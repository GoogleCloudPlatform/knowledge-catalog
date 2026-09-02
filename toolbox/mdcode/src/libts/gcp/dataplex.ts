// API client for Knowledge Catalog (Dataplex)
//

import * as api from './api';
import * as context from './context';
import * as crm from './crm';


export interface EntryGroup {
  name: string;
  [key: string]: any;
}

export interface EntryType {
  name: string;
  requiredAspects: { type: string; }[];
  [key: string]: any;
}

export interface AspectType {
  name: string;
  [key: string]: any;
}

export interface Aspect {
  aspectType?: string;
  data?: Record<string, any>;
}

export interface Entry {
  name: string;
  entryType: string;
  parentEntry?: string;
  createTime?: string;
  updateTime?: string;
  entrySource?: {
    resource?: string;
    ancestors?: {
      name: string;
      type: string;
    }[];
    displayName?: string;
    description?: string;
    labels?: Record<string, string>;
    location?: string;
    createTime?: string;
    updateTime?: string; 
  };
  aspects?: Record<string, Aspect>;
}

export interface EntryReference {
  // Full resource name of the referenced entry.
  name: string;
  // Path within the entry that is referenced; empty means the entry itself.
  path?: string;
  // SOURCE / TARGET for a directed link; UNSPECIFIED for an undirected one.
  type: 'UNSPECIFIED' | 'SOURCE' | 'TARGET';
}

export interface EntryLink {
  // Server-assigned (output only); set by the emitter to the destination name so
  // the publisher can address it for an in-place update.
  name?: string;
  entryLinkType: string;
  // Exactly two references.
  entryReferences: EntryReference[];
  // At most one Dataplex-owned aspect (e.g. schema-join), keyed as
  // `project.location.aspectType`.
  aspects?: Record<string, Aspect>;
}

interface EntryList {
  entries: Entry[];
  nextPageToken?: string;
}

interface EntryLinkList {
  // Absent when the referenced entry has no links of the requested type(s).
  entryLinks?: EntryLink[];
  nextPageToken?: string;
}


export class CatalogClient extends api.ApiClient {

  constructor(ctx: context.ApiContext) {
    // Defaults to the production Dataplex endpoint. Override via DATAPLEX_ENDPOINT
    // to target a non-prod host (e.g. an autopush/sandbox EAP), same env-var
    // knob style as GCP_LOG.
    super(process.env.DATAPLEX_ENDPOINT || 'https://dataplex.googleapis.com',
          'v1', ctx);
  }

  async getEntryGroup(project: string, location: string,
                      entryGroup: string): Promise<api.ApiResult<EntryGroup>> {
    const name = catalogContainer(project, location, entryGroup);
    return await this._get(name);
  }

  async getEntryType(project: string, location: string,
                     type: string): Promise<api.ApiResult<EntryType>> {
    const name = `${catalogContainer(project, location)}/entryTypes/${type}`;
    return await this._get(name);
  }

  async getAspectType(project: string, location: string,
                      type: string): Promise<api.ApiResult<AspectType>> {
    const name = `${catalogContainer(project, location)}/aspectTypes/${type}`;
    return await this._get(name);
  }

  async getEntry(project: string, location: string, entryGroup: string, entry: string,
                 aspects?: string[]): Promise<api.ApiResult<Entry>> {
    const name = `${catalogContainer(project, location, entryGroup)}/entries/${entry}`;
    const params: Record<string, any> = { view: 'BASIC' };
    if (aspects && aspects.length) {
      params.view = 'CUSTOM';
      params.aspectTypes = aspects;
    }

    const res = await this._get<Entry>(name, params);
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  async lookupEntry(project: string, location: string, name: string,
                    aspects?: string[]): Promise<api.ApiResult<Entry>> {
    const container = `${catalogContainer(project, location)}:lookupEntry`;
    const params: Record<string, any> = { entry: name, view: 'BASIC' };
    if (aspects && aspects.length) {
      params.view = 'CUSTOM';
      params.aspectTypes = aspects;
    }

    const res = await this._get<Entry>(container, params);
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  async modifyEntry(project: string, location: string, entry: Entry,
                    updateMask?: string[],
                    aspectKeys?: string[]): Promise<api.ApiResult<Entry>> {
    const container = `${catalogContainer(project, location)}:modifyEntry`;
    const body: Record<string, any> = {
      entry: entry,
      updateMask: updateMask ? updateMask.join(',') : undefined,
      aspectKeys: aspectKeys ?? undefined
    };

    const res = await this._post<Entry>(container, body);
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  async updateEntry(entry: Entry,
                    updateMask?: string[],
                    aspectKeys?: string[]): Promise<api.ApiResult<Entry>> {
    const params: Record<string, any> = {};
    if (updateMask && updateMask.length) {
      params.updateMask = updateMask.join(',');
    }
    if (aspectKeys && aspectKeys.length) {
      params.aspectKeys = aspectKeys;
    }

    const res = await this._patch<Entry>(entry.name, entry, params);
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  async *listEntries(project: string, location: string,
                     entryGroup: string): AsyncGenerator<Entry, void, unknown> {
    const parent = catalogContainer(project, location, entryGroup);
    const resourceName = `${parent}/entries`;

    let pageToken: string | undefined = undefined;
    do {
      const params: Record<string, string | number> = { pageSize: 1000 };
      if (pageToken) {
        params.pageToken = pageToken;
      }

      const res = await this._get<EntryList>(resourceName, params);
      if (res.status !== 200) {
        throw new Error(`Failed to list entries: ${res.message || res.status}`);
      }

      const entries = res.result?.entries || [];
      for (const entry of entries) {
        await _fixEntry(entry, this.context);
        yield entry;
      }

      pageToken = res.result?.nextPageToken;
    } while (pageToken);
  }

  async createEntry(project: string, location: string, entryGroup: string, 
                    entryId: string, entry?: Entry): Promise<api.ApiResult<Entry>> {
    const parent = catalogContainer(project, location, entryGroup);
    const resourceName = `${parent}/entries`;

    const params: Record<string, any> = { entryId };

    const res = await this._post<Entry>(resourceName, entry, params);
    
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  async deleteEntry(project: string, location: string, entryGroup: string,
                    entry: string): Promise<api.ApiResult<Entry>> {
    const name = `${catalogContainer(project, location, entryGroup)}/entries/${entry}`;
    return await this._delete<Entry>(name);
  }

  async createEntryGroup(project: string, location: string, 
                         entryGroupId: string, entryGroup?: EntryGroup): Promise<api.ApiResult<EntryGroup>> {
    const parent = catalogContainer(project, location);
    const resourceName = `${parent}/entryGroups`;

    const params: Record<string, any> = { entryGroupId };

    const res = await this._post<EntryGroup>(resourceName, entryGroup, params);

    return res;
  }

  async createEntryLink(project: string, location: string, entryGroup: string,
                        entryLinkId: string,
                        entryLink: EntryLink): Promise<api.ApiResult<EntryLink>> {
    const parent = catalogContainer(project, location, entryGroup);
    const resourceName = `${parent}/entryLinks`;

    const params: Record<string, any> = { entryLinkId };

    return await this._post<EntryLink>(resourceName, entryLink, params);
  }

  // Patches an existing entry link. UpdateEntryLink has no update mask: the
  // aspects present in the request body are the ones written, narrowed to
  // `aspectKeys` (each `project.location.aspectType`) when given. The entry
  // references and link type are immutable server-side.
  async updateEntryLink(entryLink: EntryLink,
                        aspectKeys?: string[]): Promise<api.ApiResult<EntryLink>> {
    const params: Record<string, any> = {};
    if (aspectKeys && aspectKeys.length) {
      params.aspectKeys = aspectKeys;
    }
    return await this._patch<EntryLink>(entryLink.name!, entryLink, params);
  }

  async deleteEntryLink(project: string, location: string, entryGroup: string,
                        entryLinkId: string): Promise<api.ApiResult<EntryLink>> {
    const name = `${
        catalogContainer(project, location, entryGroup)}/entryLinks/${
        entryLinkId}`;
    return await this._delete<EntryLink>(name);
  }

  // Returns every entry link that references `entry` (its full resource name),
  // draining all pages. There is no list-entry-links collection API; the server
  // only exposes links per referenced entry, via the location-scoped
  // :lookupEntryLinks custom verb (mirroring :lookupEntry). `entryLinkTypes`
  // optionally filters to specific link types (server caps it at 10); `entryMode`
  // filters by the entry's role in the link (SOURCE/TARGET). The server caps a
  // page at 10 links, so this follows nextPageToken until exhausted and returns
  // the flat list. A non-200 on any page aborts and is returned as-is.
  async lookupEntryLinks(
      project: string, location: string,
      opts: {entry: string; entryLinkTypes?: string[];
             entryMode?: 'UNSPECIFIED' | 'SOURCE' | 'TARGET'}):
      Promise<api.ApiResult<EntryLink[]>> {
    const container = `${catalogContainer(project, location)}:lookupEntryLinks`;
    const links: EntryLink[] = [];
    let pageToken: string | undefined = undefined;
    do {
      const params: Record<string, any> = {
        entry: opts.entry,
        entryLinkTypes: opts.entryLinkTypes,
        entryMode: opts.entryMode,
        pageSize: 10,
        pageToken,
      };
      const res = await this._get<EntryLinkList>(container, params);
      if (res.status != 200) {
        return { status: res.status, message: res.message };
      }
      for (const link of res.result?.entryLinks ?? []) {
        links.push(link);
      }
      pageToken = res.result?.nextPageToken;
    } while (pageToken);
    return { status: 200, result: links };
  }

}


// Fix all entries and aspects to consistently use project id. Its currently a mess with an
// inconsistent mix of project ids and unusable project numbers.
async function _fixEntry(entry: Entry, ctx: context.ApiContext): Promise<void> {
  entry.name = await crm.fixProject(entry.name, ctx);
  entry.entryType = await crm.fixProject(entry.entryType, ctx);
  if (entry.entrySource?.resource) {
    entry.entrySource.resource = await crm.fixProject(entry.entrySource.resource, ctx);
  }

  if (entry.aspects) {
    const fixedAspects: Record<string, Aspect> = {};
    for (const [aspectKey, aspectValue] of Object.entries(entry.aspects)) {
      let aspectType = '';
      if (!aspectValue || Object.keys(aspectValue).length) {
        aspectType = _typeRefToName(aspectKey, 'aspect');
      }
      else {
        aspectType = aspectValue['aspectType'] as string;
      }
      aspectType = await crm.fixProject(aspectType, ctx);

      fixedAspects[_nameToTypeRef(aspectType)] = {
        aspectType: aspectType,
        data: aspectValue['data'] ?? {}
      };
    }
    entry.aspects = fixedAspects;
  }
}

// Constructs canonical names for catalog container resources, identified by project, location and
// optionally, depending on use-case, the entry group.
export function catalogContainer(project: string, location: string, entryGroup: string=''): string {
  let container = `projects/${project}/locations/${location}`;
  if (entryGroup) {
    container += `/entryGroups/${entryGroup}`;
  }

  return container;
}

// Converts project.location.type to projects/${project}/locations/${location}/typeTypes/${type}
export function _typeRefToName(ref: string, type: string): string {
  const refParts = ref.split('.');
  if (refParts.length !== 3) {
    throw new Error(`Invalid type reference: ${ref}`);
  }
  return `projects/${refParts[0]}/locations/${refParts[1]}/${type}Types/${refParts[2]}`;
}

// Converts projects/${project}/locations/${location}/typeTypes/${type} -> project.location.type
export function _nameToTypeRef(name: string): string {
  const nameParts = name.split('/');
  if (nameParts.length < 6) {
    throw new Error(`Invalid type name: ${name}`);
  }
  return `${nameParts[1]}.${nameParts[3]}.${nameParts[5]}`;
}
