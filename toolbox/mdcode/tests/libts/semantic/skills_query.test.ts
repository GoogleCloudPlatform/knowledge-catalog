// Behavior specification for the read side of a generated Agent Skill
// (`kcmd skills-generate --mode query|both`).
//
// The claims under test:
//
//   - Shape. SKILL.md is an index -- coordinates, a short guide, one line per
//     graph label and per metric -- and the detail is in references/, one page
//     per label plus metrics.md and patterns.md.
//   - Fidelity to the graph. Labels, edges and MEASUREs are what the BigQuery
//     generator would build: an abstract parent is a label, a defined entity is
//     an `is<Name>` flag on its parent and not a label, a metric that is not a
//     single aggregate is not promised as a MEASURE.
//   - Generated patterns name only labels and edges the graph has.
//   - Budgets and determinism, as for the act router.
//   - The act mode is untouched: it is still the default.
//
// Nothing here opens a database.

import {describe, expect, test} from 'bun:test';
import * as yaml from 'yaml';

import {Entity, Field, SemanticModel} from '../../../src/libts/semantic/ir';
import {resolveInheritance} from '../../../src/libts/semantic/resolve_inheritance';
import {SemanticRuntime} from '../../../src/libts/semantic/runtime/runtime';
import {generateSkill} from '../../../src/libts/semantic/skills';
import {graphLabels, NAVIGATION_GUIDE} from '../../../src/libts/semantic/skills_query';

function target(graph: string): {vendorName: string; data: string} {
  return {
    vendorName: 'GOOGLE',
    data: JSON.stringify({
      deploymentTargets:
          [`//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/${graph}`],
    }),
  };
}

function f(name: string, expression: string, extra: Partial<Field> = {}): Field {
  return {name, expression, type: 'String', ...extra};
}

// An abstract parent with two subtypes, a to-one edge with an inverse, an
// M:N edge, a transitive self-edge, a defined subset, a metric that lowers
// to a MEASURE and one that does not, a constraint, and an action.
function fixture(): SemanticModel {
  return {
    name: 'sales',
    description: 'Sales test model. Amounts are USD thousands.',
    entities: [
      {
        name: 'Party',
        abstract: true,
        dataSource: '',
        keys: [],
        description: 'Anyone we trade with.',
        fields: [{name: 'partyName', type: 'String'}],
      },
      {
        name: 'Customer',
        extends: ['Party'],
        dataSource: 'p.d.customer',
        keys: ['customerId'],
        description: 'A party that buys.',
        aiContext: {synonyms: ['Client']},
        fields: [
          f('customerId', 'customer_id'), f('partyName', 'customer_name'),
          f('tier', 'tier'),
        ],
      },
      {
        name: 'Supplier',
        extends: ['Party'],
        dataSource: 'p.d.supplier',
        keys: ['supplierId'],
        description: 'A party that sells to us.',
        fields: [f('supplierId', 'supplier_id'), f('partyName', 'supplier_name')],
      },
      {
        name: 'Order',
        dataSource: 'p.d.orders',
        keys: ['orderId'],
        description: 'A customer order.',
        fields: [
          f('orderId', 'order_id'),
          f('customerId', 'customer_id'),
          // `unit` is not in the IR yet; the page renders unknown field
          // metadata generically, so it must show up.
          {...f('amount', 'amount_k', {type: 'Decimal', description: 'Order value.'}),
           unit: 'USD thousands'} as Field,
          f('status', 'status'),
        ],
      },
      {
        name: 'BigOrder',
        extends: ['Order'],
        dataSource: '',
        keys: [],
        fields: [],
        description: 'A large order.',
        definition: {expression: 'amount >= 1000', description: 'At least USD 1M.'},
      },
      {
        name: 'Product',
        dataSource: 'p.d.product',
        keys: ['productId'],
        description: 'Something we sell.',
        fields: [
          f('productId', 'product_id'), f('productName', 'product_name'),
          f('parentProductId', 'parent_id'), f('supplierId', 'supplier_id'),
        ],
      },
    ],
    relationships: [
      {
        name: 'placedBy',
        source: {entity: 'Order', columns: ['customerId']},
        destination: {entity: 'Customer', columns: ['customerId']},
        inverse: 'placed',
        aiContext: {instructions: 'The customer who placed the order.'},
      },
      {
        name: 'contains',
        source: {entity: 'Order', columns: []},
        destination: {entity: 'Product', columns: []},
        association: {
          dataSource: 'p.d.order_line',
          keys: ['line_id'],
          sourceColumns: ['order_id'],
          destinationColumns: ['product_id'],
        },
      },
      {
        name: 'partOf',
        source: {entity: 'Product', columns: ['parentProductId']},
        destination: {entity: 'Product', columns: ['productId']},
        aiContext: {
          instructions: 'partOf is transitive: only direct edges are stored; ' +
              'follow it with a quantified path.',
        },
      },
      {
        name: 'suppliedBy',
        source: {entity: 'Product', columns: ['supplierId']},
        destination: {entity: 'Supplier', columns: ['supplierId']},
      },
    ],
    metrics: [
      {
        name: 'total_amount',
        expression: 'SUM(Order.amount)',
        entity: 'Order',
        description: 'Total order value, USD thousands.',
      },
      {
        name: 'paid_ratio',
        expression:
            "SAFE_DIVIDE(COUNTIF(Order.status = 'paid'), COUNT(Order.orderId))",
        entity: 'Order',
        description: 'Share of orders that are paid.',
      },
    ],
    constraints: [{
      name: 'Order_placedBy_exactly_1',
      judgment: 'Each Order has exactly one placedBy relationship to a Customer.',
      description: 'Link each Order to one Customer.',
      onViolation: 'warn',
      severity: 'medium',
    }],
    actions: [{
      name: 'CancelOrder',
      description: 'Cancels an order.',
      parameters: [{name: 'orderId', type: 'String', required: true}],
      executor: {
        kind: 'sql',
        sql: {statements: ["UPDATE orders SET status = 'cancelled' WHERE order_id = @orderId"]},
      },
      guards: [],
    }],
    customExtensions: [target('g')],
  };
}

function rt(model: SemanticModel): SemanticRuntime {
  return {
    model: resolveInheritance(model).model,
    document: 'sales',
    store: {kind: 'bigquery', name: 'projects/p/datasets/d', project: 'p', dataset: 'd'},
    profile: 'bigquery',
    entryGroup: 'sales_eg',
  };
}

function generate(
    model: SemanticModel, mode: 'act'|'query'|'both' = 'query',
    extraModels: SemanticModel[] = [], metricGraphs?: boolean) {
  const out = generateSkill(
      {runtime: rt(model), mode, query: {extraModels, location: 'US', metricGraphs}});
  if ('error' in out) throw new Error(out.error);
  return {...out, files: Object.fromEntries(out.files.map(x => [x.path, x.text]))};
}

function frontmatter(document: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(document);
  expect(match).not.toBeNull();
  return yaml.parse(match![1]) as Record<string, unknown>;
}

function body(document: string): string {
  return document.replace(/^---\n[\s\S]*?\n---\n/, '');
}

function words(lines: readonly string[]): number {
  return lines.join(' ').split(/\s+/).filter(w => w).length;
}


describe('query mode: structure', () => {
  const {files, name} = generate(fixture());

  test('writes SKILL.md, one page per graph label, metrics and patterns', () => {
    expect(name).toBe('sales');
    expect(Object.keys(files).sort()).toEqual([
      'SKILL.md',
      'references/entities/Customer.md',
      'references/entities/Order.md',
      'references/entities/Party.md',
      'references/entities/Product.md',
      'references/entities/Supplier.md',
      'references/metrics.md',
      'references/patterns.md',
    ]);
  });

  test('frontmatter names the skill and routes reads to it', () => {
    const fm = frontmatter(files['SKILL.md']);
    expect(fm.name).toBe('sales');
    const description = String(fm.description);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toContain('reads or analyses');
    expect(description).toContain('p.d.g');
    expect(description).toContain('Order');
  });

  test('the body gives the coordinates', () => {
    const b = body(files['SKILL.md']);
    expect(b).toContain('Property graph: `p.d.g`');
    expect(b).toContain('Semantic dataset: `p.d`');
    expect(b).toContain('Location: `US`');
    expect(b).toContain('`sales_eg`');
  });

  test('the navigation guide is short and model-agnostic', () => {
    expect(words(NAVIGATION_GUIDE)).toBeLessThanOrEqual(300);
    const guide = NAVIGATION_GUIDE.join('\n');
    expect(guide).not.toContain('sales');
    expect(guide).toContain('preferred source, not the boundary');
    expect(guide).toContain('Read the question literally');
    expect(guide).toContain('one final answer');
    expect(guide).toContain('never rescale');
    expect(body(files['SKILL.md'])).toContain(guide.trim());
    expect(body(files['SKILL.md'])).toContain('## GQL in BigQuery');
  });

  test('the index ranks labels by relationships and lists subsets under the parent', () => {
    const b = body(files['SKILL.md']);
    const rows = b.split('\n').filter(l => l.startsWith('| ['));
    expect(rows.map(r => /\| \[(\w+)\]/.exec(r)![1])).toEqual(
        ['Product', 'Order', 'Customer', 'Supplier', 'Party']);
    expect(rows.find(r => r.includes('[Party]'))).toContain('abstract (2 subtypes)');
    expect(rows.find(r => r.includes('[Order]'))).toContain('`isBigOrder`');
    // A defined entity is not a label, so it has no row and no page.
    expect(rows.some(r => r.includes('[BigOrder]'))).toBe(false);
    expect(b).toMatch(/\| `total_amount` \| .* \| `Order` in `g__order_metrics` \|/);
    // A composite (a COUNTIF over a count) is read on the metric graph too.
    expect(b).toMatch(/\| `paid_ratio` \| .* \| `Order` in `g__order_metrics` \|/);
  });

  test('the coordinates list the metric graphs next to the main graph', () => {
    const b = body(files['SKILL.md']);
    expect(b).toContain('- Metric graphs for `GRAPH_EXPAND`, one per fact entity');
    expect(b).toContain('  - `p.d.g__order_metrics`: root `Order`, node tables `Order`, `Customer`.');
  });
});


describe('query mode: entity pages', () => {
  const {files} = generate(fixture());
  const order = files['references/entities/Order.md'];

  test('properties carry type, physical column and generic metadata', () => {
    expect(order).toContain('| `amount` | Decimal | `amount_k` |');
    expect(order).toContain('Unit: USD thousands.');
    expect(order).toContain('Source table: `p.d.orders`');
  });

  test('relationships render with cardinality, inverse and join', () => {
    expect(order).toContain('`(Order)-[:placedBy]->(Customer)` -- N:1');
    expect(order).toContain('inverse `(Customer)-[:placed]->(Order)`');
    expect(order).toContain('SQL join Order.customer_id = Customer.customer_id');
    expect(order).toContain('`(Order)-[:contains]->(Product)` -- M:N');
    expect(order).toContain('The customer who placed the order.');
  });

  test('defined subsets, metrics and constraints are on the parent page', () => {
    expect(order).toContain('## Defined subsets');
    expect(order).toContain('`isBigOrder` (BigOrder) -- `amount >= 1000`');
    expect(order).toContain('`total_amount`');
    expect(order).toContain('**Order_placedBy_exactly_1** (on violation: warn, severity: medium)');
  });

  test('relationship ai_context (transitivity hints) is rendered', () => {
    expect(files['references/entities/Product.md']).toContain('partOf is transitive');
  });

  test('an abstract label page names the tables that carry it', () => {
    const party = files['references/entities/Party.md'];
    expect(party).toContain('Abstract label `Party`');
    expect(party).toContain('`p.d.customer`');
    expect(party).toContain('`p.d.supplier`');
    expect(files['references/entities/Customer.md'])
        .toContain('Labels it carries: `Customer`, `Party`');
  });
});


describe('query mode: metrics', () => {
  const {files} = generate(fixture());
  const metrics = files['references/metrics.md'];
  const section = (page: string, name: string) =>
      page.split(`## ${name}\n`)[1].split('\n## ')[0];

  test('a MEASURE gets a GRAPH_EXPAND query on its fact\'s metric graph', () => {
    const s = section(metrics, 'total_amount');
    expect(s).toContain('- Graph: `p.d.g__order_metrics`, the metric graph for `Order` ' +
        '(2 node tables: `Order`, `Customer`)');
    expect(s).toContain('- MEASURE in: `p.d.g` (on `Order`), `p.d.g__order_metrics` (on `Order`)');
    expect(s).toContain([
      '```sql',
      'SELECT Customer_partyName AS partyName,',
      '       AGG(Order_total_amount) AS total_amount',
      'FROM GRAPH_EXPAND("p.d.g__order_metrics")',
      'GROUP BY partyName',
      'ORDER BY total_amount DESC',
      '```',
    ].join('\n'));
    expect(metrics).not.toContain('GRAPH_EXPAND("p.d.g")');
  });

  test('a composite metric is its single-aggregate MEASUREs and a SAFE_DIVIDE', () => {
    expect(section(metrics, 'paid_ratio')).toBe([
      '',
      'Share of orders that are paid.',
      '',
      '- Expression: `SAFE_DIVIDE(COUNTIF(Order.status = \'paid\'), COUNT(Order.orderId))`',
      '- Anchor: `Order`',
      '- Graph: `p.d.g__order_metrics`, the metric graph for `Order` (2 node tables: `Order`, `Customer`)',
      '- MEASUREs: `Order_paid_ratio__agg1` = `SUM(CASE WHEN Order.status = \'paid\' THEN 1 ELSE 0 END)` ' +
          '(`COUNTIF(Order.status = \'paid\')` as a CASE); `Order_paid_ratio__agg2` = `COUNT(Order.orderId)`',
      '- Composition: `SAFE_DIVIDE(AGG(Order_paid_ratio__agg1), AGG(Order_paid_ratio__agg2))`',
      '',
      '```sql',
      'SELECT Customer_partyName AS partyName,',
      '       SAFE_DIVIDE(AGG(Order_paid_ratio__agg1), AGG(Order_paid_ratio__agg2)) AS paid_ratio',
      'FROM GRAPH_EXPAND("p.d.g__order_metrics")',
      'GROUP BY partyName',
      'ORDER BY paid_ratio DESC',
      '```',
      '',
    ].join('\n'));
    expect(metrics).toContain('select its composition as given, e.g. `SAFE_DIVIDE(AGG(n), AGG(d))`');
  });

  // A ratio with a multiplier whose condition is a defined entity's
  // membership; a metric reading two entities inside one aggregate (a view);
  // one whose entities share no many-to-one root -- Order and Product are
  // linked only many-to-many -- (SQL only).
  function variant(): SemanticModel {
    const m = fixture();
    m.metrics.push(
        {
          name: 'big_share',
          expression: '100 * COUNTIF(Order.amount >= 1000) / COUNT(Order.orderId)',
          entity: 'Order',
        },
        {name: 'gold_amount', expression: "SUM(IF(Customer.tier = 'gold', Order.amount, 0))"},
        {name: 'cross_ratio', expression: 'SUM(Order.amount) / COUNT(Product.productId)'});
    return m;
  }
  const page = generate(variant()).files['references/metrics.md'];

  test('a COUNTIF of a defined entity sums its membership property, keeping the multiplier', () => {
    const s = section(page, 'big_share');
    expect(s).toContain('`Order_big_share__agg1` = `SUM(CAST(Order.isBigOrder AS INT64))` ' +
        '(`COUNTIF(Order.amount >= 1000)` as the membership property `isBigOrder`)');
    expect(s).toContain(
        '       100 * SAFE_DIVIDE(AGG(Order_big_share__agg1), AGG(Order_big_share__agg2)) AS big_share');
  });

  test('a metric no graph can hold is read on the fallback view', () => {
    const s = section(page, 'gold_amount');
    expect(s).toContain('Not a graph MEASURE (SUM(IF(Customer.tier = \'gold\', Order.amount, 0)) ' +
        'reads several entities (Customer, Order); a MEASURE reads one table). Read it on the ' +
        'generated view `p.d.g__order_metrics_view`, one row per `Order` record:');
    expect(s).toContain([
      'SELECT Customer_partyName AS partyName,',
      '       SUM(IF(Customer_tier = \'gold\', Order_amount, 0)) AS gold_amount',
      'FROM `p.d.g__order_metrics_view`',
    ].join('\n'));
    expect(page).toContain('A metric no graph can hold is read from a generated view');
  });

  test('a metric with no many-to-one root gets SQL over the source tables', () => {
    const s = section(page, 'cross_ratio');
    expect(s).toContain('Not a graph MEASURE (its aggregates read Order, Product, and no one ' +
        'of them reaches the others through many-to-one relationships). Compute it in SQL:');
    expect(s).toContain('FROM `p.d.orders` AS Order');
    expect(s).not.toContain('GRAPH_EXPAND(');
  });

  test('--no-metric-graphs reads the main graph\'s own MEASUREs, as before', () => {
    const off = generate(fixture(), 'query', [], false).files;
    const page = off['references/metrics.md'];
    expect(page).toContain('FROM GRAPH_EXPAND("p.d.g")');
    expect(page).not.toContain('__order_metrics');
    const s = section(page, 'paid_ratio');
    expect(s).toContain('Not a graph MEASURE');
    expect(s).toContain('FROM `p.d.orders` AS Order');
    expect(s).toContain("COUNTIF(Order.status = 'paid')");
    expect(s).not.toContain('GRAPH_EXPAND("');
    expect(body(off['SKILL.md'])).toMatch(/\| `paid_ratio` \| .* \| SQL \|/);
    expect(body(off['SKILL.md'])).not.toContain('Metric graphs');
  });
});


describe('query mode: generated patterns', () => {
  const {files} = generate(fixture());
  const patterns = files['references/patterns.md'];

  test('between 6 and 10 patterns covering the required shapes', () => {
    const count = patterns.split('\n').filter(l => l.startsWith('## ')).length;
    expect(count).toBeGreaterThanOrEqual(6);
    expect(count).toBeLessThanOrEqual(10);
    expect(patterns).toContain('MATCH (n:Party)');
    expect(patterns).toContain('-[:partOf]->{1,5}');
    expect(patterns).toContain('GROUP BY');
    expect(patterns).toContain('GRAPH_EXPAND("p.d.g__order_metrics")');
    expect(patterns).toContain('## Composite metric: paid_ratio');
    expect(patterns).toContain(
        'SAFE_DIVIDE(AGG(Order_paid_ratio__agg1), AGG(Order_paid_ratio__agg2)) AS paid_ratio');
    expect(patterns).toContain('FROM GRAPH_TABLE(');
    expect(patterns).toMatch(/MATCH \(a:\w+\)-\[:\w+\]->\(b:\w+\)-\[:\w+\]->\(c:\w+\)/);
  });

  test('every label and edge a pattern names exists in the graph', () => {
    const {nodeLabels, edgeLabels} = graphLabels(rt(fixture()).model);
    const matchLines = patterns.split('\n').filter(l => /MATCH /.test(l));
    expect(matchLines.length).toBeGreaterThan(0);
    for (const line of matchLines) {
      for (const m of line.matchAll(/\(\w*:([A-Za-z_][\w]*)\)/g)) {
        expect(nodeLabels).toContain(m[1]);
      }
      for (const m of line.matchAll(/\[\w*:([A-Za-z_][\w]*)\]/g)) {
        expect(edgeLabels).toContain(m[1]);
      }
    }
    expect(nodeLabels).not.toContain('BigOrder');
  });
});


describe('query mode: budgets and determinism', () => {
  test('the fixture stays well inside the body budget', () => {
    const {files, warnings} = generate(fixture());
    const b = body(files['SKILL.md']);
    expect(b.split('\n').length).toBeLessThanOrEqual(500);
    expect(Math.ceil(b.length / 4)).toBeLessThanOrEqual(5000);
    expect(warnings.some(w => w.includes('SKILL.md body'))).toBe(false);
  });

  test('a model too large for the body is warned about', () => {
    const big = fixture();
    for (let i = 0; i < 600; i++) {
      big.entities.push({
        name: `Thing${String(i).padStart(3, '0')}`,
        dataSource: `p.d.thing_${i}`,
        keys: ['id'],
        description: 'A filler entity with a description long enough to fill a row.',
        fields: [f('id', 'id')],
      });
    }
    const {warnings} = generate(big);
    expect(warnings.some(w => w.includes('SKILL.md body is') && w.includes('lines'))).toBe(true);
  });

  test('output is byte-identical across runs and declaration order', () => {
    const a = generate(fixture());
    const b = generate(fixture());
    expect(b.files).toEqual(a.files);
    const shuffled = fixture();
    shuffled.entities = [...shuffled.entities].reverse();
    shuffled.relationships = [...shuffled.relationships].reverse();
    shuffled.metrics = [...shuffled.metrics].reverse();
    expect(generate(shuffled).files).toEqual(a.files);
  });
});


describe('extra graphs', () => {
  // A metrics slice: the same Order, compiled into its own small graph.
  function slice(): SemanticModel {
    const m = fixture();
    return {
      name: 'sales_metrics',
      entities: m.entities.filter(e => ['Order', 'Customer'].includes(e.name))
                    .map(e => ({...e, extends: undefined}) as Entity),
      relationships: m.relationships.filter(r => r.name === 'placedBy'),
      metrics: m.metrics.filter(x => x.name === 'total_amount'),
      customExtensions: [target('g_metrics')],
    };
  }

  test('the skill points at the extra graph and lists its measures', () => {
    const {files} = generate(fixture(), 'query', [slice()]);
    expect(body(files['SKILL.md'])).toContain('Also: `p.d.g_metrics` (model `sales_metrics`');
    expect(files['references/metrics.md'])
        .toContain('MEASURE in: `p.d.g` (on `Order`), `p.d.g_metrics` (on `Order`)');
  });

  test('GRAPH_EXPAND moves to a graph within the node-table limit', () => {
    const wide = fixture();
    for (let i = 0; i < 8; i++) {
      wide.entities.push({
        name: `Filler${i}`, dataSource: `p.d.filler_${i}`, keys: ['id'], fields: [f('id', 'id')],
      });
    }
    const {files} = generate(wide, 'query', [slice()]);
    const section = files['references/metrics.md'].split('## total_amount')[1];
    expect(section).toContain('FROM GRAPH_EXPAND("p.d.g_metrics")');
    expect(body(files['SKILL.md'])).toMatch(/\| `total_amount` \| .* \| `Order` in `g_metrics` \|/);
  });
});


describe('modes', () => {
  test('act is still the default, and writes no query pages', () => {
    const runtime = rt(fixture());
    const dflt = generateSkill({runtime});
    const act = generateSkill({runtime, mode: 'act'});
    expect(dflt).toEqual(act);
    if ('error' in act) throw new Error(act.error);
    expect(act.files.map(x => x.path).sort()).toEqual(['SKILL.md', 'references/cancel-order.md']);
    expect(act.files[0].text).toContain('## What you can do here');
    expect(act.files[0].text).not.toContain('## How to answer');
  });

  test('an unknown mode is an error', () => {
    const out = generateSkill({runtime: rt(fixture()), mode: 'read' as never});
    expect('error' in out && out.error).toContain("unknown skill mode 'read'");
  });

  test('both writes one skill with the query index and the action router', () => {
    const {files, warnings} = generate(fixture(), 'both');
    const b = body(files['SKILL.md']);
    expect(b).toContain('## How to answer');
    expect(b).toContain('## Entities');
    expect(b).toContain('## What you can do here');
    expect(b).toContain('`references/cancel-order.md`');
    // The act side's table listing is replaced by a pointer to the read side.
    expect(b).not.toContain('This skill offers writes, not reads');
    expect(Object.keys(files)).toContain('references/cancel-order.md');
    expect(Object.keys(files)).toContain('references/entities/Order.md');
    expect(String(frontmatter(files['SKILL.md']).description).length).toBeLessThanOrEqual(1024);
    expect(String(frontmatter(files['SKILL.md']).description)).toContain('CancelOrder');
    expect(warnings.some(w => w.includes('SKILL.md body'))).toBe(false);
  });

  test('both on a model without actions is the query skill, warned', () => {
    const m = fixture();
    m.actions = [];
    const both = generate(m, 'both');
    const query = generate(m, 'query');
    expect(both.files).toEqual(query.files);
    expect(both.warnings[0]).toContain('declares no actions');
  });
});
