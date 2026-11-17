import * as yaml from 'yaml';

// How kcmd parses a model or profile document. `resolveKnownTags: false` keeps
// YAML-only tags (`!!timestamp`, `!!binary`) as the text written instead of
// turning them into Date or Uint8Array, and reads `!!set` as a mapping with
// null values, so custom `ai_context` members with no JSON counterpart stay
// text. `logLevel: 'error'` keeps unresolved-tag warnings off stderr. The
// loader, the profile reader and the layout all parse with these, so a value
// means the same thing to each.
export const YAML_OPTIONS = {resolveKnownTags: false, logLevel: 'error'} as const;

// Parses `text` with YAML_OPTIONS and keeps what parses when the text has a
// YAML error, such as a bad indent. A key set twice is not an error here, and
// its last value is kept. An alias whose anchor is not set reads as null. A
// reader that only looks values up uses this, so a model file the load
// rejects still gives them. The load reports the error.
export function parseLeniently(text: string): yaml.Document.Parsed {
  const doc = yaml.parseDocument(text, {...YAML_OPTIONS, uniqueKeys: false});
  yaml.visit(doc, {
    Alias: (_, alias) => alias.resolve(doc) ? undefined : doc.createNode(null),
  });
  return doc;
}

// The value of the model or profile document `doc`, parsed from `text`, as
// yaml.parse reads it. `doc` defaults to `text` parsed with YAML_OPTIONS.
// Throws the document's first YAML error. Also throws for an alias inside the
// value its anchor names, such as `*a` in `data: &a {self: *a}`. That error
// gives the alias's line and column in `text`.
export function documentValue(
    text: string,
    doc: yaml.Document = yaml.parseDocument(text, YAML_OPTIONS)): unknown {
  if (doc.errors.length > 0) throw doc.errors[0];
  // The walk goes in document order. `anchors` holds the node each anchor
  // names at its current point, and `open` holds the nodes it is inside.
  const anchors = new Map<string, unknown>();
  const open = new Set<unknown>();
  // The first alias under `node` inside the value its anchor names.
  const loop = (node: unknown): yaml.Alias|undefined => {
    if (yaml.isAlias(node)) {
      return open.has(anchors.get(node.source)) ? node : undefined;
    }
    if (yaml.isNode(node) && node.anchor) anchors.set(node.anchor, node);
    open.add(node);
    const items = yaml.isPair(node) ? [node.key, node.value] :
        yaml.isCollection(node)     ? node.items :
                                      [];
    for (const item of items) {
      const found = loop(item);
      if (found) return found;
    }
    open.delete(node);
    return undefined;
  };
  const alias = loop(doc.contents);
  if (alias) {
    const at = alias.range![0];
    const line = text.slice(0, at).split('\n').length;
    throw new Error(
        `Alias '*${alias.source}' at line ${line}, column ` +
        `${at - text.lastIndexOf('\n', at - 1)} refers to a value that ` +
        `contains it; JSON cannot hold such a value.`);
  }
  return doc.toJS();
}

// The message of `err`, a YAML error in `text`. YAML reports a quote, `[` or
// `{` left open where it stops reading it, so the message gives the line and
// column where the innermost one opens instead. `above` is the text of the
// file before `text`, such as the `---` line above an overview sidecar's
// frontmatter, and the line, column and snippet are those in the file. YAML
// reads an unquoted `*` as an alias, so a value such as `metrics_exclude: *`
// does not parse, and the message then shows its line with the `*` quoted,
// when that line parses.
export function yamlErrorMessage(err: any, text: string, above = ''): string {
  const message =
      placedMessage(err, text, above) ?? String(err?.message ?? err);
  // The hint reads the line in the file, as the position does.
  const file = above + text;
  const pos = err?.pos?.[0];
  const at = typeof pos === 'number' ? above.length + pos : -1;
  if (err?.code !== 'BAD_ALIAS' || file[at] !== '*' ||
      !/^Alias cannot be an empty string/.test(message)) {
    return message;
  }
  const start = file.lastIndexOf('\n', at - 1) + 1;
  const end = file.indexOf('\n', at);
  const line = file.slice(start, end < 0 ? undefined : end).replace(/\r$/, '');
  const quoted = `${line.slice(0, at - start)}"*"${line.slice(at - start + 1)}`;
  try {
    yaml.parse(quoted.trim(), YAML_OPTIONS);
  } catch {
    return message;
  }
  return `${message.replace(/\n*$/, '\n')}YAML reads an unquoted '*' as an ` +
      `alias; write it in quotes, as in ${quoted.trim()}.`;
}

// `err` is a YAML error in `text`. placedMessage returns its message in YAML's
// words with a new position text. The position text gives the line, column
// and snippet in `above` followed by `text`. The error may report a quote, `]`
// or `}` missing from a key or a value. openStart then finds where that key or
// value starts. The position text points there instead of where YAML stops
// reading. The position text keeps YAML's position for any other error, and
// when openStart finds no token. placedMessage returns undefined when the
// position text keeps YAML's position and `above` is empty. It also returns
// undefined when `err` has no position or a position below 0, or when the
// message of `err` does not end in the position text YAML adds.
function placedMessage(
    err: any, text: string, above: string): string|undefined {
  const pos: unknown = err?.pos;
  if (!Array.isArray(pos) || !(pos[0] >= 0)) return undefined;
  // The lines YAML counts as it parses, which its positions use.
  const lines = new yaml.LineCounter();
  const tokens = [...new yaml.Parser(lines.addNewLine).parse(text)];
  const close = missingClose(err);
  const start = close === undefined ?
      undefined :
      openStart(tokens, text, close, pos[0]);
  if (start === undefined && !above) return undefined;
  const added = positionText(text, lines, pos);
  const message = String(err.message);
  if (!message.endsWith(added)) return undefined;
  // The lines of `above`, then the lines YAML counts in `text`.
  const fileLines = new yaml.LineCounter();
  fileLines.addNewLine(0);
  for (let i = above.indexOf('\n'); i >= 0; i = above.indexOf('\n', i + 1)) {
    fileLines.addNewLine(i + 1);
  }
  for (const s of lines.lineStarts.slice(1)) {
    fileLines.addNewLine(above.length + s);
  }
  const range = start === undefined ? pos : [start, start + 1];
  return message.slice(0, -added.length) +
      positionText(above + text, fileLines, range.map(p => p + above.length));
}

// The closing character YAML's error `err` reports missing: the quote of
// "Missing closing quote", or the `]` or `}` a flow sequence or flow map
// "must end with". Undefined for any other error. These errors have the code
// MISSING_CHAR or BAD_INDENT, which other errors share, so the message tells
// them apart.
function missingClose(err: any): string|undefined {
  if (err?.code !== 'MISSING_CHAR' && err?.code !== 'BAD_INDENT') {
    return undefined;
  }
  const message = String(err.message);
  return /^Missing closing (["'])quote/.exec(message)?.[1] ??
      /^Flow (?:map|sequence) (?:in block collection must be sufficiently indented and )?(?:must )?end with a ([\]}])/
          .exec(message)?.[1];
}

// The start offset of the token that YAML's error at `at` reports as missing
// `close`. `tokens` is the CST of `text`. That token is the innermost
// candidate. A candidate is a key or value token that closes with `close` and
// ends at `at`. A double-quoted or single-quoted key or value closes with its
// quote. Such a key or value is a candidate whether or not its closing quote
// is there. A flow collection closes with the `]` or `}` that matches its `[`
// or `{`. It is a candidate only when the first token of its CST's `end` list
// is not that bracket. That list also holds the spaces, comment and line break
// after the bracket. A token ends at `at` when `at` follows its last character
// other than a space, tab or line break, with only such characters in between.
// The innermost candidate is the one that starts last. openStart returns
// undefined when no token is a candidate.
function openStart(
    tokens: yaml.CST.Token[], text: string, close: string,
    at: number): number|undefined {
  const blank = (i: number) => ' \t\r\n'.includes(text[i] ?? 'x');
  let start: number|undefined;
  for (const token of tokens) {
    if (token.type !== 'document') continue;
    yaml.CST.visit(token, ({key, value}) => {
      for (const t of [key, value]) {
        if (!t || closer(t) !== close) continue;
        if (t.type === 'flow-collection' && t.end[0]?.source === close) {
          continue;
        }
        let last = t.offset + yaml.CST.stringify(t).length;
        let after = last;
        while (last > t.offset + 1 && blank(last - 1)) last--;
        while (blank(after)) after++;
        if (last <= at && at <= after) start = Math.max(start ?? 0, t.offset);
      }
    });
  }
  return start;
}

// The character that closes `token`: the quote of a quoted value, or the `]`
// or `}` of a flow collection. Undefined for any other kind.
function closer(token: yaml.CST.Token): string|undefined {
  if (token.type === 'flow-collection') {
    return token.start.source === '{' ? '}' : ']';
  }
  return token.type === 'double-quoted-scalar' ? '"' :
      token.type === 'single-quoted-scalar'    ? "'" :
                                                 undefined;
}

// Where `range` is in `text`, whose lines are `lines`, in the yaml package's
// own error snippet layout.
function positionText(
    text: string, lines: yaml.LineCounter, [from, to]: number[]): string {
  const {line, col} = lines.linePos(from);
  const end = lines.linePos(to);
  const starts = lines.lineStarts;
  let at = col - 1;
  let shown =
      text.slice(starts[line - 1], starts[line]).replace(/[\n\r]+$/, '');
  if (at >= 60 && shown.length > 80) {
    const cut = Math.min(at - 39, shown.length - 79);
    shown = `…${shown.slice(cut)}`;
    at -= cut - 1;
  }
  if (shown.length > 80) shown = `${shown.slice(0, 79)}…`;
  if (line > 1 && /^ *$/.test(shown.slice(0, at))) {
    const above = text.slice(starts[line - 2], starts[line - 1]);
    shown = (above.length > 80 ? `${above.slice(0, 79)}…\n` : above) + shown;
  }
  const where = ` at line ${line}, column ${col}`;
  if (!/[^ ]/.test(shown)) return where;
  const carets = end.line === line && end.col > col ?
      Math.max(1, Math.min(end.col - col, 80 - at)) :
      1;
  return `${where}:\n\n${shown}\n${' '.repeat(at)}${'^'.repeat(carets)}\n`;
}
