// Merges a logical semantic model with a chosen binding profile, and prunes what
// the resulting binding cannot answer.
//
// A model is authored as ONE logical declaration (entities, fields,
// relationships, metrics, the grain, and the graph shape) plus zero or more
// BINDING PROFILES that supply the physical facets it leaves open: each entity's
// `source`, each field's column (`expression`), each action's `executor`, and
// the deployment target.
// `kcmd push --profile <name>` merges the selected profile onto the logical
// model BY NAME and deploys the result. See docs/semantic-model/profiles.md.
//
// Two passes live here:
//   - mergeProfile overlays one profile document onto the logical document,
//     enforcing the binding-only contract: a profile rebinds what it names,
//     leaves everything else as the model file has it, may exclude fields and
//     metrics, and may not add elements or change what anything means. It runs
//     on the parsed authoring documents (the readable, sugared form) before
//     schema validation, so a profile is written in the same syntax as the
//     model.
//   - pruneUnavailable runs over the loaded IR and drops each field left unbound
//     plus every metric whose expression reads one, returning the pruned model
//     and a per-profile availability report. Keys and join columns are physical
//     columns rather than fields, so pruning fields never removes an entity or
//     a relationship.

import * as yaml from 'yaml';

import {Action, isFieldBound, Metric, Relationship, SemanticModel} from './ir';
import {blankStringLiterals, escapeRegExp, referencedEntityNames,} from './sql_expr_utils';

// The implicit profile: the inline bindings already in the model document (the
// combined single-file form). It is never merged -- it IS the document as
// authored -- so a bare `kcmd push` behaves as it always has.
export const DEFAULT_PROFILE = 'default';

export interface MergeResult {
  // The merged authoring document (still in the sugared form), ready to feed
  // through the normal loader.
  doc: unknown;
  warnings: string[];
  // A binding-only or unknown-name violation, naming the offending path. When
  // set, `doc` should not be deployed.
  error?: string;
}

// Keys a profile may carry at each level. Everything else is a logical
// declaration the model owns; setting it in a profile is rejected so swapping a
// profile can move data but never change what the model means.
//
// A profile file is a top-level profile object (`name`, `entities`, ...). The
// older form, a `semantic_model:` wrapper around partial models, is still
// accepted until the fixture migration moves the repo's own files over; the
// LEGACY_* sets describe it.
const PROFILE_FILE_KEYS = new Set([
  'name', 'entities', 'relationships', 'metrics_exclude', 'actions',
]);
const PROFILE_ENTITY_KEYS = new Set([
  'name', 'source', 'primary_key', 'unique_keys', 'fields', 'fields_exclude',
]);
const PROFILE_RELATIONSHIP_KEYS = new Set(['name', 'from_columns', 'to_columns']);
const PROFILE_FIELD_KEYS = new Set(['name', 'expression']);
const PROFILE_ACTION_KEYS = new Set(['name', 'executor']);
const LEGACY_MODEL_KEYS = new Set([
  'name', 'version', 'deployment_target', 'entities', 'datasets', 'actions',
]);
const LEGACY_ENTITY_KEYS = new Set(['name', 'source', 'fields', 'fields_exclude']);

/**
 * Overlays `profileDoc` onto `logicalDoc` and returns the merged document. The
 * inputs are never mutated. A profile is an overlay: it rebinds what it names
 * and leaves everything else as the model file has it. It supplies physical
 * bindings only; a violation of that contract (setting a declaration, or naming
 * an element the logical model does not declare) is returned as `error`,
 * naming the path.
 */
export function mergeProfile(
    logicalDoc: unknown, profileDoc: unknown,
    profileName: string): MergeResult {
  const warnings: string[] = [];
  const merged = structuredClone(logicalDoc) as any;
  const profile = profileDoc as any;

  if (!merged || typeof merged !== 'object' ||
      !Array.isArray(merged.semantic_model)) {
    return {
      doc: merged, warnings,
      error: 'the logical model is not a semantic_model document',
    };
  }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return {
      doc: merged, warnings,
      error: `profile '${profileName}' is not a profile document`,
    };
  }

  const logicalByName = new Map<string, any>();
  for (const m of merged.semantic_model) {
    if (m && typeof m === 'object' && typeof m.name === 'string') {
      logicalByName.set(m.name, m);
    }
  }

  // The models this profile binds. A profile file belongs to the one model it
  // sits beside; the legacy wrapper names its models.
  const legacy = Array.isArray(profile.semantic_model);
  let targets: Array<{lm: any; pm: any}>;
  if (legacy) {
    targets = [];
    for (const pm of profile.semantic_model) {
      if (!pm || typeof pm !== 'object') continue;
      const lm = logicalByName.get(pm.name);
      if (!lm) {
        return {
          doc: merged, warnings,
          error: `profile '${profileName}': model '${
              pm.name}' is not in the logical model`,
        };
      }
      targets.push({lm, pm});
    }
  } else {
    if (logicalByName.size !== 1) {
      return {
        doc: merged, warnings,
        error: `profile '${profileName}' binds one model, but the logical ` +
            `document declares ${logicalByName.size}`,
      };
    }
    targets = [{lm: [...logicalByName.values()][0], pm: profile}];
  }

  const sqlInLogical = findLogicalSqlExecutor(targets.map(t => t.lm));
  if (sqlInLogical) {
    return {
      doc: merged, warnings,
      error: `profile '${profileName}': action '${sqlInLogical.action}' in ` +
          `model '${sqlInLogical.model}' declares a 'sql' executor. A ` +
          `statement names one database's own tables and columns, so it ` +
          `belongs in the profile that binds them, not in the model. Move ` +
          `the executor into each profile that performs this write as DML.`,
    };
  }

  for (const {lm, pm} of targets) {
    const err = legacy ? mergeLegacyModel(lm, pm, profileName) :
                         mergeProfileFile(lm, pm, profileName);
    if (err) return {doc: merged, warnings, error: err};
  }
  return {doc: merged, warnings};
}

// Overlays a top-level profile object onto the one model it binds.
function mergeProfileFile(lm: any, pf: any, profileName: string): string|
    undefined {
  for (const k of Object.keys(pf)) {
    if (!PROFILE_FILE_KEYS.has(k)) {
      return declError(profileName, `the profile`, k);
    }
  }
  const err = mergeActions(lm, pf.actions, profileName) ??
      mergeEntities(lm, pf.entities, PROFILE_ENTITY_KEYS, profileName) ??
      mergeRelationships(lm, pf.relationships, profileName) ??
      excludeMetrics(lm, pf.metrics_exclude, profileName);
  return err;
}

// Overlays one partial model from the legacy `semantic_model:` wrapper.
function mergeLegacyModel(lm: any, pm: any, profileName: string): string|
    undefined {
  for (const k of Object.keys(pm)) {
    if (!LEGACY_MODEL_KEYS.has(k)) {
      return declError(profileName, `model '${pm.name}'`, k);
    }
  }
  if (pm.deployment_target !== undefined) {
    lm.deployment_target = pm.deployment_target;
  }
  return mergeActions(lm, pm.actions, profileName) ??
      mergeEntities(
             lm, pm.entities ?? pm.datasets, LEGACY_ENTITY_KEYS, profileName);
}

function mergeActions(lm: any, actions: unknown, profileName: string): string|
    undefined {
  if (actions === undefined) return undefined;
  if (!Array.isArray(actions)) {
    return `profile '${profileName}': 'actions' must be a list`;
  }
  const lActions = indexByName(lm.actions);
  for (const pa of actions) {
    if (!pa || typeof pa !== 'object') continue;
    const la = lActions.get(pa.name);
    if (!la) {
      return `profile '${profileName}': action '${
          pa.name}' is not in the logical model`;
    }
    const err = mergeAction(la, pa, profileName);
    if (err) return err;
  }
  return undefined;
}

function mergeEntities(
    lm: any, entities: unknown, allowed: Set<string>,
    profileName: string): string|undefined {
  if (entities === undefined) return undefined;
  if (!Array.isArray(entities)) {
    return `profile '${profileName}': 'entities' must be a list`;
  }
  const lByName = indexByName(lm.entities ?? lm.datasets);
  for (const pe of entities) {
    if (!pe || typeof pe !== 'object') continue;
    const le = lByName.get(pe.name);
    if (!le) {
      return `profile '${profileName}': entity '${
          pe.name}' is not in the logical model`;
    }
    const err = mergeEntity(le, pe, allowed, profileName);
    if (err) return err;
  }
  return undefined;
}

// Overlays one action's binding. Unlike a field's column, an executor is
// INHERITED when the profile says nothing: an action the profile does not
// mention keeps whatever the model declared, so a model can state one default
// executor and a profile override only the stores that perform the write
// differently.
//
// Withdrawing an inherited executor is therefore explicit: `executor: null`
// says this store performs the write by no means at all, which leaves the
// action declared and unavailable here.
function mergeAction(la: any, pa: any, profileName: string): string|undefined {
  for (const k of Object.keys(pa)) {
    if (!PROFILE_ACTION_KEYS.has(k)) {
      return declError(profileName, `action '${pa.name}'`, k);
    }
  }
  if (pa.executor === null) {
    delete la.executor;
  } else if (pa.executor !== undefined) {
    la.executor = pa.executor;
  }
  return undefined;
}

// Overlays one entity's bindings. A field the profile names in `fields` is
// rebound; one it names in `fields_exclude` has its binding cleared, so
// pruneUnavailable drops it; every other field keeps what the model file gave
// it.
function mergeEntity(
    le: any, pe: any, allowed: Set<string>, profileName: string): string|
    undefined {
  for (const k of Object.keys(pe)) {
    if (!allowed.has(k)) {
      return declError(profileName, `entity '${pe.name}'`, k);
    }
  }
  if (pe.source !== undefined) le.source = pe.source;
  if (pe.primary_key !== undefined) le.primary_key = pe.primary_key;
  if (pe.unique_keys !== undefined) le.unique_keys = pe.unique_keys;

  for (const key of ['fields', 'fields_exclude']) {
    if (pe[key] !== undefined && !Array.isArray(pe[key])) {
      return `profile '${profileName}': entity '${pe.name}' '${
          key}' must be a list`;
    }
  }
  const lByName = indexByName(le.fields ?? []);
  const rebound = new Set<string>();
  for (const pf of pe.fields ?? []) {
    if (!pf || typeof pf !== 'object') continue;
    const lf = lByName.get(pf.name);
    if (!lf) {
      return `profile '${profileName}': field '${pe.name}.${
          pf.name}' is not in the logical model`;
    }
    const err = mergeField(lf, pf, pe.name, profileName);
    if (err) return err;
    rebound.add(pf.name);
  }
  for (const name of pe.fields_exclude ?? []) {
    const lf = lByName.get(name);
    if (!lf) {
      return `profile '${profileName}': field '${pe.name}.${
          name}' in 'fields_exclude' is not in the logical model`;
    }
    if (rebound.has(name)) {
      return `profile '${profileName}': field '${pe.name}.${
          name}' is in both 'fields' and 'fields_exclude'`;
    }
    delete lf.expression;
  }
  return undefined;
}

// Overlays a field's binding. The expression may be anything a model field's
// expression may be -- a column, a computation, or the `dialects:` form.
function mergeField(lf: any, pf: any, entityName: string, profileName: string):
    string|undefined {
  for (const k of Object.keys(pf)) {
    if (!PROFILE_FIELD_KEYS.has(k)) {
      return declError(profileName, `field '${entityName}.${pf.name}'`, k);
    }
  }
  if (pf.expression !== undefined) lf.expression = pf.expression;
  return undefined;
}

// Overlays relationships' join columns, by relationship name.
function mergeRelationships(
    lm: any, relationships: unknown, profileName: string): string|undefined {
  if (relationships === undefined) return undefined;
  if (!Array.isArray(relationships)) {
    return `profile '${profileName}': 'relationships' must be a list`;
  }
  const lByName = indexByName(lm.relationships);
  for (const pr of relationships) {
    if (!pr || typeof pr !== 'object') continue;
    const lr = lByName.get(pr.name);
    if (!lr) {
      return `profile '${profileName}': relationship '${
          pr.name}' is not in the logical model`;
    }
    for (const k of Object.keys(pr)) {
      if (!PROFILE_RELATIONSHIP_KEYS.has(k)) {
        return declError(profileName, `relationship '${pr.name}'`, k);
      }
    }
    if (pr.from_columns !== undefined) lr.from_columns = pr.from_columns;
    if (pr.to_columns !== undefined) lr.to_columns = pr.to_columns;
  }
  return undefined;
}

// Removes the metrics a profile excludes: `"*"` for every metric, now and
// later, or a list of metric names.
function excludeMetrics(lm: any, exclude: unknown, profileName: string):
    string|undefined {
  if (exclude === undefined) return undefined;
  if (exclude === '*') {
    lm.metrics = [];
    return undefined;
  }
  if (!Array.isArray(exclude)) {
    return `profile '${profileName}': 'metrics_exclude' must be "*" or a ` +
        `list of metric names`;
  }
  const known = indexByName(lm.metrics);
  for (const name of exclude) {
    if (name === '*') {
      return `profile '${profileName}': 'metrics_exclude' takes "*" on its ` +
          `own, not inside a list`;
    }
    if (!known.has(name)) {
      return `profile '${profileName}': metric '${
          name}' in 'metrics_exclude' is not in the logical model`;
    }
  }
  const excluded = new Set(exclude as string[]);
  lm.metrics = (lm.metrics ?? []).filter((m: any) => !excluded.has(m?.name));
  return undefined;
}

function declError(profileName: string, where: string, key: string): string {
  return `profile '${profileName}': ${where} sets '${key}', which a profile ` +
      `may not set; a profile carries only physical bindings, and the ` +
      `logical model owns everything else`;
}

function indexByName(list: unknown): Map<string, any> {
  const m = new Map<string, any>();
  if (Array.isArray(list)) {
    for (const item of list) {
      if (item && typeof item === 'object' && typeof item.name === 'string') {
        m.set(item.name, item);
      }
    }
  }
  return m;
}

// A `sql` executor carries the write itself, in the bound store's table and
// column names and its dialect, so it is physical in the way a field's
// `expression` is, and a model a profile binds must leave it to the profile.
// Scoped to the models the profile binds: a model the profile does not name
// keeps its inline statements, written against its inline bindings.
function findLogicalSqlExecutor(models: any[]):
    {model: string; action: string}|undefined {
  for (const m of models) {
    for (const a of m.actions ?? []) {
      if (a && typeof a === 'object' && a.executor &&
          typeof a.executor === 'object' && a.executor.sql !== undefined) {
        return {model: m.name, action: String(a.name)};
      }
    }
  }
  return undefined;
}


// One profile's availability outcome: the fields it leaves unbound, and the
// building blocks that fall with them.
export interface AvailabilityReport {
  profile: string;
  unboundFields: string[];  // "Entity.field"
  // No pruning rule drops an entity or a relationship today (see the file
  // header); both lists stay for the callers that report them.
  droppedEntities: {name: string; reason: string}[];
  droppedMetrics: {name: string; reason: string}[];
  droppedRelationships: {name: string; reason: string}[];
  // An action this profile cannot perform: it binds no executor for it.
  droppedActions: {name: string; reason: string}[];
}

/**
 * Returns a clone of `model` reduced to what `profileName` can answer: unbound
 * fields removed from their entities, every metric that depends on one dropped,
 * and every action with no executor dropped. The input is never mutated. The report
 * names each dropped block and the unbound field that stops it, so a caller can
 * state the withheld coverage. A model with nothing unbound resolves unchanged.
 */
export function pruneUnavailable(model: SemanticModel, profileName: string):
    {model: SemanticModel; report: AvailabilityReport} {
  const clone: SemanticModel = structuredClone(model);
  const report: AvailabilityReport = {
    profile: profileName,
    unboundFields: [],
    droppedEntities: [],
    droppedMetrics: [],
    droppedRelationships: [],
    droppedActions: [],
  };

  // A field is bound when isFieldBound says so; otherwise it is unbound
  // (structurally absent under this profile). isFieldBound is the shared
  // predicate the generator also uses, so a field awaiting transpilation (its
  // column carried on the imported expression) counts as bound, not dropped.
  const unbound = new Set<string>();
  for (const e of clone.entities ?? []) {
    // An abstract entity has no table and no bindings by design: it survives
    // only as a label on its subtypes (which bind its inherited fields on their
    // own tables). Its fields are legitimately column-less, so they are not
    // "unbound" in the pruning sense -- skip them so the entity is not dropped
    // and its field names remain to define the shared label's signature.
    if (e.abstract) continue;
    for (const f of e.fields ?? []) {
      if (!isFieldBound(f)) unbound.add(`${e.name}.${f.name}`);
    }
  }
  report.unboundFields = [...unbound];

  // Keys and join columns are physical column names, not fields, so whether a
  // field is bound says nothing about them. Excluding a field that happens to
  // share a key column's name drops the field and nothing else.
  const allEntityNames = (clone.entities ?? []).map(e => e.name);

  // Drop unbound fields. (A bound field whose value is null still emits a
  // column -- unbound is not null.)
  for (const e of clone.entities ?? []) {
    // Keep an abstract entity's fields intact: they are column-less by design
    // and name the shared label's property set for the emitter (see above).
    if (e.abstract) continue;
    e.fields = (e.fields ?? []).filter(isFieldBound);
  }

  // A relationship's join columns are its own binding, so pruning fields never
  // removes one.
  const keptRels: Relationship[] = clone.relationships ?? [];

  // A metric is available only when every field it references is bound and --
  // when it spans entities -- a relationship connects them.
  const keptMetrics: Metric[] = [];
  for (const mt of clone.metrics ?? []) {
    const expr = mt.expression ?? '';
    const refs = referencedEntityNames(expr, allEntityNames);
    const hit = firstUnboundReferenced(expr, unbound);
    if (hit) {
      report.droppedMetrics.push(
          {name: mt.name, reason: `field ${hit} is unbound`});
      continue;
    }
    if (refs.length > 1 && !connectingRelationshipKept(refs, keptRels)) {
      report.droppedMetrics.push({
        name: mt.name,
        reason: `no available relationship connects ${refs.join(', ')}`,
      });
      continue;
    }
    keptMetrics.push(mt);
  }
  clone.metrics = keptMetrics;

  // An action is available only where a binding performs it. The executor is
  // the action's binding, so an action without one is unavailable for the same
  // reason a column-less field is: it is declared, and there is nothing here to
  // carry it out.
  const keptActions: Action[] = [];
  for (const a of clone.actions ?? []) {
    if (a.executor === undefined) {
      report.droppedActions.push(
          {name: a.name, reason: 'no executor is bound under this profile'});
      continue;
    }
    keptActions.push(a);
  }
  clone.actions = keptActions;

  return {model: clone, report};
}

// The first unbound "Entity.field" a metric expression references (qualified),
// or null. Text inside string literals is ignored.
function firstUnboundReferenced(expr: string, unbound: Set<string>): string|
    null {
  const scannable = blankStringLiterals(expr);
  for (const key of unbound) {
    const dot = key.indexOf('.');
    const entity = key.slice(0, dot);
    const field = key.slice(dot + 1);
    const re = new RegExp(`(?<![\\w\`])\`?${escapeRegExp(entity)}\`?\\.\`?${
        escapeRegExp(field)}\`?(?![\\w])`);
    if (re.test(scannable)) return key;
  }
  return null;
}

// Whether any relationship directly connects two of the referenced entities --
// the minimal check that a cross-entity metric has a join path.
function connectingRelationshipKept(
    refEntities: string[], kept: Relationship[]): boolean {
  const set = new Set(refEntities);
  return kept.some(
      r => set.has(r.source.entity) && set.has(r.destination.entity));
}


/**
 * Parses a logical model document and a binding profile document, merges the
 * profile onto the model by name, and returns the merged authoring text plus
 * any merge warnings. Shared by every path that reads a profile -- push,
 * `profiles`, and creating a runtime -- so the three parse, merge, warn and
 * fail identically; on a parse error or a binding-contract violation it
 * returns `error` for the caller to surface.
 */
export function mergeProfileOntoDoc(
    logicalText: string, profileText: string,
    profileName: string): {text: string; warnings: string[]}|{
  error: string
}
{
  let logicalDoc: unknown;
  let profileDoc: unknown;
  try {
    logicalDoc = yaml.parse(logicalText);
    profileDoc = yaml.parse(profileText);
  } catch (err: any) {
    return {
      error: `could not parse the model or profile '${profileName}': ${
          err?.message ?? err}`,
    };
  }
  const merged = mergeProfile(logicalDoc, profileDoc, profileName);
  if (merged.error) return {error: merged.error};
  return {text: yaml.stringify(merged.doc), warnings: merged.warnings};
}
