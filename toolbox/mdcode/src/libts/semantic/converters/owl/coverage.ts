// OWL import coverage (proposed): every construct occurrence of a parsed
// ontology, classified by what the import made of it -- compiled, hinted or
// dropped (see ../coverage.ts for the outcomes).
//
// It runs AFTER the mapping and reads both sides -- the parsed ontology (what
// was there) and the imported model (what came out) -- so an outcome is a
// fact about the output, not a second copy of the mapper's decisions. A drop's
// reason is the mapper's own warning where it gave one, else the documented
// policy (to_ir.ts header). Elements `--prune-unbound` removed are reported as
// dropped with the reason "pruned".

import {Constraint, Entity, SemanticModel} from '../../ir';
import {CoverageEntry, CoverageOutcome, CoverageRecorder} from '../coverage';

import {manchester} from './constraints';
import {EquivalentFold} from './folds';
import {OwlChainStep, OwlClass, OwlCommonAnnotations, OwlModel} from './model';
import {localName} from './parse';
import {datatypeFor} from './to_ir';

export interface OwlCoverageInput {
  // The OwlModel the mapping read (after folding, see folds.ts).
  owl: OwlModel;
  // The unkeyed classes folded into a keyed equivalent.
  folds?: readonly EquivalentFold[];
  // The model the mapping produced, BEFORE any pruning.
  model: SemanticModel;
  // The mapper's warnings, for drop reasons.
  warnings: readonly string[];
  // What `--prune-unbound` removed, when it ran.
  pruned?: {
    entities: readonly string[];
    relationships: readonly string[];
    constraints: readonly string[];
  };
}

// The drop reasons of what `--prune-unbound` removed, by why it went (see
// semantic/prune.ts).
const PRUNED = 'pruned (--prune-unbound)';
const PRUNED_ENTITY = `${PRUNED}: not bound, not an ancestor of a bound ` +
    'entity, and not defined over one';
const PRUNED_ENDPOINT = `${PRUNED}: an endpoint entity was pruned`;
const PRUNED_ABSTRACT =
    `${PRUNED}: an abstract relationship with no kept sub-relationship`;
const PRUNED_CONSTRAINT = `${PRUNED}: the constraint names a pruned entity`;

// What an outcome hangs on: when that element was pruned, the outcome is a
// drop.
interface Owner {
  entity?: string;
  relationship?: string;
  constraint?: string;
}

/** The coverage entries of one OWL import, in report order. */
export function owlCoverage(input: OwlCoverageInput): CoverageEntry[] {
  const {owl, model, warnings} = input;
  const rec = new CoverageRecorder();
  const entities = new Map(model.entities.map(e => [e.name, e]));
  const rels = new Map(model.relationships.map(r => [r.name, r]));
  const byInverse = new Map(
      model.relationships.filter(r => r.inverse).map(r => [r.inverse!, r]));
  const constraints = model.constraints ?? [];
  const prunedEntities = new Set(input.pruned?.entities ?? []);
  const prunedRels = new Set(input.pruned?.relationships ?? []);
  const prunedConstraints = new Set(input.pruned?.constraints ?? []);

  // Why the owner of an outcome was pruned, or undefined when it was kept.
  const prunedBecause = (o: Owner): string|undefined => {
    if (o.entity !== undefined && prunedEntities.has(o.entity)) {
      return PRUNED_ENTITY;
    }
    if (o.relationship !== undefined && prunedRels.has(o.relationship)) {
      const r = rels.get(o.relationship);
      return r && !prunedEntities.has(r.source.entity) &&
              !prunedEntities.has(r.destination.entity) ?
          PRUNED_ABSTRACT :
          PRUNED_ENDPOINT;
    }
    if (o.constraint !== undefined && prunedConstraints.has(o.constraint)) {
      return PRUNED_CONSTRAINT;
    }
    return undefined;
  };
  // Records a compiled / hinted outcome, or a drop when its owner was pruned.
  const land =
      (outcome: Exclude<CoverageOutcome, 'dropped'>, construct: string,
       subject: string, owner: Owner, target: string, reason?: string) => {
        const pruned = prunedBecause(owner);
        if (pruned !== undefined) {
          rec.dropped(construct, subject, pruned);
        } else {
          rec.add({construct, subject, outcome, target, reason});
        }
      };
  // Records a drop; when its owner was pruned, the prune is the reason (it
  // would have gone whatever the mapping made of it).
  const drop =
      (construct: string, subject: string, owner: Owner, reason: string) => {
        rec.dropped(construct, subject, prunedBecause(owner) ?? reason);
      };
  // The mapper's warning about a construct: the first warning containing all
  // needles of any needle set, preferring one that reports a skip.
  const why = (needleSets: string[][], fallback: string): string => {
    const hits = warnings.filter(
        w => needleSets.some(set => set.every(n => w.includes(n))));
    return hits.find(w => SKIP_WORDS.test(w)) ?? hits[0] ?? fallback;
  };
  const byProvenance = (axiom: string): Constraint|undefined =>
      constraints.find(c => c.description?.endsWith(`(From OWL: ${axiom}.)`));
  const lineage = (name: string): string[] => {
    const out: string[] = [];
    const queue = [name];
    while (queue.length) {
      const next = queue.shift()!;
      if (out.includes(next)) continue;
      out.push(next);
      queue.push(...(entities.get(next)?.extends ?? []));
    }
    return out;
  };

  // --- Classes. --------------------------------------------------------------
  const firstClass = new Map<string, OwlClass>();
  for (const c of owl.classes) {
    if (firstClass.has(c.localName)) {
      rec.dropped(
          'owl:Class', c.localName,
          'declared more than once (same local name); the first declaration ' +
              'is imported');
      continue;
    }
    firstClass.set(c.localName, c);
    const e = entities.get(c.localName);
    if (!e) {
      rec.dropped(
          'owl:Class', c.localName,
          why([[`class '${c.localName}'`]], 'not imported'));
      continue;
    }
    land(
        'compiled', 'owl:Class', c.localName, {entity: e.name},
        e.definition ? `defined entity ${e.name}` : `entity ${e.name}`);
  }
  // Classes folded into their keyed equivalent (folds.ts): no entity of their
  // own, by design.
  for (const f of input.folds ?? []) {
    land('compiled', 'owl:Class', f.folded, {entity: f.into},
         `entity ${f.into} (folded in)`);
    land('compiled', 'owl:equivalentClass (folded)',
         `${f.folded} EquivalentTo ${f.into}`, {entity: f.into},
         `entity ${f.into} ai_context.synonyms`,
         'an unkeyed class equivalent to a keyed one names the same ' +
             'concept: its relationships and fields move to the keyed entity');
  }
  const classes = [...firstClass.values()].filter(c => entities.has(c.localName));

  for (const c of classes) {
    const C = c.localName;
    const e = entities.get(C)!;
    for (const parent of dedupe(c.subClassOf)) {
      const subject = `${C} SubClassOf ${parent}`;
      if (!firstClass.has(parent)) {
        rec.dropped(
            'rdfs:subClassOf', subject,
            `'${parent}' is not an owl:Class of this ontology, so it cannot ` +
                `be resolved`);
      } else if (e.extends?.includes(parent)) {
        land('compiled', 'rdfs:subClassOf', subject, {entity: C},
             `entity ${C} extends`);
      } else if (lineage(C).includes(parent)) {
        land('compiled', 'rdfs:subClassOf', subject, {entity: C},
             `entity ${C} extends (through ${(e.extends ?? []).join(', ')})`);
      } else if (e.definition) {
        rec.dropped(
            'rdfs:subClassOf', subject,
            `a defined entity has exactly one parent ('${
                e.extends?.[0]}'), and '${parent}' is not on its lineage`);
      } else if (entities.get(parent)?.definition) {
        rec.dropped(
            'rdfs:subClassOf', subject,
            `'${parent}' is a defined entity, which cannot be a supertype; ${
                C} extends its base instead`);
      } else {
        rec.dropped(
            'rdfs:subClassOf', subject,
            why([[`class '${C}'`, parent]], 'not kept'));
      }
    }
  }

  for (const c of classes) {
    if (!c.keys.length) continue;
    const C = c.localName;
    const keys = dedupe(c.keys);
    const subject = `${C} HasKey (${keys.join(' ')})`;
    if (sameList(entities.get(C)!.keys, keys)) {
      land('compiled', 'owl:hasKey', subject, {entity: C},
           `entity ${C} primary_key`);
    } else {
      rec.dropped(
          'owl:hasKey', subject,
          why([[`class '${C}' owl:hasKey`]], 'not kept'));
    }
  }

  // Abstract by structure, and the kcmd:abstract override (abstract.ts).
  for (const c of classes) {
    const C = c.localName;
    const e = entities.get(C)!;
    const owner = {entity: C};
    if (c.abstract !== undefined) {
      if (e.definition || e.members) {
        drop('kcmd:abstract', C, owner,
             `${e.definition ? 'a defined entity' : 'a vocabulary'} is never ` +
                 `abstract`);
      } else {
        land('compiled', 'kcmd:abstract', C, owner,
             c.abstract ? `entity ${C} abstract` : `entity ${C} (concrete)`);
      }
      continue;
    }
    if (e.definition || e.members) continue;
    if (lineage(C).some(n => entities.get(n)?.keys.length)) continue;
    if (e.abstract) {
      land('compiled', 'owl:hasKey (absent)', C, owner, `entity ${C} abstract`,
           'no key (own or inherited) and has subclasses: a label on its ' +
               'subtypes, not a table');
    } else {
      drop('owl:hasKey (absent)', C, owner,
           'no key (own or inherited) and no subclasses: kept as a concrete ' +
               'entity with an empty primary_key; declare owl:hasKey to bind ' +
               'it, or annotate kcmd:abstract true');
    }
  }

  // --- Datatype properties. ----------------------------------------------------
  const seenFields = new Set<string>();
  for (const p of owl.datatypeProperties) {
    const P = p.localName;
    for (const d of p.unsupportedDomains ?? []) {
      rec.dropped(
          'rdfs:domain', `${P} domain ${d}`,
          'only a named class, or an owl:unionOf of named classes, can hold ' +
              'a field');
    }
    if (!p.domains.length) {
      rec.dropped(
          'owl:DatatypeProperty', P,
          'no rdfs:domain: a field must belong to a class');
      continue;
    }
    // The domains on which this declaration produced the field.
    const produced: Entity[] = [];
    for (const d of p.domains) {
      const subject = `${d}.${P}`;
      const e = entities.get(d);
      if (!e) {
        rec.dropped(
            'owl:DatatypeProperty', subject,
            `domain '${d}' is not an owl:Class of this ontology`);
        continue;
      }
      if (seenFields.has(subject) || !e.fields.some(f => f.name === P)) {
        rec.dropped(
            'owl:DatatypeProperty', subject,
            why([[`datatype property '${P}' on '${d}'`]],
                'duplicates an existing field name'));
        continue;
      }
      seenFields.add(subject);
      produced.push(e);
      land('compiled', 'owl:DatatypeProperty', subject, {entity: d},
           `field ${subject}`);
    }
    if (!produced.length) continue;
    const first = produced[0].name;
    if (p.unionDomain) {
      land('compiled', 'owl:unionOf (rdfs:domain)',
           `${P} domain unionOf(${p.domains.join(' ')})`, {entity: first},
           `fields ${produced.map(e => `${e.name}.${P}`).join(', ')}`,
           'the field is placed on each member class');
    }
    if (p.rangeIri) {
      const type = datatypeFor(p.rangeIri);
      const subject = `${P} range ${localName(p.rangeIri)}`;
      if (type !== 'Opaque') {
        land('compiled', 'rdfs:range', subject, {entity: first},
             `field ${first}.${P} type ${type}`);
      } else {
        rec.dropped(
            'rdfs:range', subject,
            `${localName(p.rangeIri)} has no OSI datatype; the field is ` +
                `typed Opaque`);
      }
    }
    for (const e of produced) {
      const subject = `${e.name}.${P}`;
      if (p.inverseFunctional) {
        const asKey = sameList(e.keys, [P]);
        const asUnique = (e.uniqueKeys ?? []).some(u => sameList(u, [P]));
        if (asKey || asUnique) {
          land('compiled', 'owl:InverseFunctionalProperty', subject,
               {entity: e.name},
               `entity ${e.name} ${asKey ? 'primary_key' : 'unique_keys'}`);
        } else {
          rec.dropped('owl:InverseFunctionalProperty', subject, 'not kept');
        }
      }
      if (p.functional) {
        land('compiled', 'owl:FunctionalProperty', subject, {entity: e.name},
             `field ${subject}`,
             'guaranteed by construction: a field holds at most one value');
      }
      if (p.unit !== undefined) {
        land('compiled', 'qudt:unit', subject, {entity: e.name},
             `field ${subject} unit`);
      }
      for (const q of dedupe(p.equivalentProperty.map(localName))) {
        land('hinted', 'owl:equivalentProperty', `${P} EquivalentTo ${q}`,
             {entity: e.name}, `field ${subject} ai_context.synonyms`,
             'an equivalence is recorded as alternate names');
      }
      annotateField(e.name, p);
    }
    for (const s of dedupe(p.subPropertyOf.map(localName))) {
      rec.dropped(
          'rdfs:subPropertyOf', `${P} SubPropertyOf ${s}`,
          'inheritance between datatype properties has no native home in ' +
              'the model');
    }
    for (const q of dedupe(p.propertyDisjointWith.map(localName))) {
      rec.dropped(
          'owl:propertyDisjointWith', `${P} DisjointWith ${q}`,
          'no native construct for disjoint properties');
    }
    common(p, `field ${first}.${P}`, {entity: first}, P);
  }

  // --- Object properties. -------------------------------------------------------
  const objectNames = new Set(owl.objectProperties.map(p => p.localName));
  const seenRels = new Set<string>();
  for (const p of owl.objectProperties) {
    const P = p.localName;
    const duplicate = seenRels.has(P);
    seenRels.add(P);
    const r = duplicate ? undefined : rels.get(P);
    const folded = duplicate ? undefined : byInverse.get(P);
    if (r) {
      land('compiled', 'owl:ObjectProperty', P, {relationship: P},
           r.abstract ? `relationship ${P} (abstract: a label on its ` +
                   `sub-relationships)` :
                        `relationship ${P}`);
    } else if (folded) {
      land('compiled', 'owl:ObjectProperty', P, {relationship: folded.name},
           `relationship ${folded.name} inverse`,
           `the reverse reading of ${folded.name} (owl:inverseOf)`);
    } else {
      rec.dropped(
          'owl:ObjectProperty', P,
          why([[`object property '${P}'`]], 'not imported'));
    }
    const owner: Owner = {relationship: r ? P : folded?.name};
    const carrier = r ? `relationship ${P}` : undefined;

    // `<ns>:encodedBy` -> the edge's join columns (to_ir.joinEncodedEdges).
    if (p.encodedBy !== undefined) {
      const subject = `${P} encodedBy ${p.encodedBy}`;
      if (r?.source.columns.length) {
        land('compiled', 'encodedBy', subject, owner,
             `relationship ${P} from_columns [${
                 r.source.columns.join(', ')}] to_columns [${
                 r.destination.columns.join(', ')}]`);
      } else {
        drop('encodedBy', subject, owner,
             why([[`object property '${P}' is encodedBy`]],
                 !r                ? 'the relationship was not imported' :
                     r.abstract    ? 'an abstract relationship has no join ' +
                             'columns' :
                     r.via?.length ? 'a derived relationship has no join ' +
                             'columns' :
                                     'not kept'));
      }
    }

    for (const s of dedupe(p.subPropertyOf.map(localName))) {
      if (s === P) continue;
      const subject = `${P} SubPropertyOf ${s}`;
      if (!objectNames.has(s)) {
        drop('rdfs:subPropertyOf', subject, owner,
             `'${s}' is not an object property of this ontology`);
      } else if (r?.extends?.includes(s)) {
        land('compiled', 'rdfs:subPropertyOf', subject, owner,
             `relationship ${P} extends`);
      } else {
        drop('rdfs:subPropertyOf', subject, owner,
             r ? `'${s}' did not become a relationship` :
                 `'${P}' did not become a relationship`);
      }
    }

    for (const q of dedupe(p.inverseOf.map(localName))) {
      if (q === P) continue;
      const subject = `${P} InverseOf ${q}`;
      const fwd = rels.get(P)?.inverse === q ? rels.get(P) :
          rels.get(q)?.inverse === P         ? rels.get(q) :
                                               undefined;
      if (fwd) {
        land('compiled', 'owl:inverseOf', subject, {relationship: fwd.name},
             `relationship ${fwd.name} inverse ${fwd.inverse}`);
      } else {
        drop('owl:inverseOf', subject, owner,
             why([[`'${P}'`, 'inverse'], [`'${q}'`, `'${P}'`, 'inverse']],
                 'not folded into an inverse'));
      }
    }

    const characteristic =
        (flag: boolean, construct: string, hint: string|undefined) => {
          if (!flag) return;
          if (carrier && hint) {
            land('hinted', construct, P, owner,
                 `${carrier} ai_context.instructions`, hint);
          } else if (!carrier) {
            drop(construct, P, owner,
                 folded ? `stated on '${P}', which is the inverse reading of ${
                              folded.name}; not carried` :
                          'the relationship was not imported');
          } else {
            drop(construct, P, owner, 'no native construct');
          }
        };
    characteristic(
        p.transitive, 'owl:TransitiveProperty',
        'no native construct: agents are told the edge is transitive and to ' +
            'follow it with a bounded quantified path');
    characteristic(
        p.symmetric, 'owl:SymmetricProperty',
        'no native construct: agents are told to match the edge undirected');
    if (p.functional) {
      const k = byProvenance(`${P} is a FunctionalProperty`);
      if (k) {
        land('compiled', 'owl:FunctionalProperty', P,
             {relationship: P, constraint: k.name}, `constraint ${k.name}`);
      } else if (carrier) {
        land('compiled', 'owl:FunctionalProperty', P, owner, carrier,
             'already bounded to one by a cardinality restriction constraint');
      } else {
        characteristic(true, 'owl:FunctionalProperty', undefined);
      }
    }
    characteristic(p.reflexive, 'owl:ReflexiveProperty', undefined);
    characteristic(p.irreflexive, 'owl:IrreflexiveProperty', undefined);
    characteristic(p.asymmetric, 'owl:AsymmetricProperty', undefined);

    for (const q of dedupe(p.equivalentProperty.map(localName))) {
      const subject = `${P} EquivalentTo ${q}`;
      if (carrier) {
        land('hinted', 'owl:equivalentProperty', subject, owner,
             `${carrier} ai_context.synonyms`,
             'an equivalence is recorded as alternate names');
      } else {
        drop('owl:equivalentProperty', subject, owner,
             'the relationship was not imported');
      }
    }
    for (const q of dedupe(p.propertyDisjointWith.map(localName))) {
      drop('owl:propertyDisjointWith', `${P} DisjointWith ${q}`, owner,
           'no native construct for disjoint properties');
    }
    for (const chain of p.propertyChain) {
      drop('owl:propertyChainAxiom',
           `${P} = ${chain.map(chainMember).join(' o ')}`, owner,
           'no native construct for a property chain (a derived relationship ' +
               'needs its join path spelled out)');
    }
    if (carrier) {
      annotateRelationship(P, p);
      common(p, carrier, owner, P);
    } else if (folded) {
      for (const [has, construct] of annotationKinds(p)) {
        if (has) {
          drop(construct, P, owner,
               `annotations of an inverse reading (folded into ${
                   folded.name}) are not carried`);
        }
      }
    }
  }

  // --- Class axioms. -------------------------------------------------------------
  for (const c of classes) {
    const C = c.localName;
    const e = entities.get(C)!;
    for (const q of dedupe(c.equivalentClass.map(localName))) {
      land('hinted', 'owl:equivalentClass (named)', `${C} EquivalentTo ${q}`,
           {entity: C}, `entity ${C} ai_context.synonyms`,
           'an equivalence is recorded as alternate names; the classes are ' +
               'not merged');
    }
    if (c.definitions?.length) {
      const subject = `${C} EquivalentTo <class expression>`;
      if (e.definition) {
        land('compiled', 'owl:equivalentClass (defined class)', subject,
             {entity: C}, `defined entity ${C} definition.expression`);
      } else {
        const w = warnings.find(
            x => x.startsWith(`class '${C}': its owl:equivalentClass`));
        const blocked =
            w && /defined entity \((.*)\); imported as/.exec(w)?.[1];
        drop('owl:equivalentClass (defined class)', subject, {entity: C},
             `not compiled to a defined entity${
                 blocked ? ` (${blocked})` : ''}; imported as a subclass ` +
                 `whose restrictions become constraints`);
      }
    }
    for (const r of c.restrictions) {
      const axiom = manchester(C, r);
      if (r.via === 'equivalentClass' && e.definition) {
        land('compiled', 'owl:Restriction', axiom, {entity: C},
             `defined entity ${C} definition.expression`,
             'part of the membership predicate');
        continue;
      }
      const k = byProvenance(axiom);
      if (k) {
        land('compiled', 'owl:Restriction', axiom,
             {entity: C, constraint: k.name}, `constraint ${k.name}`);
        continue;
      }
      const w = warnings.find(x => x.startsWith(`restriction '${axiom}'`));
      if (w) {
        drop('owl:Restriction', axiom, {entity: C}, w);
        continue;
      }
      land('compiled', 'owl:Restriction', axiom, {entity: C}, 'model structure',
           'already guaranteed by the model structure (a field holds one ' +
               'value; an edge ends at its declared destination)');
    }
    if (c.oneOf.length) {
      drop('owl:oneOf', `${C} = {${c.oneOf.map(localName).join(' ')}}`,
           {entity: C},
           'an enumeration of individuals: individuals are not modeled (the ' +
               'class is imported as an entity whose rows are its members)');
    }
  }

  const seenPairs = new Set<string>();
  const allDisjoint = owl.allDisjointClassesAxioms.map(
      ax => dedupe(ax.members.map(localName)));
  for (const c of classes) {
    for (const iri of c.disjointWith) {
      const a = c.localName;
      const b = localName(iri);
      const key = [a, b].sort().join('|');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const subject = `${a} DisjointWith ${b}`;
      const k = byProvenance(subject);
      const set = allDisjoint.find(m => m.includes(a) && m.includes(b));
      const setConstraint =
          set && byProvenance(`DisjointClasses(${set.join(' ')})`);
      if (k) {
        land('compiled', 'owl:disjointWith', subject,
             {entity: a, constraint: k.name}, `constraint ${k.name}`);
      } else if (setConstraint) {
        land('compiled', 'owl:disjointWith', subject,
             {entity: a, constraint: setConstraint.name},
             `constraint ${setConstraint.name}`,
             'stated by the owl:AllDisjointClasses set');
      } else {
        rec.dropped(
            'owl:disjointWith', subject,
            why([[`'${subject}'`]], 'not kept'));
      }
    }
  }
  for (const names of allDisjoint) {
    const axiom = `DisjointClasses(${names.join(' ')})`;
    const k = byProvenance(axiom);
    if (k) {
      land('compiled', 'owl:AllDisjointClasses', axiom, {constraint: k.name},
           `constraint ${k.name}`);
    } else {
      rec.dropped(
          'owl:AllDisjointClasses', axiom, why([[`'${axiom}'`]], 'not kept'));
    }
  }
  for (const members of owl.allDisjointProperties) {
    rec.dropped(
        'owl:AllDisjointProperties',
        `DisjointProperties(${dedupe(members.map(localName)).join(' ')})`,
        'no native construct for disjoint properties');
  }

  // --- Individuals. ---------------------------------------------------------------
  for (const [iri, code] of Object.entries(owl.individualCodes ?? {})) {
    const subject = `${localName(iri)} (code '${code}')`;
    const literal = `'${code.toLowerCase()}'`;
    const user = model.entities.find(
        x => x.definition?.expression.toLowerCase().includes(literal));
    if (user) {
      land('compiled', 'owl:NamedIndividual', subject, {entity: user.name},
           `defined entity ${user.name} definition.expression`,
           'matched through its stored code');
    } else {
      rec.dropped(
          'owl:NamedIndividual', subject,
          'an individual is instance data; only its code is used, when a ' +
              'compiled class definition names it');
    }
  }
  for (const members of owl.allDifferent) {
    rec.dropped(
        'owl:AllDifferent',
        `DifferentIndividuals(${dedupe(members.map(localName)).join(' ')})`,
        'individuals are not modeled');
  }

  // --- Class annotations, ontology header, vocabulary. ----------------------------
  for (const c of classes) {
    const C = c.localName;
    const owner = {entity: C};
    if (c.label !== undefined) {
      land('compiled', 'rdfs:label', C, owner,
           sameName(c.label, C) ? `entity ${C} name` :
                                  `entity ${C} ai_context.synonyms`,
           sameName(c.label, C) ? 'the label repeats the name' :
                                  'entities have no label slot');
    }
    if (c.comment !== undefined) {
      land('compiled', 'rdfs:comment', C, owner, `entity ${C} description`);
    }
    if (c.synonyms.length) {
      land('compiled', 'skos:altLabel', C, owner,
           `entity ${C} ai_context.synonyms`);
    }
    if (c.examples.length) {
      land('compiled', 'skos:example', C, owner,
           `entity ${C} ai_context.examples`);
    }
    common(c, `entity ${C}`, owner, C);
  }
  if (owl.ontology) {
    rec.compiled('owl:Ontology', model.name, 'model description / ai_context');
    if (owl.ontology.version !== undefined) {
      rec.compiled('owl:versionInfo', `ontology ${model.name}`,
                   'model description');
    }
  }
  for (const t of model.glossary?.terms ?? []) {
    rec.compiled('skos:Concept', t.id, `glossary term ${t.id}`);
  }

  return rec.entries;

  // Per-term annotations every kind of term carries.
  function common(
      t: OwlCommonAnnotations, carrier: string, owner: Owner, name: string) {
    if (t.deprecated) {
      land('hinted', 'owl:deprecated', name, owner,
           `${carrier} description + ai_context.instructions`,
           'no native deprecation flag: the description is prefixed ' +
               'DEPRECATED and agents are told not to use the term');
    }
    if (t.seeAlso.length) {
      if (t.deprecated) {
        land('hinted', 'rdfs:seeAlso', name, owner,
             `${carrier} ai_context.instructions`,
             'used only to name the replacement of a deprecated term');
      } else {
        rec.dropped('rdfs:seeAlso', name,
                    'external pointers have no native slot');
      }
    }
    if (t.isDefinedBy.length) {
      rec.dropped('rdfs:isDefinedBy', name, 'no native slot');
    }
    if (t.versionInfo !== undefined) {
      rec.dropped('owl:versionInfo', name, 'term versions have no native slot');
    }
  }

  function annotateField(
      entity: string,
      p: {localName: string; label?: string; comment?: string;
          synonyms: string[]; examples: string[]}) {
    const f = `${entity}.${p.localName}`;
    const owner = {entity};
    if (p.label !== undefined) {
      land('compiled', 'rdfs:label', f, owner,
           sameName(p.label, p.localName) ? `field ${f} name` :
                                            `field ${f} label`,
           sameName(p.label, p.localName) ? 'the label repeats the name' :
                                            undefined);
    }
    if (p.comment !== undefined) {
      land('compiled', 'rdfs:comment', f, owner, `field ${f} description`);
    }
    if (p.synonyms.length) {
      land('compiled', 'skos:altLabel', f, owner,
           `field ${f} ai_context.synonyms`);
    }
    if (p.examples.length) {
      land('compiled', 'skos:example', f, owner,
           `field ${f} ai_context.examples`);
    }
  }

  function annotateRelationship(
      name: string,
      p: {label?: string; comment?: string; synonyms: string[];
          examples: string[]}) {
    const owner = {relationship: name};
    if (p.label !== undefined) {
      land('compiled', 'rdfs:label', name, owner,
           sameName(p.label, name) ? `relationship ${name} name` :
                                     `relationship ${name} ai_context.synonyms`,
           sameName(p.label, name) ? 'the label repeats the name' :
                                     'relationships have no label slot');
    }
    if (p.comment !== undefined) {
      land('compiled', 'rdfs:comment', name, owner,
           `relationship ${name} ai_context.instructions`,
           'relationships have no description slot');
    }
    if (p.synonyms.length) {
      land('compiled', 'skos:altLabel', name, owner,
           `relationship ${name} ai_context.synonyms`);
    }
    if (p.examples.length) {
      land('compiled', 'skos:example', name, owner,
           `relationship ${name} ai_context.examples`);
    }
  }
}

// Warnings that report a skip, preferred as a drop reason over informational
// ones about the same term.
const SKIP_WORDS = /skipped|dropped|not compiled|ignored|not kept|instead|kept as separate/;

// The annotation constructs a term carries, as [present, construct] pairs.
function annotationKinds(p: {label?: string; comment?: string;
                             synonyms: string[]; examples: string[]}):
    [boolean, string][] {
  return [
    [p.label !== undefined, 'rdfs:label'],
    [p.comment !== undefined, 'rdfs:comment'],
    [p.synonyms.length > 0, 'skos:altLabel'],
    [p.examples.length > 0, 'skos:example'],
  ];
}

// True when a label only respaces / recases the name (to_ir drops it then).
function sameName(label: string, name: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(label) === norm(name);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

// A property-chain member as written in a report: an anonymous inverse
// reads `inverse(p)`, and any unsupported blank node reads `[anonymous]`.
function chainMember(step: OwlChainStep): string {
  if (step.inverse) return `inverse(${localName(step.property)})`;
  if (step.unsupported) return '[anonymous]';
  return step.property ? localName(step.property) : '[anonymous]';
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
