// Which physical table an entity is bound to.
//
// A binding profile gives an entity a `source`, and every caller that touches
// real rows has to turn that string into a table name: the DDL generator
// naming an input table, the runtime building a statement, the agent tool
// derivation describing what a lookup reads. They must agree, so the rule
// lives in one place rather than in each of them.
//
// This is a binding concern, not a Spanner one. It sits outside the deploy
// path deliberately -- `runtime/` reads it, and a runtime that had to import a
// DDL generator to learn a table name would be describing a layering that is
// not real.

import {quoteIdentifier} from './sql_identifiers';


// Maps the IR's `dataSource` to the BARE Spanner table name the graph
// references. A property graph names input tables within its own database, so
// only the final segment of a qualified `project.dataset.table` (or any dotted
// source) is meaningful; the leading qualifiers name where a BigQuery copy
// lives and have no bearing on the Spanner table. A resource-name URI
// (`//spanner.googleapis.com/.../tables/<t>`, or any other `scheme://.../<t>`)
// names its table by the final PATH segment for the same reason — the leading
// path locates the store, not the table. A verbatim query (contains whitespace)
// cannot back a graph element table, so it is passed through parenthesized with
// a warning.
export function spannerTable(
    dataSource: string, warnings: string[], context: string): string {
  const trimmed = (dataSource ?? '').trim();
  if (!trimmed) {
    warnings.push(
        `${context}: empty data source; the table reference will be invalid`);
    return quoteIdentifier('');
  }
  if (/\s/.test(trimmed)) {
    warnings.push(
        `${context}: data source '${
            trimmed}' looks like a query, not a table reference; ` +
        `emitting it verbatim (a graph element table requires a table)`);
    return `(${trimmed})`;
  }
  // A BigQuery resource URI is rewritten to `project.dataset.table` upstream in
  // the loader, but a Spanner-native (or other `scheme://`) URI is kept
  // verbatim there, so reduce it to its final path segment here before the
  // dotted reduction below.
  const source = isResourceUri(trimmed) ? finalPathSegment(trimmed) : trimmed;
  const last = splitDotted(source).map(unquote).pop() ?? source;
  return quoteIdentifier(last);
}


// A Google Cloud resource name (`//host/...`) or any `scheme://...` URI, as
// opposed to a bare or dotted table reference. Mirrors the loader's source
// parsing so the two agree on what counts as a URI.
function isResourceUri(source: string): boolean {
  return source.startsWith('//') || /^[a-z][\w+.-]*:\/\//i.test(source);
}


// The final non-empty path segment of a URI (`.../tables/Customer` →
// `Customer`).
function finalPathSegment(uri: string): string {
  const segments = uri.split('/').filter(s => s.length > 0);
  return segments.pop() ?? uri;
}


// Splits a dotted source into its segments, treating a backtick- or
// double-quote-delimited segment as opaque so a dot INSIDE quotes does not
// split an identifier: `proj.ds.`weird.name`` yields ['proj', 'ds',
// '`weird.name`'], not a spurious break inside the quoted table name.
function splitDotted(source: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string|null = null;
  for (const ch of source) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '`' || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === '.') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}


function unquote(part: string): string {
  return part.replace(/^[`"]/, '').replace(/[`"]$/, '');
}
