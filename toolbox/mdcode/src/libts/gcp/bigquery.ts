// API client for BigQuery
//

import * as api from './api';
import * as context from './context';


export interface Dataset {
  id: string;
  datasetReference: {
    projectId: string;
    datasetId: string;
  };
  location: string;
  [key: string]: any;
}

export interface Table {
  id: string;
  tableReference: {
    projectId: string;
    datasetId: string;
    tableId: string;
  };
  [key: string]: any;
}

interface TableList {
  tables: Table[];
  nextPageToken?: string;
}

export interface QueryResponse {
  jobComplete?: boolean;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  errors?: { reason?: string; message: string }[];
  [key: string]: any;
}

export interface Job {
  status?: {
    state?: string;
    errorResult?: { reason?: string; message: string };
    errors?: { reason?: string; message: string }[];
  };
  [key: string]: any;
}


export class BigQueryClient extends api.ApiClient {

  constructor(ctx: context.ApiContext) {
    super('https://bigquery.googleapis.com', 'bigquery/v2', ctx);
  }

  async getDataset(project: string, dataset: string): Promise<api.ApiResult<Dataset>> {
    const name = `projects/${project}/datasets/${dataset}`;
    const params: Record<string, any> = { datasetView: 'METADATA' };

    return await this._get(name, params);
  }

  // Fetches a single table's metadata. Used as a cheap existence/access probe
  // before deploy: a 200 means the table is reachable, a 404 that it does not
  // exist, a 403 that the caller cannot see it. `selectedFields` trims the
  // response to the reference alone, since only the status is consulted.
  async getTable(project: string, dataset: string, table: string): Promise<api.ApiResult<Table>> {
    const name = `projects/${project}/datasets/${dataset}/tables/${table}`;
    const params: Record<string, any> = { selectedFields: 'tableReference' };

    return await this._get<Table>(name, params);
  }

  async *listTables(project: string, dataset: string): AsyncGenerator<Table> {
    const name = `projects/${project}/datasets/${dataset}/tables`;

    let pageToken: string | undefined = undefined;
    do {
      const params: Record<string, any> = { maxResults: 500 };
      if (pageToken) {
        params.pageToken = pageToken;
      }

      const res = await this._get<TableList>(name, params);
      if (res.status !== 200) {
        throw new Error(`Failed to list tables: ${res.message || res.status}`);
      }

      const tables = res.result?.tables || [];
      for (const table of tables) {
        yield table;
      }

      pageToken = res.result?.nextPageToken;
    } while (pageToken);
  }

  // Executes a SQL statement (including DDL) synchronously via jobs.query.
  // When `location` is set it pins the job's processing location so it agrees
  // with getQueryResults/getJob; otherwise BigQuery infers it from the
  // referenced tables.
  async query(project: string, sql: string, location?: string): Promise<api.ApiResult<QueryResponse>> {
    const name = `projects/${project}/queries`;
    const body: Record<string, any> = { query: sql, useLegacySql: false };
    if (location) {
      body.location = location;
    }
    return await this._post<QueryResponse>(name, body);
  }

  // Fetches the status/results of a running query job. Used to poll until the
  // job reports `jobComplete`, since jobs.query can return before a slow DDL
  // statement has finished executing.
  async getQueryResults(project: string, jobId: string, location?: string): Promise<api.ApiResult<QueryResponse>> {
    const name = `projects/${project}/queries/${jobId}`;
    const params: Record<string, any> = { maxResults: 0, timeoutMs: 10000 };
    if (location) {
      params.location = location;
    }
    return await this._get<QueryResponse>(name, params);
  }

  // Fetches a job's full status. status.errorResult is the definitive fatal
  // error for a completed job; the query response's errors[] also includes
  // non-fatal warnings, so it cannot decide success on its own.
  async getJob(project: string, jobId: string, location?: string): Promise<api.ApiResult<Job>> {
    const name = `projects/${project}/jobs/${jobId}`;
    const params: Record<string, any> = {};
    if (location) {
      params.location = location;
    }
    return await this._get<Job>(name, params);
  }
}
