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
    └── eval/                 # evaluation CLI (dynamic + golden-based)
        ├── __main__.py        # `python -m eval --output-dir ... [--golden ...]`
        ├── dynamic_eval.py    # golden-free scoring of a single run
        ├── golden_eval.py     # golden-based scoring (concepts, facts, coverage)
        ├── metrics.py         # metric library (deterministic + LLM-judge)
        ├── loaders.py         # read catalog/ + trajectory.json
        └── goldens/           # golden schema (TEMPLATE.json), GOLDENS.md, example
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
  --folders=<drive_folder_id_or_url> \
  --topic="<your use case / instruction>" \
  --project=<your_gcp_project> \
  --location=<vertex_location> \
  --model=<vertex_model> \
  --output_dir=<local_output_dir>

# Doc mode — build a knowledge base from Google Docs (+ optional folder).
python3 toolbox/enrichment/src/agent_runner.py \
  --mode=doc \
  --docs="https://docs.google.com/document/d/<id>,<id2>" \
  --folders=<drive_folder_id_or_url> \
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
| `--docs` | doc / overlay | no | Comma-separated **mixed list**, routed per entry: Google Doc URLs/IDs **and/or local `.md`/`.markdown` files**. A local file is a doc-mode depth-0 "spine" doc. |
| `--folders` | all | no | Comma-separated **mixed list**, routed per entry: Google Drive folder URLs/IDs **and/or local directories of `.md` files** (read recursively). Seeds depth-1 children (doc) or grounding docs (table/overlay). (`--folder` is accepted as a deprecated alias.) |
| `--topic` | both | no | Free-text use case / instruction guiding enrichment (anything, e.g. `"Customer 360 data"`). |

## Local Markdown inputs

You don't have to put your source material in Google Drive. `--docs` and
`--folders` both accept **local Markdown** (`.md` / `.markdown`) alongside Google
Docs / Drive folders — every entry in either flag is routed independently, so a
single run can mix all four kinds of source.

**How each entry is classified (format-first, so it never depends on your shell's
working directory):**

1. Starts with `http://` / `https://` → **Google Drive** (Doc or folder URL).
2. Ends in `.md` / `.markdown` → **local Markdown file**.
3. Path-shaped (`/abs/path`, `./rel`, `../rel`, `~/path`, or contains a `/`) →
   **local** (a directory is read recursively; a file is read directly).
4. A bare relative name that exists on disk → **local**.
5. Otherwise (a bare opaque token) → **Google Drive ID**.

Because Drive IDs are long opaque tokens and local paths/`.md` files trip rules
1–3 first, there is no collision between the two. The agent logs how it routed
each entry (`[Route] --docs '…' -> local md spine file`, etc.). Absolute paths
are recommended; relative paths resolve from the agent's working directory.

**What local Markdown maps to per mode:**

- **doc mode** — a local `.md` file in `--docs` is a depth-0 *spine* doc (like an
  authoritative Google Doc); a local directory in `--docs`/`--folders` contributes
  its `.md` files as depth-1 children (like a Drive folder).
- **table / context_overlay modes** — local `.md` files/folders join the
  candidate pool that the relevance router grounds each table's overview in,
  exactly like Drive documents.

```bash
# Doc mode mixing Google Docs + local Markdown (files and a folder):
python3 toolbox/enrichment/src/agent_runner.py \
  --mode=doc \
  --docs="https://docs.google.com/document/d/<id>,./notes/data_model.md" \
  --folders="<drive_folder_id_or_url>,./local_md_corpus" \
  --topic="<your use case>" \
  --entry_group=<project>.<location>.<entryGroupId> \
  --project=<your_gcp_project> --model=<vertex_model> \
  --output_dir=<local_output_dir>

# Table mode grounded purely in a local Markdown folder (no Drive needed):
python3 toolbox/enrichment/src/agent_runner.py \
  --mode=table \
  --dataset=<project>.<dataset> \
  --folders=./local_md_corpus \
  --project=<your_gcp_project> --model=<vertex_model> \
  --output_dir=<local_output_dir>
```

Each source the agent reads is recorded in `trajectory.json` as its own tool call
(`read_local_md` for local files, `fetch_gdoc` for Google Docs), so downstream
evaluation counts and grounds on exactly what was read.

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
python -m eval --output-dir /tmp/enrich_out --model gemini-2.5-pro
```

Each run also writes a full **`eval_report.md`** next to `trajectory.json` in the
output dir — the same metrics with **untruncated** rationales (the terminal
scorecard abbreviates them to stay readable).

### Flags

Flags (see `python -m eval --help`):

| Flag | Required | Meaning |
|------|----------|---------|
| `--output-dir` | yes | The enrichment run's output dir (contains `catalog/` + `trajectory.json`). |
| `--golden` | no | Golden file → golden-based eval (adds concept_recall/precision, fact_recall, coverage). Omit for dynamic (golden-free) eval. See `eval/goldens/GOLDENS.md`. |
| `--persona` | no | Persona id from the golden's `personas` (golden mode only). |
| `--model` | no | Judge model — any Vertex AI model id you have access to. Defaults to `gemini-2.5-pro`. |
| `--json` | no | Emit raw JSON instead of the formatted scorecard (for piping/automation). |

It reports the following, each on a 0–1 scale (higher is better):

- **structural_validity** *(deterministic)* — the generated mdcode is well-formed:
  entry YAML parses, required fields are present, the entry type matches the mode,
  and overviews are clean Markdown (headers present, no stray YAML frontmatter, no
  unclosed code fences).
- **perf** *(report-only)* — token usage and latency for the run, reported for
  visibility (not gated against a budget; does not affect pass/fail).
- **hallucination_free** *(judge)* — is every factual claim in the overviews
  supported by what the agent actually retrieved? The score is the fraction of
  extracted claims that are grounded; **1.0 = nothing fabricated**. Claims are
  checked in parallel across chunks of the retrieved source.
- **redundancy_index** *(judge)* — does the overview add **novel** context beyond
  echoing column names/schema? **1 = rich synthesis, 0 = tautological restatement.**
- **disambiguation_efficacy** *(judge)* — is the enrichment enough to tell this
  entry apart from similar/overlapping ones (its grain and purpose made explicit)?
  **1 = clearly distinct.**
- **absence_of_contradictions** *(judge)* — are there contradictions within or
  across the generated entries (join keys, enums, metric definitions, freshness)?
  **1 = none, 0 = an explicit conflict.**

### Enabling the judge-based metrics

The **deterministic** metrics (`structural_validity`, `perf`) always run. The
**judge-based** metrics (`hallucination_free`, `redundancy_index`,
`disambiguation_efficacy`, `absence_of_contradictions`) run **automatically as
soon as judge auth is available** — there is no on/off flag. To turn them on, set
up Vertex AI auth (the same auth the enrichment agent uses):

```bash
export GOOGLE_CLOUD_PROJECT=<your-project>
gcloud auth application-default login
```

Without auth they are simply skipped and shown as `n/a`; the deterministic metrics
still run. Choose the judge model with `--model` (default `gemini-2.5-pro`).

### Golden-based eval (optional)

Dynamic eval needs no answer key. For deeper checks — *did we capture the expected
concepts and facts, without spurious entries?* — score against a **golden** that
declares what the output should contain:

```bash
python -m eval --output-dir /tmp/enrich_out --golden eval/goldens/example_ga_events.json
```

On top of the dynamic metrics this adds **concept_recall**, **concept_precision**,
**fact_recall**, and section/term coverage. Golden runs write a full
`golden_report_<run>.md` (untruncated rationales) into a tmp folder
(`$TMPDIR/kc_golden_eval_reports/`) — the path is printed on the `[eval]` log.
See `eval/goldens/GOLDENS.md` for the schema and three ways to build goldens —
author them, work backward from already-documented data, or harvest them from
human review.

**Ready-to-run example — theLook eCommerce (table mode):** a complete,
out-of-the-box golden built on the public `bigquery-public-data.thelook_ecommerce`
dataset and grounded by a local markdown corpus (`eval/corpora/thelook_ecommerce/`).
**GOLDENS.md → "theLook eCommerce"** has the full copy-paste flow: copy the public
dataset into your project (`bq cp`), enrich it in table mode
(`--folders=eval/corpora/thelook_ecommerce`), then
`python -m eval --output-dir <out> --golden eval/goldens/thelook_ecommerce.json`.

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
