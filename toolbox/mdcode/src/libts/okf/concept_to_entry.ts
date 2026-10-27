// The inverse of entryToConcept: rebuilds the catalog entry a concept came from

import * as gcp from '../gcp';
import {
  assertResidueOnly,
  DEFAULT_DOCUMENT_ENTRY_TYPE,
  DOCUMENT_ASPECT_KEY,
  OVERVIEW_ASPECT_KEY,
  QUERY_TEMPLATE_ASPECT_KEY,
  QUERY_TEMPLATE_ENTRY_TYPE,
  typeFacetKey,
} from './catalog_residue';
import {Concept, EXTRA_KEY, RESIDUE_KEY} from './concept';
import {appendOkfMetadata} from './okf_metadata';

export class ConceptError extends Error {}

function mapping(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function headingTitle(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m && m[1]) return m[1];
  }
  return undefined;
}

/** Maps OKF human-readable `type` labels to Dataplex `document.type` slugs. */
export function normalizeOkfDocType(rawType: string): string {
  const norm = rawType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (
    norm === 'table' ||
    norm === 'bigquery-table' ||
    norm === 'table-context'
  ) {
    return 'table-context';
  }
  return norm || 'document';
}

function bodyContent(body: string, hadTrailingNewline: boolean): string {
  if (hadTrailingNewline) return body;
  return body.endsWith('\n') ? body.slice(0, -1) : body;
}

export function conceptToEntry(concept: Concept, entryGroup: string): gcp.Entry {
  const frontmatter = concept.frontmatter;
  assertResidueOnly(frontmatter);

  const residue = mapping(frontmatter[RESIDUE_KEY]);
  const extra = mapping(frontmatter[EXTRA_KEY]);
  const extraResource = mapping(extra['resource']);

  const residueEntryType = text(residue['entryType']);
  const extraEntryType = text(extra['type']);
  const rawExplicitType = residueEntryType ?? extraEntryType;
  const hasQueryTemplateAspect =
    QUERY_TEMPLATE_ASPECT_KEY in mapping(extra['aspects']) ||
    QUERY_TEMPLATE_ASPECT_KEY in mapping(residue['aspects']);
  const inferredQueryTemplateType =
    !rawExplicitType &&
    hasQueryTemplateAspect &&
    normalizeOkfDocType(text(frontmatter['type']) ?? '') === 'query-template'
      ? QUERY_TEMPLATE_ENTRY_TYPE
      : undefined;
  const normalizedExplicitType = rawExplicitType ?? inferredQueryTemplateType;
  const isQueryTemplate = Boolean(
    normalizedExplicitType?.endsWith('/entryTypes/query-template'),
  );
  const defaultedEntryType = !normalizedExplicitType;

  const isRootIndex = concept.id === 'index';
  const isDirIndex = concept.id.endsWith('/index');

  let conceptType = text(frontmatter['type']);
  if (!conceptType && defaultedEntryType) {
    if (isRootIndex) {
      conceptType = 'knowledge-base';
    } else if (isDirIndex) {
      conceptType = 'knowledge-base-index';
    } else {
      throw new ConceptError(
        `${concept.id}: no ${RESIDUE_KEY}.entryType and no frontmatter 'type', ` +
          `so the catalog entry type is unknown`,
      );
    }
  }

  const entryType = normalizedExplicitType ?? DEFAULT_DOCUMENT_ENTRY_TYPE;

  let resolvedId =
    text(residue['entryId']) ?? text(extra['entry_id']) ?? concept.id;
  if (defaultedEntryType && !text(residue['entryId']) && !text(extra['entry_id'])) {
    if (isRootIndex) {
      resolvedId = 'agents';
    } else if (isDirIndex) {
      resolvedId = concept.id.slice(0, -'/index'.length);
    }
  }

  const entry: gcp.Entry = {
    name: `${entryGroup}/entries/${resolvedId}`,
    entryType,
  };

  const explicitParent =
    text(residue['parentEntry']) ?? text(extraResource['parent']);
  if (explicitParent) {
    entry.parentEntry = explicitParent;
  } else if (defaultedEntryType) {
    if (isRootIndex) {
      // Root `index.md` (`agents`) is the top-level entry; no parentEntry.
    } else if (isDirIndex) {
      const slash = resolvedId.lastIndexOf('/');
      entry.parentEntry =
        slash !== -1
          ? `${entryGroup}/entries/${resolvedId.slice(0, slash)}`
          : `${entryGroup}/entries/agents`;
    } else {
      const slash = resolvedId.lastIndexOf('/');
      if (slash !== -1) {
        entry.parentEntry = `${entryGroup}/entries/${resolvedId.slice(0, slash)}`;
      }
    }
  }

  const source: Record<string, unknown> = {...mapping(residue['entrySource'])};
  for (const key of ['system', 'platform', 'ancestors', 'labels'] as const) {
    if (source[key] === undefined && extraResource[key] !== undefined) {
      source[key] = extraResource[key];
    }
  }
  const displayName =
    text(frontmatter['title']) ??
    (defaultedEntryType || isQueryTemplate
      ? headingTitle(concept.body)
      : undefined);
  const description = text(frontmatter['description']);
  const resource = text(frontmatter['resource']);
  if (displayName) source['displayName'] = displayName;
  if (description) source['description'] = description;
  if (resource) source['resource'] = resource;
  if (Object.keys(source).length) {
    entry.entrySource = source as gcp.Entry['entrySource'];
  }

  const aspects: Record<string, {data: Record<string, unknown>}> = {};
  for (const [key, data] of Object.entries(mapping(extra['aspects']))) {
    const mapped = mapping(data);
    const inner =
      Object.keys(mapped).length === 1 && 'data' in mapped
        ? mapping(mapped['data'])
        : mapped;
    aspects[key] = {data: {...inner}};
  }
  for (const [key, data] of Object.entries(mapping(residue['aspects']))) {
    aspects[key] = {data: {...mapping(data)}};
  }

  // A type with no stashed aspect was read off the entry type, not an aspect,
  // unless the entry came from a pure OKF file (defaultedEntryType) or `extra`.
  const facetKey = typeFacetKey(entryType);
  const shortEntryType = entryType.split('/').pop();
  if (isQueryTemplate) {
    const qtAspect = aspects[QUERY_TEMPLATE_ASPECT_KEY];
    if (!qtAspect) {
      throw new ConceptError(
        `${concept.id}: query-template entry requires aspect '${QUERY_TEMPLATE_ASPECT_KEY}'`,
      );
    }
    const qtData = qtAspect.data;
    for (const reqField of ['query', 'nlQuery', 'intent', 'sourceType'] as const) {
      if (!text(qtData[reqField])) {
        throw new ConceptError(
          `${concept.id}: ${QUERY_TEMPLATE_ASPECT_KEY}.${reqField} is required`,
        );
      }
    }
    if (Array.isArray(qtData['parameters'])) {
      const allowedParamKeys = new Set([
        'name',
        'type',
        'description',
        'sampleValues',
        'targets',
      ]);
      qtData['parameters'] = qtData['parameters'].map((rawParam, idx) => {
        const param = mapping(rawParam);
        const cleaned: Record<string, unknown> = {};
        const stripped: string[] = [];
        for (const [k, v] of Object.entries(param)) {
          if (allowedParamKeys.has(k)) {
            cleaned[k] = v;
          } else {
            stripped.push(k);
          }
        }
        if (stripped.length) {
          console.warn(
            `[kcmd] ${concept.id}: stripping unsupported parameter key(s) ${stripped.join(', ')} on parameters[${idx}]`,
          );
        }
        return cleaned;
      });
    }
    delete aspects[DOCUMENT_ASPECT_KEY];
  } else if (defaultedEntryType) {
    const docType = normalizeOkfDocType(conceptType ?? 'document');
    aspects[DOCUMENT_ASPECT_KEY] = {
      data: {type: docType, ...(aspects[DOCUMENT_ASPECT_KEY]?.data ?? {})},
    };
  } else if (
    conceptType &&
    facetKey &&
    facetKey in aspects &&
    (facetKey === DOCUMENT_ASPECT_KEY ||
      normalizeOkfDocType(conceptType) !== shortEntryType)
  ) {
    aspects[facetKey] = {data: {type: conceptType, ...aspects[facetKey].data}};
  } else if (
    conceptType &&
    !residueEntryType &&
    extraEntryType &&
    facetKey === DOCUMENT_ASPECT_KEY &&
    !(facetKey in aspects)
  ) {
    aspects[facetKey] = {data: {type: normalizeOkfDocType(conceptType)}};
  }

  const content = appendOkfMetadata(
    bodyContent(concept.body, residue['trailingNewline'] !== false),
    frontmatter,
  );
  if (content) {
    aspects[OVERVIEW_ASPECT_KEY] = {data: {content, contentType: 'MARKDOWN'}};
  }

  if (Object.keys(aspects).length) {
    entry.aspects = aspects as gcp.Entry['aspects'];
  }
  return entry;
}
