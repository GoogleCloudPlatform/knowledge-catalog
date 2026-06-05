# Metadata as Code

Metadata as Code is a Knowledge Catalog (Dataplex) provides data stewards and data producers and AI agents with a source code artifact-based UX for metadata management and context engineering.

Users and agents can author, manage, and enrich metadata artifacts using developer-friendly workflows with version control and CI/CD. It provides a standard metadata format can be used by a variety of tools and agents.

More details are in the [docs/concept.md](docs/concept.md).

## Key Features

* Intuitive human and agent-friendly representation of metadata as source code in YAML and markdown files. Artifacts are organized in a hierarchical manner mirroring the resource hierarchy of data and metadata assets.
* Bi-directional sync between local workspace and catalog service (`pull` / `push`).
* **Context overlay via `reference`** — pull read-only first-party (1P) entries (schema, descriptions) into a separate `reference/` directory so agents/users can ground enrichment on authoritative metadata without permission to edit those 1P entries.
* **Resource aliases** — short, friendly aspect keys (`schema`, `bigquery-table`, `storage`, …) instead of fully-qualified type names, with sensible predefined aliases for GCP-managed (1P) aspects.
* **Markdown sidecars** — keep large unstructured aspect content (e.g. an `overview`) in a `<entry>.<aspect>.md` file next to the entry YAML.
* **Source types** — BigQuery datasets, Dataplex EntryGroups, Knowledge Base EntryGroups, and BigLake/Iceberg namespaces.
* Support for both 1st party and 3rd party metadata constructs.
* Distributed as a TypeScript and Python library, a CLI tool (`kcmd`), and an MCP server for use in a variety of applications, agents and workflows.

## What's New

* **`kcmd reference`** — an `init`+`pull` for a *read-only* reference resource, driven by a `reference:` block in `catalog.yaml`. Pulls the referenced entries/aspects into `reference/` (never pushed). Ideal for agent enrichment: ground the editable context entries on the live 1P schema/description. Re-run any time to refresh (acts like a `pull --force` for the reference layer).
* **Resource aliases** — entries pulled from the catalog now use short alias aspect keys by default (e.g. `schema:` rather than `dataplex-types.global.schema:`). Define your own under `aliases:` in the manifest; predefined GCP-managed aliases (`bigquery-dataset`, `bigquery-table`, `schema`, `storage`) cannot be re-used. Both short alias keys and fully-qualified type names are accepted on `push`.
* **Markdown sidecars in the standard layout** — `<entry>.<aspect>.md` files are merged into the entry's aspect on `push` and emitted on `pull`.
* **BigLake / Iceberg** — `kcmd init --biglake-namespace <project>.<catalog>.<namespace> --iceberg`.

## Metadata Artifacts

### Directory Layout
Metadata is organized within a directory representing a resource such as a BigQuery Dataset, Dataplex EntryGroup etc.

```
path/to/root/
├── catalog.yaml                       # Manifest and config directives
├── catalog/                           # The editable metadata snapshot (pushable)
│   └── <dir1>/
│       └── <entry-id1>.yaml           # Entry
│       └── <dir2>/
│           ├── <entry-id2>.yaml       # Entry with sidecar markdown
│           └── <entry-id2>.overview.md  #   (an <entry>.<aspect>.md sidecar)
└── reference/                         # Read-only 1P reference entries (pulled by
    └── <proj>.<dataset>/              #   `kcmd reference`; NEVER pushed)
        └── <table>.yaml
```

## Catalog Snapshot Files

### Manifest File
**catalog/catalog.yaml**
```yaml
scope: bq-dataset.prod-data.ecommerce

aliases:
  ca-guidelines:
    aspect: data-agents-project.global.ca-guidelines
  ecommerce:
    aspect: data-agents-project.global.ecommerce

snapshot:
  entries:
    - bigquery-table
    - bigquery-view
    - entry-group
  aspects:
    - overview
    - descriptions

publishing:
  aspects:
    - overview
    - descriptions

# Optional: pull read-only 1P entries into reference/ for grounding (no publishing).
reference:
  scope: bq-dataset.prod-data.ecommerce
  snapshot:
    entries:
      - bigquery-table
    aspects:
      - schema
```

* **`scope`** — the resource this workspace manages (`bq-dataset.<proj>.<dataset>`, `entry-group.<proj>.<loc>.<id>`, `kb.<proj>.<loc>.<id>`, or a BigLake namespace).
* **`aliases`** — your own short names mapping `alias -> { aspect: <fully-qualified type> }`. Predefined GCP-managed aliases (`bigquery-dataset`, `bigquery-table`, `schema`, `storage`) are reserved.
* **`snapshot`** — the entry + aspect types present locally.
* **`publishing`** — the subset of aspects `kcmd push` writes back to the catalog.
* **`reference`** (optional) — a *read-only* resource to pull into `reference/` (its own `scope` + `snapshot`; **no** `publishing`). Populated by `kcmd reference`.

## Entry YAML File
**catalog/prod-data.ecommerce/products.yaml**
```yaml
id: products
type: bigquery-table

resource:
  name: projects/prod-data/datasets/ecommerce/tables/products
  displayName: Products Table
  description: All products in the catalog
  labels:
    env: prod
  createTime: 2026-04-23T00:44:03Z
  updateTime: 2026-04-23T00:44:03Z

schema:
  ...

contacts:
  ...
```

## Entry Sidecar Markdown File
**catalog/prod-data.ecommerce/products.overview.md**

```markdown
---
userManaged: true
links:
  ...
---
[overview.content]
```

## Usage

### Library

You can use the `kcmd` library to programmatically interact with the catalog metadata.

```bash
npm install kcmd
```

```typescript
import * as kcmd from 'kcmd';

// Creating a catalog manifest from scratch
const manifest = new kcmd.CatalogManifest(...);
manifest.save('/path/to/root');

// Loading a catalog snapshot from the filesystem
const snapshot = kcmd.CatalogSnapshot.fromPath('/path/to/root');

// Pulling the latest metadata from the Catalog service.
const pullResult = await snapshot.pull();
if (pullResult.success) {
  console.log('Metadata pulled successfully');
}
else {
  console.error('Metadata pull failed:', pullResult.error);
}

// Pushing the modified metadata to the Catalog service.
const pushResult = await snapshot.push();
if (pushResult.success) {
  console.log('Metadata pushed successfully');
}
else {
  console.error('Metadata push failed:', pushResult.error);
}
```

### CLI

The package provides the `kcmd` CLI tool. This is distributed as a standalone binary.

```bash
# Initialize a new catalog snapshot for a bigquery dataset
kcmd init --bigquery-dataset <projectId>.<datasetId>

# Initialize a new catalog snapshot for multiple bigquery datasets
kcmd init --bigquery-dataset <projectId>.<datasetId1> --bigquery-dataset <projectId>.<datasetId2>

# Initialize a new catalog snapshot for a bigquery dataset with specific types
kcmd init --bigquery-dataset <projectId>.<datasetId> \
  --entry bigquery-table --entry bigquery-view \
  --aspect overview --aspect description

# Initialize a new catalog snapshot for a custom EntryGroup
kcmd init --entry-group <projectId>.<locationId>.<entryGroupId>

# Initialize a new catalog snapshot for a Knowledge Base EntryGroup
kcmd init --kb <projectId>.<locationId>.<entryGroupId>

# Initialize a new catalog snapshot for a BigLake (Iceberg) namespace
kcmd init --biglake-namespace <projectId>.<catalogId>.<namespaceId> --iceberg

# Pull the latest catalog snapshot from the Knowledge Catalog service
# Reports any conflicts if there are pending changes that have not been
# pushed to the catalog.
# Supports dry run with the --dry-run flag.
kcmd pull

# Pull read-only reference entries (the `reference:` block in catalog.yaml) into
# reference/. These ground enrichment on the live 1P metadata and are never
# pushed. Re-run any time to refresh.
kcmd reference

# Check for local modifications
kcmd status

# Push local changes to the Knowledge Catalog service. Only pushes changes
# made since the last pull, and if that metadata has not been modified within
# catalog in the interim.
# Supports dry run with the --dry-run flag.
kcmd push
```

NOTE: The CLI uses `gcloud` to obtain authentication tokens, so ensure you are authenticated via `gcloud auth application-default login`.

### MCP Server

To use the Metadata as Code tools as MCP tools in an agentic system such as the Gemini CLI, add the following to your MCP settings file:

```json
{
  "mcpServers": {
    "kc-mac": {
      "command": "kcmd",
      "args": ["mcp", "--path", "/path/to/root"]
    }
  }
}
```

The server offers the following tools: 

| Tool             | Description                                           |
|------------------|-------------------------------------------------------|
| pull             | Pull the latest metadata from the Catalog service     |
| push             | Push the modified metadata to the Catalog service     |
| list-entries     | List entries in the catalog snapshot                  |
| lookup-entry     | Lookup an entry and its metadata from the snapshot    |
| modify-entry     | Modify an entry and its metadata in the snapshot      |

NOTE: The server uses `gcloud` to obtain authentication tokens, so ensure you are authenticated via `gcloud auth application-default login`.

## Developer Workflow

### Setup

```bash
git clone https://github.com/googlecloudplatform/knowledge-catalog
cd toolbox/mdcode
npm install
```

### Build

```bash
npm run build
```

### Test

```bash
npm run test
```
