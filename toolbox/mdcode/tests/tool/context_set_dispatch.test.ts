// Tests for the `context-set` split workspace in src/tool/commands.ts:
// `kcmd init --context-set`, two-leg `kcmd pull`, and two-leg `kcmd push`.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiResult} from '../../src/libts/gcp/api';
import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient, Entry, EntryLink} from '../../src/libts/gcp/dataplex';
import {SplitLayout} from '../../src/libts/layouts/split';
import * as kc from '../../src/libts/semantic/deploy_knowledge_catalog';
import {CUSTOM_TYPES} from '../../src/libts/semantic/kc_custom_types';
import * as pullKc from '../../src/libts/semantic/pull_kc';
import {CatalogSnapshot} from '../../src/libts/snapshot';
import {CatalogSync} from '../../src/libts/sync';
import {init, pull, push} from '../../src/tool/commands';
import {passGraphChecks, passSourceCheck} from '../libts/mocks';

const CTX = new ApiContext('proj', 'us', 'test-token');
const GROUP = 'projects/proj/locations/us/entryGroups/cs';
const OP = 'projects/proj/locations/us/operations/op-cs-1';

function ok<T>(result?: T): ApiResult<T> {
  return {status: 200, result};
}
function err(status: number, message: string): ApiResult<any> {
  return {status, message};
}

const MODEL_YAML = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        primary_key: [id]
        fields:
          - { name: id, datatype: STRING }
`;

let dir = '';
let cwd = '';

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-context-set-'));
  process.chdir(dir);

  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  spyOn(console, 'log').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation(() => {});
  spyOn(console, 'warn').mockImplementation(() => {});
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);

  spyOn(CatalogClient.prototype, 'createEntryGroup')
      .mockImplementation(async () => err(409, 'already exists'));
  spyOn(CatalogClient.prototype, 'getEntryGroup')
      .mockImplementation(async () => ok({name: GROUP, type: 'context-set'}));
  spyOn(CatalogClient.prototype, 'createAspectType')
      .mockImplementation(async () => ok({name: OP, done: true}));
  spyOn(CatalogClient.prototype, 'createEntryType')
      .mockImplementation(async () => ok({name: OP, done: true}));
  spyOn(CatalogClient.prototype, 'getOperation')
      .mockImplementation(async () => ok({name: OP, done: true}));
  spyOn(CatalogClient.prototype, 'getAspectType')
      .mockImplementation(async () => ok({} as any));
  spyOn(CatalogClient.prototype, 'getEntryType')
      .mockImplementation(async () => ok({} as any));
  passGraphChecks();
  passSourceCheck();
});

afterEach(() => {
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});

function writeContextSetManifest(): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: context-set.proj.us.cs\nsnapshot:\n  aspects:\n    - dataplex-types.global.overview\n');
}

describe('init --context-set', () => {
  test(
      'creates a context-set entry group, awaits LRO, provisions custom types, and scaffolds catalog/ and bundle/',
      async () => {
        let polls = 0;
        const logs: string[] = [];
        spyOn(console, 'log').mockImplementation((...args: any[]) => {
          logs.push(args.join(' '));
        });
        const createGroup =
            spyOn(CatalogClient.prototype, 'createEntryGroup')
                .mockImplementation(async () => ok({name: OP, done: false} as any));
        const getGroup = spyOn(CatalogClient.prototype, 'getEntryGroup');
        spyOn(CatalogClient.prototype, 'getOperation')
            .mockImplementation(async (name: string) => {
              polls++;
              return ok({name, done: polls >= 2});
            });
        const createAspect = spyOn(CatalogClient.prototype, 'createAspectType');
        const createEntry = spyOn(CatalogClient.prototype, 'createEntryType');

        const code = await init({contextSet: 'proj.us.cs'});

        expect(code).toBe(0);
        expect(createGroup).toHaveBeenCalledTimes(1);
        expect(createGroup.mock.calls[0]).toEqual([
          'proj',
          'us',
          'cs',
          {type: 'context-set'} as any,
        ]);
        expect(getGroup).not.toHaveBeenCalled();
        expect(polls).toBeGreaterThanOrEqual(2);
        expect(createAspect).toHaveBeenCalledTimes(CUSTOM_TYPES.length);
        expect(createEntry).toHaveBeenCalledTimes(CUSTOM_TYPES.length);
        expect(fs.existsSync(path.join(dir, 'catalog', 'EntryGroups', 'cs')))
            .toBe(true);
        expect(fs.existsSync(path.join(dir, 'bundle'))).toBe(true);
        expect(logs.join('\n')).toContain("Note: 'proj.us.cs' is a new context set.");
        expect(logs.join('\n')).toContain(
            'gcloud dataplex entry-groups add-iam-policy-binding cs --project=proj --location=us --member=<principal> --role=roles/dataplex.contentEditor');
        const manifestText = fs.readFileSync(path.join(dir, 'catalog.yaml'), 'utf8');
        expect(manifestText).toContain('scope: context-set.proj.us.cs');
        expect(manifestText).toContain('dataplex-types.global.overview');
        expect(manifestText).not.toContain('layout:');
      });

  test(
      'waits by polling getEntryGroup when caller lacks dataplex.operations.get (roles/dataplex.contentCreator)',
      async () => {
        spyOn(CatalogClient.prototype, 'createEntryGroup')
            .mockImplementation(async () => ok({name: OP, done: false} as any));
        spyOn(CatalogClient.prototype, 'getOperation')
            .mockImplementation(async () => err(403, 'Permission denied on operation'));
        let groupReads = 0;
        spyOn(CatalogClient.prototype, 'getEntryGroup')
            .mockImplementation(async () => {
              groupReads++;
              return ok(
                  groupReads >= 2 ? {name: GROUP, type: 'context-set'} :
                                    {name: GROUP});
            });

        const code = await init({contextSet: 'proj.us.cs'});

        expect(code).toBe(0);
        expect(groupReads).toBe(2);
        expect(fs.existsSync(path.join(dir, 'catalog.yaml'))).toBe(true);
      });

  test.each([409, 403])(
      'succeeds idempotently when create answers %d and existing group has type context-set',
      async (status) => {
        spyOn(CatalogClient.prototype, 'createEntryGroup')
            .mockImplementation(async () => err(status, 'already exists or denied'));
        spyOn(CatalogClient.prototype, 'getEntryGroup')
            .mockImplementation(async () => ok({name: GROUP, type: 'context-set'}));

        const code = await init({contextSet: 'proj.us.cs'});

        expect(code).toBe(0);
        expect(fs.existsSync(path.join(dir, 'catalog.yaml'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'catalog', 'EntryGroups', 'cs')))
            .toBe(true);
        expect(fs.existsSync(path.join(dir, 'bundle'))).toBe(true);
      });

  test(
      'fails with a clear error when the existing entry group is a plain entry group (type !== context-set)',
      async () => {
        spyOn(CatalogClient.prototype, 'createEntryGroup')
            .mockImplementation(async () => err(409, 'already exists'));
        spyOn(CatalogClient.prototype, 'getEntryGroup')
            .mockImplementation(async () => ok({name: GROUP}));
        const errors: string[] = [];
        spyOn(console, 'error').mockImplementation((...args: any[]) => {
          errors.push(args.join(' '));
        });

        const code = await init({contextSet: 'proj.us.cs'});

        expect(code).toBe(1);
        expect(fs.existsSync(path.join(dir, 'catalog.yaml'))).toBe(false);
        expect(fs.existsSync(path.join(dir, 'bundle'))).toBe(false);
        expect(errors.join('\n')).toContain(
            "entry group 'proj.us.cs' exists but is not a context set");
        expect(errors.join('\n')).toContain('use a new context set ID');
      });

  test(
      'fails naming roles/dataplex.contentCreator and roles/dataplex.contentEditor when create is denied (403) and group does not exist',
      async () => {
        spyOn(CatalogClient.prototype, 'createEntryGroup')
            .mockImplementation(async () => err(403, 'Permission denied'));
        spyOn(CatalogClient.prototype, 'getEntryGroup')
            .mockImplementation(async () => err(404, 'Not found'));
        const errors: string[] = [];
        spyOn(console, 'error').mockImplementation((...args: any[]) => {
          errors.push(args.join(' '));
        });

        const code = await init({contextSet: 'proj.us.cs'});

        expect(code).toBe(1);
        expect(fs.existsSync(path.join(dir, 'catalog.yaml'))).toBe(false);
        expect(errors.join('\n')).toContain('roles/dataplex.contentCreator');
        expect(errors.join('\n')).toContain('roles/dataplex.contentEditor');
      });

  test(
      'does not append roles advice when create fails for a non-permission reason (e.g. 500)',
      async () => {
        spyOn(CatalogClient.prototype, 'createEntryGroup')
            .mockImplementation(async () => err(500, 'Internal error'));
        const errors: string[] = [];
        spyOn(console, 'error').mockImplementation((...args: any[]) => {
          errors.push(args.join(' '));
        });

        const code = await init({contextSet: 'proj.us.cs'});

        expect(code).toBe(1);
        expect(errors.join('\n')).toContain("creating context set 'proj.us.cs': Internal error");
        expect(errors.join('\n')).not.toContain('roles/dataplex.contentCreator');
      });

  test('rejects --format okf on --context-set', async () => {
    await expect(
        init({contextSet: 'proj.us.cs', format: 'okf'}),
    ).rejects.toThrow(/applies only to 'entryGroup' and 'kb' scopes/);
  });
});

describe('context-set pull and push dispatch', () => {
  test(
      'pull runs both the semantic model leg and the OKF bundle leg and forwards flags',
      async () => {
        writeContextSetManifest();
        let seenLayout: unknown;
        const origFromPath = CatalogSnapshot.fromPath.bind(CatalogSnapshot);
        spyOn(CatalogSnapshot, 'fromPath').mockImplementation(
            async (...args: Parameters<typeof CatalogSnapshot.fromPath>) => {
              const snap = await origFromPath(...args);
              seenLayout = snap.layout;
              return snap;
            });
        const pullModelSpy =
            spyOn(pullKc, 'pullKnowledgeCatalog').mockResolvedValue({
              models: [],
              warnings: [],
              firstGeneration: [],
            });
        const pullBundleSpy =
            spyOn(CatalogSync.prototype, 'pull').mockResolvedValue({
              success: true,
            });

        const code = await pull({dryRun: true, forceRemove: true});

        expect(code).toBe(0);
        expect(seenLayout).toBeInstanceOf(SplitLayout);
        expect(pullModelSpy).toHaveBeenCalledTimes(1);
        expect(pullBundleSpy).toHaveBeenCalledWith({
          dryRun: true,
          forceRemove: true,
        });
      });

  test('pull stops before the OKF bundle leg when the semantic model leg fails',
       async () => {
         writeContextSetManifest();
         const egDir = path.join(dir, 'catalog', 'EntryGroups', 'cs');
         fs.mkdirSync(egDir, {recursive: true});
         fs.writeFileSync(path.join(egDir, 'local_other.yaml'), MODEL_YAML);

         spyOn(pullKc, 'pullKnowledgeCatalog').mockResolvedValue({
           models: [{name: 'remote_model', version: '0.2.0.dev0/google'} as any],
           warnings: [],
           firstGeneration: [],
         });
         const pullBundleSpy = spyOn(CatalogSync.prototype, 'pull');

         const code = await pull({forceRemove: false});

         expect(code).toBe(1);
         expect(pullBundleSpy).not.toHaveBeenCalled();
       });

  test(
      'push runs both the semantic model leg and the OKF bundle leg and forwards --validate-only',
      async () => {
        writeContextSetManifest();
        const egDir = path.join(dir, 'catalog', 'EntryGroups', 'cs');
        fs.mkdirSync(egDir, {recursive: true});
        fs.writeFileSync(path.join(egDir, 'commerce.yaml'), MODEL_YAML);

        const order: string[] = [];
        spyOn(kc, 'preflightKnowledgeCatalog').mockImplementation(async () => {
          order.push('model');
          return {
            result: {
              success: true,
              created: 0,
              updated: 0,
              deleted: 0,
              linked: 0,
              unchangedLinks: 0,
              unlinked: 0,
              warnings: [],
              plan: [],
            },
          };
        });
        const pushBundleSpy =
            spyOn(CatalogSync.prototype, 'push').mockImplementation(async () => {
              order.push('bundle');
              return {success: true};
            });

        const code = await push({dryRun: true});

        expect(code).toBe(0);
        expect(order).toEqual(['model', 'bundle']);
        expect(pushBundleSpy).toHaveBeenCalledWith({
          force: undefined,
          validateOnly: true,
        });
      });

  test('push stops before the OKF bundle leg when the semantic model leg fails',
       async () => {
         writeContextSetManifest();
         const egDir = path.join(dir, 'catalog', 'EntryGroups', 'cs');
         fs.mkdirSync(egDir, {recursive: true});
         fs.writeFileSync(path.join(egDir, 'commerce.yaml'), MODEL_YAML);

         spyOn(kc, 'preflightKnowledgeCatalog').mockResolvedValue({
           result: {
             success: false,
             details: 'model validation failed',
             created: 0,
             updated: 0,
             deleted: 0,
             linked: 0,
             unchangedLinks: 0,
             unlinked: 0,
             warnings: [],
             plan: [],
           },
         });
         const pushBundleSpy = spyOn(CatalogSync.prototype, 'push');

         const code = await push({});

         expect(code).toBe(1);
         expect(pushBundleSpy).not.toHaveBeenCalled();
       });

  test(
      'full round-trip: push and pull preserve both the OSI+G semantic model and OKF bundle with _links.yaml targeting a semantic entry',
      async () => {
        writeContextSetManifest();
        const egDir = path.join(dir, 'catalog', 'EntryGroups', 'cs');
        fs.mkdirSync(egDir, {recursive: true});
        fs.writeFileSync(path.join(egDir, 'commerce.yaml'), MODEL_YAML);

        const bundleDir = path.join(dir, 'bundle', 'terms');
        fs.mkdirSync(bundleDir, {recursive: true});
        fs.writeFileSync(
            path.join(dir, 'bundle', 'agents.md'),
            '---\ntype: context-set\ntitle: Commerce Context Set\n---\n# Commerce Context Set\n\nRoot overview for the combined context set.\n');
        const termMd = `---
type: generic
title: Active Customer
---
# Active Customer

A customer with at least one order in the past 90 days.
`;
        fs.writeFileSync(path.join(bundleDir, 'active-customer.md'), termMd);
        const modelEntryId = 'commerce';
        const customerEntryId = 'commerce/entities/Customer';
        const linksYaml = `links:
  - id: link-term-to-entity
    type: related
    entries:
      - terms/active-customer
      - ${customerEntryId}
`;
        fs.writeFileSync(path.join(dir, 'bundle', '_links.yaml'), linksYaml);

        // In-memory catalog store populated by push and read by pull.
        const entries = new Map<string, Entry>();
        const links = new Map<string, EntryLink>();

        spyOn(CatalogClient.prototype, 'batchChangeMetadata')
            .mockImplementation(async () => ({status: 501}) as any);
        spyOn(CatalogClient.prototype, 'listEntries').mockImplementation(
            async function* () {
              for (const e of entries.values()) yield e;
            });
        spyOn(CatalogClient.prototype, 'getEntry').mockImplementation(
            async (_p: string, _l: string, _g: string, id: string) => {
              const found = entries.get(`${GROUP}/entries/${id}`);
              return found ? ok(found) : err(404, 'Not found');
            });
        spyOn(CatalogClient.prototype, 'lookupEntry').mockImplementation(
            async (_p: string, _l: string, name: string) => {
              const found = entries.get(name);
              return found ? ok(found) : err(404, 'Not found');
            });
        spyOn(CatalogClient.prototype, 'createEntry').mockImplementation(
            async (_p: string, _l: string, _g: string, id: string, entry?: Entry) => {
              const full: Entry = {
                ...(entry as Entry),
                name: `${GROUP}/entries/${id}`,
              };
              entries.set(full.name, full);
              return ok(full);
            });
        spyOn(CatalogClient.prototype, 'updateEntry').mockImplementation(
            async (entry: Entry) => {
              const prev = entries.get(entry.name);
              const merged: Entry = {
                ...prev,
                ...entry,
                aspects: entry.aspects ?? prev?.aspects,
              };
              entries.set(entry.name, merged);
              return ok(merged);
            });
        spyOn(CatalogClient.prototype, 'lookupEntryLinks').mockImplementation(
            async (_p: string, _l: string, opts: {entry: string}) =>
                ok([...links.values()].filter(l =>
                    (l.entryReferences ?? []).some(r => r.name === opts.entry))));
        spyOn(CatalogClient.prototype, 'createEntryLink').mockImplementation(
            async (_p: string, _l: string, _g: string, id: string, link: EntryLink) => {
              const full: EntryLink = {
                ...link,
                name: `${GROUP}/entryLinks/${id}`,
              };
              links.set(full.name!, full);
              return ok(full);
            });

        expect(await push({})).toBe(0);

        // Verify both the semantic model entries and the OKF document entry were written,
        // plus the entry link from the OKF term to the semantic entity, and the
        // context-set representative entry overview was published from bundle/agents.md.
        expect(entries.has(`${GROUP}/entries/${modelEntryId}`)).toBe(true);
        expect(entries.has(`${GROUP}/entries/${customerEntryId}`)).toBe(true);
        expect(entries.has(`${GROUP}/entries/terms/active-customer`)).toBe(true);
        expect(links.has(`${GROUP}/entryLinks/link-term-to-entity`)).toBe(true);
        const repOverview =
            entries.get(`${GROUP}/entries/cs_entry`)?.aspects?.['dataplex-types.global.overview']?.data?.['content'];
        expect(repOverview).toContain('Root overview for the combined context set.');

        // Now pull into a fresh workspace directory and verify both halves round-trip.
        const pullDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-cs-pull-'));
        try {
          process.chdir(pullDir);
          expect(await init({contextSet: 'proj.us.cs', pull: true})).toBe(0);

          const pulledModel = fs.readFileSync(
              path.join(pullDir, 'catalog', 'EntryGroups', 'cs', 'commerce.yaml'),
              'utf8');
          expect(pulledModel).toContain('name: commerce');
          expect(pulledModel).toContain('name: Customer');

          // Semantic entries must not leak into bundle/.
          const bundleFiles = fs.readdirSync(path.join(pullDir, 'bundle'), {
            recursive: true,
          }) as string[];
          expect(bundleFiles.some(f => f.includes(customerEntryId))).toBe(false);

          const pulledTerm = fs.readFileSync(
              path.join(pullDir, 'bundle', 'terms', 'active-customer.md'),
              'utf8');
          expect(pulledTerm).toContain(
              'A customer with at least one order in the past 90 days.');

          const pulledLinks = fs.readFileSync(
              path.join(pullDir, 'bundle', '_links.yaml'), 'utf8');
          expect(pulledLinks).toContain('link-term-to-entity');
          expect(pulledLinks).toContain(customerEntryId);
        } finally {
          process.chdir(dir);
          fs.rmSync(pullDir, {recursive: true, force: true});
        }
      });

  test(
      'warns naming the tried entries and last status when updating the context-set overview fails',
      async () => {
        writeContextSetManifest();
        fs.mkdirSync(path.join(dir, 'bundle'), {recursive: true});
        fs.writeFileSync(
            path.join(dir, 'bundle', 'index.md'),
            '---\nokf_version: "0.2"\n---\n# Commerce\n\nOverview body.\n');
        spyOn(CatalogSync.prototype, 'push').mockResolvedValue({success: true});
        spyOn(CatalogClient.prototype, 'updateEntry')
            .mockImplementation(async () => err(404, 'Entry not found'));
        const warnings: string[] = [];
        spyOn(console, 'warn').mockImplementation((...args: any[]) => {
          warnings.push(args.join(' '));
        });

        expect(await push({})).toBe(0);

        expect(warnings.join('\n')).toContain(
            `Warning: could not update context set overview on '${GROUP}/entries/cs_entry'`);
        expect(warnings.join('\n')).toContain('404 (Entry not found)');
      });
});
