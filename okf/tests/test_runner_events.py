from __future__ import annotations

import logging

from aws_reference_agent.runner import _log_event_parts
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
)


def test_logs_tool_use_compact(caplog):
    msg = AssistantMessage(
        content=[ToolUseBlock(id="1", name="list_concepts", input={"n": 5})],
        model="sonnet",
    )
    with caplog.at_level(logging.INFO, logger="aws_reference_agent.runner"):
        _log_event_parts(msg, "concept1", verbose=False)
    assert any("→ list_concepts(n=5)" in r.message for r in caplog.records)


def test_logs_tool_use_verbose(caplog):
    msg = AssistantMessage(
        content=[ToolUseBlock(id="1", name="list_concepts", input={"n": 5})],
        model="sonnet",
    )
    with caplog.at_level(logging.INFO, logger="aws_reference_agent.runner"):
        _log_event_parts(msg, "concept1", verbose=True)
    joined = "\n".join(r.message for r in caplog.records)
    assert "→ list_concepts" in joined
    assert '"n": 5' in joined


def test_logs_tool_result_compact_and_error_flag(caplog):
    msg = AssistantMessage(
        content=[
            ToolResultBlock(
                tool_use_id="1",
                content=[{"type": "text", "text": "boom"}],
                is_error=True,
            )
        ],
        model="sonnet",
    )
    with caplog.at_level(logging.INFO, logger="aws_reference_agent.runner"):
        _log_event_parts(msg, "concept1", verbose=False)
    assert any("← error: boom" in r.message for r in caplog.records)


def test_logs_text_block_and_returns_last_text():
    msg = AssistantMessage(
        content=[TextBlock(text="  hello world  ")],
        model="sonnet",
    )
    last = _log_event_parts(msg, "concept1", verbose=False)
    assert last == "  hello world  "


def test_result_message_logged_at_debug(caplog):
    msg = ResultMessage(
        subtype="success",
        duration_ms=100,
        duration_api_ms=90,
        is_error=False,
        num_turns=3,
        session_id="s1",
        total_cost_usd=0.01,
    )
    with caplog.at_level(logging.DEBUG, logger="aws_reference_agent.runner"):
        _log_event_parts(msg, "concept1", verbose=False)
    assert any("turn complete" in r.message for r in caplog.records)
