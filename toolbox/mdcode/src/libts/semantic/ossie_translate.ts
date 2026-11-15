// Translates an OSSIE_SQL_2026 text into BigQuery's SQL.
//
// kcmd's Ossie parser reads the text into a tree, and each node is written as
// BigQuery's form of it. Operators, CASE, CAST, IN, BETWEEN, LIKE and IS NULL
// are written directly, and FUNCTIONS maps each function of Ossie's function
// tables that has a direct BigQuery form to that form. Beyond those forms, the
// translation adds only what BigQuery needs to run the text: a cast to
// TIMESTAMP beside a visible TIMESTAMP, a typed NULL where BigQuery refuses a
// literal NULL, constant folding where BigQuery takes only a literal, and the
// window NULL placement Ossie requires. Anything else stays untranslated.

import {isStackOverflow, ossieDatePart, OssieFrameBound, OssieNode, OssieSortItem, OssieSpan, OssieWindow, parseOssie, tokenizeOssie} from './ossie_parser';
import {backtick, quoteIdentifier} from './sql_identifiers';

// The reminder for each form whose value can differ from the source's in a
// way the author should check.
const REMINDERS = {
  SPLIT_PART: "SPLIT_PART: BigQuery's SPLIT gives NULL past the last part and for a negative part, where the source may give '' and count a negative part from the end; check the BIGQUERY entry.",
  SUBSTRING: 'SUBSTRING: BigQuery reads a start of 0 as 1 and counts a negative start from the end, where the source shortens the substring for a start below 1; check the BIGQUERY entry.',
  REGEXP_EXTRACT: 'REGEXP_EXTRACT: BigQuery gives the match of a capturing group where the pattern has one, where the source gives the whole match; check the BIGQUERY entry.',
  VARCHAR: 'CAST to VARCHAR(n): BigQuery cuts the text of any value to n characters, where the source raises an error, or TRY_CAST gives NULL, for a longer value that is not a string; check the BIGQUERY entry.',
  EXTRACT_SECOND: "EXTRACT(SECOND) and DATE_PART('second'): BigQuery gives whole seconds, where the source keeps the fraction; check the BIGQUERY entry.",
  PERCENTILE: "MEDIAN, PERCENTILE_CONT and PERCENTILE_DISC without OVER: BigQuery's APPROX_QUANTILES gives an approximate value, where the source gives the exact one; check the BIGQUERY entry.",
};

type Reminder = keyof typeof REMINDERS;

// `names`, functions BigQuery calls by the same name with the arguments
// `args`, as forms of FUNCTIONS.
function same(args: string, names: string): Record<string, string> {
  return Object.fromEntries(names.trim().split(/\s+/).map(n => [n, `${n}(${args})`]));
}

// BigQuery's form of each function of Ossie's function tables that has a
// direct one, by name in upper case. In a form, $1 to $3 stand for the
// arguments and $* for all of them, and @1 and ?1 for the first beside an
// operator (see fill). A call takes as many arguments as its form names, or as
// RANGES gives for a form with $*. The first argument of a function of PARTS
// is a date part. The percentiles' forms only give their arguments, since
// percentile writes them.
const FUNCTIONS: Record<string, string> = {
  ...same('', 'ROW_NUMBER RANK DENSE_RANK PERCENT_RANK CUME_DIST'),
  ...same('$1', `
      SUM COUNT AVG MIN MAX STDDEV STDDEV_POP STDDEV_SAMP VARIANCE VAR_POP VAR_SAMP APPROX_COUNT_DISTINCT
      MEDIAN PERCENTILE_CONT PERCENTILE_DISC NTILE FIRST_VALUE LAST_VALUE LENGTH LOWER UPPER TRIM LTRIM RTRIM
      ABS FLOOR CEIL CEILING SIGN SQRT EXP LN LOG10 SIN COS TAN ASIN ACOS ATAN`),
  ...same('$1, $2', 'APPROX_PERCENTILE NTH_VALUE LEFT RIGHT MOD POWER ATAN2 NULLIF IFNULL REGEXP_EXTRACT'),
  ...same('$1, $2, $3', 'REPLACE REGEXP_REPLACE IF'),
  ...same('$*', 'LAG LEAD ROUND TRUNC SUBSTRING CONCAT COALESCE GREATEST LEAST'),
  ...Object.fromEntries(
      ['YEAR', 'QUARTER', 'MONTH', 'DAY', 'DAYOFYEAR', 'HOUR', 'MINUTE', 'SECOND'].map(p => [p, `EXTRACT(${p} FROM $1)`])),
  DATE_PART: 'EXTRACT($1 FROM $2)',
  DATE_TRUNC: 'DATE_TRUNC($2, $1)',
  DATEADD: 'DATE_ADD($3, INTERVAL $2 $1)',
  DATEDIFF: 'DATE_DIFF($3, $2, $1)',
  TO_DATE: 'CAST($1 AS DATE)',
  TO_TIMESTAMP: 'CAST($1 AS TIMESTAMP)',
  SPLIT_PART: 'SPLIT($1, $2)[SAFE_ORDINAL($3)]',
  CHARINDEX: 'STRPOS($2, $1)',
  CONTAINS: '(STRPOS($1, $2) > 0)',
  STARTSWITH: 'STARTS_WITH($1, $2)',
  ENDSWITH: 'ENDS_WITH($1, $2)',
  REGEXP_LIKE: 'REGEXP_CONTAINS($1, $2)',
  REGEXP_COUNT: 'ARRAY_LENGTH(REGEXP_EXTRACT_ALL($1, $2))',
  TRUNCATE: 'TRUNC($*)',
  LOG: 'LOG($2, $1)',
  PI: 'ACOS(-1)',
  RADIANS: '(@1 * ACOS(-1) / 180)',
  DEGREES: '(@1 * 180 / ACOS(-1))',
  IFF: 'IF($1, $2, $3)',
  NVL: 'IFNULL($1, $2)',
  NVL2: 'IF(?1 IS NULL, $3, $2)',
  ZEROIFNULL: 'IFNULL($1, 0)',
  NULLIFZERO: 'NULLIF($1, 0)',
};

// The fewest and most arguments of each function whose form has $*, and of
// TO_CHAR, TO_DATE and TO_TIMESTAMP, which take a format second (see
// formatted). TO_CHAR has no form, since formatted writes each call of it.
const RANGES: Record<string, [number, number]> = {
  LAG: [1, 3], LEAD: [1, 3], ROUND: [1, 2], TRUNC: [1, 2], TRUNCATE: [1, 2], SUBSTRING: [2, 3],
  CONCAT: [1, Infinity], COALESCE: [1, Infinity], GREATEST: [1, Infinity], LEAST: [1, Infinity], TO_CHAR: [2, 2],
  TO_DATE: [1, 2], TO_TIMESTAMP: [1, 2],
};

// The fewest and most arguments a call of `name` takes, or undefined for a
// function kcmd does not translate, which is neither one of FUNCTIONS nor
// TO_CHAR.
function arity(name: string): [number, number]|undefined {
  const form = FUNCTIONS[name];
  if (!form) return RANGES[name];
  const most = Math.max(0, ...[...form.matchAll(/[$@?](\d)/g)].map(m => Number(m[1])));
  return RANGES[name] ?? [most, most];
}

// The aggregates, which take DISTINCT, FILTER and OVER, and the window
// functions, which take OVER. FRAMELESS holds those that take no frame.
const AGGREGATES = new Set([
  'SUM', 'COUNT', 'AVG', 'MIN', 'MAX', 'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'VARIANCE', 'VAR_POP', 'VAR_SAMP',
  'APPROX_COUNT_DISTINCT', 'MEDIAN', 'PERCENTILE_CONT', 'PERCENTILE_DISC', 'APPROX_PERCENTILE',
]);
const FRAMELESS = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'PERCENT_RANK', 'CUME_DIST', 'NTILE', 'LAG', 'LEAD']);
const WINDOW_FUNCTIONS = new Set([...FRAMELESS, 'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE']);
const PERCENTILES = new Set(['MEDIAN', 'PERCENTILE_CONT', 'PERCENTILE_DISC', 'APPROX_PERCENTILE']);

// The aggregates BigQuery has no form of over a window, and those it takes
// over a window only without DISTINCT.
const UNWINDOWED = new Set(['APPROX_COUNT_DISTINCT', 'APPROX_PERCENTILE']);
const UNDISTINCT = new Set([
  'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'VARIANCE', 'VAR_POP', 'VAR_SAMP', 'MEDIAN', 'PERCENTILE_CONT', 'PERCENTILE_DISC',
]);

// The argument each window function takes only as a literal INT64, by
// position, with its name for a message and the least value BigQuery takes.
const LITERAL_ARGUMENTS: Record<string, [number, string, number]> = {
  LAG: [1, 'offset', 0], LEAD: [1, 'offset', 0], NTILE: [0, 'count', 1], NTH_VALUE: [1, 'position', 1],
};

// The positions of the values each function compares or gives, which get the
// casts to TIMESTAMP (see stamped). -1 stands for every argument.
const STAMPED: Record<string, number[]> = {
  COALESCE: [-1], IFNULL: [-1], NVL: [-1], GREATEST: [-1], LEAST: [-1], IF: [1, 2], IFF: [1, 2], NVL2: [1, 2],
  NULLIF: [0, 1], DATEDIFF: [1, 2],
};

// The positions STAMPED gives a call of `name` with `count` arguments.
function stampedPositions(name: string, count: number): number[] {
  const at = STAMPED[name] ?? [];
  return at[0] === -1 ? [...Array(count).keys()] : at.filter(i => i < count);
}

// The date parts in `words`, each by the name BigQuery gives it, with
// `week` for WEEK.
function parts(words: string, week = 'ISOWEEK'): Record<string, string> {
  return Object.fromEntries(words.split(' ').map(w => [w, w === 'WEEK' ? week : w]));
}

// The date parts of EXTRACT, and of the first argument of each function of
// PARTS, by name in upper case. A week starts on Monday.
const EXTRACT_PARTS = parts('YEAR QUARTER MONTH WEEK DAY DAYOFWEEK DAYOFYEAR HOUR MINUTE SECOND MILLISECOND');
const UNITS = 'YEAR QUARTER MONTH WEEK DAY HOUR MINUTE SECOND MILLISECOND';
const PARTS: Record<string, Record<string, string>> = {
  DATE_PART: EXTRACT_PARTS,
  DATE_TRUNC: parts('YEAR QUARTER MONTH WEEK DAY HOUR MINUTE SECOND'),
  DATEADD: parts(UNITS, 'WEEK'),
  DATEDIFF: parts(UNITS),
};

// The parts of PARTS longer than a day, and those shorter than a day, by
// BigQuery's names.
const LONG_PARTS = new Set(['YEAR', 'QUARTER', 'MONTH', 'WEEK', 'ISOWEEK']);
const SHORT_PARTS = new Set(['HOUR', 'MINUTE', 'SECOND', 'MILLISECOND']);

// BigQuery's type for each type of Ossie's CAST, by name in upper case.
const CAST_TYPES: Record<string, string> = {
  VARCHAR: 'STRING', STRING: 'STRING', INTEGER: 'INT64', INT: 'INT64', BIGINT: 'INT64', DECIMAL: 'NUMERIC',
  NUMERIC: 'NUMERIC', FLOAT: 'FLOAT64', DOUBLE: 'FLOAT64', BOOLEAN: 'BOOL', DATE: 'DATE', TIME: 'TIME',
  TIMESTAMP: 'TIMESTAMP', TIMESTAMP_NTZ: 'DATETIME',
};

// BigQuery's type for DECIMAL(p, s), whose `params` are p and any s: NUMERIC
// where a NUMERIC holds it, with at most 9 places and 29 digits before the
// point, else BIGNUMERIC, with at most 38 of each, and else none.
function decimal(params: readonly string[]): string|undefined {
  const [p, s = 0] = params.map(Number);
  const holds = (places: number, digits: number) => s <= places && p >= Math.max(1, s) && p <= s + digits;
  return holds(9, 29) ? 'NUMERIC' : holds(38, 38) ? 'BIGNUMERIC' : undefined;
}

// The functions whose result type is fixed, with that type.
const RESULT_TYPES: Record<string, string> = {TO_DATE: 'DATE', TO_TIMESTAMP: 'TIMESTAMP'};

// How tightly BigQuery binds the operator at the top of a translation: OR,
// AND, NOT, comparisons and predicates, +, - and ||, then * and /, unary +
// and -, and last one value, such as a name, a literal, a call or a value in
// parentheses. BigQuery binds || as tightly as * and /, but no value is one
// that both || and an arithmetic operator take, so || is written where Ossie
// binds it.
const [OR, AND, NOT, CMP, ADD, MUL, UNARY, ATOM] = [1, 2, 3, 4, 5, 6, 7, 8];

// A translation: its SQL, and how tightly its top operator binds.
interface Out {
  sql: string;
  prec: number;
}

const atom = (sql: string): Out => ({sql, prec: ATOM});

// `out`'s SQL where an operator that binds at `prec` stands beside it, in
// parentheses when its own operator binds less tightly.
function at(out: Out, prec: number): string {
  return out.prec >= prec ? out.sql : `(${out.sql})`;
}

// `out`, a value where BigQuery refuses a literal NULL, with a literal NULL
// cast to `type`.
function typed(out: Out, type: string): Out {
  return out.sql === 'NULL' ? atom(`CAST(NULL AS ${type})`) : out;
}

// `form`, a form of FUNCTIONS, with each $n replaced by the SQL of argument n
// and $* by all of them. @n is argument n beside `*` and ?n argument n before
// IS NULL, each in parentheses unless it binds as tightly as that operator.
// Beside `*`, a literal NULL, which BigQuery refuses there, is cast to INT64.
function fill(form: string, args: Out[]): string {
  return form.replace(/([$@?])([1-9*])/g, (_, sigil: string, i: string) => {
    if (i === '*') return args.map(a => a.sql).join(', ');
    const arg = args[Number(i) - 1];
    return sigil === '$' ? arg.sql : sigil === '@' ? at(typed(arg, 'INT64'), MUL) : at(arg, ADD);
  });
}

// `node` without the parentheses around it.
function unwrapped(node: OssieNode): OssieNode {
  while (node.kind === 'parenthesized') node = node.inner;
  return node;
}

// The BigQuery type `node` visibly has, as a literal, a cast or a function
// whose result type is fixed has one, or undefined. DATE_TRUNC and DATEADD
// have the type of their date. A CASE, and a function of STAMPED other than
// DATEDIFF, is visibly a TIMESTAMP when a value it gives is, since the others
// are then cast to one.
function visibleType(node: OssieNode): string|undefined {
  const n = unwrapped(node);
  switch (n.kind) {
    case 'literal':
      return n.type === 'string' ? 'STRING' : n.type === 'boolean' ? 'BOOL' :
          n.type === 'number' ? (/^\d+$/.test(n.text) ? 'INT64' : 'FLOAT64') : undefined;
    case 'typedLiteral':
      return n.type === 'TIMESTAMP_NTZ' ? 'DATETIME' : n.type;
    case 'currentDatetime':
      return n.name.slice('CURRENT_'.length);
    case 'cast':
      return CAST_TYPES[n.type.name.name.toUpperCase()];
    case 'case':
      return [...n.whens.map(w => w.result), ...n.else ? [n.else] : []].some(r => visibleType(r) === 'TIMESTAMP') ?
          'TIMESTAMP' : undefined;
    case 'functionCall': {
      const name = n.name.quoted ? '' : n.name.name.toUpperCase();
      const date = name === 'DATE_TRUNC' ? n.args[1] : name === 'DATEADD' ? n.args[2] : undefined;
      if (date) return visibleType(date);
      const given = name === 'DATEDIFF' ? [] : stampedPositions(name, n.args.length).map(i => n.args[i]);
      return RESULT_TYPES[name] ?? (given.some(a => visibleType(a) === 'TIMESTAMP') ? 'TIMESTAMP' : undefined);
    }
    default:
      return undefined;
  }
}

// Ossie's core format tokens, longest first, with BigQuery's format element
// for each.
const FORMAT_TOKENS: [string, string][] = [
  ['MONTH', '%B'], ['YYYY', '%Y'], ['HH24', '%H'], ['HH12', '%I'], ['MON', '%b'], ['DAY', '%A'], ['YY', '%y'],
  ['MM', '%m'], ['DD', '%d'], ['DY', '%a'], ['HH', '%I'], ['MI', '%M'], ['SS', '%S'], ['AM', '%p'], ['PM', '%p'],
];

// `format`, an Ossie format, as a BigQuery format, or the part of it that is
// not a core token, as `{word}`. Each core token, in any letter case, becomes
// its element, the longest token first. Text in double quotes is literal
// text, and so is any character other than a letter. BigQuery copies both,
// with each `%` doubled. A letter that starts no core token, such as the I of
// IYYY, starts the word, and so does a double quote that the format does not
// close.
function bigQueryFormat(format: string): string|{word: string} {
  let out = '';
  for (let i = 0; i < format.length;) {
    const token = FORMAT_TOKENS.find(([t]) => format.slice(i, i + t.length).toUpperCase() === t);
    const end = format[i] === '"' ? format.indexOf('"', i + 1) : i + 1;
    if (!token && (end < 0 || /\p{L}/u.test(format[i]))) return {word: /^("|\p{L}[\p{L}\d]*)/u.exec(format.slice(i))![1]};
    out += token ? token[1] : format.slice(format[i] === '"' ? i + 1 : i, end).replaceAll('%', '%%');
    i = token ? i + token[0].length : format[i] === '"' ? end + 1 : end;
  }
  return out;
}

// `value` as a BigQuery string literal.
function stringLiteral(value: string): string {
  return `'${value.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

// The names a reference writes in backticks, in any letter case, besides those
// quoteIdentifier quotes. kcmd's SQL reader cannot read them bare, such as
// `date` before a dot, or BigQuery reads them bare as something else:
// `current_datetime` as the function, and `match_recognize` as a keyword.
const MISREAD = new Set([
  'ALTER', 'APPROXIMATE', 'BOTH', 'CONNECT_BY_ROOT', 'CURRENT_DATETIME', 'DATE', 'DATETIME', 'DELETE', 'DROP',
  'INSERT', 'LAMBDA', 'LEADING', 'MATCH_RECOGNIZE', 'MINUS', 'SAFE_CAST', 'TIMESTAMP', 'TRAILING',
]);

// --- Constants ------------------------------------------------------------------

// What an expression of constants gives: a number, a truth value or NULL.
type Constant = number|boolean|null;

type Call = Extract<OssieNode, {kind: 'functionCall'}>;
type Cast = Extract<OssieNode, {kind: 'cast'}>;

// BigQuery's ROUND of `x` to `d` places, which rounds a tie away from zero.
function roundAway(x: number, d = 0): number {
  return Math.sign(x) * Math.round(Math.abs(x) * 10 ** d) / 10 ** d;
}

// TRUNC of `x` to `d` places.
function truncated(x: number, d = 0): number {
  return Math.trunc(x * 10 ** d) / 10 ** d;
}

// The operators and functions `constant` computes on numbers, by name.
const NUMBER_OPERATIONS: Record<string, (...v: number[]) => number> = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b,
  ABS: Math.abs, FLOOR: Math.floor, CEIL: Math.ceil, CEILING: Math.ceil, POWER: Math.pow, ROUND: roundAway,
  TRUNC: truncated, TRUNCATE: truncated, GREATEST: Math.max, LEAST: Math.min,
};

// The comparisons `constant` computes, by operator.
const COMPARED: Record<string, (a: number, b: number) => boolean> = {
  '=': (a, b) => a === b, '<>': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
  '>': (a, b) => a > b, '>=': (a, b) => a >= b,
};

// The value of `node` where the text computes it from constants alone, with
// JavaScript's numbers, such as 2 for 1 + 1, CAST(2 AS INTEGER), ABS(-2) or
// GREATEST(1, 2). Undefined where `node` reads a column, or is a construct or
// calls a function this does not compute.
function constant(node: OssieNode): Constant|undefined {
  switch (node.kind) {
    case 'literal':
      return node.type === 'number' ? Number(node.text) : node.type === 'null' ? null :
          node.type === 'boolean' ? node.value.toUpperCase() === 'TRUE' : undefined;
    case 'parenthesized':
      return constant(node.inner);
    case 'unary':
      return computed(node.op, [0, constant(node.operand)]);
    case 'additive':
    case 'multiplicative':
      return computed(node.op, [node.left, node.right].map(constant));
    case 'comparison': {
      const [a, b] = [node.left, node.right].map(constant);
      if (a === null || b === null) return null;
      return typeof a === 'number' && typeof b === 'number' ? COMPARED[node.op](a, b) : undefined;
    }
    case 'isNull': {
      const x = constant(node.operand);
      return x === undefined ? undefined : (x === null) !== node.not;
    }
    case 'not': {
      const x = constant(node.operand);
      return typeof x === 'boolean' ? !x : x;
    }
    case 'and':
    case 'or': {
      const [a, b] = [node.left, node.right].map(constant);
      if (a === undefined || b === undefined || typeof a === 'number' || typeof b === 'number') return undefined;
      const decides = node.kind === 'or';
      return a === decides || b === decides ? decides : a === null || b === null ? null : !decides;
    }
    case 'case':
      return chosen(node);
    case 'cast':
      return castConstant(node);
    case 'functionCall':
      return calledConstant(node);
    default:
      return undefined;
  }
}

// The operation `name` of NUMBER_OPERATIONS on `values`: NULL for a NULL
// among them, and undefined for a value that is not a number.
function computed(name: string, values: readonly (Constant|undefined)[]): Constant|undefined {
  if (values.some(v => v === undefined || typeof v === 'boolean') || !NUMBER_OPERATIONS[name]) return undefined;
  return values.includes(null) ? null : NUMBER_OPERATIONS[name](...values as number[]);
}

// The value a CASE of constants gives.
function chosen(node: Extract<OssieNode, {kind: 'case'}>): Constant|undefined {
  const operand = node.operand ? constant(node.operand) : true;
  const whens = node.whens.map(w => [constant(w.condition), constant(w.result)]);
  const otherwise = node.else ? constant(node.else) : null;
  if (operand === undefined || otherwise === undefined || whens.flat().includes(undefined)) return undefined;
  const taken = whens.find(([c]) => c !== null && operand !== null && c === operand);
  return taken ? taken[1]! : otherwise;
}

// The value a cast of a constant to a number type gives: a cast to an integer
// rounds half away from zero, and one to DECIMAL to its scale. A DECIMAL
// without parameters keeps 9 places, as BigQuery's NUMERIC does.
function castConstant(node: Cast): Constant|undefined {
  const x = constant(node.operand);
  if (typeof x !== 'number') return x === null ? null : undefined;
  switch (node.type.name.name.toUpperCase()) {
    case 'INTEGER':
    case 'INT':
    case 'BIGINT':
      return roundAway(x);
    case 'DECIMAL':
    case 'NUMERIC':
      return roundAway(x, node.type.params.length ? Number(node.type.params[1] ?? 0) : 9);
    case 'FLOAT':
    case 'DOUBLE':
      return x;
    default:
      return undefined;
  }
}

// The value a call of a function in NUMBER_OPERATIONS, IF, IFF, COALESCE or
// NULLIF gives from constants.
function calledConstant(node: Call): Constant|undefined {
  const name = node.name.name.toUpperCase();
  const [fewest, most] = arity(name) ?? [1, 0];
  if (node.name.quoted || node.over || node.filter || node.distinct || node.star ||
      node.args.length < fewest || node.args.length > most) {
    return undefined;
  }
  const values = node.args.map(constant);
  if (values.includes(undefined)) return undefined;
  switch (name) {
    case 'IF':
    case 'IFF':
      return values[0] === true ? values[1] : values[2];
    case 'COALESCE':
      return values.find(v => v !== null) ?? null;
    case 'NULLIF':
      return values[0] === values[1] ? null : values[0];
    default:
      return computed(name, values);
  }
}

// `v` as an SQL number literal: a whole number within INT64's range in full,
// and any other number with at most 15 significant digits, so 0.1 + 0.2 is
// 0.3.
function numberSql(v: number): string {
  return Number.isInteger(v) && Math.abs(v) < 2 ** 63 ? BigInt(v).toString() : String(Number(v.toPrecision(15)));
}

// --- The translator ---------------------------------------------------------------

// Thrown for a construct kcmd does not translate, named for a message.
class Untranslated {
  constructor(readonly construct: string) {}
}

function refuse(construct: string): never {
  throw new Untranslated(construct);
}

/**
 * BigQuery's SQL for `text`, an OSSIE_SQL_2026 text, with the reminder of each
 * form it writes whose value can differ from the source's, or the message
 * saying why kcmd does not translate the text. Each comment of the text
 * follows the SQL as a block comment.
 */
export function ossieToBigQuery(text: string): {sql: string; reminders: string[]}|{error: string} {
  const parsed = parseOssie(text);
  if ('error' in parsed) {
    return {error: `kcmd does not translate a text that Ossie's grammar does not read: ${parsed.error.message}`};
  }
  try {
    const translator = new Translator(text);
    const sql = translator.out(parsed.tree).sql;
    const read = tokenizeOssie(text);
    const comments = 'error' in read ? [] : read.comments.map(
        c => `/*${(c.line ? ` ${c.body.trim()} ` : c.body).replaceAll('/*', '/ *').replaceAll('*/', '* /')}*/`);
    return {sql: [sql, ...comments].join(' '), reminders: [...translator.reminders].map(r => REMINDERS[r])};
  } catch (e) {
    if (e instanceof Untranslated) return {error: `kcmd does not translate ${e.construct}`};
    if (isStackOverflow(e)) return {error: 'kcmd does not translate a text that nests this deep'};
    throw e;
  }
}

// Translates the nodes of one text, `text`.
class Translator {
  // The reminders of the forms the translation writes.
  readonly reminders = new Set<Reminder>();

  constructor(private readonly text: string) {}

  // The text at `span`, for a message.
  private written(span: OssieSpan): string {
    return this.text.slice(span.start, span.end);
  }

  out(node: OssieNode): Out {
    const predicate = (sql: string): Out => ({sql, prec: CMP});
    const not = (n: {not: boolean}) => n.not ? 'NOT ' : '';
    switch (node.kind) {
      case 'reference':
        return atom(node.parts.map(p =>
            p.quoted || MISREAD.has(p.name.toUpperCase()) ? backtick(p.name) : quoteIdentifier(p.name)).join('.'));
      case 'literal':
        return atom(node.type === 'string' ? stringLiteral(node.value) : node.type === 'number' ? node.text : node.value);
      case 'typedLiteral':
        return atom(`${node.type === 'TIMESTAMP_NTZ' ? 'DATETIME' : node.type} ${stringLiteral(node.value)}`);
      case 'currentDatetime':
        return atom(`${node.name}()`);
      case 'parenthesized': {
        // A literal NULL stays bare, so that `typed` finds it.
        const inner = this.out(node.inner);
        return inner.sql === 'NULL' ? inner : atom(`(${inner.sql})`);
      }
      case 'unary': {
        const x = at(typed(this.out(node.operand), 'INT64'), UNARY);
        // A space keeps `- -x` from starting a comment.
        return {sql: `${node.op}${/^[-+]/.test(x) ? ' ' : ''}${x}`, prec: UNARY};
      }
      case 'multiplicative':
        if (node.op === '%') return atom(`MOD(${this.out(node.left).sql}, ${this.out(node.right).sql})`);
        return this.binary(node.left, node.op, node.right, MUL, 'INT64');
      case 'additive':
        return this.binary(node.left, node.op, node.right, ADD, node.op === '||' ? 'STRING' : 'INT64');
      case 'comparison': {
        // A literal NULL takes the type the other value visibly has.
        const sides = [node.left, node.right];
        const [l, r] = this.stamped(sides, true).map((o, i) =>
            o.sql === 'NULL' ? typed(o, visibleType(sides[1 - i]) ?? refuse(`${node.op} on NULL`)) : o);
        return predicate(`${at(l, ADD)} ${node.op} ${at(r, ADD)}`);
      }
      case 'between': {
        const [x, low, high] = this.stamped([node.operand, node.low, node.high], true);
        return predicate(`${at(x, ADD)} ${not(node)}BETWEEN ${at(low, ADD)} AND ${at(high, ADD)}`);
      }
      case 'inList': {
        const [x, ...list] = this.stamped([node.operand, ...node.list], true);
        return predicate(`${at(x, ADD)} ${not(node)}IN (${list.map(o => o.sql).join(', ')})`);
      }
      case 'like': {
        // ILIKE compares both values in lower case.
        const [x, p] = [node.operand, node.pattern].map(
            n => node.op === 'ILIKE' ? atom(`LOWER(${this.out(n).sql})`) : typed(this.out(n), 'STRING'));
        return predicate(`${at(x, ADD)} ${not(node)}LIKE ${at(p, ADD)}`);
      }
      case 'isNull':
        return predicate(`${at(this.out(node.operand), ADD)} IS ${not(node)}NULL`);
      case 'isDistinctFrom': {
        const [l, r] = this.stamped([node.left, node.right], true);
        return predicate(`${at(l, ADD)} IS ${not(node)}DISTINCT FROM ${at(r, ADD)}`);
      }
      case 'not':
        // A predicate after NOT goes in parentheses, so that kcmd's SQL
        // reader reads its columns.
        return {sql: `NOT ${at(typed(this.out(node.operand), 'BOOL'), ADD)}`, prec: NOT};
      case 'and':
      case 'or': {
        const prec = node.kind === 'and' ? AND : OR;
        const [l, r] = [this.out(node.left), this.out(node.right)];
        return {sql: `${at(l, prec)} ${node.kind.toUpperCase()} ${at(r, prec + 1)}`, prec};
      }
      case 'case':
        return this.caseOf(node);
      case 'cast':
        return this.cast(node);
      case 'extract': {
        const what = `EXTRACT with part '${node.field.written}'`;
        const part = EXTRACT_PARTS[node.field.name.toUpperCase()] ?? refuse(what);
        this.refuseShortPartOfDate(what, part, [node.operand]);
        if (part === 'SECOND') this.reminders.add('EXTRACT_SECOND');
        return atom(`EXTRACT(${part} FROM ${this.out(node.operand).sql})`);
      }
      case 'position':
        return atom(`STRPOS(${this.out(node.string).sql}, ${this.out(node.substring).sql})`);
      case 'functionCall':
        return this.call(node);
      default:
        return node satisfies never;
    }
  }

  // `op` of `left` and `right`, an operator BigQuery binds at `prec` from left
  // to right, with a literal NULL cast to `type`.
  private binary(left: OssieNode, op: string, right: OssieNode, prec: number, type: string): Out {
    const [l, r] = [left, right].map(n => typed(this.out(n), type));
    return {sql: `${at(l, prec)} ${op} ${at(r, prec + 1)}`, prec};
  }

  // The translations of `nodes`, the values one construct compares or gives.
  // Beside a value that is visibly a TIMESTAMP, each value that is not
  // visibly one is cast to TIMESTAMP, since BigQuery compares and merges no
  // DATE or DATETIME with a TIMESTAMP. Where the values are `compared`, a
  // visible DATE or DATETIME beside a value whose type is not visible, such as
  // a column, gets each value that is not visibly a DATETIME cast to DATETIME,
  // which BigQuery compares for a DATE, a DATETIME and a TIMESTAMP column alike.
  private stamped(nodes: readonly OssieNode[], compared = false): Out[] {
    const types = nodes.map(visibleType);
    // A literal NULL is no column.
    const unknown = nodes.some((n, i) => types[i] === undefined && unwrapped(n).kind !== 'literal');
    const to = types.includes('TIMESTAMP') ? 'TIMESTAMP' :
        compared && unknown && types.some(t => t === 'DATE' || t === 'DATETIME') ? 'DATETIME' : undefined;
    return nodes.map((n, i) => to && types[i] !== to ? atom(`CAST(${this.out(n).sql} AS ${to})`) : this.out(n));
  }

  // `node`, a CASE. Its results get the casts to TIMESTAMP. A simple CASE
  // compares its value with each WHEN value, so they get the casts of a
  // comparison.
  private caseOf(node: Extract<OssieNode, {kind: 'case'}>): Out {
    const results = this.stamped([...node.whens.map(w => w.result), ...node.else ? [node.else] : []]);
    const compared = node.operand ? this.stamped([node.operand, ...node.whens.map(w => w.condition)], true) :
                                    [undefined, ...node.whens.map(w => this.out(w.condition))];
    const whens = node.whens.map((_, i) => ` WHEN ${compared[i + 1]!.sql} THEN ${results[i].sql}`);
    const operand = compared[0] ? ` ${compared[0].sql}` : '';
    return atom(`CASE${operand}${whens.join('')}${node.else ? ` ELSE ${results.at(-1)!.sql}` : ''} END`);
  }

  // `node`, a CAST or a TRY_CAST, as BigQuery's CAST or SAFE_CAST to its type
  // for Ossie's. A size is a whole number. A cast to VARCHAR(n) keeps the
  // first n characters of the text.
  private cast(node: Cast): Out {
    const fn = node.try ? 'SAFE_CAST' : 'CAST';
    const params = node.type.params;
    const named = CAST_TYPES[node.type.name.name.toUpperCase()];
    const type = named === 'NUMERIC' && params.length ? decimal(params) : named;
    const sizes = type === 'STRING' ? 1 : type?.endsWith('NUMERIC') ? 2 : 0;
    // BigQuery's SAFE_CAST to NUMERIC(p, s) raises an error for a value past
    // the precision, where TRY_CAST gives NULL.
    if (!type || params.length > sizes || params.some(n => !/^\d+$/.test(n)) || node.try && sizes === 2 && params.length) {
      refuse(`${node.try ? 'TRY_CAST' : 'CAST'} to ${this.written(node.type)}`);
    }
    const x = this.out(node.operand).sql;
    if (type === 'STRING' && params.length) {
      this.reminders.add('VARCHAR');
      return atom(`SUBSTRING(${fn}(${x} AS STRING), 1, ${params[0]})`);
    }
    return atom(`${fn}(${x} AS ${type}${params.length ? `(${params.join(', ')})` : ''})`);
  }

  // `node`, a call of a function of FUNCTIONS or of TO_CHAR, with the clauses
  // its function takes.
  private call(node: Call): Out {
    const fn = node.name.written;
    const name = node.name.quoted ? '' : node.name.name.toUpperCase();
    const [fewest, most] = arity(name) ?? refuse(fn);
    const count = node.star ? 1 : node.args.length;
    if (count < fewest || count > most) refuse(`${fn} with ${count} argument${count === 1 ? '' : 's'}`);
    // The clauses BigQuery refuses on the call, as a message names them.
    const ordered = !!node.over && (node.over.orderBy.length > 0 || !!node.over.frame);
    const clause = [
      node.star && name !== 'COUNT' && 'with *', node.distinct && !AGGREGATES.has(name) && 'with DISTINCT',
      node.filter && !AGGREGATES.has(name) && 'with FILTER',
      node.withinGroup && !name.startsWith('PERCENTILE_') && 'with WITHIN GROUP',
      node.over && !AGGREGATES.has(name) && !WINDOW_FUNCTIONS.has(name) && 'with OVER',
      !node.over && WINDOW_FUNCTIONS.has(name) && 'without OVER',
      node.over?.frame && FRAMELESS.has(name) && 'with a frame', node.over && UNWINDOWED.has(name) && 'with OVER',
      ordered && PERCENTILES.has(name) && 'over a window with ORDER BY or a frame',
      ordered && node.distinct && 'with DISTINCT over a window with ORDER BY or a frame',
      node.over && node.distinct && UNDISTINCT.has(name) && 'with DISTINCT and OVER',
    ].find(c => c);
    if (clause) refuse(`${fn} ${clause}`);
    // HOUR, MINUTE and SECOND read the part they are named for.
    this.refuseShortPartOfDate(fn, name, node.args);
    this.remind(node, name);
    // TO_CHAR, TO_DATE and TO_TIMESTAMP with two arguments take a format.
    const sql = PERCENTILES.has(name) ? this.percentile(node, name) :
        name.startsWith('TO_') && node.args.length === 2 ? this.formatted(node, name) :
        fill(FUNCTIONS[name], this.args(node, name));
    return atom(node.over ? `${sql} ${this.window(node.over, name)}` : sql);
  }

  // The arguments of `node`, a call of `name`, as its form takes them: a date
  // part by BigQuery's name, a literal where BigQuery takes only one, the
  // casts to TIMESTAMP of STAMPED, and an aggregate's FILTER and DISTINCT.
  private args(node: Call, name: string): Out[] {
    const group = stampedPositions(name, node.args.length);
    const stamped = this.stamped(group.map(i => node.args[i]), name === 'DATEDIFF');
    const literal = LITERAL_ARGUMENTS[name];
    const args = node.args.map((a, i) => i === 0 && PARTS[name] ? atom(this.part(node, PARTS[name])) :
        group.includes(i) ? stamped[group.indexOf(i)] :
        literal?.[0] === i ? atom(this.literal(a, `${node.name.written} with the ${literal[1]}`, literal[2], true)) :
        this.out(a));
    if (node.star) args.push(atom(node.filter ? '1' : '*'));
    if (AGGREGATES.has(name)) args[0] = atom(this.aggregated(node, args[0].sql));
    return args;
  }

  // `value`, the value of `node`, an aggregate, with its FILTER and DISTINCT.
  // FILTER (WHERE p) gives the aggregate of IF(p, value, NULL), since the
  // aggregate skips NULL.
  private aggregated(node: Call, value: string): string {
    const filtered = node.filter ? `IF(${this.out(node.filter).sql}, ${value}, NULL)` : value;
    return node.distinct ? `DISTINCT ${filtered}` : filtered;
  }

  // Adds the reminder of `node`, a call of `name`, where its form can give
  // another value than the source's: SPLIT_PART, SUBSTRING with a start that
  // constants give below 1, and REGEXP_EXTRACT with a literal pattern that
  // holds a capturing group.
  private remind(node: Call, name: string): void {
    const start = name === 'SUBSTRING' ? constant(node.args[1]) : undefined;
    if (name === 'SPLIT_PART' || (typeof start === 'number' && start < 1)) this.reminders.add(name as Reminder);
    // A capturing group opens with ( that ? does not follow, or with (?P<name> or (?<name>.
    const pattern = name === 'REGEXP_EXTRACT' ? unwrapped(node.args[1]) : undefined;
    const capturing = /\((?!\?)|\(\?P?<\w/;
    if (pattern?.kind === 'literal' && pattern.type === 'string' && capturing.test(pattern.value.replace(/\\./g, ''))) {
      this.reminders.add('REGEXP_EXTRACT');
    }
  }

  // BigQuery's name for the date part of `node`, its first argument, a string
  // such as 'month' or a word such as month, by `names`.
  private part(node: Call, names: Record<string, string>): string {
    const arg = node.args[0];
    const ref = ossieDatePart(node);
    const word = arg.kind === 'literal' && arg.type === 'string' ? arg.value :
        ref?.kind === 'reference' ? ref.parts[0].name : undefined;
    const part = names[word?.toUpperCase() ?? ''] ?? refuse(`${node.name.written} with part '${word ?? this.written(arg)}'`);
    const name = node.name.name.toUpperCase();
    const what = `${node.name.written} with part '${word}'`;
    // DATE_PART is the other syntax of EXTRACT.
    if (name === 'DATE_PART' && part === 'SECOND') this.reminders.add('EXTRACT_SECOND');
    // The dates of the call: DATEADD's third argument, and the second and any
    // third of the others.
    const dates = node.args.slice(name === 'DATEADD' ? 2 : 1);
    // BigQuery's DATE_ADD and DATE_DIFF take no part longer than a day of a
    // TIMESTAMP. They get one where a date is visibly a TIMESTAMP, since
    // DATEDIFF's other date is then cast to one.
    if ((name === 'DATEADD' || name === 'DATEDIFF') && LONG_PARTS.has(part) &&
        dates.some(d => visibleType(d) === 'TIMESTAMP')) {
      refuse(`${what} of a TIMESTAMP, since BigQuery takes no part longer than DAY there`);
    }
    this.refuseShortPartOfDate(what, part, dates);
    return part;
  }

  // Refuses `what`, which reads date part `part`, by BigQuery's name, of
  // `dates`, where the part is shorter than a day and every date is visibly a
  // DATE, since BigQuery takes no such part of a DATE. Every date counts,
  // since DATEDIFF casts a DATE beside a column to DATETIME.
  private refuseShortPartOfDate(what: string, part: string, dates: readonly OssieNode[]): void {
    if (SHORT_PARTS.has(part) && dates.length && dates.every(d => visibleType(d) === 'DATE')) {
      refuse(`${what} of a DATE, since BigQuery takes no part shorter than DAY there`);
    }
  }

  // The literal for `node` where BigQuery takes only a literal, which a
  // message names `what`: the number that constants alone give there, of
  // `least` or more, and a whole number within INT64 where `whole`. A whole
  // number keeps the digits a literal writes, so it stays exact past 2^53, and
  // 1e2 becomes 100. Any other number keeps a literal's text.
  private literal(node: OssieNode, what: string, least: number, whole: boolean): string {
    const n = unwrapped(node);
    const text = n.kind === 'literal' && n.type === 'number' ? n.text : undefined;
    const digits = text !== undefined && /^\d+$/.test(text) ? text : undefined;
    const v = constant(node);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < least ||
        whole && !(digits ? BigInt(digits) < 2n ** 63n : Number.isInteger(v) && Math.abs(v) < 2 ** 63)) {
      refuse(`${what} ${this.written(node)}, since BigQuery takes only a literal ${whole ? 'INT64' : 'number'} of ${
          least} or more there`);
    }
    return digits ?? (Number.isInteger(v) || text === undefined ? numberSql(v) : text);
  }

  // `node`, TO_CHAR, or TO_DATE or TO_TIMESTAMP with a format, named `name`.
  // TO_TIMESTAMP is BigQuery's PARSE_TIMESTAMP. TO_DATE is PARSE_DATE, or the
  // DATE of PARSE_DATETIME when the format has a time of day, which
  // PARSE_DATE refuses. TO_CHAR is FORMAT_TIMESTAMP when the format has a
  // time of day and FORMAT_DATE otherwise, which both take a DATE, a DATETIME
  // and a TIMESTAMP. The format is a literal, whose tokens become BigQuery's
  // elements (see bigQueryFormat).
  private formatted(node: Call, name: string): string {
    const [value, given] = node.args;
    const fn = node.name.written;
    const literal = unwrapped(given);
    if (literal.kind !== 'literal' || literal.type !== 'string') refuse(`${fn} with a format that is not a literal`);
    const format = bigQueryFormat(literal.value);
    if (typeof format === 'object') {
      refuse(`${fn} with '${format.word}' in its format, which is not one of Ossie's format tokens`);
    }
    const [f, x] = [stringLiteral(format), this.out(value).sql];
    const timed = /%[HIMSp]/.test(format.replaceAll('%%', ''));
    if (name === 'TO_TIMESTAMP') return `PARSE_TIMESTAMP(${f}, ${x})`;
    if (name === 'TO_DATE') return timed ? `DATE(PARSE_DATETIME(${f}, ${x}))` : `PARSE_DATE(${f}, ${x})`;
    return `${timed ? 'FORMAT_TIMESTAMP' : 'FORMAT_DATE'}(${f}, ${x})`;
  }

  // `node`, MEDIAN, PERCENTILE_CONT, PERCENTILE_DISC or APPROX_PERCENTILE,
  // named `name`, without its OVER. Over a window, it is BigQuery's
  // PERCENTILE_CONT or PERCENTILE_DISC. Otherwise it is APPROX_QUANTILES at
  // the fraction's offset, with 100 quantiles, or as many as the fraction's
  // decimal places need, which BigQuery takes up to 100000.
  private percentile(node: Call, name: string): string {
    const fn = node.name.written;
    const order = node.withinGroup;
    const within = name.startsWith('PERCENTILE_');
    if (within && (order?.length !== 1 || order[0].direction === 'DESC')) {
      refuse(`${fn} without WITHIN GROUP (ORDER BY a value ascending)`);
    }
    const x = this.aggregated(node, this.out(within ? order![0].expr : node.args[0]).sql);
    const fraction = node.args.at(-1)!;
    const p = name === 'MEDIAN' ? '0.5' : this.literal(fraction, `${fn} with the fraction`, 0, false);
    if (Number(p) > 1) refuse(`${fn} with the fraction ${this.written(fraction)}, since a fraction is at most 1`);
    if (node.over) return `${name === 'PERCENTILE_DISC' ? name : 'PERCENTILE_CONT'}(${x}, ${p})`;
    if (name !== 'APPROX_PERCENTILE') this.reminders.add('PERCENTILE');
    const [digits, exponent = '0'] = p.split(/e/i);
    const places = Math.max(2, (digits.split('.')[1] ?? '').length - Number(exponent));
    if (places > 5) refuse(`${fn} with a fraction of more than 5 decimal places`);
    return `APPROX_QUANTILES(${x}, ${10 ** places})[OFFSET(${Math.round(Number(p) * 10 ** places)})]`;
  }

  // The OVER clause of `over`, the window of a call of `name`, with each
  // frame offset a literal and the NULL placement of each ORDER BY item (see
  // sortItem).
  private window(over: OssieWindow, name: string): string {
    const frame = over.frame;
    // An aggregate and a navigation function get a RANGE frame from ORDER BY
    // alone.
    const ranged = frame ? frame.unit === 'RANGE' : !FRAMELESS.has(name);
    const offset = [frame?.from, frame?.to].some(b => b?.kind === 'offset');
    // A ROWS offset, and a RANGE offset beside an ORDER BY value that is
    // visibly an INT64, is an INT64.
    const key = over.orderBy.length === 1 ? visibleType(over.orderBy[0].expr) : undefined;
    const whole = frame?.unit === 'ROWS' || key === 'INT64';
    const bound = (b: OssieFrameBound) => b.kind === 'unbounded' ? `UNBOUNDED ${b.direction}` :
        b.kind === 'currentRow' ? 'CURRENT ROW' : `${this.literal(b.expr, 'the frame offset', 0, whole)} ${b.direction}`;
    const clauses = [
      ...over.partitionBy.length ? [`PARTITION BY ${over.partitionBy.map(e => this.out(e).sql).join(', ')}`] : [],
      ...over.orderBy.length ? [`ORDER BY ${over.orderBy.map(i => this.sortItem(i, ranged, offset)).join(', ')}`] : [],
      ...frame ? [`${frame.unit} ${frame.to ? `BETWEEN ${bound(frame.from)} AND ${bound(frame.to)}` : bound(frame.from)}`] :
                 [],
    ];
    return `OVER (${clauses.join(' ')})`;
  }

  // `item`, an item of a window's ORDER BY, with NULL last after ASC and
  // first after DESC unless it says otherwise, as Ossie requires. In a RANGE
  // frame, BigQuery takes only NULLS FIRST after ASC and NULLS LAST after
  // DESC. So there, the other placements sort by `x IS NULL` first, as
  // Ossie's spec does on an engine without NULLS FIRST and NULLS LAST, which
  // BigQuery refuses beside a frame offset.
  private sortItem(item: OssieSortItem, ranged: boolean, offset: boolean): string {
    const x = this.out(item.expr);
    const desc = item.direction === 'DESC';
    const first = item.nulls ? item.nulls === 'FIRST' : desc;
    const dir = item.direction ? ` ${item.direction}` : '';
    if (!ranged || first !== desc) return `${x.sql}${dir} NULLS ${first ? 'FIRST' : 'LAST'}`;
    if (offset) refuse(`a RANGE frame with an offset, where BigQuery cannot put NULL ${first ? 'first after DESC' : 'last after ASC'}`);
    return `${at(x, ADD)} IS NULL${dir}, ${x.sql}${dir}`;
  }
}
