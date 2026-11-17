// Tests for the import of an Apache Ossie file that holds its model at the
// document root (import_model.ts).

import {describe, expect, test} from 'bun:test';

import {importSemanticModelYaml} from '../../../src/libts/semantic/import_model';

const TABLES = 'bigquery.googleapis.com/projects/acme/datasets/sales/tables';

/**
 * An Ossie file of version `version` whose model `name` has dataset orders,
 * with `orders` after its fields, dataset customers, and `rest` after them.
 */
function ossieFile({version = '0.3.0.dev0', name = 'shop', orders = '', rest = ''} = {}):
    string {
  return `version: ${version}
name: ${name}
datasets:
  - name: orders
    source: ${TABLES}/orders
    primary_key: [order_id]
    fields:
      - name: order_id
        expression:
          sql: o_id
      - name: amount
        expression:
          sql: amt
${orders}  - name: customers
    source: ${TABLES}/customers
    fields:
      - name: id
        expression:
          sql: id
${rest}`;
}

describe('an Ossie file with its model at the document root', () => {
  const FILE = `# yaml-language-server: $schema=../core-spec/ossie-schema.json
# The shop.
version: "0.3.0.dev0"
name: Shop model
datasets:
  - name: orders
    source: ${TABLES}/orders
    primary_key: [order_id]
    unique_keys: [[label]]
    fields:
      - name: order_id
        expression:
          sql: o_id
      - name: label
        expression:
          sql: first || last
      - name: amount
        expression:
          sql: orders.amt
    # Totals of an order.
    metrics:
      - name: total  # in dollars
        expression:
          sql: SUM(amount)
    nonportable_extensions:
      - vendor_name: DBT
        data: {price: 1.50, tags: [a]}
relationships:
  - name: orders_orders
    from: orders
    to: orders
    from_columns: [ORDER_ID]
    to_columns: [nope]
metrics:
  - name: total
    expression:
      sql: COUNT(orders.order_id)
`;

  test.each([
    ['google', `# The shop.
version: "0.2.0.dev0/google"
semantic_model:
  - name: Shop-model
    entities:
      - name: orders
        source: ${TABLES}/orders
        primary_key: [o_id]
        unique_keys: [[label]]
        fields:
          - name: order_id
            expression:
              dialects:
                - dialect: OSSIE_SQL_2026
                  expression: o_id
          - name: label
            expression:
              dialects:
                - dialect: OSSIE_SQL_2026
                  expression: first || last
          - name: amount
            expression:
              dialects:
                - dialect: OSSIE_SQL_2026
                  expression: amt
        custom_extensions:
          - vendor_name: DBT
            data: '{"price":1.50,"tags":["a"]}'
    relationships:
      - name: orders_orders
        from: orders
        to: orders
        from_columns: [o_id]
        to_columns: [nope]
    metrics:
      - name: total
        expression:
          dialects:
            - dialect: OSSIE_SQL_2026
              expression: COUNT(orders.order_id)
      # Totals of an order.
      - name: orders_total  # in dollars
        entity: orders
        expression:
          dialects:
            - dialect: OSSIE_SQL_2026
              expression: SUM(orders.amount)
`],
    ['ossie', `# The shop.
version: "0.2.0.dev0"
semantic_model:
  - name: Shop-model
    datasets:
      - name: orders
        source: ${TABLES}/orders
        primary_key: [o_id]
        unique_keys: [[label]]
        fields:
          - name: order_id
            expression:
              dialects:
                - dialect: OSSIE_SQL_2026
                  expression: o_id
          - name: label
            expression:
              dialects:
                - dialect: OSSIE_SQL_2026
                  expression: first || last
          - name: amount
            expression:
              dialects:
                - dialect: OSSIE_SQL_2026
                  expression: amt
        custom_extensions:
          - vendor_name: DBT
            data: '{"price":1.50,"tags":["a"]}'
    relationships:
      - name: orders_orders
        from: orders
        to: orders
        from_columns: [o_id]
        to_columns: [nope]
    metrics:
      - name: total
        expression:
          dialects:
            - dialect: OSSIE_SQL_2026
              expression: COUNT(orders.order_id)
      # Totals of an order.
      - name: orders_total  # in dollars
        expression:
          dialects:
            - dialect: OSSIE_SQL_2026
              expression: SUM(orders.amount)
        custom_extensions:
          - vendor_name: GOOGLE
            data: '{"entity":"orders"}'
`],
  ] as const)('converts it, keeping every other line, into the %s flavor', async (flavor, output) => {
    const res = await importSemanticModelYaml(FILE, {flavor});
    const word = flavor === 'google' ? 'entity' : 'dataset';
    expect(res.files.map(f => f.content)).toEqual([output]);
    expect(res.warnings.slice(0, 16)).toEqual([
      "Removed the editor schema line '# yaml-language-server: $schema=../core-spec/ossie-schema.json', " +
          "which names the input file's schema.",
      "model 'Shop model': wrote its name as 'Shop-model', since a model name holds only " +
          'letters, digits, underscores and hyphens.',
      "Moved the model from the document root into 'semantic_model', and wrote version " +
          `'0.2.0.dev0${flavor === 'google' ? '/google' : ''}' in place of '0.3.0.dev0'.`,
      `${word} 'orders': moved metric 'total' to the model's metrics as 'orders_total', ` +
          "anchored on 'orders', since another metric is named 'total'.",
      `${word} 'orders': renamed 'nonportable_extensions' to 'custom_extensions' and wrote the ` +
          'data of its extension blocks as JSON text.',
      "field 'orders.order_id': moved 'sql' into an 'OSSIE_SQL_2026' entry of 'dialects'.",
      "field 'orders.label': moved 'sql' into an 'OSSIE_SQL_2026' entry of 'dialects'.",
      "field 'orders.amount': moved 'sql' into an 'OSSIE_SQL_2026' entry of 'dialects'.",
      "metric 'total': moved 'sql' into an 'OSSIE_SQL_2026' entry of 'dialects'.",
      "metric 'orders_total': moved 'sql' into an 'OSSIE_SQL_2026' entry of 'dialects'.",
      "field 'orders.amount': wrote its 'OSSIE_SQL_2026' text 'orders.amt' as 'amt'.",
      "metric 'orders_total': wrote its 'OSSIE_SQL_2026' text 'SUM(amount)' as " +
          "'SUM(orders.amount)'.",
      `${word} 'orders': rewrote primary_key entry 'order_id' as column 'o_id', which field ` +
          "'orders.order_id' reads.",
      `${word} 'orders': left unique_keys[0] entry 'label' as written, since field ` +
          "'orders.label' does not read exactly one column that a key can name.",
      "relationship 'orders_orders': rewrote from_columns entry 'ORDER_ID' as column 'o_id', " +
          "which field 'orders.order_id' reads.",
      "relationship 'orders_orders': left to_columns entry 'nope' as written, since it names " +
          `no field of ${word} 'orders'; kcmd reads it as a column name.`,
    ]);
  });

  // [what the input holds, the input, the options, the error import stops on].
  // An import that stops reports no edit but the hyphens it gave the model name.
  test.each([
    ['--input first-party', ossieFile(), {strict: true},
     "Document is an Apache Ossie '0.3.0.dev0' file with its model at the document root, which " +
     "kcmd never writes; import it without '--input first-party'."],
    ['a GOOGLE block', ossieFile({rest: "nonportable_extensions: [{vendor_name: google, data: {}}]\n"}), {},
     "Document holds a 'GOOGLE' extension block, which kcmd never writes in a file with the model " +
     'at the document root; remove it.'],
    ['a semantic_model list', 'version: 0.3.0.dev0\nsemantic_model: [{name: shop}]\n', {},
     "Document is a '0.3.0.dev0' file with a 'semantic_model' list; such a file holds its model at " +
     "the document root. Move the model's keys to the root in place of 'semantic_model'."],
    ['a model name that is not a string', ossieFile({name: '123'}), {},
     'Model name 123 is not a string; write it as one, since import names the file it writes after it.'],
    ['a model name hyphens cannot make valid', ossieFile({name: '1 shop'}), {},
     "Model name '1 shop' is not valid; names must match ^[A-Za-z][A-Za-z0-9_-]*$: a letter, " +
     'then letters, digits, underscores or hyphens.'],
    ['a field name kcmd refuses',
     ossieFile({orders: '      - name: order total\n        expression:\n          sql: amt\n'}), {},
     "entity 'orders': Field name 'order total' is not valid; names must match ^[A-Za-z_][A-Za-z0-9_]{0,299}$: " +
     'a letter or underscore, then letters, digits or underscores.'],
    ['an alias inside the value its anchor names',
     ossieFile({rest: 'nonportable_extensions: [{vendor_name: DBT, data: &a {self: *a}}]\n'}), {},
     "Semantic model load error: could not parse input: Alias '*a' at line 20, column 61 refers to a value " +
     'that contains it; JSON cannot hold such a value.'],
  ])('stops on %s', async (_, input, opts, error) => {
    const res = await importSemanticModelYaml(input, {flavor: 'google', ...opts});
    expect([res.files, res.warnings, res.errors]).toEqual([[], [], [error]]);
  });

  const WRAPPED = "Moved the model from the document root into 'semantic_model', and " +
      "wrote version '0.2.0.dev0/google' in place of '0.3.0.dev0'.";
  // [what the input holds, the input, the options, the line that reports it,
  // and a line of the written file]
  test.each([
    ['an unwrapped 0.2.0.dev0 file', ossieFile({version: '0.2.0.dev0'}), {flavor: 'ossie'},
     "Moved the model from the document root into 'semantic_model'.", 'version: 0.2.0.dev0'],
    ['the schema line of an unwrapped 0.2.0.dev0 file',
     `# yaml-language-server: $schema=s.json\n${ossieFile({version: '0.2.0.dev0'})}`, {flavor: 'ossie'},
     "Removed the editor schema line '# yaml-language-server: $schema=s.json', which names the " +
         "input file's schema.", 'version: 0.2.0.dev0\nsemantic_model:'],
    ['a version after the other keys',
     ossieFile().replace('version: 0.3.0.dev0\n', '').replace('datasets:', '# The datasets.\ndatasets:') +
         '# The version.\nversion: 0.3.0.dev0\n',
     {}, WRAPPED,
     '# The version.\nversion: 0.2.0.dev0/google\nsemantic_model:\n  - name: shop\n' +
         '    # The datasets.\n    entities:\n'],
    ['a byte order mark', `\uFEFF${ossieFile()}`, {}, WRAPPED,
     'version: 0.2.0.dev0/google\nsemantic_model:\n  - name: shop\n'],
    ['a document end marker', `${ossieFile()}...\n`, {}, WRAPPED,
     'semantic_model:\n  - name: shop\n'],
    ['a quoted sql with a comment on and above its key',
     ossieFile({orders: '      - name: x\n        expression:\n          # The sum.\n          sql: "a + b"  # in cents\n'}),
     {}, "field 'orders.x': moved 'sql' into an 'OSSIE_SQL_2026' entry of 'dialects'.",
     '            expression:\n              # The sum.\n              dialects:  # in cents\n' +
         '                - dialect: OSSIE_SQL_2026\n                  expression: "a + b"\n'],
    ['a sql in a block scalar',
     ossieFile({orders: '      - name: x\n        expression:\n          sql: |  # The sum.\n            a +\n              b\n'}),
     {}, "field 'orders.x': moved 'sql' into an 'OSSIE_SQL_2026' entry of 'dialects'.",
     '              dialects:\n                - dialect: OSSIE_SQL_2026\n' +
         '                  expression: |  # The sum.\n                    a +\n                      b\n'],
    ['a sql beside dialects',
     ossieFile({orders: '      - name: x\n        expression:\n          sql: "a"\n          dialects: [{dialect: SNOWFLAKE, expression: b}]\n'}),
     {}, "field 'orders.x': moved 'sql' into an 'OSSIE_SQL_2026' entry of 'dialects'.",
     'dialects: [{dialect: OSSIE_SQL_2026, expression: "a"}, {dialect: SNOWFLAKE, expression: b}]'],
    ['a sql beside an OSSIE_SQL_2026 entry',
     ossieFile({orders: '      - name: x\n        expression:\n          sql: a\n          dialects: [{dialect: OSSIE_SQL_2026, expression: b}]\n'}),
     {}, "field 'orders.x': moved 'sql' into its 'OSSIE_SQL_2026' entry of 'dialects' in place of the " +
         "text 'b', since Ossie reads 'sql' as the 'OSSIE_SQL_2026' text.",
     '          dialects: [{dialect: OSSIE_SQL_2026, expression: a}]\n'],
    ["a relationship's dataset in another letter case",
     ossieFile({rest: 'relationships: [{name: r, from: ORDERS, to: Customers, from_columns: [id], to_columns: [id]}]\n'}),
     {}, "relationship 'r': wrote 'to' entity 'Customers' as 'customers'.", 'from: orders, to: customers'],
    ['a root metrics key with only a comment',
     ossieFile({orders: '    metrics:\n      # The sum.\n      - name: m  # in cents\n        expression:\n' +
                    '          sql: SUM(amount)\n',
                rest: 'metrics:  # model metrics\n'}),
     {}, "entity 'orders': moved metric 'm' to the model's metrics, anchored on 'orders'.",
     '    metrics:  # model metrics\n      # The sum.\n      - name: m  # in cents\n'],
    ['a root metrics key with an empty flow list',
     ossieFile({orders: '    metrics:\n      # The sum.\n      - name: m  # in cents\n        expression:\n' +
                    '          sql: SUM(amount)\n',
                rest: 'metrics: []  # model metrics\n'}),
     {}, "entity 'orders': moved metric 'm' to the model's metrics, anchored on 'orders'.",
     '    metrics:  # model metrics\n      # The sum.\n      - name: m  # in cents\n'],
    ['root keys written after `?`, one with its list left of the key',
     ossieFile({orders: '    metrics:\n      # The sum.\n      - name: m  # in cents\n        expression:\n' +
                    '          sql: SUM(amount)\n',
                rest: '?  metrics  # model metrics\n:\n'})
         .replace('name: shop\ndatasets:\n', '?   name\n: shop\n?     datasets\n:\n'),
     {}, "entity 'orders': moved metric 'm' to the model's metrics, anchored on 'orders'.",
     '    ?  metrics  # model metrics\n    :\n      # The sum.\n      - name: m  # in cents\n'],
    ['a sql in a flow mapping after a key list whose item has an anchor',
     ossieFile().replace('[order_id]\n    fields:\n      - name: order_id\n        expression:\n          sql: o_id\n',
                         '[ &k order_id ]\n    fields:\n      - name: order_id\n        expression: {sql: order_id}\n'),
     {}, "field 'orders.order_id': moved 'sql' into an 'OSSIE_SQL_2026' entry of 'dialects'.",
     '        primary_key: [ &k order_id ]\n        fields:\n          - name: order_id\n' +
         '            expression: {dialects: [ {dialect: OSSIE_SQL_2026, expression: order_id} ]}\n'],
    ['model metrics with an anchor another value names',
     ossieFile({orders: '    metrics:\n      - name: m\n        expression:\n          sql: SUM(amount)\n',
                rest: 'metrics: &mm []\nai_context: {x: *mm}\n'}),
     {}, "entity 'orders': moved metric 'm' to the model's metrics, anchored on 'orders'.",
     '    ai_context: {custom: {x: []}}\n'],
    ['a moved metric with an anchor a later dataset names',
     ossieFile({orders: '    metrics:\n      - name: m\n        description: &d Total amount\n' +
                    '        expression:\n          sql: SUM(amount)\n'})
         .replace('  - name: customers\n', '  - name: customers\n    description: *d\n'),
     {}, "entity 'orders': moved metric 'm' to the model's metrics, anchored on 'orders'.",
     '      - name: customers\n        description: Total amount\n'],
    ['an alias key in a field\'s ai_context over several lines, whose anchor the sql conversion drops',
     ossieFile().replace('      - name: order_id\n        expression:\n          sql: o_id\n',
                         '      - name: order_id\n        expression: {sql: &k o_id}\n' +
                             '        ai_context: {*k : the order id,\n          synonyms: [order]}\n'),
     {flavor: 'ossie'}, "field 'orders.order_id': moved 'sql' into an 'OSSIE_SQL_2026' entry of 'dialects'.",
     '            ai_context: {o_id: the order id,\n              synonyms: [order]}\n'],
    ['an alias key in a field\'s ai_context over several lines that repeats another key',
     ossieFile().replace('      - name: order_id\n        expression:\n          sql: o_id\n',
                         '      - name: order_id\n        expression: {sql: &k o_id}\n' +
                             '        ai_context: {*k : the order id,\n          o_id: again}\n'),
     {flavor: 'ossie'}, "field 'orders.order_id': moved 'sql' into an 'OSSIE_SQL_2026' entry of 'dialects'.",
     '            ai_context: {o_id: again}\n'],
    ['an empty dataset metrics list', ossieFile({orders: '    metrics: []\n'}), {},
     "entity 'orders': removed its empty 'metrics' list, since kcmd lists every metric in the model's " +
         'metrics.',
     '                  expression: amt\n      - name: customers\n'],
    ['a moved metric whose other name a metric has too',
     ossieFile({orders: '    metrics: [{name: m, expression: {sql: COUNT(*)}}]\n',
                rest: 'metrics:\n  - {name: m, expression: {sql: COUNT(*)}}\n  - {name: orders_m, expression: {sql: COUNT(*)}}\n'}),
     {}, "entity 'orders': moved metric 'm' to the model's metrics, anchored on 'orders'; another " +
         "metric is named 'm', and so is one named 'orders_m', so rename it.",
     '      - name: m\n        entity: orders\n'],
    ['a field added to a dataset whose fields key has no value',
     ossieFile({orders: `  - {name: items, source: ${TABLES}/items, fields, metrics: [{name: n, expression: {sql: SUM(source.price)}}]}\n`}),
     {}, "entity 'items': added field 'price', which reads column 'price', for metric 'n'.",
     `      - {name: items, source: ${TABLES}/items, fields: [{name: price, expression: {dialects: ` +
         '[{dialect: OSSIE_SQL_2026, expression: price}]}}]}\n'],
  ] as const)('converts %s', async (_, input, opts, line, written) => {
    const res = await importSemanticModelYaml(input, {flavor: 'google', ...opts});
    expect(res.warnings).toContain(line);
    expect(res.files[0].content).toContain(written);
  });

  // The load error of a written file whose dataset orders keeps its `metrics`.
  const KEPT_METRICS = "Semantic model load error: entity 'orders': unknown key 'metrics'; it takes 'name', " +
      "'source', 'primary_key', 'unique_keys', 'description', 'ai_context', 'fields', 'custom_extensions', " +
      "'extends' and 'abstract'";
  // [what the input holds, the input, the line that reports it, and the load
  // error of the written file]
  test.each([
    ['a source column of a dataset whose fields is not a list',
     ossieFile().replace('    fields:\n      - name: id\n        expression:\n          sql: id\n',
                         '    fields: id\n    metrics: [{name: n, expression: {sql: SUM(source.price)}}]\n'),
     "metric 'n': left 'source.price' as written, since 'fields' of entity 'customers' is not a list.",
     "Semantic model load error: entity 'customers': 'fields' is 'id'; it takes a list"],
    ['a moved metric whose extension blocks are not a list',
     ossieFile({orders: '    metrics: [{name: m, expression: {sql: SUM(amount)}, nonportable_extensions: {vendor_name: DBT}}]\n'}),
     "metric 'm': did not anchor it on 'orders', since its extension blocks are not a list.",
     "Semantic model load error: metric 'm': 'custom_extensions' is a mapping; it takes a list"],
    ["a dataset's metrics that is not a list", ossieFile({orders: '    metrics: oops\n'}),
     "entity 'orders': left its 'metrics' as written, since it is not a list.", KEPT_METRICS],
    ["a dataset's metrics with an entry that has no name",
     ossieFile({orders: '    metrics: [{name: m, expression: {sql: SUM(amount)}}, {expression: {sql: COUNT(*)}}]\n'}),
     "entity 'orders': left its 'metrics' as written, since metric number 2 has no string 'name'.", KEPT_METRICS],
    ["a dataset's metrics beside a model's metrics that is not a list",
     ossieFile({orders: '    metrics: [{name: m, expression: {sql: SUM(amount)}}]\n', rest: 'metrics: oops\n'}),
     "entity 'orders': left its 'metrics' as written, since the model's 'metrics' is not a list.",
     `${KEPT_METRICS}\nmodel 'shop': 'metrics' is 'oops'; it takes a list`],
  ])('leaves %s as written, and stops, since the written file does not load', async (_, input, line, error) => {
    const res = await importSemanticModelYaml(input, {flavor: 'google'});
    expect(res.warnings).toContain(line);
    expect([res.files, res.errors]).toEqual([[], [error]]);
  });

  // A metric of dataset orders whose OSSIE_SQL_2026 text is `sql`.
  const metric = (sql: string) => `    metrics: [{name: m, expression: {sql: '${sql}'}}]\n`;
  // A model metric whose OSSIE_SQL_2026 text is `sql`.
  const modelMetric = (sql: string) => `metrics: [{name: t, expression: {sql: '${sql}'}}]\n`;
  // [what the input holds, its lines after the fields of orders, its lines
  // after the datasets, the line that reports the conversion]
  test.each([
    ["a field text's qualifier that names its own dataset",
     "      - {name: x, expression: {sql: 'ORDERS.a + 1'}}\n", '',
     "field 'orders.x': wrote its 'OSSIE_SQL_2026' text 'ORDERS.a + 1' as 'a + 1'."],
    ["such a qualifier in a text of another dialect",
     '      - {name: x, expression: {dialects: [{dialect: SNOWFLAKE, expression: Orders.a}]}}\n', '',
     "field 'orders.x': wrote its 'SNOWFLAKE' text 'Orders.a' as 'a'."],
    ["such a qualifier in double quotes in an ANSI_SQL text on a BigQuery table",
     '      - {name: x, expression: {dialects: [{dialect: ANSI_SQL, expression: \'"orders"."a"\'}]}}\n', '',
     "field 'orders.x': wrote its 'ANSI_SQL' text '\"orders\".\"a\"' as '\"a\"', and BigQuery would " +
         'read its double-quoted words as text.'],
    ["a moved metric's field", metric('SUM(Amount)'), '',
     "metric 'm': wrote its 'OSSIE_SQL_2026' text 'SUM(Amount)' as 'SUM(orders.amount)'."],
    ["a moved metric's source column that a field reads", metric('SUM(source.AMT)'), '',
     "metric 'm': wrote its 'OSSIE_SQL_2026' text 'SUM(source.AMT)' as 'SUM(orders.amount)'."],
    ["a moved metric's source column that no field reads", metric('SUM(source.price)'), '',
     "dataset 'orders': added field 'price', which reads column 'price', for metric 'm'."],
    ["a source column named like a field that reads another", metric('SUM(source.amount)'), '',
     "metric 'm': left 'source.amount' as written, since field 'orders.amount' reads another column."],
    ['a source column whose name is no field name', metric('SUM(source."a b")'), '',
     "metric 'm': left 'source.\"a b\"' as written, since a field named 'a b' breaks kcmd's name rules."],
    ['a source column named like a metric', '    metrics: [{name: price, expression: {sql: SUM(source.price)}}]\n', '',
     "metric 'price': left 'source.price' as written, since a field named 'price' would collide with " +
         "metric 'price'."],
    ["a model metric's names in another letter case and in quotes", '',
     modelMetric('SUM(ORDERS.AMOUNT) + SUM("ORDERS".amount) + SUM("orders".amount)'),
     "metric 't': wrote its 'OSSIE_SQL_2026' text 'SUM(ORDERS.AMOUNT) + SUM(\"ORDERS\".amount) + " +
         "SUM(\"orders\".amount)' as 'SUM(orders.amount) + SUM(orders.amount) + SUM(\"orders\".amount)'."],
    ["a model metric's qualifier in another letter case in a text of another dialect", '',
     "metrics: [{name: t, expression: {dialects: [{dialect: SNOWFLAKE, expression: 'SUM(ORDERS.amount)'}]}}]\n",
     "metric 't': wrote its 'SNOWFLAKE' text 'SUM(ORDERS.amount)' as 'SUM(orders.amount)'."],
    ['a text the parser cannot read', metric('SUM(amount'), '',
     "metric 'm': left its 'OSSIE_SQL_2026' text as written, since kcmd cannot read it."],
    ["a moved metric's field and source column in a text of another dialect",
     "    metrics: [{name: m, expression: {dialects: [{dialect: BIGQUERY, expression: 'SUM(amount) + SUM(source.x)'}]}}]\n",
     '', "metric 'm': its 'BIGQUERY' text names fields of dataset 'orders' without a qualifier and " +
         "reads 'source.<column>'; import converts these only in an 'OSSIE_SQL_2026' text, so they " +
         'stay as written.'],
    ['a call of AGG', metric('SUM(amount)'), modelMetric('AGG(orders.m) * 2'),
     "metric 't': wrote 'AGG(orders.m)' as '(SUM(orders.amount))'."],
    ['a call of AGG with FILTER', metric('SUM(amount)'), modelMetric('AGG(orders.m) FILTER (WHERE orders.amount > 0)'),
     "metric 't': left 'AGG(orders.m) FILTER (WHERE orders.amount > 0)' as written, since AGG takes no " +
         'FILTER clause.'],
    ['a call of AGG with OVER', metric('SUM(amount)'), modelMetric('AGG(orders.m) OVER ()'),
     "metric 't': left 'AGG(orders.m) OVER ()' as written, since kcmd cannot write a metric before OVER."],
    ['a call of AGG whose metric names no field', metric('COUNT(*)'), modelMetric('AGG(orders.m) * 2'),
     "metric 't': left 'AGG(orders.m)' as written, since the 'OSSIE_SQL_2026' text of that metric " +
         "names no field of dataset 'orders'."],
    ['a call of AGG that names no metric with such a text', '', modelMetric('AGG(orders.m)'),
     "metric 't': left 'AGG(orders.m)' as written, since it does not name a dataset's metric with an " +
         "'OSSIE_SQL_2026' text."],
  ])('converts the names of %s', async (_, orders, rest, line) => {
    const res = await importSemanticModelYaml(ossieFile({orders, rest}), {flavor: 'ossie'});
    expect(res.warnings).toContain(line);
  });

  test('quotes a dataset name the parser reads as a keyword, and inlines a call of AGG on it', async () => {
    const input = ossieFile({orders: metric('SUM(amount)'), rest: modelMetric('AGG("ORDER".m) * 2')})
        .replace('- name: orders', '- name: Order');
    const res = await importSemanticModelYaml(input, {flavor: 'google'});
    expect(res.files[0].content).toContain('expression: SUM("Order".amount)');
    expect(res.warnings).toContain(`metric 't': wrote 'AGG("ORDER".m)' as '(SUM("Order".amount))'.`);
  });

  test('adds a BIGQUERY text beside each OSSIE_SQL_2026 text under --transpile', async () => {
    const res = await importSemanticModelYaml(ossieFile({orders: metric('SUM(amount)')}), {flavor: 'google', transpile: true});
    const content = res.files[0].content;
    expect(content).toContain(
        '                - dialect: OSSIE_SQL_2026\n                  expression: o_id\n' +
        '                - dialect: BIGQUERY\n                  expression: o_id\n');
    expect(content).toContain(
        '            - dialect: OSSIE_SQL_2026\n              expression: SUM(orders.amount)\n' +
        '            - dialect: BIGQUERY\n              expression: SUM(orders.amount)\n');
  });

  test('gives no advice about a profile file beside it', async () => {
    const res = await importSemanticModelYaml(
        ossieFile(), {flavor: 'google', profileFiles: [{fileName: 'shop.profile.dev.yaml', content: 'name: dev\n'}]});
    expect(res.warnings.join('\n')).not.toContain('shop.profile.dev.yaml');
  });

  const VANILLA = `# yaml-language-server: $schema=ossie.json\nversion: "0.2.0.dev0"\nsemantic_model:\n` +
      `  - name: shop\n    datasets:\n      - name: orders\n        source: ${TABLES}/orders\n` +
      '        fields: [{name: id, expression: {dialects: [{dialect: BIGQUERY, expression: id}]}}]\n';
  test.each([
    ['a vanilla file becomes a Google one', VANILLA, {flavor: 'google'}],
    ['a first-party Google file becomes a vanilla one',
     VANILLA.replace('"0.2.0.dev0"', '"0.2.0.dev0/google"').replace('datasets:', 'entities:'),
     {flavor: 'ossie', strict: true}],
  ] as const)('removes the editor schema line when %s', async (_, input, opts) => {
    const res = await importSemanticModelYaml(input, opts);
    expect(res.warnings[0]).toBe(
        "Removed the editor schema line '# yaml-language-server: $schema=ossie.json', which names " +
        "the input file's schema.");
    expect(res.files[0].content).not.toContain('yaml-language-server');
  });

  test('reports no schema line removal when a first-party import stops', async () => {
    const res = await importSemanticModelYaml(
        VANILLA.replace('dialect: BIGQUERY', 'dialect: MDX'), {flavor: 'google', strict: true});
    expect(res.errors).not.toEqual([]);
    expect(res.warnings.join('\n')).not.toContain('schema line');
  });
});
