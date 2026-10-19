// Business glossary (K9): the model's `glossary` block (see ir.Glossary) and
// its publication as a Knowledge Catalog (Dataplex) Business Glossary.
//
// Everything K9 owns that needs no network lives in this module, so the
// feature is unit-testable offline and easy to find, rename or drop:
//
//   - checkGlossary: the static checks (unique ids, resolvable categories,
//     related terms and `defines` targets).
//   - termDescription / splitTermDescription: the term description codec. A
//     Dataplex term has only a display name and a description, so what the
//     glossary API has no slot for rides as fixed, parseable trailing
//     paragraphs, which also lets catalog free-text search find synonyms:
//
//       <definition>\n\nFormula: SUM(Order.total)\n\nAlso called: sales,
//       turnover.\n\nRelated terms: net-revenue.\n\nDefines: Order (entity),
//       Order.total (field).\n\nSource: <free text>
//
//   - planGlossary: the ordered, idempotent list of REST requests (glossary,
//     categories, terms, entry links) for one model. The executor
//     (glossary_publish.ts) only sends them.
//   - glossaryFromDataplex: the reverse, for a Knowledge Catalog pull.
//
// Nothing here is specific to one source format: any importer (OWL/SKOS
// today; LookML or others later) feeds the same `glossary:` spec, and the
// publisher only reads the IR.
//
// REST reference (v1):
//   glossaries  https://cloud.google.com/dataplex/docs/reference/rest/v1/projects.locations.glossaries
//   categories  .../projects.locations.glossaries.categories
//   terms       .../projects.locations.glossaries.terms
//   entryLinks  .../projects.locations.entryGroups.entryLinks
//   guide       https://cloud.google.com/dataplex/docs/manage-glossaries

import {snakeCase} from './generated_views';
import {fieldBinding, Glossary, GlossaryCategory, GlossaryDefines, GlossaryTerm, SemanticModel} from './ir';
import {physicalBindings} from './knowledge_catalog';
import {declaredConceptFields} from './resolve_inheritance';
import {stripQualifier} from './sql_expr_utils';
import {isSimpleIdentifier} from './sql_identifiers';

// ---------------------------------------------------------------------------
// Names.
// ---------------------------------------------------------------------------

/** The Dataplex resource-id rule shared by glossaries, categories and terms. */
export const GLOSSARY_ID_RE = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** System entry link types (project `dataplex-types`, location `global`). */
export const LINK_TYPES = {
  definition: 'projects/dataplex-types/locations/global/entryLinkTypes/definition',
  related: 'projects/dataplex-types/locations/global/entryLinkTypes/related',
  synonym: 'projects/dataplex-types/locations/global/entryLinkTypes/synonym',
} as const;

/** The labels every resource kcmd writes carries (prune only touches these). */
export const MANAGED_BY_LABEL = 'managed-by';
export const MANAGED_BY_VALUE = 'kcmd';
export const MODEL_LABEL = 'kcmd-model';

// Lowercase, any other character -> hyphen, collapse runs, start with a
// letter, end with a letter or digit, at most `max` chars. The Dataplex
// resource-id and entry-link-id rule.
export function idSlug(s: string, max = 63): string {
  const out = s.toLowerCase()
                  .replace(/[^a-z0-9-]+/g, '-')
                  .replace(/-+/g, '-')
                  .replace(/^[^a-z]+/, '')
                  .slice(0, max)
                  .replace(/-+$/, '');
  return out || 'x';
}

// Label values: lowercase letters, digits, underscores and hyphens, <= 63.
function labelValue(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 63);
}

/** The `kcmd-model` label value kcmd writes for a model. */
export function modelLabelValue(modelName: string): string {
  return labelValue(modelName);
}

/** The published glossary id: the spec's, else `<model>-glossary`. */
export function glossaryId(model: Pick<SemanticModel, 'name'|'glossary'>):
    string {
  return model.glossary?.id ?? idSlug(`${model.name}-glossary`);
}

/** A term's display name: the spec's, else its id in title case. */
export function termDisplayName(t: Pick<GlossaryTerm, 'id'|'displayName'>):
    string {
  return t.displayName?.trim() || humanize(t.id);
}

export function categoryDisplayName(
    c: Pick<GlossaryCategory, 'id'|'displayName'>): string {
  return c.displayName?.trim() || humanize(c.id);
}

function humanize(id: string): string {
  return id.split('-').filter(Boolean)
      .map(w => w[0].toUpperCase() + w.slice(1))
      .join(' ');
}

// The knowledge_catalog.ts entry-id slug (kept in step with Namer there).
function entrySlug(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// FNV-1a, 32-bit, hex: a short stable suffix that keeps link ids unique when
// the readable part is truncated.
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A deterministic entry-link id: `<prefix>-<readable>-<hash>`, <= 63. */
export function linkId(prefix: string, readable: string, key: string): string {
  return `${prefix}-${idSlug(readable, 63 - prefix.length - 10)}-${fnv(key)}`;
}

// ---------------------------------------------------------------------------
// Static checks.
// ---------------------------------------------------------------------------

const MAX_CATEGORY_DEPTH = 3;  // Dataplex nests categories up to 3 levels.
// A BigQuery data agent imports at most this many glossary terms per table.
export const TERMS_PER_TABLE_HINT = 10;

/**
 * The glossary's static checks. Errors: duplicate ids, an unknown category /
 * parent / related term, a category cycle or nesting deeper than Dataplex
 * allows, and a `defines` naming no entity, `Entity.field` (inherited fields
 * count) or metric. With `fieldsPruned` (a binding profile removed unbound
 * fields and what reads them) an unresolved `defines` is a warning instead.
 * Warnings: a term with no definition; more terms on one table than a data
 * agent imports.
 */
export function checkGlossary(
    model: SemanticModel,
    opts: {fieldsPruned?: boolean} = {}): {errors: string[]; warnings: string[]} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const g = model.glossary;
  if (!g) return {errors, warnings};
  const where = `glossary '${glossaryId(model)}'`;

  const categories = new Map<string, GlossaryCategory>();
  for (const c of g.categories) {
    if (categories.has(c.id)) {
      errors.push(`${where}: duplicate category id '${c.id}'`);
    }
    categories.set(c.id, c);
  }
  for (const c of g.categories) {
    if (c.parent === undefined) continue;
    if (!categories.has(c.parent)) {
      errors.push(`${where}: category '${c.id}' has parent '${c.parent}', ` +
          `which is not a category of the glossary`);
      continue;
    }
    // Walk up: a cycle or more than MAX_CATEGORY_DEPTH levels is an error.
    const seen = new Set([c.id]);
    let depth = 1;
    let cyclic = false;
    let p: string|undefined = c.parent;
    while (p !== undefined && categories.has(p)) {
      if (seen.has(p)) {
        errors.push(`${where}: category '${c.id}' is its own ancestor`);
        cyclic = true;
        break;
      }
      seen.add(p);
      depth++;
      p = categories.get(p)!.parent;
    }
    if (!cyclic && depth > MAX_CATEGORY_DEPTH) {
      errors.push(`${where}: category '${c.id}' is nested ${depth} levels ` +
          `deep; Knowledge Catalog allows ${MAX_CATEGORY_DEPTH}`);
    }
  }

  const termIds = new Set<string>();
  for (const t of g.terms) {
    if (termIds.has(t.id)) errors.push(`${where}: duplicate term id '${t.id}'`);
    termIds.add(t.id);
  }

  const resolver = definesResolver(model);
  const unresolved = (msg: string) =>
      (opts.fieldsPruned ? warnings : errors).push(msg);
  const termsPerEntity = new Map<string, Set<string>>();
  for (const t of g.terms) {
    const label = `${where}: term '${t.id}'`;
    if (t.category !== undefined && !categories.has(t.category)) {
      errors.push(`${label}: category '${t.category}' is not a category of ` +
          `the glossary`);
    }
    for (const r of t.related ?? []) {
      if (r === t.id) {
        errors.push(`${label}: lists itself as related`);
      } else if (!termIds.has(r)) {
        errors.push(`${label}: related term '${r}' is not a term of the ` +
            `glossary`);
      }
    }
    if (!t.definition?.trim()) {
      warnings.push(`${label}: has no definition`);
    }
    for (const d of t.defines ?? []) {
      const hit = resolver(d);
      if (hit.error) {
        unresolved(`${label}: defines ${d.kind} '${d.ref}', ${hit.error}`);
        continue;
      }
      if (hit.entity) {
        const s = termsPerEntity.get(hit.entity) ?? new Set<string>();
        s.add(t.id);
        termsPerEntity.set(hit.entity, s);
      }
    }
  }
  for (const [entity, terms] of termsPerEntity) {
    if (terms.size > TERMS_PER_TABLE_HINT) {
      warnings.push(`${where}: ${terms.size} terms define entity '${entity}' ` +
          `or its fields; a BigQuery data agent imports at most ` +
          `${TERMS_PER_TABLE_HINT} glossary terms per table`);
    }
  }
  return {errors, warnings};
}

/** How one `defines` item resolves against the model. */
export interface ResolvedDefines {
  // The entity the item lands on (the entity itself, a field's owner, or a
  // single-entity metric's entity).
  entity?: string;
  field?: string;
  metric?: string;
  error?: string;
}

/**
 * Resolves `defines` items: `entity` an entity name; `field` `Entity.field`
 * with inherited fields counting; `metric` a metric name.
 */
export function definesResolver(model: SemanticModel):
    (d: GlossaryDefines) => ResolvedDefines {
  const entities = new Map((model.entities ?? []).map(e => [e.name, e]));
  const metrics = new Map((model.metrics ?? []).map(m => [m.name, m]));
  // Inherited fields count. Resolving throws on a dangling `extends`
  // (validate reports that once, elsewhere), so fall back to own fields.
  let fieldsOf: (name: string) => Set<string>;
  try {
    const concepts = declaredConceptFields(model);
    fieldsOf = n => new Set(concepts.get(n)?.fields.keys() ?? []);
  } catch {
    fieldsOf = n => new Set((entities.get(n)?.fields ?? []).map(f => f.name));
  }
  return (d: GlossaryDefines): ResolvedDefines => {
    if (d.kind === 'entity') {
      return entities.has(d.ref) ? {entity: d.ref} :
                                   {error: 'which is not an entity of the model'};
    }
    if (d.kind === 'metric') {
      const m = metrics.get(d.ref);
      return m ? {metric: d.ref, entity: m.entity} :
                 {error: 'which is not a metric of the model'};
    }
    const dot = d.ref.indexOf('.');
    if (dot <= 0 || dot === d.ref.length - 1) {
      return {error: `which is not of the form Entity.field`};
    }
    const entity = d.ref.slice(0, dot);
    const field = d.ref.slice(dot + 1);
    if (!entities.has(entity)) {
      return {error: `whose entity '${entity}' is not an entity of the model`};
    }
    if (!fieldsOf(entity).has(field)) {
      return {error: `which is not a field of '${entity}' (own or inherited)`};
    }
    return {entity, field};
  };
}

// ---------------------------------------------------------------------------
// Term description codec.
// ---------------------------------------------------------------------------

export const FORMULA_PREFIX = 'Formula: ';
export const SYNONYMS_PREFIX = 'Also called: ';
export const RELATED_PREFIX = 'Related terms: ';
export const DEFINES_PREFIX = 'Defines: ';
export const SOURCE_PREFIX = 'Source: ';

function oneLine(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, ' ');
}

function sentence(items: string[]): string {
  return `${items.join(', ')}.`;
}

/**
 * The published term description: the definition, then fixed trailing
 * paragraphs for formula, synonyms ("Also called: a, b."), related term ids,
 * the model elements it defines, and provenance. Free-text catalog search
 * indexes the description, so synonyms become searchable.
 */
export function termDescription(t: GlossaryTerm): string {
  const parts: string[] = [];
  if (t.definition?.trim()) parts.push(t.definition.trim());
  if (t.formula?.trim()) parts.push(FORMULA_PREFIX + oneLine(t.formula));
  if (t.synonyms?.length) {
    parts.push(SYNONYMS_PREFIX + sentence(t.synonyms.map(oneLine)));
  }
  if (t.related?.length) parts.push(RELATED_PREFIX + sentence(t.related));
  if (t.defines?.length) {
    parts.push(DEFINES_PREFIX +
        sentence(t.defines.map(d => `${d.ref} (${d.kind})`)));
  }
  if (t.source?.trim()) parts.push(SOURCE_PREFIX + oneLine(t.source));
  return parts.join('\n\n');
}

function unsentence(s: string): string[] {
  return s.replace(/\.$/, '').split(/,\s*/).map(x => x.trim()).filter(Boolean);
}

/**
 * The reverse of termDescription: peels the trailers back off. Paragraphs
 * that are not trailers stay in the definition, so a description edited in
 * the catalog UI still round-trips its prose.
 */
export function splitTermDescription(description: string):
    Omit<GlossaryTerm, 'id'|'displayName'|'category'> {
  const out: Omit<GlossaryTerm, 'id'|'displayName'|'category'> = {};
  const prose: string[] = [];
  for (const p of description.split(/\n\s*\n/)) {
    const para = p.trim();
    if (!para) continue;
    if (para.startsWith(FORMULA_PREFIX)) {
      out.formula = para.slice(FORMULA_PREFIX.length);
    } else if (para.startsWith(SYNONYMS_PREFIX)) {
      out.synonyms = unsentence(para.slice(SYNONYMS_PREFIX.length));
    } else if (para.startsWith(RELATED_PREFIX)) {
      out.related = unsentence(para.slice(RELATED_PREFIX.length));
    } else if (para.startsWith(DEFINES_PREFIX)) {
      const defs: GlossaryDefines[] = [];
      for (const item of unsentence(para.slice(DEFINES_PREFIX.length))) {
        const m = /^(.+) \((entity|field|metric)\)$/.exec(item);
        if (m) defs.push({kind: m[2] as GlossaryDefines['kind'], ref: m[1]});
      }
      if (defs.length) out.defines = defs;
    } else if (para.startsWith(SOURCE_PREFIX)) {
      out.source = para.slice(SOURCE_PREFIX.length);
    } else {
      prose.push(para);
    }
  }
  if (prose.length) out.definition = prose.join('\n\n');
  return out;
}

// ---------------------------------------------------------------------------
// Request plan.
// ---------------------------------------------------------------------------

/** Where the glossary and the linked entries live. */
export interface GlossaryTarget {
  // The project (id) and number that own the glossary.
  project: string;
  projectNumber: string;
  // Glossary location; Knowledge Catalog glossaries are usually `global`.
  location: string;
  // The kcmd entry group the semantic model is published in (catalog.yaml
  // source). When set, definition links also go to the semantic entity /
  // metric entries kcmd publishes there.
  semantic?: {project: string; projectNumber?: string; location: string;
              entryGroup: string};
  // BigQuery dataset location (any case) keyed `project.dataset`; a field or
  // entity whose dataset location is unknown gets no BigQuery leg.
  datasetLocations?: Map<string, string>;
  // Project number keyed by project id, for BigQuery data projects.
  projectNumbers?: Map<string, string>;
}

/** One REST call of the plan (paths are relative to `v1/`). */
export interface GlossaryRequest {
  kind: 'glossary'|'category'|'term'|'link';
  // The created resource's id and full name.
  id: string;
  name: string;
  method: 'POST';
  // The collection to POST to, e.g. `projects/p/locations/global/glossaries`.
  path: string;
  query: Record<string, string>;
  body: Record<string, any>;
  // glossaries.create returns a long-running Operation.
  lro?: boolean;
  // On 409 ALREADY_EXISTS: PATCH `name` with this update mask (resources
  // kcmd owns), or nothing ('exists': entry links are immutable).
  onConflict: {updateMask: string}|'exists';
  // A human line for dry-run output and logs.
  label: string;
  // K5: what to send instead when this request is refused. A definition link
  // on a kcmd semantic entry falls back to the column of the node view the
  // entity is read through (in `@bigquery`), so the term still lands on the
  // modelled concept rather than only on the raw source table.
  fallback?: GlossaryRequest;
}

export interface GlossaryPlan {
  glossaryName: string;
  requests: GlossaryRequest[];
  // Links not planned, with the reason (no table, unknown location, ...).
  notes: string[];
  // Full names of the categories / terms the spec declares (prune keeps them).
  categoryNames: Set<string>;
  termNames: Set<string>;
}

/** The term's Dataplex entry name (in the `@dataplex` system entry group). */
export function termEntryName(
    projectNumber: string, location: string, glossary: string,
    term: string): string {
  const res =
      `projects/${projectNumber}/locations/${location}/glossaries/${glossary}`;
  return `projects/${projectNumber}/locations/${location}/entryGroups/` +
      `@dataplex/entries/${res}/terms/${term}`;
}

// `p.d.t` (optionally backticked as a whole or per part) -> its parts.
export function bigQueryTableParts(dataSource: string):
    {project: string; dataset: string; table: string}|undefined {
  if (!dataSource || dataSource.startsWith('unbound:')) return undefined;
  const parts = dataSource.replace(/`/g, '').split('.');
  if (parts.length !== 3 || parts.some(p => !p)) return undefined;
  return {project: parts[0], dataset: parts[1], table: parts[2]};
}

// A field's physical column when it is a plain column reference; undefined
// for a computed field (no column to point a `Schema.<column>` path at).
function columnOf(entity: string, binding: string|undefined): string|undefined {
  if (binding === undefined) return undefined;
  const bare = stripQualifier(binding.trim(), entity).replace(/^`|`$/g, '');
  return isSimpleIdentifier(bare) ? bare : undefined;
}

/**
 * The ordered, idempotent request plan publishing `model.glossary`:
 *   1. the glossary (LRO);
 *   2. categories, parents first;
 *   3. terms;
 *   4. `related` links between terms, in the glossary project's `@dataplex`
 *      entry group, both references UNSPECIFIED;
 *   5. `definition` links from each defined element's BigQuery table entry
 *      (in `@bigquery`, the dataset location; column path `Schema.<column>`)
 *      to the term, SOURCE -> TARGET;
 *   6. the same from the semantic entity / metric entries kcmd publishes
 *      (when `target.semantic` is set).
 * Pure: the caller resolves project numbers and dataset locations.
 */
export function planGlossary(
    model: SemanticModel, target: GlossaryTarget): GlossaryPlan {
  const g: Glossary = model.glossary ?? {categories: [], terms: []};
  const gid = glossaryId(model);
  const {project, projectNumber, location} = target;
  const parent = `projects/${project}/locations/${location}`;
  const glossaryName = `${parent}/glossaries/${gid}`;
  const labels = {
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [MODEL_LABEL]: labelValue(model.name),
  };
  const requests: GlossaryRequest[] = [];
  const notes: string[] = [];

  requests.push({
    kind: 'glossary',
    id: gid,
    name: glossaryName,
    method: 'POST',
    path: `${parent}/glossaries`,
    query: {glossaryId: gid},
    body: compact({
      displayName: g.displayName ?? humanize(gid),
      description: g.description,
      labels,
    }),
    lro: true,
    onConflict: {updateMask: 'displayName,description,labels'},
    label: `glossary ${gid}`,
  });

  // Categories, parents first (a cycle is a checkGlossary error; anything
  // left unordered is appended so the API reports it).
  const byId = new Map(g.categories.map(c => [c.id, c]));
  const ordered: GlossaryCategory[] = [];
  const placed = new Set<string>();
  const place = (c: GlossaryCategory, stack: Set<string>) => {
    if (placed.has(c.id) || stack.has(c.id)) return;
    stack.add(c.id);
    const p = c.parent !== undefined ? byId.get(c.parent) : undefined;
    if (p) place(p, stack);
    placed.add(c.id);
    ordered.push(c);
  };
  for (const c of g.categories) place(c, new Set());
  const categoryName = (id: string) => `${glossaryName}/categories/${id}`;
  const categoryNames = new Set<string>();
  for (const c of ordered) {
    const name = categoryName(c.id);
    categoryNames.add(name);
    requests.push({
      kind: 'category',
      id: c.id,
      name,
      method: 'POST',
      path: `${glossaryName}/categories`,
      query: {categoryId: c.id},
      body: compact({
        displayName: categoryDisplayName(c),
        description: c.description,
        labels,
        parent: c.parent !== undefined && byId.has(c.parent) ?
            categoryName(c.parent) :
            glossaryName,
      }),
      onConflict: {updateMask: 'displayName,description,labels,parent'},
      label: `category ${c.id}`,
    });
  }

  const termNames = new Set<string>();
  for (const t of g.terms) {
    const name = `${glossaryName}/terms/${t.id}`;
    termNames.add(name);
    requests.push({
      kind: 'term',
      id: t.id,
      name,
      method: 'POST',
      path: `${glossaryName}/terms`,
      query: {termId: t.id},
      body: compact({
        displayName: termDisplayName(t),
        description: termDescription(t) || undefined,
        labels,
        parent: t.category !== undefined && byId.has(t.category) ?
            categoryName(t.category) :
            glossaryName,
      }),
      onConflict: {updateMask: 'displayName,description,labels,parent'},
      label: `term ${t.id}`,
    });
  }

  const termEntry = (id: string) =>
      termEntryName(projectNumber, location, gid, id);
  const seenLinks = new Set<string>();
  const linkRequest = (
      group: string, id: string, type: keyof typeof LINK_TYPES,
      refs: Array<{name: string; path?: string; type: string}>,
      label: string): GlossaryRequest => ({
    kind: 'link',
    id,
    name: `${group}/entryLinks/${id}`,
    method: 'POST',
    path: `${group}/entryLinks`,
    query: {entryLinkId: id},
    body: {
      entryLinkType: LINK_TYPES[type],
      entryReferences: refs.map(r => compact(r)),
    },
    onConflict: 'exists',
    label,
  });
  const pushLink = (
      group: string, id: string, type: keyof typeof LINK_TYPES,
      refs: Array<{name: string; path?: string; type: string}>, label: string,
      fallback?: GlossaryRequest) => {
    const request = linkRequest(group, id, type, refs, label);
    if (seenLinks.has(request.name)) return;
    seenLinks.add(request.name);
    requests.push(fallback ? {...request, fallback} : request);
  };

  // 4. related (term <-> term), one link per unordered pair. The guide
  // creates them in the first term's project's @dataplex entry group.
  const termIds = new Set(g.terms.map(t => t.id));
  const dataplexGroup = `${parent}/entryGroups/@dataplex`;
  for (const t of g.terms) {
    for (const r of t.related ?? []) {
      if (r === t.id || !termIds.has(r)) continue;
      const [a, b] = [t.id, r].sort();
      pushLink(
          dataplexGroup, linkId('rel', `${gid}-${a}`, `${gid}/${a}/${b}`),
          'related',
          [
            {name: termEntry(a), type: 'UNSPECIFIED'},
            {name: termEntry(b), type: 'UNSPECIFIED'},
          ],
          `related ${a} <-> ${b}`);
    }
  }

  // 5 + 6. definition (element -> term).
  const resolve = definesResolver(model);
  const entities = new Map((model.entities ?? []).map(e => [e.name, e]));
  let fieldsOf: (entity: string) => Map<string, any>;
  try {
    const concepts = declaredConceptFields(model);
    fieldsOf = n => concepts.get(n)?.fields ?? new Map();
  } catch {
    fieldsOf = n =>
        new Map((entities.get(n)?.fields ?? []).map(f => [f.name, f]));
  }
  const sem = target.semantic;
  const semNumber = sem ? (sem.projectNumber ?? sem.project) : '';
  const semGroup = sem ?
      `projects/${semNumber}/locations/${sem.location}/entryGroups/${
          sem.entryGroup}` :
      '';
  const modelSlug = entrySlug(model.name);

  // K5: the node view each entity is read through (node_views.ts), and the
  // `@bigquery` definition link a refused semantic-entry link falls back to.
  // A field maps to its snake_case view column; an entity (or a metric, via
  // its attach entity) links the view itself. No node view (mode: direct,
  // abstract, unbound) or an unknown dataset location: no fallback -- the raw
  // table leg above already covers a directly bound entity.
  const physical = sem ? physicalBindings(model) : new Map();
  const nodeViewFallback =
      (entity: string, field: string|undefined,
       termRef: {name: string; type: string},
       termId: string): GlossaryRequest|undefined => {
        const view = bigQueryTableParts(physical.get(entity)?.nodeView ?? '');
        if (!view) return undefined;
        const dsLoc = target.datasetLocations
                          ?.get(`${view.project}.${view.dataset}`)
                          ?.toLowerCase();
        const dataNumber = target.projectNumbers?.get(view.project);
        if (!dsLoc || !dataNumber) return undefined;
        const group =
            `projects/${dataNumber}/locations/${dsLoc}/entryGroups/@bigquery`;
        const entry = `${group}/entries/bigquery.googleapis.com/projects/${
            view.project}/datasets/${view.dataset}/tables/${view.table}`;
        const column = field !== undefined ? snakeCase(field) : undefined;
        const path = column ? `Schema.${column}` : undefined;
        return linkRequest(
            group,
            linkId('def', termId, `${entry}#${path ?? ''}->${termRef.name}`),
            'definition', [{name: entry, path, type: 'SOURCE'}, termRef],
            `definition ${view.project}.${view.dataset}.${view.table}${
                column ? `.${column}` : ''} -> ${termId} (node view fallback)`);
      };

  for (const t of g.terms) {
    for (const d of t.defines ?? []) {
      const hit = resolve(d);
      const what = `term '${t.id}' defines ${d.kind} '${d.ref}'`;
      if (hit.error) {
        notes.push(`${what}: skipped, ${hit.error}`);
        continue;
      }
      const termRef = {name: termEntry(t.id), type: 'TARGET'};

      // BigQuery table leg (entity / field only).
      if (d.kind !== 'metric' && hit.entity) {
        const e = entities.get(hit.entity)!;
        const tbl = bigQueryTableParts(e.dataSource);
        let column: string|undefined;
        let skip: string|undefined;
        if (e.abstract) {
          skip = 'the entity is abstract (no table)';
        } else if (e.definition) {
          skip = 'the entity is defined (a filter, no table of its own)';
        } else if (!tbl) {
          skip = `the entity is not bound to a BigQuery table ` +
              `('${e.dataSource}')`;
        } else if (hit.field) {
          const f = fieldsOf(e.name).get(hit.field);
          column = f ? columnOf(e.name, fieldBinding(f)) : undefined;
          if (!column) skip = 'the field is computed or unbound (no column)';
        }
        const dsLoc = tbl ?
            target.datasetLocations?.get(`${tbl.project}.${tbl.dataset}`)
                ?.toLowerCase() :
            undefined;
        const dataNumber = tbl ? target.projectNumbers?.get(tbl.project) :
                                 undefined;
        if (!skip && !dsLoc) {
          skip = `the location of dataset ${tbl!.project}.${tbl!.dataset} ` +
              `is unknown`;
        }
        if (!skip && !dataNumber) {
          skip = `the project number of ${tbl!.project} is unknown`;
        }
        if (skip) {
          notes.push(`${what}: BigQuery table link skipped, ${skip}`);
        } else {
          const group = `projects/${dataNumber}/locations/${
              dsLoc}/entryGroups/@bigquery`;
          const entry = `${group}/entries/bigquery.googleapis.com/projects/${
              tbl!.project}/datasets/${tbl!.dataset}/tables/${tbl!.table}`;
          const path = column ? `Schema.${column}` : undefined;
          pushLink(
              group,
              linkId('def', t.id, `${entry}#${path ?? ''}->${termRef.name}`),
              'definition',
              [{name: entry, path, type: 'SOURCE'}, termRef],
              `definition ${tbl!.project}.${tbl!.dataset}.${tbl!.table}${
                  column ? `.${column}` : ''} -> ${t.id}`);
        }
      }

      // Semantic entry leg. If the API refuses a definition link on the kcmd
      // entry, the publisher sends the fallback: the same term on the column
      // of the node view the entity is read through (K5).
      if (sem) {
        const entryId = d.kind === 'metric' ?
            `${modelSlug}.metrics.${entrySlug(d.ref)}` :
            `${modelSlug}.entities.${entrySlug(hit.entity!)}`;
        const entry = `${semGroup}/entries/${entryId}`;
        const path = hit.field ? `Schema.${hit.field}` : undefined;
        const viewEntity = d.kind === 'metric' ?
            (model.metrics ?? []).find(m => m.name === d.ref)?.entity :
            hit.entity;
        const fallback = viewEntity !== undefined ?
            nodeViewFallback(viewEntity, hit.field, termRef, t.id) :
            undefined;
        pushLink(
            semGroup,
            linkId('def', t.id, `${entry}#${path ?? ''}->${termRef.name}`),
            'definition', [{name: entry, path, type: 'SOURCE'}, termRef],
            `definition ${entryId}${path ? ` ${path}` : ''} -> ${t.id}`,
            fallback);
      }
    }
  }
  return {glossaryName, requests, notes, categoryNames, termNames};
}

function compact<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Spec serialization (IR -> snake_case `glossary:` block).
// ---------------------------------------------------------------------------

/** The `glossary:` block as written in a model document (loader inverse). */
export function glossaryDoc(g: Glossary): Record<string, any> {
  const list = <T>(xs: T[]|undefined) => xs?.length ? xs : undefined;
  return compact({
    id: g.id,
    display_name: g.displayName,
    description: g.description,
    categories: list(g.categories.map(c => compact({
      id: c.id,
      display_name: c.displayName,
      description: c.description,
      parent: c.parent,
    }))),
    terms: list(g.terms.map(t => compact({
      id: t.id,
      display_name: t.displayName,
      definition: t.definition,
      category: t.category,
      synonyms: list(t.synonyms),
      related: list(t.related),
      formula: t.formula,
      defines: list(t.defines?.map(d => ({[d.kind]: d.ref}))),
      source: t.source,
    }))),
  });
}

// ---------------------------------------------------------------------------
// Pull: Dataplex resources -> spec.
// ---------------------------------------------------------------------------

/** The subset of the Dataplex Glossary / Category / Term resources read. */
export interface DataplexGlossaryResource {
  name: string;
  displayName?: string;
  description?: string;
  labels?: Record<string, string>;
  parent?: string;
}

/**
 * Rebuilds a `glossary` spec from the published resources (the reverse of
 * planGlossary + termDescription). `related` and `defines` come back from
 * the description trailers, so no entry-link lookup is needed.
 */
export function glossaryFromDataplex(
    glossary: DataplexGlossaryResource,
    categories: DataplexGlossaryResource[],
    terms: DataplexGlossaryResource[]): Glossary {
  const last = (name: string) => name.slice(name.lastIndexOf('/') + 1);
  const categoryOf = (parent?: string) =>
      parent && parent.includes('/categories/') ? last(parent) : undefined;
  const out: Glossary = {id: last(glossary.name), categories: [], terms: []};
  if (glossary.displayName) out.displayName = glossary.displayName;
  if (glossary.description) out.description = glossary.description;
  for (const c of [...categories].sort((a, b) => a.name.localeCompare(b.name))) {
    const cat: GlossaryCategory = {id: last(c.name)};
    if (c.displayName && c.displayName !== humanize(cat.id)) {
      cat.displayName = c.displayName;
    }
    if (c.description) cat.description = c.description;
    const p = categoryOf(c.parent);
    if (p) cat.parent = p;
    out.categories.push(cat);
  }
  for (const t of [...terms].sort((a, b) => a.name.localeCompare(b.name))) {
    const term: GlossaryTerm = {id: last(t.name)};
    if (t.displayName && t.displayName !== humanize(term.id)) {
      term.displayName = t.displayName;
    }
    const c = categoryOf(t.parent);
    if (c) term.category = c;
    Object.assign(term, splitTermDescription(t.description ?? ''));
    out.terms.push(term);
  }
  return out;
}
