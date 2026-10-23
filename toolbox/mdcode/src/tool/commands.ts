// CLI command handlers
//

import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

import * as kcmd from '../libts';
import {BigQueryClient} from '../libts/gcp/bigquery';
import * as context from '../libts/gcp/context';
import * as dataplex from '../libts/gcp/dataplex';
import {SpannerClient} from '../libts/gcp/spanner';
import {fileNameOf, SemanticModelLayout} from '../libts/layouts/semantic-model';
import {convertOwlToOsi} from '../libts/semantic/converters/owl/convert';
import * as deploy from '../libts/semantic/deploy_bigquery';
import * as kc from '../libts/semantic/deploy_knowledge_catalog';
import * as deploySpannerLeg from '../libts/semantic/deploy_spanner';
import {cloudSqlDialects} from '../libts/semantic/cloudsql_dialect';
import {googleBlockTargets, googleDeploymentTargets, resolveModelDeployments, unnamedDeployments} from '../libts/semantic/deployment_target';
import {ProfileSpec, SemanticModel} from '../libts/semantic/ir';
import {FILE_COPY_TYPE_ID, FileCopy, provisionCustomTypes} from '../libts/semantic/kc_custom_types';
import {deploymentProfileError, LoadedModel, loadSemanticModels, SemanticModelError, setsAKeyTwice, writtenSource} from '../libts/semantic/loader';
import {serializeModel} from '../libts/semantic/osi_converter';
import * as pullKc from '../libts/semantic/pull_kc';
import {applyProfileExclusions, AvailabilityReport, CloudSqlLoad, DeclaredProfile, declaredProfiles, DEFAULT_PROFILE, DocumentProfile, expressionSources, inheritanceErrorOf, isLegacyWrapper, isProfileFileForm, loadProfileFile, modelFileAloneMessage, ProfileExclusion, profileErrorMessage, profileForDocument, profileSourceMessage, pruneUnavailable, reservedProfileNameError, sourcesDialect, unknownProfileMessage, validateProfileCompleteness, validateProfileConsistency,} from '../libts/semantic/resolve_profiles';
import {createSemanticRuntimes, undeclaredProfileError} from '../libts/semantic/runtime/runtime';
import {profileTargets, storeLine} from '../libts/semantic/runtime/store';
import {generateSkill, SkillPackage} from '../libts/semantic/skills';
import {loadSqlEngine} from '../libts/semantic/sql_parser';
import {transpileModels} from '../libts/semantic/transpile';
import {inlineBindingWarnings, validateBigQueryActionStatements, validateBigQueryDataSources, validateDeployments, validateExpressionReferences, validateInheritance, validateInlineDialects, validatePushRequirements, validateSpannerActionStatements} from '../libts/semantic/validate';
import {YAML_OPTIONS} from '../libts/semantic/yaml_options';
import {Sources} from '../libts/source';
import {SemanticModelSource} from '../libts/sources/semantic-model';


export interface InitOptions {
  entryGroup?: string;
  bigqueryDataset?: string|string[];
  kb?: string;
  semanticModel?: string;
  pull?: boolean;
}


// Whether Knowledge Catalog push and pull should use the second-generation
// built-in aspect fields and entry-id layout. Only `KC_V2_ASPECTS=1` enables
// it; unset, `''`, `'0'`, and `'true'` are all off.
export function kcV2Aspects(): boolean {
  return process.env.KC_V2_ASPECTS === '1';
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
  // False for `--no-deployment`, or true when it is absent. Semantic-model
  // push only.
  deployment?: boolean;
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


// Whether a model document's text declares a graph deployment target, without
// a full strict load. True when the model names one via the `deployments:` list
// (or the legacy `deployment_target:` key), or a GOOGLE custom_extension
// `deployments` or `deploymentTargets` list. Drives the push mode: a push whose
// models all declare no target governs the logical model only -- it deploys no
// graph, so bindings and a target are not required and pruning is skipped
// (Knowledge Catalog publishes the whole model). It also returns true when the
// YAML does not parse, or when the data string of a GOOGLE block on the model
// is not a JSON object, sets a key twice, or holds a `deployments` or
// `deploymentTargets` value that is not a list. The strict load then reports the problem, and the push
// does not silently take the logical path. A block whose data is not a string
// is skipped, and the load rejects it.
export function declaresGraphTarget(text: string): boolean {
  let doc: any;
  try {
    doc = yaml.parse(text, YAML_OPTIONS);
  } catch {
    return true;  // let the strict loader report the parse error
  }
  const models = Array.isArray(doc?.semantic_model) ? doc.semantic_model : [];
  for (const m of models) {
    if (typeof m?.deployment_target === 'string' &&
        m.deployment_target.trim()) {
      return true;
    }
    if (Array.isArray(m?.deployments) && m.deployments.length > 0) {
      return true;
    }
    const exts = Array.isArray(m?.custom_extensions) ? m.custom_extensions : [];
    for (const ext of exts) {
      if (ext?.vendor_name !== 'GOOGLE' || typeof ext?.data !== 'string') {
        continue;
      }
      // The rule every other reader uses: a blank target names nothing, and
      // a non-string one is a target in no accepted form, which the target
      // checks reject.
      let data: unknown;
      try {
        if (googleBlockTargets([{vendorName: 'GOOGLE', data: ext.data}], '')
                .length) {
          return true;
        }
        data = JSON.parse(ext.data);
      } catch {
        return true;  // malformed GOOGLE data: strict load will name it
      }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return true;  // not a JSON object: strict load will name it
      }
      // JSON.parse keeps the last of a repeated key, so an earlier value may
      // list a target. The strict load rejects the repeat.
      if (setsAKeyTwice(ext.data)) return true;
      const {deployments, deploymentTargets} =
          data as {deployments?: unknown; deploymentTargets?: unknown};
      if (deploymentTargets !== undefined &&
          !Array.isArray(deploymentTargets)) {
        return true;
      }
      if (Array.isArray(deployments) ? deployments.length > 0 :
                                       deployments !== undefined) {
        return true;
      }
    }
  }
  return false;
}


// True when a model declares a deployment target of the given graph type. The
// loader rejects a GOOGLE block that makes googleDeploymentTargets throw, so
// only a model built in memory reaches the catch.
function hasTargetType(
    loaded: Pick<LoadedModel, 'model'>, type: 'bigquery'|'spanner'): boolean {
  try {
    const t = googleDeploymentTargets(loaded.model);
    return type === 'bigquery' ? t.bigQuery.length > 0 : t.spanner.length > 0;
  } catch {
    return false;
  }
}

// The dialect pruning reads a model's SQL in: SPANNER when the model has a
// Spanner graph target, since that graph reads SPANNER text first, else the
// dialect its sources imply.
function pruningDialect(model: SemanticModel): string|undefined {
  return hasTargetType({model}, 'spanner') ? 'SPANNER' : sourcesDialect(model);
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
    // A caller without create permission may be refused the create of an
    // entry group that exists. A lookup tells the two apart.
    const exists = res.status === 409 ||
        (res.status === 403 &&
         (await catalog.getEntryGroup(
              source.project, source.location, source.entryGroup))
                 .status === 200);
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

  // Re-running init for the same scope leaves catalog.yaml as it was, so
  // default_profile, every other key and the comments are kept. Init for
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


// A model document with one binding profile and what applying it gave. A
// profile file, which names no deployment target, is applied to the model file
// loaded on its own: `text` is the model file's, `base` that load, `applied`
// the result and `warnings` the warnings applying it gave. A legacy
// `semantic_model:` wrapper is merged into the text, so `text` is the merged
// text and `excluded` the fields it excludes. Its `base` is the model file
// loaded on its own, or, when the model file loads only with the wrapper
// merged in, `baseError` says why it does not.
export interface ProfiledDoc {
  name: string;
  text: string;
  excluded?: ProfileExclusion[];
  allowLegacyBareSource?: boolean;
  base?: SemanticModel;
  baseError?: string;
  applied?: SemanticModel;
  warnings?: string[];
  // The concrete entities `applied` leaves with no source.
  sourceless?: string[];
}

export {isProfileFileForm};

// `doc` as push prepares it under a profile that profileForDocument applied.
// The warnings merging a legacy wrapper gives are the caller's to print.
function profiledDoc(
    doc: {name: string; text: string},
    res: Extract<DocumentProfile, {kind: 'file'|'wrapper'}>,
    load: CloudSqlLoad): ProfiledDoc {
  if (res.kind === 'file') {
    return {
      name: doc.name,
      text: doc.text,
      base: res.base,
      applied: res.model,
      warnings: res.warnings,
      sourceless: res.sourceless,
    };
  }
  // The model file as it loads on its own, which the profile checks read.
  const alone = loadSemanticModels([doc], {bindingOptional: true, ...load});
  return {
    name: doc.name,
    text: res.text,
    excluded: res.excluded,
    // A legacy `semantic_model:` wrapper may still carry `deployment_target:`
    // and bare sources.
    allowLegacyBareSource: true,
    base: alone.error ? undefined : alone.models[0].model,
    baseError: alone.error,
  };
}

// `list` with each document labeled with `profileName`, so an error names the
// profile, which may have set the value the error is about. The inline
// bindings get no label.
function withProfileLabel(
    list: LoadedModel[], profileName: string): LoadedModel[] {
  return profileName === DEFAULT_PROFILE ?
      list :
      list.map(m => ({...m, document: `${m.document}, profile '${profileName}'`}));
}

// `model` without the exclusions a profile marked on it.
function withoutExclusions(model: SemanticModel): SemanticModel {
  const out = structuredClone(model);
  for (const e of out.entities ?? []) delete e.excludedFields;
  delete out.excludedMetrics;
  return out;
}

// The fields a profile marked as excluded on `model`.
function fieldExclusionsOf(model: SemanticModel): ProfileExclusion[] {
  return (model.entities ?? []).flatMap(
      e => (e.excludedFields ?? [])
               .map(field => ({model: model.name, entity: e.name, field})));
}

// Why a graph push of `profileName` cannot go ahead because the profile is a
// named profile, or undefined when it can. A named profile is a profile file
// or a profile in a vanilla model's GOOGLE block. It names no deployment
// target, and a deployment cannot name a profile yet, so a graph push of one
// would deploy into the model file's own target, whatever system the profile
// binds.
export function profileFileGraphError(
    docs: ProfiledDoc[], profileName: string): string|undefined {
  const fileForm = docs.find(d => d.applied);
  if (!fileForm) return undefined;
  return `[${fileForm.name}] binding profile '${profileName}' is a named ` +
      `profile, which names no deployment target, and a deployment cannot ` +
      `name a profile yet; a graph push would deploy it into the model ` +
      `file's own target. Run 'kcmd push --profile default' to deploy the ` +
      `model file's own bindings, or 'kcmd push --no-profile' to publish to ` +
      `Knowledge Catalog without deploying a graph. Both need the model file's ` +
      `own bindings to be complete.`;
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

// The dialect of each Cloud SQL table the model documents `docs` and their
// profile files write as a resource name, read from the tables' Knowledge
// Catalog entries, for every load the command makes. Makes no call when no file
// writes one. Prints each table whose entry cannot be read and returns null.
async function cloudSqlLoad(
    ctx: context.ApiContext, docs: Array<{name: string; text: string}>,
    profileDocs: ProfileDocs): Promise<CloudSqlLoad|null> {
  const texts = docs.map(d => d.text);
  for (const doc of docs) {
    try {
      texts.push(...profileDocs(doc.name).map(p => p.text));
    } catch {
      // A profile file the layout rejects is reported where it is read.
    }
  }
  const {dialects, errors} =
      await cloudSqlDialects(texts, new dataplex.CatalogClient(ctx));
  if (errors.length) {
    for (const e of errors) console.error(`Error: ${e}`);
    return null;
  }
  return {cloudSqlDialects: dialects};
}

// Gives the profiles a model document declares: its profile files, then the
// profiles a vanilla model carries in its GOOGLE block.
type DeclaredProfiles = (doc: {name: string; text: string}) =>
    DeclaredProfile[];

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

// The profiles `doc` declares, read with `declared`. When the profiles in a
// vanilla model's GOOGLE blocks cannot be read, prints the same error the
// runtime returns and gives undefined. Throws when a profile file breaks a
// layout rule.
function readDeclaredProfiles(declared: DeclaredProfiles, doc: {
  name: string; text: string
}): DeclaredProfile[]|undefined {
  try {
    return declared(doc);
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
    console.error(`Error: ${err.message}`);
    return undefined;
  }
}

// The file copies of each model file and of each of its profile files: each
// file's text exactly as read, for the catalog to store, under the name
// fileNameOf gives it. Throws when a profile file breaks one of the layout's
// file rules or a file is not valid UTF-8.
function fileCopiesOf(
    layout: SemanticModelLayout, docs: {name: string; text: string}[],
    profileDocs: ProfileDocs): FileCopy[] {
  const files: FileCopy[] = [];
  for (const doc of docs) {
    const modelPath = layout.modelPath(doc.name);
    const copy =
        (localPath: string, fileName: string, content: string): FileCopy => {
          checkUtf8(localPath, fileName, content);
          return {fileName, content};
        };
    files.push(
        copy(modelPath, fileNameOf(layout, doc.name, modelPath), doc.text));
    // profileDocuments applies the file rules, so a profile file that breaks
    // one stops the push before anything is stored.
    for (const p of profileDocs(doc.name)) {
      files.push(copy(p.path, p.fileName, p.text));
    }
  }
  return files;
}

// Throws, naming the file, when the file at `localPath` is not valid UTF-8,
// since its copy could not return it byte for byte. A file read as UTF-8 has
// each invalid byte replaced by U+FFFD, so only a text holding U+FFFD needs
// its bytes checked.
function checkUtf8(localPath: string, fileName: string, text: string): void {
  if (!text.includes('\uFFFD')) return;
  try {
    new TextDecoder('utf-8', {fatal: true}).decode(fs.readFileSync(localPath));
  } catch {
    throw new Error(
        `File '${fileName}' is not valid UTF-8; push stores each model and ` +
        `profile file exactly as written, so save it as UTF-8.`);
  }
}

// The copies push stores of each model file in `docs` and of its profile
// files, read and checked locally. `error` is set instead, with push's text,
// when a copy cannot be read or fails a check.
function checkedFileCopies(
    layout: SemanticModelLayout, docs: {name: string; text: string}[],
    profileDocs: ProfileDocs): {files: FileCopy[]; error?: string} {
  let read: FileCopy[];
  try {
    read = fileCopiesOf(layout, docs, profileDocs);
  } catch (err: any) {
    return {files: [], error: `${err.message || err}`};
  }
  // One id and the number of copies on every copy this push stores let a
  // pull tell a whole set from a push that stopped partway.
  const pushId = randomUUID();
  const files = read.map(f => ({...f, pushId, pushFileCount: read.length}));
  const error = kc.checkFileCopies(files);
  return error ? {files: [], error} : {files};
}

// The models one binding profile gives for push: all of them, and those whose
// deployment target is a BigQuery graph or a Spanner graph.
interface PreparedModels {
  models: LoadedModel[];
  bqModels: LoadedModel[];
  spannerModels: LoadedModel[];
}

// Where prepareModels sends the warnings, notes and errors it finds.
interface PrepareReport {
  warning(message: string): void;
  // What a pruned profile leaves unavailable.
  note(message: string): void;
  error(message: string): void;
}

// How push prints what prepareModels finds: each message on its own line,
// after its kind.
const PUSH_REPORT: PrepareReport = {
  warning: m => console.warn(`Warning: ${m}`),
  note: m => console.warn(`Note: ${m}`),
  error: m => console.error(`Error: ${m}`),
};

// The errors the named profiles of each model in `docs` give: each profile
// file, and each profile a vanilla model carries in its GOOGLE block, checked
// on its own for completeness. An error about a profile file names that file,
// and one about a block profile names the model document.
// A model's profiles are checked against its model file as loaded, whichever
// binding `profileName` selects. `checkedByDoc`
// holds each document as push checks it: with the profile applied, or loaded
// with no profile applied. Push's own checks cover part of this for the
// binding it selects, so those rules leave that binding out. A
// legacy `semantic_model:` wrapper, and a file under the reserved name
// 'default', which no push deploys, are not read here. With `transpile`, push
// fills in BigQuery SQL for a text written only in a vendor dialect its
// translator reads. Push also checks the keys and join columns of the model
// file and of each named profile. The warnings go to `warnings`.
function namedProfileErrors(
    docs: ProfiledDoc[], checkedByDoc: Map<string, SemanticModel>,
    profileName: string, profileDocs: ProfileDocs, declared: DeclaredProfiles,
    warnings: string[], transpile: boolean, load: CloudSqlLoad): string[] {
  const errors: string[] = [];
  for (const d of docs) {
    // Each named profile, with the label its errors carry and a function that
    // reads it. declared() lists the profile files too, so only its block
    // profiles are taken from it. A block profile is already read. Its actions
    // are dropped, as loadProfileFile skips a profile file's.
    let named: Array<{name: string; label: string; read: () => ProfileSpec}>;
    try {
      named = [
        ...profileDocs(d.name).filter(p => !isLegacyWrapper(p.text)).map(p => ({
          name: p.name,
          label: p.fileName,
          read: () => loadProfileFile(p.text, p.name, {skipActions: true}),
        })),
        ...declared(d).flatMap(p => 'spec' in p ? [{
          name: p.name,
          label: d.name,
          read: () => {
            const {actions: _, ...spec} = p.spec;
            return spec;
          },
        }] : []),
      ].filter(p => p.name.toLowerCase() !== DEFAULT_PROFILE);
    } catch (err: any) {
      // A profile file that breaks one of the layout's file rules, or block
      // profiles a load rejects.
      errors.push(`${err.message || err}`);
      continue;
    }
    // The model file as loaded on its own, which is the model push checks
    // when no profile applies. It is unset when the model file loads only
    // with a legacy wrapper merged in. No profile file can apply then. A
    // profile file that does not load gives its own error, as it does beside
    // a model file that loads. Any other gives the error a push that selects
    // it gives.
    const base = d.base ?? (d.excluded ? undefined : checkedByDoc.get(d.name));
    if (!base) {
      if (d.baseError) {
        for (const p of named) {
          let error = modelFileAloneMessage(d.baseError, p.name);
          try {
            p.read();
          } catch (err) {
            if (!(err instanceof SemanticModelError)) throw err;
            error = `[${p.label}] ${err.message}`;
          }
          errors.push(error);
        }
      }
      continue;
    }
    // Actions are out of scope for the preview. Push checks a profile's
    // actions only when it applies the profile, so these checks leave them
    // out.
    const logical = {...base, actions: []};
    // Push warns about the SQL it cannot read in the model it checks, so
    // these checks leave out a warning about model file SQL that push reads
    // in the same dialect. Push stops reading what the SQL reads when that
    // model's hierarchy does not resolve, and these checks then give every
    // warning.
    const pushed = checkedByDoc.get(d.name);
    const ownSqlOnly = pushed && !inheritanceErrorOf(pushed) ? {
      dialect: sourcesDialect(pushed),
      rebound: reboundFields(base, pushed),
    } : undefined;
    const specs: ProfileSpec[] = [];
    for (const p of named) {
      const at = (m: string) => `[${p.label}] ${m}`;
      let spec: ProfileSpec;
      try {
        spec = p.read();
      } catch (err) {
        if (!(err instanceof SemanticModelError)) throw err;
        errors.push(at(err.message));
        continue;
      }
      specs.push(spec);
      const profileWarnings: string[] = [];
      errors.push(
          ...validateProfileCompleteness(logical, spec, profileWarnings, {
            applied: !!d.applied && p.name === profileName,
            ownSqlOnly,
            transpiled: transpile,
            ...load,
          }).map(at));
      warnings.push(...profileWarnings.map(at));
    }
    errors.push(...validateProfileConsistency(logical, specs, profileName)
                    .map(e => `[${d.name}] ${e}`));
  }
  return errors;
}

// The errors validateInlineDialects and validateDeployments give for each
// model file in `docs`, whichever binding push deploys. The warnings from
// inlineBindingWarnings go to `warnings`.
function modelFileBindingErrors(
    docs: ProfiledDoc[], checkedByDoc: Map<string, SemanticModel>,
    declared: DeclaredProfiles, warnings: string[],
    transpile: boolean): string[] {
  const errors: string[] = [];
  for (const d of docs) {
    const base = d.base ?? (d.excluded ? undefined : checkedByDoc.get(d.name));
    if (!base) continue;
    errors.push(
        ...validateInlineDialects(base, d.name, {transpiled: transpile}));
    let named: boolean|undefined;
    try {
      named = declared(d).some(p => p.name.toLowerCase() !== DEFAULT_PROFILE);
    } catch {
      // namedProfileErrors reports a profile that does not load.
    }
    if (named !== undefined) {
      warnings.push(...inlineBindingWarnings(base, d.name, named));
    }
    // A legacy wrapper push deploys the wrapper's bindings, not these.
    if (d.excluded) continue;
    // Push reports missing join columns itself for a model with a graph target.
    const loaded = {document: d.name, model: base};
    const joinsChecked = !d.applied &&
        (hasTargetType(loaded, 'bigquery') || hasTargetType(loaded, 'spanner'));
    errors.push(...validateDeployments(base, d.name, {joinsChecked}));
  }
  return errors;
}

// The fields of the model file `base`, each as 'Entity.field', whose SQL
// `pushed` does not keep, because the profile push applies rebinds or
// excludes them. Push never reads the model file's SQL for these.
function reboundFields(base: SemanticModel, pushed: SemanticModel): string[] {
  const sqlByField = (m: SemanticModel) => new Map((m.entities ?? []).flatMap(
      e => e.fields.map(f => [
        `${e.name}.${f.name}`, JSON.stringify(expressionSources(f)),
      ] as const)));
  const after = sqlByField(pushed);
  return [...sqlByField(base)]
      .filter(([field, sql]) => after.get(field) !== sql)
      .map(([field]) => field);
}

// Loads and validates a profile's documents into deployable models, sharing
// one IR across the push legs. `prune` drops each unbound field, and whatever
// depends on it, so a deployed graph presents only what its binding answers; a
// catalog-only push leaves it off to publish the whole logical model. Once
// the documents load and no deployment names a profile, every named profile
// the models declare is checked too: the profile files `profileDocs` reads,
// and the GOOGLE block profiles `declared` adds. So is each deployment. Runs
// local checks only. Returns the models and the target partition the graph
// legs need, or null after reporting an error.
async function prepareModels(
    docs: ProfiledDoc[], profileName: string, opts: {
      prune: boolean; defaultProject: string; profileDocs: ProfileDocs;
      declared: DeclaredProfiles;
      transpile?: boolean;
      load: CloudSqlLoad;
    },
    report: PrepareReport): Promise<PreparedModels|null> {
  const {prune, defaultProject} = opts;
  // A document a profile file applied to is already loaded. Its
  // exclusions are marked; a catalog-only push publishes the whole logical
  // model, so they come off again there.
  const loaded = loadSemanticModels(
      docs.filter(d => !d.applied),
      {defaultProject, bindingOptional: !prune, ...opts.load});
  if (loaded.error) {
    // A legacy wrapper's merged text may be what fails to load.
    report.error(
        profileName === DEFAULT_PROFILE ?
            loaded.error :
            `profile '${profileName}': ${loaded.error}`);
    return null;
  }
  // In the order of the documents, as one load of them all gives. The
  // load prefixes each warning with its document's name.
  const warnings = docs.flatMap(
      d => d.applied ?
          d.warnings ?? [] :
          loaded.warnings.filter(w => w.startsWith(`[${d.name}] `)));
  for (const w of warnings) {
    if (opts.transpile && w.includes('needs transpilation')) continue;
    report.warning(w);
  }
  // A pruned push needs every concrete entity bound. The load above checks
  // a legacy wrapper's merged text; a profile file's applied model is
  // checked here.
  if (prune) {
    const sourceless = docs.flatMap(
        d => (d.sourceless ?? [])
                 .map(
                     e => `[${d.name}] profile '${profileName}': ${
                         profileSourceMessage(e)}`));
    if (sourceless.length) {
      for (const e of sourceless) report.error(e);
      return null;
    }
  }
  // A validation error names the profile, which may have set the value
  // the error is about.
  const labeled = (list: LoadedModel[]) => withProfileLabel(list, profileName);
  const loadedByDoc = new Map(loaded.models.map(m => [m.document, m]));
  let models: LoadedModel[] = docs.map(
      d => d.applied ?
          {document: d.name,
           model: prune ? d.applied : withoutExclusions(d.applied)} :
          loadedByDoc.get(d.name)!);
  const depProfileErr = deploymentProfileError(models);
  if (depProfileErr) {
    report.error(depProfileErr);
    return null;
  }
  // The fields and metrics a legacy wrapper excludes, by document.
  const excludedByDoc =
      new Map(docs.map(d => [d.name, d.excluded ?? []] as const));
  // Each document as push checks it below, with a legacy wrapper's exclusions
  // marked on a pruned push.
  const checkedByDoc = new Map(models.map(({document, model}) => {
    const excluded = prune ? excludedByDoc.get(document) ?? [] : [];
    return [document, applyProfileExclusions(model, excluded)] as const;
  }));
  const unprunedWarnings: string[] = [];
  const profileErrors = [
    ...namedProfileErrors(
        docs, checkedByDoc, profileName, opts.profileDocs, opts.declared,
        unprunedWarnings, !!opts.transpile, opts.load),
    ...modelFileBindingErrors(
        docs, checkedByDoc, opts.declared, unprunedWarnings, !!opts.transpile),
  ];
  let unprunedErrors: string[] = [];
  if (opts.transpile) {
    const transpiled = await transpileModels(models);
    models = transpiled.models;
    for (const w of transpiled.warnings) report.warning(w);
  }
  if (prune) {
    // A profile's exclusions apply to the entity that names each one, which
    // the merged document cannot say on its own. Only a
    // pruned push applies them: a catalog-only push publishes the whole
    // logical model.
    const marked = models.map(({document, model}) => ({
                                document,
                                model: applyProfileExclusions(
                                    model, excludedByDoc.get(document) ?? []),
                              }));
    // Pruning can remove the field an inheritance, concrete-leaf, or
    // expression-reference rule is about, so those rules also run on the
    // model before pruning.
    unprunedErrors = [
      ...validateInheritance(labeled(marked)),
      ...validateExpressionReferences(labeled(marked), false, unprunedWarnings),
    ];
    const availability: AvailabilityReport[] = [];
    models = marked.map(({document, model}) => {
      const {model: pruned, report: r} =
          pruneUnavailable(model, profileName, pruningDialect(model));
      availability.push(r);
      return {document, model: pruned};
    });
    // Pruning never removes an entity or a relationship: their key and join
    // columns are physical columns, not fields. So the note counts what
    // pruning can make unavailable: fields, metrics and actions.
    for (const r of availability) {
      const dropped = r.droppedMetrics.length + r.droppedActions.length;
      if (r.unboundFields.length || r.droppedFields.length || dropped) {
        report.note(
            `profile '${r.profile}' leaves ${
                r.unboundFields.length} field(s) unbound` +
            (r.droppedFields.length ?
                 `; ${r.droppedFields.length} field(s) that read them ` +
                     `unavailable` :
                 '') +
            (dropped ?
                 `; ${r.droppedMetrics.length} metric(s) and ${
                     r.droppedActions.length} action(s) unavailable` :
                 '') +
            '.');
      }
    }
  }
  const pushWarnings: string[] = [];
  // The exclusions a catalog-only push does not apply: a profile file's,
  // taken off above, and a legacy wrapper's. The check that each inherited
  // field holds SQL still honors them.
  const liftedExclusions = prune ?
      [] :
      docs.flatMap(
          d => d.applied ? fieldExclusionsOf(d.applied) : d.excluded ?? []);
  // The pruned model can only repeat an unpruned error, so each is
  // reported once.
  const validationErrors = [...new Set([
    ...profileErrors,
    ...unprunedErrors,
    ...validatePushRequirements(labeled(models), {
      targetOptional: !prune,
      fieldsPruned: prune,
      warnings: pushWarnings,
      liftedExclusions,
    }),
  ])];
  for (const w of new Set([...unprunedWarnings, ...pushWarnings])) {
    report.warning(w);
  }
  if (validationErrors.length) {
    for (const e of validationErrors) report.error(e);
    return null;
  }
  const bqModels = models.filter(m => hasTargetType(m, 'bigquery'));
  const spannerModels = models.filter(m => hasTargetType(m, 'spanner'));
  return {models, bqModels, spannerModels};
}

// Warns about each model whose model file is not named after it, when push
// stores file copies. Pull writes a model to `<model>.yaml`, so it returns the
// copy of a model file only under that name.
function warnModelFileNames(
    models: LoadedModel[], fileCopies: FileCopy[]): void {
  for (const {document, model} of models) {
    if (!fileCopies.length || document === model.name) continue;
    console.warn(
        `Warning: [${model.name}] model file '${document}.yaml' is not ` +
        `named '${model.name}.yaml'. The file copy can only return a ` +
        `model file named after its model, so pull will rebuild ` +
        `'${model.name}.yaml' from the catalog instead of returning this ` +
        `file; rename it '${model.name}.yaml' to keep it exact.`);
  }
}

// The errors `kcmd push --profile <profileName>` gives for one model document,
// from its local checks alone. `doc` is the document as push prepares it under
// that profile. Push deploys a graph for a document that declares a deployment
// target and checks it pruned. Otherwise it publishes to Knowledge Catalog only
// and checks the whole model. A graph push of a profile file is refused before
// any check runs. Push's checks on the copies it stores of the model and
// profile files run once for the scope, in profiles(). Its lookup of their type
// is left out. `profileDocs` reads the model's profile files, and `declared`
// its declared profiles, like the readers push builds.
async function pushErrors(
    doc: ProfiledDoc, profileName: string, defaultProject: string,
    ctx: context.ApiContext, profileDocs: ProfileDocs,
    declared: DeclaredProfiles, load: CloudSqlLoad): Promise<string[]> {
  const graph = declaresGraphTarget(doc.text);
  const refused = graph ? profileFileGraphError([doc], profileName) : undefined;
  if (refused) return [refused];
  const errors: string[] = [];
  const prepared = await prepareModels(
      [doc], profileName,
      {prune: graph, defaultProject, profileDocs, declared, load},
      {
        warning: () => {},
        note: () => {},
        error: e => errors.push(e),
      });
  if (!prepared || !graph) return errors;
  // Push then generates each graph's DDL. Under --validate-only,
  // deployBigQuery and deploySpanner only generate the DDL and call no service.
  const legs = [
    [prepared.bqModels, deploy.deployBigQuery],
    [prepared.spannerModels, deploySpannerLeg.deploySpanner],
  ] as const;
  for (const [models, deployLeg] of legs) {
    if (!models.length) continue;
    try {
      const result = await deployLeg(models, ctx, {validateOnly: true});
      if (!result.success) {
        errors.push(result.details ?? 'the graph could not be generated');
      }
    } catch (err: any) {
      errors.push(err.message || String(err));
    }
  }
  return errors;
}

export async function push(options: PushOptions): Promise<number> {
  const ctx = context.ApiContext.default();
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);

  if (snapshot.manifest.source.type === Sources.SEMANTIC_MODEL) {
    // The semantic-model source always resolves to the SemanticModel layout
    // (see createLayout), so this cast is safe.
    const layout = snapshot.layout as SemanticModelLayout;
    const source = snapshot.manifest.source as SemanticModelSource;
    const layoutDocs = layout.modelDocuments();
    const profileDocs = profileDocsReader(layout);
    // Reading a GOOGLE block profile checks its field bindings for SQL, which
    // needs the SQL parser.
    if (!await sqlParserReady()) return 1;
    if (options.deployment === false) {
      return pushInTwoPhases(options, {
        ctx,
        layout,
        source,
        docs: layoutDocs,
        profileDocs,
        defaultProfile: snapshot.manifest.defaultProfile,
      });
    }

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

    const declared = declaredProfilesReader(profileDocs);
    const defaultProject = source.project ?? ctx.project;

    // Knowledge Catalog records one canonical view of the logical model: the
    // single --profile selection, else the default binding.
    const kcProfileName =
        namedProfile ?? snapshot.manifest.defaultProfile ?? DEFAULT_PROFILE;

    // A Cloud SQL table written as its resource name takes its dialect from its
    // Knowledge Catalog entry, looked up once before anything loads.
    const load = await cloudSqlLoad(ctx, layoutDocs, profileDocs);
    if (!load) return 1;

    // Reserve the profile name 'default': it is the sentinel for the inline
    // bindings (never merged onto the document), so a
    // `<model>.profiles/default.yaml` would be silently unreachable. Reject it
    // rather than let it sit there doing nothing. Only when the push may apply
    // a profile: a graph push may, and a catalog-only --no-profile push applies
    // the default_profile catalog.yaml names. A --no-profile push with no
    // default_profile applies none, so it does not police their names here. It
    // still reads every profile file to check it, and to store it when
    // KC_V2_ASPECTS is off, so the layout's file rules apply then too. The
    // profile checks skip a file under the reserved name. A push that may apply
    // a profile reads every model's profiles here, so GOOGLE block profiles
    // that cannot be read stop it with exit 1.
    if (graphEnabled || kcProfileName !== DEFAULT_PROFILE) {
      for (const doc of layoutDocs) {
        const docProfiles = readDeclaredProfiles(declared, doc);
        if (!docProfiles) return 1;
        const clash = reservedProfileNameError(doc.name, docProfiles);
        if (clash) {
          console.error(`Error: ${clash}`);
          return 1;
        }
      }
    }

    // Apply one binding profile to every model document, returning the docs
    // (or null after reporting an error): a profile file is applied to the
    // loaded model file, and a legacy wrapper is merged into its text. The
    // implicit 'default' profile is the inline document as authored, so
    // nothing is applied. With
    // `skipMissing` (the --all-profiles fan-out) a model that does not define
    // the profile is dropped from the result rather than erroring -- the
    // profile name came from another model in the group and is not this one's
    // concern; without it (an explicit --profile) a missing profile is an
    // error.
    const docsForProfile = (profileName: string, {skipMissing = false} = {}):
        ProfiledDoc[]|null => {
          if (profileName === DEFAULT_PROFILE) return layoutDocs;
          const out: ProfiledDoc[] = [];
          for (const doc of layoutDocs) {
            // A profile file applies to the model file loaded on its own,
            // since its sources may all be in profile files.
            const docProfiles = readDeclaredProfiles(declared, doc);
            if (!docProfiles) return null;
            const res =
                profileForDocument(doc, docProfiles, profileName, load);
            if (res.kind === 'missing') {
              if (skipMissing) continue;
              console.error(`Error: ${
                  unknownProfileMessage(profileName, doc.name, res.declared)}`);
              return null;
            }
            if (res.kind === 'error') {
              console.error(`Error: ${
                  profileErrorMessage(
                      doc.name, res, profileName, profileDocs(doc.name))}`);
              return null;
            }
            if (res.kind === 'wrapper') {
              for (const w of res.warnings) {
                console.warn(`Warning: [${doc.name}] ${w}`);
              }
            }
            out.push(profiledDoc(doc, res, load));
          }
          return out;
        };

    // Apply + prepare a profile once and reuse it. The graph leg and the
    // Knowledge Catalog leg both consume the default binding, so without this a
    // bound `kcmd push` would load, transpile, prune, and validate the same
    // profile twice -- and print every loader/transpile warning twice. Keyed by
    // the inputs that change the result: profile name, prune, and (since
    // --all-profiles may prepare a filtered subset of the documents) the set of
    // document names.
    const docsCache = new Map<string, ProfiledDoc[]|null>();
    const docsOnce = (profileName: string, skipMissing: boolean) => {
      const key = `${profileName}|${skipMissing}`;
      if (docsCache.has(key)) return docsCache.get(key)!;
      const docs = docsForProfile(profileName, {skipMissing});
      docsCache.set(key, docs);
      return docs;
    };
    const prepareCache = new Map<string, PreparedModels|null>();
    // --all-profiles prepares several bindings, and each one checks every
    // profile file again, so a warning prints the first time only.
    const warned = new Set<string>();
    // Pruning notes, printed once the checks before the deploy loop pass.
    const pruningNotes: string[] = [];
    const report: PrepareReport = {
      ...PUSH_REPORT,
      warning: m => {
        if (!warned.has(m)) PUSH_REPORT.warning(m);
        warned.add(m);
      },
      note: m => pruningNotes.push(m),
    };
    const prepareOnce = async(
        docs: ProfiledDoc[], profileName: string,
        prune: boolean): Promise<PreparedModels|null> => {
      const key =
          `${profileName}|${prune}|${docs.map(d => d.name).sort().join(',')}`;
      if (prepareCache.has(key)) return prepareCache.get(key)!;
      const prepared = await prepareModels(
          docs, profileName,
          {
            prune,
            defaultProject,
            profileDocs,
            declared,
            transpile: options.transpile,
            load,
          },
          report);
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
          for (const p of declared(doc)) names.add(p.name);
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
    // a fail-fast push stops before later legs). Only the documents that, with
    // the profile, declare a deployment target contribute a graph; the rest are
    // left to the Knowledge Catalog leg (a profile that binds no target at all
    // is skipped). The live BigQuery pre-flight runs before each BigQuery
    // deploy so a push fails fast when a source table is unreachable; it also
    // runs under
    // --validate-only. A deployment target may be claimed by only one model
    // and profile in a run: two profiles, or two model files under one
    // profile, pointing at the same graph would have the second CREATE OR
    // REPLACE silently overwrite the first, so that is an error rather than
    // last-write-wins.
    const multiProfile = graphProfileNames.length > 1;
    // Target URI -> the profile and model that claimed it first.
    const claimedTargets = new Map<string, {profile: string; model: string}>();
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
    // Prepare every selected profile, and check every collision, before the
    // first graph deploys, so a push that fails one of those checks replaces no
    // graph. The live checks against each backend still run inside the deploy
    // loop, one profile at a time.
    const graphPlans: Array<{profileName: string; prepared: PreparedModels}> =
        [];
    for (const profileName of graphProfileNames) {
      // --all-profiles fans out over every model's profiles, so a model that
      // does not define this one is dropped (skipMissing) rather than failing
      // the run; a single --profile / default push keeps every model.
      const profiled = docsOnce(profileName, allProfiles);
      if (!profiled) return 1;
      const docs = profiled.filter(d => declaresGraphTarget(d.text));
      if (!docs.length) {
        skippedProfiles.push(profileName);
        continue;
      }
      const blocked = profileFileGraphError(docs, profileName);
      if (blocked) {
        console.error(`Error: ${blocked}`);
        return 1;
      }
      const prepared = await prepareOnce(docs, profileName, true);
      if (!prepared) return 1;
      for (const d of docs) loadedDocs.add(d.name);
      noteCatalogOnly(prepared.models);
      for (const m of prepared.models) {
        for (const uri of deploy.deploymentTargetUris(m.model)) {
          const first = claimedTargets.get(uri);
          if (first !== undefined) {
            console.error(
                `Error: model '${first.model}' under binding profile '${
                    first.profile}' and model '${
                    m.model.name}' under binding profile '${profileName}' ` +
                `both deploy to the same graph '${uri}'; give each its own ` +
                `deployment target (the second would overwrite the first).`);
            return 1;
          }
          claimedTargets.set(uri, {profile: profileName, model: m.model.name});
        }
      }
      graphPlans.push({profileName, prepared});
    }
    // Prepares the catalog leg under kcProfileName. prepareOnce keeps the
    // result, so preparing it early costs nothing.
    const prepareKc = async(): Promise<PreparedModels|null> => {
      const docs = docsOnce(kcProfileName, false);
      if (!docs) return null;
      const prune = graphEnabled && docs.some(d => declaresGraphTarget(d.text));
      return prepareOnce(docs, kcProfileName, prune);
    };
    // Runs the catalog leg's local checks and the one-model check before any
    // graph deploys, so a push that fails them replaces no graph.
    if (kcEnabled) {
      const prepared = await prepareKc();
      if (!prepared) return 1;
      if (prepared.models.length > 1) {
        PUSH_REPORT.error(kc.oneModelPerEntryGroupMessage(
            source.entryGroup, prepared.models.length));
        return 1;
      }
    }
    // Under --no-kc, the loop above already loaded every document that
    // contributes a graph. The rest load here, before any graph deploys, so a
    // push that fails one of their checks replaces no graph. That is usually
    // none, and a model that does not define this profile is skipped rather
    // than failing a warning.
    if (!kcEnabled) {
      const rest = (docsOnce(kcProfileName, true) ?? [])
                       .filter(d => !loadedDocs.has(d.name));
      if (rest.length) {
        const prepared = await prepareOnce(rest, kcProfileName, false);
        // prepareModels has already printed why it failed. Ignoring that here
        // would report a successful push over its own error output, and the
        // same document fails the default push through the Knowledge Catalog
        // leg, so --no-kc fails on it too.
        if (!prepared) return 1;
        noteCatalogOnly(prepared.models);
      }
    }

    // With KC_V2_ASPECTS off, the catalog leg stores the model file and every
    // profile file as read, whichever profile this push selects, so a pull
    // can return them all. Reading them under --no-profile too keeps a push
    // from dropping a stored profile copy. They are read and checked, and the
    // type that holds them is looked up, before any graph deploys and under
    // --validate-only too. The catalog leg then does not look the type up
    // again. With more than one model document, push has stopped above.
    let fileCopies: FileCopy[] = [];
    if (kcEnabled && !kcV2Aspects() && layoutDocs.length === 1) {
      const copies = checkedFileCopies(layout, layoutDocs, profileDocs);
      const problem = copies.error ??
          await kc.checkCustomTypes(
              new dataplex.CatalogClient(ctx), source, [FILE_COPY_TYPE_ID]);
      if (problem) {
        console.error(`Error: ${problem}`);
        return 1;
      }
      fileCopies = copies.files;
    }
    for (const n of pruningNotes) PUSH_REPORT.note(n);

    for (const {profileName, prepared} of graphPlans) {
      if (multiProfile) console.log(`\n-- Binding profile '${profileName}' --`);
      if (prepared.bqModels.length) {
        const bq = new BigQueryClient(ctx);
        const accessErrors = await validateBigQueryDataSources(
            withProfileLabel(prepared.bqModels, profileName), bq,
            defaultProject);
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
            withProfileLabel(prepared.bqModels, profileName), bq,
            defaultProject);
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
            withProfileLabel(prepared.spannerModels, profileName),
            new SpannerClient(ctx));
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
      for (const [name, n] of catalogOnly) {
        console.warn(`Warning: ${catalogOnlyWarning(name, n)}`);
      }
    }

    // Alongside a graph deploy the catalog entries reflect the binding
    // (pruned to what it answers); a catalog-only --no-profile push publishes
    // the whole logical model unpruned.
    if (kcEnabled) {
      const prepared = await prepareKc();
      if (!prepared) return 1;
      warnModelFileNames(prepared.models, fileCopies);
      const code = await pushKnowledgeCatalog(
          prepared.models, ctx, options, source, fileCopies);
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
    [options.deployment === false, '--no-deployment'],
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


// The error for a flag the two-phase path does not take, or undefined.
function twoPhaseFlagError(options: PushOptions): string|undefined {
  if (options.kc === false) {
    return `'--no-kc' is not supported; every push publishes the model to ` +
        `Knowledge Catalog.`;
  }
  const ownProfile = `does not apply to a push that uses deployments, since ` +
      `each deployment names its own profile.`;
  // cac passes a numeric profile name as a number, so any value but a boolean
  // counts.
  if (options.profile !== undefined && options.profile !== true &&
      options.profile !== false) {
    return `'--profile' ${ownProfile}`;
  }
  if (options.allProfiles) {
    return `'--all-profiles' ${ownProfile}`;
  }
  if (options.profile === false) {
    return `'--no-profile' does not apply to a push that uses deployments. ` +
        `Use '--no-deployment' to publish to Knowledge Catalog only.`;
  }
  return undefined;
}

// What the two-phase path reads: the scope and its model documents.
interface TwoPhaseScope {
  ctx: context.ApiContext;
  layout: SemanticModelLayout;
  source: SemanticModelSource;
  docs: {name: string; text: string}[];
  profileDocs: ProfileDocs;
  // The default_profile catalog.yaml names, if any.
  defaultProfile?: string;
  load: CloudSqlLoad;
}

// Runs checkBeforeWrites and the checks that call a service, then publishes to
// Knowledge Catalog when every check passes. Returns a process exit code.
async function pushInTwoPhases(
    options: PushOptions, scope: Omit<TwoPhaseScope, 'load'>): Promise<number> {
  const {ctx, source} = scope;
  const fail = (...errors: string[]) => {
    for (const e of errors) console.error(`Error: ${e}`);
    return 1;
  };
  const flagError = twoPhaseFlagError(options);
  if (flagError) return fail(flagError);
  const load = await cloudSqlLoad(ctx, scope.docs, scope.profileDocs);
  if (!load) return 1;
  const checked = await checkBeforeWrites(options, {...scope, load});
  if (!checked) return 1;
  const {kcModels, fileCopies} = checked;
  if (fileCopies.length) {
    const problem = await kc.checkCustomTypes(
        new dataplex.CatalogClient(ctx), source, [FILE_COPY_TYPE_ID]);
    if (problem) return fail(problem);
  }
  warnModelFileNames(kcModels, fileCopies);
  const kcOptions = catalogDeployOptions(options, source, fileCopies);
  const preflight =
      await kc.preflightKnowledgeCatalog(kcModels, ctx, kcOptions);
  const preflightWarnings =
      preflight.prepared?.warnings ?? preflight.result?.warnings ?? [];
  for (const w of preflightWarnings) console.warn(`Warning: ${w}`);
  if (preflight.result && !preflight.result.success) {
    return reportCatalogResult(preflight.result, options);
  }
  if (options.validateOnly) {
    return reportCatalogResult(preflight.result!, options);
  }
  console.log('Pushing semantic model (Knowledge Catalog)...');
  const published =
      await kc.applyKnowledgeCatalog(preflight.prepared!, ctx, kcOptions);
  return reportCatalogResult(published, options);
}

// The local checks of a two-phase push, which call no service: it stops at
// the first check that fails, and returns the models the catalog receives and
// the file copies it stores, or undefined after printing why push stops.
async function checkBeforeWrites(options: PushOptions, scope: TwoPhaseScope):
    Promise<{kcModels: LoadedModel[]; fileCopies: FileCopy[]}|undefined> {
  const {ctx, layout, source, docs, profileDocs, load} = scope;
  const fail = (...errors: string[]) => {
    for (const error of new Set(errors)) console.error(`Error: ${error}`);
    return undefined;
  };
  // Prints a warning, except the loader's 'needs transpilation' warnings
  // under --transpile.
  const warn = (w: string) => {
    if (options.transpile && w.includes('needs transpilation')) return;
    console.warn(`Warning: ${w}`);
  };

  const defaultProject = source.project ?? ctx.project;
  // A model file may leave every source to its profile files, so a source is
  // required only once a deployment's profile is applied.
  const loaded = loadSemanticModels(
      docs, {defaultProject, bindingOptional: true, ...load});
  if (loaded.error) return fail(loaded.error);
  for (const w of loaded.warnings) warn(w);
  if (loaded.models.length > 1) {
    return fail(kc.oneModelPerEntryGroupMessage(
        source.entryGroup, loaded.models.length));
  }
  const models: LoadedModel[] = [];
  for (const base of loaded.models) {
    const model = withProfileFiles(base, profileDocs);
    if ('error' in model) return fail(model.error);
    models.push(model);
  }
  // Every profile each model declares, legacy wrappers included.
  const declaredBy = declaredProfilesReader(profileDocs);
  const declaredNames = (document: string) =>
      declaredBy(docs.find(d => d.name === document)!).map(p => p.name);
  // With KC_V2_ASPECTS off, the catalog stores each model file and profile
  // file as read.
  let fileCopies: FileCopy[] = [];
  if (!kcV2Aspects() && docs.length === 1) {
    const copies = checkedFileCopies(layout, docs, profileDocs);
    if (copies.error) return fail(copies.error);
    fileCopies = copies.files;
  }

  // Every deployment's target must be in an accepted form, and its profile one
  // the model declares.
  for (const {document, model} of models) {
    const every = resolveModelDeployments(model);
    if ('error' in every) return fail(every.error);
    const undeclared = undeclaredProfileError(
        document, model, declaredNames(document));
    if (undeclared) return fail(undeclared);
  }
  const byDefault = defaultProfileCheck(scope, models, declaredBy);
  if ('error' in byDefault) return fail(byDefault.error);

  // Every named profile is checked on its own against the model file, and so
  // are the model file's own bindings and each deployment. The catalog's model
  // is checked as a model that deploys nowhere, though one with no deployments
  // list keeps its GOOGLE block targets.
  const profileWarnings: string[] = [];
  const profileErrors = namedProfileErrors(
      docs, new Map(loaded.models.map(m => [m.document, m.model])),
      DEFAULT_PROFILE, profileDocs, declaredBy, profileWarnings,
      !!options.transpile, load);
  for (const {document, model} of models) {
    profileErrors.push(
        ...validateInlineDialects(
            model, document, {transpiled: !!options.transpile}),
        ...validateDeployments(model, document));
    const named =
        declaredNames(document).some(n => n.toLowerCase() !== DEFAULT_PROFILE);
    profileWarnings.push(...inlineBindingWarnings(model, document, named));
  }
  let kcModels = models;
  if (options.transpile) {
    const transpiled = await transpileModels(kcModels);
    kcModels = transpiled.models;
    for (const w of transpiled.warnings) warn(w);
  }
  const kcWarnings: string[] = [];
  const kcErrors = kcModels.flatMap(
      m => validatePushRequirements(
          [m.model.deployments === undefined ?
               m :
               {...m, model: {...m.model, deployments: []}}],
          {targetOptional: true, warnings: kcWarnings}));
  for (const w of [...profileWarnings, ...kcWarnings]) warn(w);
  if (profileErrors.length || kcErrors.length) {
    return fail(...profileErrors, ...kcErrors);
  }

  return {kcModels, fileCopies};
}

// Adds the profile files of the model in `base` to `model.profiles`, without
// their actions or a legacy `semantic_model:` wrapper. Returns the error of the
// first profile file that breaks a file rule. A profile file that does not load
// is left out, for namedProfileErrors to report.
function withProfileFiles(base: LoadedModel, profileDocs: ProfileDocs):
    LoadedModel|{error: string} {
  const {document, model} = base;
  const profiles = [...(model.profiles ?? [])];
  let files: ReturnType<ProfileDocs>;
  try {
    files = profileDocs(document);
  } catch (err: any) {
    return {error: err.message || String(err)};
  }
  const reserved = reservedProfileNameError(document, files);
  if (reserved) return {error: reserved};
  for (const p of files) {
    if (isLegacyWrapper(p.text)) continue;
    try {
      profiles.push(loadProfileFile(p.text, p.name, {skipActions: true}));
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
    }
  }
  return {document, model: profiles.length ? {...model, profiles} : model};
}

// Checks that each model declares catalog.yaml's default_profile, since the
// runtime refuses a scope whose default_profile a model lacks.
function defaultProfileCheck(
    scope: TwoPhaseScope, models: LoadedModel[], declaredBy: DeclaredProfiles):
    {error: string}|{} {
  const {defaultProfile, docs, load} = scope;
  if (defaultProfile === undefined || defaultProfile === DEFAULT_PROFILE) {
    return {};
  }
  for (const {document} of models) {
    const doc = docs.find(d => d.name === document)!;
    const res = profileForDocument(doc, declaredBy(doc), defaultProfile, load);
    if (res.kind === 'missing') {
      return {
        error: unknownProfileMessage(defaultProfile, document, res.declared),
      };
    }
  }
  return {};
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

  // One line, because the caller is `STORE=$(kcmd profiles --print-store)` and
  // a second line makes that variable address the wrong database. A scope
  // holding several models has no single answer, so it says so instead,
  // before any AlloyDB lookup.
  const opened =
      await createSemanticRuntimes({profile: named, ctx, oneModel: true});
  if ('error' in opened) {
    console.error(`Error: ${opened.error}`);
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


// Prints a profile's report under its header: the deployment target, the
// source each entity binds to, and what the profile cannot answer or cannot
// run.
function printProfileReport(
    model: SemanticModel, name: string, fileForm: boolean): void {
  // The targets the profile's deployments name, as --print-store reads them.
  let targets: string[] = [];
  try {
    targets = profileTargets(model, name, {legacyWrapper: !fileForm});
  } catch {
    // A GOOGLE block that is not valid JSON is a push-time error; here just
    // show none rather than abort the listing.
  }
  // Pruned for the graphs this profile's own deployments name.
  const {report} = pruneUnavailable(
      model, name,
      pruningDialect({...model, deployments: unnamedDeployments(targets)}));
  const none = fileForm ? '(none; no deployment names this profile)' : '(none)';
  console.log(`    target: ${targets.length ? targets.join(', ') : none}`);
  console.log('    sources:');
  for (const e of model.entities ?? []) {
    console.log(`      ${e.name} -> ${writtenSource(e) || '(unbound)'}`);
  }

  const withheld: string[] = [];
  const excludedHere = new Set((model.entities ?? []).flatMap(
      e => (e.excludedFields ?? []).map(f => `${e.name}.${f}`)));
  for (const f of report.unboundFields) {
    withheld.push(
        `field ${f} (${excludedHere.has(f) ? 'excluded' : 'unbound'})`);
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
// report), then each error `kcmd push --profile <name>` would give. Read-only:
// it applies and prunes each profile and runs push's local checks the way push
// does, but deploys nothing, so a user can see coverage and whether push
// accepts a profile before choosing one. Its one service call is push's Cloud
// SQL dialect lookup. Returns a process exit code (0 on success).
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
  const defaultProject = source.project ?? ctx.project;
  const profileDocs = profileDocsReader(layout);
  const declaredBy = declaredProfilesReader(profileDocs);
  // A Cloud SQL table written as its resource name takes its dialect from its
  // Knowledge Catalog entry, looked up once, as push does.
  const load = await cloudSqlLoad(ctx, docs, profileDocs);
  if (!load) return 1;
  const errorsFor = (doc: ProfiledDoc, name: string) =>
      pushErrors(doc, name, defaultProject, ctx, profileDocs, declaredBy, load);
  // The inline bindings' header. 'default' is not a profile document and
  // never can be -- a push rejects a file by that name. It names the inline
  // bindings, which every model has.
  const inlineHeader =
      `  profile '${DEFAULT_PROFILE}': the model document's own inline ` +
      `bindings, as authored -- nothing merged, nothing withheld.`;
  // Prints the warnings push gives about the model file's own bindings in
  // `doc`, unless the model file does not load on its own.
  const warnInline = (doc: {name: string; text: string}, named: boolean) => {
    const loaded =
        loadSemanticModels([doc], {defaultProject, bindingOptional: true});
    if (loaded.error) return;
    for (const w of inlineBindingWarnings(
             loaded.models[0].model, doc.name, named)) {
      console.warn(`  profile '${DEFAULT_PROFILE}': warning: ${w}`);
    }
  };

  // The profiles are read before anything prints, as a graph push reads them.
  // A profile file that breaks a layout rule throws. When a model's GOOGLE
  // block profiles cannot be read, the error is printed and the command exits
  // 1.
  for (const doc of docs) {
    if (!readDeclaredProfiles(declaredBy, doc)) return 1;
  }
  // Push publishes to Knowledge Catalog one model per entry group.
  if (docs.length > 1) {
    printRejects(
        '', [kc.oneModelPerEntryGroupMessage(source.entryGroup, docs.length)]);
  }
  // With KC_V2_ASPECTS off, push stores a copy of the model file and of each
  // profile file, and checks the copies before any graph deploys. Its lookup
  // of the type that holds them calls a service, so it runs only at push time.
  if (!kcV2Aspects() && docs.length === 1) {
    const {error} = checkedFileCopies(layout, docs, profileDocs);
    if (error) printRejects('', [error]);
  }

  for (const doc of docs) {
    console.log(`Model '${doc.name}' (${source.entryGroup}):`);
    const modelProfiles = declaredBy(doc);
    const modelErrors: string[] = [];
    // Push refuses every graph push while a model declares a profile named
    // 'default', whichever binding it deploys.
    const reserved = reservedProfileNameError(doc.name, modelProfiles);
    if (reserved) modelErrors.push(reserved);
    // Push deploys no profile under that name, so it is neither merged nor
    // listed.
    const declared =
        modelProfiles.filter(p => p.name.toLowerCase() !== DEFAULT_PROFILE);
    // Push fails when default_profile names a profile this model lacks.
    if (!only && defaultProfile !== undefined &&
        defaultProfile !== DEFAULT_PROFILE &&
        !modelProfiles.some(p => p.name === defaultProfile)) {
      modelErrors.push(unknownProfileMessage(
          defaultProfile, doc.name, declared.map(p => p.name)));
    }
    printRejects('  ', modelErrors);
    // 'default' is the one profile name that is always right. Reported here
    // rather than falling into the typo check below, which would call a
    // universally valid name undeclared.
    if (only === DEFAULT_PROFILE) {
      console.log(inlineHeader);
      warnInline(doc, declared.length > 0);
      printRejects('    ', await errorsFor(doc, DEFAULT_PROFILE));
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
      printRejects('    ', await errorsFor(doc, DEFAULT_PROFILE));
      continue;
    }
    for (const {name} of available) {
      const res = profileForDocument(doc, available, name, load);
      // Narrows the type; `name` comes from `available`, so it is found.
      if (res.kind === 'missing') continue;
      // Push applies the profile to every model in the scope, so a model that
      // does not declare it fails the push.
      const errors = docs.filter(d => d.name !== doc.name).flatMap(d => {
        const names = declaredBy(d).map(p => p.name);
        return names.includes(name) ?
            [] :
            [unknownProfileMessage(name, d.name, names)];
      });
      let model: SemanticModel|undefined;
      if (res.kind === 'error') {
        errors.push(profileErrorMessage(
            doc.name, res, name, profileDocs(doc.name)));
      } else {
        for (const w of res.warnings) {
          console.warn(`  profile '${name}': warning: ${w}`);
        }
        if (res.kind === 'file') {
          model = res.model;
        } else {
          // Loaded as push loads it: a legacy wrapper may still carry
          // `deployment_target:` and bare sources, and one with no graph
          // target needs no sources. Push reports a load that fails.
          const loaded = loadSemanticModels(
              [{
                name: doc.name,
                text: res.text,
                allowLegacyBareSource: true,
                excluded: res.excluded,
              }],
              {
                defaultProject,
                bindingOptional: !declaresGraphTarget(res.text),
                ...load,
              });
          for (const w of loaded.warnings) {
            console.warn(`  profile '${name}': warning: ${w}`);
          }
          if (!loaded.error) {
            model =
                applyProfileExclusions(loaded.models[0].model, res.excluded);
          }
        }
        errors.push(...await errorsFor(profiledDoc(doc, res, load), name));
      }
      const marker = name === defaultProfile ? ' (default)' : '';
      console.log(`  profile '${name}'${marker}`);
      if (model) printProfileReport(model, name, res.kind === 'file');
      printRejects('    ', errors);
    }
    // `kcmd push --profile default`, and a push that names no profile when no
    // `default_profile` is set, deploy the inline bindings. They are reported
    // when push rejects them.
    if (!only) {
      const errors = await errorsFor(doc, DEFAULT_PROFILE);
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
    source: SemanticModelSource, sourceFiles: FileCopy[]): Promise<number> {
  console.log(
      options.validateOnly ?
          'Validating semantic model for Knowledge Catalog...' :
          'Pushing semantic model (Knowledge Catalog)...');
  // The deploy passes its warnings to `onWarnings` before the first catalog
  // write. A run that stops before then returns them in the result instead.
  // `result.warnings` starts with the warnings `onWarnings` got, because
  // applyKnowledgeCatalog copies them and adds none. The slice below then
  // skips the ones already printed.
  let printed = 0;
  const printWarnings = (warnings: readonly string[]) => {
    for (const w of warnings.slice(printed)) console.warn(`Warning: ${w}`);
    printed = warnings.length;
  };
  const result = await kc.deployKnowledgeCatalog(models, ctx, {
    ...catalogDeployOptions(options, source, sourceFiles),
    onWarnings: printWarnings,
  });

  printWarnings(result.warnings);
  return reportCatalogResult(result, options);
}

// The options the Knowledge Catalog leg takes from the push `options`, the
// scope `source` and the file copies push stores.
function catalogDeployOptions(
    options: PushOptions, source: SemanticModelSource,
    sourceFiles: FileCopy[]): kc.KcDeployOptions {
  return {
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
    v2Aspects: kcV2Aspects(),
    sourceFiles,
    // Push looks up the file-copy type before any graph deploys whenever it
    // has copies to store.
    fileCopyTypeChecked: sourceFiles.length > 0,
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
// unless --force-remove authorizes deleting the stale local model first. When
// the catalog holds file copies of the model and profile files, pull writes
// those instead of the model rebuilt from the aspects.
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
  const result = await pullKc.pullKnowledgeCatalog(catalog, {
    project: source.project,
    location: source.location,
    entryGroup: source.entryGroup,
    v2Aspects: kcV2Aspects(),
  });

  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }

  // A pull returns file copies only with the model they belong to.
  const rawFiles = result.rawFiles ?? [];
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

  // The file copies are written instead of the model rebuilt from the
  // aspects. Writing both would leave whichever wrote `<model>.yaml` last.
  // The copies belong to the entry group's one model.
  if (rawFiles.length) {
    return writeFileCopies(layout, result.models[0].name, rawFiles, options);
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

  // A pull that writes the rebuilt model with KC_V2_ASPECTS off returns no
  // profile, so it keeps every local profile file, even under --force-remove,
  // and names each one.
  if (result.rawFiles) {
    for (const model of result.models) {
      const kept = layout.localProfileFiles(model.name).map(p => p.path);
      if (!kept.length) continue;
      console.warn(
          `Warning: [${model.name}] the catalog holds no copy of the profile ` +
          `files, so pull keeps the local ones: ${kept.join(', ')}.`);
    }
  }

  console.log(
      options.dryRun ?
          `Dry run: would write ${created} new and ${
              updated} updated model document(s).` :
          `Wrote ${created} new and ${updated} updated model document(s).`);
  return 0;
}


// Writes the file copies a pull returned for `model` into the entry group
// directory, each to the path its name maps to, and leaves a file whose
// content is unchanged as it is. A name that is not one push stores is
// skipped with a warning. Then each local profile file the catalog did not
// return is named in a warning, or deleted under --force-remove. Returns a
// process exit code.
function writeFileCopies(
    layout: SemanticModelLayout, model: string, files: FileCopy[],
    options: PullOptions): number {
  const written = new Set<string>();
  const counts = {created: 0, updated: 0, unchanged: 0};
  for (const {fileName, content} of files) {
    const target = fileCopyTarget(layout, model, fileName);
    if (!target) {
      console.warn(
          `Warning: skipped '${fileName}' from the catalog; pull writes only ` +
          `'${model}.yaml', '${model}.profile.<name>.yaml' and ` +
          `'${model}.profiles/<name>.yaml' inside the entry group directory.`);
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

  // Pull writes each file back to the path it came from, so a local profile
  // file the catalog does not have is stale.
  for (const stale of layout.localProfileFiles(model)) {
    if (written.has(path.resolve(stale.path))) continue;
    if (!options.forceRemove) {
      console.warn(
          `Warning: local profile file ${stale.path} is not in the catalog; ` +
          `delete it, or pull with --force-remove to delete it.`);
    } else if (options.dryRun) {
      console.log(`  would remove ${stale.path}`);
    } else {
      // The older `<model>.profiles/` directory has no layout method.
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


// Where pull writes a file copy of `model`, and how, or undefined when its
// name is not one push stores. The name comes from the catalog, so only
// `<model>.yaml`, `<model>.profile.<profile name>.yaml` and
// `<model>.profiles/<name>.yaml` are written, each relative, ending in
// `.yaml`, with no `..` segment and no NUL byte. The model file and a sibling
// profile file are written through the layout, which keeps both in the entry
// group directory; the older `<model>.profiles/` directory has no layout
// method.
function fileCopyTarget(
    layout: SemanticModelLayout, model: string, fileName: string):
    {path: string; write: (text: string) => void}|undefined {
  if (path.posix.isAbsolute(fileName) || path.win32.isAbsolute(fileName) ||
      fileName.includes('\0') || fileName.split(/[\\/]/).includes('..') ||
      !fileName.endsWith('.yaml')) {
    return undefined;
  }
  if (fileName === `${model}.yaml`) {
    return {
      path: layout.modelPath(model),
      write: text => layout.writeModelDocument(model, text),
    };
  }
  // A model name holding a path separator maps to a flat model file, and its
  // profile files have no such mapping.
  if (/[\\/]/.test(model) || !fileName.startsWith(`${model}.`)) {
    return undefined;
  }
  const rest = fileName.slice(model.length + 1);
  const profileName = /^profile\.(.+)\.yaml$/.exec(rest)?.[1];
  if (profileName !== undefined) {
    let localPath: string;
    try {
      // Throws when the name breaks the profile naming rule.
      localPath = layout.profilePath(model, profileName);
    } catch {
      return undefined;
    }
    return {
      path: localPath,
      write: text => layout.writeProfileDocument(model, profileName, text),
    };
  }
  if (!/^profiles\/[^/\\]+$/.test(rest)) return undefined;
  const localPath = path.join(path.dirname(layout.modelPath(model)), fileName);
  return {
    path: localPath,
    write: text => {
      fs.mkdirSync(path.dirname(localPath), {recursive: true});
      fs.writeFileSync(localPath, text);
    },
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
  // `--name` names one skill, so a scope of several models is refused before
  // any AlloyDB lookup.
  const opened = await createSemanticRuntimes({
    profile: named,
    ctx,
    oneModel: options.name ?
        count => `--name applies to one skill, and this scope has ${
            count} models. Drop it and each takes its model's name.` :
        false,
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
      // A store error already names the model.
      const named = generated.error.startsWith(`Model '`);
      console.error(`Error: ${named ? '' : `[${runtime.model.name}] `}${
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

