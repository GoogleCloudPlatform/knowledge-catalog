# Validating constraints against BigQuery

`kcmd validate --target bigquery` measures how well the data a binding profile
binds conforms to the model's constraints. It replaces the prototype's
`shacl_to_sql.py`: the rules come from the model (imported SHACL and OWL
constraints, plus keys and foreign keys), and the tables come from the selected
profile, so the queries follow the same bindings the property graph does.

```bash
# Write the queries only (no credentials needed).
kcmd validate --target bigquery --profile bigquery --sql-only --out validation

# Run them (dry run first), print the results table.
kcmd validate --target bigquery --profile bigquery --location US

# ...and publish the results to Knowledge Catalog.
kcmd validate --target bigquery --profile bigquery --location US --publish
```

To check the model's claims rather than its rules, see [Profiling the data
against BigQuery](profiling.md) (`kcmd profile`, proposed). It checks that
keys identify rows, that relationships keep their cardinality and reach a row,
and that a unit's scale holds across fields and over time.

## What gets checked

A model constraint is a judged rule: its body is a sentence (see
[model_spec.md](model_spec.md)). The SHACL and OWL importers, however, write
every rule they generate from a closed vocabulary, and they end the
constraint's `description` with a provenance note restating the source terms:

```text
(From SHACL: OpportunityShape, salesStage sh:pattern '^[0-9][A-Z]?$'.)
(From OWL: Opportunity SubClassOf hasBuyer exactly 1 ClientAccount.)
```

`validate` parses that note (and, for `sh:in`, the judgment, which quotes each
member exactly) back into a structured rule and compiles it to SQL. One check
per constraint: a **count query** returning one row `violations, total`, and an
**examples query** returning up to `--examples` violating rows as
`focus_key, value`.

| Kind | Source terms | Violation (per focus row) |
|------|--------------|---------------------------|
| required | `sh:minCount 1` on a field; OWL `some` / `min 1` / `exactly 1` on a field | `f IS NULL OR TRIM(CAST(f AS STRING)) = ''` |
| empty | `sh:maxCount 0`; OWL `max 0` / `exactly 0` on a field | `f IS NOT NULL` |
| pattern | `sh:pattern` (+ `sh:flags` `i`, `s`, `m`) | `f IS NOT NULL AND NOT REGEXP_CONTAINS(CAST(f AS STRING), '(?flags)pattern')` |
| in | `sh:in (...)` | `f IS NOT NULL AND CAST(f AS STRING) NOT IN (...)` |
| value | OWL `p value v` on a field | `f IS NULL OR CAST(f AS STRING) != 'v'` |
| range | `sh:minInclusive` / `minExclusive` / `maxInclusive` / `maxExclusive` | numeric bound: `SAFE_CAST(.. AS BIGNUMERIC)` compare; temporal field: `SAFE_CAST` to `DATE` / `DATETIME` / `TIMESTAMP` / `TIME`; else string compare |
| length | `sh:minLength` / `sh:maxLength` | `LENGTH(CAST(f AS STRING)) < min OR > max` |
| lessThan / lessThanOrEquals | `sh:lessThan g` / `sh:lessThanOrEquals g` | both set and `f >= g` / `f > g` |
| equals | `sh:equals g` | exactly one set, or `f != g` |
| disjoint | `sh:disjoint g` (fields) | `f = g` |
| cardinality | `sh:minCount` / `sh:maxCount` / `sh:qualified*` on a relationship; OWL `some` / `min` / `max` / `exactly` (also through an `inverse` name); `FunctionalProperty` | per-focus edge count (`LEFT JOIN` of the counted edges) `< min` or `> max` |
| class | `sh:class X` alone on a relationship; OWL `only X` | forward: the foreign key is set and points at no `X` row; inverse: some source row is not an `X` |
| disjointClasses | OWL `DisjointWith` / `DisjointClasses` | a key that is an instance of more than one of the classes |

The model's own structure adds, unless `--no-structural`:

| Check | Id | Violation |
|-------|----|-----------|
| primaryKey | `<Entity>_primary_key` (one per table) | a key column is NULL, or the key repeats |
| uniqueKey | `<Entity>_unique_<cols>` | all columns set and the combination repeats |
| references | `<relationship>_references` | foreign key set and no destination row has it |

### How classes map to rows

- An entity's rows are its bound table plus the tables of its table-backed
  subtypes, de-duplicated by key, so an instance counts once.
- A **defined entity** (`definition:`) is lowered exactly as the graph leg
  lowers it: its rows are its base's rows filtered by the membership predicate.
- An edge counts only when the row at its other end exists (and, for a
  qualified rule, is an instance of the qualifier). A foreign key pointing at
  nothing is a missing edge, not a present one -- the `references` check reports
  it separately.

### What is skipped

Anything without a deterministic form is listed in one warning, with the
reason, and in the manifest's `unsupported` array:

- a hand-written judgment (no provenance note);
- OWL `p value <individual>` on a relationship (no row identifies an
  individual);
- a rule on an association (junction-table) or abstract relationship;
- a rule on a field or entity the profile leaves unbound;
- a regular-expression flag RE2 has no equivalent for (`x`, `q`).

`sh:datatype` never reaches the model as a constraint (the importer folds it
into the field type), so it is not checked here.

## Outputs

`--out` (default `validation`) receives, per model:

- `<model>.validation.sql` -- every count query followed by its examples query,
  runnable as-is; skipped constraints are listed in comments at the top.
- `<model>.validation.json` -- the manifest: `model`, `profile`, `generatedAt`,
  `checks[]` (`id`, `constraint`, `source` = `constraint` | `model`, `origin` =
  `SHACL` | `OWL` | `model`, `kind`, `entity`, `field`, `onViolation`,
  `severity`, `sql`, `examplesSql`), `unsupported[]` and `warnings[]`.
- `<model>.results.json` (after a run) -- one record per check: `status`,
  `violations`, `total`, `examples`, `error`, `checkedAt`, `sql`.

When run, each check is dry-run first (name resolution, access, syntax), then
counted; the examples query runs only for a failing check. A check that cannot
run is `error` with BigQuery's message; the command exits 1 when any check
errored and 0 otherwise -- violations are the report, not a failure.

## Publishing to Knowledge Catalog

`--publish` writes the results onto the entity entries `kcmd push` publishes
(`<model>.entities.<Entity>` in the scope's entry group), as one aspect of type
`projects/<project>/locations/global/aspectTypes/semantic-constraint-results`.
The aspect type is created on first use in the scope's project. Each entity's
aspect holds `model`, `profile`, `checkedAt` and a `results[]` array, one
record per check on that entity:

```json
{
  "constraint": "Opportunity_salesStage_pattern",
  "kind": "pattern",
  "status": "fail",
  "field": "salesStage",
  "violations": 3,
  "total": 1200,
  "examples": ["OPP-0042: 9Z", "OPP-0107: x"],
  "checkedAt": "2026-01-01T00:00:00.000Z",
  "sql": "WITH focus AS (...) SELECT COUNTIF(...) AS violations, COUNT(*) AS total FROM focus"
}
```

The update names only this aspect, so the entry's other aspects are untouched,
and a later `kcmd push` -- which names only the aspects it owns -- leaves the
results in place. Run `kcmd push` first: an entity entry that does not exist is
reported, not created.

> [!IMPORTANT]
> The results describe stored data at one point in time. Nothing uses them as a
> filter: the property graph, queries, skills and action guards read the model,
> never these counts.
