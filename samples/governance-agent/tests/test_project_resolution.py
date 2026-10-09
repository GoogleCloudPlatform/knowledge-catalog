import logging
import sys
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

from metadata_propagation import steward_cli
from metadata_propagation.agent.plugins.context import resolve_default_project

ARGPARSE_USAGE_ERROR = 2


@pytest.fixture
def restore_root_logger():
    # steward_cli.main() reconfigures the root logger; undo that after a test.
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    yield
    root.handlers[:] = handlers
    root.setLevel(level)


def test_env_var_takes_precedence(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "env-project")
    with patch("google.auth.default") as mock_default:
        assert resolve_default_project() == "env-project"
    mock_default.assert_not_called()


def test_falls_back_to_adc_project(monkeypatch):
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    with patch("google.auth.default", return_value=(MagicMock(), "adc-project")):
        assert resolve_default_project() == "adc-project"


@pytest.mark.parametrize("adc_project", [None, ""])
def test_returns_none_when_adc_has_no_project(monkeypatch, adc_project):
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    with patch("google.auth.default", return_value=(MagicMock(), adc_project)):
        assert resolve_default_project() is None


def test_returns_none_when_adc_is_unavailable(monkeypatch):
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    with patch("google.auth.default", side_effect=Exception("no ADC")):
        assert resolve_default_project() is None


def test_cli_errors_without_a_project(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["steward_cli", "scan", "--dataset", "ds"])
    monkeypatch.setattr(steward_cli, "resolve_default_project", lambda: None)
    with pytest.raises(SystemExit) as exc_info:
        steward_cli.main()
    assert exc_info.value.code == ARGPARSE_USAGE_ERROR
    assert "No Google Cloud project found" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("extra_args", "expected_project"),
    [([], "resolved-project"), (["--project", "flag-project"], "flag-project")],
)
def test_cli_passes_project_to_plugins(
    monkeypatch, restore_root_logger, extra_args, expected_project
):
    monkeypatch.setattr(
        sys, "argv", ["steward_cli", *extra_args, "scan", "--dataset", "ds"]
    )
    resolver = MagicMock(return_value="resolved-project")
    monkeypatch.setattr(steward_cli, "resolve_default_project", resolver)
    lineage_plugin = MagicMock()
    lineage_plugin.return_value.scan_for_missing_descriptions.return_value = (
        pd.DataFrame()
    )
    monkeypatch.setattr(steward_cli, "LineagePlugin", lineage_plugin)
    for name in ("GlossaryPlugin", "PolicyTagPlugin", "DocDescriptionPlugin"):
        monkeypatch.setattr(steward_cli, name, MagicMock())

    steward_cli.main()

    lineage_plugin.assert_called_once_with(expected_project, "europe-west1")
    assert resolver.call_count == (0 if extra_args else 1)
