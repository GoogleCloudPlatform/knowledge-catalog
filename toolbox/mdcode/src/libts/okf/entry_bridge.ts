// Between the catalog entry an OKF concept carries and kcmd's local entry.
//
// The OKF converters speak the service shape (`gcp.Entry`: full resource
// names, aspects wrapped in `{data}`), because that is what the bundle's
// `x-kcmd` residue stashes and what push sends. The layouts speak kcmd's local
// shape (`md.Entry`: a bare entry ID, a `<project>.<location>.<type>`
// reference, aspect data unwrapped). This module is the join.
//
// It does not call snapshot's own toLocalEntry/toServiceEntry: those are
// private to snapshot and apply the manifest's publishingConfig and
// ingestedEntries filtering, which the OKF path would then apply twice.
//
// Two service fields have no home in md.Entry -- `entrySource.system` and
// `entrySource.platform`. They stay in the concept's residue on disk and are
// carried through on save, so a round trip does not drop them even though a
// caller editing md.Entry cannot see them.

import * as dataplex from '../gcp/dataplex';
import * as gcp from '../gcp';
import * as md from '../metadata';

/** The bare entry ID of a full entry resource name. */
export function entryIdOf(name: string): string {
  const at = name.indexOf('/entries/');
  return at === -1 ? name : name.slice(at + '/entries/'.length);
}

// A service entry in kcmd's local form. `localName` is the entry's name in the
// workspace, which for an OKF bundle is the concept's path without `.md`.
export function serviceEntryToLocal(entry: gcp.Entry, localName: string): md.Entry {
  const aspects: Record<string, md.Aspect> = {};
  for (const [key, aspect] of Object.entries(entry.aspects ?? {})) {
    aspects[key] = aspect.data ?? {};
  }

  const source = entry.entrySource ?? {};
  const resource: md.Entry['resource'] = {};
  if (source.resource) resource.name = source.resource;
  if (source.displayName) resource.displayName = source.displayName;
  if (source.description) resource.description = source.description;
  if (source.labels && Object.keys(source.labels).length) {
    resource.labels = source.labels;
  }
  if (source.location) resource.location = source.location;
  if (source.ancestors?.length) resource.ancestors = source.ancestors;
  // Dataplex requires parentEntry to be in the same entry group, so the local
  // name always resolves; keeping it local is what lets a bundle be pushed to
  // a different group than it was pulled from.
  if (entry.parentEntry) resource.parent = entryIdOf(entry.parentEntry);

  return {
    name: localName,
    type: dataplex._nameToTypeRef(entry.entryType ?? ''),
    resource,
    aspects,
  };
}

// The inverse. `entryGroup` is the full entry-group resource name the entry
// belongs to, used to build the entry's own name and to resolve a local
// parent back to a full one. `carriedSource` holds the entrySource fields
// md.Entry cannot express, read off the concept being overwritten.
export function localEntryToService(
  entry: md.Entry,
  entryGroup: string,
  carriedSource: Record<string, unknown> = {},
): gcp.Entry {
  const service: gcp.Entry = {
    name: `${entryGroup}/entries/${entry.name}`,
    entryType: dataplex._typeRefToName(entry.type, 'entry'),
  };

  const resource = entry.resource ?? {};
  if (resource.parent) {
    service.parentEntry = `${entryGroup}/entries/${resource.parent}`;
  }

  const source: Record<string, unknown> = {...carriedSource};
  if (resource.name) source['resource'] = resource.name;
  if (resource.displayName) source['displayName'] = resource.displayName;
  if (resource.description) source['description'] = resource.description;
  if (resource.labels && Object.keys(resource.labels).length) {
    source['labels'] = resource.labels;
  } else {
    delete source['labels'];
  }
  if (resource.location) source['location'] = resource.location;
  if (resource.ancestors?.length) {
    source['ancestors'] = resource.ancestors;
  } else {
    delete source['ancestors'];
  }
  if (Object.keys(source).length) {
    service.entrySource = source as gcp.Entry['entrySource'];
  }

  const aspects: Record<string, {data: Record<string, unknown>}> = {};
  for (const [key, data] of Object.entries(entry.aspects ?? {})) {
    aspects[key] = {data: (data ?? {}) as Record<string, unknown>};
  }
  if (Object.keys(aspects).length) {
    service.aspects = aspects as gcp.Entry['aspects'];
  }
  return service;
}
