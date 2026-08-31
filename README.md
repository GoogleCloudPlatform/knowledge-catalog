# Knowledge Catalog

[Knowledge Catalog](https://cloud.google.com/products/knowledge-catalog) (formerly
Dataplex) is an AI-powered data catalog and metadata management platform. It
builds a dynamic knowledge graph of your data — structured and unstructured — that
gives AI agents the semantics and business context they need to work with it.

This repository holds the tools, agents, and samples for managing that metadata:
authoring it as source code, enriching it, and retrieving it.

## What's in this repository

### Metadata as Code — [`toolbox/mdcode`](toolbox/mdcode/README.md)

Author catalog metadata as source files (YAML and markdown) and keep it in sync
with the catalog service, using the same edit, review, and version-control
workflows you use for code. It ships as a TypeScript and a Python library, a CLI
tool (`kcmd`), and an MCP server that exposes the same operations to agents.

This is also how you build and deploy **semantic models**. A semantic model
describes a business logically — its entities, the relationships between them, and
the metrics computed over them — in a format based on
[Apache Ossie](https://ossie.apache.org/), independent of where the data
physically lives. `kcmd push` deploys that one model
to two kinds of destination at once:

- **Knowledge Catalog, where the model is governed.** It becomes catalog entries —
  one per entity, metric, and the model itself — joined by links for its
  relationships. There it is the single governed definition of the business:
  access-controlled, searchable, and part of the dynamic knowledge graph that gives
  AI agents the semantics and business context to work with your data. Governing
  needs no tables or data, so you can publish a purely logical model before it is
  bound — or govern the model together with its bindings. The catalog serves either.
- **A data store, where the model becomes queryable.** Consumers ask for business
  concepts — `Customer`, `revenue` — and get consistent, model-defined answers
  rather than re-deriving joins and formulas per query. The store can be
  **analytical**, such as BigQuery for reporting and conversational-analytics
  agents, or **operational**, such as Spanner for the live state an agent reads
  before it acts.

A **binding profile** maps one logical model onto a concrete store, so you keep a
single definition and add a profile per store or environment. `Customer` and
`revenue` mean the same thing whichever profile serves them, so an
operational agent and an analytics agent share one definition.

Start with the [semantic model guide](toolbox/mdcode/docs/semantic-model/README.md)
to author and deploy one, [binding profiles](toolbox/mdcode/docs/semantic-model/profiles.md)
to bind one model to several stores, or the
[end-to-end codelab](toolbox/mdcode/docs/semantic-model/codelab.md) for the whole
lifecycle. To start from an existing OWL ontology, see
[Importing an OWL ontology](toolbox/mdcode/docs/semantic-model/owl-import.md).

### Enrichment agent — [`toolbox/enrichment`](toolbox/enrichment/README.md)

A customizable agentic workflow that extracts information from external sources
to build and maintain metadata about data assets, ready for use as context.

### Samples — [`samples`](samples/README.md)

Runnable examples built on the catalog's APIs: a
[discovery agent](samples/discovery/README.md) that searches and reasons over data
assets through the Search APIs, and an
[enrichment agent](samples/enrichment/README.md) that generates and improves asset
documentation.

### Open Knowledge Format

The `okf/` directory is a frozen snapshot. The Open Knowledge Format now lives in
its own repository,
[GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format);
read the spec, file issues, and open pull requests there.

## Getting started

Open this repository in Cloud Shell:

[![Open in Cloud Shell](http://gstatic.com/cloudssh/images/open-btn.svg)](https://console.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https%3A%2F%2Fgithub.com%2FGoogleCloudPlatform%2Fknowledge-catalog.git)

To try Metadata as Code and semantic models, follow the
[`toolbox/mdcode` guide](toolbox/mdcode/README.md).

## Contributing

See the [contributing instructions](CONTRIBUTING.md) to get started.

## License

All solutions within this repository are provided under the
[Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) license. See
[LICENSE](LICENSE.md) for the full terms and conditions.

## Disclaimer

This repository and its contents are not an official Google product.
