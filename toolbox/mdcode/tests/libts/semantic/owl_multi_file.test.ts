// Behavior specification for the multi-file OWL import: `kcmd owl import
// a.ttl b.ttl ...` merges several Turtle modules of one ontology into one
// model, and follows an `owl:imports` to a local file that declares the
// imported ontology (converters/owl/imports.ts). See the user guide section
// "Importing a modular ontology (several files)".

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {collectOwlSources} from '../../../src/libts/semantic/converters/owl/imports';
import {loadModels} from '../../../src/libts/semantic/loader';
import {owl} from '../../../src/tool/commands';

const MODULAR = path.join(__dirname, 'fixtures', 'owl', 'modular');

function readModule(name: string): string {
  return fs.readFileSync(path.join(MODULAR, name), 'utf8');
}

function load(text: string) {
  return loadModels(text, {bindingOptional: true}).models[0];
}

const PREFIXES = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
`;


describe('several Turtle documents merge into one model', () => {
  const docs = [readModule('commercial.ttl'), readModule('core.ttl')];

  test('produces exactly the documented OSI (golden)', () => {
    const {yaml: text} = convertOwlToOsi(docs, 'commercial');
    expect(text).toEqual(readModule('modular.osi.golden.yaml'));
  });

  test('cross-file references resolve, with no warnings', () => {
    const {yaml: text, warnings, stats} = convertOwlToOsi(docs, 'commercial');
    // Every reference crosses the file boundary and still resolves: nothing
    // is skipped as "not an owl:Class in this ontology".
    expect(warnings).toEqual([]);
    expect(stats).toEqual(
        {classes: 3, datatypeProperties: 5, objectProperties: 2});
    const model = load(text);
    const byName = Object.fromEntries(model.entities.map(e => [e.name, e]));
    // subClassOf a class declared in the other file.
    expect(byName['ClientAccount'].extends).toEqual(['Party']);
    // A datatype property in commercial.ttl whose domain is core:Party.
    expect(byName['Party'].fields.map(f => f.name)).toContain('accountTier');
    // An edge whose range is declared in the other file.
    const ownedBy = model.relationships.find(r => r.name === 'ownedBy')!;
    expect(ownedBy.destination.entity).toBe('Party');
  });

  test('the first document header describes the model', () => {
    // The root module comes first; a dependency's header does not override
    // it.
    const model = load(convertOwlToOsi(docs, 'commercial').yaml);
    expect(model.description)
        .toBe(
            'Commercial domain: client accounts and the opportunities they buy.');
    const reversed = load(convertOwlToOsi([...docs].reverse(), 'core').yaml);
    expect(reversed.description).toBe('Shared upper classes.');
  });

  test('a single-element array converts exactly like the string form', () => {
    const one = readModule('core.ttl');
    expect(convertOwlToOsi([one], 'core').yaml)
        .toEqual(convertOwlToOsi(one, 'core').yaml);
  });

  test('the base namespace is the dominant one across all files', () => {
    // No header: the description names the base IRI. Module a has one term,
    // module b three, so b's namespace wins even though a comes first.
    const a = `${PREFIXES} @prefix a: <http://example.com/a#> .
      a:Thing a owl:Class .`;
    const b = `${PREFIXES} @prefix b: <http://example.com/b#> .
      b:One a owl:Class . b:Two a owl:Class . b:Three a owl:Class .`;
    expect(load(convertOwlToOsi([a, b], 'x').yaml).description)
        .toBe('Imported from OWL ontology http://example.com/b#');
  });

  test('blank-node labels are scoped per document', () => {
    // Both modules spell their owl:hasKey list with the same blank label
    // `_:k`. Merged naively the two lists would fuse into one node; scoped
    // per document each class keeps its own key.
    const a = `${PREFIXES} @prefix ex: <http://example.com/x#> .
      ex:A a owl:Class ; owl:hasKey _:k .
      _:k rdf:first ex:aId ; rdf:rest rdf:nil .
      ex:aId a owl:DatatypeProperty ; rdfs:domain ex:A ; rdfs:range xsd:string .`;
    const b = `${PREFIXES} @prefix ex: <http://example.com/x#> .
      ex:B a owl:Class ; owl:hasKey _:k .
      _:k rdf:first ex:bId ; rdf:rest rdf:nil .
      ex:bId a owl:DatatypeProperty ; rdfs:domain ex:B ; rdfs:range xsd:string .`;
    const model = load(convertOwlToOsi([a, b], 'x').yaml);
    const byName = Object.fromEntries(model.entities.map(e => [e.name, e]));
    expect(byName['A'].keys).toEqual(['aId']);
    expect(byName['B'].keys).toEqual(['bId']);
  });

  test('a class declared in two modules is one entity', () => {
    // A module may re-declare an upper class it annotates; the same IRI is
    // the same class, so it is neither duplicated nor warned about.
    const a = `${PREFIXES} @prefix ex: <http://example.com/x#> .
      ex:Party a owl:Class ; rdfs:comment "A party." .`;
    const b = `${PREFIXES} @prefix ex: <http://example.com/x#> .
      ex:Party a owl:Class .
      ex:Client a owl:Class ; rdfs:subClassOf ex:Party .`;
    const {yaml: text, warnings} = convertOwlToOsi([a, b], 'x');
    expect(warnings).toEqual([]);
    const model = load(text);
    expect(model.entities.map(e => e.name)).toEqual(['Party', 'Client']);
  });
});


describe('owl:imports is followed to local files only', () => {
  function tmpdir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'owl-imports-'));
  }

  test('an import resolves to a file beside the importer named after the IRI',
       () => {
         const dir = tmpdir();
         fs.writeFileSync(
             path.join(dir, 'commercial.ttl'), readModule('commercial.ttl'));
         fs.writeFileSync(path.join(dir, 'core.ttl'), readModule('core.ttl'));
         const {sources, warnings} =
             collectOwlSources([path.join(dir, 'commercial.ttl')]);
         expect(warnings).toEqual([]);
         expect(sources.map(s => path.basename(s.path))).toEqual([
           'commercial.ttl', 'core.ttl'
         ]);
       });

  test('an import already given on the command line is not read twice', () => {
    const dir = tmpdir();
    fs.writeFileSync(
        path.join(dir, 'commercial.ttl'), readModule('commercial.ttl'));
    // Named differently from the IRI's last segment: satisfied because its
    // owl:Ontology IRI matches, not because of its file name.
    fs.writeFileSync(path.join(dir, 'upper.ttl'), readModule('core.ttl'));
    const {sources, warnings} = collectOwlSources([
      path.join(dir, 'commercial.ttl'), path.join(dir, 'upper.ttl')
    ]);
    expect(warnings).toEqual([]);
    expect(sources.map(s => path.basename(s.path))).toEqual([
      'commercial.ttl', 'upper.ttl'
    ]);
  });

  test('a same-named file that declares another ontology is not taken', () => {
    const dir = tmpdir();
    fs.writeFileSync(
        path.join(dir, 'commercial.ttl'), readModule('commercial.ttl'));
    fs.writeFileSync(
        path.join(dir, 'core.ttl'),
        `${PREFIXES} <http://example.com/somethingElse> a owl:Ontology .`);
    const {sources, warnings} =
        collectOwlSources([path.join(dir, 'commercial.ttl')]);
    expect(sources).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('<http://example.com/core>');
    expect(warnings[0]).toContain('did not resolve');
  });

  test('imports are followed transitively and a cycle terminates', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'a.ttl'), `${PREFIXES}
      <http://example.com/a> a owl:Ontology ; owl:imports <http://example.com/b> .`);
    fs.writeFileSync(path.join(dir, 'b.ttl'), `${PREFIXES}
      <http://example.com/b> a owl:Ontology ; owl:imports <http://example.com/c> .`);
    fs.writeFileSync(path.join(dir, 'c.ttl'), `${PREFIXES}
      <http://example.com/c> a owl:Ontology ; owl:imports <http://example.com/a> .`);
    const {sources, warnings} = collectOwlSources([path.join(dir, 'a.ttl')]);
    expect(warnings).toEqual([]);
    expect(sources.map(s => path.basename(s.path))).toEqual([
      'a.ttl', 'b.ttl', 'c.ttl'
    ]);
  });
});


describe('the owl import handler takes several files and --name', () => {
  test('follows the import and names the model after the first file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-multi-'));
    fs.writeFileSync(
        path.join(dir, 'commercial.ttl'), readModule('commercial.ttl'));
    fs.writeFileSync(path.join(dir, 'core.ttl'), readModule('core.ttl'));
    const out = path.join(dir, 'out.yaml');
    expect(await owl('import', [path.join(dir, 'commercial.ttl')], {out}))
        .toBe(0);
    const doc = yaml.parse(fs.readFileSync(out, 'utf8'));
    expect(doc.semantic_model[0].name).toBe('commercial');
    // core.ttl's Party arrived through owl:imports.
    expect(doc.semantic_model[0].entities.map((e: any) => e.name))
        .toContain('Party');
  });

  test('--name overrides the file-derived model name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-multi-'));
    const commercial = path.join(dir, 'commercial.ttl');
    const core = path.join(dir, 'core.ttl');
    fs.writeFileSync(commercial, readModule('commercial.ttl'));
    fs.writeFileSync(core, readModule('core.ttl'));
    const out = path.join(dir, 'out.yaml');
    expect(await owl('import', [core, commercial], {out, name: 'ps_commercial'}))
        .toBe(0);
    const doc = yaml.parse(fs.readFileSync(out, 'utf8'));
    expect(doc.semantic_model[0].name).toBe('ps_commercial');
    // core came first, so its header describes the model.
    expect(doc.semantic_model[0].description).toBe('Shared upper classes.');
  });

  test('a missing file fails before anything is written', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-multi-'));
    const core = path.join(dir, 'core.ttl');
    fs.writeFileSync(core, readModule('core.ttl'));
    const out = path.join(dir, 'out.yaml');
    expect(await owl('import', [core, path.join(dir, 'nope.ttl')], {out}))
        .toBe(1);
    expect(fs.existsSync(out)).toBe(false);
  });
});
