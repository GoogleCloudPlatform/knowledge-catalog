// `kcmd bind --from-catalog` binds the model Knowledge Catalog holds. After a
// govern-style push (the logical model, no profile) to a catalog whose
// project has the annotation aspect types, the pulled model must be the local
// one -- abstract relationships, `extends`, verbatim names, join direction and
// metric expressions included -- so binding it writes the same profile.

import {afterEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {ApiContext} from '../../../src/libts/gcp/context';
import {CatalogClient, Entry, EntryLink} from '../../../src/libts/gcp/dataplex';
import {renderBindReport, renderProfileYaml} from '../../../src/libts/semantic/bind/report';
import {bindDocument} from '../../../src/libts/semantic/bind/run';
import {filterScan, scanFromCsv} from '../../../src/libts/semantic/bind/scan';
import {deployKnowledgeCatalog} from '../../../src/libts/semantic/deploy_knowledge_catalog';
import {ANNOTATION_ASPECT_IDS} from '../../../src/libts/semantic/kc_custom_types';
import {formatIssues, loadModels} from '../../../src/libts/semantic/loader';
import {pullModelDocs} from '../../../src/tool/bind';

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

// Just enough of CatalogClient for push and pull, with every annotation
// aspect type provisioned (`kcmd init` ran) unless `provisioned` is false.
// The other custom types `kcmd init` creates (semantic-constraint, ...) always
// exist, as the push preflight requires.
function fakeCatalog(provisioned = true) {
  const entries = new Map<string, Entry>();
  const links = new Map<string, EntryLink>();
  const ok = (result?: any) => ({status: 200, result});
  const P = CatalogClient.prototype as any;
  spyOn(P, 'getAspectType').mockImplementation(
      async (_project: string, _location: string, id: string) =>
          provisioned || !ANNOTATION_ASPECT_IDS.includes(id) ?
          ok({}) :
          {status: 404, message: 'not found'});
  spyOn(P, 'getEntryType').mockImplementation(async () => ok({}));
  spyOn(P, 'listEntries').mockImplementation(async function*() {
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
  spyOn(P, 'updateEntry').mockImplementation(async (entry: Entry) => {
    entries.set(entry.name, structuredClone(entry));
    return ok(entry);
  });
  spyOn(P, 'deleteEntry').mockImplementation(async () => ok({}));
  spyOn(P, 'lookupEntry').mockImplementation(async (...a: any[]) => {
    const e = entries.get(a[2]);
    if (!e) return {status: 404, message: 'not found'};
    // Only the requested aspect types come back, as on the live API.
    const want = new Set((a[3] ?? []).map(aspectKey));
    const out = structuredClone(e);
    out.aspects = Object.fromEntries(
        Object.entries(e.aspects ?? {}).filter(([k]) => want.has(k)));
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
            (!o.entryLinkTypes || o.entryLinkTypes.includes(l.entryLinkType))));
  });
  return {entries, links};
}

const modelText =
    fs.readFileSync(path.join(FIXTURES, 'ps_commercial.yaml'), 'utf8');

async function governPush(provisioned = true) {
  fakeCatalog(provisioned);
  const local = loadModels(modelText, {bindingOptional: true}).models[0];
  const push = await deployKnowledgeCatalog(
      [{document: 'ps_commercial.yaml', model: local}] as any, CTX, {
        ...OPTS,
        entryCreateTries: 1,
        customAspects: provisioned ?
            ['semantic-ai-context', 'semantic-expressions', 'semantic-binding'] :
            [],
      });
  expect(push.details).toBeUndefined();
  expect(push.success).toBe(true);
  return local;
}

describe('bind --from-catalog over a govern-style push', () => {
  test('the pulled model is the local one, with no warning but the missing ' +
           'file copy',
       async () => {
         const local = await governPush();
         const pulled = await pullModelDocs(new CatalogClient(CTX), OPTS);
         // This push stores no file copy, so the pull rebuilds the model file
         // from the aspects and says so. Nothing else is reported.
         expect(pulled.warnings).toEqual([
           'no stored copy of the model file was found, so it is rebuilt ' +
               'from the catalog\'s aspects and may differ from what was ' +
               'pushed; push it again to store a copy',
         ]);
         expect(pulled.docs).toHaveLength(1);
         const back = loadModels(pulled.docs[0].text, {bindingOptional: true});
         expect(back.models[0]).toEqual(local);
         // The constructs the lossy read used to lose.
         const rel = (n: string) =>
             back.models[0].relationships.find(r => r.name === n);
         expect(rel('belongsToTerritory')?.abstract).toBe(true);
         expect(rel('hasBuyer')?.extends).toEqual(['hasCounterparty']);
       });

  test('binding the pulled model writes the same profile and report',
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
         const bindText = async (text: string) => {
           const {results, models} = await bindDocument({
             modelText: text,
             docName: 'ps_commercial',
             tables,
             profileName: 'bigquery',
             profileData: false,
           });
           return [
             renderProfileYaml(results, meta),
             renderBindReport(results, models, meta),
           ];
         };
         expect(await bindText(pulled.docs[0].text))
             .toEqual(await bindText(modelText));
       });

  test('without the aspect types the pull is the lossy read', async () => {
    await governPush(false);
    const pulled = await pullModelDocs(new CatalogClient(CTX), OPTS);
    expect(pulled.warnings.some(w => /specializes 'belongsToTerritory'/.test(w)))
        .toBe(true);
  });
});

describe('load errors name each problem', () => {
  test('one line per issue, union branches folded', () => {
    let message = '';
    try {
      loadModels(
          'version: 0.2.0.dev0/google\nsemantic_model:\n  - name: m\n    entities: []\n' +
              '    metrics:\n      - name: x\n',
          {bindingOptional: true});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^Semantic model load error: \d+ problems?:\n  - /);
    expect(message).toContain(
        'semantic_model[0].metrics[0].expression: required (expected');
  });

  test('an empty issue list still says something', () => {
    expect(formatIssues([])).toBe('the document does not match the schema');
  });
});
