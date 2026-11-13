// Changes the text of a YAML document to hold a new value. Each part whose
// value stays comes back byte for byte, and a changed part is written in the
// file's indentation and line endings. A changed block scalar keeps the
// indentation of its lines.

import * as yaml from 'yaml';

import {isGoogleVendor, isRecord} from './loader';
import {YAML_OPTIONS} from './yaml_options';

/**
 * Parses `text` for `updateText`. A JSON file, which is one flow mapping, is
 * first rewritten as block YAML, which the returned `text` holds. A number
 * keeps its text there when that is a JSON number, such as `1.50`, `1e400` or
 * an integer past 2^53.
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
  const numbers = numbersHeld(document, text);
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
  const yamlText = numbers(document.toString({lineWidth: 0}));
  return {document: parse(yamlText), text: yamlText};
}

/**
 * Sets each number of `doc`, which parses `text`, whose text is a JSON number
 * to a placeholder string that neither `text` nor a string of `doc` holds, and
 * gives a function that writes each placeholder in a text written from `doc`
 * as its number's text. So a number such as `1.50`, `1e400` or an integer past
 * 2^53 keeps its text.
 */
function numbersHeld(doc: yaml.Document, text: string):
    (written: string) => string {
  // A string can hold what its text does not, through an escape such as
  // `\u005f`.
  const texts = [text];
  yaml.visit(doc, {
    Scalar: (_, n) => void (typeof n.value === 'string' && texts.push(n.value)),
  });
  let stem = 'kcmd_number_';
  while (texts.some(s => s.includes(stem))) stem += '_';
  const numbers: string[] = [];
  yaml.visit(doc, {
    Scalar: (_, n) => {
      const source = scalarSource(n);
      if (typeof n.value === 'number' && JSON_NUMBER.test(source)) {
        n.value = stem + numbers.length;
        numbers.push(source);
      }
    },
  });
  return written => written.replace(
             new RegExp(`${stem}(\\d+)`, 'g'), (_, k) => numbers[Number(k)]);
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
    values: new Map(),
    aliases: [],
    nl: /\r?\n/.exec(text)?.[0] ?? '\n',
    ...indents(doc, text),
  };
  hold(u, value, doc.contents);
  patch(u, value, doc.contents, {col: 0, prefix: '', flow: false});
  // An alias stays when its value is its anchor's value: the anchor's old
  // value when the anchor's text stays, or its new value when its text
  // changed and keeps its `&` mark. Any other alias is written out.
  const touched = (a: number, b: number) =>
      u.edits.some(([p, q]) => p < b && q > a);
  for (const [alias, v, slot] of u.aliases) {
    const anchor = alias.resolve(doc) as yaml.Node;
    const [a, b] = anchor.range!;
    const mark = text.lastIndexOf(`&${anchor.anchor}`, a);
    const stays = !u.dirty.has(anchor) && !touched(a, b) ?
        canonical(anchor.toJS(doc)) === canonical(v) :
        mark >= 0 && !touched(mark, mark + 1 + anchor.anchor!.length) &&
            u.values.has(anchor) &&
            canonical(u.values.get(anchor)) === canonical(v);
    if (!stays) replace(u, v, alias, slot);
  }
  // The empty lines after a block scalar that keeps its final line breaks, as
  // `|+` does, are its text. An edit that removes the text right after one
  // whose text stays also removes the blank lines it would leave there.
  const ends = new Set<number>();
  yaml.visit(doc, {
    Scalar: (_, n) => {
      const [a, b] = n.range!;
      if (keepsBreaks(text, n) && !u.edits.some(([p, q]) => p < b && q > a)) {
        ends.add(b);
      }
    },
  });
  const made = u.edits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  made.forEach(([from, to, s], i) => {
    const [p, q, inserted] = made[i - 1] ?? [];
    if (s || !ends.has(from) || p === from && q === from && inserted) return;
    made[i][1] = skipBlank(text, to, made[i + 1]?.[0] ?? text.length);
    ends.add(made[i][1]);
  });
  edits.push(...made);
  const out = spliced(text, made);
  // A text with no final newline keeps none, unless the text of a block scalar
  // that keeps its final line breaks reaches its end.
  return text.endsWith('\n') || ends.has(text.length) ?
      out :
      out.replace(/\r?\n$/, '');
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
  /** Each node `patch` wrote, with the value it wrote there. */
  values: Map<unknown, unknown>;
  /** Each alias, with its new value and where it sits. */
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
   * The offset after that `:` or `-`. Unset for the root, and for a key
   * written with no `:`, as `b` in `{a: 1, b}`.
   */
  after?: number;
  /** For a key written with no `:`, the offset after the key. */
  keyEnd?: number;
  /** Whether the node is inside a flow collection. */
  flow: boolean;
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
  // Its value stays unwritten while it stays null.
  if (node === null && value === null) return;
  const edits = u.edits.length;
  u.values.set(node, value);
  // A flow collection over several lines that changes is written again in
  // block style.
  if (yaml.isCollection(node) && node.flow && spansLines(u.text, node) &&
      canonical(node.toJS(u.doc)) !== canonical(value)) {
    replace(u, value, node, slot);
  } else if (
      isFull(value) && yaml.isCollection(node) &&
      Array.isArray(value) === yaml.isSeq(node)) {
    patchItems(u, value, node, slot);
  } else if (yaml.isScalar(node) && !isObject(value)) {
    if (node.value !== value) setScalar(u, node, value, slot);
  } else if (
      isObject(value) && !isFull(value) && yaml.isCollection(node) &&
      node.items.length === 0 && Array.isArray(value) === yaml.isSeq(node)) {
    // An empty list or mapping that stays empty keeps its text.
  } else if (yaml.isAlias(node)) {
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
  // The text between two items.
  const sep = g.length > 1 ? t.slice(g[0].end, g[1].start) : ', ';
  const slotOf = (i: number): Slot => {
    const item = items[i];
    const sep = yaml.isPair(item) ?
        item.srcToken?.sep?.find(s => s.type === 'map-value-ind')?.offset :
        g[i].start;
    const prefix = yaml.isPair(item) ? ':' : '-';
    const keyEnd = yaml.isPair(item) && yaml.isNode(item.key) ?
        item.key.range?.[1] :
        undefined;
    return sep === undefined ? {col, prefix, keyEnd, flow} :
                               {col, prefix, after: sep + 1, flow};
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
  s = lead + s;
  u.edits.push([from, to, u.text[to - 1] === '\n' ? s + u.nl : s]);
}

/**
 * Writes `value` in place of `node`. The comment on the line where `node`
 * starts stays on that line.
 */
function replace(u: Update, value: unknown, node: unknown, slot: Slot): void {
  const t = u.text;
  // A key written with no `:` takes `: ` and the value after it, on its line.
  // Only the root, at the start of an empty text, has no other place.
  if (!(yaml.isNode(node) && node.range) && slot.after === undefined &&
      slot.prefix) {
    if (slot.keyEnd !== undefined) {
      u.edits.push([
        slot.keyEnd, slot.keyEnd, `: ${scalarText(u, value, slot.col, true)}`,
      ]);
    }
    return;
  }
  const [from, to, lead] = yaml.isNode(node) && node.range ?
      rangeOf(u, node) :
      [slot.after ?? 0, slot.after ?? 0, ''];
  // A flow collection on one line stays flow.
  if (slot.flow || slot.after === undefined ||
      yaml.isCollection(node) && node.flow && isObject(value) &&
          !spansLines(u.text, node)) {
    u.edits.push([from, to, lead + scalarText(u, value, slot.col, true)]);
    return;
  }
  const keyLine = lineEnd(t, slot.after);
  // A block collection's range can run over the comments after it and into
  // the next line's indentation. The comments at its key's column or less
  // stay.
  const stop = blockEnd(t, to, slot.col, node);
  const end = lineEnd(t, Math.max(from, stop - 1));
  // A scalar, alias or flow collection on the line under its key is replaced
  // there, so the comments above it and after it stay.
  const under = from > keyLine && (!yaml.isCollection(node) || node.flow);
  const col = under && isFull(value) ? from - lineStart(t, from) : slot.col;
  const [first, ...rest] = under && isFull(value) ?
      items(u, value as object, col) :
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
  // The anchor and tag of a node under its key line are on the key line. A
  // collection's tag does not apply to a scalar that replaces it, so it is
  // dropped, and the anchor stays.
  const tail = from > keyLine ? t.slice(slot.after, keyLine) : after;
  const props =
      from > keyLine ? /^([ \t]+[&!][^ \t\r\n]*)*/.exec(tail)![0] : '';
  const kept = yaml.isCollection(node) && !isFull(value) ?
      props.replace(/[ \t]+![^ \t\r\n]*/g, '') :
      props;
  if (under && kept !== props) {
    u.edits.push([slot.after, slot.after + props.length, kept]);
  }
  if (under && !isFull(value)) {
    // As a block scalar, text of several lines would take the text after it.
    const type = typeof value === 'string' && value.includes('\n') ?
        'QUOTE_DOUBLE' :
        undefined;
    u.edits.push(
        [from, end, scalarText(u, value, slot.col, false, type) + after]);
    return;
  }
  if (under) {
    u.edits.push([from, end, [first.slice(col) + after, ...rest].join(u.nl)]);
    return;
  }
  // A node under its key line keeps the text after its key on that line, and
  // its anchor and tag go before the new value.
  const head = first.slice(col + slot.prefix.length);
  u.edits.push([
    slot.after, end,
    [kept + head + tail.slice(props.length), ...rest].join(u.nl),
  ]);
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
 * pair with the same key and value whose text the new value does not keep.
 * Undefined when nothing moved, or when the text would not read back as
 * `value` at its new place, as when it holds an alias of an anchor outside it.
 * A value that is or holds a block scalar that keeps its final line breaks,
 * as `|+` does, is written fresh, since its text would take the blank lines
 * after its new place.
 */
function movedText(
    u: Update, key: string|undefined, value: unknown,
    col?: number): string[]|undefined {
  const node = isObject(value) ? u.links.get(value) : undefined;
  const found = u.pairs.find(([p, parent]) => !u.used.has(p) &&
      (node ? p.value === node && u.held.get(node) === value :
              key !== undefined && keyOf(p) === key && yaml.isScalar(p.value) &&
              p.value.value === value &&
              (u.held.get(parent) as Record<string, unknown>|undefined)?.[key] !==
                  value));
  const p = found?.[0];
  const v = p?.value as yaml.Node|undefined;
  if (!p || !v?.range || !yaml.isNode(p.key) || keeps(u, v)) return undefined;
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
 * `text` from offset `from` to `to`, with each line that starts after `from`,
 * and the first line too when `from` starts it, moved `shift` columns right,
 * or left up to its first character. A blank line stays blank.
 */
function shifted(text: string, from: number, to: number, shift: number): string {
  const whole = lineStart(text, from) === from;
  return text.slice(from, to)
      .split('\n')
      .map((l, i) => i === 0 && !whole || l === '' || l === '\r' ? l :
               shift >= 0 ? ' '.repeat(shift) + l :
                            l.slice(Math.min(-shift, indentOf(l))))
      .join('\n');
}

/**
 * The text of item `i` of `node`, a mapping or list of `doc` that `text`
 * holds, moved so that the key or `-` that starts it sits at column `col`:
 * `above`, the comments and blank lines above the item, and `item`, its own
 * text from its key or `-`, without the spaces before it. An item of a flow
 * collection becomes an item of a block list: `- `, the item, and the comment
 * after it on its line. With `keyLine` set, a comment after the bracket that
 * closes the collection is not the item's, since the caller keeps it on the
 * line of the collection's key. With `key`, a pair's key is written as
 * `key`. Each line keeps its text and moves by the same number of columns, so
 * the item keeps its quoting, escapes, block scalars and comments. Each part
 * is empty or ends with a line break.
 */
export function movedItem(
    text: string, doc: yaml.Document.Parsed, node: yaml.YAMLMap|yaml.YAMLSeq,
    i: number, col: number, key?: string,
    keyLine = false): {above: string; item: string} {
  const nl = /\r?\n/.exec(text)?.[0] ?? '\n';
  const ended = (s: string) => s === '' || s.endsWith('\n') ? s : s + nl;
  const at = (p: number) => p - lineStart(text, p);
  const g = geometry({text, doc}, node, !!node.flow);
  const {head, start, end} = g[i];
  if (!node.flow) {
    const shift = col - at(start);
    const pair = node.items[i];
    const k = key !== undefined && yaml.isPair(pair) && yaml.isNode(pair.key) ?
        pair.key.range! :
        undefined;
    const above = head < lineStart(text, start) ?
        shifted(text, head, lineStart(text, start), shift) :
        '';
    const item = k ? key + shifted(text, k[1], end, shift) :
                     shifted(text, start, end, shift);
    return {above, item: ended(item)};
  }
  // The comment lines between the item before it, or the bracket, and it.
  const from = nextLine(text, i > 0 ? g[i - 1].end : node.range![0]);
  const above = text.slice(from, Math.max(from, lineStart(text, start)))
                    .split(/(?<=\n)/)
                    .filter(l => /^[ \t]*(#.*)?\r?\n?$/.test(l))
                    .map(l => l.replace(/^[ \t]*(?=#)/, ' '.repeat(col)))
                    .join('');
  // The comment after the item, when no other item or value follows it on
  // its line.
  const rest = text.slice(end, lineEnd(text, end));
  const close = node.range![1];
  const comment = keyLine && close > end && close <= end + rest.length ?
      null :
      /^[\s,\]}]*?([ \t]*)(#.*)$/.exec(rest);
  // The lines after the first keep at least the indentation a flow
  // collection in a block list item needs.
  const lines = shifted(text, start, end, col + 2 - at(start))
                    .split('\n')
                    .map((l, j) => j && l.trim() && indentOf(l) <= col ?
                             ' '.repeat(col + 1) + l.trimStart() :
                             l)
                    .join('\n');
  const item =
      `- ${lines}${comment ? (comment[1] || ' ') + comment[2] : ''}`;
  return {above: ended(above), item: ended(item)};
}

/**
 * `text`, which `doc` parses, with each key of its root mapping except those
 * in `kept` moved into a mapping that is the one item of a new list under
 * `key`, written after the kept keys in the file's list style. The moved
 * lines keep their text, each indented by the same amount, so their comments,
 * blank lines and block scalars stay as written. The comments and blank lines
 * above the first moved key stay above `key`, and a kept key after it moves
 * there with the comments above it. A document end marker and what follows
 * it stay after the model. Expects a block mapping at the root with a key to
 * move.
 */
export function wrappedRoot(
    text: string, doc: yaml.Document.Parsed, key: string,
    kept: readonly string[]): string {
  const root = doc.contents as yaml.YAMLMap;
  const g = geometry({text, doc}, root, false);
  const {seqIndent, itemIndent, itemAlone} = indents(doc, text);
  const nl = /\r?\n/.exec(text)?.[0] ?? '\n';
  const keep = root.items.map(p => kept.includes(keyOf(p)));
  const at = lineStart(text, g[keep.indexOf(false)].start);
  const rootCol = g[0].start - lineStart(text, g[0].start);
  const marker = /^\.\.\.(?=[ \t\r\n]|$)/m.exec(text.slice(root.range![1]));
  const stop = doc.directives?.docEnd && marker ?
      root.range![1] + marker.index :
      text.length;
  const above: string[] = [];
  const edits: Array<[number, number, string]> = [];
  g.forEach(({head, end}, i) => {
    if (!keep[i] || head < at) return;
    const lines = text.slice(head, end);
    above.push(lines.endsWith('\n') ? lines : lines + nl);
    edits.push([head - at, end - at, '']);
  });
  // The columns from the root's keys to the moved keys, and the `-` that
  // starts the moved mapping, with the spaces after it.
  const inner = seqIndent + (itemAlone ? itemIndent : Math.max(itemIndent, 2));
  const dash = ' '.repeat(rootCol + seqIndent) + '-' +
      (itemAlone ? nl + ' '.repeat(rootCol + inner) :
                   ' '.repeat(inner - seqIndent - 1));
  const body = spliced(text.slice(at, stop), edits);
  const [first, ...rest] =
      shifted(body, 0, body.length, inner).split('\n');
  const moved = [dash + first.trimStart(), ...rest].join('\n');
  const out = text.slice(0, at) + above.join('') + ' '.repeat(rootCol) + key +
      ':' + nl + moved + text.slice(stop);
  return text.endsWith('\n') ? out : out.replace(/\r?\n$/, '');
}

/**
 * `text`, which `doc` parses, with the items of the list under `key` in each
 * of the mappings `sources` moved, in order, to the end of the block list
 * under `key` in the block mapping `target`. When `target` has no `key`, it is
 * added as the last key of `target`, and when its value is empty or a flow
 * list, it becomes a block list. Each emptied `key` is removed. The items move
 * by text (see movedItem), and so do the comments above each removed key and
 * on its line, which go above its first item. `text` itself when no source has
 * `key`. Undefined when a value under `key` is neither a list nor empty, or a
 * removed key is the only key of its mapping.
 */
export function movedItems(
    text: string, doc: yaml.Document.Parsed, sources: yaml.YAMLMap[],
    target: yaml.YAMLMap, key: string): string|undefined {
  const nl = /\r?\n/.exec(text)?.[0] ?? '\n';
  const col = (p: number) => p - lineStart(text, p);
  const empty = (v: unknown) => v === null || yaml.isScalar(v) && v.value === null;
  const found = sources.map(s => s.items.findIndex(p => keyOf(p) === key));
  if (found.every(i => i < 0)) return text;
  if (target.flow || target.items.length === 0) return undefined;
  const own = target.items.find(p => keyOf(p) === key);
  const list = own?.value;
  const keyCol = col((target.items[0].key as yaml.Node).range![0]);
  const block = yaml.isSeq(list) && !list.flow && list.items.length > 0;
  const to = block ? col(dashes(list)[0]) :
                     keyCol + indents(doc, text).seqIndent;
  const edits: Array<[number, number, string]> = [];
  let moved = '';
  let count = 0;
  let refused = false;
  sources.forEach((source, n) => {
    const i = found[n];
    if (i < 0) return;
    const pair = source.items[i];
    const value = pair.value;
    const g = geometry({text, doc}, source, !!source.flow);
    if (!yaml.isSeq(value) && !empty(value) || g.length === 1) {
      refused = true;
      return;
    }
    const {head, start, end, inline} = g[i];
    const next = g[i + 1];
    if (source.flow) {
      edits.push(next ? [start, next.start, ''] : [g[i - 1].end, end, '']);
    } else if (inline) {
      // The next key moves up onto the `- ` line, and its comments go above
      // that line.
      const line = lineStart(text, start);
      const ownLine = lineStart(text, next.start);
      const indent = /^[ \t]*/.exec(text.slice(line))![0];
      const comments = text.slice(skipBlank(text, next.head, ownLine), ownLine)
                           .replace(/^[ \t]*(?=#)/gm,
                                    w => w.length > indent.length ? indent : w);
      edits.push([line, line, comments], [start, next.start, '']);
    } else {
      // The comments above the key go above its first item.
      moved += text.slice(head, lineStart(text, start))
                   .replace(/^[ \t]*(?=#)/gm, ' '.repeat(to));
      edits.push([head, end, '']);
    }
    // So does the comment on the key's line, unless an item follows the key
    // there.
    const firstLine = yaml.isSeq(value) && value.items[0] ?
        lineStart(text, (value.items[0] as yaml.Node).range![0]) :
        Infinity;
    const keyLine = text.slice(start, lineEnd(text, start));
    const comment = /\s(#.*)$/.exec(keyLine.slice(keyLine.indexOf(':')));
    if (!source.flow && comment && firstLine > start) {
      moved += `${' '.repeat(to)}${comment[1]}${nl}`;
    }
    const items = yaml.isSeq(value) ? value : undefined;
    for (let j = 0; j < (items?.items.length ?? 0); j++) {
      const {above, item} = movedItem(text, doc, items!, j, to);
      moved += above + ' '.repeat(to) + item;
      count++;
    }
  });
  if (refused) return undefined;
  let at: number;
  if (count === 0) {
    at = text.length;
  } else if (block) {
    at = geometry({text, doc}, list, false).at(-1)!.end;
  } else if (own) {
    // An empty value or a flow list under `key` becomes a block list, its
    // items moved by text before the new ones.
    if (!yaml.isSeq(list) && !empty(list)) return undefined;
    const colon = (own.srcToken as yaml.CST.BlockMap['items'][number])
                      ?.sep?.find(s => s.type === 'map-value-ind')?.offset;
    if (colon === undefined) return undefined;
    const valueEnd =
        (list as yaml.Node|null)?.range?.[1] ?? colon + 1;
    edits.push([colon + 1, Math.max(colon + 1, valueEnd), '']);
    at = nextLine(text, valueEnd);
    let kept = '';
    for (let j = 0; j < (yaml.isSeq(list) ? list.items.length : 0); j++) {
      const {above, item} =
          movedItem(text, doc, list as yaml.YAMLSeq, j, to, undefined, true);
      kept += above + ' '.repeat(to) + item;
    }
    moved = kept + moved;
  } else {
    at = geometry({text, doc}, target, false).at(-1)!.end;
    moved = `${' '.repeat(keyCol)}${key}:${nl}${moved}`;
  }
  // The edits before `at` move it.
  const shift = edits.filter(([, e]) => e <= at)
                    .reduce((n, [s, e, r]) => n + r.length - (e - s), 0);
  const out = spliced(text, edits);
  const p = at + shift;
  const lead = count > 0 && p > 0 && out[p - 1] !== '\n' ? nl : '';
  const result = out.slice(0, p) + (count > 0 ? lead + moved : '') + out.slice(p);
  return text.endsWith('\n') ? result : result.replace(/\r?\n$/, '');
}

/**
 * `text`, which `doc` parses, with the value of key `from` of each of `maps`
 * moved into a new first item of the list under key `to` of the same
 * mapping, as the value of `key`, after the keys and values of `entry`. The
 * value moves by text (see movedItem), with the comment after it on its line,
 * and the comments above `from` go above the new item. When the mapping has
 * no `to`, the text of `from` becomes `to`, so the comments above it stay. In
 * a block mapping, a flow list under `to` becomes a block list, its items
 * moved by text. Also gives each mapping it changed; a mapping whose `to`
 * holds no list, or whose `from` follows a `-` on its line, stays as written.
 */
export function valuesListed(
    text: string, doc: yaml.Document.Parsed, maps: yaml.YAMLMap[],
    from: string, to: string, entry: Record<string, string>,
    key: string): {text: string; changed: yaml.YAMLMap[]} {
  const nl = /\r?\n/.exec(text)?.[0] ?? '\n';
  const col = (p: number) => p - lineStart(text, p);
  const file = indents(doc, text);
  const keys = Object.entries(entry).map(([k, v]) => `${k}: ${v}`);
  const edits: Array<[number, number, string]> = [];
  const changed: yaml.YAMLMap[] = [];
  for (const map of maps) {
    const i = map.items.findIndex(p => keyOf(p) === from);
    const j = map.items.findIndex(p => keyOf(p) === to);
    const pair = map.items[i];
    const list = map.items[j]?.value;
    if (!pair || j >= 0 && !yaml.isSeq(list) ||
        !yaml.isNode(pair.key) || !yaml.isNode(pair.value)) {
      continue;
    }
    const g = geometry({text, doc}, map, !!map.flow);
    if (map.flow) {
      const [v0, v1] = pair.value.range!;
      const pad = file.pad.map;
      const value = `{${pad}${[...keys, `${key}: ${text.slice(v0, v1)}`].join(', ')}${pad}}`;
      if (!yaml.isSeq(list)) {
        const [k0, k1] = pair.key.range!;
        edits.push([k0, k1, to], [v0, v1, `[${file.pad.seq}${value}${file.pad.seq}]`]);
      } else {
        const next = g[i + 1];
        edits.push(next ? [g[i].start, next.start, ''] : [g[i - 1].end, g[i].end, '']);
        const first = list.items[0] as yaml.Node|undefined;
        edits.push(first ? [first.range![0], first.range![0], `${value}, `] :
                           [list.range![0] + 1, list.range![0] + 1, value]);
      }
      changed.push(map);
      continue;
    }
    const {head, start, end, inline} = g[i];
    if (inline) continue;
    // The new item's `-` and its keys sit as the first item of a block list
    // under `to` does, or else as the file's list items do.
    const firstItem = yaml.isSeq(list) && !list.flow ? list.items[0] : undefined;
    const firstKey = yaml.isMap(firstItem) && !firstItem.flow ?
        (firstItem.items[0]?.key as yaml.Node|undefined)?.range?.[0] :
        undefined;
    const dash = firstItem ? col(dashes(list as yaml.YAMLSeq)[0]) :
        col(start) + file.seqIndent;
    const alone = firstKey !== undefined ?
        lineStart(text, firstKey) !== lineStart(text, dashes(list as yaml.YAMLSeq)[0]) :
        file.itemAlone;
    const at = firstKey !== undefined ? col(firstKey) : dash + file.itemIndent;
    const [k0, ...ks] = keys;
    const lines = (alone ? `${' '.repeat(dash)}-${nl}${' '.repeat(at)}` :
                           `${' '.repeat(dash)}-${' '.repeat(Math.max(1, at - dash - 1))}`) +
        k0 + nl + ks.map(k => ' '.repeat(at) + k + nl).join('');
    const moved = movedItem(text, doc, map, i, at, key);
    const item = lines + ' '.repeat(at) + moved.item;
    if (!yaml.isSeq(list)) {
      edits.push([start, end, `${to}:${nl}${item}`]);
    } else if (firstItem) {
      edits.push([head, end, '']);
      const above =
          moved.above.replace(/^[ \t]*(?=#)/gm, ' '.repeat(dash));
      const listHead = geometry({text, doc}, list, false)[0].head;
      edits.push([listHead, listHead, above + item]);
    } else {
      // A flow list becomes a block list.
      const toPair = map.items[j];
      const colon = (toPair.srcToken as yaml.CST.BlockMap['items'][number])
                        ?.sep?.find(s => s.type === 'map-value-ind')?.offset;
      if (colon === undefined) continue;
      edits.push([head, end, '']);
      const valueEnd = list.range![1];
      let rest = '';
      for (let n = 0; n < list.items.length; n++) {
        const m = movedItem(text, doc, list, n, dash, undefined, true);
        rest += m.above + ' '.repeat(dash) + m.item;
      }
      const above =
          moved.above.replace(/^[ \t]*(?=#)/gm, ' '.repeat(dash));
      const after = nextLine(text, valueEnd);
      const lead = after === text.length && !text.endsWith('\n') ? nl : '';
      edits.push([colon + 1, valueEnd, ''], [after, after, lead + above + item + rest]);
    }
    changed.push(map);
  }
  const out = spliced(text, edits);
  return {
    text: text.endsWith('\n') ? out : out.replace(/\r?\n$/, ''),
    changed,
  };
}

/**
 * `text` with each alias that comes before its anchor, which YAML cannot
 * read, written as the anchor's value, in flow style on one line, the names
 * of those anchors, and for each alias written, its anchor's name and the
 * keys and indexes from the document root to it. A number in a value so
 * written keeps its text when that is a JSON number, such as `1.50`.
 */
export function aliasesWritten(text: string): {
  text: string; anchors: string[];
  sites: Array<{anchor: string; path: Array<string|number>}>;
} {
  const anchors: string[] = [];
  const sites: Array<{anchor: string; path: Array<string|number>}> = [];
  // A value written so may hold another such alias, so each pass writes the
  // aliases whose anchor's value reads.
  for (let pass = 0; pass < 10; pass++) {
    const doc = yaml.parseDocument(text, YAML_OPTIONS);
    const numbers = numbersHeld(doc, text);
    const nodes: yaml.Node[] = [];
    yaml.visit(doc, {Node: (_, n) => void nodes.push(n)});
    const edits: Array<[number, number, string]> = [];
    yaml.visit(doc, {
      Alias: (_, alias, path) => {
        if (alias.resolve(doc) || !alias.range) return;
        const anchor = nodes.find(
            n => n.anchor === alias.source && n.range &&
                n.range[0] > alias.range![0]);
        let value: unknown;
        try {
          value = anchor?.toJS(doc);
        } catch {
          return;
        }
        if (!anchor) return;
        // A string with a line break is written in double quotes, which hold
        // it on one line.
        const node = new yaml.Document(value, YAML_OPTIONS);
        yaml.visit(node, {
          Scalar: (_, n) => {
            if (typeof n.value === 'string' && /[\n\r]/.test(n.value)) {
              n.type = 'QUOTE_DOUBLE';
            }
          },
        });
        const written = numbers(node.toString({
          collectionStyle: 'flow',
          flowCollectionPadding: false,
          lineWidth: 0,
          doubleQuotedMinMultiLineLength: Number.MAX_SAFE_INTEGER,
        }).trimEnd());
        edits.push([alias.range[0], alias.range[1], written]);
        if (!anchors.includes(alias.source)) anchors.push(alias.source);
        sites.push({anchor: alias.source, path: keysTo(path, alias)});
      },
    });
    if (!edits.length) break;
    text = spliced(text, edits);
  }
  return {text, anchors, sites};
}

/**
 * The keys and indexes from the document root to `node`, whose ancestors
 * yaml.visit gives as `path`.
 */
function keysTo(
    path: readonly unknown[], node: unknown): Array<string|number> {
  const chain = [...path, node];
  return chain.flatMap((n, i): Array<string|number> => {
    if (yaml.isSeq(n)) return [n.items.indexOf(chain[i + 1] as yaml.Node)];
    return yaml.isPair(n) && yaml.isScalar(n.key) ? [String(n.key.value)] : [];
  });
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
        const firstKey = (first.items[0].key as yaml.Node).range![0];
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

/** Whether `node` is the `data` of a GOOGLE block. */
function isGoogleData(u: Update, node: yaml.Node): boolean {
  const [pair, map] = u.pairs.find(([p]) => p.value === node) ?? [];
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

// A number as JSON writes one.
const JSON_NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/;

/**
 * The value of `node`, a node of `doc`, as one line of JSON as compactJson
 * writes it. A mapping keeps its keys in the order written. A key that is not
 * a string is written as its text, a key written as an alias as its anchor's
 * value, and a list or mapping as a key as its JSON. A number keeps its text
 * when that is a JSON number, such as `1.50`, an integer past 2^53 or `1e400`,
 * which is past the range of a double, and is written as its value otherwise,
 * so `+1` is `1`. An alias is written as its anchor's value. For a value JSON
 * has no form for, `.inf`, `-.inf` or `.nan`, gives its text and its path: the
 * keys and list indexes that lead to it, as in `a.b[2]`. For two keys of a
 * mapping that JSON writes alike, such as `1` and `"1"`, gives that key and
 * the mapping's path, with `key` set.
 */
export function nodeJson(node: unknown, doc: yaml.Document):
    string|{text: string; path: string; key?: boolean} {
  let bad: {text: string; path: string; key?: boolean}|undefined;
  const write = (n: unknown, path: string): string => {
    if (yaml.isAlias(n)) return write(n.resolve(doc), path);
    if (yaml.isMap(n)) {
      const keys = new Set<string>();
      return `{${n.items.map(p => {
        const k = yaml.isAlias(p.key) ? p.key.resolve(doc) : p.key;
        const key = !yaml.isScalar(k) ? write(k, path) :
            typeof k.value === 'string' ? k.value :
            k.value === null            ? '' :
                                          scalarSource(k);
        if (keys.has(key)) bad ??= {text: key, path, key: true};
        keys.add(key);
        return `${JSON.stringify(key)}:${
            write(p.value, path ? `${path}.${key}` : key)}`;
      }).join(',')}}`;
    }
    if (yaml.isSeq(n)) {
      return `[${n.items.map((v, i) => write(v, `${path}[${i}]`)).join(',')}]`;
    }
    const value = yaml.isScalar(n) ? n.value : null;
    if (typeof value !== 'number') return JSON.stringify(value ?? null);
    const text = scalarSource(n as yaml.Scalar);
    if (JSON_NUMBER.test(text)) return text;
    if (!Number.isFinite(value)) bad ??= {text, path};
    return JSON.stringify(value);
  };
  const json = write(node, '');
  return bad ?? json;
}

/**
 * The text a scalar is written as, or for a scalar made rather than parsed,
 * its value as YAML writes it, as `.inf` for Infinity.
 */
function scalarSource(n: yaml.Scalar): string {
  const {value} = n;
  return (n as yaml.Scalar.Parsed).source ??
      (typeof value !== 'number' || Number.isFinite(value) ? String(value) :
           Number.isNaN(value)                             ? '.nan' :
           value > 0                                       ? '.inf' :
                                                             '-.inf');
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
