# Freeform actions

Status: proposal. Nothing here is implemented.

A user in conversation asks for something that writes, and no action covers it.
"Refund Morgan forty dollars for the late delivery" is an ordinary request, and
a model that declares `IssueCredit` answers it while a model that does not
cannot — not because the write is illegal, but because nobody anticipated that
sentence.

Declaring more actions does not close that. Whatever is enumerated, the next
request is outside it. What closes it is enumerating the **bounds** instead of
the writes, and generating the write inside them at call time.

The ontology is already most of a write grammar. It says a Credit has an amount
and an order, that the amount is a Decimal, that a credit cannot exceed the
order it credits. That is enough to decide whether a proposed change is a legal
act, without anyone having written down that this particular act exists. What it
does not yet say is which concepts may be written at all, and that is the one
thing an author has to add.


## What gets declared

A `writable` surface, on the binding profile. Writability is a physical facet —
the same ontology is writable against the operational store and read-only
against the warehouse — so it belongs where `executor` and `source` already
live, and it inherits and withdraws the same way.

```yaml
# commerce.profiles/spanner.yaml
writable:
  - {concept: Credit,   operations: [create]}
  - {concept: Order,    operations: [modify], fields: [adjusted_total, status]}
  - {concept: Customer, operations: [modify], fields: [email]}
```

Default closed. A profile with no `writable` block admits no freeform write, and
that is the state every model is in until somebody decides otherwise.

The shape is `AffectedConcept` — `concept`, `operation`, `fields`, over the same
`CONCEPT_OPERATIONS` vocabulary of `create` / `modify` / `delete`. That is the
structural move the rest of this depends on: what a profile permits and what a
generated statement turns out to do are written in one language, so admission is
a subset test between two values of the same type, rather than a comparison
between a declaration and some SQL.


## What the agent gets

One tool pair, alongside the per-entity lookups `agent_tools.ts` already
derives.

```
propose_change(request, refs)  ->  a proposal; nothing is written
apply_change(proposal_id)      ->  the write
```

`propose_change` does not write. It returns what it would do, and a person says
yes. That is not a courtesy — it is the review step. A declared action's DML was
read by somebody before it shipped; a freeform statement has no such moment, so
the moment has to be the call, and the reviewer has to be the one asking.

`refs` are keys the agent already resolved through the `find_*` lookups. It does
not pass a name and let the runtime guess: it looks the customer up, shows the
row, and passes the key. This costs a turn and buys the central safety property
below, and it keeps what the agent resolved visible to the user rather than
hidden inside a write.

`apply_change` runs **the statements the proposal holds**, not a regeneration
from the same words. A second generation can differ from the first, and then the
user confirmed one change and another ran. The proposal is held by the runtime
with its exact statements and bound values, is single-use, and expires — it
carries pre-resolved keys, and a key means something different an hour later.


## The pipeline

```
request (words) + refs (keys the agent looked up)
  |
  plan      generate DML                     Planner seam -> Gemini
  parse     AST                              @polyglot-sql/sdk, already bundled
  derive    affects, read off the AST
  admit     affects subset-of writable, and the five checks below
  attach    every constraint reading a touched concept
  check     `before` rules: expression -> store, judgment -> judge
  |
  PROPOSE ------------------ stop. a person reads it. ------------------
  |
  open txn -> run -> `after` invariants -> commit, or roll back
```

Nothing before `PROPOSE` opens a transaction. Everything after it is the path
`run_action.ts` already walks.


## Admission

With a declared action, the statement was reviewed and `validate.ts` pinned its
shape at publish time. Here there is no publish time, so this gate is the whole
of it. All six checks read the AST.

1. **Shape.** One DML verb per statement, no `;`, the verb one of
   `SQL_EXECUTOR_VERBS`. No DDL, no DCL, no query.

2. **Every value is a bound parameter.** No literal in a value position except
   `NULL`. A generated `SET adjusted_total = 107.85` would mean the number the
   user confirmed is not the number that runs, and it would leave every
   constraint that reads a parameter reading nothing. The AST tags literals, so
   this is a walk rather than a guess.

3. **`affects` is a subset of `writable`.** The target table maps back to a
   declared concept, the verb to a permitted operation, and the assigned or
   inserted columns to permitted fields.

4. **Every `UPDATE` and `DELETE` is keyed to a resolved row.** Not "has a
   `WHERE`" — has an equality predicate on the entity's key column, bound to a
   value that appears in `refs`.

5. **Row cap.** The number of resolved keys bounds how many rows a statement may
   touch, and the proposal states the number.

6. **No widening.** No CTE that writes, no subquery whose `FROM` names a table
   outside the readable surface, no join that could move the target off the
   keyed row.

Check 4 is the one carrying the weight. The others bound what *kind* of write
this is; 4 bounds *how much*. "Delete all orders" is well-formed DML inside any
reasonable `writable` surface, and what stops it is that no lookup resolved
those rows, so there are no keys to bind and the statement cannot be written.
The rule that the agent must look something up before it can write to it is the
difference between a bounded surface and a database connection.

The parser is already in the tree: `transpile.ts` loads the `@polyglot-sql/sdk`
Rust/WASM engine, and it parses DML today, naming the target table and tagging
each literal.

```
parse('UPDATE t SET a = 1 WHERE b = 2')
  -> {"update":{"table":{"name":{"name":"t",...}},
      "set":[[{"name":"a"},{"literal":{"literal_type":"number","value":"1"}}]],
      "where_clause":{...}}}
```

Two notes from probing it. The dialect is a positional string —
`parse(sql, 'postgresql')` — and the options-object form fails with a WASM
memory error. And there is no Spanner dialect, so GoogleSQL parses as
`bigquery`, which needs checking against the DML forms Spanner accepts and
BigQuery does not.


## Which rules apply

A declared action names its rules in `guards`, and `run_action.ts` defends that
at length: a constraint no action names gates nothing, so publishing a rule
cannot silently start refusing calls that succeeded the day before.

A freeform write has no `guards` list to write and no history of prior calls, so
it needs another answer and can afford one. The rules that apply are the ones
that **read a concept the statement touches**. `analyze` on
`fork/constraint-eval` already reports exactly that — `AnalyzedRule` carries the
`entities` and `fields` a rule reads — so attachment is an intersection between
that and the affects derived in the step above.

This is still an explicit reference. The statement is the reference; it is
computed rather than listed, and it can be computed only because the statement
is generated and therefore in hand before it runs. It is also stricter than a
list, because an author cannot forget an entry.

It does reopen a settled decision. The rule that a constraint is inert until
referenced was settled against automatic application, and this is automatic
application in one bounded place. The argument for the carve-out is that the
decision protects *declared* calls from a rule published later, and a freeform
write is neither declared nor previously working, so nothing can regress. That
argument covers the freeform path and nothing else — a declared action's guards
stay exactly as they are. Whether the carve-out is acceptable is a call to make
before any of this is built, because if it is not, freeform writes can only run
against models whose every relevant rule is already named somewhere, which is
not a useful restriction.

Two consequences worth stating:

- A constraint whose expression falls outside the grammar, and which reads a
  touched concept, **refuses the proposal**. It is not skipped. This will refuse
  a lot at first, which is the correct direction to fail in.
- `analyze(action, constraint)` resolves parameter references against an
  action's declared parameters, and a freeform write has none. It needs a
  synthetic action built from the derived bindings — small, but it is a change
  to a module still in flight.


## What the person sees

The proposal is read in ontology terms, because that is what the user asked in.
The SQL is there for whoever wants it, below.

```
Proposed change  —  "refund Morgan $40 for the late delivery"

  create  Credit                      1 row
            order    #12345  (Morgan Ellis)
            amount   40.00
            reason   "late delivery"
  modify  Order.adjusted_total        1 row
            #12345   147.85 -> 107.85

  Checked   credit_within_order_total   holds  (40.00 <= 147.85)
            memo_names_a_failure        holds  (gemini-2.5-flash: names a
                                                delivery failure)
  On commit order_total_non_negative    checked inside the transaction

  SQL       INSERT INTO credit (credit_id, order_id, amount, reason)
                 VALUES (@credit_id, @order, @amount, @reason)
            UPDATE orders SET adjusted_total = adjusted_total - @amount
                 WHERE order_id = @order

Apply?  kcmd change apply 01JQ8F
```

What a rule reported is part of the proposal, not a footnote. A user approving a
change approves what was checked along with it, and a rule that went unchecked
has to be visible at the moment of approval rather than in a log afterwards.


## The dependency

`fork/constraint-eval` (79709b0) is a prerequisite, not a neighbour.

Admission bounds which tables, which columns, which values and which rows. None
of that says the resulting state is sound. For a declared action that gap is
covered by a human having read the DML; here nothing covers it except a check on
the post-state. The branch's `after`-timing invariants run inside the
transaction and roll the write back, which is the only mechanism that bounds a
statement nobody wrote.

Build the gate first, but do not run a freeform write against a live store until
that branch has landed.


## The flywheel

A freeform write that succeeded is a candidate action. It has statements that
passed the gate, a parameter list read off its bound values, and a derived
`affects`.

```
kcmd change apply 01JQ8F --save-as IssueCredit
```

writes it into the profile as an ordinary `sql` executor action, for a human to
review and merge. From then on it is the fully governed path that exists today:
named, published to Knowledge Catalog, offered to agents as its own tool, and
run without a model in the loop.

So freeform is the long tail and the intake, not a replacement. The action
catalog grows from what people asked for rather than from what someone
anticipated, and anything that recurs stops being generated.


## Refused

- Any write against a profile with no `writable` surface.
- Anything that is not `INSERT`, `UPDATE` or `DELETE`.
- An `UPDATE` or `DELETE` not keyed to a row a lookup resolved.
- Applying without a confirmation, or with one that was used or has expired.
- A touched concept carrying a rule that cannot be checked.
- A table the model does not declare. The honest answer is that the model does
  not describe it, which is the same answer the read side gives.

And one thing deliberately not built: a tool that takes SQL from the agent. The
agent supplies words and resolved keys; the runtime supplies the statement. The
user's own text reaches the planner's prompt, and `gemini.ts` already fences
caller-written text as data on the judge path — but the fence is not the
defence. The gate is, because it reads the output and does not care what the
prompt said, and the keyed-row rule is, because it bounds the blast radius of a
prompt that worked.


## Stack

1. `writable` in the profile: IR, loader, `validate.ts`, Knowledge Catalog
   round-trip. Construct only, no runtime.
2. `runtime/admit.ts`: the AST gate, and affects derived from a statement. Run
   it over every existing hand-written action fixture first — it has to pass
   what already ships before it judges anything generated.
3. The `Planner` seam, the proposal store, `kcmd change propose` / `apply`.
   Shaped like `Judge`: an interface in the library, no model client on its
   dependency list.
4. A Gemini planner in `gcp/gemini.ts`, reusing the fence and the schema text
   `judge_store.ts` composes.
5. Attachment and checking, on top of `fork/constraint-eval`.
6. `propose_change` / `apply_change` in `agent_tools.ts`, and the ADK demo.
7. `--save-as`.
