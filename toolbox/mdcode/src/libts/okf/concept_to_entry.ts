// The inverse of entryToConcept: rebuilds the catalog entry a concept came from

import * as gcp from '../gcp';
import {OVERVIEW_ASPECT_KEY, typeFacetKey} from './catalog_residue';
import {Concept, RESIDUE_KEY} from './concept';
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

function bodyContent(body: string, hadTrailingNewline: boolean): string {
  if (hadTrailingNewline) return body;
  return body.endsWith('\n') ? body.slice(0, -1) : body;
}

export function conceptToEntry(concept: Concept, entryGroup: string): gcp.Entry {
  const frontmatter = concept.frontmatter;
  const residue = mapping(frontmatter[RESIDUE_KEY]);

  const entryType = text(residue['entryType']);
  if (!entryType) {
    throw new ConceptError(
      `${concept.id}: no ${RESIDUE_KEY}.entryType, so the catalog entry type ` +
        `and the aspect carrying '${frontmatter['type']}' are both unknown`,
    );
  }

  const entry: gcp.Entry = {
    name: `${entryGroup}/entries/${concept.id}`,
    entryType,
  };

  const parentEntry = text(residue['parentEntry']);
  if (parentEntry) entry.parentEntry = parentEntry;

  const source: Record<string, unknown> = {...mapping(residue['entrySource'])};
  const displayName = text(frontmatter['title']);
  const description = text(frontmatter['description']);
  const resource = text(frontmatter['resource']);
  if (displayName) source['displayName'] = displayName;
  if (description) source['description'] = description;
  if (resource) source['resource'] = resource;
  if (Object.keys(source).length) {
    entry.entrySource = source as gcp.Entry['entrySource'];
  }

  const aspects: Record<string, {data: Record<string, unknown>}> = {};
  for (const [key, data] of Object.entries(mapping(residue['aspects']))) {
    aspects[key] = {data: {...mapping(data)}};
  }

  // A type with no stashed aspect was read off the entry type, not an aspect.
  const conceptType = text(frontmatter['type']);
  const facetKey = typeFacetKey(entryType);
  if (conceptType && facetKey && facetKey in aspects) {
    aspects[facetKey] = {data: {type: conceptType, ...aspects[facetKey].data}};
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
