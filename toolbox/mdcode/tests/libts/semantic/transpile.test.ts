// Hermetic tests for the transpile pass (src/libts/semantic/transpile.ts).
//
// These never invoke sqlglot: the transpilation MECHANISM is injected as a fake
// SqlTranspiler, so the tests pin the pass's own logic -- which nodes it
// selects, how it applies results, the qualifier-preservation guard, graceful
// degradation, and non-mutation -- independent of any external engine. The real
// sqlglot adapter is exercised separately in transpile.sqlglot.test.ts (gated
// on the dependency being installed) and end-to-end in transpile.e2e.test.ts.

import {describe, expect, test} from 'bun:test';

import {SemanticModel} from '../../../src/libts/semantic/ir';
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
    const {transpiler} = fakeTranspiler(() => 'IF(orders.s = 1, 1, 0)');
    const {model, warnings} = await transpileModel(baseModel(), {transpiler});

    const label = model.entities[0].fields[1];
    expect(label.expression).toBe('IF(orders.s = 1, 1, 0)');
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
        expect(warnings.some(w => w.includes('no result returned'))).toBe(true);
      });

  test(
      'rejects a rewrite that changes the referenced entities (guard)',
      async () => {
        // Re-casing the qualifier (`orders.` -> `Orders.`) would make the
        // case-sensitive emitter miss the reference; the guard must keep it
        // verbatim.
        const {transpiler} = fakeTranspiler(() => 'SUM(Orders.amt)');
        const {model, warnings} =
            await transpileModel(baseModel(), {transpiler});

        const rev = model.metrics[0];
        expect(rev.expression).toBeUndefined();
        expect(rev.importedExpression).toBe('SUM(orders.amt)');
        expect(warnings.some(
                   w => w.includes(`metric 'rev'`) &&
                       w.includes('altered the referenced entities')))
            .toBe(true);
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

    expect(model.relationships[0].association!.fields![0].expression)
        .toBe('IF(g > 0, g, 0)');
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
        expect(out.entities[0].fields[0].expression)
            .toBe('IF(orders.s = 1, 1, 0)');
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
        await transpileModel(baseModel(), {transpiler, target: 'SPARK'});
        expect(sawTarget).toBe('SPARK');
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
        expect(models[0].model.entities[0].fields[1].expression)
            .toBe('IF(orders.s = 1, 1, 0)');
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
