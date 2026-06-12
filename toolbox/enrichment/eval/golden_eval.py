"""Golden-based evaluation of an enrichment run.

Where the dynamic (golden-free) evaluator grounds only in what the agent
retrieved, this scores the output against a hand-authored / harvested GOLDEN that
declares the concepts, facts, sections, and terms the enrichment SHOULD contain.
See goldens/GOLDENS.md for the golden schema and how to build one.

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
  mode = "table" if agent_type == "table" else "doc"
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
  res.append(metrics.check_perf(latency, arts, perf_budget or {}, tokens))
  if mode == "table":
    res.append(metrics.check_entry_grounding(arts))
  if golden.get("expected_headings"):
    res.append(metrics.check_expected_headings(arts, golden["expected_headings"]))

  # Judge: business terms
  if golden.get("business_terms"):
    res.append(metrics.check_business_terms(arts, golden["business_terms"], judge))

  thr = _THRESHOLDS
  # Judge: concept recall/precision + fact recall
  if mode == "doc" and golden.get("expected_topics"):
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
    res.append(metrics.MetricResult(
        "fact_recall", tm["fact_coverage"],
        tm["fact_coverage"] >= thr["fact_recall"], _fact_detail(per_topic)))
  elif mode == "table" and golden.get("tables"):
    topics = [{"canonical": t["table"], "flavor_hints": [t["table"]],
               "golden_facts": t.get("golden_facts", [])} for t in golden["tables"]]
    tm = metrics.match_topics(arts, topics, judge, 0.7)
    res.append(metrics.MetricResult(
        "fact_recall", tm["fact_coverage"],
        tm["fact_coverage"] >= thr["fact_recall"],
        _fact_detail(tm.get("per_topic", []))))

  # Judge: persona alignment (optional)
  if persona_id and golden.get("personas", {}).get(persona_id):
    res.append(metrics.check_persona_alignment(
        arts, golden["personas"][persona_id], judge))

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

  label = getattr(metrics, "_METRIC_LABEL", {})
  out_metrics, numeric = [], []
  for r in res:
    sc = None if r.score is None else round(float(r.score), 4)
    if sc is not None:
      numeric.append(sc)
    out_metrics.append({"name": r.name, "score": sc,
                        "description": label.get(r.name, r.name),
                        "rationale": r.detail,
                        "insights": getattr(r, "insights", "") or ""})
  results = {
      "output_dir": output_dir, "golden": golden_path,
      "agent_type": agent_type, "mode": mode,
      "metrics": out_metrics,
      "average_score": round(sum(numeric) / len(numeric), 4) if numeric else None,
      "telemetry": {
          "tokens_in": tokens.get("input", 0), "tokens_out": tokens.get("output", 0),
          "tokens_total": tokens.get("total", 0),
          "num_tool_calls": len(traj.get("tool_uses") or []),
          "latency_s": latency or None,
      },
  }
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
