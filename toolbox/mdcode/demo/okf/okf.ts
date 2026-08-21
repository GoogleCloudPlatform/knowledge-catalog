// Translation between clean OKF frontmatter and the kcmd "pushable" form.
//
// kcmd's generic Documents Layout only maps title/description/tags + body and
// passes a `catalogEntry:` block through verbatim. The OKF signal layer has no
// generic home, so we move it into a custom `okf` Dataplex aspect carried
// through that passthrough. This keeps the library generic: all OKF knowledge
// lives here in the demo.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs as nodeParseArgs } from 'node:util';
import * as yaml from 'yaml';

export const DEFAULT_ENTRY_GROUP = 'okf_demo';

// Relative to the repo root. The demo runs from toolbox/mdcode/demo/okf, so the
// root is four levels up.
export const DEFAULT_BUNDLE = 'okf/bundles/acme_retail';
const REPO_ROOT_FROM_DEMO = '../../../..';

// Parse argv against an exact set of accepted flags. Handles both
// `--flag value` and `--flag=value`. An unknown flag, a missing value, or a
// bare positional stops the run rather than being ignored, so a mistyped flag
// can never be dropped in silence.
function parseFlags(argv: string[], accepted: string[]): Record<string, string | undefined> {
  const options: Record<string, { type: 'string' }> = {};
  for (const name of accepted) {
    options[name] = { type: 'string' };
  }
  try {
    const parsed = nodeParseArgs({ args: argv, options, strict: true, allowPositionals: false });
    return parsed.values as Record<string, string | undefined>;
  } catch (e) {
    throw new Error(`Invalid arguments: ${(e as Error).message}`);
  }
}

/**
 * Parse setup.ts's argv into { entryGroup }. `--entry-group` names the entry
 * group to create; setup.ts is the only script that takes it, because every
 * other script reads the entry group back out of the manifest it writes.
 * Validates the name against Dataplex's own naming rule.
 */
export function parseDemoArgs(argv: string[] = process.argv.slice(2)): { entryGroup: string } {
  const values = parseFlags(argv, ['entry-group']);
  const entryGroup = values['entry-group'] ?? DEFAULT_ENTRY_GROUP;
  if (!/^[a-z][a-z0-9_-]{0,61}[a-z0-9]$/.test(entryGroup)) {
    throw new Error(`Invalid entry-group name: '${entryGroup}'. Must match /^[a-z][a-z0-9_-]{0,61}[a-z0-9]$/`);
  }
  return { entryGroup };
}

/** Stop if argv carries any flag at all. For the scripts that take none. */
export function rejectArgs(argv: string[] = process.argv.slice(2)): void {
  parseFlags(argv, []);
}

// The manifest setup.ts writes. Every later script addresses the entry group it
// names, so without it there is nothing to act on.
function manifestPath(root: string): string {
  const file = path.join(root, 'catalog.yaml');
  if (!fs.existsSync(file)) {
    throw new Error('catalog.yaml not found; run setup.ts first.');
  }
  return file;
}

/** Stop unless setup.ts has written a manifest for this demo to act on. */
export function requireManifest(root: string): void {
  manifestPath(root);
}

// cleanup deletes an entry group outright, so the name comes from the manifest
// that setup.ts wrote rather than from a flag a caller could mistype.
export function manifestEntryGroup(root: string): string {
  const file = manifestPath(root);
  const scope = yaml.parse(fs.readFileSync(file, 'utf8'))?.scope;
  const entryGroup = String(scope ?? '').split('.').pop() ?? '';
  if (!entryGroup) {
    throw new Error(`catalog.yaml has no usable scope to read an entry group from: ${JSON.stringify(scope)}`);
  }
  return entryGroup;
}

export interface Split { meta: any | null; body: string; }

// Where an unmodeled key sits in the frontmatter: record fields are strings,
// list positions are numbers. `['sources', 0, 'license']` is a producer-defined
// subfield on the first source.
type Path = (string | number)[];
type Extra = [Path, any];

// `--bundle <dir>` selects which OKF bundle push and pull operate on, so the
// demo can run against a bundle elsewhere in the repo. Without it they operate
// on the in-repo Acme Retail bundle, which exercises the full v0.2 signal
// layer. It is the only flag these two scripts take: the entry group comes from
// the manifest, not from the command line.
export function bundleDir(root: string, argv: string[] = process.argv.slice(2)): string {
  const value = parseFlags(argv, ['bundle'])['bundle'];
  if (value === undefined) {
    return path.resolve(root, REPO_ROOT_FROM_DEMO, DEFAULT_BUNDLE);
  }
  return path.resolve(root, value);
}

// Pull writes files, so it defaults to a gitignored scratch directory instead of
// the bundle push reads. Defaulting both to the same place would let a stray
// `bun pull.ts` overwrite the canonical Acme Retail source in the repo.
export const DEFAULT_PULL_TARGET = 'pulled';

export function pullTargetDir(root: string, argv: string[] = process.argv.slice(2)): string {
  const value = parseFlags(argv, ['bundle'])['bundle'];
  if (value === undefined) {
    return path.join(root, DEFAULT_PULL_TARGET);
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
export function toStaging(content: string, okfKey: string, entryTypeKey: string): string {
  const { meta, body } = splitFrontmatter(content);
  if (!meta) {
    // SPEC 8 index files carry no frontmatter, so stage the entry type on its
    // own. Without it the layout falls back to the built-in generic type and
    // the bundle's navigation nodes end up a different kind of thing from the
    // concepts they link to. Pull drops it again: there is no signal to restore.
    return render({ type: entryTypeKey }, body);
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

  // The OKF `type` is freeform prose and never a Dataplex type ref, so the
  // layout would fall back to generic. It rides on the aspect as `okf_type`
  // instead, leaving `type` here to name the Dataplex entry type.
  const staged: any = { type: entryTypeKey, ...pick(meta, LAYOUT_KEYS) };
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
