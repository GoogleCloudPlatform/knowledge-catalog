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
import {SemanticModel} from './ir';
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

    // Every model must declare exactly one deployment target -- a single
    // BigQuery Graph URI (we do not support zero or several graphs per model).
    if (deployInfo.uris.length !== 1) {
      errors.push(
          `model '${model.name}' (${document}) declares ${
              deployInfo.uris.length} deploymentTargets; exactly one BigQuery ` +
          `Graph target is required under its GOOGLE custom_extension.`);
    } else if (deployInfo.malformed.length) {
      // The single target is present but is not a valid BigQuery Graph URI.
      errors.push(
          `model '${model.name}' (${document}) deploymentTarget '${
              deployInfo.malformed[0]}' is not a valid BigQuery Graph URI; ` +
          `expected //bigquery.googleapis.com/projects/<p>/datasets/<d>/` +
          `propertyGraphs/<g>.`);
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
// Each distinct source is probed with a dry-run query (`SELECT 1 FROM <ref>`,
// suffixed `WHERE FALSE` so it scans no data),
// so BigQuery resolves the reference exactly as the generated DDL will. That
// covers every reference form the generator emits -- a three-part
// `project.dataset.table`, a four-part federated REST-catalog / Lakehouse name
// (e.g. an Apache Iceberg table via BigLake), and quoted identifiers -- rather
// than only a three-part name. A source the loader kept verbatim because it is a
// query (contains whitespace) is not a table and is skipped. The dry-run is
// billed to the model's BigQuery deployment-target project (the same project the
// deploy runs against), falling back to `defaultProject`. Each distinct (billing
// project, reference) pair is probed once. Returns one message per unreachable
// table (empty when all pass).
export async function validateBigQueryDataSources(
    models: LoadedModel[], bq: BigQueryClient,
    defaultProject: string): Promise<string[]> {
  // Dedup by billing project + reference so a table shared across
  // entities/models is probed once; keep the first reference for a locatable
  // error message.
  const refs = new Map<string, {
    project: string; ref: string; document: string; model: string;
    entity: string;
  }>();
  for (const {document, model} of models) {
    const project = billingProject(model, defaultProject);
    for (const entity of model.entities ?? []) {
      const ref = probeableRef(entity.dataSource);
      if (!ref) continue;
      const key = `${project}\u0000${ref}`;
      if (!refs.has(key)) {
        refs.set(key, {
          project, ref, document, model: model.name, entity: entity.name,
        });
      }
    }
  }

  const errors: string[] = [];
  for (const {project, ref, document, model, entity} of refs.values()) {
    const res =
        await bq.query(
        project, `SELECT 1 FROM \`${ref}\` WHERE FALSE`, undefined, true);
    if (res.status === 200) continue;
    const msg = res.message?.trim() || `HTTP ${res.status}`;
    const why = /not found/i.test(msg) ?
        'does not exist' :
        /access denied|permission denied|not authorized|does not have permission/i
                .test(msg) ?
        'is not accessible (permission denied)' :
        `could not be verified (${msg})`;
    errors.push(
        `entity '${entity}' in model '${model}' (${document}) references ` +
        `BigQuery table '${ref}', which ${why}; the model cannot be deployed. ` +
        `Create the table or grant access to it, or fix the entity's source.`);
  }
  return errors;
}


// The BigQuery project a model's deploy -- and thus its dry-run pre-flight --
// bills to: the project of the model's first BigQuery Graph deployment target
// (where the CREATE PROPERTY GRAPH runs), falling back to the scope's default
// project when the model declares no parseable BigQuery Graph target.
// googleDeploymentTargets is safe here: validatePushRequirements ran first and
// already rejected a malformed GOOGLE extension.
function billingProject(model: SemanticModel, defaultProject: string): string {
  try {
    return googleDeploymentTargets(model).targets[0]?.project ?? defaultProject;
  } catch {
    return defaultProject;
  }
}


// A source that can be probed as a BigQuery table: the canonical `dataSource`,
// trimmed, or null when it is not a table reference -- empty, or a query the
// loader kept verbatim (contains whitespace). Unlike a tables.get probe this
// imposes no part-count limit, so a three-part `project.dataset.table` and a
// four-part REST-catalog / Lakehouse name are both returned for the dry-run to
// resolve.
function probeableRef(dataSource: string|undefined): string|null {
  const trimmed = (dataSource ?? '').trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  return trimmed;
}
