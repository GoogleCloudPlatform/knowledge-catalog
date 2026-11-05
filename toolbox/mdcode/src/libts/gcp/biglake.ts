// API client for BigLake, covering the calls the source check needs: reading
// an Iceberg REST catalog or a Hive catalog, whose region decides where
// Knowledge Catalog keeps the entries of its tables.

import * as api from './api';
import * as context from './context';


// A BigLake catalog, as getCatalog or getHiveCatalog returns it. The Iceberg
// REST catalog API writes its fields in kebab case. `replicas` names the
// regions that hold the catalog, written as the API writes them. A regional or
// federated catalog lists one replica with no state: `us-central1`, or `US` for
// a federated multi-region one. A multi-region catalog of Cloud Storage tables
// lists one replica per region, one of them `STATE_PRIMARY` and the rest
// `STATE_SECONDARY`, and lists none for a few seconds after it is created
// (live, 2026-11-03). A table's entry sits in the region that was the primary
// when the table was created, so after a failover an older table's entry can
// sit in a former primary's region, now a secondary's; while the failover runs,
// the new primary reads `STATE_PRIMARY_IN_PROGRESS` (from review on #623,
// 2026-11-03).
export interface Catalog {
  name?: string;
  'catalog-type'?: string;
  replicas?: Array<{region?: string; state?: string}>;
  'storage-regions'?: string[];
  [key: string]: any;
}


export class BigLakeClient extends api.ApiClient {
  private readonly hive: api.ApiClient;

  constructor(ctx: context.ApiContext) {
    super('https://biglake.googleapis.com', 'iceberg/v1/restcatalog/extensions',
          ctx);
    this.hive =
        new api.ApiClient('https://biglake.googleapis.com', 'hive/v1', ctx);
  }

  // Fetches an Iceberg REST catalog. A catalog that does not exist answers
  // 404, and a Hive catalog answers 400.
  async getCatalog(project: string, catalog: string):
      Promise<api.ApiResult<Catalog>> {
    return await this._get<Catalog>(`projects/${project}/catalogs/${catalog}`);
  }

  // Fetches a Hive catalog. Any other catalog answers 404, and an id that is
  // not lower-case letters, digits and underscores answers 400.
  async getHiveCatalog(project: string, catalog: string):
      Promise<api.ApiResult<Catalog>> {
    return await this.hive._get<Catalog>(
        `projects/${project}/catalogs/${catalog}`);
  }
}
