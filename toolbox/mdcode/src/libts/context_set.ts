// The context set's display name and description, kept in catalog.yaml.
//
// A context set is a Knowledge Catalog entry group. Its display name and
// description are properties of the entry group itself, not of any entry, so
// no layout's entry files hold them. Every workspace has a catalog.yaml naming
// the entry group, so they live there as two optional top-level keys:
//
//   scope: semantic-model.my-project.us.sales
//   displayName: Sales
//   description: Orders, customers and revenue for the sales team.
//
// `kcmd pull` sets both from the entry group, keeping every other key and
// comment in the file. `kcmd push` writes whichever key differs from the entry
// group back to it. A key that is absent is not managed: push leaves that
// property alone. Every scope backed by an entry group takes the keys, in
// every layout; a BigQuery dataset scope has no entry group and refuses them.

import * as fs from 'node:fs';
import * as yaml from 'yaml';

import * as api from './gcp/api';
import * as dataplex from './gcp/dataplex';
import {CatalogSource, ENTRY_GROUP_SCOPES, entryGroupCoordinates, EntryGroupCoordinates} from './source';

// The limits Knowledge Catalog puts on an entry group's description and
// display name.
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_DISPLAY_NAME_LENGTH = 500;

// The catalog.yaml keys, which are also the entry group's field names.
export const METADATA_KEYS = ['displayName', 'description'] as const;
export type MetadataKey = (typeof METADATA_KEYS)[number];

export type ContextSetMetadata = Partial<Record<MetadataKey, string>>;

// The labels messages use for each key.
const LABELS: Record<MetadataKey, string> = {
  displayName: 'display name',
  description: 'description',
};

const LIMITS: Record<MetadataKey, number> = {
  displayName: MAX_DISPLAY_NAME_LENGTH,
  description: MAX_DESCRIPTION_LENGTH,
};


// The entry group a context set scope names.
export type EntryGroupRef =
    Pick<EntryGroupCoordinates, 'project'|'location'|'entryGroup'>;


// The entry group `source` is backed by, or undefined for a scope that has
// none (a BigQuery dataset).
export function contextSetOf(source: CatalogSource): EntryGroupRef|undefined {
  return ENTRY_GROUP_SCOPES.includes(source.type) ?
      entryGroupCoordinates(source) :
      undefined;
}


// Why catalog.yaml may not hold `present` keys for `scope` (its parsed value):
// the keys apply only to a single scope backed by an entry group. Undefined
// when it may. The manifest schema reports it (see manifest.ts); lengths are
// checked by metadataErrors, at push, so a pull can still refresh an
// over-long value.
export function metadataScopeError(
    scope: unknown, present: readonly MetadataKey[]): string|undefined {
  if (!present.length) return undefined;
  const type = typeof scope === 'string' ? scope.split('.')[0] : undefined;
  if (type !== undefined && ENTRY_GROUP_SCOPES.includes(type)) return undefined;
  return `${present.map(k => `'${k}'`).join(' and ')} apply only to scopes ` +
      `backed by an entry group (${
             ENTRY_GROUP_SCOPES.map(s => `'${s}'`).join(', ')}).`;
}


// The keys a parsed catalog.yaml holds as strings. Anything else, or a key
// that is not a string, is left out; the manifest schema reports the latter.
export function metadataOfManifest(manifest: unknown): ContextSetMetadata {
  const metadata: ContextSetMetadata = {};
  if (typeof manifest !== 'object' || manifest === null) return metadata;
  for (const key of METADATA_KEYS) {
    const value = (manifest as Record<string, unknown>)[key];
    if (typeof value === 'string') metadata[key] = value;
  }
  return metadata;
}


// The keys the catalog.yaml at `path` holds, or none when there is no file.
export function readContextSetMetadata(path: string): ContextSetMetadata {
  if (!fs.existsSync(path)) return {};
  return metadataOfManifest(yaml.parse(fs.readFileSync(path, 'utf8')));
}


// The display name and description an entry group has. An empty value is
// left out, as Knowledge Catalog leaves out an unset one.
export function metadataOfEntryGroup(group: dataplex.EntryGroup|undefined):
    ContextSetMetadata {
  const metadata: ContextSetMetadata = {};
  for (const key of METADATA_KEYS) {
    const value = group?.[key];
    if (typeof value === 'string' && value !== '') metadata[key] = value;
  }
  return metadata;
}


// Why `metadata` cannot be written to Knowledge Catalog: one message per key
// that is longer than the entry group allows.
export function metadataErrors(metadata: ContextSetMetadata): string[] {
  const errors: string[] = [];
  for (const key of METADATA_KEYS) {
    const value = metadata[key];
    if (value !== undefined && value.length > LIMITS[key]) {
      errors.push(
          `catalog.yaml: the context set's ${LABELS[key]} is ${
              value.length} characters long; Knowledge Catalog allows at ` +
          `most ${LIMITS[key]}.`);
    }
  }
  return errors;
}


// The keys of `local` whose values differ from `remote`, as an entry group
// patch and its update mask. Undefined when nothing differs. A key `local`
// does not hold is not managed and never differs.
export function metadataUpdate(
    local: ContextSetMetadata, remote: ContextSetMetadata):
    {patch: ContextSetMetadata; updateMask: MetadataKey[]}|undefined {
  const patch: ContextSetMetadata = {};
  const updateMask: MetadataKey[] = [];
  for (const key of METADATA_KEYS) {
    const value = local[key];
    if (value === undefined || value === (remote[key] ?? '')) continue;
    patch[key] = value;
    updateMask.push(key);
  }
  return updateMask.length ? {patch, updateMask} : undefined;
}


// Sets the keys of the catalog.yaml at `path` to `metadata`, keeping every
// other key and comment as written. A key `metadata` does not hold is
// removed. Returns the keys that changed; the file is left untouched when
// none did.
export function writeContextSetMetadata(
    path: string, metadata: ContextSetMetadata): MetadataKey[] {
  const doc = yaml.parseDocument(fs.readFileSync(path, 'utf8'));
  const current = metadataOfManifest(doc.toJS());
  const changed = METADATA_KEYS.filter(k => current[k] !== metadata[k]);
  if (!changed.length) return [];
  for (const key of changed) {
    const value = metadata[key];
    if (value === undefined) {
      doc.delete(key);
    } else {
      doc.set(key, value);
    }
  }
  fs.writeFileSync(path, doc.toString(), 'utf8');
  return changed;
}


// What a pull or push of the keys did.
export interface MetadataSyncResult {
  // The keys that changed (or, on a dry run, would change).
  changed: MetadataKey[];
  error?: string;
}


// Reads the entry group `ref` names and sets the keys of the catalog.yaml at
// `path` from it. On a dry run the file is not written, and `changed` lists
// the keys a pull would change.
export async function pullContextSetMetadata(
    catalog: dataplex.CatalogClient, ref: EntryGroupRef, path: string,
    options: {dryRun?: boolean} = {}): Promise<MetadataSyncResult> {
  const res =
      await catalog.getEntryGroup(ref.project, ref.location, ref.entryGroup);
  if (res.status !== 200) {
    return {
      changed: [],
      error: `reading context set '${nameOf(ref)}': ${failure(res)}`,
    };
  }
  const remote = metadataOfEntryGroup(res.result);
  if (options.dryRun) {
    const local = readContextSetMetadata(path);
    return {changed: METADATA_KEYS.filter(k => local[k] !== remote[k])};
  }
  return {changed: writeContextSetMetadata(path, remote)};
}


// Writes the keys `local` holds to the entry group `ref` names, when they
// differ from it, and waits for the update to finish. Under `validateOnly`
// nothing is written, and `changed` lists the keys a push would change.
export async function pushContextSetMetadata(
    catalog: dataplex.CatalogClient, ref: EntryGroupRef,
    local: ContextSetMetadata,
    options: {validateOnly?: boolean} = {}): Promise<MetadataSyncResult> {
  const errors = metadataErrors(local);
  if (errors.length) return {changed: [], error: errors.join('\n')};
  if (!METADATA_KEYS.some(k => local[k] !== undefined)) return {changed: []};
  const res =
      await catalog.getEntryGroup(ref.project, ref.location, ref.entryGroup);
  if (res.status !== 200) {
    return {
      changed: [],
      error: `reading context set '${nameOf(ref)}': ${failure(res)}`,
    };
  }
  const update = metadataUpdate(local, metadataOfEntryGroup(res.result));
  if (!update) return {changed: []};
  if (options.validateOnly) return {changed: update.updateMask};
  const patched = await catalog.updateEntryGroup(
      ref.project, ref.location, ref.entryGroup, update.patch,
      update.updateMask);
  if (patched.status !== 200) {
    return {
      changed: [],
      error: `updating context set '${nameOf(ref)}': ${failure(patched)}`,
    };
  }
  const opError =
      await catalog.awaitOperation(patched.result, 'updateEntryGroup');
  if (opError) {
    return {
      changed: [],
      error: `updating context set '${nameOf(ref)}': ${opError}`,
    };
  }
  return {changed: update.updateMask};
}


// A one-line report of `changed`, such as "the context set's display name and
// description", for the commands to print.
export function describeChanged(changed: MetadataKey[]): string {
  return `the context set's ${changed.map(k => LABELS[k]).join(' and ')}`;
}


function nameOf(ref: EntryGroupRef): string {
  return `${ref.project}.${ref.location}.${ref.entryGroup}`;
}


function failure(res: api.ApiResult<unknown>): string {
  return res.message || `HTTP ${res.status}`;
}
