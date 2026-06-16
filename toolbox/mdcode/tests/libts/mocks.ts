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
  async getGlossary(project: string, location: string, glossaryId: string): Promise<gcp.ApiResult<any>> {
    const nameSuffix = `/glossaries/${glossaryId}`;
    const entry = this.mockEntries.find(e => e.name.endsWith(nameSuffix));
    if (entry) {
      return { status: 200, result: { displayName: entry.entrySource?.displayName || glossaryId } };
    }
    return { status: 404, message: 'Not found' };
  }

  async getGlossaryTerm(project: string, location: string, glossaryId: string, termId: string): Promise<gcp.ApiResult<any>> {
    const nameSuffix = `/glossaries/${glossaryId}/terms/${termId}`;
    const entry = this.mockEntries.find(e => e.name.endsWith(nameSuffix));
    if (entry) {
      return { status: 200, result: { displayName: entry.entrySource?.displayName || termId } };
    }
    return { status: 404, message: 'Not found' };
  }

  async getEntry(project: string, location: string, entryGroup: string, id: string,
                 aspects?: string[]): Promise<gcp.ApiResult<gcp.Entry>> {
    const name = `projects/${project}/locations/${location}/entryGroups/${entryGroup}/entries/${id}`;
    const entry = this.mockEntries.find(e => e.name == name);
    if (entry) {
      const cloned = JSON.parse(JSON.stringify(entry));
      await this.fixEntry(cloned);
      return { status: 200, result: cloned };
    }
    return { status: 404, message: 'Not found' };
  }

  async lookupEntry(project: string, location: string, name: string, aspects?: string[]): Promise<gcp.ApiResult<gcp.Entry>> {
    const entry = this.mockEntries.find(e => e.name == name);
    if (entry) {
      const cloned = JSON.parse(JSON.stringify(entry));
      await this.fixEntry(cloned);
      return { status: 200, result: cloned };
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
      const cloned = JSON.parse(JSON.stringify(existingEntry));
      await this.fixEntry(cloned);
      return { status: 200, result: cloned };
    }
    return { status: 404, message: 'Not found' };
  }

  async *listEntries(project: string, location: string,
                     entryGroup: string): AsyncGenerator<gcp.Entry, void, unknown> {
    for (const entry of this.mockEntries) {
      const cloned = JSON.parse(JSON.stringify(entry));
      await this.fixEntry(cloned);
      yield cloned;
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
      const cloned = JSON.parse(JSON.stringify(existingEntry));
      await this.fixEntry(cloned);
      return { status: 200, result: cloned };
    }
    return { status: 404, message: 'Not found' };
  }

  public mockEntryLinks: gcp.EntryLink[] = [];

  async lookupEntryLinks(
    project: string,
    location: string,
    entryName: string,
    entryLinkTypes?: string[]
  ): Promise<gcp.ApiResult<gcp.LookupEntryLinksResponse>> {
    const links = this.mockEntryLinks.filter(l =>
      l.entryReferences.some(r => r.name === entryName) &&
      (!entryLinkTypes || entryLinkTypes.includes(l.entryLinkType))
    );
    const clonedLinks = JSON.parse(JSON.stringify(links));
    for (const link of clonedLinks) {
      await this.fixEntryLink(link);
    }
    return { status: 200, result: { entryLinks: clonedLinks } };
  }

  async createEntryLink(
    project: string,
    location: string,
    entryGroup: string,
    entryLink: gcp.EntryLink
  ): Promise<gcp.ApiResult<gcp.EntryLink>> {
    const createdLink = { ...entryLink, name: `${gcp.catalogContainer(project, location, entryGroup)}/entryLinks/link-${Date.now()}` };
    this.mockEntryLinks.push(createdLink);
    return { status: 200, result: createdLink };
  }

  async deleteEntryLink(
    project: string,
    location: string,
    entryGroup: string,
    entryLinkName: string
  ): Promise<gcp.ApiResult<any>> {
    const name = `${gcp.catalogContainer(project, location, entryGroup)}/entryLinks/${entryLinkName}`;
    const idx = this.mockEntryLinks.findIndex(l => l.name === name || l.name.endsWith(entryLinkName));
    if (idx !== -1) {
      this.mockEntryLinks.splice(idx, 1);
      return { status: 200, result: {} };
    }
    return { status: 404, message: 'Not found' };
  }

  async *listEntryLinks(
    project: string,
    location: string,
    entryGroup: string,
    filter?: string
  ): AsyncGenerator<gcp.EntryLink, void, unknown> {
    const parent = gcp.catalogContainer(project, location, entryGroup);
    for (const link of this.mockEntryLinks) {
      if (link.name.startsWith(parent)) {
        const clonedLink = JSON.parse(JSON.stringify(link));
        await this.fixEntryLink(clonedLink);
        yield clonedLink;
      }
    }
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
