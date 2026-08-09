// Behavior specification for the KC converter's read direction
// (modelsFromCatalogResources in src/libts/semantic/kc_converter.ts).
//
// The reader is the inverse of the emitter (generateCatalogResources). The
// central guarantee is an emitter -> reader round trip: emit a model's entries
// AND entry links, read them back, and get an IR equal to the source WHERE the
// emitter is lossless. The write drops content by design (entity keys,
// ai_context, field labels, importedDialect, and many-to-many relationships --
// see the emitter header), so the expected read-back is the source model with
// exactly those fields cleared. 1:1 / 1:N relationships and deployment targets
// DO round-trip (via schema-join links and the semantic-model aspect), except
// that relationship names come back normalized (lowercased/hyphenated).
// Targeted tests pin the mapping details a round trip cannot isolate (the
// dataType inverse, the DIMENSION role, resource-URI parsing, metric attach
// re-derivation, relationship endpoint/direction recovery, and parent/anchor
// grouping).

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {Entity, Metric, SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';

const FIXTURES = path.join(__dirname, 'fixtures');

const OPTS = {
  project: 'dest',
  location: 'us',
  entryGroup: 'eg'
};

// Emits a model to entries + entry links and reads it straight back.
function roundTrip(model: SemanticModel):
    {models: SemanticModel[]; warnings: string[]} {
  const {entries, entryLinks} = generateCatalogResources(model, OPTS);
  return modelsFromCatalogResources(entries, entryLinks);
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


describe('relationship recovery (schema-join links -> IR)', () => {
  // orders.o_custkey (the foreign-key side) references customer.c_custkey.
  const twoEntities: Entity[] = [
    {
      name: 'orders',
      dataSource: 'p.d.orders',
      keys: [],
      fields: [{name: 'o_custkey', expression: 'orders.o_custkey'}],
    },
    {
      name: 'customer',
      dataSource: 'p.d.customer',
      keys: [],
      fields: [{name: 'c_custkey', expression: 'customer.c_custkey'}],
    },
  ];

  test(
      'a 1:N relationship recovers its endpoints, direction, and columns',
      () => {
        const model: SemanticModel = {
          name: 'sales',
          entities: twoEntities,
          relationships: [{
            name:
                'places',  // already link-slug-safe, so it round-trips exactly
            source: {entity: 'orders', columns: ['o_custkey']},
            destination: {entity: 'customer', columns: ['c_custkey']},
          }],
          metrics: [],
        };
        const rels = roundTrip(model).models[0].relationships;
        expect(rels).toEqual([{
          name: 'places',
          source: {entity: 'orders', columns: ['o_custkey']},
          destination: {entity: 'customer', columns: ['c_custkey']},
        }]);
      });

  test(
      'a relationship name comes back normalized (lowercased/hyphenated)',
      () => {
        const model: SemanticModel = {
          name: 'sales',
          entities: twoEntities,
          relationships: [{
            name: 'Places_Order',  // mixed case + underscore -> normalized on
                                   // read
            source: {entity: 'orders', columns: ['o_custkey']},
            destination: {entity: 'customer', columns: ['c_custkey']},
          }],
          metrics: [],
        };
        expect(roundTrip(model).models[0].relationships[0].name)
            .toBe('places-order');
      });

  test('a many-to-many (association) relationship is not recovered', () => {
    const model: SemanticModel = {
      name: 'sales',
      entities: twoEntities,
      relationships: [{
        name: 'enrolls',
        source: {entity: 'orders', columns: ['o_custkey']},
        destination: {entity: 'customer', columns: ['c_custkey']},
        association: {
          dataSource: 'p.d.junction',
          keys: ['id'],
          sourceColumns: ['j_orderkey'],
          destinationColumns: ['j_custkey'],
        },
      }],
      metrics: [],
    };
    // The emitter never publishes M:N, so no schema-join link exists to read.
    expect(roundTrip(model).models[0].relationships).toEqual([]);
  });

  test(
      'endpoints resolve from the link references, not the shared table name',
      () => {
        // Two entities over the SAME table: a data-source index would collapse
        // them (last write wins), so both endpoints must come from the link's
        // entryReferences instead. Direction can't be told from the shared
        // table, so the reader keeps the reference order and warns.
        const sameTable: Entity[] = [
          {
            name: 'parent_order',
            dataSource: 'p.d.orders',
            keys: [],
            fields: [{name: 'id', expression: 'parent_order.id'}],
          },
          {
            name: 'child_order',
            dataSource: 'p.d.orders',
            keys: [],
            fields: [{name: 'parent_id', expression: 'child_order.parent_id'}],
          },
        ];
        const model: SemanticModel = {
          name: 'sales',
          entities: sameTable,
          relationships: [{
            name: 'parents',
            source: {entity: 'child_order', columns: ['parent_id']},
            destination: {entity: 'parent_order', columns: ['id']},
          }],
          metrics: [],
        };
        const {models, warnings} = roundTrip(model);
        expect(models[0].relationships).toEqual([{
          name: 'parents',
          source: {entity: 'child_order', columns: ['parent_id']},
          destination: {entity: 'parent_order', columns: ['id']},
        }]);
        expect(warnings.some(w => /join direction is ambiguous/i.test(w)))
            .toBe(true);
      });

  test(
      'endpoints resolve when link references carry an un-normalized project ' +
          'number',
      () => {
        // The live path is asymmetric: lookupEntry normalizes entry names to
        // project IDs, but lookupEntryLinks returns references still carrying
        // the numeric project. Matching on the (stable) entry id keeps the
        // relationship resolvable rather than silently dropping it.
        const model: SemanticModel = {
          name: 'sales',
          entities: twoEntities,
          relationships: [{
            name: 'places',
            source: {entity: 'orders', columns: ['o_custkey']},
            destination: {entity: 'customer', columns: ['c_custkey']},
          }],
          metrics: [],
        };
        const {entries, entryLinks} = generateCatalogResources(model, OPTS);
        const numeric = entryLinks.map(
            l => ({
              ...l,
              entryReferences:
                  (l.entryReferences ??
                   []).map(r => ({
                             ...r,
                             name: r.name.replace(
                                 'projects/dest/', 'projects/000000000000/'),
                           })),
            }));
        const {models} = modelsFromCatalogResources(entries, numeric);
        expect(models[0].relationships).toEqual([{
          name: 'places',
          source: {entity: 'orders', columns: ['o_custkey']},
          destination: {entity: 'customer', columns: ['c_custkey']},
        }]);
      });

  test(
      'the model prefix is stripped across tricky model names ' +
          '(linkNamePrefix tracks the emitter slug)',
      () => {
        // Pins the read-side prefix reproduction to the emitter's linkSlug: if
        // it drifts, the model prefix would survive and the recovered name
        // would not equal the bare, normalized relationship name.
        for (const modelName of ['Sales', 'Sales Analytics', '123 Sales!']) {
          const model: SemanticModel = {
            name: modelName,
            entities: twoEntities,
            relationships: [{
              name: 'rel_one',
              source: {entity: 'orders', columns: ['o_custkey']},
              destination: {entity: 'customer', columns: ['c_custkey']},
            }],
            metrics: [],
          };
          expect(roundTrip(model).models[0].relationships[0].name)
              .toBe('rel-one');
        }
      });

  test('an unnamed link returned from both endpoints is deduped', () => {
    // Defense in depth: if the catalog ever returns a nameless schema-join
    // link, the per-endpoint fan-out yields it twice; dedup falls back to the
    // endpoint pair so it becomes one relationship, not two.
    const model: SemanticModel = {
      name: 'sales',
      entities: twoEntities,
      relationships: [{
        name: 'places',
        source: {entity: 'orders', columns: ['o_custkey']},
        destination: {entity: 'customer', columns: ['c_custkey']},
      }],
      metrics: [],
    };
    const {entries, entryLinks} = generateCatalogResources(model, OPTS);
    const nameless = entryLinks.map(l => ({...l, name: undefined}));
    const {models} = modelsFromCatalogResources(
        entries, [...nameless, ...nameless.map(l => ({...l}))]);
    expect(models[0].relationships).toHaveLength(1);
  });
});


describe(
    'deployment-target recovery (semantic-model aspect -> custom_extensions)',
    () => {
      test('the GOOGLE deployment targets ride back verbatim', () => {
        const uri =
            '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
        const data = JSON.stringify({deploymentTargets: [uri]});
        const model: SemanticModel = {
          name: 'sales',
          customExtensions: [{vendorName: 'GOOGLE', data}],
          entities: [{name: 'e', dataSource: 'p.d.t', keys: [], fields: []}],
          relationships: [],
          metrics: [],
        };
        expect(roundTrip(model).models[0].customExtensions).toEqual([
          {vendorName: 'GOOGLE', data}
        ]);
      });

      test(
          'a model with no deployment targets recovers no custom_extensions',
          () => {
            const model: SemanticModel = {
              name: 'sales',
              entities:
                  [{name: 'e', dataSource: 'p.d.t', keys: [], fields: []}],
              relationships: [],
              metrics: [],
            };
            expect(roundTrip(model).models[0].customExtensions).toBeUndefined();
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
  test(
      'warns that the metric may be unplaceable and leaves it unattached',
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


// -- Golden pull: the whole KC entries -> IR -> OSI YAML output. --
//
// The round trip above proves the reader inverts the emitter in memory; this
// pins the reviewable artifact. For each corpus fixture it reads the committed
// emitter golden (`<fixture>.knowledge_catalog.golden.json` -- the exact
// entries and entry links a push produced) back through the reader and
// serializes the reconstructed IR to `<fixture>.pull.golden.yaml`. Open that
// next to the fixture's `.osi.golden.yaml` to see, as whole files, what a
// Knowledge Catalog round trip preserves (including 1:1 / 1:N relationships and
// deployment targets) and what it drops (keys, ai_context, labels, vendor SQL,
// M:N relationships).
//
//   Regenerate after an intentional reader/serializer change:
//     UPDATE_GOLDENS=1 npx bun test ./tests/libts/semantic/kc_converter.test.ts
describe(
    'golden pull: each corpus KC golden reconstructs to its exact YAML', () => {
      const CORPUS = [
        'sales_bq_graph_target.yaml',
        'star_orders_customer.yaml',
        'tpcds_date_edge.yaml',
      ];
      const kcGoldenPath = (fixture: string) => path.join(
          FIXTURES,
          fixture.replace(/\.yaml$/, '.knowledge_catalog.golden.json'));
      const pullGoldenPath = (fixture: string) =>
          path.join(FIXTURES, fixture.replace(/\.yaml$/, '.pull.golden.yaml'));

      for (const fixture of CORPUS) {
        test(fixture, () => {
          const kc = JSON.parse(fs.readFileSync(kcGoldenPath(fixture), 'utf8'));
          const {models, warnings} =
              modelsFromCatalogResources(kc.entries, kc.entryLinks ?? []);
          // Reader warnings ride along as YAML comments so the golden shows
          // the full outcome, not just the recovered document.
          const header = warnings.length ?
              warnings.map((w: string) => `# warning: ${w}`).join('\n') + '\n' :
              '# (no warnings)\n';
          const actual =
              header + models.map(m => serializeModel(m).yaml).join('---\n');
          const golden = pullGoldenPath(fixture);
          if (process.env.UPDATE_GOLDENS) {
            fs.writeFileSync(golden, actual);
            return;
          }
          if (!fs.existsSync(golden)) {
            throw new Error(`missing golden ${
                path.basename(
                    golden)} \u2014 run UPDATE_GOLDENS=1 to create it`);
          }
          expect(actual).toBe(fs.readFileSync(golden, 'utf8'));
        });
      }
    });
