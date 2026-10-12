// Tests for `kcV2Aspects()` and forwarding of `v2Aspects` through `kcmd push`
// and `kcmd pull` (src/tool/commands.ts,
// src/libts/semantic/deploy_knowledge_catalog.ts).

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../src/libts/gcp/context';
import * as bqLeg from '../../src/libts/semantic/deploy_bigquery';
import * as kc from '../../src/libts/semantic/deploy_knowledge_catalog';
import * as spannerLeg from '../../src/libts/semantic/deploy_spanner';
import * as kcEmit from '../../src/libts/semantic/knowledge_catalog';
import * as pullKc from '../../src/libts/semantic/pull_kc';
import * as validateMod from '../../src/libts/semantic/validate';
import {kcV2Aspects, pull, push} from '../../src/tool/commands';

const CTX = new ApiContext('test-project', 'us', 'test-token');

const MODEL_YAML = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        primary_key: [key]
        fields:
          - { name: key, label: Customer ID }
`;

let dir = '';
let cwd = '';
let savedEnv: string|undefined;

function writeWorkspace(): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.test-project.us.commerce_eg\n');
  const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
  fs.mkdirSync(eg, {recursive: true});
  fs.writeFileSync(path.join(eg, 'commerce.yaml'), MODEL_YAML);
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-commands-'));
  process.chdir(dir);
  savedEnv = process.env.KC_V2_ASPECTS;
  delete process.env.KC_V2_ASPECTS;
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  spyOn(console, 'log').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation(() => {});
  spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.KC_V2_ASPECTS;
  } else {
    process.env.KC_V2_ASPECTS = savedEnv;
  }
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});

describe('kcV2Aspects', () => {
  test('returns true only when KC_V2_ASPECTS is "1"', () => {
    delete process.env.KC_V2_ASPECTS;
    expect(kcV2Aspects()).toBe(false);

    process.env.KC_V2_ASPECTS = '';
    expect(kcV2Aspects()).toBe(false);

    process.env.KC_V2_ASPECTS = '0';
    expect(kcV2Aspects()).toBe(false);

    process.env.KC_V2_ASPECTS = 'true';
    expect(kcV2Aspects()).toBe(false);

    process.env.KC_V2_ASPECTS = '1';
    expect(kcV2Aspects()).toBe(true);
  });
});

describe('v2Aspects forwarding', () => {
  test(
      'push forwards v2Aspects: false when KC_V2_ASPECTS is unset',
      async () => {
        writeWorkspace();
        const deploySpy = spyOn(kc, 'deployKnowledgeCatalog');
        const emitSpy = spyOn(kcEmit, 'generateCatalogResources');

        const code = await push({validateOnly: true});

        expect(code).toBe(0);
        expect(deploySpy).toHaveBeenCalledTimes(1);
        expect(deploySpy.mock.calls[0][2].v2Aspects).toBe(false);
        expect(emitSpy).toHaveBeenCalledTimes(1);
        expect(emitSpy.mock.calls[0][1].v2Aspects).toBe(false);
      });

  test('push forwards v2Aspects: true when KC_V2_ASPECTS is "1"', async () => {
    writeWorkspace();
    process.env.KC_V2_ASPECTS = '1';
    const deploySpy = spyOn(kc, 'deployKnowledgeCatalog');
    const emitSpy = spyOn(kcEmit, 'generateCatalogResources');

    const code = await push({validateOnly: true});

    expect(code).toBe(0);
    expect(deploySpy).toHaveBeenCalledTimes(1);
    expect(deploySpy.mock.calls[0][2].v2Aspects).toBe(true);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls[0][1].v2Aspects).toBe(true);
  });

  test(
      'pull forwards v2Aspects: false when KC_V2_ASPECTS is unset',
      async () => {
        writeWorkspace();
        const pullSpy = spyOn(pullKc, 'pullKnowledgeCatalog')
                            .mockResolvedValue({models: [], warnings: []});

        const code = await pull();

        expect(code).toBe(0);
        expect(pullSpy).toHaveBeenCalledTimes(1);
        expect(pullSpy.mock.calls[0][1].v2Aspects).toBe(false);
      });

  test('pull forwards v2Aspects: true when KC_V2_ASPECTS is "1"', async () => {
    writeWorkspace();
    process.env.KC_V2_ASPECTS = '1';
    const pullSpy = spyOn(pullKc, 'pullKnowledgeCatalog')
                        .mockResolvedValue({models: [], warnings: []});

    const code = await pull();

    expect(code).toBe(0);
    expect(pullSpy).toHaveBeenCalledTimes(1);
    expect(pullSpy.mock.calls[0][1].v2Aspects).toBe(true);
  });
});


describe('a push with a sibling profile file', () => {
  test('a graph push of the profile file is refused before anything deploys', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: //bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g
    entities:
      - name: Customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/d/tables/customer
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }
`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), `name: prod
entities:
  - name: Customer
    source: //bigquery.googleapis.com/projects/test-project/datasets/prod/tables/customer
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const code = await push({validateOnly: true, kc: false, profile: 'prod'});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("binding profile 'prod' is a profile file, which names no deployment target");
  });

  test('when default_profile names the profile file, the refusal points at --profile default', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\ndefault_profile: prod\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: //bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g
    entities:
      - name: Customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/d/tables/customer
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }
`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), `name: prod
entities:
  - name: Customer
    source: //bigquery.googleapis.com/projects/test-project/datasets/prod/tables/customer
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(validateMod, 'validateBigQueryDataSources').mockResolvedValue([]);
    spyOn(validateMod, 'validateBigQueryActionStatements').mockResolvedValue([]);
    const bqSpy = spyOn(bqLeg, 'deployBigQuery')
                      .mockResolvedValue({deployed: 0, ddl: [], warnings: []} as any);

    // Without --profile, push takes default_profile, the profile file.
    expect(await push({validateOnly: true, kc: false})).toBe(1);
    const refusal = errorSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(refusal).toContain(
        "Run 'kcmd push --profile default' to deploy the model file's own " +
        "bindings, or 'kcmd push --no-profile' to publish to Knowledge " +
        'Catalog without deploying a graph.');
    expect(bqSpy).not.toHaveBeenCalled();

    // The command it names deploys the model file's own bindings.
    errorSpy.mockClear();
    await push({validateOnly: true, kc: false, profile: 'default'});
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .not.toContain('is a profile file');
    expect(bqSpy).toHaveBeenCalledTimes(1);
    expect(bqSpy.mock.calls[0][0][0].model.entities?.[0].dataSource)
        .toBe('test-project.d.customer');
  });
});


describe('push preflights under a legacy wrapper', () => {
  // Each live preflight gets documents labeled with the profile, so its errors
  // name the profile that may have set the value they are about.
  test('every preflight names the profile', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(path.join(eg, 'commerce.profiles'), {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/raw/tables/customer
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }
`);
    const wrapper = (target: string, source: string) => `semantic_model:
  - name: commerce
    deployment_target: ${target}
    entities:
      - name: Customer
        source: ${source}
`;
    fs.writeFileSync(path.join(eg, 'commerce.profiles', 'bq.yaml'), wrapper(
        '//bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g',
        '//bigquery.googleapis.com/projects/test-project/datasets/prod/tables/customer'));
    fs.writeFileSync(path.join(eg, 'commerce.profiles', 'sp.yaml'), wrapper(
        '//spanner.googleapis.com/projects/test-project/instances/i/databases/d/propertyGraphs/g',
        '//spanner.googleapis.com/projects/test-project/instances/i/databases/d/tables/Customer'));
    const seen: Record<string, string[]> = {};
    const record = (name: string) => async (models: any[]) => {
      (seen[name] ??= []).push(...models.map(m => m.document));
      return [];
    };
    spyOn(validateMod, 'validateBigQueryDataSources').mockImplementation(record('sources') as any);
    spyOn(validateMod, 'validateBigQueryActionStatements').mockImplementation(record('bqDml') as any);
    spyOn(validateMod, 'validateSpannerActionStatements').mockImplementation(record('spDml') as any);
    spyOn(bqLeg, 'deployBigQuery').mockResolvedValue(
        {success: true, deployed: 0, ddl: [], warnings: []} as any);
    spyOn(spannerLeg, 'deploySpanner').mockResolvedValue(
        {success: true, warnings: [], ddl: [], deployed: 0} as any);

    expect(await push({validateOnly: true, kc: false, profile: 'bq'})).toBe(0);
    expect(await push({validateOnly: true, kc: false, profile: 'sp'})).toBe(0);
    expect(seen).toEqual({
      sources: ["commerce, profile 'bq'"],
      bqDml: ["commerce, profile 'bq'"],
      spDml: ["commerce, profile 'sp'"],
    });
  });
});


describe('a catalog-only push with a sibling profile file', () => {
  const KC_OK = {
    success: true, created: 0, updated: 0, deleted: 0, linked: 0, unlinked: 0,
    warnings: [], plan: [], details: '',
  } as any;
  const setup = (deployment: string, entities: string) => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\ndefault_profile: prod\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
${deployment}    entities:
${entities}`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), `name: prod
entities:
  - name: Customer
    source: //bigquery.googleapis.com/projects/test-project/datasets/prod/tables/customer
`);
  };
  const CUSTOMER = `      - name: Customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/raw/tables/customer
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }
`;

  // `--no-profile` publishes the default binding, here the profile file, and
  // the model it gives keeps the model file's deployments.
  test('the deployment-profile check covers the model a profile file gives', async () => {
    setup(`    deployments:
      - name: g
        target: //bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g
        profile: prod
`, CUSTOMER);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const deploySpy = spyOn(kc, 'deployKnowledgeCatalog').mockResolvedValue(KC_OK);

    expect(await push({validateOnly: true, profile: false})).toBe(1);
    expect(deploySpy).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("deployment 'g' names profile 'prod'");
  });

  // A catalog-only push publishes the whole logical model, so an entity the
  // profile file leaves without a source does not stop it.
  test('an entity left without a source does not stop a catalog-only push', async () => {
    setup('', CUSTOMER + `      - name: Orders
        primary_key: [id]
        fields:
          - { name: id, expression: o_id }
`);
    const deploySpy = spyOn(kc, 'deployKnowledgeCatalog').mockResolvedValue(KC_OK);

    expect(await push({validateOnly: true, profile: false})).toBe(0);
    expect(deploySpy).toHaveBeenCalledTimes(1);
    const entities = deploySpy.mock.calls[0][0][0].model.entities;
    expect(entities.map(e => [e.name, e.dataSource])).toEqual([
      ['Customer', 'test-project.prod.customer'],
      ['Orders', ''],
    ]);
  });

  test('applies the profile to the model file, unpruned', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    // No deployment target, so the push publishes to Knowledge Catalog only.
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/raw/tables/customer
        fields:
          - { name: key, expression: c_key }
          - { name: credit, expression: c_credit }
`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), `name: prod
entities:
  - name: Customer
    source: //bigquery.googleapis.com/projects/test-project/datasets/prod/tables/customer
    primary_key: [cust_key]
    fields:
      - { name: key, expression: cust_key }
    fields_exclude: [credit]
`);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const deploySpy = spyOn(kc, 'deployKnowledgeCatalog');

    const code = await push({validateOnly: true, profile: 'prod'});

    expect(code).toBe(0);
    // With the flag off, a `--profile` push publishes that profile's bindings
    // as the entity's own. This expectation goes when `--profile` leaves push.
    const customer = deploySpy.mock.calls[0][0][0].model.entities[0];
    expect(customer.dataSource).toBe('test-project.prod.customer');
    expect(customer.keys).toEqual(['cust_key']);
    expect(customer.fields.find(f => f.name === 'key')!.expression)
        .toBe('cust_key');
    // The excluded field loses its binding, as a merge clears it, and the
    // catalog still receives it.
    expect(customer.fields.find(f => f.name === 'credit')).toEqual({
      name: 'credit',
    });
    expect(customer.excludedFields).toBeUndefined();
    // The model file states no key, but the profile does.
    expect(warnSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .not.toContain('no primary_key');
  });
});


describe('a catalog-only push of a profile file keeps the model file\'s warnings', () => {
  test('a key neither file states is warned about', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/raw/tables/customer
        fields:
          - { name: key, expression: c_key }
`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), `name: prod
entities:
  - name: Customer
    source: //bigquery.googleapis.com/projects/test-project/datasets/prod/tables/customer
`);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    spyOn(kc, 'deployKnowledgeCatalog');

    expect(await push({validateOnly: true, profile: 'prod'})).toBe(0);
    expect(warnSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("[commerce] dataset 'Customer': no primary_key");
  });
});


// One scope may mix a profile file and a legacy wrapper. The warnings still
// come in the order of the documents.
describe('a push prints warnings in document order', () => {
  test('a legacy wrapper before a profile file', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(path.join(eg, 'a.profiles'), {recursive: true});
    const BQ = (t: string) =>
        `//bigquery.googleapis.com/projects/test-project/datasets/raw/tables/${t}`;
    const keyless = (name: string) => `version: "0.2.0.dev0/google"
semantic_model:
  - name: ${name}
    entities:
      - name: X
        source: ${BQ(name)}
        fields:
          - { name: id, expression: id }
`;
    fs.writeFileSync(path.join(eg, 'a.yaml'), keyless('a'));
    fs.writeFileSync(path.join(eg, 'b.yaml'), keyless('b'));
    fs.writeFileSync(path.join(eg, 'a.profiles', 'prod.yaml'), `semantic_model:
  - name: a
    entities:
      - name: X
        source: ${BQ('a2')}
`);
    fs.writeFileSync(path.join(eg, 'b.profile.prod.yaml'),
                     `name: prod\nentities:\n  - name: X\n    source: ${BQ('b2')}\n`);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
    spyOn(kc, 'deployKnowledgeCatalog');

    // The catalog takes one model per entry group, so the push itself fails
    // after the warnings are printed.
    await push({validateOnly: true, profile: 'prod'});
    const out = warnSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(out.indexOf("[a] dataset 'X': no primary_key"))
        .toBeLessThan(out.indexOf("[b] dataset 'X': no primary_key"));
    expect(out.indexOf("[a] dataset 'X'")).toBeGreaterThan(-1);
  });
});


describe('a push error under a named profile names the profile', () => {
  const writeModel = (profile: string) => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/raw/tables/customer
        primary_key: [c_key]
        fields:
          - { name: key, expression: c_key }
      - name: Order
        source: //bigquery.googleapis.com/projects/test-project/datasets/raw/tables/orders
        primary_key: [o_key]
        fields:
          - { name: key, expression: o_key }
    relationships:
      - name: placed_by
        from: Order
        to: Customer
        from_columns: [o_cust]
        to_columns: [c_key]
`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), profile);
  };

  // The profile's key leaves the relationship's to_columns covering none.
  test('a key the profile sets', async () => {
    writeModel(`name: prod
entities:
  - name: Customer
    source: //bigquery.googleapis.com/projects/test-project/datasets/prod/tables/customer
    primary_key: [cust_id]
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const code = await push({validateOnly: true, profile: 'prod'});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain(
            "relationship 'placed_by' in model 'commerce' (commerce, profile " +
            "'prod'): its to_columns");
  });

  // A legacy wrapper is merged into the model file's text, and the merged text
  // is what fails to load.
  test('a legacy wrapper whose merged text does not load', async () => {
    writeModel('name: prod\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.rmSync(path.join(eg, 'commerce.profile.prod.yaml'));
    fs.mkdirSync(path.join(eg, 'commerce.profiles'));
    fs.writeFileSync(path.join(eg, 'commerce.profiles', 'legacy.yaml'), `semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: SELECT * FROM customer
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const code = await push({validateOnly: true, profile: 'legacy'});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("Error: profile 'legacy': Model document 'commerce'");
  });

  // A model file that does not load on its own is the loader's error, which
  // names the document itself.
  test('a model file that does not load alone', async () => {
    writeModel('name: prod\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: not a table
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const code = await push({validateOnly: true, profile: 'prod'});

    expect(code).toBe(1);
    const errors = errorSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(errors).toContain("Error: Model document 'commerce': ");
    // The error says why a profile that would complete the model does not.
    expect(errors).toContain(
        "(under profile 'prod', the model file must load on its own before " +
        'the profile applies)');
  });

  // The profile's source is read by the loader's source reader, so it is
  // rejected as the same source in a model file is.
  test('a source the loader rejects', async () => {
    writeModel(`name: prod
entities:
  - name: Customer
    source: prod.customer
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const code = await push({validateOnly: true, profile: 'prod'});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain(
            "[commerce] profile 'prod': entity 'Customer': bare table name " +
            "'prod.customer' is not a valid source");
  });
});


// The profile file is applied to the model file loaded on its own, so a model
// file that does not load alone stops the push, even where the profile would
// complete it. The YAML merge loaded the merged text instead.
describe('a catalog-only push of a profile file loads the model file alone', () => {
  test('a half-bound join in the model file is reported', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    const BQ = (t: string) =>
        `//bigquery.googleapis.com/projects/test-project/datasets/raw/tables/${t}`;
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: ${BQ('customer')}
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }
      - name: Order
        source: ${BQ('orders')}
        primary_key: [key]
        fields:
          - { name: key, expression: o_key }
    relationships:
      - name: placed_by
        from: Order
        to: Customer
        from_columns: [o_cust]
`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), `name: prod
relationships:
  - name: placed_by
    to_columns: [c_key]
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    const deploySpy = spyOn(kc, 'deployKnowledgeCatalog');

    const code = await push({validateOnly: true, profile: 'prod'});

    expect(code).toBe(1);
    expect(deploySpy).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain(
        "relationship 'placed_by': from_columns and to_columns must be given " +
        'together');
  });
});


// Until each graph generator emits its own engine's text, a field's
// `expression` is what lands in the DDL, so pruning judges that text too.
describe('a Spanner graph push prunes by the text the generator emits', () => {
  test('a field whose emitted text reads an unbound field is dropped', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: //spanner.googleapis.com/projects/test-project/instances/i/databases/db/propertyGraphs/g
    entities:
      - name: orders
        source: //spanner.googleapis.com/projects/test-project/instances/i/databases/db/tables/orders
        primary_key: [order_id]
        fields:
          - { name: order_id, expression: order_id }
          - { name: gross, expression: gross }
          - { name: tax }
          - name: net
            expression:
              dialects:
                - { dialect: SPANNER, expression: "orders.gross" }
                - { dialect: ANSI_SQL, expression: "orders.gross - orders.tax" }
`);
    spyOn(console, 'warn').mockImplementation(() => {});
    spyOn(console, 'log').mockImplementation(() => {});
    const deploySpy = spyOn(spannerLeg, 'deploySpanner').mockResolvedValue(
        {success: true, warnings: [], ddl: [], deployed: 0} as any);

    const code = await push({validateOnly: true, kc: false});

    expect(code).toBe(0);
    const orders = deploySpy.mock.calls[0][0][0].model.entities[0];
    expect(orders.fields.map(f => f.name)).toEqual(['order_id', 'gross']);
  });
});


// A pruned push needs every concrete entity bound. A profile file applies to
// the model file loaded on its own, so push checks its sources itself. A scope
// with a graph model and a profile file on another model reaches the check.
describe('a pruned push checks the sources a profile file leaves out', () => {
  test('a concrete entity with no source is reported', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(path.join(eg, 'a.profiles'), {recursive: true});
    const SPANNER = 'projects/test-project/instances/i/databases/db';
    fs.writeFileSync(path.join(eg, 'a.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: a
    deployments:
      - name: g
        target: //spanner.googleapis.com/${SPANNER}/propertyGraphs/g
    entities:
      - name: X
        source: //spanner.googleapis.com/${SPANNER}/tables/X
        primary_key: [id]
        fields:
          - { name: id, expression: id }
`);
    fs.writeFileSync(path.join(eg, 'a.profiles', 'prod.yaml'), `semantic_model:
  - name: a
    entities:
      - name: X
        source: //spanner.googleapis.com/${SPANNER}/tables/X2
`);
    fs.writeFileSync(path.join(eg, 'b.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: b
    entities:
      - name: Y
        primary_key: [id]
        fields:
          - { name: id, expression: id }
`);
    fs.writeFileSync(path.join(eg, 'b.profile.prod.yaml'), `name: prod
entities:
  - name: Y
    fields:
      - { name: id, expression: y_id }
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(spannerLeg, 'deploySpanner').mockResolvedValue(
        {success: true, warnings: [], ddl: [], deployed: 0} as any);
    const deploySpy = spyOn(kc, 'deployKnowledgeCatalog');

    const code = await push({validateOnly: true, profile: 'prod'});

    expect(code).toBe(1);
    expect(deploySpy).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain(
        "[b] profile 'prod': entity 'Y' has no source in this profile or in " +
        'the model file');
  });
});


// A push that deploys a graph prunes unbound fields, which can remove the very
// field an inheritance rule is about. The rules run on the model before
// pruning, so a graph push and a catalog-only push give the same answer.
describe('a graph push checks inheritance before pruning', () => {
  const GRAPH_MODEL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: //bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g
    entities:
      - name: customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/d/tables/customer
        primary_key: [id]
        fields:
          - { name: id, datatype: Integer, expression: id }
          - { name: name, datatype: String, expression: cust_name }
      - name: vip
        extends: [customer]
        source: //bigquery.googleapis.com/projects/test-project/datasets/d/tables/vip
        primary_key: [id]
        fields:
          - { name: name, datatype: Integer, description: VIP name }
`;

  test('a redefined inherited field with no column is reported', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), GRAPH_MODEL);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const code = await push({validateOnly: true, kc: false});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("field 'name' is inherited, so it may only be rebound to a column");
  });

  test('the error names the profile it was found under', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(path.join(eg, 'commerce.profiles'), {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), GRAPH_MODEL);
    fs.writeFileSync(
        path.join(eg, 'commerce.profiles', 'legacy.yaml'), `semantic_model:
  - name: commerce
    entities:
      - name: customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/d2/tables/customer
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});

    const code =
        await push({validateOnly: true, kc: false, profile: 'legacy'});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("(commerce, profile 'legacy')");
  });
});
