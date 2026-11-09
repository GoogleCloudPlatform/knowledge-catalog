// Knowledge Catalog <-> Semantic Model IR converter.
//
// SCAFFOLD (naming for the end state): this file currently holds only the
// READ direction -- Knowledge Catalog entries -> IR
// (`modelsFromCatalogResources` and its helpers). The WRITE direction (IR -> KC
// entries, `generateCatalogResources`) still lives in `knowledge_catalog.ts`
// and moves here once PR4 (the KC push line) merges, at which point this
// becomes the full two-way converter and `knowledge_catalog.ts` goes away.
// Until then, "where is the KC emit code?" -> `knowledge_catalog.ts`.
//
// TODO(#278): fold the KC WRITE direction in and drop the scaffold. Once
// #278 merges, move `generateCatalogResources` (and the `KcResources` type
// + emit helpers) out of `knowledge_catalog.ts` into this file, delete
// `knowledge_catalog.ts`, and repoint its importers
// (`deploy_knowledge_catalog.ts` and the emitter tests). Then this is the sole
// KC<->IR codec and the SCAFFOLD note above comes out.
//
// The reader is the inverse of `generateCatalogResources` with the
// second-generation types: it rebuilds the IR from the entries a pull
// hydrated (see `pull_kc.pullKnowledgeCatalog`). `semantic-entity`,
// `semantic-metric` and `semantic-relationship` entries, and action and
// constraint entries, are grouped under their `semantic-model` anchor via
// `parentEntry`; entries of other types are ignored. Resources are matched by
// type-name SUFFIX, so a reader need not know which system-type
// project/location the emitter used.
//
// Every value push stores comes back (see readModelV2), each relationship is
// read from its own entry, and no entry link is read. A model an older kcmd
// pushed with the first-generation types is not rebuilt.

import type {Aspect, Entry} from '../gcp/dataplex';
import type {OverviewSidecar} from '../layouts/semantic-model';

import {Action, AiContext, Constraint, DATA_TYPES, DataType, Entity, Field, FIELD_BINDING_KEYS, Metric, ProfileSpec, Relationship, SemanticModel} from './ir';
import {isActionEntry, readAction} from './kc_actions';
import {isConstraintEntry, readConstraint} from './kc_constraints';
import {entryIdOf} from './kc_ids';
import {DEFAULT_DIALECT, readFieldExpression, sourceToDataSource} from './loader';
import {compact, nonEmpty} from './osi_converter';

export interface ReadResult {
  models: SemanticModel[];
  warnings: string[];
  // The overview sidecar of each entry of `models` whose overview holds
  // content, contentType or links, by entry id. Absent when `models` is
  // empty.
  overviews?: Map<string, OverviewSidecar>;
  // Each model an older kcmd pushed with the first-generation types, which
  // is left out of `models`.
  firstGeneration?: FirstGenerationModel[];
}

// A model the read leaves out: its name, and its model entry followed by the
// entries under it.
export interface FirstGenerationModel {
  name: string;
  entries: Entry[];
}

// A guard naming a constraint this pull did not recover -- because its entry was
// absent, or was skipped as unreadable. readAction keeps the name so the
// author's model is not silently rewritten, which leaves the document one that
// push will reject. Reporting it here puts the message on the command that
// produced the document rather than on the next one.
function warnDanglingGuards(
    actions: Action[], constraints: Constraint[], modelName: string,
    warnings: string[]): void {
  if (!actions.length) return;
  const recovered = new Set(constraints.map(c => c.name));
  for (const action of actions) {
    for (const guard of action.guards ?? []) {
      if (recovered.has(guard)) continue;
      warnings.push(
          `model '${modelName}': action '${action.name}' is guarded by ` +
          `'${guard}', but no constraint of that name was recovered; the ` +
          `name is kept, and a push rejects it until the constraint is back`);
    }
  }
}

/**
 * Reconstructs the Semantic Model IR from Knowledge Catalog entries.
 *
 * Returns one model per `semantic-model` anchor whose aspect has
 * `specVersion`, rebuilt from the second-generation types (see readModelV2),
 * plus any warnings (no anchor, an orphaned child, an unreadable action or
 * constraint). A model without `specVersion` was pushed by an older kcmd with
 * the first-generation types; it is returned in `firstGeneration` instead of
 * being rebuilt. Entries must already be hydrated with their aspect data; a
 * BASIC list omits aspect data, so the puller re-fetches each entry first.
 */
export function modelsFromCatalogResources(entries: Entry[]): ReadResult {
  const warnings: string[] = [];

  const anchors = entries.filter(e => semanticType(e) === 'semantic-model');
  const entityEntries =
      entries.filter(e => semanticType(e) === 'semantic-entity');
  const metricEntries =
      entries.filter(e => semanticType(e) === 'semantic-metric');
  const relationshipEntries =
      entries.filter(e => semanticType(e) === 'semantic-relationship');
  // Actions have no built-in system type; `kc_actions.ts` owns the custom one
  // and recognizes an entry carrying it. Constraints are the same, through
  // `kc_constraints.ts`.
  const actionEntries = entries.filter(isActionEntry);
  const constraintEntries = entries.filter(isConstraintEntry);

  if (!anchors.length) {
    warnings.push('no semantic-model entry found; nothing to reconstruct');
    return {models: [], warnings: [...new Set(warnings)]};
  }

  // A child belongs to its anchor by parentEntry. When there is exactly one
  // anchor, children whose parentEntry does not resolve (e.g. a project-id
  // normalization mismatch) are still attached to it rather than dropped.
  const anchorNames = new Set(anchors.map(a => a.name));
  const soleAnchor = anchors.length === 1 ? anchors[0].name : undefined;
  const childrenOf = (anchorName: string, pool: Entry[]) => pool.filter(
      e => e.parentEntry === anchorName ||
          (soleAnchor === anchorName && !anchorNames.has(e.parentEntry ?? '')));

  const overviews = new Map<string, OverviewSidecar>();
  const nameOf = (anchor: Entry) =>
      anchor.entrySource?.displayName ?? idOf(anchor.name);
  // A model whose model entry has no specVersion was pushed with the
  // first-generation types. It is left out rather than rebuilt from them.
  const isFirstGeneration = (anchor: Entry) =>
      aspectData(anchor, 'semantic-model').specVersion === undefined;
  const firstGeneration = anchors.filter(isFirstGeneration).map(anchor => ({
    name: nameOf(anchor),
    entries: [
      anchor,
      ...[entityEntries, metricEntries, actionEntries, constraintEntries]
          .flatMap(pool => childrenOf(anchor.name, pool)),
    ],
  }));
  const models = anchors.filter(a => !isFirstGeneration(a)).map(anchor => {
    const children = (pool: Entry[]) => childrenOf(anchor.name, pool);
    const [entities, metrics, relationships] =
        [entityEntries, metricEntries, relationshipEntries].map(children);
    overviewSidecars([anchor, ...entities, ...metrics, ...relationships])
        .forEach((sidecar, id) => overviews.set(id, sidecar));
    const model =
        readModelV2(anchor, nameOf(anchor), entities, metrics, relationships);
    readActionsAndConstraints(
        model, sortedByName(children(actionEntries)),
        sortedByName(children(constraintEntries)), warnings);
    return model;
  });

  // Flag children that resolved to no anchor at all (only possible with
  // multiple anchors, where the sole-anchor fallback does not apply).
  if (!soleAnchor) {
    for (const child of [...entityEntries, ...metricEntries, ...actionEntries,
                         ...constraintEntries]) {
      if (!child.parentEntry || !anchorNames.has(child.parentEntry)) {
        warnings.push(`entry '${
            child.name}' has no resolvable parent semantic-model; omitted`);
      }
    }
  }

  return {
    models,
    warnings: [...new Set(warnings)],
    ...(models.length ? {overviews} : {}),
    ...(firstGeneration.length ? {firstGeneration} : {}),
  };
}


// Reads a model's action and constraint entries onto `model`.
function readActionsAndConstraints(
    model: SemanticModel, actionEntries: Entry[], constraintEntries: Entry[],
    warnings: string[]): void {
  const actions = actionEntries.map(e => readAction(e, warnings))
                      .filter((a): a is Action => a !== undefined);
  if (actions.length) model.actions = actions;
  const constraints = constraintEntries.map(e => readConstraint(e, warnings))
                          .filter((c): c is Constraint => c !== undefined);
  if (constraints.length) model.constraints = constraints;
  warnDanglingGuards(actions, constraints, model.name, warnings);
}


// Rebuilds a model from the second-generation types: its model entry and the
// entity, metric and relationship entries under it, each kind sorted by name.
function readModelV2(
    anchor: Entry, name: string, entityEntries: Entry[], metricEntries: Entry[],
    relationshipEntries: Entry[]): SemanticModel {
  const data = aspectData(anchor, 'semantic-model');
  // The named profiles in stored order, which the readers below fill in.
  const profiles = new Map<string, ProfileSpec>(
      stringList(asArray(data.profiles).map(p => p?.name))
          .map(p => [p, {name: p, entities: [], relationships: []}]));
  const entities =
      sortedByName(entityEntries).map(e => readEntityV2(e, profiles));
  const relationships = sortedByName(relationshipEntries)
                            .map(e => readRelationshipV2(e, profiles));
  const sortedMetrics = sortedByName(metricEntries);
  const metrics = sortedMetrics.map(readMetricV2);

  // Each profile excludes '*' when it excludes every metric, and otherwise the
  // metrics it excludes, in name order.
  const excludedIn = sortedMetrics.map(
      e => stringList(aspectData(e, 'semantic-metric').excludedInProfiles));
  for (const profile of profiles.values()) {
    const excluded =
        metrics.filter((_, i) => excludedIn[i].includes(profile.name))
            .map(m => m.name);
    if (excluded.length) {
      profile.metricsExclude =
          excluded.length === metrics.length ? '*' : excluded;
    }
  }

  return compact({
    name,
    version: data.specVersion,
    entities,
    relationships,
    metrics,
    ...objectPropertiesV2(
        anchor, '', data.synonyms, anchor.entrySource?.description),
    profiles: nonEmpty([...profiles.values()]),
    deployments: nonEmpty(asArray(data.deployments).map(
        d => compact({name: d?.name, target: d?.target, profile: d?.profile}))),
  });
}


// Rebuilds an entity with every field its schema lists, and each field it
// only rebinds, and adds each named profile's binding of it to `profiles`.
function readEntityV2(
    entry: Entry, profiles: Map<string, ProfileSpec>): Entity {
  const name = idOf(entry.name);
  const data = aspectData(entry, 'semantic-entity');
  const records =
      asArray(aspectData(entry, 'sql-expressions').fieldExpressions);
  for (const p of asArray(data.profiles)) {
    const bound = records.filter(r => r?.qualifier === p?.name);
    profiles.get(p?.name)?.entities.push(compact({
      name,
      source: p.source?.resource,
      primaryKey: nonEmpty(stringList(p.primaryKey?.fields)),
      uniqueKeys: nonEmpty(uniqueKeysOf(p)),
      fields: nonEmpty([...new Set(bound.map(r => r.name))].map(
          f => ({
            name: f,
            ...expressionOf(
                bound.filter(r => r.name === f),
                `profile '${p.name}': entity '${name}': field '${f}'`),
          }))),
      fieldsExclude: nonEmpty(stringList(p.excludedFields)),
    }));
  }
  const inline = records.filter(r => !r?.qualifier);
  const source = data.source?.resource;
  return compact({
    name,
    dataSource: typeof source === 'string' ? sourceToDataSource(source) : '',
    authoredSource: source,
    keys: stringList(data.primaryKey?.fields),
    uniqueKeys: nonEmpty(uniqueKeysOf(data)),
    extends: nonEmpty(stringList(data.extends)),
    abstract: data.abstract === true || undefined,
    fields: withRebindings(
        asArray(aspectData(entry, 'schema').fields)
            .filter(fd => typeof fd?.name === 'string')
            .map(fd => readFieldV2(entry, name, fd, inline)),
        inline, name),
    ...objectPropertiesV2(
        entry, '', data.synonyms, entry.entrySource?.description),
  });
}


// `fields` plus a field for each name `records` hold that `fields` lack: an
// inherited field the entity only rebinds. Each keeps the place its records
// give it.
function withRebindings(
    fields: Field[], records: any[], entity: string): Field[] {
  const position = (name: string) => records.findIndex(r => r?.name === name);
  const out = [...fields];
  for (const name of new Set(records.map(r => r?.name))) {
    if (fields.some(f => f.name === name)) continue;
    const at = out.findIndex(f => position(f.name) > position(name));
    out.splice(at < 0 ? out.length : at, 0, {
      name,
      ...expressionOf(
          records.filter(r => r?.name === name), `field '${entity}.${name}'`),
    });
  }
  return out;
}


// Rebuilds a field from its schema record `fd`, the entity's sql-expressions
// `records` that name no profile, and its aspects at its path.
function readFieldV2(
    entry: Entry, entity: string, fd: any, records: any[]): Field {
  const isTime = fd.annotations?.is_time;
  return compact({
    name: fd.name,
    ...expressionOf(
        records.filter(r => r?.name === fd.name),
        `field '${entity}.${fd.name}'`),
    type: dataTypeOf(fd.dataType),
    dimension: fd.semantic === 'DIMENSION' || isTime !== undefined ?
        compact(
            {isTime: isTime === undefined ? undefined : isTime === 'true'}) :
        undefined,
    label: fd.annotations?.label || undefined,
    ...objectPropertiesV2(
        entry, `Schema.${fd.name}`, fd.synonyms, fd.description),
  });
}


// Rebuilds a metric. Its entity is the one push stored, declared or derived,
// and pull writes it back as declared.
function readMetricV2(entry: Entry): Metric {
  const name = idOf(entry.name);
  const data = aspectData(entry, 'semantic-metric');
  const entity = typeof data.entity === 'string' ? data.entity : undefined;
  return compact({
    name,
    ...expressionOf(
        asArray(aspectData(entry, 'sql-expressions').expressions),
        `metric '${name}'`),
    type: dataTypeOf(data.dataType),
    entity,
    authoredEntity: entity,
    ...objectPropertiesV2(
        entry, '', data.synonyms, entry.entrySource?.description),
  });
}


// Rebuilds a relationship, and adds each named profile's join columns to
// `profiles`. A name holds no '/', so the last segment of the entry id, after
// `<model>/relationships/`, is the name as written.
function readRelationshipV2(
    entry: Entry, profiles: Map<string, ProfileSpec>): Relationship {
  const name = idOf(entry.name);
  const data = aspectData(entry, 'semantic-relationship');
  for (const p of asArray(data.profiles)) {
    profiles.get(p?.name)?.relationships.push({
      name,
      fromColumns: stringList(p.sourceFields),
      toColumns: stringList(p.targetFields),
    });
  }
  return compact({
    name,
    source:
        {entity: data.source?.name, columns: stringList(data.source?.fields)},
    destination:
        {entity: data.target?.name, columns: stringList(data.target?.fields)},
    ...objectPropertiesV2(
        entry, '', data.synonyms, entry.entrySource?.description),
  });
}


// An object's `description`, ai_context and extension blocks, read from its
// aspects on `entry` at `path`, which is `Schema.<field>` for a field and
// empty otherwise. `synonyms` come from the object's own aspect. A part with
// nothing in it is undefined, and custom members are sorted by name.
function objectPropertiesV2(
    entry: Entry, path: string, synonyms: unknown,
    description: string|
    undefined): Pick<Entity, 'description'|'aiContext'|'customExtensions'> {
  const guidelines = aspectDataOf(entry.aspects, 'guidelines', path);
  // Knowledge Catalog's own guidelines are not part of the model.
  const authored = guidelines.userManaged !== false ? guidelines : {};
  const members = Object.keys(authored.data ?? {}).sort();
  const ai: AiContext = compact({
    instructions: authored.instructions || undefined,
    synonyms: nonEmpty(stringList(synonyms)),
    examples: nonEmpty(stringList(
        asArray(aspectDataOf(entry.aspects, 'overview', path).examples)
            .map(x => x?.content))),
    additionalProperties: members.length ?
        Object.fromEntries(members.map(m => [m, authored.data[m]])) :
        undefined,
  });
  return {
    description,
    aiContext: Object.keys(ai).length ? ai : undefined,
    customExtensions: nonEmpty(
        asArray(aspectDataOf(entry.aspects, 'semantic-extensions', path)
                    .customExtensions)
            .map(x => ({vendorName: x?.vendorName, data: x?.data}))),
  };
}


// The expression `records` hold, read as the loader reads the form they
// keep: a record with no dialect is the string form, and records with one are
// a dialect list, in stored order. Empty when there is no record.
function expressionOf(records: any[], where: string):
    Partial<Pick<Field, (typeof FIELD_BINDING_KEYS)[number]>> {
  if (!records.length) return {};
  const short = records.find(r => !r.dialect);
  const doc = short ? short.sql : {
    dialects: records.map(r => ({dialect: r.dialect, expression: r.sql})),
  };
  return readFieldExpression(doc, where, DEFAULT_DIALECT, () => undefined);
}


// The overview sidecar each of `entries` holds in its overview, by entry id:
// its content, contentType and links. An entry with none of the three has
// none.
function overviewSidecars(entries: Entry[]): Map<string, OverviewSidecar> {
  const out = new Map<string, OverviewSidecar>();
  for (const entry of entries) {
    const {content, contentType, links} = aspectData(entry, 'overview');
    const sidecar = compact({
      content: content || undefined,
      contentType,
      links: nonEmpty(asArray(links)),
    });
    if (Object.keys(sidecar).length) out.set(entryIdOf(entry.name), sidecar);
  }
  return out;
}


// The unique keys of a semantic-entity aspect or one of its profile records.
function uniqueKeysOf(data: any): string[][] {
  return asArray(data?.uniqueConstraints)
      .map(u => stringList(u?.fields))
      .filter(k => k.length);
}


// The IR datatype a second-generation `dataType` names. Opaque, stored for an
// object with no datatype, reads as none.
function dataTypeOf(dataType: unknown): DataType|undefined {
  return dataType !== 'Opaque' &&
          (DATA_TYPES as readonly unknown[]).includes(dataType) ?
      dataType as DataType :
      undefined;
}


// `entries` sorted by the last segment of their entry ids. One model's entries
// of one kind differ only in the name of the object each holds, so this is
// name order.
function sortedByName(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    const [x, y] = [idOf(a.name), idOf(b.name)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}


// The bare `semantic-*` type of an entry, matched by entryType suffix so the
// system-type project/location need not be known. Returns undefined for entries
// that are not part of a semantic model.
function semanticType(entry: Entry): 'semantic-model'|'semantic-entity'|
    'semantic-metric'|'semantic-relationship'|undefined {
  for (const t
           of ['semantic-model', 'semantic-entity', 'semantic-metric',
               'semantic-relationship'] as const) {
    if (entry.entryType?.endsWith(`/entryTypes/${t}`)) return t;
  }
  return undefined;
}


// The `data` payload of an entry's aspect of the given bare type, at the
// entry itself. See aspectDataOf.
function aspectData(entry: Entry, type: string): Record<string, any> {
  return aspectDataOf(entry.aspects, type);
}


// The `data` payload of an aspect of the given bare type from an aspect map,
// matched by the aspect key's `.<type>` suffix or the aspectType's
// `/aspectTypes/<type>` suffix (robust to whichever system-type
// project/location the emitter used). Only the aspect at `path` matches, which
// is the entry itself when `path` is empty and a field for `Schema.<field>`.
// Returns an empty object when the aspect is absent.
function aspectDataOf(
    aspects: Record<string, Aspect>|undefined, type: string,
    path = ''): Record<string, any> {
  for (const [key, aspect] of Object.entries(aspects ?? {})) {
    const [ref, keyPath = ''] = key.split('@');
    if ((aspect.path || keyPath) !== path) continue;
    if (ref.endsWith(`.${type}`) ||
        aspect.aspectType?.endsWith(`/aspectTypes/${type}`)) {
      return aspect.data ?? {};
    }
  }
  return {};
}


// The id segment of a full entry resource name (after the last '/').
function idOf(name: string): string {
  return name.split('/').pop() ?? name;
}


function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}


// The non-empty strings of an array value, dropping non-string and empty
// entries.
function stringList(value: any): string[] {
  return asArray(value).filter(
      (s): s is string => typeof s === 'string' && s !== '');
}
