// Multi-file OWL import: which Turtle files make up one ontology.
//
// `kcmd owl import a.ttl b.ttl ...` merges every file it is given into one
// model (see parse.parseOwl for the merge itself). This module decides WHICH
// files that is: the files named on the command line, in the order given, plus
// the local files that satisfy their `owl:imports` -- so a modular ontology
// whose root module imports its dependencies can be imported by naming the
// root alone.
//
// An `owl:imports` names an ontology by IRI, and resolving an arbitrary IRI
// would mean fetching it over the network, which an offline, reproducible
// import must not do. So an import is followed ONLY to a local file, and only
// when that file proves it is the imported ontology:
//   1. an import already satisfied by a loaded file (one named on the command
//      line, or found earlier) -- its `owl:Ontology` IRI equals the imported
//      IRI -- needs nothing more;
//   2. otherwise a `file:` IRI names its file directly;
//   3. otherwise the importing file's own directory is searched for a file
//      named after the IRI's last path segment (`<seg>`, `<seg>.ttl`,
//      `<seg>.owl.ttl`), e.g. `https://example.org/ontology/core` ->
//      `core.ttl`.
// A candidate from (2)/(3) is accepted only when its own `owl:Ontology` IRI
// matches the import (a file that merely shares the name is not the
// ontology). An import that cannot be resolved this way is WARNED, never
// fatal -- the named files still import, and the warning says to pass the
// dependency on the command line. IRIs are compared ignoring one trailing
// `#`/`/`, the usual spelling drift between an ontology's IRI and its
// namespace.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

import {parseOwlHeader} from './parse';

/** One Turtle file of the ontology, with its contents. */
export interface OwlSource {
  path: string;
  text: string;
}

export interface CollectResult {
  // The files to merge, command-line files first (in the order given), then
  // each followed import in discovery order. No file appears twice.
  sources: OwlSource[];
  // Non-fatal notes: an owl:imports that resolved to no local file.
  warnings: string[];
}

// An IRI with at most one trailing `#` or `/` removed, the form two spellings
// of the same ontology IRI are compared in.
function normalizeIri(iri: string): string {
  return iri.replace(/[#/]$/, '');
}

// The local files an `owl:imports` IRI could name, most specific first.
function candidatePaths(iri: string, importerDir: string): string[] {
  if (iri.startsWith('file:')) {
    try {
      return [fileURLToPath(iri)];
    } catch {
      return [];
    }
  }
  const trimmed = normalizeIri(iri);
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('#'));
  const segment = cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
  if (!segment || segment.includes(':')) return [];
  const bare = segment.replace(/\.owl\.ttl$|\.ttl$|\.owl$/i, '');
  return [
    path.join(importerDir, segment),
    path.join(importerDir, `${bare}.ttl`),
    path.join(importerDir, `${bare}.owl.ttl`),
  ];
}

/**
 * Collects the Turtle files that make up one ontology: `files` (read in the
 * order given) plus, transitively, the local files that satisfy their
 * `owl:imports` (see the module comment for the resolution rules).
 *
 * Throws only when a command-line file cannot be read or is malformed Turtle
 * (the CLI checks existence first). A followed import that is malformed is
 * also an error: it was found because it declared the imported IRI, so it is
 * part of the ontology.
 */
export function collectOwlSources(files: string[]): CollectResult {
  const sources: OwlSource[] = [];
  const warnings: string[] = [];
  const loadedPaths = new Set<string>();
  // Ontology IRIs (normalized) of every loaded file -> an import of one of
  // them is already satisfied.
  const loadedIris = new Set<string>();
  // Pending imports: the IRI and the directory of the file that named it.
  const pending: Array<{iri: string; from: string}> = [];

  const load = (file: string, text: string) => {
    const header = parseOwlHeader(text);
    sources.push({path: file, text});
    loadedPaths.add(path.resolve(file));
    if (header.ontologyIri) loadedIris.add(normalizeIri(header.ontologyIri));
    for (const iri of header.imports) pending.push({iri, from: file});
  };

  // Command-line files first, all of them, so an import between two named
  // files is satisfied by (1) regardless of argument order.
  for (const file of files) {
    if (loadedPaths.has(path.resolve(file))) continue;
    load(file, fs.readFileSync(file, 'utf8'));
  }

  const unresolved = new Set<string>();
  while (pending.length) {
    const {iri, from} = pending.shift()!;
    if (loadedIris.has(normalizeIri(iri))) continue;
    let found = false;
    for (const candidate of candidatePaths(iri, path.dirname(from))) {
      if (loadedPaths.has(path.resolve(candidate))) continue;
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        continue;
      }
      const text = fs.readFileSync(candidate, 'utf8');
      const header = parseOwlHeader(text);
      if (!header.ontologyIri ||
          normalizeIri(header.ontologyIri) !== normalizeIri(iri)) {
        continue;
      }
      load(candidate, text);
      found = true;
      break;
    }
    if (!found && !unresolved.has(iri)) {
      unresolved.add(iri);
      warnings.push(
          `owl:imports <${iri}> (in ${from}) did not resolve to a local file ` +
          `declaring that ontology; its terms are not imported. Pass the ` +
          `file on the command line, or place it beside ${
              path.basename(from)} named after the IRI's last segment.`);
    }
  }
  return {sources, warnings};
}
