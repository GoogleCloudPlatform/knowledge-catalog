// OwlModel -> Turtle (.ttl) serializer.
//
// The mechanical mirror of parse.ts: parse.ts reads RDF triples into an
// OwlModel; this writes an OwlModel back out as a Turtle document. All OSI ->
// OWL policy lives in from_ir.ts (which builds the OwlModel); this file only
// decides how to render terms, in a fixed order so the output is stable (and a
// golden pins it).
//
// The document is written so parse.ts reads it back into the SAME OwlModel:
//   - every class / property is a term in the ontology's own namespace (the
//   `ex:`
//     prefix), so parse's dominantNamespace recovers that base IRI;
//   - a class's alternate names are emitted as skos:altLabel (a class has no
//   OSI
//     label), a datatype property's label as the primary rdfs:label;
//   - a carried cross-reference already re-expanded to a full IRI by from_ir is
//     rendered prefixed when in-namespace (parse re-shortens it) and as a full
//     <IRI> otherwise;
//   - rdfs:seeAlso values are emitted verbatim: from_ir carries them in the
//     N-Triples object form parse stored them in, which is already valid
//     Turtle.

import {OwlCommonAnnotations, OwlModel} from './model';

export interface SerializeResult {
  turtle: string;
  warnings: string[];
}

const OWL = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

// The namespace used for this ontology's own terms when the model carries no
// `owl:baseIri` (a model with no shortened cross-reference; see to_ir). Any
// consistent value works: parse's dominantNamespace recovers it as the base,
// and because nothing is shortened against it, it never leaks into the
// re-imported IR (the model name comes from the file, not the namespace).
const DEFAULT_BASE = 'http://example.com/ontology#';

// A `predicate object` pair to emit under a subject, pre-rendered. Kept as a
// tuple so a subject block is just an ordered list the writer joins.
type Pair = [predicate: string, object: string];

/**
 * Serializes an OwlModel to a Turtle document string.
 *
 * The output round-trips through parse.ts to an equivalent OwlModel. Never
 * throws; the (currently always empty) warnings channel mirrors the import
 * direction so callers can treat both uniformly.
 */
export function serializeOwl(owl: OwlModel): SerializeResult {
  const base = owl.baseIri ?? DEFAULT_BASE;
  const term = (localName: string) => renderIri(`${base}${localName}`, base);
  const blocks: string[] = [];

  // Ontology header.
  if (owl.ontology) {
    const o = owl.ontology;
    const pairs: Pair[] = [];
    // All header labels ride as skos:altLabel: the importer folds them into the
    // model ai_context synonyms regardless of which label predicate carried
    // them.
    for (const s of o.synonyms) pairs.push(['skos:altLabel', literal(s)]);
    if (o.comment !== undefined)
      pairs.push(['rdfs:comment', literal(o.comment)]);
    for (const e of o.examples) pairs.push(['skos:example', literal(e)]);
    if (o.version !== undefined) {
      pairs.push(['owl:versionInfo', literal(o.version)]);
    }
    blocks.push(
        subject(renderIri(ontologyIri(base), base), 'owl:Ontology', pairs));
  }

  // Classes.
  for (const c of owl.classes) {
    const pairs: Pair[] = [];
    for (const s of c.synonyms) pairs.push(['skos:altLabel', literal(s)]);
    if (c.comment !== undefined)
      pairs.push(['rdfs:comment', literal(c.comment)]);
    for (const e of c.examples) pairs.push(['skos:example', literal(e)]);
    for (const p of c.subClassOf) pairs.push(['rdfs:subClassOf', term(p)]);
    for (const iri of c.equivalentClass) {
      pairs.push(['owl:equivalentClass', renderIri(iri, base)]);
    }
    for (const iri of c.disjointWith) {
      pairs.push(['owl:disjointWith', renderIri(iri, base)]);
    }
    pairs.push(...commonPairs(c, base));
    if (c.keys.length) {
      pairs.push(['owl:hasKey', collection(c.keys.map(term))]);
    }
    blocks.push(subject(term(c.localName), 'owl:Class', pairs));
  }

  // Datatype properties.
  for (const p of owl.datatypeProperties) {
    const types = ['owl:DatatypeProperty'];
    if (p.inverseFunctional) types.push('owl:InverseFunctionalProperty');
    if (p.functional) types.push('owl:FunctionalProperty');
    const pairs: Pair[] = [];
    for (const d of p.domains) pairs.push(['rdfs:domain', term(d)]);
    if (p.rangeIri !== undefined) {
      pairs.push(['rdfs:range', renderIri(p.rangeIri, base)]);
    }
    // The datatype property owns the OSI label slot: emit it as the primary
    // rdfs:label, the synonyms as skos:altLabel.
    if (p.label !== undefined) pairs.push(['rdfs:label', literal(p.label)]);
    for (const s of p.synonyms) pairs.push(['skos:altLabel', literal(s)]);
    if (p.comment !== undefined)
      pairs.push(['rdfs:comment', literal(p.comment)]);
    for (const e of p.examples) pairs.push(['skos:example', literal(e)]);
    for (const iri of p.subPropertyOf) {
      pairs.push(['rdfs:subPropertyOf', renderIri(iri, base)]);
    }
    for (const iri of p.equivalentProperty) {
      pairs.push(['owl:equivalentProperty', renderIri(iri, base)]);
    }
    for (const iri of p.propertyDisjointWith) {
      pairs.push(['owl:propertyDisjointWith', renderIri(iri, base)]);
    }
    pairs.push(...commonPairs(p, base));
    blocks.push(subject(term(p.localName), types.join(', '), pairs));
  }

  // Object properties.
  for (const p of owl.objectProperties) {
    const types = ['owl:ObjectProperty'];
    if (p.symmetric) types.push('owl:SymmetricProperty');
    if (p.transitive) types.push('owl:TransitiveProperty');
    if (p.functional) types.push('owl:FunctionalProperty');
    if (p.reflexive) types.push('owl:ReflexiveProperty');
    if (p.irreflexive) types.push('owl:IrreflexiveProperty');
    if (p.asymmetric) types.push('owl:AsymmetricProperty');
    const pairs: Pair[] = [];
    for (const d of p.domains) pairs.push(['rdfs:domain', term(d)]);
    for (const r of p.ranges) pairs.push(['rdfs:range', term(r)]);
    // A relationship has no OSI label; its comment rode in ai_context, its
    // alternate names in synonyms -> skos:altLabel.
    for (const s of p.synonyms) pairs.push(['skos:altLabel', literal(s)]);
    if (p.comment !== undefined)
      pairs.push(['rdfs:comment', literal(p.comment)]);
    for (const e of p.examples) pairs.push(['skos:example', literal(e)]);
    for (const iri of p.subPropertyOf) {
      pairs.push(['rdfs:subPropertyOf', renderIri(iri, base)]);
    }
    for (const iri of p.inverseOf) {
      pairs.push(['owl:inverseOf', renderIri(iri, base)]);
    }
    for (const iri of p.equivalentProperty) {
      pairs.push(['owl:equivalentProperty', renderIri(iri, base)]);
    }
    for (const iri of p.propertyDisjointWith) {
      pairs.push(['owl:propertyDisjointWith', renderIri(iri, base)]);
    }
    pairs.push(...commonPairs(p, base));
    blocks.push(subject(term(p.localName), types.join(', '), pairs));
  }

  const prefixes = [
    `@prefix owl:  <${OWL}> .`,
    `@prefix rdfs: <${RDFS}> .`,
    `@prefix skos: <${SKOS}> .`,
    `@prefix xsd:  <${XSD}> .`,
    `@prefix ex:   <${base}> .`,
  ].join('\n');

  const turtle = `${prefixes}\n\n${blocks.join('\n\n')}\n`;
  return {turtle, warnings: []};
}

// The per-term carried annotations (rdfs:seeAlso / isDefinedBy, owl:deprecated
// / owl:versionInfo), in the same fixed order to_ir.commonTerms wrote them.
// seeAlso values are emitted VERBATIM: from_ir carries them in the N-Triples
// object form (an IRI as `<iri>`, a literal as `"text"...`), already valid
// Turtle. isDefinedBy values are bare IRIs, wrapped as `<iri>`.
function commonPairs(a: OwlCommonAnnotations, base: string): Pair[] {
  const pairs: Pair[] = [];
  for (const s of a.seeAlso) pairs.push(['rdfs:seeAlso', s]);
  for (const iri of a.isDefinedBy) {
    pairs.push(['rdfs:isDefinedBy', renderIri(iri, base)]);
  }
  if (a.deprecated) pairs.push(['owl:deprecated', 'true']);
  if (a.versionInfo !== undefined) {
    pairs.push(['owl:versionInfo', literal(a.versionInfo)]);
  }
  return pairs;
}

// Renders one subject block: `<subject> a <types> ;` then each predicate/object
// pair, one per indented line, closed with ` .`. With no pairs the type triple
// stands alone.
function subject(subj: string, types: string, pairs: Pair[]): string {
  const head = `${subj} a ${types}`;
  if (!pairs.length) return `${head} .`;
  const body = pairs.map(([p, o]) => `    ${p} ${o}`).join(' ;\n');
  return `${head} ;\n${body} .`;
}

// An RDF collection (list) in Turtle `( a b c )` form -- how owl:hasKey names
// its member properties (see parse.resolveList).
function collection(items: string[]): string {
  return `( ${items.join(' ')} )`;
}

// Renders a full IRI as a term: prefixed when it sits in a namespace this
// document declares a prefix for (so the output reads like a hand-authored
// ontology and parse re-reads it identically), otherwise as a full `<IRI>`. The
// local part must be a Turtle-safe PN_LOCAL for the prefixed form; a name with
// an unusual character falls back to the full IRI.
function renderIri(iri: string, base: string): string {
  const prefixes: Array<[string, string]> = [
    ['ex', base],
    ['xsd', XSD],
    ['owl', OWL],
    ['rdfs', RDFS],
    ['skos', SKOS],
  ];
  for (const [prefix, ns] of prefixes) {
    if (iri.startsWith(ns)) {
      const local = iri.slice(ns.length);
      if (isSafeLocalName(local)) return `${prefix}:${local}`;
    }
  }
  return `<${iri}>`;
}

// True for a local name safe to emit after a prefix without escaping -- the
// common ASCII identifier shape. Anything else uses the full-IRI form, which is
// always safe.
function isSafeLocalName(local: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(local);
}

// Renders a Turtle string literal, escaping the characters that would otherwise
// break the quoting or the line (backslash, double quote, newline, tab,
// carriage return). A language tag or datatype is never added: from_ir routes
// typed / tagged literals through the verbatim seeAlso channel, so every
// literal reached here is a plain xsd:string.
function literal(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\')
                      .replace(/"/g, '\\"')
                      .replace(/\n/g, '\\n')
                      .replace(/\r/g, '\\r')
                      .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

// The IRI naming the owl:Ontology node. The base IRI without its trailing
// delimiter is the conventional ontology IRI (e.g. base `http://ex/sales#` ->
// `http://ex/sales`); it is cosmetic (parse derives the base from the terms,
// not this node), so any stable value is fine.
function ontologyIri(base: string): string {
  const last = base[base.length - 1];
  return last === '#' || last === '/' ? base.slice(0, -1) : base;
}
