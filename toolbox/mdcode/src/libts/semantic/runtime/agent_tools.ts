/**
 * Turning a model into agent tools.
 *
 * An agent needs two things from a model: a way to look at what is there, and
 * a way to change it. Both are already declared.
 *
 * An action declares everything a write tool needs: a name, a description of
 * what it does, its typed parameters, the guidance an AI caller should follow
 * (`ai_context.instructions`), and the rules that gate it. An entity plus its
 * binding profile declares everything a read tool needs: the fields, and the
 * table and columns they resolve to. This module reads both out and hands back
 * plain descriptions of the tools, each with a function that runs it.
 *
 * The description is framework-neutral on purpose. Nothing here imports an
 * agent framework, so binding these to Google ADK, to LangChain, or to an MCP
 * server is a short adapter the caller writes, and adding a second framework
 * costs nothing in this file. The ADK adapter in
 * demo/semantic-model/agent/agent.ts is a dozen lines.
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

import {boundTable, spannerTable} from '../binding';
import {Action, ActionParameter, Constraint, Entity, fieldBinding, SemanticModel} from '../ir';

import {dialectFor} from './dialect';
import {Judge} from './judge';
import {ActionHandler, ActionOutcome, bindScalar, isParameterRequired, runAction, sentence, whyRefusedWithoutRunning,} from './run_action';
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
  /**
   * The rows the action's arguments resolved to, so a caller can report what
   * it actually acted on rather than what it asked for.
   */
  actedOn?: Record<string, string[]>;
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
  const byName = new Map(
      (model.constraints ?? [])
          .filter(c => c.onViolation !== 'warn')
          .map(c => [c.name, c]));
  return (action.guards ?? [])
      .map(name => byName.get(name))
      .filter((c): c is Constraint => c !== undefined);
}


// An entity-typed parameter takes a reference the runtime resolves, so the
// description says so rather than demanding a key the caller may not have. A
// scalar parameter takes its own type.
function toolParameter(param: ActionParameter): ToolParameter {
  const said = param.description?.trim();
  const required = isParameterRequired(param);
  const guidance = scalarFormatGuidance(param.type);
  const out: ToolParameter = param.isEntityRef ?
      {
        name: param.name,
        type: 'string',
        description: said ?
            `${sentence(said)} Give its key, or text that identifies exactly ` +
                `one ${param.type}; the call fails when nothing matches or ` +
                `more than one does.` :
            `Which ${param.type} this applies to. Give its key, or text ` +
                `that identifies exactly one; the call fails when nothing ` +
                `matches or more than one does.`,
        required,
      } :
      {
        name: param.name,
        type: jsonType(param.type),
        description: said ?
            (guidance ? `${sentence(said)} ${guidance}` : said) :
            `The ${param.name}, as ${article(param.type)}.`,
        required,
      };
  if (param.default !== undefined) out.default = param.default;
  return out;
}


function scalarFormatGuidance(dataType: string): string|undefined {
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
function jsonType(dataType: string): ToolParameterType {
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


function article(dataType: string): string {
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
      const actedOn: Record<string, string[]> = {};
      for (const [param, ref] of Object.entries(outcome.refs)) {
        actedOn[param] = ref.keys;
      }
      const result: ToolResult = {applied: true, actedOn};
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


// ---------------------------------------------------------------------------
// The read side: one lookup tool per entity.
// ---------------------------------------------------------------------------

/**
 * Rows a lookup tool returned, with the field names they line up with.
 *
 * Values are strings because that is what the store returns over REST, and
 * because a tool result is read by a language model rather than by arithmetic.
 */
export interface EntityRows {
  entity: string;
  fields: string[];
  /** `null` where the column is NULL: a CAST of NULL is still NULL. */
  rows: Array<Array<string|null>>;
  /** True when the row cap cut the answer short, so a caller can narrow it. */
  truncated: boolean;
  /** Set instead of rows when the entity cannot be read, saying why. */
  problem?: string;
}


/** One lookup tool, derived from one entity and its binding. */
export interface EntityTool {
  name: string;
  entityName: string;
  description: string;
  /** One optional exact-match filter per bound field. */
  parameters: ToolParameter[];
  /**
   * Whether calling this would reach the store, on the same terms as
   * `ActionTool.runnable`: false when the answer is already in the model, so
   * that an adapter can decline to offer a tool that returns a problem however
   * it is called. `invoke` still works and still reports the problem.
   */
  runnable: boolean;
  /** Why `runnable` is false, in words a caller can report. */
  unavailable?: string;
  invoke(args: Record<string, unknown>): Promise<EntityRows>;
}


export interface EntityToolOptions {
  /** The model to derive lookups from, and the store they would read. */
  runtime: SemanticRuntime;
  /** Most rows one call returns. Defaults to 50. */
  rowLimit?: number;
}


const DEFAULT_ROW_LIMIT = 50;


/**
 * One lookup tool per entity the model declares, in declaration order.
 *
 * What these tools can express is deliberately narrow: exact match on any
 * bound field, combined with AND, capped at `rowLimit` rows. No joins, no
 * ranges, no aggregation and no ordering. That is enough for an agent to find
 * the object an action needs, which is the job here, and it keeps the derived
 * SQL something a reader can check by eye. A model that needs richer questions
 * answered wants a metric or a query surface declared in the model, rather
 * than a more clever generator over this one.
 *
 * Table and column names come from the model's binding, never from an
 * argument; filter values are bound parameters. So no caller-supplied text
 * reaches the SQL text.
 */
export function entityTools(opts: EntityToolOptions): EntityTool[] {
  return (opts.runtime.model.entities ?? [])
      .map(entity => lookupFor(entity, opts));
}


/** Everything a model offers an agent, in one name space. */
export interface ModelTools {
  /** One lookup per entity: how the agent finds the object to act on. */
  lookups: EntityTool[];
  /** One write per action. */
  actions: ActionTool[];
  /**
   * What to tell an agent holding these tools: the model's own
   * `ai_context.instructions` followed by how the tools are meant to be used.
   */
  instruction: string;
}


/**
 * Every tool a model offers, with the names guaranteed distinct.
 *
 * `actionTools` and `entityTools` each name their own tools, and neither can
 * see the other -- so a model with an entity `Account` and an action
 * `FindAccount` derives two tools called `find_account`. An adapter registering
 * both either errors or silently keeps one, and which one it keeps is the
 * framework's business rather than the model's. Deriving them together is the
 * only place that can be noticed, so it is the place that settles it.
 *
 * An action's tool name is the author's own -- the action is called that in the
 * model, in the catalog and on the command line -- so it keeps it, and a lookup
 * that wanted the same name takes its longer form instead.
 */
export function modelTools(opts: ActionToolOptions&EntityToolOptions):
    ModelTools {
  const actions = actionTools(opts);
  const lookups = entityTools(opts);

  const taken = new Set<string>();
  for (const tool of actions) {
    // Two actions can still collide with each other -- `IssueCredit` and
    // `issue-credit` snake-case alike -- and there is no principled winner
    // between two author names, so the later one is numbered.
    tool.name = distinct(tool.name, taken);
  }
  for (const tool of lookups) {
    tool.name = taken.has(tool.name) ?
        distinct(`lookup_${snakeCase(tool.entityName)}`, taken) :
        distinct(tool.name, taken);
  }
  return {lookups, actions, instruction: instructionFor(opts.runtime.model)};
}


/** A tool derived from a model, whichever half it came from. */
export type DerivedTool = EntityTool|ActionTool;


/** Derived tools sorted by whether this binding can serve them. */
export interface CallableTools {
  /** The ones a call would actually reach the store through. */
  callable: DerivedTool[];
  /** The rest. Each carries `unavailable`, saying why. */
  withheld: DerivedTool[];
  /** `ModelTools.instruction`, carried through unchanged. */
  instruction: string;
}


/**
 * Sort the derived tools into the ones this binding can serve and the ones it
 * cannot.
 *
 * Every adapter has to make this split, and it is the same split every time. A
 * tool the runtime cannot run is still declared, still published and still
 * worth naming -- but offering it as callable spends a turn on a call that
 * cannot succeed and teaches the agent nothing it can act on. Lookups and
 * actions answer `runnable` on the same terms, so they are sorted together
 * rather than twice, and they keep the order `modelTools` gave them.
 *
 * What to do about `withheld` stays the caller's: print it, log it, refuse to
 * start. Dropping it in silence is the one thing this does not make easy.
 */
export function callableTools(tools: ModelTools): CallableTools {
  const derived: DerivedTool[] = [...tools.lookups, ...tools.actions];
  return {
    callable: derived.filter(tool => tool.runnable),
    withheld: derived.filter(tool => !tool.runnable),
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
// The second part is about the tools rather than the business -- what a lookup
// is for, and what a refused write means. That half is owed by whoever derived
// the tools, because it describes a contract this file defines and the model
// never stated. Written into each agent instead, it is the same paragraph
// copied into every adapter, drifting in each one.
//
// So neither half is the agent's to write, and an agent that appends its own
// is saying something the model did not.
function instructionFor(model: SemanticModel): string {
  const parts: string[] = [];
  const stated = model.aiContext?.instructions?.trim();
  if (stated) parts.push(stated);
  parts.push(
      'Never invent an identifier. When you are given a name or a ' +
      'description instead of one, find it with the lookup tools rather than ' +
      'asking for it -- that is what they are for, and asking wastes the ' +
      'caller\'s time. Never compute a total or a balance yourself; the ' +
      'tools do that. When a tool reports that a write did not happen, read ' +
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


function lookupFor(entity: Entity, opts: EntityToolOptions): EntityTool {
  const bound = boundFields(entity);
  const unavailable = whyUnreadable(entity, bound) ?? noStore(opts.runtime);
  return {
    name: `find_${snakeCase(entity.name)}`,
    entityName: entity.name,
    description: lookupDescription(entity, bound),
    runnable: !unavailable,
    ...(unavailable ? {unavailable} : {}),
    parameters: bound.map(f => ({
                            name: f.name,
                            type: jsonType(f.type),
                            description: filterDescription(entity, f),
                            required: false,
                          })),
    async invoke(args: Record<string, unknown>): Promise<EntityRows> {
      return await runLookup(entity, bound, args, opts);
    },
  };
}


// Why nothing derived from this runtime can be called, or null when it can
// be. Both halves of a runtime are needed to make a call: a model says what to
// do and a store is where it happens, and a runtime carrying only the first is
// a model an agent can read about but not use.
function noStore(runtime: SemanticRuntime): string|null {
  const client = runtimeClient(runtime);
  return 'error' in client ? client.error : null;
}


// Why no call to this entity's lookup could return rows, or null if one
// could. Every answer is in the model, which is what makes it answerable
// before the tool is offered rather than after a caller has spent a turn on
// it -- the same bargain `ActionTool.runnable` strikes on the write side.
// `runLookup` asks these again where it would read, because that is where the
// failure has to be reported; here they decide whether to bother the caller.
function whyUnreadable(entity: Entity, bound: BoundField[]): string|null {
  if (entity.abstract) {
    return `${entity.name} is abstract: it groups its subtypes and has no ` +
        `table of its own. Look up one of the subtypes instead.`;
  }
  if (!bound.length) {
    return `No field of ${entity.name} is bound to a plain column, so there ` +
        `is nothing to read. Push the model with a binding profile.`;
  }
  const warnings: string[] = [];
  spannerTable(entity.dataSource, warnings, `entity '${entity.name}'`);
  return warnings.length ? warnings.join('; ') : null;
}


// A field is readable when the profile bound it to a plain column. One bound
// to an expression is skipped rather than guessed at, and an entity with no
// plain-column fields yields a tool that reports the problem when called.
//
// Exported because judge_store.ts needs the same answer. Two readers deciding
// separately what counts as readable is how a judge comes to be shown a column
// the lookup tool will not return.
export interface BoundField {
  name: string;
  type: string;
  column: string;
  /** What the model says this field holds, if it says anything. */
  description?: string;
}


export function boundFields(entity: Entity): BoundField[] {
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


// What the model says the field holds, then how the filter treats it. The
// first half is the only written-down source for the values a coded field
// accepts, so a caller that does not get it has to guess one and spend a turn
// learning it was wrong.
function filterDescription(entity: Entity, field: BoundField): string {
  const match = `Match ${entity.name}.${
      field.name} exactly. Omit to leave it unfiltered.`;
  return field.description ? `${field.description} ${match}` : match;
}


function lookupDescription(entity: Entity, bound: BoundField[]): string {
  const parts: string[] = [];
  parts.push(entity.description?.trim() || `Look up ${entity.name} records.`);
  if (bound.length) {
    parts.push(
        `Returns ${bound.map(f => f.name).join(', ')}. Every argument is an ` +
        `exact match and every one is optional; giving none returns the ` +
        `first rows. This tool cannot join, compare ranges, or total ` +
        `anything.`);
  }
  const instructions = entity.aiContext?.instructions?.trim();
  if (instructions) parts.push(instructions);
  return parts.join('\n\n');
}


async function runLookup(
    entity: Entity, bound: BoundField[], args: Record<string, unknown>,
    opts: EntityToolOptions): Promise<EntityRows> {
  const empty = {entity: entity.name, fields: [], rows: [], truncated: false};
  // Asked of the same function the tool's `unavailable` was asked of, so the
  // reason a call reports and the reason the tool advertises are one text.
  const unreadable = whyUnreadable(entity, bound);
  if (unreadable) return {...empty, problem: unreadable};

  // Written for whichever store this runtime is bound to. The shape of the
  // statement is the same either way; what differs is how a name is quoted
  // and how a column is rendered as text.
  const dialect = dialectFor(opts.runtime.store);
  const warnings: string[] = [];
  const table = boundTable(
      entity.dataSource, warnings, `entity '${entity.name}'`, dialect.quote);

  // Only field names the model declares reach the SQL, and every value is
  // bound. An argument naming an unknown field is a caller error worth
  // reporting rather than ignoring.
  const predicates: string[] = [];
  const params: Record<string, unknown> = {};
  const paramTypes: Record<string, {code: string}> = {};
  for (const [name, value] of Object.entries(args)) {
    // Absent means unfiltered; empty means the empty string. `bindScalar`
    // draws the line in the same place for the write path, and a caller that
    // sends '' for an unset filter gets no rows rather than the first fifty
    // of the table read back as though they matched.
    if (value === undefined || value === null) continue;
    const field = bound.find(f => f.name === name);
    if (!field) {
      return {
        ...empty,
        problem: `${entity.name} has no readable field '${name}'. It has ${
            bound.map(f => f.name).join(', ')}.`,
      };
    }
    // Compared as ITSELF, against the input parsed to the type the field
    // declares -- the same discipline resolveEntityRef follows, for the same
    // reason. `CAST(col AS STRING) = @f` would let one predicate shape serve
    // every column type, and no index can answer it: a lookup on a primary key
    // would scan the table.
    const value_ = bindScalar({name: field.name, type: field.type}, value);
    if ('error' in value_) {
      return {
        ...empty,
        problem:
            `${value_.error} No ${entity.name} has ${field.name} = '${value}'.`,
      };
    }
    const bind = `f_${predicates.length}`;
    predicates.push(`${dialect.quote(field.column)} = @${bind}`);
    params[bind] = value_.value;
    paramTypes[bind] = {code: value_.code};
  }

  const limit = opts.rowLimit ?? DEFAULT_ROW_LIMIT;
  const columns =
      bound.map(f => dialect.castToText(dialect.quote(f.column))).join(', ');
  const where = predicates.length ? ` WHERE ${predicates.join(' AND ')}` : '';
  // One row over the cap, so "there are more" can be told from "that is all".
  const sql = `SELECT ${columns} FROM ${table}${where} LIMIT ${limit + 1}`;

  // An unbound entity, a bad source and an unknown filter all come back as a
  // `problem` the caller can read out. A store that refuses the read -- no
  // permission, no such table, no session to be had -- is not a different kind
  // of thing, and throwing would reach an adapter as a crashed tool call
  // rather than as something the agent can report and work around.
  const client = runtimeClient(opts.runtime);
  if ('error' in client) return {...empty, problem: client.error};

  let rows: Array<Array<string|null>>;
  try {
    rows = await client.withSession(async sessionName => {
      const res =
          await client.executeQuery(sessionName, {sql, params, paramTypes});
      if (res.status < 200 || res.status >= 300) {
        throw new Error(res.message ?? `${res.status}`);
      }
      return res.result?.rows ?? [];
    });
  } catch (err) {
    return {
      ...empty,
      problem: `Could not read ${entity.name}: ${
          err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    entity: entity.name,
    fields: bound.map(f => f.name),
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}
