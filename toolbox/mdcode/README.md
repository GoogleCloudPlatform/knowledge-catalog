# Metadata as Code

Metadata as Code is a Knowledge Catalog (Dataplex) provides data stewards and data producers and AI agents with a source code artifact-based UX for metadata management and context engineering.

Users and agents can author, manage, and enrich metadata artifacts using developer-friendly workflows with version control and CI/CD. It provides a standard metadata format can be used by a variety of tools and agents.

More details are in the [docs/concept.md](docs/concept.md).

## Key Features

* Intuitive human and agent-friendly representation of metadata as source code in YAML and markdown files. Artifacts are organized in a hierarchical manner mirroring the resource hierarchy of data and metadata assets.
* Bi-directional sync between local workspace and catalog service.
* Support for both 1st party and 3rd party metadata constructs.
* Distributed as a TypeScript and Python libraries, a CLI tool (kcmd), and an MCP server for use in a variety of applications, agents and workflows.

## Metadata Artifacts

### Directory Layout
Metadata is organized within a directory representing a resource such as a BigQuery Dataset, Dataplex EntryGroup etc.

```
path/to/root/
├── catalog.yaml                       # Manifest and config directives
└── catalog/                           # Contains the metadata snapshot
    └── <dir1>/
        └── <entry-id1>.yaml           # Entry
        └── <dir2>/
            ├── <entry-id2>.yaml       # Entry with sidecar markdown
            └── <entry-id2>.aspect.md  # files
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
    - dataplex-types.global.bigquery-dataset
    - dataplex-types.global.bigquery-table
    - dataplex-types.global.bigquery-view
  aspects:
    - dataplex-types.global.overview
    - dataplex-types.global.descriptions

publishing:
  aspects:
    - dataplex-types.global.overview
    - dataplex-types.global.descriptions
```

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

You can use the `@google-cloud/kcmd` library to programmatically interact with the catalog metadata.

```bash
npm install @google-cloud/kcmd
```

```typescript
import * as kcmd from '@google-cloud/kcmd';

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

The package provides the `kcmd` CLI tool, which runs on Node.js 22.12 or later.

```bash
# Initialize a new catalog snapshot for a bigquery dataset
kcmd init --bigquery-dataset <projectId>.<datasetId>

# Initialize a new catalog snapshot for multiple bigquery datasets
kcmd init --bigquery-dataset <projectId>.<datasetId1> --bigquery-dataset <projectId>.<datasetId2>

# Initialize a new catalog snapshot for a custom EntryGroup
kcmd init --entry-group <projectId>.<locationId>.<entryGroupId>

# Initialize an OKF workspace for an EntryGroup (or --kb): the entries are kept
# as an Open Knowledge Format bundle under bundle/, with entry links in
# bundle/_links.yaml. init records `layout: okf` in catalog.yaml, and pull and
# push read it, so they take no flag. The entry group may not exist yet;
# `kcmd push` creates it as a context set.
kcmd init --entry-group <projectId>.<locationId>.<entryGroupId> --format okf

# For a scope backed by an entry group (entryGroup, kb, semantic-model), in any
# layout, the context set's display name and description live in catalog.yaml
# as `displayName:` and `description:`:
# - Pull sets both from the entry group, keeping every other key and comment; a
#   value the entry group does not set removes its key.
# - Push writes only the keys whose values differ from the entry group, after
#   the entries and any graph deploys, so the last write wins. An absent key,
#   or one with no value, is not managed; `description: ""` clears the
#   description, and an empty value stays in the file after a pull.
# - Write a multi-line description with `>-`: `|` keeps a trailing newline,
#   which push would send to Knowledge Catalog.
# - The description holds at most 1,024 characters and the display name 256;
#   push fails before any write when a value is longer.

# Pull the latest catalog snapshot from the Knowledge Catalog service
# Reports any conflicts if there are pending changes that have not been
# pushed to the catalog.
# Supports dry run with the --dry-run flag.
# Pull fetches the aspects each entry's type requires. To pull only some entry
# types, or other aspects, list them as project.location.type under
# snapshot.entries and snapshot.aspects in catalog.yaml.
# kcmd init lists dataplex-types.global.overview under snapshot.aspects for
# knowledge base, entry group and BigQuery dataset scopes.
kcmd pull

# Check for local modifications
kcmd status

# Push local changes to the Knowledge Catalog service. Only pushes changes
# made since the last pull, and if that metadata has not been modified within
# catalog in the interim.
# Supports dry run with the --dry-run flag.
kcmd push
```

NOTE: The CLI uses `gcloud` to obtain authentication tokens, so ensure you are authenticated via `gcloud auth application-default login`.

#### Environment variables

An optional variable overrides where `kcmd` talks to the catalog. It defaults to
production, so you normally leave it unset.

| Variable | Effect |
|----------|--------|
| `DATAPLEX_ENDPOINT` | Base URL for the Knowledge Catalog (Dataplex) API. Defaults to `https://dataplex.googleapis.com`. Set it to reach a non-prod host. |

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
