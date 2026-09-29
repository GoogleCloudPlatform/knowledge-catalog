// An element table whose (default) label has nothing to list must say
// `NO PROPERTIES`, on both the BigQuery and the Spanner leg.
//
// Leaving the properties clause out is not "no properties": a label with no
// clause defaults to PROPERTIES ARE ALL COLUMNS, so every column of the backing
// table -- modeled or not -- leaks onto the element as a bare property. For a
// foreign-key edge that is the whole SOURCE entity's table, and a leaked column
// collides with any node MEASURE of the same name (verified live on BigQuery:
// "Property 'won_amount' is defined as MEASURE, but there are other
// declarations with the same name"). The corpus goldens show the shape in
// context; these tests pin the rule itself, including the MEASURE-collision
// case that motivated it.

import {describe, expect, test} from 'bun:test';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {Association, SemanticModel} from '../../../src/libts/semantic/ir';
import {generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';

const GEN_OPTS = {project: 'p', dataset: 'd'};

// Opportunity -[hasBuyer]-> Client over the opportunity table's FK. The
// opportunity table also carries a `won_amount` column, bound as field
// `wonAmount`, and the model defines a metric named `won_amount` -- the exact
// live shape that failed before the fix.
function sales(): SemanticModel {
  return {
    name: 'sales',
    entities: [
      {
        name: 'Opportunity',
        dataSource: 'p.d.opportunity',
        keys: ['opportunity_id'],
        fields: [
          {name: 'opportunity_id', expression: 'Opportunity.opportunity_id'},
          {name: 'client_id', expression: 'Opportunity.client_id'},
          {name: 'wonAmount', expression: 'Opportunity.won_amount'},
        ],
      },
      {
        name: 'Client',
        dataSource: 'p.d.client',
        keys: ['client_id'],
        fields: [{name: 'client_id', expression: 'Client.client_id'}],
      },
    ],
    relationships: [{
      name: 'hasBuyer',
      source: {entity: 'Opportunity', columns: ['client_id']},
      destination: {entity: 'Client', columns: ['client_id']},
    }],
    metrics: [{
      name: 'won_amount',
      expression: 'SUM(Opportunity.wonAmount)',
      entity: 'Opportunity',
    }],
  };
}

// The element-table block that starts with `<table> AS <alias>`, up to the
// next element table or the end of its list.
function block(ddl: string, alias: string): string {
  const lines = ddl.split('\n');
  const start = lines.findIndex(l => l.trimEnd().endsWith(` AS ${alias}`));
  expect(start).toBeGreaterThanOrEqual(0);
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i]) || /^\S/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

const GENERATORS = [
  ['BigQuery', (m: SemanticModel) => generatePropertyGraph(m, GEN_OPTS).ddl],
  ['Spanner', (m: SemanticModel) => generateSpannerPropertyGraph(m).ddl],
] as const;

describe.each(GENERATORS)('%s: an empty label says NO PROPERTIES', (_, gen) => {
  test('a foreign-key edge closes with NO PROPERTIES', () => {
    const edge = block(gen(sales()), 'hasBuyer');
    expect(edge).toMatch(/DESTINATION KEY\(client_id\) REFERENCES Client\(client_id\)/);
    // The clause is the edge table's last line: after SOURCE/DESTINATION and
    // after the label's OPTIONS (BigQuery) when there are any.
    expect(edge.trimEnd().split('\n').pop()!.trim()).toMatch(/^NO PROPERTIES,?$/);
    expect(edge).not.toContain('PROPERTIES(');
  });

  test('the edge OPTIONS precede NO PROPERTIES', () => {
    const model = sales();
    model.relationships[0].description = 'The client buying the opportunity.';
    const edge = block(gen(model), 'hasBuyer');
    expect(edge.trimEnd().split('\n').pop()!.trim()).toMatch(/^NO PROPERTIES,?$/);
  });

  test('a node with only a KEY says NO PROPERTIES', () => {
    const model = sales();
    model.entities[1].fields = [];
    const node = block(gen(model), 'Client');
    expect(node).toContain('KEY(client_id)');
    expect(node).toContain('NO PROPERTIES');
  });

  test('a node with properties is unchanged (no NO PROPERTIES)', () => {
    const node = block(gen(sales()), 'Opportunity');
    expect(node).toContain('PROPERTIES(');
    expect(node).not.toContain('NO PROPERTIES');
  });

  test('a field-less M:N junction edge says NO PROPERTIES', () => {
    const model = sales();
    const assoc: Association = {
      dataSource: 'p.d.opportunity_client',
      keys: ['opportunity_id', 'client_id'],
      sourceColumns: ['opportunity_id'],
      destinationColumns: ['client_id'],
    };
    model.relationships.push({
      name: 'sharedWith',
      source: {entity: 'Opportunity', columns: ['opportunity_id']},
      destination: {entity: 'Client', columns: ['client_id']},
      association: assoc,
    });
    const edge = block(gen(model), 'sharedWith');
    expect(edge).toContain('NO PROPERTIES');
    // With junction fields the edge lists them instead.
    assoc.fields = [{name: 'role', expression: 'sharedWith.role'}];
    const withFields = block(gen(model), 'sharedWith');
    expect(withFields).toContain('PROPERTIES(');
    expect(withFields).not.toContain('NO PROPERTIES');
  });
});

test('BigQuery: the MEASURE named like a physical column is the only declaration of that name', () => {
  // The live failure: `won_amount` is both a metric (MEASURE) on Opportunity
  // and a physical column of the opportunity table that backs hasBuyer. With
  // the edge defaulting to ALL COLUMNS, `won_amount` was also declared as an
  // edge property. Now the only `won_amount` declaration is the MEASURE.
  const {ddl} = generatePropertyGraph(sales(), GEN_OPTS);
  expect(ddl).toMatch(/MEASURE\(SUM\(wonAmount\)\) AS won_amount/);
  expect(block(ddl, 'hasBuyer')).not.toContain('won_amount');
  expect(ddl).not.toContain('ALL COLUMNS');
});
