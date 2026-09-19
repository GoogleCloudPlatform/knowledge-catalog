// The semantic runtime: executing a model's action against a live store.
//
// A semantic model has always described what things MEAN. Actions describe what
// can be DONE. This module is where the two meet an actual database:
//
//   1. RESOLVE. An action's parameters are typed by the ontology, so an
//      entity-typed argument is an object reference, not a value. The caller
//      (often an agent) supplies something human -- an account id, a person's
//      name -- and the runtime turns it into the row that argument denotes,
//      failing loudly on "no such thing" and on "more than one such thing".
//   2. BIND. Every argument becomes a query parameter of the store type its
//      declared ontology type implies. Nothing is interpolated into SQL.
//   3. APPLY. A read-write transaction is opened, the action's writes are run
//      inside it, and it is committed. Any failure before the commit rolls
//      back, so no partial write survives. A failure OF the commit is the one
//      case nothing here can resolve -- the store may have applied it and lost
//      the response -- and it is reported as the unknown it is rather than as
//      a rollback.
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

import {boundTable} from '../binding';
import {Action, ActionParameter, Constraint, Entity, fieldBinding, SemanticModel,} from '../ir';
import {bindScalar, isParameterRequired, sentence, storeCodeFor,} from '../parameters';
import {referencedParameters} from '../sql_identifiers';

import {dialectFor, SqlDialect} from './dialect';
import {Judge, JudgeVerdict} from './judge';
import {runtimeClient, SemanticRuntime} from './runtime';

export {bindScalar, isParameterRequired, sentence, storeCodeFor} from '../parameters';


// An entity-typed argument, resolved to the row it denotes.
export interface EntityRef {
  entity: string;
  // Key values in the entity's declared key order, as strings (both
  // operational backends hand every scalar over as text, and the runtime keeps
  // them that way so a caller need not know the physical types).
  keys: string[];
  // How the caller referred to it, kept for error messages.
  input: string;
}


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


// What the handler is given: the action, its arguments with entity-typed ones
// already resolved, and a reader scoped to the open transaction (so a handler
// can look at the pre-state before deciding what to write). An optional
// entity-typed parameter omitted by the caller has no entry in `refs`
// (`refs[param.name]` is `undefined`).
export interface ActionContext {
  model: SemanticModel;
  action: Action;
  args: Record<string, unknown>;
  refs: Record<string, EntityRef|undefined>;
  query: QueryFn;
}


export type ActionHandler = (ctx: ActionContext) => Promise<ActionPlan>;


export type ActionOutcome = {
  status: 'committed';
  commitTimestamp?: string;
  refs: Record<string, EntityRef>;
  // What a rule reported without stopping the write. A guard whose
  // `onViolation` is `warn` puts its verdict here, and so does one whose judge
  // could not be reached: the call committed, and the caller is told what went
  // unmet or unchecked rather than left to read silence as "every rule
  // passed".
  warnings?: string[];
}|{
  status: 'error';
  // A failure that stopped the write: an argument that resolved to nothing, an
  // action this runtime will not run unchecked, a store-level error. The
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
}


// Runs one action end to end. Never throws for an expected failure -- an
// unresolvable argument, a refused action, a rejected statement all come back
// as an outcome, because the caller is usually an agent that needs to read the
// reason and try again.
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
  const refusal =
      whyRefusedWithoutRunning(model, action, opts.handler, opts.judge);
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
  if (opts.judge) {
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
  // Every guard still unsettled here is advisory, because anything stricter
  // was refused above. An advisory rule nothing checked is a check the model
  // asked for and did not get, and a caller shown no line for it reads the
  // write as having passed every rule the model states.
  for (const {constraint, why} of unsettledGuards(model, action, opts.judge)) {
    warnings.push(`${citation(constraint)} was not checked: ${why}`);
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
              err instanceof Error ? err.message :
                                     String(err)} (while running: ${stmt.sql})`);
        }
        if (res.status < 200 || res.status >= 300) {
          throw new StoreError(
              `${res.message ?? 'request failed'} (while running: ${stmt.sql})`);
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

        // The action's own statements were written for this store by
        // whoever wrote the profile. The reference-resolving SELECTs below are
        // written here, so they are the ones that need to know which dialect
        // is listening.
        const resolved = await resolveArguments(
            model, action, args, query, dialectFor(opts.runtime.store));
        if ('error' in resolved) {
          return await rollback({status: 'error', message: resolved.error});
        }
        const refs = resolved.refs;

        // The bindings exist to fill the model's OWN statements, so they are
        // built only when the model is what supplies them. A handler is given
        // `refs` whole and may write a composite key, which this pass refuses
        // because a single statement parameter cannot carry one.
        let plan: ActionPlan|{error: string};
        if (opts.handler) {
          plan = await opts.handler({model, action, args, refs, query});
        } else {
          const bound = bindArguments(model, action, args, refs);
          if ('error' in bound) {
            return await rollback({status: 'error', message: bound.error});
          }
          plan = planFromExecutor(action, bound);
        }
        if ('error' in plan) {
          return await rollback({status: 'error', message: plan.error});
        }
        for (const stmt of plan.statements) {
          await run(stmt);
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
                client.database}: ${reason}. The store refused the commit ` +
                `outright, so nothing was written and the action can be run ` +
                `again.`,
          });
        }
        return {
          status: 'committed',
          commitTimestamp: committed.result?.commitTimestamp,
          refs,
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
        message:
            `Action '${action.name}' could not start on ${client.database}: ${
                reason}`,
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


// Commit statuses that mean the transaction applied NOTHING, as against
// leaving its fate unknown. A Spanner `409 ABORTED` -- the routine outcome of
// lock contention -- guarantees it, and so do a rejected request, a denied
// permission, and a transaction the server no longer has. Everything else,
// every 5xx and every timeout included, is a commit that may have landed:
// unlisted is the safe default, because the cost of wrongly reporting "nothing
// was written" is a retry that writes twice.
const DEFINITELY_NOT_COMMITTED = new Set([400, 401, 403, 404, 409, 412]);


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
    judge?: Judge): string|null {
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
        executor.kind.toUpperCase()}, which runs outside this transaction ` +
        `and could not be rolled back if the commit failed. Supply a handler ` +
        `that performs the write as DML, or declare the action with a 'sql' ` +
        `executor.`;
  }
  const unchecked = unsafeToRunUnchecked(model, action, judge);
  if (unchecked) return unchecked;
  // The refusals left are about filling the model's OWN statements, so they
  // apply only when the model is what supplies them. A handler writes its own
  // DML, is handed `refs` whole, and may well spell a composite key across
  // several parameters -- none of what follows is owed by it.
  if (handler) return null;
  return unbindableByThisRuntime(model, action);
}


// Why this runtime could not fill the model's own statements for `action`, or
// null if it could. The answer is in the model and needs no row, so it is owed
// HERE. Binding asks it again where the values are, which is where it has to be
// enforced; asking only there would charge a caller a transaction to be told
// something the model said all along.
function unbindableByThisRuntime(
    model: SemanticModel, action: Action): string|null {
  for (const param of action.parameters) {
    if (!param.isEntityRef) continue;
    const entity = (model.entities ?? []).find(e => e.name === param.type);
    const parts = (entity?.keys ?? []).length;
    if (parts > 1) {
      return `Parameter '${param.name}' of action '${action.name}' refers ` +
          `to a ${param.type}, whose key has ${parts} parts; the runtime ` +
          `binds an object reference as a single value, so a composite key ` +
          `cannot be passed to a statement.`;
    }
  }
  return null;
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
    model: SemanticModel, action: Action, judge?: Judge): string|null {
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
  if (guards.length && !judge) {
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


function entityKeyType(model: SemanticModel, entityName: string): string {
  const entity = (model.entities ?? []).find(e => e.name === entityName);
  const keyField = entity?.fields.find(f => f.name === (entity.keys ?? [])[0]);
  return keyField?.type ?? 'String';
}


// Why the arguments cannot fill this call, or null if they can. Runs the same
// checks `resolveArguments` and `bindArguments` run, early enough that nothing
// has been opened or asked. `binds` is false when a handler supplies the
// writes: it is handed the arguments whole and decides for itself what it
// needs, so only the object references are its business here.
function argumentsNotUsable(
    action: Action, args: Record<string, unknown>, binds: boolean): string|
    null {
  for (const param of action.parameters) {
    const raw = args[param.name];
    const required = isParameterRequired(param);
    if (param.isEntityRef) {
      if (raw === undefined || raw === null || `${raw}`.trim() === '') {
        if (!required && (raw === undefined || raw === null)) continue;
        return `Action '${action.name}' requires '${param.name}', a ` +
            `reference to a ${param.type}, but none was given.`;
      }
      continue;
    }
    if (!binds) continue;
    if (!required && (raw === undefined || raw === null)) continue;
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


// Turns each declared parameter into a bound value: an entity-typed one into
// the key of the row it resolved to, a scalar into a value of the store's
// matching type. Nothing is interpolated into SQL, so no argument can reach the
// store as anything but data.
function bindArguments(
    model: SemanticModel, action: Action, args: Record<string, unknown>,
    refs: Record<string, EntityRef>): Bindings|{error: string} {
  const params: Record<string, unknown> = {};
  const types: Record<string, {code: string}> = {};
  for (const param of action.parameters) {
    const required = isParameterRequired(param);
    const raw = args[param.name];
    if (!required && (raw === undefined || raw === null)) {
      const targetType = param.isEntityRef ?
          entityKeyType(model, param.type) :
          param.type;
      params[param.name] = null;
      types[param.name] = {code: storeCodeFor(targetType)};
      continue;
    }
    const bound = param.isEntityRef ?
        bindReference(model, param, refs[param.name]) :
        bindScalar(param, raw);
    if ('error' in bound) return {error: bound.error};
    params[param.name] = bound.value;
    types[param.name] = {code: bound.code};
  }
  return {params, types};
}


// An object reference as its key value, typed by the ontology. Resolution
// returns every key as a string, because that is what the store's REST surface
// gives back; binding it into a statement needs the type the KEY FIELD declares,
// or an integer-keyed row would be handed to the store as text.
function bindReference(
    model: SemanticModel, param: ActionParameter, ref: EntityRef|undefined):
    {value: unknown; code: string}|{error: string} {
  if (!ref) return {error: `Parameter '${param.name}' was not resolved.`};
  if (ref.keys.length !== 1) {
    return {
      error: `Parameter '${param.name}' refers to a ${param.type}, whose key ` +
          `has ${ref.keys.length} parts; the runtime binds an object ` +
          `reference as a single value, so a composite key cannot be passed ` +
          `to a statement.`,
    };
  }
  return bindScalar(
      {name: param.name, type: entityKeyType(model, param.type)}, ref.keys[0]);
}


// Builds the plan from the action's own DML. Every `@name` in a statement names
// a parameter the action declares; validate.ts refuses a model where one does
// not, so an unbound reference cannot reach here. A key for a row the statement
// inserts is the statement's own business -- a UUID function, or a value the
// caller passed like any other.
function planFromExecutor(
    action: Action, bound: Bindings): ActionPlan|{error: string} {
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


// Turns each entity-typed argument into the row it denotes. Scalar arguments
// pass through untouched; this is only about object references.
async function resolveArguments(
    model: SemanticModel, action: Action, args: Record<string, unknown>,
    query: QueryFn, dialect: SqlDialect):
    Promise<{refs: Record<string, EntityRef>}|{error: string}> {
  const refs: Record<string, EntityRef> = {};
  for (const param of action.parameters) {
    if (!param.isEntityRef) continue;
    const raw = args[param.name];
    const required = isParameterRequired(param);
    if (raw === undefined || raw === null || `${raw}`.trim() === '') {
      if (!required && (raw === undefined || raw === null)) continue;
      return {
        error: `Action '${action.name}' requires '${param.name}', a reference ` +
            `to a ${param.type}, but none was given.`,
      };
    }
    const entity = (model.entities ?? []).find(e => e.name === param.type);
    if (!entity) {
      return {
        error: `Parameter '${param.name}' is typed '${param.type}', which the ` +
            `model does not declare as an entity.`,
      };
    }
    const resolved = await resolveEntityRef(entity, `${raw}`, query, dialect);
    if ('error' in resolved) return {error: resolved.error};
    refs[param.name] = resolved.ref;
  }
  return {refs};
}


// Resolves one object reference. `input` is matched against the entity's key
// and, when it has one, its identifying text field -- so an agent can say
// "Account 1" or "Alice" and the runtime finds the same row either way.
//
// Both failure modes are reported precisely, because both are things the caller
// can act on: nothing matched (the reference is wrong) or several matched (the
// reference is ambiguous, and the candidates are listed).
async function resolveEntityRef(
    entity: Entity, input: string, query: QueryFn, dialect: SqlDialect):
    Promise<{ref: EntityRef}|{error: string}> {
  const warnings: string[] = [];
  const table = boundTable(
      entity.dataSource, warnings, `entity '${entity.name}'`, dialect.quote);
  if (warnings.length) {
    return {error: `Cannot resolve a ${entity.name}: ${warnings.join('; ')}.`};
  }

  const keyColumns: string[] = [];
  const keyTypes: string[] = [];
  for (const key of entity.keys) {
    const field = entity.fields.find(f => f.name === key);
    const expr = (field ? fieldBinding(field) ?? '' : '').trim();
    if (!expr || !/^[A-Za-z_]\w*$/.test(expr)) {
      return {
        error: `Cannot resolve a ${entity.name}: its key field '${
            key}' is not bound to a plain column.`,
      };
    }
    keyColumns.push(dialect.quote(expr));
    keyTypes.push(field?.type ?? 'String');
  }
  if (!keyColumns.length) {
    return {error: `Cannot resolve a ${entity.name}: it declares no key.`};
  }

  // Each column is compared as ITSELF, against the input parsed to the type
  // that column's field declares. Casting them all to STRING would let one
  // predicate shape serve every key type, but no index can answer it -- and
  // this SELECT runs inside the action's read-write transaction, so a scan
  // would hold read locks over the whole table for the length of the write.
  // Input that is not a value of a key's type cannot name that key, so its
  // predicate is dropped rather than made to match by casting.
  //
  // Only a SINGLE-column key is matched this way. One input value cannot name
  // a composite key, and `k1 = @ref OR k2 = @ref` would accept a row matching
  // one PART of the key as though it were the row meant -- worse, it can match
  // several rows that agree on that part and differ in the rest. A
  // composite-keyed entity is reachable here only through its identifying
  // text column.
  const predicates: string[] = [];
  const params: Record<string, unknown> = {};
  const paramTypes: Record<string, {code: string}> = {};
  if (keyColumns.length === 1) {
    const bound = bindScalar({name: 'ref', type: keyTypes[0]}, input);
    if (!('error' in bound)) {
      predicates.push(`${keyColumns[0]} = @ref0`);
      params['ref0'] = bound.value;
      paramTypes['ref0'] = {code: bound.code};
    }
  }
  // An identifying column is a String field by construction, so the input is
  // already a value of its type.
  const label = identifyingColumn(entity, dialect);
  if (label) {
    predicates.push(`${label} = @ref`);
    params['ref'] = input;
    paramTypes['ref'] = {code: 'STRING'};
  }
  if (!predicates.length) {
    if (keyColumns.length > 1) {
      return {
        error: `Cannot resolve a ${entity.name} from a single value: its key ` +
            `has ${keyColumns.length} columns, and it declares no ` +
            `identifying text field to match instead.`,
      };
    }
    // The input is not a value of the key's type and there is no text field to
    // match it against, so no row in the table can be the one meant.
    return {error: `No ${entity.name} matches '${input}'.`};
  }

  // A key read here is carried in an EntityRef and re-bound as a parameter
  // later, so it has to come back written the way `bindScalar` reads it.
  //
  // A Date is the one key type where that is not what arrives: PostgreSQL hands
  // a `date` back as a timestamp value, which renders as a full ISO instant
  // rather than the plain day `bindScalar` requires. Casting it to text asks
  // the database for the day, which both backends spell the same way.
  //
  // Nothing else is cast, and a timestamp key least of all. Both backends
  // already return one in RFC 3339, which is the form required; casting would
  // REPLACE that with the SQL rendering -- `2026-09-07 00:00:00+00`, a
  // two-digit offset -- which is not a form `bindScalar` accepts. A cast that
  // was added for dates would have broken timestamps.
  //
  // Either way this is the SELECT list, not the WHERE clause: the predicates
  // above stay uncast so an index can answer them (see the note there). Casting
  // an output costs no index; casting a predicate would.
  const selected = keyColumns.map(
      (column, i) => keyTypes[i] === 'Date' ? dialect.castToText(column) :
                                              column);

  // LIMIT 2 is enough to tell "one match" from "more than one", and avoids
  // dragging back a large candidate set just to reject it.
  const rows = await query({
    sql: `SELECT ${selected.join(', ')} FROM ${table} WHERE ${
        predicates.join(' OR ')} LIMIT 2`,
    params,
    paramTypes,
  });

  if (!rows.length) {
    return {error: `No ${entity.name} matches '${input}'.`};
  }
  if (rows.length > 1) {
    return {
      error: `'${input}' matches more than one ${entity.name} (${
          rows.map(r => r.join('/')).join(', ')}); use a key to disambiguate.`,
    };
  }
  // A key column cannot be NULL -- it is what identifies the row -- so a null
  // here is the store disagreeing with the model about which columns the key
  // is. Reported rather than carried: the value would go on to fill a
  // statement parameter, and an empty string standing in for it would name a
  // different row, or no row, without saying so.
  const keys = rows[0];
  if (keys.some(value => value === null)) {
    return {
      error: `Cannot resolve a ${entity.name}: the row matching '${
          input}' has no value in a key column, so it cannot be referred to.`,
    };
  }
  return {ref: {entity: entity.name, keys: keys as string[], input}};
}


// The entity's identifying text field, if it has an obvious one: a String field
// that is not part of the key and whose name reads as a name. Deliberately
// conservative -- guessing wrong would make an agent's reference resolve to the
// wrong row, which is worse than making it supply a key.
function identifyingColumn(entity: Entity, dialect: SqlDialect): string|
    null {
  const keys = new Set(entity.keys);
  for (const field of entity.fields) {
    if (keys.has(field.name)) continue;
    if (field.type !== 'String') continue;
    if (!/^(name|full_name|fullname|title|label|display_name)$/i.test(
            field.name)) {
      continue;
    }
    const expr = (fieldBinding(field) ?? '').trim();
    if (!expr || !/^[A-Za-z_]\w*$/.test(expr)) continue;
    return dialect.quote(expr);
  }
  return null;
}
