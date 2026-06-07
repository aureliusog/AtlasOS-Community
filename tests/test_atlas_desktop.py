"""Tests for Atlas desktop command placeholders."""

from src.atlas_desktop import desktop_status, queue_desktop_command


def test_desktop_command_disabled_by_default():
    result = queue_desktop_command("open_cursor", {"project": "houseify"})
    assert result["ok"] is True
    assert result["executed"] is False
    assert "disabled" in result["message"].lower() or "queued" in result["message"].lower()


def test_desktop_status_label():
    status = desktop_status()
    assert status["ok"] is True
    assert status["desktop_commands_enabled"] is False
    assert "Disabled" in status["label"]
