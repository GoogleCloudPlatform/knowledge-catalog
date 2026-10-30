// Transient-failure retry on reads. Spies on _requestCore so the retry is
// pinned without a live endpoint; GCP_RETRY_DELAY_MS keeps the backoff off the
// wall clock.

import {beforeAll, describe, expect, spyOn, test} from 'bun:test';

import {ApiClient, isTransientStatus} from '../../../src/libts/gcp/api';
import {ApiContext} from '../../../src/libts/gcp/context';

const CTX = new ApiContext('test-project', 'us', 'test-token');

beforeAll(() => {
  process.env.GCP_RETRY_DELAY_MS = '1';
});

function reply(status: number, body: unknown = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  } as unknown as Response;
}

function clientReturning(...statuses: number[]) {
  const client = new ApiClient('https://host', 'v1', CTX);
  let call = 0;
  const core = spyOn(client as any, '_requestCore')
                   .mockImplementation(async () => reply(statuses[call++]));
  return {client, core};
}

describe('isTransientStatus', () => {
  test('5xx and 429 are transient', () => {
    expect(isTransientStatus(500)).toBe(true);
    expect(isTransientStatus(503)).toBe(true);
    expect(isTransientStatus(429)).toBe(true);
  });

  test('other 4xx and success are not', () => {
    expect(isTransientStatus(200)).toBe(false);
    expect(isTransientStatus(403)).toBe(false);
    expect(isTransientStatus(404)).toBe(false);
    expect(isTransientStatus(409)).toBe(false);
  });
});

describe('ApiClient._get', () => {
  test('a 500 is retried and the retry is returned', async () => {
    const {client, core} = clientReturning(500, 200);
    const res = await (client as any)._get('entries/a');
    expect(res.status).toBe(200);
    expect(core).toHaveBeenCalledTimes(2);
  });

  test('a 429 is retried', async () => {
    const {client, core} = clientReturning(429, 200);
    const res = await (client as any)._get('entries/a');
    expect(res.status).toBe(200);
    expect(core).toHaveBeenCalledTimes(2);
  });

  test('gives up after four attempts and returns the last failure', async () => {
    const {client, core} = clientReturning(500, 500, 500, 500);
    const res = await (client as any)._get('entries/a');
    expect(res.status).toBe(500);
    expect(core).toHaveBeenCalledTimes(4);
  });

  test('a 404 is not retried', async () => {
    const {client, core} = clientReturning(404);
    const res = await (client as any)._get('entries/a');
    expect(res.status).toBe(404);
    expect(core).toHaveBeenCalledTimes(1);
  });

  test('a 403 is not retried', async () => {
    const {client, core} = clientReturning(403);
    const res = await (client as any)._get('entries/a');
    expect(res.status).toBe(403);
    expect(core).toHaveBeenCalledTimes(1);
  });

  test('a first-try success issues one request', async () => {
    const {client, core} = clientReturning(200);
    const res = await (client as any)._get('entries/a');
    expect(res.status).toBe(200);
    expect(core).toHaveBeenCalledTimes(1);
  });
});

describe('writes', () => {
  test('a 500 on POST is not retried', async () => {
    const {client, core} = clientReturning(500, 200);
    const res = await (client as any)._post('entries', {});
    expect(res.status).toBe(500);
    expect(core).toHaveBeenCalledTimes(1);
  });

  test('a 500 on PATCH is not retried', async () => {
    const {client, core} = clientReturning(500, 200);
    const res = await (client as any)._patch('entries/a', {});
    expect(res.status).toBe(500);
    expect(core).toHaveBeenCalledTimes(1);
  });

  test('a 500 on DELETE is not retried', async () => {
    const {client, core} = clientReturning(500, 200);
    const res = await (client as any)._delete('entries/a');
    expect(res.status).toBe(500);
    expect(core).toHaveBeenCalledTimes(1);
  });
});
