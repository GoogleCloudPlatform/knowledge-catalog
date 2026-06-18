"""Run a golden as a CASE: optional dataset-copy setup + N agent runs.

`python -m eval --run` uses this to match a single-agent eval: a golden
file can carry a `run` block (the agent inputs + optional `setup`), and the eval
copies any public dataset into the user's project, runs the agent `--runs` times
(under a concurrency cap so parallel runs don't blow Vertex quota), and hands the
output dirs back to the scorer.

The agent itself caps its own internal LLM concurrency per mode
(`CONCURRENCY_LIMIT` in modes/table_mode.py = 12, doc_mode.py = 6, per-doc = 20);
this module caps how many agent *processes* run at once on top of that.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys

# The published agent lives next to the eval package: agents/enrichment/src.
_AGENT_DIR = os.environ.get("KC_AGENT_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")


def _bq(*args: str) -> subprocess.CompletedProcess:
  return subprocess.run(["bq", *args], capture_output=True, text=True, check=False)


def ensure_dataset_copy(source: str, target_project: str, target_dataset: str,
                        location: str = "US") -> str:
  """Make `target_project.target_dataset` exist by copying it from `source`.

  Idempotent: if the target dataset already exists it is left untouched. `source`
  is `project.dataset` (e.g. `bigquery-public-data.thelook_ecommerce`); the source
  is read via its public/shared access and per-table copy failures are non-fatal.
  Returns the `project.dataset` of the copy.
  """
  target_ref = f"{target_project}:{target_dataset}"
  if _bq("--project_id", target_project, "show", "--dataset",
         target_ref).returncode == 0:
    print(f"[setup] dataset {target_project}.{target_dataset} already exists "
          "— reusing (no copy).", flush=True)
    return f"{target_project}.{target_dataset}"
  print(f"[setup] copying {source} -> {target_project}.{target_dataset} ...",
        flush=True)
  _bq("--project_id", target_project, "mk", "--dataset",
      f"--location={location}", target_ref)
  src_project, src_dataset = source.split(".", 1)
  ls = _bq("--format=json", "--project_id", target_project, "ls",
           "--max_results=10000", f"{src_project}:{src_dataset}")
  try:
    tables = [it["tableReference"]["tableId"]
              for it in (json.loads(ls.stdout) or [])]
  except (json.JSONDecodeError, KeyError, TypeError):
    tables = []
  for tbl in tables:
    cp = _bq("--project_id", target_project, "cp", "-f", "--no_clobber",
             f"{src_project}:{src_dataset}.{tbl}",
             f"{target_project}:{target_dataset}.{tbl}")
    if cp.returncode != 0:
      print(f"[setup] warning: copy {tbl} failed (non-fatal): "
            f"{(cp.stderr or '').strip()[:160]}", flush=True)
  print(f"[setup] copied {len(tables)} table(s).", flush=True)
  return f"{target_project}.{target_dataset}"


def ensure_schema_only_replica(spec: dict, project: str) -> str:
  """Reproduce a public dataset as a SCHEMA-ONLY, description-stripped replica in
  the user's project by invoking a builder under eval/tools/.

  For public datasets that are too large to copy (e.g. crypto_bitcoin,
  stackoverflow) and/or ship rich column descriptions that would hand the agent
  free grounding, we replicate only the schema (empty tables, descriptions
  stripped) so enrichment must come from the grounding corpus. `spec` carries an
  optional `builder` (default make_public_replica.py), `dataset`, and optionally
  `source` and `tables`. Returns `<project>.<dataset>`."""
  builder = spec.get("builder", "make_public_replica.py")
  script = os.path.join(os.path.dirname(__file__), "tools", builder)
  argv = [sys.executable, script, "--project", project,
          "--dataset", spec["dataset"], "--location", spec.get("location", "US")]
  if spec.get("source"):
    argv += ["--source", spec["source"]]
  if spec.get("tables"):
    argv += ["--tables", ",".join(spec["tables"])]
  print(f"[setup] schema-only replica via {builder}: {project}.{spec['dataset']}",
        flush=True)
  subprocess.run(argv, check=False)
  return f"{project}.{spec['dataset']}"


def resolve_inputs(golden: dict, project: str) -> dict:
  """Build the agent CLI inputs for a golden's `run` block.

  Runs any `setup.copy_public_dataset` / `setup.schema_only_replica` and, for it,
  sets `dataset` to the copy/replica in the user's project. Returns a dict of
  agent flags (mode/topic/dataset/folders/docs/entry_group/glossaries).

  Any `{project}` placeholder in a run-block string value is replaced with the
  user's `--project`, so a doc-mode golden can declare a generalizable
  `entry_group` like `{project}.global.kc-eval-foo` and still target whoever runs
  it.
  """
  run = dict(golden.get("run") or {})
  setup = run.pop("setup", None) or {}
  cp = setup.get("copy_public_dataset")
  if cp:
    ds = ensure_dataset_copy(cp["source"], project, cp["dataset"],
                             location=cp.get("location", "US"))
    run.setdefault("dataset", ds)
  sor = setup.get("schema_only_replica")
  if sor:
    run.setdefault("dataset", ensure_schema_only_replica(sor, project))
  return {k: (v.replace("{project}", project) if isinstance(v, str) else v)
          for k, v in run.items()}


def _argv(inputs: dict, project: str, model: str, output_dir: str) -> list[str]:
  argv = [sys.executable, os.path.join(_AGENT_DIR, "agent_runner.py"),
          f"--project={project}", f"--model={model}",
          f"--output_dir={output_dir}"]
  for key in ("mode", "topic", "dataset", "entry_group", "folders", "docs",
              "glossaries", "location", "tables"):
    val = inputs.get(key)
    if val:
      argv.append(f"--{key}={val}")
  return argv


async def run_agent(inputs: dict, project: str, model: str, output_dir: str,
                    sem: asyncio.Semaphore) -> tuple[int, str]:
  """Run one agent process for `inputs` into `output_dir`, gated by `sem`."""
  os.makedirs(output_dir, exist_ok=True)
  argv = _argv(inputs, project, model, output_dir)
  env = dict(os.environ)
  env["PYTHONPATH"] = _AGENT_DIR + os.pathsep + env.get("PYTHONPATH", "")
  env["GOOGLE_GENAI_USE_VERTEXAI"] = "True"
  env["GOOGLE_CLOUD_PROJECT"] = project
  env.setdefault("GOOGLE_CLOUD_LOCATION", inputs.get("location") or "global")
  # Run from the eval-invocation dir (agents/enrichment) so relative inputs like
  # `--folders=eval/corpora/...` resolve; PYTHONPATH (absolute) keeps imports OK.
  async with sem:
    print(f"[run] agent ({inputs.get('mode', 'doc')}) -> {output_dir}", flush=True)
    proc = await asyncio.create_subprocess_exec(
        *argv, cwd=os.getcwd(), env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await proc.communicate()
    log = out.decode(errors="replace") if out else ""
    if proc.returncode != 0:
      print(f"[run] FAILED ({output_dir}): {log.strip()[-400:]}", flush=True)
    return proc.returncode, log
