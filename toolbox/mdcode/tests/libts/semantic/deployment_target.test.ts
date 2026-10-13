// Tests for reading a model's named deployments (deployment_target.ts): the
// `--deployment` selection, resolving each entry's target to its engine and
// coordinates, and googleDeploymentTargets reading the list instead of the
// GOOGLE block the loader folds it into.

import {describe, expect, test} from 'bun:test';

import {destinationKey, googleDeploymentTargets, parseDeploymentSelection, resolveModelDeployments} from '../../../src/libts/semantic/deployment_target';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';

const BQ_URI =
    '//bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/retail';
const SPANNER_URI =
    '//spanner.googleapis.com/projects/acme/instances/ops/databases/sales/propertyGraphs/retail';
const ALLOY_URI =
    '//alloydb.googleapis.com/projects/acme/locations/us-central1/clusters/main/databases/sales';
const ALLOY_INSTANCE_URI =
    '//alloydb.googleapis.com/projects/acme/locations/us-central1/clusters/main/instances/primary/databases/sales';

// A Google-flavor model loaded from `deployments:` entries, so it carries the
// GOOGLE block the loader folds the targets into.
function modelWith(
    deployments: Array<{name: string; target: string; profile?: string}>):
    SemanticModel {
  const entries = deployments.map(
      d => `      - name: ${d.name}\n        target: "${d.target}"\n` +
          (d.profile ? `        profile: ${d.profile}\n` : ''));
  const text = `version: "0.2.0.dev0/google"
semantic_model:
  - name: retail
    deployments:
${entries.join('')}    entities:
      - name: Order
        primary_key: [id]
        fields:
          - { name: id }
`;
  return loadModels(text, {bindingOptional: true}).models[0];
}

function resolved(model: SemanticModel, selected?: string[]) {
  const res = resolveModelDeployments(model, selected);
  if ('error' in res) throw new Error(res.error);
  return res.deployments;
}

function errorOf(model: SemanticModel, selected?: string[]): string {
  const res = resolveModelDeployments(model, selected);
  if (!('error' in res)) throw new Error('expected an error');
  return res.error;
}


describe('parseDeploymentSelection', () => {
  test('a single name', () => {
    expect(parseDeploymentSelection('a')).toEqual(['a']);
  });

  test('a comma-separated list', () => {
    expect(parseDeploymentSelection('a,b')).toEqual(['a', 'b']);
  });

  test('a repeated flag, keeping the first of each name', () => {
    expect(parseDeploymentSelection(['a,b', 'c', 'a'])).toEqual(['a', 'b', 'c']);
  });

  test('pieces are trimmed and empty ones dropped', () => {
    expect(parseDeploymentSelection(' a , ,b ')).toEqual(['a', 'b']);
  });

  test('an absent or negated flag selects nothing', () => {
    expect(parseDeploymentSelection(true)).toBeUndefined();
    expect(parseDeploymentSelection(false)).toBeUndefined();
    expect(parseDeploymentSelection(undefined)).toBeUndefined();
  });

  // A repeated flag fails when any one occurrence names nothing. A bare
  // `--deployment` among repeated ones arrives as `true`.
  test('a flag that names no deployment is an error', () => {
    for (const raw of
             ['', ',', [' , ', ''], ['a', ''], ['a', ' , '], ['a', true], []]) {
      expect(() => parseDeploymentSelection(raw))
          .toThrow('--deployment names no deployment');
    }
  });
});


describe('resolveModelDeployments: resource URIs', () => {
  test('a BigQuery graph', () => {
    const [d] = resolved(modelWith([{name: 'bq_prod', target: BQ_URI}]));
    expect(d.engine).toBe('bigquery');
    expect(d.coordinates).toEqual(
        {project: 'acme', dataset: 'sales', graphName: 'retail', uri: BQ_URI});
  });

  test('a Spanner graph', () => {
    const [d] =
        resolved(modelWith([{name: 'spanner_prod', target: SPANNER_URI}]));
    expect(d.engine).toBe('spanner');
    expect(d.coordinates).toEqual({
      project: 'acme',
      instance: 'ops',
      database: 'sales',
      graphName: 'retail',
      uri: SPANNER_URI,
    });
  });

  test('an AlloyDB database, named by its cluster', () => {
    const [d] = resolved(modelWith([{name: 'alloy_prod', target: ALLOY_URI}]));
    expect(d.engine).toBe('alloydb');
    expect(d.coordinates).toEqual({
      project: 'acme',
      location: 'us-central1',
      cluster: 'main',
      database: 'sales',
      uri: ALLOY_URI,
    });
  });

  test('the instance-based AlloyDB URI is rejected', () => {
    const error =
        errorOf(modelWith([{name: 'alloy_prod', target: ALLOY_INSTANCE_URI}]));
    expect(error).toContain(
        `Model 'retail': deployment 'alloy_prod' targets '${
            ALLOY_INSTANCE_URI}', the instance-based AlloyDB URI, which ` +
        'names no real resource');
    expect(error).toContain(`write '${ALLOY_URI}'.`);
  });

  test('a URI of no supported destination is rejected', () => {
    const target =
        '//bigquery.googleapis.com/projects/acme/datasets/sales/tables/orders';
    expect(errorOf(modelWith([{name: 'bq_prod', target}])))
        .toContain(
            `deployment 'bq_prod' targets '${target}', which is not a ` +
            'BigQuery graph, a Spanner graph or an AlloyDB database');
  });
});


// kcmd accepts no Knowledge Catalog name as a target, and the error names the
// resource URI form to write.
describe('resolveModelDeployments: Knowledge Catalog names', () => {
  const BQ_FORM =
      '//bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>';

  test('a graph or database name is rejected with the URI form to write', () => {
    for (const [target, form] of [
           ['bigquery:graph:acme.sales.retail', BQ_FORM],
           ['bigquery:propertygraph:acme.sales.retail', BQ_FORM],
           [
             'spanner:graph:acme.regional-us-central1.ops.sales.retail',
             '//spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/propertyGraphs/<g>',
           ],
           [
             'alloydb:acme.us-central1.main.sales',
             '//alloydb.googleapis.com/projects/<p>/locations/<l>/clusters/<c>/databases/<db>',
           ],
         ]) {
      expect(errorOf(modelWith([{name: 'prod', target}])))
          .toBe(
              `Model 'retail': deployment 'prod' targets '${target}', which ` +
              `is a Knowledge Catalog name. Write the resource URI instead: ` +
              `'${form}'.`);
    }
  });

  test('any other catalog name gets every URI form', () => {
    const target = 'bigquery:acme.sales.retail';
    const error = errorOf(modelWith([{name: 'bq_prod', target}]));
    expect(error).toContain(
        `targets '${target}', which is not a BigQuery graph, a Spanner graph ` +
        'or an AlloyDB database. Write a resource URI:');
    expect(error).toContain(`'${BQ_FORM}'`);
  });
});


describe('destinationKey', () => {
  test('is the target as written', () => {
    expect(destinationKey(BQ_URI)).toBe(BQ_URI);
    expect(destinationKey(SPANNER_URI)).toBe(SPANNER_URI);
    expect(destinationKey(ALLOY_URI)).toBe(ALLOY_URI);
    expect(destinationKey('not a target')).toBe('not a target');
  });

  test('names a legacy AlloyDB database by its cluster-based URI', () => {
    expect(destinationKey(ALLOY_INSTANCE_URI)).toBe(ALLOY_URI);
  });
});


describe('resolveModelDeployments: profiles and selection', () => {
  const model = modelWith([
    {name: 'bq_prod', target: BQ_URI, profile: 'analytical'},
    {name: 'spanner_prod', target: SPANNER_URI, profile: 'operational'},
    {name: 'alloy_prod', target: ALLOY_URI},
  ]);

  test('every deployment, in declaration order, with its profile', () => {
    expect(resolved(model).map(d => [d.name, d.profile])).toEqual([
      ['bq_prod', 'analytical'],
      ['spanner_prod', 'operational'],
      ['alloy_prod', 'default'],
    ]);
  });

  test('selection keeps the order given', () => {
    expect(resolved(model, ['alloy_prod', 'bq_prod']).map(d => d.name))
        .toEqual(['alloy_prod', 'bq_prod']);
  });

  test('an unknown name lists what the model declares', () => {
    expect(errorOf(model, ['bq_prod', 'missing']))
        .toBe(
            "Model 'retail' has no deployment named 'missing' (available: " +
            'bq_prod, spanner_prod, alloy_prod).');
  });

  test('only the selected targets are parsed', () => {
    const mixed = modelWith([
      {name: 'good', target: BQ_URI},
      {name: 'bad', target: ALLOY_INSTANCE_URI},
    ]);
    expect(resolved(mixed, ['good']).map(d => d.name)).toEqual(['good']);
    expect(errorOf(mixed)).toContain("deployment 'bad'");
  });
});


describe('googleDeploymentTargets reads the named list', () => {
  test('three deployments give three targets, not six', () => {
    const model = modelWith([
      {name: 'bq_prod', target: BQ_URI},
      {name: 'spanner_prod', target: SPANNER_URI},
      {name: 'alloy_prod', target: ALLOY_URI},
    ]);
    // The loader also folds the three targets into a GOOGLE block.
    expect(JSON.parse(model.customExtensions![0].data).deploymentTargets)
        .toEqual([BQ_URI, SPANNER_URI, ALLOY_URI]);
    const targets = googleDeploymentTargets(model);
    expect(targets.uris).toEqual([BQ_URI, SPANNER_URI, ALLOY_URI]);
    expect(targets.bigQuery).toHaveLength(1);
    expect(targets.spanner).toHaveLength(1);
    expect(targets.alloyDb).toHaveLength(1);
    expect(targets.malformed).toEqual([]);
  });

  test('a narrowed model sees only the deployments it keeps', () => {
    const model = modelWith([
      {name: 'bq_prod', target: BQ_URI},
      {name: 'spanner_prod', target: SPANNER_URI},
    ]);
    const narrowed = {...model, deployments: [model.deployments![1]]};
    expect(googleDeploymentTargets(narrowed).uris).toEqual([SPANNER_URI]);
  });

  test('a catalog name is malformed, in a list or in a GOOGLE block', () => {
    const target = 'bigquery:graph:acme.sales.retail';
    const listed = googleDeploymentTargets(
        modelWith([{name: 'bq_prod', target}]));
    expect(listed.bigQuery).toEqual([]);
    expect(listed.malformed).toEqual([target]);
    const vanilla = googleDeploymentTargets({
      name: 'm',
      entities: [],
      relationships: [],
      metrics: [],
      customExtensions: [{
        vendorName: 'GOOGLE',
        data: JSON.stringify({deploymentTargets: [target]}),
      }],
    });
    expect(vanilla.bigQuery).toEqual([]);
    expect(vanilla.malformed).toEqual([target]);
  });

  // A legacy file's `deployment_target:` may still hold the instance-based
  // URI, and keeps working until the demo moves off it.
  test('a legacy deployment_target keeps its instance-based AlloyDB URI', () => {
    const model = loadModels(
                      `version: "0.2.0.dev0/google"
semantic_model:
  - name: retail
    deployment_target: ${ALLOY_INSTANCE_URI}
    entities:
      - name: Order
        primary_key: [id]
        fields:
          - { name: id }
`,
                      {bindingOptional: true, allowLegacyBareSource: true})
                      .models[0];
    expect(googleDeploymentTargets(model).alloyDb).toEqual([{
      project: 'acme',
      location: 'us-central1',
      cluster: 'main',
      instance: 'primary',
      database: 'sales',
      uri: ALLOY_INSTANCE_URI,
    }]);
  });
});
