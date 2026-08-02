from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from aws_reference_agent import agent as agent_mod
from aws_reference_agent.tools.context import (
    clear_docs_state,
    clear_web_state,
    set_context,
)


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_web_state()
    clear_docs_state()


def _set_ctx(tmp_path: Path) -> None:
    src = MagicMock()
    src.list_concepts.return_value = []
    set_context(src, tmp_path, model="sonnet")


def _run(handler, args):
    return asyncio.run(handler(args))


def test_list_concepts_wrapper_success(tmp_path):
    _set_ctx(tmp_path)
    result = _run(agent_mod._list_concepts.handler, {})
    assert result.get("is_error") is not True
    text = result["content"][0]["text"]
    assert json.loads(text) == []


def test_list_concepts_wrapper_error(tmp_path, monkeypatch):
    _set_ctx(tmp_path)

    def _boom():
        raise RuntimeError("kaboom")

    monkeypatch.setattr(agent_mod, "list_concepts", _boom)
    # rebuild handler bound to the raising function
    wrapped = agent_mod._wrap("list_concepts", {}, _boom)
    result = _run(wrapped.handler, {})
    assert result["is_error"] is True
    assert "kaboom" in result["content"][0]["text"]


def test_read_concept_raw_wrapper_success(tmp_path):
    src = MagicMock()
    ref = MagicMock()
    src.find.return_value = ref
    src.read_concept.return_value = {"schema": {"a": "b"}}
    set_context(src, tmp_path, model="sonnet")

    result = _run(
        agent_mod._read_concept_raw.handler, {"concept_id": "tables/foo"}
    )
    assert result.get("is_error") is not True
    assert json.loads(result["content"][0]["text"]) == {"schema": {"a": "b"}}


def test_read_concept_raw_wrapper_error_unknown_concept(tmp_path):
    src = MagicMock()
    src.find.return_value = None
    set_context(src, tmp_path, model="sonnet")

    result = _run(
        agent_mod._read_concept_raw.handler, {"concept_id": "tables/missing"}
    )
    assert result["is_error"] is True
    assert "Unknown concept" in result["content"][0]["text"]


def test_sample_rows_wrapper_success(tmp_path):
    src = MagicMock()
    ref = MagicMock()
    src.find.return_value = ref
    src.sample_rows.return_value = [{"x": 1}]
    set_context(src, tmp_path, model="sonnet")

    result = _run(agent_mod._sample_rows.handler, {"concept_id": "t/x", "n": 3})
    assert result.get("is_error") is not True
    payload = json.loads(result["content"][0]["text"])
    assert payload["rows"] == [{"x": "1"}]


def test_write_concept_doc_wrapper_success(tmp_path):
    _set_ctx(tmp_path)
    result = _run(
        agent_mod._write_concept_doc.handler,
        {
            "concept_id": "tables/foo",
            "frontmatter": {
                "type": "Glue Table",
                "title": "Foo",
                "description": "d",
                "resource": "arn:aws:glue:x",
                "tags": ["a"],
            },
            "body": "body text",
        },
    )
    assert result.get("is_error") is not True
    payload = json.loads(result["content"][0]["text"])
    assert "path" in payload


def test_read_existing_doc_wrapper_missing(tmp_path):
    _set_ctx(tmp_path)
    result = _run(
        agent_mod._read_existing_doc.handler, {"concept_id": "tables/nope"}
    )
    assert result.get("is_error") is not True
    assert json.loads(result["content"][0]["text"]) is None


def test_fetch_url_wrapper_error_no_web_state(tmp_path):
    _set_ctx(tmp_path)
    result = _run(agent_mod._fetch_url.handler, {"url": "https://example.com"})
    assert result["is_error"] is True
    assert "Web state not set" in result["content"][0]["text"]


def test_read_local_doc_wrapper_error_no_docs_state(tmp_path):
    _set_ctx(tmp_path)
    result = _run(agent_mod._read_local_doc.handler, {"path": "a.md"})
    assert result["is_error"] is True
    assert "Docs state not set" in result["content"][0]["text"]


def test_build_docs_options():
    options = agent_mod.build_docs_options()
    assert options.tools == []
    assert options.model == agent_mod.DEFAULT_MODEL
    assert options.system_prompt
    assert options.allowed_tools == [
        "mcp__okf__list_concepts",
        "mcp__okf__read_concept_raw",
        "mcp__okf__read_existing_doc",
        "mcp__okf__write_concept_doc",
        "mcp__okf__list_local_docs",
        "mcp__okf__read_local_doc",
    ]


def test_build_source_options():
    options = agent_mod.build_source_options(model="opus")
    assert options.tools == []
    assert options.model == "opus"
    assert options.system_prompt
    assert options.allowed_tools == [
        "mcp__okf__list_concepts",
        "mcp__okf__read_concept_raw",
        "mcp__okf__sample_rows",
        "mcp__okf__read_existing_doc",
        "mcp__okf__write_concept_doc",
        "mcp__okf__validate_query",
    ]


def test_build_web_options():
    options = agent_mod.build_web_options()
    assert options.tools == []
    assert options.model == agent_mod.DEFAULT_MODEL
    assert options.system_prompt
    assert options.allowed_tools == [
        "mcp__okf__list_concepts",
        "mcp__okf__read_concept_raw",
        "mcp__okf__read_existing_doc",
        "mcp__okf__write_concept_doc",
        "mcp__okf__fetch_url",
    ]
