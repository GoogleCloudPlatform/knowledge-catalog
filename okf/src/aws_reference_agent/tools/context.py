from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from aws_reference_agent.docs.reader import discover
from aws_reference_agent.sources.base import Source
from aws_reference_agent.verification import VerifyMode


@dataclass
class ToolContext:
    source: Source
    bundle_root: Path
    model: str = ""
    expected_concept_ids: set[tuple[str, ...]] = field(default_factory=set)
    verify_queries: str = VerifyMode.SCHEMA


@dataclass
class WebState:
    allowed_hosts: set[str]
    max_pages: int
    allowed_path_prefixes: tuple[str, ...] = ()
    denied_path_substrings: tuple[str, ...] = ()
    max_depth: int = 2
    visited: set[str] = field(default_factory=set)
    fetched_count: int = 0
    url_depth: dict[str, int] = field(default_factory=dict)


@dataclass
class DocsState:
    root: Path
    manifest: dict[str, dict[str, object]]
    max_files: int
    max_bytes: int
    truncated_count: int = 0
    read: set[str] = field(default_factory=set)
    read_count: int = 0


_ctx: ToolContext | None = None
_web: WebState | None = None
_docs: DocsState | None = None


def set_context(
    source: Source,
    bundle_root: Path,
    model: str = "",
    *,
    verify_queries: str = VerifyMode.SCHEMA,
) -> None:
    global _ctx
    _ctx = ToolContext(
        source=source,
        bundle_root=Path(bundle_root),
        model=model,
        verify_queries=verify_queries,
    )


def get_context() -> ToolContext:
    if _ctx is None:
        raise RuntimeError(
            "Tool context not set. Call set_context() before invoking the agent."
        )
    return _ctx


def set_web_state(
    allowed_hosts: set[str],
    max_pages: int,
    *,
    seeds: list[str] | None = None,
    allowed_path_prefixes: list[str] | None = None,
    denied_path_substrings: list[str] | None = None,
    max_depth: int = 2,
) -> None:
    global _web
    _web = WebState(
        allowed_hosts=set(allowed_hosts),
        max_pages=int(max_pages),
        allowed_path_prefixes=tuple(allowed_path_prefixes or ()),
        denied_path_substrings=tuple(denied_path_substrings or ()),
        max_depth=int(max_depth),
    )
    for seed in seeds or ():
        _web.url_depth[seed] = 0


def get_web_state() -> WebState:
    if _web is None:
        raise RuntimeError(
            "Web state not set. Call set_web_state() before invoking the web agent."
        )
    return _web


def clear_web_state() -> None:
    global _web
    _web = None


def is_web_pass() -> bool:
    """True while the runner is executing the web-ingestion pass."""
    return _web is not None


def set_docs_state(
    root: Path | str,
    *,
    include: list[str] | None = None,
    exclude: list[str] | None = None,
    max_files: int = 200,
    max_bytes: int = 40 * 1024,
) -> None:
    """Enter the docs pass, discovering the readable document set up front.

    The manifest is computed once here rather than per tool call, so the set of
    paths the agent may read is fixed before the model runs.
    """
    global _docs
    found = discover(root, include=include, exclude=exclude, max_files=max_files)
    manifest: dict[str, dict[str, object]] = {}
    for rel in found.paths:
        stat = (found.root / rel).stat()
        manifest[rel] = {
            "bytes": stat.st_size,
            "modified": datetime.fromtimestamp(
                stat.st_mtime, tz=timezone.utc
            ).isoformat(timespec="seconds"),
        }
    _docs = DocsState(
        root=found.root,
        manifest=manifest,
        max_files=int(max_files),
        max_bytes=int(max_bytes),
        truncated_count=found.truncated_count,
    )


def get_docs_state() -> DocsState:
    if _docs is None:
        raise RuntimeError(
            "Docs state not set. Call set_docs_state() before invoking the docs agent."
        )
    return _docs


def clear_docs_state() -> None:
    global _docs
    _docs = None


def is_docs_pass() -> bool:
    """True while the runner is executing the local-document ingestion pass."""
    return _docs is not None


def is_augmenting_pass() -> bool:
    """True during any pass that augments docs the source pass already wrote.

    The augmentation guard in `bundle_tools` keys off this rather than off the
    web pass alone, so a new ingestion pass cannot silently shrink a table
    doc's schema or provenance.
    """
    return is_web_pass() or is_docs_pass()


def get_verify_mode() -> str:
    """Return the current query-verification mode."""
    return get_context().verify_queries


def set_expected_concepts(ids: set[tuple[str, ...]]) -> None:
    """Record the concept ids expected to be produced by this run.

    An empty set means "unknown" (e.g. no run scoping is active), in which
    case link validation falls back to checking file existence on disk only.
    """
    get_context().expected_concept_ids = set(ids)


def get_expected_concepts() -> set[tuple[str, ...]]:
    return get_context().expected_concept_ids
