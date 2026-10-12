// Conformance test for the openapi-to-okf producer: run it against a fixture
// OpenAPI 3.x document and assert the emitted bundle obeys OKF v0.1 — every
// concept has a non-empty `type`, links are plain relative markdown (no
// [[wiki]] syntax), and `okf_version` appears only in the bundle-root index.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const producer = join(here, "..", "openapi-to-okf.mjs");
const fixture = join(here, "fixture-openapi.json");

function walkMd(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

test("produces a conformant OKF v0.1 bundle from an OpenAPI 3.x spec", () => {
  const out = mkdtempSync(join(tmpdir(), "okf-openapi-"));
  execFileSync("node", [producer, fixture, out, "--base", "https://api.example.com"]);

  const files = walkMd(out);
  assert.ok(files.length >= 2, "emits multiple markdown files");

  const root = join(out, "index.md");
  assert.match(readFileSync(root, "utf8"), /okf_version:\s*["']?0\.1/, "root index.md declares okf_version");

  let okfVersionCount = 0;
  for (const f of files) {
    const base = basename(f);
    const body = readFileSync(f, "utf8");
    assert.ok(!body.includes("[["), `${base}: must not use [[wiki]] links`);
    if (/^okf_version:/m.test(body)) okfVersionCount++;

    if (base === "index.md" || base === "log.md") continue; // reserved files
    const fm = body.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${base}: concept must have YAML frontmatter`);
    assert.match(fm[1], /^type:\s*\S/m, `${base}: concept must declare a non-empty type`);
  }
  assert.equal(okfVersionCount, 1, "okf_version appears only once (bundle-root index.md)");
});
