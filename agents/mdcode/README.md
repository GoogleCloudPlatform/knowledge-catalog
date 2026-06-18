# Metadata as Code

Metadata as Code is a Knowledge Catalog (Dataplex) provides data stewards and
data producers and AI agents with a source code artifact-based UX for metadata
management and context engineering.

Users and agents can author, manage, and enrich metadata artifacts using
developer-friendly workflows with version control and CI/CD. It provides a
standard metadata format can be used by a variety of tools and agents.

More details are in the [docs/concept.md](docs/concept.md).

## Key Features

`kcmd` (Metadata as Code) provides a developer-friendly UX for Dataplex metadata management, enabling data stewards and AI agents to author and enrich metadata using version-controlled workflows.

#### 1. Core Metadata Management

*   **Metadata as Source Code**: Manage catalog entries as local YAML and Markdown files, organized in a hierarchy that mirrors your cloud resources.
*   **Bi-directional Sync**: Seamlessly sync local changes with the Catalog service via `pull` and `push` operations.

#### 2. Grounding & Safe Publishing

*   **Contextual Reference Layers**: Pull read-only system metadata (like schemas) into `.ref.yaml` files. This provides an authoritative baseline for enrichment without risking accidental overwrites.
*   **Automatic Provisioning**: Create missing Entry Groups and Entries directly from your local filesystem during a `push`.

#### 3. Content Flexibility

*   **Optimized Layouts**: Automatically switches between **YAML Layout** (for data assets) and **Markdown Layout** (for human-centric Knowledge Bases).
*   **Markdown Sidecars**: Detach long-form text (like overviews) into sidecar `.md` files to maintain clean and manageable YAML files.
*   **OKF Bundles**: Opt into the **OKF Layout** with `--format okf` to
    read/write an
    [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
    bundle — one `.md` per concept (YAML frontmatter + body) plus reserved
    `index.md` directory listings, rooted at `bundle/`.

#### 4. Integration & Extensibility

*   **Agent-Ready (MCP)**: Includes a built-in **Model Context Protocol (MCP)** server, allowing AI agents to list, lookup, and modify metadata autonomously.
*   **Unified Interface**: Supports BigQuery Datasets, Dataplex Entry Groups,
    BigLake namespaces, and Business Glossaries through a single command-line
    tool and library.

#### 5. Linked Metadata & Glossary

*   **EntryLinks**: Catalog relationships (e.g., `definition` linking a BQ
    column to a business term, or `schema-join` between BQ tables) are
    first-class artifacts in `pull` and `push`. Declare `entryLinks` in your
    manifest and they sync alongside entries.
*   **Column-level Linking**: Links that carry a `Schema.<field>` source path
    are inlined under `aspects.schema.fields[].links` on the table YAML —
    per-column governance lives right next to the column definition.
*   **Glossary as a Source**: `scope:
    glossary.<project>.<location>.<glossary-id>` manages Business Glossaries
    (terms, categories, nested structure) using the same `pull`/`push` workflow
    as other source types. Targets in pulled YAML resolve to the human-readable
    `project.location.glossary.term` form (display-name based) with the full UID
    preserved in `id` for round-trip.
*   **Safe Push Reconciliation**: `push` matches local vs remote links by
    normalized target + path (project ID/Number agnostic, `@dataplex` proxy
    unwrapped), so existing links are detected and kept in place — no spurious
    delete-and-recreate cycles.

## What's New

*   **Multi-dataset Support**: `kcmd init` now accepts multiple `--bigquery-dataset` flags, enabling a single workspace to manage metadata across multiple BQ datasets.
*   **Knowledge Base (Wiki) Mode**: Use the `--kb` flag to manage human-authored content via the **Markdown Layout**. It automatically organizes pages as `.md` files with YAML frontmatter.
*   **AI-Native Reference Layers**: Use `kcmd reference` to pull read-only system metadata. This creates a distinct `.ref.yaml` layer, allowing AI agents to ground their enrichments on authoritative schemas without modifying them.
*   **Built-in MCP Server**: Native support for the Model Context Protocol, allowing seamless integration with AI agents for automated metadata tasks.
*   **EntryLinks Sync**: `pull` and `push` now manage `EntryLink` resources as
    first-class artifacts. Declare link types in `snapshot.entryLinks` to fetch
    them, in `publishing.entryLinks` to reconcile them on push, and (optionally)
    in `reference.snapshot.entryLinks` so `.ref.yaml` baselines include the
    pre-edit link state for clean diffs.
*   **Glossary Source**: A Business Glossary can be the primary `scope`
    (`glossary.<project>.<location>.<glossary-id>`), enabling local CRUD of
    glossary terms and categories via the same `pull`/`push` workflow.
    Glossaries also work as a `reference.scope` so other workspaces can ground
    enrichment in glossary terms without owning them.
*   **OKF Layout (`--format okf`)**: `init`, `pull`, `push`, and `reference`
    accept `--format okf` to read/write an
    [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
    bundle — a directory of single-`.md` concepts (YAML frontmatter + body) with
    reserved `index.md` listings, rooted at `bundle/` instead of `catalog/`.
    `init --format okf` records `layout: okf` in the manifest so later commands
    default to it. The full entry is preserved under a hidden `x-kcmd`
    frontmatter key for lossless round-trip (consumers ignore unknown keys per
    SPEC), and per-folder `index` entries are synthesized from the directory
    tree on `push` so the catalog hierarchy is recreated — synthesis is skipped
    for ingested sources (e.g. BigQuery `@bigquery` system entries), where
    `index.md` stays navigation-only.

## Usage

### 1. Initialization (`kcmd init`)
The initialization flag defines the **Mode** (Source Type) of your workspace. This selection is mandatory and determines how `kcmd` communicates with GCP and how files are structured locally. You must choose **exactly one** primary source type.

Source Type (Mode) | CLI Flag              | Required ID Format                            | Target Resource & Layout
:----------------- | :-------------------- | :-------------------------------------------- | :-----------------------
**BigQuery**       | `--bigquery-dataset`  | `my-project-id.my-dataset-id`                 | Manages tables, views, and schemas (**YAML** Layout).
**Knowledge Base** | `--kb`                | `my-project-id.my-location.my-entry-group-id` | Manages human-authored Wiki/Doc content (**Markdown** Layout).
**Entry Group**    | `--entry-group`       | `my-project-id.my-location.my-entry-group-id` | Manages custom or user-defined catalog entries (**YAML** Layout).
**BigLake**        | `--biglake-namespace` | `my-project-id.my-catalog-id.my-namespace-id` | Manages Iceberg/BigLake table metadata (**YAML** Layout).
**Glossary**       | `--glossary`          | `my-project-id.my-location.my-glossary-id`    | Manages a Business Glossary — terms and categories under `catalog/glossaries/` (**YAML** Layout).

**Note on BigQuery:** While you must pick one mode, the BigQuery mode allows you to specify multiple datasets by repeating the flag (e.g., `--bigquery-dataset ds1 --bigquery-dataset ds2`).

**Note on Glossary:** The glossary scope is flexible — you can specify one or
more glossaries by ID or display name in a single `--glossary` flag using a
comma-separated list, or omit the glossary ID entirely to operate in "location
mode":

*   **By ID (single or multiple)**: `--glossary
    my-project.us-central1.glossary-a,glossary-b`
*   **By display name (exact match)**: `--glossary my-project.us-central1.My
    Business Glossary` (falls back from ID lookup automatically)
*   **Location mode** (all glossaries in a location): `--glossary
    my-project.us-central1`

**Examples:**

```bash
# Data Mode: Initialize with one or more BigQuery datasets
kcmd init --bigquery-dataset my-project-id.my-dataset-id

# Wiki Mode: Initialize a human-authored Knowledge Base (uses .md files)
kcmd init --kb my-project-id.us-central1.my-knowledge-base-id

# BigLake Mode: Requires the --iceberg flag
kcmd init --biglake-namespace my-project-id.my-catalog-id.my-namespace-id --iceberg

# Glossary Mode: Initialize a workspace rooted at a Business Glossary
kcmd init --glossary my-project-id.us-central1.my-glossary-id

# Glossary Mode: Multiple glossaries (comma-separated, in the same project/location)
kcmd init --glossary my-project-id.us-central1.glossary-a,glossary-b

# Glossary Mode: Location mode — all glossaries in a given location
kcmd init --glossary my-project-id.us-central1
```

**Note on layout (`--format`):** Independently of the source type, `init`,
`pull`, `push`, and `reference` accept `--format <standard|documents|okf>` to
override the on-disk layout. `--format okf` reads/writes an **OKF** bundle under
`bundle/` (instead of `catalog/`); `init --format okf` records `layout: okf` in
`catalog.yaml` so subsequent commands default to it. See **OKF Layout** under
Directory Layout below.

```bash
# Initialize an Entry Group workspace that stores an OKF bundle under bundle/
kcmd init --entry-group my-project-id.us-central1.my-eg-id --format okf
```

### 2. Synchronization

#### Pulling Metadata

*   **`kcmd pull`**: Downloads editable metadata into the `catalog/` directory.
    *   Generates `.yaml` files in **YAML** mode or `.md` files in **Markdown** mode.
    *   With `--format okf` (or `layout: okf` in the manifest), writes the **OKF
        Layout** under `bundle/` instead — one `.md` per concept — and
        regenerates the reserved `index.md` listings after the pull.
    *   **Entry Links**: When `snapshot.entryLinks` is declared, `pull` also
        calls `lookupEntryLinks` for every fetched entry and inlines the results
        into the entry YAML — column-level links (those with a `Schema.<field>`
        source path) land under `aspects.schema.fields[].links`, others under
        the top-level `links` block. Omit `snapshot.entryLinks` to skip the link
        fetch entirely.
*   **`kcmd reference`**: Downloads read-only reference data defined in the
    `reference:` block of your manifest.
    *   Generates **`.ref.yaml`** files as siblings to your editable files. These are used for grounding and are never pushed.
    *   Honors `reference.snapshot.entryLinks` the same way as `pull` honors
        `snapshot.entryLinks`, so a `.ref.yaml` baseline can include the
        pre-edit link state for clean `diff`s.
    *   Under `--format okf` the read-only mirror is written as `.ref.md`
        siblings in `bundle/` (the OKF reference layer).

#### Pushing Changes

*   **`kcmd push`**: Uploads local edits from `catalog/` to the Catalog service.
    *   **Skip Reference Layers**: Files ending in `.ref.yaml` are strictly read-only and **skipped** during push.
    *   **Auto-Creation**: If an entry (or its parent Entry Group) does not exist in the service, `kcmd` will attempt to create it using parameters derived from your local workspace:
        *   **Project & Location**: Derived from the workspace context.
        *   **Entry Group**: Determined by your workspace mode (e.g., `@bigquery` for BigQuery mode, or your custom ID for Knowledge Base/Entry Group modes).
        *   **Entry ID**: Derived from your local file path. For example, a file at `catalog/bigquery/my-project/my-dataset/my-new-table.yaml` will result in an **Entry ID** of `bigquery.googleapis.com/projects/my-project/datasets/my-dataset/tables/my-new-table`.
    *   **Entry Link Reconciliation**: When `publishing.entryLinks` is declared,
        `push` reconciles local vs remote `EntryLink` resources of those types
        per entry. Matching is symmetrical and project ID/Number agnostic
        (`@dataplex` proxy unwrapped, both sides normalized to project ID before
        comparison), so unchanged links are preserved (no delete-then-create).
        New local links are created; remote links of the configured types with
        no local match are deleted. Omit (or leave empty)
        `publishing.entryLinks` to disable link mutations entirely — useful when
        a workspace only reads links.
    *   `--force`: Overwrites service metadata, ignoring potential conflicts.
    *   `--validate-only`: Validates the local snapshot against the service without performing a push.
    *   `--format okf`: Reads the **OKF Layout** from `bundle/`, reconstructing
        each entry from its `x-kcmd` frontmatter. Per-folder `index` entries are
        synthesized from the directory tree (so the hierarchy is recreated),
        except for ingested sources (e.g. `@bigquery`), which can't hold custom
        entries.

> [!IMPORTANT] **`kcmd push` does NOT create Glossary, GlossaryCategory, or
> GlossaryTerm resources.**
>
> These three resource kinds are Dataplex **control-plane** resources — they
> govern catalog *structure* (which terms are sanctioned business vocabulary,
> how the vocabulary is organized) rather than describing data assets. Their
> lifecycle is intentionally controlled by humans: a glossary should reflect a
> deliberate governance decision, not appear as a side effect of an enrichment
> agent's run.
>
> Concretely: * A missing `Glossary`, `GlossaryCategory`, or `GlossaryTerm`
> referenced by your local snapshot causes `kcmd push` to fail fast with a clear
> error pointing at the missing resource. * To use a glossary, **create the
> glossary (and any categories/terms you need) yourself first** — via the
> Dataplex console or `gcloud dataplex glossaries create …` / `gcloud dataplex
> glossary-terms create …` — then run `kcmd pull` followed by `kcmd push` to
> manage metadata (e.g., descriptions, labels) on the existing resources. *
> `kcmd push` **is allowed to update** the description, labels, and other
> metadata of an *already-existing* glossary/category/term. This update path is
> the only mutation kcmd performs against the glossary hierarchy; it never adds
> or removes a node. * EntryLinks that *reference* glossary terms (e.g.,
> `definition` links from a BQ column to a term) are catalog metadata and ARE
> created/deleted normally by `kcmd push` — the no-create rule applies only to
> the glossary tree itself, not to the relationships pointing at it.
>
> If your workflow needs to bootstrap an empty glossary, do it once out-of-band
> and treat the result as a stable input to `kcmd`.

### 3. AI Agent Integration (MCP)
To use `kcmd` as a Model Context Protocol (MCP) server for agents like the Gemini CLI:

```json
{
  "mcpServers": {
    "kcmd": {
      "command": "npx",
      "args": ["-y", "kcmd", "mcp", "--path", "/absolute/path/to/workspace"]
    }
  }
}
```

The server provides tools like `list-entries`, `lookup-entry`, and `modify-entry` for automated context engineering and metadata enrichment.

### 4. Authentication
The CLI and MCP server use `gcloud` to obtain authentication tokens. Ensure you are authenticated:

```bash
gcloud auth application-default login
```

## Metadata Artifacts

### Directory Layout

`kcmd` organizes metadata based on the resource hierarchy. Each entry (e.g., a table) is managed as a standalone YAML file, potentially with a Markdown sidecar for long-form content.

#### YAML Layout (Data Assets)
Entries are files named `<entry-id>.yaml`. Sidecars use the format `<entry-id>.<aspect-alias>.md`. Reference layers co-exist as `*.ref.yaml` files.

```text
/
├── catalog.yaml
└── catalog/
    └── bigquery/
        └── my-project-id/
            ├── my-dataset-id.yaml      # Dataset entry file
            └── my-dataset-id/          # Directory for entries within this dataset
                ├── table1.yaml         # Table 1 entry file (editable)
                ├── table1.ref.yaml     # Table 1 reference layer (read-only system metadata)
                ├── table2.yaml         # Table 2 entry file
                └── table2.overview.md  # Sidecar for table2's overview aspect
```

#### Markdown Layout (Knowledge Base)
Entries are `.md` files containing both metadata and content.

```text
/
├── catalog.yaml
└── catalog/
    └── my-namespace/
        └── my-project-id/
            └── my-location-id/
                ├── page1.md            # Page 1 (Frontmatter + Markdown)
                └── page2.md            # Page 2
```

#### OKF Layout (Bundle)

With `--format okf`, each concept is a single `.md` file (YAML frontmatter +
overview body) rooted at **`bundle/`** instead of `catalog/`. Reserved
`index.md` files list each directory's children; only the bundle-root `index.md`
carries `okf_version`. Read-only reference mirrors are `*.ref.md`.

```text
/
├── catalog.yaml                       # manifest (layout: okf)
└── bundle/
    ├── index.md                       # root listing (carries okf_version)
    └── bigquery/
        └── my-project-id/
            └── my-dataset-id/
                ├── index.md           # directory listing (no frontmatter)
                ├── table1.md          # concept: frontmatter + overview body
                └── table1.ref.md      # read-only reference mirror
```

The full Dataplex entry (all aspects, links, `resource.parent`) is preserved
under a hidden `x-kcmd` frontmatter key so the bundle round-trips losslessly;
OKF consumers ignore the unknown key. Files authored without `x-kcmd` (hand-
written OKF) still load, reconstructed from the SPEC frontmatter fields.

## Catalog Manifest (`catalog.yaml`)

The manifest defines the synchronization scope, the types of metadata to manage, and optional reference layers for grounding.
### Example Manifest

```yaml
# The primary resource(s) to manage. Format: <mode-id>.<project-id>.<resource-id>
scope: bigquery-mode-id.my-project-id.my-dataset-id

# Defines which entry, aspect, and link types are managed locally.
snapshot:
  entries:
    - dataplex-types.global.bigquery-table
  aspects:
    - dataplex-types.global.schema
    - dataplex-types.global.bigquery-table
    - dataplex-types.global.storage
    - dataplex-types.global.overview
  entryLinks:
    - definition          # system alias: dataplex-types.global.definition
    - synonym

# Defines which aspects and links are pushed back to the service.
publishing:
  aspects:
    - dataplex-types.global.overview
  entryLinks:
    - definition          # delete remote links of this type that aren't present locally; create new local ones

# Optional: pull read-only metadata for grounding (never pushed).
reference:
  scope: bq-dataset.my-project-id.my-dataset-id
  snapshot:
    entries:
      - dataplex-types.global.bigquery-table
    aspects:
      - dataplex-types.global.schema
      - dataplex-types.global.overview
    entryLinks:
      - definition        # include pre-edit links in .ref.yaml so diffs surface only the changes
      - synonym
```

*   **`scope`** — The "Source of Truth" for your workspace. It defines which GCP
    resources `kcmd` connects to for pulling metadata and where it deploys
    changes during a push. It also determines the directory hierarchy within
    your `catalog/` folder. Supported types include `bq-dataset.*`,
    `entryGroup.*`, `kb.*`, `biglake-namespace.*`, and
    `glossary.<project>.<location>.<glossary-id>`.
*   **`layout`** (optional) — overrides the on-disk layout (`standard` |
    `documents` | `okf`); normally derived from the source type. Written by
    `init --format` and honored by `--format` on the other commands. `okf` roots
    the workspace at `bundle/` and stores one `.md` per concept (see **OKF
    Layout** above).
*   **`snapshot`** — The entry, aspect, and link types to manage locally.
    *   `entryLinks` (optional) — short aliases (`definition`, `synonym`,
        `related`, `schema-join`) or fully-qualified link type refs. When set,
        `pull` calls `lookupEntryLinks` for every pulled entry and routes
        results into the entry YAML (top-level `links` for entry-level links,
        `aspects.schema.fields[].links` for column-level links carrying a
        `Schema.<field>` path). Omit to skip link sync entirely.
*   **`publishing`** — The subset of aspects `kcmd push` writes back to the
    catalog.
    *   `entryLinks` (optional) — must be a subset of `snapshot.entryLinks`. On
        `push`, the engine compares local vs remote links of these types (after
        unwrapping `@dataplex` proxies and normalizing project IDs) and
        reconciles: existing matches are kept, missing-remote links are created,
        missing-local links are deleted. Omit (or leave empty) to skip link
        mutations entirely — useful when you want to read links without taking
        responsibility for them.
*   **`reference`** — A read-only resource to pull as a reference layer (saved
    as `*.ref.yaml`).
    *   `reference.snapshot.entryLinks` (optional) — when present, `.ref.yaml`
        files include the pre-edit link state, so diffing live `.yaml` vs
        `.ref.yaml` surfaces only what your enrichment added or removed.

## Entry Artifacts

### Standard Entry (YAML)

**catalog/bigquery/my-project-id/my-dataset-id/my-table-id.yaml**

```yaml
name: bigquery/my-project-id/my-dataset-id/my-table-id
type: dataplex-types.global.bigquery-table

resource:
  name: projects/my-project-id/datasets/my-dataset-id/tables/my-table-id
  displayName: my-table-id
  description: A descriptive summary of this table
  labels:
    env: prod
  location: us-central1
  ancestors:
    - name: projects/my-project-id/datasets/my-dataset-id
      type: dataplex-types.global.bigquery-dataset
  createTime: 2024-09-18 00:01:34.230000+00:00
  updateTime: 2024-10-23 22:55:17.063000+00:00

aspects:
  schema:
    fields:
      - name: my-column
        dataType: STRING
        metadataType: STRING
        mode: NULLABLE
  storage:
    service: BIGQUERY
    resourceName: //bigquery.googleapis.com/projects/my-project-id/datasets/my-dataset-id/tables/my-table-id

category: miscellaneous
```

### Document Entry (Markdown)

**catalog/my-namespace/my-project-id/my-location-id/my-page-id.md**

```markdown
---
type: dataplex-types.global.entry
title: My Page Title
catalogEntry:
  id: my-page-id
  resource:
    name: projects/my-project-id/locations/my-location-id/entryGroups/my-eg-id/entries/my-page-id
---
# Welcome to My Knowledge Base Page
This is the human-authored content of the page.
```

### Entry with EntryLinks

Column-level links live under `aspects.schema.fields[].links` and are produced
automatically when the link's source reference carries a `Schema.<field>` path
on `pull`. Entry-level links (no `Schema.<field>` path) appear at the top level
under `links`. The `target` value is the human-readable
`<project>.<location>.<glossary-display-name>.<term-display-name>` form, and the
full UID resource path is preserved in `id` so `push` can reconstruct the exact
catalog reference.

**catalog/bigquery/my-project-id/my-dataset-id/orders.yaml** (excerpt)

```yaml
aspects:
  schema:
    fields:
      - name: customer_id
        dataType: STRING
        mode: NULLABLE
        links:
          definition:
            - target: my-project-id.global.business-glossary.customer-id
              id: projects/my-project-id/locations/global/glossaries/biz/terms/customer-id
      - name: total_amount
        dataType: NUMERIC
        mode: NULLABLE
        links:
          definition:
            - target: my-project-id.global.business-glossary.transaction-amount
              id: projects/my-project-id/locations/global/glossaries/biz/terms/transaction-amount

# Top-level links (entry-level relationships without a column path)
links:
  related:
    - target: my-other-project.us.docs-eg.runbook-page
```

### Glossary Term (YAML)

When the workspace `scope` is `glossary.<project>.<location>.<glossary-id>`, the
local hierarchy mirrors the glossary's "glossary → category → term" tree.

**catalog/glossaries/Business Glossary (biz)/terms/customer-id.yaml**

```yaml
name: glossaries/Business Glossary (biz)/terms/customer-id
type: glossaryTerm
displayName: customer-id
description: Unique identifier for a customer record.
parent: projects/my-project-id/locations/global/glossaries/biz
```

## Developer Workflow

### Setup

```bash
git clone https://github.com/googlecloudplatform/knowledge-catalog
cd agents/mdcode
npm install
```

### Build & Test

```bash
npm run build
npm run test
```
