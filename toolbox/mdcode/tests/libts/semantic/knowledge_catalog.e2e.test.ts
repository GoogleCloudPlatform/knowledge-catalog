// End-to-end tests for the Knowledge Catalog destination: real-shaped fixtures
// run the full file -> IR -> catalog-resources path.
//
// The primary check is a GOLDEN test: for every fixture in the corpus, the
// generated Entries (with their `semantic-*` / `schema` aspects) plus the
// emitter warnings are compared byte-for-byte against a committed
// `<fixture>.knowledge_catalog.golden.json`. The golden is the reviewable "big
// picture" — open a `.yaml` next to its `.knowledge_catalog.golden.json` to see
// the full input and the exact catalog resources it maps to; a changed aspect
// shape, dropped field, or reordered entry shows up as a diff.
//
//   Regenerate goldens after an intentional emitter change:
//     UPDATE_GOLDENS=1 npx bun test \
//         ./tests/libts/semantic/knowledge_catalog.e2e.test.ts
//   then read the diff before committing.
//
// Focused behavior (warnings, schema-join link emission, metric dataType
// fallback) is asserted in knowledge_catalog.test.ts; the publisher's write
// sequence in deploy_knowledge_catalog.test.ts.

import {describe, expect, test} from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {loadModels, LoadOptions} from '../../../src/libts/semantic/loader';

const FIXTURES = path.join(__dirname, 'fixtures');

// Fixtures that get a KC golden. Chosen to exercise the distinct mappings:
//   sales_bq_graph_target -> model aspect deploymentTargets + un-typed metric
//     (dataType fallback); star_orders_customer -> a direct-FK relationship
//     (schema-join link) + multiple entities/metrics; tpcds_date_edge ->
//     temporal field types.
const CORPUS = [
  'sales_bq_graph_target.yaml',
  'star_orders_customer.yaml',
  'tpcds_date_edge.yaml',
];

// A fixed destination + default (dataplex-types/global) system types, so the
// golden pins the exact resource names the emitter produces.
const GEN_OPTS = {
  project: 'sqlgen-testing',
  location: 'us',
  entryGroup: 'semantic'
};

function loadFixture(fixture: string, load: LoadOptions = {}) {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  return loadModels(
      text,
      {defaultProject: 'sqlgen-testing', defaultDataset: 'demo', ...load});
}

// The exact artifact a golden captures: the generated entries, then the
// relationship entry links, then the emitter warnings, as pretty JSON so a
// reviewer sees the full resource shapes.
function render(fixture: string): string {
  const {models} = loadFixture(fixture);
  const {entries, entryLinks, warnings} =
      generateCatalogResources(models[0], GEN_OPTS);
  return JSON.stringify({entries, entryLinks, warnings}, null, 2) + '\n';
}

const goldenPath = (fixture: string) => path.join(
    FIXTURES, fixture.replace(/\.yaml$/, '.knowledge_catalog.golden.json'));


describe(
    'golden KC resources: each corpus fixture maps to its exact catalog entries',
    () => {
      for (const fixture of CORPUS) {
        test(fixture, () => {
          const actual = render(fixture);
          const golden = goldenPath(fixture);
          if (process.env.UPDATE_GOLDENS) {
            fs.writeFileSync(golden, actual);
            return;
          }
          if (!fs.existsSync(golden)) {
            throw new Error(`missing golden ${
                path.basename(golden)} — run UPDATE_GOLDENS=1 to create it`);
          }
          expect(actual).toBe(fs.readFileSync(golden, 'utf8'));
        });
      }
    });
