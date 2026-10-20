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
// AN ASPECT-ONLY TYPE has no entry type: its aspect rides an entry of a
// BUILT-IN type (a `semantic-model` / `semantic-entity` / `semantic-metric`
// entry) to carry what that type's closed template has no slot for. The three
// annotation aspects below are the model content a push would otherwise lose
// (see kc_annotations.ts, which encodes them). Each is optional on its entry,
// so a project that has not re-run `kcmd init` still pushes; it just pushes
// the lossy subset (see provisionedCustomAspects).
//
// TEMPLATES ARE APPEND-ONLY. Dataplex rejects a backwards-incompatible template
// change, so a new field must be APPENDED with a fresh index. Renumbering or
// removing an existing field breaks the update for every project that already
// provisioned the type.

import {AspectType, CatalogClient, Entry, EntryType} from '../gcp/dataplex';

import {AiContext} from './ir';
import {entryIdOf} from './kc_ids';

// A type kcmd provisions because no built-in one exists yet.
export interface CustomType {
  // Shared by the entry type and the aspect type.
  id: string;
  // The entry type, minus the required-aspect list: it always requires exactly
  // this record's aspect type, which provisionCustomTypes fills in. Absent on
  // an aspect-only type (see the header).
  entryType?: Omit<EntryType, 'name'|'requiredAspects'>;
  // The aspect type, including the metadata template that gives the entry its
  // typed, queryable fields.
  aspectType: Omit<AspectType, 'name'>;
  // Set when every push needs the type, so init fails when it cannot create
  // it. Absent means the type backs an optional construct.
  required?: boolean;
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
// mirrors the model's own parameter list. Every parameter carries a scalar
// `type`, and one projected from a field also names the `concept` and `field`
// it came from -- so a consumer that has not loaded the model can bind a value
// from the type alone, and follow the projection to the definition when it
// wants to know what the value MEANS.
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
                description: 'The scalar datatype of the value. Stated by ' +
                    'the parameter, or taken from the field it projects.',
              },
            },
            {
              index: 3,
              name: 'isEntityRef',
              type: 'bool',
              annotations: {
                displayName: 'Is Entity Reference (reserved)',
                description:
                    'Reserved and never written. It marked a parameter whose ' +
                    '`type` named an entity, so the parameter referred to an ' +
                    'object rather than carrying a value. Those parameters ' +
                    'were removed; every parameter now carries a scalar, and ' +
                    'one taken from a field names it in `concept`/`field`.',
              },
            },
            {
              index: 4,
              name: 'description',
              type: 'string',
              annotations: {
                displayName: 'Description',
                description:
                    'Human- and model-readable description of the parameter.',
              },
            },
            {
              index: 5,
              name: 'required',
              type: 'bool',
              annotations: {
                displayName: 'Required',
                description:
                    'Whether the parameter must be supplied when invoking the action.',
              },
            },
            {
              index: 6,
              name: 'default',
              type: 'string',
              annotations: {
                displayName: 'Default Value',
                description:
                    'Default value substituted when omitted, serialized as text.',
              },
            },
            {
              index: 7,
              name: 'concept',
              type: 'string',
              annotations: {
                displayName: 'Concept',
                description:
                    'The entity or relationship this parameter projects a ' +
                    'field of. Absent on a parameter that stands alone.',
              },
            },
            {
              index: 8,
              name: 'field',
              type: 'string',
              annotations: {
                displayName: 'Field',
                description:
                    'The field within `concept` whose type and wording this ' +
                    'parameter takes. Present exactly when `concept` is.',
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
// A constraint states its rule in `judgment`: the rule in words -- whether a
// discount is justified, whether a refund reason is plausible, whether an order
// is within a standing limit -- which a language-model judge settles against
// the proposed write. The push refuses a constraint that states none, so the
// field is required in the sense that matters and the template cannot say so.
//
// `expression` and `evaluation` are RESERVED and no push writes either. They
// carried a second, deterministic body, a boolean in the model's own language,
// which was removed. They stay DECLARED rather than deleted for two reasons: an
// aspect type already created in a project keeps matching the one `kcmd init`
// would create, and a catalog still holding an expression from an older push
// reads back as a named skip instead of a silently empty rule.
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
      'every instance of an entity, however that instance was written, ' +
      'stated in words for a reader to settle.',
  metadataTemplate: {
    name: CONSTRAINT_TYPE_ID,
    type: 'record',
    recordFields: [
      {
        index: 1,
        name: 'expression',
        type: 'string',
        annotations: {
          displayName: 'Expression (reserved)',
          description:
              'Reserved and never written. It carried a deterministic body, ' +
              'a boolean in the model\'s own expression language, which was ' +
              'removed. A constraint states its rule in `judgment`. An entry ' +
              'still holding a value here predates the removal and its rule ' +
              'has to be restated.',
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
              'action does. Required, and any of the three words: a ' +
              'constraint a judge settles must say what its verdict costs.',
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
              'The invariant in words, for example `A discount over 30% ' +
              'must be justified by the reason given in ' +
              'Order.discount_reason`. A ' +
              'language-model judge settles it against the proposed write at ' +
              'review time. Field names are written model-qualified so a ' +
              'reader can resolve them. States one condition, as what must ' +
              'be true rather than what to do; the consequence is ' +
              '`onViolation`, and a policy whose conditions end differently ' +
              'is published as several constraints. The only body a ' +
              'constraint has, and always present.',
        },
      },
      {
        index: 6,
        name: 'evaluation',
        type: 'string',
        annotations: {
          displayName: 'Evaluation (reserved)',
          description:
              'Reserved and never written. It said which of two bodies a ' +
              'constraint used, and there is one body: every constraint is ' +
              'settled by a language-model judge reading the write that ' +
              'would break it.',
        },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Annotation aspects (aspect-only; see the header and kc_annotations.ts).
// ---------------------------------------------------------------------------

// The whole `ai_context` of a model element and of the parts of it that have
// no entry of their own: an entity's fields, and (on the model anchor) the
// relationships, which are entry links and so cannot carry a custom aspect.
export const AI_CONTEXT_TYPE_ID = 'semantic-ai-context';

// SQL expressions and the authoring facts the built-in templates collapse: a
// metric's expression, and per field its expression (the column binding), its
// imported vendor form, its dimension role and its logical datatype.
export const EXPRESSIONS_TYPE_ID = 'semantic-expressions';

// Where an entity's rows come from and how they are shaped: binding mode,
// hydration rules, vocabulary members, the physical assets it is read through
// (node view, graph node), and -- on a junction entry -- the many-to-many
// relationship the junction backs.
export const BINDING_TYPE_ID = 'semantic-binding';

// The relationship-index fields that carry a relationship publishing no
// schema-join link (see AI_CONTEXT_ASPECT_TYPE). A chain step is written as
// the relationship name, prefixed `~` when it is traversed backwards.
const UNPUBLISHED_RELATIONSHIP_FIELDS = [
  ['source', 'Source Entity', 'string'],
  ['destination', 'Destination Entity', 'string'],
  ['sourceColumns', 'Source Columns', 'strings'],
  ['destinationColumns', 'Destination Columns', 'strings'],
  ['abstract', 'Abstract', 'bool'],
  ['extends', 'Specializes', 'strings'],
  ['description', 'Description', 'string'],
  ['inverse', 'Inverse Name', 'string'],
  ['via', 'Derived Via', 'strings'],
  ['filter', 'Derived Filter', 'string'],
].map(([name, displayName, kind], i) => kind === 'strings' ? {
  index: 4 + i,
  name,
  type: 'array',
  arrayItems: {name: `${name}Item`, type: 'string'},
  annotations: {displayName},
} : {
  index: 4 + i,
  name,
  type: kind,
  annotations: {displayName},
});

const AI_CONTEXT_ASPECT_TYPE: Omit<AspectType, 'name'> = {
  displayName: 'Semantic AI Context',
  description:
      'The ai_context (instructions, synonyms, examples) of a semantic model ' +
      'element and of its fields; on the model, also of each relationship.',
  metadataTemplate: {
    name: AI_CONTEXT_TYPE_ID,
    type: 'record',
    recordFields: [
      aiContextField(1),
      {
        index: 2,
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
              annotations: {displayName: 'Field'},
            },
            aiContextField(2),
          ],
        },
        annotations: {
          displayName: 'Fields',
          description: 'The ai_context of each field of an entity that has one.',
        },
      },
      {
        index: 3,
        name: 'relationships',
        type: 'array',
        arrayItems: {
          name: 'relationship',
          type: 'record',
          recordFields: [
            {
              index: 1,
              name: 'name',
              type: 'string',
              constraints: {required: true},
              annotations: {
                displayName: 'Name',
                description: 'The relationship name exactly as authored.',
              },
            },
            {
              index: 2,
              name: 'link',
              type: 'string',
              annotations: {
                displayName: 'Entry Link',
                description:
                    'Id of the schema-join entry link that publishes it (on ' +
                    'a many-to-many relationship, the link to its source).',
              },
            },
            aiContextField(3),
            // Fields 4-13 are set only on a relationship that publishes no
            // schema-join link (abstract, or an endpoint that is abstract or
            // has no join columns): the row is then its only record, so it
            // carries the whole relationship and pull rebuilds it from here.
            ...UNPUBLISHED_RELATIONSHIP_FIELDS,
          ],
        },
        annotations: {
          displayName: 'Relationships',
          description:
              'On the model entry: every relationship by its authored name, ' +
              'with its ai_context. An entry link carries no custom aspect, ' +
              'so this is where they ride; one that publishes no link rides ' +
              'here whole.',
        },
      },
    ],
  },
};

const expressionFields = (first: number) => [
  {
    index: first,
    name: 'expression',
    type: 'string',
    annotations: {
      displayName: 'Expression',
      description: 'The GoogleSQL expression (for a field, its column binding).',
    },
  },
  {
    index: first + 1,
    name: 'importedExpression',
    type: 'string',
    annotations: {
      displayName: 'Imported Expression',
      description: 'The original vendor SQL, verbatim.',
    },
  },
  {
    index: first + 2,
    name: 'importedDialect',
    type: 'string',
    annotations: {displayName: 'Imported Dialect'},
  },
  {
    index: first + 3,
    name: 'type',
    type: 'string',
    annotations: {
      displayName: 'Logical Type',
      description:
          'The datatype as authored (String, Integer, ... Opaque); the ' +
          'schema\'s column type cannot tell an authored String from an ' +
          'untyped value.',
    },
  },
];

const EXPRESSIONS_ASPECT_TYPE: Omit<AspectType, 'name'> = {
  displayName: 'Semantic Expressions',
  description:
      'The SQL of a semantic model element: a metric\'s aggregate, or the ' +
      'column binding and dimension role of each field of an entity.',
  metadataTemplate: {
    name: EXPRESSIONS_TYPE_ID,
    type: 'record',
    recordFields: [
      ...expressionFields(1),
      {
        index: 5,
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
              annotations: {displayName: 'Field'},
            },
            ...expressionFields(2),
            {
              index: 6,
              name: 'dimension',
              type: 'bool',
              annotations: {
                displayName: 'Dimension',
                description: 'The field is a dimension.',
              },
            },
            {
              index: 7,
              name: 'isTime',
              type: 'bool',
              annotations: {
                displayName: 'Time Dimension',
                description:
                    'Explicit temporal-dimension flag; absent means ' +
                    'inferred from the type.',
              },
            },
          ],
        },
        annotations: {displayName: 'Fields'},
      },
    ],
  },
};

const str = (index: number, name: string, displayName: string,
             required = false) => ({
  index,
  name,
  type: 'string',
  ...(required ? {constraints: {required: true}} : {}),
  annotations: {displayName},
});

const BINDING_ASPECT_TYPE: Omit<AspectType, 'name'> = {
  displayName: 'Semantic Binding',
  description:
      'Where a semantic entity\'s rows come from and how they are shaped: ' +
      'the binding mode, the hydration rules, vocabulary members, and the ' +
      'physical assets (node view, graph node) an agent reads it through.',
  metadataTemplate: {
    name: BINDING_TYPE_ID,
    type: 'record',
    recordFields: [
      {
        index: 1,
        name: 'mode',
        type: 'string',
        annotations: {
          displayName: 'Mode',
          description:
              '`view` (read through a generated node view) or `direct` ' +
              '(the source table as-is). Absent means `view`.',
        },
      },
      {
        index: 2,
        name: 'hydration',
        type: 'record',
        recordFields: [
          {
            index: 1,
            name: 'grain',
            type: 'record',
            recordFields: [
              str(1, 'latestBy', 'Latest By'),
              {index: 2, name: 'deterministic', type: 'bool',
               annotations: {displayName: 'Deterministic'}},
            ],
            annotations: {
              displayName: 'Grain',
              description: 'One row per key: the latest by `latestBy`, or a ' +
                  'deterministic pick.',
            },
          },
          {
            index: 2,
            name: 'normalize',
            type: 'array',
            arrayItems: {
              name: 'rule',
              type: 'record',
              recordFields: [
                str(1, 'field', 'Field', true),
                str(2, 'before', 'Before'),
                str(3, 'after', 'After'),
                {index: 4, name: 'divideBy', type: 'double',
                 annotations: {displayName: 'Divide By'}},
                {index: 5, name: 'multiplyBy', type: 'double',
                 annotations: {displayName: 'Multiply By'}},
                str(6, 'on', 'Date Column'),
              ],
            },
            annotations: {
              displayName: 'Normalize',
              description: 'Declared value corrections before / after a date.',
            },
          },
          {
            index: 3,
            name: 'resolve',
            type: 'array',
            arrayItems: {
              name: 'rule',
              type: 'record',
              recordFields: [
                str(1, 'field', 'Field', true),
                {index: 2, name: 'match', type: 'array',
                 arrayItems: {name: 'match', type: 'string'},
                 annotations: {displayName: 'Match'}},
              ],
            },
            annotations: {
              displayName: 'Resolve',
              description: 'Foreign keys recorded as a code or name, resolved ' +
                  'to the destination\'s key.',
            },
          },
          {
            index: 4,
            name: 'deriveFrom',
            type: 'string',
            annotations: {
              displayName: 'Derive From',
              description: 'The relationship whose distinct foreign-key ' +
                  'values are the entity\'s rows.',
            },
          },
          {
            index: 5,
            name: 'constraints',
            type: 'string',
            annotations: {
              displayName: 'Constraints',
              description: '`enforce`: the node view applies the model\'s ' +
                  'constraints to the rows it serves (reject rules withhold ' +
                  'the value or exclude the row; the rest are named in ' +
                  '`_warnings`).',
            },
          },
        ],
        annotations: {
          displayName: 'Hydration',
          description: 'How the bound source is reshaped into the entity.',
        },
      },
      {
        index: 3,
        name: 'members',
        type: 'array',
        arrayItems: {
          name: 'member',
          type: 'record',
          recordFields: [
            str(1, 'code', 'Code', true),
            str(2, 'label', 'Label'),
            {index: 3, name: 'synonyms', type: 'array',
             arrayItems: {name: 'synonym', type: 'string'},
             annotations: {displayName: 'Synonyms'}},
            str(4, 'definition', 'Definition'),
            {index: 5, name: 'order', type: 'int',
             annotations: {displayName: 'Order'}},
            str(6, 'iri', 'IRI'),
          ],
        },
        annotations: {
          displayName: 'Members',
          description: 'A vocabulary\'s members: its rows.',
        },
      },
      {
        index: 4,
        name: 'nodeView',
        type: 'string',
        annotations: {
          displayName: 'Node View',
          description:
              'The BigQuery view the entity is read through (generated, ' +
              'deduplicated, ontology-named), as `project.dataset.view`.',
        },
      },
      {
        index: 5,
        name: 'graph',
        type: 'string',
        annotations: {
          displayName: 'Graph',
          description: 'The property graph the entity is a node of, as ' +
              '`project.dataset.graph`.',
        },
      },
      {
        index: 6,
        name: 'graphNode',
        type: 'string',
        annotations: {
          displayName: 'Graph Node Label',
          description: 'The entity\'s node label in that graph.',
        },
      },
      {
        index: 7,
        name: 'association',
        type: 'record',
        recordFields: [
          str(1, 'relationship', 'Relationship', true),
          str(2, 'source', 'Source Entity'),
          str(3, 'destination', 'Destination Entity'),
        ],
        annotations: {
          displayName: 'Association',
          description:
              'On a junction entry: the many-to-many relationship whose ' +
              'pairs this table holds.',
        },
      },
    ],
  },
};

// The id of the file-copy type. A file copy holds the text of one model or
// profile file as push read it, so a pull can return the file unchanged.
export const FILE_COPY_TYPE_ID = 'semantic-model-file';

// The entrySource label a push puts on the model entry when it stores file
// copies. Its value is the push id those copies carry. A model entry whose
// label names a push the catalog holds no copies of was last written by a
// push that stopped before storing them. kcmd owns this label and no other.
export const PUSH_ID_LABEL = 'kcmd-push-id';

// A file copy: one model or profile file's name and text.
export interface FileCopy {
  // The file's path relative to the entry group directory, for example
  // `retail.yaml` or `retail.profile.prod.yaml`.
  fileName: string;
  // The file's text, exactly as read.
  content: string;
  // The id of the push that stored the copy. Every copy one push stores
  // carries the same id. Absent on a copy stored before push ids.
  pushId?: string;
  // How many copies that push stored. Absent on a copy stored before copy
  // counts.
  pushFileCount?: number;
}

// The aspect that carries a file copy.
const FILE_COPY_ASPECT_TYPE: Omit<AspectType, 'name'> = {
  displayName: 'Semantic Model File',
  description:
      'The text of one semantic model file or profile file, exactly as ' +
      'pushed.',
  metadataTemplate: {
    name: FILE_COPY_TYPE_ID,
    type: 'record',
    recordFields: [
      {
        index: 1,
        name: 'fileName',
        type: 'string',
        constraints: {required: true},
        annotations: {
          displayName: 'File Name',
          description:
              'The file\'s path relative to the entry group directory, for ' +
              'example `retail.profile.prod.yaml`.',
        },
      },
      {
        index: 2,
        name: 'content',
        type: 'string',
        constraints: {required: true},
        annotations: {
          displayName: 'Content',
          description: 'The file\'s text, exactly as read.',
        },
      },
      {
        index: 3,
        name: 'pushId',
        type: 'string',
        annotations: {
          displayName: 'Push ID',
          description:
              'The id of the push that stored this copy. Every copy one push ' +
              'stores carries the same id.',
        },
      },
      {
        index: 4,
        name: 'pushFileCount',
        type: 'int',
        annotations: {
          displayName: 'Push File Count',
          description: 'How many file copies the push that stored this one ' +
              'stored in all.',
        },
      },
    ],
  },
};

// Every type kcmd provisions. This list is the whole of what is custom.
// Entry+aspect pairs first, then the aspect-only annotation types.
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
  {
    id: FILE_COPY_TYPE_ID,
    entryType: {
      displayName: 'Semantic Model File',
      description: 'A copy of one semantic model file or profile file.',
    },
    aspectType: FILE_COPY_ASPECT_TYPE,
    // Push stores every model file with it.
    required: true,
  },
  {id: AI_CONTEXT_TYPE_ID, aspectType: AI_CONTEXT_ASPECT_TYPE},
  {id: EXPRESSIONS_TYPE_ID, aspectType: EXPRESSIONS_ASPECT_TYPE},
  {id: BINDING_TYPE_ID, aspectType: BINDING_ASPECT_TYPE},
];

// The aspect-only annotation types, in the order a push attaches them.
export const ANNOTATION_ASPECT_IDS: readonly string[] =
    [AI_CONTEXT_TYPE_ID, EXPRESSIONS_TYPE_ID, BINDING_TYPE_ID];

/**
 * The annotation aspect types already provisioned in a destination (by `kcmd
 * init`). A push attaches only these, and a pull hydrates only these: naming
 * an aspect type the project does not have would fail the whole write or
 * read, while leaving one out only loses what it would have carried. A failed
 * read (missing, no permission) counts as not provisioned.
 */
export async function provisionedCustomAspects(
    cat: Pick<CatalogClient, 'getAspectType'>,
    dest: {project: string}): Promise<string[]> {
  const home = customTypeHome(dest);
  const out: string[] = [];
  for (const id of ANNOTATION_ASPECT_IDS) {
    try {
      const res = await cat.getAspectType(home.project, home.location, id);
      if (res.status === 200) out.push(id);
    } catch {
      // Unreadable is the same as absent here.
    }
  }
  return out;
}

// Custom types are provisioned at `global` so an entry group in any region can
// reference them, matching where the built-in system types live.
const CUSTOM_TYPE_LOCATION = 'global';

// True when kcmd still provisions this id. It turns false the moment the type
// is deleted from CUSTOM_TYPES, which is how the rest of the code learns that a
// built-in has taken over.
export function isCustomType(id: string): boolean {
  return CUSTOM_TYPES.some(t => t.id === id);
}

/**
 * Collects the deduplicated list of `kcmd`-owned custom type IDs
 * (`semantic-action`, `semantic-constraint`, etc.) used by `entries`.
 */
export function collectCustomTypes(entries: readonly Entry[]): string[] {
  const used = new Set<string>();
  for (const entry of entries) {
    const typeId = entryIdOf(entry.entryType ?? '');
    if (isCustomType(typeId)) used.add(typeId);
  }
  return [...used];
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
// `denied` is the narrower case of lacking permission to create a type that
// backs an optional construct, which is reported and survived: a project whose
// models use none of those constructs never needs the type. Lacking permission
// to create a required type that does not exist is an `error`.
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
 * Stops at the first hard failure, which includes a permission refusal for a
 * required type that does not exist. A refusal to patch a type that exists is
 * a warning. A refusal for an optional type does NOT stop it: the refusals
 * differ per type and per operation -- patching a type that already exists
 * needs `update`, creating one that does not needs `create` -- so a caller
 * refused one type may well be allowed the next, and giving up early would
 * leave a type uncreated that nothing was stopping. Every type is attempted
 * and the first refusal is reported once they have been.
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
  // none of the optional types, so that refusal is reported rather than fatal.
  // A required type is needed by every push, so its refusal stops init.
  const denial = (what: string, status: number, message?: string):
      ProvisionResult|undefined => {
    if (status !== 403) return undefined;
    const refused = `no permission to create ${what} in project '${
        home.project}' (${message || status})`;
    return type.required ?
        {error: `${refused}; every push needs it, so init cannot finish`} :
        {
          denied: `${refused}; models that need it cannot be pushed until ` +
              `it exists`
        };
  };

  // A caller without create permission may be refused the create of a type
  // that already exists. For a required type a lookup tells the two apart, so
  // init fails only when the type is missing.
  const refusedButExists =
      async (status: number, lookup: () => Promise<{status: number}>) =>
          status === 403 && !!type.required && (await lookup()).status === 200;

  const warnings: string[] = [];
  const aspectLabel = `aspect type '${type.id}'`;
  const aspect = await cat.createAspectType(
      home.project, home.location, type.id, type.aspectType);
  if (aspect.status === 409 ||
      await refusedButExists(
          aspect.status,
          () => cat.getAspectType(home.project, home.location, type.id))) {
    const upd = await cat.updateAspectType(
        home.project, home.location, type.id, type.aspectType,
        ['description', 'display_name', 'metadata_template']);
    // Patching an existing type forward is best effort. Dataplex refuses a
    // template change it judges backwards-incompatible -- removing a field, or
    // renumbering one -- and the type already there is the one every published
    // entry depends on. Leaving it alone and saying so beats aborting an init
    // that has already created the entry group.
    //
    // What the warning has to carry is the way OUT, because there is no way
    // forward: `kcmd` creates and patches aspect types and does not delete
    // them, so a project holding a template this build cannot patch stays that
    // way until someone removes it by hand. Naming the resource and the
    // command is the whole of the fix; a reader who has only "left it
    // unchanged" has to work out which of several types in which project, and
    // then that `gcloud dataplex aspect-types` is where it lives.
    const reason = upd.status !== 200 ?
        `${upd.message || upd.status}` :
        await cat.awaitOperation(upd.result, `updating ${aspectLabel}`);
    if (upd.status === 403) {
      // The type exists, so a refusal to patch it leaves it as it is.
      warnings.push(
          `no permission to update the existing ${aspectLabel} in project ` +
          `'${home.project}' (${reason}); left it unchanged`);
    } else if (reason) {
      const resource = customAspectTypeName(type.id, dest);
      warnings.push(
          `left the existing ${aspectLabel} unchanged (${reason}). It is ` +
          `${resource}, and Dataplex will not patch it into the template ` +
          `this build states -- a template field that was removed or ` +
          `renumbered is a backwards-incompatible change and is refused. A ` +
          `push will fail wherever the two disagree. To move it forward, ` +
          `delete it and re-run this command: gcloud dataplex aspect-types ` +
          `delete ${type.id} --project=${home.project} ` +
          `--location=${home.location}. Deleting takes the aspects of every ` +
          `entry already published with this type, so re-push those models ` +
          `afterwards.`);
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
  // what an entry already published depends on. An aspect-only type has none.
  const collected = warnings.length ? {warnings} : {};
  if (!type.entryType) return collected;
  const entryLabel = `entry type '${type.id}'`;
  const entryType =
      await cat.createEntryType(home.project, home.location, type.id, {
        ...type.entryType,
        requiredAspects: [{type: customAspectTypeName(type.id, dest)}],
      });
  if (entryType.status === 409 ||
      await refusedButExists(
          entryType.status,
          () => cat.getEntryType(home.project, home.location, type.id))) {
    return collected;
  }
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
