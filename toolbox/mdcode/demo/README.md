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
body. OKF's signal layer has no generic home, so `push.ts`/`pull.ts`
translate it into a custom typed `okf` Dataplex aspect (created by
`setup.ts`) and back, keeping the on-disk files clean OKF and
round-tripping the signal losslessly.

The aspect models the full OKF v0.2 signal as typed, searchable fields:
`type`, `resource`, `generated`, `verified`, `status`, `stale_after`,
`sources` (with `author`, `usage_count`, `last_modified`), `usage_window`,
and the Attested Computation contract (`runtime`, `parameters`,
`computation`, `executor`, `attester`). OKF also permits producer-defined
frontmatter keys, so no enumerated template can ever be complete. Anything
the template does not model is carried as JSON on a single `extra` field,
which keeps the round-trip lossless for any conformant bundle.

**Setup**

* Creates an empty Dataplex EntryGroup (`okf_ga4`).
* Creates the custom `okf` aspect type from `okf-aspect.json`, or updates it
  if a previous run of this demo left an older template behind.
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

* Edit any markdown file under `catalog/` directly. Any frontmatter key and
  the markdown body can be changed, then push again.

```bash
bun push.ts
```

**Verify the Translation**

* `verify.ts` runs every file in a bundle through the translation in both
  directions and reports any key or body content that did not survive. It
  touches no cloud resources, so it needs no project and makes a good
  pre-push check.

```bash
bun verify.ts
```

**Run Against Another Bundle**

* `push.ts`, `pull.ts`, and `verify.ts` all take `--bundle <dir>`, so the
  demo can run against a bundle elsewhere in the repo without copying it
  in. `okf/bundles/acme_retail` is the bundle that exercises the full v0.2
  signal layer, including an Attested Computation and a producer-defined
  key.

```bash
bun verify.ts --bundle ../../../../okf/bundles/acme_retail
bun push.ts   --bundle ../../../../okf/bundles/acme_retail
bun pull.ts   --bundle /tmp/acme_pulled
```

* Pull re-emits frontmatter in a canonical key order and block style, so
  pulling a bundle that was hand-authored with flow mappings back over
  itself shows presentation churn in `git diff` even though nothing was
  lost. `verify.ts` is the semantic check; it compares parsed frontmatter
  and body, not bytes. The GA4 bundle in `catalog/` is already in canonical
  form, so for it a pull after a push leaves the tree byte-identical.

* Two things do not make the trip. Only `.md` files are pushed, so bundle
  attachments such as `acme_retail/attesters/sql_equality.py` stay local
  even though frontmatter points at them. And in-body markdown links
  between concepts stay markdown; the only native Knowledge Catalog edges
  are the parent links derived from the directory structure.

**Cleanup**

* Deletes the Dataplex EntryGroup. The custom `okf` aspect type is left in
  place: it is scoped to the project and location rather than to this demo, so
  other OKF bundles in the same project carry their signal layer on it. The
  command to remove it manually is printed at the end.

```bash
bun cleanup.ts
```
