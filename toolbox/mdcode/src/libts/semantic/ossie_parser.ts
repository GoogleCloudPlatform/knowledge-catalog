// Reads a text of Apache Ossie's expression language, OSSIE_SQL_2026, into a
// tree, as Ossie's expression grammar reads it.
//
// The grammar reads expressions only, with no SELECT, FROM or subquery. It
// reads every function as a call of a name with its arguments, and which
// functions exist is not a question of syntax. Only CASE, CAST and TRY_CAST,
// EXTRACT, POSITION, COUNT(*), DISTINCT, FILTER, WITHIN GROUP, OVER and typed
// literals have syntax of their own. Keywords match in any letter case.
//
// Operators bind in this order, tightest first: unary + and -; *, / and %;
// +, - and ||; comparisons and the predicates BETWEEN, IN, LIKE, ILIKE and
// IS; NOT; AND; OR. The operands of a comparison or a predicate are
// arithmetic, so `a = b = c` needs parentheses.
//
// A text the grammar does not read whole gives the place where the reading
// stops and what the grammar expects there. Each text is read in time linear
// in its length, apart from the parentheses of POSITION. The parser can read
// those again for each IN that stands in them outside other parentheses and
// CASE.

/** Where a part of a text is written, in code units, end exclusive. */
export interface OssieSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * A name as a text writes it: the text as written, the name it spells, and
 * whether quotes wrap it. A quoted name spells what its double quotes hold,
 * with each `""` read as one quote, and matches only that spelling. A regular
 * name spells itself and matches in any letter case.
 */
export interface OssieIdentifier extends OssieSpan {
  readonly written: string;
  readonly name: string;
  readonly quoted: boolean;
}

/** An expression of ORDER BY, with its direction and its NULLS order. */
export interface OssieSortItem extends OssieSpan {
  readonly expr: OssieNode;
  readonly direction?: 'ASC'|'DESC';
  readonly nulls?: 'FIRST'|'LAST';
}

/** One end of a window frame. */
export type OssieFrameBound = OssieSpan&(
    {readonly kind: 'unbounded'; readonly direction: 'PRECEDING'|'FOLLOWING'}|
    {readonly kind: 'currentRow'}|{
      readonly kind: 'offset';
      readonly expr: OssieNode;
      readonly direction: 'PRECEDING' | 'FOLLOWING'
    });

/** The window of an OVER clause. */
export interface OssieWindow extends OssieSpan {
  readonly partitionBy: readonly OssieNode[];
  readonly orderBy: readonly OssieSortItem[];
  readonly frame?: OssieSpan&{
    readonly unit: 'ROWS' | 'RANGE';
    readonly from: OssieFrameBound;
    readonly to?: OssieFrameBound;
  };
}

/**
 * A node of the tree of an OSSIE_SQL_2026 text: its kind, where it is
 * written, and its parts. The kinds follow the grammar's rules:
 * 1. `reference`: a name with each part, as `dataset.field`.
 * 2. `literal`: a number, a string, TRUE or FALSE, or NULL, as written, with
 *    a string's characters as `value`.
 * 3. `typedLiteral`: DATE, TIME, TIMESTAMP or TIMESTAMP_NTZ before a string.
 * 4. `currentDatetime`: CURRENT_DATE, CURRENT_TIME or CURRENT_TIMESTAMP, with
 *    or without `()`.
 * 5. `functionCall`: a name and its arguments, `*`, or DISTINCT and its
 *    arguments, with WITHIN GROUP, FILTER and OVER when written.
 * 6. `case`, `cast`, `extract` and `position`, each of its own syntax.
 * 7. `parenthesized`, `unary`, `multiplicative` and `additive`.
 * 8. `comparison`, `between`, `inList`, `like`, `isNull` and
 *    `isDistinctFrom`, each negated by NOT when `not` is set.
 * 9. `not`, `and` and `or`.
 */
export type OssieNode = OssieSpan&(
    {readonly kind: 'reference'; readonly parts: readonly OssieIdentifier[]}|{
      readonly kind: 'literal';
      readonly type: 'number' | 'string' | 'boolean' | 'null';
      readonly text: string;
      readonly value: string;
    }|{
      readonly kind: 'typedLiteral';
      readonly type: 'DATE' | 'TIME' | 'TIMESTAMP' | 'TIMESTAMP_NTZ';
      readonly text: string;
      readonly value: string;
    }|{
      readonly kind: 'currentDatetime';
      readonly name: 'CURRENT_DATE' | 'CURRENT_TIME' | 'CURRENT_TIMESTAMP';
      readonly parens: boolean;
    }|{
      readonly kind: 'functionCall';
      readonly name: OssieIdentifier;
      readonly star: boolean;
      readonly distinct: boolean;
      readonly args: readonly OssieNode[];
      readonly withinGroup?: readonly OssieSortItem[];
      readonly filter?: OssieNode;
      readonly over?: OssieWindow;
    }|{
      readonly kind: 'case';
      readonly operand?: OssieNode;
      readonly whens:
          ReadonlyArray<{readonly condition: OssieNode; readonly result: OssieNode}>;
      readonly else?: OssieNode;
    }|{
      readonly kind: 'cast';
      readonly try: boolean;
      readonly operand: OssieNode;
      readonly type: OssieSpan&
          {readonly name: OssieIdentifier; readonly params: readonly string[]};
    }|{
      readonly kind: 'extract';
      readonly field: OssieIdentifier;
      readonly operand: OssieNode;
    }|{
      readonly kind: 'position';
      readonly substring: OssieNode;
      readonly string: OssieNode;
    }|{readonly kind: 'parenthesized'; readonly inner: OssieNode}|{
      readonly kind: 'unary';
      readonly op: '+' | '-';
      readonly operand: OssieNode;
    }|{
      readonly kind: 'multiplicative' | 'additive';
      readonly op: string;
      readonly left: OssieNode;
      readonly right: OssieNode;
    }|{
      readonly kind: 'comparison';
      readonly op: string;
      readonly left: OssieNode;
      readonly right: OssieNode;
    }|{
      readonly kind: 'between';
      readonly not: boolean;
      readonly operand: OssieNode;
      readonly low: OssieNode;
      readonly high: OssieNode;
    }|{
      readonly kind: 'inList';
      readonly not: boolean;
      readonly operand: OssieNode;
      readonly list: readonly OssieNode[];
    }|{
      readonly kind: 'like';
      readonly not: boolean;
      readonly op: 'LIKE' | 'ILIKE';
      readonly operand: OssieNode;
      readonly pattern: OssieNode;
    }|{
      readonly kind: 'isNull';
      readonly not: boolean;
      readonly operand: OssieNode;
    }|{
      readonly kind: 'isDistinctFrom';
      readonly not: boolean;
      readonly left: OssieNode;
      readonly right: OssieNode;
    }|{readonly kind: 'not'; readonly operand: OssieNode}|{
      readonly kind: 'and' | 'or';
      readonly left: OssieNode;
      readonly right: OssieNode;
    });

/**
 * A token of an OSSIE_SQL_2026 text. `value` is a keyword in upper case, the
 * name a quoted name spells, a string's characters, `<>` for `!=`, and
 * otherwise the token as written.
 */
export interface OssieToken extends OssieSpan {
  readonly type: 'keyword'|'name'|'quoted'|'number'|'string'|'symbol';
  readonly written: string;
  readonly value: string;
}

/**
 * A comment of an OSSIE_SQL_2026 text: where it is, as written, its text
 * inside the markers, and whether it is a line comment. A line comment, from
 * `--`, ends before a line feed or a carriage return, and a block comment at
 * the first marker that closes it.
 */
export interface OssieComment extends OssieSpan {
  readonly written: string;
  readonly body: string;
  readonly line: boolean;
}

/**
 * Where a text stops reading as an expression: the offset in code units, and
 * a message with the line and column from 1, what the grammar expects there
 * and what the text holds there, as `line 1, column 5: expected ')', found
 * the end of the text`.
 */
export interface OssieSyntaxError {
  readonly offset: number;
  readonly message: string;
}

/**
 * The most levels of parentheses, calls, CASE, NOT and signs the parser reads
 * a text to, so that neither it nor a reader that recurses over the tree runs
 * out of stack on such nesting. Under node, which runs the npm build, the
 * parser runs out after about 650 levels and the translator after about 550,
 * so 250 leaves a margin for the calls below them.
 */
export const MAX_DEPTH = 250;

/** Whether `e` is the error a JavaScript engine throws when the stack runs out. */
export function isStackOverflow(e: unknown): boolean {
  return e instanceof RangeError && /call stack/i.test(e.message);
}

/** The words the grammar reserves, which are never a name unquoted. */
export const OSSIE_RESERVED: ReadonlySet<string> = new Set([
  'AND', 'AS', 'BETWEEN', 'BY', 'CASE', 'CAST', 'CURRENT_DATE', 'CURRENT_TIME',
  'CURRENT_TIMESTAMP', 'DISTINCT', 'ELSE', 'END', 'EXTRACT', 'FALSE', 'FROM',
  'ILIKE', 'IN', 'IS', 'LIKE', 'NOT', 'NULL', 'OR', 'ORDER', 'THEN', 'TRUE',
  'TRY_CAST', 'WHEN', 'WHERE',
]);

// The keywords that are names wherever their own syntax does not stand, as
// a column may be called `date`, `first` or `range`.
const NON_RESERVED = new Set([
  'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMP_NTZ', 'FIRST', 'LAST', 'NULLS', 'ROW',
  'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT', 'FILTER',
  'OVER', 'WITHIN', 'GROUP', 'PARTITION', 'ASC', 'DESC', 'POSITION',
]);

// Every keyword of the grammar, in upper case.
const KEYWORDS: ReadonlySet<string> = new Set([...OSSIE_RESERVED, ...NON_RESERVED]);

const TYPED_LITERALS = new Set(['DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMP_NTZ']);
const COMPARISONS = new Set(['=', '<>', '<', '<=', '>', '>=']);
const TWO_CHARACTER_SYMBOLS = new Set(['<>', '!=', '<=', '>=', '||']);
const SYMBOLS = new Set('=<>+-*/%(),.');

const AN_OPERATOR = 'an operator';
const AN_EXPRESSION = 'an expression';
const A_NAME = 'a name';
const THE_END = 'the end of the text';

/**
 * The tokens of `text`, an OSSIE_SQL_2026 text, without its spaces, and its
 * comments, each in text order, or where a character starts no token. A block
 * comment with no end is a `/` and a `*`, as the grammar reads it.
 */
export function tokenizeOssie(text: string):
    {tokens: OssieToken[]; comments: OssieComment[]}|{error: OssieSyntaxError} {
  const tokens: OssieToken[] = [];
  const comments: OssieComment[] = [];
  const comment = (start: number, end: number, line: boolean) => {
    comments.push({
      start, end, written: text.slice(start, end), body: text.slice(start + 2, line ? end : end - 2), line,
    });
  };
  const digit = (c: string|undefined) => !!c && c >= '0' && c <= '9';
  const push = (type: OssieToken['type'], start: number, end: number,
                value?: string) => {
    const written = text.slice(start, end);
    tokens.push({type, start, end, written, value: value ?? written});
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
    } else if (text.startsWith('--', i)) {
      const start = i;
      while (i < text.length && text[i] !== '\r' && text[i] !== '\n') i++;
      comment(start, i, true);
    } else if (text.startsWith('/*', i) && text.indexOf('*/', i + 2) >= 0) {
      const start = i;
      i = text.indexOf('*/', i + 2) + 2;
      comment(start, i, false);
    } else if (c === '\'' || c === '"') {
      // A quote inside is written twice.
      let end = i + 1;
      let value = '';
      for (;; end++) {
        if (end >= text.length) {
          const what = c === '\'' ? 'string' : 'quoted name';
          return {
            error: syntaxError(
                text, end, `${c} to end the ${what} at offset ${i}`, THE_END),
          };
        }
        if (text[end] !== c) {
          value += text[end];
        } else if (text[end + 1] === c) {
          value += c;
          end++;
        } else {
          break;
        }
      }
      push(c === '\'' ? 'string' : 'quoted', i, end + 1, value);
      i = end + 1;
    } else if (digit(c) || (c === '.' && digit(text[i + 1]))) {
      let end = i;
      while (digit(text[end])) end++;
      if (text[end] === '.') {
        end++;
        while (digit(text[end])) end++;
      }
      // An exponent is part of the number only when digits follow it.
      if (text[end] === 'e' || text[end] === 'E') {
        const sign = text[end + 1] === '+' || text[end + 1] === '-' ? 1 : 0;
        if (digit(text[end + 1 + sign])) {
          end += 1 + sign;
          while (digit(text[end])) end++;
        }
      }
      push('number', i, end);
      i = end;
    } else if (regularNameEnd(text, i) > i) {
      const end = regularNameEnd(text, i);
      const upper = text.slice(i, end).toUpperCase();
      if (KEYWORDS.has(upper)) push('keyword', i, end, upper);
      else push('name', i, end);
      i = end;
    } else if (TWO_CHARACTER_SYMBOLS.has(text.slice(i, i + 2))) {
      const symbol = text.slice(i, i + 2);
      push('symbol', i, i + 2, symbol === '!=' ? '<>' : symbol);
      i += 2;
    } else if (SYMBOLS.has(c)) {
      push('symbol', i, i + 1);
      i++;
    } else {
      return {error: syntaxError(text, i, 'a token', `'${c}'`)};
    }
  }
  return {tokens, comments};
}

/**
 * The end of the regular identifier, [A-Za-z_][A-Za-z0-9_$]*, that starts at
 * offset `start` of `text`, or `start` when none starts there. Ossie reads
 * such a name without quotes, in any letter case.
 */
export function regularNameEnd(text: string, start: number): number {
  if (!/[A-Za-z_]/.test(text[start] ?? '')) return start;
  let end = start + 1;
  while (/[A-Za-z0-9_$]/.test(text[end] ?? '')) end++;
  return end;
}

/** Token `t`, a name, a quoted name or a keyword, as a name a text writes. */
export function ossieIdentifier(t: OssieToken): OssieIdentifier {
  const quoted = t.type === 'quoted';
  return {
    start: t.start,
    end: t.end,
    written: t.written,
    name: quoted ? t.value : t.written,
    quoted,
  };
}

// The most trees PARSES keeps, so a long import reads each text once without
// holding every tree.
const MAX_CACHED_PARSES = 65536;
const PARSES = new Map<string, {tree: OssieNode}|{error: OssieSyntaxError}>();

/**
 * The tree of `text`, an OSSIE_SQL_2026 text, when the grammar reads all of
 * it as one expression, or else where it stops and what it expects there. A
 * text that holds no token is no expression.
 */
export function parseOssie(text: string):
    {tree: OssieNode}|{error: OssieSyntaxError} {
  const cached = PARSES.get(text);
  if (cached) return cached;
  const tokens = tokenizeOssie(text);
  const parsed = 'error' in tokens ? tokens :
                                     new OssieParser(text, tokens.tokens).parse();
  if (PARSES.size >= MAX_CACHED_PARSES) PARSES.clear();
  PARSES.set(text, parsed);
  return parsed;
}

/**
 * The tree of `text`, an OSSIE_SQL_2026 text, or null when the text holds no
 * token, as an empty text or one of comments alone does. Undefined when the
 * text does not parse.
 */
export function ossieTree(text: string): OssieNode|null|undefined {
  const parsed = parseOssie(text);
  if ('tree' in parsed) return parsed.tree;
  const read = tokenizeOssie(text);
  return 'tokens' in read && !read.tokens.length ? null : undefined;
}

// The functions of Ossie's tables whose first argument is a date part, each
// with the number of arguments the tables give it.
const DATE_PART_CALLS: ReadonlyMap<string, number> = new Map([
  ['DATE_PART', 2], ['DATE_TRUNC', 2], ['DATEADD', 3], ['DATEDIFF', 3],
]);

/**
 * The date part a call reads, as `week` is in `DATE_TRUNC(week, d)`: the first
 * argument of a call of DATE_PART or DATE_TRUNC with two arguments, or of
 * DATEADD or DATEDIFF with three, when it is one word written without quotes
 * or a qualifier, in a call written without quotes or DISTINCT. Undefined for
 * any other node.
 */
export function ossieDatePart(node: OssieNode): OssieNode|undefined {
  if (node.kind !== 'functionCall' || node.name.quoted || node.distinct ||
      DATE_PART_CALLS.get(node.name.name.toUpperCase()) !== node.args.length) {
    return undefined;
  }
  const [part] = node.args;
  return part.kind === 'reference' && part.parts.length === 1 &&
          !part.parts[0].quoted ?
      part :
      undefined;
}

/**
 * The values of the window `over`, in the order the text writes them: each
 * expression of PARTITION BY and ORDER BY, and each offset of its frame.
 */
export function ossieWindowValues(over: OssieWindow|undefined): OssieNode[] {
  if (!over) return [];
  const bounds = [over.frame?.from, over.frame?.to].flatMap(
      b => b?.kind === 'offset' ? [b.expr] : []);
  return [...over.partitionBy, ...over.orderBy.map(i => i.expr), ...bounds];
}

/**
 * The nodes right under `node`, in the order the text writes them: each
 * operand, argument, condition and result, and each expression of a FILTER
 * or OVER clause, a WITHIN GROUP and a window frame.
 */
function ossieChildren(node: OssieNode): OssieNode[] {
  switch (node.kind) {
    case 'reference':
    case 'literal':
    case 'typedLiteral':
    case 'currentDatetime':
      return [];
    case 'functionCall':
      return [
        ...node.args, ...(node.withinGroup ?? []).map(s => s.expr),
        ...node.filter ? [node.filter] : [], ...ossieWindowValues(node.over),
      ];
    case 'case':
      return [
        ...node.operand ? [node.operand] : [],
        ...node.whens.flatMap(w => [w.condition, w.result]),
        ...node.else ? [node.else] : [],
      ];
    case 'cast':
    case 'extract':
    case 'unary':
    case 'not':
    case 'isNull':
      return [node.operand];
    case 'position':
      return [node.substring, node.string];
    case 'parenthesized':
      return [node.inner];
    case 'between':
      return [node.operand, node.low, node.high];
    case 'inList':
      return [node.operand, ...node.list];
    case 'like':
      return [node.operand, node.pattern];
    default:
      return [node.left, node.right];
  }
}

/** Every node of `tree`, each before the nodes under it, in text order. */
export function ossieNodes(tree: OssieNode): OssieNode[] {
  const out: OssieNode[] = [];
  // A stack, so a long chain of operators does not nest calls. Each child is
  // pushed alone, since a call with a long list of arguments runs out of stack.
  const stack = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    out.push(node);
    const children = ossieChildren(node);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out;
}

/**
 * The names `tree` reads, each as its parts, in the order written: each
 * reference that is not a date part (see ossieDatePart), nor inside the
 * arguments of a call that `skipped` accepts when given.
 */
export function ossieReferences(
    tree: OssieNode, skipped?: (call: OssieNode) => boolean):
    Array<readonly OssieIdentifier[]> {
  const left = new Set<OssieNode>();
  const references: Array<readonly OssieIdentifier[]> = [];
  for (const node of ossieNodes(tree)) {
    const part = ossieDatePart(node);
    if (part) left.add(part);
    if (node.kind === 'functionCall' && skipped?.(node)) {
      for (const arg of node.args) ossieNodes(arg).forEach(n => left.add(n));
    }
    if (node.kind === 'reference' && !left.has(node)) {
      references.push(node.parts);
    }
  }
  return references;
}

/**
 * The parts of the one name `tree` is, perhaps in parentheses, when it has
 * at most two, as `orders.amount` or `("AMOUNT")`. Undefined for any other
 * tree.
 */
export function ossieSoleReference(tree: OssieNode|null|undefined):
    readonly OssieIdentifier[]|undefined {
  let node = tree;
  while (node?.kind === 'parenthesized') node = node.inner;
  return node?.kind === 'reference' && node.parts.length <= 2 ? node.parts :
                                                                undefined;
}

// `items` as alternatives in a sentence, as "a, b or c".
function alternatives(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

// The error for a text that stops reading at `offset`, where the grammar
// expects `expected` and the text holds `found`.
function syntaxError(
    text: string, offset: number, expected: string,
    found: string): OssieSyntaxError {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - (before.lastIndexOf('\n') + 1) + 1;
  return {
    offset,
    message: `line ${line}, column ${column}: expected ${expected}, found ${
        found}`,
  };
}

// The error for a text whose tree nests more than MAX_DEPTH levels deep, at
// `offset`, where it gets that deep.
function deepError(text: string, offset: number): OssieSyntaxError {
  return syntaxError(text, offset, `at most ${MAX_DEPTH} levels of nesting`, 'a deeper expression');
}

// Thrown where the reading stops. The parser has recorded why.
class Stop {}

// A reading of POSITION: its node, the token after it, and the end of its
// last token.
interface PositionRead {
  node: OssieNode;
  pos: number;
  lastEnd: number;
}

// Thrown where the text nests more than MAX_DEPTH levels deep, at `offset`.
class Deep {
  constructor(readonly offset: number) {}
}

// A recursive-descent reader of the tokens of one text by the grammar's
// rules. It reads each choice from the next tokens. The one choice it cannot
// read so is where POSITION's IN stands, as in `POSITION(a IN (b))`, and
// there it tries each IN, from the last, as the grammar reads the text.
class OssieParser {
  private pos = 0;
  private depth = 0;
  private limit: number;
  // The readings of POSITION (see position).
  private readonly positions = new Map<string, PositionRead|'stop'>();
  private readonly positionsAt = new Map<number, PositionRead>();
  private lastEnd = 0;
  // The furthest token where a choice failed, and what it expected there.
  private furthest = -1;
  private expected: string[] = [];

  constructor(
      private readonly text: string, private readonly tokens: OssieToken[]) {
    this.limit = tokens.length;
  }

  parse(): {tree: OssieNode}|{error: OssieSyntaxError} {
    try {
      const tree = this.expr();
      if (this.peek()) {
        this.expect(THE_END);
        throw new Stop();
      }
      return {tree};
    } catch (e) {
      if (e instanceof Deep) return {error: deepError(this.text, e.offset)};
      // MAX_DEPTH stops the reading before the stack runs out, unless the
      // caller has used most of it.
      if (isStackOverflow(e)) return {error: deepError(this.text, this.peek()?.start ?? this.text.length)};
      if (!(e instanceof Stop)) throw e;
      const t = this.tokens[this.furthest];
      const found = !t ? THE_END :
          t.written.length > 40 ? `'${t.written.slice(0, 37)}...'` :
                                  `'${t.written}'`;
      return {
        error: syntaxError(
            this.text, t?.start ?? this.text.length,
            alternatives(this.expected), found),
      };
    }
  }

  // The token `k` after the current one, unless the reading ends first.
  private peek(k = 0): OssieToken|undefined {
    const i = this.pos + k;
    return i < this.limit ? this.tokens[i] : undefined;
  }

  // Records that `what` may stand at the current token.
  private expect(what: string): void {
    if (this.pos > this.furthest) {
      this.furthest = this.pos;
      this.expected = [];
    }
    if (this.pos === this.furthest && !this.expected.includes(what)) {
      this.expected.push(what);
    }
  }

  private stop(what: string): never {
    this.expect(what);
    throw new Stop();
  }

  // Whether the token `k` after the current one is keyword or symbol `value`.
  private is(value: string, k = 0): boolean {
    const t = this.peek(k);
    return !!t && (t.type === 'keyword' || t.type === 'symbol') &&
        t.value === value;
  }

  private advance(): OssieToken {
    const t = this.tokens[this.pos++];
    this.lastEnd = t.end;
    return t;
  }

  // Takes the current token when it is keyword or symbol `value`. Otherwise
  // records `what`, when given, as expected there.
  private accept(value: string, what?: string): OssieToken|undefined {
    if (this.is(value)) return this.advance();
    if (what) this.expect(what);
    return undefined;
  }

  private take(value: string): OssieToken {
    return this.accept(value) ?? this.stop(`'${value}'`);
  }

  // The current token taken when it is one of `values`.
  private takeOne<T extends string>(values: readonly T[]): T {
    const found = values.find(v => this.is(v));
    if (found === undefined) {
      this.stop(alternatives(values.map(v => `'${v}'`)));
    }
    this.advance();
    return found;
  }

  // Whether the token `k` after the current one is a name: a regular name, a
  // quoted name, or a keyword the grammar does not reserve.
  private isName(k = 0): boolean {
    const t = this.peek(k);
    return !!t &&
        (t.type === 'name' || t.type === 'quoted' ||
         t.type === 'keyword' && NON_RESERVED.has(t.value));
  }

  private identifier(): OssieIdentifier {
    if (!this.isName()) this.stop(A_NAME);
    return ossieIdentifier(this.advance());
  }

  // expr: NOT, AND and OR over predicates.
  private expr(): OssieNode {
    let left = this.andExpr();
    while (this.accept('OR', AN_OPERATOR)) {
      const right = this.andExpr();
      left = {kind: 'or', left, right, start: left.start, end: right.end};
    }
    return left;
  }

  private andExpr(): OssieNode {
    let left = this.notExpr();
    while (this.accept('AND', AN_OPERATOR)) {
      const right = this.notExpr();
      left = {kind: 'and', left, right, start: left.start, end: right.end};
    }
    return left;
  }

  private notExpr(): OssieNode {
    const not = this.accept('NOT');
    if (!not) return this.predicate();
    const operand = this.nested(() => this.notExpr());
    return {kind: 'not', operand, start: not.start, end: operand.end};
  }

  // A comparison or a predicate over value expressions, or one value
  // expression.
  private predicate(): OssieNode {
    const left = this.valueExpr();
    const at = (end: number) => ({start: left.start, end});
    const op = this.peek();
    if (op?.type === 'symbol' && COMPARISONS.has(op.value)) {
      this.advance();
      const right = this.valueExpr();
      return {kind: 'comparison', op: op.value, left, right, ...at(right.end)};
    }
    this.expect(AN_OPERATOR);
    const not = this.is('NOT') &&
        ['BETWEEN', 'IN', 'LIKE', 'ILIKE'].some(w => this.is(w, 1));
    if (not) this.advance();
    if (this.accept('BETWEEN')) {
      const low = this.valueExpr();
      this.take('AND');
      const high = this.valueExpr();
      return {kind: 'between', not, operand: left, low, high, ...at(high.end)};
    }
    if (this.accept('IN')) {
      this.take('(');
      const list = [this.valueExpr()];
      while (this.accept(',', `','`)) list.push(this.valueExpr());
      this.take(')');
      return {kind: 'inList', not, operand: left, list, ...at(this.lastEnd)};
    }
    const like = this.peek();
    if (this.accept('LIKE') || this.accept('ILIKE')) {
      const pattern = this.valueExpr();
      return {
        kind: 'like', not, op: like!.value as 'LIKE' | 'ILIKE', operand: left,
        pattern, ...at(pattern.end),
      };
    }
    if (this.accept('IS')) {
      const isNot = !!this.accept('NOT', `'NOT'`);
      if (this.accept('NULL', `'NULL'`)) {
        return {kind: 'isNull', not: isNot, operand: left, ...at(this.lastEnd)};
      }
      this.take('DISTINCT');
      this.take('FROM');
      const right = this.valueExpr();
      return {
        kind: 'isDistinctFrom', not: isNot, left, right, ...at(right.end),
      };
    }
    return left;
  }

  // valueExpr: +, - and || over *, / and %, over unary + and -.
  private valueExpr(): OssieNode {
    let left = this.multiplicative();
    for (;;) {
      const op = ['+', '-', '||'].find(o => this.is(o));
      if (op === undefined) {
        this.expect(AN_OPERATOR);
        return left;
      }
      this.advance();
      const right = this.multiplicative();
      left = {
        kind: 'additive', op, left, right, start: left.start, end: right.end,
      };
    }
  }

  private multiplicative(): OssieNode {
    let left = this.unary();
    for (;;) {
      const op = ['*', '/', '%'].find(o => this.is(o));
      if (op === undefined) {
        this.expect(AN_OPERATOR);
        return left;
      }
      this.advance();
      const right = this.unary();
      left = {
        kind: 'multiplicative', op, left, right, start: left.start,
        end: right.end,
      };
    }
  }

  private unary(): OssieNode {
    const op = ['+', '-'].find(o => this.is(o)) as '+' | '-' | undefined;
    if (op === undefined) return this.nested(() => this.primary());
    const start = this.advance().start;
    const operand = this.nested(() => this.unary());
    return {kind: 'unary', op, operand, start, end: operand.end};
  }

  // What `read` reads, one level deeper in the tree. A text that nests more
  // than MAX_DEPTH levels deep stops at the current token.
  private nested(read: () => OssieNode): OssieNode {
    if (this.depth >= MAX_DEPTH) throw new Deep(this.peek()?.start ?? this.text.length);
    this.depth++;
    try {
      return read();
    } finally {
      this.depth--;
    }
  }

  private primary(): OssieNode {
    const t = this.peek();
    if (!t) this.stop(AN_EXPRESSION);
    const {start} = t;
    if (this.accept('(')) {
      const inner = this.expr();
      this.take(')');
      return {kind: 'parenthesized', inner, start, end: this.lastEnd};
    }
    if (t.type === 'number' || t.type === 'string') {
      this.advance();
      return {
        kind: 'literal', type: t.type, text: t.written, value: t.value, start,
        end: t.end,
      };
    }
    if (t.type === 'keyword') {
      switch (t.value) {
        case 'TRUE':
        case 'FALSE':
        case 'NULL':
          this.advance();
          return {
            kind: 'literal', type: t.value === 'NULL' ? 'null' : 'boolean',
            text: t.written, value: t.value, start, end: t.end,
          };
        case 'CASE':
          return this.caseExpr();
        case 'CAST':
        case 'TRY_CAST':
          return this.castExpr();
        case 'EXTRACT':
          return this.extractExpr();
        case 'CURRENT_DATE':
        case 'CURRENT_TIME':
        case 'CURRENT_TIMESTAMP': {
          this.advance();
          const parens = !!this.accept('(');
          if (parens) this.take(')');
          return {
            kind: 'currentDatetime',
            name: t.value as 'CURRENT_DATE' | 'CURRENT_TIME' | 'CURRENT_TIMESTAMP',
            parens, start, end: this.lastEnd,
          };
        }
        default:
      }
      if (TYPED_LITERALS.has(t.value) && this.peek(1)?.type === 'string') {
        this.advance();
        const literal = this.advance();
        return {
          kind: 'typedLiteral',
          type: t.value as 'DATE' | 'TIME' | 'TIMESTAMP' | 'TIMESTAMP_NTZ',
          text: literal.written, value: literal.value, start, end: literal.end,
        };
      }
      if (t.value === 'POSITION' && this.is('(', 1)) return this.position();
    }
    if (!this.isName()) this.stop(AN_EXPRESSION);
    if (this.is('(', 1)) return this.functionCall(this.identifier());
    const parts = [this.identifier()];
    while (this.accept('.')) parts.push(this.identifier());
    return {kind: 'reference', parts, start, end: this.lastEnd};
  }

  private functionCall(name: OssieIdentifier): OssieNode {
    this.take('(');
    const star = !!this.accept('*', `'*'`);
    const distinct = !star && !!this.accept('DISTINCT', `'DISTINCT'`);
    const args: OssieNode[] = [];
    if (distinct || !star && !this.is(')')) {
      args.push(this.expr());
      while (this.accept(',', `','`)) args.push(this.expr());
    }
    this.take(')');
    let withinGroup: OssieSortItem[]|undefined;
    let filter: OssieNode|undefined;
    let over: OssieWindow|undefined;
    if (this.accept('WITHIN')) {
      this.take('GROUP');
      this.take('(');
      this.take('ORDER');
      this.take('BY');
      withinGroup = this.sortItems();
      this.take(')');
    }
    if (this.accept('FILTER')) {
      this.take('(');
      this.take('WHERE');
      filter = this.expr();
      this.take(')');
    }
    const overAt = this.peek()?.start;
    if (this.accept('OVER')) over = this.window(overAt!);
    return {
      kind: 'functionCall', name, star, distinct, args,
      ...withinGroup ? {withinGroup} : {}, ...filter ? {filter} : {},
      ...over ? {over} : {}, start: name.start, end: this.lastEnd,
    };
  }

  private sortItems(): OssieSortItem[] {
    const items: OssieSortItem[] = [];
    do {
      const expr = this.expr();
      const direction = this.accept('ASC') ? 'ASC' as const :
          this.accept('DESC')              ? 'DESC' as const :
                                             undefined;
      const nulls = this.accept('NULLS') ?
          this.takeOne(['FIRST', 'LAST'] as const) :
          undefined;
      items.push({
        expr, ...direction ? {direction} : {}, ...nulls ? {nulls} : {},
        start: expr.start, end: this.lastEnd,
      });
    } while (this.accept(',', `','`));
    return items;
  }

  // The window after OVER, which starts at `start`.
  private window(start: number): OssieWindow {
    this.take('(');
    const partitionBy: OssieNode[] = [];
    if (this.accept('PARTITION', `'PARTITION'`)) {
      this.take('BY');
      do partitionBy.push(this.expr());
      while (this.accept(',', `','`));
    }
    let orderBy: OssieSortItem[] = [];
    if (this.accept('ORDER', `'ORDER'`)) {
      this.take('BY');
      orderBy = this.sortItems();
    }
    let frame: OssieWindow['frame'];
    const unitAt = this.peek()?.start;
    if (this.is('ROWS') || this.is('RANGE')) {
      const unit = this.takeOne(['ROWS', 'RANGE'] as const);
      if (this.accept('BETWEEN')) {
        const from = this.frameBound();
        this.take('AND');
        const to = this.frameBound();
        frame = {unit, from, to, start: unitAt!, end: this.lastEnd};
      } else {
        frame = {unit, from: this.frameBound(), start: unitAt!, end: this.lastEnd};
      }
    } else {
      this.expect(`'ROWS'`);
      this.expect(`'RANGE'`);
    }
    this.take(')');
    return {
      partitionBy, orderBy, ...frame ? {frame} : {}, start, end: this.lastEnd,
    };
  }

  private frameBound(): OssieFrameBound {
    const start = this.peek()?.start ?? this.text.length;
    const directions = ['PRECEDING', 'FOLLOWING'] as const;
    if (this.is('UNBOUNDED') && directions.some(d => this.is(d, 1))) {
      this.advance();
      const direction = this.takeOne(directions);
      return {kind: 'unbounded', direction, start, end: this.lastEnd};
    }
    if (this.is('CURRENT') && this.is('ROW', 1)) {
      this.advance();
      this.advance();
      return {kind: 'currentRow', start, end: this.lastEnd};
    }
    const expr = this.expr();
    const direction = this.takeOne(directions);
    return {kind: 'offset', expr, direction, start, end: this.lastEnd};
  }

  private caseExpr(): OssieNode {
    const {start} = this.take('CASE');
    const operand = this.accept('WHEN', `'WHEN'`) ? undefined : this.expr();
    // The first WHEN is taken when there is no operand.
    if (operand) this.take('WHEN');
    const whens: Array<{condition: OssieNode; result: OssieNode}> = [];
    do {
      const condition = this.expr();
      this.take('THEN');
      whens.push({condition, result: this.expr()});
    } while (this.accept('WHEN', `'WHEN'`));
    const otherwise = this.accept('ELSE', `'ELSE'`) ? this.expr() : undefined;
    this.take('END');
    return {
      kind: 'case', ...operand ? {operand} : {}, whens,
      ...otherwise ? {else: otherwise} : {}, start, end: this.lastEnd,
    };
  }

  private castExpr(): OssieNode {
    const keyword = this.advance();
    this.take('(');
    const operand = this.expr();
    this.take('AS');
    const name = this.identifier();
    const params: string[] = [];
    if (this.accept('(')) {
      params.push(this.number());
      if (this.accept(',', `','`)) params.push(this.number());
      this.take(')');
    }
    const type = {name, params, start: name.start, end: this.lastEnd};
    this.take(')');
    return {
      kind: 'cast', try: keyword.value === 'TRY_CAST', operand, type,
      start: keyword.start, end: this.lastEnd,
    };
  }

  private number(): string {
    if (this.peek()?.type !== 'number') this.stop('a number');
    return this.advance().written;
  }

  private extractExpr(): OssieNode {
    const {start} = this.take('EXTRACT');
    this.take('(');
    const field = this.identifier();
    this.take('FROM');
    const operand = this.expr();
    this.take(')');
    return {kind: 'extract', field, operand, start, end: this.lastEnd};
  }

  // POSITION(substring IN string) when the text reads so, and else a call of
  // a function named POSITION. The IN of a predicate can stand where
  // POSITION's IN does, so the substring is read as far as it reads first,
  // and then up to each IN outside parentheses and CASE, from the last. Only
  // a call takes WITHIN GROUP, FILTER or OVER, so one of them after the
  // parentheses makes it a call. Each reading is remembered, so a POSITION
  // nested in the substring of another is read once: by the token it starts
  // at and the token where reading stops, and by the token it starts at
  // alone. A reading holds for any stop at or after the token that follows
  // it, when that token was there to see, since only that token decides
  // that the reading ends there.
  private position(): OssieNode {
    const start = this.pos;
    const key = `${start} ${this.limit}`;
    const at = this.positionsAt.get(start);
    const known = at && this.limit >= at.pos ? at : this.positions.get(key);
    if (known === 'stop') throw new Stop();
    if (known) {
      this.pos = known.pos;
      this.lastEnd = known.lastEnd;
      return known.node;
    }
    try {
      const read = {node: this.positionRead(), pos: this.pos, lastEnd: this.lastEnd};
      this.positions.set(key, read);
      if (this.limit > read.pos) this.positionsAt.set(start, read);
      return read.node;
    } catch (e) {
      if (e instanceof Stop) this.positions.set(key, 'stop');
      throw e;
    }
  }

  // The reading position() remembers.
  private positionRead(): OssieNode {
    const keyword = this.advance();
    const save = this.pos;
    const attempt = (split?: number): OssieNode|undefined => {
      this.pos = save;
      try {
        this.take('(');
        let substring: OssieNode;
        if (split === undefined) {
          substring = this.expr();
        } else {
          const limit = this.limit;
          this.limit = split;
          try {
            substring = this.expr();
            if (this.peek()) this.stop(AN_OPERATOR);
          } finally {
            this.limit = limit;
          }
        }
        this.take('IN');
        const string = this.expr();
        this.take(')');
        return {
          kind: 'position', substring, string, start: keyword.start,
          end: this.lastEnd,
        };
      } catch (e) {
        if (!(e instanceof Stop)) throw e;
        return undefined;
      }
    };
    const read = attempt() ??
        this.ins(save).reverse().reduce<OssieNode|undefined>(
            (found, split) => found ?? attempt(split), undefined);
    if (read && !['WITHIN', 'FILTER', 'OVER'].some(w => this.is(w))) return read;
    this.pos = save;
    return this.functionCall(ossieIdentifier(keyword));
  }

  // Each IN between the parenthesis at token `open` and the one that closes
  // it that stands outside any other parentheses and any CASE.
  private ins(open: number): number[] {
    const found: number[] = [];
    let depth = 0;
    for (let i = open; i < this.limit; i++) {
      const t = this.tokens[i];
      const value = t.type === 'symbol' || t.type === 'keyword' ? t.value : '';
      if (value === '(' || value === 'CASE') depth++;
      if (value === ')' || value === 'END') depth--;
      if (depth === 0) break;
      if (depth === 1 && value === 'IN') found.push(i);
    }
    return found;
  }
}

