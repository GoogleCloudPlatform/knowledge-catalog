"""CLI for enrichment evaluation (dynamic golden-free + golden-based).

Run from `toolbox/enrichment/`:

    # Dynamic (golden-free) — grounds in the agent's own trajectory.json:
    python -m eval --output-dir /path/to/output

    # Golden-based — score against an answer key (concepts, facts, coverage):
    python -m eval --output-dir /path/to/output --golden eval/goldens/example_ga_events.json

The output dir is what the enrichment agent wrote (contains `catalog/` and
`trajectory.json`). Judge auth: Vertex AI — set GOOGLE_CLOUD_PROJECT and
Application Default Credentials (`gcloud auth application-default login`), the
same auth the enrichment agent uses. Dynamic runs write a full `eval_report.md`
into the output dir; golden runs write `golden_report_<run>.md` into a tmp folder
(both with untruncated rationales).
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .dynamic_eval import run_dynamic_eval
from .golden_eval import run_golden_eval


def _has_judge_auth() -> bool:
  return bool(os.environ.get("GOOGLE_CLOUD_PROJECT")
              or os.environ.get("GOOGLE_GENAI_USE_VERTEXAI"))


def _fmt(results: dict) -> str:
  metrics = results.get("metrics", [])
  golden = results.get("golden")
  # Width the metric column to the longest name (e.g. absence_of_contradictions)
  # so every score stays aligned.
  w = max([len(m["name"]) for m in metrics] + [len("metric"), len("AVERAGE")])
  title = "Golden eval" if golden else "Dynamic eval"
  lines = ["", f"{title} — {results.get('output_dir')}"]
  if golden:
    lines.append(f"  golden: {golden}")
  lines.append(f"  mode: {results.get('mode')}  (agent_type={results.get('agent_type')})")
  lines += ["",
            f"  {'metric':{w}} {'score':>7}   rationale",
            f"  {'-'*w} {'-'*7}   {'-'*40}"]
  for m in metrics:
    sc = m["score"]
    sc_s = " n/a" if sc is None else f"{sc:5.3f}"
    rat = (m.get("rationale") or "").replace("\n", " ")
    if len(rat) > 90:
      rat = rat[:90] + "…"
    lines.append(f"  {m['name']:{w}} {sc_s:>7}   {rat}")
  avg = results.get("average_score")
  lines.append(f"  {'-'*w} {'-'*7}")
  lines.append(f"  {'AVERAGE':{w}} {('n/a' if avg is None else f'{avg:5.3f}'):>7}")
  t = results.get("telemetry", {})
  lat = t.get("latency_s")
  lines.append("")
  lines.append(f"  tokens: {t.get('tokens_total', 0):,} "
               f"(in {t.get('tokens_in', 0):,} / out {t.get('tokens_out', 0):,})  ·  "
               f"tool calls: {t.get('num_tool_calls', 0)}  ·  "
               f"latency: {('—' if not lat else f'{lat:.1f}s')}")
  lines.append("")
  if golden:
    # Golden reports go to a tmp folder (path is logged on stderr by the eval).
    lines.append("  full report: see [eval] log above (written under "
                 "$TMPDIR/kc_golden_eval_reports/)")
  else:
    lines.append(f"  full report: {os.path.join(results.get('output_dir', ''), 'eval_report.md')}")
  lines.append("")
  return "\n".join(lines)


def main(argv=None) -> int:
  ap = argparse.ArgumentParser(
      prog="python -m eval",
      description="Evaluate an enrichment run (dynamic golden-free, or golden-based).")
  ap.add_argument("--output-dir", required=True,
                  help="Enrichment output dir (contains catalog/ and trajectory.json).")
  ap.add_argument("--golden", default=None,
                  help="Golden file → golden-based eval (concept_recall/precision, "
                       "fact_recall, coverage). Omit for dynamic (golden-free) eval.")
  ap.add_argument("--persona", default=None,
                  help="Persona id from the golden's `personas` (golden mode only).")
  ap.add_argument("--model", default="gemini-2.5-pro",
                  help="Judge model: any Vertex AI model id you have access to "
                       "(default: gemini-2.5-pro).")
  ap.add_argument("--json", action="store_true",
                  help="Emit raw JSON instead of a formatted scorecard.")
  args = ap.parse_args(argv)

  if not os.path.isdir(args.output_dir):
    print(f"error: not a directory: {args.output_dir}", file=sys.stderr)
    return 2
  if args.golden and not os.path.isfile(args.golden):
    print(f"error: golden not found: {args.golden}", file=sys.stderr)
    return 2
  if args.persona and not args.golden:
    print("error: --persona requires --golden (personas live in the golden file).",
          file=sys.stderr)
    return 2
  if not _has_judge_auth():
    print("warning: GOOGLE_CLOUD_PROJECT not set — judge-based metrics "
          "(hallucination_free, rubric, concept/fact recall) need Vertex AI auth "
          "(set GOOGLE_CLOUD_PROJECT + run `gcloud auth application-default login`). "
          "Deterministic metrics still run.", file=sys.stderr)

  if args.golden:
    results = run_golden_eval(args.output_dir, args.golden,
                              model=args.model, persona_id=args.persona)
  else:
    results = run_dynamic_eval(args.output_dir, model=args.model)
  if "error" in results:
    print(f"error: {results['error']}", file=sys.stderr)
    return 1
  print(json.dumps(results, indent=2) if args.json else _fmt(results))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
