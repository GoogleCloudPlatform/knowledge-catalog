// OWL axioms -> semantic-model constraints.
//
// An ontology states rules about its terms that a semantic model can carry
// NATIVELY as model-level constraints (see ir.ts Constraint and
// docs/semantic-model/actions.md, "Constraints"): a judged rule with a name,
// the rule in words (`judgment`), the error text a violation surfaces
// (`description`), what a violation does (`on_violation`), and how grave it is
// (`severity`). Knowledge Catalog publishes each one as a governed entry an
// agent reads, and an action that lists it in `guards` is refused when its
// attempted write breaks it -- so an imported axiom has a real downstream
// effect rather than riding along as an opaque note.
//
// The axioms mapped here, each onto one constraint:
//
//   C rdfs:subClassOf / owl:equivalentClass [ owl:Restriction ... ]
//   (bare, or a conjunct of an owl:intersectionOf there -- C ≡ D ⊓ R entails
//   C ⊑ R, so the Protégé defined-class shape yields the same constraint)
//     on an object property (a relationship of C or a supertype of C):
//       owl:cardinality / qualifiedCardinality N    -> C_p_exactly_N
//       owl:minCardinality / minQualifiedCardinality -> C_p_min_N
//       owl:maxCardinality / maxQualifiedCardinality -> C_p_max_N
//       owl:someValuesFrom X                         -> C_p_some_X
//       owl:allValuesFrom X                          -> C_p_only_X
//       owl:hasValue v                               -> C_p_value_v
//     on a relationship's INVERSE name (`inverse:`, from owl:inverseOf): the
//       same kinds and names, stated against the forward edge read backwards
//       (C is its destination; "linked from X via fwd") -- see inverseRule
//     on a datatype property (a field of C or a supertype of C):
//       min/exact 1, someValuesFrom                  -> C_p_required
//       max/exact 0                                  -> C_p_empty
//       owl:hasValue v                               -> C_p_value_v
//   p a owl:FunctionalProperty (object property)     -> D_p_functional
//   A owl:disjointWith B                             -> A_disjoint_B
//   [] a owl:AllDisjointClasses ; owl:members (...)  -> A_B_..._disjoint
//
// What is deliberately NOT a constraint, because the semantic model already
// guarantees it structurally (a field is a single scalar column; an edge always
// ends at its declared destination entity):
//   - a datatype max N >= 1, a datatype allValuesFrom, a FunctionalProperty on
//     a datatype property (a field holds at most one value by construction);
//   - an object allValuesFrom whose filler IS the relationship's destination;
//   - min 0 (trivially true).
// These are dropped silently, like every other construct with no downstream
// effect. A restriction that cannot be resolved against the model (an
// anonymous filler, a property that is neither a relationship nor a field of
// the class, a datatype minimum above one) is warned and skipped -- never
// carried opaquely.
//
// Enforcement facets. OWL says WHAT must hold, never how much it matters or
// what to do about a violation, so both come from the optional kcmd annotation
// vocabulary (parse.ts KCMD_NS): `kcmd:onViolation` ("reject" | "escalate" |
// "warn") and `kcmd:severity` ("critical" | "high" | "medium" | "low"). Either
// may sit on the restriction node, the class, or the property; the most
// specific wins per facet (restriction > class > property). `on_violation` is
// required by the model, so absent an annotation it defaults to `warn` -- an
// imported rule informs until someone decides it should block. `severity`
// carries no default, matching the IR ("an author who did not say has not
// said").

import {Constraint, CONSTRAINT_SEVERITIES, ConstraintSeverity, Entity, Relationship, VIOLATION_EFFECTS, ViolationEffect,} from '../../ir';

import {OwlClass, OwlConstraintPolicy, OwlModel, OwlRestriction} from './model';
import {localName} from './parse';

const OWL_THING = 'http://www.w3.org/2002/07/owl#Thing';

// What the constraint derivation needs from the mapped model.
export interface ConstraintContext {
  entitiesByName: Map<string, Entity>;
  relationships: Relationship[];
}

/**
 * Derives the model-level constraints an ontology's axioms state (see the file
 * comment for the mapping). Appends a warning for each axiom it cannot resolve
 * against the mapped model. Order is deterministic: each class's restrictions
 * in class order, then functional properties, then pairwise disjointness, then
 * AllDisjointClasses sets.
 */
export function owlConstraints(
    owl: OwlModel, ctx: ConstraintContext, warnings: string[]): Constraint[] {
  const out: Constraint[] = [];
  const usedNames = new Set<string>();
  const relByName = new Map(ctx.relationships.map(r => [r.name, r]));
  // Relationships by their inverse name (`inverse:`), so a restriction
  // phrased through the inverse resolves to the forward edge.
  const inverseByName = new Map(
      ctx.relationships.filter(r => r.inverse).map(r => [r.inverse!, r]));
  const propertyPolicy = new Map<string, OwlConstraintPolicy|undefined>();
  for (const p of [...owl.datatypeProperties, ...owl.objectProperties]) {
    if (!propertyPolicy.has(p.localName)) {
      propertyPolicy.set(p.localName, p.constraintPolicy);
    }
  }
  const classByName = new Map<string, OwlClass>();
  for (const c of owl.classes) {
    if (!classByName.has(c.localName)) classByName.set(c.localName, c);
  }
  // `Entity|relationship` pairs already bounded to at most one by a
  // restriction, so a FunctionalProperty on the same edge is not restated.
  const atMostOne = new Set<string>();

  const add = (
      baseName: string, judgment: string, description: string,
      policies: (OwlConstraintPolicy|undefined)[], where: string) => {
    let name = sanitize(baseName);
    for (let i = 2; usedNames.has(name); i++) name = `${sanitize(baseName)}_${i}`;
    usedNames.add(name);
    const {onViolation, severity} = resolvePolicy(policies, where, warnings);
    const c: Constraint = {name, judgment, description, onViolation};
    if (severity) c.severity = severity;
    out.push(c);
  };

  // --- Class restrictions. -------------------------------------------------
  for (const c of owl.classes) {
    const entity = ctx.entitiesByName.get(c.localName);
    if (!entity || classByName.get(c.localName) !== c) continue;
    for (const r of c.restrictions) {
      const prop = localName(r.property);
      const axiom = manchester(c.localName, r);
      const where = `restriction '${axiom}'`;
      if (r.anonymousFiller) {
        warnings.push(
            `${where}: the filler is an anonymous class expression, which ` +
            `has no name to state a rule about; skipped.`);
        continue;
      }
      const policies = [
        r.policy, c.constraintPolicy, propertyPolicy.get(prop),
      ];
      const rel = relByName.get(prop);
      if (rel) {
        const derived = relationshipRule(c.localName, rel, r, ctx, where, warnings);
        if (!derived) continue;
        if (derived.atMostOne) atMostOne.add(`${rel.source.entity}|${prop}`);
        add(derived.name, derived.judgment,
            withProvenance(r.comment ?? derived.description, axiom), policies,
            where);
        continue;
      }
      // A restriction may name a relationship's INVERSE -- an owl:inverseOf
      // property the importer folded into `inverse:` on its forward edge
      // rather than emitting as a second relationship (see to_ir
      // planInverseFolds). It constrains the same edge read backwards: C is
      // the edge's DESTINATION and the filler its source.
      const inv = inverseByName.get(prop);
      if (inv) {
        const derived = inverseRule(c.localName, inv, r, ctx, where, warnings);
        if (!derived) continue;
        add(derived.name, derived.judgment,
            withProvenance(r.comment ?? derived.description, axiom), policies,
            where);
        continue;
      }
      if (fieldOf(entity, prop, ctx)) {
        const derived = fieldRule(c.localName, prop, r, where, warnings);
        if (!derived) continue;
        add(derived.name, derived.judgment,
            withProvenance(r.comment ?? derived.description, axiom), policies,
            where);
        continue;
      }
      warnings.push(
          `${where}: '${prop}' is neither a relationship (or a relationship's ` +
          `inverse) nor a field of '${c.localName}' (or its supertypes) in ` +
          `the imported model; skipped.`);
    }
  }

  // --- Functional object properties. --------------------------------------
  for (const p of owl.objectProperties) {
    if (!p.functional) continue;
    const rel = relByName.get(p.localName);
    if (!rel) continue;  // not converted (already warned)
    const from = rel.source.entity;
    if (atMostOne.has(`${from}|${p.localName}`)) continue;
    add(`${from}_${p.localName}_functional`,
        `Each ${from} has at most one ${p.localName} relationship. ` +
            `${cap(article(from))} ${from} with more than one does not ` +
            `satisfy this rule.`,
        withProvenance(
            `Link each ${from} to at most one ${rel.destination.entity} ` +
                `through ${p.localName}.`,
            `${p.localName} is a FunctionalProperty`),
        [p.constraintPolicy], `functional property '${p.localName}'`);
  }

  // --- Disjoint classes. ---------------------------------------------------
  const inSameSet = (a: string, b: string) => owl.allDisjointClassesAxioms.some(
      ax => ax.members.map(localName).includes(a) &&
          ax.members.map(localName).includes(b));
  const seenPairs = new Set<string>();
  for (const c of owl.classes) {
    if (classByName.get(c.localName) !== c) continue;
    for (const iri of c.disjointWith) {
      const a = c.localName;
      const b = localName(iri);
      const key = [a, b].sort().join('|');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const axiom = `${a} DisjointWith ${b}`;
      if (!ctx.entitiesByName.has(a) || !ctx.entitiesByName.has(b)) {
        warnings.push(
            `'${axiom}': '${b}' is not a class in the imported model; ` +
            `skipped.`);
        continue;
      }
      if (inSameSet(a, b)) continue;  // stated by the AllDisjointClasses set
      add(`${a}_disjoint_${b}`,
          `No ${a} is also ${article(b)} ${b}. An instance that is both ` +
              `${article(a)} ${a} and ${article(b)} ${b} does not satisfy ` +
              `this rule.`,
          withProvenance(
              `Classify it as ${article(a)} ${a} or ${article(b)} ${b}, not ` +
                  `both.`,
              axiom),
          [c.constraintPolicy, classByName.get(b)?.constraintPolicy],
          `'${axiom}'`);
    }
  }

  for (const ax of owl.allDisjointClassesAxioms) {
    const names = [...new Set(ax.members.map(localName))];
    const axiom = `DisjointClasses(${names.join(' ')})`;
    const unknown = names.filter(n => !ctx.entitiesByName.has(n));
    const known = names.filter(n => ctx.entitiesByName.has(n));
    if (unknown.length) {
      warnings.push(
          `'${axiom}': ${unknown.map(n => `'${n}'`).join(', ')} ${
              unknown.length > 1 ? 'are' : 'is'} not a class in the imported ` +
          `model; ${known.length >= 2 ? 'left out of the rule' : 'skipped'}.`);
    }
    if (known.length < 2) continue;
    const list = listPhrase(known);
    add(`${known.join('_')}_disjoint`,
        `No instance is more than one of ${list}. An instance classified as ` +
            `two or more of them does not satisfy this rule.`,
        withProvenance(
            ax.comment ?? `Classify it as at most one of ${list}.`, axiom),
        [ax.policy], `'${axiom}'`);
  }

  return out;
}

// --- Relationship restrictions. ----------------------------------------------

interface DerivedRule {
  name: string;
  judgment: string;
  description: string;
  atMostOne?: boolean;
}

function relationshipRule(
    cls: string, rel: Relationship, r: OwlRestriction, ctx: ConstraintContext,
    where: string, warnings: string[]): DerivedRule|undefined {
  const p = rel.name;
  // The edge must start at the class or at one of its supertypes (whose edges
  // the class inherits): a rule about C's `p` edges is unsatisfiable when `p`
  // never leaves a C.
  if (!lineage(cls, ctx).includes(rel.source.entity)) {
    warnings.push(
        `${where}: relationship '${p}' starts at '${rel.source.entity}', not ` +
        `at '${cls}' or one of its supertypes; skipped.`);
    return undefined;
  }
  let target = rel.destination.entity;
  let fillerName: string|undefined;
  if (r.filler && r.filler !== OWL_THING) {
    fillerName = localName(r.filler);
    if (!ctx.entitiesByName.has(fillerName)) {
      warnings.push(
          `${where}: '${fillerName}' is not a class in the imported model; ` +
          `skipped.`);
      return undefined;
    }
    target = fillerName;
  }
  const C = cls;
  const aC = cap(article(C));
  const toX = `to ${article(target)} ${target}`;
  const n = r.cardinality ?? 0;
  // A bound qualified by the edge's own destination counts every `p` edge, so
  // it restates a FunctionalProperty on the same edge (see atMostOne).
  const boundsAllEdges = !fillerName || fillerName === rel.destination.entity;
  switch (r.kind) {
    case 'exact':
      if (n === 0) return noneRule();
      return {
        name: `${C}_${p}_exactly_${n}`,
        judgment: `Each ${C} has exactly ${count(n)} ${p} ${rels(n)} ${toX}. ` +
            (n === 1 ?
                 `${aC} ${C} with no ${p} relationship ${toX}, or with more ` +
                     `than one, does not satisfy this rule.` :
                 `${aC} ${C} with fewer or more than ${count(n)} does not ` +
                     `satisfy this rule.`),
        description: `Link each ${C} to exactly ${count(n)} ${target} ` +
            `through ${p}.`,
        atMostOne: n === 1 && boundsAllEdges,
      };
    case 'min':
    case 'some':
      if (r.kind === 'min' && n === 0) return undefined;  // trivially true
      {
        const m = r.kind === 'some' ? 1 : n;
        const suffix = r.kind === 'some' ?
            (fillerName ? `some_${fillerName}` : 'some') :
            `min_${m}`;
        return {
          name: `${C}_${p}_${suffix}`,
          judgment: `Each ${C} has at least ${count(m)} ${p} ${rels(m)} ` +
              `${toX}. ${aC} ${C} with ${
                  m === 1 ? `no ${p} relationship ${toX}` :
                            `fewer than ${count(m)}`} does not satisfy this ` +
              `rule.`,
          description: `Link each ${C} to at least ${count(m)} ${target} ` +
              `through ${p}.`,
        };
      }
    case 'max':
      if (n === 0) return noneRule();
      return {
        name: `${C}_${p}_max_${n}`,
        judgment: `Each ${C} has at most ${count(n)} ${p} ${rels(n)} ${toX}. ` +
            `${aC} ${C} with more than ${count(n)} does not satisfy this rule.`,
        description: `Link each ${C} to at most ${count(n)} ${target} ` +
            `through ${p}.`,
        atMostOne: n === 1 && boundsAllEdges,
      };
    case 'all':
      // An edge always ends at its declared destination: restating that is no
      // rule.
      if (!fillerName || fillerName === rel.destination.entity) return undefined;
      return {
        name: `${C}_${p}_only_${fillerName}`,
        judgment: `Every ${p} relationship from ${article(C)} ${C} leads ${
            toX}. ${aC} ${C} with a ${p} relationship to anything other than ${
            article(target)} ${target} does not satisfy this rule.`,
        description: `Link ${article(C)} ${C} through ${p} only to ${
            article(target)} ${target}.`,
      };
    case 'value':
      return {
        name: `${C}_${p}_value_${r.value}`,
        judgment: `Each ${C} has a ${p} relationship to ${
            quote(r.value)}. ${aC} ${C} without it does not satisfy this rule.`,
        description: `Link each ${C} to ${quote(r.value)} through ${p}.`,
      };
    default:
      return undefined;
  }

  function noneRule(): DerivedRule {
    return {
      name: `${C}_${p}_${r.kind === 'max' ? 'max' : 'exactly'}_0`,
      judgment: `No ${C} has a ${p} relationship ${toX}. ${aC} ${C} with ` +
          `one does not satisfy this rule.`,
      description: `Do not link ${article(C)} ${C} to ${article(target)} ${
          target} through ${p}.`,
    };
  }
}

// --- Restrictions through an inverse name. ------------------------------------

// A restriction on `p` where `p` is the inverse of relationship `fwd`
// (`rel.inverse === p`): `C ⊑ ≤1 p.X` reads "each C is linked FROM at most one
// X through fwd". The edge is the same one -- only the direction the axiom
// reads it in differs -- so C must be the edge's destination (or a subtype of
// it) and the filler narrows its SOURCE. The constraint keeps the axiom's name
// (`C_p_max_1`), and its text names the forward relationship, which is what
// the model and the graph carry, with the inverse reading in parentheses.
// Mirrors relationshipRule case by case; a FunctionalProperty on the forward
// edge bounds a different direction, so no atMostOne dedupe applies here.
function inverseRule(
    cls: string, rel: Relationship, r: OwlRestriction, ctx: ConstraintContext,
    where: string, warnings: string[]): DerivedRule|undefined {
  const p = rel.inverse!;
  const fwd = rel.name;
  if (!lineage(cls, ctx).includes(rel.destination.entity)) {
    warnings.push(
        `${where}: '${p}' is the inverse of relationship '${fwd}', which ends ` +
        `at '${rel.destination.entity}', not at '${cls}' or one of its ` +
        `supertypes; skipped.`);
    return undefined;
  }
  let source = rel.source.entity;
  let fillerName: string|undefined;
  if (r.filler && r.filler !== OWL_THING) {
    fillerName = localName(r.filler);
    if (!ctx.entitiesByName.has(fillerName)) {
      warnings.push(
          `${where}: '${fillerName}' is not a class in the imported model; ` +
          `skipped.`);
      return undefined;
    }
    source = fillerName;
  }
  const C = cls;
  const aC = cap(article(C));
  const via = `via ${fwd}`;
  const reading = `(${p} is ${fwd} read backwards)`;
  const n = r.cardinality ?? 0;
  const none = (): DerivedRule => ({
    name: `${C}_${p}_${r.kind === 'max' ? 'max' : 'exactly'}_0`,
    judgment: `No ${C} is linked from ${article(source)} ${source} ${via} ${
        reading}. ${aC} ${C} that is does not satisfy this rule.`,
    description: `Do not link ${article(C)} ${C} from ${article(source)} ${
        source} through ${fwd}.`,
  });
  switch (r.kind) {
    case 'exact':
      if (n === 0) return none();
      return {
        name: `${C}_${p}_exactly_${n}`,
        judgment: `Each ${C} is linked from exactly ${count(n)} ${source} ${
                      via} ${reading}. ` +
            (n === 1 ?
                 `${aC} ${C} linked from no ${source} ${via}, or from more ` +
                     `than one, does not satisfy this rule.` :
                 `${aC} ${C} linked from fewer or more than ${count(n)} does ` +
                     `not satisfy this rule.`),
        description: `Link each ${C} from exactly ${count(n)} ${source} ` +
            `through ${fwd}.`,
      };
    case 'min':
    case 'some':
      if (r.kind === 'min' && n === 0) return undefined;  // trivially true
      {
        const m = r.kind === 'some' ? 1 : n;
        const suffix = r.kind === 'some' ?
            (fillerName ? `some_${fillerName}` : 'some') :
            `min_${m}`;
        return {
          name: `${C}_${p}_${suffix}`,
          judgment: `Each ${C} is linked from at least ${count(m)} ${source} ${
                        via} ${reading}. ${aC} ${C} linked from ${
                        m === 1 ? `no ${source} ${via}` :
                                  `fewer than ${count(m)}`} does not satisfy ` +
              `this rule.`,
          description: `Link each ${C} from at least ${count(m)} ${source} ` +
              `through ${fwd}.`,
        };
      }
    case 'max':
      if (n === 0) return none();
      return {
        name: `${C}_${p}_max_${n}`,
        judgment: `Each ${C} is linked from at most ${count(n)} ${source} ${
                      via} ${reading}. ${aC} ${C} linked from more than ${
                      count(n)} does not satisfy this rule.`,
        description: `Link each ${C} from at most ${count(n)} ${source} ` +
            `through ${fwd}.`,
      };
    case 'all':
      // Every fwd edge already starts at its declared source: restating that
      // is no rule.
      if (!fillerName || fillerName === rel.source.entity) return undefined;
      return {
        name: `${C}_${p}_only_${fillerName}`,
        judgment: `Every ${fwd} relationship that reaches ${article(C)} ${
                      C} comes from ${article(source)} ${source} ${reading}. ${
                      aC} ${C} linked ${via} from anything other than ${
                      article(source)} ${source} does not satisfy this rule.`,
        description: `Link ${article(C)} ${C} only from ${article(source)} ${
            source} through ${fwd}.`,
      };
    case 'value':
      return {
        name: `${C}_${p}_value_${r.value}`,
        judgment: `Each ${C} is linked from ${quote(r.value)} ${via} ${
            reading}. ${aC} ${C} without that link does not satisfy this rule.`,
        description: `Link each ${C} from ${quote(r.value)} through ${fwd}.`,
      };
    default:
      return undefined;
  }
}

// --- Datatype (field) restrictions. ------------------------------------------

function fieldRule(
    cls: string, prop: string, r: OwlRestriction, where: string,
    warnings: string[]): DerivedRule|undefined {
  const f = `${cls}.${prop}`;
  const aC = cap(article(cls));
  const n = r.cardinality ?? 0;
  const required = (): DerivedRule => ({
    name: `${cls}_${prop}_required`,
    judgment: `Every ${cls} has a value for ${f}. ${aC} ${cls} whose ${
        f} is null or missing does not satisfy this rule.`,
    description: `Set ${f} on every ${cls}.`,
  });
  const empty = (): DerivedRule => ({
    name: `${cls}_${prop}_empty`,
    judgment: `No ${cls} has a value for ${f}. ${aC} ${cls} with any ${
        f} does not satisfy this rule.`,
    description: `Leave ${f} empty.`,
  });
  switch (r.kind) {
    case 'some':
      return required();
    case 'min':
    case 'exact':
      if (r.kind === 'exact' && n === 0) return empty();
      if (n === 0) return undefined;  // min 0: trivially true
      if (n === 1) return required();
      warnings.push(
          `${where}: '${prop}' is a field, which holds one value, so a ` +
          `minimum of ${n} cannot be met; skipped.`);
      return undefined;
    case 'max':
      // At most N >= 1 values: a single-valued field satisfies it by
      // construction.
      return n === 0 ? empty() : undefined;
    case 'all':
      return undefined;  // the field's datatype already states it
    case 'value':
      return {
        name: `${cls}_${prop}_value_${r.value}`,
        judgment: `Every ${cls} has ${f} equal to ${quote(r.value)}. ${aC} ${
            cls} with any other ${f} does not satisfy this rule.`,
        description: `Set ${f} to ${quote(r.value)}.`,
      };
    default:
      return undefined;
  }
}

// --- Helpers. ----------------------------------------------------------------

// The class and all its supertypes (transitively, cycle-safe), nearest first.
function lineage(name: string, ctx: ConstraintContext): string[] {
  const out: string[] = [];
  const queue = [name];
  while (queue.length) {
    const n = queue.shift()!;
    if (out.includes(n)) continue;
    out.push(n);
    queue.push(...(ctx.entitiesByName.get(n)?.extends ?? []));
  }
  return out;
}

// True when `prop` is a field of the entity or of one of its supertypes.
function fieldOf(entity: Entity, prop: string, ctx: ConstraintContext): boolean {
  return lineage(entity.name, ctx).some(
      n => ctx.entitiesByName.get(n)?.fields.some(f => f.name === prop));
}

// Resolves the enforcement facets from the policies in precedence order (most
// specific first), validating each value against the model's vocabulary.
function resolvePolicy(
    policies: (OwlConstraintPolicy|undefined)[], where: string,
    warnings: string[]):
    {onViolation: ViolationEffect; severity?: ConstraintSeverity} {
  let onViolation: ViolationEffect|undefined;
  let severity: ConstraintSeverity|undefined;
  for (const p of policies) {
    if (!p) continue;
    if (onViolation === undefined && p.onViolation !== undefined) {
      if ((VIOLATION_EFFECTS as readonly string[]).includes(p.onViolation)) {
        onViolation = p.onViolation as ViolationEffect;
      } else {
        warnings.push(
            `${where}: kcmd:onViolation '${p.onViolation}' is not one of ${
                VIOLATION_EFFECTS.join(', ')}; ignored.`);
      }
    }
    if (severity === undefined && p.severity !== undefined) {
      if ((CONSTRAINT_SEVERITIES as readonly string[]).includes(p.severity)) {
        severity = p.severity as ConstraintSeverity;
      } else {
        warnings.push(
            `${where}: kcmd:severity '${p.severity}' is not one of ${
                CONSTRAINT_SEVERITIES.join(', ')}; ignored.`);
      }
    }
  }
  return {onViolation: onViolation ?? 'warn', severity};
}

// The axiom in Manchester-like syntax, for provenance and warnings. A
// restriction that is a conjunct of an intersection is shown with its named
// conjuncts (`C EquivalentTo D and (p some X)`).
function manchester(cls: string, r: OwlRestriction): string {
  const head = `${cls} ${r.via === 'subClassOf' ? 'SubClassOf' : 'EquivalentTo'}`;
  const p = localName(r.property);
  const filler = r.filler ? ` ${localName(r.filler)}` :
      r.anonymousFiller ? ' [anonymous]' : '';
  let body: string;
  switch (r.kind) {
    case 'some': body = `${p} some${filler}`; break;
    case 'all': body = `${p} only${filler}`; break;
    case 'value': body = `${p} value ${quote(r.value)}`; break;
    case 'exact': body = `${p} exactly ${r.cardinality}${filler}`; break;
    case 'min': body = `${p} min ${r.cardinality}${filler}`; break;
    case 'max': body = `${p} max ${r.cardinality}${filler}`; break;
    default: body = p;
  }
  return r.intersectedWith?.length ?
      `${head} ${r.intersectedWith.join(' and ')} and (${body})` :
      `${head} ${body}`;
}

function withProvenance(text: string, axiom: string): string {
  return `${text} (From OWL: ${axiom}.)`;
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
function quote(v: string|undefined): string {
  return `'${v ?? ''}'`;
}
function listPhrase(items: string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
