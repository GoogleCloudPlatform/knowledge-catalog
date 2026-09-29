// Relationship inverses (`inverse:`, the native home of OWL owl:inverseOf).
//
// An inverse is the SAME edge read backwards: one relationship, one join, and a
// second name. These tests pin each leg of that contract:
//   * loader  -- `/google`-only key; self-inverse and name clashes rejected;
//   * BigQuery / Spanner -- a second edge table over the same backing table
//     with SOURCE / DESTINATION swapped (FK and association edges alike), no
//     OPTIONS on the inverse label, clash omitted with a warning for IR that
//     skipped the loader;
//   * OSI serializer -- `inverse` round-trips through the document;
//   * Knowledge Catalog -- the `Inverse: <name>.` trailer on the join
//     description, parsed back on pull.

import {describe, expect, test} from 'bun:test';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources, splitInverse} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';
import {generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';

const GOOGLE = '0.2.0.dev0/google';

// A bound two-entity model: Opportunity -[hasBuyer]-> Client, with the
// inverse hasOpportunity (Client -> Opportunity). `extra` is spliced into the
// relationship; `version` selects the profile.
function doc(extra = '  inverse: hasOpportunity', version = GOOGLE): string {
  return `version: ${version}
semantic_model:
  - name: deals
    datasets:
      - name: Client
        source: proj.ds.client
        primary_key: [client_id]
        fields:
          - { name: client_id, expression: client_id }
          - { name: name, expression: name }
      - name: Opportunity
        source: proj.ds.opportunity
        primary_key: [opportunity_id]
        fields:
          - { name: opportunity_id, expression: opportunity_id }
          - { name: client_id, expression: client_id }
    relationships:
      - name: hasBuyer
        from: Opportunity
        to: Client
        from_columns: [client_id]
        to_columns: [client_id]
        description: The client buying the opportunity.
      ${extra}
`;
}

function load(text: string): SemanticModel {
  return loadModels(text).models[0];
}

// The edge-table block whose alias is `alias` (up to the next alias line).
function edgeBlock(ddl: string, alias: string): string {
  const lines = ddl.split('\n');
  const start = lines.findIndex(l => new RegExp(` AS ${alias}\\b`).test(l));
  expect(start).toBeGreaterThanOrEqual(0);
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/ AS \w+$/.test(lines[i]) || /^\s*\)/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

describe('loader: relationship inverse', () => {
  test('the /google profile accepts inverse and carries it into the IR', () => {
    const model = load(doc());
    expect(model.relationships[0].inverse).toBe('hasOpportunity');
  });

  test('a model with no inverse loads exactly as before', () => {
    const model = load(doc(''));
    expect(model.relationships[0].inverse).toBeUndefined();
  });

  test('vanilla Ossie rejects inverse (an extension key)', () => {
    expect(() => loadModels(doc(undefined, '0.2.0.dev0'))).toThrow(/inverse/);
  });

  test('an inverse naming the relationship itself is rejected', () => {
    expect(() => loadModels(doc('  inverse: hasBuyer')))
        .toThrow(/names the relationship itself/);
  });

  test('an inverse repeating an entity name is rejected (case-insensitive)',
       () => {
         expect(() => loadModels(doc('  inverse: client')))
             .toThrow(/graph element names must be unique/);
       });
});

describe('BigQuery: the inverse is a reversed edge table', () => {
  const opts = {project: 'proj', dataset: 'ds'};

  test('a second edge table over the same backing table, ends swapped', () => {
    const {ddl, warnings} = generatePropertyGraph(load(doc()), opts);
    expect(warnings).toEqual([]);
    const fwd = edgeBlock(ddl, 'hasBuyer');
    const inv = edgeBlock(ddl, 'hasOpportunity');
    expect(fwd).toContain('`proj.ds.opportunity` AS hasBuyer');
    expect(inv).toContain('`proj.ds.opportunity` AS hasOpportunity');
    expect(fwd).toMatch(
        /SOURCE KEY\(opportunity_id\) REFERENCES Opportunity\(opportunity_id\)/);
    expect(fwd).toMatch(
        /DESTINATION KEY\(client_id\) REFERENCES Client\(client_id\)/);
    expect(inv).toMatch(/SOURCE KEY\(client_id\) REFERENCES Client\(client_id\)/);
    expect(inv).toMatch(
        /DESTINATION KEY\(opportunity_id\) REFERENCES Opportunity\(opportunity_id\)/);
    // Same edge key on both readings: one set of rows.
    expect(inv).toContain('KEY(opportunity_id)');
  });

  test('the description OPTIONS stay on the forward label only', () => {
    const {ddl} = generatePropertyGraph(load(doc()), opts);
    expect(edgeBlock(ddl, 'hasBuyer')).toContain('OPTIONS');
    expect(edgeBlock(ddl, 'hasOpportunity')).not.toContain('OPTIONS');
  });

  test('no inverse, no second edge table', () => {
    const {ddl} = generatePropertyGraph(load(doc('')), opts);
    expect(ddl).not.toContain('hasOpportunity');
    expect(ddl.match(/`proj\.ds\.opportunity` AS/g)!.length).toBe(2);
  });

  test('an association (M:N) inverse swaps the junction ends', () => {
    const model = load(doc());
    model.relationships[0].association = {
      dataSource: 'proj.ds.opp_client',
      keys: ['opportunity_id', 'client_id'],
      sourceColumns: ['opportunity_id'],
      destinationColumns: ['client_id'],
    };
    const {ddl} = generatePropertyGraph(model, opts);
    const inv = edgeBlock(ddl, 'hasOpportunity');
    expect(inv).toContain('`proj.ds.opp_client` AS hasOpportunity');
    expect(inv).toMatch(/SOURCE KEY\(client_id\) REFERENCES Client\(client_id\)/);
    expect(inv).toMatch(
        /DESTINATION KEY\(opportunity_id\) REFERENCES Opportunity\(opportunity_id\)/);
  });

  test('IR that skipped the loader: a clashing inverse is omitted, warned',
       () => {
         const model = load(doc(''));
         model.relationships[0].inverse = 'Client';
         const {ddl, warnings} = generatePropertyGraph(model, opts);
         expect(ddl.match(/`proj\.ds\.opportunity` AS/g)!.length).toBe(2);
         expect(warnings.join('\n')).toMatch(/inverse 'Client' repeats/);
       });
});

describe('Spanner: the inverse is a reversed edge table', () => {
  test('bare names, ends swapped', () => {
    const {ddl} = generateSpannerPropertyGraph(load(doc()));
    const inv = edgeBlock(ddl, 'hasOpportunity');
    expect(inv).toContain('opportunity AS hasOpportunity');
    expect(inv).toMatch(/SOURCE KEY\(client_id\) REFERENCES Client\(client_id\)/);
    expect(inv).toMatch(
        /DESTINATION KEY\(opportunity_id\) REFERENCES Opportunity\(opportunity_id\)/);
  });
});

describe('OSI serializer: inverse round-trips', () => {
  test('serialize -> load keeps the inverse', () => {
    const model = load(doc());
    const text = serializeModel(model).yaml;
    expect(text).toContain('inverse: hasOpportunity');
    expect(load(text).relationships[0].inverse).toBe('hasOpportunity');
  });
});

describe('Knowledge Catalog: the Inverse trailer', () => {
  const OPTS = {project: 'dest', location: 'us', entryGroup: 'eg'};

  function joinDescription(model: SemanticModel): string|undefined {
    const {entryLinks} = generateCatalogResources(model, OPTS);
    const link = entryLinks.find(l => l.aspects);
    const aspect = Object.values(link!.aspects!)[0] as any;
    return aspect.data.joins[0].description;
  }

  test('push appends the inverse to the join description', () => {
    expect(joinDescription(load(doc())))
        .toBe('The client buying the opportunity.\n\nInverse: hasOpportunity.');
  });

  test('push without an inverse leaves the description untouched', () => {
    expect(joinDescription(load(doc('')))).toBe(
        'The client buying the opportunity.');
  });

  test('pull restores inverse and the original description', () => {
    const {entries, entryLinks} = generateCatalogResources(load(doc()), OPTS);
    const {models} = modelsFromCatalogResources(entries, entryLinks);
    const rel = models[0].relationships[0];
    expect(rel.inverse).toBe('hasOpportunity');
    expect(rel.description).toBe('The client buying the opportunity.');
  });

  test('splitInverse reads only a final trailer paragraph', () => {
    expect(splitInverse('Inverse: x.')).toEqual({inverse: 'x'});
    expect(splitInverse('A.\n\nInverse: x.'))
        .toEqual({description: 'A.', inverse: 'x'});
    // Mid-text mentions and other shapes are ordinary prose.
    expect(splitInverse('Inverse: x. More.'))
        .toEqual({description: 'Inverse: x. More.'});
    expect(splitInverse('See the Inverse: x.'))
        .toEqual({description: 'See the Inverse: x.'});
  });
});
