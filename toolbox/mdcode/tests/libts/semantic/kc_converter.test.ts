// Behavior specification for the KC converter's read direction
// (modelsFromCatalogResources in src/libts/semantic/kc_converter.ts).
//
// The reader is the inverse of the emitter (generateCatalogResources). The
// central guarantee is an emitter -> reader round trip: emit a model's entries
// AND entry links, read them back, and get an IR equal to the source WHERE the
// emitter is lossless. The write drops content by design (entity keys,
// ai_context, field labels, importedDialect, and many-to-many relationships --
// see the emitter header), so the expected read-back is the source model with
// exactly those fields cleared. It ALSO drops the per-field `semantics` block
// (field/metric expressions and the DIMENSION role) unless the push enabled
// `emitExpressions`, so a DEFAULT round trip (roundTrip) loses those too, while
// a full round trip (roundTripFull, emitExpressions: true) keeps them. 1:1 /
// 1:N relationships and deployment targets DO round-trip either way (via
// schema-join links and the semantic-model aspect), except that relationship
// names come back normalized (lowercased/hyphenated). Targeted tests pin the
// mapping details a round trip cannot isolate (the dataType inverse, the
// DIMENSION role, resource-URI parsing, metric attach re-derivation,
// relationship endpoint/direction recovery, and parent/anchor grouping).

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {CustomExtension, Entity, Metric, SemanticModel} from '../../../src/libts/semantic/ir';
import {linkNamePrefix, modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';

const FIXTURES = path.join(__dirname, 'fixtures');

const OPTS = {
  project: 'dest',
  location: 'us',
  entryGroup: 'eg'
};

// Emits a model to entries + entry links and reads it straight back. The
// default push omits the per-field `semantics` block (expressions + role), so a
// default round trip drops those; use roundTripFull to exercise their recovery.
function roundTrip(model: SemanticModel):
    {models: SemanticModel[]; warnings: string[]} {
  const {entries, entryLinks} = generateCatalogResources(model, OPTS);
  return modelsFromCatalogResources(entries, entryLinks);
}

// A round trip through a `--emit-expressions` push: the catalog then holds the
// per-field `semantics` block and the metric expression, so field/metric
// expressions and DIMENSION roles round-trip too.
function roundTripFull(model: SemanticModel):
    {models: SemanticModel[]; warnings: string[]} {
  const {entries, entryLinks} =
      generateCatalogResources(model, {...OPTS, emitExpressions: true});
  return modelsFromCatalogResources(entries, entryLinks);
}


describe('emitter -> reader round trip (lossless slice)', () => {
  // A model using only round-trippable content: no keys/ai_context/labels/
  // relationships (all dropped by the write), and datatypes that invert
  // cleanly. Its fields and metric carry expressions and a DIMENSION role, so
  // it round-trips losslessly only through a `--emit-expressions` push
  // (roundTripFull); a default push omits the per-field `semantics` block.
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
    const {models} = roundTripFull(source);
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
  // reads back as un-typed (indistinguishable from a plain STRING), while
  // Opaque is disambiguated by metadataType OTHER. An un-typed field is emitted
  // as Opaque (STRING + OTHER) and so reads back as Opaque.
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
    ['String', undefined],  // collapses to un-typed
    [undefined, 'Opaque'],  // un-typed defaults to Opaque
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
  function readWith(
      rt: (m: SemanticModel) => {models: SemanticModel[]},
      field: Entity['fields'][number]) {
    const model: SemanticModel = {
      name: 'm',
      entities: [{name: 'e', dataSource: 'p.d.t', keys: [], fields: [field]}],
      relationships: [],
      metrics: [],
    };
    return rt(model).models[0].entities[0].fields[0];
  }
  // Default push (no per-field `semantics`) vs a `--emit-expressions` push.
  const readField = (f: Entity['fields'][number]) => readWith(roundTrip, f);
  const readFieldFull = (f: Entity['fields'][number]) =>
      readWith(roundTripFull, f);

  test('a DIMENSION role reads back as a dimension marker', () => {
    // The role lives in the gated `semantics` block, so it survives only a
    // `--emit-expressions` push.
    const back = readFieldFull({name: 'd', expression: 'e.d', dimension: {}});
    expect(back.dimension).toEqual({});
  });

  test('a non-dimension field has no dimension marker', () => {
    const back = readFieldFull({name: 'f', expression: 'e.f'});
    expect(back.dimension).toBeUndefined();
  });

  test(
      'a default push drops the DIMENSION role with the semantics block',
      () => {
        const back = readField({name: 'd', expression: 'e.d', dimension: {}});
        expect(back.dimension).toBeUndefined();
        expect(back.expression).toBeUndefined();
      });

  test(
      'an imported expression is not persisted to or recovered from the catalog',
      () => {
        const back = readFieldFull({
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

  test('a schema field missing its name is skipped with a warning', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'e',
        dataSource: 'p.d.t',
        keys: [],
        fields: [{name: 'f', expression: 'e.f'}],
      }],
      relationships: [],
      metrics: [],
    };
    const {entries, entryLinks} = generateCatalogResources(model, OPTS);
    // Inject a nameless field record into the entity's schema aspect, as a
    // malformed catalog could return; the reader must drop it, not emit a field
    // with an undefined name.
    for (const entry of entries) {
      for (const aspect of Object.values(entry.aspects ?? {})) {
        const fields = (aspect as {data?: {fields?: unknown[]}}).data?.fields;
        if (Array.isArray(fields)) fields.push({dataType: 'INT64'});
      }
    }
    const {models, warnings} = modelsFromCatalogResources(entries, entryLinks);
    expect(models[0].entities[0].fields.map(f => f.name)).toEqual(['f']);
    expect(
        warnings.some(w => /missing its name; the field is skipped/i.test(w)))
        .toBe(true);
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
        // Full push: the expression is in the catalog, so the entity is
        // re-derived from it (single entity -> attach; two entities -> none).
        const {models} = roundTripFull(model);
        const byName = new Map(models[0].metrics.map(m => [m.name, m]));
        expect(byName.get('revenue')!.entity).toBe('orders');
        expect(byName.get('mix')!.entity).toBeUndefined();
      });

  test(
      'a cross-entity metric falls back to the persisted attach entity', () => {
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
          // Two entities in the expression, so it cannot be re-derived; the
          // authored attach entity must ride back on the persisted aspect.
          metrics: [{
            name: 'mix',
            expression: 'SUM(orders.amt) / COUNT(customer.region)',
            entity: 'orders',
          }],
        };
        const {models} = roundTrip(model);
        expect(models[0].metrics[0].entity).toBe('orders');
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
        // The unplaceable warning fires from the expression, so it needs a push
        // that wrote one (a default push omits it, leaving nothing to check).
        const {models, warnings} = roundTripFull(model);
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


// -- Symmetry: emit -> read drops ONLY the documented set. --
//
// The golden pull above lets a human eyeball what a Knowledge Catalog round
// trip loses; this asserts it mechanically. For each corpus fixture it loads
// the authored IR, runs a full emit -> read round trip, and asserts the result
// equals the authored IR reduced to the "KC floor" -- the model with exactly
// the documented losses and normalizations applied (`stripToKcFloor`). Applying
// that same reduction to BOTH sides makes `toEqual` flag only UNDOCUMENTED
// divergence, so a new emitter/reader regression (a dropped column, a lost
// description, an un-stripped M:N edge) fails here even though every individual
// loss is already pinned by a targeted test above.
describe(
    'symmetry: an emit -> read round trip drops only documented fields', () => {
      const CORPUS = [
        'sales_bq_graph_target.yaml',
        'star_orders_customer.yaml',
        'tpcds_date_edge.yaml',
      ];
      // Same load defaults as the OSI / KC / pull goldens.
      const LOAD = {defaultProject: 'sqlgen-testing', defaultDataset: 'demo'};

      for (const fixture of CORPUS) {
        test(fixture, () => {
          const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
          for (const authored of loadModels(text, LOAD).models) {
            const {models, warnings} = roundTrip(authored);
            expect(models).toHaveLength(1);
            expect(stripToKcFloor(models[0])).toEqual(stripToKcFloor(authored));
            // A clean corpus model round-trips without reader warnings.
            expect(warnings).toEqual([]);
          }
        });
      }
    });


// Reduces a model to the "KC floor": the most an emit -> read round trip can
// preserve, i.e. the authored model with exactly the documented Knowledge
// Catalog losses and normalizations applied. Idempotent (already-floored input
// is unchanged), so it can be applied to both sides of a round trip. Each
// transform mirrors one emitter/reader behavior pinned by a targeted test
// above.
function stripToKcFloor(model: SemanticModel): SemanticModel {
  const m = structuredClone(model);

  // Model ai_context is not persisted; only a GOOGLE deployment-targets block
  // rides back, re-serialized to the reader's canonical JSON form.
  delete m.aiContext;
  const ext = canonicalGoogleExt(m.customExtensions);
  if (ext) {
    m.customExtensions = ext;
  } else {
    delete m.customExtensions;
  }

  for (const e of m.entities) {
    e.keys = [];  // keys / unique keys are never persisted
    delete e.uniqueKeys;
    delete e.aiContext;
    delete e.customExtensions;
    for (const f of e.fields) {
      delete f.label;  // display label is not persisted
      delete f.aiContext;
      delete f.importedExpression;  // vendor SQL is not persisted
      delete f.importedDialect;
      delete f.customExtensions;
      // A default push omits the per-field `semantics` block, so the field
      // expression and the DIMENSION role are not persisted (they ride back
      // only through a `--emit-expressions` push).
      delete f.expression;
      delete f.dimension;
      // Field types round-trip through dataType + metadataType: String is
      // indistinguishable from an un-typed field on read (both plain STRING),
      // while an un-typed field is emitted as Opaque (STRING + OTHER) and so
      // reads back as Opaque.
      if (f.type === 'String') {
        delete f.type;
      } else if (f.type === undefined) {
        f.type = 'Opaque';
      }
    }
  }

  for (const metric of m.metrics) {
    delete metric.aiContext;
    delete metric.importedExpression;
    delete metric.importedDialect;
    delete metric.customExtensions;
    delete metric.expression;  // omitted by a default push, like field ones
    // The metric aspect stores only a dataType (no metadataType), so it cannot
    // encode Opaque: a typeless metric, String, and Opaque all emit a bare
    // STRING dataType that reads back un-typed. A concrete type like Decimal
    // (NUMERIC) round-trips.
    if (metric.type === 'String' || metric.type === 'Opaque') {
      delete metric.type;
    }
  }

  // M:N (association) edges are never published; a 1:1 / 1:N name comes back
  // normalized via the emitter's slug (its exact form is pinned above).
  m.relationships = m.relationships.filter(r => !r.association).map(r => {
    const rel = structuredClone(r);
    rel.name = linkNamePrefix(rel.name);
    delete rel.aiContext;
    delete rel.customExtensions;
    return rel;
  });

  return m;
}


// The inverse-canonical of the emitter's deployment-target persistence,
// matching the reader's readDeploymentTargets: keep only GOOGLE
// deploymentTargets and re-serialize them so an authored block and its
// round-tripped form (which the reader always JSON.stringifies afresh) compare
// equal. Returns undefined when the model declares none, exactly as the reader
// omits custom_extensions then.
function canonicalGoogleExt(exts: CustomExtension[]|undefined):
    CustomExtension[]|undefined {
  const targets: string[] = [];
  for (const ext of exts ?? []) {
    if (ext.vendorName !== 'GOOGLE') continue;
    let parsed: any;
    try {
      parsed = JSON.parse(ext.data);
    } catch {
      continue;
    }
    for (const t of parsed?.deploymentTargets ?? []) {
      if (typeof t === 'string' && t) targets.push(t);
    }
  }
  return targets.length ? [{
    vendorName: 'GOOGLE',
    data: JSON.stringify({deploymentTargets: targets})
  }] :
                          undefined;
}
