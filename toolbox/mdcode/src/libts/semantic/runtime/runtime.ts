// Creating a semantic runtime: the model as authored, merged with one binding
// profile, paired with the store that profile's deployment target names.
//
// A semantic model on disk is a declaration. A runtime is that declaration
// made operational -- bindings applied, inheritance resolved, a store to run
// against. Every caller that does anything with a model wants the pair, so the
// pair is what this hands back, rather than a model the caller then has to
// find a store for.
//
// Both halves were the CLI's private business until an agent needed them. An
// agent skill derives its tools from the same bound model `kcmd skills-generate`
// reads, against the same store, so it has to reach them the same way -- and a
// second loader that merges profiles slightly differently is a demo that passes
// while the product fails. The CLI calls this too, so there is one answer to
// "what does this scope say" rather than one per caller.

import * as context from '../../gcp/context';
import {SemanticModelLayout} from '../../layouts/semantic-model';
import {CatalogSnapshot} from '../../snapshot';
import {Sources} from '../../source';
import {SemanticModelSource} from '../../sources/semantic-model';
import {SemanticModel} from '../ir';
import {loadSemanticModels} from '../loader';
import {resolveInheritance} from '../resolve_inheritance';
import {DEFAULT_PROFILE, mergeProfileOntoDoc} from '../resolve_profiles';

import {resolveStore, Store} from './store';


/**
 * A semantic model made operational: the model as authored under one binding
 * profile, and the store it runs against.
 */
export interface SemanticRuntime {
  model: SemanticModel;
  /**
   * The model file this was authored in -- the `.yaml` basename, not a path.
   * Carried so a message about this model can point at the author's file.
   */
  document: string;
  /** Where the model's data lives. Absent when this profile binds no store. */
  store?: Store;
  /** Why there is no store. Set exactly when `store` is absent. */
  storeError?: string;
  /** Which binding profile produced this. Provenance, for messages. */
  profile: string;
  /** The entry group the model is scoped to. */
  entryGroup: string;
}


/**
 * Why this runtime cannot execute SQL DML statements, or null when it can.
 *
 * Having a store is the whole requirement. Every backend a profile can deploy
 * to -- Spanner, AlloyDB, BigQuery -- executes DML, so the kind of store is not
 * a reason to refuse an action.
 */
export function runtimeStoreError(runtime: SemanticRuntime): string|null {
  if (!runtime.store) {
    return runtime.storeError ??
        `Model '${runtime.model.name}' has no store under profile '${
            runtime.profile}'.`;
  }
  return null;
}


/** How to create the runtimes. Every field has the answer `kcmd` would give. */
export interface CreateRuntimeOptions {
  /** Directory holding `catalog.yaml`. Defaults to the current directory. */
  path?: string;
  /**
   * Binding profile to merge onto each model. Defaults to the scope's
   * `default_profile`, and failing that to the model's inline bindings.
   */
  profile?: string;
  ctx?: context.ApiContext;
  /**
   * Where a non-fatal problem goes -- an unbound field, a profile that names
   * something the model does not. Defaults to `console.warn`. A caller with a
   * transcript to keep tidy can collect them instead.
   */
  onWarning?: (text: string) => void;
}


/**
 * One runtime per model document in the scope, in discovery order.
 *
 * A lighter path than push's: nothing is transpiled, pruned or validated for
 * deployment, because running an action needs the model as authored rather
 * than the subset a deployed graph can answer. Bindings stay optional, so a
 * purely logical model yields a runtime with no store -- readable and
 * inspectable, not runnable -- instead of an error that stops the scope.
 */
export async function createSemanticRuntimes(options: CreateRuntimeOptions = {}):
    Promise<SemanticRuntime[]|{error: string}> {
  const base = options.path ?? '.';
  const ctx = options.ctx ?? context.ApiContext.default();
  const warn = options.onWarning ?? ((text: string) => console.warn(text));

  let snapshot: CatalogSnapshot;
  try {
    snapshot = await CatalogSnapshot.fromPath(base, ctx);
  } catch (err: any) {
    return {error: `${err?.message ?? err}`};
  }
  if (snapshot.manifest.source.type !== Sources.SEMANTIC_MODEL) {
    return {error: `'${base}' is not a semantic-model scope.`};
  }
  const layout = snapshot.layout as SemanticModelLayout;
  const source = snapshot.manifest.source as SemanticModelSource;
  const profile =
      options.profile ?? snapshot.manifest.defaultProfile ?? DEFAULT_PROFILE;

  const docs = layout.modelDocuments();
  if (!docs.length) return {error: 'no semantic model documents found.'};

  const merged: Array<{name: string; text: string}> = [];
  for (const doc of docs) {
    if (profile === DEFAULT_PROFILE) {
      merged.push({name: doc.name, text: doc.text});
      continue;
    }
    const available = layout.profileDocuments(doc.name);
    const chosen = available.find(p => p.name === profile);
    if (!chosen) {
      const names = available.map(p => p.name);
      return {
        error: `unknown binding profile '${profile}' for model '${doc.name}'; ` +
            (names.length ? `defined profiles: ${names.join(', ')}.` :
                            `no profiles are defined for this model.`),
      };
    }
    const res = mergeProfileOntoDoc(doc.text, chosen.text, profile);
    if ('error' in res) return {error: `[${doc.name}] ${res.error}`};
    for (const w of res.warnings) warn(`Warning: [${doc.name}] ${w}`);
    merged.push({name: doc.name, text: res.text});
  }

  const loaded = loadSemanticModels(
      merged,
      {defaultProject: source.project ?? ctx.project, bindingOptional: true});
  if (loaded.error) return {error: loaded.error};
  for (const w of loaded.warnings) warn(`Warning: ${w}`);

  // Inheritance is resolved for the same reason both push legs resolve it: an
  // inherited field is a field, and every reader downstream reads
  // `entity.fields`. The runtime is the reader where skipping it is unsafe
  // rather than merely incomplete. It would not see a subtype's inherited
  // `name`, so resolving a reference by name would report a row missing that
  // is there; and it would not see an inherited key's TYPE, so the check that
  // refuses a generated UUID for an Integer key would read the key as a
  // String, pass, and let the store take the mismatch instead.
  const runtimes: SemanticRuntime[] = [];
  for (const {document, model: authored} of loaded.models) {
    const resolved = resolveInheritance(authored);
    for (const w of resolved.warnings) warn(`Warning: ${w}`);
    const store = resolveStore(resolved.model);
    runtimes.push({
      model: resolved.model,
      document,
      ...('error' in store ? {storeError: store.error} : {store}),
      profile,
      entryGroup: source.entryGroup,
    });
  }
  return runtimes;
}
