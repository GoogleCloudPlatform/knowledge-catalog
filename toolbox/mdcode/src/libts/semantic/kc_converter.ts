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
// (`deploy_knowledge_catalog.ts` and the emitter tests). `idOf` -- shared by
// both directions and re-exported from here only for `pull_kc` today -- becomes
// a plain local. Then this is the sole KC<->IR codec and the SCAFFOLD note
// above comes out.
//
// The reader is the inverse of `generateCatalogResources`: it reconstructs the
// IR from the entries a pull hydrated (see `pull_kc.pullKnowledgeCatalog`).
// `semantic-entity` / `semantic-metric` entries are grouped under their
// `semantic-model` anchor via `parentEntry`; entries of other types are
// ignored. Resources are matched by type-name SUFFIX, so a reader need not know
// which system-type project/location the emitter used.
//
// Fidelity is bounded by what the emitter persisted, so this read is the
// inverse of the WRITE, not of the authored document. It recovers names,
// descriptions, data sources, field datatypes and labels (via the schema
// aspect), entity keys and unique keys (the schema aspect's primaryKey /
// uniqueConstraints), each object's `ai_context.instructions` (from its
// `guidelines` aspect, on the model/entity/metric), each metric's attach entity
// (re-derived from its expression, as the loader does, when the catalog holds
// one, else the value the emitter persisted), the model's deployment targets
// (from the semantic-model aspect, back into `deployments` and the GOOGLE
// `custom_extensions` block), and 1:1 / 1:N relationships (from the
// `schema-join` entry links a pull fetched -- see
// `modelsFromCatalogResources`'s `entryLinks` argument).
// Entity `extends` and `abstract` come back from the `Specializes:` / `Abstract:`
// paragraphs publish appends to an entity entry's description (see
// `splitEntityTrailers`). Field `unit` / `scale` and entity `grain` /
// `history` (K7) come back the same way, from `Unit:` / `Scale:` and
// `Grain:` / `History:` paragraphs (see units_history.ts).
// The per-field `semantics` block -- field/metric expressions and the DIMENSION
// role
// -- is gated off the catalog by default: the emitter writes it only under
// `--emit-expressions` (see `KcGenerateOptions.emitExpressions`), so those
// three recover only when the push that wrote them enabled it, and a default
// push -> pull drops them. It cannot recover what the emitter never writes:
// `ai_context.synonyms`/`examples` and field-level `ai_context` (only
// model/entity/metric `instructions` are persisted, via `guidelines`),
// `importedExpression`/`importedDialect` (the vendor-dialect SQL), and
// many-to-many (association) relationships (whose edge lives only in the
// BigQuery property graph). A `String`- or `Opaque`-typed METRIC also reads
// back un-typed: the metric aspect persists only `dataType` (both collapse to
// `STRING`, with no metadataType to disambiguate), so -- as with a plain STRING
// field -- the reader leaves it un-typed rather than guess. Relationship NAMES
// come back lowercased, since the emitter encodes the name only in the link id
// (via `linkSlug`), not in the join aspect.
//
// K1 (lossless push/pull): when the push attached kcmd's annotation aspects
// (`semantic-ai-context`, `semantic-expressions`, `semantic-binding`; see
// kc_annotations.ts), they are authoritative for what they cover and lift
// every limit above: the whole ai_context (synonyms, examples, field-level),
// expressions, imported SQL, dimension roles and logical types, binding mode,
// hydration and full vocabulary members, relationship names verbatim (from
// the anchor's index) in authored order, many-to-many relationships
// (folded back from their junction entry and its two links), and the
// relationships that publish no link at all -- abstract ones, and those with
// an abstract or column-less endpoint -- which the index carries whole.
// Without them (a project that has not re-run `kcmd init`) the read is as
// described above.

import type {Aspect, Entry, EntryLink} from '../gcp/dataplex';

import {Action, AiContext, Association, Constraint, CustomExtension, DataType, DeploymentSpec, Entity, Field, Metric, Relationship, SemanticModel} from './ir';
import {isActionEntry, readAction} from './kc_actions';
import {applyFieldExpressions, readAiContextAnnotation, readBindingAnnotation, readExpressionsAnnotation, RelationshipIndexRow} from './kc_annotations';
import {isConstraintEntry, readConstraint} from './kc_constraints';
import {linkSlug} from './kc_ids';
import {ABSTRACT_MARKER, DEFINED_AS_PREFIX, DEFINITION_NOTE_PREFIX, INVERSE_PREFIX, SPECIALIZES_PREFIX} from './knowledge_catalog';
import {splitGrainHistoryTrailers, splitUnitTrailer} from './units_history';
import {splitDerivedTrailers} from './derived_relationships';
import {splitMembersTrailer} from './vocabulary';
import {splitConstraintsTrailer} from './constraint_enforcement';
import {splitHydrationTrailer} from './hydration_kc';
import {splitContentsTrailer, splitQueryTrailer, splitReadThroughTrailer, splitRelationshipsTrailer} from './read_trailers';
import {unnamedDeployments} from './deployment_target';
import {noSqlReason, sourceToDataSource} from './loader';
import {columnReferences, entitiesReached} from './sql_expr_utils';

export interface ReadResult {
  models: SemanticModel[];
  warnings: string[];
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
 * Returns one model per `semantic-model` anchor plus any warnings (no anchor,
 * an orphaned child, an entry missing its aspect data). Entries must already be
 * hydrated with their `semantic-*` (and, for entities, `schema`) aspect data; a
 * BASIC list omits aspect data, so the puller re-fetches each entry first.
 *
 * `entryLinks` are the `schema-join` links a pull fetched for the group (see
 * `pull_kc`); each link between two of a model's entity entries is
 * reconstructed as a 1:1 / 1:N relationship. Pass `[]` (the default) to
 * reconstruct entities and metrics only.
 */
export function modelsFromCatalogResources(
    entries: Entry[], entryLinks: EntryLink[] = []): ReadResult {
  const warnings: string[] = [];

  const anchors = entries.filter(e => semanticType(e) === 'semantic-model');
  const entityEntries =
      entries.filter(e => semanticType(e) === 'semantic-entity');
  const metricEntries =
      entries.filter(e => semanticType(e) === 'semantic-metric');
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

  const models = anchors.map(anchor => {
    const name = anchor.entrySource?.displayName ?? idOf(anchor.name);

    // A many-to-many relationship's junction is published as a semantic-entity
    // entry too; it is part of a relationship, not an entity of the model.
    const childEntityEntries = childrenOf(anchor.name, entityEntries);
    const junctionEntries = childEntityEntries.filter(isJunctionEntry);
    const entityEntriesForModel =
        childEntityEntries.filter(e => !isJunctionEntry(e));
    const entities = entityEntriesForModel.map(e => readEntity(e, warnings));
    const entityNames = entities.map(e => e.name);
    // Entity inheritance round-trip. A restored `extends` naming an entity this
    // pull did not recover (its entry was skipped, or deleted from the
    // catalog) would dangle -- a load error -- so keep only parents that
    // resolve and drop the rest with a warning naming the gap.
    const pulledEntities = new Set(entityNames);
    for (const entity of entities) {
      if (!entity.extends) continue;
      const kept = entity.extends.filter(p => pulledEntities.has(p));
      for (const p of entity.extends.filter(p => !pulledEntities.has(p))) {
        warnings.push(
            `entity '${entity.name}' specializes '${p}', which this pull did ` +
            `not recover; 'extends: [${p}]' is dropped`);
      }
      if (kept.length) {
        entity.extends = kept;
      } else {
        delete entity.extends;
      }
    }
    const metrics = childrenOf(anchor.name, metricEntries)
                        .map(e => readMetric(e, entityNames, warnings));

    // Index this model's entities by their entry id, so a schema-join link can
    // resolve its endpoints from the link's entryReferences. The id segment is
    // stable across the project-number/id normalization that lookupEntry
    // applies to entries but lookupEntryLinks does not apply to link
    // references, so matching on it (not the full resource name) keeps
    // live-fetched links resolvable.
    const entityByEntryId = new Map<string, Entity>();
    entityEntriesForModel.forEach(
        (e, i) => entityByEntryId.set(idOf(e.name), entities[i]));
    const junctionByEntryId =
        new Map(junctionEntries.map(e => [idOf(e.name), e] as const));

    // Relationships come from the schema-join entry links whose two endpoints
    // are both this model's entity entries, plus each junction's pair of
    // links (a many-to-many relationship). The anchor's ai-context aspect,
    // when present, indexes them by link id with their authored names.
    const anchorAi = readAiContextAnnotation(anchor);
    const relationships = readRelationships(
        entryLinks, name, entityByEntryId, warnings, junctionByEntryId,
        anchorAi?.relationships ?? []);

    const model: SemanticModel = {name, entities, relationships, metrics};
    // The contents paragraph is derived (push lists the model's metrics and
    // entities on the anchor), so it is dropped here.
    const description = splitContentsTrailer(anchor.entrySource?.description).rest;
    if (description !== undefined) model.description = description;
    const actions = childrenOf(anchor.name, actionEntries)
                        .map(e => readAction(e, warnings))
                        .filter((a): a is Action => a !== undefined);
    if (actions.length) model.actions = actions;
    const constraints = childrenOf(anchor.name, constraintEntries)
                            .map(e => readConstraint(e, warnings))
                            .filter((c): c is Constraint => c !== undefined);
    if (constraints.length) model.constraints = constraints;
    warnDanglingGuards(actions, constraints, name, warnings);
    // Deployment targets ride back in both the GOOGLE custom_extensions block
    // and as synthesized `deployments` entries (`default` when one,
    // `deployment_1`, `deployment_2`, ... when several).
    const targets = readDeploymentTargets(anchor, name, warnings);
    if (targets) {
      model.customExtensions = [targets.extension];
      model.deployments = targets.deployments;
    }
    const ai = anchorAi ? anchorAi.aiContext : readAiContext(anchor);
    if (ai) model.aiContext = ai;
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

  return {models, warnings: [...new Set(warnings)]};
}


// Reconstructs an entity from its `semantic-entity` aspect (the backing
// source), the built-in `schema` aspect (its fields, primary key, and unique
// constraints), and the built-in `guidelines` aspect (ai_context instructions).
function readEntity(entry: Entry, warnings: string[]): Entity {
  const name = entry.entrySource?.displayName ?? idOf(entry.name);
  const semantic = aspectData(entry, 'semantic-entity');
  const schema = aspectData(entry, 'schema');
  if (!Object.keys(semantic).length) {
    warnings.push(`entity '${
        name}': no semantic-entity aspect data (fetch with the aspect type)`);
  }

  // Publish appends the Specializes paragraph then the Abstract marker (or the
  // definition trailers), then the K7 Grain / History paragraphs, then the K3
  // Members paragraph, then the derived Read through, Relationships and
  // Constraints paragraphs, then the Hydration paragraph, to the entity
  // description (knowledge_catalog.entityDescription); peel them off in
  // reverse. Read through, Relationships and Constraints are recomputed by
  // every push, so they are dropped.
  const hyd = splitHydrationTrailer(entry.entrySource?.description);
  const k3 = splitMembersTrailer(splitReadThroughTrailer(
      splitRelationshipsTrailer(splitConstraintsTrailer(hyd.rest).rest).rest)
                                     .rest);
  const k7 = splitGrainHistoryTrailers(k3.rest);
  const defined = splitDefinitionTrailer(k7.rest);
  const trailers = splitEntityTrailers(defined.rest);
  // A source written as a catalog name is stored in `importedResource`, with
  // `resources` left empty.
  const imported = semantic?.source?.importedResource;
  const rawResource = (semantic?.source?.resources?.[0] ?? '').trim() ||
      (typeof imported === 'string' ? imported.trim() : '');
  const dataSource = dataSourceFromResource(rawResource);
  // An abstract entity has no table by design, so an empty source is expected;
  // so does a defined one (a subset of its parent's rows), a vocabulary (its
  // rows are its members), and a derived one (its rows come from a
  // relationship). With the annotation aspects the read is lossless, so an
  // empty source is what was authored (a logical model not yet bound).
  const annotated = !!(readAiContextAnnotation(entry) ||
                       readExpressionsAnnotation(entry) ||
                       readBindingAnnotation(entry));
  if (!dataSource && !trailers.abstract && !defined.definition && !k3.members &&
      !hyd.hydration?.deriveFrom && !annotated) {
    warnings.push(
        `entity '${name}': no backing data source in the semantic-entity ` +
        `aspect; 'source' will be empty and the entity may not load`);
  }
  const entity: Entity = {
    name,
    dataSource,
    ...(rawResource ? {authoredSource: rawResource} : {}),
    // The grain / primary key, from the schema aspect's primaryKey.fields
    // (ordered, so a composite key's ordinal positions round-trip).
    keys: stringList(schema.primaryKey?.fields),
    fields: asArray(schema.fields)
                .map(fd => readField(fd, name, warnings))
                .filter((f): f is Field => f !== undefined),
  };
  // Additional unique column sets, from the schema aspect's uniqueConstraints
  // (each constraint's `fields` is one set); dropped when empty.
  const uniqueKeys = asArray(schema.uniqueConstraints)
                         .map(uc => stringList(uc?.fields))
                         .filter(fields => fields.length);
  if (uniqueKeys.length) entity.uniqueKeys = uniqueKeys;
  if (trailers.description !== undefined) {
    entity.description = trailers.description;
  }
  if (trailers.parents.length) entity.extends = trailers.parents;
  if (trailers.abstract) entity.abstract = true;
  if (defined.definition) entity.definition = defined.definition;
  if (k7.grain !== undefined) entity.grain = k7.grain;
  if (k7.history !== undefined) entity.history = k7.history;
  if (k3.members !== undefined) entity.members = k3.members;
  if (hyd.hydration !== undefined) entity.hydration = hyd.hydration;
  if (hyd.mode !== undefined) entity.mode = hyd.mode;
  const aiAnn = readAiContextAnnotation(entry);
  const ai = aiAnn ? aiAnn.aiContext : readAiContext(entry);
  if (ai) entity.aiContext = ai;
  applyEntityAnnotations(entity, entry);
  return entity;
}

// K1: an entity entry's annotation aspects, when present, are authoritative
// for what they cover (see kc_annotations.ts): field ai_context; field
// expressions, imported SQL, dimension role and logical type; and the binding
// mode, hydration rules and full vocabulary members (the trailers carry only
// codes and labels).
function applyEntityAnnotations(entity: Entity, entry: Entry): void {
  const aiAnn = readAiContextAnnotation(entry);
  if (aiAnn) {
    for (const field of entity.fields) {
      const fieldAi = aiAnn.fields.get(field.name);
      if (fieldAi) {
        field.aiContext = fieldAi;
      } else {
        delete field.aiContext;
      }
    }
  }
  const exprAnn = readExpressionsAnnotation(entry);
  if (exprAnn) applyFieldExpressions(entity.fields, exprAnn);
  const binding = readBindingAnnotation(entry);
  if (binding && !binding.association) {
    for (const key of ['mode', 'hydration', 'members'] as const) {
      if (binding[key] !== undefined) {
        (entity as any)[key] = binding[key];
      } else {
        delete entity[key];
      }
    }
  }
}

// A junction entry: the table behind a many-to-many relationship, published
// as a semantic-entity under the `<model>.associations.` prefix and tagged by
// its binding aspect's `association`.
function isJunctionEntry(entry: Entry): boolean {
  return idOf(entry.name).includes('.associations.') ||
      !!readBindingAnnotation(entry)?.association;
}

// Peels a defined entity's trailers -- an optional `Definition note: …`
// paragraph followed by the final `Defined as: <expression>` paragraph (see
// knowledge_catalog.entityDescription) -- off a pulled entity description,
// returning the definition and the remaining text for splitEntityTrailers. A
// description without the `Defined as:` paragraph comes back untouched.
export function splitDefinitionTrailer(text: string|undefined): {
  rest: string|undefined;
  definition?: {expression: string; description?: string};
} {
  if (text === undefined) return {rest: undefined};
  let paragraphs = text.split('\n\n');
  const last = paragraphs[paragraphs.length - 1];
  if (!last.startsWith(DEFINED_AS_PREFIX)) return {rest: text};
  const expression = last.slice(DEFINED_AS_PREFIX.length).trim();
  if (!expression) return {rest: text};
  paragraphs = paragraphs.slice(0, -1);
  const definition: {expression: string; description?: string} = {expression};
  const note = paragraphs[paragraphs.length - 1];
  if (note !== undefined && note.startsWith(DEFINITION_NOTE_PREFIX)) {
    definition.description = note.slice(DEFINITION_NOTE_PREFIX.length).trim();
    paragraphs = paragraphs.slice(0, -1);
  }
  const rest = paragraphs.join('\n\n');
  return {rest: rest === '' ? undefined : rest, definition};
}

// Splits a pulled entity description into the authored description, the
// supertypes publish appended as a `Specializes: a, b.` paragraph, and the
// trailing `Abstract: no table of its own.` marker (see
// knowledge_catalog.entityDescription). Peeled from the end in reverse publish
// order; a description without either paragraph comes back untouched. An
// empty remainder becomes undefined, so an entity published with no authored
// description reads back without one.
export function splitEntityTrailers(text: string|undefined):
    {description: string|undefined; parents: string[]; abstract: boolean} {
  if (text === undefined) {
    return {description: undefined, parents: [], abstract: false};
  }
  let paragraphs = text.split('\n\n');
  let abstract = false;
  if (paragraphs[paragraphs.length - 1] === ABSTRACT_MARKER) {
    abstract = true;
    paragraphs = paragraphs.slice(0, -1);
  }
  let parents: string[] = [];
  const last = paragraphs[paragraphs.length - 1];
  if (last !== undefined && last.startsWith(SPECIALIZES_PREFIX) &&
      last.endsWith('.')) {
    parents = last.slice(SPECIALIZES_PREFIX.length, -1)
                  .split(',')
                  .map(s => s.trim())
                  .filter(s => s.length > 0);
    paragraphs = paragraphs.slice(0, -1);
  }
  const rest = paragraphs.join('\n\n');
  // Untouched text keeps its exact form (including an authored empty string).
  if (!abstract && !parents.length) {
    return {description: text, parents, abstract};
  }
  return {description: rest === '' ? undefined : rest, parents, abstract};
}


// Recovers ai_context from an entry's `guidelines` aspect. The emitter routes
// only `ai_context.instructions` to that aspect (see guidelinesAspectData), so
// synonyms and examples stay absent. Author-declared guidelines are stamped
// userManaged:true; Dataplex may also attach machine-generated guidelines
// (userManaged:false), which are not authored model content, so those are
// skipped. Returns undefined when the entry carries no author guidelines
// instructions.
function readAiContext(entry: Entry): AiContext|undefined {
  const guidelines = aspectData(entry, 'guidelines');
  if (guidelines.userManaged === false) return undefined;
  const instructions = guidelines.instructions;
  if (typeof instructions !== 'string' || instructions === '') return undefined;
  return {instructions};
}


// Reconstructs a field from one `schema` aspect field record, inverting
// schemaAspectData: the datatype from dataType/metadataType, expressions from
// the nested `semantics` block, and the DIMENSION role back to a dimension
// marker.
function readField(fd: any, entityName: string, warnings: string[]): Field|
    undefined {
  const name = fd?.name;
  if (name === undefined || name === '') {
    warnings.push(
        `entity '${entityName}': a schema field is missing its name; the ` +
        `field is skipped`);
    return undefined;
  }
  const field: Field = {name};
  const sem = fd?.semantics ?? {};
  // An expression with no SQL does not load, so the field is read as unbound.
  const noSql = typeof sem.expression === 'string' ?
      noSqlReason(sem.expression, 'ANSI_SQL', entityName) :
      undefined;
  if (noSql) {
    warnings.push(
        `entity '${entityName}': field '${name}': its expression in the ` +
        `catalog ${noSql}, so the field is read as unbound`);
  } else if (sem.expression !== undefined) {
    field.expression = sem.expression;
  }
  const type = irDataType(fd?.dataType, fd?.metadataType);
  if (type !== undefined) field.type = type;
  if (sem.role === 'DIMENSION') field.dimension = {};
  // K7: the emitter appends `Unit: …` / `Scale: …` to the description.
  const unit = splitUnitTrailer(fd?.description);
  if (unit.rest !== undefined) field.description = unit.rest;
  if (unit.unit !== undefined) field.unit = unit.unit;
  if (unit.scale !== undefined) field.scale = unit.scale;
  // The display label rides in the schema field's `annotations` map (the
  // inverse of the emitter's `annotations: {label}`).
  const label = fd?.annotations?.label;
  if (typeof label === 'string' && label !== '') field.label = label;
  return field;
}


// Reconstructs a metric from its `semantic-metric` aspect. The attach `entity`
// is re-derived from the expression (as the loader does) when the aspect holds
// one, else it falls back to the entity the emitter persisted. A default push
// omits the expression entirely (it is gated behind `--emit-expressions`), so
// an absent expression is expected, not an error, and does not warn.
function readMetric(
    entry: Entry, entityNames: string[], warnings: string[]): Metric {
  const name = entry.entrySource?.displayName ?? idOf(entry.name);
  const data = {...aspectData(entry, 'semantic-metric')};
  // K1: the expressions aspect, when present, is authoritative for the
  // expression, its imported vendor form and the logical type.
  const exprAnn = readExpressionsAnnotation(entry);
  if (exprAnn) data.expression = exprAnn.expression;

  const metric: Metric = {name};
  // An expression with no SQL does not load, so it is read as absent, and the
  // serializer warns that the metric needs one.
  const expression = typeof data.expression === 'string' &&
          noSqlReason(data.expression, 'ANSI_SQL') ?
      undefined :
      data.expression;
  if (expression !== undefined) metric.expression = expression;
  const exprForRefs = expression ?? '';
  const cols = exprForRefs ? columnReferences(exprForRefs, 'BIGQUERY') : [];
  const referenced = entitiesReached(cols ?? [], entityNames);
  const persistedEntity =
      typeof data.entity === 'string' && data.entity !== '' ? data.entity :
                                                              undefined;
  if (cols === undefined && persistedEntity === undefined) {
    warnings.push(
        `metric '${name}': expression could not be parsed; entity inference ` +
        `was skipped (set 'entity' on the metric, or backtick-quote a ` +
        `reserved qualifier, such as \`Date\`.amount)`);
  }
  if (referenced.length === 1) {
    // The expression pins exactly one known entity; re-derive it (as the loader
    // does) so the attach entity stays consistent with the reconstructed set.
    metric.entity = referenced[0];
  } else if (persistedEntity !== undefined) {
    // The expression does not pin a single known entity (none, or several), so
    // fall back to the attach entity the emitter persisted (metricAspectData)
    // rather than dropping it.
    metric.entity = persistedEntity;
    // A recovered expression that cannot re-derive the anchor means the author
    // wrote it; mark it authored so the serializer writes `entity:` back. Not
    // when the anchor names a dataset this pull did not rebuild: a derived
    // anchor is persisted too, and `entity:` naming no dataset would not load.
    // With no expression (a default push) the metric cannot reload either way.
    if (exprForRefs && entityNames.includes(persistedEntity)) {
      metric.authoredEntity = persistedEntity;
    }
  } else if (cols !== undefined && exprForRefs && !referenced.length) {
    // Parity with the loader's convertMetric: an expression that qualifies no
    // known entity is flagged as potentially unplaceable downstream.
    warnings.push(
        `metric '${name}': expression references no known entity; it may not ` +
        `be placeable downstream`);
  }
  // The emitter writes a required dataType, defaulting a typeless metric to
  // Opaque (see metricAspectData). The metric aspect carries no metadataType,
  // so Opaque serializes as a bare STRING, which irDataType reads back as
  // un-typed
  // -- a metric authored without a datatype round-trips un-typed rather than as
  // a guessed numeric type.
  const type = exprAnn ? exprAnn.type : irDataType(data.dataType, undefined);
  if (type !== undefined) metric.type = type;
  if (exprAnn?.importedExpression !== undefined)
    metric.importedExpression = exprAnn.importedExpression;
  if (exprAnn?.importedDialect !== undefined)
    metric.importedDialect = exprAnn.importedDialect;
  // Push appends the derived `Query: …` paragraph when it knew the physical
  // layout (read_trailers.ts); every push recomputes it, so it is dropped.
  const description = splitQueryTrailer(entry.entrySource?.description).rest;
  if (description !== undefined) metric.description = description;
  const aiAnn = readAiContextAnnotation(entry);
  const ai = aiAnn ? aiAnn.aiContext : readAiContext(entry);
  if (ai) metric.aiContext = ai;
  return metric;
}



// The inverse of columnDataType/columnMetadataType: maps the schema aspect's
// dataType (disambiguated by metadataType only for the STRING family) back to
// the IR's logical DataType. STRING + OTHER is Opaque -- which the emitter
// writes both for an authored `Opaque` field and for a field the author left
// untyped; a plain STRING (metadataType STRING) is an authored `String` and is
// read as un-typed (undefined), the loader's default. (The metric aspect has no
// metadataType, so a metric's bare STRING always reads back un-typed.)
function irDataType(dataType: string|undefined, metadataType: string|undefined):
    DataType|undefined {
  switch (dataType) {
    case 'INT64':
      return 'Integer';
    case 'NUMERIC':
      return 'Decimal';
    case 'FLOAT64':
      return 'Float';
    case 'BOOL':
      return 'Boolean';
    case 'DATE':
      return 'Date';
    case 'TIME':
      return 'Time';
    case 'DATETIME':
      return 'DateTime';
    case 'TIMESTAMP':
      return 'DateTimeTz';
    case 'STRING':
      return metadataType === 'OTHER' ? 'Opaque' : undefined;
    default:
      return undefined;
  }
}


// The inverse of entityAspectData, through the loader's own conversion: a
// BigQuery or BigLake resource URI or resource name, or a `bigquery:` catalog
// name, becomes the dot-separated table string. A Spanner or AlloyDB resource
// name becomes its resource URI. Anything else is returned trimmed. An absent
// resource reads as ''.
function dataSourceFromResource(resource: string|undefined): string {
  return sourceToDataSource(resource ?? '');
}


// The bare `semantic-*` type of an entry, matched by entryType suffix so the
// system-type project/location need not be known. Returns undefined for entries
// that are not part of a semantic model.
function semanticType(entry: Entry): 'semantic-model'|'semantic-entity'|
    'semantic-metric'|undefined {
  for (const t of ['semantic-model', 'semantic-entity', 'semantic-metric'] as
       const) {
    if (entry.entryType?.endsWith(`/entryTypes/${t}`)) return t;
  }
  return undefined;
}


// The `data` payload of an entry's aspect of the given bare type. See
// aspectDataOf; entries and entry links carry aspects in the same shape.
function aspectData(entry: Entry, type: string): Record<string, any> {
  return aspectDataOf(entry.aspects, type);
}


// The `data` payload of an aspect of the given bare type from an aspect map,
// matched by the aspect key's `.<type>` suffix or the aspectType's
// `/aspectTypes/<type>` suffix (robust to whichever system-type
// project/location the emitter used). Returns an empty object when the aspect
// is absent.
function aspectDataOf(aspects: Record<string, Aspect>|undefined, type: string):
    Record<string, any> {
  for (const [key, aspect] of Object.entries(aspects ?? {})) {
    if (key.endsWith(`.${type}`) ||
        aspect.aspectType?.endsWith(`/aspectTypes/${type}`)) {
      return aspect.data ?? {};
    }
  }
  return {};
}


// Recovers the model's deployment targets from its semantic-model aspect back
// into both the GOOGLE custom_extension shim and a `deployments` list (`default`
// when there is one target, `deployment_1`, `deployment_2`, ... when there are
// several), warning that the original deployment names were not recovered.
// Returns undefined when the model has none.
function readDeploymentTargets(
    anchor: Entry, modelName: string, warnings: string[]):
    {extension: CustomExtension; deployments: DeploymentSpec[]}|undefined {
  const deployments: DeploymentSpec[] = unnamedDeployments(
      asArray(aspectData(anchor, 'semantic-model').deploymentTargets)
          .filter((t): t is string => typeof t === 'string'));
  if (!deployments.length) return undefined;
  const targets = deployments.map(d => d.target);
  warnings.push(
      `model '${modelName}': deployment names were not recovered (the ` +
      `catalog stores target URIs only); using ${
          deployments.map(d => `'${d.name}'`).join(', ')}`);
  return {
    extension: {
      vendorName: 'GOOGLE',
      data: JSON.stringify({deploymentTargets: targets}),
    },
    deployments,
  };
}


// Inverts schemaJoinAspectData (knowledge_catalog.ts): each schema-join link
// whose two endpoints are both this model's entity entries becomes one
// direct-FK relationship, and each junction entry's `-src` / `-dst` link pair
// one many-to-many relationship (see knowledge_catalog.junctionResources).
//
// Endpoint identity comes from the link's entryReferences (matched by entry id
// via `entityByEntryId`), NOT from the aspect's table names: the id is unique
// per entity (two entities can share a table) and survives the
// project-number/id normalization lookupEntry applies to entries but
// lookupEntryLinks does not apply to link references. The aspect then supplies
// the join columns and the direction -- its `source` side is the foreign-key
// side, named by its data source -- used only to orient the two endpoints. The
// link id encodes the (normalized) relationship name; the anchor's index
// (`index`, from its ai-context aspect) maps a link id back to the authored
// name and ai_context, and fixes the order. Links are deduped -- schema-join
// is undirected, so a per-entry lookup can return the same link once from
// each endpoint.
function readRelationships(
    links: EntryLink[], modelName: string, entityByEntryId: Map<string, Entity>,
    warnings: string[], junctionByEntryId: Map<string, Entry> = new Map(),
    index: RelationshipIndexRow[] = []): Relationship[] {
  const prefix = linkNamePrefix(modelName);
  const byLink = new Map(
      index.filter(r => r.link).map(r => [r.link!, r] as const));
  const indexed = (link: EntryLink|undefined, rel: Relationship) => {
    const row = link ? byLink.get(idOf(link.name ?? '')) : undefined;
    if (!row) return;
    rel.name = row.name;
    if (row.aiContext) rel.aiContext = row.aiContext;
  };
  const seen = new Set<string>();
  const out: Relationship[] = [];
  // Junction entry id -> its two side links and the endpoint each reaches.
  const sides =
      new Map<string, {src?: [EntryLink, Entity]; dst?: [EntryLink, Entity]}>();
  for (const link of links) {
    if (!link.entryLinkType?.endsWith('/entryLinkTypes/schema-join')) continue;
    const refs = link.entryReferences ?? [];
    if (refs.length !== 2) continue;
    // Resolve both endpoints from the link's references. A reference that is
    // not one of this model's entities (another model, or a non-entity) means
    // the link does not belong here -- skip it quietly.
    const endA = entityByEntryId.get(idOf(refs[0].name));
    const endB = entityByEntryId.get(idOf(refs[1].name));
    const juncA = junctionByEntryId.has(idOf(refs[0].name)) ?
        idOf(refs[0].name) : undefined;
    const juncB = junctionByEntryId.has(idOf(refs[1].name)) ?
        idOf(refs[1].name) : undefined;
    if ((juncA && endB) || (juncB && endA)) {
      const key = linkDedupKey(link);
      if (seen.has(key)) continue;
      seen.add(key);
      const junction = (juncA ?? juncB)!;
      const end = (juncA ? endB : endA)!;
      const id = idOf(link.name ?? '');
      const side = id.endsWith('-src') ? 'src' : id.endsWith('-dst') ? 'dst' :
                                                                        undefined;
      if (!side) continue;
      const entry = sides.get(junction) ?? {};
      entry[side] = [link, end];
      sides.set(junction, entry);
      continue;
    }
    if (!endA || !endB) continue;

    const key = linkDedupKey(link);
    if (seen.has(key)) continue;
    seen.add(key);

    const join = asArray(aspectDataOf(link.aspects, 'schema-join').joins)[0];
    if (!join) {
      warnings.push(
          `entry link '${link.name}': no schema-join aspect data; the ` +
          `relationship is skipped`);
      continue;
    }
    // Direction lives in the aspect: `source` is the foreign-key side, named by
    // its data source. Orient the two endpoints by matching that name, keeping
    // join.source.fields paired with the source side. When neither orientation
    // matches -- or both do, because the endpoints share a data source -- the
    // direction is undecidable, so keep the reference order and warn rather
    // than drop the edge.
    const srcName = (join.source?.name ?? '').trim();
    const tgtName = (join.target?.name ?? '').trim();
    // An endpoint with no data source (a logical, unbound model) is named by
    // its entity name instead -- what schemaJoinAspectData writes then.
    const aSrc = (endA.dataSource || endA.name).trim();
    const bSrc = (endB.dataSource || endB.name).trim();
    const endAIsSource = aSrc === srcName && bSrc === tgtName;
    const endBIsSource = bSrc === srcName && aSrc === tgtName;
    let [source, destination] = [endA, endB];
    if (endBIsSource && !endAIsSource) {
      [source, destination] = [endB, endA];
    } else if (!endAIsSource && !endBIsSource) {
      warnings.push(
          `entry link '${link.name}': join direction does not match either ` +
          `endpoint's data source; using the reference order`);
    } else if (endAIsSource && endBIsSource) {
      warnings.push(
          `entry link '${link.name}': join direction is ambiguous (endpoints ` +
          `share a data source); using the reference order`);
    }
    const rel: Relationship = {
      name: relationshipName(link.name, prefix),
      source: {entity: source.name, columns: asArray(join.source?.fields)},
      destination:
          {entity: destination.name, columns: asArray(join.target?.fields)},
    };
    applyJoinDescription(rel, join.description);
    indexed(link, rel);
    out.push(rel);
  }

  // Many-to-many: a junction entry plus its two side links.
  for (const [junctionId, pair] of sides) {
    const junctionEntry = junctionByEntryId.get(junctionId)!;
    if (!pair.src || !pair.dst) {
      warnings.push(
          `junction entry '${junctionEntry.name}': missing its ${
              pair.src ? 'destination' : 'source'} link; the many-to-many ` +
          `relationship is skipped`);
      continue;
    }
    const [srcLink, srcEnd] = pair.src;
    const [dstLink, dstEnd] = pair.dst;
    const srcJoin =
        asArray(aspectDataOf(srcLink.aspects, 'schema-join').joins)[0] ?? {};
    const dstJoin =
        asArray(aspectDataOf(dstLink.aspects, 'schema-join').joins)[0] ?? {};
    const junction = readEntity(junctionEntry, []);
    const association: Association = {
      dataSource: junction.dataSource,
      keys: junction.keys,
      sourceColumns: stringList(srcJoin.source?.fields),
      destinationColumns: stringList(dstJoin.source?.fields),
    };
    if (junction.fields.length) association.fields = junction.fields;
    const tagged = readBindingAnnotation(junctionEntry)?.association;
    const rel: Relationship = {
      name: tagged?.relationship ??
          relationshipName(
              (srcLink.name ?? '').replace(/-src$/, ''), prefix),
      source: {entity: srcEnd.name, columns: stringList(srcJoin.target?.fields)},
      destination:
          {entity: dstEnd.name, columns: stringList(dstJoin.target?.fields)},
      association,
    };
    applyJoinDescription(rel, srcJoin.description);
    indexed(srcLink, rel);
    out.push(rel);
  }

  // Relationships that publish no link (abstract, or an abstract /
  // column-less endpoint) ride the anchor's index whole. Rebuilt only when
  // both endpoints are entities this pull recovered, so none dangles.
  const known = new Set([...entityByEntryId.values()].map(e => e.name));
  for (const row of index) {
    const u = row.unpublished;
    if (!u || row.link) continue;
    if (!known.has(u.source.entity) || !known.has(u.destination.entity)) {
      warnings.push(
          `relationship '${row.name}': an endpoint entity was not recovered; ` +
          `the relationship is skipped`);
      continue;
    }
    const rel: Relationship = {
      name: row.name,
      ...structuredClone(u),
    };
    if (row.aiContext) rel.aiContext = row.aiContext;
    out.push(rel);
  }

  // The anchor's index fixes the authored order; anything it does not list
  // (a catalog pushed before it existed) keeps the order it was read in.
  if (index.length) {
    const position = new Map(index.map((r, i) => [r.name, i] as const));
    const at = (r: Relationship) => position.get(r.name) ?? index.length;
    out.sort((a, b) => at(a) - at(b));
  }
  // Relationship inheritance round-trip. Only a concrete (bound) relationship
  // publishes a link, so a parent that is ABSTRACT -- the common case -- has no
  // link to pull back, and a restored `extends` naming it would dangle (a
  // validate error). Keep each parent that resolves to a pulled relationship
  // (by verbatim name, or by the link-slugged name pull recovers for one not
  // already in slug form); drop the rest with a warning naming the gap.
  const pulledNames = new Set(out.map(r => r.name));
  for (const rel of out) {
    if (!rel.extends) continue;
    const kept: string[] = [];
    for (const parent of rel.extends) {
      const slug = linkSlug(parent);
      const resolved = pulledNames.has(parent) ? parent :
          pulledNames.has(slug)                ? slug :
                                                 undefined;
      if (resolved) {
        kept.push(resolved);
      } else {
        warnings.push(
            `relationship '${rel.name}' specializes '${parent}', which ` +
            `publishes no schema-join link (it is abstract, or unbound), so ` +
            `the pulled model cannot declare it; 'extends: [${parent}]' is ` +
            `dropped -- re-add the abstract relationship to restore it`);
      }
    }
    if (kept.length) {
      rel.extends = kept;
    } else {
      delete rel.extends;
    }
  }
  // K2: a chain step names a relationship (or its inverse) as authored, while
  // pull recovers relationship names in link-slug form; resolve each step the
  // way `extends` parents are, so the pulled chain still follows. A step that
  // resolves to nothing is kept as published (the loader then warns).
  const inverseNames = new Set(
      out.flatMap(r => r.inverse !== undefined ? [r.inverse] : []));
  for (const rel of out) {
    if (!rel.via) continue;
    rel.via = rel.via.map(step => {
      const name = step.relationship;
      if (pulledNames.has(name) || inverseNames.has(name)) return step;
      const slug = linkSlug(name);
      return pulledNames.has(slug) ? {...step, relationship: slug} : step;
    });
  }
  return out;
}

// Peels a pulled join description back into the relationship: publish
// appends Specializes, then Inverse, then (K2) the Derived paragraphs (see
// knowledge_catalog.joinDescription); peel them off in reverse.
function applyJoinDescription(
    rel: Relationship, text: string|undefined): void {
  if (text === undefined) return;
  const k2 = splitDerivedTrailers(text);
  if (k2.via) {
    // A derived join publishes its endpoints' keys as `fields` (see
    // knowledge_catalog.schemaJoinAspectData); its pairs come from the
    // chain, so it binds no columns of its own.
    rel.via = k2.via;
    if (k2.filter !== undefined) rel.filter = k2.filter;
    rel.source.columns = [];
    rel.destination.columns = [];
  }
  const inv = k2.rest !== undefined ? splitInverse(k2.rest) : {};
  if (inv.inverse !== undefined) rel.inverse = inv.inverse;
  if (inv.description !== undefined) {
    const {description, parents} = splitSpecializes(inv.description);
    if (description !== undefined) rel.description = description;
    if (parents.length) rel.extends = parents;
  }
}

// Splits a pulled schema-join description into the authored description and
// the super-relationship names publish appended as its last paragraph (see
// knowledge_catalog.SPECIALIZES_PREFIX). A description without that trailing
// paragraph comes back untouched with no parents. Run AFTER splitInverse: the
// Inverse paragraph, when present, follows this one.
export function splitSpecializes(text: string):
    {description: string|undefined; parents: string[]} {
  const paragraphs = text.split('\n\n');
  const last = paragraphs[paragraphs.length - 1];
  if (!last.startsWith(SPECIALIZES_PREFIX) || !last.endsWith('.')) {
    return {description: text, parents: []};
  }
  const parents = last.slice(SPECIALIZES_PREFIX.length, -1)
                      .split(',')
                      .map(s => s.trim())
                      .filter(s => s.length > 0);
  const rest = paragraphs.slice(0, -1).join('\n\n');
  return {description: rest.length ? rest : undefined, parents};
}

// Splits the `Inverse: <name>.` trailer knowledge_catalog.ts appends to a join
// description back off it (see joinDescription there). Only a final paragraph
// of exactly that shape is read, so an ordinary description that happens to
// mention an inverse is left alone.
export function splitInverse(text: string):
    {description?: string; inverse?: string} {
  const m = text.match(
      new RegExp(`(?:^|\\n\\n)${INVERSE_PREFIX}([A-Za-z_][A-Za-z0-9_-]*)\\.$`));
  if (!m) return {description: text};
  const rest = text.slice(0, m.index).trimEnd();
  return {description: rest || undefined, inverse: m[1]};
}


// A stable dedup key for an entry link: its name when present, else its
// (order-independent) endpoint pair and type. Guards against a per-endpoint
// lookup returning an unnamed link once from each of its two endpoints.
export function linkDedupKey(link: EntryLink): string {
  if (link.name) return link.name;
  const refs = (link.entryReferences ?? []).map(r => r.name).sort();
  return `${refs.join('\0')}\0${link.entryLinkType ?? ''}`;
}


// Best-effort recovery of the relationship name from the link id, which the
// emitter built as linkSlug(`<model>-<name>`) (lowercased, with each underscore
// turned into a hyphen -- see knowledge_catalog.ts). Strips the model prefix
// when present. A relationship name has no hyphen, so each hyphen left is read
// back as an underscore; the name comes back lowercased.
function relationshipName(
    linkName: string|undefined, modelPrefix: string): string {
  const id = idOf(linkName ?? '');
  const rest = modelPrefix && id.startsWith(`${modelPrefix}-`) ?
      id.slice(modelPrefix.length + 1) :
      '';
  return (rest || id).replace(/-/g, '_');
}


// Mirrors the model-name portion of the emitter's linkSlug so the prefix a link
// id was built with can be stripped. Kept local rather than imported: this
// read-side module must not depend on the write-side emitter. Exported for the
// symmetry test, which reuses it to reproduce the normalized relationship name
// rather than reimplementing the slug rule.
//
// It reproduces linkSlug's normalization AND its 63-char cap + trailing-hyphen
// re-strip, so the prefix stays aligned with the id even when the combined
// `<model>-<name>` slug was truncated. (linkSlug's `|| 'link'` empty-slug
// fallback is intentionally omitted: an empty prefix strips nothing and
// relationshipName then returns the id verbatim, which is already correct. When
// the cap truncates into the model slug itself the relationship name is
// unrecoverable regardless -- relationshipName returns the truncated id.)
export function linkNamePrefix(modelName: string): string {
  return modelName.toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[^a-z]+/, '')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63)
      .replace(/-+$/, '');
}


// The id segment of a full entry resource name (after the last '/').
export function idOf(name: string): string {
  return name.split('/').pop() ?? name;
}


function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}


// The non-empty strings of an array value, dropping non-string and empty
// entries. Used for key / unique-constraint field lists from the schema aspect.
function stringList(value: any): string[] {
  return asArray(value).filter(
      (s): s is string => typeof s === 'string' && s !== '');
}
