"""Dynamic (golden-free) evaluation of a single enrichment run.

Scores the output of one enrichment run with no golden/reference answers needed,
grounded in the agent's own captured `trajectory.json` (what it actually
retrieved). Useful for evaluating enrichment on your own data out of the box.

Metrics:
  - structural_validity : the generated mdcode is well-formed (deterministic)
  - perf                : token usage + latency against an optional budget
  - hallucination_free  : every factual claim in the overviews is supported by
                          what the agent retrieved (chunked, parallel, judge)
  - rubric dims         : redundancy_index, disambiguation_efficacy,
                          absence_of_contradictions (judge)

Scores are 0..1 (None = the metric self-skipped, e.g. hallucination with no
grounding source available). See README.md for usage.
"""

from __future__ import annotations

import json
import os
import sys
import textwrap
import time

from . import loaders
from . import metrics


def _log(msg: str) -> None:
  """Progress line to stderr (keeps stdout/--json clean)."""
  print(f"[eval] {msg}", file=sys.stderr, flush=True)


def _wrap_para(text: str, width: int = 88) -> str:
  """Wrap a rationale/insight into width-bounded lines so the report stays
  readable in editors that don't soft-wrap long lines (e.g. nano)."""
  body = " ".join((text or "").split())
  return textwrap.fill(body, width=width) if body else "(none)"


def fmt_score(score) -> str:
  """Render a metric score (stored 0..1) on the 0-100 scale shown to users.

  Scores are kept normalized (0..1) internally — thresholds, gating and the JSON
  output — and only scaled to 0-100 for display in the scorecard, report, and
  progress logs. None -> "n/a".
  """
  return "n/a" if score is None else f"{float(score) * 100:.1f}"


def build_results(output_dir, agent_type, mode, metric_results, traj, tokens,
                  latency, **extra):
  """Shared result-dict builder for both the dynamic and golden eval paths.

  Normalizes a list of MetricResult into the on-disk/JSON shape (scores kept
  0..1; fmt_score scales to 0-100 for display) + the average + telemetry. `extra`
  merges extra top-level keys (e.g. golden=<path> for the golden path).
  """
  label = getattr(metrics, "_METRIC_LABEL", {})
  out_metrics, numeric = [], []
  for r in metric_results:
    sc = None if r.score is None else round(float(r.score), 4)
    if sc is not None:
      numeric.append(sc)
    out_metrics.append({
        "name": r.name,
        "score": sc,
        # `passed` is needed by the cross-run roll-up (runs_passed = k/n); kept on
        # every per-run metric so aggregate.py can mirror the reference design.
        "passed": bool(getattr(r, "passed", True)),
        "description": label.get(r.name, r.name),
        "rationale": r.detail,
        "insights": getattr(r, "insights", "") or "",
    })
  return {
      "output_dir": output_dir,
      "agent_type": agent_type,
      "mode": mode,
      "metrics": out_metrics,
      "average_score": round(sum(numeric) / len(numeric), 4) if numeric else None,
      "telemetry": {
          "tokens_in": tokens.get("input", 0),
          "tokens_out": tokens.get("output", 0),
          "tokens_total": tokens.get("total", 0),
          "num_tool_calls": len(traj.get("tool_uses") or []),
          "latency_s": latency or None,
      },
      **extra,
  }


def write_report(results: dict, output_dir: str,
                 filename: str = "eval_report.md") -> str:
  """Write a full, untruncated eval report (Markdown) next to trajectory.json.

  The terminal scorecard truncates rationales to stay readable; this file keeps
  the full rationale + insights for every metric. Returns the path written ("" on
  failure). Reused by both the dynamic and golden evaluators.
  """
  t = results.get("telemetry", {})
  avg = results.get("average_score")
  lines = ["# Enrichment eval report", ""]
  lines.append(f"- output: `{results.get('output_dir')}`")
  if results.get("golden"):
    lines.append(f"- golden: `{results.get('golden')}`")
  lines.append(f"- mode: {results.get('mode')} "
               f"(agent_type={results.get('agent_type')})")
  lines.append(f"- generated: {time.strftime('%Y-%m-%d %H:%M:%S')}")
  lines.append(f"- average score: {fmt_score(avg)}/100")
  lat = t.get("latency_s")
  lines.append(f"- telemetry: {t.get('tokens_total', 0):,} tokens "
               f"(in {t.get('tokens_in', 0):,} / out {t.get('tokens_out', 0):,}) · "
               f"{t.get('num_tool_calls', 0)} tool calls · "
               f"latency {('n/a' if not lat else f'{lat:.1f}s')}")
  lines.append("")
  for m in results.get("metrics", []):
    sc = m.get("score")
    lines.append(f"## {m['name']} — {fmt_score(sc)}/100")
    if m.get("description"):
      lines.append(f"_{m['description']}_")
    # Per-run signal (mean across runs): runs k/n + each run's score. Consistency
    # metrics hold entry COUNTS (not 0..1) and explain them in their rationale.
    rs = m.get("run_scores")
    if rs and not m["name"].endswith("_consistency"):
      rp = m.get("runs_passed")
      lines.append("")
      lines.append(f"- per run: {', '.join(fmt_score(s) for s in rs)}"
                   + (f"  ·  passed {rp}" if rp else ""))
    lines.append("")
    lines.append("**Rationale:**")
    lines.append("")
    lines.append(_wrap_para(m.get("rationale")))
    if m.get("insights"):
      lines.append("")
      lines.append("**Insights:**")
      lines.append("")
      lines.append(_wrap_para(m.get("insights")))
    lines.append("")

  # Per-run breakdown (multi-run cases): each run's metrics + rationale, so a
  # reader can drill into what earned each score.
  per_run = results.get("per_run")
  if per_run and len(per_run) > 1:
    lines.append("---")
    lines.append("")
    lines.append("# Per-run breakdown")
    lines.append("")
    for run in per_run:
      avg = run.get("average_score")
      lines.append(f"## Run {run.get('index')} — average {fmt_score(avg)}/100")
      lines.append("")
      for m in run.get("metrics", []):
        lines.append(f"- **{m['name']}** — {fmt_score(m.get('score'))}/100"
                     + ("" if m.get("passed", True) else " (below gate)"))
        rat = " ".join((m.get("rationale") or "").split())
        if rat:
          lines.append(f"  - {rat}")
      lines.append("")
  path = os.path.join(output_dir, filename)
  try:
    with open(path, "w", encoding="utf-8") as f:
      f.write("\n".join(lines) + "\n")
    _log(f"full report → {path}")
    return path
  except OSError as e:
    _log(f"could not write report: {e}")
    return ""


def run_dynamic_eval(output_dir: str, model: str = "gemini-2.5-pro",
                     perf_budget: dict | None = None) -> dict:
  """Evaluate one enrichment run directory. Returns a results dict.

  Args:
    output_dir: the agent's output dir (contains `catalog/` and `trajectory.json`).
    model: judge model — any Vertex AI model id you have access to
      (default gemini-2.5-pro).
    perf_budget: optional {"max_latency_s":..., "max_total_tokens":...}.
  """
  traj = loaders.load_trajectory(output_dir)
  agent_type = traj.get("agent_type", "doc")
  # Pass the real mode through (doc / table / context_overlay / hybrid),
  # respecting the agent's per-mode contract. context_overlay AND hybrid keep
  # their own mode so check_structural applies the right (lenient) entry-type
  # handling for overlay `generic` + `.ref` bigquery entries. HYBRID (doc CLI +
  # --dataset) records agent_type="hybrid".
  mode = agent_type if agent_type in ("table", "context_overlay", "hybrid") else "doc"

  _log(f"scoring {output_dir}  (mode={mode})")
  arts = loaders.load_mdcode(os.path.join(output_dir, "catalog"))
  if not arts.get("overview_md") and not arts.get("yaml"):
    return {"error": f"No generated mdcode found under {output_dir}/catalog."}
  _log(f"loaded {len(arts.get('overview_md', {}))} overview(s), "
       f"{len(arts.get('yaml', {}))} entry yaml(s)")

  # Ground hallucination against what the agent actually retrieved at runtime.
  src_parts = []
  for t in (traj.get("tool_responses") or []):
    r = t.get("response") if isinstance(t, dict) else t
    if isinstance(r, dict):
      texts = [str(r[k]) for k in ("content", "text", "overview", "description")
               if r.get(k)]
      src_parts.extend(texts or [json.dumps(r)[:50000]])
    elif isinstance(r, str):
      src_parts.append(r)
  source_context = "\n\n".join(src_parts)

  tokens = dict(traj.get("token_usage") or {})
  tokens["total"] = (tokens.get("input", 0) or 0) + (tokens.get("output", 0) or 0)
  latency = float(traj.get("latency") or 0.0)

  # Only build a real judge when auth is present; otherwise pass a no-op so the
  # judge-based metrics self-skip (deterministic metrics still run) instead of
  # hanging on retries / erroring with no credentials.
  has_auth = bool(os.environ.get("GOOGLE_CLOUD_PROJECT")
                  or os.environ.get("GOOGLE_GENAI_USE_VERTEXAI"))
  # Only build a real judge when auth is present; otherwise a no-op so judge-based
  # metrics self-skip (deterministic metrics still run) instead of hanging/erroring.
  judge = metrics.default_judge(model) if has_auth else (lambda _p: "")
  _log(f"judge: {model + ' (on)' if has_auth else 'OFF — no auth, judge metrics will be n/a'}")

  mres = []
  _log("· structural_validity (deterministic) …")
  mres.append(metrics.check_structural(arts, mode))
  _log(f"  = {fmt_score(mres[-1].score)}")
  _log("· perf (deterministic) …")
  mres.append(metrics.check_perf(latency, arts, perf_budget or {}, tokens))
  _log(f"  = {fmt_score(mres[-1].score)}")

  # Table mode: also ground against the pulled 1P schema / reference + produced yaml.
  extra = ""
  if mode == "table":
    refs = loaders.load_references(output_dir)
    extra = "\n\n".join(
        list((refs.get("yaml") or {}).values())
        + list((refs.get("overview_md") or {}).values())
        + list((arts.get("reference_yaml") or {}).values())
        + list((arts.get("reference_overview_md") or {}).values())
        + list((arts.get("yaml") or {}).values()))
  _log("· hallucination_free (judge: extract claims → verify across chunks) …")
  _t = time.time()
  try:
    mres.append(metrics.check_hallucination(arts, source_context, judge,
                                            extra_grounding=extra))
    _log(f"  = {fmt_score(mres[-1].score)}  ({time.time() - _t:.0f}s)")
  except Exception as e:  # pylint: disable=broad-except
    # e.g. Vertex auth/ADC missing despite GOOGLE_CLOUD_PROJECT being set. Degrade
    # to n/a (excluded from the gate) instead of crashing the whole eval.
    _log(f"  (hallucination skipped: {str(e)[:120]})")
    mres.append(metrics.MetricResult(
        "hallucination_free", None, True,
        "groundedness not scored — judge unavailable (check Vertex AI auth: "
        "GOOGLE_CLOUD_PROJECT + `gcloud auth application-default login`)"))
  _log("· rubric: redundancy / disambiguation / contradictions (judge) …")
  _t = time.time()
  try:
    rub = metrics.score_rubric(arts, judge, None)
    mres.extend(rub)
    for r in rub:
      _log(f"    {r.name} = {fmt_score(r.score)}")
    _log(f"  (rubric done in {time.time() - _t:.0f}s)")
  except Exception:  # pylint: disable=broad-except
    _log("  (rubric skipped)")
  _log("done — scorecard below")

  results = build_results(output_dir, agent_type, mode, mres, traj, tokens, latency)
  write_report(results, output_dir)
  return results
