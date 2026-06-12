// API client for BigLake Metastore Service
//

import * as api from './api';
import * as context from './context';

export interface BigLakeTable {
  name: string;
  [key: string]: any;
}

interface TableList {
  tables?: BigLakeTable[];
  nextPageToken?: string;
}

export class BigLakeClient extends api.ApiClient {
  constructor(ctx: context.ApiContext, catalogType: 'iceberg') {
    const pathPrefix =
      catalogType === 'iceberg' ? 'iceberg/v1/restcatalog/v1' : '';
    super('https://biglake.googleapis.com', pathPrefix, ctx);
  }

  async *listTables(
    project: string,
    location: string,
    catalog: string,
    namespace: string,
  ): AsyncGenerator<BigLakeTable> {
    const name = `projects/${project}/catalogs/${catalog}/namespaces/${namespace}/tables`;

    const params: Record<string, any> = {};
    const res = await this._get<{
      identifiers?: Array<{namespace: string[]; name: string}>;
    }>(name, params);
    if (res.status !== 200) {
      throw new Error(
        `Failed to list BigLake Iceberg tables: ${res.message || res.status}`,
      );
    }

    const tables = res.result?.identifiers || [];
    for (const table of tables) {
      yield {
        name: `projects/${project}/locations/${location}/catalogs/${catalog}/namespaces/${namespace}/tables/${table.name}`,
      };
    }
  }
}
