"""Atlas OS configuration API — identity, profile, projects, agents, briefing, reports."""

from typing import Any, Dict, List, Optional
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from src.atlas_agents import (
    apply_report_action,
    normalize_action,
    reports_for_queue,
    run_agent_action,
)
from src.atlas_config import (
    data_dir,
    generate_briefing,
    load_agents,
    load_finance,
    load_pipeline,
    load_profile_bundle,
    load_projects,
    load_reports,
    save_finance,
    save_pipeline,
    save_projects,
)
from src.atlas_pipeline import apply_action as pipeline_apply_action
from src.atlas_pipeline import attach_report, create_item
from src.atlas_project_index import index_all_projects, index_project, load_index, load_summary
from src.atlas_desktop import desktop_status, queue_desktop_command
from src.atlas_mount_workspace import bootstrap_workspace_folders, get_workspace_status
from src.atlas_voice import get_whisper_config, transcribe_audio, whisper_available
from src.atlas_workspace import load_workspace, relink_project, save_workspace, scan_workspace
from src.auth_helpers import get_current_user
from src.upload_limits import read_upload_limited

logger = logging.getLogger(__name__)

ATLAS_VOICE_MAX_BYTES = 25 * 1024 * 1024
ATLAS_VOICE_ALLOWED_TYPES = {
    "audio/webm",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp4",
    "video/webm",
    "application/ogg",
}
ATLAS_VOICE_ALLOWED_EXT = {".webm", ".ogg", ".wav", ".m4a", ".mp3", ".mpeg", ".mpga"}


class AgentRunRequest(BaseModel):
    agent_id: str = Field(..., min_length=1, max_length=64)
    action: str = Field(..., min_length=1, max_length=128)
    project_id: Optional[str] = Field(None, max_length=64)


class WorkspaceSaveRequest(BaseModel):
    workspace_root: str = ""
    auto_discover: bool = True
    auto_index_on_scan: bool = False


class ReportActionRequest(BaseModel):
    action: str = Field(..., min_length=1, max_length=32)


class ProjectIndexRequest(BaseModel):
    project_id: str = Field(..., min_length=1, max_length=64)


class ProjectSaveRequest(BaseModel):
    id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=128)
    path: str = ""
    description: str = ""
    type: str = "SaaS"
    status: str = "active"
    priority: str = "medium"
    notes: str = ""
    agents_allowed: bool = True
    suggested_next_action: str = ""


class FinanceEntryUpdate(BaseModel):
    id: str
    expected_revenue: Optional[float] = None
    actual_revenue: Optional[float] = None
    costs: Optional[float] = None
    monetisation_strategy: Optional[str] = None
    notes: Optional[str] = None


class PipelineCreateRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=256)
    source_agent: str = "research"
    source_report_id: Optional[str] = None


class PipelineActionRequest(BaseModel):
    action: str = Field(..., min_length=1, max_length=64)


class DesktopCommandRequest(BaseModel):
    command: str = Field(..., min_length=1, max_length=128)
    args: Dict[str, Any] = Field(default_factory=dict)


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def setup_atlas_routes() -> APIRouter:
    router = APIRouter(prefix="/api/atlas", tags=["atlas"])

    @router.get("/profile")
    async def get_atlas_profile(request: Request):
        get_current_user(request)
        return load_profile_bundle()

    @router.get("/workspace")
    async def get_atlas_workspace(request: Request):
        get_current_user(request)
        ws = load_workspace(data_dir())
        return {
            "ok": True,
            "workspace": ws,
            "status": get_workspace_status(ws),
            "projects": load_projects(),
        }

    @router.post("/workspace")
    async def save_atlas_workspace(request: Request, body: WorkspaceSaveRequest):
        get_current_user(request)
        ws = load_workspace(data_dir())
        # Docker mount mode: workspace_root stays at /workspace/Projects
        if (ws.get("workspace_mode") or "docker_mount") != "docker_mount":
            ws["workspace_root"] = body.workspace_root.strip()
        ws["auto_discover"] = body.auto_discover
        ws["auto_index_on_scan"] = body.auto_index_on_scan
        saved = save_workspace(data_dir(), ws)
        return {"ok": True, "workspace": saved, "status": get_workspace_status(saved)}

    @router.post("/workspace/bootstrap")
    async def bootstrap_atlas_workspace(request: Request):
        get_current_user(request)
        result = bootstrap_workspace_folders()
        ws = load_workspace(data_dir())
        result["workspace"] = ws
        result["status"] = get_workspace_status(ws)
        return result

    @router.post("/workspace/scan")
    async def scan_atlas_workspace(request: Request):
        get_current_user(request)
        return scan_workspace(data_dir())

    @router.post("/projects/{project_id}/relink")
    async def relink_atlas_project(project_id: str, request: Request):
        get_current_user(request)
        return relink_project(data_dir(), project_id)

    @router.get("/projects")
    async def get_atlas_projects(request: Request):
        get_current_user(request)
        return {"projects": load_projects()}

    @router.get("/projects/recent")
    async def get_recent_projects(request: Request):
        get_current_user(request)
        from src.atlas_projects import get_recent_projects
        projects = get_recent_projects()
        return {"ok": True, "projects": projects}

    @router.get("/projects/{project_id}/context")
    async def get_project_context(project_id: str, request: Request):
        get_current_user(request)
        from src.atlas_projects import build_project_context
        return build_project_context(project_id)

    @router.post("/projects/{project_id}/pin")
    async def pin_project(project_id: str, request: Request):
        get_current_user(request)
        from src.atlas_projects import toggle_pin
        return toggle_pin(project_id)

    @router.post("/projects/{project_id}/activity")
    async def project_activity(project_id: str, request: Request):
        get_current_user(request)
        from src.atlas_projects import record_activity
        try:
            body = await request.json()
        except Exception:
            body = {}
        activity_type = (body.get("type") or "view") if isinstance(body, dict) else "view"
        return record_activity(project_id, activity_type)

    @router.post("/projects")
    async def save_atlas_project(request: Request, body: ProjectSaveRequest):
        get_current_user(request)
        from src.atlas_mount_workspace import enrich_project, validate_project_path

        ws = load_workspace(data_dir())
        path = body.path.strip()
        if path and (ws.get("workspace_mode") or "docker_mount") == "docker_mount":
            _, perr = validate_project_path(path, ws)
            if perr:
                return {"ok": False, "message": perr}
        projects = load_projects()
        pid = (body.id or "").strip() or str(uuid.uuid4())[:8]
        entry = {
            "id": pid,
            "name": body.name.strip(),
            "path": path,
            "description": body.description.strip(),
            "type": body.type.strip() or "SaaS",
            "status": body.status.strip() or "active",
            "priority": body.priority.strip() or "medium",
            "notes": body.notes.strip(),
            "agents_allowed": body.agents_allowed,
            "suggested_next_action": body.suggested_next_action.strip(),
            "created_at": _now_iso(),
            "last_indexed_at": None,
            "file_count": 0,
            "recent_changes": {},
            "source": "manual",
            "detected_type": body.type.strip() or "SaaS",
            "detected_stack": [],
            "last_seen_at": None,
            "indexed": False,
        }
        existing = next((i for i, p in enumerate(projects) if p.get("id") == pid), None)
        if existing is not None:
            old = projects[existing]
            entry["created_at"] = old.get("created_at") or entry["created_at"]
            entry["last_indexed_at"] = old.get("last_indexed_at")
            entry["file_count"] = old.get("file_count", 0)
            entry["recent_changes"] = old.get("recent_changes") or {}
            entry["source"] = old.get("source") or "manual"
            entry["detected_type"] = old.get("detected_type")
            entry["detected_stack"] = old.get("detected_stack") or []
            entry["last_seen_at"] = old.get("last_seen_at")
            entry["indexed"] = old.get("indexed", bool(old.get("last_indexed_at")))
            entry = enrich_project(entry, ws)
            projects[existing] = entry
        else:
            entry = enrich_project(entry, ws)
            projects.append(entry)
        save_projects(projects)
        return {"ok": True, "project": entry, "projects": projects}

    @router.post("/projects/index")
    async def index_atlas_project(request: Request, body: ProjectIndexRequest):
        """Read-only directory scan — metadata only."""
        get_current_user(request)
        projects = load_projects()
        project = next((p for p in projects if p.get("id") == body.project_id), None)
        if not project:
            return {"ok": False, "message": "Project not found"}
        if not project.get("agents_allowed", True):
            return {"ok": False, "message": "Agent indexing disabled for this project"}
        result = index_project(data_dir(), project)
        if not result.get("ok"):
            return result
        for i, p in enumerate(projects):
            if p.get("id") == body.project_id:
                projects[i] = result["project"]
                break
        save_projects(projects)
        return result

    @router.post("/projects/index-all")
    async def index_all_atlas_projects(request: Request):
        """Read-only batch index for all projects with valid paths."""
        get_current_user(request)
        return index_all_projects(data_dir())

    @router.get("/projects/{project_id}/index")
    async def get_project_index(project_id: str, request: Request):
        get_current_user(request)
        idx = load_index(data_dir(), project_id)
        if not idx:
            return {"ok": False, "message": "No index for this project"}
        return {"ok": True, "index": idx}

    @router.get("/projects/{project_id}/summary")
    async def get_project_summary(project_id: str, request: Request):
        get_current_user(request)
        summary = load_summary(data_dir(), project_id)
        if not summary:
            return {"ok": False, "message": "No summary for this project — index it first"}
        return {"ok": True, "summary": summary}

    @router.get("/finance")
    async def get_atlas_finance(request: Request):
        get_current_user(request)
        return load_finance()

    @router.get("/finance/personal")
    async def get_personal_finance(request: Request):
        get_current_user(request)
        from src.atlas_personal_finance import load_personal_finance
        return {"ok": True, "personal": load_personal_finance()}

    @router.get("/finance/overview")
    async def get_finance_overview(request: Request):
        get_current_user(request)
        from src.atlas_personal_finance import compute_overview, load_personal_finance
        return {
            "ok": True,
            "project_finance": load_finance(),
            "personal": load_personal_finance(),
            "overview": compute_overview(),
        }

    @router.post("/finance/bills")
    async def add_finance_bill(request: Request):
        get_current_user(request)
        from src.atlas_personal_finance import add_bill
        body = await request.json()
        return add_bill(body if isinstance(body, dict) else {})

    @router.post("/finance/work-log")
    async def add_finance_work_log(request: Request):
        get_current_user(request)
        from src.atlas_personal_finance import add_work_log
        body = await request.json()
        return add_work_log(body if isinstance(body, dict) else {})

    @router.post("/finance/deductions")
    async def add_finance_deduction(request: Request):
        get_current_user(request)
        from src.atlas_personal_finance import add_deduction
        body = await request.json()
        return add_deduction(body if isinstance(body, dict) else {})

    @router.put("/finance")
    async def update_atlas_finance(request: Request, body: FinanceEntryUpdate):
        get_current_user(request)
        data = load_finance()
        entries = data.get("entries") or []
        found = False
        for e in entries:
            if e.get("id") == body.id:
                if body.expected_revenue is not None:
                    e["expected_revenue"] = body.expected_revenue
                if body.actual_revenue is not None:
                    e["actual_revenue"] = body.actual_revenue
                if body.costs is not None:
                    e["costs"] = body.costs
                if body.monetisation_strategy is not None:
                    e["monetisation_strategy"] = body.monetisation_strategy
                if body.notes is not None:
                    e["notes"] = body.notes
                e["profit_estimate"] = (e.get("actual_revenue") or 0) - (e.get("costs") or 0)
                e["last_updated"] = _now_iso()
                found = True
                break
        if not found:
            return {"ok": False, "message": "Finance entry not found"}
        data["entries"] = entries
        save_finance(data)
        return {"ok": True, "finance": data}

    @router.get("/pipeline")
    async def get_atlas_pipeline(request: Request):
        get_current_user(request)
        return {"items": load_pipeline()}

    @router.post("/pipeline")
    async def create_pipeline_item(request: Request, body: PipelineCreateRequest):
        get_current_user(request)
        items = load_pipeline()
        item = create_item(
            body.title.strip(),
            source_agent=body.source_agent,
            source_report_id=body.source_report_id,
        )
        items.insert(0, item)
        save_pipeline(items)
        return {"ok": True, "item": item, "items": items}

    @router.post("/pipeline/{item_id}/action")
    async def pipeline_item_action(item_id: str, request: Request, body: PipelineActionRequest):
        owner = get_current_user(request)
        items = load_pipeline()
        item = next((i for i in items if i.get("id") == item_id), None)
        if not item:
            return {"ok": False, "message": "Pipeline item not found"}
        result = pipeline_apply_action(item, body.action)
        if not result.get("ok"):
            return result
        updated = result["item"]
        for i, it in enumerate(items):
            if it.get("id") == item_id:
                items[i] = updated
                break
        save_pipeline(items)
        run_result = None
        if result.get("run_agent_id") and result.get("run_action"):
            run_result = await run_agent_action(
                result["run_agent_id"],
                result["run_action"],
                owner=owner,
            )
            if run_result.get("ok") and run_result.get("report"):
                attach_report(updated, run_result["report"]["id"])
                for i, it in enumerate(items):
                    if it.get("id") == item_id:
                        items[i] = updated
                        break
                save_pipeline(items)
        return {
            **result,
            "items": items,
            "run_result": run_result,
        }

    @router.get("/agents")
    async def get_atlas_agents(request: Request):
        get_current_user(request)
        return {"agents": load_agents()}

    @router.get("/reports")
    async def get_atlas_reports(request: Request):
        get_current_user(request)
        queue = reports_for_queue()
        return {
            "reports": queue["all"],
            "queue": {
                "pending": queue["pending"],
                "waiting_for_approval": queue["waiting_for_approval"],
                "completed_today": queue["completed_today"],
            },
        }

    @router.get("/reports/{report_id}")
    async def get_atlas_report(report_id: str, request: Request):
        get_current_user(request)
        report = next((r for r in load_reports() if r.get("id") == report_id), None)
        if not report:
            return {"ok": False, "message": "Report not found"}
        return {"ok": True, "report": report}

    @router.get("/briefing")
    async def get_atlas_briefing(request: Request):
        get_current_user(request)
        return generate_briefing()

    @router.post("/agents/run")
    async def run_atlas_agent(request: Request, body: AgentRunRequest):
        """Generate an agent report — LLM when available, safe fallback otherwise."""
        owner = get_current_user(request)
        action = normalize_action(body.action)
        result = await run_agent_action(
            body.agent_id,
            action,
            owner=owner,
            project_id=body.project_id,
        )
        return result

    @router.post("/reports/{report_id}/action")
    async def atlas_report_action(report_id: str, request: Request, body: ReportActionRequest):
        get_current_user(request)
        result = apply_report_action(report_id, body.action)
        if result.get("ok") and body.action == "approve":
            report = result.get("report") or {}
            if report.get("agent_id") == "research":
                items = load_pipeline()
                title = report.get("title") or report.get("summary") or "Approved idea"
                existing = next(
                    (i for i in items if i.get("source_report_id") == report_id),
                    None,
                )
                if not existing:
                    item = create_item(
                        title,
                        source_agent="research",
                        source_report_id=report_id,
                    )
                    items.insert(0, item)
                    save_pipeline(items)
                    result["pipeline_item"] = item
        return result

    def _voice_tmp_dir() -> Path:
        tmp = data_dir() / "tmp_voice"
        tmp.mkdir(parents=True, exist_ok=True)
        return tmp

    def _validate_voice_upload(upload: UploadFile) -> Optional[str]:
        """Return error message if invalid, else None."""
        filename = (upload.filename or "").lower()
        ext = Path(filename).suffix
        content_type = (upload.content_type or "").split(";", 1)[0].strip().lower()
        if ext in ATLAS_VOICE_ALLOWED_EXT:
            return None
        if content_type in ATLAS_VOICE_ALLOWED_TYPES:
            return None
        return (
            "Unsupported audio type. Upload webm, ogg, or wav."
        )

    @router.get("/voice/status")
    async def voice_status(request: Request):
        """Report whether local Whisper is available (no model load)."""
        get_current_user(request)
        cfg = get_whisper_config()
        return {
            "ok": True,
            "whisper_available": whisper_available(),
            "model": cfg["model"],
            "device": cfg["device"],
            "compute_type": cfg["compute_type"],
        }

    @router.post("/voice/transcribe")
    async def voice_transcribe(
        request: Request,
        audio: UploadFile = File(...),
        language: str = Form("en"),
    ):
        """Local Whisper transcription for Atlas Voice V2."""
        get_current_user(request)

        type_err = _validate_voice_upload(audio)
        if type_err:
            return JSONResponse(
                status_code=400,
                content={"ok": False, "error": "unsupported_type", "message": type_err},
            )

        audio_bytes = await read_upload_limited(audio, ATLAS_VOICE_MAX_BYTES, "Audio file")
        if not audio_bytes:
            return JSONResponse(
                status_code=400,
                content={"ok": False, "error": "empty_file", "message": "Empty audio file."},
            )

        ext = Path(audio.filename or "audio.webm").suffix.lower()
        if ext not in ATLAS_VOICE_ALLOWED_EXT:
            ext = ".webm"

        tmp_path = _voice_tmp_dir() / f"{uuid.uuid4().hex}{ext}"
        try:
            tmp_path.write_bytes(audio_bytes)
            result = transcribe_audio(tmp_path, language=language or "en")
        except Exception as exc:
            logger.error("[atlas-voice] upload transcribe failed: %s", exc, exc_info=True)
            result = {
                "ok": False,
                "error": "transcription_failed",
                "message": f"Transcription failed: {exc}",
            }
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError as exc:
                logger.warning("[atlas-voice] could not delete temp audio %s: %s", tmp_path, exc)

        if not result.get("ok"):
            status = 501 if result.get("error") == "whisper_not_installed" else 500
            return JSONResponse(status_code=status, content=result)
        return result

    @router.get("/desktop/status")
    async def get_desktop_status(request: Request):
        get_current_user(request)
        return desktop_status()

    @router.post("/desktop/command")
    async def post_desktop_command(request: Request, body: DesktopCommandRequest):
        """Placeholder desktop control — queues only, no shell execution in V1."""
        get_current_user(request)
        return queue_desktop_command(body.command, body.args)

    return router
