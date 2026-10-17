// Applies a chosen binding profile to a logical semantic model, and prunes what
// the resulting binding cannot answer.
//
// A model is authored as ONE logical declaration (entities, fields,
// relationships, metrics, the grain, and the graph shape) plus zero or more
// BINDING PROFILES that supply the physical facets it leaves open: each entity's
// `source`, each field's column (`expression`) and each action's `executor`. An
// old-style `semantic_model:` profile may also name a deployment target.
// `kcmd push --profile <name>` applies the selected profile to the logical
// model BY NAME and deploys the result. See docs/semantic-model/profiles.md.
//
// Three passes live here:
//   - applyProfile applies a profile, read into a ProfileSpec, to a loaded
//     model. Push, `kcmd profiles`, the runtime and the profile checks apply a
//     profile file this way, and a profile held in memory is applied the same
//     way. Push, `kcmd profiles` and the runtime start at profileForDocument,
//     which finds the profile by name and loads the model file on its own
//     (applyToDocument). A file is read with loadProfileFile.
//     applyProfileSpec then checks what the profile may set
//     (profileApplyError), sets the values (applyBindings) and gives the
//     warnings (warningsAfterProfile). applyProfile and applyProfileFile take
//     the same steps for a model already loaded, and the completeness check
//     applies the bindings with applyBindings.
//   - mergeProfile overlays one profile document onto the logical document,
//     enforcing the binding-only contract: a profile rebinds what it names,
//     leaves everything else as the model file has it, may exclude fields and
//     metrics, and may not add elements or change what anything means. It runs
//     on the parsed authoring documents (the readable, sugared form) before
//     schema validation, so a profile is written in the same syntax as the
//     model. Only the legacy `semantic_model:` wrapper still goes through it.
//   - pruneUnavailable runs over the loaded IR and drops each field left unbound
//     or excluded, every field that reads one of those, and every metric whose
//     expression reads any of them, returning the pruned model and a
//     per-profile availability report. Keys and join columns are physical
//     columns rather than fields, so pruning fields never removes an entity or
//     a relationship.

import * as yaml from 'yaml';

import {Action, Entity, expressionForDialect, Field, FIELD_BINDING_KEYS, fieldBinding, isFieldBound, Metric, ProfileEntityBinding, ProfileRelationshipBinding, ProfileSpec, Relationship, SemanticModel, SqlDialect} from './ir';
import {databaseOf, DEFAULT_DIALECT, entityAndMetricWarnings, expressionDocOf, halfBoundJoinMessage, inferMetricEntities, inheritedNoSqlProblems, isAcceptedSource, joinLengthMessage, LoadOptions, loadSemanticModels, noSqlReason, parseExecutor, parseFieldBinding, parseFieldExpression, parseSource, readFieldExpression, SemanticModelError} from './loader';
import {declaredConceptFields, InheritanceError, resolveInheritance} from './resolve_inheritance';
import {columnReferences, entitiesReached, fieldsReadOn, isColumnName, keysCoveredByColumns} from './sql_expr_utils';
import {SqlColumn} from './sql_parser';
import {YAML_OPTIONS} from './yaml_options';

// The implicit profile: the inline bindings already in the model document (the
// combined single-file form). It is never merged -- it IS the document as
// authored -- so a bare `kcmd push` behaves as it always has.
export const DEFAULT_PROFILE = 'default';

// A profile name: a letter, then letters, digits, underscores and hyphens, at
// most 500 characters. A profile name never appears in SQL, so a hyphen is
// safe.
export const PROFILE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,499}$/;

export interface MergeResult {
  // The merged authoring document (still in the sugared form), ready to feed
  // through the normal loader.
  doc: unknown;
  warnings: string[];
  // A binding-only or unknown-name violation, naming the offending path. When
  // set, `doc` should not be deployed.
  error?: string;
  // The fields and metrics the profile excludes. The merged document keeps
  // them all, so a catalog push publishes the whole logical model. Apply them
  // to the loaded model with applyProfileExclusions before pruning: a field
  // exclusion applies to the entity that names it and not to its descendants,
  // which the merged document alone cannot say.
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
      error: sqlExecutorMessage(
          profileName, sqlInLogical.action, sqlInLogical.model),
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
 * metric. Returns a copy when anything applies, and `model` itself otherwise;
 * the input is never mutated.
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
// is read first exactly as loadProfileFile reads it. The commands apply a
// profile file with applyProfileFile instead; the tests merge profile files
// here, as the result applyProfile must match.
function mergeProfileFile(
    lm: any, pf: any, profileName: string,
    excluded: ProfileExclusion[]): string|undefined {
  try {
    profileSpecOf(pf, profileName);
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
    return err.message;
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
    delete lm.deployments;
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
    // An abstract entity has no table, so no profile binds it.
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
  // An exclusion applies to this entity only. The
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
      // since a redeclaration with nothing but the name is rejected. The
      // entity still inherits the declaration.
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
  // A profile file's entry always has an expression (profileSpecOf rejects one
  // without). The legacy wrapper form may list a field with none, and it is
  // removed with that form.
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
  // No pruning rule drops an entity or a relationship, so droppedEntities and
  // droppedRelationships are always empty (see the file header).
  droppedEntities: {name: string; reason: string}[];
  droppedMetrics: {name: string; reason: string}[];
  droppedRelationships: {name: string; reason: string}[];
  // An action this profile cannot perform: it binds no executor for it.
  droppedActions: {name: string; reason: string}[];
  // A bound field that reads an unavailable field of its entity, directly or
  // through other fields, so it cannot be computed either. "Entity.field".
  droppedFields: {name: string; reason: string}[];
  // A field or metric whose SQL the parser cannot read, so the fields that SQL
  // reads were not checked. A metric is kept; a field is judged on what could
  // be read.
  warnings: string[];
}

/**
 * Returns a clone of `model` reduced to what `profileName` can answer: unbound
 * and excluded fields taken off their entities, with every field that reads
 * one of them, directly or through other fields; every excluded metric and
 * every metric that reads an unavailable field dropped; and every action with
 * no executor dropped. A field counts whether the entity declares or inherits
 * it. What a field or metric reads comes from the text `dialect` evaluates,
 * which defaults to the dialect the model's sources imply, and from the text
 * the graph generators emit (see prunedTexts). When the sources are in
 * systems of different dialects, or one names no system, there is no dialect
 * and every text counts.
 * The input is never mutated. The report names each dropped block
 * and the unbound field that stops it, so a caller can state the withheld
 * coverage. A model with nothing unbound resolves unchanged.
 */
export function pruneUnavailable(
    model: SemanticModel, profileName: string,
    dialect: string|undefined = sourcesDialect(model)):
    {model: SemanticModel; report: AvailabilityReport} {
  const clone: SemanticModel = structuredClone(model);
  const report: AvailabilityReport = {
    profile: profileName,
    unboundFields: [],
    droppedEntities: [],
    droppedMetrics: [],
    droppedRelationships: [],
    droppedActions: [],
    droppedFields: [],
    warnings: [],
  };

  // A field is bound when isFieldBound says so; otherwise it is unbound
  // (structurally absent under this profile). isFieldBound is the shared
  // predicate the generator also uses, so a field awaiting transpilation (its
  // column carried on the imported expression) counts as bound, not dropped.
  //
  // Availability is judged on each entity's resolved fields, declared plus
  // inherited, since a metric can read an inherited field as readily as a
  // declared one. A field the profile excludes on an entity is unavailable on
  // that entity.
  const unbound = new Set<string>();
  const resolved = resolvedEntities(clone);
  for (const e of resolved) {
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

  // A field that reads an unavailable field of its entity is unavailable too,
  // and so is every field and metric that reads it in turn. Each field's
  // dependencies are read once, and only when something is unbound.
  const unavailable = new Set(unbound);
  const unreadable = new Set<string>();
  const dependencies = new Map<string, string[]>();
  if (unbound.size) {
    for (const e of resolved) {
      if (e.abstract) continue;
      for (const f of e.fields ?? []) {
        const key = `${e.name}.${f.name}`;
        if (unbound.has(key)) continue;
        dependencies.set(
            key,
            fieldDependencies(
                clone, e.name, f.name, unreadable, dialect, prunedTexts)
                .map(dep => `${e.name}.${dep}`));
      }
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [key, deps] of dependencies) {
      if (unavailable.has(key)) continue;
      const reached = deps.find(target => unavailable.has(target));
      if (reached) {
        unavailable.add(key);
        report.droppedFields.push(
            {name: key, reason: `reads ${reached}, which is unavailable`});
        grew = true;
      }
    }
  }
  for (const what of unreadable) {
    report.warnings.push(
        `${what}: kcmd could not read its SQL, so the fields it reads were ` +
        `not checked`);
  }

  // Keys and join columns are physical column names, not fields, so whether a
  // field is bound says nothing about them. Excluding a field that happens to
  // share a key column's name drops the field and nothing else.
  const allEntityNames = (clone.entities ?? []).map(e => e.name);

  // Take unbound and excluded fields off the entities that declare them. (A
  // bound field whose value is null still emits a column -- unbound is not
  // null.) A declaration that a descendant inherits stays, so the descendant
  // keeps the definition and whatever binding it has, and is marked excluded on
  // the declaring entity instead, since a binding is a fact about one table.
  const extendedNames = new Set(
      resolvedEntities(clone).flatMap(e => e.extends ?? []));
  for (const e of clone.entities ?? []) {
    // Keep an abstract entity's fields intact: they are column-less by design
    // and name the shared label's property set for the emitter (see above).
    if (e.abstract) continue;
    // An inherited field that is unavailable on this entity is marked excluded
    // here, whether it is unbound, excluded, or reads such a field. Removing
    // this entity's line alone, or having none to remove, would let inheritance
    // hand back the ancestor's definition and binding.
    const inheritedUnavailable = [...inheritedNamesOf(clone, e.name)].filter(
        name => unavailable.has(`${e.name}.${name}`));
    const excluded = new Set(e.excludedFields ?? []);
    const gone = (f: Field) => !isFieldBound(f) || excluded.has(f.name) ||
        unavailable.has(`${e.name}.${f.name}`);
    if (extendedNames.has(e.name)) {
      const kept = (e.fields ?? []).filter(gone).map(f => f.name);
      if (kept.length) {
        e.excludedFields = [...new Set([...excluded, ...kept])];
      }
    } else {
      e.fields = (e.fields ?? []).filter(f => !gone(f));
    }
    if (inheritedUnavailable.length) {
      e.excludedFields =
          [...new Set([...(e.excludedFields ?? []), ...inheritedUnavailable])];
    }
  }

  // A relationship's join columns are its own binding, so pruning fields never
  // removes one.
  const keptRels: Relationship[] = clone.relationships ?? [];

  // A metric is available only when the profile does not exclude it, every
  // field it reads is available, and -- when it spans entities -- a
  // relationship connects them.
  const excludedMetrics = new Set(clone.excludedMetrics ?? []);
  delete clone.excludedMetrics;
  const keptMetrics: Metric[] = [];
  for (const mt of clone.metrics ?? []) {
    if (excludedMetrics.has(mt.name)) {
      report.droppedMetrics.push({name: mt.name, reason: 'excluded'});
      continue;
    }
    const columns: SqlColumn[] = [];
    // A text with no SQL has nothing to read.
    const sources = prunedTexts(mt, dialect)
                        .filter(s => noSqlReason(s.text, s.dialect) === undefined);
    let unread = 0;
    for (const {text, dialect} of sources) {
      const read = columnReferences(text, dialect);
      if (read) {
        columns.push(...read);
      } else {
        unread++;
      }
    }
    const hit = firstUnboundReferenced(columns, unavailable);
    if (hit) {
      report.droppedMetrics.push({
        name: mt.name,
        reason: `field ${hit} is ${unbound.has(hit) ? 'unbound' : 'unavailable'}`,
      });
      continue;
    }
    const refs = entitiesReached(columns, allEntityNames);
    if (refs.length > 1 && !connectingRelationshipKept(refs, keptRels)) {
      report.droppedMetrics.push({
        name: mt.name,
        reason: `no available relationship connects ${refs.join(', ')}`,
      });
      continue;
    }
    // A text the parser cannot read is skipped, so what it reads is unknown.
    if (unread) {
      report.warnings.push(
          unread === sources.length ?
              `metric '${mt.name}': kcmd could not read its SQL, so the ` +
                  `fields it reads were not checked` :
              `metric '${mt.name}': kcmd could not read some of its SQL, so ` +
                  `the fields that SQL reads were not checked`);
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
  } catch (err) {
    if (!(err instanceof InheritanceError)) throw err;
    return entities;
  }
}

// The names of the fields `entityName` inherits from every ancestor its
// `extends` reaches. A caller asking for many entities passes `byName`, the
// model's entities by name, built once.
function inheritedNamesOf(
    model: SemanticModel, entityName: string,
    byName = new Map((model.entities ?? []).map(e => [e.name, e]))):
    Set<string> {
  return new Set(ancestorsOf(entityName, byName)
                     .flatMap(a => (a.fields ?? []).map(f => f.name)));
}

// Every ancestor `entityName`'s `extends` reaches, each once. `byName` is the
// model's entities by name.
function ancestorsOf(
    entityName: string, byName: Map<string, Entity>): Entity[] {
  const ancestors: Entity[] = [];
  const seen = new Set<string>([entityName]);
  const queue = [...(byName.get(entityName)?.extends ?? [])];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const ancestor = byName.get(name);
    if (!ancestor) continue;
    ancestors.push(ancestor);
    queue.push(...(ancestor.extends ?? []));
  }
  return ancestors;
}

// The first unbound "Entity.field" among the columns a metric expression
// reads, or null.
function firstUnboundReferenced(columns: SqlColumn[], unbound: Set<string>):
    string|null {
  for (const key of unbound) {
    const dot = key.indexOf('.');
    if (fieldsReadOn(columns, key.slice(0, dot)).includes(key.slice(dot + 1))) {
      return key;
    }
  }
  return null;
}

// The dialect `text` is written in on `f`: the dialect of the list entry that
// holds it, the imported dialect for the imported text, and BigQuery
// otherwise, since the loader fills `expression` from a `BIGQUERY` or
// `ANSI_SQL` entry.
function dialectOf(
    f: Pick<Field, 'dialects'|'importedExpression'|'importedDialect'>,
    text: string): string {
  const entry = f.dialects?.find(d => d.expression === text);
  if (entry) return entry.dialect;
  if (text === f.importedExpression && f.importedDialect) {
    return f.importedDialect;
  }
  return 'BIGQUERY';
}

// Whether any relationship directly connects two of the referenced entities --
// the minimal check that a cross-entity metric has a join path.
function connectingRelationshipKept(
    refEntities: string[], kept: Relationship[]): boolean {
  const set = new Set(refEntities);
  return kept.some(
      r => set.has(r.source.entity) && set.has(r.destination.entity));
}


// Whether a profile text is in the profile file form (a top-level profile
// object) rather than the legacy `semantic_model:` wrapper.
export function isProfileFileForm(text: string): boolean {
  try {
    const doc = yaml.parse(text, YAML_OPTIONS);
    return !!doc && typeof doc === 'object' && !Array.isArray(doc) &&
        (doc as any).semantic_model === undefined;
  } catch {
    return false;
  }
}

/**
 * Parses a logical model document and a binding profile document, merges the
 * profile onto the model by name, and returns the merged authoring text plus
 * any merge warnings. Push, `profiles` and creating a runtime use it for the
 * legacy `semantic_model:` wrapper, and apply a profile file with
 * applyProfileFile. The tests merge profile files too, as the result
 * applyProfile must match. On a parse error or a binding-contract violation it
 * returns `error` for the caller to surface. `deploymentTarget` is set when
 * the merged model names its target with a `deployment_target` key, which the
 * loader turns into a deployment named `default`.
 */
export function mergeProfileOntoDoc(
    logicalText: string, profileText: string, profileName: string): {
  text: string;
  warnings: string[];
  excluded: ProfileExclusion[];
  deploymentTarget: boolean;
}|{error: string} {
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
  const models: any[] = (merged.doc as any).semantic_model;
  return {
    text: yaml.stringify(merged.doc),
    warnings: merged.warnings,
    excluded: merged.excluded,
    deploymentTarget: models.some(m => m?.deployment_target !== undefined),
  };
}


/**
 * Reads a profile file -- the top-level profile object `mergeProfile` also
 * accepts -- into the IR's `ProfileSpec`. Throws on anything a profile may not
 * say: an unknown key at any level, a value of the wrong shape, a field in both
 * `fields` and `fields_exclude`, `"*"` inside a `metrics_exclude` list, or a
 * `name` other than `profileName`. A field expression and an action's
 * executor are read by the loader's own readers, so each follows the rules it
 * follows in a model file. A source is kept as written, and applyProfile reads
 * it with the loader's reader too. A field expression's short form means
 * `ANSI_SQL` in either flavor. Actions are out of scope for the preview, so
 * nothing more is checked.
 */
export function loadProfileFile(text: string, profileName: string):
    ProfileSpec {
  let doc: any;
  try {
    doc = yaml.parse(text, YAML_OPTIONS);
  } catch (err: any) {
    throw new SemanticModelError(
        `profile '${profileName}' does not parse: ${err?.message ?? err}`);
  }
  return profileSpecOf(doc, profileName);
}

/** How a profile's values are read, matching the load of the model. */
export interface ApplyProfileOptions {
  // The preferred dialect the model was loaded with, which picks the text each
  // field takes.
  load?: Pick<LoadOptions, 'dialect'>;
  // Collects the warnings a load gives for the values the profile sets.
  // applyProfile only; the other functions return them.
  warnings?: string[];
  // The load of the model file the profile applies to: its document name and
  // its warnings. The warnings about values the profile replaces are dropped.
  from?: {document: string; warnings: string[]};
}

/**
 * Returns a copy of `model` with `profile` applied: each named entity's
 * source, its keys where the profile states them, its field bindings, as a
 * binding-only redeclaration for a field the entity inherits, and its
 * `fields_exclude`; each relationship's join columns; `metrics_exclude`; and
 * each action's executor, which is taken as given, since actions are out of
 * preview scope. A field a profile binds keeps every dialect text the profile
 * wrote. An excluded field is marked in `excludedFields`, and loses its
 * binding when no entity inherits it. The input is never mutated.
 *
 * Throws, naming the profile, when the profile repeats a name, leaves a field
 * entry with nothing to bind, both binds and excludes a field, puts "*" inside
 * a list, names something the model does not declare, binds an abstract
 * entity, gives join columns a load would reject, gives a source or
 * expression the loader's readers reject, or is applied to a model that
 * declares a `sql` executor, which belongs in each profile.
 */
export function applyProfile(
    model: SemanticModel, profile: ProfileSpec,
    opts: Omit<ApplyProfileOptions, 'from'> = {}): SemanticModel {
  const res = applyProfileSpec(model, profile, opts);
  if ('error' in res) throw new SemanticModelError(res.error);
  if (opts.warnings) {
    // With no `from`, these are the applied model's entity and metric
    // warnings, judged in the load dialect as the callers judge them. Keep
    // those the model did not give already.
    const before = new Set(entityAndMetricWarnings(
        model, opts.load?.dialect ?? DEFAULT_DIALECT));
    opts.warnings.push(...res.warnings.filter(w => !before.has(w)));
  }
  return res.model;
}

/**
 * Reads the profile file `text` and applies it to `model`, or returns the
 * error that stops it, naming the profile. The warnings are those of the
 * model file's load (`opts.from`), less the ones about values the profile
 * replaces, followed by those for the values it sets, each prefixed with the
 * document name. Callers use it for a text in profile-file form (see
 * isProfileFileForm).
 */
export function applyProfileFile(
    model: SemanticModel, text: string, profileName: string,
    opts: Omit<ApplyProfileOptions, 'warnings'> = {}):
    {model: SemanticModel; warnings: string[]}|{error: string} {
  // Checked before the profile is read, as the merge does, so the same error
  // comes first. profileApplyError checks it again for a profile built in
  // memory.
  const sql = logicalSqlExecutorError(model, profileName);
  if (sql) return {error: sql};
  let profile: ProfileSpec;
  try {
    profile = loadProfileFile(text, profileName);
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
    return {error: err.message};
  }
  return applyProfileSpec(model, profile, opts);
}

// applyProfile and applyProfileFile's shared work: the reasons a profile
// cannot apply, the bindings, and the warnings that follow.
function applyProfileSpec(
    model: SemanticModel, profile: ProfileSpec,
    opts: Omit<ApplyProfileOptions, 'warnings'>):
    {model: SemanticModel; warnings: string[]}|{error: string} {
  const error = profileApplyError(model, profile);
  if (error) return {error};
  const applied = applyBindings(model, profile, opts);
  if (applied.errors.length) {
    return {error: `profile '${profile.name}': ${applied.errors[0]}`};
  }
  // A field the profile binds is checked on each entity that inherits it, as
  // a load checks a model file's. A model whose inheritance does not resolve
  // is reported by validation instead.
  let concepts;
  try {
    concepts = declaredConceptFields(applied.model);
  } catch (err) {
    if (!(err instanceof InheritanceError)) throw err;
  }
  const inherited =
      concepts && inheritedNoSqlProblems(applied.model.entities, concepts)[0];
  if (inherited) return {error: `profile '${profile.name}': ${inherited}`};
  return {
    model: applied.model,
    warnings: warningsAfterProfile(model, applied.model, opts),
  };
}

/** A profile applied to a model document loaded on its own. */
export interface AppliedProfile {
  // The model document as it loads on its own, and with the profile applied.
  base: SemanticModel;
  model: SemanticModel;
  // The document's load warnings, less those the profile settles, then those
  // its values give, each prefixed with the document name.
  warnings: string[];
  // Each concrete entity left with no source, which a pruned push rejects.
  sourceless: string[];
}

/**
 * Loads the model document `doc` on its own and applies `profile` to it. An
 * error says whether the document failed to load or the profile failed to
 * apply, since the callers word the two differently.
 */
function applyProfileToDocument(
    doc: {name: string; text: string}, profile: ProfileSpec): AppliedProfile|
    {error: string; stage: 'load'|'apply'} {
  return applyToDocument(
      doc, (base, from) => applyProfileSpec(base, profile, {from}));
}

/** applyProfileToDocument for the profile file `text`. */
function applyProfileFileToDocument(
    doc: {name: string; text: string}, text: string,
    profileName: string): AppliedProfile|
    {error: string; stage: 'load'|'apply'} {
  return applyToDocument(
      doc, (base, from) => applyProfileFile(base, text, profileName, {from}));
}

function applyToDocument(
    doc: {name: string; text: string},
    apply: (base: SemanticModel,
            from: {document: string; warnings: string[]}) =>
        {model: SemanticModel; warnings: string[]}|{error: string}):
    AppliedProfile|{error: string; stage: 'load'|'apply'} {
  const loaded = loadSemanticModels(
      [{name: doc.name, text: doc.text}], {bindingOptional: true});
  if (loaded.error) return {error: loaded.error, stage: 'load'};
  const base = loaded.models[0].model;
  const res = apply(base, {document: doc.name, warnings: loaded.warnings});
  if ('error' in res) return {error: res.error, stage: 'apply'};
  const sourceless = (res.model.entities ?? [])
                         .filter(e => !e.abstract && !e.dataSource)
                         .map(e => e.name);
  return {base, model: res.model, warnings: res.warnings, sourceless};
}

/**
 * A profile a model declares: the text of a profile file or a legacy wrapper,
 * or a profile already read, such as one a vanilla model carries in its GOOGLE
 * block.
 */
export type DeclaredProfile = {name: string; text: string}|
    {name: string; spec: ProfileSpec};

/** A profile, in either form, applied to one model document. */
export type DocumentProfile = ({kind: 'file'}&AppliedProfile)|{
  // A legacy `semantic_model:` wrapper, merged into the document's text.
  // `deploymentTarget` is set when the merged model names its target with a
  // `deployment_target` key.
  kind: 'wrapper';
  text: string;
  excluded: ProfileExclusion[];
  warnings: string[];
  deploymentTarget: boolean;
}|{kind: 'error'; error: string; stage: 'load'|'apply'}|{
  // The document declares no profile by that name.
  kind: 'missing';
  declared: string[];
};

/**
 * Finds the profile `profileName` among `profiles`, the ones the model
 * document `doc` declares, and applies it, as push, `kcmd profiles` and the
 * runtime do. A profile file, or a profile already read, applies to the
 * document loaded on its own. A legacy `semantic_model:` wrapper merges into
 * the document's text until b/568186042 stops selecting it.
 */
export function profileForDocument(
    doc: {name: string; text: string}, profiles: DeclaredProfile[],
    profileName: string): DocumentProfile {
  const chosen = profiles.find(p => p.name === profileName);
  if (!chosen) return {kind: 'missing', declared: profiles.map(p => p.name)};
  if ('spec' in chosen || isProfileFileForm(chosen.text)) {
    const res = 'spec' in chosen ?
        applyProfileToDocument(doc, chosen.spec) :
        applyProfileFileToDocument(doc, chosen.text, profileName);
    return 'error' in res ? {kind: 'error', ...res} : {kind: 'file', ...res};
  }
  const res = mergeProfileOntoDoc(doc.text, chosen.text, profileName);
  if ('error' in res) return {kind: 'error', error: res.error, stage: 'apply'};
  return {kind: 'wrapper', ...res};
}

/**
 * `error`, from loading a model document on its own before a profile file
 * applies to it, with a note that says so. A model file that a profile used to
 * complete, such as one with a half-given join, fails that load. Names
 * `profileName` when one profile is selected.
 */
export function modelFileAloneMessage(
    error: string, profileName?: string): string {
  return profileName === undefined ?
      `${error} (the model file must load on its own before a profile file ` +
          `applies)` :
      `${error} (under profile '${profileName}', the model file must load ` +
          `on its own before the profile applies)`;
}

/** The error for a profile name a model document does not declare. */
export function unknownProfileMessage(
    profileName: string, model: string, declared: string[]): string {
  return `unknown binding profile '${profileName}' for model '${model}'; ` +
      (declared.length ? `defined profiles: ${declared.join(', ')}.` :
                         `no profiles are defined for this model.`);
}

/**
 * The error for a model document `docName` whose `profiles` include one named
 * `default` in any letter case. Push refuses every graph push of such a
 * model, and the runtime refuses the model too. Undefined when no profile has
 * that name.
 */
export function reservedProfileNameError(
    docName: string, profiles: {name: string}[]): string|undefined {
  if (!profiles.some(p => p.name.toLowerCase() === DEFAULT_PROFILE)) {
    return undefined;
  }
  return `[${docName}] a binding profile may not be named '${
             DEFAULT_PROFILE}' -- that name refers to the model's inline ` +
      `bindings. Rename the profile file.`;
}

/** The error for a concrete entity no profile file or model file binds. */
export function profileSourceMessage(entity: string): string {
  return `entity '${entity}' has no source in this profile or in the model ` +
      `file`;
}

// The warnings a load of the applied model would give, each prefixed with the
// document name: those about its entities and metrics, from
// entityAndMetricWarnings, which builds them with the helpers the load uses,
// then the model file's other load warnings, about actions, which a profile
// does not change. That is the order a load gives them. The applied model is
// judged in the load's dialect, which picked the text each field holds and
// the generators emit.
function warningsAfterProfile(
    model: SemanticModel, applied: SemanticModel,
    opts: Omit<ApplyProfileOptions, 'warnings'>): string[] {
  const from = opts.from;
  const prefix = from ? `[${from.document}] ` : '';
  const preferred = opts.load?.dialect ?? DEFAULT_DIALECT;
  const before =
      new Set(entityAndMetricWarnings(model, preferred).map(w => prefix + w));
  const kept = (from?.warnings ?? []).filter(w => !before.has(w));
  const after =
      entityAndMetricWarnings(applied, preferred).map(w => prefix + w);
  return [...new Set([...after, ...kept])];
}

// Every reason `profile` names something `model` cannot take, in the order the
// YAML merge checks: a `sql` executor in the model, the profile's own
// structure, and each action, entity, field, relationship and metric it names
// that the model does not declare or a profile cannot bind. applyProfile
// throws the first, and validateProfileCompleteness lists them all.
function profileProblems(model: SemanticModel, profile: ProfileSpec): string[] {
  const at = `profile '${profile.name}'`;
  const problems: string[] = [];
  const sql = logicalSqlExecutorError(model, profile.name);
  if (sql) problems.push(sql);
  problems.push(...profileStructureErrors(profile));
  const actions = new Set((model.actions ?? []).map(a => a.name));
  for (const pa of profile.actions ?? []) {
    if (!actions.has(pa.name)) {
      problems.push(`${at}: action '${pa.name}' is not in the logical model`);
    }
  }
  const byName = new Map((model.entities ?? []).map(e => [e.name, e]));
  for (const pe of profile.entities) {
    const e = byName.get(pe.name);
    if (!e) {
      problems.push(`${at}: entity '${pe.name}' is not in the logical model`);
      continue;
    }
    if (e.abstract) {
      problems.push(
          `${at}: entity '${pe.name}' is abstract, so a profile cannot ` +
          `bind it`);
      continue;
    }
    const declared = new Set(e.fields.map(f => f.name));
    const inherited = inheritedNamesOf(model, e.name, byName);
    for (const pf of pe.fields ?? []) {
      if (!declared.has(pf.name) && !inherited.has(pf.name)) {
        problems.push(`${at}: field '${pe.name}.${
            pf.name}' is not in the logical model`);
      }
    }
    for (const name of pe.fieldsExclude ?? []) {
      if (!declared.has(name) && !inherited.has(name)) {
        problems.push(`${at}: field '${pe.name}.${
            name}' in 'fields_exclude' is not in the logical model`);
      }
    }
  }
  const relationships = new Set((model.relationships ?? []).map(r => r.name));
  for (const pr of profile.relationships) {
    if (!relationships.has(pr.name)) {
      problems.push(
          `${at}: relationship '${pr.name}' is not in the logical model`);
    }
  }
  if (Array.isArray(profile.metricsExclude)) {
    const metrics = new Set((model.metrics ?? []).map(m => m.name));
    for (const name of profile.metricsExclude) {
      if (!metrics.has(name)) {
        problems.push(`${at}: metric '${
            name}' in 'metrics_exclude' is not in the logical model`);
      }
    }
  }
  return problems;
}

// Why `profile` cannot apply to `model`, or undefined: the first of
// profileProblems, then the join columns each relationship ends up with,
// checked as a load checks them: both lists or neither, of equal length.
function profileApplyError(
    model: SemanticModel, profile: ProfileSpec): string|undefined {
  const problems = profileProblems(model, profile);
  if (problems.length) return problems[0];
  const at = `profile '${profile.name}'`;
  for (const pr of profile.relationships) {
    const r = (model.relationships ?? []).find(x => x.name === pr.name)!;
    const from = pr.fromColumns.length ? pr.fromColumns : r.source.columns;
    const to = pr.toColumns.length ? pr.toColumns : r.destination.columns;
    if (!from.length !== !to.length) {
      return `${at}: ${halfBoundJoinMessage(r.name)}`;
    }
    if (from.length !== to.length) {
      return `${at}: ${joinLengthMessage(r.name, from.length, to.length)}`;
    }
  }
  return undefined;
}

// What loadProfileFile rejects in a profile's structure, in the order it
// checks, with its messages: a repeated name, a field entry with nothing to
// bind, a repeated dialect, a field both bound and excluded, and `"*"` inside
// a list. A profile file never has these; a profile built in memory may.
function profileStructureErrors(profile: ProfileSpec): string[] {
  const at = `profile '${profile.name}'`;
  const errors: string[] = [];
  const twice = (names: string[]) =>
      names.find((n, i) => names.indexOf(n) !== i);
  const dupEntity = twice(profile.entities.map(e => e.name));
  if (dupEntity) errors.push(`${at} 'entities' lists '${dupEntity}' twice`);
  for (const pe of profile.entities) {
    const where = `${at}: entity '${pe.name}'`;
    const bound = (pe.fields ?? []).map(f => f.name);
    const dupField = twice(bound);
    if (dupField) errors.push(`${where} 'fields' lists '${dupField}' twice`);
    for (const pf of pe.fields ?? []) {
      const fat = `${where}: field '${pf.name}'`;
      if (!pf.dialects?.length && !isFieldBound(pf as Field)) {
        errors.push(
            `${fat} has no 'expression'; bind it with one, or list it in ` +
            `'fields_exclude'`);
      }
      // Checked by the loader's reader, as a profile file's is. A binding
      // with no dialect list, which only a profile built in memory has, is
      // read as parseFieldBinding reads it.
      if (expressionDocOf(pf) !== undefined) {
        try {
          parseFieldBinding(pf, fat, DEFAULT_DIALECT, pe.name);
        } catch (err) {
          if (!(err instanceof SemanticModelError)) throw err;
          errors.push(err.message);
        }
      }
    }
    const both = (pe.fieldsExclude ?? []).find(n => bound.includes(n));
    if (both) {
      errors.push(
          `${where}: field '${both}' is in both 'fields' and ` +
          `'fields_exclude'`);
    }
  }
  const dupRel = twice(profile.relationships.map(r => r.name));
  if (dupRel) errors.push(`${at} 'relationships' lists '${dupRel}' twice`);
  if (Array.isArray(profile.metricsExclude) &&
      profile.metricsExclude.includes('*')) {
    errors.push(
        `${at}: 'metrics_exclude' takes "*" on its own, not inside a list`);
  }
  return errors;
}

// The error for a model that declares a `sql` executor when a profile binds
// it: a statement names one database's tables, so it belongs in the profile.
function logicalSqlExecutorError(
    model: SemanticModel, profileName: string): string|undefined {
  const action = (model.actions ?? []).find(a => a.executor?.kind === 'sql');
  return action && sqlExecutorMessage(profileName, action.name, model.name);
}

// The error for a `sql` executor in a model that a profile applies to.
function sqlExecutorMessage(
    profileName: string, action: string, model: string): string {
  return `profile '${profileName}': action '${action}' in model '${
             model}' declares a 'sql' executor. A statement names one ` +
      `database's own tables and columns, so it belongs in the profile that ` +
      `binds them, not in the model. Move the executor into each profile ` +
      `that performs this write as DML.`;
}

// Applies what `profile` sets on the names `model` declares, and skips any
// name it does not. applyProfile checks the names first; the profile checks
// report each unknown name themselves. With `noSqlAsWritten`, a field binding
// the reader rejects only for holding no SQL is applied as a valid one is.
function applyBindings(
    model: SemanticModel, profile: ProfileSpec,
    opts: ApplyProfileOptions&{noSqlAsWritten?: boolean}):
    {model: SemanticModel; errors: string[]} {
  const errors: string[] = [];
  const out: SemanticModel = structuredClone(model);
  const load = opts.load ?? {};
  const preferred = load.dialect ?? DEFAULT_DIALECT;
  // A source or expression the loader's readers reject is left unapplied. A
  // rejected source is listed in `errors`. A rejected expression is not:
  // profileStructureErrors reports it first, in the words a profile file gets,
  // and every caller runs it before this.
  const read = <T>(readValue: () => T, list: boolean): T|undefined => {
    try {
      return readValue();
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
      if (list) errors.push(readerMessage(err));
      return undefined;
    }
  };
  // An executor the profile leaves out stays as the model declares it; `null`
  // withdraws it.
  for (const pa of profile.actions ?? []) {
    const a = (out.actions ?? []).find(x => x.name === pa.name);
    if (!a || pa.executor === undefined) continue;
    if (pa.executor === null) {
      delete a.executor;
    } else {
      a.executor = structuredClone(pa.executor);
    }
  }
  const byName = new Map((out.entities ?? []).map(e => [e.name, e]));
  const extended = entitiesWithDescendants(out);
  for (const pe of profile.entities) {
    const e = byName.get(pe.name);
    if (!e || e.abstract) continue;
    const parsed = pe.source === undefined ?
        undefined :
        read(() => parseSource(pe.source!, load, `entity '${e.name}'`), true);
    if (parsed) {
      e.dataSource = parsed.dataSource;
      e.authoredSource = parsed.authoredSource;
    }
    if (pe.primaryKey !== undefined) {
      e.keys = [...pe.primaryKey];
    }
    if (pe.uniqueKeys !== undefined) {
      if (pe.uniqueKeys.length) {
        e.uniqueKeys = pe.uniqueKeys.map(k => [...k]);
      } else {
        delete e.uniqueKeys;
      }
    }
    const inherited = inheritedNamesOf(out, e.name, byName);
    for (const pf of pe.fields ?? []) {
      // An entry with nothing to bind leaves the field as it is. applyProfile
      // rejects one, and validateProfileCompleteness reports it, through
      // profileStructureErrors.
      if (!pf.dialects?.length && !isFieldBound(pf as Field)) continue;
      // Read as a load reads the same expression in a model file. One the
      // reader rejects is left unapplied, also when a profile built in memory
      // gives it with no dialect list. Under `noSqlAsWritten`, one the reader
      // rejects only for holding no SQL is read as the schema accepts it.
      const where = `field '${e.name}.${pf.name}'`;
      const binding =
          read(() => parseFieldBinding(pf, where, preferred, e.name), false) ??
          (opts.noSqlAsWritten ?
               read(
                   () => readFieldExpression(
                       expressionDocOf(pf), where, preferred, () => undefined),
                   false) :
               undefined);
      if (!binding) continue;
      let f = e.fields.find(x => x.name === pf.name);
      if (!f) {
        if (!inherited.has(pf.name)) continue;
        // Binding an inherited field redeclares it on this entity with only a
        // binding, which inheritance merges over the ancestor's definition.
        f = {name: pf.name};
        e.fields.push(f);
      }
      for (const k of FIELD_BINDING_KEYS) delete f[k];
      if (pf.dialects?.length) {
        Object.assign(f, binding);
      } else {
        // A profile built in memory may carry a binding with no dialect list,
        // which is applied as written.
        for (const k of FIELD_BINDING_KEYS) {
          if (pf[k] !== undefined) (f as any)[k] = structuredClone(pf[k]);
        }
      }
    }
    // An exclusion applies to this entity only. A field no entity inherits
    // from this one also loses its binding; one a descendant inherits keeps
    // the binding the descendant reads.
    const below = extended.has(e.name);
    for (const name of pe.fieldsExclude ?? []) {
      const f = e.fields.find(x => x.name === name);
      if (!f || below) continue;
      if (inherited.has(name)) {
        // A line that only redeclares an inherited field goes with its
        // binding. The entity still inherits the declaration.
        e.fields = e.fields.filter(x => x !== f);
      } else {
        for (const k of FIELD_BINDING_KEYS) delete f[k];
      }
    }
    if (pe.fieldsExclude?.length) {
      e.excludedFields =
          [...new Set([...(e.excludedFields ?? []), ...pe.fieldsExclude])];
    }
  }
  // A side the profile leaves empty keeps the model file's columns, as the
  // merge keeps a side the profile does not name.
  for (const pr of profile.relationships) {
    const r = (out.relationships ?? []).find(x => x.name === pr.name);
    if (!r) continue;
    if (pr.fromColumns.length) r.source.columns = [...pr.fromColumns];
    if (pr.toColumns.length) r.destination.columns = [...pr.toColumns];
  }
  if (profile.metricsExclude !== undefined) {
    const names = profile.metricsExclude === '*' ?
        (out.metrics ?? []).map(m => m.name) :
        profile.metricsExclude;
    if (names.length) {
      out.excludedMetrics =
          [...new Set([...(out.excludedMetrics ?? []), ...names])];
    }
  }
  // The load read each ANSI_SQL metric in the dialect the model file's sources
  // imply, or with the generic parser when they imply none. The profile's
  // sources can imply another dialect, so each metric with no authored entity
  // is inferred again, as a load of the model file with these sources would
  // infer it. A metric whose new reading does not pin exactly one entity has
  // none.
  const entityNames = (out.entities ?? []).map(e => e.name);
  const impliedDialect = sourcesDialect(out);
  for (const m of out.metrics ?? []) {
    if (m.authoredEntity !== undefined) continue;
    const {referenced} = inferMetricEntities(
        m, entityNames, preferred, impliedDialect, out.version);
    if (referenced.length === 1) {
      m.entity = referenced[0];
    } else {
      delete m.entity;
    }
  }
  return {model: out, errors};
}

// The message of an error the loader's source or expression reader throws,
// without the prefix a model file's load gives it.
function readerMessage(err: SemanticModelError): string {
  return err.message.replace(/^Semantic model load error: /, '');
}

// The entities another entity extends, directly or through others: exactly
// those named in some other entity's `extends`.
function entitiesWithDescendants(model: SemanticModel): Set<string> {
  return new Set((model.entities ?? []).flatMap(
      e => (e.extends ?? []).filter(p => p !== e.name)));
}

// Reads a parsed profile file into a ProfileSpec, throwing on anything a
// profile may not say. Shared by loadProfileFile, mergeProfileFile and the
// loader's reading of a vanilla GOOGLE block's profiles, so the three agree on
// what a valid profile is.
export function profileSpecOf(doc: any, profileName: string): ProfileSpec {
  const where = `profile '${profileName}'`;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) ||
      doc.semantic_model !== undefined) {
    throw new SemanticModelError(`${where} is not a profile file`);
  }
  if (doc.version !== undefined) {
    throw new SemanticModelError(
        `${where} sets 'version'; a profile file takes its version from the ` +
        `model file beside it, so remove the line`);
  }
  // The profile's own name is checked against the file name below.
  requireKeys(doc, PROFILE_FILE_KEYS, where, false);
  if (doc.name !== profileName) {
    throw new SemanticModelError(
        `${where} declares name '${doc.name ?? ''}', which does not match ` +
        `its file's profile name '${profileName}'`);
  }
  const spec: ProfileSpec = {
    name: profileName,
    entities: listOf(doc.entities, `${where} 'entities'`)
                  .map(e => profileEntity(e, where)),
    relationships:
        listOf(doc.relationships, `${where} 'relationships'`).map(r => {
          requireKeys(r, PROFILE_RELATIONSHIP_KEYS, `${where}: relationship`);
          const at = `${where}: relationship '${r.name}'`;
          // An empty list is rejected as a load rejects one, so an empty side
          // here can only mean a side the profile leaves out.
          for (const key of ['from_columns', 'to_columns']) {
            if (Array.isArray(r[key]) && !r[key].length) {
              throw new SemanticModelError(`${at} '${key}' lists no column`);
            }
          }
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
      throw new SemanticModelError(
          `${where}: 'metrics_exclude' must be "*" or a list of metric names`);
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
        executor: a.executor === null ?
            null :
            parseExecutor(a.executor, `${where}: action '${a.name}'`),
      };
    });
  }
  // A repeated name, a field with nothing to bind, a field both bound and
  // excluded, and "*" inside a list, judged as for a profile held in memory.
  const problems = profileStructureErrors(spec);
  if (problems.length) throw new SemanticModelError(problems[0]);
  return spec;
}

function profileEntity(e: any, where: string): ProfileEntityBinding {
  requireKeys(e, PROFILE_ENTITY_KEYS, `${where}: entity`);
  const at = `${where}: entity '${e.name}'`;
  const binding: ProfileEntityBinding = {name: e.name};
  if (e.source !== undefined) {
    if (typeof e.source !== 'string') {
      throw new SemanticModelError(`${at} 'source' must be a string`);
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
    binding.fields = listOf(e.fields, `${at} 'fields'`).map(f => {
      requireKeys(f, PROFILE_FIELD_KEYS, `${at}: field`);
      const fat = `${at}: field '${f.name}'`;
      return f.expression === undefined ?
          {name: f.name} :
          {
            name: f.name,
            ...parseFieldExpression(
                f.expression, fat, DEFAULT_DIALECT, e.name),
          };
    });
  }
  if (e.fields_exclude !== undefined) {
    binding.fieldsExclude =
        stringList(e.fields_exclude, `${at} 'fields_exclude'`);
  }
  return binding;
}

// Checks that `obj` is a mapping carrying only `allowed` keys and, unless
// `named` is false, a string `name`.
function requireKeys(
    obj: any, allowed: Set<string>, where: string, named = true): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new SemanticModelError(`${where} is not a mapping`);
  }
  if (named && typeof obj.name !== 'string') {
    throw new SemanticModelError(`${where} has no 'name'`);
  }
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new SemanticModelError(notAllowed(
          named && obj.name !== undefined ? `${where} '${obj.name}'` : where,
          k));
    }
  }
}

function listOf(value: unknown, where: string): any[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SemanticModelError(`${where} must be a list`);
  }
  return value;
}

function stringList(value: unknown, where: string): string[] {
  const list = listOf(value, where);
  if (!list.every(v => typeof v === 'string')) {
    throw new SemanticModelError(`${where} must be a list of names`);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Whether a profile can be deployed.
// ---------------------------------------------------------------------------


// The dialect each system's sources infer, keyed by the
// system databaseOf puts first.
const DIALECT_OF_SYSTEM: Record<string, string> = {
  bigquery: 'BIGQUERY',
  spanner: 'SPANNER',
  alloydb: 'ALLOYDB',
  cloudsql_mysql: 'MYSQL',
  cloudsql_postgresql: 'POSTGRES',
};
// Whether a bound field has a text an engine of `dialect` can run: the one
// textsFor selects for it.
function runsOn(f: Field, dialect: string): boolean {
  return textsFor(f, dialect).length > 0;
}

// Each text a field's or metric's expression carries, with the dialect it is
// written in.
export function expressionSources(
    f: Pick<
        Field,
        'expression'|'dialects'|'importedExpression'|'importedDialect'>):
    Array<{text: string; dialect: string}> {
  const out: Array<{text: string; dialect: string}> = (f.dialects ?? []).map(
      d => ({text: d.expression, dialect: d.dialect}));
  for (const text of [f.expression, f.importedExpression]) {
    if (text !== undefined && !out.some(o => o.text === text)) {
      out.push({text, dialect: dialectOf(f, text)});
    }
  }
  return out;
}

// The texts a profile of `dialect` evaluates for a field or metric, each with
// the dialect to read it in. A profile has one dialect, so it evaluates the
// entry for that dialect, or the ANSI_SQL entry when there is none, and its
// database runs an ANSI_SQL text as its own SQL. A field held without a
// dialect list offers its imported text when that is in the profile's dialect,
// and otherwise the text the loader picked. With no known dialect, every text
// counts, each read in the dialect it is written in.
function textsFor(
    f: Pick<
        Field,
        'expression'|'dialects'|'importedExpression'|'importedDialect'>,
    dialect: string|undefined): Array<{text: string; dialect: string}> {
  if (dialect === undefined) return expressionSources(f);
  // The text a database of this dialect runs: its own entry, or the
  // ANSI_SQL one.
  const text = expressionForDialect(f, dialect as SqlDialect);
  return text !== undefined ? [{text, dialect}] : [];
}

// The texts pruning reads: those a profile of `dialect` evaluates, and the text
// the graph generators emit today, which is `fieldBinding` whatever the
// engine. Reading both keeps a deployed graph from reading a field the profile
// leaves unbound. Once each generator emits its own engine's text, the
// emitted text adds nothing and this can read `textsFor` alone.
function prunedTexts(
    f: Pick<
        Field,
        'expression'|'dialects'|'importedExpression'|'importedDialect'>,
    dialect: string|undefined): Array<{text: string; dialect: string}> {
  const out = textsFor(f, dialect);
  const emitted = fieldBinding(f);
  if (emitted !== undefined && !out.some(t => t.text === emitted)) {
    const written = dialectOf(f, emitted);
    out.push({
      text: emitted,
      dialect: written === 'ANSI_SQL' && dialect ? dialect : written,
    });
  }
  return out;
}

// The dialect a model's sources imply: that of the one database every concrete
// entity reads from, or undefined when they name several, or a source names
// none. A legacy bare name, which the loader completes into
// `project.dataset.table` in `dataSource`, names BigQuery however many parts it
// was written with.
export function sourcesDialect(
    model: Pick<SemanticModel, 'entities'>): string|undefined {
  return dialectOfSources(
      (model.entities ?? [])
          .filter(e => !e.abstract)
          .map(e => e.authoredSource !== undefined &&
                       isAcceptedSource(e.authoredSource.trim()) ?
                   e.authoredSource :
                   e.dataSource ?? ''));
}

// The dialect every one of `sources` implies, or undefined when one names no
// database in an accepted form or two imply different dialects. Two databases
// of one system, such as two Spanner databases, imply that system's dialect.
// A three-part dotted name, which is how the loader completes a legacy bare
// name, names BigQuery.
function dialectOfSources(sources: string[]): string|undefined {
  const dialects = new Set<string|undefined>(sources.map(source => {
    const s = source.trim();
    const db = databaseOf(s) ??
        (/^[^./:\s`]+\.[^./:\s`]+\.[^./:\s`]+$/.test(s) ? 'bigquery' :
                                                         undefined);
    return db ? DIALECT_OF_SYSTEM[db.split('/')[0]] : undefined;
  }));
  if (dialects.size !== 1) return undefined;
  return [...dialects][0];
}

/**
 * Returns one message per reason `profile` cannot be deployed against
 * `baseModel`, or an empty list. Checks a single profile: nothing unknown,
 * every field it binds holding SQL on each entity that inherits it, every
 * concrete entity bound and all in one database, key shapes matching the
 * model file's where it states keys, every relationship bound, every field the
 * model file leaves unbound accounted for, and exclusions closed under
 * dependency, metrics included. Rules that compare profiles with each other
 * are in validateProfileConsistency. An expression the SQL parser cannot read
 * is skipped by the rules that read references, with a message in `warnings`.
 */
export function validateProfileCompleteness(
    baseModel: SemanticModel, profile: ProfileSpec,
    warnings: string[] = []): string[] {
  const errors: string[] = [];
  // "field 'Entity.field'" or "metric 'name'", for each expression the parser
  // cannot read, reported once.
  const unreadable = new Set<string>();
  const at = `profile '${profile.name}'`;
  // What a profile file could not say, for a profile built in memory, and
  // every name the model does not take, as applyProfile judges them.
  errors.push(...profileProblems(baseModel, profile));
  const entities = baseModel.entities ?? [];
  const byName = new Map(entities.map(e => [e.name, e]));
  // Declared plus inherited fields, in the model file and as this profile sees
  // the model: the profile applied as push applies it, and each excluded field
  // left off the entity that names it. A broken hierarchy in
  // the model file is reported by push; one the profile itself creates, by
  // binding a field on two unrelated branches, is reported here.
  const fieldsOf = fieldsByEntity(baseModel);
  const {model: profiled, errors: unread} =
      applyBindings(baseModel, profile, {});
  errors.push(...unread.map(e => `${at}: ${e}`));
  const profiledError = inheritanceErrorOf(profiled);
  if (profiledError && !inheritanceErrorOf(baseModel)) {
    errors.push(`${at}: ${profiledError}`);
    return errors;
  }
  // A field the profile binds is checked on each entity that inherits it, as
  // applyProfile checks it. A binding the reader rejects only for holding no
  // SQL is reported where the profile writes it and left unapplied above.
  // Applied here, it is also reported on an entity where its expression, read
  // as a document writes it, has a further problem.
  if (!profiledError) {
    const asWritten =
        applyBindings(baseModel, profile, {noSqlAsWritten: true}).model;
    const checked = inheritanceErrorOf(asWritten) ? profiled : asWritten;
    const inherited =
        inheritedNoSqlProblems(checked.entities, declaredConceptFields(checked));
    errors.push(...inherited.map(p => `${at}: ${p}`));
  }
  const seenOf = fieldsByEntity(profiled);
  const bindingOf = new Map(profile.entities.map(e => [e.name, e]));
  // Every concrete entity bound, all in one database. The profile's dialect
  // is the one its own sources imply, so a source the model file states for an
  // entity the profile leaves out does not decide it.
  const databases = new Map<string, string>();
  const stated: string[] = [];
  for (const e of entities) {
    if (e.abstract) continue;
    const pe = bindingOf.get(e.name);
    if (pe?.source === undefined) {
      errors.push(`${at}: entity '${e.name}' has no source in this profile`);
      continue;
    }
    // A source the loader's reader rejects, an empty one included, is already
    // reported, and the reader accepts only a form databaseOf reads once
    // trimmed.
    const db = databaseOf(pe.source.trim());
    if (!db) continue;
    stated.push(pe.source);
    if (!databases.has(db)) databases.set(db, e.name);
  }
  if (databases.size > 1) {
    const named = [...databases.values()].map(n => `'${n}'`).join(', ');
    errors.push(
        `${at} binds entities in more than one database (${named}); a ` +
        `profile reads from one system a single query can reach`);
  }
  const dialect = dialectOfSources(stated);


  // The expressions of each entity the profile may bind.
  for (const pe of profile.entities) {
    const e = byName.get(pe.name);
    if (!e || e.abstract) continue;
    const known = fieldsOf.get(pe.name)!;
    // A profile field's expression may be anything the model file's could be:
    // its own table's columns and its own entity's fields, never another
    // entity's fields.
    // A name after a dot is a struct path segment, such as `customer` in
    // `details.customer.id`, and reads no entity.
    // These two rules check every text the profile wrote, since each must be a
    // valid field expression wherever it runs; the dependency rules below read
    // only the text the profile's dialect evaluates. An ANSI_SQL text is read
    // as the profile's own SQL.
    const others = entities.map(x => x.name).filter(n => n !== pe.name);
    for (const pf of pe.fields ?? []) {
      // A text with no SQL is reported above, and has nothing to read.
      const readable = expressionSources(pf).filter(
          s => noSqlReason(s.text, s.dialect, pe.name) === undefined);
      for (const {text, dialect: written} of readable) {
        const columns = columnReferences(
            text, written === 'ANSI_SQL' && dialect ? dialect : written);
        if (!columns) {
          unreadable.add(`field '${pe.name}.${pf.name}'`);
          continue;
        }
        for (const other of others) {
          if (fieldsReadOn(columns, other).length) {
            errors.push(
                `${at}: field '${pe.name}.${pf.name}' reads entity '${
                    other}'; a field expression reads only its own entity`);
          }
        }
        for (const ref of fieldsReadOn(columns, pe.name)) {
          if (!known.has(ref)) {
            errors.push(
                `${at}: field '${pe.name}.${pf.name}' reads '${pe.name}.${
                    ref}', which is not a field of '${pe.name}'`);
          }
        }
      }
    }
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
  // both join column lists, and the model file's do not stand in for them.
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
          `${at}: ${joinLengthMessage(r.name, from.length, to.length)}`);
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
  // it, not to that entity's descendants.
  const excluded = new Set<string>();
  for (const e of entities) {
    if (e.abstract) continue;
    const pe = bindingOf.get(e.name);
    for (const name of pe?.fieldsExclude ?? []) {
      excluded.add(`${e.name}.${name}`);
    }
    // A field the profile lists in `fields`, on this entity or on a concrete
    // ancestor that has the field, is bound by it. One whose expression the
    // reader rejected is reported once, as that, where the profile lists it.
    const listedOn = [e, ...ancestorsOf(e.name, byName).filter(
                             a => !a.abstract)];
    const rebound = new Set(listedOn.flatMap(
        x => (bindingOf.get(x.name)?.fields ?? [])
                 .map(f => f.name)
                 .filter(n => x === e || fieldsOf.get(x.name)?.has(n))));
    for (const f of seenOf.get(e.name)?.values() ?? []) {
      if (!isFieldBound(f) && !rebound.has(f.name)) {
        errors.push(
            `${at}: field '${e.name}.${f.name}' has no binding in the model ` +
            `file; bind it in 'fields' or leave it out in 'fields_exclude'`);
      }
    }
  }
  // Every bound field, and every metric the profile keeps, has a text this
  // profile's database can run, checked once its sources name one database.
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
    if (profile.metricsExclude !== '*') {
      const excludedMetrics = new Set(profile.metricsExclude ?? []);
      for (const m of baseModel.metrics ?? []) {
        if (!excludedMetrics.has(m.name) && !runsOn(m as Field, dialect)) {
          errors.push(
              `${at}: metric '${m.name}' has no expression for ${dialect} or ` +
              `ANSI_SQL, and this profile's sources are ${dialect}; give it ` +
              `one, or add it to 'metrics_exclude'`);
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
        // A field reads only its own entity's fields. An
        // inherited field is read in the form its declaring ancestor wrote it,
        // because inheritance strips the qualifier when it copies one down.
        for (const dep of fieldDependencies(
                 profiled, e.name, f.name, unreadable, dialect)) {
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
      const read: Array<ReadonlyArray<SqlColumn>> = [];
      for (const text of textsFor(m as Field, dialect)) {
        // A text with no SQL has nothing to read.
        if (noSqlReason(text.text, text.dialect) !== undefined) continue;
        const columns = columnReferences(text.text, text.dialect);
        if (columns) {
          read.push(columns);
        } else {
          unreadable.add(`metric '${m.name}'`);
        }
      }
      const reached = [...excluded, ...dangling.keys()].filter(target => {
        const [te, tf] = target.split('.');
        return read.some(columns => fieldsReadOn(columns, te).includes(tf));
      });
      if (reached.length) {
        errors.push(
            `${at}: metric '${m.name}' reaches ${
                reached.map(r => `'${r}', ${why(r)}`).join('; ')}; add '${
                m.name}' to 'metrics_exclude'`);
      }
    }
  }
  for (const what of unreadable) {
    warnings.push(
        `${at}: kcmd could not read the SQL of ${what}, so the fields it ` +
        `reads were not checked`);
  }
  return errors;
}

/**
 * Returns one message per way `profiles` disagree with each other about the
 * model, or an empty list:
 *   - where the model file states no key for an entity, either every profile
 *     states keys of one shape, or none does;
 *   - in every binding that states a relationship's join columns, the model
 *     file's included, its `to_columns` cover a primary or unique key of the
 *     target, and the same keys in every binding, because cardinality is a
 *     property of the model. A superset of a key
 *     covers it (see keysCoveredBy).
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
  // Each binding's fields, so a key or join column that names a field is read
  // as that field's column, as the graph generators read it. A value the
  // loader's readers reject is left unapplied; the completeness check reports
  // it.
  const baseFields = fieldsByEntity(baseModel);
  const profileFields = new Map(profiles.map(
      p => [p.name, fieldsByEntity(applyBindings(baseModel, p, {}).model)]));
  for (const r of baseModel.relationships ?? []) {
    if (r.association) continue;
    const target = byName.get(r.destination.entity);
    if (!target || target.abstract) continue;
    // Every binding that binds the relationship, by stating its join columns,
    // covers a key of the target, and the same keys as every other binding,
    // because cardinality is a property of the model. A binding's keys are its
    // own where it states them and the model file's otherwise. A join that
    // covers no key is neither many-to-one nor one-to-one, so it is rejected. A binding
    // that states no join columns does not bind the relationship and is left
    // out; for a named profile, completeness reports that.
    const answers = new Map<string, string[]>();
    const record =
        (who: string, fields: Map<string, Map<string, Field>>, to: string[],
         pk: string[], uks: string[][]) => {
          if (!to.length) return;
          const entity = {
            name: target.name,
            fields: [...(fields.get(target.name)?.values() ?? [])],
          };
          const covered = keysCoveredByColumns(entity, to, pk, uks);
          // A key that names a field with no column in this binding cannot be
          // judged here.
          if (!covered) return;
          if (!covered.length) {
            errors.push(
                `relationship '${r.name}': ${who} joins on to_columns ${
                    JSON.stringify(to)}, which cover no primary or unique key ` +
                `of '${target.name}'`);
            return;
          }
          const a = covered.join(' and ');
          answers.set(a, [...(answers.get(a) ?? []), who]);
        };
    record(
        'the model file', baseFields, r.destination.columns, target.keys,
        target.uniqueKeys ?? []);
    for (const p of profiles) {
      const pr = p.relationships.find(x => x.name === r.name);
      const pe = bindingIn(p, target.name);
      record(
          `profile '${p.name}'`, profileFields.get(p.name)!,
          pr?.toColumns ?? [],
          pe?.primaryKey ?? target.keys,
          pe?.uniqueKeys ?? target.uniqueKeys ?? []);
    }
    if (answers.size > 1) {
      const detail =
          [...answers].map(([a, who]) => `${who.join(', ')}: ${a}`).join('; ');
      errors.push(
          `relationship '${r.name}' covers different keys under different ` +
          `bindings (${detail}); its 'to_columns' must cover the same keys in ` +
          `every binding`);
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
    } catch (err) {
      // A broken hierarchy keeps the declared fields; it is reported
      // elsewhere. Anything else is a bug.
      if (!(err instanceof InheritanceError)) throw err;
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

// The message of the inheritance error resolving `model` throws, or undefined
// when it resolves.
function inheritanceErrorOf(model: SemanticModel): string|undefined {
  if (!(model.entities ?? []).some(e => e.extends?.length)) return undefined;
  try {
    resolveInheritance(model);
    return undefined;
  } catch (err) {
    if (!(err instanceof InheritanceError)) throw err;
    return err.message;
  }
}

// The fields of its own entity that `field` reads on `entityName`, from the
// texts `texts` picks for a profile of `dialect` (textsFor unless pruning
// passes prunedTexts) as written: the entity's own declaration when it binds
// the field, otherwise that of the nearest ancestor that does, read with that
// ancestor's qualifier.
function fieldDependencies(
    model: SemanticModel, entityName: string, field: string,
    unreadable: Set<string>, dialect?: string,
    texts: typeof textsFor = textsFor): string[] {
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
      const deps = new Set<string>();
      for (const text of texts(own, dialect)) {
        // A text with no SQL has nothing to read.
        if (noSqlReason(text.text, text.dialect, name) !== undefined) continue;
        const columns = columnReferences(text.text, text.dialect);
        if (!columns) {
          unreadable.add(`field '${name}.${field}'`);
          continue;
        }
        for (const dep of fieldsReadOn(columns, name)) deps.add(dep);
      }
      return [...deps];
    }
    queue.push(...(e?.extends ?? []));
  }
  return [];
}

// "[2, 1]": how many unique keys, and how wide each is.
function shapeOf(keys: string[][]): string {
  return `[${keys.map(k => k.length).join(', ')}]`;
}

