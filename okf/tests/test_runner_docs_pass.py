from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from aws_reference_agent import runner as runner_mod
from aws_reference_agent.runner import ReferenceRunner
from aws_reference_agent.tools.context import clear_docs_state, is_docs_pass


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_docs_state()


def _docs_root(tmp_path: Path) -> Path:
    root = tmp_path / "docs"
    root.mkdir()
    (root / "dictionary.md").write_text("# Users\n- `id`\n", encoding="utf-8")
    return root


def _stub_query(monkeypatch, calls: list[dict]):
    """Record each pass's prompt and whether docs state was live during it."""

    async def _fake_query(*, prompt, options):
        calls.append({"prompt": prompt, "docs_pass": is_docs_pass()})
        return
        yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr(runner_mod, "query", _fake_query)


def _runner(tmp_path: Path, **kwargs) -> ReferenceRunner:
    src = MagicMock()
    src.list_concepts.return_value = []
    return ReferenceRunner(
        source=src, bundle_root=tmp_path / "bundle", **kwargs
    )


def test_docs_pass_is_skipped_when_no_docs_root(tmp_path, monkeypatch):
    calls: list[dict] = []
    _stub_query(monkeypatch, calls)
    _runner(tmp_path).run_docs_pass()
    assert calls == []


def test_docs_pass_runs_with_docs_state_live(tmp_path, monkeypatch):
    calls: list[dict] = []
    _stub_query(monkeypatch, calls)
    root = _docs_root(tmp_path)
    _runner(tmp_path, docs_root=root).run_docs_pass()

    assert len(calls) == 1
    assert calls[0]["docs_pass"] is True
    assert "dictionary.md" not in calls[0]["prompt"]  # the listing tool serves paths
    assert str(root) in calls[0]["prompt"]


def test_docs_state_is_cleared_after_the_pass(tmp_path, monkeypatch):
    calls: list[dict] = []
    _stub_query(monkeypatch, calls)
    _runner(tmp_path, docs_root=_docs_root(tmp_path)).run_docs_pass()
    assert is_docs_pass() is False


def test_docs_state_is_cleared_when_the_pass_raises(tmp_path, monkeypatch):
    async def _boom(*, prompt, options):
        raise RuntimeError("kaboom")
        yield  # pragma: no cover

    monkeypatch.setattr(runner_mod, "query", _boom)
    with pytest.raises(RuntimeError):
        _runner(tmp_path, docs_root=_docs_root(tmp_path)).run_docs_pass()
    assert is_docs_pass() is False


def test_drain_closes_the_query_generator_when_the_loop_body_raises(
    tmp_path, monkeypatch
):
    # `_drain` iterates to exhaustion, so the only way it can abandon the SDK's
    # generator is by leaving the `async for` early — i.e. an exception from the
    # loop body. Left unclosed, the generator is finalized by the interpreter's
    # asyncgen hook after the loop is already tearing down, which raised
    # "aclose(): asynchronous generator is already running" once per leaked pass.
    #
    # Asserted from inside a live loop on purpose: `asyncio.run` finalizes
    # abandoned generators at shutdown, so a check made after it returns passes
    # with or without `aclosing`.
    closed: list[bool] = []

    async def _fake_query(*, prompt, options):
        try:
            yield "first"
            yield "never reached"  # pragma: no cover
        finally:
            closed.append(True)

    def _boom(message, prefix, *, verbose):
        raise RuntimeError("logging blew up")

    monkeypatch.setattr(runner_mod, "query", _fake_query)
    monkeypatch.setattr(runner_mod, "_log_event_parts", _boom)

    r = _runner(tmp_path, docs_root=_docs_root(tmp_path))

    async def drain_and_report() -> list[bool]:
        with pytest.raises(RuntimeError, match="logging blew up"):
            await r._drain("msg", object(), "docs")
        return list(closed)

    assert asyncio.run(drain_and_report()) == [True]


def test_docs_pass_runs_after_the_web_pass_and_before_indexes(tmp_path, monkeypatch):
    order: list[str] = []

    async def _fake_query(*, prompt, options):
        order.append("docs" if is_docs_pass() else "web")
        return
        yield  # pragma: no cover

    monkeypatch.setattr(runner_mod, "query", _fake_query)
    monkeypatch.setattr(
        runner_mod,
        "regenerate_indexes",
        lambda *a, **k: order.append("indexes"),
    )

    r = _runner(
        tmp_path,
        web_seeds=["https://example.com/docs"],
        docs_root=_docs_root(tmp_path),
    )
    r.enrich_all()

    assert order == ["web", "docs", "indexes"]
