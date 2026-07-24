// Push clean OKF -> Dataplex, preserving the OKF signal layer.
//
// The on-disk catalog/ is clean OKF. kcmd's generic Documents Layout only maps
// title/description/tags + body, so we translate each file into the "pushable"
// form (signal moved into a custom `okf` aspect via the catalogEntry passthrough)
// in a throwaway .staging/ tree, then delegate to the real kcmd binary.

import * as cp from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as kcmd from 'kcmd';
import { toStaging } from './okf';

const context = kcmd.gcp.ApiContext.default();
const okfKey = `${context.project}.${context.location}.okf`;

const root = process.cwd();
const catalogDir = path.join(root, 'catalog');
const stagingDir = path.join(root, '.staging');
const binary = path.resolve(root, '../../dist/kcmd');

function listMd(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      out.push(...listMd(full));
    } else if (name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stagingDir, 'catalog'), { recursive: true });
fs.copyFileSync(path.join(root, 'catalog.yaml'), path.join(stagingDir, 'catalog.yaml'));

for (const file of listMd(catalogDir)) {
  const rel = path.relative(catalogDir, file);
  const dest = path.join(stagingDir, 'catalog', rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, toStaging(fs.readFileSync(file, 'utf8'), okfKey));
}

cp.execFileSync(binary, ['push'], { cwd: stagingDir, stdio: 'inherit' });

fs.rmSync(stagingDir, { recursive: true, force: true });
