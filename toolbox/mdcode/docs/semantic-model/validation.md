# Validating constraints against BigQuery

`kcmd validate --target bigquery` measures how well the data a binding profile
binds conforms to the model's constraints. The rules come from the model
(imported SHACL and OWL constraints, plus keys and foreign keys), and the tables
come from the selected profile, so the queries follow the same bindings the
property graph does.

`validate` reports on the data as stored. Applying the same rules to the rows a
read sees is the node view's job: a profile that sets
`hydration.constraints: enforce` gets node views that withhold, exclude and
flag by each rule's `on_violation` (see
[Enforcing constraints at consumption time](#enforcing-constraints-at-consumption-time)).
Both parse and compile a rule with the same code, so the violation column below
is also the predicate an enforcing view flags a row with.

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
> The results describe stored data at one point in time; the counts themselves
> filter nothing. What a read sees is decided by the node views: where the
> binding sets `hydration.constraints: enforce`, they apply the rules (next
> section), and push measures and publishes their rates over the served rows.

## Enforcing constraints at consumption time

A binding opts an entity in with one hydration rule, in the model file's inline
binding or in a profile of the `<model>.profiles/` layout (a profile file,
`<model>.profile.<name>.yaml`, may not set `hydration`; see
[Hydration](profiles.md#hydration--reshaping-a-table-into-the-entity)):

```yaml
# pricing.profiles/bigquery.yaml (excerpt)
entities:
  - name: DealPricing
    source: //bigquery.googleapis.com/projects/p/datasets/ps_pricing/tables/deal_pricing
    hydration:
      grain: {deterministic: true}
      constraints: enforce
```

`kcmd bind --enforce-constraints` writes it on every entity whose view would
apply or report a rule. The entity's node view then applies every rule this page
can check, after the other hydration rules, routed on the rule's
`on_violation`:

| The rule | What the node view serves |
|---|---|
| `reject`, about a value (`pattern`, `in`, `value`, `range`, `length`, `empty`, a comparison with another field) | the row, with the failing value withheld (NULL) |
| `reject`, about the record (`required`, or any rule on a key field) | no row: it is excluded |
| `warn` or `escalate` | the row as stored (a read has no approver to escalate to) |
| an allowed set (`sh:in`), any word | a value equal to a member once case and whitespace are ignored, in the member's spelling (`COMPETITIVE PRESSURE` → `Competitive Pressure`); only a value matching no member breaks the rule, and a spelling two members share stays as recorded |
| `cardinality`, `class`, `disjointClasses` | nothing changes: reported, never applied, since excluding a record for a missing or extra edge would cascade across entities |

Every rule a served row breaks — a withheld value's rule included — is named in
the view's `_warnings` column (`ARRAY<STRING>`, empty when the row breaks none),
so a reader can filter clean rows (`ARRAY_LENGTH(_warnings) = 0`) or count one
rule (`'DealPricing_floorPrice_lte_targetPrice' IN UNNEST(_warnings)`).
`_warnings` is a column of the node view; the graph's node properties stay the
modeled fields, so `GRAPH_EXPAND`, GQL and measures read the served values.

A rule on a supertype applies to each subtype's rows, and a rule on a defined
entity applies to its base's rows that its membership predicate selects. Every
rule is checked on the same hydrated, spelling-repaired row, so one rule's
outcome never feeds another's. A rule the view cannot check (its field is not
bound) is listed by push as a warning.

The view is three steps: `hydrated` (the hydration SELECT), `checked` (one
boolean per rule), then the served columns:

```sql
WITH hydrated AS (
  SELECT t.pricing_id, t.floor_price, t.target_price, ... FROM `p.ps_pricing.deal_pricing` AS t
  QUALIFY ROW_NUMBER() OVER (PARTITION BY t.pricing_id ORDER BY FARM_FINGERPRINT(TO_JSON_STRING(t))) = 1
),
checked AS (
  SELECT h.*,
    COALESCE(h.pricing_id IS NULL OR TRIM(CAST(h.pricing_id AS STRING)) = '', FALSE) AS _kcmd_c0,
    COALESCE(h.floor_price IS NOT NULL AND h.target_price IS NOT NULL AND h.floor_price > h.target_price, FALSE) AS _kcmd_c1
  FROM hydrated AS h
)
SELECT
  c.pricing_id,
  IF(c._kcmd_c1, NULL, c.floor_price) AS floor_price,
  c.target_price,
  ARRAY(SELECT w.rule FROM UNNEST([
      STRUCT(c._kcmd_c1 AS broken, 'DealPricing_floorPrice_lte_targetPrice' AS rule)
    ]) AS w WITH OFFSET AS o WHERE w.broken ORDER BY o) AS _warnings
FROM checked AS c
WHERE NOT (c._kcmd_c0)
```

After deploying, push counts each rule over the `checked` rows (and the
reported rules with the queries on this page, over the node views), and the
entity's Knowledge Catalog entry carries the result as a derived paragraph
between `Relationships:` and `Hydration:` (pull drops it; the next push writes
it again):

```text
Constraints: enforced in the node view after hydration; each rule a served row
breaks is named in its _warnings column. Rows excluded: DealPricing_pricingId_required
(none). Values withheld (served as NULL): floorPrice by
DealPricing_floorPrice_lte_targetPrice (50.1%). Flagged only:
DealPricing_pricingConstruct_in (<0.1%). Spelling normalized to the allowed
members: pricingConstruct. Rates are over the 60,700 hydrated rows.
```

When the paragraph would crowd the description, the rules no row breaks fold
into a count (`4 more rules hold on every row.`). The view's own description
names the same rules, without rates.

## Contract tests (`kcmd test`, proposed)

`validate` measures the data. `kcmd test --target bigquery` checks the
**graph**: that what the BigQuery leg deployed does what the model says. Every
test is generated from the model and the selected binding profile, nothing is
written per model, and every statement is a query, so a run creates and
modifies nothing.

```bash
# Write the tests only (no credentials needed).
kcmd test --target bigquery --profile bigquery --sql-only --out contract-tests

# Run them read-only (dry run first) and print pass / fail.
kcmd test --target bigquery --profile bigquery --location US
```

| Flag | Meaning |
|------|---------|
| `--target bigquery` | Required; the only engine. |
| `--profile [name]` | The binding profile whose graph and tables are tested; defaults to `default_profile`, else the inline bindings. |
| `--out <dir>` | Where the files go (default `contract-tests`). |
| `--location <location>` | BigQuery processing location for the query jobs; inferred when unset. |
| `--sql-only` | Write the tests and the manifest and run nothing (also what happens without credentials). |
| `--path-bound <k>` | The `k` of the quantified paths `-[:p]->{1,k}` (default 10, the bound the OWL importer's transitivity hint names). |

### What is tested

| Kind | Generated for | Passes when |
|------|---------------|-------------|
| `defined-membership` (K1) | every defined entity (`definition:`) | the base's rows where the graph property `is<Class>` holds (`MATCH (n:Base) WHERE n.isClass`) are exactly the rows the definition's expression selects over the base's bound tables, compared on the base's key. The reference side is the SQL `validate` uses for the class. |
| `transitive-closure` | every relationship the model marks transitive (its `ai_context.instructions` call it transitive, as the OWL importer writes for `owl:TransitiveProperty`), abstract ones included | the pairs `(a)-[:p]->{1,k}(b)` returns are exactly the pairs a `WITH RECURSIVE` closure returns, up to `k` hops, over the bound join columns of every edge table labelled `p`: the relationship's own and each sub-relationship's (see below) |
| `validation-query` (K4) | every check `validate` plans | the count query runs and the examples query compiles |

A comparison is one statement that returns `actual_rows`, `expected_rows`,
`missing`, `extra` and up to five examples of each difference. Both sides are
reduced to distinct rows: the contract is about which rows come back, not how
many times.

#### Transitive closure over a relationship hierarchy

A sub-relationship's edge table also carries the labels of its ancestors, so a
path over `p` follows the edges of `p` and of every sub-relationship of `p`.
The closure test reads the same edges. Take an org chart where `within` is
abstract and marked transitive, and three sub-relationships extend it:
`inTeam` (Employee to Team), `teamOf` (Team to Division) and `subDivisionOf`
(Division to Division). The test for `within` works like this:

- **Reference side.** `WITH RECURSIVE` walks the union of the three edge
  tables, read from their bound join columns.
- **Graph side.** One quantified path per pair of node tables that some path
  joins: `(a:Employee)-[:within]->{1,k}(b:Team)`,
  `(a:Employee)-[:within]->{1,k}(b:Division)`,
  `(a:Team)-[:within]->{1,k}(b:Division)` and
  `(a:Division)-[:within]->{1,k}(b:Division)`.
- **Node ids.** Nodes compare as `<node table>:<key>`, since a path crosses
  node tables whose keys can collide. Each node table is read on its own.
  Suppose a subtype with a table of its own, such as `Subsidiary` extending
  `Division`, is also an endpoint. Its label is then excluded from the
  parent's (`(a:Division&!Subsidiary)`), so each node is counted under its own
  table.
- **Unbound join fields.** Keys and join columns are physical columns, so push
  keeps an edge table whose join field the profile leaves unbound, and the edge
  table reads the column of that name. The closure test reads the edge the
  same way.

A relationship with no sub-relationships is the one-table case,
`(a:Department)-[:partOf]->{1,k}(b:Department)`.

### What is not tested

An element a generator recognises but cannot test is listed with the reason:
in the console report, at the end of the `.sql` file, and in the manifest's
`skipped[]`. Examples:

- a defined entity whose parent chain does not resolve;
- a transitive relationship that cannot be tested, because:
  - no edge table in the graph carries its label;
  - its edges never chain, so no edge starts at a node table where another
    ends and no path goes past one hop;
  - one of its edge tables is backed by an association table, or declares no
    join columns;
- a constraint `validate` has no query for;
- any graph test when the model declares no BigQuery graph target.

### Enterprise reservation

The membership and closure tests read the graph with `GRAPH_TABLE` and are
flagged `graphQuery`. BigQuery may refuse a graph query because the project has
no Enterprise reservation; such an error names the Enterprise edition or a
reservation. In that case the test is reported `skipped` with the reason `needs
Enterprise reservation`, keeping BigQuery's error, and is not counted as failed.
The same error on a plain SQL test is an `error`.

### Outputs and exit code

`--out` receives, per model:

- `<model>.contract.sql` -- every test's statement under a comment naming it,
  then the elements not tested. Running the file writes nothing.
- `<model>.contract.json` -- the manifest: `model`, `profile`, `generatedAt`,
  `graph`, `tests[]`, `skipped[]` and `warnings[]`. Each test has:
  - `id` (`<kind>:<subject>`), `kind`, `subject` and `description`;
  - `comparison` (`sameRows` | `executes`) and `graphQuery`;
  - `sql`, plus `compileOnly`, `actualSql` / `expectedSql` and
    `resultColumns` where they apply.
- `<model>.contract-results.json` (after a run) -- one record per test:
  - `status` (`pass` | `fail` | `error` | `skipped`), with `reason` and `error`;
  - for a comparison: `actualRows`, `expectedRows`, `missing`, `extra` and
    their examples;
  - for an executed statement: the first row's `values`;
  - `checkedAt`.

Each statement is dry-run first, then the test runs. The command exits 1 when a
test fails or errors and 0 otherwise. This differs from `validate`: there,
violations describe the data, while a failing contract test means the graph
does not do what the model says.

### Adding a family of tests

The families are `ContractTestGenerator`s listed in `CONTRACT_TEST_GENERATORS`
(`src/libts/semantic/contract_tests.ts`). Adding a family means adding a
generator to that list; the planner, the runner, the report, the manifest and
the CLI need no change. A generator:

1. has a stable `kind` (the test-id prefix and the report's grouping) and a
   one-sentence `summary`;
2. reads only the `ContractContext` and never names a model element. The
   context holds:
   - the merged model and the graph's name;
   - the `Binder`, which resolves an entity to its bound rows the same way
     `validate` and the graph leg do;
   - the `GraphShape` of the graph as push deploys it (what the binding
     leaves unbound pruned): node tables, edge tables, each edge table's
     labels, and the shared edge labels;
   - `pathBound`;
3. builds its tests with the exported helpers:
   - `graphTableSql` for the graph side;
   - `sameRowsSql` (with `cte`, `rowKey`, `q`) for a comparison;
   - or a bare statement with `comparison: 'executes'`;
4. sets `graphQuery: true` on a statement that reads the graph with
   `GRAPH_TABLE`, so that a reservation refusal reports the test as skipped;
5. returns a skip with a reason for every element it recognises but cannot
   test;
6. has a golden unit test of its generated SQL. The runner takes an injectable
   query function, so a run can be unit-tested too (see
   `tests/libts/semantic/contract_tests.test.ts`).

Two families have marked places in the list:

- **`derived-edge` (K2).** The actual side reads the derived edge label. The
  expected side follows the edge's explicit multi-hop path. The comparison is
  over source and destination keys.
- **`metric-slice` (K6).** The actual side is `GRAPH_EXPAND` with `AGG`. The
  expected side is the reference SQL aggregate. The comparison is over the
  dimension columns and the rounded measure. `GRAPH_EXPAND` runs on demand, so
  `graphQuery` is false.
