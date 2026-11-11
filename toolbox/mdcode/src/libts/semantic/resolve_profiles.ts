// Applies a chosen binding profile to a logical semantic model, and prunes what
// the resulting binding cannot answer.
//
// A model is authored as ONE logical declaration (entities, fields,
// relationships, metrics, the grain, and the graph shape) plus zero or more
// BINDING PROFILES that supply the physical facets it leaves open: each entity's
// `source`, each field's column (`expression`) and each action's `executor`.
// `kcmd push` applies the profile each deployment names to the logical model
// BY NAME and deploys the result. See docs/semantic-model/profiles.md.
//
// Two passes live here:
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
//   - pruneUnavailable runs over the loaded IR and drops each field left unbound
//     or excluded, every field that reads one of those, and every metric whose
//     expression reads any of them, returning the pruned model and a
//     per-profile availability report. Keys and join columns are physical
//     columns rather than fields, so pruning fields never removes an entity or
//     a relationship.

import * as yaml from 'yaml';

import {Action, coversKey, Entity, expressionForDialect, Field, FIELD_BINDING_KEYS, isFieldBound, Metric, ProfileEntityBinding, ProfileRelationshipBinding, ProfileSpec, Relationship, SemanticModel, SqlDialect} from './ir';
import {cloudSqlTableOf, databaseOf, DEFAULT_DIALECT, DIALECT_OF_ENTRY_TYPE, DIALECT_OF_FQN_PREFIX, dialectLookupKey, entityAndMetricWarnings, expressionDocOf, GOOGLE_VERSION, googleBlockProfiles, inferMetricEntities, inheritedNoSqlProblems, joinLengthMessage, listed, LoadOptions, loadSemanticModels, modelFileKeysAt, noSqlReason, OSSIE_VERSION, parseExecutor, parseFieldBinding, parseFieldExpression, parseSource, readFieldExpression, SemanticModelError, spannerDatabaseOf, thirdPartyEntryOf, writtenSource} from './loader';
import {qualifierCaseError} from './names';
import {declaredConceptFields, InheritanceError, resolveInheritance} from './resolve_inheritance';
import {columnReferences, columnsForSource, entitiesReached, fieldsReadOn, isColumnName, selfReferenceMessage} from './sql_expr_utils';
import {SqlColumn} from './sql_parser';
import {translatesToBigQuery} from './transpile';
import {YAML_OPTIONS} from './yaml_options';

// The implicit profile: the inline bindings already in the model document (the
// combined single-file form).
export const DEFAULT_PROFILE = 'default';

// Keys a profile may carry at each level. A key the model file takes at the
// same level is a logical declaration the model owns; setting it in a profile
// is rejected so swapping a profile can move data but never change what the
// model means. Any other key is unknown.
export const PROFILE_FILE_KEYS = new Set([
  'name', 'entities', 'relationships', 'metrics_exclude', 'actions',
]);
const PROFILE_ENTITY_KEYS = new Set([
  'name', 'source', 'primary_key', 'unique_keys', 'fields', 'fields_exclude',
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


// One profile's availability outcome: the fields it leaves unbound, and the
// building blocks that fall with them.
export interface AvailabilityReport {
  profile: string;
  unboundFields: string[];  // "Entity.field"
  excludedFields: string[];  // The unbound fields the profile excludes.
  // No pruning rule drops an entity or a relationship, so droppedEntities and
  // droppedRelationships are always empty (see the file header).
  droppedEntities: {name: string; reason: string}[];
  // `field` is the unavailable field the metric reads, as "Entity.field",
  // when that is why it is dropped.
  droppedMetrics: {name: string; reason: string; field?: string}[];
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
 * it. What a field or metric reads comes from the text `dialect` evaluates
 * (see textsFor). `dialect` defaults to the dialect the model's sources
 * imply. When the sources are in systems of different dialects, or one names
 * no system, there is no dialect and every text counts. When no lookup read
 * the dialect, it is null and no text counts.
 * The input is never mutated. The report names each dropped block
 * and the unbound field that stops it, so a caller can state the withheld
 * coverage. A model with nothing unbound resolves unchanged.
 */
export function pruneUnavailable(
    model: SemanticModel, profileName: string,
    dialect: string|null|undefined = sourcesDialect(model)):
    {model: SemanticModel; report: AvailabilityReport} {
  const clone: SemanticModel = structuredClone(model);
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

  // A field is bound when isFieldBound says so; otherwise it is unbound
  // (structurally absent under this profile). A field awaiting transpilation
  // (its column carried on the imported expression) or bound only through a
  // dialect list counts as bound, not dropped. The graph generators ask a
  // narrower question, whether the field has SQL for their engine, and leave
  // out a bound field that has none with a warning of their own.
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
      report.excludedFields.push(`${e.name}.${name}`);
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
    // An unqualified name reads a field of the metric's entity.
    const hit = firstUnboundReferenced(
        columns.map(c => c.qualifier === undefined && mt.entity ?
                        {...c, qualifier: mt.entity} : c),
        unavailable);
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

// `model` without the exclusions a profile marked on it.
export function withoutExclusions(model: SemanticModel): SemanticModel {
  const out = structuredClone(model);
  for (const e of out.entities ?? []) delete e.excludedFields;
  delete out.excludedMetrics;
  return out;
}

// Each entity resolved for inheritance, or as declared when the hierarchy is
// broken, which push reports elsewhere. `extends` is expanded to every
// ancestor.
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

// The names of the fields `entityName` inherits from every ancestor its
// `extends` reaches. A caller asking for many entities passes `byName`, the
// model's entities by name, built once.
export function inheritedNamesOf(
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


/**
 * Reads a profile file into the IR's `ProfileSpec`. Throws on anything a
 * profile may not say: an unknown key at any level, a value of the wrong shape,
 * a field in both `fields` and `fields_exclude`, `"*"` inside a
 * `metrics_exclude` list, or a `name` other than `profileName`. A field
 * expression and an action's executor are read by the loader's own readers, so
 * each follows the rules it follows in a model file. A source is kept as
 * written, and applyProfile reads it with the loader's reader too. A field
 * expression's short form means `ANSI_SQL` in either flavor. Actions are out of
 * scope for the preview, so nothing more is checked. With `skipActions`, the
 * profile's actions are not read.
 */
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

// The source dialects a command looked up before it loads
// (LoadOptions.sourceDialects). `sourceDatabases` holds the database each
// third-party table's entry names, by entry name, for the one-database rule.
export type DialectLoad = Pick<LoadOptions, 'sourceDialects'>&
    {sourceDatabases?: ReadonlyMap<string, string>};

/** How a profile's values are read, matching the load of the model. */
export interface ApplyProfileOptions {
  // The preferred dialect the model was loaded with, which picks the text each
  // field takes, and the source dialects it was given.
  load?: Pick<LoadOptions, 'dialect'|'sourceDialects'>;
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
 * entity, states one of a relationship's join column lists without the
 * other or gives both lists with different lengths, gives a source or
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
    // warnings, judged on its tables in the load dialect, as the callers
    // judge them. Keep those the model did not give already.
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
 * document name. With `skipActions`, the profile's actions are not read.
 */
export function applyProfileFile(
    model: SemanticModel, text: string, profileName: string,
    opts: Omit<ApplyProfileOptions, 'warnings'> = {}, skipActions = false):
    {model: SemanticModel; warnings: string[]}|{error: string} {
  // Checked before the profile is read, so a model with a `sql` executor
  // reports that first even when the profile file does not parse.
  // profileApplyError checks it again for a profile built in memory.
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
  // The model document with the profile applied.
  model: SemanticModel;
  // The document's load warnings, less those the profile settles, then those
  // its values give, each prefixed with the document name.
  warnings: string[];
}

/**
 * Loads the model document `doc` on its own and applies `profile` to it. An
 * error says whether the document failed to load or the profile failed to
 * apply, since the callers word the two differently. With `skipActions`,
 * neither the profile's actions nor the model's take part.
 */
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

/** applyProfileToDocument for the profile file `text`. */
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

// Loads `doc` on its own and calls `apply` on its model, without the model's
// actions when `skipActions` is set.
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

/**
 * A profile a model declares: the text of a profile file, or a profile already
 * read, such as one a vanilla model carries in its GOOGLE block. A profile
 * already read may carry `label`, the file that holds it, which
 * namedProfileErrors names in place of the model document.
 */
export type DeclaredProfile = {name: string; text: string}|
    {name: string; spec: ProfileSpec; label?: string};

// Gives the profiles a model document declares: its profile files, then the
// profiles a vanilla model carries in its GOOGLE block.
export type DeclaredProfiles = (doc: {name: string; text: string}) =>
    DeclaredProfile[];

// A model's profile files, each with the file name messages give it.
export type ProfileFiles =
    (model: string) => Array<{name: string; text: string; fileName: string}>;

/**
 * The profiles the model document `doc` declares: `files`, its profile files,
 * then the profiles a vanilla model carries in its GOOGLE block, by name, as
 * the layout orders profile files. Push, `kcmd profiles` and the runtime all
 * read them here, so they agree. Throws SemanticModelError, naming the
 * document as a load does, when googleBlockProfiles throws, such as on block
 * profiles a load rejects.
 */
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

/** A profile applied to one model document. */
export type DocumentProfile = ({kind: 'file'}&AppliedProfile)|
    {kind: 'error'; error: string; stage: 'load'|'apply'}|{
  // The document declares no profile by that name.
  kind: 'missing';
  declared: string[];
};

/**
 * Finds the profile `profileName` among `profiles`, the ones the model
 * document `doc` declares, and applies it, as push, `kcmd profiles` and the
 * runtime do. It applies to the document loaded on its own. With
 * `skipActions`, neither the profile's actions nor the model's take part, as
 * in the profile push publishes to Knowledge Catalog.
 */
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

/**
 * The warnings that applying the profile `profileName` among `profiles` to the
 * model document `doc` gives, each labeled with the profile. The profile is
 * applied as push publishes it, without actions, so a profile whose actions
 * do not apply gives them too. The warnings in `own`, which the document's own
 * load gives, are left out. Empty unless profileForDocument applies the
 * profile as a profile file.
 */
export function appliedProfileWarnings(
    doc: {name: string; text: string}, profiles: DeclaredProfile[],
    profileName: string, own: string[], load: DialectLoad = {}): string[] {
  const res =
      profileForDocument(doc, profiles, profileName, load, {skipActions: true});
  if (res.kind !== 'file') return [];
  return res.warnings.filter(w => !own.includes(w))
      .map(w => `profile '${profileName}': ${w}`);
}

/**
 * `error`, from loading a model document on its own before a profile file
 * applies to it, with a note that says so. A model file that a profile used to
 * complete, such as one with a half-given join, fails that load. Names
 * `profileName` when one profile is selected.
 */
function modelFileAloneMessage(
    error: string, profileName?: string): string {
  return profileName === undefined ?
      `${error} (the model file must load on its own before a profile file ` +
          `applies)` :
      `${error} (under profile '${profileName}', the model file must load ` +
          `on its own before the profile applies)`;
}

/**
 * The error a command gives when a profile cannot be applied to the model
 * document `docName`, whose profile files are `profileFiles`. An error applying
 * a profile file names that file, as the profile checks do. An error applying
 * a profile from a GOOGLE block names the model document.
 */
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

/**
 * Why `model` cannot be used because a deployment names a binding profile
 * `declared` does not hold, or undefined when each names `default` or a
 * declared profile. `document` is the model's document, for the message.
 */
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
      `bindings. Rename the profile.`;
}

// The warnings a load of the applied model would give, each prefixed with the
// document name: those about its entities and metrics, from
// entityAndMetricWarnings, which builds them with the helpers the load uses,
// then the model file's other load warnings, about actions, which a profile
// does not change. That is the order a load gives them. The applied model is
// judged on its own tables, in the load's dialect.
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

// Every reason `profile` names something `model` cannot take, in this order:
// a `sql` executor in the model, the profile's own
// structure, and each action, entity, field, relationship and metric it names
// that the model does not declare or a profile cannot bind. applyProfile
// throws the first, and validateProfileCompleteness lists them all.
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
// profileProblems, then the join columns the profile states for each
// relationship. One list without the other gets the completeness check's
// error, and two lists must have equal length. A relationship the profile
// gives neither list keeps the model file's join columns, which the
// completeness check reports.
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

// The error for a relationship a named profile does not bind with both
// 'from_columns' and 'to_columns'.
function profileJoinMessage(relationship: string): string {
  return `relationship '${relationship}' has no join columns in this ` +
      `profile; a named profile states both 'from_columns' and ` +
      `'to_columns' itself`;
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
      if (!isFieldBound(pf as Field)) {
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
      // The profile's source replaces the model file's, and so does its
      // looked-up dialect, or the lack of one.
      if (parsed.sourceDialect) {
        e.sourceDialect = parsed.sourceDialect;
      } else {
        delete e.sourceDialect;
      }
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
      if (!isFieldBound(pf as Field)) continue;
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
  // A side the profile leaves empty keeps the model file's columns.
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
export function readerMessage(err: SemanticModelError): string {
  return err.message.replace(/^Semantic model load error: /, '');
}

// The entities another entity extends, directly or through others: exactly
// those named in some other entity's `extends`.
function entitiesWithDescendants(model: SemanticModel): Set<string> {
  return new Set((model.entities ?? []).flatMap(
      e => (e.extends ?? []).filter(p => p !== e.name)));
}

// Reads a parsed profile file into a ProfileSpec, throwing on anything a
// profile may not say. Shared by loadProfileFile and the loader's reading of a
// vanilla GOOGLE block's profiles, so the two agree on what a valid profile is.
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
  // The profile's own name is checked against the file name below.
  requireKeys(doc, PROFILE_FILE_KEYS, where, [], false);
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
          requireKeys(
              r, PROFILE_RELATIONSHIP_KEYS, `${where}: relationship`,
              ['relationships', 0]);
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
    // Actions are out of preview scope and gain no new checks, so when a
    // profile lists an action twice, the last entry wins.
    spec.actions = listOf(doc.actions, `${where} 'actions'`).map(a => {
      requireKeys(a, PROFILE_ACTION_KEYS, `${where}: action`, ['actions', 0]);
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
  requireKeys(e, PROFILE_ENTITY_KEYS, `${where}: entity`, ['datasets', 0]);
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
      requireKeys(
          f, PROFILE_FIELD_KEYS, `${at}: field`, ['datasets', 0, 'fields', 0]);
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
// `named` is false, a string `name`. `level` is the path of the same level in
// a model file, below its model (see modelFileKeysAt).
function requireKeys(
    obj: any, allowed: Set<string>, where: string,
    level: readonly PropertyKey[], named = true): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new SemanticModelError(`${where} is not a mapping`);
  }
  if (named && typeof obj.name !== 'string') {
    throw new SemanticModelError(`${where} has no 'name'`);
  }
  const at = named && obj.name !== undefined ? `${where} '${obj.name}'` : where;
  for (const k of Object.keys(obj)) {
    if (allowed.has(k)) continue;
    throw new SemanticModelError(
        modelFileKeysAt(level).includes(k) ?
            notAllowed(at, k) :
            `${at}: unknown key '${k}'; it takes ${
                listed([...allowed].map(a => `'${a}'`))}`);
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
// counts, each read in the dialect it is written in. With a null dialect, which
// no lookup read, the text the database runs is not known, and none counts.
function textsFor(
    f: Pick<
        Field,
        'expression'|'dialects'|'importedExpression'|'importedDialect'>,
    dialect: string|null|undefined): Array<{text: string; dialect: string}> {
  if (dialect === null) return [];
  if (dialect === undefined) return expressionSources(f);
  // The text a database of this dialect runs: its own entry, or the
  // ANSI_SQL one.
  const text = expressionForDialect(f, dialect as SqlDialect);
  return text !== undefined ? [{text, dialect}] : [];
}

// Whether a field or metric holds SQL but has no text in any of `dialects`
// and no ANSI_SQL text, so no table of those dialects runs it.
export function noTextFor(
    f: Parameters<typeof textsFor>[0], dialects: string[]): boolean {
  return isFieldBound(f) && dialects.every(d => !textsFor(f, d).length);
}

// An entity's table as a message names it, with every dialect it may run. A
// table whose dialect neither a lookup nor its name gives is `unread` and
// named after its system.
export interface TableDialects {
  name: string;
  dialects: string[];
  unread?: boolean;
  // Set for a Cloud SQL table read as MySQL from a name with no schema.
  guessed?: boolean;
}

// The table of `entity`, or undefined when the load does not know its
// dialect. With `withUnread`, a Cloud SQL, Spanner or third-party table no
// lookup has read is given too, and a Cloud SQL name with no schema gives
// MySQL.
export function tableDialects(
    entity: Pick<Entity, 'abstract'|'authoredSource'|'dataSource'|'sourceDialect'>,
    withUnread: boolean): TableDialects|undefined {
  const dialect = sourcesDialect({entities: [entity]});
  if (dialect) return {name: dialect, dialects: [dialect]};
  if (!withUnread) return undefined;
  const source = writtenSource(entity);
  const table = cloudSqlTableOf(source);
  if (table) {
    // Only a MySQL table's name has no schema.
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

// Each field of each entity whose table `tableDialects(entity, withUnread)`
// gives, with that table. An inherited field is listed on each entity that
// inherits it.
export function fieldsOnTables(model: SemanticModel, withUnread = false):
    Array<{entity: Entity; field: Field; table: TableDialects}> {
  return resolvedEntities(model).flatMap(entity => {
    const table = tableDialects(entity, withUnread);
    if (!table) return [];
    return (entity.fields ?? []).map(field => ({entity, field, table}));
  });
}

// The import command, ending in `flags`, that keeps the model file of `model`
// in its own flavor: `--flavor google` for a Google model, `--flavor ossie` for
// a vanilla one, and both flavors when no model is known. Push reads only files
// written for kcmd, so the command takes `--input first-party`. A third-party
// import names the command for the file it imports instead, which reads that
// file as another product's.
export function importCommand(
    flags: string,
    model?: Pick<SemanticModel, 'version'|'thirdPartyImport'>): string {
  const flavor = model?.version === GOOGLE_VERSION ? 'google' :
      model?.version === OSSIE_VERSION             ? 'ossie' :
                                                     '<ossie|google>';
  const input = model?.thirdPartyImport ? '' : ' --input first-party';
  return `kcmd import <file>${input} --flavor ${flavor} ${flags}`;
}

// Whether `kcmd import --transpile` gives BigQuery SQL to a field or metric
// of `model` with no text for `dialect`: true when `dialect` is BIGQUERY and
// import's translator turns its imported text into BigQuery SQL.
export function importTranspiles(
    f: Parameters<typeof textsFor>[0], dialect: string|undefined,
    model: Pick<SemanticModel, 'entities'>): boolean {
  return dialect === 'BIGQUERY' && !!f.importedExpression &&
      translatesToBigQuery(f, (model.entities ?? []).map(e => e.name));
}

// The hint that import can add a text in `dialect` to `f`, a field of
// `model`, or ''.
export function importHint(
    f: Parameters<typeof textsFor>[0], dialect: string,
    model: Pick<SemanticModel, 'entities'|'version'|'thirdPartyImport'>):
    string {
  if (!importTranspiles(f, dialect, model)) return '';
  return `; give it one, or add one with '${
      importCommand('--transpile', model)}'`;
}

// The dialect a model's sources imply: that of the one database every concrete
// entity with a source reads from, or undefined when they name several, a
// source names none, or no entity has one. It is null when every source is a
// table whose dialect no lookup read (see dialectOfSources).
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

// The dialect every one of `sources` implies, or undefined when one names no
// database in an accepted form or two imply different dialects. Two databases
// of one system, such as two AlloyDB databases, imply that system's dialect.
// A three-part dotted name names BigQuery.
//
// A Cloud SQL table written as its resource name, a third-party table and a
// Spanner table imply the dialect a lookup gave in `lookedUp`
// (LoadOptions.sourceDialects): the one their catalog entry or Spanner
// database gives. When every source is such a table and none was looked up,
// as when `kcmd import` cannot read them, the dialect is null: how their
// database reads an ANSI_SQL text is not known, so a check reads no such text.
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

// The first entity of `bindings` in each database their sources name, for the
// one-database rule. A source that names no database is left out.
export function firstEntityPerDatabase(
    bindings: ReadonlyArray<{entity: string; source: string; lookedUp?: string}>,
    sourceDatabases?: ReadonlyMap<string, string>): string[] {
  const databases = new Map<string, string>();
  // Each table whose entry no lookup read, with the keys of the databases it
  // may be in: its PostgreSQL database or its SQL Server instance for a Cloud
  // SQL table in a schema, and any third-party database for a third-party
  // table. `key` is the one it takes when it counts as a database of its own.
  const unreadTables:
      Array<{entity: string; key: string; fits: (key: string) => boolean}> = [];
  const isThirdParty = (k: string) => k.startsWith('thirdparty/') ||
      [...DIALECT_OF_FQN_PREFIX.keys()].some(p => k.startsWith(`${p}/`));
  for (const {entity, source, lookedUp} of bindings) {
    const s = source.trim();
    const db = databaseOf(s);
    if (!db) continue;
    // One query reaches every database of a SQL Server instance, so a SQL
    // Server table is keyed by its instance. A third-party table is in the
    // database its entry's fullyQualifiedName names. A Cloud SQL table in a
    // schema may be either engine's, so for it and for a third-party table
    // the entry decides which database of its system it is in. A table whose
    // entry no lookup read is compared after the loop.
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
  // A third-party table whose entry names no database is in the database of
  // the other tables of its system.
  for (const [prefix, systemDialect] of DIALECT_OF_FQN_PREFIX) {
    if ([...databases.keys()].some(k => k.startsWith(`${prefix}/`))) {
      databases.delete(`thirdparty/${systemDialect}`);
    }
  }
  // A table whose entry no lookup read counts as another database only when
  // none of the databases it may be in holds another table. Tables of two
  // systems are never in one database, so it always counts beside a table of
  // another system.
  for (const u of unreadTables) {
    if (![...databases.keys()].some(u.fits)) databases.set(u.key, u.entity);
  }
  return [...databases.values()];
}

/** What the caller of validateProfileCompleteness checks itself. */
export interface CompletenessOptions extends DialectLoad {
  // The caller warns about the model file's SQL that it reads, which it does
  // only when the hierarchy of the model it checks resolves. It reads an
  // ANSI_SQL text in `dialect`, as generic SQL when that is unset, and not at
  // all when it is null, and every other entry in its own dialect. A warning
  // about the model file's SQL is left out when the caller also warns about
  // each text this check cannot read: an entry in a dialect other than
  // ANSI_SQL, or an ANSI_SQL text when this profile's dialect is `dialect` or
  // the caller cannot read it either.
  ownSqlOnly?: {dialect?: string|null};
}

/**
 * Returns one message per reason `profile` cannot be deployed against
 * `baseModel`, or an empty list. Checks a single profile: nothing unknown,
 * every field it binds holding SQL on each entity that inherits it, every
 * concrete entity bound and all in one database, its own keys where the model
 * file states keys, every relationship bound, every field the model file
 * leaves unbound accounted for, every field whose expression reads a column
 * restated or excluded, and exclusions closed under dependency, metrics
 * included. The check that join columns cover a key of the target is in
 * validateProfileConsistency. An expression the SQL parser cannot read
 * is skipped by the rules that read references, with a message in `warnings`.
 * `opts` says what the caller checks itself, so that nothing is reported
 * twice.
 */
export function validateProfileCompleteness(
    baseModel: SemanticModel, profile: ProfileSpec, warnings: string[] = [],
    opts: CompletenessOptions = {}): string[] {
  const errors: string[] = [];
  // Each field or metric whose SQL the parser cannot read, reported once, by
  // the label fieldLabel or metricLabel gives it.
  const unreadable = new Set<string>();
  const at = `profile '${profile.name}'`;
  // What a profile file could not say, for a profile built in memory, and
  // every name the model does not take, as applyProfile judges them.
  errors.push(...profileProblems(baseModel, profile));
  const entities = baseModel.entities ?? [];
  const byName = new Map(entities.map(e => [e.name, e]));
  // Declared plus inherited fields, in the model file and as this profile sees
  // the model: the profile applied as push applies it, and each excluded field
  // left off the entity that names it. Push reports a broken hierarchy in the
  // model file. A profile breaks the hierarchy itself when it binds a field on
  // two unrelated branches. That is reported here once the model file's
  // hierarchy resolves. The rules below still run on a broken hierarchy, apart
  // from the check that each inherited field holds SQL, which push also skips
  // then. An entity whose own ancestors do not resolve shows only its declared
  // fields, so the rules that need what it inherits leave it out.
  const fieldsOf = fieldsByEntity(baseModel);
  // The entities whose own ancestors do not resolve in the model file, so
  // what they inherit is not known.
  const unknownAncestry = unresolvedEntities(baseModel);
  const {model: profiled, errors: unread} =
      applyBindings(
          baseModel, profile, {load: {sourceDialects: opts.sourceDialects}});
  errors.push(...unread.map(e => `${at}: ${e}`));
  const profiledError = inheritanceErrorOf(profiled);
  if (profiledError && !inheritanceErrorOf(baseModel)) {
    errors.push(`${at}: ${profiledError}`);
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
  const stated: Array<{entity: string; source: string; lookedUp?: string}> =
      [];
  const profiledByName =
      new Map((profiled.entities ?? []).map(e => [e.name, e]));
  // The entities whose source the loader's reader rejects.
  const rejected = new Set<string>();
  for (const e of entities) {
    if (e.abstract) continue;
    const pe = bindingOf.get(e.name);
    if (pe?.source === undefined) {
      errors.push(`${at}: entity '${e.name}' has no source in this profile`);
      continue;
    }
    // A source the loader's reader rejects is already reported, and its
    // entity keeps the model file's table and dialect. databaseOf still reads
    // some rejected sources, such as one with a leading `//`. An entity whose
    // source is rejected or names no database is left out of the one-database
    // and dialect rules.
    const db = databaseOf(pe.source.trim());
    const profiledEntity = profiledByName.get(e.name);
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


  // The expressions of each entity the profile may bind.
  for (const pe of profile.entities) {
    const e = byName.get(pe.name);
    if (!e || e.abstract) continue;
    const known = fieldsOf.get(pe.name)!;
    // A profile field's expression may be anything the model file's could be:
    // its own table's columns and its own entity's fields, never another
    // entity's fields, with each qualifier in its entity's case.
    // A name after a dot is a struct path segment, such as `customer` in
    // `details.customer.id`, and reads no entity.
    // These rules check every text the profile wrote, since each must be a
    // valid field expression wherever it runs; the dependency rules below read
    // only the text the profile's dialect evaluates. An ANSI_SQL text is read
    // as the profile's own SQL, and not at all when no lookup read its
    // dialect.
    const others = entities.map(x => x.name).filter(n => n !== pe.name);
    for (const pf of pe.fields ?? []) {
      // A text with no SQL is reported above, and has nothing to read.
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

  // The profile's own keys, where the model file states keys: those name
  // columns of the model file's table.
  for (const e of entities) {
    const pe = bindingOf.get(e.name);
    if (!pe || e.abstract) continue;
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

  // Every relationship bound, by the profile itself: a named profile states
  // both join column lists, and the model file's do not stand in for them.
  for (const r of baseModel.relationships ?? []) {
    if (r.association) continue;
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

  // Every field the model file leaves unbound is accounted for, and exclusions
  // are closed under dependency. An exclusion applies to the entity that names
  // it, not to that entity's descendants.
  const excluded = new Set<string>();
  // The entities whose own ancestors do not resolve with the profile applied.
  // A line on one that restates an inherited field is not judged unbound.
  const unknownProfiled = unresolvedEntities(profiled);
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
      if (!isFieldBound(f) && !rebound.has(f.name) &&
          !(unknownProfiled.has(e.name) &&
            inheritedNamesOf(profiled, e.name).has(f.name))) {
        errors.push(
            `${at}: field '${e.name}.${f.name}' has no binding in the model ` +
            `file; bind it in 'fields' or leave it out in 'fields_exclude'`);
      }
    }
  }
  // A profile restates or excludes each field whose binding reads a column,
  // since that column belongs to another table. seenOf leaves out excluded
  // fields.
  for (const e of entities) {
    const pe = bindingOf.get(e.name);
    if (!pe || e.abstract || unknownProfiled.has(e.name)) continue;
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
  // Each field or metric, as "field 'Entity.field'" or "metric 'name'", with
  // a text this check cannot read that push reads in another dialect: an
  // ANSI_SQL text, which push reads in its own dialect. Push reads every
  // other entry in the dialect it is written in, as this check does.
  const readOtherwise = new Set<string>();
  const noteUnread =
      (what: string, owner: Pick<Field, 'dialects'>,
       text: {text: string; dialect: string}) => {
        const asWritten = text.dialect !== 'ANSI_SQL' &&
            (owner.dialects ?? []).some(
                d => d.dialect === text.dialect && d.expression === text.text);
        // The caller warns about an ANSI_SQL text it cannot read either.
        const callerFails = !!opts.ownSqlOnly &&
            !columnsForSource(text.text, 'ANSI_SQL', opts.ownSqlOnly.dialect);
        if (!asWritten && !callerFails) readOtherwise.add(what);
      };
  // Every bound field, and every metric the profile keeps, has a text this
  // profile's database can run, checked once its sources name one database.
  if (dialect) {
    for (const e of entities) {
      if (e.abstract || rejected.has(e.name)) continue;
      for (const f of seenOf.get(e.name)?.values() ?? []) {
        // validateInlineDialects reports a field inherited unchanged.
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
                  importCommand('--transpile', baseModel)}',` :
              '';
          errors.push(
              `${at}: metric '${m.name}' has no expression for ${dialect} or ` +
              `ANSI_SQL, and this profile's sources are ${dialect}; give it ` +
              `one,${viaImport} or add it to 'metrics_exclude'`);
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
    const [entity, name] = field.split('.');
    // A field the entity's binding lists in 'fields' cannot be in
    // 'fields_exclude' too.
    const bound =
        bindingOf.get(entity)?.fields?.some(f => f.name === name) ?? false;
    errors.push(
        `${at}: field '${field}' depends on '${reached}', which this ` +
        `profile excludes; ${bound ? 'move' : 'add'} '${name}' ${
            bound ? "from 'fields' " : ''}to the 'fields_exclude' of entity ` +
        `'${entity}', or rebind it`);
  }
  const why = (target: string) => excluded.has(target) ?
      'which this profile excludes' :
      `which depends on '${dangling.get(target)}', an excluded field`;
  if (profile.metricsExclude !== '*') {
    const metricExcluded = new Set(profile.metricsExclude ?? []);
    // The profile's metrics, each with its entity as this profile's sources
    // infer it.
    for (const m of profiled.metrics ?? []) {
      if (metricExcluded.has(m.name)) continue;
      // An unqualified name that is a field of the metric's entity reads
      // that field.
      const ownFields = m.entity ? fieldsOf.get(m.entity) : undefined;
      const read: Array<ReadonlyArray<SqlColumn>> = [];
      for (const text of textsFor(m as Field, dialect)) {
        // A text with no SQL has nothing to read.
        if (noSqlReason(text.text, text.dialect) !== undefined) continue;
        const columns = columnReferences(text.text, text.dialect);
        if (columns) {
          read.push(columns.map(
              c => c.qualifier === undefined && ownFields?.has(c.name) ?
                  {...c, qualifier: m.entity} :
                  c));
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
  // The fields this profile binds, whose SQL the profile writes.
  const own = new Set(profile.entities.flatMap(
      pe => (pe.fields ?? []).map(pf => fieldLabel(pe.name, pf.name))));
  // Whether the caller warns itself about this model file SQL.
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

/**
 * Returns one message for each binding, the model file's included, whose
 * `to_columns` for a relationship cover no primary or unique key of its
 * target, or an empty list. A superset of a key covers it (see coversKey).
 * Keys and join columns are compared as written. A binding whose key or join
 * columns are not all column names (isColumnName) is left out. `applied` names
 * the profile the push applies. The "covers no key" check then leaves out that
 * profile's join, or the model file's when the profile states none.
 */
export function validateProfileConsistency(
    baseModel: SemanticModel, profiles: ProfileSpec[],
    applied?: string): string[] {
  const errors: string[] = [];
  const entities = baseModel.entities ?? [];
  const byName = new Map(entities.map(e => [e.name, e]));
  for (const r of baseModel.relationships ?? []) {
    if (r.association) continue;
    const target = byName.get(r.destination.entity);
    if (!target || target.abstract) continue;
    const appliedJoin = profiles.find(p => p.name === applied)
                            ?.relationships.find(x => x.name === r.name);
    // Push's own key check reports this binding's join, so it is left out here.
    const checkedByPush = applied === undefined ? undefined :
        appliedJoin?.toColumns.length ? `profile '${applied}'` :
                                        'the model file';
    // A binding that states no keys is checked against the model file's,
    // since completeness reports the missing keys. A binding with no join
    // columns is left out; completeness reports it for a named profile.
    const record =
        (who: string, to: string[], pk: string[], uks: string[][]) => {
          // The column name checks report a value that is not a column name.
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

// An error of a two-phase push's checks, and what it belongs to: the whole
// push when `document` is unset, the model in `document` when `profile` is
// unset, and that profile of the model otherwise. A deployment's errors belong
// to the profile it uses, which is 'default' when it names none.
export interface LocalCheckError {
  error: string;
  document?: string;
  profile?: string;
}

// The errors the named profiles of each model in `docs` give: each profile
// file, and each profile a vanilla model carries in its GOOGLE block, checked
// on its own for completeness. An error about a profile file names that file,
// and one about a block profile names its label or the model document.
// A model's profiles are checked against its model file as loaded on its own,
// which `baseByDoc` holds. A file under the reserved name 'default', which no
// push deploys, is not read here. Push also checks the
// keys and join columns of the model file and of each named profile. The
// warnings go to `warnings`. `profileDocs` gives a model's profile files, and
// `declared` the profiles a document declares, as push reads them.
export function namedProfileErrors(
    docs: Array<{name: string; text: string}>,
    baseByDoc: Map<string, SemanticModel>,
    profileDocs: ProfileFiles, declared: DeclaredProfiles,
    warnings: string[], load: DialectLoad): LocalCheckError[] {
  const errors: LocalCheckError[] = [];
  for (const d of docs) {
    // Each named profile, with the label its errors carry and a function that
    // reads it. declared() lists the profile files too, so only its block
    // profiles are taken from it. A block profile is already read. Its actions
    // are dropped, as loadProfileFile skips a profile file's.
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
      // A profile file that breaks one of the layout's file rules, or block
      // profiles a load rejects.
      errors.push({error: `${err.message || err}`, document: d.name});
      continue;
    }
    // A document that holds no model has nothing to check its profiles
    // against.
    const base = baseByDoc.get(d.name);
    if (!base) continue;
    // Actions are out of scope for the preview. Push checks a profile's
    // actions only when it applies the profile, so these checks leave them
    // out.
    const logical = {...base, actions: []};
    // Push warns about the SQL it cannot read in the model file, so these
    // checks leave out a warning about model file SQL that push reads in the
    // same dialect. Push stops reading what the SQL reads when the model's
    // hierarchy does not resolve, and these checks then give every warning.
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

// Each entity's fields, declared plus inherited, by name. Resolution throws on a
// broken hierarchy, which push reports elsewhere. Each entity is then resolved
// with only its own ancestors, and one whose own ancestors do not resolve
// keeps its declared fields.
function fieldsByEntity(model: SemanticModel): Map<string, Map<string, Field>> {
  let resolved: Entity[] = model.entities ?? [];
  if (resolved.some(e => e.extends?.length)) {
    try {
      resolved = resolveInheritance(model).model.entities ?? resolved;
    } catch (err) {
      // Anything but a broken hierarchy is a bug.
      if (!(err instanceof InheritanceError)) throw err;
      resolved = resolved.map(e => resolvedAlone(model, e.name) ?? e);
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

// The entity `name` resolved with only its ancestors, or undefined when its
// own ancestors do not resolve.
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

// The entities of `model` whose own ancestors do not resolve, so what they
// inherit is not known. Empty when the hierarchy resolves.
function unresolvedEntities(model: SemanticModel): Set<string> {
  if (!inheritanceErrorOf(model)) return new Set();
  return new Set((model.entities ?? [])
                     .filter(e => e.extends?.length &&
                                 !resolvedAlone(model, e.name))
                     .map(e => e.name));
}

// The message of the inheritance error resolving `model` throws, or undefined
// when it resolves.
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

// How a warning names a field, "field 'Entity.field'". The checks that skip a
// warning compare these labels, so each label comes from here.
function fieldLabel(entity: string, field: string): string {
  return `field '${entity}.${field}'`;
}

// How a warning names a metric, "metric 'name'".
function metricLabel(name: string): string {
  return `metric '${name}'`;
}

// The declaration of `field` whose binding `entityName` uses, and the entity
// that declares it: the entity's own when it binds the field, otherwise, of
// the ancestors that bind it, the one with the most ancestors. Undefined when
// none binds it.
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

// The first column `entityName`'s binding of `field` reads, as written, and
// the entity that declares it (see boundDeclaration), or undefined when that
// entity is abstract. A column is a reference no entity name qualifies, and an
// ANSI_SQL text is read in `dialect` if set, and not at all if it is null.
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

// The fields of its own entity that `field` reads on `entityName`, from the
// texts a profile of `dialect` evaluates (see textsFor) as written. The
// declaration read is the one boundDeclaration gives, read with its entity's
// qualifier.
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
    // A text with no SQL has nothing to read.
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

// Whether a primary key and unique keys state a key. An empty unique key
// counts as none.
export function statesKey(
    primaryKey: string[]|undefined, uniqueKeys: string[][]|undefined): boolean {
  return !!primaryKey?.length || nonEmptyKeys(uniqueKeys).length > 0;
}

// The unique keys in `keys` that hold a column. An empty unique key counts as
// none.
function nonEmptyKeys(keys: string[][]|undefined): string[][] {
  return (keys ?? []).filter(k => k.length > 0);
}

