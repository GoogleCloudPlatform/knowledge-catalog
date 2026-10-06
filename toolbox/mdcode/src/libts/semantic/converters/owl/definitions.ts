// owl:equivalentClass -> defined (virtual) entities.
//
// An OWL defined class states necessary AND sufficient membership conditions:
//
//   com:WonOpportunity owl:equivalentClass
//       [ owl:intersectionOf ( com:Opportunity
//                              [ owl:onProperty com:inStage ;
//                                owl:hasValue com:Stage_Won ] ) ] .
//
// When those conditions can be decided on one row of an existing entity (the
// class's BASE: its nearest superclass that is not itself defined), the class
// becomes a defined entity (ir.Entity.definition) whose expression is that
// decision in SQL over the base's field names -- `salesStage = '5_won'` -- and
// the graph legs lower it to a boolean property on the base (see
// ../../defined_entities.ts). The compilation follows the ontology prototype's
// class_sql reference compiler:
//
//   named class on the base's lineage (the base or an ancestor) -> TRUE
//   another defined class over the same base                    -> its
//       definition, expanded inline
//   owl:intersectionOf / unionOf / complementOf                 -> AND / OR / NOT
//   hasValue <literal> on a datatype property                   -> field = lit
//   hasValue <individual> on an object property the ontology
//       marks `encodedBy` a code column                         -> LOWER(code) = 'c' (string codes match case-insensitively)
//   someValuesFrom a facet-restricted datatype                  -> range tests
//   someValuesFrom a data enumeration (owl:oneOf literals)      -> field IN (…)
//   someValuesFrom a plain datatype / min 1 / exact 1           -> IS NOT NULL
//   allValuesFrom R                                             -> (f IS NULL OR R)
//   max 0 / exact 0                                             -> IS NULL
//
// Anything else -- above all a restriction that traverses a relationship
// (`hasBuyer some StrategicAccount`), which needs a join a one-row predicate
// cannot express -- is warned, naming the construct that blocked compilation.
// A class with fields or a key of its own stays a table-backed subclass with
// the constraints its restrictions imply. One with neither has no rows to
// bind, so it becomes ABSTRACT (no node of its own) and keeps its constraints,
// its definition carried as readable text in ai_context.instructions.
//
// Two deliberate differences from the prototype: string comparisons are exact
// (the prototype lower-cases both sides), so the SQL means what the ontology
// says; and an individual with no stored code compiles to its local name with
// a warning rather than failing.

import {Entity, Field, Relationship} from '../../ir';

import {OwlClassExpr, OwlDataRange, OwlLiteral, OwlModel} from './model';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const OWL_THING = 'http://www.w3.org/2002/07/owl#Thing';
const RDFS_RESOURCE = 'http://www.w3.org/2000/01/rdf-schema#Resource';
const RDFS_LITERAL = 'http://www.w3.org/2000/01/rdf-schema#Literal';

const NUMERIC_XSD = new Set([
  'integer', 'int', 'long', 'short', 'byte', 'nonNegativeInteger',
  'nonPositiveInteger', 'positiveInteger', 'negativeInteger', 'unsignedLong',
  'unsignedInt', 'unsignedShort', 'unsignedByte', 'decimal', 'float', 'double',
]);

function localName(iri: string): string {
  const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return cut >= 0 ? iri.slice(cut + 1) : iri;
}

/** What the compiler produced: the classes it turned into defined entities. */
export interface DefinitionsResult {
  // Local names of the classes now carrying `definition`. Their
  // owl:equivalentClass restrictions are the definition, so the caller drops
  // them from constraint derivation.
  compiled: Set<string>;
}

// A compiled boolean: a constant, or SQL tagged with its outermost operator so
// a parent can parenthesize only where precedence requires.
type Compiled = {kind: 'true'}|{kind: 'false'}|{
  kind: 'sql';
  sql: string;
  prec: 'atom'|'and'|'or';
};
const TRUE: Compiled = {kind: 'true'};
const FALSE: Compiled = {kind: 'false'};

class Unsupported extends Error {
  constructor(readonly construct: string) {
    super(construct);
  }
}

function atom(sql: string): Compiled {
  return {kind: 'sql', sql, prec: 'atom'};
}

function andOf(parts: Compiled[]): Compiled {
  if (parts.some(p => p.kind === 'false')) return FALSE;
  const sql = parts.filter(
      (p): p is Extract<Compiled, {kind: 'sql'}> => p.kind === 'sql');
  if (!sql.length) return TRUE;
  if (sql.length === 1) return sql[0];
  return {
    kind: 'sql',
    sql: sql.map(p => p.prec === 'or' ? `(${p.sql})` : p.sql).join(' AND '),
    prec: 'and',
  };
}

function orOf(parts: Compiled[]): Compiled {
  if (parts.some(p => p.kind === 'true')) return TRUE;
  const sql = parts.filter(
      (p): p is Extract<Compiled, {kind: 'sql'}> => p.kind === 'sql');
  if (!sql.length) return FALSE;
  if (sql.length === 1) return sql[0];
  return {
    kind: 'sql',
    sql: sql.map(p => p.prec === 'atom' ? p.sql : `(${p.sql})`).join(' OR '),
    prec: 'or',
  };
}

function notOf(part: Compiled): Compiled {
  if (part.kind === 'true') return FALSE;
  if (part.kind === 'false') return TRUE;
  return atom(`NOT (${part.sql})`);
}

// A SQL string literal (GoogleSQL: backslash escapes inside '...').
function sqlString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
}

// A literal as SQL, by its XSD datatype (falling back to the target field's
// type for an untyped literal).
function sqlLiteral(lit: OwlLiteral, fieldType?: Field['type']): string {
  const dt = lit.datatype?.startsWith(XSD) ?
      lit.datatype.slice(XSD.length) :
      undefined;
  const v = lit.value.trim();
  const numeric = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v);
  if (dt && NUMERIC_XSD.has(dt) && numeric) return v;
  if (dt === 'boolean' && /^(true|false|1|0)$/.test(v)) {
    return v === 'true' || v === '1' ? 'TRUE' : 'FALSE';
  }
  if (dt === 'date') return `DATE ${sqlString(v)}`;
  if (dt === 'time') return `TIME ${sqlString(v)}`;
  if (dt === 'dateTime' || dt === 'dateTimeStamp') {
    return /(Z|[+-]\d\d:\d\d)$/.test(v) ? `TIMESTAMP ${sqlString(v)}` :
                                           `DATETIME ${sqlString(v)}`;
  }
  // An untyped / xsd:string literal compared with a typed field.
  if ((dt === undefined || dt === 'string') && !lit.language) {
    if ((fieldType === 'Integer' || fieldType === 'Decimal' ||
         fieldType === 'Float') &&
        numeric) {
      return v;
    }
    if (fieldType === 'Boolean' && /^(true|false)$/i.test(v)) {
      return v.toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
    }
  }
  return sqlString(lit.value);
}

interface Context {
  owl: OwlModel;
  entitiesByName: Map<string, Entity>;
  relationships: Relationship[];
  warnings: string[];
}

/**
 * Compiles every class with an owl:equivalentClass definition that can be
 * decided on one row of its base into a defined entity, in place: sets
 * `definition` and narrows `extends` to the single parent. Classes that do not
 * compile are left untouched (warned). Subclasses of a compiled class that are
 * not themselves defined are re-pointed at its base (a defined entity cannot
 * be a supertype).
 */
export function compileOwlDefinitions(
    owl: OwlModel,
    ctx: {entitiesByName: Map<string, Entity>; relationships: Relationship[]},
    warnings: string[]): DefinitionsResult {
  const compiled = new Set<string>();
  const c: Context = {owl, ...ctx, warnings};
  const candidates = new Map(
      owl.classes.filter(k => k.definitions?.length)
          .filter(k => c.entitiesByName.has(k.localName))
          .map(k => [k.localName, k]));
  if (!candidates.size) return {compiled};

  const lineage = (cls: string): string[] => {
    const out: string[] = [];
    const queue = [cls];
    while (queue.length) {
      const next = queue.shift()!;
      if (out.includes(next)) continue;
      out.push(next);
      queue.push(...(c.entitiesByName.get(next)?.extends ?? []));
    }
    return out;
  };
  // The nearest superclass that is not a candidate (breadth-first).
  const baseOf = (cls: string): string|undefined =>
      lineage(cls).slice(1).find(n => !candidates.has(n));

  const fieldOf = (base: string, name: string): Field|undefined => {
    for (const n of lineage(base)) {
      const f = c.entitiesByName.get(n)?.fields.find(x => x.name === name);
      if (f) return f;
    }
    return undefined;
  };
  const datatypeProps = new Set(owl.datatypeProperties.map(p => p.localName));
  const objectProps = new Map(owl.objectProperties.map(p => [p.localName, p]));

  // Compiles expression `e` as a membership test on rows of `base`.
  // `expanding` guards against definitional cycles (A ≡ … B …, B ≡ … A …).
  const compile =
      (e: OwlClassExpr, base: string, owner: string,
       expanding: Set<string>): Compiled => {
        switch (e.kind) {
          case 'named': {
            if (e.iri === OWL_THING || e.iri === RDFS_RESOURCE) return TRUE;
            const name = localName(e.iri);
            if (lineage(base).includes(name)) return TRUE;
            const other = candidates.get(name);
            if (other && baseOf(name) !== undefined &&
                lineage(base).includes(baseOf(name)!)) {
              if (expanding.has(name)) {
                throw new Unsupported(
                    `a circular definition through '${name}'`);
              }
              const inner = new Set(expanding).add(name);
              return orOf(other.definitions!.slice(0, 1).map(
                  d => compile(d, base, owner, inner)));
            }
            throw new Unsupported(`membership in class '${
                name}', which is neither on '${
                base}'s lineage nor a defined class over it`);
          }
          case 'and':
            return andOf(
                e.operands.map(o => compile(o, base, owner, expanding)));
          case 'or':
            return orOf(
                e.operands.map(o => compile(o, base, owner, expanding)));
          case 'not':
            return notOf(compile(e.operand, base, owner, expanding));
          case 'oneOf':
            throw new Unsupported('an enumeration of individuals (owl:oneOf)');
          case 'unsupported':
            throw new Unsupported(e.construct);
          case 'restriction':
            return compileRestriction(e, base, owner);
        }
      };

  const compileRestriction =
      (e: Extract<OwlClassExpr, {kind: 'restriction'}>, base: string,
       owner: string): Compiled => {
        const prop = localName(e.property);
        // Object property: decidable on the row only when its value is
        // stored as a code column on the subject (encodedBy).
        const op = objectProps.get(prop);
        if (op) {
          const column = op.encodedBy;
          if (!column) {
            throw new Unsupported(`a restriction on object property '${
                prop}', which traverses a relationship and has no ` +
                                  `encodedBy code column on '${base}'`);
          }
          const field = fieldOf(base, column);
          if (!field) {
            throw new Unsupported(`object property '${prop}' is encodedBy '${
                column}', which is not a field of '${base}'`);
          }
          const code = (iri: string): string => {
            const stored = c.owl.individualCodes?.[iri];
            if (stored !== undefined) return stored;
            c.warnings.push(`class '${owner}': individual '${
                localName(iri)}' has no code (core:code / skos:notation); ` +
                            `its local name is used in the definition.`);
            return localName(iri);
          };
          // Vocabulary codes are identifiers: on a string column they match
          // case-insensitively (source systems often store '5_Won' next to
          // '5_won'), so membership does not silently drop rows over casing.
          const codeIn = (codes: string[]): string => {
            if (field.type === 'String') {
              const lits = codes.map(v => sqlLiteral({value: v.toLowerCase()}, field.type));
              return lits.length === 1 ? `LOWER(${column}) = ${lits[0]}` :
                                         `LOWER(${column}) IN (${lits.join(', ')})`;
            }
            const lits = codes.map(v => sqlLiteral({value: v}, field.type));
            return lits.length === 1 ? `${column} = ${lits[0]}` :
                                       `${column} IN (${lits.join(', ')})`;
          };
          switch (e.restriction) {
            case 'value':
              if (!e.value || !('iri' in e.value)) {
                throw new Unsupported(
                    `a literal hasValue on object property '${prop}'`);
              }
              return atom(codeIn([code(e.value.iri)]));
            case 'some':
            case 'min':
            case 'exact': {
              const n = e.restriction === 'some' ? 1 : e.cardinality ?? 1;
              if (e.restriction === 'exact' && n === 0)
                return atom(`${column} IS NULL`);
              if (e.restriction === 'min' && n === 0) return TRUE;
              if (n !== 1) {
                throw new Unsupported(`a cardinality of ${
                    n} on single-valued '${prop}'`);
              }
              const f = e.filler;
              if (!f || isAnyClass(f, op.ranges[0])) {
                return atom(`${column} IS NOT NULL`);
              }
              if (f.kind === 'oneOf') {
                return atom(codeIn(f.members.map(code)));
              }
              throw new Unsupported(`a class filler on object property '${
                  prop}' other than its range or an enumeration`);
            }
            case 'max':
              if (e.cardinality === 0) return atom(`${column} IS NULL`);
              return TRUE;
            case 'all': {
              const f = e.filler;
              if (!f || isAnyClass(f, op.ranges[0])) return TRUE;
              if (f.kind === 'oneOf') {
                return atom(`(${column} IS NULL OR ${codeIn(f.members.map(code))})`);
              }
              throw new Unsupported(`an allValuesFrom class filler on '${
                  prop}'`);
            }
          }
        }
        if (!datatypeProps.has(prop)) {
          throw new Unsupported(`a restriction on '${
              prop}', which is not a property of this ontology`);
        }
        const field = fieldOf(base, prop);
        if (!field) {
          throw new Unsupported(
              `a restriction on '${prop}', which is not a field of '${base}'`);
        }
        switch (e.restriction) {
          case 'value':
            if (!e.value || !('literal' in e.value)) {
              throw new Unsupported(
                  `an individual hasValue on datatype property '${prop}'`);
            }
            return atom(`${prop} = ${sqlLiteral(e.value.literal, field.type)}`);
          case 'some':
            return rangeTest(prop, e.filler, field);
          case 'all': {
            const r = rangeTest(prop, e.filler, field, true);
            if (r.kind === 'true') return TRUE;
            if (r.kind === 'false') return atom(`${prop} IS NULL`);
            return atom(`(${prop} IS NULL OR ${r.sql})`);
          }
          case 'min':
          case 'exact': {
            const n = e.cardinality ?? 0;
            if (n === 0) {
              return e.restriction === 'min' ? TRUE : atom(`${prop} IS NULL`);
            }
            if (n !== 1) {
              throw new Unsupported(
                  `a cardinality of ${n} on single-valued '${prop}'`);
            }
            return rangeTest(prop, e.filler, field);
          }
          case 'max':
            if (e.cardinality === 0) return atom(`${prop} IS NULL`);
            if (e.filler) {
              throw new Unsupported(
                  `a qualified max cardinality on '${prop}'`);
            }
            return TRUE;
        }
      };

  // `prop` has a value in data range `r` (no range: any value). With
  // `allowAny`, a plain datatype test is vacuous (TRUE) rather than NOT NULL.
  const rangeTest =
      (prop: string, r: OwlClassExpr|OwlDataRange|undefined, field: Field,
       allowAny = false): Compiled => {
        if (!r || (r.kind === 'datatype') || isTopData(r)) {
          return allowAny ? TRUE : atom(`${prop} IS NOT NULL`);
        }
        if (r.kind === 'dataOneOf') {
          if (!r.values.length) return FALSE;
          return atom(`${prop} IN (${
              r.values.map(v => sqlLiteral(v, field.type)).join(', ')})`);
        }
        if (r.kind === 'facets') {
          const parts = r.facets.map(({facet, value}) => {
            const lit = sqlLiteral(
                value.datatype === `${XSD}string` ?
                    {...value, datatype: r.datatype} :
                    value,
                field.type);
            switch (localName(facet)) {
              case 'minInclusive':
                return atom(`${prop} >= ${lit}`);
              case 'minExclusive':
                return atom(`${prop} > ${lit}`);
              case 'maxInclusive':
                return atom(`${prop} <= ${lit}`);
              case 'maxExclusive':
                return atom(`${prop} < ${lit}`);
              case 'pattern':
                return atom(`REGEXP_CONTAINS(${prop}, ${
                    sqlString(`^(?:${value.value})$`)})`);
              case 'length':
                return atom(`CHAR_LENGTH(${prop}) = ${Number(value.value)}`);
              case 'minLength':
                return atom(`CHAR_LENGTH(${prop}) >= ${Number(value.value)}`);
              case 'maxLength':
                return atom(`CHAR_LENGTH(${prop}) <= ${Number(value.value)}`);
              default:
                throw new Unsupported(
                    `the datatype facet ${localName(facet)} on '${prop}'`);
            }
          });
          return parts.length ? andOf(parts) : atom(`${prop} IS NOT NULL`);
        }
        throw new Unsupported(`a class filler on datatype property '${prop}'`);
      };

  // Compile each candidate relative to its base.
  const results = new Map<string, {base: string; sql: string}>();
  for (const [name, cls] of candidates) {
    const entity = c.entitiesByName.get(name)!;
    if (entity.fields.length || entity.keys.length) {
      c.warnings.push(
          `class '${name}': its owl:equivalentClass definition was not ` +
          `compiled to a defined entity (it declares its own ${
              entity.fields.length ? 'fields' : 'key'}, so it is a table-backed ` +
          `subtype rather than a filter over its superclass); imported as a ` +
          `subclass with constraints instead.`);
      continue;
    }
    // A class with no fields or key of its own that cannot be a filter has
    // no rows to bind: as a concrete entity it would be a keyless node no
    // binding can satisfy. It becomes abstract (no node of its own), keeps
    // the constraints its restrictions imply, and carries its definition as
    // text so an agent can still evaluate membership by querying the base.
    const fallback = (why: string) => {
      entity.abstract = true;
      const text = cls.definitions!.map(d => describeClassExpr(d)).join('; or equivalently ');
      const over = baseOf(name);
      const note = `Membership is defined, not stored: a ${name} is ${text}. ` +
          `No ${name} rows or nodes exist; to find its members, evaluate ` +
          `this definition over ${over ? `${over} and its relationships` :
                                         'the entities it names'}.`;
      entity.aiContext = {
        ...(entity.aiContext ?? {}),
        instructions: entity.aiContext?.instructions ?
            `${entity.aiContext.instructions}\n\n${note}` :
            note,
      };
      c.warnings.push(
          `class '${name}': its owl:equivalentClass definition was not ` +
          `compiled to a defined entity (${why}); imported as an abstract ` +
          `entity with constraints, its definition in ai_context.instructions.`);
    };
    const base = baseOf(name);
    if (!base) {
      fallback('it has no superclass to define it over');
      continue;
    }
    let result: Compiled|undefined;
    let blocked: string|undefined;
    for (const d of cls.definitions!) {
      try {
        result = compile(d, base, name, new Set([name]));
        break;
      } catch (err) {
        if (!(err instanceof Unsupported)) throw err;
        blocked ??= err.construct;
      }
    }
    if (!result) {
      fallback(`unsupported: ${blocked}`);
      continue;
    }
    if (result.kind !== 'sql') {
      fallback(result.kind === 'true' ?
                   `it is equivalent to its superclass '${base}'` :
                   'it can have no members');
      continue;
    }
    results.set(name, {base, sql: result.sql});
  }

  // Parents: the most specific class on the lineage that is the base itself
  // or a compiled defined class over the same base. Its own definition makes
  // the conjunction redundant, but the hierarchy (Won ⊑ Closed) survives.
  for (const [name, {base, sql}] of results) {
    const entity = c.entitiesByName.get(name)!;
    const eligible = lineage(name).slice(1).filter(
        n => n === base || results.get(n)?.base === base);
    const parent = eligible.find(
        n => !eligible.some(m => m !== n && lineage(m).includes(n))) ??
        base;
    const dropped = (entity.extends ?? []).filter(
        p => p !== parent && !lineage(parent).includes(p));
    if (dropped.length) {
      c.warnings.push(`class '${name}': defined over '${parent}'; its other ` +
                      `superclass(es) ${
                          dropped.map(d => `'${d}'`)
                              .join(', ')} are not kept (a defined entity ` +
                      `has exactly one parent).`);
    }
    entity.extends = [parent];
    entity.dataSource = '';
    // No separate definition note: the class's own description
    // (skos:definition / rdfs:comment) already says what membership means.
    entity.definition = {expression: sql};
    compiled.add(name);
  }

  // A class that is not defined but subclasses a defined one: a defined
  // entity cannot be a supertype, so re-point it at that class's base.
  for (const entity of c.entitiesByName.values()) {
    if (compiled.has(entity.name) || !entity.extends?.length) continue;
    const parents: string[] = [];
    let changed = false;
    for (const p of entity.extends) {
      const target = compiled.has(p) ? results.get(p)!.base : p;
      if (target !== p) changed = true;
      if (!parents.includes(target)) parents.push(target);
    }
    if (changed) {
      c.warnings.push(`class '${entity.name}' subclasses defined class(es) ${
          entity.extends.filter(p => compiled.has(p))
              .map(p => `'${p}'`)
              .join(', ')}; it now extends ${
          parents.map(p => `'${p}'`)
              .join(', ')} instead (a defined entity cannot be a supertype).`);
      entity.extends = parents;
    }
  }
  return {compiled};
}

// A filler that admits any value of the property's range: owl:Thing, or the
// range class itself.
function isAnyClass(f: OwlClassExpr|OwlDataRange, range?: string): boolean {
  return f.kind === 'named' &&
      (f.iri === OWL_THING || (range !== undefined && localName(f.iri) === range));
}

function isTopData(r: OwlClassExpr|OwlDataRange): boolean {
  return r.kind === 'named' && r.iri === RDFS_LITERAL;
}

const FACET_SYMBOL: Record<string, string> = {
  minInclusive: '>=', minExclusive: '>', maxInclusive: '<=', maxExclusive: '<',
};

function describeLiteral(l: OwlLiteral): string {
  return JSON.stringify(l.value);
}

function describeFiller(f: OwlClassExpr|OwlDataRange): string {
  switch (f.kind) {
    case 'datatype':
      return localName(f.iri);
    case 'facets':
      return `${localName(f.datatype)}[${f.facets.map(({facet, value}) => {
        const name = localName(facet);
        return `${FACET_SYMBOL[name] ?? name} ${value.value}`;
      }).join(', ')}]`;
    case 'dataOneOf':
      return `{${f.values.map(describeLiteral).join(', ')}}`;
    default:
      return describeClassExpr(f, true);
  }
}

/**
 * A class expression as readable text in OWL Manchester syntax, e.g.
 * `Opportunity and (HighValueOpportunity or (hasBuyer some StrategicAccount))`.
 * Names are local names; `nested` parenthesizes a compound expression.
 */
export function describeClassExpr(e: OwlClassExpr, nested = false): string {
  const wrap = (s: string) => nested ? `(${s})` : s;
  switch (e.kind) {
    case 'named':
      return localName(e.iri);
    case 'and':
    case 'or':
      return wrap(e.operands.map(o => describeClassExpr(o, true)).join(` ${e.kind} `));
    case 'not':
      return `not ${describeClassExpr(e.operand, true)}`;
    case 'oneOf':
      return `{${e.members.map(localName).join(', ')}}`;
    case 'unsupported':
      return `(${e.construct})`;
    case 'restriction': {
      const p = localName(e.property);
      const filler = e.filler ? ` ${describeFiller(e.filler)}` : '';
      switch (e.restriction) {
        case 'value': {
          const v = e.value;
          const shown = !v ? '?' : 'literal' in v ? describeLiteral(v.literal) : localName(v.iri);
          return wrap(`${p} value ${shown}`);
        }
        case 'some':
        case 'all':
          return wrap(`${p} ${e.restriction === 'some' ? 'some' : 'only'}${filler || ' Thing'}`);
        default:
          return wrap(`${p} ${e.restriction} ${e.cardinality ?? 0}${filler}`);
      }
    }
  }
}
