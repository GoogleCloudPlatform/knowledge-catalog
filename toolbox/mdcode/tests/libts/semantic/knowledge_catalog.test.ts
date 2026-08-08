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
function schemaField(model: SemanticModel): Record<string, any> {
  const {entries} = generateCatalogResources(model, OPTS);
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

      test('an un-typed field falls back to STRING / STRING', () => {
        const f = schemaField(modelWithField(undefined));
        expect(f.dataType).toBe('STRING');
        expect(f.metadataType).toBe('STRING');
      });
    });


describe(
    'a field with dimension metadata gets role DIMENSION, else DEFAULT', () => {
      test('dimension -> DIMENSION', () => {
        expect(schemaField(modelWithField('String', true)).semantics.role)
            .toBe('DIMENSION');
      });
      test('no dimension -> DEFAULT', () => {
        expect(schemaField(modelWithField('String', false)).semantics.role)
            .toBe('DEFAULT');
      });
    });


describe('the schema aspect carries expression fidelity in semantics', () => {
  test('both target and imported expressions are preserved', () => {
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
    const f = schemaField(model);
    expect(f.semantics.expression).toBe('CAST(e.f AS INT64)');
    expect(f.semantics.importedExpression).toBe('e.f::int');
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
  function metricData(model: SemanticModel) {
    const {entries, warnings} = generateCatalogResources(model, OPTS);
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
        const {data, warnings} = metricData(model);
        expect(data).toEqual(
            {entity: 'o', dataType: 'NUMERIC', expression: 'SUM(o.p)'});
        expect(warnings.some(w => w.includes('dataType'))).toBe(false);
      });

  test('an un-typed metric falls back to FLOAT64 dataType and warns', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [],
      relationships: [],
      metrics: [{name: 'rev', expression: 'COUNT(*)'}],
    };
    const {data, warnings} = metricData(model);
    expect(data.dataType).toBe('FLOAT64');
    expect(data.entity).toBeUndefined();  // cross-entity / unattached
    expect(warnings.some(
               w => w.includes('metric \'rev\'') && w.includes('FLOAT64')))
        .toBe(true);
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


describe('relationships map to schema-join entry links', () => {
  // A two-entity model joined by a direct foreign key (orders.custkey ->
  // customer.custkey), the common case the loader produces from
  // `relationships`.
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
        name: 'orders_to_customer',
        source: {entity: 'orders', columns: ['custkey']},
        destination: {entity: 'customer', columns: ['c_key']},
        description: 'each order belongs to a customer',
      }],
    };
  }

  test('a direct FK becomes one FOREIGN_KEY schema-join link', () => {
    const {entryLinks, warnings} =
        generateCatalogResources(directFkModel(), OPTS);
    expect(entryLinks.length).toBe(1);
    const link = entryLinks[0];

    // Link id is slugged and undirected: two UNSPECIFIED references naming the
    // endpoint entities' entries, typed schema-join.
    expect(link.name!.endsWith('/entryLinks/m-orders-to-customer')).toBe(true);
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

  test(
      'a many-to-many (association) edge is skipped and warned, no link',
      () => {
        const model = directFkModel();
        model.relationships[0].association = {
          dataSource: 'p.d.order_customer',
          keys: ['id'],
          sourceColumns: ['o_key'],
          destinationColumns: ['c_key'],
        };
        const {entryLinks, warnings} = generateCatalogResources(model, OPTS);
        expect(entryLinks.length).toBe(0);
        expect(warnings.some(
                   w => w.includes('orders_to_customer') &&
                       w.includes('many-to-many')))
            .toBe(true);
      });

  test('an edge to an unpublished entity is skipped and warned', () => {
    const model = directFkModel();
    // Point the destination at an entity the model does not declare, so it is
    // never emitted and the link has no endpoint entry to reference.
    model.relationships[0].destination.entity = 'ghost';
    const {entryLinks, warnings} = generateCatalogResources(model, OPTS);
    expect(entryLinks.length).toBe(0);
    expect(warnings.some(
               w => w.includes('orders_to_customer') && w.includes('ghost')))
        .toBe(true);
  });
});
