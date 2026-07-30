from __future__ import annotations

import asyncio
import logging

log = logging.getLogger(__name__)

_PROMPT_TEMPLATE = """\
You are summarizing a directory in an Open Knowledge Format bundle in ONE \
sentence (max ~25 words).

Directory: {rel_path}
Contents:
{contents}

Write one sentence that names what this directory collectively contains. Be \
concrete and factual; do not editorialize. Output the sentence only — no \
preamble, no quotes, no trailing punctuation beyond a single period.
"""


def _fallback(children: list[tuple[str, str]]) -> str:
    titles = ", ".join(t for t, _ in children if t) or "no titled entries"
    return f"Contains {len(children)} entries: {titles}."


def synthesize_description(
    rel_path: str,
    children: list[tuple[str, str]],
    *,
    model: str,
) -> str:
    if not children:
        return ""
    contents = "\n".join(
        f"- {title}: {desc}" if desc else f"- {title}"
        for title, desc in children
    )
    prompt = _PROMPT_TEMPLATE.format(rel_path=rel_path, contents=contents)
    try:
        text = asyncio.run(_ask(prompt, model)).strip()
        if not text:
            return _fallback(children)
        return text.splitlines()[0].strip()
    except Exception as exc:
        log.warning("synthesize_description failed for %s: %s", rel_path, exc)
        return _fallback(children)


async def _ask(prompt: str, model: str) -> str:
    """One-shot text completion with no tools.

    Runs its own event loop via `asyncio.run`, so callers inside a running loop
    must dispatch this through a worker thread (see `ReferenceRunner`).
    """
    from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

    options = ClaudeAgentOptions(model=model, tools=[], allowed_tools=[])
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, ResultMessage) and message.subtype == "success":
            return message.result or ""
    return ""
