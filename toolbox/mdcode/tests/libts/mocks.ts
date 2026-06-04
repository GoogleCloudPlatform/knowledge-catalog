import * as gcp from '../../src/libts/gcp';
import * as bigquery from '../../src/libts/gcp/bigquery';

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

  async *listTables(project: string, dataset: string): AsyncGenerator<bigquery.Table> {
    for (const table of this.mockTables.values()) {
      if (table.tableReference.projectId === project && table.tableReference.datasetId === dataset) {
        yield table;
      }
    }
  }
}
