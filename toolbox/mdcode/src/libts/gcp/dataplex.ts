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
  requiredAspects: {type: string}[];
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

export interface Glossary {
  name: string;
  displayName?: string;
  description?: string;
  labels?: Record<string, string>;
  createTime?: string;
  updateTime?: string;
}

export interface GlossaryTerm {
  name: string;
  displayName?: string;
  description?: string;
  labels?: Record<string, string>;
  parent: string;
  createTime?: string;
  updateTime?: string;
}

export interface GlossaryCategory {
  name: string;
  displayName?: string;
  description?: string;
  labels?: Record<string, string>;
  parent: string;
  createTime?: string;
  updateTime?: string;
}

interface EntryList {
  entries: Entry[];
  nextPageToken?: string;
}

interface GlossaryList {
  glossaries: Glossary[];
  nextPageToken?: string;
}

interface GlossaryTermList {
  terms: GlossaryTerm[];
  nextPageToken?: string;
}

interface GlossaryCategoryList {
  categories: GlossaryCategory[];
  nextPageToken?: string;
}

export class CatalogClient extends api.ApiClient {
  constructor(ctx: context.ApiContext) {
    super('https://dataplex.googleapis.com', 'v1', ctx);
  }

  async getEntryGroup(
    project: string,
    location: string,
    entryGroup: string,
  ): Promise<api.ApiResult<EntryGroup>> {
    const name = catalogContainer(project, location, entryGroup);
    return await this._get(name);
  }

  async getEntryType(
    project: string,
    location: string,
    type: string,
  ): Promise<api.ApiResult<EntryType>> {
    const name = `${catalogContainer(project, location)}/entryTypes/${type}`;
    return await this._get(name);
  }

  async getAspectType(
    project: string,
    location: string,
    type: string,
  ): Promise<api.ApiResult<AspectType>> {
    const name = `${catalogContainer(project, location)}/aspectTypes/${type}`;
    return await this._get(name);
  }

  async getEntry(
    project: string,
    location: string,
    entryGroup: string,
    entry: string,
    aspects?: string[],
  ): Promise<api.ApiResult<Entry>> {
    const name = `${catalogContainer(project, location, entryGroup)}/entries/${entry}`;
    const params: Record<string, any> = {view: 'BASIC'};
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

  async lookupEntry(
    project: string,
    location: string,
    name: string,
    aspects?: string[],
  ): Promise<api.ApiResult<Entry>> {
    const container = `${catalogContainer(project, location)}:lookupEntry`;
    const params: Record<string, any> = {entry: name, view: 'BASIC'};
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

  async modifyEntry(
    project: string,
    location: string,
    entry: Entry,
    updateMask?: string[],
    aspectKeys?: string[],
  ): Promise<api.ApiResult<Entry>> {
    const container = `${catalogContainer(project, location)}:modifyEntry`;
    const body: Record<string, any> = {
      entry: entry,
      updateMask: updateMask ? updateMask.join(',') : undefined,
      aspectKeys: aspectKeys ?? undefined,
    };

    const res = await this._post<Entry>(container, body);
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  async updateEntry(
    entry: Entry,
    updateMask?: string[],
    aspectKeys?: string[],
  ): Promise<api.ApiResult<Entry>> {
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

  async *listEntries(
    project: string,
    location: string,
    entryGroup: string,
  ): AsyncGenerator<Entry, void, unknown> {
    const parent = catalogContainer(project, location, entryGroup);
    const resourceName = `${parent}/entries`;

    let pageToken: string | undefined = undefined;
    do {
      const params: Record<string, string | number> = {pageSize: 1000};
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
    entryLinkTypes?: string[],
  ): Promise<api.ApiResult<LookupEntryLinksResponse>> {
    const container = `${catalogContainer(project, location)}:lookupEntryLinks`;
    const params: Record<string, any> = {
      entry: entryName,
    };
    if (entryLinkTypes && entryLinkTypes.length) {
      // Send as a REPEATED query param (`?entryLinkTypes=A&entryLinkTypes=B`).
      // `api._get` expands arrays into repeated params; a comma-joined string
      // gets parsed by the server as one resource name and fails with
      // INVALID_ARGUMENT once there are 2+ types in the list.
      params.entryLinkTypes = entryLinkTypes;
    }
    const res = await this._get<LookupEntryLinksResponse>(container, params);
    if (res.status === 200 && res.result?.entryLinks) {
      for (const link of res.result.entryLinks) {
        await _fixEntryLink(link, this.context);
      }
    }
    return res;
  }

  async createEntryLink(
    project: string,
    location: string,
    entryGroup: string,
    entryLinkId: string,
    entryLink: EntryLink,
  ): Promise<api.ApiResult<EntryLink>> {
    const parent = catalogContainer(project, location, entryGroup);
    const container = `${parent}/entryLinks`;
    const params: Record<string, any> = {entryLinkId};
    const res = await this._post<EntryLink>(container, entryLink, params);
    if (res.status === 200 && res.result) {
      await _fixEntryLink(res.result, this.context);
    }
    return res;
  }

  async deleteEntryLink(
    project: string,
    location: string,
    entryGroup: string,
    entryLinkId: string,
  ): Promise<api.ApiResult<{}>> {
    const parent = catalogContainer(project, location, entryGroup);
    const name = `${parent}/entryLinks/${entryLinkId}`;
    return await this._delete<{}>(name);
  }

  async *listEntryLinks(
    project: string,
    location: string,
    entryGroup: string,
    filter?: string,
  ): AsyncGenerator<EntryLink, void, unknown> {
    const parent = catalogContainer(project, location, entryGroup);
    const resourceName = `${parent}/entryLinks`;

    let pageToken: string | undefined = undefined;
    do {
      const params: Record<string, string | number> = {pageSize: 1000};
      if (filter) {
        params.filter = filter;
      }
      if (pageToken) {
        params.pageToken = pageToken;
      }

      const res = await this._get<{
        entryLinks: EntryLink[];
        nextPageToken?: string;
      }>(resourceName, params);
      if (res.status !== 200) {
        throw new Error(
          `Failed to list entry links: ${res.message || res.status}`,
        );
      }

      const links = res.result?.entryLinks || [];
      for (const link of links) {
        await _fixEntryLink(link, this.context);
        yield link;
      }

      pageToken = res.result?.nextPageToken;
    } while (pageToken);
  }

  async createEntry(
    project: string,
    location: string,
    entryGroup: string,
    entryId: string,
    entry?: Entry,
  ): Promise<api.ApiResult<Entry>> {
    const parent = catalogContainer(project, location, entryGroup);
    const resourceName = `${parent}/entries`;

    const params: Record<string, any> = {entryId};

    const res = await this._post<Entry>(resourceName, entry, params);

    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  async createEntryGroup(
    project: string,
    location: string,
    entryGroupId: string,
    entryGroup?: EntryGroup,
  ): Promise<api.ApiResult<EntryGroup>> {
    const parent = catalogContainer(project, location);
    const resourceName = `${parent}/entryGroups`;

    const params: Record<string, any> = {entryGroupId};

    const res = await this._post<EntryGroup>(resourceName, entryGroup, params);

    return res;
  }

  async getGlossary(
    project: string,
    location: string,
    glossary: string,
  ): Promise<api.ApiResult<Glossary>> {
    const name = `${catalogContainer(project, location)}/glossaries/${glossary}`;
    const res = await this._get<Glossary>(name);
    if (res.status == 200 && res.result) {
      await _fixGlossary(res.result, this.context);
    }
    return res;
  }

  async *listGlossaries(
    project: string,
    location: string,
  ): AsyncGenerator<Glossary, void, unknown> {
    const parent = catalogContainer(project, location);
    const resourceName = `${parent}/glossaries`;

    let pageToken: string | undefined = undefined;
    do {
      const params: Record<string, string | number> = {pageSize: 1000};
      if (pageToken) {
        params.pageToken = pageToken;
      }

      const res = await this._get<GlossaryList>(resourceName, params);
      if (res.status !== 200) {
        throw new Error(
          `Failed to list glossaries: ${res.message || res.status}`,
        );
      }

      const glossaries = res.result?.glossaries || [];
      for (const glossary of glossaries) {
        await _fixGlossary(glossary, this.context);
        yield glossary;
      }

      pageToken = res.result?.nextPageToken;
    } while (pageToken);
  }

  async createGlossary(
    project: string,
    location: string,
    glossaryId: string,
    glossary?: Glossary,
  ): Promise<api.ApiResult<Glossary>> {
    const parent = catalogContainer(project, location);
    const resourceName = `${parent}/glossaries`;
    const params: Record<string, any> = {glossaryId};
    const res = await this._post<Glossary>(resourceName, glossary, params);
    if (res.status == 200 && res.result) {
      await _fixGlossary(res.result, this.context);
    }
    return res;
  }

  async updateGlossary(
    glossary: Glossary,
    updateMask?: string[],
  ): Promise<api.ApiResult<Glossary>> {
    const params: Record<string, any> = {};
    if (updateMask && updateMask.length) {
      params.updateMask = updateMask.join(',');
    }
    const res = await this._patch<Glossary>(glossary.name, glossary, params);
    if (res.status == 200 && res.result) {
      await _fixGlossary(res.result, this.context);
    }
    return res;
  }

  async deleteGlossary(
    project: string,
    location: string,
    glossary: string,
  ): Promise<api.ApiResult<void>> {
    const name = `${catalogContainer(project, location)}/glossaries/${glossary}`;
    return await this._delete(name);
  }

  async getGlossaryTerm(
    project: string,
    location: string,
    glossary: string,
    term: string,
  ): Promise<api.ApiResult<GlossaryTerm>> {
    const name = `${catalogContainer(project, location)}/glossaries/${glossary}/terms/${term}`;
    const res = await this._get<GlossaryTerm>(name);
    if (res.status == 200 && res.result) {
      await _fixGlossaryTerm(res.result, this.context);
    }
    return res;
  }

  async *listGlossaryTerms(
    project: string,
    location: string,
    glossary: string,
  ): AsyncGenerator<GlossaryTerm, void, unknown> {
    const parent = `${catalogContainer(project, location)}/glossaries/${glossary}`;
    const resourceName = `${parent}/terms`;

    let pageToken: string | undefined = undefined;
    do {
      const params: Record<string, string | number> = {pageSize: 1000};
      if (pageToken) {
        params.pageToken = pageToken;
      }

      const res = await this._get<GlossaryTermList>(resourceName, params);
      if (res.status !== 200) {
        throw new Error(
          `Failed to list glossary terms: ${res.message || res.status}`,
        );
      }

      const terms = res.result?.terms || [];
      for (const term of terms) {
        await _fixGlossaryTerm(term, this.context);
        yield term;
      }

      pageToken = res.result?.nextPageToken;
    } while (pageToken);
  }

  async createGlossaryTerm(
    project: string,
    location: string,
    glossary: string,
    termId: string,
    term?: GlossaryTerm,
  ): Promise<api.ApiResult<GlossaryTerm>> {
    const parent = `${catalogContainer(project, location)}/glossaries/${glossary}`;
    const resourceName = `${parent}/terms`;
    const params: Record<string, any> = {termId};
    const res = await this._post<GlossaryTerm>(resourceName, term, params);
    if (res.status == 200 && res.result) {
      await _fixGlossaryTerm(res.result, this.context);
    }
    return res;
  }

  async updateGlossaryTerm(
    term: GlossaryTerm,
    updateMask?: string[],
  ): Promise<api.ApiResult<GlossaryTerm>> {
    const params: Record<string, any> = {};
    if (updateMask && updateMask.length) {
      params.updateMask = updateMask.join(',');
    }
    const res = await this._patch<GlossaryTerm>(term.name, term, params);
    if (res.status == 200 && res.result) {
      await _fixGlossaryTerm(res.result, this.context);
    }
    return res;
  }

  async deleteGlossaryTerm(
    project: string,
    location: string,
    glossary: string,
    term: string,
  ): Promise<api.ApiResult<void>> {
    const name = `${catalogContainer(project, location)}/glossaries/${glossary}/terms/${term}`;
    return await this._delete(name);
  }

  async getGlossaryCategory(
    project: string,
    location: string,
    glossary: string,
    category: string,
  ): Promise<api.ApiResult<GlossaryCategory>> {
    const name = `${catalogContainer(project, location)}/glossaries/${glossary}/categories/${category}`;
    const res = await this._get<GlossaryCategory>(name);
    if (res.status == 200 && res.result) {
      await _fixGlossaryCategory(res.result, this.context);
    }
    return res;
  }

  async *listGlossaryCategories(
    project: string,
    location: string,
    glossary: string,
  ): AsyncGenerator<GlossaryCategory, void, unknown> {
    const parent = `${catalogContainer(project, location)}/glossaries/${glossary}`;
    const resourceName = `${parent}/categories`;

    let pageToken: string | undefined = undefined;
    do {
      const params: Record<string, string | number> = {pageSize: 1000};
      if (pageToken) {
        params.pageToken = pageToken;
      }

      const res = await this._get<GlossaryCategoryList>(resourceName, params);
      if (res.status !== 200) {
        throw new Error(
          `Failed to list glossary categories: ${res.message || res.status}`,
        );
      }

      const categories = res.result?.categories || [];
      for (const category of categories) {
        await _fixGlossaryCategory(category, this.context);
        yield category;
      }

      pageToken = res.result?.nextPageToken;
    } while (pageToken);
  }

  async createGlossaryCategory(
    project: string,
    location: string,
    glossary: string,
    categoryId: string,
    category?: GlossaryCategory,
  ): Promise<api.ApiResult<GlossaryCategory>> {
    const parent = `${catalogContainer(project, location)}/glossaries/${glossary}`;
    const resourceName = `${parent}/categories`;
    const params: Record<string, any> = {categoryId};
    const res = await this._post<GlossaryCategory>(
      resourceName,
      category,
      params,
    );
    if (res.status == 200 && res.result) {
      await _fixGlossaryCategory(res.result, this.context);
    }
    return res;
  }

  async updateGlossaryCategory(
    category: GlossaryCategory,
    updateMask?: string[],
  ): Promise<api.ApiResult<GlossaryCategory>> {
    const params: Record<string, any> = {};
    if (updateMask && updateMask.length) {
      params.updateMask = updateMask.join(',');
    }
    const res = await this._patch<GlossaryCategory>(
      category.name,
      category,
      params,
    );
    if (res.status == 200 && res.result) {
      await _fixGlossaryCategory(res.result, this.context);
    }
    return res;
  }

  async deleteGlossaryCategory(
    project: string,
    location: string,
    glossary: string,
    category: string,
  ): Promise<api.ApiResult<void>> {
    const name = `${catalogContainer(project, location)}/glossaries/${glossary}/categories/${category}`;
    return await this._delete(name);
  }
}

// Fix all entries and aspects to consistently use project id. Its currently a mess with an
// inconsistent mix of project ids and unusable project numbers.
async function _fixEntry(entry: Entry, ctx: context.ApiContext): Promise<void> {
  entry.name = await crm.fixProject(entry.name, ctx);
  entry.entryType = await crm.fixProject(entry.entryType, ctx);
  if (entry.entrySource?.resource) {
    entry.entrySource.resource = await crm.fixProject(
      entry.entrySource.resource,
      ctx,
    );
  }

  if (entry.aspects) {
    const fixedAspects: Record<string, Aspect> = {};
    for (const [aspectKey, aspectValue] of Object.entries(entry.aspects)) {
      let aspectType = '';
      if (!aspectValue || Object.keys(aspectValue).length) {
        aspectType = _typeRefToName(aspectKey, 'aspect');
      } else {
        aspectType = aspectValue['aspectType'] as string;
      }
      aspectType = await crm.fixProject(aspectType, ctx);

      fixedAspects[_nameToTypeRef(aspectType)] = {
        aspectType: aspectType,
        data: aspectValue['data'] ?? {},
      };
    }
    entry.aspects = fixedAspects;
  }
}

async function _fixGlossary(
  glossary: Glossary,
  ctx: context.ApiContext,
): Promise<void> {
  glossary.name = await crm.fixProject(glossary.name, ctx);
}

async function _fixGlossaryTerm(
  term: GlossaryTerm,
  ctx: context.ApiContext,
): Promise<void> {
  term.name = await crm.fixProject(term.name, ctx);
  term.parent = await crm.fixProject(term.parent, ctx);
}

async function _fixGlossaryCategory(
  category: GlossaryCategory,
  ctx: context.ApiContext,
): Promise<void> {
  category.name = await crm.fixProject(category.name, ctx);
  category.parent = await crm.fixProject(category.parent, ctx);
}

// Constructs canonical names for catalog container resources, identified by project, location and
// optionally, depending on use-case, the entry group.
export function catalogContainer(
  project: string,
  location: string,
  entryGroup: string = '',
): string {
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

export function wrapAsProxyEntry(resourceName: string): string {
  if (!resourceName.startsWith('projects/')) {
    return resourceName;
  }
  if (resourceName.includes('/entryGroups/')) {
    return resourceName;
  }
  const parts = resourceName.split('/');
  if (parts.length >= 4 && parts[2] === 'locations') {
    const project = parts[1];
    const location = parts[3];
    return `projects/${project}/locations/${location}/entryGroups/@dataplex/entries/${resourceName}`;
  }
  return resourceName;
}

export function unwrapProxyEntry(entryName: string): string {
  const match = entryName.match(
    /\/entryGroups\/@dataplex\/entries\/(projects\/.+)$/,
  );
  if (match) {
    return match[1];
  }
  return entryName;
}

export async function _fixEntryLink(
  link: EntryLink,
  ctx: context.ApiContext,
): Promise<void> {
  link.name = await crm.fixProject(link.name, ctx);
  link.entryLinkType = await crm.fixProject(link.entryLinkType, ctx);
  if (link.entryReferences) {
    for (const ref of link.entryReferences) {
      ref.name = await crm.fixProject(ref.name, ctx);
    }
  }
}
