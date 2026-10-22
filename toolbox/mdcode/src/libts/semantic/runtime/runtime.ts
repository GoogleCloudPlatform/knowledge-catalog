// Creating a semantic runtime: the model as authored, merged with one binding
// profile, paired with the store the deployment that uses that profile names.
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

import {AlloyDbClient} from '../../gcp/alloydb';
import * as context from '../../gcp/context';
import {CatalogClient} from '../../gcp/dataplex';
import {fileNameOf, SemanticModelLayout} from '../../layouts/semantic-model';
import {CatalogSnapshot} from '../../snapshot';
import {Sources} from '../../source';
import {SemanticModelSource} from '../../sources/semantic-model';
import {cloudSqlDialects} from '../cloudsql_dialect';
import {SemanticModel} from '../ir';
import {loadSemanticModels, SemanticModelError} from '../loader';
import {resolveInheritance, ResolveResult} from '../resolve_inheritance';
import {applyProfileExclusions, DeclaredProfile, declaredProfiles, DEFAULT_PROFILE, isLegacyWrapper, loadProfileFile, ProfileExclusion, profileErrorMessage, profileForDocument, reservedProfileNameError, unknownProfileMessage} from '../resolve_profiles';
import {loadSqlEngine} from '../sql_parser';

import {resolveStore, Store, withPrimaryInstance} from './store';


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
  /**
   * Set when the model's deployments name a target and still no store
   * results. The target of any deployment may be in no accepted form, the
   * profile's several targets may leave the store ambiguous, the model may
   * bind a table outside its Spanner or AlloyDB store, or finding how to
   * connect may fail, such as the lookup of an AlloyDB cluster's primary
   * instance. Also set when a GOOGLE block's data is not valid JSON, so its
   * targets cannot be read. `storeError` says why.
   */
  storeFailed?: boolean;
  /**
   * Set with `storeFailed` when the model's deployments give no store
   * whatever the model is used for. One such case is a target in
   * no accepted form in any deployment. Another is a GOOGLE block that is not
   * valid JSON. A third is several targets for the profile with no single
   * store. A table bound outside the store and a failed AlloyDB lookup are
   * not such cases.
   */
  deploymentsRejected?: boolean;
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
   * Binding profile to apply to each model. Defaults to the scope's
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
  /**
   * Set to refuse a scope that holds more than one model. The scope is
   * refused before any store is looked up. When this is a function, it takes
   * the number of models and returns the error.
   */
  oneModel?: boolean|((count: number) => string);
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

  // Reading a GOOGLE block profile checks its field bindings for SQL, which
  // needs the SQL parser.
  try {
    await loadSqlEngine();
  } catch (err: any) {
    return {error: `${err?.message ?? err}`};
  }

  // Push reads every model's profiles first, whichever profile it deploys:
  // its profile files, then the profiles a vanilla model carries in its
  // GOOGLE block. It refuses the scope when profileDocuments rejects a file,
  // such as a `<model>.profile.<name>.yaml` file whose `name:` does not match
  // its file name, or when a GOOGLE block profile does not load. It also
  // refuses it when a model declares a profile named `default` in any letter
  // case.
  const profilesByDoc = new Map<string, DeclaredProfile[]>();
  // Each model's profile files alone, which an error applying one names.
  const filesByDoc =
      new Map<string, Array<{name: string; text: string; path: string}>>();
  for (const doc of docs) {
    let files: Array<{name: string; text: string; path: string}>;
    let available: DeclaredProfile[];
    try {
      files = layout.profileDocuments(doc.name);
      available = declaredProfiles(doc, files);
    } catch (err: any) {
      return {error: err?.message ?? String(err)};
    }
    const reserved = reservedProfileNameError(doc.name, available);
    if (reserved) return {error: reserved};
    profilesByDoc.set(doc.name, available);
    filesByDoc.set(doc.name, files);
  }

  // A Cloud SQL table written as its resource name takes its dialect from its
  // Knowledge Catalog entry, looked up once for the scope before anything
  // loads. A table whose entry cannot be read stops the scope, as push does.
  const lookup = await cloudSqlDialects(
      [...docs.map(d => d.text),
       ...[...filesByDoc.values()].flat().map(f => f.text)],
      new CatalogClient(ctx));
  if (lookup.errors.length) return {error: lookup.errors.join('\n')};
  const load = {cloudSqlDialects: lookup.dialects};

  const merged: Array<{
    name: string; text: string; allowLegacyBareSource?: boolean;
    excluded?: ProfileExclusion[];
  }> = [];
  const excludedByDoc = new Map<string, ProfileExclusion[]>();
  // A profile file applies to its model file loaded on its own, with its
  // exclusions already marked.
  const appliedByDoc = new Map<string, SemanticModel>();
  // The warnings applying each profile file gave.
  const fileWarnings = new Map<string, string[]>();
  // The documents a legacy `semantic_model:` wrapper was merged into, each
  // with whether the merged model names its target with `deployment_target`.
  const wrapped = new Map<string, boolean>();
  const defaultProject = source.project ?? ctx.project;
  for (const doc of docs) {
    if (profile === DEFAULT_PROFILE) {
      merged.push({name: doc.name, text: doc.text});
      continue;
    }
    const available = profilesByDoc.get(doc.name) ?? [];
    const res = profileForDocument(doc, available, profile, load);
    if (res.kind === 'missing') {
      return {error: unknownProfileMessage(profile, doc.name, res.declared)};
    }
    if (res.kind === 'error') {
      const files = (filesByDoc.get(doc.name) ?? []).map(
          p => ({...p, fileName: fileNameOf(layout, doc.name, p.path)}));
      return {error: profileErrorMessage(doc.name, res, profile, files)};
    }
    if (res.kind === 'file') {
      fileWarnings.set(doc.name, res.warnings);
      appliedByDoc.set(doc.name, res.model);
      continue;
    }
    for (const w of res.warnings) warn(`Warning: [${doc.name}] ${w}`);
    merged.push({
      name: doc.name,
      text: res.text,
      // A legacy `semantic_model:` wrapper may still carry
      // `deployment_target:` and bare sources.
      allowLegacyBareSource: true,
      excluded: res.excluded,
    });
    excludedByDoc.set(doc.name, res.excluded);
    wrapped.set(doc.name, res.deploymentTarget);
  }

  const loaded = loadSemanticModels(
      merged, {defaultProject, bindingOptional: true, ...load});
  if (loaded.error) return {error: loaded.error};
  // In the order of the documents, as one load of them all gives. The load
  // prefixes each warning with its document's name.
  for (const doc of docs) {
    const own = fileWarnings.get(doc.name) ??
        loaded.warnings.filter(w => w.startsWith(`[${doc.name}] `));
    for (const w of own) warn(`Warning: ${w}`);
  }
  const loadedByDoc = new Map(loaded.models.map(m => [m.document, m.model]));
  const models = docs.flatMap(doc => {
    const model = appliedByDoc.get(doc.name) ?? loadedByDoc.get(doc.name);
    return model ? [{document: doc.name, model}] : [];
  });

  // A deployment that names a profile the model does not declare would be
  // used by no profile. Push refuses it too.
  for (const {document, model} of models) {
    const declared = (profilesByDoc.get(document) ?? []).map(p => p.name);
    const error = undeclaredProfileError(document, model, declared);
    if (error) return {error};
  }

  // Push then loads every profile file, whichever profile it deploys, and
  // refuses one that does not load. It merges a legacy `semantic_model:`
  // wrapper only when that wrapper's profile applies.
  for (const doc of docs) {
    for (const p of filesByDoc.get(doc.name) ?? []) {
      if (isLegacyWrapper(p.text)) continue;
      try {
        loadProfileFile(p.text, p.name, {skipActions: true});
      } catch (err) {
        if (!(err instanceof SemanticModelError)) throw err;
        const file = fileNameOf(layout, doc.name, p.path);
        return {error: `[${file}] ${err.message}`};
      }
    }
  }

  if (options.oneModel && models.length > 1) {
    return {
      error: typeof options.oneModel === 'function' ?
          options.oneModel(models.length) :
          `this scope holds ${models.length} models, which may name ` +
              `different databases, so there is no single store. Narrow ` +
              `the scope to one model.`,
    };
  }

  // Inheritance is resolved for the same reason both push legs resolve it: an
  // inherited field is a field, and every reader downstream reads
  // `entity.fields`. The runtime is the reader where skipping it is unsafe
  // rather than merely incomplete. It would not see a subtype's inherited
  // `name`, so resolving a reference by name would report a row missing that
  // is there; and it would not see an inherited key's TYPE, so the check that
  // refuses a generated UUID for an Integer key would read the key as a
  // String, pass, and let the store take the mismatch instead.
  const runtimes: SemanticRuntime[] = [];
  const alloyDb = new AlloyDbClient(ctx);
  for (const {document, model: loadedModel} of models) {
    // A profile's exclusions apply to the entity that names each one.
    const authored = applyProfileExclusions(
        loadedModel, excludedByDoc.get(document) ?? []);
    // An excluded metric is not available under the profile.
    const excludedMetrics = new Set(authored.excludedMetrics ?? []);
    if (excludedMetrics.size) {
      authored.metrics =
          (authored.metrics ?? []).filter(m => !excludedMetrics.has(m.name));
    }
    // The store is the one the profile's deployments name. Finding it reads
    // only the deployment targets and the tables the model binds, which
    // inheritance does not change.
    const chosen = resolveStore(authored, profile, {
      legacyWrapper: wrapped.has(document),
      deploymentTarget: wrapped.get(document),
    });
    // Resolving throws on an `extends` that names an entity the model does
    // not declare, on a cycle, on a field inherited from two unrelated
    // ancestors, and on two fields of one entity whose names differ only in
    // case. The loader lets each through, and push reports it as an
    // error. An AlloyDB database runs an inherited text as PostgreSQL, where
    // `#` starts no comment.
    let resolved: ResolveResult;
    try {
      resolved = resolveInheritance(
          authored,
          !('error' in chosen) && chosen.kind === 'alloydb' ? 'POSTGRES' :
                                                              undefined);
    } catch (err: any) {
      const message = `${err?.message ?? err}`;
      return {
        error: `[${document}] model '${authored.name}': ${message}${
            message.endsWith('.') ? '' : '.'}`,
      };
    }
    for (const w of resolved.warnings) warn(`Warning: ${w}`);
    // An AlloyDB database is reached through its cluster's primary instance.
    const runtime: SemanticRuntime = {
      model: resolved.model,
      document,
      profile,
      entryGroup: source.entryGroup,
    };
    if ('error' in chosen) {
      runtime.storeError = chosen.error;
      if (chosen.named) runtime.storeFailed = true;
      if (chosen.rejected) runtime.deploymentsRejected = true;
    } else {
      const store = await withPrimaryInstance(chosen, alloyDb);
      if ('error' in store) {
        runtime.storeError = store.error;
        runtime.storeFailed = true;
      } else {
        runtime.store = store;
      }
    }
    runtimes.push(runtime);
  }
  return runtimes;
}


/**
 * Why `model` cannot be used because a deployment names a binding profile
 * `declared` does not hold, or undefined when each names `default` or a
 * declared profile. `document` is the model's document, for the message.
 */
export function undeclaredProfileError(
    document: string, model: SemanticModel, declared: string[]): string|
    undefined {
  for (const d of model.deployments ?? []) {
    const profile = d.profile ?? DEFAULT_PROFILE;
    if (profile === DEFAULT_PROFILE || declared.includes(profile)) continue;
    return `[${document}] model '${model.name}': deployment '${
               d.name}' names unknown binding profile '${profile}'; ` +
        (declared.length ? `defined profiles: ${declared.join(', ')}.` :
                           `no profiles are defined for this model.`);
  }
  return undefined;
}
