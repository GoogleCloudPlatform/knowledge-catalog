// Behavior specification for the Knowledge Catalog reader
// (modelsFromCatalogResources in src/libts/semantic/knowledge_catalog.ts).
//
// The reader is the inverse of the emitter (generateCatalogResources). The
// central guarantee is an emitter -> reader round trip: emit a model's entries,
// read them back, and get an IR equal to the source WHERE the emitter is
// lossless. The write drops content by design (entity keys, ai_context, field
// labels, importedDialect, relationships -- see the emitter header), so the
// expected read-back is the source model with exactly those fields cleared.
// Targeted tests pin the mapping details a round trip cannot isolate (the
// dataType inverse, the DIMENSION role, resource-URI parsing, metric attach
// re-derivation, and parent/anchor grouping).

import {describe, expect, test} from 'bun:test';

import {Entity, Metric, SemanticModel} from '../../../src/libts/semantic/ir';
import {generateCatalogResources, modelsFromCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';

const OPTS = {
  project: 'dest',
  location: 'us',
  entryGroup: 'eg'
};

// Emits a model to entries and reads it straight back.
function roundTrip(model: SemanticModel):
    {models: SemanticModel[]; warnings: string[]} {
  const {entries} = generateCatalogResources(model, OPTS);
  return modelsFromCatalogResources(entries);
}


describe('emitter -> reader round trip (lossless slice)', () => {
  // A model using only round-trippable content: no keys/ai_context/labels/
  // relationships (all dropped by the write), and datatypes that invert
  // cleanly.
  const source: SemanticModel = {
    name: 'sales',
    description: 'the sales model',
    entities: [{
      name: 'orders',
      dataSource: 'demo.sales.orders',
      keys: [],  // keys are not persisted; keep empty so the round trip matches
      fields: [
        {name: 'o_orderkey', expression: 'orders.o_orderkey', type: 'Integer'},
        {
          name: 'o_orderdate',
          expression: 'orders.o_orderdate',
          type: 'Date',
          dimension: {},
          description: 'order date',
        },
      ],
    }],
    relationships: [],
    metrics: [{
      name: 'total_revenue',
      expression: 'SUM(orders.o_totalprice)',
      entity: 'orders',
      type: 'Decimal',
    }],
  };

  test('reconstructs an IR equal to the source', () => {
    const {models} = roundTrip(source);
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(source);
  });
});


describe('dataType inverse (schema aspect -> IR type)', () => {
  // Emit a one-field model of each IR type, read it back, and check the field's
  // reconstructed type. String and Opaque both emit dataType STRING; String
  // (indistinguishable from an un-typed field) reads back as undefined, while
  // Opaque is disambiguated by metadataType OTHER.
  const cases: [Metric['type']|undefined, Metric['type']|undefined][] = [
    ['Integer', 'Integer'],
    ['Decimal', 'Decimal'],
    ['Float', 'Float'],
    ['Boolean', 'Boolean'],
    ['Date', 'Date'],
    ['Time', 'Time'],
    ['DateTime', 'DateTime'],
    ['DateTimeTz', 'DateTimeTz'],
    ['Opaque', 'Opaque'],
    ['String', undefined],   // collapses to un-typed
    [undefined, undefined],  // un-typed stays un-typed
  ];

  for (const [type, expected] of cases) {
    test(`${type ?? 'un-typed'} -> ${expected ?? 'un-typed'}`, () => {
      const model: SemanticModel = {
        name: 'm',
        entities: [{
          name: 'e',
          dataSource: 'p.d.t',
          keys: [],
          fields: [{name: 'f', expression: 'e.f', ...(type ? {type} : {})}],
        }],
        relationships: [],
        metrics: [],
      };
      const back = roundTrip(model).models[0].entities[0].fields[0];
      expect(back.type).toBe(expected as any);
    });
  }
});


describe('field mapping details', () => {
  function readField(field: Entity['fields'][number]) {
    const model: SemanticModel = {
      name: 'm',
      entities: [{name: 'e', dataSource: 'p.d.t', keys: [], fields: [field]}],
      relationships: [],
      metrics: [],
    };
    return roundTrip(model).models[0].entities[0].fields[0];
  }

  test('a DIMENSION role reads back as a dimension marker', () => {
    const back = readField({name: 'd', expression: 'e.d', dimension: {}});
    expect(back.dimension).toEqual({});
  });

  test('a non-dimension field has no dimension marker', () => {
    const back = readField({name: 'f', expression: 'e.f'});
    expect(back.dimension).toBeUndefined();
  });

  test(
      'an imported expression is not persisted to or recovered from the catalog',
      () => {
        const back = readField({
          name: 'amt',
          expression: 'e.amt',
          importedExpression: 'e.amt::NUMBER',
          importedDialect: 'SNOWFLAKE',
        });
        expect(back.expression).toBe('e.amt');
        // The emitter no longer writes importedExpression/importedDialect, so
        // neither survives the round trip.
        expect(back.importedExpression).toBeUndefined();
        expect(back.importedDialect).toBeUndefined();
      });
});


describe('data source resource-path parsing', () => {
  function readDataSource(dataSource: string): string {
    const model: SemanticModel = {
      name: 'm',
      entities: [{name: 'e', dataSource, keys: [], fields: []}],
      relationships: [],
      metrics: [],
    };
    return roundTrip(model).models[0].entities[0].dataSource;
  }

  test(
      'a three-part BigQuery reference round-trips through the resource URI',
      () => {
        expect(readDataSource('proj.ds.tbl')).toBe('proj.ds.tbl');
      });

  test('a verbatim query source is preserved unchanged', () => {
    const query = 'SELECT * FROM t';
    expect(readDataSource(query)).toBe(query);
  });
});


describe('metric attach entity is re-derived from the expression', () => {
  test(
      'a single-entity metric attaches; a cross-entity metric does not', () => {
        const model: SemanticModel = {
          name: 'm',
          entities: [
            {
              name: 'orders',
              dataSource: 'p.d.orders',
              keys: [],
              fields: [{name: 'amt', expression: 'orders.amt'}]
            },
            {
              name: 'customer',
              dataSource: 'p.d.customer',
              keys: [],
              fields: [{name: 'region', expression: 'customer.region'}]
            },
          ],
          relationships: [],
          metrics: [
            {name: 'revenue', expression: 'SUM(orders.amt)', entity: 'orders'},
            {
              name: 'mix',
              expression: 'SUM(orders.amt) / COUNT(customer.region)'
            },
          ],
        };
        const {models} = roundTrip(model);
        const byName = new Map(models[0].metrics.map(m => [m.name, m]));
        expect(byName.get('revenue')!.entity).toBe('orders');
        expect(byName.get('mix')!.entity).toBeUndefined();
      });
});


describe('anchor / parent grouping', () => {
  test('no semantic-model entry yields no models and a warning', () => {
    const {models, warnings} = modelsFromCatalogResources([]);
    expect(models).toHaveLength(0);
    expect(warnings.some(w => /no semantic-model entry/i.test(w))).toBe(true);
  });

  test('two models keep their own children by parentEntry', () => {
    const a = generateCatalogResources(
        {
          name: 'a',
          entities: [{name: 'ea', dataSource: 'p.d.a', keys: [], fields: []}],
          relationships: [],
          metrics: [],
        },
        OPTS);
    const b = generateCatalogResources(
        {
          name: 'b',
          entities: [{name: 'eb', dataSource: 'p.d.b', keys: [], fields: []}],
          relationships: [],
          metrics: [],
        },
        OPTS);
    const {models} = modelsFromCatalogResources([...a.entries, ...b.entries]);
    const byName = new Map(models.map(m => [m.name, m]));
    expect(byName.get('a')!.entities.map(e => e.name)).toEqual(['ea']);
    expect(byName.get('b')!.entities.map(e => e.name)).toEqual(['eb']);
  });
});


describe('metric expression referencing no known entity', () => {
  test('warns that the metric may be unplaceable and leaves it unattached',
       () => {
         const model: SemanticModel = {
           name: 'm',
           entities:
               [{name: 'orders', dataSource: 'p.d.o', keys: [], fields: []}],
           relationships: [],
           // References `widgets`, which is not an entity of this model.
           metrics: [{name: 'bogus', expression: 'SUM(widgets.qty)'}],
         };
         const {models, warnings} = roundTrip(model);
         expect(models[0].metrics[0].entity).toBeUndefined();
         expect(warnings.some(w => /bogus.*references no known entity/i.test(w)))
             .toBe(true);
       });
});
