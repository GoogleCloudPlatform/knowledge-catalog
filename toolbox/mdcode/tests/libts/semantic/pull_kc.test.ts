// Tests for the semantic-model Knowledge Catalog pull leg
// (pullKnowledgeCatalog in src/libts/semantic/pull_kc.ts).
//
// pullKnowledgeCatalog is the orchestration around the pure reader: enumerate
// the entry group, hydrate each semantic entry's aspect data, and reconstruct
// the IR. The catalog client is stubbed so no network call is made. The entries
// the fake serves are produced by the real emitter with the second-generation
// types, or captured from production for a model an older kcmd pushed with the
// first-generation types, so this exercises the true list -> hydrate -> read
// path end to end: the single-model-per-group invariant, aborting on any fetch
// failure, ignoring foreign entries, the warning about a model an older kcmd
// pushed, and leaving out the file copies it stored. The second-generation
// tests round-trip a whole model through push and pull.

import {afterEach, beforeAll, describe, expect, mock, spyOn, test} from 'bun:test';

import {ApiResult} from '../../../src/libts/gcp/api';
import {CatalogClient, Entry} from '../../../src/libts/gcp/dataplex';
import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {entryIdOf} from '../../../src/libts/semantic/kc_ids';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {loadModels} from '../../../src/libts/semantic/loader';
import {serializeModelFiles} from '../../../src/libts/semantic/osi_converter';
import {pullKnowledgeCatalog} from '../../../src/libts/semantic/pull_kc';
import {applyProfile, loadProfileFile} from '../../../src/libts/semantic/resolve_profiles';
import {generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';
import {loadSqlEngine} from '../../../src/libts/semantic/sql_parser';

import {FIRST_GEN_OPTS, firstGenEntries} from './fixtures/first_gen_entries';

const OPTS = {
  project: 'dest',
  location: 'us',
  entryGroup: 'eg'
};

const SALES: SemanticModel = {
  name: 'sales',
  aiContext: {instructions: 'Use for order analysis.'},
  entities: [{
    name: 'orders',
    authoredSource: 'bigquery.googleapis.com/projects/demo/datasets/sales/tables/orders',
    dataSource: 'demo.sales.orders',
    keys: ['o_orderkey'],
    uniqueKeys: [['o_totalprice']],
    aiContext: {instructions: 'One row per order.'},
    fields: [
      {name: 'o_orderkey', expression: 'orders.o_orderkey', type: 'Integer'},
      {
        name: 'o_totalprice',
        expression: 'orders.o_totalprice',
        type: 'Decimal',
        label: 'Total Price',
      },
    ],
  }],
  relationships: [],
  metrics: [{
    name: 'total_revenue',
    expression: 'SUM(orders.o_totalprice)',
    entity: 'orders',
    aiContext: {instructions: 'Sum of order totals.'},
    // Metrics carry a datatype through KC (semantic-metric.dataType is
    // required).
    type: 'Decimal'
  }],
};

// The entries a second-generation push writes for a model.
function entriesFor(model: SemanticModel): Entry[] {
  return generateCatalogResources(model, OPTS).entries;
}

function ok<T>(result?: T): ApiResult<T> {
  return {status: 200, result};
}
function err(status: number, message: string): ApiResult<any> {
  return {status, message};
}

// The longest lookup URL the stub has seen.
let maxUrl = 0;

// Stubs listEntries (yields `listed`) and lookupEntry (serves `served` by name,
// or 404s an unknown name). As Dataplex does, a lookup returns only the aspects
// of the types and paths it asks for, at most 100 of them, and fails when its
// URL passes 16,384 bytes. Past 100 it returns the last 100, so a cut read
// leaves out an entity's own aspects. `lookupFail` forces a failure for one
// entry name. lookupEntryLinks is stubbed only to show that pull never calls it.
function stubClient(listed: Entry[], served: Entry[], lookupFail?: string):
    {list: any; lookup: any; lookupLinks: any} {
  maxUrl = 0;
  const byName = new Map(served.map(e => [e.name, e]));
  const list = spyOn(CatalogClient.prototype, 'listEntries')
                   .mockImplementation(async function*() {
                     for (const e of listed) yield e;
                   } as any);
  const lookup =
      spyOn(CatalogClient.prototype, 'lookupEntry')
          .mockImplementation(async (p, l, name, opts = {}) => {
            const types = opts.aspects ?? [];
            const paths = opts.paths;
            if (name === lookupFail) return err(500, 'boom');
            const e = byName.get(name);
            if (!e) return err(404, 'not found');
            const query = new URLSearchParams([
              ['entry', name],
              ['view', 'CUSTOM'],
              ...types.map(t => ['aspectTypes', t]),
              ...(paths ?? []).map(path => ['paths', path]),
            ]);
            const url = `/v1/projects/${p}/locations/${l}:lookupEntry?${query}`;
            maxUrl = Math.max(maxUrl, url.length);
            if (url.length > 16_384) return err(400, 'URL too long');
            const aspects =
                Object.entries(e.aspects ?? {})
                    .filter(
                        ([key, a]) => types.includes(a.aspectType!) &&
                            (!paths || paths.includes(key.split('@')[1] ?? '')))
                    .slice(-100);
            return ok({...e, aspects: Object.fromEntries(aspects)});
          });
  const lookupLinks = spyOn(CatalogClient.prototype, 'lookupEntryLinks')
                          .mockImplementation(async () => ok([]));
  return {list, lookup, lookupLinks};
}

beforeAll(loadSqlEngine);

afterEach(() => {
  mock.restore();
});


describe('pullKnowledgeCatalog: single-model invariant and robustness', () => {
  test(
      'more than one semantic model in the group is a hard error', async () => {
        const other: SemanticModel = {
          name: 'inventory',
          entities:
              [{name: 'items', dataSource: 'p.d.items', keys: [], fields: []}],
          relationships: [],
          metrics: [],
        };
        const entries = [...entriesFor(SALES), ...entriesFor(other)];
        stubClient(entries, entries);

        const cat = new CatalogClient({} as any);
        // An entry group holds exactly one model; two anchors is an unexpected
        // catalog state the pull refuses to guess through, naming both.
        await expect(pullKnowledgeCatalog(cat, OPTS))
            .rejects.toThrow(/holds 2 semantic models.*expected exactly one/i);
      });

  // A listing of a group that does not exist fails, and pull then gives
  // push's sentence for the missing group. Any other failure keeps its own
  // error.
  test.each([
    [404, "entry group 'eg' does not exist in location 'us' of project " +
         "'dest'; run 'kcmd init --semantic-model dest.us.eg' to create it, " +
         'or correct the scope in catalog.yaml.'],
    [200, 'Failed to list entries: denied'],
  ])('a failed listing of a group that answers %d', async (status, message) => {
    spyOn(CatalogClient.prototype, 'listEntries')
        .mockImplementation(async function*() {
          throw new Error('Failed to list entries: denied');
        } as any);
    spyOn(CatalogClient.prototype, 'getEntryGroup')
        .mockResolvedValue({status} as any);

    await expect(pullKnowledgeCatalog(new CatalogClient({} as any), OPTS))
        .rejects.toThrow(new Error(message));
  });

  test('an empty group reconstructs no models (a clean no-op)', async () => {
    stubClient([], []);

    const cat = new CatalogClient({} as any);
    const {models, warnings} = await pullKnowledgeCatalog(cat, OPTS);
    expect(models).toHaveLength(0);
    // Zero anchors is "nothing to pull", surfaced as a soft warning.
    expect(warnings.some(w => /nothing to reconstruct/i.test(w))).toBe(true);
  });

  test(
      'a non-semantic entry in the group is ignored, not fetched', async () => {
        const entries = entriesFor(SALES);
        const foreign: Entry = {
          name: `projects/dest/locations/us/entryGroups/eg/entries/foreign`,
          entryType: 'projects/x/locations/us/entryTypes/some-other-type',
        };
        const {lookup} = stubClient([...entries, foreign], entries);

        const cat = new CatalogClient({} as any);
        const {models} = await pullKnowledgeCatalog(cat, OPTS);
        expect(models).toHaveLength(1);
        // The foreign entry is never hydrated (only the 3 semantic entries
        // are).
        expect(lookup).toHaveBeenCalledTimes(3);
      });

  test('a failed hydration aborts the pull', async () => {
    const entries = entriesFor(SALES);
    const metricEntry =
        entries.find(e => e.entryType.endsWith('/semantic-metric'))!;
    stubClient(entries, entries, metricEntry.name);

    const cat = new CatalogClient({} as any);
    // A failed fetch means part of the model would be silently missing, so the
    // pull aborts rather than reconstruct an incomplete model.
    await expect(pullKnowledgeCatalog(cat, OPTS))
        .rejects.toThrow(
            new RegExp(`failed to fetch entry.*${metricEntry.name}`, 'i'));
  });

  test(
      'a child whose parentEntry does not resolve is kept (sole-anchor ' +
          'fallback)',
      async () => {
        const entries = entriesFor(SALES);
        // Simulate a project-id normalization mismatch: the metric points at an
        // anchor name that differs from the emitted one. With a single model in
        // the group the reader still attaches it via the sole-anchor fallback.
        const metricEntry =
            entries.find(e => e.entryType.endsWith('/semantic-metric'))!;
        metricEntry.parentEntry = metricEntry.parentEntry!.replace(
            'projects/dest/', 'projects/12345/');
        const {lookup} = stubClient(entries, entries);

        const cat = new CatalogClient({} as any);
        const {models} = await pullKnowledgeCatalog(cat, OPTS);

        expect(models).toHaveLength(1);
        expect(models[0].metrics.map(m => m.name)).toEqual(['total_revenue']);
        // The metric was hydrated despite the parent mismatch (3 entries).
        expect(lookup).toHaveBeenCalledTimes(3);
      });
});


describe('pullKnowledgeCatalog: a model an older kcmd pushed', () => {
  const isCopy = (e: Entry) => e.entryType.endsWith('/semantic-model-file');
  const WARNING =
      `model 'shop' in entry group 'kcmd-v1-prod-test-20261104' was pushed ` +
      `by an older kcmd (first-generation aspects: semantic-model, ` +
      `semantic-entity, semantic-metric). Pull wrote nothing for it; push it ` +
      `again with the current kcmd`;
  const cat = new CatalogClient({} as any);

  test('it is left out with a warning, and no copy is fetched', async () => {
    const listed = firstGenEntries();
    const {lookup, lookupLinks} = stubClient(listed, listed);

    const result = await pullKnowledgeCatalog(cat, FIRST_GEN_OPTS);

    expect(result.models).toEqual([]);
    expect(result.firstGeneration?.map(m => m.name)).toEqual(['shop']);
    expect(result.warnings).toEqual([WARNING]);
    const fetched = lookup.mock.calls.map((c: any[]) => c[2]);
    expect(listed.filter(isCopy).some(e => fetched.includes(e.name)))
        .toBe(false);
    // Pull reads no link.
    expect(lookupLinks).not.toHaveBeenCalled();
  });

  // An older kcmd labels the model entry as writing when it writes that
  // entry, so a push of it that stopped right after leaves this label.
  test('a model entry labeled as being written aborts the pull, naming the ' +
           'model',
       async () => {
         const listed = firstGenEntries();
         const anchor = listed.find(
             e => e.entryType.endsWith('/entryTypes/semantic-model'))!;
         anchor.entrySource!.labels!['kcmd-push-state'] = 'writing';
         stubClient(listed, listed);

         await expect(pullKnowledgeCatalog(cat, FIRST_GEN_OPTS))
             .rejects.toThrow(
                 'the last push of model \'shop\' did not finish: its model ' +
                 'entry\'s kcmd-push-state label still says writing');
       });
});


describe('pullKnowledgeCatalog: second-generation models', () => {
  const TABLE = (t: string) =>
      `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
  const GRAPH = (g: string) =>
      `bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/${g}`;
  // A model with everything a push stores. Its entities, metrics and
  // relationships are in name order, as a pull returns them, since
  // relationship order reaches the links and the DDL.
  const SHOP = `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    description: The shop
    ai_context:
      instructions: Use for sales questions.
      synonyms: [store]
      examples: [Top customers?]
      custom: {owner: crm, limit: .inf}
    custom_extensions: [{vendor_name: DBT, data: '{"x": 1}'}]
    deployments:
      - {name: main, target: ${GRAPH('main')}}
      - {name: analytics, target: ${GRAPH('analytics')}, profile: analytical}
    entities:
      - name: customers
        extends: [party]
        source: ${TABLE('customers')}
        primary_key: [party_id]
        unique_keys: [[email]]
        description: People who buy
        ai_context:
          synonyms: [buyers]
          examples: [Big spenders?]
          custom: {tier: gold, region: west}
        custom_extensions: [{vendor_name: DBT, data: '{"m": "t"}'}]
        fields:
          - {name: party_id, expression: cust_id}
          - name: email
            expression: LOWER(email)
            dimension: {}
            label: Email
            ai_context:
              instructions: Mask it.
              synonyms: [mail]
              examples: [Gmail users]
              custom: {pii: true}
            custom_extensions: [{vendor_name: DBT, data: '{"t": []}'}]
          - name: signup_date
            datatype: Date
            expression: signup
            dimension: {is_time: false}
          - {name: birthday, datatype: Date, expression: bday}
      - {name: employees, source: ${TABLE('employees')}, primary_key: [id],
         fields: [{name: id, expression: id}]}
      - name: orders
        source: ${TABLE('orders')}
        primary_key: [id]
        fields:
          - {name: id, expression: id}
          - name: amount
            datatype: Decimal
            expression:
              dialects:
                - {dialect: BIGQUERY, expression: SAFE_CAST(amt AS NUMERIC)}
                - {dialect: SNOWFLAKE, expression: TRY_CAST(amt AS NUMBER)}
                - {dialect: ANSI_SQL, expression: CAST(amt AS DECIMAL)}
          - {name: cust_id, expression: cust_id}
      - name: party
        abstract: true
        fields:
          - {name: party_id, datatype: Integer, ai_context: Never show ids.}
          - {name: name, datatype: String}
      - {name: vips, extends: [customers], source: ${TABLE('vips')},
         primary_key: [party_id]}
    relationships:
      - name: customer_orders
        from: orders
        to: customers
        from_columns: [cust_id]
        to_columns: [party_id]
        description: Each order has one customer
        ai_context:
          instructions: Join here.
          synonyms: [placed_by]
          examples: [Who ordered?]
          custom: {weight: 2}
        custom_extensions: [{vendor_name: DBT, data: '{"r": 1}'}]
      - {name: order_recipient, from: orders, to: customers,
         from_columns: [cust_id], to_columns: [party_id]}
      - {name: orders_by_staff, from: orders, to: employees}
    metrics:
      - {name: avg_amount, expression: AVG(orders.amount)}
      - {name: order_count, entity: orders, expression: COUNT(*)}
      - name: revenue
        datatype: Decimal
        expression:
          dialects:
            - {dialect: BIGQUERY, expression: SUM(orders.amount)}
            - {dialect: ANSI_SQL, expression: SUM(orders.amount)}
        ai_context: {synonyms: [sales], examples: [Revenue in May?]}
        custom_extensions: [{vendor_name: DBT, data: '{"k": 2}'}]
`;
  const PROFILES = {
    analytical: `name: analytical
entities:
  - name: customers
    source: ${TABLE('customers_a')}
    primary_key: [cust_key]
    unique_keys: [[mail]]
    fields:
      - {name: email, expression: mail}
      - name: name
        expression: {dialects: [{dialect: BIGQUERY, expression: full_name}]}
  - {name: orders, source: ${TABLE('orders_a')}, fields_exclude: [cust_id]}
relationships:
  - {name: customer_orders, from_columns: [customer_key], to_columns: [cust_key]}
metrics_exclude: [revenue, order_count, avg_amount]
`,
    ops: `name: ops
entities:
  - name: orders
    source: ${TABLE('orders_ops')}
    primary_key: [order_id]
    fields: [{name: amount, expression: amt_ops}]
metrics_exclude: [revenue, avg_amount]
`,
    qa: 'name: qa\nmetrics_exclude: "*"\n',
  };
  // A vanilla model with a different third-party block on every object that
  // takes one, and every construct a vanilla model keeps in GOOGLE blocks.
  const DBT = (n: number) => `{vendor_name: DBT, data: '{"n": ${n}}'}`;
  const GOOGLE = (data: object) =>
      `{vendor_name: GOOGLE, data: '${JSON.stringify(data)}'}`;
  const ANSI = (sql: string) =>
      `{dialects: [{dialect: ANSI_SQL, expression: ${sql}}]}`;
  const VANILLA = `version: "0.2.0.dev0"
semantic_model:
  - name: store
    custom_extensions:
      - ${DBT(1)}
      - ${GOOGLE({
    profiles: [{
      name: 'eu',
      entities: [{
        name: 'customers',
        source: TABLE('customers_eu'),
        primary_key: ['cust_key'],
        fields: [{name: 'id', expression: 'cust_key'}],
      }],
      relationships: [{
        name: 'customer_party', from_columns: ['cust_key'], to_columns: ['id'],
      }],
      metrics_exclude: '*',
    }],
    deployments: [
      {name: 'main', target: GRAPH('main')},
      {name: 'eu', target: GRAPH('eu'), profile: 'eu'},
    ],
  })}
    datasets:
      - name: customers
        source: ${TABLE('customers')}
        primary_key: [id]
        custom_extensions: [${DBT(2)}, ${GOOGLE({extends: ['party']})}]
        fields: [{name: id, expression: ${ANSI('cust_id')}}]
      - name: party
        source: ${TABLE('party')}
        primary_key: [id]
        custom_extensions: [${DBT(4)}]
        fields:
          - {name: id, expression: ${ANSI('id')}, custom_extensions: [${DBT(5)}]}
    relationships:
      - name: customer_party
        from: customers
        to: party
        from_columns: [id]
        to_columns: [id]
        custom_extensions:
          - ${DBT(6)}
          - ${GOOGLE({description: 'Each customer is a party'})}
    metrics:
      - name: customer_count
        expression: ${ANSI('COUNT(*)')}
        custom_extensions: [${DBT(7)}, ${GOOGLE({entity: 'customers'})}]
`;
  // A model file and its profile files, as a push publishes them.
  function loaded(
      text = SHOP, profiles: Record<string, string> = PROFILES): SemanticModel {
    const model = loadModels(text).models[0];
    const named = Object.entries(profiles);
    if (named.length) {
      model.profiles = named.map(([name, t]) => loadProfileFile(t, name));
    }
    return model;
  }
  // What a push of `model` generates: its entries and links, and the
  // BigQuery and Spanner DDL of the model under each of its bindings.
  function pushed(model: SemanticModel, overviews?: Map<string, any>) {
    const {entries, entryLinks} =
        generateCatalogResources(model, {...OPTS, overviews});
    const bindings =
        [model, ...(model.profiles ?? []).map(p => applyProfile(model, p))];
    const graphs = [generatePropertyGraph, generateSpannerPropertyGraph];
    const ddl = bindings.flatMap(m => graphs.map(g => g(m).ddl));
    return {entries, entryLinks, ddl};
  }
  const KEY = (type: string) => `dataplex-types.global.${type}`;
  const cat = new CatalogClient({} as any);

  // Pulls what a push of `text` and `profiles` stores, from entries listed in
  // reverse so pull's order cannot come from the catalog's, writes the pulled
  // model as files and pushes them again, which must give what the first push
  // gave. Returns the first push's entries and the pull.
  async function roundTrip(
      text: string, profiles: Record<string, string>,
      overviews?: Map<string, any>) {
    const first = pushed(loaded(text, profiles), overviews);
    stubClient([...first.entries].reverse(), first.entries);
    const pulled = await pullKnowledgeCatalog(cat, OPTS);
    // `<model>.profile.<name>.yaml` holds the profile <name>.
    const [file, ...profileFiles] = serializeModelFiles(pulled.models[0]).files;
    const again = loaded(
        file.content,
        Object.fromEntries(
            profileFiles.map(f => [f.fileName.split('.')[2], f.content])));
    expect(pushed(again, pulled.overviews)).toEqual(first);
    return {entries: first.entries, pulled};
  }

  test(
      'a Google model pulls back as pushed, with its sidecars, and pushed ' +
          'again gives what its push gave',
      async () => {
        const overviews = new Map([
          ['shop', {content: '# Shop', contentType: 'MARKDOWN'}],
          ['shop/entities/orders', {links: [{url: 'https://wiki/orders'}]}],
        ]);
        const {entries, pulled} = await roundTrip(SHOP, PROFILES, overviews);

        // Push leaves out a member it cannot store.
        // Each profile's metrics_exclude comes back as '*' or a sorted list,
        // and each metric's entity as declared.
        const expected = loaded();
        delete expected.aiContext!.additionalProperties!.limit;
        expected.profiles![0].metricsExclude = '*';
        expected.profiles![1].metricsExclude = ['avg_amount', 'revenue'];
        for (const m of expected.metrics) m.authoredEntity = m.entity;
        expect(pulled).toEqual({
          models: [expected],
          warnings: [],
          overviews,
        });
        expect(Object.keys(
                   pulled.models[0].entities[0].aiContext!.additionalProperties!))
            .toEqual(['region', 'tier']);

        // With no metric entry, no profile excludes a metric. Guidelines that
        // Knowledge Catalog wrote are left out. is_time alone marks a
        // dimension.
        mock.restore();
        const noMetrics = entries.filter(e => !e.name.includes('/metrics/'));
        noMetrics[0].aspects![KEY('guidelines')].data!.userManaged = false;
        const {fields} = noMetrics[1].aspects![KEY('schema')].data!;
        delete fields.find((f: any) => f.name === 'signup_date').semantic;
        stubClient(noMetrics, noMetrics);
        const {models: [withoutMetrics]} = await pullKnowledgeCatalog(cat, OPTS);
        expect(withoutMetrics.profiles!.map(p => p.metricsExclude)).toEqual([
          undefined, undefined, undefined
        ]);
        expect(withoutMetrics.aiContext)
            .toEqual({synonyms: ['store'], examples: ['Top customers?']});
        expect(withoutMetrics.entities[0].fields[2].dimension).toEqual({
          isTime: false
        });

        // A model entry with no specVersion is first-generation, and is not
        // rebuilt.
        delete noMetrics[0].aspects![KEY('semantic-model')].data!.specVersion;
        const firstGen = await pullKnowledgeCatalog(cat, OPTS);
        expect(firstGen.models).toEqual([]);
        expect(firstGen.firstGeneration?.map(m => m.name)).toEqual(['shop']);
      });

  test('a vanilla model pulled and pushed again gives what its push gave',
       () => roundTrip(VANILLA, {}));

  test('a third-party table\'s entry name pulls back exactly as written, and ' +
           'pushed again gives what its push gave',
       async () => {
         const entry = (t: string) =>
             `projects/p/locations/us/entryGroups/sf/entries/acme.public.${t}`;
         const {entries} = await roundTrip(
             SHOP.replace(TABLE('orders'), entry('orders')),
             {ops: PROFILES.ops.replace(TABLE('orders_ops'), entry('orders_ops'))});
         const stored = entries.find(e => e.name.endsWith('/shop/entities/orders'))!
                            .aspects![KEY('semantic-entity')].data!;
         expect([stored.source, stored.profiles[0].source]).toEqual([
           {resource: entry('orders')}, {resource: entry('orders_ops')},
         ]);
       });

  test('each entry is read with the aspects of its type, and no link is read',
       async () => {
         const opts = {...OPTS, systemTypeProject: 'types'};
         const {entries} = generateCatalogResources(loaded(), opts);
         const {lookup, lookupLinks} = stubClient(entries, entries);
         await pullKnowledgeCatalog(cat, OPTS);
         // The aspect types read for the model, an entity, a metric and a
         // relationship, each named by its id in the type project.
         const prefix = 'projects/types/locations/global/aspectTypes/';
         const read = new Map<string, string[]>(lookup.mock.calls.map(
             (c: any[]) => [entryIdOf(c[2]), c[3]?.aspects ?? []]));
         const OBJECT = ['guidelines', 'semantic-extensions', 'overview'];
         expect([
           'shop', 'shop/entities/orders', 'shop/metrics/revenue',
           'shop/relationships/customer_orders'
         ].map(id => read.get(id)?.map(t => t.replace(prefix, '')))).toEqual([
           ['semantic-model', ...OBJECT],
           ['semantic-entity', 'schema', 'sql-expressions', ...OBJECT],
           ['semantic-metric', 'sql-expressions', ...OBJECT],
           ['semantic-relationship', ...OBJECT],
         ]);
         expect(lookupLinks).not.toHaveBeenCalled();
       });

  test(
      'an entity with more than 100 aspects, and more than 100 of one type, ' +
          'is read whole, one read at a time',
      async () => {
        // The entity and f0 to f159 carry instructions. Fields f0 to f39 also
        // carry an example and a third-party block, so the entry holds 161
        // guidelines aspects and 40 of each other type. The 300-character
        // names of f100 to f150 make a read by path reach the URL limit
        // before 99 paths, and f98's length makes that read exactly 16,384
        // bytes.
        const model: SemanticModel = {
          name: 'wide',
          version: '0.2.0.dev0/google',
          entities: [{
            name: 'events',
            dataSource: '',
            keys: [],
            aiContext: {instructions: 'One row per event.'},
            fields: Array.from({length: 160}, (_, i) => i < 40 ? {
              name: `f${i}`,
              aiContext: {instructions: 'Say it.', examples: ['An example']},
              customExtensions: [{vendorName: 'DBT', data: '{}'}],
            } : {
              name: i === 98 ? 'f98'.padEnd(14, 'x') :
                  i < 100 || i > 150 ? `f${i}` : `f${i}`.padEnd(300, 'x'),
              aiContext: {instructions: 'Say it.'},
            }),
          }],
          relationships: [],
          metrics: [],
        };
        const {entries} = generateCatalogResources(model, OPTS);
        const {lookup} = stubClient(entries, entries);
        // The per-type reads run one at a time.
        const serve = lookup.getMockImplementation();
        let inFlight = 0, peak = 0;
        lookup.mockImplementation(async (...args: any[]) => {
          const one = args[3]?.aspects?.length === 1;
          if (one) peak = Math.max(peak, ++inFlight);
          const res = await serve(...args);
          if (one) inFlight--;
          return res;
        });
        expect((await pullKnowledgeCatalog(cat, OPTS)).models).toEqual([model]);
        expect(peak).toBe(1);
        expect(maxUrl).toBe(16_384);
      });
});
