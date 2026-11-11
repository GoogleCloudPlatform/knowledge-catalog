// Tests that push's advice to add a BigQuery text with `kcmd import
// --transpile` names the first error that import would stop on, and that
// following it once that error is fixed clears the advice
// (src/tool/commands.ts, transpileOutcomes, and
// src/libts/semantic/resolve_profiles.ts, transpileAdvice).

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../../src/libts/gcp/context';
import {SpannerClient} from '../../../src/libts/gcp/spanner';
import * as engine from '../../../src/libts/semantic/import_model';
import {importModel, profiles} from '../../../src/tool/commands';

import {bqTable, CTX, CUSTOMER, runPush, Scope, SPANNER_CUSTOMER, writeScope} from './harness';

const snowflake = (text: string) =>
    ({dialects: [{dialect: 'SNOWFLAKE', expression: text}]});
const bigquery = (text: string) =>
    ({dialects: [{dialect: 'BIGQUERY', expression: text}]});
const ORDERS = {
  name: 'Orders',
  source: bqTable('orders'),
  primary_key: ['id'],
  fields: [{name: 'id', expression: 'o_id'}, {name: 'cust', expression: 'o_cust'}],
};
const metric = (text: string, entity?: string) =>
    ({metrics: [{name: 'm', ...entity ? {entity} : {}, expression: snowflake(text)}]});
// Customer with field code, whose text import translates, and `more` fields.
const withCode = (...more: object[]) => ({
  ...CUSTOMER,
  fields: [...CUSTOMER.fields, {name: 'code', expression: snowflake('IFF(TRUE, c_key, 0)')},
           ...more],
});
// Profile prod, which binds Customer with `fields` and Orders as the model
// file does, on tables in dataset prod.
const prod = (fields: object[]) => ({
  prod: {
    entities: {
      Customer: {...CUSTOMER, source: bqTable('customer', 'prod'), fields},
      Orders: {...ORDERS, source: bqTable('orders', 'prod')},
    },
  },
});
const MODEL = "in model 'commerce' (commerce)";
const PROFILE = "[commerce.profile.prod.yaml] profile 'prod':";
const COMMAND = "add one with 'kcmd import <file> --input first-party --flavor google " +
    "--transpile'";
// The warning that `subject` has no BigQuery text, with advice that ends with
// `error`.
const warning = (subject: string, error: string) => `Warning: [commerce] ${
    subject}: no 'BIGQUERY' or 'ANSI_SQL' dialect, so a BIGQUERY table cannot run its ` +
    `'SNOWFLAKE' expression; give it one, or ${COMMAND} after fixing this: ${error}`;
// A profile binding whose only text reads another entity once translated.
const BINDING_TEXT: Scope = {
  entities: [{...CUSTOMER, fields: [...CUSTOMER.fields,
                                    {name: 'code', expression: bigquery('c_code')}]},
             ORDERS],
  profiles: prod([...CUSTOMER.fields,
                  {name: 'code', expression: snowflake('IFF(TRUE, Orders.id, 0)')}]),
};
const BINDING_TEXT_ERROR = `Error: ${PROFILE} field 'Customer.code' has no expression for ` +
    "BIGQUERY or ANSI_SQL, and this profile's sources are BIGQUERY; give it one, or " +
    `${COMMAND} after fixing this: ${PROFILE} field 'Customer.code' reads entity 'Orders'; a ` +
    'field expression reads only its own entity';
const unanchored = (reach: string) => `metric 'm': its expression reaches ${reach}; set ` +
    "'entity' on the metric, or scope its expression to one entity";

let dir = '';
let cwd = '';
beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-transpile-advice-'));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(dir, {recursive: true, force: true});
});

describe('the advice to add a BigQuery text', () => {
  // [label, the scope, a line push prints, the scope once the error it names
  // is fixed]
  test.each([
    ['a bare column', metric('SUM(IFF(TRUE, key, 0))', 'Customer'),
     warning("metric 'm'", `metric 'm' ${MODEL}: 'key' must be written as 'entity.field'; ` +
             'a metric reads fields, never columns'),
     metric('SUM(IFF(TRUE, Customer.key, 0))', 'Customer')],
    ['an undeclared qualifier', metric('SUM(IFF(TRUE, x.key, 0))', 'Customer'),
     warning("metric 'm'", `metric 'm' ${MODEL}: 'x.key' has qualifier 'x', which is not ` +
             "a declared entity in model 'commerce'; write 'entity.field' starting with a " +
             'declared entity'),
     metric('SUM(IFF(TRUE, Customer.key, 0))', 'Customer')],
    ['an anchor the SQL contradicts',
     {entities: [CUSTOMER, ORDERS], ...metric('SUM(IFF(TRUE, Orders.id, 0))', 'Customer')},
     warning("metric 'm'", `metric 'm' ${MODEL} is anchored to entity 'Customer', but its ` +
             "expression only references 'Orders'; the anchor contradicts the SQL"),
     {entities: [CUSTOMER, ORDERS], ...metric('SUM(IFF(TRUE, Orders.id, 0))', 'Orders')}],
    ['an unanchored metric that reaches no entity', metric('IFF(TRUE, COUNT(*), 0)'),
     warning("metric 'm'", unanchored('no declared entity')),
     metric('IFF(TRUE, COUNT(*), 0)', 'Customer')],
    ['an unanchored metric that reaches two entities',
     {entities: [CUSTOMER, ORDERS],
      ...metric('IFF(TRUE, COUNT(Customer.key) + COUNT(Orders.id), 0)')},
     warning("metric 'm'", unanchored('multiple entities (Customer, Orders)')),
     {entities: [CUSTOMER, ORDERS],
      ...metric('IFF(TRUE, COUNT(Customer.key) + COUNT(Orders.id), 0)', 'Customer')}],
    ['a field another field blocks',
     {entities: [withCode({name: 'custom', expression: snowflake('MY_UDF(c_key)')})]},
     warning("field 'Customer.code'", `field 'Customer.custom' ${MODEL} has no expression ` +
             "for BIGQUERY or ANSI_SQL, and the model file binds entity 'Customer' to a " +
             'BIGQUERY source; give it one'),
     {entities: [withCode({name: 'custom', expression: bigquery('c_key')})]}],
    ['the first of two errors',
     {entities: [withCode({name: 'custom', expression: snowflake('MY_UDF(c_key)')})],
      ...metric('SUM(IFF(TRUE, key, 0))', 'Customer')},
     warning("field 'Customer.code'", `field 'Customer.custom' ${MODEL} has no expression ` +
             "for BIGQUERY or ANSI_SQL, and the model file binds entity 'Customer' to a " +
             'BIGQUERY source; give it one'),
     {entities: [withCode({name: 'custom', expression: bigquery('c_key')})],
      ...metric('SUM(IFF(TRUE, Customer.key, 0))', 'Customer')}],
    ['a relationship key error',
     {entities: [withCode(), ORDERS], relationships: [{
       name: 'placed', from: 'Orders', to: 'Customer', from_columns: ['o_cust'],
       to_columns: ['c_name'],
     }]},
     warning("field 'Customer.code'", `relationship 'placed' ${MODEL}: its to_columns ` +
             `["c_name"] cover no primary or unique key of 'Customer'; join on every ` +
             "column of one of its keys, and declare that key if 'Customer' has none"),
     {entities: [withCode(), ORDERS], relationships: [{
       name: 'placed', from: 'Orders', to: 'Customer', from_columns: ['o_cust'],
       to_columns: ['key'],
     }]}],
    ['a profile binding\'s own text', BINDING_TEXT, BINDING_TEXT_ERROR,
     {entities: [{...CUSTOMER, fields: [...CUSTOMER.fields,
                                        {name: 'code', expression: bigquery('c_code')}]},
                 ORDERS],
      profiles: prod([...CUSTOMER.fields,
                      {name: 'code', expression: snowflake('IFF(TRUE, c_code, 0)')}])}],
    ['profile fields left unbound',
     {entities: [{...CUSTOMER, fields: [...CUSTOMER.fields,
                                        {name: 'note', expression: 'c_note'}]},
                 ORDERS],
      ...metric('SUM(IFF(TRUE, Customer.key, 0))', 'Customer'),
      profiles: prod(CUSTOMER.fields)},
     warning("metric 'm'", `${PROFILE} field 'Customer.note' reads column 'c_note' ` +
             "through its model file expression; bind it in 'fields' for this profile, or " +
             "leave it out in 'fields_exclude'"),
     {entities: [{...CUSTOMER, fields: [...CUSTOMER.fields,
                                        {name: 'note', expression: 'c_note'}]},
                 ORDERS],
      ...metric('SUM(IFF(TRUE, Customer.key, 0))', 'Customer'),
      profiles: prod([...CUSTOMER.fields, {name: 'note', expression: 'c_note'}])}],
  ] as Array<[string, Scope, string, Scope]>)('names %s, and works once it is fixed',
      async (_, scope, line, fixed) => {
        writeScope(dir, scope);
        const first = await runPush({}, {validateOnly: true});
        expect([...first.errors, ...first.warnings]).toContain(line);
        writeScope(dir, fixed);
        expect(await importModel('catalog/EntryGroups/commerce_eg/commerce.yaml',
                                 {flavor: 'google', input: 'first-party', transpile: true}))
            .toBe(0);
        const after = await runPush({}, {validateOnly: true});
        expect(after.code).toBe(0);
        expect([...after.errors, ...after.warnings].join('\n')).not.toContain(COMMAND);
      });

  // Runs `kcmd profiles` with `flags`. Gives its exit code, the lines it
  // prints and how many times it ran the import engine.
  const report = async (flags: Parameters<typeof profiles>[0]) => {
    mock.restore();
    spyOn(ApiContext, 'default').mockReturnValue(CTX);
    spyOn(SpannerClient.prototype, 'getDatabase').mockResolvedValue(
        {status: 200, result: {databaseDialect: 'GOOGLE_STANDARD_SQL'}} as any);
    const imports = spyOn(engine, 'importSemanticModelYaml');
    const lines: string[] = [];
    for (const stream of ['error', 'warn', 'log'] as const) {
      spyOn(console, stream).mockImplementation((...a: unknown[]) => {
        lines.push(a.join(' '));
      });
    }
    const code = await profiles(flags);
    const runs = imports.mock.calls.length;
    mock.restore();
    return {code, lines, runs};
  };

  test('names the same error in kcmd profiles --print-store', async () => {
    writeScope(dir, BINDING_TEXT);
    const {code, lines} = await report({printStore: true, profile: 'prod'});
    expect(code).toBe(1);
    expect(lines).toContain(BINDING_TEXT_ERROR);
  });

  // Only a message about a BigQuery table gives the advice, so a command runs
  // the import only for a model file with a BigQuery table.
  test.each([
    ['runs no import for a model file with no BigQuery table',
     {entities: [{...CUSTOMER, source: SPANNER_CUSTOMER, fields: [{
       name: 'key', expression: {dialects: [{dialect: 'SPANNER', expression: 'c_key'}]},
     }]}]},
     0],
    ['runs the import once for a model file with a BigQuery table', {entities: [withCode()]}, 1],
  ] as Array<[string, Scope, number]>)('%s', async (_, scope, runs) => {
    writeScope(dir, scope);
    expect((await report({})).runs).toBe(runs);
  });
});
