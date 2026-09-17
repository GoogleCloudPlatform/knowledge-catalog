// Behavior specification for the MCP Toolbox -> OSI converter
// (convertToolboxToOsi in src/libts/semantic/converters/toolbox/convert.ts).
//
// The converter answers one question: is an MCP Toolbox configuration enough to
// reconstruct a semantic model? A configuration is a list of CALLABLE things --
// it has verbs and no nouns -- so the answer depends entirely on whether the
// nouns can be read out of the SQL inside the verbs. What is pinned here is
// therefore split in two:
//
//   1. What the import RECOVERS. Both fixtures are the published Toolbox
//      quickstart configurations, unedited, so these tests say what a real
//      config yields rather than what a config written for the test does: the
//      tables become entities, the joins become relationships pointing the
//      right way, the DML tools become actions whose blast radius was read out
//      of the statement rather than taken on trust, and the result loads and
//      validates through kcmd's own loader.
//   2. What it CANNOT, which is the more useful half. A primary key, a
//      parameter's description, a named subset of tools, a statement whose
//      table is supplied at call time: each of those is pinned as a warning,
//      because each is a real difference between the two formats and not an
//      unfinished corner of the converter.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {convertToolboxToOsi} from '../../../src/libts/semantic/converters/toolbox/convert';
import {parseToolboxConfig} from '../../../src/libts/semantic/converters/toolbox/parse';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';
import {modelTools} from '../../../src/libts/semantic/runtime/agent_tools';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

const FIXTURES = path.join(__dirname, 'fixtures', 'toolbox');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function convert(name: string, modelName: string) {
  return convertToolboxToOsi([readFixture(name)], modelName);
}

// Loads a converted document the way `kcmd push` would. A Toolbox import is
// BOUND -- entities carry their table and fields carry their column -- so the
// ordinary loader is used, not the bindingOptional one the OWL import needs.
function load(yaml: string): SemanticModel {
  const result = loadModels(yaml);
  expect(result.models).toHaveLength(1);
  return result.models[0];
}

function entity(model: SemanticModel, name: string) {
  const found = model.entities.find(e => e.name === name);
  expect(found).toBeDefined();
  return found!;
}

function action(model: SemanticModel, name: string) {
  const found = (model.actions ?? []).find(a => a.name === name);
  expect(found).toBeDefined();
  return found!;
}

function matching(warnings: string[], fragment: string): string[] {
  return warnings.filter(w => w.includes(fragment));
}


describe('the Toolbox quickstart configuration imports as a model', () => {
  const result = convert('hotels.tools.yaml', 'hotels');
  const model = load(result.yaml);

  test('the one table its tools name becomes the one entity', () => {
    expect(model.entities.map(e => e.name)).toEqual(['hotels']);
  });

  test('a column is recovered from a predicate as well as a projection', () => {
    // Every statement in this config is either `SELECT *` (which projects no
    // column an analyzer can name) or an UPDATE. So `name` and `location` are
    // known only because the two search tools filter on them -- which is the
    // whole reason those tools exist.
    expect(entity(model, 'hotels').fields.map(f => f.name).sort()).toEqual([
      'booked', 'checkin_date', 'checkout_date', 'id', 'location', 'name'
    ]);
  });

  test('each field is bound to its column', () => {
    expect(entity(model, 'hotels').fields.find(f => f.name === 'booked'))
        .toMatchObject({expression: 'booked'});
  });

  test('the three write tools become actions and the two reads do not', () => {
    expect((model.actions ?? []).map(a => a.name)).toEqual([
      'book-hotel', 'update-hotel', 'cancel-hotel'
    ]);
  });

  test('a positional placeholder becomes the parameter it binds', () => {
    // The authored statement is
    //   UPDATE hotels SET checkin_date = CAST($2 as date),
    //                     checkout_date = CAST($3 as date) WHERE id = $1
    // so the placeholders are OUT OF ORDER: a rewrite that renamed them in the
    // order they appear would swap the row's identity for its check-in date.
    // They are matched by the index the placeholder carries instead.
    expect(action(model, 'update-hotel').executor).toEqual({
      kind: 'sql',
      sql: {
        statements: [
          'UPDATE hotels SET checkin_date = CAST(@checkin_date AS DATE), ' +
          'checkout_date = CAST(@checkout_date AS DATE) WHERE id = @hotel_id'
        ],
      },
    });
  });

  test('an action\'s blast radius is read out of its statement', () => {
    // Not taken from the tool's annotations, which say only "destructive":
    // `affects` names the table the UPDATE targets and the columns it SETs,
    // and the `id` it matches on is excluded because the statement reads it to
    // find the row rather than changing it.
    expect(action(model, 'update-hotel').affects).toEqual([{
      concept: 'hotels',
      operation: 'modify',
      fields: ['checkin_date', 'checkout_date'],
    }]);
    expect(action(model, 'cancel-hotel').affects).toEqual([
      {concept: 'hotels', operation: 'modify', fields: ['booked']},
    ]);
  });

  test('the converted document passes the checks a push runs', () => {
    expect(validatePushRequirements([{document: 'hotels', model}], {
      targetOptional: true,
    })).toEqual([]);
  });

  test('a non-Google source binds to no store, and says so', () => {
    // A `postgres` source names a host and a port. kcmd derives the store a
    // model runs against from its entities' sources and recognizes Spanner,
    // AlloyDB and BigQuery, so this model publishes to Knowledge Catalog and
    // runs nowhere -- which the import states rather than leaving to be
    // discovered at the first call.
    expect(entity(model, 'hotels').dataSource).toBe('hotels');
    expect(matching(result.warnings, 'nothing runs against it'))
        .toHaveLength(1);
  });
});


describe('the Toolbox AlloyDB quickstart imports with its edges', () => {
  const result = convert('flower_shop.tools.yaml', 'flower_shop');
  const model = load(result.yaml);

  test('an alias is not mistaken for a table', () => {
    // `cart_items ci JOIN cart c ...` parses with the alias in a node of the
    // same shape as a table reference, so a walk that took every one of them
    // would add `ci` and `c` as entities of their own.
    expect(model.entities.map(e => e.name).sort()).toEqual([
      'cart', 'cart_items', 'products'
    ]);
  });

  test('a join becomes a relationship pointing from the foreign key', () => {
    // An ON clause is symmetric and a relationship is not. `cart_items.cart_id`
    // names `cart`, so it is the foreign key and its side is the source --
    // read out of the column's own name, not assumed from the order written.
    expect(model.relationships).toEqual([
      {
        name: 'cart_items_cart',
        source: {entity: 'cart_items', columns: ['cart_id']},
        destination: {entity: 'cart', columns: ['cart_id']},
      },
      {
        name: 'cart_items_products',
        source: {entity: 'cart_items', columns: ['product_id']},
        destination: {entity: 'products', columns: ['product_id']},
      },
    ]);
  });

  test('a Google source becomes a resource name kcmd can address', () => {
    expect(entity(model, 'cart_items').dataSource)
        .toBe(
            '//alloydb.googleapis.com/projects/my-project/locations/' +
            'us-central1/clusters/my-cluster/instances/my-instance/' +
            'databases/my-database/tables/cart_items');
  });

  test('an INSERT names the columns it writes, a DELETE names none', () => {
    expect(action(model, 'add-to-cart').affects).toEqual([{
      concept: 'cart_items',
      operation: 'create',
      fields: ['cart_id', 'product_id', 'quantity', 'price'],
    }]);
    expect(action(model, 'delete-from-cart').affects).toEqual([
      {concept: 'cart_items', operation: 'delete'},
    ]);
  });

  test('a parameter arrives whole: type, sentence and optionality', () => {
    // The description is the load-bearing string in a Toolbox parameter -- it
    // is what the agent reads to decide what to put in the argument -- and it
    // carries across since #442 gave ActionParameter somewhere to put it.
    expect(action(model, 'add-to-cart').parameters).toEqual([
      {
        name: 'cart_id',
        type: 'Integer',
        description: 'The id of the cart.',
        required: true,
        isEntityRef: false,
      },
      {
        name: 'product_id',
        type: 'Integer',
        description: 'The id of the product.',
        required: true,
        isEntityRef: false,
      },
      {
        name: 'quantity',
        type: 'Integer',
        description: 'The quantity of items to add.',
        required: true,
        isEntityRef: false,
      },
      {
        name: 'price',
        type: 'Float',
        description: 'The price of items to add.',
        required: true,
        isEntityRef: false,
      },
    ]);
  });

  test('a tool that wraps an API rather than a statement is skipped', () => {
    expect(matching(result.warnings, 'ask-questions-about-products'))
        .toHaveLength(1);
    expect(result.stats).toMatchObject({toolsRead: 3, toolsSkipped: 1});
  });

  test('the converted document passes the checks a push runs', () => {
    expect(validatePushRequirements([{document: 'flower_shop', model}], {
      targetOptional: true,
    })).toEqual([]);
  });
});


describe('what a configuration cannot say', () => {
  const hotels = convert('hotels.tools.yaml', 'hotels');
  const shop = convert('flower_shop.tools.yaml', 'flower_shop');

  test('no entity gets a primary key, and the candidates are reported', () => {
    for (const e of load(shop.yaml).entities) expect(e.keys).toEqual([]);
    // A join column is the closest thing to evidence of a key a configuration
    // contains, so it is named in the warning and written nowhere: a wrong key
    // is worse than an absent one.
    expect(matching(shop.warnings, `entity 'cart_items' has no primary_key`))
        .toEqual([
          `entity 'cart_items' has no primary_key: a Toolbox configuration ` +
          `never states one. Joined on 'cart_id', 'product_id', which is ` +
          `where a key usually is.`
        ]);
  });

  test('a value restriction has to become a constraint', () => {
    // What a parameter still cannot say on its own. An allowed-values list is a
    // rule about the argument, and a rule lives in a constraint that guards the
    // action -- so the import names the destination rather than dropping it.
    const {warnings} = convertToolboxToOsi(
        [`
kind: source
name: pg
type: postgres
---
kind: tool
name: set-status
type: postgres-sql
source: pg
description: Set an order's status.
parameters:
  - name: order_id
    type: string
    description: The order.
  - name: status
    type: string
    description: The new status.
    allowedValues: [open, shipped, cancelled]
  - name: notify
    type: boolean
    description: Whether to notify the customer.
    default: false
statement: UPDATE orders SET status = $2 WHERE id = $1;
`],
        'restricted');
    expect(matching(warnings, `parameter 'status'`)).toEqual([
      `parameter 'status' of tool 'set-status' restricts its values, which ` +
      `OSI cannot say on a parameter. Write the restriction as a constraint ` +
      `and guard the action with it`
    ]);
  });

  test('a defaulted parameter states its default and not its necessity', () => {
    // OSI rejects `required: true` beside a `default` -- a value that is always
    // supplied cannot also be demanded -- so the import writes one or the
    // other. Toolbox's own `required` is nil-defaults-to-TRUE, the opposite of
    // how an absent flag usually reads, which is why the undefaulted ones come
    // out as an explicit `required: true` rather than silence.
    const {yaml} = convertToolboxToOsi(
        [`
kind: source
name: pg
type: postgres
---
kind: tool
name: set-status
type: postgres-sql
source: pg
description: Set an order's status.
parameters:
  - name: order_id
    type: string
    description: The order.
  - name: notify
    type: boolean
    description: Whether to notify the customer.
    default: false
statement: UPDATE orders SET status = 'shipped' WHERE id = $1;
`],
        'defaulted');
    const params = load(yaml).actions![0].parameters;
    expect(params).toEqual([
      {
        name: 'order_id',
        type: 'String',
        description: 'The order.',
        required: true,
        isEntityRef: false,
      },
      {
        name: 'notify',
        type: 'Boolean',
        description: 'Whether to notify the customer.',
        default: false,
        isEntityRef: false,
      },
    ]);
  });

  test('a toolset has no counterpart and is dropped', () => {
    expect(matching(hotels.warnings, `dropped group 'my-toolset'`))
        .toHaveLength(1);
  });

  test('a tool whose table arrives at call time is skipped entirely', () => {
    const {warnings, stats} = convertToolboxToOsi(
        [`
kind: source
name: pg
type: postgres
---
kind: tool
name: count-rows
type: postgres-sql
source: pg
description: Count the rows of a table.
templateParameters:
  - name: tableName
    type: string
    description: The table to count.
statement: SELECT COUNT(*) FROM {{.tableName}};
---
kind: tool
name: get-hotel
type: postgres-sql
source: pg
description: Get one hotel.
parameters:
  - name: id
    type: string
    description: The hotel id.
statement: SELECT id, name FROM hotels WHERE id = $1;
`],
        'templated');
    // A template parameter is interpolated into the statement before it is
    // prepared, so the statement is not fixed and what it touches cannot be
    // declared ahead of the call -- which is the one thing a semantic model
    // has to be able to say.
    expect(stats).toMatchObject({toolsRead: 1, toolsSkipped: 1, entities: 1});
    expect(matching(warnings, 'templateParameters')).toHaveLength(1);
  });
});


describe('both configuration spellings read the same', () => {
  // Toolbox accepts a flat form (one document per object, `kind` naming the
  // primitive and `type` the concrete type) and a nested one (maps keyed by
  // name, `kind` naming the concrete type), and rewrites the second into the
  // first at load. Real configurations in the wild use both.
  const nested = `
sources:
  pg:
    kind: postgres
    host: 127.0.0.1
    database: shop
tools:
  get-hotel:
    kind: postgres-sql
    source: pg
    description: Get one hotel.
    parameters:
      - name: id
        type: string
        description: The hotel id.
    statement: SELECT id, name FROM hotels WHERE id = $1;
toolsets:
  everything:
    - get-hotel
`;

  const flat = `
kind: source
name: pg
type: postgres
host: 127.0.0.1
database: shop
---
kind: tool
name: get-hotel
type: postgres-sql
source: pg
description: Get one hotel.
parameters:
  - name: id
    type: string
    description: The hotel id.
statement: SELECT id, name FROM hotels WHERE id = $1;
---
kind: toolset
name: everything
tools:
  - get-hotel
`;

  test('the nested form parses to the flat one', () => {
    expect(parseToolboxConfig([nested]).config)
        .toEqual(parseToolboxConfig([flat]).config);
  });

  test('and converts to the same model', () => {
    expect(convertToolboxToOsi([nested], 'shop').yaml)
        .toEqual(convertToolboxToOsi([flat], 'shop').yaml);
  });

  test('a document the importer does not read is named, not ignored', () => {
    const {warnings} = parseToolboxConfig([`
kind: prompt
name: greeting
messages:
  - role: user
    content: hello
`]);
    expect(matching(warnings, `ignored 'prompt' document 'greeting'`))
        .toHaveLength(1);
  });
});


describe('the read tools come back derived from the model', () => {
  // The punchline of the import, and the sharpest statement of the difference
  // between the two formats. A SELECT tool imports to NOTHING: a lookup over an
  // entity is not something a semantic model stores, it is something kcmd
  // generates from the entity. So the tools that went in as hand-written
  // documents come back out of the model, and the configuration's author never
  // has to write the next one.
  const model = load(convert('hotels.tools.yaml', 'hotels').yaml);

  const tools = modelTools({
    runtime: {
      model,
      document: 'hotels',
      profile: 'default',
      entryGroup: 'test',
      storeError: 'no store in this test',
    },
  });

  test('every entity gets a lookup nobody wrote', () => {
    expect(tools.lookups.map(t => t.name)).toEqual(['find_hotels']);
  });

  test('the lookup filters on the columns the search tools filtered on', () => {
    // `search-hotels-by-name` and `search-hotels-by-location` were two hand
    // written tools; they come back as two optional filters on one derived one.
    const filters = tools.lookups[0].parameters.map(p => p.name);
    expect(filters).toContain('name');
    expect(filters).toContain('location');
  });

  test('every imported action gets a tool', () => {
    expect(tools.actions.map(t => t.name)).toEqual([
      'book_hotel', 'update_hotel', 'cancel_hotel'
    ]);
  });
});


describe('the database a statement runs against is imported too', () => {
  // An entity's `source` says where a field lives. A `deployment_target` says
  // where a statement EXECUTES, and kcmd asks for one before it offers an agent
  // any tool at all -- so this is what separates a model that loads from a
  // model that runs. A Toolbox source states it outright, since holding a
  // connection is the whole reason a source exists.
  test('a Google source yields the database, one level above the table', () => {
    const model = load(convert('flower_shop.tools.yaml', 'flower_shop').yaml);
    expect(model.customExtensions).toEqual([{
      vendorName: 'GOOGLE',
      data: JSON.stringify({
        deploymentTargets:
            ['//alloydb.googleapis.com/projects/my-project/locations/' +
             'us-central1/clusters/my-cluster/instances/my-instance/' +
             'databases/my-database'],
      }),
    }]);
  });

  test('so the whole configuration round-trips into a runnable surface', () => {
    const model = load(convert('flower_shop.tools.yaml', 'flower_shop').yaml);
    const tools = modelTools({
      runtime: {
        model,
        document: 'flower_shop',
        profile: 'default',
        entryGroup: 'test',
        storeError: 'no store in this test',
      },
    });
    // Four tools went in, one was skipped, and five come out: the two writes
    // that were authored, plus a lookup for each entity that was not.
    expect(tools.actions.map(t => t.name)).toEqual([
      'add_to_cart', 'delete_from_cart'
    ]);
    expect(tools.lookups.map(t => t.name)).toEqual([
      'find_cart', 'find_cart_items', 'find_products'
    ]);
  });

  test('a non-Google source yields none, so no tool is offered', () => {
    // The ceiling, stated as a test rather than left to be met at runtime: a
    // plain `postgres` source names a host and a port, kcmd addresses Spanner,
    // AlloyDB and BigQuery, and a model with nowhere to run offers nothing.
    const model = load(convert('hotels.tools.yaml', 'hotels').yaml);
    expect(model.customExtensions).toBeUndefined();
  });

  test('two databases in one configuration are reported, not picked', () => {
    const {warnings} = convertToolboxToOsi(
        [`
kind: source
name: a
type: spanner
project: my-project
instance: my-instance
database: one
---
kind: source
name: b
type: spanner
project: my-project
instance: my-instance
database: two
---
kind: tool
name: read-a
type: postgres-sql
source: a
description: Read a.
statement: SELECT id FROM accounts;
---
kind: tool
name: read-b
type: postgres-sql
source: b
description: Read b.
statement: SELECT id FROM ledgers;
`],
        'split');
    expect(matching(warnings, 'name 2 different databases')).toHaveLength(1);
  });
});
