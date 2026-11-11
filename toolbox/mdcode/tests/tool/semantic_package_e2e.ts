// End-to-end verification for `npm run pack:semantic`:
// confirms `dist/google-cloud-kcmd-semantic-<ver>-semantic.tgz` bundles all runtime
// dependencies (top-level and nested) + WASM + LICENSE files with `private: true`
// and no `publishConfig` or `package-lock.json`, matches the SPDX SBOM 1:1 on
// `name@version`, installs 100% offline with an empty npm cache, executes
// `owl import` (n3) and `import` (@polyglot-sql/sdk WASM) offline, and leaves
// tracked `package.json` and `build/ts/kcmd/cli.js` untouched/gated.

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import pkg from '../../package.json';
import lock from '../../package-lock.json';

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT, 'dist');
const TARBALL = path.join(
    DIST_DIR, `google-cloud-kcmd-semantic-${pkg.version}-semantic.tgz`);
const SBOM_PATH = path.join(DIST_DIR, 'sbom-semantic.spdx.json');
const BUNDLED_PKG_ROOT_RE =
    /^package(?:\/node_modules\/(?:@[^/]+\/[^/]+|[^@/]+))+\/package\.json$/;

let tmpDir: string;
let unpackedDir: string;
let tarEntries: string[];

beforeAll(() => {
  execFileSync('npm', ['run', 'pack:semantic'], {cwd: ROOT, stdio: 'pipe'});
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-semantic-pkg-'));
  unpackedDir = path.join(tmpDir, 'unpacked');
  fs.mkdirSync(unpackedDir, {recursive: true});
  tarEntries = execFileSync('tar', ['-tzf', TARBALL], {encoding: 'utf8'})
                   .split(/\r?\n/)
                   .filter(Boolean);
  execFileSync('tar', ['-xzf', TARBALL, '-C', unpackedDir]);
}, 180000);

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('semantic tarball build (npm run pack:semantic)', () => {
  test('cleans staging directory and leaves workspace files unmutated and gated', () => {
    expect(fs.existsSync(path.join(DIST_DIR, 'semantic-stage'))).toBe(false);

    const diskPkg = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(diskPkg.name).toBe('@google-cloud/kcmd');
    expect(diskPkg.version).toBe(pkg.version);
    expect(diskPkg.private).toBeUndefined();
    expect(diskPkg.publishConfig).toEqual({access: 'public'});
    expect(diskPkg.bundleDependencies).toBeUndefined();

    const gated = Bun.spawnSync({
      cmd: ['node', path.join(ROOT, 'build', 'ts', 'kcmd', 'cli.js'), 'profiles'],
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(gated.exitCode).toBe(1);
    expect(gated.stderr.toString()).toContain("Unknown command 'profiles'");
    expect(gated.stdout.toString() + gated.stderr.toString())
        .not.toMatch(/private/i);
  });

  test('sets private: true, omits publishConfig and package-lock.json, and packs all runtime deps + WASM + LICENSE files', () => {
    expect(fs.existsSync(TARBALL)).toBe(true);
    const entrySet = new Set(tarEntries);

    expect(entrySet.has('package/package.json')).toBe(true);
    expect(entrySet.has('package/package-lock.json')).toBe(false);
    expect(entrySet.has('package/LICENSE')).toBe(true);
    expect(entrySet.has('package/README.md')).toBe(true);
    expect(entrySet.has('package/build/ts/kcmd/cli.js')).toBe(true);

    const packedPkg = JSON.parse(
        fs.readFileSync(path.join(unpackedDir, 'package', 'package.json'), 'utf8'));
    expect(packedPkg.name).toBe('@google-cloud/kcmd-semantic');
    expect(packedPkg.version).toBe(`${pkg.version}-semantic`);
    expect(packedPkg.private).toBe(true);
    expect(packedPkg.publishConfig).toBeUndefined();
    expect(packedPkg.devDependencies).toBeUndefined();
    expect(packedPkg.bundleDependencies).toEqual(Object.keys(pkg.dependencies));

    const expectedRuntimePaths =
        Object.entries(lock.packages)
            .filter(
                ([rel, meta]) => rel.startsWith('node_modules/') &&
                    !(meta as {dev?: boolean; optional?: boolean}).dev &&
                    !(meta as {optional?: boolean}).optional)
            .map(([rel]) => `package/${rel}/package.json`)
            .sort();
    expect(expectedRuntimePaths.some(
               p => p.indexOf('/node_modules/') !== p.lastIndexOf('/node_modules/')))
        .toBe(true);
    for (const expectedPath of expectedRuntimePaths) {
      expect(entrySet.has(expectedPath)).toBe(true);
    }
    expect(entrySet.has(
               'package/node_modules/@polyglot-sql/sdk/dist/polyglot_sql.wasm'))
        .toBe(true);
    expect(tarEntries.some(
               e => e.startsWith('package/node_modules/@polyglot-sql/sdk/LICENSE')))
        .toBe(true);
    expect(tarEntries.some(e => e.startsWith('package/node_modules/n3/LICENSE')))
        .toBe(true);

    for (const devDep of ['typescript', 'bun', 'memfs', '@modelcontextprotocol/inspector']) {
      expect(tarEntries.some(e => e.startsWith(`package/node_modules/${devDep}/`)))
          .toBe(false);
    }
  });

  test('SPDX SBOM matches bundled tarball runtime package roots 1:1 on name@version', () => {
    expect(fs.existsSync(SBOM_PATH)).toBe(true);
    const sbom = JSON.parse(fs.readFileSync(SBOM_PATH, 'utf8'));
    expect(sbom.spdxVersion).toMatch(/^SPDX-/);

    const bundledRootPaths = tarEntries.filter(e => BUNDLED_PKG_ROOT_RE.test(e));
    const bundledIds = new Set(bundledRootPaths.map(rel => {
      const p = JSON.parse(
          fs.readFileSync(path.join(unpackedDir, rel), 'utf8'));
      return `${p.name}@${p.version}`;
    }));

    const rootId = `@google-cloud/kcmd-semantic@${pkg.version}-semantic`;
    const sbomAllIds: string[] = (sbom.packages ?? []).map(
        (p: {name?: string; versionInfo?: string}) =>
            `${p.name}@${p.versionInfo}`);
    expect(sbomAllIds).toContain(rootId);

    const expectedRuntimePaths =
        Object.entries(lock.packages)
            .filter(
                ([rel, meta]) => rel.startsWith('node_modules/') &&
                    !(meta as {dev?: boolean}).dev &&
                    fs.existsSync(path.join(ROOT, rel)))
            .map(([rel]) => `package/${rel}/package.json`)
            .sort();

    const sbomRuntimeIds = new Set(sbomAllIds.filter(id => id !== rootId));
    expect([...bundledRootPaths].sort()).toEqual(expectedRuntimePaths);
    expect(bundledIds.size).toBeGreaterThanOrEqual(
        Object.keys(pkg.dependencies).length);
    expect([...sbomRuntimeIds].sort()).toEqual([...bundledIds].sort());

    const sbomNames = new Set(
        [...sbomRuntimeIds].map(id => id.slice(0, id.lastIndexOf('@'))));
    const bundledNames = new Set(
        [...bundledIds].map(id => id.slice(0, id.lastIndexOf('@'))));
    for (const reqRuntime of Object.keys(pkg.dependencies)) {
      expect(sbomNames.has(reqRuntime)).toBe(true);
      expect(bundledNames.has(reqRuntime)).toBe(true);
    }
    for (const devDep of [
      'typescript',
      'bun',
      'memfs',
      '@modelcontextprotocol/inspector',
    ]) {
      expect(sbomNames.has(devDep)).toBe(false);
      expect(bundledNames.has(devDep)).toBe(false);
    }

    expect(sbom.creationInfo.created)
        .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const spdxIdRe = /^SPDXRef-[A-Za-z0-9.-]+$/;
    for (const id of sbom.documentDescribes ?? []) {
      expect(id).toMatch(spdxIdRe);
    }
    for (const r of sbom.relationships ?? []) {
      expect(r.spdxElementId).toMatch(spdxIdRe);
      expect(r.relatedSpdxElement).toMatch(spdxIdRe);
    }

    const rootSpdxId = sbom.documentDescribes?.[0];
    expect(typeof rootSpdxId).toBe('string');
    const containsTargets = new Set(
        (sbom.relationships ?? [])
            .filter(
                (r: {spdxElementId?: string; relationshipType?: string}) =>
                    r.spdxElementId === rootSpdxId &&
                    r.relationshipType === 'CONTAINS')
            .map((r: {relatedSpdxElement?: string}) => r.relatedSpdxElement));
    for (const p of sbom.packages ?? []) {
      expect(p.SPDXID).toMatch(spdxIdRe);
      expect(Boolean(p.licenseConcluded)).toBe(true);
      expect(p.licenseConcluded).not.toBe('NOASSERTION');
      if (p.SPDXID !== rootSpdxId) {
        expect(containsTargets.has(p.SPDXID)).toBe(true);
      }
    }
  });

  test('installs offline with empty cache and executes semantic CLI commands (n3 + WASM)', () => {
    const installDir = path.join(tmpDir, 'consumer');
    const cacheDir = path.join(tmpDir, 'empty-npm-cache');
    fs.mkdirSync(installDir, {recursive: true});
    fs.mkdirSync(cacheDir, {recursive: true});

    const cleanEnv = Object.fromEntries(
        Object.entries(process.env)
            .filter(([k]) => !k.toLowerCase().startsWith('npm_config_')));
    execFileSync(
        'npm',
        [
          'install', '-g', '--offline', '--no-audit', '--no-fund',
          '--cache', cacheDir, '--prefix', installDir, TARBALL,
        ],
        {cwd: installDir, env: cleanEnv, stdio: 'pipe'});

    const kcmdBin = path.join(installDir, 'bin', 'kcmd');
    expect(fs.existsSync(kcmdBin)).toBe(true);

    const runInstalled = (...args: string[]) => {
      const p = Bun.spawnSync({
        cmd: [kcmdBin, ...args],
        cwd: installDir,
        env: {...process.env, CLOUDSDK_CONFIG: tmpDir},
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return {
        code: p.exitCode ?? -1,
        stdout: p.stdout.toString(),
        stderr: p.stderr.toString(),
      };
    };

    const ver = runInstalled('--version');
    expect(ver.code).toBe(0);
    expect(ver.stdout).toContain(`kcmd/${pkg.version}-semantic`);

    const help = runInstalled('--help');
    expect(help.code).toBe(0);
    for (const cmd of ['init', 'pull', 'push', 'profiles', 'owl', 'import', 'skills-generate', 'mcp']) {
      expect(help.stdout).toContain(cmd);
    }

    const owlFixture = path.join(
        ROOT, 'tests', 'libts', 'semantic', 'fixtures', 'owl', 'org.owl.ttl');
    const owlOut = path.join(installDir, 'org.osi.yaml');
    const owlRes = runInstalled('owl', 'import', owlFixture, '--out', owlOut);
    expect(owlRes.code).toBe(0);
    expect(fs.existsSync(owlOut)).toBe(true);
    expect(fs.readFileSync(owlOut, 'utf8')).toContain('semantic_model:');

    const sqlFixture = path.join(
        ROOT, 'tests', 'libts', 'semantic', 'fixtures', 'measure_lowering.yaml');
    const importOut = path.join(installDir, 'imported.osi.yaml');
    const importRes = runInstalled(
        'import', sqlFixture, '--flavor', 'ossie', '--out', importOut);
    expect(importRes.code).toBe(0);
    expect(fs.existsSync(importOut)).toBe(true);
    expect(fs.readFileSync(importOut, 'utf8')).toContain('semantic_model:');
  }, 180000);
});
