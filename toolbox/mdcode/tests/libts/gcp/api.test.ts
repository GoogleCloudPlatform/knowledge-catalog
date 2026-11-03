// Transient-failure retry on reads. Spies on _requestCore so the retry is
// pinned without a live endpoint; retryDelayMs: 0 keeps the backoff off the
// wall clock.

import {describe, expect, spyOn, test} from 'bun:test';

import {ApiClient, isTransientStatus} from '../../../src/libts/gcp/api';
import {ApiContext} from '../../../src/libts/gcp/context';

const CTX = new ApiContext('test-project', 'us', 'test-token');

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

function clientReturning(statuses: number[], retryDelayMs = 0) {
  const client = new ApiClient('https://host', 'v1', CTX, {retryDelayMs});
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
  test('a 500 is retried and the retry is returned (with retryDelayMs: 0)', async () => {
    const {client, core} = clientReturning([500, 200], 0);
    const res = await (client as any)._get('entries/a');
    expect(res.status).toBe(200);
    expect(core).toHaveBeenCalledTimes(2);
  });

  test('GCP_RETRY_DELAY_MS=0 is honored as 0ms rather than falling back to 500ms', async () => {
    const prior = process.env.GCP_RETRY_DELAY_MS;
    process.env.GCP_RETRY_DELAY_MS = '0';
    try {
      const client = new ApiClient('https://host', 'v1', CTX);
      let call = 0;
      const statuses = [503, 503, 200];
      const core = spyOn(client as any, '_requestCore')
                       .mockImplementation(async () => reply(statuses[call++]));
      const start = Date.now();
      const res = await (client as any)._get('entries/a');
      expect(res.status).toBe(200);
      expect(core).toHaveBeenCalledTimes(3);
      expect(Date.now() - start).toBeLessThan(250);
    } finally {
      if (prior === undefined) {
        delete process.env.GCP_RETRY_DELAY_MS;
      } else {
        process.env.GCP_RETRY_DELAY_MS = prior;
      }
    }
  });

  test('a 429 is retried', async () => {
    const {client, core} = clientReturning([429, 200]);
    const res = await (client as any)._get('entries/a');
    expect(res.status).toBe(200);
    expect(core).toHaveBeenCalledTimes(2);
  });

  test('gives up after four attempts and returns the last failure', async () => {
    const {client, core} = clientReturning([500, 500, 500, 500]);
    const res = await (client as any)._get('entries/a');
    expect(res.status).toBe(500);
    expect(core).toHaveBeenCalledTimes(4);
  });

  test('{retry: false} disables transient retries on polling reads', async () => {
    const {client, core} = clientReturning([500, 200]);
    const res = await (client as any)._get('operations/op1', undefined, {retry: false});
    expect(res.status).toBe(500);
    expect(core).toHaveBeenCalledTimes(1);
  });

  test('a 404 is not retried', async () => {
    const {client, core} = clientReturning([404]);
    const res = await (client as any)._get('entries/a');
    expect(res.status).toBe(404);
    expect(core).toHaveBeenCalledTimes(1);
  });

  test('a 403 is not retried', async () => {
    const {client, core} = clientReturning([403]);
    const res = await (client as any)._get('entries/a');
    expect(res.status).toBe(403);
    expect(core).toHaveBeenCalledTimes(1);
  });

  test('a first-try success issues one request', async () => {
    const {client, core} = clientReturning([200]);
    const res = await (client as any)._get('entries/a');
    expect(res.status).toBe(200);
    expect(core).toHaveBeenCalledTimes(1);
  });
});

describe('writes', () => {
  test('a 500 on POST is not retried', async () => {
    const {client, core} = clientReturning([500, 200]);
    const res = await (client as any)._post('entries', {});
    expect(res.status).toBe(500);
    expect(core).toHaveBeenCalledTimes(1);
  });

  test('a 500 on PATCH is not retried', async () => {
    const {client, core} = clientReturning([500, 200]);
    const res = await (client as any)._patch('entries/a', {});
    expect(res.status).toBe(500);
    expect(core).toHaveBeenCalledTimes(1);
  });

  test('a 500 on DELETE is not retried', async () => {
    const {client, core} = clientReturning([500, 200]);
    const res = await (client as any)._delete('entries/a');
    expect(res.status).toBe(500);
    expect(core).toHaveBeenCalledTimes(1);
  });
});

describe('a failed response', () => {
  const debug = 'at com.google.Frame(Frame.java:1)\n'.repeat(1000);
  const google = (error: object) => JSON.stringify({error}, null, 2);
  test.each([
    ['a Google API error gives its message',
     google({message: 'Bad.', details: [{'@type': 'Debug', detail: debug}]}),
     'Bad.'],
    ['a LocalizedMessage detail is preferred',
     google({
       message: 'a \\"b\\"',
       details: [{'@type': 'google.rpc.LocalizedMessage', message: 'a "b"'}],
     }),
     'a "b"'],
    ['a JSON body with no error message comes back as it is',
     '{"error": "x"}', '{"error": "x"}'],
    ['a body that is not JSON comes back trimmed',
     ' <html>Bad Gateway</html>\n', '<html>Bad Gateway</html>'],
    ['a long body that is not JSON is cut',
     debug, `${debug.slice(0, 2000)}...`],
  ])('%s, and GCP_LOG prints the whole body', async (_name, body, message) => {
    const client = new ApiClient('https://host', 'v1', CTX);
    spyOn(client as any, '_requestCore')
        .mockResolvedValue(new Response(body, {status: 400}));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    process.env.GCP_LOG = '1';
    try {
      expect(await (client as any)._get('entries/a'))
          .toEqual({status: 400, message, body});
      expect(log).toHaveBeenLastCalledWith(`[GCP_LOG] 400:${body}\n`, '');
    } finally {
      delete process.env.GCP_LOG;
      log.mockRestore();
    }
  });
});
