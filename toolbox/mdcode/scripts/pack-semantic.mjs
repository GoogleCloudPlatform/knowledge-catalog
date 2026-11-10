import {execFileSync, execSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');
const stageDir = path.join(distDir, 'semantic-stage');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'));
const semanticName = '@google-cloud/kcmd-semantic';
const semanticVersion = `${pkg.version}-semantic`;
const tarballPath = path.join(distDir, `google-cloud-kcmd-semantic-${semanticVersion}.tgz`);
const sbomPath = path.join(distDir, 'sbom-semantic.spdx.json');

execFileSync('npm', ['run', 'build:libts'], {cwd: rootDir, stdio: 'inherit'});
execFileSync('npm', ['run', 'build:cli'], {cwd: rootDir, stdio: 'inherit'});

fs.rmSync(stageDir, {recursive: true, force: true});
fs.rmSync(tarballPath, {force: true});
fs.rmSync(sbomPath, {force: true});
fs.mkdirSync(stageDir, {recursive: true});

try {
  for (const rel of ['build/ts/kcmd', 'README.md', 'LICENSE']) {
    const dst = path.join(stageDir, rel);
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.cpSync(path.join(rootDir, rel), dst, {recursive: true});
  }
  for (const [relPath, meta] of Object.entries(lock.packages)) {
    if (!relPath.startsWith('node_modules/') || meta.dev || meta.devOptional) continue;
    const src = path.join(rootDir, relPath);
    if (!fs.existsSync(src)) {
      if (meta.optional) continue;
      throw new Error(`Missing runtime dependency at '${relPath}'; run 'npm ci' first.`);
    }
    const dst = path.join(stageDir, relPath);
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.cpSync(src, dst, {
      recursive: true,
      filter: (s) => s === src || path.relative(src, s).split(path.sep)[0] !== 'node_modules',
    });
    const {version} = JSON.parse(fs.readFileSync(path.join(dst, 'package.json'), 'utf8'));
    if (version !== meta.version) {
      throw new Error(`'${relPath}' is ${version}, but package-lock.json says ${meta.version}; run 'npm ci' first.`);
    }
  }

  let sha = '';
  try {
    sha = execSync('git rev-parse --short HEAD', {cwd: rootDir, stdio: ['ignore', 'pipe', 'ignore']}).toString().trim();
  } catch {}
  const stageCli = path.join(stageDir, 'build', 'ts', 'kcmd', 'cli.js');
  execFileSync(
      'npx',
      [
        'bun', 'build', '--target=node', '--format=cjs', '--packages=external',
        '--define', '__KCMD_ENABLE_SEMANTIC__=true',
        '--define', `__KCMD_VERSION__=${JSON.stringify(semanticVersion)}`,
        '--define', `__KCMD_COMMIT__=${JSON.stringify(sha)}`,
        '--banner=#!/usr/bin/env node', '--outfile', stageCli, 'src/tool/main.ts',
      ],
      {cwd: rootDir, stdio: 'inherit'});
  fs.chmodSync(stageCli, 0o755);

  const {devDependencies: _dev, publishConfig: _pub, ...restPkg} = pkg;
  const semanticPkg = {
    ...restPkg,
    name: semanticName,
    version: semanticVersion,
    private: true,
    bundleDependencies: Object.keys(pkg.dependencies),
  };
  fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify(semanticPkg, null, 2) + '\n');

  execFileSync('npm', ['pack', '--pack-destination', distDir], {cwd: stageDir, stdio: 'inherit'});

  const semanticLockPackages = {};
  for (const [relPath, meta] of Object.entries(lock.packages)) {
    if (relPath === '') {
      const {devDependencies: _lockDev, ...restRoot} = meta;
      semanticLockPackages[''] = {
        ...restRoot,
        name: semanticName,
        version: semanticVersion,
      };
    } else if (
        !meta.dev && !meta.devOptional &&
        fs.existsSync(path.join(stageDir, relPath))) {
      semanticLockPackages[relPath] = meta;
    }
  }
  fs.writeFileSync(
      path.join(stageDir, 'package-lock.json'),
      JSON.stringify(
          {
            ...lock,
            name: semanticName,
            version: semanticVersion,
            packages: semanticLockPackages,
          },
          null, 2) +
          '\n');

  const sbomRaw = execFileSync(
      'npm',
      ['sbom', '--sbom-format=spdx', '--package-lock-only'],
      {cwd: stageDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  const sbomDoc = JSON.parse(sbomRaw);
  // SPDX 2.3 allows only letters, digits, '.' and '-' in IDs, and no fractional seconds in 'created'.
  const spdxId = (id) => id.replace(/[^A-Za-z0-9.-]/g, '-');
  sbomDoc.creationInfo.created = sbomDoc.creationInfo.created.replace(/\.\d+Z$/, 'Z');
  sbomDoc.documentDescribes = sbomDoc.documentDescribes?.map(spdxId);
  sbomDoc.relationships ??= [];
  for (const r of sbomDoc.relationships) {
    r.spdxElementId = spdxId(r.spdxElementId);
    r.relatedSpdxElement = spdxId(r.relatedSpdxElement);
  }
  const rootSpdxId = sbomDoc.documentDescribes?.[0];
  for (const p of sbomDoc.packages ?? []) {
    p.SPDXID = spdxId(p.SPDXID);
    if (!p.licenseConcluded && p.licenseDeclared) {
      p.licenseConcluded = p.licenseDeclared;
    }
    if (rootSpdxId && p.SPDXID && p.SPDXID !== rootSpdxId) {
      sbomDoc.relationships.push({
        spdxElementId: rootSpdxId,
        relatedSpdxElement: p.SPDXID,
        relationshipType: 'CONTAINS',
      });
    }
  }
  fs.writeFileSync(sbomPath, JSON.stringify(sbomDoc, null, 2) + '\n');
} catch (err) {
  fs.rmSync(tarballPath, {force: true});
  fs.rmSync(sbomPath, {force: true});
  throw err;
} finally {
  fs.rmSync(stageDir, {recursive: true, force: true});
}
