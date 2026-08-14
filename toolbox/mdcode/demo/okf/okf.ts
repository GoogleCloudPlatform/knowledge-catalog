// Translation between clean OKF frontmatter and the kcmd "pushable" form.
//
// kcmd's generic Documents Layout only maps title/description/tags + body and
// passes a `catalogEntry:` block through verbatim. The OKF signal layer has no
// generic home, so we move it into a custom `okf` Dataplex aspect carried
// through that passthrough. This keeps the library generic: all OKF knowledge
// lives here in the demo.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

export interface Split { meta: any | null; body: string; }

// Where an unmodeled key sits in the frontmatter: record fields are strings,
// list positions are numbers. `['sources', 0, 'license']` is a producer-defined
// subfield on the first source.
type Path = (string | number)[];
type Extra = [Path, any];

// `--bundle <dir>` selects which OKF bundle to operate on, so the demo can run
// against a bundle elsewhere in the repo instead of only its own catalog/.
export function bundleDir(root: string, argv: string[] = process.argv.slice(2)): string {
  const i = argv.indexOf('--bundle');
  if (i === -1) {
    return path.join(root, 'catalog');
  }
  const value = argv[i + 1];
  if (!value) {
    throw new Error('--bundle requires a directory path');
  }
  return path.resolve(root, value);
}

export function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      out.push(...listMarkdown(full));
    } else if (name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out.sort();
}

// Mapped natively by the Documents Layout, so they stay at the top level of the
// staged frontmatter.
const LAYOUT_KEYS = ['title', 'description', 'tags'];

// The OKF v0.2 signal layer, in SPEC order, carried on the `okf` aspect.
// Adding a key the SPEC gains is a one-line change here plus a field in
// okf-aspect.json.
const SIGNAL_KEYS = [
  'generated', 'verified', 'status', 'stale_after', 'usage_window',
  'runtime', 'parameters', 'computation', 'executor', 'attester', 'sources',
];

// `type` and `resource` are carried outside the signal record: `type` as
// `okf_type`, `resource` as the catalog entry's resource name.
const MODELED_KEYS = new Set([...LAYOUT_KEYS, ...SIGNAL_KEYS, 'type', 'resource']);

// Field order within each signal record, and which signal keys hold a list of
// them. Used to give pulled records a deterministic shape.
const RECORD_KEYS: Record<string, string[]> = {
  generated: ['by', 'at'],
  verified: ['by', 'at'],
  usage_window: ['from', 'to'],
  parameters: ['name', 'type', 'required'],
  executor: ['resource', 'receipt'],
  attester: ['resource'],
  sources: ['id', 'resource', 'title', 'author', 'usage_count', 'last_modified'],
};
const LIST_KEYS = new Set(['verified', 'parameters', 'sources']);

export function splitFrontmatter(content: string): Split {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { meta: null, body: content };
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    return { meta: null, body: content };
  }
  const meta = yaml.parse(lines.slice(1, end).join('\n'));
  const body = lines.slice(end + 1).join('\n');
  return { meta, body };
}

function render(meta: any, body: string): string {
  const fm = yaml.stringify(meta).trimEnd();
  return `---\n${fm}\n---\n\n${body.trim()}\n`;
}

function setAtPath(root: any, path: Path, value: any): void {
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    if (node[segment] === undefined) {
      node[segment] = typeof path[i + 1] === 'number' ? [] : {};
    }
    node = node[segment];
  }
  node[path[path.length - 1]] = value;
}

// Keep only present keys, in a stable order, so round-trips are deterministic.
function pick(obj: any, keys: string[]): any {
  const out: any = {};
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) {
      out[k] = obj[k];
    }
  }
  return out;
}

// clean OKF -> pushable (signal moved into catalogEntry / okf aspect)
export function toStaging(content: string, okfKey: string): string {
  const { meta, body } = splitFrontmatter(content);
  if (!meta) {
    return content;
  }

  // OKF permits producer-defined keys at any depth, so an enumerated template
  // can never be complete. Anything unmodeled is diverted here and rides along
  // in `extra` as a [path, value] pair to keep the round-trip lossless.
  const extras: Extra[] = [];
  const divert = (value: any, fields: string[], path: Path): any => {
    const kept: any = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || item === null) {
        continue;
      }
      if (fields.includes(key)) {
        kept[key] = item;
      } else {
        extras.push([[...path, key], item]);
      }
    }
    return pick(kept, fields);
  };

  const signal: any = {};
  if (meta.type !== undefined) {
    signal.okf_type = meta.type;
  }
  for (const [key, value] of Object.entries(pick(meta, SIGNAL_KEYS))) {
    const fields = RECORD_KEYS[key];
    if (!fields) {
      signal[key] = value;
    } else if (LIST_KEYS.has(key)) {
      // SPEC 5.2 allows a lone verifier as a bare mapping; the field is a list.
      const list = Array.isArray(value) ? value : [value];
      signal[key] = list.map((item, i) => divert(item, fields, [key, i]));
    } else {
      signal[key] = divert(value, fields, [key]);
    }
  }

  for (const key of Object.keys(meta)) {
    if (!MODELED_KEYS.has(key)) {
      extras.push([[key], meta[key]]);
    }
  }
  if (extras.length > 0) {
    signal.extra = JSON.stringify(extras);
  }

  const staged = pick(meta, LAYOUT_KEYS);
  staged.catalogEntry = {
    resource: { name: meta.resource },
    aspects: { [okfKey]: signal },
  };
  return render(staged, body);
}

// pushable (as returned by `kcmd pull`) -> clean OKF
export function fromStaging(content: string, okfKey: string): string {
  const { meta, body } = splitFrontmatter(content);
  if (!meta) {
    return content;
  }
  const ce = meta.catalogEntry ?? {};
  const okf = (ce.aspects ?? {})[okfKey] ?? {};

  // Directory index entries carry no OKF signal, so emit body only, matching
  // the frontmatter-free index files in the source bundle.
  const hasSignal = Object.keys(okf).length > 0 || ce.resource?.name !== undefined;
  if (!hasSignal) {
    return `${body.trim()}\n`;
  }

  const clean: any = {};
  if (okf.okf_type !== undefined) clean.type = okf.okf_type;
  if (ce.resource?.name !== undefined) clean.resource = ce.resource.name;
  Object.assign(clean, pick(meta, LAYOUT_KEYS));
  for (const [key, value] of Object.entries(pick(okf, SIGNAL_KEYS))) {
    const fields = RECORD_KEYS[key];
    if (!fields) {
      clean[key] = value;
    } else if (LIST_KEYS.has(key)) {
      clean[key] = (value as any[]).map((item) => pick(item, fields));
    } else {
      clean[key] = pick(value, fields);
    }
  }
  // Last, so the records the nested paths point into already exist. A diverted
  // subfield returns at the end of its record rather than its original
  // position, which pull already normalizes anyway.
  if (okf.extra !== undefined) {
    for (const [path, value] of JSON.parse(okf.extra) as Extra[]) {
      setAtPath(clean, path, value);
    }
  }
  return render(clean, body);
}
