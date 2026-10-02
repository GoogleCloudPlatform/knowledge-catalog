// OWL annotations and property characteristics -> native ai_context /
// description.
//
// Several OWL facts have no structural home in a semantic model but DO have a
// native one that changes what a reader or an agent does with the term:
//
//   owl:equivalentClass <named>      -> entity ai_context.synonyms
//   owl:equivalentProperty <named>   -> field / relationship ai_context.synonyms
//       The referent's local name (and its rdfs:label, when this ontology
//       declares one) is another name for the same concept, which is exactly
//       what `synonyms` feeds: natural-language search and query grounding.
//   owl:deprecated true              -> description prefixed "DEPRECATED: " and
//                                       an ai_context instruction not to use
//                                       the term; "Use X instead." when an
//                                       rdfs:seeAlso names an in-model term of
//                                       the same kind
//   owl:TransitiveProperty           -> relationship instruction to follow the
//                                       edge with a quantified path
//   owl:SymmetricProperty            -> relationship instruction to match the
//                                       edge undirected
//
// The instructions are what an agent writing GQL reads from Knowledge Catalog
// (ai_context.instructions lands in the entry's guidelines), so a transitive
// or symmetric edge is queried correctly rather than one hop / one direction
// only. Nothing is carried opaquely: each fact either changes a native slot or
// is dropped, as before.
//
// Runs as a post-pass over the mapped entities and relationships, keyed by
// name, so it composes with every other mapping step without touching them.

import {AiContext, Entity, Field, Relationship} from '../../ir';

import {OwlCommonAnnotations, OwlModel} from './model';
import {localName} from './parse';

// Upper bound suggested for a quantified path over a transitive edge. BigQuery
// and Spanner Graph take a bounded quantifier `{lower,upper}`; ten covers the
// depth of the hierarchies ontologies model (territories, org charts, part
// trees) and the instruction tells the agent to adjust it.
const TRANSITIVE_PATH_BOUND = 10;

/**
 * Applies the OWL annotations and property characteristics above to the mapped
 * entities and relationships, in place.
 */
export function applyOwlAnnotations(
    owl: OwlModel, entities: Entity[], relationships: Relationship[]): void {
  // rdfs:label of each term this ontology declares, by local name, so an
  // equivalence to an in-document term can contribute its human name too.
  const labels = new Map<string, string>();
  for (const t of [
         ...owl.classes, ...owl.datatypeProperties, ...owl.objectProperties
       ]) {
    if (t.label && !labels.has(t.localName)) labels.set(t.localName, t.label);
  }
  const alsoKnownAs = (iris: string[]): string[] => iris.flatMap(iri => {
    const name = localName(iri);
    const label = labels.get(name);
    return label ? [name, label] : [name];
  });

  const entityByName = new Map(entities.map(e => [e.name, e]));
  const relByName = new Map(relationships.map(r => [r.name, r]));

  // --- Classes -> entities. ------------------------------------------------
  for (const c of owl.classes) {
    const e = entityByName.get(c.localName);
    if (!e) continue;
    e.aiContext = addSynonyms(e.aiContext, alsoKnownAs(c.equivalentClass), e.name);
    if (c.deprecated) {
      e.description = deprecatedDescription(e.description);
      const instead = replacement(c, n => entityByName.has(n), n => n);
      e.aiContext = addInstruction(
          e.aiContext,
          `${e.name} is deprecated: do not use it in new queries or writes.` +
              (instead ? ` Use ${instead} instead.` : ''));
    }
  }

  // --- Datatype properties -> fields (on every domain entity). ------------
  for (const p of owl.datatypeProperties) {
    for (const domain of p.domains) {
      const e = entityByName.get(domain);
      const f = e?.fields.find(x => x.name === p.localName);
      if (!e || !f) continue;
      applyToField(e, f, p, alsoKnownAs(p.equivalentProperty));
    }
  }

  // --- Object properties -> relationships. --------------------------------
  for (const p of owl.objectProperties) {
    const r = relByName.get(p.localName);
    if (!r) continue;
    r.aiContext =
        addSynonyms(r.aiContext, alsoKnownAs(p.equivalentProperty), r.name);
    if (p.deprecated) {
      const instead = replacement(p, n => relByName.has(n), n => n);
      r.aiContext = addInstruction(
          r.aiContext,
          `DEPRECATED: do not use ${r.name} in new queries or writes.` +
              (instead ? ` Use ${instead} instead.` : ''));
    }
    const from = r.source.entity;
    const to = r.destination.entity;
    if (p.transitive) {
      r.aiContext = addInstruction(
          r.aiContext,
          `${r.name} is transitive: if a ${r.name} b and b ${r.name} c, then ` +
              `a ${r.name} c, but only the direct edges are stored. To follow ` +
              `it, match a quantified path, e.g. MATCH (a:${from})-[:${
                  r.name}]->{1,${TRANSITIVE_PATH_BOUND}}(b:${to}) (raise the ` +
              `upper bound for deeper chains).`);
    }
    if (p.symmetric) {
      r.aiContext = addInstruction(
          r.aiContext,
          `${r.name} is symmetric: a ${r.name} b implies b ${r.name} a, but ` +
              `each pair may be stored in one direction only. Match it ` +
              `undirected, e.g. MATCH (a:${from})-[:${r.name}]-(b:${to}).`);
    }
  }

  function applyToField(
      e: Entity, f: Field, p: OwlCommonAnnotations&{localName: string},
      synonyms: string[]) {
    // A field's display label is already one of its names.
    f.aiContext = addSynonyms(
        f.aiContext, synonyms.filter(s => s !== f.label), f.name);
    if (!p.deprecated) return;
    f.description = deprecatedDescription(f.description);
    const instead = replacement(
        p, n => e.fields.some(x => x.name === n), n => `${e.name}.${n}`);
    f.aiContext = addInstruction(
        f.aiContext,
        `${e.name}.${f.name} is deprecated: do not use it in new queries or ` +
            `writes.` +
            (instead ? ` Use ${instead} instead.` : ''));
  }
}

// "DEPRECATED: <description>", or just "DEPRECATED." when there is none.
function deprecatedDescription(description: string|undefined): string {
  return description ? `DEPRECATED: ${description}` : 'DEPRECATED.';
}

// The in-model replacement a deprecated term's rdfs:seeAlso points at: the
// first seeAlso IRI whose local name is an in-model term of the same kind,
// rendered by `render`. Literal seeAlso values and out-of-model IRIs are
// ignored (they are external pointers, not a replacement the agent can use).
function replacement(
    t: OwlCommonAnnotations, inModel: (name: string) => boolean,
    render: (name: string) => string): string|undefined {
  for (const s of t.seeAlso) {
    const m = /^<(.*)>$/.exec(s);
    if (!m) continue;
    const name = localName(m[1]);
    if (inModel(name)) return render(name);
  }
  return undefined;
}

// Adds alternate names to an ai_context, deduped and excluding the term's own
// name (or a respaced/recased rendering of it). Returns the input unchanged
// when there is nothing to add, so no empty ai_context is emitted.
function addSynonyms(
    ai: AiContext|undefined, names: string[], own: string): AiContext|undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const fresh = names.filter(n => norm(n) !== norm(own));
  if (!fresh.length) return ai;
  const synonyms = [...new Set([...(ai?.synonyms ?? []), ...fresh])];
  return {...(ai ?? {}), synonyms};
}

// Appends one instruction paragraph to an ai_context's instructions.
function addInstruction(ai: AiContext|undefined, text: string): AiContext {
  const instructions =
      ai?.instructions ? `${ai.instructions}\n\n${text}` : text;
  return {...(ai ?? {}), instructions};
}
