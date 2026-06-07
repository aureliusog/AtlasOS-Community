"""Atlas OS local identity, profile, projects, and agents configuration."""

from __future__ import annotations

import json
import logging
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULTS_DIR = _REPO_ROOT / "config" / "atlas"
_DATA_DIR = _REPO_ROOT / "data" / "atlas"

_CONFIG_FILES = (
    "atlas_identity.json",
    "aurelius_profile.json",
    "projects.json",
    "agents.json",
    "reports.json",
    "finance.json",
    "pipeline.json",
    "workspace.json",
    "personal_finance.json",
    "desktop_permissions.json",
)


def _ensure_data_dir() -> None:
    """Seed data/atlas from bundled defaults when local files are missing."""
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    for name in _CONFIG_FILES:
        dest = _DATA_DIR / name
        if dest.exists():
            continue
        src = _DEFAULTS_DIR / name
        if src.exists():
            shutil.copy2(src, dest)
            logger.info("[atlas] seeded %s", dest)
        else:
            logger.warning("[atlas] missing default config %s", src)


def _read_json(filename: str) -> Dict[str, Any]:
    _ensure_data_dir()
    path = _DATA_DIR / filename
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        logger.warning("[atlas] could not read %s: %s", path, exc)
        fallback = _DEFAULTS_DIR / filename
        if fallback.exists():
            with open(fallback, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, dict) else {}
        return {}


def load_atlas_identity() -> Dict[str, Any]:
    return _read_json("atlas_identity.json")


def load_aurelius_profile() -> Dict[str, Any]:
    return _read_json("aurelius_profile.json")


def data_dir() -> Path:
    _ensure_data_dir()
    return _DATA_DIR


def load_projects() -> List[Dict[str, Any]]:
    data = _read_json("projects.json")
    projects = data.get("projects", [])
    if not isinstance(projects, list):
        return []
    return [_normalize_project(p) for p in projects]


def _normalize_project(p: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure extended project fields exist without breaking legacy entries."""
    from src.atlas_mount_workspace import enrich_project
    from src.atlas_workspace import load_workspace

    out = dict(p)
    out.setdefault("path", "")
    out.setdefault("type", "SaaS")
    out.setdefault("created_at", out.get("created_at") or datetime.now(timezone.utc).replace(microsecond=0).isoformat())
    out.setdefault("last_indexed_at", None)
    out.setdefault("file_count", 0)
    out.setdefault("recent_changes", {})
    out.setdefault("notes", "")
    out.setdefault("agents_allowed", True)
    out.setdefault("source", "manual")
    out.setdefault("detected_type", out.get("type"))
    out.setdefault("detected_stack", [])
    out.setdefault("last_seen_at", None)
    out.setdefault("indexed", bool(out.get("last_indexed_at")))
    out.setdefault("pinned", False)
    out.setdefault("last_chat_at", None)
    out.setdefault("last_agent_report_at", None)
    out.setdefault("last_activity_at", None)
    out.setdefault("activity_score", 0)
    out.setdefault("focus_mode", False)
    try:
        ws = load_workspace(data_dir())
        out = enrich_project(out, ws)
        from src.atlas_projects import refresh_project_activity_fields
        return refresh_project_activity_fields(out)
    except Exception:
        out.setdefault("display_path", out.get("path", ""))
        out.setdefault("path_status", "empty" if not out.get("path") else "unknown")
        out.setdefault("can_relink", False)
        return out


def save_projects(projects: List[Dict[str, Any]]) -> None:
    _write_json("projects.json", {"projects": projects})


def load_finance() -> Dict[str, Any]:
    data = _read_json("finance.json")
    return data if data else {"entries": [], "notes": ""}


def save_finance(data: Dict[str, Any]) -> None:
    _write_json("finance.json", data)


def load_pipeline() -> List[Dict[str, Any]]:
    data = _read_json("pipeline.json")
    items = data.get("items", [])
    return items if isinstance(items, list) else []


def save_pipeline(items: List[Dict[str, Any]]) -> None:
    _write_json("pipeline.json", {"items": items})


def load_agents() -> List[Dict[str, Any]]:
    data = _read_json("agents.json")
    agents = data.get("agents", [])
    return agents if isinstance(agents, list) else []


def save_agents(agents: List[Dict[str, Any]]) -> None:
    """Persist agent state to data/atlas/agents.json only."""
    _write_json("agents.json", {"agents": agents})


def load_reports() -> List[Dict[str, Any]]:
    data = _read_json("reports.json")
    reports = data.get("reports", [])
    return reports if isinstance(reports, list) else []


def save_reports(reports: List[Dict[str, Any]]) -> None:
    """Persist reports to data/atlas/reports.json only."""
    _write_json("reports.json", {"reports": reports})


def _write_json(filename: str, data: Dict[str, Any]) -> None:
    _ensure_data_dir()
    path = _DATA_DIR / filename
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def load_profile_bundle() -> Dict[str, Any]:
    return {
        "identity": load_atlas_identity(),
        "profile": load_aurelius_profile(),
    }


def time_aware_greeting(profile: Optional[Dict[str, Any]] = None) -> str:
    profile = profile or load_aurelius_profile()
    address = (profile.get("address_as") or "Sir").strip()
    hour = datetime.now().hour
    if hour < 12:
        part = "morning"
    elif hour < 17:
        part = "afternoon"
    else:
        part = "evening"
    return f"Good {part}, {address}. What shall we build today?"


def active_focus_projects() -> List[Dict[str, Any]]:
    return [p for p in load_projects() if (p.get("status") or "").lower() == "active"]


def generate_briefing() -> Dict[str, Any]:
    """Build a simple non-AI briefing from workspace, projects, and summaries."""
    from src.atlas_workspace import load_workspace
    from src.atlas_project_index import load_all_summaries, load_summary

    profile = load_aurelius_profile()
    projects = active_focus_projects()
    all_projects = load_projects()
    agents = load_agents()
    ddir = data_dir()
    ws = load_workspace(ddir)
    summaries = {s.get("project_id"): s for s in load_all_summaries(ddir)}

    greeting = time_aware_greeting(profile)
    focus_names = [p.get("name") for p in projects if p.get("name")]
    focus_text = " and ".join(focus_names) if focus_names else (profile.get("current_focus") or "").rstrip(".")

    ready_agents = [a for a in agents if (a.get("status") or "").lower() == "ready"]
    dev_ready = next((a for a in agents if a.get("id") == "developer" and (a.get("status") or "") in ("ready", "idle")), None)

    from src.atlas_mount_workspace import get_workspace_status, is_mounted

    mount_status = get_workspace_status(ws)
    workspace_lines: List[str] = []
    if not is_mounted():
        workspace_lines.append(mount_status.get("warning") or "Atlas Workspace is not mounted.")
    elif not (ws.get("workspace_root") or "").strip():
        workspace_lines.append(
            "Configure Atlas Workspace in Projects — put project folders in C:\\AtlasWorkspace\\Projects."
        )
    else:
        with_path = [p for p in all_projects if (p.get("path") or "").strip()]
        indexed = [p for p in with_path if p.get("last_indexed_at") or p.get("indexed")]
        not_indexed = [p for p in with_path if p not in indexed]
        changed: List[str] = []
        for p in with_path:
            ch = p.get("recent_changes") or {}
            total = (ch.get("new_count") or 0) + (ch.get("modified_count") or 0)
            if total:
                changed.append(p.get("name", "Project"))

        workspace_lines.append(
            f"{len(with_path)} project(s) discovered in your workspace; {len(indexed)} indexed."
        )
        if not_indexed:
            names = ", ".join(p.get("name", "Project") for p in not_indexed[:4])
            suffix = f" and {len(not_indexed) - 4} more" if len(not_indexed) > 4 else ""
            workspace_lines.append(f"Not indexed yet: {names}{suffix}.")
        if changed:
            ch_names = ", ".join(changed[:4])
            suffix = f" and {len(changed) - 4} more" if len(changed) > 4 else ""
            workspace_lines.append(f"Recent changes in {ch_names}{suffix}.")
        elif ws.get("last_scan_at"):
            workspace_lines.append(f"Workspace last scanned {ws['last_scan_at']}.")

        for p in indexed[:2]:
            summ = summaries.get(p.get("id")) or load_summary(ddir, p.get("id") or "")
            if summ and summ.get("summary"):
                workspace_lines.append(summ["summary"])

        if dev_ready and indexed:
            indexed_name = indexed[0].get("name") or (focus_names[0] if focus_names else "your top project")
            workspace_lines.append(f"Developer Agent can review {indexed_name} when ready.")

    if len(ready_agents) == 1:
        ready_line = f"{ready_agents[0].get('name', 'Agent')} is ready."
    elif len(ready_agents) > 1:
        names = [a.get("name", "Agent") for a in ready_agents]
        ready_line = f"{', '.join(names[:-1])} and {names[-1]} are ready."
    else:
        ready_line = ""

    high_priority = sorted(
        projects,
        key=lambda p: 0 if (p.get("priority") or "").lower() == "high" else 1,
    )
    actions = [
        (p.get("suggested_next_action") or "").strip()
        for p in high_priority
        if (p.get("suggested_next_action") or "").strip()
    ]
    if workspace_lines:
        rec = workspace_lines[0]
    elif len(focus_names) >= 2:
        rec = (
            "Recommended next action: "
            f"Review {focus_names[0]} onboarding or define the {focus_names[1]} core workflow."
        )
    elif len(actions) == 1:
        rec = f"Recommended next action: {actions[0]}"
    else:
        rec = ""

    parts = [greeting.rstrip(".") + ".", "Atlas is online."]
    if focus_text:
        parts.append(f"Your active focus is {focus_text}.")
    for line in workspace_lines[:3]:
        parts.append(line)
    if ready_line:
        parts.append(ready_line)
    if rec and rec not in parts:
        parts.append(rec)

    text = " ".join(parts)
    return {
        "text": text,
        "greeting": greeting,
        "focus": focus_names,
        "ready_agents": [a.get("name") for a in ready_agents],
        "recommended_actions": actions,
        "workspace_lines": workspace_lines,
    }


def build_atlas_system_context() -> str:
    """Compact Atlas OS context for assistant / agent system prompts."""
    from src.atlas_project_index import format_summaries_for_agents, load_all_summaries

    identity = load_atlas_identity()
    profile = load_aurelius_profile()
    projects = active_focus_projects()
    agents = load_agents()
    summaries = load_all_summaries(data_dir())

    address = profile.get("address_as") or identity.get("address_user_as") or "Sir"
    reply_style = identity.get("reply_style") or (
        "Default to brief replies unless the user asks for detail. "
        "Voice: 1–4 sentences. Text: concise but useful. "
        "When responding by voice, be brief, natural, and refer to the user as sir "
        "without overusing punctuation."
    )

    lines = [
        "# Atlas OS Context",
        f"You are {identity.get('name', 'Atlas')}, {identity.get('role', 'a local AI operating system')}.",
        f"Mission: {identity.get('mission', '')}",
        f"Tone: {identity.get('tone', '')}",
        f"Style: {identity.get('style', '')}",
        f"Address the user as {address} (e.g. \"Yes sir\", \"Understood, Sir\", \"Good evening, Sir\").",
        f"Reply style: {reply_style}",
        "Avoid long essays, generic AI waffle, overexplaining, and repeating context.",
        "",
        f"## User: {profile.get('name', 'Aurelius')} ({address})",
        f"Work style: {profile.get('work_style', '')}",
        f"Current focus: {profile.get('current_focus', '')}",
        f"Deprioritise unless asked: {profile.get('ignore_for_now', '')}",
        f"Also known as: {profile.get('also_known_as', '')}",
        f"Interests: {', '.join(profile.get('interests', [])) if isinstance(profile.get('interests'), list) else profile.get('likes', '')}",
        f"Business preferences: {profile.get('business_preferences', '')}",
        f"Preferences: {profile.get('likes', '')}",
        f"How to assist: {profile.get('assistant_style', '')}",
        f"Atlas role: {profile.get('atlas_role', '')}",
    ]

    if projects:
        lines.append("")
        lines.append("## Active Projects")
        for p in projects:
            name = p.get("name", "Project")
            desc = p.get("description", "")
            nxt = p.get("suggested_next_action", "")
            pri = p.get("priority", "")
            lines.append(f"- {name} ({pri}): {desc}")
            if p.get("path"):
                lines.append(f"  Path: {p.get('path')} — {p.get('file_count', 0)} files indexed")
            ch = p.get("recent_changes") or {}
            if ch.get("new_count") or ch.get("modified_count"):
                lines.append(
                    f"  Recent changes: {ch.get('new_count', 0)} new, {ch.get('modified_count', 0)} modified"
                )
            if nxt:
                lines.append(f"  Next: {nxt}")

    if summaries:
        lines.append("")
        lines.append("## Project Index Summaries (metadata only — no raw file dumps)")
        lines.append(format_summaries_for_agents(summaries))

    if agents:
        lines.append("")
        lines.append("## Agent Personalities (reference roles — you may adopt the relevant lens)")
        for a in agents:
            lines.append(
                f"- {a.get('name', 'Agent')} [{a.get('status', 'idle')}]: {a.get('role', '')}"
            )

    return "\n".join(line for line in lines if line is not None).strip()
