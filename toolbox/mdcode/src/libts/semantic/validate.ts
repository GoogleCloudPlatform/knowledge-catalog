// Push-time validation gate for a semantic model.
//
// Runs once over the shared, already-parsed models (see loadSemanticModels)
// before any destination leg, so a real `kcmd push` AND a `--validate-only` dry
// run enforce the same requirements. Returns one message per violation (an
// empty array means valid); the caller (commands.ts) prints them and aborts the
// push. Kept separate from the loader -- which validates a document against the
// schema -- because these are deployment requirements, not schema rules, and
// they read the GOOGLE deployment-target extension the BigQuery leg owns.

import {BigQueryClient} from '../gcp/bigquery';
import {googleDeploymentTargets} from './deploy_bigquery';
import {LoadedModel} from './loader';

// Checks every model against the push requirements and returns the collected
// error messages (empty when all models pass), each tagged with the model's
// source document so the author can find it.
export function validatePushRequirements(models: LoadedModel[]): string[] {
  const errors: string[] = [];
  for (const {document, model} of models) {
    let deployInfo: ReturnType<typeof googleDeploymentTargets>;
    try {
      // One pass over the model's GOOGLE extension(s): both checks below read
      // the same parse rather than re-parsing the JSON per reader.
      deployInfo = googleDeploymentTargets(model);
    } catch (err: any) {
      // Malformed GOOGLE extension JSON: surface it as a validation error here
      // rather than letting it throw out of a later leg as an uncaught stack.
      errors.push(`${err.message || err} (${document})`);
      continue;
    }

    // Every model must declare at least one deployment target.
    if (!deployInfo.uris.length) {
      errors.push(
          `model '${model.name}' (${document}) declares no deploymentTargets; ` +
          `add at least one under its GOOGLE custom_extension.`);
    }

    // A model that targets a BigQuery graph must have every metric resolve to a
    // single entity, or the metric cannot lower to a MEASURE and would be
    // silently dropped from the graph. The loader sets metric.entity only when
    // the expression resolves to exactly one entity, so an unset entity is the
    // "references zero or multiple entities" case.
    if (deployInfo.targets.length > 0) {
      for (const metric of model.metrics ?? []) {
        if (!metric.entity) {
          errors.push(
              `metric '${metric.name}' in model '${model.name}' (${
                  document}) targets a BigQuery graph but does not resolve to a ` +
              `single entity; set its attach entity or scope its expression to ` +
              `one entity.`);
        }
      }
    }
  }
  return errors;
}


// Live pre-flight over the same models: confirms every entity's BigQuery source
// table is reachable BEFORE any destination leg runs, so a push -- to BigQuery
// or to Knowledge Catalog -- fails fast when the model could not deploy, rather
// than surfacing a missing table only once the BigQuery leg executes its DDL.
// The entity sources are BigQuery tables regardless of --target, so this runs
// for every destination and for --validate-only.
//
// Only a clean three-part `project.dataset.table` source is probed; a source
// the loader kept verbatim because it is a query or is not a plain table
// reference cannot be resolved to a tables.get and is skipped. Each distinct
// table is checked once. Returns one message per unreachable table (empty when
// all pass).
export async function validateBigQueryDataSources(
    models: LoadedModel[], bq: BigQueryClient): Promise<string[]> {
  // Dedup by fully-qualified table so a table shared across entities/models is
  // probed once; keep the first reference for a locatable error message.
  const refs =
      new Map<string, {document: string; model: string; entity: string}>();
  for (const {document, model} of models) {
    for (const entity of model.entities ?? []) {
      const parsed = parseTableRef(entity.dataSource);
      if (!parsed) continue;
      const key = `${parsed.project}.${parsed.dataset}.${parsed.table}`;
      if (!refs.has(key)) {
        refs.set(key, {document, model: model.name, entity: entity.name});
      }
    }
  }

  const errors: string[] = [];
  for (const [key, where] of refs) {
    const {project, dataset, table} = parseTableRef(key)!;
    const res = await bq.getTable(project, dataset, table);
    if (res.status === 200) continue;
    const why = res.status === 404 ?
        'does not exist' :
        res.status === 403 ?
        'is not accessible (permission denied)' :
        `could not be verified (${res.message?.trim() || `HTTP ${res.status}`})`;
    errors.push(
        `entity '${where.entity}' in model '${where.model}' (${
            where.document}) references BigQuery table '${key}', which ${why}; ` +
        `the model cannot be deployed. Create the table or grant access to it, ` +
        `or fix the entity's source.`);
  }
  return errors;
}


// Parses a canonical entity dataSource into a BigQuery table reference, or null
// when it is not a plain three-part `project.dataset.table` name -- a query
// (contains whitespace) or an under/over-qualified reference the loader passed
// through verbatim -- and so cannot be probed with tables.get.
function parseTableRef(dataSource: string|undefined):
    {project: string; dataset: string; table: string}|null {
  const trimmed = (dataSource ?? '').trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const parts = trimmed.split('.').map(
      p => p.replace(/^[`"]/, '').replace(/[`"]$/, ''));
  if (parts.length !== 3 || parts.some(p => !p.length)) return null;
  return {project: parts[0], dataset: parts[1], table: parts[2]};
}
