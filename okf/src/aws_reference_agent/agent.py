from __future__ import annotations

import json
from importlib import resources
from typing import Any, Callable

from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, tool

from aws_reference_agent.tools.bundle_tools import read_existing_doc, write_concept_doc
from aws_reference_agent.tools.doc_tools import list_local_docs, read_local_doc
from aws_reference_agent.tools.source_tools import (
    list_concepts,
    read_concept_raw,
    sample_rows,
    validate_query,
)
from aws_reference_agent.tools.web_tools import fetch_url

DEFAULT_MODEL = "sonnet"

_SERVER_NAME = "okf"


def _load_prompt(filename: str) -> str:
    return (
        resources.files("aws_reference_agent.prompts")
        .joinpath(filename)
        .read_text(encoding="utf-8")
    )


def _qualify(name: str) -> str:
    return f"mcp__{_SERVER_NAME}__{name}"


def _wrap(name: str, input_schema: dict, fn: Callable[..., Any]):
    """Wrap a sync tool function into an async @tool-decorated handler.

    The description shown to the model is the wrapped function's own
    docstring, preserved verbatim.
    """

    description = (fn.__doc__ or "").strip()

    @tool(name, description, input_schema)
    async def _handler(args: dict) -> dict:
        try:
            result = fn(**args)
        except Exception as e:  # noqa: BLE001 - surface to the agent loop
            return {"content": [{"type": "text", "text": str(e)}], "is_error": True}
        text = json.dumps(result, indent=2, default=str, ensure_ascii=False)
        return {"content": [{"type": "text", "text": text}]}

    return _handler


_list_concepts = _wrap("list_concepts", {}, list_concepts)
_read_concept_raw = _wrap(
    "read_concept_raw", {"concept_id": str}, read_concept_raw
)
_sample_rows = _wrap(
    "sample_rows", {"concept_id": str, "n": int}, sample_rows
)
_read_existing_doc = _wrap(
    "read_existing_doc", {"concept_id": str}, read_existing_doc
)
_write_concept_doc = _wrap(
    "write_concept_doc",
    {"concept_id": str, "frontmatter": dict, "body": str},
    write_concept_doc,
)
_fetch_url = _wrap("fetch_url", {"url": str}, fetch_url)
_list_local_docs = _wrap("list_local_docs", {}, list_local_docs)
_read_local_doc = _wrap("read_local_doc", {"path": str}, read_local_doc)
_validate_query = _wrap("validate_query", {"sql": str}, validate_query)


def build_source_options(model: str = DEFAULT_MODEL) -> ClaudeAgentOptions:
    tools = [
        _list_concepts,
        _read_concept_raw,
        _sample_rows,
        _read_existing_doc,
        _write_concept_doc,
        _validate_query,
    ]
    server = create_sdk_mcp_server(name=_SERVER_NAME, version="1.0.0", tools=tools)
    allowed = [
        _qualify(n)
        for n in (
            "list_concepts",
            "read_concept_raw",
            "sample_rows",
            "read_existing_doc",
            "write_concept_doc",
            "validate_query",
        )
    ]
    return ClaudeAgentOptions(
        system_prompt=_load_prompt("reference_instruction.md"),
        mcp_servers={_SERVER_NAME: server},
        allowed_tools=allowed,
        tools=[],
        model=model,
    )


def build_web_options(model: str = DEFAULT_MODEL) -> ClaudeAgentOptions:
    tools = [
        _list_concepts,
        _read_concept_raw,
        _read_existing_doc,
        _write_concept_doc,
        _fetch_url,
    ]
    server = create_sdk_mcp_server(name=_SERVER_NAME, version="1.0.0", tools=tools)
    allowed = [
        _qualify(n)
        for n in (
            "list_concepts",
            "read_concept_raw",
            "read_existing_doc",
            "write_concept_doc",
            "fetch_url",
        )
    ]
    return ClaudeAgentOptions(
        system_prompt=_load_prompt("web_ingestion_instruction.md"),
        mcp_servers={_SERVER_NAME: server},
        allowed_tools=allowed,
        tools=[],
        model=model,
    )


def build_docs_options(model: str = DEFAULT_MODEL) -> ClaudeAgentOptions:
    tools = [
        _list_concepts,
        _read_concept_raw,
        _read_existing_doc,
        _write_concept_doc,
        _list_local_docs,
        _read_local_doc,
    ]
    server = create_sdk_mcp_server(name=_SERVER_NAME, version="1.0.0", tools=tools)
    allowed = [
        _qualify(n)
        for n in (
            "list_concepts",
            "read_concept_raw",
            "read_existing_doc",
            "write_concept_doc",
            "list_local_docs",
            "read_local_doc",
        )
    ]
    return ClaudeAgentOptions(
        system_prompt=_load_prompt("docs_ingestion_instruction.md"),
        mcp_servers={_SERVER_NAME: server},
        allowed_tools=allowed,
        tools=[],
        model=model,
    )
