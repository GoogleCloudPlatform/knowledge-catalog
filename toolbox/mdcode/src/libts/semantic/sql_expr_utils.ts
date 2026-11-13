// Helpers for reading and rewriting entity-qualified SQL expressions across the
// semantic-model layer.
//
// An expression names a field of its entity as `<Entity>.<field>`, and a
// column of its table without a qualifier. The SQL parser
// (`columnReferences`, `entitiesReached`, `fieldsReadOn`) reads column and
// entity references across dialects for the loader, validator, profile checks,
// pull reader, and transpiler. The graph generators read them with the parser
// too: `measureEntities` places a measure, `measureAggregates` finds its
// aggregates, `withoutQualifier` makes an expression table-local,
// `qualifiedColumns` finds the sibling fields it names and
// `withSiblingsSpliced` puts their SQL in their place, and `requalified` moves
// an inherited expression onto the entity inheriting it. `columnName` and
// `qualifiedName` write a name so that a dialect reads it as that name, and
// `columnKey` and `sameColumns` compare column names across dialects.
//

import {Field, fieldBinding} from './ir';
import {ANY_CASE_DIALECTS, isSimpleIdentifier, nameKey, quoteIfReserved, readsAsKeyword, storedName} from './sql_identifiers';
import {soleColumn, SqlColumn, sqlColumns, sqlExpressionTree, SqlToken, sqlTokens, withoutComments, withoutEngineMessages} from './sql_parser';

// The dialect a graph generator reads `dialect` in: an ANSI_SQL text, or a
// text with no dialect, is read as BigQuery.
function graphReading(dialect?: string): string {
  return !dialect || dialect === 'ANSI_SQL' ? 'BIGQUERY' : dialect;
}

// Each `<name>.` qualifier that `expression`, read in `dialect`, writes before
// a column, for a name in `names`, as indexes into the text's tokens, in the
// order written. A name matches case-sensitively, bare or quoted as the
// dialect quotes an identifier, and not after a dot, so the second `orders` in
// the struct path `orders.orders.id` is not one. The SQL parser decides which
// candidates are qualifiers, so a string literal, a comment or a function
// namespace such as `NET.` in `NET.HOST(orders.url)` holds none. The parser
// reads each candidate as a placeholder name, so one it reserves as a keyword,
// such as `Date` in `Date.days`, still reads as a qualifier. When the parser
// cannot read the text even so, every candidate is taken as a qualifier.
// Undefined when the engine cannot tokenize the text.
function qualifiersIn(
    expression: string, names: ReadonlySet<string>,
    dialect: string): {tokens: SqlToken[]; at: number[]}|undefined {
  const tokens = sqlTokens(expression, dialect);
  if (!tokens) return undefined;
  const chars = Array.from(expression);
  const asWritten = (t: SqlToken) =>
      chars.slice(t.span.start, t.span.end).join('');
  const candidates: number[] = [];
  tokens.forEach((t, i) => {
    if (names.has(t.text) && tokens[i + 1]?.token_type === 'DOT' &&
        tokens[i - 1]?.token_type !== 'DOT' &&
        (t.token_type === 'QUOTED_IDENTIFIER' || asWritten(t) === t.text)) {
      candidates.push(i);
    }
  });
  if (!candidates.length) return {tokens, at: []};
  // A placeholder stem the text does not hold.
  const stem = unusedName(expression, 'kcmd_qualifier_');
  let text = '';
  let end = 0;
  candidates.forEach((i, k) => {
    text += chars.slice(end, tokens[i].span.start).join('') + stem + k;
    end = tokens[i].span.end;
  });
  text += chars.slice(end).join('');
  const columns = columnReferences(text, dialect);
  const at = !columns ? candidates : candidates.filter(
      (_, k) => columns.some(c => c.qualifier?.toLowerCase() === stem + k));
  return {tokens, at};
}

// A name as an expression writes it: its text as written, the name without
// its quotes, and whether quotes wrap it.
export interface WrittenName {
  written: string;
  name: string;
  quoted: boolean;
}

// `expression`, read in `dialect`, with each column it reads, written as
// `<qualifier>.<column>` or as a bare column, replaced by the text `rewrite`
// gives for it, or kept as written when that is undefined. The rest of the
// text stays as written. Only a column whose name or qualifier `names` holds
// in lower case is found, and only where the SQL parser reads that name as
// part of a column, so a keyword, a function name, a date part or a name a
// subquery binds is left alone. A name is part of a column when the text
// with that name alone read as a placeholder reads the same columns, with
// the placeholder in place of the name. A quoted name that stands alone is
// read as a name even where the parser reads it as a function, as it reads
// `current_date` in backticks in BigQuery, when the dialect's database reads
// its quotes as a name's (see NAME_QUOTES). When the parser cannot read the
// text itself, as with a qualifier it reserves as a keyword, such as `order`
// in `order.id`, each such name beside a dot is read as a placeholder in
// every reading. A struct path gives its first two parts. `rewrite` also learns whether the column
// sits in a subquery with its own FROM, at a place where a column of that
// FROM's tables may take the place of its name, and whether that FROM may
// name the table of the column's qualifier (see subqueryTables), and where
// the column stands in the text, with each name read as a placeholder beside
// a dot read so outside the column. Returns `expression` when the engine
// cannot read it so.
export function columnsRewritten(
    expression: string, dialect: string, names: ReadonlySet<string>,
    rewrite: (column: {
      qualifier?: WrittenName; name: WrittenName; inSubquery: boolean;
      bound: boolean; at: NameInText;
    }) => string | undefined): string {
  const tokens = sqlTokens(expression, dialect);
  if (!tokens) return expression;
  const chars = Array.from(expression);
  const written = (t: SqlToken): WrittenName => {
    const text = chars.slice(t.span.start, t.span.end).join('');
    const quoted = t.token_type === 'QUOTED_IDENTIFIER';
    return {written: text, name: quoted ? t.text : text, quoted};
  };
  // The text with each of `edits` made: each replaces the characters from
  // one offset to another, in order. A space keeps a new name apart from a
  // word written against the text it replaces, as `WHEN` is in
  // `WHEN"orders".f`.
  const word = (c: string|undefined) => !!c && /[\p{L}\p{N}_$]/u.test(c);
  const edited = (edits: Array<[number, number, string]>) => {
    let out = '';
    let end = 0;
    for (const [from, to, s] of edits) {
      const before = word(chars[from - 1]) && word(s[0]) ? ' ' : '';
      const after = word(chars[to]) && word(s.at(-1)) ? ' ' : '';
      out += chars.slice(end, from).join('') + before + s + after;
      end = to;
    }
    return out + chars.slice(end).join('');
  };
  const candidates = tokens.flatMap(
      (t, i) => names.has(written(t).name.toLowerCase()) ? [i] : []);
  if (!candidates.length) return expression;
  // A placeholder stem the text does not hold.
  const stem = unusedName(expression, 'kcmd_name_');
  const placeholder = (name: string|undefined, k: number) =>
      name?.toLowerCase() === stem + k;
  const reading = (columns: ReadonlyArray<SqlColumn>) =>
      columns.map(c => `${c.qualifier ?? ''}\0${c.name}`).sort().join('\n');
  // The names read as a placeholder in every reading, one per name, by the
  // index of each token that writes it, and each name by its placeholder.
  const standInStem = unusedName(expression, 'kcmd_stand_in_');
  const standIns = new Map<string, string>();
  const standInNames = new Map<string, string>();
  const misread = new Map<number, string>();
  const standIn = (i: number) => {
    const name = written(tokens[i]).name;
    if (!standIns.has(name)) {
      standIns.set(name, standInStem + standIns.size);
      standInNames.set(standIns.get(name)!, name);
    }
    misread.set(i, standIns.get(name)!);
  };
  // A quoted name the parser reads as something other than a column, such as
  // `current_date` in backticks in BigQuery, is one. Only a name that stands
  // alone counts, with no dot or `(` beside it.
  tokens.forEach((t, i) => {
    const next = tokens[i + 1]?.token_type;
    if (t.token_type !== 'QUOTED_IDENTIFIER' ||
        !opensName(chars[t.span.start], dialect) ||
        tokens[i - 1]?.token_type === 'DOT' || next === 'DOT' ||
        next === 'L_PAREN' || soleColumn(written(t).written, dialect)) {
      return;
    }
    standIn(i);
  });
  // The columns of the text with each name in `misread` read as its
  // placeholder, and with token `at`, when given, read as `as`. Each
  // placeholder of `misread` is read back as its name.
  const readAs = (at?: number, as?: string) => {
    const edits: Array<[number, number, string]> =
        [...misread].filter(([i]) => i !== at)
            .map(([i, p]) => [tokens[i].span.start, tokens[i].span.end, p]);
    if (at !== undefined) {
      edits.push([tokens[at].span.start, tokens[at].span.end, as!]);
    }
    edits.sort((a, b) => a[0] - b[0]);
    const unread = (n: string) => standInNames.get(n.toLowerCase()) ?? n;
    return columnReferences(edits.length ? edited(edits) : expression, dialect)
        ?.map(c => ({
                ...(c.qualifier === undefined ?
                        {} :
                        {qualifier: unread(c.qualifier)}),
                name: unread(c.name),
              }));
  };
  const dot = (i: number) => tokens[i]?.token_type === 'DOT';
  // When the parser cannot read the text, as with a qualifier it reserves as
  // a keyword, such as `order` in `order.id`, each candidate beside a dot is
  // read as a placeholder too. The others stay as written, so the `DATE` of
  // `DATE '2026-01-01'` still reads as a keyword.
  let columns = readAs();
  let besideDots: number[] = [];
  if (!columns) {
    besideDots = candidates.filter(i => dot(i - 1) || dot(i + 1));
    besideDots.forEach(standIn);
    columns = readAs();
    if (!columns) return expression;
  }
  // Where the code points from `from` to `to` stand in the text with each of
  // `besideDots` outside them read as its placeholder, so the parser reads
  // the text around a column as it reads it above.
  const placed = (from: number, to: number): NameInText => {
    const outside = besideDots
        .filter(i => tokens[i].span.end <= from || tokens[i].span.start >= to)
        .map((i): [number, number, string] =>
                 [tokens[i].span.start, tokens[i].span.end, misread.get(i)!]);
    const start = Array.from(edited(outside.filter(([s]) => s < from))).length -
        (chars.length - from);
    return {text: edited(outside), start, end: start + to - from};
  };
  // Each candidate the parser reads as part of a column: as its qualifier,
  // or as its name, with or without a qualifier.
  const roles = new Map<number, 'qualifier'|'qualified'|'bare'>();
  const role = (c: SqlColumn) => placeholder(c.qualifier, 0) ?
      'qualifier' :
      c.qualifier === undefined ? 'bare' : 'qualified';
  for (const i of candidates) {
    const read = readAs(i, stem + 0);
    const hits = read?.filter(
        c => placeholder(c.qualifier, 0) || placeholder(c.name, 0)) ?? [];
    const name = written(tokens[i]).name;
    const back = read?.map(c => ({
      qualifier: placeholder(c.qualifier, 0) ? name : c.qualifier,
      name: placeholder(c.name, 0) ? name : c.name,
    }));
    if (hits.length === 1 && reading(back!) === reading(columns)) {
      roles.set(i, role(hits[0]));
    }
  }
  const binding = bindingSubqueries(tokens);
  const inSubquery = (i: number) => binding[i].length > 0;
  const bound = subqueryTables(chars, tokens, dialect);
  const spans = new Map<number, [number|undefined, number]>();
  for (const [i, r] of roles) {
    if (r !== 'qualifier') {
      spans.set(i, [r === 'qualified' && dot(i - 1) ? i - 2 : undefined, i]);
    } else if (dot(i + 1) && tokens[i + 2]) {
      spans.set(i + 2, [i, i + 2]);
    }
  }
  const edits: Array<[number, number, string]> = [];
  let end = 0;
  for (const [q, n] of [...spans.values()].sort((a, b) => a[1] - b[1])) {
    const from = tokens[q ?? n].span.start;
    const to = tokens[n].span.end;
    const replacement = from < end ? undefined : rewrite({
      qualifier: q === undefined ? undefined : written(tokens[q]),
      name: written(tokens[n]),
      inSubquery: inSubquery(n),
      bound: q !== undefined && bound(q, written(tokens[q])),
      at: placed(from, to),
    });
    if (replacement === undefined) continue;
    edits.push([from, to, replacement]);
    end = to;
  }
  return edits.length ? edited(edits) : expression;
}

// The tokens a subquery's first FROM item holds outside its parentheses: a
// table's name and the dots in it, a function such as UNNEST and the
// parenthesis that opens its arguments, and the item's alias.
const FROM_ITEM_TOKENS =
    new Set(['VAR', 'QUOTED_IDENTIFIER', 'DOT', 'AS', 'L_PAREN']);

// For each of `tokens`, the subqueries whose own FROM may give a table in
// place of a name it holds, each by the index of the parenthesis that opens
// it: each subquery around the token that has a FROM, unless the token sits
// in that subquery's first FROM item, which reads only the names of the
// query around it, as UNNEST(orders.items) does, or in the WITH clause the
// subquery opens with. A subquery is a parenthesis that opens with SELECT or
// WITH.
export function bindingSubqueries(tokens: SqlToken[]): number[][] {
  // Each subquery's phase is -1 in the WITH clause it opens with, 0 before
  // its FROM, 1 in its first FROM item, and 2 after it.
  type Query = {at: number; phase: number; from: boolean};
  const open: Array<Query|undefined> = [];
  const exposed: Query[][] = [];
  tokens.forEach((t, i) => {
    const type = t.token_type;
    const top = open.at(-1);
    if (top?.phase === -1 && type === 'SELECT') top.phase = 0;
    if (top?.phase === 1 && !FROM_ITEM_TOKENS.has(type)) top.phase = 2;
    if (top && type === 'FROM' && top.phase === 0) {
      top.phase = 1;
      top.from = true;
    }
    exposed.push(open.filter(
        (q): q is Query => !!q && q.phase !== 1 && q.phase !== -1));
    if (type === 'L_PAREN') {
      const next = tokens[i + 1]?.token_type;
      open.push(
          next === 'SELECT' ? {at: i, phase: 0, from: false} :
          next === 'WITH'   ? {at: i, phase: -1, from: false} :
                              undefined);
    } else if (type === 'R_PAREN') {
      open.pop();
    }
  });
  return exposed.map(qs => qs.filter(q => q.from).map(q => q.at));
}

// Whether a qualifier named `name`, token `i` of `tokens`, read in `dialect`,
// whose text's characters are `chars`, may name a table of a subquery
// around it: a table or alias its own FROM names, compared as nameKey
// compares two names of the text, where that FROM's tables may take the
// place of a name (see bindingSubqueries). `original` gives the name a
// placeholder name of the text stands for, and undefined for any other
// name. A subquery the parser cannot read alone is taken to name every
// qualifier in it.
export function subqueryTables(
    chars: string[], tokens: SqlToken[], dialect: string,
    original: (name: string) => {name: string; quoted: boolean}|undefined =
        () => undefined):
    (i: number, name: {name: string; quoted: boolean}) => boolean {
  const binding = bindingSubqueries(tokens);
  // The token that closes each parenthesis, by the token that opens it.
  const closes = new Map<number, number>();
  const open: number[] = [];
  tokens.forEach((t, i) => {
    if (t.token_type === 'L_PAREN') open.push(i);
    if (t.token_type === 'R_PAREN' && open.length) closes.set(open.pop()!, i);
  });
  // The names each subquery's FROM gives, by the token that opens it.
  const names = new Map<number, Set<string>|undefined>();
  const namesAt = (at: number) => {
    if (!names.has(at)) {
      const end = tokens[closes.get(at) ?? tokens.length - 1].span.end;
      const text = chars.slice(tokens[at].span.start, end).join('');
      names.set(
          at, fromNames(sqlExpressionTree(text, dialect), dialect, original));
    }
    return names.get(at);
  };
  return (i, name) => binding[i].some(at => {
    const named = namesAt(at);
    return !named || named.has(nameKey(name, dialect));
  });
}

// The names of the tables and aliases that the FROM of the subquery `tree`,
// the parser's tree of one in a text of `dialect`, names, with its JOINs and
// its WITH, in each SELECT of a UNION, INTERSECT or EXCEPT, each as nameKey
// gives it. A placeholder name stands for the name `original` gives for it.
// Undefined when `tree` is not a subquery.
function fromNames(
    tree: any, dialect: string,
    original: (name: string) => {name: string; quoted: boolean}|undefined):
    Set<string>|undefined {
  const query = tree?.subquery?.this;
  if (!query) return undefined;
  const names = new Set<string>();
  const add = (n: any) => {
    if (typeof n?.name !== 'string') return;
    const name = original(n.name) ?? {name: n.name, quoted: n.quoted === true};
    names.add(nameKey(name, dialect));
  };
  const visit = (item: any) => {
    if (item?.alias) {
      add(item.alias.alias);
      visit(item.alias.this);
    }
    add(item?.table?.name);
    for (const kind of ['table', 'unnest', 'subquery']) {
      add(item?.[kind]?.alias);
    }
  };
  const read = (q: any) => {
    const set = q?.union ?? q?.intersect ?? q?.except;
    const select = q?.select;
    for (const cte of (set ?? select)?.with?.ctes ?? []) add(cte?.alias);
    if (set) {
      read(set.left);
      read(set.right);
    }
    for (const item of select?.from?.expressions ?? []) visit(item);
    for (const join of select?.joins ?? []) visit(join?.this);
  };
  read(query);
  return names;
}

// `name` in the quotes a text of `dialect` writes a name in: backticks in
// GoogleSQL, MySQL and Databricks, brackets in T-SQL, and double quotes in
// the others. An ANSI_SQL text on a table of `tableDialect` writes it as that
// dialect does. A quote character in `name` is escaped as the dialect escapes
// one.
export function quotedName(
    name: string, dialect: string, tableDialect?: string): string {
  switch (namingDialect(dialect, tableDialect)) {
    case 'BIGQUERY':
    case 'SPANNER':
      return `\`${name.replace(/[\\`]/g, '\\$&')}\``;
    case 'MYSQL':
    case 'DATABRICKS':
      return `\`${name.replace(/`/g, '``')}\``;
    case 'SQLSERVER':
      return `[${name.replace(/]/g, ']]')}]`;
    default:
      return `"${name.replace(/"/g, '""')}"`;
  }
}

// The dialect whose rules read and write a name in a text of `dialect`: an
// ANSI_SQL text on a table of `tableDialect` runs as that dialect's SQL.
function namingDialect(dialect: string, tableDialect?: string): string {
  const d = dialect.toUpperCase();
  return d === 'ANSI_SQL' && tableDialect ? tableDialect.toUpperCase() : d;
}

// Where a name stands in an expression: alone, before a dot, or after one.
type NamePlace = 'alone'|'qualifier'|'member';

// The characters that open a quoted name in each dialect that reads a name
// in quotes other than double quotes. SQL Server reads both brackets and
// double quotes. Every other dialect reads double quotes only.
const NAME_QUOTES: Readonly<Record<string, string>> = {
  BIGQUERY: '`',
  SPANNER: '`',
  MYSQL: '`',
  DATABRICKS: '`',
  SQLSERVER: '["',
};

// Whether `quote` opens a quoted name in a text of `dialect` (see
// NAME_QUOTES).
function opensName(quote: string|undefined, dialect: string): boolean {
  return !!quote &&
      (NAME_QUOTES[dialect.toUpperCase()] ?? '"').includes(quote);
}

// Whether a text of `dialect` on a table of `tableDialect` reads `quote` as
// the quote that opens a name, as BigQuery reads a backtick and not a double
// quote. An ANSI_SQL text reads quotes as its table's dialect does.
export function quotesName(
    quote: string|undefined, dialect: string, tableDialect?: string): boolean {
  return opensName(quote, namingDialect(dialect, tableDialect));
}

// The dialects whose database reads any word after a dot as a name, as
// BigQuery reads `t.order`. In the other dialects, a word the database reads
// as a keyword alone is quoted after a dot too, as SQL Server needs
// `t.[order]`.
const MEMBER_KEYWORD_DIALECTS =
    new Set(['BIGQUERY', 'SPANNER', 'POSTGRES', 'ALLOYDB', 'MYSQL']);

// The name `text` reads as in a text of `dialect` when it stands at `at`, and
// whether it is quoted, or undefined when it is not one name that reads as a
// name there. A quoted name reads as the name inside its quotes, as the
// tokenizer gives it, since the parser reads one such as "current_date" as
// the function, when the dialect's database reads those quotes as a name's
// (see NAME_QUOTES). A name without quotes reads as itself when the parser
// reads it as a column there and the dialect's database does not read it as
// a keyword or a function (see readsAsKeyword), which after a dot only some
// databases do not (see MEMBER_KEYWORD_DIALECTS).
function nameRead(text: string, dialect: string, at: NamePlace):
    {name: string; quoted: boolean}|undefined {
  const tokens = sqlTokens(text, dialect);
  if (tokens?.length !== 1) return undefined;
  if (tokens[0].token_type === 'QUOTED_IDENTIFIER') {
    return opensName(text[0], dialect) ? {name: tokens[0].text, quoted: true} :
                                         undefined;
  }
  if ((at !== 'member' || !MEMBER_KEYWORD_DIALECTS.has(dialect.toUpperCase())) &&
      readsAsKeyword(text, dialect)) {
    return undefined;
  }
  const other = unusedName(text, 'kcmd_name_');
  const column = soleColumn(
      at === 'alone'     ? text :
      at === 'qualifier' ? `${text}.${other}` :
                           `${other}.${text}`,
      dialect);
  const read = !column || column.quoted ? undefined :
      at === 'alone'     ? !column.qualifier && column.name :
      at === 'qualifier' ? column.name === other && column.qualifier :
                           column.qualifier === other && column.name;
  return read === text ? {name: text, quoted: false} : undefined;
}

// `part`, a name an expression writes at `at`, as a text of `dialect` writes
// it there so that it reads as a name `same` accepts, given the text: as
// written when it reads so, else as `plain` without quotes when that is a
// plain identifier that reads so, and else as `quoted`.
function partWritten(
    part: WrittenName, dialect: string, at: NamePlace,
    same: (read: {name: string; quoted: boolean}, text: string) => boolean,
    plain: string, quoted: string): string {
  const reads = (text: string) => {
    const read = nameRead(text, dialect, at);
    return !!read && same(read, text);
  };
  if (reads(part.written)) return part.written;
  return isSimpleIdentifier(plain) && reads(plain) ? plain : quoted;
}

// Where a name stands in a text: the text, and the code points from the
// start of the name's qualifier, or of the name when it has none, to the end
// of the name, end exclusive.
export interface NameInText {
  text: string;
  start: number;
  end: number;
}

// Whether `written`, a column written without a qualifier, reads as the
// column `name` where `at` places it, in a text of `dialect`. It does when
// the text with `written` in that place reads the columns it reads with a
// placeholder name there, with `name` in the placeholder's place. So `day`
// does not read as a column as the first argument of DATEDIFF, nor `if`
// before `+ 1`. It does not either when the text reads no column at the
// placeholder, as SQL Server reads any name there as a date part. True when
// the parser cannot read the text with the placeholder.
function readsInPlace(
    written: string, name: string, at: NameInText, dialect: string): boolean {
  const chars = Array.from(at.text);
  const word = (c: string|undefined) => !!c && /[\p{L}\p{N}_$]/u.test(c);
  const placed = (s: string) => chars.slice(0, at.start).join('') +
      (word(chars[at.start - 1]) ? ' ' : '') + s +
      (word(chars[at.end]) ? ' ' : '') + chars.slice(at.end).join('');
  const stem = unusedName(at.text + written, 'kcmd_place_');
  const before = columnReferences(placed(stem), dialect);
  if (!before) return true;
  const is = (part: string|undefined) => part?.toLowerCase() === stem;
  if (!before.some(c => is(c.qualifier) || is(c.name))) return false;
  const after = columnReferences(placed(written), dialect);
  const key = (cs: ReadonlyArray<SqlColumn>) =>
      cs.map(c => `${c.qualifier ?? ''}\0${c.name}`).sort().join('\n');
  return !!after &&
      key(after) ===
      key(before.map(c => ({
                       ...(c.qualifier === undefined ?
                               {} :
                               {qualifier: is(c.qualifier) ? name : c.qualifier}),
                       name: is(c.name) ? name : c.name,
                     })));
}

// Column `original`, as a text of `dialect` writes it, written with no
// qualifier so that the dialect reads the same column: as written when it
// reads as that column alone, and where `at` places it when given, and
// otherwise in the dialect's quotes, since a name such as `current_date`
// reads as a function without its qualifier, one such as `order` as a
// keyword, and `day` as a date part as the first argument of DATEDIFF. When the dialect's database stores
// a name written without quotes in another letter case, the quotes hold the
// name in that case, so `current_date` in a SNOWFLAKE text becomes
// "CURRENT_DATE" and `CURRENT_USER` in a POSTGRES text becomes
// "current_user". A quoted name
// whose quotes the dialect does not read as a name, such as "amount" in an
// ANSI_SQL text on a BIGQUERY table, is written without quotes when it is a
// plain identifier that reads as that column, and else in the dialect's
// quotes. An ANSI_SQL text on a table of `tableDialect` is written as that
// dialect writes it, and one on a table of no known dialect as standard SQL
// writes it: in double quotes, with a name written without quotes in upper
// case.
export function columnName(
    original: WrittenName, dialect: string, tableDialect?: string,
    at?: NameInText): string {
  const d = namingDialect(dialect, tableDialect);
  const stored = storedName(original.name, original.quoted, d);
  return partWritten(
      original, d, 'alone',
      (read, text) => storedName(read.name, read.quoted, d) === stored &&
          (!at || readsInPlace(text, read.name, at, d)),
      stored, quotedName(stored, d));
}

// `<qualifier>.<name>`, a field or a column with the qualifier of its dataset
// or table, written so that a text of `dialect` reads it as those two names:
// each part as written when it reads so in its place, and otherwise in the
// dialect's quotes, so a qualifier such as `date`, which does not read as a
// name before a dot, becomes "date" in a POSTGRES text and `date` in
// backticks in a BIGQUERY text. Each part keeps its letter case, since kcmd
// matches these names as written. A quoted part whose quotes the dialect
// does not read as a name is written without quotes when it is a plain
// identifier that reads so. An ANSI_SQL text on a table of `tableDialect` is
// written as that dialect writes it.
export function qualifiedName(
    qualifier: WrittenName, name: WrittenName, dialect: string,
    tableDialect?: string): string {
  const d = namingDialect(dialect, tableDialect);
  const part = (p: WrittenName, at: NamePlace) => partWritten(
      p, d, at, read => read.name === p.name, p.name, quotedName(p.name, d));
  return `${part(qualifier, 'qualifier')}.${part(name, 'member')}`;
}

// A column's name as the database of a text's dialect matches it, as
// columnKey gives it, for comparing column names across dialects with
// sameColumns.
export interface ColumnKey {
  // The name as the database stores it.
  stored: string;
  // Whether the database matches the name in any letter case.
  anyCase: boolean;
  // Whether a name written without quotes is stored so, as `amount` is in
  // POSTGRES and `AMOUNT` in SNOWFLAKE.
  folded: boolean;
}

// Column `column`, written in a text of `dialect` with or without quotes, as
// that dialect's database matches it. BIGQUERY, SPANNER, MYSQL, DATABRICKS
// and SQLSERVER match a column in any letter case. POSTGRES and ALLOYDB store
// a name written without quotes in lower case, and other dialects, such as
// SNOWFLAKE, in upper case; each stores a quoted name as written. An ANSI_SQL
// text on a table of `tableDialect` is matched as that dialect matches it.
export function columnKey(
    column: {name: string; quoted: boolean}, dialect: string,
    tableDialect?: string): ColumnKey {
  const d = namingDialect(dialect, tableDialect);
  const stored = storedName(column.name, column.quoted, d);
  return {
    stored,
    anyCase: ANY_CASE_DIALECTS.has(d),
    folded: /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(stored) &&
        storedName(stored, false, d) === stored,
  };
}

// Whether every two of `keys` can name the same column. Two keys do when
// either database ignores case and the names are equal in any case, when
// the stored names are equal, or when both are the stored form of one name
// written without quotes, as `amount` in POSTGRES and `AMOUNT` in SNOWFLAKE
// are. Every pair is compared, since the relation is not transitive: a
// BIGQUERY `tax` matches both `tax` and "Tax" in POSTGRES, which do not
// match each other.
export function sameColumns(keys: readonly ColumnKey[]): boolean {
  const same = (a: ColumnKey, b: ColumnKey) =>
      a.anyCase || b.anyCase || a.folded && b.folded ?
      a.stored.toLowerCase() === b.stored.toLowerCase() :
      a.stored === b.stored;
  return keys.every((a, i) => keys.slice(i + 1).every(b => same(a, b)));
}

// `base`, a lowercase name, with underscores added until `text` does not hold
// it in any case.
export function unusedName(text: string, base: string): string {
  let name = base;
  while (text.toLowerCase().includes(name)) name += '_';
  return name;
}

// `expression` without each `<qualifier>.` it writes before a column (see
// qualifiersIn), so it reads the columns of the qualifier's own table. The
// rest of the text stays as written. The text is read in `dialect`; an
// ANSI_SQL text, or one with no dialect, is read as BigQuery, as the graph
// generators read it. Returns `expression` itself when it writes no such
// qualifier or the engine cannot tokenize it.
export function withoutQualifier(
    expression: string, qualifier: string, dialect?: string): string {
  return spliced(expression, qualifier, graphReading(dialect), new Map());
}

// `expression`, BigQuery SQL on `qualifier`'s table, as withoutQualifier gives
// it, except that each `<qualifier>.<field>` whose field `siblings` holds is
// replaced, whole, by the SQL it maps to, as given. The graph generators put
// the SQL of each sibling field an expression names in its place so (see
// graph_ddl.fieldSql).
export function withSiblingsSpliced(
    expression: string, qualifier: string,
    siblings: ReadonlyMap<string, string>): string {
  return spliced(expression, qualifier, 'BIGQUERY', siblings);
}

// `expression`, read in `dialect`, without each `<qualifier>.` it writes
// before a column (see qualifiersIn), and with each `<qualifier>.<column>`
// whose column `replacements` holds replaced, whole, by the SQL it maps to.
function spliced(
    expression: string, qualifier: string, dialect: string,
    replacements: ReadonlyMap<string, string>): string {
  const read = qualifiersIn(expression, new Set([qualifier]), dialect);
  if (!read?.at.length) return expression;
  const {tokens, at} = read;
  const chars = Array.from(expression);
  let out = '';
  let end = 0;
  for (const i of at) {
    out += chars.slice(end, tokens[i].span.start).join('');
    const column = tokens[i + 2];
    const replacement = column && replacements.get(nameOf(column, chars));
    if (replacement !== undefined) {
      out += replacement;
      end = column.span.end;
    } else {
      // The qualifier, its dot, and what lies between the dot and the column.
      end = column?.span.start ?? tokens[i + 1].span.end;
    }
  }
  return out + chars.slice(end).join('');
}

// The column written after each `<qualifier>.` that `expression` writes before
// a column (see qualifiersIn), without its quotes, in the order written, so
// ``orders.a + `orders`.`b`.c`` gives `a` and `b`. The text is read in
// `dialect`, as withoutQualifier reads it, so a qualifier the parser reserves,
// such as `Date` in `Date.days`, gives its column too. Undefined when the
// engine cannot tokenize the text.
export function qualifiedColumns(
    expression: string, qualifier: string, dialect?: string): string[]|
    undefined {
  const read =
      qualifiersIn(expression, new Set([qualifier]), graphReading(dialect));
  if (!read) return undefined;
  const chars = Array.from(expression);
  return read.at.filter(i => read.tokens[i + 2])
      .map(i => nameOf(read.tokens[i + 2], chars));
}

// The name token `t` of the text whose characters are `chars` gives, as
// written, without its quotes.
function nameOf(t: SqlToken, chars: string[]): string {
  return t.token_type === 'QUOTED_IDENTIFIER' ?
      t.text :
      chars.slice(t.span.start, t.span.end).join('');
}

// The error for a field of `owner` that names itself. `cycle` starts at that
// field and runs through the fields it names back to it, and `where` follows
// the field's name, as ` in model 'm' (doc)` does. The graph renders a field
// that names a sibling field from that sibling's own SQL (see
// graph_ddl.fieldSql), so a field that reaches itself has none.
export function selfReferenceMessage(
    owner: string, cycle: string[], where = ''): string {
  const [field, ...through] = cycle;
  return `field '${owner}.${field}'${where} names itself` +
      (through.length ?
           ` through ${through.map(n => `'${owner}.${n}'`).join(', ')}` :
           '') +
      `; a field expression may name other fields of its entity, but not ` +
      `itself, directly or through other fields` +
      (through.length ? '' :
                        `; to read the column of that name, write it ` +
               `without the qualifier: '${quoteIfReserved(field)}'`);
}

// `expression` with each `<from>.` qualifier it writes before a column (see
// qualifiersIn) renamed `<to>.`, quoted as it was written. The rest of the
// text stays as written. The text is read in `dialect`, as withoutQualifier
// reads it. Returns `expression` itself when it writes no such qualifier or
// the engine cannot tokenize it.
export function requalified(
    expression: string, from: string, to: string, dialect?: string): string {
  const read = qualifiersIn(expression, new Set([from]), graphReading(dialect));
  if (!read?.at.length) return expression;
  const {tokens, at} = read;
  const chars = Array.from(expression);
  let out = '';
  let end = 0;
  for (const i of at) {
    const {start, end: after} = tokens[i].span;
    out += chars.slice(end, start).join('') +
        chars.slice(start, after).join('').replace(from, () => to);
    end = after;
  }
  return out + chars.slice(end).join('');
}

// The entities from `entityNames` whose qualifier a metric's BigQuery SQL
// `expression` writes before a column (see qualifiersIn), deduplicated in the
// order written, or else `entity`, the metric's anchor, when given. The
// BigQuery generator places the metric's measure on the entity this gives
// when it gives one, and a BigQuery push rejects a metric it gives several or
// none for (see validate.ts).
export function measureEntities(
    expression: string, entityNames: ReadonlyArray<string>,
    entity?: string): string[] {
  const read = qualifiersIn(expression, new Set(entityNames), 'BIGQUERY');
  const reached = [...new Set(read?.at.map(i => read.tokens[i].text) ?? [])];
  return reached.length || !entity ? reached : [entity];
}

// `text`, written in `dialect`, with its comments removed. An ANSI_SQL text, or
// a text with no dialect, is read as BigQuery, as the loader and the graph
// generators read it.
export function sqlWithoutComments(text: string, dialect?: string): string {
  return withoutComments(text, graphReading(dialect));
}

// `field`'s binding, as fieldBinding gives it, with its comments removed.
// Undefined when the field is unbound. The target text is read in
// `targetDialect`, BigQuery unless given. The parser reads Spanner SQL as
// BigQuery. Imported vendor SQL, the binding only when there is no target
// text, is read in its imported dialect, so it keeps what that dialect does
// not read as a comment.
export function fieldBindingWithoutComments(
    field: Pick<Field, 'expression'|'importedExpression'|'importedDialect'>,
    targetDialect?: string): string|undefined {
  const text = fieldBinding(field);
  if (text === undefined) return undefined;
  return sqlWithoutComments(
      text,
      field.expression === undefined ? field.importedDialect : targetDialect);
}

// Results of columnReferences by dialect and text, so the checks one push
// runs read each text once. When full, the oldest entry goes.
const MAX_COLUMN_CACHE_SIZE = 65536;
const COLUMN_CACHE = new Map<string, ReadonlyArray<SqlColumn>|undefined>();

// Every column an expression reads, with the qualifier written before it, in
// the order written, or undefined when the SQL parser cannot read the
// expression in `dialect`, one of the dialect names a dialect list uses. The
// parser handles string literals, comments and each dialect's quoting, so
// `"orders"."amount"` in a PostgreSQL text reads the column `amount` of
// `orders`, while in BigQuery the same text is not SQL and gives undefined. A struct path reads
// as its first two parts: `orders.shipping_address.city` reads
// `shipping_address` of `orders`.
export function columnReferences(expression: string, dialect: string):
    ReadonlyArray<SqlColumn>|undefined {
  const key = `${dialect.toUpperCase()}\0${expression}`;
  if (COLUMN_CACHE.has(key)) return COLUMN_CACHE.get(key);
  const cols = sqlColumns(expression, dialect);
  if (COLUMN_CACHE.size >= MAX_COLUMN_CACHE_SIZE) {
    COLUMN_CACHE.delete(COLUMN_CACHE.keys().next().value!);
  }
  COLUMN_CACHE.set(key, cols);
  return cols;
}

// Reads the columns of `text` in `dialect`. An `ANSI_SQL` text is read in the
// dialect the model's sources imply (`impliedDialect`), since the database runs
// an `ANSI_SQL` entry as its own SQL. When the sources do not imply a single
// dialect, the generic parser reads the text, and any bare identifier that
// BigQuery's parser does not also read as a bare column (such as a `MONTH`
// date part or a double-quoted string literal) is filtered out. When their
// dialect is null, which no lookup read, an `ANSI_SQL` text is not read.
export function columnsForSource(
    text: string, dialect: string,
    impliedDialect?: string|null): ReadonlyArray<SqlColumn>|undefined {
  if (dialect === 'ANSI_SQL' && impliedDialect === null) return undefined;
  if (dialect === 'ANSI_SQL' && impliedDialect) {
    return columnReferences(text, impliedDialect);
  }
  const cols = columnReferences(text, dialect);
  if (!cols || dialect !== 'ANSI_SQL') return cols;
  const bqCols = columnReferences(text, 'BIGQUERY');
  if (!bqCols) return cols;
  const bqBare =
      new Set(bqCols.filter(c => c.qualifier === undefined).map(c => c.name));
  return cols.filter(c => c.qualifier !== undefined || bqBare.has(c.name));
}

// The columns an ANSI_SQL text reads when no lookup read its tables' dialect,
// read as generic SQL. `dialects` are the dialects those tables may have.
// Each name whose reading depends on the dialect is left out: an unqualified
// name, which may be a keyword there, such as `month` in
// `DATE_TRUNC(month, ts)`, and a name in double quotes, which some databases
// read as a string. `skipped` is set when a name is left out. Undefined when
// the parser cannot read the text in one of `dialects` or as generic SQL.
export function columnsWithoutDialect(
    text: string, dialects: readonly string[]):
    {columns: SqlColumn[]; skipped: boolean}|undefined {
  // T-SQL's parser panics on `IF(...)`, and the tables may not run T-SQL, so
  // the engine's message stays out of the output.
  if (withoutEngineMessages(
          () => dialects.some(d => !columnReferences(text, d)))) {
    return undefined;
  }
  const tokens = sqlTokens(text, 'ANSI_SQL');
  if (!tokens) return undefined;
  // Each name in double quotes is read as a placeholder name, so the columns
  // it gives can be told apart.
  const chars = Array.from(text);
  const stem = unusedName(text, 'kcmd_quoted_');
  let read = '';
  let end = 0;
  tokens.filter(t => t.token_type === 'QUOTED_IDENTIFIER' &&
                    chars[t.span.start] === '"')
      .forEach((t, k) => {
        read += chars.slice(end, t.span.start).join('') + stem + k;
        end = t.span.end;
      });
  read += chars.slice(end).join('');
  const all = columnReferences(read, 'ANSI_SQL');
  if (!all) return undefined;
  const columns = all.filter(
      c => c.qualifier !== undefined && !c.qualifier.startsWith(stem) &&
          !c.name.startsWith(stem));
  return {columns, skipped: columns.length < all.length};
}

// The entities from `entityNames` that `columns` read, deduplicated in
// first-seen order. Matching is case-sensitive.
export function entitiesReached(
    columns: ReadonlyArray<SqlColumn>,
    entityNames: ReadonlyArray<string>|ReadonlySet<string>): string[] {
  const known =
      entityNames instanceof Set ? entityNames : new Set(entityNames);
  const reached: string[] = [];
  for (const c of columns) {
    if (c.qualifier && known.has(c.qualifier) &&
        !reached.includes(c.qualifier)) {
      reached.push(c.qualifier);
    }
  }
  return reached;
}

// The fields `columns` read on `entityName`, written `entityName.field`,
// deduplicated in first-seen order. Matching is case-sensitive.
export function fieldsReadOn(
    columns: ReadonlyArray<SqlColumn>, entityName: string):
    string[] {
  const fields: string[] = [];
  for (const c of columns) {
    if (c.qualifier === entityName && !fields.includes(c.name)) {
      fields.push(c.name);
    }
  }
  return fields;
}

// The aggregates BigQuery accepts in a MEASURE, its complete list. BigQuery
// rejects any other there, such as COUNTIF or APPROX_COUNT_DISTINCT.
export const SUPPORTED_AGGREGATES = ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'];

// When `expression`, read in `dialect`, is one of SUPPORTED_AGGREGATES over
// one operand, or COUNT(*), with at most DISTINCT or ALL, and the operand holds
// no other aggregate, window or subquery: the function's name as written, the
// operand as written without the parentheses around it (so
// `COUNT(DISTINCT(x))` gives `x`), and whether the call is DISTINCT. COUNT(*)
// gives the operand `*`. Undefined otherwise.
export function singleAggregate(expression: string, dialect: string):
    {fn: string; operand: string; distinct: boolean}|undefined {
  const node = unwrapped(sqlExpressionTree(expression, dialect));
  const kind = node && Object.keys(node).length === 1 ? Object.keys(node)[0] :
                                                        undefined;
  if (!kind || !isAggregateCall(kind, node[kind]) ||
      aggregateProblem(kind, node[kind])) {
    return undefined;
  }
  // The call as written: its name, `(`, DISTINCT or ALL if written, the
  // operand and `)`, inside any parentheses around the whole call.
  const tokens = unparenthesized(sqlTokens(expression, dialect) ?? []);
  if (tokens.length < 4 ||
      !SUPPORTED_AGGREGATES.includes(tokens[0].text.toUpperCase()) ||
      tokens[1].token_type !== 'L_PAREN' ||
      closingParen(tokens, 1) !== tokens.length - 1) {
    return undefined;
  }
  let inner = tokens.slice(2, -1);
  if (inner[0]?.token_type === 'DISTINCT' || inner[0]?.token_type === 'ALL') {
    inner = inner.slice(1);
  }
  inner = unparenthesized(inner);
  if (!inner.length) return undefined;
  const chars = Array.from(expression);
  return {
    fn: tokens[0].text,
    operand: chars.slice(inner[0].span.start, inner[inner.length - 1].span.end)
                 .join(''),
    distinct: node[kind].distinct === true,
  };
}

// An aggregate a BigQuery measure applies, as measureAggregates gives it:
// where the call is written in the expression, from its name to its `)`, in
// code points with the end exclusive, and the call as singleAggregate reads it.
export interface MeasureAggregate {
  start: number;
  end: number;
  fn: string;
  operand: string;
  distinct: boolean;
}

// `expression` with each of `aggregates` replaced by what `by` gives for it.
export function replacedAggregates(
    expression: string, aggregates: MeasureAggregate[],
    by: (agg: MeasureAggregate, i: number) => string): string {
  const chars = Array.from(expression);
  let text = '';
  let after = 0;
  aggregates.forEach((agg, i) => {
    text += chars.slice(after, agg.start).join('') + by(agg, i);
    after = agg.end;
  });
  return text + chars.slice(after).join('');
}

// The aggregates of `expression`, read in `dialect`, in the order written,
// when it can be a BigQuery measure; else why it cannot, as a clause such as
// `it reads field 'amount' outside an aggregate`. It can be one when it holds
// an aggregate; each aggregate it holds is one singleAggregate reads; no window
// or subquery sits outside them; every field it reads sits inside one; and it
// calls no user-defined function outside them. Arithmetic, CASE, IF and
// BigQuery's other built-in scalar functions, and literals, may surround the
// aggregates, as in `SUM(o.amount) / COUNT(o.id)`. The push checks and the
// BigQuery generator both read a measure so.
export function measureAggregates(expression: string, dialect: string):
    {aggregates: MeasureAggregate[]}|{problem: string} {
  const tree = sqlExpressionTree(expression, dialect);
  const tokens = sqlTokens(expression, dialect);
  if (!tree || !tokens || tokens.some(t => t.token_type === 'SEMICOLON')) {
    return {problem: 'the SQL parser cannot read it as one expression'};
  }
  const {calls, windowOrSubquery} = aggregateCalls(tree);
  if (windowOrSubquery) return {problem: 'it uses a window or a subquery'};
  if (!calls.length) {
    return {
      problem: `it holds no aggregate (${SUPPORTED_AGGREGATES.join(', ')})`
    };
  }
  for (const [kind, call] of calls) {
    const problem = aggregateProblem(kind, call);
    if (problem) return {problem};
  }
  // Where each call is written: the first call, from the left, that
  // singleAggregate reads, then the next one after it. A function in a
  // namespace, such as `ds.SUM`, is not one of the aggregates.
  const chars = Array.from(expression);
  const aggregates: MeasureAggregate[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i + 1].token_type !== 'L_PAREN' ||
        tokens[i - 1]?.token_type === 'DOT') {
      continue;
    }
    const close = closingParen(tokens, i + 1);
    if (close < 0) break;
    const {start} = tokens[i].span;
    const {end} = tokens[close].span;
    const agg = singleAggregate(chars.slice(start, end).join(''), dialect);
    if (!agg) continue;
    aggregates.push({start, end, ...agg});
    i = close;
  }
  if (aggregates.length !== calls.length) {
    return {problem: 'the SQL parser cannot tell where each aggregate is'};
  }
  // The fields read outside the aggregates: those of the text with each
  // aggregate replaced by a literal.
  const rest = replacedAggregates(expression, aggregates, () => ' 0 ');
  const outside = sqlColumns(rest, dialect);
  if (!outside) {
    return {problem: 'the SQL parser cannot read it as one expression'};
  }
  if (outside.length) {
    return {
      problem: `it reads field '${outside[0].name}' outside an aggregate`
    };
  }
  // BigQuery accepts a graph whose measure calls a user-defined function
  // outside its aggregates, but every GRAPH_EXPAND query on that node table
  // then fails with "Function not found". One inside an aggregate's operand
  // becomes a property, so it stays allowed.
  const udf = userDefinedFunction(sqlExpressionTree(rest, dialect));
  if (udf) {
    return {
      problem: `it calls user-defined function '${udf}' outside an ` +
          `aggregate, which BigQuery cannot read in a measure`
    };
  }
  return {aggregates};
}

// The first user-defined function the parser's tree `node` calls, by its
// dotted name, such as `ds.f`, or undefined when it calls none: a call whose
// name has a dot, other than `SAFE.` before one name, as in `SAFE.LOG10`.
// BigQuery reads `ml.f` or `net.f` as the function of a dataset with that
// name. The parser reads `` `p.ds.f`(…) `` as a function of that name, and
// `ds.f(…)` or `p.ds.f(…)` as a method call on a column.
function userDefinedFunction(node: unknown): string|undefined {
  if (node === null || typeof node !== 'object') return undefined;
  for (const [kind, value] of Object.entries(node)) {
    const name = kind === 'function' ? String(value.name) :
        kind === 'method_call' ?
        [...namePath(value.this), value.method?.name].join('.') :
        '';
    const parts = name.split('.');
    if (parts.length > 1 &&
        !(parts.length === 2 && parts[0].toUpperCase() === 'SAFE')) {
      return name;
    }
    const inner = userDefinedFunction(value);
    if (inner) return inner;
  }
  return undefined;
}

// The parts of the dotted name the parser's tree `node` reads, such as
// ['p', 'ds'] for `p.ds`, or none when it reads something else.
function namePath(node: any): string[] {
  if (node?.column) {
    const {table, name} = node.column;
    return table ? [table.name, name.name] : [name.name];
  }
  if (node?.dot) return [...namePath(node.dot.this), node.dot.field.name];
  return [];
}

// Why the parser's aggregate call `call`, of node kind `kind`, cannot be in a
// BigQuery measure, or undefined when it can: when it is one of
// SUPPORTED_AGGREGATES over one operand, or COUNT(*), with at most DISTINCT or
// ALL, and the operand holds no other aggregate, window or subquery.
function aggregateProblem(kind: string, call: any): string|undefined {
  // The parser keeps the call's name in `name` or `original_name`.
  const name = String(call.name ?? call.original_name ?? kind).toUpperCase();
  if (!SUPPORTED_AGGREGATES.includes(name)) {
    return `it uses ${name}, which BigQuery does not allow in a measure (${
        SUPPORTED_AGGREGATES.join(', ')})`;
  }
  // The parser reads an aggregate over several operands, such as
  // `MIN(a, b)`, as a function with arguments, and `COUNT(DISTINCT a, b)` as
  // a count of a tuple.
  const star = kind === 'count' && call.star === true && !call.this;
  const operand = unwrapped(call.this);
  const operands = Array.isArray(call.args) ? call.args.length :
      star                                  ? 1 :
      operand?.tuple                        ? operand.tuple.expressions.length :
                                              operand ? 1 : 0;
  if (operands !== 1) {
    return `it calls ${name} with ${operands} operands, where an aggregate ` +
        `in a measure takes one`;
  }
  if (!star && nestsAggregateOrSubquery(operand)) {
    return 'it nests an aggregate, a window or a subquery';
  }
  const known = new Set(['this', 'star', 'distinct', 'name', 'original_name']);
  if (kind === 'function' || kind === 'aggregate_function' ||
      (!star && operand.star) ||
      !Object.entries(call).every(
          ([key, v]) => known.has(key) || v === null || v === undefined ||
              v === false || (Array.isArray(v) && v.length === 0))) {
    return `it calls ${name} with something other than one operand and ` +
        `DISTINCT or ALL`;
  }
  return undefined;
}

// The outermost aggregate calls in the parser's tree `node`, each as its node
// kind and the call, and whether a window or a subquery sits outside them. A
// call of the name of one of SUPPORTED_AGGREGATES that the parser reads as a
// plain function, such as `MIN(a, b)` or `SAFE.SUM(a)`, counts as one.
function aggregateCalls(node: unknown):
    {calls: Array<[string, any]>; windowOrSubquery: boolean} {
  const found = {calls: [] as Array<[string, any]>, windowOrSubquery: false};
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (n === null || typeof n !== 'object') return;
    for (const [kind, value] of Object.entries(n)) {
      if (kind === 'window_function' || kind === 'subquery' ||
          kind === 'select') {
        found.windowOrSubquery = true;
      } else if (
          isAggregateCall(kind, value) ||
          (kind === 'function' &&
           SUPPORTED_AGGREGATES.includes(
               String(value.name).toUpperCase().replace(/^SAFE\./, '')))) {
        found.calls.push([kind, value]);
      } else {
        visit(value);
      }
    }
  };
  visit(node);
  return found;
}

// The index of the `)` that closes the `(` at `open` in `tokens`, or -1.
function closingParen(tokens: SqlToken[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].token_type === 'L_PAREN') depth++;
    if (tokens[i].token_type === 'R_PAREN' && --depth === 0) return i;
  }
  return -1;
}

// `tokens` without the parentheses around all of them.
function unparenthesized(tokens: SqlToken[]): SqlToken[] {
  while (tokens.length >= 2 && tokens[0].token_type === 'L_PAREN') {
    let depth = 0;
    let closesAt = -1;
    for (let i = 0; i < tokens.length && closesAt < 0; i++) {
      if (tokens[i].token_type === 'L_PAREN') depth++;
      if (tokens[i].token_type === 'R_PAREN' && --depth === 0) closesAt = i;
    }
    if (closesAt !== tokens.length - 1) break;
    tokens = tokens.slice(1, -1);
  }
  return tokens;
}

// The parser's tree `node` without the parentheses and comments around it.
function unwrapped(node: any): any {
  while (node?.paren || node?.annotated) {
    node = (node.paren ?? node.annotated).this;
  }
  return node;
}

// Whether `expression`, read in `dialect`, holds a subquery at any depth, such
// as `(SELECT ...)`, `EXISTS (SELECT ...)` or `x IN (SELECT ...)`. False when
// the SQL parser cannot read it.
export function holdsSubquery(expression: string, dialect: string): boolean {
  const holds = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(holds);
    if (node === null || typeof node !== 'object') return false;
    return Object.entries(node).some(
        ([kind, value]) =>
            kind === 'subquery' || kind === 'select' || holds(value));
  };
  return holds(sqlExpressionTree(expression, dialect));
}

// Whether `expression`, read in `dialect`, calls a window function outside
// any subquery, as RANK() OVER (...) and SUM(x) OVER () do. False when the
// SQL parser cannot read it.
export function holdsWindowFunction(
    expression: string, dialect: string): boolean {
  const holds = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(holds);
    if (node === null || typeof node !== 'object') return false;
    return Object.entries(node).some(
        ([kind, value]) => kind === 'window_function' ||
            kind !== 'subquery' && kind !== 'select' && holds(value));
  };
  return holds(sqlExpressionTree(expression, dialect));
}

// Whether the parser's tree `node` holds an aggregate, a window or a subquery
// at any depth.
function nestsAggregateOrSubquery(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(nestsAggregateOrSubquery);
  if (node === null || typeof node !== 'object') return false;
  return Object.entries(node).some(
      ([kind, value]) => isAggregateCall(kind, value) ||
          kind === 'window_function' || kind === 'subquery' ||
          kind === 'select' || nestsAggregateOrSubquery(value));
}

// Whether `value`, of node kind `kind` in the parser's tree, is an aggregate
// call. The parser gives an aggregate call `distinct` and `filter` keys, or
// the kind `aggregate_function`.
function isAggregateCall(kind: string, value: any): boolean {
  return kind === 'aggregate_function' ||
      (value !== null && typeof value === 'object' && 'distinct' in value &&
       'filter' in value);
}

// Whether a key or join column is a physical column name rather than an
// expression. A value that starts and ends with a backtick, with none between,
// passes whatever it holds. An unquoted value may not contain whitespace,
// parentheses, a dot, a comma, a backtick or a SQL operator. Nothing else about
// the character set is checked; the database rejects a bad name.
export function isColumnName(value: unknown): boolean {
  return typeof value === 'string' &&
      (/^`[^`]+`$/.test(value) || /^[^\s().+\-*/%=<>!|&^~,`]+$/.test(value));
}
