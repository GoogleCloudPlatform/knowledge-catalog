// Translation between clean OKF frontmatter and the kcmd "pushable" form.
//
// kcmd's generic Documents Layout only maps title/description/tags + body and
// passes a `catalogEntry:` block through verbatim. The OKF signal layer
// (type, resource, generated, sources) has no generic home, so we move it into
// a custom `okf` Dataplex aspect carried through that passthrough. This keeps
// the library generic — all OKF knowledge lives here in the demo.

import * as yaml from 'yaml';

export interface Split { meta: any | null; body: string; }

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
  const staged = pick(meta, ['title', 'description', 'tags']);
  staged.catalogEntry = {
    resource: { name: meta.resource },
    aspects: {
      [okfKey]: pick(
        { okf_type: meta.type, generated: meta.generated, sources: meta.sources },
        ['okf_type', 'generated', 'sources'],
      ),
    },
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

  // Directory index entries carry no OKF signal — emit body only, matching the
  // frontmatter-free index files in the source bundle.
  const isOkf = okf.okf_type !== undefined || okf.generated !== undefined
    || okf.sources !== undefined || ce.resource?.name !== undefined;
  if (!isOkf) {
    return `${body.trim()}\n`;
  }

  const clean: any = {};
  if (okf.okf_type !== undefined) clean.type = okf.okf_type;
  if (ce.resource?.name !== undefined) clean.resource = ce.resource.name;
  if (meta.title !== undefined) clean.title = meta.title;
  if (meta.description !== undefined) clean.description = meta.description;
  if (meta.tags !== undefined) clean.tags = meta.tags;
  if (okf.generated !== undefined) clean.generated = pick(okf.generated, ['by', 'at']);
  if (okf.sources !== undefined) {
    clean.sources = (okf.sources as any[]).map((s) => pick(s, ['id', 'resource', 'title']));
  }
  return render(clean, body);
}
