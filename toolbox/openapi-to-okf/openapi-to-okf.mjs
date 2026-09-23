// openapi-to-okf, turn any OpenAPI 3.x spec into an Open Knowledge Format (OKF
// v0.1) bundle: a directory of plain Markdown files with YAML frontmatter that
// link to one another. One concept per file. The only required frontmatter
// field is `type`. Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog
//
// This is a GENERIC producer (no TempGuru specifics). It is the artifact behind
// the proposed contribution to Google's OKF repo: a reusable bridge that lets any
// API publisher expose its OpenAPI catalog as agent-readable knowledge. Validated
// against a real production spec (TempGuru's public event-staffing API).
//
// Usage:
//   node openapi-to-okf.mjs <path-to-openapi.json> <output-dir> [--base <api-base-url>]
//
// Output:
//   <output-dir>/index.md            bundle root, declares okf_version (the only
//                                    index.md allowed to carry frontmatter, per spec)
//   <output-dir>/log.md              change log (no frontmatter, per spec)
//   <output-dir>/operations/*.md     one concept per path+method operation
//   <output-dir>/schemas/*.md        one concept per components.schemas entry

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ── args ─────────────────────────────────────────────────────────────────────
const [specPath, outDir, ...rest] = process.argv.slice(2);
if (!specPath || !outDir) {
  console.error("usage: node openapi-to-okf.mjs <openapi.json> <output-dir> [--base <url>]");
  process.exit(1);
}
const baseFlag = rest.indexOf("--base");
const apiBase = baseFlag >= 0 ? rest[baseFlag + 1] : undefined;

const spec = JSON.parse(readFileSync(resolve(specPath), "utf8"));
const out = resolve(outDir);

// ── helpers ────────────────────────────────────────────────────────────────
const OKF_VERSION = "0.1";
// Always double-quote string scalars so colons, commas, URLs never break YAML.
const scalar = (v) =>
  typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v));
const fm = (obj) => {
  const lines = ["---"];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${scalar(item)}`);
    } else lines.push(`${k}: ${scalar(v)}`);
  }
  lines.push("---");
  return lines.join("\n");
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const oneLine = (s) => (s || "").replace(/\s+/g, " ").trim();
// Clean one-sentence summary for frontmatter: strip markdown, stop at first period.
const summarize = (s) => {
  const clean = oneLine(s).replace(/\*\*/g, "").replace(/`/g, "");
  const firstSentence = clean.split(/(?<=\.)\s/)[0];
  return (firstSentence.length > 200 ? firstSentence.slice(0, 197) + "..." : firstSentence) || undefined;
};
// Join a server origin and an OpenAPI path without doubling a shared prefix.
const joinUrl = (origin, path) => {
  if (!origin) return path;
  const o = origin.replace(/\/+$/, "");
  try {
    const oPath = new URL(o).pathname.replace(/\/+$/, "");
    if (oPath && path.startsWith(oPath + "/")) return new URL(o).origin + path;
  } catch { /* origin not a full URL, fall through */ }
  return o + path;
};
let fileCount = 0;
const write = (rel, content) => {
  const full = join(out, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content.endsWith("\n") ? content : content + "\n");
  fileCount += 1;
};
// A $ref like "#/components/schemas/City" -> { name: "City", file: "../schemas/city.md" }
const refTo = (ref, fromDir) => {
  const name = ref.split("/").pop();
  const prefix = fromDir === "operations" ? ".." : ".";
  return { name, link: `[${name}](${prefix}/schemas/${slug(name)}.md)` };
};
const collectRefs = (node, acc = new Set()) => {
  if (!node || typeof node !== "object") return acc;
  if (typeof node.$ref === "string" && node.$ref.includes("/components/schemas/")) acc.add(node.$ref);
  for (const v of Object.values(node)) collectRefs(v, acc);
  return acc;
};

rmSync(out, { recursive: true, force: true });

const info = spec.info || {};
const servers = (spec.servers || []).map((s) => s.url).filter(Boolean);
const base = apiBase || servers[0] || "";

// ── operations ───────────────────────────────────────────────────────────────
const METHODS = ["get", "post", "put", "patch", "delete"];
const operations = [];
for (const [path, item] of Object.entries(spec.paths || {})) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    const id = op.operationId || `${method}-${slug(path)}`;
    operations.push({ id, method: method.toUpperCase(), path, op });
  }
}

for (const { id, method, path, op } of operations) {
  const refs = [...collectRefs(op)].map((r) => refTo(r, "operations"));
  const params = (op.parameters || []).map(
    (p) => `- \`${p.name}\` (${p.in}${p.required ? ", required" : ""})${p.description ? `: ${oneLine(p.description)}` : ""}`,
  );
  const body = [
    `# ${op.summary || id}`,
    "",
    oneLine(op.description) || `\`${method} ${path}\``,
    "",
    `- **Operation:** \`${method} ${joinUrl(base, path)}\``,
    op.tags?.length ? `- **Tags:** ${op.tags.join(", ")}` : "",
    "",
    params.length ? `## Parameters\n\n${params.join("\n")}` : "",
    refs.length ? `\n## Related schemas\n\n${refs.map((r) => `- ${r.link}`).join("\n")}` : "",
    `\n[All operations](index.md) · [bundle root](../index.md)`,
  ]
    .filter(Boolean)
    .join("\n");
  write(
    `operations/${slug(id)}.md`,
    `${fm({
      type: "API Operation",
      title: op.summary || id,
      description: summarize(op.description),
      method,
      path,
      resource: base ? joinUrl(base, path) : undefined,
      operation_id: op.operationId,
      tags: op.tags,
    })}\n${body}\n`,
  );
}

// ── schemas ──────────────────────────────────────────────────────────────────
const schemas = Object.entries(spec.components?.schemas || {});
for (const [name, schema] of schemas) {
  const props = Object.entries(schema.properties || {}).map(([k, v]) => {
    const req = (schema.required || []).includes(k) ? ", required" : "";
    return `- \`${k}\` (${v.type || v.$ref?.split("/").pop() || "any"}${req})${v.description ? `: ${oneLine(v.description)}` : ""}`;
  });
  const body = [
    `# ${name}`,
    "",
    oneLine(schema.description) || `Schema \`${name}\`.`,
    "",
    props.length ? `## Properties\n\n${props.join("\n")}` : "",
    `\n[All schemas](index.md) · [bundle root](../index.md)`,
  ]
    .filter(Boolean)
    .join("\n");
  write(
    `schemas/${slug(name)}.md`,
    `${fm({ type: "Schema", title: name, description: summarize(schema.description) })}\n${body}\n`,
  );
}

// ── directory index files (no frontmatter, per spec §6) ───────────────────────
write(
  "operations/index.md",
  `# Operations\n\n${operations
    .map((o) => `- [${o.op.summary || o.id}](${slug(o.id)}.md), \`${o.method} ${o.path}\``)
    .join("\n")}\n`,
);
if (schemas.length) {
  write(
    "schemas/index.md",
    `# Schemas\n\n${schemas.map(([n]) => `- [${n}](${slug(n)}.md)`).join("\n")}\n`,
  );
}

// ── bundle root (the only index.md allowed frontmatter: okf_version only) ──────
write(
  "index.md",
  `---\nokf_version: ${scalar(OKF_VERSION)}\n---\n\n# ${info.title || "API Knowledge"}\n\n${oneLine(info.description)?.split(". ")[0] || ""}.\n\n${base ? `API base: \`${base}\`. ` : ""}Generated from an OpenAPI ${spec.openapi || "3.x"} spec.\n\n- [Operations](operations/index.md) (${operations.length})\n${schemas.length ? `- [Schemas](schemas/index.md) (${schemas.length})\n` : ""}- [Change log](log.md)\n`,
);

// ── log (no frontmatter, per spec §7) ──────────────────────────────────────────
write(
  "log.md",
  `# Change Log\n\n## ${info.version || "initial"}\n\n- Generated from OpenAPI ${spec.openapi || "3.x"} (\`${info.title || ""}\` v${info.version || "?"}) by openapi-to-okf.\n- ${operations.length} operations, ${schemas.length} schemas.\n`,
);

console.log(`Wrote ${fileCount} OKF files to ${out} (${operations.length} operations, ${schemas.length} schemas).`);
