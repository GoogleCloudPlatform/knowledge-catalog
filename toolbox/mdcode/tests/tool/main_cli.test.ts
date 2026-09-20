// Tests for the top-level argument handling in src/tool/main.ts: what `--help`
// and `--version` exit with, and that neither flag swallows a command that cac
// actually matched. main.ts runs on import, so unlike the other tests in this
// directory these spawn it as a child process and read its exit code.
//
// Each case runs in an empty temp directory with no catalog.yaml, so a command
// that really is reached fails fast on the missing manifest and makes no
// network call. That failure is the signal the command ran at all.

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// bun test runs from the package root; fail loudly rather than silently
// spawning nothing if that ever stops being true.
const MAIN = path.join(process.cwd(), 'src', 'tool', 'main.ts');

let cwd: string;

beforeAll(() => {
  if (!fs.existsSync(MAIN)) throw new Error(`cannot find CLI entrypoint ${MAIN}`);
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-cli-'));
});

afterAll(() => {
  fs.rmSync(cwd, {recursive: true, force: true});
});

function run(...args: string[]): {code: number; out: string} {
  const p = Bun.spawnSync({
    cmd: ['bun', MAIN, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: p.exitCode ?? -1,
    out: p.stdout.toString() + p.stderr.toString(),
  };
}

// cac prints the usage block itself; counting it catches the double-print that
// came from falling through to the `!cli.matchedCommand` branch after cac had
// already answered.
function usageBlocks(out: string): number {
  return out.split('\n').filter((l) => l.startsWith('Usage:')).length;
}

describe('kcmd: --help and --version', () => {
  test('`--help` succeeds and prints the usage block once', () => {
    const {code, out} = run('--help');
    expect(code).toBe(0);
    expect(usageBlocks(out)).toBe(1);
  });

  test('`--version` succeeds and prints only the version', () => {
    const {code, out} = run('--version');
    expect(code).toBe(0);
    expect(usageBlocks(out)).toBe(0);
    expect(out).toContain('kcmd/');
  });

  test('`--help` on a command succeeds and prints that command', () => {
    const {code, out} = run('push', '--help');
    expect(code).toBe(0);
    expect(usageBlocks(out)).toBe(1);
    expect(out).toContain('kcmd push');
  });

  // cac serves `--version` only when nothing matched. With a command matched it
  // runs the action, and because every action is async `cli.parse()` returns
  // while the action is still pending -- so exiting on the flag alone would
  // kill the command here and report success.
  for (const flag of ['--version', '-v']) {
    // Spawns `bun src/tool/main.ts`, which loads the whole CLI before it can
    // fail on the missing manifest. That is well past bun's 5s default.
    test(`\`push ${flag}\` still runs the command`, () => {
      const {code, out} = run('push', flag);
      expect(code).not.toBe(0);
      expect(out).toContain('catalog.yaml');
    }, 30000);
  }

  test('an unknown command is still an error', () => {
    const {code, out} = run('bogusverb');
    expect(code).toBe(1);
    expect(out).toContain(`Unknown command 'bogusverb'`);
  });

  // cac serves `--help` for a command it never matched and clears the match to
  // say so, which is the same state a command that answered its own `--help`
  // leaves behind. Taking that as handled would report a misspelled verb as a
  // success, so the verb the caller typed is what decides.
  for (const flag of ['--help', '--version']) {
    test(`an unknown command with ${flag} is still an error`, () => {
      const {code, out} = run('bogusverb', flag);
      expect(code).toBe(1);
      expect(out).toContain(`Unknown command 'bogusverb'`);
    });
  }

  test('an unknown command with --help prints one usage block', () => {
    // cac has already printed usage by the time the error is reported.
    expect(usageBlocks(run('bogusverb', '--help').out)).toBe(1);
  });

  test('`--help` past a command that takes arguments still succeeds', () => {
    // `action <command> [name]` has its own name taken out of `cli.args` --
    // which arrives holding `list`, a word that names no command -- so
    // `process.argv` is the only place the verb survives to be checked.
    const {code, out} = run('action', 'list', '--help');
    expect(code).toBe(0);
    expect(out).toContain('kcmd action');
  });

  test('`--help` before an unknown verb is still an error', () => {
    // The verb is the first token that is not a flag, not the first token.
    // Reading `process.argv[2]` saw `--help` here, took the absence of a verb
    // for a bare help request, and exited 0 on a misspelled subcommand.
    const {code, out} = run('--help', 'bogusverb');
    expect(code).toBe(1);
    expect(out).toContain(`Unknown command 'bogusverb'`);
  });

  test('`--help` before a known verb still succeeds', () => {
    const {code, out} = run('--help', 'action');
    expect(code).toBe(0);
    expect(out).not.toContain('Unknown command');
  });
});
