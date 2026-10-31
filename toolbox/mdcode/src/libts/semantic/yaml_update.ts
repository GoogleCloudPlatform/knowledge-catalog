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
  if (out !== node && yaml.isNode(node)) {
    out.commentBefore = node.commentBefore;
    out.comment = node.comment;
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
  dropSpaceBefore(pairs, node.items[0]);
  node.items = pairs;
  return node;
}

function updatePair(u: Update, pair: yaml.Pair, value: unknown): void {
  if (yaml.isScalar(pair.key)) {
    moveKeyLineComment(pair, pair.key, value);
  }
  pair.value = updateNode(u, value, pair.value);
}

/**
 * Clears the blank line before `items[0]` when it takes the place of `first`.
 * That blank line would print as a line of spaces under the key, or put a
 * list item's first key on the line after its `- `.
 */
function dropSpaceBefore(items: readonly unknown[], first: unknown): void {
  const owner = yaml.isPair(items[0]) ? items[0].key : items[0];
  if (items[0] !== first && yaml.isNode(owner)) owner.spaceBefore = false;
}

/**
 * Moves the comment on `pair`'s key line onto `key` when the value is a block
 * collection, or a scalar that becomes one. The comment above the
 * collection's first item moves onto that item, so it goes or moves with it.
 */
function moveKeyLineComment(
    pair: yaml.Pair, key: yaml.Scalar, value: unknown): void {
  const prev = pair.value;
  if (yaml.isCollection(prev)) {
    const keyLine = keyLineComment(pair);
    const first = prev.items[0];
    const owner = yaml.isPair(first) ? first.key : first;
    const before = prev.commentBefore;
    if (prev.flow || !before || !yaml.isNode(owner)) return;
    const above =
        keyLine === undefined ? before : before.slice(keyLine.length + 1);
    key.comment = keyLine;
    owner.commentBefore =
        [above, owner.commentBefore].filter(c => c).join('\n');
    prev.commentBefore = undefined;
  } else if (yaml.isNode(prev) && isObject(value)) {
    // A scalar that becomes a mapping or list.
    key.comment = prev.comment;
    prev.comment = undefined;
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
  const items = value.map((v, i) => updateNode(u, v, matched[i]));
  dropSpaceBefore(items, node.items[0]);
  node.items = items;
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
