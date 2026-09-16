# Generated writes: an `intent` executor

Status: proposal. Nothing here is implemented.

An action's read-side counterpart already generates SQL from words. A judge
holding `--judge-reads-store` is handed the physical schema the profile binds
and writes its own `SELECT` against it; `runtime/judge_store.ts` composes the
schema, fences the statement and caps what comes back. The write side has no
equivalent. An action either carries its DML verbatim in a `sql` executor, or
it names a foreign system in an `mcp` / `rest` / `grpc` executor and
`runAction` refuses to run it unless the caller hands in a TypeScript
`handler` that produces statements itself.

That handler is the hard-coded part. An action that sends mail today is a
function somebody wrote, compiled into the agent, invisible to the catalog and
unreachable by any rule the model states. There is no reason the write cannot
be generated from the action's own words at call time, the way the read is —
provided what comes back is admitted by a gate, rather than trusted because a
model produced it.


## What the construct is

One new executor kind, `intent`, whose body is the request in words and whose
`produces` names which of the existing kinds the generation fills in.

```yaml
actions:
  - name: IssueCredit
    parameters:
      - {name: order, type: Order}
      - {name: amount, type: Decimal}
      - {name: memo, type: String}
    affects:
      - {concept: Credit, operation: create}
      - {concept: Order, operation: modify, fields: [adjusted_total]}
    guards: [credit_within_order_total, memo_names_a_failure]
    executor:
      intent:
        request: >
          Record a credit against the order for the amount, with the memo as
          its reason, and reduce the order's adjusted total by the same amount.
        produces: sql
```

The generator's job is to fill in the part the produced kind leaves blank, and
nothing else:

| `produces` | generated | declared, never generated |
| --- | --- | --- |
| `sql` | the `statements` list | the tables, via `affects` and the profile |
| `rest` | the request body | `endpoint`, `method` |
| `mcp` | the tool arguments | `server`, `tool` |

That split is the whole safety argument. A generated payload against a
declared destination has a blast radius: whatever that endpoint, that tool or
those tables can do. A generated destination has none, and nothing downstream
can recover one, so the destination stays in the model where a reviewer reads
it.


## The seam

Mirror `Judge`. `runtime/judge.ts` is an interface and nothing else — the
library names what a judge is asked and what it must answer, and
`gcp/gemini.ts` implements it, so no model client reaches the library's
dependency list. A planner is the same shape.

```ts
// runtime/planner.ts
export interface PlanRequest {
  action: string;
  actionDescription?: string;
  request: string;                  // the intent, verbatim
  arguments: Record<string, unknown>;
  parameters: ActionParameter[];    // the only names a statement may bind
  refs: Record<string, EntityRef>;  // object references, already resolved
  schema: string;                   // physical tables and columns
  dialect: 'GoogleSQL'|'PostgreSQL';
  writable: WritableConcept[];      // from `affects`, in physical terms
  rejected?: string;                // why the previous attempt was refused
}

export interface Planner {
  readonly name: string;
  plan(request: PlanRequest): Promise<SqlPlan|PayloadPlan>;
}
```

`schema` is `judge_store.ts`'s `schemaText` — the same composition, restricted
to the concepts `affects` names. `dialect` is `dialectFor(runtime.store)`.
`rejected` is what makes one retry worth having: the admission gate below
produces a sentence, and a generator that reads it fixes a missing `@memo`
without spending the caller's turn.

`RunActionOptions` gains `planner?: Planner`. Omitting it does not mean "run
the intent ungenerated" — an action with an `intent` executor and no planner is
refused by `whyRefusedWithoutRunning`, exactly as an action guarded by a
judgment and given no judge is refused today. Same function, same reason, so
`agent_tools.ts` withholds the tool rather than advertising one that fails
every call.


## The admission gate

This is where the proposal lives or dies. `ir.ts` states the case for the `sql`
executor as two properties: the blast radius is checkable, and a guard is a
real gate. Both come from the statement being in the model, reviewed, before
anyone calls it. A generated statement has neither by construction, so the
checks move from publish time to call time — and they must be the *same*
checks, not a second weaker set.

`runtime/admit.ts`, run on every generated statement before a session opens:

1. **Shape.** Hoist `sqlExecutorErrors` out of `validate.ts` into a shared
   module and call it here. One DML verb per statement, no `;`, every `@name`
   declared as a parameter. Publish time and call time then share one
   implementation rather than drifting.

2. **No literal in a value position.** Stricter than the publish-time rule, and
   the load-bearing addition. A hand-written `SET balance = 500` was reviewed;
   a generated one means the caller's `amount` stopped being what reaches the
   store, and every guard that read the arguments judged a write that did not
   run. So every value comes from a bound parameter, and a statement carrying a
   literal other than `NULL` is rejected with that sentence.

3. **Table allow-list.** Every table the statement writes must be the bound
   table of a concept `affects` names, and the verb must match that entry's
   `operation`. An `intent` executor with no `affects` is refused at load time:
   there is nothing to bound the generation with.

4. **Every declared parameter is used.** An action declares `memo` and the
   generated DML never binds it — the write silently dropped an input the
   caller supplied and the model promised to record.

Checks 2 and 3 want a parse, not a regex, and there is already one. `mdcode`
bundles the `@polyglot-sql/sdk` Rust/WASM engine for `transpile.ts`, and it
parses DML today:

```
parse('UPDATE t SET a = 1 WHERE b = 2')
  -> {"update":{"table":{"name":{"name":"t",...}},
      "set":[[{"name":"a"},{"literal":{"literal_type":"number","value":"1"}}]],
      "where_clause":{...}}}
```

The target table is a field, and a literal is tagged as one — checks 2 and 3
read the AST rather than scanning text. Two notes from probing it. The dialect
is a positional string, `parse(sql, 'postgresql')`, not an options object; the
object form fails with a WASM memory error. And there is no Spanner dialect in
the list, so GoogleSQL DML parses as `bigquery`, which needs checking against
the DML forms Spanner accepts that BigQuery does not.

Reuse the same gate for `produces: rest` and `produces: mcp` by declaring a
JSON Schema for the payload on the intent, and validating what comes back
against it. A generated email body is otherwise unbounded text.


## Where the guards move

Two things change, and the first is the one that makes this defensible.

**A judge must see the statement.** `askJudges` builds a `JudgeRequest` from
the arguments alone, which is right while the arguments determine the write.
Once they do not, judging the arguments judges the wrong thing. Add
`statements?: string[]` to `JudgeRequest`, populated only when generated, and
say in `judge.ts` that a judge shown one is being asked about the write rather
than about the request.

**The ordering has to change.** Generation needs `refs`, and `refs` are
resolved inside the transaction today; guards settle before it opens, on
purpose, because holding write locks across a model call costs more than it
buys. With a planner, three passes need to happen before the write:

```
resolve refs (read-only)  ->  plan  ->  admit  ->  judge  ->  open txn  ->  run
```

The resolution SELECT moves outside the transaction. That admits a race the
runtime already accepts — `judge_store.ts` says a judge's read is true when it
is read and not guaranteed still true at commit — and it is a better trade
than holding locks across two Gemini calls. What it costs: a key that vanished
between resolution and the write makes the DML affect zero rows. So report
rows-affected per statement in the outcome, and treat zero on an `UPDATE` or
`DELETE` as a warning rather than a silent success.


## The dependency: `fork/constraint-eval`

A pre-write guard reads the call. Once the call no longer determines the write,
a pre-write guard is not sufficient on its own — the admission gate bounds
*which tables* and *which values*, and nothing bounds which rows.

`fork/constraint-eval` (79709b0) is what closes that. It splits a constraint
into two timings: a `before` guard against the pre-state and the arguments, and
an `after` invariant that runs inside the transaction against the post-state
and rolls the write back if the rule does not hold. An `after` invariant is the
right enforcement point for a write nobody wrote — `Order.total >= 0` holds or
the transaction is gone, whatever statement produced the state.

Land that branch first. Generated DML without post-state invariants is a write
gated only by checks on its text.


## What is refused

- Generating the destination — an endpoint, a tool, a table set not in
  `affects`.
- DDL, and any relaxation of `SQL_EXECUTOR_VERBS`.
- Running an `intent` executor without a planner, without `affects`, or with a
  statement the gate rejected. No fallback to a literal executor and no partial
  application: the run ends with the reason.
- Publishing an intent to Knowledge Catalog as though it were an executable
  write. `kc_actions.ts` flattens it with `executorKind: 'intent'` plus the
  request text and the produced kind, so a catalog reader sees that this
  action's write is generated.

One more worth stating: the caller writes the memo, and the memo goes into the
planner's prompt. `gemini.ts` already fences caller-written text as data on the
judge path and the planner reuses it — but the fence is not the defence. The
admission gate is, because it reads the output and does not care what the
prompt said.


## Graduating an intent

`kcmd action compile <name>` runs the planner once, admits the result, and
writes it into the binding profile as an ordinary `sql` executor.

That makes the intent an authoring affordance rather than a runtime dependency:
words while the action is being worked out, a reviewed literal statement once
it is settled, and the same gate over both. It also fits where executors
already live — the intent is on the action, the compiled statement is in the
profile, which is where a profile supplying an executor puts one today.

An action can stay on its intent in production. That is a choice about whether
the write is the same every call, and the compile path is what makes it a
choice rather than the only mode.


## Stack

1. `intent` in the IR, loader, `validate.ts` and the Knowledge Catalog
   round-trip. Construct only, no runtime.
2. `runtime/admit.ts`, with `sqlExecutorErrors` hoisted out of `validate.ts`.
   Tested against every existing hand-written fixture first — the gate has to
   pass what is already shipped before it judges anything generated.
3. The `Planner` seam, `produces: sql` in `run_action.ts`, the reordered
   passes, `--dry-run`, and the generated statements in `ActionOutcome`.
4. A Gemini planner in `gcp/gemini.ts`, reusing the fence and `schemaText`.
5. `kcmd action compile`.
6. `produces: rest`: payload schema, payload judged, and the call made after
   the commit. It cannot be rolled back — `run_action.ts` refuses `rest` today
   for exactly that reason, and generating the body does not change it — so the
   outcome reports "the write landed and the notification did not" rather than
   claiming a rollback.
