from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlparse

_SEGMENT_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.\-]*")


def _validate_segment(seg: str) -> None:
    if not _SEGMENT_RE.fullmatch(seg):
        raise ValueError(f"Invalid concept id segment: {seg!r}")


def concept_id_to_path(bundle_root: Path, concept_id: tuple[str, ...]) -> Path:
    if not concept_id:
        raise ValueError("concept_id must have at least one segment")
    for seg in concept_id:
        _validate_segment(seg)
    *dirs, name = concept_id
    return bundle_root.joinpath(*dirs, f"{name}.md")


def path_to_concept_id(bundle_root: Path, path: Path) -> tuple[str, ...]:
    rel = path.relative_to(bundle_root).with_suffix("")
    return tuple(rel.parts)


def parse_concept_id(s: str) -> tuple[str, ...]:
    parts = tuple(p for p in s.split("/") if p)
    if not parts:
        raise ValueError(f"Empty concept id: {s!r}")
    for p in parts:
        _validate_segment(p)
    return parts


def resolve_reference_path(
    bundle_root: Path,
    concept_path: Path,
    reference: str,
) -> str:
    """Resolve an OKF §6.2 path-valued reference.

    URLs are returned unchanged.

    Bundle-relative paths beginning with '/' are interpreted relative
    to the bundle root.

    Other paths are interpreted relative to the directory containing
    the concept document.

    The returned bundle-relative paths always begin with '/'.
    """
    reference = str(reference).strip()

    if not reference:
        return reference

    parsed = urlparse(reference)
    if parsed.scheme:
        return reference

    bundle_root = bundle_root.resolve()
    concept_path = concept_path.resolve()

    if reference.startswith("/"):
        candidate = (bundle_root / reference.lstrip("/")).resolve()
    else:
        candidate = (concept_path.parent / reference).resolve()

    try:
        relative = candidate.relative_to(bundle_root)
    except ValueError as exc:
        raise ValueError(
            f"Reference escapes bundle root: {reference!r}"
        ) from exc

    return "/" + relative.as_posix()
