// The semantic runtime: executing a model's action against a live store.
//
// A semantic model has always described what things MEAN. Actions describe what
// can be DONE. This module is where the two meet an actual database:
//
//   1. BIND. Every parameter is a scalar, and every argument becomes a query
//      parameter of the store type its resolved ontology type implies. Nothing
//      is interpolated into SQL.
//   2. APPLY. A read-write transaction is opened, the action's writes are run
//      inside it, and it is committed. Any failure before the commit rolls
//      back, so no partial write survives. A failure OF the commit is the one
//      case nothing here can resolve -- the store may have applied it and lost
//      the response -- and it is reported as the unknown it is rather than as
//      a rollback.
//
// A statement that wrote NO ROW is a failure, not a quiet success. An UPDATE or
// a DELETE whose predicate found nothing did not do what the action says it
// does, and reporting "committed" for it would tell a caller a row was changed
// that was never there. Only an INSERT may write nothing, so a statement whose
// verb this runtime cannot read is refused rather than assumed harmless. See
// the row-count check in `runAction`.
//
// Where the write comes from. An action with a `sql` executor carries its own
// DML, and the runtime runs those statements itself. An action with an `mcp`,
// `rest` or `grpc` executor names an operation that lives in another system,
// which this module cannot call and could not roll back if it did; for those
// the caller supplies a handler that produces the statements.
//
// Constraints, and how this settles them. A constraint states its rule as a
// `judgment`, and every one of them is settled the same way: by asking a judge,
// before the transaction opens -- see `askJudges`. A judgment is the one body a
// constraint has, so there is no case here where the runtime has to decide
// which checker a guard belongs to.
//
// An action guarded on a run that was given no judge to ask is REFUSED rather
// than run unchecked. See `unsafeToRunUnchecked`. Refusing is the point. A
// model that declares a rule and a runtime that quietly ignores it is worse
// than no runtime at all, because the model states the call is checked and
// nothing says otherwise.
//
// A constraint no action names gates nothing here, because it gates nothing
// anywhere: a rule takes effect where something references it, and `guards` is
// that reference for an action (see Action.guards in ir.ts). Refusing on a
// constraint that merely reads data the action writes would mean publishing a
// rule silently stopped calls that succeeded the day before, which is the
// property that reference rule exists to guarantee.

import * as spanner from '../../gcp/spanner';
import {Action, Constraint, SemanticModel,} from '../ir';
import {bindScalar, isParameterRequired, sentence, storeCodeFor,} from '../parameters';
import {leadingDmlVerb, referencedParameters} from '../sql_identifiers';

import {Judge, JudgeVerdict} from './judge';
import {runtimeClient, SemanticRuntime} from './runtime';

export {bindScalar, isParameterRequired, sentence, storeCodeFor} from '../parameters';


// The writes an action performs: either built from its `sql` executor or
// produced by the caller's handler.
export interface ActionPlan {
  // DML to run inside the transaction, in order.
  statements: spanner.Statement[];
}


// Reads rows inside the open transaction. Every scalar arrives as text --
// both operational backends hand their values over that way, and the runtime
// keeps them so, so a caller need not know the physical types -- and a SQL
// NULL arrives as `null`, which is the one value no text can stand in for.
export type QueryFn = (stmt: spanner.Statement) =>
    Promise<Array<Array<string|null>>>;


// What the handler is given: the action, its arguments, and a reader scoped to
// the open transaction (so a handler can look at the pre-state before deciding
// what to write).
export interface ActionContext {
  model: SemanticModel;
  action: Action;
  args: Record<string, unknown>;
  query: QueryFn;
}


export type ActionHandler = (ctx: ActionContext) => Promise<ActionPlan>;


export type ActionOutcome = {
  status: 'committed';
  commitTimestamp?: string;
  // What a rule reported without stopping the write. A guard whose
  // `onViolation` is `warn` puts its verdict here, and so does one whose judge
  // could not be reached: the call committed, and the caller is told what went
  // unmet or unchecked rather than left to read silence as "every rule
  // passed".
  warnings?: string[];
}|{
  status: 'error';
  // A failure that stopped the write: an argument of the wrong type or none at
  // all, a write that matched no row, an action this runtime will not run
  // unchecked, a store-level error. The
  // transaction is rolled back, so no partial write survives -- except in the
  // one case `indeterminate` marks.
  message: string;
  // Set when the write may in fact have landed: the statements ran and the
  // COMMIT itself failed. Spanner reports a deadline or a 5xx on commit for a
  // commit that succeeded as well as for one that did not, and nothing can
  // undo it from here. A caller must not read this as "nothing happened" and
  // retry.
  indeterminate?: boolean;
};


export interface RunActionOptions {
  runtime: SemanticRuntime;
  actionName: string;
  args: Record<string, unknown>;
  // Supplies the writes for an action whose executor lives in another system.
  // Omit it for a `sql` executor, whose writes are in the model.
  handler?: ActionHandler;
  // Settles the guards this model states in words. Omitting it does not mean
  // "run those unjudged": an action with a guard to settle is refused, because
  // a judgment is the only body a constraint has and only a judge settles one.
  judge?: Judge;
  // Runs the action without checking its guards at all. Not a weaker check --
  // no check: every refusal a guard would have produced is skipped and the
  // write happens. It exists because the refusals above are total. An author
  // trying a model out locally, against their own database, has no judge to
  // supply and would find every guarded action unrunnable; the alternative is
  // deleting the guards to test the write, which is worse. The outcome names
  // every guard the run passed over, in `warnings`, so nothing that reads the
  // outcome -- a command line, or an agent handed the result of a tool call --
  // is ever told the write passed rules nothing consulted.
  skipGuards?: boolean;
}


// Runs one action end to end. Never throws for an expected failure -- an
// argument of the wrong type, a refused action, a rejected statement all come
// back as an outcome, because the caller is usually an agent that needs to read
// the reason and try again.
export async function runAction(opts: RunActionOptions):
    Promise<ActionOutcome> {
  const {model} = opts.runtime;
  const action = (model.actions ?? []).find(a => a.name === opts.actionName);
  if (!action) {
    return {
      status: 'error',
      message: `Model '${model.name}' declares no action '${opts.actionName}'.`,
    };
  }
  const args: Record<string, unknown> = {...opts.args};
  for (const param of action.parameters) {
    if (args[param.name] === undefined && param.default !== undefined) {
      args[param.name] = param.default;
    }
  }
  // Decided BEFORE touching the store, so an action this runtime will not run
  // fails without having opened a transaction at all.
  const refusal = whyRefusedWithoutRunning(
      model, action, opts.handler, opts.judge, opts.skipGuards);
  if (refusal) return {status: 'error', message: refusal};

  // Checked before the judge as well. A judge is asked whether a rule holds
  // for a call, so a call missing one of its arguments comes back as a rule the
  // caller broke rather than an argument the caller forgot -- and costs a model
  // call to say it. The words are the ones the later passes use, so this only
  // moves when they are said.
  const unusable = argumentsNotUsable(action, args, !opts.handler);
  if (unusable) return {status: 'error', message: unusable};

  // Resolved before the judge, not after. There may be no store to touch at
  // all, and a run that could never have written must not first spend seconds
  // and a model call finding that out.
  const client = runtimeClient(opts.runtime);
  if ('error' in client) return {status: 'error', message: client.error};

  // A judged guard settles HERE, before a transaction exists. A model call
  // takes seconds, and holding the store's write locks across one costs more
  // than it buys, so the order is: ask, refuse with nothing touched, then open
  // the transaction. The price is that a judge reads the attempted call and
  // never the state the write produced, which means a rule about the RESULT of
  // a write is out of reach here and belongs in the schema.
  const warnings: string[] = [];
  // `skipGuards` means nobody is asked -- the whole point of it -- so it
  // stands the asking down too, not just the refusal for want of a judge
  // and the unsettled-guard warnings. A caller that passed both used to
  // reach the judge with those warnings suppressed, so a guard whose
  // judgment states nothing, or one that threw while being asked, committed
  // with no line about it anywhere.
  if (opts.judge && !opts.skipGuards) {
    const judged = judgedGuards(model, action);
    if (judged.length) {
      // Returned rather than thrown. A throw from here reaches the catch at
      // the end, which has no transaction to report on and would announce this
      // as a failure to start on the database.
      const asked = await askJudges(action, args, judged, opts.judge);
      if ('error' in asked) return {status: 'error', message: asked.error};
      warnings.push(...asked.warnings);
    }
  }
  // An unsettled rule is a check the model asked for and did not get, and a
  // caller shown no line for it reads the write as having passed every rule the
  // model states. Every one reaching here is advisory, because anything
  // stricter was refused above.
  //
  // This travels with the outcome rather than being left to whoever called,
  // including under `skipGuards`. A caller that asked for the skip does know it
  // asked, but it is not the only one reading the result: `describeOutcome`
  // hands these warnings to an agent as the tool's own answer, and an agent
  // told only `applied: true` has been told the write met every rule the model
  // states, which is the one thing it did not.
  //
  // One line for the whole skip rather than one per rule. The rules were not
  // checked for one reason, and repeating it four times buries the outcome of
  // the write under a list that says the same thing each time.
  const skipped = skippedGuards(action, opts.skipGuards);
  if (skipped.length) {
    warnings.push(
        `guards were not checked: ${skipped.join(', ')} -- this run was ` +
        `told to skip them, and the write was made anyway`);
  } else {
    for (const {constraint, why} of unsettledGuards(
             model, action, opts.judge)) {
      warnings.push(`${citation(constraint)} was not checked: ${why}`);
    }
  }

  // Whether a transaction was ever opened. A session that could not be
  // created, or a `beginReadWrite` that threw, fails with nothing to roll
  // back -- and the outer catch must not claim it rolled one back.
  let opened = false;
  try {
    return await client.withSession(async sessionName => {
      const begun = await client.beginReadWrite(sessionName);
      const transactionId = begun.result?.id;
      if (!transactionId) {
        return {
          status: 'error',
          message: `Could not begin a transaction on ${client.database} (${
              begun.status}${begun.message ? `: ${begun.message}` : ''}).`,
        } as ActionOutcome;
      }
      opened = true;

      const run = async (stmt: spanner.Statement) => {
        // A refusal arrives as a non-2xx response; a dropped socket, a DNS
        // failure or a TLS error arrives as a thrown fetch error instead.
        // Both are the store not answering, and neither is this process being
        // wrong -- so both have to leave here as a StoreError. Without this
        // the thrown one reaches the outer catch as a plain Error and is
        // reported as a failure inside the runtime, which sends the reader to
        // look for a bug in the code instead of retrying a transient fault.
        let res;
        try {
          res = await client.executeSql(sessionName, transactionId, stmt);
        } catch (err) {
          throw new StoreError(`${
              err instanceof Error ?
                  err.message :
                  String(err)} (while running: ${stmt.sql})`);
        }
        if (res.status < 200 || res.status >= 300) {
          throw new StoreError(`${
              res.message ?? 'request failed'} (while running: ${stmt.sql})`);
        }
        return res.result ?? {};
      };
      const query = async (stmt: spanner.Statement) =>
          (await run(stmt)).rows ?? [];

      // Everything from here on is inside the transaction, so any failure must
      // roll back rather than leave it open.
      try {
        // A rollback that itself fails must not replace the reason the action
        // stopped -- that reason is what the caller acts on, and the server
        // aborts an abandoned transaction on its own.
        const rollback = async (outcome: ActionOutcome) => {
          try {
            await client.rollback(sessionName, transactionId);
          } catch {
          }
          return outcome;
        };

        // The bindings exist to fill the model's OWN statements, so they are
        // built only when the model is what supplies them. A handler writes its
        // own DML and is handed the arguments whole.
        let plan: ActionPlan|{error: string};
        if (opts.handler) {
          plan = await opts.handler({model, action, args, query});
        } else {
          const bound = bindArguments(action, args);
          if ('error' in bound) {
            return await rollback({status: 'error', message: bound.error});
          }
          plan = planFromExecutor(action, bound);
        }
        if ('error' in plan) {
          return await rollback({status: 'error', message: plan.error});
        }
        for (const stmt of plan.statements) {
          const result = await run(stmt);
          const missed = noRowMatched(stmt, result);
          if (missed) {
            return await rollback({
              status: 'error',
              message: `Action '${action.name}' was rolled back: ${missed}`,
            });
          }
        }

        // Deliberately NOT rolled back. Once commit has been called the
        // transaction's fate is the server's, and a deadline or a 5xx is
        // exactly the shape of failure Spanner returns for a commit that
        // landed and lost its response. Reporting "rolled back" here would be
        // a guess, and the caller acting on it would retry a write that
        // already happened.
        const indeterminate = (reason: string): ActionOutcome => ({
          status: 'error',
          indeterminate: true,
          message: `Action '${action.name}' ran, but committing it failed ` +
              `on ${client.database}: ${reason}. Whether the write landed is ` +
              `unknown -- the store may have applied it and lost the ` +
              `response -- so read the affected data before retrying.`,
        });

        // A commit fails in three shapes, and only two of them are unknowable.
        // It can REJECT outright -- the request throws on a socket hang-up, a
        // DNS failure or an abort -- which is precisely what a commit deadline
        // looks like from the client. It can RETURN a 5xx or a timeout, which
        // Spanner sends just as readily for a commit that landed and lost its
        // response as for one that did not. Both are indeterminate, and
        // letting either fall through to the catch below, which rolls back and
        // says so, would state the opposite of what is known.
        //
        // But a commit can also be REFUSED, definitively, and the commonest
        // refusal is routine: `409 ABORTED` is what Spanner returns under lock
        // contention, and it guarantees the transaction applied nothing. The
        // right response to it is to run the action again. Telling that caller
        // the write may have landed and the data must be read before retrying
        // would turn every lock conflict into an investigation.
        let committed;
        try {
          committed = await client.commit(sessionName, transactionId);
        } catch (err) {
          return indeterminate(err instanceof Error ? err.message : `${err}`);
        }
        if (committed.status < 200 || committed.status >= 300) {
          const reason = `${committed.message ?? committed.status}`;
          if (!DEFINITELY_NOT_COMMITTED.has(committed.status)) {
            return indeterminate(reason);
          }
          // Rolled back on the way out. An ABORTED transaction is already
          // gone, so this is a no-op for the commonest case, but a refusal on
          // other grounds can leave one open, and it costs a request either
          // way.
          return await rollback({
            status: 'error',
            message: `Action '${action.name}' was not committed on ${
                         client.database}: ${
                         reason}. The store refused the commit ` +
                `outright, so nothing was written and the action can be run ` +
                `again.`,
          });
        }
        return {
          status: 'committed',
          commitTimestamp: committed.result?.commitTimestamp,
          ...(warnings.length ? {warnings} : {}),
        } as ActionOutcome;
      } catch (err) {
        try {
          await client.rollback(sessionName, transactionId);
        } catch {
        }
        throw err;
      }
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (!opened) {
      return {
        status: 'error',
        message: `Action '${action.name}' could not start on ${
            client.database}: ${reason}`,
      };
    }
    // A statement the store rejected and a bug in a handler both arrive here,
    // and they are not the same news. The first is the action failing on its
    // own terms, and the message is about the write. The second is this
    // process being wrong, and reporting it as a rejected write sends the
    // reader to the data to look for a problem that is in the code.
    return {
      status: 'error',
      message: err instanceof StoreError ?
          `Action '${action.name}' failed and was rolled back: ${reason}` :
          `Action '${action.name}' failed and was rolled back, but not on ` +
              `the store's account: ${reason}. That is a failure inside the ` +
              `runtime or its caller rather than a rejected write.`,
    };
  }
}


// A store-level failure, distinguished from a programming error so the message
// surfaced to the caller stays about the store.
class StoreError extends Error {}


// Why a statement that ran without error still did nothing, or null when it
// did something.
//
// An UPDATE or a DELETE says which rows it acts on, and a predicate that
// matched none of them did not perform the action -- it performed nothing, and
// the store reports that as success. Nothing else in this module would notice:
// the commit lands, the caller is told the write happened, and the row it
// believes it changed is whatever it was before. The commonest cause is the
// commonest mistake, a key that names no row.
//
// An INSERT is exempt, and not as an oversight. It creates rows rather than
// finding them, so "no row matched" is not a thing it can report -- a zero
// count from one means the statement inserted nothing on purpose (an
// `INSERT ... SELECT` over an empty set, an `ON CONFLICT DO NOTHING`), which is
// the author's statement doing what the author wrote.
//
// THE EXEMPTION IS THE ONLY WAY PAST, which is the opposite of how this read
// until it was turned around. Checking for a verb that must be refused leaves
// every statement this runtime misreads passing silently, and passing silently
// is what a missed write looks like -- that is exactly how reading the verb out
// of the first six characters survived as long as it did. Checking instead for
// the one verb that may write nothing puts the burden the other way: a
// statement whose verb cannot be read is refused, loudly, and the author finds
// out on the first run rather than never.
//
// The store has already said this was DML by reporting an exact count at all,
// so the verb is not being consulted to decide whether the check applies. It is
// consulted for one thing: whether this is the INSERT that is allowed to write
// nothing. A MERGE is not, since a MERGE reporting zero neither matched a row
// nor inserted one.
//
// A store that reports no count at all is left alone rather than guessed
// about. Refusing a write because the row count was missing would fail actions
// that worked, over a fact nobody stated.
function noRowMatched(
    stmt: spanner.Statement,
    result: {stats?: {rowCountExact?: string}}): string|null {
  const verb = leadingDmlVerb(stmt.sql);
  if (verb === 'INSERT') return null;
  const exact = result.stats?.rowCountExact;
  if (exact === undefined || exact === null) return null;
  if (Number(exact) !== 0) return null;
  const quoted = `The statement was: ${stmt.sql.replace(/\s+/g, ' ').trim()}`;
  if (verb === 'UPDATE' || verb === 'DELETE') {
    return `${verb === 'UPDATE' ? 'an UPDATE' : 'a DELETE'} matched no rows, ` +
        `so the action did not do what it says it does. Nothing was ` +
        `written. ${quoted}`;
  }
  if (verb === 'MERGE') {
    return `a MERGE neither matched a row nor inserted one, so the action ` +
        `did not do what it says it does. Nothing was written. ${quoted}`;
  }
  return `this runtime could not read a DML verb from the statement, and it ` +
      `wrote no rows. Only an INSERT may write none, so a statement that ` +
      `cannot be shown to be one is refused rather than reported as ` +
      `applied. Nothing was written. ${quoted}`;
}


// Commit statuses that mean the transaction applied NOTHING, as against
// leaving its fate unknown. A Spanner `409 ABORTED` -- the routine outcome of
// lock contention -- guarantees it, and so do a rejected request, a denied
// permission, and a transaction the server no longer has. Everything else,
// every 5xx and every timeout included, is a commit that may have landed:
// unlisted is the safe default, because the cost of wrongly reporting "nothing
// was written" is a retry that writes twice.
const DEFINITELY_NOT_COMMITTED = new Set([400, 401, 403, 404, 409, 412]);


/**
 * The `kcmd action-run` line that would actually run this action here.
 *
 * Exported for the same reason `whyRefusedWithoutRunning` is: which arguments
 * a call requires is a rule the runtime already owns, and a second copy drifts
 * silently -- into a suggested command that is refused the moment it is run.
 *
 * A guard changes none of this. `kcmd action-run` settles none of them however
 * the action is written, so there is no flag about guards for the line to
 * carry and no reader who needs one to make the call work.
 */
export function runLine(a: Action): string {
  return [`kcmd action-run ${a.name}`, ...runFlags(a)].join(' ');
}

/**
 * The flags `runLine` would pass, one per element, without the command in
 * front of them.
 *
 * Separate from `runLine` because a caller that rebuilds the head -- to quote
 * an action name for a block meant to be copied and run, say -- would
 * otherwise have to take the rendered line apart to get at the flags, and the
 * only thing in it to split on is ' --', which an action name is free to
 * contain. Nothing constrains what is in a name.
 */
export function runFlags(a: Action): string[] {
  return a.parameters.filter(isParameterRequired)
      .map(p => `--arg ${p.name}=<${p.type ?? 'no type'}>`);
}

/**
 * Why this runtime would refuse `action` before opening a transaction, or null
 * if it would run it.
 *
 * Exported because deriving a tool for an agent needs the same answer BEFORE
 * the tool is offered: one that refuses every call spends the agent's turn and
 * teaches it nothing. A second copy of this rule elsewhere would drift, and
 * the drift is silent in both directions -- a tool advertised as runnable that
 * always refuses, or one withheld that would have worked.
 */
export function whyRefusedWithoutRunning(
    model: SemanticModel, action: Action, handler?: ActionHandler,
    judge?: Judge, skipGuards?: boolean): string|null {
  // No executor at all is a binding outcome, not a broken model: the executor
  // is a physical facet, so an action can be declared here and performable
  // only somewhere else. Say which it is, because the fix is in the profile
  // rather than in the action.
  const executor = action.executor;
  if (!executor) {
    return `Action '${action.name}' has no executor under this binding, so ` +
        `there is nothing to run. An executor is a physical binding: a ` +
        `profile supplies one, and a profile that writes 'executor: null' ` +
        `withdraws it. The action is still declared and still published; it ` +
        `is only not performable here, and is performed somewhere else.`;
  }
  if (!handler && executor.kind !== 'sql') {
    return `Action '${action.name}' is executed by ${
               executor.kind
                   .toUpperCase()}, which runs outside this transaction ` +
        `and could not be rolled back if the commit failed. Supply a handler ` +
        `that performs the write as DML, or declare the action with a 'sql' ` +
        `executor.`;
  }
  // Nothing about a parameter can refuse an action here any more. Every
  // parameter is a scalar and binds as one, so a key with three parts is three
  // ordinary parameters and there is no shape of key this runtime cannot pass
  // to a statement. What is left is the guards.
  return unsafeToRunUnchecked(model, action, judge, skipGuards);
}


// Why a rule the model states has to stop `action`, or null if none does.
//
// One question, and it is narrower than "could some rule bear on this write":
// does the action name a constraint that has to be checked before it runs,
// which nothing can check yet. `guards` is what gives a constraint effect over
// a call -- a rule no action names is a catalogued rule no call consults -- so
// the model's own answer to "what gates this" is the list, and reading further
// would be this module inventing an obligation the model does not state.
//
// An action naming no guard therefore runs. That is not this module judging the
// write safe; it is the model saying no rule gates the call. What the write
// does is the author's, which is what `affects` describes and what the
// evaluator will check against the statements once it exists.
function unsafeToRunUnchecked(
    model: SemanticModel, action: Action, judge?: Judge,
    skipGuards?: boolean): string|null {
  // A guard names a constraint the author says is checked before the call.
  // One whose `onViolation` is `warn` reports rather than refuses, so an
  // evaluator would let the write through, and refusing here would make a
  // model that states advisory rules permanently unrunnable. Only a name the
  // model declares AS advisory stands down -- a guard naming nothing this
  // model declares still refuses, because it is not something to guess about.
  const advisory = new Set((model.constraints ?? [])
                               .filter(c => c.onViolation === 'warn')
                               .map(c => c.name));
  const guards = (action.guards ?? []).filter(g => !advisory.has(g));
  // A judgment with no words in it -- or no judgment at all -- is nothing to
  // put to a judge. `kcmd` validates the model first, so this arrives only
  // through the library entry point, where asking anyway would refuse every
  // call and cite a rule it cannot quote.
  const blank =
      (model.constraints ?? [])
          .filter(c => guards.includes(c.name) && !(c.judgment ?? '').trim())
          .map(c => c.name);
  if (blank.length) {
    const says = blank.length === 1 ? 'states no rule to put to a judge' :
                                      'state no rule to put to a judge';
    return `Action '${action.name}' is guarded by ${quoteList(blank)}, ` +
        `which ${says}. There is nothing to put to a judge, so the action ` +
        `is refused rather than run unchecked.`;
  }
  // A guard naming a rule the model does not declare is nothing at all, and it
  // refuses whether or not a judge was handed in, so it is answered first: a
  // caller told to supply a judge, who supplied one and was refused again, has
  // been sent the wrong way.
  const declared = new Set((model.constraints ?? []).map(c => c.name));
  const undeclared = guards.filter(g => !declared.has(g));
  if (undeclared.length) {
    return `Action '${action.name}' is guarded by ${quoteList(undeclared)}, ` +
        `which ${undeclared.length === 1 ? 'is' : 'are'} not declared by ` +
        `model '${
               model.name}'. Running it would apply a write the model says ` +
        `must be checked first, so it is refused rather than run unchecked.`;
  }
  // What is left is settled by asking, and nothing was supplied to ask.
  // Refusing it HERE is what keeps this function and `runAction` in agreement:
  // a tool advertised as runnable and then refused mid-call spends the
  // caller's turn and teaches it nothing.
  //
  // `skipGuards` is the caller saying nobody will be asked, so this refusal
  // stands down. Only this one: the two above are the model being wrong about
  // its own rules -- a guard that quotes nothing, a guard that names nothing --
  // and not asking repairs neither. They are also what a push refuses, so
  // standing them down here would make this runtime disagree with the
  // validation that gates publishing the model.
  if (!skipGuards && guards.length && !judge) {
    return `Action '${action.name}' is guarded by ${quoteList(guards)}, ` +
        `which ${guards.length === 1 ? 'is' : 'are'} settled by reading the ` +
        `call, and this runtime was given no judge to ask. Running it would ` +
        `apply a write the model says must be checked first, so it is ` +
        `refused rather than run unchecked.`;
  }
  return null;
}


// The rules `action` names in its `guards` that a judge can actually be asked
// about. Advisory ones are included, because a rule that never stops the call
// still has something to report. One whose judgment states no words is left
// out: it is nothing to ask, and `unsettledGuards` reports it.
function judgedGuards(
    model: SemanticModel, action: Action): readonly Constraint[] {
  const guards = new Set(action.guards ?? []);
  return (model.constraints ?? [])
      .filter(c => guards.has(c.name) && (c.judgment ?? '').trim());
}


// Puts each judged guard to the judge, in the order the model declares them,
// and stops at the first that refuses: a call already going to be refused does
// not pay for the rest.
async function askJudges(
    action: Action, args: Record<string, unknown>,
    constraints: readonly Constraint[],
    judge: Judge): Promise<{warnings: string[]}|{error: string}> {
  const warnings: string[] = [];
  for (const constraint of constraints) {
    const advisory = constraint.onViolation === 'warn';
    let verdict: JudgeVerdict;
    try {
      const answer = await judge.decide({
        constraint: constraint.name,
        rule: (constraint.judgment ?? '').trim(),
        action: action.name,
        actionDescription: action.description,
        arguments: args,
      });
      // Read inside the try. `Judge` is a seam a caller implements, so a
      // verdict can arrive without the fields its type promises, and reaching
      // into a malformed one below would throw out of `runAction` -- which
      // states that it returns an outcome for every expected failure.
      if (typeof answer?.holds !== 'boolean') {
        throw new Error(
            `judge ${judge.name} did not say whether the rule holds`);
      }
      verdict = {
        holds: answer.holds,
        reason: typeof answer.reason === 'string' ? answer.reason : '',
      };
    } catch (err) {
      // A judge that could not be reached has not said the rule fails; it has
      // said nothing. Routing that is what `onViolation` is for: an advisory
      // rule reports it and the write proceeds, anything stricter stops the
      // call.
      const reason = err instanceof Error ? err.message : String(err);
      if (advisory) {
        warnings.push(
            `${citation(constraint)} was not checked: ${sentence(reason)}`);
        continue;
      }
      return {
        error: `Action '${action.name}' is guarded by ${
                   citation(constraint)}, and ${sentence(reason)} No ` +
            `transaction was opened, so nothing was written.`,
      };
    }
    if (verdict.holds) continue;
    const found = `${judge.name} judged that it does not hold for this call${
        verdict.reason.trim() ? `: ${sentence(verdict.reason)}` : '.'}`;
    if (advisory) {
      warnings.push(`${citation(constraint)} is advisory, and ${found}`);
      continue;
    }
    // `escalate` states that an approver exists, which is a routing this
    // runtime has nobody to route to. Saying so is the difference between a
    // rule that ends the matter and one a person can still allow.
    const appeal = constraint.onViolation === 'escalate' ?
        ` The model marks this rule 'escalate', so an approver may allow it; ` +
            `nothing here can.` :
        '';
    const steer = constraint.description?.trim();
    return {
      error: `Action '${action.name}' is guarded by ${citation(constraint)}, ` +
          `and ${found}${appeal}${steer ? ` ${sentence(steer)}` : ''} No ` +
          `transaction was opened, so nothing was written.`,
    };
  }
  return {warnings};
}


// Why the arguments cannot fill this call, or null if they can. Runs the same
// checks `bindArguments` runs, early enough that nothing has been opened or
// asked. `binds` is false when a handler supplies the writes: it is handed the
// arguments whole and decides for itself what it needs, so there is nothing
// owed to it here.
function argumentsNotUsable(
    action: Action, args: Record<string, unknown>, binds: boolean): string|
    null {
  if (!binds) return null;
  for (const param of action.parameters) {
    const raw = args[param.name];
    if (!isParameterRequired(param) && (raw === undefined || raw === null)) {
      continue;
    }
    const bound = bindScalar(param, raw);
    if ('error' in bound) return bound.error;
  }
  return null;
}


// How a rule is named in a report: what it is called, and the rule it states.
// Quoting it saves the reader a trip to the model to find out what the name
// refers to.
function citation(constraint: Constraint): string {
  const rule = (constraint.judgment ?? '').trim();
  return rule ? `'${constraint.name}' ("${rule}")` : `'${constraint.name}'`;
}


// The guards nothing settled on this run, each with why. Reached only after
// `unsafeToRunUnchecked` has refused everything stricter, so what turns up
// here is advisory: it did not stop the write, and it still has to be
// reported rather than left to read as a rule that passed.
// The guards a `skipGuards` run passed over, in the order the action names
// them. Reads the action rather than the model's constraints, because a guard
// naming a constraint that does not exist was refused before this point and a
// run that reaches here names only real ones.
function skippedGuards(
    action: Action, skipGuards?: boolean): readonly string[] {
  if (!skipGuards) return [];
  return action.guards ?? [];
}


function unsettledGuards(model: SemanticModel, action: Action, judge?: Judge):
    ReadonlyArray<{constraint: Constraint; why: string}> {
  const named = new Set(action.guards ?? []);
  const out: Array<{constraint: Constraint; why: string}> = [];
  for (const constraint of model.constraints ?? []) {
    if (!named.has(constraint.name)) continue;
    if (!(constraint.judgment ?? '').trim()) {
      // No rule to put to a judge. Refused outright when the guard is anything
      // stricter; an advisory one is never refused, so it lands here instead
      // of reaching a judge as an empty rule. `kcmd` validates the model
      // first, so a constraint with no body at all arrives only through the
      // library entry point and reads the same way.
      out.push({
        constraint,
        why: 'its judgment states no words to put to a judge.',
      });
      continue;
    }
    // One that had a judge was already put to it, and `askJudges` reported
    // whatever came back.
    if (judge) continue;
    out.push({constraint, why: 'this run was given no judge to ask.'});
  }
  return out;
}


function quoteList(names: readonly string[]): string {
  const quoted = names.map(n => `'${n}'`);
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}


interface Bindings {
  params: Record<string, unknown>;
  types: Record<string, {code: string}>;
}


// Turns each declared parameter into a bound value of the store type its
// resolved ontology type implies. Nothing is interpolated into SQL, so no
// argument can reach the store as anything but data.
function bindArguments(action: Action, args: Record<string, unknown>): Bindings|
{
  error: string
}
{
  const params: Record<string, unknown> = {};
  const types: Record<string, {code: string}> = {};
  for (const param of action.parameters) {
    const required = isParameterRequired(param);
    const raw = args[param.name];
    if (!required && (raw === undefined || raw === null)) {
      params[param.name] = null;
      types[param.name] = {code: storeCodeFor(param.type ?? 'String')};
      continue;
    }
    const bound = bindScalar(param, raw);
    if ('error' in bound) return {error: bound.error};
    params[param.name] = bound.value;
    types[param.name] = {code: bound.code};
  }
  return {params, types};
}


// Builds the plan from the action's own DML. Every `@name` in a statement names
// a parameter the action declares; validate.ts refuses a model where one does
// not, so an unbound reference cannot reach here. A key for a row the statement
// inserts is the statement's own business -- a UUID function, or a value the
// caller passed like any other.
function planFromExecutor(action: Action, bound: Bindings): ActionPlan|{
  error: string
}
{
  const executor = action.executor;
  if (executor?.kind !== 'sql') {
    return {error: `Action '${action.name}' has no 'sql' executor.`};
  }
  // Null-prototype maps throughout. Parameter names come from the model, and
  // `'toString' in {}` is true, so a plain object would let `@toString` pass
  // the "is it declared" check below and reach the store bound to
  // Object.prototype's own member.
  const values: Record<string, unknown> =
      Object.assign(Object.create(null), bound.params);
  const types: Record<string, {code: string}> =
      Object.assign(Object.create(null), bound.types);

  const statements: spanner.Statement[] = [];
  for (const sql of executor.sql.statements) {
    const params: Record<string, unknown> = {};
    const paramTypes: Record<string, {code: string}> = {};
    for (const name of referencedParameters(sql)) {
      if (!Object.hasOwn(values, name)) {
        return {
          error: `Action '${action.name}' binds '@${name}', but declares no ` +
              `parameter of that name.`,
        };
      }
      params[name] = values[name];
      paramTypes[name] = types[name];
    }
    statements.push({sql, params, paramTypes});
  }
  return {statements};
}
