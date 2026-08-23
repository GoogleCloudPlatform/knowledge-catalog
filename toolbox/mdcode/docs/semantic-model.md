# Deploying a semantic model

This guide has moved into [`semantic-model/`](semantic-model/README.md) and is
now split by what you came to do:

- **[Deploy guide](semantic-model/README.md)** — author a model, push it, update
  it, pull it back.
- **[Reference](semantic-model/reference.md)** — every flag, what push creates in
  BigQuery and Knowledge Catalog (including class hierarchies), validation, and
  permissions.
- **[What push and pull preserve](semantic-model/fidelity.md)** — the
  round-trip fidelity matrix: what survives a deploy, what a pull recovers, and
  what neither keeps.
- **[Importing an OWL ontology](semantic-model/owl-import.md)** — convert an OWL
  ontology into a semantic model, then deploy it the normal way.
