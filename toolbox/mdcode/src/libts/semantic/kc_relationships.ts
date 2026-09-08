// How a model's relationships are encoded in Knowledge Catalog.
//
// Every relationship publishes as one ENTRY, parented to the model anchor
// beside the entities and metrics, carrying an aspect with the whole
// relationship: its name, its two endpoint entities, the columns that reach
// each of them, and -- for a many-to-many edge -- the table it runs through,
// that table's key, and the edge's own properties. The type is the custom
// `semantic-relationship` pair DECLARED IN kc_custom_types.ts and created there
// by `kcmd init
// --semantic-model`. That file is the list of what is custom; this one is only
// the encoding that fills the aspect.
//
// WHY AN ENTRY, when Dataplex has a built-in `schema-join` entry link for
// joins. schema-join holds exactly one source/target column pair, which cannot
// describe a many-to-many edge -- that is two joins through a third table --
// and Dataplex has no custom entry LINK types to define one with. It also has
// no field for the relationship's own name, so a link's name survives only in
// its id, which is lowercased and hyphenated. An entry has room for all of it.
//
// A foreign-key relationship still ALSO emits its schema-join link (see
// knowledge_catalog.relationshipLink). The entry is the fidelity record, the
// link is the graph-shaped projection that other Dataplex surfaces already
// understand; dropping the link would trade interop for nothing. The two agree,
// and a pull prefers the entry (see kc_converter).
//
// The custom pair is what makes a relationship explicit in the catalog. A
// search can tell one apart from anything else by its entry type, and the
// aspect's fields are typed and queryable rather than prose a reader has to
// interpret.
//
// WHEN A BUILT-IN RELATIONSHIP TYPE SHIPS, follow the instructions at the top
// of kc_custom_types.ts. Nothing in this file changes: the readers below match
// a type by its id suffix, so they do not care which project it lives in.
//
// The call sites are `knowledge_catalog.ts` (emit the entries),
// `kc_converter.ts` (read them back), and `pull_kc.ts` (hydrate the aspect).
//
// `instructions` and the edge's own `fields` ride the relationship's aspect
// rather than the built-in `guidelines` and `schema` aspects an entity uses. A
// pull derives which aspect types to hydrate from the project the ENTRY type
// lives in, so a relationship entry, whose type is custom and therefore in the
// destination project, would ask for aspect types that exist only under
// `dataplex-types`. Keeping both on the relationship's own aspect keeps the
// whole encoding inside the one type kc_custom_types.ts provisions. It is also
// the only home either has ever had: the `guidelines` aspect attaches to a
// model, an entity, or a metric, never to a relationship.
//
// The helpers at the bottom duplicate a few lines from the modules above on
// purpose. This module imports only the IR, the entry shape and the type
// registry, so it can be swapped or deleted as a unit.

import {Entry} from '../gcp/dataplex';

import {AiContext, DATA_TYPES, DataType, Field, Relationship, SemanticModel} from './ir';
import {customAspectKey, customAspectTypeName, customEntryTypeName, RELATIONSHIP_TYPE_ID} from './kc_custom_types';

// Full resource name of the relationship entry type for a destination.
export function relationshipEntryTypeName(dest: {project: string}): string {
  return customEntryTypeName(RELATIONSHIP_TYPE_ID, dest);
}

// Full resource name of the relationship aspect type for a destination.
export function relationshipAspectTypeName(dest: {project: string}): string {
  return customAspectTypeName(RELATIONSHIP_TYPE_ID, dest);
}

// Aspect-map key: the `project.location.type` reference form the client keys an
// entry's aspects by.
export function relationshipAspectKey(dest: {project: string}): string {
  return customAspectKey(RELATIONSHIP_TYPE_ID, dest);
}


// ---------------------------------------------------------------------------
// Write side: the IR -> one entry per relationship.
// ---------------------------------------------------------------------------

// What the emitter supplies so this file need not rebuild entry names or repeat
// the id-collision bookkeeping it already does for entities and metrics.
export interface RelationshipEmitContext {
  // The destination project, which is where the custom types live.
  project: string;
  // Full entry resource name for an entry id (Namer.entry).
  entry(entryId: string): string;
  // Full entry resource name of the model anchor, the parent of every
  // relationship.
  anchor: string;
  // Reserves an entry id, returning false when it collides with one already
  // emitted (knowledge_catalog.claim).
  claim(entryId: string, label: string): boolean;
  // Names of the entities this push actually publishes an entry for. An
  // abstract entity, or one a binding profile pruned, is absent, so an edge
  // ending on it would name an entity the catalog has no entry for.
  publishedEntities: Set<string>;
  // Renders a table into the linked-resource form the catalog stores
  // (knowledge_catalog.resourcePath), so the table a many-to-many edge runs
  // through is addressed the same way an entity's backing table is.
  resource(dataSource: string): string;
}

// The entry id of one relationship: `<model>.relationships.<name>`, alongside
// `<model>.entities.<name>` and `<model>.metrics.<name>`.
export function relationshipEntryId(modelId: string, relName: string): string {
  return `${modelId}.relationships.${slug(relName)}`;
}

// The entry-id prefix a model's relationships occupy, so delete reconciliation
// removes the entry of a relationship dropped from the model.
export function relationshipOwnedPrefix(modelId: string): string {
  return `${modelId}.relationships.`;
}

/**
 * One entry per relationship, to append to the model's entries.
 *
 * Every relationship gets one, foreign-key and many-to-many alike -- including
 * a purely logical edge with no join columns, which has no schema-join link to
 * be published by and would otherwise reach the catalog not at all.
 *
 * An edge whose endpoint entity this push does not publish is skipped with a
 * warning; `relationshipLink` then skips the same edge silently, so one dropped
 * relationship reports once.
 */
export function relationshipEntries(
    model: SemanticModel, modelId: string, ctx: RelationshipEmitContext,
    warnings: string[]): Entry[] {
  const entries: Entry[] = [];
  for (const rel of model.relationships ?? []) {
    const missing = !ctx.publishedEntities.has(rel.source.entity) ?
        rel.source.entity :
        !ctx.publishedEntities.has(rel.destination.entity) ?
        rel.destination.entity :
        undefined;
    if (missing !== undefined) {
      warnings.push(
          `relationship '${rel.name}': endpoint entity '${missing}' is not a ` +
          `published entity; the relationship is skipped.`);
      continue;
    }

    const id = relationshipEntryId(modelId, rel.name);
    if (!ctx.claim(id, `relationship '${rel.name}'`)) continue;
    entries.push({
      name: ctx.entry(id),
      entryType: relationshipEntryTypeName(ctx),
      parentEntry: ctx.anchor,
      entrySource: compact({
                     displayName: rel.name,
                     description: rel.description,
                   }) as Entry['entrySource'],
      aspects: {
        [relationshipAspectKey(ctx)]: {
          aspectType: relationshipAspectTypeName(ctx),
          data: relationshipAspectData(rel, ctx),
        },
      },
    });
  }
  return entries;
}

// The aspect payload for one relationship: its two endpoints and the columns
// that reach them, the table a many-to-many edge runs through with that table's
// key and the edge's properties, and any AI instructions.
function relationshipAspectData(
    rel: Relationship, ctx: RelationshipEmitContext): Record<string, any> {
  return compact({
    fromEntity: rel.source.entity,
    toEntity: rel.destination.entity,
    // Set only on a many-to-many edge. A model with no physical binding has no
    // table to name either; the template leaves the field optional, so omit it
    // rather than store ''.
    through: rel.through ? ctx.resource(rel.through) || undefined : undefined,
    keys: nonEmpty(rel.keys ?? []),
    // Absent on a purely logical edge, which is bound by nothing yet.
    fromColumns: nonEmpty(rel.source.columns),
    toColumns: nonEmpty(rel.destination.columns),
    fields: nonEmpty(
        (rel.fields ??
         []).map(f => compact({
                   name: f.name,
                   // An untyped field is published as Opaque, the explicit
                   // "type unknown" marker, so a pull recovers it as Opaque
                   // rather than dropping the type
                   // -- what the built-in schema aspect does for an entity's
                   // fields.
                   dataType: f.type ?? 'Opaque',
                   description: f.description,
                   expression: f.expression,
                 }))),
    instructions: rel.aiContext?.instructions || undefined,
  });
}


// ---------------------------------------------------------------------------
// Read side: a relationship entry -> the IR.
// ---------------------------------------------------------------------------

// True when an entry is one of a model's relationships, matched by the entry
// type's id suffix so the project the type lives in need not be known -- which
// is what lets a pull keep working when the custom type is replaced by a
// built-in one.
export function isRelationshipEntry(entry: Entry): boolean {
  return entry.entryType?.endsWith(`/entryTypes/${RELATIONSHIP_TYPE_ID}`) ??
      false;
}

// The aspect type resource names to hydrate for a relationship entry. Named
// through the entry type's own project so the pull follows the type wherever it
// lives.
export function relationshipAspectTypes(entryTypeBase: string): string[] {
  return [`${entryTypeBase}/aspectTypes/${RELATIONSHIP_TYPE_ID}`];
}

/**
 * Recovers one relationship from its entry, the inverse of
 * relationshipEntries.
 *
 * Returns undefined, with a warning, for an entry naming an endpoint that is
 * not one of the model's entities, or for a many-to-many edge whose column
 * lists are empty: an edge running through a table but not saying which pairs
 * it holds cannot be reloaded. One bad entry degrades itself rather than the
 * pull.
 *
 * Empty column lists on an edge with no `through` are fine -- that is a purely
 * logical relationship, and recovering it is the point of storing one.
 */
export function readRelationshipEntry(
    entry: Entry, entityNames: string[], warnings: string[]): Relationship|
    undefined {
  const name = entry.entrySource?.displayName || idOf(entry.name);
  const data = relationshipAspectDataOf(entry);
  const known = new Set(entityNames);

  const from = str(data.fromEntity);
  const to = str(data.toEntity);
  for (const [side, end] of [['fromEntity', from], ['toEntity', to]] as const) {
    if (!known.has(end)) {
      warnings.push(
          `relationship '${name}': ${side} '${end}' is not one of the ` +
          `model's entities; the relationship is skipped`);
      return undefined;
    }
  }

  const fromColumns = stringList(data.fromColumns);
  const toColumns = stringList(data.toColumns);
  const through = dataSourceFromResource(str(data.through));
  if (through && (!fromColumns.length || !toColumns.length)) {
    const side = !fromColumns.length ? 'from' : 'to';
    warnings.push(
        `relationship '${name}': the ${RELATIONSHIP_TYPE_ID} aspect names a ` +
        `'through' table but no column on the ${side} end; the relationship ` +
        `is skipped`);
    return undefined;
  }

  const relationship: Relationship = {
    name,
    source: {entity: from, columns: fromColumns},
    destination: {entity: to, columns: toColumns},
  };
  if (through) {
    relationship.through = through;
    relationship.keys = stringList(data.keys);
    const fields = asArray(data.fields)
                       .map(f => readField(f))
                       .filter((f): f is Field => f !== undefined);
    if (fields.length) relationship.fields = fields;
  }
  const description = entry.entrySource?.description;
  if (description !== undefined && description !== '') {
    relationship.description = description;
  }
  const instructions = str(data.instructions);
  if (instructions) relationship.aiContext = {instructions} as AiContext;
  return relationship;
}

// One edge property from its aspect record. A record with no name is dropped: a
// nameless field cannot be referenced and would not survive a reload.
function readField(f: any): Field|undefined {
  const name = str(f?.name);
  if (!name) return undefined;
  const field: Field = {name};
  const expression = str(f?.expression);
  if (expression) field.expression = expression;
  const dataType = str(f?.dataType);
  if ((DATA_TYPES as readonly string[]).includes(dataType)) {
    field.type = dataType as DataType;
  }
  const description = str(f?.description);
  if (description) field.description = description;
  return field;
}


// ---------------------------------------------------------------------------
// Local helpers (see the file header on why they are not shared).
// ---------------------------------------------------------------------------

// The relationship aspect's `data` from an entry, matched by the aspect key's
// `.semantic-relationship` suffix or the aspectType's
// `/aspectTypes/semantic-relationship` suffix, so it is found whichever project
// the type was provisioned in.
function relationshipAspectDataOf(entry: Entry): Record<string, any> {
  for (const [key, aspect] of Object.entries(entry.aspects ?? {})) {
    if (key.endsWith(`.${RELATIONSHIP_TYPE_ID}`) ||
        aspect.aspectType?.endsWith(`/aspectTypes/${RELATIONSHIP_TYPE_ID}`)) {
      return aspect.data ?? {};
    }
  }
  return {};
}

// The dotted `project.dataset.table` form of a stored linked resource, the
// inverse of knowledge_catalog.resourcePath. Anything that is not a BigQuery
// table URI comes back as it was stored.
function dataSourceFromResource(resource: string): string {
  const value = resource.trim();
  const m = value.match(
      /^\/\/bigquery\.googleapis\.com\/projects\/([^/]+)\/datasets\/([^/]+)\/tables\/([^/]+)$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : value;
}

// Entry ids allow letters, numbers, underscores, hyphens, and periods.
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// The id segment of a full entry resource name.
function idOf(name: string): string {
  return name.split('/').pop() ?? name;
}

// Drops undefined-valued keys so the emitted aspect (and its golden) only shows
// fields the model actually set.
function compact<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

// The non-empty strings of an array value, dropping non-string and empty
// members so a degenerate '' does not round-trip.
function stringList(value: any): string[] {
  return asArray(value).filter(
      (s): s is string => typeof s === 'string' && s !== '');
}

function str(value: any): string {
  return typeof value === 'string' ? value : '';
}

function nonEmpty<T>(list: T[]): T[]|undefined {
  return list.length ? list : undefined;
}
