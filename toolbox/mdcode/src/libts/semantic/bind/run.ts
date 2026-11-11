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
import {snakeCase} from '../generated_views';
import {checkHydration} from '../hydration';
import {Entity, SemanticModel} from '../ir';
import {loadModels} from '../loader';
import {lowerNodeViews} from '../node_views';
import {distinctQueries, evaluateProfile, planBigQueryProfile, ProfileFinding, ProfilePlan, QueryOutcome} from '../profile_bigquery';
import {modelFileAloneMessage, profileForDocument} from '../resolve_profiles';
import {loadSqlEngine} from '../sql_parser';
import {bindChecks, EntityProposals, evaluateRefinements, planRefinements, tablesByRef} from './hydrate';
import {buildProfileRelationships, ModelBindResult} from './report';
import {CatalogScan, parseScanResult, ScanPattern, scanSql, ScanTable, tableUri} from './scan';
import {bindEntities, BindThresholds, EntityBinding} from './score';

/** Runs one single-row query. */
export type QueryFn = (sql: string) => Promise<QueryOutcome>;

/** Runs `sqls` (each once) with bounded concurrency; outcomes keyed by SQL. */
export async function runAll(
    sqls: string[], query: QueryFn, concurrency = 6):
    Promise<Map<string, QueryOutcome>> {
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
  await Promise.all(
      Array.from({length: Math.max(1, Math.min(concurrency, queue.length))}, worker));
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

/**
 * The flat draft `ProfileSpec` document the profiler reads (no hydration):
 * physical keys and relationship join columns included so `planBigQueryProfile`
 * queries the candidate tables directly.
 */
export function draftProfileDoc(
    profileName: string, bindings: EntityBinding[],
    model?: SemanticModel): Record<string, unknown> {
  const entities: Array<Record<string, unknown>> = [];
  const entityByName = new Map((model?.entities ?? []).map(e => [e.name, e]));
  for (const b of bindings) {
    const e = entityByName.get(b.entity);
    if (b.chosen && (b.status === 'auto' || b.status === 'needs_review')) {
      const [project, dataset, ...rest] = b.chosen.table.split('.');
      const matched = b.chosen.matches.filter(m => m.typeOk);
      const matchedNames = new Set(matched.map(m => m.field));
      const excluded = [
        ...b.chosen.matches.filter(m => !m.typeOk).map(m => m.field),
        ...b.chosen.unmatched,
      ].filter(f => !matchedNames.has(f));
      const pk = e?.keys?.length ?
          e.keys.map(
              k => b.chosen!.matches.find(m => m.field === k)?.column ??
                  snakeCase(k)) :
          undefined;
      const uks = (e?.uniqueKeys ?? [])
                      .filter(uk => uk.length > 0)
                      .map(
                          uk => uk.map(
                              k => b.chosen!.matches.find(m => m.field === k)
                                       ?.column ??
                                  snakeCase(k)));
      entities.push({
        name: b.entity,
        source: tableUri({project, dataset, table: rest.join('.')}),
        ...(pk ? {primary_key: pk} : {}),
        ...(uks.length ? {unique_keys: uks} : {}),
        ...(matched.length ? {
          fields: matched.map(m => ({name: m.field, expression: m.column})),
        } :
                             {}),
        ...(excluded.length ? {fields_exclude: excluded} : {}),
      });
    } else if (b.status === 'vocabulary' &&
               (b.vocabFields?.length || b.vocabUnbound?.length)) {
      entities.push({
        name: b.entity,
        ...(b.vocabFields?.length ? {
          fields:
              b.vocabFields.map(v => ({name: v.field, expression: v.column})),
        } :
                                    {}),
        ...(b.vocabUnbound?.length ? {fields_exclude: b.vocabUnbound} : {}),
      });
    } else if (b.status === 'derived' && b.deriveFrom) {
      entities.push({
        name: b.entity,
        hydration: {derive_from: {relationship: b.deriveFrom.relationship}},
      });
    }
  }
  const relationships = buildProfileRelationships(model, bindings, true);
  return {
    name: profileName,
    entities,
    ...(relationships.length ? {relationships} : {}),
  };
}

// Applies the flat profile `profileText` to `modelText` using
// `resolve_profiles.profileForDocument`, exactly as push reads it.
function loadProfiled(
    modelText: string, profileText: string, profileName: string,
    docName: string): {models: SemanticModel[]}|{error: string} {
  const res = profileForDocument(
      {name: docName, text: modelText}, [{name: profileName, text: profileText}],
      profileName);
  if (res.kind === 'missing') {
    return {error: `no binding profile '${profileName}' to apply`};
  }
  if (res.kind === 'error') {
    return {
      error: res.stage === 'load' ?
          modelFileAloneMessage(res.error, profileName) :
          res.error,
    };
  }
  return {models: [res.model]};
}

async function profileModel(
    input: BindDocumentInput, model: SemanticModel, bindings: EntityBinding[],
    query: QueryFn): Promise<{
  plan?: ProfilePlan; findings: ProfileFinding[];
  proposals: Map<string, EntityProposals>;
  notProfiled?: string;
}> {
  const empty = {findings: [], proposals: new Map<string, EntityProposals>()};
  const draft =
      yaml.stringify(draftProfileDoc(input.profileName, bindings, model));
  const loaded =
      loadProfiled(input.modelText, draft, input.profileName, input.docName);
  if ('error' in loaded) {
    return {
      ...empty,
      notProfiled: `the draft profile does not apply: ${loaded.error}`,
    };
  }
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
  await loadSqlEngine();
  const {models, warnings} = loadModels(
      input.modelText,
      {bindingOptional: true, defaultProject: input.defaultProject});
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
      semanticModel: model,
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
    _defaultProject?: string): string[] {
  const loaded = loadProfiled(modelText, profileText, profileName, docName);
  if ('error' in loaded) return [loaded.error];
  // Check hydration against the logical model keys/joins with only each
  // entity's hydration/source/mode overlaid so logical resolve/derive_from
  // field names match before physical key/join lowering.
  const baseModels =
      loadModels(modelText, {bindingOptional: true}).models;
  const baseByName = new Map(baseModels.map(m => [m.name, m]));
  return loaded.models.flatMap(m => {
    const base = baseByName.get(m.name);
    if (!base) return checkHydration(m).errors;
    const byEnt = new Map((m.entities ?? []).map(e => [e.name, e]));
    const hybrid: SemanticModel = {
      ...base,
      entities: (base.entities ?? []).map(be => {
        const pe = byEnt.get(be.name);
        if (!pe) return be;
        return {
          ...be,
          dataSource: pe.dataSource,
          hydration: pe.hydration,
          mode: pe.mode,
        };
      }),
    };
    return checkHydration(hybrid).errors;
  });
}

/**
 * The entities whose node view would apply or report at least one of the
 * model's constraints under the profile (`kcmd bind --enforce-constraints`
 * writes `hydration.constraints: enforce` on exactly these).
 */
export function enforceableEntities(
    modelText: string, profileText: string, profileName: string, docName: string,
    _defaultProject?: string): Set<string> {
  const out = new Set<string>();
  const loaded = loadProfiled(modelText, profileText, profileName, docName);
  if ('error' in loaded) return out;
  for (const model of loaded.models) {
    if (!(model.constraints ?? []).length) continue;
    const eligible = (e: Entity) => !e.abstract && !e.definition &&
        e.members === undefined && e.mode !== 'direct' &&
        !e.hydration?.deriveFrom;
    const all: SemanticModel = {
      ...model,
      entities: (model.entities ?? []).map(
          e => eligible(e) ? {
            ...e,
            hydration: {...(e.hydration ?? {}), constraints: 'enforce'},
          } :
                             e),
    };
    let target: {project?: string; dataset?: string} =
        {project: 'p', dataset: 'kcmd_bind'};
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
    super(
        process.env.DATAPLEX_ENDPOINT || 'https://dataplex.googleapis.com',
        'v1', ctx);
  }

  async search(project: string, query: string): Promise<string[]> {
    const res = await this._post<{
      results?: Array<{dataplexEntry?: {fullyQualifiedName?: string}}>;
    }>(`projects/${project}/locations/global:searchEntries`, {},
       {query, pageSize: 20});
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
  const known =
      new Set(tables.map(t => `${t.project}.${t.dataset}.${t.table}`));
  const hits = new Map<string, Set<string>>();
  for (const e of model.entities ?? []) {
    if (e.abstract || e.definition || e.members !== undefined ||
        !e.keys?.length) {
      continue;
    }
    const found = new Set<string>();
    for (const name of [e.name, ...(e.aiContext?.synonyms ?? [])].slice(0, 3)) {
      for (const ref of
               await client.search(project, `system=bigquery ${name}`)) {
        if (known.has(ref)) found.add(ref);
      }
    }
    if (found.size) hits.set(e.name, found);
  }
  return hits;
}
