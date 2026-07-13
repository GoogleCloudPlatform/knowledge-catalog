# Demo

## Configuration

You will need a cloud project with permissions to use BigQuery and Knowledge Catalog APIs.

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

This demo demonstrates working with metadata for BigQuery resources (dataset and table).

**Setup**

* Creates a BigQuery dataset (`demo_ecommerce`) and a table (`events`) based on BigQuery
  sample data in your cloud project.
* Creates a `catalog.yaml` manifest to specify the local catalog snapshot.

```bash
bun setup.ts
cat catalog.yaml
```

**Create Metadata Snapshot**

* Pull metadata from Knowledge Catalog

```bash
../../dist/kcmd pull
ls -R catalog
cat catalog/$DEMO_CLOUD_PROJECT.demo_ecommerce.yaml
```

**Modify Metadata Snapshot**

* Either manually edit the file, or use the following command which adds a dummy
  overview aspect.

```bash
bun update.ts catalog/$DEMO_CLOUD_PROJECT.demo_ecommerce.yaml
cat catalog/$DEMO_CLOUD_PROJECT.demo_ecommerce.yaml
```

**Publish Metadata Snapshot**

* Push metadata to Knowledge Catalog

```bash
../../dist/kcmd push
```

**Cleanup**

* Deletes the BigQuery resources created for the demo

```bash
bun cleanup.ts
```

## Knowledge Base

This demo demonstrates working with a Knowledge Base managed in Knowledge Catalog.

**Setup**

* Creates a Dataplex EntryGroup (`demo_kb`) and a set of document entries within it.
* Creates a `catalog.yaml` manifest to specify the local catalog snapshot.

```bash
bun setup.ts
cat catalog.yaml
```

**Create Metadata Snapshot**

* Pull metadata from Knowledge Catalog

```bash
../../dist/kcmd pull
ls -R catalog
cat catalog/index.md
```

**Modify Metadata Snapshot**

* Either manually edit the file, or use the following command which creates a placeholder
  demo update to the content of the `index` entry using the `kcmd` (metadata as code)
  library.

```bash
bun update.ts
cat catalog/index.md
```

**Publish Metadata Snapshot**

* Push metadata to Knowledge Catalog

```bash
../../dist/kcmd push
```

**Cleanup**

* Deletes the Dataplex EntryGroup

```bash
bun cleanup.ts
```

## OKF Wiki

This demo demonstrates publishing an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
wiki bundle (a directory of markdown files with YAML frontmatter) into a
Knowledge Catalog EntryGroup via the Documents Layout. The bundle in
`okf/catalog/` is a GA4 sample with indexes, references, a dataset, and a
table, 14 markdown files in total. The Documents Layout maps each `.md`
file to an entry whose name is derived from the file path, with the
markdown body stored on the `dataplex-types.global.overview` aspect.

The generic Documents Layout only carries `title`/`description`/`tags` +
body. OKF's signal layer (`resource`, `type`, `generated`, `sources`) has
no generic home, so `push.ts`/`pull.ts` translate it into a custom typed
`okf` Dataplex aspect (created by `setup.ts`) and back, keeping the
on-disk files clean OKF and round-tripping the signal losslessly.

**Setup**

* Creates an empty Dataplex EntryGroup (`okf_ga4`).
* Creates the custom `okf` aspect type from `okf-aspect.json`.
* Creates a `catalog.yaml` manifest pointing at the EntryGroup and listing
  the `okf` aspect.
* The `catalog/` directory is already populated with the GA4 markdown bundle.

```bash
bun setup.ts
cat catalog.yaml
ls -R catalog
```

**Publish Metadata Snapshot**

* Push the bundled markdown to Knowledge Catalog. Entry names mirror the
  file path (e.g. `references/metrics/purchasers.md` &rarr; entry
  `references/metrics/purchasers`). Custom `type:` values in frontmatter
  that aren't valid Dataplex type refs are preserved on the `okf` aspect
  (the entry itself falls back to `dataplex-types.global.generic`).

```bash
bun push.ts
```

**Pull Metadata Snapshot**

* Pull the snapshot back down into `catalog/` as clean OKF. The signal
  layer is restored from the `okf` aspect, so a pull right after a push
  leaves `catalog/` unchanged.

```bash
bun pull.ts
```

**Modify Metadata Snapshot**

* Edit any markdown file under `catalog/` directly. Frontmatter fields
  (`title`, `description`, `tags`, plus the OKF signal keys `resource`,
  `type`, `generated`, `sources`) and the markdown body can be changed,
  then push again.

```bash
bun push.ts
```

**Cleanup**

* Deletes the Dataplex EntryGroup and the custom `okf` aspect type.

```bash
bun cleanup.ts
```
