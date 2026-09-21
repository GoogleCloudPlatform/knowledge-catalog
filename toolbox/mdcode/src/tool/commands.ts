// CLI command handlers
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

import * as kcmd from '../libts';
import {BigQueryClient} from '../libts/gcp/bigquery';
import * as context from '../libts/gcp/context';
import * as dataplex from '../libts/gcp/dataplex';
import {SpannerClient} from '../libts/gcp/spanner';
import {SemanticModelLayout} from '../libts/layouts/semantic-model';
import {convertOwlToOsi} from '../libts/semantic/converters/owl/convert';
import * as deploy from '../libts/semantic/deploy_bigquery';
import * as kc from '../libts/semantic/deploy_knowledge_catalog';
import * as deploySpannerLeg from '../libts/semantic/deploy_spanner';
import {googleDeploymentTargets} from '../libts/semantic/deployment_target';
import {provisionCustomTypes} from '../libts/semantic/kc_custom_types';
import {LoadedModel, loadSemanticModels} from '../libts/semantic/loader';
import {serializeModel} from '../libts/semantic/osi_converter';
import {pullKnowledgeCatalog} from '../libts/semantic/pull_kc';
import {AvailabilityReport, DEFAULT_PROFILE, mergeProfileOntoDoc, pruneUnavailable,} from '../libts/semantic/resolve_profiles';
import {createSemanticRuntimes} from '../libts/semantic/runtime/runtime';
import {storeLine} from '../libts/semantic/runtime/store';
import {generateSkill, SkillPackage} from '../libts/semantic/skills';
import {transpileModels} from '../libts/semantic/transpile';
import {validateBigQueryActionStatements, validateBigQueryDataSources, validatePushRequirements, validateSpannerActionStatements} from '../libts/semantic/validate';
import {Sources} from '../libts/source';
import {SemanticModelSource} from '../libts/sources/semantic-model';


export interface InitOptions {
  entryGroup?: string;
  bigqueryDataset?: string|string[];
  kb?: string;
  semanticModel?: string;
  pull?: boolean;
}


// What a model would deploy through the Knowledge Catalog leg alone. Named
// rather than written inline at its one use site: an object literal inside a
// generic argument is what editor formatters mangle first, and this one has
// been mangled into `new Map < string, {...} > ()` more than once.
interface CatalogOnlyCounts {
  actions: number;
  constraints: number;
}

export interface PushOptions {
  // Generic push flag for non-semantic-model (CatalogSync) scopes;
  // forwarded to CatalogSync.push. The semantic-model legs ignore it.
  // The catch-all "force the push" toggle -- distinct from
  // `forceRemove` below, which specifically authorizes deleting models
  // this push no longer includes.
  force?: boolean;
  // Run every validation check and report pass/fail, but write nothing
  // to any destination (a dry run). Applies to both push paths.
  validateOnly?: boolean;
  // Delete Knowledge Catalog models already in the entry group that this push
  // does not include (a removed or renamed model). Without it, an unrecognized
  // model in the group fails the push. Semantic-model KC push only.
  // Unlike `force` above, this authorizes a destructive delete rather
  // than overriding a conflict.
  forceRemove?: boolean;
  // Whether to push the Knowledge Catalog metadata leg. On by default;
  // `--no-kc` sets it false to deploy only the graph. The catalog toggle is
  // symmetric with the profile axis below: `--no-profile` gives a catalog-only
  // push, `--no-kc` a graph-only push, and both together are an error (nothing
  // to deploy). Ignored for non-semantic-model scopes.
  kc?: boolean;
  // Print each pushed destination's generated artifact in that destination's
  // native format (BigQuery/Spanner Graph -> SQL DDL, Knowledge Catalog -> the
  // entry plan), each block labeled by destination. Works with or without
  // --validate-only. Semantic-model push only.
  print?: boolean;
  // Emit the SQL-expression fields not yet supported by the published Knowledge
  // Catalog system-type templates (per-field schema semantics and the metric
  // expression). Off by default so a push matches the live types; enable once
  // the templates gain these fields. Semantic-model KC push only.
  emitExpressions?: boolean;
  // Rewrite vendor-dialect expressions (e.g. Snowflake/Databricks) to GoogleSQL
  // before deploying, filling any target `expression` the loader left unset
  // because only an `importedExpression` was supplied. Off by default (a model
  // authored in GoogleSQL/ANSI needs nothing). Runs per prepared binding, so
  // both the graph and Knowledge Catalog legs see the filled expressions.
  // Semantic-model push only. See ../libts/semantic/transpile.
  transpile?: boolean;
  // How many binding profiles the graph leg deploys for -- the graph axis. cac
  // folds three flags onto this one key: `--no-profile` sets it false (deploy
  // no graph, publish only to Knowledge Catalog); `--profile <name>` sets the
  // string (deploy that one, reading `<model>.profiles/<name>.yaml`); omitted
  // leaves it undefined (the model's default binding: `default_profile` from
  // catalog.yaml, else the inline bindings -- the implicit 'default' profile).
  // A profile's deployment target selects the graph backend, so the profile --
  // not a flag -- decides where the graph deploys. Mutually exclusive with
  // allProfiles. Semantic-model push only.
  profile?: string|boolean;
  // Deploy the graph once per defined binding profile (plus the inline
  // 'default' when the document itself declares a target), instead of a single
  // profile: the "all" end of the profile axis. `--all-profiles`. The Knowledge
  // Catalog leg still records one canonical view (the default binding).
  // Mutually exclusive with profile and with --no-profile. Semantic-model push
  // only.
  allProfiles?: boolean;
}


// Guard the push flag combination before any work. A push has two axes: how
// many binding profiles the graph deploys for (--no-profile = none, default =
// the default one, --profile = one, --all-profiles = all) and whether the
// Knowledge Catalog leg runs (--no-kc). The graph backend is never a
// command-line choice (each model's deployment target names it). --no-profile
// deploys no graph, so it cannot also ask for a profile, and --profile /
// --all-profiles are mutually exclusive. Returns an error to report, or null
// when the combination is coherent.
export function checkPushSelection(sel: {
  graphEnabled: boolean; kcEnabled: boolean; allProfiles: boolean;
  namedProfile: boolean;
}): {error: string}|null {
  if (!sel.graphEnabled && !sel.kcEnabled) {
    return {
      error: '--no-profile and --no-kc together leave nothing to deploy.'
    };
  }
  if (!sel.graphEnabled && (sel.allProfiles || sel.namedProfile)) {
    return {
      error: '--no-profile deploys no graph, so it cannot be combined with ' +
          '--profile or --all-profiles (there is no graph to bind).',
    };
  }
  if (sel.allProfiles && sel.namedProfile) {
    return {
      error: '--profile names one binding profile and --all-profiles deploys ' +
          'every one; use one or the other.',
    };
  }
  return null;
}


// Whether a model document (already profile-merged) declares a graph deployment
// target, without a full strict load. True when the model names one via the
// `deployment_target:` sugar or a GOOGLE custom_extension `deploymentTargets`.
// Drives the push mode: a push whose models all declare no target governs the
// logical model only -- it deploys no graph, so bindings and a target are not
// required and pruning is skipped (Knowledge Catalog publishes the whole
// model). On any ambiguity (unparseable YAML, malformed GOOGLE data) it returns
// true, so the strict load reports the problem rather than silently taking the
// logical path.
export function declaresGraphTarget(text: string): boolean {
  let doc: any;
  try {
    doc = yaml.parse(text);
  } catch {
    return true;  // let the strict loader report the parse error
  }
  const models = Array.isArray(doc?.semantic_model) ? doc.semantic_model : [];
  for (const m of models) {
    if (typeof m?.deployment_target === 'string' &&
        m.deployment_target.trim()) {
      return true;
    }
    const exts = Array.isArray(m?.custom_extensions) ? m.custom_extensions : [];
    for (const ext of exts) {
      if (ext?.vendor_name !== 'GOOGLE' || typeof ext?.data !== 'string') {
        continue;
      }
      let data: any;
      try {
        data = JSON.parse(ext.data);
      } catch {
        return true;  // malformed GOOGLE data: strict load will name it
      }
      if (Array.isArray(data?.deploymentTargets) &&
          data.deploymentTargets.length) {
        return true;
      }
    }
  }
  return false;
}


// True when a loaded model declares a deployment target of the given graph type
// ('bigquery' or 'spanner'). Used to route each model to the leg that can
// deploy it. Safe by the time it runs: validatePushRequirements has already
// rejected a malformed GOOGLE extension, so googleDeploymentTargets does not
// throw; the try/catch is a defensive fallback that routes an unparseable model
// nowhere.
function hasTargetType(
    loaded: LoadedModel, type: 'bigquery'|'spanner'): boolean {
  try {
    const t = googleDeploymentTargets(loaded.model);
    return type === 'bigquery' ? t.bigQuery.length > 0 : t.spanner.length > 0;
  } catch {
    return false;
  }
}


export async function init(options: InitOptions): Promise<number> {
  const ctx = context.ApiContext.default();

  let manifest: kcmd.CatalogManifest;
  if (options.entryGroup) {
    manifest =
        await kcmd.CatalogManifest.initWithEntryGroup(options.entryGroup, ctx);
  } else if (options.kb) {
    manifest =
        await kcmd.CatalogManifest.initWithKnowledgeBase(options.kb, ctx);
  } else if (options.bigqueryDataset) {
    let datasets = '';
    if (Array.isArray(options.bigqueryDataset)) {
      datasets = options.bigqueryDataset.join(',');
    } else {
      datasets = options.bigqueryDataset!;
    }
    manifest = await kcmd.CatalogManifest.initWithBigQuery(datasets, ctx);
  } else if (options.semanticModel) {
    manifest = await kcmd.CatalogManifest.initWithSemanticModel(
        options.semanticModel, ctx);
    const source = manifest.source as SemanticModelSource;
    // Provision the destination entry group now, at init, so push writes only
    // entries -- matching how the standard layout operates (its push creates
    // entries, never the entry group). Idempotent: an already-existing group
    // (409) is success.
    const catalog = new dataplex.CatalogClient(ctx);
    const res = await catalog.createEntryGroup(
        source.project, source.location, source.entryGroup);
    if (res.status !== 200 && res.status !== 409) {
      console.error(
          `Error: failed to create entry group '${source.name}': ` +
          `${res.message || res.status}`);
      return 1;
    }
    // A few constructs have no built-in system type, so the entry and aspect
    // types they need are provisioned here too. Everything else the push
    // writes references types that already exist under `dataplex-types`.
    // kc_custom_types.ts is the list of what is custom.
    const provisioned = await provisionCustomTypes(catalog, source);
    for (const w of provisioned.warnings ?? []) console.warn(`Warning: ${w}`);
    if (provisioned.error) {
      console.error(`Error: ${provisioned.error}`);
      return 1;
    }
    if (provisioned.denied) console.warn(`Warning: ${provisioned.denied}`);
    fs.mkdirSync(
        path.join('catalog', 'EntryGroups', source.entryGroup),
        {recursive: true});
  } else {
    console.error(
        'Error: Must provide --entry-group, --bigquery-dataset, --kb, or --semantic-model');
    return 1;
  }

  manifest.save('catalog.yaml');
  console.log(fs.readFileSync('catalog.yaml', 'utf8'));

  if (options.pull) {
    return await pull();
  }

  return 0;
}


export interface PullOptions {
  // Reconstruct + report only; never writes a file. Mirrors push
  // --validate-only.
  dryRun?: boolean;
  // Authorize replacing a differently-named local model with the catalog's.
  // Without it, a pull whose catalog model id differs from the local model on
  // disk fails rather than leave two models in the entry group. Mirrors the
  // push flag of the same name.
  forceRemove?: boolean;
}


export async function pull(options: PullOptions = {}): Promise<number> {
  const ctx = context.ApiContext.default();
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);

  if (snapshot.manifest.source.type === Sources.SEMANTIC_MODEL) {
    return await pullSemanticModel(ctx, snapshot, options);
  }

  const catalog = new dataplex.CatalogClient(ctx);
  const sync = new kcmd.CatalogSync(catalog, snapshot);

  console.log('Pulling catalog entries...');
  const result = await sync.pull();

  if (result.success) {
    console.log('Successfully updated local snapshot.');
    return 0;
  } else {
    console.error('Error pulling catalog entries:', result.details);
    return 1;
  }
}


export async function push(options: PushOptions): Promise<number> {
  const ctx = context.ApiContext.default();
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);

  if (snapshot.manifest.source.type === Sources.SEMANTIC_MODEL) {
    // The semantic-model source always resolves to the SemanticModel layout
    // (see createLayout), so this cast is safe.
    const layout = snapshot.layout as SemanticModelLayout;
    const source = snapshot.manifest.source as SemanticModelSource;

    // The push has two axes. The profile axis says how many binding profiles
    // the graph deploys for: --no-profile (options.profile === false) deploys
    // none -- a catalog-only push; --profile <name> deploys that one;
    // --all-profiles every one; and the default (undefined) the model's default
    // binding
    // (`default_profile` from catalog.yaml, else the inline bindings -- the
    // implicit 'default' profile). A profile's deployment target names the
    // backend; the command line never does. The catalog axis is --no-kc.
    const kcEnabled = options.kc !== false;
    const allProfiles = options.allProfiles === true;
    const namedProfile =
        typeof options.profile === 'string' ? options.profile : undefined;
    const graphEnabled = options.profile !== false;
    const selectionError = checkPushSelection({
      graphEnabled,
      kcEnabled,
      allProfiles,
      namedProfile: namedProfile !== undefined,
    });
    if (selectionError) {
      console.error(`Error: ${selectionError.error}`);
      return 1;
    }

    const layoutDocs = layout.modelDocuments();
    const defaultProject = source.project ?? ctx.project;

    // Reserve the profile name 'default': it is the sentinel for the inline
    // bindings (never merged onto the document), so a
    // `<model>.profiles/default.yaml` would be silently unreachable. Reject it
    // rather than let it sit there doing nothing. Only when the graph axis is
    // on: a graph push may resolve profiles, but a catalog-only --no-profile
    // push reads no profile files, so it does not police their names.
    if (graphEnabled) {
      for (const doc of layoutDocs) {
        const clash = layout.profileDocuments(doc.name).some(
            p => p.name === DEFAULT_PROFILE);
        if (clash) {
          console.error(
              `Error: [${doc.name}] a binding profile may not be named '${
                  DEFAULT_PROFILE}' -- that name refers to the model's inline ` +
              `bindings. Rename the profile file.`);
          return 1;
        }
      }
    }

    // Merge one binding profile onto every model document, returning the merged
    // docs (or null after reporting an error). The implicit 'default' profile
    // is the inline document as authored, so nothing is merged. With
    // `skipMissing` (the --all-profiles fan-out) a model that does not define
    // the profile is dropped from the result rather than erroring -- the
    // profile name came from another model in the group and is not this one's
    // concern; without it (an explicit --profile) a missing profile is an
    // error.
    const mergeForProfile = (profileName: string, {skipMissing = false} = {}):
        Array<{name: string; text: string}>|null => {
          if (profileName === DEFAULT_PROFILE) return layoutDocs;
          const merged: Array<{name: string; text: string}> = [];
          for (const doc of layoutDocs) {
            const available = layout.profileDocuments(doc.name);
            const chosen = available.find(p => p.name === profileName);
            if (!chosen) {
              if (skipMissing) continue;
              const names = available.map(p => p.name);
              console.error(
                  `Error: unknown binding profile '${profileName}' for model '${
                      doc.name}'; ` +
                  (names.length ? `defined profiles: ${names.join(', ')}.` :
                                  `no profiles are defined for this model.`));
              return null;
            }
            const res = mergeProfileOntoDoc(doc.text, chosen.text, profileName);
            if ('error' in res) {
              console.error(`Error: [${doc.name}] ${res.error}`);
              return null;
            }
            for (const w of res.warnings) {
              console.warn(`Warning: [${doc.name}] ${w}`);
            }
            merged.push({name: doc.name, text: res.text});
          }
          return merged;
        };

    // Load + validate a profile's merged documents into deployable models,
    // sharing one IR across both legs. `prune` drops each unbound field (and
    // whatever depends on it) so a deployed graph presents only what its
    // binding answers; a catalog-only push leaves it off to publish the whole
    // logical model. Returns the models and the target partition the graph legs
    // need, or null after reporting an error.
    const prepareModels = async(
        docs: Array<{name: string; text: string}>, profileName: string,
        {prune}: {prune: boolean}): Promise<{
      models: LoadedModel[]; bqModels: LoadedModel[];
      spannerModels: LoadedModel[]
    }|null> => {
      const loaded =
          loadSemanticModels(docs, {defaultProject, bindingOptional: !prune});
      if (loaded.error) {
        console.error('Error:', loaded.error);
        return null;
      }
      for (const w of loaded.warnings) {
        if (options.transpile && w.includes('needs transpilation')) continue;
        console.warn(`Warning: ${w}`);
      }
      let models = loaded.models;
      if (options.transpile) {
        const transpiled = await transpileModels(models);
        models = transpiled.models;
        for (const w of transpiled.warnings) console.warn(`Warning: ${w}`);
      }
      if (prune) {
        const availability: AvailabilityReport[] = [];
        models = models.map(({document, model}) => {
          const {model: pruned, report} = pruneUnavailable(model, profileName);
          availability.push(report);
          return {document, model: pruned};
        });
        for (const r of availability) {
          const dropped = r.droppedEntities.length + r.droppedMetrics.length +
              r.droppedRelationships.length + r.droppedActions.length;
          if (r.unboundFields.length || dropped) {
            console.warn(
                `Note: profile '${r.profile}' leaves ${
                    r.unboundFields.length} field(s) unbound` +
                (dropped ?
                     `; ${r.droppedEntities.length} entity(ies), ${
                         r.droppedMetrics.length} metric(s), ${
                         r.droppedRelationships.length} relationship(s) ` +
                         `and ${r.droppedActions.length} action(s) ` +
                         `unavailable` :
                     '') +
                '.');
          }
        }
      }
      const validationErrors = validatePushRequirements(
          models, {targetOptional: !prune, fieldsPruned: prune});
      if (validationErrors.length) {
        for (const e of validationErrors) console.error(`Error: ${e}`);
        return null;
      }
      const bqModels = models.filter(m => hasTargetType(m, 'bigquery'));
      const spannerModels = models.filter(m => hasTargetType(m, 'spanner'));
      return {models, bqModels, spannerModels};
    };

    // Merge + prepare a profile once and reuse it. The graph leg and the
    // Knowledge Catalog leg both consume the default binding, so without this a
    // bound `kcmd push` would load, transpile, prune, and validate the same
    // profile twice -- and print every loader/transpile warning twice. Keyed by
    // the inputs that change the result: profile name, prune, and (since
    // --all-profiles may prepare a filtered subset of the documents) the set of
    // document names.
    type Prepared = {
      models: LoadedModel[]; bqModels: LoadedModel[];
      spannerModels: LoadedModel[];
    };
    const mergeCache =
        new Map<string, Array<{name: string; text: string}>|null>();
    const mergeOnce = (profileName: string, skipMissing: boolean) => {
      const key = `${profileName}|${skipMissing}`;
      if (mergeCache.has(key)) return mergeCache.get(key)!;
      const docs = mergeForProfile(profileName, {skipMissing});
      mergeCache.set(key, docs);
      return docs;
    };
    const prepareCache = new Map<string, Prepared|null>();
    const prepareOnce = async(
        docs: Array<{name: string; text: string}>, profileName: string,
        prune: boolean): Promise<Prepared|null> => {
      const key =
          `${profileName}|${prune}|${docs.map(d => d.name).sort().join(',')}`;
      if (prepareCache.has(key)) return prepareCache.get(key)!;
      const prepared = await prepareModels(docs, profileName, {prune});
      prepareCache.set(key, prepared);
      return prepared;
    };

    // The graph binding profiles to deploy, in a deterministic order (named
    // profiles first, sorted, then the inline 'default'). --all-profiles fans
    // out over every defined profile, plus the inline 'default' when the
    // document itself declares a target; a single push deploys the named or the
    // default profile. Empty when --no-profile.
    const graphProfileNames: string[] = [];
    if (graphEnabled) {
      if (allProfiles) {
        const names = new Set<string>();
        for (const doc of layoutDocs) {
          for (const p of layout.profileDocuments(doc.name)) names.add(p.name);
          if (declaresGraphTarget(doc.text)) names.add(DEFAULT_PROFILE);
        }
        for (const n of [...names].filter(n => n !== DEFAULT_PROFILE).sort()) {
          graphProfileNames.push(n);
        }
        if (names.has(DEFAULT_PROFILE)) graphProfileNames.push(DEFAULT_PROFILE);
        if (!graphProfileNames.length) {
          console.warn(
              'Warning: --all-profiles found no binding profiles and no inline ' +
              'deployment target; no graph will be deployed.');
        }
      } else {
        graphProfileNames.push(
            namedProfile ?? snapshot.manifest.defaultProfile ??
            DEFAULT_PROFILE);
      }
    }

    // Deploy each selected profile's graph (BigQuery first within a profile, so
    // a fail-fast push stops before later legs). Only the documents that, after
    // the merge, declare a deployment target contribute a graph; the rest are
    // left to the Knowledge Catalog leg (a profile that binds no target at all
    // is skipped). The live BigQuery pre-flight runs before each BigQuery
    // deploy so a push fails fast when a source table is unreachable; it also
    // runs under
    // --validate-only. A deployment target may be claimed by only one profile
    // in a run: two profiles pointing at the same graph would have the second
    // CREATE OR REPLACE silently overwrite the first, so that is an error
    // rather than last-write-wins.
    const multiProfile = graphProfileNames.length > 1;
    const claimedTargets = new Map<string, string>();  // target URI -> profile
    const deployedProfiles: string[] = [];
    const skippedProfiles: string[] = [];
    let deployedGraphs = 0;
    // Model name -> action count, and the documents already loaded below, so
    // the --no-kc actions warning can reuse this pass instead of repeating it.
    // Per model, what deploys through the Knowledge Catalog leg ALONE:
    // actions and constraints both have a catalog home and no graph one, so a
    // push that omits that leg has to account for either.
    const catalogOnly = new Map<string, CatalogOnlyCounts>();
    const noteCatalogOnly = (loaded: LoadedModel[]) => {
      for (const {model} of loaded) {
        const actions = model.actions?.length ?? 0;
        const constraints = model.constraints?.length ?? 0;
        if (actions || constraints)
          catalogOnly.set(model.name, {actions, constraints});
      }
    };
    const loadedDocs = new Set<string>();
    for (const profileName of graphProfileNames) {
      // --all-profiles fans out over every model's profiles, so a model that
      // does not define this one is dropped (skipMissing) rather than failing
      // the run; a single --profile / default push keeps every model.
      const merged = mergeOnce(profileName, allProfiles);
      if (!merged) return 1;
      const docs = merged.filter(d => declaresGraphTarget(d.text));
      if (!docs.length) {
        skippedProfiles.push(profileName);
        continue;
      }
      const prepared = await prepareOnce(docs, profileName, true);
      if (!prepared) return 1;
      for (const d of docs) loadedDocs.add(d.name);
      noteCatalogOnly(prepared.models);
      // Fail before any deploy if this profile's targets collide with a graph
      // an earlier profile already claimed this run.
      for (const m of prepared.models) {
        for (const uri of deploy.deploymentTargetUris(m.model)) {
          const owner = claimedTargets.get(uri);
          if (owner !== undefined) {
            console.error(
                `Error: binding profiles '${owner}' and '${
                    profileName}' both ` +
                `deploy to the same graph '${
                    uri}'; give each profile its own ` +
                `deployment target (the second would overwrite the first).`);
            return 1;
          }
          claimedTargets.set(uri, profileName);
        }
      }
      if (multiProfile) console.log(`\n-- Binding profile '${profileName}' --`);
      if (prepared.bqModels.length) {
        const bq = new BigQueryClient(ctx);
        const accessErrors = await validateBigQueryDataSources(
            prepared.bqModels, bq, defaultProject);
        if (accessErrors.length) {
          for (const e of accessErrors) console.error(`Error: ${e}`);
          return 1;
        }
        // Two pre-flights, in the order a failure is cheapest to read: the one
        // above confirms each entity's source table is reachable, this one
        // dry-runs each `sql` executor's DML. A missing source table would
        // make every statement over it fail too, so reporting it first says
        // "the table is gone" rather than listing each statement that noticed.
        const dmlErrors = await validateBigQueryActionStatements(
            prepared.bqModels, bq, defaultProject);
        if (dmlErrors.length) {
          for (const e of dmlErrors) console.error(`Error: ${e}`);
          return 1;
        }
        const code = await pushBigQuery(prepared.bqModels, ctx, options);
        if (code !== 0) return code;
        deployedGraphs += prepared.bqModels.length;
      }
      if (prepared.spannerModels.length) {
        // Sibling of the BigQuery pre-flight above, over a different surface:
        // that one confirms each entity's source table is reachable, this one
        // PLANs each `sql` executor's DML against the database this profile
        // binds. Both run before the deploy and both run under
        // --validate-only, because the point is to fail while nothing has been
        // published yet.
        const dmlErrors = await validateSpannerActionStatements(
            prepared.spannerModels, new SpannerClient(ctx));
        if (dmlErrors.length) {
          for (const e of dmlErrors) console.error(`Error: ${e}`);
          return 1;
        }
        const code = await pushSpanner(prepared.spannerModels, ctx, options);
        if (code !== 0) return code;
        deployedGraphs += prepared.spannerModels.length;
      }
      deployedProfiles.push(profileName);
    }
    // Under --all-profiles the per-leg "Deployed N" lines alone don't show the
    // whole fan-out, so summarize which profiles deployed and which were
    // skipped for declaring no deployment target.
    if (allProfiles && (deployedProfiles.length || skippedProfiles.length)) {
      console.log(
          `Deployed ${deployedGraphs} graph(s) across ${
              deployedProfiles.length} binding profile(s)` +
          (deployedProfiles.length ? ` (${deployedProfiles.join(', ')})` : '') +
          (skippedProfiles.length ?
               `; skipped ${
                   skippedProfiles.length} with no deployment target (${
                   skippedProfiles.join(', ')})` :
               '') +
          '.');
    }

    // Neither a BigQuery nor a Spanner property graph has a construct for an
    // action or a constraint, so Knowledge Catalog is their only destination. A
    // push that omits the KC leg (--no-kc) would validate them and then deploy
    // them nowhere. Warn instead of dropping them silently.
    if (!kcEnabled) {
      // The loop above already loaded every document that contributes a graph.
      // Only the rest need loading, which is usually none, and a model that
      // does not define this profile is skipped rather than failing a warning.
      const kcProfileName =
          namedProfile ?? snapshot.manifest.defaultProfile ?? DEFAULT_PROFILE;
      const rest = (mergeOnce(kcProfileName, true) ??
                    []).filter(d => !loadedDocs.has(d.name));
      if (rest.length) {
        const prepared = await prepareOnce(rest, kcProfileName, false);
        // prepareModels has already printed why it failed. Ignoring that here
        // would report a successful push over its own error output, and the
        // same document fails the default push through the Knowledge Catalog
        // leg, so --no-kc fails on it too.
        if (!prepared) return 1;
        noteCatalogOnly(prepared.models);
      }
      for (const [name, n] of catalogOnly) {
        console.warn(`Warning: ${catalogOnlyWarning(name, n)}`);
      }
    }

    // Knowledge Catalog records one canonical view of the logical model: the
    // single --profile selection, else the default binding. Alongside a graph
    // deploy the entries reflect that binding (pruned to what it answers); a
    // catalog-only --no-profile push publishes the whole logical model
    // unpruned.
    if (kcEnabled) {
      const kcProfileName =
          namedProfile ?? snapshot.manifest.defaultProfile ?? DEFAULT_PROFILE;
      const docs = mergeOnce(kcProfileName, false);
      if (!docs) return 1;
      const prune = graphEnabled && docs.some(d => declaresGraphTarget(d.text));
      const prepared = await prepareOnce(docs, kcProfileName, prune);
      if (!prepared) return 1;
      const code =
          await pushKnowledgeCatalog(prepared.models, ctx, options, source);
      if (code !== 0) return code;
    } else if (deployedGraphs === 0) {
      // Graph-only push (--no-kc) whose selected profile(s) declare no target:
      // there is nothing to deploy and nowhere else to record the model.
      console.error(
          'Error: no selected binding profile declares a deployment target, ' +
          'so there is no graph to deploy; give the model a deployment target, ' +
          'or drop --no-kc to publish it to Knowledge Catalog.');
      return 1;
    }
    return 0;
  }

  // These flags only take effect on a semantic-model push; on a regular
  // catalog snapshot they are inert. Warn rather than silently ignore them, so
  // a user who expected (say) --transpile to run isn't misled by a clean exit.
  const semanticOnlyFlags: Array<[boolean, string]> = [
    [typeof options.profile === 'string', '--profile'],
    [!!options.allProfiles, '--all-profiles'],
    [!!options.transpile, '--transpile'],
    [options.profile === false, '--no-profile'],
    [options.kc === false, '--no-kc'],
    [!!options.print, '--print'],
    [!!options.emitExpressions, '--emit-expressions'],
    [!!options.forceRemove, '--force-remove'],
  ];
  for (const [set, flag] of semanticOnlyFlags) {
    if (set) {
      console.warn(`Warning: ${
          flag} only applies to a semantic-model push; ignoring it.`);
    }
  }

  const catalog = new dataplex.CatalogClient(ctx);
  const sync = new kcmd.CatalogSync(catalog, snapshot);

  console.log(
      options.validateOnly ? 'Validating catalog entries...' :
                             'Pushing catalog entries...');
  const result = await sync.push(options);

  if (result.success) {
    console.log(
        options.validateOnly ? 'Validation complete; no changes applied.' :
                               'Successfully pushed catalog entries.');
    return 0;
  } else {
    console.error('Error pushing catalog entries:', result.details);
    return 1;
  }
}


export interface ProfilesOptions {
  // `string|boolean` for the same reason push's is: cac yields `true` for a
  // bare `--profile` and `false` for `--no-profile`.
  profile?: string|boolean;
  // `--print-store`: print the store this profile deploys to and nothing else.
  printStore?: boolean;
}


// Prints the store one profile deploys to, on a line with nothing else on it.
//
//   kcmd profiles --print-store [--profile <name>]
//
// A script that creates, seeds or drops the database an action writes to has
// to address the database the action writes to, and the profile's deployment
// target is what decides that; naming it a second time in the script is a
// second place to name it differently. So the script asks. The answer is a
// read of the binding, never a choice of one -- `--profile` is the only thing
// that picks, here as everywhere else.
//
// Returns a process exit code (0 on success).
async function printStore(options: ProfilesOptions): Promise<number> {
  const ctx = context.ApiContext.default();
  const named =
      typeof options.profile === 'string' ? options.profile : undefined;

  const opened = await createSemanticRuntimes({profile: named, ctx});
  if ('error' in opened) {
    console.error(`Error: ${opened.error}`);
    return 1;
  }

  // One line, because the caller is `STORE=$(kcmd profiles --print-store)` and
  // a second line makes that variable address the wrong database. A scope
  // holding several models has no single answer, so it says so instead.
  if (opened.length > 1) {
    console.error(
        `Error: this scope holds ${opened.length} models, which may name ` +
        `different databases, so --print-store has no single answer. Narrow ` +
        `the scope to one model.`);
    return 1;
  }
  for (const {store, storeError} of opened) {
    if (!store) {
      console.error(`Error: ${storeError}`);
      return 1;
    }
    console.log(storeLine(store));
  }
  return 0;
}


// Lists a semantic model's binding profiles and, per profile, its resolved
// deployment target and sources plus what it cannot answer (the availability
// report). Read-only: it merges and prunes each profile the way push does, but
// deploys nothing and runs no live probe, so a user can see coverage before
// choosing a profile. Returns a process exit code (0 on success).
export async function profiles(options: ProfilesOptions = {}): Promise<number> {
  if (options.printStore) return await printStore(options);

  // `--profile` narrows the report to one profile; anything that is not a name
  // (a bare `--profile`, `--no-profile`) narrows nothing, the same read every
  // other command does.
  const only =
      typeof options.profile === 'string' ? options.profile : undefined;

  const ctx = context.ApiContext.default();
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
  if (snapshot.manifest.source.type !== Sources.SEMANTIC_MODEL) {
    console.error(
        'Error: `kcmd profiles` applies only to a semantic-model scope.');
    return 1;
  }
  const layout = snapshot.layout as SemanticModelLayout;
  const source = snapshot.manifest.source as SemanticModelSource;
  const defaultProfile = snapshot.manifest.defaultProfile;

  const docs = layout.modelDocuments();
  if (!docs.length) {
    console.log('No semantic model documents found.');
    return 0;
  }

  // Set when `--profile` names something no model declares, so a typo exits
  // non-zero rather than reporting an empty scope as a clean one.
  let missing = false;

  for (const doc of docs) {
    console.log(`Model '${doc.name}' (${source.entryGroup}):`);
    const declared = layout.profileDocuments(doc.name);
    // 'default' is not a profile document and never can be -- a push rejects a
    // file by that name. It names the inline bindings, which every model has,
    // so it is the one profile name that is always right and has nothing to
    // merge or prune. Reported here rather than falling into the typo check
    // below, which would call a universally valid name undeclared.
    if (only === DEFAULT_PROFILE) {
      console.log(
          `  profile '${DEFAULT_PROFILE}': the model document's own inline ` +
          `bindings, as authored -- nothing merged, nothing withheld.`);
      continue;
    }
    const available = only ? declared.filter(p => p.name === only) : declared;
    // Naming a profile the model does not declare is a typo, not an empty
    // report: saying nothing would read as "this profile withholds nothing".
    // Checked before the inline-binding line below, because a model that
    // declares no profile documents still has to call a typo a typo -- saying
    // "no binding profiles" and exiting 0 answers a question nobody asked.
    if (only && !available.length) {
      console.error(
          `  no profile '${only}'; this model declares ` +
          (declared.length ?
               `${declared.map(p => `'${p.name}'`).join(', ')}.` :
               `none, and its inline bindings are its 'default'.`));
      missing = true;
      continue;
    }
    if (!declared.length) {
      console.log(
          `  no binding profiles; the model document is its own inline ` +
          `'default' binding.`);
      continue;
    }
    for (const {name, text} of available) {
      const res = mergeProfileOntoDoc(doc.text, text, name);
      if ('error' in res) {
        console.error(`  profile '${name}': ${res.error}`);
        continue;
      }
      for (const w of res.warnings) {
        console.warn(`  profile '${name}': warning: ${w}`);
      }
      const loaded = loadSemanticModels(
          [{name: doc.name, text: res.text}],
          {defaultProject: source.project ?? ctx.project});
      if (loaded.error) {
        console.error(`  profile '${name}': ${loaded.error}`);
        continue;
      }
      const model = loaded.models[0].model;
      const {report} = pruneUnavailable(model, name);
      const marker = name === defaultProfile ? ' (default)' : '';
      console.log(`  profile '${name}'${marker}`);

      let targets: string[] = [];
      try {
        targets = deploy.deploymentTargetUris(model);
      } catch {
        // A malformed deployment target is a push-time error; here just show
        // none rather than abort the listing.
      }
      console.log(
          `    target: ${targets.length ? targets.join(', ') : '(none)'}`);
      console.log('    sources:');
      for (const e of model.entities ?? []) {
        console.log(`      ${e.name} -> ${e.dataSource || '(unbound)'}`);
      }

      const withheld: string[] = [];
      for (const d of report.droppedEntities) {
        withheld.push(`entity ${d.name} (${d.reason})`);
      }
      for (const f of report.unboundFields)
        withheld.push(`field ${f} (unbound)`);
      for (const d of report.droppedRelationships) {
        withheld.push(`relationship ${d.name} (${d.reason})`);
      }
      for (const d of report.droppedMetrics) {
        withheld.push(`metric ${d.name} (${d.reason})`);
      }
      if (withheld.length) {
        console.log('    cannot answer:');
        for (const w of withheld) console.log(`      ${w}`);
      } else {
        console.log('    cannot answer: nothing withheld.');
      }
      // Listed apart from the read side: an action is not a question this
      // binding cannot answer, it is a write it cannot perform.
      if (report.droppedActions.length) {
        console.log('    cannot run:');
        for (const d of report.droppedActions) {
          console.log(`      action ${d.name} (${d.reason})`);
        }
      }
    }
  }
  return missing ? 1 : 0;
}


// Deploys the semantic model's BigQuery Graph leg (over the pre-loaded models)
// and prints the result. Returns a process exit code (0 on success).
async function pushBigQuery(
    models: LoadedModel[], ctx: context.ApiContext,
    options: PushOptions): Promise<number> {
  console.log(
      options.validateOnly ? 'Validating semantic model for BigQuery Graph...' :
                             'Pushing semantic model (BigQuery Graph)...');
  const result = await deploy.deployBigQuery(models, ctx, options);

  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }
  if (options.print) {
    console.log('-- BigQuery Graph --');
    for (const block of result.ddl) {
      console.log(`${block}\n`);
    }
  }

  if (!result.success) {
    console.error('Error pushing semantic model to BigQuery:', result.details);
    return 1;
  }
  console.log(
      options.validateOnly ? 'Validation complete; no changes applied.' :
                             `Deployed ${result.deployed} BigQuery Graph(s).`);
  return 0;
}


// Deploys the semantic model's Spanner Graph leg (over the pre-loaded models)
// and prints the result. Sibling to pushBigQuery. Returns a process exit code
// (0 on success).
async function pushSpanner(
    models: LoadedModel[], ctx: context.ApiContext,
    options: PushOptions): Promise<number> {
  console.log(
      options.validateOnly ? 'Validating semantic model for Spanner Graph...' :
                             'Pushing semantic model (Spanner Graph)...');
  const result = await deploySpannerLeg.deploySpanner(models, ctx, options);

  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }
  if (options.print) {
    console.log('-- Spanner Graph --');
    for (const block of result.ddl) {
      console.log(`${block}\n`);
    }
  }

  if (!result.success) {
    console.error('Error pushing semantic model to Spanner:', result.details);
    return 1;
  }
  console.log(
      options.validateOnly ? 'Validation complete; no changes applied.' :
                             `Deployed ${result.deployed} Spanner Graph(s).`);
  return 0;
}


// Deploys the semantic model's Knowledge Catalog leg (over the pre-loaded
// models) and prints the result. The destination coordinates come from the
// scope (project.location.entryGroup). Returns a process exit code (0 on
// success).
async function pushKnowledgeCatalog(
    models: LoadedModel[], ctx: context.ApiContext, options: PushOptions,
    source: SemanticModelSource): Promise<number> {
  console.log(
      options.validateOnly ?
          'Validating semantic model for Knowledge Catalog...' :
          'Pushing semantic model (Knowledge Catalog)...');
  const result = await kc.deployKnowledgeCatalog(models, ctx, {
    project: source.project,
    location: source.location,
    entryGroup: source.entryGroup,
    validateOnly: options.validateOnly,
    forceRemove: options.forceRemove,
    emitExpressions: options.emitExpressions,
    // The semantic-* system types live in `dataplex-types/global` on prod.
    // Override via KC_TYPE_PROJECT to reference them from another project
    // (e.g. `dataplex-autopush-types` on the autopush/sandbox EAP).
    systemTypeProject: process.env.KC_TYPE_PROJECT,
  });

  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }
  if (options.print) {
    console.log('-- Knowledge Catalog --');
    for (const line of result.plan) {
      console.log(line);
    }
  }

  if (!result.success) {
    console.error(
        'Error pushing semantic model to Knowledge Catalog:', result.details);
    return 1;
  }
  const n = result.created + result.updated;
  const removed = result.deleted ? `; removed ${result.deleted} orphaned entr${
                                       result.deleted === 1 ? 'y' : 'ies'}` :
                                   '';
  const linked = result.linked ? `; linked ${result.linked} relationship${
                                     result.linked === 1 ? '' : 's'}` :
                                 '';
  const unlinked = result.unlinked ?
      `; unlinked ${result.unlinked} orphaned link${
          result.unlinked === 1 ? '' : 's'}` :
      '';
  console.log(
      options.validateOnly ?
          'Validation complete; no changes applied.' :
          `Wrote ${result.created} new and ${result.updated} updated ` +
              `Knowledge Catalog entr${n === 1 ? 'y' : 'ies'}${removed}${
                  linked}${unlinked}.`);
  return 0;
}


// Pulls the semantic model's Knowledge Catalog entries back into local model
// documents (catalog/EntryGroups/<entryGroup>/<model>.yaml) and prints the
// result. The destination coordinates come from the scope
// (project.location.entryGroup). An entry group holds one model: a local
// document with the same name is overwritten in place; a differently-named
// local document is a conflict (pull would leave two models), so pull fails
// unless --force-remove authorizes deleting the stale local model first.
// Returns a process exit code (0 on success).
async function pullSemanticModel(
    ctx: context.ApiContext, snapshot: kcmd.CatalogSnapshot,
    options: PullOptions): Promise<number> {
  // The semantic-model source always resolves to the SemanticModel layout
  // (see createLayout), so these casts are safe.
  const layout = snapshot.layout as SemanticModelLayout;
  const source = snapshot.manifest.source as SemanticModelSource;

  console.log(
      options.dryRun ?
          'Reconstructing semantic model from Knowledge Catalog (dry run)...' :
          'Pulling semantic model from Knowledge Catalog...');

  const catalog = new dataplex.CatalogClient(ctx);
  const result = await pullKnowledgeCatalog(catalog, {
    project: source.project,
    location: source.location,
    entryGroup: source.entryGroup,
  });

  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }

  if (!result.models.length) {
    console.log('No semantic models found; nothing to pull.');
    return 0;
  }

  // Reconcile the local layout with the catalog. A local document whose name
  // differs from the pulled model would leave the entry group with two models,
  // so pull refuses by default; --force-remove deletes the stale local
  // document(s) before the catalog's is written.
  const catalogNames = new Set(result.models.map(m => m.name));
  // Compare by the on-disk path each name maps to, not the raw name: a catalog
  // model name and a local document whose names sanitize to the same file (e.g.
  // 'a/b' -> 'a_b.yaml') are the same model, not a stale conflict.
  const catalogPaths =
      new Set(result.models.map(m => layout.modelPath(m.name)));
  const staleLocal = layout.modelDocuments()
                         .map(d => d.name)
                         .filter(n => !catalogPaths.has(layout.modelPath(n)));
  if (staleLocal.length) {
    if (!options.forceRemove) {
      const localList = staleLocal.map(n => `'${n}'`).join(', ');
      const catalogList = [...catalogNames].map(n => `'${n}'`).join(', ');
      console.error(
          `Error: local model(s) ${localList} do not match the catalog ` +
          `model ${catalogList} in this entry group. An entry group holds ` +
          `one model, so pull will not leave two behind. Re-run with ` +
          `--force-remove to delete the local model(s) and pull the ` +
          `catalog's.`);
      return 1;
    }
    for (const name of staleLocal) {
      const p = layout.modelPath(name);
      if (options.dryRun) {
        console.log(`  would remove ${p}`);
      } else {
        layout.removeModelDocument(name);
        console.log(`  removed ${p}`);
      }
    }
  }

  let created = 0;
  let updated = 0;
  // Guard against two reconstructed models whose names map to the same file
  // (path-separator sanitizing, or two anchors sharing a display name): the
  // later write would silently clobber the earlier. Track written paths so the
  // collision is reported and the dry-run/real counts agree on the repeat.
  const writtenBy = new Map<string, string>();
  for (const model of result.models) {
    const serialized = serializeModel(model);
    for (const w of serialized.warnings) {
      console.warn(`Warning: [${model.name}] ${w}`);
    }
    const target = layout.modelPath(model.name);
    const prior = writtenBy.get(target);
    if (prior !== undefined && prior !== model.name) {
      console.warn(
          `Warning: models '${prior}' and '${model.name}' both map to ` +
          `${target}; the later overwrites the earlier -- rename one model.`);
    }
    const existed = writtenBy.has(target) || layout.hasModel(model.name);
    writtenBy.set(target, model.name);
    if (options.dryRun) {
      console.log(`  would ${existed ? 'update' : 'create'} ${target}`);
    } else {
      layout.writeModelDocument(model.name, serialized.yaml);
      console.log(`  ${existed ? 'updated' : 'created'} ${target}`);
    }
    if (existed)
      updated++;
    else
      created++;
  }

  console.log(
      options.dryRun ?
          `Dry run: would write ${created} new and ${
              updated} updated model document(s).` :
          `Wrote ${created} new and ${updated} updated model document(s).`);
  return 0;
}


export interface OwlImportOptions {
  // Emit the compact flow YAML layout (`primary_key: [id]`, inline field and
  // relationship maps) instead of the default block layout. Off by default;
  // the semantic-model codelab turns it on so its shown output is reproducible.
  compact?: boolean;
  // Write the generated OSI document to this path instead of the semantic-model
  // layout dir. When omitted, the model lands in the scope's model layout so
  // the next `kcmd push` picks it up.
  out?: string;
}

// Recognized OWL source extensions, stripped to derive the model name from the
// filename: `sales.owl.ttl` -> `sales`.
const OWL_EXTENSIONS = /\.owl\.ttl$|\.ttl$|\.owl$/i;

// Handles `kcmd owl <action> <file>`. The only action is `import`: convert a
// Turtle OWL ontology into an OSI model document that then rides the normal
// `kcmd push` / `kcmd pull`. The converted model is purely LOGICAL (see the OWL
// converter): `kcmd push` publishes it as-is; a BigQuery or Spanner
// Graph deploy needs each relationship's join columns added to the model (a
// logical fact the model owns) plus a binding profile (sources, field columns)
// and a deployment target. Returns a process exit code.
export async function owl(
    action: string, file: string, options: OwlImportOptions): Promise<number> {
  if (action !== 'import') {
    console.error(
        `Error: unknown owl action '${action}'; the only action is 'import' ` +
        `(usage: kcmd owl import <file.ttl>).`);
    return 1;
  }

  if (!fs.existsSync(file)) {
    console.error(`Error: file not found: ${file}`);
    return 1;
  }

  const turtle = fs.readFileSync(file, 'utf8');
  const modelName = path.basename(file).replace(OWL_EXTENSIONS, '');
  if (!modelName) {
    console.error(`Error: could not derive a model name from '${file}'.`);
    return 1;
  }

  // convertOwlToOsi throws only on malformed Turtle; main.ts's try/catch
  // reports it.
  const result =
      convertOwlToOsi(turtle, modelName, {compactFlow: options.compact});
  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }

  const {classes, datatypeProperties, objectProperties} = result.stats;

  // Guard: an ontology with no owl:Class yields a model with no datasets, which
  // is not a loadable OSI model. Fail clearly -- before the summary, so we do
  // not print a "converted 0 classes" line for a model we are about to reject
  // -- rather than writing an empty artifact that only errors on a later
  // push/pull.
  if (classes === 0) {
    console.error(`Error: no owl:Class declarations found in '${
        file}'; nothing to import.`);
    return 1;
  }

  console.log(
      `converted ${classes} ${plural(classes, 'class', 'classes')}, ` +
      `${objectProperties} ` +
      `${plural(objectProperties, 'object property', 'object properties')}, ` +
      `${datatypeProperties} ` +
      `${
          plural(
              datatypeProperties, 'datatype property',
              'datatype properties')}`);

  // Sink: an explicit --out path writes directly; otherwise the semantic-model
  // layout places the document under the scope's entry group so `kcmd push`
  // finds it.
  let writtenPath: string;
  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), {recursive: true});
    fs.writeFileSync(options.out, result.yaml);
    writtenPath = options.out;
  } else {
    const ctx = context.ApiContext.default();
    const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
    if (snapshot.manifest.source.type !== Sources.SEMANTIC_MODEL) {
      console.error(
          `Error: this catalog is not a semantic-model scope, so there is no ` +
          `model layout to write into. Run \`kcmd init --semantic-model ...\` ` +
          `first, or pass --out <path> to write the OSI document directly.`);
      return 1;
    }
    const layout = snapshot.layout as SemanticModelLayout;
    layout.writeModelDocument(modelName, result.yaml);
    writtenPath = layout.modelPath(modelName);
  }

  console.log(`wrote ${writtenPath}`);
  return 0;
}

// Selects the singular or plural form based on `n` (English count agreement).
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}


// What `--no-kc` costs a model that declares catalog-only constructs. Both
// actions and constraints deploy through the Knowledge Catalog leg alone, so
// either one on its own is worth a warning, and a model with both gets one
// sentence naming both. Exported for the same reason checkPushSelection is: it
// is a pure decision about what a flag combination means.
export function catalogOnlyWarning(
    model: string, n: {actions: number; constraints: number}): string {
  const declared =
      [
        n.actions ? `${n.actions} action(s)` : '',
        n.constraints ? `${n.constraints} constraint(s)` : '',
      ].filter(part => part)
          .join(' and ');
  return `model '${model}' declares ${declared}, which deploy only to ` +
      `Knowledge Catalog; --no-kc excludes that leg, so they will not be ` +
      `deployed. Drop --no-kc to deploy them.`;
}


export interface SkillsGenerateOptions {
  profile?: string|boolean;
  /**
   * Directory the skill directories are written under. Defaults to `skills`.
   */
  out?: string;
  /** Overrides the skill's name, and so the directory it is written to. */
  name?: string;
  /** Replace a skill that is already there, pruning stale pages. */
  force?: boolean;
}


// Writing a model out as an Agent Skill.
//
// Writes the derived model to disk in the form an agent loads by itself: a
// directory per model, a `SKILL.md` a client reads, and the per-action detail
// in files beside it.
//
// One skill per model in the scope, because a skill is named and a name
// addresses one thing. `--name` therefore only applies to a scope with one
// model; with more, each takes its own model's name.
//
// A skill already on disk is not overwritten without `--force`. What is
// generated is a starting point somebody is expected to read and may have
// edited, and a regeneration that silently replaced those edits would be a
// command that loses work every time the model changes.
//
// Returns a process exit code (0 on success).
export async function skillsGenerate(options: SkillsGenerateOptions = {}):
    Promise<number> {
  const ctx = context.ApiContext.default();
  const named =
      typeof options.profile === 'string' ? options.profile : undefined;
  const opened = await createSemanticRuntimes({profile: named, ctx});
  if ('error' in opened) {
    console.error(`Error: ${opened.error}`);
    return 1;
  }
  if (options.name && opened.length > 1) {
    console.error(`Error: --name applies to one skill, and this scope has ${
        opened.length} models. Drop it and each takes its model's name.`);
    return 1;
  }

  const root = options.out ?? 'skills';

  // Everything knowable before a byte is written is settled first, and one
  // fault stops the whole scope. Interleaving the checks with the writes means
  // a collision found on the second model is reported after the first has
  // already been written -- the command refuses the scope and leaves half of
  // it on disk, under a name it has just said it cannot assign. `generateSkill`
  // is pure, so ordering the work this way costs only the order.
  const planned: Array<{model: string; dir: string; generated: SkillPackage;}> =
      [];
  // A skill name is a lossy form of a model name, so two models in one scope
  // can arrive at one directory. Writing both would leave the second on disk
  // and the first gone, with two "Wrote ..." lines and an exit code of 0
  // saying otherwise.
  const claimed = new Map<string, string>();
  let failed = false;
  for (const runtime of opened) {
    const generated = generateSkill({runtime, name: options.name});
    if ('error' in generated) {
      console.error(`Error: [${runtime.model.name}] ${generated.error}`);
      failed = true;
      continue;
    }
    const clash = claimed.get(generated.name);
    if (clash !== undefined) {
      console.error(
          `Error: models '${clash}' and '${runtime.model.name}' both name ` +
          `their skill '${generated.name}'. Generate them separately with ` +
          `--name, or rename one model.`);
      failed = true;
      continue;
    }
    claimed.set(generated.name, runtime.model.name);

    // The directory name IS the skill name -- a client that finds them
    // different skips the skill -- so it is taken from what was generated
    // rather than from anything the caller typed.
    const dir = path.join(root, generated.name);
    if (fs.existsSync(dir) && !options.force) {
      console.error(
          `Error: ${dir} already exists. Pass --force to rewrite it.`);
      failed = true;
      continue;
    }
    planned.push({model: runtime.model.name, dir, generated});
  }
  if (failed) return 1;

  for (const {model, dir, generated} of planned) {
    // Warned before this skill is written, so a reader who does not want it
    // still has the chance not to have it.
    for (const warning of generated.warnings) {
      console.warn(`Warning: [${model}] ${warning}`);
    }
    try {
      const keep = new Set(generated.files.map(f => f.path));
      for (const file of generated.files) {
        const target = path.join(dir, file.path);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, file.text);
        console.log(`Wrote ${target}`);
      }
      for (const stale of stalePages(dir, keep)) {
        fs.rmSync(path.join(dir, stale));
        console.log(`Removed ${path.join(dir, stale)}`);
      }
    } catch (e) {
      // A path that will not take a write is the one thing this cannot check
      // in advance. One of them must not take the rest of the scope with it,
      // and must not be reported as a bare errno with no model attached.
      console.error(`Error: [${model}] could not write under ${dir}: ${
          e instanceof Error ? e.message : String(e)}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

// Reference pages left over from an action the model no longer declares.
//
// `--force` replaces a skill rather than layering a new one over it. Without
// this, renaming an action leaves its old page on disk, and progressive
// disclosure means an agent is expected to open files under `references/` on
// demand -- so the stale page is read as current and describes a call that no
// longer exists.
function stalePages(dir: string, keep: Set<string>): string[] {
  const refs = path.join(dir, 'references');
  if (!fs.existsSync(refs)) return [];
  return fs.readdirSync(refs)
      .filter(f => f.endsWith('.md'))
      .map(f => `references/${f}`)
      .filter(f => !keep.has(f));
}

