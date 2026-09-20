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
    test(`\`push ${flag}\` still runs the command`, () => {
      const {code, out} = run('push', flag);
      expect(code).not.toBe(0);
      expect(out).toContain('catalog.yaml');
    });
  }

  test('an unknown command is still an error', () => {
    const {code, out} = run('bogusverb');
    expect(code).toBe(1);
    expect(out).toContain(`Unknown command 'bogusverb'`);
  });
});
