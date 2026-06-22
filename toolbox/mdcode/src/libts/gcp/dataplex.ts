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
  name: string;
  type: string;
  path?: string;
}

export interface EntryLink {
  name: string;
  entryLinkType: string;
  entryReferences: EntryReference[];
  aspects?: Record<string, Aspect>;
}

export interface LookupEntryLinksResponse {
  entryLinks: EntryLink[];
  nextPageToken?: string;
}

interface EntryList {
  entries: Entry[];
  nextPageToken?: string;
}


export class CatalogClient extends api.ApiClient {

  constructor(ctx: context.ApiContext) {
    super('https://dataplex.googleapis.com', 'v1', ctx);
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

  async getGlossary(project: string, location: string, glossaryId: string): Promise<api.ApiResult<any>> {
    const name = `projects/${project}/locations/${location}/glossaries/${glossaryId}`;
    return await this._get(name);
  }

  async getGlossaryTerm(project: string, location: string, glossaryId: string, termId: string): Promise<api.ApiResult<any>> {
    const name = `projects/${project}/locations/${location}/glossaries/${glossaryId}/terms/${termId}`;
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

  async lookupEntryLinks(
    project: string,
    location: string,
    entryName: string,
    entryLinkTypes?: string[]
  ): Promise<api.ApiResult<LookupEntryLinksResponse>> {
    const container = `${catalogContainer(project, location)}:lookupEntryLinks`;
    const entryLinks: EntryLink[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const params: Record<string, any> = {
        entry: entryName,
        pageSize: 1000,
      };
      if (entryLinkTypes && entryLinkTypes.length) {
        params.entryLinkTypes = entryLinkTypes;
      }
      if (pageToken) {
        params.pageToken = pageToken;
      }
      const res = await this._get<LookupEntryLinksResponse>(container, params);
      if (res.status !== 200) {
        return res;
      }
      if (res.result?.entryLinks) {
        for (const link of res.result.entryLinks) {
          await _fixEntryLink(link, this.context);
          entryLinks.push(link);
        }
      }
      pageToken = res.result?.nextPageToken;
    } while (pageToken);

    return {
      status: 200,
      result: {
        entryLinks,
      },
    };
  }

  async createEntryLink(
    project: string,
    location: string,
    entryGroup: string,
    entryLink: EntryLink
  ): Promise<api.ApiResult<EntryLink>> {
    const parent = catalogContainer(project, location, entryGroup);
    const container = `${parent}/entryLinks`;

    const sortedRefs = [...entryLink.entryReferences].sort((a, b) => a.name.localeCompare(b.name));
    const source = sortedRefs[0]?.name || '';
    const target = sortedRefs[1]?.name || '';
    const type = entryLink.entryLinkType.split('/').pop() || '';
    const sourcePath = sortedRefs[0]?.path || '';
    const targetPath = sortedRefs[1]?.path || '';

    const hashInput = `${source}|${target}|${type}|${sourcePath}|${targetPath}`;
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
      hash = (hash << 5) - hash + hashInput.charCodeAt(i);
      hash |= 0;
    }
    const entryLinkId = `link-${Math.abs(hash).toString(36)}`;
    const params = { entryLinkId };

    return await this._post<EntryLink>(container, entryLink, params);
  }

  async deleteEntryLink(
    project: string,
    location: string,
    entryGroup: string,
    entryLinkName: string
  ): Promise<api.ApiResult<any>> {
    const parent = catalogContainer(project, location, entryGroup);
    const name = `${parent}/entryLinks/${entryLinkName}`;
    return await this._delete<any>(name);
  }

  async *listEntryLinks(
    project: string,
    location: string,
    entryGroup: string,
    filter?: string
  ): AsyncGenerator<EntryLink, void, unknown> {
    const parent = catalogContainer(project, location, entryGroup);
    const resourceName = `${parent}/entryLinks`;

    let pageToken: string | undefined = undefined;
    do {
      const params: Record<string, string | number> = { pageSize: 1000 };
      if (filter) {
        params.filter = filter;
      }
      if (pageToken) {
        params.pageToken = pageToken;
      }

      const res = await this._get<{ entryLinks: EntryLink[]; nextPageToken?: string }>(
        resourceName,
        params
      );
      if (res.status !== 200) {
        throw new Error(`Failed to list entry links: ${res.message || res.status}`);
      }

      const links = res.result?.entryLinks || [];
      for (const link of links) {
        await _fixEntryLink(link, this.context);
        yield link;
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

  async createEntryGroup(project: string, location: string, 
                         entryGroupId: string, entryGroup?: EntryGroup): Promise<api.ApiResult<EntryGroup>> {
    const parent = catalogContainer(project, location);
    const resourceName = `${parent}/entryGroups`;

    const params: Record<string, any> = { entryGroupId };

    const res = await this._post<EntryGroup>(resourceName, entryGroup, params);

    return res;
  }

  async fixEntry(entry: Entry): Promise<void> {
    await _fixEntry(entry, this.context);
  }

  async fixEntryLink(link: EntryLink): Promise<void> {
    await _fixEntryLink(link, this.context);
  }

}

async function _fixEntryLink(link: EntryLink, ctx: context.ApiContext): Promise<void> {
  link.name = await crm.fixProject(link.name, ctx);
  link.entryLinkType = await crm.fixProject(link.entryLinkType, ctx);
  if (link.entryReferences) {
    for (const ref of link.entryReferences) {
      ref.name = await crm.fixProject(ref.name, ctx);
    }
  }
  if (link.aspects) {
    const fixedAspects: Record<string, Aspect> = {};
    for (const [aspectKey, aspectValue] of Object.entries(link.aspects)) {
      let aspectType = aspectValue.aspectType || _typeRefToName(aspectKey, 'aspect');
      aspectType = await crm.fixProject(aspectType, ctx);
      fixedAspects[_nameToTypeRef(aspectType)] = {
        aspectType,
        data: aspectValue.data ?? {}
      };
    }
    link.aspects = fixedAspects;
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
