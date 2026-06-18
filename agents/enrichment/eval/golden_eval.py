"""Golden-based evaluation of an enrichment run.

Where the dynamic (golden-free) evaluator grounds only in what the agent
retrieved, this scores the output against a hand-authored / harvested GOLDEN that
declares the concepts, facts, sections, and terms the enrichment SHOULD contain.
See goldens/README.md for the golden schema and how to build one.

Adds, on top of the dynamic metrics (structural_validity, perf, hallucination_free):
  - concept_recall / concept_precision : did we capture the expected concepts as
    entries, without spurious/duplicate ones? (doc mode; needs expected_topics)
  - fact_recall                        : are each concept's / table's golden facts
    conveyed? (doc + table)
  - enrichment_diversity               : are the expected sections present?
                                         (needs expected_headings)
  - business_terms_presence            : are the expected business terms covered?
  - persona_alignment                  : (optional) does the output emphasize a
                                         persona's focus areas? (needs personas)

Scores are 0..1 (None = self-skipped). CLI: `python -m eval --output-dir DIR --golden G.json`.
"""

from __future__ import annotations

import json
import os
import tempfile

from . import loaders
from . import metrics
from . import dynamic_eval

# Default pass thresholds (report-oriented; tune per your bar).
_THRESHOLDS = {"concept_recall": 0.7, "concept_precision": 0.7, "fact_recall": 0.7}


def _classify_extras(extras, allowlist):
  """Split produced 'extra' entries into acceptable (match the golden's
  acceptable_extra_concepts allowlist) vs truly spurious. Allowlist items may be a
  string or {name, aliases:[...]}; matching is hyphen/underscore/space-insensitive."""
  import re
  def norm(s):
    return re.sub(r"[-_\s]", "",
                  str(s).replace(".overview.md", "").replace(".md", "").lower())
  pats = []
  for c in (allowlist or []):
    if isinstance(c, dict):
      names = [c.get("name", "")] + list(c.get("aliases") or [])
      label = c.get("name", "")
    else:
      label, names = c, [c]
    pats.append((label, [norm(n) for n in names if n]))
  acceptable, spurious = [], []
  for e in extras:
    ne = norm(e)
    hit = next((label for label, normed in pats
                if any(p and (p in ne or ne in p) for p in normed)), None)
    (acceptable if hit else spurious).append((e, hit))
  return acceptable, spurious


def _trajectory_source(traj: dict) -> str:
  parts = []
  for t in (traj.get("tool_responses") or []):
    r = t.get("response") if isinstance(t, dict) else t
    if isinstance(r, dict):
      texts = [str(r[k]) for k in ("content", "text", "overview", "description")
               if r.get(k)]
      parts.extend(texts or [json.dumps(r)[:50000]])
    elif isinstance(r, str):
      parts.append(r)
  return "\n\n".join(parts)


# Map each recorded tool_use (trajectory.json) to the marker phrase that
# metrics.fired_tools() recognizes, so check_trajectory (unchanged, stdout-based) can read github's structured tool calls. This lets the
# trajectory metric (must_call / must_not_call) work off trajectory.json instead
# of needing the agent's stdout.
_TRAJ_TOOL_PHRASE = {
    "fetch_gdoc": "Fetching",          # -> drive_fetch
    "read_local_md": "Fetching",       # -> drive_fetch (local markdown source)
    "get_table_entry": "bigquery-dataset",   # -> dataset_pull
    "reference_table": "bigquery-dataset",   # -> dataset_pull
    "explore_repo": "github",          # -> github_fetch
}


def _traj_markers(traj: dict) -> str:
  """Synthesize a marker string from trajectory.json tool_uses so the (unchanged)
  stdout-based check_trajectory can derive which tool categories fired."""
  names = [t.get("name") for t in (traj.get("tool_uses") or [])
           if isinstance(t, dict)]
  return " ".join(_TRAJ_TOOL_PHRASE.get(n, "") for n in names if n)


def run_golden_eval(output_dir: str, golden_path: str,
                    model: str = "gemini-2.5-pro", persona_id: str | None = None,
                    perf_budget: dict | None = None,
                    report_dir: str | None = None,
                    report_name: str | None = None) -> dict:
  """Evaluate one run against a golden file. Returns a results dict.

  `report_dir` / `report_name` let a batch caller collect the per-golden reports
  in one folder (one .md per golden); by default the report is named by the
  golden + run so several goldens scoring the same output dir don't clobber each
  other.
  """
  with open(golden_path, encoding="utf-8") as f:
    golden = json.load(f)

  traj = loaders.load_trajectory(output_dir)
  agent_type = traj.get("agent_type", "doc")
  # Pass the real mode through (doc / table / context_overlay), respecting the
  # agent's per-mode contract. context_overlay keeps its own mode so
  # check_structural skips the entry-type check (overlay entries are `generic`,
  # mixed with `.ref` bigquery types — metrics._ENTRY_TYPE has no overlay key) and
  # the table-only metrics (entry_grounding, reference grounding, per-table
  # fact_recall) don't apply to it.
  # HYBRID (doc CLI + --dataset) records agent_type="hybrid"; it is graded on BOTH
  # its KB entries AND its per-table overlays (see fact scoring below).
  mode = agent_type if agent_type in ("table", "context_overlay", "hybrid") else "doc"
  arts = loaders.load_mdcode(os.path.join(output_dir, "catalog"))
  if not arts.get("overview_md") and not arts.get("yaml"):
    return {"error": f"No generated mdcode found under {output_dir}/catalog."}

  tokens = dict(traj.get("token_usage") or {})
  tokens["total"] = (tokens.get("input", 0) or 0) + (tokens.get("output", 0) or 0)
  latency = float(traj.get("latency") or 0.0)
  # No-op judge when auth is absent → judge metrics self-skip (deterministic
  # metrics still run) instead of hanging on retries / erroring.
  judge = (metrics.default_judge(model)
           if (os.environ.get("GOOGLE_CLOUD_PROJECT")
               or os.environ.get("GOOGLE_GENAI_USE_VERTEXAI"))
           else (lambda _p: ""))
  res: list = []

  # Deterministic
  res.append(metrics.check_structural(arts, mode))
  # Folder/index naming (golden-gated): only when the golden declares
  # `expected_folders`; deterministic token-overlap of expected folder names vs
  # the emitted per-folder index displayNames (v3 folder/index hierarchy).
  if golden.get("expected_folders"):
    res.append(metrics.check_index_names(arts, golden["expected_folders"]))
  # Input-conditioned tool use (must_call / must_not_call) . github records the actual tool calls in trajectory.json, so we derive the
  # fired tools from there (no agent stdout needed). check_trajectory/metrics.py are unchanged.
  res.append(metrics.check_trajectory(_traj_markers(traj),
                                      golden.get("trajectory", {})))
  res.append(metrics.check_perf(latency, arts, perf_budget or {}, tokens))
  # Guard against invented entries not backed by a real dataset table. Applies to
  # table + context_overlay; skipped for hybrid (its standalone KB entries are
  # legitimately not tables, so entry-grounding doesn't apply to the run).
  if mode in ("table", "context_overlay"):
    res.append(metrics.check_entry_grounding(arts))
  if golden.get("expected_headings"):
    res.append(metrics.check_expected_headings(arts, golden["expected_headings"]))

  # Judge: business terms — presence + (dedicated per-term MaC) validity. business_terms_validity is typically low today (the agent
  # doesn't emit per-term files) but is included for parity so scores are comparable.
  if golden.get("business_terms"):
    res.append(metrics.check_business_terms(arts, golden["business_terms"], judge))
    res.append(metrics.check_business_terms_validity(
        arts, golden["business_terms"], judge))

  # Merge/update path: if the golden declares pre-baked context, verify it was
  # PRESERVED through enrichment only when prebaked_facts is set.
  if golden.get("prebaked_facts"):
    res.append(metrics.check_context_preservation(
        arts, golden["prebaked_facts"], judge))

  thr = _THRESHOLDS
  # Judge: concept recall/precision + fact recall. Fact scoring spans all four
  # modes, composed from two scorers so HYBRID (doc KB entries + per-table
  # overlays) is graded on BOTH (mirrors prototype scorer.py):
  #   * KB concepts (match_topics over expected_topics): doc + hybrid.
  #   * Table facts (each golden.table treated as a topic): table +
  #     context_overlay + hybrid.
  # Contributions combine (weighted by #topics / #tables) into one fact_recall;
  # for plain doc/table this reduces to the original single-scorer score.
  fact_parts = []  # (coverage, weight, detail)
  if mode in ("doc", "hybrid") and golden.get("expected_topics"):
    tm = metrics.match_topics(arts, golden["expected_topics"], judge, 0.7)
    per_topic = tm.get("per_topic", [])
    matched = [t["topic"] for t in per_topic if t.get("matched")]
    missed = [t["topic"] for t in per_topic if not t.get("matched")]
    extra = tm.get("extra_entries", [])
    res.append(metrics.MetricResult(
        "concept_recall", tm["concept_recall"],
        tm["concept_recall"] >= thr["concept_recall"],
        f"Captured {len(matched)} of {len(per_topic)} expected concepts as entries"
        + (f"; missing: {', '.join(missed)}." if missed else ".")))
    # concept_precision is meaningful for PLAIN doc only. HYBRID also emits one
    # overlay per table + folder index entries, which would be miscounted as
    # spurious KB concepts; hybrid is recall-oriented, so we skip precision.
    if mode == "doc":
      n_prod = len(tm.get("produced_entries", []))
      acc, spu = _classify_extras(extra, golden.get("acceptable_extra_concepts"))
      precision = (n_prod - len(spu)) / n_prod if n_prod else 1.0
      detail = (f"{n_prod - len(extra)} of {n_prod} produced entries map to a core "
                "expected concept")
      if spu:
        detail += "; spurious: " + ", ".join(e for e, _ in spu)
      res.append(metrics.MetricResult(
          "concept_precision", round(precision, 3),
          precision >= thr["concept_precision"], detail + "."))
    fact_parts.append(
        (tm["fact_coverage"], len(per_topic) or 1, _fact_detail(per_topic)))
  if mode in ("table", "context_overlay", "hybrid") and golden.get("tables"):
    topics = [{"canonical": t["table"], "flavor_hints": [t["table"]],
               "golden_facts": t.get("golden_facts", [])} for t in golden["tables"]]
    # scope_to_entry: a table's golden_facts are scored against THAT table's own
    # entry, not the global output -- so a cross-table fact (e.g. an inbound FK)
    # only earns credit if the agent carried it onto the referenced table. This
    # is what makes the cross-table shared-concepts feature observable in the
    # score; without it a child table stating the relationship from its side
    # wrongly satisfies the parent table's fact (see eval audit, 2026-06-18).
    tmt = metrics.match_topics(arts, topics, judge, 0.7, scope_to_entry=True)
    fact_parts.append(
        (tmt["fact_coverage"], len(topics) or 1,
         _fact_detail(tmt.get("per_topic", []))))
  if fact_parts:
    total_w = sum(w for _c, w, _d in fact_parts) or 1
    cov = sum(c * w for c, w, _d in fact_parts) / total_w
    res.append(metrics.MetricResult(
        "fact_recall", cov, cov >= thr["fact_recall"],
        " | ".join(d for _c, _w, d in fact_parts)))

  # Judge: persona alignment (optional)
  if persona_id and golden.get("personas", {}).get(persona_id):
    res.append(metrics.check_persona_alignment(
        arts, golden["personas"][persona_id], judge))

  # Judge: rubric dims (redundancy_index / disambiguation_efficacy /
  # absence_of_contradictions) — same set dynamic eval scores. Degrades gracefully without a judge.
  try:
    res.extend(metrics.score_rubric(arts, judge, golden.get("business_terms")))
  except Exception:  # pylint: disable=broad-except
    pass

  # Judge: hallucination grounded on trajectory (+ table reference)
  src = _trajectory_source(traj)
  extra_g = ""
  if mode == "table":
    refs = loaders.load_references(output_dir)
    extra_g = "\n\n".join(
        list((refs.get("yaml") or {}).values())
        + list((arts.get("reference_yaml") or {}).values())
        + list((arts.get("reference_overview_md") or {}).values())
        + list((arts.get("yaml") or {}).values()))
  res.append(metrics.check_hallucination(arts, src, judge, extra_grounding=extra_g))

  # Shared result builder (same shape + 0-100 scaling as the dynamic path).
  results = dynamic_eval.build_results(output_dir, agent_type, mode, res, traj,
                                       tokens, latency, golden=golden_path)
  # Golden reports go to a dedicated tmp folder (not next to trajectory.json).
  # Named by golden + run so several goldens scoring the same output dir (or
  # parallel runs) don't clobber each other; a batch caller can override both.
  report_dir = report_dir or os.path.join(
      tempfile.gettempdir(), "kc_golden_eval_reports")
  os.makedirs(report_dir, exist_ok=True)
  gstem = os.path.splitext(os.path.basename(golden_path))[0]
  run = os.path.basename(output_dir.rstrip("/")) or "run"
  fname = report_name or f"golden_report_{gstem}__{run}.md"
  dynamic_eval.write_report(results, report_dir, filename=fname)
  results["report_path"] = os.path.join(report_dir, fname)
  return results


def _fact_detail(per_topic: list) -> str:
  missing = [f"[{t['topic']}] {f}"
             for t in per_topic for f in (t.get("missing_facts") or [])]
  if not missing:
    return "All golden facts are conveyed by the matched entries."
  return f"Missing/partial facts: " + "; ".join(missing[:6]) + (
      f" (+{len(missing)-6} more)" if len(missing) > 6 else "")
