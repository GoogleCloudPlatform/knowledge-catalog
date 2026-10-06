// SKOS -> business glossary (K9) for the OWL importer.
//
// A SKOS vocabulary is a business glossary: skos:Concept is a term,
// skos:ConceptScheme the glossary or a category. This pass reads the same
// Turtle the OWL parser reads and fills `model.glossary` (ir.Glossary), so an
// `owl import` of an ontology that ships its vocabulary yields a model that
// `kcmd glossary push` publishes. Kept separate from parse.ts / to_ir.ts:
// those map the ontology's classes and properties, this maps its vocabulary,
// and the two only meet in `defines`.
//
// Mapping (deliberately simple):
//   skos:Concept             -> term (id from the local name)
//   skos:prefLabel           -> display_name (English, else untagged, else any)
//   skos:definition          -> definition (else rdfs:comment / dcterms:description)
//   skos:altLabel            -> synonyms (also skos:hiddenLabel)
//   skos:related             -> related (both directions)
//   skos:inScheme            -> category (one category per scheme when there
//                               are several; a single scheme describes the
//                               glossary itself instead: its label and
//                               definition become the glossary's)
//   dcterms:subject / rdfs:seeAlso / skos:exactMatch / skos:closeMatch naming
//   a class or a datatype property the importer turned into an entity / field
//                            -> defines
//   a concept that IS also an owl:Class or datatype property
//                            -> defines (itself)
//   dcterms:source           -> source
// Anything else is ignored.

import {Parser, Quad} from 'n3';

import {idSlug} from '../../glossary';
import {Glossary, GlossaryDefines, GlossaryTerm, SemanticModel} from '../../ir';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const DCTERMS = 'http://purl.org/dc/terms/';

const RDF_TYPE = `${RDF}type`;
const CONCEPT = `${SKOS}Concept`;
const SCHEME = `${SKOS}ConceptScheme`;
// kcmd:Metric individuals (see metrics.ts): when a glossary is emitted, each
// imported metric no concept defines gets a term that defines it.
const KCMD_METRIC = 'https://kcmd.dev/ns#Metric';
const DEFINES_PREDICATES = new Set([
  `${DCTERMS}subject`,
  `${RDFS}seeAlso`,
  `${SKOS}exactMatch`,
  `${SKOS}closeMatch`,
]);

function localName(iri: string): string {
  const m = /[#/:]([^#/:]*)$/.exec(iri);
  return m && m[1] ? m[1] : iri;
}

interface Lit {value: string; lang: string}

/**
 * Builds a glossary from the SKOS concepts in `turtle` (one document or the
 * modules of one ontology), resolving `defines` against `model` (the IR the
 * OWL mapper produced). Returns undefined when there are no concepts.
 */
export function skosToGlossary(
    turtle: string|string[], model: SemanticModel,
    warnings: string[] = []): Glossary|undefined {
  const docs = Array.isArray(turtle) ? turtle : [turtle];
  const quads: Quad[] = [];
  docs.forEach((text, i) => {
    quads.push(...new Parser({blankNodePrefix: `d${i}_`}).parse(text));
  });

  const types = new Map<string, Set<string>>();
  const props = new Map<string, Map<string, Array<{iri?: string; lit?: Lit}>>>();
  for (const q of quads) {
    const s = q.subject.value;
    const p = q.predicate.value;
    if (p === RDF_TYPE) {
      const t = types.get(s) ?? new Set<string>();
      t.add(q.object.value);
      types.set(s, t);
      continue;
    }
    const byP = props.get(s) ?? new Map();
    const vals = byP.get(p) ?? [];
    if (q.object.termType === 'Literal') {
      vals.push({lit: {value: q.object.value, lang: (q.object as any).language ?? ''}});
    } else {
      vals.push({iri: q.object.value});
    }
    byP.set(p, vals);
    props.set(s, byP);
  }
  const iris = (s: string, p: string) =>
      (props.get(s)?.get(p) ?? []).map(v => v.iri).filter((x): x is string => !!x);
  const lits = (s: string, p: string) =>
      (props.get(s)?.get(p) ?? []).map(v => v.lit).filter((x): x is Lit => !!x);
  const best = (s: string, ...ps: string[]): string|undefined => {
    for (const p of ps) {
      const ls = lits(s, p);
      const pick = ls.find(l => l.lang.toLowerCase().startsWith('en')) ??
          ls.find(l => !l.lang) ?? ls[0];
      if (pick) return pick.value.trim();
    }
    return undefined;
  };

  const concepts = [...types].filter(([, t]) => t.has(CONCEPT)).map(([s]) => s);
  if (!concepts.length) return undefined;

  // Ids: the slugged local name, de-duplicated with a numeric suffix.
  const used = new Set<string>();
  const idOf = new Map<string, string>();
  const claim = (iri: string) => {
    let base = idSlug(localName(iri).replace(/([a-z0-9])([A-Z])/g, '$1-$2'));
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base.slice(0, 59)}-${n}`;
    used.add(id);
    idOf.set(iri, id);
    return id;
  };

  // Schemes: every scheme a concept is in.
  const schemes = new Set<string>();
  for (const c of concepts) {
    for (const s of iris(c, `${SKOS}inScheme`)) schemes.add(s);
    for (const s of iris(c, `${SKOS}topConceptOf`)) schemes.add(s);
  }
  for (const [s, t] of types) if (t.has(SCHEME)) schemes.add(s);
  const schemeList = [...schemes];
  // One scheme -> it is the glossary; several -> each is a category.
  const glossary: Glossary = {categories: [], terms: []};
  const categoryOf = new Map<string, string>();
  if (schemeList.length === 1) {
    const s = schemeList[0];
    const label = best(s, `${SKOS}prefLabel`, `${RDFS}label`, `${DCTERMS}title`);
    const desc = best(s, `${SKOS}definition`, `${RDFS}comment`, `${DCTERMS}description`);
    if (label) glossary.displayName = label;
    if (desc) glossary.description = desc;
  } else {
    for (const s of schemeList) {
      const id = claim(s);
      const label = best(s, `${SKOS}prefLabel`, `${RDFS}label`, `${DCTERMS}title`);
      const desc = best(s, `${SKOS}definition`, `${RDFS}comment`, `${DCTERMS}description`);
      glossary.categories.push({
        id,
        ...(label ? {displayName: label} : {}),
        ...(desc ? {description: desc} : {}),
      });
      categoryOf.set(s, id);
    }
  }
  for (const c of concepts) claim(c);

  // Model element lookup by local name.
  const entityNames = new Set((model.entities ?? []).map(e => e.name));
  const fieldOwner = new Map<string, string>();
  for (const e of model.entities ?? []) {
    for (const f of e.fields ?? []) {
      if (!fieldOwner.has(f.name)) fieldOwner.set(f.name, e.name);
    }
  }
  const metricNames = new Set((model.metrics ?? []).map(m => m.name));
  const definesOf = (iri: string): GlossaryDefines|undefined => {
    const n = localName(iri);
    if (entityNames.has(n)) return {kind: 'entity', ref: n};
    const owner = fieldOwner.get(n);
    if (owner) return {kind: 'field', ref: `${owner}.${n}`};
    if (metricNames.has(n)) return {kind: 'metric', ref: n};
    return undefined;
  };

  const related = new Map<string, Set<string>>();
  const relate = (a: string, b: string) => {
    if (a === b || !idOf.has(a) || !idOf.has(b)) return;
    const s = related.get(a) ?? new Set<string>();
    s.add(idOf.get(b)!);
    related.set(a, s);
  };
  for (const c of concepts) {
    for (const r of iris(c, `${SKOS}related`)) {
      relate(c, r);
      relate(r, c);
    }
  }

  for (const c of concepts) {
    const term: GlossaryTerm = {id: idOf.get(c)!};
    const label = best(c, `${SKOS}prefLabel`, `${RDFS}label`);
    if (label) term.displayName = label;
    const def = best(c, `${SKOS}definition`, `${RDFS}comment`,
                     `${DCTERMS}description`);
    if (def) term.definition = def;
    const syn = [...new Set([...lits(c, `${SKOS}altLabel`),
                             ...lits(c, `${SKOS}hiddenLabel`)]
                                .filter(l => !l.lang ||
                                        l.lang.toLowerCase().startsWith('en'))
                                .map(l => l.value.trim())
                                .filter(v => v && v !== label))];
    if (syn.length) term.synonyms = syn;
    const scheme = [...iris(c, `${SKOS}inScheme`), ...iris(c, `${SKOS}topConceptOf`)]
                       .find(s => categoryOf.has(s));
    if (scheme) term.category = categoryOf.get(scheme);
    const rel = related.get(c);
    if (rel?.size) term.related = [...rel].sort();
    const defines: GlossaryDefines[] = [];
    const seen = new Set<string>();
    const add = (d: GlossaryDefines|undefined) => {
      if (!d || seen.has(`${d.kind}:${d.ref}`)) return;
      seen.add(`${d.kind}:${d.ref}`);
      defines.push(d);
    };
    add(definesOf(c));
    for (const p of DEFINES_PREDICATES) {
      for (const o of iris(c, p)) {
        const d = definesOf(o);
        add(d);
        if (!d && p === `${DCTERMS}subject`) {
          warnings.push(`skos concept '${localName(c)}': dcterms:subject ` +
              `'${localName(o)}' names no imported class or property; ` +
              `not linked`);
        }
      }
    }
    if (defines.length) term.defines = defines;
    const src = best(c, `${DCTERMS}source`) ?? iris(c, `${DCTERMS}source`)[0];
    if (src) term.source = src;
    glossary.terms.push(term);
  }

  // A glossary is emitted, so every imported kcmd:Metric that no concept
  // already defines gets a term of its own that defines it: display name
  // from skos:prefLabel / rdfs:label, definition from skos:definition (else
  // rdfs:comment / dcterms:description), synonyms from skos:altLabel.
  const definedMetrics = new Set(glossary.terms.flatMap(
      t => (t.defines ?? []).filter(d => d.kind === 'metric').map(d => d.ref)));
  for (const [s, t] of types) {
    if (!t.has(KCMD_METRIC) || t.has(CONCEPT)) continue;
    const name = localName(s);
    if (!metricNames.has(name) || definedMetrics.has(name)) continue;
    definedMetrics.add(name);
    const term: GlossaryTerm = {id: claim(s)};
    const label = best(s, `${SKOS}prefLabel`, `${RDFS}label`);
    if (label) term.displayName = label;
    const def = best(s, `${SKOS}definition`, `${RDFS}comment`,
                     `${DCTERMS}description`);
    if (def) term.definition = def;
    const syn = [...new Set(lits(s, `${SKOS}altLabel`)
                                .filter(l => !l.lang ||
                                        l.lang.toLowerCase().startsWith('en'))
                                .map(l => l.value.trim())
                                .filter(v => v && v !== label))];
    if (syn.length) term.synonyms = syn;
    term.defines = [{kind: 'metric', ref: name}];
    glossary.terms.push(term);
  }
  return glossary;
}
