# Drafting a binding from an existing warehouse (`kcmd bind`)

> **Proposed.** `kcmd bind` is a proposed command; its flags and its output may
> change.

A [binding profile](profiles.md) maps each entity of a logical model to the
table it reads and each field to a column. When the tables already exist, for
example a raw estate that grew up before the model, writing that profile by hand
means reading every table. `kcmd bind` drafts it instead. It scans the
warehouse, scores every concrete entity against every table, matches fields to
columns, then profiles the tables it picked and proposes the
[hydration](profiles.md) each one needs: a grain, value resolution, a unit
normalization, or a derivation from a relationship.

`bind` is deterministic. It uses no language model: the same model and the same
scan always produce the same profile, and every decision is explained in a
report beside it. When it is unsure it says so and stops, rather than guess.

```bash
kcmd bind --profile bigquery --scan my-project.ps_*            # draft, then review
kcmd bind --profile bigquery --scan my-project.ps_* --accept-review
kcmd push --profile bigquery                                   # deploy the result
```

## What it writes

| File | Contents |
|---|---|
| `<model>.profiles/<profile>.yaml` | The binding profile: each bound entity's `source`, its field `expression`s, and its `hydration`. Entities that need review are written as comments. |
| `bind_report.md` | Every decision and the reason for it: the chosen table and the score breakdown, the field-to-column matches and the rule behind each, the rejected candidates, the hydration proposals with their evidence, and the tables left out of the scan. |
| `bind_scan.json` | The scan itself (tables, columns, types), so a rerun can skip BigQuery with `--scan-file`. |

The report and the scan land in the profile's directory, or in `--out`.

Rerunning `bind` rewrites the profile. Change the model, the scan or the flags
rather than editing the draft; once you accept a profile, it is an ordinary
binding profile you own.

## How an entity is bound

### 1. Which entities get a table

Only **concrete** entities are bound to a table. The rest get none:

| Entity | Binding |
|---|---|
| abstract (`abstract: true`) | none: its subtypes are bound, and a query on it gathers them |
| defined (a filter over its parent) | none: it is a filter over its parent's table |
| keyless (no `primary_key`) | none: no key identifies a row |
| vocabulary | its generated `vocab_<name>` view (`code`, `label`, `sort_order`, `definition`, `iri`); a field such as `stageLabel` maps to `label` |

### 2. Scoring the candidates

Every concrete entity is scored against every scanned table:

| Signal | Weight | Meaning |
|---|---|---|
| Name similarity | 0.35 | token overlap and edit distance between the entity name and the table name |
| Key present | 0.30 | a column matches each key field; a table with no key match can only be guessed |
| Field coverage | 0.25 | the share of the entity's fields that found a column |
| Knowledge Catalog hit | 0.10 | the table came back from a catalog search for the entity's names (`--kc-search` only) |

Fields match columns by these rules, strongest first. A column whose type
contradicts the field's datatype still matches, at half strength, and is flagged
in the report.

| Rule | Example |
|---|---|
| same name (snake_cased) | `wonAmount` → `won_amount` |
| the field's `label`, snake_cased | `originatorId`, labelled "Lead Originator Id" → `lead_originator_id` |
| `_code` / `_key` suffix dropped | `marketUnitCode` → `market_unit` |
| entity-name prefix dropped | `accountCreatedAt` on ClientAccount → `created_at` |
| the one column ending in `_<field>` | `unitName` → `market_unit_name` |
| one of the field's `ai_context` synonyms | a field with synonym `bookedValue` → `booked_value` |
| the only `*_name` / `*_email` / `*_title` column | `partyName` → `contact_name` |
| first `_id` column (single key only, a guess) | flagged *guessed*; never auto-accepted |

Tables are then assigned greedily, best pair first, and each table goes to at most
one entity.

### 3. The deprecated-class guard

An entity described as `DEPRECATED: … Use X` marks the tables that look like it
as its own. A table whose name resembles a deprecated entity more than it
resembles the entity being scored is that entity's *shadow*. Other entities are
not bound to it, and it does not count as their runner-up. This keeps
`Opportunity` off `deal_legacy` even though both tables carry the same columns.

### 4. Accept, review, or derive

An entity is **auto-accepted** when its best table:

- matches every key field (not a guess),
- covers at least 60% of its fields, and
- beats the runner-up by a margin of at least 0.15.

Otherwise it **needs review**, and the report lists its top three candidates.
Accepting one is always enough to resolve it: rerun with `--accept-review` to take
every best candidate, or move the entity into the model's inline binding.

A concrete entity with no table of its own is **derived** when a relationship
from a bound entity lands on its single key. `EcosystemPartner`, keyed by
`partnerName`, is derived from `PartnerAlliance.partnerName` through
`allianceWith`, so its rows are the distinct partner names the alliances name.
Derivation also outranks a table whose key column is only guessed. An entity with
no table and nothing to derive it from is **unbound**.

## Hydration proposals

`bind` then profiles the tables it chose (the same read-only queries as
[`kcmd profile`](profiling.md)) and turns each contradiction of the model into a
proposal:

| The data shows | Proposal |
|---|---|
| the key repeats | `grain: {latest_by: <column>}`, the date column that picks one row per key without ties (latest updated, then created, then any date); `grain: {deterministic: true}` when no column breaks the ties |
| foreign-key values miss the destination's key, but match its unique name | `resolve: [{field, match: [key, name]}]` |
| a series changes scale by a power of ten at a date (a unit change: cents, thousands) | `normalize: [{field, before: <date>, divide_by: <factor>}]`, with the date that best splits the two scales. Any other jump changes what the series measures, so no factor can repair it; it is reported as a note |
| no table, but an edge lands on the key | `derive_from: {relationship}` |

A `normalize` rule rescales history, so `bind` never switches one on by itself:
the profile carries it as a comment until a human confirms it with
`--accept-review`. Pass `--no-profile-data` to skip profiling altogether.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | every concrete entity is bound or derived, and nothing waits on a human |
| 2 | something needs review (an entity, an unbound entity, or a pending `normalize`); the profile and report are still written. `--accept-review` clears it |
| 1 | an error: the model does not load, the scan fails, or the drafted profile does not merge cleanly |

## What is scanned

`--scan <project>.<dataset glob>` reads `INFORMATION_SCHEMA.COLUMNS` for every
matching dataset in one query. Some datasets are always left out: the deployment
target's own dataset, so the curated output never binds to itself, and every
dataset matching `--exclude`. Views are left out unless you pass
`--include-views`. Every dropped table is listed at the end of the report.

`--from-catalog` binds the model as pulled from Knowledge Catalog, the governed
definition, instead of the local documents. `--model <file>` binds one document
and writes its profile beside it.

## Flags

| Flag | Meaning |
|---|---|
| `--profile <name>` | the profile to write (default `bigquery`) |
| `--scan <project>.<glob>` | the datasets to scan |
| `--scan-file <file>` | read the scan from a `bind_scan.json` or an `INFORMATION_SCHEMA.COLUMNS` CSV instead |
| `--model <file>` | bind this document instead of the scope's |
| `--from-catalog` | bind the model pulled from Knowledge Catalog |
| `--accept-review` | take every best candidate and switch on the proposed `normalize` rules |
| `--no-profile-data` | do not profile the chosen tables (no hydration proposals) |
| `--exclude <glob>` | leave matching datasets out; repeatable |
| `--include-views` | consider views as well as base tables |
| `--kc-search` | add the Knowledge Catalog search signal |
| `--deployment-target <uri>` | the target the profile declares; defaults to the existing profile's, else the model's |
| `--location <location>` | BigQuery location of the scanned datasets (default `US`) |
| `--project <project>` | the project query jobs run and bill in |
| `--label <key:value>` | label every query job; repeatable |
| `--out <dir>` | where `bind_report.md` and `bind_scan.json` go |
