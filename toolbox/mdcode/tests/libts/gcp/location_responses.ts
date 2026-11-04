// Trimmed copies of what the services returned on 2026-10-27 in
// kc-looker-external (2026-11-03 where marked), for the reads that find where
// Knowledge Catalog keeps a table's entry. Shared by the client tests and the
// source check's tests, so both copy the same live behavior:
//
// - A BigQuery table writes its dataset's location as the API writes it
//   (`US`); its entries sit in `us` (2026-11-03).
// - A Spanner instance names its config by full name, and the config marks
//   one replica as its default leader, where the entries sit: us-central1 for
//   `regional-us-central1`, us-east4 for `nam3`.
// - A regional or federated BigLake catalog lists one replica, with no state;
//   a federated multi-region catalog writes it in upper case (`US`). A
//   multi-region catalog of Cloud Storage tables lists a primary and a
//   secondary replica (2026-11-03), and a table's entries sit in the region
//   that was the primary when the table was created: after a failover, an
//   older table's entries can sit in a former primary's region, now a
//   secondary's (from review on #623, 2026-11-03; not tested live by us).
// - A missing table, dataset, instance or catalog answers 404.
// - Spanner answers 403, naming the permission, for an instance or instance
//   config the caller may not read, whether or not it exists (on
//   bigquery-public-data and dataplex-staging-types, 2026-10-27; again
//   2026-11-03).
// - Knowledge Catalog answers 403, with the message below, both for a missing
//   entry and for a lookup in the wrong location.

export const P = 'kc-looker-external';

// bigquery tables.get with view=BASIC, 2026-11-03; schema and the other
// fields trimmed.
export const US_TABLE = {
  kind: 'bigquery#table',
  id: `${P}:kcmd_demo.orders`,
  tableReference: {projectId: P, datasetId: 'kcmd_demo', tableId: 'orders'},
  type: 'TABLE',
  location: 'US',
};

export const REGIONAL_INSTANCE = {
  name: `projects/${P}/instances/kcmd-src-reg`,
  config: `projects/${P}/instanceConfigs/regional-us-central1`,
};
export const REGIONAL_CONFIG = {
  name: `projects/${P}/instanceConfigs/regional-us-central1`,
  replicas: [
    {location: 'us-central1', type: 'READ_WRITE', defaultLeaderLocation: true},
    {location: 'us-central1', type: 'READ_WRITE'},
    {location: 'us-central1', type: 'READ_WRITE'},
  ],
};
export const NAM3_INSTANCE = {
  name: `projects/${P}/instances/kcmd-src-multi`,
  config: `projects/${P}/instanceConfigs/nam3`,
};
export const NAM3_CONFIG = {
  name: `projects/${P}/instanceConfigs/nam3`,
  replicas: [
    {location: 'us-east4', type: 'READ_WRITE', defaultLeaderLocation: true},
    {location: 'us-east4', type: 'READ_WRITE'},
    {location: 'us-east1', type: 'READ_WRITE'},
    {location: 'us-east1', type: 'READ_WRITE'},
    {location: 'us-central1', type: 'WITNESS'},
  ],
  leaderOptions: ['us-east1', 'us-east4'],
};
// A config whose default leader is not its first replica, as in nam22, nam23,
// eur7 and dual-region-japan1.
export const NAM22_CONFIG = {
  name: `projects/${P}/instanceConfigs/nam22`,
  replicas: [
    {location: 'us-east1', type: 'READ_WRITE'},
    {location: 'us-east1', type: 'READ_WRITE'},
    {location: 'us-east5', type: 'READ_WRITE', defaultLeaderLocation: true},
    {location: 'us-east5', type: 'READ_WRITE'},
    {location: 'us-east4', type: 'WITNESS'},
  ],
  leaderOptions: ['us-east1', 'us-east5'],
};

export const REGIONAL_CATALOG = {
  'name': `projects/${P}/catalogs/kcmd-src-biglake-57138`,
  'catalog-type': 'CATALOG_TYPE_GCS_BUCKET',
  'storage-regions': ['us-central1'],
  'replicas': [{region: 'us-central1'}],
};
export const FEDERATED_CATALOG = {
  'name': 'projects/looker-private-demo/catalogs/snowflake',
  'catalog-type': 'CATALOG_TYPE_FEDERATED',
  'storage-regions': ['US'],
  'replicas': [{region: 'US'}],
};
// A US catalog of Cloud Storage tables, seconds after it was created, on
// 2026-11-03 (a throwaway catalog, since deleted). Right after creation it
// listed `replicas: []`.
export const MULTI_REGION_GCS_CATALOG = {
  'name': `projects/${P}/catalogs/kcmd-biglake-probe-6890`,
  'catalog-type': 'CATALOG_TYPE_GCS_BUCKET',
  'storage-regions': ['US'],
  'replicas': [
    {region: 'us-central1', state: 'STATE_PRIMARY'},
    {region: 'us-east1', state: 'STATE_SECONDARY'},
  ],
};

// A Hive catalog, read in sqlgen-testing on 2026-11-04. It lists its primary
// replica first, and its tables' entries sit in `us`.
export const HIVE_CATALOG = {
  name: 'projects/sqlgen-testing/catalogs/sqlgen_jharshit_atscale_hive_us',
  replicas: [{region: 'US', state: 'STATE_PRIMARY'},
             {region: 'us-east1', state: 'STATE_SECONDARY'}],
};

export const NOT_FOUND = {status: 404, message: 'Not found'};

// The Iceberg REST catalog API's answer for HIVE_CATALOG (live, 2026-11-04).
export const NOT_ICEBERG = {
  status: 400,
  message: 'Catalog sqlgen_jharshit_atscale_hive_us is not an Iceberg Catalog.',
};

// The Hive API's answer for an id with a hyphen (live, 2026-11-04).
export const INVALID_HIVE_ID = {
  status: 400,
  message: "Invalid catalog name: 'kcmd-src-biglake-57138'. Must be a match " +
      "of regex '^[a-z0-9][a-z0-9_]{0,255}$'",
};

// BigQuery's tables.get answer for the table ID `orders!x`, which the loader
// accepts and BigQuery rejects (live, 2026-11-04; the message is the body's
// `error.message`).
export const INVALID_TABLE_ID = {
  status: 400,
  message: 'Invalid table ID "orders!x".',
};

// Spanner's answer when the caller lacks `permission` on `resource`, a full
// resource name such as `projects/p/instanceConfigs/nam3`, whether or not the
// resource exists (2026-10-27 and 2026-11-03).
export function spannerDenied(permission: string, resource: string) {
  return {
    status: 403,
    message: `Operation denied by [IAM permission '${permission}' on ` +
        `resource '//spanner.googleapis.com/${resource}'].`,
  };
}

// Knowledge Catalog's answer for the entry `name` when it is missing or in
// another location.
export function entryDenied(name: string) {
  return {
    status: 403,
    message: `Permission denied on resource \`${name}\` (or it may not exist).`,
  };
}

// Knowledge Catalog's lookupEntry answer for the malformed entry `name`
// (live in kc-looker-external, us-east4, 2026-11-04: for entry `` and `  `
// it answered 400 INVALID_ARGUMENT; the message is the body's
// `error.message`).
export function entryInvalid(name: string) {
  return {status: 400, message: `Invalid \`Entry\` resource name \`${name}\`.`};
}
