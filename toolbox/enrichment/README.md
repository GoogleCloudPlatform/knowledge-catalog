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
kcenrich catalog --path . --config-path ../demo
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
# Create a BigQuery dataset and table
bq mk ${DEMO_CLOUD_PROJECT}:demo-dataset
bq mk -t ${DEMO_CLOUD_PROJECT}:demo-dataset.demo-table name:string,value:string
```

**Create and populate a catalog snapshot**
```bash
mkdir -p catalog
cd catalog
kcmd init --bigquery-dataset ${DEMO_CLOUD_PROJECT}.demo-dataset
kcmd pull
```

**Enrich the metadata**
```bash
kcenrich catalog --path . --config-path ../config
```

**Clean up**
```bash
bq rm -r ${DEMO_CLOUD_PROJECT}:demo-dataset
```
