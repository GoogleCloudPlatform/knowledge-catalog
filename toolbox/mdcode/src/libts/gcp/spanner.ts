// API client for Cloud Spanner (Database Admin surface).
//
// The semantic-model Spanner leg only needs to run DDL and a table existence
// probe, so this exposes just those: updateDatabaseDdl (which returns a
// long-running operation), getOperation (to poll it), and getTable (a cheap
// pre-flight over information schema is out of scope here; see the deploy leg).
//

import * as api from './api';
import * as context from './context';


// A long-running operation, as returned by updateDatabaseDdl and fetched by
// getOperation. `done` flips to true at completion; `error` is set on failure
// (a google.rpc.Status).
export interface Operation {
  name?: string;
  done?: boolean;
  error?: {code?: number; message?: string; [key: string]: any};
  response?: {[key: string]: any};
  metadata?: {[key: string]: any};
  [key: string]: any;
}


export class SpannerClient extends api.ApiClient {
  constructor(ctx: context.ApiContext) {
    super('https://spanner.googleapis.com', 'v1', ctx);
  }

  // Applies DDL statements to a database. This is asynchronous: the response is
  // a long-running Operation whose `name` the caller polls with getOperation
  // until `done`. Statements are applied in order.
  async updateDatabaseDdl(
      project: string, instance: string, database: string,
      statements: string[]): Promise<api.ApiResult<Operation>> {
    const name =
        `projects/${project}/instances/${instance}/databases/${database}/ddl`;
    return await this._post<Operation>(name, {statements});
  }

  // Fetches a long-running operation by its resource name (as returned in
  // Operation.name, e.g.
  // `projects/.../instances/.../databases/.../operations/...`).
  async getOperation(operationName: string): Promise<api.ApiResult<Operation>> {
    return await this._get<Operation>(operationName);
  }
}
