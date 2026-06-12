from __future__ import annotations

from typing import Any

from enrichment_agent.bundle.paths import parse_concept_id
from enrichment_agent.tools.context import get_context


def _ref_to_dict(ref) -> dict[str, Any]:
    return {
        "id": ref.id_str,
        "type": ref.type,
        "resource": ref.resource,
        "hint": dict(ref.hint),
    }


def list_concepts() -> list[dict[str, Any]]:
    """List every concept the active source advertises.

    Returns a list of objects with fields: `id` (slash-joined path used as the
    concept_id in other tools), `type` (OKF type, e.g. 'BigQuery Table'),
    `resource` (canonical URI of the underlying asset, if any), and `hint`
    (source-specific extra info such as wildcard flags or shard counts).
    """
    src = get_context().source
    return [_ref_to_dict(r) for r in src.list_concepts()]


def read_concept_raw(concept_id: str) -> dict[str, Any]:
    """Fetch raw structured metadata for a single concept from its source.

    `concept_id` is the slash-joined id returned by `list_concepts` (e.g.
    'tables/events_'). For BigQuery tables this includes schema (with nested
    RECORD fields), partitioning, clustering, row counts, and timestamps.
    """
    src = get_context().source
    cid = parse_concept_id(concept_id)
    ref = src.find(cid)
    if ref is None:
        raise ValueError(f"Unknown concept: {concept_id}")
    return src.read_concept(ref)


def sample_rows(concept_id: str, n: int = 5) -> dict[str, Any]:
    """Pull a small sample of rows from the underlying asset, if supported.

    Returns an object with `rows` (a list of stringified row dicts; empty if
    sampling is unsupported or fails) and `note` (a short human-readable
    explanation when rows could not be sampled).
    """
    src = get_context().source
    cid = parse_concept_id(concept_id)
    ref = src.find(cid)
    if ref is None:
        return {"rows": [], "note": f"Unknown concept: {concept_id}"}
    try:
        rows = src.sample_rows(ref, n=n)
    except Exception as e:
        return {"rows": [], "note": f"Sampling failed: {e}"}
    if rows is None:
        return {"rows": [], "note": "Sampling is not supported for this concept."}
    coerced = [{k: str(v) for k, v in row.items()} for row in rows]
    return {"rows": coerced, "note": ""}
