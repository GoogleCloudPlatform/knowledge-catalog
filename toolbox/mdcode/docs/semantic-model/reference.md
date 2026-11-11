# Reference

Lookup companion to the [deploy guide](README.md): every flag, exactly what push
creates in each destination, the validation checks, and the permissions each leg
needs. For what of your metadata survives a deploy or a pull, see
[What push and pull preserve](fidelity.md).

## CLI flags

### init

```bash
kcmd init --semantic-model <projectId>.<locationId>.<entryGroupId>
```

Provisions the Knowledge Catalog entry group named by the scope (idempotent — an
existing group is fine) and creates its local directory,
`catalog/EntryGroups/<entryGroupId>/`. Author `<model>.yaml` there.

### push

```bash
kcmd push
```

With no flags, `kcmd push` validates the model and its deployments, publishes
the model and any sibling `<model>.profile.<name>.yaml` files to Knowledge
Catalog, and deploys every entry in the model's `deployments:` list in order.
You do not choose the graph backend on the command line: each deployment entry
deploys to whichever backend its `target` names (BigQuery Graph or Spanner
Graph; an AlloyDB deployment targets an AlloyDB database for actions and deploys
no graph), using the binding profile its `profile` names (or the model file's
inline `default` bindings when `profile` is omitted). Every push publishes to
Knowledge Catalog.

| Flag | Effect |
|------|--------|
| `--deployment <names>` | Deploy only these entries of the model's `deployments:` list, comma-separated or repeated, in the order given. Push still publishes the model to Knowledge Catalog first. |
| `--no-deployment` | Publish the model to Knowledge Catalog and deploy no graph, after the validation phase below. Push refuses it with `--deployment`, in either order. |
| `--skip-source-check` | Skip the source check, which looks up the Knowledge Catalog entry of each BigQuery, BigLake, Spanner and AlloyDB table a source names and checks that each profile's BigQuery and BigLake tables share a location. See [Validation](#validation). Push prints a line saying it skips the check. It still reads the dialect of each Cloud SQL, Spanner and third-party table. |
| `--no-metric-graphs` | Deploy each BigQuery graph alone, without the `GRAPH_EXPAND` metric graphs and fallback metric views deployed next to it by default (proposed; see [Metric graphs for `GRAPH_EXPAND`](#metric-graphs-for-graph_expand-proposed)). The main graph is the same either way. |
| `--validate-only` | Run every validation check and report pass/fail, but write nothing. |
| `--dry-run` | The same as `--validate-only`. The push still prints its plan, including the metric graphs and views it would create. |
| `--print` | Print each destination's generated artifact (BigQuery or Spanner Graph SQL DDL, Knowledge Catalog entry plan). Combine with `--validate-only` to preview without deploying. |
| `--force-remove` | Delete models in the entry group that this push no longer includes (see [Updating and removing models](README.md#updating-and-removing-models)). |
| `--strict-profile` | Proposed. Before each BigQuery graph deploy, profile the bound data as [`kcmd profile`](#profile) does, and stop when the data contradicts any statement. Unverified statements never block. The queries only read, so this also runs under `--validate-only`. A Spanner graph is not profiled. See [Gating a push](profiling.md#gating-a-push-proposed). |

Push runs in two phases:
1. **Validation phase:** Writes nothing. It checks every source of every
   profile against Knowledge Catalog, runs the other Knowledge Catalog checks,
   and runs the local checks of every deployment in `deployments:`. The checks
   that read a deployment's store run only for the deployments this push
   deploys: its BigQuery dataset or Spanner database, its BigQuery source
   tables, a dry run of its BigQuery graph DDL, and each action statement,
   which BigQuery dry-runs and Spanner plans. It also prints each graph's
   warnings, such as a metric the graph leaves out. Knowledge Catalog receives
   every profile, so this phase prints the load warnings of each profile,
   whether or not a selected deployment applies it, each prefixed with
   `profile '<name>':`. (Spanner
   cannot dry-run a property graph's DDL without executing it, so a Spanner
   deployment whose graph DDL Spanner rejects fails in the second phase, after
   Knowledge Catalog is written.)
2. **Publish and deploy phase:** Publishes the model file (as written) and any
   sibling `<model>.profile.<name>.yaml` files to Knowledge Catalog, then
   deploys each selected deployment in order with the profile it names. An
   AlloyDB deployment deploys no graph.

### pull

```bash
kcmd pull
```

Rebuilds the model file and profile files from the Knowledge Catalog entries.
It changes a local file only where the catalog differs from it, so the rest
keeps its comments, key order and formatting, and writes a file whole when it
cannot. When the model entry's `kcmd-push-state` label says the last push
stopped partway, it writes nothing.
Reads only from Knowledge Catalog (never BigQuery); its coordinates come from
the same scope you authored under. See [Pull](README.md#pull) for behavior.

| Flag | Effect |
|------|--------|
| `--dry-run` | Read the catalog and report what would be written, but write or delete no files. |
| `--force-remove` | Replace a differently-named local model with the catalog's (see [Pull](README.md#pull)); without it, a pull that would leave the entry group holding two models fails. It also deletes a local profile file or overview sidecar the pull did not write. |

### import

```bash
kcmd import <file> --flavor <ossie|google>
```

Imports a semantic model file into the flavor `--flavor` names. Import changes
a value only when that flavor rejects it. When the file's own flavor rejects
the value too, the change is a repair. A file another product wrote is
repaired, and each repair is reported as a warning. Renaming a dialect such as
`GOOGLE_SQL` or `bigquery` is a repair. In a vanilla file written as vanilla,
recasing a datatype such as `integer` is a repair, and so is writing a string
`expression` as an `ANSI_SQL` entry under `dialects`. The other changes convert
the file between flavors and are not reported. A conversion moves each value
the two flavors place differently, such as a dataset's `extends`, between its
own key and a `GOOGLE` block, as written. A conversion to vanilla drops an
empty `extends`, `deployments` or relationship `description` instead of writing
a `GOOGLE` block for it, and drops an empty `custom`, with its `ai_context`
when nothing else is left in it. A file written for kcmd converts between
flavors exactly or not at all. The `<model>.profile.<name>.yaml` files beside
a Google-flavor `<file>` go in with it. A profile's sources stay as written,
even with `--source-prefix`. Import runs push's checks of the model and its
bindings on what it writes, and stops where push stops. Unlike push, it
reports every deployment target in no accepted form. Without
`--input first-party`, it still reports each profile's problems when the model
file has a source push rejects. The checks cover the model's names,
descriptions, fields, keys, metrics, relationships, inheritance, actions and
constraints. They also cover the model file's own bindings and each profile
import writes. For each deployment they cover its profile, bindings, metrics,
tables and graph. A profile file beside a vanilla `<file>` and a
`<model>.profiles/` directory beside `<file>` are checked too. The checks also
make sure Knowledge Catalog can store each aspect push writes. The deployment
checks include the names a BigQuery or Spanner graph cannot hold and BigQuery's
description and synonym limits. Import reports what these checks reject as an
error under `--input first-party` and as a warning otherwise, except a
deployment target in no accepted form, which is an error either way. It reports
their warnings as warnings in either mode. They include push's warnings about the Knowledge
Catalog entries, about the fields each deployment leaves out and about each
graph. Import leaves out push's notes. A profile file that does not parse is
always an error. Under `--input first-party`, a message from these checks names
the input file that holds what it reports. The checks that read a service stay
with push, such as whether each source names a table Knowledge Catalog knows
about. For its checks, import reads only each table's dialect, as push does: a
Cloud SQL or third-party table's from its Knowledge Catalog entry, and a Spanner
table's from its database. Import then judges each table in that dialect. When
it cannot read a table's dialect, it warns with push's reason and skips the
checks that need the dialect: whether a field has SQL in its table's dialect,
what an `ANSI_SQL` text reads when every table of the model file or profile is
such a table, and whether a profile's or the model file's tables are in one
database when only that table's entry can say. Tables of two systems are never
in one database, so import still reports a profile or model file that binds a
BigQuery table beside such a table.
Nothing is written
when the import reports an error. Import rewrites only the values it changes,
and every other line of the file stays as written, with its comments, blank
lines, quoting, indentation and line endings. Comments on anything import
removes or moves elsewhere in the file are dropped, such as those on a key that
goes into or out of a `GOOGLE` block. A flow collection over several lines that
import changes is written again in block style, without the comments inside it.
A value that import would write as a `|+` block scalar is double-quoted
instead, and a `|+` block scalar that it moves is written again. A profile file
written beside the model is rewritten the same way. A profile file's comments
are dropped when its contents move into the model file. A JSON file is written
as YAML, and import reports the conversion. Without `--out`, the files go into
the scope's entry group folder, and an import that would leave one of the
model's profile files there unwritten is refused. Without `--out`, an import is
also refused when the entry group folder already holds another model's file,
since an entry group holds one model. It is refused too when the input file is
a `.yaml` file in that folder other than `<model>.yaml`, since the model would
then have two files.

| Flag | Effect |
|------|--------|
| `--input <who>` | Who wrote the file: `third-party`, a file another product wrote (default), or `first-party`, a file written for kcmd. |
| `--flavor <flavor>` | Flavor to write: `ossie` or `google`. Required. |
| `--source-prefix <prefix>` | GCP resource name of the database whose tables complete each bare table name, such as `bigquery.googleapis.com/projects/p/datasets/d`, or the name of a Knowledge Catalog entry group, `projects/<p>/locations/<l>/entryGroups/<g>`. Against a Spanner prefix, `ops.stations` and `<db>.ops.stations` both become `.../databases/<db>/tables/ops.stations`, the table `stations` in schema `ops`. Leading parts that match the prefix are read as the prefix, so `<db>.stations` is the table `stations`. A lower-case `public.` schema part names a PostgreSQL-dialect database's default schema, so `public.stations` becomes `.../tables/stations`. Against an AlloyDB prefix, a name's unquoted parts are read in lower case, as PostgreSQL reads them. A name that still differs from a database prefix only in letter case is not completed, and import reports it. For an entry group, the import writes the entry name of the one table entry whose `fullyQualifiedName` ends in the bare name. An unquoted part of the name matches in any letter case, and a quoted part only in its own case. For example, `public.orders` becomes the name of the entry for `snowflake:acme.RETAIL.PUBLIC.ORDERS`. A name that no entry or several entries end in stays as written and is reported. Listing the entries needs read access to the entry group. |
| `--transpile` | Add a BigQuery translation beside SQL in another dialect, in the model and in each profile the import writes. Import translates only common SQL that gives the same value in BigQuery for ordinary data. It leaves any other text as written and warns. A profile is translated only when all its tables are in BigQuery or BigLake. Off by default. See [What import translates to BigQuery](fidelity.md#what-import-translates-to-bigquery). |
| `--out <path>` | A `.yaml` file to write the one output file to, or a directory to write each output file into. |

### profiles

```bash
kcmd profiles
```

Reports each binding profile the model declares: the deployment targets that use
it, the source each entity binds to, and what the profile cannot answer or
cannot run. Under each profile it then prints every error push would give for
it, after a `push rejects:` heading. The inline `default` binding is checked
too. Beside declared profiles it is listed only when push would reject it.
Some errors fail every push of the scope, such as a
second model in the entry group. When push would stop at such an error,
`kcmd profiles` prints it once above the profiles. A Cloud SQL or third-party
table whose dialect cannot be read from its entry, or a Spanner database whose
dialect cannot be read, stops the command before the report. When push warns
that the model file's own bindings are incomplete, the report prints that
warning under `profile 'default'`, unless `--profile` names another profile.

The command is read-only. It applies and prunes each profile and generates each
graph as `push --validate-only` does, but deploys nothing, so you can compare
coverage before choosing one. Like push, it reads the Knowledge Catalog entry
of each Cloud SQL table written as its resource name and of each third-party
table, and each Spanner database a source names, for the dialect.
The other checks that need a service run only at push time: the source check,
the BigQuery source table probe, the dry runs of action statements and of each
BigQuery graph's DDL, the check that a deployment's BigQuery dataset or Spanner
database exists, the check of a Spanner deployment's instance edition, and (on
a push without `--validate-only`) the Knowledge Catalog checks on the entry
group. It exits non-zero when push would reject a binding. Under each profile it
prints the errors of that profile's own
checks and of each deployment that uses it. The errors of a deployment that
names no profile print under `default`. With `--profile <name>`, the other
profiles' errors print above the profiles too, since any of them stops the
push. Push applies only the profiles that deployments use, so it can accept an
unused profile that does not apply. When push gives no error and a profile does
not apply, the report prints why on a `not shown:` line under that profile.
The report's `target:` line lists the targets of the deployments the profile
uses, the same ones `--print-store` reads. For an AlloyDB target named by its
cluster, `--print-store` calls the AlloyDB API to find the cluster's primary
instance.

| Flag | Effect |
|------|--------|
| `--profile [name]` | Report only this profile. Naming one the model does not declare is an error, not an empty report. Defaults to every profile. |
| `--print-store` | Print only the store the profile deploys to, on one line and nothing else, for a script to read rather than parse out of the report: `project/instance/database` for a Spanner store, and the backend named ahead of the path for any other (`alloydb:project/region/cluster/instance/database`, `bigquery:project/dataset`). The store is the one the deployments for the profile name: those that name it in `profile`, or that name no profile or `default` for `default`. Of several, it is the single Spanner or AlloyDB store. For an AlloyDB target named by its cluster, the instance printed is the cluster's primary instance. Errors when the scope holds more than one model, since those may name different databases, before any AlloyDB call. Also errors when a deployment names a profile the model does not declare, and when no single store results. Like push, it errors when the model's `extends` do not resolve: one names an entity the model does not declare, they form a cycle, or an entity inherits one field from two unrelated ancestors. A target in no accepted form in any deployment fails it under every profile. It reads every model's profiles first: its sibling `<model>.profile.<name>.yaml` files (for a `0.2.0.dev0/google` model), and the profiles a vanilla `0.2.0.dev0` model carries in its `GOOGLE` custom extension block. It errors on a profile file that breaks one of the [profile file rules](profiles.md#file-layout) or on a `GOOGLE` block profile that does not load. Like push, it checks each named profile against the model file loaded on its own, with the profile checks listed under [Validation](profiles.md#validation) and the [Sources](profiles.md#sources) rules on one database and on dialect text. When a check fails, it gives the errors push gives for those profiles, before any AlloyDB call. It reads each source's dialect as push does. When a Spanner database or a third-party table's entry cannot be read, it skips the dialect rules for that table. When a Cloud SQL table's entry cannot be read, it stops, as push does. Like push, it errors on an entry that reads but gives no dialect or names no table. For an AlloyDB cluster it also errors when the cluster has no primary instance, when the primary is not READY, or when the instance listing fails. |

This is a read of the binding, never a choice of one. Nothing on any `kcmd`
command line names a store directly; `--profile` selects a binding and the
deployments that use that binding decide where writes land. A script that
creates, seeds or drops that database asks for the name rather than repeating
it:

```bash
IFS=/ read -r PROJECT INSTANCE DATABASE <<<"$(kcmd profiles --print-store)"
```

### skills-generate

```bash
kcmd skills-generate
```

Writes each model in the scope out as an [Agent Skill](https://agentskills.io/)
folder: a `SKILL.md` naming the model, routing to its actions and saying what a
call comes back as, and one `references/<action>.md` per action carrying that
action's arguments, rules and blast radius. It reads the model, touches no
store, calls no judge, and runs nothing. For an AlloyDB target named by its
cluster, it calls the AlloyDB API to find the cluster's primary instance.

A skill names the store only for a model with actions, in its "Running an
action" section. The command fails without writing anything when push rejects
the deployments. That happens when the target of any deployment is in no
accepted form, whichever profile the deployment is for. It also happens when
several targets leave the store ambiguous, or when a deployment names a profile
the model does not declare. It accepts a deployment that names `default` or a
declared profile, as push does. It accepts a Spanner deployment
that names no profile in a model with metrics, which push refuses. It fails on
two BigQuery deployments that use one profile, since they leave no single
store, while push deploys both. It accepts a model that binds a table outside
the database a deployment deploys to, which push refuses, unless the model has
actions and that database is the Spanner or AlloyDB store of the selected
profile. It also accepts a profile file that no deployment uses, as push does,
and writes a skill whose store line says there
is none. A vanilla model lists its deployments in a `GOOGLE` block.
The command fails the same way when a target there is in no accepted form, or
when the block's data is not valid JSON. It reads every
model's profiles first: its `<model>.profile.<name>.yaml` files, and the
profiles a vanilla model carries in its `GOOGLE` block. It fails on a profile
file that breaks one of the sibling profile file rules, such as a
`<model>.profile.<name>.yaml` file whose `name:` does not match its file name,
on a `GOOGLE` block profile that does not load, and on a profile named
`default` in any letter case. It does not run
push's checks that every named profile applies to the model and that each is
complete. So it still writes a skill when a profile leaves an entity without a
source. It does not run push's check that each model file and profile file is
valid UTF-8. It does not check that the entry group holds one model, or that
two models deploy to different graphs. Of push's checks on
the model itself, it runs only the one on inheritance. It fails when an
`extends` names an entity the model does not declare, when `extends` forms a
cycle, or when an entity inherits one field from two unrelated ancestors. It
runs none of the others, such as a concrete entity with no source or an action
guarded by a constraint the model lacks. It fails when the profile binds a
third-party table, naming the entity and the table, since kcmd has no engine
that reads one. So does `kcmd profiles --print-store`.

For a model with actions, it also fails without writing anything when the
profile names a store that cannot be resolved. That happens when the model
binds a table outside its Spanner or AlloyDB store, when the AlloyDB cluster
has no primary instance, when the primary is not READY, or when the instance
listing fails. A model with no actions still gets its skill in those cases,
since the skill does not name the store.

A BigQuery graph may read tables in other datasets, as push allows. For such a
model, and for a profile whose deployments name no target, the store line says
there is none and gives the reason.

A skill's `name` and the directory it sits in have to match, or a client skips
it. So the directory is named from what was generated rather than from anything
the caller typed, and a name the format does not allow fails before anything is
written.

Everything the binding decides lives in `SKILL.md`: the store, the executor
kinds, and which actions this deployment cannot run and why, all under one
heading, plus the snippet for reading the store directly. A reference page is
the same bytes under any profile.

A guarded action is always described as runnable, because a rule stated in words
is settled by the runtime before the transaction opens and a guarded action only
ever runs against a runtime that has a judge. There is no flag here to say
otherwise: whether the caller of `skills-generate` had a judge configured is a
fact about that invocation, not about the deployment the document is read
against.

| Flag | Effect |
|------|--------|
| `--out <dir>` | Directory the skill directories are written under. Defaults to `skills`. |
| `--name <name>` | Name the skill, and so its directory. Defaults to the model's own name. Rejected when the scope holds more than one model, because a name names one skill. |
| `--profile [name]` | Read the model under this binding profile (`<model>.profile.<name>.yaml`). Defaults to the model's inline `default` bindings. It is what the one deployment-specific section describes. |
| `--force` | Replace a skill already at that path. A reference page for an action the model no longer declares is deleted and reported; a file outside `references/` is left alone. |

Before anything is written, a warning is printed when no action in a model is
runnable under the selected profile, because a skill that can run nothing is
rarely what was meant. Two models in one scope whose names normalize to one
skill name are refused rather than one overwriting the other. See
[Generating an Agent Skill](skills.md).

### validate

```bash
kcmd validate --target bigquery [--profile bigquery] [--location US]
```

Checks the data the selected binding profile binds against the model's
constraints. Every constraint imported from SHACL or OWL (recognized by its
`(From SHACL: …)` / `(From OWL: …)` provenance note) becomes one
violation-count query (`violations`, `total`) and one examples query over the
bound BigQuery tables; the model's primary keys, unique keys and foreign keys add
structural checks. A constraint with no deterministic form -- a hand-written
judgment, a rule on an unbound field -- is listed in one warning with the
reason, never guessed at.

The queries are always written to `--out` as `<model>.validation.sql` and a
JSON manifest `<model>.validation.json`. Unless `--sql-only` is given (or there
are no credentials), each query is then dry-run, run, and a table of
constraint / violations / total / status (`pass`, `fail`, `error`) is printed
and saved as `<model>.results.json`. The exit code is 1 only when a check could
not run; violations are a report about the data, not a command failure.

| Flag | Effect |
|------|--------|
| `--target <target>` | Required. Only `bigquery`. |
| `--profile [name]` | Check the tables this binding profile binds. Defaults to the model's inline `default` bindings. Refused when the profile runs against a Spanner or AlloyDB store; a profile file's store comes from the deployments that name it (see [Binding profiles](profiles.md)). |
| `--out <dir>` | Where the `.sql`, manifest and results are written. Defaults to `validation`. |
| `--sql-only` | Write the queries and manifest; run nothing. |
| `--examples <n>` | Violating keys sampled per failing check. Default 5; `0` skips the examples queries. |
| `--location <location>` | BigQuery processing location for the query jobs. |
| `--publish` | Write the results to Knowledge Catalog as a `semantic-constraint-results` aspect on each checked entity's entry (the entries `kcmd push` publishes). Not combinable with `--sql-only`. |
| `--no-structural` | Check only the constraints, not keys and foreign keys. |

The results are never used as filters: no graph, query, skill or action guard
reads them. See [Validating constraints against BigQuery](validation.md).

### test (proposed)

```bash
kcmd test --target bigquery [--profile bigquery] [--location US] [--out contract-tests]
```

Runs contract tests generated from the model against the deployed BigQuery
graph, read-only, and reports pass / fail. `validate` measures the data; `test`
checks that the graph does what the model says:

- **`defined-membership`**: for each defined entity, the base rows where the
  graph property `is<Class>` holds are exactly the rows its definition selects.
- **`transitive-closure`**: for each relationship the model marks transitive, a
  quantified path `-[:p]->{1,k}` returns exactly the pairs a recursive SQL
  closure returns. The closure runs over the join columns of every edge
  labelled `p`: the relationship's own edges and those of each
  sub-relationship. An abstract relationship is therefore tested too.
- **`validation-query`**: every query `validate` plans for the model executes.

The tests are written to `--out` as `<model>.contract.sql` and the manifest
`<model>.contract.json`; a run adds `<model>.contract-results.json`. Every
statement is a query, so a run creates and modifies nothing. An element a
generator cannot test is listed with the reason. A graph test that BigQuery
refuses for lack of an Enterprise reservation is reported `skipped` (`needs
Enterprise reservation`), not failed. The exit code is 1 when a test fails or
errors.

| Flag | Effect |
|------|--------|
| `--target <target>` | Required. Only `bigquery`. |
| `--profile [name]` | Test the graph and tables this binding profile binds. Defaults to the model's inline `default` bindings. Refused when the profile runs against a Spanner or AlloyDB store, as for `validate`. |
| `--out <dir>` | Where the `.sql`, manifest and results are written. Defaults to `contract-tests`. |
| `--sql-only` | Write the tests and the manifest; run nothing (also the behaviour without credentials). |
| `--location <location>` | BigQuery processing location for the query jobs. |
| `--path-bound <k>` | The `k` of the quantified paths the `transitive-closure` tests compare. Default 10. |

See [Contract tests](validation.md#contract-tests-kcmd-test-proposed).

### profile

```bash
kcmd profile [--profile bigquery] [--location US] [--strict] [--publish [--dry-run]]
```

Proposed. Checks the model's claims against the data the selected binding
profile binds, and reports each claim as a statement that is `verified`,
`unverified` or `contradicted`, with its evidence. The claims are:
- keys identify rows;
- direct foreign-key relationships are many-to-one (or one-to-one) and reach a
  row;
- `sh:in` fields take only the declared values;
- a `unit`'s magnitudes agree across the model's fields;
- numeric series keep one scale over time, unless a `Regime:` note declares
  the change;
- required fields are set.

Each statement comes from one read-only query over the bound BigQuery tables.
A claim that cannot be queried, such as one on an unbound field, is listed
with the reason.

The queries are always written to `--out` as `profile.sql`. Unless
`--sql-only` is given, or there are no credentials, they are then run. A table
is printed for each model, and `profile.json` and `profile.md` are written.

The exit code is 1 when a query could not run or publishing failed, and also,
with `--strict`, when any statement is contradicted. Otherwise it is 0: the
statuses are a report about the data.

| Flag | Effect |
|------|--------|
| `--target <target>` | Only `bigquery`, the default. |
| `--profile [name]` | Profile the tables this binding profile binds. Defaults to the model's inline `default` bindings. Refused when the profile runs against a Spanner or AlloyDB store, as for `validate`. |
| `--out <dir>` | Where `profile.sql`, `profile.json` and `profile.md` are written. Defaults to `profiling`. |
| `--sql-only` | Write `profile.sql`; run nothing. This is also what happens without credentials. |
| `--location <location>` | BigQuery processing location for the query jobs. |
| `--project <project>` | Project the query jobs run and bill in. Defaults to the gcloud project. |
| `--label <key:value>` | Label every query job. Repeatable. Keys and values use lowercase letters, digits, `_` and `-`. |
| `--strict` | Exit 1 when the data contradicts any statement. |
| `--publish` | Write the statements to Knowledge Catalog as a `semantic-profile-results` aspect on each profiled entity's entry (the entries `kcmd push` publishes). Not combinable with `--sql-only`. |
| `--dry-run` | With `--publish`: print the Knowledge Catalog requests; send nothing. |
| `--examples <n>` | Offending values to list for each statement: repeated keys, orphaned foreign keys, values outside a declared set. Default 5; `0` lists none. |
| `--magnitude-orders <x>` | Units: how many orders of magnitude a field's median may sit from the median of the other fields with its unit and scale before it is flagged. Default 2. |
| `--window-months <n>` | Scale over time: the window length in months. Default 3. |
| `--shift-factor <x>` | Scale over time: the ratio between neighbouring windows' medians that counts as a break. Must be greater than 1. Default 50. |
| `--min-window-rows <n>` | Scale over time: the non-zero values a window needs before it is compared. Default 30. |

Like `validate`'s results, the statuses are never used as filters. See
[Profiling the data against BigQuery](profiling.md).

### glossary push

```bash
kcmd glossary push [--dry-run] [--prune-glossary] [--profile <name>]
```

Publishes each model's `glossary:` block as a Knowledge Catalog Business
Glossary: the glossary, its categories and terms, `related` entry links between
terms, and `definition` entry links from the BigQuery tables / columns (and the
semantic entity / metric entries) the terms define. Idempotent (409 → PATCH);
run it after `kcmd push`. `kcmd push` does not publish the glossary. See
[Business glossary](glossary.md).

| Flag | Effect |
|------|--------|
| `--dry-run` | Print every REST request (path, query, body) and the skipped links; send nothing. |
| `--prune-glossary` | Delete the terms and categories labelled `kcmd-model: <model>` that the spec does not declare. |
| `--profile [name]` | Resolve table / column bindings through this binding profile. |
| `--project <project>` | Project that owns the glossary. Defaults to the `catalog.yaml` source project. |
| `--location <location>` | Glossary location. Defaults to `global`. |
| `--no-semantic-links` | Link only the BigQuery tables, not the semantic entries. |

### owl import

```bash
kcmd owl import <file.ttl> [<file.ttl> ...]
```

Converts a Turtle OWL ontology into one semantic-model document (see
[Importing an OWL ontology](owl-import.md)). Several files are the modules of
**one** ontology: they are merged (an RDF merge — cross-file `rdfs:subClassOf`,
`rdfs:domain` and `rdfs:range` references resolve) into a single model. An
`owl:imports` in any of them is followed to a **local** file only: one already
given on the command line, or one beside the importing file named after the
imported IRI's last segment (`…/ontology/core` → `core.ttl`) whose own
`owl:Ontology` IRI matches. An import that resolves to no such file is warned
and skipped — nothing is fetched over the network. The first file's ontology
header describes the model.

| Flag | Effect |
|------|--------|
| `--name <model>` | Name the model. Defaults to the first file's stem (`sales.owl.ttl` → `sales`). |
| `--out <path>` | Write the document to this path instead of the semantic-model layout dir. |
| `--compact` | Emit the compact flow YAML layout instead of the default block layout. |
| `--prune-unbound [binding]` | Proposed. Keep only the entities the binding gives a `source`, their ancestors and the defined entities over them; remove the rest with the relationships, constraints and glossary links that refer to it, and print what was removed. The value is a binding profile (`<model>.profile.<name>.yaml`) or a model document with inline bindings; the bare flag reads the model's `<model>.profile.<name>.yaml` files in the scope's layout, else the ones beside `--out`. Fails, writing nothing, when the binding binds no entity. See [Pruning to what is bound](owl-import.md#5-pruning-to-what-is-bound-proposed). |
| `--coverage <path>` | Proposed. Write the coverage report here instead of to `coverage.json` beside the written model. |
| `--no-coverage` | Proposed. Print no coverage summary and write no coverage report. |

Every import prints a coverage summary: each construct it read, counted as
`compiled`, `hinted` or `dropped`. It writes the full report, with the reason
for each hint and drop, to `coverage.json` (see [Coverage
report](owl-import.md#6-coverage-report-proposed)).

### shacl import

```bash
kcmd shacl import <shapes.ttl> [<shapes.ttl> ...] (--into <model.yaml> | --model <name>)
```

Adds the rules a SHACL shapes graph states to an existing model as native
constraints, editing the document in place; re-importing replaces the
constraints generated earlier from the same shapes (see [Importing SHACL shapes
as constraints](shacl-import.md)).

| Flag | Effect |
|------|--------|
| `--into <model.yaml>` | The model document to add the constraints to. Defaults to the `--model` model in the semantic-model layout. |
| `--model <name>` | The model receiving the constraints. Required without `--into`; with `--into` it confirms the document's model (a document declares one model, and the load refuses a document that declares two). |
| `--out <path>` | Write the updated document here instead of back to its source. |
| `--coverage <path>` | Proposed. Write the coverage report here instead of to `coverage.json` beside the written document. |
| `--no-coverage` | Proposed. Print no coverage summary and write no coverage report. |

Like `owl import`, every import prints a coverage summary and writes
`coverage.json`, listing each shape and constraint component with its outcome
(see [Coverage report](shacl-import.md#3-coverage-report-proposed)). When the
SHACL import writes the model the OWL import wrote, both reports of that model
sit side by side in one file.

## What gets created in BigQuery

`push` executes a single `CREATE OR REPLACE PROPERTY GRAPH` per deployment
target, in the project and dataset the target names. Each part of your model
becomes one part of that graph:

| Model element | BigQuery construct | Notes |
|---|---|---|
| Model | `PROPERTY GRAPH` | named by the deployment-target URI |
| Entity | a node view + `NODE TABLE` | the node table reads the entity's generated node view (see [Node views](#node-views-hydration)), keyed by its primary key; with `mode: direct` it reads the `source` table itself. The node table lists the entity's bound fields and its measures, and one with neither is written with `NO PROPERTIES`. A measure over a field that reads another column also adds that column as a property, and a measure over other SQL adds a property named `<metric>_input`. A column whose name another property in the graph already has goes through a `<metric>_input` property too. |
| Relationship | `EDGE TABLE` | connects the two entities' node tables; a foreign-key edge declares no fields of its own, so it is written with `NO PROPERTIES` and exposes none of its table's columns |
| Relationship `inverse` | a second `EDGE TABLE` over the same backing table | `SOURCE`/`DESTINATION` swapped, labeled with the inverse name (see [Relationship inverses](#relationship-inverses-inverse)) |
| Metric | `MEASURE` on a node table | must resolve to a single entity and read every field inside `SUM`, `AVG`, `COUNT`, `MIN` or `MAX`, each over one operand; BigQuery's built-in scalar SQL may combine them, as in `SUM(orders.amount) / COUNT(orders.order_id)`, but a user-defined function may not (otherwise the push is rejected; see [Validation](#validation)) |
| Entity `extends` | extra `LABEL` clauses on the subclass node table | the subclass also matches its supertypes; the supertypes' fields flatten down (see [Class hierarchies](#class-hierarchies-extends--labels)) |
| Relationship `extends` / `abstract` | extra `LABEL … NO PROPERTIES` clauses on the sub-relationship's edge table; no edge table for an abstract relationship | a match on the parent label spans every descendant edge table (see [Relationship hierarchies](#relationship-hierarchies)) |
| Action | *nothing* | an action reaches Knowledge Catalog only (see below); the BigQuery push deploys none and warns once |
| Constraint | *no graph construct* | a constraint is published to Knowledge Catalog (see below); a node view under `hydration.constraints: enforce` applies it to the rows it serves (see [Node views](#node-views-hydration)) |

Next to that graph, a push also deploys the model's metrics as small
`GRAPH_EXPAND`-ready metric graphs, plus a view for any metric none can hold
(proposed; see [Metric graphs for `GRAPH_EXPAND`](#metric-graphs-for-graph_expand-proposed)).

`push` reads the target dataset's location (`bigquery.datasets.get`) so the
statement runs in the right region; without that permission it falls back to
BigQuery's own location inference and warns. Under `--validate-only` (or
`--dry-run`) no graph DDL is executed and nothing is written (the live
source-table checks still run — see [Validation](#validation)); the node views
a push would create are listed under `Node views (dry run; nothing created):`,
and `--print` shows every statement's DDL in deploy order.

Statements run one at a time, in this order, each `CREATE OR REPLACE`: node
views; vocabulary views; edge views (resolved foreign keys, vocabulary edges,
derived relationships); the graph; the metric graphs; the metric views. A
failing statement stops the push and names what it was creating — for a node
view, the view and its entity — and what earlier statements already deployed
(nothing is rolled back). Knowledge Catalog is written after the graph legs.

**How a metric becomes a `MEASURE`.** A graph measure aggregates a node
property, so the aggregate's operand is exposed as one first. An operand that
is a single field aggregates that field's property directly
(`MEASURE(SUM(amount))`), even when a profile bound the field to a differently
named column. Any other operand is added as a derived property,
`<expr> AS <metric>_input`, and the measure aggregates that. A property
expression is evaluated against the table's physical columns, not the other
properties, so each field named in a compound operand is first replaced by the
column (or SQL) it is bound to, parenthesized when it is not a bare column:
`SUM(Opportunity.totalContractValue * Opportunity.probabilityOfWin)` under a
profile that binds `total_contract_value` and `probability_of_win` becomes
`total_contract_value * probability_of_win AS weighted_pipeline_input`. String
literals, function names, and qualified names are left untouched. Two metrics
whose operands resolve to the same SQL share one derived property. (Through a
node view, the column a field is bound to is its view column,
`snake_case(<field>)`.)

**Measure names.** A measure is named like its metric, so a reader selects
`AGG(<NodeTable>_<metric>)`, with one exception. When the metric's name is also
a column of the node table's backing table, the measure is named
`<metric>__measure`. That happens, for example, with a metric `won_amount =
SUM(Opportunity.wonAmount)` read through a node view whose column is
`won_amount`. BigQuery accepts a measure named like a backing column, but then
fails every query on the graph, GQL and `GRAPH_EXPAND` alike, with an internal
error. Push warns once per renamed metric, and the metric's `Query:` paragraph
in Knowledge Catalog always names the measure as deployed.

For which of your descriptive metadata (`description`, `ai_context`, field
labels, …) lands in the graph and which is dropped, see
[What push and pull preserve](fidelity.md#to-bigquery).

### Node views (hydration)

A property graph is a schema over tables, and BigQuery does not enforce a node
table's `KEY`: a key the source repeats silently doubles every match and
measure through it. So by default a push reads each bound concrete entity
through a view it generates in the graph's dataset, named
`snake_case(<entity>)`, with:

- **columns** — the entity's modeled fields only, each named
  `snake_case(<field>)` and computed from the field's binding (a column the
  model does not declare is not exposed);
- **rows** — what the entity's binding `hydration` rules make of the source:
  one row per key (`grain`), rescaled values (`normalize`), foreign keys
  rewritten to the destination's key (`resolve`), or, for an entity with no
  table, the distinct foreign keys of a relationship (`derive_from`). See
  [Hydration](profiles.md#hydration--reshaping-a-table-into-the-entity) for the
  rules and the SQL each compiles to;
- **constraints** — under `constraints: enforce`, the model's constraints
  applied to those rows: a `reject` rule's failing value withheld (NULL) or,
  for a required field or the key, the row left out; allowed-set values served
  in the member's spelling; and a `_warnings` column (`ARRAY<STRING>`) naming
  every rule the row breaks. See
  [Enforcing constraints at consumption time](validation.md#enforcing-constraints-at-consumption-time);
- **description** — the entity's description, its key, a one-line summary of
  the rules applied (and of the constraints it enforces), and its source.

The graph, its edges (a foreign key is read from its entity's view), vocabulary
and derived edges, measures, and metric graphs all read the views, so every
governed read inherits the hydration and the enforced constraints; the
`_warnings` column is read through the view itself (it is not a node
property). An abstract,
defined, or vocabulary entity gets none (a vocabulary keeps its `vocab_*`
view), nor does one with `mode: direct`, or one whose view would replace a
table the model binds (warned). The views need `bigquery.tables.create` /
`bigquery.tables.update` on the graph's dataset, as the graph does.

### Metric graphs for `GRAPH_EXPAND` (proposed)

> [!NOTE]
> A proposed kcmd enhancement. It changes what a push deploys, not the model
> spec; `--no-metric-graphs` turns it off.

`GRAPH_EXPAND` reads a graph's measures without an Enterprise reservation, but
only from a tree: at most 10 node tables, one root, every other node reached by
exactly one path. A main graph rarely is one. So after each BigQuery graph, in
the same project, dataset and location, `push` creates:

| Statement | Name | One per |
|---|---|---|
| `CREATE OR REPLACE PROPERTY GRAPH` | `<graph>__<fact_in_snake_case>_metrics` | fact entity (the entity a metric aggregates), unless the main graph already serves `GRAPH_EXPAND` for every metric of that fact |
| `CREATE OR REPLACE VIEW` | `<graph>__<fact_in_snake_case>_metrics_view` | fact entity with a metric no metric graph can hold |

The statements run in that order: the main graph, its metric graphs, then its
views. A metric graph is a tree rooted at the fact. It reaches the entities the
fact's metrics read, then further many-to-one dimensions breadth-first, up to
10 node tables. It carries only that fact's metrics, a composite metric as one
`MEASURE` per aggregate. A view has one row per fact record, with columns named
`<Entity>_<field>`. The main graph is the same with or without them. The rules
are in
[What push and pull preserve](fidelity.md#metric-graphs-for-graph_expand-proposed).

The push prints the plan, one line per metric graph and view. A dry run prints
it too, headed `Metric graphs (dry run; nothing created):`, and `--print` adds
each statement's DDL after the main graph's:

```text
Metric graphs:
  [retail -> g] metric graph p.d.g__customer_metrics: root Customer, 2 node table(s) (Region via inRegion), labels Party; metrics customer_count
  [retail -> g] metric graph p.d.g__sale_metrics: root Sale, 5 node table(s) (Product via ofProduct, Customer via soldTo, Category via inCategory, Region via inRegion), labels Party; metrics avg_price, revenue, units, win_rate; left out: purchases (inverse of soldTo)
  [retail -> g] metric graph p.d.g__sale_return_metrics: root SaleReturn, 6 node table(s) (Sale via returnOf, Product via ofProduct, Customer via soldTo, Category via inCategory, Region via inRegion), labels Party; metrics refund_total; left out: purchases (inverse of soldTo), returns (inverse of returnOf)
  [retail -> g] metric view p.d.g__sale_metrics_view: one row per Sale, 18 column(s); metrics amount_stddev
Deployed 4 BigQuery Graph(s) and 1 metric view(s).
```

Each metric that falls back to a view, or gets neither a graph nor a view, is
also a warning:

```text
Warning: [retail -> g] metric 'amount_stddev' cannot be a graph MEASURE (STDDEV cannot be a MEASURE (a measure is one of SUM, AVG, COUNT, MIN, MAX)); it falls back to the SQL view p.d.g__sale_metrics_view
```

A failing statement stops the push with
`Failed to deploy metric graph '<name>': <error>` or
`Failed to create metric view '<name>': <error>`, followed by how many graphs
and views this run had already replaced: `CREATE OR REPLACE` is not rolled
back.

Metric graphs and views are derived, not authored: Knowledge Catalog does not
record them and `pull` does not read them. A push replaces them but never drops
one, so a metric graph or view whose fact has no metrics left stays until you
drop it.

### Only modeled properties are exposed

Every node and edge table lists exactly the properties the model declares, and
one with nothing to list says `NO PROPERTIES`. The push never leaves the
properties clause out: a label without one defaults to `PROPERTIES ARE ALL
COLUMNS`, which would expose every column of the backing table — modeled or
not — on the element. That matters most for a relationship. A foreign-key edge
is backed by its source entity's table, whose columns are that node's
properties, not the edge's, so the edge is emitted as:

```sql
`proj.ds.opportunity` AS hasBuyer
  KEY(opportunity_id)
  SOURCE KEY(opportunity_id) REFERENCES Opportunity(opportunity_id)
  DESTINATION KEY(client_id) REFERENCES Client(client_id)
  OPTIONS(description="…")
  NO PROPERTIES
```

Left to ALL COLUMNS, a physical column such as `won_amount` would appear on the
edge and collide with a metric of the same name on a node (BigQuery rejects it:
"Property 'won_amount' is defined as MEASURE, but there are other declarations
with the same name"). The same rule covers a node that declares only its key
and an M:N junction edge with no fields of its own. (Verified live.)

### Class hierarchies (`extends` → labels)

This section is the rules lookup. To model a hierarchy step by step — declaring
it, binding each subtype's table, and keeping supertype counts correct — see
[Modeling class hierarchies](inheritance.md).

An entity that declares `extends: [Parent]` is a **subclass**. BigQuery Graph has
no inheritance keyword, so the push expresses the hierarchy with **labels**: a
subclass node table declares its own default label **plus one `LABEL <Ancestor>`
per supertype**, walking the full transitive chain. A node then matches its
supertype in a query — `MATCH (:Party)` returns every `Customer` and every
`Supplier` node.

You author each entity's **own** fields plus the one `extends` keyword, and the
push flattens the supertype's fields down onto each subclass. The usual
supertype has no table of its own, so mark it `abstract: true`: it has no
`source` and no key, produces no node table, and survives only as a label on its
subtypes.

```yaml
entities:
  - name: Party
    abstract: true             # no table; becomes a label on every subtype
    fields:
      - { name: id,   datatype: Integer }
      - { name: name, datatype: String }
  - name: Customer
    extends: [Party]           # the one keyword you add
    primary_key: [c_custkey]   # each subclass keeps its OWN key; keys do not inherit
    source: bigquery.googleapis.com/projects/proj/datasets/ds/tables/customer
    fields:
      - { name: id,   expression: c_custkey }
      - { name: name, expression: c_name }                      # the inherited field, bound to this table's column
      - { name: tier, datatype: String, expression: c_tier }
  - name: Supplier
    extends: [Party]
    primary_key: [s_suppkey]
    source: bigquery.googleapis.com/projects/proj/datasets/ds/tables/supplier
    fields:
      - { name: id,     expression: s_suppkey }
      - { name: name,   expression: s_name }
      - { name: rating, datatype: Integer, expression: s_rating }
```

**The supertype's fields flatten down** onto each subclass. A supertype
contributes its field names to every subclass, ordered own fields first then
inherited. An abstract supertype binds no columns of its own, so each subtype
supplies the column for every inherited name on its own table — `id` and `name`
above are bound on both the customer and the supplier. Under a concrete
supertype, a subtype restates each inherited field whose supertype expression
reads a column. This holds in each named profile, and in the model file when it
gives the subtype a source. A field whose supertype expression reads only other
fields flattens straight down.

A subtype redeclares an inherited field only to bind it. The redeclaration
names the field and gives it a column of the subtype's table. The datatype,
label, dimension, description, `ai_context` and `custom_extensions` come from
the ancestor that declares the field, and push rejects a redeclaration that
restates any of them, or gives nothing but the name. A subtype that does not bind an inherited field takes the
binding of the nearest ancestor that does. Under a concrete supertype the graph
keeps the supertype's binding either way, as the boundaries below describe.

**A shared label is reconciled by property name rather than by backing column**
(verified live). Every table that carries `LABEL Party` must expose the same property
names — here `id` and `name` — and each backs them with its own column. So the
push renders each inherited property from the subtype's own binding: `c_name AS
name` on the customer table, `s_name AS name` on the supplier table. A bare-alias
reference such as `PROPERTIES(name)` does not deploy; BigQuery rejects it with
`Unrecognized name: name`.

```sql
`proj.ds.customer` AS Customer
  KEY(c_custkey)
  DEFAULT LABEL
  PROPERTIES( c_custkey AS id, c_name AS name, c_tier AS tier )   -- id and name inherited from Party; tier is Customer's own
  LABEL Party
  PROPERTIES( c_custkey AS id, c_name AS name )                   -- Party's signature, backed by this table's columns
```

```
GRAPH proj.ds.parties
MATCH (p:Party) RETURN p.name   -- resolves on Customer and Supplier alike
```

The boundaries:

- **Fields flow down; edges and keys do not.** A subclass gains its supertypes'
  fields but **not** their relationships or their key: an edge stays bound to the
  exact node table it was declared on, and each subclass keeps its own `KEY` (a
  node table is identified by its own grain, never its supertype's). An edge
  declared on a supertype would join only the supertype's own rows and miss
  every subtype, so push rejects a concrete relationship that connects an
  abstract entity or one that a table-backed entity extends (a defined or
  abstract subtype does not count). Declare such an edge on each concrete leaf,
  for example `Customer —livesIn→ City`. An abstract relationship deploys no
  edge table, so its ends may be supertypes (see [Relationship
  hierarchies](#relationship-hierarchies)).
- **The subclass's `source` must physically expose every inherited column.** The
  flattened `name` above is read from `proj.ds.customer`, so that table (or a view
  over it) must include the column that `Customer`'s `name` field binds. A
  subclass whose table lacks a column that one of its inherited properties needs
  fails the push when the graph deploys.
- **A shared supertype label carries no OPTIONS and no measures.** A supertype's
  label is bound by every subclass table, and BigQuery forbids a label carried by
  more than one element table from carrying an `OPTIONS` clause or a `MEASURE`
  (and accepts `OPTIONS` only on a table's `DEFAULT LABEL`, never on the
  secondary `LABEL` an abstract supertype produces). So a supertype's own
  `description` and `ai_context` are dropped from its label (with a warning).
  For the same reason push rejects a metric that belongs to an abstract entity
  or to one that a table-backed entity extends. Attach metrics to a leaf class
  instead. Subclass and leaf labels are unaffected.
- **Each inherited property has one definition under the shared label.** For an
  abstract supertype, the subtype supplies that definition — it binds the
  inherited field to its own column, as `name` is bound above, and that binding is
  used. A concrete supertype already defines the property on its own table, so a
  subtype that declares the same-named field with a different column or expression
  cannot override it: the supertype's definition wins and the subtype's is dropped
  (with a warning). Redeclaring it with the same column is a harmless no-op.
- **An empty label says `NO PROPERTIES`.** A label written with no properties
  clause means `PROPERTIES ARE ALL COLUMNS`. In a hierarchy that would expose
  every column of the table again under the label. Those copies clash with the
  properties the push renders explicitly on the same table, and BigQuery rejects
  the graph with `Property '<name>' has more than one definition in the element
  table`. So inside a hierarchy the push writes `NO PROPERTIES` for any label
  with nothing to list, on both backends. That covers an abstract root with no
  fields (a `BusinessObject` label on every node, for example), a supertype
  whose fields the subtype leaves unbound, and a subtype with no bound fields of
  its own. The labels still work for `MATCH (:BusinessObject)`. The same rule
  applies outside hierarchies (see [Only modeled properties are
  exposed](#only-modeled-properties-are-exposed)).

An entity marked **`abstract: true`** is a conceptual class with no physical
table: it has no `source`, no key and no field expressions, produces **no node
table**, and survives only as a `LABEL` on its concrete descendants. Push
rejects an abstract entity that declares a `source`, a `primary_key`, a
`unique_keys` entry or a field expression. Its field names still flatten
down, and each concrete subtype supplies the column for each of those names, so
the shared label's signature is present on every subtype table. An abstract
entity that no concrete entity extends has nothing to attach to and is dropped
with a warning. `abstract` is an explicit marker: a non-abstract entity with no
`source` is treated as a binding error and fails the push, never
silently dropped as if it were table-less. In Knowledge Catalog, every entity
gets an entry, abstract or not, and a `reference` link runs from each entity to
each parent it extends.

A supertype **may** instead be concrete — carry its own `source` and `primary_key`.
It then becomes both its own node table and a label on its subtypes (a concrete
supertype without a `primary_key` forms no node table and its label is left off
its subtypes, with a warning; give it a `primary_key`, or mark it `abstract: true`
when it has no table of its own). Every subtype table
must still expose columns that render to the supertype's property signature, so
each subtype table has to carry the supertype's columns under the same names. The
supertype's own rows and its subtypes' rows are distinct nodes: a real thing
present in both the supertype table and a subtype table is matched twice under the
supertype label. Because table-backed subtypes extend it, a concrete supertype
cannot be a relationship endpoint or own a metric. Prefer an abstract supertype unless
each real thing lives in exactly one table under the hierarchy.

**Multiple supertypes and diamonds.** `extends` takes a list, so a subclass may
extend several supertypes and carry every one's label. The push expands `extends`
to the full transitive ancestor set, de-duplicated. A diamond — two supertypes
that share a grandparent — lists that grandparent's label once, so
`MATCH (:Grandparent)` matches the leaf a single time. A field may be declared
or rebound on only one side of a diamond. When two supertypes that do not extend
each other both declare or rebind the same field, push rejects the model,
because nothing says which definition wins. A field that reaches the leaf by two
paths from a single declaration on the shared grandparent is fine. `extends` may
not form a cycle, and push rejects one. Depth and breadth do not
change the rules: each concrete table binds every inherited property to its own
column, and these shapes deploy on both BigQuery Graph and Spanner Graph
(verified live for a diamond and for a three-level hierarchy with several
concrete leaves).

### Relationship hierarchies

A relationship may `extends: [Rel, …]` other relationships, and a relationship
may be `abstract: true` (both `/google` extensions; see [Relationship
inheritance](inheritance.md#relationship-inheritance)). Edge labels are resolved
like node labels:

- **An abstract relationship emits no `EDGE TABLE`.** It keeps `from`/`to` but
  must not declare `from_columns`/`to_columns` (the loader rejects it), and push
  does not require join columns of it. One that nothing extends is warned.
- **Ends.** An abstract relationship's `from` and `to` may be abstract entities
  or supertypes: it binds no join, and the leaf rule exempts it. A concrete
  relationship, a sub-relationship included, connects concrete leaves only (see
  [Class hierarchies](#class-hierarchies-extends--labels)).
- **A concrete edge in a hierarchy** is emitted as `DEFAULT LABEL`, then its
  `OPTIONS` (BigQuery), then its properties clause (`NO PROPERTIES` for a
  foreign-key edge), then `LABEL <ancestor> NO
  PROPERTIES` for every transitive ancestor, nearest first, de-duplicated.
  Ancestor labels carry no properties, so edge tables over different source
  tables share the label without agreeing on columns — `MATCH
  ()-[:Ancestor]->()` spans all of them.
- **A concrete relationship that others extend** is emitted with `DEFAULT
  LABEL` and `NO PROPERTIES`, the only property signature compatible with its
  children's; its `OPTIONS` are dropped with a warning (BigQuery rejects
  `OPTIONS` on a label that other tables also define). An edge present in its
  table and a child's table is matched twice under its label.
- **Edges outside any hierarchy are unchanged** — no `LABEL` clause.
- **The loader warns** on a dangling parent, a cyclic `extends` chain, and a
  child whose `from`/`to` is neither the parent's end nor a subtype of it (per
  entity `extends`). Push rejects a dangling parent.
- **Knowledge Catalog.** Every relationship (other than a many-to-many
  association) has its own `semantic-relationship` entry, abstract parents
  included. A child relationship appends `Specializes: <parent>, ….` to its
  entry description, and `pull` strips that line back into `extends`.

### Relationship inverses (`inverse`)

A relationship is directed, but a question often reads it the other way — "the
opportunities of this client" over `hasBuyer` (Opportunity → Client). Name that
reading with `inverse:` (`/google` profile) rather than declaring a second
relationship; it is the native home of OWL `owl:inverseOf` (see [Inverse
properties](owl-import.md#inverse-properties-owlinverseof)):

```yaml
relationships:
  - name: hasBuyer
    from: Opportunity
    to: Client
    from_columns: [client_id]
    to_columns: [client_id]
    inverse: hasOpportunity      # Client -[hasOpportunity]-> Opportunity
```

The push emits the inverse as a **second edge table over the same backing
table**, with `SOURCE` and `DESTINATION` swapped and the inverse name as its
label. There is one set of rows and one join; only the direction label differs:

```sql
`proj.ds.opportunity` AS hasBuyer
  KEY(opportunity_id)
  SOURCE KEY(opportunity_id) REFERENCES Opportunity(opportunity_id)
  DESTINATION KEY(client_id) REFERENCES Client(client_id)
  NO PROPERTIES,
`proj.ds.opportunity` AS hasOpportunity
  KEY(opportunity_id)
  SOURCE KEY(client_id) REFERENCES Client(client_id)
  DESTINATION KEY(opportunity_id) REFERENCES Opportunity(opportunity_id)
  NO PROPERTIES
```

so both `MATCH (o)-[:hasBuyer]->(c)` and `MATCH (c)-[:hasOpportunity]->(o)`
resolve. (BigQuery accepts two edge tables over one backing table — the DDL
above deploys, verified live.) The rules:

- **One name, no second definition.** The inverse carries no columns,
  description, or synonyms of its own; the relationship's `OPTIONS` stay on the
  forward label only, and an M:N inverse shares the junction's properties.
- **Unique across the graph.** The inverse becomes an element alias, so it must
  differ (case-insensitively) from every entity, relationship, and other
  inverse name, and from its own relationship's name; the loader rejects a
  clash. An IR that reaches the push some other way (a Knowledge Catalog pull)
  has the clashing inverse omitted with a warning instead.
- **Spanner Graph** emits the same pair of edge tables.
- **Hierarchies.** The reversed edge carries only its own label: the
  relationship's ancestor labels name the forward direction, so they are not
  repeated on it. An abstract relationship emits no edge table, so its
  `inverse` is not emitted either (warned).
- **Knowledge Catalog** appends an `Inverse: <name>.` trailer to the
  `semantic-relationship` entry's description, and `pull` strips it back into
  `inverse:` (a description that ends that way is read as an inverse).

## What gets created in Spanner

When the deployment target is a Spanner graph, `push` executes the same
`CREATE OR REPLACE PROPERTY GRAPH` — but generated for Spanner Graph, which
differs from BigQuery Graph in five ways:

| Model element | Spanner construct | Notes |
|---|---|---|
| Model | `PROPERTY GRAPH` | named by the target's `graphs/<g>` segment, **bare** (no backticked `project.dataset.` prefix) |
| Entity | `NODE TABLE` | backed by the table the entity's `source` names after `tables/`, in the target database. `…/tables/Orders` gives `Orders`, and `…/tables/ops.stations` gives `ops.stations`, a table in schema `ops`. Keyed by the entity's primary key; Spanner rejects the graph unless the table's primary key or a unique index covers that key. The node table lists the entity's bound fields, and one with none is written with `NO PROPERTIES`. |
| Relationship | `EDGE TABLE` | connects the two entities' node tables; a foreign-key edge declares no fields of its own, so it is written with `NO PROPERTIES` and exposes none of its table's columns |
| Relationship `inverse` | a second `EDGE TABLE` over the same table | `SOURCE`/`DESTINATION` swapped, as on BigQuery (see [Relationship inverses](#relationship-inverses-inverse)) |
| Metric | — dropped | Spanner has no `MEASURE`, so a Spanner deployment uses a profile that excludes every metric, and push rejects one that leaves a metric available |
| Entity `extends` | extra `LABEL` clauses on the subclass node table | same label-and-flatten handling as BigQuery (see [Class hierarchies](#class-hierarchies-extends--labels)) |

- **Bare table and graph names.** A Spanner property graph lives inside one
  database and names tables in that same database, so the generator emits bare
  names — no `project.dataset.` qualifier on either the tables or the graph. A
  table in a named schema keeps its schema, as in `ops.stations`.
- **No `MEASURE`.** Spanner has no `MEASURE`, so a Spanner deployment uses a
  profile that excludes every metric, and push rejects one that leaves a metric
  available. The
  BigQuery-only rule that a metric must resolve to a single entity therefore does
  not apply to a Spanner target (see [Validation](#validation)).
  Push refuses a Spanner deployment that names no profile in a model with
  metrics; name a profile with `metrics_exclude: "*"`.
- **No per-element `OPTIONS`.** `description` and `ai_context` are not emitted
  into the Spanner DDL; they ride into Knowledge Catalog instead — mirroring how
  BigQuery's graph-level `OPTIONS` is dropped. See
  [What push and pull preserve](fidelity.md#to-spanner).
- **Its own SQL.** A field reads its `SPANNER` expression, else its `ANSI_SQL`
  one, and is left out with a warning when it has neither.
- **Async DDL.** The statement is applied through the Spanner Admin
  `updateDatabaseDdl` long-running operation, polled to completion (BigQuery runs
  its DDL through `jobs.query`). No region detection is needed — the DDL runs in
  the database the target names.

Spanner Graph needs an Enterprise or Enterprise Plus edition instance, or a
free trial instance. In its first phase, push reads the instance of each
Spanner deployment it would deploy. It refuses such a deployment on a Standard
edition instance before anything is written, also under `--validate-only` and
`--skip-source-check`.
When push cannot read the instance under `--skip-source-check`, it warns that
it could not read the edition and skips this check. A graph on a Standard
edition instance then fails in the second phase, after Knowledge Catalog is
written. Without that flag, the source check reads the same instance first and
stops the push when it cannot.

Under `--validate-only` nothing is applied; add `--print` to see the generated
Spanner DDL. Unlike the BigQuery leg, a Spanner-targeting model's source tables
are **not** probed before deploy. Its actions are: every `sql` executor
statement is planned against the target database first, on both legs (see
[Validation](#validation)).

## What gets created in Knowledge Catalog

Each element of your model maps to one catalog resource. Every resource type
below except `semantic-action` and `semantic-constraint`
is a built-in system type under `dataplex-types/global` — push references them,
it never creates them. Those two are custom, and `kcmd init --semantic-model`
creates them in your own project at `global`; push still writes only entries
and links.

> Set `KC_TYPE_PROJECT` to read these system types from another project, and
> `DATAPLEX_ENDPOINT` to target a non-prod Dataplex host; both default to
> production (`dataplex-types` / `https://dataplex.googleapis.com`).

| Model element | Catalog resource | Kind | Id |
|---|---|---|---|
| Model | `semantic-model` | entry — anchor / parent of the rest | `<model>` |
| Entity | `semantic-entity` (+ built-in `schema` aspect) | entry | `<model>/entities/<entity>` |
| Metric | `semantic-metric` | entry | `<model>/metrics/<metric>` |
| Relationship | `semantic-relationship` | entry | `<model>/relationships/<relationship>` |
| Each ordered pair of related entities | `semantic-link` | entry link between the two entity entries | `semantic-link-` and a hash |
| Each relationship's two entities, and each parent in `extends` | built-in `reference` | entry link | `semantic-relationship-` or `semantic-extends-` and a hash |
| Grounding (bound entity → physical) | `schema-join` (type `JOIN`) to the `@bigquery` node view / table entry and graph node entry | entry links | `<model>-bind-view-<entity>`, `<model>-bind-node-<entity>` |
| Action | `semantic-action` (custom type) | entry | `<model>.actions.<action>` |
| Constraint | `semantic-constraint` (custom type) | entry | `<model>.constraints.<constraint>` |

The model entry also carries the `kcmd-push-state` label, which reads `writing`
until the push's last write sets it to `finished`. On each entry, push owns the
`schema`, `semantic-*`, `guidelines`, `sql-expressions`, `semantic-extensions`
and `overview` aspects it writes, the display name, the description and the
`kcmd-push-state` label. When it updates an entry, it keeps
every other label and the source `resource`, `system`, `platform`, `createTime`
and `updateTime` another tool set.

An entity entry carries the fields it declares in the `schema` aspect (name,
data type, description, synonyms and any `label` per field), and its keys and
unique keys (`primaryKey` / `uniqueConstraints`) in its `semantic-entity`
aspect. A relationship entry carries its endpoints and join columns in its
`semantic-relationship` aspect. Any element with `ai_context.instructions` (the
model, an entity, a field, a metric or a relationship) also gets a built-in
`guidelines` aspect holding that text. An element with `ai_context.examples`
also gets an `overview` aspect holding them.

### What an agent reads through `lookup_context`

`lookup_context`, the call an agent grounds on, returns each entry's
description and its schema. It does not return aspects or entry links. So when
push deploys a BigQuery graph, it ends each description with how to read
the entry:

| Entry | Paragraph | Example |
|---|---|---|
| Model anchor | `Contents:` every metric, then every entity, by name, so an agent whose search matched nothing can pick the entries to look up. Sized to keep the description within Dataplex's 2,000 characters (`… N more`) | `Contents: metrics revenue, aov; entities Customer, Order, Product.` |
| Bound entity | `Read through:` its node view (its table under `mode: direct`), its graph and node label | ``Read through: node view `p.d.order`; graph `p.d.shop_graph`, node Order.`` |
| Bound entity | `Relationships:` every edge from it (`→`) and to it (`←`) with the join columns of the views both ends are read through, this entity's column first; a many-to-many edge names its junction table. Sized to keep the description within Dataplex's 2,000 characters (`… N more`), just before `Constraints:` / `Hydration:` | `Relationships: placedBy → Customer (customer_id = customer_id).` |
| Bound entity under `hydration.constraints: enforce` | `Constraints:` the rules its node view applies (rows excluded, values withheld, flagged only), the spelling it normalizes, and the relationship rules it reports, each with how often it breaks over the hydrated rows (push measures it after the deploy); every broken rule is named in the view's `_warnings` column. At most 800 characters: the rules no row breaks fold into a count first. Just before `Hydration:` | `Constraints: enforced in the node view after hydration; … Values withheld (served as NULL): floorPrice by DealPricing_floorPrice_lte_targetPrice (50.1%). …` |
| Metric | `Query:` its measures composed as its expression over `GRAPH_EXPAND` of the graph that holds them (or its expression over its fallback view), last | `Query: SELECT AGG(Order_revenue) FROM GRAPH_EXPAND("p.d.shop_graph__order_metrics")` |

The query runs as written; to slice it, add `WHERE` and `GROUP BY` over the
same `GRAPH_EXPAND`'s `<NodeTable>_<field>` columns. The paragraphs are
derived from the model and its deployment target, so `pull` drops them and the
next push writes them again.

### Binding links

When the graph and the source datasets are visible, push links each bound
entity entry to the `@bigquery` entry it is read through — its generated node
view, or its table under `mode: direct` — and to its node in the property graph
(`…/propertyGraphs/<graph>/nodes/<Label>`). Each is a `schema-join` of type
`JOIN` on the entity key, described `Binding: <entity> is read through …`, so
a reader can walk from an entity, or from a glossary term, to the physical
asset inside the catalog. The `@bigquery` entries exist
only once BigQuery has created the view or graph and Dataplex has indexed it,
so a refused binding link is a warning, not a failed push; the next push writes
it. Push deletes any binding link of the entity that it does not write.

An entry link can reference only entries of its own region, and a `@bigquery`
entry lives in its dataset's location. Binding links therefore need the model's
entry group in the same location as the data — `scope:
semantic-model.<project>.us.<entry_group>` for datasets in `US`. With the entry
group anywhere else (`global` included), push writes none and says so in one
warning.

### Glossary definition links

`kcmd glossary push` links each term to the BigQuery table column it names and
to the kcmd `semantic-entity` / `semantic-metric` entry. If Dataplex refuses
the link on the kcmd entry, the publisher links the term to the matching column
of the entity's node view (`Schema.<snake_case field>`; the whole view for an
entity or a metric) instead, and reports `… linked … (node view fallback)
instead`. An entity with no node view (`mode: direct`) keeps only the table
link.

An **action** entry carries its executor, its typed parameters, the names of the
constraints that gate it (`guards`), and the concepts it changes (`affects`) in
a `semantic-action` aspect, along with the action's `ai_context.instructions`. A
guard is stored as the constraint name, matching a sibling `semantic-constraint`
entry on the same model, so a reader holding one action entry can find the rules
it is checked against. An affected concept is stored as its name — an entity or
a relationship, named the same way, since the model is what says which.
That aspect type is provisioned in your project rather than referenced from
`dataplex-types`, because Dataplex has no built-in action type yet; when one
ships, the entries move to it and their shape does not change. (This is the
prototype scope — an action's `precondition` is not modeled yet, and nothing
consumes its `affects`.)

A **constraint** entry carries its rule in a `semantic-constraint`
aspect, together with the whole of any `ai_context` declared on it. The rule
sits in the one body a constraint has, `judgment`: the condition written as a
sentence, settled by a language model reading the attempted call. The aspect
type also declares `expression` and `evaluation`, which nothing writes and
nothing reads. They are kept so that an aspect type already provisioned in your
project still matches what `kcmd init` would create, and an entry left holding
an old `expression` reads back as a named skip rather than as a rule. The
constraint's `description` is the entry's own summary, because that sentence is
what a caller refused by the rule reads. Its type is provisioned alongside the
action pair and for the same reason. All three parts of `ai_context` survive.

The aspect also carries the constraint's two routing words: `onViolation` (what
the engine does to the write — `reject`, `escalate` or `warn`) and `severity`
(how grave the breach is — `critical`, `high`, `medium` or `low`). They ride the
aspect rather than the entry source because they are machine-readable and not
prose. `onViolation` is required of every constraint, and `severity` is not: one
that declares no severity is published without the field and reads back without
it, so the ranking stays the model's to define. Each is read on its own, so an
unrecognized word in one is dropped on pull with a warning without costing the
reader the other. An unreadable `severity` leaves the rule unranked, which
nothing reads yet. An unreadable `onViolation` is dropped too, but there is no
fallback to drop to now that the word is required: the pull warns that the
constraint will not push, and loading the pulled model names the constraint and
says the word is missing. That is the outcome to want when the catalog no
longer says how a breach routes.

The catalog's metadata does not hold your whole model, and pull rebuilds the
model file and profile files from that metadata alone. For exactly what
the metadata stores and what is never stored, see
[What push and pull preserve](fidelity.md#to-knowledge-catalog).

### The second-generation types

Push and pull use the second generation of the semantic types. An older `kcmd`
pushed a first generation, with dotted entity and metric ids
(`<model>.entities.<entity>`) and a `schema-join` link per relationship. A push
over that entry group deletes those entries and links. Pull rebuilds no model
pushed with the first-generation types, and warns about it instead.

Each relationship other than a many-to-many association has an entry of its
own. Entry ids are `<model>`, `<model>/entities/<entity>`,
`<model>/metrics/<metric>` and `<model>/relationships/<relationship>`.

A `semantic-link` joins each ordered pair of related entities. Built-in
`reference` links run from each relationship's entry to the entries of its
source and target entities, and from each entity's entry to the entry of each
parent in its `extends`. An unbound relationship gets its `reference` links
too. Their ids start with `semantic-relationship-` or `semantic-extends-`,
followed by the first 32 hex characters of a SHA-256 hash. The hash covers
`<model>/<relationship>/source` or `<model>/<relationship>/target` for a
relationship, and `<model>/<child>/<parent>` for a parent. Push owns only the
`reference` links with those prefixes. It deletes the ones the model no longer
has and leaves every other `reference` link alone. Pull reads no entry link.

An entity's `schema` aspect lists only the fields it declares. A field it
inherits and only rebinds is a `fieldExpressions[]` record in its
`sql-expressions` aspect, with nothing in `schema`. A field's `guidelines`,
`overview` and `semantic-extensions` aspects sit at `Schema.<field>` on the
entity that declares the field.

`semantic-metric.entity` holds the metric's entity, declared or derived. Pull
writes it back as `entity:`. `excludedInProfiles` follows the order of the
model entry's `profiles` list.

Push writes each entry's whole `overview` aspect from the workspace and never
reads it back. `examples` come from the model file's `ai_context.examples`.
`content`, `contentType` and `links` come from the entry's sidecar. The
sidecar is the file `<entry-id>.overview.md` in the directory that holds
`<model>.yaml`, so the model's sidecar is `<model>.overview.md` and an
entity's is `<model>/entities/<entity>.overview.md`. The sidecar's frontmatter holds
`contentType` and `links`, and its body is `content`. `contentType` is
`MARKDOWN` or `HTML`. Each link has a `url` and an optional `title`. A
malformed sidecar fails the push before anything is written. So does a
sidecar that is not valid UTF-8. Push warns about a sidecar that names no
entry of the model. A field's overview holds its
examples alone. An overview edited in the console survives a push only once
`kcmd pull` writes the edit into the sidecar. Pull writes a sidecar for each
entry whose overview has content, a content type or links. It warns about a
local sidecar the catalog did not return, and `--force-remove` deletes it.

Pull writes the model file, and one file per named profile of a Google-flavor
model. A profile file keeps the actions it binds locally, since the catalog
stores no profile's actions. A local profile file the pull did not write draws a
warning, and `--force-remove` deletes it.

## Validation

`push` and `--validate-only` run the same checks, apart from the Knowledge
Catalog checks on the entry group, which only a push without `--validate-only`
runs. [push](#push) says when each check runs.
Each check enforces a rule the [model specification](model_spec.md) *defines*;
this section is the operational side of it — what the tool does when the rule is
broken — and links to the definition it enforces:

Before these checks even run, the document must **load**, and the loader is strict:
`version` is required and must be `0.2.0.dev0` (vanilla Ossie) or
`0.2.0.dev0/google` (the extended profile); every object is closed, so an unknown
key — including a native key under vanilla, or a `custom_extensions` block under
`/google` — is rejected; names must be unique within their scope; every
`extends` must name an entity defined in the model; every dialect entry must use
one of the supported SQL dialects ([model spec §2.5](model_spec.md#25-expressions));
a plain-string `expression` is allowed in a model file
only under `0.2.0.dev0/google` (while a profile binding accepts a plain-string
`expression`, a column name, or a `dialects` list in either flavor); a field's
or metric's `expression`, in the string form and in each dialect entry, may not
be empty, only whitespace or only a comment; and a field's `expression` may not
be only its entity's qualifier, such as `orders.`. A load failure is reported the
same way as a validation failure — nothing is touched, non-zero exit — and is
defined in [model spec §1](model_spec.md#1-status-and-baseline),
[§2](model_spec.md#2-document-shape), [§6](model_spec.md#6-the-extension-mechanism),
and [§4.1](model_spec.md#41-narrowings-stricter-than-ossie).

* **Every deployment target must be a valid BigQuery Graph, Spanner Graph, or
  AlloyDB database resource name.** Each deployment in `deployments:` (or in a
  vanilla model's `GOOGLE` block) must have a unique `name` and a distinct `target` that
  matches
  `bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>`,
  `spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/graphs/<g>`,
  or `alloydb.googleapis.com/projects/<p>/locations/<l>/clusters/<c>/databases/<d>`
  (for example a `propertyGraph` typo, a Spanner graph under `propertyGraphs/`,
  a leading `//`, or a `…/entryGroups/@bigquery/entries/…` entry form is
  rejected). The error names the offending target and what to write instead. A
  **logical model that declares no deployments** is allowed: it deploys no graph
  and publishes to Knowledge Catalog only. This gate runs before any destination
  leg, so a malformed target writes **nothing** — not to the graph and **not to
  Knowledge Catalog**; the push aborts with a non-zero exit and no entries are
  created. Defined in
  [model spec §4.1](model_spec.md#41-narrowings-stricter-than-ossie) and
  [§7.2](model_spec.md#72-deployments-and-deployment-targets) (the grammar). *(static)*
* **Every metric on a BigQuery Graph model resolves to exactly one entity** —
  otherwise it would be dropped from the BigQuery Graph. Set the metric's attach
  entity, or scope its expression to a single entity. This rule is
  BigQuery-only: Spanner has no `MEASURE`, so a Spanner deployment uses a
  profile that excludes every metric, and push rejects one that leaves a metric
  available. Defined in
  [model spec §4.1](model_spec.md#41-narrowings-stricter-than-ossie). *(static)*
* **Each deployment meets the rules of its engine.** Every push checks each
  deployment the model declares, whether or not the push deploys it. A
  deployment that names no profile uses the model file's own bindings. They
  must give every concrete entity a source and every relationship both join
  column lists. They must also bind every field that each deployed metric
  reads, directly or through another field. On a BigQuery or Spanner
  deployment, every concrete leaf entity must have a `primary_key`, and the
  model file's own bindings must give every field of a concrete leaf entity an
  expression, inherited fields included, since the model file has no
  `fields_exclude`. An AlloyDB deployment reads only
  the `ALLOYDB` or `ANSI_SQL` text of each metric and field. A Spanner
  deployment deploys no metric. On a BigQuery deployment, every relationship's
  `to_columns` must name exactly its target's `primary_key` columns, in any
  order (not a `unique_keys` entry, and no extra columns), and each metric
  becomes a measure, so it must read every field inside `SUM`, `AVG`, `COUNT`,
  `MIN` or `MAX`, each over one operand. Scalar SQL may combine the aggregates,
  as in `SUM(orders.amount) / COUNT(orders.order_id)`, but a function around
  them must be a BigQuery built-in function whose name has no dot, or one with
  the `SAFE.` prefix. The measure rule skips a metric that has only a vendor
  text. A BigQuery or Spanner graph cannot hold an entity and a relationship
  whose names match ignoring case. A BigQuery graph also cannot hold a metric
  named like a field of another entity, ignoring case. BigQuery limits the
  options kcmd writes on each label and property, too. The description holds at
  most 1,024 characters, counting the field label and the time-dimension line
  kcmd adds to it. Each `extensions` value (`instructions`, and `examples`
  serialized as a JSON array) holds at most 1,024 characters. An element holds
  at most eight synonyms of one to 300 characters each. No two of them may
  match ignoring case, and none may match the element's own name.
  A deployment that names a profile is held to the graph `primary_key` rule
  and, on BigQuery, the join-key and measure rules under that profile, with the
  keys and joins it states, except for the metrics it leaves unavailable. On
  Spanner, that profile must leave every metric unavailable.
  *(static)*
* **A third-party table is written as its entry name, and takes the dialect
  its entry records.** A table outside Google Cloud is written as the entry
  name of its Knowledge Catalog entry,
  `projects/<p>/locations/<l>/entryGroups/<g>/entries/<id>`, in an entry group
  whose id does not begin with `@`. An entry name in a system entry group is
  rejected with the resource name to write when there is one, and so are a
  Knowledge Catalog name such as `snowflake:acme.retail.public.orders` and a
  value with a leading `//`. Push and `kcmd profiles` look each entry up once
  before they load the model. The prefix of the entry's `fullyQualifiedName`
  gives the dialect: `snowflake:` gives `SNOWFLAKE`, `databricks:` gives
  `DATABRICKS`, `mysql:` gives `MYSQL`, `postgresql:` gives `POSTGRES` and
  `sqlserver:` gives `SQLSERVER`. An entry with no `fullyQualifiedName` gives
  the dialect of its `entrySource.system`, in any letter case: `SNOWFLAKE`,
  `DATABRICKS`, `MYSQL`, `POSTGRESQL` or `POSTGRES`, or `SQLSERVER`. A missing
  entry, or one that gives no dialect, stops the command before anything is
  written. So does an entry whose `fullyQualifiedName` names something other
  than a table or view, such as the schema `snowflake:acme.retail.public`. A
  field the model file binds to the table then needs SQL in that dialect or in
  `ANSI_SQL`. So does every field and metric of a profile whose sources fix
  that dialect. *(live — needs read access to the entry)*
* **A Spanner table takes its database's dialect.** Knowledge Catalog does not
  record whether a Spanner database is GoogleSQL or PostgreSQL, so push and
  `kcmd profiles` read each database a source names once, with the Spanner
  API, before they load the model:
  `GOOGLE_STANDARD_SQL` gives `SPANNER` and `POSTGRESQL` gives `POSTGRES`. A
  database that cannot be read stops the command before anything is written.
  A field the model file binds to one of its tables then needs SQL in that
  dialect or in `ANSI_SQL`. So does every field and metric of a profile whose
  sources are in that database. Spanner creates no property graph in a
  PostgreSQL-dialect database, so push refuses a Spanner deployment there
  before anything is written. *(live — needs `spanner.databases.get` on the
  database)*
* **Each field the model file binds has a text its entity's database runs.**
  The field needs an entry in the dialect of its entity's source, an
  `ANSI_SQL` entry, or the string form. `kcmd import --transpile` adds a
  BigQuery entry for a text it can translate. Every push
  runs this check, whether or not a deployment uses those bindings. When a
  BigQuery, Spanner, MySQL or Databricks table runs an `ANSI_SQL` entry or the
  string form with a double-quoted token, push accepts it and warns, naming
  the field or metric, since those databases read that token as text.
  PostgreSQL, AlloyDB, SQL Server and Snowflake tables read it as a name, and
  so does a Spanner table in a PostgreSQL-dialect database.
  *(static)*
* **The model file's own bindings are all in one database.** One database
  means what it means for a profile ([Sources](profiles.md#sources)). Every
  push checks them, whether or not a deployment uses them. *(static)*
* Every class hierarchy follows the inheritance rules. `extends` forms no cycle,
  and no field is declared by two supertypes that do not extend each other. A
  subtype redeclares an inherited field only to bind it. A concrete entity
  with a source restates each inherited field whose ancestor's expression reads
  a column. An
  abstract entity declares no source, key or field expression. Relationships
  and metrics attach only to concrete leaf entities (an abstract relationship,
  which deploys no edge table, is exempt). The rules and their
  reasons are in [Class hierarchies](#class-hierarchies-extends--labels).
  These checks run on every push, including a `--no-deployment` push to
  Knowledge Catalog alone. *(static)*
* **Relationships join two different entities in one direction.** Push rejects
  a relationship from an entity to itself, and relationships in both directions
  between two entities. *(static)*
* **Every action is well-formed.** Each action parameter must settle on one
  scalar datatype: projected from a field it names with `concept` and `field`,
  or stated as its own `type`. Naming an entity as a `type`, or restating a
  projected parameter's type, is rejected. Two parameters a caller could confuse
  — projecting the same field, or sharing a declared type — must each carry
  their own `description`. Each executor must carry its coordinates (an `mcp`
  server + tool, a `rest` endpoint + method, a `grpc` service + method, or at
  least one non-blank `sql` statement) with no blank field. A coordinate omitted altogether is rejected earlier, when the
  model is parsed. An action with *no* executor is not an error at all: the
  executor is a physical binding, so an action no binding performs here is still
  a declaration worth publishing. Each name in the
  action's `guards` must resolve to a constraint that the same model declares. A
  guard resolving to nothing leaves the author believing the write is checked
  when nothing checks it. Every `concept` in the action's `affects` must
  likewise resolve to an entity or a relationship the same model declares, and
  its `fields` must be fields of that concept — for a relationship, the
  properties of the junction table backing a many-to-many edge, so a plain
  foreign-key edge has none. Naming fields beside a `delete` is rejected,
  because a `delete` takes the whole instance. An affected concept that resolves
  to nothing is reported and then left alone, since every later check about it
  is meaningless; undeclared fields do not chain that way, so a concept that
  does resolve reports every field it does not have. Everything that reads the
  ontology — the concept check and the field check both — stands down on a
  profile push, because pruning drops whole entities and whole relationships as
  well as unbound fields, and an action reaches no graph in any case. Pruning
  now drops an action that names a dropped *concept*, so for the concept check
  the offending action is gone before the check would run; it does not drop one
  whose `affects` names a pruned *field*, so a blast radius can still name a
  field the published entity no longer carries, and nothing reports it. The
  fields-beside-a-`delete` check reads only the entry, so it still applies. A `sql` executor is checked further, because it carries the
  write itself rather than a pointer to whoever performs it: each statement must
  begin with `INSERT`, `UPDATE` or `DELETE`, must contain no `;` other than a
  trailing one, and may reference only `@parameter` names the action declares.
  Together those are what let every value be bound instead of interpolated, so
  an argument cannot reach the store as SQL. Where the key of an inserted row
  comes from is the statement's own business: a SQL function such as
  `GENERATE_UUID()`, a declared parameter, or a key column left out where it
  has a default. `affects` has no bearing on it. A declared parameter hands the
  key to the caller, and since the verb check reads only a statement's first
  word, an upsert passes and overwrites the row that key names. Four further
  rules are enforced at parse time: exactly one executor kind (`executor
  requires exactly one kind, but 2 given (mcp, rest)`),
  the closed `create` / `modify` / `delete` vocabulary for `operation`, the
  rejection of a repeated guard name, and the rejection of a repeated
  concept-and-operation pair in `affects`. Every check named so far is static —
  it reads the document alone — so it runs on every push, regardless of
  destination. What the *names* in a statement mean is settled live instead, by
  the store the profile binds: see the DML pre-flight under
  [Validation](#validation). Note that actions themselves
  deploy **only** through the Knowledge Catalog leg (BigQuery and Spanner graph
  deployments warn that actions are not deployed to the graph). *(static, plus a
  live pre-flight for a `sql` executor)*
* **Every constraint states its rule as a judgment.** A constraint has one
  body, `judgment`, and it must be non-empty; one declaring no judgment states
  no rule at all, and the error names it. `expression` is a reserved key: a
  model stating one is answered with a sentence telling the author to restate
  the rule in words, rather than with an unrecognized-key error that explains
  nothing. What a judgment costs is in
  [Actions](actions.md#what-a-judgment-costs). *(static)*
* **Every constraint says what a violation does.** `on_violation` is required
  rather than defaulting. Any of the three words is allowed, `reject` included;
  leaving the key out is the error, because an unmarked constraint rejects and
  that is too strong a consequence to inherit by silence. Every `Entity.field`
  token in the judgment is resolved against the model, so a field name that has
  been renamed out from under the sentence is caught. Quoted text is scanned
  too: in prose, quotes usually set off a field name for emphasis, and skipping
  those would hide the renames this check exists to catch. A qualifier that is
  not a known entity — a relationship-qualified name like `OrderedAs.quantity`,
  or a metric reference — is left alone rather than guessed at, so a valid
  sentence is never falsely rejected. So is a token whose **tail** names
  something the model declares that is not a field of the head: `Customer.Order`
  and `LineItem.BelongsTo` are traversals, and `Order.total_revenue` names a
  metric, none of which the check can settle. So is an entity that declares no
  fields, since fields are optional and a logical model may declare none; an
  empty list is no evidence that a field is missing. So is a token carrying a
  third dotted segment, which is a path rather than a field. What is left is the
  case the check exists for: a tail the model declares under no kind at all,
  next to an entity it does declare. *(static)*
* Like an action, a constraint reaches Knowledge Catalog only (BigQuery and
  Spanner graph deployments warn that constraints are not deployed to the
  graph, though a BigQuery node view still applies the constraints its binding
  enforces). Two rules are enforced at parse time:
  `on_violation` and `severity` are each a closed vocabulary — `reject` /
  `escalate` / `warn` and `critical` / `high` / `medium` / `low` — so an
  unrecognized word is a hard load error rather than a value that publishes and
  means nothing. *(static)*
* **Each deployment's tables are in the database it deploys to.** A Spanner or
  AlloyDB deployment reads only tables in its target database. A BigQuery
  deployment reads only BigQuery or BigLake tables, in any dataset of any
  project. A Cloud SQL table fails every deployment, and so does a third-party
  table, since kcmd has no engine that reads one. A push with no deployment
  publishes such a model to Knowledge Catalog. Every push checks every
  deployment this way, whether or not `--deployment` names it, and under
  `--no-deployment` too. It reads each entity's `source` from the profile the
  deployment names, or from the model file when it names none. *(static)*
* **Every source names a table Knowledge Catalog knows about.** Every push
  runs this source check before it writes anything, under `--no-deployment`
  and `--validate-only` too. It looks up the Knowledge Catalog entry of each
  BigQuery, BigLake, Spanner and AlloyDB table a source names. It checks the
  model file's own bindings and every profile, whether or not a deployment
  uses them. A table with no entry stops the push. So does a table you can
  query but whose entry you may not read, and a table whose location push
  cannot read. The check also refuses a profile whose BigQuery and BigLake
  tables share no location, since BigQuery runs each query in one location
  ([Sources](profiles.md#sources)). The model file's own bindings count as a
  profile here. Push reads the entry of a Cloud SQL or third-party table for
  its dialect instead, and a missing entry stops the push even with
  `--skip-source-check`. That flag skips the source check and its location
  rule. `kcmd profiles` does not run the source check.
  *(live — needs the reads listed under [Permissions](#permissions))*
* **Every entity's source table is reachable.** For a **BigQuery-targeting**
  model, each `source` is probed with a dry-run query, so BigQuery resolves it
  exactly as the deploy will — a BigQuery table or a BigLake table (e.g. an
  Iceberg table in a federated REST catalog). A table that does not exist or that
  you cannot access fails the push, naming the table and the entity. Push probes
  the tables of the deployments it would deploy, each in the location of the
  graph's dataset when push can read it. A table in another location fails the
  push, and the error names the table's location when BigQuery reports it. A
  **Spanner-targeting** model's sources live in Spanner (a different system) and
  are **not** probed here. The `source` construct and the resource names it takes
  are defined in [model spec §7.1](model_spec.md#71-table-sources).
  *(live — needs BigQuery access)*
* **Every `sql` executor statement is accepted by the store it will run
  against.** Each statement is sent to the bound store with the request that
  means *plan it, do not run it* — `dryRun` on BigQuery, `queryMode: PLAN` in an
  uncommitted read-write transaction on Spanner — so the store parses, resolves
  and type-checks it without writing anything. That catches a table or a column
  the database does not have (answered with the store's own *Did you mean
  `account_id`?*), a placeholder or a function from the wrong dialect, and a
  parameter whose declared type does not match the column it is compared with:
  the parameter types the action declares are sent with the statement, unbound,
  which is what turns them into a claim the store checks. The database a
  statement is planned against is the one the profile deploys the graph to, so
  which store answers is the profile's choice, not the statement's. Failing to
  reach the store at all fails the push rather than skipping the check — a push
  that could not verify its statements must not proceed as though it had.
  *(live — needs query access to the bound store)*

The live table check runs whenever the BigQuery leg runs (some selected
deployment targets BigQuery Graph), because the same tables back both a
BigQuery graph and its Knowledge Catalog entries. The DML pre-flight rides the
same two legs: it runs before the BigQuery deploy and before the Spanner deploy,
and both run under `--validate-only`, so a statement fails while nothing has
been published. Two kinds of model run neither leg and are therefore checked
statically and no further: a catalog-only model (or `--no-deployment`), which
deploys no target at all, and an **AlloyDB**-targeting one — AlloyDB is a valid
deployment target and a valid store for an action to write to, but push has no
client for it, so its statements are never sent anywhere. Neither case is
reported as verified.

## Permissions

`push` needs access to whichever destinations you deploy to.

**BigQuery** — for a BigQuery-targeting model (the BigQuery leg runs whenever
such a model is present), and for the validation pre-flight:

* `bigquery.jobs.create` in the deployment-target project — to run the deploy's
  `CREATE OR REPLACE PROPERTY GRAPH` and both pre-flight dry runs
* read access on each entity's source table, so the dry-run can resolve it
* read access on each table an action's `sql` executor names, for the same
  reason — a dry run of a DML statement resolves the table it writes to, though
  it writes nothing
* `bigquery.datasets.get` on the target dataset (region detection; optional —
  push degrades gracefully without it)
* `bigquery.tables.create` and `bigquery.tables.update` on the target dataset —
  only when a metric falls back to a view (proposed metric graphs; see
  [Metric graphs for `GRAPH_EXPAND`](#metric-graphs-for-graph_expand-proposed)),
  to run its `CREATE OR REPLACE VIEW`

**Spanner** — for a Spanner-targeting model (the Spanner leg runs whenever such a
model is present), on the database the target names:

* `spanner.databases.updateDdl` — to apply the `CREATE OR REPLACE PROPERTY GRAPH`
  through `updateDatabaseDdl`
* `spanner.databaseOperations.get` — to poll the long-running operation to
  completion
* `spanner.sessions.create` and `spanner.sessions.delete`,
  `spanner.databases.select`, and
  `spanner.databases.beginOrRollbackReadWriteTransaction` — the DML pre-flight
  plans each statement on a session, and a `PLAN` of a DML statement has to open
  the read-write transaction it would write in even though it never commits one.
  All four come with `roles/spanner.databaseUser`.
* `spanner.instances.get` on the instance, to read the instance's edition
  before any write. `spanner.databases.get` lets push check that the database
  exists. Both come with `roles/spanner.databaseUser` granted on the instance
  or its project.

**Spanner sources** — for a model whose `source` values name Spanner tables,
whether or not it deploys to Spanner:

* `spanner.databases.get` on each database those tables are in, to read the
  database's SQL dialect. `kcmd profiles` needs it too, and `kcmd import` uses
  it when it can.

**Source check** — for every push, on the tables the sources name. Push makes
none of these reads with `--skip-source-check`:

* `bigquery.tables.get` on each BigQuery table, to read the table's location
* `biglake.catalogs.get` on the catalog of each BigLake table, to read its
  replica regions, whether push reads it through the Iceberg REST catalog API
  or, for a Hive catalog, the Hive API
* `spanner.instances.get` on the instance of each Spanner table, to read the
  instance's config. `spanner.instanceConfigs.get` on the project only saves
  lookups. With it, push reads the region of a multi-region or custom config's
  default leader and looks the entry up there. Without it, push looks the
  entry up in each region the instance has replicas in.
* read access to each table's Knowledge Catalog entry. Dataplex checks the
  caller's permission on the table in its own system, such as
  `bigquery.tables.get` for a BigQuery table.

**Knowledge Catalog / Dataplex** — for the Knowledge Catalog push (every push
publishes to Knowledge Catalog):

Writing an entry with aspects needs permission on **both** the entry operation
and each aspect type attached, so a push needs, on the destination entry group:

* `dataplex.entries.create`, `dataplex.entries.update`, `dataplex.entries.delete`,
  `dataplex.entries.list` and `dataplex.entries.get` — push upserts the model /
  entity / metric entries, deletes orphaned ones, and reads the model entry again
  before it labels the push finished
* `dataplex.entryLinks.create`, `dataplex.entryLinks.get`,
  `dataplex.entryLinks.update`, `dataplex.entryLinks.delete` and
  `dataplex.entries.link` — push creates and reads the `semantic-link` and
  `reference` links, updates the `semantic-link` ones, and deletes the ones
  the model no longer has
* `dataplex.entryGroups.useSchemaAspect` — every entity carries the built-in
  `schema` aspect (the fields it declares)
* `dataplex.entryGroups.useReferenceEntryLink` — when the model has
  relationships or an entity extends another
* `dataplex.entryGroups.useOverviewAspect` — when an element carries
  `ai_context.examples` or has an overview sidecar
* `dataplex.entryGroups.useGuidelinesAspect` — when an element carries
  `ai_context.instructions` or custom `ai_context` members
* `dataplex.entryGroups.useSemanticTypes` — every built-in `semantic-*`
  aspect, entry and entry link type
* `dataplex.entryGroups.useSQLExpressionsAspect` — when a field or metric has
  an expression
* `dataplex.aspectTypes.use` on the `semantic-action` aspect type, when the
  model declares actions, and on `semantic-constraint` when it declares
  constraints — those types are custom rather than built-in, so they are
  authorized on the type resource instead of through an entry-group
  use-permission

> The `schema`, `overview` and `guidelines` use-permissions are on Dataplex's
> [permissions page](https://cloud.google.com/dataplex/docs/iam-permissions).
> The `reference`, `sql-expressions` and semantic-type permissions are not
> listed there yet, so confirm them against your project's IAM once granted.

`kcmd init --semantic-model` creates what a later push only references, so it
needs more than push does, in the destination project:

* `dataplex.entryGroups.create` — the destination entry group
* `dataplex.aspectTypes.create` / `dataplex.aspectTypes.update` and
  `dataplex.entryTypes.create` — the custom `semantic-action` and
  `semantic-constraint` pairs. Init patches an aspect
  type that is already there, so a project set up by an older `kcmd` picks up
  template additions; an entry type that is already there is left alone.

The entry group is required. A push to an entry group that does not exist
stops before writing anything and asks you to run `kcmd init --semantic-model`.
When the scope in catalog.yaml names the wrong location or group, correct the
scope instead. When the entry group or a type already exists, init goes on even
if you may not create or update it, and reports a refusal to update a type as a
warning, so a teammate without these permissions can still run init in a
project someone else set up. Actions and constraints are optional
constructs, so init reports a refusal to create their types as a warning and
carries on; every model that declares neither still pushes and pulls. Any other
failure to create a type stops init, rather than leaving a later push to hit an
opaque parsing error.

`kcmd pull` needs read access to the same entry group instead — to list its
entries and fetch each `semantic-*` entry with its aspects.
