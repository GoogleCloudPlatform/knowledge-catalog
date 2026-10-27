// Tests ApiContext (src/libts/gcp/context.ts): when it runs the gcloud
// commands. A context from deferred() must run none until a request reads the
// project, the location or the token, so commands that only read a local
// workspace need neither gcloud nor credentials.

import {afterEach, beforeEach, describe, expect, spyOn, test} from 'bun:test';
import * as cp from 'child_process';

import {ApiContext} from '../../../src/libts/gcp/context';

const VALUES: Record<string, string> = {
  'gcloud -q config get-value project': 'my-project\n',
  'gcloud -q config get-value compute/region': 'us-central1\n',
  'gcloud -q auth application-default print-access-token': 'token-1\n',
};

let exec: ReturnType<typeof spyOn>;

beforeEach(() => {
  exec = spyOn(cp, 'execSync').mockImplementation(((cmd: string) => {
    const value = VALUES[cmd];
    if (value === undefined) throw new Error(`unexpected command: ${cmd}`);
    return Buffer.from(value);
  }) as any);
});

afterEach(() => {
  exec.mockRestore();
});

describe('ApiContext.deferred', () => {
  test('runs no gcloud command until a value is read', () => {
    ApiContext.deferred();
    expect(exec).not.toHaveBeenCalled();
  });

  test('reads all three values on the first read, once', () => {
    const ctx = ApiContext.deferred();
    expect(ctx.location).toBe('us-central1');
    expect(exec).toHaveBeenCalledTimes(3);
    expect(ctx.project).toBe('my-project');
    expect(ctx.token).toBe('token-1');
    expect(exec).toHaveBeenCalledTimes(3);
  });

  test('fails at first use as default() does, and again on the next read',
       () => {
         VALUES['gcloud -q config get-value compute/region'] = '\n';
         try {
           const ctx = ApiContext.deferred();
           expect(() => ctx.project).toThrow('Ensure gcloud is configured');
           expect(() => ctx.token).toThrow('Ensure gcloud is configured');
         } finally {
           VALUES['gcloud -q config get-value compute/region'] =
               'us-central1\n';
         }
       });

  test('refresh() before any read only reads once', () => {
    const ctx = ApiContext.deferred();
    ctx.refresh();
    expect(exec).toHaveBeenCalledTimes(3);
    expect(ctx.token).toBe('token-1');
    expect(exec).toHaveBeenCalledTimes(3);
  });
});

describe('ApiContext.default and the constructor', () => {
  test('default() reads gcloud immediately', () => {
    const ctx = ApiContext.default();
    expect(exec).toHaveBeenCalledTimes(3);
    expect(ctx.project).toBe('my-project');
  });

  test('an explicit context runs no command', () => {
    const ctx = new ApiContext('p', 'l', 't');
    expect([ctx.project, ctx.location, ctx.token]).toEqual(['p', 'l', 't']);
    expect(exec).not.toHaveBeenCalled();
  });

  test('refresh() on a read context fetches a new token', () => {
    const ctx = new ApiContext('p', 'l', 't');
    ctx.refresh();
    expect(ctx.token).toBe('token-1');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
