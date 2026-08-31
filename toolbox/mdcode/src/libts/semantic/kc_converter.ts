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
// (from the semantic-model aspect, back into the GOOGLE `custom_extensions`
// block), and 1:1 / 1:N relationships (from the `schema-join` entry links a
// pull fetched -- see `modelsFromCatalogResources`'s `entryLinks` argument).
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
// come back normalized (lowercased/hyphenated), since the emitter encodes the
// name only in the link id (via `linkSlug`), not in the join aspect.

import type {Aspect, Entry, EntryLink} from '../gcp/dataplex';

import {Action, ActionParameter, AiContext, CustomExtension, DATA_TYPES, DataType, Entity, Executor, Field, Metric, Relationship, SemanticModel} from './ir';
import {ACTIONS_OVERVIEW_MARKER} from './knowledge_catalog';
import {referencedEntityNames} from './sql_expr_utils';

export interface ReadResult {
  models: SemanticModel[];
  warnings: string[];
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

    const entityEntriesForModel = childrenOf(anchor.name, entityEntries);
    const entities = entityEntriesForModel.map(e => readEntity(e, warnings));
    const entityNames = entities.map(e => e.name);
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

    // Relationships come from the schema-join entry links whose two endpoints
    // are both this model's entity entries (M:N edges were never published --
    // they live only in the BigQuery property graph -- so stay absent here).
    const relationships =
        readRelationships(entryLinks, name, entityByEntryId, warnings);

    const model: SemanticModel = {name, entities, relationships, metrics};
    const description = anchor.entrySource?.description;
    if (description !== undefined) model.description = description;
    // Actions ride the anchor's overview aspect (see
    // actionsOverviewAspectData); recover them from its embedded JSON block.
    // Absent overview -> no actions.
    const actions = readActionsFromOverview(anchor, entityNames, warnings);
    if (actions.length) model.actions = actions;
    // Deployment targets ride back in the same GOOGLE custom_extensions block
    // the author wrote them in (the inverse of the emitter's modelAspectData).
    const targets = readDeploymentTargets(anchor);
    if (targets) model.customExtensions = [targets];
    const ai = readAiContext(anchor);
    if (ai) model.aiContext = ai;
    return model;
  });

  // Flag children that resolved to no anchor at all (only possible with
  // multiple anchors, where the sole-anchor fallback does not apply).
  if (!soleAnchor) {
    for (const child of [...entityEntries, ...metricEntries]) {
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

  const dataSource = dataSourceFromResource(semantic?.source?.resources?.[0]);
  if (!dataSource) {
    warnings.push(
        `entity '${name}': no backing data source in the semantic-entity ` +
        `aspect; 'source' will be empty and the entity may not load`);
  }
  const entity: Entity = {
    name,
    dataSource,
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
  const description = entry.entrySource?.description;
  if (description !== undefined) entity.description = description;
  const ai = readAiContext(entry);
  if (ai) entity.aiContext = ai;
  return entity;
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
  if (sem.expression !== undefined) field.expression = sem.expression;
  const type = irDataType(fd?.dataType, fd?.metadataType);
  if (type !== undefined) field.type = type;
  if (sem.role === 'DIMENSION') field.dimension = {};
  if (fd?.description !== undefined) field.description = fd.description;
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
  const data = aspectData(entry, 'semantic-metric');

  const metric: Metric = {name};
  if (data.expression !== undefined) metric.expression = data.expression;
  const exprForRefs = data.expression ?? '';
  const referenced = referencedEntityNames(exprForRefs, entityNames);
  const persistedEntity =
      typeof data.entity === 'string' && data.entity !== '' ? data.entity :
                                                              undefined;
  if (referenced.length === 1) {
    // The expression pins exactly one known entity; re-derive it (as the loader
    // does) so the attach entity stays consistent with the reconstructed set.
    metric.entity = referenced[0];
  } else if (persistedEntity !== undefined) {
    // The expression does not pin a single known entity (none, or several), so
    // fall back to the attach entity the emitter persisted (metricAspectData)
    // rather than dropping it.
    metric.entity = persistedEntity;
  } else if (exprForRefs && !referenced.length) {
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
  const type = irDataType(data.dataType, undefined);
  if (type !== undefined) metric.type = type;
  const description = entry.entrySource?.description;
  if (description !== undefined) metric.description = description;
  const ai = readAiContext(entry);
  if (ai) metric.aiContext = ai;
  return metric;
}


// Recovers the model's actions from the anchor's `overview` aspect, the inverse
// of actionsOverviewAspectData. The overview's Markdown is for humans; the
// machine-readable form is a fenced JSON array after ACTIONS_OVERVIEW_MARKER,
// so this locates that block, parses it, and rebuilds each Action.
// `isEntityRef` is re-derived against the reconstructed entities (as the loader
// does) rather than trusted from the JSON, so it stays consistent with the
// pulled model. Returns an empty list when there is no overview or no parseable
// action block.
function readActionsFromOverview(
    anchor: Entry, entityNames: string[], warnings: string[]): Action[] {
  const content = aspectData(anchor, 'overview').content;
  if (typeof content !== 'string' || !content.includes(ACTIONS_OVERVIEW_MARKER))
    return [];
  const json = jsonBlockAfterMarker(content, ACTIONS_OVERVIEW_MARKER);
  if (json === undefined) {
    warnings.push(
        `model actions: overview aspect has the actions marker but no parseable ` +
        `JSON block; actions are not recovered`);
    return [];
  }
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (err: any) {
    warnings.push(`model actions: overview action block is not valid JSON (${
        err.message || err}); actions are not recovered`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    warnings.push(
        `model actions: overview action block is not a JSON array; actions are ` +
        `not recovered`);
    return [];
  }
  const entitySet = new Set(entityNames);
  return parsed.map((a: any) => readAction(a, entitySet, warnings))
      .filter((a): a is Action => a !== undefined);
}


// Extracts the first ```json ... ``` fenced block that follows `marker` in the
// content, returning the block's inner text (or undefined when none follows).
function jsonBlockAfterMarker(content: string, marker: string): string|
    undefined {
  const afterMarker =
      content.slice(content.lastIndexOf(marker) + marker.length);
  const fence = afterMarker.match(/```json\s*\n([\s\S]*?)\n```/);
  return fence ? fence[1] : undefined;
}


// Rebuilds one Action from its embedded JSON (the inverse of actionJson). A
// record missing a usable name or executor is skipped with a warning, so a
// malformed block degrades one action rather than the whole pull.
function readAction(
    a: any, entityNames: Set<string>, warnings: string[]): Action|undefined {
  const name = typeof a?.name === 'string' ? a.name : '';
  if (!name) {
    warnings.push(
        'model actions: an action in the overview has no name; skipped');
    return undefined;
  }
  const executor = readExecutor(a?.executor);
  if (!executor) {
    warnings.push(
        `action '${name}': overview executor is missing or malformed; the ` +
        `action is skipped`);
    return undefined;
  }
  const parameters =
      asArray(a?.parameters)
          .map((p: any) => readParameter(p, entityNames, name, warnings))
          .filter((p): p is ActionParameter => p !== undefined);
  const action: Action = {name, executor, parameters};
  if (typeof a?.description === 'string' && a.description !== '')
    action.description = a.description;
  if (a?.aiContext && typeof a.aiContext === 'object')
    action.aiContext = a.aiContext as AiContext;
  if (Array.isArray(a?.customExtensions))
    action.customExtensions = a.customExtensions as CustomExtension[];
  return action;
}


// One action parameter from its JSON, re-deriving isEntityRef against the
// model's entities (a scalar datatype otherwise). A record missing a name is
// dropped.
function readParameter(
    p: any, entityNames: Set<string>, actionName: string,
    warnings: string[]): ActionParameter|undefined {
  const name = typeof p?.name === 'string' ? p.name : '';
  const type = typeof p?.type === 'string' ? p.type : '';
  if (!name) return undefined;
  const param: ActionParameter = {name, type};
  if (entityNames.has(type)) {
    param.isEntityRef = true;
  } else if ((DATA_TYPES as readonly string[]).includes(type)) {
    param.isEntityRef = false;
  } else {
    // The type resolves to neither an entity in the pulled model nor a scalar
    // datatype -- e.g. an entity-typed parameter whose entity was not part of
    // this pull. Leave isEntityRef unset (push-side validate flags it) and warn
    // so the gap is visible rather than silently dropped.
    warnings.push(
        `action '${actionName}': parameter '${name}' type '${type}' is ` +
        `neither a known entity nor a scalar datatype; pulled without a ` +
        `resolved type`);
  }
  return param;
}


// The IR executor from the embedded single-key JSON object
// ({mcp}/{rest}/{grpc}, the inverse of executorJson). Returns undefined when no
// known kind is present or a coordinate is not a string.
function readExecutor(ex: any): Executor|undefined {
  // A coordinate must be a present, NON-BLANK string. The overview JSON can
  // carry an empty string (e.g. a hand-edited block); treat that as malformed
  // so the reader rejects it exactly as push-side validate would, rather than
  // recovering an action the next push cannot deploy.
  const str = (v: any): v is string => typeof v === 'string' && v.trim() !== '';
  if (ex?.mcp && str(ex.mcp.server) && str(ex.mcp.tool))
    return {kind: 'mcp', mcp: {server: ex.mcp.server, tool: ex.mcp.tool}};
  if (ex?.rest && str(ex.rest.endpoint) && str(ex.rest.method))
    return {
      kind: 'rest',
      rest: {endpoint: ex.rest.endpoint, method: ex.rest.method}
    };
  if (ex?.grpc && str(ex.grpc.service) && str(ex.grpc.method))
    return {
      kind: 'grpc',
      grpc: {service: ex.grpc.service, method: ex.grpc.method}
    };
  return undefined;
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


// The inverse of resourcePath: a BigQuery linked-resource URI becomes the
// canonical `project.dataset.table` string; anything else (a verbatim query or
// a passthrough reference) is returned unchanged.
function dataSourceFromResource(resource: string|undefined): string {
  const value = (resource ?? '').trim();
  const m = value.match(
      /^\/\/bigquery\.googleapis\.com\/projects\/([^/]+)\/datasets\/([^/]+)\/tables\/([^/]+)$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : value;
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
// into the GOOGLE custom_extension the author declared them in (the inverse of
// the emitter's modelAspectData). Returns undefined when the model has none.
function readDeploymentTargets(anchor: Entry): CustomExtension|undefined {
  const targets =
      asArray(aspectData(anchor, 'semantic-model').deploymentTargets)
          .filter((t): t is string => typeof t === 'string' && t !== '');
  if (!targets.length) return undefined;
  return {
    vendorName: 'GOOGLE',
    data: JSON.stringify({deploymentTargets: targets})
  };
}


// Inverts schemaJoinAspectData (knowledge_catalog.ts): each schema-join link
// whose two endpoints are both this model's entity entries becomes one
// direct-FK relationship.
//
// Endpoint identity comes from the link's entryReferences (matched by entry id
// via `entityByEntryId`), NOT from the aspect's table names: the id is unique
// per entity (two entities can share a table) and survives the
// project-number/id normalization lookupEntry applies to entries but
// lookupEntryLinks does not apply to link references. The aspect then supplies
// the join columns and the direction -- its `source` side is the foreign-key
// side, named by its data source -- used only to orient the two endpoints. The
// link id encodes the (normalized) relationship name. Links are deduped --
// schema-join is undirected, so a per-entry lookup can return the same link
// once from each endpoint.
function readRelationships(
    links: EntryLink[], modelName: string, entityByEntryId: Map<string, Entity>,
    warnings: string[]): Relationship[] {
  const prefix = linkNamePrefix(modelName);
  const seen = new Set<string>();
  const out: Relationship[] = [];
  for (const link of links) {
    if (!link.entryLinkType?.endsWith('/entryLinkTypes/schema-join')) continue;
    const refs = link.entryReferences ?? [];
    if (refs.length !== 2) continue;
    // Resolve both endpoints from the link's references. A reference that is
    // not one of this model's entities (another model, or a non-entity) means
    // the link does not belong here -- skip it quietly, as with M:N edges.
    const endA = entityByEntryId.get(idOf(refs[0].name));
    const endB = entityByEntryId.get(idOf(refs[1].name));
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
    const aSrc = (endA.dataSource ?? '').trim();
    const bSrc = (endB.dataSource ?? '').trim();
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
    if (join.description !== undefined) rel.description = join.description;
    out.push(rel);
  }
  return out;
}


// A stable dedup key for an entry link: its name when present, else its
// (order-independent) endpoint pair and type. Guards against a per-endpoint
// lookup returning an unnamed link once from each of its two endpoints.
export function linkDedupKey(link: EntryLink): string {
  if (link.name) return link.name;
  const refs = (link.entryReferences ?? []).map(r => r.name).sort();
  return `${refs.join(' ')} ${link.entryLinkType ?? ''}`;
}


// Best-effort recovery of the relationship name from the link id, which the
// emitter built as linkSlug(`<model>-<name>`) (lowercased/hyphenated -- see
// knowledge_catalog.ts). Strips the model prefix when present; the name comes
// back normalized, never verbatim.
function relationshipName(
    linkName: string|undefined, modelPrefix: string): string {
  const id = idOf(linkName ?? '');
  if (modelPrefix && id.startsWith(`${modelPrefix}-`)) {
    const rest = id.slice(modelPrefix.length + 1);
    if (rest) return rest;
  }
  return id;
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
