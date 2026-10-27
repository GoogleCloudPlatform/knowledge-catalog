// A catalog entry rendered as an OKF concept: the inverse of conceptToEntry.
//
// Lived inside catalog_to_okf.ts while pull was the only caller. The OKF
// layout needs the same mapping, and the two must agree exactly or a bundle
// written by one would not round-trip through the other, so it lives here and
// takes the concept's id rather than reaching into a snapshot for it.

import * as gcp from '../gcp';
import {assertResidueOnly, buildResidue, OVERVIEW_ASPECT_KEY, typeFacetKey} from './catalog_residue';
import {Concept, RESIDUE_KEY} from './concept';
import {splitOkfMetadata} from './okf_metadata';

export function entryToConcept(entry: gcp.Entry, id: string): Concept {
  const source = entry.entrySource ?? {};
  const frontmatter: Record<string, unknown> = {type: conceptType(entry)};
  if (source.displayName) frontmatter['title'] = source.displayName;
  if (source.description) frontmatter['description'] = source.description;
  if (source.resource) frontmatter['resource'] = source.resource;

  const overview = entry.aspects?.[OVERVIEW_ASPECT_KEY];
  const content =
    typeof overview?.data?.['content'] === 'string'
      ? (overview.data['content'] as string)
      : '';
  const {body, metadata} = splitOkfMetadata(content);
  Object.assign(frontmatter, metadata);

  // The residue must see the body after the trailing section is split off, or
  // trailingNewline and the section fight and the body grows a line per cycle.
  const residue = buildResidue(entry, OVERVIEW_ASPECT_KEY, body);
  if (residue) frontmatter[RESIDUE_KEY] = residue;
  assertResidueOnly(frontmatter);

  return {id, frontmatter, body};
}

/** The OKF `type` label: the facet aspect's own `type`, else the entry type. */
export function conceptType(entry: gcp.Entry): string {
  const key = typeFacetKey(entry.entryType);
  if (key) {
    const label = entry.aspects?.[key]?.data?.['type'];
    if (typeof label === 'string' && label) return label;
  }
  return entry.entryType?.split('/').pop() || 'concept';
}
