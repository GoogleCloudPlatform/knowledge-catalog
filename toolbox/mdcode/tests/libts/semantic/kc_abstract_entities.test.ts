// Behavior specification for abstract entities and entity inheritance on the
// Knowledge Catalog leg (src/libts/semantic/knowledge_catalog.ts for push,
// src/libts/semantic/kc_converter.ts for pull).
//
// An abstract entity (a table-less supertype) publishes as a semantic-entity
// entry with the same shape an unbound logical entity already has: an empty
// `source.resources`, its own fields in the schema aspect, and no primaryKey.
// Neither closed template has a slot for a supertype or for "no table", so
// `extends` and `abstract` ride the entry description as fixed trailing
// paragraphs -- `Specializes: <parents>.` then `Abstract: no table of its own.`
// -- which pull peels back off. No new Dataplex type is involved.

import {describe, expect, test} from 'bun:test';

import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources, splitEntityTrailers} from '../../../src/libts/semantic/kc_converter';
import {ABSTRACT_MARKER, generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';

const OPTS = {project: 'dest-proj', location: 'us', entryGroup: 'eg'};

const ENTITY = 'dataplex-types.global.semantic-entity';
const SCHEMA = 'dataplex-types.global.schema';

// Party (abstract) <- Customer (concrete, with its own description), plus a
// concrete Order with an edge to Customer and one to Party.
function model(): SemanticModel {
  return {
    name: 'm',
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
    expect(party.aspects[ENTITY].data).toEqual({source: {resources: []}});
    expect(party.aspects[SCHEMA].data).toEqual({
      fields: [{name: 'partyName', dataType: 'STRING', metadataType: 'STRING'}],
    });
  });

  test('with the Abstract marker after its description', () => {
    const {entries} = generateCatalogResources(model(), OPTS);
    expect(entryOf(entries, 'Party').entrySource.description)
        .toBe(`Anyone we do business with.\n\n${ABSTRACT_MARKER}`);
  });

  test('without the "no keys" or "is abstract; skipped" warnings', () => {
    const {warnings} = generateCatalogResources(model(), OPTS);
    expect(warnings.filter(w => w.includes(`'Party'`) &&
                               !w.includes('relationship')))
        .toEqual([]);
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
  test('a subtype carries a Specializes paragraph', () => {
    const {entries} = generateCatalogResources(model(), OPTS);
    expect(entryOf(entries, 'Customer').entrySource.description)
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
  test('are skipped with a warning; others still publish', () => {
    const {entryLinks, warnings} = generateCatalogResources(model(), OPTS);
    expect(entryLinks).toHaveLength(1);
    expect(warnings).toContain(
        `relationship 'involves': endpoint entity 'Party' is abstract (no ` +
        `table), so the relationship link is skipped.`);
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
    // No "no backing data source" warning for the abstract entity.
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
