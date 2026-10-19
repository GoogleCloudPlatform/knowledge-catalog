// Resolves what a Knowledge Catalog push needs from the environment to close
// the loop with BigQuery (K1 / K3): which annotation aspect types the
// destination project has, and where the `@bigquery` entries of the model's
// physical assets live (a dataset's location, a project's number).
//
// Kept apart from knowledge_catalog.ts (pure) and deploy_knowledge_catalog.ts
// (writes) so the CLI calls one function per concern and the library defaults
// stay network-free: a caller that passes neither option gets the pre-K1 push.

import {BigQueryClient} from '../gcp/bigquery';
import {ApiContext} from '../gcp/context';
import {ResourceManagerClient} from '../gcp/crm';
import {CatalogClient} from '../gcp/dataplex';

import {SemanticModel} from './ir';
import {provisionedCustomAspects} from './kc_custom_types';
import {BigQueryEntryLocator, physicalBindings} from './knowledge_catalog';

/** Probes the destination for the annotation aspect types `kcmd init` made. */
export async function probeAnnotationAspects(
    ctx: ApiContext, dest: {project: string}): Promise<string[]> {
  return provisionedCustomAspects(new CatalogClient(ctx), dest);
}

/**
 * Locates the datasets (and project numbers) of every physical asset the
 * models' entities are read through: node views, the graph and, for an entity
 * bound directly, its source table. A failed read leaves that dataset out, so
 * the emitter skips its binding links with a warning instead of failing.
 */
export async function resolveBigQueryEntries(
    models: SemanticModel[], ctx: ApiContext): Promise<BigQueryEntryLocator> {
  const bq = new BigQueryClient(ctx);
  const crm = new ResourceManagerClient(ctx);
  const datasets = new Set<string>();
  for (const model of models) {
    for (const [name, phys] of physicalBindings(model)) {
      const refs = [phys.nodeView, phys.graph];
      if (!phys.nodeView) {
        refs.push((model.entities ?? []).find(e => e.name === name)?.dataSource);
      }
      for (const ref of refs) {
        const parts = (ref ?? '').replace(/`/g, '').trim().split('.');
        if (parts.length === 3 && parts.every(p => p && !/\s/.test(p))) {
          datasets.add(`${parts[0]}.${parts[1]}`);
        }
      }
    }
  }
  const datasetLocations = new Map<string, string>();
  const projectNumbers = new Map<string, string>();
  for (const key of datasets) {
    const [project, dataset] = key.split('.');
    try {
      const ds = await bq.getDataset(project, dataset);
      const loc = ds.status === 200 ? (ds.result as any)?.location : undefined;
      if (loc) datasetLocations.set(key, String(loc).toLowerCase());
    } catch {
      // Unknown location: its binding links are skipped with a warning.
    }
    if (!projectNumbers.has(project) && !/^\d+$/.test(project)) {
      try {
        const res = await crm.getProject(project);
        const n = res.status === 200 ?
            res.result?.name?.replace(/^projects\//, '') :
            undefined;
        if (n) projectNumbers.set(project, n);
      } catch {
        // The project id works in an entry reference too.
      }
    }
  }
  return {datasetLocations, projectNumbers};
}
