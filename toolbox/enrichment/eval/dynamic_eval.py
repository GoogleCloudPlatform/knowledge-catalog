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

from . import loaders
from . import metrics


def run_dynamic_eval(output_dir: str, model: str = "gemini-2.5-pro",
                     perf_budget: dict | None = None) -> dict:
  """Evaluate one enrichment run directory. Returns a results dict.

  Args:
    output_dir: the agent's output dir (contains `catalog/` and `trajectory.json`).
    model: judge model (any Gemini model id available to your auth).
    perf_budget: optional {"max_latency_s":..., "max_total_tokens":...}.
  """
  traj = loaders.load_trajectory(output_dir)
  agent_type = traj.get("agent_type", "doc")
  mode = "table" if agent_type == "table" else "doc"

  arts = loaders.load_mdcode(os.path.join(output_dir, "catalog"))
  if not arts.get("overview_md") and not arts.get("yaml"):
    return {"error": f"No generated mdcode found under {output_dir}/catalog."}

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

  judge = metrics.default_judge(model)
  mres = [
      metrics.check_structural(arts, mode),
      metrics.check_perf(latency, arts, perf_budget or {}, tokens),
  ]
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
  mres.append(metrics.check_hallucination(arts, source_context, judge,
                                          extra_grounding=extra))
  try:
    mres.extend(metrics.score_rubric(arts, judge, None))
  except Exception:  # pylint: disable=broad-except
    pass

  label = getattr(metrics, "_METRIC_LABEL", {})
  out_metrics, numeric = [], []
  for r in mres:
    sc = None if r.score is None else round(float(r.score), 4)
    if sc is not None:
      numeric.append(sc)
    out_metrics.append({
        "name": r.name,
        "score": sc,
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
  }
