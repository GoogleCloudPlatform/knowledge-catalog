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

import {describe, expect, mock, spyOn, test} from 'bun:test';

import type {OverviewSidecar} from '../../../src/libts/layouts/semantic-model';
import {DataType, Entity, SemanticModel} from '../../../src/libts/semantic/ir';
import {semanticLinkId} from '../../../src/libts/semantic/kc_ids';
import {generateCatalogResources, KcGenerateOptions} from '../../../src/libts/semantic/knowledge_catalog';
import {loadModels} from '../../../src/libts/semantic/loader';
import * as resolveInheritanceModule from '../../../src/libts/semantic/resolve_inheritance';
import {applyProfileFile, loadProfileFile, mergeProfileOntoDoc} from '../../../src/libts/semantic/resolve_profiles';

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

const V2 = {...OPTS, v2Aspects: true};
const V2_EXPR = {...V2, emitExpressions: true};
const KEY = (type: string) => `dataplex-types.global.${type}`;
const DATAPLEX = 'projects/dataplex-types/locations/global';
const EG = 'projects/dest-proj/locations/us/entryGroups/eg';
// A link of type `type` with id `id` from entry `from` to entry `to`.
const DIRECTED = (type: string, id: string, from: string, to: string) => ({
  name: `${EG}/entryLinks/${id}`,
  entryLinkType: `${DATAPLEX}/entryLinkTypes/${type}`,
  entryReferences: [
    {name: `${EG}/entries/${from}`, type: 'SOURCE' as const},
    {name: `${EG}/entries/${to}`, type: 'TARGET' as const},
  ],
});
const TABLE = (t: string) =>
    `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
const GRAPH = (g: string) =>
    `bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/${g}`;
// The entry whose name ends in /entries/<suffix>, emitted under V2 unless
// `opts` says otherwise, and the data of one of its aspects.
function entry(
    model: SemanticModel, suffix: string, opts: KcGenerateOptions = V2) {
  return generateCatalogResources(model, opts)
      .entries.find(e => e.name.endsWith(`/entries/${suffix}`))!;
}
function data(model: SemanticModel, suffix: string, type: string,
              opts: KcGenerateOptions = V2): any {
  return entry(model, suffix, opts).aspects![KEY(type)]?.data;
}
const load = (text: string): SemanticModel =>
    loadModels(text, {bindingOptional: true}).models[0];
// Loads the profile `name` whose other keys are the YAML `body`.
const PROFILE = (name: string, body: string) =>
    loadProfileFile(`name: ${name}\n${body}`, name);
// The data of a guidelines aspect and of an overview aspect.
const GUIDE = (instructions: string) => ({instructions, userManaged: true});
const EXAMPLES = (...texts: string[]) =>
    ({examples: texts.map(content => ({content}))});
// A YAML entity over table p.d.<name> with an `id` field and the given key.
const ENTITY_YAML = (name: string, key = '[id]') => `      - name: ${name}
        source: ${TABLE(name)}
        primary_key: ${key}
        fields:
          - { name: id, expression: id }`;
// A vanilla model `shop` over table p.d.orders, with the given data in its
// GOOGLE block and the given YAML lines at the end of the model.
const vanilla = (block: object, more = '') => load(`version: "0.2.0.dev0"
semantic_model:
  - name: shop
    custom_extensions:
      - {vendor_name: GOOGLE, data: '${JSON.stringify(block)}'}
    datasets:
      - name: orders
        source: ${TABLE('orders')}
        primary_key: [id]
        fields:
          - name: id
            expression: {dialects: [{dialect: ANSI_SQL, expression: id}]}
${more}`);
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
      'a clean project.dataset.table becomes the BigQuery table\'s resource name',
      () => {
        expect(resources('proj.ds.tbl')).toEqual([
          'bigquery.googleapis.com/projects/proj/datasets/ds/tables/tbl',
        ]);
      });
  test('a query-like source is kept verbatim', () => {
    expect(resources('SELECT 1')).toEqual(['SELECT 1']);
  });
  test('an under-qualified reference is kept verbatim', () => {
    expect(resources('ds.tbl')).toEqual(['ds.tbl']);
  });
  test('a source containing / or : is returned unchanged', () => {
    const spUri = '//spanner.googleapis.com/projects/p/instances/i/databases/db/tables/Orders';
    const mysqlCat = 'cloudsql_mysql:acme.us.inst.shop.payments';
    expect(resources(spUri)).toEqual([spUri]);
    expect(resources(mysqlCat)).toEqual([mysqlCat]);
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
      'a Spanner-targeted model records its Spanner target in the semantic-model aspect',
      () => {
        // A model bound to Spanner Graph must not lose its deployment target in
        // Knowledge Catalog (the aspect used to read only BigQuery targets, so a
        // Spanner-only model round-tripped as UNBOUND).
        const spannerUri =
            'spanner.googleapis.com/projects/p/instances/i/databases/db/graphs/g';
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
      'a model targeting Spanner, BigQuery, and AlloyDB records all three targets in declaration order',
      () => {
        const bqUri =
            'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
        const spannerUri =
            'spanner.googleapis.com/projects/p/instances/i/databases/db/graphs/g';
        const alloyUri =
            'alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/instances/i/databases/db';
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [{name: 'e', dataSource: 'p.d.t', keys: ['k'], fields: []}],
          customExtensions: [{
            vendorName: 'GOOGLE',
            data: JSON.stringify({deploymentTargets: [spannerUri, bqUri, alloyUri]}),
          }],
        };
        const {entries} = generateCatalogResources(model, OPTS);
        const anchor = entries[0];
        expect(anchor.aspects!['dataplex-types.global.semantic-model'].data)
            .toEqual({deploymentTargets: [spannerUri, bqUri, alloyUri]});
      });

  test(
      'a model preserves every declared target in order even when deployment_target.ts does not recognize it',
      () => {
        const clusterAlloyUri =
            'alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/databases/db';
        const alloyCatalogName = 'alloydb:p.us-central1.c.db';
        const bqUri =
            'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
        const customTarget = 'bigquery.googleapis.com/projects/p/datasets/d/tables/graph_name';
        const targets =
            [clusterAlloyUri, bqUri, alloyCatalogName, customTarget];
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [{name: 'e', dataSource: 'p.d.t', keys: ['k'], fields: []}],
          customExtensions: [{
            vendorName: 'GOOGLE',
            data: JSON.stringify({deploymentTargets: targets}),
          }],
        };
        const {entries} = generateCatalogResources(model, OPTS);
        const anchor = entries[0];
        expect(anchor.aspects!['dataplex-types.global.semantic-model'].data)
            .toEqual({deploymentTargets: targets});
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
        name: 'placed',
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
    expect(link.name!.endsWith('/entryLinks/m-placed')).toBe(true);
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
                   w => w.includes('relationship \'placed\'') &&
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
               w => w.includes('relationship \'placed\'') &&
                   w.includes('ghost')))
        .toBe(true);
  });

  test('a column-less (purely logical) edge is skipped and warned, no link',
       () => {
         // An OWL import leaves an edge with no join columns. schema-join is a
         // server CLOSED template, so rather than risk a rejected column-less
         // aspect the emitter skips the link (the edge publishes once join
         // columns are added to the model).
         const model = directFkModel();
         model.relationships[0].source.columns = [];
         model.relationships[0].destination.columns = [];
         const {entryLinks, warnings} = generateCatalogResources(model, OPTS);
         expect(entryLinks.length).toBe(0);
         expect(warnings.some(
                    w => w.includes('relationship \'placed\'') &&
                        w.includes('no join columns')))
             .toBe(true);
       });

  test(
      'a relationship name that is not link-id-clean warns it will normalize',
      () => {
        const model = directFkModel();
        // Underscores + uppercase are not valid in a link id, so the emitter
        // slugs the name into the link id; a pull can only recover that slugged
        // form. Warn so the author knows the round trip renames it.
        model.relationships[0].name = 'Orders_To_Customer';
        const {entryLinks, warnings} = generateCatalogResources(model, OPTS);
        expect(entryLinks.length).toBe(1);
        expect(warnings.some(
                   w => w.includes('Orders_To_Customer') &&
                       w.includes("'orders_to_customer'")))
            .toBe(true);
      });

  test(
      'two relationships between the same pair of entities, flag off, ' +
          'emit one link and warn on the second',
      () => {
        const model = directFkModel();
        model.relationships = [
          {
            name: 'billing',
            source: {entity: 'orders', columns: ['billing_custkey']},
            destination: {entity: 'customer', columns: ['c_key']},
          },
          {
            name: 'shipping',
            source: {entity: 'customer', columns: ['c_key']},
            destination: {entity: 'orders', columns: ['shipping_custkey']},
          },
        ];

        const {entryLinks, warnings} = generateCatalogResources(model, OPTS);

        expect(entryLinks.map(l => l.name)).toEqual([
          'projects/dest-proj/locations/us/entryGroups/eg/entryLinks/' +
              'm-billing',
        ]);
        expect(warnings).toEqual([
          'relationship \'shipping\': shares entities \'customer\' ' +
              'and \'orders\' with relationship \'billing\'; ' +
              'skipped because the catalog shows one join for those entities.',
        ]);
      });

  test(
      'two relationships that share one entity on different pairs both ' +
          'emit a link',
      () => {
        // `customer` sorts first in both pairs, so a pair key built from one
        // entity alone would wrongly skip the second relationship.
        const model = directFkModel();
        model.entities.push({
          name: 'supplier',
          dataSource: 'p.d.supplier',
          keys: ['s_key'],
          fields: [],
        });
        model.relationships = [
          {
            name: 'billing',
            source: {entity: 'orders', columns: ['custkey']},
            destination: {entity: 'customer', columns: ['c_key']},
          },
          {
            name: 'sourcing',
            source: {entity: 'customer', columns: ['suppkey']},
            destination: {entity: 'supplier', columns: ['s_key']},
          },
        ];

        const {entryLinks, warnings} = generateCatalogResources(model, OPTS);

        expect(entryLinks.map(l => l.name)).toEqual([
          'projects/dest-proj/locations/us/entryGroups/eg/entryLinks/m-billing',
          'projects/dest-proj/locations/us/entryGroups/eg/entryLinks/' +
              'm-sourcing',
        ]);
        expect(warnings).toEqual([]);
      });

  test(
      'an unpublishable relationship does not claim the entity pair ' +
          'ahead of a valid relationship',
      () => {
        const model = directFkModel();
        model.relationships = [
          {
            name: 'assoc',
            source: {entity: 'orders', columns: ['custkey']},
            destination: {entity: 'customer', columns: ['c_key']},
            association: {
              dataSource: 'p.d.order_customer',
              keys: ['id'],
              sourceColumns: ['o_key'],
              destinationColumns: ['c_key'],
            },
          },
          {
            name: 'placed',
            source: {entity: 'orders', columns: ['custkey']},
            destination: {entity: 'customer', columns: ['c_key']},
          },
        ];

        const {entryLinks, warnings} = generateCatalogResources(model, OPTS);

        expect(entryLinks.map(l => l.name)).toEqual([
          'projects/dest-proj/locations/us/entryGroups/eg/entryLinks/' +
              'm-placed',
        ]);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('relationship \'assoc\'');
      });

  test(
      'an unpublishable relationship after a valid relationship on the same ' +
          'entity pair or on a self-relationship warns with its ' +
          'unpublishable reason',
      () => {
        const model = directFkModel();
        model.relationships = [
          {
            name: 'placed',
            source: {entity: 'orders', columns: ['custkey']},
            destination: {entity: 'customer', columns: ['c_key']},
          },
          {
            name: 'assoc',
            source: {entity: 'orders', columns: ['custkey']},
            destination: {entity: 'customer', columns: ['c_key']},
            association: {
              dataSource: 'p.d.order_customer',
              keys: ['id'],
              sourceColumns: ['o_key'],
              destinationColumns: ['c_key'],
            },
          },
          {
            name: 'self_assoc',
            source: {entity: 'orders', columns: ['o_key']},
            destination: {entity: 'orders', columns: ['o_key']},
            association: {
              dataSource: 'p.d.order_related',
              keys: ['id'],
              sourceColumns: ['o_key'],
              destinationColumns: ['related_key'],
            },
          },
        ];
        const {entryLinks, warnings} = generateCatalogResources(model, OPTS);
        expect(entryLinks.map(l => l.name)).toEqual([
          'projects/dest-proj/locations/us/entryGroups/eg/entryLinks/' +
              'm-placed',
        ]);
        expect(warnings).toEqual([
          'relationship \'assoc\': many-to-many (association) edges are not ' +
              'published to Knowledge Catalog yet; the edge lives in the ' +
              'BigQuery property graph.',
          'relationship \'self_assoc\': many-to-many (association) edges are ' +
              'not published to Knowledge Catalog yet; the edge lives in the ' +
              'BigQuery property graph.',
        ]);
      });

  test(
      'a column-less relationship after a valid one on the same pair warns ' +
          'about its join columns, and one on an unpublished entity warns ' +
          'about that entity',
      () => {
        const model = directFkModel();
        model.relationships = [
          {
            name: 'placed',
            source: {entity: 'orders', columns: ['custkey']},
            destination: {entity: 'customer', columns: ['c_key']},
          },
          {
            name: 'logical',
            source: {entity: 'orders', columns: []},
            destination: {entity: 'customer', columns: []},
          },
          {
            name: 'ghost_rel',
            source: {entity: 'ghost', columns: ['c_key']},
            destination: {entity: 'customer', columns: ['c_key']},
          },
        ];

        const {entryLinks, warnings} = generateCatalogResources(model, OPTS);

        expect(entryLinks.map(l => l.name)).toEqual([
          'projects/dest-proj/locations/us/entryGroups/eg/entryLinks/' +
              'm-placed',
        ]);
        expect(warnings).toEqual([
          'relationship \'logical\': no join columns, so it is not published ' +
              'to Knowledge Catalog yet; add its from_columns and to_columns ' +
              'to the relationship in the model to publish the link.',
          'relationship \'ghost_rel\': endpoint entity \'ghost\' is not a ' +
              'published entity; the relationship link is skipped.',
        ]);
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
        name: 'placed',
        source: {entity: 'orders', columns: ['custkey']},
        destination: {entity: 'customer', columns: ['c_key']},
      }],
    };
  }

  test('every entity is published (anchor + 2 entities), no warnings', () => {
    const {entries, warnings} = generateCatalogResources(logicalModel(), OPTS);
    const kinds = entries.map(e => e.entryType.replace(/.*\//, ''));
    expect(kinds).toEqual(
        ['semantic-model', 'semantic-entity', 'semantic-entity']);
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


describe('a field a binding profile excludes', () => {
  // Pruning marks a field excluded on an entity another extends, and a pruned
  // push publishes what the profile answers.
  test('is left out of the schema aspect once pruning marks it', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'e', dataSource: 'p.d.t', keys: ['k'],
        fields: [{name: 'k', expression: 'k'}, {name: 'secret', expression: 'secret'}],
        excludedFields: ['secret'],
      }],
      relationships: [], metrics: [],
    };
    const {entries} = generateCatalogResources(model, OPTS);
    const entity = entries.find(e => e.entryType.endsWith('/semantic-entity'))!;
    const fields = entity.aspects!['dataplex-types.global.schema'].data!.fields;
    expect(fields.map((f: any) => f.name)).toEqual(['k']);
  });

  // A catalog-only push publishes the whole logical model,
  // so it applies none of the exclusions the merge returns.
  test('is still published by a catalog-only push, with an excluded metric', () => {
    const merged = mergeProfileOntoDoc(`version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: orders
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders
        primary_key: [id]
        fields:
          - { name: id, expression: id }
          - { name: amount, expression: amount }
          - { name: secret, expression: secret }
    metrics:
      - { name: revenue, expression: SUM(orders.amount) }
`, `name: ops
entities:
  - name: orders
    source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders_ops
    fields_exclude: [secret]
metrics_exclude: "*"
`, 'ops');
    if ('error' in merged) throw new Error(merged.error);
    expect(merged.excluded).toEqual([
      {model: 'shop', entity: 'orders', field: 'secret'},
      {model: 'shop', metric: 'revenue'},
    ]);
    const {models} = loadModels(merged.text, {bindingOptional: true});
    const {entries} = generateCatalogResources(models[0], OPTS);
    const entity = entries.find(e => e.entryType.endsWith('/semantic-entity'))!;
    expect(entity.aspects!['dataplex-types.global.schema'].data!.fields
               .map((f: any) => f.name))
        .toEqual(['id', 'amount', 'secret']);
    expect(entries.filter(e => e.entryType.endsWith('/semantic-metric')).length)
        .toBe(1);
  });
});


describe('each model and profile file is stored in a file-copy entry', () => {
  const MODEL: SemanticModel = {
    name: 'retail',
    entities: [{name: 'e', dataSource: 'p.d.t', keys: ['k'], fields: []}],
    relationships: [],
    metrics: [],
  };
  const FILES = [
    {fileName: 'retail.yaml', content: '# the model\nversion: x\n'},
    {fileName: 'retail.profiles/prod.yaml', content: 'name: prod\n'},
    {fileName: 'retail.profile.dev.yaml', content: 'name: dev\n'},
  ];
  const copies = (opts: Record<string, any>) =>
      generateCatalogResources(MODEL, {...OPTS, ...opts})
          .entries.filter(e => e.entryType.endsWith('/semantic-model-file'));

  test('one child entry of the model entry per file', () => {
    const entries = copies({sourceFiles: FILES});
    const prefix = 'projects/dest-proj/locations/us/entryGroups/eg/entries/';
    expect(entries.map(e => e.name)).toEqual([
      `${prefix}retail.files.retail.yaml`,
      `${prefix}retail.files.retail.profiles_prod.yaml`,
      `${prefix}retail.files.retail.profile.dev.yaml`,
    ]);
    // The type is custom, so it lives in the destination project.
    expect(entries[0]).toEqual({
      name: `${prefix}retail.files.retail.yaml`,
      entryType:
          'projects/dest-proj/locations/global/entryTypes/semantic-model-file',
      parentEntry: `${prefix}retail`,
      aspects: {
        'dest-proj.global.semantic-model-file': {
          aspectType: 'projects/dest-proj/locations/global/aspectTypes/' +
              'semantic-model-file',
          data: FILES[0],
        },
      },
    });
  });

  test('none with v2Aspects on, and none without sourceFiles', () => {
    expect(copies({sourceFiles: FILES, v2Aspects: true})).toEqual([]);
    expect(copies({})).toEqual([]);
  });

  // A pull compares the label with the push id on the copies.
  test('the model entry carries the copies\' push id in the kcmd-push-id ' +
           'label, only when copies are stored',
       () => {
         const anchor = (opts: Record<string, any>) =>
             generateCatalogResources(MODEL, {...OPTS, ...opts}).entries[0];
         const stamped = FILES.map(f => ({...f, pushId: 'push-7'}));
         expect(anchor({sourceFiles: stamped}).entrySource).toEqual({
           displayName: 'retail',
           labels: {'kcmd-push-id': 'push-7'},
         });
         expect(anchor({sourceFiles: stamped, v2Aspects: true}).entrySource)
             .toEqual({displayName: 'retail'});
         expect(anchor({}).entrySource).toEqual({displayName: 'retail'});
       });

  // `slug` turns a space into `_`, and names in the older profile directory
  // are not checked, so two of them can share an id.
  test('two file names that map to one entry id throw, naming both', () => {
    expect(() => copies({
             sourceFiles: [
               {fileName: 'retail.profiles/a b.yaml', content: 'x'},
               {fileName: 'retail.profiles/a_b.yaml', content: 'y'},
             ]
           }))
        .toThrow(
            'files \'retail.profiles/a b.yaml\' and ' +
            '\'retail.profiles/a_b.yaml\' both map to entry id ' +
            '\'retail.files.retail.profiles_a_b.yaml\'; rename one of them');
  });

  test('every copy sits under a prefix the model owns', () => {
    const {entries, ownedPrefixes} =
        generateCatalogResources(MODEL, {...OPTS, sourceFiles: FILES});
    for (const e of entries.filter(
             e => e.entryType.endsWith('/semantic-model-file'))) {
      const id = e.name.split('/').pop()!;
      expect(ownedPrefixes.some(p => id.startsWith(p))).toBe(true);
    }
  });
});


describe('an entity source is stored as written', () => {
  function sourceRecord(authoredSource: string, dataSource: string) {
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities:
          [{name: 'e', authoredSource, dataSource, keys: ['k'], fields: []}],
    };
    const {entries} = generateCatalogResources(model, OPTS);
    const entity = entries.find(e => e.entryType.endsWith('/semantic-entity'))!;
    return entity.aspects!['dataplex-types.global.semantic-entity']
        .data!.source;
  }

  test('a resource name stays in resources unchanged', () => {
    const name =
        'spanner.googleapis.com/projects/p/instances/i/databases/db/tables/Orders';
    expect(sourceRecord(name, `//${name}`)).toEqual({resources: [name]});
  });
});


describe('a third-party custom_extensions block is noted once', () => {
  const NOTE = 'custom_extensions from vendors other than GOOGLE are not ' +
      'indexed by the Knowledge Catalog aspects; the stored copy of the ' +
      'model file preserves them';
  const SOURCE_FILES = [{fileName: 'm.yaml', content: 'x'}];
  const withExtensions =
      (model: SemanticModel['customExtensions'],
       field: SemanticModel['customExtensions']): SemanticModel => ({
        name: 'm',
        customExtensions: model,
        entities: [{
          name: 'e',
          dataSource: 'p.d.t',
          keys: ['k'],
          fields: [{name: 'k', customExtensions: field}],
        }],
        relationships: [],
        metrics: [],
      });

  test('once, however many blocks there are', () => {
    const model = withExtensions(
        [{vendorName: 'GOODDATA', data: '{}'}],
        [{vendorName: 'LOOKER', data: '{}'}]);
    const {warnings} = generateCatalogResources(
        model, {...OPTS, sourceFiles: SOURCE_FILES});
    expect(warnings.filter(w => w === NOTE)).toHaveLength(1);
  });

  test('not at all with KC_V2_ASPECTS on', () => {
    const model =
        withExtensions([{vendorName: 'GOODDATA', data: '{}'}], undefined);
    const {warnings} = generateCatalogResources(
        model, {...OPTS, sourceFiles: SOURCE_FILES, v2Aspects: true});
    expect(warnings).not.toContain(NOTE);
  });

  test('for a block on a field alone', () => {
    const model =
        withExtensions(undefined, [{vendorName: 'LOOKER', data: '{}'}]);
    const {warnings} = generateCatalogResources(
        model, {...OPTS, sourceFiles: SOURCE_FILES});
    expect(warnings).toContain(NOTE);
  });

  test('for a block on an entity, a relationship, a metric or an action alone',
       () => {
         const block = [{vendorName: 'LOOKER', data: '{}'}];
         const base = withExtensions(undefined, undefined);
         const entity = base.entities[0];
         const relationship = {
           name: 'r',
           source: {entity: 'e', columns: []},
           destination: {entity: 'e', columns: []},
         };
         const metric = {name: 'n', expression: 'COUNT(*)'};
         const action = {name: 'a', parameters: []};
         const variants: SemanticModel[] = [
           {...base, entities: [{...entity, customExtensions: block}]},
           {...base, relationships: [{...relationship, customExtensions: block}]},
           {...base, metrics: [{...metric, customExtensions: block}]},
           {...base, actions: [{...action, customExtensions: block}]},
         ];
         for (const model of variants) {
           const {warnings} = generateCatalogResources(
               model, {...OPTS, sourceFiles: SOURCE_FILES});
           expect(warnings).toContain(NOTE);
         }
       });

  test('not at all with only a GOOGLE block', () => {
    const model = withExtensions(
        [{vendorName: 'GOOGLE', data: '{"deploymentTargets":[]}'}], undefined);
    const {warnings} = generateCatalogResources(
        model, {...OPTS, sourceFiles: SOURCE_FILES});
    expect(warnings).not.toContain(NOTE);
  });
});


describe('a subtype field that only rebinds an inherited field', () => {
  const MODEL_FILE = (customerFields: string) => `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: Party
        abstract: true
        fields:
          - { name: id, datatype: Integer, description: The party id, label: Party ID }
      - name: Customer
        extends: [Party]
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/customer
        primary_key: [id]
        fields:
${customerFields}`;
  const ANCESTOR = {
    name: 'id',
    dataType: 'INT64',
    metadataType: 'NUMBER',
    description: 'The party id',
    annotations: {label: 'Party ID'},
  };

  function customerField(
      model: SemanticModel, name: string, v2Aspects = false): any {
    const {entries} = generateCatalogResources(model, {...OPTS, v2Aspects});
    const customer = entries.find(e => e.entrySource?.displayName === 'Customer')!;
    return customer.aspects!['dataplex-types.global.schema'].data!.fields.find(
        (f: any) => f.name === name);
  }

  test('is published with the ancestor\'s datatype, description and label',
       () => {
         const {models} = loadModels(
             MODEL_FILE('          - { name: id, expression: cust_id }\n'),
             {bindingOptional: true});
         expect(customerField(models[0], 'id')).toEqual(ANCESTOR);
         // The second-generation layout lists inherited fields another way.
         expect(customerField(models[0], 'id', true).dataType).toBe('STRING');
       });

  // Push rejects a subtype that sets a definition on an inherited field, so
  // only the emitter's own rule is exercised here.
  test('keeps a datatype, description and label it sets itself', () => {
    const {models} = loadModels(
        MODEL_FILE('          - { name: id, expression: cust_id }\n'),
        {bindingOptional: true});
    const model = structuredClone(models[0]);
    const id = model.entities.find(e => e.name === 'Customer')!.fields[0];
    Object.assign(id, {
      type: 'String',
      description: 'The customer id',
      label: 'Customer ID',
    });
    expect(customerField(model, 'id')).toEqual({
      name: 'id',
      dataType: 'STRING',
      metadataType: 'STRING',
      description: 'The customer id',
      annotations: {label: 'Customer ID'},
    });
  });

  test('an error from resolving inheritance that is not an InheritanceError ' +
           'is not swallowed',
       () => {
         const {models} = loadModels(
             MODEL_FILE('          - { name: id, expression: cust_id }\n'),
             {bindingOptional: true});
         spyOn(resolveInheritanceModule, 'resolveInheritance')
             .mockImplementation(() => {
               throw new Error('resolver bug');
             });
         try {
           expect(() => customerField(models[0], 'id')).toThrow('resolver bug');
         } finally {
           mock.restore();
         }
       });

  test('is published the same way when a profile rebinds it', () => {
    const {models} = loadModels(
        MODEL_FILE('          - { name: tier, datatype: String }\n'),
        {bindingOptional: true});
    const applied = applyProfileFile(models[0], `name: prod
entities:
  - name: Customer
    fields:
      - { name: id, expression: cust_key }
`, 'prod');
    if ('error' in applied) throw new Error(applied.error);
    expect(customerField(applied.model, 'id')).toEqual(ANCESTOR);
  });
});


describe('with KC_V2_ASPECTS on, the model and its metrics', () => {
  const MODEL_FILE = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    ai_context:
      instructions: Sales data.
      synonyms: [revenue_model]
      custom:
        owner: analytics
        tier: 1.5
        tags: {pii: false, area: [emea, apac]}
    custom_extensions:
      - {vendor_name: DBT, data: '{"materialized": "table"}'}
      - {vendor_name: LOOKER, data: 'not json at all'}
      - {vendor_name: DBT, data: '{"materialized": "table"}'}
    deployments:
      - {name: main, target: ${GRAPH('g')}}
      - {name: ana, target: ${GRAPH('h')}, profile: analytical}
      - {name: plain, target: ${GRAPH('i')}, profile: default}
    entities:
${ENTITY_YAML('orders')}
          - { name: amount, expression: amount }
    metrics:
      - name: revenue
        expression: SUM(orders.amount)
        datatype: Decimal
        ai_context: {synonyms: [sales, turnover], custom: {unit: USD, scale: ~}}
      - name: order_count
        entity: orders
        expression:
          dialects:
            - { dialect: BIGQUERY, expression: COUNT(*) }
            - { dialect: ANSI_SQL, expression: COUNT(1) }
      - name: opaque_metric
        expression: MAX(orders.amount)
        datatype: Opaque
`;
  const loaded = () => load(MODEL_FILE);
  const metric = (model: SemanticModel, name: string,
                  type = 'semantic-metric', opts = V2) =>
      data(model, `${model.name}/metrics/${name}`, type, opts);
  const excluded = (model: SemanticModel, name: string) =>
      metric(model, name).excludedInProfiles;

  test('semantic-extensions holds every third-party block in order, ' +
           'duplicates included, on its own entry, and is left out when the ' +
           'only block is GOOGLE\'s',
       () => {
         const model = loaded();
         // The loader folds the deployments into a GOOGLE block.
         expect(model.customExtensions!.some(x => x.vendorName === 'GOOGLE'))
             .toBe(true);
         const DBT = {vendorName: 'DBT', data: '{"materialized": "table"}'};
         expect(data(model, 'sales', 'semantic-extensions')).toEqual({
           customExtensions:
               [DBT, {vendorName: 'LOOKER', data: 'not json at all'}, DBT],
         });
         model.metrics[0].customExtensions =
             [{vendorName: 'Google', data: '{}'}];
         expect(metric(model, 'revenue', 'semantic-extensions'))
             .toEqual({customExtensions: [{vendorName: 'Google', data: '{}'}]});
         model.customExtensions =
             model.customExtensions!.filter(x => x.vendorName === 'GOOGLE');
         model.metrics[0].customExtensions =
             [{vendorName: 'GOOGLE', data: '{"entity": "orders"}'}];
         expect(data(model, 'sales', 'semantic-extensions')).toBeUndefined();
         expect(metric(model, 'revenue', 'semantic-extensions'))
             .toBeUndefined();
       });

  test('the model aspect holds the version, synonyms, named profiles and ' +
           'deployments, no deploymentTargets list or extension blocks, ' +
           'leaves out what would be empty, and defaults the version',
       () => {
         const model = loaded();
         model.profiles =
             ['analytical', 'ops'].map(n => PROFILE(n, 'metrics_exclude: []'));
         expect(data(model, 'sales', 'semantic-model')).toEqual({
           specVersion: '0.2.0.dev0/google',
           synonyms: ['revenue_model'],
           profiles: [{name: 'analytical'}, {name: 'ops'}],
           deployments: [
             {name: 'main', target: GRAPH('g')},
             {name: 'ana', target: GRAPH('h'), profile: 'analytical'},
             {name: 'plain', target: GRAPH('i')},
           ],
         });
         const bare: SemanticModel = {
           name: 'bare',
           entities: [],
           relationships: [],
           metrics: [],
           profiles: [{name: 'default', entities: [], relationships: []}],
           deployments: [],
           aiContext: {synonyms: []},
         };
         expect(data(bare, 'bare', 'semantic-model'))
             .toEqual({specVersion: '0.2.0.dev0/google'});
         bare.version = '0.2.0.dev0';
         expect(data(bare, 'bare', 'semantic-model'))
             .toEqual({specVersion: '0.2.0.dev0'});
       });

  test('a vanilla model\'s deploymentTargets become deployments named ' +
           'default or deployment_<n>',
       () => {
         const targets = (...graphs: string[]) => data(
             vanilla({deploymentTargets: graphs.map(GRAPH)}), 'shop',
             'semantic-model');
         expect(targets('g')).toEqual({
           specVersion: '0.2.0.dev0',
           deployments: [{name: 'default', target: GRAPH('g')}],
         });
         expect(targets('g', 'h')).toEqual({
           specVersion: '0.2.0.dev0',
           deployments: [
             {name: 'deployment_1', target: GRAPH('g')},
             {name: 'deployment_2', target: GRAPH('h')},
           ],
         });
       });

  test('a metric records its canonical data type with the metadataType it ' +
           'maps to, its synonyms and its entity, declared or derived',
       () => {
         const model = loaded();
         // The loader derives `orders` for revenue; only order_count wrote it.
         expect(model.metrics[0].authoredEntity).toBeUndefined();
         expect(metric(model, 'revenue')).toEqual({
           entity: 'orders',
           dataType: 'Decimal',
           metadataType: 'NUMBER',
           synonyms: ['sales', 'turnover'],
         });
         expect(metric(model, 'order_count')).toEqual({
           entity: 'orders',
           dataType: 'Opaque',
           metadataType: 'OTHER',
         });
         expect(metric(model, 'opaque_metric')).toEqual(
             {entity: 'orders', dataType: 'Opaque', metadataType: 'OTHER'});
       });

  test('a profile excluding every metric is on every metric entry, and one ' +
           'with a list is on the metrics it names, in profile order',
       () => {
         const model = loaded();
         model.profiles = [
           PROFILE('zeta', 'metrics_exclude: [revenue]'),
           PROFILE('all', 'metrics_exclude: "*"'),
           PROFILE('Beta', 'metrics_exclude: [revenue, order_count]'),
           PROFILE('none', 'metrics_exclude: []'),
         ];
         expect(excluded(model, 'revenue')).toEqual(['zeta', 'all', 'Beta']);
         expect(excluded(model, 'order_count')).toEqual(['all', 'Beta']);
         expect(excluded(model, 'opaque_metric')).toEqual(['all']);
       });

  test('a short-form expression is written with no dialect, name or ' +
           'qualifier, a dialect list one record per entry, and ' +
           'semantic-metric carries no expression, even under emitExpressions',
       () => {
         const model = loaded();
         expect(metric(model, 'revenue', 'sql-expressions'))
             .toEqual({expressions: [{sql: 'SUM(orders.amount)'}]});
         expect(metric(model, 'revenue', 'semantic-metric', V2_EXPR).expression)
             .toBeUndefined();
         expect(metric(model, 'order_count', 'sql-expressions')).toEqual({
           expressions: [
             {dialect: 'BIGQUERY', sql: 'COUNT(*)'},
             {dialect: 'ANSI_SQL', sql: 'COUNT(1)'},
           ],
         });
       });

  test('examples land in overview as content records, in order, with no ' +
           'title or content type, beside what the entry\'s sidecar holds, ' +
           'and nowhere with neither',
       () => {
         const model = loaded();
         model.metrics[1].aiContext = {examples: []};
         expect(metric(model, 'order_count', 'overview')).toBeUndefined();
         model.aiContext!.examples = ['Total sales last month?', 'By region'];
         model.metrics[1].aiContext = {examples: ['How many orders?']};
         expect(data(model, 'sales', 'overview'))
             .toEqual(EXAMPLES('Total sales last month?', 'By region'));
         expect(metric(model, 'order_count', 'overview'))
             .toEqual(EXAMPLES('How many orders?'));
         // A sidecar fills the rest of the instance, an empty one adds
         // nothing, and one with no entry warns.
         const sidecar = {content: '# Sales', contentType: 'MARKDOWN',
                          links: [{url: 'https://wiki/sales', title: 'Wiki'}]};
         const opts = {...V2, overviews: new Map<string, OverviewSidecar>([
           ['sales', sidecar], ['sales/metrics/revenue', {content: 'Net.'}],
           ['sales/metrics/opaque_metric', {}],
           ['sales/metrics/gone', {content: 'Old.'}],
         ])};
         expect(data(model, 'sales', 'overview', opts)).toEqual({
           ...sidecar, ...EXAMPLES('Total sales last month?', 'By region'),
         });
         expect(metric(model, 'revenue', 'overview', opts))
             .toEqual({content: 'Net.'});
         expect(metric(model, 'opaque_metric', 'overview', opts))
             .toBeUndefined();
         expect(generateCatalogResources(model, opts).warnings).toContain(
             'sidecar \'sales/metrics/gone.overview.md\' names no entry of ' +
             'this model; it is not pushed');
       });

  test('guidelines holds the instructions and, in data, the custom ' +
           'ai_context members as loaded, and is left out when an object ' +
           'has neither',
       () => {
         const model = loaded();
         expect(data(model, 'sales', 'guidelines')).toEqual({
           ...GUIDE('Sales data.'),
           data: {owner: 'analytics', tier: 1.5,
                  tags: {pii: false, area: ['emea', 'apac']}},
         });
         expect(data(model, 'sales', 'guidelines', OPTS))
             .toEqual(GUIDE('Sales data.'));
         expect(metric(model, 'revenue', 'guidelines'))
             .toEqual({data: {unit: 'USD', scale: null}, userManaged: true});
         expect(metric(model, 'order_count', 'guidelines')).toBeUndefined();
         model.metrics[1].aiContext = {instructions: 'Count them.'};
         expect(metric(model, 'order_count', 'guidelines'))
             .toEqual(GUIDE('Count them.'));
       });

  test('a custom member whose value holds .inf, -.inf, .nan or a number ' +
           'past 2^53, at any depth, is left out of data with a warning',
       () => {
         for (const [value, holds] of [
                ['.inf', '.inf'], ['-.inf', '-.inf'], ['[1, {n: .nan}]', '.nan'],
                ['9007199254740993', 'a number past 2^53'],
              ]) {
           const model = load(MODEL_FILE.replace('tier: 1.5', `tier: ${value}`));
           expect(data(model, 'sales', 'guidelines').data).toEqual(
               {owner: 'analytics', tags: {pii: false, area: ['emea', 'apac']}});
           expect(generateCatalogResources(model, V2).warnings).toContain(
               `model 'sales': ai_context member 'tier' is not pushed: its ` +
               `value holds ${holds}, which Knowledge Catalog cannot store ` +
               `as written`);
           expect(generateCatalogResources(model, OPTS).warnings).toEqual([]);
         }
       });
});


describe('with KC_V2_ASPECTS on, relationships', () => {
  const ENTRY = (id: string) => `${EG}/entries/${id}`;
  const MODEL_FILE = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    entities:
${ENTITY_YAML('orders')}
${ENTITY_YAML('customers', '[tenant, id]')}
${ENTITY_YAML('addresses')}
    relationships:
      - name: orders_to_customers
        from: orders
        to: customers
        from_columns: [tenant, cust_id]
        to_columns: [tenant, id]
        description: Each order belongs to one customer.
        ai_context:
          instructions: Join through this edge to reach customer attributes.
          synonyms: [placed_by]
          examples: [Which customer placed order 42?]
        custom_extensions:
          - {vendor_name: DBT, data: '{"relationship": true}'}
      - { name: Order_Billing, from: orders, to: customers,
          from_columns: ['\`bill cust\`'], to_columns: [id] }
      - { name: customer_address, from: customers, to: addresses }
      - { name: orders_to_ship_address, from: orders, to: addresses,
          from_columns: [ship_addr_id], to_columns: [id] }
`;
  const loaded = () => load(MODEL_FILE);
  const rel = (model: SemanticModel, name: string) =>
      data(model, `sales/relationships/${name}`, 'semantic-relationship');

  test('a relationship entry sits under the model and holds its ' +
           'endpoints, any join columns as written, synonyms, instructions, ' +
           'third-party blocks and examples, and no schema or sql-expressions',
       () => {
         const model = loaded();
         const {entryType, parentEntry, entrySource, aspects} =
             entry(model, 'sales/relationships/orders_to_customers');
         expect(entryType).toBe(`${DATAPLEX}/entryTypes/semantic-relationship`);
         expect(parentEntry).toBe(ENTRY('sales'));
         expect(entrySource).toEqual({
           displayName: 'orders_to_customers',
           description: 'Each order belongs to one customer.',
         });
         expect(aspects![KEY('semantic-relationship')].data).toEqual({
           source: {name: 'orders', fields: ['tenant', 'cust_id']},
           target: {name: 'customers', fields: ['tenant', 'id']},
           synonyms: ['placed_by'],
         });
         expect(aspects![KEY('guidelines')].data).toEqual(
             GUIDE('Join through this edge to reach customer attributes.'));
         expect(aspects![KEY('semantic-extensions')].data).toEqual({
           customExtensions:
               [{vendorName: 'DBT', data: '{"relationship": true}'}],
         });
         const id = 'sales/relationships/orders_to_customers';
         const opts = {...V2, overviews: new Map([[id, {content: 'Edge.'}]])};
         expect(data(model, id, 'overview', opts)).toEqual({
           content: 'Edge.', ...EXAMPLES('Which customer placed order 42?'),
         });
         expect(generateCatalogResources(model, opts).warnings).toEqual([]);
         expect(aspects![KEY('schema')]).toBeUndefined();
         expect(aspects![KEY('sql-expressions')]).toBeUndefined();
         expect(rel(model, 'customer_address')).toEqual({
           source: {name: 'customers'},
           target: {name: 'addresses'},
         });
         expect(rel(model, 'Order_Billing').source)
             .toEqual({name: 'orders', fields: ['`bill cust`']});
       });

  test('profiles holds the join columns of each named profile that binds ' +
           'the relationship, in declaration order, and is absent when the ' +
           'model has no named profile',
       () => {
         const model = loaded();
         model.profiles = [
           PROFILE('operational', `relationships:
  - name: Order_Billing
    from_columns: [bill_id]
    to_columns: [cid]
`),
           PROFILE('analytical', `relationships:
  - name: orders_to_customers
    from_columns: [tenant_id, customer_key]
    to_columns: [tenant_id, ck]
  - name: Order_Billing
    from_columns: [billing_key]
`),
         ];
         expect(rel(model, 'orders_to_customers').profiles).toEqual([{
           name: 'analytical',
           sourceFields: ['tenant_id', 'customer_key'],
           targetFields: ['tenant_id', 'ck'],
         }]);
         expect(rel(model, 'Order_Billing').profiles).toEqual([
           {name: 'operational', sourceFields: ['bill_id'],
            targetFields: ['cid']},
           {name: 'analytical', sourceFields: ['billing_key']},
         ]);
         expect(rel(model, 'customer_address').profiles).toBeUndefined();
         model.profiles = [{name: 'default', entities: [], relationships: [
           {name: 'orders_to_customers', fromColumns: ['a'], toColumns: ['b']},
         ]}];
         expect(rel(model, 'orders_to_customers').profiles).toBeUndefined();
       });

  test('relationship entries keep their names and follow the entities in ' +
           'declaration order, each ordered pair of entities gets one ' +
           'semantic-link listing its relationships, each relationship a ' +
           'reference link to each entity, bound or not, and an association ' +
           'gets a warning and no entry or link',
       () => {
         const model = loaded();
         model.relationships.unshift({
           ...model.relationships[0],
           name: 'm2m',
           association: {dataSource: 'p.d.order_customer', keys: ['id'],
                         sourceColumns: ['o_key'], destinationColumns: ['c_key']},
         });
         const {entries, entryLinks, warnings} =
             generateCatalogResources(model, V2);
         expect(entries.map(e => e.name)).toEqual([
           'sales',
           'sales/entities/orders',
           'sales/entities/customers',
           'sales/entities/addresses',
           'sales/relationships/orders_to_customers',
           'sales/relationships/Order_Billing',
           'sales/relationships/customer_address',
           'sales/relationships/orders_to_ship_address',
         ].map(ENTRY));
         expect(warnings).toEqual([expect.stringMatching(
             /^relationship 'm2m': many-to-many \(association\) edges/)]);
         const link = (from: string, to: string, relationships: string[]) => ({
           ...DIRECTED(
               'semantic-link', semanticLinkId('link', 'sales', from, to),
               `sales/entities/${from}`, `sales/entities/${to}`),
           aspects: {
             [KEY('semantic-link')]: {
               aspectType: `${DATAPLEX}/aspectTypes/semantic-link`,
               data: {relationships},
             },
           },
         });
         const reference = (rel: string, end: string, entity: string) =>
             DIRECTED(
                 'reference', semanticLinkId('relationship', 'sales', rel, end),
                 `sales/relationships/${rel}`, `sales/entities/${entity}`);
         expect(entryLinks).toEqual([
           link('orders', 'customers',
                ['orders_to_customers', 'Order_Billing']),
           link('customers', 'addresses', ['customer_address']),
           link('orders', 'addresses', ['orders_to_ship_address']),
           ...[
             ['orders_to_customers', 'orders', 'customers'],
             ['Order_Billing', 'orders', 'customers'],
             ['customer_address', 'customers', 'addresses'],
             ['orders_to_ship_address', 'orders', 'addresses'],
           ].flatMap(([rel, from, to]) => [
             reference(rel, 'source', from),
             reference(rel, 'target', to),
           ]),
         ]);
       });
});
