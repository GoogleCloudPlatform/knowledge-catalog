// CLI command handlers
//

import {randomUUID} from 'node:crypto';
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
import {fileNameOf, formatOverviewSidecar, OverviewSidecar, profileFilesBeside, SemanticModelLayout} from '../libts/layouts/semantic-model';
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
import {FILE_COPY_TYPE_ID, FileCopy, provisionCustomTypes} from '../libts/semantic/kc_custom_types';
import {listed, LoadedModel, loadSemanticModels, OSSIE_VERSION, SemanticModelError, writtenSource} from '../libts/semantic/loader';
import {serializeModel, serializeModelFiles} from '../libts/semantic/osi_converter';
import * as pullKc from '../libts/semantic/pull_kc';
import {applyProfile, AvailabilityReport, DeclaredProfile, declaredProfiles, DEFAULT_PROFILE, DialectLoad, IMPORT_TRANSPILE_COMMAND, inheritanceErrorOf, loadProfileFile, profileErrorMessage, profileForDocument, pruneUnavailable, reservedProfileNameError, sourcesDialect, validateProfileCompleteness, validateProfileConsistency,} from '../libts/semantic/resolve_profiles';
import {createSemanticRuntimes, undeclaredProfileError} from '../libts/semantic/runtime/runtime';
import {profileTargets, storeLine} from '../libts/semantic/runtime/store';
import {generateSkill, SkillPackage} from '../libts/semantic/skills';
import {sourceDialects} from '../libts/semantic/source_dialect';
import {sourceEntryErrors} from '../libts/semantic/source_entries';
import {loadSqlEngine} from '../libts/semantic/sql_parser';
import {deploymentTableErrors, inlineBindingWarnings, storeMessage, validateBigQueryActionStatements, validateBigQueryDataSources, validateDeployments, validateExpressionReferences, validateInheritance, validateInheritedColumns, validateInlineDialects, validatePushRequirements, validateSpannerActionStatements} from '../libts/semantic/validate';
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


// Whether Knowledge Catalog push and pull should use the second-generation
// built-in aspect fields and entry-id layout. Only `KC_V2_ASPECTS=1` enables
// it; unset, `''`, `'0'`, and `'true'` are all off.
export function kcV2Aspects(): boolean {
  return process.env.KC_V2_ASPECTS === '1';
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
  // location. The lookup of a Cloud SQL or third-party table's entry, which
  // push needs for the table's dialect, still runs. Semantic-model push only.
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
    const model = path.basename(dir).slice(0, -'.profiles'.length);
    errors.push(
        `Legacy profile directory '${model}.profiles/' is no longer ` +
        `supported; rename profile files to '${model}.profile.<name>.yaml' ` +
        `beside '${model}.yaml'.`);
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

// The dialect of each Cloud SQL and third-party table the model documents
// `docs` and their profile files write, read from the tables' Knowledge
// Catalog entries, for every load the command makes. Makes no call when no file
// writes one. Prints each table whose dialect cannot be read and returns null.
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
  const {dialects, databases, errors} =
      await sourceDialects(texts, new dataplex.CatalogClient(ctx));
  if (errors.length) {
    for (const e of errors) console.error(`Error: ${e}`);
    return null;
  }
  return {sourceDialects: dialects, sourceDatabases: databases};
}

// Checks that every source in the inline bindings and named profiles of
// `models` names a table with a Knowledge Catalog entry (see
// sourceEntryErrors), and gives one message per entity that does not, and per
// profile whose BigQuery and BigLake tables share no location. With
// --skip-source-check, says so and checks nothing.
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

// An error of a two-phase push's checks, and what it belongs to: the whole
// push when `document` is unset, the model in `document` when `profile` is
// unset, and that profile of the model otherwise. A deployment's errors belong
// to the profile it uses, which is 'default' when it names none.
interface LocalCheckError {
  error: string;
  document?: string;
  profile?: string;
}

// The errors the named profiles of each model in `docs` give: each profile
// file, and each profile a vanilla model carries in its GOOGLE block, checked
// on its own for completeness. An error about a profile file names that file,
// and one about a block profile names the model document.
// A model's profiles are checked against its model file as loaded on its own,
// which `baseByDoc` holds. A file under the reserved name 'default', which no
// push deploys, is not read here. Push also checks the
// keys and join columns of the model file and of each named profile. The
// warnings go to `warnings`.
function namedProfileErrors(
    docs: Array<{name: string; text: string}>,
    baseByDoc: Map<string, SemanticModel>, profileDocs: ProfileDocs,
    declared: DeclaredProfiles, warnings: string[],
    load: DialectLoad): LocalCheckError[] {
  const errors: LocalCheckError[] = [];
  for (const d of docs) {
    // Each named profile, with the label its errors carry and a function that
    // reads it. declared() lists the profile files too, so only its block
    // profiles are taken from it. A block profile is already read. Its actions
    // are dropped, as loadProfileFile skips a profile file's.
    let named: Array<
        {name: string; label: string; block: boolean; read: () => ProfileSpec}>;
    try {
      named = [
        ...profileDocs(d.name).map(p => ({
          name: p.name,
          label: p.fileName,
          block: false,
          read: () => loadProfileFile(p.text, p.name, {skipActions: true}),
        })),
        ...declared(d).flatMap(p => 'spec' in p ? [{
          name: p.name,
          label: d.name,
          block: true,
          read: () => {
            const {actions: _, ...spec} = p.spec;
            return spec;
          },
        }] : []),
      ].filter(p => p.name.toLowerCase() !== DEFAULT_PROFILE);
    } catch (err: any) {
      // A profile file that breaks one of the layout's file rules, or block
      // profiles a load rejects.
      errors.push({error: `${err.message || err}`, document: d.name});
      continue;
    }
    // A document that holds no model has nothing to check its profiles
    // against.
    const base = baseByDoc.get(d.name);
    if (!base) continue;
    // Actions are out of scope for the preview. Push checks a profile's
    // actions only when it applies the profile, so these checks leave them
    // out.
    const logical = {...base, actions: []};
    // Push warns about the SQL it cannot read in the model file, so these
    // checks leave out a warning about model file SQL that push reads in the
    // same dialect. Push stops reading what the SQL reads when the model's
    // hierarchy does not resolve, and these checks then give every warning.
    const ownSqlOnly = !inheritanceErrorOf(base) ?
        {dialect: sourcesDialect(base)} :
        undefined;
    const specs: ProfileSpec[] = [];
    for (const p of named) {
      const at = (m: string) => `[${p.label}] ${m}`;
      const tag = (m: string) =>
          ({error: at(m), document: d.name, profile: p.name});
      let spec: ProfileSpec;
      try {
        spec = p.read();
      } catch (err) {
        if (!(err instanceof SemanticModelError)) throw err;
        errors.push(tag(err.message));
        continue;
      }
      specs.push(spec);
      const profileWarnings: string[] = [];
      errors.push(
          ...validateProfileCompleteness(logical, spec, profileWarnings, {
            ownSqlOnly,
            googleBlock: p.block,
            ...load,
          }).map(tag));
      warnings.push(...profileWarnings.map(at));
    }
    errors.push(...validateProfileConsistency(logical, specs, DEFAULT_PROFILE)
                    .map(e => ({error: `[${d.name}] ${e}`, document: d.name})));
  }
  return errors;
}

// The warnings and the note push prints on what pruning leaves out of model
// `model`. Each line names the model, and `at` its document and the
// deployment. `outcome` says what becomes of a field left out.
function pruningLines(
    r: AvailabilityReport, model: string, at: string,
    outcome = 'the graph omits it'): string[] {
  const where = `model '${model}' (${at})`;
  const excluded = new Set(r.excludedFields);
  const omits = (field: string, why: string) =>
      `Warning: field '${field}' in ${where} ${why}, so ${outcome}.`;
  // Such as "metric 'a'" or "metrics 'a' and 'b'", or '' for no names.
  const named = (kind: string, names: string[]) => names.length ?
      `${plural(names.length, kind, `${kind}s`)} ${
          listed(names.map(n => `'${n}'`))}` :
      '';
  const unavailable = [
    named('metric', r.droppedMetrics.map(m => m.name)),
    named('action', r.droppedActions.map(a => a.name)),
  ].filter(n => n).join(r.droppedMetrics.length > 1 ? ', and ' : ' and ');
  const note = [
    excluded.size ? `excludes ${named('field', [...excluded])}.` : '',
    unavailable && `leaves ${unavailable} unavailable.`,
  ].filter(p => p).join(' It ');
  return [
    ...r.unboundFields.filter(f => !excluded.has(f))
        .map(f => omits(f, 'has no expression')),
    ...r.droppedFields.map(d => omits(d.name, d.reason)),
    ...note ? [`Note: ${where} ${note}`] : [],
  ];
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

// What checkCatalogAspects reports for a flag-on push of `models` to `source`
// with the overview sidecars `overviews`.
function catalogAspects(
    models: LoadedModel[], source: SemanticModelSource,
    overviews?: ReadonlyMap<string, OverviewSidecar>):
    {error?: string; warnings: string[]} {
  return kc.checkCatalogAspects(models, {
    project: source.project,
    location: source.location,
    entryGroup: source.entryGroup,
    systemTypeProject: process.env.KC_TYPE_PROJECT,
    v2Aspects: true,
    overviews,
  });
}

// Generates a graph leg's DDL without calling a service, or gives why it
// cannot be generated.
async function generateOffline(
    deployLeg: typeof deploy.deployBigQuery, models: LoadedModel[],
    ctx: context.ApiContext): Promise<deploy.DeployResult|string> {
  try {
    const result = await deployLeg(models, ctx, {validateOnly: true});
    if (result.success) return result;
    return result.details ?? 'the graph could not be generated';
  } catch (err: any) {
    return err.message || String(err);
  }
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
          `; use '${IMPORT_TRANSPILE_COMMAND}' to translate SQL dialects ` +
              `when importing a model. Import translates the profile files ` +
              `it writes, but a Google model re-imported in place keeps its ` +
              `profile files as written; write their 'BIGQUERY' or ` +
              `'ANSI_SQL' expressions yourself`),
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
        const catalog = new dataplex.CatalogClient(ctx);
        const createRes = await catalog.createEntryGroup(
          project,
          location,
          groupId,
          {
            type: 'context-set',
            ...(rootMeta.displayName ? {displayName: rootMeta.displayName} : {}),
            ...(rootMeta.description ? {description: rootMeta.description} : {}),
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

// One selected deployment, its message prefix and the model it deploys. A
// BigQuery or Spanner deployment also holds its generated DDL and warnings.
interface DeploymentPlan {
  deployment: ResolvedDeployment;
  at: string;
  model: LoadedModel;
  generated?: {ddl: string[]; warnings: string[]};
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
  const {plans, kcModels, fileCopies, leftOut, overviews} = checked;
  const sourceErrors = await sourceCheckErrors(kcModels, ctx, options);
  if (sourceErrors.length) return fail(...sourceErrors);
  if (fileCopies.length) {
    const problem = await kc.checkCustomTypes(
        new dataplex.CatalogClient(ctx), source, [FILE_COPY_TYPE_ID]);
    if (problem) return fail(problem);
  }
  warnModelFileNames(kcModels, fileCopies);
  const kcOptions =
      catalogDeployOptions(options, source, fileCopies, overviews);
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
    if (code !== 0) return code;
  }
  return 0;
}

// The local checks of a two-phase push, which call no service: it stops at
// the first check that fails, and returns each selected deployment's plan, the
// models the catalog receives, the file copies it stores, the overview sidecars
// it writes and what pruning leaves out, or the errors that stop it. With
// `quiet`, for the `kcmd profiles` report, it prints no warning.
async function checkBeforeWrites(
    options: PushOptions, scope: TwoPhaseScope, quiet = false): Promise<{
  plans: DeploymentPlan[]; kcModels: LoadedModel[]; fileCopies: FileCopy[];
  leftOut: string[];
  overviews?: Map<string, OverviewSidecar>;
}|{errors: LocalCheckError[]}> {
  const {ctx, layout, source, docs, profileDocs, load} = scope;
  const stop = (errors: LocalCheckError[]) => ({errors});
  const fail = (...errors: string[]) => stop(errors.map(error => ({error})));
  const ofModel = (document: string, ...errors: string[]) =>
      errors.map(error => ({error, document}));
  const ofProfile = (document: string, profile: string, ...errors: string[]) =>
      errors.map(error => ({error, document, profile}));
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

  const defaultProject = source.project ?? ctx.project;
  // A model file may leave every source to its profile files, so a source is
  // required only once a deployment's profile is applied. The checks below
  // reject a field its table cannot run, so the load does not warn about it.
  const loaded = loadSemanticModels(
      docs,
      {defaultProject, bindingOptional: true, ...load, fieldTextChecked: true});
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
  }
  // Every profile each model declares.
  const declaredBy = declaredProfilesReader(profileDocs);
  const declaredNames = (document: string) =>
      declaredBy(docs.find(d => d.name === document)!).map(p => p.name);
  // With KC_V2_ASPECTS off, the catalog stores each model file and profile
  // file as read. With it on, it writes each overview sidecar.
  let fileCopies: FileCopy[] = [];
  let overviews: Map<string, OverviewSidecar>|undefined;
  if (!kcV2Aspects() && docs.length === 1) {
    const copies = checkedFileCopies(layout, docs, profileDocs);
    if (copies.error) return fail(copies.error);
    fileCopies = copies.files;
  }
  if (kcV2Aspects() && docs.length === 1) {
    try {
      overviews = layout.overviewSidecars();
    } catch (err: any) {
      return fail(err.message);
    }
  }

  // Every deployment's target must be in an accepted form, and its profile one
  // the model declares, whether or not this push selects the deployment.
  const selectedByDoc = new Map<string, ResolvedDeployment[]>();
  const everyByDoc = new Map<string, ResolvedDeployment[]>();
  for (const {document, model} of models) {
    const every = resolveModelDeployments(model);
    if ('error' in every) return stop(ofModel(document, every.error));
    const resolved = noDeployment ? {deployments: []} :
                                    resolveModelDeployments(model, selected);
    if ('error' in resolved) return stop(ofModel(document, resolved.error));
    const undeclared = undeclaredProfileError(
        document, model, declaredNames(document));
    if (undeclared) return stop(ofModel(document, undeclared));
    everyByDoc.set(document, every.deployments);
    selectedByDoc.set(document, resolved.deployments);
  }

  // Every named profile is checked on its own against the model file, and so
  // are the model file's own bindings and each deployment. The catalog's model
  // is checked as a model that deploys nowhere. A selected deployment's own
  // checks run only after these pass, so these give every error and every
  // warning about SQL kcmd cannot read.
  const profileWarnings: string[] = [];
  const profileErrors = namedProfileErrors(
      docs, new Map(loaded.models.map(m => [m.document, m.model])),
      profileDocs, declaredBy, profileWarnings, load);
  for (const {document, model} of models) {
    profileErrors.push(
        ...ofProfile(
            document, DEFAULT_PROFILE,
            ...validateInlineDialects(model, document),
            ...validateInheritedColumns(model, document)),
        // One call per profile, so each error carries its deployments' profile.
        ...[...new Set(everyByDoc.get(document)!.map(d => d.profile))].flatMap(
            profile => ofProfile(document, profile, ...validateDeployments({
              ...model,
              deployments: model.deployments!.filter(
                  d => (d.profile ?? DEFAULT_PROFILE) === profile),
            }, document))));
    const doc = docs.find(d => d.name === document)!;
    const declared = declaredBy(doc);
    const named = declared.some(p => p.name.toLowerCase() !== DEFAULT_PROFILE);
    profileWarnings.push(...inlineBindingWarnings(model, document, named));
    // A profile that no selected deployment applies still goes to Knowledge
    // Catalog, so its load warnings print here, less those the model file's
    // load gave, unless a check above recorded an error for that profile. A
    // selected deployment prints its own profile's warnings.
    const applied = selectedByDoc.get(document)!.map(d => d.profile);
    for (const {name} of declared) {
      if (applied.includes(name)) continue;
      if (profileErrors.some(
              e => e.document === document && e.profile === name)) {
        continue;
      }
      const res = profileForDocument(doc, declared, name, load);
      if (res.kind !== 'file') continue;
      profileWarnings.push(
          ...res.warnings.filter(w => !loaded.warnings.includes(w))
              .map(w => `profile '${name}': ${w}`));
    }
  }
  const kcWarnings: string[] = [];
  const kcErrors = models.flatMap(
      m => ofModel(m.document, ...validatePushRequirements(
          [{...m, model: {...m.model, deployments: []}}],
          {
            warnings: kcWarnings,
            v2Aspects: kcV2Aspects(),
          })));
  for (const w of [...profileWarnings, ...kcWarnings]) warn(w);
  if (profileErrors.length || kcErrors.length) {
    return stop([...profileErrors, ...kcErrors]);
  }
  // Each deployment's tables must be in the database it deploys to, whether
  // or not this push selects the deployment.
  const tableErrors = models.flatMap(
      ({document, model}) => (everyByDoc.get(document) ?? []).flatMap(
          d => ofProfile(
              document, d.profile,
              ...deploymentTableErrors(document, model, d))));
  if (tableErrors.length) return stop(tableErrors);

  const plans: DeploymentPlan[] = [];
  const leftOut: string[] = [];
  for (const base of models) {
    for (const deployment of selectedByDoc.get(base.document) ?? []) {
      const plan = await deploymentPlan(
          base, profileDocs(base.document), deployment, ctx, warn, leftOut);
      if ('errors' in plan) {
        return stop(
            ofProfile(base.document, deployment.profile, ...plan.errors));
      }
      plans.push(plan);
    }
  }
  return {plans, kcModels: models, fileCopies, leftOut, overviews};
}

// Adds the profile files of the model in `base` to `model.profiles`, without
// their actions. Returns the error of the first profile file that breaks a
// file rule. A profile file that does not load is left out, for
// namedProfileErrors to report.
function withProfileFiles(base: LoadedModel, profileDocs: ProfileDocs):
    LoadedModel|{errors: LocalCheckError[]} {
  const {document, model} = base;
  const profiles = [...(model.profiles ?? [])];
  let files: ReturnType<ProfileDocs>;
  try {
    files = profileDocs(document);
  } catch (err: any) {
    return {errors: [{error: err.message || String(err), document}]};
  }
  const reserved = reservedProfileNameError(document, files);
  if (reserved) return {errors: [{error: reserved, document}]};
  for (const p of files) {
    try {
      profiles.push(loadProfileFile(p.text, p.name, {skipActions: true}));
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
    }
  }
  return {document, model: profiles.length ? {...model, profiles} : model};
}

// Builds and checks the model `deployment` deploys from `base`, reading its
// profile file in `files` again with its actions, and generates its DDL
// offline. Returns the plan, or the errors that stop the push.
async function deploymentPlan(
    base: LoadedModel, files: ReturnType<ProfileDocs>,
    deployment: ResolvedDeployment, ctx: context.ApiContext,
    warn: (w: string) => void,
    leftOut: string[]): Promise<DeploymentPlan|{errors: string[]}> {
  const {document, model} = base;
  const at = `[${document}] deployment '${deployment.name}'`;
  const fail = (...errors: string[]) => ({errors});
  if (deployment.engine === 'spanner' &&
      deployment.profile === DEFAULT_PROFILE && model.metrics?.length) {
    return fail(
        `${at} targets a Spanner graph and uses the model file's own ` +
        `bindings, but the model declares metrics, which a Spanner graph ` +
        `cannot hold; name a profile with metrics_exclude: "*".`);
  }
  let applied = model;
  if (deployment.profile !== DEFAULT_PROFILE) {
    // checkBeforeWrites has checked that the model declares the profile and
    // that its file loads, so `model.profiles` holds it.
    let spec = model.profiles!.find(p => p.name === deployment.profile)!;
    const file = files.find(p => p.name === deployment.profile);
    const warnings: string[] = [];
    try {
      // A profile in a GOOGLE block has no file and applies as loaded.
      if (file) spec = loadProfileFile(file.text, file.name);
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
      return fail(`[${file!.fileName}] ${err.message}`);
    }
    try {
      applied = applyProfile(model, spec, {warnings});
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
      return fail(`${at}: ${err.message}`);
    }
    for (const w of warnings) {
      warn(`profile '${deployment.profile}': [${document}] ${w}`);
    }
  }
  // Messages name the deployment.
  const label = `${document}, deployment '${deployment.name}'`;
  const checked: LoadedModel = {document: label, model: applied};
  // Pruning can remove the field these rules are about, so they run first.
  // checkBeforeWrites has already warned about the SQL they cannot read.
  const unprunedErrors = [
    ...validateInheritance([checked]),
    ...validateExpressionReferences([checked]),
  ];
  const {model: pruned, report} =
      pruneUnavailable(checked.model, deployment.profile);
  leftOut.push(...pruningLines(
      report, model.name, label,
      deployment.engine === 'alloydb' ? 'it is unavailable there' : undefined));
  // Keeps only this deployment, so every reader sees its target alone.
  const narrowed: LoadedModel = {
    document: checked.document,
    model: {
      ...pruned,
      deployments:
          (model.deployments ?? []).filter(d => d.name === deployment.name),
    },
  };
  const errors = [
    ...unprunedErrors,
    ...validatePushRequirements([narrowed], {
      fieldsPruned: true,
      v2Aspects: kcV2Aspects(),
    }),
  ];
  if (errors.length) return {errors};
  // An AlloyDB database holds no graph.
  if (deployment.engine === 'alloydb') {
    return {deployment, at, model: narrowed};
  }
  const generated = await generateOffline(
      deployment.engine === 'bigquery' ? deploy.deployBigQuery :
                                         deploySpannerLeg.deploySpanner,
      [narrowed], ctx);
  if (typeof generated === 'string') return fail(`${at}: ${generated}`);
  return {deployment, at, model: narrowed, generated};
}

// The errors of one deployment's live checks, which change nothing. They read
// the dataset or database, probe each BigQuery source and dry-run the BigQuery
// DDL in the dataset's location, and check each action's DML. A dataset whose
// location cannot be read adds a warning to `warnings`.
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
  // before any AlloyDB lookup.
  const opened = await createSemanticRuntimes(
      {profile: named, ctx, oneModel: true, snapshot});
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
function printProfileReport(model: SemanticModel, name: string): void {
  // The targets the profile's deployments name, as --print-store reads them.
  let targets: string[] = [];
  try {
    targets = profileTargets(model, name);
  } catch {
    // A GOOGLE block that is not valid JSON is a push-time error; here just
    // show none rather than abort the listing.
  }
  // Pruned for the graphs this profile's own deployments name.
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
// whether push accepts a profile before a deployment names it. Its one service
// call is push's Cloud SQL dialect lookup. Returns a process exit code (0 on
// success).
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
  // A Cloud SQL or third-party table takes its dialect from its Knowledge
  // Catalog entry, looked up once, as push does.
  const load = await dialectLoad(ctx, docs, profileDocs);
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
    const loaded =
        loadSemanticModels([doc], {defaultProject, bindingOptional: true});
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
  // With KC_V2_ASPECTS on, push prints the emitter's warnings and checks
  // every aspect's size once the local checks pass, before any write.
  if (kcV2Aspects() && 'kcModels' in checked) {
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
      if (res.kind === 'error') {
        applyError =
            profileErrorMessage(doc.name, res, name, profileDocs(doc.name));
      } else {
        for (const w of res.warnings) {
          console.warn(`  profile '${name}': warning: ${w}`);
        }
        model = res.model;
      }
      console.log(`  profile '${name}'`);
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
// scope `source`, the file copies push stores and the overview sidecars it
// writes.
function catalogDeployOptions(
    options: PushOptions, source: SemanticModelSource, sourceFiles: FileCopy[],
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
    v2Aspects: kcV2Aspects(),
    sourceFiles,
    overviews,
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
  // With KC_V2_ASPECTS on, the relationships of an ordered entity pair share
  // one link, so the count is of links.
  const plural = result.linked === 1 ? '' : 's';
  const linked = !result.linked ? '' :
      kcV2Aspects() ? `; wrote ${result.linked} entry link${plural}` :
                      `; linked ${result.linked} relationship${plural}`;
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
// those instead of the model rebuilt from the aspects. A model rebuilt from
// the second-generation types is written the same way, as its model file,
// profile files and overview sidecars. Returns a process exit code (0 on
// success).
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
    systemTypeProject: process.env.KC_TYPE_PROJECT,
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
      // Its profile files go too, since push refuses a profile file with no
      // model beside it.
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

  // The file copies are written instead of the model rebuilt from the
  // aspects. Writing both would leave whichever wrote `<model>.yaml` last.
  // The copies belong to the entry group's one model.
  if (rawFiles.length) {
    return writePulledFiles(layout, result.models[0].name, rawFiles, options);
  }
  if (result.secondGeneration) {
    const pulled = result.models[0];
    // The catalog stores no profile's actions, so a profile file keeps the
    // actions it binds locally. A vanilla model declares no action.
    const model = pulled.version === OSSIE_VERSION ? pulled : {
      ...pulled,
      profiles: pulled.profiles?.map(p => {
        const actions = localProfileActions(layout, pulled.name, p.name);
        return actions ? {...p, actions} : p;
      }),
    };
    const {files, warnings} = serializeModelFiles(model, {logical: true});
    for (const w of warnings) console.warn(`Warning: [${model.name}] ${w}`);
    for (const [id, sidecar] of result.overviews ?? []) {
      files.push({
        fileName: `${id}.overview.md`,
        content: formatOverviewSidecar(sidecar),
      });
    }
    return writePulledFiles(
        layout, model.name, files, options, {sidecars: true});
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


// Writes the files a pull returned or rebuilt for `model`, and skips a name
// push does not store. Then it names each local profile file, and with
// `sidecars` each overview sidecar, that the pull did not write, or deletes it
// under --force-remove.
function writePulledFiles(
    layout: SemanticModelLayout, model: string, files: FileCopy[],
    options: PullOptions, {sidecars = false} = {}): number {
  const written = new Set<string>();
  const counts = {created: 0, updated: 0, unchanged: 0};
  const forms = [
    `'${model}.yaml'`, `'${model}.profile.<name>.yaml'`,
    `'${model}.profiles/<name>.yaml'`
  ];
  if (sidecars) forms.push('overview sidecars');
  for (const {fileName, content} of files) {
    const target = pulledFileTarget(layout, model, fileName, sidecars);
    if (!target) {
      console.warn(
          `Warning: skipped '${fileName}' from the catalog; pull writes only ` +
          `${forms.slice(0, -1).join(', ')} and ${forms.at(-1)} inside the ` +
          `entry group directory.`);
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
  // file or overview sidecar the catalog does not have is stale.
  const local: Array<{path: string; profileName?: string; kind: string}> = [
    ...layout.localProfileFiles(model).map(f => ({...f, kind: 'profile file'})),
    ...(sidecars ? layout.overviewSidecarPaths() : [])
        .map(f => ({path: f.path, kind: 'overview sidecar'})),
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
      // The older `<model>.profiles/` directory and a sidecar have no layout
      // method.
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
// Undefined unless the name is relative, holds no `..` segment or NUL byte, and
// names `<model>.yaml`, `<model>.profile.<name>.yaml`,
// `<model>.profiles/<name>.yaml` or, with `sidecars`, an overview sidecar
// that push reads: `<model>.overview.md` or
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
  return {path: localPath, write: writeFile};
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
    writeFileAt(options.out, result.yaml);
    writtenPath = options.out;
  } else {
    const layout = await workspaceLayout();
    if (typeof layout === 'string') return printErrors(layout);
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

  // A Google-flavor model's profiles are its own files beside it, found by
  // the input file's name without `.yaml` or `.yml`, not by the model name
  // inside it.
  const stem = path.basename(file).replace(YAML_FILE, '');
  const profileFiles = profileFilesBeside(path.dirname(file), stem).map(p => ({
    fileName: path.basename(p.path),
    content: fs.readFileSync(p.path, 'utf8'),
  }));
  // Without --out the files go into the workspace. A Google model file
  // re-imported there in place keeps its profile files as they are; any other
  // Google-flavor import of a Google model writes them with the model.
  const layout = options.out ? undefined : await workspaceLayout();
  const keepProfileFiles = typeof layout === 'object' &&
      path.resolve(file) === path.resolve(layout.modelPath(stem));
  const result = await importSemanticModelYaml(fs.readFileSync(file, 'utf8'), {
    flavor: flavor as 'ossie' | 'google',
    sourcePrefix: options.sourcePrefix,
    transpile: !!options.transpile,
    strict: input === 'first-party',
    profileFiles,
    keepProfileFiles,
    fileName: path.basename(file),
    // Called only for a --source-prefix that names an entry group, so an
    // import that reads no catalog needs no credentials.
    listEntries: (project, location, entryGroup) =>
        new dataplex.CatalogClient(context.ApiContext.default())
            .listEntries(project, location, entryGroup),
  });
  for (const w of result.warnings) console.warn(`Warning: ${w}`);
  if (!result.ok) return fail(...result.errors);

  // Every target is found before anything is written, so a file that has
  // none writes nothing.
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
    // `layout` is set, since there is no --out.
    if (typeof layout !== 'object') return fail(layout as string);
    // The engine's first file is the model file, `<model>.yaml`; the rest are
    // its profile files, which pull's mapping writes beside it.
    const model = result.files[0].fileName.replace(YAML_FILE, '');
    targets = result.files.map(
        f => pulledFileTarget(layout, model, f.fileName, false));
    // Re-importing the same model replaces its file. The input itself may be
    // in the entry group under another name.
    const docs = layout.modelDocuments()
                     .map(d => layout.modelPath(d.name))
                     .filter(p => p !== layout.modelPath(model));
    const others = docs.filter(p => path.resolve(p) !== path.resolve(file));
    const refusals: string[] = [];
    if (others.length) {
      refusals.push(
          `the entry group already holds another model's file (${
              others.join(', ')}), and an entry group holds one model; ` +
          `remove it if this model replaces it, pass --out <path> to write ` +
          `elsewhere, or import into another entry group's scope.`);
    }
    if (others.length < docs.length) {
      refusals.push(
          `the input file ${file} sits in the entry group, so the import ` +
          `would leave this model in two files there, ${file} and ${
              layout.modelPath(model)}. Move the input${
              profileFiles.length ? ' and its profile files' : ''} out of ` +
          `the entry group and import it from there, or pass --out <path> ` +
          `to write elsewhere.`);
    }
    if (refusals.length) return fail(...refusals);
    // Refuse to leave behind a profile file this import does not write. Push
    // rejects one beside a vanilla model, and reads one beside a Google model
    // as that model's profile. A Google model file re-imported in place keeps
    // its profile files.
    const inPlace = flavor === 'google' && result.files.length === 1 &&
        path.resolve(file) === path.resolve(layout.modelPath(model));
    if (!inPlace) {
      const kept = new Set(targets.map(t => t && path.resolve(t.path)));
      const left = layout.localProfileFiles(model).map(p => p.path).filter(
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

// Selects the singular or plural form based on `n` (English count agreement).
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
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

