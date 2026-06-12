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

The agent has three modes:

- **`table`** — pulls a BigQuery dataset's tables (schema) via `kcmd`, routes
  Google Drive documents to each table by relevance, and writes an enriched
  overview per table in the `kcmd` `bq-dataset` format. Also emits a `queries`
  aspect per table that bundles BigQuery `INFORMATION_SCHEMA` query patterns,
  SQL examples extracted from routed docs, and (optionally) ground-truth SQL
  from user-feedback proposals. Optionally (`--glossaries`) maps columns to
  Dataplex glossary terms and injects field-level definition links.
- **`doc`** — crawls Google Docs (and an optional Drive folder), map-reduce
  summarizes them, and emits a knowledge-base mdcode snapshot.
- **`context_overlay`** — pulls 1P BigQuery table entries via `kcmd reference`
  (read-only) and creates a NEW context-overlay entry per table in an editable
  entry group. The overlay carries the enriched overview + queries aspect so you
  can ship richer descriptions without touching the live `@bigquery` entry.

Any of the three modes can optionally ingest **user-feedback proposals** via
`--feedback_dir` / `--feedback_files`. Feedback is treated as the
**highest-priority context source** — proposals override conflicting information
from Drive docs, semantic search, or INFORMATION_SCHEMA-derived patterns.

Any of the three modes can also ingest a **GitHub source-code repository** via
`--repo` (an extra context source — not a fourth mode). A code-understanding
agent explores the repo **agentically through the GitHub MCP server** and
distills it into code *component cards*. In `doc` mode the distinct components
surface as their own knowledge-base entries; in `table` / `context_overlay` mode
the cards join the relevance router's candidate pool, so code that reads or
writes a table (or contains SQL referencing it) grounds that table's overview
and queries aspect.

After a run, you can iterate on the output with free-text **refinement** —
either an interactive REPL (`--interactive`) or a single re-invocation
(`--refine_instruction`). Refinement reuses the already-loaded context and never
re-reads the source docs or re-pulls the dataset.

## Layout

This repo mirrors the `GoogleCloudPlatform/knowledge-catalog` `toolbox/` layout:

```
toolbox/
├── mdcode/                      # the kcmd (Metadata as Code) CLI + library
└── enrichment/
    ├── src/
    │   ├── agent_runner.py      # CLI entrypoint: flags + dispatch to a mode
    │   ├── engine.py            # LLM agents (Vertex Gemini) for all modes
    │   ├── common.py            # shared helpers (run_text, mdcode parsing, trajectory)
    │   ├── refine.py            # multi-turn refinement (REPL + persist/re-invoke)
    │   ├── linking.py           # glossary column→term linking helper (table mode)
    │   ├── modes/
    │   │   ├── doc_mode.py             # run(topic, docs, folder, output_dir, model, entry_group, ...)
    │   │   ├── table_mode.py           # run(dataset, folder, topic, output_dir, model, ...)
    │   │   └── context_overlay_mode.py # run(dataset, folder, topic, ..., entry_group, ...)
    │   └── tools/
    │       ├── kcmd_tools.py     # kcmd init/pull/reference discovery + entry reading
    │       ├── drive_tools.py    # Google Drive/Docs fetch helpers
    │       ├── bq_usage_tools.py # INFORMATION_SCHEMA query history + queries-aspect sidecar
    │       ├── feedback_tools.py # user-feedback proposal loader + per-table router
    │       └── github_tools.py   # agentic GitHub-repo code source via the GitHub MCP server
    └── eval/                     # evaluation CLI (dynamic, golden-free)
        ├── __main__.py          # `python -m eval --output-dir ...`
        ├── dynamic_eval.py      # golden-free scoring of a single run
        ├── metrics.py           # metric library (deterministic + LLM-judge)
        └── loaders.py           # read catalog/ + trajectory.json
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
               google-cloud-bigquery mcp pypdf pyyaml requests absl-py
   ```
   (`google-cloud-bigquery` powers the table-mode usage signal; `mcp` is only
   needed for the GitHub source over a local stdio server — the default hosted
   remote server works without it.)

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

# Context-overlay mode — enrich BQ tables into a SEPARATE entry group you own
# (the live @bigquery entries are read-only, never modified).
python3 toolbox/enrichment/src/agent_runner.py \
  --mode=context_overlay \
  --dataset=<project>.<dataset> \
  --entry_group=<project>.<location>.<entryGroupId> \
  --folder=<drive_folder_id_or_url> \
  --topic="<your use case / instruction>" \
  --project=<your_gcp_project> \
  --model=<vertex_model> \
  --output_dir=<local_output_dir>
```

Any mode can additionally pull in a GitHub repository as a code-context source.
The GitHub MCP server reads a Personal Access Token from its environment:

```bash
export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...
python3 toolbox/enrichment/src/agent_runner.py --mode=doc \
  --entry_group=<project>.<location>.<entryGroupId> \
  --topic="Order pipeline" \
  --repo=my-org/order-service --repo_ref=main \
  --project=<your_gcp_project> --model=<vertex_model> --output_dir=<local_output_dir>
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

### Flags

Every invocation goes through `agent_runner.py` (run it with `--help` for the raw
list). `--project`, `--model`, and `--output_dir` are required in **every** mode;
`--dataset` and/or `--entry_group` become required depending on the mode.

**Which flag applies to which mode** — `R` = required, `✓` = optional, `—` = not used:

| Flag | `doc` | `table` | `context_overlay` |
|------|:-----:|:-------:|:-----------------:|
| `--project` | R | R | R |
| `--model` | R | R | R |
| `--output_dir` | R | R | R |
| `--location` | ✓ | ✓ | ✓ |
| `--mode` | ✓ | ✓ | ✓ |
| `--topic` | ✓ | ✓ | ✓ |
| `--dataset` | — | R | R |
| `--entry_group` | R | — | R |
| `--folder` | ✓ | ✓ | ✓ |
| `--docs` | ✓ | — | ✓ |
| `--tables` | — | — | ✓ |
| `--include_usage` | — | ✓ | ✓ |
| `--usage_window_days` | — | ✓ | ✓ |
| `--usage_scope` | — | ✓ | ✓ |
| `--anonymize_users` | — | ✓ | ✓ |
| `--glossaries` | — | ✓ | — |
| `--feedback_dir` | ✓ | ✓ | ✓ |
| `--feedback_files` | ✓ | ✓ | ✓ |
| `--repo` | ✓ | ✓ | ✓ |
| `--repo_ref` | ✓ | ✓ | ✓ |
| `--repo_subdir` | ✓ | ✓ | ✓ |
| `--mcp_config` | ✓ | ✓ | ✓ |
| `--interactive` | ✓ | ✓ | ✓ |
| `--refine_instruction` | ✓ | ✓ | ✓ |

#### Required in every mode

- **`--project`** — Google Cloud project that hosts the Vertex AI model. Example: `--project=my-gcp-project`.
- **`--model`** — Vertex AI model id for the reasoning-heavy steps, e.g. `--model=gemini-2.5-pro`. (Small structured steps use a pinned Flash model internally.)
- **`--output_dir`** — Local directory for the generated mdcode tree, `trajectory.json`, and `refine_session.json`. Example: `--output_dir=/tmp/enrich_out`.

#### Model / location

- **`--location`** — *(optional, default `global`)* Vertex AI location for the model, e.g. `--location=us-central1`.

#### Mode selection & target

- **`--mode`** — *(optional, default inferred)* One of `doc`, `table`, `context_overlay`. If omitted it's inferred: `--dataset` set ⇒ `table`, otherwise `doc`. `context_overlay` is never inferred — pass it explicitly.
- **`--dataset`** — *(table, context_overlay — required)* BigQuery dataset as `project.dataset`, e.g. `--dataset=my-proj.analytics`. Ignored in doc mode.
- **`--entry_group`** — *(doc, context_overlay — required)* Entry group `project.location.entryGroupId`. In **doc** mode it **must already exist** (the agent runs read-only `kcmd` and won't create it — see the note above). In **overlay** mode it's where the new overlay entries are created. Ignored in table mode, which writes onto the live `@bigquery` entries.

#### Source context (what the agent reads)

- **`--topic`** — *(optional, default `"Metadata enrichment"`)* Free-text use case/instruction that steers enrichment (and the doc-mode topic reduce). Example: `--topic="Customer 360 data"`.
- **`--folder`** — *(optional)* Google Drive folder ID or URL to seed source documents from (Docs/Sheets/Slides/PDF). Works in all modes. Example: `--folder=https://drive.google.com/drive/folders/<id>`.
- **`--docs`** — *(doc, context_overlay)* Comma-separated Google Doc URLs or IDs. In doc mode these are the authoritative depth-0 "spine"; in overlay mode they're routed to tables. **Not used in table mode** — use `--folder` there. Example: `--docs="https://docs.google.com/document/d/<id1>,<id2>"`.
- **`--tables`** — *(context_overlay only)* Restrict the overlay to specific tables — short names or `proj.ds.table` FQNs, comma-separated. Empty = every table in `--dataset`. Example: `--tables=orders,customers`.

#### BigQuery usage signal — the `queries` aspect *(table, context_overlay)*

- **`--include_usage`** — *(default `true`)* Fetch BigQuery `INFORMATION_SCHEMA` query history per table and emit a `<table>.queries.md` sidecar. `--include_usage=false` skips the BQ scan entirely.
- **`--usage_window_days`** — *(default `30`)* Days of query history to aggregate. Example: `--usage_window_days=90`.
- **`--usage_scope`** — *(default `auto`)* `auto` tries `JOBS_BY_PROJECT` then falls back to `JOBS_BY_USER` on a permission error; `project` requires `JOBS_BY_PROJECT`; `user` reads only your own queries (always works, but narrow).
- **`--anonymize_users`** — *(default `false`)* Replace user emails with stable SHA hashes in the usage signal.

#### Glossary column-linking *(table only)*

- **`--glossaries`** — Comma-separated Dataplex glossaries `project.location.glossaryId`. When set, the agent maps BigQuery columns to glossary terms and injects field-level `links.definition` into each table's entry YAML (published by `kcmd push`). Example: `--glossaries=my-proj.us.business-glossary`.

#### User-feedback proposals *(all modes)*

- **`--feedback_dir`** — Directory of user-feedback files (`.md`/`.json`, pure-JSON `{proposals: [...]}` content), walked recursively. Proposals are the highest-priority context and **override** conflicting info from docs/usage. Routed per-table in table/overlay; applied globally in doc mode.
- **`--feedback_files`** — Explicit comma-separated feedback file paths; combinable with `--feedback_dir`.

#### GitHub source-code input *(all modes)*

- **`--repo`** — GitHub repo as `owner/name` or a URL, explored agentically via the GitHub MCP server as an extra code-context source. Needs a token in the server's environment (default env var `GITHUB_PERSONAL_ACCESS_TOKEN`). Empty = no code source.
- **`--repo_ref`** — Branch/tag/SHA to read (default: the repo's default branch). Example: `--repo_ref=main`.
- **`--repo_subdir`** — Path prefix to scope the exploration, e.g. `--repo_subdir=src/server`.
- **`--mcp_config`** — Path to an `mcp.json` describing the GitHub MCP server. Falls back to `KC_ENRICH_MCP_CONFIG`, then the hosted remote server (`https://api.githubcopilot.com/mcp/`). Pick a server entry with `KC_ENRICH_GITHUB_MCP_SERVER` (default `github_remote`; use `github` for the local stdio binary).

#### Refinement *(all modes, after a run)*

- **`--interactive`** — *(default `false`)* After the initial run, stay in a `refine>` REPL for free-text changes — rewrite an overview, add/remove/recategorize entries, or ask a question. Reuses loaded context (no doc re-read). No-op on a non-TTY.
- **`--refine_instruction`** — Apply ONE refinement turn to the saved session in `--output_dir`, then exit (the webapp's persist + re-invoke flow). Requires a prior run's `refine_session.json` in `--output_dir`. Example: `--refine_instruction="make the orders overview more concise"`.

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
