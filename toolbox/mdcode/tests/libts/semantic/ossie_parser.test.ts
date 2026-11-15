// Tests for the reader of Apache Ossie's expression language,
// src/libts/semantic/ossie_parser.ts.

import {beforeAll, describe, expect, spyOn, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {MAX_DEPTH, OssieFrameBound, OssieNode, ossieNodes, OssieSortItem, OssieWindow, parseOssie, tokenizeOssie} from '../../../src/libts/semantic/ossie_parser';
import {columnReferences, withoutQualifier} from '../../../src/libts/semantic/sql_expr_utils';
import {holdsNoSql, loadedSqlEngine, loadSqlEngine, soleColumn, sqlExpressionTree, sqlTokens, withoutComments} from '../../../src/libts/semantic/sql_parser';

// The texts of a block, one per line.
const lines = (block: string) => block.split('\n').filter(l => l.trim());

// Apache Ossie's conformance fixtures for its expression grammar: every
// parser of the grammar reads each text of VALID and refuses each of
// INVALID.
const VALID = lines(`
SUM(amount)
COUNT(*)
COUNT(DISTINCT customer_id)
SUM(DISTINCT amount)
PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY x)
PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY x DESC NULLS LAST)
SUM(amount) FILTER (WHERE status = 'completed')
COUNT(*) FILTER (WHERE status = 'completed')
COUNT(DISTINCT customer_id) FILTER (WHERE status = 'completed')
SUM(CASE WHEN status = 'completed' THEN amount END)
CASE WHEN a > 1 THEN 'x' WHEN a > 0 THEN 'y' ELSE 'z' END
CASE expression WHEN 1 THEN 'one' WHEN 2 THEN 'two' ELSE 'many' END
CAST('2024-01-15' AS DATE)
CAST(x AS DECIMAL(10, 2))
TRY_CAST(x AS INTEGER)
EXTRACT(YEAR FROM date_expr)
POSITION('a' IN str)
CURRENT_DATE
CURRENT_DATE()
CURRENT_TIMESTAMP
CURRENT_TIME()
DATE '2024-01-15'
TIMESTAMP_NTZ '2024-01-15 10:30:00'
TIME '10:30:00'
DATEADD(day, 7, order_date)
DATEADD(month, -1, order_date)
PI()
COALESCE(a, b, c)
ROUND(x, 2)
first_name || ' ' || last_name
x % 2
-x + +y * (z - 1) / 2
a <> b AND a != b AND a <= b AND a >= b
str LIKE 'a%'
str NOT LIKE 'a%'
str ILIKE '%b_'
x BETWEEN 1 AND 10 AND y NOT BETWEEN a AND b
x IN (1, 2, 3)
x NOT IN ('a', 'b')
x IS NULL
x IS NOT NULL
a IS DISTINCT FROM b
a IS NOT DISTINCT FROM b
NOT expr
NOT a = b
a AND b OR NOT c
TRUE AND NOT FALSE
1.5e-3 + .5 + 10.
NULL
"Order Date"
"say ""hi"""
dataset.field
schema.dataset."Field"
date
first
a -- trailing comment
a + 1 /* inline */ + 2
sum(amount) filter (where status = 'completed')
case when a then b else c end
ROW_NUMBER() OVER (ORDER BY id)
RANK() OVER (ORDER BY revenue DESC NULLS LAST)
NTILE(4) OVER (PARTITION BY region ORDER BY revenue)
SUM(amount) OVER (PARTITION BY region)
AVG(amount) OVER (ORDER BY order_date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)
SUM(amount) OVER (ORDER BY d RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
amount / SUM(amount) OVER () * 100
`);

const INVALID = lines(`
1 +
SUM(
(a
a b
CASE WHEN a THEN b
x BETWEEN 1
x IN ()
SELECT a FROM t
a IS
'unterminated
CAST(x AS)
order_date + INTERVAL '7 days'
DATE_ADD(d, INTERVAL 7 DAY)
SUM(DISTINCT)
COUNT(DISTINCT)
`);

// A window frame as `shown` writes it.
function frame(f: NonNullable<OssieWindow['frame']>): string {
  const bound = (b: OssieFrameBound) => b.kind === 'unbounded' ?
      `UNBOUNDED ${b.direction}` :
      b.kind === 'currentRow' ? 'CURRENT ROW' :
                                `${shown(b.expr)} ${b.direction}`;
  return f.to ? `${f.unit} BETWEEN ${bound(f.from)} AND ${bound(f.to)}` :
                `${f.unit} ${bound(f.from)}`;
}

// `node` written so that a row can compare it: each operator with its
// operands in parentheses, a parenthesized expression in brackets, and each
// name and literal as written.
function shown(node: OssieNode): string {
  const sorted = (items: readonly OssieSortItem[]) => items.map(
      s => [shown(s.expr), s.direction, s.nulls && `NULLS ${s.nulls}`]
               .filter(Boolean)
               .join(' '));
  const not = (n: {not: boolean}) => n.not ? 'NOT ' : '';
  switch (node.kind) {
    case 'reference':
      return node.parts.map(p => p.written).join('.');
    case 'literal':
      return node.text;
    case 'typedLiteral':
      return `${node.type} ${node.text}`;
    case 'currentDatetime':
      return node.name + (node.parens ? '()' : '');
    case 'functionCall': {
      const args = node.star ? '*' :
          (node.distinct ? 'DISTINCT ' : '') + node.args.map(shown).join(', ');
      const over = node.over && [
        node.over.partitionBy.length ?
            `PARTITION BY ${node.over.partitionBy.map(shown).join(', ')}` :
            '',
        node.over.orderBy.length ?
            `ORDER BY ${sorted(node.over.orderBy).join(', ')}` :
            '',
        node.over.frame ? frame(node.over.frame) : '',
      ].filter(Boolean).join(' ');
      return `${node.name.written}(${args})` +
          (node.withinGroup ?
               ` WITHIN GROUP (ORDER BY ${sorted(node.withinGroup).join(', ')})` :
               '') +
          (node.filter ? ` FILTER (WHERE ${shown(node.filter)})` : '') +
          (node.over ? ` OVER (${over})` : '');
    }
    case 'case':
      return [
        'CASE', ...node.operand ? [shown(node.operand)] : [],
        ...node.whens.map(
            w => `WHEN ${shown(w.condition)} THEN ${shown(w.result)}`),
        ...node.else ? [`ELSE ${shown(node.else)}`] : [], 'END',
      ].join(' ');
    case 'cast':
      return `${node.try ? 'TRY_CAST' : 'CAST'}(${shown(node.operand)} AS ${
          node.type.name.written}${
          node.type.params.length ? `(${node.type.params.join(', ')})` : ''})`;
    case 'extract':
      return `EXTRACT(${node.field.written} FROM ${shown(node.operand)})`;
    case 'position':
      return `POSITION(${shown(node.substring)} IN ${shown(node.string)})`;
    case 'parenthesized':
      return `[${shown(node.inner)}]`;
    case 'unary':
      return `(${node.op}${shown(node.operand)})`;
    case 'not':
      return `(NOT ${shown(node.operand)})`;
    case 'between':
      return `(${shown(node.operand)} ${not(node)}BETWEEN ${
          shown(node.low)} AND ${shown(node.high)})`;
    case 'inList':
      return `(${shown(node.operand)} ${not(node)}IN [${
          node.list.map(shown).join(', ')}])`;
    case 'like':
      return `(${shown(node.operand)} ${not(node)}${node.op} ${
          shown(node.pattern)})`;
    case 'isNull':
      return `(${shown(node.operand)} IS ${not(node)}NULL)`;
    case 'isDistinctFrom':
      return `(${shown(node.left)} IS ${not(node)}DISTINCT FROM ${
          shown(node.right)})`;
    default: {
      const op = 'op' in node ? node.op : node.kind.toUpperCase();
      return `(${shown(node.left)} ${op} ${shown(node.right)})`;
    }
  }
}

// The tree of `text`, which must parse.
function tree(text: string): OssieNode {
  const parsed = parseOssie(text);
  if ('error' in parsed) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.tree;
}

// Why `text` does not parse, or undefined when it does.
function refusal(text: string): string|undefined {
  const parsed = parseOssie(text);
  return 'error' in parsed ? parsed.error.message : undefined;
}

describe("Ossie's conformance fixtures", () => {
  test.each(VALID)('reads %p', text => {
    expect(refusal(text)).toBeUndefined();
  });

  test.each(INVALID)('refuses %p', text => {
    expect(refusal(text)).toBeString();
  });

  test.each<[string, string]>([
    ['1 + 2 * 3', '(1 + (2 * 3))'],
    ['NOT a = b', '(NOT (a = b))'],
    ['NOT a AND b', '((NOT a) AND b)'],
    ['a OR b AND c', '(a OR (b AND c))'],
    ['x BETWEEN 1 AND 2 AND y', '((x BETWEEN 1 AND 2) AND y)'],
    ['(a = b) = c', '([(a = b)] = c)'],
    ['-x + +y * (z - 1) / 2', '((-x) + (((+y) * [(z - 1)]) / 2))'],
    ['a || b - c', '((a || b) - c)'],
    ['NOT NOT a OR b', '((NOT (NOT a)) OR b)'],
  ])('binds %p as %p', (text, expected) => {
    expect(shown(tree(text))).toBe(expected);
  });
});

describe('parseOssie', () => {
  test('gives each part of a name as written, its spelling and its span', () => {
    const node = tree('  Orders."Order ""Date""".x');
    expect(node).toEqual({
      kind: 'reference',
      start: 2,
      end: 27,
      parts: [
        {written: 'Orders', name: 'Orders', quoted: false, start: 2, end: 8},
        {written: '"Order ""Date"""', name: 'Order "Date"', quoted: true, start: 9, end: 25},
        {written: 'x', name: 'x', quoted: false, start: 26, end: 27},
      ],
    });
  });

  test.each<[string, string, string]>([
    ['a keyword the grammar does not reserve is a name',
     'date + first + desc + position + current + over + range',
     '((((((date + first) + desc) + position) + current) + over) + range)'],
    ['a word other dialects reserve is a name',
     'select + if + day + interval + join + end_date',
     '(((((select + if) + day) + interval) + join) + end_date)'],
    ['a typed literal needs a string', "date '2024-01-01' + timestamp_ntz 'x' + date",
     "((DATE '2024-01-01' + TIMESTAMP_NTZ 'x') + date)"],
    ['POSITION is a function when IN does not separate its arguments',
     'POSITION(a, b) + position', '(POSITION(a, b) + position)'],
    ['the IN of a list may stand inside POSITION',
     'POSITION(a IN (b)) + POSITION(a IN (b) IN c)',
     '(POSITION(a IN [b]) + POSITION((a IN [b]) IN c))'],
    ['a call of POSITION with an IN list takes OVER and FILTER',
     'POSITION(a IN (b)) OVER () + POSITION(a IN (b)) FILTER (WHERE c)',
     '(POSITION((a IN [b])) OVER () + POSITION((a IN [b])) FILTER (WHERE c))'],
    ['a frame bound may be a column named like its keywords',
     'SUM(x) OVER (ROWS BETWEEN unbounded PRECEDING AND current FOLLOWING)',
     'SUM(x) OVER (ROWS BETWEEN UNBOUNDED PRECEDING AND current FOLLOWING)'],
    ['a simple CASE, CAST, EXTRACT and a quoted function name',
     'CASE a WHEN 1 THEN CAST(b AS VARCHAR(3)) ELSE EXTRACT(day FROM c) END + "f"(d)',
     '(CASE a WHEN 1 THEN CAST(b AS VARCHAR(3)) ELSE EXTRACT(day FROM c) END + "f"(d))'],
    ['a function takes no argument, a star, or DISTINCT',
     'f() + COUNT(*) + COUNT(DISTINCT a, b)', '((f() + COUNT(*)) + COUNT(DISTINCT a, b))'],
  ])('%s', (_, text, expected) => {
    expect(shown(tree(text))).toBe(expected);
  });

  test('reads as a name after a dot each keyword the grammar does not reserve', () => {
    const names = `DATE TIME TIMESTAMP TIMESTAMP_NTZ FIRST LAST NULLS ROW ROWS RANGE UNBOUNDED
        PRECEDING FOLLOWING CURRENT FILTER OVER WITHIN GROUP PARTITION ASC DESC POSITION`;
    const reserved = `AND AS BETWEEN BY CASE CAST CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DISTINCT
        ELSE END EXTRACT FALSE FROM ILIKE IN IS LIKE NOT NULL OR ORDER THEN TRUE TRY_CAST WHEN WHERE`;
    const read = (words: string) =>
        words.split(/\s+/).filter(w => refusal(`x.${w.toLowerCase()}`) === undefined);
    expect([read(names).length, read(reserved)]).toEqual([22, []]);
  });

  test('gives the span of each node', () => {
    const node = tree('/* c */ SUM(x) FILTER (WHERE y) -- d');
    expect(node).toMatchObject({kind: 'functionCall', start: 8, end: 31});
    expect(ossieNodes(node).map(n => n.kind)).toEqual(['functionCall', 'reference', 'reference']);
  });

  test('counts offsets in code units', () => {
    expect(tree(`'😀' || a`)).toMatchObject({right: {start: 8, end: 9}});
  });

  test.each<[string, string]>([
    ['', 'line 1, column 1: expected an expression, found the end of the text'],
    ['-- only a comment', 'line 1, column 18: expected an expression, found the end of the text'],
    ['SUM(x) OVER (ORDER BY y DESC NULLS)', `line 1, column 35: expected 'FIRST' or 'LAST', found ')'`],
    ['orders.end', `line 1, column 8: expected a name, found 'end'`],
    ['COUNT(from)', `line 1, column 7: expected '*', 'DISTINCT' or an expression, found 'from'`],
    ['(SELECT MAX(v) FROM t)', `line 1, column 9: expected an operator or ')', found 'MAX'`],
    ['a\n  + #', `line 2, column 5: expected a token, found '#'`],
    ['"open', `line 1, column 6: expected " to end the quoted name at offset 0, found the end of the text`],
    ['CURRENT_DATE(1)', `line 1, column 14: expected ')', found '1'`],
    ['CAST(x AS DECIMAL(4, -2))', `line 1, column 22: expected a number, found '-'`],
    ['a.b(c)', `line 1, column 4: expected an operator or the end of the text, found '('`],
    ['x NOT y', `line 1, column 3: expected an operator or the end of the text, found 'NOT'`],
    ['a = b = c', `line 1, column 7: expected an operator or the end of the text, found '='`],
    ['é', `line 1, column 1: expected a token, found 'é'`],
    ['a\u00a0+ b', `line 1, column 2: expected a token, found '\u00a0'`],
    ['a /* open', `line 1, column 4: expected an expression, found '*'`],
  ])('refuses %p: %s', (text, expected) => {
    expect(refusal(text)).toBe(expected);
  });

  // The message, after its line and column, for a text that nests more than
  // MAX_DEPTH levels deep.
  const DEEP = `expected at most ${MAX_DEPTH} levels of nesting, found a deeper expression`;

  test('stops a text that nests more than MAX_DEPTH levels deep', () => {
    const nested = (n: number) => `${'('.repeat(n - 1)}x${')'.repeat(n - 1)}`;
    expect(refusal(nested(MAX_DEPTH))).toBeUndefined();
    expect(parseOssie(nested(MAX_DEPTH + 1)))
        .toEqual({error: {offset: MAX_DEPTH, message: `line 1, column ${MAX_DEPTH + 1}: ${DEEP}`}});
    expect(refusal(`${'NOT '.repeat(100000)}p`)).toEndWith(DEEP);
  });

  test('reads a POSITION nested in the substring of another in one pass', () => {
    expect(tree('POSITION('.repeat(30) + 'a' + ' IN b)'.repeat(30)).kind).toBe('position');
  });

  test('stops a text nested 10,000 levels deep, and walks a list of 130,000 items, under node', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ossie-depth-'));
    try {
      const entry = join(dir, 'deep.ts');
      writeFileSync(entry, [
        `import {ossieNodes, parseOssie} from ${JSON.stringify(join(__dirname, '../../../src/libts/semantic/ossie_parser'))};`,
        `const read = parseOssie('('.repeat(10000) + 'a' + ')'.repeat(10000));`,
        `const list = parseOssie('x IN (' + Array(130000).fill('1').join(', ') + ')');`,
        `console.log('error' in read && read.error.message, 'tree' in list && String(ossieNodes(list.tree).length));`,
      ].join('\n'));
      const built = await Bun.build({entrypoints: [entry], outdir: dir, target: 'node'});
      expect(built.success).toBe(true);
      const run = Bun.spawnSync({cmd: ['node', built.outputs[0].path]});
      expect(run.stdout.toString().trim()).toBe(`line 1, column ${MAX_DEPTH + 1}: ${DEEP} 130002`);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('reads a long text in one pass', () => {
    const branches = Array.from({length: 20000}, (_, i) => `WHEN c = ${i} THEN 'v${i}'`);
    const text = `CASE ${branches.join(' ')} END + ${Array(20000).fill('a').join(' + ')}`;
    const started = performance.now();
    expect(tree(text).kind).toBe('additive');
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('tokenizeOssie', () => {
  test('gives each token with its value', () => {
    const tokens = tokenizeOssie(`a.Sum != 'it''s' /* c */ || 1.5E3`);
    expect('tokens' in tokens && tokens.tokens.map(t => [t.type, t.value])).toEqual([
      ['name', 'a'], ['symbol', '.'], ['name', 'Sum'], ['symbol', '<>'], ['string', "it's"],
      ['symbol', '||'], ['number', '1.5E3'],
    ]);
  });

  test('gives each comment with its place and its text', () => {
    const read = tokenizeOssie('a /* b */ -- c\n+ 1 --');
    expect('comments' in read && read.comments).toEqual([
      {start: 2, end: 9, written: '/* b */', body: ' b ', line: false},
      {start: 10, end: 14, written: '-- c', body: ' c', line: true},
      {start: 19, end: 21, written: '--', body: '', line: true},
    ]);
  });
});

describe("sql_parser's readers of an OSSIE_SQL_2026 text", () => {
  beforeAll(async () => {
    await loadSqlEngine();
  });

  test('read it by Ossie\'s grammar, and never hand it to the SQL engine', () => {
    const engine = loadedSqlEngine()!;
    const spies = [spyOn(engine, 'parse'), spyOn(engine, 'tokenize')];
    const calls = () => spies.reduce((n, s) => n + s.mock.calls.length, 0);
    try {
      const dialect = 'OSSIE_SQL_2026';
      expect({
        columns: columnReferences(
            'select + if + DATEADD(fortnight, 1, d) + DATEDIFF(c, e) + TIMESTAMPDIFF(day, a, b) + t.x.y', dialect),
        sole: soleColumn('(orders."Amount")', dialect),
        tokens: sqlTokens('a /* c */ <> "b"', dialect)?.map(t => [t.token_type, t.text, t.span.start, t.comments]),
        attached: sqlTokens('a /* c */ -- d\n<> b /* e */', dialect)?.map(t => [t.comments, t.trailing_comments]),
        engineTree: sqlExpressionTree('a + (SELECT MAX(v) FROM t)', dialect),
        empty: [holdsNoSql('-- only a comment', dialect), holdsNoSql('a', dialect)],
        comments: withoutComments('orders/* c */.amount -- d', dialect),
        unqualified: withoutQualifier('orders.amount + "orders".tax', 'orders', dialect),
        calls: calls(),
      }).toEqual({
        columns: [
          {name: 'select'}, {name: 'if'}, {name: 'd'}, {name: 'c'}, {name: 'e'}, {name: 'day'}, {name: 'a'},
          {name: 'b'}, {qualifier: 't', name: 'x'},
        ],
        sole: {qualifier: 'orders', name: 'Amount'},
        tokens: [['VAR', 'a', 0, []], ['NEQ', '<>', 10, ['/* c */']], ['QUOTED_IDENTIFIER', 'b', 13, []]],
        attached: [[[], []], [['/* c */', '-- d'], []], [[], ['/* e */']]],
        engineTree: undefined,
        empty: [true, false],
        comments: 'orders.amount',
        unqualified: 'amount + tax',
        calls: 0,
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
