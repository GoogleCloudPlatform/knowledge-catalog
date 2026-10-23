// Hermetic tests for the transpile pass (src/libts/semantic/transpile.ts).
//
// These never invoke the real engine: the transpilation MECHANISM is injected
// as a fake SqlTranspiler, so the tests pin the pass's own logic -- which nodes
// it selects, how it applies results, the qualifier-preservation guard,
// graceful degradation, and non-mutation -- independent of any engine. The real
// @polyglot-sql/sdk adapter is exercised separately in
// transpile.polyglot.test.ts and end-to-end in transpile.e2e.test.ts.

import {describe, expect, spyOn, test} from 'bun:test';

import {Field, SemanticModel} from '../../../src/libts/semantic/ir';
import * as sqlParser from '../../../src/libts/semantic/sql_parser';
import {SqlTranspiler, transpileModel, transpileModels, TranspileRequest,} from '../../../src/libts/semantic/transpile';

// Builds a one-entity, one-metric model whose interesting fields/metric carry
// only an imported (vendor) form, so the pass has something to fill. Extra
// entities/fields/metrics can be layered on by the caller.
function baseModel(): SemanticModel {
  return {
    name: 'm',
    entities: [{
      name: 'orders',
      dataSource: 'p.d.orders',
      keys: ['id'],
      fields: [
        {name: 'id', expression: 'id'},  // already target
        {
          name: 'label',
          importedExpression: 'IFF(orders.s=1,1,0)',
          importedDialect: 'SNOWFLAKE'
        },
      ],
    }],
    relationships: [],
    metrics: [
      {
        name: 'rev',
        importedExpression: 'SUM(orders.amt)',
        importedDialect: 'SNOWFLAKE',
        entity: 'orders'
      },
    ],
  };
}

// Builds a single-entity (`orders`) model with `fields` and no metrics.
function modelWithFields(...fields: Field[]): SemanticModel {
  return {
    name: 'm',
    entities:
        [{name: 'orders', dataSource: 'p.d.orders', keys: ['id'], fields}],
    relationships: [],
    metrics: [],
  };
}

// A fake transpiler that maps each request's expression through `map` (identity
// by default) and records what it was asked to transpile.
function fakeTranspiler(
    map: (expr: string, req: TranspileRequest) => string = e =>
        e): {transpiler: SqlTranspiler; seen: TranspileRequest[]} {
  const seen: TranspileRequest[] = [];
  const transpiler: SqlTranspiler = async requests => {
    for (const r of requests) seen.push(r);
    return requests.map(r => ({id: r.id, sql: map(r.expression, r)}));
  };
  return {transpiler, seen};
}

describe('transpileModel', () => {
  test('fills a missing target expression from the imported form', async () => {
    const loadSpy = spyOn(sqlParser, 'loadSqlEngine');
    const {transpiler} = fakeTranspiler(() => 'IF(orders.s = 1, 1, 0)');
    const {model, warnings} = await transpileModel(baseModel(), {transpiler});

    expect(loadSpy).toHaveBeenCalledTimes(1);
    loadSpy.mockRestore();
    const label = model.entities[0].fields[1];
    expect(label.dialects).toEqual([
      {dialect: 'BIGQUERY', expression: 'IF(orders.s = 1, 1, 0)'},
    ]);
    expect(label.stringForm).toBe(false);
    expect(label.expression).toBeUndefined();
    // The imported form is retained (round-trip fidelity; the KC leg may emit
    // it).
    expect(label.importedExpression).toBe('IFF(orders.s=1,1,0)');
    expect(label.importedDialect).toBe('SNOWFLAKE');
    expect(warnings).toContain(
        `field 'orders.label': transpiled 'SNOWFLAKE' -> 'BIGQUERY'`);
  });

  test(
      'leaves a node that already has a target expression untouched',
      async () => {
        const {transpiler, seen} = fakeTranspiler(() => 'MANGLED');
        const {model} = await transpileModel(baseModel(), {transpiler});

        // `id` already had `expression`, so it is neither sent to the
        // transpiler nor rewritten.
        expect(model.entities[0].fields[0].expression).toBe('id');
        expect(seen.some(r => r.expression === 'id')).toBe(false);
      });

  test('never invokes the transpiler when nothing needs it', async () => {
    let called = false;
    const transpiler: SqlTranspiler = async reqs => {
      called = true;
      return reqs.map(r => ({id: r.id, sql: r.expression}));
    };
    const allTarget: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'e',
        dataSource: 'p.d.e',
        keys: ['id'],
        fields: [{name: 'id', expression: 'id'}]
      }],
      relationships: [],
      metrics: [],
    };
    const {warnings} = await transpileModel(allTarget, {transpiler});
    expect(called).toBe(false);
    expect(warnings).toEqual([]);
  });

  test(
      'leaves the expression unset and warns when transpilation errors',
      async () => {
        const transpiler: SqlTranspiler = async reqs =>
            reqs.map(r => ({id: r.id, error: 'boom'}));
        const {model, warnings} =
            await transpileModel(baseModel(), {transpiler});

        const label = model.entities[0].fields[1];
        expect(label.expression).toBeUndefined();
        expect(label.dialects).toBeUndefined();
        expect(label.importedExpression)
            .toBe('IFF(orders.s=1,1,0)');  // still there for the emitter
        expect(warnings.some(
                   w => w.includes(`field 'orders.label'`) &&
                       w.includes('could not transpile') && w.includes('boom')))
            .toBe(true);
      });

  test(
      'leaves the expression unset and warns when no result is returned',
      async () => {
        // A mechanism that drops a request entirely (returns fewer responses).
        const transpiler: SqlTranspiler = async () => [];
        const {model, warnings} =
            await transpileModel(baseModel(), {transpiler});
        expect(model.entities[0].fields[1].expression).toBeUndefined();
        expect(model.entities[0].fields[1].dialects).toBeUndefined();
        expect(warnings.some(w => w.includes('no result returned'))).toBe(true);
      });

  test(
      'rejects a rewrite that re-cases an entity qualifier (guard)',
      async () => {
        // Re-casing the qualifier (`orders.` -> `Orders.`) would make the
        // case-sensitive emitter miss the reference; the guard must keep it
        // verbatim.
        const {transpiler} = fakeTranspiler(() => 'SUM(Orders.amt)');
        const {model, warnings} =
            await transpileModel(baseModel(), {transpiler});

        const rev = model.metrics[0];
        expect(rev.expression).toBeUndefined();
        expect(rev.dialects).toBeUndefined();
        expect(rev.importedExpression).toBe('SUM(orders.amt)');
        expect(warnings.some(
                   w => w.includes(`metric 'rev'`) &&
                       w.includes('re-cased an entity qualifier')))
            .toBe(true);
      });

  test(
      'accepts a correct rewrite even when the vendor form quoted the ' +
          'qualifier (no false reject)',
      async () => {
        // The imported Snowflake form double-quotes the qualifier
        // (`"orders".amt`); blankStringLiterals treats double-quotes as a
        // string literal, so an input-vs-output guard would see the qualifier
        // vanish and wrongly reject a perfectly good rewrite. The guard now
        // checks the output against itself, so the valid GoogleSQL is accepted.
        const model: SemanticModel = {
          name: 'm',
          entities: [{
            name: 'orders',
            dataSource: 'p.d.orders',
            keys: ['id'],
            fields: [{
              name: 'amt_known',
              importedExpression: 'NVL("orders".amt, 0)',
              importedDialect: 'SNOWFLAKE',
            }],
          }],
          relationships: [],
          metrics: [],
        };
        const {transpiler} = fakeTranspiler(() => 'COALESCE(orders.amt, 0)');
        const {model: out, warnings} =
            await transpileModel(model, {transpiler});

        expect(out.entities[0].fields[0].dialects).toEqual([
          {dialect: 'BIGQUERY', expression: 'COALESCE(orders.amt, 0)'},
        ]);
        expect(out.entities[0].fields[0].stringForm).toBe(false);
        expect(warnings.some(w => w.includes('transpiled'))).toBe(true);
        expect(warnings.some(w => w.includes('re-cased'))).toBe(false);
      });

  test('does not mutate the input model', async () => {
    const input = baseModel();
    const snapshot = structuredClone(input);
    const {transpiler} = fakeTranspiler(() => 'REWRITTEN');
    await transpileModel(input, {transpiler});
    expect(input).toEqual(snapshot);
  });

  test('transpiles association (junction) edge-property fields', async () => {
    const withAssoc: SemanticModel = {
      name: 'm',
      entities: [
        {name: 'student', dataSource: 'p.d.student', keys: ['sid'], fields: []},
        {name: 'course', dataSource: 'p.d.course', keys: ['cid'], fields: []},
      ],
      relationships: [{
        name: 'enrollment',
        source: {entity: 'student', columns: ['sid']},
        destination: {entity: 'course', columns: ['cid']},
        association: {
          dataSource: 'p.d.enrollment',
          keys: ['eid'],
          sourceColumns: ['sid'],
          destinationColumns: ['cid'],
          fields: [{
            name: 'grade',
            importedExpression: 'IFF(g>0,g,0)',
            importedDialect: 'SNOWFLAKE'
          }],
        },
      }],
      metrics: [],
    };
    const {transpiler} = fakeTranspiler(() => 'IF(g > 0, g, 0)');
    const {model, warnings} = await transpileModel(withAssoc, {transpiler});

    expect(model.relationships[0].association!.fields![0].dialects).toEqual([
      {dialect: 'BIGQUERY', expression: 'IF(g > 0, g, 0)'},
    ]);
    expect(model.relationships[0].association!.fields![0].stringForm)
        .toBe(false);
    expect(warnings.some(
               w => w.includes(`relationship 'enrollment' field 'grade'`) &&
                   w.includes('transpiled')))
        .toBe(true);
  });

  test(
      'passes the source dialect and expression through to the mechanism',
      async () => {
        const {transpiler, seen} = fakeTranspiler();
        await transpileModel(baseModel(), {transpiler});
        const label = seen.find(r => r.expression === 'IFF(orders.s=1,1,0)');
        expect(label?.dialect).toBe('SNOWFLAKE');
        const rev = seen.find(r => r.expression === 'SUM(orders.amt)');
        expect(rev?.dialect).toBe('SNOWFLAKE');
      });

  test(
      'defaults a missing source dialect to ANSI_SQL instead of crashing',
      async () => {
        // Hand-built IR can carry an imported expression with no declared
        // dialect. The pass must still transpile it (as portable ANSI) rather
        // than passing `undefined` into the mechanism.
        const model: SemanticModel = {
          name: 'm',
          entities: [{
            name: 'orders',
            dataSource: 'p.d.orders',
            keys: ['id'],
            fields:
                [{name: 'label', importedExpression: 'IFF(orders.s=1,1,0)'}],
          }],
          relationships: [],
          metrics: [],
        };
        const {transpiler, seen} =
            fakeTranspiler(() => 'IF(orders.s = 1, 1, 0)');
        const {model: out, warnings} =
            await transpileModel(model, {transpiler});

        const req = seen.find(r => r.expression === 'IFF(orders.s=1,1,0)');
        expect(req?.dialect).toBe('ANSI_SQL');
        expect(out.entities[0].fields[0].dialects).toEqual([
          {dialect: 'BIGQUERY', expression: 'IF(orders.s = 1, 1, 0)'},
        ]);
        expect(warnings.some(w => w.includes(`field 'orders.label'`)))
            .toBe(true);
      });

  test(
      'treats an empty source dialect as ANSI_SQL, not an unsupported dialect',
      async () => {
        // An importer may leave importedDialect as '' rather than undefined.
        // `?? 'ANSI_SQL'` would keep the empty string and the adapter would
        // report it unsupported; `|| 'ANSI_SQL'` (the fix) falls back to ANSI.
        const model: SemanticModel = {
          name: 'm',
          entities: [{
            name: 'orders',
            dataSource: 'p.d.orders',
            keys: ['id'],
            fields: [{
              name: 'label',
              importedExpression: 'IFF(orders.s=1,1,0)',
              importedDialect: '',
            }],
          }],
          relationships: [],
          metrics: [],
        };
        const {transpiler, seen} =
            fakeTranspiler(() => 'IF(orders.s = 1, 1, 0)');
        const {model: out, warnings} =
            await transpileModel(model, {transpiler});

        const req = seen.find(r => r.expression === 'IFF(orders.s=1,1,0)');
        expect(req?.dialect).toBe('ANSI_SQL');
        expect(out.entities[0].fields[0].dialects).toEqual([
          {dialect: 'BIGQUERY', expression: 'IF(orders.s = 1, 1, 0)'},
        ]);
        expect(warnings.some(w => w.includes(`field 'orders.label'`)))
            .toBe(true);
      });

  test(
      'honors a non-default target dialect passed through to the mechanism',
      async () => {
        let sawTarget = '';
        const transpiler: SqlTranspiler = async (reqs, target) => {
          sawTarget = target;
          return reqs.map(r => ({id: r.id, sql: r.expression}));
        };
        await transpileModel(baseModel(), {transpiler, target: 'POSTGRES'});
        expect(sawTarget).toBe('POSTGRES');
      });

  test(
      'qualifier guard does not mistake a struct subfield for a re-cased entity qualifier',
      async () => {
        const m: SemanticModel = {
          name: 'sales',
          entities: [
            {
              name: 'orders',
              dataSource: 'p.d.orders',
              keys: ['o_id'],
              fields: [{name: 'customer', expression: 'orders.customer'}],
            },
            {
              name: 'customer',
              dataSource: 'p.d.customer',
              keys: ['c_id'],
              fields: [{name: 'id', expression: 'customer.c_id'}],
            },
          ],
          relationships: [],
          metrics: [{
            name: 'cust_count',
            importedExpression: 'COUNT(orders.Customer.id)',
            importedDialect: 'SNOWFLAKE',
            entity: 'orders',
          }],
        };
        const {model: out, warnings} = await transpileModel(m, {
          transpiler: async reqs =>
              reqs.map(r => ({id: r.id, sql: 'COUNT(orders.Customer.id)'})),
        });
        expect(out.metrics[0].dialects).toEqual([
          {dialect: 'BIGQUERY', expression: 'COUNT(orders.Customer.id)'},
        ]);
        expect(warnings.some(w => w.includes('re-cased'))).toBe(false);
      });

  test(
      'warns and keeps transpiled SQL when the qualifier check cannot parse the transpiled output',
      async () => {
        const {model: out, warnings} = await transpileModel(baseModel(), {
          transpiler: async reqs =>
              reqs.map(r => ({id: r.id, sql: 'SUM(orders.amt'})),
        });
        expect(out.metrics[0].dialects).toEqual([
          {dialect: 'BIGQUERY', expression: 'SUM(orders.amt'},
        ]);
        expect(warnings.some(
                   w => w.includes(`metric 'rev'`) &&
                       w.includes('could not be parsed; qualifier check was skipped')))
            .toBe(true);
      });

  test(
      'adds a BIGQUERY entry after existing dialect entries and clears stringForm',
      async () => {
        const model = modelWithFields(
            {
              name: 'label',
              dialects: [
                {dialect: 'SNOWFLAKE', expression: 'IFF(orders.s=1,1,0)'},
              ],
              stringForm: false,
              importedExpression: 'IFF(orders.s=1,1,0)',
              importedDialect: 'SNOWFLAKE',
            },
            {name: 'unbound'});
        const {transpiler} = fakeTranspiler(() => 'IF(orders.s = 1, 1, 0)');
        const {model: out} = await transpileModel(model, {transpiler});

        const label = out.entities[0].fields[0];
        expect(label.dialects).toEqual([
          {dialect: 'SNOWFLAKE', expression: 'IFF(orders.s=1,1,0)'},
          {dialect: 'BIGQUERY', expression: 'IF(orders.s = 1, 1, 0)'},
        ]);
        expect(label.stringForm).toBe(false);
        expect(label.expression).toBeUndefined();
      });

  test(
      'queues an ANSI_SQL entry only when it double-quotes a column name and has no BIGQUERY entry',
      async () => {
        for (const expr
                 of ['"orders"."order_amount"',
                     'orders."order_amount"',
                     '"orders".order_amount',
                     '"order_amount"',
                     'SUM("orders"."order_amount")',
                     'COALESCE("orders"."order_amount", 0)',
                     'Time."hour"',
        ]) {
          const model = modelWithFields(
              {
                name: 'amt',
                expression: expr,
                dialects: [{dialect: 'ANSI_SQL', expression: expr}],
                stringForm: true,
              },
              {name: 'bare_ir', expression: expr});
          const {transpiler, seen} =
              fakeTranspiler(() => '`orders`.`order_amount`');
          const {model: out} = await transpileModel(model, {transpiler});
          const amt = out.entities[0].fields[0];
          expect(seen).toEqual([
            {id: '0', dialect: 'ANSI_SQL', expression: expr},
            {id: '1', dialect: 'ANSI_SQL', expression: expr},
          ]);
          expect(amt.dialects).toEqual([
            {dialect: 'ANSI_SQL', expression: expr},
            {dialect: 'BIGQUERY', expression: '`orders`.`order_amount`'},
          ]);
          expect(amt.stringForm).toBe(false);
          expect(amt.expression).toBe(expr);
        }

        for (const expr
                 of ['orders.order_amount',
                     `'a "quoted" string'`,
                     '`orders`.`order_amount`',
                     '`orders`.note = \'a "quoted" string\'',
                     '`orders`.`note` = \'a "quoted" ` string\'',
                     'orders.order_amount -- "orders"."order_amount"',
        ]) {
          const model = modelWithFields(
              {
                name: 'plain',
                expression: expr,
                dialects: [{dialect: 'ANSI_SQL', expression: expr}],
                stringForm: true,
              },
              {
                name: 'already_bq',
                expression: '`orders`.`order_amount`',
                dialects: [
                  {dialect: 'ANSI_SQL', expression: '"orders"."order_amount"'},
                  {dialect: 'BIGQUERY', expression: '`orders`.`order_amount`'},
                ],
                stringForm: false,
              });
          const {transpiler, seen} = fakeTranspiler();
          const {model: out} = await transpileModel(model, {transpiler});
          expect(seen).toEqual([]);
          expect(out.entities[0].fields[0].dialects).toEqual([
            {dialect: 'ANSI_SQL', expression: expr}
          ]);
          expect(out.entities[0].fields[0].stringForm).toBe(true);
        }
      });
});

describe('transpileModels', () => {
  test(
      'transpiles each model and prefixes warnings with the document',
      async () => {
        const {transpiler} = fakeTranspiler(() => 'IF(orders.s = 1, 1, 0)');
        const {models, warnings} = await transpileModels(
            [{document: 'sales.yaml', model: baseModel()}], {transpiler});

        expect(models[0].document).toBe('sales.yaml');
        expect(models[0].model.entities[0].fields[1].dialects).toEqual([
          {dialect: 'BIGQUERY', expression: 'IF(orders.s = 1, 1, 0)'},
        ]);
        expect(
            warnings.some(
                w => w.startsWith('[sales.yaml] ') && w.includes('transpiled')))
            .toBe(true);
      });

  test('does not mutate the input LoadedModel array', async () => {
    const input = [{document: 'a.yaml', model: baseModel()}];
    const snapshot = structuredClone(input);
    const {transpiler} = fakeTranspiler(() => 'REWRITTEN');
    await transpileModels(input, {transpiler});
    expect(input).toEqual(snapshot);
  });
});
