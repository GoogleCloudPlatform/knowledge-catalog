// Tests for `kcmd import` (importModel in src/tool/commands.ts, b/568397111).
// The import engine is the real one on main, so its answers are faithful; a
// spy that calls through checks what the command passes it. A case that needs
// more than one output file stubs the engine with the shape serializeModelFiles
// gives a model with a profile: `<model>.yaml` and `<model>.profile.<name>.yaml`.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as kcmd from '../../src/libts';
import {ApiContext} from '../../src/libts/gcp/context';
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
      expect(call.mock.calls).toEqual([[model(), {...expected, profileFiles: []}]]);
    });
  }

  // Found by the input file's name, `.yaml` or `.yml`, and always `.yaml`.
  for (const input of ['in/retail.yaml', 'in/retail.yml']) {
    test(`passes the engine the profile files beside ${input}, and no other file`, async () => {
      write(input, model());
      write('in/retail.profile.prod.yaml', 'name: prod\n');
      write('in/retail.profile.dev.yaml', 'name: dev\n');
      write('in/other.profile.qa.yaml', 'name: qa\n');
      const call = spyOn(engine, 'importSemanticModelYaml');
      await importModel(input, {flavor: 'ossie', out: 'out'});
      expect(call.mock.calls[0][1]!.profileFiles).toEqual([
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

  test('without --out, needs a semantic-model workspace and writes nothing otherwise', async () => {
    // An entry group scope, whose snapshot would load its entries from the
    // catalog; the command reads only its source type.
    spyOn(kcmd.CatalogSnapshot, 'fromPath')
        .mockResolvedValue({manifest: {source: {type: Sources.ENTRYGROUP}}} as any);
    write('retail.yaml', model());
    expect(await importModel('retail.yaml', {flavor: 'ossie'})).toBe(1);
    expect(errors).toEqual([expect.stringContaining(
        'Error: this catalog is not a semantic-model scope')]);
    expect(filesIn()).toEqual(['retail.yaml']);
  });

  describe('a model with a profile, which gives two files', () => {
    const FILES = [
      {fileName: 'retail.yaml', content: 'model\n'},
      {fileName: 'retail.profile.prod.yaml', content: 'profile\n'},
    ];
    const stub = () => spyOn(engine, 'importSemanticModelYaml')
                           .mockResolvedValue({ok: true, files: FILES, warnings: [], errors: []});

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
