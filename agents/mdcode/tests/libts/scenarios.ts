import * as realGlob from 'glob';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

// Load the scenario files NOW, using the real fs!
const scenariosPath = path.join(__dirname, '..', 'scenarios');
let globPattern = '**/*.yaml';
if (process.env.TEST_GLOB) {
  globPattern = process.env.TEST_GLOB;
}
const scenarioFiles = realGlob.globSync(globPattern, {
  cwd: scenariosPath,
  absolute: true,
});
const scenarios = scenarioFiles.map((file: string) =>
  yaml.parse(realFs.readFileSync(file, 'utf-8') as string),
);

import {describe, expect, mock, spyOn, test} from 'bun:test';
import {fs as memfs, vol} from 'memfs';
import type * as mocksType from './mocks';

mock.module('fs', () => memfs);
mock.module('node:fs', () => memfs);

import * as gcp from '../../src/libts/gcp';
import * as bq from '../../src/libts/gcp/bigquery';

const fs = memfs;
const kcmac = require('../../src/libts');
const {
  CatalogClientMock,
  BigQueryClientMock,
  BigLakeClientMock,
  TEST_API_CONTEXT,
} = require('./mocks');

let currentCatalogMock: mocksType.CatalogClientMock | null = null;
let currentBigQueryMock: mocksType.BigQueryClientMock | null = null;
let currentBigLakeMock: mocksType.BigLakeClientMock | null = null;

function runScenario(scenario: any) {
  describe(scenario.name, () => {
    test('run', async () => {
      const catalog = new CatalogClientMock();
      const bigquery = new BigQueryClientMock();

      // Reset state
      vol.reset();
      currentCatalogMock = catalog;
      currentBigQueryMock = bigquery;
      currentBigLakeMock = null;

      // Setup state - Catalog Service
      if (scenario.setup?.catalog?.entries) {
        catalog.setMockEntries(scenario.setup.catalog.entries);
      }
      if (scenario.setup?.catalog?.entryGroups) {
        for (const eg of scenario.setup.catalog.entryGroups) {
          catalog.addMockEntryGroup(eg);
        }
      }
      if (scenario.setup?.catalog?.entryTypes) {
        for (const et of scenario.setup.catalog.entryTypes) {
          catalog.addMockEntryType(et);
        }
      }
      if (scenario.setup?.catalog?.aspectTypes) {
        for (const at of scenario.setup.catalog.aspectTypes) {
          catalog.addMockAspectType(at);
        }
      }

      // Setup state - BigQuery Service
      if (scenario.setup?.bigQuery?.datasets) {
        for (const ds of scenario.setup.bigQuery.datasets) {
          bigquery.addMockDataset(ds);
        }
      }
      if (scenario.setup?.bigQuery?.tables) {
        for (const table of scenario.setup.bigQuery.tables) {
          bigquery.addMockTable(table);
        }
      }

      // Setup state - BigLake Service
      const biglake = new BigLakeClientMock();
      currentBigLakeMock = biglake;
      if (scenario.setup?.bigLake?.tables) {
        for (const table of scenario.setup.bigLake.tables) {
          biglake.addMockTable(table);
        }
      }

      // Setup state - Filesystem
      if (scenario.setup?.fileSystem) {
        vol.fromJSON(scenario.setup.fileSystem, '/');
      } else {
        vol.fromJSON({}, '/');
      }

      // Execute - Manifest setup
      if (scenario.init?.entryGroup) {
        const mf = await kcmac.CatalogManifest.initWithEntryGroup(
          scenario.init.entryGroup,
          TEST_API_CONTEXT,
        );
        mf.save('/catalog.yaml');
      }
      if (scenario.init?.dataset) {
        const mf = await kcmac.CatalogManifest.initWithBigQuery(
          scenario.init.dataset,
          TEST_API_CONTEXT,
        );
        mf.save('/catalog.yaml');
      }
      if (scenario.init?.kb) {
        const mf = await kcmac.CatalogManifest.initWithKnowledgeBase(
          scenario.init.kb,
          TEST_API_CONTEXT,
        );
        mf.save('/catalog.yaml');
      }
      if (scenario.init?.biglakeNamespace) {
        const mf = await kcmac.CatalogManifest.initWithBigLakeNamespace(
          scenario.init.biglakeNamespace,
          'iceberg',
          TEST_API_CONTEXT,
        );
        mf.save('/catalog.yaml');
      }
      if (!fs.existsSync('/catalog.yaml')) {
        throw new Error('Scenario did not include or initialize a manifest');
      }
      const snapshot = await kcmac.CatalogSnapshot.fromPath(
        '/',
        TEST_API_CONTEXT,
      );
      const sync = new kcmac.CatalogSync(catalog, snapshot);

      // Execute - Snapshot actions
      const actions = scenario.actions ?? [];
      for (const actionStep of actions) {
        const {action, ...params} = actionStep;
        switch (action) {
          case 'pull':
            await sync.pull();
            break;
          case 'push':
            await sync.push(params.options);
            break;
          case 'listEntries':
            console.log(await snapshot.listEntries());
            break;
          case 'createEntry':
            await snapshot.createEntry(params.name, params.entry);
            break;
          case 'updateEntry':
            await snapshot.updateEntry(params.entry, params.fields);
            break;
          case 'deleteEntry':
            await snapshot.deleteEntry(params.name);
            break;
          case 'reference':
            const referenceSnapshot = await kcmac.CatalogSnapshot.fromPath(
              '/',
              TEST_API_CONTEXT,
              true,
            );
            const refereneSync = new kcmac.CatalogSync(
              catalog,
              referenceSnapshot,
            );
            await refereneSync.reference();

            break;
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      }

      // Assert expectations - Filesystem
      if (scenario.assert?.fileSystem) {
        for (const [fpath, rawCondition] of Object.entries(
          scenario.assert.fileSystem,
        )) {
          const condition = rawCondition as any;
          const absolutePath = path.resolve('/', fpath);

          if (condition === null) {
            expect(fs.existsSync(absolutePath)).toBe(false);
          } else {
            expect(fs.existsSync(absolutePath)).toBe(true);
            if (typeof condition === 'string') {
              const actualContent = fs.readFileSync(
                absolutePath,
                'utf8',
              ) as string;
              expect(actualContent.trim()).toBe(condition.trim());
            } else if (Array.isArray(condition)) {
              const actualContent = fs.readFileSync(
                absolutePath,
                'utf8',
              ) as string;
              for (const cond of condition) {
                if (cond && typeof cond === 'object' && 'contains' in cond) {
                  expect(actualContent).toContain(cond.contains);
                }
              }
            } else if (
              condition &&
              typeof condition === 'object' &&
              'contains' in condition
            ) {
              const actualContent = fs.readFileSync(
                absolutePath,
                'utf8',
              ) as string;
              expect(actualContent).toContain(condition.contains);
            }
          }
        }
      }

      // Assert expectations - Catalog Service
      if (scenario.assert?.catalog?.entries) {
        expect(JSON.parse(JSON.stringify(catalog.mockEntries))).toEqual(
          JSON.parse(JSON.stringify(scenario.assert.catalog.entries)),
        );
      }
    });
  });
}

function main() {
  // Establish dynamic prototype spies to automatically connect inner-constructed
  // API clients directly to the scenario mock data registries.
  spyOn(gcp.CatalogClient.prototype, 'getEntryGroup').mockImplementation(
    async function (project: string, location: string, id: string) {
      if (currentCatalogMock) {
        return await currentCatalogMock.getEntryGroup(project, location, id);
      }
      return {status: 404, message: 'Not found'};
    },
  );

  spyOn(gcp.CatalogClient.prototype, 'getEntryType').mockImplementation(
    async function (project: string, location: string, type: string) {
      if (currentCatalogMock) {
        return await currentCatalogMock.getEntryType(project, location, type);
      }
      return {status: 404, message: 'Not found'};
    },
  );

  spyOn(gcp.CatalogClient.prototype, 'getAspectType').mockImplementation(
    async function (project: string, location: string, type: string) {
      if (currentCatalogMock) {
        return await currentCatalogMock.getAspectType(project, location, type);
      }
      return {status: 404, message: 'Not found'};
    },
  );

  spyOn(gcp.CatalogClient.prototype, 'getEntry').mockImplementation(
    async function (
      project: string,
      location: string,
      entryGroup: string,
      entry: string,
    ) {
      if (currentCatalogMock) {
        return await currentCatalogMock.getEntry(
          project,
          location,
          entryGroup,
          entry,
        );
      }
      return {status: 404, message: 'Not found'};
    },
  );

  spyOn(gcp.CatalogClient.prototype, 'lookupEntry').mockImplementation(
    async function (project: string, location: string, entry: string) {
      if (currentCatalogMock) {
        return await currentCatalogMock.lookupEntry(project, location, entry);
      }
      return {status: 404, message: 'Not found'};
    },
  );

  spyOn(gcp.CatalogClient.prototype, 'modifyEntry').mockImplementation(
    async function (
      project: string,
      location: string,
      entry: gcp.Entry,
      updateMask?: string[],
      aspectKeys?: string[],
    ) {
      if (currentCatalogMock) {
        return await currentCatalogMock.modifyEntry(
          project,
          location,
          entry,
          updateMask,
          aspectKeys,
        );
      }
      return {status: 404, message: 'Not found'};
    },
  );

  spyOn(gcp.CatalogClient.prototype, 'listEntries').mockImplementation(
    async function* (project: string, location: string, entryGroup: string) {
      if (currentCatalogMock) {
        for await (const entry of currentCatalogMock.listEntries(
          project,
          location,
          entryGroup,
        )) {
          yield entry;
        }
      }
    },
  );

  spyOn(gcp.CatalogClient.prototype, 'updateEntry').mockImplementation(
    async function (
      entry: gcp.Entry,
      updateMask?: string[],
      aspectKeys?: string[],
    ) {
      if (currentCatalogMock) {
        return await currentCatalogMock.updateEntry(
          entry,
          updateMask,
          aspectKeys,
        );
      }
      return {status: 404, message: 'Not found'};
    },
  );

  spyOn(gcp.CatalogClient.prototype, 'createEntry').mockImplementation(
    async function (
      project: string,
      location: string,
      entryGroup: string,
      entryId: string,
      entry?: gcp.Entry,
    ) {
      if (currentCatalogMock) {
        return await currentCatalogMock.createEntry(
          project,
          location,
          entryGroup,
          entryId,
          entry,
        );
      }
      return {status: 404, message: 'Not found'};
    },
  );

  spyOn(bq.BigQueryClient.prototype, 'getDataset').mockImplementation(
    async function (project: string, dataset: string) {
      if (currentBigQueryMock) {
        return await currentBigQueryMock.getDataset(project, dataset);
      }
      return {status: 404, message: 'Not found'};
    },
  );

  spyOn(bq.BigQueryClient.prototype, 'listTables').mockImplementation(
    async function* (project: string, dataset: string) {
      if (currentBigQueryMock) {
        for await (const table of currentBigQueryMock.listTables(
          project,
          dataset,
        )) {
          yield table;
        }
      }
    },
  );

  spyOn(gcp.BigLakeClient.prototype, 'listTables').mockImplementation(
    async function* (
      project: string,
      location: string,
      catalog: string,
      database: string,
    ) {
      if (currentBigLakeMock) {
        for await (const table of currentBigLakeMock.listTables(
          project,
          location,
          catalog,
          database,
        )) {
          yield table;
        }
      }
    },
  );

  // Globally mock fs and node:fs to direct file system calls to virtual volume
  mock.module('fs', () => memfs);
  mock.module('node:fs', () => memfs);

  for (const scenario of scenarios) {
    runScenario(scenario);
  }

  describe('BigLake Namespace Init Failure', () => {
    test('should throw error on malformed coordinate', () => {
      expect(
        kcmac.CatalogManifest.initWithBigLakeNamespace(
          'invalid-format',
          'iceberg',
          TEST_API_CONTEXT,
        ),
      ).rejects.toThrow(
        'BigLake namespace must be in format <projectId>.<catalogId>.<namespaceId>',
      );

      expect(
        kcmac.CatalogManifest.initWithBigLakeNamespace(
          'proj.cat',
          'iceberg',
          TEST_API_CONTEXT,
        ),
      ).rejects.toThrow(
        'BigLake namespace must be in format <projectId>.<catalogId>.<namespaceId>',
      );
    });
  });
}

main();
