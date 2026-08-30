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

This is also how you build **semantic models**. You describe your entities
(tables), the metrics computed over them, and the relationships between them in a
single [Apache Ossie](https://ossie.apache.org/) document. One `kcmd push` then
deploys that document to two destinations at once:

- a queryable property graph — **BigQuery Graph** or **Spanner Graph**, chosen by
  the deployment target you declare — so the model can be traversed in SQL. On
  BigQuery each metric becomes a graph measure, so agents and analysts query
  business concepts rather than raw columns.
- **Knowledge Catalog** entries and links that make the model discoverable as
  metadata.

Start with the [semantic model guide](toolbox/mdcode/docs/semantic-model/README.md)
to author and deploy one, or the
[end-to-end codelab](toolbox/mdcode/docs/semantic-model/codelab.md) to walk the
whole lifecycle: author, govern, hydrate, and query one model. To start from an
existing OWL ontology, see
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
