// Behavior specification for K2 (proposed): derived relationships -- a
// relationship that is the composition of others, `via: [^r1, r2, ...]` with an
// optional `filter` (src/libts/semantic/derived_relationships.ts) -- across the
// toolchain: the loader's checks, chain resolution, the BigQuery lowering (a
// generated `edge_<relationship>` view materializing the distinct pairs, and
// an edge table over it), availability pruning, push validation, the
// Knowledge Catalog schema-join push/pull, OSI round-trip, and the OWL
// importer's owl:propertyChainAxiom mapping.
//
// Running example: customers hold memberships in clubs; `belongsTo` is the
// customer -> club edge reached through an active membership.

import {describe, expect, test} from 'bun:test';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {parseOwl} from '../../../src/libts/semantic/converters/owl/parse';
import {checkDerivedRelationships, chainPath, derivedTrailers, formatChain, parseStep, resolveChain, splitDerivedTrailers} from '../../../src/libts/semantic/derived_relationships';
import {Relationship, SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {fromDocument, loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';
import {pruneUnavailable} from '../../../src/libts/semantic/resolve_profiles';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

const GEN_OPTS = {project: 'p', dataset: 'd'};
const KC_OPTS = {project: 'dest-proj', location: 'us', entryGroup: 'eg'};
const TARGET = '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';

function model(): SemanticModel {
  return {
    name: 'clubs',
    entities: [
      {
        name: 'Customer',
        dataSource: 'p.d.customers',
        keys: ['customerId'],
        fields: [{name: 'customerId', type: 'String', expression: 'customer_id'}],
      },
      {
        name: 'Membership',
        dataSource: 'p.d.memberships',
        keys: ['membershipId'],
        fields: [
          {name: 'membershipId', type: 'String', expression: 'membership_id'},
          {name: 'customerId', type: 'String', expression: 'customer_id'},
          {name: 'clubId', type: 'String', expression: 'club_id'},
          {name: 'status', type: 'String', expression: 'status'},
        ],
      },
      {
        name: 'Club',
        dataSource: 'p.d.clubs',
        keys: ['clubId'],
        fields: [{name: 'clubId', type: 'String', expression: 'club_id'}],
      },
      {
        name: 'Order',
        dataSource: 'p.d.orders',
        keys: ['orderId'],
        fields: [
          {name: 'orderId', type: 'String', expression: 'order_id'},
          {name: 'customerId', type: 'String', expression: 'customer_id'},
          {name: 'statusKey', type: 'String', expression: 'status_key'},
        ],
      },
      {
        name: 'OrderStatus',
        dataSource: '',
        keys: ['statusCode'],
        fields: [{name: 'statusCode', type: 'String'}],
        members: [{code: 'OPEN', label: 'Open'}, {code: 'SHIPPED'}],
      },
    ],
    relationships: [
      {
        name: 'memberOf',
        source: {entity: 'Membership', columns: ['customerId']},
        destination: {entity: 'Customer', columns: ['customerId']},
      },
      {
        name: 'inClub',
        source: {entity: 'Membership', columns: ['clubId']},
        destination: {entity: 'Club', columns: ['clubId']},
      },
      {
        name: 'placedBy',
        source: {entity: 'Order', columns: ['customerId']},
        destination: {entity: 'Customer', columns: ['customerId']},
      },
      {
        name: 'hasStatus',
        source: {entity: 'Order', columns: ['statusKey']},
        destination: {entity: 'OrderStatus', columns: ['statusCode']},
      },
      {
        name: 'belongsTo',
        source: {entity: 'Customer', columns: []},
        destination: {entity: 'Club', columns: []},
        via: [{relationship: 'memberOf', inverse: true}, {relationship: 'inClub'}],
        filter: `Membership.status = 'active'`,
        description: 'The clubs a customer is an active member of.',
      },
      {
        name: 'orderStatuses',
        source: {entity: 'Customer', columns: []},
        destination: {entity: 'OrderStatus', columns: []},
        via: [{relationship: 'placedBy', inverse: true}, {relationship: 'hasStatus'}],
      },
    ],
    metrics: [],
    customExtensions: [{
      vendorName: 'GOOGLE',
      data: JSON.stringify({deploymentTargets: [TARGET]}),
    }],
  };
}

const rel = (m: SemanticModel, name: string) =>
    m.relationships.find(r => r.name === name)!;
const flat = (s: string) => s.replace(/\s+/g, ' ');

const BELONGS_TO_VIEW = [
  'CREATE OR REPLACE VIEW `p.d.edge_belongs_to`',
  "OPTIONS (description = 'Derived edge belongsTo (Customer -> Club): the " +
      'distinct pairs reached via ^memberOf, inClub (Customer -> Membership ' +
      "-> Club) where Membership.status = \\'active\\'. Generated by kcmd; do " +
      "not edit.') AS",
  'SELECT DISTINCT n0.customer_id AS source_customer_id, n2.club_id AS ' +
      'target_club_id',
  'FROM `p.d.customers` AS n0',
  'JOIN `p.d.memberships` AS n1 ON n1.customer_id = n0.customer_id',
  'JOIN `p.d.clubs` AS n2 ON n1.club_id = n2.club_id',
  "WHERE n1.status = 'active'",
].join('\n');

const ORDER_STATUSES_VIEW = [
  'CREATE OR REPLACE VIEW `p.d.edge_order_statuses`',
  "OPTIONS (description = 'Derived edge orderStatuses (Customer -> " +
      'OrderStatus): the distinct pairs reached via ^placedBy, hasStatus ' +
      "(Customer -> Order -> OrderStatus). Generated by kcmd; do not edit.') AS",
  'SELECT DISTINCT n0.customer_id AS source_customer_id, n2.code AS target_code',
  'FROM `p.d.customers` AS n0',
  'JOIN `p.d.orders` AS n1 ON n1.customer_id = n0.customer_id',
  'JOIN `p.d.vocab_order_status` AS n2 ON LOWER(n1.status_key) = LOWER(n2.code)',
].join('\n');

describe('loader', () => {
  const doc = (derived: any, version = '0.2.0.dev0/google') => ({
    version,
    semantic_model: [{
      name: 'm',
      datasets: [
        {
          name: 'Customer',
          source: 'bigquery:p.d.customers',
          primary_key: ['customerId'],
          fields: [{name: 'customerId', expression: 'customer_id'}],
        },
        {
          name: 'Membership',
          source: 'bigquery:p.d.memberships',
          primary_key: ['membershipId'],
          fields: [
            {name: 'membershipId', expression: 'membership_id'},
            {name: 'customerId', expression: 'customer_id'},
            {name: 'clubId', expression: 'club_id'},
            {name: 'status', expression: 'status'},
          ],
        },
        {
          name: 'Club',
          source: 'bigquery:p.d.clubs',
          primary_key: ['clubId'],
          fields: [{name: 'clubId', expression: 'club_id'}],
        },
      ],
      relationships: [
        {
          name: 'memberOf',
          from: 'Membership',
          to: 'Customer',
          from_columns: ['customerId'],
          to_columns: ['customerId'],
        },
        {
          name: 'inClub',
          from: 'Membership',
          to: 'Club',
          from_columns: ['clubId'],
          to_columns: ['clubId'],
        },
        {name: 'belongsTo', from: 'Customer', to: 'Club', ...derived},
      ],
    }],
  });

  test('via and filter load onto the IR', () => {
    const {models, warnings} = fromDocument(doc({
      via: ['^memberOf', 'inClub'],
      filter: `Membership.status = 'active'`,
    }));
    const r = rel(models[0], 'belongsTo');
    expect(r.via).toEqual(
        [{relationship: 'memberOf', inverse: true}, {relationship: 'inClub'}]);
    expect(r.filter).toBe(`Membership.status = 'active'`);
    expect(r.source.columns).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('the keys are native extensions: vanilla Ossie rejects them', () => {
    expect(() => fromDocument(doc({via: ['^memberOf', 'inClub']}, '0.2.0.dev0')))
        .toThrow();
  });

  test('a chain composes at least two steps', () => {
    expect(() => fromDocument(doc({via: ['inClub']}))).toThrow();
  });

  test('a derived relationship binds no join columns', () => {
    expect(() => fromDocument(doc({
             via: ['^memberOf', 'inClub'],
             from_columns: ['customerId'],
             to_columns: ['clubId'],
           })))
        .toThrow(/binds no join columns/);
  });

  test('a derived relationship cannot be abstract', () => {
    expect(() => fromDocument(doc({via: ['^memberOf', 'inClub'], abstract: true})))
        .toThrow(/cannot be abstract/);
  });

  test('a step naming the relationship itself is a load error', () => {
    expect(() => fromDocument(doc({via: ['belongsTo', 'inClub']})))
        .toThrow(/names the relationship itself/);
  });

  test('an unresolved or disconnected chain loads with a warning', () => {
    const unknown = fromDocument(doc({via: ['^memberOf', 'nope']})).warnings;
    expect(unknown).toContain(
        `model 'm': relationship 'belongsTo': via [^memberOf, nope]: step ` +
        `'nope' names no relationship in the model`);
    const broken = fromDocument(doc({via: ['memberOf', 'inClub']})).warnings;
    expect(broken).toContain(
        `model 'm': relationship 'belongsTo': via [memberOf, inClub]: step 1 ` +
        `arrives at 'Customer' but step 2 leaves from 'Membership'; the chain ` +
        `does not connect`);
  });

  test('a filter without via is warned and ignored', () => {
    const {warnings} = fromDocument(doc({
      from_columns: ['customerId'],
      to_columns: ['clubId'],
      filter: 'x = 1',
    }));
    expect(warnings.some(w => w.includes(`'filter' is only read on a derived`)))
        .toBe(true);
  });
});

describe('chain resolution', () => {
  test('steps parse and format with ^ for a backwards walk', () => {
    expect(parseStep(' ^memberOf ')).toEqual({relationship: 'memberOf', inverse: true});
    expect(parseStep('inClub')).toEqual({relationship: 'inClub'});
    expect(formatChain(rel(model(), 'belongsTo').via!)).toBe('^memberOf, inClub');
  });

  test('a chain resolves to hops and an entity path', () => {
    const m = model();
    const res = resolveChain(rel(m, 'belongsTo'), m.relationships);
    expect(res.hops!.map(h => [h.relationship.name, h.inverse, h.from, h.to]))
        .toEqual([
          ['memberOf', true, 'Customer', 'Membership'],
          ['inClub', false, 'Membership', 'Club'],
        ]);
    expect(chainPath(res.hops!)).toBe('Customer -> Membership -> Club');
  });

  test('a step may name a declared inverse (read backwards)', () => {
    const m = model();
    rel(m, 'memberOf').inverse = 'memberships';
    const r: Relationship = {
      name: 'clubsOf',
      source: {entity: 'Customer', columns: []},
      destination: {entity: 'Club', columns: []},
      via: [{relationship: 'memberships'}, {relationship: 'inClub'}],
    };
    const res = resolveChain(r, m.relationships);
    expect(res.hops!.map(h => [h.relationship.name, h.inverse]))
        .toEqual([['memberOf', true], ['inClub', false]]);
  });

  test('a derived step expands in place, reversed when walked backwards', () => {
    const m = model();
    const forward: Relationship = {
      name: 'orderClubs',
      source: {entity: 'Order', columns: []},
      destination: {entity: 'Club', columns: []},
      via: [{relationship: 'placedBy'}, {relationship: 'belongsTo'}],
    };
    expect(chainPath(resolveChain(forward, m.relationships).hops!))
        .toBe('Order -> Customer -> Membership -> Club');
    const backward: Relationship = {
      name: 'clubCustomers',
      source: {entity: 'Club', columns: []},
      destination: {entity: 'Customer', columns: []},
      via: [{relationship: 'belongsTo', inverse: true}, {relationship: 'placedBy', inverse: true}],
    };
    const hops = resolveChain(backward, m.relationships).hops!;
    expect(hops.map(h => [h.relationship.name, h.inverse])).toEqual([
      ['inClub', true], ['memberOf', false], ['placedBy', true]
    ]);
  });

  test('unknown, abstract and cyclic steps are errors', () => {
    const m = model();
    const r = (via: Relationship['via']): Relationship => ({
      name: 'x',
      source: {entity: 'Customer', columns: []},
      destination: {entity: 'Club', columns: []},
      via,
    });
    expect(resolveChain(r([{relationship: 'nope'}, {relationship: 'inClub'}]), m.relationships).error)
        .toBe(`step 'nope' names no relationship in the model`);
    rel(m, 'inClub').abstract = true;
    expect(resolveChain(rel(m, 'belongsTo'), m.relationships).error)
        .toBe(`step 'inClub' names abstract relationship 'inClub', which has no edges`);
    const a = r([{relationship: 'b'}, {relationship: 'inClub'}]);
    a.name = 'a';
    const b = r([{relationship: 'a'}, {relationship: 'inClub'}]);
    b.name = 'b';
    expect(resolveChain(a, [...model().relationships, a, b]).error)
        .toBe(`the chain is cyclic through 'a'`);
  });

  test('ends that do not match the chain are warned', () => {
    const m = model();
    rel(m, 'belongsTo').source.entity = 'Order';
    const warnings: string[] = [];
    checkDerivedRelationships(m.entities, m.relationships, warnings);
    expect(warnings).toEqual([
      `relationship 'belongsTo': from 'Order' but its chain starts at 'Customer'`,
    ]);
  });
});

describe('BigQuery lowering', () => {
  const gen = generatePropertyGraph(model(), GEN_OPTS);
  const view = (name: string) => gen.views?.find(v => v.name === name)?.ddl;

  test('a derived edge view materializes the distinct pairs', () => {
    expect(view('edge_belongs_to')).toBe(BELONGS_TO_VIEW);
  });

  test('a hop into a vocabulary matches the code case-insensitively', () => {
    expect(view('edge_order_statuses')).toBe(ORDER_STATUSES_VIEW);
  });

  test('the edge table reads the view', () => {
    expect(flat(gen.ddl))
        .toContain(
            '`p.d.edge_belongs_to` AS belongsTo ' +
            'KEY(source_customer_id, target_club_id) ' +
            'SOURCE KEY(source_customer_id) REFERENCES Customer(customer_id) ' +
            'DESTINATION KEY(target_club_id) REFERENCES Club(club_id)');
  });

  test('views come after the vocabularies they read, in model order', () => {
    expect(gen.views?.map(v => v.name)).toEqual([
      'vocab_order_status', 'edge_has_status', 'edge_belongs_to',
      'edge_order_statuses'
    ]);
    expect(gen.warnings).toEqual([]);
  });

  test('a filter string literal is not rewritten', () => {
    const m = model();
    rel(m, 'belongsTo').filter = `Membership.status <> 'Membership.status'`;
    const ddl = generatePropertyGraph(m, GEN_OPTS)
                    .views!.find(v => v.name === 'edge_belongs_to')!.ddl;
    expect(ddl).toContain(`WHERE n1.status <> 'Membership.status'`);
  });

  test('a nested derived step expands into one view', () => {
    const m = model();
    rel(m, 'belongsTo').filter = undefined;
    m.relationships.push({
      name: 'orderClubs',
      source: {entity: 'Order', columns: []},
      destination: {entity: 'Club', columns: []},
      via: [{relationship: 'placedBy'}, {relationship: 'belongsTo'}],
    });
    const ddl = generatePropertyGraph(m, GEN_OPTS)
                    .views!.find(v => v.name === 'edge_order_clubs')!.ddl;
    expect(ddl).toContain(
        'SELECT DISTINCT n0.order_id AS source_order_id, n3.club_id AS ' +
        'target_club_id\nFROM `p.d.orders` AS n0\n' +
        'JOIN `p.d.customers` AS n1 ON n0.customer_id = n1.customer_id\n' +
        'JOIN `p.d.memberships` AS n2 ON n2.customer_id = n1.customer_id\n' +
        'JOIN `p.d.clubs` AS n3 ON n2.club_id = n3.club_id');
  });

  test('a chain through a filtered derived step is omitted, warned', () => {
    const m = model();
    m.relationships.push({
      name: 'orderClubs',
      source: {entity: 'Order', columns: []},
      destination: {entity: 'Club', columns: []},
      via: [{relationship: 'placedBy'}, {relationship: 'belongsTo'}],
    });
    const out = generatePropertyGraph(m, GEN_OPTS);
    expect(out.views?.map(v => v.name)).not.toContain('edge_order_clubs');
    expect(out.warnings).toContain(
        `relationship 'orderClubs': derived via [placedBy, belongsTo] cannot ` +
        `be materialized (step 'belongsTo' is derived with a filter, which a ` +
        `chain through it does not apply yet); edge omitted`);
  });

  test('a chain through a junction edge is omitted, warned', () => {
    const m = model();
    const inClub = rel(m, 'inClub');
    inClub.source.columns = [];
    inClub.destination.columns = [];
    inClub.association = {
      dataSource: 'p.d.club_members',
      keys: ['membership_id', 'club_id'],
      sourceColumns: ['membership_id'],
      destinationColumns: ['club_id'],
    };
    const out = generatePropertyGraph(m, GEN_OPTS);
    expect(out.ddl).not.toContain('AS belongsTo');
    expect(out.warnings).toContain(
        `relationship 'belongsTo': derived via [^memberOf, inClub] cannot be ` +
        `materialized (step 'inClub' has no foreign-key columns (a junction or ` +
        `logical edge cannot be followed yet)); edge omitted`);
  });

  test('a derived edge stays when a step\'s join field is unbound', () => {
    const m = model();
    // Join columns are physical columns, not fields: unbinding the field that
    // shares the column's name drops that field, not the step, so the chain
    // and the edge derived from it stay.
    delete m.entities[1].fields[2].expression;
    const {model: pruned, report} = pruneUnavailable(m, 'bigquery');
    expect(report.droppedRelationships).toEqual([]);
    expect(report.unboundFields).toContain('Membership.clubId');
    expect(pruned.relationships.map(r => r.name))
        .toEqual(expect.arrayContaining(['inClub', 'belongsTo']));
  });
});

describe('validation', () => {
  const errorsOf = (m: SemanticModel) =>
      validatePushRequirements([{document: 'doc.yaml', model: m} as any], {
        targetOptional: true,
      });

  test('a derived relationship needs no join columns on a BigQuery push', () => {
    expect(errorsOf(model())).toEqual([]);
  });

  test('a derived relationship is an error for a Spanner graph', () => {
    const m = model();
    m.entities[4] = {...m.entities[4], dataSource: 'order_status'};
    m.customExtensions = [{
      vendorName: 'GOOGLE',
      data: JSON.stringify({
        deploymentTargets: [
          '//spanner.googleapis.com/projects/p/instances/i/databases/db/propertyGraphs/g'
        ],
      }),
    }];
    expect(errorsOf(m).some(
               e => /relationship 'belongsTo' .* is derived \('via'\), which only a BigQuery graph push materializes/
                        .test(e)))
        .toBe(true);
  });
});

describe('Knowledge Catalog push / pull', () => {
  const joinsOf = (res: any): any[] =>
      [...(res.entryLinks ?? []), ...(res.entries ?? [])].flatMap(
          (x: any) => Object.values(x.aspects ?? {})
                          .flatMap((a: any) => a?.data?.joins ?? []));
  const derivedJoin = (res: any) => joinsOf(res).find(
      (j: any) => (j.description ?? '').toLowerCase().includes(
          'derived via: ^memberof'));

  test('push publishes a JOIN over the endpoint keys, with the derivation', () => {
    const join = derivedJoin(generateCatalogResources(model(), KC_OPTS));
    expect(join.type).toBe('JOIN');
    expect(join.source.fields).toEqual(['customerId']);
    expect(join.target.fields).toEqual(['clubId']);
    expect(join.description)
        .toBe(
            'The clubs a customer is an active member of.\n\n' +
            'Derived via: ^memberOf, inClub.\n\n' +
            `Derived filter: Membership.status = 'active'`);
  });

  test('pull restores via and filter; push is a fixed point', () => {
    const pushed = generateCatalogResources(model(), KC_OPTS);
    const {models} = modelsFromCatalogResources(pushed.entries, pushed.entryLinks);
    const pulled = models[0];
    const r = pulled.relationships.find(x => x.via?.length && x.filter)!;
    expect(r.source.entity).toBe('Customer');
    expect(r.destination.entity).toBe('Club');
    expect(r.filter).toBe(`Membership.status = 'active'`);
    expect(r.description).toBe('The clubs a customer is an active member of.');
    expect(r.source.columns).toEqual([]);
    // Pull recovers relationship names in link-slug form; each step resolves
    // to a pulled relationship, so the chain still follows.
    expect(resolveChain(r, pulled.relationships).error).toBeUndefined();
    expect(r.via!.map(s => !!s.inverse)).toEqual([true, false]);
    const again = generateCatalogResources(pulled, KC_OPTS);
    expect(derivedJoin(again).description.toLowerCase())
        .toBe(derivedJoin(pushed).description.toLowerCase());
    const twice = generateCatalogResources(
        modelsFromCatalogResources(again.entries, again.entryLinks).models[0],
        KC_OPTS);
    expect(derivedJoin(twice).description).toBe(derivedJoin(again).description);
  });

  test('a derived edge with an unkeyed endpoint is not published, warned', () => {
    const m = model();
    m.entities[2].keys = [];
    const out = generateCatalogResources(m, KC_OPTS);
    expect(derivedJoin(out)).toBeUndefined();
    expect(out.warnings.some(
               (w: string) => w.includes(
                   `relationship 'belongsTo': derived, and endpoint entity ` +
                   `'Club' has no primary key`)))
        .toBe(true);
  });
});

describe('derived trailers codec', () => {
  test('forms and inverse', () => {
    const r = rel(model(), 'belongsTo');
    expect(derivedTrailers(r)).toEqual([
      'Derived via: ^memberOf, inClub.',
      `Derived filter: Membership.status = 'active'`,
    ]);
    expect(derivedTrailers({via: undefined})).toEqual([]);
    expect(splitDerivedTrailers(['Text.', ...derivedTrailers(r)].join('\n\n')))
        .toEqual({rest: 'Text.', via: r.via, filter: r.filter});
    expect(splitDerivedTrailers('Derived via: a, ^b.'))
        .toEqual({
          rest: undefined,
          via: [{relationship: 'a'}, {relationship: 'b', inverse: true}],
        });
  });

  test('text without a well-formed trailer is left alone', () => {
    expect(splitDerivedTrailers('Plain.')).toEqual({rest: 'Plain.'});
    expect(splitDerivedTrailers('Derived via: a, b'))
        .toEqual({rest: 'Derived via: a, b'});
    expect(splitDerivedTrailers(undefined)).toEqual({rest: undefined});
  });
});

describe('OSI round-trip', () => {
  test('via and filter survive serialize -> load', () => {
    const m = model();
    // Each source as a load records it, in an accepted form, so the
    // serialized document reloads.
    for (const e of m.entities) {
      if (e.dataSource) e.authoredSource = `bigquery:${e.dataSource}`;
    }
    const {yaml} = serializeModel(m);
    expect(yaml).toContain('- ^memberOf');
    expect(yaml).toContain('filter:');
    const {models} = loadModels(yaml);
    const r = rel(models[0], 'belongsTo');
    expect(r.via).toEqual(rel(model(), 'belongsTo').via);
    expect(r.filter).toBe(`Membership.status = 'active'`);
  });
});

describe('OWL import', () => {
  const TTL = `
    @prefix owl:  <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
    @prefix ex:   <https://example.org/clubs#> .

    ex:Customer a owl:Class ; owl:hasKey ( ex:customerId ) .
    ex:customerId a owl:DatatypeProperty ; rdfs:domain ex:Customer ; rdfs:range xsd:string .
    ex:Membership a owl:Class ; owl:hasKey ( ex:membershipId ) .
    ex:membershipId a owl:DatatypeProperty ; rdfs:domain ex:Membership ; rdfs:range xsd:string .
    ex:Club a owl:Class ; owl:hasKey ( ex:clubId ) .
    ex:clubId a owl:DatatypeProperty ; rdfs:domain ex:Club ; rdfs:range xsd:string .

    ex:memberOf a owl:ObjectProperty ; rdfs:domain ex:Membership ; rdfs:range ex:Customer .
    ex:inClub a owl:ObjectProperty ; rdfs:domain ex:Membership ; rdfs:range ex:Club .

    # Declared ends; the first step walks memberOf backwards.
    ex:belongsTo a owl:ObjectProperty ; rdfs:domain ex:Customer ; rdfs:range ex:Club ;
        owl:propertyChainAxiom ( [ owl:inverseOf ex:memberOf ] ex:inClub ) .

    # No domain or range: the chain's ends stand in.
    ex:clubOf a owl:ObjectProperty ;
        owl:propertyChainAxiom ( [ owl:inverseOf ex:memberOf ] ex:inClub ) .

    # Not imported as 'via': a single step, and a recursive chain.
    ex:sameClub a owl:ObjectProperty ; rdfs:domain ex:Membership ; rdfs:range ex:Club ;
        owl:propertyChainAxiom ( ex:inClub ) .
    ex:feederClub a owl:ObjectProperty ; rdfs:domain ex:Club ; rdfs:range ex:Club ;
        owl:propertyChainAxiom ( ex:feederClub ex:feederClub ) .
  `;

  test('the parser reads chain steps, an inverse step as a flag', () => {
    const owl = parseOwl(TTL);
    const p = owl.objectProperties.find(x => x.localName === 'belongsTo')!;
    expect(p.propertyChain).toEqual([[
      {property: 'https://example.org/clubs#memberOf', inverse: true},
      {property: 'https://example.org/clubs#inClub'},
    ]]);
  });

  const r = convertOwlToOsi(TTL, 'clubs');
  const m = loadModels(r.yaml, {bindingOptional: true}).models[0];

  test('owl:propertyChainAxiom maps to via', () => {
    const b = rel(m, 'belongsTo');
    expect([b.source.entity, b.destination.entity]).toEqual(['Customer', 'Club']);
    expect(b.via).toEqual(
        [{relationship: 'memberOf', inverse: true}, {relationship: 'inClub'}]);
    expect(r.yaml).toContain('- ^memberOf');
    expect(r.stats.derivedRelationships).toBe(2);
  });

  test('missing ends are inferred from the chain, with warnings', () => {
    const c = rel(m, 'clubOf');
    expect([c.source.entity, c.destination.entity]).toEqual(['Customer', 'Club']);
    expect(r.warnings).toContain(
        `object property 'clubOf' declares no rdfs:domain; inferred ` +
        `'Customer', where its owl:propertyChainAxiom starts.`);
    expect(r.warnings).toContain(
        `object property 'clubOf' declares no rdfs:range; inferred 'Club', ` +
        `where its owl:propertyChainAxiom ends.`);
  });

  test('a single-step or recursive chain is not imported, warned', () => {
    expect(rel(m, 'sameClub').via).toBeUndefined();
    expect(rel(m, 'feederClub').via).toBeUndefined();
    expect(r.warnings).toContain(
        `object property 'sameClub': its owl:propertyChainAxiom has a single ` +
        `step; not imported as 'via' (a chain composes at least two).`);
    expect(r.warnings.some(
               w => w.startsWith(`object property 'feederClub': its ` +
                                 `owl:propertyChainAxiom names the property itself`)))
        .toBe(true);
  });

  test('a step naming a folded owl:inverseOf property still resolves', () => {
    const ttl = TTL + `
      ex:hasMembership a owl:ObjectProperty ; owl:inverseOf ex:memberOf ;
          rdfs:domain ex:Customer ; rdfs:range ex:Membership .
      ex:clubsViaMembership a owl:ObjectProperty ; rdfs:domain ex:Customer ;
          rdfs:range ex:Club ;
          owl:propertyChainAxiom ( ex:hasMembership ex:inClub ) .
    `;
    const out = convertOwlToOsi(ttl, 'clubs');
    const folded = loadModels(out.yaml, {bindingOptional: true}).models[0];
    for (const name of ['belongsTo', 'clubOf', 'clubsViaMembership']) {
      const res = resolveChain(rel(folded, name), folded.relationships);
      expect(chainPath(res.hops!)).toBe('Customer -> Membership -> Club');
    }
    expect(out.warnings.some(w => w.includes(`'clubsViaMembership'`))).toBe(false);
  });
});
