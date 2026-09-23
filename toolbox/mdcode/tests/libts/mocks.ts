import * as gcp from '../../src/libts/gcp';
import * as bigquery from '../../src/libts/gcp/bigquery';
import * as spanner from '../../src/libts/gcp/spanner';

// Bypass actual gcloud CLI calls by using the explicit constructor
export const TEST_API_CONTEXT = new gcp.ApiContext('test-project', 'test-location', 'test-token');


export class CatalogClientMock extends gcp.CatalogClient {
  public mockEntries: gcp.Entry[] = [];
  public mockEntryGroups: Map<string, gcp.EntryGroup> = new Map();
  public mockEntryTypes: Map<string, gcp.EntryType> = new Map();
  public mockAspectTypes: Map<string, gcp.AspectType> = new Map();

  constructor() {
    super(TEST_API_CONTEXT);
  }

  setMockEntries(entries: gcp.Entry[]) {
    this.mockEntries = entries;
  }

  addMockEntryGroup(resource: gcp.EntryGroup) {
    this.mockEntryGroups.set(resource.name, resource);
  }

  addMockEntryType(resource: gcp.EntryType) {
    this.mockEntryTypes.set(resource.name, resource);
  }

  addMockAspectType(resource: gcp.AspectType) {
    this.mockAspectTypes.set(resource.name, resource);
  }

  async getEntryGroup(project: string, location: string, id: string): Promise<gcp.ApiResult<gcp.EntryGroup>> {
    const name = `projects/${project}/locations/${location}/entryGroups/${id}`;
    const group = this.mockEntryGroups.get(name);
    if (group) {
      return { status: 200, result: group };
    }
    return { status: 404, message: 'Not found' };
  }

  async getEntryType(project: string, location: string, id: string): Promise<gcp.ApiResult<gcp.EntryType>> {
    const name = `projects/${project}/locations/${location}/entryTypes/${id}`;
    const res = this.mockEntryTypes.get(name);
    if (res) {
      return { status: 200, result: res };
    }
    return { status: 404, message: 'Not found' };
  }

  async getAspectType(project: string, location: string, id: string): Promise<gcp.ApiResult<gcp.AspectType>> {
    const name = `projects/${project}/locations/${location}/aspectTypes/${id}`;
    const res = this.mockAspectTypes.get(name);
    if (res) {
      return { status: 200, result: res };
    }
    return { status: 404, message: 'Not found' };
  }

  async getEntry(project: string, location: string, entryGroup: string, id: string,
                 aspects?: string[]): Promise<gcp.ApiResult<gcp.Entry>> {
    const name = `projects/${project}/locations/${location}/entryGroups/${entryGroup}/entries/${id}`;
    const entry = this.mockEntries.find(e => e.name == name);
    if (entry) {
      return { status: 200, result: entry };
    }
    return { status: 404, message: 'Not found' };
  }

  async lookupEntry(project: string, location: string, name: string, aspects?: string[]): Promise<gcp.ApiResult<gcp.Entry>> {
    const entry = this.mockEntries.find(e => e.name == name);
    if (entry) {
      return { status: 200, result: entry };
    }
    return { status: 404, message: 'Not found' };
  }

  async modifyEntry(project: string, location: string, entry: gcp.Entry, updateMask?: string[], aspectKeys?: string[]): Promise<gcp.ApiResult<gcp.Entry>> {
    const existingEntry = this.mockEntries.find(e => e.name == entry.name);
    if (existingEntry) {
      if (updateMask?.find(m => m == 'entry_source')) {
        existingEntry.entrySource = entry.entrySource;
      }
      if (updateMask?.find(m => m == 'aspects')) {
        if (!existingEntry.aspects) {
          existingEntry.aspects = {};
        }
        for (const aspectKey of aspectKeys ?? []) {
          if (entry.aspects?.[aspectKey]) {
            existingEntry.aspects[aspectKey] = entry.aspects[aspectKey];
          }
          else {
            delete existingEntry.aspects[aspectKey];
          }
        }
      }
      return { status: 200, result: existingEntry };
    }
    return { status: 404, message: 'Not found' };
  }

  async *listEntries(project: string, location: string,
                     entryGroup: string): AsyncGenerator<gcp.Entry, void, unknown> {
    for (const entry of this.mockEntries) {
      yield entry;
    }
  }

  async updateEntry(entry: gcp.Entry, updateMask?: string[], aspectKeys?: string[]): Promise<gcp.ApiResult<gcp.Entry>> {
    const existingEntry = this.mockEntries.find(e => e.name == entry.name);
    if (existingEntry) {
      if (updateMask?.find(m => m == 'entry_source')) {
        existingEntry.entrySource = entry.entrySource;
      }
      if (updateMask?.find(m => m == 'aspects')) {
        if (!existingEntry.aspects) {
          existingEntry.aspects = {};
        }
        for (const f in aspectKeys ?? []) {
          if (entry.aspects?.[f]) {
            existingEntry.aspects[f] = entry.aspects[f];
          }
          else {
            delete existingEntry.aspects[f];
          }
        }
      }
      return { status: 200, result: existingEntry };
    }
    return { status: 404, message: 'Not found' };
  }

  async createEntry(project: string, location: string, entryGroup: string, entryId: string, entry?: gcp.Entry): Promise<gcp.ApiResult<gcp.Entry>> {
    const fakeEntry = entry;
    if (fakeEntry) {
      this.mockEntries.push(fakeEntry);
      return { status: 200, result: entry };
    }
    return {status: 404, message: 'Not found' };
  }
}


export class BigQueryClientMock extends bigquery.BigQueryClient {
  public mockDatasets: Map<string, any> = new Map();
  public mockTables: Map<string, any> = new Map();

  constructor() {
    super(TEST_API_CONTEXT);
  }

  addMockDataset(resource: bigquery.Dataset) {
    const name = `projects/${resource.datasetReference.projectId}/datasets/${resource.datasetReference.datasetId}`;
    this.mockDatasets.set(name, resource);
  }

  addMockTable(resource: bigquery.Table) {
    const name = `projects/${resource.tableReference.projectId}/datasets/${resource.tableReference.datasetId}/tables/${resource.tableReference.tableId}`;
    this.mockTables.set(name, resource);
  }

  async getDataset(project: string, id: string): Promise<gcp.ApiResult<bigquery.Dataset>> {
    const name = `projects/${project}/datasets/${id}`;
    const resource = this.mockDatasets.get(name);
    if (resource) {
      return { status: 200, result: resource };
    }
    return { status: 404, message: 'Not found' };
  }

  async getTable(project: string, dataset: string, table: string): Promise<gcp.ApiResult<bigquery.Table>> {
    const name = `projects/${project}/datasets/${dataset}/tables/${table}`;
    const resource = this.mockTables.get(name);
    if (resource) {
      return { status: 200, result: resource };
    }
    return { status: 404, message: 'Not found' };
  }

  async *listTables(project: string, dataset: string): AsyncGenerator<bigquery.Table> {
    for (const table of this.mockTables.values()) {
      if (table.tableReference.projectId === project && table.tableReference.datasetId === dataset) {
        yield table;
      }
    }
  }

  // Reachable sources for the dry-run probe (validateBigQueryDataSources). Use
  // for reference forms tables.get cannot address, e.g. a four-part REST-catalog
  // name; a three-part table added via addMockTable is reachable too.
  public mockSources: Set<string> = new Set();

  addMockSource(ref: string) {
    this.mockSources.add(ref);
  }

  // Dry-run table probe: a query of the form `SELECT 1 FROM \`<ref>\`` resolves
  // against the reachable set (mockSources, plus any three-part table added via
  // addMockTable). An unknown reference returns a BigQuery-style "Not found" so
  // the validator reports it; a non-probe query is a benign success.
  // Tables the DML pre-flight (validateBigQueryActionStatements) resolves
  // against, separate from mockSources because that one only answers "does this
  // reference exist" while a DML statement is also checked column by column.
  public dmlSchema: MockSchema = new Map();
  // Every dry run of a DML statement, in order, for a test that asserts what
  // was sent.
  public dryRunDml: Array<{
    project: string,
    sql: string,
    parameterTypes?: Record<string, string>,
  }> = [];

  async query(project: string, sql: string, location?: string, dryRun?: boolean,
              namedParameterTypes?: Record<string, string>):
      Promise<gcp.ApiResult<bigquery.QueryResponse>> {
    if (dryRun && /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i.test(sql)) {
      this.dryRunDml.push({project, sql, parameterTypes: namedParameterTypes});
      const rejection = mockPlanRejection(sql, this.dmlSchema);
      return rejection ? {status: 400, message: rejection} :
                         {status: 200, result: {}};
    }
    const m = /FROM `([^`]+)`/.exec(sql);
    if (dryRun && m) {
      return this.isReachableSource(m[1]) ?
          {status: 200, result: {}} :
          {status: 400, message: `Not found: Table ${m[1]} was not found`};
    }
    return {status: 200, result: {}};
  }

  private isReachableSource(ref: string): boolean {
    if (this.mockSources.has(ref)) return true;
    const parts = ref.split('.');
    if (parts.length === 3) {
      return this.mockTables.has(
          `projects/${parts[0]}/datasets/${parts[1]}/tables/${parts[2]}`);
    }
    return false;
  }
}


// A schema for the DML pre-flight fakes below: table name -> its column names,
// both lower-cased so a lookup is case-insensitive the way GoogleSQL is.
export type MockSchema = Map<string, Set<string>>;


export function mockSchema(tables: Record<string, string[]>): MockSchema {
  const schema: MockSchema = new Map();
  for (const [table, columns] of Object.entries(tables)) {
    schema.set(table.toLowerCase(), new Set(columns.map(c => c.toLowerCase())));
  }
  return schema;
}


// The error a store would return for this DML statement, or null when it would
// be accepted. Shared by the Spanner and BigQuery fakes because both backends
// answer the same two complaints in the same words.
//
// This is NOT a SQL engine: it finds the table the statement writes to, then
// walks the remaining bare identifiers and rejects the first one the declared
// schema does not have. That is enough to spec the validator's own behavior --
// which statements it sends, where it sends them, how it reports a rejection,
// and that it cleans up afterwards -- while the fidelity of the real check is
// what the live e2e tests cover.
export function mockPlanRejection(
    sql: string, schema: MockSchema): string|null {
  // The written table, with any backtick-quoted qualification stripped to its
  // last part, so `p.d.account` and a bare `account` both look up the same.
  const written =
      /\b(?:INTO|UPDATE|FROM)\s+`?([A-Za-z_][\w.$-]*)`?/i.exec(sql)?.[1];
  const table = written?.split('.').pop();
  if (!table || !schema.has(table.toLowerCase())) {
    return JSON.stringify({
      error: {message: `Not found: Table ${written ?? '?'} was not found`},
    });
  }
  const columns = schema.get(table.toLowerCase())!;
  const keywords = new Set([
    'insert', 'into', 'values', 'update', 'set', 'delete', 'from', 'where',
    'and', 'or', 'not', 'null', 'true', 'false',
  ]);
  // Drop bound parameters and the table reference itself; what is left in
  // identifier position should all be columns.
  const rest = sql.replace(/@\w+/g, ' ').replace(/`[^`]*`/g, ' ');
  const bare = written && !sql.includes('`') ? written : '';
  for (const m of rest.matchAll(/[A-Za-z_]\w*/g)) {
    const word = m[0].toLowerCase();
    if (keywords.has(word) || word === bare.toLowerCase()) continue;
    if (columns.has(word)) continue;
    // Spanner and BigQuery both suggest the near-miss, which is most of the
    // value of asking the store at all -- so the fake suggests it too.
    const near =
        [...columns].find(c => c.replace(/_/g, '') === word.replace(/_/g, ''));
    return JSON.stringify({
      error: {
        message: `Unrecognized name: ${m[0]}${
            near ? `; Did you mean ${near}?` : ''} at [1:${m.index! + 1}]`,
      },
    });
  }
  return null;
}


// A Spanner client whose data plane answers from a declared schema instead of a
// live database, for the push-time DML pre-flight
// (validateSpannerActionStatements). See mockPlanRejection for what it does and
// does not model.
export class SpannerClientMock extends spanner.SpannerClient {
  public schema: MockSchema = new Map();
  // Every planDml call, in order, for a test that asserts what was sent.
  public planned: Array<{
    session: string,
    sql: string,
    params?: Record<string, null>,
    paramTypes?: Record<string, {code: string}>,
  }> = [];
  public createdSessions: string[] = [];
  public deletedSessions: string[] = [];
  // Set to fail createSession, standing in for an unreachable database.
  public sessionError?: string;

  private nextSession = 0;

  constructor() {
    super(TEST_API_CONTEXT);
  }

  async createSession(project: string, instance: string, database: string):
      Promise<gcp.ApiResult<spanner.Session>> {
    if (this.sessionError) return {status: 403, message: this.sessionError};
    const name = `projects/${project}/instances/${instance}/databases/${
        database}/sessions/s${this.nextSession++}`;
    this.createdSessions.push(name);
    return {status: 200, result: {name}};
  }

  async deleteSession(sessionName: string): Promise<gcp.ApiResult<{}>> {
    this.deletedSessions.push(sessionName);
    return {status: 200, result: {}};
  }

  async planDml(
      sessionName: string, sql: string, params?: Record<string, null>,
      paramTypes?: Record<string, {code: string}>):
      Promise<gcp.ApiResult<spanner.ResultSet>> {
    this.planned.push({session: sessionName, sql, params, paramTypes});
    const rejection = mockPlanRejection(sql, this.schema);
    if (rejection) return {status: 400, message: rejection};
    return {
      status: 200,
      result: {
        stats: {queryPlan: {planNodes: [{displayName: 'Apply Mutations'}]}},
      },
    };
  }
}
