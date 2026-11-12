# What push and pull preserve

Your model document is the source of truth. Pushing it — to Knowledge Catalog
and to a property graph in BigQuery or Spanner — and pulling it back are each
**lossy in specific ways**. The catalog keeps metadata, the graph keeps what it
can query, and `pull` can only return what the catalog was given. This page is
the one authoritative map of what survives each direction. Keep your authored
document.

Which backend a push deploys to — BigQuery or Spanner — is set by each entry's
`target` in `deployments`, and which binding feeds it is set by that entry's
`profile`; neither is a backend flag on the command line (see
[Reference → push](reference.md#push) for `--deployment` and
`--no-deployment`). Each destination has its own section below, starting with
[To Knowledge Catalog](#to-knowledge-catalog).

## The round-trip matrix

Rows are what you authored; columns are its fate in each direction. `✓` = comes
back as authored, in the normal forms that
[What pull recovers](#what-pull-recovers) lists; `—` = not present in that
destination. Footnotes carry the
nuances that don't fit a cell. BigQuery and Spanner each get a column; they
agree on every structural row and differ only where a Spanner target has no
`MEASURE` and no `OPTIONS` metadata, and in which SQL text a field reads — see
[To Spanner](#to-spanner).

| Authored element                                               | → Knowledge Catalog             | Recovered by `pull`                            | → BigQuery                                                           | → Spanner                                                            |
|----------------------------------------------------------------|---------------------------------|------------------------------------------------|----------------------------------------------------------------------|----------------------------------------------------------------------|
| Entity (name, `source`)                                        | `semantic-entity` entry¹⁰       | ✓                                              | `NODE TABLE`                                                         | `NODE TABLE`                                                         |
| Field                                                          | `schema` aspect field           | ✓ (type²)                                      | column on the node table¹                                            | column on the node table¹                                            |
| Field `label`                                                  | `schema` per-field annotation   | ✓                                              | into `OPTIONS(description)`                                          | — dropped                                                            |
| Field expression (canonical SQL)                               | `sql-expressions` aspect³       | ✓³                                             | builds the DDL                                                       | builds the DDL                                                       |
| Field dimension role (`is_time`)                               | `schema` per-field `semantic`³  | ✓³                                             | noted in `OPTIONS(description)`                                      | — dropped                                                            |
| Primary key                                                    | `semantic-entity.primaryKey`    | ✓                                              | `KEY(...)` on the node table                                         | `KEY(...)` on the node table                                         |
| Unique keys                                                    | `semantic-entity.uniqueConstraints` | ✓                                              | — dropped                                                            | — dropped                                                            |
| Metric                                                         | `semantic-metric` entry         | ✓ (type⁵)                                      | `MEASURE`⁴                                                           | — dropped (no `MEASURE`)                                             |
| Relationship                                                   | `semantic-relationship` entry¹⁵ | ✓⁶                                             | `EDGE TABLE`                                                         | `EDGE TABLE`                                                         |
| Entity `extends`                                               | `semantic-entity.extends`       | ✓                                              | `LABEL` clauses + flattened fields                                   | `LABEL` clauses + flattened fields                                   |
| Action                                                         | `semantic-action` entry¹²       | ✓¹²                                            | — not deployed¹²                                                     | — not deployed¹²                                                     |
| Constraint                                                     | `semantic-constraint` entry¹³   | ✓¹³                                            | — not deployed¹³                                                     | — not deployed¹³                                                     |
| `description` (entity / metric / field / relationship)         | entry description / `schema`    | ✓                                              | `OPTIONS(description)`                                               | — dropped                                                            |
| `ai_context.synonyms`                                          | `semantic-*` aspect / `schema`  | ✓                                              | `OPTIONS(synonyms=[...])`                                            | — dropped                                                            |
| `ai_context.instructions`                                      | `guidelines` aspect⁷            | ✓⁷                                             | `OPTIONS(extensions=[("instructions", ...)])`                        | — dropped                                                            |
| `ai_context.examples`                                          | `overview` aspect               | ✓                                              | `OPTIONS(extensions=[("examples", ...)])`                            | — dropped                                                            |
| Model-level `description` / `instructions`                     | on the model entry              | ✓⁸                                             | — dropped⁸                                                           | — dropped⁸                                                           |
| Model-level `ai_context.synonyms` / `examples`                 | `semantic-model` / `overview`   | ✓                                              | — dropped                                                            | — dropped                                                            |
| `deployments` (`name`, `target`, `profile`)                    | recorded on the model entry     | ✓                                              | names the graph                                                      | names the graph                                                      |
| Binding profile (`<model>.profile.<name>.yaml`)                | on the model's entries¹⁴        | ✓¹⁴                                            | one graph per BigQuery deployment                                    | one graph per Spanner deployment                                     |
| Vendor-dialect `expression` variant (non-canonical `dialects[]` entry)¹¹ | `sql-expressions` aspect | ✓                                              | — not used; a field or metric with only vendor text is left out     | — not used; a field with only vendor text is left out               |
| `custom_extensions` from a vendor other than GOOGLE            | `semantic-extensions` aspect⁹   | ✓⁹                                             | — not in graph                                                       | — not in graph                                                       |

1. **Field type source.** The graph uses the source column's own type; a
   field's authored `datatype` is not carried.
2. **Field type.** Every concrete type round-trips. Push stores a field with
   no `datatype` as `dataType` `Opaque`, and `pull` writes no `datatype` for an
   `Opaque` field, so a field typed `Opaque` comes back untyped.
3. **Expressions and dimension role.** Push stores each field's expression in
   its entity's `sql-expressions` aspect, and its dimension role and `is_time`
   in the `schema` aspect, and `pull` rebuilds both from there.
4. **Metric shape.** A metric must resolve to exactly one entity, or the push
   is rejected. It must also read every field inside `SUM`, `AVG`, `COUNT`,
   `MIN` or `MAX`, each over one operand, and scalar SQL may combine them, as
   in `SUM(orders.amount) / COUNT(orders.order_id)`. Otherwise the push is
   rejected.
5. **Metric type.** A metric's data type round-trips as a field's does (see
   footnote 2): an untyped or `Opaque` metric comes back untyped.
6. **Relationship name.** A relationship's name is the last segment of its
   entry id, `<model>/relationships/<relationship>`, so it comes back as
   written.
7. **Guidelines aspect.** The `guidelines` aspect holds the
   `ai_context.instructions` and the custom `ai_context` members of the model,
   an entity, a field, a metric or a relationship. A field's `guidelines`
   aspect sits on its entity's entry at `Schema.<field>`. Push leaves out a
   custom member whose value Knowledge Catalog cannot store as written, such as
   `.inf`, and warns.
8. **Model-level metadata.** Neither graph has a home for statement-level
   metadata — BigQuery silently drops graph-statement `OPTIONS`, and Spanner
   carries no `OPTIONS` at all — so the model's `description` and
   `ai_context.instructions` are carried into Knowledge Catalog instead.
9. **Other custom extensions.** A `custom_extensions` block from a vendor other
   than GOOGLE goes, as written, into the `semantic-extensions` aspect of the
   model, entity, field, metric or relationship that declares it, and `pull`
   writes it back. The graphs leave it out.
   The OWL importer emits none:
   it is import-only (see [Importing an OWL ontology](owl-import.md)).
10. **Logical (unbound) model.** A model with no bindings still publishes to
    Knowledge Catalog. An entity with no `source` gets an entry whose
    `semantic-entity` aspect records no source, and a relationship with no join
    columns still gets its entry and its links.
11. **Vendor-dialect fallback.** What you author is the `expression.dialects[]`
    list using one of the supported SQL dialects (see
    [Model spec §2.5](model_spec.md#25-expressions)).
    `importedExpression` / `importedDialect` are not
    authored keys — the loader *derives* them from a non-canonical dialect entry
    (for example the `SNOWFLAKE` or `DATABRICKS` form a metric was imported
    from). `kcmd import
    --transpile` adds a `BIGQUERY` dialect entry to a model file's field or
    metric, translated from a vendor-only expression or from an `ANSI_SQL`
    expression that double-quotes column names, when it can translate the
    text. It does the same in each
    profile the import writes, when all of that profile's tables are in
    BigQuery or BigLake. Without the translation, kcmd warns about
    either kind of text on a BigQuery table. Spanner, MySQL and Databricks
    also read a double-quoted name as text, so kcmd warns about that kind on
    their tables, apart from a Spanner table in a PostgreSQL-dialect database,
    which push, `kcmd profiles` and import judge as `POSTGRES` once they read
    its database's dialect.
    On a table in another database, it warns about a field or metric with no
    text that table runs. Push rejects such a field in the model file with an
    error in place of the warning. `kcmd import` gives push's message in place
    of the warning on an AlloyDB table, and on a Cloud SQL, Spanner or
    third-party table whose dialect it reads as push does. When a profile binds
    that table, push rejects the field or metric instead. When import cannot
    read a table's dialect, it warns and skips the checks that need it.
    `kcmd skills-generate` and `kcmd profiles --print-store` do not look up a
    third-party table's dialect for their warnings, and they read a Spanner
    table as `SPANNER`. The check `--print-store` runs on the named profiles
    reads each table's dialect as push does.
    Import reads a Cloud SQL table it cannot look up as MySQL when the name has
    no schema. On any
    other table whose dialect a command has not looked up, kcmd warns only about
    a field or metric with no text in any dialect the table's name allows. A
    BigQuery
    graph reads a field's or metric's `BIGQUERY` entry, else its `ANSI_SQL` one. It never emits the
    vendor text. A field with none of these is left out of its node table with
    a warning, though push rejects such a field in the model file first. A
    metric with none, or one that aggregates such a field, is
    skipped with a warning. A Spanner graph reads a field's `SPANNER` entry,
    else its `ANSI_SQL` one, and leaves out a field with neither. See
    [Model spec §2.5](model_spec.md#25-expressions).
12. **Actions.** An action reaches Knowledge Catalog only, as one
    `semantic-action` entry under the model entry, and `pull` reads it back from
    that entry. Every other push target deploys nothing for it and warns once.
    Its `guards` are stored as constraint names and round-trip verbatim. A name
    whose constraint is absent from a pull is kept rather than dropped, so a
    partial pull never silently rewrites the author's model; the pull warns
    about the name it kept, and a push rejects the model until the constraint
    is back. A name the aspect repeats is the one exception, dropped to its
    single occurrence because the loader rejects a repeat and the document has
    to stay loadable. Its `affects` round-trips the same way, with the same
    exception for a repeated concept-and-operation pair. See
    [Modeling write operations](actions.md).
13. **Constraints.** A constraint reaches Knowledge Catalog only, as one
    `semantic-constraint` entry under the model entry, and `pull` reads it back.
    Every other push target deploys nothing for it and warns once. Publishing is
    all that push does with a constraint; what settles one is a run, and the
    runtime an application embeds is what puts each guard to a judge before the
    write.
14. **Binding profiles and deployments.** A model may define several physical
    realizations in sibling `<model>.profile.<name>.yaml` files and reference
    them from `deployments` (see [Binding profiles](profiles.md) and
    [Reference → push](reference.md#push)); two deployments claiming the same
    target are rejected before anything deploys. Push records each named
    profile and what it binds on the model's entries, and `pull` rebuilds one
    profile file per named profile from them. The catalog stores no profile's
    actions, so a pulled profile file keeps the actions the local one binds.
15. **Relationship entries and links.** Each relationship gets its own entry.
    A `semantic-link` joins each ordered pair of related entities and lists
    their relationships in declaration order, so several relationships between
    the same two entities share one. A `reference` link runs from each
    relationship's entry to each of its two entities. Pull reads each
    relationship from its entry and reads no link.

## To Knowledge Catalog

The catalog holds the model's metadata. Every resource type it uses is a
built-in system type under `dataplex-types/global`, apart from the custom
`semantic-action` and `semantic-constraint` pairs that `kcmd init`
provisions. A push references those types and never creates them (see
[Reference → What gets created in Knowledge Catalog](reference.md#what-gets-created-in-knowledge-catalog)).

Every push publishes the model file as written to Knowledge Catalog: every
entity, metric, and relationship the document declares. A `pull` rebuilds the
model and profile files from that metadata alone, and changes a local file only
where it differs (see [What pull recovers](#what-pull-recovers)).

A logical model still produces complete entries (footnote 10).

**Model file and sibling profile files.** A model may define several physical
realizations — an analytical binding onto BigQuery (`<model>.profile.analytical.yaml`)
and an operational one onto Spanner (`<model>.profile.operational.yaml`), say —
and list both in `deployments`. Push records each named profile in the catalog
metadata, and `pull` rebuilds the profile files from it (footnote 14; see
[Reference → push](reference.md#push)).

**Actions** follow the same one-entry-per-element rule as everything else: each
becomes a `semantic-action` entry under the model entry, carrying its executor,
typed parameters, `guards`, and `affects` in a `semantic-action` aspect. They
round-trip losslessly through `pull` (name, description, executor, typed
parameters, `guards`, `affects`, and `instructions`). A parameter projected
from a field round-trips as the projection it was authored as: the aspect
stores `concept` and `field` alongside the resolved scalar `type`, and a pull
writes the projection back out without the type, so re-loading resolves it from
the same field and arrives at the same parameter. Two things about a projection
do not survive the trip. Its `label` and `ai_context` are dropped — the aspect
has nowhere to put them, so a pull recovers the parameter's `description` and
not those two. And the wording a pull does recover comes back as the
parameter's own: the loader resolves an inherited `description` into the
parameter when the model loads, and nothing downstream can tell that apart from
one the author typed, so a pulled document states it where the original left it
to the field. Re-loading gives the same parameter, but the field and the
parameter now each hold a copy, and changing the field no longer moves it.
A projection whose field is not in the pulled document comes back as a
declared parameter carrying the resolved `type` instead, since emitting a
`concept`/`field` pair that resolves to nothing would write a document that will
not load. A `sql` executor
round-trips its `statements` with the rest: they are the
write, not a note about it, so a catalog that dropped them would describe an
action nobody could re-deploy. The entry type is custom, so `kcmd init` creates
it; a model that declares no action never needs it.

What an action affects round-trips as a fact, not as the text it was authored
in. The two authored shapes — the bare name and the record — are one shape in
the model, so a record carrying nothing but a concept (`- concept: Account`)
comes back as the bare `Account`, which says the same thing. Everything after
that first pass is byte-for-byte stable.

`affects` stores only what the author wrote, which is why it survives a partial
pull intact. Whether a `concept` is an entity or an edge is not recorded, so
nothing about it has to be re-resolved, and nothing can go stale.

**Constraints** publish the same way: each becomes a `semantic-constraint` entry
under the model entry, with the rule and any `instructions` in a
`semantic-constraint` aspect and the `description` as the entry's own summary.
Name, description, `on_violation`, `severity`, instructions, and whichever body
states the rule — `expression` or `judgment` — round-trip losslessly through
`pull`. A constraint that declares neither routing word comes back without them
rather than with a default filled in. The aspect also carries a derived
`evaluation` field, `deterministic` or `judged`, which a pull recomputes from
the body rather than reading, so it can never come back disagreeing with the
rule beside it; it is not written into the authored document, because a derived
value in an authored file is a value that can go stale. An entry that states
both bodies, or neither, is skipped with a warning rather than pulled into a
model that would then fail its own push. That entry type is custom too, and a
model that declares no constraint never needs it.

## To BigQuery

Push preserves both the queryable structure and the descriptive metadata attached
to it. The structure becomes the node tables, edge tables, and measures; the
descriptive metadata is written into each element's `OPTIONS(...)` in the graph
(visible with `--print`).

BigQuery's graph `OPTIONS` give an element a `description` string, a `synonyms`
array, and an `extensions` array of `(key, value)` string pairs. `synonyms`
carries across structurally as `synonyms=[...]`. `ai_context.instructions` and
`ai_context.examples` carry across in `extensions=[...]` as
`("instructions", "...")` and `("examples", "[...]")`, with `examples`
serialized as a JSON array string. Custom `ai_context` members stay out of the
DDL. A field's `label` and temporal-dimension marker have no dedicated option,
so they still combine with the field's `description` in `OPTIONS(description)`.

The model's own statement-level metadata has nowhere to go: BigQuery silently
drops graph-statement `OPTIONS`, so the model's `description` / `ai_context` are
not in the graph — the `description` and `ai_context.instructions` are carried
into Knowledge Catalog instead. Of an entity's keys only its primary key is
emitted as `KEY(...)`; `unique_keys` are dropped. The imported vendor SQL is
never emitted. `kcmd import --transpile` adds a `BIGQUERY` entry to a model
file's field or metric whose expression is vendor-only or an `ANSI_SQL`
expression that double-quotes column names, when it can translate the text. It
does the same in each profile the import writes, when all of that profile's
tables are in BigQuery or BigLake.
The graph builds each field and metric from its `BIGQUERY` entry, else its
`ANSI_SQL` one. A field with none of these is left out of its node table with a warning,
though push rejects such a field in the model file first. A
metric with none, or one that aggregates such a field, is skipped with a
warning.

### What import translates to BigQuery

`kcmd import --transpile` sees only the SQL text. So it translates only common
SQL that gives the same value in BigQuery for ordinary data, whatever the
column types are. It translates aggregates, CASE, COALESCE and other NULL
handling, arithmetic beside a number or a SUM, COUNT or AVG, most comparisons,
basic casts, and a few string and date functions. Its warning about any other
text names the first part it does not translate. It names a function and a
date part as the author wrote them, such as `CHAR_LENGTH` or `DATEPART` with
part `w`.

It reads each database's SQL under that database's default settings:
PostgreSQL, MySQL, SQL Server and Databricks in UTC, Snowflake in
America/Los_Angeles with TIMESTAMP read as TIMESTAMP_NTZ, and Spanner in
America/Los_Angeles. A database set up another way can need its `BIGQUERY`
entries edited by hand.

It translates a date or time plus or minus an amount of one unit. The value
can be a column, a cast to DATE, a DATE literal, the current date, the current
timestamp, a cast to a timestamp type where the list below names one, or,
where the list allows, another such sum. MIN or MAX of such a value gets what
the value gets, as does Snowflake's DATE_TRUNC, whose value keeps the type of
its date. Each way a database writes the same sum gets the same BigQuery
value and type: `+` or `-` with an INTERVAL, a function such as DATE_ADD,
ADDDATE, DATEADD or TIMESTAMPADD with any unit name the database documents, or
a whole number of days. The
amount is a whole number. In a function and in MySQL's INTERVAL it can also be
an expression, such as a column, which import writes as it is. BigQuery rejects
an amount that is not an INT64, where the database may round it. An amount
that is visibly an INTERVAL, such as `3 * INTERVAL 1 DAY` in Databricks'
date_add, stays untranslated, as the database rejects it. SQL Server's
DATEADD reads a string of a whole number, such as '1', as the number. A column
can be a DATE, a DATETIME or a TIMESTAMP in BigQuery, so import adds to a column
only the units that keep the value and type of each. It also adds months,
quarters and years to a column, which BigQuery rejects for a TIMESTAMP column.
From MySQL, Snowflake, Databricks and SQL Server it adds a week to a column as
7 days, which BigQuery's DATE_ADD also adds to a TIMESTAMP. An amount n of weeks
that is an expression becomes `7 * (n)` days. These are the units it adds, by
database. Milliseconds and microseconds go wherever seconds go, where the
database names them: PostgreSQL, Snowflake and Databricks name both, and MySQL
names microseconds.

- MySQL: every unit from seconds to years to a column and to a value it can
  see is a DATE, such as the current date.
  It writes NOW(), CURRENT_TIMESTAMP, LOCALTIMESTAMP and LOCALTIME as
  DATETIME_TRUNC(CURRENT_DATETIME('UTC'), SECOND), a DATETIME in whole seconds
  as in MySQL, and adds every unit to it.
  A date or a time it can see, compared with a number or plus or minus a
  number, counts as the number of its digits, as in MySQL: `CURDATE() + 1`
  becomes `CAST(FORMAT_DATE('%Y%m%d', CURRENT_DATE) AS INT64) + 1`. A
  COALESCE, IF or CASE counts so only when each value it can give is visibly a
  DATE, or each a DATETIME.
  A sum that names its INTERVAL first adds it to all that follows, as MySQL
  does, so `INTERVAL 1 MONTH + CURDATE() - INTERVAL 1 DAY` subtracts the day
  first. A compound unit, such as HOUR_MINUTE in `INTERVAL '1:30'
  HOUR_MINUTE`, becomes one INTERVAL per part, read from a number or a string
  by MySQL's rules: fewer numbers fill the smallest parts, and the digits of
  microseconds are a fraction of a second. The parts are then added as a sum
  of INTERVALs is, below.
- PostgreSQL: every unit to a column, to a DATE and to a DATE plus an
  INTERVAL, and to the current timestamp, which stays a TIMESTAMP. A cast to
  timestamp gets what a DATE plus an INTERVAL gets, and a cast to timestamptz
  what the current timestamp gets. A DATE plus
  an INTERVAL gives a DATETIME, as it gives a timestamp in PostgreSQL. Months
  and years go to the current timestamp as a DATETIME in UTC, which BigQuery
  reads back as a TIMESTAMP: `NOW() + INTERVAL '1 month'` becomes
  `TIMESTAMP(DATETIME(CURRENT_TIMESTAMP(), 'UTC') + INTERVAL 1 MONTH, 'UTC')`.
  An INTERVAL string can name several units, such as '1 day 2 hours', and
  decades, centuries and millennia, which count as 10, 100 and 1000 years. A
  cast to INTERVAL with fields, such as `'90 minutes'::interval hour`, and
  `INTERVAL '90 minutes' HOUR` become the INTERVAL PostgreSQL computes, here
  `INTERVAL 1 HOUR`.
- Snowflake: every unit from seconds to years to a column and to a DATE. It
  writes CURRENT_TIMESTAMP as CURRENT_DATETIME('America/Los_Angeles') and adds
  days, weeks, months, quarters and years to it. An INTERVAL string
  names at most days, and DATEADD names any unit. A cast to TIMESTAMP or
  TIMESTAMP_NTZ, and a value plus hours, minutes or seconds, is a
  TIMESTAMP_NTZ, a DATETIME in BigQuery, and gets every unit.
- Databricks: days, weeks, months and years to a column and to a DATE.
  date_add, date_sub and two-argument dateadd give a DATE, as in Databricks.
  timestampadd, and three-argument dateadd and date_add, such as
  `dateadd(HOUR, 3, d)`, add every unit to a DATE or the current timestamp,
  which they read as a TIMESTAMP, and nothing to a column, which can keep its
  TIMESTAMP_NTZ type. timestampdiff counts days and smaller units, and weeks
  of 7 days, as BigQuery's TIMESTAMP_DIFF does between TIMESTAMP(x) values.
  Databricks counts months, quarters and years by the calendar, so those stay
  untranslated.
  Seconds, minutes and hours go to TIMESTAMP(x) of a DATE, its midnight in
  UTC, which gives a TIMESTAMP as in Databricks. It adds seconds, minutes,
  hours, days and weeks to the current timestamp, a TIMESTAMP, and months and
  years to it as a DATETIME in UTC, as from PostgreSQL.
- SQL Server: days, weeks, months, quarters and years to a column and to a
  date, such as a cast to date or CURRENT_DATE, and minutes and hours to a
  column, which BigQuery rejects for a DATE column, as SQL Server rejects them
  for a date. Seconds stay untranslated on a column, since SQL Server ignores
  -30 to 29 seconds added to a smalldatetime. It writes GETDATE() and
  CURRENT_TIMESTAMP as CURRENT_DATETIME('UTC'), a DATETIME as in SQL Server,
  and adds every unit to it. A number added to it counts days, as in SQL
  Server. Its fraction becomes the hours, minutes, seconds or milliseconds it
  holds, so `GETDATE() + 1.25` adds 30 hours. A fraction that is not whole
  hundredths of a second stays untranslated, since SQL Server rounds it to
  1/300 of a second.

From PostgreSQL, Snowflake and Databricks, a whole number added to a DATE
counts as days. Added to a DATE that COALESCE, IF or CASE gives, such as
`COALESCE(d, CURRENT_DATE) + 1`, it stays as written. A column plus a whole
number, such as `(d + 1) + INTERVAL '1 day'`, gets an INTERVAL as a DATE does.
None of the three adds an INTERVAL to a number or a whole number to a
timestamp, and BigQuery does neither. Import
translates no date arithmetic from ANSI_SQL, since the databases an ANSI_SQL
text runs on add a unit as different types. From a SPANNER text it keeps
DATE_ADD, DATE_SUB, TIMESTAMP_ADD and TIMESTAMP_SUB, and weeks, days, hours and
minutes added with `+` or `-`, which BigQuery adds as Spanner does. A week is
7 days in both. The amount is a whole number or an expression, such as
`INTERVAL (1+1) DAY`. EXTRACT takes an INTERVAL of any unit, since Spanner and
BigQuery give its parts the same way. From the other databases, import leaves
any other date arithmetic untranslated, such as an INTERVAL of a fraction,
or a function such as COALESCE plus an INTERVAL.

From PostgreSQL and Databricks, import also translates a sum or difference of
INTERVALs, such as `INTERVAL '1 day' + INTERVAL '2 hours'`, and an INTERVAL
times an amount. Alone, it becomes BigQuery's INTERVAL sum as written. Added
to a value, it gets the form and type that its smallest unit gets in the list
above. Where that form is `+`, import keeps the sum as written, and each of
its units must be one the list adds to the result. A sum with months or years
on the current timestamp goes to its DATETIME in UTC as a whole. BigQuery then
adds months first, then days, then time, as PostgreSQL and Databricks do.
Where that form is DATE_ADD, the INTERVALs must add up to one amount of their
smallest unit, so they must all be months and years, or all be weeks and
smaller units. An INTERVAL times a whole number adds the product. Times
another amount n, the sum is an expression of n, such as `(-36 + (n))` months,
which BigQuery rejects unless n is an INT64. Databricks multiplies weeks and
smaller units into seconds, so `current_date() + 3 * INTERVAL 1 DAY` gives a
TIMESTAMP and becomes `TIMESTAMP(CURRENT_DATE) + 3 * INTERVAL 1 DAY`.
Databricks' `CURRENT_DATE + (INTERVAL 1 MONTH + INTERVAL 1 YEAR)` becomes
`DATE_ADD(CURRENT_DATE, INTERVAL 13 MONTH)`. A Databricks sum joins months and
years, or weeks and smaller units, as Databricks does. A single INTERVAL
alone stays untranslated. So does AVG of an INTERVAL and an INTERVAL divided
by a number, since BigQuery rounds them down to whole microseconds. PostgreSQL
and Databricks round to the nearest microsecond, and Databricks gives a
year-month INTERVAL in whole months.

From PostgreSQL and Databricks, a DATE or a DATETIME that import can see
beside a TIMESTAMP, compared with it or as a result of one COALESCE, IF or
CASE, gets TIMESTAMP(x), its midnight or wall-clock time in UTC, as those
databases read it: `CURRENT_DATE - 7 < NOW()` becomes
`TIMESTAMP(DATE_SUB(CURRENT_DATE, INTERVAL 7 DAY)) < CURRENT_TIMESTAMP()`.

BigQuery rejects a translated field when a column's BigQuery type is not the
one the expression needs, such as a DATETIME column compared with PostgreSQL's
NOW(), a TIMESTAMP column compared with MySQL's NOW(), or a TIMESTAMP column
plus a month. Then edit that field's `BIGQUERY` entry.

The BigQuery value can differ from the source's value in these cases:

- A decimal, boolean or timestamp column joined into text takes BigQuery's
  text format, such as '12.5' for 12.50.
- A MySQL date column plus a number gives a date in BigQuery where MySQL gives
  a number.
- A Snowflake TIMESTAMP_LTZ or TIMESTAMP_TZ column plus or minus days or weeks
  can be an hour off across a daylight saving change. Snowflake adds a day in
  its default time zone, America/Los_Angeles, where BigQuery adds 24 hours.
- A MySQL TIMESTAMP column plus or minus a unit of a week or less gives a
  DATETIME in MySQL and a TIMESTAMP in BigQuery, with the same value in UTC.
- MySQL's NOW() counts whole seconds and SQL Server's GETDATE() counts 1/300 of
  a second, where CURRENT_DATETIME counts microseconds. A comparison with a time
  in the same second can then give the other result.
- MySQL, SQL Server and PostgreSQL compare text by a collation. Text that
  differs only in letter case, accents or trailing spaces can give another
  value. PostgreSQL also ignores spaces and punctuation when it sorts text.
- A Snowflake or Databricks division or average can differ after the sixth
  decimal place.
- On a Snowflake FLOAT or PostgreSQL double precision column, an average or a
  Snowflake division can differ slightly from the source's. FLOOR or CEIL of it
  can then differ by one at a whole number, and a comparison of it can give the
  other result.

Spanner's default time zone, America/Los_Angeles, is written into the date and
time functions of a `SPANNER` text. A Spanner database created with another
`default_time_zone` reads those functions in its own time zone, so the
translated text can give other dates and hours than the database does. For such
a database, edit by hand the translated `BIGQUERY` entries of the fields and
metrics that read it, so that they name its time zone.
Snowflake's default time zone is written into the current date and time
functions of a `SNOWFLAKE` text, and UTC into the current timestamp of a
`MYSQL` or `SQLSERVER` text.

## To Spanner

A Spanner target keeps the queryable **structure** and drops the descriptive
metadata. The node tables, edge tables, and labels (including the `extends`
hierarchy, with fields flattened down) deploy exactly as they do for BigQuery,
but with bare table and graph names. Three things do not make the trip, all by
design:

- **Metrics.** Spanner has no `MEASURE`, so a Spanner deployment uses a profile
  that excludes every metric, and push rejects one that leaves a metric
  available. The BigQuery-only rule that a metric resolve to one
  entity does not apply. Author your metrics as usual — a BigQuery target still
  emits them, and Knowledge Catalog still records each `semantic-metric` entry —
  they simply have no home in the Spanner graph.
- **`OPTIONS` metadata.** Spanner carries no per-element `OPTIONS`, so
  `description`, `synonyms`, `instructions`, `examples`, and field `label` are not
  written into the Spanner DDL. They still reach Knowledge Catalog on the same
  push (the model's / entities' / metrics' descriptions and `instructions` land
  on their entries and the `guidelines` aspect), so the descriptive layer lives in
  the catalog rather than in the Spanner graph. This mirrors how BigQuery drops
  its graph-*statement* `OPTIONS` while keeping per-element ones.
- **Another engine's SQL.** A field reads its `SPANNER` expression, else its
  `ANSI_SQL` one, and is left out with a warning when it has neither.

Everything else — keys, relationships, the label hierarchy — matches the
**→ BigQuery** column above.

**Actions and constraints** reach neither graph. They are published to
Knowledge Catalog as one `semantic-action` or `semantic-constraint` entry each
and round-trip losslessly through `pull` — see
[To Knowledge Catalog](#to-knowledge-catalog).

## What pull recovers

`pull` rebuilds the model file from the catalog metadata that the rest of this
section describes. It changes a local model or profile file only where its
content differs from the catalog's: pull compares the file it would write for
the local file with the one it writes for the catalog, so a difference that is
only one of the normal forms below changes nothing. Each value the catalog holds
as the file says keeps its text, comments, key order and formatting, and a file
that holds what the catalog holds stays byte for byte. A changed string keeps
its quoting or block style, and other changed values are written in pull's form.
A changed block scalar keeps the indentation of its lines and its indentation
indicator. A block more than 9 columns deeper than its key that comes to need an
indicator is double-quoted, since the indicator stops at 9. A double-quoted
string whose lines would read back as other text, such as a line of one space,
is written on one line. A string that comes to hold DEL, a C1 control or a line
or paragraph separator is double-quoted, with those characters written as
escapes.
When the catalog reorders a list whose order counts, such as an entity's fields,
an item that moves, or an item it moves past, can be written in pull's form too.
The JSON `data` of a GOOGLE block, which holds a vanilla model's deployments and
profiles, changes the same way and keeps its layout. DEL, the C1 controls and
the line and paragraph separators in it are written as JSON escapes, such as
`\u2028`. When that `data` would
then not hold what the catalog holds, it comes back as the catalog holds it,
and the rest of the file still changes only where it differs. A `data`
written as a quoted string over several lines that changes is written as one
line of compact JSON, quoted as kcmd quotes a new block. Another
vendor's `data` comes back as the catalog holds it. Pull writes a file whole,
with none of its comments, key order or formatting, when there is no local
file, when the local file does not load or is not valid UTF-8, and when
changing only those values would not give what the catalog holds.
[Pull](README.md#pull) says when `pull` refuses the catalog instead.

Pull reads the second-generation types. It rebuilds the model file, profile
files and overview sidecars from the metadata. A model file it writes whole
states each metric's entity as `entity:`, declared or derived. See
[Reference](reference.md#the-second-generation-types). A model an older
`kcmd` pushed with the first-generation types is left out with a warning.

`pull` returns what push wrote: the model and every named profile. Push does
not prune the model to a deployment's profile first.

**Normalized** — the content survives, the form changes:

- A field or metric typed `Opaque` comes back with no `datatype`, since push
  stores one with no type as `Opaque` too.
- A `datatype` written in another letter case comes back in its canonical
  case, such as `Integer` for `integer`.
- A Google-flavor model that names its entities under `datasets:` comes back
  with `entities:`.
- A description comes back without the spaces and line breaks at its start and
  end, since push stores it trimmed. A `description: |` block of more than one
  line comes back as `|-`, and a one-line block as a plain string. An action
  parameter's own description is stored as written and comes back unchanged.
- `ai_context` comes back in the object form, and its custom members come
  back sorted by name. A number in a custom member comes back in its JSON form,
  since that is how the catalog stores it. `1.0` comes back as `1`, and `2.50`
  as `2.5`.
- In a vanilla model, the `GOOGLE` blocks on an object come back as one block
  under the name `GOOGLE`, after the other vendors' blocks. When its `data`
  comes back as the catalog holds it, the `data` is compact JSON.
- A profile's `metrics_exclude` comes back as a list in name order. When it
  excludes every metric, it comes back as `"*"`, unless the local file writes
  that profile's `metrics_exclude` as a list.
- Entities, relationships, metrics, actions and constraints come back sorted
  by name. Field order within each entity is kept.

**So a file pull writes whole is not your original file.** Treat a rebuilt
document as a faithful copy of the catalog metadata rather than of the authored
model, and keep the authored document as the source of truth.

(A deployment target in no supported form is **not** a pull gap. Every push
rejects it at the validation gate before anything is written, a catalog-only
push (`--no-deployment`) too; see [Validation](reference.md#validation).)
