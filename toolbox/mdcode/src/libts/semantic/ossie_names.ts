// Reads the names in an OSSIE_SQL_2026 text of an Apache Ossie file by
// Ossie's rules, so import can write each of them in kcmd's naming.
//
// What a name refers to depends on where the text sits:
// - In a field expression, every name is a column of the source of the
//   field's dataset. The name may be qualified with the field's own dataset.
//   A qualifier that names another dataset is invalid.
// - In a metric with an anchor, a bare name is a field of the anchor.
//   `source.x` is column x of the anchor's source, unless the anchor has a
//   field named `source`. `d.f` is field f of dataset d.
// - In a metric without an anchor, `d.f` is field f of dataset d. A bare name
//   refers to nothing.
// A written name matches a declared name as ossieMatches says.

import {bindingSubqueries, columnKey, columnReferences, NameInText, quotesName, sameColumns, subqueryTables, unusedName, WrittenName} from './sql_expr_utils';
import {OSSIE_RESERVED} from './sql_identifiers';
import {soleColumn, SqlColumn, sqlDateParts, sqlExpressionTree, SqlToken, sqlTokens} from './sql_parser';

const OSSIE_SQL = 'OSSIE_SQL_2026';

// A source column as one text of a field names it: without quotes, whether
// quotes wrap it, and the dialect of the text.
export interface FieldColumn {
  name: string;
  quoted: boolean;
  dialect: string;
}

// A dataset of the model a text sits in: its name, and each field's name
// with the one source column the field reads, if it reads exactly one, as
// each of the field's texts names it (see fieldSoleColumn).
export interface OssieDataset {
  name: string;
  fields: Array<{name: string; column?: readonly FieldColumn[]}>;
}

// Where a text sits. `dataset` is a field's dataset, or a metric's anchor,
// and is unset for a metric without an anchor. `datasets` are the model's.
export interface OssieContext {
  kind: 'field'|'metric';
  dataset?: string;
  datasets: readonly OssieDataset[];
}

// A name a text reads. `start` and `end` are code-unit offsets into the text,
// end exclusive, from the qualifier, when there is one, to the name, and
// `written` is the text between them. A column of a dataset's source gives
// the column's name without quotes, and whether quotes wrap it. A field
// gives the dataset and field names as declared. An unresolved name refers
// to nothing the model declares: a name no dataset or field matches, a bare
// name in a metric without an anchor, a qualifier that names a table of a
// subquery's own FROM, or a struct path, such as `address.city`, whose first
// part names no dataset.
export type OssieReference = {
  start: number; end: number; written: string
}&({
  kind: 'column';
  dataset: string;
  column: string;
  quoted: boolean
}|{
  kind: 'field';
  dataset: string;
  field: string
}|{kind: 'unresolved'});

// What a text reads: every name, in the order written, and each qualified
// name, as written, whose qualifier names another dataset in a field
// expression. Such a name is unresolved.
export interface OssieReading {
  references: OssieReference[];
  otherDataset: string[];
}

// Whether `written`, a name as a text writes it, matches `declared`, a name
// the model declares. Ossie writes an unquoted name in upper case before it
// compares it. So an unquoted name matches in any letter case. A quoted name
// matches the name it spells, or a plain identifier ([A-Za-z_][A-Za-z0-9_$]*)
// whose upper case it spells, as "AMOUNT" matches `amount`.
export function ossieMatches(
    written: {name: string; quoted: boolean}, declared: string): boolean {
  if (!written.quoted) {
    return written.name.toUpperCase() === declared.toUpperCase();
  }
  return written.name === declared ||
      (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(declared) &&
       declared.toUpperCase() === written.name);
}

// The name of `declared` that `written` matches: the one it spells, or else
// the first one ossieMatches gives.
function declaredMatch(
    written: WrittenName, declared: readonly string[]): string|undefined {
  return declared.find(n => n === written.name) ??
      declared.find(n => ossieMatches(written, n));
}

// The names `text` reads, by Ossie's rules for a text that sits as `ctx`
// says, in the order written. Undefined when the text does not parse.
export function readOssieText(text: string, ctx: OssieContext): OssieReading|
    undefined {
  const names = namesRead(text, ctx.datasets);
  if (!names) return undefined;
  const otherDataset: string[] = [];
  const references = names.map((n): OssieReference => {
    const written = text.slice(n.start, n.end);
    const at = {start: n.start, end: n.end, written};
    const target = n.bound ? undefined : resolved(n, ctx);
    if (target?.kind === 'other') otherDataset.push(written);
    return {
      ...at,
      ...(target && target.kind !== 'other' ? target : {kind: 'unresolved'})
    };
  });
  return {references, otherDataset};
}

// A column as columnsRewritten gives it to the function that rewrites it, and
// whether its qualifier names the source of a metric's anchor.
type RewrittenColumn = {
  qualifier?: WrittenName; name: WrittenName; inSubquery: boolean;
  bound: boolean; at: NameInText; source: boolean;
};

// `text`, an OSSIE_SQL_2026 text that sits as `ctx` says, with each name it
// reads replaced by the text `rewrite` gives for it, or kept as written when
// that is undefined, as columnsRewritten does for a text of another
// dialect. The names are the columns and fields Ossie's rules read (see
// readOssieText), and in a field expression each name whose qualifier names
// another dataset. A name a subquery's FROM may bind is read as if it did
// not. `rewrite` learns each as columnsRewritten gives a column: its
// qualifier, when there is one, and its name, as written, whether it sits
// in a subquery with its own FROM (see bindingSubqueries), whether that
// FROM may name the qualifier's table (see subqueryTables), and where it
// stands in the text as the parser reads it (see namesRead). A qualifier
// that names a dataset and a name that names a field each give the name as
// declared, as `orders` for `"ORDERS"`, and the qualifier of a column of a
// metric's anchor gives `source`, with `source` set. Undefined when the text
// does not parse.
export function ossieNamesRewritten(
    text: string, ctx: OssieContext,
    rewrite: (column: RewrittenColumn) => string | undefined): string|
    undefined {
  const names = namesRead(text, ctx.datasets);
  if (!names) return undefined;
  const word = (c: string|undefined) => !!c && /[\p{L}\p{N}_$]/u.test(c);
  let [out, end] = ['', 0];
  for (const n of names) {
    const target = resolved(n, ctx);
    if (!target) continue;
    const declared = (part: WrittenName, name: string) => ({...part, name});
    const source = target.kind === 'column' && ctx.kind === 'metric';
    const qualifier = n.qualifier &&
        declared(n.qualifier, source ? 'source' : target.dataset);
    const name =
        target.kind === 'field' ? declared(n.name, target.field) : n.name;
    const replacement = rewrite({
      ...(qualifier ? {qualifier} : {}),
      name,
      inSubquery: n.inSubquery,
      bound: !!n.bound,
      at: n.at,
      source,
    });
    if (replacement === undefined) continue;
    const before = word(text[n.start - 1]) && word(replacement[0]) ? ' ' : '';
    const after = word(text[n.end]) && word(replacement.at(-1)) ? ' ' : '';
    out += text.slice(end, n.start) + before + replacement + after;
    end = n.end;
  }
  return out + text.slice(end);
}

// What name `n` refers to in a text that sits as `ctx` says: a column, a
// field, another dataset, which a qualifier in a field expression names, or
// undefined when it refers to nothing the model declares.
function resolved(n: NameRead, ctx: OssieContext):
    {kind: 'column'; dataset: string; column: string; quoted: boolean}|{
  kind: 'field';
  dataset: string;
  field: string
}
|{kind: 'other'; dataset: string}|undefined {
  const column = (dataset: string) => ({
    kind: 'column' as const,
    dataset,
    column: n.name.name,
    quoted: n.name.quoted,
  });
  const field = (dataset: OssieDataset|undefined) => {
    const name =
        dataset && declaredMatch(n.name, dataset.fields.map(f => f.name));
    return name === undefined ?
        undefined :
        {kind: 'field' as const, dataset: dataset!.name, field: name};
  };
  const own = ctx.datasets.find(d => d.name === ctx.dataset);
  const q = n.qualifier;
  if (ctx.kind === 'field') {
    if (ctx.dataset === undefined) return undefined;
    if (!q || ossieMatches(q, ctx.dataset)) return column(ctx.dataset);
    const other = declaredMatch(q, ctx.datasets.map(d => d.name));
    return other === undefined ? undefined : {kind: 'other', dataset: other};
  }
  if (!q) return field(own);
  if (ctx.dataset !== undefined && ossieMatches(q, 'source') &&
      !own?.fields.some(f => ossieMatches(q, f.name))) {
    return column(ctx.dataset);
  }
  const dataset = declaredMatch(q, ctx.datasets.map(d => d.name));
  return field(ctx.datasets.find(d => d.name === dataset));
}

// The source column that `text`, an expression of a field of `dataset`, is
// when it reads that one column and nothing else. The column may sit in
// parentheses and may be qualified with the field's own dataset, as in
// `amount`, `orders.amount` or `("AMOUNT")`. Gives the name without quotes
// and whether quotes wrap it. Undefined for any other text, or one that does
// not parse.
export function ossieSoleColumn(
    text: string, dataset: string, datasets: readonly OssieDataset[]):
    {name: string; quoted: boolean}|undefined {
  const reading = readOssieText(text, {kind: 'field', dataset, datasets});
  const [ref, ...more] = reading?.references ?? [];
  if (ref?.kind !== 'column' || more.length) return undefined;
  // The text with the reference read as a placeholder is that placeholder
  // alone when nothing but parentheses surrounds it.
  const stem = unusedName(text, 'kcmd_column_');
  const rest = soleColumn(
      `${text.slice(0, ref.start)} ${stem} ${text.slice(ref.end)}`, OSSIE_SQL);
  return rest?.qualifier === undefined && rest?.name.toLowerCase() === stem ?
      {name: ref.column, quoted: ref.quoted} :
      undefined;
}

// Why `text`, the OSSIE_SQL_2026 text of a field of `dataset`, holds no SQL
// when it is only a qualifier that names `dataset` by Ossie's rules (see
// ossieMatches): "is only the qualifier '<qualifier>'", with the qualifier
// and its dot as written. Undefined otherwise.
export function ossieOnlyQualifier(
    text: string, dataset: string): string|undefined {
  const tokens = sqlTokens(text, OSSIE_SQL);
  if (tokens?.length !== 2 || tokens[1].token_type !== 'DOT') return undefined;
  const chars = Array.from(text);
  const [name] = tokens;
  const written = chars.slice(name.span.start, name.span.end).join('');
  const quoted = name.token_type === 'QUOTED_IDENTIFIER';
  // A string or a number is not a name.
  const isName = quoted || written.toLowerCase() === name.text.toLowerCase();
  if (!isName ||
      !ossieMatches({name: quoted ? name.text : written, quoted}, dataset)) {
    return undefined;
  }
  return `is only the qualifier '${
      chars.slice(name.span.start, tokens[1].span.end).join('')}'`;
}

// The datasets of a document as the Ossie reader takes them, from
// `datasets`, each a dataset as the document writes it: its name, and the
// names of the fields it declares, inherits through `extends`, or that
// `extra` lists for it.
export function documentDatasets(
    datasets: ReadonlyArray<Record<string, any>>,
    extra?: ReadonlyMap<string, readonly string[]>): OssieDataset[] {
  const byName = new Map(datasets.map(ds => [String(ds.name), ds]));
  const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
  return datasets.map(ds => {
    const name = String(ds.name);
    const fields: string[] = [];
    const seen = new Set<unknown>();
    const visit = (d: Record<string, any>|undefined) => {
      if (!d || seen.has(d)) return;
      seen.add(d);
      for (const f of list(d.fields)) {
        const field = (f as Record<string, unknown>|null)?.name;
        if (typeof field === 'string') fields.push(field);
      }
      for (const parent of list(d.extends)) {
        if (typeof parent === 'string') visit(byName.get(parent));
      }
    };
    visit(ds);
    return {
      name,
      fields: [...new Set([...fields, ...extra?.get(name) ?? []])].map(
          f => ({name: f})),
    };
  });
}

// The one source column a field of `dataset` reads, as each of `texts`, the
// field's texts in the dialects kcmd runs, names it, in the order of the
// texts. An OSSIE_SQL_2026 text is read as ossieSoleColumn reads it. A text
// in another dialect is read as that dialect reads it: one column without a
// qualifier, perhaps in parentheses, or one name in quotes, which the parser
// may read as a function, as it reads "current_date". Every two texts must
// name the same column, as sameColumns compares them. An ANSI_SQL text is
// read and compared as a text of `tableDialect`, the dialect of the
// dataset's table, when it is given. Undefined when the field has no text, a
// text is not one column, or two texts name different columns.
export function fieldSoleColumn(
    texts: ReadonlyArray<{dialect: string; expression: string}>,
    dataset: string, datasets: readonly OssieDataset[],
    tableDialect?: string): FieldColumn[]|undefined {
  const columns: Array<FieldColumn|undefined> = texts.map(t => {
    const dialect = t.dialect.toUpperCase();
    const column = dialect === OSSIE_SQL ?
        ossieSoleColumn(t.expression, dataset, datasets) :
        unqualifiedColumn(t.expression, dialect, tableDialect);
    return column && {...column, dialect};
  });
  const read = columns.filter((c): c is FieldColumn => c !== undefined);
  if (!read.length || read.length < columns.length ||
      !sameColumns(read.map(c => columnKey(c, c.dialect, tableDialect)))) {
    return undefined;
  }
  return read;
}

// The field of `dataset` whose one source column is `column`, or undefined.
// This is the field a metric's `source.x` reads. Each text of the field must
// name `column`, as sameColumns compares the two. `column` is named in a text
// of `dialect`, OSSIE_SQL_2026 by default. An ANSI_SQL text, the metric's or
// a field's, is compared as a text of `tableDialect`, the dialect of the
// dataset's table, when it is given.
export function columnField(
    column: {name: string; quoted: boolean}, dataset: OssieDataset,
    dialect = OSSIE_SQL, tableDialect?: string): string|undefined {
  const key = (c: {name: string; quoted: boolean}, d: string) =>
      columnKey(c, d, tableDialect);
  return dataset.fields
      .find(
          f => f.column &&
              sameColumns([
                key(column, dialect),
                ...f.column.map(c => key(c, c.dialect)),
              ]))
      ?.name;
}

// The dialects whose database reads a quoted name that holds a dot as a
// path of names, as BigQuery reads `orders.addr.city` in backticks.
const PATH_QUOTE_DIALECTS = new Set(['BIGQUERY', 'SPANNER']);

// The column `text`, in `dialect`, is when it is one column without a
// qualifier, or one name in quotes, either perhaps in parentheses, with
// whether quotes wrap it. A quoted name is not a column when it is empty,
// when the database that runs the text does not read its quotes as a
// name's, as BigQuery does not read double quotes, or when it reads it as a
// path (see PATH_QUOTE_DIALECTS). An ANSI_SQL text runs as a text of
// `tableDialect`, and on a table of unknown dialect any quotes are a name's.
function unqualifiedColumn(
    text: string, dialect: string, tableDialect?: string):
    {name: string; quoted: boolean}|undefined {
  const column = soleColumn(text, dialect) ?? quotedNameAlone(text, dialect);
  if (!column || column.qualifier !== undefined || !column.name) {
    return undefined;
  }
  if (column.quoted) {
    const quoted =
        sqlTokens(text, dialect)?.find(t => t.token_type === 'QUOTED_IDENTIFIER');
    const reading = dialect === 'ANSI_SQL' && tableDialect ?
        tableDialect.toUpperCase() :
        dialect;
    const quote = quoted && Array.from(text)[quoted.span.start];
    if (!quoted ||
        reading !== 'ANSI_SQL' && !quotesName(quote, dialect, tableDialect) ||
        PATH_QUOTE_DIALECTS.has(reading) && column.name.includes('.')) {
      return undefined;
    }
  }
  return {name: column.name, quoted: column.quoted};
}

// The name `text`, in `dialect`, is when it is one name in quotes, perhaps in
// parentheses, as the tokenizer gives it. The parser reads some such names,
// as "current_date", as a function.
function quotedNameAlone(text: string, dialect: string):
    {qualifier?: string; name: string; quoted: boolean}|undefined {
  const tokens = sqlTokens(text, dialect) ?? [];
  let [first, last] = [0, tokens.length - 1];
  while (first < last && tokens[first].token_type === 'L_PAREN' &&
         tokens[last].token_type === 'R_PAREN') {
    first++;
    last--;
  }
  return first === last && tokens[first]?.token_type === 'QUOTED_IDENTIFIER' ?
      {name: tokens[first].text, quoted: true} :
      undefined;
}

// A name a text reads, as namesRead finds it: where it is written, in code
// units, end exclusive, from its qualifier to its name, and the qualifier
// and the name as written. `inSubquery` is set when the name sits in a
// subquery with its own FROM (see bindingSubqueries), and `bound` when such
// a subquery's FROM names a table or alias that the qualifier may name.
// `at` is where the name stands in the text the parser reads in its place,
// which reads each other name as a placeholder where the parser cannot read
// it (see readable).
interface NameRead {
  start: number;
  end: number;
  qualifier?: WrittenName;
  name: WrittenName;
  inSubquery: boolean;
  bound?: boolean;
  at: NameInText;
}

// The part of a column a name is: its qualifier, its name after a
// qualifier, or its name alone.
type Role = 'qualifier'|'qualified'|'bare';

// The functions Ossie calls without parentheses. Any other word written
// alone without parentheses is a name, though the parser reads some, such as
// `sysdate` or `pi`, as functions.
const OSSIE_BARE_FUNCTIONS =
    new Set(['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP']);

// The functions whose first argument is a date part, as `week` is in
// `DATE_TRUNC(week, d)`.
const DATE_PART_FUNCTIONS =
    new Set(['DATE_PART', 'DATE_TRUNC', 'DATEDIFF', 'DATEADD']);

// The words Ossie's grammar gives a meaning of their own: those it reserves,
// and those that are names except where they have that meaning, such as
// `date` before a string. Any other word is a name in Ossie, though the
// parser reads some, such as `select` and `interval`, as SQL syntax.
const OSSIE_KEYWORDS = new Set([
  ...OSSIE_RESERVED, ...`
  ASC CURRENT DATE DESC FILTER FIRST FOLLOWING GROUP LAST NULLS OVER PARTITION
  POSITION PRECEDING RANGE ROW ROWS TIME TIMESTAMP TIMESTAMP_NTZ UNBOUNDED
  WITHIN`.trim().split(/\s+/),
]);

// Every name `text` reads as part of a column, in the order written, or
// undefined when the text does not parse. `datasets` are the model's.
//
// A word or a quoted name is part of a column when the text with that token
// alone read as a placeholder reads the same columns, with the placeholder
// in place of the token's name. So a function name, a keyword, a string
// literal and a comment are not.
//
// The parser reads some names as a function called without parentheses, as
// it reads `"current_date"` and `sysdate`, or as a lone identifier. Such a
// word is a name when the only change a placeholder in its place makes is a
// column the parser reads there. Ossie's own such functions
// (OSSIE_BARE_FUNCTIONS) are not names when written without quotes. A date
// part is not a name either: a word notAName gives, and a word written
// without quotes or a qualifier that the parser reads as a date part where
// it stands.
//
// A struct path gives its first two parts, as `orders.address` in
// `orders.address.city`.
function namesRead(
    text: string, datasets: readonly OssieDataset[]): NameRead[]|undefined {
  const tokens = sqlTokens(text, OSSIE_SQL);
  if (!tokens) return undefined;
  const chars = Array.from(text);
  const part = (t: SqlToken) => writtenPart(chars, t);
  const work = readable(chars, tokens, datasets);
  if (!work) return undefined;
  const workChars = Array.from(work.text);
  const stem = unusedName(work.text, 'kcmd_name_');
  let tree: unknown;
  const roles = new Map<number, Role>();
  // A word the work text reads as a placeholder has the part of a column that
  // the placeholder has there.
  const at = (name: string|undefined) =>
      name === undefined ? undefined : work.standsFor.get(name.toLowerCase());
  let unclaimed = false;
  for (const c of work.columns) {
    const [q, n] = [at(c.qualifier), at(c.name)];
    if (q !== undefined) {
      roles.set(q, 'qualifier');
    } else if (n !== undefined) {
      roles.set(n, c.qualifier === undefined ? 'bare' : 'qualified');
    } else {
      unclaimed = true;
    }
  }
  const placeholders = new Set(work.standsFor.values());
  // Any other word is read as a placeholder alone. A word Ossie reserves is
  // read so only when the parser reads a column no placeholder stands for,
  // as it reads `end` in `CASE WHEN end > 0 THEN 1 END`.
  tokens.forEach((t, i) => {
    const word = part(t);
    if (placeholders.has(i) || !isWord(word) ||
        !unclaimed && !word.quoted &&
            OSSIE_RESERVED.has(word.name.toUpperCase()) ||
        tokens[i + 1]?.token_type === 'L_PAREN' || notAName(tokens, i, part)) {
      return;
    }
    const edited = withNames(workChars, work.tokens, [i], () => stem);
    const read = columnReferences(edited, OSSIE_SQL);
    if (!read) return;
    const role = roleOf(
        read, work.columns, stem, writtenPart(workChars, work.tokens[i]).name);
    if (role) {
      roles.set(i, role);
    } else if (
        read.length === work.columns.length + 1 &&
        read.some(
            c => c.qualifier === undefined && c.name.toLowerCase() === stem)) {
      tree ??= sqlExpressionTree(work.text, OSSIE_SQL);
      if (readAsName(tree, sqlExpressionTree(edited, OSSIE_SQL), stem)) {
        roles.set(i, 'bare');
      }
    }
  });
  // A word written without quotes or a qualifier is a date part where the
  // parser reads it as one in its place, as it reads `day` in
  // `TIMESTAMPDIFF(day, a, b)`, though Ossie names no such function.
  for (const [i, role] of roles) {
    const word = part(tokens[i]);
    if (role !== 'bare' || word.quoted) continue;
    const parts = (name: string) =>
        sqlDateParts(withNames(workChars, work.tokens, [i], () => name),
                     OSSIE_SQL)
            ?.filter(p => p.toLowerCase() === word.name.toLowerCase())
            .length ??
        0;
    if (parts(word.written) > parts(stem)) roles.delete(i);
  }
  const bound = subqueryTables(
      workChars, work.tokens, OSSIE_SQL,
      name => {
        const i = work.standsFor.get(name.toLowerCase());
        return i === undefined ? undefined : part(tokens[i]);
      });
  const binding = bindingSubqueries(work.tokens);
  // Each code point's offset in code units.
  const units = [0];
  for (const c of chars) units.push(units[units.length - 1] + c.length);
  const dot = (i: number) => tokens[i]?.token_type === 'DOT';
  const names: NameRead[] = [];
  let after = -1;
  for (const [i, role] of [...roles].sort((a, b) => a[0] - b[0])) {
    const [q, n] = role === 'qualifier'    ? [i, i + 2] :
        role === 'qualified' && dot(i - 1) ? [i - 2, i] :
                                             [undefined, i];
    if (!tokens[n] || (q ?? n) <= after) continue;
    const qualifier = q === undefined ? undefined : part(tokens[q]);
    names.push({
      start: units[tokens[q ?? n].span.start],
      end: units[tokens[n].span.end],
      ...(qualifier ? {qualifier} : {}),
      name: part(tokens[n]),
      inSubquery: binding[n].length > 0,
      ...(qualifier && bound(q!, qualifier) ? {bound: true} : {}),
      at: {
        text: work.text,
        start: work.tokens[q ?? n].span.start,
        end: work.tokens[n].span.end,
      },
    });
    after = n;
  }
  return names;
}

// Token `t` of the text whose characters are `chars`, as written, with its
// name: what is inside the quotes for a quoted name.
function writtenPart(chars: string[], t: SqlToken): WrittenName {
  const written = chars.slice(t.span.start, t.span.end).join('');
  const quoted = t.token_type === 'QUOTED_IDENTIFIER';
  return {written, name: quoted ? t.text : written, quoted};
}

// Whether `name` is a quoted name or a word that may be one.
function isWord(name: WrittenName): boolean {
  return name.quoted || /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(name.written);
}

// Whether token `i` of `tokens` is a word Ossie reads as something other
// than a name: one of OSSIE_BARE_FUNCTIONS written alone without quotes, or
// a date part, the unquoted word that is the first argument of one of
// DATE_PART_FUNCTIONS or that comes before FROM in EXTRACT.
function notAName(
    tokens: SqlToken[], i: number,
    part: (t: SqlToken) => WrittenName): boolean {
  const type = (k: number) => tokens[k]?.token_type;
  const word = part(tokens[i]);
  if (word.quoted) return false;
  if (OSSIE_BARE_FUNCTIONS.has(word.name.toUpperCase())) {
    return type(i - 1) !== 'DOT' && type(i + 1) !== 'DOT';
  }
  const fn =
      tokens[i - 2] && type(i - 3) !== 'DOT' && type(i - 1) === 'L_PAREN' ?
      part(tokens[i - 2]) :
      undefined;
  const name = fn && !fn.quoted ? fn.name.toUpperCase() : '';
  return (DATE_PART_FUNCTIONS.has(name) && type(i + 1) === 'COMMA') ||
      (name === 'EXTRACT' && type(i + 1) === 'FROM');
}

// The text of `tokens`, whose characters are `chars`, as namesRead reads it,
// with its tokens, which pair one for one with `tokens`, the columns it
// reads, and the token each placeholder name in it stands for, by the
// placeholder in lower case. Undefined when none of the forms below parses.
//
// Each form reads some words as placeholder names. The first form replaces
// each reserved word written before or after a dot, as `Date` in
// `Date.year`, since the parser cannot read some there. It also replaces
// each word Ossie reads as a name wherever it stands: a quoted name, and a
// word that is none of Ossie's keywords (see OSSIE_KEYWORDS), though the
// parser reads some, such as `select`, as SQL syntax. A word that names a
// function, before `(`, or a type, after AS, and one notAName gives stay.
// Ossie has no subqueries, so the second form leaves such words in a
// subquery, as SELECT is in one. The third form also replaces each reserved
// word that matches a name `datasets` declare, as `from` in `COUNT(from)`.
// The last form replaces only the words before or after a dot.
function readable(
    chars: string[], tokens: SqlToken[], datasets: readonly OssieDataset[]): {
  text: string; tokens: SqlToken[]; columns: ReadonlyArray<SqlColumn>;
  standsFor: Map<string, number>;
}|undefined {
  const part = (t: SqlToken) => writtenPart(chars, t);
  const type = (i: number) => tokens[i]?.token_type;
  const reserved = (t: SqlToken) =>
      !part(t).quoted && t.token_type !== 'VAR' && isWord(part(t));
  const dotted = tokens.flatMap(
      (t, i) => reserved(t) && (type(i - 1) === 'DOT' || type(i + 1) === 'DOT') ?
          [i] :
          []);
  const syntax = tokens.flatMap(
      (t, i) => !dotted.includes(i) && isWord(part(t)) &&
              (part(t).quoted ||
               !OSSIE_KEYWORDS.has(part(t).name.toUpperCase())) &&
              type(i + 1) !== 'L_PAREN' && type(i - 1) !== 'AS' &&
              !notAName(tokens, i, part) ?
          [i] :
          []);
  const inSubquery = subqueryTokens(tokens);
  const outside = syntax.filter(i => !inSubquery[i]);
  const declared = ['source'];
  for (const d of datasets) {
    declared.push(d.name);
    for (const f of d.fields) {
      declared.push(f.name, ...(f.column ?? []).map(c => c.name));
    }
  }
  const named = tokens.flatMap(
      (t, i) => reserved(t) && !dotted.includes(i) && !outside.includes(i) &&
              declared.some(n => ossieMatches(part(t), n)) ?
          [i] :
          []);
  const stem = unusedName(chars.join(''), 'kcmd_word_');
  const tries = [
    [...dotted, ...syntax], [...dotted, ...outside],
    [...dotted, ...outside, ...named], dotted,
  ].filter((at, k, all) => k === 0 || at.length !== all[k - 1].length);
  for (const at of tries) {
    at.sort((a, b) => a - b);
    const text = withNames(chars, tokens, at, k => stem + k);
    const columns = columnReferences(text, OSSIE_SQL);
    const read = columns && sqlTokens(text, OSSIE_SQL);
    if (columns && read?.length === tokens.length) {
      return {
        text, tokens: read, columns,
        standsFor: new Map(at.map((i, k) => [stem + k, i])),
      };
    }
  }
  return undefined;
}

// Whether each of `tokens` sits in a subquery: a parenthesis that opens with
// SELECT or WITH.
function subqueryTokens(tokens: SqlToken[]): boolean[] {
  const open: boolean[] = [];
  return tokens.map((t, i) => {
    if (t.token_type === 'L_PAREN') {
      const next = tokens[i + 1]?.token_type;
      open.push(next === 'SELECT' || next === 'WITH');
    } else if (t.token_type === 'R_PAREN') {
      open.pop();
    }
    return open.includes(true);
  });
}

// `chars` with each token of `tokens` at `at` replaced by `name(k)`, for the
// k-th. A space keeps a name apart from a word written against the token, as
// `WHEN` is in `WHEN"x"`.
function withNames(
    chars: string[], tokens: SqlToken[], at: number[],
    name: (k: number) => string): string {
  const word = (c: string|undefined) => !!c && /[\p{L}\p{N}_$]/u.test(c);
  let out = '';
  let end = 0;
  at.forEach((i, k) => {
    const {start, end: next} = tokens[i].span;
    out += chars.slice(end, start).join('') +
        (word(chars[start - 1]) ? ' ' : '') + name(k) +
        (word(chars[next]) ? ' ' : '');
    end = next;
  });
  return out + chars.slice(end).join('');
}

// The part of a column placeholder `stem` is in `read`, the columns a text
// reads with one name read as `stem`, when they are `columns`, the columns
// of the text itself, with `stem` in place of `name`. Undefined otherwise.
function roleOf(
    read: ReadonlyArray<SqlColumn>, columns: ReadonlyArray<SqlColumn>,
    stem: string, name: string): Role|undefined {
  const is = (n: string|undefined) => n?.toLowerCase() === stem;
  const hits = read.filter(c => is(c.qualifier) || is(c.name));
  if (hits.length !== 1) return undefined;
  const key = (cs: ReadonlyArray<SqlColumn>) =>
      cs.map(c => `${c.qualifier ?? ''}\0${c.name}`).sort().join('\n');
  const back = read.map(
      c => ({qualifier: is(c.qualifier) ? name : c.qualifier,
             name: is(c.name) ? name : c.name}));
  if (key(back) !== key(columns)) return undefined;
  return is(hits[0].qualifier)        ? 'qualifier' :
      hits[0].qualifier === undefined ? 'bare' :
                                        'qualified';
}

// Whether `before` and `after`, the parser's trees of a text and of that
// text with one word read as placeholder `stem`, differ in one place only,
// where `before` reads a function called without parentheses or a lone
// identifier, and `after` reads the placeholder as a column.
function readAsName(before: unknown, after: unknown, stem: string): boolean {
  const [was, is]: any[] = soleDifference(before, after) ?? [];
  const kind = (node: any) =>
      node && typeof node === 'object' && Object.keys(node).length === 1 ?
      Object.keys(node)[0] :
      undefined;
  const fn = kind(was) === 'function' ? was.function : undefined;
  const column = kind(is) === 'column' ? is.column : undefined;
  return !!column && !column.table &&
      String(column.name?.name).toLowerCase() === stem &&
      (kind(was) === 'identifier' ||
       (fn?.no_parens === true && !fn.args?.length));
}

// The parts of `a` and `b`, two of the parser's trees, at the one place they
// differ: the trees themselves when they differ in their keys or in more
// than one of them, else the parts under the one key that differs.
// Undefined when they are the same.
function soleDifference(a: any, b: any): [unknown, unknown]|undefined {
  const same = (x: unknown, y: unknown) =>
      JSON.stringify(x) === JSON.stringify(y);
  if (same(a, b)) return undefined;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return [a, b];
  const keys = Object.keys(a);
  const differ = keys.filter(k => !same(a[k], b[k]));
  if (keys.length !== Object.keys(b).length || !keys.every(k => k in b) ||
      differ.length !== 1) {
    return [a, b];
  }
  return soleDifference(a[differ[0]], b[differ[0]]);
}
