from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from enrichment_agent.agent import DEFAULT_MODEL, build_bq_agent, build_web_agent
from enrichment_agent.bundle.index import regenerate_indexes
from enrichment_agent.sources.base import ConceptRef, Source
from enrichment_agent.tools.context import (
    clear_web_state,
    set_context,
    set_web_state,
)

log = logging.getLogger(__name__)

_BQ_APP_NAME = "enrichment_agent_bq"
_WEB_APP_NAME = "enrichment_agent_web"
_USER_ID = "enricher"

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


def _log_event_parts(event, prefix: str, *, verbose: bool) -> str | None:
    if not event.content or not event.content.parts:
        return None
    last_text: str | None = None
    for part in event.content.parts:
        fc = getattr(part, "function_call", None)
        fr = getattr(part, "function_response", None)
        text = getattr(part, "text", None)
        if fc and getattr(fc, "name", None):
            if verbose:
                log.info("[%s] → %s\n%s", prefix, fc.name, _full_json(fc.args or {}))
            else:
                log.info("[%s] → %s(%s)", prefix, fc.name, _compact_args(fc.args))
        elif fr and getattr(fr, "name", None):
            response = getattr(fr, "response", None)
            if verbose:
                log.info("[%s] ← %s\n%s", prefix, fr.name, _full_json(response))
            else:
                log.info("[%s] ← %s: %s", prefix, fr.name, _compact_response(response))
        elif text:
            stripped = text.strip()
            if not stripped:
                continue
            last_text = text
            if verbose:
                log.info("[%s] ✎ %s", prefix, stripped)
            else:
                log.info("[%s] ✎ %s", prefix, _compact_text(stripped))
    return last_text


def _build_bq_user_message(ref: ConceptRef) -> types.Content:
    text = (
        f"Enrich the concept with id: {ref.id_str}\n"
        f"OKF type: {ref.type}\n"
        f"Follow the standard workflow and write exactly one document for "
        f"this concept."
    )
    return types.Content(role="user", parts=[types.Part(text=text)])


def _build_web_user_message(
    seeds: list[str],
    max_pages: int,
    allowed_hosts: list[str],
    *,
    max_depth: int,
    allowed_path_prefixes: list[str],
    denied_path_substrings: list[str],
) -> types.Content:
    seed_lines = "\n".join(f"- {s}" for s in seeds)
    allowed_lines = ", ".join(sorted(allowed_hosts)) or "(any)"
    prefixes = ", ".join(allowed_path_prefixes) or "(any path)"
    denied = ", ".join(denied_path_substrings) or "(none)"
    text = (
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
        f"Follow the web-ingestion workflow. For each fetched page, decide "
        f"whether it enriches an existing concept, deserves its own "
        f"`references/<slug>` doc, or should be skipped. Prefer skipping over "
        f"borderline fetches — the budget is small."
    )
    return types.Content(role="user", parts=[types.Part(text=text)])


class EnrichmentRunner:
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
        verbose: bool = False,
    ):
        self.source = source
        self.bundle_root = Path(bundle_root)
        self.model = model
        self.verbose = verbose
        self.bundle_root.mkdir(parents=True, exist_ok=True)
        set_context(self.source, self.bundle_root)

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

        self._bq_agent = build_bq_agent(model=model)
        self._bq_session_service = InMemorySessionService()
        self._bq_runner = Runner(
            agent=self._bq_agent,
            app_name=_BQ_APP_NAME,
            session_service=self._bq_session_service,
        )

        self._web_runner: Runner | None = None
        if self.web_seeds:
            self._web_agent = build_web_agent(model=model)
            self._web_session_service = InMemorySessionService()
            self._web_runner = Runner(
                agent=self._web_agent,
                app_name=_WEB_APP_NAME,
                session_service=self._web_session_service,
            )

    def enrich_concept(self, ref: ConceptRef) -> None:
        session_id = f"enrich-{uuid.uuid4().hex[:12]}"
        self._bq_session_service.create_session_sync(
            app_name=_BQ_APP_NAME, user_id=_USER_ID, session_id=session_id
        )
        message = _build_bq_user_message(ref)
        for event in self._bq_runner.run(
            user_id=_USER_ID, session_id=session_id, new_message=message
        ):
            _log_event_parts(event, ref.id_str, verbose=self.verbose)

    def run_web_pass(self) -> None:
        if not self._web_runner or not self.web_seeds:
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
            session_id = f"web-{uuid.uuid4().hex[:12]}"
            self._web_session_service.create_session_sync(
                app_name=_WEB_APP_NAME, user_id=_USER_ID, session_id=session_id
            )
            message = _build_web_user_message(
                self.web_seeds,
                self.web_max_pages,
                sorted(self.web_allowed_hosts),
                max_depth=self.web_max_depth,
                allowed_path_prefixes=self.web_allowed_path_prefixes,
                denied_path_substrings=self.web_denied_path_substrings,
            )
            for event in self._web_runner.run(
                user_id=_USER_ID, session_id=session_id, new_message=message
            ):
                _log_event_parts(event, "web", verbose=self.verbose)
        finally:
            clear_web_state()

    def enrich_all(self, only: list[tuple[str, ...]] | None = None) -> int:
        concepts = self.source.list_concepts()
        if only is not None:
            wanted = set(only)
            concepts = [c for c in concepts if c.id in wanted]
            missing = wanted - {c.id for c in concepts}
            if missing:
                raise ValueError(
                    f"Unknown concept(s): {sorted('/'.join(m) for m in missing)}"
                )

        count = 0
        for ref in concepts:
            log.info("Enriching %s (%s)", ref.id_str, ref.type)
            self.enrich_concept(ref)
            count += 1

        self.run_web_pass()

        log.info("Regenerating index.md files in %s", self.bundle_root)
        regenerate_indexes(self.bundle_root, model=self.model)
        return count
