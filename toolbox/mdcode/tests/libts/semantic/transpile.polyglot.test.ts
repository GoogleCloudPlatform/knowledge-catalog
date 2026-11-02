// Tests for the default transpilation MECHANISM (the polyglotTranspiler adapter
// in src/libts/semantic/transpile.ts).
//
// The engine is the @polyglot-sql/sdk Rust/WASM blob bundled into the tool, so
// there is no external dependency and these tests run everywhere -- both the
// invariants and the real Snowflake/Databricks -> GoogleSQL transformations.
// The adapter is still designed to never throw: an unsupported source dialect
// or an unparseable expression degrades to a per-request `error`.

import {describe, expect, test} from 'bun:test';

import {polyglotTranspiler, transpileModel} from '../../../src/libts/semantic/transpile';

describe('polyglotTranspiler (mechanism invariants)', () => {
  test(
      'returns exactly one response per request, correlated by id',
      async () => {
        const requests = [
          {id: 'a', dialect: 'SNOWFLAKE', expression: 'NVL(x, 0)'},
          {id: 'b', dialect: 'DATABRICKS', expression: 'x::double'},
        ];
        const responses = await polyglotTranspiler(requests, 'BIGQUERY');
        expect(responses.length).toBe(2);
        expect(new Set(responses.map(r => r.id))).toEqual(new Set(['a', 'b']));
        // Each response is exactly one of sql|error, never both, never neither.
        for (const r of responses) {
          expect((r.sql === undefined) !== (r.error === undefined)).toBe(true);
        }
      });

  test('resolves to an empty array for no requests', async () => {
    expect(await polyglotTranspiler([], 'BIGQUERY')).toEqual([]);
  });

  test(
      'degrades to a per-request error (never throws) for an unsupported ' +
          'source dialect',
      async () => {
        for (const unsupported
                 of ['NOT_A_DIALECT',
                     'SPARK',
                     'POSTGRESQL',
                     'TERADATA',
                     'PRESTO',
                     'TRINO',
                     'DUCKDB',
                     'REDSHIFT',
                     'ORACLE',
                     'TSQL',
        ]) {
          const responses = await polyglotTranspiler(
              [{id: '0', dialect: unsupported, expression: 'NVL(x, 0)'}],
              'BIGQUERY');
          expect(responses.length).toBe(1);
          expect(responses[0].sql).toBeUndefined();
          expect(responses[0].error)
              .toContain(`unsupported source dialect '${unsupported}'`);
        }
      });

  test(
      'translates SPANNER (as BigQuery), ALLOYDB (as PostgreSQL), and ' +
          'SQLSERVER (as T-SQL)',
      async () => {
        const responses = await polyglotTranspiler(
            [
              {
                id: 'spanner',
                dialect: 'SPANNER',
                expression: 'IF(orders.s = 1, 1, 0)',
              },
              {
                id: 'alloydb',
                dialect: 'ALLOYDB',
                expression: '"orders"."amount"::text',
              },
              {
                id: 'sqlserver',
                dialect: 'SQLSERVER',
                expression: 'ISNULL([orders].[amount], 0)',
              },
            ],
            'BIGQUERY');
        const byId = new Map(responses.map(r => [r.id, r]));
        expect(byId.get('spanner')!.sql).toBe('IF(orders.s = 1, 1, 0)');
        expect(byId.get('alloydb')!.sql)
            .toBe('CAST(`orders`.`amount` AS STRING)');
        expect(byId.get('sqlserver')!.sql)
            .toBe('COALESCE(`orders`.`amount`, 0)');
      });

  test(
      'warns that SQL Server text is translated on a best-effort basis',
      async () => {
        // The engine gets common T-SQL forms wrong without an error (a CONVERT
        // style, DATEDIFF(dd, ...), DATEPART, N'' strings), so translating
        // SQLSERVER text warns the user to check the BIGQUERY entry.
        const {model, warnings} = await transpileModel({
          name: 'sales',
          entities: [{
            name: 'orders',
            dataSource: 'p.d.orders',
            keys: ['id'],
            fields: [{
              name: 'd',
              dialects:
                  [{dialect: 'SQLSERVER', expression: 'ISNULL(orders.d, 0)'}],
              stringForm: false,
            }],
          }],
          relationships: [],
          metrics: [],
        });
        expect(model.entities[0].fields[0].dialects).toEqual([
          {dialect: 'SQLSERVER', expression: 'ISNULL(orders.d, 0)'},
          {dialect: 'BIGQUERY', expression: 'COALESCE(orders.d, 0)'},
        ]);
        expect(warnings).toEqual([
          'field \'orders.d\': transpiled \'SQLSERVER\' -> \'BIGQUERY\'',
          'field \'orders.d\': SQL Server text is translated to BigQuery on a ' +
              'best-effort basis, and the translator can get some T-SQL wrong; ' +
              'check the BIGQUERY entry.',
        ]);
      });

  test(
      'translates double-quoted identifiers in vendor and ANSI_SQL text to ' +
          'BigQuery backticks while keeping string literals intact',
      async () => {
        const responses = await polyglotTranspiler(
            [
              {
                id: 'vendor',
                dialect: 'SNOWFLAKE',
                expression: 'SUM("orders"."col")',
              },
              {
                id: 'ansi',
                dialect: 'ANSI_SQL',
                expression: '"orders"."col"',
              },
              {
                id: 'lit',
                dialect: 'ANSI_SQL',
                expression: `'a "quoted" string'`,
              },
            ],
            'BIGQUERY');
        const byId = new Map(responses.map(r => [r.id, r]));
        expect(byId.get('vendor')!.sql).toBe('SUM(`orders`.`col`)');
        expect(byId.get('ansi')!.sql).toBe('`orders`.`col`');
        expect(byId.get('lit')!.sql).toBe(`'a "quoted" string'`);
      });

  test(
      'errors every request for an unsupported target dialect rather than ' +
          'silently emitting BigQuery',
      async () => {
        const responses = await polyglotTranspiler(
            [
              {id: 'a', dialect: 'SNOWFLAKE', expression: 'NVL(x, 0)'},
              {id: 'b', dialect: 'DATABRICKS', expression: 'x::double'},
            ],
            'NOT_A_DIALECT');
        expect(responses.length).toBe(2);
        for (const r of responses) {
          expect(r.sql).toBeUndefined();
          expect(r.error).toContain('unsupported target dialect');
        }
      });
});

describe('polyglotTranspiler (transformations)', () => {
  test('rewrites Snowflake NVL/IFF to GoogleSQL', async () => {
    const responses = await polyglotTranspiler(
        [
          {id: 'nvl', dialect: 'SNOWFLAKE', expression: 'NVL(orders.amt, 0)'},
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

  test('rewrites Databricks casts to GoogleSQL', async () => {
    const responses = await polyglotTranspiler(
        [
          {id: 'd', dialect: 'DATABRICKS', expression: 'orders.p::double'},
          {id: 't', dialect: 'DATABRICKS', expression: 'orders.c::text'},
        ],
        'BIGQUERY');
    const byId = new Map(responses.map(r => [r.id, r]));
    expect(byId.get('d')!.sql).toBe('SAFE_CAST(orders.p AS FLOAT64)');
    expect(byId.get('t')!.sql).toBe('SAFE_CAST(orders.c AS STRING)');
  });

  test('preserves the entity qualifier through a rewrite', async () => {
    // The qualifier-preservation guard depends on this: the engine must not
    // re-case or requalify `orders.` when it rewrites the surrounding function.
    const [res] = await polyglotTranspiler(
        [{
          id: '0',
          dialect: 'SNOWFLAKE',
          expression: 'DATEADD(day, 7, orders.d)'
        }],
        'BIGQUERY');
    expect(res.sql).toContain('orders.d');
  });

  test(
      'targets ANSI_SQL as dialect-neutral, not silently BigQuery',
      async () => {
        // ANSI_SQL maps to the engine's neutral 'generic' dialect; it must not
        // be clobbered to BigQuery. `::double` renders as the generic
        // `CAST(... AS DOUBLE)` under ANSI, vs `SAFE_CAST(... AS FLOAT64)`
        // under BigQuery.
        const [ansi] = await polyglotTranspiler(
            [{id: '0', dialect: 'DATABRICKS', expression: 'x::double'}],
            'ANSI_SQL');
        expect(ansi.sql).toBe('CAST(x AS DOUBLE)');
        const [bq] = await polyglotTranspiler(
            [{id: '0', dialect: 'DATABRICKS', expression: 'x::double'}],
            'BIGQUERY');
        expect(bq.sql).toBe('SAFE_CAST(x AS FLOAT64)');
      });

  test('reports a parse error per request rather than throwing', async () => {
    const [res] = await polyglotTranspiler(
        [{id: '0', dialect: 'SNOWFLAKE', expression: 'SELECT SELECT ((('}],
        'BIGQUERY');
    // Whatever the engine makes of it, the adapter must return a single
    // correlated response and never reject.
    expect(res.id).toBe('0');
    expect(res.error).toBeDefined();
  });
});
