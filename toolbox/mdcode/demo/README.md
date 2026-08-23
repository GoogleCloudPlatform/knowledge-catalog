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
Knowledge Catalog EntryGroup via the Documents Layout. By default it operates
on `okf/bundles/acme_retail`, the canonical in-repo bundle: 17 markdown files
covering metrics, computations, policies, skills, and tables, and the one that
exercises the full v0.2 signal layer. The Documents Layout maps each `.md`
file to an entry whose name is derived from the file path, with the
markdown body stored on the `dataplex-types.global.overview` aspect.

A second bundle in `okf/catalog/` is a GA4 sample with indexes, references, a
dataset, and a table, 14 markdown files in total. It is kept for anyone who was
using the old default, and is reachable with `--bundle catalog`.

The generic Documents Layout only carries `title`/`description`/`tags` +
body. OKF's signal layer has no generic home, so `push.ts`/`pull.ts`
translate it into a custom typed `okf` Dataplex aspect (created by
`setup.ts`) and back, keeping the on-disk files clean OKF and
round-tripping the signal losslessly.

Entries are published under a custom `okf-bundle` entry type rather than
the built-in `dataplex-types.global.generic`, so a catalog-wide search can
pick out OKF documents. A document's OKF `type:` is freeform prose, not a
Dataplex type ref, so it is recorded separately as `okf_type` on the `okf`
aspect. `okf-bundle` declares no required aspects, because SPEC 8 index
files carry no signal layer and requiring the `okf` aspect would reject
them. An entry's type is fixed at creation, so a bundle already published
under the generic type has to have its entry group deleted and recreated.

The aspect models the full OKF v0.2 signal as typed, searchable fields:
`type`, `resource`, `generated`, `verified`, `status`, `stale_after`,
`sources` (with `author`, `usage_count`, `last_modified`), `usage_window`,
and the Attested Computation contract (`runtime`, `parameters`,
`computation`, `executor`, `attester`). OKF also permits producer-defined
frontmatter keys at any depth, so no enumerated template can ever be
complete. Anything the template does not model, whether a top-level key like
`not:` or a subfield inside a modeled record like `sources[].license`, is
diverted onto a single `extra` field as a JSON list of `[path, value]` pairs
and restored on pull. That keeps the round-trip lossless for any conformant
bundle. A diverted subfield returns at the end of its record rather than its
original position, which is the same presentation normalization pull already
applies elsewhere.

**Setup**

* Creates an empty Dataplex EntryGroup (`okf_demo`). `--entry-group <name>`
  names a different one; the name must match Dataplex's own rule
  (`/^[a-z][a-z0-9_-]{0,61}[a-z0-9]$/`) or setup stops before calling gcloud.
* Creates the custom `okf` aspect type from `okf-aspect.json`, or updates it
  if a previous run of this demo left an older template behind.
* Creates the custom `okf-bundle` entry type.
* Creates a `.state/catalog.yaml` manifest pointing at the EntryGroup and
  listing the `okf-bundle` entry type and the `okf` aspect. It sits in a hidden
  `.state/` directory so that this demo directory never takes on the shape of a
  canonical snapshot root, which is a `catalog.yaml` beside a `catalog/` tree.

`setup.ts` is the only script that takes `--entry-group`. The rest read the
EntryGroup back out of the manifest it writes, so they cannot be aimed at an
EntryGroup this demo never created.

```bash
bun setup.ts
cat .state/catalog.yaml
```

**Publish Metadata Snapshot**

* Push the bundled markdown to Knowledge Catalog. Without `--bundle` this
  pushes `okf/bundles/acme_retail`. Entry names mirror the file path
  (e.g. `metrics/revenue.md` &rarr; entry `metrics/revenue`). Every file
  lands as an `okf-bundle` entry, index files included, with its OKF
  `type:` on the `okf` aspect.

```bash
bun push.ts
```

**Pull Metadata Snapshot**

* Pull the snapshot back down as clean OKF. The signal layer is restored
  from the `okf` aspect. Pull writes to `./pulled/`, a gitignored scratch
  directory, so it never overwrites the bundle push reads from; compare the
  two to confirm the round trip.

```bash
bun pull.ts
diff -r ../../../../okf/bundles/acme_retail pulled
```

**Modify Metadata Snapshot**

* Edit any markdown file in the bundle directly. Any frontmatter key and
  the markdown body can be changed, then push again.

```bash
bun push.ts
```

**Run Against Another Bundle**

* `push.ts` and `pull.ts` both take `--bundle <dir>`, so the demo can run
  against a bundle elsewhere in the repo without copying it in, and pull can
  be aimed somewhere other than `./pulled/`. `--bundle catalog` selects the
  GA4 sample that used to be the default.

```bash
bun push.ts --bundle catalog
bun pull.ts --bundle /tmp/acme_pulled
```

* Pull re-emits frontmatter in a canonical key order and block style, so
  pulling a hand-authored bundle back shows presentation churn in a `diff`
  even though nothing was lost. The Acme Retail bundle uses flow mappings, so
  expect churn there; compare parsed frontmatter and body rather than bytes.
  The GA4 bundle in `catalog/` is already in canonical form, so
  `bun push.ts --bundle catalog` followed by `bun pull.ts --bundle catalog`
  leaves that tree byte-identical.

* Two things do not make the trip. Only `.md` files are pushed, so bundle
  attachments such as `acme_retail/attesters/sql_equality.py` stay local
  even though frontmatter points at them. And in-body markdown links
  between concepts stay markdown; the only native Knowledge Catalog edges
  are the parent links derived from the directory structure.

**Cleanup**

* Deletes the Dataplex EntryGroup named in `.state/catalog.yaml`, printing
  which one and in which project first. It takes no flags, so the only
  EntryGroup it can delete is the one `setup.ts` created. The custom `okf`
  aspect type and `okf-bundle` entry type are left in place: they are scoped
  to the project and location rather than to this demo, so other OKF bundles
  in the same project are typed by them too. The commands to remove them
  manually are printed at the end.

```bash
bun cleanup.ts
```
