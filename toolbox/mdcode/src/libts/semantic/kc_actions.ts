// How a model's ACTIONS are encoded in Knowledge Catalog.
//
// An action is published exactly the way a metric is: one entry per action,
// parented to the model anchor, carrying one aspect that holds the executor and
// the typed parameters. What differs is the type. Every other construct has a
// built-in system type, and an action does not, so it uses the custom
// `semantic-action` pair DECLARED IN kc_custom_types.ts and created there by
// `kcmd init --semantic-model`. That file is the list of what is custom; this
// one is only the encoding that fills the aspect.
//
// The custom pair is what makes an action explicit in the catalog. A search can
// tell an action apart from anything else by its entry type, and the aspect's
// fields are typed and queryable rather than prose a reader has to interpret.
//
// WHEN A BUILT-IN ACTION TYPE SHIPS, follow the instructions at the top of
// kc_custom_types.ts. Nothing in this file changes: the readers below match a
// type by its id suffix, so they do not care which project it lives in.
//
// The call sites are `knowledge_catalog.ts` (emit the entries),
// `kc_converter.ts` (read them back), and `pull_kc.ts` (hydrate the aspect).
//
// `instructions` rides the action's own aspect rather than the built-in
// `guidelines` aspect that an entity or metric uses. A pull derives which
// aspect types to hydrate from the project the ENTRY type lives in, so an
// action entry, whose type is custom and therefore in the destination project,
// would ask for a `guidelines` aspect type that only exists under
// `dataplex-types`. Keeping the field on the action's own aspect keeps the
// whole encoding inside the one type kc_custom_types.ts provisions.
//
// The helpers at the bottom duplicate a few lines from the modules above on
// purpose. This module imports only the IR, the entry shape and the type
// registry, so it can be swapped or deleted as a unit.

import {Entry} from '../gcp/dataplex';

import {Action, ActionParameter, AffectedConcept, AiContext, CONCEPT_OPERATIONS, ConceptOperation, DATA_TYPES, Executor, SemanticModel} from './ir';
import {ACTION_TYPE_ID, customAspectKey, customAspectTypeName, customEntryTypeName} from './kc_custom_types';

// Full resource name of the action entry type for a destination.
export function actionEntryTypeName(dest: {project: string}): string {
  return customEntryTypeName(ACTION_TYPE_ID, dest);
}

// Full resource name of the action aspect type for a destination.
export function actionAspectTypeName(dest: {project: string}): string {
  return customAspectTypeName(ACTION_TYPE_ID, dest);
}

// Aspect-map key: the `project.location.type` reference form the client keys an
// entry's aspects by.
export function actionAspectKey(dest: {project: string}): string {
  return customAspectKey(ACTION_TYPE_ID, dest);
}


// ---------------------------------------------------------------------------
// Write side: the IR -> one entry per action.
// ---------------------------------------------------------------------------

// What the emitter supplies so this file need not rebuild entry names or repeat
// the id-collision bookkeeping it already does for entities and metrics.
export interface ActionEmitContext {
  // The destination project, which is where the custom types live.
  project: string;
  // Full entry resource name for an entry id (Namer.entry).
  entry(entryId: string): string;
  // Full entry resource name of the model anchor, the parent of every action.
  anchor: string;
  // Reserves an entry id, returning false when it collides with one already
  // emitted (knowledge_catalog.claim).
  claim(entryId: string, label: string): boolean;
  // Names of the entities this push actually publishes an entry for. An
  // abstract entity, or one a binding profile pruned, is absent, so a
  // parameter typed by it would name an entry that does not exist.
  publishedEntities: Set<string>;
}

// The entry id of one action: `<model>.actions.<name>`, alongside
// `<model>.entities.<name>` and `<model>.metrics.<name>`.
export function actionEntryId(modelId: string, actionName: string): string {
  return `${modelId}.actions.${slug(actionName)}`;
}

// The entry-id prefix a model's actions occupy, so delete reconciliation
// removes the entry of an action dropped from the model.
export function actionOwnedPrefix(modelId: string): string {
  return `${modelId}.actions.`;
}

/**
 * One entry per action, to append to the model's entries.
 *
 * Empty when the model declares no actions, so a model without actions is
 * unchanged from before actions existed. Warns once when it is non-empty:
 * actions reach Knowledge Catalog and nowhere else, which is worth saying out
 * loud on a push that also deploys a graph.
 */
export function actionEntries(
    model: SemanticModel, modelId: string, ctx: ActionEmitContext,
    warnings: string[]): Entry[] {
  const actions = model.actions ?? [];
  if (!actions.length) return [];

  // A relationship is a perfectly good `affects` concept but is never in
  // publishedEntities, so the check below reads the model's own edges for it.
  // Pruning drops a whole relationship from the model, so a dropped one is
  // absent from this set for the same reason a dropped entity is absent from
  // publishedEntities.
  const relationshipNames =
      new Set((model.relationships ?? []).map(r => r.name));

  const entries: Entry[] = [];
  for (const action of actions) {
    const id = actionEntryId(modelId, action.name);
    if (!ctx.claim(id, `action '${action.name}'`)) continue;
    // A parameter typed by an entity this push does not publish leaves the
    // catalog naming an entity it has no entry for, and a later pull cannot
    // tell that the type was an entity rather than a misspelled scalar.
    for (const p of action.parameters ?? []) {
      if (p.isEntityRef && !ctx.publishedEntities.has(p.type)) {
        warnings.push(
            `model '${model.name}': action '${action.name}' parameter ` +
            `'${p.name}' refers to entity '${p.type}', which this push does ` +
            `not publish (abstract or unavailable), so a pull will not ` +
            `recover it as an entity reference.`);
      }
    }
    // The same hazard for the concepts the action declares it changes. The
    // entry is still published -- the action does change that concept, and
    // dropping the claim would understate the blast radius -- but the catalog
    // then names a concept it has no entry for, and pulling that model and
    // pushing it unpruned fails hard on the same name. Say it where the
    // divergence is created rather than two commands later.
    for (const affected of action.affects ?? []) {
      if (ctx.publishedEntities.has(affected.concept)) continue;
      if (relationshipNames.has(affected.concept)) continue;
      warnings.push(
          `model '${model.name}': action '${action.name}' affects ` +
          `'${affected.concept}', which this push does not publish ` +
          `(abstract or unavailable), so the catalog records a blast radius ` +
          `naming a concept it has no entry for.`);
    }
    entries.push({
      name: ctx.entry(id),
      entryType: actionEntryTypeName(ctx),
      parentEntry: ctx.anchor,
      entrySource: compact({
                     displayName: action.name,
                     description: action.description,
                   }) as Entry['entrySource'],
      aspects: {
        [actionAspectKey(ctx)]: {
          aspectType: actionAspectTypeName(ctx),
          data: actionAspectData(action),
        },
      },
    });
  }
  // Counted from what was emitted rather than from the model, so a name
  // collision that skipped an action does not inflate the number.
  if (entries.length) warnings.push(
      `model '${model.name}': ${entries.length} action(s) published as ` +
      `${ACTION_TYPE_ID} entries (Knowledge Catalog is the only system an ` +
      `action reaches).`);
  return entries;
}

// The aspect payload for one action: the executor flattened to the fields of
// its kind, the typed parameters, the constraints that gate it, what it
// changes, and any AI instructions. Guards are the constraint NAMES, matching
// the sibling `semantic-constraint` entries by display name, so a reader
// holding one action entry can find the rules it is checked against; an
// an affected concept names an entity or relationship entry the same way.
function actionAspectData(action: Action): Record<string, any> {
  return compact({
    ...(action.executor ? executorData(action.executor) : {}),
    parameters: action.parameters.map(
        p => compact({name: p.name, type: p.type, isEntityRef: p.isEntityRef})),
    guards: action.guards?.length ? action.guards : undefined,
    affects: action.affects?.length ? action.affects.map(affectedConceptData) :
                                      undefined,
    instructions: action.aiContext?.instructions || undefined,
  });
}

// One affected concept as its aspect record: exactly the three fields the IR
// carries, so
// the round-trip is a rename away from an identity.
function affectedConceptData(affected: AffectedConcept): Record<string, any> {
  return compact({
    concept: affected.concept,
    operation: affected.operation,
    fields: affected.fields?.length ? [...affected.fields] : undefined,
  });
}

// The executor's kind plus the two coordinates that kind uses. Only the fields
// of the live kind are set, so the aspect never shows blanks for the others.
function executorData(ex: Executor): Record<string, any> {
  switch (ex.kind) {
    case 'mcp':
      return {
        executorKind: 'mcp',
        mcpServer: ex.mcp.server,
        mcpTool: ex.mcp.tool,
      };
    case 'rest':
      return {
        executorKind: 'rest',
        restEndpoint: ex.rest.endpoint,
        restMethod: ex.rest.method,
      };
    case 'grpc':
      return {
        executorKind: 'grpc',
        grpcService: ex.grpc.service,
        grpcMethod: ex.grpc.method,
      };
    case 'sql':
      // The statements are published verbatim. A consumer that only routes on
      // the kind can ignore them; one that wants to know what the action
      // actually writes -- a review engine deciding whether the declared
      // `affects` matches the write -- has the text without a second lookup.
      return {
        executorKind: 'sql',
        sqlStatements: [...ex.sql.statements],
      };
  }
}


// ---------------------------------------------------------------------------
// Read side: an action entry -> the IR.
// ---------------------------------------------------------------------------

// True when an entry is one of a model's actions, matched by the entry type's
// id suffix so the project the type lives in need not be known -- which is what
// lets a pull keep working when the custom type is replaced by a built-in one.
export function isActionEntry(entry: Entry): boolean {
  return entry.entryType?.endsWith(`/entryTypes/${ACTION_TYPE_ID}`) ?? false;
}

// The aspect type resource names to hydrate for an action entry. Named through
// the entry type's own project so the pull follows the type wherever it lives.
export function actionAspectTypes(entryTypeBase: string): string[] {
  return [`${entryTypeBase}/aspectTypes/${ACTION_TYPE_ID}`];
}

/**
 * Recovers one action from its entry, the inverse of actionEntries.
 *
 * `isEntityRef` is re-derived against the entity names this pull actually
 * recovered (as the loader does) rather than trusted from the stored aspect,
 * so it stays consistent with the model actually pulled. An affected concept
 * needs no
 * such treatment: it stores only what the author wrote.
 *
 * An entry with NO executor recovers as an action with none: that is a legal
 * published state, not damage. An entry whose executor names a kind but lacks
 * the coordinates that kind needs is malformed, and returns undefined with a
 * warning, so one bad entry degrades itself rather than the pull.
 */
export function readAction(
    entry: Entry, entityNames: string[], warnings: string[]): Action|undefined {
  const name = entry.entrySource?.displayName || idOf(entry.name);
  const data = actionAspectDataOf(entry);
  // No kind at all is an action no binding performed, which round-trips as it
  // was published. A kind whose coordinates are missing is damage.
  const declaresExecutor =
      typeof data.executorKind === 'string' && data.executorKind.trim() !== '';
  const executor = readExecutor(data);
  if (declaresExecutor && !executor) {
    warnings.push(
        `action '${name}': the ${ACTION_TYPE_ID} aspect has no usable ` +
        `executor; the action is skipped`);
    return undefined;
  }
  const entitySet = new Set(entityNames);
  const parameters =
      asArray(data.parameters)
          .map((p: any) => readParameter(p, entitySet, name, warnings))
          .filter((p): p is ActionParameter => p !== undefined);

  const action: Action = {name, parameters};
  if (executor) action.executor = executor;
  // Guard names round-trip verbatim. A name whose constraint is not part of
  // this pull is kept rather than dropped, because dropping it here would
  // silently rewrite the author's model. It is not kept in silence:
  // kc_converter warns once it has both lists in hand, and push-side validate
  // rejects it.
  //
  // A REPEATED name is the exception, because the loader rejects one outright:
  // keeping it would hand back a document that cannot be reloaded. A duplicate
  // guard checks the same constraint twice, so dropping it loses no meaning.
  const guards: string[] = [];
  for (const g of asArray(data.guards)) {
    if (typeof g !== 'string' || g === '') continue;
    if (guards.includes(g)) {
      warnings.push(
          `action '${name}': the ${ACTION_TYPE_ID} aspect repeats guard ` +
          `'${g}'; the duplicate is dropped so the document still loads`);
      continue;
    }
    guards.push(g);
  }
  if (guards.length) action.guards = guards;

  // Affected concepts, deduplicated on the pair the loader rejects a repeat
  // of, for the
  // same reason a repeated guard is dropped here: keeping it would hand back a
  // document that cannot be reloaded.
  const affects: AffectedConcept[] = [];
  const seen = new Set<string>();
  for (const raw of asArray(data.affects)) {
    const affected = readAffectedConcept(raw, name, warnings);
    if (!affected) continue;
    const key = `${affected.concept}/${affected.operation ?? ''}`;
    if (seen.has(key)) {
      warnings.push(
          `action '${name}': the ${ACTION_TYPE_ID} aspect repeats the entry ` +
          `on '${affected.concept}'; the duplicate is dropped so the ` +
          `document still loads`);
      continue;
    }
    seen.add(key);
    affects.push(affected);
  }
  if (affects.length) action.affects = affects;

  const description = entry.entrySource?.description;
  if (description !== undefined && description !== '')
    action.description = description;
  if (typeof data.instructions === 'string' && data.instructions !== '')
    action.aiContext = {instructions: data.instructions} as AiContext;
  return action;
}

// One action parameter from its aspect record, re-deriving isEntityRef against
// the model's entities (a scalar datatype otherwise). A record missing a name is
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

// One affected concept from its aspect record, the inverse of
// affectedConceptData. A record with no concept is dropped: it names nothing,
// so there is nothing to recover.
//
// Unlike readParameter, this resolves nothing against the pulled model. It
// could not do so honestly if it tried: a pull recovers relationships from the
// schema-join entry links, so a many-to-many edge is never among them, and
// every entry naming one would look unresolvable on a model that is perfectly
// well-formed. Nothing here needs the answer, so nothing asks.
function readAffectedConcept(
    raw: any, actionName: string,
    warnings: string[]): AffectedConcept|undefined {
  const concept = typeof raw?.concept === 'string' ? raw.concept : '';
  if (!concept) return undefined;
  const affected: AffectedConcept = {concept};

  if ((CONCEPT_OPERATIONS as readonly string[]).includes(raw.operation)) {
    affected.operation = raw.operation as ConceptOperation;
  } else if (raw.operation !== undefined && raw.operation !== '') {
    // An aspect edited by hand can carry anything. Dropping the operation
    // keeps the entry (the blast radius is still true) and says why.
    warnings.push(
        `action '${actionName}': affects '${concept}' with an unknown ` +
        `operation '${raw.operation}'; recovered with the operation dropped`);
  }

  const fields: string[] = [];
  for (const f of asArray(raw.fields)) {
    if (typeof f !== 'string' || f === '' || fields.includes(f)) continue;
    fields.push(f);
  }
  if (fields.length) affected.fields = fields;
  return affected;
}

// The IR executor from the aspect's flat fields, the inverse of executorData.
// Returns undefined when the kind is unknown or either of its coordinates is
// missing.
function readExecutor(data: Record<string, any>): Executor|undefined {
  // A coordinate must be a present, NON-BLANK string. An aspect edited by hand
  // can carry an empty one; treat that as malformed so the reader rejects it
  // exactly as push-side validate would, rather than recovering an action the
  // next push cannot deploy.
  const str = (v: any): v is string => typeof v === 'string' && v.trim() !== '';
  switch (data.executorKind) {
    case 'mcp':
      if (str(data.mcpServer) && str(data.mcpTool))
        return {kind: 'mcp', mcp: {server: data.mcpServer, tool: data.mcpTool}};
      return undefined;
    case 'rest':
      if (str(data.restEndpoint) && str(data.restMethod))
        return {
          kind: 'rest',
          rest: {endpoint: data.restEndpoint, method: data.restMethod}
        };
      return undefined;
    case 'grpc':
      if (str(data.grpcService) && str(data.grpcMethod))
        return {
          kind: 'grpc',
          grpc: {service: data.grpcService, method: data.grpcMethod}
        };
      return undefined;
    case 'sql': {
      // Unlike the other three, the coordinate here is a list. A blank entry is
      // dropped rather than kept: it is not a statement, and validate would
      // reject the pulled model for carrying it. An executor left with no
      // statement at all is malformed, like a missing coordinate elsewhere.
      const statements = Array.isArray(data.sqlStatements) ?
          data.sqlStatements.filter(str).map((s: string) => s.trim()) :
          [];
      if (statements.length) return {kind: 'sql', sql: {statements}};
      return undefined;
    }
    default:
      return undefined;
  }
}


// ---------------------------------------------------------------------------
// Local helpers (see the file header on why they are not shared).
// ---------------------------------------------------------------------------

// The action aspect's `data` from an entry, matched by the aspect key's
// `.semantic-action` suffix or the aspectType's `/aspectTypes/semantic-action`
// suffix, so it is found whichever project the type was provisioned in.
function actionAspectDataOf(entry: Entry): Record<string, any> {
  for (const [key, aspect] of Object.entries(entry.aspects ?? {})) {
    if (key.endsWith(`.${ACTION_TYPE_ID}`) ||
        aspect.aspectType?.endsWith(`/aspectTypes/${ACTION_TYPE_ID}`)) {
      return aspect.data ?? {};
    }
  }
  return {};
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
