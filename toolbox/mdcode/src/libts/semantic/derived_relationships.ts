// Derived relationships (K2, proposed): relationships that are the
// composition of others (see ir.Relationship.via) -- OWL's
// owl:propertyChainAxiom:
//
//   relationships:
//     - name: belongsTo
//       from: Customer
//       to: Club
//       via: [^memberOf, inClub]   # ^ = walked backwards (SPARQL ^p)
//       filter: Membership.status = 'active'   # optional
//
// A derived relationship binds no join columns: its pairs are whatever the
// chain reaches. So:
//
//   - BigQuery: kcmd generates an `edge_<relationship>` view that follows the
//     chain and materializes the distinct (source key, destination key) pairs,
//
//       SELECT DISTINCT n0.customer_id AS source_customer_id,
//                       n2.club_id AS target_club_id
//       FROM customers AS n0
//       JOIN memberships AS n1 ON n1.customer_id = n0.customer_id
//       JOIN clubs AS n2 ON n1.club_id = n2.club_id
//
//     and backs the edge table with it (an association edge, see
//     ir.Association), deployed before the graph like a vocabulary view.
//     A hop into a vocabulary matches the code case-insensitively, as every
//     vocabulary join does (see vocabulary.ts).
//   - Knowledge Catalog: the schema-join pairs the two endpoints' keys and its
//     description states the derivation as fixed, parseable trailing
//     paragraphs (`Derived via: ^memberOf, inClub.`).
//
// Everything K2 owns lives here so the feature is easy to find, rename or drop.

import {Entity, Relationship, RelationshipStep, SemanticModel} from './ir';
import {aliased, edgeViewName, GeneratedView, oneLine, physicalColumnOf, sqlString, viewRef, ViewTarget} from './generated_views';
import {escapeRegExp, mapOutsideStringLiterals} from './sql_expr_utils';
import {isVocabulary, vocabularyJoinCondition} from './vocabulary';

/** A chain step as written in the spec: `name`, or `^name` walked backwards. */
export function formatStep(step: RelationshipStep): string {
  return step.inverse ? `^${step.relationship}` : step.relationship;
}

/** Parses a spec chain step (see formatStep). */
export function parseStep(text: string): RelationshipStep {
  const t = text.trim();
  return t.startsWith('^') ? {relationship: t.slice(1).trim(), inverse: true} :
                             {relationship: t};
}

/** A chain as one line: `^memberOf, inClub`. */
export function formatChain(steps: readonly RelationshipStep[]): string {
  return steps.map(formatStep).join(', ');
}

/** One concrete hop of a resolved chain. */
export interface ChainHop {
  relationship: Relationship;
  // Walked destination -> source.
  inverse: boolean;
  // The entities the hop leaves from and arrives at, in walking order.
  from: string;
  to: string;
}

export type ChainResolution = {hops: ChainHop[]; error?: undefined}|
    {hops?: undefined; error: string};

const flip = (h: ChainHop): ChainHop =>
    ({...h, inverse: !h.inverse, from: h.to, to: h.from});

/**
 * Resolves a derived relationship's chain to concrete hops. A step may name a
 * relationship or a relationship's declared `inverse` (read as that
 * relationship walked backwards); a step that is itself derived is expanded in
 * place (reversed when walked backwards). Unknown, abstract and cyclic steps
 * are reported as `error`.
 */
export function resolveChain(
    rel: Relationship, relationships: readonly Relationship[]):
    ChainResolution {
  const byName = new Map(relationships.map(r => [r.name, r]));
  const byInverse = new Map(
      relationships.filter(r => r.inverse).map(r => [r.inverse!, r]));
  const expand =
      (steps: readonly RelationshipStep[], visiting: Set<string>):
          ChainHop[] => {
            const out: ChainHop[] = [];
            for (const step of steps) {
              let r = byName.get(step.relationship);
              let inverse = !!step.inverse;
              if (!r) {
                r = byInverse.get(step.relationship);
                inverse = !inverse;
              }
              if (!r) {
                throw new Error(`step '${
                    formatStep(step)}' names no relationship in the model`);
              }
              if (r.abstract) {
                throw new Error(`step '${formatStep(step)}' names abstract ` +
                                `relationship '${r.name}', which has no edges`);
              }
              if (!r.via?.length) {
                out.push({
                  relationship: r,
                  inverse,
                  from: inverse ? r.destination.entity : r.source.entity,
                  to: inverse ? r.source.entity : r.destination.entity,
                });
                continue;
              }
              if (visiting.has(r.name)) {
                throw new Error(`the chain is cyclic through '${r.name}'`);
              }
              visiting.add(r.name);
              const inner = expand(r.via, visiting);
              visiting.delete(r.name);
              out.push(...(inverse ? inner.reverse().map(flip) : inner));
            }
            return out;
          };
  try {
    return {hops: expand(rel.via ?? [], new Set([rel.name]))};
  } catch (err: any) {
    return {error: err.message || String(err)};
  }
}

/** The entity path a chain walks: `Customer -> Membership -> Club`. */
export function chainPath(hops: readonly ChainHop[]): string {
  return hops.length ? [hops[0].from, ...hops.map(h => h.to)].join(' -> ') :
                       '';
}

// The entity itself plus every transitive `extends` ancestor.
function lineageOf(entities: readonly Entity[]): (name: string) => Set<string> {
  const byName = new Map(entities.map(e => [e.name, e]));
  return (name: string) => {
    const out = new Set<string>();
    const queue = [name];
    while (queue.length) {
      const n = queue.shift()!;
      if (out.has(n)) continue;
      out.add(n);
      queue.push(...(byName.get(n)?.extends ?? []));
    }
    return out;
  };
}

/**
 * Static checks on derived relationships (run by the loader): every step
 * resolves, consecutive steps meet at the same entity (or a subtype /
 * supertype of it), and the relationship's own ends match the chain's. A
 * `filter` without `via` is reported as ignored. Warnings only: a graph leg
 * omits a chain it cannot follow, with its own warning.
 */
export function checkDerivedRelationships(
    entities: readonly Entity[], relationships: readonly Relationship[],
    warnings: string[]): void {
  const lineage = lineageOf(entities);
  const related = (a: string, b: string) =>
      lineage(a).has(b) || lineage(b).has(a);
  for (const rel of relationships) {
    const ctx = `relationship '${rel.name}'`;
    if (rel.filter !== undefined && !rel.via?.length) {
      warnings.push(`${ctx}: 'filter' is only read on a derived relationship ` +
                    `(one with 'via'); ignored`);
    }
    if (!rel.via?.length) continue;
    const res = resolveChain(rel, relationships);
    if (res.error !== undefined) {
      warnings.push(`${ctx}: via [${formatChain(rel.via)}]: ${res.error}`);
      continue;
    }
    const hops = res.hops;
    for (let i = 0; i + 1 < hops.length; i++) {
      if (!related(hops[i].to, hops[i + 1].from)) {
        warnings.push(`${ctx}: via [${formatChain(rel.via)}]: step ${
            i + 1} arrives at '${hops[i].to}' but step ${i + 2} leaves from '${
            hops[i + 1].from}'; the chain does not connect`);
      }
    }
    if (!related(rel.source.entity, hops[0].from)) {
      warnings.push(`${ctx}: from '${rel.source.entity}' but its chain ` +
                    `starts at '${hops[0].from}'`);
    }
    if (!related(rel.destination.entity, hops[hops.length - 1].to)) {
      warnings.push(`${ctx}: to '${rel.destination.entity}' but its chain ` +
                    `ends at '${hops[hops.length - 1].to}'`);
    }
  }
}

// --------------------------------------------------------------------------
// BigQuery lowering.
// --------------------------------------------------------------------------

/**
 * Lowers each derived relationship for a BigQuery graph: an `edge_<name>`
 * view materializes its pairs over the chain, and the relationship is re-backed
 * by that view as an association edge. Run after vocabulary lowering (entities
 * then carry their generated sources); a hop whose relationship was re-backed
 * for a vocabulary still joins on its foreign key. A chain that cannot be
 * followed -- an unresolved step, a junction (association) hop, an endpoint
 * with no table -- omits the relationship with a warning. Returns the
 * rewritten model (the input is not mutated) and the views, in chain order.
 */
export function lowerDerivedRelationships(
    model: SemanticModel, target: ViewTarget,
    warnings: string[]): {model: SemanticModel; views: GeneratedView[]} {
  const relationships = model.relationships ?? [];
  if (!relationships.some(r => r.via?.length && !r.abstract)) {
    return {model, views: []};
  }
  const entities = model.entities ?? [];
  const byName = new Map(entities.map(e => [e.name, e]));
  const views: GeneratedView[] = [];
  const out: Relationship[] = [];
  for (const rel of relationships) {
    if (!rel.via?.length || rel.abstract) {
      out.push(rel);
      continue;
    }
    const built = derivedEdgeView(rel, relationships, byName, target);
    if ('error' in built) {
      warnings.push(`relationship '${rel.name}': derived via [${
          formatChain(rel.via)}] cannot be materialized (${
          built.error}); edge omitted`);
      continue;
    }
    warnings.push(...built.warnings);
    views.push(built.view);
    out.push({
      ...rel,
      association: {
        dataSource: built.view.ref,
        keys: [...built.sourceColumns, ...built.destinationColumns],
        sourceColumns: built.sourceColumns,
        destinationColumns: built.destinationColumns,
      },
    });
  }
  return {model: {...model, relationships: out}, views};
}

// A concrete entity a chain node can read: bound to a table, keyed.
function tableEntity(
    byName: Map<string, Entity>, ...names: string[]): Entity|undefined {
  for (const n of names) {
    const e = byName.get(n);
    if (e && !e.abstract && !e.definition && e.dataSource?.trim() &&
        !e.dataSource.startsWith('unbound:')) {
      return e;
    }
  }
  return undefined;
}

function outputName(column: string): string {
  const cleaned =
      column.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'key';
}

type DerivedView = {
  view: GeneratedView; sourceColumns: string[]; destinationColumns: string[];
  warnings: string[];
};

// The first derived relationship with a `filter` that the chain expands
// through, if any. An expansion follows the inner chain but does not carry
// its filter, so such a chain is not materialized (it would over-reach).
function filteredDerivedStep(
    rel: Relationship, relationships: readonly Relationship[]): string|
    undefined {
  const byName = new Map(relationships.map(r => [r.name, r]));
  const byInverse = new Map(
      relationships.filter(r => r.inverse).map(r => [r.inverse!, r]));
  const seen = new Set<string>([rel.name]);
  const walk = (steps: readonly RelationshipStep[]): string|undefined => {
    for (const s of steps) {
      const r = byName.get(s.relationship) ?? byInverse.get(s.relationship);
      if (!r?.via?.length || seen.has(r.name)) continue;
      seen.add(r.name);
      if (r.filter?.trim()) return r.name;
      const inner = walk(r.via);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  return walk(rel.via ?? []);
}

function derivedEdgeView(
    rel: Relationship, relationships: readonly Relationship[],
    byName: Map<string, Entity>, target: ViewTarget): DerivedView|
    {error: string} {
  const res = resolveChain(rel, relationships);
  if (res.error !== undefined) return {error: res.error};
  const filtered = filteredDerivedStep(rel, relationships);
  if (filtered !== undefined) {
    return {
      error: `step '${filtered}' is derived with a filter, which a chain ` +
          `through it does not apply yet`,
    };
  }
  const hops = res.hops;
  const warnings: string[] = [];

  // One table per chain node: the relationship's own ends at the two
  // extremes (a narrower `from`/`to` restricts the pairs), the hop endpoints
  // in between.
  const nodes: Entity[] = [];
  for (let i = 0; i <= hops.length; i++) {
    const names = i === 0 ? [rel.source.entity, hops[0].from] :
        i === hops.length ? [rel.destination.entity, hops[i - 1].to] :
                            [hops[i - 1].to, hops[i].from];
    const e = tableEntity(byName, ...names);
    if (!e) return {error: `'${names[0]}' has no table to read`};
    nodes.push(e);
  }

  const joins: string[] = [];
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const r = hop.relationship;
    if (!r.source.columns.length || !r.destination.columns.length) {
      return {
        error: `step '${r.name}' has no foreign-key columns (a junction or ` +
            `logical edge cannot be followed yet)`,
      };
    }
    // The foreign key lives on the relationship's source; walking it
    // backwards swaps which chain node holds it.
    const [fkAlias, fkEntity, keyAlias, keyEntity] = hop.inverse ?
        [`n${i + 1}`, nodes[i + 1], `n${i}`, nodes[i]] :
        [`n${i}`, nodes[i], `n${i + 1}`, nodes[i + 1]];
    const dest = byName.get(r.destination.entity);
    const intoVocabulary = !!dest && isVocabulary(dest);
    const conditions = r.source.columns.map((fk, j) => {
      const keyField = r.destination.columns[j];
      if (intoVocabulary) {
        return vocabularyJoinCondition(
            fkEntity, fkAlias, fk, keyEntity, keyAlias, keyField);
      }
      const left = aliased(fkAlias, physicalColumnOf(fkEntity, fk));
      const right = aliased(keyAlias, physicalColumnOf(keyEntity, keyField));
      return `${left} = ${right}`;
    });
    joins.push(`JOIN \`${nodes[i + 1].dataSource.replace(/`/g, '')}\` AS n${
        i + 1} ON ${conditions.join(' AND ')}`);
  }

  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const lastAlias = `n${nodes.length - 1}`;
  const sourceKeys = first.keys.map(k => physicalColumnOf(first, k));
  const destKeys = last.keys.map(k => physicalColumnOf(last, k));
  if (!sourceKeys.length || !destKeys.length) {
    return {error: `'${(!sourceKeys.length ? first : last).name}' has no key`};
  }
  const sourceColumns = sourceKeys.map(c => `source_${outputName(c)}`);
  const destinationColumns = destKeys.map(c => `target_${outputName(c)}`);
  const select = [
    ...sourceKeys.map((c, i) => `${aliased('n0', c)} AS ${sourceColumns[i]}`),
    ...destKeys.map(
        (c, i) => `${aliased(lastAlias, c)} AS ${destinationColumns[i]}`),
  ];

  const name = edgeViewName(rel.name);
  const ref = viewRef(name, target);
  const filter = rel.filter?.trim() ?
      rewriteFilter(rel.filter, nodes, hops, rel.name, warnings) :
      undefined;
  const description = `Derived edge ${rel.name} (${rel.source.entity} -> ${
      rel.destination.entity}): the distinct pairs reached via ${
      formatChain(rel.via ?? [])} (${chainPath(hops)})${
      filter ? ` where ${oneLine(rel.filter!)}` : ''}. Generated by kcmd; do ` +
      `not edit.`;
  const ddl = [
    `CREATE OR REPLACE VIEW \`${ref}\``,
    `OPTIONS (description = ${sqlString(description)}) AS`,
    `SELECT DISTINCT ${select.join(', ')}`,
    `FROM \`${first.dataSource.replace(/`/g, '')}\` AS n0`,
    ...joins,
    ...(filter ? [`WHERE ${filter}`] : []),
  ].join('\n');
  return {
    view: {name, ref, kind: 'edge', ddl},
    sourceColumns,
    destinationColumns,
    warnings,
  };
}

// Rewrites a filter's `Entity.field` references onto the chain's table
// aliases (`n<i>.<column>`). An entity is found by the table a node reads or
// by the name a hop declares; one that occurs at several nodes resolves to the
// first, with a warning.
function rewriteFilter(
    filter: string, nodes: readonly Entity[], hops: readonly ChainHop[],
    relName: string, warnings: string[]): string {
  const aliasesOf = new Map<string, number[]>();
  const note = (name: string, i: number) => {
    const list = aliasesOf.get(name) ?? [];
    if (!list.includes(i)) list.push(i);
    aliasesOf.set(name, list);
  };
  nodes.forEach((n, i) => note(n.name, i));
  hops.forEach((h, i) => {
    note(h.from, i);
    note(h.to, i + 1);
  });
  let out = filter;
  for (const [name, at] of aliasesOf) {
    const re = new RegExp(
        `(?<![\\w\`])\`?${escapeRegExp(name)}\`?\\.\`?([A-Za-z_][A-Za-z0-9_]*)\`?`,
        'g');
    let used = false;
    out = mapOutsideStringLiterals(out, seg => seg.replace(re, (_m, field) => {
      used = true;
      return aliased(`n${at[0]}`, physicalColumnOf(nodes[at[0]], field));
    }));
    if (used && at.length > 1) {
      warnings.push(`relationship '${relName}': filter names '${
          name}', which occurs more than once in the chain; it reads the ` +
                    `first occurrence`);
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Knowledge Catalog trailer codec.
// --------------------------------------------------------------------------

export const DERIVED_VIA_PREFIX = 'Derived via: ';
export const DERIVED_FILTER_PREFIX = 'Derived filter: ';

/**
 * The paragraphs a derived relationship's schema-join description carries, in
 * publish order: `Derived via: ^a, b.` then, with a filter,
 * `Derived filter: <expression>` (verbatim, folded to one line, no period).
 */
export function derivedTrailers(rel: Pick<Relationship, 'via'|'filter'>):
    string[] {
  if (!rel.via?.length) return [];
  const out = [`${DERIVED_VIA_PREFIX}${formatChain(rel.via)}.`];
  if (rel.filter?.trim()) {
    out.push(`${DERIVED_FILTER_PREFIX}${oneLine(rel.filter)}`);
  }
  return out;
}

/**
 * Peels the derived paragraphs (see derivedTrailers) off the end of a pulled
 * schema-join description. Text without them is returned untouched.
 */
export function splitDerivedTrailers(text: string|undefined): {
  rest: string|undefined; via?: RelationshipStep[]; filter?: string
} {
  if (text === undefined) return {rest: undefined};
  let paragraphs = text.split('\n\n');
  let filter: string|undefined;
  const last = paragraphs[paragraphs.length - 1];
  if (last.startsWith(DERIVED_FILTER_PREFIX)) {
    filter = last.slice(DERIVED_FILTER_PREFIX.length).trim();
    paragraphs = paragraphs.slice(0, -1);
  }
  const viaLine = paragraphs[paragraphs.length - 1];
  if (viaLine === undefined || !viaLine.startsWith(DERIVED_VIA_PREFIX) ||
      !viaLine.endsWith('.')) {
    return {rest: text};
  }
  const via = viaLine.slice(DERIVED_VIA_PREFIX.length, -1)
                  .split(',')
                  .map(parseStep)
                  .filter(s => s.relationship);
  if (!via.length) return {rest: text};
  const rest = paragraphs.slice(0, -1).join('\n\n');
  return {
    rest: rest === '' ? undefined : rest,
    via,
    ...(filter ? {filter} : {}),
  };
}
