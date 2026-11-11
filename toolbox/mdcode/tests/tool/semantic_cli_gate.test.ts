// Verifies the npm CLI bundle (`build/ts/kcmd/cli.js` built with
// `--define __KCMD_ENABLE_SEMANTIC__=false`) exposes only the non-semantic
// commands and options, omits semantic commands/flags in `--help`, rejects
// unregistered semantic commands/options with standard Unknown command /
// Unknown option errors, and rejects `semantic-model` workspaces with the
// unsupported-scope error.

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';

import pkg from '../../package.json';

const ROOT = path.resolve(__dirname, '..', '..');
const CLI_JS = path.join(ROOT, 'build', 'ts', 'kcmd', 'cli.js');
const UNSUPPORTED_SEMANTIC_SCOPE_ERROR =
    'Error: catalog.yaml names a semantic-model scope, which this version of kcmd does not support.';

let tmpDir: string;
let fakeBinDir: string;

beforeAll(() => {
  execFileSync('npm', ['run', 'build:cli'], {cwd: ROOT, stdio: 'pipe'});
  if (!fs.existsSync(CLI_JS)) {
    throw new Error(`Expected built CLI at ${CLI_JS}`);
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-gated-cli-'));
  fakeBinDir = path.join(tmpDir, 'fake-bin');
  fs.mkdirSync(fakeBinDir, {recursive: true});
  const gcloudStub = path.join(fakeBinDir, 'gcloud');
  fs.writeFileSync(
      gcloudStub, '#!/bin/sh\necho "no credentials in test" >&2\nexit 1\n',
      {mode: 0o755});
}, 30000);

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, {recursive: true, force: true});
});

function runGated(args: string[], workDir = tmpDir): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const proc = Bun.spawnSync({
    cmd: ['node', CLI_JS, ...args],
    cwd: workDir,
    env: {
      ...process.env,
      CLOUDSDK_CONFIG: tmpDir,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function parseHelpCommands(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const idx = lines.findIndex(l => l.trim() === 'Commands:');
  if (idx < 0) return [];
  const cmds: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break;
    if (!/^\s+/.test(line)) break;
    const token = line.trim().split(/\s+/)[0];
    if (token) cmds.push(token);
  }
  return cmds;
}

describe('gated kcmd CLI (--define __KCMD_ENABLE_SEMANTIC__=false)', () => {
  test('--version succeeds and prints package version', () => {
    for (const flag of ['--version', '-v']) {
      const res = runGated([flag]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(`kcmd/${pkg.version}`);
      expect(res.stdout + res.stderr).not.toMatch(/private/i);
    }
  });

  test('--help exposes exact command allowlist and zero semantic terms', () => {
    const res = runGated(['--help']);
    expect(res.code).toBe(0);
    expect(parseHelpCommands(res.stdout)).toEqual(['init', 'pull', 'push', 'mcp']);
    expect(res.stdout + res.stderr).not.toMatch(
        /semantic|profiles|\bowl\b|\bshacl\b|\bbind\b|\bglossary\b|skills-generate|--deployment|--no-metric-graphs|--strict-profile/i);
    expect(res.stdout + res.stderr).not.toMatch(/private/i);
  });

  for (const sub of ['init', 'pull', 'push', 'mcp']) {
    test(`${sub} --help omits semantic options and terms`, () => {
      const res = runGated([sub, '--help']);
      expect(res.code).toBe(0);
      expect(res.stdout + res.stderr).not.toMatch(
          /semantic|profiles|\bowl\b|\bshacl\b|\bbind\b|\bglossary\b|skills-generate|--deployment|--no-metric-graphs|--strict-profile/i);
      expect(res.stdout + res.stderr).not.toMatch(/private/i);
      if (sub === 'pull') {
        expect(res.stdout).toContain(
            'Delete stale local OKF concept files not in Knowledge Catalog');
      }
    });
  }

  for (const args of [
    ['profiles'],
    ['owl'],
    ['owl', 'import', 'ontology.ttl'],
    ['shacl', 'import', 'shapes.ttl'],
    ['import', 'model.yaml'],
    ['skills-generate'],
    ['validate'],
    ['test'],
    ['profile'],
    ['bind'],
    ['glossary', 'push'],
    ['profiles', '--help'],
    ['--help', 'profiles'],
    ['owl', '--help'],
    ['shacl', '--help'],
    ['import', '--help'],
    ['skills-generate', '--help'],
    ['validate', '--help'],
    ['test', '--help'],
    ['profile', '--help'],
    ['bind', '--help'],
    ['glossary', '--help'],
  ]) {
    test(`rejects unknown gated command: kcmd ${args.join(' ')}`, () => {
      const res = runGated(args);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('Unknown command');
      expect(res.stdout + res.stderr).not.toMatch(/private/i);
    });
  }

  for (const args of [
    ['init', '--semantic-model', 'p.l.g'],
    ['init', '--semantic-model=p.l.g'],
    ['push', '--deployment'],
    ['push', '--deployment', 'analytical'],
    ['push', '--deployment=analytical'],
    ['push', '--no-deployment'],
    ['push', '--print'],
    ['push', '--skip-source-check'],
    ['push', '--no-metric-graphs'],
    ['push', '--strict-profile'],
    ['push', '--profile', 'prod'],
    ['push', '--no-profile'],
    ['push', '--force-remove'],
    ['push', '--emit-expressions'],
    ['push', '--no-kc'],
    ['push', '--transpile'],
    ['push', '--all-profiles'],
  ]) {
    test(`rejects unknown gated option: kcmd ${args.join(' ')}`, () => {
      const res = runGated(args);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('Unknown option');
      expect(res.stdout + res.stderr).not.toMatch(/private/i);
    });
  }

  test('bare init error omits --semantic-model', () => {
    const res = runGated(['init']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(
        'Error: Must provide --entry-group, --bigquery-dataset, or --kb');
    expect(res.stderr).not.toMatch(/semantic/i);
    expect(res.stdout + res.stderr).not.toMatch(/private/i);
  });

  for (const [label, manifestObj] of [
    ['bare string scope', {scope: 'semantic-model'}],
    ['qualified string scope', {scope: 'semantic-model.p.l.g'}],
    ['array scope', {scope: ['semantic-model.p.l.g']}],
  ] as const) {
    test(`rejects pull, push, mcp (cwd), and mcp --path in semantic-model workspace (${label})`, () => {
      const wsDir = fs.mkdtempSync(path.join(tmpDir, 'ws-'));
      fs.writeFileSync(
          path.join(wsDir, 'catalog.yaml'), yaml.stringify(manifestObj), 'utf8');

      for (const cmd of ['pull', 'push', 'mcp']) {
        const res = runGated([cmd], wsDir);
        expect(res.code).toBe(1);
        expect(res.stderr).toContain(UNSUPPORTED_SEMANTIC_SCOPE_ERROR);
        expect(res.stdout + res.stderr).not.toMatch(/private/i);
      }

      const mcpPathRes = runGated(['mcp', '--path', wsDir], tmpDir);
      expect(mcpPathRes.code).toBe(1);
      expect(mcpPathRes.stderr).toContain(UNSUPPORTED_SEMANTIC_SCOPE_ERROR);
      expect(mcpPathRes.stdout + mcpPathRes.stderr).not.toMatch(/private/i);
    }, 30000);
  }

  test('permits non-semantic workspace scopes through assertScopeSupported', () => {
    const egWsDir = fs.mkdtempSync(path.join(tmpDir, 'eg-ws-'));
    fs.writeFileSync(
        path.join(egWsDir, 'catalog.yaml'),
        yaml.stringify({scope: 'entryGroup.p.l.g', layout: 'unknown-layout'}),
        'utf8');

    for (const cmd of ['pull', 'push', 'mcp']) {
      const res = runGated([cmd], egWsDir);
      expect(res.code).toBe(1);
      expect(res.stderr).not.toContain(UNSUPPORTED_SEMANTIC_SCOPE_ERROR);
      expect(res.stderr).toContain(
          cmd === 'mcp' ? 'Error starting MCP server:' :
                          "Manifest error: layout 'unknown-layout'");
    }
  }, 30000);
});
