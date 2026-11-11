// How a pull changes a local model or profile file to hold what the catalog
// holds.
//
// Pull rebuilds each model and profile file from the catalog, so the files it
// builds have none of the author's comments and formatting, and give the
// content in one normal form: an `ai_context` in its object form, entities,
// metrics, relationships, actions and constraints sorted by name, and so on
// (see fidelity.md, "What pull recovers"). `catalogForm` gives the model a pull
// would rebuild if the catalog held what the local files say: it runs the
// local files through push's emitter and pull's reader. The text pull builds
// for that model is the local file in pull's normal form. What differs between
// it and the text pull builds from the catalog is what the catalog changed, and
// `updatedText` makes only those changes to the local file, inside the JSON
// `data` of a GOOGLE block too.

import {isDeepStrictEqual} from 'node:util';
import * as yaml from 'yaml';

import {SemanticModel} from './ir';
import {modelsFromCatalogResources} from './kc_converter';
import {generateCatalogResources} from './knowledge_catalog';
import {isGoogleVendor, isRecord, loadSemanticModels, SemanticModelError} from './loader';
import {loadProfileFile, plainCopy, ProfileFiles, profileProblems} from './resolve_profiles';
import {withProfileFiles} from './validate';
import {YAML_OPTIONS} from './yaml_options';
import {itemKey, itemKeys, linkNodes, parseForUpdate, spansLines, spliced, updateText} from './yaml_update';

/** The entry group the catalog form is built for. */
export interface CatalogScope {
  project: string;
  location: string;
  entryGroup: string;
}

/**
 * The model a pull would rebuild if the catalog held what the model file `doc`
 * and its profile files say. `profileDocs` gives the profile files. The model
 * and profile files load as push loads them, and their entries are built as
 * push builds them and read back as pull reads them. Returns `error` when a
 * file does not load, push would refuse a profile, or the catalog would hold
 * no model for it.
 *
 * Reading an inherited field's SQL needs the SQL parser, so call
 * `loadSqlEngine()` first.
 */
export function catalogForm(
    doc: {name: string; text: string}, profileDocs: ProfileFiles,
    scope: CatalogScope): {model: SemanticModel}|{error: string} {
  const loaded = loadSemanticModels([doc], {bindingOptional: true});
  if (loaded.error) return {error: loaded.error};
  if (loaded.models.length !== 1) {
    return {error: `'${doc.name}' holds ${loaded.models.length} models`};
  }
  const pushed = withProfileFiles(loaded.models[0], profileDocs);
  if ('errors' in pushed) return {error: pushed.errors[0].error};
  // withProfileFiles leaves out a profile file that does not load, which push
  // reports in a later check (see namedProfileErrors).
  for (const p of profileDocs(doc.name)) {
    try {
      loadProfileFile(p.text, p.name, {skipActions: true});
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
      return {error: err.message};
    }
  }
  // The emitter drops a name the model does not declare, so a profile naming
  // one would read as the catalog's. Push refuses it. Push checks a profile
  // without the model's actions and its own, which are out of scope for the
  // preview (see namedProfileErrors), so this check leaves them out too.
  const logical = {...pushed.model, actions: []};
  for (const profile of logical.profiles ?? []) {
    const [problem] = profileProblems(logical, {...profile, actions: []});
    if (problem) return {error: problem};
  }
  const {entries} = generateCatalogResources(pushed.model, scope);
  const [model] = modelsFromCatalogResources(entries).models;
  return model ? {model} : {error: `'${doc.name}' gives no model`};
}

/**
 * `local`, the text of a local model or profile file, changed by what changes
 * from `base`, the text pull builds for that file, to `pulled`, the text pull
 * builds for it from the catalog. Each part `base` and `pulled` agree on keeps
 * its local text, comments and form, and so does each part they both leave
 * out. Each part that changes is written in pull's form, except inside the
 * JSON `data` of a GOOGLE block, which keeps its layout (see `updatedJson`)
 * when `jsonLayout` is set, or else is the catalog's when it changes. A `data`
 * written as a quoted string over several lines that changes goes on one line
 * as compact JSON (see `updateText`). The local file must parse.
 */
export function updatedText(
    local: string, base: string, pulled: string, jsonLayout = true): string {
  const {document, text} = parseForUpdate(local);
  // A plain copy, so that an alias and its anchor are two values.
  const value = plainCopy(document.toJS());
  const links = linkNodes(value, document.contents);
  const parse = (t: string) => yaml.parse(t, YAML_OPTIONS);
  return updateText(
      text, document, merged(value, parse(base), parse(pulled), jsonLayout),
      links);
}

// The JSON object or list `value` holds when it is a string, or undefined.
function jsonIn(value: unknown): object|undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `data`, the JSON text of a GOOGLE block's `data`, changed to hold `value`
 * in its own layout (see `updatedJson`), or undefined when it cannot be.
 */
export function updatedData(data: string, value: unknown): string|undefined {
  // A string that ends in a blank line is written double-quoted, since a
  // `|+` block would take the blank lines after it, so a changed `data`
  // ends in one line break and stays a block. DEL, the C1 controls and the
  // line and paragraph separators are written as JSON escapes, since a string
  // that holds one is double-quoted.
  return updatedJson(data, value)
      ?.replace(/\n\s*$/, '\n')
      .replace(/[\x7f-\x9f\u2028\u2029]/g,
               c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// `text`, a JSON object or list, changed to hold `value`, or undefined when
// the yaml library reads `text` as another value, as with a lone carriage
// return. Each part whose value stays keeps its text, and a changed scalar is
// written in place. A removed key or item goes with its comma. A new one goes
// after the entry it follows in `value`, with its container's separator. A
// new item copies the text of the item beside it: its brackets and the gaps
// between its entries, with each nested value written like that item's value
// at the same key, or like its first item. A new key takes the gap after the
// key beside it. A list whose entries change order is
// written again in the new order, each entry keeping its own text. A container
// whose entries cannot be matched one to one, or that loses every entry, is
// written again, as is a value that changes shape. An empty list or object
// that gains entries takes its container's layout.
function updatedJson(text: string, value: unknown): string|undefined {
  const doc = yaml.parseDocument(text);
  if (doc.errors.length || !isDeepStrictEqual(doc.toJS(), JSON.parse(text))) {
    return undefined;
  }
  const edits: Array<[number, number, string]> = [];
  const rangeOf = (node: yaml.Node) => node.range!;
  // Where an entry's text starts and ends: a pair's key and value, or an item.
  const startOf = (item: unknown) =>
      rangeOf((yaml.isPair(item) ? item.key : item) as yaml.Node)[0];
  const endOf = (item: unknown) =>
      rangeOf((yaml.isPair(item) ? item.value : item) as yaml.Node)[1];
  // The separators the text writes between a key and its value, between two
  // entries on one line, and inside the brackets of a list or object on one
  // line: those of the first pair written on one line, the first one-line gap
  // between two entries, and the first one-line list and object.
  let colon: string|undefined;
  let comma: string|undefined;
  const pad: {map?: string, seq?: string} = {};
  yaml.visit(doc, {
    Pair: (_, {key, value}) => {
      if (!yaml.isNode(key) || !yaml.isNode(value)) return;
      const gap = text.slice(rangeOf(key)[1], rangeOf(value)[0]);
      if (!gap.includes('\n')) colon ??= gap;
    },
    Collection: (_, node) => {
      const {items} = node;
      for (let i = 1; i < items.length && comma === undefined; i++) {
        const gap = text.slice(endOf(items[i - 1]), startOf(items[i]));
        if (!gap.includes('\n')) comma = gap;
      }
      if (items.length && !spansLines(text, node)) {
        pad[yaml.isMap(node) ? 'map' : 'seq'] ??=
            text.slice(rangeOf(node)[0] + 1, startOf(items[0]));
      }
    },
  });
  const kv = colon ?? ': ';
  const sep1 = comma ?? (kv === ':' ? ',' : ', ');
  const flat = (v: unknown): string => Array.isArray(v) ?
      (v.length ? `[${pad.seq ?? ''}${v.map(flat).join(sep1)}${pad.seq ?? ''}]` :
                  '[]') :
      isRecord(v) ?
      (Object.keys(v).length ?
           `{${pad.map ?? ''}${
               Object.entries(v)
                   .map(([k, x]) => JSON.stringify(k) + kv + flat(x))
                   .join(sep1)}${pad.map ?? ''}}` :
           '{}') :
      JSON.stringify(v);
  const indentAt = (at: number) => {
    const start = text.lastIndexOf('\n', at - 1) + 1;
    return {column: at - start, indent: /^[ \t]*/.exec(text.slice(start))![0]};
  };
  // `v` written over lines as `JSON.stringify` indents it by `step`, after
  // the indentation `indent`, when `lines` is set, or else on one line.
  const json = (v: unknown, indent: string, step: string, lines: boolean) =>
      lines && typeof v === 'object' && v !== null ?
      JSON.stringify(v, null, step).replace(/\n/g, `\n${indent}`) :
      flat(v);
  // The indentation of the line `node` starts on, the indent step of its
  // entries, and whether `node` is written as `JSON.stringify` indents it.
  const layout = (node: yaml.Node) => {
    const [from, to] = rangeOf(node);
    const {indent} = indentAt(from);
    const items = yaml.isCollection(node) ? node.items : [];
    const child = items.length ? indentAt(startOf(items[0])) : undefined;
    const step = child && child.column === child.indent.length &&
            child.indent.startsWith(indent) &&
            child.indent.length > indent.length ?
        child.indent.slice(indent.length) :
        '  ';
    const lines = spansLines(text, node) &&
        text.slice(from, to) === json(node.toJS(doc), indent, step, true);
    return {indent, step, lines};
  };
  // `x` written like the list or object `near`: its brackets, and the gaps
  // after its opening bracket, between its entries, after each key and before
  // its closing bracket. Each nested value is written like `near`'s value at
  // the same key, or like its first item. Undefined when `near` is not a list
  // or object with entries, of the kind `x` is.
  const like = (x: unknown, near: yaml.Node|undefined): string|undefined => {
    const isMap = yaml.isMap(near) && isRecord(x);
    if (!near || !isMap && !(yaml.isSeq(near) && Array.isArray(x))) {
      return undefined;
    }
    const items = (near as yaml.YAMLMap|yaml.YAMLSeq).items as unknown[];
    if (!items.length) return undefined;
    const [from, to] = rangeOf(near);
    const open = text.slice(from + 1, startOf(items[0]));
    const close = text.slice(endOf(items[items.length - 1]), to - 1);
    const sep = items.length > 1 ? text.slice(endOf(items[0]), startOf(items[1])) :
        open.includes('\n')      ? `,${open}` :
                                   sep1;
    const nested = (v: unknown, n: yaml.Node|undefined) => like(v, n) ??
        (open.includes('\n') ?
             json(v, indentAt(startOf(items[0])).indent, layout(near).step,
                  layout(near).lines) :
             flat(v));
    const pairs = items as yaml.Pair[];
    const entries = isMap ?
        Object.entries(x).map(([k, v]) => {
          const pair = pairs.find(
              p => String((p.key as yaml.Scalar).value) === k) ?? pairs[0];
          const gap = text.slice(
              rangeOf(pair.key as yaml.Node)[1],
              rangeOf(pair.value as yaml.Node)[0]);
          return JSON.stringify(k) + gap +
              nested(v, pair === pairs[0] &&
                                String((pair.key as yaml.Scalar).value) !== k ?
                         undefined :
                         pair.value as yaml.Node);
        }) :
        (x as unknown[]).map(v => nested(v, items[0] as yaml.Node));
    const [l, r] = isMap ? ['{', '}'] : ['[', ']'];
    return entries.length ? l + open + entries.join(sep) + close + r : l + r;
  };
  // `node` written again to hold `v`. An empty list or object takes the
  // layout of `parent`, its container.
  const write = (node: yaml.Node, v: unknown, parent?: yaml.Node) => {
    const empty = yaml.isCollection(node) && !node.items.length;
    const {indent, step, lines} = layout(empty && parent ? parent : node);
    edits.push([
      ...rangeOf(node).slice(0, 2) as [number, number],
      json(v, empty ? indentAt(rangeOf(node)[0]).indent : indent, step,
           empty && parent ? lines : spansLines(text, node)),
    ]);
  };
  const edit = (node: yaml.Node, v: unknown, parent?: yaml.Node): void => {
    if (isDeepStrictEqual(node.toJS(doc), v)) return;
    const isMap = yaml.isMap(node) && isRecord(v);
    if (!isMap && !(yaml.isSeq(node) && Array.isArray(v))) {
      return write(node, v, parent);
    }
    // Each entry of the node, with its key, where its text starts and ends,
    // its value's node, and the gap after its key.
    const items = (node as yaml.YAMLMap|yaml.YAMLSeq).items.map(item => {
      const n = (isMap ? (item as yaml.Pair).value : item) as yaml.Node;
      return {
        key: isMap ? String(((item as yaml.Pair).key as yaml.Scalar).value) :
                     itemKey(n.toJS(doc)),
        from: startOf(item),
        to: rangeOf(n)[1],
        node: n,
        gap: isMap ? text.slice(rangeOf((item as yaml.Pair).key as yaml.Node)[1],
                                rangeOf(n)[0]) :
                     '',
      };
    });
    const entries: Array<[string, unknown]> = isMap ?
        Object.entries(v) :
        (v as unknown[]).map(x => [itemKey(x), x]);
    if (!items.length || !entries.length) return write(node, v, parent);
    const keys = entries.map(([k]) => k);
    const {indent, step, lines} = layout(node);
    // The first entry's line, which it starts when the entries are on their
    // own lines.
    const first = indentAt(items[0].from);
    const sep = items.length > 1 ? text.slice(items[0].to, items[1].from) :
        first.column === first.indent.length ? `,\n${first.indent}` :
                                               sep1;
    // `x` as a new entry. A new item is written like the item `near` beside
    // it. A new key takes the gap after `near`'s key, and its value, which
    // `near` lacks, is written like its container.
    const fresh = (k: string, x: unknown, near: (typeof items)[number]) => {
      const nearby = layout(near.node);
      return (isMap ? JSON.stringify(k) + near.gap : '') +
          ((isMap ? undefined : like(x, near.node)) ??
           (nearby.lines ? json(x, nearby.indent, nearby.step, true) :
                           json(x, indent + step, step, lines)));
    };
    const kept = items.filter(i => keys.includes(i.key));
    const unique = (ks: string[]) => new Set(ks).size === ks.length;
    const matched = unique(keys) && unique(items.map(i => i.key));
    if (!kept.length || !matched ||
        !isDeepStrictEqual(kept.map(i => i.key),
                           keys.filter(k => kept.some(i => i.key === k)))) {
      // The entries again, from the first to the last, each matched one
      // keeping its own text with its changes made.
      const texts = entries.map(([k, x]) => {
        const item = matched ? items.find(i => i.key === k) : undefined;
        if (!item) return fresh(k, x, items[0]);
        const mark = edits.length;
        edit(item.node, x, node);
        return spliced(
            text.slice(item.from, item.to),
            edits.splice(mark).map(
                ([a, b, s]) => [a - item.from, b - item.from, s] as const));
      });
      edits.push([items[0].from, items[items.length - 1].to, texts.join(sep)]);
      return;
    }
    // Each run of removed entries goes with the commas around it.
    for (let a = 0; a < items.length; a++) {
      if (keys.includes(items[a].key)) continue;
      let b = a;
      while (b + 1 < items.length && !keys.includes(items[b + 1].key)) b++;
      const next = items[b + 1];
      edits.push(next ? [items[a].from, next.from, ''] :
                        [items[a - 1].to, items[b].to, '']);
      a = b;
    }
    // Each kept entry changes in place, and each new one goes after the kept
    // entry it follows, or before the first entry.
    let after: (typeof items)[number]|undefined;
    for (const [k, x] of entries) {
      const item = items.find(i => i.key === k);
      if (item) {
        edit(item.node, x, node);
        after = item;
        continue;
      }
      const entry = fresh(k, x, after ?? items[0]);
      edits.push(after ? [after.to, after.to, sep + entry] :
                         [items[0].from, items[0].from, entry + sep]);
    }
  };
  edit(doc.contents as yaml.Node, value);
  return spliced(text, edits);
}

// `local` changed by what changes from `base` to `pulled`, three values at the
// same place in the local file, in pull's form of it, and in pull's form of
// the catalog's file. A value the two forms agree on is the local one, as
// written. A value of another shape in the local file is replaced whole.
//
// `json` marks the `data` of a GOOGLE block, the JSON string that holds a
// vanilla model's deployments and profiles, which pull writes from its value.
// It keeps its layout when `jsonLayout` is set. Any other string, such as
// another vendor's `data`, comes back as the catalog holds it.
function merged(
    local: unknown, base: unknown, pulled: unknown, jsonLayout: boolean,
    json = false, statements = false): unknown {
  if (isDeepStrictEqual(base, pulled)) return local;
  const [l, b, p] = [local, base, pulled].map(jsonIn);
  if (json && l !== undefined && b !== undefined && p !== undefined) {
    return updatedData(local as string, merged(l, b, p, jsonLayout)) ?? pulled;
  }
  if (isRecord(local) && isRecord(base) && isRecord(pulled)) {
    const entries = mergedEntries(
        Object.entries(local), Object.entries(base), Object.entries(pulled),
        false, jsonLayout, jsonLayout && isGoogleVendor(local.vendor_name));
    return Object.fromEntries(entries!);
  }
  if (Array.isArray(local) && Array.isArray(base) && Array.isArray(pulled)) {
    // An action statement matches trimmed, as pull reads it, so a '|' block's
    // final line break keeps it the same statement.
    const read = (v: unknown) =>
        statements && typeof v === 'string' ? v.trim() : v;
    // A key two items of one of the lists share matches by value in all three.
    const repeated = new Set([local, base, pulled].flatMap(items => {
      const keys = items.map(v => itemKey(read(v)));
      return keys.filter((k, i) => keys.indexOf(k) !== i);
    }));
    const keyed = (items: unknown[]) => {
      const keys = itemKeys(items.map(read), repeated);
      return items.map((v, i) => [keys[i], v] as const);
    };
    const entries = mergedEntries(
        keyed(local), keyed(base), keyed(pulled), true, jsonLayout);
    return entries ? entries.map(([, v]) => v) : pulled;
  }
  return pulled;
}

// The entries of `local`, a mapping's or a list's, each changed by what
// changes from `base` to `pulled`. An entry `base` has and `pulled` does not
// goes. An entry the local file does not have and `pulled` changes, such as
// one only `pulled` has, goes after the entry it follows in `pulled`. A local
// entry `base` does not have, such as a `profile: default` pull leaves out,
// stays. The local order stays unless the entries both forms have are in
// another order in `pulled`, as when a list whose order means something
// changes order.
//
// A list's entries must match one to one across the three values. Undefined
// when two items of a list have one key, or when a local item has no
// counterpart in `base` or one there has none in the local list, as when an
// item is written in another form.
function mergedEntries<K>(
    local: ReadonlyArray<readonly [K, unknown]>,
    base: ReadonlyArray<readonly [K, unknown]>,
    pulled: ReadonlyArray<readonly [K, unknown]>, isList: boolean,
    jsonLayout: boolean, googleBlock = false): Array<[K, unknown]>|undefined {
  const [l, b, p] = [local, base, pulled].map(e => new Map(e));
  if (isList &&
      (l.size < local.length || b.size < base.length ||
       p.size < pulled.length || l.size !== b.size ||
       local.some(([k]) => !b.has(k)))) {
    return undefined;
  }
  const keysOf = (entries: ReadonlyArray<readonly [K, unknown]>) =>
      entries.map(([k]) => k);
  const shared = (keys: K[]) => keys.filter(k => b.has(k) && p.has(k));
  const sameOrder =
      isDeepStrictEqual(shared(keysOf(base)), shared(keysOf(pulled)));
  // Two forms of a mapping give its keys in one order, so only a list's
  // entries, which match one to one, can come in another order.
  const order =
      sameOrder ? keysOf(local) : keysOf(pulled).filter(k => b.has(k));
  const keys = order.filter(k => !b.has(k) || p.has(k));
  pulled.forEach(([k, v], i) => {
    if (l.has(k) || b.has(k) && isDeepStrictEqual(b.get(k), v)) return;
    const before = pulled.slice(0, i).reverse().find(([j]) => keys.includes(j));
    keys.splice(before ? keys.indexOf(before[0]) + 1 : 0, 0, k);
  });
  return keys.map(k => [
    k,
    !l.has(k)              ? p.get(k) :
        !b.has(k) && !p.has(k) ? l.get(k) :
                                 merged(l.get(k), b.get(k), p.get(k),
                                        jsonLayout,
                                        googleBlock && k === 'data',
                                        !isList && k === 'statements'),
  ]);
}
