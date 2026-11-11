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

// A GOOGLE block's JSON `data` string is changed like the YAML around it: each
// value that stays keeps its text, and the block keeps its layout. Pull writes
// `data` as compact JSON.
describe('updatedText in a JSON data string', () => {
  // A binding of entity `name` to table `t/<table>`, with a field per column.
  const binding = (name: string, table: string, ...columns: string[]) => ({
    name,
    source: `t/${table}`,
    fields: columns.map(c => ({name: c, expression: c})),
  });
  const DATA = {
    deployments: [{name: 'default', target: 'g/main'}],
    profiles: [{
      name: 'prod',
      entities: [
        binding('Order', 'orders', 'id', 'total'),
        binding('Customer', 'customer', 'id'),
      ],
    }],
  };
  const ITEM = binding('Item', 'item', 'id', 'qty');
  // Three layouts: as `JSON.stringify` indents it, by hand, with each
  // innermost list or object on one line, and indented by tabs.
  const indented = (data: unknown) => JSON.stringify(data, null, 2);
  const hand = (data: unknown) => indented(data).replace(
      /[{[][^{}[\]]*[}\]]/g,
      s => s.replace(/\n\s*/g, ' ').replace(/([{[]) | ([}\]])/g, '$1$2'));
  const LAYOUTS = {
    indented,
    'by hand': hand,
    'with tabs': (data: unknown) => JSON.stringify(data, null, '\t'),
  };
  // `data` as a hand-written block over several lines, and as pull writes it.
  const block = (text: string) => `custom_extensions:
  - vendor_name: GOOGLE   # bindings
    data: |
${text.replace(/^/gm, '      ')}
`;
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
      'adds an item after the one it follows',
      changed(d => d.profiles[0].entities.splice(1, 0, ITEM)),
    ],
    [
      'adds two items after one, in order',
      changed(d => d.profiles[0].entities.splice(
                  1, 0, binding('A', 'a', 'id'), binding('B', 'b', 'x', 'y'))),
    ],
    [
      'drops an item the catalog no longer has, with its comma',
      changed(d => d.profiles[0].entities.pop()),
    ],
    [
      'adds an item before the first one',
      changed(d => d.profiles[0].entities.unshift(ITEM)),
    ],
    [
      'drops the first item, with its comma',
      changed(d => d.profiles[0].entities.shift()),
    ],
    [
      'replaces the last item',
      changed(d => d.profiles[0].entities[1] = ITEM),
    ],
    [
      'writes a list again when every item goes',
      changed(d => d.profiles[0].entities = [ITEM]),
    ],
    [
      'adds a key after the one it follows',
      changed(d => d.profiles[0].metrics_exclude = ['revenue']),
    ],
    [
      'drops a key the catalog no longer has, with its comma',
      changed(d => delete d.deployments),
    ],
    [
      'adds an item to a list of one',
      changed(d => d.deployments.push({name: 'dev', target: 'g/dev'})),
    ],
    [
      'keeps each item\'s text and changes when the catalog reorders a list',
      changed(d => {
        d.profiles[0].entities.reverse();
        d.profiles[0].entities[1].source = 't/orders_v2';
      }),
    ],
  ] as const) {
    for (const [name, layout] of Object.entries(LAYOUTS)) {
      test(`${what}, ${name}`, () => {
        expect(updatedText(block(layout(DATA)), BASE, pulled(data)))
            .toBe(block(layout(data)));
      });
    }
  }

  for (const [what, local, base, data, want] of [
    [
      'writes a new item like the one beside it after a bracket',
      `{
  "deployments": [{
    "name": "default",
    "target": "g/main"
  }]
}`,
      {deployments: DATA.deployments},
      {deployments: [...DATA.deployments, {name: 'dev', target: 'g/dev'}]},
      `{
  "deployments": [{
    "name": "default",
    "target": "g/main"
  }, {
    "name": "dev",
    "target": "g/dev"
  }]
}`,
    ],
    [
      'writes the items an empty list gains in its container\'s layout',
      indented({deployments: []}),
      {deployments: []},
      {deployments: DATA.deployments},
      indented({deployments: DATA.deployments}),
    ],
    [
      'writes a new object with the colon of a pair on one line',
      '{"a":\n[1],\n"b": 2}',
      {a: [1], b: 2},
      {a: [1], b: 2, c: {d: 3}},
      '{"a":\n[1],\n"b": 2,\n"c": {"d": 3}}',
    ],
  ] as const) {
    test(what, () => {
      expect(updatedText(block(local), pulled(base), pulled(data)))
          .toBe(block(want));
    });
  }

  // `data` written in another style changes in that style.
  for (const [what, local, want] of [
    [
      'keeps the escaped line breaks of a double-quoted string',
      '"{\\n  \\"a\\": [1]\\n}"\n', '"{\\n  \\"a\\": [1, 2]\\n}"\n',
    ],
    [
      'keeps a `|+` block that ends in a blank line a block',
      '|+\n      {\n        "a": [1]\n      }\n\n',
      '|\n      {\n        "a": [1, 2]\n      }\n',
    ],
  ] as const) {
    test(what, () => {
      const google = (data: string) =>
          `custom_extensions:\n  - vendor_name: GOOGLE\n    data: ${data}`;
      expect(updatedText(google(local), pulled({a: [1]}), pulled({a: [1, 2]})))
          .toBe(google(want));
    });
  }

  // A block whose `data` is on one line.
  const inline = (data: string, vendor = 'GOOGLE') =>
      `- {vendor_name: ${vendor}, data: '${data}'}  # kept\n`;

  for (const [what, local, base, pulledData, want] of [
    ['keeps a one-line JSON string on one line', '{"a": 1, "b": [1, 2]}',
     '{"a":1,"b":[1,2]}', '{"a":2,"b":[1,2,3]}', '{"a": 2, "b": [1, 2, 3]}'],
    ['keeps each item\'s spacing when the catalog reorders a list',
     '{"fields": [{"name": "a" }, {"name":"b"}]}',
     '{"fields":[{"name":"a"},{"name":"b"}]}',
     '{"fields":[{"name":"b"},{"name":"a"}]}',
     '{"fields": [{"name":"b"}, {"name": "a" }]}'],
    // A comma inside a string is not the text's separator.
    ['writes a new key with the separators of the text\'s entries',
     '{"s": "f(a,b)", "l": [1, 2]}', '{"s":"f(a,b)","l":[1,2]}',
     '{"s":"f(a,b)","l":[1,2],"k":[3,4]}',
     '{"s": "f(a,b)", "l": [1, 2], "k": [3, 4]}'],
    // A quote and a colon inside a key are not the text's separator.
    ['writes a new key with the separator of the text\'s pairs',
     '{"x\\":y": 1}', '{"x\\":y":1}', '{"x\\":y":1,"k":2}',
     '{"x\\":y": 1, "k": 2}'],
    ['writes a new value with the spaces inside the text\'s brackets',
     '{ "a": [ 1 ] }', '{"a":[1]}', '{"a":[1],"b":{"c":[2]}}',
     '{ "a": [ 1 ], "b": { "c": [ 2 ] } }'],
    ['writes a new item with a bare comma beside a bare colon',
     '{"extends":["Thing"]}', '{"extends":["Thing"]}',
     '{"extends":["Thing","Named"]}', '{"extends":["Thing","Named"]}'],
  ] as const) {
    test(what, () => {
      expect(updatedText(inline(local), inline(base), inline(pulledData)))
          .toBe(inline(want));
    });
  }

  // The catalog keeps another vendor's `data` as written.
  test('leaves another vendor\'s data as the catalog holds it', () => {
    const local = inline('{"a": 1}', 'ACME');
    expect(updatedText(local, local, inline('{"a":2}', 'ACME')))
        .toBe(inline('{"a":2}', 'ACME'));
  });

  test('matches a GOOGLE block whatever the case of its vendor_name', () => {
    const local = block(indented(DATA)).replace('GOOGLE', 'Google');
    const data = changed(d => d.deployments[0].target = 'g/prod');
    expect(updatedText(local, BASE, pulled(data)))
        .toBe(block(indented(data)).replace('GOOGLE', 'Google'));
  });

  // JSON reads a lone carriage return as space, and yaml reads the text around
  // it as other values.
  test('writes the catalog\'s data when the local data has a lone carriage ' +
           'return',
       () => {
         const local =
             '- {vendor_name: GOOGLE, data: "{\\"a\\": \\r\\t[1]}"}\n';
         expect(updatedText(local, inline('{"a":[1]}'),
                            inline('{"a":[1],"b":2}')))
             .toBe(
                 '- {vendor_name: GOOGLE, data: ' +
                 '"{\\"a\\":[1],\\"b\\":2}"}\n');
       });
});
