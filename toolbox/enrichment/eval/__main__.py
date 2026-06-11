"""CLI for dynamic (golden-free) enrichment evaluation.

Run from `toolbox/enrichment/`:

    python -m eval --output-dir /path/to/enrichment/output
    python -m eval --output-dir /path/to/output --model gemini-2.5-flash --json

The output dir is what the enrichment agent wrote (contains `catalog/` and
`trajectory.json`). Judge auth: Vertex AI — set GOOGLE_CLOUD_PROJECT and
Application Default Credentials (`gcloud auth application-default login`),
the same auth the enrichment agent uses.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .dynamic_eval import run_dynamic_eval


def _has_judge_auth() -> bool:
  return bool(os.environ.get("GOOGLE_CLOUD_PROJECT")
              or os.environ.get("GOOGLE_GENAI_USE_VERTEXAI"))


def _fmt(results: dict) -> str:
  lines = []
  lines.append("")
  lines.append(f"Dynamic eval — {results.get('output_dir')}")
  lines.append(f"  mode: {results.get('mode')}  (agent_type={results.get('agent_type')})")
  lines.append("")
  lines.append(f"  {'metric':24} {'score':>7}   rationale")
  lines.append(f"  {'-'*24} {'-'*7}   {'-'*40}")
  for m in results.get("metrics", []):
    sc = m["score"]
    sc_s = " n/a" if sc is None else f"{sc:5.3f}"
    rat = (m.get("rationale") or "").replace("\n", " ")
    if len(rat) > 90:
      rat = rat[:90] + "…"
    lines.append(f"  {m['name']:24} {sc_s:>7}   {rat}")
  avg = results.get("average_score")
  lines.append(f"  {'-'*24} {'-'*7}")
  lines.append(f"  {'AVERAGE':24} {('n/a' if avg is None else f'{avg:5.3f}'):>7}")
  t = results.get("telemetry", {})
  lat = t.get("latency_s")
  lines.append("")
  lines.append(f"  tokens: {t.get('tokens_total',0):,} "
               f"(in {t.get('tokens_in',0):,} / out {t.get('tokens_out',0):,})  ·  "
               f"tool calls: {t.get('num_tool_calls',0)}  ·  "
               f"latency: {('—' if not lat else f'{lat:.1f}s')}")
  lines.append("")
  return "\n".join(lines)


def main(argv=None) -> int:
  ap = argparse.ArgumentParser(
      prog="python -m eval",
      description="Dynamic (golden-free) evaluation of an enrichment run.")
  ap.add_argument("--output-dir", required=True,
                  help="Enrichment output dir (contains catalog/ and trajectory.json).")
  ap.add_argument("--model", default="gemini-2.5-pro",
                  help="Judge model id (default: gemini-2.5-pro).")
  ap.add_argument("--max-latency-s", type=float, default=None,
                  help="Optional perf budget: max acceptable latency in seconds.")
  ap.add_argument("--max-total-tokens", type=int, default=None,
                  help="Optional perf budget: max acceptable total tokens.")
  ap.add_argument("--json", action="store_true",
                  help="Emit raw JSON instead of a formatted scorecard.")
  args = ap.parse_args(argv)

  if not os.path.isdir(args.output_dir):
    print(f"error: not a directory: {args.output_dir}", file=sys.stderr)
    return 2
  if not _has_judge_auth():
    print("warning: GOOGLE_CLOUD_PROJECT not set — judge-based metrics "
          "(hallucination_free, rubric) need Vertex AI auth (set GOOGLE_CLOUD_PROJECT "
          "+ run `gcloud auth application-default login`). Deterministic metrics still run.",
          file=sys.stderr)

  budget = {}
  if args.max_latency_s is not None:
    budget["max_latency_s"] = args.max_latency_s
  if args.max_total_tokens is not None:
    budget["max_total_tokens"] = args.max_total_tokens

  results = run_dynamic_eval(args.output_dir, model=args.model,
                             perf_budget=budget or None)
  if "error" in results:
    print(f"error: {results['error']}", file=sys.stderr)
    return 1
  print(json.dumps(results, indent=2) if args.json else _fmt(results))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
