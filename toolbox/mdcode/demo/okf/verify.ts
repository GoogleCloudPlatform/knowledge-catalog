// Check that the OKF <-> Dataplex translation is lossless, without touching the cloud.
//
// Runs every markdown file in a bundle through toStaging then fromStaging and
// compares the result to the original. YAML key order and flow style are not
// compared, because the translation deliberately re-emits frontmatter in a
// canonical shape; everything else must survive untouched.
//
//   bun verify.ts                                      # this demo's catalog/
//   bun verify.ts --bundle ../../../../okf/bundles/acme_retail

import * as fs from 'node:fs';
import * as path from 'node:path';
import { bundleDir, listMarkdown, splitFrontmatter, toStaging, fromStaging } from './okf';

// The aspect key is used symmetrically by both directions, so its value is
// arbitrary here and no GCP project is needed.
const okfKey = 'local.local.okf';

const root = process.cwd();
const dir = bundleDir(root);

function describe(value: any): string {
  return value === undefined ? '(missing)' : JSON.stringify(value);
}

function diff(before: any, after: any, at: string, out: string[]): void {
  if (before === after) {
    return;
  }
  const bothRecords = before && after
    && typeof before === 'object' && typeof after === 'object'
    && Array.isArray(before) === Array.isArray(after);
  if (!bothRecords) {
    out.push(`${at}: ${describe(before)} -> ${describe(after)}`);
    return;
  }
  if (Array.isArray(before)) {
    if (before.length !== after.length) {
      out.push(`${at}: ${before.length} items -> ${after.length} items`);
      return;
    }
    before.forEach((item, i) => diff(item, after[i], `${at}[${i}]`, out));
    return;
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    diff(before[key], after[key], at ? `${at}.${key}` : key, out);
  }
}

const files = listMarkdown(dir);
let failed = 0;

for (const file of files) {
  const rel = path.relative(dir, file);
  const original = fs.readFileSync(file, 'utf8');
  const roundTripped = fromStaging(toStaging(original, okfKey), okfKey);

  const before = splitFrontmatter(original);
  const after = splitFrontmatter(roundTripped);

  const losses: string[] = [];
  diff(before.meta ?? {}, after.meta ?? {}, '', losses);
  if (before.body.trim() !== after.body.trim()) {
    losses.push('body: content changed');
  }

  if (losses.length === 0) {
    console.log(`ok    ${rel}`);
  } else {
    failed++;
    console.log(`FAIL  ${rel}`);
    for (const loss of losses) {
      console.log(`        ${loss}`);
    }
  }
}

console.log();
console.log(`${files.length} files, ${files.length - failed} ok, ${failed} lossy`);
process.exit(failed === 0 ? 0 : 1);
