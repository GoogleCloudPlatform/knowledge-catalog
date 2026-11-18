// Changes the text of a YAML document to hold a new value. Each part whose
// value stays comes back byte for byte, and a changed part is written in the
// file's indentation and line endings. A changed block scalar keeps the
// indentation of its lines.

import * as yaml from 'yaml';

import {isGoogleVendor, isRecord} from './loader';
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
 * The node each alias of `doc` names: the last node above it with its anchor,
 * or undefined when there is none.
 */
export function aliasNodes(doc: yaml.Document):
    Map<yaml.Alias, yaml.Node|undefined> {
  const named = new Map<yaml.Alias, yaml.Node|undefined>();
  const anchors = new Map<string, yaml.Node>();
  yaml.visit(doc, {
    Node: (_, n) => {
      if (yaml.isAlias(n)) named.set(n, anchors.get(n.source));
      else if (n.anchor) anchors.set(n.anchor, n);
    },
  });
  return named;
}

/**
 * Returns `text`, which `doc` parses, changed to hold `value`. An object or
 * array keeps the node `links` maps it to, and any other value keeps the node
 * under the same key, or the list item with the same key (see `itemKeys`). A
 * kept node whose value stays keeps its text and the comments and blank lines
 * around it. A changed scalar keeps its quoting, and a removed item takes its
 * comments and the blank lines above it. A flow collection over several lines
 * that changes is written again in block style. A value that would be written
 * as a block scalar that keeps its final line breaks, as `|+` does, is
 * double-quoted instead, and so is a string that comes to hold a character
 * that YAML writes only as an escape, such as DEL. The JSON `data` of a GOOGLE
 * block written as a quoted string over several lines that changes is written
 * on one line as compact JSON, quoted as kcmd quotes a new block. Each edit it
 * makes to `text`, which replaces the text from one offset to another, is
 * added to `edits` in offset order.
 */
export function updateText(
    text: string, doc: yaml.Document, value: unknown,
    links: ReadonlyMap<object, yaml.Node>,
    edits: Array<[number, number, string]> = []): string {
  const u: Update = {
    text,
    doc,
    links,
    ...pairsIndexed(doc),
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
  // The anchor and tag of the root are in the tokens of its document.
  const root = doc.contents;
  const document = yaml.isNode(root) && (root.anchor || root.tag) ?
      [...new yaml.Parser().parse(text)].find(t => t.type === 'document') :
      undefined;
  const marks = (document as yaml.CST.Document|undefined)?.start.filter(
      s => MARKS.includes(s.type));
  patch(u, value, root, {col: 0, prefix: '', flow: false, props: marks});
  // An alias whose anchor changed or went is written out. The text of the
  // value or key it names starts at its anchor or tag.
  const props = new Map<unknown, yaml.CST.SourceToken[]>();
  if (u.aliases.length) {
    yaml.visit(doc, {
      Collection: (_, n) => itemProps(n).forEach((p, i) => {
        const item = n.items[i];
        props.set(yaml.isPair(item) ? item.value : item, p);
      }),
      Pair: (_, p) => {
        const marks = p.srcToken?.start.filter(
            s => s.type === 'anchor' || s.type === 'tag');
        if (marks?.length && p.key) props.set(p.key, marks);
      },
    });
  }
  const named = u.aliases.length ? aliasNodes(doc) : new Map();
  for (const [alias, v, slot] of u.aliases) {
    const anchor = named.get(alias) as yaml.Node;
    const a = props.get(anchor)?.[0]?.offset ?? anchor.range![0];
    const b = anchor.range![1];
    if (u.dirty.has(anchor) || u.edits.some(([p, q]) => p < b && q > a)) {
      replace(u, v, alias, slot);
    }
  }
  // An alias that names another node in the new text, or none, is written
  // out too, as when moved text defines its anchor's name again between the
  // alias and its anchor. A value written fresh holds no anchor, so every
  // other alias still names the same node.
  let [made, out] = composed(u);
  const misread = misreadAliases(u, named, made, out);
  if (misread.length) {
    u.fresh = true;
    for (const [alias, v, slot] of misread) replace(u, v, alias, slot);
    [made, out] = composed(u);
  }
  edits.push(...made);
  return out;
}

/**
 * The edits `u.edits` gives, in offset order, and the text they make of
 * `u.text`.
 */
function composed(u: Update): [Array<[number, number, string]>, string] {
  const text = u.text;
  // The empty lines after a block scalar that keeps its final line breaks, as
  // `|+` does, are its text. An edit that removes the text right after one
  // whose text stays also removes the blank lines it would leave there.
  const ends = new Set<number>();
  yaml.visit(u.doc, {
    Scalar: (_, n) => {
      const [a, b] = n.range!;
      if (keepsBreaks(text, n) && !u.edits.some(([p, q]) => p < b && q > a)) {
        ends.add(b);
      }
    },
  });
  // An insertion that falls inside a span another edit removes goes where
  // that span starts.
  const removed = u.edits.filter(([a, b, s]) => !s && a < b);
  const placed = u.edits.map(([a, b, s]): [number, number, string] => {
    const span = a === b && s ? removed.find(([p, q]) => p < a && a < q) : undefined;
    return span ? [span[0], span[0], s] : [a, b, s];
  });
  const made = placed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  made.forEach(([from, to, s], i) => {
    const [p, q, inserted] = made[i - 1] ?? [];
    if (s || !ends.has(from) || p === from && q === from && inserted) return;
    made[i][1] = skipBlank(text, to, made[i + 1]?.[0] ?? text.length);
    ends.add(made[i][1]);
  });
  const out = spliced(text, made);
  // A text with no final newline keeps none, unless the text of a block scalar
  // that keeps its final line breaks reaches its end.
  return [
    made,
    text.endsWith('\n') || ends.has(text.length) ? out :
                                                   out.replace(/\r?\n$/, ''),
  ];
}

/**
 * The aliases of `u.aliases` whose text stays and that name another node in
 * `out` than in `u.text`, or none. `named` gives the node each alias of
 * `u.doc` names (see aliasNodes), and the edits `made` give `out`.
 */
function misreadAliases(
    u: Update, named: ReadonlyMap<yaml.Alias, yaml.Node|undefined>,
    made: ReadonlyArray<[number, number, string]>,
    out: string): Update['aliases'] {
  const kept = u.aliases.filter(([alias]) => {
    const [a, b] = alias.range!;
    return !u.edits.some(([p, q]) => p < b && q > a);
  });
  if (!kept.length) return [];
  // The node each alias of `out` names, by the offset of the alias.
  const outNamed = new Map(
      [...aliasNodes(yaml.parseDocument(out, YAML_OPTIONS))].map(
          ([alias, node]) => [alias.range![0], node]));
  // The offset in `out` of an offset of `u.text` inside no edit. Text inserted
  // at the offset goes before it, unless `empty` is set. An empty node, such
  // as the value of `a: &x`, has no text, and the writer inserts text at its
  // offset only after the item it ends.
  const moved = (at: number, empty = false) => made.reduce(
      (s, [p, q, t]) =>
          q < at || q === at && !(empty && p === at) ? s + t.length - (q - p) : s,
      at);
  // An alias whose anchor changed or went is already written out. So the node
  // each kept alias names keeps its text, and starts where its start in
  // `u.text` moves to.
  return kept.filter(([alias]) => {
    const [a, b] = (named.get(alias) as yaml.Node).range!;
    return outNamed.get(moved(alias.range![0]))?.range![0] !== moved(a, a === b);
  });
}

interface Update {
  text: string;
  doc: yaml.Document;
  links: ReadonlyMap<object, yaml.Node>;
  /** The pairs of `doc` by their value node, each with its mapping. */
  byValue: ReadonlyMap<unknown, ReadonlyArray<[yaml.Pair, unknown]>>;
  /**
   * The pairs of `doc` whose value is a scalar, by their key and value (see
   * scalarKey), each with its mapping.
   */
  byScalar: ReadonlyMap<string, ReadonlyArray<[yaml.Pair, unknown]>>;
  /**
   * Each node whose text the new value keeps, with the object of the new value
   * that keeps it.
   */
  held: Map<unknown, object>;
  /** The pairs whose text a moved value took. */
  used: Set<yaml.Pair>;
  /** A scalar whose text may move into the value written in its place. */
  replacing?: unknown;
  /** Whether a value written now takes no text from the input. */
  fresh?: boolean;
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
  /** Whether a mapping in a list starts on the line after its `-`. */
  itemAlone: boolean;
  /** The space inside the brackets of the file's flow mappings and lists. */
  pad: {map: string, seq: string};
}

/** Where a node sits in the text. */
interface Slot {
  /** The column of the key or `-` that holds the node. */
  col: number;
  /** `:` after a key, or `-`. */
  prefix: string;
  /**
   * The offset after that `:` or `-`, or after a key written with no `:`.
   * Unset for the root.
   */
  after?: number;
  /** Whether the node is inside a flow collection. */
  flow: boolean;
  /** The anchor and tag tokens of the node. */
  props?: yaml.CST.SourceToken[];
}

/**
 * Fills `held` for `value` in place of `node`: the node `links` maps each
 * object to, and each mapping or list whose items `patch` keeps. The value
 * that keeps a node's items in place holds it.
 */
function hold(u: Update, value: unknown, node: unknown): void {
  if (!isObject(value)) return;
  const linked = u.links.get(value);
  if (linked && !u.held.has(linked)) u.held.set(linked, value);
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
  // A key written with no value, as `b` in `{a: 1, b}`, has no value node.
  // Its text stays while its value stays null.
  if (node === null && value === null) return;
  const edits = u.edits.length;
  // A flow collection over several lines is written again in block style
  // when its value changes. It keeps its text when its value stays, even when
  // a linked item in it moved, since the text reads as the value. One with a
  // key that is not a scalar, such as an alias, is patched item by item
  // instead.
  const lines = yaml.isCollection(node) && node.flow && spansLines(u.text, node);
  const stays = lines && canonical(node.toJS(u.doc)) === canonical(value);
  if (lines && !stays) {
    replace(u, value, node, slot);
  } else if (stays && scalarKeys(node as yaml.Node)) {
    keep(u, value, node as yaml.YAMLMap|yaml.YAMLSeq);
  } else if (
      isFull(value) && yaml.isCollection(node) &&
      Array.isArray(value) === yaml.isSeq(node)) {
    patchItems(u, value, node, slot);
  } else if (yaml.isScalar(node) && !isObject(value)) {
    if (!Object.is(node.value, value)) setScalar(u, node, value, slot);
  } else if (
      isObject(value) && !isFull(value) && yaml.isCollection(node) &&
      node.items.length === 0 && Array.isArray(value) === yaml.isSeq(node)) {
    // An empty list or mapping that stays empty keeps its text.
  } else if (
      yaml.isAlias(node) && canonical(node.toJS(u.doc)) === canonical(value)) {
    u.aliases.push([node, value, slot]);
  } else {
    replace(u, value, node, slot);
  }
  if (u.edits.length > edits) u.dirty.add(node);
}

/**
 * Keeps the text of `node`, which reads as `value`. A key in it that the
 * document renames is written again, and each alias in it is recorded with
 * its value, so that the alias is written out when its anchor changes.
 */
function keep(
    u: Update, value: unknown, node: yaml.YAMLMap|yaml.YAMLSeq): void {
  (node.items as unknown[]).forEach((item, i) => {
    const pair = yaml.isPair(item) ? item : undefined;
    if (pair && yaml.isScalar(pair.key) && typeof pair.key.value === 'string' &&
        pair.key.source !== pair.key.value) {
      setScalar(u, pair.key, pair.key.value, {col: 0, prefix: ':', flow: true});
    }
    const n = pair ? pair.value : item;
    const v = pair ? (value as Record<string, unknown>)[keyOf(pair)] :
                     (value as unknown[])[i];
    if (yaml.isAlias(n)) {
      u.aliases.push(
          [n, v, {col: 0, prefix: '', after: n.range![0], flow: true}]);
    } else if (yaml.isCollection(n)) {
      keep(u, v, n);
    }
  });
}

/** Whether each key of each mapping in `node` is a scalar. */
function scalarKeys(node: yaml.Node): boolean {
  let scalar = true;
  yaml.visit(node, {Pair: (_, p) => void (scalar &&= yaml.isScalar(p.key))});
  return scalar;
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
}

function patchItems(
    u: Update, value: object, node: yaml.YAMLMap|yaml.YAMLSeq,
    slot: Slot): void {
  const t = u.text;
  const flow = slot.flow || !!node.flow;
  const items = node.items as unknown[];
  const entries = entriesOf(value);
  const at = matchItems(u, entries, node);
  // A pair written as a flow list item, as `a: 1` in `[a: 1]`, has no braces,
  // so it is written again with them when it comes to hold more than one.
  if (at.every(i => i < 0) ||
      yaml.isMap(node) && flow && node.srcToken?.type !== 'flow-collection' &&
          entries.length > 1) {
    return replace(u, value, node, slot);
  }
  // The kept item each new entry goes after, or -1.
  const follows = at.map((j, i) => j < 0 ? Math.max(-1, ...at.slice(0, i)) : NaN);
  const g = geometry(u, node, flow);
  const col = g[0].start - lineStart(t, g[0].start);
  // The text between two items.
  const sep = g.length > 1 ? t.slice(g[0].end, g[1].start) : ', ';
  const props = itemProps(node);
  const slotOf = (i: number): Slot => {
    const item = items[i];
    const sep = yaml.isPair(item) ?
        item.srcToken?.sep?.find(s => s.type === 'map-value-ind')?.offset :
        g[i].start;
    const prefix = yaml.isPair(item) ? ':' : '-';
    // A key written with no `:`, as `b` in `{a: 1, b}`, has its slot right
    // after it.
    const after = sep !== undefined ? sep + 1 :
        ((item as yaml.Pair).key as yaml.Node).range![1];
    return {col, prefix, after, flow, props: props[i]};
  };
  // Removes each run of items no entry keeps.
  for (let a = 0; a < items.length; a++) {
    if (at.includes(a)) continue;
    let b = a;
    while (b + 1 < items.length && !at.includes(b + 1)) b++;
    const next = g[b + 1];
    if (flow && next) {
      u.edits.push([g[a].start, next.start, '']);
    } else if (flow) {
      // The comma after the item that becomes last goes, unless a new entry
      // comes after it.
      u.edits.push(
          [follows.includes(a - 1) ? g[a].start : g[a - 1].end, g[b].end, '']);
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
      // The anchor and tag of the slot are its value's, so the key leaves
      // them as they are.
      if (yaml.isScalar(key) && typeof key.value === 'string' &&
          key.source !== key.value) {
        setScalar(u, key, key.value, {...slotOf(at[i]), props: undefined});
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
    if (flow) {
      // New items go before the item after the one they follow.
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
 * `links` maps it to, or else a free item with the same key (see `itemKeys`),
 * and the kept items stay in their order.
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
  const js = items.map(n => u.copies.get(n) ?? (n as yaml.Node).toJS(u.doc));
  const free =
      itemKeys(js).flatMap((key, j) => at.includes(j) ? [] : [{j, key}]);
  const keys = itemKeys(entries.map(([, v]) => v));
  let last = -1;
  return at.map((j, i) => {
    if (j === -2) {
      const f = free.findIndex(f => f.key === keys[i]);
      j = f < 0 ? -1 : free.splice(f, 1)[0].j;
    }
    if (j >= 0 && j < last) return -1;
    last = Math.max(last, j);
    return j;
  });
}

function geometry(
    u: Pick<Update, 'text'|'doc'>, node: yaml.YAMLMap|yaml.YAMLSeq,
    flow: boolean): Item[] {
  const t = u.text;
  const starts = itemStarts(node);
  let prevEnd = 0;
  return (node.items as unknown[]).map((item, i) => {
    const last =
        (yaml.isPair(item) ? item.value ?? item.key : item) as yaml.Node;
    const start = starts[i];
    const ls = lineStart(t, start);
    const inline = !flow && t.slice(ls, start).trim() !== '';
    const end = flow ? last.range![1] :
                       blockEnd(t, Math.max(last.range![2], nextLine(t, start)),
                                start - ls, last);
    // The root's first item owns no comments: those above it are the file's.
    const floor = i > 0 ? prevEnd : node === u.doc.contents ? ls : 0;
    let head = inline || flow ? start : ls;
    while (head > floor &&
           /^[ \t]*(#.*)?\r?\n$/.test(t.slice(lineStart(t, head - 1), head))) {
      head = lineStart(t, head - 1);
    }
    prevEnd = end;
    return {start, end, head, inline};
  });
}

/**
 * Where a block item at column `col` ends, given where its `node` ends: at a
 * line's start, before the blank lines and the comments at its column or less
 * under it, since those are above the next item. When `node` ends in a block
 * scalar, the lines of that scalar's text stay in the item, such as the empty
 * lines that end a `|+` block scalar.
 */
function blockEnd(t: string, end: number, col: number, node?: unknown): number {
  // An empty value, as in `a:`, ends at the line break after it.
  if (end === lineEnd(t, end)) end = nextLine(t, end);
  if (t.slice(lineStart(t, end), end).trim() === '') end = lineStart(t, end);
  let last = node;
  while (yaml.isCollection(last) && last.items.length > 0) {
    const item = last.items.at(-1);
    last = yaml.isPair(item) ? item.value : item;
  }
  const floor = yaml.isScalar(last) && /^BLOCK/.test(last.type ?? '') ?
      lineStart(t, last.range![1]) :
      0;
  let p = end;
  for (let q = lineStart(t, p - 1); p > floor; p = q, q = lineStart(t, p - 1)) {
    const line = t.slice(q, lineEnd(t, q));
    if (line.trim() && (!/^\s*#/.test(line) || line.search(/\S/) > col)) break;
  }
  return p;
}

function setScalar(
    u: Update, node: yaml.Scalar, value: unknown, slot: Slot): void {
  const [from, to, lead] = rangeOf(u, node);
  const kept = typeof node.value === 'string' && typeof value === 'string';
  const type = kept ? node.type : undefined;
  // A double-quoted string that writes its line breaks as `\n` escapes on one
  // line, as PyYAML does, keeps writing them so.
  const written = u.text.slice(node.range![0], node.range![1]);
  const escaped = type === 'QUOTE_DOUBLE' && written.includes('\\n') &&
      !written.includes('\n');
  // A block scalar written again keeps the indentation of its lines of text,
  // and a header that sets that indentation keeps setting it. An indentation
  // indicator stops at 9, so a block more than 9 columns deeper than its key
  // that comes to need one is double-quoted.
  const indent = blockIndent(u.text, node, slot.col);
  const step = indent === undefined ? 0 : indent - slot.col;
  // The JSON `data` of a GOOGLE block written as a quoted string over several
  // lines is written on one line as compact JSON, quoted as kcmd quotes a new
  // block. Only the whitespace outside its JSON strings goes, so its numbers,
  // escapes and key order stay as written.
  const compact = /^QUOTE/.test(type ?? '') && written.includes('\n') &&
      isGoogleData(u, node) && isJson(node.value) && isJson(value);
  let s = compact ?
      scalarText(u, compactJson(value), slot.col, slot.flow) :
      scalarText(
          step >= 1 ? {...u, step} : u, value, slot.col, slot.flow, type,
          escaped);
  // A value of several lines in place of a plain or double-quoted scalar is
  // double-quoted. As a block scalar it would take the comment after it into
  // its text. A single-quoted one stays single-quoted.
  if (!/^(BLOCK|QUOTE_SINGLE)/.test(node.type ?? '') && s.includes('\n')) {
    s = scalarText(u, value, slot.col, slot.flow, 'QUOTE_DOUBLE');
  }
  // The digit stays on the side of the chomping indicator it was written on.
  const head = (t: string) => /^[|>][-+0-9]*/.exec(t)?.[0] ?? '';
  const digit = /[1-9]/.exec(head(written))?.[0];
  if (head(s) && digit) {
    const chomp = /[-+]/.exec(head(s))?.[0] ?? '';
    s = s[0] + (/^.[-+]/.test(head(written)) ? chomp + digit : digit + chomp) +
        s.slice(head(s).length);
  }
  // The text after a block scalar's header, such as a comment, stays after
  // the new header, or after the new value when it is not a block scalar.
  const tail = headerTail(u.text, from) ?? '';
  s = /^[|>]/.test(s) ? s.replace(/^[|>][-+0-9]*/, h => h + tail) : s + tail;
  // A tag stays when the new text reads back as the value under it. The
  // read-back puts the text at the column of its key or `-`, which a block
  // scalar's indentation indicator counts from, and takes the file's
  // directives, since a `%TAG` shorthand needs them. A tag of YAML's core
  // schema must read it back with no warning. The parser warns about any
  // other tag, whose meaning kcmd cannot check, so that warning is ignored.
  const tag = (slot.props ?? []).filter(t => t.type === 'tag');
  const directives = u.doc.directives?.toString(u.doc);
  const typed = tag.length > 0 &&
      readsInBlock(
          (directives ? `${directives}\n---\n` : '') +
              `${' '.repeat(slot.col)}_: ${tag[0].source} ${s}`,
          value, CORE_TAGS.has(node.tag ?? ''));
  const {start, cuts} =
      propsOut(u.text, tag.length && !typed ? tag : [], from, slot);
  s = (start < from ? '' : lead) + s;
  u.edits.push(...cuts, [start, to, u.text[to - 1] === '\n' ? s + u.nl : s]);
}

/**
 * Writes `value` in place of `node`, its anchor and its tag (see propsOut).
 * The comment on the line where `node` starts stays on that line, and so does
 * a comment after an anchor or tag, except on the lines between a key and a
 * block collection under it, which go with the collection.
 */
function replace(u: Update, value: unknown, node: unknown, slot: Slot): void {
  const t = u.text;
  // A key written with no `:` has no value node, so the value goes after a
  // new `:`. In a block mapping, where such a key follows `?`, that `:` starts
  // a line under the `?`, after the line that holds the key's last character.
  if (node === null && slot.after !== undefined) {
    const at = slot.flow ? slot.after : lineEnd(t, slot.after - 1);
    u.edits.push([at, at, slot.flow ?
        `${slot.prefix} ${scalarText(u, value, slot.col, true)}` :
        u.nl + block(u, slot.prefix, value, slot.col).join(u.nl)]);
    return;
  }
  const [from, to, lead] = yaml.isNode(node) && node.range ?
      rangeOf(u, node) :
      [slot.after ?? 0, slot.after ?? 0, ''];
  // An alias of the anchor is written out (see updateText).
  const {start, keyEnd, cuts} = propsOut(t, slot.props ?? [], from, slot);
  const keyLine = slot.flow || slot.after === undefined ?
      -1 :
      lineEnd(t, slot.after);
  // A flow collection on one line stays flow.
  if (slot.flow || slot.after === undefined ||
      yaml.isCollection(node) && node.flow && isObject(value) &&
          !spansLines(u.text, node)) {
    // The text of a block value ends with its line break, which stays.
    const s = (start < from ? '' : lead) + scalarText(u, value, slot.col, true);
    u.edits.push(...cuts, [start, to, t[to - 1] === '\n' ? s + u.nl : s]);
    return;
  }
  // A block collection's range can run over the comments after it and into
  // the next line's indentation. The comments at its key's column or less
  // stay.
  const stop = blockEnd(t, to, slot.col, node);
  const end = lineEnd(t, Math.max(from, stop - 1));
  // A scalar, alias or flow collection on the line under its key is replaced
  // there, so the comments above it and after it stay.
  const under = from > keyLine && (!yaml.isCollection(node) || node.flow);
  const col = under && isFull(value) ? start - lineStart(t, start) : slot.col;
  // A scalar under a key the document renames moves its text into the value
  // written in its place, when that value holds it.
  const pair = u.byValue.get(node)?.[0]?.[0];
  if (pair && yaml.isScalar(pair.key) && pair.key.source !== pair.key.value) {
    u.replacing = node;
  }
  const [first, ...rest] = under && isFull(value) ?
      items(u, value as object, col) :
      block(u, slot.prefix, value, col);
  u.replacing = undefined;
  // The text after the node on its last line stays, or after a block
  // scalar's header unless the scalar's text moved into the new value. A
  // block collection of several lines keeps none.
  const header = headerTail(t, from);
  const moved = (u.byValue.get(node) ?? []).some(([p]) => u.used.has(p));
  const after = header !== undefined ? (moved ? '' : header) :
      end === lineEnd(t, from) || !yaml.isCollection(node) || node.flow ?
                                       t.slice(to, end) :
                                       '';
  if (under) u.edits.push(...cuts);
  if (under && !isFull(value)) {
    // As a block scalar, text of several lines would take the text after it.
    const type = typeof value === 'string' && value.includes('\n') ?
        'QUOTE_DOUBLE' :
        undefined;
    u.edits.push(
        [start, end, scalarText(u, value, slot.col, false, type) + after]);
    return;
  }
  if (under) {
    u.edits.push([start, end, [first.slice(col) + after, ...rest].join(u.nl)]);
    return;
  }
  const tail = from > keyLine ? t.slice(keyEnd, keyLine) : after;
  const head = first.slice(col + slot.prefix.length);
  u.edits.push([slot.after, end, [head + tail, ...rest].join(u.nl)]);
}

/**
 * The edits that take the anchor and tag tokens `tokens` out of the text of
 * the value at `from` in `slot`, and where the value's own edit starts. Each
 * line's tokens go together, with the spaces after them up to the next token
 * or the value. When the value follows them, its edit starts where they do,
 * as for an empty value right after them. When the end of the line or a
 * comment follows them, the value is on a later line. Then they go with the
 * spaces before them instead, and with spaces that end the line, so a comment
 * stays where it was. Tokens that start their line leave a comment after them
 * in their place, and take a line with nothing else on it. Otherwise a cut
 * never takes the text before its tokens, such as the separator before a flow
 * list item, which another edit may take. `keyEnd` is where the tokens on the
 * line of the key or `-` end, or that line's end when only spaces follow
 * them, or the slot's `after` when none are there.
 */
function propsOut(
    t: string, tokens: yaml.CST.SourceToken[], from: number, slot: Slot):
    {start: number, keyEnd?: number, cuts: Array<[number, number, string]>} {
  const keyLine = slot.flow || slot.after === undefined ?
      -1 :
      lineEnd(t, slot.after);
  const own = lineStart(t, from);
  const last = tokens.filter(s => s.offset < own && s.offset < keyLine).at(-1);
  let keyEnd = last ? last.offset + last.source.length : slot.after;
  if (last && !t.slice(keyEnd, keyLine).trim()) keyEnd = keyLine;
  const runs: Array<[number, number]> = [];
  for (const s of tokens) {
    const run = runs.at(-1);
    const end = s.offset + s.source.length;
    if (run && lineStart(t, run[0]) === lineStart(t, s.offset)) run[1] = end;
    else runs.push([s.offset, end]);
  }
  let start = from;
  const cuts: Array<[number, number, string]> = [];
  for (const [a, end] of runs) {
    const ls = lineStart(t, a);
    let [pre, b] = [a, end];
    while (/[ \t]/.test(t[pre - 1] ?? '')) pre--;
    while (/[ \t]/.test(t[b] ?? '')) b++;
    const eol = b === lineEnd(t, b);
    if (end <= from && from <= b) {
      start = a;
    } else if (pre > ls && (eol || t[b] === '#')) {
      cuts.push([pre, eol ? b : end, '']);
    } else if (eol) {
      cuts.push([ls, nextLine(t, a), '']);
    } else {
      cuts.push([a, b, '']);
    }
  }
  return {start, keyEnd, cuts};
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
    const s = scalarText(u, value, col, false);
    // A block scalar's header is a line of its own, so that a comment after
    // it stays out of the text.
    const line = `${pad}${prefix} ${s}`;
    return /^[|>]/.test(s) ? line.split(u.nl) : [line];
  }
  if (prefix === '-' && isRecord(value)) {
    const lines = items(u, value, col + u.itemIndent);
    // In a file whose items start on the line after their '-', so do new ones.
    if (u.itemAlone) return [pad + '-', ...lines];
    const [first, ...rest] = lines;
    return [pad + '-' + first.slice(col + 1), ...rest];
  }
  const nested =
      prefix === '-' ? 2 : Array.isArray(value) ? u.seqIndent : u.step;
  return [pad + prefix, ...items(u, value, col + nested)];
}

/** The lines of each item of the collection `value`, at column `col`. */
function items(u: Update, value: object, col: number): string[] {
  release(u, value);
  return entriesOf(value).flatMap(([k, v]) => {
    const prefix =
        Array.isArray(value) ? '-' : `${scalarText(u, k, 0, false)}:`;
    return block(u, prefix, v, col, String(k));
  });
}

/**
 * Lets the entries of `value`, which is written entry by entry, move from the
 * node `links` maps it to, unless another value keeps that node in place.
 */
function release(u: Update, value: object): void {
  const node = u.links.get(value);
  if (u.held.get(node) === value) u.held.delete(node);
}

/**
 * The text of the input value that `value` moved from, for `key` at column
 * `col`, or in a flow mapping when `col` is undefined: what follows the key's
 * `:` on its line, then each line under it, re-indented. An object or array
 * moves from the node `links` maps it to, unless another value keeps that
 * node in place. A scalar under `key` moves from a
 * pair with the same key and value whose text the new value does not keep,
 * or from the scalar `replacing` names, when it has that value.
 * Undefined while `fresh` is set, when nothing moved, or when the text would
 * not read back as `value` at its new place, as when it holds an alias of an
 * anchor outside it.
 * A value that is or holds a block scalar that keeps its final line breaks,
 * as `|+` does, is written fresh, since its text would take the blank lines
 * after its new place.
 */
function movedText(
    u: Update, key: string|undefined, value: unknown,
    col?: number): string[]|undefined {
  if (u.fresh) return undefined;
  const node = isObject(value) ? u.links.get(value) : undefined;
  const candidates = node ? u.byValue.get(node) : [
    ...(u.byValue.get(u.replacing) ?? []),
    ...(key !== undefined ? u.byScalar.get(scalarKey(key, value)) ?? [] : []),
  ];
  const found = candidates?.find(([p, parent]) => !u.used.has(p) &&
      (node ? p.value === node && u.held.get(node) === value :
              yaml.isScalar(p.value) && p.value.value === value &&
              (p.value === u.replacing ||
               key !== undefined && keyOf(p) === key &&
               (u.held.get(parent) as Record<string, unknown>|undefined)?.[key] !==
                   value)));
  const p = found?.[0];
  const v = p?.value as yaml.Node|undefined;
  if (!p || !v?.range || !yaml.isNode(p.key) || keeps(u, v)) return undefined;
  const t = u.text;
  const keyCol = pairStart(p) - lineStart(t, pairStart(p));
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
                    .map((l, i) => !own && i === 0 ? l : shiftedLine(l, shift));
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

/**
 * Whether `text` reads as `value` as the value of a key in a flow mapping.
 * An empty text does not count, so that the key gets a value written after
 * its `:` instead of nothing.
 */
function readsInFlow(text: string, value: unknown): boolean {
  try {
    return text !== '' &&
        canonical(yaml.parse(`{_: ${text}}`, YAML_OPTIONS)) ===
        canonical({_: value});
  } catch {
    return false;
  }
}

/**
 * Whether `text`, one key and its value, reads as that key holding `value`.
 * An alias in it must have its anchor in it. With `clean`, a text the parser
 * warns about does not read as `value`.
 */
function readsInBlock(text: string, value: unknown, clean = false): boolean {
  try {
    const read = yaml.parse(text, YAML_OPTIONS);
    return isRecord(read) &&
        canonical(Object.values(read)[0]) === canonical(value) &&
        !(clean && yaml.parseDocument(text, YAML_OPTIONS).warnings.length);
  } catch {
    return false;
  }
}

/** Whether the text of `node`, in `text`, spans lines. */
export function spansLines(text: string, node: yaml.Node): boolean {
  return text.slice(node.range![0], node.range![1]).includes('\n');
}

/**
 * `text` with each of `edits` made: each replaces the text from one offset to
 * another. Edits are made in offset order. At one offset, an insertion comes
 * before a replacement, and two insertions keep the order given. Throws when
 * two overlap, since one would write part of the text twice.
 */
export function spliced(
    text: string, edits: ReadonlyArray<readonly [number, number, string]>):
    string {
  let out = '';
  let at = 0;
  for (const [from, to, s] of [...edits].sort(
           (a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (from < at) throw new Error(`Overlapping edits at offset ${from}.`);
    out += text.slice(at, from) + s;
    at = to;
  }
  return out + text.slice(at);
}

/**
 * `text`, which `doc` parses and whose root is a block mapping, with each root
 * key but `kept` moved, with the lines under it, into a mapping that is the
 * one item of a new list under `key`, in the file's list style. Each moved
 * line keeps its text and moves by the same number of columns, so comments,
 * blank lines and block scalars stay as written. The comments above the first
 * moved key stay above `key`. A `kept` key after it moves above `key`, with
 * the comments above it.
 */
export function wrappedRoot(
    text: string, doc: yaml.Document.Parsed, key: string,
    kept: string): string {
  const root = doc.contents as yaml.YAMLMap;
  const g = geometry({text, doc}, root, false);
  const {seqIndent, itemIndent, itemAlone} = indents(doc, text);
  const nl = /\r?\n/.exec(text)?.[0] ?? '\n';
  const at = lineStart(text, g[root.items.findIndex(p => keyOf(p) !== kept)].start);
  const col = g[0].start - lineStart(text, g[0].start);
  const above: string[] = [];
  const edits: Array<[number, number, string]> = [];
  root.items.forEach((p, i) => {
    if (keyOf(p) !== kept || g[i].head < at) return;
    const lines = text.slice(g[i].head, g[i].end);
    above.push(lines.endsWith('\n') ? lines : lines + nl);
    edits.push([g[i].head - at, g[i].end - at, '']);
  });
  const lines = shifted(spliced(text.slice(at), edits), seqIndent + itemIndent)
                    .split('\n');
  // The first moved key goes after the `-` of the new item.
  const dash = ' '.repeat(col + seqIndent) + '-';
  lines[0] = itemAlone ? dash + nl + lines[0] :
                         dash + lines[0].slice(col + seqIndent + 1);
  return text.slice(0, at) + above.join('') + ' '.repeat(col) + key + ':' + nl +
      lines.join('\n');
}

/**
 * `text`, which `doc` parses, with the items of the block list under `key` in
 * each of the block mappings `sources` moved, in order, to the end of the
 * block list under `key` in the block mapping `target`, which gets the key
 * last when it has none. A `key` of `target` with no value, as in `metrics:`
 * with only a comment, or with an empty flow list takes the items as its
 * list. Each source's `key` goes, and the comments above it and on its line
 * go above its first item. The items keep their comments and their text, each
 * line moved by the same number of columns. An empty flow list under a
 * source's `key` goes with it. Undefined for any other value under `key`, for
 * a source that holds `key` alone, and for a source that writes `key` as
 * something other than a scalar, such as an alias.
 */
export function movedItems(
    text: string, doc: yaml.Document.Parsed, sources: yaml.YAMLMap[],
    target: yaml.YAMLMap, key: string): string|undefined {
  const nl = /\r?\n/.exec(text)?.[0] ?? '\n';
  const blockList = (v: unknown): v is yaml.YAMLSeq =>
      yaml.isSeq(v) && !v.flow && v.items.length > 0;
  const index = target.items.findIndex(p => keyOf(p) === key);
  const own = target.items[index]?.value;
  const empty = yaml.isScalar(own) && own.value === null ||
      yaml.isSeq(own) && own.flow && !own.items.length;
  if (target.flow || own !== undefined && !empty && !blockList(own)) {
    return undefined;
  }
  const column = (p: number) => p - lineStart(text, p);
  const keyCol = column(pairStart(target.items[0]));
  const to = blockList(own) ? dashes(own)[0] - lineStart(text, dashes(own)[0]) :
                              keyCol + indents(doc, text).seqIndent;
  const edits: Array<[number, number, string]> = [];
  let moved = '';
  for (const source of sources) {
    const i = source.items.findIndex(p => keyOf(p) === key);
    const pair = source.items[i];
    if (i < 0 || source.flow || source.items.length < 2) return undefined;
    const {head, start, end} = geometry({text, doc}, source, false)[i];
    edits.push([head, end, '']);
    if (yaml.isSeq(pair.value) && pair.value.flow && !pair.value.items.length) {
      continue;
    }
    if (!blockList(pair.value)) return undefined;
    const keyEnd = (pair.key as yaml.Node).range![1];
    const comment = /\s(#.*)$/.exec(text.slice(keyEnd, lineEnd(text, keyEnd)));
    const items = geometry({text, doc}, pair.value, false);
    moved += text.slice(head, lineStart(text, start))
                 .replace(/^[ \t]*(?=#)/gm, ' '.repeat(to)) +
        (comment ? ' '.repeat(to) + comment[1] + nl : '') +
        shifted(text.slice(items[0].head, end),
                to - (dashes(pair.value)[0] - lineStart(text, items[0].start)));
  }
  if (moved) {
    // An empty flow list under `key` goes, with the spaces before it.
    if (yaml.isSeq(own) && own.flow) {
      let from = own.range![0];
      while (/[ \t]/.test(text[from - 1])) from--;
      edits.push([from, own.range![1], '']);
    }
    const at = blockList(own) ?
        geometry({text, doc}, own, false).at(-1)!.end :
        geometry({text, doc}, target, false).at(empty ? index : -1)!.end;
    // The text before `at` once a removal that ends there is made.
    const before = edits.find(([, end]) => end === at)?.[0] ?? at;
    const lead = before > 0 && text[before - 1] !== '\n' ? nl : '';
    edits.push([at, at, lead + (own ? '' : ' '.repeat(keyCol) + key + ':' + nl) +
                         (moved.endsWith('\n') ? moved : moved + nl)]);
  }
  return spliced(text, edits);
}

// The tags of YAML's core schema.
const CORE_TAGS = new Set(['str', 'int', 'float', 'bool', 'null', 'map', 'seq']
                              .map(t => `tag:yaml.org,2002:${t}`));

/**
 * The value of `node`, a node of `doc`, as compact JSON, with each mapping's
 * keys in the order written. A number keeps its text when that is a JSON
 * number, such as `1.50`. Undefined when JSON cannot hold the value: a key
 * that is not a scalar, two keys JSON writes alike, a number such as `.inf`,
 * or a value with a tag outside YAML's core schema.
 */
export function nodeJson(node: unknown, doc: yaml.Document): string|undefined {
  const n = yaml.isAlias(node) ? node.resolve(doc) : node;
  if (yaml.isNode(n) && n.tag && !CORE_TAGS.has(n.tag)) return undefined;
  if (yaml.isMap(n)) {
    const keys = new Set<string>();
    const parts: string[] = [];
    for (const p of n.items) {
      const k = yaml.isAlias(p.key) ? p.key.resolve(doc) : p.key;
      if (!yaml.isScalar(k) || k.tag && !CORE_TAGS.has(k.tag)) return undefined;
      const key = typeof k.value === 'string' ?
          k.value :
          (k as yaml.Scalar.Parsed).source ?? String(k.value);
      const value = nodeJson(p.value, doc);
      if (keys.has(key) || value === undefined) return undefined;
      keys.add(key);
      parts.push(`${JSON.stringify(key)}:${value}`);
    }
    return `{${parts.join(',')}}`;
  }
  if (yaml.isSeq(n)) {
    const items = n.items.map(v => nodeJson(v, doc));
    return items.includes(undefined) ? undefined : `[${items.join(',')}]`;
  }
  const value = yaml.isScalar(n) ? n.value : null;
  if (typeof value !== 'number') return JSON.stringify(value);
  const text = (n as yaml.Scalar.Parsed).source;
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(text)) return text;
  return Number.isFinite(value) ? JSON.stringify(value) : undefined;
}

/** `text` with each line moved as shiftedLine moves it. */
function shifted(text: string, shift: number): string {
  return text.split('\n').map(l => shiftedLine(l, shift)).join('\n');
}

/**
 * `line` moved `shift` columns right, or left as far as its indentation
 * allows. An empty line stays empty.
 */
function shiftedLine(line: string, shift: number): string {
  return line === '' || line === '\r' ? line :
      shift >= 0 ? ' '.repeat(shift) + line :
                   line.slice(Math.min(-shift, indentOf(line)));
}

/** Whether `node` is or holds a block scalar that keeps its final line breaks. */
function keeps(u: Update, node: yaml.Node): boolean {
  let found = false;
  yaml.visit(node, {Scalar: (_, n) => void (found ||= keepsBreaks(u.text, n))});
  return found;
}

/** Whether `node` is a block scalar that keeps its final line breaks. */
function keepsBreaks(t: string, node: unknown): node is yaml.Scalar {
  return yaml.isScalar(node) &&
      /^[|>][0-9]*\+/.test(t.slice(node.range![0], lineEnd(t, node.range![0])));
}

/** The number of spaces and tabs that start `line`. */
function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)![0].length;
}

/**
 * `value` written as a scalar or flow collection. Each line after the first
 * that is not empty is indented under column `col`. In a flow collection, or
 * when `oneLine` is set, a double-quoted string of several lines is one line.
 */
function scalarText(
    u: Update, value: unknown, col: number, flow: boolean,
    type?: yaml.Scalar.Type, oneLine = false): string {
  if (flow && isFull(value)) {
    release(u, value);
    const seq = Array.isArray(value);
    const pad = seq ? u.pad.seq : u.pad.map;
    const parts = entriesOf(value).map(([k, v]) => seq ?
        scalarText(u, v, col, true) :
        `${scalarText(u, k, 0, true)}: ${flowValue(u, String(k), v)}`);
    return `${seq ? '[' : '{'}${pad}${parts.join(', ')}${pad}${seq ? ']' : '}'}`;
  }
  const lines = flow && typeof value === 'string' && value.includes('\n');
  // YAML allows DEL and the C1 controls other than NEL only as escapes, and
  // YAML 1.1 reads NEL, U+2028 and U+2029 as line breaks where YAML 1.2 does
  // not, so a string that holds one is double-quoted and writes them as
  // escapes.
  const special =
      typeof value === 'string' && /[\x7f-\x9f\u2028\u2029]/.test(value);
  const node = isObject(value) ? value : Object.assign(
      new yaml.Scalar(value),
      {type: lines || special ? 'QUOTE_DOUBLE' : type});
  const text = yaml.stringify(flow ? [node] : {_: node}, {
    ...YAML_OPTIONS,
    compat: 'yaml-1.1',
    indent: u.step,
    lineWidth: 0,
    doubleQuotedMinMultiLineLength: flow || oneLine ? Infinity : undefined,
    flowCollectionPadding: false,
    collectionStyle: flow ? 'flow' : 'any',
  });
  // A block scalar that keeps its final line breaks would take the blank
  // lines after it, and an indentation indicator stops at 9, so such a value
  // is double-quoted.
  if (!flow &&
      (/^_: [|>][0-9]*\+/.test(text) ||
       u.step > 9 && /^_: [|>][-+]?[0-9]/.test(text))) {
    return scalarText(u, value, col, flow, 'QUOTE_DOUBLE');
  }
  // yaml writes some double-quoted text over several lines so that it reads
  // back as other text, as with a line of one space, so that text goes on one
  // line.
  if (!flow && !oneLine && /^_: "/.test(text) &&
      text.trimEnd().includes('\n') && !readsInBlock(text, value)) {
    return scalarText(u, value, col, flow, 'QUOTE_DOUBLE', true);
  }
  // A block scalar's indentation indicator, which yaml writes as 2, is the
  // file's.
  const written = flow ? text.slice(1, -2) :
                         text.slice(3, -1).replace(/^([|>])2/, `$1${u.step}`);
  const block = /^[|>]/.test(written);
  const names: Record<string, string> =
      {'\x85': 'N', '\u2028': 'L', '\u2029': 'P'};
  return (special ? written.replace(
                        /[\x7f-\x9f\u2028\u2029]/g,
                        c => `\\${names[c] ?? `x${c.charCodeAt(0).toString(16)}`}`) :
                    written)
      .split('\n')
      // yaml writes an empty line at the start of a block scalar as a line of
      // spaces, which is written empty.
      .map((line, i) => i === 0 || !line ? line :
               block && line === ' '.repeat(u.step) ? '' :
                                                      ' '.repeat(col) + line)
      .join(u.nl);
}

/**
 * The indentation of the file's first nested mapping, list and list item, and
 * the space after the bracket of its first flow mapping and flow list whose
 * first item is on the bracket's line.
 */
function indents(doc: yaml.Document, text: string):
    Pick<Update, 'step'|'seqIndent'|'itemIndent'|'itemAlone'|'pad'> {
  const col = (p: number) => p - lineStart(text, p);
  const found: Partial<Record<'step'|'seqIndent'|'itemIndent', number>> = {};
  const pad: Partial<Update['pad']> = {};
  let itemAlone: boolean|undefined;
  yaml.visit(doc, {
    Collection: (_, v) => {
      // A pair written as a flow list item, as `a: 1` in `[a: 1]`, has no
      // bracket.
      const gap = v.srcToken?.type === 'flow-collection' && v.items.length ?
          text.slice(v.range![0] + 1, itemStarts(v)[0]) :
          '\n';
      if (!gap.includes('\n')) pad[yaml.isMap(v) ? 'map' : 'seq'] ??= gap;
    },
    Pair: (_, pair) => {
      const {key, value: v} = pair;
      if (!yaml.isNode(key) || !yaml.isCollection(v) || v.flow ||
          v.items.length === 0) {
        return;
      }
      const first = v.items[0];
      const at = itemStarts(v)[0];
      found[yaml.isMap(v) ? 'step' : 'seqIndent'] ??=
          col(at) - col(pairStart(pair));
      if (yaml.isMap(first) && !first.flow && first.items[0]) {
        const firstKey = pairStart(first.items[0]);
        found.itemIndent ??= col(firstKey) - col(at);
        itemAlone ??= lineStart(text, firstKey) !== lineStart(text, at);
      }
    },
  });
  return {
    step: 2, seqIndent: 2, itemIndent: 2, ...found,
    itemAlone: itemAlone ?? false, pad: {map: '', seq: '', ...pad},
  };
}

/** The offset of each `-` of a block list. */
function dashes(node: yaml.YAMLMap|yaml.YAMLSeq): number[] {
  return ((node.srcToken as yaml.CST.BlockSequence)?.items ?? [])
      .flatMap(it => it.start.filter(s => s.type === 'seq-item-ind'))
      .map(s => s.offset);
}

// The tokens that can come before a node's own text and start its text: a
// `?`, an anchor and a tag.
const MARKS = ['explicit-key-ind', 'anchor', 'tag'];

/**
 * The offset where `pair` starts: its `?`, or else its key's anchor or tag,
 * or else its key.
 */
function pairStart(pair: yaml.Pair): number {
  const mark = pair.srcToken?.start.find(s => MARKS.includes(s.type));
  return mark?.offset ?? (pair.key as yaml.Node).range![0];
}

/**
 * The offset where each item of `node` starts: a pair where pairStart says, a
 * block list item at its `-`, and a flow list item at its first `?`, anchor
 * or tag, or else at its own text.
 */
function itemStarts(node: yaml.YAMLMap|yaml.YAMLSeq): number[] {
  if (yaml.isMap(node)) return node.items.map(p => pairStart(p));
  if (!node.flow) return dashes(node);
  // A flow list item's marks come after the item before it, or the bracket.
  const marks = marksOf(node);
  let from = node.range![0];
  return (node.items as yaml.Node[]).map(item => {
    const [at, end] = item.range!;
    const mark = marks.find(s => s.offset >= from && s.offset < at);
    from = end;
    return mark?.offset ?? at;
  });
}

/**
 * The anchor and tag tokens of the value of each item of `node`. A pair's
 * value has those after its `:`. A block list item has those after its `-`.
 * A flow list item has those after the item before it, or after the bracket,
 * and a pair written as a flow list item has its `?` there too.
 */
function itemProps(node: yaml.YAMLMap|yaml.YAMLSeq): yaml.CST.SourceToken[][] {
  const marks = marksOf(node);
  const starts = itemStarts(node);
  return (node.items as unknown[]).map((item, i) => {
    const v = (yaml.isPair(item) ? item.value : item) as yaml.Node|null;
    const from = yaml.isPair(item) ?
        item.srcToken?.sep?.find(s => s.type === 'map-value-ind')?.offset :
        starts[i];
    return from === undefined || !v?.range ? [] :
        marks.filter(s => s.offset >= from && s.offset < v.range![0]);
  });
}

/** The `?`, anchor and tag tokens of the items of `node`, in text order. */
function marksOf(node: yaml.YAMLMap|yaml.YAMLSeq): yaml.CST.SourceToken[] {
  // A pair written as a flow list item has no token of its own, so the
  // tokens of its pair are read.
  const items =
      (node.srcToken as {items?: yaml.CST.CollectionItem[]}|undefined)?.items ??
      (node.items as yaml.Pair[]).map(p => p.srcToken);
  return items.flatMap(it => [...it?.start ?? [], ...it?.sep ?? []])
      .filter(s => MARKS.includes(s.type));
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

/**
 * The indentation of the lines of text of the block scalar `node`, whose key
 * or `-` is at column `col`, or undefined when `node` is not a block scalar or
 * has no line of text. A header that sets the indentation gives it, and
 * otherwise the spaces before its first line of text do.
 */
function blockIndent(
    t: string, node: yaml.Scalar, col: number): number|undefined {
  const [from, to] = node.range!;
  const header =
      /^[|>](?:([1-9])[-+]?|[-+]([1-9])?)?(?![-+0-9])/.exec(t.slice(from, to));
  if (!header) return undefined;
  const digit = header[1] ?? header[2];
  if (digit) return col + Number(digit);
  const line =
      t.slice(from, to).split('\n').slice(1).find(l => /[^ \r]/.test(l));
  return line === undefined ? undefined : /^ */.exec(line)![0].length;
}

/**
 * The offset where the line holding `p` starts. The first line starts after
 * a byte order mark.
 */
function lineStart(t: string, p: number): number {
  const start = t.lastIndexOf('\n', p - 1) + 1;
  return start === 0 && p > 0 && t.startsWith('\uFEFF') ? 1 : start;
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

/**
 * Each pair of `doc` with the mapping that holds it, by its value node, and
 * each pair whose value is a scalar by its key and value, in document order.
 */
function pairsIndexed(doc: yaml.Document): Pick<Update, 'byValue'|'byScalar'> {
  const byValue = new Map<unknown, Array<[yaml.Pair, unknown]>>();
  const byScalar = new Map<string, Array<[yaml.Pair, unknown]>>();
  const add = <K>(
      map: Map<K, Array<[yaml.Pair, unknown]>>, k: K,
      entry: [yaml.Pair, unknown]) => {
    const list = map.get(k);
    if (list) list.push(entry);
    else map.set(k, [entry]);
  };
  yaml.visit(doc, {
    Pair: (_, p, path) => {
      const entry: [yaml.Pair, unknown] = [p, path.at(-1)];
      if (p.value != null) add(byValue, p.value, entry);
      if (yaml.isScalar(p.value)) {
        add(byScalar, scalarKey(keyOf(p), p.value.value), entry);
      }
    },
  });
  return {byValue, byScalar};
}

/** The text byScalar files a pair under: its key, value type and value. */
function scalarKey(key: string, value: unknown): string {
  return `${key}\0${typeof value}\0${String(value)}`;
}

function keyOf(pair: yaml.Pair): string {
  const key = yaml.isScalar(pair.key) ? pair.key.value : pair.key;
  return key === null ? '' : String(key);
}

/** Whether `node` is the `data` of a GOOGLE block. */
function isGoogleData(u: Update, node: yaml.Node): boolean {
  const [pair, map] = u.byValue.get(node)?.[0] ?? [];
  return !!pair && keyOf(pair) === 'data' && yaml.isMap(map) &&
      isGoogleVendor(map.get('vendor_name'));
}

/** Whether `value` is a string that parses as JSON. */
function isJson(value: unknown): value is string {
  try {
    JSON.parse(value as string);
    return typeof value === 'string';
  } catch {
    return false;
  }
}

/** `json`, a JSON text, without the whitespace outside its strings. */
function compactJson(json: string): string {
  return json.replace(/("(?:[^"\\]|\\.)*")|[ \t\n\r]+/g, (_, s) => s ?? '');
}

function entriesOf(value: object): Array<[string|number, unknown]> {
  return Array.isArray(value) ?
      value.map((v, i) => [i, v]) :
      Object.entries(value).filter(([, v]) => v !== undefined);
}

function isFull(value: unknown): value is object {
  return isObject(value) && entriesOf(value).length > 0;
}

/**
 * What matches a list item with another: its `name`, or else the key that
 * names an item of its list (`dialect`, `concept` or `vendor_name`), or else
 * its value, with each mapping's keys in any order. With `byValue`, its value.
 */
export function itemKey(value: unknown, byValue = false): string {
  const key = !byValue && isRecord(value) &&
      ['name', 'dialect', 'concept', 'vendor_name'].find(
          k => typeof value[k] === 'string');
  const name = key && (value as Record<string, unknown>)[key];
  // A GOOGLE block matches whatever case its vendor_name is written in, as the
  // loader reads it.
  return key === 'vendor_name' && isGoogleVendor(name) ? 'vendor_name:GOOGLE' :
      key                                             ? `${key}:${name}` :
                                                        canonical(value);
}

/**
 * The itemKey of each of `items`, or else its value when another of `items`
 * has the same key or `repeated` holds that key.
 */
export function itemKeys(items: unknown[], repeated = new Set<string>()):
    string[] {
  const keys = items.map(v => itemKey(v));
  return keys.map(
      (k, i) => repeated.has(k) || keys.indexOf(k) !== keys.lastIndexOf(k) ?
          itemKey(items[i], true) :
          k);
}

/**
 * `value` as JSON text with each mapping's keys sorted. Two values give one
 * text only when they are equal. JSON writes NaN and the infinities as `null`
 * and -0 as `0`, so these are written as strings that start with a NUL
 * instead. A string that starts with a NUL gets another one.
 */
function canonical(value: unknown): string {
  const exact = (_: string, v: unknown) => isRecord(v) ?
      Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) :
      typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0)) ?
      `\0${Object.is(v, -0) ? '-0' : v}` :
      typeof v === 'string' && v.startsWith('\0') ? `\0${v}` :
      v;
  return JSON.stringify(value, exact) ?? 'undefined';
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
