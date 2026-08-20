from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from reference_agent.bundle.document import (
    REQUIRED_FRONTMATTER_KEYS,
    OKFDocument,
    OKFDocumentError,
)
from reference_agent.bundle.paths import concept_id_to_path, parse_concept_id
from reference_agent.tools.context import get_context, is_web_pass

_PREFERRED_KEY_ORDER = (
    "type",
    "resource",
    "title",
    "description",
    "tags",
    "status",
    "generated",
    "verified",
    "stale_after",
    "sources",
    "usage_window",
)

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


def _sources_count(frontmatter: dict[str, Any]) -> int:
    sources = frontmatter.get("sources")
    if isinstance(sources, list):
        return len(sources)
    if sources:  # a bare mapping counts as one entry
        return 1
    return 0


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

    `frontmatter` must include at minimum `type` (OKF v0.2 §11). `title`,
    `description`, `resource`, and `tags` are strongly recommended when
    applicable. `generated` is filled in automatically: leave it unset and the
    tool records `generated: {by: reference_agent/<model>, at: <now>}`, or
    provide your own `{by, at}` mapping. Provenance goes in the `sources`
    frontmatter family (not a `# Citations` body section); attribute individual
    body claims with markdown footnotes keyed to `sources[].id`. The `body`
    should contain the prose description plus `# Schema` and
    `# Common query patterns` sections per the OKF convention.

    Returns {'path': <relative path written>, 'bytes': <int>}.
    """
    ctx = get_context()
    cid = parse_concept_id(concept_id)
    path = concept_id_to_path(ctx.bundle_root, cid)

    fm = dict(frontmatter)
    generated = fm.get("generated")
    if not isinstance(generated, dict):
        generated = {}
    else:
        generated = dict(generated)
    if not generated.get("by"):
        generated["by"] = f"reference_agent/{ctx.model}" if ctx.model else "reference_agent"
    if not generated.get("at"):
        generated["at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    fm["generated"] = generated
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
    # an existing BigQuery Table doc's # Schema field set or its `sources`
    # frontmatter list. The BQ pass populates these from real metadata; the
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
            old_sources = _sources_count(existing.frontmatter)
            new_sources = _sources_count(fm)
            if new_sources < old_sources:
                return {
                    "error": (
                        f"Refusing to write: the existing `sources` "
                        f"frontmatter had {old_sources} entr(y/ies) "
                        f"(including the BigQuery resource), but your new "
                        f"`sources` has only {new_sources}. Merge your new "
                        f"source into the existing list rather than replacing "
                        f"it. Re-call write_concept_doc with every existing "
                        f"`sources` entry preserved plus the new one."
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
