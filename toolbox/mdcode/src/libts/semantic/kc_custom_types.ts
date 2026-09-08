// The entry and aspect types kcmd creates itself.
//
// READ THIS FIRST IF YOU OWN DATAPLEX TYPES. Everything a semantic model
// publishes maps to a BUILT-IN system type under
// `projects/dataplex-types/locations/global`: a model, an entity and a metric
// each get an entry (`semantic-model` / `semantic-entity` / `semantic-metric`),
// a relationship becomes a `schema-join` entry link, and the built-in `schema`
// and `guidelines` aspects carry the rest. The types listed in CUSTOM_TYPES
// below are the exceptions. Dataplex has no built-in equivalent for them, so
// `kcmd init --semantic-model` creates them in the destination project instead.
// Each record here is a request: please make this one built-in.
//
// TO MAKE ONE BUILT-IN. Publish an entry type and an aspect type under
// `dataplex-types/global` with the same id and the same metadata template as
// the record below, then delete that record from CUSTOM_TYPES and name the
// type through `Namer.typeName` in knowledge_catalog.ts, the way every built-in
// type is already named. Nothing else moves: entry ids, entry shape, the owned
// prefix for delete reconciliation, and the readers all match a type by its id
// suffix, so they do not care which project it lives in.
//
// TO ADD A NEW CUSTOM TYPE. Append a record. Provisioning, naming and the init
// wiring are generic over this list, so no other file in this directory needs
// to change; what does need writing is the encoding that fills the aspect, the
// way kc_actions.ts does for `semantic-action` and kc_relationships.ts does for
// `semantic-relationship`.
//
// A CUSTOM TYPE IS ONE ENTRY TYPE PLUS ONE ASPECT TYPE that share an id, the
// way the built-in `semantic-metric` entry type and aspect type share theirs.
// The entry type requires its own aspect type, so an entry of that type cannot
// exist without the aspect that gives it meaning. A future type that needs a
// different arrangement is a reason to generalize this file rather than to add
// a second mechanism elsewhere.
//
// TEMPLATES ARE APPEND-ONLY. Dataplex rejects a backwards-incompatible template
// change, so a new field must be APPENDED with a fresh index. Renumbering or
// removing an existing field breaks the update for every project that already
// provisioned the type.

import {AspectType, CatalogClient, EntryType} from '../gcp/dataplex';

// A type kcmd provisions because no built-in one exists yet.
export interface CustomType {
  // Shared by the entry type and the aspect type.
  id: string;
  // The entry type, minus the required-aspect list: it always requires exactly
  // this record's aspect type, which provisionCustomTypes fills in.
  entryType: Omit<EntryType, 'name'|'requiredAspects'>;
  // The aspect type, including the metadata template that gives the entry its
  // typed, queryable fields.
  aspectType: Omit<AspectType, 'name'>;
}

// The id of the action type. An action is a write operation defined on a
// semantic model; kc_actions.ts holds the encoding that fills its aspect.
export const ACTION_TYPE_ID = 'semantic-action';

// The aspect that carries an action's mechanics.
//
// The executor is FLATTENED rather than nested one record per kind: an aspect
// holds exactly one executor, and a flat record shows the reader which one at a
// glance instead of three sibling records of which two are empty. `parameters`
// mirrors the model's own parameter list, including the derived `isEntityRef`
// so a consumer that has not loaded the model can still tell an object
// reference from a scalar.
const ACTION_ASPECT_TYPE: Omit<AspectType, 'name'> = {
  displayName: 'Semantic Action',
  description:
      'A write operation defined on a semantic model: how it is executed, ' +
      'and the inputs it takes.',
  metadataTemplate: {
    name: ACTION_TYPE_ID,
    type: 'record',
    recordFields: [
      {
        index: 1,
        name: 'executorKind',
        type: 'string',
        constraints: {required: true},
        annotations: {
          displayName: 'Executor Kind',
          description:
              'How the action is executed: `mcp`, `rest`, or `grpc`. The ' +
              'fields for that kind, and only those, are set.',
        },
      },
      {
        index: 2,
        name: 'mcpServer',
        type: 'string',
        annotations: {
          displayName: 'MCP Server',
          description: 'Resource name of the MCP server hosting the tool.',
        },
      },
      {
        index: 3,
        name: 'mcpTool',
        type: 'string',
        annotations: {
          displayName: 'MCP Tool',
          description: 'Name of the tool to call on the MCP server.',
        },
      },
      {
        index: 4,
        name: 'restEndpoint',
        type: 'string',
        annotations: {
          displayName: 'REST Endpoint',
          description: 'URL the request is sent to.',
        },
      },
      {
        index: 5,
        name: 'restMethod',
        type: 'string',
        annotations: {
          displayName: 'REST Method',
          description: 'HTTP method, for example POST.',
        },
      },
      {
        index: 6,
        name: 'grpcService',
        type: 'string',
        annotations: {
          displayName: 'gRPC Service',
          description: 'Fully qualified name of the gRPC service.',
        },
      },
      {
        index: 7,
        name: 'grpcMethod',
        type: 'string',
        annotations: {
          displayName: 'gRPC Method',
          description: 'Method on the gRPC service.',
        },
      },
      {
        index: 8,
        name: 'parameters',
        type: 'array',
        arrayItems: {
          name: 'parameter',
          type: 'record',
          recordFields: [
            {
              index: 1,
              name: 'name',
              type: 'string',
              constraints: {required: true},
              annotations: {displayName: 'Name'},
            },
            {
              index: 2,
              name: 'type',
              type: 'string',
              constraints: {required: true},
              annotations: {
                displayName: 'Type',
                description:
                    'The authored type: an entity name, or a scalar datatype.',
              },
            },
            {
              index: 3,
              name: 'isEntityRef',
              type: 'bool',
              annotations: {
                displayName: 'Is Entity Reference',
                description:
                    'True when `type` names an entity, so the parameter ' +
                    'refers to an object rather than carrying a value.',
              },
            },
          ],
        },
        annotations: {
          displayName: 'Parameters',
          description:
              'The inputs the action takes, each typed by the ontology.',
        },
      },
      {
        index: 9,
        name: 'instructions',
        type: 'string',
        annotations: {
          displayName: 'Instructions',
          description:
              'Guidance for AI consumers (the action\'s ai_context ' +
              'instructions).',
        },
      },
    ],
  },
};

// The id of the relationship type. kc_relationships.ts holds the encoding that
// fills its aspect.
export const RELATIONSHIP_TYPE_ID = 'semantic-relationship';

// The aspect that carries a relationship -- any relationship, one-to-many and
// many-to-many alike.
//
// The built-in `schema-join` entry link already models a join, but only a direct
// foreign key: it holds ONE source/target column pair. A many-to-many edge is
// two joins through a third table, so it does not fit, and a custom entry LINK
// type is not available -- Dataplex accepts only its own link types. schema-join
// also has no field for the relationship's own name, which is why a link's name
// survives only in its lowercased, hyphenated id. That leaves an entry, which is
// what this type is: one per relationship, parented to the model anchor beside
// the entities and metrics. A foreign-key edge still emits its schema-join link
// as well, for the Dataplex surfaces that already read links.
//
// The endpoints are recorded as entity NAMES rather than as entry references
// because the two entity entries are already the link endpoints a consumer
// resolves by name everywhere else in this encoding (a metric's `entity`, an
// action parameter's `type`), and a name survives the project-number
// normalization that rewrites resource names on the way back.
//
// `through`, `keys` and `fields` are set only on a many-to-many edge: it is the
// one shape with a table of its own, hence a key of its own and properties --
// an enrollment's grade -- belonging to neither endpoint. They ride here rather
// than in the built-in `schema` aspect for the same reason `instructions` does
// not use `guidelines`: a pull derives which aspect types to hydrate from the
// project the ENTRY type lives in, and a custom entry type lives in the
// destination project, where no built-in aspect type exists.
const RELATIONSHIP_ASPECT_TYPE: Omit<AspectType, 'name'> = {
  displayName: 'Semantic Relationship',
  description:
      'A relationship in a semantic model: the two entities it connects, the ' +
      'columns that reach them, and -- when it is many-to-many -- the table ' +
      'it runs through.',
  metadataTemplate: {
    name: RELATIONSHIP_TYPE_ID,
    type: 'record',
    recordFields: [
      {
        index: 1,
        name: 'fromEntity',
        type: 'string',
        constraints: {required: true},
        annotations: {
          displayName: 'From Entity',
          description:
              'Name of the entity at the source end. It is the SOURCE of the ' +
              'edge in a property graph.',
        },
      },
      {
        index: 2,
        name: 'toEntity',
        type: 'string',
        constraints: {required: true},
        annotations: {
          displayName: 'To Entity',
          description:
              'Name of the entity at the destination end. It is the ' +
              'DESTINATION of the edge in a property graph.',
        },
      },
      {
        index: 3,
        name: 'through',
        type: 'string',
        annotations: {
          displayName: 'Through Table',
          description:
              'Resource name of the table a many-to-many edge runs through, ' +
              'holding one row per (from, to) pair. Empty on a foreign-key ' +
              'edge, which has no table of its own, and on a model with no ' +
              'physical binding.',
        },
      },
      {
        index: 4,
        name: 'keys',
        type: 'array',
        arrayItems: {name: 'key', type: 'string'},
        annotations: {
          displayName: 'Keys',
          description:
              'The edge\'s own key columns, on the table it runs through. ' +
              'Empty on a foreign-key edge, which is keyed by its source ' +
              'entity.',
        },
      },
      {
        index: 5,
        name: 'fromColumns',
        type: 'array',
        arrayItems: {name: 'column', type: 'string'},
        annotations: {
          displayName: 'From Columns',
          description:
              'Columns reaching the from entity: on that entity\'s own table ' +
              'for a foreign-key edge, on the through table for a ' +
              'many-to-many one.',
        },
      },
      {
        index: 6,
        name: 'toColumns',
        type: 'array',
        arrayItems: {name: 'column', type: 'string'},
        annotations: {
          displayName: 'To Columns',
          description:
              'Columns reaching the to entity: on that entity\'s own table ' +
              'for a foreign-key edge, on the through table for a ' +
              'many-to-many one.',
        },
      },
      {
        index: 7,
        name: 'fields',
        type: 'array',
        arrayItems: {
          name: 'field',
          type: 'record',
          recordFields: [
            {
              index: 1,
              name: 'name',
              type: 'string',
              constraints: {required: true},
              annotations: {displayName: 'Name'},
            },
            {
              index: 2,
              name: 'dataType',
              type: 'string',
              annotations: {
                displayName: 'Data Type',
                description: 'The field\'s logical datatype.',
              },
            },
            {
              index: 3,
              name: 'description',
              type: 'string',
              annotations: {displayName: 'Description'},
            },
            {
              index: 4,
              name: 'expression',
              type: 'string',
              annotations: {
                displayName: 'Expression',
                description:
                    'The through-table column the field binds to. Empty on ' +
                    'a model with no physical binding.',
              },
            },
          ],
        },
        annotations: {
          displayName: 'Fields',
          description:
              'Properties of a many-to-many edge itself, belonging to ' +
              'neither endpoint (an enrollment\'s grade).',
        },
      },
      {
        index: 8,
        name: 'instructions',
        type: 'string',
        annotations: {
          displayName: 'Instructions',
          description:
              'Guidance for AI consumers (the relationship\'s ai_context ' +
              'instructions).',
        },
      },
    ],
  },
};

// Every type kcmd provisions. This list is the whole of what is custom.
export const CUSTOM_TYPES: readonly CustomType[] = [
  {
    id: ACTION_TYPE_ID,
    entryType: {
      displayName: 'Semantic Action',
      description: 'A write operation defined on a semantic model.',
    },
    aspectType: ACTION_ASPECT_TYPE,
  },
  {
    id: RELATIONSHIP_TYPE_ID,
    entryType: {
      displayName: 'Semantic Relationship',
      description: 'A relationship between two entities of a semantic model.',
    },
    aspectType: RELATIONSHIP_ASPECT_TYPE,
  },
];

// Custom types are provisioned at `global` so an entry group in any region can
// reference them, matching where the built-in system types live.
const CUSTOM_TYPE_LOCATION = 'global';

// True when kcmd still provisions this id. It turns false the moment the type
// is deleted from CUSTOM_TYPES, which is how the rest of the code learns that a
// built-in has taken over.
export function isCustomType(id: string): boolean {
  return CUSTOM_TYPES.some(t => t.id === id);
}

// Where a destination's custom types live: the destination project itself,
// because `kcmd init` is what creates them there.
export function customTypeHome(dest: {project: string}):
    {project: string; location: string} {
  return {project: dest.project, location: CUSTOM_TYPE_LOCATION};
}

// Full resource name of a custom entry type in a destination.
export function customEntryTypeName(
    id: string, dest: {project: string}): string {
  const home = customTypeHome(dest);
  return `projects/${home.project}/locations/${home.location}/entryTypes/${id}`;
}

// Full resource name of a custom aspect type in a destination.
export function customAspectTypeName(
    id: string, dest: {project: string}): string {
  const home = customTypeHome(dest);
  return `projects/${home.project}/locations/${home.location}/aspectTypes/${
      id}`;
}

// Aspect-map key: the `project.location.type` reference form the client keys an
// entry's aspects by (see dataplex._nameToTypeRef).
export function customAspectKey(id: string, dest: {project: string}): string {
  const home = customTypeHome(dest);
  return `${home.project}.${home.location}.${id}`;
}

// What provisioning produced. `error` is a failure the caller must not ignore.
// `denied` is the narrower case of lacking permission to create a type, which
// is reported and survived: these types back optional constructs, and a project
// whose models use none of them never needs them.
export interface ProvisionResult {
  error?: string;
  denied?: string;
  // Problems that left an existing type as it was without stopping init.
  warnings?: string[];
}

/**
 * Creates every type in CUSTOM_TYPES in a destination.
 *
 * Called from `kcmd init --semantic-model`, beside the entry group it already
 * provisions, so a push still writes nothing but entries. Each aspect type is
 * created and then, if it is already there, patched: a project provisioned by
 * an earlier version of kcmd holds an older template, and pushing a field that
 * template lacks fails with an opaque parsing error. Dataplex rejects a
 * backwards-incompatible change, so the patch only ever adds appended fields.
 *
 * Stops at the first hard failure, and returns as soon as one type is refused
 * for lack of permission, since the same caller will be refused the next one.
 */
export async function provisionCustomTypes(
    cat: CatalogClient, dest: {project: string}): Promise<ProvisionResult> {
  const warnings: string[] = [];
  for (const type of CUSTOM_TYPES) {
    const result = await provisionOne(cat, dest, type);
    if (result.warnings) warnings.push(...result.warnings);
    if (result.error || result.denied)
      return {...result, warnings: warnings.length ? warnings : undefined};
  }
  return warnings.length ? {warnings} : {};
}

// One custom type: its aspect type, then the entry type that requires it.
async function provisionOne(
    cat: CatalogClient, dest: {project: string},
    type: CustomType): Promise<ProvisionResult> {
  const home = customTypeHome(dest);

  // Creating a type needs permissions that publishing entries does not. A
  // caller who lacks them can still init, push and pull every model that uses
  // none of these types, so the refusal is reported rather than fatal.
  const denial = (what: string, status: number, message?: string):
      ProvisionResult|undefined => status === 403 ?
      {
        denied: `no permission to create ${what} in project '${
            home.project}' (${message || status}); ` +
            `models that need it cannot be pushed until it exists`
      } :
      undefined;

  const warnings: string[] = [];
  const aspectLabel = `aspect type '${type.id}'`;
  const aspect = await cat.createAspectType(
      home.project, home.location, type.id, type.aspectType);
  if (aspect.status === 409) {
    const upd = await cat.updateAspectType(
        home.project, home.location, type.id, type.aspectType,
        ['description', 'display_name', 'metadata_template']);
    const refused = denial(aspectLabel, upd.status, upd.message);
    if (refused) return refused;
    // Patching an existing type forward is best effort. An older kcmd run
    // against a project a newer one provisioned asks Dataplex to remove
    // template fields, which it rejects, and the type already there is the one
    // every published entry depends on. Leaving it alone and saying so beats
    // aborting an init that has already created the entry group, and a push
    // that needs a field the older template lacks reports that itself.
    const reason = upd.status !== 200 ?
        `${upd.message || upd.status}` :
        await cat.awaitOperation(upd.result, `updating ${aspectLabel}`);
    if (reason) {
      warnings.push(
          `left the existing ${aspectLabel} in project '${home.project}' ` +
          `unchanged (${reason}); a push that needs a field it does not ` +
          `carry will fail`);
    }
  } else if (aspect.status !== 200) {
    const refused = denial(aspectLabel, aspect.status, aspect.message);
    if (refused) return refused;
    return {
      error: `creating ${aspectLabel}: ${aspect.message || aspect.status}`
    };
  } else {
    // The entry type below names this aspect type in its required aspects, and
    // the server rejects that while the create is still in flight, so the wait
    // is load-bearing rather than tidiness.
    const failed =
        await cat.awaitOperation(aspect.result, `creating ${aspectLabel}`);
    if (failed) return {error: failed};
  }

  // The entry type requires the aspect type above, so it is created second. An
  // existing one is left alone rather than patched: unlike the aspect type it
  // carries no template that grows over time, and its required-aspect list is
  // what an entry already published depends on.
  const entryLabel = `entry type '${type.id}'`;
  const entryType =
      await cat.createEntryType(home.project, home.location, type.id, {
        ...type.entryType,
        requiredAspects: [{type: customAspectTypeName(type.id, dest)}],
      });
  const collected = warnings.length ? {warnings} : {};
  if (entryType.status === 409) return collected;
  const refused = denial(entryLabel, entryType.status, entryType.message);
  if (refused) return {...refused, ...collected};
  if (entryType.status !== 200) {
    return {
      ...collected,
      error: `creating ${entryLabel}: ${entryType.message || entryType.status}`
    };
  }
  // A push may follow immediately, and an entry naming a type that is still
  // being created is rejected the same way, so wait here too.
  const failed =
      await cat.awaitOperation(entryType.result, `creating ${entryLabel}`);
  return failed ? {...collected, error: failed} : collected;
}
