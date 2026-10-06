// OWL enumerations and named individuals -> vocabulary members (K3, proposed;
// see ../../vocabulary.ts for what a vocabulary is and how it lowers).
//
// A class becomes a vocabulary when
//   - it carries the class-level boolean annotation whose predicate local name
//     is `vocabulary` set to true (`core:vocabulary true`), or
//   - it is an enumeration (owl:oneOf, directly or as its owl:equivalentClass),
//     or
//   - one of its direct instances is declared owl:NamedIndividual in the
//     imported ontology,
// unless that annotation says `false`. Its members are the enumeration's
// individuals in list order, then its other direct instances in document
// order, each read as
//   code        kcmd:code, else skos:notation, else any annotation whose local
//               name is `code`, else the individual's local name
//   label       rdfs:label, else skos:prefLabel, else the local name when it
//               differs from the code
//   synonyms    the remaining labels (further labels, skos:altLabel, ...)
//   definition  skos:definition, else rdfs:comment / dcterms: / dc:description
//   order       an annotation whose local name is `sortOrder` / `order`, when
//               it is an integer
//   iri         the individual's IRI
// and sorted by `order` (members without one keep their relative place after
// those with one). Edges match a code case-insensitively, so a code repeating
// another in a different case is dropped with a warning.

import {Entity, VocabularyMember} from '../../ir';

import {OwlClass, OwlIndividual, OwlModel} from './model';
import {localName} from './parse';

/** Why a class is a vocabulary, or undefined when it is not one. */
export type VocabularyReason = 'annotation'|'enumeration'|'individuals';

// Whether the individual is asserted a direct instance of the class: by full
// IRI, or by local name for a hand-built class with no IRI.
function isInstanceOf(i: OwlIndividual, c: OwlClass): boolean {
  return c.iri !== undefined ? i.types.includes(c.iri) :
                               i.types.some(t => localName(t) === c.localName);
}

/**
 * Whether (and why) a class is a vocabulary, given its direct instances. An
 * explicit `vocabulary false` wins over an enumeration or named individuals.
 */
export function vocabularyReason(
    c: OwlClass, instances: readonly OwlIndividual[]): VocabularyReason|
    undefined {
  if (c.vocabulary === false) return undefined;
  if (c.vocabulary === true) return 'annotation';
  if (c.oneOf.length) return 'enumeration';
  if (instances.some(i => i.named)) return 'individuals';
  return undefined;
}

// One member, from an individual's IRI and staged facts (absent for an
// enumerated IRI the ontology says nothing else about).
function memberOf(
    iri: string, individual: OwlIndividual|undefined,
    codes: Record<string, string>|undefined, ctx: string,
    warnings: string[]): VocabularyMember {
  const name = localName(iri);
  const stored = individual?.code ?? codes?.[iri];
  const code = stored !== undefined && stored !== '' ? stored : name;
  const member: VocabularyMember = {code};
  const label = individual?.label ?? (name !== code ? name : undefined);
  if (label !== undefined) member.label = label;
  const synonyms = [...new Set(individual?.synonyms ?? [])].filter(
      s => s !== label && s !== code);
  if (synonyms.length) member.synonyms = synonyms;
  if (individual?.definition !== undefined) {
    member.definition = individual.definition;
  }
  const order = individual?.order;
  if (order !== undefined) {
    const n = Number(order);
    if (order !== '' && Number.isInteger(n)) {
      member.order = n;
    } else {
      warnings.push(`${ctx}: member '${name}' has a sort order '${
          order}' that is not an integer; ignored.`);
    }
  }
  member.iri = iri;
  return member;
}

/**
 * The members of a vocabulary class: its enumeration's individuals, then its
 * other direct instances, deduplicated by IRI and by code (case-insensitive,
 * first wins, warned), sorted by `order`.
 */
export function vocabularyMembers(
    c: OwlClass, instances: readonly OwlIndividual[], owl: OwlModel,
    warnings: string[]): VocabularyMember[] {
  const ctx = `class '${c.localName}'`;
  const byIri = new Map((owl.individuals ?? []).map(i => [i.iri, i]));
  const iris = [...new Set([...c.oneOf, ...instances.map(i => i.iri)])];
  const members: VocabularyMember[] = [];
  const codes = new Map<string, string>();
  for (const iri of iris) {
    const m = memberOf(iri, byIri.get(iri), owl.individualCodes, ctx, warnings);
    const key = m.code.toLowerCase();
    const prior = codes.get(key);
    if (prior !== undefined) {
      warnings.push(`${ctx}: member '${localName(iri)}' has code '${
          m.code}', which repeats '${prior}' (codes are matched ` +
          `case-insensitively); dropped.`);
      continue;
    }
    codes.set(key, m.code);
    members.push(m);
  }
  // Stable: members without an order keep their relative place, last.
  return members
      .map((m, i) => ({m, i}))
      .sort((a, b) => (a.m.order ?? Infinity) - (b.m.order ?? Infinity) ||
                a.i - b.i)
      .map(({m}) => m);
}

/**
 * Gives every vocabulary class's entity its `members` (see the header). A
 * class whose entity is a defined entity keeps its definition instead
 * (a vocabulary's rows are its members, a defined entity's are its parent's),
 * with a warning. Returns how many entities became vocabularies.
 */
export function applyOwlVocabularies(
    owl: OwlModel, entitiesByName: Map<string, Entity>,
    warnings: string[]): number {
  const individuals = owl.individuals ?? [];
  const done = new Set<string>();
  let count = 0;
  for (const c of owl.classes) {
    // Only the first class of a local name became an entity.
    if (done.has(c.localName)) continue;
    done.add(c.localName);
    const entity = entitiesByName.get(c.localName);
    if (!entity) continue;
    const instances = individuals.filter(i => isInstanceOf(i, c));
    const reason = vocabularyReason(c, instances);
    if (!reason) continue;
    const ctx = `class '${c.localName}'`;
    if (entity.definition) {
      warnings.push(`${ctx} is a vocabulary but also compiles to a defined ` +
                    `entity; its members are not imported.`);
      continue;
    }
    entity.members = vocabularyMembers(c, instances, owl, warnings);
    count++;
    if (reason === 'individuals') {
      warnings.push(`${ctx} has owl:NamedIndividual instances, so it is ` +
                    `imported as a vocabulary of ${entity.members.length} ` +
                    `member(s); annotate it \`vocabulary false\` to keep it a ` +
                    `data class.`);
    } else if (!entity.members.length) {
      warnings.push(`${ctx} is a vocabulary with no members in the imported ` +
                    `ontology; its member list is empty.`);
    }
  }
  return count;
}

/** A vocabulary detached from field-carrying parents (for coverage). */
export interface DetachedVocabulary {
  vocabulary: string;
  parents: string[];
}

/**
 * A vocabulary's rows are its members, read through a view with fixed
 * columns (code, label, sort_order, definition, iri; see ../../vocabulary.ts).
 * It cannot bind fields it would inherit from a data class above it
 * (`GeographicRegion rdfs:subClassOf OrgUnit` would inherit `unitName`), so a
 * vocabulary entity drops every `extends` parent whose lineage declares
 * fields, with a warning; parents that carry no fields (pure categories) are
 * kept. Run after applyOwlVocabularies.
 */
export function detachVocabularyParents(
    entitiesByName: Map<string, Entity>,
    warnings: string[]): DetachedVocabulary[] {
  const carriesFields = (name: string): boolean => {
    const seen = new Set<string>();
    const queue = [name];
    while (queue.length) {
      const n = queue.shift()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const e = entitiesByName.get(n);
      if (!e) continue;
      if (e.fields.length) return true;
      queue.push(...(e.extends ?? []));
    }
    return false;
  };
  const detached: DetachedVocabulary[] = [];
  for (const e of entitiesByName.values()) {
    if (e.members === undefined || !e.extends?.length) continue;
    const drop = e.extends.filter(carriesFields);
    if (!drop.length) continue;
    const keep = e.extends.filter(p => !drop.includes(p));
    if (keep.length) {
      e.extends = keep;
    } else {
      delete e.extends;
    }
    detached.push({vocabulary: e.name, parents: drop});
    warnings.push(
        `class '${e.name}' is a vocabulary, so it does not extend ${
            drop.map(p => `'${p}'`).join(', ')}: a vocabulary's rows are its ` +
        `members (code, label, sort order), which carry none of the fields ` +
        `it would inherit.`);
  }
  return detached;
}
