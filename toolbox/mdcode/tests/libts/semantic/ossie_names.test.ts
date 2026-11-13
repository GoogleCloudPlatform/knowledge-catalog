// Tests for the reader of names in an OSSIE_SQL_2026 text,
// src/libts/semantic/ossie_names.ts.

import {beforeAll, describe, expect, test} from 'bun:test';

import {columnField, FieldColumn, fieldSoleColumn, OssieContext, OssieDataset, ossieMatches, OssieReference, ossieSoleColumn, readOssieText} from '../../../src/libts/semantic/ossie_names';
import {loadSqlEngine} from '../../../src/libts/semantic/sql_parser';

beforeAll(async () => {
  await loadSqlEngine();
});

const DATASETS: OssieDataset[] = [
  {
    name: 'orders',
    fields: [
      {name: 'amount', column: [{name: 'o_amount', quoted: false, dialect: 'OSSIE_SQL_2026'}]},
      {name: 'status'},
      {name: 'current_date'},
      {name: 'from'},
    ],
  },
  {name: 'customers', fields: [{name: 'id'}, {name: 'name'}]},
  {name: 'events', fields: [{name: 'source'}, {name: 'kind'}]},
  {name: 'date', fields: [{name: 'year'}]},
];

// A reference as a row writes it: the text it covers, then what it refers to.
function shown(r: OssieReference): string {
  const target = r.kind === 'column' ?
      `column ${r.dataset}.${r.quoted ? `"${r.column}"` : r.column}` :
      r.kind === 'field' ? `field ${r.dataset}.${r.field}` :
                           'unresolved';
  return `${r.written} -> ${target}`;
}

// What `text` reads where `ctx` says, as rows write it, then each name whose
// qualifier names another dataset; undefined when it does not parse.
function read(text: string, ctx: Omit<OssieContext, 'datasets'>): string[]|
    undefined {
  const reading = readOssieText(text, {...ctx, datasets: DATASETS});
  if (!reading) return undefined;
  return [
    ...reading.references.map(shown),
    ...reading.otherDataset.map(o => `other ${o}`),
  ];
}

describe('readOssieText', () => {
  test.each<[string, string, string[]|undefined]>([
    ['a bare name is a column', 'o_amount * 2',
     ['o_amount -> column orders.o_amount']],
    ['a quoted name keeps its spelling', '"O_Amount"',
     ['"O_Amount" -> column orders."O_Amount"']],
    ['a quoted keyword is a column', '"date" + "interval" + "user"',
     ['"date" -> column orders."date"',
      '"interval" -> column orders."interval"',
      '"user" -> column orders."user"']],
    ['the own dataset may qualify a column', 'orders.o_amount',
     ['orders.o_amount -> column orders.o_amount']],
    ['the own dataset matches in any case, or quoted in capitals',
     'ORDERS.a + "ORDERS".b',
     ['ORDERS.a -> column orders.a', '"ORDERS".b -> column orders.b']],
    ['a quoted qualifier in other capitals names no dataset', '"Orders".a',
     ['"Orders".a -> unresolved']],
    ['another dataset is invalid', 'customers.id',
     ['customers.id -> unresolved', 'other customers.id']],
    ['a struct path is unresolved', 'address.city',
     ['address.city -> unresolved']],
    ['a struct path after the own dataset gives its column',
     'orders.address.city', ['orders.address -> column orders.address']],
    ['names in a string literal or a comment are not read',
     `'orders.x' || y /* customers.z */ -- orders.w`, ['y -> column orders.y']],
    ['a function name is not read', 'UPPER(status)',
     ['status -> column orders.status']],
    ['a quoted name the parser reads as a function is a column',
     '"current_date" + "pi"',
     ['"current_date" -> column orders."current_date"',
      '"pi" -> column orders."pi"']],
    ['an Ossie function written without parentheses is not a name',
     'current_date - CURRENT_TIMESTAMP() + Current_Time', []],
    ['any other word the parser reads as a function is a column',
     'sysdate + user',
     ['sysdate -> column orders.sysdate', 'user -> column orders.user']],
    ['a word Ossie reads as a name that the parser reads as SQL syntax is a column',
     'UPPER(select) || join || CAST(x AS STRING) || LEFT(s, 2)',
     ['select -> column orders.select', 'join -> column orders.join',
      'x -> column orders.x', 's -> column orders.s']],
    ['a word the parser reads as an operator is a column each time it is written',
     'binary + binary', ['binary -> column orders.binary', 'binary -> column orders.binary']],
    ['a reserved word is a column', 'interval * 2 + date + orders.interval',
     ['interval -> column orders.interval', 'date -> column orders.date',
      'orders.interval -> column orders.interval']],
    ['a date part is not a name',
     'DATE_TRUNC(week, a) + DATEADD(fortnight, 1, b) + EXTRACT(YEAR FROM c)',
     ['a -> column orders.a', 'b -> column orders.b', 'c -> column orders.c']],
    ['a qualifier that names a table of a subquery\'s FROM is unresolved',
     '(SELECT MAX(customers.v) FROM customers) + ' +
         '(SELECT MAX(orders.v) FROM sales.orders AS o)',
     ['customers.v -> unresolved', 'orders.v -> unresolved']],
    ['a subquery\'s FROM does not bind a name in its first FROM item, nor one its FROMs do not name',
     '(SELECT COUNT(*) FROM UNNEST(customers.items) AS customers) + ' +
         '(SELECT customers.id FROM orders UNION ALL SELECT 1 FROM orders)',
     ['customers.items -> unresolved', 'customers.id -> unresolved',
      'other customers.items', 'other customers.id']],
    ['a correlated name in a subquery is read',
     '(SELECT MAX(c.v) FROM customers AS c WHERE c.k = orders.k)',
     ['orders.k -> column orders.k']],
    ['offsets count code units', `'😀' || orders.a`,
     ['orders.a -> column orders.a']],
    ['an empty text reads nothing', '', []],
    ['a text that does not parse gives nothing', 'SUM(', undefined],
  ])('in a field of orders, %s', (_, text, expected) => {
    expect(read(text, {kind: 'field', dataset: 'orders'})).toEqual(expected);
  });

  test.each<[string, string, string, string[]]>([
    ['a bare name is a field of the anchor', 'orders', 'SUM(AMOUNT)',
     ['AMOUNT -> field orders.amount']],
    ['a quoted name in capitals matches a plain field', 'orders',
     'SUM("AMOUNT")', ['"AMOUNT" -> field orders.amount']],
    ['a quoted name in other capitals matches no field', 'orders',
     'SUM("Amount")', ['"Amount" -> unresolved']],
    ['source.x is a column of the anchor in any case', 'orders',
     'SUM(source.o_amount) + MAX(SOURCE.o_tax)',
     ['source.o_amount -> column orders.o_amount',
      'SOURCE.o_tax -> column orders.o_tax']],
    ['source is a field when the anchor declares one', 'events',
     'COUNT(source) + COUNT(source.x)',
     ['source -> field events.source', 'source.x -> unresolved']],
    ['a qualified name is a field of that dataset', 'orders',
     'SUM(amount) / COUNT(CUSTOMERS.ID)',
     ['amount -> field orders.amount', 'CUSTOMERS.ID -> field customers.id']],
    ['an unknown name is unresolved', 'orders', 'nope + customers.nope',
     ['nope -> unresolved', 'customers.nope -> unresolved']],
    ['a quoted keyword in capitals matches a plain field', 'orders',
     'DATEDIFF(day, "CURRENT_DATE", CURRENT_DATE)',
     ['"CURRENT_DATE" -> field orders.current_date']],
    ['a reserved word may qualify a field', 'orders', 'MAX(Date.year)',
     ['Date.year -> field date.year']],
    ['a reserved word the parser cannot read alone matches a field',
     'orders', 'COUNT(from)', ['from -> field orders.from']],
    ['a field beside a TIMESTAMP_NTZ literal is read', 'orders',
     `MAX(CASE WHEN status > timestamp_ntz '2024-01-15 10:30' THEN amount END)`,
     ['status -> field orders.status', 'amount -> field orders.amount']],
  ])('in an anchored metric, %s', (_, anchor, text, expected) => {
    expect(read(text, {kind: 'metric', dataset: anchor})).toEqual(expected);
  });

  test('in an anchored metric, a field named like a word Ossie reserves is read where the parser reads it as a column', () => {
    const datasets = [{name: 'orders', fields: [{name: 'end'}]}];
    const reading = readOssieText('SUM(CASE WHEN end > 0 THEN end END)', {kind: 'metric', dataset: 'orders', datasets});
    expect(reading?.references.map(shown)).toEqual(['end -> field orders.end', 'end -> field orders.end']);
  });

  test('in a metric without an anchor, only a qualified name is a field', () => {
    expect(read('SUM(orders.amount) + amount + source.x', {kind: 'metric'}))
        .toEqual([
          'orders.amount -> field orders.amount',
          'amount -> unresolved',
          'source.x -> unresolved',
        ]);
  });
});

describe('ossieMatches', () => {
  test.each<[string, boolean, string, boolean]>([
    ['Id', false, 'iD', true],
    ['ID', true, 'id', true],
    ['id', true, 'id', true],
    ['id', true, 'ID', false],
    ['Id', true, 'id', false],
    ['ORDER DATE', true, 'Order Date', false],
    ['Order Date', true, 'Order Date', true],
    ['X$Y', true, 'x$y', true],
  ])('%p quoted %p against %p gives %p', (name, quoted, declared, expected) => {
    expect(ossieMatches({name, quoted}, declared)).toBe(expected);
  });
});

describe('ossieSoleColumn', () => {
  test.each<[string, {name: string; quoted: boolean}|undefined]>([
    ['o_amount', {name: 'o_amount', quoted: false}],
    ['(Orders.o_amount)', {name: 'o_amount', quoted: false}],
    ['"ORDERS"."O_AMOUNT"', {name: 'O_AMOUNT', quoted: true}],
    ['"current_date"', {name: 'current_date', quoted: true}],
    ['current_date', undefined],
    ['o_amount + 1', undefined],
    ['customers.id', undefined],
    ['orders.address.city', undefined],
  ])('%p gives %p', (text, expected) => {
    expect(ossieSoleColumn(text, 'orders', DATASETS)).toEqual(expected);
  });
});

describe('fieldSoleColumn', () => {
  test.each<[string, Array<[string, string]>, ReturnType<typeof fieldSoleColumn>]>([
    ['a BIGQUERY text alone', [['BIGQUERY', 'tax_amt']], [{name: 'tax_amt', quoted: false, dialect: 'BIGQUERY'}]],
    ['each text, when they agree', [['BIGQUERY', 'COST'], ['OSSIE_SQL_2026', 'ORDERS.cost']],
     [{name: 'COST', quoted: false, dialect: 'BIGQUERY'}, {name: 'cost', quoted: false, dialect: 'OSSIE_SQL_2026'}]],
    ['a quoted name the parser reads as a function', [['ANSI_SQL', '"current_date"']],
     [{name: 'current_date', quoted: true, dialect: 'ANSI_SQL'}]],
    ['nothing for a qualified kcmd text', [['BIGQUERY', 'orders.amt']], undefined],
    ['nothing for texts naming different columns', [['OSSIE_SQL_2026', '"Amt"'], ['POSTGRES', 'amt']], undefined],
    ['nothing when a text is not one column', [['OSSIE_SQL_2026', 'amt'], ['BIGQUERY', 'amt + 1']], undefined],
    ['nothing without a text', [], undefined],
    ['nothing for an empty quoted name', [['POSTGRES', '""']], undefined],
  ])('gives %s', (_, texts, expected) => {
    const read = texts.map(([dialect, expression]) => ({dialect, expression}));
    expect(fieldSoleColumn(read, 'orders', DATASETS)).toEqual(expected);
  });

  test("compares an ANSI_SQL text by the rule of the dataset's table", () => {
    const texts = [{dialect: 'OSSIE_SQL_2026', expression: 'amt'}, {dialect: 'ANSI_SQL', expression: '`Amt`'}];
    expect([fieldSoleColumn(texts, 'orders', DATASETS, 'POSTGRES'), fieldSoleColumn(texts, 'orders', DATASETS, 'BIGQUERY')])
        .toEqual([undefined, [{name: 'amt', quoted: false, dialect: 'OSSIE_SQL_2026'}, {name: 'Amt', quoted: true, dialect: 'ANSI_SQL'}]]);
  });

  test.each([['"Amt"'], ['`a.b`']])("reads no column in ANSI_SQL %s on a BigQuery table, which BigQuery reads as text or a path", text => {
    expect(fieldSoleColumn([{dialect: 'ANSI_SQL', expression: text}], 'orders', DATASETS, 'BIGQUERY')).toBeUndefined();
  });
});

describe('columnField', () => {
  const dataset: OssieDataset = {
    name: 'orders',
    fields: [
      {name: 'tax', column: [{name: 'tax_amt', quoted: false, dialect: 'BIGQUERY'}]},
      {name: 'cost', column: [{name: 'COST', quoted: false, dialect: 'OSSIE_SQL_2026'}]},
    ],
  };
  test.each<[string, boolean, string|undefined, string|undefined, string|undefined]>([
    ['TAX_AMT', true, undefined, undefined, 'tax'],
    ['cost', false, undefined, undefined, 'cost'],
    ['cost', true, undefined, undefined, undefined],
    ['cost', true, 'POSTGRES', undefined, 'cost'],
    ['Cost', true, 'ANSI_SQL', 'BIGQUERY', 'cost'],
    ['Cost', true, 'ANSI_SQL', undefined, undefined],
  ])('%p quoted %p in %p on a %p table is read by %p', (name, quoted, dialect, table, expected) => {
    expect(columnField({name, quoted}, dataset, dialect, table)).toBe(expected);
  });

  test('reads no field one of whose texts names another column, in either order of the texts', () => {
    const texts = [{name: 'tax', quoted: false, dialect: 'BIGQUERY'}, {name: 'tax', quoted: false, dialect: 'POSTGRES'}];
    const field = (column: FieldColumn[]): OssieDataset => ({name: 'orders', fields: [{name: 'levy', column}]});
    expect([texts, [...texts].reverse()].map(column => columnField({name: 'Tax', quoted: true}, field(column), 'POSTGRES')))
        .toEqual([undefined, undefined]);
  });
});
