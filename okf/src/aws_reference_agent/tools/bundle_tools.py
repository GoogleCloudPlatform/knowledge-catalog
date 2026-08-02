from __future__ import annotations

import posixpath
import re
from datetime import datetime, timezone
from typing import Any

from aws_reference_agent.bundle.document import (
    REQUIRED_FRONTMATTER_KEYS,
    OKFDocument,
    OKFDocumentError,
)
from aws_reference_agent.bundle.paths import concept_id_to_path, parse_concept_id
from aws_reference_agent.bundle.sql_check import (
    extract_sql_blocks,
    section_content_lines,
    unknown_identifiers,
)
from aws_reference_agent.okf_types import SOURCE_TABLE_TYPE
from aws_reference_agent.tools.context import (
    get_context,
    get_expected_concepts,
    get_verify_mode,
    is_augmenting_pass,
)
from aws_reference_agent.verification import VerifyMode

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

_LINK_TARGET_RE = re.compile(r"\]\(\s*([^)\s]+)")


def _dead_links(body: str, cid: tuple[str, ...]) -> list[str]:
    """Return offending markdown link targets that will not resolve to a
    document in the bundle.

    Skips absolute URLs, mailto links, anchors, root-relative links (`/...`),
    non-`.md` targets, and `index.md` targets (generated after all concepts
    are written). Everything else is resolved relative to the directory the
    doc being written lives in, then checked against the bundle: either the
    resolved file already exists on disk, or its bundle-relative path matches
    a concept id in the run's expected-concept set. When that set is empty
    (unknown scope), only the file-existence check applies.
    """
    ctx = get_context()
    expected = get_expected_concepts()
    dir_rel = "/".join(cid[:-1])
    offenders: list[str] = []
    for target in _LINK_TARGET_RE.findall(body):
        if target.startswith(("http://", "https://", "mailto:", "#", "/")):
            continue
        if not target.lower().endswith(".md"):
            continue
        if posixpath.basename(target) == "index.md":
            continue

        joined = posixpath.join(dir_rel, target) if dir_rel else target
        resolved = posixpath.normpath(joined)
        if resolved == ".." or resolved.startswith("../"):
            offenders.append(f"{target} (escapes the bundle root)")
            continue

        if (ctx.bundle_root / resolved).exists():
            continue
        candidate_id = tuple(resolved[: -len(".md")].split("/"))
        if expected and candidate_id in expected:
            continue
        offenders.append(target)
    return offenders


def _section_content_lines(body: str, heading: str) -> list[str]:
    # Delegate to the canonical implementation in bundle.sql_check.
    return section_content_lines(body, heading)


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
    tool records `generated: {by: aws_reference_agent/<model>, at: <now>}`, or
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
        generated["by"] = f"aws_reference_agent/{ctx.model}" if ctx.model else "aws_reference_agent"
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

    dead_links = _dead_links(body or "", cid)
    if dead_links:
        shown = "; ".join(dead_links[:10])
        truncated = " (and more)" if len(dead_links) > 10 else ""
        return {
            "error": (
                f"Refusing to write: the body links to "
                f"{len(dead_links)} target(s) that will never exist in this "
                f"bundle: {shown}{truncated}. This is final — the target is "
                f"out of this run's scope, so re-checking list_concepts will "
                f"not change it (an entry there with `in_scope: false` is "
                f"listed for recognition only, not as a link target). Drop the "
                f"link(s) or rewrite the prose to name the concept as plain "
                f"text; only link to in-scope concepts or documents already on "
                f"disk."
            ),
            "concept_id": concept_id,
        }

    # Mint guard: an augmenting pass may only create documents under
    # `references/`. Anything else it creates is a concept the source pass never
    # advertised, so its schema and `resource` are the model's invention rather
    # than catalog metadata — and the schema guard below cannot catch that,
    # because there is no existing doc to compare against. Keyed on the
    # destination rather than the declared `type` so relabelling cannot bypass
    # it.
    if is_augmenting_pass() and not path.exists() and cid[0] != "references":
        return {
            "error": (
                f"Refusing to write: this pass augments concepts the source "
                f"pass already produced, and no document exists yet at "
                f"{concept_id}. An ingestion pass may only create new "
                f"documents under `references/`. If the document you ingested "
                f"describes a concept the catalog does not have, do not mint "
                f"it: either record what it says in a `references/<slug>` doc, "
                f"or note the discrepancy in the prose of an existing concept."
            ),
            "concept_id": concept_id,
        }

    # SQL schema-consistency guard: check that every bare column identifier in
    # # Common query patterns exists in # Schema. Runs only for source-table
    # docs with a non-empty schema, and only when verify mode is not OFF.
    if (
        get_verify_mode() != VerifyMode.OFF
        and fm.get("type") == SOURCE_TABLE_TYPE
    ):
        known = _schema_field_names(body or "")
        if known:
            all_unknown: list[str] = []
            for sql_block in extract_sql_blocks(body or ""):
                all_unknown.extend(
                    t for t in unknown_identifiers(sql_block, known)
                    if t not in all_unknown
                )
            if all_unknown:
                shown = ", ".join(f"`{u}`" for u in all_unknown[:10])
                truncated = " (and more)" if len(all_unknown) > 10 else ""
                return {
                    "error": (
                        f"Refusing to write: a # Common query patterns snippet "
                        f"references {len(all_unknown)} column(s) not present in "
                        f"# Schema: {shown}{truncated}. Verify column names against "
                        f"the # Schema section and correct the SQL snippets. "
                        f"Re-call write_concept_doc with the corrected body."
                    ),
                    "concept_id": concept_id,
                }

    # Augmentation guard: during any ingestion pass, refuse writes that shrink
    # an existing source table doc's # Schema field set or its `sources`
    # frontmatter list. The source pass populates these from real metadata;
    # later passes must augment, not replace.
    if is_augmenting_pass() and path.exists():
        try:
            existing = OKFDocument.parse(path.read_text(encoding="utf-8"))
        except Exception:
            existing = None
        if existing is not None and existing.frontmatter.get("type") == SOURCE_TABLE_TYPE:
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
                        f"source metadata, but your new # Schema is "
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
                        f"(including the source resource), but your new "
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
