// Push-time validation gate for a semantic model.
//
// Runs once over the shared, already-parsed models (see loadSemanticModels)
// before any destination leg, so a real `kcmd push` AND a `--validate-only` dry
// run enforce the same requirements. Returns one message per violation (an
// empty array means valid); the caller (commands.ts) prints them and aborts the
// push. Kept separate from the loader -- which validates a document against the
// schema -- because these are deployment requirements, not schema rules, and
// they read the GOOGLE deployment-target extension the BigQuery leg owns.

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
