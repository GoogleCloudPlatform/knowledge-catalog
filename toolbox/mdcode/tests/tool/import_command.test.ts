// Tests for `kcmd import` (importModel in src/tool/commands.ts, b/568397111).
// The import engine is the real one, so its answers are faithful; a
// spy that calls through checks what the command passes it. Some cases that
// need more than one output file stub the engine with the shape
// serializeModelFiles gives a model with a profile: `<model>.yaml` and
// `<model>.profile.<name>.yaml`.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as kcmd from '../../src/libts';
import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient} from '../../src/libts/gcp/dataplex';
import {SpannerClient} from '../../src/libts/gcp/spanner';
import * as engine from '../../src/libts/semantic/import_model';
import {Sources} from '../../src/libts/source';
import {ImportCommandOptions, importModel} from '../../src/tool/commands';

const PREFIX = 'bigquery.googleapis.com/projects/acme/datasets/sales';
// A vanilla model the engine imports as it is.
const MODEL = `version: "0.2.0.dev0"
semantic_model:
  - name: retail
    datasets:
      - name: orders
        source: SOURCE
        primary_key: [order_id]
        fields:
          - name: order_id
            expression:
              dialects: [{dialect: BIGQUERY, expression: order_id}]
`;
const model = (source = `${PREFIX}/tables/orders`) =>
    MODEL.replace('SOURCE', source);
// The default model as a Google-flavor file.
const google = model().replace('version: "0.2.0.dev0"', 'version: "0.2.0.dev0/google"')
                   .replace('    datasets:\n', '    entities:\n');

let dir = '';
let cwd = '';
let errors: string[] = [];
let warnings: string[] = [];

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-import-'));
  process.chdir(dir);
  errors = [];
  warnings = [];
  spyOn(console, 'log').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(' '));
  });
  spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warnings.push(a.map(String).join(' '));
  });
  spyOn(ApiContext, 'default')
      .mockReturnValue(new ApiContext('test-project', 'us', 'test-token'));
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
});

afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(dir, {recursive: true, force: true});
  mock.restore();
});

// Writes `text` to `name` in the test directory.
function write(name: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, name)), {recursive: true});
  fs.writeFileSync(path.join(dir, name), text);
}
// Every file under `sub`, relative to it, sorted.
const filesIn = (sub = '.') =>
    fs.existsSync(path.join(dir, sub)) ?
    (fs.readdirSync(path.join(dir, sub), {recursive: true}) as string[])
        .filter(f => fs.statSync(path.join(dir, sub, f)).isFile())
        .sort() :
    [];
// A semantic-model workspace with entry group sales, whose model files live
// in catalog/EntryGroups/sales/.
function workspace(): void {
  write('catalog.yaml', 'scope: semantic-model.test-project.us.sales\n');
  fs.mkdirSync(path.join(dir, 'catalog', 'EntryGroups', 'sales'), {recursive: true});
}
const GROUP = path.join('catalog', 'EntryGroups', 'sales');
// The engine's own output for `text` under `opts`.
const imported = async (text: string, opts: engine.ImportSemanticModelOptions) =>
    (await engine.importSemanticModelYaml(text, opts)).files;

describe('kcmd import', () => {
  // [label, options, file exists, error]
  const REFUSED: Array<[string, ImportCommandOptions, boolean, string]> = [
    ['no --flavor', {}, true,
     "--flavor is required: name the flavor to write, 'ossie' or 'google'."],
    ['an unknown --flavor', {flavor: 'xml'}, true,
     "--flavor 'xml' is not a flavor; use 'ossie' or 'google'."],
    ['an unknown --input', {flavor: 'google', input: 'owl'}, true,
     "--input 'owl' is not supported; use 'third-party' or 'first-party'."],
    ['a missing file', {flavor: 'google'}, false, 'file not found: retail.yaml'],
  ];
  for (const [label, options, exists, error] of REFUSED) {
    test(`${label} is refused before the engine runs`, async () => {
      if (exists) write('retail.yaml', model());
      const call = spyOn(engine, 'importSemanticModelYaml');
      expect(await importModel('retail.yaml', {...options, out: 'out'})).toBe(1);
      expect(errors).toEqual([`Error: ${error}`]);
      expect(call).not.toHaveBeenCalled();
      expect(filesIn('out')).toEqual([]);
    });
  }

  // [label, command options, what the engine gets]
  const PASSED: Array<[string, ImportCommandOptions, engine.ImportSemanticModelOptions]> = [
    ['a third-party file by default, with --transpile off', {flavor: 'ossie'},
     {flavor: 'ossie', sourcePrefix: undefined, transpile: false, strict: false}],
    ['a first-party file strictly, with --source-prefix and --transpile',
     {flavor: 'ossie', input: 'first-party', sourcePrefix: PREFIX, transpile: true},
     {flavor: 'ossie', sourcePrefix: PREFIX, transpile: true, strict: true}],
  ];
  for (const [label, options, expected] of PASSED) {
    test(`passes the engine its options: ${label}`, async () => {
      write('retail.yaml', model());
      const call = spyOn(engine, 'importSemanticModelYaml');
      expect(await importModel('retail.yaml', {...options, out: 'out'})).toBe(0);
      expect(call.mock.calls).toEqual(
          [[model(), {
            ...expected, profileFiles: [], fileName: 'retail.yaml',
            listEntries: expect.any(Function), readDialects: expect.any(Function),
            overwritesInput: expect.any(Function), transpileOutcome: expect.any(Function),
          }]]);
      expect(ApiContext.default).not.toHaveBeenCalled();
    });
  }

  // Found by the input file's name, `.yaml` or `.yml`, and always `.yaml`, in
  // the order push checks them.
  for (const input of ['in/retail.yaml', 'in/retail.yml']) {
    test(`passes the engine the profile files beside ${input}, and no other file`, async () => {
      write(input, model());
      write('in/retail.profile.prod.yaml', 'name: prod\n');
      write('in/retail.profile.dev.yaml', 'name: dev\n');
      write('in/retail.profile.prod.v2.yaml', 'name: prod\n');
      write('in/retail.profile.yaml', 'name: prod\n');
      write('in/retail.profile.qa.yml', 'name: qa\n');
      write('in/other.profile.qa.yaml', 'name: qa\n');
      const call = spyOn(engine, 'importSemanticModelYaml');
      await importModel(input, {flavor: 'ossie', out: 'out'});
      expect(call.mock.calls[0][1]!.profileFiles).toEqual([
        {fileName: 'retail.profile.yaml', content: 'name: prod\n'},
        {fileName: 'retail.profile.prod.v2.yaml', content: 'name: prod\n'},
        {fileName: 'retail.profile.dev.yaml', content: 'name: dev\n'},
        {fileName: 'retail.profile.prod.yaml', content: 'name: prod\n'},
      ]);
    });
  }

  // [label, --out, where the model file lands]
  const WRITTEN: Array<[string, string|undefined, string]> = [
    ['to the file --out names', 'models/mine.yaml', 'models/mine.yaml'],
    ['to a .yml file --out names', 'models/mine.yml', 'models/mine.yml'],
    ['into the directory --out names', 'models', 'models/retail.yaml'],
    ['into the workspace without --out', undefined, `${GROUP}/retail.yaml`],
  ];
  for (const [label, out, at] of WRITTEN) {
    test(`writes the engine's file ${label}`, async () => {
      workspace();
      write('retail.yaml', model());
      expect(await importModel('retail.yaml', {flavor: 'ossie', out})).toBe(0);
      expect(fs.readFileSync(path.join(dir, at), 'utf8'))
          .toBe((await imported(model(), {flavor: 'ossie'}))[0].content);
      expect(errors).toEqual([]);
    });
  }

  // A third-party import that writes over its input names the import command
  // that reads the file it writes. The command takes --input first-party when
  // that file has a GOOGLE block, here for the relationship's description.
  // Following it adds the BigQuery text of 'orders.order_id'.
  const DESCRIBED = `      - name: customers\n        source: ${PREFIX}/tables/customers\n` +
      '        primary_key: [id]\n        fields:\n          - name: id\n' +
      '            expression: {dialects: [{dialect: BIGQUERY, expression: id}]}\n' +
      '    relationships:\n      - {name: oc, from: orders, to: customers, ' +
      'from_columns: [order_id], to_columns: [id], description: d}\n';
  // [label, the input, --out, text after the field 'orders.order_id', --input]
  test.each([
    ['in place in the workspace', path.join(GROUP, 'retail.yaml'), undefined, DESCRIBED, 'first-party'],
    ['over the file --out names', 'retail.yaml', 'retail.yaml', DESCRIBED, 'first-party'],
    // A first-party import of this file stops at the field the translator
    // refuses. The metric draws the hint from the load too.
    ['in place, writing no GOOGLE block,', path.join(GROUP, 'retail.yaml'), undefined,
     '          - name: custom_val\n            expression: {dialects: [{dialect: SNOWFLAKE, ' +
         "expression: 'MY_CUSTOM_SNOWFLAKE_UDF(order_id)'}]}\n    metrics:\n" +
         "      - {name: n, expression: {dialects: [{dialect: SNOWFLAKE, expression: 'COUNT(orders.order_id)'}]}}\n",
     undefined],
  ])('a third-party import %s hints at a command that reads the written file', async (_, input, out, rest, mode) => {
    workspace();
    write(input, model().replace('dialect: BIGQUERY', 'dialect: SNOWFLAKE') + rest);
    expect(await importModel(input, {flavor: 'ossie', out})).toBe(0);
    // The load warns about each text import can translate, and every warning
    // that names a command names the same one as push's check.
    const hint = (firstParty: unknown) => `add one with 'kcmd import <file>${
        firstParty ? ' --input first-party' : ''} --flavor ossie --transpile'`;
    const translated = ["field 'orders.order_id'", ...rest.includes('metrics:') ? ["metric 'n'"] : []];
    for (const name of translated) {
      expect(warnings).toContain(`Warning: ${name}: no 'BIGQUERY' or 'ANSI_SQL' dialect, so a ` +
          `BIGQUERY table cannot run its 'SNOWFLAKE' expression; give it one, or ${hint(mode)}`);
    }
    for (const w of warnings.filter(w => w.includes('kcmd import'))) expect(w).toContain(hint(mode));
    expect(warnings.join('\n')).not.toContain(hint(!mode));
    warnings = [];
    expect(await importModel(input, {flavor: 'ossie', input: mode, transpile: true, out}))
        .toBe(0);
    expect(errors).toEqual([]);
    for (const name of translated) expect(warnings.join('\n')).not.toContain(`${name}: no 'BIGQUERY'`);
    expect(warnings.join('\n')).not.toContain("field 'orders.order_id' in model");
  });

  // A profile that passes its checks prints its load warnings, which name the
  // same command as the model file's.
  test('a third-party import of a Google model and its profile file names one command', async () => {
    write('in/retail.yaml', model().replace('"0.2.0.dev0"', '"0.2.0.dev0/google"')
        .replace('datasets:', 'entities:') +
        "          - name: flag\n            expression: {dialects: [{dialect: SNOWFLAKE, expression: 'IFF(TRUE, 1, 0)'}]}\n");
    write('in/retail.profile.prod.yaml',
          `name: prod\nentities:\n  - name: orders\n    source: ${PREFIX}/tables/orders_prod\n` +
          '    primary_key: [order_id]\n    fields:\n      - name: order_id\n' +
          '        expression: {dialects: [{dialect: BIGQUERY, expression: order_id}]}\n');
    expect(await importModel('in/retail.yaml', {flavor: 'google', out: 'out'})).toBe(0);
    expect(warnings).toContainEqual(
        expect.stringContaining("add one with 'kcmd import <file> --flavor google --transpile'"));
    expect(warnings.join('\n')).not.toContain('--input first-party');
  });

  // An in-place import that a leftover profile file stops names that error in
  // its advice, since the import the advice suggests reads the file this one
  // would write. Once the file is gone, the import writes, and following the
  // advice clears it.
  test('an in-place import a leftover profile file stops names that error in its advice', async () => {
    workspace();
    const input = path.join(GROUP, 'retail.yaml');
    const leftover = path.join(GROUP, 'retail.profile.prod.yaml');
    write(input, model().replace('dialect: BIGQUERY', 'dialect: SNOWFLAKE') + DESCRIBED);
    write(leftover, 'name: prod\n');
    const refusal = `the import does not write ${leftover}, which would stay beside the ` +
        'model; pass --out <path> to write elsewhere, or first remove any the model no ' +
        'longer uses';
    const advice = "Warning: field 'orders.order_id': no 'BIGQUERY' or 'ANSI_SQL' dialect, " +
        "so a BIGQUERY table cannot run its 'SNOWFLAKE' expression; give it one, or add " +
        "one with 'kcmd import <file> --input first-party --flavor ossie --transpile'";
    expect(await importModel(input, {flavor: 'ossie'})).toBe(1);
    expect(warnings).toContain(`${advice} after fixing this: ${refusal}`);
    expect(errors).toEqual([`Error: ${refusal}.`]);
    fs.rmSync(path.join(dir, leftover));
    warnings = [];
    expect(await importModel(input, {flavor: 'ossie'})).toBe(0);
    expect(warnings).toContain(advice);
    expect(await importModel(input, {flavor: 'ossie', input: 'first-party', transpile: true}))
        .toBe(0);
    warnings = [];
    expect(await importModel(input, {flavor: 'ossie', input: 'first-party'})).toBe(0);
    expect(warnings.join('\n')).not.toContain("field 'orders.order_id': no 'BIGQUERY'");
  });

  const IN_GROUP = path.join(GROUP, 'shop.yaml');
  // [label, the workspace, the error, the input file]
  const REFUSED_WITHOUT_OUT: Array<[string, () => void, string, string?]> = [
    ['no catalog.yaml', () => {},
     'Error: there is no catalog.yaml in this directory, so there is no model ' +
         'layout to write into. Pass --out <path> to write the file directly.'],
    ['a scope that is not a semantic model', () => {
       // An entry group scope, whose snapshot would load its entries from the
       // catalog; the command reads only its source type.
       write('catalog.yaml', 'scope: entryGroup.test-project.us.sales\n');
       spyOn(kcmd.CatalogSnapshot, 'fromPath')
           .mockResolvedValue({manifest: {source: {type: Sources.ENTRYGROUP}}} as any);
     }, 'Error: this catalog is not a semantic-model scope'],
    ['an entry group that holds another model', () => {
       workspace();
       write(IN_GROUP, model().replace('name: retail', 'name: shop'));
     }, `Error: the entry group already holds another model's file (${IN_GROUP}), ` +
         'and an entry group holds one model; remove it if this model replaces it, pass ' +
         "--out <path> to write elsewhere, or import into another entry group's scope."],
    ['an input file in the entry group under another name', workspace,
     `Error: the input file ./${IN_GROUP} sits in the entry group, so the import would ` +
         `leave this model in two files there, ./${IN_GROUP} and ${path.join(GROUP, 'retail.yaml')}. ` +
         'Move the input out of the entry group and import it from there, or pass ' +
         '--out <path> to write elsewhere.',
     `./${IN_GROUP}`],
  ];
  for (const [label, setUp, error, input = 'retail.yaml'] of REFUSED_WITHOUT_OUT) {
    test(`without --out, ${label} is refused and nothing is written`, async () => {
      setUp();
      write(input, model());
      const before = filesIn();
      expect(await importModel(input, {flavor: 'ossie'})).toBe(1);
      expect(errors).toEqual([expect.stringContaining(error)]);
      expect(filesIn()).toEqual(before);
    });
  }

  // A vanilla model with a GOOGLE block converts only as a first-party file,
  // and the bare source it asks --source-prefix to complete is a warning
  // there too.
  test('a first-party file\'s bare source is completed from --source-prefix, with a warning', async () => {
    const vanilla = model('orders') +
        "    custom_extensions:\n      - vendor_name: GOOGLE\n" +
        `        data: '{"profiles": [{"name": "prod", "entities": [{"name": "orders", "source": "${
            PREFIX}/tables/orders_prod", "primary_key": ["order_id"], "fields": ` +
        `[{"name": "order_id", "expression": "order_id"}]}]}]}'\n`;
    write('retail.yaml', vanilla);
    expect(await importModel('retail.yaml', {
      flavor: 'ossie', input: 'first-party', sourcePrefix: PREFIX, out: 'out',
    })).toBe(0);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      `Warning: dataset 'orders': rewrote bare source 'orders' to '${PREFIX}/tables/orders'.`,
    ]);
    expect(fs.readFileSync(path.join(dir, 'out', 'retail.yaml'), 'utf8'))
        .toContain(`source: ${PREFIX}/tables/orders\n`);
  });

  // The command lists the entry group with the Dataplex client, which follows
  // each page, and then reads the entry's dialect as push does.
  test('completes a bare name from an entry on a later page of the --source-prefix entry group', async () => {
    const group = 'projects/acme/locations/us/entryGroups/sf';
    const page = (id: string, nextPageToken?: string) => ({
      status: 200,
      result: {
        entries: [{name: `${group}/entries/${id}`, entryType: 'type',
                   fullyQualifiedName: `snowflake:acme.retail.public.${id}`}],
        nextPageToken,
      },
    });
    const lookup = 'projects/acme/locations/us:lookupEntry';
    const get = spyOn(CatalogClient.prototype as any, '_get').mockImplementation(
        async (name: string, params: any) => name === lookup ?
            {status: 200, result: {fullyQualifiedName: 'snowflake:acme.retail.public.orders'}} :
            params.pageToken ? page('orders') : page('items', 'T'));
    write('retail.yaml', model('public.orders'));
    expect(await importModel('retail.yaml', {flavor: 'ossie', sourcePrefix: group, out: 'out'}))
        .toBe(0);
    expect(get.mock.calls.map(([name, params]: any) => [name, params.pageToken ?? params.entry]))
        .toEqual([[`${group}/entries`, undefined], [`${group}/entries`, 'T'],
                  [lookup, `${group}/entries/orders`]]);
    expect(fs.readFileSync(path.join(dir, 'out', 'retail.yaml'), 'utf8'))
        .toContain(`source: ${group}/entries/orders\n`);
  });

  test('reads a Spanner database\'s dialect as push does', async () => {
    const get = spyOn(SpannerClient.prototype, 'getDatabase')
                    .mockResolvedValue({status: 200, result: {databaseDialect: 'POSTGRESQL'}});
    write('retail.yaml', model('spanner.googleapis.com/projects/acme/instances/i/databases/db/tables/orders')
                             .replace('BIGQUERY', 'POSTGRES'));
    expect(await importModel('retail.yaml', {flavor: 'ossie', input: 'first-party', out: 'out'}))
        .toBe(0);
    expect(get.mock.calls).toEqual([['acme', 'i', 'db']]);
    expect([errors, warnings]).toEqual([[], []]);
  });

  // A profile file the import does not write would stay beside the model:
  // push rejects it beside a vanilla model, and reads it beside a Google one.
  describe('a model with a profile file in the workspace', () => {
    const MODEL_FILE = path.join(GROUP, 'retail.yaml');
    const PROFILE_FILE = path.join(GROUP, 'retail.profile.prod.yaml');
    // Profile prod, whose field order_id has only Snowflake SQL.
    const PROFILE =
        `# The prod tables.\nname: prod\nentities:\n  - name: orders\n` +
        `    source: ${PREFIX}/tables/orders_prod     # the prod copy\n` +
        '    fields:\n      - name: order_id\n        expression:\n' +
        '          dialects: [{dialect: SNOWFLAKE, expression: "NVL(order_id, 0)"}]\n' +
        '    primary_key: [order_id]     # same key\n';
    // PROFILE translated by --transpile, written as the model file is: the
    // flow list gains the entry, and the rest of the file stays as written.
    const TRANSLATED = PROFILE.replace(
        '"NVL(order_id, 0)"}]',
        '"NVL(order_id, 0)"}, {dialect: BIGQUERY, expression: "COALESCE(order_id, 0)"}]');
    // Writes the model and its profile file as `<stem>.yaml` and
    // `<stem>.profile.prod.yaml`.
    const setUp = (stem = 'retail') => {
      workspace();
      write(path.join(GROUP, `${stem}.yaml`), google);
      write(path.join(GROUP, `${stem}.profile.prod.yaml`), PROFILE);
    };

    // Push's text about the profile file `file` beside the vanilla model file `modelFile`.
    const besideVanilla = (file: string, modelFile: string) =>
        `Profile file '${file}' sits beside '${modelFile}', which is a 0.2.0.dev0 document; ` +
        'sibling profile files are Google-flavor only, and a 0.2.0.dev0 model keeps its ' +
        'profiles in its GOOGLE block.';
    // [label, the model file, --flavor, the error]. With --transpile, PROFILE
    // has the BigQuery SQL push requires.
    for (const [label, text, flavor, error] of [
      ['a Google model converted to vanilla', google, 'ossie',
       `the import does not write ${PROFILE_FILE}, which would stay beside the model`],
      ['a vanilla model converted to Google', model(), 'google',
       besideVanilla('retail.profile.prod.yaml', 'retail.yaml')],
    ]) {
      test(`${label} in place is refused, naming the profile file`, async () => {
        setUp();
        write(MODEL_FILE, text);
        expect(await importModel(MODEL_FILE, {flavor, input: 'first-party', transpile: true}))
            .toBe(1);
        expect(errors).toEqual([expect.stringContaining(`Error: ${error}`)]);
        expect(fs.readFileSync(path.join(dir, MODEL_FILE), 'utf8')).toBe(text);
      });
    }

    // A vanilla model keeps its profiles in its GOOGLE block, and push refuses a
    // profile file beside it, after it checks the file's name. Push also
    // refuses a `<model>.profiles/` directory. Import gives push's text,
    // naming the input: an error under --input first-party, and a warning
    // otherwise.
    const PROD = besideVanilla('sales.profile.prod.yaml', 'sales.yaml');
    const LEGACY_DIR = "Legacy profile directory 'sales.profiles/' is no longer supported; " +
        "rename profile files to 'sales.profile.<name>.yaml' beside 'sales.yaml'.";
    // [--input, --flavor, the profile file, push's text]
    const BESIDE_VANILLA: Array<[string, string, string, string]> = [
      ['first-party', 'google', 'sales.profile.prod.yaml', PROD],
      ['first-party', 'ossie', 'sales.profile.prod.yaml', PROD],
      ['third-party', 'google', 'sales.profile.prod.yaml', PROD],
      ['third-party', 'ossie', 'sales.profile.prod.yaml', PROD],
      ['first-party', 'google', 'sales.profile.yaml',
       "Profile file 'sales.profile.yaml' names no profile; rename it 'sales.profile.<name>.yaml'."],
      ['first-party', 'google', 'sales.profiles/prod.yaml', LEGACY_DIR],
      ['third-party', 'google', 'sales.profiles/prod.yaml', LEGACY_DIR],
    ];
    for (const [input, flavor, file, message] of BESIDE_VANILLA) {
      test(`${file} beside a vanilla model gets push's text, ${input} to ${flavor}`, async () => {
        write('in/sales.yaml', model());
        write(`in/${file}`, PROFILE);
        const strict = input === 'first-party';
        expect(await importModel('in/sales.yaml', {flavor, input, out: 'out'})).toBe(strict ? 1 : 0);
        expect([...errors, ...warnings]).toEqual([`${strict ? 'Error' : 'Warning'}: ${message}`]);
        expect(filesIn('out')).toEqual(strict ? [] : ['retail.yaml']);
      });
    }

    // Each is a profile file of the model. Push refuses the misnamed ones and
    // the legacy profile directory.
    for (const left of [
      'retail.profile.yaml', 'retail.profile.prod.v2.yaml', 'retail.profile.-us.yaml',
      path.join('retail.profiles', 'prod.yaml'),
    ]) {
      test(`a model imported beside ${left} is refused, and nothing is written`, async () => {
        workspace();
        write(path.join(GROUP, left), PROFILE);
        write('in/sales.yaml', google);
        expect(await importModel('in/sales.yaml', {flavor: 'google'})).toBe(1);
        expect(errors).toEqual([
          `Error: the import does not write ${path.join(GROUP, left)}, which would stay beside ` +
          'the model; pass --out <path> to write elsewhere, or first remove any the model no ' +
          'longer uses.',
        ]);
        expect(filesIn(GROUP)).toEqual([left]);
      });
    }

    test('re-imported as Google flavor in place with --transpile translates its profile file', async () => {
      setUp();
      expect(await importModel(MODEL_FILE, {flavor: 'google', input: 'first-party', transpile: true}))
          .toBe(0);
      expect(errors).toEqual([]);
      expect(filesIn(GROUP)).toEqual(['retail.profile.prod.yaml', 'retail.yaml']);
      expect(fs.readFileSync(path.join(dir, PROFILE_FILE), 'utf8')).toBe(TRANSLATED);
    });

    // Under the model's name, which the input file's name need not be. A
    // third-party import warns that PROFILE lacks BigQuery SQL.
    test('imported as Google flavor from another folder brings its profile file', async () => {
      workspace();
      write('in/sales.yaml', google);
      write('in/sales.profile.prod.yaml', PROFILE);
      expect(await importModel('in/sales.yaml', {flavor: 'google'})).toBe(0);
      expect(errors).toEqual([]);
      expect(filesIn(GROUP)).toEqual(['retail.profile.prod.yaml', 'retail.yaml']);
      expect(fs.readFileSync(path.join(dir, PROFILE_FILE), 'utf8')).toBe(PROFILE);
    });

    // Push refuses a profile file whose name has a dot or is empty. Import
    // gives push's text: an error naming the input under --input first-party,
    // and a warning naming the file it writes otherwise.
    // [the profile file of model `m`, push's text about it]
    const MISNAMED: Array<[(m: string) => string, (m: string) => string]> = [
      [m => `${m}.profile.prod.v2.yaml`,
       m => `Profile file '${m}.profile.prod.v2.yaml' has profile name 'prod.v2'; a profile ` +
           'name is a letter followed by letters, digits, underscores and hyphens.'],
      [m => `${m}.profile.yaml`,
       m => `Profile file '${m}.profile.yaml' names no profile; rename it ` +
           `'${m}.profile.<name>.yaml'.`],
    ];
    for (const [file, error] of MISNAMED) {
      for (const flavor of ['google', 'ossie']) {
        test(`${file('sales')} gets push's error under --input first-party, to ${flavor}`, async () => {
          write('in/sales.yaml', google);
          write(`in/${file('sales')}`, PROFILE);
          expect(await importModel('in/sales.yaml', {flavor, input: 'first-party', out: 'out'}))
              .toBe(1);
          expect(errors).toEqual([`Error: ${error('sales')}`]);
          expect(filesIn('out')).toEqual([]);
        });
      }

      test(`${file('sales')} is written with push's warning in third-party mode`, async () => {
        write('in/sales.yaml', google);
        write(`in/${file('sales')}`, PROFILE);
        expect(await importModel('in/sales.yaml', {flavor: 'google', out: 'out'})).toBe(0);
        expect(warnings).toEqual([`Warning: ${error('retail')}`]);
        expect(filesIn('out')).toEqual([file('retail'), 'retail.yaml']);
      });
    }

    test('imported as Google flavor to --out with --transpile brings its profile files translated', async () => {
      write('in/retail.yaml', google);
      write('in/retail.profile.prod.yaml', PROFILE);
      // Written as they are, with warnings: dev gains no entry, and qa does not
      // load.
      write('in/retail.profile.dev.yaml', 'name:  dev\nentities:\n  - name: orders\n');
      write('in/retail.profile.qa.yaml', 'name: staging\n');
      expect(await importModel('in/retail.yaml', {
        flavor: 'google', transpile: true, out: 'out',
      })).toBe(0);
      expect(filesIn('out')).toEqual([
        'retail.profile.dev.yaml', 'retail.profile.prod.yaml', 'retail.profile.qa.yaml',
        'retail.yaml',
      ]);
      expect(fs.readFileSync(path.join(dir, 'out', 'retail.profile.prod.yaml'), 'utf8'))
          .toBe(TRANSLATED);
      expect(['dev', 'qa'].map(
                 p => fs.readFileSync(path.join(dir, 'out', `retail.profile.${p}.yaml`), 'utf8')))
          .toEqual(['name:  dev\nentities:\n  - name: orders\n', 'name: staging\n']);
    });

    test('under another name in the entry group is refused, saying to move its profile files too', async () => {
      setUp('shop');
      expect(await importModel(IN_GROUP, {flavor: 'ossie', input: 'first-party', transpile: true}))
          .toBe(1);
      expect(errors).toEqual([expect.stringContaining(
          'Move the input and its profile files out of the entry group')]);
    });
  });

  describe('a model with a profile, which gives two files', () => {
    const FILES = [
      {fileName: 'retail.yaml', content: 'model\n'},
      {fileName: 'retail.profile.prod.yaml', content: 'profile\n'},
    ];
    const stub = () => spyOn(engine, 'importSemanticModelYaml')
                           .mockResolvedValue({ok: true, files: FILES, warnings: [], errors: []});

    test('a file with no place in the layout is refused, and nothing is written', async () => {
      workspace();
      write('retail.yaml', model());
      spyOn(engine, 'importSemanticModelYaml').mockResolvedValue({
        ok: true, warnings: [], errors: [],
        files: [FILES[0], {fileName: 'retail.overview.md', content: 'overview\n'}],
      });
      expect(await importModel('retail.yaml', {flavor: 'google'})).toBe(1);
      expect(errors).toEqual([
        "Error: the import gives 'retail.overview.md', which has no place in the " +
            'semantic-model layout.',
      ]);
      expect(filesIn(GROUP)).toEqual([]);
    });

    test('--out naming a file is refused, and nothing is written', async () => {
      write('retail.yaml', model());
      stub();
      expect(await importModel('retail.yaml', {flavor: 'google', out: 'out/mine.yaml'})).toBe(1);
      expect(errors).toEqual([
        "Error: --out 'out/mine.yaml' names a file, but the import gives 2 files " +
        '(retail.yaml, retail.profile.prod.yaml); name a directory instead.',
      ]);
      expect(filesIn('out')).toEqual([]);
    });

    // [label, --out, the directory both files land in]
    for (const [label, out, at] of [
      ['the directory --out names', 'out', 'out'],
      ['the workspace, without --out', undefined, GROUP],
    ] as const) {
      test(`each file goes into ${label}`, async () => {
        workspace();
        write('retail.yaml', model());
        stub();
        expect(await importModel('retail.yaml', {flavor: 'google', out})).toBe(0);
        expect(fs.readFileSync(path.join(dir, at, 'retail.yaml'), 'utf8')).toBe('model\n');
        expect(fs.readFileSync(path.join(dir, at, 'retail.profile.prod.yaml'), 'utf8'))
            .toBe('profile\n');
      });
    }
  });

  // [label, input text]
  const FAILED: Array<[string, string]> = [
    ['a file that is not YAML', 'version: [unclosed\n'],
    ['an illegal name', model().replace('name: orders', 'name: 2024_orders')],
  ];
  for (const [label, text] of FAILED) {
    test(`${label} prints the engine's errors and writes nothing`, async () => {
      workspace();
      write('retail.yaml', text);
      const result = await engine.importSemanticModelYaml(text, {flavor: 'ossie'});
      expect(result.ok).toBe(false);
      expect(await importModel('retail.yaml', {flavor: 'ossie'})).toBe(1);
      expect(errors).toEqual(result.errors.map(e => `Error: ${e}`));
      expect(filesIn(GROUP)).toEqual([]);
    });
  }

  // Push refuses an unquoted action statement with a comment on the same line.
  test('a first-party file with a comment after an action statement gets push\'s error, and nothing is written', async () => {
    // Push stops at the first refusal, before it checks the deployment's
    // target or the second statement's parameter.
    write('retail.yaml',
          google.replace('  - name: retail\n',
                         '  - name: retail\n    deployments: [{name: bad, target: not-a-target}]\n') +
          '    actions:\n      - name: purge\n        parameters: [{name: k, type: Integer}]\n' +
          '        executor:\n          sql:\n            statements:\n' +
          "              - UPDATE orders SET doc = doc #- '{draft}' WHERE order_id = @k\n" +
          '              - DELETE FROM orders WHERE order_id = @missing\n');
    expect(await importModel('retail.yaml', {flavor: 'google', input: 'first-party', out: 'out'}))
        .toBe(1);
    expect(errors).toEqual([expect.stringContaining(
        "Error: action 'purge' in model 'retail' (retail) has a sql executor whose statement 1 " +
        'has a comment on the same line')]);
    expect(filesIn('out')).toEqual([]);
  });

  test('a strict import says why it left a field untranslated, beside the error about it', async () => {
    write('retail.yaml', model().replace('dialect: BIGQUERY, expression: order_id',
                                         'dialect: SNOWFLAKE, expression: "GREATEST(a, b)"'));
    expect(await importModel('retail.yaml', {
      flavor: 'google', input: 'first-party', transpile: true, out: 'out',
    })).toBe(1);
    expect(warnings).toContain(
        "Warning: field 'orders.order_id': could not transpile 'SNOWFLAKE' -> " +
        "'BIGQUERY' (kcmd does not translate GREATEST); left untranslated");
    expect(errors.join('\n')).toContain("Error: field 'orders.order_id' in model 'retail'");
  });

  test('a bare source without --source-prefix is written as it is, with the engine\'s warning', async () => {
    write('retail.yaml', model('orders'));
    const result = await engine.importSemanticModelYaml(model('orders'), {flavor: 'ossie'});
    expect(result.warnings).not.toEqual([]);
    expect(await importModel('retail.yaml', {flavor: 'ossie', out: 'out'})).toBe(0);
    expect(warnings).toEqual(result.warnings.map(w => `Warning: ${w}`));
    expect(fs.readFileSync(path.join(dir, 'out', 'retail.yaml'), 'utf8'))
        .toContain('source: orders');
  });
});
