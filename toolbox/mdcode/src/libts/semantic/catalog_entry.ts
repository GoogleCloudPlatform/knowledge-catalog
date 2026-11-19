// Reading a table's Knowledge Catalog entry, which the dialect lookup and the
// source check share, so both read an entry, and the answer, the same way.

import type {ApiResult} from '../gcp/api';
import {catalogContainer, LookupEntryOptions} from '../gcp/dataplex';
import {sentence} from './parameters';

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

// A read the service answered with 403 or 404: the status and the service's
// message.
export interface Refusal {
  unreadable: true;
  status: 403|404;
  message?: string;
}

// What a read gave: its result; a Refusal; or the message for any other
// failure, with the status when the service answered one other than 200.
export type Read<T> = {result: T}|Refusal|{error: string; status?: number};

// Makes the call `call`, which `what` names in a message. Never throws. The
// message of a failed call is on one line (see oneLine).
export async function read<T>(
    what: string, call: () => Promise<ApiResult<T>>): Promise<Read<T>> {
  let res: ApiResult<T>;
  try {
    res = await call();
  } catch (err: any) {
    return {error: oneLine(`${what} failed: ${err?.message ?? err}`)};
  }
  // Dataplex answers 403 both when an entry does not exist and when the caller
  // may not read it; the admin APIs answer 404 for a missing resource.
  if (res.status === 403 || res.status === 404) {
    return {unreadable: true, status: res.status, message: res.message};
  }
  if (res.status !== 200 || !res.result) {
    return {
      error: oneLine(`${what} failed (HTTP ${res.status}${
          res.message ? `: ${res.message}` : ''}).`),
      ...(res.status !== 200 && {status: res.status}),
    };
  }
  return {result: res.result};
}

// Dataplex's generic denial, which it gives both for an entry that does not
// exist and for one the caller may not read.
const GENERIC_DENIAL =
    /^Permission denied on resource `[^`]*` \(or it may not exist\)\.?$/;

// What Dataplex said in the refusal `refused`, as a sentence to add after
// kcmd's own. The sentence is `Dataplex said:` and the refusal's message, on
// one line. Gives '' when the refusal has no message. Also gives '' for
// Dataplex's generic denial, "Permission denied on resource `<name>` (or it
// may not exist).", which says only that the entry may not exist or may not
// be readable.
export function dataplexSaid(refused: Refusal): string {
  const said = oneLine(refused.message ?? '');
  return said && !GENERIC_DENIAL.test(said) ?
      ` Dataplex said: ${sentence(said)}` :
      '';
}

// `text` with each run of whitespace made one space. A service's message can
// span lines, and each message kcmd prints is one line.
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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
      () => catalog.lookupEntry(project, location, name, aspects && {aspects}));
}
