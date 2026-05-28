# Enrichment Agent

The enrichment agent for Knowledge Catalog provides a customizable agentic
workflow for extracting information from various sources to build metadata
about data assets, which can then be used as context.

## Usage

### Prerequisites

The enrichment agent depends on the [Metadata as Code](../mdcode/README.md) capability.
Follow the instructions on that page on using the `kcmd` tool.

### CLI

The package provides the `kcenrich` CLI tool. This is distributed as a standalone binary.

```bash
# Initialize a new catalog snapshot for a bigquery dataset
kcmd init --bigquery-dataset <projectId>.<datasetId>

# Pull the latest catalog snapshot from the Knowledge Catalog service
kcmd pull

# Run the enrichment tool
kcagent enrich --catalog-path . --tools-path tools --prompt-path prompt.md
```

## Developer Workflow

### Setup

```bash
git clone https://github.com/googlecloudplatform/knowledge-catalog
cd toolbox/enrichment
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

### Demo

The repository contains a self-contained demo. Running the demo involves creating a BigQuery dataset and a Dataplex EntryGroup within your cloud project.

**Initialize Environment**
```bash
export DEMO_CLOUD_PROJECT="<your-gcp-project-id>"
```

**Initialize gcloud**
```bash
gcloud auth application-default login
gcloud config set project $DEMO_CLOUD_PROJECT
gcloud config set compute/region us
```

**Setup demo resources**
```bash
bq query --use_legacy_sql=false <<EOF
CREATE SCHEMA IF NOT EXISTS \`${DEMO_CLOUD_PROJECT}.demo_ecommerce\`
OPTIONS (
  location = 'US',
  labels = [('usage', 'demo')]
);

CREATE TABLE IF NOT EXISTS \`${DEMO_CLOUD_PROJECT}.demo_ecommerce.events\`
PARTITION BY event_date_dt
AS
SELECT
  *,
  PARSE_DATE('%Y%m%d', event_date) AS event_date_dt
FROM
  \`bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*\`;
EOF
```

**Create and populate a catalog snapshot**
```bash
mkdir -p demo
cd demo
cat <<EOF > catalog.yaml
scope: bq-dataset.${DEMO_CLOUD_PROJECT}.demo_ecommerce

snapshot:
  entries:
    - dataplex-types.global.bigquery-dataset
    - dataplex-types.global.bigquery-table
  aspects:
    - dataplex-types.global.overview
EOF

../../mdcode/dist/kcmd pull
```

**Create and populate the tools**
```bash
cat <<EOF > prompt.md
Enrich the documentation of the assets using the internal organizational information.
Use the following sources:

* Fileset source
EOF
```
```bash
mkdir tools
cat <<EOF > tools/mcp.json
{
  "mcpServers": {
    "md-fileset": {
      "command": "../dist/md-fileset",
      "args": [ "--dir", "fileset" ]
    }
  }
}
EOF
```

```bash
mkdir -p tools/skills/fileset-source
cat <<EOF > tools/skills/fileset-source/SKILL.md
---
name: fileset-source
description: >
  Use the fileset source to find relevant markdown documents and extract information
  about assets.
---

The `md-fileset` mcp server provides the following tools to extract relevant
information from a directory hierarchy of markdown files:

* **list_fileset_contents** - browse and navigate the directory tree to list the
  contents of the specified path. The items may be files or sub-directories.

* **read_fileset_file** - read the contents of a file in the knowledge base. The entire
  contents are provided. Extract and summarise the relevant information based on
  the documentation being generated..

* **search_fileset_content** - searches the knowledge base and returns the matching files,
  along with matching line numbers and line snippets. This can be used to quickly
  find matches without having to list and read all files.

To work with a fileset effectively create search queries (use simple keyword queries
with individual tokens) to find relevant files, and then read the files to find relevant information. If one query does not work, try a few other keywords.
EOF
```

**Add Docs**  
Copy over the individual markdown files from [here](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/1e97103cdbf7e6425113a73304029ddb4f1f3a6b/samples/enrichment/sample/docs) into the `fileset/` directory

**Enrich the metadata**
```bash
../dist/kcagent enrich --catalog-path . --tools-path tools --prompt-path prompt.md
```

**Clean up**
```bash
bq rm -r ${DEMO_CLOUD_PROJECT}:demo-dataset
```
