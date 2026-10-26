// EntryLink serialization and parsing for OKF `bundle/_links.yaml` (SPEC §4).

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

import * as gcp from '../gcp';
import * as dataplex from '../gcp/dataplex';
import {Concept, EXTRA_KEY, RESIDUE_KEY} from './concept';

export const LINKS_FILE = '_links.yaml';

const SYSTEM_TYPES_PREFIX =
  'projects/dataplex-types/locations/global/entryLinkTypes/';

const UNDIRECTED_LINK_TYPES = new Set(['related', 'synonym', 'schema-join']);

// The system link types, which Knowledge Catalog returns under the project
// number of `dataplex-types` rather than its ID.
const SYSTEM_LINK_TYPE_NAMES = new Set([
  'related',
  'reference',
  'synonym',
  'definition',
  'schema-join',
]);
const NUMBERED_SYSTEM_LINK_TYPE =
  /^projects\/\d+\/locations\/global\/entryLinkTypes\/([a-z0-9-]+)$/;

export interface BundleLinksResult {
  /** True when `_links.yaml` exists or a concept declares frontmatter links. */
  hasLinksConfig: boolean;
  /** Deduplicated Dataplex EntryLinks ready for push. */
  links: gcp.EntryLink[];
}

/** Reads `bundle/_links.yaml` and any frontmatter `links` from `concepts`. */
export function readBundleLinks(
  root: string,
  entryGroup: string,
  concepts: Concept[] = [],
): BundleLinksResult {
  const rawLinks: Array<{raw: Record<string, unknown>; sourceId?: string}> = [];
  let hasLinksConfig = false;

  for (const linksFile of findLinksFiles(root)) {
    hasLinksConfig = true;
    const text = fs.readFileSync(linksFile, 'utf8');
    let parsed: unknown;
    try {
      parsed = yaml.parse(text);
    } catch (err: any) {
      throw new Error(
        `invalid YAML in ${path.relative(root, linksFile)}: ${err.message || err}`,
      );
    }
    if (parsed === null || parsed === undefined) continue;
    for (const item of extractRawLinks(parsed, path.relative(root, linksFile))) {
      rawLinks.push({raw: item});
    }
  }

  for (const concept of concepts) {
    const fm = concept.frontmatter;
    const extra = asRecord(fm[EXTRA_KEY]);
    const residue = asRecord(fm[RESIDUE_KEY]);
    const conceptLinks = fm['links'] ?? extra?.['links'] ?? residue?.['links'];
    if (conceptLinks === undefined) continue;
    hasLinksConfig = true;
    for (const item of extractRawLinks(conceptLinks, `${concept.id}.md`)) {
      rawLinks.push({raw: item, sourceId: concept.id});
    }
  }

  const byKey = new Map<string, gcp.EntryLink>();
  for (const {raw, sourceId} of rawLinks) {
    const link = toEntryLink(raw, entryGroup, sourceId);
    byKey.set(linkDedupKey(link), link);
  }

  return {hasLinksConfig, links: [...byKey.values()]};
}

/** Formats Dataplex `EntryLink`s into canonical `bundle/_links.yaml` content. */
export function formatLinksYaml(
  links: gcp.EntryLink[],
  entryGroup: string,
): string {
  const serialized = links.map((link) => {
    const shortType = shortenLinkType(link.entryLinkType);
    const refs = orderedReferences(link.entryReferences ?? [], entryGroup).map(
      (ref) => {
        const shortName = shortenEntryName(ref.name, entryGroup);
        const hasPath = typeof ref.path === 'string' && ref.path.length > 0;
        const hasRole =
          typeof ref.type === 'string' &&
          ref.type.length > 0 &&
          ref.type !== 'UNSPECIFIED';
        if (!hasPath && !hasRole) {
          return shortName;
        }
        const out: Record<string, unknown> = {name: shortName};
        if (hasPath) out.path = ref.path;
        if (hasRole) out.type = ref.type;
        return out;
      },
    );

    // The link's own ID, so that pushing a pulled bundle updates the same
    // link instead of deleting it and creating one under a new ID.
    const id = entryLinkId(link);
    const item: Record<string, unknown> = {
      ...(id ? {id} : {}),
      type: shortType,
      entries: refs,
    };
    if (link.aspects && Object.keys(link.aspects).length > 0) {
      item.aspects = link.aspects;
    }
    return item;
  });

  return yaml.stringify({links: serialized});
}

/** Extracts the bare `entryLinkId` from an `EntryLink.name`. */
export function entryLinkId(link: gcp.EntryLink): string {
  return link.name?.split('/entryLinks/')[1] ?? link.name ?? '';
}

/** Deterministic deduplication key across link type and endpoints. */
export function linkDedupKey(link: gcp.EntryLink): string {
  if (link.name) return link.name;
  const refs = (link.entryReferences ?? [])
    .map((r) => `${r.type ?? 'UNSPECIFIED'}:${r.name}${r.path ? `@${r.path}` : ''}`)
    .sort()
    .join('|');
  return `${link.entryLinkType}|${refs}`;
}

/** True when `existing` differs from `desired` in immutable type or references. */
export function isStaleEntryLink(
  existing: gcp.EntryLink,
  desired: gcp.EntryLink,
): boolean {
  if (
    shortenLinkType(existing.entryLinkType) !==
    shortenLinkType(desired.entryLinkType)
  ) {
    return true;
  }
  const a = canonicalRefs(existing.entryReferences ?? []);
  const b = canonicalRefs(desired.entryReferences ?? []);
  return a !== b;
}

function canonicalRefs(refs: gcp.EntryReference[]): string {
  return refs
    .map(
      (r) =>
        `${r.type ?? 'UNSPECIFIED'}:${normalizeProjectSegment(r.name)}${
          r.path ? `@${r.path}` : ''
        }`,
    )
    .sort()
    .join('|');
}

function normalizeProjectSegment(resourceName: string): string {
  const idx = resourceName.indexOf('/locations/');
  return idx === -1 ? resourceName : resourceName.slice(idx);
}

function findLinksFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findLinksFiles(full));
    } else if (entry.name === LINKS_FILE) {
      files.push(full);
    }
  }
  return files.sort();
}

function extractRawLinks(
  parsed: unknown,
  sourceLabel: string,
): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) {
    return parsed.map((item, i) => {
      const rec = asRecord(item);
      if (!rec) {
        throw new Error(`${sourceLabel}: link #${i + 1} must be an object`);
      }
      return rec;
    });
  }
  const obj = asRecord(parsed);
  if (!obj) {
    throw new Error(`${sourceLabel}: expected a YAML mapping or sequence`);
  }
  const list = obj['links'] ?? obj['entryLinks'] ?? obj['entry_links'];
  if (list !== undefined) {
    if (!Array.isArray(list)) {
      throw new Error(`${sourceLabel}: 'links' must be a list`);
    }
    return extractRawLinks(list, sourceLabel);
  }

  // Shorthand mapping keyed by link type: `{ related: [...], definition: [...] }`.
  const out: Array<Record<string, unknown>> = [];
  for (const [key, val] of Object.entries(obj)) {
    if (!Array.isArray(val)) {
      throw new Error(
        `${sourceLabel}: unexpected field '${key}' (expected 'links' list)`,
      );
    }
    for (const item of extractRawLinks(val, `${sourceLabel}.${key}`)) {
      out.push({type: key, ...item});
    }
  }
  return out;
}

function toEntryLink(
  raw: Record<string, unknown>,
  entryGroup: string,
  defaultSourceId?: string,
): gcp.EntryLink {
  const rawType =
    asString(raw['type']) ??
    asString(raw['entryLinkType']) ??
    asString(raw['entry_link_type']) ??
    asString(raw['linkType']) ??
    asString(raw['link_type']);
  if (!rawType) {
    throw new Error(`${LINKS_FILE}: link is missing 'type'`);
  }
  const entryLinkType = resolveEntryLinkType(rawType);
  const shortType = shortenLinkType(entryLinkType);
  const isUndirected = UNDIRECTED_LINK_TYPES.has(shortType);

  const rawRefs = extractRawRefs(raw, defaultSourceId);
  if (rawRefs.length < 2) {
    throw new Error(
      `${LINKS_FILE}: link of type '${rawType}' must reference at least 2 entries`,
    );
  }

  const entryReferences: gcp.EntryReference[] = rawRefs.map((r) =>
    toEntryReference(r, entryGroup, isUndirected),
  );

  // Directed 2-endpoint links (such as `definition`) default untyped endpoints
  // to SOURCE -> TARGET in declaration order.
  if (
    !isUndirected &&
    entryReferences.length === 2 &&
    entryReferences[0].type === 'UNSPECIFIED' &&
    entryReferences[1].type === 'UNSPECIFIED'
  ) {
    entryReferences[0].type = 'SOURCE';
    entryReferences[1].type = 'TARGET';
  }

  const explicitId =
    asString(raw['id']) ??
    asString(raw['entryLinkId']) ??
    asString(raw['entry_link_id']) ??
    asString(raw['name']);
  const linkId = explicitId
    ? normalizeLinkId(explicitId)
    : computeDeterministicLinkId(entryLinkType, entryReferences);

  const link: gcp.EntryLink = {
    name: `${entryGroup}/entryLinks/${linkId}`,
    entryLinkType,
    entryReferences,
  };

  const rawAspects = asRecord(raw['aspects']);
  if (rawAspects && Object.keys(rawAspects).length > 0) {
    const aspects: Record<string, gcp.Aspect> = {};
    for (const [key, val] of Object.entries(rawAspects)) {
      const valRec = asRecord(val);
      if (!valRec) continue;
      const atIdx = key.indexOf('@');
      const typeRef = atIdx === -1 ? key : key.slice(0, atIdx);
      const keyPath = atIdx === -1 ? undefined : key.slice(atIdx + 1);
      const aspectType =
        asString(valRec['aspectType']) ??
        (typeRef.split('.').length === 3
          ? dataplex._typeRefToName(typeRef, 'aspect')
          : undefined);
      const data = asRecord(valRec['data']) ?? valRec;
      aspects[key] = {
        ...(aspectType ? {aspectType} : {}),
        ...(keyPath ? {path: keyPath} : {}),
        data,
      };
    }
    if (Object.keys(aspects).length > 0) {
      link.aspects = aspects;
    }
  }

  return link;
}

function extractRawRefs(
  raw: Record<string, unknown>,
  defaultSourceId?: string,
): unknown[] {
  const list =
    raw['entries'] ?? raw['entryReferences'] ?? raw['entry_references'] ?? raw['references'];
  if (Array.isArray(list)) {
    if (list.length === 1 && defaultSourceId) {
      return [{name: defaultSourceId, type: 'SOURCE'}, list[0]];
    }
    return list;
  }
  const source = raw['source'] ?? raw['from'] ?? defaultSourceId;
  const target = raw['target'] ?? raw['to'];
  if (source !== undefined && target !== undefined) {
    const srcObj =
      typeof source === 'string'
        ? {
            name: source,
            path: raw['source_path'] ?? raw['sourcePath'],
            type: 'SOURCE',
          }
        : {...(asRecord(source) ?? {}), type: 'SOURCE'};
    const tgtObj =
      typeof target === 'string'
        ? {
            name: target,
            path: raw['target_path'] ?? raw['targetPath'] ?? raw['path'],
            type: 'TARGET',
          }
        : {...(asRecord(target) ?? {}), type: 'TARGET'};
    return [srcObj, tgtObj];
  }
  throw new Error(`${LINKS_FILE}: link is missing 'entries' list`);
}

function toEntryReference(
  raw: unknown,
  entryGroup: string,
  isUndirected: boolean,
): gcp.EntryReference {
  if (typeof raw === 'string') {
    const [rawName, inlinePath] = splitInlinePath(raw);
    const ref: gcp.EntryReference = {
      name: resolveEntryRefName(rawName, entryGroup),
      type: 'UNSPECIFIED',
    };
    if (inlinePath) ref.path = inlinePath;
    return ref;
  }

  const obj = asRecord(raw);
  if (!obj) {
    throw new Error(`${LINKS_FILE}: entry reference must be a string or object`);
  }
  const rawName =
    asString(obj['name']) ??
    asString(obj['entry']) ??
    asString(obj['id']) ??
    asString(obj['target']);
  if (!rawName) {
    throw new Error(`${LINKS_FILE}: entry reference is missing 'name'`);
  }
  const [baseName, inlinePath] = splitInlinePath(rawName);
  const pathVal =
    asString(obj['path']) ??
    asString(obj['field']) ??
    asString(obj['column']) ??
    inlinePath;
  const rawRole = (
    asString(obj['type']) ??
    asString(obj['role']) ??
    asString(obj['mode']) ??
    'UNSPECIFIED'
  ).toUpperCase();

  let type: 'UNSPECIFIED' | 'SOURCE' | 'TARGET' = 'UNSPECIFIED';
  if (!isUndirected) {
    if (rawRole === 'SOURCE' || rawRole === 'FROM') {
      type = 'SOURCE';
    } else if (rawRole === 'TARGET' || rawRole === 'TO') {
      type = 'TARGET';
    }
  }

  const ref: gcp.EntryReference = {
    name: resolveEntryRefName(baseName, entryGroup),
    type,
  };
  if (pathVal) ref.path = pathVal;
  return ref;
}

function splitInlinePath(raw: string): [string, string | undefined] {
  const hashIdx = raw.indexOf('#');
  if (hashIdx === -1) return [raw, undefined];
  const base = raw.slice(0, hashIdx);
  const col = raw.slice(hashIdx + 1);
  if (!col) return [base, undefined];
  return [base, col.startsWith('Schema.') ? col : `Schema.${col}`];
}

export function resolveEntryLinkType(rawType: string): string {
  const trimmed = rawType.trim();
  if (trimmed.startsWith('projects/') && trimmed.includes('/entryLinkTypes/')) {
    return trimmed;
  }
  if (trimmed.split('.').length === 3) {
    return dataplex._typeRefToName(trimmed, 'entryLink');
  }
  return `${SYSTEM_TYPES_PREFIX}${trimmed}`;
}

export function shortenLinkType(entryLinkType: string): string {
  if (entryLinkType.startsWith(SYSTEM_TYPES_PREFIX)) {
    return entryLinkType.slice(SYSTEM_TYPES_PREFIX.length);
  }
  const numbered = NUMBERED_SYSTEM_LINK_TYPE.exec(entryLinkType)?.[1];
  if (numbered && SYSTEM_LINK_TYPE_NAMES.has(numbered)) return numbered;
  return entryLinkType;
}

export function resolveEntryRefName(
  rawName: string,
  entryGroup: string,
): string {
  let cleaned = rawName.trim();
  if (cleaned.startsWith('projects/') && cleaned.includes('/entries/')) {
    return cleaned;
  }
  cleaned = cleaned
    .replace(/^\.\//, '')
    .replace(/^(bundle|catalog)\//, '')
    .replace(/\.md$/, '');
  return `${entryGroup}/entries/${cleaned}`;
}

export function shortenEntryName(
  fullEntryName: string,
  entryGroup: string,
): string {
  const prefix = `${entryGroup}/entries/`;
  if (fullEntryName.startsWith(prefix)) {
    return fullEntryName.slice(prefix.length);
  }
  // Handle project-number vs project-id spelling of the same location + entryGroup.
  const locIdx = entryGroup.indexOf('/locations/');
  if (locIdx !== -1) {
    const groupSuffix = `${entryGroup.slice(locIdx)}/entries/`;
    const matchIdx = fullEntryName.indexOf(groupSuffix);
    if (matchIdx !== -1 && fullEntryName.startsWith('projects/')) {
      return fullEntryName.slice(matchIdx + groupSuffix.length);
    }
  }
  return fullEntryName;
}

function orderedReferences(
  refs: gcp.EntryReference[],
  entryGroup: string,
): gcp.EntryReference[] {
  const copy = [...refs];
  const hasDirected = copy.some(
    (r) => r.type === 'SOURCE' || r.type === 'TARGET',
  );
  if (hasDirected) {
    const rank = (t: string | undefined) =>
      t === 'SOURCE' ? 0 : t === 'TARGET' ? 1 : 2;
    return copy.sort((a, b) => rank(a.type) - rank(b.type));
  }
  // For undirected links, list in-group entries before external entries.
  const isLocal = (r: gcp.EntryReference) =>
    shortenEntryName(r.name, entryGroup) !== r.name;
  return copy.sort((a, b) => Number(isLocal(b)) - Number(isLocal(a)));
}

function normalizeLinkId(rawId: string): string {
  const tail = rawId.includes('/entryLinks/')
    ? rawId.split('/entryLinks/')[1]
    : rawId;
  const slug = tail
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return 'link-default';
  const prefixed = /^[a-z]/.test(slug) ? slug : `link-${slug}`;
  return prefixed.slice(0, 63).replace(/-+$/, '');
}

function computeDeterministicLinkId(
  entryLinkType: string,
  refs: gcp.EntryReference[],
): string {
  const canonical = `${entryLinkType}|${refs
    .map((r) => `${r.type}:${r.name}${r.path ? `@${r.path}` : ''}`)
    .sort()
    .join('|')}`;
  const digest = crypto
    .createHash('sha1')
    .update(canonical)
    .digest('hex')
    .slice(0, 10);
  return `link-${digest}`;
}

function asRecord(val: unknown): Record<string, unknown> | undefined {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : undefined;
}

function asString(val: unknown): string | undefined {
  return typeof val === 'string' && val.trim().length > 0
    ? val.trim()
    : undefined;
}
