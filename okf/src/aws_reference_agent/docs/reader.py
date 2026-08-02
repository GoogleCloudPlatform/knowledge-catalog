"""Read plain-text and markdown documents from a local directory.

The docs-pass analogue of `web/fetcher.py`: pure I/O with no awareness of tool
state, so the confinement rules below can be tested directly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from fnmatch import fnmatch
from pathlib import Path

_TEXT_SUFFIXES = frozenset({".md", ".markdown", ".txt", ".text", ".rst"})
_MAX_DOC_BYTES = 40 * 1024
_MAX_FILES = 200
_MAX_TITLE_CHARS = 120

_ATX_TITLE_RE = re.compile(r"^#\s+(.+?)\s*$")


class DocReadError(Exception):
    pass


@dataclass(frozen=True)
class LocalDoc:
    rel_path: str
    title: str | None
    markdown: str
    bytes: int
    modified: str


@dataclass(frozen=True)
class DocManifest:
    root: Path
    paths: list[str] = field(default_factory=list)
    truncated_count: int = 0


def _truncate(text: str, max_bytes: int) -> str:
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return text
    return encoded[:max_bytes].decode("utf-8", errors="ignore") + "\n\n[...truncated...]"


def _resolved_root(root: Path | str) -> Path:
    resolved = Path(root).resolve()
    if not resolved.is_dir():
        raise DocReadError(f"docs root is not a directory: {root}")
    return resolved


def _confine(root: Path, rel_path: str) -> Path:
    """Resolve `rel_path` under `root`, refusing anything that escapes it.

    Resolving before the containment check is what makes this safe against both
    `../` traversal and symlinks whose target lies outside the root.
    """
    resolved = (root / rel_path).resolve()
    if resolved != root and not resolved.is_relative_to(root):
        raise DocReadError(f"path resolves outside the docs root: {rel_path}")
    return resolved


def _extract_title(text: str) -> str | None:
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        match = _ATX_TITLE_RE.match(stripped)
        if match:
            return match.group(1)
        return stripped[:_MAX_TITLE_CHARS]
    return None


def discover(
    root: Path | str,
    *,
    include: list[str] | None = None,
    exclude: list[str] | None = None,
    max_files: int = _MAX_FILES,
) -> DocManifest:
    """List candidate documents under `root`, as sorted root-relative paths.

    Only text suffixes are considered. Dotfiles, dot-directories, and anything
    resolving outside `root` (notably escaping symlinks) are omitted. The result
    is truncated to `max_files`, with the number dropped reported separately so
    the caller can surface it rather than capping silently.
    """
    resolved_root = _resolved_root(root)

    found: list[str] = []
    for path in resolved_root.rglob("*"):
        rel = path.relative_to(resolved_root).as_posix()
        if any(part.startswith(".") for part in rel.split("/")):
            continue
        if path.suffix.lower() not in _TEXT_SUFFIXES:
            continue
        if not path.is_file():
            continue
        try:
            _confine(resolved_root, rel)
        except DocReadError:
            continue
        if include and not any(fnmatch(rel, pattern) for pattern in include):
            continue
        if exclude and any(fnmatch(rel, pattern) for pattern in exclude):
            continue
        found.append(rel)

    found.sort()
    kept = found[:max_files]
    return DocManifest(
        root=resolved_root,
        paths=kept,
        truncated_count=len(found) - len(kept),
    )


def read(
    root: Path | str,
    rel_path: str,
    *,
    max_bytes: int = _MAX_DOC_BYTES,
) -> LocalDoc:
    """Read one document under `root` and return it as markdown plus metadata.

    `bytes` is the true on-disk size even when `markdown` was truncated, so a
    consumer can tell that it is holding a partial document.
    """
    resolved_root = _resolved_root(root)
    path = _confine(resolved_root, rel_path)

    if not path.is_file():
        raise DocReadError(f"not a regular file: {rel_path}")

    try:
        raw = path.read_bytes()
        modified_ts = path.stat().st_mtime
    except OSError as e:
        raise DocReadError(str(e)) from e

    text = raw.decode("utf-8", errors="replace")
    modified = (
        datetime.fromtimestamp(modified_ts, tz=timezone.utc).isoformat(timespec="seconds")
    )

    return LocalDoc(
        rel_path=path.relative_to(resolved_root).as_posix(),
        title=_extract_title(text),
        markdown=_truncate(text, max_bytes),
        bytes=len(raw),
        modified=modified,
    )
