// API client for BigLake, covering the one call the source check needs:
// reading an Iceberg REST catalog, whose region decides where Knowledge
// Catalog keeps the entries of its tables.

import * as api from './api';
import * as context from './context';


// A BigLake Iceberg REST catalog, as getCatalog returns it. The API writes its
// fields in kebab case. `replicas` names the regions that hold the catalog,
// written as the API writes them. A regional or federated catalog lists one
// replica with no state: `us-central1`, or `US` for a federated multi-region
// one. A multi-region catalog of Cloud Storage tables lists one replica per
// region, one of them `STATE_PRIMARY` and the rest `STATE_SECONDARY`, and
// lists none for a few seconds after it is created (live, 2026-11-03).
export interface Catalog {
  name?: string;
  'catalog-type'?: string;
  replicas?: Array<{region?: string; state?: string}>;
  'storage-regions'?: string[];
  [key: string]: any;
}


export class BigLakeClient extends api.ApiClient {
  constructor(ctx: context.ApiContext) {
    super('https://biglake.googleapis.com', 'iceberg/v1/restcatalog/extensions',
          ctx);
  }

  // Fetches a catalog. A catalog that does not exist answers 404.
  async getCatalog(project: string, catalog: string):
      Promise<api.ApiResult<Catalog>> {
    return await this._get<Catalog>(`projects/${project}/catalogs/${catalog}`);
  }
}
