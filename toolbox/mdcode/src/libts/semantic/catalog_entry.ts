// Reading a table's Knowledge Catalog entry, which the dialect lookup and the
// source check share, so both read an entry, and the answer, the same way.

import type {ApiResult} from '../gcp/api';
import {catalogContainer, LookupEntryOptions} from '../gcp/dataplex';

// What an entry read gives: the entry's type, names and source, and the data
// of each aspect the read asked for, keyed by aspect key.
export interface EntryRead {
  entryType?: string;
  fullyQualifiedName?: string;
  entrySource?: {system?: string};
  aspects?: Record<string, {data?: Record<string, any>}>;
}

// The one catalog call an entry read makes; `CatalogClient` provides it.
export interface EntryLookup {
  lookupEntry(
      project: string, location: string, name: string,
      opts?: LookupEntryOptions): Promise<ApiResult<EntryRead>>;
}

// What a read gave: its result; `unreadable`, with the status and the
// service's message, when the service answered 403 or 404; or the message for
// any other failure, with the status when the service answered one other
// than 200.
export type Read<T> = {result: T}|
    {unreadable: true; status: 403|404; message?: string}|
    {error: string; status?: number};

// Makes the call `call`, which `what` names in a message. Never throws.
export async function read<T>(
    what: string, call: () => Promise<ApiResult<T>>): Promise<Read<T>> {
  let res: ApiResult<T>;
  try {
    res = await call();
  } catch (err: any) {
    return {error: `${what} failed: ${err?.message ?? err}`};
  }
  // Dataplex answers 403 both when an entry does not exist and when the caller
  // may not read it; the admin APIs answer 404 for a missing resource.
  if (res.status === 403 || res.status === 404) {
    return {unreadable: true, status: res.status, message: res.message};
  }
  if (res.status !== 200 || !res.result) {
    return {
      error: `${what} failed (HTTP ${res.status}${
          res.message ? `: ${res.message}` : ''}).`,
      ...(res.status !== 200 && {status: res.status}),
    };
  }
  return {result: res.result};
}

// Looks up the catalog entry of the resource whose name is `resourceName`, in
// the entry group `@<system>` at `location`, with the aspects of the aspect
// types `aspects`. `what` names the lookup in a message.
export function lookupSystemEntry(
    catalog: EntryLookup, system: string, project: string, location: string,
    resourceName: string, what = 'looking up its Knowledge Catalog entry',
    aspects?: string[]): Promise<Read<EntryRead>> {
  const name = `${catalogContainer(project, location, `@${system}`)}/entries/${
      resourceName}`;
  return read(
      what,
      () => aspects ? catalog.lookupEntry(project, location, name, {aspects}) :
                      catalog.lookupEntry(project, location, name));
}
