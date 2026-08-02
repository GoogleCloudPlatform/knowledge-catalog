from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    query,
)

from aws_reference_agent.agent import (
    DEFAULT_MODEL,
    build_docs_options,
    build_source_options,
    build_web_options,
)
from aws_reference_agent.bundle.index import regenerate_indexes
from aws_reference_agent.sources.base import ConceptRef, Source
from aws_reference_agent.tools.context import (
    clear_docs_state,
    clear_web_state,
    get_docs_state,
    set_context,
    set_docs_state,
    set_expected_concepts,
    set_web_state,
)
from aws_reference_agent.verification import VerifyMode

log = logging.getLogger(__name__)

_COMPACT_STR_LIMIT = 120
_COMPACT_TEXT_LIMIT = 200


def _summarize_value(value: Any, limit: int) -> str:
    if isinstance(value, str):
        return value if len(value) <= limit else f"<{len(value)} chars>"
    if isinstance(value, dict):
        if not value:
            return "{}"
        return f"{{{len(value)} keys}}"
    if isinstance(value, list):
        return f"[{len(value)} items]"
    if isinstance(value, (int, float, bool)) or value is None:
        return repr(value)
    return f"<{type(value).__name__}>"


def _compact_args(args: dict[str, Any] | None) -> str:
    if not args:
        return ""
    parts = [
        f"{k}={_summarize_value(v, _COMPACT_STR_LIMIT)}" for k, v in args.items()
    ]
    return ", ".join(parts)


def _compact_response(value: Any) -> str:
    if isinstance(value, dict):
        if not value:
            return "{}"
        # Surface useful scalar fields verbatim, summarize others.
        bits = []
        for k, v in value.items():
            bits.append(f"{k}={_summarize_value(v, _COMPACT_STR_LIMIT)}")
        return "{" + ", ".join(bits) + "}"
    return _summarize_value(value, _COMPACT_STR_LIMIT)


def _compact_text(text: str) -> str:
    one_line = " · ".join(s.strip() for s in text.splitlines() if s.strip())
    if len(one_line) <= _COMPACT_TEXT_LIMIT:
        return one_line
    return one_line[:_COMPACT_TEXT_LIMIT].rstrip() + " …"


def _full_json(value: Any) -> str:
    try:
        return json.dumps(value, indent=2, default=str, ensure_ascii=False)
    except Exception:
        return repr(value)


def _tool_result_text(content: Any) -> Any:
    """Extract a loggable value from a ToolResultBlock's content."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        return "\n".join(texts) if texts else content
    return content


def _log_event_parts(message, prefix: str, *, verbose: bool) -> str | None:
    """Log the tool calls / results / text of a single SDK message.

    Returns the last non-empty assistant text seen, or None.
    """
    last_text: str | None = None

    if isinstance(message, (AssistantMessage, UserMessage)):
        for block in message.content:
            if isinstance(block, ToolUseBlock):
                if verbose:
                    log.info(
                        "[%s] → %s\n%s", prefix, block.name, _full_json(block.input or {})
                    )
                else:
                    log.info(
                        "[%s] → %s(%s)", prefix, block.name, _compact_args(block.input)
                    )
            elif isinstance(block, ToolResultBlock):
                response = _tool_result_text(block.content)
                label = "error" if block.is_error else "result"
                if verbose:
                    log.info("[%s] ← %s\n%s", prefix, label, _full_json(response))
                else:
                    log.info(
                        "[%s] ← %s: %s", prefix, label, _compact_response(response)
                    )
            elif isinstance(block, TextBlock):
                stripped = block.text.strip()
                if not stripped:
                    continue
                last_text = block.text
                if verbose:
                    log.info("[%s] ✎ %s", prefix, stripped)
                else:
                    log.info("[%s] ✎ %s", prefix, _compact_text(stripped))
    elif isinstance(message, ResultMessage):
        log.debug(
            "[%s] turn complete: turns=%s cost_usd=%s duration_ms=%s",
            prefix,
            message.num_turns,
            message.total_cost_usd,
            message.duration_ms,
        )

    return last_text


def _build_source_user_message(ref: ConceptRef) -> str:
    return (
        f"Enrich the concept with id: {ref.id_str}\n"
        f"OKF type: {ref.type}\n"
        f"Follow the standard workflow and write exactly one document for "
        f"this concept."
    )


def _build_web_user_message(
    seeds: list[str],
    max_pages: int,
    allowed_hosts: list[str],
    *,
    max_depth: int,
    allowed_path_prefixes: list[str],
    denied_path_substrings: list[str],
) -> str:
    seed_lines = "\n".join(f"- {s}" for s in seeds)
    allowed_lines = ", ".join(sorted(allowed_hosts)) or "(any)"
    prefixes = ", ".join(allowed_path_prefixes) or "(any path)"
    denied = ", ".join(denied_path_substrings) or "(none)"
    return (
        f"Ingest the following seed URLs and crawl outward as your judgment "
        f"directs.\n\n"
        f"Seed URLs:\n{seed_lines}\n\n"
        f"Hard limits enforced by the fetch_url tool — do not retry rejected "
        f"URLs:\n"
        f"- Max pages: {max_pages}\n"
        f"- Max hop depth from any seed: {max_depth}\n"
        f"- Allowed hosts: {allowed_lines}\n"
        f"- Allowed URL path prefixes: {prefixes}\n"
        f"- Denied URL path substrings: {denied}\n\n"
        f"Follow the web-ingestion workflow. Do not stop after a single page: "
        f"seed pages are usually indexes or schema references, so follow their "
        f"in-domain links to the high-value pages (sample-query / cookbook, "
        f"metric definitions, field/enum references) and keep going until the "
        f"relevant material is covered or the page budget is spent. For each "
        f"fetched page, decide whether it enriches an existing concept, "
        f"deserves its own `references/<slug>` doc, or should be skipped. Skip "
        f"obvious junk (nav, marketing, login), but do not skip authoritative "
        f"documentation just to conserve budget."
    )


def _build_docs_user_message(
    root: Path,
    max_files: int,
    max_bytes: int,
    *,
    include: list[str],
    exclude: list[str],
) -> str:
    includes = ", ".join(include) or "(all text files)"
    excludes = ", ".join(exclude) or "(none)"
    return (
        f"Ingest the local documents under the document root below.\n\n"
        f"Document root: {root}\n\n"
        f"Hard limits enforced by the read_local_doc tool — do not retry "
        f"rejected paths:\n"
        f"- Max files you may read: {max_files}\n"
        f"- Max bytes per document (longer documents are truncated): {max_bytes}\n"
        f"- Include globs: {includes}\n"
        f"- Exclude globs: {excludes}\n\n"
        f"Follow the document-ingestion workflow. Call `list_local_docs()` once "
        f"to get the complete set of readable paths — you cannot read a path "
        f"that is not in that listing. Then read the documents whose paths and "
        f"titles suggest they describe this bundle's data (data dictionaries, "
        f"field tables, metric definitions, query cookbooks) and fold what they "
        f"say into the existing concept docs. Enrichment is the point of this "
        f"pass: prefer augmenting an existing concept over minting a new "
        f"reference, and remember the catalog's schema wins over any document "
        f"that contradicts it."
    )


class ReferenceRunner:
    def __init__(
        self,
        source: Source,
        bundle_root: Path,
        model: str = DEFAULT_MODEL,
        web_seeds: list[str] | None = None,
        web_max_pages: int = 100,
        web_allowed_hosts: set[str] | None = None,
        web_allowed_path_prefixes: list[str] | None = None,
        web_denied_path_substrings: list[str] | None = None,
        web_max_depth: int = 2,
        docs_root: Path | None = None,
        docs_include: list[str] | None = None,
        docs_exclude: list[str] | None = None,
        docs_max_files: int = 200,
        docs_max_bytes: int = 40 * 1024,
        verbose: bool = False,
        verify_queries: str = VerifyMode.SCHEMA,
    ):
        self.source = source
        self.bundle_root = Path(bundle_root)
        self.model = model
        self.verbose = verbose
        self.verify_queries = verify_queries
        self.bundle_root.mkdir(parents=True, exist_ok=True)
        set_context(self.source, self.bundle_root, model=self.model, verify_queries=self.verify_queries)

        self.web_seeds = list(web_seeds or [])
        self.web_max_pages = int(web_max_pages)
        self.web_allowed_path_prefixes = list(web_allowed_path_prefixes or [])
        self.web_denied_path_substrings = list(web_denied_path_substrings or [])
        self.web_max_depth = int(web_max_depth)
        if web_allowed_hosts is not None:
            self.web_allowed_hosts = set(web_allowed_hosts)
        else:
            self.web_allowed_hosts = {
                urlparse(s).netloc for s in self.web_seeds if urlparse(s).netloc
            }

        self.docs_root = Path(docs_root) if docs_root else None
        self.docs_include = list(docs_include or [])
        self.docs_exclude = list(docs_exclude or [])
        self.docs_max_files = int(docs_max_files)
        self.docs_max_bytes = int(docs_max_bytes)

        self._source_options = build_source_options(model=model)
        self._web_options = (
            build_web_options(model=model) if self.web_seeds else None
        )
        self._docs_options = (
            build_docs_options(model=model) if self.docs_root else None
        )

    async def _drain(self, message: str, options, prefix: str) -> None:
        """Run one agent turn, logging each message.

        `aclosing` matters: without it the SDK's async generator is left to the
        interpreter's asyncgen shutdown hook, which finalizes it after the loop
        is already tearing down and raises "aclose(): asynchronous generator is
        already running" once per leaked pass.
        """
        async with contextlib.aclosing(
            query(prompt=message, options=options)
        ) as stream:
            async for msg in stream:
                _log_event_parts(msg, prefix, verbose=self.verbose)

    async def _enrich_concept_async(self, ref: ConceptRef) -> None:
        await self._drain(
            _build_source_user_message(ref), self._source_options, ref.id_str
        )

    def enrich_concept(self, ref: ConceptRef) -> None:
        asyncio.run(self._enrich_concept_async(ref))

    async def _run_web_pass_async(self) -> None:
        if not self._web_options or not self.web_seeds:
            return
        log.info(
            "Running web pass: %d seed(s), max_pages=%d, max_depth=%d, "
            "allowed_hosts=%s, allowed_path_prefixes=%s, "
            "denied_path_substrings=%s",
            len(self.web_seeds),
            self.web_max_pages,
            self.web_max_depth,
            sorted(self.web_allowed_hosts),
            self.web_allowed_path_prefixes,
            self.web_denied_path_substrings,
        )
        set_web_state(
            self.web_allowed_hosts,
            self.web_max_pages,
            seeds=self.web_seeds,
            allowed_path_prefixes=self.web_allowed_path_prefixes,
            denied_path_substrings=self.web_denied_path_substrings,
            max_depth=self.web_max_depth,
        )
        try:
            message = _build_web_user_message(
                self.web_seeds,
                self.web_max_pages,
                sorted(self.web_allowed_hosts),
                max_depth=self.web_max_depth,
                allowed_path_prefixes=self.web_allowed_path_prefixes,
                denied_path_substrings=self.web_denied_path_substrings,
            )
            await self._drain(message, self._web_options, "web")
        finally:
            clear_web_state()

    def run_web_pass(self) -> None:
        asyncio.run(self._run_web_pass_async())

    async def _run_docs_pass_async(self) -> None:
        if not self._docs_options or not self.docs_root:
            return
        set_docs_state(
            self.docs_root,
            include=self.docs_include or None,
            exclude=self.docs_exclude or None,
            max_files=self.docs_max_files,
            max_bytes=self.docs_max_bytes,
        )
        try:
            state = get_docs_state()
            # A truncated manifest must be visible: silently capping coverage
            # reads as "we ingested everything" when we did not.
            log.info(
                "Running docs pass: root=%s, %d document(s) discovered "
                "(%d dropped by max_files=%d), max_bytes=%d, include=%s, "
                "exclude=%s",
                state.root,
                len(state.manifest),
                state.truncated_count,
                self.docs_max_files,
                self.docs_max_bytes,
                self.docs_include,
                self.docs_exclude,
            )
            message = _build_docs_user_message(
                state.root,
                self.docs_max_files,
                self.docs_max_bytes,
                include=self.docs_include,
                exclude=self.docs_exclude,
            )
            await self._drain(message, self._docs_options, "docs")
        finally:
            clear_docs_state()

    def run_docs_pass(self) -> None:
        asyncio.run(self._run_docs_pass_async())

    async def _enrich_all_async(self, only: list[tuple[str, ...]] | None) -> int:
        concepts = self.source.list_concepts()
        if only is not None:
            wanted = set(only)
            concepts = [c for c in concepts if c.id in wanted]
            missing = wanted - {c.id for c in concepts}
            if missing:
                raise ValueError(
                    f"Unknown concept(s): {sorted('/'.join(m) for m in missing)}"
                )
        set_expected_concepts({c.id for c in concepts})

        count = 0
        for ref in concepts:
            log.info("Enriching %s (%s)", ref.id_str, ref.type)
            await self._enrich_concept_async(ref)
            count += 1

        await self._run_web_pass_async()
        # Local docs land last: they are the most likely to be stale and the
        # most org-specific, so they augment rather than get augmented.
        await self._run_docs_pass_async()

        log.info("Regenerating index.md files in %s", self.bundle_root)
        # regenerate_indexes is sync and its synthesizer opens its own event
        # loop, so it cannot run on this one.
        await asyncio.to_thread(
            regenerate_indexes, self.bundle_root, model=self.model
        )
        return count

    def enrich_all(self, only: list[tuple[str, ...]] | None = None) -> int:
        return asyncio.run(self._enrich_all_async(only))
