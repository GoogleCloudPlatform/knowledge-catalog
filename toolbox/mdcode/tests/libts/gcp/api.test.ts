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
  // What Dataplex answered, live, to a path it does not serve.
  const NOT_FOUND_PAGE = `<!DOCTYPE html>
<html lang=en>
  <meta charset=utf-8>
  <meta name=viewport content="initial-scale=1, minimum-scale=1, width=device-width">
  <title>Error 404 (Not Found)!!1</title>
  <style>
    *{margin:0;padding:0}html,code{font:15px/22px arial,sans-serif}html{background:#fff;color:#222;padding:15px}body{margin:7% auto 0;max-width:390px;min-height:180px;padding:30px 0 15px}* > body{background:url(//www.google.com/images/errors/robot.png) 100% 5px no-repeat;padding-right:205px}p{margin:11px 0 22px;overflow:hidden}ins{color:#777;text-decoration:none}a img{border:0}@media screen and (max-width:772px){body{background:none;margin-top:0;max-width:none;padding-right:0}}#logo{background:url(//www.google.com/images/branding/googlelogo/1x/googlelogo_color_150x54dp.png) no-repeat;margin-left:-5px}@media only screen and (min-resolution:192dpi){#logo{background:url(//www.google.com/images/branding/googlelogo/2x/googlelogo_color_150x54dp.png) no-repeat 0% 0%/100% 100%;-moz-border-image:url(//www.google.com/images/branding/googlelogo/2x/googlelogo_color_150x54dp.png) 0}}@media only screen and (-webkit-min-device-pixel-ratio:2){#logo{background:url(//www.google.com/images/branding/googlelogo/2x/googlelogo_color_150x54dp.png) no-repeat;-webkit-background-size:100% 100%}}#logo{display:inline-block;height:54px;width:150px}
  </style>
  <a href=//www.google.com/><span id=logo aria-label=Google></span></a>
  <p><b>404.</b> <ins>That’s an error.</ins>
  <p>The requested URL <code>/v1bogus/xyz</code> was not found on this server.  <ins>That’s all we know.</ins>
`;
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
    ['a field violation the message lacks follows it',
     google({
       message: 'Invalid GetDatabase request.',
       details: [{
         '@type': 'type.googleapis.com/google.rpc.BadRequest',
         fieldViolations: [{
           field: 'name',
           description: 'Got: databases/Retail\nError: Invalid database name.',
         }],
       }],
     }),
     'Invalid GetDatabase request. Got: databases/Retail; Error: Invalid ' +
         'database name.'],
    ['a field violation the message states is not repeated',
     google({
       message: 'Invalid value at \'view\', "NOPE"',
       details: [{
         '@type': 'type.googleapis.com/google.rpc.BadRequest',
         fieldViolations:
             [{field: 'view', description: 'Invalid value at \'view\', "NOPE"'}],
       }],
     }),
     'Invalid value at \'view\', "NOPE"'],
    ['a JSON body with no error message comes back as it is',
     '{"error": "x"}', '{"error": "x"}'],
    ['an HTML page comes back as its text, its scripts dropped before the cut',
     ` <html><script>${'retry();'.repeat(300)}</script>Bad Gateway</html>\n`,
     'Bad Gateway'],
    ['an HTML page comes back without its style',
     NOT_FOUND_PAGE,
     'Error 404 (Not Found)!!1 404. That’s an error. The requested URL ' +
         '/v1bogus/xyz was not found on this server. That’s all we know.'],
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
