# Demo

## Configuration

You will need a cloud project with permissions to use BigQuery and Knowledge
Catalog APIs.

```bash
export DEMO_CLOUD_PROJECT=<GCP_PROJECT_ID>
```

Ensure that gcloud is installed and configured.

```bash
gcloud auth application-default login
gcloud config set compute/region us-central1
gcloud config set project $DEMO_CLOUD_PROJECT
```

## BigQuery Dataset

This demo demonstrates working with metadata for BigQuery resources (dataset and
table).

**Setup**

*   Creates a BigQuery dataset (`demo_ecommerce`) and a table (`events`) based
    on BigQuery sample data in your cloud project.
*   Creates a `catalog.yaml` manifest to specify the local catalog snapshot.

```bash
bun setup.ts
cat catalog.yaml
```

**Create Metadata Snapshot**

*   Pull metadata from Knowledge Catalog

```bash
../../dist/kcmd pull
ls -R catalog
cat catalog/$DEMO_CLOUD_PROJECT.demo_ecommerce.yaml
```

**Modify Metadata Snapshot**

*   Either manually edit the file, or use the following command which adds a
    dummy overview aspect.

```bash
bun update.ts catalog/$DEMO_CLOUD_PROJECT.demo_ecommerce.yaml
cat catalog/$DEMO_CLOUD_PROJECT.demo_ecommerce.yaml
```

**Publish Metadata Snapshot**

*   Push metadata to Knowledge Catalog

```bash
../../dist/kcmd push
```

**Cleanup**

*   Deletes the BigQuery resources created for the demo

```bash
bun cleanup.ts
```

## Knowledge Base

This demo demonstrates working with a Knowledge Base managed in Knowledge
Catalog.

**Setup**

*   Creates a Dataplex EntryGroup (`demo_kb`) and a set of document entries
    within it.
*   Creates a `catalog.yaml` manifest to specify the local catalog snapshot.

```bash
bun setup.ts
cat catalog.yaml
```

**Create Metadata Snapshot**

*   Pull metadata from Knowledge Catalog

```bash
../../dist/kcmd pull
ls -R catalog
cat catalog/index.md
```

**Modify Metadata Snapshot**

*   Either manually edit the file, or use the following command which creates a
    placeholder demo update to the content of the `index` entry using the `kcmd`
    (metadata as code) library.

```bash
bun update.ts
cat catalog/index.md
```

**Publish Metadata Snapshot**

*   Push metadata to Knowledge Catalog

```bash
../../dist/kcmd push
```

**Cleanup**

*   Deletes the Dataplex EntryGroup

```bash
bun cleanup.ts
```
