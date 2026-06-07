"""Atlas desktop command placeholders — safe groundwork only, no execution by default."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List

from src.atlas_config import data_dir

logger = logging.getLogger(__name__)

_PERMISSIONS_FILE = "desktop_permissions.json"
_DEFAULTS = {
    "desktop_commands_enabled": False,
    "allowed_apps": ["cursor", "brave", "chrome", "explorer"],
    "require_confirmation": True,
}


def _permissions_path() -> Path:
    return data_dir() / _PERMISSIONS_FILE


def load_desktop_permissions() -> Dict[str, Any]:
    path = _permissions_path()
    if not path.is_file():
        return dict(_DEFAULTS)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return dict(_DEFAULTS)
        out = dict(_DEFAULTS)
        out.update(data)
        return out
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("[atlas-desktop] could not read permissions: %s", exc)
        return dict(_DEFAULTS)


def queue_desktop_command(command: str, args: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """Queue a desktop command. Execution is disabled until permissions are enabled."""
    cmd = (command or "").strip()
    if not cmd:
        return {"ok": False, "error": "empty_command", "message": "Command is required."}

    perms = load_desktop_permissions()
    enabled = bool(perms.get("desktop_commands_enabled"))

    if not enabled:
        return {
            "ok": True,
            "queued": True,
            "executed": False,
            "command": cmd,
            "args": args or {},
            "message": (
                "Desktop command queued. Execution is disabled until local permissions are configured."
            ),
        }

    # Future: gated execution with confirmation — still placeholder in V1
    return {
        "ok": True,
        "queued": True,
        "executed": False,
        "command": cmd,
        "args": args or {},
        "message": (
            "Desktop commands are enabled in config but execution is not implemented in V1."
        ),
    }


def desktop_status() -> Dict[str, Any]:
    perms = load_desktop_permissions()
    enabled = bool(perms.get("desktop_commands_enabled"))
    return {
        "ok": True,
        "desktop_commands_enabled": enabled,
        "require_confirmation": bool(perms.get("require_confirmation", True)),
        "allowed_apps": list(perms.get("allowed_apps") or []),
        "label": "Desktop Control: Enabled" if enabled else "Desktop Control: Disabled",
    }
