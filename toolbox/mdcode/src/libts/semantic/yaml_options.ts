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
// column where the innermost one opens instead. YAML reads an unquoted `*` as
// an alias, so a value such as `metrics_exclude: *` does not parse, and the
// message then shows its line with the `*` quoted, when that line parses.
export function yamlErrorMessage(err: any, text: string): string {
  const message = openTokenMessage(err, text) ?? String(err?.message ?? err);
  const at = err?.pos?.[0];
  if (err?.code !== 'BAD_ALIAS' || typeof at !== 'number' || text[at] !== '*' ||
      !/^Alias cannot be an empty string/.test(message)) {
    return message;
  }
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const end = text.indexOf('\n', at);
  const line = text.slice(start, end < 0 ? undefined : end).replace(/\r$/, '');
  const quoted = `${line.slice(0, at - start)}"*"${line.slice(at - start + 1)}`;
  try {
    yaml.parse(quoted.trim(), YAML_OPTIONS);
  } catch {
    return message;
  }
  return `${message.replace(/\n*$/, '\n')}YAML reads an unquoted '*' as an ` +
      `alias; write it in quotes, as in ${quoted.trim()}.`;
}

// The message of `err` at the start of the innermost quoted value, flow
// sequence or flow mapping left open that ends where `err` is, or undefined
// when none does.
function openTokenMessage(err: any, text: string): string|undefined {
  const at = err?.pos?.[0];
  if (typeof at !== 'number') return undefined;
  const lines = new yaml.LineCounter();
  let start: number|undefined;
  for (const token of new yaml.Parser(lines.addNewLine).parse(text)) {
    if (token.type !== 'document') continue;
    yaml.CST.visit(token, ({key, value}) => {
      for (const t of [key, value]) {
        if (t && openEnd(t) === at) start = Math.max(start ?? 0, t.offset);
      }
    });
  }
  if (start === undefined) return undefined;
  const bare =
      yaml.parseDocument(text, {...YAML_OPTIONS, prettyErrors: false})
          .errors.find(e => e.code === err.code && e.pos[0] === at);
  return bare && bare.message + positionText(text, lines, start);
}

// The text of a closed quoted value. In double quotes a backslash escapes the
// character after it, and in single quotes `''` is one quote, so neither
// closes the value.
const CLOSED_QUOTE = {
  'double-quoted-scalar': /^"(?:[^"\\]|\\[^])*"$/,
  'single-quoted-scalar': /^'(?:[^']|'')*'$/,
};

// Where YAML reports `token` left open: the end of a quoted value or flow
// collection that lacks its closing character. Undefined for any other token.
function openEnd(token: yaml.CST.Token): number|undefined {
  if (token.type === 'flow-collection') {
    const close = token.start.source === '{' ? '}' : ']';
    return token.end[0]?.source === close ?
        undefined :
        token.offset + yaml.CST.stringify(token).length;
  }
  if (token.type !== 'double-quoted-scalar' &&
      token.type !== 'single-quoted-scalar') {
    return undefined;
  }
  return CLOSED_QUOTE[token.type].test(token.source) ?
      undefined :
      token.offset + token.source.length;
}

// Where `offset` is in `text`, in the yaml package's own error snippet layout.
function positionText(
    text: string, lines: yaml.LineCounter, offset: number): string {
  const {line, col} = lines.linePos(offset);
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
  return ` at line ${line}, column ${col}:\n\n${shown}\n${' '.repeat(at)}^\n`;
}
