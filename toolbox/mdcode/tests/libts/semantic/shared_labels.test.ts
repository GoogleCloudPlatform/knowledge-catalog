// A shared ABSTRACT label exposes one property set on every table that carries
// it, on both the BigQuery and the Spanner leg.
//
// Both engines require that "labels with the same name expose the same set of
// properties". An abstract supertype has no table; each concrete descendant
// renders its label from its own binding. When the descendants bind different
// subsets of the inherited fields, the label may carry only the fields every
// descendant binds. The live shape that failed (BigQuery: "The label
// 'Organization' is defined with different properties"): Organization ⊑ Party
// {partyName}, carried by ClientAccount (binds partyName) and by
// EcosystemPartner, a node derived from a relationship that carries only its
// key.

import {describe, expect, test} from 'bun:test';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';

const GEN_OPTS = {project: 'p', dataset: 'd'};

function parties(): SemanticModel {
  return {
    name: 'parties',
    entities: [
      {
        name: 'Party',
        dataSource: '',
        keys: [],
        abstract: true,
        fields: [{name: 'partyName', description: 'Display name of a party.'}],
      },
      {
        name: 'Organization',
        dataSource: '',
        keys: [],
        abstract: true,
        extends: ['Party'],
        fields: [],
      },
      {
        name: 'Person',
        dataSource: '',
        keys: [],
        abstract: true,
        extends: ['Party'],
        fields: [],
      },
      {
        name: 'ClientAccount',
        dataSource: 'p.d.client_account',
        keys: ['accountId'],
        extends: ['Organization'],
        fields: [
          {name: 'accountId', expression: 'account_id'},
          {name: 'partyName', expression: 'account_name'},
        ],
      },
      // Derived from a relationship: the node view carries only its key.
      {
        name: 'EcosystemPartner',
        dataSource: 'p.d.node_ecosystem_partner',
        keys: ['partnerName'],
        extends: ['Organization'],
        fields: [{name: 'partnerName', expression: 'partner_name'}],
      },
      {
        name: 'KeyBuyer',
        dataSource: 'p.d.key_buyer',
        keys: ['buyerId'],
        extends: ['Person'],
        fields: [
          {name: 'buyerId', expression: 'buyer_id'},
          {name: 'partyName', expression: 'full_name'},
        ],
      },
      {
        name: 'Employee',
        dataSource: 'p.d.employee',
        keys: ['employeeId'],
        extends: ['Person'],
        fields: [
          {name: 'employeeId', expression: 'employee_id'},
          {name: 'partyName', expression: 'employee_name'},
        ],
      },
    ],
    relationships: [],
    metrics: [],
  };
}

const GENERATORS = [
  ['BigQuery', (m: SemanticModel) => generatePropertyGraph(m, GEN_OPTS)],
  ['Spanner', (m: SemanticModel) => generateSpannerPropertyGraph(m)],
] as const;

// The property names each label of each node table declares:
// table alias -> label ('DEFAULT' for the default label) -> names.
function labelProperties(ddl: string): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>();
  const lines = ddl.split('\n');
  let labels: Map<string, string[]>|undefined;
  let current: string|undefined;
  let inProps = false;
  for (const raw of lines) {
    const header = raw.match(/^ {2}\S.* AS (\w+),?$/);
    if (header) {
      labels = new Map();
      out.set(header[1], labels);
      current = undefined;
      inProps = false;
      continue;
    }
    if (!labels) continue;
    const text = raw.trim();
    if (inProps) {
      if (text === ')' || text === '),') {
        inProps = false;
        continue;
      }
      const core = text.split(' OPTIONS(')[0].replace(/,$/, '');
      const alias = core.match(/ AS (\w+)$/);
      labels.get(current!)!.push(alias ? alias[1] : core);
      continue;
    }
    if (text === 'DEFAULT LABEL') {
      current = 'DEFAULT';
      labels.set(current, []);
    } else if (text.startsWith('LABEL ')) {
      current = text.slice('LABEL '.length);
      labels.set(current, []);
    } else if (text === 'PROPERTIES(' && current) {
      inProps = true;
    }
  }
  return out;
}

describe.each(GENERATORS)(
    '%s: a shared abstract label has one property set', (_, gen) => {
      test('every table carrying a label declares the same properties', () => {
        const byTable = labelProperties(gen(parties()).ddl);
        const signatures = new Map<string, Set<string>>();
        for (const labels of byTable.values()) {
          for (const [label, names] of labels) {
            if (label === 'DEFAULT') continue;
            const set = signatures.get(label) ?? new Set<string>();
            set.add(JSON.stringify([...names].sort()));
            signatures.set(label, set);
          }
        }
        expect([...signatures.keys()].sort()).toEqual(
            ['Organization', 'Party', 'Person']);
        for (const [label, set] of signatures) {
          expect({label, signatures: set.size})
              .toEqual({label, signatures: 1});
        }
      });

      test(
          'a field one descendant leaves unbound is left out of the label',
          () => {
            const byTable = labelProperties(gen(parties()).ddl);
            expect(byTable.get('ClientAccount')!.get('Organization'))
                .toEqual([]);
            expect(byTable.get('EcosystemPartner')!.get('Organization'))
                .toEqual([]);
            // Party is also carried by EcosystemPartner (through Organization).
            for (const table of ['ClientAccount', 'KeyBuyer', 'Employee']) {
              expect(byTable.get(table)!.get('Party')).toEqual([]);
            }
          });

      test('the binding descendants keep the field as their own property', () => {
        const byTable = labelProperties(gen(parties()).ddl);
        expect(byTable.get('ClientAccount')!.get('DEFAULT'))
            .toContain('partyName');
        expect(byTable.get('KeyBuyer')!.get('DEFAULT')).toContain('partyName');
      });

      test('a label whose descendants all bind the field keeps it', () => {
        const byTable = labelProperties(gen(parties()).ddl);
        expect(byTable.get('KeyBuyer')!.get('Person')).toEqual(['partyName']);
        expect(byTable.get('Employee')!.get('Person')).toEqual(['partyName']);
      });

      test('the omission is warned, naming the label and the table', () => {
        const {warnings} = gen(parties());
        const shared = warnings.filter(w => w.startsWith('label '));
        expect(shared.some(
                   w => w.includes(`label 'Organization'`) &&
                       w.includes(`'EcosystemPartner'`) &&
                       w.includes(`'partyName'`)))
            .toBe(true);
        expect(shared.some(w => w.includes(`label 'Person'`))).toBe(false);
      });

      test('when every descendant binds the field, every label carries it', () => {
        const model = parties();
        model.entities.find(e => e.name === 'EcosystemPartner')!.fields.push(
            {name: 'partyName', expression: 'partner_name'});
        const {ddl, warnings} = gen(model);
        const byTable = labelProperties(ddl);
        for (const table of ['ClientAccount', 'EcosystemPartner']) {
          expect(byTable.get(table)!.get('Organization'))
              .toEqual(['partyName']);
          expect(byTable.get(table)!.get('Party')).toEqual(['partyName']);
        }
        expect(warnings.some(w => w.startsWith('label '))).toBe(false);
      });
    });
