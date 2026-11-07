// Behavior specification for the Knowledge Catalog emitter
// (src/libts/semantic/knowledge_catalog.ts).
//
// The readable "big picture" goldens live in `knowledge_catalog.e2e.test.ts` (a
// corpus of `<fixture>.yaml` inputs, each with a committed
// `<fixture>.knowledge_catalog.golden.json`). This file holds the cases those
// fixtures do not show, such as the logical DataType -> schema `metadataType`
// mapping (the corpus fixtures declare no field `datatype`, so every field
// falls back to Opaque) and IR the loader never produces.

import {describe, expect, test} from 'bun:test';

import type {OverviewSidecar} from '../../../src/libts/layouts/semantic-model';
import {DataType, Entity, SemanticModel} from '../../../src/libts/semantic/ir';
import {semanticLinkId} from '../../../src/libts/semantic/kc_ids';
import {generateCatalogResources, KcGenerateOptions} from '../../../src/libts/semantic/knowledge_catalog';
import {loadModels} from '../../../src/libts/semantic/loader';
import {applyProfileFile, loadProfileFile} from '../../../src/libts/semantic/resolve_profiles';

const OPTS = {
  project: 'dest-proj',
  location: 'us',
  entryGroup: 'eg',
  v2Aspects: true
};
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
// The entry whose name ends in /entries/<suffix>, emitted under OPTS unless
// `opts` says otherwise, and the data of one of its aspects.
function entry(
    model: SemanticModel, suffix: string, opts: KcGenerateOptions = OPTS) {
  return generateCatalogResources(model, opts)
      .entries.find(e => e.name.endsWith(`/entries/${suffix}`))!;
}
function data(model: SemanticModel, suffix: string, type: string,
              opts: KcGenerateOptions = OPTS): any {
  return entry(model, suffix, opts).aspects![KEY(type)]?.data;
}
const load = (text: string): SemanticModel =>
    loadModels(text, {bindingOptional: true}).models[0];
// Loads the profile `name` whose other keys are the YAML `body`.
const PROFILE = (name: string, body: string) =>
    loadProfileFile(`name: ${name}\n${body}`, name);
// Loads the profile `name`. Each binding is an entity name followed by the
// other keys of its entry, in YAML flow style.
const ENTITIES = (name: string, ...bindings: string[]) => PROFILE(
    name, `entities: [${bindings.map(b => `{name: ${b}}`).join(', ')}]`);
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
      test('the logical type is the dataType', () => {
        for (const [type, metadataType] of [
               ['String', 'STRING'],
               ['Integer', 'NUMBER'],
               ['Decimal', 'NUMBER'],
               ['Float', 'NUMBER'],
               ['Boolean', 'BOOLEAN'],
               ['Date', 'DATETIME'],
               ['Time', 'DATETIME'],
               ['DateTime', 'DATETIME'],
               ['DateTimeTz', 'TIMESTAMP'],
               ['Opaque', 'OTHER'],
             ] as [DataType, string][]) {
          expect(schemaField(modelWithField(type)))
              .toMatchObject({dataType: type, metadataType});
        }
      });
    });


describe('model-level structure', () => {
  test('a model with no entities gets only its semantic-model entry, with a ' +
           'warning',
       () => {
         const model: SemanticModel =
             {name: 'm', entities: [], relationships: [], metrics: []};
         const {entries, warnings} = generateCatalogResources(model, OPTS);
         expect(entries.map(e => e.entryType))
             .toEqual([`${DATAPLEX}/entryTypes/semantic-model`]);
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
});


describe('a purely logical model (no physical binding) emits cleanly', () => {
  // A Knowledge-Catalog-only model governs meaning with no binding: every
  // entity has an empty dataSource and its fields carry no expression. The
  // emitter still publishes every entity and relationship, with no warning.
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

  test('every entity and the relationship are published, no warnings', () => {
    const {entries, warnings} = generateCatalogResources(logicalModel(), OPTS);
    const kinds = entries.map(e => e.entryType.replace(/.*\//, ''));
    expect(kinds).toEqual([
      'semantic-model', 'semantic-entity', 'semantic-entity',
      'semantic-relationship'
    ]);
    expect(warnings).toEqual([]);
  });
});


describe('a field a binding profile excludes', () => {
  // A catalog-only push publishes the whole logical model,
  // so it applies none of the exclusions the profile marks.
  test(
      'is still published by a catalog-only push, with an excluded metric',
      () => {
        const {models} = loadModels(
            `version: "0.2.0.dev0/google"
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
`,
            {bindingOptional: true});
        const ops = loadProfileFile(
            `name: ops
entities:
  - name: orders
    source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders_ops
    fields_exclude: [secret]
metrics_exclude: "*"
`,
            'ops', {skipActions: true});
        const {entries} = generateCatalogResources(
            {...models[0], profiles: [ops]}, OPTS);
        const entity =
            entries.find(e => e.entryType.endsWith('/semantic-entity'))!;
        expect(entity.aspects!['dataplex-types.global.schema'].data!.fields.map(
                   (f: any) => f.name))
            .toEqual(['id', 'amount', 'secret']);
        expect(entries.filter(e => e.entryType.endsWith('/semantic-metric'))
                   .length)
            .toBe(1);
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
                  type = 'semantic-metric', opts = OPTS) =>
      data(model, `${model.name}/metrics/${name}`, type, opts);
  const excluded = (model: SemanticModel, name: string) =>
      metric(model, name).excludedInProfiles;

  test('semantic-extensions holds every third-party block in order, ' +
           'duplicates included, on its own entry, and is left out when the ' +
           'only block is GOOGLE\'s',
       () => {
         const model = loaded();
         model.customExtensions!.push({vendorName: 'GOOGLE', data: '{}'});
         const DBT = {vendorName: 'DBT', data: '{"materialized": "table"}'};
         expect(data(model, 'sales', 'semantic-extensions')).toEqual({
           customExtensions:
               [DBT, {vendorName: 'LOOKER', data: 'not json at all'}, DBT],
         });
         model.metrics[0].customExtensions =
             [{vendorName: 'Google', data: '{}'}];
         expect(metric(model, 'revenue', 'semantic-extensions'))
             .toEqual({customExtensions: [{vendorName: 'Google', data: '{}'}]});
         model.customExtensions = [{vendorName: 'GOOGLE', data: '{}'}];
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
           'semantic-metric carries no expression',
       () => {
         const model = loaded();
         expect(metric(model, 'revenue', 'sql-expressions'))
             .toEqual({expressions: [{sql: 'SUM(orders.amount)'}]});
         expect(metric(model, 'revenue', 'semantic-metric').expression)
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
         const opts = {...OPTS, overviews: new Map<string, OverviewSidecar>([
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
           expect(generateCatalogResources(model, OPTS).warnings).toContain(
               `model 'sales': ai_context member 'tier' is not pushed: its ` +
               `value holds ${holds}, which Knowledge Catalog cannot store ` +
               `as written`);
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
         const opts = {...OPTS, overviews: new Map([[id, {content: 'Edge.'}]])};
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
             generateCatalogResources(model, OPTS);
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


describe('with KC_V2_ASPECTS on, entities, fields and expressions', () => {
  const MODEL_FILE = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    entities:
      - name: party
        abstract: true
        ai_context: {synonyms: [counterparty]}
        fields:
          - name: id
            datatype: Integer
            description: The party id
            label: Party ID
            ai_context: {instructions: Hide raw ids., synonyms: [party_key],
                         examples: [Party 7], custom: {pii: true, rank: .inf}}
            custom_extensions:
              - {vendor_name: DBT, data: '{"tests": ["not_null"]}'}
          - { name: name, datatype: String }
      - name: person
        abstract: true
        extends: [party]
        fields: [{ name: birth_date, datatype: Date }]
      - name: customers
        extends: [person]
        source: ${TABLE('customers')}
        primary_key: [id]
        unique_keys: [[tenant, email], ['\`legacy id\`']]
        ai_context:
          {instructions: Use for analytics., synonyms: [buyers, clients],
           examples: [Who bought the most?], custom: {tier: gold, rank: .nan}}
        custom_extensions: [{vendor_name: DBT, data: '{"model": true}'}]
        fields:
          - { name: id, expression: cust_id }
          - { name: signup, datatype: Date, dimension: {is_time: true} }
          - {name: region, dimension: {}, expression: {dialects: [
                {dialect: BIGQUERY, expression: 'SAFE_DIVIDE(a, b)'},
                {dialect: ANSI_SQL, expression: a / b}]}}
          - { name: active, datatype: Boolean, dimension: {is_time: false} }
          - { name: email, expression: LOWER(email) }
      - name: events
        source: ${TABLE('events')}
        fields: [{name: at, expression: at}]
      - name: visits
        extends: [events]
        source: ${TABLE('visits')}
        unique_keys: [[visit_no]]
        fields: [{name: visit_no, expression: visit_no}]
    actions:
      - name: Notify
        executor:
          mcp: {server: //agentregistry.googleapis.com/x/mcpServers/s, tool: n}
        parameters: [{name: who, concept: customers, field: name}]
`;
  const loaded = () => load(MODEL_FILE);
  // The data of aspect `type` on the entry of entity `name`.
  const aspect =
      (model: SemanticModel, name: string, type: string, opts = OPTS) =>
          data(model, `sales/entities/${name}`, type, opts);
  const NO_KEYS = (entity: string) =>
      `entity '${entity}': no keys declared in the source model; declare ` +
      'primary_key or unique_keys in the model file or in a profile to ' +
      'record a key in Knowledge Catalog';
  // A sql-expressions record; `qualifier` names the profile it comes from.
  const record = (qualifier?: string) =>
      (name: string, sql: string, dialect?: string) =>
          ({name, qualifier, dialect, sql});
  const [own, prod, dev] = [record(), record('prod'), record('dev')];

  test('semantic-entity holds the source and keys as written, the direct ' +
           'parents, abstract and synonyms, a reference link runs from each ' +
           'entity to each parent, and an abstract entity draws no warning',
       () => {
         const model = loaded();
         expect(['customers', 'party', 'person'].map(
                    name => aspect(model, name, 'semantic-entity')))
             .toEqual([
               {
                 source: {resource: TABLE('customers')},
                 primaryKey: {fields: ['id']},
                 uniqueConstraints: [
                   {fields: ['tenant', 'email']}, {fields: ['`legacy id`']},
                 ],
                 extends: ['person'],
                 synonyms: ['buyers', 'clients'],
               },
               {abstract: true, synonyms: ['counterparty']},
               {extends: ['party'], abstract: true},
             ]);
         const extendsLink = (child: string, parent: string) => DIRECTED(
             'reference', semanticLinkId('extends', 'sales', child, parent),
             `sales/entities/${child}`, `sales/entities/${parent}`);
         model.entities.find(e => e.name === 'customers')!.extends =
             ['person', 'party'];
         expect(aspect(model, 'customers', 'semantic-entity').extends)
             .toEqual(['person', 'party']);
         const {entryLinks, warnings} = generateCatalogResources(model, OPTS);
         expect(entryLinks).toEqual([
           extendsLink('person', 'party'), extendsLink('customers', 'person'),
           extendsLink('customers', 'party'), extendsLink('visits', 'events'),
         ]);
         expect(warnings.filter(w => w.includes('abstract'))).toEqual([]);
       });

  test('the missing-key warning skips abstract entities and counts unique ' +
           'keys and keys in a named profile',
       () => {
         for (const [name, profiles, warns] of [
                ['no profile', [], true],
                ['a primary key in a profile', [
                  ENTITIES('ops', 'visits'),
                  ENTITIES('prod', 'events, primary_key: [event_id]'),
                ], false],
                ['a unique key in a profile',
                 [ENTITIES('prod', 'events, unique_keys: [[at]]')], false],
                ['a profile with no key', [ENTITIES(
                     'prod', `events, source: ${TABLE('events_prod')}`,
                     'visits, primary_key: [visit_no]')], true],
              ] as [string, SemanticModel['profiles'], boolean][]) {
           const model = loaded();
           model.profiles = profiles;
           expect(generateCatalogResources(model, OPTS).warnings.filter(
                      w => w.includes('no keys')), name)
               .toEqual(warns ? [NO_KEYS('events')] : []);
         }
       });

  test('a named profile that lists an entity gets a record of the source, ' +
           'excludedFields and keys it states, without an empty unique key, ' +
           'and a qualified expression record for each field it binds, after ' +
           'the entity\'s own records',
       () => {
         const model = loaded();
         expect(aspect(model, 'visits', 'sql-expressions'))
             .toEqual({fieldExpressions: [own('visit_no', 'visit_no')]});
         model.profiles = [
           ENTITIES(
               'prod',
               `customers, source: ${TABLE('customers_prod')}, ` +
                   'primary_key: [cust_key], fields_exclude: [active], ' +
                   'unique_keys: [[tenant_id, mail], []], fields: [' +
                   '{name: email, expression: mail}, ' +
                   '{name: name, expression: full_name}, ' +
                   '{name: region, expression: {dialects: [' +
                   '{dialect: SPANNER, expression: "a / NULLIF(b, 0)"}, ' +
                   '{dialect: ANSI_SQL, expression: a / b}]}}]',
               'events, unique_keys: [[at]]'),
           ENTITIES(
               'dev',
               `customers, source: ${TABLE('customers_dev')}, fields: [` +
                   '{name: email, expression: mail}, ' +
                   '{name: id, expression: dev_id}]'),
         ];
         expect(aspect(model, 'customers', 'semantic-entity').profiles)
             .toEqual([
               {
                 name: 'prod',
                 source: {resource: TABLE('customers_prod')},
                 excludedFields: ['active'],
                 primaryKey: {fields: ['cust_key']},
                 uniqueConstraints: [{fields: ['tenant_id', 'mail']}],
               },
               {name: 'dev', source: {resource: TABLE('customers_dev')}},
             ]);
         expect(aspect(model, 'events', 'semantic-entity').profiles).toEqual(
             [{name: 'prod', uniqueConstraints: [{fields: ['at']}]}]);
         expect(aspect(model, 'visits', 'semantic-entity').profiles)
             .toBeUndefined();
         expect(aspect(model, 'customers', 'sql-expressions').fieldExpressions)
             .toEqual([
               own('id', 'cust_id'),
               own('region', 'SAFE_DIVIDE(a, b)', 'BIGQUERY'),
               own('region', 'a / b', 'ANSI_SQL'), own('email', 'LOWER(email)'),
               prod('email', 'mail'), prod('name', 'full_name'),
               prod('region', 'a / NULLIF(b, 0)', 'SPANNER'),
               prod('region', 'a / b', 'ANSI_SQL'), dev('email', 'mail'),
               dev('id', 'dev_id'),
             ]);
       });

  test('an entity\'s schema lists the fields it declares, leaving out one ' +
           'it only rebinds and keeping one a profile excludes, with no ' +
           'keys or semantics block, and an action projecting an excluded ' +
           'field does not warn',
       () => {
         const applied = applyProfileFile(
             loaded(),
             'name: prod\nentities: [{name: customers, ' +
                 'fields_exclude: [signup, name]}]',
             'prod');
         if ('error' in applied) throw new Error(applied.error);
         const {model} = applied;
         expect(aspect(model, 'customers', 'schema')).toEqual({
           fields: [
             {name: 'signup', dataType: 'Date', metadataType: 'DATETIME',
              semantic: 'DIMENSION', annotations: {is_time: 'true'}},
             {name: 'region', dataType: 'Opaque', metadataType: 'OTHER',
              semantic: 'DIMENSION'},
             {name: 'active', dataType: 'Boolean', metadataType: 'BOOLEAN',
              semantic: 'DIMENSION', annotations: {is_time: 'false'}},
             {name: 'email', dataType: 'Opaque', metadataType: 'OTHER'},
           ],
         });
         expect(aspect(model, 'party', 'schema').fields).toEqual([
           {name: 'id', description: 'The party id', dataType: 'Integer',
            metadataType: 'NUMBER', synonyms: ['party_key'],
            annotations: {label: 'Party ID'}},
           {name: 'name', dataType: 'String', metadataType: 'STRING'},
         ]);
         // An action projecting the excluded inherited field does not warn,
         // since the schema keeps the field.
         expect(generateCatalogResources(model, OPTS).warnings.filter(
                    w => w.includes('parameter \'who\'')))
             .toEqual([]);
       });

  test('an entity carries guidelines, semantic-extensions and an overview ' +
           'of its examples and sidecar at entry level, a field with them ' +
           'gets the matching aspect at its path on the entity that declares ' +
           'it, and an unstorable member warns once',
       () => {
         const AT = (type: string) => `${KEY(type)}@Schema.id`;
         const model = loaded();
         const id = 'sales/entities/customers';
         const opts = {
           ...OPTS,
           overviews: new Map([[id, {content: 'Buyers.'}]])
         };
         const customers = entry(model, id, opts).aspects!;
         const party = entry(model, 'sales/entities/party').aspects!;
         expect(customers[KEY('overview')].data).toEqual(
             {content: 'Buyers.', ...EXAMPLES('Who bought the most?')});
         const FIELD: Record<string, any> = {
           guidelines: {...GUIDE('Hide raw ids.'), data: {pii: true}},
           'semantic-extensions': {
             customExtensions: [
               {vendorName: 'DBT', data: '{"tests": ["not_null"]}'},
             ],
           },
           overview: EXAMPLES('Party 7'),
         };
         for (const [type, want] of Object.entries(FIELD)) {
           expect(party[AT(type)], type).toEqual(
               {aspectType: `${DATAPLEX}/aspectTypes/${type}`, data: want});
         }
         const HEAD = [KEY('semantic-entity'), KEY('schema')];
         expect(Object.keys(customers)).toEqual([
           ...HEAD, ...Object.keys(FIELD).map(KEY), KEY('sql-expressions'),
         ]);
         expect(Object.keys(party))
             .toEqual([...HEAD, ...Object.keys(FIELD).map(AT)]);
         expect(generateCatalogResources(model, OPTS).warnings.filter(
                    w => w.includes('ai_context member')))
             .toEqual([['field \'party.id\'', '.inf'],
                       ['entity \'customers\'', '.nan']].map(
                          ([object, holds]) => `${object}: ai_context ` +
                              `member 'rank' is not pushed: its value ` +
                              `holds ${holds}, which Knowledge Catalog ` +
                              `cannot store as written`));
       });
});
