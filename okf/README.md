# Open Knowledge Format (OKF)

### 📖 [Read the Open Knowledge Format v0.2 specification → SPEC.md](SPEC.md)

> **This repository is primarily about the [Open Knowledge Format
> (OKF)](SPEC.md).**
>
> OKF is a **universal, vendor-neutral format** for representing knowledge
> as plain markdown files with YAML frontmatter. It is **not tied to any
> particular agent, framework, model provider, or serving system**. The
> goal is simple:
>
> - **Anyone can produce** OKF — humans authoring by hand, agents built on
>   any framework (Google ADK, LangChain, custom), export pipelines from
>   existing catalogs (Dataplex, Unity Catalog, Collibra, …), or scripts
>   walking a database.
> - **Anyone can serve and consume** OKF — a static file server, a
>   knowledge-management UI (Obsidian, Notion, MkDocs), an LLM loading
>   files into context, a search index, or a graph viewer like the one
>   bundled in this repo.
>
> The agent below is a **proof of concept** demonstrating *one* way to
> produce OKF bundles automatically. The format itself is the
> contribution; this agent and the visualizer exist to make the format
> tangible at both ends — production and consumption.
>
> **See OKF in practice** — a ready-to-browse bundle checked into
> [`bundles/`](bundles/):
>
> - [`bundles/acme_retail/`](bundles/acme_retail/) — Acme Retail
>   ([viz.html](bundles/acme_retail/viz.html)) — a hand-authored bundle
>   showing the concept types the agent does not generate: Policy,
>   Metric, Attested Computation, Skill, and Log. It predates the AWS
>   port and still carries BigQuery-flavoured SQL and executor skill.

## Why OKF?

OKF represents catalog knowledge as plain markdown files with YAML
frontmatter, organized in a directory hierarchy. That choice unlocks a few
properties that are hard to get from a service-owned metadata store:

- **Human- and agent-readable.** No SDK or query language stands between a
  reader and the content. An engineer can `cat` a concept; an LLM can ingest
  it verbatim into context.
- **Version-controllable out of the box.** Bundles live in git. Pull
  requests, line-by-line diffs, blame, and review workflows just work —
  knowledge curation becomes a normal software-engineering activity.
- **Portable and lock-in free.** A bundle is a directory. Ship it as a
  tarball, host it in any repo, mount it from any filesystem, or sync it to
  any system that speaks files. No proprietary API stands between you and
  your metadata.
- **Mixes structured and unstructured data deliberately.** Use frontmatter
  for the few fields you want to query, filter, or index on (`type`,
  `resource`, `tags`, `generated`, `status`); use the markdown body for the
  prose, schemas, and example queries that LLMs and humans actually read.
- **Trust, provenance, and freshness are first-class.** v0.2 puts queryable
  signals in frontmatter — where a concept came from (`sources` with per-source
  credibility signals), who produced and confirmed it (`generated`, `verified`,
  from which consumers derive a trust tier), and whether it is still current
  (`status`, `stale_after`) — so an agent-maintained corpus stays trustable
  without any bespoke runtime.
- **Minimally opinionated, freely extensible.** A small set of required
  keys ensures interoperability, but bundles can carry arbitrary extra
  frontmatter keys and arbitrary body sections without breaking
  consumers.
- **Composes with existing tooling.** Many knowledge tools — Notion,
  Obsidian, MkDocs, Hugo, Jekyll — already speak markdown plus YAML
  frontmatter, so bundles can be browsed, edited, or rendered without
  custom UI.
- **Progressive disclosure built in.** Auto-generated `index.md` files
  let an agent or human navigate the hierarchy one level at a time
  instead of loading the entire bundle into context.
- **Graph-shaped, not just tree-shaped.** Concepts link to each other via
  normal markdown links, expressing relationships richer than the
  parent/child implied by the directory layout.

The net effect is that reference agents, consumption agents, and humans
collaborate on the same artifacts in the same way they already collaborate
on source code.

## Install

```
uv sync
uv run aws-reference-agent --help
```

Install uv first if needed: `curl -LsSf https://astral.sh/uv/install.sh | sh`.
`uv sync` provisions Python 3.11 automatically if it is not already present.

## Prerequisites

- **Python 3.11+**.
- **AWS credentials** via the standard chain: either `aws sso login
  --profile <name>` and pass `--profile <name>` to the CLI, or the usual
  environment variables (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
  `AWS_SESSION_TOKEN`, or `AWS_PROFILE`). Region can come from `--region`,
  the profile's configured region, or `AWS_REGION`.
- **Node.js and the `claude` CLI.** The agent is built on
  `claude-agent-sdk`, which spawns the Claude Code CLI as a subprocess to
  drive the tool-use loop — install Node.js and run `npm install -g
  @anthropic-ai/claude-code` (or otherwise ensure `claude` is on `PATH`)
  before running `enrich`.
- **Claude credentials** — either:
  - an Anthropic API key: `export ANTHROPIC_API_KEY=<key>`, **or**
  - Amazon Bedrock:
    ```
    export CLAUDE_CODE_USE_BEDROCK=1
    export AWS_REGION=us-east-1
    export ANTHROPIC_MODEL='us.anthropic.claude-sonnet-4-6'  # optional override
    ```

## How the reference agent works

The reference agent runs in three passes. The **Glue pass** writes one OKF
doc per concept the source advertises (database + tables), using AWS Glue
Data Catalog metadata, optionally augmented with a small Athena `LIMIT`
sample of each table's rows. The **web pass** then runs the LLM as its
own crawler: it receives a list of seed URLs (provided via `--web-seed`
or `--web-seed-file`), fetches the seeds via the `fetch_url` tool, and
decides which outbound links are worth following based on whether they
look like authoritative documentation for the existing concepts. For
each page it fetches, the agent chooses to (a) enrich one or more
existing concept docs, (b) mint a standalone `references/<slug>` doc, or
(c) skip. A hard `--web-max-pages` cap and a same-domain allowed-hosts
filter (configurable via `--web-allowed-host`) are enforced inside the
tool, so the agent cannot overrun.

The **docs pass** does the same job from local files instead of the web:
point `--docs-root` at a directory of markdown or plain-text documents (a
repo's `docs/`, an exported data dictionary, runbooks) and the agent calls
`list_local_docs()` once to get the complete set of readable paths, then
reads the ones that look like they describe the bundle's data. There is no
link graph to crawl, so the readable set is fixed before the model runs:
`read_local_doc` refuses any path outside that listing, which also rejects
`../` traversal and symlinks pointing out of the root. `--docs-max-files`
caps how many documents it may read and `--docs-max-bytes` truncates
oversized ones; `--docs-include` / `--docs-exclude` take globs against the
root-relative path. This pass needs **no IAM and no network** — the IAM
policy below is unchanged by it.

The docs pass runs last, after the web pass, because local documents are
the most likely to be stale. It is enrichment-first: documents augment
existing concept docs (field descriptions folded into `# Schema`, metrics
into `references/metrics/`, joins into `references/joins/`) rather than
becoming concepts of their own. Where a document contradicts the catalog,
the catalog's schema wins and the discrepancy is recorded in prose.

Both augmenting passes are confined to enrichment by `write_concept_doc`,
not just by prompt wording. They may **create** documents only under
`references/`; any other id must already exist on disk. Without that
guard an ingested document describing a table the catalog does not have
would produce a `type: Glue Table` doc whose schema and `resource` ARN
were the model's invention, with no way for a reader to tell it from
catalog-derived fact. They also may not shrink an existing table doc's
`# Schema` field set or its `sources` list. `list_concepts` marks each
entry `in_scope`: out-of-scope concepts stay listed so the agent can
recognise them (both sides of a documented join, say) but they get no
document and must not be linked.

Use `--no-web` to skip the web pass, `--no-docs` to skip the docs pass,
and `--no-sample` to skip Athena row sampling.

## Query verification

Every table doc carries a `# Common query patterns` section — the SQL a
reader is most likely to copy and run, and the part an LLM is most likely
to get subtly wrong by inventing a column. `--verify-queries` controls how
hard the agent's snippets are checked before they reach the bundle:

| Mode      | Cost               | What it checks                                        |
|-----------|--------------------|-------------------------------------------------------|
| `off`     | none               | Nothing. Snippets are written as-is.                  |
| `schema`  | none (**default**) | Locally, that every column named in a snippet appears in the doc's `# Schema`. |
| `execute` | Athena queries     | The above, plus each snippet actually runs.           |

Under `schema`, the write is refused when a snippet references a column
that is not in `# Schema`, and the agent is handed the offending names so
it can correct the SQL and retry. This is a purely local text check — no
AWS calls, no cost.

Under `execute`, the agent additionally gets a `validate_query` tool that
wraps each snippet as `SELECT * FROM (<snippet>) LIMIT 1` and runs it. The
`LIMIT` keeps it fast and near-free of scanned bytes, since the goal is a
pass/fail answer rather than data — results are never fetched. On failure
Athena's own parse or binding error is returned to the agent. Only
single-statement `SELECT`/`WITH` queries are submitted; anything else is
rejected before an AWS call is made.

The `schema` check is a conservative heuristic over SQL identifiers. If it
ever rejects a legitimate query, `--verify-queries off` is the escape
hatch.

`execute` shares the Athena client with row sampling, so it needs the same
credentials and cannot work under `--no-sample`. Combining the two is
rejected at startup rather than silently verifying nothing.

## IAM

Least-privilege policy for reading a Glue database and sampling rows via
Athena:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GlueCatalogRead",
      "Effect": "Allow",
      "Action": [
        "glue:GetDatabase",
        "glue:GetTables",
        "glue:GetTable",
        "glue:GetPartitions"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AthenaRowSampling",
      "Effect": "Allow",
      "Action": [
        "athena:StartQueryExecution",
        "athena:GetQueryExecution",
        "athena:GetQueryResults",
        "athena:StopQueryExecution"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadTableData",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::<data-bucket>",
        "arn:aws:s3:::<data-bucket>/*"
      ]
    },
    {
      "Sid": "AthenaResultsBucket",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::<athena-results-bucket>/*"
    }
  ]
}
```

Pass `--no-sample` to skip row sampling entirely — that drops the need
for every `athena:*` permission and both S3 statements above; only
`GlueCatalogRead` is required.

`--verify-queries execute` runs through the same Athena path and needs no
permissions beyond the ones above. It reads no rows, so
`athena:GetQueryResults` is not exercised by verification itself.

## Verify access

Before spending tokens, confirm the credentials reach your catalog. This
hits Glue only — no LLM, no Athena, no cost:

```
uv run python -c "
from aws_reference_agent.sources.glue import GlueSource
s = GlueSource(database='<glue-database-name>', sampling_enabled=False)
for c in s.list_concepts(): print(c.id_str, '|', c.type, '|', c.resource)
"
```

It should print one `databases/<name>` row and one `tables/<name>` row
per table, each with a Glue ARN. Add `region='<aws-region>'` if your
profile has no configured region. To eyeball the parsed schema for one
table before committing to a full run:

```
uv run python -c "
import json
from aws_reference_agent.sources.glue import GlueSource
s = GlueSource(database='<glue-database-name>', sampling_enabled=False)
ref = s.find(('tables', '<table-name>'))
print(json.dumps(s.read_concept(ref), indent=2, default=str))
"
```

## Run

Start with one concept and both optional passes off. This is a single
LLM turn against a single table — no crawling, no Athena scan:

```
uv run aws-reference-agent enrich \
    --source glue \
    --database <glue-database-name> \
    --concept tables/<table-name> \
    --no-web \
    --no-sample \
    --out /tmp/okf-smoke \
    -v
```

`-v` logs every tool call and its result, which is the fastest way to
see what the agent is actually doing.

To try the docs pass on its own — no network, no Athena, one table:

```
uv run aws-reference-agent enrich \
    --source glue \
    --database <glue-database-name> \
    --concept tables/<table-name> \
    --no-web \
    --no-sample \
    --docs-root ./docs \
    --docs-include '*.md' \
    --docs-max-files 10 \
    --out /tmp/okf-docs-smoke \
    -v
```

In the `-v` log, expect one `list_local_docs` call followed by
`read_local_doc` calls for the documents the agent selected. Seeing
`write_concept_doc` return a schema-guard error and then succeed on retry
is the healthy trace for an augmentation.

Then widen to the whole database with all passes on:

```
uv run aws-reference-agent enrich \
    --source glue \
    --database <glue-database-name> \
    --region <aws-region> \
    --profile <aws-profile> \
    --athena-workgroup <workgroup> \
    --web-seed-file <path/to/seeds.txt> \
    --web-max-pages 40 \
    --docs-root ./docs \
    --out ./bundles/<name>
```

Notes on the optional flags:

- `--region` and `--profile` are only needed when the environment or the
  active AWS profile doesn't already supply them.
- `--athena-output-location s3://<bucket>/athena/` is for workgroups that
  do **not** configure their own results location. Passing it against a
  workgroup that enforces one causes Athena to reject the query, and row
  sampling then silently yields no rows — omit it unless you know your
  workgroup needs it.
- `--no-sample` skips Athena entirely; `--no-web` skips the crawl;
  `--no-docs` skips the docs pass even when `--docs-root` is set.
- `--docs-root` needs no credentials. A nonexistent or non-directory path
  is a hard error rather than a silently skipped pass.
- `--verify-queries {off,schema,execute}` sets how the agent's
  `# Common query patterns` SQL is checked (default `schema`, which costs
  nothing). See [Query verification](#query-verification).
- `--concept <type>/<name>` is repeatable, so you can re-run a handful of
  tables without regenerating the whole bundle.

Row sampling is best-effort by design: if Athena fails for any reason the
run continues and the affected docs simply carry no sample rows. Run with
`-v` and look for `sample_rows` in the log to confirm it returned data.

## Samples

Each sample pairs a **recipe** (`samples/<name>/`, with the seed URLs and
exact `enrich` command) with the **produced bundle** (`bundles/<name>/`)
that the recipe generated. Open the recipe to reproduce; open the bundle
to browse the result directly.

- **NOAA GHCN-Daily** — public S3 dataset (no public Glue catalog; the
  recipe registers the Hive-partitioned Parquet data in your own Glue
  database, then runs the agent against it). Runnable against the current
  AWS agent, but no bundle is committed yet.
  · [recipe](samples/noaa_ghcn/README.md)

The pre-fork BigQuery recipes and the bundles they produced (GA4, Stack
Overflow, Bitcoin) were removed with the AWS port — they could not be
re-run against the Glue agent, and the table docs they contained are the
same shape this agent now produces from a real catalog.

## Visualize

The `visualize` subcommand renders any OKF bundle as a **self-contained
interactive HTML file** — one file, no backend, no install on the
viewing side. Open it in any modern browser, share it as an artifact,
host it on a static file server, or commit it next to the bundle (as
this repo does).

The viewer is itself a proof-of-concept *consumer* of OKF, mirroring
the way the reference agent is a proof-of-concept *producer*. OKF
bundles can be consumed by anything that reads markdown; this is just
one shape.

### What it shows

- A **force-directed graph** of every concept in the bundle, with
  colored nodes by type (datasets, tables, references, …) and directed
  edges drawn from each cross-link in the markdown bodies.
- A **detail panel** for the selected concept showing its frontmatter
  (description, resource link, tags) and its rendered markdown body —
  with internal `[…](/path/to/concept.md)` links rewired to navigate
  within the viewer instead of following the path.
- A **"Cited by" backlinks** list under each concept (computed from the
  reverse of the link graph).
- A **search box** (matches title, concept id, and tags), a **type
  filter**, and switchable graph layouts (cose / concentric /
  breadth-first / circle / grid).

### Generate

```
uv run aws-reference-agent visualize --bundle ./bundles/<name>
```

That writes `bundles/<name>/viz.html`. Flags:

| Flag           | Default                | Description                                 |
|----------------|------------------------|---------------------------------------------|
| `--bundle`     | *(required)*           | Bundle root directory.                      |
| `--out`        | `<bundle>/viz.html`    | Output HTML path.                           |
| `--name`       | bundle directory name  | Display name shown in the viewer header.    |

Example, writing the output somewhere else and overriding the header:

```
uv run aws-reference-agent visualize \
    --bundle ./bundles/acme_retail \
    --out /tmp/acme.html \
    --name "Acme Retail OKF"
```

### How it's built

The HTML embeds the bundle as a JSON blob and uses
[Cytoscape.js](https://js.cytoscape.org/) for the graph and
[marked](https://marked.js.org/) for in-browser markdown rendering,
both loaded from a CDN. No data leaves the page; the bundle is parsed
once at generation time and serialized into the file.

## Tests

```
uv run pytest
```
