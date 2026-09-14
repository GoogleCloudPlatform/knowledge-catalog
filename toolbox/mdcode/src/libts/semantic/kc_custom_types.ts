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
// way kc_actions.ts does for `semantic-action` and kc_constraints.ts for
// `semantic-constraint`.
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

import {AiContext} from './ir';

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


// ---------------------------------------------------------------------------
// `ai_context`, shared by every custom aspect.
// ---------------------------------------------------------------------------

// The whole of a model element's `ai_context`, as one template field.
//
// Every element in the format carries the same three-part annotation:
// instructions, synonyms, examples. A custom aspect carries all three. Carrying
// a chosen part instead would mean a document that loads cleanly comes back
// from a pull missing fields it declared. The built-in `guidelines` aspect does
// have a home for `instructions` alone, and an element routed there loses the
// other two, but kcmd owns this template and has no reason to inherit that
// limit.
//
// The annotation goes on the custom aspect rather than on a `guidelines` aspect
// beside it, because a pull hydrates aspect types from the project the ENTRY
// type lives in, and `guidelines` is published under `dataplex-types`.
//
// `index` is a parameter because template field indexes are positional and
// append-only (see the header), so each aspect places this field wherever its
// own template has room. `semantic-action` still carries a flat `instructions`
// string at index 9. That type was provisioned before this field existed, and
// renaming a template field is the backwards-incompatible change Dataplex
// rejects, so it moves over by APPENDING this field and retiring that one.
export function aiContextField(index: number): Record<string, any> {
  return {
    index,
    name: 'aiContext',
    type: 'record',
    recordFields: [
      {
        index: 1,
        name: 'instructions',
        type: 'string',
        annotations: {
          displayName: 'Instructions',
          description: 'Free-form guidance for AI consumers.',
        },
      },
      {
        index: 2,
        name: 'synonyms',
        type: 'array',
        arrayItems: {name: 'synonym', type: 'string'},
        annotations: {
          displayName: 'Synonyms',
          description: 'Alternate names for the annotated object.',
        },
      },
      {
        index: 3,
        name: 'examples',
        type: 'array',
        arrayItems: {name: 'example', type: 'string'},
        annotations: {
          displayName: 'Examples',
          description:
              'Example questions or usages illustrating the annotated object.',
        },
      },
    ],
    annotations: {
      displayName: 'AI Context',
      description:
          'The element\'s `ai_context`: guidance, alternate names and ' +
          'examples for AI consumers.',
    },
  };
}

// The aspect value for an `ai_context`. Undefined when it carries nothing, so
// an element without one attaches no empty record and its golden stays quiet.
export function aiContextAspectValue(ai: AiContext|undefined):
    Record<string, any>|undefined {
  if (!ai) return undefined;
  const out: Record<string, any> = {};
  if (ai.instructions) out.instructions = ai.instructions;
  if (ai.synonyms?.length) out.synonyms = [...ai.synonyms];
  if (ai.examples?.length) out.examples = [...ai.examples];
  return Object.keys(out).length ? out : undefined;
}

// The inverse: an `ai_context` from an aspect value, or undefined when there is
// nothing usable in it. Every part is checked rather than trusted, because an
// aspect can be hand-edited in the catalog into a shape the emitter never
// writes.
export function aiContextFromAspect(value: any): AiContext|undefined {
  if (!value || typeof value !== 'object') return undefined;
  const strings = (v: any): string[]|undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((s: any) => typeof s === 'string' && s !== '');
    return out.length ? out : undefined;
  };
  const ai: AiContext = {};
  if (typeof value.instructions === 'string' && value.instructions !== '')
    ai.instructions = value.instructions;
  const synonyms = strings(value.synonyms);
  if (synonyms) ai.synonyms = synonyms;
  const examples = strings(value.examples);
  if (examples) ai.examples = examples;
  return Object.keys(ai).length ? ai : undefined;
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
        // NOT required: an executor is a physical binding, so an action no
        // binding performs here publishes with none. The rest of the record --
        // the parameters, the guards, what it changes -- is the declaration,
        // and that is what the catalog is for.
        index: 1,
        name: 'executorKind',
        type: 'string',
        annotations: {
          displayName: 'Executor Kind',
          description:
              'How the action is executed: `mcp`, `rest`, `grpc`, or `sql`. ' +
              'The fields for that kind, and only those, are set. Absent ' +
              'when no binding supplies an executor.',
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
      {
        index: 10,
        name: 'guards',
        type: 'array',
        arrayItems: {name: 'guard', type: 'string'},
        annotations: {
          displayName: 'Guards',
          description:
              'Names of the constraints that gate this action, each a ' +
              '`semantic-constraint` entry on the same model. They are ' +
              'checked before the action runs.',
        },
      },
      {
        index: 11,
        name: 'affects',
        type: 'array',
        arrayItems: {
          name: 'affectedConcept',
          type: 'record',
          recordFields: [
            {
              index: 1,
              name: 'concept',
              type: 'string',
              constraints: {required: true},
              annotations: {
                displayName: 'Concept',
                description:
                    'The entity or relationship this action changes, by name.',
              },
            },
            {
              index: 2,
              name: 'operation',
              type: 'string',
              annotations: {
                displayName: 'Operation',
                description:
                    'How the concept is changed: `create`, `modify` or ' +
                    '`delete`. The same three apply to an entity and to a ' +
                    'relationship. Absent means unspecified.',
              },
            },
            {
              index: 3,
              name: 'fields',
              type: 'array',
              arrayItems: {name: 'field', type: 'string'},
              annotations: {
                displayName: 'Fields',
                description:
                    'The fields the operation touches, when it touches only ' +
                    'some of them. Absent means the whole instance.',
              },
            },
          ],
        },
        annotations: {
          displayName: 'Affects',
          description:
              'What a call changes: one record per concept -- an entity or ' +
              'a relationship -- the action touches, with the operation and ' +
              'the fields where the model states them. Declared, because an ' +
              'executor is opaque and nothing reading the model can see ' +
              'what it writes.',
        },
      },
      {
        index: 12,
        name: 'sqlStatements',
        type: 'array',
        arrayItems: {name: 'statement', type: 'string'},
        annotations: {
          displayName: 'SQL Statements',
          description:
              'The DML statements a `sql` executor runs, in order, each a ' +
              'single INSERT, UPDATE or DELETE with its values bound as ' +
              '`@parameter` references. Present only for that executor ' +
              'kind: the other three name a system that performs the write ' +
              'and carry no text. A reader with these can check the ' +
              'declared `affects` against the write itself instead of ' +
              'taking it on trust.',
        },
      },
    ],
  },
};


// The id of the constraint type. A constraint is a named invariant over a
// semantic model; kc_constraints.ts holds the encoding that fills its aspect.
export const CONSTRAINT_TYPE_ID = 'semantic-constraint';

// The aspect that carries a constraint's rule.
//
// A constraint states its rule in one of two fields, and neither is required on
// its own because either one alone is a whole rule. `expression` is a boolean
// expression a query can compute. `judgment` is the rule in words, for a rule
// no expression decides -- whether a discount is justified, whether a refund
// reason is plausible -- which a language-model judge settles at review time.
// The push refuses a constraint that states both or neither, so the pair is
// required in the sense that matters and the template cannot say so.
//
// `evaluation` restates which of the two the constraint used. It is derived,
// never authored, and a reader recomputes it from the bodies rather than
// trusting it. It exists so a consumer selecting rules to lower into a store
// CHECK and a consumer selecting rules to hand a judge can each filter on one
// field.
//
// The other two authored fields are the ones every model element carries, and
// they land in different places. `description` rides the entry source, the way
// an action's and a metric's do: a violation quotes it back to the caller as
// the error, which makes it the entry's summary rather than part of the rule.
// `ai_context` rides this aspect whole
// (see aiContextField).
//
// `onViolation` and `severity` ride the aspect rather than the entry source
// because they are machine-readable routing and not prose. They answer
// different questions and are separate fields for that reason: `onViolation` is
// what the engine does about a breach, `severity` is how grave the breach is.
// A `low` rule can still be an absolute refusal, and a `critical` one can be a
// warning because the organization is not ready to block on it. Published
// without `onViolation`, a rule a supervisor may override reads the same as one
// nobody can.
const CONSTRAINT_ASPECT_TYPE: Omit<AspectType, 'name'> = {
  displayName: 'Semantic Constraint',
  description:
      'An invariant over a semantic model: a condition that must hold for ' +
      'every instance of an entity, however that instance was written. The ' +
      'condition is either a boolean expression a query can compute or a ' +
      'rule stated in words for a reader to settle.',
  metadataTemplate: {
    name: CONSTRAINT_TYPE_ID,
    type: 'record',
    recordFields: [
      {
        index: 1,
        name: 'expression',
        type: 'string',
        annotations: {
          displayName: 'Expression',
          description:
              'The invariant, as a boolean expression in the model\'s ' +
              'expression language, for example `Customer.balance >= 0`. ' +
              'Present on a constraint a query can decide; a constraint ' +
              'states `judgment` instead when no expression decides it.',
        },
      },
      aiContextField(2),
      {
        index: 3,
        name: 'onViolation',
        type: 'string',
        annotations: {
          displayName: 'On Violation',
          description:
              'What a violation does to the write that tripped it: ' +
              '`reject` refuses the write and nobody may approve it, ' +
              '`escalate` holds the write for a human decision, `warn` lets ' +
              'it proceed and reports it. Absent means `reject`. `escalate` ' +
              'states that an approver exists, not who they are. A ' +
              'constraint states one condition and this is that ' +
              'condition\'s consequence, so a policy whose conditions end ' +
              'differently is published as several constraints, each with ' +
              'its own word, listed together by an action\'s `guards`; the ' +
              'strictest consequence among the violated ones is what the ' +
              'action does. That combination is what the model states, and ' +
              'no component evaluates a constraint today. A constraint ' +
              'stating `judgment` always states this field, and may state ' +
              'any of the three words.',
        },
      },
      {
        index: 4,
        name: 'severity',
        type: 'string',
        annotations: {
          displayName: 'Severity',
          description:
              'How grave a violation is, for ranking and reporting: ' +
              '`critical`, `high`, `medium` or `low`. Independent of what ' +
              'the engine does about it, which is `onViolation`. Absent ' +
              'means the model did not say; there is no default.',
        },
      },
      {
        index: 5,
        name: 'judgment',
        type: 'string',
        annotations: {
          displayName: 'Judgment',
          description:
              'The invariant in words, for a rule no boolean expression ' +
              'decides, for example `A discount over 30% must be justified ' +
              'by the reason given in Order.discount_reason`. A ' +
              'language-model judge settles it against the proposed write at ' +
              'review time. Field names are written model-qualified so a ' +
              'reader can resolve them. States one condition, as what must ' +
              'be true rather than what to do; the consequence is ' +
              '`onViolation`, and a policy whose conditions end differently ' +
              'is published as several constraints. Present instead of ' +
              '`expression`, never alongside it.',
        },
      },
      {
        index: 6,
        name: 'evaluation',
        type: 'string',
        annotations: {
          displayName: 'Evaluation',
          description:
              'How the constraint is settled: `deterministic` when it ' +
              'states an `expression`, `judged` when it states a ' +
              '`judgment`. Derived from which of the two the constraint ' +
              'used, so it says nothing they do not, and present so a ' +
              'consumer can select rules by how they are decided without ' +
              'inspecting both bodies.',
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
    id: CONSTRAINT_TYPE_ID,
    entryType: {
      displayName: 'Semantic Constraint',
      description: 'An invariant a semantic model requires to hold.',
    },
    aspectType: CONSTRAINT_ASPECT_TYPE,
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
 * Stops at the first hard failure. A permission refusal does NOT stop it: the
 * refusals differ per type and per operation -- patching a type that already
 * exists needs `update`, creating one that does not needs `create` -- so a
 * caller refused one type may well be allowed the next, and giving up early
 * would leave a type uncreated that nothing was stopping. Every type is
 * attempted and the first refusal is reported once they have been.
 */
export async function provisionCustomTypes(
    cat: CatalogClient, dest: {project: string}): Promise<ProvisionResult> {
  const warnings: string[] = [];
  let denied: ProvisionResult|undefined;
  for (const type of CUSTOM_TYPES) {
    const result = await provisionOne(cat, dest, type);
    if (result.warnings) warnings.push(...result.warnings);
    // A hard failure is infrastructure-level and says nothing about the next
    // type, so it still stops everything.
    if (result.error)
      return {...result, warnings: warnings.length ? warnings : undefined};
    if (result.denied && !denied) denied = result;
  }
  if (denied)
    return {...denied, warnings: warnings.length ? warnings : undefined};
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
          `unchanged (${reason}); a push will fail wherever the two ` +
          `templates disagree, whether it states a field this one does not ` +
          `carry or omits one this one still requires`);
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
