"""Tests for Atlas local voice transcription."""

import tempfile
from pathlib import Path

from src.atlas_voice import (
    get_whisper_config,
    transcribe_audio,
    whisper_available,
)


def test_whisper_config_defaults():
    cfg = get_whisper_config()
    assert cfg["model"] == "tiny.en"
    assert cfg["device"] == "cpu"
    assert cfg["compute_type"] == "int8"


def test_transcribe_missing_file():
    result = transcribe_audio("/nonexistent/atlas-voice-test.webm")
    assert result["ok"] is False
    assert result["error"] == "file_not_found"


def test_transcribe_without_whisper():
    if whisper_available():
        return
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(b"\x00\x01\x02")
        path = tmp.name
    try:
        result = transcribe_audio(path)
        assert result["ok"] is False
        assert result["error"] == "whisper_not_installed"
        assert "faster-whisper" in result["message"].lower()
    finally:
        Path(path).unlink(missing_ok=True)
