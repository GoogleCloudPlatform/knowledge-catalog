// Tests for `kcV2Aspects()` and forwarding of `v2Aspects` through `kcmd push`
// and `kcmd pull`, and for the file copies a push stores and a pull writes
// back (src/tool/commands.ts,
// src/libts/semantic/deploy_knowledge_catalog.ts).

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient, Entry} from '../../src/libts/gcp/dataplex';
import {SemanticModelLayout} from '../../src/libts/layouts/semantic-model';
import * as bqLeg from '../../src/libts/semantic/deploy_bigquery';
import * as kc from '../../src/libts/semantic/deploy_knowledge_catalog';
import * as spannerLeg from '../../src/libts/semantic/deploy_spanner';
import {SemanticModel} from '../../src/libts/semantic/ir';
import * as kcEmit from '../../src/libts/semantic/knowledge_catalog';
import * as loaderMod from '../../src/libts/semantic/loader';
import * as osi from '../../src/libts/semantic/osi_converter';
import * as pullKc from '../../src/libts/semantic/pull_kc';
import {createSemanticRuntimes} from '../../src/libts/semantic/runtime/runtime';
import * as sqlParser from '../../src/libts/semantic/sql_parser';
import * as validateMod from '../../src/libts/semantic/validate';
import {kcV2Aspects, profiles, pull, push} from '../../src/tool/commands';

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
  // A call no test stubs fails instead of reaching the network.
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
  // With KC_V2_ASPECTS off, push checks that the file-copy type exists.
  spyOn(CatalogClient.prototype, 'getEntryType')
      .mockResolvedValue({status: 200, result: {}} as any);
  spyOn(CatalogClient.prototype, 'getAspectType')
      .mockResolvedValue({status: 200, result: {}} as any);
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

describe('push prints Knowledge Catalog warnings', () => {
  const RESULT = {
    success: true, created: 1, updated: 0, deleted: 0, linked: 0, unlinked: 0,
    warnings: ['a relationship is skipped'], plan: [],
  };

  test('before the first catalog write, once each', async () => {
    writeWorkspace();
    const events: string[] = [];
    spyOn(console, 'warn').mockImplementation((m: any) => {
      events.push(String(m));
    });
    spyOn(kc, 'deployKnowledgeCatalog')
        .mockImplementation(async (_models, _ctx, opts) => {
          opts.onWarnings?.(RESULT.warnings);
          events.push('first catalog write');
          return RESULT;
        });

    expect(await push({})).toBe(0);
    expect(events).toEqual([
      'Warning: a relationship is skipped',
      'first catalog write',
    ]);
  });

  test('under --validate-only, from the result', async () => {
    writeWorkspace();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    spyOn(kc, 'deployKnowledgeCatalog').mockResolvedValue(RESULT);

    expect(await push({validateOnly: true})).toBe(0);
    expect(warn.mock.calls.map(c => String(c[0]))).toEqual([
      'Warning: a relationship is skipped',
    ]);
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

  test('a metric reading an unbound field and a non-existent field is reported before pruning drops it', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: default
        target: //bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g
    entities:
      - name: customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/d/tables/customer
        primary_key: [id]
        fields:
          - { name: id, datatype: Integer, expression: id }
          - { name: credit_limit, datatype: Decimal }
    metrics:
      - name: bad_metric
        expression:
          dialects:
            - dialect: BIGQUERY
              expression: SUM(customer.credit_limit) + SUM(customer.non_existent)
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const code = await push({validateOnly: true, kc: false});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("expression references 'customer.non_existent', but entity 'customer' has no field 'non_existent'");
  });

  test('an unparseable metric expression prints its unreadable-SQL warning only once on push, and entry points load the SQL engine', async () => {
    writeWorkspace();
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: default, target: //bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g }
    entities:
      - name: customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/d/tables/customer
        primary_key: [id]
        fields: [{ name: id, datatype: Integer, expression: id }]
    metrics:
      - name: broken_metric
        entity: customer
        expression: "SUM(customer.id"
`);
    spyOn(validateMod, 'validateBigQueryDataSources').mockResolvedValue([]);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const order: string[] = [];
    const origLoad = sqlParser.loadSqlEngine;
    const spy = spyOn(sqlParser, 'loadSqlEngine').mockImplementation(async () => {
      order.push('loadSqlEngine');
      return origLoad();
    });
    const origLoadModels = loaderMod.loadSemanticModels;
    spyOn(loaderMod, 'loadSemanticModels').mockImplementation((...args) => {
      order.push('loadSemanticModels');
      return origLoadModels(...args);
    });
    const origExprRefs = validateMod.validateExpressionReferences;
    spyOn(validateMod, 'validateExpressionReferences')
        .mockImplementation((...args) => {
          order.push('validateExpressionReferences');
          return origExprRefs(...args);
        });
    const origPushReqs = validateMod.validatePushRequirements;
    spyOn(validateMod, 'validatePushRequirements')
        .mockImplementation((...args) => {
          order.push('validatePushRequirements');
          return origPushReqs(...args);
        });

    expect(await push({validateOnly: true, kc: false})).toBe(0);
    expect(warnSpy.mock.calls.map(c => String(c[0])).filter(m => m.includes('could not read its SQL')))
        .toEqual([
          "Warning: metric 'broken_metric' in model 'commerce' (commerce): kcmd " +
          'could not read its SQL, so the fields it reads were not checked.',
        ]);
    expect(order).toEqual([
      'loadSqlEngine',
      'loadSemanticModels',
      'validateExpressionReferences',
      'validatePushRequirements',
      'validateExpressionReferences',
    ]);
    expect(spy).toHaveBeenCalledTimes(1);

    await profiles();
    await pullKc.pullKnowledgeCatalog(
        {async *listEntries() {}} as any, {project: 'p', location: 'us', entryGroup: 'eg'});
    await createSemanticRuntimes();
    expect(spy).toHaveBeenCalledTimes(4);
  });
});


// ---------------------------------------------------------------------------
// The file copy: push stores each model and profile file, pull writes it back.
// ---------------------------------------------------------------------------

// A model file whose comments, key order and flow style the serializer would
// not reproduce.
const ROUND_TRIP_MODEL = `# The commerce model. Comments survive the round trip.
version: "0.2.0.dev0/google"
semantic_model:
  - description: Orders and customers   # description before name
    name: commerce
    deployments:
      - name: prod
        target: //bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g
    entities:
      - name: Customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/d/tables/customer
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }   # flow style
`;

const ROUND_TRIP_PROFILE = `# Production bindings.
name: prod
entities:
  - name: Customer
    source: //bigquery.googleapis.com/projects/test-project/datasets/prod/tables/customer
`;

function entryGroupDir(): string {
  return path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
}

function writeRoundTripWorkspace(profile = ROUND_TRIP_PROFILE): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.test-project.us.commerce_eg\n');
  fs.mkdirSync(entryGroupDir(), {recursive: true});
  fs.writeFileSync(path.join(entryGroupDir(), 'commerce.yaml'), ROUND_TRIP_MODEL);
  fs.writeFileSync(
      path.join(entryGroupDir(), 'commerce.profile.prod.yaml'), profile);
}

// An in-memory catalog that push writes into and pull reads from. Every
// client call the two legs make is answered here, and fetch throws, so no
// test reaches the network. `missingType` names a custom type the project
// lacks.
function fakeCatalog(opts: {missingType?: string} = {}) {
  const entries = new Map<string, Entry>();
  const P = CatalogClient.prototype;
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
  const typeResult = async (_p: string, _l: string, id: string) =>
      id === opts.missingType ? {status: 404, message: 'not found'} :
                                {status: 200, result: {}};
  const entryType =
      spyOn(P, 'getEntryType').mockImplementation(typeResult as any);
  const aspectType =
      spyOn(P, 'getAspectType').mockImplementation(typeResult as any);
  // A list returns entries without their aspects.
  const list = spyOn(P, 'listEntries').mockImplementation(async function*() {
    for (const e of entries.values()) {
      yield {name: e.name, entryType: e.entryType, parentEntry: e.parentEntry};
    }
  } as any);
  const create = spyOn(P, 'createEntry')
                     .mockImplementation(async (...args: any[]) => {
                       const entry: Entry = args[4];
                       if (entries.has(entry.name)) return {status: 409};
                       entries.set(entry.name, structuredClone(entry));
                       return {status: 200, result: entry};
                     });
  spyOn(P, 'updateEntry').mockImplementation(async (entry: Entry) => {
    entries.set(entry.name, structuredClone(entry));
    return {status: 200, result: entry};
  });
  spyOn(P, 'deleteEntry').mockImplementation(async (...args: any[]) => {
    for (const name of entries.keys()) {
      if (name.endsWith(`/entries/${args[3]}`)) entries.delete(name);
    }
    return {status: 200};
  });
  // A lookup returns only the aspects it asks for.
  spyOn(P, 'lookupEntry')
      .mockImplementation(async (_p: string, _l: string, name: string,
                                 aspectTypes?: string[]) => {
        const e = entries.get(name);
        if (!e) return {status: 404, message: 'not found'};
        const aspects = Object.fromEntries(
            Object.entries(e.aspects ?? {})
                .filter(([, a]) => (aspectTypes ?? []).includes(a.aspectType!)));
        return {status: 200, result: {...structuredClone(e), aspects}};
      });
  spyOn(P, 'lookupEntryLinks')
      .mockImplementation(async () => ({status: 200, result: []}));
  return {entries, create, list, entryType, aspectType};
}

// The file copies the fake catalog holds, by file name.
function storedCopies(entries: Map<string, Entry>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries.values()) {
    if (!e.entryType.endsWith('/semantic-model-file')) continue;
    const data = Object.values(e.aspects ?? {})[0].data!;
    out[data.fileName] = data.content;
  }
  return out;
}

function messages(spy: any): string {
  return spy.mock.calls.map((c: any[]) => c.map(String).join(' ')).join('\n');
}

describe('the file copy round trip', () => {
  test('push then pull returns the model file and profile file byte for byte',
       async () => {
         writeRoundTripWorkspace();
         const {entries} = fakeCatalog();
         spyOn(validateMod, 'validateBigQueryDataSources').mockResolvedValue([]);
         spyOn(validateMod, 'validateBigQueryActionStatements')
             .mockResolvedValue([]);
         spyOn(bqLeg, 'deployBigQuery')
             .mockResolvedValue(
                 {success: true, deployed: 1, ddl: [], warnings: []} as any);

         expect(await push({})).toBe(0);
         expect(Object.keys(storedCopies(entries)).sort()).toEqual([
           'commerce.profile.prod.yaml',
           'commerce.yaml',
         ]);

         // The local files change, then the pull puts them back.
         const modelPath = path.join(entryGroupDir(), 'commerce.yaml');
         const profilePath =
             path.join(entryGroupDir(), 'commerce.profile.prod.yaml');
         fs.writeFileSync(modelPath, 'version: "0.2.0.dev0/google"\n');
         fs.rmSync(profilePath);
         const serialize = spyOn(osi, 'serializeModel');

         expect(await pull()).toBe(0);
         expect(fs.readFileSync(modelPath, 'utf8')).toBe(ROUND_TRIP_MODEL);
         expect(fs.readFileSync(profilePath, 'utf8')).toBe(ROUND_TRIP_PROFILE);
         expect(serialize).not.toHaveBeenCalled();
       });

  test('a push with --no-profile still stores the profile copies', async () => {
    writeRoundTripWorkspace();
    const {entries} = fakeCatalog();

    expect(await push({profile: false})).toBe(0);
    expect(storedCopies(entries)).toEqual({
      'commerce.yaml': ROUND_TRIP_MODEL,
      'commerce.profile.prod.yaml': ROUND_TRIP_PROFILE,
    });
  });

  test('a push into a project without the file-copy type writes nothing',
       async () => {
         writeRoundTripWorkspace();
         const {create} = fakeCatalog({missingType: 'semantic-model-file'});
         const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

         expect(await push({profile: false})).toBe(1);
         expect(messages(errorSpy))
             .toContain(
                 'Custom type \'semantic-model-file\' not found in project ' +
                 '\'test-project\'; run \'kcmd init --semantic-model\' first.');
         expect(create).not.toHaveBeenCalled();
       });

  // A push that deploys no graph runs the catalog leg's local checks first.
  test('a catalog-only push reports a local error before a failed file-copy ' +
           'type lookup',
       async () => {
         writeRoundTripWorkspace();
         fs.writeFileSync(
             path.join(entryGroupDir(), 'commerce.yaml'),
             ROUND_TRIP_MODEL.replace(
                 'primary_key: [key]', 'primary_key: [key]\n        bogus: 1'));
         const {entryType} =
             fakeCatalog({missingType: 'semantic-model-file'});
         for (const validateOnly of [true, false]) {
           const errorSpy =
               spyOn(console, 'error').mockImplementation(() => {});
           expect(await push({profile: false, validateOnly})).toBe(1);
           expect(messages(errorSpy)).toContain('bogus');
           expect(messages(errorSpy)).not.toContain('not found in project');
         }
         expect(entryType).not.toHaveBeenCalled();
       });

  test('a file over the aspect size limit fails in the preflight, naming it',
       async () => {
         // The limit production enforces on one aspect's data.
         expect(kc.MAX_ASPECT_DATA_BYTES).toBe(122_880);
         writeRoundTripWorkspace(
             `${ROUND_TRIP_PROFILE}# ${'x'.repeat(kc.MAX_ASPECT_DATA_BYTES)}\n`);
         const {create, list} = fakeCatalog();
         const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

         expect(await push({profile: false})).toBe(1);
         expect(messages(errorSpy))
             .toContain(
                 'file \'commerce.profile.prod.yaml\' is too large to store ' +
                 'in Knowledge Catalog');
         // The check is local, so the push stops before it reads the catalog.
         expect(list).not.toHaveBeenCalled();
         expect(create).not.toHaveBeenCalled();
       });
});


describe('the file copy across pushes and layouts', () => {
  test('a legacy profiles directory comes back byte for byte', async () => {
    const legacy = `# A legacy wrapper.
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/prod/tables/customer
`;
    writeRoundTripWorkspace();
    fs.rmSync(path.join(entryGroupDir(), 'commerce.profile.prod.yaml'));
    const legacyPath = path.join(entryGroupDir(), 'commerce.profiles', 'prod.yaml');
    fs.mkdirSync(path.dirname(legacyPath));
    fs.writeFileSync(legacyPath, legacy);
    const {entries} = fakeCatalog();

    expect(await push({profile: false})).toBe(0);
    expect(Object.keys(storedCopies(entries)).sort())
        .toEqual(['commerce.profiles/prod.yaml', 'commerce.yaml']);

    fs.rmSync(path.dirname(legacyPath), {recursive: true});
    expect(await pull()).toBe(0);
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacy);
  });

  test('a re-push updates a changed copy and deletes a removed one',
       async () => {
         writeRoundTripWorkspace();
         const {entries} = fakeCatalog();
         expect(await push({profile: false})).toBe(0);

         const changed = ROUND_TRIP_MODEL.replace(
             'Orders and customers', 'Orders and their customers');
         fs.writeFileSync(path.join(entryGroupDir(), 'commerce.yaml'), changed);
         fs.rmSync(path.join(entryGroupDir(), 'commerce.profile.prod.yaml'));
         expect(await push({profile: false})).toBe(0);

         expect(storedCopies(entries)).toEqual({'commerce.yaml': changed});
       });

  // Pull writes a model to the file its name implies, so a copy stored under
  // another file name is not the model file.
  test('a model file named apart from its model is rebuilt, not lost',
       async () => {
         fs.writeFileSync(
             path.join(dir, 'catalog.yaml'),
             'scope: semantic-model.test-project.us.commerce_eg\n');
         fs.mkdirSync(entryGroupDir(), {recursive: true});
         const shop = path.join(entryGroupDir(), 'shop.yaml');
         fs.writeFileSync(shop, ROUND_TRIP_MODEL);
         const {entries} = fakeCatalog();
         const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
         expect(await push({profile: false})).toBe(0);
         expect(Object.keys(storedCopies(entries))).toEqual(['shop.yaml']);

         fs.rmSync(shop);
         expect(await pull()).toBe(0);
         expect(messages(warnSpy))
             .toContain(
                 'the stored copies of model \'commerce\' hold no ' +
                 '\'commerce.yaml\', so the model file is rebuilt');
         const rebuilt = path.join(entryGroupDir(), 'commerce.yaml');
         expect(fs.readFileSync(rebuilt, 'utf8')).toContain('name: commerce');
       });

  test('with KC_V2_ASPECTS on, push reads no profile file and stores no copy',
       async () => {
         process.env.KC_V2_ASPECTS = '1';
         writeRoundTripWorkspace('name: [unterminated\n');
         const {entries} = fakeCatalog();

         expect(await push({profile: false})).toBe(0);
         expect(storedCopies(entries)).toEqual({});
       });
});


describe('pull with stored file copies', () => {
  const COMMERCE: SemanticModel =
      {name: 'commerce', entities: [], relationships: [], metrics: []};
  const MODEL_COPY = {fileName: 'commerce.yaml', content: ROUND_TRIP_MODEL};
  const PROD_COPY = {
    fileName: 'commerce.profile.prod.yaml',
    content: ROUND_TRIP_PROFILE,
  };
  const pulled = (rawFiles: {fileName: string; content: string}[]) =>
      spyOn(pullKc, 'pullKnowledgeCatalog')
          .mockResolvedValue({models: [COMMERCE], rawFiles, warnings: []});
  const local = (name: string) => path.join(entryGroupDir(), name);
  // How a message names a local file: relative to the workspace.
  const shown = (name: string) =>
      path.join('catalog', 'EntryGroups', 'commerce_eg', name);
  // A workspace holding the model file and two profile files, of which the
  // catalog has only `prod`.
  const withStaleProfile = () => {
    writeRoundTripWorkspace('name: prod\n');
    fs.writeFileSync(local('commerce.profile.dev.yaml'), 'name: dev\n');
  };

  test('a file name that is absolute, climbs out, or names another model is ' +
           'skipped with a warning',
       async () => {
         writeRoundTripWorkspace();
         const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
         pulled([
           {fileName: '/tmp/commerce.yaml', content: 'x'},
           {fileName: 'commerce.profile/../../escaped.yaml', content: 'x'},
           {fileName: 'other.yaml', content: 'x'},
           MODEL_COPY,
         ]);

         expect(await pull()).toBe(0);
         const warned = messages(warnSpy);
         for (const name of ['/tmp/commerce.yaml',
                             'commerce.profile/../../escaped.yaml',
                             'other.yaml']) {
           expect(warned).toContain(`skipped '${name}' from the catalog`);
         }
         expect(fs.existsSync(path.join(dir, 'catalog', 'escaped.yaml')))
             .toBe(false);
         expect(fs.existsSync(local('other.yaml'))).toBe(false);
         expect(fs.readFileSync(local('commerce.yaml'), 'utf8'))
             .toBe(ROUND_TRIP_MODEL);
       });

  test('a local profile file the pull did not return is named and kept',
       async () => {
         withStaleProfile();
         const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
         pulled([MODEL_COPY, PROD_COPY]);

         expect(await pull()).toBe(0);
         expect(messages(warnSpy))
             .toContain(
                 `local profile file ${shown('commerce.profile.dev.yaml')} ` +
                 `is not in the catalog`);
         expect(fs.existsSync(local('commerce.profile.dev.yaml'))).toBe(true);
         expect(fs.readFileSync(local('commerce.profile.prod.yaml'), 'utf8'))
             .toBe(ROUND_TRIP_PROFILE);
       });

  test('under --force-remove it is deleted', async () => {
    withStaleProfile();
    pulled([MODEL_COPY, PROD_COPY]);

    expect(await pull({forceRemove: true})).toBe(0);
    expect(fs.existsSync(local('commerce.profile.dev.yaml'))).toBe(false);
    expect(fs.existsSync(local('commerce.profile.prod.yaml'))).toBe(true);
  });

  test('under --dry-run nothing is written or deleted', async () => {
    withStaleProfile();
    pulled([{...MODEL_COPY, content: 'changed\n'}, PROD_COPY]);

    expect(await pull({dryRun: true, forceRemove: true})).toBe(0);
    expect(fs.readFileSync(local('commerce.yaml'), 'utf8'))
        .toBe(ROUND_TRIP_MODEL);
    expect(fs.readFileSync(local('commerce.profile.prod.yaml'), 'utf8'))
        .toBe('name: prod\n');
    expect(fs.existsSync(local('commerce.profile.dev.yaml'))).toBe(true);
  });

  test('with no copies, every local profile file is kept and named, even ' +
           'under --force-remove',
       async () => {
         withStaleProfile();
         const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
         const serialize = spyOn(osi, 'serializeModel');
         pulled([]);

         expect(await pull({forceRemove: true})).toBe(0);
         // The model is rebuilt from the aspects.
         expect(serialize).toHaveBeenCalledTimes(1);
         expect(messages(warnSpy))
             .toContain(
                 `the catalog holds no copy of the profile files, so pull ` +
                 `keeps the local ones: ${shown('commerce.profile.dev.yaml')}, ` +
                 `${shown('commerce.profile.prod.yaml')}.`);
         expect(fs.existsSync(local('commerce.profile.dev.yaml'))).toBe(true);
         expect(fs.existsSync(local('commerce.profile.prod.yaml'))).toBe(true);
       });

  // A teammate converts the model to the vanilla flavor and pushes. Pull
  // writes that model file beside the local sibling profile file.
  test('a local sibling profile file beside a pulled vanilla model file is ' +
           'named, and deleted under --force-remove',
       async () => {
         writeRoundTripWorkspace();
         const vanilla = 'version: "0.2.0.dev0"\nsemantic_model:\n' +
             '  - name: commerce\n    datasets: []\n';
         const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
         pulled([{fileName: 'commerce.yaml', content: vanilla}]);

         expect(await pull()).toBe(0);
         expect(messages(warnSpy))
             .toContain(
                 `local profile file ${shown('commerce.profile.prod.yaml')} ` +
                 `is not in the catalog`);
         expect(fs.existsSync(local('commerce.profile.prod.yaml'))).toBe(true);

         expect(await pull({forceRemove: true})).toBe(0);
         expect(fs.existsSync(local('commerce.profile.prod.yaml'))).toBe(false);
         expect(fs.readFileSync(local('commerce.yaml'), 'utf8')).toBe(vanilla);
       });

  // Push ignores the older directory once sibling files exist, so a file
  // left there is stale too. The dry run reads the disk before any write and
  // the real run after, and both report the same removal.
  test('a profile file left in the older directory is removed by a dry run ' +
           'and a real run alike',
       async () => {
         writeRoundTripWorkspace();
         fs.rmSync(local('commerce.profile.prod.yaml'));
         fs.mkdirSync(local('commerce.profiles'));
         fs.writeFileSync(local('commerce.profiles/prod.yaml'), 'legacy\n');
         const logSpy = spyOn(console, 'log').mockImplementation(() => {});
         pulled([MODEL_COPY, PROD_COPY]);

         expect(await pull({dryRun: true, forceRemove: true})).toBe(0);
         expect(messages(logSpy))
             .toContain(`would remove ${shown('commerce.profiles/prod.yaml')}`);
         expect(fs.existsSync(local('commerce.profiles/prod.yaml'))).toBe(true);

         expect(await pull({forceRemove: true})).toBe(0);
         expect(messages(logSpy))
             .toContain(`  removed ${shown('commerce.profiles/prod.yaml')}`);
         expect(fs.existsSync(local('commerce.profiles/prod.yaml'))).toBe(false);
         expect(fs.readFileSync(local('commerce.profile.prod.yaml'), 'utf8'))
             .toBe(ROUND_TRIP_PROFILE);
       });

  test('a name that only looks like a profile file is skipped', async () => {
    writeRoundTripWorkspace();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const names = [
      // The layout reads this one as a second model.
      'commerce.profilex.yaml',
      // Push rejects a profile file with no name.
      'commerce.profile.yaml',
      // A profile name has no dot.
      'commerce.profile.a.b.yaml',
      // Push reads no subdirectory.
      'commerce.profiles/sub/deep.yaml',
      'commerce.profile.pr\0d.yaml',
      'commerce.profiles/pr\0d.yaml',
    ];
    pulled([...names.map(fileName => ({fileName, content: 'x'})), MODEL_COPY]);

    expect(await pull()).toBe(0);
    const warned = messages(warnSpy);
    for (const name of names) {
      expect(warned).toContain(`skipped '${name}' from the catalog`);
    }
    expect(fs.readdirSync(entryGroupDir()).sort()).toEqual([
      'commerce.profile.prod.yaml',
      'commerce.yaml',
    ]);
  });

  test('a name with a backslash `..` segment is skipped', async () => {
    writeRoundTripWorkspace();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const names = [
      'commerce.profile.a\\..\\..\\escaped.yaml',
      'commerce.profiles/..\\..\\escaped.yaml',
    ];
    pulled([...names.map(fileName => ({fileName, content: 'x'})), MODEL_COPY]);

    expect(await pull()).toBe(0);
    for (const name of names) {
      expect(messages(warnSpy)).toContain(`skipped '${name}' from the catalog`);
    }
    expect(fs.readdirSync(entryGroupDir()).sort()).toEqual([
      'commerce.profile.prod.yaml',
      'commerce.yaml',
    ]);
    expect(fs.readdirSync(path.join(dir, 'catalog')).sort()).toEqual([
      'EntryGroups',
    ]);
  });

  test('a name that does not end in .yaml is skipped', async () => {
    writeRoundTripWorkspace();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const names = [
      'commerce.profiles/prod.yml',
      'commerce.profile.dev.yml',
      'commerce.yml',
    ];
    pulled([...names.map(fileName => ({fileName, content: 'x'})), MODEL_COPY]);

    expect(await pull()).toBe(0);
    for (const name of names) {
      expect(messages(warnSpy)).toContain(`skipped '${name}' from the catalog`);
    }
    expect(fs.existsSync(local('commerce.profiles'))).toBe(false);
    expect(fs.existsSync(local('commerce.yml'))).toBe(false);
  });

  // The model name comes from the catalog's model entry, which another
  // writer may have named so.
  test('a model name holding a path separator gets a flat model file',
       async () => {
         fs.writeFileSync(
             path.join(dir, 'catalog.yaml'),
             'scope: semantic-model.test-project.us.commerce_eg\n');
         fs.mkdirSync(entryGroupDir(), {recursive: true});
         const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
         spyOn(pullKc, 'pullKnowledgeCatalog').mockResolvedValue({
           models: [{...COMMERCE, name: 'sub/retail'}],
           rawFiles: [
             {fileName: 'sub/retail.profile.prod.yaml', content: 'name: prod\n'},
             {fileName: 'sub/retail.profiles/dev.yaml', content: 'name: dev\n'},
             {fileName: 'sub/retail.yaml', content: ROUND_TRIP_MODEL},
           ],
           warnings: [],
         });

         expect(await pull()).toBe(0);
         expect(fs.readdirSync(entryGroupDir())).toEqual(['sub_retail.yaml']);
         expect(fs.readFileSync(local('sub_retail.yaml'), 'utf8'))
             .toBe(ROUND_TRIP_MODEL);
         // Its profile files have no flat name to go to.
         for (const name of ['sub/retail.profile.prod.yaml',
                             'sub/retail.profiles/dev.yaml']) {
           expect(messages(warnSpy))
               .toContain(`skipped '${name}' from the catalog`);
         }
       });

  test('a model whose catalog name is an absolute path writes nothing',
       async () => {
         fs.writeFileSync(
             path.join(dir, 'catalog.yaml'),
             'scope: semantic-model.test-project.us.commerce_eg\n');
         fs.mkdirSync(entryGroupDir(), {recursive: true});
         const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
         const abs = path.join(dir, 'abs', 'retail');
         spyOn(pullKc, 'pullKnowledgeCatalog').mockResolvedValue({
           models: [{...COMMERCE, name: abs}],
           rawFiles: [{fileName: `${abs}.yaml`, content: ROUND_TRIP_MODEL}],
           warnings: [],
         });

         expect(await pull()).toBe(0);
         expect(messages(warnSpy))
             .toContain(`skipped '${abs}.yaml' from the catalog`);
         expect(fs.readdirSync(entryGroupDir())).toEqual([]);
         expect(fs.existsSync(`${abs}.yaml`)).toBe(false);
       });

  test('the summary counts new, updated and unchanged files apart, and an ' +
           'unchanged file is not rewritten',
       async () => {
         writeRoundTripWorkspace();
         fs.writeFileSync(local('commerce.yaml'), 'an older model file\n');
         fs.renameSync(
             local('commerce.profile.prod.yaml'),
             local('commerce.profile.dev.yaml'));
         const devCopy = {
           fileName: 'commerce.profile.dev.yaml',
           content: ROUND_TRIP_PROFILE,
         };
         const qaCopy = {
           fileName: 'commerce.profile.qa.yaml',
           content: 'name: qa\n',
         };
         const logSpy = spyOn(console, 'log').mockImplementation(() => {});
         pulled([MODEL_COPY, devCopy, PROD_COPY, qaCopy]);
         const written = spyOn(fs, 'writeFileSync');

         expect(await pull()).toBe(0);
         const out = messages(logSpy);
         expect(out).toContain(`  updated ${shown('commerce.yaml')}`);
         for (const [state, name] of [
                ['unchanged', 'commerce.profile.dev.yaml'],
                ['created', 'commerce.profile.prod.yaml'],
                ['created', 'commerce.profile.qa.yaml'],
              ]) {
           expect(out).toContain(`  ${state} ${shown(name)}`);
         }
         expect(out).toContain(
             'Wrote 2 new and 1 updated file(s); 1 unchanged.');
         expect(written.mock.calls.map(c => String(c[0]))).not.toContain(
             shown('commerce.profile.dev.yaml'));
       });

  test('profile files are written and deleted through the layout', async () => {
    withStaleProfile();
    const write = spyOn(SemanticModelLayout.prototype, 'writeProfileDocument');
    const remove = spyOn(SemanticModelLayout.prototype, 'removeProfileDocument');
    pulled([MODEL_COPY, PROD_COPY]);

    expect(await pull({forceRemove: true})).toBe(0);
    expect(write.mock.calls).toEqual([['commerce', 'prod', ROUND_TRIP_PROFILE]]);
    expect(remove.mock.calls).toEqual([['commerce', 'dev']]);
  });

  // Push ignores the older directory once sibling files exist, but the file
  // is still kept, so the warning names it too.
  test('with no copies, the kept files include the older profile directory',
       async () => {
         withStaleProfile();
         fs.mkdirSync(local('commerce.profiles'));
         fs.writeFileSync(local('commerce.profiles/old.yaml'), 'legacy\n');
         const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
         pulled([]);

         expect(await pull({forceRemove: true})).toBe(0);
         expect(messages(warnSpy))
             .toContain(
                 `keeps the local ones: ${shown('commerce.profile.dev.yaml')}, ` +
                 `${shown('commerce.profile.prod.yaml')}, ` +
                 `${shown('commerce.profiles/old.yaml')}.`);
         expect(fs.existsSync(local('commerce.profiles/old.yaml'))).toBe(true);
       });

  // The model name comes from the catalog's model entry, which another
  // writer may have named so.
  test('a model name with a `..` segment reaches no profile file outside ' +
           'the entry group',
       async () => {
         fs.writeFileSync(
             path.join(dir, 'catalog.yaml'),
             'scope: semantic-model.test-project.us.commerce_eg\n');
         fs.mkdirSync(entryGroupDir(), {recursive: true});
         const outside =
             path.join(dir, 'catalog', 'EntryGroups', 'other', 'retail.profiles');
         fs.mkdirSync(outside, {recursive: true});
         fs.writeFileSync(path.join(outside, 'prod.yaml'), 'name: prod\n');
         spyOn(pullKc, 'pullKnowledgeCatalog').mockResolvedValue({
           models: [{...COMMERCE, name: '../other/retail'}],
           rawFiles: [{fileName: '../other/retail.yaml', content: 'x'}],
           warnings: [],
         });

         expect(await pull({forceRemove: true})).toBe(0);
         expect(fs.existsSync(path.join(outside, 'prod.yaml'))).toBe(true);
       });

  test('with KC_V2_ASPECTS on, pull leaves local profile files unnamed',
       async () => {
         process.env.KC_V2_ASPECTS = '1';
         withStaleProfile();
         const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
         spyOn(pullKc, 'pullKnowledgeCatalog')
             .mockResolvedValue({models: [COMMERCE], warnings: []});

         expect(await pull({forceRemove: true})).toBe(0);
         expect(messages(warnSpy)).not.toContain('profile file');
         expect(fs.existsSync(local('commerce.profile.dev.yaml'))).toBe(true);
         expect(fs.existsSync(local('commerce.profile.prod.yaml'))).toBe(true);
       });
});


describe('the file-copy type is checked before anything is written', () => {
  test('a graph push into a project without it deploys no graph', async () => {
    writeRoundTripWorkspace();
    const {create} = fakeCatalog({missingType: 'semantic-model-file'});
    spyOn(validateMod, 'validateBigQueryDataSources').mockResolvedValue([]);
    spyOn(validateMod, 'validateBigQueryActionStatements').mockResolvedValue([]);
    const deployed =
        spyOn(bqLeg, 'deployBigQuery')
            .mockResolvedValue(
                {success: true, deployed: 1, ddl: [], warnings: []} as any);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    expect(await push({})).toBe(1);
    expect(messages(errorSpy))
        .toContain(
            'Error: Custom type \'semantic-model-file\' not found in project ' +
            '\'test-project\'; run \'kcmd init --semantic-model\' first.');
    expect(deployed).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  test('--validate-only fails in a project without it', async () => {
    writeRoundTripWorkspace();
    fakeCatalog({missingType: 'semantic-model-file'});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    expect(await push({validateOnly: true, profile: false})).toBe(1);
    expect(messages(errorSpy))
        .toContain(
            'Custom type \'semantic-model-file\' not found in project ' +
            '\'test-project\'; run \'kcmd init --semantic-model\' first.');
  });

  // Push looks the type up before any graph deploys, so the catalog leg does
  // not look it up a second time.
  test('a push looks it up once, and so does --validate-only', async () => {
    writeRoundTripWorkspace();
    const {entries, entryType, aspectType} = fakeCatalog();
    const lookups = () => [entryType, aspectType].map(
        spy => spy.mock.calls.filter(c => c[2] === 'semantic-model-file')
                   .length);

    expect(await push({profile: false})).toBe(0);
    expect(Object.keys(storedCopies(entries))).toHaveLength(2);
    expect(lookups()).toEqual([1, 1]);

    entryType.mockClear();
    aspectType.mockClear();
    expect(await push({validateOnly: true, profile: false})).toBe(0);
    expect(lookups()).toEqual([1, 1]);
  });

  test('with KC_V2_ASPECTS on, push stores no copy and does not look it up',
       async () => {
         process.env.KC_V2_ASPECTS = '1';
         writeRoundTripWorkspace();
         const lookup = spyOn(CatalogClient.prototype, 'getEntryType');

         expect(await push({validateOnly: true, profile: false})).toBe(0);
         expect(lookup).not.toHaveBeenCalled();
       });
});


describe('push checks each file before anything is stored', () => {
  test('a --no-profile push applies the profile file rules', async () => {
    writeRoundTripWorkspace('name: staging\n');
    const {create} = fakeCatalog();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    expect(await push({profile: false})).toBe(1);
    expect(messages(errorSpy))
        .toContain(
            'Error: Profile file \'commerce.profile.prod.yaml\' declares name ' +
            '\'staging\', which does not match filename suffix \'prod\'.');
    expect(create).not.toHaveBeenCalled();
  });

  test('a profile file that is not valid UTF-8 fails the push, naming it',
       async () => {
         writeRoundTripWorkspace();
         // A Latin-1 é in a comment.
         fs.writeFileSync(
             path.join(entryGroupDir(), 'commerce.profile.prod.yaml'),
             Buffer.concat([
               Buffer.from('# caf'), Buffer.from([0xe9]),
               Buffer.from(`\n${ROUND_TRIP_PROFILE}`)
             ]));
         const {create} = fakeCatalog();
         const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

         expect(await push({profile: false})).toBe(1);
         expect(messages(errorSpy))
             .toContain(
                 'Error: File \'commerce.profile.prod.yaml\' is not valid ' +
                 'UTF-8; push stores each model and profile file exactly as ' +
                 'written, so save it as UTF-8.');
         expect(create).not.toHaveBeenCalled();
       });

  test('a model file that is not valid UTF-8 fails the push too', async () => {
    writeRoundTripWorkspace();
    fs.writeFileSync(
        path.join(entryGroupDir(), 'commerce.yaml'),
        Buffer.concat(
            [Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\n'),
             Buffer.from(ROUND_TRIP_MODEL)]));
    fakeCatalog();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    expect(await push({profile: false})).toBe(1);
    expect(messages(errorSpy))
        .toContain('Error: File \'commerce.yaml\' is not valid UTF-8');
  });

  test('a file holding U+FFFD as text is stored as written', async () => {
    const profile = `# \uFFFD marks a lost character.\n${ROUND_TRIP_PROFILE}`;
    writeRoundTripWorkspace(profile);
    const {entries} = fakeCatalog();

    expect(await push({profile: false})).toBe(0);
    expect(storedCopies(entries)['commerce.profile.prod.yaml']).toBe(profile);
  });

  // The size and entry id checks need only the copies, so they run before
  // the graph leg too.
  for (const [label, setup, error] of [
         [
           'a file over the size limit',
           () => fs.appendFileSync(
               path.join(entryGroupDir(), 'commerce.profile.prod.yaml'),
               `# ${'x'.repeat(kc.MAX_ASPECT_DATA_BYTES)}\n`),
           'file \'commerce.profile.prod.yaml\' is too large to store',
         ],
         [
           'two file names that map to one entry id',
           () => {
             fs.rmSync(path.join(entryGroupDir(), 'commerce.profile.prod.yaml'));
             const legacy = path.join(entryGroupDir(), 'commerce.profiles');
             fs.mkdirSync(legacy);
             for (const name of ['a b.yaml', 'a_b.yaml']) {
               fs.writeFileSync(path.join(legacy, name), 'semantic_model: []\n');
             }
           },
           'both map to one entry id',
         ],
       ] as const) {
    test(`a graph push with ${label} deploys no graph`, async () => {
      writeRoundTripWorkspace();
      setup();
      const {create} = fakeCatalog();
      spyOn(validateMod, 'validateBigQueryDataSources').mockResolvedValue([]);
      spyOn(validateMod, 'validateBigQueryActionStatements')
          .mockResolvedValue([]);
      const deployed =
          spyOn(bqLeg, 'deployBigQuery')
              .mockResolvedValue(
                  {success: true, deployed: 1, ddl: [], warnings: []} as any);
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      expect(await push({})).toBe(1);
      expect(messages(errorSpy)).toContain(error);
      expect(deployed).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });
  }

  test('a --validate-only push of a file over the size limit fails',
       async () => {
         writeRoundTripWorkspace(
             `${ROUND_TRIP_PROFILE}# ${'x'.repeat(kc.MAX_ASPECT_DATA_BYTES)}\n`);
         fakeCatalog();
         const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

         expect(await push({validateOnly: true, profile: false})).toBe(1);
         expect(messages(errorSpy))
             .toContain(
                 'file \'commerce.profile.prod.yaml\' is too large to store ' +
                 'in Knowledge Catalog');
       });

  test('two profile files whose names map to one entry id fail the push',
       async () => {
         writeRoundTripWorkspace();
         fs.rmSync(path.join(entryGroupDir(), 'commerce.profile.prod.yaml'));
         const legacy = path.join(entryGroupDir(), 'commerce.profiles');
         fs.mkdirSync(legacy);
         fs.writeFileSync(path.join(legacy, 'a b.yaml'), 'semantic_model: []\n');
         fs.writeFileSync(path.join(legacy, 'a_b.yaml'), 'semantic_model: []\n');
         const {create} = fakeCatalog();
         const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

         expect(await push({profile: false})).toBe(1);
         expect(messages(errorSpy))
             .toContain(
                 'Error: files \'commerce.profiles/a b.yaml\' and ' +
                 '\'commerce.profiles/a_b.yaml\' both map to one entry id; ' +
                 'rename one of them');
         expect(create).not.toHaveBeenCalled();
       });

  // The catalog takes one model per entry group.
  test('with two model documents, that is reported before a profile file ' +
           'problem',
       async () => {
         writeRoundTripWorkspace('name: staging\n');
         fs.writeFileSync(
             path.join(entryGroupDir(), 'other.yaml'),
             MODEL_YAML.replace('name: commerce', 'name: other'));
         fakeCatalog();
         const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

         expect(await push({profile: false})).toBe(1);
         const errors = messages(errorSpy);
         expect(errors).toContain(
             'entry group \'commerce_eg\' would receive 2 models');
         expect(errors).not.toContain('does not match filename suffix');
       });
});


describe('a model file not named after its model', () => {
  const NOTE = 'Warning: [commerce] model file \'shop.yaml\' is not named ' +
      '\'commerce.yaml\'. The file copy can only return a model file named ' +
      'after its model, so pull will rebuild \'commerce.yaml\' from the ' +
      'catalog instead of returning this file; rename it \'commerce.yaml\' ' +
      'to keep it exact.';
  const writeShop = () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    fs.mkdirSync(entryGroupDir(), {recursive: true});
    fs.writeFileSync(path.join(entryGroupDir(), 'shop.yaml'), ROUND_TRIP_MODEL);
  };

  test('push warns once, naming the file and the model, and succeeds',
       async () => {
         writeShop();
         const {entries} = fakeCatalog();
         const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

         expect(await push({profile: false})).toBe(0);
         expect(warnSpy.mock.calls.map(c => String(c[0]))
                    .filter(w => w.includes('is not named')))
             .toEqual([NOTE]);
         expect(Object.keys(storedCopies(entries))).toEqual(['shop.yaml']);
       });

  test('no warning for a model file named after its model, or with ' +
           'KC_V2_ASPECTS on',
       async () => {
         writeRoundTripWorkspace();
         fakeCatalog();
         const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
         expect(await push({profile: false})).toBe(0);

         fs.rmSync(entryGroupDir(), {recursive: true});
         writeShop();
         process.env.KC_V2_ASPECTS = '1';
         expect(await push({profile: false})).toBe(0);
         expect(messages(warnSpy)).not.toContain('is not named');
       });
});


describe('the push id on every file copy', () => {
  // The push id each stored copy carries, by file name.
  const pushIds = (entries: Map<string, Entry>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const e of entries.values()) {
      if (!e.entryType.endsWith('/semantic-model-file')) continue;
      const data = Object.values(e.aspects ?? {})[0].data!;
      out[data.fileName] = data.pushId;
    }
    return out;
  };
  // Every file under the entry group directory, with its text.
  const localFiles = (): Record<string, string> => Object.fromEntries(
      (fs.readdirSync(entryGroupDir(), {recursive: true}) as string[])
          .map(f => path.join(entryGroupDir(), f))
          .filter(f => fs.statSync(f).isFile())
          .map(f => [f, fs.readFileSync(f, 'utf8')]));

  // Makes every write of the copy of `fileName` fail, or of every copy when
  // `fileName` is absent.
  const failCopyWrites = (entries: Map<string, Entry>, fileName?: string) => {
    const failing = (entry: Entry) => fileName === undefined ?
        entry.name.includes('/commerce.files.') :
        entry.name.endsWith(`/commerce.files.${fileName}`);
    spyOn(CatalogClient.prototype, 'createEntry')
        .mockImplementation(async (...args: any[]) => {
          const entry: Entry = args[4];
          if (failing(entry)) return {status: 500, message: 'injected'};
          if (entries.has(entry.name)) return {status: 409};
          entries.set(entry.name, structuredClone(entry));
          return {status: 200, result: entry};
        });
    spyOn(CatalogClient.prototype, 'updateEntry')
        .mockImplementation(async (entry: Entry) => {
          if (failing(entry)) return {status: 500, message: 'injected'};
          entries.set(entry.name, structuredClone(entry));
          return {status: 200, result: entry};
        });
  };
  const PARTIAL = 'the last push of model \'commerce\' did not finish: the ' +
      'catalog holds 1 of its 2 file copies, so pull writes nothing. Push ' +
      'again, then pull.';
  const NONE = 'the last push of model \'commerce\' did not finish: the ' +
      'catalog holds none of its file copies, so pull writes nothing. Push ' +
      'again, then pull.';

  // The labeled model entry lands, and no copy does.
  test('a first push whose copies all failed leaves a model pull refuses, ' +
           'and --force-remove writes and deletes nothing',
       async () => {
         writeRoundTripWorkspace();
         const {entries} = fakeCatalog();
         failCopyWrites(entries);
         expect(await push({profile: false})).toBe(1);
         expect(storedCopies(entries)).toEqual({});

         // A teammate's workspace, with another model file that
         // --force-remove would delete.
         fs.writeFileSync(
             path.join(entryGroupDir(), 'other.yaml'),
             MODEL_YAML.replace('name: commerce', 'name: other'));
         const before = localFiles();
         await expect(pull({forceRemove: true})).rejects.toThrow(NONE);
         expect(localFiles()).toEqual(before);
       });

  test('a --force-remove rename whose copies all failed leaves a model pull ' +
           'refuses',
       async () => {
         fs.writeFileSync(
             path.join(dir, 'catalog.yaml'),
             'scope: semantic-model.test-project.us.commerce_eg\n');
         fs.mkdirSync(entryGroupDir(), {recursive: true});
         const shop = path.join(entryGroupDir(), 'shop.yaml');
         fs.writeFileSync(
             shop, ROUND_TRIP_MODEL.replace('name: commerce', 'name: shop'));
         const {entries} = fakeCatalog();
         expect(await push({profile: false})).toBe(0);

         fs.rmSync(shop);
         fs.writeFileSync(
             path.join(entryGroupDir(), 'commerce.yaml'), ROUND_TRIP_MODEL);
         failCopyWrites(entries);
         expect(await push({profile: false, forceRemove: true})).toBe(1);
         expect(storedCopies(entries)).toEqual({});

         const before = localFiles();
         await expect(pull({forceRemove: true})).rejects.toThrow(NONE);
         expect(localFiles()).toEqual(before);
       });

  // The earlier push's copies are a finished set, so only the push id label
  // on the model entry tells.
  test('a re-push whose model entry landed and whose copies all failed ' +
           'leaves a model pull refuses, and --force-remove keeps the new ' +
           'files',
       async () => {
         writeRoundTripWorkspace();
         fs.rmSync(path.join(entryGroupDir(), 'commerce.profile.prod.yaml'));
         const {entries} = fakeCatalog();
         expect(await push({profile: false})).toBe(0);

         fs.writeFileSync(
             path.join(entryGroupDir(), 'commerce.yaml'),
             ROUND_TRIP_MODEL.replace('Orders and customers', 'Orders'));
         fs.writeFileSync(
             path.join(entryGroupDir(), 'commerce.profile.prod.yaml'),
             ROUND_TRIP_PROFILE);
         failCopyWrites(entries);
         expect(await push({profile: false})).toBe(1);
         expect(Object.keys(storedCopies(entries))).toEqual(['commerce.yaml']);

         const before = localFiles();
         await expect(pull({forceRemove: true}))
             .rejects.toThrow(
                 'the last push of model \'commerce\' did not finish: its ' +
                 'model entry and its file copies come from different ' +
                 'pushes, so pull writes nothing. Push again, then pull.');
         expect(localFiles()).toEqual(before);
       });

  // Dataplex deletes the old model entry's children with it, so a rename that
  // stops after that delete leaves no model at all.
  test('a --force-remove rename that stopped after deleting the old model ' +
           'leaves a catalog pull writes nothing from',
       async () => {
         fs.writeFileSync(
             path.join(dir, 'catalog.yaml'),
             'scope: semantic-model.test-project.us.commerce_eg\n');
         fs.mkdirSync(entryGroupDir(), {recursive: true});
         const shop = path.join(entryGroupDir(), 'shop.yaml');
         fs.writeFileSync(
             shop, ROUND_TRIP_MODEL.replace('name: commerce', 'name: shop'));
         const {entries} = fakeCatalog();
         expect(await push({profile: false})).toBe(0);

         fs.rmSync(shop);
         fs.writeFileSync(
             path.join(entryGroupDir(), 'commerce.yaml'), ROUND_TRIP_MODEL);
         // Every delete but the old model entry's fails.
         spyOn(CatalogClient.prototype, 'deleteEntry')
             .mockImplementation(async (...args: any[]) => {
               if (args[3] !== 'shop') return {status: 500, message: 'injected'};
               for (const name of [...entries.keys()]) {
                 const id = name.split('/').pop()!;
                 if (id === 'shop' || id.startsWith('shop.')) entries.delete(name);
               }
               return {status: 200};
             });
         expect(await push({profile: false, forceRemove: true})).toBe(1);
         expect(entries.size).toBe(0);

         const before = localFiles();
         const logSpy = spyOn(console, 'log').mockImplementation(() => {});
         expect(await pull()).toBe(0);
         expect(await pull({forceRemove: true})).toBe(0);
         expect(localFiles()).toEqual(before);
         expect(messages(logSpy).split('No semantic models found').length)
             .toBe(3);
       });

  // The copies that landed share one id, so only the count tells.
  test('a first push whose profile copy failed leaves a set pull refuses, ' +
           'and --force-remove keeps the profile file',
       async () => {
         writeRoundTripWorkspace();
         const {entries} = fakeCatalog();
         failCopyWrites(entries, 'commerce.profile.prod.yaml');
         expect(await push({profile: false})).toBe(1);
         expect(Object.keys(storedCopies(entries))).toEqual(['commerce.yaml']);

         const before = localFiles();
         await expect(pull({forceRemove: true})).rejects.toThrow(PARTIAL);
         expect(localFiles()).toEqual(before);
       });

  test('a push that adds a profile file whose copy failed leaves a set pull ' +
           'refuses, and --force-remove keeps the new file',
       async () => {
         writeRoundTripWorkspace();
         fs.rmSync(path.join(entryGroupDir(), 'commerce.profile.prod.yaml'));
         const {entries} = fakeCatalog();
         expect(await push({profile: false})).toBe(0);

         fs.writeFileSync(
             path.join(entryGroupDir(), 'commerce.profile.prod.yaml'),
             ROUND_TRIP_PROFILE);
         failCopyWrites(entries, 'commerce.profile.prod.yaml');
         expect(await push({profile: false})).toBe(1);

         const before = localFiles();
         await expect(pull({forceRemove: true})).rejects.toThrow(PARTIAL);
         expect(localFiles()).toEqual(before);
       });

  test('every copy one push stores carries the same id, and the next push ' +
           'another',
       async () => {
         writeRoundTripWorkspace();
         const {entries} = fakeCatalog();

         expect(await push({profile: false})).toBe(0);
         const first = pushIds(entries);
         expect(Object.keys(first).sort()).toEqual([
           'commerce.profile.prod.yaml',
           'commerce.yaml',
         ]);
         expect(first['commerce.yaml']).toEqual(expect.any(String));
         expect(first['commerce.profile.prod.yaml'])
             .toBe(first['commerce.yaml']);
         // Each copy also says how many copies its push stored.
         for (const e of entries.values()) {
           if (!e.entryType.endsWith('/semantic-model-file')) continue;
           expect(Object.values(e.aspects ?? {})[0].data!.pushFileCount)
               .toBe(2);
         }

         expect(await push({profile: false})).toBe(0);
         const second = pushIds(entries);
         expect(second['commerce.profile.prod.yaml'])
             .toBe(second['commerce.yaml']);
         expect(second['commerce.yaml']).not.toBe(first['commerce.yaml']);
       });

  test('a pull after a push that stopped partway writes and deletes nothing, ' +
           'even under --force-remove',
       async () => {
         writeRoundTripWorkspace();
         const {entries} = fakeCatalog();
         expect(await push({profile: false})).toBe(0);

         // The next push edits both files, and the profile copy's write fails.
         fs.writeFileSync(
             path.join(entryGroupDir(), 'commerce.yaml'),
             ROUND_TRIP_MODEL.replace('Orders and customers', 'Orders'));
         fs.writeFileSync(
             path.join(entryGroupDir(), 'commerce.profile.prod.yaml'),
             `${ROUND_TRIP_PROFILE}# edited\n`);
         spyOn(CatalogClient.prototype, 'updateEntry')
             .mockImplementation(async (entry: Entry) => {
               if (entry.name.endsWith(
                       '/commerce.files.commerce.profile.prod.yaml')) {
                 return {status: 500, message: 'injected'};
               }
               entries.set(entry.name, structuredClone(entry));
               return {status: 200, result: entry};
             });
         const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
         expect(await push({profile: false})).toBe(1);
         expect(messages(errorSpy))
             .toContain(
                 'The catalog may now lack some or all of this push\'s file ' +
                 'copies, so push again before you pull.');

         // A teammate's workspace, with a profile file the catalog lacks.
         fs.writeFileSync(
             path.join(entryGroupDir(), 'commerce.profile.dev.yaml'),
             'name: dev\n');
         const before = localFiles();

         await expect(pull({forceRemove: true}))
             .rejects.toThrow(
                 'the last push of model \'commerce\' did not finish: its ' +
                 'file copies in the catalog come from different pushes, so ' +
                 'pull writes nothing. Push again, then pull.');
         expect(localFiles()).toEqual(before);
       });
});


// Makes the fake catalog answer an update the way Dataplex does. The update
// writes each aspect `aspectKeys` names that the body carries. A key that ends
// in `@*` names the type's aspects at every field path. With
// `deleteMissingAspects` the update removes each named aspect the body leaves
// out, and the response lists that aspect under its key with an empty value,
// spelling the type's project as a number.
function patchLikeDataplex(entries: Map<string, Entry>): void {
  (CatalogClient.prototype.updateEntry as any).mockRestore();
  spyOn(CatalogClient.prototype as any, '_patch')
      .mockImplementation(async (...args: any[]) => {
        const [name, body, params] = args as [string, Entry, any];
        const stored = entries.get(name);
        if (!stored) return {status: 404, message: 'not found'};
        const aspects = {...stored.aspects};
        const answered: Record<string, any> = {};
        for (const listed of params.aspectKeys ?? []) {
          const keys = listed.endsWith('@*') ?
              [...Object.keys(aspects), ...Object.keys(body.aspects ?? {})]
                  .filter(k => k.startsWith(listed.slice(0, -1))) :
              [listed];
          for (const key of new Set(keys)) {
            if (body.aspects?.[key]) {
              aspects[key] = structuredClone(body.aspects[key]);
              answered[key] = {...body.aspects[key], createTime: 'now'};
            } else if (params.deleteMissingAspects && aspects[key]) {
              delete aspects[key];
              answered[key.replace(/^dataplex-types\./, '655216118709.')] = {};
            }
          }
        }
        entries.set(name, {...structuredClone(body), aspects});
        return {
          status: 200,
          result: {name, entryType: body.entryType, aspects: answered},
        };
      });
}

describe('a push whose update removes an aspect', () => {
  const WITH_INSTRUCTIONS = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        primary_key: [key]
        ai_context:
          instructions: Join orders on the customer key.
        fields:
          - { name: key, label: Customer ID }
      - name: Order
        primary_key: [id]
        fields:
          - { name: id }
    metrics:
      - name: customers
        description: Customers
        entity: Customer
        expression: COUNT(Customer.key)
`;
  // The instructions and the Order entity are gone, and the metric has a new
  // description.
  const WITHOUT_INSTRUCTIONS = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        primary_key: [key]
        fields:
          - { name: key, label: Customer ID }
    metrics:
      - name: customers
        description: Customer count
        entity: Customer
        expression: COUNT(Customer.key)
`;
  const named = (id: string) =>
      `projects/test-project/locations/us/entryGroups/commerce_eg/entries/${id}`;

  test('exits 0, removes the aspect, and finishes the writes and deletions ' +
           'after the update',
       async () => {
         writeWorkspace();
         const modelPath = path.join(entryGroupDir(), 'commerce.yaml');
         fs.writeFileSync(modelPath, WITH_INSTRUCTIONS);
         const {entries} = fakeCatalog();
         patchLikeDataplex(entries);
         const customer = () =>
             Object.keys(entries.get(named('commerce.entities.Customer'))!
                             .aspects ?? {});
         expect(await push({})).toBe(0);
         expect(customer()).toContain('dataplex-types.global.guidelines');

         fs.writeFileSync(modelPath, WITHOUT_INSTRUCTIONS);
         const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
         const code = await push({});

         expect(messages(errorSpy)).toBe('');
         expect(code).toBe(0);
         expect(customer()).not.toContain('dataplex-types.global.guidelines');
         // The metric is written after the entities, and an orphaned entry is
         // deleted last.
         expect(entries.get(named('commerce.metrics.customers'))!.entrySource
                    ?.description)
             .toBe('Customer count');
         expect(entries.has(named('commerce.entities.Order'))).toBe(false);
         expect(storedCopies(entries)['commerce.yaml'])
             .toBe(WITHOUT_INSTRUCTIONS);
       });

  test('with KC_V2_ASPECTS on, exits 0 and removes sql-expressions and a ' +
           'field\'s guidelines too',
       async () => {
         process.env.KC_V2_ASPECTS = '1';
         writeWorkspace();
         const modelPath = path.join(entryGroupDir(), 'commerce.yaml');
         fs.writeFileSync(modelPath, WITH_INSTRUCTIONS);
         const {entries} = fakeCatalog();
         patchLikeDataplex(entries);
         expect(await push({})).toBe(0);
         // Another writer adds two aspects that push owns under the flag.
         const customer = () =>
             entries.get(named('commerce/entities/Customer'))!.aspects!;
         customer()['dataplex-types.global.sql-expressions'] = {
           aspectType:
               'projects/dataplex-types/locations/global/aspectTypes/' +
               'sql-expressions',
           data: {},
         };
         customer()['dataplex-types.global.guidelines@Schema.key'] = {
           aspectType:
               'projects/dataplex-types/locations/global/aspectTypes/guidelines',
           path: 'Schema.key',
           data: {instructions: 'The key.', userManaged: true},
         };

         fs.writeFileSync(modelPath, WITHOUT_INSTRUCTIONS);
         const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
         const code = await push({});

         expect(messages(errorSpy)).toBe('');
         expect(code).toBe(0);
         expect(Object.keys(customer()).sort()).toEqual([
           'dataplex-types.global.schema',
           'dataplex-types.global.semantic-entity',
         ]);
         expect(entries.get(named('commerce/metrics/customers'))!.entrySource
                    ?.description)
             .toBe('Customer count');
         expect(entries.has(named('commerce/entities/Order'))).toBe(false);
       });
});


// Push applies a profile, loads its models and checks them. It prints each
// warning after `Warning:`, the summary of what pruning leaves unavailable after
// `Note:` and each error after `Error:`.
describe('push applies, loads and checks a profile', () => {
  const BQ = 'bigquery.googleapis.com/projects/acme/datasets/sales';
  const prints = (spy: any) => spy.mock.calls.map((c: any[]) => c.join(' '));

  // Writes the scope and its model file, and returns the entry group's
  // directory.
  function writeModel(text: string): string {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), text);
    return eg;
  }

  // Mocks the Knowledge Catalog leg, and returns the mock.
  function mockKc() {
    return spyOn(kc, 'deployKnowledgeCatalog').mockResolvedValue({
      success: true,
      warnings: [],
      created: 0,
      updated: 0,
      deleted: 0,
      linked: 0,
      unlinked: 0,
      plan: [],
    });
  }

  // Two deployments stop the push after pruning, before any live check.
  test('a pruned push notes the fields its profile leaves unbound', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: a, target: "//${BQ}/propertyGraphs/a" }
      - { name: b, target: "//${BQ}/propertyGraphs/b" }
    entities:
      - name: customer
        source: //${BQ}/tables/customer
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
          - { name: ltv }
`);
    expect(await push({validateOnly: true})).toBe(1);
    expect(prints(console.warn))
        .toContain("Note: profile 'default' leaves 1 field(s) unbound.");
  });

  // Unlike a field with no expression, a field with a blank one stops the push
  // when its model file loads.
  test('a push stops at a blank field expression and names the field', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: g, target: "//${BQ}/propertyGraphs/g" }
    entities:
      - name: customer
        source: //${BQ}/tables/customer
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
          - { name: ltv, expression: "" }
`);
    const kcSpy = mockKc();
    expect(await push({validateOnly: true})).toBe(1);
    expect(prints(console.error).join('\n'))
        .toContain("field 'customer.ltv': 'expression' is blank");
    expect(prints(console.warn)).toEqual([]);
    expect(kcSpy).not.toHaveBeenCalled();
  });

  // BigQuery read `-- x AS notes,` as a comment, so the graph deployed without
  // the field and with no error.
  test('a push stops at a field whose expression is only a comment', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: g, target: "//${BQ}/propertyGraphs/g" }
    entities:
      - name: customer
        source: //${BQ}/tables/customer
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
          - { name: notes, expression: "-- x" }
          - { name: ltv, expression: ltv }
`);
    const kcSpy = mockKc();
    expect(await push({validateOnly: true})).toBe(1);
    expect(prints(console.error).join('\n'))
        .toContain("field 'customer.notes': 'expression' is only a comment");
    expect(kcSpy).not.toHaveBeenCalled();
  });

  // Setting 'entity' on a metric with no SQL let the push pass, and the graph
  // dropped the metric.
  test('a push stops at a blank metric expression and does not ask for an entity', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: g, target: "//${BQ}/propertyGraphs/g" }
    entities:
      - name: customer
        source: //${BQ}/tables/customer
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
          - { name: ltv, expression: ltv }
    metrics:
      - { name: total, expression: "  " }
`);
    const kcSpy = mockKc();
    expect(await push({validateOnly: true})).toBe(1);
    const errors = prints(console.error).join('\n');
    expect(errors).toContain(
        "metric 'total': 'expression' is blank; write the metric's SQL");
    expect(errors).not.toContain("'entity'");
    expect(kcSpy).not.toHaveBeenCalled();
  });

  test('--transpile fills a vendor-only expression and drops the warning about it', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: purchase
        source: //${BQ}/tables/purchase
        primary_key: [p_id]
        fields:
          - { name: p_id, expression: p_id }
          - { name: amount, expression: amount }
    metrics:
      - name: positive_spend
        expression:
          dialects:
            - { dialect: SNOWFLAKE, expression: "SUM(IFF(purchase.amount > 0, purchase.amount, 0))" }
`);
    const kcSpy = mockKc();
    const metric = () =>
        kcSpy.mock.calls.at(-1)![0][0].model.metrics![0];
    expect(await push({validateOnly: true})).toBe(0);
    expect(prints(console.warn).join('\n')).toContain('needs transpilation');
    expect(metric().expression).toBeUndefined();

    (console.warn as any).mockClear();
    expect(await push({validateOnly: true, transpile: true})).toBe(0);
    expect(prints(console.warn).join('\n')).not.toContain('needs transpilation');
    expect(prints(console.warn)).toContain(
        "Warning: [commerce] metric 'positive_spend': transpiled " +
        "'SNOWFLAKE' -> 'BIGQUERY'");
    expect(metric().expression).toBeDefined();
  });

  // Two deployments stop the push after pruning, before any live check.
  test('a pruned push warns about a metric whose SQL it cannot read', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: a, target: "//${BQ}/propertyGraphs/a" }
      - { name: b, target: "//${BQ}/propertyGraphs/b" }
    entities:
      - name: customer
        source: //${BQ}/tables/customer
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
    metrics:
      - { name: broken, expression: "SUM((customer.c_id" }
`);
    expect(await push({validateOnly: true})).toBe(1);
    expect(prints(console.warn))
        .toContain(
            "Warning: metric 'broken' in model 'commerce' (commerce): kcmd " +
            'could not read its SQL, so the fields it reads were not checked.');
  });

  test('a pruned push reports a SQL parser that cannot load', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: g, target: "//${BQ}/propertyGraphs/g" }
    entities:
      - name: customer
        source: //${BQ}/tables/customer
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
`);
    spyOn(sqlParser, 'loadSqlEngine')
        .mockRejectedValue(new Error('engine missing'));
    expect(await push({validateOnly: true})).toBe(1);
    expect(prints(console.error)).toEqual(
        ['Error: the SQL parser could not be loaded: engine missing']);
  });

  // Push reserves the name 'default' in any letter case.
  test('a push refuses a legacy profile named Default', async () => {
    const eg = writeModel(MODEL_YAML);
    fs.mkdirSync(path.join(eg, 'commerce.profiles'));
    fs.writeFileSync(path.join(eg, 'commerce.profiles', 'Default.yaml'), `semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: //${BQ}/tables/customer
`);
    mockKc();
    expect(await push({validateOnly: true})).toBe(1);
    expect(prints(console.error)).toEqual([
      "Error: [commerce] a binding profile may not be named 'default' -- " +
          "that name refers to the model's inline bindings. Rename the " +
          'profile file.',
    ]);
  });

  test('a push resolves a legacy wrapper\'s bare source in the default project', async () => {
    const eg = writeModel(MODEL_YAML);
    fs.mkdirSync(path.join(eg, 'commerce.profiles'));
    fs.writeFileSync(path.join(eg, 'commerce.profiles', 'legacy.yaml'), `semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: sales.customer
`);
    const kcSpy = mockKc();
    expect(await push({validateOnly: true, profile: 'legacy'})).toBe(0);
    expect(kcSpy.mock.calls[0][0][0].model.entities![0].dataSource)
        .toBe('test-project.sales.customer');
  });

  const selections = [
    ['--profile', {profile: 'prod'}],
    ['--all-profiles', {allProfiles: true}],
    ['--no-profile', {profile: false}],
  ] as const;
  for (const [flag, selection] of selections) {
    test(`each profile file is read once during a ${flag} push`, async () => {
      const eg = writeModel(MODEL_YAML);
      const profilePath = path.join(eg, 'commerce.profile.prod.yaml');
      fs.writeFileSync(profilePath, `name: prod
entities:
  - name: Customer
    source: //${BQ}/tables/customer
    fields:
      - { name: key, expression: c_id }
`);
      mockKc();
      const readSpy = spyOn(fs, 'readFileSync');

      expect(await push({validateOnly: true, ...selection})).toBe(0);

      const reads = readSpy.mock.calls.filter(
          c => path.resolve(String(c[0])) === profilePath);
      expect(reads).toHaveLength(1);
    });
  }
});
