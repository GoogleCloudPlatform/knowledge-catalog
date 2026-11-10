import {describe, expect, test} from 'bun:test';

import {updatedText} from '../../../src/libts/semantic/pull_update';

// Each case gives the local file, the text pull builds for it (`base`), the
// text pull builds from the catalog (`pulled`), and the file pull writes.
describe('updatedText', () => {
  const LOCAL = `# Hand-written.
entities:
  - name: orders   # the fact table
    ai_context: An order.
    fields: [{ name: id }, { name: total }]
  - name: customers
    primary_key: [key]
metrics:
  - { name: revenue, expression: SUM(orders.total) }
profile: default
`;
  // LOCAL in pull's normal form: sorted entities, the object `ai_context`, a
  // derived metric entity, and no `profile: default`.
  const BASE = `entities:
  - name: customers
    primary_key: [key]
  - name: orders
    ai_context: {instructions: An order.}
    fields: [{ name: id }, { name: total }]
metrics:
  - { name: revenue, entity: orders, expression: SUM(orders.total) }
`;
  const edit = (...pairs: string[]) => {
    let text = BASE;
    for (let i = 0; i < pairs.length; i += 2) {
      expect(text).toContain(pairs[i]);
      text = text.replace(pairs[i], pairs[i + 1]);
    }
    return text;
  };

  for (const [what, pulled, want] of [
    ['that changes nothing keeps the file byte for byte', BASE, LOCAL],
    [
      'changes only a changed value',
      edit('primary_key: [key]', 'primary_key: [id]'),
      LOCAL.replace('primary_key: [key]', 'primary_key: [id]'),
    ],
    [
      'replaces a value written in another form when it changes',
      edit('{instructions: An order.}', '{instructions: A sale.}'),
      LOCAL.replace(
          'ai_context: An order.',
          'ai_context:\n      instructions: A sale.'),
    ],
    [
      'adds an item after the one it follows in pull\'s order, and keeps ' +
          'the local order',
      edit(
          '  - name: orders\n',
          '  - name: items\n    primary_key: [sku]\n  - name: orders\n'),
      // A new item is written in block style.
      LOCAL.replace(
          'metrics:',
          '  - name: items\n    primary_key:\n      - sku\nmetrics:'),
    ],
    [
      'drops an item the catalog no longer has, with its comment',
      edit(
          '  - name: orders\n' +
              '    ai_context: {instructions: An order.}\n' +
              '    fields: [{ name: id }, { name: total }]\n',
          ''),
      LOCAL.replace(
          '  - name: orders   # the fact table\n' +
              '    ai_context: An order.\n' +
              '    fields: [{ name: id }, { name: total }]\n',
          ''),
    ],
    [
      'follows the catalog when a list whose order means something changes ' +
          'order',
      edit('[{ name: id }, { name: total }]', '[{ name: total }, { name: id }]'),
      LOCAL.replace(
          '[{ name: id }, { name: total }]', '[{ name: total }, { name: id }]'),
    ],
    [
      'leaves out a key pull adds when its value agrees',
      edit('SUM(orders.total)', 'SUM(orders.total * 2)'),
      LOCAL.replace('SUM(orders.total)', 'SUM(orders.total * 2)'),
    ],
    [
      'writes a key pull adds, after the key it follows there, when its ' +
          'value changes',
      edit('entity: orders', 'entity: customers'),
      LOCAL.replace(
          '{ name: revenue, expression: SUM(orders.total) }',
          '{ name: revenue, entity: customers, expression: SUM(orders.total) }'),
    ],
  ] as const) {
    test(what, () => {
      expect(updatedText(LOCAL, BASE, pulled)).toBe(want);
    });
  }

  test('keeps an alias whose value stays', () => {
    const local = `entities:
  - name: orders
    fields:
      - &id { name: id, datatype: Integer }
  - name: invoices
    description: Old
    fields:
      - *id
`;
    const base = `entities:
  - name: orders
    fields: [{ name: id, datatype: Integer }]
  - name: invoices
    description: Old
    fields: [{ name: id, datatype: Integer }]
`;
    expect(updatedText(local, base, base.replace('Old', 'New')))
        .toBe(local.replace('Old', 'New'));
  });

  // A list item with no `name` is matched by the key that names an item of
  // its list, so a changed value keeps the item's comment.
  for (const [what, local, base, pulled, want] of [
    [
      'a dialect',
      'dialects:\n  - dialect: BIGQUERY   # BigQuery only\n' +
          '    expression: LOWER(email)\n',
      'dialects:\n  - {dialect: BIGQUERY, expression: LOWER(email)}\n',
      'dialects:\n  - {dialect: BIGQUERY, expression: UPPER(email)}\n',
      'dialects:\n  - dialect: BIGQUERY   # BigQuery only\n' +
          '    expression: UPPER(email)\n',
    ],
    [
      'an affected concept',
      'affects:\n  - concept: orders   # the order\n    operation: create\n',
      'affects:\n  - {concept: orders, operation: create}\n',
      'affects:\n  - {concept: orders, operation: modify}\n',
      'affects:\n  - concept: orders   # the order\n    operation: modify\n',
    ],
    [
      'a GOOGLE block pull writes last',
      'custom_extensions:\n  - vendor_name: GOOGLE   # bindings\n' +
          '    data: \'{"a": 1}\'\n  - vendor_name: DBT\n    data: \'{}\'\n',
      'custom_extensions:\n  - {vendor_name: DBT, data: \'{}\'}\n' +
          '  - {vendor_name: GOOGLE, data: \'{"a": 1}\'}\n',
      'custom_extensions:\n  - {vendor_name: DBT, data: \'{}\'}\n' +
          '  - {vendor_name: GOOGLE, data: \'{"a": 2}\'}\n',
      'custom_extensions:\n  - vendor_name: GOOGLE   # bindings\n' +
          '    data: \'{"a": 2}\'\n  - vendor_name: DBT\n    data: \'{}\'\n',
    ],
  ] as const) {
    test(`keeps the comment of ${what} whose value changes`, () => {
      expect(updatedText(local, base, pulled)).toBe(want);
    });
  }

  // Two blocks of one vendor share `vendor_name`, so each matches by its
  // value. The comment of a block the catalog drops goes with it, and a block
  // the catalog changes is written again rather than take another's comment.
  const ACME = 'x:\n  - vendor_name: ACME   # first block\n' +
      '    data: \'{"a":1}\'\n  - vendor_name: ACME   # second block\n' +
      '    data: \'{"b":2}\'\n';
  const ACME_BASE = 'x:\n  - {vendor_name: ACME, data: \'{"a":1}\'}\n' +
      '  - {vendor_name: ACME, data: \'{"b":2}\'}\n';
  for (const [what, pulled, want] of [
    ['drops the first of two blocks of one vendor',
     'x:\n  - {vendor_name: ACME, data: \'{"b":2}\'}\n',
     'x:\n  - vendor_name: ACME   # second block\n    data: \'{"b":2}\'\n'],
    ['drops the first of two blocks of one vendor and changes the second',
     'x:\n  - {vendor_name: ACME, data: \'{"b":3}\'}\n',
     'x:\n  - vendor_name: ACME\n    data: \'{"b":3}\'\n'],
  ] as const) {
    test(what, () => {
      expect(updatedText(ACME, ACME_BASE, pulled)).toBe(want);
    });
  }

  test('changes a block and adds another of its vendor without moving its ' +
           'comment',
       () => {
         // Either new block could be the changed one, so neither takes the
         // local block's comment.
         expect(updatedText(
                    'x:\n  - vendor_name: ACME   # only block\n' +
                        '    data: \'{"a":1}\'\n',
                    'x:\n  - {vendor_name: ACME, data: \'{"a":1}\'}\n',
                    'x:\n  - {vendor_name: ACME, data: \'{"a":2}\'}\n' +
                        '  - {vendor_name: ACME, data: \'{"b":1}\'}\n'))
             .toBe(
                 'x:\n  - vendor_name: ACME\n    data: \'{"a":2}\'\n' +
                 '  - vendor_name: ACME\n    data: \'{"b":1}\'\n');
       });

  // When the items of a list do not match one to one across the three
  // values, no item can be matched with certainty, so the list is pulled's.
  for (const [what, local, base, pulled, want] of [
    ['the local list repeats an item', 'x: [a, a, b]  # kept\n', 'x: [a, b]\n',
     'x: [a, c]\n', 'x: [a, c]  # kept\n'],
    ['pull\'s form of the local list repeats an item', 'x: [a]  # kept\n',
     'x: [a, a]\n', 'x: [a, a, b]\n', 'x: [a, a, b]  # kept\n'],
    ['pulled repeats an item', 'x: [a]\n', 'x: [a]\n', 'x: [a, a]\n',
     'x: [a, a]\n'],
    ['pulled repeats an item and adds one', 'x: [a]\n', 'x: [a]\n',
     'x: [a, a, b]\n', 'x: [a, a, b]\n'],
    ['a local item is not in pull\'s form', 'x: [a, z]\n', 'x: [a, b]\n',
     'x: [a, c]\n', 'x: [a, c]\n'],
    ['an item of pull\'s form is not local', 'x: [a, b]\n', 'x: [a, b, c]\n',
     'x: [a, c]\n', 'x: [a, c]\n'],
  ] as const) {
    test(`replaces a list when ${what}`, () => {
      expect(updatedText(local, base, pulled)).toBe(want);
    });
  }
});

// A JSON `data` string, such as a GOOGLE block's, is changed like the YAML
// around it: each value that stays keeps its text, and the block keeps its
// layout. Pull writes `data` as compact JSON.
describe('updatedText in a JSON data string', () => {
  const DATA = {
    deployments: [{name: 'default', target: 'g/main'}],
    profiles: [{
      name: 'prod',
      entities: [
        {name: 'Order', source: 't/orders'},
        {name: 'Customer', source: 't/customer'},
      ],
    }],
  };
  // `data` as a hand-written block over several lines, and as pull writes it.
  const block = (text: string) => `custom_extensions:
  - vendor_name: GOOGLE   # bindings
    data: |
${text.replace(/^/gm, '      ')}
`;
  const LOCAL = block(JSON.stringify(DATA, null, 2));
  const pulled = (data: unknown) => `custom_extensions:
  - {vendor_name: GOOGLE, data: '${JSON.stringify(data)}'}
`;
  const BASE = pulled(DATA);
  // DATA with `edit` applied to a copy.
  const changed = (edit: (d: any) => void) => {
    const d = structuredClone(DATA);
    edit(d);
    return d;
  };

  // Each change leaves the block as the changed data written by hand in the
  // same layout.
  for (const [what, data] of [
    [
      'changes only a changed value',
      changed(d => d.profiles[0].entities[0].source = 't/orders_v2'),
    ],
    [
      'adds an item after the one it follows, in the block\'s layout',
      changed(d => d.profiles[0].entities.splice(
                  1, 0, {name: 'Item', source: 't/item'})),
    ],
    [
      'drops an item the catalog no longer has, with its comma',
      changed(d => d.profiles[0].entities.pop()),
    ],
    [
      'adds an item before the first one',
      changed(d => d.profiles[0].entities.unshift(
                  {name: 'Item', source: 't/item'})),
    ],
    [
      'drops the first item, with its comma',
      changed(d => d.profiles[0].entities.shift()),
    ],
    [
      'replaces the last item',
      changed(
          d => d.profiles[0].entities[1] = {name: 'Item', source: 't/item'}),
    ],
    [
      'writes a list again when every item goes',
      changed(d => d.profiles[0].entities = [{name: 'Item', source: 't/item'}]),
    ],
    [
      'adds a key after the one it follows',
      changed(d => d.profiles[0].metrics_exclude = ['revenue']),
    ],
  ] as const) {
    test(what, () => {
      expect(updatedText(LOCAL, BASE, pulled(data)))
          .toBe(block(JSON.stringify(data, null, 2)));
    });
  }

  test('keeps a one-line JSON string on one line', () => {
    const local = `x: '{"a": 1, "b": [1, 2]}'  # kept\n`;
    expect(updatedText(
               local, `x: '{"a":1,"b":[1,2]}'\n`, `x: '{"a":2,"b":[1,2,3]}'\n`))
        .toBe(`x: '{"a": 2, "b": [1, 2, 3]}'  # kept\n`);
  });

  test('writes a list again when the catalog changes its order', () => {
    const local = 'x: \'{"fields": [{"name": "a"}, {"name": "b"}]}\'\n';
    expect(updatedText(
               local, 'x: \'{"fields":[{"name":"a"},{"name":"b"}]}\'\n',
               'x: \'{"fields":[{"name":"b"},{"name":"a"}]}\'\n'))
        .toBe('x: \'{"fields": [{"name": "b"}, {"name": "a"}]}\'\n');
  });
});
