// `kcmd bind --from-catalog` binds the model Knowledge Catalog holds. After a
// govern-style push (the logical model, `--no-deployment`) to Knowledge
// Catalog using V2 aspects, the pulled model must match the local one --
// abstract relationships, `extends`, verbatim names, join direction and metric
// expressions included -- so binding it writes the same flat profile.

import {afterEach, beforeAll, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

import {ApiContext} from '../../../src/libts/gcp/context';
import {CatalogClient, Entry, EntryLink} from '../../../src/libts/gcp/dataplex';
import {renderProfileYaml} from '../../../src/libts/semantic/bind/report';
import {bindDocument} from '../../../src/libts/semantic/bind/run';
import {filterScan, scanFromCsv} from '../../../src/libts/semantic/bind/scan';
import {deployKnowledgeCatalog} from '../../../src/libts/semantic/deploy_knowledge_catalog';
import {formatIssues, loadModels} from '../../../src/libts/semantic/loader';
import {loadSqlEngine} from '../../../src/libts/semantic/sql_parser';
import {pullModelDocs, upsertModelDeployment} from '../../../src/tool/bind';

beforeAll(loadSqlEngine);

const CTX = new ApiContext('test-project', 'us', 'test-token');
const OPTS = {project: 'dest', location: 'global', entryGroup: 'ps_commercial'};
const FIXTURES = path.join(__dirname, 'fixtures', 'bind');

afterEach(() => {
  mock.restore();
});

function aspectKey(aspectType: string): string {
  const m = aspectType.match(
      /^projects\/([^/]+)\/locations\/([^/]+)\/aspectTypes\/(.+)$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : aspectType;
}

// Just enough of CatalogClient for V2 push and pull.
function fakeCatalog() {
  const entries = new Map<string, Entry>();
  const links = new Map<string, EntryLink>();
  const ok = (result?: any) => ({status: 200, result});
  const P = CatalogClient.prototype as any;
  spyOn(P, 'getEntryGroup').mockImplementation(async () => ok({}));
  spyOn(P, 'getAspectType').mockImplementation(async () => ok({}));
  spyOn(P, 'getEntryType').mockImplementation(async () => ok({}));
  spyOn(P, 'listEntries').mockImplementation(async function* () {
    for (const e of [...entries.values()]) {
      yield {name: e.name, entryType: e.entryType, parentEntry: e.parentEntry};
    }
  });
  spyOn(P, 'createEntry').mockImplementation(async (...a: any[]) => {
    const entry: Entry = a[4];
    if (entries.has(entry.name)) return {status: 409, message: 'exists'};
    entries.set(entry.name, structuredClone(entry));
    return ok(entry);
  });
  spyOn(P, 'updateEntry').mockImplementation(async (entry: Entry, mask?: string[]) => {
    const prev = entries.get(entry.name);
    const merged: Entry = prev && mask && !mask.includes('aspects') ?
        {...prev, ...structuredClone(entry), aspects: prev.aspects} :
        structuredClone(entry);
    entries.set(entry.name, merged);
    return ok(merged);
  });
  spyOn(P, 'deleteEntry').mockImplementation(async () => ok({}));
  spyOn(P, 'getEntry').mockImplementation(async (...a: any[]) => {
    const name = a.length === 1 ? a[0] :
        `projects/${a[0]}/locations/${a[1]}/entryGroups/${a[2]}/entries/${a[3]}`;
    const e = entries.get(name);
    return e ? ok(structuredClone(e)) : {status: 404, message: 'not found'};
  });
  spyOn(P, 'lookupEntry').mockImplementation(async (...a: any[]) => {
    const e = entries.get(a[2]);
    if (!e) return {status: 404, message: 'not found'};
    const aspectTypes: string[] =
        Array.isArray(a[3]) ? a[3] : (a[3]?.aspects ?? a[3]?.aspectTypes ?? []);
    const out = structuredClone(e);
    if (aspectTypes.length) {
      const want = new Set(aspectTypes.map(aspectKey));
      out.aspects = Object.fromEntries(
          Object.entries(e.aspects ?? {})
              .filter(([k]) => want.has(k.split('@')[0])));
    }
    return ok(out);
  });
  spyOn(P, 'createEntryLink').mockImplementation(async (...a: any[]) => {
    const link: EntryLink = a[4];
    if (links.has(link.name!)) return {status: 409, message: 'exists'};
    links.set(link.name!, structuredClone(link));
    return ok(link);
  });
  spyOn(P, 'updateEntryLink').mockImplementation(async (link: EntryLink) => {
    links.set(link.name!, structuredClone(link));
    return ok(link);
  });
  spyOn(P, 'deleteEntryLink').mockImplementation(async () => ok({}));
  spyOn(P, 'lookupEntryLinks').mockImplementation(async (...a: any[]) => {
    const o = a[2];
    return ok([...links.values()].filter(
        l => l.entryReferences.some(r => r.name === o.entry) &&
            (!o.entryLinkTypes ||
             o.entryLinkTypes.includes(l.entryLinkType))));
  });
  return {entries, links};
}

const modelText =
    fs.readFileSync(path.join(FIXTURES, 'ps_commercial.yaml'), 'utf8');

async function governPush() {
  fakeCatalog();
  const local = loadModels(modelText, {bindingOptional: true}).models[0];
  const push = await deployKnowledgeCatalog(
      [{document: 'ps_commercial.yaml', model: local}] as any, CTX, {
        ...OPTS,
        entryCreateTries: 1,
      });
  expect(push.details).toBeUndefined();
  expect(push.success).toBe(true);
  return local;
}

const byName = <T extends {name: string}>(xs: T[]|undefined) =>
    xs ? [...xs].sort((a, b) => a.name.localeCompare(b.name)) : xs;

function normalizedModel(m: any) {
  return {
    ...m,
    entities: byName(m.entities),
    relationships: byName(m.relationships),
    metrics: byName(m.metrics)?.map(({authoredEntity: _a, ...rest}: any) => rest),
    constraints: byName(m.constraints),
    actions: byName(m.actions),
  };
}

function normalizedProfile(text: string) {
  const doc = yaml.parse(text);
  return {
    ...doc,
    entities: byName(doc.entities),
    relationships: byName(doc.relationships),
  };
}

describe('bind --from-catalog over a govern-style push', () => {
  test('the pulled model matches the local one with zero warnings',
       async () => {
         const local = await governPush();
         const pulled = await pullModelDocs(new CatalogClient(CTX), OPTS);
         expect(pulled.warnings).toEqual([]);
         expect(pulled.docs).toHaveLength(1);
         const back = loadModels(pulled.docs[0].text, {bindingOptional: true});
         expect(normalizedModel(back.models[0])).toEqual(normalizedModel(local));
         const rel = (n: string) =>
             back.models[0].relationships.find(r => r.name === n);
         expect(rel('belongsToTerritory')?.abstract).toBe(true);
         expect(rel('hasBuyer')?.extends).toEqual(['hasCounterparty']);
       });

  test('binding the pulled model writes the same profile bindings as local',
       async () => {
         await governPush();
         const pulled = await pullModelDocs(new CatalogClient(CTX), OPTS);
         const scan = scanFromCsv(
             fs.readFileSync(path.join(FIXTURES, 'columns.csv'), 'utf8'),
             'kc-demo-349204');
         const {tables, dropped} = filterScan(
             scan, {exclude: ['ps_semantic'], datasetGlob: 'ps_*'});
         const meta = {
           profile: 'bigquery',
           scan: 'kc-demo-349204.ps_*',
           tablesScanned: tables.length,
           dropped,
           acceptReview: true,
         };
         const bindProfile = async (text: string) => {
           const {results, models} = await bindDocument({
             modelText: text,
             docName: 'ps_commercial',
             tables,
             profileName: 'bigquery',
             profileData: false,
           });
           return normalizedProfile(renderProfileYaml(results, meta, models));
         };
         expect(await bindProfile(pulled.docs[0].text))
             .toEqual(await bindProfile(modelText));
       });

  test('upsertModelDeployment strips leading // and updates deployments in place',
       () => {
         const updated = upsertModelDeployment(
             modelText, 'bigquery',
             '//bigquery.googleapis.com/projects/kc-demo-349204/datasets/ps_semantic/propertyGraphs/commercial_graph');
         const parsed = loadModels(updated, {bindingOptional: true}).models[0];
         expect(parsed.deployments).toEqual([{
           name: 'bigquery',
           target:
               'bigquery.googleapis.com/projects/kc-demo-349204/datasets/ps_semantic/propertyGraphs/commercial_graph',
           profile: 'bigquery',
         }]);
       });
});

describe('load errors name each problem', () => {
  test('one line per issue, naming model and metric', () => {
    let message = '';
    try {
      loadModels(
          'version: 0.2.0.dev0/google\nsemantic_model:\n  - name: m\n    entities: []\n' +
              '    metrics:\n      - name: x\n',
          {bindingOptional: true});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("model 'm': 'entities' is an empty list");
    expect(message).toContain("metric 'x': 'expression' is missing");
    expect(formatIssues([])).toBe('');
  });
});
