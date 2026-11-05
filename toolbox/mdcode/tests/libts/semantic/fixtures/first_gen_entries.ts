// The entries a push with KC_V2_ASPECTS off (first-generation aspects plus a
// file copy) writes for a tiny model, captured from production so tests need
// not build them with the first-generation emitter.
//
// Captured 2026-11-04 (b/575695037): `kcmd push` with KC_V2_ASPECTS unset, at
// main 075d6d3a, of the model in FIRST_GEN_MODEL_FILE into
// projects/kc-looker-external/locations/global/entryGroups/
// kcmd-v1-prod-test-20261104 (kept), then read back with the Dataplex REST API:
// list, and lookupEntry view=ALL per entry.
//
// Trimmed to what kcmd reads: create/update times and empty aspectSource are
// dropped. The entries are as CatalogClient returns them, after _fixEntry: the
// project numbers 655216118709 (dataplex-types) and 634224303705
// (kc-looker-external) in entry and aspect types are replaced by the project
// ids, and aspects are keyed `<project>.<location>.<type>`.
//
// What production stores, as captured:
// - the model entry `shop`: its semantic-model aspect holds no data, and so no
//   specVersion, which marks it first-generation; its entry carries the
//   push's `kcmd-push-id` label;
// - one entry per entity, `shop.entities.<name>`, with the semantic-entity
//   and schema aspects, and one per metric, `shop.metrics.<name>`, with the
//   semantic-metric aspect. No guidelines aspect, as the model sets no
//   ai_context;
// - the file copy `shop.files.shop.yaml`, of the custom semantic-model-file
//   type in the destination project;
// - the relationship as a `schema-join` entry link between the two entity
//   entries, which is not kept here, since pull reads no entry link;
// - the entry group's own entry, which Dataplex lists with the others.

import type {Entry} from '../../../../src/libts/gcp/dataplex';

// Where the entries were captured.
export const FIRST_GEN_OPTS = {
  project: 'kc-looker-external',
  location: 'global',
  entryGroup: 'kcmd-v1-prod-test-20261104',
};

const GROUP = 'projects/kc-looker-external/locations/global/entryGroups/' +
    'kcmd-v1-prod-test-20261104';
const ANCHOR = `${GROUP}/entries/shop`;
const TYPES = 'projects/dataplex-types/locations/global';
const TABLE = (t: string) =>
    `bigquery.googleapis.com/projects/kc-looker-external/datasets/kcmd_demo/tables/${t}`;
const aspect = (type: string, data: Record<string, any>, project = 'dataplex-types') =>
    ({[`${project}.global.${type}`]: {
      aspectType: `projects/${project}/locations/global/aspectTypes/${type}`,
      data,
    }});

// The model file pushed, which the file copy holds.
export const FIRST_GEN_MODEL_FILE = `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    description: Tiny v1 (flag-off) prod test model (b/575695037)
    entities:
      - name: orders
        description: A customer order
        source: ${TABLE('orders')}
        primary_key: [order_id]
        fields:
          - { name: order_id,    datatype: Integer, expression: order_id }
          - { name: customer_id, datatype: Integer, expression: customer_id }
          - { name: order_total, datatype: Decimal, expression: order_total }
      - name: customers
        description: A customer who places orders
        source: ${TABLE('customers')}
        primary_key: [customer_id]
        fields:
          - { name: customer_id, datatype: Integer, expression: customer_id }
          - { name: full_name,   datatype: String,  expression: full_name }
    relationships:
      - name: placed_by
        from: orders
        to: customers
        from_columns: [customer_id]
        to_columns: [customer_id]
    metrics:
      - name: revenue
        description: Total order value
        datatype: Decimal
        expression:
          dialects: [{ dialect: BIGQUERY, expression: SUM(orders.order_total) }]
`;

const PUSH_ID = '7940fe6a-9931-4196-a2b9-2f8176b4e880';

// In the order the list returned them.
const ENTRIES: Entry[] = [
  {
    name: `${GROUP}/entries/shop.entities.orders`,
    entryType: `${TYPES}/entryTypes/semantic-entity`,
    aspects: {
      ...aspect('schema', {
        fields: [
          {name: 'order_id', dataType: 'INT64', metadataType: 'NUMBER'},
          {name: 'customer_id', dataType: 'INT64', metadataType: 'NUMBER'},
          {name: 'order_total', dataType: 'NUMERIC', metadataType: 'NUMBER'},
        ],
        primaryKey: {fields: ['order_id']},
      }),
      ...aspect('semantic-entity', {source: {resources: [TABLE('orders')]}}),
    },
    parentEntry: ANCHOR,
    entrySource: {
      displayName: 'orders',
      description: 'A customer order',
      location: 'global',
    },
  },
  {
    name: `${GROUP}/entries/kcmd-v1-prod-test-20261104_entry`,
    entryType: `${TYPES}/entryTypes/entrygroup`,
    aspects: aspect('entrygroup-aspect', {}),
    entrySource: {
      resource: GROUP,
      system: 'Dataplex',
      platform: 'GCP',
      location: 'global',
    },
  },
  {
    name: `${GROUP}/entries/shop.metrics.revenue`,
    entryType: `${TYPES}/entryTypes/semantic-metric`,
    aspects: aspect('semantic-metric', {entity: 'orders', dataType: 'NUMERIC'}),
    parentEntry: ANCHOR,
    entrySource: {
      displayName: 'revenue',
      description: 'Total order value',
      location: 'global',
    },
  },
  {
    name: ANCHOR,
    entryType: `${TYPES}/entryTypes/semantic-model`,
    aspects: aspect('semantic-model', {}),
    entrySource: {
      displayName: 'shop',
      description: 'Tiny v1 (flag-off) prod test model (b/575695037)',
      labels: {'kcmd-push-id': PUSH_ID},
      location: 'global',
    },
  },
  {
    name: `${GROUP}/entries/shop.entities.customers`,
    entryType: `${TYPES}/entryTypes/semantic-entity`,
    aspects: {
      ...aspect('schema', {
        fields: [
          {name: 'customer_id', dataType: 'INT64', metadataType: 'NUMBER'},
          {name: 'full_name', dataType: 'STRING', metadataType: 'STRING'},
        ],
        primaryKey: {fields: ['customer_id']},
      }),
      ...aspect('semantic-entity', {source: {resources: [TABLE('customers')]}}),
    },
    parentEntry: ANCHOR,
    entrySource: {
      displayName: 'customers',
      description: 'A customer who places orders',
      location: 'global',
    },
  },
  {
    name: `${GROUP}/entries/shop.files.shop.yaml`,
    entryType:
        'projects/kc-looker-external/locations/global/entryTypes/semantic-model-file',
    aspects: aspect(
        'semantic-model-file', {
          fileName: 'shop.yaml',
          content: FIRST_GEN_MODEL_FILE,
          pushId: PUSH_ID,
          pushFileCount: 1,
        },
        'kc-looker-external'),
    parentEntry: ANCHOR,
    entrySource: {location: 'global'},
  },
];

// A fresh copy of the captured entries, which a test may change.
export function firstGenEntries(): Entry[] {
  return structuredClone(ENTRIES);
}

