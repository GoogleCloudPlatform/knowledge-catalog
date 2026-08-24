// Pull from Dataplex -> clean OKF, restoring the OKF signal layer.
//
// kcmd pulls into a throwaway .staging/ tree in the "pushable" form (signal
// carried in the custom `okf` aspect via the catalogEntry passthrough); we then
// translate each file back to clean OKF and write it to pulled/. Inverse of push.ts.

import * as cp from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as kcmd from 'kcmd';
import { pullTargetDir, listMarkdown, fromStaging, manifestFile, requireManifest } from './okf';

const context = kcmd.gcp.ApiContext.default();
const okfKey = `${context.project}.${context.location}.okf`;

const root = process.cwd();
requireManifest(root);
const catalogDir = pullTargetDir(root);
const stagingDir = path.join(root, '.staging');
const stagingCatalog = path.join(stagingDir, 'catalog');
const binary = path.resolve(root, '../../dist/kcmd');

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingCatalog, { recursive: true });
// kcmd reads the manifest from the root of the tree it is pointed at, so the
// staging copy keeps the plain name even though the demo's own lives under .state/.
fs.copyFileSync(manifestFile(root), path.join(stagingDir, 'catalog.yaml'));

try {
  cp.execFileSync(binary, ['pull'], { cwd: stagingDir, stdio: 'inherit' });

  for (const file of listMarkdown(stagingCatalog)) {
    const rel = path.relative(stagingCatalog, file);
    const dest = path.join(catalogDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fromStaging(fs.readFileSync(file, 'utf8'), okfKey));
  }
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
