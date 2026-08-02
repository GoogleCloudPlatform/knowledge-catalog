from __future__ import annotations

from pathlib import Path

import pytest

from aws_reference_agent import cli as cli_mod


class _FakeRunner:
    last_kwargs: dict = {}

    def __init__(self, **kwargs):
        type(self).last_kwargs = kwargs

    def enrich_all(self, only=None):
        return 1


@pytest.fixture(autouse=True)
def _stub(monkeypatch):
    monkeypatch.setattr(cli_mod, "ReferenceRunner", _FakeRunner)
    monkeypatch.setattr(cli_mod, "_build_source", lambda name, args: object())
    _FakeRunner.last_kwargs = {}


def _argv(tmp_path: Path, *extra: str) -> list[str]:
    return [
        "enrich",
        "--source",
        "glue",
        "--database",
        "db",
        "--out",
        str(tmp_path / "bundle"),
        "--no-web",
        *extra,
    ]


def test_docs_flags_are_threaded_into_the_runner(tmp_path, capsys):
    docs = tmp_path / "docs"
    docs.mkdir()

    assert cli_mod.main(
        _argv(
            tmp_path,
            "--docs-root",
            str(docs),
            "--docs-include",
            "*.md",
            "--docs-exclude",
            "CHANGELOG.md",
            "--docs-max-files",
            "7",
            "--docs-max-bytes",
            "1024",
        )
    ) == 0

    kwargs = _FakeRunner.last_kwargs
    assert kwargs["docs_root"] == docs
    assert kwargs["docs_include"] == ["*.md"]
    assert kwargs["docs_exclude"] == ["CHANGELOG.md"]
    assert kwargs["docs_max_files"] == 7
    assert kwargs["docs_max_bytes"] == 1024
    assert "docs pass read up to 7 file(s)" in capsys.readouterr().err


def test_no_docs_suppresses_the_pass(tmp_path, capsys):
    docs = tmp_path / "docs"
    docs.mkdir()

    assert cli_mod.main(
        _argv(tmp_path, "--docs-root", str(docs), "--no-docs")
    ) == 0

    assert _FakeRunner.last_kwargs["docs_root"] is None
    assert "docs pass skipped" in capsys.readouterr().err


def test_docs_pass_skipped_when_no_root_given(tmp_path, capsys):
    assert cli_mod.main(_argv(tmp_path)) == 0
    assert _FakeRunner.last_kwargs["docs_root"] is None
    assert "docs pass skipped" in capsys.readouterr().err


def test_nonexistent_docs_root_exits_with_a_message(tmp_path):
    with pytest.raises(SystemExit) as e:
        cli_mod.main(_argv(tmp_path, "--docs-root", str(tmp_path / "nope")))
    assert "--docs-root" in str(e.value)


def test_docs_root_that_is_a_file_exits_with_a_message(tmp_path):
    f = tmp_path / "a.md"
    f.write_text("x", encoding="utf-8")
    with pytest.raises(SystemExit) as e:
        cli_mod.main(_argv(tmp_path, "--docs-root", str(f)))
    assert "--docs-root" in str(e.value)
