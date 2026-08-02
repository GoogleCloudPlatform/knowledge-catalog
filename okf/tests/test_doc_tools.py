from __future__ import annotations

from pathlib import Path

import pytest

from aws_reference_agent.docs.reader import DocReadError
from aws_reference_agent.tools.context import (
    clear_docs_state,
    get_docs_state,
    set_docs_state,
)
from aws_reference_agent.tools.doc_tools import list_local_docs, read_local_doc


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_docs_state()


def _root(tmp_path: Path, files: dict[str, str] | None = None) -> Path:
    root = tmp_path / "docs"
    root.mkdir(exist_ok=True)
    for rel, text in (files or {"schema.md": "# Schema\nfields"}).items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return root


def test_list_local_docs_returns_the_manifest(tmp_path):
    root = _root(tmp_path, {"a.md": "# A\n", "b.txt": "plain"})
    set_docs_state(root)

    result = list_local_docs()

    assert [d["path"] for d in result["docs"]] == ["a.md", "b.txt"]
    assert result["count"] == 2
    assert result["truncated_count"] == 0
    assert all("bytes" in d and "modified" in d for d in result["docs"])


def test_list_local_docs_surfaces_a_truncated_manifest(tmp_path):
    root = _root(tmp_path, {f"d{i}.md": "x" for i in range(4)})
    set_docs_state(root, max_files=2)

    result = list_local_docs()

    assert result["count"] == 2
    # A dropped file must be visible to the agent, not capped silently.
    assert result["truncated_count"] == 2


def test_read_local_doc_returns_content_and_increments_the_count(tmp_path):
    root = _root(tmp_path, {"schema.md": "# Schema\n\n- `id`: the id\n"})
    set_docs_state(root)

    result = read_local_doc("schema.md")

    assert "error" not in result
    assert result["title"] == "Schema"
    assert "- `id`: the id" in result["markdown"]
    assert result["read_count"] == 1
    assert get_docs_state().read == {"schema.md"}


def test_read_local_doc_rejects_a_path_not_in_the_manifest(tmp_path):
    root = _root(tmp_path)
    set_docs_state(root)
    # Exists on disk but was filtered out of the manifest, so it is not readable.
    (root / "secret.md").write_text("nope", encoding="utf-8")

    result = read_local_doc("secret.md")

    assert "not in the document manifest" in result["error"]


def test_read_local_doc_rejects_traversal_via_the_manifest_check(tmp_path):
    root = _root(tmp_path)
    set_docs_state(root)

    result = read_local_doc("../../etc/passwd")

    assert "not in the document manifest" in result["error"]


def test_read_local_doc_rejects_a_repeat_read(tmp_path):
    root = _root(tmp_path)
    set_docs_state(root)
    read_local_doc("schema.md")

    result = read_local_doc("schema.md")

    assert "already read" in result["error"]
    assert get_docs_state().read_count == 1


def test_read_local_doc_rejects_when_the_budget_is_spent(tmp_path):
    root = _root(tmp_path, {"a.md": "a", "b.md": "b"})
    set_docs_state(root, max_files=2)
    state = get_docs_state()
    state.max_files = 1
    read_local_doc("a.md")

    result = read_local_doc("b.md")

    assert "max_files reached" in result["error"]


def test_read_local_doc_surfaces_a_reader_failure_as_an_error(tmp_path, monkeypatch):
    root = _root(tmp_path)
    set_docs_state(root)

    def _boom(*args, **kwargs):
        raise DocReadError("disk on fire")

    monkeypatch.setattr("aws_reference_agent.tools.doc_tools.read", _boom)

    result = read_local_doc("schema.md")

    assert "disk on fire" in result["error"]


def test_rejection_shape_carries_budget_context(tmp_path):
    root = _root(tmp_path)
    set_docs_state(root, max_files=7)

    result = read_local_doc("missing.md")

    assert result["path"] == "missing.md"
    assert result["read_count"] == 0
    assert result["max_files_budget"] == 7
