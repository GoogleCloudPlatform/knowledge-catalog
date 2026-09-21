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
//     enforcing the binding-only contract: a profile may set physical facets and
//     may leave a field unbound, but it may not add or remove elements or change
//     what anything means. It runs on the parsed authoring documents (the
//     readable, sugared form) before schema validation, so a profile is written
//     in the same syntax as the model.
//   - pruneUnavailable runs over the loaded IR and drops each field left unbound
//     plus everything that depends on it -- a metric whose expression reads it, a
//     relationship whose join column is unbound, a cross-entity metric over a
//     dropped relationship -- returning the pruned model and a per-profile
//     availability report. Availability propagates UP the dependency graph from
//     the fields a profile binds.

import * as yaml from 'yaml';

import {Action, fieldBinding, Metric, Relationship, SemanticModel} from './ir';
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
const PROFILE_MODEL_KEYS = new Set([
  'name', 'version', 'deployment_target', 'entities', 'datasets', 'actions',
]);
const PROFILE_ENTITY_KEYS = new Set(['name', 'source', 'fields']);
const PROFILE_FIELD_KEYS = new Set(['name', 'expression']);
const PROFILE_ACTION_KEYS = new Set(['name', 'executor']);

/**
 * Overlays `profileDoc` onto `logicalDoc`, matching models, entities, fields by
 * `name`, and returns the merged document. The inputs are never mutated. A
 * profile supplies physical bindings only; a violation of that contract (setting
 * a declaration, or naming an element the logical model does not declare) is
 * returned as `error`, naming the path.
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
  if (!profile || typeof profile !== 'object' ||
      !Array.isArray(profile.semantic_model)) {
    return {
      doc: merged, warnings,
      error: `profile '${profileName}' is not a semantic_model document`,
    };
  }

  const logicalByName = new Map<string, any>();
  for (const m of merged.semantic_model) {
    if (m && typeof m === 'object' && typeof m.name === 'string') {
      logicalByName.set(m.name, m);
    }
  }

  // Clear the logical clone's inline field bindings before overlaying the
  // profile, so for the models the profile targets the profile alone decides
  // what is bound (see below). A model the profile does not name keeps its
  // inline bindings untouched.
  const profileModelNames = new Set<string>();
  for (const pm of profile.semantic_model) {
    if (pm && typeof pm === 'object' && typeof pm.name === 'string') {
      profileModelNames.add(pm.name);
    }
  }
  stripInlineFieldExpressions(merged, profileModelNames);

  const sqlInLogical = findLogicalSqlExecutor(merged, profileModelNames);
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
    const err = mergeModel(lm, pm, profileName);
    if (err) return {doc: merged, warnings, error: err};
  }

  return {doc: merged, warnings};
}

function mergeModel(lm: any, pm: any, profileName: string): string|undefined {
  for (const k of Object.keys(pm)) {
    if (!PROFILE_MODEL_KEYS.has(k)) {
      return declError(profileName, `model '${pm.name}'`, k);
    }
  }
  if (pm.deployment_target !== undefined) {
    lm.deployment_target = pm.deployment_target;
  }

  if (pm.actions !== undefined) {
    if (!Array.isArray(pm.actions)) {
      return `profile '${profileName}': 'actions' must be a list`;
    }
    const lActions = indexByName(lm.actions);
    for (const pa of pm.actions) {
      if (!pa || typeof pa !== 'object') continue;
      const la = lActions.get(pa.name);
      if (!la) {
        return `profile '${profileName}': action '${
            pa.name}' is not in the logical model`;
      }
      const err = mergeAction(la, pa, profileName);
      if (err) return err;
    }
  }

  const pEntities = pm.entities ?? pm.datasets;
  if (pEntities === undefined) return undefined;
  if (!Array.isArray(pEntities)) {
    return `profile '${profileName}': 'entities' must be a list`;
  }
  const lByName = indexByName(lm.entities ?? lm.datasets);
  for (const pe of pEntities) {
    if (!pe || typeof pe !== 'object') continue;
    const le = lByName.get(pe.name);
    if (!le) {
      return `profile '${profileName}': entity '${
          pe.name}' is not in the logical model`;
    }
    const err = mergeEntity(le, pe, profileName);
    if (err) return err;
  }
  return undefined;
}

// Overlays one action's binding. Unlike a field's column, an executor is
// INHERITED when the profile says nothing: an action the profile does not
// mention keeps whatever the model declared, so a model can state one default
// executor and a profile override only the stores that perform the write
// differently. A field cannot work that way -- inheriting a column name into a
// renamed schema binds to the wrong column silently -- but an executor names a
// whole mechanism, and a wrong one fails loudly at the first call rather than
// returning another column's data.
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

function mergeEntity(le: any, pe: any, profileName: string): string|undefined {
  for (const k of Object.keys(pe)) {
    if (!PROFILE_ENTITY_KEYS.has(k)) {
      return declError(profileName, `entity '${pe.name}'`, k);
    }
  }
  if (pe.source !== undefined) le.source = pe.source;

  if (pe.fields === undefined) return undefined;
  if (!Array.isArray(pe.fields)) {
    return `profile '${profileName}': entity '${
        pe.name}' 'fields' must be a list`;
  }
  const lByName = indexByName(le.fields ?? []);
  for (const pf of pe.fields) {
    if (!pf || typeof pf !== 'object') continue;
    const lf = lByName.get(pf.name);
    if (!lf) {
      return `profile '${profileName}': field '${pe.name}.${
          pf.name}' is not in the logical model`;
    }
    const err = mergeField(lf, pf, pe.name, profileName);
    if (err) return err;
  }
  return undefined;
}

function mergeField(lf: any, pf: any, entityName: string, profileName: string):
    string|undefined {
  for (const k of Object.keys(pf)) {
    if (!PROFILE_FIELD_KEYS.has(k)) {
      return declError(profileName, `field '${entityName}.${pf.name}'`, k);
    }
  }
  if (pf.expression !== undefined) {
    if (!isBareColumnRef(pf.expression)) {
      return `profile '${profileName}': field '${entityName}.${
          pf.name}' expression must be a bare column reference, not arbitrary ` +
          `SQL; the computation is the logical model's to define`;
    }
    lf.expression = pf.expression;
  }
  // A field the profile does not bind keeps no expression -- unbound under this
  // profile (a field is unbound exactly when it carries no expression).
  return undefined;
}

function declError(profileName: string, where: string, key: string): string {
  return `profile '${profileName}': ${where} sets '${key}', a logical ` +
      `declaration the model owns; a profile may set only physical bindings ` +
      `(source, expression, executor, deployment_target)`;
}

// A profile's field expression must be a BARE column reference (e.g. `c_name`),
// never arbitrary SQL: the computation belongs to the logical model, and only
// the column it reads may vary per profile. Accepts the bare-string form and the
// per-dialect object; rejects any variant that contains whitespace or a call.
function isBareColumnRef(expr: unknown): boolean {
  const parts: string[] = [];
  if (typeof expr === 'string') {
    parts.push(expr);
  } else if (
      expr && typeof expr === 'object' &&
      Array.isArray((expr as any).dialects)) {
    for (const d of (expr as any).dialects) {
      if (d && typeof d.expression === 'string') parts.push(d.expression);
    }
  } else {
    return false;
  }
  if (!parts.length) return false;
  return parts.every(s => !/[\s()]/.test(s.trim()));
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
// `expression` is, and a model a profile names must leave it to the profile.
// Inheriting one would be incoherent, not merely untidy:
// stripInlineFieldExpressions has just cleared this model's inline column
// bindings so the profile alone decides them, while the inherited statements
// would still be written against the columns that were cleared.
//
// Scoped to the models the profile targets, for the same reason that pass is:
// a model the profile does not name keeps its inline bindings, and its inline
// statements are written against those.
function findLogicalSqlExecutor(doc: any, modelNames: Set<string>):
    {model: string; action: string}|undefined {
  for (const m of doc.semantic_model ?? []) {
    if (!m || typeof m !== 'object' || !modelNames.has(m.name)) continue;
    for (const a of m.actions ?? []) {
      if (a && typeof a === 'object' && a.executor &&
          typeof a.executor === 'object' && a.executor.sql !== undefined) {
        return {model: m.name, action: String(a.name)};
      }
    }
  }
  return undefined;
}

// A profile is authoritative for a model's physical bindings, so a field is
// bound under the merged model only if the profile binds it. This clears every
// inline field expression from the logical clone before the profile is
// overlaid, so a field the profile does not bind is left unbound (§7.3,
// "omitted is unbound"). Only the per-field column binding is cleared; the
// logical model's meaning -- names, types, relationships, metric formulas -- is
// untouched. A field is unbound exactly when it carries no expression; there is
// no separate flag.
function stripInlineFieldExpressions(doc: any, modelNames: Set<string>): void {
  for (const m of doc.semantic_model ?? []) {
    if (!m || typeof m !== 'object' || !modelNames.has(m.name)) continue;
    const entities = m.entities ?? m.datasets ?? [];
    for (const e of entities) {
      if (!e || typeof e !== 'object' || !Array.isArray(e.fields)) continue;
      for (const f of e.fields) {
        if (f && typeof f === 'object') delete f.expression;
      }
    }
  }
}


// One profile's availability outcome: the fields it leaves unbound, and the
// building blocks that fall with them.
export interface AvailabilityReport {
  profile: string;
  unboundFields: string[];  // "Entity.field"
  // An entity dropped whole because its key names an unbound field: a graph node
  // must be keyed, so an unbound key makes the entire entity unavailable.
  droppedEntities: {name: string; reason: string}[];
  droppedMetrics: {name: string; reason: string}[];
  droppedRelationships: {name: string; reason: string}[];
  // An action this profile cannot perform: it binds no executor for it, or a
  // concept the action names is itself unavailable.
  droppedActions: {name: string; reason: string}[];
}

/**
 * Returns a clone of `model` reduced to what `profileName` can answer: unbound
 * fields removed from their entities, and every metric or relationship that
 * depends on an unbound field dropped. The input is never mutated. The report
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

  // A field is bound when fieldBinding resolves it to a column; otherwise it is
  // unbound (structurally absent under this profile). fieldBinding is the shared
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
      if (fieldBinding(f) === undefined) unbound.add(`${e.name}.${f.name}`);
    }
  }
  report.unboundFields = [...unbound];

  // An entity whose key names an unbound field cannot be a node -- a graph node
  // must be keyed -- so the WHOLE entity is unavailable and everything on it (its
  // relationships and the metrics over it) falls with it. This is availability
  // propagating up from the unbound key. Record the entity, and add every one of
  // its fields to the unbound set so the relationship and metric passes below
  // cascade over it. Entity names are captured before any drop so a metric or
  // relationship that references a dropped entity is still detected.
  const allEntityNames = (clone.entities ?? []).map(e => e.name);
  const unavailableEntities = new Set<string>();
  for (const e of clone.entities ?? []) {
    const missingKey =
        (e.keys ?? []).find(k => unbound.has(`${e.name}.${k}`));
    if (missingKey !== undefined) {
      unavailableEntities.add(e.name);
      report.droppedEntities.push(
          {name: e.name, reason: `key field ${missingKey} is unbound`});
      for (const f of e.fields ?? []) unbound.add(`${e.name}.${f.name}`);
    }
  }

  // Drop unavailable entities whole, then drop unbound fields from the entities
  // that remain. (A bound field whose value is null still emits a column --
  // unbound is not null.)
  clone.entities =
      (clone.entities ?? []).filter(e => !unavailableEntities.has(e.name));
  for (const e of clone.entities) {
    // Keep an abstract entity's fields intact: they are column-less by design
    // and name the shared label's property set for the emitter (see above).
    if (e.abstract) continue;
    e.fields = (e.fields ?? []).filter(f => fieldBinding(f) !== undefined);
  }

  // A relationship is available only when both endpoint entities are available
  // and the join columns on both ends are bound (its endpoints' `columns` name
  // fields on those entities).
  const keptRels: Relationship[] = [];
  for (const r of clone.relationships ?? []) {
    const deadEnd = [r.source.entity, r.destination.entity].find(
        n => unavailableEntities.has(n));
    if (deadEnd !== undefined) {
      report.droppedRelationships.push(
          {name: r.name, reason: `entity ${deadEnd} is unavailable`});
      continue;
    }
    const missing = unboundJoinField(r, unbound);
    if (missing) {
      report.droppedRelationships.push(
          {name: r.name, reason: `join column ${missing} is unbound`});
    } else {
      keptRels.push(r);
    }
  }
  clone.relationships = keptRels;

  // A metric is available only when no entity it spans is unavailable, every
  // field it references is bound, and -- when it spans entities -- a relationship
  // connecting them survives.
  const keptMetrics: Metric[] = [];
  for (const mt of clone.metrics ?? []) {
    const expr = mt.expression ?? '';
    const refs = referencedEntityNames(expr, allEntityNames);
    const deadEntity = refs.find(n => unavailableEntities.has(n));
    if (deadEntity !== undefined) {
      report.droppedMetrics.push(
          {name: mt.name, reason: `entity ${deadEntity} is unavailable`});
      continue;
    }
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

  // An action is available only where a binding performs it and every concept
  // it names survives. The executor is the action's binding, so an action
  // without one is unavailable for the same reason a column-less field is: it
  // is declared, and there is nothing here to carry it out.
  const droppedRels = new Set(report.droppedRelationships.map(d => d.name));
  const keptActions: Action[] = [];
  for (const a of clone.actions ?? []) {
    if (a.executor === undefined) {
      report.droppedActions.push(
          {name: a.name, reason: 'no executor is bound under this profile'});
      continue;
    }
    // Parameters are not tested. Every one is a scalar, and a parameter
    // projected from a field took a copy of that field's type and wording when
    // the model loaded -- it needs nothing at run time from the concept it was
    // projected from. So a profile that leaves that concept unavailable leaves
    // the parameter intact, and dropping the action over it would withhold a
    // write the binding is perfectly able to perform.
    const deadAffected = (a.affects ?? [])
                             .find(
                                 f => unavailableEntities.has(f.concept) ||
                                     droppedRels.has(f.concept));
    if (deadAffected !== undefined) {
      report.droppedActions.push({
        name: a.name,
        reason: `it affects ${deadAffected.concept}, which is unavailable`,
      });
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

// The first join field of a relationship that is unbound on its own end, or
// null when both ends' join columns are bound.
function unboundJoinField(r: Relationship, unbound: Set<string>): string|null {
  for (const c of r.source?.columns ?? []) {
    const key = `${r.source.entity}.${c}`;
    if (unbound.has(key)) return key;
  }
  for (const c of r.destination?.columns ?? []) {
    const key = `${r.destination.entity}.${c}`;
    if (unbound.has(key)) return key;
  }
  return null;
}

// Whether any surviving relationship directly connects two of the referenced
// entities -- the minimal check that a cross-entity metric still has a join path
// after unavailable relationships were dropped.
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
