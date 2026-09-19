// Tests for `kcmd action` (src/tool/commands.ts, action()) -- the command in
// front of the semantic runtime.
//
// Almost nothing here reaches a store, and that is not a compromise: `list`
// never opens one, and every `run` covered but the last fails before the first
// request. The exception fakes the Spanner client's own surface, because what
// it checks is the QUESTION the runtime asks the store. The
// argument parse, the choice of database, and the runtime's own refusal to run
// an action a constraint is supposed to decide all happen before a session
// exists. What is under test is the wiring -- that the command finds the model,
// merges the profile, parses the arguments, picks the database from the
// deployment target rather than from a flag, and hands the runtime's answer
// back as an exit code. It runs in a temp working directory with a pinned
// context, mirroring profiles.test.ts.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../src/libts/gcp/context';
import {SpannerDataClient} from '../../src/libts/gcp/spanner';
import {action} from '../../src/tool/commands';

const CTX = new ApiContext('test-project', 'us', 'test-token');

const SPANNER = '//spanner.googleapis.com/projects/acme-ops/instances/prod';

// The model as authored: bound to Spanner, with one action the runtime could
// run and one it could not, plus the two constraint shapes -- an invariant over
// stored data and a guard over an argument.
const MODEL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: ${SPANNER}/databases/commerce/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${SPANNER}/databases/commerce/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
          - { name: total, expression: Total }
      - name: Entry
        source: ${SPANNER}/databases/commerce/tables/LedgerEntry
        primary_key: [key]
        fields:
          - { name: key, expression: EntryId }
          - { name: amount, expression: Amount }
    actions:
      - name: IssueCredit
        description: Credit an order
        executor:
          sql:
            statements:
              - >-
                INSERT INTO LedgerEntry (EntryId, OrderId, Amount)
                VALUES (GENERATE_UUID(), @order, @amount)
        parameters:
          - {name: order, type: Order}
          - {name: amount, type: Decimal}
        guards: [CreditIsPositive]
        affects:
          - {concept: Entry, operation: create}
      - name: NotifyCustomer
        executor:
          mcp:
            server: //agentregistry.googleapis.com/projects/acme-ops/locations/us-central1/mcpServers/commerce
            tool: notify
        parameters:
          - {name: order, type: Order}
    constraints:
      - name: TotalStaysPositive
        judgment: The resulting Order.total must not be negative.
        on_violation: reject
        description: An order total never goes negative.
      - name: CreditIsPositive
        judgment: The amount argument of this call must be positive.
        on_violation: reject
        description: A credit must be for a positive amount.
`;

// The same model with nothing to run.
const NO_ACTIONS = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: ${SPANNER}/databases/commerce/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${SPANNER}/databases/commerce/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`;

// An analytical binding: the same concepts, deployed to BigQuery.
const ANALYTICAL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/propertyGraphs/commerce
    entities:
      - name: Order
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
        fields:
          - { name: key, expression: order_id }
          - { name: total, expression: total }
      - name: Entry
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/ledger
        fields:
          - { name: key, expression: entry_id }
          - { name: amount, expression: amount }
`;

// A read-only binding of the same store. An executor is a physical facet, so
// a profile can withdraw one with `executor: null` -- the action stays
// declared and published, and simply cannot be performed here.
const READONLY = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: ${SPANNER}/databases/commerce/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${SPANNER}/databases/commerce/tables/Orders
        fields:
          - { name: key, expression: OrderId }
          - { name: total, expression: Total }
      - name: Entry
        source: ${SPANNER}/databases/commerce/tables/LedgerEntry
        fields:
          - { name: key, expression: EntryId }
          - { name: amount, expression: Amount }
    actions:
      - name: IssueCredit
        executor: null
`;

// A binding whose deployment target and entity sources disagree about which
// database they mean.
const MISMATCHED = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: ${SPANNER}/databases/archive/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${SPANNER}/databases/commerce/tables/Orders
        fields:
          - { name: key, expression: OrderId }
          - { name: total, expression: Total }
      - name: Entry
        source: ${SPANNER}/databases/commerce/tables/LedgerEntry
        fields:
          - { name: key, expression: EntryId }
          - { name: amount, expression: Amount }
`;


// A binding that points the model at Spanner and leaves its entities in
// BigQuery. The statements would still run -- they name a table, not a
// database -- so the write would land in whatever Spanner table shares the
// name while the data the model describes sat untouched in the other system.
const CROSSBOUND = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: ${SPANNER}/databases/commerce/propertyGraphs/commerce
    entities:
      - name: Order
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
        fields:
          - { name: key, expression: order_id }
          - { name: total, expression: total }
      - name: Entry
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/ledger
        fields:
          - { name: key, expression: entry_id }
          - { name: amount, expression: amount }
`;


// A second document in the same scope, whose action names a concept the model
// does not declare. Running an action in ANOTHER document must not be blocked
// by it.
const WAREHOUSE = `version: "0.2.0.dev0/google"
semantic_model:
  - name: warehouse
    deployment_target: ${SPANNER}/databases/commerce/propertyGraphs/warehouse
    entities:
      - name: Bin
        source: ${SPANNER}/databases/commerce/tables/Bins
        primary_key: [key]
        fields:
          - { name: key, expression: BinId }
    actions:
      - name: Restock
        executor:
          sql:
            statements:
              - UPDATE Bins SET Held = Held + 1 WHERE BinId = @bin
        parameters:
          - {name: bin, type: Bin}
        affects:
          - {concept: Pallet, operation: modify}
`;


// A subtype whose identifying field is its supertype's. Nothing else here has
// inheritance, and the run path is the one reader for which not resolving it
// is unsafe rather than merely incomplete.
const INHERITS = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: ${SPANNER}/databases/commerce/propertyGraphs/commerce
    entities:
      - name: Party
        source: ${SPANNER}/databases/commerce/tables/Parties
        primary_key: [key]
        fields:
          - { name: key, expression: PartyId }
          - { name: name, expression: FullName, datatype: String }
      - name: Customer
        extends: [Party]
        source: ${SPANNER}/databases/commerce/tables/Customers
        primary_key: [key]
        fields:
          - { name: key, expression: CustomerId }
    actions:
      - name: Touch
        executor:
          sql:
            statements:
              - >-
                UPDATE Customers SET LastSeen = CURRENT_TIMESTAMP()
                WHERE CustomerId = @who
        parameters:
          - {name: who, type: Customer}
        affects:
          - {concept: Customer, operation: modify, fields: [key]}
`;

let dir = '';
let cwd = '';
let logs: string[] = [];

function writeWorkspace(modelText = MODEL): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.test-project.us.commerce_eg\n');
  const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
  fs.mkdirSync(path.join(eg, 'commerce.profiles'), {recursive: true});
  fs.writeFileSync(path.join(eg, 'commerce.yaml'), modelText);
  fs.writeFileSync(
      path.join(eg, 'commerce.profiles', 'analytical.yaml'), ANALYTICAL);
  fs.writeFileSync(
      path.join(eg, 'commerce.profiles', 'mismatched.yaml'), MISMATCHED);
  fs.writeFileSync(
      path.join(eg, 'commerce.profiles', 'readonly.yaml'), READONLY);
  fs.writeFileSync(
      path.join(eg, 'commerce.profiles', 'crossbound.yaml'), CROSSBOUND);
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-action-'));
  process.chdir(dir);
  logs = [];
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  for (const channel of ['log', 'warn', 'error'] as const) {
    spyOn(console, channel).mockImplementation((...a: any[]) => {
      logs.push(a.join(' '));
    });
  }
});

afterEach(() => {
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});


describe('kcmd action list', () => {
  test(
      'prints each action with what it takes, what it touches, and the ' +
           'command line that runs it',
       async () => {
         writeWorkspace();
         const code = await action('list', undefined);
         expect(code).toBe(0);
         const out = logs.join('\n');

        expect(out).toContain(
            'Model \'commerce\' (commerce_eg), profile \'default\'');
         expect(out).toContain('IssueCredit: Credit an order');

         // An entity-typed parameter is marked as a reference: the caller
         // passes something to look up, not a value.
        expect(out).toContain(
            'parameters: order (Order, reference), amount (Decimal)');
         expect(out).toContain('executor:   sql');
         expect(out).toContain('guards:     CreditIsPositive');
         expect(out).toContain('affects:    Entry (create)');

         // The point of the listing: the reader can copy this and run it.
        // IssueCredit names a guard, and a guard is settled by asking, so the
        // line carries the flags that supply a judge -- see the judge-flag
        // test below for why both of them.
         expect(out).toContain(
            'run:        kcmd action run IssueCredit --judge ' +
            '--judge-reads-store --arg order=<Order> --arg amount=<Decimal>');

         // An action with no description, guards or blast radius shows only
         // what it declares.
         expect(out).toContain('NotifyCustomer');
         expect(out).toContain('executor:   mcp');
        expect(out).toContain(
            'run:        kcmd action run NotifyCustomer --arg order=<Order>');
       });

  test(
      'shows defaults and optionality in parameters and omits them from the run line',
       async () => {
         const optionalModel = MODEL.replace(
             '          - {name: order, type: Order}\n          - {name: amount, type: Decimal}',
             '          - {name: order, type: Order}\n' +
                 '          - {name: amount, type: Decimal}\n' +
                 '          - {name: currency, type: String, default: USD}\n' +
                 '          - {name: blank, type: String, default: ""}\n' +
                 '          - {name: cleared, type: Boolean, default: null}\n' +
                 '          - {name: literalNull, type: String, default: "null"}\n' +
                 '          - {name: memo, type: String, required: false}');
         writeWorkspace(optionalModel);
         const code = await action('list', undefined);
         expect(code).toBe(0);
         const out = logs.join('\n');
         expect(out).toContain(
             'parameters: order (Order, reference), amount (Decimal), ' +
             'currency (String, default: "USD"), blank (String, default: ""), ' +
             'cleared (Boolean, default: null), literalNull (String, default: "null"), ' +
             'memo (String, optional)');
         expect(out).toContain(
            'run:        kcmd action run IssueCredit --judge ' +
            '--judge-reads-store --arg order=<Order> --arg amount=<Decimal>');
         expect(out).not.toContain('--arg currency=');
         expect(out).not.toContain('--arg memo=');
       });

  test(
      'shows an action the profile withdrew as declared but not runnable',
       async () => {
         // The listing answers "what can this model do HERE". Printing a run
         // line for a write this binding cannot perform would send the reader
         // to a refusal, so it prints the fix instead.
         writeWorkspace();
         const code = await action('list', undefined, {profile: 'readonly'});
         expect(code).toBe(0);
         const out = logs.join('\n');
         expect(out).toContain('IssueCredit');
         expect(out).toContain('executor:   (none under this profile');
         expect(out).toContain('bind an executor in a profile to run this');
         expect(out).not.toContain('kcmd action run IssueCredit');
       });

  test(
      'the run line names both judge flags when a guard is judged',
       async () => {
         // Copying the line is the whole point of printing it. A judged guard
         // refuses without a judge, so a line omitting the flag would send the
         // reader to a refusal it could have predicted. The same holds one step
         // on: a judgment comparing the call against a stored row is refused
         // without `--judge-reads-store`, and a constraint's wording does not
         // say which judgments those are, so the line offers the read wherever
         // the profile binds a table to read.
        writeWorkspace();
         const code = await action('list', undefined);
         expect(code).toBe(0);
         const out = logs.join('\n');
         expect(out).toContain(
             'run:        kcmd action run IssueCredit --judge ' +
             '--judge-reads-store --arg order=<Order>');
         // The other action names no guard at all, so it gains nothing.
         expect(out).toContain(
             'run:        kcmd action run NotifyCustomer --arg order=<Order>');
       });

  test('says so when a model declares no actions', async () => {
    writeWorkspace(NO_ACTIONS);
    const code = await action('list', undefined);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('declares no actions.');
  });

  test('reads the model under a named profile', async () => {
    writeWorkspace();
    const code = await action('list', undefined, {profile: 'analytical'});
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('profile \'analytical\'');
  });

  test(
      'names the profiles that exist when given one that does not',
       async () => {
         writeWorkspace();
         const code = await action('list', undefined, {profile: 'nope'});
         expect(code).toBe(1);
         const out = logs.join('\n');
        expect(out).toContain('unknown binding profile \'nope\'');
         expect(out).toContain('analytical');
       });

  test('rejects a subcommand that is neither list nor run', async () => {
    writeWorkspace();
    const code = await action('explain', 'IssueCredit');
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('expected \'list\' or \'run\'');
  });
});


describe('kcmd action run: what it will not send to a store', () => {
  test('needs an action name', async () => {
    writeWorkspace();
    const code = await action('run', undefined);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('needs an action name');
  });

  test(
      'names the declared actions when asked for one that is not there',
       async () => {
         writeWorkspace();
         const code = await action('run', 'IssueRefund');
         expect(code).toBe(1);
         const out = logs.join('\n');
        expect(out).toContain('declares an action \'IssueRefund\'');
         expect(out).toContain('declared: IssueCredit, NotifyCustomer.');
       });

  test('rejects an --arg that does not name a parameter', async () => {
    writeWorkspace();
    const code = await action(
        'run', 'IssueCredit', {arg: ['order=12345', 'amount']});
    expect(code).toBe(1);
    expect(logs.join('\n'))
        .toContain('--arg expects <name>=<value>, but got \'amount\'');
  });

  test('rejects the same parameter given twice', async () => {
    writeWorkspace();
    const code =
        await action('run', 'IssueCredit', {arg: ['amount=30', 'amount=40']});
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('--arg amount was given twice.');
  });

  test(
      'takes a single --arg, which cac hands over as a bare string',
       async () => {
         writeWorkspace();
         // Reaches the runtime rather than the argument parser: the refusal
         // below is about the guard, which is proof the parse succeeded.
         const code = await action('run', 'IssueCredit', {arg: 'amount=30'});
         expect(code).toBe(1);
        expect(logs.join('\n'))
            .toContain('this runtime was given no judge to ask');
       });

  test(
      'refuses an action whose executor runs outside the transaction',
       async () => {
         writeWorkspace();
         const code = await action('run', 'NotifyCustomer', {arg: 'order=1'});
         expect(code).toBe(1);
        expect(logs.join('\n'))
            .toContain('which runs outside this transaction');
       });

  test('refuses a guarded action when no judge was supplied', async () => {
         writeWorkspace();
    const code =
        await action('run', 'IssueCredit', {arg: ['order=12345', 'amount=30']});
         expect(code).toBe(1);
         const out = logs.join('\n');
    expect(out).toContain('is guarded by \'CreditIsPositive\'');
         // It got as far as choosing a database, so the refusal is the
         // runtime's and not a wiring failure earlier on.
         expect(out).toContain(
        'Running \'IssueCredit\' on projects/acme-ops/instances/prod/databases/commerce');
       });
});


describe('kcmd action run: an action this binding cannot perform', () => {
  test('refuses an action whose executor the profile withdrew', async () => {
    // Nothing is wrong with the action. The binding is what says no, so the
    // message has to send the reader to the profile rather than to the model.
    writeWorkspace();
    const code = await action(
        'run', 'IssueCredit',
        {profile: 'readonly', arg: ['order=1', 'amount=5']});
    expect(code).toBe(1);
    const out = logs.join('\n');
    expect(out).toContain('no executor under this binding');
    expect(out).toContain('profile');
  });
});


describe('kcmd action run: where the write would go', () => {
  test('refuses a profile that deploys to BigQuery', async () => {
    writeWorkspace();
    const code = await action(
        'run', 'IssueCredit',
        {profile: 'analytical', arg: ['order=12345', 'amount=30']});
    expect(code).toBe(1);
    const out = logs.join('\n');
    expect(out).toContain('deploys to the BigQuery dataset');
    // Named by what it lacks -- an operational store -- rather than by one
    // backend, because there is now more than one backend that would do.
    expect(out).toContain('statements run against an operational database');
    expect(out).toContain('Spanner or AlloyDB');
    // Refused before the run banner: a dataset is not somewhere a run lands.
    expect(out).not.toContain('Running');
  });

  test(
      'refuses a binding whose sources sit in a different database than ' +
           'its deployment target',
       async () => {
         writeWorkspace();
         const code = await action(
             'run', 'IssueCredit',
             {profile: 'mismatched', arg: ['order=12345', 'amount=30']});
         expect(code).toBe(1);
         const out = logs.join('\n');
         expect(out).toContain(
            'binds \'Order\' to //spanner.googleapis.com/projects/acme-ops/' +
             'instances/prod/databases/commerce/tables/Orders');
         expect(out).toContain(
             'deployment target is projects/acme-ops/instances/prod/databases/archive');
         expect(out).toContain('address a table by name alone');
       });

  test('refuses a binding that leaves its entities in another system', async () => {
         // The same hazard as a wrong database and a likelier one: the
         // statements name a table, so they would run against whatever
         // Spanner table shares the name while the data the model describes
         // sat in BigQuery, untouched and unmentioned.
         writeWorkspace();
         const code = await action(
             'run', 'IssueCredit',
             {profile: 'crossbound', arg: ['order=12345', 'amount=30']});
         expect(code).toBe(1);
         const out = logs.join('\n');
    expect(out).toContain('binds \'Order\' to acme-analytics.sales.orders');
         expect(out).toContain(
             'deployment target is projects/acme-ops/instances/prod/databases/commerce');
         expect(out).toContain('address a table by name alone');
       });
});


// A scope holds every document under the entry group, and `run` touches one of
// them. An error in a document this call will not read is a real error to fix,
// and refusing on it would report a model the reader did not name.
describe('kcmd action run: which model has to be valid', () => {
  function withWarehouse(): void {
    writeWorkspace();
    fs.writeFileSync(
        path.join(
            dir, 'catalog', 'EntryGroups', 'commerce_eg', 'warehouse.yaml'),
        WAREHOUSE);
  }

  test(
      'a broken document elsewhere in the scope does not block the run',
       async () => {
         withWarehouse();
         const code = await action(
             'run', 'IssueCredit', {arg: ['order=12345', 'amount=30']});
         // Still refused -- IssueCredit is guarded and nothing evaluates a
         // guard yet -- but refused on its OWN terms.
         expect(code).toBe(1);
         // The broken document is still WARNED about -- it is a real problem,
         // reported where it is. What must not happen is it becoming the
         // reason this call failed.
         const errors = logs.filter(l => l.startsWith('Error:')).join('\n');
        expect(errors).toContain('is guarded by \'CreditIsPositive\'');
         expect(errors).not.toContain('Pallet');
         expect(errors).not.toContain('warehouse');
       });

  test(
      'the broken document is still refused when it is the one being run',
       async () => {
         withWarehouse();
         const code = await action('run', 'Restock', {arg: ['bin=B1']});
         expect(code).toBe(1);
         const errors = logs.filter(l => l.startsWith('Error:')).join('\n');
         expect(errors).toContain('Pallet');
       });
});


// cac and mri hand back values a flag's name does not suggest, and the shell
// hands back names an object literal already has. Both look like a nuisance
// and both change which model runs, or whether the run happens at all.
describe('kcmd action: what the command line can actually contain', () => {
  test(
      'a bare --profile falls back to the default rather than looking up ' +
          'a profile called \'true\'',
       async () => {
         // cac yields `true` for `--profile` with no value. Reading it as a
         // name would fail the command with a profile the user never typed.
         writeWorkspace();
         const code = await action('list', undefined, {profile: true});
         expect(code).toBe(0);
        expect(logs.join('\n')).toContain('profile \'default\'');
       });

  test('--no-profile does not become a profile name either', async () => {
    // mri yields `false`, which `??` would pass straight through.
    writeWorkspace();
    const code = await action('list', undefined, {profile: false});
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('profile \'default\'');
  });

  test('a named profile still selects that profile', async () => {
    writeWorkspace();
    await action('list', undefined, {profile: 'analytical'});
    expect(logs.join('\n')).toContain('profile \'analytical\'');
  });

  test('an argument named after an Object member is an ordinary argument',
       async () => {
         // On a plain object `'toString' in args` is true before anything is
         // parsed, so this would report a duplicate the caller never gave.
         writeWorkspace();
         await action(
             'run', 'IssueCredit',
             {arg: ['toString=x', 'order=1', 'amount=5']});
         const out = logs.join('\n');
         expect(out).not.toContain('given twice');
         // It gets as far as the refusal, which is where this model stops.
         expect(out).toContain('CreditIsPositive');
       });

  test('a genuinely repeated argument is still reported', async () => {
    writeWorkspace();
    const code = await action(
        'run', 'IssueCredit', {arg: ['order=1', 'order=2', 'amount=5']});
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('--arg order was given twice');
  });
});


// `run` skips the deployment checks on purpose -- it deploys nothing -- but
// not the ones the runtime's refusal gate depends on.
describe('kcmd action run: --arg has to be a pair', () => {
  test('a bare value is reported rather than crashing the parse', async () => {
    // cac does not hand back a string for every `--arg`: it coerces a bare
    // numeric value, so `--arg amount 30` arrives here as the NUMBER 30. Left
    // as it came, `pair.indexOf` threw a TypeError past the parser and the
    // message written for exactly this typo was unreachable.
    writeWorkspace();
    expect(await action('run', 'IssueCredit', {arg: 30 as any})).toBe(1);
    expect(logs.join('\n')).toContain('--arg expects <name>=<value>');
  });
});


describe('kcmd action run: a subtype inherits its fields', () => {
  test('resolves a reference by an inherited identifying column', async () => {
    // Both push legs resolve inheritance and this path did not, so a subtype
    // arrived at the runtime with only the fields it declares itself.
    // Customer's identifying field is Party's `name`; without it the lookup
    // drops silently to key-only and reports a row missing that is there.
    writeWorkspace(INHERITS);
    const asked: string[] = [];
    const ok = (result: unknown) =>
        Promise.resolve({status: 200, result} as any);
    spyOn(SpannerDataClient.prototype, 'createSession')
        .mockImplementation(() => ok({name: 'sessions/1'}));
    spyOn(SpannerDataClient.prototype, 'deleteSession')
        .mockImplementation(() => ok({}));
    spyOn(SpannerDataClient.prototype, 'beginReadWrite')
        .mockImplementation(() => ok({id: 'txn-1'}));
    spyOn(SpannerDataClient.prototype, 'rollback')
        .mockImplementation(() => ok({}));
    spyOn(SpannerDataClient.prototype, 'executeSql')
        .mockImplementation((_s: any, _t: any, stmt: any) => {
          asked.push(stmt.sql);
          return ok({rows: []});
        });

    // No row comes back, so the run fails -- but it fails having asked the
    // right question, which is what is under test.
    expect(await action('run', 'Touch', {arg: 'who=Alice'})).toBe(1);
    expect(asked[0]).toContain('FullName = @ref');
  });
});


describe('kcmd action run: the model has to be valid to run', () => {
  const TYPO = MODEL.replace(
      '- {concept: Entry, operation: create}',
      '- {concept: Etnry, operation: create}');

  test(
      'an affects entry naming a concept the model does not declare is ' +
          'refused rather than run',
      async () => {
        // A push rejects this outright, and running the model is running the
        // same typo, so `action run` reports it by name rather than passing
        // over an entry that resolves to nothing.
        writeWorkspace(TYPO);
        const code =
            await action('run', 'IssueCredit', {arg: ['order=A1', 'amount=5']});
        expect(code).toBe(1);
        expect(logs.join('\n')).toContain('\'Etnry\'');
      });

  test('but listing it still works, because listing runs nothing', async () => {
    writeWorkspace(TYPO);
    expect(await action('list', undefined)).toBe(0);
  });
});
