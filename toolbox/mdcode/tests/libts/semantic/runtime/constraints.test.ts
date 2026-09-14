// Lowering a constraint to a probe.
//
// A probe is a SELECT that returns the rows breaking the rule, so an empty
// result means the rule holds. Two things are under test: the SQL a given
// expression turns into, and -- at least as important -- which expressions are
// refused. The lowering fails closed, so every refusal here is an action the
// runtime will decline to run rather than run unchecked, and each one has to
// say enough for whoever wrote the model to fix it.
//
// No store is involved. A probe is built from the model and the action alone,
// with the arguments left as parameters, which is what lets the same call
// answer both "may this action be offered at all" and "what shall I run".

import {describe, expect, test} from 'bun:test';

import {Action, Constraint, Entity, SemanticModel} from '../../../../src/libts/semantic/ir';
import {
  CheckPlan,
  checkStatement,
  ConstraintCheck,
  effectOf,
  GOOGLE_SQL,
  planGuard,
  planGuards,
  SqlDialect,
  strictestEffect,
  violating,
  violationFrom,
} from '../../../../src/libts/semantic/runtime/constraints';


const ORDER: Entity = {
  name: 'Order',
  dataSource: 'demo.commerce.Orders',
  keys: ['key'],
  fields: [
    {name: 'key', expression: 'OrderId'},
    {name: 'total', expression: 'Total'},
    {name: 'closedOn', expression: 'ClosedOn'},
    {name: 'status', expression: 'Status', type: 'String'},
    // Bound to an expression rather than to a column.
    {name: 'margin', expression: 'Price * Quantity'},
    // Bound to nothing: the profile in force gives it no column.
    {name: 'memo'},
  ],
};

const ENTRY: Entity = {
  name: 'Entry',
  dataSource: 'demo.commerce.LedgerEntry',
  keys: ['key'],
  fields: [
    {name: 'key', expression: 'EntryId'},
    {name: 'amount', expression: 'Amount'},
  ],
};

const LINE: Entity = {
  name: 'Line',
  dataSource: 'demo.commerce.OrderLine',
  keys: ['orderKey', 'lineNo'],
  fields: [
    {name: 'orderKey', expression: 'OrderId'},
    {name: 'lineNo', expression: 'LineNo'},
    {name: 'qty', expression: 'Qty'},
  ],
};

const PARTY: Entity = {
  name: 'Party',
  dataSource: '',
  keys: [],
  abstract: true,
  fields: [{name: 'name', expression: 'Name'}],
};

const ISSUE_CREDIT: Action = {
  name: 'IssueCredit',
  description: 'Credit an order.',
  executor: {
    kind: 'sql',
    sql: {
      statements: [
        'INSERT INTO LedgerEntry (EntryId, OrderId, Amount) ' +
            'VALUES (@newEntryKey, @order, @amount)',
      ],
    },
  },
  parameters: [
    {name: 'order', type: 'Order', isEntityRef: true},
    {name: 'amount', type: 'Decimal', isEntityRef: false},
  ],
};

// Two references to the SAME entity, which is the shape a transfer takes and
// the shape that catches a probe scoped to only one of them.
const MOVE_CREDIT: Action = {
  name: 'MoveCredit',
  description: 'Move a credit from one order to another.',
  executor: {
    kind: 'sql',
    sql: {statements: ['UPDATE Orders SET Total = Total WHERE OrderId = @from']},
  },
  parameters: [
    {name: 'from', type: 'Order', isEntityRef: true},
    {name: 'to', type: 'Order', isEntityRef: true},
    {name: 'amount', type: 'Decimal', isEntityRef: false},
  ],
};


function modelWith(over: Partial<SemanticModel> = {}): SemanticModel {
  return {
    name: 'commerce',
    entities: [ORDER, ENTRY, LINE, PARTY],
    relationships: [],
    metrics: [],
    actions: [ISSUE_CREDIT, MOVE_CREDIT],
    ...over,
  };
}

function lowerRule(
    constraint: Constraint, action: Action = ISSUE_CREDIT,
    model: SemanticModel = modelWith()): CheckPlan {
  return planGuard(model, action, constraint);
}

function lower(expression: string, action?: Action): CheckPlan {
  return lowerRule({name: 'Rule', expression}, action);
}

// The probe's query text is read often enough here to be worth flattening onto
// the check, so an assertion about the SQL reads as one.
function probeOf(lowered: CheckPlan): ConstraintCheck&{sql: string} {
  if (!lowered.ok) throw new Error(`expected a probe: ${lowered.reason}`);
  return {...lowered.check, sql: lowered.check.query.text};
}

function reasonOf(lowered: CheckPlan): string {
  if (lowered.ok) {
    throw new Error(`expected a refusal: ${lowered.check.query.text}`);
  }
  return lowered.reason;
}


describe('what the probe reads and when it runs', () => {
  test('every parameter of the entity is in scope, not just the first', () => {
    // The failure this guards against is silent: scoping to `from` alone
    // would probe one of the two rows the action writes and report the rule
    // as checked, which is the one outcome the lowering must never produce.
    const probe = probeOf(lower('Order.total >= 0', MOVE_CREDIT));
    expect(probe.sql).toContain('WHERE OrderId IN (@from, @to)');
    expect(probe.sql).not.toContain('OrderId = @from');
  });

  test('both references are bound to the probe', () => {
    const params = {from: 1, to: 2, amount: 5};
    const types = {
      from: {code: 'INT64'},
      to: {code: 'INT64'},
      amount: {code: 'NUMERIC'},
    };
    const statement = checkStatement(
        probeOf(lower('Order.total >= 0', MOVE_CREDIT)), params, types);
    expect(statement.params).toEqual({from: 1, to: 2});
  });

  test('one reference still reads as a plain equality', () => {
    expect(probeOf(lower('Order.total >= 0')).sql)
        .toContain('WHERE OrderId = @order');
  });

  test('a rule over stored state alone reads the table, after the write',
       () => {
         const probe = probeOf(lower('Order.total >= 0'));
         expect(probe.timing).toBe('after');
         expect(probe.entity).toBe('Order');
         expect(probe.sql).toBe(
             'SELECT OrderId FROM Orders WHERE OrderId = @order ' +
             'AND NOT COALESCE((Total >= 0), FALSE) LIMIT 5');
       });

  test('a rule over an argument alone reads no table, before the write', () => {
    // GoogleSQL needs a source for a SELECT with a WHERE and nothing to read,
    // and one row is all a question about the arguments takes.
    const probe = probeOf(lower('amount <= 25'));
    expect(probe.timing).toBe('before');
    expect(probe.entity).toBeUndefined();
    expect(probe.sql).toBe(
        'SELECT 1 AS violated FROM UNNEST([1]) ' +
        'WHERE NOT COALESCE((@amount <= 25), FALSE)');
  });

  test('a rule comparing an argument to stored state runs before the write',
       () => {
         // A parameter is not in the store, so no post-state check could ask
         // it. Asking before the write is also the only timing that can stop
         // the call without undoing anything.
         const probe = probeOf(lower('amount <= Order.total'));
         expect(probe.timing).toBe('before');
         expect(probe.sql).toContain('NOT COALESCE((@amount <= Total), FALSE)');
       });

  test('a rule needing both moments is refused rather than timed as one',
       () => {
         // One probe runs at one moment. Timing this by whether any comparison
         // reads a parameter would check `Order.total >= 0` against the
         // pre-state and never look again, so the write that drives the total
         // negative commits while the rule reports as checked.
         const reason = reasonOf(lower('Order.total >= 0 AND amount > 0'));
         expect(reason).toContain("about this call's arguments");
         expect(reason).toContain('about stored data');
         // The same holds for OR, which cannot be split into two probes at all.
         expect(reasonOf(lower('Order.total >= 0 OR amount > 0')))
             .toContain('about stored data');
       });

  test('the probe is scoped to the rows the call names', () => {
    // Without the scope this is a table scan holding read locks for the length
    // of the write, which is how a gate gets switched off.
    expect(probeOf(lower('Order.total >= 0')).sql)
        .toContain('WHERE OrderId = @order AND');
  });

  test('the probe returns the key columns, so a violation names its row', () => {
    expect(probeOf(lower('Order.total >= 0')).columns).toEqual(['OrderId']);
  });

  test('an unknown answer counts as a violation', () => {
    // SQL three-valued logic: `NULL >= 0` is unknown, and a plain NOT would
    // leave that row out of the violating set, passing a rule nothing verified.
    expect(probeOf(lower('Order.total >= 0')).sql).toContain('NOT COALESCE(');
  });
});


describe('the expressions the grammar accepts', () => {
  test('comparisons joined by AND keep their own parentheses', () => {
    expect(probeOf(lower('Order.total >= 0 AND Order.total <= 100000')).sql)
        .toContain('NOT COALESCE((Total >= 0) AND (Total <= 100000), FALSE)');
  });

  test('a literal containing AND or OR is one operand, not a join', () => {
    // The scan for AND/OR runs over the whole expression, so a rule whose
    // string happens to spell one of them used to come apart in the middle
    // of the quotes and be refused for a fault it does not have.
    expect(probeOf(lower("Order.status != 'held AND pending'")).sql)
        .toContain("NOT COALESCE((Status != 'held AND pending'), FALSE)");
    expect(probeOf(lower("Order.status != 'ON HOLD OR CLOSED'")).sql)
        .toContain("NOT COALESCE((Status != 'ON HOLD OR CLOSED'), FALSE)");
  });

  test('a literal spelling an operator the grammar bars is still a literal',
       () => {
         // The gates that refuse `==` and parentheses read the expression with
         // its literals blanked. Reading raw text refused these two for a fault
         // they do not have, which on a reject-class guard leaves the action
         // permanently unrunnable.
         expect(probeOf(lower("Order.status = 'a==b'")).sql)
             .toContain("NOT COALESCE((Status = 'a==b'), FALSE)");
         expect(probeOf(lower("Order.status = 'see (attached)'")).sql)
             .toContain("NOT COALESCE((Status = 'see (attached)'), FALSE)");
       });

  test('an operator inside a literal is not the comparison', () => {
    expect(probeOf(lower("'a>b' != Order.status")).sql)
        .toContain("NOT COALESCE(('a>b' != Status), FALSE)");
  });

  test('a joined rule whose literal also spells a joiner', () => {
    // Both scans have to agree about where the literal ends: the real AND
    // joins the two comparisons, the one inside the quotes does not.
    expect(probeOf(lower(
               "Order.status != 'held AND pending' AND Order.total >= 0"))
               .sql)
        .toContain(
            "(Status != 'held AND pending') AND (Total >= 0)");
  });

  test('OR is carried through as written', () => {
    expect(probeOf(lower("Order.status = 'open' OR Order.total >= 0")).sql)
        .toContain("(Status = 'open') OR (Total >= 0)");
  });

  test('an equality against NULL becomes a null test', () => {
    // GoogleSQL refuses `col = NULL` outright, so lowering it verbatim would
    // emit a probe that cannot run.
    expect(probeOf(lower('Order.closedOn = NULL')).sql)
        .toContain('(ClosedOn IS NULL)');
    expect(probeOf(lower('Order.closedOn != NULL')).sql)
        .toContain('(ClosedOn IS NOT NULL)');
  });

  test('<> reads as !=', () => {
    expect(probeOf(lower("Order.status <> 'void'")).sql)
        .toContain("(Status != 'void')");
  });

  test('>= is not read as > with a stray = after it', () => {
    expect(probeOf(lower('Order.total >= 0')).sql).toContain('(Total >= 0)');
  });
});


describe('the expressions it refuses, and what it says about them', () => {
  test('a rule settled by judgment', () => {
    // Nothing here calls a judge, and running the action anyway would run
    // unjudged an action whose model says it is judged.
    const reason = reasonOf(lowerRule({
      name: 'LargeCreditIsJustified',
      judgment: 'The request must name a specific service failure.',
      onViolation: 'escalate',
    }));
    expect(reason).toContain("constraint 'LargeCreditIsJustified' cannot be checked");
    expect(reason).toContain('runs no judge');
  });

  test('an expression that is not there', () => {
    expect(reasonOf(lower(''))).toContain('declares no expression');
  });

  test("'==' for equality", () => {
    expect(reasonOf(lower('Order.total == 0'))).toContain("a single '='");
  });

  test('parentheses and function calls', () => {
    expect(reasonOf(lower('Order.total >= ABS(0)')))
        .toContain('parentheses or a function call');
  });

  test('an aggregate, which is a function call and needs a decision beyond it',
       () => {
         // How an aggregate is evaluated inside a row-level probe is a real
         // question with more than one answer, so it is named rather than
         // guessed at.
         expect(reasonOf(lower('Order.total = SUM(Entry.amount)')))
             .toContain('parentheses or a function call');
       });

  test('an ordering comparison against NULL', () => {
    expect(reasonOf(lower('Order.closedOn > NULL'))).toContain('no meaning');
  });

  test('a segment that is not a comparison at all', () => {
    expect(reasonOf(lower('Order.total'))).toContain('is not a comparison');
  });

  test('a bare name that is not a parameter of this action', () => {
    // The likely mistake is a field written without its entity, so the message
    // says how a field is written.
    const reason = reasonOf(lower('total >= 0'));
    expect(reason).toContain("'total' is not a parameter of this action");
    expect(reason).toContain('<Entity>.<field>');
  });

  test('a rule spanning two entities, with both named', () => {
    const reason = reasonOf(lower('Order.total >= Entry.amount'));
    expect(reason).toContain('it spans Entry and Order');
    expect(reason).toContain("one constraint per entity");
  });

  test('a field the entity does not declare', () => {
    expect(reasonOf(lower('Order.shipped >= 0')))
        .toContain("Order declares no field 'shipped'");
  });

  test('a field the profile in force bound to nothing', () => {
    // Unbound is structurally absent, not null: there is no column to read the
    // rule against, so the rule cannot be checked here.
    expect(reasonOf(lower("Order.memo != ''")))
        .toContain('Order.memo is unbound under this profile');
  });

  test('a field bound to an expression rather than to a column', () => {
    expect(reasonOf(lower('Order.margin >= 0')))
        .toContain('bound to an expression (Price * Quantity)');
  });

  test('an entity with no table to read', () => {
    expect(reasonOf(lower("Party.name != ''")))
        .toContain("'Party' is abstract");
  });

  test('an entity of no model', () => {
    expect(reasonOf(lower('Customer.tier >= 0')))
        .toContain("'Customer' is not an entity of this model");
  });

  test('an entity the action takes no reference to', () => {
    // Widening the probe to every row is the alternative, and a gate whose
    // cost grows with the table is one that gets switched off.
    const reason = reasonOf(lower('Entry.amount > 0'));
    expect(reason).toContain("action 'IssueCredit' takes no Entry parameter");
    expect(reason).toContain('the rows this call touches');
  });

  test('an entity whose key has more than one part', () => {
    const adjust: Action = {
      ...ISSUE_CREDIT,
      name: 'AdjustLine',
      parameters: [{name: 'line', type: 'Line', isEntityRef: true}],
    };
    expect(reasonOf(lower('Line.qty > 0', adjust)))
        .toContain('Line has a 2-part key');
  });

});


describe('lowering the guards of one action', () => {
  const positive: Constraint = {name: 'Positive', expression: 'amount > 0'};
  const judged: Constraint = {
    name: 'Justified',
    judgment: 'The request must name a specific service failure.',
    onViolation: 'reject',
  };

  const guardedBy = (constraints: Constraint[], guards: string[]) =>
      planGuards(
          modelWith({constraints}), {...ISSUE_CREDIT, guards});

  test('a guard naming a constraint the model does not declare is an error',
       () => {
         // Not something to guess about, and not classifiable as advisory:
         // there is no declaration to read an `on_violation` from.
         const {errors} = guardedBy([positive], ['NoSuchRule']);
         expect(errors.join(' ')).toContain("guarded by 'NoSuchRule'");
       });

  test('a guard it cannot check stops the action', () => {
    const {checks, errors} = guardedBy([judged], ['Justified']);
    expect(checks).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test('an advisory rule it cannot check is reported, not turned into a stop',
       () => {
         // `warn` reports and lets the write through, so being unable to
         // evaluate it costs a report and stops nothing. Refusing over it
         // would make the advice the one thing that blocks the action.
         const advisory: Constraint = {...judged, onViolation: 'warn'};
         const {errors, unchecked} = guardedBy([advisory], ['Justified']);
         expect(errors).toEqual([]);
         expect(unchecked.map(u => u.constraint)).toEqual(['Justified']);
         expect(unchecked[0].reason).toContain('runs no judge');
       });

  test('the checkable guards are still lowered alongside the rest', () => {
    const {checks, errors} =
        guardedBy([positive, judged], ['Positive', 'Justified']);
    expect(checks.map(c => c.constraint.name)).toEqual(['Positive']);
    expect(errors).toHaveLength(1);
  });

  test('an action naming no guard produces nothing to run', () => {
    const {checks, errors, unchecked} = guardedBy([positive], []);
    expect(checks).toEqual([]);
    expect(errors).toEqual([]);
    expect(unchecked).toEqual([]);
  });
});


describe('binding a probe to the call', () => {
  const params = {order: '12345', amount: 30, other: 'x'};
  const types = {
    order: {code: 'STRING'},
    amount: {code: 'NUMERIC'},
    other: {code: 'STRING'},
  };

  test('carries only the parameters its SQL names', () => {
    // An action's parameter list is wider than any one rule, and a statement
    // carrying a parameter it never reads is one the store may refuse.
    const statement =
        checkStatement(probeOf(lower('amount <= 25')), params, types);
    expect(statement.params).toEqual({amount: 30});
    expect(statement.paramTypes).toEqual({amount: {code: 'NUMERIC'}});
  });

  test('carries the scope parameter too, when the probe reads a table', () => {
    const statement =
        checkStatement(probeOf(lower('Order.total >= 0')), params, types);
    expect(statement.params).toEqual({order: '12345'});
  });

  test('a probe naming no parameter carries none at all', () => {
    const statement = checkStatement(
        {
          constraint: {name: 'Rule', expression: 'TRUE = TRUE'},
          timing: 'before',
          query: {
            text: 'SELECT 1 AS violated FROM UNNEST([1]) WHERE FALSE',
            parameters: [],
          },
          columns: ['violated'],
        },
        params, types);
    expect(statement.params).toBeUndefined();
  });
});


describe('what the dialect decides, and what it does not', () => {
  // A second dialect, standing in for one that reads the pushed property graph
  // rather than the table: the same column of the same table, reached through
  // a pattern variable instead of named bare.
  const THROUGH_A_VARIABLE: SqlDialect = {
    name: 'test',
    columnRef: (column) => `o.${column}`,
    parameterRef: (name) => `@${name}`,
    entityProbe: ({table, keys, scope, predicate, limit}) =>
        `MATCH (o:${table}) WHERE ${scope} AND ${violating(predicate)} ` +
        `RETURN ${keys.map(k => `o.${k}`).join(', ')} LIMIT ${limit}`,
    argumentProbe: (predicate) =>
        `RETURN 1 AS violated WHERE ${violating(predicate)}`,
  };

  const inDialect = (expression: string, dialect: SqlDialect) => planGuard(
      modelWith(), ISSUE_CREDIT, {name: 'Rule', expression}, dialect);

  test('the same rule is written differently and resolved the same', () => {
    // Binding is what the two share: both read column Total of table Orders,
    // and only the way the reference is written down differs.
    expect(probeOf(inDialect('Order.total >= 0', GOOGLE_SQL)).sql)
        .toBe(
            'SELECT OrderId FROM Orders WHERE OrderId = @order AND ' +
            'NOT COALESCE((Total >= 0), FALSE) LIMIT 5');
    expect(probeOf(inDialect('Order.total >= 0', THROUGH_A_VARIABLE)).sql)
        .toBe(
            'MATCH (o:Orders) WHERE o.OrderId = @order AND ' +
            'NOT COALESCE((o.Total >= 0), FALSE) RETURN o.OrderId LIMIT 5');
  });

  test('everything but the writing is settled before a dialect is asked', () => {
    // The grammar, the entity a rule reads and the moment it runs are decided
    // in the analysis, so a dialect can neither widen what the runtime agrees
    // to check nor move when it checks it.
    for (const dialect of [GOOGLE_SQL, THROUGH_A_VARIABLE]) {
      expect(reasonOf(inDialect('SUM(Order.total) > 0', dialect)))
          .toContain('parentheses or a function call');
      expect(reasonOf(inDialect('Order.total >= 0 AND amount > 0', dialect)))
          .toContain('about stored data');
      expect(probeOf(inDialect('Order.total >= 0', dialect)).timing)
          .toBe('after');
      expect(probeOf(inDialect('amount <= Order.total', dialect)).timing)
          .toBe('before');
    }
  });

  test('a check reports the parameters it wrote, whatever it wrote them as',
       () => {
         // The emitter names them rather than the caller scanning the text
         // back out of it, so a dialect with another sigil binds correctly
         // without anyone teaching the binder about it.
         const check = probeOf(inDialect('amount <= Order.total', GOOGLE_SQL));
         expect([...check.query.parameters].sort()).toEqual([
           'amount', 'order'
         ]);
       });
});


describe('reporting a violation', () => {
  test("the author's own words lead, and the citation follows", () => {
    // The description is written as the instruction to the caller who was
    // refused; the name and expression are what lets someone look the rule up.
    const probe = probeOf(lowerRule({
      name: 'NonNegativeTotal',
      expression: 'Order.total >= 0',
      description: 'An order total never goes negative.',
    }));
    const violation = violationFrom(probe, [['12345']]);
    expect(violation.message)
        .toBe(
            'An order total never goes negative. ' +
            "Stopped by 'NonNegativeTotal' (Order.total >= 0). " +
            'Violating Order: 12345.');
    expect(violation.constraint).toBe('NonNegativeTotal');
    expect(violation.instances).toEqual(['12345']);
  });

  test('a rule with no description still says which rule it was', () => {
    const violation = violationFrom(probeOf(lower('Order.total >= 0')), [['7']]);
    expect(violation.message).toContain("Constraint 'Rule' does not hold.");
  });

  test('a rule over the arguments alone names no row', () => {
    // Its probe returns one row that identifies nothing, and "Violating: 1"
    // would read as a row key.
    const violation = violationFrom(probeOf(lower('amount <= 25')), [['1']]);
    expect(violation.instances).toEqual([]);
    expect(violation.message).not.toContain('Violating');
  });

  test('several violating rows are all named', () => {
    const violation =
        violationFrom(probeOf(lower('Order.total >= 0')), [['1'], ['2']]);
    expect(violation.message).toContain('Violating Order: 1, 2.');
  });
});


describe('what a violation does to the write', () => {
  test('an expression that does not say rejects', () => {
    // The safe reading of an author who did not say.
    expect(effectOf({name: 'Rule', expression: 'amount > 0'})).toBe('reject');
  });

  test('an effect the author did state is used as written', () => {
    expect(effectOf({
      name: 'Rule',
      expression: 'amount > 0',
      onViolation: 'escalate',
    })).toBe('escalate');
  });

  test('the strictest effect among several is the answer', () => {
    // Being told a supervisor could approve a write another rule forbids
    // outright sends the caller to ask for something nobody can give.
    const violation = (effect: 'reject'|'escalate'|'warn') =>
        ({constraint: effect, effect, message: '', instances: []});
    expect(strictestEffect([violation('warn'), violation('escalate')]))
        .toBe('escalate');
    expect(strictestEffect([violation('escalate'), violation('reject')]))
        .toBe('reject');
    expect(strictestEffect([violation('warn')])).toBe('warn');
  });

  test('nothing violated is no answer at all', () => {
    expect(strictestEffect([])).toBeNull();
  });
});
