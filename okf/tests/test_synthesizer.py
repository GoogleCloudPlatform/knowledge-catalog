from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace

from aws_reference_agent.bundle import synthesizer

_CHILDREN = [("tables", "the tables"), ("databases", "the databases")]


class _FakeResultMessage:
    def __init__(self, subtype: str, result: str) -> None:
        self.subtype = subtype
        self.result = result


def _install_fake_sdk(monkeypatch, *, messages, closed) -> None:
    """Stub `claude_agent_sdk` so `_ask` iterates a generator we can observe."""

    async def fake_query(*, prompt, options):
        try:
            for m in messages:
                yield m
        finally:
            closed.append(True)

    monkeypatch.setitem(
        sys.modules,
        "claude_agent_sdk",
        SimpleNamespace(
            ClaudeAgentOptions=lambda **kwargs: kwargs,
            ResultMessage=_FakeResultMessage,
            query=fake_query,
        ),
    )


def test_should_close_query_generator_before_returning_when_result_found(monkeypatch):
    # `_ask` returns mid-iteration. The generator must be closed by the time it
    # returns, not left for loop-shutdown finalization — that deferred close
    # races the SDK's own `aclose` and raised "aclose(): asynchronous generator
    # is already running" after an otherwise successful run.
    #
    # Asserted inside a live loop on purpose: `asyncio.run` finalizes abandoned
    # generators at shutdown, so a check after it returns passes either way.
    closed: list[bool] = []
    _install_fake_sdk(
        monkeypatch,
        messages=[
            _FakeResultMessage("success", "A short description"),
            _FakeResultMessage("success", "never reached"),
        ],
        closed=closed,
    )

    async def ask_and_report() -> tuple[str, list[bool]]:
        text = await synthesizer._ask("prompt", "m")
        return text, list(closed)

    result, closed_during_loop = asyncio.run(ask_and_report())

    assert result == "A short description"
    assert closed_during_loop == [True]


def test_should_fall_back_when_no_success_message_is_emitted(monkeypatch):
    closed: list[bool] = []
    _install_fake_sdk(
        monkeypatch,
        messages=[_FakeResultMessage("error_during_execution", "")],
        closed=closed,
    )

    result = synthesizer.synthesize_description("tables", _CHILDREN, model="m")

    assert result == "Contains 2 entries: tables, databases."
    assert closed == [True]


def test_should_return_empty_without_calling_the_sdk_when_there_are_no_children():
    assert synthesizer.synthesize_description("tables", [], model="m") == ""
