// Applies a chosen binding profile to a logical semantic model, and prunes what
// the resulting binding cannot answer.
//
// A model is authored as ONE logical declaration (entities, fields,
// relationships, metrics, the grain, and the graph shape) plus zero or more
// BINDING PROFILES that supply the physical facets it leaves open: each entity's
// `source`, each field's column (`expression`) and each action's `executor`.
// `kcmd push` applies the profile each deployment names to the logical model
// BY NAME and deploys the result. See docs/semantic-model/profiles.md.

import * as yaml from 'yaml';

import {hydrationDocErrors, hydrationFromDoc, hydrationToDoc, isDerivedEntity, modeDocError} from './hydration';
import {Action, coversKey, Entity, EntityBindingMode, expressionForDialect, Field, FIELD_BINDING_KEYS, isFieldBound, Metric, ProfileEntityBinding, ProfileRelationshipBinding, ProfileSpec, Relationship, SemanticModel, SqlDialect} from './ir';
import {cloudSqlTableOf, databaseOf, DEFAULT_DIALECT, DIALECT_OF_ENTRY_TYPE, DIALECT_OF_FQN_PREFIX, dialectLookupKey, entityAndMetricWarnings, expressionDocOf, GOOGLE_VERSION, googleBlockProfiles, inferMetricEntities, inheritedNoSqlProblems, joinLengthMessage, LoadOptions, loadSemanticModels, noSqlReason, OSSIE_VERSION, parseExecutor, parseFieldBinding, parseFieldExpression, parseSource, readFieldExpression, SemanticModelError, spannerDatabaseOf, thirdPartyEntryOf, writtenSource} from './loader';
import {qualifierCaseError} from './names';
import {withHydrationBindings} from './node_views';
import {declaredConceptFields, InheritanceError, resolveInheritance} from './resolve_inheritance';
import {columnReferences, columnsForSource, entitiesReached, fieldsReadOn, isColumnName, selfReferenceMessage} from './sql_expr_utils';
import {SqlColumn} from './sql_parser';
import {translatesToBigQuery} from './transpile';
import {generatesVocabularyView, withVocabularyBindings} from './vocabulary';
import {YAML_OPTIONS} from './yaml_options';

// The implicit profile: the inline bindings already in the model document (the
// combined single-file form).
export const DEFAULT_PROFILE = 'default';

// Keys a profile may carry at each level. Everything else is a logical
// declaration the model owns; setting it in a profile is rejected so swapping a
// profile can move data but never change what the model means.
export const PROFILE_FILE_KEYS = new Set([
  'name', 'entities', 'relationships', 'metrics_exclude', 'actions',
]);
const PROFILE_ENTITY_KEYS = new Set([
  'name', 'source', 'primary_key', 'unique_keys', 'hydration', 'mode',
  'fields', 'fields_exclude',
]);
const PROFILE_RELATIONSHIP_KEYS =
    new Set(['name', 'from_columns', 'to_columns']);
const PROFILE_FIELD_KEYS = new Set(['name', 'expression']);
const PROFILE_ACTION_KEYS = new Set(['name', 'executor']);

// A deep copy in which every node is its own object. structuredClone keeps a
// YAML anchor and its aliases as one object, so an edit through one alias
// would change every node that shares it.
export function plainCopy(value: unknown): any {
  if (Array.isArray(value)) return value.map(plainCopy);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, plainCopy(v)]));
  }
  return value;
}

function notAllowed(where: string, key: string): string {
  return `${where} sets '${key}', which a profile may not set; a profile ` +
      `carries only physical bindings, and the logical model owns everything ` +
      `else`;
}

// Entities whose fields kcmd synthesizes bindings for when no profile states
// one: a vocabulary view's columns (`code`, `label`, `sort_order`,
// `definition`, `iri`), and a derived entity's key column.
export function withDefaultBindings(model: SemanticModel): SemanticModel {
  return {
    ...model,
    entities: (model.entities ?? [])
                  .map(withVocabularyBindings)
                  .map(withHydrationBindings),
  };
}

// Entities that deliberately have no physical source table of their own:
// defined entities (filters over a parent), derived entities
// (`hydration.derive_from`), and sourceless vocabularies (`members`, whose
// view kcmd generates).
export function tablelessByDesign(e: Entity): boolean {
  return !!e.definition || isDerivedEntity(e) || generatesVocabularyView(e);
}

// One profile's availability outcome: the fields it leaves unbound, and the
// building blocks that fall with them.
export interface AvailabilityReport {
  profile: string;
  unboundFields: string[];  // "Entity.field"
  excludedFields: string[];  // The unbound fields the profile excludes.
  droppedEntities: {name: string; reason: string}[];
  droppedMetrics: {name: string; reason: string; field?: string}[];
  droppedRelationships: {name: string; reason: string}[];
  droppedActions: {name: string; reason: string}[];
  droppedFields: {name: string; reason: string}[];
  warnings: string[];
}

export function pruneUnavailable(
    model: SemanticModel, profileName: string,
    dialect: string|null|undefined = sourcesDialect(model)):
    {model: SemanticModel; report: AvailabilityReport} {
  const clone: SemanticModel = withDefaultBindings(structuredClone(model));
  const report: AvailabilityReport = {
    profile: profileName,
    unboundFields: [],
    excludedFields: [],
    droppedEntities: [],
    droppedMetrics: [],
    droppedRelationships: [],
    droppedActions: [],
    droppedFields: [],
    warnings: [],
  };

  const unbound = new Set<string>();
  const resolved = resolvedEntities(clone);
  for (const e of resolved) {
    if (e.abstract || e.definition) continue;
    for (const f of e.fields ?? []) {
      if (!isFieldBound(f)) unbound.add(`${e.name}.${f.name}`);
    }
    for (const name of e.excludedFields ?? []) {
      unbound.add(`${e.name}.${name}`);
      report.excludedFields.push(`${e.name}.${name}`);
    }
  }
  report.unboundFields = [...unbound];

  const unavailable = new Set(unbound);
  const unreadable = new Set<string>();
  const dependencies = new Map<string, string[]>();
  if (unbound.size) {
    for (const e of resolved) {
      if (e.abstract || e.definition) continue;
      for (const f of e.fields ?? []) {
        const key = `${e.name}.${f.name}`;
        if (unbound.has(key)) continue;
        dependencies.set(
            key,
            fieldDependencies(
                clone, e.name, f.name, unreadable, dialect)
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

  const allEntityNames = (clone.entities ?? []).map(e => e.name);

  const extendedNames = new Set(
      resolvedEntities(clone)
          .filter(e => !e.definition)
          .flatMap(e => e.extends ?? []));
  for (const e of clone.entities ?? []) {
    if (e.abstract || e.definition) continue;
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

  const keptRels: Relationship[] = clone.relationships ?? [];

  const excludedMetrics = new Set(clone.excludedMetrics ?? []);
  delete clone.excludedMetrics;
  const keptMetrics: Metric[] = [];
  for (const mt of clone.metrics ?? []) {
    if (excludedMetrics.has(mt.name)) {
      report.droppedMetrics.push({name: mt.name, reason: 'excluded'});
      continue;
    }
    const columns: SqlColumn[] = [];
    const sources = textsFor(mt, dialect)
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
        field: hit,
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

export function withoutExclusions(model: SemanticModel): SemanticModel {
  const out = structuredClone(model);
  for (const e of out.entities ?? []) delete e.excludedFields;
  delete out.excludedMetrics;
  return out;
}

export function resolvedEntities(model: SemanticModel): Entity[] {
  const entities = model.entities ?? [];
  if (!entities.some(e => e.extends?.length)) return entities;
  try {
    return resolveInheritance(model).model.entities ?? entities;
  } catch (err) {
    if (!(err instanceof InheritanceError)) throw err;
    return entities;
  }
}

export function inheritedNamesOf(
    model: SemanticModel, entityName: string,
    byName = new Map((model.entities ?? []).map(e => [e.name, e]))):
    Set<string> {
  return new Set(ancestorsOf(entityName, byName)
                     .flatMap(a => (a.fields ?? []).map(f => f.name)));
}

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

function connectingRelationshipKept(
    refEntities: string[], kept: Relationship[]): boolean {
  const set = new Set(refEntities);
  return kept.some(
      r => set.has(r.source.entity) && set.has(r.destination.entity));
}


export function loadProfileFile(
    text: string, profileName: string,
    opts: {skipActions?: boolean} = {}): ProfileSpec {
  let doc: any;
  try {
    doc = yaml.parse(text, YAML_OPTIONS);
  } catch (err: any) {
    throw new SemanticModelError(
        `profile '${profileName}' does not parse: ${err?.message ?? err}`);
  }
  if (opts.skipActions && doc && typeof doc === 'object' &&
      !Array.isArray(doc)) {
    const {actions: _, ...rest} = doc;
    doc = rest;
  }
  return profileSpecOf(doc, profileName);
}

export type DialectLoad = Pick<LoadOptions, 'sourceDialects'>&
    {sourceDatabases?: ReadonlyMap<string, string>};

export interface ApplyProfileOptions {
  load?: Pick<LoadOptions, 'dialect'|'sourceDialects'>;
  warnings?: string[];
  from?: {document: string; warnings: string[]};
  defaultProject?: string;
  defaultDataset?: string;
}

export function applyProfile(
    model: SemanticModel, profile: ProfileSpec,
    opts: Omit<ApplyProfileOptions, 'from'> = {}): SemanticModel {
  const res = applyProfileSpec(model, profile, opts);
  if ('error' in res && res.error !== undefined) throw new SemanticModelError(res.error);
  if (opts.warnings) {
    const before = new Set(entityAndMetricWarnings(
        model, opts.load?.dialect ?? DEFAULT_DIALECT));
    opts.warnings.push(...res.warnings.filter(w => !before.has(w)));
  }
  return res.model;
}

export function applyProfileFile(
    model: SemanticModel, text: string, profileName: string,
    opts: Omit<ApplyProfileOptions, 'warnings'> = {}, skipActions = false):
    {model: SemanticModel; warnings: string[]; error?: undefined}|
    {error: string; model?: undefined; warnings?: undefined} {
  const sql = logicalSqlExecutorError(model, profileName);
  if (sql) return {error: sql};
  let profile: ProfileSpec;
  try {
    profile = loadProfileFile(text, profileName, {skipActions});
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
    return {error: err.message};
  }
  return applyProfileSpec(model, profile, opts);
}

function applyProfileSpec(
    model: SemanticModel, profile: ProfileSpec,
    opts: Omit<ApplyProfileOptions, 'warnings'>):
    {model: SemanticModel; warnings: string[]; error?: undefined}|
    {error: string; model?: undefined; warnings?: undefined} {
  const error = profileApplyError(model, profile);
  if (error) return {error};
  const applied = applyBindings(model, profile, opts);
  if (applied.errors.length) {
    return {error: `profile '${profile.name}': ${applied.errors[0]}`};
  }
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

export interface AppliedProfile {
  model: SemanticModel;
  warnings: string[];
}

function applyProfileToDocument(
    doc: {name: string; text: string}, profile: ProfileSpec, load: DialectLoad,
    skipActions: boolean):
    AppliedProfile|{error: string; stage: 'load'|'apply'} {
  const {actions: _, ...bindings} = profile;
  return applyToDocument(
      doc,
      (base, from) => applyProfileSpec(
          base, skipActions ? bindings : profile, {from, load}),
      load, skipActions);
}

function applyProfileFileToDocument(
    doc: {name: string; text: string}, text: string, profileName: string,
    load: DialectLoad, skipActions: boolean):
    AppliedProfile|{error: string; stage: 'load'|'apply'} {
  return applyToDocument(
      doc,
      (base, from) =>
          applyProfileFile(base, text, profileName, {from, load}, skipActions),
      load, skipActions);
}

function applyToDocument(
    doc: {name: string; text: string},
    apply: (base: SemanticModel,
            from: {document: string; warnings: string[]}) =>
        {model: SemanticModel; warnings: string[]}|{error: string},
    load: DialectLoad, skipActions: boolean):
    AppliedProfile|{error: string; stage: 'load'|'apply'} {
  const loaded = loadSemanticModels(
      [{name: doc.name, text: doc.text}], {bindingOptional: true, ...load});
  if (loaded.error) return {error: loaded.error, stage: 'load'};
  const {model} = loaded.models[0];
  const res = apply(
      skipActions ? {...model, actions: []} : model,
      {document: doc.name, warnings: loaded.warnings});
  if ('error' in res) return {error: res.error, stage: 'apply'};
  return {model: res.model, warnings: res.warnings};
}

export type DeclaredProfile = {name: string; text: string}|
    {name: string; spec: ProfileSpec; label?: string};

export type DeclaredProfiles = (doc: {name: string; text: string}) =>
    DeclaredProfile[];

export type ProfileFiles =
    (model: string) => Array<{name: string; text: string; fileName: string}>;

export function declaredProfiles(
    doc: {name: string; text: string},
    files: Array<{name: string; text: string}>): DeclaredProfile[] {
  let blockProfiles: ProfileSpec[];
  try {
    blockProfiles = googleBlockProfiles(doc.text);
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
    throw new SemanticModelError(
        `Model document '${doc.name}': ${err.message}`);
  }
  return [
    ...files,
    ...blockProfiles.map(spec => ({name: spec.name, spec}))
        .sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

export type DocumentProfile = ({kind: 'file'}&AppliedProfile)|
    {kind: 'error'; error: string; stage: 'load'|'apply'}|{
  kind: 'missing';
  declared: string[];
};

export function profileForDocument(
    doc: {name: string; text: string}, profiles: DeclaredProfile[],
    profileName: string, load: DialectLoad = {},
    opts: {skipActions?: boolean} = {}): DocumentProfile {
  const chosen = profiles.find(p => p.name === profileName);
  if (!chosen) return {kind: 'missing', declared: profiles.map(p => p.name)};
  const skipActions = !!opts.skipActions;
  const res = 'spec' in chosen ?
      applyProfileToDocument(doc, chosen.spec, load, skipActions) :
      applyProfileFileToDocument(
          doc, chosen.text, profileName, load, skipActions);
  return 'error' in res ? {kind: 'error', ...res} : {kind: 'file', ...res};
}

export function appliedProfileWarnings(
    doc: {name: string; text: string}, profiles: DeclaredProfile[],
    profileName: string, own: string[], load: DialectLoad = {}): string[] {
  const res =
      profileForDocument(doc, profiles, profileName, load, {skipActions: true});
  if (res.kind !== 'file') return [];
  return res.warnings.filter(w => !own.includes(w))
      .map(w => `profile '${profileName}': ${w}`);
}

export function modelFileAloneMessage(
    error: string, profileName?: string): string {
  return profileName === undefined ?
      `${error} (the model file must load on its own before a profile file ` +
          `applies)` :
      `${error} (under profile '${profileName}', the model file must load ` +
          `on its own before the profile applies)`;
}

export function profileErrorMessage(
    docName: string, res: Extract<DocumentProfile, {kind: 'error'}>,
    profileName: string,
    profileFiles: Array<{name: string; text: string; fileName: string}>):
    string {
  if (res.stage === 'load') {
    return modelFileAloneMessage(res.error, profileName);
  }
  const file = profileFiles.find(p => p.name === profileName);
  return `[${file?.fileName ?? docName}] ${res.error}`;
}

export function undeclaredProfileError(
    document: string, model: SemanticModel, declared: string[]): string|
    undefined {
  for (const d of model.deployments ?? []) {
    const profile = d.profile ?? DEFAULT_PROFILE;
    if (profile === DEFAULT_PROFILE || declared.includes(profile)) continue;
    return `[${document}] model '${model.name}': deployment '${
               d.name}' names unknown binding profile '${profile}'; ` +
        (declared.length ? `defined profiles: ${declared.join(', ')}.` :
                           `no profiles are defined for this model.`);
  }
  return undefined;
}

export function unknownProfileMessage(
    profileName: string, model: string, declared: string[]): string {
  return `unknown binding profile '${profileName}' for model '${model}'; ` +
      (declared.length ? `defined profiles: ${declared.join(', ')}.` :
                         `no profiles are defined for this model.`);
}

export function reservedProfileNameError(
    docName: string, profiles: {name: string}[]): string|undefined {
  if (!profiles.some(p => p.name.toLowerCase() === DEFAULT_PROFILE)) {
    return undefined;
  }
  return `[${docName}] a binding profile may not be named '${
             DEFAULT_PROFILE}' -- that name refers to the model's inline ` +
      `bindings. Rename the profile.`;
}

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
      entityAndMetricWarnings(applied, preferred, true).map(w => prefix + w);
  return [...new Set([...after, ...kept])];
}

export function profileProblems(
    model: SemanticModel, profile: ProfileSpec): string[] {
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
    if (e.definition) {
      problems.push(
          `${at}: entity '${pe.name}' is a defined entity, so a profile ` +
          `cannot bind it`);
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

function profileApplyError(
    model: SemanticModel, profile: ProfileSpec): string|undefined {
  const problems = profileProblems(model, profile);
  if (problems.length) return problems[0];
  const at = `profile '${profile.name}'`;
  for (const {name, fromColumns: from, toColumns: to} of
           profile.relationships) {
    if (!from.length !== !to.length) {
      return `${at}: ${profileJoinMessage(name)}`;
    }
    if (from.length !== to.length) {
      return `${at}: ${joinLengthMessage(name, from.length, to.length)}`;
    }
  }
  return undefined;
}

function profileJoinMessage(relationship: string): string {
  return `relationship '${relationship}' has no join columns in this ` +
      `profile; a named profile states both 'from_columns' and ` +
      `'to_columns' itself`;
}

function profileStructureErrors(profile: ProfileSpec): string[] {
  const at = `profile '${profile.name}'`;
  const errors: string[] = [];
  const twice = (names: string[]) =>
      names.find((n, i) => names.indexOf(n) !== i);
  const dupEntity = twice(profile.entities.map(e => e.name));
  if (dupEntity) errors.push(`${at} 'entities' lists '${dupEntity}' twice`);
  for (const pe of profile.entities) {
    const where = `${at}: entity '${pe.name}'`;
    if (pe.hydration !== undefined && pe.hydration !== null) {
      const doc = hydrationToDoc(pe.hydration);
      for (const err of hydrationDocErrors(doc)) {
        errors.push(`${where} ${err}`);
      }
      if (pe.hydration.deriveFrom !== undefined && pe.source !== undefined) {
        errors.push(
            `${where} declares both 'source' and 'hydration.derive_from'; ` +
            `a derived entity has no table of its own`);
      }
    }
    if (pe.mode !== undefined && pe.mode !== null) {
      const err = modeDocError(pe.mode);
      if (err) errors.push(`${where} ${err}`);
    }
    if (pe.mode === 'direct' && pe.hydration &&
        (pe.hydration.grain || pe.hydration.normalize ||
         pe.hydration.deriveFrom || pe.hydration.constraints)) {
      errors.push(
          `${where} sets 'mode: direct' alongside hydration rules that ` +
          `require a node view`);
    }
    const bound = (pe.fields ?? []).map(f => f.name);
    const dupField = twice(bound);
    if (dupField) errors.push(`${where} 'fields' lists '${dupField}' twice`);
    for (const pf of pe.fields ?? []) {
      const fat = `${where}: field '${pf.name}'`;
      if (!isFieldBound(pf as Field)) {
        errors.push(
            `${fat} has no 'expression'; bind it with one, or list it in ` +
            `'fields_exclude'`);
      }
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

function logicalSqlExecutorError(
    model: SemanticModel, profileName: string): string|undefined {
  const action = (model.actions ?? []).find(a => a.executor?.kind === 'sql');
  return action && sqlExecutorMessage(profileName, action.name, model.name);
}

function sqlExecutorMessage(
    profileName: string, action: string, model: string): string {
  return `profile '${profileName}': action '${action}' in model '${
             model}' declares a 'sql' executor. A statement names one ` +
      `database's own tables and columns, so it belongs in the profile that ` +
      `binds them, not in the model. Move the executor into each profile ` +
      `that performs this write as DML.`;
}

function applyBindings(
    model: SemanticModel, profile: ProfileSpec,
    opts: ApplyProfileOptions&{noSqlAsWritten?: boolean}):
    {model: SemanticModel; errors: string[]} {
  const errors: string[] = [];
  const out: SemanticModel = structuredClone(model);
  const load = opts.load ?? {};
  const preferred = load.dialect ?? DEFAULT_DIALECT;
  const read = <T>(readValue: () => T, list: boolean): T|undefined => {
    try {
      return readValue();
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
      if (list) errors.push(readerMessage(err));
      return undefined;
    }
  };
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
    if (!e || e.abstract || e.definition) continue;
    const parsed = pe.source === undefined ?
        undefined :
        read(() => parseSource(pe.source!, load, `entity '${e.name}'`), true);
    if (parsed) {
      e.dataSource = parsed.dataSource;
      e.authoredSource = parsed.authoredSource;
      if (parsed.sourceDialect) {
        e.sourceDialect = parsed.sourceDialect;
      } else {
        delete e.sourceDialect;
      }
    }
    if (pe.hydration === null) {
      delete e.hydration;
    } else if (pe.hydration !== undefined) {
      e.hydration = structuredClone(pe.hydration);
      if (pe.hydration.deriveFrom !== undefined && pe.source === undefined) {
        e.dataSource = '';
        delete e.authoredSource;
        delete e.sourceDialect;
      }
    }
    if (pe.mode === null) {
      delete e.mode;
    } else if (pe.mode !== undefined) {
      e.mode = pe.mode;
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
      if (!isFieldBound(pf as Field)) continue;
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
        f = {name: pf.name};
        e.fields.push(f);
      }
      for (const k of FIELD_BINDING_KEYS) delete f[k];
      if (pf.dialects?.length) {
        Object.assign(f, binding);
      } else {
        for (const k of FIELD_BINDING_KEYS) {
          if (pf[k] !== undefined) (f as any)[k] = structuredClone(pf[k]);
        }
      }
    }
    const below = extended.has(e.name);
    for (const name of pe.fieldsExclude ?? []) {
      const f = e.fields.find(x => x.name === name);
      if (!f || below) continue;
      if (inherited.has(name)) {
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

export function readerMessage(err: SemanticModelError): string {
  return err.message.replace(/^Semantic model load error: /, '');
}

function entitiesWithDescendants(model: SemanticModel): Set<string> {
  return new Set((model.entities ?? [])
                     .filter(e => !e.definition)
                     .flatMap(e => (e.extends ?? []).filter(p => p !== e.name)));
}

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
  if (doc.datasets !== undefined) {
    throw new SemanticModelError(
        `${where} lists its bindings under 'datasets'; a profile lists them ` +
        `under 'entities'`);
  }
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
          for (const key of ['from_columns', 'to_columns']) {
            if (Array.isArray(r[key]) && !r[key].length) {
              throw new SemanticModelError(`${at} '${key}' lists no column`);
            }
          }
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
  if (e.hydration === null) {
    binding.hydration = null;
  } else if (e.hydration !== undefined) {
    const errs = hydrationDocErrors(e.hydration);
    if (errs.length) {
      throw new SemanticModelError(`${at} ${errs.join('; ')}`);
    }
    binding.hydration = hydrationFromDoc(e.hydration);
  }
  if (e.mode === null) {
    binding.mode = null;
  } else if (e.mode !== undefined) {
    const err = modeDocError(e.mode);
    if (err) throw new SemanticModelError(`${at} ${err}`);
    binding.mode = e.mode as EntityBindingMode;
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


const DIALECT_OF_SYSTEM: Record<string, string> = {
  bigquery: 'BIGQUERY',
  spanner: 'SPANNER',
  alloydb: 'ALLOYDB',
  cloudsql_mysql: 'MYSQL',
  cloudsql_postgresql: 'POSTGRES',
};

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

function textsFor(
    f: Pick<
        Field,
        'expression'|'dialects'|'importedExpression'|'importedDialect'>,
    dialect: string|null|undefined): Array<{text: string; dialect: string}> {
  if (dialect === null) return [];
  if (dialect === undefined) return expressionSources(f);
  const text = expressionForDialect(f, dialect as SqlDialect);
  return text !== undefined ? [{text, dialect}] : [];
}

export function noTextFor(
    f: Parameters<typeof textsFor>[0], dialects: string[]): boolean {
  return isFieldBound(f) && dialects.every(d => !textsFor(f, d).length);
}

export interface TableDialects {
  name: string;
  dialects: string[];
  unread?: boolean;
  guessed?: boolean;
}

export function tableDialects(
    entity: Pick<Entity, 'abstract'|'authoredSource'|'dataSource'|'sourceDialect'>,
    withUnread: boolean): TableDialects|undefined {
  const dialect = sourcesDialect({entities: [entity]});
  if (dialect) return {name: dialect, dialects: [dialect]};
  if (!withUnread) return undefined;
  const source = writtenSource(entity);
  const table = cloudSqlTableOf(source);
  if (table) {
    const mysql = DIALECT_OF_SYSTEM.cloudsql_mysql;
    if (!table.inSchema) return {name: mysql, dialects: [mysql], guessed: true};
    const dialects = [...new Set(Object.values(DIALECT_OF_ENTRY_TYPE))].filter(
        d => d !== mysql);
    return {name: 'Cloud SQL', dialects, unread: true};
  }
  if (thirdPartyEntryOf(source)) {
    const dialects = [...DIALECT_OF_FQN_PREFIX.values()];
    return {name: 'third-party', dialects, unread: true};
  }
  if (spannerDatabaseOf(source)) {
    return {name: 'Spanner', dialects: ['SPANNER', 'POSTGRES'], unread: true};
  }
  return undefined;
}

export function fieldsOnTables(model: SemanticModel, withUnread = false):
    Array<{entity: Entity; field: Field; table: TableDialects}> {
  return resolvedEntities(model).flatMap(entity => {
    const table = tableDialects(entity, withUnread);
    if (!table) return [];
    return (entity.fields ?? []).map(field => ({entity, field, table}));
  });
}

export function importCommand(flags: string, version?: string): string {
  const flavor = version === GOOGLE_VERSION ? 'google' :
      version === OSSIE_VERSION             ? 'ossie' :
                                              '<ossie|google>';
  return `kcmd import <file> --input first-party --flavor ${flavor} ${flags}`;
}

export function importTranspiles(
    f: Parameters<typeof textsFor>[0], dialect: string|undefined,
    model: Pick<SemanticModel, 'entities'>): boolean {
  return dialect === 'BIGQUERY' && !!f.importedExpression &&
      translatesToBigQuery(f, (model.entities ?? []).map(e => e.name));
}

export function importHint(
    f: Parameters<typeof textsFor>[0], dialect: string,
    model: Pick<SemanticModel, 'entities'|'version'>): string {
  if (!importTranspiles(f, dialect, model)) return '';
  return `; give it one, or add one with '${
      importCommand('--transpile', model.version)}'`;
}

export function sourcesDialect(model: {
  entities?: ReadonlyArray<
      Pick<Entity, 'abstract'|'authoredSource'|'dataSource'|'sourceDialect'>>;
}): string|null|undefined {
  return dialectOfSources(
      (model.entities ?? [])
          .filter(e => !e.abstract && (e.authoredSource || e.dataSource))
          .map(e => ({
                 source: writtenSource(e),
                 lookedUp: e.sourceDialect,
               })));
}

function dialectOfSources(sources: Array<{source: string; lookedUp?: string}>):
    string|null|undefined {
  if (sources.length &&
      sources.every(s => dialectLookupKey(s.source.trim()) && !s.lookedUp)) {
    return null;
  }
  const dialects = new Set<string|undefined>(sources.map(({source, lookedUp}) => {
    const s = source.trim();
    if (dialectLookupKey(s)) return lookedUp;
    const db = databaseOf(s) ??
        (/^[^./:\s`]+\.[^./:\s`]+\.[^./:\s`]+$/.test(s) ? 'bigquery' :
                                                         undefined);
    return db ? DIALECT_OF_SYSTEM[db.split('/')[0]] : undefined;
  }));
  if (dialects.size !== 1) return undefined;
  return [...dialects][0];
}

export function firstEntityPerDatabase(
    bindings: ReadonlyArray<{entity: string; source: string; lookedUp?: string}>,
    sourceDatabases?: ReadonlyMap<string, string>): string[] {
  const databases = new Map<string, string>();
  const unreadTables:
      Array<{entity: string; key: string; fits: (key: string) => boolean}> = [];
  const isThirdParty = (k: string) => k.startsWith('thirdparty/') ||
      [...DIALECT_OF_FQN_PREFIX.keys()].some(p => k.startsWith(`${p}/`));
  for (const {entity, source, lookedUp} of bindings) {
    const s = source.trim();
    const db = databaseOf(s);
    if (!db) continue;
    const table = cloudSqlTableOf(s);
    const instance = table?.resourceName.split('/databases/')[0];
    if (lookedUp === undefined && table?.inSchema) {
      const fits = (k: string) => k === db || k === instance;
      unreadTables.push({entity, key: instance!, fits});
      continue;
    }
    if (lookedUp === undefined && db === 'thirdparty') {
      unreadTables.push({entity, key: 'thirdparty/', fits: isThirdParty});
      continue;
    }
    const key = table && lookedUp === 'SQLSERVER' ? instance! :
        db !== 'thirdparty' ? db :
        sourceDatabases?.get(s) ?? `thirdparty/${lookedUp}`;
    if (!databases.has(key)) databases.set(key, entity);
  }
  for (const [prefix, systemDialect] of DIALECT_OF_FQN_PREFIX) {
    if ([...databases.keys()].some(k => k.startsWith(`${prefix}/`))) {
      databases.delete(`thirdparty/${systemDialect}`);
    }
  }
  for (const u of unreadTables) {
    if (![...databases.keys()].some(u.fits)) databases.set(u.key, u.entity);
  }
  return [...databases.values()];
}

export interface CompletenessOptions extends DialectLoad {
  ownSqlOnly?: {dialect?: string|null};
}

export function validateProfileCompleteness(
    baseModel: SemanticModel, profile: ProfileSpec, warnings: string[] = [],
    opts: CompletenessOptions = {}): string[] {
  const errors: string[] = [];
  const unreadable = new Set<string>();
  const at = `profile '${profile.name}'`;
  errors.push(...profileProblems(baseModel, profile));
  const entities = baseModel.entities ?? [];
  const byName = new Map(entities.map(e => [e.name, e]));
  const fieldsOf = fieldsByEntity(baseModel);
  const unknownAncestry = unresolvedEntities(baseModel);
  const {model: profiled, errors: unread} =
      applyBindings(
          baseModel, profile, {load: {sourceDialects: opts.sourceDialects}});
  errors.push(...unread.map(e => `${at}: ${e}`));
  const profiledError = inheritanceErrorOf(profiled);
  if (profiledError && !inheritanceErrorOf(baseModel)) {
    errors.push(`${at}: ${profiledError}`);
  }
  if (!profiledError) {
    const asWritten =
        applyBindings(baseModel, profile, {noSqlAsWritten: true}).model;
    const checked = inheritanceErrorOf(asWritten) ? profiled : asWritten;
    const inherited =
        inheritedNoSqlProblems(checked.entities, declaredConceptFields(checked));
    errors.push(...inherited.map(p => `${at}: ${p}`));
  }
  const seenOf = fieldsByEntity(profiled);
  const defaultBound = fieldsByEntity(withDefaultBindings(profiled));
  const bindingOf = new Map(profile.entities.map(e => [e.name, e]));
  const stated: Array<{entity: string; source: string; lookedUp?: string}> =
      [];
  const profiledByName =
      new Map((profiled.entities ?? []).map(e => [e.name, e]));
  const rejected = new Set<string>();
  for (const e of entities) {
    if (e.abstract || e.definition) continue;
    const pe = bindingOf.get(e.name);
    const profiledEntity = profiledByName.get(e.name) ?? e;
    if (pe?.source === undefined) {
      if (!tablelessByDesign(profiledEntity)) {
        errors.push(`${at}: entity '${e.name}' has no source in this profile`);
      }
      continue;
    }
    const db = databaseOf(pe.source.trim());
    if (!db || profiledEntity?.authoredSource !== pe.source.trim()) {
      rejected.add(e.name);
      continue;
    }
    const lookedUp = profiledEntity.sourceDialect;
    stated.push({entity: e.name, source: pe.source, lookedUp});
  }
  const databases = firstEntityPerDatabase(stated, opts.sourceDatabases);
  if (databases.length > 1) {
    const named = databases.map(n => `'${n}'`).join(', ');
    errors.push(
        `${at} binds entities in more than one database (${named}); a ` +
        `profile reads from one system a single query can reach`);
  }
  const dialect = dialectOfSources(stated);

  for (const pe of profile.entities) {
    const e = byName.get(pe.name);
    if (!e || e.abstract || e.definition) continue;
    const known = fieldsOf.get(pe.name)!;
    const others = entities.map(x => x.name).filter(n => n !== pe.name);
    for (const pf of pe.fields ?? []) {
      const readable = expressionSources(pf).filter(
          s => noSqlReason(s.text, s.dialect, pe.name) === undefined &&
              !(s.dialect === 'ANSI_SQL' && dialect === null));
      for (const {text, dialect: written} of readable) {
        const columns = columnReferences(
            text, written === 'ANSI_SQL' && dialect ? dialect : written);
        if (!columns) {
          unreadable.add(fieldLabel(pe.name, pf.name));
          continue;
        }
        for (const other of others) {
          if (fieldsReadOn(columns, other).length) {
            errors.push(
                `${at}: field '${pe.name}.${pf.name}' reads entity '${
                    other}'; a field expression reads only its own entity`);
          }
        }
        errors.push(...new Set(columns.flatMap(
            c => qualifierCaseError(`${at}: field '${pe.name}.${pf.name}'`, c,
                                    entities.map(x => x.name)) ?? [])));
        for (const ref of fieldsReadOn(columns, pe.name)) {
          if (!known.has(ref) && !unknownAncestry.has(pe.name)) {
            errors.push(
                `${at}: field '${pe.name}.${pf.name}' reads '${pe.name}.${
                    ref}', which is not a field of '${pe.name}'`);
          } else if (ref === pf.name) {
            errors.push(`${at}: ${selfReferenceMessage(pe.name, [pf.name])}`);
          }
        }
      }
    }
  }

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

  for (const e of entities) {
    const pe = bindingOf.get(e.name);
    const profiledEntity = profiledByName.get(e.name) ?? e;
    if (!pe || e.abstract || tablelessByDesign(profiledEntity)) continue;
    const missing: string[] = [];
    if (e.keys.length && !pe.primaryKey?.length) missing.push('primary_key');
    if (nonEmptyKeys(e.uniqueKeys).length &&
        !nonEmptyKeys(pe.uniqueKeys).length) {
      missing.push('unique_keys');
    }
    if (missing.length) {
      errors.push(
          `${at}: entity '${e.name}' has no ${missing.join(' or ')} in this ` +
          `profile; the model file's keys are columns of its own table, so ` +
          `state this profile's keys`);
    }
  }

  for (const r of baseModel.relationships ?? []) {
    if (r.association || r.abstract || r.via?.length) continue;
    const pr = profile.relationships.find(x => x.name === r.name);
    const from = pr?.fromColumns ?? [];
    const to = pr?.toColumns ?? [];
    if (!from.length || !to.length) {
      errors.push(`${at}: ${profileJoinMessage(r.name)}`);
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

  const excluded = new Set<string>();
  const unknownProfiled = unresolvedEntities(profiled);
  for (const e of entities) {
    if (e.abstract || e.definition) continue;
    const pe = bindingOf.get(e.name);
    for (const name of pe?.fieldsExclude ?? []) {
      excluded.add(`${e.name}.${name}`);
    }
    const listedOn = [
      e,
      ...ancestorsOf(e.name, byName).filter(a => !a.abstract && !a.definition),
    ];
    const rebound = new Set(listedOn.flatMap(
        x => (bindingOf.get(x.name)?.fields ?? [])
                 .map(f => f.name)
                 .filter(n => x === e || fieldsOf.get(x.name)?.has(n))));
    for (const f of defaultBound.get(e.name)?.values() ?? []) {
      if (!isFieldBound(f) && !rebound.has(f.name) &&
          !(unknownProfiled.has(e.name) &&
            inheritedNamesOf(profiled, e.name).has(f.name))) {
        errors.push(
            `${at}: field '${e.name}.${f.name}' has no binding in the model ` +
            `file; bind it in 'fields' or leave it out in 'fields_exclude'`);
      }
    }
  }

  for (const e of entities) {
    const pe = bindingOf.get(e.name);
    const profiledEntity = profiledByName.get(e.name) ?? e;
    if (!pe || e.abstract || tablelessByDesign(profiledEntity) ||
        unknownProfiled.has(e.name)) {
      continue;
    }
    const restated = new Set((pe.fields ?? []).map(f => f.name));
    for (const name of seenOf.get(e.name)?.keys() ?? []) {
      const read = !restated.has(name) &&
          columnBinding(profiled, e.name, name, dialect);
      if (!read) continue;
      const through = read.owner === e.name ?
          'its model file expression' :
          `the expression it inherits from '${read.owner}'`;
      errors.push(
          `${at}: field '${e.name}.${name}' reads column '${read.column}' ` +
          `through ${through}; bind it in 'fields' for this profile, or ` +
          `leave it out in 'fields_exclude'`);
    }
  }

  const readOtherwise = new Set<string>();
  const noteUnread =
      (what: string, owner: Pick<Field, 'dialects'>,
       text: {text: string; dialect: string}) => {
        const asWritten = text.dialect !== 'ANSI_SQL' &&
            (owner.dialects ?? []).some(
                d => d.dialect === text.dialect && d.expression === text.text);
        const callerFails = !!opts.ownSqlOnly &&
            !columnsForSource(text.text, 'ANSI_SQL', opts.ownSqlOnly.dialect);
        if (!asWritten && !callerFails) readOtherwise.add(what);
      };
  if (dialect) {
    for (const e of entities) {
      const profiledEntity = profiledByName.get(e.name) ?? e;
      if (e.abstract || e.definition || tablelessByDesign(profiledEntity) ||
          rejected.has(e.name)) {
        continue;
      }
      for (const f of seenOf.get(e.name)?.values() ?? []) {
        const asInModelFile = fieldsOf.get(e.name)?.get(f.name);
        const reported = !!asInModelFile &&
            JSON.stringify(expressionSources(f)) ===
                JSON.stringify(expressionSources(asInModelFile)) &&
            sourcesDialect({entities: [e]}) === dialect;
        if (noTextFor(f, [dialect]) && !reported) {
          errors.push(
              `${at}: field '${e.name}.${f.name}' has no expression for ${
                  dialect} or ANSI_SQL, and this profile's sources are ${
                  dialect}${importHint(f, dialect, baseModel)}`);
        }
      }
    }
    if (profile.metricsExclude !== '*') {
      const excludedMetrics = new Set(profile.metricsExclude ?? []);
      for (const m of baseModel.metrics ?? []) {
        if (!excludedMetrics.has(m.name) && noTextFor(m, [dialect])) {
          const viaImport = importTranspiles(m as Field, dialect, baseModel) ?
              ` add one with '${
                  importCommand('--transpile', baseModel.version)}',` :
              '';
          errors.push(
              `${at}: metric '${m.name}' has no expression for ${dialect} or ` +
              `ANSI_SQL, and this profile's sources are ${dialect}; give it ` +
              `one,${viaImport} or add it to 'metrics_exclude'`);
        }
      }
    }
  }

  const dangling = new Map<string, string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of entities) {
      if (e.abstract || e.definition) continue;
      for (const f of seenOf.get(e.name)?.values() ?? []) {
        const key = `${e.name}.${f.name}`;
        if (excluded.has(key) || dangling.has(key)) continue;
        for (const dep of fieldDependencies(
                 profiled, e.name, f.name, unreadable, dialect, noteUnread)) {
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
        if (noSqlReason(text.text, text.dialect) !== undefined) continue;
        const columns = columnReferences(text.text, text.dialect);
        if (columns) {
          read.push(columns);
        } else {
          unreadable.add(metricLabel(m.name));
          noteUnread(metricLabel(m.name), m, text);
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
  const own = new Set(profile.entities.flatMap(
      pe => (pe.fields ?? []).map(pf => fieldLabel(pe.name, pf.name))));
  const caller = opts.ownSqlOnly;
  const callerWarns = (what: string) => !!caller &&
      (caller.dialect === dialect || !readOtherwise.has(what));
  for (const what of unreadable) {
    if (!own.has(what) && callerWarns(what)) {
      continue;
    }
    warnings.push(
        `${at}: kcmd could not read the SQL of ${what}, so the fields it ` +
        `reads were not checked`);
  }
  return errors;
}

export function validateProfileConsistency(
    baseModel: SemanticModel, profiles: ProfileSpec[],
    applied?: string): string[] {
  const errors: string[] = [];
  const entities = baseModel.entities ?? [];
  const byName = new Map(entities.map(e => [e.name, e]));
  for (const r of baseModel.relationships ?? []) {
    if (r.association || r.abstract || r.via?.length) continue;
    const rawTarget = byName.get(r.destination.entity);
    if (!rawTarget || rawTarget.abstract || rawTarget.definition) continue;
    const target = withVocabularyBindings(rawTarget);
    const appliedJoin = profiles.find(p => p.name === applied)
                            ?.relationships.find(x => x.name === r.name);
    const checkedByPush = applied === undefined ? undefined :
        appliedJoin?.toColumns.length ? `profile '${applied}'` :
                                        'the model file';
    const record =
        (who: string, to: string[], pk: string[], uks: string[][]) => {
          if (!to.length || ![...to, ...pk, ...uks.flat()].every(isColumnName)) {
            return;
          }
          if (!coversKey(to, pk, uks) && who !== checkedByPush) {
            errors.push(
                `relationship '${r.name}': ${who} joins on to_columns ${
                    JSON.stringify(to)}, which cover no primary or unique key ` +
                `of '${target.name}'`);
          }
        };
    record(
        'the model file', r.destination.columns, target.keys,
        target.uniqueKeys ?? []);
    for (const p of profiles) {
      const pr = p.relationships.find(x => x.name === r.name);
      const pe = p.entities.find(e => e.name === target.name);
      record(
          `profile '${p.name}'`, pr?.toColumns ?? [],
          pe?.primaryKey?.length ? pe.primaryKey : target.keys,
          nonEmptyKeys(pe?.uniqueKeys).length ? pe!.uniqueKeys! :
                                               target.uniqueKeys ?? []);
    }
  }
  return errors;
}

export interface LocalCheckError {
  error: string;
  document?: string;
  profile?: string;
}

export function namedProfileErrors(
    docs: Array<{name: string; text: string}>,
    baseByDoc: Map<string, SemanticModel>,
    profileDocs: ProfileFiles, declared: DeclaredProfiles,
    warnings: string[], load: DialectLoad): LocalCheckError[] {
  const errors: LocalCheckError[] = [];
  for (const d of docs) {
    let named: Array<{name: string; label: string; read: () => ProfileSpec}>;
    try {
      named = [
        ...profileDocs(d.name).map(p => ({
          name: p.name,
          label: p.fileName,
          read: () => loadProfileFile(p.text, p.name, {skipActions: true}),
        })),
        ...declared(d).flatMap(p => 'spec' in p ? [{
          name: p.name,
          label: p.label ?? d.name,
          read: () => {
            const {actions: _, ...spec} = p.spec;
            return spec;
          },
        }] : []),
      ].filter(p => p.name.toLowerCase() !== DEFAULT_PROFILE);
    } catch (err: any) {
      errors.push({error: `${err.message || err}`, document: d.name});
      continue;
    }
    const base = baseByDoc.get(d.name);
    if (!base) continue;
    const logical = {...base, actions: []};
    const ownSqlOnly = !inheritanceErrorOf(base) ?
        {dialect: sourcesDialect(base)} :
        undefined;
    const specs: ProfileSpec[] = [];
    for (const p of named) {
      const at = (m: string) => `[${p.label}] ${m}`;
      const tag = (m: string) =>
          ({error: at(m), document: d.name, profile: p.name});
      let spec: ProfileSpec;
      try {
        spec = p.read();
      } catch (err) {
        if (!(err instanceof SemanticModelError)) throw err;
        errors.push(tag(err.message));
        continue;
      }
      specs.push(spec);
      const profileWarnings: string[] = [];
      errors.push(
          ...validateProfileCompleteness(logical, spec, profileWarnings, {
            ownSqlOnly,
            ...load,
          }).map(tag));
      warnings.push(...profileWarnings.map(at));
    }
    errors.push(...validateProfileConsistency(logical, specs, DEFAULT_PROFILE)
                    .map(e => ({error: `[${d.name}] ${e}`, document: d.name})));
  }
  return errors;
}

function fieldsByEntity(model: SemanticModel): Map<string, Map<string, Field>> {
  let resolved: Entity[] = model.entities ?? [];
  if (resolved.some(e => e.extends?.length)) {
    try {
      resolved = resolveInheritance(model).model.entities ?? resolved;
    } catch (err) {
      if (!(err instanceof InheritanceError)) throw err;
      resolved = resolved.map(e => resolvedAlone(model, e.name) ?? e);
    }
  }
  return new Map(resolved.map(e => {
    const excluded = new Set(e.excludedFields ?? []);
    return [
      e.name,
      new Map(e.fields.filter(f => !excluded.has(f.name)).map(f => [f.name, f])),
    ];
  }));
}

function resolvedAlone(model: SemanticModel, name: string): Entity|undefined {
  const byName = new Map((model.entities ?? []).map(e => [e.name, e]));
  const line = new Set<string>();
  const queue = [name];
  while (queue.length) {
    const n = queue.shift()!;
    if (line.has(n)) continue;
    line.add(n);
    queue.push(...(byName.get(n)?.extends ?? []));
  }
  try {
    const entities = (model.entities ?? []).filter(e => line.has(e.name));
    return resolveInheritance({...model, entities})
        .model.entities?.find(e => e.name === name);
  } catch (err) {
    if (!(err instanceof InheritanceError)) throw err;
    return undefined;
  }
}

function unresolvedEntities(model: SemanticModel): Set<string> {
  if (!inheritanceErrorOf(model)) return new Set();
  return new Set((model.entities ?? [])
                     .filter(e => e.extends?.length &&
                                 !resolvedAlone(model, e.name))
                     .map(e => e.name));
}

export function inheritanceErrorOf(model: SemanticModel): string|undefined {
  if (!(model.entities ?? []).some(e => e.extends?.length)) return undefined;
  try {
    resolveInheritance(model);
    return undefined;
  } catch (err) {
    if (!(err instanceof InheritanceError)) throw err;
    return err.message;
  }
}

function fieldLabel(entity: string, field: string): string {
  return `field '${entity}.${field}'`;
}

function metricLabel(name: string): string {
  return `metric '${name}'`;
}

function boundDeclaration(
    model: SemanticModel, entityName: string,
    field: string): {owner: string; field: Field}|undefined {
  const byName = new Map((model.entities ?? []).map(e => [e.name, e]));
  const bindingOn = (name: string) => byName.get(name)?.fields.find(
      f => f.name === field && isFieldBound(f));
  let owner = bindingOn(entityName) ? entityName : undefined;
  if (!owner) {
    let depth = -1;
    for (const a of ancestorsOf(entityName, byName)) {
      const d = bindingOn(a.name) ? ancestorsOf(a.name, byName).length : -1;
      if (d > depth) [owner, depth] = [a.name, d];
    }
  }
  return owner ? {owner, field: bindingOn(owner)!} : undefined;
}

export function columnBinding(
    model: SemanticModel, entityName: string, field: string,
    dialect?: string|null): {owner: string; column: string}|undefined {
  const byName = new Map((model.entities ?? []).map(e => [e.name, e]));
  const bound = boundDeclaration(model, entityName, field);
  if (!bound || byName.get(bound.owner)?.abstract) return undefined;
  for (const {text, dialect: written} of expressionSources(bound.field)) {
    const c = columnsForSource(text, written, dialect)
                  ?.find(c => !byName.has(c.qualifier ?? ''));
    if (c) {
      return {
        owner: bound.owner,
        column: c.qualifier ? `${c.qualifier}.${c.name}` : c.name,
      };
    }
  }
  return undefined;
}

function fieldDependencies(
    model: SemanticModel, entityName: string, field: string,
    unreadable: Set<string>, dialect?: string|null,
    onUnread?: (what: string, owner: Field,
                text: {text: string; dialect: string}) => void): string[] {
  const bound = boundDeclaration(model, entityName, field);
  if (!bound) return [];
  const name = bound.owner;
  const deps = new Set<string>();
  for (const text of textsFor(bound.field, dialect)) {
    if (noSqlReason(text.text, text.dialect, name) !== undefined) continue;
    const columns = columnReferences(text.text, text.dialect);
    if (!columns) {
      unreadable.add(fieldLabel(name, field));
      onUnread?.(fieldLabel(name, field), bound.field, text);
      continue;
    }
    for (const dep of fieldsReadOn(columns, name)) deps.add(dep);
  }
  return [...deps];
}

export function statesKey(
    primaryKey: string[]|undefined, uniqueKeys: string[][]|undefined): boolean {
  return !!primaryKey?.length || nonEmptyKeys(uniqueKeys).length > 0;
}

function nonEmptyKeys(keys: string[][]|undefined): string[][] {
  return (keys ?? []).filter(k => k.length > 0);
}
