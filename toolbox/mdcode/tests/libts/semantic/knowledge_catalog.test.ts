// Behavior specification for the Knowledge Catalog emitter
// (src/libts/semantic/knowledge_catalog.ts).
//
// The readable "big picture" goldens live in `knowledge_catalog.e2e.test.ts` (a
// corpus of `<fixture>.yaml` inputs, each with a committed
// `<fixture>.knowledge_catalog.golden.json`). This file holds what a loader
// fixture
// CANNOT express, because the open AI-first format the loader reads is a subset
// of the IR:
//   - the logical DataType -> schema `dataType`/`metadataType` mapping and the
//     DIMENSION role (the corpus fixtures declare no field `datatype`, so every
//     field falls back to STRING/DEFAULT);
//   - the `dataSource` -> resource-path forms (BigQuery URI vs. verbatim);
//   - IR-contract cases the loader never produces (a metric with an explicit
//     type, a cross-entity metric with no attach entity, duplicate ids).

import {describe, expect, test} from 'bun:test';

import {DataType, Entity, SemanticModel} from '../../../src/libts/semantic/ir';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';

const OPTS = {
  project: 'dest-proj',
  location: 'us',
  entryGroup: 'eg'
};
// The expression fields (per-field schema semantics, metric expression) are
// gated off by default; this turns them on to assert their content.
const OPTS_EXPR = {
  ...OPTS,
  emitExpressions: true
};

// A one-entity model whose single field carries the given IR type + dimension,
// so a test can read back the emitted schema aspect for that field.
function modelWithField(
    type: DataType|undefined, dimension = false): SemanticModel {
  const entity: Entity = {
    name: 'e',
    dataSource: 'p.d.t',
    keys: ['k'],
    fields: [{
      name: 'f',
      expression: 'e.f',
      ...(type ? {type} : {}),
      ...(dimension ? {dimension: {}} : {}),
    }],
  };
  return {name: 'm', entities: [entity], relationships: [], metrics: []};
}

// The schema-aspect field record for the sole field of modelWithField.
function schemaField(model: SemanticModel, opts = OPTS): Record<string, any> {
  const {entries} = generateCatalogResources(model, opts);
  const entity = entries.find(e => e.entryType.endsWith('/semantic-entity'))!;
  const schema = entity.aspects!['dataplex-types.global.schema'].data!;
  return schema.fields[0];
}


describe(
    'logical DataType maps to the schema aspect dataType + metadataType',
    () => {
      const cases: [DataType, string, string][] = [
        ['String', 'STRING', 'STRING'],
        ['Integer', 'INT64', 'NUMBER'],
        ['Decimal', 'NUMERIC', 'NUMBER'],
        ['Float', 'FLOAT64', 'NUMBER'],
        ['Boolean', 'BOOL', 'BOOLEAN'],
        ['Date', 'DATE', 'DATETIME'],
        ['Time', 'TIME', 'DATETIME'],
        ['DateTime', 'DATETIME', 'DATETIME'],
        ['DateTimeTz', 'TIMESTAMP', 'TIMESTAMP'],
        ['Opaque', 'STRING', 'OTHER'],
      ];
      for (const [type, dataType, metadataType] of cases) {
        test(`${type} -> ${dataType} / ${metadataType}`, () => {
          const f = schemaField(modelWithField(type));
          expect(f.dataType).toBe(dataType);
          expect(f.metadataType).toBe(metadataType);
        });
      }

      test('an un-typed field falls back to Opaque (STRING / OTHER)', () => {
        const f = schemaField(modelWithField(undefined));
        expect(f.dataType).toBe('STRING');
        expect(f.metadataType).toBe('OTHER');
      });
    });


describe(
    'a field with dimension metadata gets role DIMENSION, else DEFAULT', () => {
      test('dimension -> DIMENSION', () => {
        expect(schemaField(modelWithField('String', true), OPTS_EXPR)
                   .semantics.role)
            .toBe('DIMENSION');
      });
      test('no dimension -> DEFAULT', () => {
        expect(schemaField(modelWithField('String', false), OPTS_EXPR)
                   .semantics.role)
            .toBe('DEFAULT');
      });
    });


describe('the schema aspect carries the target expression in semantics', () => {
  test(
      'the target expression is kept; imported vendor SQL is not emitted',
      () => {
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [{
            name: 'e',
            dataSource: 'p.d.t',
            keys: ['k'],
            fields: [{
              name: 'f',
              expression: 'CAST(e.f AS INT64)',
              importedExpression: 'e.f::int',
              importedDialect: 'SNOWFLAKE',
            }],
          }],
        };
        const f = schemaField(model, OPTS_EXPR);
        expect(f.semantics.expression).toBe('CAST(e.f AS INT64)');
        // importedExpression is the vendor/MAQL form; KC has no consumer for
        // it.
        expect(f.semantics.importedExpression).toBeUndefined();
      });
});


describe('the schema semantics block is gated behind emitExpressions', () => {
  test('omitted by default; the non-gated columns are still emitted', () => {
    const f = schemaField(modelWithField('String', true));
    expect(f.semantics).toBeUndefined();
    expect(f.dataType).toBe('STRING');
    expect(f.metadataType).toBe('STRING');
  });
  test(
      'emitExpressions re-adds the semantics block (expression + role)', () => {
        const f = schemaField(modelWithField('String', true), OPTS_EXPR);
        expect(f.semantics).toEqual({expression: 'e.f', role: 'DIMENSION'});
      });
});


describe(
    'the schema aspect carries keys, unique constraints, and labels', () => {
      // Entity keys / unique keys and a field label ride the built-in `schema`
      // aspect (primaryKey / uniqueConstraints / per-field annotations); all
      // three are in the CLOSED schema template, so they emit on a default push
      // (no
      // --emit-expressions gating).
      const model: SemanticModel = {
        name: 'm',
        relationships: [],
        metrics: [],
        entities: [{
          name: 'e',
          dataSource: 'p.d.t',
          keys: ['a', 'b'],
          uniqueKeys: [['a'], ['b', 'c']],
          fields: [
            {name: 'a', expression: 'e.a'},
            {name: 'b', expression: 'e.b', label: 'Bee'},
          ],
        }],
      };
      const {entries} = generateCatalogResources(model, OPTS);
      const schema =
          entries.find(e => e.entryType.endsWith('/semantic-entity'))!
              .aspects!['dataplex-types.global.schema']
              .data!;

      test('entity keys emit as an ordered primaryKey', () => {
        expect(schema.primaryKey).toEqual({fields: ['a', 'b']});
      });
      test('unique keys emit as uniqueConstraints, one per key', () => {
        expect(schema.uniqueConstraints).toEqual([
          {fields: ['a']}, {fields: ['b', 'c']}
        ]);
      });
      test(
          'a field label emits as an annotations map; unlabeled fields omit it',
          () => {
            const [a, b] = schema.fields;
            expect(a.annotations).toBeUndefined();
            expect(b.annotations).toEqual({label: 'Bee'});
          });

      test(
          'an entity with no keys / unique keys / labels omits all three',
          () => {
            const bare: SemanticModel = {
              name: 'm',
              relationships: [],
              metrics: [],
              entities: [{
                name: 'e',
                dataSource: 'p.d.t',
                keys: [],
                fields: [
                  {name: 'a', expression: 'e.a'},
                ]
              }],
            };
            const s = generateCatalogResources(bare, OPTS)
                          .entries
                          .find(e => e.entryType.endsWith('/semantic-entity'))!
                          .aspects!['dataplex-types.global.schema']
                          .data!;
            expect(s.primaryKey).toBeUndefined();
            expect(s.uniqueConstraints).toBeUndefined();
            expect(s.fields[0].annotations).toBeUndefined();
          });

      test(
          'empty-string key members and empty unique-key sets are dropped',
          () => {
            // Degenerate key input: the reader's stringList drops '' members,
            // so the emitter must too or the round trip is asymmetric. A unique
            // key that is empty after filtering is omitted entirely.
            const degenerate: SemanticModel = {
              name: 'm',
              relationships: [],
              metrics: [],
              entities: [{
                name: 'e',
                dataSource: 'p.d.t',
                keys: ['a', ''],
                uniqueKeys: [[''], ['b', '']],
                fields: [{name: 'a', expression: 'e.a'}],
              }],
            };
            const s = generateCatalogResources(degenerate, OPTS)
                          .entries
                          .find(e => e.entryType.endsWith('/semantic-entity'))!
                          .aspects!['dataplex-types.global.schema']
                          .data!;
            expect(s.primaryKey).toEqual({fields: ['a']});
            expect(s.uniqueConstraints).toEqual([{fields: ['b']}]);
          });
    });


describe('ai_context.instructions emits a guidelines aspect', () => {
  const GUIDELINES = 'dataplex-types.global.guidelines';
  const model: SemanticModel = {
    name: 'm',
    aiContext: {instructions: 'Model doc.', synonyms: ['syn']},
    relationships: [],
    entities: [{
      name: 'e',
      dataSource: 'p.d.t',
      keys: ['k'],
      aiContext: {instructions: 'Entity doc.'},
      fields: [
        // A field-level ai_context has no entry to attach a guidelines aspect
        // to, so it must not surface anywhere.
        {name: 'k', expression: 'e.k', aiContext: {synonyms: ['field syn']}},
      ],
    }],
    metrics: [{
      name: 'rev',
      expression: 'SUM(e.k)',
      entity: 'e',
      type: 'Integer',
      aiContext: {instructions: 'Metric doc.'},
    }],
  };
  const {entries} = generateCatalogResources(model, OPTS);
  const byType = (suffix: string) =>
      entries.find(e => e.entryType.endsWith(suffix))!;

  test('the model anchor carries a userManaged guidelines aspect', () => {
    expect(byType('/semantic-model').aspects![GUIDELINES].data)
        .toEqual({instructions: 'Model doc.', userManaged: true});
  });
  test('the entity carries its instructions in a guidelines aspect', () => {
    expect(byType('/semantic-entity').aspects![GUIDELINES].data)
        .toEqual({instructions: 'Entity doc.', userManaged: true});
  });
  test('the metric carries its instructions in a guidelines aspect', () => {
    expect(byType('/semantic-metric').aspects![GUIDELINES].data)
        .toEqual({instructions: 'Metric doc.', userManaged: true});
  });

  test('an object with no instructions gets no guidelines aspect', () => {
    // The field's synonym-only ai_context routes nothing; and a model without
    // instructions omits the aspect entirely.
    const plain: SemanticModel =
        {name: 'm', entities: [], relationships: [], metrics: []};
    const anchor = generateCatalogResources(plain, OPTS).entries[0];
    expect(anchor.aspects![GUIDELINES]).toBeUndefined();
  });
});


describe('entity dataSource maps to a resource path', () => {
  function resources(dataSource: string): string[] {
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [{name: 'e', dataSource, keys: ['k'], fields: []}],
    };
    const {entries} = generateCatalogResources(model, OPTS);
    const entity = entries.find(e => e.entryType.endsWith('/semantic-entity'))!;
    return entity.aspects!['dataplex-types.global.semantic-entity']
        .data!.source.resources;
  }

  test(
      'a clean project.dataset.table becomes a BigQuery linked-resource URI',
      () => {
        expect(resources('proj.ds.tbl')).toEqual([
          '//bigquery.googleapis.com/projects/proj/datasets/ds/tables/tbl',
        ]);
      });
  test('a query-like source is kept verbatim', () => {
    expect(resources('SELECT 1')).toEqual(['SELECT 1']);
  });
  test('an under-qualified reference is kept verbatim', () => {
    expect(resources('ds.tbl')).toEqual(['ds.tbl']);
  });
});


describe('semantic-metric aspect', () => {
  function metricData(model: SemanticModel, opts = OPTS) {
    const {entries, warnings} = generateCatalogResources(model, opts);
    const metric = entries.find(e => e.entryType.endsWith('/semantic-metric'))!;
    return {
      data: metric.aspects!['dataplex-types.global.semantic-metric'].data!,
      warnings
    };
  }

  test(
      'a typed metric carries its mapped dataType and attach entity, no warning',
      () => {
        const model: SemanticModel = {
          name: 'm',
          entities: [],
          relationships: [],
          metrics: [
            {name: 'rev', expression: 'SUM(o.p)', entity: 'o', type: 'Decimal'}
          ],
        };
        const {data, warnings} = metricData(model, OPTS_EXPR);
        expect(data).toEqual(
            {entity: 'o', dataType: 'NUMERIC', expression: 'SUM(o.p)'});
        expect(warnings.some(w => w.includes('dataType'))).toBe(false);
      });

  test(
      'an un-typed metric falls back to Opaque (STRING) dataType, no warning',
      () => {
        const model: SemanticModel = {
          name: 'm',
          entities: [],
          relationships: [],
          metrics: [{name: 'rev', expression: 'COUNT(*)'}],
        };
        const {data, warnings} = metricData(model);
        // No metadataType on the metric aspect, so Opaque emits a bare STRING;
        // the reader reads it back un-typed (see kc_converter). No NUMERIC
        // guess, so nothing to warn about.
        expect(data.dataType).toBe('STRING');
        expect(data.entity).toBeUndefined();  // cross-entity / unattached
        expect(warnings.some(w => w.includes('metric \'rev\''))).toBe(false);
      });

  test(
      'the expression is gated: omitted by default, kept with emitExpressions',
      () => {
        const model: SemanticModel = {
          name: 'm',
          entities: [],
          relationships: [],
          metrics: [
            {name: 'rev', expression: 'SUM(o.p)', entity: 'o', type: 'Decimal'}
          ],
        };
        expect(metricData(model).data)
            .toEqual({entity: 'o', dataType: 'NUMERIC'});
        expect(metricData(model, OPTS_EXPR).data.expression).toBe('SUM(o.p)');
      });
});


describe('model-level structure', () => {
  test(
      'a model with no BigQuery targets emits an empty semantic-model aspect',
      () => {
        const model: SemanticModel =
            {name: 'm', entities: [], relationships: [], metrics: []};
        const {entries, warnings} = generateCatalogResources(model, OPTS);
        const anchor = entries[0];
        expect(anchor.entryType.endsWith('/semantic-model')).toBe(true);
        expect(anchor.aspects!['dataplex-types.global.semantic-model'].data)
            .toEqual({});
        expect(warnings).toContain(
            'model has no entities; only the semantic-model entry will be generated');
      });

  test(
      'a Spanner-targeted model records its Spanner URI in the semantic-model aspect',
      () => {
        // A model bound to Spanner Graph must not lose its deployment target in
        // Knowledge Catalog (the aspect used to read only BigQuery targets, so a
        // Spanner-only model round-tripped as UNBOUND).
        const spannerUri =
            '//spanner.googleapis.com/projects/p/instances/i/databases/db/propertyGraphs/g';
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [{name: 'e', dataSource: 'p.d.t', keys: ['k'], fields: []}],
          customExtensions: [{
            vendorName: 'GOOGLE',
            data: JSON.stringify({deploymentTargets: [spannerUri]}),
          }],
        };
        const {entries} = generateCatalogResources(model, OPTS);
        const anchor = entries[0];
        expect(anchor.aspects!['dataplex-types.global.semantic-model'].data)
            .toEqual({deploymentTargets: [spannerUri]});
      });

  test(
      'a model targeting both BigQuery and Spanner records both URIs, BigQuery first',
      () => {
        const bqUri =
            '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
        const spannerUri =
            '//spanner.googleapis.com/projects/p/instances/i/databases/db/propertyGraphs/g';
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [{name: 'e', dataSource: 'p.d.t', keys: ['k'], fields: []}],
          customExtensions: [{
            vendorName: 'GOOGLE',
            data: JSON.stringify({deploymentTargets: [spannerUri, bqUri]}),
          }],
        };
        const {entries} = generateCatalogResources(model, OPTS);
        const anchor = entries[0];
        expect(anchor.aspects!['dataplex-types.global.semantic-model'].data)
            .toEqual({deploymentTargets: [bqUri, spannerUri]});
      });

  test('the anchor is emitted first and is the parent of every child', () => {
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      entities: [{name: 'e', dataSource: 'p.d.t', keys: ['k'], fields: []}],
      metrics:
          [{name: 'rev', expression: 'SUM(e.x)', entity: 'e', type: 'Integer'}],
    };
    const {entries} = generateCatalogResources(model, OPTS);
    expect(entries[0].entryType.endsWith('/semantic-model')).toBe(true);
    const anchorName = entries[0].name;
    for (const child of entries.slice(1)) {
      expect(child.parentEntry).toBe(anchorName);
    }
  });

  test(
      'two entities that normalize to the same id: the duplicate is skipped + warned',
      () => {
        // 'a b' and 'a-b' both slug to 'a_b' vs 'a-b'? '-' is allowed, space ->
        // '_'. Use names that both map to 'a_b': 'a b' and 'a.b' would differ
        // ('.' kept). 'a b' and 'a/b' both become 'a_b'.
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [
            {name: 'a b', dataSource: 'p.d.t1', keys: ['k'], fields: []},
            {name: 'a/b', dataSource: 'p.d.t2', keys: ['k'], fields: []},
          ],
        };
        const {entries, warnings} = generateCatalogResources(model, OPTS);
        const entityEntries =
            entries.filter(e => e.entryType.endsWith('/semantic-entity'));
        expect(entityEntries.length).toBe(1);
        expect(warnings.some(w => w.includes('duplicates an earlier one')))
            .toBe(true);
      });
});


// A two-entity model joined by a direct foreign key (orders.custkey ->
// customer.custkey), the common case the loader produces from `relationships`.
function directFkModel(): SemanticModel {
  return {
    name: 'm',
    metrics: [],
    entities: [
      {name: 'orders', dataSource: 'p.d.orders', keys: ['o_key'], fields: []},
      {
        name: 'customer',
        dataSource: 'p.d.customer',
        keys: ['c_key'],
        fields: []
      },
    ],
    relationships: [{
      name: 'orders-to-customer',
      source: {entity: 'orders', columns: ['custkey']},
      destination: {entity: 'customer', columns: ['c_key']},
      description: 'each order belongs to a customer',
    }],
  };
}

describe('relationships map to schema-join entry links', () => {
  test('a direct FK becomes one FOREIGN_KEY schema-join link', () => {
    const {entryLinks, warnings} =
        generateCatalogResources(directFkModel(), OPTS);
    expect(entryLinks.length).toBe(1);
    const link = entryLinks[0];

    // Link id is slugged and undirected: two UNSPECIFIED references naming the
    // endpoint entities' entries, typed schema-join.
    expect(link.name!.endsWith('/entryLinks/m-orders-to-customer')).toBe(true);
    // Already-normalized name: no rename, so no normalization warning.
    expect(link.entryLinkType.endsWith('/entryLinkTypes/schema-join'))
        .toBe(true);
    expect(link.entryReferences.map(r => r.type)).toEqual([
      'UNSPECIFIED', 'UNSPECIFIED'
    ]);
    expect(link.entryReferences[0].name.endsWith('/entries/m.entities.orders'))
        .toBe(true);
    expect(
        link.entryReferences[1].name.endsWith('/entries/m.entities.customer'))
        .toBe(true);

    // The join direction + column pairing live in the aspect: source is the FK
    // side, each side's `name` is the entity's dataSource, type is FOREIGN_KEY.
    const aspect = link.aspects!['dataplex-types.global.schema-join'].data!;
    expect(aspect.userManaged).toBe(true);
    expect(aspect.joins.length).toBe(1);
    const join = aspect.joins[0];
    expect(join.type).toBe('FOREIGN_KEY');
    expect(join.inferenceSource).toBe('USER');
    expect(join.source).toEqual({name: 'p.d.orders', fields: ['custkey']});
    expect(join.target).toEqual({name: 'p.d.customer', fields: ['c_key']});
    expect(join.description).toBe('each order belongs to a customer');
    expect(warnings.length).toBe(0);
  });

  test('a many-to-many edge produces no link (it is an entry instead)', () => {
    const {entryLinks, warnings} = generateCatalogResources(mnModel(), OPTS);
    expect(entryLinks.length).toBe(0);
    // Silently, because the edge is published -- as an entry, asserted in the
    // many-to-many describe below. A warning here would say a supported
    // construct was dropped.
    expect(warnings.length).toBe(0);
  });

  test('an edge to an unpublished entity is skipped and warned', () => {
    const model = directFkModel();
    // Point the destination at an entity the model does not declare, so it is
    // never emitted and the link has no endpoint entry to reference.
    model.relationships[0].destination.entity = 'ghost';
    const {entryLinks, warnings} = generateCatalogResources(model, OPTS);
    expect(entryLinks.length).toBe(0);
    expect(warnings.some(
               w => w.includes('orders-to-customer') && w.includes('ghost')))
        .toBe(true);
  });

  test('a column-less (purely logical) edge produces no link, silently', () => {
    // An OWL import leaves an edge with no join columns. schema-join is a
    // server CLOSED template, so rather than risk a rejected column-less aspect
    // the emitter skips the link. Silently: the edge is still published, as an
    // entry, so nothing is lost by having no link for it.
    const model = directFkModel();
    model.relationships[0].source.columns = [];
    model.relationships[0].destination.columns = [];
    const {entryLinks, warnings} = generateCatalogResources(model, OPTS);
    expect(entryLinks.length).toBe(0);
    expect(warnings.length).toBe(0);
  });

  test('a name that is not link-id-clean is slugged into the link id', () => {
    // Underscores and uppercase are not valid in a link id, so the emitter
    // slugs the name. No warning: the entry carries the authored name verbatim,
    // and a pull reads the name from there, so the slug never reaches the
    // author.
    const model = directFkModel();
    model.relationships[0].name = 'Orders_To_Customer';
    const {entryLinks, warnings} = generateCatalogResources(model, OPTS);
    expect(entryLinks.length).toBe(1);
    expect(entryLinks[0].name!.endsWith('/entryLinks/m-orders-to-customer'))
        .toBe(true);
    expect(warnings.length).toBe(0);
  });
});


// The same two entities paired through a table of their own instead of a
// foreign key: an order reaches many customers and a customer is reached by
// many orders, so the pairs live in `p.d.order_customer` with a `discount` of
// their own.
function mnModel(): SemanticModel {
  return {
    name: 'm',
    metrics: [],
    entities: [
      {name: 'orders', dataSource: 'p.d.orders', keys: ['o_key'], fields: []},
      {
        name: 'customer',
        dataSource: 'p.d.customer',
        keys: ['c_key'],
        fields: []
      },
    ],
    relationships: [{
      name: 'order-customer',
      source: {entity: 'orders', columns: ['j_orderkey']},
      destination: {entity: 'customer', columns: ['j_custkey']},
      description: 'which customers an order reached',
      through: 'p.d.order_customer',
      keys: ['id'],
      fields: [{name: 'discount', expression: 'j.discount', type: 'Decimal'}],
    }],
  };
}

// The sole semantic-relationship entry of a generated model.
function relationshipEntry(model: SemanticModel) {
  const {entries} = generateCatalogResources(model, OPTS);
  const found = entries.filter(
      e => e.entryType.endsWith('/entryTypes/semantic-relationship'));
  expect(found.length).toBe(1);
  return found[0];
}

// A relationship has no built-in Knowledge Catalog type of its own: schema-join
// is an entry LINK, which holds one column pair and no name, and Dataplex has
// no custom entry LINK types. Every relationship therefore publishes as an entry
// of the custom `semantic-relationship` type, the same mechanism actions use.
// See kc_relationships.ts.
describe('a relationship becomes a semantic-relationship entry', () => {
  const ASPECT = 'dest-proj.global.semantic-relationship';

  test('the entry is typed, named and parented to the model anchor', () => {
    const entry = relationshipEntry(mnModel());
    expect(entry.name!.endsWith('/entries/m.relationships.order-customer'))
        .toBe(true);
    // The custom type lives in the DESTINATION project (kcmd init creates it
    // there), not under dataplex-types with the built-in types.
    expect(entry.entryType)
        .toBe(
            'projects/dest-proj/locations/global/entryTypes/semantic-relationship');
    expect(entry.parentEntry!.endsWith('/entries/m')).toBe(true);
    // The authored name rides the entry source verbatim, so unlike the
    // schema-join link's id it is not normalized on the way back.
    expect(entry.entrySource!.displayName).toBe('order-customer');
    expect(entry.entrySource!.description)
        .toBe('which customers an order reached');
  });

  test('the aspect carries both endpoints, the table and its columns', () => {
    const entry = relationshipEntry(mnModel());
    const aspect = entry.aspects![ASPECT];
    expect(aspect.aspectType)
        .toBe(
            'projects/dest-proj/locations/global/aspectTypes/semantic-relationship');
    const data = aspect.data!;
    expect(data.fromEntity).toBe('orders');
    expect(data.toEntity).toBe('customer');
    // The table the edge runs through is addressed the way an entity's backing
    // table is: the BigQuery linked-resource URI, not the dotted form.
    expect(data.through)
        .toBe(
            '//bigquery.googleapis.com/projects/p/datasets/d/tables/order_customer');
    expect(data.keys).toEqual(['id']);
    expect(data.fromColumns).toEqual(['j_orderkey']);
    expect(data.toColumns).toEqual(['j_custkey']);
  });

  test('edge properties ride the relationship aspect, not a schema aspect', () => {
    // The entry's type is custom, so the built-in `schema` aspect type is not
    // available to it (a pull derives the aspect base from the entry type's
    // project). The edge's own fields therefore live on this aspect.
    const entry = relationshipEntry(mnModel());
    expect(Object.keys(entry.aspects!)).toEqual([ASPECT]);
    expect(entry.aspects![ASPECT].data!.fields).toEqual([
      {name: 'discount', dataType: 'Decimal', expression: 'j.discount'},
    ]);
  });

  test('an untyped edge property is published as Opaque', () => {
    const model = mnModel();
    delete model.relationships[0].fields![0].type;
    const data = relationshipEntry(model).aspects![ASPECT].data!;
    expect(data.fields[0].dataType).toBe('Opaque');
  });

  test('ai_context.instructions ride the relationship aspect too', () => {
    const model = mnModel();
    model.relationships[0].aiContext = {instructions: 'one row per pairing'};
    const entry = relationshipEntry(model);
    expect(entry.aspects![ASPECT].data!.instructions).toBe('one row per pairing');
    // Not the built-in guidelines aspect, which this entry type cannot require.
    expect(Object.keys(entry.aspects!)).toEqual([ASPECT]);
  });

  test('the relationships prefix is owned, so a dropped edge is reconciled',
       () => {
         const {ownedPrefixes} = generateCatalogResources(mnModel(), OPTS);
         expect(ownedPrefixes).toContain('m.relationships.');
       });

  test('a foreign-key edge gets an entry too, with no through table', () => {
    // The entry is the fidelity record for EVERY relationship; the schema-join
    // link is the graph-shaped projection a foreign-key edge also gets.
    const {entries, entryLinks} =
        generateCatalogResources(directFkModel(), OPTS);
    const entry = entries.find(
        e => e.entryType.endsWith('/entryTypes/semantic-relationship'))!;
    const data = entry.aspects![ASPECT].data!;
    expect('through' in data).toBe(false);
    expect(data.fromColumns).toEqual(['custkey']);
    expect(data.toColumns).toEqual(['c_key']);
    expect(entryLinks.length).toBe(1);
  });

  test('an edge to an unpublished entity is skipped and warned', () => {
    const model = mnModel();
    model.relationships[0].destination.entity = 'ghost';
    const {entries, warnings} = generateCatalogResources(model, OPTS);
    expect(entries.some(
               e => e.entryType.endsWith('/entryTypes/semantic-relationship')))
        .toBe(false);
    expect(warnings.some(
               w => w.includes('order-customer') && w.includes('ghost')))
        .toBe(true);
  });

  test('an unbound through table is omitted rather than stored as a blank',
       () => {
         const model = mnModel();
         model.relationships[0].through = '';
         const data = relationshipEntry(model).aspects![ASPECT].data!;
         expect('through' in data).toBe(false);
         // The logical shape survives: the edge still says what it pairs.
         expect(data.fromColumns).toEqual(['j_orderkey']);
       });
});


describe('a purely logical model (no physical binding) emits cleanly', () => {
  // A Knowledge-Catalog-only model governs meaning with no binding: every
  // entity has an empty dataSource and its fields carry no expression. The
  // emitter must publish it without inventing a bogus physical resource, and a
  // relationship's join endpoints fall back to the entity name (there is no
  // table to name).
  function logicalModel(): SemanticModel {
    return {
      name: 'm',
      metrics: [],
      entities: [
        {
          name: 'orders',
          dataSource: '',
          keys: ['o_key'],
          fields: [{name: 'amount'}]
        },
        {
          name: 'customer',
          dataSource: '',
          keys: ['c_key'],
          fields: [{name: 'name'}]
        },
      ],
      relationships: [{
        name: 'orders-to-customer',
        source: {entity: 'orders', columns: ['custkey']},
        destination: {entity: 'customer', columns: ['c_key']},
      }],
    };
  }

  test('every entity is published (anchor + 2 entities), no warnings', () => {
    const {entries, warnings} = generateCatalogResources(logicalModel(), OPTS);
    const kinds = entries.map(e => e.entryType.replace(/.*\//, ''));
    expect(kinds).toEqual([
      'semantic-model', 'semantic-entity', 'semantic-entity',
      'semantic-relationship'
    ]);
    expect(warnings).toEqual([]);
  });

  test('a logical entity emits an empty source (no bogus empty element)', () => {
    const {entries} = generateCatalogResources(logicalModel(), OPTS);
    const orders = entries.find(e => e.entryType.endsWith('/semantic-entity'))!;
    // No table -> `source.resources` is [], not the old omitted source (which
    // the semantic-entity template rejects) or a bogus source:{resources:['']}.
    const data = orders.aspects!['dataplex-types.global.semantic-entity'].data!;
    expect(data.source).toEqual({resources: []});
  });

  test(
      'the schema-join endpoints fall back to the entity name when there is no table',
      () => {
        const {entryLinks} = generateCatalogResources(logicalModel(), OPTS);
        expect(entryLinks.length).toBe(1);
        const join = entryLinks[0]
                         .aspects!['dataplex-types.global.schema-join']
                         .data!.joins[0];
        // No dataSource to name, so the endpoint `name` is the entity name.
        expect(join.source).toEqual({name: 'orders', fields: ['custkey']});
        expect(join.target).toEqual({name: 'customer', fields: ['c_key']});
      });
});


describe('abstract entities are skipped for Knowledge Catalog', () => {
  // The KC leg does not model inheritance (that is BigQuery-only today), and an
  // abstract entity has no physical table, so it must not be published as an
  // entry with an empty linked resource. It is skipped with a warning; its
  // concrete subtype is published normally.
  function withAbstract(): SemanticModel {
    return {
      name: 'm',
      entities: [
        {name: 'Party', dataSource: '', keys: [], abstract: true,
         fields: [{name: 'id', expression: 'id'}]},
        {name: 'Person', dataSource: 'p.d.person', keys: ['id'],
         extends: ['Party'], fields: [{name: 'id', expression: 'id'}]},
      ],
      relationships: [],
      metrics: [],
    };
  }

  test('an abstract entity produces no entry and warns', () => {
    const {entries, warnings} = generateCatalogResources(withAbstract(), OPTS);
    const names = entries.map(e => e.entrySource!.displayName ?? '');
    expect(names).not.toContain('Party');
    expect(warnings.some(
               w => w.includes(`entity 'Party' is abstract`) &&
                   w.includes('skipped for Knowledge Catalog')))
        .toBe(true);
  });

  test('the concrete subtype is still published', () => {
    const {entries} = generateCatalogResources(withAbstract(), OPTS);
    const person =
        entries.find(e => e.entryType.endsWith('/semantic-entity'));
    expect(person).toBeDefined();
    expect(person!.entrySource!.displayName).toBe('Person');
  });
});
