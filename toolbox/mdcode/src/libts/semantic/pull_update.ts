// What a pull would write for a model whose catalog entries say what the local
// files say.
//
// Pull rebuilds each model and profile file from the catalog, so the files it
// writes lose the author's comments and formatting, and give the content in
// one normal form: an `ai_context` in its object form, entities, metrics and
// relationships sorted by name, and so on (see fidelity.md, "What pull
// recovers"). A local file whose content the catalog already holds is one pull
// need not write. `catalogForm` gives the model a pull would rebuild if the
// catalog held what the local files say: it runs the local files through
// push's emitter and pull's reader. When pull writes the same text for that
// model as for the catalog's, the local files hold the catalog's content.

import {SemanticModel} from './ir';
import {modelsFromCatalogResources} from './kc_converter';
import {generateCatalogResources} from './knowledge_catalog';
import {loadSemanticModels} from './loader';
import {ProfileFiles} from './resolve_profiles';
import {withProfileFiles} from './validate';

/** The entry group the catalog form is built for. */
export interface CatalogScope {
  project: string;
  location: string;
  entryGroup: string;
}

/**
 * The model a pull would rebuild if the catalog held what the model file `doc`
 * and its profile files, which `profileDocs` gives, say. The model and profile
 * files load as push loads them, and their entries are built as push builds
 * them and read back as pull reads them. Returns `error` when the model file
 * does not load, or the catalog would hold no model for it.
 *
 * Reading an inherited field's SQL needs the SQL parser, so call
 * `loadSqlEngine()` first.
 */
export function catalogForm(
    doc: {name: string; text: string}, profileDocs: ProfileFiles,
    scope: CatalogScope): {model: SemanticModel}|{error: string} {
  const loaded = loadSemanticModels([doc], {bindingOptional: true});
  if (loaded.error) return {error: loaded.error};
  if (loaded.models.length !== 1) {
    return {error: `'${doc.name}' holds ${loaded.models.length} models`};
  }
  const pushed = withProfileFiles(loaded.models[0], profileDocs);
  if ('errors' in pushed) return {error: pushed.errors[0].error};
  const {entries} = generateCatalogResources(pushed.model, scope);
  const [model] = modelsFromCatalogResources(entries).models;
  return model ? {model} : {error: `'${doc.name}' gives no model`};
}
