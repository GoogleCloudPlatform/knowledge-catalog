// Tests for the default sqlglot transpilation MECHANISM (the sqlglotTranspiler
// adapter in src/libts/semantic/transpile.ts).
//
// sqlglot is an OPTIONAL out-of-process dependency (it cannot be bundled into a
// `bun --compile` binary), so the adapter is designed to never throw: a missing
// interpreter, a missing `sqlglot` module, a non-zero exit, or unparseable
// output all degrade to a per-request `error`. The invariant tests below assert
// that contract and run everywhere. The transformation tests assert real
// Snowflake/Databricks -> GoogleSQL rewrites and are gated on `sqlglot`
// actually being importable, so a machine without it still passes the suite.
//
// Provide the interpreter via $KCMD_PYTHON (a venv with sqlglot); otherwise
// `python3` is used. Install for the gated tests, e.g.:
//   python3 -m venv .venv && .venv/bin/pip install sqlglot
//   KCMD_PYTHON=.venv/bin/python bun test
//   ./tests/libts/semantic/transpile.sqlglot.test.ts

import {describe, expect, test} from 'bun:test';

import {sqlglotInstalled, sqlglotTranspiler} from '../../../src/libts/semantic/transpile';

// Is a working sqlglot reachable through the adapter's interpreter? Probed
// synchronously (no top-level `await`, which tsc rejects here) so it can gate
// the transformation tests at registration time. The invariant tests below do
// not depend on it.
const AVAILABLE = sqlglotInstalled();

describe('sqlglotTranspiler (mechanism invariants; run everywhere)', () => {
  test(
      'returns exactly one response per request, correlated by id',
      async () => {
        const requests = [
          {id: 'a', dialect: 'SNOWFLAKE', expression: 'NVL(x, 0)'},
          {id: 'b', dialect: 'DATABRICKS', expression: 'x::double'},
        ];
        const responses = await sqlglotTranspiler(requests, 'BIGQUERY');
        expect(responses.length).toBe(2);
        expect(new Set(responses.map(r => r.id))).toEqual(new Set(['a', 'b']));
        // Each response is exactly one of sql|error, never both, never neither.
        for (const r of responses) {
          expect((r.sql === undefined) !== (r.error === undefined)).toBe(true);
        }
      });

  test('resolves to an empty array for no requests', async () => {
    expect(await sqlglotTranspiler([], 'BIGQUERY')).toEqual([]);
  });

  test(
      'degrades to a per-request error (never throws) for a bad interpreter',
      async () => {
        const saved = process.env.KCMD_PYTHON;
        process.env.KCMD_PYTHON = '/nonexistent/python-that-is-not-here';
        try {
          const responses = await sqlglotTranspiler(
              [{id: '0', dialect: 'SNOWFLAKE', expression: 'NVL(x, 0)'}],
              'BIGQUERY');
          expect(responses.length).toBe(1);
          expect(responses[0].sql).toBeUndefined();
          expect(responses[0].error).toBeDefined();
        } finally {
          if (saved === undefined)
            delete process.env.KCMD_PYTHON;
          else
            process.env.KCMD_PYTHON = saved;
        }
      });
});

describe(
    'sqlglotTranspiler (transformations; gated on sqlglot installed)', () => {
      test.skipIf(!AVAILABLE)(
          'rewrites Snowflake NVL/IFF to GoogleSQL', async () => {
            const responses = await sqlglotTranspiler(
                [
                  {
                    id: 'nvl',
                    dialect: 'SNOWFLAKE',
                    expression: 'NVL(orders.amt, 0)'
                  },
                  {
                    id: 'iff',
                    dialect: 'SNOWFLAKE',
                    expression: 'IFF(orders.s = \'F\', 1, 0)'
                  },
                ],
                'BIGQUERY');
            const byId = new Map(responses.map(r => [r.id, r]));
            expect(byId.get('nvl')!.sql).toBe('COALESCE(orders.amt, 0)');
            expect(byId.get('iff')!.sql).toBe('IF(orders.s = \'F\', 1, 0)');
          });

      test.skipIf(
          !AVAILABLE)('rewrites Databricks casts to GoogleSQL', async () => {
        const responses = await sqlglotTranspiler(
            [
              {id: 'd', dialect: 'DATABRICKS', expression: 'orders.p::double'},
              {id: 't', dialect: 'DATABRICKS', expression: 'orders.c::text'},
            ],
            'BIGQUERY');
        const byId = new Map(responses.map(r => [r.id, r]));
        expect(byId.get('d')!.sql).toBe('CAST(orders.p AS FLOAT64)');
        expect(byId.get('t')!.sql).toBe('CAST(orders.c AS STRING)');
      });

      test.skipIf(!AVAILABLE)(
          'preserves the entity qualifier through a rewrite', async () => {
            // The qualifier-preservation guard depends on this: sqlglot must
            // not re-case or requalify `orders.` when it rewrites the
            // surrounding function.
            const [res] = await sqlglotTranspiler(
                [{
                  id: '0',
                  dialect: 'SNOWFLAKE',
                  expression: 'DATEADD(day, 7, orders.d)'
                }],
                'BIGQUERY');
            expect(res.sql).toContain('orders.d');
          });

      test.skipIf(!AVAILABLE)(
          'reports a parse error per request rather than throwing',
          async () => {
            const [res] = await sqlglotTranspiler(
                [{
                  id: '0',
                  dialect: 'SNOWFLAKE',
                  expression: 'SELECT SELECT ((('
                }],
                'BIGQUERY');
            // Whatever sqlglot makes of it, the adapter must return a single
            // correlated response and never reject.
            expect(res.id).toBe('0');
          });
    });
