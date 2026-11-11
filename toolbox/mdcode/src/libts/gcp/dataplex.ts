// API client for Knowledge Catalog (Dataplex)
//

import * as api from './api';
import * as context from './context';
import * as crm from './crm';


export interface EntryGroup {
  name: string;
  type?: string;
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

// A long-running operation. Creating or updating a type is asynchronous: the
// call returns one of these immediately, `done` flips to true at completion,
// and `error` is set when the operation failed.
export interface Operation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string; };
  // BatchChangeMetadata reports per-change failures keyed by the change's
  // 0-based index in the request.
  metadata?: {
    failedRequests?: Record<string, { code?: number; message?: string; }>;
  };
}

// Whether `value`, such as the result of a create, is a long-running
// operation rather than the created resource.
export function isOperation(value: unknown): value is Operation {
  return typeof value === 'object' && value !== null &&
      typeof (value as {name?: unknown}).name === 'string' &&
      (value as {name: string}).name.includes('/operations/');
}

// One element of a BatchChangeMetadata request. Exactly one arm is set.
export interface MetadataChange {
  createEntryRequest?: { parent: string; entryId: string; entry: Entry; };
  updateEntryRequest?: {
    entry: Entry;
    updateMask: string;
    aspectKeys: string[];
    deleteMissingAspects: boolean;
  };
  deleteEntryRequest?: { name: string; };
  createEntryLinkRequest?: {
    parent: string;
    entryLinkId: string;
    entryLink: EntryLink;
  };
  updateEntryLinkRequest?: {
    entryLink: EntryLink;
    allowMissing?: boolean;
    aspectKeys?: string[];
  };
  deleteEntryLinkRequest?: { name: string; };
}

export interface LookupEntryOptions {
  aspects?: string[];
  paths?: string[];
  view?: 'BASIC' | 'CUSTOM' | 'ALL';
}

// Renders a finished operation's failure as a message, or returns undefined
// when it succeeded.
function operationFailure(op: Operation, what: string): string|undefined {
  if (!op.error) return undefined;
  return `${what}: ${op.error.message || `operation failed (${op.error.code})`}`;
}

export interface Aspect {
  aspectType?: string;
  path?: string;
  data?: Record<string, any>;
}

export interface Entry {
  name: string;
  entryType: string;
  parentEntry?: string;
  fullyQualifiedName?: string;
  createTime?: string;
  updateTime?: string;
  entrySource?: {
    resource?: string;
    system?: string;
    platform?: string;
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

  // `fix.keepSourceResource` returns `entrySource.resource` exactly as stored.
  async getEntry(project: string, location: string, entryGroup: string, entry: string,
                 aspects?: string[],
                 fix: FixOptions = {}): Promise<api.ApiResult<Entry>> {
    const name = `${catalogContainer(project, location, entryGroup)}/entries/${entry}`;
    const params: Record<string, any> = { view: 'BASIC' };
    if (aspects && aspects.length) {
      params.view = 'CUSTOM';
      params.aspectTypes = aspects;
    }

    const res = await this._get<Entry>(name, params);
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context, fix);
    }

    return res;
  }

  // With `opts.aspects`, `opts.paths` keeps only the aspects at those paths.
  // The path '' is the entry itself, and `Schema.<field>` is a field. Passing
  // `{view: 'ALL'}` reads every aspect without naming aspect types.
  async lookupEntry(project: string, location: string, name: string,
                    opts: LookupEntryOptions = {}): Promise<api.ApiResult<Entry>> {
    const container = `${catalogContainer(project, location)}:lookupEntry`;
    const params: Record<string, any> = { entry: name, view: opts.view ?? 'BASIC' };
    if (opts.view !== 'ALL' && opts.aspects && opts.aspects.length) {
      params.view = 'CUSTOM';
      params.aspectTypes = opts.aspects;
      params.paths = opts.paths;
    }

    const res = await this._get<Entry>(container, params);
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  // The type of every aspect on an entry, as project.location.type, each
  // once. A FULL read lists every aspect but gives data only to those the
  // entry's type requires, so this reads the keys alone, which lookupEntry
  // would drop.
  async lookupEntryAspectTypes(project: string, location: string,
                               name: string): Promise<api.ApiResult<string[]>> {
    const container = `${catalogContainer(project, location)}:lookupEntry`;
    const res = await this._get<Entry>(container, { entry: name, view: 'FULL' });
    if (res.status != 200 || !res.result) {
      return { status: res.status, message: res.message, body: res.body };
    }
    // Each type is resolved once: crm caches only the projects it can read,
    // so several field-path keys of one unreadable type would each look it up.
    const typeRefs = new Set(Object.keys(res.result.aspects ?? {})
                                 .map(key => key.split('@')[0]));
    const types = new Set<string>();
    for (const typeRef of typeRefs) {
      const { aspectType } = await _aspectTypeOfKey(typeRef, this.context);
      types.add(_nameToTypeRef(aspectType));
    }
    return { status: 200, result: [...types] };
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

  // `deleteMissingAspects` removes each aspect `aspectKeys` names that `entry`
  // does not carry. Without it Dataplex keeps such an aspect. The returned
  // entry leaves out every aspect the update removed.
  async updateEntry(entry: Entry, updateMask?: string[], aspectKeys?: string[],
                    deleteMissingAspects?: boolean):
      Promise<api.ApiResult<Entry>> {
    const params: Record<string, any> = {};
    if (updateMask && updateMask.length) {
      params.updateMask = updateMask.join(',');
    }
    if (aspectKeys && aspectKeys.length) {
      params.aspectKeys = aspectKeys;
    }
    if (deleteMissingAspects) {
      params.deleteMissingAspects = true;
    }

    const res = await this._patch<Entry>(entry.name, entry, params);
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  // `fix.keepSourceResource` returns each `entrySource.resource` exactly as
  // stored.
  async *listEntries(project: string, location: string, entryGroup: string,
                     fix: FixOptions = {}): AsyncGenerator<Entry, void, unknown> {
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
        await _fixEntry(entry, this.context, fix);
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

  // Applies up to 250 entry changes to one entry group in a single call, and
  // returns the LRO to poll. Per-change failures arrive in the operation's
  // metadata rather than as a non-200.
  async batchChangeMetadata(project: string, location: string,
                            entryGroup: string, changes: MetadataChange[]):
      Promise<api.ApiResult<Operation>> {
    const name = catalogContainer(project, location, entryGroup);
    return await this._post<Operation>(`${name}:batchChangeMetadata`,
                                       { name, changes });
  }

  async createEntryGroup(project: string, location: string, 
                         entryGroupId: string, entryGroup?: Omit<EntryGroup, 'name'>): Promise<api.ApiResult<EntryGroup>> {
    const parent = catalogContainer(project, location);
    const resourceName = `${parent}/entryGroups`;

    const params: Record<string, any> = { entryGroupId };

    const res = await this._post<EntryGroup>(resourceName, entryGroup, params);

    return res;
  }

  async updateEntryGroup(project: string, location: string,
                         entryGroupId: string, entryGroup: Partial<EntryGroup>,
                         updateMask?: string[]): Promise<api.ApiResult<Operation>> {
    const name = catalogContainer(project, location, entryGroupId);

    const params: Record<string, any> = {};
    if (updateMask && updateMask.length) {
      params.updateMask = updateMask.join(',');
    }

    return await this._patch<Operation>(name, entryGroup, params);
  }

  // Creates a custom aspect type. `aspectType` carries the display name,
  // description and metadataTemplate; the resource name comes from the id.
  async createAspectType(project: string, location: string, aspectTypeId: string,
                         aspectType: Omit<AspectType, 'name'>): Promise<api.ApiResult<Operation>> {
    const resourceName = `${catalogContainer(project, location)}/aspectTypes`;

    const params: Record<string, any> = { aspectTypeId };

    return await this._post<Operation>(resourceName, aspectType, params);
  }

  // Patches an existing aspect type. Dataplex rejects a backwards-incompatible
  // metadataTemplate change, so an update only ever adds fields.
  async updateAspectType(project: string, location: string, aspectTypeId: string,
                         aspectType: Omit<AspectType, 'name'>,
                         updateMask?: string[]): Promise<api.ApiResult<Operation>> {
    const name = `${catalogContainer(project, location)}/aspectTypes/${aspectTypeId}`;

    const params: Record<string, any> = {};
    if (updateMask && updateMask.length) {
      params.updateMask = updateMask.join(',');
    }

    return await this._patch<Operation>(name, aspectType, params);
  }

  // Creates a custom entry type.
  async createEntryType(project: string, location: string, entryTypeId: string,
                        entryType: Omit<EntryType, 'name'>): Promise<api.ApiResult<Operation>> {
    const resourceName = `${catalogContainer(project, location)}/entryTypes`;

    const params: Record<string, any> = { entryTypeId };

    return await this._post<Operation>(resourceName, entryType, params);
  }

  // Fetches a long-running operation by the resource name the call that started
  // it returned. Disables per-call _get retry so poll loops control backoff.
  async getOperation(operationName: string): Promise<api.ApiResult<Operation>> {
    return await this._get<Operation>(operationName, undefined, { retry: false });
  }

  // Polls a long-running operation until it finishes, returning both the final
  // operation (for callers that inspect `metadata.failedRequests`) and any
  // failure message.
  async pollOperation(op: Operation|undefined, what: string,
                      timeoutMs = 120000):
      Promise<{ operation?: Operation; error?: string; unreadable?: boolean }> {
    if (!op || !op.name) return { operation: op };
    if (op.done) return { operation: op, error: operationFailure(op, what) };

    const deadline = Date.now() + timeoutMs;
    let delayMs = 500;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 5000);

      const polled = await this.getOperation(op.name);
      // A client error will not resolve itself, so report it rather than spend
      // the whole timeout rediscovering it and then blame the timeout. A 5xx or
      // a throttle is worth another attempt.
      if (polled.status >= 400 && polled.status < 500 &&
          polled.status !== 429) {
        return {
          error: `${what}: reading ${op.name}: ${polled.message || polled.status}`,
          unreadable: true,
        };
      }
      if (polled.status !== 200 || !polled.result) continue;
      if (polled.result.done) {
        return {
          operation: polled.result,
          error: operationFailure(polled.result, what)
        };
      }
    }
    return { error: `${what}: timed out after ${timeoutMs}ms waiting for ${op.name}` };
  }

  // Polls a long-running operation until it finishes, and returns a message
  // describing the failure when it fails or does not finish in time. Creating a
  // type is asynchronous, so a caller that skips this races the server: an
  // entry type that names an aspect type the server cannot see yet is rejected
  // with `The following aspect types do not exist`.
  async awaitOperation(op: Operation|undefined, what: string,
                       timeoutMs = 120000): Promise<string|undefined> {
    return (await this.pollOperation(op, what, timeoutMs)).error;
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

  // Reads an entry link by its full resource name.
  async getEntryLink(name: string): Promise<api.ApiResult<EntryLink>> {
    return await this._get<EntryLink>(name);
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
        return { status: res.status, message: res.message, body: res.body };
      }
      for (const link of res.result?.entryLinks ?? []) {
        links.push(link);
      }
      pageToken = res.result?.nextPageToken;
    } while (pageToken);
    return { status: 200, result: links };
  }

}


// How `_fixEntry` treats an entry. `keepSourceResource` leaves
// `entrySource.resource` as stored, so a caller that writes it back changes
// nothing and makes no Resource Manager lookup for it.
export interface FixOptions {
  keepSourceResource?: boolean;
}

// Normalises an entry and its aspects in place so resource names and aspect
// keys consistently use project IDs (rather than project numbers), while
// preserving `@<path>` suffixes and `path` fields on field-level aspects.
// Drops an aspect whose value is null or has no fields. An update's response
// lists each aspect it removed with an empty value.
export async function _fixEntry(entry: Entry, ctx: context.ApiContext,
                                fix: FixOptions = {}): Promise<void> {
  entry.name = await crm.fixProject(entry.name, ctx);
  entry.entryType = await crm.fixProject(entry.entryType, ctx);
  if (entry.entrySource?.resource && !fix.keepSourceResource) {
    entry.entrySource.resource = await crm.fixProject(entry.entrySource.resource, ctx);
  }

  if (entry.aspects) {
    const fixedAspects: Record<string, Aspect> = {};
    for (const [aspectKey, aspectValue] of Object.entries(entry.aspects)) {
      if (!aspectValue || !Object.keys(aspectValue).length) continue;
      const { aspectType, keyPath } = await _aspectTypeOfKey(aspectKey, ctx);

      const path = aspectValue.path || keyPath;
      const baseKey = _nameToTypeRef(aspectType);
      const fixedKey = path ? `${baseKey}@${path}` : baseKey;

      fixedAspects[fixedKey] = {
        aspectType: aspectType,
        ...(path ? { path } : {}),
        data: aspectValue.data ?? {}
      };
    }
    entry.aspects = fixedAspects;
  }
}

// The aspect type an aspect key names, as a resource name with a project ID,
// and the key's `@<path>` part, if any.
async function _aspectTypeOfKey(key: string, ctx: context.ApiContext):
    Promise<{ aspectType: string; keyPath?: string }> {
  const atIdx = key.indexOf('@');
  const typeRef = atIdx === -1 ? key : key.slice(0, atIdx);
  return {
    aspectType: await crm.fixProject(_typeRefToName(typeRef, 'aspect'), ctx),
    keyPath: atIdx === -1 ? undefined : key.slice(atIdx + 1),
  };
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


// What an entry-group create did: whether it created the group, the group
// that already existed when it was read back, and why it failed.
export interface EntryGroupCreation {
  created: boolean;
  existing?: EntryGroup;
  error?: string;
}

// How long an entry-group create is waited for.
const ENTRY_GROUP_CREATE_TIMEOUT_MS = 120000;


// Creates entry group `entryGroup` with `body` (undefined for a plain group)
// and waits for the create to finish: the operation can fail after the
// request is accepted. Errors start with `label`. An entry group that already
// exists (409) is success, with `created` false, and is left as it is. So is
// a create refused (403) for a group the caller can read, since a caller
// without create permission may be refused the create of one that exists;
// that group is returned.
//
// A caller may create a group but not read the create's operation (it lacks
// `dataplex.operations.get`, as `roles/dataplex.contentCreator` and
// `roles/datacatalog.entryGroupCreator` do). Then the wait reads the group
// instead, within the same time, until it exists and has `body`'s type: a
// group reads back without its type until the create finishes.
export async function createEntryGroupAndWait(
    catalog: CatalogClient, project: string, location: string,
    entryGroup: string, body?: Omit<EntryGroup, 'name'>,
    label = `creating entry group '${project}.${location}.${entryGroup}'`,
    timeoutMs = ENTRY_GROUP_CREATE_TIMEOUT_MS): Promise<EntryGroupCreation> {
  const deadline = Date.now() + timeoutMs;
  const failed = (why: unknown) => ({created: false, error: `${label}: ${why}`});
  const res =
      await catalog.createEntryGroup(project, location, entryGroup, body);
  if (res.status === 409) return {created: false};
  if (res.status === 403) {
    const found = await catalog.getEntryGroup(project, location, entryGroup);
    if (found.status === 200) return {created: false, existing: found.result};
  }
  if (res.status !== 200) return failed(res.message || res.status);
  if (!isOperation(res.result)) return {created: true};
  const polled = await catalog.pollOperation(res.result, label, timeoutMs);
  if (!polled.unreadable) {
    return polled.error ? {created: false, error: polled.error} :
                          {created: true};
  }
  // The operation cannot be read: wait for the group itself.
  let delayMs = 500;
  while (Date.now() < deadline) {
    const found = await catalog.getEntryGroup(project, location, entryGroup);
    if (found.status === 200 &&
        (body?.type === undefined || found.result?.type === body.type)) {
      return {created: true};
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 5000);
  }
  return {
    created: false,
    error: `${polled.error}; the entry group was not ready within ${
        timeoutMs}ms either`,
  };
}


// The entry-group type of a context set.
export const CONTEXT_SET_TYPE = 'context-set';


// Creates entry group `entryGroup` as a context set (type `context-set`),
// with `metadata`'s display name and description, and waits for the create
// to finish. An existing context set is success, with `created` false, and
// is left as it is. An existing group of another type is an error: a group's
// type cannot be changed, so it can never become a context set.
export async function createContextSet(
    catalog: CatalogClient, project: string, location: string,
    entryGroup: string,
    metadata: {displayName?: string; description?: string} = {},
    timeoutMs = ENTRY_GROUP_CREATE_TIMEOUT_MS): Promise<EntryGroupCreation> {
  const name = `${project}.${location}.${entryGroup}`;
  const result = await createEntryGroupAndWait(
      catalog, project, location, entryGroup,
      {type: CONTEXT_SET_TYPE, ...metadata},
      `creating context set '${name}'`,
      timeoutMs);
  if (result.error || result.created) return result;
  let existing = result.existing;
  if (!existing) {
    const found = await catalog.getEntryGroup(project, location, entryGroup);
    if (found.status !== 200) {
      return {
        created: false,
        error: `reading entry group '${name}': ${
            found.message || found.status}`,
      };
    }
    existing = found.result;
  }
  if (existing?.type !== CONTEXT_SET_TYPE) {
    return {
      created: false,
      existing,
      error: `entry group '${name}' exists but is not a context set, and an ` +
          `entry group's type cannot be changed; use a new context set ID.`,
    };
  }
  return {created: false, existing};
}
