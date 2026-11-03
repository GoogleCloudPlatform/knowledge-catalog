// Changes the text of a YAML document to hold a new value. Each part whose
// value stays comes back byte for byte, and a changed part is written in the
// file's indentation and line endings.

import * as yaml from 'yaml';

import {isRecord} from './loader';
import {YAML_OPTIONS} from './yaml_options';

/**
 * Parses `text` for `updateText`. A JSON file, which is one flow mapping, is
 * first rewritten as block YAML, which the returned `text` holds.
 */
export function parseForUpdate(text: string):
    {document: yaml.Document.Parsed, text: string} {
  const parse = (t: string) =>
      yaml.parseDocument(t, {...YAML_OPTIONS, keepSourceTokens: true});
  const document = parse(text);
  const root = document.contents;
  if (document.errors.length > 0 || !yaml.isMap(root) || !root.flow) {
    return {document, text};
  }
  // An empty list or mapping stays `[]` or `{}`. A blank line before a
  // collection's first item is dropped, since it would print as a line of
  // spaces or a `- ` alone on its line.
  yaml.visit(document, {
    Collection: (_, n) => {
      n.flow = n.items.length === 0;
      const first = n.items[0];
      const owner = yaml.isPair(first) ? first.key : first;
      if (yaml.isNode(owner)) owner.spaceBefore = false;
    },
    Scalar: (_, n) => void delete n.type,
  });
  const yamlText = document.toString({lineWidth: 0});
  return {document: parse(yamlText), text: yamlText};
}

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
 * Returns `text`, which `doc` parses, changed to hold `value`. An object or
 * array keeps the node `links` maps it to, and any other value keeps the node
 * under the same key, or the list item with the same `name` or value. A kept
 * node whose value stays keeps its text and the comments and blank lines
 * around it. A changed scalar keeps its quoting, and a removed item takes its
 * comments and the blank lines above it.
 */
export function updateText(
    text: string, doc: yaml.Document, value: unknown,
    links: ReadonlyMap<object, yaml.Node>): string {
  const u: Update = {
    text,
    doc,
    links,
    copies: new Map([...links].map(([v, n]) => [n, v])),
    edits: [],
    dirty: new Set(),
    nl: /\r?\n/.exec(text)?.[0] ?? '\n',
    ...indents(doc, text),
  };
  patch(u, value, doc.contents, {col: 0, prefix: '', flow: false});
  let out = '';
  let at = 0;
  for (const [from, to, s] of u.edits.sort(
           (a, b) => a[0] - b[0] || a[1] - b[1])) {
    out += text.slice(at, from) + s;
    at = to;
  }
  return out + text.slice(at);
}

interface Update {
  text: string;
  doc: yaml.Document;
  links: ReadonlyMap<object, yaml.Node>;
  /** The reverse of `links`. */
  copies: ReadonlyMap<unknown, object>;
  /** Each edit replaces the text from one offset to another. */
  edits: Array<[number, number, string]>;
  /** Nodes whose text changed. An alias of one is written out. */
  dirty: Set<unknown>;
  nl: string;
  /** Columns from a key to its keys under it, and to its list's `-`. */
  step: number;
  seqIndent: number;
  /** Columns from a `-` to the keys of the mapping after it. */
  itemIndent: number;
}

/** Where a node sits in the text. */
interface Slot {
  /** The column of the key or `-` that holds the node. */
  col: number;
  /** `:` after a key, or `-`. */
  prefix: string;
  /** The offset after that `:` or `-`. Unset for the root. */
  after?: number;
  /** Whether the node is inside a flow collection. */
  flow: boolean;
}

function patch(u: Update, value: unknown, node: unknown, slot: Slot): void {
  const edits = u.edits.length;
  if (isFull(value) && yaml.isCollection(node) &&
      Array.isArray(value) === yaml.isSeq(node)) {
    patchItems(u, value, node, slot);
  } else if (yaml.isScalar(node) && !isObject(value)) {
    if (node.value !== value) setScalar(u, node, value, slot);
  } else if (
      !yaml.isAlias(node) || u.dirty.has(node.resolve(u.doc)) ||
      canonical(node.toJS(u.doc)) !== canonical(value)) {
    replace(u, value, node, slot);
  }
  if (u.edits.length > edits) u.dirty.add(node);
}

/** Where an item of a collection sits in the text. */
interface Item {
  /** The offset of its key or `-`. */
  start: number;
  /** The offset after its value. In a block collection, a line's start. */
  end: number;
  /** The offset of the comments and blank lines above it. */
  head: number;
  /** Whether it follows a `-` on its line. */
  inline: boolean;
  /** Whether a flow item has its lines to itself, but for a `,` and comment. */
  ownLines: boolean;
}

function patchItems(
    u: Update, value: object, node: yaml.YAMLMap|yaml.YAMLSeq,
    slot: Slot): void {
  const t = u.text;
  const flow = slot.flow || !!node.flow;
  const items = node.items as unknown[];
  const entries = entriesOf(value);
  const at = matchItems(u, entries, node);
  if (at.every(i => i < 0)) return replace(u, value, node, slot);
  const g = geometry(u, node, flow);
  const col = g[0].start - lineStart(t, g[0].start);
  const slotOf = (i: number): Slot => {
    const item = items[i];
    const sep = yaml.isPair(item) ?
        item.srcToken?.sep?.find(s => s.type === 'map-value-ind')?.offset :
        g[i].start;
    const prefix = yaml.isPair(item) ? ':' : '-';
    return {col, prefix, after: sep === undefined ? sep : sep + 1, flow};
  };
  // Removes each run of items no entry keeps.
  for (let a = 0; a < items.length; a++) {
    if (at.includes(a)) continue;
    let b = a;
    while (b + 1 < items.length && !at.includes(b + 1)) b++;
    const next = g[b + 1];
    if (flow && g.slice(a, b + 1).every(i => i.ownLines)) {
      u.edits.push([lineStart(t, g[a].start), nextLine(t, g[b].end), '']);
      const comma = t.indexOf(',', g[a - 1]?.end);
      if (!next && a > 0) u.edits.push([comma, comma + 1, '']);
    } else if (flow) {
      u.edits.push(
          next ? [g[a].start, next.start, ''] : [g[a - 1].end, g[b].end, '']);
    } else if (g[a].inline && next) {
      // The next item moves up onto the `- ` line, and its comments go above
      // that line, indented as it is.
      const above = lineStart(t, g[a].start);
      const own = lineStart(t, next.start);
      const indent = /^[ \t]*/.exec(t.slice(above))![0];
      const comments = t.slice(skipBlank(t, next.head, own), own)
                           .replace(/^[ \t]*(?=#)/gm, indent);
      u.edits.push(
          [above, above, comments], [g[a].start, next.start, '']);
    } else {
      // A new first item drops the blank lines above it.
      const to = a === 0 && next && at[0] >= 0 ?
          skipBlank(t, g[b].end, next.start) :
          g[b].end;
      u.edits.push([g[a].head, to, '']);
    }
    a = b;
  }
  // Updates each kept item, and adds each new one after the item before it.
  const added = new Map<number, string[]>();
  entries.forEach(([k, v], i) => {
    const item = items[at[i]];
    if (yaml.isPair(item)) {
      const key = item.key;
      if (yaml.isScalar(key) && key.source !== String(key.value)) {
        setScalar(u, key, key.value, slotOf(at[i]));
      }
      patch(u, v, item.value, slotOf(at[i]));
    } else if (at[i] >= 0) {
      patch(u, v, item, slotOf(at[i]));
    } else {
      const before = Math.max(-1, ...at.slice(0, i));
      const key = yaml.isMap(node) ? `${scalarText(u, k, 0, flow)}:` : '-';
      const lines = !flow ? block(u, key, v, col) :
          [`${yaml.isMap(node) ? `${key} ` : ''}${scalarText(u, v, 0, true)}`];
      added.set(before, [...(added.get(before) ?? []), ...lines]);
    }
  });
  for (const [j, lines] of added) {
    const near = g[Math.max(j, 0)];
    if (flow && near.ownLines) {
      // Each new item gets a line, indented as the item near it.
      const pad = t.slice(lineStart(t, near.start), near.start);
      const last = j === g.length - 1;
      if (last && !/^\s*,/.test(t.slice(near.end))) {
        u.edits.push([near.end, near.end, ',']);
      }
      const pos = j < 0 ? lineStart(t, near.start) : nextLine(t, near.end);
      const text = lines.map(l => pad + l).join(',' + u.nl);
      u.edits.push([pos, pos, text + (last ? '' : ',') + u.nl]);
    } else if (flow) {
      const sep = g.length > 1 ? t.slice(g[0].end, g[1].start) : ', ';
      const text = lines.join(sep);
      u.edits.push(
          j < 0 ? [near.start, near.start, text + sep] :
                  [near.end, near.end, sep + text]);
    } else if (j < 0 && near.inline) {
      const text = lines.join(u.nl).slice(col) + u.nl + ' '.repeat(col);
      u.edits.push([near.start, near.start, text]);
    } else {
      const pos = j < 0 ? near.head : near.end;
      const text = lines.join(u.nl);
      u.edits.push(
          pos === t.length && !t.endsWith('\n') ? [pos, pos, u.nl + text] :
                                                  [pos, pos, text + u.nl]);
    }
  }
}

/**
 * For each of `entries`, the index of the item of `node` it keeps, or -1. A
 * mapping's entry keeps the pair with its key. A list's entry keeps the item
 * `links` maps it to, or else a free item with the same `name` or value, and
 * the kept items stay in their order.
 */
function matchItems(
    u: Update, entries: Array<[string|number, unknown]>,
    node: yaml.YAMLMap|yaml.YAMLSeq): number[] {
  const items = node.items as unknown[];
  if (yaml.isMap(node)) {
    return entries.map(([k]) => node.items.findIndex(p => keyOf(p) === k));
  }
  const at = entries.map(([, v]) => {
    const linked = isObject(v) ? u.links.get(v) : undefined;
    return linked ? items.indexOf(linked) : -2;
  });
  const free = items.flatMap((n, j) => at.includes(j) ?
      [] :
      [{j, key: itemKey(u.copies.get(n) ?? (n as yaml.Node).toJS(u.doc))}]);
  let last = -1;
  return at.map((j, i) => {
    if (j === -2) {
      const f = free.findIndex(f => f.key === itemKey(entries[i][1]));
      j = f < 0 ? -1 : free.splice(f, 1)[0].j;
    }
    if (j >= 0 && j < last) return -1;
    last = Math.max(last, j);
    return j;
  });
}

function geometry(
    u: Update, node: yaml.YAMLMap|yaml.YAMLSeq, flow: boolean): Item[] {
  const t = u.text;
  const dash = flow ? [] : dashes(node);
  let prevEnd = 0;
  return (node.items as unknown[]).map((item, i) => {
    const first = (yaml.isPair(item) ? item.key : item) as yaml.Node;
    const last =
        (yaml.isPair(item) ? item.value ?? item.key : item) as yaml.Node;
    const start = yaml.isPair(item) || flow ? first.range![0] : dash[i];
    const ls = lineStart(t, start);
    const inline = !flow && t.slice(ls, start).trim() !== '';
    const end = flow ? last.range![1] : blockEnd(t, last.range![2], start - ls);
    // The root's first item owns no comments: those above it are the file's.
    const floor = i > 0 ? prevEnd : node === u.doc.contents ? ls : 0;
    let head = inline || flow ? start : ls;
    while (head > floor &&
           /^[ \t]*(#.*)?\r?\n$/.test(t.slice(lineStart(t, head - 1), head))) {
      head = lineStart(t, head - 1);
    }
    prevEnd = end;
    const ownLines = flow && t.slice(ls, start).trim() === '' &&
        /^\s*,?\s*(#.*)?$/.test(t.slice(end, lineEnd(t, end)));
    return {start, end, head, inline, ownLines};
  });
}

/**
 * Where a block item at column `col` ends, given where its node ends: at a
 * line's start, before the comments under it at its column or less, since
 * those are above the next item.
 */
function blockEnd(t: string, end: number, col: number): number {
  if (t.slice(lineStart(t, end), end).trim() === '') end = lineStart(t, end);
  let p = end;
  let cut = false;
  for (let q = lineStart(t, p - 1); p > 0; p = q, q = lineStart(t, p - 1)) {
    const line = t.slice(q, p);
    if (line.trim() && (!/^\s*#/.test(line) || line.search(/\S/) > col)) break;
    cut ||= line.trim() !== '';
  }
  return cut ? p : end;
}

function setScalar(
    u: Update, node: yaml.Scalar, value: unknown, slot: Slot): void {
  const [from, to] = node.range!;
  const kept = typeof node.value === 'string' && typeof value === 'string';
  const type = kept ? node.type : undefined;
  let s = scalarText(u, value, slot.col, slot.flow, type);
  // A value of several lines in place of a one-line scalar is one quoted
  // line, so the comment after it stays on its line.
  if (!/^BLOCK/.test(node.type ?? '') && s.includes('\n')) {
    s = scalarText(u, value, slot.col, slot.flow, 'QUOTE_DOUBLE');
  }
  u.edits.push([from, to, u.text[to - 1] === '\n' ? s + u.nl : s]);
}

/**
 * Writes `value` in place of `node`. The comment on the line where `node`
 * starts stays on that line.
 */
function replace(u: Update, value: unknown, node: unknown, slot: Slot): void {
  const t = u.text;
  const [from, to] = yaml.isNode(node) && node.range ?
      node.range :
      [slot.after ?? 0, slot.after ?? 0];
  if (slot.flow || slot.after === undefined) {
    u.edits.push([from, to, scalarText(u, value, slot.col, true)]);
    return;
  }
  const keyLine = lineEnd(t, slot.after);
  const end = lineEnd(t, Math.max(from, to - 1));
  const oneLine = end === lineEnd(t, from);
  if (from > keyLine && yaml.isScalar(node) && isFull(value) && oneLine) {
    // A scalar on the line under its key becomes a collection there.
    const col = from - lineStart(t, from);
    const [first, ...rest] = items(u, value, col);
    const text = [first.slice(col) + t.slice(to, end), ...rest].join(u.nl);
    u.edits.push([from, end, text]);
    return;
  }
  const header = yaml.isScalar(node) && /^[|>][-+0-9]*/.exec(t.slice(from));
  const tail = from > keyLine ? t.slice(slot.after, keyLine) :
      oneLine                 ? t.slice(to, end) :
      header ? t.slice(from + header[0].length, lineEnd(t, from)) :
               '';
  const [first, ...rest] = block(u, slot.prefix, value, slot.col);
  const head = first.slice(slot.col + slot.prefix.length);
  u.edits.push([slot.after, end, [head + tail, ...rest].join(u.nl)]);
}

/**
 * The lines of `prefix`, a key and `:` or a `-` at column `col`, and `value`
 * after it, in the file's indentation.
 */
function block(
    u: Update, prefix: string, value: unknown, col: number): string[] {
  const pad = ' '.repeat(col);
  if (!isFull(value)) {
    return [`${pad}${prefix} ${scalarText(u, value, col, false)}`];
  }
  if (prefix === '-' && isRecord(value)) {
    const [first, ...rest] = items(u, value, col + u.itemIndent);
    return [pad + '-' + first.slice(col + 1), ...rest];
  }
  const nested =
      prefix === '-' ? 2 : Array.isArray(value) ? u.seqIndent : u.step;
  return [pad + prefix, ...items(u, value, col + nested)];
}

/** The lines of each item of the collection `value`, at column `col`. */
function items(u: Update, value: object, col: number): string[] {
  return entriesOf(value).flatMap(([k, v]) => {
    const prefix =
        Array.isArray(value) ? '-' : `${scalarText(u, k, 0, false)}:`;
    return block(u, prefix, v, col);
  });
}

/**
 * `value` written as a scalar or flow collection. The lines of a block
 * scalar after the first are indented under column `col`.
 */
function scalarText(
    u: Update, value: unknown, col: number, flow: boolean,
    type?: yaml.Scalar.Type): string {
  const node =
      isObject(value) ? value : Object.assign(new yaml.Scalar(value), {type});
  const text = yaml.stringify(flow ? [node] : {_: node}, {
    ...YAML_OPTIONS,
    compat: 'yaml-1.1',
    indent: u.step,
    lineWidth: 0,
    flowCollectionPadding: false,
    collectionStyle: flow ? 'flow' : 'any',
  });
  return (flow ? text.slice(1, -2) : text.slice(3, -1))
      .split('\n')
      .join(u.nl + ' '.repeat(col));
}

/** The indentation of the file's first nested mapping, list and list item. */
function indents(doc: yaml.Document, text: string):
    Pick<Update, 'step'|'seqIndent'|'itemIndent'> {
  const col = (p: number) => p - lineStart(text, p);
  const found: Partial<Record<'step'|'seqIndent'|'itemIndent', number>> = {};
  yaml.visit(doc, {
    Pair: (_, {key, value: v}) => {
      if (!yaml.isNode(key) || !yaml.isCollection(v) || v.flow ||
          v.items.length === 0) {
        return;
      }
      const first = v.items[0];
      const at = yaml.isPair(first) ? (first.key as yaml.Node).range![0] :
                                      dashes(v)[0];
      found[yaml.isMap(v) ? 'step' : 'seqIndent'] ??=
          col(at) - col(key.range![0]);
      if (yaml.isMap(first) && !first.flow && first.items[0]) {
        found.itemIndent ??=
            col((first.items[0].key as yaml.Node).range![0]) - col(at);
      }
    },
  });
  return {step: 2, seqIndent: 2, itemIndent: 2, ...found};
}

/** The offset of each `-` of a block list. */
function dashes(node: yaml.YAMLMap|yaml.YAMLSeq): number[] {
  return ((node.srcToken as yaml.CST.BlockSequence)?.items ?? [])
      .flatMap(it => it.start.filter(s => s.type === 'seq-item-ind'))
      .map(s => s.offset);
}

function lineStart(t: string, p: number): number {
  return t.lastIndexOf('\n', p - 1) + 1;
}

/** The offset where the text of the line holding `p` ends. */
function lineEnd(t: string, p: number): number {
  const i = t.indexOf('\n', p);
  const e = i < 0 ? t.length : i;
  return t[e - 1] === '\r' && e - 1 >= p ? e - 1 : e;
}

/** The offset of the line after the one holding `p`. */
function nextLine(t: string, p: number): number {
  return t.indexOf('\n', p) + 1 || t.length;
}

/** The offset of the first line from `p` that is not blank, up to `limit`. */
function skipBlank(t: string, p: number, limit: number): number {
  while (p < limit && t.slice(p, nextLine(t, p)).trim() === '') {
    p = nextLine(t, p);
  }
  return p;
}

function keyOf(pair: yaml.Pair): string {
  const key = yaml.isScalar(pair.key) ? pair.key.value : pair.key;
  return key === null ? '' : String(key);
}

function entriesOf(value: object): Array<[string|number, unknown]> {
  return Array.isArray(value) ?
      value.map((v, i) => [i, v]) :
      Object.entries(value).filter(([, v]) => v !== undefined);
}

function isFull(value: unknown): value is object {
  return isObject(value) && entriesOf(value).length > 0;
}

function itemKey(value: unknown): string {
  return isRecord(value) && typeof value.name === 'string' ?
      `name:${value.name}` :
      canonical(value);
}

/** `value` as JSON text with each mapping's keys sorted. */
function canonical(value: unknown): string {
  const sorted = (_: string, v: unknown) => isRecord(v) ?
      Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) :
      v;
  return JSON.stringify(value, sorted) ?? 'undefined';
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
