// Constraints -> BigQuery validation (`kcmd validate --target bigquery`).
//
// A model constraint is a JUDGED rule: its one body is a sentence an agent or
// an action guard settles (see ir.ts Constraint). The SHACL and OWL importers
// write every rule they generate from a closed vocabulary of SHACL / OWL terms,
// and they end the constraint's `description` with a provenance note that
// restates those terms verbatim:
//
//   (From SHACL: OpportunityShape, salesStage sh:in (0A 0B 1 ...).)
//   (From OWL: Opportunity SubClassOf hasBuyer exactly 1 ClientAccount.)
//
// That note -- together with the generated judgment, which quotes `sh:in`
// members exactly -- is a machine-readable form of the rule, so an imported
// constraint can ALSO be checked deterministically over the data the selected
// binding profile binds the model to. This module does that: one
// violation-count query (and one examples query) per constraint, plus the
// structural rules the model itself states (primary keys, unique keys, foreign
// keys). A constraint with no such note -- a hand-written judgment -- has no
// deterministic form and is reported as unsupported, never guessed at.
//
// The results are a REPORT about stored data. They are never used to filter
// anything: a query, a graph, a skill or an action guard reads the model, not
// these counts. Publishing writes them to Knowledge Catalog as an aspect on the
// entity entries, beside (not inside) the published rules.
//
// Layering: everything above `runBigQueryValidation` is pure (planning, SQL,
// manifest, aspect payloads) and unit-tested without a network; the runner and
// the publisher at the bottom are the only functions that call an API.

import {ApiResult} from '../gcp/api';
import {BigQueryClient, QueryResponse} from '../gcp/bigquery';
import * as context from '../gcp/context';
import {AspectType, CatalogClient, Entry} from '../gcp/dataplex';

import {lowerDefinedEntities, membershipPropertyName, resolveDefinedEntities} from './defined_entities';
import {Constraint, ConstraintSeverity, DataType, Entity, fieldBinding, Relationship, SemanticModel, ViolationEffect} from './ir';
import {resolveInheritance} from './resolve_inheritance';
import {stripQualifier} from './sql_expr_utils';
import {isSimpleIdentifier, quoteIfReserved} from './sql_identifiers';


// ---------------------------------------------------------------------------
// The rule kinds, as parsed from a constraint.
// ---------------------------------------------------------------------------

export interface RangeBound {
  term: 'minInclusive'|'minExclusive'|'maxInclusive'|'maxExclusive';
  value: string;
}

/**
 * A constraint's rule in structured form. `entity` is the class the rule is
 * about (its focus); for a relationship rule `inverse` says whether the edge
 * is read forward (the entity is the edge's source) or backwards (the entity
 * is its destination, an OWL restriction through an `inverse:` name).
 */
export type ConstraintSpec =
    |{kind: 'required'|'empty'; entity: string; field: string}
    |{kind: 'pattern'; entity: string; field: string; pattern: string; flags?: string}
    |{kind: 'in'; entity: string; field: string; values: string[]}
    |{kind: 'value'; entity: string; field: string; value: string}
    |{kind: 'range'; entity: string; field: string; bounds: RangeBound[]}
    |{kind: 'length'; entity: string; field: string; min?: number; max?: number}
    |{
      kind: 'lessThan'|'lessThanOrEquals'|'equals'|'disjoint';
      entity: string;
      field: string;
      other: string;
    }
    |{
      kind: 'cardinality';
      entity: string;
      relationship: string;
      inverse: boolean;
      min?: number;
      max?: number;
      qualifier?: string;
    }
    |{kind: 'class'; entity: string; relationship: string; inverse: boolean; target: string}
    |{kind: 'disjointClasses'; entity: string; classes: string[]};

/** Every check kind: the constraint kinds plus the model's structural ones. */
export type CheckKind = ConstraintSpec['kind']|'primaryKey'|'uniqueKey'|'references';

export type ParsedConstraint = {spec: ConstraintSpec; origin: 'SHACL'|'OWL'}|{unsupported: string};

const SHACL_PREFIX = '(From SHACL: ';
const OWL_PREFIX = '(From OWL: ';

// The provenance note's body (`<shape>, <path> <terms>` / `<axiom>`), or
// undefined when the description carries no note with this prefix.
function provenanceBody(description: string|undefined, prefix: string): string|
    undefined {
  if (!description) return undefined;
  const at = description.lastIndexOf(prefix);
  if (at < 0) return undefined;
  const rest = description.slice(at + prefix.length).trim();
  return rest.endsWith('.)') ? rest.slice(0, -2) : undefined;
}

// Constraint names are sanitized the same way both importers do (letters,
// digits, underscore), so a prefix match compares like with like.
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

// Lookups over the AUTHORED model: the importers resolved every rule against
// the entity and its supertypes as declared, so the parser does too.
class ModelIndex {
  readonly entities: Map<string, Entity>;
  readonly relationships: Relationship[];
  constructor(readonly model: SemanticModel) {
    this.entities = new Map((model.entities ?? []).map(e => [e.name, e]));
    this.relationships = model.relationships ?? [];
  }
  lineage(name: string): string[] {
    const out: string[] = [];
    const queue = [name];
    while (queue.length) {
      const n = queue.shift()!;
      if (out.includes(n)) continue;
      out.push(n);
      queue.push(...(this.entities.get(n)?.extends ?? []));
    }
    return out;
  }
  hasField(entity: string, field: string): boolean {
    return this.lineage(entity).some(
        n => this.entities.get(n)?.fields.some(f => f.name === field));
  }
  fieldType(entity: string, field: string): DataType|undefined {
    for (const n of this.lineage(entity)) {
      const f = this.entities.get(n)?.fields.find(x => x.name === field);
      if (f) return f.type;
    }
    return undefined;
  }
  forward(entity: string, name: string): Relationship|undefined {
    const rel = this.relationships.find(r => r.name === name);
    return rel && this.lineage(entity).includes(rel.source.entity) ? rel :
                                                                     undefined;
  }
  inverse(entity: string, name: string): Relationship|undefined {
    const rel = this.relationships.find(r => r.inverse === name);
    return rel && this.lineage(entity).includes(rel.destination.entity) ?
        rel :
        undefined;
  }
}

/**
 * Recovers the structured rule of one constraint from its provenance note, or
 * says why it has none. Exported for the tests.
 */
export function parseConstraintSpec(
    constraint: Constraint, model: SemanticModel): ParsedConstraint {
  const index = new ModelIndex(model);
  const shacl = provenanceBody(constraint.description, SHACL_PREFIX);
  if (shacl !== undefined) return parseShacl(constraint, shacl, index);
  const owl = provenanceBody(constraint.description, OWL_PREFIX);
  if (owl !== undefined) return parseOwl(owl, index);
  return {
    unsupported: 'a judged rule with no SHACL/OWL provenance note has no ' +
        'deterministic form to check',
  };
}

function parseShacl(
    constraint: Constraint, body: string, index: ModelIndex): ParsedConstraint {
  const comma = body.indexOf(', ');
  if (comma < 0) return {unsupported: `unreadable SHACL provenance '${body}'`};
  const rest = body.slice(comma + 2);
  const space = rest.indexOf(' ');
  if (space < 0) return {unsupported: `unreadable SHACL provenance '${body}'`};
  const path = rest.slice(0, space);
  const terms = rest.slice(space + 1).trim();

  // The importer names a rule `<Entity>_<path>_<rule>`; the entity is the
  // longest one whose name prefixes the constraint's that way.
  const candidates = [...index.entities.keys()]
                         .filter(e => constraint.name.startsWith(
                                     `${sanitize(e)}_${sanitize(path)}_`))
                         .sort((a, b) => b.length - a.length);
  const C = candidates[0];
  if (!C) {
    return {
      unsupported: `cannot tell which entity the SHACL rule on '${
          path}' targets from the constraint name`,
    };
  }
  const ok = (spec: ConstraintSpec): ParsedConstraint => ({spec, origin: 'SHACL'});

  const rel = index.forward(C, path);
  if (rel) {
    if (/sh:(qualified)?(Min|Max)Count\b|sh:(min|max)Count\b/.test(terms)) {
      const min = terms.match(/sh:(?:qualifiedMinCount|minCount) (\d+)/);
      const max = terms.match(/sh:(?:qualifiedMaxCount|maxCount) (\d+)/);
      const cls = /sh:qualified/.test(terms) ?
          terms.match(/sh:class (\S+)/)?.[1] :
          undefined;
      return ok({
        kind: 'cardinality',
        entity: C,
        relationship: rel.name,
        inverse: false,
        ...(min ? {min: Number(min[1])} : {}),
        ...(max ? {max: Number(max[1])} : {}),
        ...(cls && cls !== rel.destination.entity ? {qualifier: cls} : {}),
      });
    }
    const only = terms.match(/^sh:class (\S+)$/);
    if (only) {
      return ok({
        kind: 'class',
        entity: C,
        relationship: rel.name,
        inverse: false,
        target: only[1],
      });
    }
    return {unsupported: `SHACL terms '${terms}' on relationship '${path}'`};
  }
  if (!index.hasField(C, path)) {
    return {
      unsupported: `'${path}' is neither a relationship nor a field of '${C}'`,
    };
  }
  const field = path;
  if (terms === 'sh:minCount 1') return ok({kind: 'required', entity: C, field});
  if (terms === 'sh:maxCount 0') return ok({kind: 'empty', entity: C, field});
  if (terms.startsWith(`sh:pattern '`)) {
    const flagsAt = terms.lastIndexOf(` sh:flags '`);
    const patternPart = flagsAt >= 0 ? terms.slice(0, flagsAt) : terms;
    const pattern = patternPart.slice(`sh:pattern '`.length, -1);
    const flags =
        flagsAt >= 0 ? terms.slice(flagsAt + ` sh:flags '`.length, -1) : undefined;
    return ok({
      kind: 'pattern',
      entity: C,
      field,
      pattern,
      ...(flags ? {flags} : {}),
    });
  }
  if (terms.startsWith('sh:in (') && terms.endsWith(')')) {
    // The provenance joins members with spaces, which is ambiguous for a
    // member that contains one; the judgment quotes each member exactly.
    const values = quotedMembers(constraint.judgment);
    if (values && values.length > 1) {
      return ok({kind: 'in', entity: C, field, values});
    }
    // A single member is written alone between the parentheses: exact. Like
    // any sh:in it constrains only values that are present (SHACL has no value
    // node for a missing one), so it stays an `in`, not a required `value`.
    return ok({kind: 'in', entity: C, field, values: [terms.slice(7, -1)]});
  }
  const bounds = [...terms.matchAll(
                      /sh:(minInclusive|minExclusive|maxInclusive|maxExclusive) (\S+)/g)]
                     .map(m => ({term: m[1] as RangeBound['term'], value: m[2]}));
  if (bounds.length) return ok({kind: 'range', entity: C, field, bounds});
  const minLength = terms.match(/sh:minLength (\d+)/);
  const maxLength = terms.match(/sh:maxLength (\d+)/);
  if (minLength || maxLength) {
    return ok({
      kind: 'length',
      entity: C,
      field,
      ...(minLength ? {min: Number(minLength[1])} : {}),
      ...(maxLength ? {max: Number(maxLength[1])} : {}),
    });
  }
  const pair =
      terms.match(/^sh:(lessThan|lessThanOrEquals|equals|disjoint) (\S+)$/);
  if (pair) {
    return ok({
      kind: pair[1] as 'lessThan' | 'lessThanOrEquals' | 'equals' | 'disjoint',
      entity: C,
      field,
      other: pair[2],
    });
  }
  return {unsupported: `SHACL terms '${terms}' on field '${C}.${field}'`};
}

// The members of "... is one of 'a', 'b' or 'c'." in a generated judgment.
function quotedMembers(judgment: string|undefined): string[]|undefined {
  if (!judgment) return undefined;
  const at = judgment.indexOf('one of ');
  if (at < 0) return undefined;
  let s = judgment.slice(at + 'one of '.length);
  const out: string[] = [];
  const re = /^'([^']*)'(, | or )?/;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    out.push(m[1]);
    s = s.slice(m[0].length);
    if (!m[2]) break;
  }
  return out.length ? out : undefined;
}

function parseOwl(axiom: string, index: ModelIndex): ParsedConstraint {
  const ok = (spec: ConstraintSpec): ParsedConstraint => ({spec, origin: 'OWL'});
  const functional = axiom.match(/^(\S+) is a FunctionalProperty$/);
  if (functional) {
    const rel = index.relationships.find(r => r.name === functional[1]);
    if (!rel) return {unsupported: `unknown relationship '${functional[1]}'`};
    return ok({
      kind: 'cardinality',
      entity: rel.source.entity,
      relationship: rel.name,
      inverse: false,
      max: 1,
    });
  }
  const pair = axiom.match(/^(\S+) DisjointWith (\S+)$/);
  const set = axiom.match(/^DisjointClasses\((.*)\)$/);
  if (pair || set) {
    const classes = (pair ? [pair[1], pair[2]] : set![1].split(/\s+/))
                        .filter(c => index.entities.has(c));
    if (classes.length < 2) {
      return {unsupported: `disjointness '${axiom}' names fewer than two entities`};
    }
    return ok({kind: 'disjointClasses', entity: classes[0], classes});
  }
  const head = axiom.match(/^(\S+) (SubClassOf|EquivalentTo) (.*)$/);
  if (!head) return {unsupported: `OWL axiom '${axiom}'`};
  const C = head[1];
  let body = head[3];
  // `C EquivalentTo D and (p some X)`: the restriction is the last conjunct.
  const conj = body.lastIndexOf(' and (');
  if (conj >= 0 && body.endsWith(')')) body = body.slice(conj + 6, -1);
  const r = body.match(/^(\S+) (some|only|value|exactly|min|max)(?: (.+))?$/);
  if (!r) return {unsupported: `OWL axiom '${axiom}'`};
  const [, p, word, tail] = r;
  let n: number|undefined;
  let filler: string|undefined;
  if (word === 'exactly' || word === 'min' || word === 'max') {
    const m = (tail ?? '').match(/^(\d+)(?: (\S+))?$/);
    if (!m) return {unsupported: `OWL axiom '${axiom}'`};
    n = Number(m[1]);
    filler = m[2];
  } else if (word !== 'value') {
    filler = tail;
  }
  const bounds = word === 'some' ? {min: 1} :
      word === 'exactly'         ? {min: n, max: n} :
      word === 'min'             ? {min: n} :
      word === 'max'             ? {max: n} :
                                   {};

  const fwd = index.forward(C, p);
  const inv = fwd ? undefined : index.inverse(C, p);
  const rel = fwd ?? inv;
  if (rel) {
    const otherEnd = fwd ? rel.destination.entity : rel.source.entity;
    const qualifier = filler && filler !== otherEnd && filler !== 'Thing' ?
        filler :
        undefined;
    if (word === 'value') {
      return {
        unsupported: `'${p} value ...' names an individual, which no row ` +
            `of a table identifies`,
      };
    }
    if (word === 'only') {
      if (!qualifier) {
        return {unsupported: `'${axiom}' restates the edge's own endpoint`};
      }
      return ok({
        kind: 'class',
        entity: C,
        relationship: rel.name,
        inverse: !!inv,
        target: qualifier,
      });
    }
    return ok({
      kind: 'cardinality',
      entity: C,
      relationship: rel.name,
      inverse: !!inv,
      ...bounds,
      ...(qualifier ? {qualifier} : {}),
    });
  }
  if (index.hasField(C, p)) {
    if (word === 'value') {
      return ok({
        kind: 'value',
        entity: C,
        field: p,
        value: (tail ?? '').replace(/^'|'$/g, ''),
      });
    }
    if (word === 'some' || ((word === 'min' || word === 'exactly') && n === 1)) {
      return ok({kind: 'required', entity: C, field: p});
    }
    if ((word === 'max' || word === 'exactly') && n === 0) {
      return ok({kind: 'empty', entity: C, field: p});
    }
    return {unsupported: `OWL axiom '${axiom}' on field '${C}.${p}'`};
  }
  return {
    unsupported: `'${p}' is neither a relationship nor a field of '${C}'`,
  };
}


// ---------------------------------------------------------------------------
// Binding: which rows of which tables are instances of a class.
// ---------------------------------------------------------------------------

// The binding helpers below are shared with the data profiler
// (profile_bigquery.ts), so both read a class's rows the same way.
export class Unsupported extends Error {}

// One table that holds instances of a class, with the row filters (a defined
// entity's membership predicate) that select them.
export interface Branch {
  entity: Entity;
  filters: string[];
}

// Resolves classes to the physical rows the selected binding gives them. Uses
// the same passes as the BigQuery graph leg (generatePropertyGraph): defined
// entities lowered to a boolean membership property on their base, then
// inheritance resolved, so a field reads the same column here as it does as a
// graph property.
export class Binder {
  readonly tables: Map<string, Entity>;
  readonly loweredRelationships: Relationship[];
  private readonly defined: Map<string, {base: string}>;
  readonly warnings: string[] = [];

  constructor(model: SemanticModel) {
    const lowered = lowerDefinedEntities(model, []);
    const resolved = resolveInheritance(lowered);
    this.tables = new Map((resolved.model.entities ?? []).map(e => [e.name, e]));
    this.loweredRelationships = resolved.model.relationships ?? [];
    this.defined = resolveDefinedEntities(model).infos;
  }

  isTableBacked(e: Entity): boolean {
    return !e.abstract && !!e.dataSource?.trim() &&
        !e.dataSource.startsWith('unbound:') && !!e.keys?.length;
  }

  branches(name: string): Branch[] {
    const info = this.defined.get(name);
    if (info) {
      const prop = membershipPropertyName(name);
      return this.branches(info.base).map(b => {
        const f = b.entity.fields.find(x => x.name === prop);
        const expr = f && fieldBinding(f);
        if (!expr) {
          throw new Unsupported(
              `defined entity '${name}' has no membership predicate on '${
                  b.entity.name}' under this binding`);
        }
        return {
          entity: b.entity,
          filters: [...b.filters, stripQualifier(expr, b.entity.name)],
        };
      });
    }
    const e = this.tables.get(name);
    if (!e) throw new Unsupported(`'${name}' is not an entity of the model`);
    const members = [
      e,
      ...[...this.tables.values()].filter(
          d => d !== e && (d.extends ?? []).includes(name)),
    ];
    const out: Branch[] = [];
    const seen = new Set<string>();
    for (const m of members) {
      if (m.abstract) continue;
      if (!this.isTableBacked(m)) {
        if (m === e) {
          throw new Unsupported(`entity '${name}' has no bound table and key ` +
                                `under this binding`);
        }
        this.warnings.push(`entity '${m.name}' (an instance of '${
            name}') has no bound table; its rows are not checked`);
        continue;
      }
      const key = m.dataSource.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({entity: m, filters: []});
    }
    if (!out.length) {
      throw new Unsupported(`'${name}' has no table-backed instances under ` +
                            `this binding`);
    }
    return out;
  }

  keys(name: string): string[] {
    const info = this.defined.get(name);
    if (info) return this.keys(info.base);
    const e = this.tables.get(name);
    if (e?.keys?.length) return e.keys;
    const first = this.branches(name)[0];
    return first.entity.keys;
  }

  // The SQL a field reads on one table: its bound column or expression.
  column(entity: Entity, field: string): string {
    const f = entity.fields.find(x => x.name === field);
    const expr = f && fieldBinding(f);
    if (!expr) {
      throw new Unsupported(
          `field '${entity.name}.${field}' is not bound under this binding`);
    }
    const local = stripQualifier(expr, entity.name);
    return isSimpleIdentifier(local) ? quoteIfReserved(local) : `(${local})`;
  }

  // The rows of class `name`, projecting `fields` under their logical names.
  // Several tables (subtypes with tables of their own) are unioned and
  // de-duplicated by key, so an instance counts once.
  rows(name: string, fields: string[]): string {
    const cols = [...new Set(fields)];
    const branches = this.branches(name);
    const selects = branches.map(b => {
      const list = cols.map(f => `${this.column(b.entity, f)} AS ${q(f)}`);
      const where = b.filters.length ?
          `\nWHERE ${b.filters.map(x => `(${x})`).join(' AND ')}` :
          '';
      return `SELECT ${list.join(', ')}\nFROM ${table(b.entity)}${where}`;
    });
    if (selects.length === 1) return selects[0];
    const keys = this.keys(name);
    const union = `SELECT * FROM (\n${indent(selects.join('\nUNION ALL\n'))}\n)`;
    return keys.every(k => cols.includes(k)) ?
        `${union}\nWHERE TRUE\nQUALIFY ROW_NUMBER() OVER (PARTITION BY ${
            keys.map(q).join(', ')}) = 1` :
        `SELECT DISTINCT * FROM (\n${indent(union)}\n)`;
  }
}

export function table(e: Entity): string {
  const src = e.dataSource.trim();
  return /\s/.test(src) ? `(${src})` : `\`${src}\``;
}


// ---------------------------------------------------------------------------
// SQL rendering.
// ---------------------------------------------------------------------------

// A logical column name in generated SQL: always backticked.
export function q(name: string): string {
  return `\`${name}\``;
}
// A GoogleSQL string literal.
export function sqlString(s: string): string {
  return `'${
      s.replace(/\\/g, '\\\\').replace(/'/g, `\\'`).replace(/\n/g, '\\n')}'`;
}
export function str(field: string): string {
  return `CAST(${q(field)} AS STRING)`;
}
export function indent(sql: string): string {
  return sql.split('\n').map(l => `  ${l}`).join('\n');
}
export function cte(name: string, sql: string): string {
  return `${name} AS (\n${indent(sql)}\n)`;
}
export function keyExpr(keys: string[]): string {
  return keys.length === 1 ?
      str(keys[0]) :
      `TO_JSON_STRING([${keys.map(str).join(', ')}])`;
}
export function allSet(fields: string[], alias = ''): string {
  return fields.map(f => `${alias}${q(f)} IS NOT NULL`).join(' AND ');
}

// What a check queries: CTEs, the relation counted, the per-row violation
// predicate, and how a violating row is shown.
interface QueryParts {
  ctes: string[];
  from: string;
  violation: string;
  key: string;
  value: string;
}

function renderCount(p: QueryParts): string {
  return `WITH ${p.ctes.join(',\n')}\nSELECT\n  COUNTIF(${
      p.violation}) AS violations,\n  COUNT(*) AS total\nFROM ${p.from}`;
}

function renderExamples(p: QueryParts, limit: number): string {
  return `WITH ${p.ctes.join(',\n')}\nSELECT\n  ${p.key} AS focus_key,\n  ${
      p.value} AS value\nFROM ${p.from}\nWHERE ${p.violation}\nLIMIT ${limit}`;
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TEMPORAL_SQL: Partial<Record<DataType, string>> = {
  Date: 'DATE',
  DateTime: 'DATETIME',
  DateTimeTz: 'TIMESTAMP',
  Time: 'TIME',
};
const RANGE_VIOLATION: Record<RangeBound['term'], string> = {
  minInclusive: '<',
  minExclusive: '<=',
  maxInclusive: '>',
  maxExclusive: '>=',
};
// SHACL / XPath regex flags RE2 understands, as an inline group.
const RE2_FLAGS: Record<string, string> = {i: 'i', s: 's', m: 'm'};

// The parts of one parsed constraint's check.
function constraintParts(
    spec: ConstraintSpec, binder: Binder, index: ModelIndex): QueryParts {
  if (spec.kind === 'disjointClasses') return disjointParts(spec.classes, binder);
  if (spec.kind === 'cardinality' || spec.kind === 'class') {
    return relationshipParts(spec, binder, index);
  }
  const C = spec.entity;
  const keys = binder.keys(C);
  const f = spec.field;
  const fields = spec.kind === 'lessThan' || spec.kind === 'lessThanOrEquals' ||
          spec.kind === 'equals' || spec.kind === 'disjoint' ?
      [...keys, f, spec.other] :
      [...keys, f];
  const focus = cte('focus', binder.rows(C, fields));
  const a = q(f);
  let violation: string;
  let value = str(f);
  switch (spec.kind) {
    case 'required':
      violation = `${a} IS NULL OR TRIM(${str(f)}) = ''`;
      break;
    case 'empty':
      violation = `${a} IS NOT NULL`;
      break;
    case 'pattern': {
      let prefix = '';
      for (const flag of spec.flags ?? '') {
        if (!RE2_FLAGS[flag]) {
          throw new Unsupported(`regular-expression flag '${flag}'`);
        }
        prefix += RE2_FLAGS[flag];
      }
      const regex = prefix ? `(?${prefix})${spec.pattern}` : spec.pattern;
      violation = `${a} IS NOT NULL AND NOT REGEXP_CONTAINS(${str(f)}, ${
          sqlString(regex)})`;
      break;
    }
    case 'in':
      violation = `${a} IS NOT NULL AND ${str(f)} NOT IN (${
          spec.values.map(sqlString).join(', ')})`;
      break;
    case 'value':
      violation = `${a} IS NULL OR ${str(f)} != ${sqlString(spec.value)}`;
      break;
    case 'range': {
      const type = index.fieldType(C, f);
      const cmp = spec.bounds.map(b => {
        const op = RANGE_VIOLATION[b.term];
        if (NUMERIC.test(b.value)) {
          return `SAFE_CAST(${str(f)} AS BIGNUMERIC) ${op} CAST(${
              sqlString(b.value)} AS BIGNUMERIC)`;
        }
        const t = type && TEMPORAL_SQL[type];
        if (t) {
          return `SAFE_CAST(${str(f)} AS ${t}) ${op} SAFE_CAST(${
              sqlString(b.value)} AS ${t})`;
        }
        return `${str(f)} ${op} ${sqlString(b.value)}`;
      });
      violation = `${a} IS NOT NULL AND (${cmp.join(' OR ')})`;
      break;
    }
    case 'length': {
      const cmp = [
        spec.min !== undefined ? `LENGTH(${str(f)}) < ${spec.min}` : '',
        spec.max !== undefined ? `LENGTH(${str(f)}) > ${spec.max}` : '',
      ].filter(Boolean);
      violation = `${a} IS NOT NULL AND (${cmp.join(' OR ')})`;
      break;
    }
    default: {
      const b = q(spec.other);
      value = `CONCAT(IFNULL(${str(f)}, 'NULL'), ' vs ', IFNULL(${
          str(spec.other)}, 'NULL'))`;
      violation = spec.kind === 'lessThan' ?
          `${a} IS NOT NULL AND ${b} IS NOT NULL AND ${a} >= ${b}` :
          spec.kind === 'lessThanOrEquals' ?
          `${a} IS NOT NULL AND ${b} IS NOT NULL AND ${a} > ${b}` :
          spec.kind === 'equals' ?
          `(${a} IS NULL) != (${b} IS NULL) OR ${a} != ${b}` :
          `${a} = ${b}`;
    }
  }
  return {ctes: [focus], from: 'focus', violation, key: keyExpr(keys), value};
}

// Joins `left.cols[i] = right.kcmd_j<i>`.
export function joinOn(left: string, cols: string[], right: string): string {
  return cols.map((c, i) => `${left}.${q(c)} = ${right}.kcmd_j${i}`)
      .join(' AND ');
}
export function projectJ(cols: string[], alias = ''): string {
  return cols.map((c, i) => `${alias}${q(c)} AS kcmd_j${i}`).join(', ');
}
export function groupJ(cols: string[]): string {
  return cols.map((_, i) => `kcmd_j${i}`).join(', ');
}

// Edge cardinality and edge-target rules over a direct foreign key.
//
// An edge counts only when the row at its other end exists (and, for a
// qualified rule, is an instance of the qualifier): a foreign key pointing at
// nothing is not an edge a graph traversal can follow, so it is a missing
// edge, not a present one.
function relationshipParts(
    spec: Extract<ConstraintSpec, {kind: 'cardinality'|'class'}>,
    binder: Binder, index: ModelIndex): QueryParts {
  const rel = index.relationships.find(r => r.name === spec.relationship)!;
  if (rel.association) {
    throw new Unsupported(`relationship '${rel.name}' is backed by an ` +
                          `association table`);
  }
  if (rel.abstract) {
    throw new Unsupported(`relationship '${rel.name}' is abstract (no join)`);
  }
  const C = spec.entity;
  const keys = binder.keys(C);
  const F = rel.source.columns;       // foreign key, on the source side
  const D = rel.destination.columns;  // referenced columns, destination side
  const own = spec.inverse ? D : F;   // the focus columns the edge joins on

  const focus = cte('focus', binder.rows(C, [...keys, ...own]));
  const checked = (extra: string, joinCte: string) => cte(
      'checked',
      `SELECT focus.*, ${extra}\nFROM focus\nLEFT JOIN ${joinCte} ON ${
          joinOn('focus', own, joinCte)}`);

  if (spec.kind === 'cardinality') {
    let edges: string;
    if (!spec.inverse) {
      const T = spec.qualifier ?? rel.destination.entity;
      edges = `SELECT ${projectJ(D)}, COUNT(*) AS kcmd_n\nFROM (\n${
          indent(binder.rows(T, [...binder.keys(T), ...D]))}\n)\nGROUP BY ${
          groupJ(D)}`;
    } else {
      const S = spec.qualifier ?? rel.source.entity;
      edges = `SELECT ${projectJ(F)}, COUNT(*) AS kcmd_n\nFROM (\n${
          indent(binder.rows(S, [...binder.keys(S), ...F]))}\n)\nWHERE ${
          allSet(F)}\nGROUP BY ${groupJ(F)}`;
    }
    const bounds = [
      spec.min !== undefined ? `kcmd_edge_count < ${spec.min}` : '',
      spec.max !== undefined ? `kcmd_edge_count > ${spec.max}` : '',
    ].filter(Boolean);
    if (!bounds.length) throw new Unsupported('a cardinality with no bound');
    return {
      ctes: [
        focus, cte('edges', edges),
        checked('COALESCE(edges.kcmd_n, 0) AS kcmd_edge_count', 'edges'),
      ],
      from: 'checked',
      violation: bounds.join(' OR '),
      key: keyExpr(keys),
      value: 'CAST(kcmd_edge_count AS STRING)',
    };
  }

  // kind 'class': every edge leads to (or, read backwards, comes from) an
  // instance of the target class.
  const X = spec.target;
  if (!spec.inverse) {
    const targets = `SELECT DISTINCT ${projectJ(D)}\nFROM (\n${
        indent(binder.rows(X, [...binder.keys(X), ...D]))}\n)`;
    return {
      ctes: [
        focus, cte('targets', targets),
        checked('targets.kcmd_j0 IS NOT NULL AS kcmd_match', 'targets'),
      ],
      from: 'checked',
      violation: `${allSet(F)} AND NOT kcmd_match`,
      key: keyExpr(keys),
      value: keyExpr(F),
    };
  }
  const S = rel.source.entity;
  const sKeys = binder.keys(S);
  const sources = `SELECT ${projectJ(F, 's.')}, COUNT(*) AS kcmd_n\nFROM (\n${
      indent(binder.rows(S, [...sKeys, ...F]))}\n) AS s\nLEFT JOIN (\n${
      indent(`SELECT DISTINCT ${projectJ(sKeys)}\nFROM (\n${
          indent(binder.rows(X, [...binder.keys(X), ...sKeys]))}\n)`)}\n) AS x ON ${
      joinOn('s', sKeys, 'x')}\nWHERE ${allSet(F, 's.')} AND x.kcmd_j0 IS NULL\nGROUP BY ${
      groupJ(F)}`;
  return {
    ctes: [
      focus, cte('others', sources),
      checked('COALESCE(others.kcmd_n, 0) AS kcmd_edge_count', 'others'),
    ],
    from: 'checked',
    violation: 'kcmd_edge_count > 0',
    key: keyExpr(keys),
    value: 'CAST(kcmd_edge_count AS STRING)',
  };
}

// No instance (identified by its key) is an instance of two of the classes.
function disjointParts(classes: string[], binder: Binder): QueryParts {
  const members = classes.map(c => {
    const keys = binder.keys(c);
    return `SELECT ${keyExpr(keys)} AS kcmd_key, ${
        sqlString(c)} AS kcmd_class\nFROM (\n${
        indent(binder.rows(c, keys))}\n)`;
  });
  return {
    ctes: [
      cte('members', members.join('\nUNION ALL\n')),
      cte('instances',
          `SELECT kcmd_key, COUNT(DISTINCT kcmd_class) AS kcmd_classes, ` +
              `STRING_AGG(DISTINCT kcmd_class, ', ' ORDER BY kcmd_class) AS ` +
              `kcmd_class_list\nFROM members\nGROUP BY kcmd_key`),
    ],
    from: 'instances',
    violation: 'kcmd_classes > 1',
    key: 'kcmd_key',
    value: 'kcmd_class_list',
  };
}

// A key over one table: never null (primary) and never repeated.
function keyParts(e: Entity, cols: string[], primary: boolean): QueryParts {
  const select = `SELECT ${
      [...new Set([...e.keys, ...cols])]
          .map(f => `${columnOf(e, f)} AS ${q(f)}`)
          .join(', ')}\nFROM ${table(e)}`;
  const partition = cols.map(q).join(', ');
  return {
    ctes: [
      cte('focus', select),
      cte('checked',
          `SELECT focus.*, COUNT(*) OVER (PARTITION BY ${
              partition}) AS kcmd_rows\nFROM focus`),
    ],
    from: 'checked',
    violation: primary ?
        `${cols.map(c => `${q(c)} IS NULL`).join(' OR ')} OR kcmd_rows > 1` :
        `${allSet(cols)} AND kcmd_rows > 1`,
    key: keyExpr(e.keys),
    value: `CONCAT(${keyExpr(cols)}, ' x', CAST(kcmd_rows AS STRING))`,
  };
}

export function columnOf(e: Entity, field: string): string {
  const f = e.fields.find(x => x.name === field);
  const expr = f && fieldBinding(f);
  if (!expr) {
    // A key that is not a declared field is already a raw column.
    if (!f) return quoteIfReserved(field);
    throw new Unsupported(`field '${e.name}.${field}' is not bound`);
  }
  const local = stripQualifier(expr, e.name);
  return isSimpleIdentifier(local) ? quoteIfReserved(local) : `(${local})`;
}


// ---------------------------------------------------------------------------
// The plan.
// ---------------------------------------------------------------------------

export interface ValidationCheck {
  // Unique within the plan: the constraint name, or a derived id for a
  // structural check (`<Entity>_primary_key`, `<relationship>_references`).
  id: string;
  // The constraint the check evaluates (equal to `id` for a structural one).
  constraint: string;
  // `constraint`: a model constraint; `model`: a key or foreign key the model
  // states structurally.
  source: 'constraint'|'model';
  origin: 'SHACL'|'OWL'|'model';
  kind: CheckKind;
  // The entity the result is about (and is published on).
  entity: string;
  // The field or relationship the rule constrains, when it has one.
  field?: string;
  onViolation?: ViolationEffect;
  severity?: ConstraintSeverity;
  // Returns one row: `violations`, `total`.
  sql: string;
  // Returns up to N violating rows: `focus_key`, `value`.
  examplesSql: string;
}

export interface UnsupportedConstraint {
  constraint: string;
  reason: string;
}

export interface ValidationPlan {
  model: string;
  checks: ValidationCheck[];
  unsupported: UnsupportedConstraint[];
  warnings: string[];
}

export interface PlanOptions {
  // Rows the examples query returns. Default 5.
  examples?: number;
  // Also check primary keys, unique keys and foreign keys. Default true.
  structural?: boolean;
}

/**
 * Compiles every constraint of `model` (the AUTHORED model, merged with the
 * selected binding profile but not inheritance-resolved) into a violation-
 * count query and an examples query over the bound BigQuery tables. A
 * constraint that cannot be checked is listed in `unsupported` with the
 * reason; nothing is skipped silently.
 */
export function planBigQueryValidation(
    model: SemanticModel, options: PlanOptions = {}): ValidationPlan {
  const limit = options.examples ?? 5;
  const index = new ModelIndex(model);
  const binder = new Binder(model);
  const checks: ValidationCheck[] = [];
  const unsupported: UnsupportedConstraint[] = [];
  const ids = new Set<string>();
  const claim = (base: string) => {
    let id = base;
    for (let i = 2; ids.has(id); i++) id = `${base}_${i}`;
    ids.add(id);
    return id;
  };

  for (const c of model.constraints ?? []) {
    const parsed = parseConstraintSpec(c, model);
    if ('unsupported' in parsed) {
      unsupported.push({constraint: c.name, reason: parsed.unsupported});
      continue;
    }
    const {spec, origin} = parsed;
    let parts: QueryParts;
    try {
      parts = constraintParts(spec, binder, index);
    } catch (err) {
      if (!(err instanceof Unsupported)) throw err;
      unsupported.push({constraint: c.name, reason: err.message});
      continue;
    }
    checks.push({
      id: claim(c.name),
      constraint: c.name,
      source: 'constraint',
      origin,
      kind: spec.kind,
      entity: spec.entity,
      ...('field' in spec ? {field: spec.field} : {}),
      ...('relationship' in spec ? {field: spec.relationship} : {}),
      ...(c.onViolation ? {onViolation: c.onViolation} : {}),
      ...(c.severity ? {severity: c.severity} : {}),
      sql: renderCount(parts),
      examplesSql: renderExamples(parts, limit),
    });
  }

  if (options.structural ?? true) {
    const structural = (id: string, kind: CheckKind, entity: string,
                        field: string|undefined, make: () => QueryParts) => {
      try {
        const parts = make();
        const checkId = claim(id);
        checks.push({
          id: checkId,
          constraint: checkId,
          source: 'model',
          origin: 'model',
          kind,
          entity,
          ...(field ? {field} : {}),
          sql: renderCount(parts),
          examplesSql: renderExamples(parts, limit),
        });
      } catch (err) {
        if (!(err instanceof Unsupported)) throw err;
        binder.warnings.push(`${id}: not checked (${err.message})`);
      }
    };
    // One key check per table: a subtype sharing its parent's table states
    // the same key over the same rows.
    const keyed = new Set<string>();
    for (const e of binder.tables.values()) {
      if (!binder.isTableBacked(e)) continue;
      const pk = `${e.dataSource.trim()}|${e.keys.join(',')}`;
      if (!keyed.has(pk)) {
        keyed.add(pk);
        structural(`${e.name}_primary_key`, 'primaryKey', e.name,
                   e.keys.join(', '), () => keyParts(e, e.keys, true));
      }
      for (const uk of e.uniqueKeys ?? []) {
        structural(`${e.name}_unique_${uk.join('_')}`, 'uniqueKey', e.name,
                   uk.join(', '), () => keyParts(e, uk, false));
      }
    }
    for (const rel of binder.loweredRelationships) {
      if (rel.abstract || rel.association) continue;
      structural(`${rel.name}_references`, 'references', rel.source.entity,
                 rel.name, () => relationshipParts(
                                     {
                                       kind: 'class',
                                       entity: rel.source.entity,
                                       relationship: rel.name,
                                       inverse: false,
                                       target: rel.destination.entity,
                                     },
                                     binder,
                                     // Defined endpoints were re-pointed at
                                     // their base by the lowering.
                                     new ModelIndex({
                                       ...model,
                                       relationships: binder.loweredRelationships,
                                     })));
    }
  }

  return {
    model: model.name,
    checks,
    unsupported,
    warnings: [...new Set(binder.warnings)],
  };
}

/** One line per unsupported constraint, for a single warning. */
export function unsupportedWarning(plan: ValidationPlan): string|undefined {
  if (!plan.unsupported.length) return undefined;
  return `${plan.unsupported.length} constraint(s) of model '${
             plan.model}' cannot be checked over BigQuery and are skipped:\n` +
      plan.unsupported.map(u => `  - ${u.constraint}: ${u.reason}`).join('\n');
}


// ---------------------------------------------------------------------------
// --sql-only artifacts: the .sql file and the JSON manifest.
// ---------------------------------------------------------------------------

export interface PlanMeta {
  profile: string;
  generatedAt?: string;
}

/** The queries as one runnable .sql file, each count query then its examples. */
export function renderValidationSql(plan: ValidationPlan, meta: PlanMeta): string {
  const out = [
    `-- Generated by kcmd validate --target bigquery for model '${
        plan.model}' (profile '${meta.profile}').`,
    `-- Each check is a violation-count query (violations, total) followed ` +
        `by an examples query.`,
    `-- Read-only: nothing here writes, and the results are a report, never ` +
        `a filter.`,
  ];
  for (const u of plan.unsupported) {
    out.push(`-- skipped ${u.constraint}: ${u.reason.replace(/\n/g, ' ')}`);
  }
  for (const c of plan.checks) {
    out.push(
        '', `-- [${c.id}] ${c.kind} on ${c.entity}${c.field ? ` (${c.field})` : ''}`,
        `${c.sql};`, `-- [${c.id}] examples`, `${c.examplesSql};`);
  }
  return out.join('\n') + '\n';
}

/** The machine-readable manifest written beside the .sql file. */
export function validationManifest(plan: ValidationPlan, meta: PlanMeta) {
  return {
    model: plan.model,
    profile: meta.profile,
    ...(meta.generatedAt ? {generatedAt: meta.generatedAt} : {}),
    checks: plan.checks.map(c => ({
                              id: c.id,
                              constraint: c.constraint,
                              source: c.source,
                              origin: c.origin,
                              kind: c.kind,
                              entity: c.entity,
                              ...(c.field ? {field: c.field} : {}),
                              ...(c.onViolation ? {onViolation: c.onViolation} : {}),
                              ...(c.severity ? {severity: c.severity} : {}),
                              sql: c.sql,
                              examplesSql: c.examplesSql,
                            })),
    unsupported: plan.unsupported,
    warnings: plan.warnings,
  };
}


// ---------------------------------------------------------------------------
// Results and the Knowledge Catalog aspect.
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass'|'fail'|'error';

export interface CheckResult {
  id: string;
  constraint: string;
  kind: CheckKind;
  entity: string;
  field?: string;
  status: CheckStatus;
  violations?: number;
  total?: number;
  examples: string[];
  error?: string;
  checkedAt: string;
  sql: string;
  onViolation?: ViolationEffect;
  severity?: ConstraintSeverity;
}

/** A finished check: pass with zero violations, fail with any. */
export function checkResult(
    check: ValidationCheck, outcome: {
      violations?: number; total?: number; examples?: string[]; error?: string
    },
    checkedAt: string): CheckResult {
  const status: CheckStatus = outcome.error !== undefined &&
          outcome.violations === undefined ?
      'error' :
      (outcome.violations ?? 0) > 0 ? 'fail' :
                                      'pass';
  return {
    id: check.id,
    constraint: check.constraint,
    kind: check.kind,
    entity: check.entity,
    ...(check.field ? {field: check.field} : {}),
    status,
    ...(outcome.violations !== undefined ? {violations: outcome.violations} : {}),
    ...(outcome.total !== undefined ? {total: outcome.total} : {}),
    examples: outcome.examples ?? [],
    ...(outcome.error !== undefined ? {error: outcome.error} : {}),
    checkedAt,
    sql: check.sql,
    ...(check.onViolation ? {onViolation: check.onViolation} : {}),
    ...(check.severity ? {severity: check.severity} : {}),
  };
}

/**
 * The per-constraint payload published in the constraint-results aspect:
 * {constraint, kind, violations, total, examples[], checkedAt, sql}, plus the
 * status, the field, an error when the check could not run, and the
 * constraint's routing words so a reader can rank without a second lookup.
 */
export function constraintResultPayload(r: CheckResult): Record<string, any> {
  const out: Record<string, any> = {
    constraint: r.constraint,
    kind: r.kind,
    status: r.status,
  };
  if (r.field !== undefined) out.field = r.field;
  if (r.violations !== undefined) out.violations = r.violations;
  if (r.total !== undefined) out.total = r.total;
  out.examples = [...r.examples];
  out.checkedAt = r.checkedAt;
  out.sql = r.sql;
  if (r.error !== undefined) out.error = r.error;
  if (r.onViolation) out.onViolation = r.onViolation;
  if (r.severity) out.severity = r.severity;
  return out;
}

export const CONSTRAINT_RESULTS_TYPE_ID = 'semantic-constraint-results';

// The aspect type the results are published under. Aspect-only (it rides the
// built-in `semantic-entity` entries), so it is not a CUSTOM_TYPES record --
// those are entry-type + aspect-type pairs that `kcmd init` provisions. It is
// created on first `--publish` instead (see ensureResultsAspectType), at the
// same home as the custom types (`<project>/global`). The template follows the
// custom-types rule: append-only, never renumber.
export const CONSTRAINT_RESULTS_ASPECT_TYPE: Omit<AspectType, 'name'> = {
  displayName: 'Semantic Constraint Results',
  description:
      'The last measured state of the data against the semantic model\'s ' +
      'constraints: one record per rule checked on this entity, with the ' +
      'violation count, the rows examined, sample violating keys and the ' +
      'query that produced them. A report, never a filter.',
  metadataTemplate: {
    name: CONSTRAINT_RESULTS_TYPE_ID,
    type: 'record',
    recordFields: [
      {index: 1, name: 'model', type: 'string', annotations: {displayName: 'Model'}},
      {
        index: 2,
        name: 'profile',
        type: 'string',
        annotations: {
          displayName: 'Binding Profile',
          description: 'The binding profile whose tables were checked.',
        },
      },
      {
        index: 3,
        name: 'checkedAt',
        type: 'string',
        annotations: {
          displayName: 'Checked At',
          description: 'When the run that wrote this aspect finished (RFC 3339).',
        },
      },
      {
        index: 4,
        name: 'results',
        type: 'array',
        arrayItems: {
          name: 'result',
          type: 'record',
          recordFields: [
            {index: 1, name: 'constraint', type: 'string', constraints: {required: true}, annotations: {displayName: 'Constraint', description: 'The constraint (or structural key) checked.'}},
            {index: 2, name: 'kind', type: 'string', annotations: {displayName: 'Kind', description: 'The rule kind: required, pattern, in, range, cardinality, class, primaryKey, references, ...'}},
            {index: 3, name: 'field', type: 'string', annotations: {displayName: 'Field', description: 'The field or relationship the rule constrains.'}},
            {index: 4, name: 'status', type: 'string', annotations: {displayName: 'Status', description: '`pass`, `fail` or `error`.'}},
            {index: 5, name: 'violations', type: 'int', annotations: {displayName: 'Violations', description: 'Rows that break the rule.'}},
            {index: 6, name: 'total', type: 'int', annotations: {displayName: 'Total', description: 'Rows examined.'}},
            {index: 7, name: 'examples', type: 'array', arrayItems: {name: 'example', type: 'string'}, annotations: {displayName: 'Examples', description: 'Keys (and offending values) of sample violating rows.'}},
            {index: 8, name: 'checkedAt', type: 'string', annotations: {displayName: 'Checked At'}},
            {index: 9, name: 'sql', type: 'string', annotations: {displayName: 'SQL', description: 'The violation-count query that produced this result.'}},
            {index: 10, name: 'error', type: 'string', annotations: {displayName: 'Error', description: 'Why the check could not run, when it could not.'}},
            {index: 11, name: 'onViolation', type: 'string', annotations: {displayName: 'On Violation'}},
            {index: 12, name: 'severity', type: 'string', annotations: {displayName: 'Severity'}},
          ],
        },
        annotations: {
          displayName: 'Results',
          description: 'One record per constraint checked on this entity.',
        },
      },
    ],
  },
};

export interface KcDestination {
  project: string;
  location: string;
  entryGroup: string;
}

// Entry ids allow letters, numbers, underscores, hyphens, and periods.
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/**
 * The full name of an entity's Knowledge Catalog entry. Mirrors
 * knowledge_catalog.ts (Namer.entry + Namer.entityId), which publishes it;
 * the tests pin the two together.
 */
export function entityEntryName(
    dest: KcDestination, model: string, entity: string): string {
  return `projects/${dest.project}/locations/${dest.location}/entryGroups/${
      dest.entryGroup}/entries/${slug(model)}.entities.${slug(entity)}`;
}

export function resultsAspectKey(dest: {project: string}): string {
  return `${dest.project}.global.${CONSTRAINT_RESULTS_TYPE_ID}`;
}
export function resultsAspectTypeName(dest: {project: string}): string {
  return `projects/${dest.project}/locations/global/aspectTypes/${
      CONSTRAINT_RESULTS_TYPE_ID}`;
}

/**
 * The entry updates that publish `results`: one per entity, each carrying only
 * the constraint-results aspect (the update names just that aspect key, so the
 * entry's other aspects are untouched).
 */
export function constraintResultsUpdates(
    results: CheckResult[], dest: KcDestination,
    meta: {model: string; profile: string; checkedAt: string}): Entry[] {
  const byEntity = new Map<string, CheckResult[]>();
  for (const r of results) {
    byEntity.set(r.entity, [...(byEntity.get(r.entity) ?? []), r]);
  }
  return [...byEntity.entries()].map(([entity, rs]) => ({
                                       name: entityEntryName(dest, meta.model, entity),
                                       entryType: 'projects/dataplex-types/locations/global/entryTypes/semantic-entity',
                                       aspects: {
                                         [resultsAspectKey(dest)]: {
                                           aspectType: resultsAspectTypeName(dest),
                                           data: {
                                             model: meta.model,
                                             profile: meta.profile,
                                             checkedAt: meta.checkedAt,
                                             results: rs.map(constraintResultPayload),
                                           },
                                         },
                                       },
                                     }));
}

/** The console table: constraint, violations, total rows, status. */
export function formatResultsTable(results: CheckResult[]): string {
  const rows = results.map(r => [
    r.constraint,
    r.violations !== undefined ? String(r.violations) : '-',
    r.total !== undefined ? String(r.total) : '-',
    r.status === 'error' ? `error: ${(r.error ?? '').split('\n')[0]}` : r.status,
  ]);
  const head = ['CONSTRAINT', 'VIOLATIONS', 'TOTAL', 'STATUS'];
  const width = head.map(
      (h, i) => Math.max(h.length, ...rows.map(r => i < 3 ? r[i].length : 0)));
  const line = (r: string[]) => r.map((c, i) => i === 3 ? c :
                                          i === 0       ? c.padEnd(width[i]) :
                                                          c.padStart(width[i]))
                                     .join('  ');
  const failed = results.filter(r => r.status === 'fail').length;
  const errored = results.filter(r => r.status === 'error').length;
  return [
    line(head), ...rows.map(line), '',
    `${results.length} checked: ${results.length - failed - errored} pass, ${
        failed} fail, ${errored} error`,
  ].join('\n');
}


// ---------------------------------------------------------------------------
// Running (network).
// ---------------------------------------------------------------------------

export interface RunOptions {
  // Project the query jobs run (and bill) in. Defaults to ctx.project.
  project?: string;
  // BigQuery processing location (e.g. US). Inferred from the tables when unset.
  location?: string;
  examples?: number;
  concurrency?: number;
  maxPolls?: number;
  now?: () => Date;
}

export function errorText(message: string|undefined, status: number): string {
  if (!message) return String(status);
  try {
    const parsed = JSON.parse(message);
    return parsed?.error?.message ?? message;
  } catch {
    return message;
  }
}

// Runs one statement and returns its rows (cells as strings or null).
export async function runQuery(
    client: BigQueryClient, project: string, sql: string,
    location: string|undefined, dryRun: boolean,
    maxPolls: number): Promise<{rows?: (string|null)[][]; error?: string}> {
  const started = await client.query(project, sql, location, dryRun);
  if (started.status !== 200 || !started.result) {
    return {error: errorText(started.message, started.status)};
  }
  if (dryRun) return {rows: []};
  let res: QueryResponse = started.result;
  const jobId = res.jobReference?.jobId;
  const loc = res.jobReference?.location ?? location;
  for (let polls = 0; res.jobComplete === false && jobId && polls < maxPolls;
       polls++) {
    const next: ApiResult<QueryResponse> =
        await client.getQueryResults(project, jobId, loc, 1000);
    if (next.status !== 200 || !next.result) {
      return {error: errorText(next.message, next.status)};
    }
    res = next.result;
  }
  if (res.jobComplete === false) return {error: `job ${jobId} did not complete`};
  const rows = (res.rows ?? []) as {f: {v: any}[]}[];
  if (!rows.length && res.errors?.length) {
    return {error: res.errors.map(e => e.message).join('; ')};
  }
  return {
    rows: rows.map(r => r.f.map(c => c.v === null || c.v === undefined ? null : String(c.v))),
  };
}

/**
 * Runs every check: a dry run first (name resolution, access, syntax), then the
 * count query, then -- only for a failing check -- the examples query.
 */
export async function runBigQueryValidation(
    plan: ValidationPlan, ctx: context.ApiContext,
    options: RunOptions = {}): Promise<CheckResult[]> {
  const client = new BigQueryClient(ctx);
  const project = options.project ?? ctx.project;
  const maxPolls = options.maxPolls ?? 30;
  const examples = options.examples ?? 5;
  const now = options.now ?? (() => new Date());
  const results: CheckResult[] = new Array(plan.checks.length);

  const runOne = async (check: ValidationCheck): Promise<CheckResult> => {
    const dry = await runQuery(client, project, check.sql, options.location, true, maxPolls);
    if (dry.error) return checkResult(check, {error: dry.error}, now().toISOString());
    const counted = await runQuery(client, project, check.sql, options.location, false, maxPolls);
    if (counted.error || !counted.rows?.length) {
      return checkResult(check, {error: counted.error ?? 'no result row'}, now().toISOString());
    }
    const violations = Number(counted.rows[0][0] ?? 0);
    const total = Number(counted.rows[0][1] ?? 0);
    let sample: string[] = [];
    let error: string|undefined;
    if (violations > 0 && examples > 0) {
      const ex = await runQuery(client, project, check.examplesSql, options.location, false, maxPolls);
      if (ex.error) {
        error = `examples: ${ex.error}`;
      } else {
        sample = (ex.rows ?? []).map(([k, v]) => v === null || v === undefined ? `${k}` : `${k}: ${v}`);
      }
    }
    return checkResult(check, {violations, total, examples: sample, ...(error ? {error} : {})}, now().toISOString());
  };

  let next = 0;
  const worker = async () => {
    while (next < plan.checks.length) {
      const i = next++;
      results[i] = await runOne(plan.checks[i]);
    }
  };
  await Promise.all(Array.from(
      {length: Math.max(1, Math.min(options.concurrency ?? 6, plan.checks.length))},
      worker));
  return results;
}


// ---------------------------------------------------------------------------
// Publishing (network).
// ---------------------------------------------------------------------------

// Creates the results aspect type when it does not exist yet. An existing one
// is left as it is (409).
async function ensureResultsAspectType(
    cat: CatalogClient, dest: {project: string}): Promise<string|undefined> {
  const created = await cat.createAspectType(
      dest.project, 'global', CONSTRAINT_RESULTS_TYPE_ID,
      CONSTRAINT_RESULTS_ASPECT_TYPE);
  if (created.status === 409) return undefined;
  if (created.status !== 200) {
    return `creating aspect type '${CONSTRAINT_RESULTS_TYPE_ID}' in project '${
        dest.project}': ${errorText(created.message, created.status)}`;
  }
  return await cat.awaitOperation(
      created.result, `creating aspect type '${CONSTRAINT_RESULTS_TYPE_ID}'`);
}

/**
 * Writes the results to Knowledge Catalog: the constraint-results aspect on
 * each checked entity's entry (published by `kcmd push`). Only that aspect is
 * named in the update, so nothing else on the entry changes, and a later push
 * -- which names only the aspects it owns -- leaves it in place.
 */
export async function publishConstraintResults(
    results: CheckResult[], ctx: context.ApiContext, dest: KcDestination,
    meta: {model: string; profile: string; checkedAt: string}):
    Promise<{published: string[]; errors: string[]}> {
  const cat = new CatalogClient(ctx);
  const failed = await ensureResultsAspectType(cat, dest);
  if (failed) return {published: [], errors: [failed]};
  const published: string[] = [];
  const errors: string[] = [];
  for (const entry of constraintResultsUpdates(results, dest, meta)) {
    const res = await cat.updateEntry(entry, ['aspects'], [resultsAspectKey(dest)]);
    if (res.status === 200) {
      published.push(entry.name);
    } else {
      errors.push(`${entry.name.split('/').pop()}: ${
          res.status === 404 ? 'no such entry (run `kcmd push` first)' :
                               errorText(res.message, res.status)}`);
    }
  }
  return {published, errors};
}
