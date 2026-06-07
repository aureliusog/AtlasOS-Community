"""Atlas local voice transcription — faster-whisper backend for Voice V2.

Lazy-loads the model on first use. No external API calls.
Configure via environment:
  ATLAS_WHISPER_MODEL       (default: tiny.en)
  ATLAS_WHISPER_DEVICE      (default: cpu)
  ATLAS_WHISPER_COMPUTE_TYPE (default: int8)
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

_whisper_model = None
_whisper_config: Optional[Tuple[str, str, str]] = None


def _env_model() -> str:
    return (os.environ.get("ATLAS_WHISPER_MODEL") or "tiny.en").strip() or "tiny.en"


def _env_device() -> str:
    return (os.environ.get("ATLAS_WHISPER_DEVICE") or "cpu").strip() or "cpu"


def _env_compute_type() -> str:
    return (os.environ.get("ATLAS_WHISPER_COMPUTE_TYPE") or "int8").strip() or "int8"


def whisper_available() -> bool:
    """True when faster-whisper is importable (not necessarily loaded)."""
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def get_whisper_config() -> Dict[str, str]:
    return {
        "model": _env_model(),
        "device": _env_device(),
        "compute_type": _env_compute_type(),
    }


def _display_model_name(model_name: str) -> str:
    base = model_name.split(".", 1)[0]
    return base or model_name


def _get_model():
    global _whisper_model, _whisper_config
    if not whisper_available():
        return None

    model_name = _env_model()
    device = _env_device()
    compute_type = _env_compute_type()
    cfg = (model_name, device, compute_type)

    if _whisper_model is not None and _whisper_config == cfg:
        return _whisper_model

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None

    try:
        _whisper_model = WhisperModel(model_name, device=device, compute_type=compute_type)
        _whisper_config = cfg
        logger.info(
            "[atlas-voice] loaded whisper model=%s device=%s compute=%s",
            model_name,
            device,
            compute_type,
        )
        return _whisper_model
    except Exception as exc:
        logger.error("[atlas-voice] failed to load whisper model: %s", exc, exc_info=True)
        _whisper_model = None
        _whisper_config = None
        return None


def transcribe_audio(path: str | Path, language: str = "en") -> Dict[str, Any]:
    """Transcribe a local audio file. Returns ok/text/engine/model/duration_ms or error dict."""
    audio_path = Path(path)
    if not audio_path.is_file():
        return {"ok": False, "error": "file_not_found", "message": "Audio file not found."}

    if not whisper_available():
        return {
            "ok": False,
            "error": "whisper_not_installed",
            "message": (
                "Local Whisper is not installed. "
                "Install faster-whisper or whisper.cpp dependencies."
            ),
        }

    model = _get_model()
    if model is None:
        return {
            "ok": False,
            "error": "whisper_load_failed",
            "message": "Local Whisper model could not be loaded.",
        }

    lang = (language or "en").strip() or "en"
    kwargs: Dict[str, Any] = {}
    if lang and lang.lower() != "auto":
        kwargs["language"] = lang

    model_name = _env_model()
    t0 = time.perf_counter()
    try:
        segments, _info = model.transcribe(str(audio_path), **kwargs)
        text = " ".join(seg.text.strip() for seg in segments if seg.text and seg.text.strip())
        duration_ms = int((time.perf_counter() - t0) * 1000)
        return {
            "ok": True,
            "text": text,
            "engine": "whisper",
            "model": _display_model_name(model_name),
            "duration_ms": duration_ms,
        }
    except Exception as exc:
        logger.error("[atlas-voice] transcription failed: %s", exc, exc_info=True)
        return {
            "ok": False,
            "error": "transcription_failed",
            "message": f"Transcription failed: {exc}",
        }
