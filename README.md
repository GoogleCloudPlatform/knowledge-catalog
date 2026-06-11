<!-- disableFinding(HTML_OPEN) -->
<!-- disableFinding(HTML_BROKEN) -->
<!-- disableFinding(LINE_OVER_80) -->
<!-- disableFinding(LIST_NO_LINE) -->
<!-- disableFinding(HEADING_REPEAT_H1) -->
<!-- disableFinding(WHITESPACE_LINES) -->
<!-- disableFinding(WHITESPACE_TRAILING) -->

# Knowledge Catalog Enrichment Agent

A command-line agent that generates **Metadata as Code** (mdcode) for Knowledge
Catalog (Dataplex). It extracts information from source material and produces the
YAML + Markdown artifacts that describe data assets, ready to be pushed to the
catalog with the `kcmd` tool.

The agent talks to the catalog **only through `kcmd`** (Metadata as Code) — it
never calls the Dataplex API directly. It runs the read-only `kcmd init` /
`kcmd pull` commands itself to scaffold `catalog.yaml` and pull existing entries
(schema, etc.); you run `kcmd push` to publish.

The agent has two modes:

- **`table`** — pulls a BigQuery dataset's tables (schema) via `kcmd`, routes
  Google Drive documents to each table by relevance, and writes an enriched
  overview per table in the `kcmd` `bq-dataset` format.
- **`doc`** — crawls Google Docs (and an optional Drive folder), map-reduce
  summarizes them, and emits a knowledge-base mdcode snapshot.

## Layout

This repo mirrors the `GoogleCloudPlatform/knowledge-catalog` `toolbox/` layout:

```
toolbox/
├── mdcode/                  # the kcmd (Metadata as Code) CLI + library
└── enrichment/
    ├── src/
        ├── agent_runner.py  # CLI entrypoint: flags + dispatch to a mode
        ├── engine.py        # LLM agents (Vertex Gemini) for both modes
        ├── common.py        # shared helpers (run_text, mdcode parsing, trajectory)
        ├── modes/
        │   ├── doc_mode.py    # run(topic, docs, folder, output_dir, model, entry_group)
        │   └── table_mode.py  # run(dataset, folder, topic, output_dir, model)
        └── tools/
            ├── kcmd_tools.py  # kcmd init/pull discovery + entry reading
            └── drive_tools.py # Google Drive/Docs fetch helpers
    └── eval/                 # dynamic (golden-free) evaluation CLI
        ├── __main__.py        # `python -m eval --output-dir ...`
        ├── dynamic_eval.py    # golden-free scoring of a single run
        ├── metrics.py         # metric library (deterministic + LLM-judge)
        └── loaders.py         # read catalog/ + trajectory.json
```

## Prerequisites

1. **Build `kcmd`** (the agent shells out to it). From the repo root:
   ```bash
   cd toolbox/mdcode
   npm install
   npm run build          # -> toolbox/mdcode/dist/kcmd

   # Put `kcmd` on your PATH so you can run `kcmd push` from anywhere.
   # $(pwd) expands to the absolute dist path now (baked into the file), while
   # \$PATH stays literal so it re-expands on each new shell.
   echo "export PATH=\"$(pwd)/dist:\$PATH\"" >> ~/.bashrc   # zsh users: ~/.zshrc
   source ~/.bashrc

   cd ../..
   ```
   The agent also finds the binary automatically at `toolbox/mdcode/dist/kcmd`
   (override with `$KCMD_BIN`), so adding it to `PATH` is only needed for running
   `kcmd` yourself (e.g. `kcmd push`). Verify with `which kcmd`.

2. **Python 3.11+** and the agent dependencies (a venv is recommended):
   ```bash
   python3 -m venv ~/.venv/kc-enrich
   source ~/.venv/kc-enrich/bin/activate
   pip install google-adk google-genai google-api-python-client google-auth \
               pypdf pyyaml requests absl-py
   ```

3. **Application Default Credentials** (the agent uses Vertex AI, `kcmd` uses
   `gcloud` for catalog auth, and Drive access for source docs):
   ```bash
   gcloud auth application-default login \
     --scopes='openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive.readonly'
   ```

The Vertex project/location and the model are supplied per run via flags
(`--project`, `--location`, `--model`) — nothing is hardcoded.

## Usage

Point `PYTHONPATH` at the package `src`, then run a mode. Supply your own GCP
project and model.

```bash
export PYTHONPATH=toolbox/enrichment/src

# Table mode — enrich a BigQuery dataset's tables, grounded in a Drive folder.
python3 toolbox/enrichment/src/agent_runner.py \
  --mode=table \
  --dataset=<project>.<dataset> \
  --folder=<drive_folder_id_or_url> \
  --topic="<your use case / instruction>" \
  --project=<your_gcp_project> \
  --location=<vertex_location> \
  --model=<vertex_model> \
  --output_dir=<local_output_dir>

# Doc mode — build a knowledge base from Google Docs (+ optional folder).
python3 toolbox/enrichment/src/agent_runner.py \
  --mode=doc \
  --docs="https://docs.google.com/document/d/<id>,<id2>" \
  --folder=<drive_folder_id_or_url> \
  --topic="<your use case / instruction>" \
  --entry_group=<project>.<location>.<entryGroupId> \
  --project=<your_gcp_project> \
  --location=<vertex_location> \
  --model=<vertex_model> \
  --output_dir=<local_output_dir>
```

All values above are yours to choose, e.g. `--topic="Customer 360 data"`,
`--location=us-central1` (or `global`), `--model=gemini-2.5-pro`,
`--output_dir=/tmp/enrich_out`.

> **Doc mode — `--entry_group` is required and must already exist.** The target
> entry group (`project.location.entryGroupId`) must be **created beforehand** in
> the specified project; the agent does not create it (it runs read-only `kcmd
> init`/`pull`). Create it first, e.g.:
> ```bash
> gcloud dataplex entry-groups create <entryGroupId> \
>   --project=<project> --location=<location>
> ```
> The knowledge-base entries are created with the 1P **generic** entry type, with
> the enriched content as their `overview` aspect.

Flags (see `agent_runner.py --help`):

| Flag | Modes | Required | Meaning |
|------|-------|----------|---------|
| `--project` | both | yes | Your Google Cloud project for the Vertex AI model. |
| `--model` | both | yes | Any Vertex AI model id you have access to, e.g. `gemini-2.5-pro`. |
| `--location` | both | no | Any Vertex AI location (e.g. `us-central1`, `europe-west1`, or `global`). Defaults to `global`. |
| `--output_dir` | both | yes | Any local directory for the generated mdcode. |
| `--mode` | both | no | `doc` or `table`. Empty → inferred (`--dataset` set ⇒ table, else doc). |
| `--dataset` | table | yes (table) | BigQuery dataset as `project.dataset`. |
| `--entry_group` | doc | **yes (doc)** | Target entry group as `project.location.entryGroupId`. **It must already exist** in that project (create it first — see note below). Entries are created with the 1P generic entry type. |
| `--docs` | doc | no | Comma-separated Google Doc URLs or IDs. |
| `--folder` | both | no | Google Drive folder ID/URL to seed from. |
| `--topic` | both | no | Free-text use case / instruction guiding enrichment (anything, e.g. `"Customer 360 data"`). |

## Output

The agent writes a `kcmd` mdcode tree into `--output_dir`: a `catalog.yaml`
manifest written by `kcmd init`; the per-entry YAML under `catalog/` (pulled by
`kcmd pull` in table mode, or generated by the agent in doc mode); and the
enriched overview sidecar Markdown. It also writes a `trajectory.json` recording
what the agent read and produced. Inspect it with:

```bash
find /tmp/enrich_out -type f
```

## Evaluating the output

Before you publish, you can score an enrichment run with the **dynamic
(golden-free) evaluator** under `toolbox/enrichment/eval/`. It needs no
reference answers — it grounds its checks in the agent's own `trajectory.json`
(what it actually retrieved), so it works on your own data out of the box.

```bash
cd toolbox/enrichment
pip install -r eval/requirements.txt

# Judge auth — Vertex AI, the same auth the agent uses:
export GOOGLE_CLOUD_PROJECT=<project>
gcloud auth application-default login

# Score a run (the same --output_dir you gave the agent):
python -m eval --output-dir /tmp/enrich_out
python -m eval --output-dir /tmp/enrich_out --model gemini-2.5-pro --json
```

It reports, on a 0–1 scale:

- **structural_validity** — the generated mdcode is well-formed (deterministic).
- **perf** — token usage and latency, against an optional `--max-latency-s` /
  `--max-total-tokens` budget.
- **hallucination_free** — every factual claim in the overviews is supported by
  what the agent actually retrieved (chunked, parallel, judged).
- **redundancy_index / disambiguation_efficacy / absence_of_contradictions** —
  rubric quality checks (judged).

Deterministic metrics always run; the judge-based metrics run when judge auth is
set (otherwise they're skipped and reported as `n/a`).

## Publishing to the catalog

The agent only **generates** mdcode and runs read-only `kcmd` commands. Pushing
to Dataplex is **your** step, with `kcmd push`:

```bash
cd /tmp/enrich_out
CLOUDSDK_CORE_PROJECT=<project> CLOUDSDK_COMPUTE_REGION=<region> \
  ../toolbox/mdcode/dist/kcmd push     # or `kcmd push` if kcmd is on your PATH
```

`kcmd` is the Metadata as Code tool from
[`GoogleCloudPlatform/knowledge-catalog`](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/toolbox/mdcode),
vendored here under `toolbox/mdcode`.
