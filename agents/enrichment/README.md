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

The agent has four modes:

- **`table`** — pulls a BigQuery dataset's tables (schema) via `kcmd`, routes
  Google Drive documents to each table by relevance, and writes an enriched
  overview per table in the `kcmd` `bq-dataset` format. Also emits a `queries`
  aspect per table that bundles BigQuery `INFORMATION_SCHEMA` query patterns,
  SQL examples extracted from routed docs, and (optionally) ground-truth SQL
  from user-feedback proposals. Optionally (`--glossaries`) maps columns to
  Dataplex glossary terms and injects field-level definition links.
  **Cross-table shared concepts:** facts that span multiple tables (e.g. a
  relationship documented only on the child side, or a metric defined across
  tables) are extracted once and injected *additively* into every relevant
  table's overview — so a parent table can surface its inbound references even
  when the source only states them child-side, without dropping any
  document-grounded fact.
- **`doc`** — crawls Google Docs (and an optional Drive folder), map-reduce
  summarizes them, and emits a knowledge-base mdcode snapshot.
- **`context_overlay`** — pulls 1P BigQuery table entries via `kcmd reference`
  (read-only) and creates a NEW context-overlay entry per table in an editable
  entry group. The overlay carries the enriched overview + queries aspect so you
  can ship richer descriptions without touching the live `@bigquery` entry. Like
  table mode, it injects the **cross-table shared concepts** additively into each
  overlay.
- **`hybrid`** — run `doc` mode WITH `--dataset`. The agent builds the
  knowledge-base entries from the docs (cross-cutting knowledge that doesn't
  belong to any single table) AND, in the *same* entry group, a context-overlay
  entry per table in the dataset. Use it when your corpus describes both general
  concepts and specific tables: one run yields standalone KB entries **plus**
  per-table overlays. Hybrid is never inferred — you opt in by passing
  `--mode=doc` together with `--dataset`.

Any of these modes can optionally ingest **user-feedback proposals** via
`--feedback_dir` / `--feedback_files`. Feedback is treated as the
**highest-priority context source** — proposals override conflicting information
from Drive docs, semantic search, or INFORMATION_SCHEMA-derived patterns.

Any of these modes can also ingest a **GitHub source-code repository** via
`--repo` (an extra context source — not a fourth mode). A code-understanding
agent explores the repo **agentically through the GitHub MCP server** and
distills it into code *component cards*. In `doc` mode the distinct components
surface as their own knowledge-base entries; in `table` / `context_overlay` mode
the cards join the relevance router's candidate pool, so code that reads or
writes a table (or contains SQL referencing it) grounds that table's overview
and queries aspect.

Beyond Google Drive, any mode can also ingest **Confluence** and **SharePoint**
as context sources (not extra modes). Pass `--confluence_space` for Confluence
spaces or `--sharepoint_sites` for SharePoint sites, or simply drop Confluence /
SharePoint URLs into `--docs` / `--folders` — they are auto-detected and lifted
into the right source. Their pages/files surface in the same shape as the other
sources: their own knowledge-base entries in `doc` mode, or relevance-router
candidates in `table` / `context_overlay`. Confluence is read through the
Atlassian Rovo MCP server; SharePoint through the Microsoft Graph REST API (text
files read in full, `.docx`/`.xlsx`/`.pptx`/PDF extracted locally — see
[docs/sharepoint-setup.md](docs/sharepoint-setup.md) for auth).

After a run, you can iterate on the output with free-text **refinement** —
either an interactive REPL (`--interactive`) or a single re-invocation
(`--refine_instruction`). Refinement reuses the already-loaded context and never
re-reads the source docs or re-pulls the dataset.

## Layout

This repo mirrors the `GoogleCloudPlatform/knowledge-catalog` `agents/` layout:

```
agents/
├── mdcode/                      # the kcmd (Metadata as Code) CLI + library
└── enrichment/
    ├── src/
    │   ├── agent_runner.py      # CLI entrypoint: flags + dispatch to a mode
    │   ├── engine.py            # LLM agents (Vertex Gemini) for all modes
    │   ├── common.py            # shared helpers (run_text, mdcode parsing, trajectory)
    │   ├── okf_serializer.py    # OKF (Open Knowledge Format) bundle writer (--output_format=okf)
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
    │       ├── github_tools.py   # agentic GitHub-repo code source via the GitHub MCP server
    │       ├── confluence_tools.py # Confluence space/page source via the Atlassian Rovo MCP server
    │       └── sharepoint_tools.py # SharePoint site/file source via the Microsoft Graph REST API
    ├── scripts/                 # SharePoint auth setup (setup_sharepoint.py, mint_sharepoint_token.py)
    ├── docs/                    # source-setup guides (sharepoint-setup.md)
    └── eval/                     # evaluation CLI (dynamic golden-free + golden-based)
        ├── __main__.py          # `python -m eval --output-dir ... [--golden ...]` | `--run`
        ├── dynamic_eval.py      # golden-free scoring of a single run
        ├── golden_eval.py       # golden-based scoring (concepts, facts, coverage)
        ├── aggregate.py         # multi-run roll-up (per-run + averaged + consistency)
        ├── runner.py            # `--run` case-runner (setup + N agent runs)
        ├── metrics.py           # metric library (deterministic + LLM-judge)
        ├── loaders.py           # read catalog/ + trajectory.json
        ├── goldens/             # golden schema (TEMPLATE.json) + ready goldens
        └── corpora/             # local markdown corpora the goldens ground on
```

## Prerequisites

You'll need a few CLIs on your PATH before installing anything Python-side:

- **Node.js + npm** (any recent LTS — `node --version`, `npm --version`) to
  build `kcmd`.
- **`gcloud` CLI** (`gcloud --version`) for Application Default Credentials.
  Install: <https://cloud.google.com/sdk/docs/install>.
- **Python 3.11+** (`python3 --version`).

Then:

1. **Build `kcmd`** (the agent shells out to it). From the repo root:
   ```bash
   cd agents/mdcode
   npm install
   npm run build          # -> agents/mdcode/dist/kcmd

   # Put `kcmd` on your PATH so you can run `kcmd push` from anywhere.
   # $(pwd) expands to the absolute dist path now (baked into the file), while
   # \$PATH stays literal so it re-expands on each new shell.
   echo "export PATH=\"$(pwd)/dist:\$PATH\"" >> ~/.bashrc   # zsh users: ~/.zshrc
   source ~/.bashrc

   cd ../..
   ```
   The agent also finds the binary automatically at `agents/mdcode/dist/kcmd`
   (override with `$KCMD_BIN`), so adding it to `PATH` is only needed for running
   `kcmd` yourself (e.g. `kcmd push`). Verify with `which kcmd`.

2. **Python deps** (a venv is recommended):
   ```bash
   python3 -m venv ~/.venv/kc-enrich
   source ~/.venv/kc-enrich/bin/activate
   pip install -r agents/enrichment/src/requirements.txt
   ```
   (`google-cloud-bigquery` powers the table-mode usage signal; `mcp` is only
   needed for the GitHub source over a local stdio server — the default hosted
   remote server works without it.) The same hand-typed list lives at the top of
   `agents/enrichment/src/requirements.txt` if you'd rather pin versions yourself.

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
export PYTHONPATH=agents/enrichment/src

# Table mode — enrich a BigQuery dataset's tables, grounded in a Drive folder.
python3 agents/enrichment/src/agent_runner.py \
  --mode=table \
  --dataset=<project>.<dataset> \
  --folders=<drive_folder_id_or_url> \
  --topic="<your use case / instruction>" \
  --project=<your_gcp_project> \
  --location=<vertex_location> \
  --model=<vertex_model> \
  --output_dir=<local_output_dir>

# Doc mode — build a knowledge base from Google Docs (+ optional folder).
python3 agents/enrichment/src/agent_runner.py \
  --mode=doc \
  --docs="https://docs.google.com/document/d/<id>,<id2>" \
  --folders=<drive_folder_id_or_url> \
  --topic="<your use case / instruction>" \
  --entry_group=<project>.<location>.<entryGroupId> \
  --project=<your_gcp_project> \
  --location=<vertex_location> \
  --model=<vertex_model> \
  --output_dir=<local_output_dir>

# Context-overlay mode — enrich BQ tables into a SEPARATE entry group you own
# (the live @bigquery entries are read-only, never modified).
python3 agents/enrichment/src/agent_runner.py \
  --mode=context_overlay \
  --dataset=<project>.<dataset> \
  --entry_group=<project>.<location>.<entryGroupId> \
  --folders=<drive_folder_id_or_url> \
  --topic="<your use case / instruction>" \
  --project=<your_gcp_project> \
  --model=<vertex_model> \
  --output_dir=<local_output_dir>

# Hybrid mode — doc mode PLUS --dataset: builds knowledge-base entries from the
# docs AND a context-overlay entry per table, in the same entry group. Output
# will contain both the standalone KB entries and the per-table overlays.
python3 agents/enrichment/src/agent_runner.py \
  --mode=doc \
  --dataset=<project>.<dataset> \
  --folders=<drive_folder_id_or_url> \
  --entry_group=<project>.<location>.<entryGroupId> \
  --topic="<your use case / instruction>" \
  --project=<your_gcp_project> \
  --location=<vertex_location> \
  --model=<vertex_model> \
  --output_dir=<local_output_dir>
```

Any mode can additionally pull in a GitHub repository as a code-context source.
The GitHub MCP server reads a Personal Access Token from its environment:

```bash
export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...
python3 agents/enrichment/src/agent_runner.py --mode=doc \
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
| `--folders` | ✓ | ✓ | ✓ |
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
| `--confluence_space` | ✓ | ✓ | ✓ |
| `--sharepoint_sites` | ✓ | ✓ | ✓ |
| `--output_format` | ✓ | ✓ | ✓ |
| `--interactive` | ✓ | ✓ | ✓ |
| `--refine_instruction` | ✓ | ✓ | ✓ |

#### Required in every mode

- **`--project`** — Google Cloud project that hosts the Vertex AI model. Example: `--project=my-gcp-project`.
- **`--model`** — Vertex AI model id for the reasoning-heavy steps, e.g. `--model=gemini-2.5-pro`. (Small structured steps use a pinned Flash model internally.)
- **`--output_dir`** — Local directory for the generated mdcode tree, `trajectory.json`, and `refine_session.json`. Example: `--output_dir=/tmp/enrich_out`.

#### Model / location

- **`--location`** — *(optional, default `global`)* Vertex AI location for the model, e.g. `--location=us-central1`.

#### Mode selection & target

- **`--mode`** — *(optional, default inferred)* One of `doc`, `table`, `context_overlay`. If omitted it's inferred: `--dataset` set ⇒ `table`, otherwise `doc`. `context_overlay` is never inferred — pass it explicitly. **Hybrid** is `--mode=doc` *with* `--dataset` (also never inferred): you get doc-mode KB entries **plus** a context-overlay entry per table.
- **`--dataset`** — *(table, context_overlay — required; doc — optional)* BigQuery dataset as `project.dataset`, e.g. `--dataset=my-proj.analytics`. In **doc** mode it's optional: supplying it switches the run to **hybrid** (doc KB entries + per-table overlays); omit it for a plain doc-only run.
- **`--entry_group`** — *(doc, context_overlay — required)* Entry group `project.location.entryGroupId`. In **doc** mode it **must already exist** (the agent runs read-only `kcmd` and won't create it — see the note above). In **overlay** mode it's where the new overlay entries are created. Ignored in table mode, which writes onto the live `@bigquery` entries.

#### Source context (what the agent reads)

- **`--topic`** — *(optional, default `"Metadata enrichment"`)* Free-text use case/instruction that steers enrichment (and the doc-mode topic reduce). Example: `--topic="Customer 360 data"`.
- **`--folders`** — *(optional)* Comma-separated, mixed list (routed per entry): Google Drive folder IDs/URLs (Docs/Sheets/Slides/PDF) **and/or local directories of `.md` files** (read recursively). Works in all modes. `--folder` (singular) is accepted as a deprecated alias. See [Local Markdown inputs](#local-markdown-inputs). Example: `--folders=https://drive.google.com/drive/folders/<id>,./local_md_corpus`.
- **`--docs`** — *(doc, context_overlay)* Comma-separated, mixed list: Google Doc URLs/IDs **and/or local `.md` files**. In doc mode these are the authoritative depth-0 "spine"; in overlay mode they're routed to tables. **Not used in table mode** — use `--folders` there. Example: `--docs="https://docs.google.com/document/d/<id1>,./notes/x.md"`.
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
- **`--mcp_config`** — Path to an `mcp.json` describing the GitHub MCP server. Falls back to `KC_ENRICH_MCP_CONFIG`, then the hosted remote server (`https://api.githubcopilot.com/mcp/`). Pick a server entry with `KC_ENRICH_GITHUB_MCP_SERVER` (default `github_remote`; use `github` for the local stdio binary). A minimal `mcp.json` with both entries:
  ```json
  {
    "mcpServers": {
      "github_remote": {
        "type": "http",
        "url": "https://api.githubcopilot.com/mcp/",
        "headers": {"Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"}
      },
      "github": {
        "type": "stdio",
        "command": "github-mcp-server",
        "args": ["stdio"],
        "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"}
      }
    }
  }
  ```

#### Confluence input *(all modes)*

- **`--confluence_space`** — Comma-separated Confluence space keys to ingest as a context source (e.g. `--confluence_space=DATA,RUNBOOKS`). Top-level pages are listed and the most topic-relevant ones read, through the Atlassian Rovo MCP server. Confluence page/space URLs may also be dropped into `--docs` / `--folders` — they are auto-detected and lifted into this source. Auth via `ATLASSIAN_API_TOKEN` / `ATLASSIAN_OAUTH_TOKEN`; the server can be overridden with `--mcp_config`.

#### SharePoint input *(all modes)*

- **`--sharepoint_sites`** — Comma-separated SharePoint sites — accepts full site URLs from your browser's address bar, e.g. `--sharepoint_sites=https://contoso.sharepoint.com/sites/Marketing`. Walks each site's default document library and reads topic-relevant files via the Microsoft Graph REST API (text read in full; `.docx`/`.xlsx`/`.pptx`/PDF extracted locally). SharePoint URLs may also be dropped into `--docs` / `--folders`. Auth uses an MSAL token cache or `MICROSOFT_ACCESS_TOKEN` — see [docs/sharepoint-setup.md](../docs/sharepoint-setup.md) and `scripts/setup_sharepoint.py`.

#### Output format *(all modes)*

- **`--output_format`** — *(default `kcmd`)* Serialization of the generated tree. `kcmd` writes the native catalog layout (`X.yaml` + `X.overview.md` under `catalog/`). `okf` writes an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle (one `X.md` per concept with YAML frontmatter + `index.md` listings under `bundle/`), publishable via `kcmd push --format okf`.

#### Refinement *(all modes, after a run)*

- **`--interactive`** — *(default `false`)* After the initial run, stay in a `refine>` REPL for free-text changes — rewrite an overview, add/remove/recategorize entries, or ask a question. Reuses loaded context (no doc re-read). No-op on a non-TTY.
- **`--refine_instruction`** — Apply ONE refinement turn to the saved session in `--output_dir`, then exit (the report's persist + re-invoke flow). Requires a prior run's `refine_session.json` in `--output_dir`. Example: `--refine_instruction="make the orders overview more concise"`.

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
python3 agents/enrichment/src/agent_runner.py \
  --mode=doc \
  --docs="https://docs.google.com/document/d/<id>,./notes/data_model.md" \
  --folders="<drive_folder_id_or_url>,./local_md_corpus" \
  --topic="<your use case>" \
  --entry_group=<project>.<location>.<entryGroupId> \
  --project=<your_gcp_project> --model=<vertex_model> \
  --output_dir=<local_output_dir>

# Table mode grounded purely in a local Markdown folder (no Drive needed):
python3 agents/enrichment/src/agent_runner.py \
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

The agent writes a `kcmd` **Metadata-as-Code** tree into `--output_dir`. The
top-level `catalog.yaml` is the manifest (`kcmd init`); everything else lives
under `catalog/`. Each entry is a **folder** containing its `…​.yaml` (the entry:
`name`/`id`/`type`/`resource`/`aspects`), its `…​.overview.md` (the enriched
overview, an `overview` aspect), and — for tables/overlays — a `…​.queries.md`
sidecar (the `queries` aspect of sample SQL). Every folder also gets an
auto-generated `index` entry (`index.yaml` + `index.overview.md`) that names the
folder and carries `contains`/`parent` links, forming a navigable hierarchy.

With **`--output_format=okf`** the same content is instead written as an
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
bundle under `bundle/` — one `X.md` per concept (YAML frontmatter + the overview
as the Markdown body) plus reserved `index.md` directory listings (the root one
carries `okf_version`). Publish it with `kcmd push --format okf`.

**Per mode** (entry `type` in parentheses):

```
catalog/
├── catalog.yaml                         # manifest (kcmd init)
│
│   ## doc mode — knowledge-base entries grouped into category folders:
├── <category>/                          # e.g. data-concepts-and-structure/
│   ├── index.{yaml,overview.md}         #   folder index (generic)
│   └── <entry>.{yaml,overview.md}       #   KB entry (generic, aspect type=knowledge-base)
│
│   ## table / context_overlay / hybrid — per-table folders under bigquery/:
└── bigquery/<project>/<dataset>/
    ├── index.{yaml,overview.md}         # dataset-level index
    └── <table>/
        ├── <table>.yaml                 # table entry (bigquery-table)  OR overlay (generic, aspect type=context-overlay)
        ├── <table>.overview.md          # enriched overview
        ├── <table>.queries.md           # sample-SQL sidecar (queries aspect)
        ├── <table>.ref.yaml             # read-only 1P @bigquery mirror (overlay/hybrid only; not pushed)
        └── index.{yaml,overview.md}     # per-table folder index
```

- **doc** → only the category-grouped KB folders.
- **table** → only the `bigquery/<project>/<dataset>/<table>/` folders; the
  overview is written onto the live `@bigquery` table entry (`bigquery-table`).
- **context_overlay** → the per-table folders, but each `<table>.yaml` is a NEW
  `generic` overlay entry (aspect `type: context-overlay`) whose `resource.name`
  points at the real `@bigquery` table; the read-only `…​.ref.*` mirror is parked
  alongside (never pushed).
- **hybrid** (`--mode=doc` + `--dataset`) → **BOTH**: the category-grouped KB
  folders **and** the per-table overlay folders. The KB entries hold only the
  cross-cutting knowledge that does not belong on any single table; the per-table
  facts (schema, columns, foreign-key relationships) live in the overlays — they
  are **not** duplicated as KB entries.

A `trajectory.json` (what the agent read + produced) and an `eval_report.md` are
also written at the root. Inspect the tree with:

```bash
find /tmp/enrich_out -type f
```

## Evaluating the output

Before you publish, you can score an enrichment run with the **dynamic
(golden-free) evaluator** under `agents/enrichment/eval/`. It needs no
reference answers — it grounds its checks in the agent's own `trajectory.json`
(what it actually retrieved), so it works on your own data out of the box.

```bash
# Run from agents/enrichment/ — `python -m eval` resolves the `eval` package
# relative to this directory.
cd agents/enrichment
pip install -r eval/requirements.txt
# If you plan to use --run (which spawns the agent itself), also install the
# agent's deps:
#   pip install -r src/requirements.txt

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
| `--output-dir` | yes (score mode) | The enrichment run's output dir (contains `catalog/` + `trajectory.json`). |
| `--golden` | no | Golden file → golden-based eval (adds concept_recall/precision, fact_recall, coverage). Omit for dynamic (golden-free) eval. See `eval/goldens/README.md`. |
| `--run` | no | Run each golden as a CASE (generate the mdcode via the agent, then score) instead of scoring an existing dir. Requires `--project`. |
| `--goldens` | no | Comma-separated golden files (run/score several cases at once). |
| `--runs` | no | How many times to run each case (default 3 in `--run`). Reports per-run + averaged metrics, and enables the cross-run **consistency** metrics (need ≥2 runs). |
| `--project` | with `--run` | GCP project the agent runs in (also sets `GOOGLE_CLOUD_PROJECT` for the judge). |
| `--concurrency` | no | Max concurrent agent processes in `--run` (default 2, env `KC_EVAL_MAX_CONCURRENCY`). |
| `--persona` | no | Persona id from the golden's `personas` (golden mode only). |
| `--model` | no | Judge model — any Vertex AI model id you have access to. Defaults to `gemini-2.5-pro`. |
| `--json` | no | Emit raw JSON instead of the formatted scorecard (for piping/automation). |

It reports the following, each shown **out of 100** in the scorecard (higher is better):

- **structural_validity** *(deterministic)* — the generated mdcode is well-formed:
  entry YAML parses, required fields are present, the entry type matches the mode,
  and overviews are clean Markdown (headers present, no stray YAML frontmatter, no
  unclosed code fences).
- **perf** *(report-only)* — token usage and latency for the run, reported for
  visibility (not gated against a budget; does not affect pass/fail).
- **hallucination_free** *(judge)* — is every factual claim in the overviews
  supported by what the agent actually retrieved? The score is the fraction of
  extracted claims that are grounded; **100 = nothing fabricated**. Claims are
  checked in parallel across chunks of the retrieved source.
- **redundancy_index** *(judge)* — does the overview add **novel** context beyond
  echoing column names/schema? **100 = rich synthesis, 0 = tautological restatement.**
- **disambiguation_efficacy** *(judge)* — is the enrichment enough to tell this
  entry apart from similar/overlapping ones (its grain and purpose made explicit)?
  **100 = clearly distinct.**
- **absence_of_contradictions** *(judge)* — are there contradictions within or
  across the generated entries (join keys, enums, metric definitions, freshness)?
  **100 = none, 0 = an explicit conflict.**

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

A **golden** is an answer key you declare for a case — the expected facts, terms,
and sections. Golden scoring runs the **full dynamic metric set**
(`structural_validity`, `perf`, `hallucination_free`, `redundancy_index`,
`disambiguation_efficacy`, `absence_of_contradictions`) **and adds** the
golden-driven metrics below (each shown out of 100, higher is better):

- **concept_recall** *(judge, doc + hybrid)* — of the concepts the golden expects
  as knowledge-base entries, what fraction did the agent produce (matched by
  meaning, not exact name)? **100 = every expected concept covered.**
- **concept_precision** *(judge, doc mode)* — of the entries the agent produced,
  what fraction map to an expected concept? Spurious entries lower it; concepts
  you list under `acceptable_extra_concepts` are exempt. **100 = no off-target
  entries.**
- **fact_recall** *(judge)* — of the `golden_facts`, what fraction are conveyed by
  the matched output? Per table in **table / context_overlay / hybrid** (each
  golden table treated as a topic); over expected concepts in **doc / hybrid**.
  **Hybrid is scored on BOTH** its KB entries and its per-table overlays (the two
  contributions combine into one score). **100 = all expected facts present.**
- **business_terms_presence** *(judge)* — are the golden's `business_terms`
  defined or used in the output (matched semantically)? **100 = all covered.**
- **enrichment_diversity** *(deterministic)* — does the output contain the
  sections the golden declares in `expected_headings`? A "Sample Queries" heading
  is satisfied by a populated `<table>.queries.md` sidecar. **100 = all expected
  sections present.**
- **entry_grounding** *(deterministic, table + context_overlay)* — do all generated
  entries correspond to real dataset tables, with none invented? (Skipped for
  hybrid, whose standalone KB entries are legitimately not tables.) **100 = nothing
  fabricated.**
- **index_name_coverage** *(deterministic, needs `expected_folders`)* — for the
  per-folder `index` entries the agent emits (doc / context_overlay / hybrid), do
  their display names cover the expected folder/category names (token-overlap
  match)? **100 = every expected folder named.**
- **persona_alignment** *(judge, with `--persona`)* — on the same source, does the
  output emphasize this persona's focus areas while still retaining the shared
  concepts? **100 = strong persona conditioning without dropping shared content.**
- **business_terms_validity** *(judge, needs `business_terms`)* — beyond mere
  presence, does each business term get a dedicated, correct definition (a
  per-term MaC file)? Typically low today (the agent doesn't emit per-term files
  yet) — included for parity with the reference design so scores are comparable.
- **context_preservation** *(judge, needs `prebaked_facts`)* — if the golden
  declares facts that already existed before enrichment, were they **preserved**
  (not clobbered) through the run? Only scored when the golden has `prebaked_facts`.
- **trajectory** *(deterministic, needs a `trajectory` block)* — input-conditioned
  tool use: did the agent call the tools it should (`must_call`) and avoid those it
  shouldn't (`must_not_call`)? Derived from `trajectory.json`. Only scored when the
  golden declares a `trajectory` block (e.g. `{ "must_not_call": ["dataset_pull"] }`
  for a doc case). **100 = tool use matched the inputs.**

The simplest way is to let the eval **run the case end-to-end** — it does the
setup (e.g. copying a public dataset into your project), runs the agent, and
scores the result. You only pass your project and the golden:

```bash
# Runs theLook eCommerce table mode for you (copies the public dataset into
# <project>, enriches it grounded by the local corpus, scores it) — 3 runs,
# run-level + averaged metrics:
python -m eval --run --goldens eval/goldens/thelook_ecommerce.json \
    --project <your_gcp_project> --model gemini-2.5-pro --runs 3
```

`--run` repeats each case `--runs` times and writes per-run + averaged reports
into a timestamped folder under `$TMPDIR/kc_golden_eval_reports/` (printed at the
end). Add more cases with a comma-separated `--goldens`. Prereqs: ADC
(`gcloud auth application-default login`) and a built `kcmd`
(`cd agents/mdcode && npm run build`) — every mode shells out to it.

#### Public goldens by mode

All goldens below ground on **public** BigQuery datasets (`bigquery-public-data.*`),
copied/replicated into your project by each golden's `run.setup`:

| Mode | Goldens |
| --- | --- |
| **doc** | `supply_chain`, `financial_services`, `phone_services` |
| **table** | `table_crypto_bitcoin`, `table_ga4_obfuscated_sample_ecommerce`, `table_stackoverflow`, `thelook_ecommerce`, `xref_stackoverflow` *(cross-table showcase: FKs documented child-side only, so parent inbound refs require cross-table aggregation)* |
| **context_overlay** | `overlay_crypto_bitcoin`, `overlay_ga4_obfuscated_sample_ecommerce` |
| **hybrid** *(doc CLI + `--dataset`)* | `hybrid_stackoverflow` |

```bash
# Cross-table showcase (table mode):
python -m eval --run --goldens eval/goldens/xref_stackoverflow.json \
    --project <your_gcp_project> --model gemini-2.5-pro --runs 2

# Context-overlay + hybrid target an entry group you own, so the golden's
# run.entry_group is `{project}.global.kc-eval-overlay` / `kc-eval-hybrid`
# (the `{project}` placeholder is filled with your --project). Create the entry
# group(s) once, then:
python -m eval --run \
    --goldens eval/goldens/overlay_crypto_bitcoin.json,eval/goldens/hybrid_stackoverflow.json \
    --project <your_gcp_project> --model gemini-2.5-pro --runs 2
```

> **The eval (and the agent) never publish to the catalog.** Every mode produces
> **local** Metadata-as-Code under `--output_dir`; the eval scores those files and
> stops. Publishing is always your explicit, separate `kcmd push` step — the agent
> only ever *reads* the catalog (`kcmd init`/`pull`/`reference`) during a run.
>
> What each mode needs in **your project** (so it can't be fully anonymous):
> - **All modes** — a GCP project for the Vertex model.
> - **table / context_overlay / hybrid** — read a BigQuery dataset through the
>   Dataplex catalog, so the golden's `run.setup` replicates the public dataset
>   into your project first. (table writes its overview onto the dataset's live
>   `@bigquery` entries; doc reads no dataset.)
> - **doc / context_overlay / hybrid** — just an entry-group **name** to namespace
>   the generated entries (e.g. `{project}.global.kc-eval-...`). It does **not** need
>   to exist beforehand — you don't create anything; `kcmd pull` tolerates a missing
>   group (the run simply starts from empty local state), and the group is only
>   actually created/populated if *you* later `kcmd push`. Table mode needs none.

### Multiple runs: averaged metrics + consistency

With `--runs N` (N ≥ 2), each metric is reported as the **mean across runs** with
its per-run scores and how many runs passed (`runs k/n`), the case rationale keeps
the *real* per-metric explanation (a representative run's, preferring a failing
one — not just "mean of N"), and the report appends a **per-run breakdown** you
can drill into. Two extra **cross-run stability** metrics are added (informational
— they don't gate the case or affect the average):

- **concept_consistency** — does the agent produce the **same set of concepts**
  every run? Each concept scores the fraction of runs it appears in, so producing
  more/fewer concepts between runs lowers it (matched by meaning when the judge is
  on, by name/word overlap otherwise). **100 = identical concept set each run.**
- **content_consistency** — for concepts that recur across runs, are their
  **facts consistent** (no drift/contradiction between runs)? **100 = same facts
  every run.**

Both measure stability *across* runs, so they only apply with **≥2 runs**; with a
single run they're surfaced as `n/a` with a note to run the case 2–3× to assess
stability.

To score an output you already produced (no agent run), point `--golden` at it:

```bash
python -m eval --output-dir /tmp/enrich_out --golden eval/goldens/supply_chain.json
```

See `eval/goldens/README.md` for the golden/case schema (incl. the `run` block
for your own cases), `--run`/`--runs`/`--goldens` usage, and three ways to build
goldens — author them, work backward from already-documented data, or harvest
them from human review.

## Natural-language input (`--task`)

Instead of wiring up every source flag by hand, you can describe the run in plain
English with `--task`. A lightweight classifier reads the text, figures out which
sources you named (Drive, local Markdown, Confluence, SharePoint, GitHub, BigQuery
dataset/tables) and the mode, and resolves them into the normal typed flags. It
prints the resolved config + sources before proceeding; add `--task_dry_run` to
review the parse and exit without running.

**Two flags are still required even with `--task`:** `--project` and `--model` —
they're needed up front to run the classifier itself, so they're never inferred
from the text. (`--output_dir`, `--location` and `--entry_group` *may* be named in
the task; if `--output_dir` is omitted it defaults to a CWD subdir.)

```bash
# Same run as the table-mode example above, described in English:
python3 agents/enrichment/src/agent_runner.py \
  --project=<your_gcp_project> --model=<vertex_model> \
  --task="Enrich the orders and customers tables in <project>.<dataset> for a
          customer-analytics use case, grounded in this Drive folder <url> and
          the Confluence space DATA. Write the output to /tmp/enrich_out."
```

`--task` and the classic flags **mix freely** — every old flag still works exactly
as before, and an explicit flag always **wins** over the parse (lists union,
scalars keep the explicit value). Omit `--task` entirely and behavior is
unchanged. Credentials are never read from the text.

## Publishing to the catalog

The agent only **generates** mdcode and runs read-only `kcmd` commands. Pushing
to Dataplex is **your** step, with `kcmd push`:

```bash
cd /tmp/enrich_out
CLOUDSDK_CORE_PROJECT=<project> CLOUDSDK_COMPUTE_REGION=<region> \
  ../agents/mdcode/dist/kcmd push     # or `kcmd push` if kcmd is on your PATH
```

`kcmd` is the Metadata as Code tool from
[`GoogleCloudPlatform/knowledge-catalog`](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/agents/mdcode),
vendored here under `agents/mdcode`.
