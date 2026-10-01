// Business glossary (K9) executor: sends the plan glossary.ts builds.
//
// Kept apart from glossary.ts so that module stays pure (no network, no GCP
// clients) and unit-testable offline; this file only resolves what the plan
// needs from the environment (project numbers, BigQuery dataset locations),
// sends the requests in order, and reports.
//
// Idempotent: every create that answers 409 ALREADY_EXISTS is followed by a
// PATCH with an update mask (glossary, categories, terms) or counted as
// already present (entry links, which are immutable). `prune` deletes the
// terms and categories kcmd created for this model (label `managed-by: kcmd`
// and `kcmd-model: <model>`) that the spec no longer declares.

import {CatalogClient} from '../gcp/dataplex';
import {BigQueryClient} from '../gcp/bigquery';
import {ApiContext} from '../gcp/context';
import {ResourceManagerClient} from '../gcp/crm';

import {bigQueryTableParts, glossaryFromDataplex, GlossaryPlan, GlossaryRequest, GlossaryTarget, MANAGED_BY_LABEL, MANAGED_BY_VALUE, MODEL_LABEL, modelLabelValue, planGlossary} from './glossary';
import {Glossary, SemanticModel} from './ir';

export interface GlossaryPublishOptions {
  // Glossary project (default: the context project) and location (default
  // `global`).
  project?: string;
  location?: string;
  // The kcmd entry group (catalog.yaml source) for the semantic-entry legs.
  semantic?: {project: string; location: string; entryGroup: string};
  // Print the plan; send nothing (reads still run to resolve numbers).
  dryRun?: boolean;
  // Delete kcmd-managed terms / categories the spec no longer declares.
  prune?: boolean;
  log?: (line: string) => void;
}

export interface GlossaryPublishResult {
  plan: GlossaryPlan;
  created: string[];
  updated: string[];
  existing: string[];
  deleted: string[];
  // Not sent or refused but not fatal (with the reason).
  skipped: string[];
  errors: string[];
}

/**
 * Resolves the environment the plan needs: the project numbers of the
 * glossary project, the semantic entry-group project and every BigQuery data
 * project; the location of every bound dataset. A failed read leaves the
 * value unknown, so the plan skips that link with a note (or, in a dry run,
 * shows a placeholder).
 */
export async function resolveGlossaryTarget(
    model: SemanticModel, ctx: ApiContext,
    opts: GlossaryPublishOptions): Promise<GlossaryTarget> {
  const crm = new ResourceManagerClient(ctx);
  const bq = new BigQueryClient(ctx);
  const numbers = new Map<string, string>();
  const number = async (project: string): Promise<string|undefined> => {
    if (/^\d+$/.test(project)) return project;
    if (numbers.has(project)) return numbers.get(project);
    const res = await crm.getProject(project);
    const n = res.status === 200 ?
        res.result?.name?.replace(/^projects\//, '') :
        undefined;
    if (n) numbers.set(project, n);
    else if (opts.dryRun) numbers.set(project, `{number-of-${project}}`);
    return numbers.get(project);
  };
  const project = opts.project ?? ctx.project;
  const projectNumber = await number(project) ?? project;

  const datasetLocations = new Map<string, string>();
  for (const e of model.entities ?? []) {
    const tbl = bigQueryTableParts(e.dataSource);
    if (!tbl || e.abstract || e.definition) continue;
    const key = `${tbl.project}.${tbl.dataset}`;
    if (datasetLocations.has(key)) continue;
    await number(tbl.project);
    const ds = await bq.getDataset(tbl.project, tbl.dataset);
    const loc = ds.status === 200 ? (ds.result as any)?.location : undefined;
    if (loc) datasetLocations.set(key, String(loc).toLowerCase());
    else if (opts.dryRun) datasetLocations.set(key, `{location-of-${key}}`);
  }

  const target: GlossaryTarget = {
    project,
    projectNumber,
    location: opts.location ?? 'global',
    datasetLocations,
    projectNumbers: numbers,
  };
  if (opts.semantic) {
    target.semantic = {
      ...opts.semantic,
      projectNumber: await number(opts.semantic.project),
    };
  }
  return target;
}

/** Plans and (unless dry-run) publishes `model.glossary`. */
export async function publishGlossary(
    model: SemanticModel, ctx: ApiContext,
    opts: GlossaryPublishOptions = {}): Promise<GlossaryPublishResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const target = await resolveGlossaryTarget(model, ctx, opts);
  const plan = planGlossary(model, target);
  const result: GlossaryPublishResult = {
    plan,
    created: [],
    updated: [],
    existing: [],
    deleted: [],
    skipped: [...plan.notes],
    errors: [],
  };

  if (opts.dryRun) {
    for (const r of plan.requests) {
      log(`POST ${r.path}?${new URLSearchParams(r.query)}  (${r.label})`);
      log(JSON.stringify(r.body, null, 2));
    }
    for (const n of plan.notes) log(`skip: ${n}`);
    if (opts.prune) log(`prune: would delete kcmd-managed terms/categories ` +
        `of model '${model.name}' not in the spec`);
    return result;
  }

  const dp = new CatalogClient(ctx);
  for (const r of plan.requests) {
    const err = await send(dp, r, result);
    if (!err) continue;
    // A refused definition link on a kcmd (custom) entry is not fatal: the
    // API may not allow definition links on custom entries, or the field
    // path may not exist on the entry's schema aspect (inherited fields).
    if (r.kind === 'link' && !r.path.includes('/entryGroups/@')) {
      result.skipped.push(`${r.label}: refused on the semantic entry (${err})`);
    } else {
      result.errors.push(`${r.label}: ${err}`);
    }
    // Without the glossary nothing else can land.
    if (r.kind === 'glossary') break;
  }

  if (opts.prune && !result.errors.some(e => e.startsWith('glossary '))) {
    await prune(dp, model, plan, result);
  }
  return result;
}

function errorText(res: {status: number; message?: string}): string {
  const m = res.message ?? '';
  try {
    const j = JSON.parse(m);
    return `${res.status} ${j?.error?.message ?? m}`.trim();
  } catch {
    return `${res.status} ${m}`.trim();
  }
}

// A create that hit an existing resource. Glossaries and entry links answer
// 409; glossary terms answer 400 "... already exists".
function isConflict(res: {status: number; message?: string}): boolean {
  return res.status === 409 ||
      (res.status === 400 && /already exists/i.test(res.message ?? ''));
}

// Sends one request; returns an error string or undefined.
async function send(
    dp: CatalogClient, r: GlossaryRequest,
    result: GlossaryPublishResult): Promise<string|undefined> {
  const res = await dp._post<any>(r.path, r.body, r.query);
  if (res.status === 200) {
    if (r.lro) {
      const e = await dp.awaitOperation(res.result, r.label);
      if (e) return e;
    }
    result.created.push(r.name);
    return undefined;
  }
  if (!isConflict(res)) return errorText(res);
  if (r.onConflict === 'exists') {
    result.existing.push(r.name);
    return undefined;
  }
  const patched =
      await dp._patch<any>(r.name, r.body, {updateMask: r.onConflict.updateMask});
  if (patched.status !== 200) return `update: ${errorText(patched)}`;
  if (r.lro) {
    const e = await dp.awaitOperation(patched.result, r.label);
    if (e) return e;
  }
  result.updated.push(r.name);
  return undefined;
}

interface Listed {
  name: string;
  parent?: string;
  labels?: Record<string, string>;
}

/**
 * Reads back the glossary kcmd published for `model` (the reverse of
 * publishGlossary): the glossary labelled `kcmd-model: <model>` in
 * `project`/`location`, with its categories and terms, as a spec block.
 * Undefined when there is none. The building block for a Knowledge Catalog
 * pull; `kcmd pull` does not call it yet.
 */
export async function pullGlossary(
    ctx: ApiContext, model: Pick<SemanticModel, 'name'>,
    opts: {project: string; location?: string}): Promise<Glossary|undefined> {
  const dp = new CatalogClient(ctx);
  const parent = `projects/${opts.project}/locations/${opts.location ?? 'global'}`;
  const want = modelLabelValue(model.name);
  const glossaries = await listAll(dp, `${parent}/glossaries`, 'glossaries');
  const g = glossaries.find(
      x => x.labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE &&
          x.labels?.[MODEL_LABEL] === want);
  if (!g) return undefined;
  const cats = await listAll(dp, `${g.name}/categories`, 'categories');
  const terms = await listAll(dp, `${g.name}/terms`, 'terms');
  return glossaryFromDataplex(g, cats, terms);
}

async function listAll(
    dp: CatalogClient, collection: string, key: string): Promise<Listed[]> {
  const out: Listed[] = [];
  let pageToken: string|undefined;
  do {
    const res = await dp._get<any>(collection, {pageSize: 1000, pageToken});
    if (res.status !== 200) break;
    out.push(...(res.result?.[key] ?? []));
    pageToken = res.result?.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

// Deletes this model's kcmd-managed terms, then categories (deepest first),
// that the spec no longer declares. Anything not labelled by kcmd for this
// model -- terms curated in the UI, other models' terms -- is left alone.
async function prune(
    dp: CatalogClient, model: SemanticModel, plan: GlossaryPlan,
    result: GlossaryPublishResult): Promise<void> {
  const glossaryReq = plan.requests.find(r => r.kind === 'glossary')!;
  const modelLabel = glossaryReq.body.labels[MODEL_LABEL];
  const ours = (x: Listed) => x.labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE &&
      x.labels?.[MODEL_LABEL] === modelLabel;
  const terms = await listAll(dp, `${plan.glossaryName}/terms`, 'terms');
  for (const t of terms) {
    if (!ours(t) || plan.termNames.has(t.name)) continue;
    const res = await dp._delete<any>(t.name);
    if (res.status === 200) result.deleted.push(t.name);
    else result.errors.push(`delete ${t.name}: ${errorText(res)}`);
  }
  const listed = await listAll(dp, `${plan.glossaryName}/categories`,
                               'categories');
  const byName = new Map(listed.map(c => [c.name, c]));
  const depth = (c: Listed, guard = 0): number => {
    const p = c.parent ? byName.get(c.parent) : undefined;
    return p && guard < 8 ? 1 + depth(p, guard + 1) : 0;
  };
  const cats = listed.filter(c => ours(c) && !plan.categoryNames.has(c.name));
  cats.sort((a, b) => depth(b) - depth(a));
  for (const c of cats) {
    const res = await dp._delete<any>(c.name);
    if (res.status === 200) result.deleted.push(c.name);
    else result.errors.push(`delete ${c.name}: ${errorText(res)}`);
  }
}
