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
              dialects: [{dialect: BIGQUERY, expression: orders.order_id}]
`;
const model = (source = `${PREFIX}/tables/orders`) =>
    MODEL.replace('SOURCE', source);

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
            listEntries: expect.any(Function),
          }]]);
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
  // each page.
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
    const get = spyOn(CatalogClient.prototype as any, '_get').mockImplementation(
        async (_: string, params: any) => params.pageToken ? page('orders') : page('items', 'T'));
    write('retail.yaml', model('public.orders'));
    expect(await importModel('retail.yaml', {flavor: 'ossie', sourcePrefix: group, out: 'out'}))
        .toBe(0);
    expect(get.mock.calls.map(([name, params]: any) => [name, params.pageToken]))
        .toEqual([[`${group}/entries`, undefined], [`${group}/entries`, 'T']]);
    expect(fs.readFileSync(path.join(dir, 'out', 'retail.yaml'), 'utf8'))
        .toContain(`source: ${group}/entries/orders\n`);
  });

  // A profile file the import does not write would stay beside the model:
  // push rejects it beside a vanilla model, and reads it beside a Google one.
  describe('a model with a profile file in the workspace', () => {
    const MODEL_FILE = path.join(GROUP, 'retail.yaml');
    const PROFILE_FILE = path.join(GROUP, 'retail.profile.prod.yaml');
    const google = model().replace('version: "0.2.0.dev0"', 'version: "0.2.0.dev0/google"')
                       .replace('    datasets:\n', '    entities:\n');
    // Profile prod, whose field order_id has only Snowflake SQL.
    const PROFILE =
        `# The prod tables.\nname: prod\nentities:\n  - name: orders\n` +
        `    source: ${PREFIX}/tables/orders_prod     # the prod copy\n` +
        '    fields:\n      - name: order_id\n        expression:\n' +
        '          dialects: [{dialect: SNOWFLAKE, expression: "NVL(order_id, 0)"}]\n' +
        '    primary_key: [order_id]     # same key\n';
    // PROFILE translated by --transpile, written as the model file is: the
    // flow list gains the entry, and one space stays before each comment.
    const TRANSLATED = PROFILE.replaceAll('     #', ' #').replace(
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
    // profile file beside it, after it checks the file's name. Import gives
    // push's text, naming the input: an error under --input first-party, and a
    // warning otherwise.
    const PROD = besideVanilla('sales.profile.prod.yaml', 'sales.yaml');
    // [--input, --flavor, the profile file, push's text]
    const BESIDE_VANILLA: Array<[string, string, string, string]> = [
      ['first-party', 'google', 'sales.profile.prod.yaml', PROD],
      ['first-party', 'ossie', 'sales.profile.prod.yaml', PROD],
      ['third-party', 'google', 'sales.profile.prod.yaml', PROD],
      ['third-party', 'ossie', 'sales.profile.prod.yaml', PROD],
      ['first-party', 'google', 'sales.profile.yaml',
       "Profile file 'sales.profile.yaml' names no profile; rename it 'sales.profile.<name>.yaml'."],
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

    // Each is a profile file of the model. Push refuses the misnamed ones, and
    // reads the file in the older directory as the model's profile.
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
      expect(await importModel(IN_GROUP, {flavor: 'ossie', input: 'first-party'})).toBe(1);
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
