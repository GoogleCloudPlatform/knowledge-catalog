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
import {checkHydration} from '../hydration';
import {SemanticModel} from '../ir';
import {loadModels, loadSemanticModels} from '../loader';
import {distinctQueries, evaluateProfile, planBigQueryProfile, ProfileFinding, ProfilePlan, QueryOutcome} from '../profile_bigquery';
import {mergeProfileOntoDoc} from '../resolve_profiles';
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

function loadOne(text: string, docName: string, defaultProject?: string):
    {models: SemanticModel[]}|{error: string} {
  const loaded = loadSemanticModels(
      [{name: docName, text}], {defaultProject, bindingOptional: true});
  if (loaded.error) return {error: loaded.error};
  return {models: loaded.models.map(m => m.model)};
}

async function profileModel(
    input: BindDocumentInput, model: SemanticModel, bindings: EntityBinding[],
    query: QueryFn): Promise<{plan?: ProfilePlan; findings: ProfileFinding[];
                              proposals: Map<string, EntityProposals>; notProfiled?: string}> {
  const empty = {findings: [], proposals: new Map<string, EntityProposals>()};
  const merged = mergeProfileOntoDoc(
      input.modelText, yaml.stringify(draftProfileDoc(model.name, bindings)), input.profileName);
  if ('error' in merged) return {...empty, notProfiled: `the draft profile does not merge: ${merged.error}`};
  const loaded = loadOne(merged.text, input.docName, input.defaultProject);
  if ('error' in loaded) return {...empty, notProfiled: `the draft profile does not load: ${loaded.error}`};
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
 * Checks a written profile the way push will read it: merged onto the model,
 * loaded, and its hydration cross-checked. Returns the errors.
 */
export function checkProfile(
    modelText: string, profileText: string, profileName: string, docName: string,
    defaultProject?: string): string[] {
  const merged = mergeProfileOntoDoc(modelText, profileText, profileName);
  if ('error' in merged) return [merged.error];
  const loaded = loadOne(merged.text, docName, defaultProject);
  if ('error' in loaded) return [loaded.error];
  return loaded.models.flatMap(m => checkHydration(m).errors);
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
