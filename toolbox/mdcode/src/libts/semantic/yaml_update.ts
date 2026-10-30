// Changes a parsed YAML document in place to hold a new value, so the text it
// gives keeps the comments, blank lines, quoting, flow style and key order of
// every part that survives.

import * as yaml from 'yaml';

import {isRecord} from './loader';

/**
 * Maps each object and array in `value` to the node it was copied from.
 * `value` must be a plain copy of `node`.
 */
export function linkNodes(
    value: unknown, node: unknown,
    links = new Map<object, yaml.Node>()): Map<object, yaml.Node> {
  if (Array.isArray(value) && yaml.isSeq(node)) {
    links.set(value, node);
    value.forEach((v, i) => linkNodes(v, node.items[i], links));
  } else if (isRecord(value) && yaml.isMap(node)) {
    links.set(value, node);
    for (const pair of node.items) {
      if (yaml.isScalar(pair.key)) {
        linkNodes(value[keyOf(pair)], pair.value, links);
      }
    }
  }
  return links;
}

/**
 * Changes `doc` in place to hold `value`, keeping each node whose value
 * survives with its comments, and moving a replaced node's comments onto its
 * replacement. An object or array keeps the node `links` maps it to, and any
 * other value keeps the node under the same key, or the list item with the
 * same `name` or the same value.
 */
export function updateDocument(
    doc: yaml.Document, value: unknown,
    links: ReadonlyMap<object, yaml.Node>): void {
  const claimed = new Set<yaml.Node>();
  const claim = (v: unknown) => {
    if (!isObject(v)) return;
    const node = links.get(v);
    if (node) claimed.add(node);
    Object.values(v).forEach(claim);
  };
  claim(value);
  const copies = new Map([...links].map(([v, n]) => [n, v]));
  doc.contents = updateNode({doc, links, claimed, copies}, value, doc.contents);
}

interface Update {
  doc: yaml.Document;
  links: ReadonlyMap<object, yaml.Node>;
  /**
   * Nodes linked to an object of the new value. Only that object keeps them.
   */
  claimed: ReadonlySet<unknown>;
  /** The reverse of `links`. */
  copies: ReadonlyMap<unknown, object>;
}

function updateNode(u: Update, value: unknown, prev: unknown): yaml.Node {
  const linked = isObject(value) ? u.links.get(value) : undefined;
  const node = linked ?? (u.claimed.has(prev) ? undefined : prev);
  let out: yaml.Node;
  if (Array.isArray(value)) {
    out = updateSeq(u, value, yaml.isSeq(node) ? node : new yaml.YAMLSeq());
  } else if (isRecord(value)) {
    out = updateMap(u, value, yaml.isMap(node) ? node : new yaml.YAMLMap());
  } else if (yaml.isScalar(node)) {
    node.value = value;
    out = node;
  } else {
    out = u.doc.createNode(value);
  }
  // A value written in a new shape keeps the comments of the one it replaces.
  // A comment after a scalar or alias goes above the mapping or list that
  // replaces it.
  if (out !== node && yaml.isNode(node)) {
    const moved = !yaml.isCollection(node) && yaml.isCollection(out);
    out.commentBefore = moved ?
        [node.commentBefore, node.comment].filter(c => c).join('\n') :
        node.commentBefore;
    if (!moved) out.comment = node.comment;
  }
  return out;
}

function updateMap(
    u: Update, value: Record<string, unknown>,
    node: yaml.YAMLMap): yaml.YAMLMap {
  const wanted = Object.entries(value).filter(([, v]) => v !== undefined);
  const keys = new Set(wanted.map(([k]) => k));
  const pairs = node.items.filter(p => keys.has(keyOf(p)));
  let at = -1;
  for (const [key, v] of wanted) {
    let i = pairs.findIndex(p => keyOf(p) === key);
    if (i < 0) {
      i = at + 1;
      pairs.splice(i, 0, new yaml.Pair(u.doc.createNode(key)));
    }
    updatePair(u, pairs[i], v);
    at = i;
  }
  node.items = pairs;
  return node;
}

function updatePair(u: Update, pair: yaml.Pair, value: unknown): void {
  const prev = pair.value;
  const first = yaml.isCollection(prev) ? prev.items[0] : undefined;
  pair.value = updateNode(u, value, prev);
  // The library keeps the comment above a mapping's or list's first item on
  // the collection, after any comment on the key's line. When that item goes,
  // only the key's comment stays.
  if (first !== undefined && yaml.isCollection(prev) && pair.value === prev &&
      !(prev.items as unknown[]).includes(first)) {
    prev.commentBefore = keyLineComment(pair);
  }
}

function updateSeq(
    u: Update, value: unknown[], node: yaml.YAMLSeq): yaml.YAMLSeq {
  const matched = value.map(v => isObject(v) ? u.links.get(v) : undefined);
  const free = node.items.map(n => {
    const copy = u.copies.get(n) ?? (yaml.isNode(n) ? n.toJSON() : n);
    return {n, key: itemKey(copy)};
  });
  value.forEach((v, i) => {
    if (matched[i]) return;
    const j = free.findIndex(f => f.key === itemKey(v));
    if (j >= 0) matched[i] = free.splice(j, 1)[0].n as yaml.Node;
  });
  node.items = value.map((v, i) => updateNode(u, v, matched[i]));
  return node;
}

/** The comment on the line of `pair`'s key, as the parser read it. */
function keyLineComment(pair: yaml.Pair): string|undefined {
  const sep = pair.srcToken?.sep ?? [];
  const newline = sep.findIndex(t => t.type === 'newline');
  const line = newline < 0 ? sep : sep.slice(0, newline);
  return line.find(t => t.type === 'comment')?.source.slice(1);
}

function keyOf(pair: yaml.Pair): string {
  const key = yaml.isScalar(pair.key) ? pair.key.value : pair.key;
  return key === null ? '' : String(key);
}

function itemKey(value: unknown): string|undefined {
  return isRecord(value) && typeof value.name === 'string' ?
      `name:${value.name}` :
      JSON.stringify(value);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
