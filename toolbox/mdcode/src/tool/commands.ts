// CLI command handlers
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

import * as kcmd from '../libts';
import {BigLakeClient} from '../libts/gcp/biglake';
import {BigQueryClient} from '../libts/gcp/bigquery';
import * as context from '../libts/gcp/context';
import * as crm from '../libts/gcp/crm';
import * as dataplex from '../libts/gcp/dataplex';
import {SpannerClient} from '../libts/gcp/spanner';
import {OkfLayout} from '../libts/layouts/okf';
import {checkProfileFileName, diskFiles, fileNameOf, filesAfter, formatOverviewSidecar, LayoutFiles, legacyProfileDirError, legacyProfileFiles, OverviewSidecar, parseOverviewSidecar, profileFileNamesBeside, sameOverview, SemanticModelLayout} from '../libts/layouts/semantic-model';
import {SplitLayout} from '../libts/layouts/split';
import {readWorkspaceLayout} from '../libts/manifest';
import {fileContentToConcept} from '../libts/okf/concept';
import {initOkfWorkspace} from '../libts/okf/init_okf_workspace';
import {convertOwlToOsi} from '../libts/semantic/converters/owl/convert';
import * as deploy from '../libts/semantic/deploy_bigquery';
import * as kc from '../libts/semantic/deploy_knowledge_catalog';
import * as deploySpannerLeg from '../libts/semantic/deploy_spanner';
import {googleDeploymentTargets, parseDeploymentSelection, ResolvedDeployment, resolveModelDeployments, unnamedDeployments} from '../libts/semantic/deployment_target';
import {importSemanticModelYaml} from '../libts/semantic/import_model';
import {ProfileSpec, SemanticModel} from '../libts/semantic/ir';
import {provisionCustomTypes} from '../libts/semantic/kc_custom_types';
import {listed, LoadedModel, loadModels, loadSemanticModels, OSSIE_VERSION, plural, SemanticModelError, writtenSource} from '../libts/semantic/loader';
import {SerializedFile, serializeModelFiles} from '../libts/semantic/osi_converter';
import {catalogForm, updatedText} from '../libts/semantic/pull_update';
import {storeMessage} from '../libts/semantic/parameters';
import * as pullKc from '../libts/semantic/pull_kc';
import {DeclaredProfile, DeclaredProfiles, declaredProfiles, DEFAULT_PROFILE, DialectLoad, importCommand, loadProfileFile, LocalCheckError, namedProfileErrors, profileErrorMessage, profileForDocument, pruneUnavailable, sourcesDialect, transpilesSomething,} from '../libts/semantic/resolve_profiles';
import {createSemanticRuntimes} from '../libts/semantic/runtime/runtime';
import {profileTargets, storeLine} from '../libts/semantic/runtime/store';
import {generateSkill, SkillPackage} from '../libts/semantic/skills';
import {SourceDialects, sourceDialects} from '../libts/semantic/source_dialect';
import {sourceEntryErrors} from '../libts/semantic/source_entries';
import {loadSqlEngine} from '../libts/semantic/sql_parser';
import {DeploymentPlan, inlineBindingWarnings, localChecks, pruningLines, validateBigQueryActionStatements, validateBigQueryDataSources, validateSpannerActionStatements, validateSpannerGraph, withProfileFiles, yamlChangedStatementErrors} from '../libts/semantic/validate';
import {entryGroupCoordinates, Sources} from '../libts/source';
import {SemanticModelSource} from '../libts/sources/semantic-model';


// `kcmd init --format <layout>` chooses how the workspace stores its entries
// on disk, and records it as `layout:` in catalog.yaml; `pull` and `push` read
// it back from there, so they take no format flag. Only `okf` exists. Anything
// else throws rather than falling back to the default layout, which would
// write a tree the caller did not ask for. main.ts turns the throw into
// `Error: <message>` and exit 1, as it does for every other command failure.
export const OKF_FORMAT = 'okf';

function okfSelected(options: {format?: string}): boolean {
  if (options.format === undefined) return false;
  if (options.format === OKF_FORMAT) return true;
  throw new Error(
      `unknown --format '${options.format}' for kcmd init. ` +
      `Only '${OKF_FORMAT}' is supported.`);
}

// Whether the workspace in the current directory is an OKF workspace, as its
// catalog.yaml records. Read before anything resolves the scope, since an OKF
// push may create the entry group.
function okfWorkspace(): boolean {
  return readWorkspaceLayout('catalog.yaml') === OKF_FORMAT;
}

export interface InitOptions {
  // The workspace layout to record in catalog.yaml; only `okf`. Omitted means
  // the layout the scope implies.
  format?: string;
  entryGroup?: string;
  bigqueryDataset?: string|string[];
  kb?: string;
  semanticModel?: string;
  contextSet?: string;
  pull?: boolean;
}


export interface PushOptions {
  // `--force`, which has no effect beyond a warning.
  force?: boolean;
  // Run every validation check and report pass/fail, but write nothing
  // to any destination (a dry run). Applies to both push paths.
  validateOnly?: boolean;
  // `--dry-run`, the README's name for the same thing, as `pull` names it.
  // push() folds it into validateOnly before anything reads either.
  dryRun?: boolean;
  // Delete Knowledge Catalog models already in the entry group that this push
  // does not include (a removed or renamed model). Without it, an unrecognized
  // model in the group fails the push. Semantic-model KC push only.
  forceRemove?: boolean;
  // Skip the checks that every source names a table Knowledge Catalog knows
  // about and that the BigQuery and BigLake tables of each profile share a
  // location. Push still looks up each source's dialect: a Cloud SQL or
  // third-party table's entry, and a Spanner table's database. Semantic-model
  // push only.
  skipSourceCheck?: boolean;
  // No longer supported: push refuses `--no-kc`, which cac gives as false,
  // since every push publishes the model to Knowledge Catalog.
  kc?: boolean;
  // Print each pushed destination's generated artifact in that destination's
  // native format (BigQuery/Spanner Graph -> SQL DDL, Knowledge Catalog -> the
  // entry plan), each block labeled by destination. Works with or without
  // --validate-only. Semantic-model push only.
  print?: boolean;
  // No longer supported: push refuses `--emit-expressions`.
  emitExpressions?: boolean;
  // No longer supported: push refuses it, and `kcmd import --transpile`
  // translates SQL dialects instead. It stays an option so the refusal can say
  // so.
  transpile?: boolean;
  // No longer supported: push refuses `--profile <name>`, a bare `--profile`
  // and `--no-profile`. main.ts passes a bare `--profile` as an empty string,
  // and cac gives `--no-profile` as false and an absent `--profile` as true.
  profile?: string|boolean;
  // No longer supported: push refuses `--all-profiles`.
  allProfiles?: boolean;
  // The `--deployment` values as typed, true for a bare `--deployment` and
  // false for `--no-deployment`, in order. Outside a list, false is
  // `--no-deployment` alone and true is neither flag. Semantic-model push only.
  deployment?: string|boolean|Array<string|boolean>;
  // Seconds to wait for Dataplex link IAM permissions on a newly created OKF
  // context set (`--propagation-timeout <seconds>`).
  propagationTimeout?: number|string;
}


// True when a model declares a deployment target of the given graph type.
function hasTargetType(
    loaded: Pick<LoadedModel, 'model'>, type: 'bigquery'|'spanner'): boolean {
  const t = googleDeploymentTargets(loaded.model);
  return type === 'bigquery' ? t.bigQuery.length > 0 : t.spanner.length > 0;
}

// The dialect pruning reads a model's SQL in: SPANNER when the model has a
// Spanner graph target, since that graph reads SPANNER text first, else the
// dialect its sources imply.
function pruningDialect(model: SemanticModel): string|null|undefined {
  return hasTargetType({model}, 'spanner') ? 'SPANNER' : sourcesDialect(model);
}


export async function init(options: InitOptions): Promise<number> {
  const okf = okfSelected(options);

  if (okf &&
      (options.bigqueryDataset || options.semanticModel ||
       options.contextSet)) {
    throw new Error(
        `Manifest error: layout '${OKF_FORMAT}' applies only to ` +
        `'${Sources.ENTRYGROUP}' and '${Sources.KB}' scopes.`);
  }

  const ctx = context.ApiContext.default();

  let manifest: kcmd.CatalogManifest;
  let okfRemoteExists = true;
  if (options.entryGroup || options.kb) {
    const scopeName = (options.entryGroup || options.kb)!;
    const isKb = Boolean(options.kb && !options.entryGroup);
    try {
      manifest = isKb
        ? await kcmd.CatalogManifest.initWithKnowledgeBase(scopeName, ctx)
        : await kcmd.CatalogManifest.initWithEntryGroup(scopeName, ctx);
    } catch (err: any) {
      const msg = String(err?.message || err);
      const parts = scopeName.split('.');
      if (
        okf &&
        msg.includes('Failed to locate EntryGroup') &&
        parts.length === 3 &&
        parts.every((p) => Boolean(p))
      ) {
        okfRemoteExists = false;
        manifest = kcmd.CatalogManifest.forPendingEntryGroup(
          isKb ? Sources.KB : Sources.ENTRYGROUP,
          scopeName,
          'okf',
        );
      } else {
        throw err;
      }
    }
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
    // entries, never the entry group). Idempotent: a group that exists is
    // success. A 409, or a 403 with a lookup that finds the group, means the
    // group exists.
    const catalog = new dataplex.CatalogClient(ctx);
    // A plain entry group, as before: creating a context set needs other
    // permissions, so it is never a side effect of this scope. The create's
    // operation can still fail after the request is accepted, so init waits
    // for it and reports the failure.
    const created = await dataplex.createEntryGroupAndWait(
        catalog, source.project, source.location, source.entryGroup);
    if (created.error) {
      console.error(`Error: ${created.error}`);
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
  } else if (options.contextSet) {
    const parts = options.contextSet.split('.');
    if (parts.length !== 3 || parts.some(p => !p)) {
      throw new Error(
          `Context set must be in format <projectId>.<locationId>.<entryGroupId>`);
    }
    const [project, location, entryGroup] = parts;
    const catalog = new dataplex.CatalogClient(ctx);
    const created =
        await dataplex.createContextSet(catalog, project, location, entryGroup);
    if (created.error) {
      if (!created.existing &&
          /\b403\b|permission.*denied/i.test(created.error)) {
        console.error(
            `Error: ${created.error}. Creating a context set needs ` +
            `roles/dataplex.contentCreator on the project (and ` +
            `roles/dataplex.contentEditor on the group for teammates and CI).`);
      } else {
        console.error(`Error: ${created.error}`);
      }
      return 1;
    }
    manifest =
        await kcmd.CatalogManifest.initWithContextSet(options.contextSet, ctx);
    const provisioned = await provisionCustomTypes(catalog, {project});
    for (const w of provisioned.warnings ?? []) console.warn(`Warning: ${w}`);
    if (provisioned.error) {
      console.error(`Error: ${provisioned.error}`);
      return 1;
    }
    if (provisioned.denied) console.warn(`Warning: ${provisioned.denied}`);
    fs.mkdirSync(
        path.join('catalog', 'EntryGroups', entryGroup), {recursive: true});
    fs.mkdirSync('bundle', {recursive: true});
    if (created.created) {
      console.log(
          `Note: '${options.contextSet}' is a new context set. To let others ` +
          `push or pull it, grant them roles/dataplex.contentEditor on it: ` +
          `gcloud dataplex entry-groups add-iam-policy-binding ${entryGroup} ` +
          `--project=${project} --location=${location} --member=<principal> ` +
          `--role=roles/dataplex.contentEditor. A pull or push in the next ` +
          `minute can fail with a permission error; run it again after that.`);
    }
  } else {
    console.error(
        'Error: Must provide --entry-group, --bigquery-dataset, --kb, --semantic-model, or --context-set');
    return 1;
  }

  if (okf) {
    (manifest as any).okfRemoteExists = okfRemoteExists;
    return await initOkfWorkspace(ctx, manifest, {pull: options.pull});
  }

  // Re-running init for the same scope leaves catalog.yaml as it was, so
  // every key and the comments are kept. Init for
  // another scope writes a new file.
  const prior = fs.existsSync('catalog.yaml') ?
      fs.readFileSync('catalog.yaml', 'utf8') :
      undefined;
  manifest.save('catalog.yaml');
  const scope = scopeOf(fs.readFileSync('catalog.yaml', 'utf8'));
  if (prior !== undefined && scope !== undefined && scopeOf(prior) === scope) {
    fs.writeFileSync('catalog.yaml', prior);
  }
  console.log(fs.readFileSync('catalog.yaml', 'utf8'));

  if (options.pull) {
    return await pull();
  }

  return 0;
}


// The scope a catalog.yaml text names, as JSON so that a list of scopes
// compares by value. Undefined when the text does not parse or names none.
function scopeOf(text: string): string|undefined {
  try {
    return JSON.stringify(yaml.parse(text)?.scope);
  } catch {
    return undefined;
  }
}


export interface PullOptions {
  // Reconstruct + report only; never writes a file. Mirrors push
  // --validate-only.
  dryRun?: boolean;
  // Authorize replacing a differently-named local model with the catalog's, or
  // removing stale OKF concept files no longer in Knowledge Catalog.
  // Without it, a pull whose catalog model id differs from the local model on
  // disk fails rather than leave two models in the entry group. Mirrors the
  // push flag of the same name.
  forceRemove?: boolean;
}


function ensureManifestExists(basePath = '.'): void {
  const manifestPath = path.join(basePath, 'catalog.yaml');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Cannot find catalog manifest at '${manifestPath}'`);
  }
}

export async function pull(options: PullOptions = {}): Promise<number> {
  okfWorkspace();
  ensureManifestExists('.');

  const ctx = context.ApiContext.default();
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);

  if (snapshot.layout instanceof OkfLayout) {
    const catalog = new dataplex.CatalogClient(ctx);
    const sync = new kcmd.CatalogSync(catalog, snapshot);
    const result = await sync.pull({
      dryRun: options.dryRun,
      forceRemove: options.forceRemove,
    });
    if (!result.success) {
      throw new Error(result.details || 'Error pulling OKF bundle');
    }
    return 0;
  }

  if (snapshot.manifest.source.type === Sources.SEMANTIC_MODEL) {
    return await pullSemanticModel(ctx, snapshot, options);
  }

  if (snapshot.manifest.source.type === Sources.CONTEXT_SET) {
    const split = snapshot.layout as SplitLayout;
    const modelCode =
        await pullSemanticModel(ctx, snapshot, options, split.semantic);
    if (modelCode !== 0) return modelCode;
    const catalog = new dataplex.CatalogClient(ctx);
    const sync = new kcmd.CatalogSync(catalog, snapshot);
    const result = await sync.pull({
      dryRun: options.dryRun,
      forceRemove: options.forceRemove,
    });
    if (!result.success) {
      throw new Error(result.details || 'Error pulling OKF bundle');
    }
    return 0;
  }

  const catalog = new dataplex.CatalogClient(ctx);
  const sync = new kcmd.CatalogSync(catalog, snapshot);

  console.log(
      options.dryRun ? 'Reconstructing catalog entries (dry run)...' :
                       'Pulling catalog entries...');
  const result = await sync.pull({
    dryRun: options.dryRun,
    forceRemove: options.forceRemove,
  });

  if (result.success) {
    if (!options.dryRun) console.log('Successfully updated local snapshot.');
    return 0;
  } else {
    console.error('Error pulling catalog entries:', result.details);
    return 1;
  }
}


// The error for each legacy profile form in the scope of `snapshot`, every one
// found: `default_profile` in catalog.yaml, a `<model>.profiles/` directory,
// and a profile file with no model file beside it. Push, `kcmd profiles` and
// `kcmd skills-generate` refuse a scope that has any, before they read a model.
// Pull and init still work in such a scope, so neither the manifest load nor
// the layout rejects them. A scope that is not a semantic-model scope gives
// none, since each command reports that itself.
function semanticLayoutOf(snapshot: kcmd.CatalogSnapshot):
    SemanticModelLayout|undefined {
  if (snapshot.manifest.source.type === Sources.SEMANTIC_MODEL) {
    return snapshot.layout as SemanticModelLayout;
  }
  if (snapshot.manifest.source.type === Sources.CONTEXT_SET) {
    return (snapshot.layout as SplitLayout).semantic;
  }
  return undefined;
}

function legacyProfileFormErrors(snapshot: kcmd.CatalogSnapshot): string[] {
  const layout = semanticLayoutOf(snapshot);
  if (!layout) return [];
  const errors: string[] = [];
  // The manifest load drops a key its schema does not have, so the key is
  // read from the file. The load has parsed the file as a mapping already.
  const manifest = yaml.parse(
      fs.readFileSync(path.join(snapshot.basePath, 'catalog.yaml'), 'utf8'));
  if ('default_profile' in manifest) {
    errors.push(
        `'default_profile' in catalog.yaml is no longer supported; specify ` +
        `'profile:' on each entry under 'deployments:' in your model YAML.`);
  }
  for (const dir of layout.legacyProfileDirs()) {
    errors.push(
        legacyProfileDirError(path.basename(dir).slice(0, -'.profiles'.length)));
  }
  for (const orphan of layout.orphanProfilePaths()) {
    const file = path.basename(orphan);
    const model = file.slice(0, file.indexOf('.profile.'));
    errors.push(`Profile file '${file}' has no '${model}.yaml' beside it.`);
  }
  return errors;
}

// Gives a model's profile files as layout.profileDocuments does, each with
// the file name push gives it (see fileNameOf).
type ProfileDocs = (model: string) =>
    Array<ReturnType<SemanticModelLayout['profileDocuments']>[number]&
          {fileName: string}>;

// Reads a model's profile files on the first call for that model and returns
// them again on later calls. A command makes one reader, so it reads each
// profile file once.
function profileDocsReader(layout: SemanticModelLayout): ProfileDocs {
  const read = new Map<string, ReturnType<ProfileDocs>>();
  return model => {
    if (!read.has(model)) {
      read.set(model, layout.profileDocuments(model).map(p => ({
        ...p,
        fileName: fileNameOf(layout, model, p.path),
      })));
    }
    return read.get(model)!;
  };
}

// The dialects sourceDialects reads for the model documents `docs` and their
// profile files, for every load the command makes, and what the import the
// advice to add a BigQuery text suggests gives for each document that may get
// it (see transpileOutcomes). `layout` gives each document's model file.
// Prints each source whose dialect cannot be read and returns null.
async function dialectLoad(
    ctx: context.ApiContext, docs: Array<{name: string; text: string}>,
    profileDocs: ProfileDocs,
    layout: SemanticModelLayout): Promise<DialectLoad|null> {
  const texts = docs.map(d => d.text);
  for (const doc of docs) {
    try {
      texts.push(...profileDocs(doc.name).map(p => p.text));
    } catch {
      // A profile file the layout rejects is reported where it is read.
    }
  }
  const read = await readDialects(ctx, texts);
  if (read.errors.length) {
    for (const e of read.errors) console.error(`Error: ${e}`);
    return null;
  }
  const load = {sourceDialects: read.dialects, sourceDatabases: read.databases};
  return {
    ...load,
    transpileOutcomes:
        await transpileOutcomes(ctx, docs, profileDocs, layout, load, read),
  };
}

// The model `doc` holds, loaded with `load`, when `kcmd import --transpile`
// gives a BigQuery text to one of its fields or metrics or to a field one of
// its profiles binds (see transpilesSomething), or undefined. The caller has
// loaded the SQL parser, which the translator needs.
function transpilingModel(
    doc: {name: string; text: string}, profileDocs: ProfileDocs,
    load: DialectLoad): SemanticModel|undefined {
  let model: SemanticModel|undefined;
  try {
    model = loadModels(doc.text, {bindingOptional: true, ...load}).models[0];
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
  }
  if (!model) return undefined;
  let files: Array<{name: string; text: string}> = [];
  try {
    files = profileDocs(doc.name);
  } catch {
    // A profile file the layout rejects is reported where it is read.
  }
  const profiles = [
    ...model.profiles ?? [],
    ...files.flatMap(f => {
      try {
        return [loadProfileFile(f.text, f.name, {skipActions: true})];
      } catch (err) {
        if (!(err instanceof SemanticModelError)) throw err;
        return [];
      }
    }),
  ];
  return transpilesSomething(model, profiles) ? model : undefined;
}

// What transpileOutcomes gives for each model document of the semantic-model
// scope or context set `snapshot`, or undefined for another scope. The import
// reads each table's dialect as `kcmd import` does, so a table whose dialect
// cannot be read gives the error or warning the import gives.
async function scopeTranspileOutcomes(
    ctx: context.ApiContext,
    snapshot: kcmd.CatalogSnapshot): Promise<Map<string, string|null>|undefined> {
  const layout = semanticLayoutOf(snapshot);
  if (!layout) return undefined;
  const profileDocs = profileDocsReader(layout);
  await loadSqlEngine();
  // Only a document that may get the advice needs its tables' dialects.
  const docs = layout.modelDocuments().filter(
      doc => transpilingModel(doc, profileDocs, {}));
  if (!docs.length) return undefined;
  const texts = docs.map(d => d.text);
  for (const doc of docs) {
    try {
      texts.push(...profileDocs(doc.name).map(p => p.text));
    } catch {
      // A profile file the layout rejects is reported where it is read.
    }
  }
  const read = await readDialects(ctx, texts);
  return transpileOutcomes(
      ctx, docs, profileDocs, layout,
      {sourceDialects: read.dialects, sourceDatabases: read.databases}, read);
}

// What `kcmd import <model file> --input first-party --flavor <its flavor>
// --transpile` gives, run in place and writing nothing, for each of `docs`
// that may get the advice to add a BigQuery text: null when it would write
// its files, or the first error it would stop on. The import reads each
// table's dialect from `dialects`, read with `load` for the same files, and
// calls services with `ctx`. The caller has loaded the SQL parser.
//
// `pull` is set for pull's run, which reads the files in the entry group of
// `layout` as the pull leaves them. That run names the entry group directory
// in --out, which skips the checks of where the files go. Pull makes those
// checks itself. It reads no table's dialect, so its checks read an ANSI_SQL
// text as pull's own checks do (see DialectLoad.readWithoutDialect).
async function transpileOutcomes(
    ctx: context.ApiContext, docs: Array<{name: string; text: string}>,
    profileDocs: ProfileDocs, layout: SemanticModelLayout, load: DialectLoad,
    dialects: SourceDialects,
    pull = false): Promise<Map<string, string|null>> {
  const outcomes = new Map<string, string|null>();
  for (const doc of docs) {
    const model = transpilingModel(doc, profileDocs, load);
    if (!model) continue;
    const plan = await planImport(
        layout.modelPath(doc.name), {
          flavor: model.version === OSSIE_VERSION ? 'ossie' : 'google',
          input: 'first-party',
          transpile: true,
          ...pull ? {out: path.dirname(layout.modelPath(doc.name))} : {},
        },
        {
          readDialects: async () => dialects,
          api: () => ctx,
          readWithoutDialect: pull,
          files: layout.files,
        });
    outcomes.set(doc.name, 'errors' in plan ? plan.errors[0] ?? null : null);
  }
  return outcomes;
}

// The dialect of each source the files `texts` write, read with the clients
// push uses. Push, kcmd profiles and kcmd import all read dialects this way.
function readDialects(ctx: context.ApiContext, texts: string[]) {
  return sourceDialects(
      texts, new dataplex.CatalogClient(ctx), {spanner: new SpannerClient(ctx)});
}

// Checks that every source in the inline bindings and named profiles of
// `models` names a table with a Knowledge Catalog entry (see
// sourceEntryErrors), and gives one message for each binding whose table has
// none, and one for each profile whose BigQuery and BigLake tables share no
// location. With --skip-source-check, says so and checks nothing.
async function sourceCheckErrors(
    models: LoadedModel[], ctx: context.ApiContext,
    options: PushOptions): Promise<string[]> {
  if (options.skipSourceCheck) {
    console.log('Skipping the source check (--skip-source-check).');
    return [];
  }
  const readers = {
    catalog: new dataplex.CatalogClient(ctx),
    bigquery: new BigQueryClient(ctx),
    biglake: new BigLakeClient(ctx),
    spanner: new SpannerClient(ctx),
  };
  return (await Promise.all(
              models.map(({model}) => sourceEntryErrors(model, readers))))
      .flat();
}

// Reads a model document's declared profiles on the first call for that
// document and returns them again on later calls. Throws when its profile
// files or the profiles in its GOOGLE blocks cannot be read.
function declaredProfilesReader(profileDocs: ProfileDocs): DeclaredProfiles {
  const read = new Map<string, DeclaredProfile[]>();
  return doc => {
    if (!read.has(doc.name)) {
      read.set(doc.name, declaredProfiles(doc, profileDocs(doc.name)));
    }
    return read.get(doc.name)!;
  };
}

// The error naming the file at `localPath` when it is not valid UTF-8, or
// undefined when it is. A file read as UTF-8 has each invalid byte replaced by
// U+FFFD, which the catalog would store and the next pull would write into the
// file, so only a text holding U+FFFD needs its bytes checked, which it reads
// with `files`.
function checkUtf8(
    localPath: string, fileName: string, text: string,
    files = diskFiles): string|undefined {
  if (!text.includes('\uFFFD')) return undefined;
  try {
    new TextDecoder('utf-8', {fatal: true}).decode(files.read(localPath));
    return undefined;
  } catch {
    return `File '${fileName}' is not valid UTF-8; save it as UTF-8.`;
  }
}

// What checkCatalogAspects reports for a push of `models` to `source` with the
// overview sidecars `overviews`.
function catalogAspects(
    models: LoadedModel[], source: SemanticModelSource,
    overviews?: ReadonlyMap<string, OverviewSidecar>):
    {error?: string; warnings: string[]} {
  return kc.checkCatalogAspects(models, {
    project: source.project,
    location: source.location,
    entryGroup: source.entryGroup,
    systemTypeProject: process.env.KC_TYPE_PROJECT,
    overviews,
  });
}

const EG_DESCRIPTION_MAX_CHARS = 1024;
const EG_DISPLAY_NAME_MAX_CHARS = 500;

function extractOkfRootMetadata(
  basePath: string,
  project: string,
  location: string,
  groupId: string,
): {displayName?: string; description?: string; overviewContent?: string} {
  const manifestPath = path.join(basePath, 'catalog.yaml');
  const rawManifest = fs.existsSync(manifestPath)
    ? (yaml.parse(fs.readFileSync(manifestPath, 'utf8')) ?? {})
    : {};
  let displayName =
    typeof rawManifest.displayName === 'string' && rawManifest.displayName.trim()
      ? rawManifest.displayName.trim()
      : undefined;
  let description =
    typeof rawManifest.description === 'string' && rawManifest.description.trim()
      ? rawManifest.description.trim()
      : undefined;
  let overviewContent: string | undefined;

  const bundleRoot = path.join(basePath, 'bundle');
  const candidates = [
    path.join(bundleRoot, `${groupId}_entry.md`),
    path.join(bundleRoot, groupId, project, location, `${groupId}_entry.md`),
    path.join(bundleRoot, 'agents.md'),
    path.join(bundleRoot, groupId, project, location, 'agents.md'),
    path.join(bundleRoot, 'index.md'),
  ];
  for (const cand of candidates) {
    if (!fs.existsSync(cand)) continue;
    try {
      const concept = fileContentToConcept(
        fs.readFileSync(cand, 'utf8'),
        path.basename(cand, '.md'),
      );
      const fmTitle =
        typeof concept.frontmatter['title'] === 'string'
          ? concept.frontmatter['title'].trim()
          : '';
      const fmDesc =
        typeof concept.frontmatter['description'] === 'string'
          ? concept.frontmatter['description'].trim()
          : '';
      const bodyClean = concept.body
        .replace(/\n*##\s+OKF\s+Metadata\b[\s\S]*$/i, '')
        .trim();
      const h1Match = bodyClean.match(/^#\s+(.+?)\s*$/m);
      const headingTitle = h1Match?.[1]?.trim() ?? '';
      const firstPara = bodyClean
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .find((p) => p && !/^([#*|-]|\d+\.)/.test(p));
      if (!displayName && (fmTitle || headingTitle)) {
        displayName = fmTitle || headingTitle;
      }
      if (!description && (fmDesc || firstPara)) {
        description = (fmDesc || firstPara || '').replace(/\s+/g, ' ').trim();
      }
      if (!overviewContent && bodyClean) {
        overviewContent = bodyClean;
      }
    } catch {
      // Ignore unparseable candidate here; CatalogSync reports concept errors.
    }
  }
  if (displayName) {
    displayName = displayName.slice(0, EG_DISPLAY_NAME_MAX_CHARS);
  }
  if (description) {
    description = description.slice(0, EG_DESCRIPTION_MAX_CHARS);
  }
  return {displayName, description, overviewContent};
}

async function publishContextSetOverview(
  catalog: dataplex.CatalogClient,
  ctx: context.ApiContext,
  project: string,
  location: string,
  groupId: string,
  overviewContent: string,
  createdEg = false,
): Promise<{written: boolean; entries: string[]; lastStatus?: string}> {
  let pnum: string | undefined;
  try {
    pnum = await crm.projectNumber(project, ctx);
  } catch {
    // Fall back to `<groupId>_entry` when project number lookup fails.
  }
  const repCandidates: string[] = [];
  if (pnum) {
    repCandidates.push(
      `projects/${project}/locations/${location}/entryGroups/@dataplex/entries/` +
        `projects/${pnum}/locations/${location}/entryGroups/${groupId}`,
    );
  }
  repCandidates.push(
    `projects/${project}/locations/${location}/entryGroups/${groupId}/entries/${groupId}_entry`,
  );
  const ovKey = 'dataplex-types.global.overview';
  const maxAttempts = createdEg ? 5 : 2;
  let lastStatus: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    for (const repName of repCandidates) {
      let res: {status: number; message?: string};
      try {
        res = await catalog.updateEntry(
          {
            name: repName,
            entryType:
              'projects/dataplex-types/locations/global/entryTypes/entrygroup',
            aspects: {
              [ovKey]: {
                data: {
                  content: overviewContent,
                  contentType: 'MARKDOWN',
                },
              },
            },
          },
          ['aspects'],
          [ovKey],
        );
      } catch (err: any) {
        lastStatus = String(err?.message || err);
        continue;
      }
      if (res.status === 200) {
        return {written: true, entries: repCandidates};
      }
      lastStatus = res.message
        ? `${res.status} (${res.message})`
        : `${res.status}`;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  return {written: false, entries: repCandidates, lastStatus};
}

// The error for each flag `options` carries that push no longer takes, naming
// what replaces it where something does. cac gives `--no-profile` and
// `--no-kc` as false, and a numeric profile name as a number. main.ts passes a
// bare `--profile` as an empty string, since cac gives it the true an absent
// one has.
function retiredPushFlagErrors(options: PushOptions): string[] {
  const retired = (flag: string, instead = '') =>
      `'${flag}' is no longer supported on 'kcmd push'${instead}.`;
  const refused: Array<[boolean, string]> = [
    [
      !!options.transpile,
      retired(
          '--transpile',
          `; use '${importCommand('--transpile')}' to translate SQL dialects ` +
              `when importing a model, in the model and each profile whose ` +
              `tables are all in BigQuery or BigLake`),
    ],
    [
      options.profile !== undefined && typeof options.profile !== 'boolean',
      retired(
          '--profile',
          `; declare a deployment with 'profile: ${
              String(options.profile) || '<profile>'}' under ` +
              `'deployments:' and run 'kcmd push --deployment <name>'`),
    ],
    [
      !!options.allProfiles,
      retired(
          '--all-profiles',
          `; 'kcmd push' deploys all entries under 'deployments:' by default`),
    ],
    [
      options.profile === false,
      retired(
          '--no-profile',
          `; use '--no-deployment' to skip database deployments or ` +
              `'--deployment <name>' to select one`),
    ],
    [!!options.emitExpressions, retired('--emit-expressions')],
    [
      options.kc === false,
      retired(
          '--no-kc',
          `; every push publishes the model to Knowledge Catalog`),
    ],
  ];
  return refused.filter(([set]) => set).map(([, error]) => error);
}

export async function push(options: PushOptions): Promise<number> {
  if (options.dryRun) options = {...options, validateOnly: true};
  const okf = okfWorkspace();

  const refused = retiredPushFlagErrors(options);
  if (refused.length) return printErrors(...refused);
  let propagationTimeoutMs: number|undefined;
  if (options.propagationTimeout !== undefined) {
    const raw = String(options.propagationTimeout).trim();
    const secs = raw === '' || typeof options.propagationTimeout === 'boolean' ?
        NaN :
        Number(options.propagationTimeout);
    if (!Number.isFinite(secs) || secs < 0) {
      return printErrors(
          `'--propagation-timeout' must be a non-negative number of seconds.`);
    }
    propagationTimeoutMs = Math.round(secs * 1000);
  }
  ensureManifestExists('.');
  const ctx = context.ApiContext.default();

  if (okf) {
    let snapshot: kcmd.CatalogSnapshot;
    let createdEg = false;
    try {
      snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
    } catch (err: any) {
      const msg = String(err?.message || err);
      const rawScope = fs.existsSync('catalog.yaml')
        ? yaml.parse(fs.readFileSync('catalog.yaml', 'utf8'))?.scope
        : undefined;
      const isKb = typeof rawScope === 'string' && rawScope.startsWith(`${Sources.KB}.`);
      const scopeStr =
        typeof rawScope === 'string'
          ? rawScope.replace(/^(entryGroup|kb)\./, '')
          : '';
      const [project, location, groupId] = scopeStr.split('.');
      if (
        !msg.includes('Failed to locate EntryGroup') ||
        !project ||
        !location ||
        !groupId
      ) {
        throw err;
      }
      if (options.validateOnly) {
        const pendingManifest = kcmd.CatalogManifest.forPendingEntryGroup(
          isKb ? Sources.KB : Sources.ENTRYGROUP,
          `${project}.${location}.${groupId}`,
          'okf',
        );
        snapshot = await kcmd.CatalogSnapshot.fromManifest('.', pendingManifest, ctx);
      } else {
        const rootMeta = extractOkfRootMetadata('.', project, location, groupId);
        const created = await dataplex.createContextSet(
          new dataplex.CatalogClient(ctx),
          project,
          location,
          groupId,
          {
            ...(rootMeta.displayName ? {displayName: rootMeta.displayName} : {}),
            ...(rootMeta.description ? {description: rootMeta.description} : {}),
          },
        );
        if (created.error) return printErrors(created.error);
        // A group that already existed (a create race) is reconciled below.
        createdEg = created.created;
        snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
      }
    }

    const {project, location, entryGroup: groupId} = entryGroupCoordinates(
      snapshot.manifest.source,
    );
    const rootMeta = extractOkfRootMetadata(
      snapshot.basePath || '.',
      project,
      location,
      groupId,
    );
    const catalog = new dataplex.CatalogClient(ctx);

    if (
      !options.validateOnly &&
      !createdEg &&
      (rootMeta.displayName || rootMeta.description)
    ) {
      const egRes = await catalog.getEntryGroup(project, location, groupId);
      if (egRes.status === 200 && egRes.result) {
        const patchBody: Record<string, any> = {};
        const updateMask: string[] = [];
        if (
          rootMeta.displayName &&
          egRes.result.displayName !== rootMeta.displayName
        ) {
          patchBody.displayName = rootMeta.displayName;
          updateMask.push('displayName');
        }
        if (
          rootMeta.description &&
          egRes.result.description !== rootMeta.description
        ) {
          patchBody.description = rootMeta.description;
          updateMask.push('description');
        }
        if (updateMask.length) {
          const patchRes = await catalog.updateEntryGroup(
            project,
            location,
            groupId,
            patchBody,
            updateMask,
          );
          if (
            patchRes.status === 200 &&
            patchRes.result?.name?.includes('/operations/')
          ) {
            await catalog.awaitOperation(patchRes.result, 'updateEntryGroup');
          }
        }
      }
    }

    const sync = new kcmd.CatalogSync(catalog, snapshot);
    const result = await sync.push({
      force: options.force,
      validateOnly: options.validateOnly,
      ...(propagationTimeoutMs !== undefined ? {propagationTimeoutMs} : {}),
    });
    if (!result.success) {
      if (result.details) console.error(`Error: ${result.details}`);
      return 1;
    }

    if (!options.validateOnly && rootMeta.overviewContent) {
      const ov = await publishContextSetOverview(
          catalog, ctx, project, location, groupId, rootMeta.overviewContent,
          createdEg);
      if (!ov.written) {
        console.warn(
            `Warning: could not update context set overview on ` +
            `${ov.entries.map(e => `'${e}'`).join(' or ')} ` +
            `(last status: ${ov.lastStatus ?? 'unknown'}).`);
      }
    }
    return 0;
  }

  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
  if (options.force) console.warn('Warning: --force has no effect.');

  const contextSet = snapshot.manifest.source.type === Sources.CONTEXT_SET;
  if (snapshot.manifest.source.type === Sources.SEMANTIC_MODEL || contextSet) {
    const legacy = legacyProfileFormErrors(snapshot);
    if (legacy.length) return printErrors(...legacy);
    const layout = semanticLayoutOf(snapshot)!;
    const source = snapshot.manifest.source as SemanticModelSource;
    const layoutDocs = layout.modelDocuments();
    const profileDocs = profileDocsReader(layout);
    // Reading a GOOGLE block profile checks its field bindings for SQL, which
    // needs the SQL parser.
    if (!await sqlParserReady()) return 1;
    // In a context-set workspace that has no model YAML (unless --deployment
    // was explicitly requested), skip the semantic-model push leg and proceed
    // directly to the OKF bundle leg.
    if (!contextSet || layoutDocs.length > 0 ||
        deploymentFlags(options.deployment).named) {
      const code = await pushInTwoPhases(
          options, {ctx, layout, source, docs: layoutDocs, profileDocs});
      if (code !== 0 || !contextSet) return code;
    }
    const catalog = new dataplex.CatalogClient(ctx);
    const sync = new kcmd.CatalogSync(catalog, snapshot);
    const result = await sync.push({
      force: options.force,
      validateOnly: options.validateOnly,
      ...(propagationTimeoutMs !== undefined ? {propagationTimeoutMs} : {}),
    });
    if (!result.success) {
      if (result.details) console.error(`Error: ${result.details}`);
      return 1;
    }
    const rootMeta = extractOkfRootMetadata(
        snapshot.basePath || '.', source.project, source.location,
        source.entryGroup);
    if (!options.validateOnly && rootMeta.overviewContent) {
      const ov = await publishContextSetOverview(
          catalog, ctx, source.project, source.location, source.entryGroup,
          rootMeta.overviewContent);
      if (!ov.written) {
        console.warn(
            `Warning: could not update context set overview on ` +
            `${ov.entries.map(e => `'${e}'`).join(' or ')} ` +
            `(last status: ${ov.lastStatus ?? 'unknown'}).`);
      }
    }
    return 0;
  }

  // These flags only take effect on a semantic-model push; on a regular
  // catalog snapshot they are inert. Warn rather than silently ignore them, so
  // a user who expected (say) --deployment to apply isn't misled by a clean
  // exit.
  const {named, negated} = deploymentFlags(options.deployment);
  const semanticOnlyFlags: Array<[boolean, string]> = [
    [!!options.print, '--print'],
    [!!options.forceRemove, '--force-remove'],
    [!!options.skipSourceCheck, '--skip-source-check'],
    [named, '--deployment'],
    [negated, '--no-deployment'],
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


// Which of `--deployment` and `--no-deployment` the push options carry.
function deploymentFlags(deployment: PushOptions['deployment']):
    {named: boolean; negated: boolean} {
  if (deployment === undefined || deployment === true) {
    return {named: false, negated: false};
  }
  const given = [deployment].flat();
  return {named: given.some(v => v !== false), negated: given.includes(false)};
}

// The `deployment` option as typed before `--` in `args`, since cac turns a
// value that looks like a number into a number and drops `--deployment`
// before `--no-deployment`. It is false for `--no-deployment` alone and true
// for neither flag.
export function typedDeployment(args: string[]): PushOptions['deployment'] {
  const typed: Array<string|boolean> = [];
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    // cac reads `-no-deployment` as `--no-deployment` too.
    if (/^-+no-deployment$/.test(args[i])) typed.push(false);
    if (args[i] === '--deployment') {
      const next = args[i + 1] ?? '-';
      typed.push(next.startsWith('-') ? true : next);
    } else if (args[i].startsWith('--deployment=')) {
      typed.push(args[i].slice('--deployment='.length));
    }
  }
  return deploymentFlags(typed).named ? typed : !typed.length;
}

// What the two-phase path reads: the scope and its model documents.
interface TwoPhaseScope {
  ctx: context.ApiContext;
  layout: SemanticModelLayout;
  source: SemanticModelSource;
  docs: {name: string; text: string}[];
  profileDocs: ProfileDocs;
  load: DialectLoad;
}

// Runs checkBeforeWrites and the checks that call a service, then publishes to
// Knowledge Catalog and deploys each selected deployment in order with its
// own model. Returns a process exit code.
async function pushInTwoPhases(
    options: PushOptions, scope: Omit<TwoPhaseScope, 'load'>): Promise<number> {
  const {ctx, source} = scope;
  const fail = printErrors;
  const {named, negated} = deploymentFlags(options.deployment);
  if (named && negated) {
    return fail('Cannot combine --no-deployment with --deployment.');
  }
  const load =
      await dialectLoad(ctx, scope.docs, scope.profileDocs, scope.layout);
  if (!load) return 1;
  const checked = await checkBeforeWrites(options, {...scope, load});
  if ('errors' in checked) return fail(...checked.errors.map(e => e.error));
  const {plans, kcModels, leftOut, overviews} = checked;
  const sourceErrors = await sourceCheckErrors(kcModels, ctx, options);
  if (sourceErrors.length) return fail(...sourceErrors);
  const kcOptions = catalogDeployOptions(options, source, overviews);
  const preflight =
      await kc.preflightKnowledgeCatalog(kcModels, ctx, kcOptions);
  const preflightWarnings =
      preflight.prepared?.warnings ?? preflight.result?.warnings ?? [];
  for (const w of preflightWarnings) console.warn(`Warning: ${w}`);
  if (preflight.result && !preflight.result.success) {
    return reportCatalogResult(preflight.result, options);
  }
  // The local checks and the catalog preflight have passed, so what pruning
  // leaves out is worth reading now.
  for (const line of leftOut) console.warn(line);
  const locationWarnings: string[] = [];
  let errors: string[] = [];
  for (const plan of plans) {
    errors = await liveErrors(
        plan, ctx, source.project ?? ctx.project, locationWarnings);
    if (errors.length) break;
  }
  // Every warning about a graph prints before the first write, and phase 2
  // does not print it again.
  const printed = new Set(locationWarnings);
  for (const w of printed) console.warn(`Warning: ${w}`);
  if (errors.length) {
    // A warning about a generated graph can explain why a check fails.
    for (const w of new Set(plans.flatMap(p => p.generated?.warnings ?? []))) {
      console.warn(`Warning: ${w}`);
    }
    return fail(...errors);
  }
  const header = (d: ResolvedDeployment) => {
    if (plans.length > 1) console.log(`\n-- Deployment '${d.name}' --`);
  };
  if (options.validateOnly) {
    // A header prints only above a graph's warnings or, under --print, its
    // DDL.
    for (const {deployment, generated} of plans) {
      if (!generated) continue;
      if (!options.print && !generated.warnings.length) continue;
      header(deployment);
      printGraph(
          deployment.engine === 'bigquery' ? 'BigQuery' : 'Spanner', generated,
          options);
    }
    return reportCatalogResult(preflight.result!, options);
  }
  for (const w of new Set(plans.flatMap(p => p.generated?.warnings ?? []))) {
    console.warn(`Warning: ${w}`);
    printed.add(w);
  }
  console.log('Pushing semantic model (Knowledge Catalog)...');
  const published =
      await kc.applyKnowledgeCatalog(preflight.prepared!, ctx, kcOptions);
  const publishedCode = reportCatalogResult(published, options);
  if (publishedCode !== 0) return publishedCode;
  for (const {deployment, model} of plans) {
    header(deployment);
    if (deployment.engine === 'alloydb') {
      console.warn(
          `Note: deployment '${deployment.name}' targets an AlloyDB ` +
          `database, which has no property graph, so push deploys no graph ` +
          `there. The model runs against that database as published to ` +
          `Knowledge Catalog.`);
      continue;
    }
    const code = deployment.engine === 'bigquery' ?
        await pushBigQuery([model], ctx, options, printed) :
        await pushSpanner([model], ctx, options, printed);
    if (code !== 0) {
      console.error(
          `Knowledge Catalog already holds the new model, but deployment '${
              deployment.name}' did not deploy its graph. Fix the cause and ` +
          `push again to finish the deploy.`);
      return code;
    }
  }
  return 0;
}

// The local checks of a two-phase push, which call no service: it stops at
// the first check that fails, and returns each selected deployment's plan, the
// models the catalog receives, the overview sidecars it writes and what
// pruning leaves out, or the errors that stop it. With
// `quiet`, for the `kcmd profiles` report, it prints no warning.
async function checkBeforeWrites(
    options: PushOptions, scope: TwoPhaseScope, quiet = false): Promise<{
  plans: DeploymentPlan[]; kcModels: LoadedModel[]; leftOut: string[];
  overviews?: Map<string, OverviewSidecar>;
}|{errors: LocalCheckError[]}> {
  const {layout, source, docs, profileDocs, load} = scope;
  const stop = (errors: LocalCheckError[]) => ({errors});
  const fail = (...errors: string[]) => stop(errors.map(error => ({error})));
  // Prints each warning once.
  const printed = new Set<string>();
  const warn = (w: string) => {
    if (quiet || printed.has(w)) return;
    printed.add(w);
    console.warn(`Warning: ${w}`);
  };

  let selected: string[]|undefined;
  try {
    selected = parseDeploymentSelection(options.deployment);
  } catch (err: any) {
    return fail(err.message || String(err));
  }
  const noDeployment = deploymentFlags(options.deployment).negated;

  // A model file may leave every source to its profile files, so a source is
  // required only once a deployment's profile is applied. The checks below
  // reject a field its table cannot run, so the load warns about it only on a
  // table of the preferred dialect.
  const loaded = loadSemanticModels(
      docs, {bindingOptional: true, ...load, fieldTextChecked: true});
  if (loaded.error) return fail(loaded.error);
  for (const w of loaded.warnings) warn(w);
  if (selected && !loaded.models.length) {
    return fail(
        `--deployment names ${selected.map(n => `'${n}'`).join(', ')}, but ` +
        `the scope has no model.`);
  }
  if (loaded.models.length > 1) {
    return fail(kc.oneModelPerEntryGroupMessage(
        source.entryGroup, loaded.models.length));
  }
  const models: LoadedModel[] = [];
  for (const base of loaded.models) {
    const model = withProfileFiles(base, profileDocs);
    if ('errors' in model) return stop(model.errors);
    models.push(model);
    // The model file and each profile file must be valid UTF-8, and YAML must
    // read each action statement in them as it is written.
    // withProfileFiles has read the profile files, so profileDocs does not
    // throw here.
    const modelPath = layout.modelPath(base.document);
    const modelFile = {
      path: modelPath,
      fileName: fileNameOf(layout, base.document, modelPath),
      text: docs.find(d => d.name === base.document)!.text,
    };
    for (const file of [modelFile, ...profileDocs(base.document)]) {
      const error =
          checkUtf8(file.path, file.fileName, file.text, layout.files);
      if (error) return fail(error);
    }
    const changed =
        yamlChangedStatementErrors(base, modelFile.text, profileDocs, load);
    if (changed.length) return fail(...changed);
  }
  // The catalog writes each overview sidecar, which must be valid UTF-8 too.
  let overviews: Map<string, OverviewSidecar>|undefined;
  if (docs.length === 1) {
    const local = layout.overviewSidecarPaths();
    try {
      for (const {path: sidecar} of local) {
        const error = checkUtf8(
            sidecar, fileNameOf(layout, docs[0].name, sidecar),
            layout.files.read(sidecar).toString('utf8'), layout.files);
        if (error) return fail(error);
      }
      overviews = layout.overviewSidecars(local);
    } catch (err: any) {
      return fail(err.message);
    }
  }

  const declaredBy = declaredProfilesReader(profileDocs);
  const checked = await localChecks(
      {docs, loaded, models, profileDocs, declaredBy, load}, warn,
      noDeployment ? [] : selected);
  if ('errors' in checked) return checked;
  // What pruning leaves out of each deployment's model.
  const leftOut = checked.plans.flatMap(pruningLines);
  return {plans: checked.plans, kcModels: models, leftOut, overviews};
}

// The errors of one deployment's live checks, which change nothing. They read
// the BigQuery dataset or the Spanner database and instance, probe each
// BigQuery source and dry-run the BigQuery DDL in the dataset's location,
// check the Spanner graph against the database's schema, and check each
// action's DML. A dataset whose location cannot be read, or an instance whose
// edition cannot be read, adds a warning to `warnings`.
async function liveErrors(
    plan: DeploymentPlan, ctx: context.ApiContext, defaultProject: string,
    warnings: string[]): Promise<string[]> {
  const {deployment, at, model} = plan;
  if (deployment.engine === 'spanner') {
    const spanner = new SpannerClient(ctx);
    const {project, instance, database} = deployment.coordinates;
    const found = await spanner.getDatabase(project, instance, database);
    const name = `${project}/${instance}/${database}`;
    if (found.status === 404) return [`${at}: database ${name} not found`];
    if (found.status !== 200) {
      return [`${at}: database ${name} could not be read: ${
          storeMessage(found.message, found.status)}`];
    }
    // Spanner Graph needs an Enterprise or Enterprise Plus edition instance, so
    // push refuses an instance whose edition is STANDARD. Under
    // --skip-source-check, push warns and skips this check when it cannot read
    // the instance.
    const read = await spanner.getInstance(project, instance);
    if (read.status !== 200) {
      warnings.push(
          `could not read the edition of instance ${project}/${instance} (${
              read.message || read.status}); Spanner Graph needs ` +
          `an Enterprise or Enterprise Plus edition instance`);
    }
    if (read.status === 200 && read.result?.edition === 'STANDARD') {
      return [
        `${at}: instance ${project}/${instance} is a Standard edition ` +
        `instance, and Spanner Graph needs an Enterprise or Enterprise Plus ` +
        `edition instance. Upgrade the instance (gcloud spanner instances ` +
        `update ${instance} --edition=ENTERPRISE --project=${project}). To ` +
        `publish the model to Knowledge Catalog without this graph, leave ` +
        `the deployment out with --deployment or --no-deployment, or remove ` +
        `it.`,
      ];
    }
    const graphErrors = await validateSpannerGraph(
        at, model.model, deployment.coordinates, spanner);
    if (graphErrors.length) return graphErrors;
    return validateSpannerActionStatements([model], spanner);
  }
  if (deployment.engine !== 'bigquery') return [];
  const bq = new BigQueryClient(ctx);
  const {project, dataset} = deployment.coordinates;
  let location: string|undefined;
  try {
    location =
        await deploy.datasetLocation(bq, deployment.coordinates, warnings);
  } catch (err: any) {
    return [`${at}: ${err.message}`];
  }
  const graph =
      location ? {at, dataset: `${project}.${dataset}`, location} : undefined;
  const accessErrors =
      await validateBigQueryDataSources([model], bq, defaultProject, graph);
  if (accessErrors.length) return accessErrors;
  for (const ddl of plan.generated?.ddl ?? []) {
    const res = await bq.query(project, ddl, location, true);
    if (res.status !== 200) {
      return [`${at}: the graph's DDL fails a BigQuery dry run: ${
          storeMessage(res.message, res.status)}`];
    }
  }
  return validateBigQueryActionStatements([model], bq, defaultProject);
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
async function printStore(
    options: ProfilesOptions, ctx: context.ApiContext,
    snapshot: kcmd.CatalogSnapshot): Promise<number> {
  const named =
      typeof options.profile === 'string' ? options.profile : undefined;

  // One line, because the caller is `STORE=$(kcmd profiles --print-store)` and
  // a second line makes that variable address the wrong database. A scope
  // holding several models has no single answer, so it says so instead,
  // before any AlloyDB lookup. A scope that push refuses for its named
  // profiles gets push's errors, also before any AlloyDB lookup.
  let refused: string[] = [];
  // The advice to add a BigQuery text names what the import it suggests
  // gives, as push's does.
  const transpileOutcomes = await scopeTranspileOutcomes(ctx, snapshot);
  const opened = await createSemanticRuntimes({
    profile: named,
    ctx,
    oneModel: true,
    snapshot,
    transpileOutcomes,
    proceed: async () => {
      const layout = semanticLayoutOf(snapshot)!;
      const docs = layout.modelDocuments();
      const profileDocs = profileDocsReader(layout);
      // The check reads each source's dialect as push does. When a read
      // fails, the check skips the dialect rules for that source, so a script
      // can still get the store of a database it has not created yet. An
      // entry that reads but gives no dialect or names no table gets push's
      // error.
      const read = await readDialects(ctx, [
        ...docs.map(d => d.text),
        ...docs.flatMap(d => profileDocs(d.name).map(p => p.text)),
      ]);
      refused = read.errors.filter(e => !read.unread.includes(e));
      if (refused.length) return false;
      const load = {
        sourceDialects: read.dialects,
        sourceDatabases: read.databases,
        transpileOutcomes,
      };
      const {models} =
          loadSemanticModels(docs, {bindingOptional: true, ...load});
      // Push refuses several models, or a deployment target in no accepted
      // form, before it checks the named profiles. The runtime refuses both.
      if (models.length > 1 ||
          models.some(m => 'error' in resolveModelDeployments(m.model))) {
        return true;
      }
      refused = namedProfileErrors(
                    docs, new Map(models.map(m => [m.document, m.model])),
                    profileDocs, declaredProfilesReader(profileDocs), [], load)
                    .map(e => e.error);
      return !refused.length;
    },
  });
  if ('error' in opened) {
    console.error(`Error: ${opened.error}`);
    return 1;
  }
  if (refused.length) return printErrors(...refused);
  for (const {store, storeError} of opened) {
    // A store error may hold several of push's errors, one to a line.
    if (!store) return printErrors(...String(storeError).split('\n'));
    console.log(storeLine(store));
  }
  return 0;
}


// Prints a profile's report under its header: the deployment target, the
// source each entity binds to, and what the profile cannot answer or cannot
// run.
function printProfileReport(model: SemanticModel, name: string): void {
  // The targets the profile's deployments name, as --print-store reads them.
  const targets = profileTargets(model, name);
  // Pruned for the graphs this profile's own deployments name.
  const {report} = pruneUnavailable(
      model, name,
      pruningDialect({...model, deployments: unnamedDeployments(targets)}));
  console.log(`    target: ${
      targets.length ? targets.join(', ') :
                       '(none; no deployment names this profile)'}`);
  console.log('    sources:');
  // No profile binds an abstract entity, since it has no table.
  for (const e of (model.entities ?? []).filter(e => !e.abstract)) {
    console.log(`      ${e.name} -> ${writtenSource(e) || '(unbound)'}`);
  }

  const withheld: string[] = [];
  const excluded = new Set(report.excludedFields);
  for (const f of report.unboundFields) {
    withheld.push(`field ${f} (${excluded.has(f) ? 'excluded' : 'unbound'})`);
  }
  for (const d of report.droppedFields) {
    withheld.push(`field ${d.name} (${d.reason})`);
  }
  for (const d of report.droppedMetrics) {
    withheld.push(`metric ${d.name} (${d.reason})`);
  }
  for (const w of report.warnings) {
    console.warn(`  profile '${name}': warning: ${w}`);
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


// Lists a semantic model's binding profiles and, per profile, its resolved
// deployment target and sources plus what it cannot answer (the availability
// report), then each error a plain `kcmd push` gives that belongs to it.
// Read-only: it applies and prunes each profile and runs push's local checks
// the way push does, but deploys nothing, so a user can see coverage and
// whether push accepts a profile before a deployment names it. Its only
// service calls are push's source dialect lookups. Returns a process exit code
// (0 on success).
export async function profiles(options: ProfilesOptions = {}): Promise<number> {
  ensureManifestExists('.');
  const ctx = context.ApiContext.default();
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
  const legacy = legacyProfileFormErrors(snapshot);
  if (legacy.length) return printErrors(...legacy);
  if (options.printStore) return await printStore(options, ctx, snapshot);

  // `--profile` narrows the report to one profile; anything that is not a name
  // (a bare `--profile`, `--no-profile`) narrows nothing, the same read every
  // other command does.
  const only =
      typeof options.profile === 'string' ? options.profile : undefined;

  const layout = semanticLayoutOf(snapshot);
  if (!layout) {
    console.error(
        'Error: `kcmd profiles` applies only to a semantic-model scope.');
    return 1;
  }
  const source = snapshot.manifest.source as SemanticModelSource;
  if (!await sqlParserReady()) return 1;

  const docs = layout.modelDocuments();
  if (!docs.length) {
    console.log('No semantic model documents found.');
    return 0;
  }

  // Set when `--profile` names something no model declares, so a typo exits
  // non-zero rather than reporting an empty scope as a clean one.
  let missing = false;
  // Set when push would reject a binding, so a script can tell.
  let failed = false;
  // Prints push's errors under a heading at `indent`, the indent of the lines
  // that describe what push rejects. An error's later lines are indented one
  // step further than its first.
  const printRejects = (indent: string, errors: string[]) => {
    if (!errors.length) return;
    console.error(`${indent}push rejects:`);
    for (const e of errors) {
      const [first, ...rest] = e.split('\n');
      console.error(`${indent}  ${first}`);
      for (const line of rest) console.error(`${indent}    ${line}`);
    }
    failed = true;
  };
  const profileDocs = profileDocsReader(layout);
  const declaredBy = declaredProfilesReader(profileDocs);
  // Source dialects are looked up once, as push does.
  const load = await dialectLoad(ctx, docs, profileDocs, layout);
  if (!load) return 1;
  // The inline bindings' header. 'default' is not a profile document and
  // never can be -- a push rejects a file by that name. It names the inline
  // bindings, which every model has.
  const inlineHeader =
      `  profile '${DEFAULT_PROFILE}': the model document's own inline ` +
      `bindings, as authored -- nothing merged, nothing withheld.`;
  // Prints the warnings push gives about the model file's own bindings in
  // `doc`, unless the model file does not load on its own.
  const warnInline = (doc: {name: string; text: string}, named: boolean) => {
    const loaded = loadSemanticModels([doc], {bindingOptional: true});
    if (loaded.error) return;
    for (const w of inlineBindingWarnings(
             loaded.models[0].model, doc.name, named)) {
      console.warn(`  profile '${DEFAULT_PROFILE}': warning: ${w}`);
    }
  };

  // The errors of a plain push's local checks, each reported under the model
  // and profile it belongs to.
  const checked = await checkBeforeWrites(
      {}, {ctx, layout, source, docs, profileDocs, load}, true);
  const pushErrors = 'errors' in checked ? checked.errors : [];
  // Push prints the emitter's warnings and checks every aspect's size once the
  // local checks pass, before any write.
  if ('kcModels' in checked) {
    const {error, warnings} =
        catalogAspects(checked.kcModels, source, checked.overviews);
    for (const w of warnings) console.warn(`Warning: ${w}`);
    if (error) pushErrors.push({error, document: checked.kcModels[0].document});
  }
  const pushErrorsWhere = (belongs: (e: LocalCheckError) => boolean) =>
      [...new Set(pushErrors.filter(belongs).map(e => e.error))];
  // Reads every model's profiles. When that fails after push stopped at
  // another error, prints that push's errors instead.
  for (const doc of docs) {
    try {
      declaredBy(doc);
    } catch (err: any) {
      const stopped = pushErrorsWhere(() => true);
      if (stopped.length && !stopped.includes(err.message)) {
        printRejects('', stopped);
        return 1;
      }
      if (!(err instanceof SemanticModelError)) throw err;
      console.error(`Error: ${err.message}`);
      return 1;
    }
  }
  // The push errors that belong to `document` and `profile`. With neither,
  // those of the whole push.
  const pushErrorsOf = (document?: string, profile?: string) =>
      pushErrorsWhere(e => e.document === document && e.profile === profile);
  printRejects('', pushErrorsOf());

  for (const doc of docs) {
    console.log(`Model '${doc.name}' (${source.entryGroup}):`);
    const modelProfiles = declaredBy(doc);
    // The errors printed above this model's profiles: those of the model and,
    // in a report narrowed to one profile, those of the other profiles, since
    // any of them stops the push.
    printRejects('  ', pushErrorsWhere(
        e => e.document === doc.name &&
            (e.profile === undefined ||
             (only !== undefined && e.profile !== only))));
    // Push deploys no profile under that name, so it is neither merged nor
    // listed.
    const declared =
        modelProfiles.filter(p => p.name.toLowerCase() !== DEFAULT_PROFILE);
    // 'default' is the one profile name that is always right. Reported here
    // rather than falling into the typo check below, which would call a
    // universally valid name undeclared.
    if (only === DEFAULT_PROFILE) {
      console.log(inlineHeader);
      warnInline(doc, declared.length > 0);
      printRejects('    ', pushErrorsOf(doc.name, DEFAULT_PROFILE));
      continue;
    }
    const available = only ? declared.filter(p => p.name === only) : declared;
    // Naming a profile the model does not declare is a typo, not an empty
    // report: saying nothing would read as "this profile withholds nothing".
    // Checked before the inline-binding line below, because a model that
    // declares no profile documents still has to call a typo a typo -- saying
    // "no binding profiles" and exiting 0 answers a question nobody asked.
    if (only && !available.length) {
      // A profile file under the reserved name is reported above, as push
      // reports it.
      if (modelProfiles.some(p => p.name === only)) continue;
      console.error(
          `  no profile '${only}'; this model declares ` +
          (declared.length ?
               `${declared.map(p => `'${p.name}'`).join(', ')}.` :
               `none, and its inline bindings are its 'default'.`));
      missing = true;
      continue;
    }
    if (!modelProfiles.length) {
      console.log(
          `  no binding profiles; the model document is its own inline ` +
          `'default' binding.`);
      warnInline(doc, declared.length > 0);
      printRejects('    ', pushErrorsOf(doc.name, DEFAULT_PROFILE));
      continue;
    }
    for (const {name} of available) {
      const res = profileForDocument(doc, available, name, load);
      // Narrows the type; `name` comes from `available`, so it is found.
      if (res.kind === 'missing') continue;
      // Push applies the profile only for the deployments that use it.
      const errors = pushErrorsOf(doc.name, name);
      let model: SemanticModel|undefined;
      // Why the profile does not apply, when it does not.
      let applyError: string|undefined;
      // Push publishes the profile without its actions, so a profile whose
      // actions do not apply still gives the warnings of what it publishes.
      // Like push, it prints none of them for a profile with an error of its
      // own in the local checks. Push still prints them when an error names no
      // profile, or when its source check later rejects the profile.
      const published = errors.length ? undefined :
          res.kind === 'error' ?
          profileForDocument(doc, available, name, load, {skipActions: true}) :
          res;
      if (res.kind === 'error') {
        applyError =
            profileErrorMessage(doc.name, res, name, profileDocs(doc.name));
      } else {
        model = res.model;
      }
      console.log(`  profile '${name}'`);
      // The warnings print under the profile they belong to.
      if (published?.kind === 'file') {
        for (const w of published.warnings) {
          console.warn(`  profile '${name}': warning: ${w}`);
        }
      }
      if (model) {
        printProfileReport(model, name);
      } else if (applyError !== undefined && !pushErrors.length) {
        // Push accepts a profile it does not apply, such as one no deployment
        // uses. When push gives no error, say why nothing is shown.
        const [first, ...rest] = applyError.split('\n');
        console.log(`    not shown: ${first}`);
        for (const line of rest) console.log(`      ${line}`);
      }
      printRejects('    ', errors);
    }
    // A deployment that names no profile deploys the inline bindings. They
    // are reported when push rejects them.
    if (!only) {
      const errors = pushErrorsOf(doc.name, DEFAULT_PROFILE);
      if (errors.length) console.log(inlineHeader);
      warnInline(doc, declared.length > 0);
      printRejects('    ', errors);
    }
  }
  return missing || failed ? 1 : 0;
}


// Loads the SQL parser the semantic-model checks read expressions with. Prints
// why when it cannot, and returns false.
async function sqlParserReady(): Promise<boolean> {
  const error = await sqlParserError();
  if (error) console.error(`Error: ${error}`);
  return !error;
}

// Loads the SQL parser, and returns why it cannot be loaded, or undefined
// when it loads.
async function sqlParserError(): Promise<string|undefined> {
  try {
    await loadSqlEngine();
    return undefined;
  } catch (err: any) {
    return `the SQL parser could not be loaded: ${err.message || err}`;
  }
}


// Prints a graph leg's warnings, less those in `printed`, and under --print
// its DDL.
function printGraph(
    engine: 'BigQuery'|'Spanner', result: {warnings: string[]; ddl: string[]},
    options: PushOptions, printed?: ReadonlySet<string>): void {
  for (const w of result.warnings) {
    if (!printed?.has(w)) console.warn(`Warning: ${w}`);
  }
  if (!options.print) return;
  console.log(`-- ${engine} Graph --`);
  for (const block of result.ddl) console.log(`${block}\n`);
}


// Deploys the semantic model's BigQuery Graph leg (over the pre-loaded models)
// and prints the result. Returns a process exit code (0 on success).
async function pushBigQuery(
    models: LoadedModel[], ctx: context.ApiContext, options: PushOptions,
    printed?: ReadonlySet<string>): Promise<number> {
  console.log(
      options.validateOnly ? 'Validating semantic model for BigQuery Graph...' :
                             'Pushing semantic model (BigQuery Graph)...');
  const result = await deploy.deployBigQuery(models, ctx, options);
  printGraph('BigQuery', result, options, printed);

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
    models: LoadedModel[], ctx: context.ApiContext, options: PushOptions,
    printed?: ReadonlySet<string>): Promise<number> {
  console.log(
      options.validateOnly ? 'Validating semantic model for Spanner Graph...' :
                             'Pushing semantic model (Spanner Graph)...');
  const result = await deploySpannerLeg.deploySpanner(models, ctx, options);
  printGraph('Spanner', result, options, printed);

  if (!result.success) {
    console.error('Error pushing semantic model to Spanner:', result.details);
    return 1;
  }
  console.log(
      options.validateOnly ? 'Validation complete; no changes applied.' :
                             `Deployed ${result.deployed} Spanner Graph(s).`);
  return 0;
}


// The options the Knowledge Catalog leg takes from the push `options`, the
// scope `source` and the overview sidecars push writes.
function catalogDeployOptions(
    options: PushOptions, source: SemanticModelSource,
    overviews?: ReadonlyMap<string, OverviewSidecar>): kc.KcDeployOptions {
  return {
    project: source.project,
    location: source.location,
    entryGroup: source.entryGroup,
    validateOnly: options.validateOnly,
    forceRemove: options.forceRemove,
    // The semantic-* system types live in `dataplex-types/global` on prod.
    // Override via KC_TYPE_PROJECT to reference them from another project
    // (e.g. `dataplex-autopush-types` on the autopush/sandbox EAP).
    systemTypeProject: process.env.KC_TYPE_PROJECT,
    overviews,
  };
}

// Prints the result of the Knowledge Catalog leg: the plan under --print, then
// why it failed or what it wrote. Returns a process exit code (0 on success).
function reportCatalogResult(
    result: kc.KcDeployResult, options: PushOptions): number {
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
  // The relationships of an ordered entity pair share one link, so the count
  // is of links. Links push found unchanged got no request and are counted
  // apart.
  const plural = result.linked === 1 ? '' : 's';
  const unchanged =
      result.unchangedLinks ? ` (${result.unchangedLinks} unchanged)` : '';
  const linked = result.linked || result.unchangedLinks ?
      `; wrote ${result.linked} entry link${plural}${unchanged}` :
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
// unless --force-remove authorizes deleting the stale local model first. The
// model, rebuilt from the second-generation types, is written as its model
// file, profile files and overview sidecars. A model an older kcmd pushed
// with the first-generation types is left out with a warning, and nothing
// is written. Returns a process exit code (0 on success).
async function pullSemanticModel(
    ctx: context.ApiContext, snapshot: kcmd.CatalogSnapshot,
    options: PullOptions,
    modelLayout?: SemanticModelLayout): Promise<number> {
  // The semantic-model source always resolves to the SemanticModel layout
  // (see createLayout), and a context-set passes split.semantic explicitly.
  const layout = modelLayout ?? (snapshot.layout as SemanticModelLayout);
  const source = snapshot.manifest.source as SemanticModelSource;

  console.log(
      options.dryRun ?
          'Reconstructing semantic model from Knowledge Catalog (dry run)...' :
          'Pulling semantic model from Knowledge Catalog...');

  const catalog = new dataplex.CatalogClient(ctx);
  const result = await pullKc.pullKnowledgeCatalog(catalog, {
    project: source.project,
    location: source.location,
    entryGroup: source.entryGroup,
  });

  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }

  if (!result.models.length) {
    console.log(
        result.firstGeneration ? 'Wrote nothing.' :
                                 'No semantic models found; nothing to pull.');
    return 0;
  }

  const pulled = result.models[0];
  const {files: pulledFiles, warnings} = pulledModelFiles(layout, pulled);
  const sidecars = [...(result.overviews ?? [])].map(([id, sidecar]) => {
    const fileName = `${id}.overview.md`;
    return {
      fileName,
      content: keptSidecar(layout, pulled.name, fileName, sidecar) ??
          formatOverviewSidecar(sidecar),
    };
  });

  // Reconcile the local layout with the catalog. A local document whose name
  // differs from the pulled model would leave the entry group with two models,
  // so pull refuses by default; --force-remove deletes the stale local
  // document(s) before the catalog's is written.
  const catalogNames = new Set(result.models.map(m => m.name));
  // Compare the local model file, by its name on disk, with the path each
  // catalog model name maps to: a catalog model 'a/b' and a local 'a_b.yaml'
  // are the same model, and a local 'a\b.yaml' is another file.
  const catalogPaths =
      new Set(result.models.map(m => layout.modelPath(m.name)));
  const staleLocal = layout.modelDocuments()
                         .map(d => d.name)
                         .filter(n => !catalogPaths.has(layout.modelFile(n)));
  // Each file of a stale local model that pull removes.
  const removed: string[] = [];
  if (staleLocal.length) {
    // A local model's files, the model file first, as the layout lists them.
    // --force-remove deletes these files for a stale model, and the advice
    // below names the same files.
    const localFiles = (name: string) => layout.modelFiles(name);
    if (!options.forceRemove) {
      // A file that holds the catalog's model under another file name is
      // kept by renaming it and its profile files to the files pull writes.
      // Each refusal offers choices, and following one choice of each
      // refusal ends with a pull that succeeds. The first file that holds a
      // model is told to keep it, by deleting the files in the way and one
      // of each two files of one profile, then renaming the rest. A file is
      // told to delete its own files when another model file is refused too.
      // --force-remove is named with every file it deletes.
      const groupDir = path.dirname(layout.modelPath(staleLocal[0]));
      // The names in the entry group directory as they are on disk.
      const present = new Set(fs.readdirSync(groupDir));
      // The file at `name` in the entry group directory, by its name on disk:
      // `name`, or on a case-insensitive file system, as on macOS and Windows,
      // the name that differs from it only in case.
      const onDisk = (name: string) => present.has(name) ? name :
          fs.existsSync(path.join(groupDir, name)) ?
          [...present].find(n => n.toLowerCase() === name.toLowerCase()) :
          undefined;
      // A file by its path in the entry group directory.
      const shown = (p: string) => path.relative(groupDir, p);
      const file = (name: string) => shown(layout.modelPath(name));
      // The model file of the local model `name`, as it is named on disk.
      const localFile = (name: string) => shown(localFiles(name)[0].path);
      const quoted = (names: string[]) => listed(names.map(n => `'${n}'`))!;
      // Every file --force-remove deletes: each stale model's files, then each
      // local profile file of the catalog's model and each overview sidecar
      // that this pull leaves out.
      const left = unwrittenFiles(
                       layout, pulled.name,
                       [...pulledFiles, ...sidecars].map(f => f.fileName))
                       .flatMap(f => f.outside ? [] : [shown(f.path)]);
      const deletedFiles = [
        ...staleLocal.flatMap(n => localFiles(n).map(f => shown(f.path))),
        ...left,
      ];
      const forceRemove = (them: string) =>
          `re-run with --force-remove to delete ${them} and pull the catalog's`;
      // `choices` as the sentence that ends a refusal.
      const offer = (choices: string[]) => {
        const text = choices.join(', or ');
        return `${text[0].toUpperCase()}${text.slice(1)}.`;
      };
      const errors: string[] = [];
      const othersFiles: string[] = [];
      const others: string[] = [];
      // Each model a refusal tells a file to keep, and that file.
      const kept = new Map<string, string>();
      for (const name of staleLocal) {
        const declared = layout.declaredModelName(name);
        if (declared !== undefined &&
            catalogPaths.has(layout.modelPath(declared))) {
          const files = localFiles(name);
          const own = files.map(f => shown(f.path));
          const stem = file(declared).replace(/\.yaml$/, '');
          // The file pull writes for each of `files`. A profile file with
          // no valid profile name has none, so it is deleted.
          const targets = files.map(
              (f, i) => i === 0 ? file(declared) :
                  f.profileName === undefined ?
                                  undefined :
                                  `${stem}.profile.${f.profileName}.yaml`);
          const unnamed = own.filter((_, i) => targets[i] === undefined);
          // The files renamed to each file pull writes, by its index in
          // `files`. Two files hold one profile when a sibling profile file
          // and a file in the older directory have the same profile name.
          const groups = [...new Set(targets)].flatMap(
              t => t === undefined ?
                  [] :
                  [files.flatMap((_, i) => targets[i] === t ? [i] : [])]);
          const twice = groups.filter(g => g.length > 1);
          // Each other file at a name pull writes.
          const taken = [...new Set(targets.flatMap(t => {
            const there = t === undefined ? undefined : onDisk(t);
            return there === undefined || own.includes(there) ? [] : [there];
          }))];
          // The catalog's model file when it holds this model too, else the
          // file a refusal before this one tells to keep it.
          const holder = layout.declaredModelName(stem) === declared ?
              stem :
              kept.get(declared);
          // What stops the rename, or else where it goes.
          const where = holder !== undefined ?
              `, which '${localFile(holder)}' also holds` :
              taken.length ?
              `, which pull writes as '${file(declared)}', and ${
                  quoted(taken)} ${taken.length > 1 ? 'are' : 'is'} already ` +
                  'there' :
              twice.length ? '' :
                             `, which pull writes as '${file(declared)}'`;
          // Only the file told to keep the model is told about a profile in
          // both forms.
          const keeps = !kept.has(declared);
          const facts = where + (keeps ? twice : []).map(
              g => `, and its profile '${files[g[0]].profileName}' is in ` +
                  `both ${quoted(g.map(i => own[i]))}`).join('');
          const them = files.length > 1 ? 'them' : 'it';
          const choices: string[] = [];
          let renamesOnly = false;
          if (keeps) {
            kept.set(declared, name);
            // The files in the way: the model file pull writes, with its
            // profile files, and each other file at a name pull writes.
            const inTheWay = [...new Set([
              ...present.has(file(declared)) ?
                  localFiles(stem).map(f => shown(f.path)) :
                  [],
              ...taken,
            ])];
            const deletes = [
              ...[...inTheWay, ...unnamed].map(f => `'${f}'`),
              ...twice.map(g => `one of ${quoted(g.map(i => own[i]))}`),
            ];
            // A plain rename keeps its short form, which names the model
            // file as "the file".
            renamesOnly = !deletes.length;
            const renames = groups.map(g => {
              const to = `'${targets[g[0]]}'`;
              if (g.length > 1) {
                return `the other${
                    twice.length > 1 ?
                        ` of ${quoted(g.map(i => own[i]))}` :
                        ''} to ${to}`;
              }
              return g[0] === 0 && renamesOnly ? `the file to ${to}` :
                                                 `'${own[g[0]]}' to ${to}`;
            });
            choices.push(
                (deletes.length ? `delete ${listed(deletes)} and rename ` :
                                  'rename ') +
                `${listed(renames)} to keep ${them}`);
          }
          if (staleLocal.length > 1) choices.push(`delete ${quoted(own)}`);
          choices.push(forceRemove(
              renamesOnly && deletedFiles.length === own.length ?
                  them :
                  quoted(deletedFiles)));
          errors.push(
              `local model file '${localFile(name)}' holds model '${declared}'${
                  facts}. ${offer(choices)}`);
        } else {
          othersFiles.push(...localFiles(name).map(f => shown(f.path)));
          others.push(
              declared === undefined || declared === name ?
                  `'${name}'` :
                  `'${declared}' in '${localFile(name)}'`);
        }
      }
      if (others.length) {
        const localList = others.join(', ');
        const catalogList = [...catalogNames].map(n => `'${n}'`).join(', ');
        errors.push(
            `local model(s) ${localList} do not match the catalog model ${
                catalogList} in this entry group. An entry group holds ` +
            `one model, so pull will not leave two behind. ${offer([
              ...others.length < staleLocal.length ?
                  [`delete ${quoted(othersFiles)}`] :
                  [],
              forceRemove(quoted(deletedFiles)),
            ])}`);
      }
      return printErrors(...errors);
    }
    for (const name of staleLocal) {
      // Its profile files go too, since push refuses a profile file with no
      // model beside it.
      const paths = localFiles(name).map(f => f.path);
      if (!options.dryRun) {
        layout.removeModelDocument(name);
        for (const p of paths.slice(1)) layout.removeFile(p);
      }
      for (const p of paths) {
        console.log(`  ${options.dryRun ? 'would remove' : 'removed'} ${p}`);
      }
      removed.push(...paths);
    }
  }

  for (const w of warnings) console.warn(`Warning: [${pulled.name}] ${w}`);
  const updated = updatedFiles(layout, source, pulled.name, pulledFiles);
  updated.push(...sidecars);
  const code =
      writePulledFiles(layout, pulled.name, updated, options, removed.length);
  // Push's checks read the files the entry group holds after the pull. Under
  // --dry-run those on disk are not the ones pull leaves, so the checks read
  // the text pull writes for each file it writes, find no file it deletes,
  // and read every other file on disk. Pull writes no file that a link puts
  // outside the entry group directory.
  const groupDir = path.dirname(layout.modelPath(pulled.name));
  const fileNames = updated.map(f => f.fileName);
  const written = new Map(updated.flatMap(({fileName, content}) => {
    const target = pulledFileTarget(layout, pulled.name, fileName, true);
    return target && !layout.outsideGroup(target.path, true) ?
        [[path.resolve(target.path), content] as const] :
        [];
  }));
  const deleted = [
    ...removed,
    ...options.forceRemove ?
        unwrittenFiles(layout, pulled.name, fileNames)
            .flatMap(f => f.outside ? [] : [f.path]) :
        [],
  ];
  const after = new SemanticModelLayout(
      path.join(groupDir, '..', '..'), path.basename(groupDir),
      options.dryRun ? filesAfter(written, deleted) : undefined);
  await after.init();
  const refusal = await pushRefusal(ctx, after, source);
  if (refusal) {
    const file = path.join(groupDir, refusal.file);
    const writes = written.has(path.resolve(file));
    // An error of several lines ends the warning at its last line.
    const error = refusal.error.trimEnd();
    console.warn(
        `Warning: push refuses ${file} as pull ${
            writes ? 'writes' : 'leaves'} it: ${
            /[.!?]$/.test(error) ? error : `${error}.`}`);
  }
  return code;
}


// Push's first error for the model, profile and overview sidecar files in the
// entry group of `layout`, with the name push gives the file it is in, or
// undefined when push accepts them. It runs push's checks of those files that
// call no service, as push runs them, the size of each aspect the catalog
// stores included. It reads no table's SQL
// dialect, since that calls a service, so only push runs the checks that need
// one. Where no table's dialect is known, it reads an ANSI_SQL text as generic
// SQL for the checks of which fields and entities an expression reads, and
// skips each name whose reading depends on the dialect. It refuses an
// action's SQL statement only when every dialect refuses it. Like push, it
// runs the import that the advice to add a BigQuery text suggests, writing
// nothing, and that import reads no table's dialect either. The caller has
// loaded the SQL parser.
async function pushRefusal(
    ctx: context.ApiContext, layout: SemanticModelLayout,
    source: SemanticModelSource):
    Promise<{error: string; file: string}|undefined> {
  const docs = layout.modelDocuments();
  const profileDocs = profileDocsReader(layout);
  const noDialects: SourceDialects =
      {dialects: new Map(), databases: new Map(), errors: [], unread: []};
  const load = {
    readWithoutDialect: true,
    transpileOutcomes: await transpileOutcomes(
        ctx, docs, profileDocs, layout, {}, noDialects, true),
  };
  const checked = await checkBeforeWrites(
      {}, {ctx, layout, source, docs, profileDocs, load}, true);
  let first = 'errors' in checked ? checked.errors[0] : undefined;
  // Once those pass, push checks the size of each aspect the catalog stores.
  if ('kcModels' in checked) {
    const {error} = catalogAspects(checked.kcModels, source, checked.overviews);
    if (error) first = {error, document: checked.kcModels[0]?.document};
  }
  if (!first) return undefined;
  // The error is in the file a label in it names, when push reads that file:
  // a leading `[<file>] ...` or `<Kind> '<file>' ...`, matched against the
  // files push reads so a quote in a file's name does not end it, or the
  // `(<file>)` after the model's name in `... in model '<name>' (<file>)`,
  // which names a profile file there. An entry's overview aspect too large to
  // store is in that entry's overview sidecar, when push reads one. A
  // file-system error, such as ENOENT or EACCES, is in the file at the path
  // it quotes, when that path is in the entry group directory. For any other
  // error with no such label, the file is that of the named profile push
  // reports the error under, as for a deployment that uses the profile, when
  // push reads one, and else the model file.
  const name = (p: string) => fileNameOf(layout, docs[0].name, p);
  const sidecars = layout.overviewSidecarPaths();
  const files = [
    ...docs.flatMap(
        d => [layout.modelPath(d.name), ...layout.profileFilePaths(d.name)]),
    ...sidecars.map(s => s.path),
  ].map(name);
  const kind = /^[A-Z][a-z]*(?: [a-z]+)* '/.exec(first.error)?.[0];
  const leads = (f: string) => [f, f.split('/').join(path.sep)].some(
      n => first.error.startsWith(`[${n}]`) ||
          kind !== undefined && first.error.startsWith(`${kind}${n}'`));
  const label = files.filter(leads).sort((a, b) => b.length - a.length)[0];
  const inModel = / in model '[^']*' \(([^)]+)\)/.exec(first.error);
  const overviewOf = /^aspect '[^'@]*\.overview(?:@[^']*)?' of entry '([^']+)'/
                         .exec(first.error)?.[1];
  const sidecar = sidecars.find(s => s.entryId === overviewOf);
  const doc = docs.find(d => d.name === first.document) ?? docs[0];
  const profileFile =
      first.profile === undefined || first.profile === DEFAULT_PROFILE ?
      undefined :
      `${doc.name}.profile.${first.profile}.yaml`;
  const quoted = /^E[A-Z]+: [^,]*, \w+ '(.*)'$/s.exec(first.error)?.[1];
  const failed = quoted === undefined ? undefined : name(quoted);
  const failedInGroup = failed !== undefined && !path.isAbsolute(failed) &&
      failed.split('/')[0] !== '..';
  const named = [
    label, inModel?.[1], sidecar && name(sidecar.path), profileFile,
  ].map(n => n?.split(path.sep).join('/'))
      .find(n => n !== undefined && files.includes(n));
  return {
    error: first.error,
    file: (failedInGroup ? failed : named) ?? name(layout.modelPath(doc.name)),
  };
}


// The text of the local overview sidecar `fileName` of `model` when push
// would read it into `sidecar`, the overview the catalog holds, so pull keeps
// its bytes, whatever its line endings and trailing blank lines. Undefined
// when the file does not exist, is not valid UTF-8 or does not parse.
function keptSidecar(
    layout: SemanticModelLayout, model: string, fileName: string,
    sidecar: OverviewSidecar): string|undefined {
  const target = pulledFileTarget(layout, model, fileName, true);
  if (!target || !fs.existsSync(target.path)) return undefined;
  const text = fs.readFileSync(target.path, 'utf8');
  if (checkUtf8(target.path, fileName, text)) return undefined;
  try {
    return sameOverview(parseOverviewSidecar(text, fileName), sidecar) ?
        text :
        undefined;
  } catch {
    return undefined;
  }
}


// The model and profile files pull writes for `pulled`. The catalog stores no
// profile's actions, so a profile file keeps the actions it binds locally. A
// vanilla model declares no action. A profile that excludes every metric
// names them all, in name order, when its local `metrics_exclude` is a list,
// and is "*" otherwise.
function pulledModelFiles(layout: SemanticModelLayout, pulled: SemanticModel) {
  const vanilla = pulled.version === OSSIE_VERSION;
  const locals = localProfiles(layout, pulled.name, vanilla);
  const model = {
    ...pulled,
    profiles: pulled.profiles?.map(p => {
      const local = locals.get(p.name);
      const actions = vanilla ? undefined : local?.actions;
      const named = p.metricsExclude === '*' &&
          Array.isArray(local?.metricsExclude);
      return {
        ...p,
        ...(actions ? {actions} : {}),
        ...(named ? {metricsExclude: pulled.metrics.map(m => m.name)} : {}),
      };
    }),
  };
  return serializeModelFiles(model, {logical: true});
}


// The model and profile files pull writes for `model`. `files` holds what
// pull built from the catalog. A local file is changed only where its content
// differs from the catalog's (see pull_update.ts), so one that holds the
// catalog's content keeps its bytes. The model file is read on its own. Each
// profile file is read on its own too, since pull builds each profile file
// from that profile alone, and is checked alone against the layout's file
// rules: beside the catalog's model file, which is the model file pull
// leaves, or else beside the local model file, as when the catalog's model no
// longer has an entity the profile file binds. Either way, a changed profile
// file must hold the catalog's content beside the catalog's model file. A file
// is written as pull built it, with a warning, when the local file does not
// load or names another model, and when the changed local file would not hold
// what the catalog holds. One that is not valid UTF-8, which push refuses, is
// written that way too, with a warning.
function updatedFiles(
    layout: SemanticModelLayout, source: SemanticModelSource, model: string,
    files: SerializedFile[]): SerializedFile[] {
  const doc = layout.modelDocuments().find(
      d => layout.modelFile(d.name) === layout.modelPath(model));
  if (!doc) return files;
  const modelFile = `${model}.yaml`;
  // Pull's text for each file, for the model file `text` and the profile
  // files `profiles` gives, or why they do not load, or the other model they
  // name.
  const texts = (text: string, profiles: ProfileDocs):
      Map<string, string>|{error: string}|{named: string} => {
    const form = catalogForm({name: doc.name, text}, profiles, source);
    if ('error' in form) return form;
    if (form.model.name !== model) return {named: form.model.name};
    return new Map(pulledModelFiles(layout, form.model)
                       .files.map(f => [f.fileName, f.content]));
  };
  const why = (read: {error: string}|{named: string}) => 'error' in read ?
      `does not load, so pull writes it from the catalog: ${read.error}` :
      `names model '${read.named}', so pull writes it from the catalog.`;
  // `file` with its content in the local file at `localPath`, which holds
  // `text`, when `base`, pull's text for that file, differs from the
  // catalog's only where the local file changes. `read` gives pull's text for
  // each file with a text in place of the local file, and the changed text
  // is kept only when pull's text for the file is then the catalog's.
  // `fromCatalog` says whether `base` was read beside the catalog's model
  // file. Only then does a `base` that is the catalog's text keep the local
  // file without that check.
  const update = (
      file: SerializedFile, localPath: string, text: string, base: string,
      read: (text: string) => ReturnType<typeof texts>, fromCatalog = true) => {
    if (checkUtf8(localPath, file.fileName, text)) {
      console.warn(
          `Warning: ${localPath} is not valid UTF-8, so pull writes it from ` +
          'the catalog.');
      return file;
    }
    if (base === file.content && fromCatalog) return {...file, content: text};
    // When a GOOGLE block's `data` that keeps its layout would not read as
    // the catalog's content, the file is changed with that `data` as the
    // catalog holds it.
    for (const content of new Set([true, false].map(
             jsonLayout => updatedText(text, base, file.content, jsonLayout)))) {
      const changed = read(content);
      if (changed instanceof Map &&
          changed.get(file.fileName) === file.content) {
        return {...file, content};
      }
    }
    console.warn(
        `Warning: pull cannot change only the values that differ in ` +
        `${localPath}, so it writes the file from the catalog.`);
    return file;
  };
  const catalogModel = files.find(f => f.fileName === modelFile)!;
  const own = texts(doc.text, () => []);
  const updated = files.map(file => {
    if (file !== catalogModel || !(own instanceof Map)) return file;
    return update(
        file, layout.modelPath(doc.name), doc.text, own.get(modelFile)!,
        text => texts(text, () => []));
  });
  if (!(own instanceof Map)) {
    console.warn(
        `Warning: local model file ${layout.modelPath(doc.name)} ${why(own)}`);
  }
  const siblings = layout.localProfileFiles(doc.name);
  return updated.map(file => {
    const sibling = siblings.find(
        p => fileNameOf(layout, doc.name, p.path) === file.fileName);
    if (!sibling?.profileName) return file;
    const whole = (reason: string) => {
      console.warn(`Warning: local profile file ${sibling.path} ${reason}`);
      return file;
    };
    // Each profile file is checked alone against the layout's file rules, so
    // a YAML error or a wrong `name:` in one does not stop pull from reading
    // the others.
    let local: ReturnType<ProfileDocs>[number];
    try {
      const name = sibling.profileName;
      const text = fs.readFileSync(sibling.path, 'utf8');
      checkProfileFileName(modelFile, file.fileName, name, text, new Map());
      local = {name, text, path: sibling.path, fileName: file.fileName};
    } catch (err: any) {
      return whole(why({error: err.message}));
    }
    const beside = (text: string, profile = local) =>
        texts(text, () => [profile]);
    let base = beside(catalogModel.content);
    const fromCatalog = base instanceof Map;
    if (!(base instanceof Map)) {
      const besideLocal = beside(doc.text);
      // A vanilla local model file gives no profile file.
      if (!(besideLocal instanceof Map) || !besideLocal.has(file.fileName)) {
        return whole(why(base));
      }
      base = besideLocal;
    }
    return update(
        file, local.path, local.text, base.get(file.fileName)!,
        text => beside(catalogModel.content, {...local, text}), fromCatalog);
  });
}


// The local profiles of `model`, by name: those in the GOOGLE block of the
// local model file for a vanilla model, and else each local profile file that
// loads.
function localProfiles(
    layout: SemanticModelLayout, model: string,
    vanilla: boolean): Map<string, ProfileSpec> {
  if (vanilla) {
    const doc = layout.modelDocuments().find(
        d => layout.modelFile(d.name) === layout.modelPath(model));
    const loaded = doc && loadSemanticModels([doc], {bindingOptional: true});
    const profiles = loaded?.models[0]?.model.profiles ?? [];
    return new Map(profiles.map(p => [p.name, p]));
  }
  const out = new Map<string, ProfileSpec>();
  for (const {path: p, profileName: name} of layout.localProfileFiles(model)) {
    if (name === undefined || out.has(name)) continue;
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      // A file pull cannot read, such as a link to no file, binds no
      // actions. Push names it.
      continue;
    }
    try {
      out.set(name, loadProfileFile(text, name));
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
    }
  }
  return out;
}


// Each local profile file of `model` and each overview sidecar that a pull
// writing the files `fileNames` leaves out, and whether a link puts it
// outside the entry group directory, where pull deletes nothing. Pull writes
// each file to the path push reads it from, so such a file is stale.
function unwrittenFiles(
    layout: SemanticModelLayout, model: string, fileNames: string[]):
    Array<
        {path: string; profileName?: string; kind: string; outside: boolean}> {
  const written = writtenPaths(layout, model, fileNames);
  return [
    // The layout lists a linked older profile directory as the link.
    ...layout.localProfileFiles(model).map(f => ({
      ...f,
      kind: f.path.endsWith('.yaml') ? 'profile file' : 'profile directory',
    })),
    ...layout.overviewSidecarPaths().map(
        f => ({path: f.path, kind: 'overview sidecar'})),
  ].filter(f => !written.has(path.resolve(f.path)))
      .map(f => ({...f, outside: layout.outsideGroup(f.path)}));
}


// The resolved path of each of the files `fileNames` of `model` that pull
// writes.
function writtenPaths(
    layout: SemanticModelLayout, model: string,
    fileNames: string[]): Set<string> {
  return new Set(fileNames.flatMap(fileName => {
    const target = pulledFileTarget(layout, model, fileName, true);
    return target ? [path.resolve(target.path)] : [];
  }));
}


// Writes the files a pull rebuilt for `model`, and skips a name push does not
// read and a file that a link puts outside the entry group directory, with a
// warning. Then it names each local profile file and overview sidecar that the
// pull did not write, or deletes it under --force-remove with each directory
// that leaves empty. The summary counts the files it removes, and `removed`
// more that the pull removed before.
function writePulledFiles(
    layout: SemanticModelLayout, model: string, files: SerializedFile[],
    options: PullOptions, removed = 0): number {
  const counts = {created: 0, updated: 0, unchanged: 0, removed};
  for (const {fileName, content} of files) {
    const target = pulledFileTarget(layout, model, fileName, true);
    if (!target) {
      console.warn(
          `Warning: skipped '${fileName}' from the catalog; pull writes only ` +
          `'${model}.yaml', '${model}.profile.<name>.yaml' and overview ` +
          `sidecars inside the entry group directory.`);
      continue;
    }
    const before =
        fs.existsSync(target.path) ? fs.readFileSync(target.path) : undefined;
    const state = !before                   ? 'created' :
        before.equals(Buffer.from(content)) ? 'unchanged' :
                                              'updated';
    if (state !== 'unchanged' && layout.outsideGroup(target.path, true)) {
      console.warn(
          `Warning: pull does not write ${target.path}, because a link puts ` +
          'it outside the entry group directory.');
      continue;
    }
    counts[state]++;
    if (state === 'unchanged') {
      console.log(`  unchanged ${target.path}`);
    } else if (options.dryRun) {
      const verb = state === 'created' ? 'create' : 'update';
      console.log(`  would ${verb} ${target.path}`);
    } else {
      target.write(content);
      console.log(`  ${state} ${target.path}`);
    }
  }

  for (const stale of
           unwrittenFiles(layout, model, files.map(f => f.fileName))) {
    if (stale.outside) {
      console.warn(
          `Warning: pull keeps local ${stale.kind} ${stale.path}, which is ` +
          'not in the catalog, because a link puts it outside the entry ' +
          'group directory.');
    } else if (!options.forceRemove) {
      console.warn(
          `Warning: local ${stale.kind} ${stale.path} is not in the ` +
          `catalog; delete it, or pull with --force-remove to delete it.`);
    } else if (options.dryRun) {
      console.log(`  would remove ${stale.path}`);
      counts.removed++;
    } else {
      layout.removeFile(stale.path);
      console.log(`  removed ${stale.path}`);
      counts.removed++;
    }
  }

  const unchanged = counts.unchanged ? `; ${counts.unchanged} unchanged` : '';
  const gone = counts.removed ?
      `; ${options.dryRun ? 'would remove' : 'removed'} ${counts.removed} ` +
          'file(s)' :
      '';
  console.log(
      options.dryRun ?
          `Dry run: would write ${counts.created} new and ${
              counts.updated} updated file(s)${unchanged}${gone}.` :
          `Wrote ${counts.created} new and ${counts.updated} updated ` +
              `file(s)${unchanged}${gone}.`);
  return 0;
}


// Where pull writes the catalog's file `fileName` of `model`, and how.
// Undefined unless the name is relative, holds no `..` segment or NUL byte, and
// names `<model>.yaml`, `<model>.profile.<name>.yaml` or, with `sidecars`, an
// overview sidecar that push reads: `<model>.overview.md` or
// `<model>/{entities,metrics,relationships}/<name>.overview.md`.
function pulledFileTarget(
    layout: SemanticModelLayout, model: string, fileName: string,
    sidecars: boolean): {path: string; write: (text: string) => void}|
    undefined {
  const sidecar = sidecars && fileName.endsWith('.overview.md');
  if (path.posix.isAbsolute(fileName) || path.win32.isAbsolute(fileName) ||
      fileName.includes('\0') || fileName.split(/[\\/]/).includes('..') ||
      !(fileName.endsWith('.yaml') || sidecar)) {
    return undefined;
  }
  if (fileName === `${model}.yaml`) {
    return {
      path: layout.modelPath(model),
      write: text => layout.writeModelDocument(model, text),
    };
  }
  // A model name holding a path separator maps to a flat model file, and its
  // profile files and sidecars have no such mapping.
  if (/[\\/]/.test(model)) return undefined;
  const localPath = path.join(path.dirname(layout.modelPath(model)), fileName);
  const writeFile = (text: string) => {
    fs.mkdirSync(path.dirname(localPath), {recursive: true});
    fs.writeFileSync(localPath, text);
  };
  if (sidecar) {
    return fileName === `${model}.overview.md` ||
            fileName.startsWith(`${model}/`) &&
                /^(entities|metrics|relationships)\/[^/\\]+\.overview\.md$/
                    .test(fileName.slice(model.length + 1)) ?
        {path: localPath, write: writeFile} :
        undefined;
  }
  if (!fileName.startsWith(`${model}.`)) return undefined;
  const rest = fileName.slice(model.length + 1);
  const profileName = /^profile\.(.+)\.yaml$/.exec(rest)?.[1];
  if (profileName === undefined) return undefined;
  let profilePath: string;
  try {
    // Throws when the name breaks the profile naming rule.
    profilePath = layout.profilePath(model, profileName);
  } catch {
    return undefined;
  }
  return {
    path: profilePath,
    write: text => layout.writeProfileDocument(model, profileName, text),
  };
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

  // Every name the import derives, from the file name and from the ontology,
  // must be one the loader accepts.
  const loaded = loadSemanticModels(
      [{name: modelName, text: result.yaml}], {bindingOptional: true});
  if (loaded.error) {
    console.error(
        `Error: '${file}' converts to a model that does not load: ${
            loaded.error}`);
    return 1;
  }

  // Without --out, the model goes into the scope's entry group, which holds
  // one model. A second model is refused before the summary, as above.
  const layout = options.out ? undefined : await workspaceLayout();
  if (layout && typeof layout !== 'string') {
    const {error} = otherModelFiles(layout, modelName, file);
    if (error) return printErrors(error);
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
  if (!layout) {
    writeFileAt(options.out!, result.yaml);
    writtenPath = options.out!;
  } else if (typeof layout === 'string') {
    return printErrors(layout);
  } else {
    layout.writeModelDocument(modelName, result.yaml);
    writtenPath = layout.modelPath(modelName);
  }

  console.log(`wrote ${writtenPath}`);
  return 0;
}

export interface ImportCommandOptions {
  // Who wrote the file. `third-party` (default): a file another product wrote;
  // import repairs its problems and reports them as warnings. `first-party`: a
  // file written for kcmd; import converts it exactly or fails.
  input?: string;
  // The flavor to write, `ossie` or `google`. Required: the input does not say
  // which flavor its owner wants.
  flavor?: string;
  // The GCP resource name of the database whose tables complete each bare
  // table name, or the name of the Knowledge Catalog entry group whose table
  // entries complete them.
  sourcePrefix?: string;
  // Add a BigQuery translation beside SQL in another dialect.
  transpile?: boolean;
  // A `.yaml` or `.yml` file to write the one output file to, or a directory
  // to write each output file into. Without it, the files go into the
  // workspace's semantic-model layout, as `kcmd owl import` writes.
  out?: string;
}

const IMPORT_INPUTS = ['third-party', 'first-party'];
const IMPORT_FLAVORS = ['ossie', 'google'];
const YAML_FILE = /\.ya?ml$/i;

// Handles `kcmd import <file>`: reads a semantic model file, has the import
// engine repair or convert it to `--flavor`, and writes the files it gives.
// Writes nothing when the engine reports an error. Returns a process exit code.
export async function importModel(
    file: string, options: ImportCommandOptions = {}): Promise<number> {
  // The advice to add a BigQuery text names the first error the import it
  // suggests would stop on: this import again with `--transpile`, of the
  // files this import writes when it writes them over its input, and with
  // `--input first-party` when the advice names that. An import with
  // `--transpile` has given every text it can translate a BigQuery text, so
  // it runs no second import.
  const plan = await planImport(file, options, options.transpile ? {} : {
    transpileOutcome: async (written, firstParty, readDialects, api) => {
      const followed = await planImport(
          file,
          {...options, ...firstParty ? {input: 'first-party'} : {}, transpile: true},
          {source: written, readDialects, api});
      return 'errors' in followed ? followed.errors[0] ?? null : null;
    },
  });
  for (const w of plan.warnings) console.warn(`Warning: ${w}`);
  if ('errors' in plan) return printErrors(...plan.errors);
  for (const {fileName: target, content} of plan.writes) {
    writeFileAt(target, content);
    console.log(`wrote ${target}`);
  }
  return 0;
}

// The input of `kcmd import` held in memory: the text of the model file and
// its profile files.
interface ImportSource {
  text: string;
  profileFiles: SerializedFile[];
}

// What planImport reads, and the import it runs for the advice to add a
// BigQuery text.
interface ImportIo {
  source?: ImportSource;
  // What the import reads its input and the files beside it with, by default
  // the disk.
  files?: LayoutFiles;
  // Set for an import that reads no table's dialect, as pull's run does (see
  // ImportSemanticModelOptions.readWithoutDialect).
  readWithoutDialect?: boolean;
  api?: () => context.ApiContext;
  readDialects?: (texts: string[]) => Promise<SourceDialects>;
  transpileOutcome?:
      (written: ImportSource|undefined, firstParty: boolean,
       readDialects: (texts: string[]) => Promise<SourceDialects>,
       api: () => context.ApiContext) => Promise<string|null>;
}

// The warnings `kcmd import` prints, then the errors it stops on, or each
// file it writes, where.
type ImportPlan = {warnings: string[]; errors: string[]}|
                  {warnings: string[]; writes: SerializedFile[]};

// What `kcmd import <file>` with `options` does, writing nothing: the warnings
// it prints, then the errors it stops on, or each file it writes, where.
// `io.source` reads the input from memory in place of `file`: the text of
// the model file and its profile files. `io.api` gives the context the import
// calls services with, by default one made when first needed. `io.readDialects`
// reads each table's dialect. `io.transpileOutcome` gives the first error the
// import with `--transpile` would stop on, of the input or, given, of the
// file this import writes and the profile files beside it then, and with
// `--input first-party` when `firstParty` is set, for the advice to add a
// BigQuery text.
async function planImport(
    file: string, options: ImportCommandOptions,
    io: ImportIo = {}): Promise<ImportPlan> {
  // One context, made on first use, and each table's dialect read once for
  // the command.
  let ctx: context.ApiContext|undefined;
  const api = io.api ?? (() => ctx ??= context.ApiContext.default());
  let dialectsRead: Promise<SourceDialects>|undefined;
  const once = {
    ...io,
    api,
    readDialects: (texts: string[]) => dialectsRead ??=
        (io.readDialects ?? (t => readDialects(api(), t)))(texts),
  };
  // A third-party import that writes its files over its input names import
  // commands that read the files it writes. It writes over its input only
  // when every file has a place (see placeFiles). An import that stops on an
  // error found after that writes nothing, so it runs again and names
  // commands that read its input.
  let readsWritten = false;
  const plan = await planOneImport(file, options, {
    ...once,
    overwrites: over => {
      readsWritten ||= over;
      return over;
    },
  });
  return 'errors' in plan && readsWritten ?
      planOneImport(file, options, {...once, overwrites: () => false}) :
      plan;
}

// One run of planImport's import. `io.overwrites` is told whether the import
// writes its files with the model file over its input, and gives the answer
// its messages assume.
async function planOneImport(
    file: string, options: ImportCommandOptions,
    io: ImportIo&Required<Pick<ImportIo, 'api'|'readDialects'>>&
    {overwrites: (over: boolean) => boolean}): Promise<ImportPlan> {
  const {api, readDialects: readDialectsOnce} = io;
  const warnings: string[] = [];
  const fail = (...errors: string[]) => ({warnings, errors});
  const {input = 'third-party', flavor} = options;
  if (!flavor) {
    return fail(
        `--flavor is required: name the flavor to write, 'ossie' or 'google'.`);
  }
  if (!IMPORT_FLAVORS.includes(flavor)) {
    return fail(`--flavor '${flavor}' is not a flavor; use 'ossie' or 'google'.`);
  }
  if (!IMPORT_INPUTS.includes(input)) {
    return fail(
        `--input '${input}' is not supported; use 'third-party' or ` +
        `'first-party'.`);
  }
  const files = io.files ?? diskFiles;
  if (!io.source && !files.exists(file)) return fail(`file not found: ${file}`);

  // A Google-flavor model's profiles are its own files beside it, found by
  // the input file's name without `.yaml` or `.yml`, not by the model name
  // inside it. The engine gets every `<name>.profile.*.yaml` there, in the
  // order push checks them, so it reports a file name push refuses.
  const dir = path.dirname(file);
  const stem = path.basename(file).replace(YAML_FILE, '');
  // Push refuses the older `<model>.profiles/` directory, which import does
  // not read.
  if (legacyProfileFiles(dir, stem, files).length) {
    if (input === 'first-party') return fail(legacyProfileDirError(stem));
    warnings.push(legacyProfileDirError(stem));
  }
  const profileFiles = io.source?.profileFiles ??
      profileFileNamesBeside(dir, stem, files)
          .map(f => ({
                 fileName: f,
                 content: files.read(path.join(dir, f)).toString('utf8'),
               }));
  // The workspace's layout, read once, when the files go into it.
  let layoutRead: Promise<SemanticModelLayout|string>|undefined;
  const layoutOf = () => layoutRead ??= workspaceLayout(api);
  // Where the import writes each of `files`, the model file first, or the
  // errors that stop it before it writes any. Every target is found before
  // anything is written, so a file that has none writes nothing.
  const placeFiles = async (files: SerializedFile[]):
      Promise<{targets: string[]}|{errors: string[]}> => {
    let targets: Array<{path: string}|undefined>;
    if (options.out && YAML_FILE.test(options.out)) {
      if (files.length > 1) {
        return {
          errors: [
            `--out '${options.out}' names a file, but the import gives ${
                files.length} files (${
                files.map(f => f.fileName).join(', ')}); name a directory ` +
                `instead.`,
          ],
        };
      }
      targets = [{path: options.out}];
    } else if (options.out) {
      const out = options.out;
      targets = files.map(f => ({path: path.join(out, f.fileName)}));
    } else {
      const layout = await layoutOf();
      if (typeof layout === 'string') return {errors: [layout]};
      // The engine's first file is the model file, `<model>.yaml`; the rest
      // are its profile files, which pull's mapping writes beside it.
      const model = files[0].fileName.replace(YAML_FILE, '');
      targets =
          files.map(f => pulledFileTarget(layout, model, f.fileName, false));
      // The input itself may be in the entry group under another name.
      const {inputThere, error} = otherModelFiles(layout, model, file);
      const refusals = error ? [error] : [];
      if (inputThere) {
        refusals.push(
            `the input file ${file} sits in the entry group, so the import ` +
            `would leave this model in two files there, ${file} and ${
                layout.modelPath(model)}. Move the input${
                profileFiles.length ? ' and its profile files' : ''} out of ` +
            `the entry group and import it from there, or pass --out ` +
            `<path> to write elsewhere.`);
      }
      if (refusals.length) return {errors: refusals};
      // Refuse to leave behind a profile file this import does not write,
      // whatever its profile name. Push rejects one beside a vanilla model,
      // and one whose name breaks its rule, and reads any other beside a
      // Google model as that model's profile. A Google model file re-imported
      // in place with no sibling profile file for the import to write keeps
      // its other ones.
      const inPlace = profileFiles.length === 0 && flavor === 'google' &&
          files.length === 1 &&
          path.resolve(file) === path.resolve(layout.modelPath(model));
      if (!inPlace) {
        const kept = new Set(targets.map(t => t && path.resolve(t.path)));
        const left = layout.profileFilePaths(model).filter(
            p => !kept.has(path.resolve(p)));
        if (left.length) {
          return {
            errors: [
              `the import does not write ${left.join(', ')}, which would ` +
              `stay beside the model; pass --out <path> to write elsewhere, ` +
              `or first remove any the model no longer uses.`,
            ],
          };
        }
      }
    }
    const unplaced = files.filter((_, i) => !targets[i]);
    if (unplaced.length) {
      return {
        errors: unplaced.map(
            f => `the import gives '${f.fileName}', which has no place in ` +
                `the semantic-model layout.`),
      };
    }
    return {targets: targets.map(t => t!.path)};
  };
  // Whether the import writes `files` with the model file over its input. It
  // writes nothing when a file has no place.
  const overwritesInput = async (files: SerializedFile[]) => {
    const placed = await placeFiles(files);
    return 'targets' in placed &&
        path.resolve(placed.targets[0]) === path.resolve(file);
  };
  // The profile files beside the input once the import writes the profile
  // files `written` beside it, each in place of one of the same name.
  const besideWritten = (written: SerializedFile[]) => [
    ...profileFiles.map(f => written.find(w => w.fileName === f.fileName) ?? f),
    ...written.filter(w => !profileFiles.some(f => f.fileName === w.fileName)),
  ];
  const result = await importSemanticModelYaml(
      io.source?.text ?? files.read(file).toString('utf8'), {
        flavor: flavor as 'ossie' | 'google',
        sourcePrefix: options.sourcePrefix,
        transpile: !!options.transpile,
        strict: input === 'first-party',
        profileFiles,
        fileName: path.basename(file),
        // Each is called only when needed: for a --source-prefix that names an
        // entry group, and for files that name a Cloud SQL, Spanner or
        // third-party table. An import that needs neither needs no
        // credentials.
        listEntries: (project, location, entryGroup) =>
            new dataplex.CatalogClient(api()).listEntries(
                project, location, entryGroup),
        readDialects: readDialectsOnce,
        readWithoutDialect: io.readWithoutDialect,
        overwritesInput: async files =>
            io.overwrites(await overwritesInput(files)),
        // The advice names the first error of the import it suggests: this
        // import again with `--transpile`, of the files this import writes
        // when it writes them over its input, and with `--input first-party`
        // when the advice names that. Of the written files, that import reads
        // the profile files beside the model file once this one writes its
        // own.
        ...io.transpileOutcome ?
            {
              transpileOutcome:
                  (files: SerializedFile[], readsWritten: boolean,
                   firstParty: boolean) =>
                      io.transpileOutcome!(
                          readsWritten ? {
                            text: files[0].content,
                            profileFiles: besideWritten(files.slice(1)),
                          } :
                                         undefined,
                          firstParty, readDialectsOnce, api),
            } :
            {},
      });
  warnings.push(...result.warnings);
  if (!result.ok) return fail(...result.errors);
  const placed = await placeFiles(result.files);
  if ('errors' in placed) return fail(...placed.errors);
  return {
    warnings,
    writes: result.files.map(
        (f, i) => ({fileName: placed.targets[i], content: f.content})),
  };
}

// Prints each of `errors` once, as `Error: ...`, and gives exit code 1.
function printErrors(...errors: string[]): number {
  for (const e of new Set(errors)) console.error(`Error: ${e}`);
  return 1;
}

// Writes `text` to `file`, creating its directory.
function writeFileAt(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true});
  fs.writeFileSync(file, text);
}

// The semantic-model layout of the workspace in `.`, where `kcmd owl import`
// and `kcmd import` write without --out, or the error for a workspace that
// has none.
async function workspaceLayout(
    api = () => context.ApiContext.default()):
    Promise<SemanticModelLayout|string> {
  if (!fs.existsSync('catalog.yaml')) {
    return `there is no catalog.yaml in this directory, so there is no model ` +
        `layout to write into. Pass --out <path> to write the file directly.`;
  }
  const notSemantic = `this catalog is not a semantic-model scope, so there ` +
      `is no model layout to write into. Run \`kcmd init --semantic-model ` +
      `...\` first, or pass --out <path> to write the file directly.`;
  // Resolving an entry group, BigQuery or knowledge base scope calls a
  // service, so a catalog.yaml that names one and passes the manifest's
  // checks gets this error first. The manifest reads or reports any other
  // catalog.yaml.
  if (kcmd.serviceScopeType('catalog.yaml')) return notSemantic;
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', api());
  return semanticLayoutOf(snapshot) ?? notSemantic;
}

// Refuses to write `model` into `layout`'s entry group beside another
// model's file, since an entry group holds one model. `inputThere` says
// whether the input file `input` is one of those files. The error leaves it
// out, since kcmd import refuses it on its own.
function otherModelFiles(
    layout: SemanticModelLayout, model: string,
    input: string): {inputThere: boolean; error?: string} {
  const files = layout.modelDocuments()
                    .map(d => layout.modelPath(d.name))
                    .filter(p => p !== layout.modelPath(model));
  const others = files.filter(p => path.resolve(p) !== path.resolve(input));
  const inputThere = others.length < files.length;
  if (!others.length) return {inputThere};
  return {
    inputThere,
    error: `the entry group already holds another model's file (${
               others.join(', ')}), and an entry group holds one model; ` +
        `remove it if this model replaces it, pass --out <path> to write ` +
        `elsewhere, or import into another entry group's scope.`,
  };
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
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
  const legacy = legacyProfileFormErrors(snapshot);
  if (legacy.length) return printErrors(...legacy);
  const named =
      typeof options.profile === 'string' ? options.profile : undefined;
  // `--name` names one skill, so a scope of several models is refused before
  // any AlloyDB lookup.
  const opened = await createSemanticRuntimes({
    profile: named,
    ctx,
    transpileOutcomes: await scopeTranspileOutcomes(ctx, snapshot),
    oneModel: options.name ?
        count => `--name applies to one skill, and this scope has ${
            count} models. Drop it and each takes its model's name.` :
        false,
    snapshot,
  });
  if ('error' in opened) {
    console.error(`Error: ${opened.error}`);
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
      // A store error already names the model, or holds push's errors, one
      // to a line, each naming the model file.
      for (const line of generated.error.split('\n')) {
        const named = line.startsWith(`Model '`) ||
            line.startsWith(`[${runtime.document}] `);
        console.error(
            `Error: ${named ? '' : `[${runtime.model.name}] `}${line}`);
      }
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

