// CLI command handlers
//

import * as cp from 'node:child_process';
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
import {checkProfileFileName, fileNameOf, formatOverviewSidecar, legacyProfileDirError, legacyProfileFiles, OverviewSidecar, profileFileNamesBeside, SemanticModelLayout} from '../libts/layouts/semantic-model';
import {readWorkspaceLayout} from '../libts/manifest';
import {fileContentToConcept} from '../libts/okf/concept';
import {initOkfWorkspace} from '../libts/okf/init_okf_workspace';
import {ConstraintRates} from '../libts/semantic/constraint_enforcement';
import * as contracts from '../libts/semantic/contract_tests';
import {buildCoverageReport, CoverageReport, formatCoverageSummary, writeCoverageFile} from '../libts/semantic/converters/coverage';
import {convertOwlToOsi} from '../libts/semantic/converters/owl/convert';
import {collectOwlSources} from '../libts/semantic/converters/owl/imports';
import {importShacl} from '../libts/semantic/converters/shacl/import';
import * as deploy from '../libts/semantic/deploy_bigquery';
import * as kc from '../libts/semantic/deploy_knowledge_catalog';
import * as deploySpannerLeg from '../libts/semantic/deploy_spanner';
import {googleDeploymentTargets, parseDeploymentSelection, ResolvedDeployment, resolveModelDeployments, unnamedDeployments} from '../libts/semantic/deployment_target';
import {checkGlossary} from '../libts/semantic/glossary';
import {publishGlossary} from '../libts/semantic/glossary_publish';
import {importSemanticModelYaml} from '../libts/semantic/import_model';
import {SemanticModel} from '../libts/semantic/ir';
import {existsAfterCreate, provisionCustomTypes} from '../libts/semantic/kc_custom_types';
import {LoadedModel, loadSemanticModels, OSSIE_VERSION, plural, SemanticModelError, writtenSource} from '../libts/semantic/loader';
import {SerializedFile, serializeModelFiles} from '../libts/semantic/osi_converter';
import {storeMessage} from '../libts/semantic/parameters';
import * as bqProfile from '../libts/semantic/profile_bigquery';
import {boundEntityNames, formatPruneSummary} from '../libts/semantic/prune';
import * as pullKc from '../libts/semantic/pull_kc';
import {catalogForm, updatedText} from '../libts/semantic/pull_update';
import {DeclaredProfile, DeclaredProfiles, declaredProfiles, DEFAULT_PROFILE, DialectLoad, importCommand, loadProfileFile, LocalCheckError, namedProfileErrors, profileErrorMessage, profileForDocument, pruneUnavailable, sourcesDialect, unknownProfileMessage,} from '../libts/semantic/resolve_profiles';
import {createSemanticRuntimes} from '../libts/semantic/runtime/runtime';
import {profileTargets, resolveStore, storeLine} from '../libts/semantic/runtime/store';
import {generateSkill, SkillPackage} from '../libts/semantic/skills';
import {sourceDialects} from '../libts/semantic/source_dialect';
import {sourceEntryErrors} from '../libts/semantic/source_entries';
import {loadSqlEngine} from '../libts/semantic/sql_parser';
import {DeploymentPlan, inlineBindingWarnings, localChecks, pruningLines, validateBigQueryActionStatements, validateBigQueryDataSources, validateSpannerActionStatements, withProfileFiles} from '../libts/semantic/validate';
import * as bqValidation from '../libts/semantic/validate_bigquery';
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
  // `--no-metric-graphs`: cac yields `false`. Skip deploying metric graphs and
  // fallback views alongside each BigQuery property graph. Semantic-model push
  // only.
  metricGraphs?: boolean;
  // `--strict-profile`: before deploying a BigQuery graph, run `kcmd profile`
  // and stop if the bound data contradicts any model claim. Semantic-model push
  // only.
  strictProfile?: boolean;
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

  if (okf && (options.bigqueryDataset || options.semanticModel)) {
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
      manifest = isKb ?
          await kcmd.CatalogManifest.initWithKnowledgeBase(scopeName, ctx) :
          await kcmd.CatalogManifest.initWithEntryGroup(scopeName, ctx);
    } catch (err: any) {
      const msg = String(err?.message || err);
      const parts = scopeName.split('.');
      if (okf && msg.includes('Failed to locate EntryGroup') &&
          parts.length === 3 && parts.every((p) => Boolean(p))) {
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
    const res = await catalog.createEntryGroup(
        source.project, source.location, source.entryGroup);
    const exists = await existsAfterCreate(
        res.status,
        () => catalog.getEntryGroup(
            source.project, source.location, source.entryGroup));
    if (res.status !== 200 && !exists) {
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
function legacyProfileFormErrors(snapshot: kcmd.CatalogSnapshot): string[] {
  if (snapshot.manifest.source.type !== Sources.SEMANTIC_MODEL) return [];
  const layout = snapshot.layout as SemanticModelLayout;
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
// profile files, for every load the command makes. Prints each source whose
// dialect cannot be read and returns null.
async function dialectLoad(
    ctx: context.ApiContext, docs: Array<{name: string; text: string}>,
    profileDocs: ProfileDocs): Promise<DialectLoad|null> {
  const texts = docs.map(d => d.text);
  for (const doc of docs) {
    try {
      texts.push(...profileDocs(doc.name).map(p => p.text));
    } catch {
      // A profile file the layout rejects is reported where it is read.
    }
  }
  const {dialects, databases, errors} = await readDialects(ctx, texts);
  if (errors.length) {
    for (const e of errors) console.error(`Error: ${e}`);
    return null;
  }
  return {sourceDialects: dialects, sourceDatabases: databases};
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
// file, so only a text holding U+FFFD needs its bytes checked.
function checkUtf8(
    localPath: string, fileName: string, text: string): string|undefined {
  if (!text.includes('\uFFFD')) return undefined;
  try {
    new TextDecoder('utf-8', {fatal: true}).decode(fs.readFileSync(localPath));
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
  const rawManifest = fs.existsSync(manifestPath) ?
      (yaml.parse(fs.readFileSync(manifestPath, 'utf8')) ?? {}) :
      {};
  let displayName =
      typeof rawManifest.displayName === 'string' && rawManifest.displayName.trim() ?
      rawManifest.displayName.trim() :
      undefined;
  let description =
      typeof rawManifest.description === 'string' && rawManifest.description.trim() ?
      rawManifest.description.trim() :
      undefined;
  let overviewContent: string|undefined;

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
      const fmTitle = typeof concept.frontmatter['title'] === 'string' ?
          concept.frontmatter['title'].trim() :
          '';
      const fmDesc = typeof concept.frontmatter['description'] === 'string' ?
          concept.frontmatter['description'].trim() :
          '';
      const bodyClean =
          concept.body.replace(/\n*##\s+OKF\s+Metadata\b[\s\S]*$/i, '').trim();
      const h1Match = bodyClean.match(/^#\s+(.+?)\s*$/m);
      const headingTitle = h1Match?.[1]?.trim() ?? '';
      const firstPara = bodyClean.split(/\n\s*\n/)
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
          `; declare a deployment with 'profile: prod' under ` +
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
  ensureManifestExists('.');
  const ctx = context.ApiContext.default();

  if (okf) {
    let snapshot: kcmd.CatalogSnapshot;
    let createdEg = false;
    try {
      snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
    } catch (err: any) {
      const msg = String(err?.message || err);
      const rawScope = fs.existsSync('catalog.yaml') ?
          yaml.parse(fs.readFileSync('catalog.yaml', 'utf8'))?.scope :
          undefined;
      const isKb =
          typeof rawScope === 'string' && rawScope.startsWith(`${Sources.KB}.`);
      const scopeStr = typeof rawScope === 'string' ?
          rawScope.replace(/^(entryGroup|kb)\./, '') :
          '';
      const [project, location, groupId] = scopeStr.split('.');
      if (!msg.includes('Failed to locate EntryGroup') || !project ||
          !location || !groupId) {
        throw err;
      }
      if (options.validateOnly) {
        const pendingManifest = kcmd.CatalogManifest.forPendingEntryGroup(
            isKb ? Sources.KB : Sources.ENTRYGROUP,
            `${project}.${location}.${groupId}`,
            'okf',
        );
        snapshot =
            await kcmd.CatalogSnapshot.fromManifest('.', pendingManifest, ctx);
      } else {
        const rootMeta = extractOkfRootMetadata('.', project, location, groupId);
        const catalog = new dataplex.CatalogClient(ctx);
        const createRes = await catalog.createEntryGroup(
            project,
            location,
            groupId,
            {
              type: 'context-set',
              ...(rootMeta.displayName ? {displayName: rootMeta.displayName} :
                                         {}),
              ...(rootMeta.description ? {description: rootMeta.description} :
                                         {}),
            } as any,
        );
        if (createRes.status !== 200 && createRes.status !== 409) {
          throw err;
        }
        if ((createRes.result as any)?.name?.includes('/operations/')) {
          await catalog.awaitOperation(
              createRes.result as any,
              'createEntryGroup',
          );
        }
        createdEg = true;
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

    if (!options.validateOnly && !createdEg &&
        (rootMeta.displayName || rootMeta.description)) {
      const egRes = await catalog.getEntryGroup(project, location, groupId);
      if (egRes.status === 200 && egRes.result) {
        const patchBody: Record<string, any> = {};
        const updateMask: string[] = [];
        if (rootMeta.displayName &&
            egRes.result.displayName !== rootMeta.displayName) {
          patchBody.displayName = rootMeta.displayName;
          updateMask.push('displayName');
        }
        if (rootMeta.description &&
            egRes.result.description !== rootMeta.description) {
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
          if (patchRes.status === 200 &&
              patchRes.result?.name?.includes('/operations/')) {
            await catalog.awaitOperation(patchRes.result, 'updateEntryGroup');
          }
        }
      }
    }

    const sync = new kcmd.CatalogSync(catalog, snapshot);
    const result = await sync.push({
      force: options.force,
      validateOnly: options.validateOnly,
    });
    if (!result.success) {
      if (result.details) console.error(`Error: ${result.details}`);
      return 1;
    }

    if (!options.validateOnly && rootMeta.overviewContent) {
      const pnum = await crm.projectNumber(project, ctx);
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
      let patchedRep = false;
      for (let attempt = 0; attempt < maxAttempts && !patchedRep; attempt++) {
        for (const repName of repCandidates) {
          const res = await catalog.updateEntry(
              {
                name: repName,
                entryType:
                    'projects/dataplex-types/locations/global/entryTypes/entrygroup',
                aspects: {
                  [ovKey]: {
                    data: {
                      content: rootMeta.overviewContent,
                      contentType: 'MARKDOWN',
                    },
                  },
                },
              },
              ['aspects'],
              [ovKey],
          );
          if (res.status === 200) {
            patchedRep = true;
            break;
          }
        }
        if (!patchedRep && attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }
    return 0;
  }

  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
  if (options.force) console.warn('Warning: --force has no effect.');

  if (snapshot.manifest.source.type === Sources.SEMANTIC_MODEL) {
    // The semantic-model source always resolves to the SemanticModel layout
    // (see createLayout), so this cast is safe.
    const legacy = legacyProfileFormErrors(snapshot);
    if (legacy.length) return printErrors(...legacy);
    const layout = snapshot.layout as SemanticModelLayout;
    const source = snapshot.manifest.source as SemanticModelSource;
    const layoutDocs = layout.modelDocuments();
    const profileDocs = profileDocsReader(layout);
    // Reading a GOOGLE block profile checks its field bindings for SQL, which
    // needs the SQL parser.
    if (!await sqlParserReady()) return 1;
    return pushInTwoPhases(
        options, {ctx, layout, source, docs: layoutDocs, profileDocs});
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
    [options.metricGraphs === false, '--no-metric-graphs'],
    [!!options.strictProfile, '--strict-profile'],
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
  const load = await dialectLoad(ctx, scope.docs, scope.profileDocs);
  if (!load) return 1;
  const checked = await checkBeforeWrites(options, {...scope, load});
  if ('errors' in checked) return fail(...checked.errors.map(e => e.error));
  const {plans, kcModels, leftOut, overviews} = checked;

  if (options.metricGraphs === false) {
    const offline = new context.ApiContext('', '', '');
    for (const plan of plans) {
      if (plan.deployment.engine === 'bigquery' && plan.generated) {
        const regen = await deploy.deployBigQuery(
            [plan.model], offline, {validateOnly: true, metricGraphs: false});
        if (regen.success) plan.generated = regen;
      }
    }
  }

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
  if (errors.length) return fail(...errors);

  if (options.strictProfile && !options.validateOnly) {
    const bqPlans = plans.filter(p => p.deployment.engine === 'bigquery');
    if (!bqPlans.length) {
      console.warn(
          'Warning: --strict-profile only runs on a BigQuery deployment; ignoring it.');
    } else {
      for (const plan of bqPlans) {
        if (!await profileGate([plan.model], ctx, plan.deployment.profile)) {
          return 1;
        }
      }
    }
  }

  const header = (d: ResolvedDeployment) => {
    if (plans.length > 1) console.log(`\n-- Deployment '${d.name}' --`);
  };
  if (options.validateOnly) {
    for (const {deployment, generated} of plans) {
      if (!generated) continue;
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

  const hasLiveCatalogWrites = preflight.prepared!.emitted.length > 0;
  const bqDeployedModels: LoadedModel[] = [];
  const constraintRates = new Map<string, ConstraintRates>();

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
    if (deployment.engine === 'bigquery') {
      const bqOut = await pushBigQuery(
          [model], ctx, options, printed, hasLiveCatalogWrites);
      if (bqOut.code !== 0) return bqOut.code;
      bqDeployedModels.push(model);
      for (const [m, rates] of bqOut.constraintRates ?? []) {
        constraintRates.set(m, rates);
      }
    } else {
      const code = await pushSpanner([model], ctx, options, printed);
      if (code !== 0) return code;
    }
  }

  if (hasLiveCatalogWrites && bqDeployedModels.length > 0) {
    const grounded = await kc.syncBigQueryCatalogGrounding(
        preflight.prepared!, bqDeployedModels,
        constraintRates.size ? constraintRates : undefined, ctx, kcOptions);
    for (const w of grounded.warnings) {
      if (!printed.has(w)) {
        console.warn(`Warning: ${w}`);
        printed.add(w);
      }
    }
    if (grounded.bound > 0) {
      console.log(`Bound ${grounded.bound} BigQuery catalog entry link(s).`);
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
  // reject a field its table cannot run, so the load does not warn about it.
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
    // The model file and each profile file must be valid UTF-8.
    // withProfileFiles has read the profile files, so profileDocs does not
    // throw here.
    const modelPath = layout.modelPath(base.document);
    const modelFile = {
      path: modelPath,
      fileName: fileNameOf(layout, base.document, modelPath),
      text: docs.find(d => d.name === base.document)!.text,
    };
    for (const file of [modelFile, ...profileDocs(base.document)]) {
      const error = checkUtf8(file.path, file.fileName, file.text);
      if (error) return fail(error);
    }
  }
  // The catalog writes each overview sidecar, which must be valid UTF-8 too.
  let overviews: Map<string, OverviewSidecar>|undefined;
  if (docs.length === 1) {
    try {
      for (const {path: sidecar} of layout.overviewSidecarPaths()) {
        const error = checkUtf8(
            sidecar, fileNameOf(layout, docs[0].name, sidecar),
            fs.readFileSync(sidecar, 'utf8'));
        if (error) return fail(error);
      }
      overviews = layout.overviewSidecars();
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

// Extracts generated view names and standalone view SELECT queries from a
// BigQuery main-graph DDL block (`CREATE OR REPLACE VIEW ...;\n\nCREATE OR
// REPLACE PROPERTY GRAPH ...`). Used when a pre-deploy dry run fails solely
// because generated views do not exist in BigQuery yet before Phase 2 creates
// them.
function generatedViewDryRunInfo(mainDdl: string): {
  createdViews: string[];
  standaloneViewSelects: string[];
} {
  const createdViews =
      [...mainDdl.matchAll(/CREATE\s+OR\s+REPLACE\s+VIEW\s+`([^`]+)`/gi)]
          .map(m => m[1]);
  if (!createdViews.length) {
    return {createdViews: [], standaloneViewSelects: []};
  }
  const statements = mainDdl.split(/;\s*\n\n+/);
  const standaloneViewSelects: string[] = [];
  const priorViews: string[] = [];
  for (const stmt of statements) {
    const m = /CREATE\s+OR\s+REPLACE\s+VIEW\s+`([^`]+)`[\s\S]*?\bAS\s*\n([\s\S]+)$/i
                  .exec(stmt.trim());
    if (!m) continue;
    const [, viewRef, selectBody] = m;
    const dependsOnPrior = priorViews.some(v => selectBody.includes(`\`${v}\``));
    if (!dependsOnPrior) standaloneViewSelects.push(selectBody);
    priorViews.push(viewRef);
  }
  return {createdViews, standaloneViewSelects};
}

// True when BigQuery rejected a multi-statement `CREATE VIEW ...; CREATE
// PROPERTY GRAPH ...` dry run only because one of the views in `createdViews`
// does not exist yet (or multi-statement `CREATE PROPERTY GRAPH` dry run is
// unsupported), rather than a column/type error in the query itself.
function isMissingGeneratedViewDryRunError(
    createdViews: readonly string[], detail: string): boolean {
  if (!createdViews.length) return false;
  if (/CREATE\s+(?:OR\s+REPLACE\s+)?PROPERTY\s+GRAPH[\s\S]*multi-statement/i
          .test(detail)) {
    return true;
  }
  if (!/not found/i.test(detail)) return false;
  return createdViews.some(ref => {
    const parts = ref.split('.');
    if (parts.length !== 3) return detail.includes(ref);
    const [p, d, t] = parts;
    return detail.includes(`${p}.${d}.${t}`) ||
        detail.includes(`${p}:${d}.${t}`) || detail.includes(`${d}.${t}`);
  });
}

// The errors of one deployment's live checks, which change nothing. They read
// the BigQuery dataset or the Spanner database and instance, probe each
// BigQuery source and dry-run the BigQuery DDL in the dataset's location, and
// check each action's DML. A dataset whose location cannot be read, or an
// instance whose edition cannot be read, adds a warning to `warnings`.
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
  // Dry-run only the main graph DDL block (`ddl[0]`); `ddl[1..]` are metric
  // slice graphs / fallback views derived from the same validated model and
  // referencing node views created during Phase 2.
  const mainDdl = plan.generated?.ddl[0];
  if (mainDdl !== undefined) {
    const res = await bq.query(project, mainDdl, location, true);
    if (res.status !== 200) {
      const detail = storeMessage(res.message, res.status);
      const {createdViews, standaloneViewSelects} =
          generatedViewDryRunInfo(mainDdl);
      if (isMissingGeneratedViewDryRunError(createdViews, detail)) {
        for (const selectSql of standaloneViewSelects) {
          const vRes = await bq.query(project, selectSql, location, true);
          if (vRes.status !== 200) {
            return [`${at}: the graph's DDL fails a BigQuery dry run: ${
                storeMessage(vRes.message, vRes.status)}`];
          }
        }
      } else {
        return [`${at}: the graph's DDL fails a BigQuery dry run: ${detail}`];
      }
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
// Returns a process exit code (0 on success).
async function printStore(
    options: ProfilesOptions, ctx: context.ApiContext,
    snapshot: kcmd.CatalogSnapshot): Promise<number> {
  const named =
      typeof options.profile === 'string' ? options.profile : undefined;

  let refused: string[] = [];
  const opened = await createSemanticRuntimes({
    profile: named,
    ctx,
    oneModel: true,
    snapshot,
    proceed: async () => {
      const layout = snapshot.layout as SemanticModelLayout;
      const docs = layout.modelDocuments();
      const profileDocs = profileDocsReader(layout);
      const read = await readDialects(ctx, [
        ...docs.map(d => d.text),
        ...docs.flatMap(d => profileDocs(d.name).map(p => p.text)),
      ]);
      refused = read.errors.filter(e => !read.unread.includes(e));
      if (refused.length) return false;
      const load = {
        sourceDialects: read.dialects,
        sourceDatabases: read.databases,
      };
      const {models} =
          loadSemanticModels(docs, {bindingOptional: true, ...load});
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
    if (!store) {
      console.error(`Error: ${storeError}`);
      return 1;
    }
    console.log(storeLine(store));
  }
  return 0;
}


// Prints a profile's report under its header: the deployment target, the
// source each entity binds to, and what the profile cannot answer or cannot
// run.
function printProfileReport(model: SemanticModel, name: string): void {
  const targets = profileTargets(model, name);
  const {report} = pruneUnavailable(
      model, name,
      pruningDialect({...model, deployments: unnamedDeployments(targets)}));
  console.log(`    target: ${
      targets.length ? targets.join(', ') :
                       '(none; no deployment names this profile)'}`);
  console.log('    sources:');
  for (const e of model.entities ?? []) {
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
export async function profiles(options: ProfilesOptions = {}): Promise<number> {
  ensureManifestExists('.');
  const ctx = context.ApiContext.default();
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
  const legacy = legacyProfileFormErrors(snapshot);
  if (legacy.length) return printErrors(...legacy);
  if (options.printStore) return await printStore(options, ctx, snapshot);

  const only =
      typeof options.profile === 'string' ? options.profile : undefined;

  if (snapshot.manifest.source.type !== Sources.SEMANTIC_MODEL) {
    console.error(
        'Error: `kcmd profiles` applies only to a semantic-model scope.');
    return 1;
  }
  const layout = snapshot.layout as SemanticModelLayout;
  const source = snapshot.manifest.source as SemanticModelSource;
  if (!await sqlParserReady()) return 1;

  const docs = layout.modelDocuments();
  if (!docs.length) {
    console.log('No semantic model documents found.');
    return 0;
  }

  let missing = false;
  let failed = false;
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
  const load = await dialectLoad(ctx, docs, profileDocs);
  if (!load) return 1;
  const inlineHeader =
      `  profile '${DEFAULT_PROFILE}': the model document's own inline ` +
      `bindings, as authored -- nothing merged, nothing withheld.`;
  const warnInline = (doc: {name: string; text: string}, named: boolean) => {
    const loaded = loadSemanticModels([doc], {bindingOptional: true});
    if (loaded.error) return;
    for (const w of inlineBindingWarnings(
             loaded.models[0].model, doc.name, named)) {
      console.warn(`  profile '${DEFAULT_PROFILE}': warning: ${w}`);
    }
  };

  const checked = await checkBeforeWrites(
      {}, {ctx, layout, source, docs, profileDocs, load}, true);
  const pushErrors = 'errors' in checked ? checked.errors : [];
  if ('kcModels' in checked) {
    const {error, warnings} =
        catalogAspects(checked.kcModels, source, checked.overviews);
    for (const w of warnings) console.warn(`Warning: ${w}`);
    if (error) pushErrors.push({error, document: checked.kcModels[0].document});
  }
  const pushErrorsWhere = (belongs: (e: LocalCheckError) => boolean) =>
      [...new Set(pushErrors.filter(belongs).map(e => e.error))];
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
  const pushErrorsOf = (document?: string, profile?: string) =>
      pushErrorsWhere(e => e.document === document && e.profile === profile);
  printRejects('', pushErrorsOf());

  for (const doc of docs) {
    console.log(`Model '${doc.name}' (${source.entryGroup}):`);
    const modelProfiles = declaredBy(doc);
    printRejects(
        '  ',
        pushErrorsWhere(
            e => e.document === doc.name &&
                (e.profile === undefined ||
                 (only !== undefined && e.profile !== only))));
    const declared =
        modelProfiles.filter(p => p.name.toLowerCase() !== DEFAULT_PROFILE);
    if (only === DEFAULT_PROFILE) {
      console.log(inlineHeader);
      warnInline(doc, declared.length > 0);
      printRejects('    ', pushErrorsOf(doc.name, DEFAULT_PROFILE));
      continue;
    }
    const available = only ? declared.filter(p => p.name === only) : declared;
    if (only && !available.length) {
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
      if (res.kind === 'missing') continue;
      const errors = pushErrorsOf(doc.name, name);
      let model: SemanticModel|undefined;
      let applyError: string|undefined;
      const published = errors.length ? undefined :
          res.kind === 'error' ?
          profileForDocument(doc, available, name, load, {skipActions: true}) :
          res;
      if (published?.kind === 'file') {
        for (const w of published.warnings) {
          console.warn(`  profile '${name}': warning: ${w}`);
        }
      }
      if (res.kind === 'error') {
        applyError =
            profileErrorMessage(doc.name, res, name, profileDocs(doc.name));
      } else {
        model = res.model;
      }
      console.log(`  profile '${name}'`);
      if (model) {
        printProfileReport(model, name);
      } else if (applyError !== undefined && !pushErrors.length) {
        const [first, ...rest] = applyError.split('\n');
        console.log(`    not shown: ${first}`);
        for (const line of rest) console.log(`      ${line}`);
      }
      printRejects('    ', errors);
    }
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
    engine: 'BigQuery'|'Spanner',
    result: {
      warnings: string[];
      ddl: string[];
      nodeViews?: string[];
      metricGraphs?: string[];
    },
    options: PushOptions, printed?: ReadonlySet<string>): void {
  for (const w of result.warnings) {
    if (!printed?.has(w)) console.warn(`Warning: ${w}`);
  }
  if (!options.print) return;
  console.log(`-- ${engine} Graph --`);
  for (const block of result.ddl) console.log(`${block}\n`);
}


// Deploys the semantic model's BigQuery Graph leg (over the pre-loaded models)
// and prints the result. Returns the exit code and any measured constraint
// rates.
async function pushBigQuery(
    models: LoadedModel[], ctx: context.ApiContext, options: PushOptions,
    printed?: ReadonlySet<string>, measureConstraints = false):
    Promise<{code: number; constraintRates?: Map<string, ConstraintRates>}> {
  console.log(
      options.validateOnly ? 'Validating semantic model for BigQuery Graph...' :
                             'Pushing semantic model (BigQuery Graph)...');
  const deployOptions =
      measureConstraints ? {...options, measureConstraints: true} : options;
  const result = await deploy.deployBigQuery(models, ctx, deployOptions);
  printGraph('BigQuery', result, options, printed);

  if (!result.success) {
    console.error('Error pushing semantic model to BigQuery:', result.details);
    return {code: 1};
  }
  const viewsSuffix = result.views ? ` and ${result.views} view(s)` : '';
  console.log(
      options.validateOnly ?
          'Validation complete; no changes applied.' :
          `Deployed ${result.deployed} BigQuery Graph(s)${viewsSuffix}.`);
  return {code: 0, constraintRates: result.constraintRates};
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
    ...(options.validateOnly ? {} : {groundingTrailers: true}),
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
  const linkPlural = result.linked === 1 ? '' : 's';
  const unchanged =
      result.unchangedLinks ? ` (${result.unchangedLinks} unchanged)` : '';
  const linked = result.linked || result.unchangedLinks ?
      `; wrote ${result.linked} entry link${linkPlural}${unchanged}` :
      '';
  const unlinked = result.unlinked ?
      `; unlinked ${result.unlinked} orphaned link${
          result.unlinked === 1 ? '' : 's'}` :
      '';
  const bound = result.bound ?
      `; bound ${result.bound} BigQuery link${result.bound === 1 ? '' : 's'}` :
      '';
  console.log(
      options.validateOnly ?
          'Validation complete; no changes applied.' :
          `Wrote ${result.created} new and ${result.updated} updated ` +
              `Knowledge Catalog entr${n === 1 ? 'y' : 'ies'}${removed}${
                  linked}${unlinked}${bound}.`);
  return 0;
}


// Pulls the semantic model's Knowledge Catalog entries back into local model
// documents (catalog/EntryGroups/<entryGroup>/<model>.yaml) and prints the
// result.
async function pullSemanticModel(
    ctx: context.ApiContext, snapshot: kcmd.CatalogSnapshot,
    options: PullOptions): Promise<number> {
  const layout = snapshot.layout as SemanticModelLayout;
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

  const catalogNames = new Set(result.models.map(m => m.name));
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
      const paths = [
        layout.modelPath(name),
        ...layout.localProfileFiles(name).map(f => f.path),
      ];
      if (!options.dryRun) {
        layout.removeModelDocument(name);
        for (const p of paths.slice(1)) fs.rmSync(p);
      }
      for (const p of paths) {
        console.log(`  ${options.dryRun ? 'would remove' : 'removed'} ${p}`);
      }
    }
  }

  const pulled = result.models[0];
  const {files, warnings} = pulledModelFiles(layout, pulled);
  for (const w of warnings) console.warn(`Warning: [${pulled.name}] ${w}`);
  const updated = updatedFiles(layout, source, pulled.name, files);
  for (const [id, sidecar] of result.overviews ?? []) {
    updated.push({
      fileName: `${id}.overview.md`,
      content: formatOverviewSidecar(sidecar),
    });
  }
  return writePulledFiles(layout, pulled.name, updated, options);
}


// The model and profile files pull writes for `pulled`. The catalog stores no
// profile's actions, so a profile file keeps the actions it binds locally. A
// vanilla model declares no action.
function pulledModelFiles(layout: SemanticModelLayout, pulled: SemanticModel) {
  const model = pulled.version === OSSIE_VERSION ? pulled : {
    ...pulled,
    profiles: pulled.profiles?.map(p => {
      const actions = localProfileActions(layout, pulled.name, p.name);
      return actions ? {...p, actions} : p;
    }),
  };
  return serializeModelFiles(model, {logical: true});
}


// The model and profile files pull writes for `model`.
function updatedFiles(
    layout: SemanticModelLayout, source: SemanticModelSource, model: string,
    files: SerializedFile[]): SerializedFile[] {
  const doc = layout.modelDocuments().find(
      d => layout.modelPath(d.name) === layout.modelPath(model));
  if (!doc) return files;
  const modelFile = `${model}.yaml`;
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
    const content = updatedText(text, base, file.content);
    const changed = read(content);
    if (changed instanceof Map && changed.get(file.fileName) === file.content) {
      return {...file, content};
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


// The actions the local profile file of `profile` binds, or undefined when it
// binds none or does not load.
function localProfileActions(
    layout: SemanticModelLayout, model: string, profile: string) {
  const file = layout.localProfileFiles(model).find(
      f => (f.profileName ?? path.basename(f.path, '.yaml')) === profile);
  if (!file) return undefined;
  try {
    return loadProfileFile(fs.readFileSync(file.path, 'utf8'), profile).actions;
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
    return undefined;
  }
}


// Writes the files a pull rebuilt for `model`, and skips a name push does not
// read. Then it names each local profile file and overview sidecar that the
// pull did not write, or deletes it under --force-remove.
function writePulledFiles(
    layout: SemanticModelLayout, model: string, files: SerializedFile[],
    options: PullOptions): number {
  const written = new Set<string>();
  const counts = {created: 0, updated: 0, unchanged: 0};
  for (const {fileName, content} of files) {
    const target = pulledFileTarget(layout, model, fileName, true);
    if (!target) {
      console.warn(
          `Warning: skipped '${fileName}' from the catalog; pull writes only ` +
          `'${model}.yaml', '${model}.profile.<name>.yaml' and overview ` +
          `sidecars inside the entry group directory.`);
      continue;
    }
    written.add(path.resolve(target.path));
    const before =
        fs.existsSync(target.path) ? fs.readFileSync(target.path) : undefined;
    const state = !before                   ? 'created' :
        before.equals(Buffer.from(content)) ? 'unchanged' :
                                              'updated';
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

  const local: Array<{path: string; profileName?: string; kind: string}> = [
    ...layout.localProfileFiles(model).map(f => ({...f, kind: 'profile file'})),
    ...layout.overviewSidecarPaths().map(
        f => ({path: f.path, kind: 'overview sidecar'})),
  ];
  for (const stale of local) {
    if (written.has(path.resolve(stale.path))) continue;
    if (!options.forceRemove) {
      console.warn(
          `Warning: local ${stale.kind} ${stale.path} is not in the ` +
          `catalog; delete it, or pull with --force-remove to delete it.`);
    } else if (options.dryRun) {
      console.log(`  would remove ${stale.path}`);
    } else {
      if (stale.profileName !== undefined) {
        layout.removeProfileDocument(model, stale.profileName);
      } else {
        fs.rmSync(stale.path);
      }
      console.log(`  removed ${stale.path}`);
    }
  }

  const unchanged = counts.unchanged ? `; ${counts.unchanged} unchanged` : '';
  console.log(
      options.dryRun ?
          `Dry run: would write ${counts.created} new and ${
              counts.updated} updated file(s)${unchanged}.` :
          `Wrote ${counts.created} new and ${counts.updated} updated ` +
              `file(s)${unchanged}.`);
  return 0;
}


// Where pull writes the catalog's file `fileName` of `model`, and how.
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
  // Explicit model name; required when importing more than one file.
  name?: string;
  // Prune to entities bound in the named profile or sibling profiles.
  pruneUnbound?: boolean|string;
  // Where to write the coverage report (`coverage.json` beside `--out`, or a
  // custom path). `--no-coverage` (`false`) writes none.
  coverage?: boolean|string;
}

// Recognized OWL source extensions, stripped to derive the model name from the
// filename: `sales.owl.ttl` -> `sales`.
const OWL_EXTENSIONS = /\.owl\.ttl$|\.ttl$|\.owl$/i;

// Handles `kcmd owl <action> <file...>`. The only action is `import`: convert
// one or more Turtle OWL ontologies into an OSI model document that then rides
// the normal `kcmd push` / `kcmd pull`. Returns a process exit code.
export async function owl(
    action: string, fileOrFiles: string|string[],
    options: OwlImportOptions = {}): Promise<number> {
  const usage =
      'usage: kcmd owl import <file.ttl...> [--name <model>] [--out <path>]';
  if (action !== 'import') {
    console.error(
        `Error: unknown owl action '${action}'; the only action is 'import' ` +
        `(${usage}).`);
    return 1;
  }

  const files = (Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles])
                    .filter(f => f !== undefined && f !== '');
  if (!files.length) {
    console.error(`Error: no ontology file given (${usage}).`);
    return 1;
  }
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`Error: file not found: ${f}`);
      return 1;
    }
  }

  let modelName: string;
  if (options.name !== undefined) {
    modelName = String(options.name).trim();
    if (!modelName) {
      console.error('Error: --name must not be empty.');
      return 1;
    }
  } else if (files.length === 1) {
    modelName = path.basename(files[0]).replace(OWL_EXTENSIONS, '');
    if (!modelName) {
      console.error(`Error: could not derive a model name from '${files[0]}'.`);
      return 1;
    }
  } else {
    console.error(
        `Error: --name <model> is required when importing more than one file ` +
        `(got ${files.length}: ${files.join(', ')}).`);
    return 1;
  }

  // Proposed --prune-unbound: the entity names the binding binds.
  let bound: string[]|undefined;
  if (options.pruneUnbound !== undefined && options.pruneUnbound !== false) {
    const docs =
        await bindingDocuments(options.pruneUnbound, modelName, options.out);
    if (typeof docs === 'string') {
      console.error(`Error: ${docs}`);
      return 1;
    }
    bound = [];
    for (const doc of docs) {
      for (const name of boundEntityNames(
               fs.readFileSync(doc, 'utf8'), modelName)) {
        if (!bound.includes(name)) bound.push(name);
      }
    }
    if (!bound.length) {
      console.error(
          `Error: --prune-unbound: ${docs.join(', ')} binds no entity (no ` +
          `entity with a source), so pruning would remove everything.`);
      return 1;
    }
    console.log(`--prune-unbound: ${bound.length} bound ${
        plural(bound.length, 'entity', 'entities')} in ${docs.join(', ')}`);
  }

  // The named files plus every local owl:imports they reach, merged in that
  // order. collectOwlSources and convertOwlToOsi throw only on malformed
  // Turtle; main.ts's try/catch reports it.
  const collected = collectOwlSources(files);
  for (const w of collected.warnings) {
    console.warn(`Warning: ${w}`);
  }
  const named = new Set(files.map(f => path.resolve(f)));
  for (const s of collected.sources) {
    if (!named.has(path.resolve(s.path))) {
      console.log(`following owl:imports: ${s.path}`);
    }
  }
  const turtle = collected.sources.map(s => s.text);
  const file = files.join(', ');
  const result = convertOwlToOsi(
      turtle.length === 1 ? turtle[0] : turtle, modelName,
      {compactFlow: options.compact, bound});
  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }

  const {classes, datatypeProperties, objectProperties} = result.stats;

  // Guard: an ontology with no owl:Class yields a model with no datasets, which
  // is not a loadable OSI model.
  if (classes === 0) {
    console.error(`Error: no owl:Class declarations found in '${
        file}'; nothing to import.`);
    return 1;
  }

  // Every name the import derives, from the file name and from the ontology,
  // must be one the loader accepts.
  await loadSqlEngine();
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
    const {error} = otherModelFiles(layout, modelName, files[0]);
    if (error) return printErrors(error);
  }
  if (typeof layout === 'string') {
    return printErrors(layout);
  }

  const {vocabularies = 0, derivedRelationships = 0, metrics = 0} =
      result.stats;
  const refined = [
    ...(vocabularies ?
            [`${vocabularies} ${
                plural(vocabularies, 'vocabulary', 'vocabularies')}`] :
            []),
    ...(derivedRelationships ?
            [`${derivedRelationships} derived ${
                plural(
                    derivedRelationships, 'relationship', 'relationships')}`] :
            []),
    ...(metrics ? [`${metrics} ${plural(metrics, 'metric', 'metrics')}`] : []),
  ];
  console.log(
      `converted ${classes} ${plural(classes, 'class', 'classes')}, ` +
      `${objectProperties} ` +
      `${plural(objectProperties, 'object property', 'object properties')}, ` +
      `${datatypeProperties} ` +
      `${
          plural(
              datatypeProperties, 'datatype property',
              'datatype properties')}` +
      (refined.length ? ` (${refined.join(', ')})` : ''));
  if (result.prune) {
    console.log(formatPruneSummary(result.prune));
  }

  // Sink: an explicit --out path writes directly; otherwise the semantic-model
  // layout places the document under the scope's entry group so `kcmd push`
  // finds it.
  let writtenPath: string;
  if (!layout) {
    writeFileAt(options.out!, result.yaml);
    writtenPath = options.out!;
  } else {
    layout.writeModelDocument(modelName, result.yaml);
    writtenPath = layout.modelPath(modelName);
  }

  console.log(`wrote ${writtenPath}`);
  if (options.coverage !== false &&
      (Boolean(options.out) || options.coverage !== undefined)) {
    const pruned = result.prune?.pruned;
    writeCoverage(
        buildCoverageReport(
            'owl', modelName, files, result.coverage,
            pruned && {
              entities: pruned.entities,
              relationships: pruned.relationships,
              constraints: pruned.constraints,
            }),
        options.coverage, writtenPath);
  }
  return 0;
}

// The binding documents `owl import --prune-unbound` reads: the named file,
// or (bare flag) the model's binding profiles in this scope's layout, else the
// profile files beside --out. Returns an error message when there is none.
async function bindingDocuments(
    flag: boolean|string, modelName: string,
    out: string|undefined): Promise<string[]|string> {
  if (flag !== true) {
    const doc = String(flag);
    return fs.existsSync(doc) ? [doc] :
                                `--prune-unbound: file not found: ${doc}`;
  }
  if (fs.existsSync('catalog.yaml')) {
    const snapshot =
        await kcmd.CatalogSnapshot.fromPath('.', context.ApiContext.default());
    if (snapshot.manifest.source.type === Sources.SEMANTIC_MODEL) {
      const layout = snapshot.layout as SemanticModelLayout;
      const docs = layout.localProfileFiles(modelName).map(p => p.path);
      if (docs.length) return docs;
      const groupDir = path.dirname(layout.profilePath(modelName, 'x'));
      const legacy = legacyProfileFiles(groupDir, modelName).map(p => p.path);
      if (legacy.length) return legacy;
    }
  }
  if (out) {
    const outDir = path.dirname(out);
    const siblings = profileFileNamesBeside(outDir, modelName)
                         .map(f => path.join(outDir, f));
    if (siblings.length) return siblings;
    const legacy = legacyProfileFiles(outDir, modelName).map(f => f.path);
    if (legacy.length) return legacy;
  }
  return `--prune-unbound found no binding profile for model '${
             modelName}' in this scope's layout${
             out ? ' or beside --out' : ''}; name the binding document: ` +
      `--prune-unbound <profile.yaml>.`;
}

// Prints an import's coverage summary and writes the report: to the
// `--coverage <path>` file, else to `coverage.json` beside the model document
// the import wrote.
function writeCoverage(
    report: CoverageReport, flag: boolean|string|undefined,
    writtenPath: string): void {
  console.log(formatCoverageSummary(report));
  const file = flag !== undefined && typeof flag !== 'boolean' ?
      String(flag) :
      path.join(path.dirname(writtenPath), 'coverage.json');
  writeCoverageFile(file, report);
  console.log(`wrote ${file}`);
}


export interface ShaclImportCommandOptions {
  // The model document to add the constraints to. When omitted, the model
  // named by --model is read from (and written back to) the scope's
  // semantic-model layout, where `kcmd owl import` puts it.
  into?: string;
  // Which model receives the constraints: required without --into; with
  // --into it only confirms the document's model (a document declares one).
  model?: string;
  // Write the updated document here instead of back to its source.
  out?: string;
  // Where to write the coverage report (default: `coverage.json` beside
  // `--into` / `--out`). `--no-coverage` (`false`) writes none.
  coverage?: boolean|string;
}

// Handles `kcmd shacl <action> <shapes.ttl...>`. The only action is `import`:
// read a SHACL shapes graph (one or more Turtle files) and merge the rules it
// states into an EXISTING model as native `constraints`.
export async function shacl(
    action: string, fileOrFiles: string|string[],
    options: ShaclImportCommandOptions = {}): Promise<number> {
  const usage =
      'usage: kcmd shacl import <shapes.ttl...> [--into <model.yaml>] ' +
      '[--model <name>] [--out <path>]';
  if (action !== 'import') {
    console.error(`Error: unknown shacl action '${
        action}'; the only action is 'import' (${usage}).`);
    return 1;
  }
  const files = (Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles])
                    .filter(f => f !== undefined && f !== '');
  if (!files.length) {
    console.error(`Error: no shapes file given (${usage}).`);
    return 1;
  }
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`Error: file not found: ${file}`);
      return 1;
    }
  }
  const modelName =
      options.model !== undefined ? String(options.model) : undefined;

  let sourcePath: string;
  let writeBack: (yaml: string) => void;
  if (options.into) {
    if (!fs.existsSync(options.into)) {
      console.error(`Error: file not found: ${options.into}`);
      return 1;
    }
    sourcePath = options.into;
    writeBack = yamlText => fs.writeFileSync(sourcePath, yamlText);
  } else {
    if (modelName === undefined) {
      console.error(
          `Error: say which model receives the constraints: --into ` +
          `<model.yaml>, or --model <name> for a model in this scope's ` +
          `semantic-model layout.`);
      return 1;
    }
    const ctx = context.ApiContext.default();
    const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
    if (snapshot.manifest.source.type !== Sources.SEMANTIC_MODEL) {
      console.error(
          `Error: this catalog is not a semantic-model scope, so there is no ` +
          `model layout to read from. Pass --into <model.yaml>.`);
      return 1;
    }
    const layout = snapshot.layout as SemanticModelLayout;
    sourcePath = layout.modelPath(modelName);
    if (!fs.existsSync(sourcePath)) {
      console.error(`Error: no model '${modelName}' in this scope (${
          sourcePath} does not exist).`);
      return 1;
    }
    writeBack = yamlText => layout.writeModelDocument(modelName, yamlText);
  }

  if (!await sqlParserReady()) return 1;
  const shapes = files.map(f => fs.readFileSync(f, 'utf8'));
  const result = importShacl(
      shapes.length === 1 ? shapes[0] : shapes,
      fs.readFileSync(sourcePath, 'utf8'), {model: modelName});
  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }
  const n = result.added.length;
  console.log(
      `read ${result.shapes} ${plural(result.shapes, 'shape', 'shapes')}; ` +
      `${n} ${plural(n, 'constraint', 'constraints')} for model '${
          result.model}'` +
      (result.replaced ? ` (replacing ${result.replaced} from an earlier ` +
                             `import)` :
                         ''));

  let writtenPath: string;
  if (options.out) {
    writeFileAt(options.out, result.yaml);
    writtenPath = options.out;
  } else {
    writeBack(result.yaml);
    writtenPath = sourcePath;
  }
  console.log(`wrote ${writtenPath}`);
  if (options.coverage !== false &&
      (Boolean(options.out || options.into) ||
       options.coverage !== undefined)) {
    writeCoverage(
        buildCoverageReport('shacl', result.model, files, result.coverage),
        options.coverage, writtenPath);
  }
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
export async function importModel(
    file: string, options: ImportCommandOptions = {}): Promise<number> {
  const fail = printErrors;
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
  if (!fs.existsSync(file)) return fail(`file not found: ${file}`);

  const dir = path.dirname(file);
  const stem = path.basename(file).replace(YAML_FILE, '');
  if (legacyProfileFiles(dir, stem).length) {
    if (input === 'first-party') return fail(legacyProfileDirError(stem));
    console.warn(`Warning: ${legacyProfileDirError(stem)}`);
  }
  const profileFiles =
      profileFileNamesBeside(dir, stem)
          .map(f => ({
                 fileName: f,
                 content: fs.readFileSync(path.join(dir, f), 'utf8'),
               }));
  let ctx: context.ApiContext|undefined;
  const api = () => ctx ??= context.ApiContext.default();
  const result = await importSemanticModelYaml(fs.readFileSync(file, 'utf8'), {
    flavor: flavor as 'ossie' | 'google',
    sourcePrefix: options.sourcePrefix,
    transpile: !!options.transpile,
    strict: input === 'first-party',
    profileFiles,
    fileName: path.basename(file),
    listEntries: (project, location, entryGroup) =>
        new dataplex.CatalogClient(api()).listEntries(
            project, location, entryGroup),
    readDialects: texts => readDialects(api(), texts),
  });
  for (const w of result.warnings) console.warn(`Warning: ${w}`);
  if (!result.ok) return fail(...result.errors);

  let targets: Array<{path: string; write: (text: string) => void}|undefined>;
  if (options.out && YAML_FILE.test(options.out)) {
    if (result.files.length > 1) {
      return fail(
          `--out '${options.out}' names a file, but the import gives ${
              result.files.length} files (${
              result.files.map(f => f.fileName).join(', ')}); name a ` +
          `directory instead.`);
    }
    const out = options.out;
    targets = [{path: out, write: text => writeFileAt(out, text)}];
  } else if (options.out) {
    const out = options.out;
    targets = result.files.map(f => {
      const target = path.join(out, f.fileName);
      return {path: target, write: text => writeFileAt(target, text)};
    });
  } else {
    const layout = await workspaceLayout();
    if (typeof layout === 'string') return fail(layout);
    const model = result.files[0].fileName.replace(YAML_FILE, '');
    targets = result.files.map(
        f => pulledFileTarget(layout, model, f.fileName, false));
    const {inputThere, error} = otherModelFiles(layout, model, file);
    const refusals = error ? [error] : [];
    if (inputThere) {
      refusals.push(
          `the input file ${file} sits in the entry group, so the import ` +
          `would leave this model in two files there, ${file} and ${
              layout.modelPath(model)}. Move the input${
              profileFiles.length ? ' and its profile files' : ''} out of ` +
          `the entry group and import it from there, or pass --out <path> ` +
          `to write elsewhere.`);
    }
    if (refusals.length) return fail(...refusals);
    const inPlace = profileFiles.length === 0 && flavor === 'google' &&
        result.files.length === 1 &&
        path.resolve(file) === path.resolve(layout.modelPath(model));
    if (!inPlace) {
      const kept = new Set(targets.map(t => t && path.resolve(t.path)));
      const left = layout.profileFilePaths(model).filter(
          p => !kept.has(path.resolve(p)));
      if (left.length) {
        return fail(
            `the import does not write ${left.join(', ')}, which would stay ` +
            `beside the model; pass --out <path> to write elsewhere, or ` +
            `first remove any the model no longer uses.`);
      }
    }
  }
  const unplaced = result.files.filter((_, i) => !targets[i]);
  if (unplaced.length) {
    return fail(...unplaced.map(
        f => `the import gives '${f.fileName}', which has no place in the ` +
            `semantic-model layout.`));
  }
  const written = result.files.map((f, i) => {
    targets[i]!.write(f.content);
    return targets[i]!.path;
  });
  for (const w of written) console.log(`wrote ${w}`);
  return 0;
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
async function workspaceLayout(): Promise<SemanticModelLayout|string> {
  if (!fs.existsSync('catalog.yaml')) {
    return `there is no catalog.yaml in this directory, so there is no model ` +
        `layout to write into. Pass --out <path> to write the file directly.`;
  }
  const snapshot =
      await kcmd.CatalogSnapshot.fromPath('.', context.ApiContext.default());
  if (snapshot.manifest.source.type !== Sources.SEMANTIC_MODEL) {
    return `this catalog is not a semantic-model scope, so there is no ` +
        `model layout to write into. Run \`kcmd init --semantic-model ...\` ` +
        `first, or pass --out <path> to write the file directly.`;
  }
  return snapshot.layout as SemanticModelLayout;
}

// Refuses to write `model` into `layout`'s entry group beside another
// model's file, since an entry group holds one model.
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
export async function skillsGenerate(options: SkillsGenerateOptions = {}):
    Promise<number> {
  const ctx = context.ApiContext.default();
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
  const legacy = legacyProfileFormErrors(snapshot);
  if (legacy.length) return printErrors(...legacy);
  const named =
      typeof options.profile === 'string' ? options.profile : undefined;
  const opened = await createSemanticRuntimes({
    profile: named,
    ctx,
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

  const planned: Array<{model: string; dir: string; generated: SkillPackage;}> =
      [];
  const claimed = new Map<string, string>();
  let failed = false;
  for (const runtime of opened) {
    const generated = generateSkill({runtime, name: options.name});
    if ('error' in generated) {
      const namedErr = generated.error.startsWith(`Model '`);
      console.error(`Error: ${namedErr ? '' : `[${runtime.model.name}] `}${
          generated.error}`);
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
      console.error(`Error: [${model}] could not write under ${dir}: ${
          e instanceof Error ? e.message : String(e)}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

// Reference pages left over from an action the model no longer declares.
function stalePages(dir: string, keep: Set<string>): string[] {
  const refs = path.join(dir, 'references');
  if (!fs.existsSync(refs)) return [];
  return fs.readdirSync(refs)
      .filter(f => f.endsWith('.md'))
      .map(f => `references/${f}`)
      .filter(f => !keep.has(f));
}


// The GCP context for `validate`, `test`, `profile` and `glossary`: falls back
// to partial gcloud values so offline (`--sql-only`, `--dry-run`) runs succeed
// even when credentials or a project are absent.
function generatorContext(): context.ApiContext {
  try {
    return context.ApiContext.default();
  } catch {
    const read = (cmd: string) => {
      try {
        return cp.execSync(cmd, {stdio: ['ignore', 'pipe', 'ignore']})
            .toString()
            .trim();
      } catch {
        return '';
      }
    };
    const project = process.env.CLOUDSDK_CORE_PROJECT ||
        read('gcloud -q config get-value project');
    const token =
        read('gcloud -q auth application-default print-access-token');
    return new context.ApiContext(project, 'global', token);
  }
}

// Narrows a model's `deployments:` list to those that use `profile`, so
// downstream planners (`planContractTests`, `publishGlossary`) resolve the
// target graph for the selected profile.
function scopedToProfile(model: SemanticModel, profile: string): SemanticModel {
  if (!model.deployments) return model;
  return {
    ...model,
    deployments:
        model.deployments.filter(d => (d.profile ?? DEFAULT_PROFILE) === profile),
  };
}

// Loads the models of the semantic-model scope at `root` AS AUTHORED (selected
// binding profile applied, inheritance unresolved) for `validate`, `test`,
// `profile`, and `glossary`.
async function loadAuthoredModels(
    command: string, root: string, profileOption: string|boolean|undefined,
    ctx: context.ApiContext): Promise<{
  models: LoadedModel[]; profile: string; layout: SemanticModelLayout;
  source: SemanticModelSource;
}|{error: string}> {
  let snapshot: kcmd.CatalogSnapshot;
  try {
    snapshot = await kcmd.CatalogSnapshot.fromPath(root, ctx);
  } catch (err: any) {
    return {error: String(err?.message ?? err)};
  }
  if (snapshot.manifest.source.type !== Sources.SEMANTIC_MODEL) {
    return {error: `${command} runs in a semantic-model scope.`};
  }
  const legacy = legacyProfileFormErrors(snapshot);
  if (legacy.length) return {error: legacy[0]};

  const layout = snapshot.layout as SemanticModelLayout;
  const profileDocs = profileDocsReader(layout);
  const source = snapshot.manifest.source as SemanticModelSource;
  const named = typeof profileOption === 'string' && profileOption !== '' ?
      profileOption :
      undefined;
  const profile = named ?? DEFAULT_PROFILE;
  const docs = layout.modelDocuments();
  if (!docs.length) return {error: 'no semantic model documents found.'};
  const parserError = await sqlParserError();
  if (parserError) return {error: parserError};

  let load: DialectLoad = {};
  if (ctx.token) {
    const lookedUp = await dialectLoad(ctx, docs, profileDocs);
    if (!lookedUp) return {error: 'could not resolve source dialects.'};
    load = lookedUp;
  }

  if (profile === DEFAULT_PROFILE) {
    const loaded = loadSemanticModels(docs, {
      defaultProject: source.project ?? ctx.project,
      bindingOptional: true,
      ...load,
    });
    if (loaded.error) return {error: loaded.error};
    for (const w of loaded.warnings) console.warn(`Warning: ${w}`);
    return {models: loaded.models, profile, layout, source};
  }

  const models: LoadedModel[] = [];
  for (const doc of docs) {
    let files: ReturnType<ProfileDocs>;
    let declared: DeclaredProfile[];
    try {
      files = profileDocs(doc.name);
      declared = declaredProfiles(doc, files);
    } catch (err: any) {
      return {error: String(err?.message ?? err)};
    }
    const res = profileForDocument(doc, declared, profile, load);
    if (res.kind === 'missing') {
      return {error: unknownProfileMessage(profile, doc.name, res.declared)};
    }
    if (res.kind === 'error') {
      return {error: profileErrorMessage(doc.name, res, profile, files)};
    }
    for (const w of res.warnings) console.warn(`Warning: ${w}`);
    models.push({document: doc.name, model: res.model});
  }
  return {models, profile, layout, source};
}

function authoredStore(authored: LoadedModel, profile: string) {
  return resolveStore(authored.model, profile);
}


export interface ValidateOptions {
  /** The engine to validate against. Only `bigquery` today. */
  target?: string;
  profile?: string|boolean;
  /** Write the results to Knowledge Catalog as an aspect on entity entries. */
  publish?: boolean;
  /** Write the .sql file and manifest and stop; run nothing. */
  sqlOnly?: boolean;
  /** Directory the .sql / .json files are written to. Defaults to `validation`. */
  out?: string;
  /** Violating keys to sample per failing check. Defaults to 5. */
  examples?: string|number;
  /** BigQuery processing location (e.g. US). */
  location?: string;
  /** Also check primary keys, unique keys and foreign keys (default true). */
  structural?: boolean;
}

// Checking the model's constraints against the data its binding profile binds.
export async function validate(options: ValidateOptions = {}): Promise<number> {
  if (options.target !== 'bigquery') {
    console.error(`Error: --target must be 'bigquery'${
        options.target ? `; got '${options.target}'` : ''}.`);
    return 1;
  }
  if (options.publish && options.sqlOnly) {
    console.error('Error: --publish and --sql-only cannot be combined.');
    return 1;
  }
  const examples = options.examples === undefined ? 5 : Number(options.examples);
  if (!Number.isInteger(examples) || examples < 0) {
    console.error(`Error: --examples must be a whole number >= 0; got '${
        options.examples}'.`);
    return 1;
  }
  const outDir = options.out ?? 'validation';
  const ctx = generatorContext();

  const loaded = await loadAuthoredModels('validate', '.', options.profile, ctx);
  if ('error' in loaded) {
    console.error(`Error: ${loaded.error}`);
    return 1;
  }
  const {models, profile, source} = loaded;

  const credentials = !!ctx.token;
  const run = !options.sqlOnly && credentials;
  if (options.publish && !credentials) {
    console.error(
        'Error: --publish needs credentials ' +
        '(gcloud auth application-default login).');
    return 1;
  }
  if (!options.sqlOnly && !credentials) {
    console.warn(
        'Warning: no credentials; writing the queries only (as --sql-only).');
  }

  let failed = false;
  for (const authored of models) {
    const {model} = authored;
    const store = authoredStore(authored, profile);
    if (!('error' in store) && store.kind !== 'bigquery') {
      console.error(`Error: [${model.name}] profile '${profile}' targets ${
          store.kind}, not BigQuery.`);
      failed = true;
      continue;
    }
    const plan = bqValidation.planBigQueryValidation(
        scopedToProfile(model, profile),
        {examples, structural: options.structural !== false});
    for (const w of plan.warnings) console.warn(`Warning: [${model.name}] ${w}`);
    const skipped = bqValidation.unsupportedWarning(plan);
    if (skipped) console.warn(`Warning: ${skipped}`);

    const meta = {profile, generatedAt: new Date().toISOString()};
    const base = path.join(outDir, model.name.replace(/[^A-Za-z0-9_.-]/g, '_'));
    try {
      fs.mkdirSync(outDir, {recursive: true});
      fs.writeFileSync(
          `${base}.validation.sql`,
          bqValidation.renderValidationSql(plan, meta));
      fs.writeFileSync(
          `${base}.validation.json`,
          JSON.stringify(bqValidation.validationManifest(plan, meta), null, 2) +
              '\n');
    } catch (e) {
      console.error(`Error: [${model.name}] could not write under ${outDir}: ${
          e instanceof Error ? e.message : String(e)}`);
      failed = true;
      continue;
    }
    console.log(`Wrote ${base}.validation.sql and ${base}.validation.json (${
        plan.checks.length} checks, ${plan.unsupported.length} skipped).`);
    if (!run || !plan.checks.length) continue;

    const results = await bqValidation.runBigQueryValidation(
        plan, ctx, {location: options.location, examples});
    console.log(`\n[${model.name}] profile '${profile}'`);
    console.log(bqValidation.formatResultsTable(results));
    const checkedAt = new Date().toISOString();
    fs.writeFileSync(
        `${base}.results.json`,
        JSON.stringify({model: model.name, profile, checkedAt, results}, null, 2) +
            '\n');
    console.log(`Wrote ${base}.results.json`);
    if (results.some(r => r.status === 'error')) failed = true;

    if (options.publish) {
      const dest = {
        project: source.project,
        location: source.location,
        entryGroup: source.entryGroup,
      };
      const published = await bqValidation.publishConstraintResults(
          results, ctx, dest, {model: model.name, profile, checkedAt});
      for (const name of published.published) console.log(`Published ${name}`);
      for (const e of published.errors) {
        console.error(`Error: [${model.name}] ${e}`);
      }
      if (published.errors.length) failed = true;
    }
  }
  return failed ? 1 : 0;
}


export interface ContractTestOptions {
  /** The engine to test on. Only `bigquery` today. */
  target?: string;
  profile?: string|boolean;
  /** Directory the .sql / .json files are written to. Defaults to `contract-tests`. */
  out?: string;
  /** Write the .sql file and the manifest and stop; run nothing. */
  sqlOnly?: boolean;
  /** BigQuery processing location (e.g. US). */
  location?: string;
  /** The k of quantified paths `{1,k}` (default 10). */
  pathBound?: string|number;
  /** The scope directory (default: the working directory). */
  cwd?: string;
}

// Model-derived contract tests: `kcmd test --target bigquery`.
export async function contractTest(options: ContractTestOptions = {}):
    Promise<number> {
  if (options.target !== 'bigquery') {
    console.error(`Error: --target must be 'bigquery'${
        options.target ? `; got '${options.target}'` : ''}.`);
    return 1;
  }
  const pathBound = options.pathBound === undefined ?
      contracts.DEFAULT_PATH_BOUND :
      Number(options.pathBound);
  if (!Number.isInteger(pathBound) || pathBound < 1) {
    console.error(`Error: --path-bound must be a whole number >= 1; got '${
        options.pathBound}'.`);
    return 1;
  }
  const root = options.cwd ?? '.';
  const outDir = path.resolve(root, options.out ?? 'contract-tests');
  const ctx = generatorContext();
  const loaded = await loadAuthoredModels('test', root, options.profile, ctx);
  if ('error' in loaded) {
    console.error(`Error: ${loaded.error}`);
    return 1;
  }
  const {models, profile} = loaded;
  const credentials = !!ctx.token;
  const run = !options.sqlOnly && credentials;
  if (!options.sqlOnly && !credentials) {
    console.warn(
        'Warning: no credentials; writing the tests only (as --sql-only).');
  }

  let failed = false;
  for (const authored of models) {
    const {model} = authored;
    const store = authoredStore(authored, profile);
    if (!('error' in store) && store.kind !== 'bigquery') {
      console.error(`Error: [${model.name}] profile '${profile}' targets ${
          store.kind}, not BigQuery.`);
      failed = true;
      continue;
    }
    const plan =
        contracts.planContractTests(scopedToProfile(model, profile), {pathBound});
    for (const w of plan.warnings) console.warn(`Warning: [${model.name}] ${w}`);
    const meta = {profile, generatedAt: new Date().toISOString()};
    const base = path.join(outDir, model.name.replace(/[^A-Za-z0-9_.-]/g, '_'));
    try {
      fs.mkdirSync(outDir, {recursive: true});
      fs.writeFileSync(
          `${base}.contract.sql`, contracts.renderContractSql(plan, meta));
      fs.writeFileSync(
          `${base}.contract.json`,
          JSON.stringify(contracts.contractManifest(plan, meta), null, 2) +
              '\n');
    } catch (e) {
      console.error(`Error: [${model.name}] could not write under ${outDir}: ${
          e instanceof Error ? e.message : String(e)}`);
      failed = true;
      continue;
    }
    console.log(`Wrote ${base}.contract.sql and ${base}.contract.json (${
        plan.tests.length} tests, ${
        plan.skipped.length} element(s) not tested).`);
    if (!run) {
      for (const s of plan.skipped) {
        console.log(`  not tested: ${s.kind}:${s.subject}: ${s.reason}`);
      }
      continue;
    }
    if (!plan.tests.length) continue;

    const results = await contracts.runContractTests(
        plan, ctx, {location: options.location});
    console.log(`\n[${model.name}] profile '${profile}'${
        plan.graph ? `, graph ${plan.graph}` : ''}`);
    console.log(contracts.formatContractResults(results, plan.skipped));
    fs.writeFileSync(
        `${base}.contract-results.json`,
        JSON.stringify(
            {
              model: model.name,
              profile,
              checkedAt: new Date().toISOString(),
              results,
              skipped: plan.skipped,
            },
            null, 2) +
            '\n');
    console.log(`Wrote ${base}.contract-results.json`);
    if (results.some(r => r.status === 'fail' || r.status === 'error')) {
      failed = true;
    }
  }
  return failed ? 1 : 0;
}


export interface ProfileOptions {
  /** The engine to profile on. Only `bigquery`, the default. */
  target?: string;
  profile?: string|boolean;
  /** Directory for profile.sql, profile.json and profile.md. Defaults to `profiling`. */
  out?: string;
  /** Write profile.sql and stop; run nothing. */
  sqlOnly?: boolean;
  /** BigQuery processing location (e.g. US). */
  location?: string;
  /** Project the query jobs run (and bill) in. Defaults to the gcloud project. */
  project?: string;
  /** BigQuery job labels as `key:value`; repeatable. */
  label?: string|string[];
  /** Exit 1 when the data contradicts any statement. */
  strict?: boolean;
  /** Write the statements to Knowledge Catalog as an aspect on entity entries. */
  publish?: boolean;
  /** With --publish: print the Knowledge Catalog requests; send nothing. */
  dryRun?: boolean;
  examples?: string|number;
  windowMonths?: string|number;
  shiftFactor?: string|number;
  magnitudeOrders?: string|number;
  minWindowRows?: string|number;
  cwd?: string;
}

// Checking the model's CLAIMS against the data its binding profile binds.
export async function profile(options: ProfileOptions = {}): Promise<number> {
  const target = options.target ?? 'bigquery';
  if (target !== 'bigquery') {
    console.error(`Error: --target must be 'bigquery'; got '${target}'.`);
    return 1;
  }
  if (options.publish && options.sqlOnly) {
    console.error('Error: --publish and --sql-only cannot be combined.');
    return 1;
  }
  if (options.dryRun && !options.publish) {
    console.warn('Warning: --dry-run only applies to --publish; ignoring it.');
  }
  const planOptions = bqProfile.parseProfileOptions({
    examples: options.examples,
    windowMonths: options.windowMonths,
    shiftFactor: options.shiftFactor,
    magnitudeOrders: options.magnitudeOrders,
    minWindowRows: options.minWindowRows,
  });
  if ('error' in planOptions) {
    console.error(`Error: ${planOptions.error}.`);
    return 1;
  }
  const labels = bqProfile.parseJobLabels(options.label);
  if ('error' in labels) {
    console.error(`Error: ${labels.error}.`);
    return 1;
  }
  const outDir = options.out ?? 'profiling';
  const root = options.cwd ?? '.';
  const ctx = generatorContext();

  const loaded =
      await loadAuthoredModels('profile', root, options.profile, ctx);
  if ('error' in loaded) {
    console.error(`Error: ${loaded.error}`);
    return 1;
  }
  const {models, profile: profileName, source} = loaded;

  const credentials = !!ctx.token;
  const run = !options.sqlOnly && credentials;
  if (options.publish && !credentials) {
    console.error(
        'Error: --publish needs credentials ' +
        '(gcloud auth application-default login).');
    return 1;
  }
  if (!options.sqlOnly && !credentials) {
    console.warn(
        'Warning: no credentials; writing the queries only (as --sql-only).');
  }
  const jobProject = options.project ?? ctx.project;
  if (run && !jobProject) {
    console.error(
        'Error: no project to run the query jobs in; pass --project.');
    return 1;
  }

  let failed = false;
  const plans: bqProfile.ProfilePlan[] = [];
  for (const authored of models) {
    const {model} = authored;
    const store = authoredStore(authored, profileName);
    if (!('error' in store) && store.kind !== 'bigquery') {
      console.error(`Error: [${model.name}] profile '${profileName}' targets ${
          store.kind}, not BigQuery.`);
      failed = true;
      continue;
    }
    const plan = bqProfile.planBigQueryProfile(
        scopedToProfile(model, profileName), planOptions);
    for (const w of plan.warnings) console.warn(`Warning: [${model.name}] ${w}`);
    console.log(`[${model.name}] ${plan.checks.length} statement(s) in ${
        bqProfile.distinctQueries(plan).length} query(ies)${
        plan.skipped.length ?
            `; ${plan.skipped.length} claim(s) not profiled (listed in profile.sql)` :
            ''}.`);
    plans.push(plan);
  }
  const sqlFile = path.join(outDir, 'profile.sql');
  try {
    fs.mkdirSync(outDir, {recursive: true});
    fs.writeFileSync(
        sqlFile,
        plans.map(p => bqProfile.renderProfileSql(p, {profile: profileName}))
            .join('\n'));
  } catch (e) {
    console.error(`Error: could not write under ${outDir}: ${
        e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  console.log(`Wrote ${sqlFile}.`);
  if (!run || !plans.length) return failed ? 1 : 0;

  const checkedAt = new Date().toISOString();
  const reports: bqProfile.ProfileReport[] = [];
  let contradicted = 0;
  for (const plan of plans) {
    const outcomes = await bqProfile.runBigQueryProfile(
        plan, ctx,
        {project: jobProject, location: options.location, labels: labels.labels});
    const findings = bqProfile.evaluateProfile(plan, outcomes);
    console.log(`\n[${plan.model}] profile '${profileName}'`);
    console.log(bqProfile.formatProfileTable(findings));
    if (findings.some(f => f.error)) failed = true;
    contradicted += findings.filter(f => f.status === 'contradicted').length;
    reports.push(bqProfile.profileReport(
        plan, findings, {profile: profileName, checkedAt}));
  }
  const jsonFile = path.join(outDir, 'profile.json');
  const mdFile = path.join(outDir, 'profile.md');
  try {
    fs.writeFileSync(
        jsonFile,
        JSON.stringify(
            {profile: profileName, checkedAt, models: reports}, null, 2) +
            '\n');
    fs.writeFileSync(mdFile, bqProfile.renderProfileMarkdown(reports));
  } catch (e) {
    console.error(`Error: could not write under ${outDir}: ${
        e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  console.log(`\nWrote ${jsonFile} and ${mdFile}.`);

  if (options.publish) {
    const dest = {
      project: source.project,
      location: source.location,
      entryGroup: source.entryGroup,
    };
    for (const r of reports) {
      const published = await bqProfile.publishProfileResults(
          r.statements, ctx, dest,
          {model: r.model, profile: profileName, checkedAt},
          {dryRun: !!options.dryRun});
      for (const name of published.published) console.log(`Published ${name}`);
      if (options.dryRun) {
        console.log(`Dry run: ${published.planned.length} entry update(s) for '${
            r.model}' printed, none sent.`);
      }
      for (const e of published.errors) {
        console.error(`Error: [${r.model}] ${e}`);
      }
      if (published.errors.length) failed = true;
    }
  }
  if (options.strict && contradicted) {
    console.error(
        `Error: --strict: the data contradicts ${contradicted} statement(s).`);
    return 1;
  }
  return failed ? 1 : 0;
}

// `kcmd push --strict-profile`: profiles each model a BigQuery graph is about
// to be deployed for and returns false when the data contradicts any claim.
export async function profileGate(
    models: LoadedModel[], ctx: context.ApiContext,
    profileName: string): Promise<boolean> {
  let ok = true;
  for (const {model} of models) {
    const plan = bqProfile.planBigQueryProfile(model);
    const findings = bqProfile.evaluateProfile(
        plan, await bqProfile.runBigQueryProfile(plan, ctx));
    const counts = bqProfile.countStatuses(findings);
    const contradicted = findings.filter(f => f.status === 'contradicted');
    if (!contradicted.length) {
      console.log(`Profile gate: [${model.name}] ${counts.verified} verified, ${
          counts.unverified} unverified, none contradicted.`);
      continue;
    }
    ok = false;
    console.error(
        `Error: [${model.name}] the data bound by profile '${
            profileName}' contradicts ${contradicted.length} statement(s); ` +
        `not deploying (details: kcmd profile --profile ${profileName}):`);
    console.error(bqProfile.formatProfileTable(contradicted));
  }
  return ok;
}


export interface GlossaryOptions {
  profile?: string|boolean;
  /** Print the requests; send nothing. */
  dryRun?: boolean;
  /** Delete kcmd-managed terms / categories the spec no longer declares. */
  pruneGlossary?: boolean;
  /** Glossary project (default: catalog.yaml source project). */
  project?: string;
  /** Glossary location (default: global). */
  location?: string;
  /** Skip the definition links to the semantic entries kcmd publishes. */
  semanticLinks?: boolean;
}

// Publishing each model's `glossary` block as a Knowledge Catalog Business
// Glossary (K9; see semantic/glossary.ts).
export async function glossary(
    action: string, options: GlossaryOptions = {}): Promise<number> {
  if (action !== 'push') {
    console.error(
        `Error: unknown glossary action '${action}'; expected 'push'.`);
    return 1;
  }
  const ctx = generatorContext();
  const loaded = await loadAuthoredModels('glossary', '.', options.profile, ctx);
  if ('error' in loaded) {
    console.error(`Error: ${loaded.error}`);
    return 1;
  }
  const {source, profile: profileName} = loaded;
  if (!options.dryRun && !ctx.token) {
    console.error(
        'Error: glossary push needs credentials ' +
        '(gcloud auth application-default login); try --dry-run.');
    return 1;
  }

  let failed = false;
  let any = false;
  for (const {model, document} of loaded.models) {
    if (!model.glossary) continue;
    any = true;
    const check = checkGlossary(model);
    if (check.errors.length) {
      for (const e of check.errors) {
        console.error(`Error: model '${model.name}' (${document}): ${e}`);
      }
      failed = true;
      continue;
    }
    const scoped = scopedToProfile(model, profileName);
    const res = await publishGlossary(scoped, ctx, {
      project: options.project ?? source.project ?? ctx.project,
      location: options.location ?? 'global',
      semantic: options.semanticLinks === false ? undefined : {
        project: source.project ?? ctx.project,
        location: source.location,
        entryGroup: source.entryGroup,
      },
      dryRun: options.dryRun,
      prune: options.pruneGlossary,
    });
    const tag = `[${model.name}]`;
    for (const n of res.created) console.log(`${tag} Created ${n}`);
    for (const n of res.updated) console.log(`${tag} Updated ${n}`);
    for (const n of res.existing) console.log(`${tag} Exists ${n}`);
    for (const n of res.deleted) console.log(`${tag} Deleted ${n}`);
    if (!options.dryRun) {
      for (const s of res.skipped) console.warn(`Warning: ${tag} skipped: ${s}`);
    }
    for (const e of res.errors) console.error(`Error: ${tag} ${e}`);
    if (res.errors.length) failed = true;
    console.log(`${tag} glossary ${res.plan.glossaryName}: ${
        res.plan.requests.length} requests${options.dryRun ? ' (dry run)' : ''}`);
  }
  if (!any) console.log('No model declares a glossary; nothing to publish.');
  return failed ? 1 : 0;
}
