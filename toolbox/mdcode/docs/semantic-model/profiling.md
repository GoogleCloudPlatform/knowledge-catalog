# Profiling the data against BigQuery (proposed)

> [!NOTE]
> `kcmd profile`, `kcmd push --strict-profile`, the `semantic-profile-results`
> aspect type and the `Regime:` note are **proposed** additions. Their names
> may change.

[`kcmd validate`](validation.md) counts violations of the model's **rules**.
`kcmd profile` checks the model's **claims** against the data that the selected
binding profile binds. A claim is what the model's keys, relationships, value
sets, units and time fields say about the data. Each claim becomes a
**statement** with a status and the evidence for it:

| Status | Meaning |
|--------|---------|
| `verified` | The data supports the claim. The evidence holds the counts that show it. |
| `unverified` | The data cannot settle the claim (no rows, no peer to compare with, too few dated values, or the query failed). Or the data only raises a doubt, such as a possible scale mismatch. |
| `contradicted` | The data contradicts the claim. |

```bash
# Write the queries only (no credentials needed).
kcmd profile --profile bigquery --sql-only

# Run them (read-only): print a table, write profiling/profile.{sql,json,md}.
kcmd profile --profile bigquery --location US --label team:data

# Exit 1 when the data contradicts any statement, e.g. in CI.
kcmd profile --profile bigquery --strict

# Print the Knowledge Catalog requests that would publish the statements.
kcmd profile --profile bigquery --publish --dry-run
```

The flags are listed in [Reference → profile](reference.md#profile).

## What gets stated

Each statement is settled by one generated query that returns one row.
Statements about the same table share a query. Rows are read the way `validate`
reads them (see [How classes map to rows](validation.md#how-classes-map-to-rows)),
so a class's instances mean the same thing in both commands.

| Kind | The claim, and where it comes from | Contradicted when |
|------|------------------------------------|-------------------|
| `primaryKey` | The `primary_key` identifies each row of the bound table. | A key column is NULL, or a key repeats. |
| `uniqueKey` | No two rows share a `unique_keys` combination. | A combination with every column set repeats. |
| `cardinality` | A direct foreign-key relationship is many-to-one. It is one-to-one when a constraint restricts the inverse to at most one (see below). | A source row reaches more than one destination row, so the referenced key repeats. For a one-to-one relationship, also when a destination row is reached by more than one source row. |
| `orphans` | Every foreign-key value that is set matches a destination row. | A value matches no row. |
| `enumCoverage` | A field with an `sh:in` constraint takes only the declared values. | A non-null value is outside the set. |
| `unitMagnitude` | A numeric field with a `unit` is in that unit and `scale`. | Never. See [Units](#units). |
| `regimeShift` | A numeric field of an entity with a time field keeps one scale over time. | The scale breaks and no regime explains it. See [Scale over time](#scale-over-time). |
| `requiredNulls` | A required field is set: `sh:minCount 1`, or OWL `some`, `min 1` or `exactly 1` on a field. | A row has NULL. |

The `cardinality` claim:
- It is one-to-one when an OWL `max 1` or `exactly 1` through the inverse name
  restricts the destination entity itself. The same restriction on a subtype
  of the destination claims less, so it does not count.
- A forward `max 1` (`sh:maxCount 1`, or an OWL `FunctionalProperty`) restates
  the many-to-one. That constraint is named as the claim's origin.

**Evidence.** Each statement carries the counts behind its status:
- keys: rows, null keys, distinct keys, and the most repeated keys;
- relationships: rows with a foreign key, rows that fan out, the most rows one
  destination receives, orphan rows, the orphan rate, and the most frequent
  orphan values;
- value sets: the share of values outside the set, the top offenders, and the
  declared values that never occur;
- required fields: the NULL count and rate.

**Unverified statements.** A statement is `unverified` when its query returns
nothing to judge: an empty table, or no row that sets the foreign key or the
field. It is also `unverified` when the query failed; the error is kept with
the statement.

**Which constraints make statements.** Value sets, required fields and declared
cardinalities are carried by constraints. They are recognized from the
importers' provenance notes, as in
[What gets checked](validation.md#what-gets-checked). Any other rule (a
pattern, a range, a hand-written judgment) is for `validate` to count and makes
no statement. `requiredNulls` counts NULLs only, whereas `validate`'s
`required` check also counts blank strings.

### Units

Fields that share a `unit` and `scale` are peers. A unit matches whatever its
case, and a field with no `scale` has scale 1.

For each field, the query takes the median of `ABS(value)`, leaving zeros out.
That median is compared with the median of the peers' medians:
- `--magnitude-orders` (default 2) or more orders of magnitude apart:
  `unverified`, with "possible scale mismatch";
- closer than that: `verified`;
- no peer, or no non-zero value: `unverified`.

A magnitude raises a doubt, never a contradiction, because a field can
legitimately be much larger than its peers.

### Scale over time

**The time field.** An entity's time field is the first of these that exists:

1. the field that `history.valid_from` names;
2. a date field that the `grain` names, as a whole word;
3. a field marked `dimension.is_time: true`;
4. the first `Date`, `DateTime` or `DateTimeTz` field.

Only bound fields count, and a field marked `is_time: false` never does.

**The measured fields.** Every other numeric field is measured: `Integer`,
`Decimal` or `Float`, or an untyped field with a `unit`. Key, unique-key and
join columns are left out.

**Windows.** Rows are grouped into windows of `--window-months` (default 3)
calendar months of the time field. A `TIMESTAMP` is cast to a `DATE`, which
uses UTC. A window counts when it has at least `--min-window-rows` (default
30) non-zero values. Neighbouring windows are consecutive windows that count,
so a gap does not split the series.

**The status.** Each window's median of `ABS(value)` is compared with the next
window's:
- they differ by a factor of `--shift-factor` (default 50) or more, and no
  regime is declared: `contradicted`;
- the same break with a declared regime: `verified`, quoting the regime;
- no such break: `verified`;
- fewer than two windows count: `unverified`.

#### Declaring a regime: the `Regime:` note (proposed)

A line that starts with `Regime:` declares a known change of scale or meaning.
Put it in a field's `description` or `ai_context.instructions`. The prefix is
matched case-insensitively.

```yaml
- name: total
  datatype: Decimal
  unit: USD
  description: |-
    Order total.
    Regime: recorded in cents until 2020-12, in dollars since 2021-01.
```

On an entity, the line covers the fields it names. If it names none, it covers
every field.

The note changes nothing else: no generated SQL, no entry, no description
trailer. It is a convention, not a key. It lives in one constant
(`REGIME_PREFIX` in `profile_bigquery.ts`), so it is easy to rename or to
replace with a native key.

### What is not profiled

Claims that have no query are listed with the reason: at the top of
`profile.sql`, under "Not profiled" in `profile.md`, and in `profile.json`'s
`skipped`. They are:
- a key of an entity with no bound table;
- a relationship with no join columns, or one backed by an association table;
- a unit or a required rule on a field that the profile leaves unbound.

An abstract relationship has no join of its own, so it is not profiled; its
sub-relationships are profiled instead.

## Outputs

`--out` (default `profiling`) receives three files:
- `profile.sql`: every query once, runnable as-is. Each query follows a comment
  for every statement it settles (`-- [id] kind: statement`). The claims that
  are not profiled are listed at the top.
- `profile.json` (after a run): `profile`, `checkedAt` and `models[]`. Each
  model holds:
  - `model`;
  - `options`: the thresholds used;
  - `summary`: the count per status;
  - `statements[]`: `id`, `kind`, `entity`, `field`, `statement`, `origin`
    (`model`, `SHACL` or `OWL`), `constraint`, `status`, `summary`, `evidence`,
    `error` and `sql`;
  - `skipped[]` and `warnings[]`.
- `profile.md` (after a run): for each model, a summary line and a table of
  status, kind, subject, statement and evidence, worst status first.

The console prints the same table for each model (status, kind, subject,
summary), followed by the totals.

Each query runs once, at most six at a time. The queries only read. Jobs run
in `--project` (default: the gcloud project), in `--location` when it is
given, and carry every `--label`.

Exit codes:
- **1** on a usage or load error, when a query could not run, or when
  publishing failed. With `--strict`, also when the data contradicts any
  statement.
- **0** otherwise: the statuses are a report about the data, not a failure.

## Publishing to Knowledge Catalog

`--publish` writes the statements onto the entity entries that `kcmd push`
publishes. They go in one aspect of type
`projects/<project>/locations/global/aspectTypes/semantic-profile-results`,
beside `validate`'s `semantic-constraint-results`. The aspect type is created
in the scope's project the first time it is needed.

Each entity's aspect holds `model`, `profile`, `checkedAt`, the counts
`verified`, `unverified` and `contradicted`, and a `statements[]` array with
one record per statement on that entity:

```json
{
  "id": "Order_status_required",
  "statement": "Every Order has a value for Order.status.",
  "kind": "requiredNulls",
  "status": "verified",
  "summary": "all 5000 row(s) have a value",
  "evidence": "{\"total\":5000,\"nulls\":0,\"nullRate\":0}",
  "field": "status",
  "constraint": "Order_status_required",
  "sql": "WITH focus AS (...) SELECT COUNT(*) AS total, COUNTIF(status IS NULL) AS nulls_0 FROM focus"
}
```

`evidence` is the statement's evidence from `profile.json`, as a JSON string.
If an entity's aspect would grow past about 100 KB, the queries are left out
and `sqlOmitted` is set.

As with `validate`, the update names only this aspect, so the entry's other
aspects are untouched. Run `kcmd push` first: an entity entry that does not
exist is reported, not created.

`--publish --dry-run` prints the requests and sends nothing:
- the aspect-type request, which is sent only when the type does not exist yet;
- each entry `PATCH …?updateMask=aspects&aspectKeys=<project>.global.semantic-profile-results`,
  with its body.

## Gating a push (proposed)

`kcmd push --strict-profile` profiles each model before its BigQuery graph is
deployed. It reports the same statements as `kcmd profile`, with the default
thresholds. The gate runs after the other BigQuery pre-flight checks (see
[Reference → Validation](reference.md#validation)).

When the data contradicts any statement, the push lists those statements and
stops before the deploy. Unverified statements never block, including those
whose query failed: the gate stops data known to disagree with the model, not
data it could not settle.

The queries only read, so the gate also runs under `--validate-only`. It does
not apply in two cases, and says so with a warning:
- a Spanner graph, which it does not profile;
- `--no-profile`, which deploys no graph.

## Permissions

- `bigquery.jobs.create` in the job project.
- Read access (`bigquery.tables.getData`) on every bound table.
- With `--publish`:
  - `dataplex.aspectTypes.create` in the scope's project, on the first run
    only;
  - `dataplex.entries.update` on the entry group;
  - `dataplex.aspectTypes.use` on `semantic-profile-results`.

> [!IMPORTANT]
> Like `validate`'s results, the statements describe stored data at one point
> in time. Nothing uses them as a filter: the property graph, queries, skills
> and action guards read the model, never these statuses.

## Not yet

- **Scale normalization.** Units are compared within one `unit` and `scale`.
  A possible next step is to normalize by `scale`, so that a field stored in
  cents can be compared with fields stored in dollars.
- **More relationships.** Association-table relationships are not profiled.
  Neither are cardinalities qualified by a class (`sh:qualifiedValueShape`, or
  OWL `max 1 X`); `validate` counts those.
- **Other engines.** BigQuery only; a Spanner or AlloyDB binding is not
  profiled.
