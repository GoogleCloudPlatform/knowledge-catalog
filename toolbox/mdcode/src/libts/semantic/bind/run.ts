// `kcmd bind`: the orchestration (network through an injected query
// function, so it is tested without BigQuery).
//
//   scan -> score (steps 1-2) -> profile the chosen tables with a draft
//   profile (step 3: keys, orphans, regime shifts) -> refinement queries ->
//   proposals -> the profile document and the report (step 4)
//
// The draft profile binds each chosen table with its matched columns and no
// hydration, leaving out columns whose type contradicts the field (a STRING
// `close_date` for a Date field would make a poor regime clock), so the
// profiler sees the raw rows the proposals are about.

import * as yaml from 'yaml';

import * as api from '../../gcp/api';
import * as context from '../../gcp/context';
import {googleDeploymentTargets} from '../deployment_target';
import {checkHydration} from '../hydration';
import {Entity, SemanticModel} from '../ir';
import {loadModels, loadSemanticModels} from '../loader';
import {lowerNodeViews} from '../node_views';
import {distinctQueries, evaluateProfile, planBigQueryProfile, ProfileFinding, ProfilePlan, QueryOutcome} from '../profile_bigquery';
import {applyProfileExclusions, modelFileAloneMessage, profileForDocument} from '../resolve_profiles';
import {bindChecks, EntityProposals, evaluateRefinements, planRefinements, tablesByRef} from './hydrate';
import {ModelBindResult} from './report';
import {CatalogScan, parseScanResult, ScanPattern, scanSql, ScanTable, tableUri} from './scan';
import {bindEntities, BindThresholds, EntityBinding} from './score';

/** Runs one single-row query. */
export type QueryFn = (sql: string) => Promise<QueryOutcome>;

/** Runs `sqls` (each once) with bounded concurrency; outcomes keyed by SQL. */
export async function runAll(
    sqls: string[], query: QueryFn, concurrency = 6): Promise<Map<string, QueryOutcome>> {
  const queue = [...new Set(sqls)];
  const out = new Map<string, QueryOutcome>();
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const sql = queue[next++];
      try {
        out.set(sql, await query(sql));
      } catch (err) {
        out.set(sql, {error: err instanceof Error ? err.message : String(err)});
      }
    }
  };
  await Promise.all(Array.from({length: Math.max(1, Math.min(concurrency, queue.length))}, worker));
  return out;
}

/** Step 0: the INFORMATION_SCHEMA scan. */
export async function runScan(
    pattern: ScanPattern, location: string, query: QueryFn): Promise<CatalogScan> {
  const res = await query(scanSql(pattern, location));
  if ('error' in res) throw new Error(`the catalog scan failed: ${res.error}`);
  return parseScanResult(pattern.project, res.row.tables);
}

export interface BindDocumentInput {
  // The logical model document (YAML text).
  modelText: string;
  // A name for the document in messages.
  docName: string;
  tables: ScanTable[];
  profileName: string;
  // Profile the chosen tables (step 3). Off: bindings only, no hydration.
  profileData: boolean;
  defaultProject?: string;
  thresholds?: Partial<BindThresholds>;
  kcHits?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface BindDocumentResult {
  models: SemanticModel[];
  results: ModelBindResult[];
}

const VERSION = '0.2.0.dev0/google';

/** The draft profile document the profiler reads (no hydration). */
export function draftProfileDoc(model: string, bindings: EntityBinding[]): Record<string, unknown> {
  const entities: Array<Record<string, unknown>> = [];
  for (const b of bindings) {
    if (b.chosen && (b.status === 'auto' || b.status === 'needs_review')) {
      const [project, dataset, ...rest] = b.chosen.table.split('.');
      entities.push({
        name: b.entity,
        source: tableUri({project, dataset, table: rest.join('.')}),
        fields: b.chosen.matches.filter(m => m.typeOk)
                    .map(m => ({name: m.field, expression: m.column})),
      });
    } else if (b.status === 'vocabulary' && b.vocabFields?.length) {
      entities.push({
        name: b.entity,
        fields: b.vocabFields.map(v => ({name: v.field, expression: v.column})),
      });
    }
  }
  return {version: VERSION, semantic_model: [{name: model, entities}]};
}

// The models of the document `modelText` with the profile `profileText`
// applied, as push applies it (resolve_profiles' profileForDocument): a profile
// file applies to the model file loaded on its own; a legacy `semantic_model:`
// wrapper -- the layout `kcmd bind` writes, which may name its graph with
// `deployment_target` -- is merged into the text and loaded as push loads one,
// with its exclusions marked.
function loadProfiled(
    modelText: string, profileText: string, profileName: string,
    docName: string, defaultProject?: string):
    {models: SemanticModel[]}|{error: string} {
  const res = profileForDocument(
      {name: docName, text: modelText}, [{name: profileName, text: profileText}],
      profileName);
  if (res.kind === 'missing') {
    return {error: `no binding profile '${profileName}' to apply`};
  }
  if (res.kind === 'error') {
    return {
      error: res.stage === 'load' ? modelFileAloneMessage(res.error, profileName) :
                                    res.error,
    };
  }
  if (res.kind === 'file') return {models: [res.model]};
  const loaded = loadSemanticModels(
      [{
        name: docName,
        text: res.text,
        allowLegacyBareSource: true,
        excluded: res.excluded,
      }],
      {defaultProject, bindingOptional: true});
  if (loaded.error) return {error: loaded.error};
  return {
    models: loaded.models.map(m => applyProfileExclusions(m.model, res.excluded)),
  };
}

async function profileModel(
    input: BindDocumentInput, model: SemanticModel, bindings: EntityBinding[],
    query: QueryFn): Promise<{plan?: ProfilePlan; findings: ProfileFinding[];
                              proposals: Map<string, EntityProposals>; notProfiled?: string}> {
  const empty = {findings: [], proposals: new Map<string, EntityProposals>()};
  const loaded = loadProfiled(
      input.modelText, yaml.stringify(draftProfileDoc(model.name, bindings)),
      input.profileName, input.docName, input.defaultProject);
  if ('error' in loaded) return {...empty, notProfiled: `the draft profile does not apply: ${loaded.error}`};
  const bound = loaded.models.find(m => m.name === model.name);
  if (!bound) return {...empty, notProfiled: 'the draft profile lost the model'};
  const full = planBigQueryProfile(bound);
  const plan: ProfilePlan = {...full, checks: bindChecks(full.checks)};
  const outcomes = await runAll(distinctQueries(plan), query);
  const findings = evaluateProfile(plan, outcomes);
  const refinements = planRefinements({
    model,
    bindings,
    tables: tablesByRef(input.tables),
    plan,
    findings,
  });
  const refined = await runAll(refinements.map(r => r.sql), query);
  return {plan, findings, proposals: evaluateRefinements(refinements, refined)};
}

/**
 * Binds every model of a logical document over the scanned tables, profiling
 * the chosen tables through `query` when `profileData` is set.
 */
export async function bindDocument(
    input: BindDocumentInput, query?: QueryFn): Promise<BindDocumentResult> {
  const {models, warnings} = loadModels(
      input.modelText, {bindingOptional: true, defaultProject: input.defaultProject});
  const results: ModelBindResult[] = [];
  for (const model of models) {
    const bindings = bindEntities(model, input.tables, {
      thresholds: input.thresholds,
      kcHits: input.kcHits,
    });
    const result: ModelBindResult = {
      model: model.name,
      bindings,
      proposals: new Map(),
      findings: [],
      warnings: [...warnings],
    };
    if (!input.profileData) {
      result.notProfiled = 'run with --no-profile-data';
    } else if (!query) {
      result.notProfiled = 'no credentials to run queries';
    } else {
      const p = await profileModel(input, model, bindings, query);
      result.plan = p.plan;
      result.findings = p.findings;
      result.proposals = p.proposals;
      if (p.notProfiled) result.notProfiled = p.notProfiled;
      for (const f of p.findings) {
        if (f.error) result.warnings.push(`profile ${f.id}: ${f.summary}`);
      }
    }
    results.push(result);
  }
  return {models, results};
}

/**
 * Checks a written profile the way push will read it: applied to the model,
 * loaded, and its hydration cross-checked. Returns the errors.
 */
export function checkProfile(
    modelText: string, profileText: string, profileName: string, docName: string,
    defaultProject?: string): string[] {
  const loaded =
      loadProfiled(modelText, profileText, profileName, docName, defaultProject);
  if ('error' in loaded) return [loaded.error];
  return loaded.models.flatMap(m => checkHydration(m).errors);
}

/**
 * The entities whose node view would apply or report at least one of the
 * model's constraints under the profile (`kcmd bind --enforce-constraints`
 * writes `hydration.constraints: enforce` on exactly these). Planned with the
 * same lowering the push runs, every eligible entity switched on; an entity
 * bound directly, derived, or left without a node view is not listed.
 */
export function enforceableEntities(
    modelText: string, profileText: string, profileName: string, docName: string,
    defaultProject?: string): Set<string> {
  const out = new Set<string>();
  const loaded =
      loadProfiled(modelText, profileText, profileName, docName, defaultProject);
  if ('error' in loaded) return out;
  for (const model of loaded.models) {
    if (!(model.constraints ?? []).length) continue;
    const eligible = (e: Entity) => !e.abstract && !e.definition &&
        e.members === undefined && e.mode !== 'direct' && !e.hydration?.deriveFrom;
    const all: SemanticModel = {
      ...model,
      entities: (model.entities ?? []).map(
          e => eligible(e) ?
              {...e, hydration: {...(e.hydration ?? {}), constraints: 'enforce'}} :
              e),
    };
    let target: {project?: string; dataset?: string} = {project: 'p', dataset: 'kcmd_bind'};
    try {
      const t = googleDeploymentTargets(model).bigQuery[0];
      if (t) target = {project: t.project, dataset: t.dataset};
    } catch {
      // a malformed target: plan against a placeholder dataset
    }
    for (const [name, e] of lowerNodeViews(all, target, []).enforcement) {
      if (e.plan.rules.length) out.add(name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Optional: a Knowledge Catalog search per entity (the 0.10 signal).
// ---------------------------------------------------------------------------

class CatalogSearchClient extends api.ApiClient {
  constructor(ctx: context.ApiContext) {
    super(process.env.DATAPLEX_ENDPOINT || 'https://dataplex.googleapis.com', 'v1', ctx);
  }

  async search(project: string, query: string): Promise<string[]> {
    const res = await this._post<{results?: Array<{dataplexEntry?: {fullyQualifiedName?: string}}>}>(
        `projects/${project}/locations/global:searchEntries`, {}, {query, pageSize: 20});
    if (res.status !== 200 || !res.result) return [];
    return (res.result.results ?? [])
        .map(r => r.dataplexEntry?.fullyQualifiedName ?? '')
        .filter(n => n.startsWith('bigquery:'))
        .map(n => n.slice('bigquery:'.length));
  }
}

/** Tables a catalog search for each concrete entity's names returns. */
export async function catalogSearchHits(
    ctx: context.ApiContext, project: string, model: SemanticModel,
    tables: ScanTable[]): Promise<Map<string, Set<string>>> {
  const client = new CatalogSearchClient(ctx);
  const known = new Set(tables.map(t => `${t.project}.${t.dataset}.${t.table}`));
  const hits = new Map<string, Set<string>>();
  for (const e of model.entities ?? []) {
    if (e.abstract || e.definition || e.members !== undefined || !e.keys?.length) continue;
    const found = new Set<string>();
    for (const name of [e.name, ...(e.aiContext?.synonyms ?? [])].slice(0, 3)) {
      for (const ref of await client.search(project, `system=bigquery ${name}`)) {
        if (known.has(ref)) found.add(ref);
      }
    }
    if (found.size) hits.set(e.name, found);
  }
  return hits;
}
