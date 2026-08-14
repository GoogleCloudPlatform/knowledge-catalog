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

  const signal: any = {};
  if (meta.type !== undefined) {
    signal.okf_type = meta.type;
  }
  Object.assign(signal, pick(meta, SIGNAL_KEYS));
  // SPEC 5.2 allows a lone verifier as a bare mapping; the aspect field is a list.
  if (signal.verified !== undefined && !Array.isArray(signal.verified)) {
    signal.verified = [signal.verified];
  }

  // OKF permits producer-defined keys, so an enumerated template can never be
  // complete. Anything unmodeled rides along as JSON to keep the round-trip
  // lossless.
  const extra: any = {};
  for (const key of Object.keys(meta)) {
    if (!MODELED_KEYS.has(key)) {
      extra[key] = meta[key];
    }
  }
  if (Object.keys(extra).length > 0) {
    signal.extra = JSON.stringify(extra);
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
  if (okf.extra !== undefined) {
    Object.assign(clean, JSON.parse(okf.extra));
  }
  return render(clean, body);
}
