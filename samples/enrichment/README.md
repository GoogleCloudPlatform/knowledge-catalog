# Knowledge Catalog Enrichment Agent

## Overview

Knowledge Catalog manages metadata about data assets (such as BigQuery tables).
This metadata powers search, and agents to discover and understand data assets.

This sample demonstrates how external sources of information can be used to
augment the metadata in Knowledge Catalog, using an agentic approach. The
enrichment agent finds information relevant to a data asset, generates
documentation, and uses Knowledge Catalog APIs to publish the documentation
as enriched metadata.

Users can customize this enrichment agent with custom instructions, tools to
access sources of information within their organization, and skills to
describe the use of these tools.

## Running the Sample

### Setup
**Setup your environment**

This step clones the repository locally, configures various environment variables,
creates a python virtual environment and installs dependencies.

```bash
git clone https://github.com/googlecloudplatform/knowledge-catalog
cd samples/enrichment
```

Ensure you have the GCloud CLI installed and configured.

```bash
export CLOUD_PROJECT=<cloud-project-id>

gcloud auth application-default login
gcloud config set core/project $CLOUD_PROJECT
gcloud auth application-default set-quota-project $CLOUD_PROJECT
```

Setup a python environment
```bash
cd src
source env.sh --install
```

**Setup sample data**

The sample creates a sample BigQuery dataset in your project whose metadata is
curated.

```
python3 ../sample/data/create_data.py
```

### Enrichment Steps

You are now ready to run the enrichment workflow.

**Download a metadata snapshot**

```bash
python3 -m enrichment.download \
  --dir ../sample/metadata.initial \
  --dataset ${KC_ENRICH_SAMPLE_PROJECT}.kc_enrich_sample_data
```

**Enrich the metadata**

```bash
python3 -m enrichment.enrich \
  --dir ../sample/metadata.initial \
  --output-dir ../sample/metadata.new \
  --config-dir ../sample/config
```

**Review the metadata updates**

```bash
git diff --no-index \
  ../sample/metadata.initial ../sample/metadata.new
```

**Publish the updated metadata**

```bash
python3 -m enrichment.publish \
  --dir ../sample/metadata.new
```
