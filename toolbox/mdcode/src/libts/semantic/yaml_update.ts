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
  // spaces or a `- ` alone on its line. A string a YAML 1.1 reader takes for
  // another type, such as `yes`, is quoted, as in every changed part.
  yaml.visit(document, {
    Collection: (_, n) => {
      n.flow = n.items.length === 0;
      const first = n.items[0];
      const owner = yaml.isPair(first) ? first.key : first;
      if (yaml.isNode(owner)) owner.spaceBefore = false;
    },
    Scalar: (_, n) => void delete n.type,
  });
  document.setSchema('1.2', {...YAML_OPTIONS, compat: 'yaml-1.1'});
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
  const pairs: Array<[yaml.Pair, unknown]> = [];
  yaml.visit(doc, {Pair: (_, p, path) => void pairs.push([p, path.at(-1)])});
  const u: Update = {
    text,
    doc,
    links,
    pairs,
    held: new Map(),
    used: new Set(),
    copies: new Map([...links].map(([v, n]) => [n, v])),
    edits: [],
    dirty: new Set(),
    aliases: [],
    nl: /\r?\n/.exec(text)?.[0] ?? '\n',
    ...indents(doc, text),
  };
  hold(u, value, doc.contents);
  patch(u, value, doc.contents, {col: 0, prefix: '', flow: false});
  // An alias whose anchor changed or went is written out.
  for (const [alias, v, slot] of u.aliases) {
    const anchor = alias.resolve(doc) as yaml.Node;
    const [a, b] = anchor.range!;
    if (u.dirty.has(anchor) || u.edits.some(([p, q]) => p < b && q > a)) {
      replace(u, v, alias, slot);
    }
  }
  let out = '';
  let at = 0;
  for (const [from, to, s] of u.edits.sort(
           (a, b) => a[0] - b[0] || a[1] - b[1])) {
    // An edit inside another would write part of the text twice.
    if (from < at) throw new Error(`Overlapping edits at offset ${from}.`);
    out += text.slice(at, from) + s;
    at = to;
  }
  out += text.slice(at);
  // A text with no final newline keeps none.
  return text.endsWith('\n') ? out : out.replace(/\r?\n$/, '');
}

interface Update {
  text: string;
  doc: yaml.Document;
  links: ReadonlyMap<object, yaml.Node>;
  /** Each pair of `doc`, with the mapping that holds it. */
  pairs: ReadonlyArray<[yaml.Pair, unknown]>;
  /**
   * Each node whose text the new value keeps, with the object of the new value
   * that keeps it.
   */
  held: Map<unknown, object>;
  /** The pairs whose text a moved value took. */
  used: Set<yaml.Pair>;
  /** The reverse of `links`. */
  copies: ReadonlyMap<unknown, object>;
  /** Each edit replaces the text from one offset to another. */
  edits: Array<[number, number, string]>;
  /** Nodes whose text changed. */
  dirty: Set<unknown>;
  /** Each alias whose value stays, with that value and where it sits. */
  aliases: Array<[yaml.Alias, unknown, Slot]>;
  nl: string;
  /** Columns from a key to its keys under it, and to its list's `-`. */
  step: number;
  seqIndent: number;
  /** Columns from a `-` to the keys of the mapping after it. */
  itemIndent: number;
  /** The space inside the brackets of the file's flow mappings and lists. */
  pad: {map: string, seq: string};
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

/**
 * Fills `held` for `value` in place of `node`: the node `links` maps each
 * object to, and each mapping or list whose items `patch` keeps.
 */
function hold(u: Update, value: unknown, node: unknown): void {
  if (!isObject(value)) return;
  const linked = u.links.get(value);
  if (linked) u.held.set(linked, value);
  const kept = isFull(value) && yaml.isCollection(node) &&
          Array.isArray(value) === yaml.isSeq(node) ?
      matchItems(u, entriesOf(value), node) :
      [];
  if (kept.some(i => i >= 0)) u.held.set(node, value);
  entriesOf(value).forEach(([, v], i) => {
    const item = yaml.isCollection(node) ? node.items[kept[i] ?? -1] : undefined;
    hold(u, v, yaml.isPair(item) ? item.value : item);
  });
}

function patch(u: Update, value: unknown, node: unknown, slot: Slot): void {
  const edits = u.edits.length;
  if (isFull(value) && yaml.isCollection(node) &&
      Array.isArray(value) === yaml.isSeq(node)) {
    patchItems(u, value, node, slot);
  } else if (yaml.isScalar(node) && !isObject(value)) {
    if (node.value !== value) setScalar(u, node, value, slot);
  } else if (
      yaml.isAlias(node) && canonical(node.toJS(u.doc)) === canonical(value)) {
    u.aliases.push([node, value, slot]);
  } else {
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
  // The kept item each new entry goes after, or -1.
  const follows = at.map((j, i) => j < 0 ? Math.max(-1, ...at.slice(0, i)) : NaN);
  const g = geometry(u, node, flow);
  const col = g[0].start - lineStart(t, g[0].start);
  // In a flow collection whose items each have their lines, removed and new
  // items take whole lines. In any other flow collection, they take the text
  // between items. One choice for both keeps their edits apart.
  const lines = flow && g.every(i => i.ownLines);
  // The text between two items, without its comments. After a lone item that
  // starts its line, a new item starts its own line too.
  const indent = t.slice(lineStart(t, g[0].start), g[0].start);
  const sep = g.length > 1 ?
      t.slice(g[0].end, g[1].start).replace(/[ \t]*#.*/g, '') :
      flow && !indent.trim() ? ',' + u.nl + indent :
                               ', ';
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
    if (lines) {
      u.edits.push([lineStart(t, g[a].start), nextLine(t, g[b].end), '']);
      // The comma after the item that becomes last goes, unless a new entry
      // comes after it.
      const comma = t.indexOf(',', g[a - 1]?.end);
      if (!next && a > 0 && !follows.includes(a - 1)) {
        u.edits.push([comma, comma + 1, '']);
      }
    } else if (flow && next) {
      u.edits.push([g[a].start, next.start, '']);
    } else if (flow) {
      // The comma after the item that becomes last goes, unless a new entry
      // comes after it, and a comment after that comma stays.
      const gap = t.slice(g[a - 1].end, g[a].start);
      const kept = gap.includes('#') ? gap.replace(',', '') : '';
      u.edits.push(
          follows.includes(a - 1) ? [g[a].start, g[b].end, ''] :
                                    [g[a - 1].end, g[b].end, kept]);
    } else if (g[a].inline && next) {
      // The next item moves up onto the `- ` line, and its comments go above
      // that line. A comment indented deeper than that line takes its
      // indentation.
      const above = lineStart(t, g[a].start);
      const own = lineStart(t, next.start);
      const indent = /^[ \t]*/.exec(t.slice(above))![0];
      const comments = t.slice(skipBlank(t, next.head, own), own)
                           .replace(/^[ \t]*(?=#)/gm,
                                    w => w.length > indent.length ? indent : w);
      u.edits.push(
          [above, above, comments], [g[a].start, next.start, '']);
    } else {
      // The blank lines above an old first item stay, and those above the
      // item that becomes first go.
      const first = a === 0 && at[0] >= 0;
      const from = first ? skipBlank(t, g[a].head, g[a].start) : g[a].head;
      const to = first && next ? skipBlank(t, g[b].end, next.start) : g[b].end;
      u.edits.push([from, to, '']);
    }
    a = b;
  }
  // Updates each kept item, and adds each new one after the item before it.
  const added = new Map<number, string[]>();
  entries.forEach(([k, v], i) => {
    const item = items[at[i]];
    if (yaml.isPair(item)) {
      const key = item.key;
      // A key renamed in the document, such as `datasets` to `entities`.
      if (yaml.isScalar(key) && typeof key.value === 'string' &&
          key.source !== key.value) {
        setScalar(u, key, key.value, slotOf(at[i]));
      }
      patch(u, v, item.value, slotOf(at[i]));
    } else if (at[i] >= 0) {
      patch(u, v, item, slotOf(at[i]));
    } else {
      const before = follows[i];
      const key = yaml.isMap(node) ? `${scalarText(u, k, 0, flow)}:` : '-';
      const text = !flow ? block(u, key, v, col, String(k)) :
          yaml.isMap(node) ? [`${key} ${flowValue(u, String(k), v)}`] :
                             [scalarText(u, v, 0, true)];
      added.set(before, [...(added.get(before) ?? []), ...text]);
    }
  });
  for (const [j, parts] of added) {
    const near = g[Math.max(j, 0)];
    if (lines) {
      // Each new item gets a line, indented as the item near it.
      const pad = t.slice(lineStart(t, near.start), near.start);
      const last = !at.some(i => i > j);
      if (last && !/^\s*,/.test(t.slice(near.end))) {
        u.edits.push([near.end, near.end, ',']);
      }
      const pos = j < 0 ? lineStart(t, near.start) : nextLine(t, near.end);
      const text = parts.map(l => pad + l).join(',' + u.nl);
      u.edits.push([pos, pos, text + (last ? '' : ',') + u.nl]);
    } else if (flow) {
      // New items go before the item after the one they follow, so that a
      // comment after the comma stays on its line.
      const text = parts.join(sep);
      const next = g[j + 1];
      const last = !at.some(i => i > j);
      u.edits.push(
          next ? [next.start, next.start, last ? text : text + sep] :
                 [near.end, near.end, sep + text]);
    } else if (j < 0 && near.inline) {
      const text = parts.join(u.nl).slice(col) + u.nl + ' '.repeat(col);
      u.edits.push([near.start, near.start, text]);
    } else {
      const pos = j < 0 ? near.head : near.end;
      const text = parts.join(u.nl);
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
    // An empty value, as in `a:`, ends on its key's line, and so does the item.
    const end = flow ? last.range![1] :
                       blockEnd(t, Math.max(last.range![2], nextLine(t, start)),
                                start - ls);
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
  const t = u.text;
  const [from, end, lead] = rangeOf(u, node);
  // A block scalar that keeps its final line breaks ends in the blank lines
  // after its text. The edit stops before the empty ones, so they stay. A
  // line of spaces can be text, so the edit replaces it.
  let to = end;
  while (/^BLOCK/.test(node.type ?? '') && lineStart(t, to - 1) > from &&
         lineStart(t, to - 1) === lineEnd(t, to - 1)) {
    to = lineStart(t, to - 1);
  }
  const kept = typeof node.value === 'string' && typeof value === 'string';
  const type = kept ? node.type : undefined;
  let s = scalarText(u, value, slot.col, slot.flow, type);
  // A value of several lines in place of a plain or double-quoted scalar is
  // double-quoted. As a block scalar it would take the comment after it into
  // its text. A single-quoted one stays single-quoted.
  if (!/^(BLOCK|QUOTE_SINGLE)/.test(node.type ?? '') && s.includes('\n')) {
    s = scalarText(u, value, slot.col, slot.flow, 'QUOTE_DOUBLE');
  }
  // A block scalar that keeps its final line breaks, as `|+` does, also takes
  // the blank lines after it. It is written with that many fewer, or
  // double-quoted when it ends in fewer.
  let blank = 0;
  for (let p = to; p < t.length && !t.slice(p, nextLine(t, p)).trim();
       p = nextLine(t, p)) {
    blank++;
  }
  const keeps = /^[|>][0-9]*\+/.test(s);
  if (keeps && !s.endsWith(u.nl.repeat(blank))) {
    s = scalarText(u, value, slot.col, slot.flow, 'QUOTE_DOUBLE');
  } else if (keeps && blank > 0) {
    s = s.slice(0, -u.nl.length * blank);
  }
  // The text after a block scalar's header, such as a comment, stays after
  // the new header, or after the new value when it is not a block scalar.
  const tail = headerTail(u.text, from) ?? '';
  s = /^[|>]/.test(s) ? s.replace(/^[|>][-+0-9]*/, h => h + tail) : s + tail;
  s = lead + s;
  u.edits.push([from, to, u.text[to - 1] === '\n' ? s + u.nl : s]);
}

/**
 * Writes `value` in place of `node`. The comment on the line where `node`
 * starts stays on that line.
 */
function replace(u: Update, value: unknown, node: unknown, slot: Slot): void {
  const t = u.text;
  const [from, to, lead] = yaml.isNode(node) && node.range ?
      rangeOf(u, node) :
      [slot.after ?? 0, slot.after ?? 0, ''];
  // A flow collection stays flow.
  if (slot.flow || slot.after === undefined ||
      yaml.isCollection(node) && node.flow && isObject(value)) {
    u.edits.push([from, to, lead + scalarText(u, value, slot.col, true)]);
    return;
  }
  const keyLine = lineEnd(t, slot.after);
  // A block collection's range can run over the comments after it and into
  // the next line's indentation. The comments at its key's column or less
  // stay.
  const stop = blockEnd(t, to, slot.col);
  const end = lineEnd(t, Math.max(from, stop - 1));
  // A scalar on the line under its key becomes a collection there.
  const under = from > keyLine && yaml.isScalar(node) && isFull(value);
  const col = under ? from - lineStart(t, from) : slot.col;
  const [first, ...rest] = under ? items(u, value as object, col) :
                                   block(u, slot.prefix, value, col);
  // The text after the node on its last line stays, or after a block
  // scalar's header unless the scalar's text moved into the new value. A
  // block collection of several lines keeps none.
  const header = headerTail(t, from);
  const moved = u.pairs.some(([p]) => p.value === node && u.used.has(p));
  const after = header !== undefined ? (moved ? '' : header) :
      end === lineEnd(t, from) || !yaml.isCollection(node) || node.flow ?
                                       t.slice(to, end) :
                                       '';
  if (under) {
    u.edits.push([from, end, [first.slice(col) + after, ...rest].join(u.nl)]);
    return;
  }
  const tail = from > keyLine ? t.slice(slot.after, keyLine) : after;
  const head = first.slice(col + slot.prefix.length);
  u.edits.push([slot.after, end, [head + tail, ...rest].join(u.nl)]);
}

/**
 * The lines of `prefix`, a key and `:` or a `-` at column `col`, and `value`
 * after it, in the file's indentation. `key` is the key `prefix` writes. A
 * value that moved keeps its text.
 */
function block(
    u: Update, prefix: string, value: unknown, col: number,
    key?: string): string[] {
  const pad = ' '.repeat(col);
  const moved = prefix.endsWith(':') ? movedText(u, key, value, col) : undefined;
  if (moved) return [pad + prefix + moved[0], ...moved.slice(1)];
  if (!isFull(value)) {
    // A block scalar's header is a line of its own, so that a comment after
    // it stays out of the text.
    const s = scalarText(u, value, col, false);
    const line = `${pad}${prefix} ${s}`;
    return /^[|>]/.test(s) ? line.split(u.nl) : [line];
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
    return block(u, prefix, v, col, String(k));
  });
}

/**
 * The text of the input value that `value` moved from, for `key` at column
 * `col`, or in a flow mapping when `col` is undefined: what follows the key's
 * `:` on its line, then each line under it, re-indented. An object or array
 * moves from the node `links` maps it to. A scalar under `key` moves from a
 * pair with the same key and value whose text the new value does not keep.
 * Undefined when nothing moved, or when the text would not read back as
 * `value` at its new place, as when it holds an alias of an anchor outside it.
 */
function movedText(
    u: Update, key: string|undefined, value: unknown,
    col?: number): string[]|undefined {
  const node = isObject(value) ? u.links.get(value) : undefined;
  const found = u.pairs.find(([p, parent]) => !u.used.has(p) &&
      (node ? p.value === node :
              key !== undefined && keyOf(p) === key && yaml.isScalar(p.value) &&
              p.value.value === value &&
              (u.held.get(parent) as Record<string, unknown>|undefined)?.[key] !==
                  value));
  const p = found?.[0];
  const v = p?.value as yaml.Node|undefined;
  if (!p || !v?.range || !yaml.isNode(p.key)) return undefined;
  const t = u.text;
  const keyCol = p.key.range![0] - lineStart(t, p.key.range![0]);
  const from = v.range[0];
  // The comments after the value at its key's column or less are above the
  // next key.
  const to = blockEnd(t, v.range[1], keyCol);
  const shift = (col ?? 0) - keyCol;
  const own = t.slice(lineStart(t, from), from).trim() === '';
  // A mapping or list on the lines under its key starts on the line after the
  // key, so the comments above its first key or item move with it. The
  // comments above a scalar under its key stay with the key.
  const start = !own ? from :
      yaml.isCollection(v) ? nextLine(t, p.key.range![1]) :
                             lineStart(t, from);
  const stop = t.slice(lineStart(t, to), to).trim() ? to : lineStart(t, to);
  const lines = t.slice(start, stop)
                    .replace(/\r?\n$/, '')
                    .split(/\r?\n/)
                    .map((l, i) => !own && i === 0 || l === '' ? l :
                             shift >= 0 ? ' '.repeat(shift) + l :
                                          l.slice(Math.min(-shift, indentOf(l))));
  // An empty value moves as nothing after the key's `:`.
  const moved = own ? ['', ...lines] :
                      [lines[0] && ' ' + lines[0], ...lines.slice(1)];
  const reads = col === undefined ?
      moved.length === 1 && readsInFlow(moved[0].trim(), value) :
      readsInBlock(
          [' '.repeat(col) + '_:' + moved[0], ...moved.slice(1)].join('\n'),
          value);
  if (!reads) return undefined;
  u.used.add(p);
  return moved;
}

/**
 * `value` under `key` in a flow mapping. A value that moved keeps its text
 * when that is one line that reads the same there.
 */
function flowValue(u: Update, key: string, value: unknown): string {
  return movedText(u, key, value)?.[0].trim() ?? scalarText(u, value, 0, true);
}

/** Whether `text` reads as `value` in a flow collection. */
function readsInFlow(text: string, value: unknown): boolean {
  try {
    return canonical(yaml.parse(`[${text}]`, YAML_OPTIONS)[0]) === canonical(value);
  } catch {
    return false;
  }
}

/**
 * Whether `text`, one key and its value, reads as that key holding `value`.
 * An alias in it must have its anchor in it.
 */
function readsInBlock(text: string, value: unknown): boolean {
  try {
    const read = yaml.parse(text, YAML_OPTIONS);
    return isRecord(read) && canonical(Object.values(read)[0]) === canonical(value);
  } catch {
    return false;
  }
}

/** The number of spaces and tabs that start `line`. */
function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)![0].length;
}

/**
 * `value` written as a scalar or flow collection. Each line after the first
 * that is not empty is indented under column `col`. In a flow collection, a
 * string of several lines is one double-quoted line.
 */
function scalarText(
    u: Update, value: unknown, col: number, flow: boolean,
    type?: yaml.Scalar.Type): string {
  if (flow && isFull(value)) {
    const seq = Array.isArray(value);
    const pad = seq ? u.pad.seq : u.pad.map;
    const parts = entriesOf(value).map(([k, v]) => seq ?
        scalarText(u, v, col, true) :
        `${scalarText(u, k, 0, true)}: ${flowValue(u, String(k), v)}`);
    return `${seq ? '[' : '{'}${pad}${parts.join(', ')}${pad}${seq ? ']' : '}'}`;
  }
  const lines = flow && typeof value === 'string' && value.includes('\n');
  const node = isObject(value) ? value : Object.assign(
      new yaml.Scalar(value), {type: lines ? 'QUOTE_DOUBLE' : type});
  const text = yaml.stringify(flow ? [node] : {_: node}, {
    ...YAML_OPTIONS,
    compat: 'yaml-1.1',
    indent: u.step,
    lineWidth: 0,
    doubleQuotedMinMultiLineLength: flow ? Infinity : undefined,
    flowCollectionPadding: false,
    collectionStyle: flow ? 'flow' : 'any',
  });
  return (flow ? text.slice(1, -2) : text.slice(3, -1))
      .split('\n')
      .map((line, i) => i > 0 && line ? ' '.repeat(col) + line : line)
      .join(u.nl);
}

/**
 * The indentation of the file's first nested mapping, list and list item, and
 * the space after the bracket of its first flow mapping and flow list whose
 * first item is on the bracket's line.
 */
function indents(doc: yaml.Document, text: string):
    Pick<Update, 'step'|'seqIndent'|'itemIndent'|'pad'> {
  const col = (p: number) => p - lineStart(text, p);
  const found: Partial<Record<'step'|'seqIndent'|'itemIndent', number>> = {};
  const pad: Partial<Update['pad']> = {};
  yaml.visit(doc, {
    Collection: (_, v) => {
      const first = v.items[0];
      const at = (yaml.isPair(first) ? first.key : first) as yaml.Node|undefined;
      const gap = v.flow && v.range && at?.range ?
          text.slice(v.range[0] + 1, at.range[0]) :
          '\n';
      if (!gap.includes('\n')) pad[yaml.isMap(v) ? 'map' : 'seq'] ??= gap;
    },
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
  return {step: 2, seqIndent: 2, itemIndent: 2, ...found, pad: {map: '', seq: '', ...pad}};
}

/** The offset of each `-` of a block list. */
function dashes(node: yaml.YAMLMap|yaml.YAMLSeq): number[] {
  return ((node.srcToken as yaml.CST.BlockSequence)?.items ?? [])
      .flatMap(it => it.start.filter(s => s.type === 'seq-item-ind'))
      .map(s => s.offset);
}

/**
 * Where the text of `node` starts and ends, and the text that a value written
 * there starts with. An empty scalar, such as the value of `a:  # c`, starts
 * right after the `:`, `-`, anchor or tag before it, and also takes the spaces
 * after that when no comment follows. A value written there starts with a
 * space.
 */
function rangeOf(u: Update, node: yaml.Node): [number, number, string] {
  const [from, to] = node.range!;
  if (from !== to || !yaml.isScalar(node)) return [from, to, ''];
  let p = from;
  while (p > 0 && /[ \t]/.test(u.text[p - 1])) p--;
  return [p, u.text[from] === '#' ? p : from, ' '];
}

/**
 * The text on its line after the header of the block scalar at `from`, or
 * undefined when no block scalar starts there.
 */
function headerTail(t: string, from: number): string|undefined {
  return /^[|>][-+0-9]*(.*)/.exec(t.slice(from, lineEnd(t, from)))?.[1];
}

function lineStart(t: string, p: number): number {
  return t.lastIndexOf('\n', p - 1) + 1;
}

/** The offset where the text of the line holding `p` ends. */
function lineEnd(t: string, p: number): number {
  const i = t.indexOf('\n', p);
  const e = i < 0 ? t.length : i;
  return t[e - 1] === '\r' ? e - 1 : e;
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
