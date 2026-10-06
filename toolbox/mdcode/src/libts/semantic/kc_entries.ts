// Pure helper operations on Knowledge Catalog `Entry` and `EntryLink` objects.
//
// Centralizes ID/type extraction, entry/link type predicates, ownership
// checks, and aspect-key extraction for entries and entry links.

import {Entry, EntryLink, EntryReference} from '../gcp/dataplex';
import {DEFAULT_TYPE_LOCATION, DEFAULT_TYPE_PROJECT, entryIdOf} from './kc_ids';
import {KcResources} from './knowledge_catalog';

/** Options overriding the system-type project, location, and V2 aspect mode. */
export interface SystemTypeOptions {
  systemTypeProject?: string;
  systemTypeLocation?: string;
  v2Aspects?: boolean;
}

/**
 * A model anchor ID paired with the child entry-ID prefixes it owns across the
 * V1 dotted (`<anchorId>.`) and V2/LookML slash (`<anchorId>/`) ID schemes.
 */
export interface KcAnchor {
  readonly anchorId: string;
  readonly ownedPrefixes: readonly string[];
}

/**
 * A model owner representation (`KcResources` or `KcAnchor`) used to test entry
 * and entry-link ownership.
 */
export type KcOwner = KcResources | KcAnchor;

// ---------------------------------------------------------------------------
// 1. Bare ID and Type-ID Extraction
// ---------------------------------------------------------------------------

/**
 * Returns the bare entry ID of `entry` (everything after `/entries/`).
 *
 * Examples:
 * - `'projects/p/locations/us/entryGroups/eg/entries/sales.entities.orders'`
 *   -> `'sales.entities.orders'`
 * - `'projects/p/locations/us/entryGroups/eg/entries/sales/entities/orders'`
 *   -> `'sales/entities/orders'`
 */
export function entryId(entry: Entry): string {
  return entryIdOf(entry.name);
}

/**
 * Returns the bare entry-type ID of `entry` (everything after `/entryTypes/`).
 *
 * Example:
 * - `'projects/dataplex-types/locations/global/entryTypes/semantic-entity'`
 *   -> `'semantic-entity'`
 */
export function entryTypeId(entry: Entry): string {
  return entryIdOf(entry.entryType ?? '');
}

/**
 * Returns the bare entry-link ID of `link` (everything after `/entryLinks/`).
 *
 * Example:
 * - `'projects/p/locations/us/entryGroups/eg/entryLinks/sales-orders-to-users'`
 *   -> `'sales-orders-to-users'`
 */
export function linkId(link: EntryLink): string {
  return entryIdOf(link.name ?? '');
}

/**
 * Returns the bare entry-link-type ID of `link` (everything after
 * `/entryLinkTypes/`).
 *
 * Example:
 * - `'projects/dataplex-types/locations/global/entryLinkTypes/schema-join'`
 *   -> `'schema-join'`
 */
export function linkTypeId(link: EntryLink): string {
  return entryIdOf(link.entryLinkType ?? '');
}

// ---------------------------------------------------------------------------
// 2. Entry & EntryLink Type Predicates & Anchor Extraction
// ---------------------------------------------------------------------------

/**
 * Returns true when `entry` is a `semantic-model` entry.
 */
export function isModelEntry(entry: Entry): boolean {
  return entryTypeId(entry) === 'semantic-model';
}

/**
 * Returns true when `entry` is a model anchor entry (`semantic-model`).
 *
 * Alias for `isModelEntry`.
 */
export const isAnchorEntry = isModelEntry;

/**
 * Returns the bare entry ID of `entry` if it is a model anchor entry
 * (`isAnchorEntry(entry)`), or `undefined` otherwise.
 */
export function anchorId(entry: Entry | undefined): string | undefined {
  return entry && isAnchorEntry(entry) ? entryId(entry) : undefined;
}

/**
 * Returns true when `entry` is a `semantic-entity` entry.
 */
export function isEntityEntry(entry: Entry): boolean {
  return entryTypeId(entry) === 'semantic-entity';
}

/**
 * Returns true when `entry` is a `semantic-metric` entry.
 */
export function isMetricEntry(entry: Entry): boolean {
  return entryTypeId(entry) === 'semantic-metric';
}

/**
 * Returns true when `entry` is a `semantic-explore` entry.
 */
export function isExploreEntry(entry: Entry): boolean {
  return entryTypeId(entry) === 'semantic-explore';
}

/**
 * Returns true when `entry` depends on a `semantic-entity` entry.
 *
 * Dependent entries (`semantic-metric` and `semantic-explore`) reference
 * entity entries by name and must be written in the second wave after entity
 * entries exist.
 */
export function isDependentEntry(entry: Entry): boolean {
  return isMetricEntry(entry) || isExploreEntry(entry);
}

/**
 * Returns true when `link` is a model relationship entry link (`schema-join`
 * in V1 or `semantic-relationship` in V2).
 *
 * Includes both V1 (`schema-join`) and V2 (`semantic-relationship`) regardless
 * of `v2Aspects`, so a model pushed with V1 and then V2 still discovers and
 * cleans up its old `schema-join` links without passing `semantic-relationship`
 * in a server-side `lookupEntryLinks` filter.
 */
export function isRelationshipLink(link: EntryLink): boolean {
  const type = linkTypeId(link);
  return type === 'schema-join' || type === 'semantic-relationship';
}

// ---------------------------------------------------------------------------
// 3. Ownership & Filtering Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `str` starts with any non-empty prefix in `prefixes`.
 */
function startsWithAny(str: string, prefixes: readonly string[]): boolean {
  return prefixes.some(p => p.length > 0 && str.startsWith(p));
}

/**
 * Returns the full resource names of all `semantic-entity` entries in
 * `entries`.
 */
export function collectEntityNames(entries: readonly Entry[]): string[] {
  return entries.filter(isEntityEntry).map(e => e.name);
}

/**
 * Returns true when `entry` is owned by `owner`:
 *   * For `KcResources`, matches child entries under `owner.ownedPrefixes`
 *     (the model anchor itself is not a child prefix).
 *   * For `KcAnchor`, matches both the model anchor entry (`owner.anchorId`)
 *     and child entries under `owner.ownedPrefixes`.
 */
export function isEntryOwner(owner: KcOwner, entry: Entry): boolean {
  if ('anchorId' in owner) {
    if (!owner.anchorId) return false;
    if (anchorId(entry) === owner.anchorId) return true;
  }
  return startsWithAny(entryId(entry), owner.ownedPrefixes);
}

/**
 * Filters `entries` to those owned by `owner` (`KcResources` or `KcAnchor`).
 */
export function collectOwnedEntries(
    owner: KcOwner, entries: readonly Entry[]): Entry[] {
  return entries.filter(e => isEntryOwner(owner, e));
}

/**
 * Returns true when both endpoints of `link` are owned by `owner`
 * (`KcResources` or `KcAnchor`).
 */
export function isLinkOwner(owner: KcOwner, link: EntryLink): boolean {
  if ('anchorId' in owner && !owner.anchorId) return false;
  return link.entryReferences.length === 2 &&
      link.entryReferences.every(
          r => startsWithAny(entryIdOf(r.name), owner.ownedPrefixes));
}

// ---------------------------------------------------------------------------
// 4. Aspect Keys & Link-Reference Comparison
// ---------------------------------------------------------------------------

/**
 * Resolves the project and location where built-in system types live.
 *
 * Uses `opts` overrides when provided and defaults to `DEFAULT_TYPE_PROJECT`
 * and `DEFAULT_TYPE_LOCATION`.
 */
function systemTypeProjectAndLocation(
    opts?: SystemTypeOptions): {proj: string; loc: string} {
  return {
    proj: opts?.systemTypeProject ?? DEFAULT_TYPE_PROJECT,
    loc: opts?.systemTypeLocation ?? DEFAULT_TYPE_LOCATION,
  };
}

/**
 * Returns the set of aspect keys to include when updating `entry`.
 *
 * Always includes every aspect key present on `entry.aspects` plus the
 * optional `<proj>.<loc>.guidelines` aspect. When `opts?.v2Aspects` is true:
 *   * Adds `<proj>.<loc>.sql-expressions` on entity and metric entries.
 *   * Adds `<proj>.<loc>.guidelines@*` on entity entries so Dataplex clears
 *     field-level `guidelines` aspects for columns whose instructions or
 *     fields were removed.
 */
export function entryAspectKeys(
    entry: Entry, opts?: SystemTypeOptions): Set<string> {
  const {proj, loc} = systemTypeProjectAndLocation(opts);
  const keys = new Set([
    ...Object.keys(entry.aspects ?? {}),
    `${proj}.${loc}.guidelines`,
  ]);
  if (!opts?.v2Aspects) return keys;

  if (isEntityEntry(entry) || isMetricEntry(entry)) {
    keys.add(`${proj}.${loc}.sql-expressions`);
  }
  if (isEntityEntry(entry)) {
    keys.add(`${proj}.${loc}.guidelines@*`);
  }
  return keys;
}

/**
 * Formats an `EntryReference` into a canonical comparison key combining its
 * bare entry ID, reference type (defaulting to `'UNSPECIFIED'`), and path
 * (treating an absent path and `''` as equal).
 */
function formatLinkReference(ref: EntryReference): string {
  const id = entryIdOf(ref.name);
  const type = ref.type ?? 'UNSPECIFIED';
  return `${id}|${type}|${ref.path ?? ''}`;
}

/**
 * Compares the `entryReferences` of two entry links by bare entry ID, reference
 * type, and path, independent of reference order.
 */
export function sameLinkReferences(a: EntryLink, b: EntryLink): boolean {
  const refsA = a.entryReferences;
  const refsB = b.entryReferences;
  if (refsA.length !== refsB.length) return false;
  const sortedA = refsA.map(formatLinkReference).sort();
  const sortedB = refsB.map(formatLinkReference).sort();
  return sortedA.every((ref, i) => ref === sortedB[i]);
}
