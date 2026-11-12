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

// The message of `err`, a YAML error in `text`. YAML reads an unquoted `*`
// as an alias, so a value such as `metrics_exclude: *` does not parse, and
// the message then shows its line with the `*` quoted, when that line parses.
export function yamlErrorMessage(err: any, text: string): string {
  const message = String(err?.message ?? err);
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
