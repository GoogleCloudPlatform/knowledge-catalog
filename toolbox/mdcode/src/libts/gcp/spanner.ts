// API client for Cloud Spanner, covering two surfaces the semantic-model push
// leg needs: Database Admin (updateDatabaseDdl and getOperation) to deploy
// Spanner Graph DDL, and the data plane (sessions and executeSql) to PLAN an
// action's DML against the live database before publishing it.

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


// A data-plane session, as returned by createSession. `name` is the full
// resource name the executeSql and delete calls address.
export interface Session {
  name?: string;
  [key: string]: any;
}


// The response to executeSql. Under queryMode PLAN nothing is executed, so the
// only field that matters is `stats.queryPlan`: its presence is the signal that
// Spanner parsed, resolved and type-checked the statement.
export interface ResultSet {
  stats?: {queryPlan?: {planNodes?: Array<{[key: string]: any}>}};
  [key: string]: any;
}


// A Spanner parameter type code (`INT64`, `STRING`, `TIMESTAMP`, ...), in the
// shape the executeSql `paramTypes` map takes.
export interface SpannerType {
  code: string;
}


export class SpannerClient extends api.ApiClient {
  constructor(ctx: context.ApiContext) {
    super('https://spanner.googleapis.com', 'v1', ctx);
  }

  // Applies DDL statements to a database. This is asynchronous: the response is
  // a long-running Operation whose `name` the caller polls with getOperation
  // until `done`. Statements are applied in order. The REST binding for
  // updateDatabaseDdl is PATCH on the `.../ddl` collection (a POST 404s --
  // verified live), so this uses PATCH, not the more common POST-to-create.
  async updateDatabaseDdl(
      project: string, instance: string, database: string,
      statements: string[]): Promise<api.ApiResult<Operation>> {
    const name =
        `projects/${project}/instances/${instance}/databases/${database}/ddl`;
    return await this._patch<Operation>(name, {statements});
  }

  // Fetches a long-running operation by its resource name (as returned in
  // Operation.name, e.g.
  // `projects/.../instances/.../databases/.../operations/...`).
  async getOperation(operationName: string): Promise<api.ApiResult<Operation>> {
    return await this._get<Operation>(operationName);
  }

  // Opens a data-plane session on a database. Every executeSql call runs in
  // one; the caller is responsible for deleting it when done.
  async createSession(project: string, instance: string, database: string):
      Promise<api.ApiResult<Session>> {
    const parent = `projects/${project}/instances/${instance}/databases/${
        database}/sessions`;
    return await this._post<Session>(parent, {});
  }

  // Closes a session by its full resource name. Deleting a session discards
  // any transaction still open on it, which is how a PLAN-only caller disposes
  // of the read-write transactions it began and never committed.
  async deleteSession(sessionName: string): Promise<api.ApiResult<{}>> {
    return await this._delete<{}>(sessionName);
  }

  // Plans a DML statement WITHOUT executing it, and without writing anything.
  //
  // Two parts of the request are load-bearing and were both established live
  // against a real database:
  //
  //   - `queryMode: PLAN` asks Spanner to parse, resolve every table and
  //     column, and type-check the statement, then return the query plan
  //     instead of running it. A `Table not found`, an `Unrecognized name`
  //     (with Spanner's own "Did you mean ...?"), a bad assignment type and a
  //     wrong-dialect construct all come back here as an error.
  //   - `transaction.begin.readWrite` is NOT optional. Spanner refuses DML
  //     outside a read-write transaction even in PLAN mode
  //     ("DML statements can only be performed in a read-write transaction"),
  //     so the request begins one. Because PLAN executes nothing, the
  //     transaction is never committed and the caller drops it by deleting the
  //     session.
  //
  // `params`/`paramTypes` are optional: Spanner infers a `@name` reference's
  // type from its context when neither is supplied. Passing them turns the
  // action's DECLARED parameter types into a claim checked against the real
  // column types, which is the reason to bother. A parameter named in `params`
  // must also appear in `paramTypes` -- a null with no declared type is the one
  // combination Spanner cannot infer.
  async planDml(
      sessionName: string, sql: string, params?: Record<string, null>,
      paramTypes?: Record<string, SpannerType>):
      Promise<api.ApiResult<ResultSet>> {
    const body: Record<string, unknown> = {
      sql,
      queryMode: 'PLAN',
      transaction: {begin: {readWrite: {}}},
    };
    if (params && Object.keys(params).length) {
      body.params = params;
      body.paramTypes = paramTypes;
    }
    return await this._post<ResultSet>(`${sessionName}:executeSql`, body);
  }
}
