from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from aws_reference_agent.tools.context import set_context
from aws_reference_agent.tools.source_tools import validate_query
from aws_reference_agent.verification import VerifyMode

_BUNDLE_ROOT = Path("/tmp/fake-bundle")


def _make_source(validate_result: str | None = None) -> MagicMock:
    src = MagicMock()
    src.validate_query.return_value = validate_result
    return src


def _ctx(tmp_path: Path, mode: str, src: MagicMock | None = None) -> None:
    if src is None:
        src = _make_source()
    set_context(src, tmp_path, verify_queries=mode)


def test_should_return_ok_true_without_calling_source_when_mode_is_off(tmp_path):
    src = _make_source()
    _ctx(tmp_path, VerifyMode.OFF, src)

    result = validate_query("SELECT 1")

    assert result["ok"] is True
    src.validate_query.assert_not_called()


def test_should_return_ok_true_without_calling_source_when_mode_is_schema(tmp_path):
    src = _make_source()
    _ctx(tmp_path, VerifyMode.SCHEMA, src)

    result = validate_query("SELECT 1")

    assert result["ok"] is True
    src.validate_query.assert_not_called()


def test_should_return_ok_true_when_source_returns_none_in_execute_mode(tmp_path):
    src = _make_source(validate_result=None)
    _ctx(tmp_path, VerifyMode.EXECUTE, src)

    result = validate_query("SELECT 1")

    assert result == {"ok": True, "note": ""}


def test_should_return_ok_false_with_note_when_source_reports_failure(tmp_path):
    src = _make_source(validate_result="SYNTAX_ERROR: unexpected token at line 1")
    _ctx(tmp_path, VerifyMode.EXECUTE, src)

    result = validate_query("SELECT bad syntax")

    assert result["ok"] is False
    assert "SYNTAX_ERROR" in result["note"]


def test_should_return_ok_false_when_source_raises_in_execute_mode(tmp_path):
    src = MagicMock()
    src.validate_query.side_effect = RuntimeError("connection lost")
    _ctx(tmp_path, VerifyMode.EXECUTE, src)

    result = validate_query("SELECT 1")

    assert result["ok"] is False
    assert "connection lost" in result["note"]
