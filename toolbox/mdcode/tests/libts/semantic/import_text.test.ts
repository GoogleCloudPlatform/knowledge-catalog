// Tests that kcmd import changes only the parts of a file it changes, over
// generated files (import_model.ts and yaml_update.ts). Each file is written
// in one style and goes through one change; the parts the change leaves must
// come back byte for byte.

import {expect, test} from 'bun:test';
import * as yaml from 'yaml';

import {importSemanticModelYaml} from '../../../src/libts/semantic/import_model';

// How a generated file is written.
interface Style {
  step: number;  // From a key to the keys under it.
  seqIndent: number;  // From a key to the `-` of its list.
  comments: boolean;  // A comment above each item and after each line.
  blanks: boolean;  // A blank line above each item.
  quote: 'plain'|'single'|'double'|'mixed';
  block: boolean;  // SQL with a `(` as a `|-` block scalar.
  flow: 'none'|'lists'|'expressions'|'lines';
  nl: string;
  bom: boolean;
  finalNewline: boolean;
  exprFirst: boolean;  // `expression` before `dialect` in a dialect entry.
  space: number;  // Spaces before a comment after a value.
  nextLine: boolean;  // An expression's text on the line under its key.
  afterList: boolean;  // A comment after each list.
  markers: boolean;  // `---` and `...` around the document.
}
const STYLE: Style = {
  step: 2, seqIndent: 2, comments: true, blanks: true, quote: 'mixed',
  block: false, flow: 'none', nl: '\n', bom: false, finalNewline: true,
  exprFirst: false, space: 2, nextLine: false, afterList: false,
  markers: false,
};

const isObj = (v: any) => v !== null && typeof v === 'object';
const full = (v: any) => isObj(v) && Object.keys(v).length > 0;

// `value` as YAML in style `s`. Every comment is different.
function write(value: any, s: Style): string {
  const out: string[] = [];
  let n = 0;
  let q = 0;
  const pad = (c: number) => ' '.repeat(c);
  const after = () => s.comments ? `${pad(s.space)}# t${n++}` : '';
  const above = (c: number) => {
    if (s.blanks) out.push('');
    if (s.comments) out.push(`${pad(c)}# o${n++}`);
  };
  const scalar = (v: any, inFlow: boolean): string => {
    const style =
        s.quote === 'mixed' ? ['plain', 'single', 'double'][q++ % 3] : s.quote;
    if (typeof v !== 'string' || v.includes('\n') || style === 'double') {
      return JSON.stringify(v);
    }
    if (style === 'single') return `'${v.replaceAll("'", "''")}'`;
    const plain = yaml.stringify(v, {lineWidth: 0}).trimEnd();
    return inFlow && /[,[\]{}]/.test(plain) ? JSON.stringify(v) : plain;
  };
  const order = (v: any) =>
      s.exprFirst && 'dialect' in v ? {expression: v.expression, ...v} : v;
  const flow = (v: any): string => Array.isArray(v) ?
      `[${v.map(flow).join(', ')}]` :
      isObj(v) ? `{${
                     Object.entries(order(v))
                         .map(([k, x]) => `${k}: ${flow(x)}`)
                         .join(', ')}}` :
                 scalar(v, true);
  // Writes `v` after `head`, which ends in `:` or `-` at column `c`.
  const val = (head: string, v: any, c: number, inner: number, key = '') => {
    const expr = key === 'expression';
    if (s.flow === 'lines' && expr && full(v) && !Array.isArray(v)) {
      // `{` and `[` end their lines, and each entry has a line.
      out.push(`${head} {${after()}`);
      for (const [k, x] of Object.entries(v) as Array<[string, any[]]>) {
        out.push(`${pad(inner)}${k}: [${after()}`);
        x.forEach((y, i) => out.push(`${pad(inner + 2)}${flow(y)}${
                                         i < x.length - 1 ? ',' : ''}${after()}`));
        out.push(`${pad(inner)}]`);
      }
      out.push(`${pad(inner - 2)}}${after()}`);
    } else if (
        !full(v) && isObj(v) ||
        full(v) && (s.flow === 'expressions' && expr ||
                    s.flow === 'lists' && v.every?.((x: any) => !isObj(x)))) {
      out.push(`${head} ${flow(v)}${after()}`);
    } else if (Array.isArray(v)) {
      out.push(head + after());
      for (const x of v) item(x, c + s.seqIndent);
      if (s.afterList && s.comments) out.push(`${pad(c + s.seqIndent)}# a${n++}`);
    } else if (isObj(v)) {
      out.push(head + after());
      pairs(order(v), c + s.step);
    } else if (s.nextLine && expr) {
      out.push(head + after(), ...(s.blanks ? [''] : []),
               `${pad(inner)}${scalar(v, false)}${after()}`);
    } else if (s.block && v.includes?.('(')) {
      out.push(`${head} |-${after()}`, pad(inner) + v);
    } else {
      out.push(`${head} ${scalar(v, false)}${after()}`);
    }
  };
  const item = (v: any, c: number) => {
    above(c);
    if (full(v) && !Array.isArray(v)) pairs(order(v), c + 2, `${pad(c)}- `);
    else val(`${pad(c)}-`, v, c, c + 2);
  };
  const pairs = (v: any, c: number, dash?: string) => {
    Object.entries(v).forEach(([k, x], i) => {
      if (i > 0 || !dash) above(c);
      val(`${i === 0 && dash ? dash : pad(c)}${k}:`, x, c, c + s.step, k);
    });
  };
  if (s.comments) out.push('# header', '');
  if (s.markers) out.push('---');
  pairs(value, 0);
  if (s.comments) out.push('# end of file');
  if (s.markers) out.push('...');
  const text = out.join('\n').replace(/^\n+/, '') + (s.finalNewline ? '\n' : '');
  return (s.bom ? '﻿' : '') + text.replaceAll('\n', s.nl);
}

// Lines of a text that a node import changed takes up.
interface Side {
  text: string;
  starts: number[];
  /** Lines of removed items and their comments, which may go. */
  gone: Set<number>;
  /** Lines of changed or added nodes, whose comments must stay. */
  changed: Set<number>;
}
const side = (text: string): Side => ({
  text,
  starts: [0, ...[...text.matchAll(/\n/g)].map(m => m.index! + 1)],
  gone: new Set(),
  changed: new Set(),
});
const lineOf = (s: Side, p: number) =>
    s.starts.filter(start => start <= p).length - 1;
const lineText = (s: Side, i: number) =>
    s.text.slice(s.starts[i], s.starts[i + 1] ?? s.text.length);
const before = (s: Side, p: number) => s.text.slice(s.starts[lineOf(s, p)], p);
const mark = (set: Set<number>, [a, b]: number[]) => {
  for (let i = a; i <= b; i++) set.add(i);
};
const isBlank = (line: string) => line.trim() === '';
const isComment = (line: string) => /^\s*#/.test(line);
const canonical = (v: unknown) => JSON.stringify(
    v, (_, x) => isObj(x) && !Array.isArray(x) ?
        Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : 1)) :
        x);
const RENAMED: Record<string, string> = {
  datasets: 'entities',
  entities: 'datasets',
};
const keyOf = (p: any) => String(p.key.value);

function startOf(node: any, item: any): number {
  if (yaml.isPair(item)) return (item.key as any).range[0];
  if (node.flow) return item.range[0];
  const dashes = node.srcToken.items.flatMap(
      (t: any) => t.start.filter((s: any) => s.type === 'seq-item-ind'));
  return dashes[node.items.indexOf(item)].offset;
}

// The lines of `item`. Comment lines after a block item at its column or
// less are above the next item.
function span(s: Side, node: any, item: any): number[] {
  const start = startOf(node, item);
  const last = yaml.isPair(item) ? item.value ?? item.key : item;
  let at = last.range[node.flow ? 1 : 2];
  if (!node.flow && isBlank(before(s, at))) at = s.starts[lineOf(s, at)];
  const end = lineOf(s, at - 1);
  const col = before(s, start).length;
  let i = end;
  let cut = false;
  for (; i > lineOf(s, start); i--) {
    const line = lineText(s, i);
    if (!isBlank(line) && (!isComment(line) || line.search(/\S/) > col)) break;
    cut ||= !isBlank(line);
  }
  return [lineOf(s, start), cut && !node.flow ? i : end];
}

// Marks a removed item: its lines, and those of the comments and blank lines
// above it. A first item also takes the blank lines under it.
function removed(s: Side, node: any, i: number) {
  const [a, b] = span(s, node, node.items[i]);
  const start = startOf(node, node.items[i]);
  if (node.flow) {
    const own = isBlank(before(s, start)) &&
        /^\s*,?\s*(#.*)?\s*$/.test(lineText(s, b).slice(
            (yaml.isPair(node.items[i]) ? node.items[i].value : node.items[i])
                .range[1] - s.starts[b]));
    return mark(own ? s.gone : s.changed, [a, b]);
  }
  mark(s.gone, [a, b]);
  if (!isBlank(before(s, start))) return;
  const floor = i > 0 ? span(s, node, node.items[i - 1])[1] : -1;
  const quiet = (k: number) => isBlank(lineText(s, k)) || isComment(lineText(s, k));
  for (let k = a - 1; k > floor && quiet(k); k--) s.gone.add(k);
  const last = s.starts.length - 1;
  for (let k = b + 1; i === 0 && k <= last && isBlank(lineText(s, k)); k++) {
    s.gone.add(k);
  }
}

// Marks the lines of the nodes that differ between `a` in `x` and `b` in
// `y`, and returns whether the two hold the same value. Each problem with the
// style of a changed part goes into `problems`.
function align(
    x: Side, y: Side, a: any, b: any, problems: string[]): boolean {
  if (yaml.isScalar(a) && yaml.isScalar(b)) {
    if (a.value === b.value) return true;
    // A changed scalar keeps its quoting and the text around it on its line.
    const around = (s: Side, n: any) => {
      const line = lineOf(s, n.range[1]);
      if (lineOf(s, n.range[0]) !== line) return undefined;
      const after = lineText(s, line).slice(n.range[1] - s.starts[line]);
      return `${before(s, n.range[0])}|${after}`;
    };
    if (typeof b.value === 'string' && !b.value.includes('\n') &&
        typeof a.value === 'string' && a.type !== b.type ||
        around(x, a) && around(y, b) && around(x, a) !== around(y, b)) {
      problems.push(`style of ${JSON.stringify(a.value)} changed`);
    }
    return false;
  }
  if (!(yaml.isMap(a) && yaml.isMap(b)) && !(yaml.isSeq(a) && yaml.isSeq(b))) {
    return false;
  }
  const as = a.items as any[];
  const bs = b.items as any[];
  const same = (p: any, q: any) => {
    if (yaml.isPair(p)) {
      return keyOf(p) === keyOf(q) || RENAMED[keyOf(p)] === keyOf(q);
    }
    const [pv, qv] = [p.toJSON(), q.toJSON()];
    if (typeof pv?.name === 'string') return pv.name === qv?.name;
    if (typeof pv?.dialect === 'string') {
      return pv.dialect.toUpperCase() === String(qv?.dialect).toUpperCase();
    }
    return canonical(pv) === canonical(qv);
  };
  const pairs: number[][] = [];
  as.forEach((p, i) => {
    const j = bs.findIndex((q, j) => !pairs.some(([, k]) => k === j) && same(p, q));
    if (j >= 0) pairs.push([i, j]);
    else removed(x, a, i);
  });
  // An item whose first key goes moves up onto the `- ` line, with the
  // comments above that key.
  const pulled = !a.flow && yaml.isPair(as[0]) && !pairs.some(([i]) => i === 0) &&
      !isBlank(before(x, startOf(a, as[0])));
  for (const [i, j] of pairs) {
    const [p, q] = [as[i], bs[j]];
    if (pulled && i === pairs[0][0]) {
      const lx = lineOf(x, startOf(a, p));
      const ly = lineOf(y, startOf(b, q));
      [x.changed.add(lx), y.changed.add(ly)];
      const moved = new Set<string>();
      for (let k = lx - 1; k >= 0 && !x.gone.has(k) &&
           (isBlank(lineText(x, k)) || isComment(lineText(x, k)));
           k--) {
        x.changed.add(k);
        if (!isBlank(lineText(x, k))) moved.add(lineText(x, k).trim());
      }
      const indent = (line: string) => line.length - line.trimStart().length;
      for (let k = ly - 1; moved.has(lineText(y, k).trim()); k--) {
        y.changed.add(k);
        if (indent(lineText(y, k)) !== indent(lineText(y, ly))) {
          problems.push('a moved comment is not indented as its `- ` line');
        }
      }
    }
    if (yaml.isPair(p) && keyOf(p) !== keyOf(q)) {
      x.changed.add(lineOf(x, startOf(a, p)));
      y.changed.add(lineOf(y, startOf(b, q)));
    }
    const kept = yaml.isPair(p) ? align(x, y, p.value, q.value, problems) :
                                  align(x, y, p, q, problems);
    if (!kept) {
      mark(x.changed, span(x, a, p));
      mark(y.changed, span(y, b, q));
    }
  }
  bs.forEach((q, j) => {
    if (!pairs.some(([, k]) => k === j)) mark(y.changed, span(y, b, q));
  });
  const touched = pairs.length !== as.length || pairs.length !== bs.length ||
      pairs.some(([i, j]) => canonical(as[i].toJSON()) !==
                     canonical(bs[j].toJSON()));
  // In a flow list that gives each item a line, a new item gets one too.
  const own = (s: Side, n: any) =>
      n.items.every((it: any) => isBlank(before(s, startOf(n, it))));
  if (touched && a.flow && b.flow && as.length > 0 && own(x, a) && !own(y, b)) {
    problems.push('a flow item lost its line');
  }
  return !(touched && a.flow) && as.length > 0 === bs.length > 0;
}

// Each distance from a key to the key or `-` under it, and from a `-` to the
// mapping after it, in `text`.
function widths(s: Side): Set<string> {
  const found = new Set<string>();
  const col = (p: number) => before(s, p).length;
  yaml.visit(yaml.parseDocument(s.text, {keepSourceTokens: true}), {
    Pair: (_, p: any) => {
      const v = p.value;
      if (!yaml.isCollection(v) || v.flow || v.items.length === 0) return;
      const at = startOf(v, v.items[0]);
      const kind = yaml.isMap(v) ? 'map' : 'seq';
      found.add(`${kind} ${col(at) - col(p.key.range[0])}`);
      const first = v.items[0];
      if (yaml.isMap(first) && !first.flow) {
        found.add(`item ${col((first.items[0].key as any).range[0]) - col(at)}`);
      }
    },
  });
  return found;
}

// Each comment of `s`, with its line and the key on the line where the
// token before it starts, if any.
function comments(s: Side) {
  let at = 0;
  let last = 0;
  return [...new yaml.Lexer().lex(s.text)].flatMap(token => {
    const p = at;
    if (!['\u0002', '\u0018', '\u001f'].includes(token)) at += token.length;
    if (token[0] !== '#') {
      if (token.trim()) last = p;
      return [];
    }
    const line = lineOf(s, p);
    const key = /^\s*(?:-\s+)?([\w"']+)\s*:/.exec(lineText(s, lineOf(s, last)))?.[1] ?? '';
    return [{token, line, key, after: !isBlank(before(s, p))}];
  });
}

// What `output` keeps of `input` outside the nodes import changed, and each
// way a changed part leaves the file's style.
function check(input: string, output: string) {
  const x = side(input);
  const y = side(output);
  const problems: string[] = [];
  align(x, y, yaml.parseDocument(input, {keepSourceTokens: true}).contents,
        yaml.parseDocument(output, {keepSourceTokens: true}).contents, problems);
  const rest = (s: Side) => s.starts.map((_, i) => i)
                                .filter(i => !s.gone.has(i) && !s.changed.has(i))
                                .map(i => lineText(s, i));
  const inOut = comments(y);
  for (const c of comments(x).filter(c => !x.gone.has(c.line))) {
    // A comment after a value stays after its key, or after what takes the
    // place of the value it follows.
    const d = inOut.find(d => d.token === c.token);
    const kept = d && (!c.after || d.after &&
        (c.key === d.key || RENAMED[c.key] === d.key ||
         c.key === '' && y.changed.has(d.line)));
    if (!kept) problems.push(`${c.token} moved`);
  }
  const wx = [...widths(x)];
  for (const w of widths(y)) {
    if (!wx.includes(w) && wx.some(v => v.split(' ')[0] === w.split(' ')[0])) {
      problems.push(`new indentation: ${w}`);
    }
  }
  if (input.includes('\r\n') && /(^|[^\r])\n/.test(output)) problems.push('LF');
  if (input[0] !== output[0]) problems.push('first character');
  for (const i of y.changed) {
    if (/[ \t]\r?\n?$/.test(lineText(y, i))) problems.push('trailing space');
  }
  return {input: rest(x), output: rest(y), problems};
}

// The models and the changes import makes to them.
const BQ = 'bigquery.googleapis.com/projects/acme/datasets/sales/tables/orders';
const CASE = "CASE WHEN orders.status = 'open' THEN 1 ELSE 0 END";
const sql = (expression: string, dialect = 'ANSI_SQL') =>
    ({dialects: [{dialect, expression}]});
const vanilla = (): any => ({
  version: '0.2.0.dev0',
  semantic_model: [{
    name: 'retail',
    description: 'Orders from the web store, the mobile app and the call centre.',
    datasets: [{
      name: 'orders',
      source: BQ,
      primary_key: ['order_id'],
      description: 'Net revenue after refunds and discounts,\nin US dollars.',
      fields: [
        {name: 'order_id', datatype: 'Integer', expression: sql('orders.order_id')},
        {name: 'status', expression: sql(CASE)},
      ],
    }],
    relationships: [],
    metrics: [{name: 'order_count', expression: sql('COUNT(orders.order_id)')}],
    ai_context: {instructions: 'Prefer net revenue'},
  }],
});
const google = (): any => {
  const {datasets, ...model} = vanilla().semantic_model[0];
  for (const f of datasets[0].fields) {
    f.expression = f.expression.dialects[0].expression;
  }
  const {relationships, metrics, ai_context, ...head} = model;
  return {
    version: '0.2.0.dev0/google',
    semantic_model: [{
      ...head,
      entities: datasets,
      relationships,
      metrics: [{
        name: 'order_count',
        entity: 'orders',
        expression: 'COUNT(orders.order_id)',
      }],
      ai_context,
    }],
  };
};
const ds = (m: any) =>
    m.semantic_model[0].datasets ?? m.semantic_model[0].entities;
const fields = (m: any) => ds(m)[0].fields;
const changed = (model: () => any, change: (m: any) => void) => () => {
  const m = model();
  change(m);
  return m;
};
const related = (model: () => any, relationship: object) => changed(model, m => {
  const g = m.version.endsWith('google');
  const expr = (e: string) => g ? e : sql(e);
  ds(m).push({
    name: 'customers', source: BQ.replace('orders', 'customers'),
    primary_key: ['customer_id'],
    fields: [{name: 'customer_id', expression: expr('customers.customer_id')}],
  });
  fields(m).push({name: 'customer_id', expression: expr('orders.customer_id')});
  m.semantic_model[0].relationships = [{
    name: 'placed_by', from: 'orders', to: 'customers',
    from_columns: ['customer_id'], to_columns: ['customer_id'], ...relationship,
  }];
});
const ROW_COUNT = {name: 'row_count', expression: sql('COUNT(*)')};
const MDX = {dialect: 'MDX', expression: '[Orders]'};
const STRICT = {strict: true, flavor: 'google'} as const;
const CHANGES: Array<[string, () => any, object?]> = [
  ['a datatype rewritten', changed(vanilla, m => fields(m)[0].datatype = 'integer')],
  ['a source completed', changed(vanilla, m => ds(m)[0].source = 'orders'),
   {sourcePrefix: BQ.replace('/tables/orders', '')}],
  ['a description cut', changed(vanilla, m => ds(m)[0].description = `Orders.${' Orders.'.repeat(129)}\n\n`.repeat(2))],
  ['a key removed', changed(vanilla, m => {
     const {name, ...rest} = fields(m)[1];
     fields(m)[1] = {name, datatype: 'Opaque', ...rest};
   })],
  ['a first key removed', changed(vanilla, m => fields(m)[1] = {datatype: 'Opaque', ...fields(m)[1]})],
  ['a query source removed', changed(google, m => ds(m)[0].source = 'SELECT * FROM orders')],
  ['a last dialect removed', changed(vanilla, m => fields(m)[0].expression.dialects.push(MDX))],
  ['a first dialect removed', changed(vanilla, m => fields(m)[0].expression.dialects.unshift(MDX))],
  ['a first metric removed', changed(vanilla, m => m.semantic_model[0].metrics.unshift(ROW_COUNT))],
  ['a last metric removed', changed(vanilla, m => m.semantic_model[0].metrics.push(ROW_COUNT))],
  ['every metric removed', changed(vanilla, m => m.semantic_model[0].metrics = [ROW_COUNT])],
  ['an extra model removed', changed(vanilla, m => m.semantic_model.push({name: 'other', datasets: []}))],
  ['a dialect entry added', changed(vanilla, m => fields(m)[0].expression = sql('NVL(orders.order_id, 0)', 'SNOWFLAKE')),
   {transpile: true}],
  ['a string expression translated', changed(google, m => fields(m)[0].expression = '"orders"."order_id"'),
   {transpile: true}],
  ['a string expression wrapped', changed(vanilla, m => fields(m)[0].expression = 'orders.order_id')],
  ['a third-party file adapted to Google', changed(vanilla, m => m.semantic_model[0].ai_context.owner = 'analytics'),
   {flavor: 'google'}],
  ['a relationship description moved', related(vanilla, {description: 'One customer.'})],
  ['a conversion to Google', related(vanilla, {custom_extensions: [{vendor_name: 'GOOGLE', data: '{"description":"One customer."}'}]}),
   STRICT],
  ['a conversion to vanilla', google, {...STRICT, flavor: 'ossie'}],
  ['a conversion to vanilla with a profile file', google, {
     ...STRICT, flavor: 'ossie',
     profileFiles: [{fileName: 'retail.profile.prod.yaml', content: `name: prod\nentities:\n  - name: orders\n    source: ${BQ}\n`}],
   }],
];
const STYLES: Array<[string, Partial<Style>]> = [
  ['comments, blank lines and mixed quoting', {}],
  ['no comments or blank lines', {comments: false, blanks: false}],
  ['comments only', {blanks: false}],
  ['blank lines only', {comments: false}],
  ['plain scalars', {quote: 'plain'}],
  ['single quotes', {quote: 'single'}],
  ['double quotes', {quote: 'double'}],
  ['block scalars', {block: true}],
  ['flow lists of scalars', {flow: 'lists'}],
  ['flow expressions', {flow: 'expressions'}],
  ['flow expressions over several lines', {flow: 'lines'}],
  ['four-space indentation', {step: 4, seqIndent: 4}],
  ['four-space indentation, lists level with keys', {step: 4, seqIndent: 0}],
  ['lists level with keys', {seqIndent: 0}],
  ['CRLF', {nl: '\r\n'}],
  ['a byte order mark', {bom: true}],
  ['no final newline', {finalNewline: false}],
  ['dialect entries written expression first', {exprFirst: true}],
  ['one space before comments', {space: 1}],
  ['expressions on the line under their key', {nextLine: true}],
  ['a comment after each list', {afterList: true}],
  ['document markers', {markers: true}],
];

// Re-imports `output`. A file with a GOOGLE block is written for kcmd.
const again = (output: string, opts: object = {}) => importSemanticModelYaml(
    output, {...opts, ...(output.includes('GOOGLE') ? {strict: true} : {})});

test.each(CHANGES.flatMap(
    ([change, model, opts]) => STYLES.map(([style, s]) => [
      `${change}, ${style},`, write(model(), {...STYLE, ...s}), opts,
    ] as const)))(
    '%s keeps the rest of the file as it was', async (_, input, opts) => {
      const res = await importSemanticModelYaml(input, opts);

      expect(res.errors).toEqual([]);
      const {input: kept, output, problems} = check(input, res.files[0].content);
      expect(output).toEqual(kept);
      expect(problems).toEqual([]);
      expect((await again(res.files[0].content, opts)).files[0].content)
          .toBe(res.files[0].content);
    });

test.each([...CHANGES, ['no change', google] as const].flatMap(
    ([change, model, opts]) => [
      [`${change}, pretty JSON,`, JSON.stringify(model(), null, 2), opts],
      [`${change}, compact JSON,`, JSON.stringify(model()), opts],
    ] as const))(
    '%s is written as YAML', async (_, input, opts) => {
      const plain = write(JSON.parse(input), {...STYLE, comments: false, blanks: false});

      const res = await importSemanticModelYaml(input, opts);

      // The output holds what the same change makes of a YAML file, in the
      // input's key order, with no line of only spaces.
      expect(res.warnings).toContain('Converted the JSON file to YAML.');
      const yamlRes = await importSemanticModelYaml(plain, opts);
      expect(JSON.stringify(yaml.parse(res.files[0].content)))
          .toBe(JSON.stringify(yaml.parse(yamlRes.files[0].content)));
      expect(res.files[0].content)
          .not.toMatch(/^\s|\n[ \t]+\n|:\n\s*(\[\]|\{\})|\n\s*-\s*\n/);
      const reimport = await again(res.files[0].content, opts);
      expect(reimport.files[0].content).toBe(res.files[0].content);
      expect(reimport.warnings).not.toContain('Converted the JSON file to YAML.');
    });
