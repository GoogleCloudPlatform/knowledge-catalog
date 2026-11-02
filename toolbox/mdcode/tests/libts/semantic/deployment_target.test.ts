// Tests for reading a model's named deployments (deployment_target.ts): the
// `--deployment` selection, resolving each entry's target to its engine and
// coordinates, and googleDeploymentTargets reading the list instead of the
// GOOGLE block the loader folds it into.

import {describe, expect, test} from 'bun:test';

import {ALLOYDB_FORM, BQ_GRAPH_FORM, destinationKey, googleDeploymentTargets, parseDeploymentSelection, resolveModelDeployments, SPANNER_GRAPH_FORM} from '../../../src/libts/semantic/deployment_target';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';

const BQ =
    'bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/retail';
const SPANNER =
    'spanner.googleapis.com/projects/acme/instances/ops/databases/sales/graphs/retail';
const ALLOY =
    'alloydb.googleapis.com/projects/acme/locations/us-central1/clusters/main/databases/sales';
const ALLOY_INSTANCE =
    'alloydb.googleapis.com/projects/acme/locations/us-central1/clusters/main/instances/primary/databases/sales';

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


describe('resolveModelDeployments: GCP resource names', () => {
  test('a BigQuery graph', () => {
    const [d] = resolved(modelWith([{name: 'bq_prod', target: BQ}]));
    expect(d.engine).toBe('bigquery');
    expect(d.coordinates).toEqual(
        {project: 'acme', dataset: 'sales', graphName: 'retail', uri: BQ});
  });

  test('a Spanner graph', () => {
    const [d] = resolved(modelWith([{name: 'spanner_prod', target: SPANNER}]));
    expect(d.engine).toBe('spanner');
    expect(d.coordinates).toEqual({
      project: 'acme',
      instance: 'ops',
      database: 'sales',
      graphName: 'retail',
      uri: SPANNER,
    });
  });

  test('an AlloyDB database, named by its cluster', () => {
    const [d] = resolved(modelWith([{name: 'alloy_prod', target: ALLOY}]));
    expect(d.engine).toBe('alloydb');
    expect(d.coordinates).toEqual({
      project: 'acme',
      location: 'us-central1',
      cluster: 'main',
      database: 'sales',
      uri: ALLOY,
    });
  });
});


// A target in an old form or another unaccepted one is rejected, and the
// error names what to write instead: the resource name of a resource URI, the
// cluster-based name of the instance-based AlloyDB name, and the resource name
// form of a Knowledge Catalog name.
describe('resolveModelDeployments: rejected targets', () => {
  const at = (target: string) =>
      `Model 'retail': deployment 'prod' targets '${target}', `;
  const notADestination =
      `which is not a BigQuery graph, a Spanner graph or an AlloyDB database. ` +
      `Write a GCP resource name: '${BQ_GRAPH_FORM}', '${SPANNER_GRAPH_FORM}' or '${ALLOYDB_FORM}'.`;
  for (const [target, rest] of [
         ...[BQ, SPANNER, ALLOY].map(name => [
           `//${name}`,
           `which is a resource URI; write its GCP resource name, without the ` +
               `leading '//': '${name}'.`,
         ]),
         ...[ALLOY_INSTANCE, `//${ALLOY_INSTANCE}`].map(legacy => [
           legacy,
           `the instance-based AlloyDB name, which names no real resource. An ` +
               `AlloyDB database belongs to its cluster; write '${ALLOY}'.`,
         ]),
         ...[
           ['bigquery:graph:acme.sales.retail', BQ_GRAPH_FORM],
           ['bigquery:propertygraph:acme.sales.retail', BQ_GRAPH_FORM],
           ['spanner:graph:acme.regional-us-central1.ops.sales.retail', SPANNER_GRAPH_FORM],
           ['alloydb:acme.us-central1.main.sales', ALLOYDB_FORM],
         ].map(([name, form]) => [
           name,
           `which is a Knowledge Catalog name. Write the GCP resource name ` +
               `instead: '${form}'.`,
         ]),
         ...[SPANNER, `//${SPANNER}`].map(graph => [
           graph.replace('/graphs/', '/propertyGraphs/'),
           `which names a Spanner graph by 'propertyGraphs'; write its ` +
               `Dataplex name: '${SPANNER}'.`,
         ]),
         // A graph name kcmd cannot accept is not given a `graphs/` name to
         // write, which would be rejected in turn.
         [SPANNER.replace('/graphs/retail', '/propertyGraphs/bad.name'), notADestination],
         ['bigquery:acme.sales.retail', notADestination],
         ['bigquery.googleapis.com/projects/acme/datasets/sales/tables/orders', notADestination],
         ['//bigquery.googleapis.com/projects/acme/datasets/sales/tables/orders', notADestination],
       ]) {
    test(`'${target}'`, () => {
      expect(errorOf(modelWith([{name: 'prod', target}]))).toBe(at(target) + rest);
    });
  }
});


describe('destinationKey', () => {
  test('is the resource URI of the target, which the checks compare', () => {
    expect(destinationKey(BQ)).toBe(`//${BQ}`);
    expect(destinationKey(ALLOY)).toBe(`//${ALLOY}`);
    expect(destinationKey('not a target')).toBe('not a target');
  });

  test('names a legacy AlloyDB database by its cluster', () => {
    expect(destinationKey(ALLOY_INSTANCE)).toBe(`//${ALLOY}`);
  });
});


describe('resolveModelDeployments: profiles and selection', () => {
  const model = modelWith([
    {name: 'bq_prod', target: BQ, profile: 'analytical'},
    {name: 'spanner_prod', target: SPANNER, profile: 'operational'},
    {name: 'alloy_prod', target: ALLOY},
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
      {name: 'good', target: BQ},
      {name: 'bad', target: ALLOY_INSTANCE},
    ]);
    expect(resolved(mixed, ['good']).map(d => d.name)).toEqual(['good']);
    expect(errorOf(mixed)).toContain("deployment 'bad'");
  });
});


describe('googleDeploymentTargets reads the named list', () => {
  test('three deployments give three targets, not six', () => {
    const model = modelWith([
      {name: 'bq_prod', target: BQ},
      {name: 'spanner_prod', target: SPANNER},
      {name: 'alloy_prod', target: ALLOY},
    ]);
    // The loader also folds the three targets into a GOOGLE block.
    expect(JSON.parse(model.customExtensions![0].data).deploymentTargets)
        .toEqual([BQ, SPANNER, ALLOY]);
    const targets = googleDeploymentTargets(model);
    expect(targets.uris).toEqual([BQ, SPANNER, ALLOY]);
    expect(targets.bigQuery).toHaveLength(1);
    expect(targets.spanner).toHaveLength(1);
    expect(targets.alloyDb).toHaveLength(1);
    expect(targets.malformed).toEqual([]);
  });

  test('a narrowed model sees only the deployments it keeps', () => {
    const model = modelWith([
      {name: 'bq_prod', target: BQ},
      {name: 'spanner_prod', target: SPANNER},
    ]);
    const narrowed = {...model, deployments: [model.deployments![1]]};
    expect(googleDeploymentTargets(narrowed).uris).toEqual([SPANNER]);
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
  // name, and keeps working until the demo moves off it.
  test('a legacy deployment_target keeps its instance-based AlloyDB name', () => {
    const model = loadModels(
                      `version: "0.2.0.dev0/google"
semantic_model:
  - name: retail
    deployment_target: ${ALLOY_INSTANCE}
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
      uri: ALLOY_INSTANCE,
    }]);
  });
});
