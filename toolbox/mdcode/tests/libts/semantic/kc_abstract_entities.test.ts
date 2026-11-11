// Behavior specification for abstract entities and entity inheritance on the
// Knowledge Catalog V2 leg (src/libts/semantic/knowledge_catalog.ts for push,
// src/libts/semantic/kc_converter.ts for pull).
//
// An abstract entity (a table-less supertype) publishes as a semantic-entity
// entry with `abstract: true` in `semantic-entity`, its own fields in `schema`,
// and no source or primaryKey. `extends` and `abstract` also appear in the
// entry description as fixed trailing paragraphs (`Specializes: <parents>.`
// then `Abstract: no table of its own.`), which pull peels back off cleanly.

import {beforeAll, describe, expect, test} from 'bun:test';

import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources, splitEntityTrailers} from '../../../src/libts/semantic/kc_converter';
import {ABSTRACT_MARKER, generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';
import {loadSqlEngine} from '../../../src/libts/semantic/sql_parser';

beforeAll(loadSqlEngine);

const OPTS = {project: 'dest-proj', location: 'us', entryGroup: 'eg'};

const ENTITY = 'dataplex-types.global.semantic-entity';
const SCHEMA = 'dataplex-types.global.schema';

// Party (abstract) <- Customer (concrete, with its own description), plus a
// concrete Order with an edge to Customer and one to Party.
function model(): SemanticModel {
  return {
    name: 'm',
    version: '0.2.0.dev0/google',
    entities: [
      {
        name: 'Party',
        dataSource: '',
        keys: [],
        abstract: true,
        description: 'Anyone we do business with.',
        fields: [{name: 'partyName', type: 'String'}],
      },
      {
        name: 'Customer',
        authoredSource: 'bigquery.googleapis.com/projects/p/datasets/d/tables/customer',
        dataSource: 'p.d.customer',
        keys: ['id'],
        extends: ['Party'],
        description: 'A buying party.',
        fields: [
          {name: 'id', type: 'String', expression: 'id'},
          {name: 'partyName', type: 'String', expression: 'name'},
        ],
      },
      {
        name: 'Order',
        authoredSource: 'bigquery.googleapis.com/projects/p/datasets/d/tables/order',
        dataSource: 'p.d.order',
        keys: ['id'],
        fields: [
          {name: 'id', type: 'String', expression: 'id'},
          {name: 'customerId', type: 'String', expression: 'customer_id'},
        ],
      },
    ],
    relationships: [
      {
        name: 'placedBy',
        source: {entity: 'Order', columns: ['customerId']},
        destination: {entity: 'Customer', columns: ['id']},
      },
      {
        name: 'involves',
        source: {entity: 'Order', columns: ['customerId']},
        destination: {entity: 'Party', columns: ['id']},
      },
    ],
    metrics: [],
  };
}

const entryOf = (entries: any[], name: string) =>
    entries.find(e => e.entrySource?.displayName === name);


describe('push: an abstract entity is published', () => {
  test('as a table-less semantic-entity entry with its own fields', () => {
    const {entries} = generateCatalogResources(model(), OPTS);
    const party = entryOf(entries, 'Party');
    expect(party).toBeDefined();
    expect(party.entryType).toEndWith('/semantic-entity');
    expect(party.aspects[ENTITY].data).toEqual({abstract: true});
    expect(party.aspects[SCHEMA].data).toEqual({
      fields: [{name: 'partyName', dataType: 'String', metadataType: 'STRING'}],
    });
  });

  test('with the Abstract marker after its description', () => {
    const {entries} = generateCatalogResources(model(), OPTS);
    expect(entryOf(entries, 'Party').entrySource.description)
        .toBe(`Anyone we do business with.\n\n${ABSTRACT_MARKER}`);
  });

  test('without the "no keys" or "is abstract; skipped" warnings', () => {
    const {warnings} = generateCatalogResources(model(), OPTS);
    expect(warnings.filter(w => w.includes(`'Party'`))).toEqual([]);
  });

  test('an abstract entity with no description carries only the marker', () => {
    const m = model();
    delete m.entities[0].description;
    const {entries} = generateCatalogResources(m, OPTS);
    expect(entryOf(entries, 'Party').entrySource.description)
        .toBe(ABSTRACT_MARKER);
  });
});


describe('push: entity extends', () => {
  test('a subtype carries extends in semantic-entity and a Specializes paragraph', () => {
    const {entries} = generateCatalogResources(model(), OPTS);
    const customer = entryOf(entries, 'Customer');
    expect(customer.aspects[ENTITY].data.extends).toEqual(['Party']);
    expect(customer.entrySource.description)
        .toBe('A buying party.\n\nSpecializes: Party.');
  });

  test('several parents are listed in order', () => {
    const m = model();
    m.entities.push({
      name: 'Auditable', dataSource: '', keys: [], abstract: true, fields: []});
    m.entities[1].extends = ['Party', 'Auditable'];
    const {entries} = generateCatalogResources(m, OPTS);
    expect(entryOf(entries, 'Customer').entrySource.description)
        .toBe('A buying party.\n\nSpecializes: Party, Auditable.');
  });

  test('an entity with neither is unchanged', () => {
    const {entries} = generateCatalogResources(model(), OPTS);
    expect(entryOf(entries, 'Order').entrySource.description).toBeUndefined();
  });
});


describe('push: relationships to an abstract endpoint', () => {
  test('publish as semantic-relationship entries with semantic-link and reference links, without warning', () => {
    const {entries, entryLinks, warnings} =
        generateCatalogResources(model(), OPTS);
    expect(entryOf(entries, 'involves')).toBeDefined();
    expect(entryOf(entries, 'involves').entryType)
        .toEndWith('/semantic-relationship');
    // 2 semantic-links (Order->Customer, Order->Party) + 4 relationship
    // references + 1 extends reference (Customer->Party) = 7 links.
    expect(entryLinks).toHaveLength(7);
    expect(warnings).toEqual([]);
  });
});


describe('pull: extends and abstract are restored', () => {
  function roundTrip(m: SemanticModel) {
    const {entries, entryLinks} = generateCatalogResources(m, OPTS);
    return modelsFromCatalogResources(entries, entryLinks);
  }

  test('the abstract entity, its description, and the subtype extends', () => {
    const {models, warnings} = roundTrip(model());
    const byName = new Map(models[0].entities.map(e => [e.name, e]));
    const party = byName.get('Party')!;
    expect(party.abstract).toBe(true);
    expect(party.description).toBe('Anyone we do business with.');
    expect(party.dataSource).toBe('');
    expect(party.keys).toEqual([]);
    const customer = byName.get('Customer')!;
    expect(customer.extends).toEqual(['Party']);
    expect(customer.description).toBe('A buying party.');
    expect(customer.abstract).toBeUndefined();
    expect(warnings.filter(w => w.includes(`entity 'Party'`))).toEqual([]);
  });

  test('the pulled model loads strictly (abstract needs no source)', () => {
    const {models} = roundTrip(model());
    const {yaml} = serializeModel(models[0]);
    const loaded = loadModels(yaml).models[0];
    const party = loaded.entities.find(e => e.name === 'Party')!;
    expect(party.abstract).toBe(true);
    expect(loaded.entities.find(e => e.name === 'Customer')!.extends)
        .toEqual(['Party']);
  });

  test('push -> pull -> push is a fixed point for entity entries', () => {
    const first = generateCatalogResources(model(), OPTS);
    const {models} =
        modelsFromCatalogResources(first.entries, first.entryLinks);
    const second = generateCatalogResources(models[0], OPTS);
    const entities = (es: any[]) =>
        es.filter(e => e.entryType.endsWith('/semantic-entity'))
            .map(e => [e.name, e.entrySource.description, e.aspects[ENTITY]])
            .sort();
    expect(entities(second.entries)).toEqual(entities(first.entries));
  });

  test('a parent the pull did not recover is dropped with a warning', () => {
    const {entries, entryLinks} = generateCatalogResources(model(), OPTS);
    const withoutParty =
        entries.filter(e => e.entrySource?.displayName !== 'Party');
    const {models, warnings} =
        modelsFromCatalogResources(withoutParty, entryLinks);
    const customer = models[0].entities.find(e => e.name === 'Customer')!;
    expect(customer.extends).toBeUndefined();
    expect(warnings).toContain(
        `entity 'Customer' specializes 'Party', which this pull did not ` +
        `recover; 'extends: [Party]' is dropped`);
  });
});


describe('splitEntityTrailers', () => {
  test('peels Abstract, then Specializes, from the end', () => {
    expect(splitEntityTrailers(
               `Text.\n\nSpecializes: A, B.\n\n${ABSTRACT_MARKER}`))
        .toEqual({description: 'Text.', parents: ['A', 'B'], abstract: true});
    expect(splitEntityTrailers('Specializes: A.'))
        .toEqual({description: undefined, parents: ['A'], abstract: false});
    expect(splitEntityTrailers(ABSTRACT_MARKER))
        .toEqual({description: undefined, parents: [], abstract: true});
  });

  test('ordinary prose is left alone', () => {
    for (const text of ['Plain.', 'Specializes in B2B sales.\n\nMore.',
                        'Abstract: a summary.', '']) {
      expect(splitEntityTrailers(text))
          .toEqual({description: text, parents: [], abstract: false});
    }
    expect(splitEntityTrailers(undefined))
        .toEqual({description: undefined, parents: [], abstract: false});
  });
});
