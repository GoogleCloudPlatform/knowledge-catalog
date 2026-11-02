// Trimmed copies of what the services returned on 2026-10-27 in
// kc-looker-external, for the reads that find where Knowledge Catalog keeps a
// table's entry. Shared by the client tests and the source check's tests, so
// both copy the same live behavior:
//
// - A BigQuery dataset writes its location as the API writes it (`US`); its
//   entries sit in `us`.
// - A Spanner instance names its config by full name, and the config marks
//   one replica as its default leader, where the entries sit: us-central1 for
//   `regional-us-central1`, us-east4 for `nam3`.
// - A BigLake catalog lists the one region it lives in; a multi-region
//   catalog writes it in upper case (`US`), and its entries sit in `us`.
// - A missing dataset, instance or catalog answers 404.
// - Knowledge Catalog answers 403, with the message below, both for a missing
//   entry and for a lookup in the wrong location.

export const P = 'kc-looker-external';

export const US_DATASET = {
  id: `${P}:kcmd_demo`,
  datasetReference: {datasetId: 'kcmd_demo', projectId: P},
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
export const MULTI_REGION_CATALOG = {
  'name': 'projects/looker-private-demo/catalogs/snowflake',
  'catalog-type': 'CATALOG_TYPE_FEDERATED',
  'storage-regions': ['US'],
  'replicas': [{region: 'US'}],
};

export const NOT_FOUND = {status: 404, message: 'Not found'};

// Knowledge Catalog's answer for the entry `name` when it is missing or in
// another location.
export function entryDenied(name: string) {
  return {
    status: 403,
    message: `Permission denied on resource \`${name}\` (or it may not exist).`,
  };
}
