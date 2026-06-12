from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from enrichment_agent.bundle.document import (
    REQUIRED_FRONTMATTER_KEYS,
    OKFDocument,
    OKFDocumentError,
)
from enrichment_agent.bundle.paths import concept_id_to_path, parse_concept_id
from enrichment_agent.tools.context import get_context, is_web_pass

_PREFERRED_KEY_ORDER = ("type", "resource", "title", "description", "tags", "timestamp")

_FIELD_NAME_RE = re.compile(r"`([A-Za-z_][A-Za-z0-9_.]*)`")


def _section_content_lines(body: str, heading: str) -> list[str]:
    """Return non-blank lines under a top-level `# heading` section."""
    in_section = False
    out: list[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            in_section = stripped == heading
            continue
        if in_section and stripped:
            out.append(line)
    return out


def _schema_field_names(body: str) -> set[str]:
    names: set[str] = set()
    for line in _section_content_lines(body, "# Schema"):
        names.update(_FIELD_NAME_RE.findall(line))
    return names


def _citation_entry_count(body: str) -> int:
    return len(_section_content_lines(body, "# Citations"))


def _reorder_frontmatter(fm: dict[str, Any]) -> dict[str, Any]:
    ordered: dict[str, Any] = {}
    for key in _PREFERRED_KEY_ORDER:
        if key in fm:
            ordered[key] = fm[key]
    for key, value in fm.items():
        if key not in ordered:
            ordered[key] = value
    return ordered


def read_existing_doc(concept_id: str) -> dict[str, Any] | None:
    """Return the existing OKF document for this concept, if one is already on
    disk.

    Use this before writing to refine prior content instead of overwriting
    blindly. Returns null when no document exists yet. When a document exists,
    returns {'frontmatter': <object>, 'body': <markdown string>}.
    """
    ctx = get_context()
    cid = parse_concept_id(concept_id)
    path = concept_id_to_path(ctx.bundle_root, cid)
    if not path.exists():
        return None
    doc = OKFDocument.parse(path.read_text(encoding="utf-8"))
    return {"frontmatter": doc.frontmatter, "body": doc.body}


def write_concept_doc(
    concept_id: str,
    frontmatter: dict[str, Any],
    body: str,
) -> dict[str, Any]:
    """Write (or overwrite) the OKF markdown document for this concept.

    `frontmatter` must include at minimum: type, title, description, timestamp
    (ISO 8601). `resource` and `tags` are strongly recommended when applicable.
    The `body` should contain the prose description plus `# Schema`,
    `# Common query patterns`, and `# Citations` sections per the OKF
    convention.

    Returns {'path': <relative path written>, 'bytes': <int>}.
    """
    ctx = get_context()
    cid = parse_concept_id(concept_id)
    path = concept_id_to_path(ctx.bundle_root, cid)

    fm = dict(frontmatter)
    if not fm.get("timestamp"):
        fm["timestamp"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    fm = _reorder_frontmatter(fm)

    doc = OKFDocument(frontmatter=fm, body=body or "")
    try:
        doc.validate()
    except OKFDocumentError as e:
        return {
            "error": (
                f"Refusing to write document with invalid frontmatter: {e}. "
                f"Required keys: {', '.join(REQUIRED_FRONTMATTER_KEYS)}. "
                f"Re-call write_concept_doc with the complete frontmatter dict."
            ),
            "concept_id": concept_id,
        }

    # Augmentation guard: during the web pass, refuse writes that shrink
    # an existing BigQuery Table doc's # Schema field set or # Citations
    # entry count. The BQ pass populates these from real metadata; the
    # web pass must augment, not replace.
    if is_web_pass() and path.exists():
        try:
            existing = OKFDocument.parse(path.read_text(encoding="utf-8"))
        except Exception:
            existing = None
        if existing is not None and existing.frontmatter.get("type") == "BigQuery Table":
            old_fields = _schema_field_names(existing.body)
            new_fields = _schema_field_names(body or "")
            missing = sorted(old_fields - new_fields)
            if missing:
                shown = ", ".join(f"`{m}`" for m in missing[:10])
                truncated = " (and more)" if len(missing) > 10 else ""
                return {
                    "error": (
                        f"Refusing to write: the existing # Schema section "
                        f"lists {len(old_fields)} field(s) populated from "
                        f"BigQuery metadata, but your new # Schema is "
                        f"missing {len(missing)} of them: {shown}"
                        f"{truncated}. Augment by adding to the existing "
                        f"schema, not replacing it. Re-call "
                        f"read_existing_doc to see the current schema, "
                        f"then re-call write_concept_doc with the full "
                        f"field list preserved."
                    ),
                    "concept_id": concept_id,
                }
            old_cites = _citation_entry_count(existing.body)
            new_cites = _citation_entry_count(body or "")
            if new_cites < old_cites:
                return {
                    "error": (
                        f"Refusing to write: the existing # Citations "
                        f"section had {old_cites} entries (including the "
                        f"BigQuery resource URL), but your new # Citations "
                        f"has only {new_cites}. Append your new citation "
                        f"rather than replacing the list. Re-call "
                        f"write_concept_doc with every existing entry "
                        f"preserved plus the new one."
                    ),
                    "concept_id": concept_id,
                }

    path.parent.mkdir(parents=True, exist_ok=True)
    text = doc.serialize()
    path.write_text(text, encoding="utf-8")
    return {
        "path": str(path.relative_to(ctx.bundle_root)),
        "bytes": len(text.encode("utf-8")),
    }
