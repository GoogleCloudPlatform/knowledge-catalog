"""CLI for enrichment evaluation (dynamic golden-free + golden-based).

Two ways to use it, run from `toolbox/enrichment/`:

  SCORE an output the agent already produced
    python -m eval --output-dir /path/to/output                       # dynamic (golden-free)
    python -m eval --output-dir /path/to/output --golden eval/goldens/supply_chain.json

  RUN golden cases on the agent, then score (like the internal Evaluation tab,
  single agent — the golden's `run` block carries the agent inputs + setup):
    python -m eval --run --goldens eval/goldens/thelook_ecommerce.json \
        --project my-gcp-project --runs 3

`--run` generates the Metadata-as-Code itself (you don't pre-run the agent),
repeats each case `--runs` times, scores every run, and reports run-level +
averaged metrics into a timestamped run folder. Agent processes are capped at
`--concurrency` (default 2, env KC_EVAL_MAX_CONCURRENCY) on top of the agent's own
per-mode LLM concurrency limits.

Judge auth: Vertex AI — set GOOGLE_CLOUD_PROJECT (or pass --project, which sets it)
and ADC (`gcloud auth application-default login`).
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import os
import sys
import tempfile
import uuid
from collections import defaultdict

from . import runner
from .dynamic_eval import run_dynamic_eval, fmt_score
from .golden_eval import run_golden_eval


def _has_judge_auth() -> bool:
  return bool(os.environ.get("GOOGLE_CLOUD_PROJECT")
              or os.environ.get("GOOGLE_GENAI_USE_VERTEXAI"))


def _fmt(results: dict) -> str:
  metrics = results.get("metrics", [])
  golden = results.get("golden")
  w = max([len(m["name"]) for m in metrics] + [len("metric"), len("AVERAGE")])
  title = "Golden eval" if golden else "Dynamic eval"
  n_runs = results.get("runs", 1)
  head = f"{title} — {results.get('output_dir')}"
  if n_runs and n_runs > 1:
    head += f"  ({n_runs} runs, averaged)"
  lines = ["", head]
  if golden:
    lines.append(f"  golden: {golden}")
  lines.append(f"  mode: {results.get('mode')}  (agent_type={results.get('agent_type')})")
  lines += ["",
            f"  {'metric':{w}} {'score':>7}   rationale",
            f"  {'-'*w} {'-'*7}   {'-'*40}"]
  for m in metrics:
    rat = (m.get("rationale") or "").replace("\n", " ")
    if len(rat) > 90:
      rat = rat[:90] + "…"
    lines.append(f"  {m['name']:{w}} {fmt_score(m['score']):>7}   {rat}")
  lines.append(f"  {'-'*w} {'-'*7}")
  lines.append(f"  {'AVERAGE':{w}} {fmt_score(results.get('average_score')):>7}")
  per_run = results.get("per_run_averages")
  if per_run and len(per_run) > 1:
    lines.append(f"  {'per-run':{w}} {', '.join(fmt_score(s) for s in per_run)}")
  t = results.get("telemetry", {})
  lat = t.get("latency_s")
  lines.append("")
  lines.append(f"  tokens: {t.get('tokens_total', 0):,} "
               f"(in {t.get('tokens_in', 0):,} / out {t.get('tokens_out', 0):,})  ·  "
               f"tool calls: {t.get('num_tool_calls', 0)}  ·  "
               f"latency: {('—' if not lat else f'{lat:.1f}s')}")
  lines.append("")
  return "\n".join(lines)


def _label(results: dict) -> str:
  g = results.get("golden")
  return os.path.basename(g) if g else os.path.basename(results.get("output_dir", ""))


def _fmt_summary(results: list[dict], batch_dir: str | None) -> str:
  w = max([len(_label(r)) for r in results] + [len("golden"), len("OVERALL")])
  lines = ["", f"=== Summary — {len(results)} case(s) ===",
           f"  {'golden':{w}} {'avg':>7}",
           f"  {'-'*w} {'-'*7}"]
  scores = []
  for r in results:
    avg = r.get("average_score")
    if isinstance(avg, (int, float)):
      scores.append(avg)
    lines.append(f"  {_label(r):{w}} {fmt_score(avg):>7}")
  if scores:
    lines.append(f"  {'-'*w} {'-'*7}")
    lines.append(f"  {'OVERALL':{w}} {fmt_score(sum(scores) / len(scores)):>7}")
  if batch_dir:
    lines.append("")
    lines.append(f"  reports: {batch_dir}")
  lines.append("")
  return "\n".join(lines)


def _aggregate_runs(run_results: list[dict]) -> dict:
  """Average N runs of one case into one result (mean per metric + per-run avgs)."""
  if len(run_results) == 1:
    r = dict(run_results[0])
    r["runs"] = 1
    return r
  base = run_results[0]
  by_metric: dict[str, list[float]] = defaultdict(list)
  for r in run_results:
    for m in r.get("metrics", []):
      if isinstance(m.get("score"), (int, float)):
        by_metric[m["name"]].append(m["score"])
  metrics = []
  n = len(run_results)
  for m in base.get("metrics", []):
    vals = by_metric.get(m["name"], [])
    if vals:
      rng = (f" (range {fmt_score(min(vals))}–{fmt_score(max(vals))})"
             if min(vals) != max(vals) else "")
      metrics.append({"name": m["name"], "score": sum(vals) / len(vals),
                      "rationale": f"mean of {len(vals)}/{n} run(s){rng}."})
    else:
      metrics.append({"name": m["name"], "score": None,
                      "rationale": "n/a across runs."})
  run_avgs = [r.get("average_score") for r in run_results
              if isinstance(r.get("average_score"), (int, float))]
  agg = dict(base)
  agg["metrics"] = metrics
  agg["average_score"] = (sum(run_avgs) / len(run_avgs)) if run_avgs else None
  agg["per_run_averages"] = run_avgs
  agg["runs"] = n
  return agg


# --------------------------- run mode (case-runner) ---------------------------

async def _run_cases(goldens, project, model, runs, concurrency, batch_dir,
                     persona, dry_run):
  cases = []
  for gp in goldens:
    with open(gp, encoding="utf-8") as f:
      golden = json.load(f)
    if "run" not in golden:
      print(f"error: {gp} has no `run` block — it's a score-only golden. Score it "
            "with `--output-dir <existing> --golden`.", file=sys.stderr)
      return None
    cases.append((gp, golden))

  if dry_run:
    print(f"[dry-run] would run {len(cases)} case(s) x {runs} run(s), "
          f"concurrency {concurrency}, into {batch_dir}:")
    for gp, golden in cases:
      print(f"  - {os.path.basename(gp)}: {json.dumps(golden['run'])}")
    return []

  sem = asyncio.Semaphore(concurrency)
  # Resolve inputs (incl. copy-public-dataset setup) sequentially — bq calls.
  jobs = []  # (gp, stem, inputs, run_idx, out_dir)
  for gp, golden in cases:
    inputs = runner.resolve_inputs(golden, project)
    stem = os.path.splitext(os.path.basename(gp))[0]
    for i in range(runs):
      out = os.path.join(batch_dir, stem, f"run{i + 1}", "mdcode")
      jobs.append((gp, stem, inputs, i + 1, out))

  async def _do(job):
    gp, stem, inputs, idx, out = job
    rc, _ = await runner.run_agent(inputs, project, model, out, sem)
    return job, rc

  done = await asyncio.gather(*[_do(j) for j in jobs])

  per_case: dict[tuple, list] = defaultdict(list)
  for (gp, stem, inputs, idx, out), rc in done:
    if rc != 0:
      print(f"[score] skip {stem} run{idx} (agent exited {rc}).", file=sys.stderr)
      continue
    # A run with no trajectory.json didn't really finish (crash/timeout) — don't
    # score garbage; surface it so the user can fix their case/env.
    if not os.path.isfile(os.path.join(out, "trajectory.json")):
      print(f"[score] skip {stem} run{idx}: no trajectory.json — the agent run "
            f"did not complete (check the agent env: deps + kcmd built). Output: "
            f"{out}", file=sys.stderr)
      continue
    res = run_golden_eval(out, gp, model=model, persona_id=persona,
                          report_dir=os.path.join(batch_dir, stem),
                          report_name=f"run{idx}.md")
    if "error" in res:
      print(f"[score] {stem} run{idx}: {res['error']}", file=sys.stderr)
      continue
    per_case[(gp, stem)].append(res)

  results = [_aggregate_runs(rl) for rl in per_case.values() if rl]
  return results


def main(argv=None) -> int:
  ap = argparse.ArgumentParser(
      prog="python -m eval",
      description="Evaluate enrichment — score an existing output, or --run golden cases.")
  ap.add_argument("--output-dir", default=None,
                  help="SCORE mode: the agent's output dir (catalog/ + trajectory.json). "
                       "Comma-separated to pair with --goldens. RUN mode: optional report "
                       "root (defaults to a timestamped folder under $TMPDIR).")
  ap.add_argument("--golden", default=None, help="A single golden file.")
  ap.add_argument("--goldens", default=None,
                  help="Comma-separated golden files → evaluate several at once.")
  ap.add_argument("--run", action="store_true",
                  help="RUN each golden as a CASE on the agent (generate mdcode via its "
                       "`run` block + setup), then score. Requires --project.")
  ap.add_argument("--project", default=None,
                  help="GCP project (RUN mode): agent Vertex project + dataset-copy target. "
                       "Also sets GOOGLE_CLOUD_PROJECT for the judge.")
  ap.add_argument("--runs", type=int, default=None,
                  help="Times to run each case for run-level + averaged metrics. "
                       "Default: 3 in --run mode (matches the internal harness), 1 in "
                       "score mode. In score mode >1 means N judge re-scoring passes.")
  ap.add_argument("--concurrency", type=int,
                  default=max(1, int(os.environ.get("KC_EVAL_MAX_CONCURRENCY", "2"))),
                  help="RUN mode: max concurrent agent processes (default 2 / "
                       "KC_EVAL_MAX_CONCURRENCY); the agent caps its own LLM concurrency.")
  ap.add_argument("--dry-run", action="store_true",
                  help="RUN mode: print the plan (cases, runs) without running anything.")
  ap.add_argument("--persona", default=None,
                  help="Persona id from the golden's `personas` (golden mode only).")
  ap.add_argument("--model", default="gemini-2.5-pro",
                  help="Model for the agent (RUN) and the judge — any Vertex AI model id "
                       "you have access to (default gemini-2.5-pro).")
  ap.add_argument("--json", action="store_true",
                  help="Emit raw JSON instead of a formatted scorecard.")
  args = ap.parse_args(argv)

  if args.runs is not None and args.runs < 1:
    print("error: --runs must be >= 1.", file=sys.stderr)
    return 2

  goldens: list[str] = []
  if args.goldens:
    goldens = [g.strip() for g in args.goldens.split(",") if g.strip()]
  elif args.golden:
    goldens = [args.golden]
  for g in goldens:
    if not os.path.isfile(g):
      print(f"error: golden not found: {g}", file=sys.stderr)
      return 2

  # ----- RUN mode: generate mdcode via the agent, then score -----
  if args.run:
    if not goldens:
      print("error: --run needs --golden/--goldens (the case to run).", file=sys.stderr)
      return 2
    if not args.project:
      print("error: --run needs --project (agent Vertex project + dataset target).",
            file=sys.stderr)
      return 2
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", args.project)
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "True")
    if not _has_judge_auth():
      print("warning: no Vertex auth — run `gcloud auth application-default login`.",
            file=sys.stderr)
    run_id = (datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
              + "_" + uuid.uuid4().hex[:6])
    root = args.output_dir or os.path.join(tempfile.gettempdir(),
                                           "kc_golden_eval_reports")
    batch_dir = os.path.join(root, f"golden_run_{run_id}")
    os.makedirs(batch_dir, exist_ok=True)
    run_n = args.runs or 3
    results = asyncio.run(_run_cases(goldens, args.project, args.model, run_n,
                                     args.concurrency, batch_dir, args.persona,
                                     args.dry_run))
    if results is None:
      return 2
    if args.dry_run:
      return 0
    # manifest for the user: what ran, when, where.
    with open(os.path.join(batch_dir, "manifest.json"), "w", encoding="utf-8") as f:
      json.dump({"run_id": run_id, "when": run_id, "project": args.project,
                 "model": args.model, "runs_per_case": run_n,
                 "concurrency": args.concurrency,
                 "cases": [os.path.basename(g) for g in goldens],
                 "results": [{"golden": _label(r), "average": r.get("average_score")}
                             for r in results]}, f, indent=2)
    if args.json:
      print(json.dumps(results, indent=2))
    else:
      for r in results:
        print(_fmt(r))
      print(_fmt_summary(results, batch_dir) if len(results) > 1
            else f"\n  reports: {batch_dir}\n")
    return 0 if results else 1

  # ----- SCORE mode: score an already-produced output dir -----
  if not args.output_dir:
    print("error: --output-dir is required (or use --run to generate it).",
          file=sys.stderr)
    return 2
  output_dirs = [d.strip() for d in args.output_dir.split(",") if d.strip()]
  if goldens:
    if len(output_dirs) == 1:
      jobs = [(output_dirs[0], g) for g in goldens]
    elif len(output_dirs) == len(goldens):
      jobs = list(zip(output_dirs, goldens))
    else:
      print("error: --output-dir must be one dir or match the --goldens count.",
            file=sys.stderr)
      return 2
  else:
    jobs = [(d, None) for d in output_dirs]
  for d, g in jobs:
    if not os.path.isdir(d):
      print(f"error: not a directory: {d}", file=sys.stderr)
      return 2
  if args.persona and not goldens:
    print("error: --persona requires a golden.", file=sys.stderr)
    return 2
  if not _has_judge_auth():
    print("warning: GOOGLE_CLOUD_PROJECT not set — judge metrics need Vertex AI auth; "
          "deterministic metrics still run.", file=sys.stderr)

  all_results, rc = [], 0
  for d, g in jobs:
    run_results = []
    for _ in range(args.runs or 1):
      res = (run_golden_eval(d, g, model=args.model, persona_id=args.persona)
             if g else run_dynamic_eval(d, model=args.model))
      if "error" in res:
        print(f"error [{g or d}]: {res['error']}", file=sys.stderr)
        rc = 1
        break
      run_results.append(res)
    if not run_results:
      continue
    agg = _aggregate_runs(run_results)
    all_results.append(agg)
    if not args.json:
      print(_fmt(agg))
  if args.json:
    print(json.dumps(all_results[0] if len(all_results) == 1 else all_results, indent=2))
  elif len(all_results) > 1:
    print(_fmt_summary(all_results, None))
  return rc


if __name__ == "__main__":
  raise SystemExit(main())
