// SHACL shapes -> semantic-model constraints.
//
// A SHACL shape states rules about the instances of a class -- *every
// opportunity has exactly one buyer*, *an engagement code matches
// ENG-[0-9]{6}* -- that a semantic model carries NATIVELY as model-level
// constraints (see ir.ts Constraint and docs/semantic-model/actions.md): a
// judged rule with a name, the rule in words (`judgment`), the error text a
// violation surfaces (`description`), what a violation does (`on_violation`),
// and how grave it is (`severity`). Knowledge Catalog publishes each one as a
// governed entry an agent reads, and an action that lists it in `guards` is
// refused when its write would break it. Nothing is carried opaquely: a SHACL
// term either becomes (part of) a constraint or is warned and skipped.
//
// Each property shape is resolved against the TARGET entity (a node shape's
// sh:targetClass, or the shape itself when it is also a class): its sh:path
// must name a relationship that starts at the entity or one of its supertypes,
// or a field of the entity or one of its supertypes. The mapping, per shape:
//
//   on a relationship p of C:
//     sh:minCount n = sh:maxCount n                 -> C_p_exactly_n
//     sh:minCount n (n > 0)                          -> C_p_min_n
//     sh:maxCount n                                  -> C_p_max_n
//     sh:class X (X not p's destination)             -> C_p_only_X
//     sh:qualifiedValueShape [sh:class X] + qualified-> C_p_exactly|min|max_n_X
//       Min/MaxCount                                    (no `_X` when X is p's
//                                                       destination)
//   on a field f of C:
//     sh:minCount 1                                  -> C_f_required
//     sh:maxCount 0                                  -> C_f_empty
//     sh:pattern (+ sh:flags)                        -> C_f_pattern
//     sh:in (v1 ... vn)                              -> C_f_in (C_f_value_v
//                                                       for a single value)
//     sh:min/maxInclusive, sh:min/maxExclusive       -> C_f_range
//     sh:minLength / sh:maxLength                    -> C_f_length
//   comparing a field f of C with another field g of C (or of a supertype):
//     sh:lessThan g                                  -> C_f_lt_g
//     sh:lessThanOrEquals g                          -> C_f_lte_g
//     sh:equals g                                    -> C_f_eq_g
//     sh:disjoint g                                  -> C_f_disjoint_g
//
// A property pair is a rule between two columns of one row, which is exactly
// what a judged constraint can state; the judgment names both as C.f / C.g so
// push validation resolves them. The other path must be a FIELD of the same
// entity or one of its supertypes -- a relationship has no single value to
// compare, and another entity's field is not "its" value -- else the pair is
// warned and skipped. So is a field compared with itself, and an ordering
// (sh:lessThan / sh:lessThanOrEquals) or sh:equals between datatypes whose
// values never compare (a Decimal with a String): SHACL would fail every
// focus node that sets them. sh:disjoint between such datatypes always holds,
// so it is structurally guaranteed and dropped silently.
//
// Structurally guaranteed facts are dropped silently, as the OWL importer does:
// a field's sh:maxCount >= 1 (a field holds one value), an sh:datatype that
// agrees with the field's datatype, an sh:class equal to the relationship's
// destination, sh:minCount 0. A conflicting sh:datatype, an unresolvable path,
// an unsupported term (sh:node, sh:or, sh:closed, a non-IRI path, ...) is
// warned and skipped.
//
// Enforcement facets come from SHACL's own sh:severity (default sh:Violation,
// per the SHACL spec, and read per shape -- a property shape does not inherit
// its node shape's severity):
//   sh:Violation -> severity high,   on_violation reject
//   sh:Warning   -> severity medium, on_violation warn
//   sh:Info      -> severity low,    on_violation warn
// sh:message (else sh:description, else a generated steering sentence) is the
// description -- the text a violation surfaces -- followed by a provenance
// note `(From SHACL: <shape>, <path> <terms>.)`. The provenance is what makes a
// re-import idempotent: constraints previously generated from a shape in the
// current input are replaced (see import.ts).

import {Constraint, ConstraintSeverity, DataType, Entity, Relationship, SemanticModel, ViolationEffect,} from '../../ir';
import {localName} from '../owl/parse';
import {datatypeFor} from '../owl/to_ir';

import {ShaclNodeShape, ShaclPair, ShaclPropertyShape, ShaclShapes, ShaclValue} from './parse';

const SH = 'http://www.w3.org/ns/shacl#';

const SEVERITIES:
    Record<string, {severity: ConstraintSeverity; onViolation: ViolationEffect}> = {
      [`${SH}Violation`]: {severity: 'high', onViolation: 'reject'},
      [`${SH}Warning`]: {severity: 'medium', onViolation: 'warn'},
      [`${SH}Info`]: {severity: 'low', onViolation: 'warn'},
    };

/** A constraint derived from a shape, with the shape key it came from. */
export interface ShapeConstraint {
  shape: string;  // the provenance key (see shapeKey)
  constraint: Constraint;
}

/**
 * The provenance note that ends every generated description; `shape` is the
 * key re-imports match on. Exported so the merge (import.ts) reads it back
 * with the same format it was written with.
 */
export const PROVENANCE_PREFIX = '(From SHACL: ';
export function provenanceShape(description: string|undefined): string|undefined {
  if (!description) return undefined;
  const at = description.lastIndexOf(PROVENANCE_PREFIX);
  if (at < 0) return undefined;
  const rest = description.slice(at + PROVENANCE_PREFIX.length);
  const comma = rest.indexOf(',');
  return comma > 0 ? rest.slice(0, comma) : undefined;
}

/**
 * Derives the constraints the shapes state against `model`. `reservedNames`
 * are constraint names already taken in the model (and not being replaced); a
 * derived name that collides gets a `_2`, `_3`, ... suffix, deterministically.
 * Warnings are appended for every term that cannot be mapped.
 */
export function shaclConstraints(
    shapes: ShaclShapes, model: SemanticModel, reservedNames: Set<string>,
    warnings: string[]): {constraints: ShapeConstraint[]; shapeKeys: string[]} {
  const entitiesByName = new Map(model.entities.map(e => [e.name, e]));
  const relByName = new Map((model.relationships ?? []).map(r => [r.name, r]));
  const used = new Set(reservedNames);
  const out: ShapeConstraint[] = [];
  const shapeKeys: string[] = [];

  const lineage = (name: string): string[] => {
    const seen: string[] = [];
    const queue = [name];
    while (queue.length) {
      const n = queue.shift()!;
      if (seen.includes(n)) continue;
      seen.push(n);
      queue.push(...(entitiesByName.get(n)?.extends ?? []));
    }
    return seen;
  };
  const fieldOf = (entity: string, name: string) => {
    for (const n of lineage(entity)) {
      const f = entitiesByName.get(n)?.fields.find(x => x.name === name);
      if (f) return f;
    }
    return undefined;
  };

  const emit = (
      shape: string, ps: ShaclPropertyShape, rule: Rule, terms: string,
      where: string) => {
    let name = sanitize(rule.name);
    const base = name;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    const facets = facetsOf(ps.severity, where, warnings);
    const text = ps.message ?? ps.description ?? rule.description;
    const path = ps.path ? localName(ps.path) : '';
    out.push({
      shape,
      constraint: {
        name,
        judgment: rule.judgment,
        description: `${text} ${PROVENANCE_PREFIX}${shape}, ${path} ${terms}.)`,
        onViolation: facets.onViolation,
        severity: facets.severity,
      },
    });
  };

  const apply = (shape: string, targets: string[], ps: ShaclPropertyShape) => {
    const psLabel = ps.name ?? (ps.path ? localName(ps.path) : '[anonymous]');
    for (const target of targets) {
      const C = localName(target);
      const where = `shape '${shape}' property '${psLabel}' on '${C}'`;
      if (!entitiesByName.has(C)) {
        warnings.push(`${where}: '${C}' is not an entity in the model; skipped.`);
        continue;
      }
      if (ps.deactivated) continue;
      if (ps.pathProblem) {
        warnings.push(`${where}: ${ps.pathProblem}, which does not name one ` +
                      `relationship or field; skipped.`);
        continue;
      }
      for (const t of ps.unsupported) {
        warnings.push(`${where}: sh:${t} is not supported; ignored.`);
      }
      const p = localName(ps.path!);
      const rel = relByName.get(p);
      if (rel && lineage(C).includes(rel.source.entity)) {
        for (const [rule, terms] of relationshipRules(C, rel, ps, entitiesByName,
                                                      where, warnings)) {
          emit(shape, ps, rule, terms, where);
        }
        continue;
      }
      const field = fieldOf(C, p);
      if (field) {
        for (const [rule, terms] of fieldRules(C, p, field.type, ps, where,
                                               warnings)) {
          emit(shape, ps, rule, terms, where);
        }
        for (const [rule, terms] of pairRules(
                 C, p, field.type, ps.pairs, g => fieldOf(C, g),
                 g => relByName.has(g), where, warnings)) {
          emit(shape, ps, rule, terms, where);
        }
        continue;
      }
      warnings.push(
          rel ? `${where}: relationship '${p}' starts at '${
                    rel.source.entity}', not at '${C}' or one of its ` +
                  `supertypes; skipped.` :
                `${where}: '${p}' is neither a relationship nor a field of ` +
                  `'${C}' (or its supertypes) in the model; skipped.`);
    }
  };

  for (const ns of shapes.nodeShapes) {
    const shape = shapeKey(ns);
    shapeKeys.push(shape);
    if (ns.deactivated) continue;
    for (const t of ns.otherTargets) {
      warnings.push(`shape '${shape}': sh:${t} targets individual nodes, ` +
                    `which the model does not hold; only sh:targetClass is ` +
                    `supported; ignored.`);
    }
    for (const t of ns.unsupported) {
      warnings.push(`shape '${shape}': node-level sh:${t} is not supported; ` +
                    `ignored.`);
    }
    if (!ns.targetClasses.length) {
      // (A shape with only node targets was already warned above.)
      if (ns.properties.length && !ns.otherTargets.length) {
        warnings.push(`shape '${shape}' has no sh:targetClass (and is not ` +
                      `itself a class), so its rules apply to nothing; ` +
                      `skipped.`);
      }
      continue;
    }
    for (const ps of ns.properties) apply(shape, ns.targetClasses, ps);
  }
  for (const ps of shapes.standaloneProperties) {
    const shape = ps.name ?? `[anonymous property shape]`;
    shapeKeys.push(shape);
    apply(shape, ps.targetClasses, ps);
  }
  return {constraints: out, shapeKeys: [...new Set(shapeKeys)]};
}

// A node shape's provenance key: its local name, or -- for a blank-node shape,
// whose parser id is not stable across runs -- the classes it targets.
function shapeKey(ns: ShaclNodeShape): string {
  if (ns.name) return ns.name;
  const targets = ns.targetClasses.map(localName).join('+');
  return targets ? `[anonymous shape for ${targets}]` : '[anonymous shape]';
}

function facetsOf(severity: string|undefined, where: string, warnings: string[]):
    {severity: ConstraintSeverity; onViolation: ViolationEffect} {
  if (severity === undefined) return SEVERITIES[`${SH}Violation`];
  const f = SEVERITIES[severity];
  if (f) return f;
  warnings.push(`${where}: sh:severity '${localName(severity)}' is not ` +
                `sh:Violation, sh:Warning or sh:Info; treated as sh:Violation.`);
  return SEVERITIES[`${SH}Violation`];
}

// --- Rules. -------------------------------------------------------------------

interface Rule {
  name: string;
  judgment: string;
  description: string;
}

function relationshipRules(
    C: string, rel: Relationship, ps: ShaclPropertyShape,
    entitiesByName: Map<string, Entity>, where: string,
    warnings: string[]): [Rule, string][] {
  const p = rel.name;
  const dest = rel.destination.entity;
  const out: [Rule, string][] = [];
  const valueTerms = ['datatype', 'pattern', 'in', 'minInclusive',
                      'maxInclusive', 'minExclusive', 'maxExclusive',
                      'minLength', 'maxLength'].filter(t => (ps as any)[t] !== undefined);
  if (valueTerms.length) {
    warnings.push(`${where}: ${valueTerms.map(t => `sh:${t}`).join(', ')} ` +
                  `constrain a value, but '${p}' is a relationship; ignored.`);
  }
  if (ps.node) {
    warnings.push(`${where}: sh:node '${localName(ps.node)}' (a nested ` +
                  `shape) is not supported; ignored.`);
  }
  const pairTerms = [...new Set(ps.pairs.map(x => `sh:${x.term}`))];
  if (pairTerms.length) {
    warnings.push(`${where}: ${pairTerms.join(', ')} compare field values, ` +
                  `but '${p}' is a relationship; ignored.`);
  }
  out.push(...countRules(C, p, dest, undefined, ps.minCount, ps.maxCount));
  for (const cls of ps.classes) {
    const X = localName(cls);
    if (X === dest) continue;  // an edge always ends at its destination
    if (!entitiesByName.has(X)) {
      warnings.push(`${where}: sh:class '${X}' is not an entity in the ` +
                    `model; skipped.`);
      continue;
    }
    out.push([{
      name: `${C}_${p}_only_${X}`,
      judgment: `Every ${p} relationship from ${article(C)} ${C} leads to ${
          article(X)} ${X}. ${cap(article(C))} ${C} with a ${p} relationship ` +
          `to anything other than ${article(X)} ${X} does not satisfy this rule.`,
      description: `Link ${article(C)} ${C} through ${p} only to ${
          article(X)} ${X}.`,
    }, `sh:class ${X}`]);
  }
  const q = ps.qualified;
  if (q) {
    if (q.problem) {
      warnings.push(`${where}: ${q.problem}; skipped.`);
    } else {
      const X = localName(q.class!);
      if (!entitiesByName.has(X)) {
        warnings.push(`${where}: qualified sh:class '${X}' is not an entity ` +
                      `in the model; skipped.`);
      } else {
        // A qualifier equal to the destination counts every edge, so it is the
        // plain count (and named like one).
        out.push(...countRules(C, p, X, X === dest ? undefined : X, q.min,
                               q.max, /*qualified=*/true));
      }
    }
  }
  return out;
}

// The cardinality rules for `min`/`max` edges from C through p to `target`;
// `qualifier` (a qualifying class narrower than p's destination) suffixes the
// name; `qualified` says the counts came from sh:qualifiedMin/MaxCount.
function countRules(
    C: string, p: string, target: string, qualifier: string|undefined,
    min: number|undefined, max: number|undefined,
    qualified = false): [Rule, string][] {
  const q = qualifier ? `_${qualifier}` : '';
  const pre = qualified ? 'sh:qualifiedMinCount' : 'sh:minCount';
  const preMax = qualified ? 'sh:qualifiedMaxCount' : 'sh:maxCount';
  const onClass = qualified ? ` sh:class ${target}` : '';
  const aC = cap(article(C));
  const toX = `to ${article(target)} ${target}`;
  const out: [Rule, string][] = [];
  if (min !== undefined && max !== undefined && min === max) {
    const n = min;
    out.push([
      n === 0 ? {
        name: `${C}_${p}_exactly_0${q}`,
        judgment: `No ${C} has a ${p} relationship ${toX}. ${aC} ${C} with ` +
            `one does not satisfy this rule.`,
        description: `Do not link ${article(C)} ${C} to ${article(target)} ${
            target} through ${p}.`,
      } :
               {
                 name: `${C}_${p}_exactly_${n}${q}`,
                 judgment: `Each ${C} has exactly ${count(n)} ${p} ${
                     rels(n)} ${toX}. ` +
                     (n === 1 ?
                          `${aC} ${C} with no ${p} relationship ${
                              toX}, or with more than one, does not satisfy ` +
                              `this rule.` :
                          `${aC} ${C} with fewer or more than ${
                              count(n)} does not satisfy this rule.`),
                 description: `Link each ${C} to exactly ${count(n)} ${
                     target} through ${p}.`,
               },
      `${pre} ${n} ${preMax} ${n}${onClass}`,
    ]);
    return out;
  }
  if (min !== undefined && min > 0) {
    out.push([{
      name: `${C}_${p}_min_${min}${q}`,
      judgment: `Each ${C} has at least ${count(min)} ${p} ${rels(min)} ${
          toX}. ${aC} ${C} with ${
          min === 1 ? `no ${p} relationship ${toX}` :
                      `fewer than ${count(min)}`} does not satisfy this rule.`,
      description: `Link each ${C} to at least ${count(min)} ${target} ` +
          `through ${p}.`,
    }, `${pre} ${min}${onClass}`]);
  }
  if (max !== undefined) {
    out.push([
      max === 0 ? {
        name: `${C}_${p}_max_0${q}`,
        judgment: `No ${C} has a ${p} relationship ${toX}. ${aC} ${C} with ` +
            `one does not satisfy this rule.`,
        description: `Do not link ${article(C)} ${C} to ${article(target)} ${
            target} through ${p}.`,
      } :
                  {
                    name: `${C}_${p}_max_${max}${q}`,
                    judgment: `Each ${C} has at most ${count(max)} ${p} ${
                        rels(max)} ${toX}. ${aC} ${C} with more than ${
                        count(max)} does not satisfy this rule.`,
                    description: `Link each ${C} to at most ${count(max)} ${
                        target} through ${p}.`,
                  },
      `${preMax} ${max}${onClass}`,
    ]);
  }
  return out;
}

function fieldRules(
    C: string, f: string, type: DataType|undefined, ps: ShaclPropertyShape,
    where: string, warnings: string[]): [Rule, string][] {
  const ref = `${C}.${f}`;
  const aC = cap(article(C));
  const out: [Rule, string][] = [];
  if (ps.classes.length || ps.qualified || ps.node) {
    warnings.push(`${where}: sh:class / sh:qualifiedValueShape / sh:node ` +
                  `constrain a linked node, but '${f}' is a field; ignored.`);
  }
  if (ps.minCount !== undefined && ps.minCount > 0) {
    if (ps.minCount === 1) {
      out.push([{
        name: `${C}_${f}_required`,
        judgment: `Every ${C} has a value for ${ref}. ${aC} ${C} whose ${
            ref} is null or missing does not satisfy this rule.`,
        description: `Set ${ref} on every ${C}.`,
      }, `sh:minCount 1`]);
    } else {
      warnings.push(`${where}: '${f}' is a field, which holds one value, so ` +
                    `sh:minCount ${ps.minCount} cannot be met; skipped.`);
    }
  }
  if (ps.maxCount === 0) {
    out.push([{
      name: `${C}_${f}_empty`,
      judgment: `No ${C} has a value for ${ref}. ${aC} ${C} with any ${
          ref} does not satisfy this rule.`,
      description: `Leave ${ref} empty.`,
    }, `sh:maxCount 0`]);
  }
  if (ps.datatype !== undefined) {
    const dt = datatypeFor(ps.datatype);
    if (type && dt !== 'Opaque' && dt !== type) {
      warnings.push(`${where}: sh:datatype ${localName(ps.datatype)} (${
          dt}) conflicts with ${ref}'s datatype ${type}; the model's ` +
                    `datatype stands.`);
    }
  }
  if (ps.pattern !== undefined) {
    const flags = ps.flags ? ` (regular-expression flags: ${ps.flags})` : '';
    out.push([{
      name: `${C}_${f}_pattern`,
      judgment: `Every ${ref} that is set matches the regular expression ${
          quote(ps.pattern)}${flags}. ${aC} ${C} whose ${
          ref} does not match it does not satisfy this rule.`,
      description: `Make ${ref} match ${quote(ps.pattern)}.`,
    }, `sh:pattern ${quote(ps.pattern)}${ps.flags ? ` sh:flags ${quote(ps.flags)}` : ''}`]);
  }
  if (ps.in) {
    const values = ps.in.map(valueText);
    if (values.length === 1) {
      out.push([{
        name: `${C}_${f}_value_${values[0]}`,
        judgment: `Every ${C} has ${ref} equal to ${quote(values[0])}. ${aC} ${
            C} with any other ${ref} does not satisfy this rule.`,
        description: `Set ${ref} to ${quote(values[0])}.`,
      }, `sh:in (${values.join(' ')})`]);
    } else if (values.length > 1) {
      const list = orList(values.map(quote));
      out.push([{
        name: `${C}_${f}_in`,
        judgment: `Every ${ref} that is set is one of ${list}. ${aC} ${
            C} with any other ${ref} does not satisfy this rule.`,
        description: `Set ${ref} to one of ${list}.`,
      }, `sh:in (${values.join(' ')})`]);
    }
  }
  const bounds: [string|undefined, string, string][] = [
    [ps.minInclusive, 'at least', 'sh:minInclusive'],
    [ps.minExclusive, 'greater than', 'sh:minExclusive'],
    [ps.maxInclusive, 'at most', 'sh:maxInclusive'],
    [ps.maxExclusive, 'less than', 'sh:maxExclusive'],
  ];
  const range = bounds.filter(([v]) => v !== undefined);
  if (range.length) {
    const phrase = range.map(([v, words]) => `${words} ${v}`).join(' and ');
    out.push([{
      name: `${C}_${f}_range`,
      judgment: `Every ${ref} that is set is ${phrase}. ${aC} ${C} whose ${
          ref} is outside that range does not satisfy this rule.`,
      description: `Keep ${ref} ${phrase}.`,
    }, range.map(([v, , term]) => `${term} ${v}`).join(' ')]);
  }
  if (ps.minLength !== undefined || ps.maxLength !== undefined) {
    const parts = [
      ps.minLength !== undefined ? `at least ${ps.minLength}` : '',
      ps.maxLength !== undefined ? `at most ${ps.maxLength}` : '',
    ].filter(Boolean).join(' and ');
    out.push([{
      name: `${C}_${f}_length`,
      judgment: `Every ${ref} that is set is ${parts} characters long. ${aC} ${
          C} whose ${ref} is shorter or longer does not satisfy this rule.`,
      description: `Keep ${ref} ${parts} characters long.`,
    }, [
      ps.minLength !== undefined ? `sh:minLength ${ps.minLength}` : '',
      ps.maxLength !== undefined ? `sh:maxLength ${ps.maxLength}` : '',
    ].filter(Boolean).join(' ')]);
  }
  return out;
}

// The property-pair rules comparing field f of C with other fields of C (or of
// its supertypes). `fieldOf` resolves a field through C's lineage;
// `isRelationship` tells a relationship name apart, for a precise warning.
//
// SHACL compares value SETS; a field holds at most one value, so the pairs read
// as their row-level meaning: an ordering compares the two values when both are
// set (an unset one leaves no pair to compare, so the rule holds), sh:equals
// requires the same value or both unset, sh:disjoint forbids the same value.
function pairRules(
    C: string, f: string, type: DataType|undefined, pairs: ShaclPair[],
    fieldOf: (name: string) => {type?: DataType}|undefined,
    isRelationship: (name: string) => boolean, where: string,
    warnings: string[]): [Rule, string][] {
  const out: [Rule, string][] = [];
  const aC = cap(article(C));
  const ref = `${C}.${f}`;
  for (const pair of pairs) {
    const term = `sh:${pair.term}`;
    if (pair.problem) {
      warnings.push(`${where}: ${pair.problem}; skipped.`);
      continue;
    }
    const g = localName(pair.other!);
    const other = fieldOf(g);
    if (!other) {
      warnings.push(
          isRelationship(g) ?
              `${where}: ${term} '${g}' is a relationship, but ${
                  term} compares ${f} with another field of '${C}'; skipped.` :
              `${where}: ${term} '${g}' is not a field of '${C}' (or its ` +
                  `supertypes); skipped.`);
      continue;
    }
    if (g === f) {
      warnings.push(`${where}: ${term} compares '${f}' with itself; skipped.`);
      continue;
    }
    if (!comparable(type, other.type)) {
      // Values of unrelated datatypes are never equal and never ordered: an
      // ordering or sh:equals would fail every row that sets them, and
      // sh:disjoint always holds (structurally guaranteed: dropped silently).
      if (pair.term !== 'disjoint') {
        warnings.push(`${where}: ${term} compares ${ref} (${type}) with ${C}.${
            g} (${other.type}), whose values never compare; skipped.`);
      }
      continue;
    }
    const refG = `${C}.${g}`;
    const bothSet = 'The rule compares the two only when both are set.';
    const rule: Rule = {
      lessThan: {
        name: `${C}_${f}_lt_${g}`,
        judgment: `Each ${C}'s ${f} must be less than its ${g}. ${aC} ${
            C} whose ${ref} is greater than or equal to its ${
            refG} does not satisfy this rule. ${bothSet}`,
        description: `Keep ${ref} below ${refG}.`,
      },
      lessThanOrEquals: {
        name: `${C}_${f}_lte_${g}`,
        judgment: `Each ${C}'s ${f} must be less than or equal to its ${g}. ${
            aC} ${C} whose ${ref} is greater than its ${
            refG} does not satisfy this rule. ${bothSet}`,
        description: `Keep ${ref} at most ${refG}.`,
      },
      equals: {
        name: `${C}_${f}_eq_${g}`,
        judgment: `Each ${C}'s ${f} must be equal to its ${g}. ${aC} ${
            C} whose ${ref} and ${refG} differ, or that sets only one of ` +
            `them, does not satisfy this rule.`,
        description: `Set ${ref} equal to ${refG}.`,
      },
      disjoint: {
        name: `${C}_${f}_disjoint_${g}`,
        judgment: `Each ${C}'s ${f} must differ from its ${g}. ${aC} ${
            C} whose ${ref} and ${refG} hold the same value does not ` +
            `satisfy this rule.`,
        description: `Keep ${ref} different from ${refG}.`,
      },
    }[pair.term];
    out.push([rule, `${term} ${g}`]);
  }
  return out;
}

const NUMERIC_TYPES: ReadonlySet<DataType> = new Set(['Integer', 'Decimal', 'Float']);

// Whether values of two field datatypes can be equal or ordered. An unknown or
// Opaque datatype is not guessed at: the pair is kept.
function comparable(a: DataType|undefined, b: DataType|undefined): boolean {
  if (!a || !b || a === 'Opaque' || b === 'Opaque' || a === b) return true;
  return NUMERIC_TYPES.has(a) && NUMERIC_TYPES.has(b);
}

// --- Helpers. -------------------------------------------------------------------

// An sh:in member as prose: a literal's lexical form, an IRI's local name.
function valueText(v: ShaclValue): string {
  return v.iri ? localName(v.value) : v.value;
}

// A constraint name is a KC entry-id segment: letters, digits, underscore.
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
      .slice(0, 120);
}

const COUNT_WORDS =
    ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
     'nine', 'ten'];
function count(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}
function rels(n: number): string {
  return n === 1 ? 'relationship' : 'relationships';
}
function article(word: string): string {
  // An all-caps acronym is read letter by letter ("an MSA", "a KPI").
  if (/^[A-Z]{2,}$/.test(word)) return /^[AEFHILMNORSX]/.test(word) ? 'an' : 'a';
  return /^[AEIOU]/i.test(word) ? 'an' : 'a';
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function quote(v: string): string {
  return `'${v}'`;
}
function orList(items: string[]): string {
  if (items.length <= 2) return items.join(' or ');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}
