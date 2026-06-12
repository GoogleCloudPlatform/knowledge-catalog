"""User-feedback file loader + per-table router for the enrichment agent.

Feedback files are pure JSON (typically with a `.md` extension, by upstream
convention) shaped like:

    {
      "proposals": [
        {
          "classification": {"detection_signal": "...", "gap_type": "..."},
          "target_asset": {"type": "COLUMN|TABLE|...", "name": "<FQN>"},
          "current_context_flaw": "<what was wrong>",
          "proposed_enrichment": {"action": "ADD_SYNONYM|...", "value": "..."},
          "evidence": {"reasoning": "...", "trajectory_quote": "..."},
          "confidence_grade": 0.0-1.0,
          "eval_candidate": {
            "is_valid_candidate": true,
            "user_query_intent": "<NL question>",
            "golden_sql": "SELECT ... FROM `<table>` ..."
          }
        }
      ]
    }

The agent treats these as **direct user corrections** — semantically higher-
priority than any other context source (Drive docs, Dataplex semantic search,
codesearch, even INFORMATION_SCHEMA query history). When this module's prompt
block lands in the writer prompt, it carries an explicit "OVERRIDE conflicting
info" directive. The eval_candidate's golden_sql becomes a `[Source: User
Feedback]` entry in the queries aspect — that SQL is by definition correct.

Routing: `target_asset.name` is FQN-shaped, with depth depending on `type`:
  - TABLE   → `project.dataset.table`        (3 segments)
  - COLUMN  → `project.dataset.table.column` (4 segments — strip last)
  - DATASET → `project.dataset`              (2 segments — table FQN starts with
  this)
A feedback proposal applies to a given table FQN if its target's table-level
prefix matches.
"""

import glob
import json
import os
from typing import Any


def _files_from_input(
    feedback_dir: str | None,
    feedback_files: list[str] | None,
) -> list[str]:
  """Expand a dir + explicit files list into a flat de-duped path list.

  `feedback_dir`: walked recursively for `.md` and `.json` files.
  `feedback_files`: paths added verbatim (after existence check).
  Files appearing in both inputs are de-duplicated. Order is dir-then-files,
  sorted within each group for determinism.
  """
  out: list[str] = []
  seen: set[str] = set()
  if feedback_dir and os.path.isdir(feedback_dir):
    matches = sorted(
        glob.glob(os.path.join(feedback_dir, "**", "*.md"), recursive=True)
        + glob.glob(os.path.join(feedback_dir, "**", "*.json"), recursive=True)
    )
    for p in matches:
      if p not in seen:
        seen.add(p)
        out.append(p)
  for p in feedback_files or []:
    p = (p or "").strip()
    if p and os.path.isfile(p) and p not in seen:
      seen.add(p)
      out.append(p)
  return out


def _parse_one(path: str) -> list[dict[str, Any]]:
  """Parse one feedback file → list of proposals (empty on any error)."""
  try:
    with open(path, "r", encoding="utf-8") as f:
      raw = f.read()
  except OSError:
    return []
  try:
    obj = json.loads(raw)
  except json.JSONDecodeError:
    # File may be markdown with embedded ```json blocks; fall back to
    # extracting the first fenced JSON block. This is a courtesy — the
    # documented format is pure JSON.
    fenced = _extract_fenced_json(raw)
    if fenced is None:
      return []
    obj = fenced
  proposals = obj.get("proposals") if isinstance(obj, dict) else None
  if not isinstance(proposals, list):
    return []
  # Tag each proposal with its source-file path so downstream rendering
  # can cite it (useful in trajectory + audit).
  out = []
  for p in proposals:
    if not isinstance(p, dict):
      continue
    p["_source_file"] = path
    out.append(p)
  return out


def _extract_fenced_json(text: str) -> Any | None:
  """Pull the first ```json ... ``` block out of `text` and parse it."""
  marker = "```json"
  i = text.find(marker)
  if i < 0:
    return None
  j = text.find("```", i + len(marker))
  if j < 0:
    return None
  blob = text[i + len(marker) : j].strip()
  try:
    return json.loads(blob)
  except json.JSONDecodeError:
    return None


def load_feedback(
    feedback_dir: str | None = None,
    feedback_files: list[str] | None = None,
) -> list[dict[str, Any]]:
  """Load + parse all feedback files; return a flat list of proposals.

  Each returned proposal is the raw dict from the file, augmented with
  `_source_file` (absolute path of origin). Caller deals with routing.
  """
  proposals: list[dict[str, Any]] = []
  for path in _files_from_input(feedback_dir, feedback_files):
    proposals.extend(_parse_one(path))
  return proposals


def _table_fqn_from_target(target: dict[str, Any]) -> str | None:
  """Extract the `project.dataset.table` prefix from a target_asset dict.

  Handles type=TABLE (3 segments → use as-is) and type=COLUMN (4 segments
  → drop the column). For type=DATASET or anything shallower, returns
  None (proposal applies to multiple tables; not routed here).
  """
  name = (target or {}).get("name") or ""
  parts = name.split(".")
  ttype = (target.get("type") or "").upper() if target else ""
  if ttype == "TABLE" and len(parts) == 3:
    return name
  if ttype == "COLUMN" and len(parts) == 4:
    return ".".join(parts[:3])
  # Permissive fallback: anything with ≥3 dotted segments → assume first
  # three are project.dataset.table. Handles missing/wrong `type`.
  if len(parts) >= 3:
    return ".".join(parts[:3])
  return None


def route_proposals_to_table(
    proposals: list[dict[str, Any]],
    table_fqn: str,
) -> list[dict[str, Any]]:
  """Return proposals whose target_asset's table prefix matches `table_fqn`."""
  out: list[dict[str, Any]] = []
  for p in proposals:
    routed = _table_fqn_from_target(p.get("target_asset") or {})
    if routed == table_fqn:
      out.append(p)
  return out


def proposals_to_queries(
    proposals: list[dict[str, Any]],
) -> list[dict[str, str]]:
  """Pluck eval_candidate.golden_sql out of proposals into queries-aspect dicts.

  Output shape matches what `bq_usage_tools.format_queries_sidecar` accepts
  via its `feedback_queries` kwarg: `[{"description": "...", "sql": "..."},
  ...]`.
  Only proposals where `eval_candidate.is_valid_candidate == True` AND
  `golden_sql` is non-empty contribute an entry. Each entry's description
  starts from `user_query_intent` (the original NL question), giving the
  queries aspect a human-readable hook back to the user's intent.
  """
  out: list[dict[str, str]] = []
  for p in proposals:
    ec = p.get("eval_candidate") or {}
    if not ec.get("is_valid_candidate"):
      continue
    sql = (ec.get("golden_sql") or "").strip()
    if not sql:
      continue
    intent = (ec.get("user_query_intent") or "").strip()
    out.append({
        "description": intent or "User-feedback golden SQL example.",
        "sql": sql,
    })
  return out


def proposals_to_prompt_block(
    proposals: list[dict[str, Any]],
    section_heading: str = "USER FEEDBACK PROPOSALS (HIGHEST PRIORITY)",
) -> str:
  """Render proposals as a prompt-ready block.

  The block carries an explicit OVERRIDE directive so the writer LLM treats
  these proposals as ground truth when they conflict with other inputs
  (Drive docs, search hits, INFORMATION_SCHEMA-derived patterns, etc.).
  Returns empty string when there are no proposals so the caller can
  unconditionally concatenate.
  """
  if not proposals:
    return ""
  lines = [
      "",
      f"=== {section_heading} ===",
      "These are direct user corrections collected from real user",
      "interactions with prior versions of this knowledge catalog entry.",
      "They OVERRIDE any conflicting information from other sources",
      "(Drive docs, semantic search hits, codesearch results, etc.).",
      "Each proposal MUST be reflected in the final overview body —",
      "preferably in a clearly-marked `## User Corrections` section near",
      "the TOP of the overview, with one bullet per proposal.",
      "",
  ]
  for i, p in enumerate(proposals, start=1):
    cls = p.get("classification") or {}
    tgt = p.get("target_asset") or {}
    pen = p.get("proposed_enrichment") or {}
    ev = p.get("evidence") or {}
    ec = p.get("eval_candidate") or {}
    src = p.get("_source_file") or "(unknown source)"
    lines.append(f"--- Proposal #{i} (from {os.path.basename(src)}) ---")
    lines.append(f"Target: {tgt.get('type', '?')} {tgt.get('name', '?')}")
    lines.append(
        "Detection signal:"
        f" {cls.get('detection_signal', '?')}"
        f" | Gap type: {cls.get('gap_type', '?')}"
        f" | Confidence: {p.get('confidence_grade', '?')}"
    )
    flaw = (p.get("current_context_flaw") or "").strip()
    if flaw:
      lines.append(f"Current context flaw: {flaw}")
    action = pen.get("action") or ""
    value = pen.get("value") or ""
    if action or value:
      lines.append(f"Proposed enrichment: {action} → {value!r}")
    reasoning = (ev.get("reasoning") or "").strip()
    if reasoning:
      lines.append(f"Evidence (reasoning): {reasoning}")
    quote = (ev.get("trajectory_quote") or "").strip()
    if quote:
      lines.append(f"Evidence (user quote): {quote!r}")
    if ec.get("is_valid_candidate") and ec.get("golden_sql"):
      intent = (ec.get("user_query_intent") or "").strip()
      if intent:
        lines.append(f"Validated user intent (NL): {intent}")
      lines.append("Golden SQL (will be added to queries aspect): present")
    lines.append("")
  return "\n".join(lines)
