"""Cross-run aggregation for `--runs > 1`.

Rolls N per-run results into one case result:

  - each aggregated metric carries the mean `score`, a representative *real*
    `rationale` (preferring a failing run's — NOT the string "mean of N runs"),
    `run_scores` (per-run), and `runs_passed` ("k/n");
  - the case also keeps `per_run` (the per-run drill-down: each run's metrics +
    rationale); and
  - two informational cross-run STABILITY metrics — `concept_consistency`
    (does the agent produce the same SET of concepts each run) and
    `content_consistency` (do recurring concepts state the same FACTS) — which
    are **n/a (None) unless there are ≥2 runs**. They never gate the case and are
    excluded from the average.
"""

from __future__ import annotations

import itertools
import os
import re

from . import loaders
from . import metrics


def _run_overviews(run_results: list[dict]) -> list[dict]:
  """One {concept_name: overview_text} map per *independent* run, loaded from each
  run's generated mdcode. Concept name = the entry's basename sans `.overview.md`.

  Runs that point at the SAME output dir are deduped: consistency measures
  agent run-to-run variability, so re-scoring one output N times (dynamic
  `--runs` on a single dir) is a single independent run, not N — otherwise it
  would trivially report 100% "consistency" comparing identical output to itself.
  """
  entries, seen = [], set()
  for r in run_results:
    od = r.get("output_dir")
    if not od or od in seen:
      continue
    seen.add(od)
    arts = loaders.load_mdcode(os.path.join(od, "catalog"))
    files = arts.get("overview_md") or {}
    if files:
      entries.append({os.path.basename(k).replace(".overview.md", ""): v
                      for k, v in files.items()})
  return entries


def metric_rollup(run_results: list[dict]) -> list[dict]:
  """Per-metric roll-up across a case's runs:
  mean score, a representative rationale (prefer a failing run's), run_scores,
  and runs_passed."""
  agg: dict[str, dict] = {}
  order: list[str] = []
  for r in run_results:
    for m in r.get("metrics", []):
      name = m["name"]
      if name not in agg:
        agg[name] = {"name": name, "scores": [], "npass": 0, "n": 0,
                     "rationale": "", "insights": "",
                     "description": m.get("description", name)}
        order.append(name)
      e = agg[name]
      sc = m.get("score")
      if sc is not None:  # skip judge-errored (unscored) runs
        e["scores"].append(round(float(sc), 4))
      e["n"] += 1
      passed = m.get("passed", True)
      if passed:
        e["npass"] += 1
      d = (m.get("rationale") or "").strip()
      if d and (not e["rationale"] or not passed):
        e["rationale"] = d
      ins = (m.get("insights") or "").strip()
      if ins and (not e["insights"] or not passed):
        e["insights"] = ins
  out = []
  for name in order:
    e = agg[name]
    scores = e["scores"]
    out.append({"name": name,
                "score": round(sum(scores) / len(scores), 4) if scores else None,
                "description": e["description"],
                # Representative detail (a failing run's when any failed). When a
                # judge is available this is rewritten into a uniform, run-aware
                # rationale by explain_metrics in aggregate_runs (see below) —
                # no judge → this fallback stays.
                "rationale": e["rationale"],
                "insights": e["insights"],
                "run_scores": scores,
                "runs_passed": f"{e['npass']}/{e['n']}"})
  return out


def consistency_metrics(run_results: list[dict], judge) -> list[dict]:
  """Two cross-run STABILITY metrics,
  matched SEMANTICALLY via the judge (string/word fallback with no judge):

    - concept_consistency: does the agent produce the same SET of concepts every
      run (each concept scores the fraction of runs it appears in, so producing
      more/fewer concepts between runs lowers it);
    - content_consistency: for concepts that recur, are the FACTS consistent.

  Informational — never gates. **n/a (None) when <2 runs** (surfaced with a note,
  matching the reference design, since consistency is undefined for a single run)."""
  run_entries = _run_overviews(run_results)
  n_runs = len(run_entries)
  counts = [len(e) for e in run_entries]
  if n_runs < 2:
    def _sk(name, desc):
      return {"name": name, "score": None, "passed": True, "description": desc,
              "rationale": "Need ≥2 independent runs (distinct agent outputs) to "
                           "measure cross-run consistency. Use the golden "
                           "case-runner `--run --runs N`, which generates N fresh "
                           "runs; dynamic `--runs` on one output dir re-scores the "
                           "same output and isn't independent.",
              "insights": "Generate the output 2-3× (different runs) to assess "
                          "stability.",
              "run_scores": counts, "runs_passed": ""}
    return [_sk("concept_consistency",
                "Cross-run stability of WHICH concepts are produced"),
            _sk("content_consistency",
                "Cross-run stability of the FACTS stated")]

  concepts = metrics.consistency_judge(run_entries, judge) if judge else None
  if concepts:  # semantic alignment from the judge
    fracs = [len(c.get("runs", [])) / n_runs for c in concepts if c.get("runs")]
    concept_score = round(sum(fracs) / len(fracs), 3) if fracs else None
    cvals = [float(c["content_consistency"]) for c in concepts
             if len(c.get("runs", [])) >= 2
             and isinstance(c.get("content_consistency"), (int, float))]
    content_score = round(sum(cvals) / len(cvals), 3) if cvals else None
    unstable = [c.get("name") for c in concepts if len(c.get("runs", [])) < n_runs]
    diverging = [c.get("name") for c in concepts if len(c.get("runs", [])) >= 2
                 and isinstance(c.get("content_consistency"), (int, float))
                 and float(c["content_consistency"]) < 0.6]
    n_concepts = len(concepts)
    match_note = "semantic match"
  else:  # deterministic fallback (no judge): string/word overlap
    norm = lambda k: re.sub(r"[-_.\s]", "", k.lower())
    words = lambda t: set(re.findall(r"[a-z0-9]{4,}", (t or "").lower()))
    by_concept: dict[str, dict] = {}
    for i, e in enumerate(run_entries):
      for name, txt in e.items():
        c = by_concept.setdefault(norm(name),
                                  {"name": name, "runs": set(), "texts": []})
        c["runs"].add(i)
        c["texts"].append(words(txt))
    n_concepts = len(by_concept)
    fracs = [len(c["runs"]) / n_runs for c in by_concept.values()]
    concept_score = round(sum(fracs) / len(fracs), 3) if fracs else None
    cvals, diverging = [], []
    for c in by_concept.values():
      ws = [w for w in c["texts"] if w]
      if len(ws) < 2:
        continue
      sims = [len(a & b) / len(a | b) if (a | b) else 1.0
              for a, b in itertools.combinations(ws, 2)]
      ov = sum(sims) / len(sims)
      cvals.append(ov)
      if ov < 0.5:
        diverging.append(c["name"])
    content_score = round(sum(cvals) / len(cvals), 3) if cvals else None
    unstable = [c["name"] for c in by_concept.values() if len(c["runs"]) < n_runs]
    match_note = "name/word match (enable judge for semantic match)"

  concept_detail = (
      f"Across {n_runs} runs the agent produced {min(counts)}–{max(counts)} "
      f"entries covering {n_concepts} distinct concepts ({match_note}); on average "
      f"each concept appears in {round((concept_score or 0) * 100)}% of runs. "
      + ("Every concept appears in all runs." if not unstable
         else f"Concepts NOT in every run (more/fewer between runs): "
              f"{', '.join(filter(None, unstable))[:220]}."))
  content_detail = (
      f"For concepts present in ≥2 runs, their facts are "
      f"{round((content_score or 0) * 100)}% consistent across runs ({match_note})."
      + (f" Diverging facts in: {', '.join(filter(None, diverging))[:220]}."
         if diverging else "")
      ) if content_score is not None else (
          "No concept recurred across runs to compare content.")
  return [
      {"name": "concept_consistency", "score": concept_score,
       "passed": (concept_score or 0) >= 0.7,
       "description": "Cross-run stability of WHICH concepts are produced",
       "rationale": concept_detail,
       "insights": ("" if (concept_score or 0) >= 0.85 else
                    "Stabilize which concepts become entries (consistent "
                    "splitting/merging) so the same set is produced each run."),
       "run_scores": counts, "runs_passed": ""},
      {"name": "content_consistency", "score": content_score,
       "passed": (content_score if content_score is not None else 1) >= 0.7,
       "description": "Cross-run stability of the FACTS stated",
       "rationale": content_detail,
       "insights": ("" if (content_score or 1) >= 0.85 else
                    "Reduce fact drift: make recurring entries state the same "
                    "facts each run."),
       "run_scores": [], "runs_passed": ""},
  ]


def runs_detail(run_results: list[dict]) -> list[dict]:
  """Per-run drill-down: each run's metrics +
  rationale + its average + telemetry, so a human can read what earned each
  score."""
  out = []
  for i, r in enumerate(run_results):
    mets = [{"name": m["name"],
             "score": (round(m["score"], 3)
                       if isinstance(m.get("score"), (int, float)) else None),
             "passed": m.get("passed"),
             "rationale": m.get("rationale", ""),
             "insights": m.get("insights", "")}
            for m in r.get("metrics", [])]
    out.append({"index": i + 1,
                "average_score": r.get("average_score"),
                "output_dir": r.get("output_dir"),
                "telemetry": r.get("telemetry", {}),
                "metrics": mets})
  return out


def _mean(vals):
  vals = [v for v in vals if isinstance(v, (int, float))]
  return sum(vals) / len(vals) if vals else None


def aggregate_runs(run_results: list[dict], mode: str | None = None,
                   model: str = "gemini-2.5-pro") -> dict:
  """Aggregate N per-run result dicts (from run_golden_eval/run_dynamic_eval) into
  one case result: per-metric mean +
  representative rationale + run_scores/runs_passed, per-run drill-down, the two
  consistency metrics, mean telemetry, and per-run averages."""
  n = len(run_results)
  base = dict(run_results[0])
  has_auth = bool(os.environ.get("GOOGLE_CLOUD_PROJECT")
                  or os.environ.get("GOOGLE_GENAI_USE_VERTEXAI"))
  judge = metrics.default_judge(model) if has_auth else None

  rollup = metric_rollup(run_results)
  # Rewrite the per-metric rationale/insights into one uniform, run-aware voice
  # via a single batched judge call. The
  # explainer reasons over the evidence + per-run scores and names the specific
  # lower run(s) itself, so we DON'T tag a single representative run. Falls back to
  # the deterministic representative detail when there's no judge or the call
  # fails. explain_metrics reads evidence from `detail`, so pass rationale as that.
  if judge is not None:
    try:
      expl = metrics.explain_metrics(
          [{**m, "detail": m.get("rationale", "")} for m in rollup],
          mode or "", judge)
    except Exception:  # pylint: disable=broad-except
      expl = {}
    for m in rollup:
      e = expl.get(m["name"])
      if e:
        if e.get("rationale"):
          m["rationale"] = e["rationale"]
        if e.get("insights"):
          m["insights"] = e["insights"]
  # Only surface the cross-run consistency metrics when there are ≥2 INDEPENDENT
  # runs (distinct output dirs). Dynamic `--runs` re-scores one output dir, so it
  # has a single distinct output and consistency is undefined — omit the rows
  # entirely there rather than show permanent n/a. Real independent runs come from
  # the golden case-runner (`--run --runs N`).
  distinct_outputs = len({r.get("output_dir") for r in run_results
                          if r.get("output_dir")})
  if distinct_outputs >= 2:
    try:
      rollup += consistency_metrics(run_results, judge)
    except Exception:  # pylint: disable=broad-except
      pass  # consistency is informational — never let it break the case score.

  run_avgs = [r.get("average_score") for r in run_results
              if isinstance(r.get("average_score"), (int, float))]
  tel = lambda k: [(r.get("telemetry") or {}).get(k) for r in run_results]
  lat = _mean(tel("latency_s"))
  base["metrics"] = rollup
  # Average excludes consistency (informational) — it's the mean of per-run means.
  base["average_score"] = round(sum(run_avgs) / len(run_avgs), 4) if run_avgs else None
  base["per_run_averages"] = run_avgs
  base["runs"] = n
  base["per_run"] = runs_detail(run_results)
  base["telemetry"] = {
      "tokens_in": round(_mean(tel("tokens_in")) or 0),
      "tokens_out": round(_mean(tel("tokens_out")) or 0),
      "tokens_total": round(_mean(tel("tokens_total")) or 0),
      "num_tool_calls": round(_mean(tel("num_tool_calls")) or 0),
      "latency_s": round(lat, 1) if lat is not None else None,
  }
  return base
