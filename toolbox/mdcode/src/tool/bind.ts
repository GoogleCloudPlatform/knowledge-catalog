// `kcmd bind`: propose a binding profile from the raw warehouse (proposed; see
// docs/semantic-model/bind.md and src/libts/semantic/bind/).
//
//   kcmd bind --profile bigquery --scan my-project.ps_* [--from-catalog]
//             [--accept-review] [--no-profile-data] [--exclude <glob>]...
//
// Reads the logical model (the scope's model documents, a --model file, or
// the model pulled from Knowledge Catalog with --from-catalog), scans the
// datasets' INFORMATION_SCHEMA (or a --scan-file), scores every entity
// against every table, profiles the chosen tables, and writes
// `<model>.profiles/<profile>.yaml` and `bind_report.md` beside it.
//
// Exit code: 0 when every decision was accepted; 2 when something needs a
// person (an entity to review, an unbound entity, a proposed normalize rule)
// and --accept-review was not given; 1 on a usage, load, scan or profile
// error.

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

import * as kcmd from '../libts';
import {BigQueryClient} from '../libts/gcp/bigquery';
import * as context from '../libts/gcp/context';
import * as dataplex from '../libts/gcp/dataplex';
import {SemanticModelLayout} from '../libts/layouts/semantic-model';
import {BindRunMeta, ModelBindResult, renderBindReport, renderProfileYaml} from '../libts/semantic/bind/report';
import {bindDocument, catalogSearchHits, checkProfile, QueryFn, runScan} from '../libts/semantic/bind/run';
import {CatalogScan, filterScan, parseScanPattern, readScanFile, ScanPattern, targetDataset} from '../libts/semantic/bind/scan';
import {bindSummary} from '../libts/semantic/bind/score';
import {bigQueryGraphTargets} from '../libts/semantic/deployment_target';
import {SemanticModel} from '../libts/semantic/ir';
import {provisionedCustomAspects} from '../libts/semantic/kc_custom_types';
import {loadModels} from '../libts/semantic/loader';
import {serializeModel} from '../libts/semantic/osi_converter';
import * as bqProfile from '../libts/semantic/profile_bigquery';
import {pullKnowledgeCatalog} from '../libts/semantic/pull_kc';
import {Sources} from '../libts/source';
import {SemanticModelSource} from '../libts/sources/semantic-model';

export interface BindOptions {
  /** The profile to write (default `bigquery`). */
  profile?: string|boolean;
  /** `project.dataset_glob` to scan. */
  scan?: string;
  /** Read the scan from a file (bind_scan.json, or a COLUMNS CSV export). */
  scanFile?: string;
  /** A model document to bind instead of the scope's. */
  model?: string;
  /** Bind the model pulled from Knowledge Catalog. */
  fromCatalog?: boolean;
  /** Accept every review item (best candidate, proposed normalize rules). */
  acceptReview?: boolean;
  /** cac's `--no-profile-data`: false skips step 3. */
  profileData?: boolean;
  /** Dataset globs to leave out of the scan; repeatable. */
  exclude?: string|string[];
  /** Consider views, not only base tables. */
  includeViews?: boolean;
  /** Search Knowledge Catalog for each entity's names (the 0.10 signal). */
  kcSearch?: boolean;
  /** BigQuery location of the scanned datasets (default US). */
  location?: string;
  /** Project the query jobs run in (default the scanned project). */
  project?: string;
  label?: string|string[];
  /** The deployment target the profile declares (its dataset is excluded). */
  deploymentTarget?: string;
  /** Directory for bind_report.md and bind_scan.json (default: the profile's). */
  out?: string;
  cwd?: string;
}

interface BindDoc {
  name: string;
  text: string;
  profileDir: string;
}

function apiContext(): context.ApiContext {
  try {
    return context.ApiContext.default();
  } catch {
    const read = (cmd: string) => {
      try {
        return cp.execSync(cmd, {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim();
      } catch {
        return '';
      }
    };
    const project = process.env.CLOUDSDK_CORE_PROJECT || read('gcloud -q config get-value project');
    const token = read('gcloud -q auth application-default print-access-token');
    return new context.ApiContext(project, 'global', token);
  }
}

function list(v: string|string[]|undefined): string[] {
  return v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(String);
}

async function scopeDocs(root: string, ctx: context.ApiContext, fromCatalog: boolean):
    Promise<{docs: BindDoc[]; project?: string}|{error: string}> {
  let snapshot: kcmd.CatalogSnapshot;
  try {
    snapshot = await kcmd.CatalogSnapshot.fromPath(root, ctx);
  } catch (err: any) {
    return {error: String(err?.message ?? err)};
  }
  if (snapshot.manifest.source.type !== Sources.SEMANTIC_MODEL) {
    return {error: 'bind runs in a semantic-model scope (or pass --model <file>).'};
  }
  const layout = snapshot.layout as SemanticModelLayout;
  const source = snapshot.manifest.source as SemanticModelSource;
  const dirOf = (name: string) => path.join(path.dirname(layout.modelPath(name)), `${name}.profiles`);
  if (!fromCatalog) {
    const docs = layout.modelDocuments().map(d => ({...d, profileDir: dirOf(d.name)}));
    if (!docs.length) return {error: 'no semantic model documents found.'};
    return {docs, project: source.project};
  }
  const pulled = await pullModelDocs(new dataplex.CatalogClient(ctx), source);
  for (const w of pulled.warnings) console.warn(`Warning: ${w}`);
  if (!pulled.docs.length) return {error: 'Knowledge Catalog holds no semantic model for this scope.'};
  return {
    docs: pulled.docs.map(d => ({...d, profileDir: dirOf(d.name)})),
    project: source.project,
  };
}

/**
 * The scope's model(s) as pulled from Knowledge Catalog, serialized as logical
 * documents. Probes the annotation aspect types `kcmd init` provisioned and
 * hydrates them, as `kcmd pull` does: they make the read lossless (metric
 * expressions, verbatim relationship names, abstract relationships), and a
 * pull without them would bind a different model than the one pushed.
 */
export async function pullModelDocs(
    catalog: dataplex.CatalogClient,
    source: Pick<SemanticModelSource, 'project'|'location'|'entryGroup'>):
    Promise<{docs: {name: string; text: string}[]; warnings: string[]}> {
  const pulled = await pullKnowledgeCatalog(catalog, {
    project: source.project,
    location: source.location,
    entryGroup: source.entryGroup,
    customAspects:
        await provisionedCustomAspects(catalog, {project: source.project}),
  });
  return {
    docs: pulled.models.map(m => ({
      name: m.name,
      text: serializeModel(m, {logical: true}).yaml,
    })),
    warnings: pulled.warnings,
  };
}

function existingTarget(profileFile: string): string|undefined {
  try {
    const doc = yaml.parse(fs.readFileSync(profileFile, 'utf8'));
    const t = doc?.semantic_model?.[0]?.deployment_target;
    return typeof t === 'string' ? t : undefined;
  } catch {
    return undefined;
  }
}

function modelTargets(text: string): string[] {
  try {
    return loadModels(text, {bindingOptional: true}).models.flatMap(
        (m: SemanticModel) => bigQueryGraphTargets(m).targets.map(t => t.uri));
  } catch {
    return [];
  }
}

export async function bind(options: BindOptions = {}): Promise<number> {
  const profileName = typeof options.profile === 'string' ? options.profile : 'bigquery';
  if (!/^[A-Za-z0-9_-]+$/.test(profileName)) {
    console.error(`Error: --profile must be a profile name; got '${profileName}'.`);
    return 1;
  }
  if (!options.scan && !options.scanFile) {
    console.error('Error: pass --scan <project>.<dataset glob> (or --scan-file <file>).');
    return 1;
  }
  let pattern: ScanPattern|undefined;
  if (options.scan) {
    const p = parseScanPattern(options.scan);
    if ('error' in p) {
      console.error(`Error: ${p.error}.`);
      return 1;
    }
    pattern = p;
  }
  const labels = bqProfile.parseJobLabels(options.label);
  if ('error' in labels) {
    console.error(`Error: ${labels.error}.`);
    return 1;
  }
  const root = options.cwd ?? '.';
  const location = options.location ?? 'US';
  const ctx = apiContext();

  // The model document(s).
  let docs: BindDoc[];
  let scopeProject: string|undefined;
  if (options.model) {
    if (options.fromCatalog) {
      console.error('Error: --model and --from-catalog cannot be combined.');
      return 1;
    }
    const file = path.resolve(root, options.model);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      console.error(`Error: could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    const stem = path.basename(file).replace(/\.(ya?ml|json)$/i, '');
    docs = [{name: stem, text, profileDir: path.join(path.dirname(file), `${stem}.profiles`)}];
  } else {
    const scoped = await scopeDocs(root, ctx, !!options.fromCatalog);
    if ('error' in scoped) {
      console.error(`Error: ${scoped.error}`);
      return 1;
    }
    docs = scoped.docs;
    scopeProject = scoped.project;
  }

  // The scan.
  const credentials = !!ctx.token;
  const jobProject = options.project ?? pattern?.project ?? ctx.project;
  const client = credentials ? new BigQueryClient(ctx) : undefined;
  const query: QueryFn|undefined = client && jobProject ?
      sql => bqProfile.runProfileQuery(client, jobProject, sql, {location, labels: labels.labels}) :
      undefined;
  let scan: CatalogScan;
  try {
    if (options.scanFile) {
      scan = readScanFile(fs.readFileSync(path.resolve(root, options.scanFile), 'utf8'),
                          pattern?.project ?? scopeProject ?? ctx.project);
    } else {
      if (!query) {
        console.error('Error: the scan needs credentials (gcloud auth application-default login).');
        return 1;
      }
      scan = await runScan(pattern!, location, query);
    }
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  let failed = false;
  let review = 0;
  for (const doc of docs) {
    const profileFile = path.join(doc.profileDir, `${profileName}.yaml`);
    const target = options.deploymentTarget ?? existingTarget(profileFile) ?? modelTargets(doc.text)[0];
    const excluded = [...list(options.exclude)];
    const td = targetDataset(target);
    if (td) excluded.push(td);
    const {tables, dropped} = filterScan(scan, {
      exclude: excluded,
      includeViews: options.includeViews,
      datasetGlob: pattern?.datasetGlob,
    });
    console.log(`[${doc.name}] ${tables.length} table(s) to consider${
        dropped.length ? `, ${dropped.length} dropped` : ''}.`);

    let kcHits: Map<string, Set<string>>|undefined;
    if (options.kcSearch && credentials) {
      const models = loadModels(doc.text, {bindingOptional: true}).models;
      kcHits = new Map();
      for (const m of models) {
        for (const [k, v] of await catalogSearchHits(ctx, pattern?.project ?? ctx.project, m, tables)) {
          kcHits.set(k, v);
        }
      }
    }

    const profileData = options.profileData !== false;
    if (profileData && !query) console.warn('Warning: no credentials; binding without profiling the data.');
    let bound;
    try {
      bound = await bindDocument({
        modelText: doc.text,
        docName: doc.name,
        tables,
        profileName,
        profileData,
        defaultProject: pattern?.project ?? scopeProject,
        kcHits,
      }, query);
    } catch (e) {
      console.error(`Error: [${doc.name}] ${e instanceof Error ? e.message : String(e)}`);
      failed = true;
      continue;
    }
    const meta: BindRunMeta = {
      profile: profileName,
      scan: options.scan ?? options.scanFile!,
      tablesScanned: tables.length,
      dropped,
      acceptReview: !!options.acceptReview,
      deploymentTarget: target,
    };
    const profileText = renderProfileYaml(bound.results, meta);
    const reportText = renderBindReport(bound.results, bound.models, meta);
    const outDir = options.out ? path.resolve(root, options.out) : doc.profileDir;
    const reportFile = path.join(outDir, 'bind_report.md');
    const scanFile = path.join(outDir, 'bind_scan.json');
    try {
      fs.mkdirSync(doc.profileDir, {recursive: true});
      fs.mkdirSync(outDir, {recursive: true});
      fs.writeFileSync(profileFile, profileText);
      fs.writeFileSync(reportFile, reportText);
      fs.writeFileSync(scanFile, `${JSON.stringify(scan, null, 2)}\n`);
    } catch (e) {
      console.error(`Error: could not write: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    for (const r of bound.results) {
      printSummary(r);
      for (const w of r.warnings) console.warn(`Warning: [${r.model}] ${w}`);
      if (!options.acceptReview) review += reviewItems(r);
    }
    const errors = checkProfile(doc.text, profileText, profileName, doc.name,
                                pattern?.project ?? scopeProject);
    for (const e of errors) console.error(`Error: [${doc.name}] the written profile: ${e}`);
    if (errors.length) failed = true;
    console.log(`Wrote ${profileFile}, ${reportFile} and ${scanFile}.`);
  }
  if (failed) return 1;
  if (review) {
    console.log(`\n${review} item(s) need review (see bind_report.md); rerun with --accept-review to accept them.`);
    return 2;
  }
  return 0;
}

function reviewItems(r: ModelBindResult): number {
  const s = bindSummary(r.bindings);
  let pending = 0;
  for (const p of r.proposals.values()) pending += p.normalize.length;
  return s.counts.needs_review + s.counts.unbound + pending;
}

function printSummary(r: ModelBindResult): void {
  const s = bindSummary(r.bindings);
  console.log(`[${r.model}] ${s.counts.auto} bound, ${s.counts.derived} derived, ${
      s.counts.needs_review} need review, ${s.counts.unbound} unbound of ${s.concrete} concrete entities (${
      Math.round(100 * s.acceptedShare)}% accepted); ${s.counts.vocabulary} vocabularies, ${
      s.counts.no_table} without a table.`);
  if (r.notProfiled) console.log(`[${r.model}] data not profiled: ${r.notProfiled}.`);
}
