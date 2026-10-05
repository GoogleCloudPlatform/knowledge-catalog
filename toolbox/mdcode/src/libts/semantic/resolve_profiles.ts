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

import {Action, ALLOWED_DIALECTS, DialectExpression, Entity, Executor, Field, FIELD_BINDING_KEYS, isFieldBound, Metric, ProfileEntityBinding, ProfileRelationshipBinding, ProfileSpec, Relationship, SemanticModel, SqlDialect} from './ir';
import {resolveInheritance} from './resolve_inheritance';
import {isColumnName, referencedEntityFields, referencedEntityNames,} from './sql_expr_utils';

// The implicit profile: the inline bindings already in the model document (the
// combined single-file form). It is never merged -- it IS the document as
// authored -- so a bare `kcmd push` behaves as it always has.
export const DEFAULT_PROFILE = 'default';

// The loader's YAML options (see loadModels in loader.ts): YAML-only tags stay
// the text written, and unresolved-tag warnings stay off stderr.
const YAML_OPTIONS = {resolveKnownTags: false, logLevel: 'error'} as const;

export interface MergeResult {
  // The merged authoring document (still in the sugared form), ready to feed
  // through the normal loader.
  doc: unknown;
  warnings: string[];
  // A binding-only or unknown-name violation, naming the offending path. When
  // set, `doc` should not be deployed.
  error?: string;
  // The fields and metrics the profile excludes. The merged document keeps
  // them all, so a catalog push publishes the whole logical model (Model Spec
  // §4.5). Apply them to the loaded model with applyProfileExclusions before
  // pruning: a field exclusion applies to the entity that names it and not to
  // its descendants (§3.1.3, §4.2.2), which the merged document alone cannot
  // say.
  excluded: ProfileExclusion[];
}

// One thing a profile excludes in one model: a field on one entity, or a
// metric.
export type ProfileExclusion = {
  model: string; entity: string; field: string;
}|{model: string; metric: string};

// Keys a profile may carry at each level. Everything else is a logical
// declaration the model owns; setting it in a profile is rejected so swapping a
// profile can move data but never change what the model means.
//
// A profile file is a top-level profile object (`name`, `entities`, ...). The
// older form, a `semantic_model:` wrapper around partial models, is still
// accepted until legacy profile selection is removed; LEGACY_MODEL_KEYS
// describes it. It takes the keys the new form takes, plus the
// `deployment_target` and `version` it always has.
const PROFILE_FILE_KEYS = new Set([
  'name', 'entities', 'relationships', 'metrics_exclude', 'actions',
]);
const PROFILE_ENTITY_KEYS = new Set([
  'name', 'source', 'primary_key', 'unique_keys', 'fields', 'fields_exclude',
]);
const PROFILE_RELATIONSHIP_KEYS =
    new Set(['name', 'from_columns', 'to_columns']);
const PROFILE_FIELD_KEYS = new Set(['name', 'expression']);
const PROFILE_ACTION_KEYS = new Set(['name', 'executor']);
const LEGACY_MODEL_KEYS = new Set([
  'name', 'version', 'deployment_target', 'entities', 'datasets',
  'relationships', 'metrics_exclude', 'actions',
]);

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
  const merged = plainCopy(logicalDoc);
  const profile = profileDoc as any;

  if (!merged || typeof merged !== 'object' ||
      !Array.isArray(merged.semantic_model)) {
    return {
      doc: merged, warnings, excluded: [],
      error: 'the logical model is not a semantic_model document',
    };
  }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return {
      doc: merged, warnings, excluded: [],
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
    const extra = Object.keys(profile).find(
        k => k !== 'semantic_model' && k !== 'version');
    if (extra) {
      return {
        doc: merged, warnings, excluded: [],
        error: `profile '${profileName}': a 'semantic_model:' profile carries ` +
            `only 'version' and 'semantic_model', not '${extra}'`,
      };
    }
    targets = [];
    for (const pm of profile.semantic_model) {
      if (!pm || typeof pm !== 'object' || typeof pm.name !== 'string') {
        return {
          doc: merged, warnings, excluded: [],
          error: `profile '${profileName}': every entry in 'semantic_model' ` +
              `is a mapping with a 'name'`,
        };
      }
      const lm = logicalByName.get(pm.name);
      if (!lm) {
        return {
          doc: merged, warnings, excluded: [],
          error: `profile '${profileName}': model '${
              pm.name}' is not in the logical model`,
        };
      }
      targets.push({lm, pm});
    }
  } else {
    if (logicalByName.size !== 1) {
      return {
        doc: merged, warnings, excluded: [],
        error: `profile '${profileName}' binds one model, but the logical ` +
            `document declares ${logicalByName.size}`,
      };
    }
    targets = [{lm: [...logicalByName.values()][0], pm: profile}];
  }

  const sqlInLogical = findLogicalSqlExecutor(targets.map(t => t.lm));
  if (sqlInLogical) {
    return {
      doc: merged, warnings, excluded: [],
      error: `profile '${profileName}': action '${sqlInLogical.action}' in ` +
          `model '${sqlInLogical.model}' declares a 'sql' executor. A ` +
          `statement names one database's own tables and columns, so it ` +
          `belongs in the profile that binds them, not in the model. Move ` +
          `the executor into each profile that performs this write as DML.`,
    };
  }

  const excluded: ProfileExclusion[] = [];
  for (const {lm, pm} of targets) {
    const err = legacy ? mergeLegacyModel(lm, pm, profileName, excluded) :
                         mergeProfileFile(lm, pm, profileName, excluded);
    if (err) return {doc: merged, warnings, excluded: [], error: err};
  }
  return {doc: merged, warnings, excluded};
}

// A deep copy in which every node is its own object. structuredClone keeps a
// YAML anchor and its aliases as one object, so a profile that rebinds or
// excludes a field on one entity would change every entity that aliases it.
function plainCopy(value: unknown): any {
  if (Array.isArray(value)) return value.map(plainCopy);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, plainCopy(v)]));
  }
  return value;
}

/**
 * Marks on `model` the fields and metrics a merged profile excludes. Inheritance
 * resolution leaves an excluded field off the entity that names it while its
 * descendants still inherit the declaration, and pruning drops an excluded
 * metric. Returns a copy; the input is not mutated.
 */
export function applyProfileExclusions(
    model: SemanticModel,
    excluded: ReadonlyArray<ProfileExclusion>): SemanticModel {
  const mine = excluded.filter(x => x.model === model.name);
  if (!mine.length) return model;
  const out = structuredClone(model);
  for (const e of out.entities ?? []) {
    const names = mine.flatMap(
        x => 'field' in x && x.entity === e.name ? [x.field] : []);
    if (names.length) {
      e.excludedFields = [...new Set([...(e.excludedFields ?? []), ...names])];
    }
  }
  const metrics = mine.flatMap(x => 'metric' in x ? [x.metric] : []);
  if (metrics.length) {
    out.excludedMetrics =
        [...new Set([...(out.excludedMetrics ?? []), ...metrics])];
  }
  return out;
}

// Overlays a top-level profile object onto the one model it binds. The object
// is read first exactly as loadProfileFile reads it, so push and the profile
// checks agree on what a valid profile file is.
function mergeProfileFile(
    lm: any, pf: any, profileName: string,
    excluded: ProfileExclusion[]): string|undefined {
  try {
    profileSpecOf(pf, profileName);
  } catch (err: any) {
    return err?.message ?? String(err);
  }
  const err = mergeActions(lm, pf.actions, profileName) ??
      mergeEntities(
             lm, pf.entities, PROFILE_ENTITY_KEYS, profileName, excluded) ??
      mergeRelationships(lm, pf.relationships, profileName) ??
      excludeMetrics(lm, pf.metrics_exclude, profileName, excluded);
  return err;
}

// Overlays one partial model from the legacy `semantic_model:` wrapper.
function mergeLegacyModel(
    lm: any, pm: any, profileName: string,
    excluded: ProfileExclusion[]): string|undefined {
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
             lm, pm.entities ?? pm.datasets, PROFILE_ENTITY_KEYS, profileName,
             excluded) ??
      mergeRelationships(lm, pm.relationships, profileName) ??
      excludeMetrics(lm, pm.metrics_exclude, profileName, excluded);
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
    lm: any, entities: unknown, allowed: Set<string>, profileName: string,
    excluded: ProfileExclusion[]): string|undefined {
  if (entities === undefined) return undefined;
  if (!Array.isArray(entities)) {
    return `profile '${profileName}': 'entities' must be a list`;
  }
  for (const pe of entities) {
    if (!pe || typeof pe !== 'object' || Array.isArray(pe) ||
        typeof pe.name !== 'string') {
      return `profile '${profileName}': every entry in 'entities' is a ` +
          `mapping with a 'name'`;
    }
  }
  const dup = duplicateName(entities);
  if (dup) return `profile '${profileName}': entity '${dup}' is listed twice`;
  const lByName = indexByName(lm.entities ?? lm.datasets);
  for (const pe of entities) {
    const le = lByName.get(pe.name);
    if (!le) {
      return `profile '${profileName}': entity '${
          pe.name}' is not in the logical model`;
    }
    // Model Spec §4.2.2: no profile binds an abstract entity.
    if (le.abstract === true) {
      return `profile '${profileName}': entity '${
          pe.name}' is abstract, so a profile cannot bind it`;
    }
    const err = mergeEntity(le, pe, allowed, profileName, lm);
    if (err) return err;
    for (const field of pe.fields_exclude ?? []) {
      excluded.push({model: lm.name, entity: pe.name, field});
    }
  }
  return undefined;
}

// The first name a list of named entries carries twice, or undefined.
function duplicateName(list: unknown[]): string|undefined {
  const seen = new Set<string>();
  for (const item of list) {
    const name = (item as any)?.name;
    if (typeof name !== 'string') continue;
    if (seen.has(name)) return name;
    seen.add(name);
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
    le: any, pe: any, allowed: Set<string>, profileName: string,
    lm: any): string|undefined {
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
  for (const pf of pe.fields ?? []) {
    if (!pf || typeof pf !== 'object' || Array.isArray(pf) ||
        typeof pf.name !== 'string') {
      return `profile '${profileName}': every entry in entity '${
          pe.name}' 'fields' is a mapping with a 'name'`;
    }
  }
  const dupField = duplicateName(pe.fields ?? []);
  if (dupField) {
    return `profile '${profileName}': field '${pe.name}.${
        dupField}' is listed twice`;
  }
  // Copy each field so no edit here reaches another entity through a shared
  // object.
  le.fields = (le.fields ?? []).map((f: any) => ({...f}));
  const lByName = indexByName(le.fields);
  const inherited = inheritedFieldNames(lm, le.name);
  const rebound = new Set<string>();
  for (const pf of pe.fields ?? []) {
    let lf = lByName.get(pf.name);
    if (!lf && inherited.has(pf.name)) {
      // Binding an inherited field redeclares it on this entity with only a
      // binding, which inheritance merges over the ancestor's definition.
      lf = {name: pf.name};
      le.fields = [...(le.fields ?? []), lf];
      lByName.set(pf.name, lf);
    }
    if (!lf) {
      return `profile '${profileName}': field '${pe.name}.${
          pf.name}' is not in the logical model`;
    }
    const err = mergeField(lf, pf, pe.name, profileName);
    if (err) return err;
    rebound.add(pf.name);
  }
  // An exclusion applies to this entity only (Model Spec §3.1.3, §4.2.2). The
  // caller records it for applyProfileExclusions. A field no entity inherits
  // from this one also loses its binding here, so it stays unbound even where
  // the exclusions are not applied; one a descendant inherits keeps the
  // binding the descendant reads.
  const inheritedBelow = hasDescendants(lm, le.name);
  for (const name of pe.fields_exclude ?? []) {
    const lf = lByName.get(name);
    if (!lf && !inherited.has(name)) {
      return `profile '${profileName}': field '${pe.name}.${
          name}' in 'fields_exclude' is not in the logical model`;
    }
    if (rebound.has(name)) {
      return `profile '${profileName}': field '${pe.name}.${
          name}' is in both 'fields' and 'fields_exclude'`;
    }
    if (lf && !inheritedBelow) {
      // A line that only redeclares an inherited field goes with its binding,
      // since a redeclaration with nothing but the name is rejected (Model
      // Spec §3.1.3). The entity still inherits the declaration.
      if (inherited.has(name)) {
        le.fields = le.fields.filter((f: any) => f !== lf);
      } else {
        delete lf.expression;
      }
    }
  }
  return undefined;
}

// Whether any entity in the logical document extends `entityName`, directly or
// through another entity.
function hasDescendants(lm: any, entityName: string): boolean {
  const entities = indexByName(lm.entities ?? lm.datasets);
  return [...entities.keys()].some(
      name => name !== entityName &&
          ancestorNames(entities, name).has(entityName));
}

// The names of every ancestor `entityName`'s `extends` reaches.
function ancestorNames(
    entities: Map<string, any>, entityName: string): Set<string> {
  const seen = new Set<string>();
  const queue = [...(entities.get(entityName)?.extends ?? [])];
  while (queue.length) {
    const anc = queue.shift();
    if (typeof anc !== 'string' || seen.has(anc)) continue;
    seen.add(anc);
    queue.push(...(entities.get(anc)?.extends ?? []));
  }
  return seen;
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
  const dup = duplicateName(relationships);
  if (dup) {
    return `profile '${profileName}': relationship '${dup}' is listed twice`;
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

// Records the metrics a profile excludes: `"*"` for every metric, now and
// later, or a list of metric names. The metrics stay in the document.
function excludeMetrics(
    lm: any, exclude: unknown, profileName: string,
    excluded: ProfileExclusion[]): string|undefined {
  if (exclude === undefined) return undefined;
  const record = (names: string[]) => {
    for (const metric of names) excluded.push({model: lm.name, metric});
  };
  if (exclude === '*') {
    record((lm.metrics ?? []).map((m: any) => m?.name)
               .filter((n: unknown): n is string => typeof n === 'string'));
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
  record([...new Set(exclude as string[])]);
  return undefined;
}

function declError(profileName: string, where: string, key: string): string {
  return notAllowed(`profile '${profileName}': ${where}`, key);
}

function notAllowed(where: string, key: string): string {
  return `${where} sets '${key}', which a profile may not set; a profile ` +
      `carries only physical bindings, and the logical model owns everything ` +
      `else`;
}

// The names of the fields an entity inherits, from every ancestor its
// `extends` reaches in the logical document.
function inheritedFieldNames(lm: any, entityName: string): Set<string> {
  const entities = indexByName(lm.entities ?? lm.datasets);
  const names = new Set<string>();
  const seen = new Set<string>([entityName]);
  const queue = [...(entities.get(entityName)?.extends ?? [])];
  while (queue.length) {
    const anc = queue.shift();
    if (typeof anc !== 'string' || seen.has(anc)) continue;
    seen.add(anc);
    const e = entities.get(anc);
    for (const f of e?.fields ?? []) {
      if (f && typeof f.name === 'string') names.add(f.name);
    }
    queue.push(...(e?.extends ?? []));
  }
  return names;
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
 * and excluded fields taken off their entities, every excluded metric and
 * every metric that depends on such a field dropped, and every action with no
 * executor dropped. A field counts
 * whether the entity declares or inherits it. The input is never
 * mutated. The report names each dropped block and the unbound field that
 * stops it, so a caller can state the withheld coverage. A model with nothing
 * unbound resolves unchanged.
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
  //
  // Availability is judged on each entity's resolved fields, declared plus
  // inherited, since a metric can read an inherited field as readily as a
  // declared one. A field the profile excludes on an entity is unavailable on
  // that entity (Model Spec §4.2.2).
  const unbound = new Set<string>();
  for (const e of resolvedEntities(clone)) {
    // An abstract entity has no table and no bindings by design: it survives
    // only as a label on its subtypes (which bind its inherited fields on their
    // own tables). Its fields are legitimately column-less, so they are not
    // "unbound" in the pruning sense.
    if (e.abstract) continue;
    for (const f of e.fields ?? []) {
      if (!isFieldBound(f)) unbound.add(`${e.name}.${f.name}`);
    }
    for (const name of e.excludedFields ?? []) {
      unbound.add(`${e.name}.${name}`);
    }
  }
  report.unboundFields = [...unbound];

  // Keys and join columns are physical column names, not fields, so whether a
  // field is bound says nothing about them. Excluding a field that happens to
  // share a key column's name drops the field and nothing else.
  const allEntityNames = (clone.entities ?? []).map(e => e.name);

  // Take unbound and excluded fields off the entities that declare them. (A
  // bound field whose value is null still emits a column -- unbound is not
  // null.) A declaration that a descendant inherits stays, so the descendant
  // keeps the definition and whatever binding it has, and is marked excluded on
  // the declaring entity instead (Model Spec §3.1.3: a binding is a fact about
  // one table).
  const extendedNames = new Set(
      resolvedEntities(clone).flatMap(e => e.extends ?? []));
  for (const e of clone.entities ?? []) {
    // Keep an abstract entity's fields intact: they are column-less by design
    // and name the shared label's property set for the emitter (see above).
    if (e.abstract) continue;
    const excluded = new Set(e.excludedFields ?? []);
    const gone = (f: Field) => !isFieldBound(f) || excluded.has(f.name);
    if (extendedNames.has(e.name)) {
      const kept = (e.fields ?? []).filter(gone).map(f => f.name);
      if (kept.length) {
        e.excludedFields = [...new Set([...excluded, ...kept])];
      }
    } else {
      e.fields = (e.fields ?? []).filter(f => !gone(f));
    }
  }

  // A relationship's join columns are its own binding, so pruning fields never
  // removes one.
  const keptRels: Relationship[] = clone.relationships ?? [];

  // A metric is available only when the profile does not exclude it, every
  // field it references is bound, and -- when it spans entities -- a
  // relationship connects them.
  const excludedMetrics = new Set(clone.excludedMetrics ?? []);
  delete clone.excludedMetrics;
  const keptMetrics: Metric[] = [];
  for (const mt of clone.metrics ?? []) {
    if (excludedMetrics.has(mt.name)) {
      report.droppedMetrics.push({name: mt.name, reason: 'excluded'});
      continue;
    }
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

// Each entity resolved for inheritance, or as declared when the hierarchy is
// broken, which push reports elsewhere. `extends` is expanded to every
// ancestor.
function resolvedEntities(model: SemanticModel): Entity[] {
  const entities = model.entities ?? [];
  if (!entities.some(e => e.extends?.length)) return entities;
  try {
    return resolveInheritance(model).model.entities ?? entities;
  } catch {
    return entities;
  }
}

// The first unbound "Entity.field" a metric expression references (qualified),
// or null. Text inside string literals is ignored.
function firstUnboundReferenced(expr: string, unbound: Set<string>): string|
    null {
  for (const key of unbound) {
    const dot = key.indexOf('.');
    if (referencedEntityFields(expr, key.slice(0, dot))
            .includes(key.slice(dot + 1))) {
      return key;
    }
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
    logicalText: string, profileText: string, profileName: string):
    {text: string; warnings: string[]; excluded: ProfileExclusion[]}|
    {error: string} {
  let logicalDoc: unknown;
  let profileDoc: unknown;
  try {
    // Parse as the loader does, so a YAML-only tag such as `!!timestamp` in a
    // custom ai_context member stays the text written through the merge.
    logicalDoc = yaml.parse(logicalText, YAML_OPTIONS);
    profileDoc = yaml.parse(profileText, YAML_OPTIONS);
  } catch (err: any) {
    return {
      error: `could not parse the model or profile '${profileName}': ${
          err?.message ?? err}`,
    };
  }
  const merged = mergeProfile(logicalDoc, profileDoc, profileName);
  if (merged.error) return {error: merged.error};
  return {
    text: yaml.stringify(merged.doc),
    warnings: merged.warnings,
    excluded: merged.excluded,
  };
}


/**
 * Reads a profile file -- the top-level profile object `mergeProfile` also
 * accepts -- into the IR's `ProfileSpec`. Throws on anything a profile may not
 * say: an unknown key at any level, a value of the wrong shape, a field in both
 * `fields` and `fields_exclude`, `"*"` inside a `metrics_exclude` list, or a
 * `name` other than `profileName`. A field expression is converted as the
 * loader converts a model field's: the short form becomes a one-entry
 * `ANSI_SQL` list with `stringForm` set, and the `dialects:` form is kept as
 * written. An action's executor is carried through as the loader reads one;
 * actions are out of scope for the preview, so nothing more is checked.
 */
export function loadProfileFile(text: string, profileName: string):
    ProfileSpec {
  let doc: any;
  try {
    doc = yaml.parse(text, YAML_OPTIONS);
  } catch (err: any) {
    throw new Error(
        `profile '${profileName}' does not parse: ${err?.message ?? err}`);
  }
  return profileSpecOf(doc, profileName);
}

// Reads a parsed profile file into a ProfileSpec, throwing on anything a
// profile may not say. Shared by loadProfileFile and by the merge push runs,
// so the two agree on what a valid profile file is.
function profileSpecOf(doc: any, profileName: string): ProfileSpec {
  const where = `profile '${profileName}'`;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) ||
      doc.semantic_model !== undefined) {
    throw new Error(`${where} is not a profile file`);
  }
  // The profile's own name is checked against the file name below.
  requireKeys(doc, PROFILE_FILE_KEYS, where, false);
  if (doc.name !== profileName) {
    throw new Error(
        `${where} declares name '${doc.name ?? ''}', which does not match ` +
        `its file's profile name '${profileName}'`);
  }
  const spec: ProfileSpec = {
    name: profileName,
    entities: namedListOf(doc.entities, `${where} 'entities'`)
                  .map(e => profileEntity(e, where)),
    relationships:
        namedListOf(doc.relationships, `${where} 'relationships'`).map(r => {
          requireKeys(r, PROFILE_RELATIONSHIP_KEYS, `${where}: relationship`);
          const at = `${where}: relationship '${r.name}'`;
          // A side the profile leaves out is empty, which completeness
          // rejects: a named profile states both join column lists itself.
          const binding: ProfileRelationshipBinding = {
            name: r.name,
            fromColumns: stringList(r.from_columns, `${at} 'from_columns'`),
            toColumns: stringList(r.to_columns, `${at} 'to_columns'`),
          };
          return binding;
        }),
  };
  if (doc.metrics_exclude !== undefined) {
    const ex = doc.metrics_exclude;
    if (ex !== '*' &&
        !(Array.isArray(ex) &&
          ex.every((n: unknown) => typeof n === 'string'))) {
      throw new Error(
          `${where}: 'metrics_exclude' must be "*" or a list of metric names`);
    }
    if (Array.isArray(ex) && ex.includes('*')) {
      throw new Error(
          `${where}: 'metrics_exclude' takes "*" on its own, not inside a ` +
          `list`);
    }
    spec.metricsExclude = ex;
  }
  if (doc.actions !== undefined) {
    // Actions are out of preview scope and gain no new checks, so a repeated
    // action is taken as the merge has always taken one: the last entry wins.
    spec.actions = listOf(doc.actions, `${where} 'actions'`).map(a => {
      requireKeys(a, PROFILE_ACTION_KEYS, `${where}: action`);
      if (a.executor === undefined) return {name: a.name};
      return {
        name: a.name,
        executor: a.executor === null ? null : profileExecutor(a.executor),
      };
    });
  }
  return spec;
}

function profileEntity(e: any, where: string): ProfileEntityBinding {
  requireKeys(e, PROFILE_ENTITY_KEYS, `${where}: entity`);
  const at = `${where}: entity '${e.name}'`;
  const binding: ProfileEntityBinding = {name: e.name};
  if (e.source !== undefined) {
    if (typeof e.source !== 'string') {
      throw new Error(`${at} 'source' must be a string`);
    }
    binding.source = e.source;
  }
  if (e.primary_key !== undefined) {
    binding.primaryKey = stringList(e.primary_key, `${at} 'primary_key'`);
  }
  if (e.unique_keys !== undefined) {
    binding.uniqueKeys = listOf(e.unique_keys, `${at} 'unique_keys'`)
                             .map(k => stringList(k, `${at} 'unique_keys'`));
  }
  if (e.fields !== undefined) {
    binding.fields = namedListOf(e.fields, `${at} 'fields'`).map(f => {
      requireKeys(f, PROFILE_FIELD_KEYS, `${at}: field`);
      const fat = `${at}: field '${f.name}'`;
      return {name: f.name, ...profileExpression(f.expression, fat)};
    });
  }
  if (e.fields_exclude !== undefined) {
    binding.fieldsExclude =
        stringList(e.fields_exclude, `${at} 'fields_exclude'`);
    const both = binding.fieldsExclude.filter(
        n => (binding.fields ?? []).some(f => f.name === n));
    if (both.length) {
      throw new Error(
          `${at}: field '${both[0]}' is in both 'fields' and 'fields_exclude'`);
    }
  }
  return binding;
}

// Checks that `obj` is a mapping carrying only `allowed` keys and, unless
// `named` is false, a string `name`.
function requireKeys(
    obj: any, allowed: Set<string>, where: string, named = true): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${where} is not a mapping`);
  }
  if (named && typeof obj.name !== 'string') {
    throw new Error(`${where} has no 'name'`);
  }
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new Error(notAllowed(
          named && obj.name !== undefined ? `${where} '${obj.name}'` : where,
          k));
    }
  }
}

function listOf(value: unknown, where: string): any[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${where} must be a list`);
  return value;
}

// A list of named entries, each named once.
function namedListOf(value: unknown, where: string): any[] {
  const list = listOf(value, where);
  const dup = duplicateName(list);
  if (dup) throw new Error(`${where} lists '${dup}' twice`);
  return list;
}

function stringList(value: unknown, where: string): string[] {
  const list = listOf(value, where);
  if (!list.every(v => typeof v === 'string')) {
    throw new Error(`${where} must be a list of names`);
  }
  return list;
}

// The IR form of a profile field's expression, as the loader builds a model
// field's. Dialect names match case-insensitively, as the loader's do, and the
// engine-specific entry wins over ANSI_SQL for `expression`. A list with
// neither keeps its first entry as the imported expression, so the field still
// counts as bound (see `isFieldBound`).
function profileExpression(expr: unknown, where: string):
    Pick<
        Field,
        'expression'|'dialects'|'stringForm'|'importedExpression'|
        'importedDialect'> {
  if (expr === undefined) return {};
  if (typeof expr === 'string') {
    return {
      expression: expr,
      dialects: [{dialect: 'ANSI_SQL', expression: expr}],
      stringForm: true,
    };
  }
  const dialects = (expr as any)?.dialects;
  if (!Array.isArray(dialects) || !dialects.length ||
      !dialects.every(
          (d: any) => typeof d?.dialect === 'string' &&
              typeof d?.expression === 'string')) {
    throw new Error(
        `${where}: 'expression' must be a string or a list of dialects`);
  }
  // Model Spec §3.5.2: only the allowlisted dialects, each at most once. A
  // profile file is Google flavor, so a name matches in any case and is
  // stored uppercase, as the loader does for that flavor.
  const list: DialectExpression[] = [];
  for (const d of dialects) {
    const dialect = d.dialect.toUpperCase();
    if (!(ALLOWED_DIALECTS as readonly string[]).includes(dialect)) {
      throw new Error(
          `${where}: dialect '${d.dialect}' is not one of ${
              ALLOWED_DIALECTS.join(', ')}`);
    }
    if (list.some(x => x.dialect === dialect)) {
      throw new Error(`${where}: dialect '${dialect}' appears twice`);
    }
    list.push({dialect: dialect as SqlDialect, expression: d.expression});
  }
  const pick = list.find(d => d.dialect === 'BIGQUERY') ??
      list.find(d => d.dialect === 'ANSI_SQL');
  const first = list[0];
  return {
    ...(pick ? {expression: pick.expression} :
               first ? {
                 importedExpression: first.expression,
                 importedDialect: first.dialect,
               } :
                       {}),
    dialects: list,
    stringForm: false,
  };
}

// An action executor as the loader reads one (see convertExecutor in
// loader.ts): exactly one of mcp, rest, grpc or sql.
function profileExecutor(ex: any): Executor {
  if (ex?.mcp) return {kind: 'mcp', mcp: {...ex.mcp}};
  if (ex?.rest) return {kind: 'rest', rest: {...ex.rest}};
  if (ex?.grpc) return {kind: 'grpc', grpc: {...ex.grpc}};
  if (ex?.sql && Array.isArray(ex.sql.statements)) {
    return {
      kind: 'sql',
      sql: {statements: ex.sql.statements.map((t: string) => String(t).trim())},
    };
  }
  throw new Error(
      `an action executor must be one of 'mcp', 'rest', 'grpc' or 'sql'`);
}


// ---------------------------------------------------------------------------
// Whether a profile can be deployed.
// ---------------------------------------------------------------------------


// The database a profile source lives in, for the one-database rule, or
// undefined when the source is in no form Model Spec §4.4 accepts: a bare
// name, a query, a graph rather than a table, an FQN under any prefix the
// table there does not list, or one with the wrong number of segments. The
// result starts with its system, which DIALECT_OF_SYSTEM maps to the dialect
// the source infers.
//
// A database is what a single query can reach: all of BigQuery, BigLake
// included because BigQuery reads it; one Spanner, AlloyDB, Cloud SQL for
// PostgreSQL or self-managed PostgreSQL database; one Cloud SQL for MySQL
// instance or self-managed MySQL server; one Snowflake account; one Databricks
// metastore. A self-managed server is named by its DNS name, so `mysql:` and
// `postgresql:` name different systems from `cloudsql_mysql:` and
// `cloudsql_postgresql:`. The segment counts are those of the Knowledge
// Catalog FQN reference.
function databaseOf(source: string): string|undefined {
  if (/^\/\/bigquery\.googleapis\.com\/projects\/[^/]+\/datasets\/[^/]+\/tables\/[^/]+$/
          .test(source) ||
      /^\/\/biglake\.googleapis\.com\/projects\/[^/]+\/catalogs\/[^/]+\/namespaces\/[^/]+\/tables\/[^/]+$/
          .test(source)) {
    return 'bigquery';
  }
  let m = source.match(
      /^\/\/spanner\.googleapis\.com\/projects\/([^/]+)\/instances\/([^/]+)\/databases\/([^/]+)\/tables\/[^/]+$/);
  if (m) return `spanner/${m[1]}/${m[2]}/${m[3]}`;
  m = source.match(
      /^\/\/alloydb\.googleapis\.com\/projects\/([^/]+)\/locations\/([^/]+)\/clusters\/([^/]+)\/instances\/[^/]+\/databases\/([^/]+)\/tables\/[^/]+$/);
  if (m) return `alloydb/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
  m = source.match(/^(databricks:table|[a-z_]+):(.+)$/);
  if (!m) return undefined;
  const seg = catalogNameSegments(m[2]);
  const first = (n: number) => seg.slice(0, n).join('.');
  switch (m[1]) {
    case 'bigquery':
      return seg.length === 3 ? 'bigquery' : undefined;
    case 'spanner':
      return seg.length === 5 ? `spanner/${seg[0]}/${seg[2]}/${seg[3]}` :
                                undefined;
    case 'alloydb':
      return seg.length === 6 ?
          `alloydb/${seg[0]}/${seg[1]}/${seg[2]}/${seg[3]}` :
          undefined;
    case 'cloudsql_mysql':
      return seg.length === 5 ? `cloudsql_mysql/${first(3)}` : undefined;
    case 'mysql':
      return seg.length === 3 ? `mysql/${first(1)}` : undefined;
    case 'cloudsql_postgresql':
      return seg.length === 6 ? `cloudsql_postgresql/${first(4)}` : undefined;
    case 'postgresql':
      return seg.length === 4 ? `postgresql/${first(2)}` : undefined;
    case 'snowflake':
      return seg.length === 4 ? `snowflake/${seg[0]}` : undefined;
    case 'databricks:table':
      return seg.length === 4 ? `databricks/${seg[0]}` : undefined;
    default:
      return undefined;
  }
}

// The dialect each system's sources infer (Model Spec §4.4), keyed by the
// system databaseOf puts first.
const DIALECT_OF_SYSTEM: Record<string, string> = {
  bigquery: 'BIGQUERY',
  spanner: 'SPANNER',
  alloydb: 'ALLOYDB',
  cloudsql_mysql: 'MYSQL',
  mysql: 'MYSQL',
  cloudsql_postgresql: 'POSTGRES',
  postgresql: 'POSTGRES',
  snowflake: 'SNOWFLAKE',
  databricks: 'DATABRICKS',
};

// Whether a bound field has a text an engine of `dialect` can run: an entry
// for that dialect, or a text that matches every engine, which is an ANSI_SQL
// entry or the string form (mapping §8.1). A field read without its dialect
// list keeps its BigQuery or ANSI_SQL text in `expression` with nothing saying
// which, so that text counts.
function runsOn(f: Field, dialect: string): boolean {
  if (f.stringForm) return true;
  if (f.dialects?.length) {
    return f.dialects.some(d => {
      const name = d.dialect.toUpperCase();
      return name === dialect || name === 'ANSI_SQL';
    });
  }
  if (f.expression !== undefined) return true;
  return f.importedDialect?.toUpperCase() === dialect;
}

// A catalog name's dot-separated segments. A segment containing a reserved
// character, such as a domain-scoped project, is wrapped in backticks, so the
// dots inside backticks do not split.
function catalogNameSegments(path: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '`') {
      // A doubled backtick inside a quoted segment is a literal backtick.
      if (quoted && path[i + 1] === '`') {
        cur += '`';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === '.' && !quoted) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function expressionTexts(
    f: Pick<Field, 'expression'|'dialects'|'importedExpression'>): string[] {
  const out = (f.dialects ?? []).map(d => d.expression);
  if (f.expression !== undefined) out.push(f.expression);
  if (f.importedExpression !== undefined) out.push(f.importedExpression);
  return out;
}

/**
 * Returns one message per reason `profile` cannot be deployed against
 * `baseModel`, or an empty list. Checks a single profile: nothing unknown,
 * every concrete entity bound and all in one database, key shapes matching the
 * model file's where it states keys, every relationship bound, every field the
 * model file leaves unbound accounted for, and exclusions closed under
 * dependency, metrics included. Rules that compare profiles with each other
 * are in validateProfileConsistency.
 */
export function validateProfileCompleteness(
    baseModel: SemanticModel, profile: ProfileSpec): string[] {
  const errors: string[] = [];
  const at = `profile '${profile.name}'`;
  const entities = baseModel.entities ?? [];
  const byName = new Map(entities.map(e => [e.name, e]));
  // Declared plus inherited fields, in the model file and as this profile sees
  // the model (see withProfile): the profile's bindings applied, and each
  // excluded field left off the entity that names it. A broken hierarchy in
  // the model file is reported by push; one the profile itself creates, by
  // binding a field on two unrelated branches, is reported here.
  const fieldsOf = fieldsByEntity(baseModel);
  const profiled = withProfile(baseModel, profile);
  const profiledError = inheritanceErrorOf(profiled);
  if (profiledError && !inheritanceErrorOf(baseModel)) {
    errors.push(`${at}: ${profiledError}`);
    return errors;
  }
  const seenOf = fieldsByEntity(profiled);
  const bindingOf = new Map(profile.entities.map(e => [e.name, e]));

  // Nothing unknown.
  for (const pe of profile.entities) {
    const e = byName.get(pe.name);
    if (!e) {
      errors.push(`${at}: entity '${pe.name}' is not in the model`);
      continue;
    }
    if (e.abstract) {
      errors.push(
          `${at}: entity '${pe.name}' is abstract, so a profile cannot ` +
          `bind it`);
      continue;
    }
    const known = fieldsOf.get(pe.name)!;
    const named = [
      ...(pe.fields ?? []).map(f => f.name), ...(pe.fieldsExclude ?? []),
    ];
    for (const name of named) {
      if (!known.has(name)) {
        errors.push(`${at}: field '${pe.name}.${name}' is not in the model`);
      }
    }
    // A profile field's expression may be anything the model file's could be
    // (Model Spec §4.5): its own table's columns and its own entity's fields,
    // never another entity's fields (§3.5.3).
    // A name after a dot is a struct path segment, such as `customer` in
    // `details.customer.id`, and reads no entity.
    const others = entities.map(x => x.name).filter(n => n !== pe.name);
    for (const pf of pe.fields ?? []) {
      for (const text of expressionTexts(pf)) {
        for (const other of others) {
          if (referencedEntityFields(text, other).length) {
            errors.push(
                `${at}: field '${pe.name}.${pf.name}' reads entity '${
                    other}'; a field expression reads only its own entity`);
          }
        }
        for (const ref of referencedEntityFields(text, pe.name)) {
          if (!known.has(ref)) {
            errors.push(
                `${at}: field '${pe.name}.${pf.name}' reads '${pe.name}.${
                    ref}', which is not a field of '${pe.name}'`);
          }
        }
      }
    }
  }
  const relByName =
      new Map((baseModel.relationships ?? []).map(r => [r.name, r]));
  for (const pr of profile.relationships) {
    if (!relByName.has(pr.name)) {
      errors.push(`${at}: relationship '${pr.name}' is not in the model`);
    }
  }
  const metricNames = new Set((baseModel.metrics ?? []).map(m => m.name));
  if (Array.isArray(profile.metricsExclude)) {
    for (const name of profile.metricsExclude) {
      if (!metricNames.has(name)) {
        errors.push(
            `${at}: metric '${name}' in 'metrics_exclude' is not in the ` +
            `model`);
      }
    }
  }

  // Every concrete entity bound, all in one database.
  const databases = new Map<string, string>();
  for (const e of entities) {
    if (e.abstract) continue;
    const pe = bindingOf.get(e.name);
    if (!pe?.source) {
      errors.push(`${at}: entity '${e.name}' has no source in this profile`);
      continue;
    }
    const db = databaseOf(pe.source);
    if (!db) {
      errors.push(
          `${at}: entity '${e.name}' source '${pe.source}' is not a resource ` +
          `URI or a catalog name`);
    } else if (!databases.has(db)) {
      databases.set(db, e.name);
    }
  }
  if (databases.size > 1) {
    const named = [...databases.values()].map(n => `'${n}'`).join(', ');
    errors.push(
        `${at} binds entities in more than one database (${named}); a ` +
        `profile reads from one system a single query can reach`);
  }

  // A profile's key columns are physical column names.
  for (const pe of profile.entities) {
    const keyColumns = [...(pe.primaryKey ?? []), ...(pe.uniqueKeys ?? []).flat()];
    const bad = keyColumns.filter(c => !isColumnName(c));
    if (bad.length) {
      errors.push(
          `${at}: entity '${pe.name}' key column ${
              bad.map(c => `'${c}'`).join(', ')} is not a physical column ` +
          `name`);
    }
  }

  // Key shapes against the model file's, where it states keys.
  for (const e of entities) {
    const pe = bindingOf.get(e.name);
    if (!pe || e.abstract) continue;
    const inlineHasKey = e.keys.length > 0 || !!e.uniqueKeys?.length;
    if (!inlineHasKey) continue;
    if (pe.primaryKey !== undefined && pe.primaryKey.length !== e.keys.length) {
      errors.push(
          `${at}: entity '${e.name}' restates its primary key with ${
              pe.primaryKey.length} column(s); the model file's has ${
              e.keys.length}`);
    }
    if (pe.uniqueKeys !== undefined &&
        shapeOf(pe.uniqueKeys) !== shapeOf(e.uniqueKeys ?? [])) {
      errors.push(
          `${at}: entity '${e.name}' restates its unique keys as ${
              shapeOf(pe.uniqueKeys)}; the model file's are ${
              shapeOf(e.uniqueKeys ?? [])}`);
    }
  }

  // Every relationship bound, by the profile itself: a named profile states
  // both join column lists, and the model file's do not stand in for them
  // (Model Spec §4.2.2).
  for (const r of baseModel.relationships ?? []) {
    if (r.association) continue;
    const pr = profile.relationships.find(x => x.name === r.name);
    const from = pr?.fromColumns ?? [];
    const to = pr?.toColumns ?? [];
    if (!from.length || !to.length) {
      errors.push(
          `${at}: relationship '${r.name}' has no join columns in this ` +
          `profile; a named profile states both 'from_columns' and ` +
          `'to_columns' itself`);
    } else if (from.length !== to.length) {
      errors.push(
          `${at}: relationship '${r.name}' joins ${from.length} column(s) to ${
              to.length}`);
    } else {
      const bad = [...from, ...to].filter(c => !isColumnName(c));
      if (bad.length) {
        errors.push(
            `${at}: relationship '${r.name}' join column ${
                bad.map(c => `'${c}'`).join(', ')} is not a physical ` +
            `column name`);
      }
    }
  }

  // Every field the model file leaves unbound is accounted for, and exclusions
  // are closed under dependency. An exclusion applies to the entity that names
  // it, not to that entity's descendants (Model Spec §3.1.3, §4.2.2).
  const excluded = new Set<string>();
  for (const e of entities) {
    if (e.abstract) continue;
    const pe = bindingOf.get(e.name);
    for (const name of pe?.fieldsExclude ?? []) {
      excluded.add(`${e.name}.${name}`);
    }
    for (const f of seenOf.get(e.name)?.values() ?? []) {
      if (!isFieldBound(f)) {
        errors.push(
            `${at}: field '${e.name}.${f.name}' has no binding in the model ` +
            `file; bind it in 'fields' or leave it out in 'fields_exclude'`);
      }
    }
  }
  // Every bound field has a text this profile's database can run (mapping
  // §8.1). The profile's dialect is the one its sources infer (Model Spec
  // §4.4), checked once they all name one database.
  const system = databases.size === 1 ?
      [...databases.keys()][0].split('/')[0] :
      undefined;
  const dialect = system ? DIALECT_OF_SYSTEM[system] : undefined;
  if (dialect) {
    for (const e of entities) {
      if (e.abstract) continue;
      for (const f of seenOf.get(e.name)?.values() ?? []) {
        if (isFieldBound(f) && !runsOn(f, dialect)) {
          errors.push(
              `${at}: field '${e.name}.${f.name}' has no expression for ${
                  dialect} or ANSI_SQL, and this profile's sources are ${
                  dialect}`);
        }
      }
    }
  }

  // Each field that depends on an excluded one, and the excluded field it
  // reaches.
  const dangling = new Map<string, string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of entities) {
      if (e.abstract) continue;
      for (const f of seenOf.get(e.name)?.values() ?? []) {
        const key = `${e.name}.${f.name}`;
        if (excluded.has(key) || dangling.has(key)) continue;
        // A field reads only its own entity's fields (Model Spec §3.5.3). An
        // inherited field is read in the form its declaring ancestor wrote it,
        // because inheritance strips the qualifier when it copies one down.
        for (const dep of fieldDependencies(profiled, e.name, f.name)) {
          const target = `${e.name}.${dep}`;
          if (excluded.has(target) || dangling.has(target)) {
            dangling.set(key, dangling.get(target) ?? target);
            grew = true;
            break;
          }
        }
      }
    }
  }
  for (const [field, reached] of dangling) {
    errors.push(
        `${at}: field '${field}' depends on '${reached}', which this ` +
        `profile excludes; exclude '${field}' too, or rebind it`);
  }
  const why = (target: string) => excluded.has(target) ?
      'which this profile excludes' :
      `which depends on '${dangling.get(target)}', an excluded field`;
  if (profile.metricsExclude !== '*') {
    const metricExcluded = new Set(profile.metricsExclude ?? []);
    for (const m of baseModel.metrics ?? []) {
      if (metricExcluded.has(m.name)) continue;
      const texts = expressionTexts(m as Field);
      const reached = [...excluded, ...dangling.keys()].filter(target => {
        const [te, tf] = target.split('.');
        return texts.some(t => referencedEntityFields(t, te).includes(tf));
      });
      if (reached.length) {
        errors.push(
            `${at}: metric '${m.name}' reaches ${
                reached.map(r => `'${r}', ${why(r)}`).join('; ')}; add '${
                m.name}' to 'metrics_exclude'`);
      }
    }
  }
  return errors;
}

/**
 * Returns one message per way `profiles` disagree with each other about the
 * model, or an empty list:
 *   - where the model file states no key for an entity, either every profile
 *     states keys of one shape, or none does;
 *   - whether a relationship's `to_columns` cover the target's primary key, its
 *     k-th unique key, or neither, is the same in every binding that states the
 *     relationship's join columns, the model file's included, because
 *     cardinality is a property of the model (mapping Addendum 2 §2).
 */
export function validateProfileConsistency(
    baseModel: SemanticModel, profiles: ProfileSpec[]): string[] {
  const errors: string[] = [];
  const entities = baseModel.entities ?? [];
  const bindingIn = (p: ProfileSpec, entity: string) =>
      p.entities.find(e => e.name === entity);

  for (const e of entities) {
    if (e.abstract || e.keys.length || e.uniqueKeys?.length) continue;
    const shapes = new Map<string, string[]>();
    for (const p of profiles) {
      const pe = bindingIn(p, e.name);
      const shape = pe && (pe.primaryKey?.length || pe.uniqueKeys?.length) ?
          `primary key of ${pe.primaryKey?.length ?? 0}, unique keys ${
              shapeOf(pe.uniqueKeys ?? [])}` :
          'no keys';
      shapes.set(shape, [...(shapes.get(shape) ?? []), p.name]);
    }
    if (shapes.size > 1) {
      const detail =
          [...shapes].map(([s, ps]) => `${ps.join(', ')}: ${s}`).join('; ');
      errors.push(
          `entity '${e.name}' has no key in the model file, and its profiles ` +
          `disagree on one (${detail}); every profile states keys of one ` +
          `shape, or none does`);
    }
  }

  const byName = new Map(entities.map(e => [e.name, e]));
  for (const r of baseModel.relationships ?? []) {
    if (r.association) continue;
    const target = byName.get(r.destination.entity);
    if (!target) continue;
    // Mapping Addendum 2 §2: every binding that binds the relationship, by
    // stating its join columns, gives the same answer. A binding's keys are its
    // own where it states them and the model file's otherwise, and a binding
    // whose join columns cover no key answers "neither". A binding that states
    // no join columns does not bind the relationship and is left out; for a
    // named profile, completeness reports that.
    const answers = new Map<string, string[]>();
    const record =
        (who: string, to: string[], pk: string[], uks: string[][]) => {
          if (!to.length) return;
          const a = coverage(to, pk, uks);
          answers.set(a, [...(answers.get(a) ?? []), who]);
        };
    record(
        'the model file', r.destination.columns, target.keys,
        target.uniqueKeys ?? []);
    for (const p of profiles) {
      const pr = p.relationships.find(x => x.name === r.name);
      const pe = bindingIn(p, target.name);
      record(
          `profile '${p.name}'`, pr?.toColumns ?? [],
          pe?.primaryKey ?? target.keys,
          pe?.uniqueKeys ?? target.uniqueKeys ?? []);
    }
    if (answers.size > 1) {
      const detail =
          [...answers].map(([a, who]) => `${who.join(', ')}: ${a}`).join('; ');
      errors.push(
          `relationship '${r.name}' has a different cardinality under ` +
          `different bindings (${detail}); which key its 'to_columns' cover ` +
          `must be the same everywhere`);
    }
  }
  return errors;
}

// Each entity's fields, declared plus inherited, by name. Resolution throws on a
// broken hierarchy, which push reports elsewhere; this then falls back to
// declared fields.
function fieldsByEntity(model: SemanticModel): Map<string, Map<string, Field>> {
  let resolved: Entity[] = model.entities ?? [];
  if (resolved.some(e => e.extends?.length)) {
    try {
      resolved = resolveInheritance(model).model.entities ?? resolved;
    } catch {
      // keep the declared fields
    }
  }
  // Resolution already leaves excluded fields off; this covers a model with no
  // inheritance, which is not resolved, and a broken one.
  return new Map(resolved.map(e => {
    const excluded = new Set(e.excludedFields ?? []);
    return [
      e.name,
      new Map(e.fields.filter(f => !excluded.has(f.name)).map(f => [f.name, f])),
    ];
  }));
}

// The model as `profile` sees it: each field the profile binds takes that
// binding, as a binding-only redeclaration when the entity only inherits it,
// and each field the profile excludes is marked excluded on the entity that
// names it, which leaves it off that entity and nowhere else. This is what
// merging the profile and applyProfileExclusions do to the model.
function withProfile(model: SemanticModel, profile: ProfileSpec): SemanticModel {
  const out = structuredClone(model);
  const bindingOf = new Map(profile.entities.map(pe => [pe.name, pe]));
  for (const e of out.entities ?? []) {
    const pe = bindingOf.get(e.name);
    if (!pe || e.abstract) continue;
    for (const pf of pe.fields ?? []) {
      if (!isFieldBound(pf)) continue;
      const binding: Partial<Field> = {};
      for (const k of FIELD_BINDING_KEYS) {
        if (pf[k] !== undefined) (binding as any)[k] = pf[k];
      }
      const own = e.fields.find(f => f.name === pf.name);
      if (own) {
        for (const k of FIELD_BINDING_KEYS) delete own[k];
        Object.assign(own, binding);
      } else {
        e.fields.push({name: pf.name, ...binding});
      }
    }
    if (pe.fieldsExclude?.length) {
      e.excludedFields = [...new Set(pe.fieldsExclude)];
    }
  }
  return out;
}

// The message of the inheritance error resolving `model` throws, or undefined
// when it resolves.
function inheritanceErrorOf(model: SemanticModel): string|undefined {
  if (!(model.entities ?? []).some(e => e.extends?.length)) return undefined;
  try {
    resolveInheritance(model);
    return undefined;
  } catch (err: any) {
    return err?.message ?? String(err);
  }
}

// The fields of its own entity that `field` reads on `entityName`, from the
// expression as written: the entity's own declaration when it binds the field,
// otherwise that of the nearest ancestor that does, read with that ancestor's
// qualifier.
function fieldDependencies(
    model: SemanticModel, entityName: string, field: string): string[] {
  const byName = new Map((model.entities ?? []).map(e => [e.name, e]));
  const queue = [entityName];
  const seen = new Set<string>();
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const e = byName.get(name);
    const own = e?.fields.find(f => f.name === field && isFieldBound(f));
    if (own) {
      return [...new Set(expressionTexts(own).flatMap(
          t => referencedEntityFields(t, name)))];
    }
    queue.push(...(e?.extends ?? []));
  }
  return [];
}

// "[2, 1]": how many unique keys, and how wide each is.
function shapeOf(keys: string[][]): string {
  return `[${keys.map(k => k.length).join(', ')}]`;
}

// Which key of the target `to` covers: its primary key, its k-th unique key
// (from 1), or neither.
function coverage(to: string[], pk: string[], uks: string[][]): string {
  // `to` covers a key when it is exactly that key's columns, each once, in any
  // order. A superset covers no key until the spec says otherwise.
  const same = (a: string[], b: string[]) => a.length > 0 &&
      a.length === b.length && new Set(a).size === a.length &&
      a.every(c => b.includes(c));
  if (same(to, pk)) return 'the primary key';
  const k = uks.findIndex(u => same(to, u));
  return k >= 0 ? `unique key ${k + 1}` : 'no key';
}
