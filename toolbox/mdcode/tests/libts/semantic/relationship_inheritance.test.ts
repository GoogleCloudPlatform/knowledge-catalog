// Behavior specification for relationship inheritance: a relationship's
// `extends` (its super-relationships) and `abstract` (a label-only
// super-relationship with no edge table), extended (`/google`) profile only.
//
// Pinned end to end, in pipeline order:
//   1. the loader accepts the keys only under the extended profile, rejects an
//      abstract relationship that binds join columns, and lints dangling
//      parents, cycles, and sub-relationships whose endpoints do not fit
//      their parent's (warnings, never throws);
//   2. validate turns a dangling parent into a push error and exempts an
//      abstract relationship from the graph join-column requirement;
//   3. the BigQuery and Spanner generators give an abstract relationship no
//      edge table and label every concrete edge with each transitive
//      ancestor (`LABEL <ancestor> NO PROPERTIES`), so
//      `MATCH ()-[e:hasCounterparty]->()` reaches every descendant's edges;
//   4. the OSI serializer round-trips both keys;
//   5. Knowledge Catalog: an abstract relationship publishes no link; a
//      concrete one names its parents on its schema-join description, and
//      pull restores `extends` when the parent itself was published.

import {describe, expect, test} from 'bun:test';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {relationshipAncestors, SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources, splitSpecializes} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';
import {generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

const TARGET =
    '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/deals';

// Two concrete counterparty edges (from two different tables) under one
// abstract `hasCounterparty`, whose endpoint types are an abstract
// CommercialDocument and the concrete Organization.
function dealsYaml(opts: {version?: string; extra?: string} = {}): string {
  return `
version: ${opts.version ?? '0.2.0.dev0/google'}
semantic_model:
  - name: deals
    deployment_target: ${TARGET}
    datasets:
      - name: CommercialDocument
        abstract: true
      - name: Opportunity
        source: p.d.opportunity
        extends: [CommercialDocument]
        primary_key: [opp_id]
        fields:
          - {name: opp_id, expression: opp_id}
          - {name: buyer_id, expression: buyer_id}
      - name: Invoice
        source: p.d.invoice
        extends: [CommercialDocument]
        primary_key: [inv_id]
        fields:
          - {name: inv_id, expression: inv_id}
          - {name: payer_id, expression: payer_id}
      - name: Organization
        source: p.d.org
        primary_key: [org_id]
        fields:
          - {name: org_id, expression: org_id}
    relationships:
      - name: hasCounterparty
        from: CommercialDocument
        to: Organization
        abstract: true
        description: The organization on the other side of a document.
      - name: hasBuyer
        from: Opportunity
        to: Organization
        extends: [hasCounterparty]
        from_columns: [buyer_id]
        to_columns: [org_id]
        description: Who is buying.
      - name: hasPayer
        from: Invoice
        to: Organization
        extends: [hasCounterparty]
        from_columns: [payer_id]
        to_columns: [org_id]
${opts.extra ?? ''}`;
}

function dealsModel(): SemanticModel {
  return loadModels(dealsYaml()).models[0];
}

describe('loader', () => {
  test('carries extends / abstract onto the IR relationship', () => {
    const model = dealsModel();
    const byName = Object.fromEntries(model.relationships.map(r => [r.name, r]));
    expect(byName['hasBuyer'].extends).toEqual(['hasCounterparty']);
    expect(byName['hasBuyer'].abstract).toBeUndefined();
    expect(byName['hasCounterparty'].abstract).toBe(true);
    expect(byName['hasCounterparty'].source.columns).toEqual([]);
  });

  test('the keys are extended-profile only (vanilla Ossie rejects them)', () => {
    expect(() => loadModels(dealsYaml({version: '0.2.0.dev0'})))
        .toThrow(/Semantic model load error/);
  });

  test('an abstract relationship that binds join columns is rejected', () => {
    const text = dealsYaml().replace(
        '        abstract: true\n        description: The organization',
        '        abstract: true\n        from_columns: [x]\n        to_columns: [y]\n' +
            '        description: The organization');
    expect(() => loadModels(text)).toThrow(/an abstract relationship has no edge/);
  });

  test('a dangling parent is a warning, not a throw', () => {
    const text = dealsYaml().replace(
        'extends: [hasCounterparty]\n        from_columns: [payer_id]',
        'extends: [hasCountreparty]\n        from_columns: [payer_id]');
    const {warnings} = loadModels(text);
    expect(warnings).toContain(
        `relationship 'hasPayer': extends 'hasCountreparty', which is not a ` +
        `relationship in the model`);
  });

  test('a cycle is a warning, not a throw', () => {
    const text = dealsYaml().replace(
        '        abstract: true\n        description: The organization',
        '        abstract: true\n        extends: [hasBuyer]\n' +
            '        description: The organization');
    const {warnings} = loadModels(text);
    expect(warnings.some(
               w => w.startsWith(`relationship 'hasBuyer'`) &&
                   w.includes('cyclic')))
        .toBe(true);
  });

  test(
      'a sub-relationship whose endpoint does not fit its parent\'s is warned',
      () => {
        // Organization -> Organization under CommercialDocument ->
        // Organization: Organization is not a CommercialDocument.
        const text = dealsYaml({
          extra: `      - name: partnerOf
        from: Organization
        to: Organization
        extends: [hasCounterparty]
        from_columns: [org_id]
        to_columns: [org_id]
`,
        });
        const {warnings} = loadModels(text);
        expect(warnings.some(
                   w => w.startsWith(`relationship 'partnerOf': source`) &&
                       w.includes(`not 'CommercialDocument' or a subtype`)))
            .toBe(true);
      });

  test('relationshipAncestors walks the transitive closure, nearest first', () => {
    const model = dealsModel();
    model.relationships.push({
      name: 'hasKeyBuyer',
      source: {entity: 'Opportunity', columns: ['buyer_id']},
      destination: {entity: 'Organization', columns: ['org_id']},
      extends: ['hasBuyer'],
    });
    expect(relationshipAncestors(model.relationships, 'hasKeyBuyer'))
        .toEqual(['hasBuyer', 'hasCounterparty']);
    expect(relationshipAncestors(model.relationships, 'hasCounterparty'))
        .toEqual([]);
  });
});

describe('validate', () => {
  test('an abstract relationship needs no join columns for a graph push', () => {
    const errors =
        validatePushRequirements([{document: 'deals', model: dealsModel()}]);
    expect(errors).toEqual([]);
  });

  test('a dangling parent is a push error (KC-only included)', () => {
    const model = dealsModel();
    model.relationships[1].extends = ['nope'];
    const errors = validatePushRequirements(
        [{document: 'deals', model}], {targetOptional: true});
    expect(errors.some(
               e => e.includes(`relationship 'hasBuyer'`) &&
                   e.includes(`extends 'nope', which is not a relationship`)))
        .toBe(true);
  });
});

describe('BigQuery graph', () => {
  const OPTS = {project: 'p', dataset: 'd'};

  test('an abstract relationship forms no edge table', () => {
    const {ddl} = generatePropertyGraph(dealsModel(), OPTS);
    expect(ddl).not.toContain('AS hasCounterparty');
  });

  test('each concrete edge carries its ancestor as a NO PROPERTIES label', () => {
    const {ddl} = generatePropertyGraph(dealsModel(), OPTS);
    // Both edge tables, over two different source tables, bind the shared
    // label -- which is what makes a hasCounterparty match span them.
    const blocks = ddl.split(/,\n(?=  `)/);
    for (const alias of ['hasBuyer', 'hasPayer']) {
      const block = blocks.find(b => b.includes(`AS ${alias}\n`))!;
      expect(block).toContain('DEFAULT LABEL');
      expect(block).toContain('LABEL hasCounterparty NO PROPERTIES');
    }
  });

  test('the full DDL is the validated shape', () => {
    // The edge's own DEFAULT LABEL says NO PROPERTIES too: left bare it would
    // default to ALL COLUMNS and leak the opportunity table's columns onto the
    // edge (see fix/bq-edge-no-properties).
    const {ddl} = generatePropertyGraph(dealsModel(), OPTS);
    expect(ddl).toContain(
        '  `p.d.opportunity` AS hasBuyer\n' +
        '    KEY(opp_id)\n' +
        '    SOURCE KEY(opp_id) REFERENCES Opportunity(opp_id)\n' +
        '    DESTINATION KEY(buyer_id) REFERENCES Organization(org_id)\n' +
        '    DEFAULT LABEL\n' +
        '    OPTIONS(description="Who is buying.")\n' +
        '    NO PROPERTIES\n' +
        '    LABEL hasCounterparty NO PROPERTIES');
  });

  test('an edge outside any hierarchy is unchanged', () => {
    const model = dealsModel();
    for (const r of model.relationships) delete r.extends;
    model.relationships = model.relationships.filter(r => !r.abstract);
    const {ddl} = generatePropertyGraph(model, OPTS);
    expect(ddl).not.toContain('LABEL hasCounterparty');
    expect(ddl).toContain(
        '    DESTINATION KEY(buyer_id) REFERENCES Organization(org_id)\n' +
        '    OPTIONS(description="Who is buying.")\n' +
        '    NO PROPERTIES');
  });

  test(
      'a concrete super-relationship shares its label: NO PROPERTIES, ' +
          'OPTIONS dropped with a warning',
      () => {
        const model = dealsModel();
        // hasBuyer becomes a concrete parent of a narrower hasKeyBuyer.
        model.relationships.push({
          name: 'hasKeyBuyer',
          source: {entity: 'Opportunity', columns: ['buyer_id']},
          destination: {entity: 'Organization', columns: ['org_id']},
          extends: ['hasBuyer'],
        });
        const {ddl, warnings} = generatePropertyGraph(model, OPTS);
        expect(ddl).not.toContain('Who is buying.');
        expect(warnings.some(
                   w => w.includes(`relationship 'hasBuyer' is a ` +
                                   `super-relationship`)))
            .toBe(true);
        const keyBuyer = ddl.split(/,\n(?=  `)/)
                             .find(b => b.includes('AS hasKeyBuyer\n'))!;
        // Transitive: both ancestors, nearest first.
        expect(keyBuyer).toContain(
            '    LABEL hasBuyer NO PROPERTIES\n' +
            '    LABEL hasCounterparty NO PROPERTIES');
        const buyer = ddl.split(/,\n(?=  `)/)
                          .find(b => b.includes('AS hasBuyer\n'))!;
        expect(buyer).toContain('DEFAULT LABEL\n    NO PROPERTIES');
      });

  test('an abstract relationship nobody extends is warned', () => {
    const model = dealsModel();
    model.relationships.push({
      name: 'ghostLink',
      source: {entity: 'Organization', columns: []},
      destination: {entity: 'Organization', columns: []},
      abstract: true,
    });
    const {ddl, warnings} = generatePropertyGraph(model, OPTS);
    expect(ddl).not.toContain('ghostLink');
    expect(warnings.some(w => w.includes(`abstract relationship 'ghostLink'`)))
        .toBe(true);
  });
});

describe('Spanner graph', () => {
  test('abstract relationships form no edge; ancestors are labels', () => {
    const {ddl} = generateSpannerPropertyGraph(dealsModel(), {});
    expect(ddl).not.toContain('AS hasCounterparty');
    expect(ddl).toContain(
        'opportunity AS hasBuyer\n' +
        '    KEY(opp_id)\n' +
        '    SOURCE KEY(opp_id) REFERENCES Opportunity(opp_id)\n' +
        '    DESTINATION KEY(buyer_id) REFERENCES Organization(org_id)\n' +
        '    DEFAULT LABEL\n' +
        '    NO PROPERTIES\n' +
        '    LABEL hasCounterparty NO PROPERTIES');
  });
});

describe('OSI serialization', () => {
  test('extends / abstract round-trip', () => {
    const {yaml} = serializeModel(dealsModel());
    expect(yaml).toContain('abstract: true');
    const again = loadModels(yaml).models[0];
    expect(again.relationships).toEqual(dealsModel().relationships);
  });
});

describe('Knowledge Catalog', () => {
  const OPTS = {project: 'dest', location: 'us', entryGroup: 'eg'};

  test('an abstract relationship publishes no link, with a warning', () => {
    const {entryLinks, warnings} =
        generateCatalogResources(dealsModel(), OPTS);
    expect(entryLinks.some(l => l.name!.includes('hascounterparty'))).toBe(false);
    expect(warnings.some(
               w => w.includes(`relationship 'hasCounterparty' is abstract`)))
        .toBe(true);
  });

  test('a sub-relationship names its parents on the join description', () => {
    const {entryLinks} = generateCatalogResources(dealsModel(), OPTS);
    const buyer = entryLinks.find(l => l.name!.endsWith('hasbuyer'))!;
    const join = (Object.values(buyer.aspects!)[0] as any).data.joins[0];
    expect(join.description).toBe('Who is buying.\n\nSpecializes: hasCounterparty.');
    const payer = entryLinks.find(l => l.name!.endsWith('haspayer'))!;
    expect((Object.values(payer.aspects!)[0] as any).data.joins[0].description)
        .toBe('Specializes: hasCounterparty.');
  });

  test(
      'pull strips the line and drops a parent that published no link ' +
          '(an abstract one), with a warning',
      () => {
        const {entries, entryLinks} =
            generateCatalogResources(dealsModel(), OPTS);
        const {models, warnings} =
            modelsFromCatalogResources(entries, entryLinks);
        const buyer = models[0].relationships.find(r => r.name === 'hasbuyer')!;
        expect(buyer.description).toBe('Who is buying.');
        expect(buyer.extends).toBeUndefined();
        expect(warnings.some(
                   w => w.includes(`specializes 'hasCounterparty'`) &&
                       w.includes('dropped')))
            .toBe(true);
      });

  test('pull restores extends when the parent itself is published', () => {
    const model = dealsModel();
    model.relationships.push({
      name: 'hasKeyBuyer',
      source: {entity: 'Opportunity', columns: ['buyer_id']},
      destination: {entity: 'Organization', columns: ['org_id']},
      extends: ['hasBuyer'],
    });
    const {entries, entryLinks} = generateCatalogResources(model, OPTS);
    const {models} = modelsFromCatalogResources(entries, entryLinks);
    const keyBuyer =
        models[0].relationships.find(r => r.name === 'haskeybuyer')!;
    // The parent is recovered under its (link-slugged) pulled name.
    expect(keyBuyer.extends).toEqual(['hasbuyer']);
  });

  test('splitSpecializes leaves an ordinary description alone', () => {
    expect(splitSpecializes('Plain text.'))
        .toEqual({description: 'Plain text.', parents: []});
    expect(splitSpecializes('Specializes: a, b.'))
        .toEqual({description: undefined, parents: ['a', 'b']});
  });
});
