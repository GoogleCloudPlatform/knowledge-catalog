# Business glossary

A semantic model names things the way the data does (`Order`, `total`,
`revenue`). The business names them its own way ("Gross Sales", "turnover").
The `glossary:` block records the business vocabulary next to the model:
business terms with definitions and synonyms, grouped in categories, and
linked to the entities, fields and metrics they name. `kcmd glossary push`
publishes it as a [Knowledge Catalog Business
Glossary](https://cloud.google.com/dataplex/docs/manage-glossaries).

The block is an extension of the `0.2.0.dev0/google` profile; vanilla Ossie
rejects it. It changes nothing else: no generated SQL, no semantic entry, no
graph element.

## Spec

```yaml
version: 0.2.0.dev0/google
semantic_model:
  - name: shop
    entities: [...]
    metrics:
      - name: revenue
        expression: SUM(Order.total)
    glossary:
      id: shop-glossary            # optional; default <model>-glossary
      display_name: Shop Glossary  # optional; default: the id in title case
      description: Commercial vocabulary.
      categories:
        - id: finance
          display_name: Finance
        - id: sales-finance
          parent: finance          # optional; categories nest up to 3 levels
      terms:
        - id: revenue
          display_name: Revenue
          definition: Total value of orders.
          category: finance        # optional; else directly under the glossary
          synonyms: [sales, turnover]
          related: [order-total]   # other term ids
          formula: SUM(Order.total) # informational, model names
          defines:                 # what the term is the business name of
            - metric: revenue
            - entity: Order
          source: finance handbook, section 2   # provenance, free text
        - id: order-total
          definition: Gross amount of one order.
          category: sales-finance
          defines:
            - field: Order.total
```

| Key | Meaning |
|---|---|
| `id` | Dataplex resource id: lowercase letters, digits and hyphens, starts with a letter, ends with a letter or digit, at most 63 characters. Becomes the published glossary, category and term id unchanged. |
| `display_name` | Optional. Defaults to the id in title case (`order-total` → "Order Total"). |
| `definition` | The business definition. A term without one is warned. |
| `synonyms` | Free-text alternative labels. They are folded into the published description ("Also called: …"), so catalog search finds the term by them. They are *not* `synonym` entry links (those join two terms). |
| `related` | Ids of related terms in the same glossary → `related` entry links. |
| `formula` | How the term is computed, in model names. Informational. |
| `defines` | The model elements the term names: `{entity: Name}`, `{field: Entity.field}` (inherited fields count) or `{metric: name}`, one key per item → `definition` entry links. |
| `source` | Provenance, free text (an importer records the file it read). |

### Checks

| Finding | Load | `validate` / push |
|---|---|---|
| Duplicate category or term id | warning | error |
| Unknown `category`, `parent` or `related` id; a category cycle; nesting deeper than 3 | warning | error |
| A `defines` naming no entity, `Entity.field` (own or inherited) or metric | warning | error — a warning when a binding profile pruned fields |
| A term with no `definition` | warning | — |
| More than 10 terms defining one entity (or its fields) | warning | — (a BigQuery data agent imports at most 10 glossary terms per table) |

## Publishing: `kcmd glossary push`

```sh
kcmd glossary push [--dry-run] [--prune-glossary] [--profile <name>] \
    [--project <project>] [--location <location>] [--no-semantic-links]
```

Run it in a semantic-model scope, after `kcmd push` (so the semantic entries
the definition links point at exist). `kcmd push` itself does not publish the
glossary. Each model with a `glossary:` block is published as follows:

1. **Glossary.** `POST v1/projects/{project}/locations/{location}/glossaries?glossaryId={id}` with
   `{displayName, description, labels}`. This is a long-running operation;
   `kcmd` waits for it. The project defaults to the `catalog.yaml` source project,
   and the location to `global`.
2. **Categories, parents first.** `POST …/glossaries/{id}/categories?categoryId={c}` with
   `{displayName, description, labels, parent}`, where `parent` is the full
   name of the glossary or of the parent category.
3. **Terms.** `POST …/glossaries/{id}/terms?termId={t}` with
   `{displayName, description, labels, parent}`, where `parent` is the
   glossary or the term's category. The description is the definition,
   followed by fixed paragraphs:

   ```text
   Total value of orders.

   Formula: SUM(Order.total)

   Also called: sales, turnover.

   Related terms: order-total.

   Defines: revenue (metric), Order (entity).

   Source: finance handbook, section 2
   ```

4. **`related` links**, one per pair of terms. They are created in the
   glossary project's `@dataplex` entry group:

   ```text
   POST v1/projects/{project}/locations/{location}/entryGroups/@dataplex/entryLinks?entryLinkId=rel-…
   {"entryLinkType": "projects/dataplex-types/locations/global/entryLinkTypes/related",
    "entryReferences": [{"name": "<term entry A>", "type": "UNSPECIFIED"},
                        {"name": "<term entry B>", "type": "UNSPECIFIED"}]}
   ```

   A term's entry is
   `projects/{projectNumber}/locations/{location}/entryGroups/@dataplex/entries/projects/{projectNumber}/locations/{location}/glossaries/{id}/terms/{t}`.

5. **`definition` links from BigQuery**, created in the source table's own
   system entry group. The group is `@bigquery` in the dataset's location,
   addressed by the data project's number:

   ```text
   POST v1/projects/{dataProjectNumber}/locations/{datasetLocation}/entryGroups/@bigquery/entryLinks?entryLinkId=def-…
   {"entryLinkType": "projects/dataplex-types/locations/global/entryLinkTypes/definition",
    "entryReferences": [
      {"name": "projects/{n}/locations/us/entryGroups/@bigquery/entries/bigquery.googleapis.com/projects/{p}/datasets/{d}/tables/{t}",
       "path": "Schema.total_amount", "type": "SOURCE"},
      {"name": "<term entry>", "type": "TARGET"}]}
   ```

   - A `field` links its physical column: `path` is `Schema.<column>`, and an
     inherited field links the concrete entity's table.
   - An `entity` links the whole table, with no `path`.
   - These are skipped, with a note, when there is no table or column to point
     at: an abstract or defined entity, an unbound entity, a computed field, or
     a dataset whose location cannot be read.

6. **`definition` links from the semantic entries** that `kcmd push`
   publishes in the `catalog.yaml` entry group. They use the same body, with
   these sources:
   - the entity entry `<model>.entities.<Entity>`, with `path: Schema.<field>`
     for a field;
   - the metric entry `<model>.metrics.<metric>` for a metric.

   The documentation does not say whether definition links are allowed on
   custom entries. If the API refuses one, it is reported as skipped rather
   than failing the run. `--no-semantic-links` leaves this leg out.

**Idempotency.** Entry-link ids are deterministic: `def-` or `rel-`, the
term, and a hash of both ends. On a 409 `ALREADY_EXISTS`:
- the glossary, categories and terms are patched (`updateMask=displayName,description,labels[,parent]`);
- entry links count as already present.

So re-running `kcmd glossary push` converges.

**Labels.** Every resource carries `managed-by: kcmd` and
`kcmd-model: <model>`. `--prune-glossary` deletes only the terms and
categories that carry this model's labels and that the spec does not
declare. Terms curated in the console are never touched.

**`--dry-run`** prints every request (method, path, query and body) and the
skipped links, and sends nothing. It still reads project numbers and dataset
locations when credentials allow, and shows placeholders when they do not.

**Permissions.**
- `dataplex.glossaries.*` on the glossary project.
- `dataplex.entryLinks.create` on the `@bigquery` system entry group of each
  data project, and on the semantic entry group.
- `resourcemanager.projects.get` to read project numbers.
- `bigquery.datasets.get` to read dataset locations.

## Importing a glossary

A glossary block is plain spec, so any source can produce it:

- **OWL / SKOS.** `kcmd owl import` maps the ontology's SKOS vocabulary to the
  glossary (see [OWL import → SKOS
  vocabulary](owl-import.md#skos-vocabulary-business-glossary)).
- **Other sources.** A planned `kcmd glossary import --from <source>` will use
  the same block.

## Not yet

- **Pull.** `kcmd pull` does not read the glossary back yet. The pure reverse
  (`glossaryFromDataplex`) and a reader (`pullGlossary`) exist. Because
  `related` and `defines` ride the description trailers, a read needs no entry
  link lookup.
- **Stale links.** `--prune-glossary` prunes terms and categories, not entry
  links. A `defines` removed from a term that remains leaves its old
  definition link in place.
- **`synonym` links.** A link between two terms that mean the same thing has
  no spec key yet. Free-text `synonyms` stay in the description.
