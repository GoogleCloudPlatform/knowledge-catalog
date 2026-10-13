"""OKF v0.1 conformance checking (SPEC §9).

A small, dependency-light validator that checks an on-disk OKF bundle against
the three conformance rules in SPEC §9:

  1. Every non-reserved ``.md`` file contains a parseable YAML frontmatter
     block (§9.1).
  2. Every frontmatter block contains a non-empty ``type`` field (§9.2).
  3. Reserved files (``index.md``, ``log.md``) follow their prescribed shape
     when present (§9.3). This checks the one hard ``index.md`` rule —
     frontmatter is permitted only in a bundle-root ``index.md`` and only the
     ``okf_version`` key (§6/§11).

Note that §9.3 also covers ``log.md`` date-heading structure (§7) and
``index.md`` body sections (§6). Those are *not* validated here: faithfully
deciding whether a ``##`` line is a real heading or fenced-code content
requires a full CommonMark parser, which is out of scope for this
dependency-light checker, so a ``log.md`` is accepted as-is. Because of that
gap the tool reports "no violations in the checked rules" rather than
asserting full v0.1 conformance.

This is intentionally *stricter to detect* than the permissive consumption
model SPEC §9 mandates for consumers: a validator's job is to surface
problems, while a consumer must tolerate them. For the producer-level bar
(``type``/``title``/``description``/``timestamp``), pass ``strict=True``.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from reference_agent.bundle.document import (
    REQUIRED_FRONTMATTER_KEYS,
    OKFDocument,
)

# Reserved filenames (SPEC §3.1).
INDEX_NAME = "index.md"
LOG_NAME = "log.md"

_FRONTMATTER_DELIM = "---"
# SPEC §11: the only frontmatter key permitted in a bundle-root index.md.
_ROOT_INDEX_ALLOWED_KEYS = frozenset({"okf_version"})


@dataclass(frozen=True)
class Violation:
    """A single OKF v0.1 conformance violation."""

    path: str  # bundle-relative POSIX path of the offending file
    rule: str  # SPEC reference, e.g. "§9.1", "§9.2", "§6", "§11"
    message: str

    def __str__(self) -> str:
        return f"{self.path}: [{self.rule}] {self.message}"


def _has_frontmatter_block(text: str) -> bool:
    """Whether ``text`` opens with a frontmatter block.

    Mirrors ``OKFDocument.parse``: a block exists iff the first line is the
    ``---`` delimiter. ``parse`` silently returns an empty mapping when no
    block is present, so presence must be checked separately to enforce §9.1.
    """
    lines = text.splitlines()
    return bool(lines) and lines[0].strip() == _FRONTMATTER_DELIM


def _check_concept(rel: str, text: str, *, strict: bool) -> list[Violation]:
    out: list[Violation] = []
    # §9.1 — a parseable YAML frontmatter block must be present.
    if not _has_frontmatter_block(text):
        out.append(Violation(rel, "§9.1", "missing YAML frontmatter block"))
        return out
    try:
        doc = OKFDocument.parse(text)
    except ValueError as exc:
        # OKFDocumentError (unterminated / non-mapping frontmatter) is a
        # ValueError subclass; PyYAML's implicit resolvers also raise a *bare*
        # ValueError for e.g. an out-of-range timestamp (`2026-13-45`). Both
        # mean the frontmatter cannot be parsed, so both are §9.1.
        out.append(Violation(rel, "§9.1", f"unparseable frontmatter: {exc}"))
        return out
    # §9.2 — frontmatter must contain a non-empty `type`.
    type_val = doc.frontmatter.get("type")
    if not (isinstance(type_val, str) and type_val.strip()):
        out.append(Violation(rel, "§9.2", "missing or empty 'type' field"))
    # --strict — also enforce the producer-level recommended keys (§4.1).
    if strict:
        missing = [
            k
            for k in REQUIRED_FRONTMATTER_KEYS
            if k != "type" and not doc.frontmatter.get(k)
        ]
        if missing:
            out.append(
                Violation(
                    rel,
                    "§4.1",
                    f"strict: missing recommended key(s): {', '.join(missing)}",
                )
            )
    return out


def _check_index(rel: str, text: str, *, is_root: bool) -> list[Violation]:
    # §6 — index.md carries no frontmatter; §11 permits only `okf_version`
    # in the bundle-root index.md.
    if not _has_frontmatter_block(text):
        return []
    if not is_root:
        return [Violation(rel, "§6", "index.md must not contain frontmatter")]
    try:
        doc = OKFDocument.parse(text)
    except ValueError as exc:  # see _check_concept: covers OKFDocumentError + bare ValueError
        return [Violation(rel, "§6", f"unparseable index frontmatter: {exc}")]
    extra = sorted(k for k in doc.frontmatter if k not in _ROOT_INDEX_ALLOWED_KEYS)
    if extra:
        return [
            Violation(
                rel,
                "§11",
                "root index.md frontmatter may only contain 'okf_version'; "
                f"found: {', '.join(extra)}",
            )
        ]
    return []


def check_bundle(root, *, strict: bool = False) -> list[Violation]:
    """Check an OKF bundle directory against the SPEC v0.1 §9 conformance rules.

    Args:
      root: Path to the bundle root directory.
      strict: Also enforce the producer-level recommended keys (``title``,
        ``description``, ``timestamp``) from SPEC §4.1, on top of §9.

    Returns:
      A list of :class:`Violation` (empty means the bundle is conformant),
      ordered by file path.

    Raises:
      FileNotFoundError: if ``root`` is not a directory.
    """
    root = Path(root)
    if not root.is_dir():
        raise FileNotFoundError(f"Bundle directory not found: {root}")
    root_resolved = root.resolve()

    violations: list[Violation] = []
    for md_path in sorted(root.rglob("*.md")):
        # rglob also matches directories and broken symlinks whose name ends in
        # '.md'; only regular files are concept/reserved documents (§3/§9).
        if not md_path.is_file():
            continue
        rel = md_path.relative_to(root).as_posix()
        try:
            text = md_path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError) as exc:
            violations.append(Violation(rel, "read", f"cannot read file: {exc}"))
            continue
        name = md_path.name
        if name == INDEX_NAME:
            is_root = md_path.parent.resolve() == root_resolved
            violations.extend(_check_index(rel, text, is_root=is_root))
        elif name == LOG_NAME:
            # Reserved file (§7). Its date-heading structure is not validated
            # (see the module docstring); the file is accepted as-is.
            continue
        else:
            violations.extend(_check_concept(rel, text, strict=strict))
    return violations
