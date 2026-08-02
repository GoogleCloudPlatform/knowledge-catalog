from __future__ import annotations

import pytest

from aws_reference_agent.cli import main

_BASE = [
    "enrich",
    "--source", "glue",
    "--database", "db",
    "--out", "/tmp/okf-cli-test",
    "--no-web",
]


def test_should_exit_when_verify_queries_execute_combined_with_no_sample():
    with pytest.raises(SystemExit) as exc:
        main([*_BASE, "--no-sample", "--verify-queries", "execute"])

    message = str(exc.value)
    assert "--no-sample" in message
    assert "--verify-queries execute" in message


def test_should_not_exit_for_no_sample_when_verify_mode_is_schema(monkeypatch):
    # Sentinel: reaching source construction proves the guard did not fire.
    def boom(*_args, **_kwargs):
        raise RuntimeError("reached source construction")

    monkeypatch.setattr("aws_reference_agent.cli._build_source", boom)

    with pytest.raises(RuntimeError, match="reached source construction"):
        main([*_BASE, "--no-sample", "--verify-queries", "schema"])
