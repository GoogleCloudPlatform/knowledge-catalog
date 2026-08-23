// Push clean OKF -> Dataplex, preserving the OKF signal layer.
//
// The on-disk bundle is clean OKF. kcmd's generic Documents Layout only maps
// title/description/tags + body, so we translate each file into the "pushable"
// form (signal moved into a custom `okf` aspect via the catalogEntry passthrough)
// in a throwaway .staging/ tree, then delegate to the real kcmd binary.

import * as cp from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as kcmd from 'kcmd';
import { bundleDir, listMarkdown, manifestFile, requireManifest, toStaging } from './okf';

const context = kcmd.gcp.ApiContext.default();
const okfKey = `${context.project}.${context.location}.okf`;
const entryTypeKey = `${context.project}.${context.location}.okf-bundle`;

const root = process.cwd();
requireManifest(root);
const catalogDir = bundleDir(root);
const stagingDir = path.join(root, '.staging');
const binary = path.resolve(root, '../../dist/kcmd');

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stagingDir, 'catalog'), { recursive: true });
// kcmd reads the manifest from the root of the tree it is pointed at, so the
// staging copy keeps the plain name even though the demo's own lives under .state/.
fs.copyFileSync(manifestFile(root), path.join(stagingDir, 'catalog.yaml'));

for (const file of listMarkdown(catalogDir)) {
  const rel = path.relative(catalogDir, file);
  const dest = path.join(stagingDir, 'catalog', rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, toStaging(fs.readFileSync(file, 'utf8'), okfKey, entryTypeKey));
}

try {
  cp.execFileSync(binary, ['push'], { cwd: stagingDir, stdio: 'inherit' });
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
