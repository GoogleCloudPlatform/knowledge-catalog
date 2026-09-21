/**
 * Turning a model into agent tools.
 *
 * An action declares everything a write tool needs: a name, a description of
 * what it does, its typed parameters, the guidance an AI caller should follow
 * (`ai_context.instructions`), and the rules that gate it. This module reads
 * that out and hands back plain descriptions of the tools, each with a
 * function that runs it.
 *
 * The description is framework-neutral on purpose. Nothing here imports an
 * agent framework, so binding these to Google ADK, to LangChain, or to an MCP
 * server is a short adapter the caller writes, and adding a second framework
 * costs nothing in this file.
 *
 * What this module does NOT do is decide anything. A tool built here is a way
 * to ask. Every refusal is decided by runAction, and an agent that calls a
 * tool it should not have gets back an outcome it has to report rather than a
 * knob it can turn.
 *
 * What the runtime can settle shows through here, because it decides which
 * tools are worth handing out. Every guard is settled by asking a judge, so
 * passing one in is what makes a guarded action callable at all; without one
 * runAction refuses rather than running the write unchecked. A tool for an
 * action that would be refused every time it was called is a bad thing to hand
 * a caller that cannot see why. So a tool carries `runnable`, and an adapter
 * binds the ones that are; the rest are still returned, named and explained,
 * because an action the model declares should not vanish from a listing of
 * what the model declares.
 */

import {boundTable} from '../binding';
import {Action, ActionParameter, Constraint, Entity, fieldBinding, SemanticModel} from '../ir';

import {SqlDialect} from './dialect';
import {Judge} from './judge';
import {ActionHandler, ActionOutcome, isParameterRequired, runAction, sentence, whyRefusedWithoutRunning,} from './run_action';
import {runtimeClient, SemanticRuntime} from './runtime';


/** The JSON types a tool parameter can take. */
export type ToolParameterType = 'string'|'number'|'integer'|'boolean';


/** One argument a tool accepts, derived from an action parameter. */
export interface ToolParameter {
  name: string;
  type: ToolParameterType;
  /** What to pass, in the words the model's own types justify. */
  description: string;
  /**
   * Whether the caller must supply this argument. An action parameter is
   * required unless declared `required: false` or given a `default`; entity
   * filters are all optional.
   */
  required: boolean;
  /**
   * The default value substituted when the caller omits the argument, if any.
   */
  default?: unknown;
}


/** One tool, derived from one action. */
export interface ActionTool {
  /** The action name in snake_case, which is what tool APIs expect. */
  name: string;
  /** The action this tool calls, by its authored name. */
  actionName: string;
  /**
   * What the tool does and how to call it: the action's description, its
   * `ai_context.instructions`, and a line naming the rules that gate it so a
   * caller learns the shape of a refusal before it hits one.
   */
  description: string;
  parameters: ToolParameter[];
  /**
   * Whether calling this would reach the store. False when the runtime would
   * refuse it before opening a transaction -- because the action names a guard
   * nothing here can settle, or because this binding supplies no executor.
   * Which guards can be settled depends on what was passed in: a judged guard
   * needs a `judge`, and an expression needs an evaluator that does not exist
   * yet. `invoke` still works and still reports the refusal; this is here so
   * an adapter can decline to offer a tool that cannot work.
   */
  runnable: boolean;
  /** Why `runnable` is false, in words a caller can report. */
  unavailable?: string;
  /** Runs the action and reports the outcome in terms an agent can act on. */
  invoke(args: Record<string, unknown>): Promise<ToolResult>;
}


/**
 * What a caller is told after invoking a tool.
 *
 * Three states, not two. A write that landed and a write that did not are the
 * obvious pair; the third is a commit whose outcome nothing can establish,
 * which a caller must not read as "nothing happened" and retry.
 */
export interface ToolResult {
  applied: boolean;
  /** Present when the write committed. */
  committedAt?: string;
  /** Why the write did not happen, in the runtime's own words. */
  reason?: string;
  /**
   * Set when the write may or may not have landed and nothing here can tell.
   * The statements ran and the commit itself failed to answer.
   */
  unknown?: boolean;
  /**
   * What the caller should do next, when the outcome permits only one thing.
   */
  whatToDo?: string;
  /**
   * What a rule reported without stopping the write. An advisory guard whose
   * rule did not hold lands here, and so does one nothing was able to put to a
   * judge. Dropping these would tell the agent the write met every rule the
   * model states, which is the one thing it must not conclude on its own.
   */
  warnings?: string[];
}


export interface ActionToolOptions {
  /** The model to derive tools from, and the store they would run against. */
  runtime: SemanticRuntime;
  /**
   * Supplies the writes for an action whose executor lives in another system.
   * Without one, only a `sql` executor is runnable, because the runtime will
   * not wrap a call it could not roll back.
   */
  handler?: ActionHandler;
  /**
   * Settles the guards the model states in words. An action guarded by a
   * judgment is refused without one, so passing a judge here is what makes
   * such an action offerable at all.
   *
   * The same judge answers `runnable` and the call, which is why it is passed
   * to the derivation rather than to each invocation: a tool derived with a
   * judge and then called without one would be advertised as runnable and
   * refused mid-call.
   */
  judge?: Judge;
}


/**
 * One tool per action the model declares, in declaration order.
 *
 * A model with no actions yields no tools, which is the honest answer: an
 * agent over a read-only model has nothing to call.
 */
export function actionTools(opts: ActionToolOptions): ActionTool[] {
  return (opts.runtime.model.actions ?? [])
      .map(action => toolFor(action, opts));
}


function toolFor(action: Action, opts: ActionToolOptions): ActionTool {
  // A handler stands in for an executor this runtime cannot call. It must not
  // stand in for one it CAN: the whole claim of a `sql` executor is that what
  // runs is what the catalog published and reviewed, and `handler` here is one
  // function for the whole model, so passing it through unconditionally would
  // retract that claim for every action at once -- silently, since runAction
  // prefers a handler over the action's own statements.
  const handler = action.executor?.kind === 'sql' ? undefined : opts.handler;
  // Asked of the runtime rather than worked out again here. Two copies of this
  // rule drift, and neither direction of the drift is visible: a tool said to
  // be runnable that refuses every call, or one withheld that would have run.
  // Two ways a call cannot go through, reported in the order that helps: what
  // is wrong with THIS action first, since it names something to fix in the
  // model, then the runtime having no store, which is the same sentence on
  // every tool and says nothing about this one.
  const model = opts.runtime.model;
  const blocked =
      whyRefusedWithoutRunning(model, action, handler, opts.judge) ??
      noStore(opts.runtime) ?? undefined;
  const tool: ActionTool = {
    name: snakeCase(action.name),
    actionName: action.name,
    description: toolDescription(action, model, blocked),
    parameters: action.parameters.map(toolParameter),
    runnable: !blocked,
    async invoke(args: Record<string, unknown>): Promise<ToolResult> {
      const outcome = await runAction({
        runtime: opts.runtime,
        actionName: action.name,
        args,
        handler,
        judge: opts.judge,
      });
      return describeOutcome(outcome);
    },
  };
  if (blocked) tool.unavailable = blocked;
  return tool;
}


// The three sources of description, in the order a caller needs them: what the
// action does, how to call it, and why it would be refused. A model that
// supplies none of them still yields a usable tool, because the parameter
// descriptions carry their own types.
function toolDescription(
    action: Action, model: SemanticModel, blocked?: string): string {
  const parts: string[] = [];
  if (action.description) parts.push(action.description.trim());
  const instructions = action.aiContext?.instructions?.trim();
  if (instructions) parts.push(instructions);
  // Said even when the call cannot be made, because the reason it cannot is
  // that these rules exist and this run has no way to settle them.
  const gates = gatingConstraints(action, model);
  if (gates.length) {
    const names = joinNames(gates.map(c => c.name));
    const rules = gates
                      .map(c => {
                        const body = (c.judgment ?? '').trim();
                        const desc = (c.description ?? '').trim();
                        const text = body && desc ?
                            `${sentence(body)} ${sentence(desc)}` :
                            (body || desc);
                        return text ? `- ${c.name}: ${text}` : undefined;
                      })
                      .filter((s): s is string => s !== undefined);
    if (rules.length) {
      parts.push(`This call is gated by ${names}:\n${rules.join('\n')}`);
    } else {
      parts.push(`This call is gated by ${names}.`);
    }
  }
  if (blocked) {
    parts.push(
        `Calling this will not work: ${blocked} Report that rather ` +
        `than retrying.`);
  }
  return parts.join('\n\n');
}


// Which rules a caller will meet. `guards` names them, and it names all of
// them: every constraint is settled before the write, from the attempted call
// alone, so there is no second set checked afterwards that a caller would have
// no way to anticipate.
//
// An ADVISORY guard is not named either. A constraint whose `onViolation` is
// `warn` reports and lets the write through, so the runtime stands down and
// the call goes ahead -- telling a caller it is "gated" by a rule that gates
// nothing is the one kind of claim this file must not make. Saying less is the
// honest half of saying it accurately.
function gatingConstraints(action: Action, model: SemanticModel): Constraint[] {
  const byName = new Map((model.constraints ?? [])
                             .filter(c => c.onViolation !== 'warn')
                             .map(c => [c.name, c]));
  return (action.guards ?? [])
      .map(name => byName.get(name))
      .filter((c): c is Constraint => c !== undefined);
}


// Every parameter is a scalar, so every one is described the same way: its own
// words, and its own type. A parameter projected from a field arrives here
// already carrying the field's type and wording, resolved by the loader, so
// there is nothing left for this to tell apart -- and nothing for it to say
// about resolution, because the runtime resolves nothing.
function toolParameter(param: ActionParameter): ToolParameter {
  const said = param.description?.trim();
  const guidance = scalarFormatGuidance(param.type);
  // `sentence` whether or not the guidance follows: a description authored
  // without a terminator is read by a model alongside every other one, and the
  // odd one out reads as a fragment of the next line rather than its own.
  const out: ToolParameter = {
    name: param.name,
    type: jsonType(param.type),
    description: said ?
        (guidance ? `${sentence(said)} ${guidance}` : sentence(said)) :
        `The ${param.name}, as ${article(param.type)}.`,
    required: isParameterRequired(param),
  };
  if (param.default !== undefined) out.default = param.default;
  return out;
}


function scalarFormatGuidance(dataType: string|undefined): string|undefined {
  switch (dataType) {
    case 'Date':
    case 'Time':
    case 'DateTime':
    case 'DateTimeTz':
      return `As ${article(dataType)}.`;
    default:
      return undefined;
  }
}


// The model's scalar types over the four JSON types a tool schema can express.
// Anything temporal or opaque travels as a string, because that is what the
// model's own text form uses and what the store parses back.
function jsonType(dataType: string|undefined): ToolParameterType {
  switch (dataType) {
    case 'Integer':
      return 'integer';
    case 'Decimal':
    case 'Float':
      return 'number';
    case 'Boolean':
      return 'boolean';
    default:
      return 'string';
  }
}


function article(dataType: string|undefined): string {
  switch (dataType) {
    case 'Integer':
      return 'a whole number';
    case 'Decimal':
      return 'a decimal number';
    case 'Float':
      return 'a number';
    case 'Boolean':
      return 'true or false';
    case 'Date':
      return 'a date, YYYY-MM-DD';
    case 'Time':
      return 'a time, HH:MM:SS';
    case 'DateTime':
    case 'DateTimeTz':
      return 'a timestamp in RFC 3339 form';
    default:
      return 'text';
  }
}


/**
 * An outcome in the terms a caller can act on.
 *
 * Exported because an adapter for a framework with its own result shape needs
 * this mapping without needing the rest of the tool.
 */
export function describeOutcome(outcome: ActionOutcome): ToolResult {
  switch (outcome.status) {
    case 'committed': {
      const result: ToolResult = {applied: true};
      if (outcome.commitTimestamp) result.committedAt = outcome.commitTimestamp;
      if (outcome.warnings?.length) result.warnings = outcome.warnings;
      return result;
    }
    case 'error':
      // `indeterminate` is the one outcome where "applied: false" would be a
      // lie the caller acts on: it retries, and the write lands twice.
      if (outcome.indeterminate) {
        return {
          applied: false,
          unknown: true,
          reason: outcome.message,
          whatToDo: 'Do NOT retry. Report that the outcome is unknown, and ' +
              'read the data back before anything else acts on it.',
        };
      }
      return {
        applied: false,
        reason: outcome.message,
        whatToDo: 'Correct what the reason describes, or report it. Nothing ' +
            'was written.',
      };
  }
}


// `IssueCredit` -> `issue_credit`, `HTTPRetry` -> `http_retry`. Tool names are
// snake_case across every framework this targets, and an action name is
// PascalCase by the model's own convention.
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/[\s-]+/g, '_')
      .toLowerCase();
}


function joinNames(names: string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}


/** Everything a model offers an agent, in one name space. */
export interface ModelTools {
  /** One write per action. */
  actions: ActionTool[];
  /** The ones a call would actually reach the store through. */
  callable: ActionTool[];
  /** The rest. Each carries `unavailable`, saying why. */
  withheld: ActionTool[];
  /**
   * What to tell an agent holding these tools: the model's own
   * `ai_context.instructions` followed by how the tools are meant to be used.
   */
  instruction: string;
}


/**
 * Every tool a model offers, with the names guaranteed distinct.
 *
 * Two actions can snake-case alike (`IssueCredit` and `issue-credit`), and
 * there is no principled winner between two author names, so the later one is
 * numbered.
 */
export function modelTools(opts: ActionToolOptions): ModelTools {
  const actions = actionTools(opts);
  const taken = new Set<string>();
  for (const tool of actions) {
    tool.name = distinct(tool.name, taken);
  }
  return {
    actions,
    callable: actions.filter(tool => tool.runnable),
    withheld: actions.filter(tool => !tool.runnable),
    instruction: instructionFor(opts.runtime.model),
  };
}


/** Derived tools sorted by whether this binding can serve them. */
export interface CallableTools {
  /** The ones a call would actually reach the store through. */
  callable: ActionTool[];
  /** The rest. Each carries `unavailable`, saying why. */
  withheld: ActionTool[];
  /** `ModelTools.instruction`, carried through unchanged. */
  instruction: string;
}


/**
 * Sort the derived tools into the ones this binding can serve and the ones it
 * cannot.
 */
export function callableTools(tools: ModelTools): CallableTools {
  return {
    callable: tools.callable,
    withheld: tools.withheld,
    instruction: tools.instruction,
  };
}


// What to tell an agent that holds these tools, and the split is the point.
//
// The first part is the model's own `ai_context.instructions`: what this
// business asks of anything that acts on it. It belongs to the model because
// it outlives whichever agent is holding the tools this week, and because an
// agent that carries it in its own source is a place the rule can be changed
// without anyone who owns the model noticing.
//
// The second part is about the tools rather than the business -- where a key
// has to come from, and what a refused write or a warning means. That half is
// owed by whoever derived the tools, because it describes a contract this file
// defines and the model never stated. Written into each agent instead, it is
// the same paragraph copied into every adapter, drifting in each one.
//
// So neither half is the agent's to write, and an agent that appends its own
// is saying something the model did not.
function instructionFor(model: SemanticModel): string {
  const parts: string[] = [];
  const stated = model.aiContext?.instructions?.trim();
  if (stated) parts.push(stated);
  parts.push(
      'Never invent an identifier. When you are given a name or a ' +
      'description where an action wants a key, ask the caller or read the ' +
      'store directly. When a tool reports that a write did not happen, read ' +
      'the reason it gives and repeat it plainly; if it says a person has to ' +
      'decide, say so and stop, because you cannot approve it yourself. When ' +
      'a write did happen and the tool returns warnings, the change landed ' +
      'and a rule still went unmet or unchecked: report both, because ' +
      'nobody else will. Finish by saying what you changed.');
  return parts.join('\n\n');
}


// Reserves `base`, or the first numbered form of it that is free.
function distinct(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  taken.add(name);
  return name;
}


// Why nothing derived from this runtime can be called, or null when it can
// be. Both halves of a runtime are needed to make a call: a model says what to
// do and a store is where it happens, and a runtime carrying only the first is
// a model an agent can read about but not use.
function noStore(runtime: SemanticRuntime): string|null {
  const client = runtimeClient(runtime);
  return 'error' in client ? client.error : null;
}


// A field is readable when the profile bound it to a plain column. One bound
// to an expression is skipped rather than guessed at.
interface BoundField {
  name: string;
  type: string;
  column: string;
  /** What the model says this field holds, if it says anything. */
  description?: string;
}


function boundFields(entity: Entity): BoundField[] {
  const bound: BoundField[] = [];
  for (const field of entity.fields) {
    const expr = (fieldBinding(field) ?? '').trim();
    if (!expr || !/^[A-Za-z_]\w*$/.test(expr)) continue;
    // A field with no declared type travels as text, which is the carrier
    // every scalar has a faithful string form in.
    const said = field.description?.trim();
    bound.push({
      name: field.name,
      type: field.type ?? 'String',
      column: expr,
      ...(said ? {description: said} : {}),
    });
  }
  return bound;
}


/**
 * An entity a statement can name: one table, and the columns behind it.
 */
export interface ReadableEntity {
  entity: Entity;
  table: string;
  fields: BoundField[];
}


/**
 * What there is to read under this runtime: one entry per entity the model
 * declares, the profile binds to a table, and a statement can name.
 *
 * An abstract entity has no table, a field bound to an expression is not a
 * column, and a data source that is not a table reference cannot be read from.
 * An entity this leaves out is one nothing here can point a reader at.
 */
export function readableEntities(
    runtime: SemanticRuntime, dialect: SqlDialect): ReadableEntity[] {
  const readable: ReadableEntity[] = [];
  for (const entity of runtime.model.entities ?? []) {
    if (entity.abstract) continue;
    const fields = boundFields(entity);
    if (!fields.length) continue;
    const warnings: string[] = [];
    const table =
        boundTable(entity.dataSource, warnings, entity.name, dialect.quote);
    if (warnings.length) continue;
    readable.push({entity, table, fields});
  }
  return readable;
}
