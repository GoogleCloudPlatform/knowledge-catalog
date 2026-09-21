/**
 * Deriving action tools and schema metadata for a bound semantic model.
 *
 * An action declares a name, a description of what it does, its typed
 * parameters, the guidance an AI caller should follow
 * (`ai_context.instructions`), and the rules that gate it (`guards`). This
 * module resolves those declarations against the active binding profile so
 * `kcmd skills-generate` can render the model as an Agent Skill.
 */

import {boundTable} from '../binding';
import {Action, ActionParameter, Entity, fieldBinding, SemanticModel} from '../ir';

import {SqlDialect} from './dialect';
import {runtimeStoreError, SemanticRuntime} from './runtime';


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
   * required unless declared `required: false` or given a `default`.
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
  parameters: ToolParameter[];
  /**
   * Whether this action can run under the active binding profile. False when
   * the profile supplies no executor, when a `sql` executor has no operational
   * store, or when the action names a guard that is undeclared or states no
   * rule text.
   */
  runnable: boolean;
  /** Why `runnable` is false, in words a caller can report. */
  unavailable?: string;
}


export interface ActionToolOptions {
  /** The model to derive tools from, and the store they would run against. */
  runtime: SemanticRuntime;
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
  const blocked = whyRefusedWithoutRunning(opts.runtime, action) ?? undefined;
  const tool: ActionTool = {
    name: snakeCase(action.name),
    actionName: action.name,
    parameters: action.parameters.map(toolParameter),
    runnable: !blocked,
  };
  if (blocked) tool.unavailable = blocked;
  return tool;
}


function whyRefusedWithoutRunning(
    runtime: SemanticRuntime, action: Action): string|null {
  const model = runtime.model;
  const executor = action.executor;
  if (!executor) {
    return `Action '${action.name}' has no executor under this binding, so ` +
        `there is nothing to run. An executor is a physical binding: a ` +
        `profile supplies one, and a profile that writes 'executor: null' ` +
        `withdraws it. The action is still declared and still published; it ` +
        `is only not performable here, and is performed somewhere else.`;
  }
  const advisory = new Set((model.constraints ?? [])
                               .filter(c => c.onViolation === 'warn')
                               .map(c => c.name));
  const guards = (action.guards ?? []).filter(g => !advisory.has(g));
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
  const declared = new Set((model.constraints ?? []).map(c => c.name));
  const undeclared = guards.filter(g => !declared.has(g));
  if (undeclared.length) {
    return `Action '${action.name}' is guarded by ${quoteList(undeclared)}, ` +
        `which ${undeclared.length === 1 ? 'is' : 'are'} not declared by ` +
        `model '${
               model.name}'. Running it would apply a write the model says ` +
        `must be checked first, so it is refused rather than run unchecked.`;
  }
  if (executor.kind === 'sql') {
    return runtimeStoreError(runtime);
  }
  return null;
}


function quoteList(names: readonly string[]): string {
  const quoted = names.map(n => `'${n}'`);
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}


function isParameterRequired(param: ActionParameter): boolean {
  if (param.default !== undefined) return false;
  return param.required !== false;
}


function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}


function toolParameter(param: ActionParameter): ToolParameter {
  const said = param.description?.trim();
  const guidance = scalarFormatGuidance(param.type);
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


function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/[\s-]+/g, '_')
      .toLowerCase();
}


/** Everything a model offers an agent, in one name space. */
export interface ModelTools {
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
 */
export function modelTools(opts: ActionToolOptions): ModelTools {
  const actions = actionTools(opts);
  const taken = new Set<string>();
  for (const tool of actions) {
    tool.name = distinct(tool.name, taken);
  }
  return {
    actions,
    instruction: instructionFor(opts.runtime.model),
  };
}


function instructionFor(model: SemanticModel): string {
  const parts: string[] = [];
  const stated = model.aiContext?.instructions?.trim();
  if (stated) parts.push(stated);
  parts.push(
      'Never invent an identifier. When you are given a name or a ' +
      'description where an action wants a key, ask the caller or read the ' +
      'store directly. Check every rule that gates an action before running ' +
      'it: when a rule says a write must not happen, refuse and explain why; ' +
      'when it says a person has to decide, say so and stop, because you ' +
      'cannot approve it yourself; when an advisory rule goes unmet, report ' +
      'both the change and the warning. Finish by saying what you changed.');
  return parts.join('\n\n');
}


function distinct(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  taken.add(name);
  return name;
}


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
