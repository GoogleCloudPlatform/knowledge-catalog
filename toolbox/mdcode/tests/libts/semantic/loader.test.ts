// Behavior specification for the semantic-model loader
// (src/libts/semantic/loader.ts).
//
// The loader reads the subset of an open, AI-first semantics format needed to
// normalize a model into the IR. Each test names one behavior. Focused tests use
// `fromDocument` with object literals; document-level tests parse raw YAML/JSON
// text via `loadModels`. This file asserts only the IR — the BigQuery generator
// is covered by `bigquery.test.ts` (unit) and `bigquery.e2e.test.ts` (file -> DDL).
//

import { describe, test, expect } from 'bun:test';
import { databaseOf, googleBlockProfiles, loadModels, LoadOptions, loadSemanticModels, fromDocument } from '../../../src/libts/semantic/loader';
import { deploymentTargetUris } from '../../../src/libts/semantic/deployment_target';
import { isTimeDimension, DATA_TYPES } from '../../../src/libts/semantic/ir';
import { resolveInheritance } from '../../../src/libts/semantic/resolve_inheritance';
import { loadProfileFile, validateProfileCompleteness, validateProfileConsistency } from '../../../src/libts/semantic/resolve_profiles';
import { readFileSync } from 'fs';
import { join } from 'path';

// Shorthand for the format's per-dialect expression object.
function expr(expression: string, dialect = 'BIGQUERY') {
  return { dialects: [{ dialect, expression }] };
}


describe('dataset source strings normalize to fully-qualified references', () => {
  const { models } = fromDocument({ version: '0.2.0.dev0',
    semantic_model: [{
      name: 'm',
      datasets: [
        { name: 'a', source: 'proj.ds.tbl', primary_key: ['id'], fields: [] },
        { name: 'b', source: 'ds.tbl', primary_key: ['id'], fields: [] },
        { name: 'c', source: 'tbl', primary_key: ['id'], fields: [] },
      ],
    }],
  }, { defaultProject: 'P', defaultDataset: 'D', allowLegacyBareSource: true });
  const [a, b, c] = models[0].entities;

  test('a three-part source becomes project.dataset.table', () => {
    expect(a.dataSource).toBe('proj.ds.tbl');
  });

  test('a two-part source becomes dataset.table, project from defaults', () => {
    expect(b.dataSource).toBe('P.ds.tbl');
  });

  test('a bare table fills both project and dataset from defaults', () => {
    expect(c.dataSource).toBe('P.D.tbl');
  });

  test('a query-like source is rejected', () => {
    expect(() => fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{ name: 'm', datasets: [
        { name: 'a', source: 'SELECT 1 FROM t', primary_key: ['id'], fields: [] }] }],
    }, { allowLegacyBareSource: true })).toThrow(
      "dataset 'a': source 'SELECT 1 FROM t' looks like a SQL query; a query-valued source is not supported yet",
    );
  });

  test('a dataset without a primary key warns (its KEY would be empty)', () => {
    const { warnings } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{ name: 'm', datasets: [
        { name: 'a', source: 'bigquery:p.d.a', fields: [] }] }],
    });
    expect(warnings.some(w => w.includes('no primary_key'))).toBe(true);
  });

  test('backtick- or double-quoted identifiers are unquoted', () => {
    const { models } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{ name: 'm', datasets: [
        { name: 'a', source: '`proj`.`ds`.`tbl`', primary_key: ['id'], fields: [] }] }],
    }, { allowLegacyBareSource: true });
    expect(models[0].entities[0].dataSource).toBe('proj.ds.tbl');
  });

  test('a four-part Lakehouse catalog name passes through untouched', () => {
    const { models, warnings } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{ name: 'm', datasets: [
        { name: 'a', source: 'proj.cat.ns.tbl', primary_key: ['id'], fields: [] }] }],
    }, { defaultProject: 'P', defaultDataset: 'D', allowLegacyBareSource: true });
    expect(models[0].entities[0].dataSource).toBe('proj.cat.ns.tbl');
    expect(warnings).toEqual([]);
  });

  test('an explicit project/dataset in the source is not overridden by defaults', () => {
    const { models } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{ name: 'm', datasets: [
        { name: 'a', source: 'realproj.realds.tbl', primary_key: ['id'], fields: [] }] }],
    }, { defaultProject: 'P', defaultDataset: 'D', allowLegacyBareSource: true });
    expect(models[0].entities[0].dataSource).toBe('realproj.realds.tbl');
  });
});


describe('per-dialect expressions collapse to a single string', () => {
  function metricDoc(dialectList: Array<{ dialect: string; expression: string }>) {
    return {
      version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'], fields: [] }],
        metrics: [{ name: 'mx', expression: { dialects: dialectList } }],
      }],
    };
  }

  test('the preferred dialect (BIGQUERY) is chosen with no warning or provenance', () => {
    const { models, warnings } = fromDocument(metricDoc([
      { dialect: 'ANSI_SQL', expression: 'SUM(orders.a)' },
      { dialect: 'BIGQUERY', expression: 'SUM(orders.b)' },
    ]));
    expect(models[0].metrics[0].expression).toBe('SUM(orders.b)');
    expect(warnings.some(w => w.includes('dialect'))).toBe(false);
    // Target dialect is already valid; no imported (vendor) form to preserve.
    expect(models[0].metrics[0].importedExpression).toBeUndefined();
  });

  test('ANSI_SQL is the fallback when the preferred dialect is absent, with an informational note', () => {
    const { models, warnings } = fromDocument(metricDoc([
      { dialect: 'ANSI_SQL', expression: 'SUM(orders.a)' },
    ]));
    expect(models[0].metrics[0].expression).toBe('SUM(orders.a)');
    expect(warnings.some(w => w.startsWith('note:') && w.includes("using the portable 'ANSI_SQL'"))).toBe(true);
    // The portable canonical dialect targets BigQuery by design; no imported form.
    expect(models[0].metrics[0].importedExpression).toBeUndefined();
  });

  test('a vendor-only expression is kept as imported_expression, with no target expression', () => {
    const { models, warnings } = fromDocument(metricDoc([
      { dialect: 'SNOWFLAKE', expression: 'SUM(orders.a)' },
    ]));
    // No target/canonical form, so the target `expression` is left unset and the
    // original vendor SQL is preserved for a later transpile pass.
    expect(models[0].metrics[0].expression).toBeUndefined();
    expect(models[0].metrics[0].importedExpression).toBe('SUM(orders.a)');
    expect(models[0].metrics[0].importedDialect).toBe('SNOWFLAKE');
    expect(warnings.some(w => w.includes("'SNOWFLAKE'") && w.includes('imported_expression'))).toBe(true);
  });

  test('an explicit dialect option overrides the default preference', () => {
    const { models } = fromDocument(metricDoc([
      { dialect: 'SNOWFLAKE', expression: 'SF' },
      { dialect: 'BIGQUERY', expression: 'BQ' },
    ]), { dialect: 'SNOWFLAKE' });
    expect(models[0].metrics[0].expression).toBe('SF');
  });

  test('dialect names must match ALLOWED_DIALECTS casing in both flavors', () => {
    expect(() => fromDocument(metricDoc([
      { dialect: 'BigQuery', expression: 'SUM(orders.a)' },
    ]))).toThrow(/ANSI_SQL.*BIGQUERY/);
    expect(() => fromDocument({
      version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
          fields: [{ name: 'a', expression: { dialects: [{ dialect: 'BigQuery', expression: 'orders.a' }] } }],
        }],
      }],
    })).toThrow(/ANSI_SQL.*BIGQUERY/);
  });

  test('field expressions select their dialect independently of metrics', () => {
    const { models, warnings } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
          fields: [
            { name: 'id', expression: expr('orders.id') },
            { name: 'net', expression: {
              dialects: [{ dialect: 'ANSI_SQL', expression: 'orders.gross - orders.tax' }] } },
            { name: 'label', expression: {
              dialects: [{ dialect: 'SNOWFLAKE', expression: "IFF(orders.ok, 'y', 'n')" }] } },
          ],
        }],
      }],
    });
    const fields = models[0].entities[0].fields;
    expect(fields[0].expression).toBe('orders.id');                  // BIGQUERY, no fallback
    expect(fields[1].expression).toBe('orders.gross - orders.tax');  // ANSI_SQL fallback
    expect(fields[2].expression).toBeUndefined();                    // no target/canonical form
    expect(fields[2].importedExpression).toBe("IFF(orders.ok, 'y', 'n')");  // SNOWFLAKE, kept as imported
    // The canonical-fallback note is field-agnostic (so it dedupes); the point
    // here is that the two fields still pick their expressions independently.
    expect(warnings.some(w => w.includes("using the portable 'ANSI_SQL'"))).toBe(true);
    // The imported (vendor) dialect is recorded only for the vendor field, so the
    // transpile pass rewrites just that one.
    expect(fields[0].importedDialect).toBeUndefined();
    expect(fields[1].importedDialect).toBeUndefined();
    expect(fields[2].importedDialect).toBe('SNOWFLAKE');
  });
});


describe('relationships map onto the direct-FK IR convention', () => {
  const { models } = fromDocument({ version: '0.2.0.dev0',
    semantic_model: [{
      name: 'm',
      datasets: [
        { name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['order_id'], fields: [] },
        { name: 'customers', source: 'bigquery:p.d.customers', primary_key: ['customer_id'], fields: [] },
      ],
      relationships: [{
        name: 'orders_customers', from: 'orders', to: 'customers',
        from_columns: ['customer_id'], to_columns: ['customer_id'],
      }],
    }],
  });
  const rel = models[0].relationships[0];

  test('the source end carries the from_columns (the FK columns)', () => {
    expect(rel.source).toEqual({ entity: 'orders', columns: ['customer_id'] });
  });

  test('the destination end carries the to_columns (the referenced key columns)', () => {
    expect(rel.destination).toEqual({ entity: 'customers', columns: ['customer_id'] });
  });

  test('a composite foreign key maps column-for-column', () => {
    const { models } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [
          { name: 'sales', source: 'bigquery:p.d.sales', primary_key: ['sale_id'], fields: [] },
          { name: 'stores', source: 'bigquery:p.d.stores', primary_key: ['region', 'store_no'], fields: [] },
        ],
        relationships: [{
          name: 'sales_stores', from: 'sales', to: 'stores',
          from_columns: ['region', 'store_no'], to_columns: ['region', 'store_no'],
        }],
      }],
    });
    const rel = models[0].relationships[0];
    expect(rel.source.columns).toEqual(['region', 'store_no']);
    expect(rel.destination.columns).toEqual(['region', 'store_no']);
  });

  test('the source columns come from from_columns, not the from dataset PK', () => {
    // The FK columns are taken straight from from_columns; the source entity's own
    // primary key is looked up from the entity by downstream consumers, never
    // duplicated onto the relationship (so a missing from-PK is irrelevant here).
    const { models } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [
          { name: 'orders', source: 'bigquery:p.d.orders', fields: [] },  // no primary_key
          { name: 'customers', source: 'bigquery:p.d.customers', primary_key: ['customer_id'], fields: [] },
        ],
        relationships: [{
          name: 'r', from: 'orders', to: 'customers',
          from_columns: ['customer_id'], to_columns: ['customer_id'],
        }],
      }],
    });
    expect(models[0].relationships[0].source).toEqual({
      entity: 'orders', columns: ['customer_id'] });
  });

  test('an unresolved to dataset is a hard error', () => {
    expect(() => fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['order_id'], fields: [] }],
        relationships: [{
          name: 'r', from: 'orders', to: 'ghost',
          from_columns: ['g_id'], to_columns: ['id'],
        }],
      }],
    })).toThrow(/'to' dataset 'ghost' is not defined/);
  });

  test('an unresolved from dataset is a hard error', () => {
    expect(() => fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'customers', source: 'bigquery:p.d.customers', primary_key: ['customer_id'], fields: [] }],
        relationships: [{
          name: 'r', from: 'ghost', to: 'customers',
          from_columns: ['c_id'], to_columns: ['customer_id'],
        }],
      }],
    })).toThrow(/'from' dataset 'ghost' is not defined/);
  });

  test('mismatched from_columns/to_columns arity is a hard error', () => {
    expect(() => fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [
          { name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['order_id'], fields: [] },
          { name: 'customers', source: 'bigquery:p.d.customers', primary_key: ['a', 'b'], fields: [] },
        ],
        relationships: [{
          name: 'r', from: 'orders', to: 'customers',
          from_columns: ['x', 'y'], to_columns: ['a'],
        }],
      }],
    })).toThrow(/different lengths/);
  });
});

describe('abstract datasets and their source constraint', () => {
  test('a non-abstract dataset with no source is a hard error', () => {
    expect(() => fromDocument({ version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'orders', primary_key: ['id'], fields: [] }],
      }],
    })).toThrow(/non-abstract dataset requires a source/);
  });

  test('an abstract dataset that also declares a source is a hard error', () => {
    // abstract == no physical table; a source would be silently ignored by the
    // BigQuery leg, dropping a table the author intended, so reject the combo.
    expect(() => fromDocument({ version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'Party', source: 'bigquery:proj.ds.party', abstract: true,
          primary_key: ['id'], fields: [],
        }],
      }],
    })).toThrow(/an abstract dataset has no table/);
  });

  test('an abstract dataset with no source loads and is marked abstract', () => {
    const { models } = fromDocument({ version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'Party', abstract: true, fields: [] }],
      }],
    });
    expect(models[0].entities[0].abstract).toBe(true);
    expect(models[0].entities[0].dataSource).toBe('');
  });

  test('an abstract dataset\'s fields need no expression under a graph leg', () => {
    // The supertype has no table, so its fields carry no column -- they name
    // the label its subtypes bind. The strict (graph-leg) schema must accept
    // them even though a concrete dataset's field would require an expression.
    const { models } = fromDocument({ version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        datasets: [
          {
            name: 'Party', abstract: true, primary_key: ['id'],
            fields: [{ name: 'id' }, { name: 'name' }],
          },
          {
            name: 'Customer', extends: ['Party'], primary_key: ['id'],
            source: 'bigquery:proj.ds.customer',
            fields: [
              { name: 'id', expression: 'c_custkey' },
              { name: 'name', expression: 'c_name' },
            ],
          },
        ],
      }],
    });
    const party = models[0].entities.find(e => e.name === 'Party')!;
    expect(party.abstract).toBe(true);
    expect(party.fields.map(f => f.name)).toEqual(['id', 'name']);
    expect(party.fields.every(f => f.expression === undefined)).toBe(true);
  });

  test('a concrete dataset\'s expression-less field loads as unbound under a graph leg', () => {
    // A field with no expression is unbound, not an error: the availability
    // pass drops it (and whatever depends on it) before generation. The
    // dataset's own `source` is a separate constraint and is still required.
    // Google flavor: a plain vanilla document (no GOOGLE block) must bind
    // every field, so leaving one unbound is a Google-flavor feature.
    const { models } = fromDocument({ version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'orders',
          primary_key: ['id'],
          source: 'bigquery:proj.ds.orders',
          fields: [{ name: 'id', expression: 'o_id' }, { name: 'total' }],
        }],
      }],
    });
    const [id, total] = models[0].entities[0].fields;
    expect(id.expression).toBe('o_id');
    expect(total.expression).toBeUndefined();
  });
});

describe('a field or metric expression with no SQL is a load error', () => {
  // The model with its `notes` field written as `notesField`, followed by
  // `metrics`, when given.
  const shop = (notesField: string, metrics = '') => `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: orders
        source: //bigquery.googleapis.com/projects/p/datasets/d/tables/orders
        primary_key: [order_id]
        fields:
          - {name: order_id, expression: order_id}
          - {name: amount, expression: amount}
          - ${notesField}
    deployments:
      - name: default
        target: //bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/shop
${metrics}`;
  const fix =
      "write the field's SQL, or remove 'expression' to leave the field unbound";
  const entries = (...list: string[]) =>
      `{name: notes, expression: {dialects: [${list.join(', ')}]}}`;

  test('an empty or whitespace string expression is rejected, naming the entity and field', () => {
    for (const blank of ['""', '"   "', '"\\t\\n"']) {
      expect(() => loadModels(shop(`{name: notes, expression: ${blank}}`)))
          .toThrow(`field 'orders.notes': 'expression' is blank; ${fix}`);
    }
  });

  test('a dialect entry with an empty expression is rejected, naming the entry', () => {
    const notes = entries(
        '{dialect: ANSI_SQL, expression: notes}', '{dialect: BIGQUERY, expression: ""}');
    expect(() => loadModels(shop(notes)))
        .toThrow(
            `field 'orders.notes': the BIGQUERY entry of 'expression' is blank; ${fix}`);
  });

  test('a blank entry is rejected when the load dialect picks another entry', () => {
    const notes = entries(
        '{dialect: BIGQUERY, expression: notes}', '{dialect: SNOWFLAKE, expression: ""}');
    expect(() => loadModels(shop(notes)))
        .toThrow("field 'orders.notes': the SNOWFLAKE entry of 'expression' is blank");
  });

  test('every blank entry of a field is named in one message', () => {
    const notes = entries(
        '{dialect: BIGQUERY, expression: ""}', '{dialect: SPANNER, expression: " "}',
        '{dialect: ANSI_SQL, expression: notes}');
    expect(() => loadModels(shop(notes)))
        .toThrow(
            "field 'orders.notes': the BIGQUERY entry of 'expression' is blank " +
            `and the SPANNER entry of 'expression' is blank; ${fix}`);
  });

  test('an expression that is only a comment is rejected', () => {
    for (const comment of ['"-- todo"', '"/* todo */"', '"-- a\\n-- b"']) {
      expect(() => loadModels(shop(`{name: notes, expression: ${comment}}`)))
          .toThrow(`field 'orders.notes': 'expression' is only a comment; ${fix}`);
    }
    // BigQuery reads `#` as a comment.
    expect(() => loadModels(shop(entries('{dialect: BIGQUERY, expression: "# todo"}'))))
        .toThrow("field 'orders.notes': the BIGQUERY entry of 'expression' is only a comment");
    expect(() => loadModels(shop('{name: notes, expression: "# todo"}')))
        .toThrow("field 'orders.notes': 'expression' is only a comment");
  });

  test('an expression that is only its entity\'s qualifier is rejected', () => {
    // The graph generators remove the qualifier, which would leave nothing.
    for (const qualifier of ['"orders."', '"orders. /* todo */"', '"`orders`."']) {
      expect(() => loadModels(shop(`{name: notes, expression: ${qualifier}}`)))
          .toThrow(`field 'orders.notes': 'expression' is only the qualifier 'orders.'; ${fix}`);
    }
    expect(() => loadModels(shop(entries('{dialect: POSTGRES, expression: "orders."}'))))
        .toThrow("field 'orders.notes': the POSTGRES entry of 'expression' is only the qualifier 'orders.'");
    expect(() => loadModels(shop('{name: notes, expression: "orders.notes"}'))).not.toThrow();
  });

  test('an inherited expression left with only the entity\'s qualifier is rejected', () => {
    // Inheritance removes `base.` on `orders`, and the graph generators remove
    // `orders.`.
    const doc = `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: base
        source: //bigquery.googleapis.com/projects/p/datasets/d/tables/base
        primary_key: [id]
        fields:
          - {name: id, expression: id}
          - {name: notes, expression: "base.orders."}
      - name: orders
        extends: [base]
        source: //bigquery.googleapis.com/projects/p/datasets/d/tables/orders
        primary_key: [id]
    deployments:
      - name: default
        target: //bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/shop
`;
    expect(() => loadModels(doc))
        .toThrow(
            "model 'shop': entity 'orders' inherits field 'notes': read on " +
            "'orders', 'expression' is only the qualifier 'orders.'; write the " +
            "field's SQL");
    expect(() => loadModels(doc.replace('base.orders.', 'base.notes'))).not.toThrow();
  });

  test('an inherited field is read as the document writes it, in any load dialect', () => {
    // PostgreSQL reads `#` as an operator, so `# path` holds SQL. A load in
    // the POSTGRES dialect makes it the field's `expression`.
    const doc = `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: base
        source: //bigquery.googleapis.com/projects/p/datasets/d/tables/base
        primary_key: [id]
        fields:
          - {name: id, expression: id}
          - name: points
            expression:
              dialects:
                - {dialect: POSTGRES, expression: "# path"}
      - name: orders
        extends: [base]
        source: //bigquery.googleapis.com/projects/p/datasets/d/tables/orders
        primary_key: [id]
`;
    expect(() => loadModels(doc, {dialect: 'POSTGRES'})).not.toThrow();
    expect(() => loadModels(doc)).not.toThrow();
  });

  test('an expression with SQL and a comment loads as written', () => {
    const {models, warnings} =
        loadModels(shop('{name: notes, expression: "notes -- free text"}'));
    expect(models[0].entities[0].fields[2].expression).toBe('notes -- free text');
    expect(warnings).toEqual([]);
  });

  test('a field with no expression still loads unbound', () => {
    const {models} = loadModels(shop('{name: notes}'));
    const notes = models[0].entities[0].fields[2];
    expect(notes.name).toBe('notes');
    expect(notes.expression).toBeUndefined();
    expect(notes.dialects).toBeUndefined();
  });

  test('a field with an expression loads as before', () => {
    const {models, warnings} = loadModels(shop('{name: notes, expression: " notes "}'));
    const notes = models[0].entities[0].fields[2];
    expect(notes.expression).toBe(' notes ');
    expect(notes.dialects).toEqual([{dialect: 'ANSI_SQL', expression: ' notes '}]);
    expect(warnings).toEqual([]);
  });

  test('a vanilla model rejects a blank dialect entry, and reports a string form as a string form', () => {
    const vanilla = (notesExpression: string) => `version: "0.2.0.dev0"
semantic_model:
  - name: shop
    datasets:
      - name: orders
        source: //bigquery.googleapis.com/projects/p/datasets/d/tables/orders
        primary_key: [order_id]
        fields:
          - {name: order_id, expression: {dialects: [{dialect: ANSI_SQL, expression: order_id}]}}
          - {name: notes, expression: ${notesExpression}}
`;
    expect(() => loadModels(vanilla('{dialects: [{dialect: ANSI_SQL, expression: ""}]}')))
        .toThrow("field 'orders.notes': the ANSI_SQL entry of 'expression' is blank");
    // A vanilla document takes no string form, so that is the first thing to fix.
    expect(() => loadModels(vanilla('""')))
        .toThrow("does not support the bare-string 'expression' shorthand");
  });

  test('a metric expression with no SQL is rejected, naming the metric', () => {
    const withMetric = (expression: string) => shop(
        '{name: notes, expression: notes}',
        `    metrics:\n      - {name: total, entity: orders, expression: ${expression}}\n`);
    for (const [expression, problem] of [
           ['""', "'expression' is blank"],
           ['"  "', "'expression' is blank"],
           ['"-- todo"', "'expression' is only a comment"],
           ['{dialects: [{dialect: ANSI_SQL, expression: SUM(orders.amount)}, ' +
                '{dialect: BIGQUERY, expression: ""}]}',
            "the BIGQUERY entry of 'expression' is blank"],
         ]) {
      expect(() => loadModels(withMetric(expression)))
          .toThrow(`metric 'total': ${problem}; write the metric's SQL`);
    }
    expect(() => loadModels(withMetric('SUM(orders.amount)'))).not.toThrow();
  });
});


describe('metrics infer their referenced entities from the expression', () => {
  test('a single referenced entity becomes the metric attach entity', () => {
    const { models } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'order_items', source: 'bigquery:p.d.order_items', primary_key: ['id'], fields: [] }],
        metrics: [{ name: 'total_revenue', expression: expr('SUM(order_items.amount)') }],
      }],
    });
    expect(models[0].metrics[0].entity).toBe('order_items');
  });

  test('a metric spanning multiple entities has no single attach entity', () => {
    // A cross-entity metric references known entities but cannot hang off one
    // node, so `entity` is left undefined -- not a missing-entity warning.
    const { models, warnings } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [
          { name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'], fields: [] },
          { name: 'customers', source: 'bigquery:p.d.customers', primary_key: ['id'], fields: [] },
        ],
        metrics: [{
          name: 'ratio',
          expression: expr('SUM(orders.amount) / COUNT(customers.id)'),
        }],
      }],
    });
    expect(models[0].metrics[0].entity).toBeUndefined();
    expect(warnings.some(w => w.includes('references no known entity'))).toBe(false);
  });

  test('a metric referencing no known entity warns', () => {
    const { warnings } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'order_items', source: 'bigquery:p.d.order_items', primary_key: ['id'], fields: [] }],
        metrics: [{ name: 'weird', expression: expr('SUM(unknown.x)') }],
      }],
    });
    expect(warnings.some(w => w.includes('references no known entity'))).toBe(true);
  });

  test('a qualifier inside a string literal is not counted as a reference', () => {
    // 'customers.region' is data, not a column reference, so the metric must be
    // attributed only to order_items.
    const { models } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [
          { name: 'order_items', source: 'bigquery:p.d.order_items', primary_key: ['id'], fields: [] },
          { name: 'customers', source: 'bigquery:p.d.customers', primary_key: ['id'], fields: [] },
        ],
        metrics: [{
          name: 'tagged',
          expression: expr("CONCAT(SUM(order_items.amount), 'customers.region')"),
        }],
      }],
    });
    expect(models[0].metrics[0].entity).toBe('order_items');
  });

  test('a backtick-quoted entity qualifier is recognized (BigQuery quoting)', () => {
    // BigQuery quotes identifiers with backticks; `orders`.amount must still be
    // attributed to the orders entity, not dropped as unqualified.
    const { models, warnings } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'], fields: [] }],
        metrics: [{ name: 'rev', expression: expr('SUM(`orders`.amount)') }],
      }],
    });
    expect(models[0].metrics[0].entity).toBe('orders');
    expect(warnings.some(w => w.includes('references no known entity'))).toBe(false);
  });
});


describe('document-level handling', () => {
  test('an unknown version is a hard load error', () => {
    expect(() => fromDocument({
      version: '9.9.9',
      semantic_model: [{ name: 'm', datasets: [
        { name: 'a', source: 'bigquery:p.d.a', primary_key: ['id'], fields: [] }] }],
    })).toThrow(/unknown version '9.9.9'/);
  });

  test('an unknown key is a hard load error (objects are strict)', () => {
    // Objects are `.strict()`: an unrecognized key is rejected rather than
    // silently dropped, so a typo cannot slip through unnoticed.
    expect(() => fromDocument({
      version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'a', source: 'bigquery:p.d.a', primary_key: ['id'],
          fields: [{ name: 'id', expression: expr('a.id'), bogus: true }],
        }],
      }],
    })).toThrow(/Semantic model load error/);
  });

  test('duplicate dataset names are a hard load error', () => {
    expect(() => fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [
          { name: 'orders', source: 'bigquery:p.d.a', primary_key: ['id'], fields: [] },
          { name: 'orders', source: 'bigquery:p.d.b', primary_key: ['id'], fields: [] },
        ],
      }],
    })).toThrow(/duplicate dataset name 'orders'/);
  });

  test('a document holds at most one semantic model', () => {
    // The format allows one model per document; a second is rejected.
    expect(() => fromDocument({ version: '0.2.0.dev0',
      semantic_model: [
        { name: 'first', datasets: [{ name: 'a', source: 'bigquery:p.d.a', primary_key: ['id'], fields: [] }] },
        { name: 'second', datasets: [{ name: 'b', source: 'bigquery:p.d.b', primary_key: ['id'], fields: [] }] },
      ],
    })).toThrow(/a document declares one model; split 'second' into its own file/);
  });

  test('model and metric descriptions carry through to the IR', () => {
    const { models } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm', description: 'a sales model',
        datasets: [{ name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'], fields: [] }],
        metrics: [{ name: 'c', description: 'row count', expression: expr('COUNT(orders.id)') }],
      }],
    });
    expect(models[0].description).toBe('a sales model');
    expect(models[0].metrics[0].description).toBe('row count');
  });

  test('JSON text loads identically to YAML (yaml.parse accepts JSON)', () => {
    const json = JSON.stringify({
      version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'a', source: 'bigquery:proj.ds.tbl', primary_key: ['id'], fields: [] }],
      }],
    });
    const { models } = loadModels(json);
    expect(models[0].entities[0].dataSource).toBe('proj.ds.tbl');
  });

  test('a document without semantic_model throws', () => {
    expect(() => fromDocument({ version: '0.2.0.dev0', foo: 'bar' })).toThrow(/Semantic model load error/);
  });

  test('an empty semantic_model array throws (min one model required)', () => {
    expect(() => fromDocument({ version: '0.2.0.dev0', semantic_model: [] })).toThrow(/Semantic model load error/);
  });

  test('unparseable input throws', () => {
    expect(() => loadModels('{ this is : not valid')).toThrow(/load error/);
  });
});


describe('richer IR fields carry through from the format', () => {
  test('field and metric datatype populate the IR type', () => {
    const { models } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
          fields: [{ name: 'amount', datatype: 'Decimal', expression: expr('orders.amount') }],
        }],
        metrics: [{ name: 'total', datatype: 'Decimal', expression: expr('SUM(orders.amount)') }],
      }],
    });
    expect(models[0].entities[0].fields[0].type).toBe('Decimal');
    expect(models[0].metrics[0].type).toBe('Decimal');
  });

  test('an off-vocabulary datatype is rejected (closed, case-sensitive enum)', () => {
    // Lowercase 'date' is not in the vocabulary (only 'Date' is); the closed
    // enum makes this a hard parse error rather than a silently mis-typed field.
    expect(() => fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
          fields: [{ name: 'created', datatype: 'date', expression: expr('orders.created') }],
        }],
      }],
    })).toThrow(/Semantic model load error/);
  });

  test('a dataset unique_keys becomes Entity.uniqueKeys', () => {
    const { models } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
          unique_keys: [['sku', 'region'], ['external_id']],
          fields: [],
        }],
      }],
    });
    expect(models[0].entities[0].uniqueKeys).toEqual([['sku', 'region'], ['external_id']]);
  });

  test('the GOOGLE block is carried verbatim, not interpreted at load time', () => {
    const { models } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        custom_extensions: [
          { vendor_name: 'OTHER', data: '{"ignored": true}' },
          { vendor_name: 'GOOGLE', data: JSON.stringify({
            deploymentTargets: ['projects/p/locations/us/graphs/g'] }) },
        ],
        datasets: [{ name: 'a', source: 'bigquery:p.d.a', primary_key: ['id'], fields: [] }],
      }],
    });
    // GOOGLE gets no special treatment -- it rides along in customExtensions like
    // any other vendor block; a typed deployment view is a consumer concern.
    expect(models[0].customExtensions).toEqual([
      { vendorName: 'OTHER', data: '{"ignored": true}' },
      { vendorName: 'GOOGLE', data: JSON.stringify({
        deploymentTargets: ['projects/p/locations/us/graphs/g'] }) },
    ]);
  });

  test('a malformed GOOGLE block is rejected, naming the model', () => {
    expect(() => fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        custom_extensions: [{ vendor_name: 'GOOGLE', data: '{not json' }],
        datasets: [{ name: 'a', source: 'bigquery:p.d.a', primary_key: ['id'], fields: [] }],
      }],
    })).toThrow("model 'm': the 'data' of a GOOGLE custom_extensions block must be a JSON object.");
  });

  test('ai_context instructions and synonyms are structural, not folded into description', () => {
    const { models } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm', description: 'a sales model',
        ai_context: { instructions: 'Prefer net revenue.', synonyms: ['sales', 'commerce'] },
        datasets: [{
          name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
          ai_context: { instructions: 'One row per order.', synonyms: ['purchases'] },
          fields: [{
            name: 'amount', expression: expr('orders.amount'),
            ai_context: { instructions: 'Gross, before tax.' },
          }],
        }],
      }],
    });
    const model = models[0];
    // Description stays the base text; instructions/synonyms live on aiContext.
    expect(model.description).toBe('a sales model');
    expect(model.aiContext?.instructions).toBe('Prefer net revenue.');
    expect(model.aiContext?.synonyms).toEqual(['sales', 'commerce']);

    // Dataset-level: no base description supplied, so it stays unset; instructions
    // and synonyms are structural.
    const entity = model.entities[0];
    expect(entity.description).toBeUndefined();
    expect(entity.aiContext?.instructions).toBe('One row per order.');
    expect(entity.aiContext?.synonyms).toEqual(['purchases']);

    // Field-level: instructions structural; no description text was supplied.
    const field = entity.fields[0];
    expect(field.description).toBeUndefined();
    expect(field.aiContext?.instructions).toBe('Gross, before tax.');
  });
});


describe('Apache OSI v0.2.0.dev0 spec coverage', () => {
  // A maximal document exercising every field the OSI core schema defines,
  // including nested custom_extensions at every level and the required version
  // const. It must load without throwing and without spurious warnings, and the
  // supported semantics must land in the IR.
  const doc = {
    version: '0.2.0.dev0',
    semantic_model: [{
      name: 'sales',
      description: 'Sales semantic model',
      ai_context: { instructions: 'Prefer net.', synonyms: ['commerce'], examples: ['revenue by month'] },
      custom_extensions: [{ vendor_name: 'GOOGLE', data: JSON.stringify({
        deploymentTargets: ['projects/p/locations/us/graphs/g'] }) }],
      datasets: [
        {
          name: 'orders',
          source: 'bigquery:proj.ds.orders',
          primary_key: ['order_id'],
          unique_keys: [['external_id']],
          description: 'One row per order',
          ai_context: { instructions: 'Grain: order.', synonyms: ['purchases'] },
          custom_extensions: [{ vendor_name: 'DBT', data: '{"model":"orders"}' }],
          fields: [{
            name: 'amount',
            expression: { dialects: [{ dialect: 'BIGQUERY', expression: 'orders.amount' }] },
            dimension: { is_time: false },
            label: 'Order amount',
            description: 'Gross amount',
            datatype: 'Decimal',
            ai_context: { instructions: 'Before tax.', synonyms: ['gross'] },
            custom_extensions: [{ vendor_name: 'SNOWFLAKE', data: '{}' }],
          }],
        },
        { name: 'customers', source: 'bigquery:proj.ds.customers', primary_key: ['customer_id'], fields: [] },
      ],
      relationships: [{
        name: 'orders_customers',
        from: 'orders', to: 'customers',
        from_columns: ['customer_id'], to_columns: ['customer_id'],
        ai_context: { instructions: 'Each order has one customer.' },
        custom_extensions: [{ vendor_name: 'COMMON', data: '{}' }],
      }],
      metrics: [{
        name: 'total_amount',
        expression: { dialects: [{ dialect: 'BIGQUERY', expression: 'SUM(orders.amount)' }] },
        description: 'Total sales',
        datatype: 'Decimal',
        ai_context: { instructions: 'Sum of amounts.', synonyms: ['revenue'] },
        custom_extensions: [{ vendor_name: 'GOODDATA', data: '{}' }],
      }],
    }],
  };

  test('a maximal spec document loads without throwing', () => {
    expect(() => fromDocument(doc)).not.toThrow();
  });

  test('nested custom_extensions do not produce warnings (accepted, validated)', () => {
    const { warnings } = fromDocument(doc);
    // No vendor extension is acted upon at load time; all are accepted silently.
    // No dialect fallbacks here either, so no notes.
    expect(warnings).toEqual([]);
  });

  test('nested custom_extensions are preserved verbatim at every level', () => {
    const { models } = fromDocument(doc);
    const m = models[0];
    // Model level: the raw GOOGLE block is kept verbatim, uninterpreted.
    expect(m.customExtensions).toEqual([
      { vendorName: 'GOOGLE', data: JSON.stringify({
        deploymentTargets: ['projects/p/locations/us/graphs/g'] }) },
    ]);
    // Dataset / field / relationship / metric levels: kept verbatim, data opaque.
    expect(m.entities[0].customExtensions).toEqual([{ vendorName: 'DBT', data: '{"model":"orders"}' }]);
    expect(m.entities[0].fields[0].customExtensions).toEqual([{ vendorName: 'SNOWFLAKE', data: '{}' }]);
    expect(m.relationships[0].customExtensions).toEqual([{ vendorName: 'COMMON', data: '{}' }]);
    expect(m.metrics[0].customExtensions).toEqual([{ vendorName: 'GOODDATA', data: '{}' }]);
  });

  test('every supported field maps into the IR', () => {
    const { models } = fromDocument(doc);
    const m = models[0];
    expect(m.name).toBe('sales');
    expect(m.description).toBe('Sales semantic model');
    expect(m.aiContext?.examples).toEqual(['revenue by month']);
    expect(m.aiContext?.instructions).toBe('Prefer net.');
    expect(m.aiContext?.synonyms).toEqual(['commerce']);

    const orders = m.entities[0];
    expect(orders.dataSource).toBe('proj.ds.orders');
    expect(orders.keys).toEqual(['order_id']);
    expect(orders.uniqueKeys).toEqual([['external_id']]);
    expect(orders.aiContext?.instructions).toBe('Grain: order.');
    expect(orders.aiContext?.synonyms).toEqual(['purchases']);

    const amount = orders.fields[0];
    expect(amount.expression).toBe('orders.amount');
    expect(amount.type).toBe('Decimal');
    expect(amount.label).toBe('Order amount');
    expect(amount.description).toBe('Gross amount');
    expect(amount.dimension?.isTime).toBe(false);
    expect(isTimeDimension(amount)).toBe(false);
    expect(amount.aiContext?.instructions).toBe('Before tax.');
    expect(amount.aiContext?.synonyms).toEqual(['gross']);

    const rel = m.relationships[0];
    expect(rel.source.entity).toBe('orders');
    expect(rel.destination.entity).toBe('customers');
    expect(rel.aiContext?.instructions).toBe('Each order has one customer.');

    const metric = m.metrics[0];
    expect(metric.expression).toBe('SUM(orders.amount)');
    expect(metric.type).toBe('Decimal');
    expect(metric.entity).toBe('orders');
    expect(metric.aiContext?.instructions).toBe('Sum of amounts.');
    expect(metric.aiContext?.synonyms).toEqual(['revenue']);
  });

  test('all eight allowed dialects and ten datatypes are accepted, while non-SQL dialects (MDX, TABLEAU, MAQL) are rejected', () => {
    const dialects = ['ANSI_SQL', 'BIGQUERY', 'SPANNER', 'MYSQL', 'POSTGRES', 'ALLOYDB', 'SNOWFLAKE', 'DATABRICKS'];
    const datatypes = [...DATA_TYPES];  // the loader accepts exactly the IR vocabulary
    const { models } = fromDocument({
      version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'd', source: 'bigquery:p.d.d', primary_key: ['id'],
          fields: datatypes.map((dt, i) => ({
            name: `f${i}`, datatype: dt,
            expression: { dialects: [{ dialect: dialects[i % dialects.length], expression: `d.c${i}` }] },
          })),
        }],
      }],
    });
    // Every value is accepted. `Opaque` means "a type this model cannot name",
    // the same as leaving `datatype` out, so it loads as no type.
    expect(models[0].entities[0].fields.map(f => f.type))
        .toEqual(datatypes.map(dt => (dt === 'Opaque' ? undefined : dt)));

    for (const nonSql of ['MDX', 'TABLEAU', 'MAQL', 'THOUGHTSPOT']) {
      expect(() => fromDocument({
        version: '0.2.0.dev0',
        semantic_model: [{
          name: 'm',
          datasets: [{
            name: 'd', source: 'bigquery:p.d.d', primary_key: ['id'],
            fields: [{
              name: 'f',
              expression: { dialects: [{ dialect: nonSql, expression: 'd.c' }] },
            }],
          }],
        }],
      })).toThrow(`Unknown dialect '${nonSql}'`);
    }
  });
});


// Reads a real fixture file from tests/libts/semantic/fixtures and returns its
// text, so these tests exercise the on-disk YAML path (loadModels) end to end
// rather than hand-built object literals.
function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

describe('gold fixtures parse from disk (real YAML files)', () => {
  test('star_orders_customer.yaml: happy path (ai_context, time dimension, metrics)', () => {
    const { models } = loadModels(fixture('star_orders_customer.yaml'), { allowLegacyBareSource: true });
    expect(models).toHaveLength(1);
    const m = models[0];
    expect(m.name).toBe('sales');
    expect(m.aiContext?.instructions).toBe('Use this model for order analysis.');
    expect(m.entities.map(e => e.name)).toEqual(['orders', 'customer']);
    expect(m.entities[0].keys).toEqual(['o_orderkey']);
    expect(m.relationships.map(r => r.name)).toEqual(['orders_to_customer']);

    const orderdate = m.entities[0].fields.find(f => f.name === 'o_orderdate')!;
    expect(orderdate.aiContext?.synonyms).toEqual(['order date', 'date']);
    // label and time-dimension role are structural now, not folded into text.
    expect(orderdate.label).toBe('Order Date');
    expect(orderdate.dimension?.isTime).toBe(true);
    expect(isTimeDimension(orderdate)).toBe(true);
    expect(orderdate.description).toBeUndefined();

    const revenue = m.metrics.find(mt => mt.name === 'total_revenue')!;
    expect(revenue.expression).toBe('SUM(orders.o_totalprice)');
    expect(revenue.entity).toBe('orders');
    expect(revenue.aiContext?.synonyms).toEqual(['revenue', 'sales']);
    // order_count is entity-scoped (COUNT(orders.o_orderkey)) -> attach entity
    // inferred from the qualifier, so it is a valid single-entity measure.
    const count = m.metrics.find(mt => mt.name === 'order_count')!;
    expect(count.entity).toBe('orders');
    expect(count.expression).toBe('COUNT(orders.o_orderkey)');
  });

  test('vendor_dialects.yaml: non-target dialects kept as imported_expression', () => {
    const { models, warnings } = loadModels(fixture('vendor_dialects.yaml'), { allowLegacyBareSource: true });
    const m = models[0];
    expect(m.name).toBe('vendor_sales');

    const label = m.entities[0].fields.find(f => f.name === 'order_status_label')!;
    expect(label.expression).toBeUndefined();
    expect(label.importedDialect).toBe('SNOWFLAKE');
    expect(label.importedExpression).toContain('IFF(');

    const fulfilled = m.metrics.find(mt => mt.name === 'fulfilled_revenue')!;
    expect(fulfilled.expression).toBeUndefined();
    expect(fulfilled.importedDialect).toBe('SNOWFLAKE');
    expect(fulfilled.entity).toBe('orders');

    // Portable control metric still resolves to a target expression.
    const control = m.metrics.find(mt => mt.name === 'total_revenue')!;
    expect(control.expression).toBe('SUM(orders.o_totalprice)');

    expect(warnings.some(w =>
      w.includes("field 'orders.order_status_label'") && w.includes('imported_expression'))).toBe(true);
  });

  test('lineitem_databricks_ext.yaml: unique_keys + no-primary-key warning', () => {
    const { models, warnings } = loadModels(fixture('lineitem_databricks_ext.yaml'), { allowLegacyBareSource: true });
    const m = models[0];
    const orders = m.entities.find(e => e.name === 'orders')!;
    expect(orders.keys).toEqual([]);
    expect(orders.uniqueKeys).toEqual([['o_orderkey']]);
    expect(warnings.some(w => w.includes("dataset 'lineitem'") && w.includes('no primary_key'))).toBe(true);

    // custom_extensions are preserved verbatim at model / field / relationship / metric levels.
    expect(m.customExtensions?.[0].vendorName).toBe('DATABRICKS');
    const lineitem = m.entities.find(e => e.name === 'lineitem')!;
    expect(lineitem.fields[0].customExtensions?.[0].vendorName).toBe('DATABRICKS');
    expect(m.relationships[0].customExtensions?.[0].vendorName).toBe('DATABRICKS');
    expect(m.metrics.find(mt => mt.name === 'revenue')!.customExtensions?.[0].data).toContain('currency');
  });

  test('sales_google_ext.yaml: GOOGLE block verbatim + datatypes + unique_keys', () => {
    const { models } = loadModels(fixture('sales_google_ext.yaml'), { allowLegacyBareSource: true });
    const m = models[0];
    expect(m.customExtensions).toEqual([{
      vendorName: 'GOOGLE',
      data: JSON.stringify({ deploymentTargets: ['projects/demo/locations/us/entryGroups/@bigquery/entries/sales_graph'] }),
    }]);
    const orders = m.entities[0];
    expect(orders.uniqueKeys).toEqual([['o_orderkey'], ['o_ordernumber']]);
    expect(orders.fields.map(f => f.type)).toEqual(['Integer', 'String', 'Date', 'Decimal']);
    expect(m.metrics[0].type).toBe('Decimal');
    // Expressions are supplied in the BIGQUERY dialect (the default target), so
    // they resolve directly as `expression` -- exercising pickDialect's
    // target-dialect-present path, not the ANSI_SQL fallback. Nothing is left as
    // an imported (needs-transpile) form.
    expect(m.metrics[0].expression).toBe('SUM(orders.o_totalprice)');
    expect(m.metrics[0].importedExpression).toBeUndefined();
    expect(orders.fields.every(f => f.expression && !f.importedExpression)).toBe(true);
  });

  test('ossie/tpcds_semantic_model.yaml: the Apache reference example loads', () => {
    // The upstream example uses bare dotted table names, which the strict
    // source spec rejects by default (`kcmd import` rewrites them); it loads
    // here under `allowLegacyBareSource`.
    const { models, warnings } = loadModels(fixture('ossie/tpcds_semantic_model.yaml'), { allowLegacyBareSource: true });
    expect(models).toHaveLength(1);
    const m = models[0];
    expect(m.name).toBe('tpcds_retail_model');
    expect(m.entities).toHaveLength(5);
    expect(m.relationships).toHaveLength(4);
    expect(m.metrics).toHaveLength(5);

    // A cross-entity metric references more than one entity, so it has no
    // single attach entity.
    const clv = m.metrics.find(mt => mt.name === 'customer_lifetime_value')!;
    expect(clv.entity).toBeUndefined();

    // Every field and metric expression is ANSI_SQL -> resolves to a target
    // expression, so nothing is left needing transpilation.
    const needsTranspile = warnings.filter(w => w.includes('imported_expression'));
    expect(needsTranspile).toEqual([]);
  });
});

describe('duplicate names within a model are hard errors (uniqueness checks)', () => {
  test('duplicate field names within a dataset are a hard error', () => {
    expect(() => fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
          fields: [
            { name: 'amount', expression: expr('orders.amount') },
            { name: 'amount', expression: expr('orders.amount2') },
          ],
        }],
      }],
    })).toThrow(/duplicate field name 'amount'/);
  });

  test('duplicate metric names within a model are a hard error', () => {
    expect(() => fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
          fields: [{ name: 'amount', expression: expr('orders.amount') }] }],
        metrics: [
          { name: 'total', expression: expr('SUM(orders.amount)') },
          { name: 'total', expression: expr('AVG(orders.amount)') },
        ],
      }],
    })).toThrow(/duplicate metric name 'total'/);
  });

  test('duplicate relationship names within a model are a hard error', () => {
    expect(() => fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [
          { name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['o_id'],
            fields: [{ name: 'c_id', expression: expr('orders.c_id') }] },
          { name: 'customer', source: 'bigquery:p.d.customer', primary_key: ['c_id'],
            fields: [{ name: 'c_id', expression: expr('customer.c_id') }] },
        ],
        relationships: [
          { name: 'o2c', from: 'orders', to: 'customer', from_columns: ['c_id'], to_columns: ['c_id'] },
          { name: 'o2c', from: 'orders', to: 'customer', from_columns: ['c_id'], to_columns: ['c_id'] },
        ],
      }],
    })).toThrow(/duplicate relationship name 'o2c'/);
  });
});


describe('field label and time-dimension role align with the format models', () => {
  // Builds one field with the given extra props and returns its IR form.
  function field(props: Record<string, unknown>) {
    const { models } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'd', source: 'bigquery:p.d.d', primary_key: ['id'],
          fields: [{ name: 'f', expression: expr('d.f'), ...props }],
        }],
      }],
    });
    return models[0].entities[0].fields[0];
  }

  test('label is preserved structurally, separate from description', () => {
    const f = field({ label: 'Order Date', description: 'The order date' });
    expect(f.label).toBe('Order Date');
    expect(f.description).toBe('The order date');
  });

  test('a label alone is not mis-mapped into description', () => {
    const f = field({ label: 'Order Date' });
    expect(f.label).toBe('Order Date');
    expect(f.description).toBeUndefined();
  });

  test('an explicit is_time:true makes it a time dimension', () => {
    const f = field({ dimension: { is_time: true } });
    expect(f.dimension?.isTime).toBe(true);
    expect(isTimeDimension(f)).toBe(true);
  });

  test('an explicit is_time:false overrides a temporal datatype', () => {
    const f = field({ dimension: { is_time: false }, datatype: 'Date' });
    expect(f.dimension?.isTime).toBe(false);
    expect(isTimeDimension(f)).toBe(false);
  });

  test('a temporal datatype infers a time dimension when is_time is unset', () => {
    const f = field({ dimension: {}, datatype: 'Date' });
    expect(f.dimension?.isTime).toBeUndefined();
    expect(isTimeDimension(f)).toBe(true);
  });

  test('a temporal datatype with no dimension block is not a dimension', () => {
    const f = field({ datatype: 'Date' });
    expect(f.dimension).toBeUndefined();
    expect(isTimeDimension(f)).toBe(false);
  });

  test('a non-temporal datatype with an empty dimension is not a time dimension', () => {
    const f = field({ dimension: {}, datatype: 'String' });
    expect(isTimeDimension(f)).toBe(false);
  });
});


describe('authoring sugars: entities alias, bare-string expression, deployment_target', () => {
  const URI =
    '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';

  test("'entities:' is an alias for 'datasets:'", () => {
    const { models } = fromDocument({ version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        entities: [
          { name: 'a', source: 'bigquery:proj.ds.tbl', primary_key: ['id'],
            fields: [{ name: 'id', expression: expr('id') }] },
        ],
      }],
    });
    expect(models[0].entities.map(e => e.name)).toEqual(['a']);
    expect(models[0].entities[0].dataSource).toBe('proj.ds.tbl');
  });

  test("declaring both 'entities' and 'datasets' is an error", () => {
    expect(() => fromDocument({ version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        entities: [{ name: 'a', source: 'bigquery:p.d.s', fields: [] }],
        datasets: [{ name: 'b', source: 'bigquery:p.d.s', fields: [] }],
      }],
    })).toThrow(/set either 'entities' or 'datasets', not both/);
  });

  test('a bare-string expression expands to a one-entry ANSI_SQL list in 0.2.0.dev0/google and is rejected in 0.2.0.dev0', () => {
    const { models, warnings } = fromDocument({ version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'a', source: 'bigquery:proj.ds.tbl', primary_key: ['id'],
          fields: [{ name: 'id', expression: 'id_col' }],
        }],
      }],
    });
    const field = models[0].entities[0].fields[0];
    expect(field.expression).toBe('id_col');
    expect(field.stringForm).toBe(true);
    expect(field.dialects).toEqual([{ dialect: 'ANSI_SQL', expression: 'id_col' }]);
    expect(warnings.some(w => w.includes("no 'BIGQUERY' dialect"))).toBe(false);

    expect(() => fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'a', source: 'bigquery:proj.ds.tbl', primary_key: ['id'],
          fields: [{ name: 'id', expression: 'id_col' }],
        }],
      }],
    })).toThrow(/dialects:/);
  });

  test("a top-level 'deployment_target' is rejected with a migration pointer to 'deployments'", () => {
    expect(() => fromDocument({ version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm', deployment_target: URI,
        datasets: [{ name: 'a', source: 'bigquery:p.d.s', primary_key: ['id'],
          fields: [{ name: 'id', expression: 'id' }] }],
      }],
    })).toThrow("model 'm': 'deployment_target' is no longer supported; migrate to the named 'deployments' list");
  });

});

describe('a field is unbound exactly when it has no expression', () => {
  // Google flavor throughout: a plain vanilla document (no GOOGLE block) must
  // bind every field, so an unbound field is a Google-flavor feature.
  test('an unbound field loads with no expression', () => {
    // There is no separate flag: a field is unbound simply by carrying no
    // expression. This holds on either leg -- a graph leg does not reject an
    // unbound field; the availability pass drops it before generation.
    const { models } = fromDocument({ version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'a', source: 'bigquery:p.d.s', primary_key: ['id'],
          fields: [
            { name: 'id', expression: 'id' },
            { name: 'credit' },
          ],
        }],
      }],
    }, { bindingOptional: true });
    const [id, credit] = models[0].entities[0].fields;
    expect(id.expression).toBe('id');
    expect(credit.expression).toBeUndefined();
  });

  test('an expression-less field is not a load error under a graph leg', () => {
    // A missing expression is an unbound field, not a validation failure: the
    // availability pass prunes it (and any metric that reads it) before the
    // graph is generated, so one logical model can serve stores that lack a
    // given column.
    const { models } = fromDocument({ version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'a', source: 'bigquery:p.d.s', primary_key: ['id'],
          fields: [{ name: 'id', expression: 'id' }, { name: 'credit' }] }],
      }],
    });
    const credit = models[0].entities[0].fields.find(f => f.name === 'credit')!;
    expect(credit.expression).toBeUndefined();
  });
});


describe('a purely logical model loads only under bindingOptional', () => {
  // A logical-only model declares meaning (entities, fields, keys) with no
  // physical binding: no dataset `source`, no field `expression`. It is the
  // Knowledge-Catalog-only push case -- KC governs the logical layer and needs
  // no table or column to point at. Google flavor: a plain vanilla document
  // (no GOOGLE block) must bind both, whatever the push.
  const logicalOnly = {
    version: '0.2.0.dev0/google',
    semantic_model: [{
      name: 'm',
      datasets: [{
        name: 'orders', primary_key: ['id'],
        fields: [{ name: 'amount' }, { name: 'status' }],
      }],
    }],
  };

  test('under bindingOptional it loads with an empty source and unbound fields', () => {
    const { models } = fromDocument(logicalOnly, { bindingOptional: true });
    const orders = models[0].entities[0];
    // No source -> empty dataSource (the emitter tolerates this); the fields
    // carry no expression because there is no binding.
    expect(orders.dataSource).toBe('');
    expect(orders.keys).toEqual(['id']);
    expect(orders.fields.map(f => f.name)).toEqual(['amount', 'status']);
    expect(orders.fields.every(f => f.expression === undefined)).toBe(true);
  });

  test('without bindingOptional the same model fails for the missing source', () => {
    let message = '';
    try {
      fromDocument(logicalOnly);
    } catch (e: any) {
      message = String(e.message ?? e);
    }
    // A non-abstract dataset in a graph leg still requires a source. The
    // expression-less fields are unbound, not errors -- the availability pass
    // drops them -- so only the missing-source check fires here.
    expect(message).toContain("dataset 'orders': a non-abstract dataset requires a source");
    expect(message).not.toContain("requires an expression");
  });

  test('bindingOptional still rejects an abstract dataset that also names a source', () => {
    expect(() => fromDocument({ version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'Party', abstract: true, source: 'bigquery:p.d.party', fields: [] }],
      }],
    }, { bindingOptional: true })).toThrow(/an abstract dataset has no table/);
  });
});

// ---------------------------------------------------------------------------
// Flavor rules (b/567743138). The two document versions are two flavors of one
// format: '0.2.0.dev0' (vanilla Ossie, extensions only in custom_extensions)
// and '0.2.0.dev0/google' (native extension keys). The tests below pin what
// each flavor accepts and rejects, and what the IR records.
// ---------------------------------------------------------------------------

const VANILLA = '0.2.0.dev0';
const GOOGLE = '0.2.0.dev0/google';
const FLAVORS = [VANILLA, GOOGLE] as const;
type Level = 'model'|'dataset'|'field'|'relationship'|'metric';
const LEVELS: Level[] = ['model', 'dataset', 'field', 'relationship', 'metric'];

function load(version: string, model: object, opts = {}) {
  return fromDocument({ version, semantic_model: [model] }, opts);
}

// A small fully-bound model. `patch` is applied to the object at `level`, so a
// test can place one key (ai_context, custom_extensions, ...) exactly there.
function fullModel(level?: Level, patch: object = {}): any {
  const at = (l: Level) => (l === level ? patch : {});
  return {
    name: 'm', ...at('model'),
    datasets: [
      { name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'], ...at('dataset'),
        fields: [
          { name: 'id', expression: expr('id') },
          { name: 'customer_id', expression: expr('customer_id'), ...at('field') },
        ] },
      { name: 'customers', source: 'bigquery:p.d.customers', primary_key: ['id'], fields: [] },
    ],
    relationships: [{
      name: 'orders_to_customers', from: 'orders', to: 'customers',
      from_columns: ['customer_id'], to_columns: ['id'], ...at('relationship'),
    }],
    metrics: [{ name: 'order_count', expression: expr('COUNT(orders.id)'), ...at('metric') }],
  };
}

// The IR object a level maps to.
function irAt(m: any, level: Level): any {
  switch (level) {
    case 'model': return m;
    case 'dataset': return m.entities[0];
    case 'field': return m.entities[0].fields[1];
    case 'relationship': return m.relationships[0];
    case 'metric': return m.metrics[0];
  }
}

describe('a document holds exactly one semantic model', () => {
  test('one model loads', () => {
    for (const v of FLAVORS) expect(load(v, fullModel()).models).toHaveLength(1);
  });
  test('an empty semantic_model list is rejected', () => {
    expect(() => fromDocument({ version: VANILLA, semantic_model: [] }))
      .toThrow(/semantic_model/);
  });
});

describe('the declared version is preserved on the model', () => {
  for (const v of FLAVORS) {
    test(v, () => expect(load(v, fullModel()).models[0].version).toBe(v));
  }
});

describe('ai_context: custom members', () => {
  const expected = {
    instructions: 'Use for net revenue',
    synonyms: ['net_rev'],
    examples: ['What is net revenue?'],
    additionalProperties: { dbt_meta: { owner: 'analytics' }, priority: 3 },
  };

  test('the vanilla and Google worked examples load to the same AiContext', () => {
    const vanilla = loadModels(`
version: '0.2.0.dev0'
semantic_model:
  - name: m
    datasets:
      - name: orders
        source: bigquery:p.d.orders
        primary_key: [id]
        ai_context:
          instructions: Use for net revenue
          synonyms: [net_rev]
          examples: ["What is net revenue?"]
          dbt_meta: {owner: analytics}
          priority: 3
`);
    const google = loadModels(`
version: '0.2.0.dev0/google'
semantic_model:
  - name: m
    datasets:
      - name: orders
        source: bigquery:p.d.orders
        primary_key: [id]
        ai_context:
          instructions: Use for net revenue
          synonyms: [net_rev]
          examples: ["What is net revenue?"]
          custom:
            dbt_meta: {owner: analytics}
            priority: 3
`);
    expect(vanilla.models[0].entities[0].aiContext).toEqual(expected);
    expect(google.models[0].entities[0].aiContext).toEqual(expected);
  });

  test('custom members are carried at every level, in both flavors', () => {
    for (const level of LEVELS) {
      const v = load(VANILLA, fullModel(level, { ai_context: { k: 1 } })).models[0];
      const g = load(GOOGLE, fullModel(level, { ai_context: { custom: { k: 1 } } })).models[0];
      expect(irAt(v, level).aiContext).toEqual({ additionalProperties: { k: 1 } });
      expect(irAt(g, level).aiContext).toEqual({ additionalProperties: { k: 1 } });
    }
  });

  test('Google: a bare unknown key is still rejected', () => {
    expect(() => load(GOOGLE, fullModel('dataset', { ai_context: { synonym: ['x'] } })))
      .toThrow(/synonym/);
  });

  test("Google: 'custom' must be a mapping", () => {
    expect(() => load(GOOGLE, fullModel('dataset', { ai_context: { custom: ['x'] } })))
      .toThrow(/must be a mapping/);
  });

  test("Google: 'custom' cannot hold a standard member", () => {
    expect(() => load(GOOGLE,
      fullModel('dataset', { ai_context: { custom: { synonyms: ['x'] } } })))
      .toThrow(/cannot hold 'synonyms'/);
  });

  test("Google: member names are case-sensitive, so custom.Synonyms is custom", () => {
    const m = load(GOOGLE,
      fullModel('dataset', { ai_context: { custom: { Synonyms: ['x'] } } })).models[0];
    expect(m.entities[0].aiContext).toEqual({ additionalProperties: { Synonyms: ['x'] } });
  });

  test("vanilla: a sibling named 'custom' is a custom member like any other", () => {
    const m = load(VANILLA,
      fullModel('dataset', { ai_context: { custom: { a: 1 } } })).models[0];
    expect(m.entities[0].aiContext).toEqual({ additionalProperties: { custom: { a: 1 } } });
  });

  test("vanilla: 'Synonyms' is a custom member, not a synonym", () => {
    const m = load(VANILLA,
      fullModel('dataset', { ai_context: { Synonyms: ['x'] } })).models[0];
    expect(m.entities[0].aiContext).toEqual({ additionalProperties: { Synonyms: ['x'] } });
  });

  test('a non-string example is rejected, not dropped, in both flavors', () => {
    for (const v of FLAVORS) {
      expect(() => load(v, fullModel('dataset', { ai_context: { examples: ['ok', 3] } })))
        .toThrow(/examples/);
    }
  });

  test('YAML values with no JSON counterpart (!!timestamp, !!binary, !!set) stay text', () => {
    const { models } = loadModels(`
version: '0.2.0.dev0'
semantic_model:
  - name: m
    datasets:
      - name: orders
        source: bigquery:p.d.orders
        primary_key: [id]
        ai_context:
          reviewed: !!timestamp 2025-01-01
          blob: !!binary aGk=
          tags: !!set {a: null, b: null}
`);
    expect(models[0].entities[0].aiContext).toEqual({
      additionalProperties: {
        reviewed: '2025-01-01',
        blob: 'aGk=',
        tags: { a: null, b: null },
      },
    });
  });

  test('the string shorthand is instructions only', () => {
    for (const v of FLAVORS) {
      const m = load(v, fullModel('dataset', { ai_context: 'Use me' })).models[0];
      expect(m.entities[0].aiContext).toEqual({ instructions: 'Use me' });
    }
  });
});

describe('custom_extensions: where each vendor block is accepted', () => {
  const block = (vendor_name: string, data = '{}') => ({ vendor_name, data });

  test('a third-party block is carried at all five levels, in both flavors', () => {
    for (const v of FLAVORS) {
      for (const level of LEVELS) {
        const m = load(v, fullModel(level, { custom_extensions: [block('ACME', '{"a":1}')] }))
          .models[0];
        expect(irAt(m, level).customExtensions)
          .toEqual([{ vendorName: 'ACME', data: '{"a":1}' }]);
      }
    }
  });

  test('Google: a GOOGLE block is rejected at every level', () => {
    for (const level of LEVELS) {
      expect(() => load(GOOGLE, fullModel(level, { custom_extensions: [block('GOOGLE')] })))
        .toThrow(/'GOOGLE' custom_extensions block is not accepted/);
    }
  });

  // The format defines no field-level GOOGLE extension, so the message does not
  // send the author to a native key.
  test('Google: a GOOGLE block on a field says no field-level extension exists', () => {
    expect(() => load(GOOGLE, fullModel('field', { custom_extensions: [block('GOOGLE')] })))
      .toThrow(/not accepted on a field; the format defines no field-level GOOGLE extension/);
  });

  test('vanilla: a GOOGLE block is rejected on a field only', () => {
    for (const level of LEVELS) {
      const run = () => load(VANILLA, fullModel(level, { custom_extensions: [block('GOOGLE')] }));
      if (level === 'field') {
        expect(run).toThrow(/cannot carry a 'GOOGLE' custom_extensions block on a field/);
      } else {
        expect(irAt(run().models[0], level).customExtensions).toBeUndefined();
      }
    }
  });

  test("vendor names are case-sensitive: a 'Google' block is third-party", () => {
    for (const v of FLAVORS) {
      for (const level of LEVELS) {
        const m = load(v, fullModel(level, { custom_extensions: [block('Google')] })).models[0];
        expect(irAt(m, level).customExtensions).toEqual([{ vendorName: 'Google', data: '{}' }]);
      }
    }
  });

  test('several blocks from one vendor are kept in order', () => {
    const m = load(VANILLA, fullModel('field', {
      custom_extensions: [block('ACME', '{"n":1}'), block('ACME', '{"n":2}')],
    })).models[0];
    expect(irAt(m, 'field').customExtensions).toEqual([
      { vendorName: 'ACME', data: '{"n":1}' },
      { vendorName: 'ACME', data: '{"n":2}' },
    ]);
  });
});

describe('relationship description', () => {
  test('vanilla: a plain description is rejected, naming the GOOGLE-block form', () => {
    expect(() => load(VANILLA, fullModel('relationship', { description: 'd' })))
      .toThrow(/cannot carry a plain 'description'[\s\S]*vendor_name: GOOGLE/);
  });
  test('Google: a plain description loads', () => {
    const m = load(GOOGLE, fullModel('relationship', { description: 'd' })).models[0];
    expect(m.relationships[0].description).toBe('d');
  });
  test('vanilla: a description inside a GOOGLE block loads', () => {
    const m = load(VANILLA, fullModel('relationship', {
      custom_extensions: [{ vendor_name: 'GOOGLE', data: '{"description": "d"}' }],
    })).models[0];
    expect(m.relationships[0].description).toBe('d');
    expect(m.relationships[0].customExtensions).toBeUndefined();
  });
});

describe('metric entity anchor', () => {
  const countStar = (patch = {}) => fullModel('metric', { expression: expr('COUNT(*)'), ...patch });

  test('Google: an anchor sets entity and authoredEntity, with no warning', () => {
    const { models, warnings } = load(GOOGLE, countStar({ entity: 'orders' }));
    expect(models[0].metrics[0].entity).toBe('orders');
    expect(models[0].metrics[0].authoredEntity).toBe('orders');
    expect(warnings.some(w => w.includes('references no known entity'))).toBe(false);
  });
  test('vanilla: an anchor is rejected with a pointer to the alternatives', () => {
    expect(() => load(VANILLA, countStar({ entity: 'orders' })))
      .toThrow(/'entity' is a '0.2.0.dev0\/google' extension/);
    // A metric reads fields, never columns.
    expect(() => load(VANILLA, countStar({ entity: 'orders' })))
      .toThrow(/takes its entity from the fields it reads/);
  });
  test('without an anchor the entity is inferred, and authoredEntity is unset', () => {
    for (const v of FLAVORS) {
      const m = load(v, fullModel()).models[0];
      expect(m.metrics[0].entity).toBe('orders');
      expect(m.metrics[0].authoredEntity).toBeUndefined();
    }
  });
  test('COUNT(*) without an anchor still warns', () => {
    const { warnings } = load(GOOGLE, countStar());
    expect(warnings.some(w => w.includes('references no known entity'))).toBe(true);
  });
  test('an anchor naming an unknown dataset is rejected', () => {
    expect(() => load(GOOGLE, countStar({ entity: 'nope' })))
      .toThrow(/'entity' names 'nope', which is not a dataset in this model/);
  });
  test('infers metric entity from the leading qualifier of a struct path', () => {
    for (const exprText of [
           'COUNT(orders.shipping_address.city)',
           'COUNT(`orders`.`shipping_address`.city)',
           'COUNT(orders.`shipping_address`.city)',
         ]) {
      const yaml = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    datasets:
      - name: orders
        source: bigquery:p.d.orders
        primary_key: [o_id]
        fields:
          - { name: shipping_address, expression: orders.shipping_address }
      - name: shipping_address
        source: bigquery:p.d.shipping_address
        primary_key: [addr_id]
        fields:
          - { name: city, expression: shipping_address.city }
    metrics:
      - name: city_count
        expression: "${exprText}"
`;
      const { models, warnings } = loadModels(yaml);
      expect(models[0].metrics[0].entity).toBe('orders');
      expect(warnings).toEqual([]);
    }
  });
  test('does not mistake a function namespace like NET.HOST for an entity qualifier, infers entity across dialect entries, and warns with fix hint when an expression cannot be parsed', () => {
    const netYaml = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    datasets:
      - name: orders
        source: bigquery:p.d.orders
        primary_key: [o_id]
        fields:
          - { name: url, expression: orders.url }
          - { name: order_date, expression: orders.order_date }
          - { name: flags, expression: orders.flags }
      - name: NET
        source: bigquery:p.d.net
        primary_key: [n_id]
        fields:
          - { name: HOST, expression: NET.HOST }
    metrics:
      - name: host_count
        expression: "COUNT(DISTINCT NET.HOST(orders.url))"
      - name: multi_dialect_count
        expression:
          dialects:
            - { dialect: BIGQUERY, expression: "COUNT(*)" }
            - { dialect: SNOWFLAKE, expression: "COUNT(orders.url)" }
      - name: recent_count
        expression: 'COUNTIF(orders.order_date >= DATE "2024-01-01")'
      - name: flagged_sum
        expression: "SUM(orders.flags & 0x1)"
      - name: anchored_broken
        entity: orders
        expression: "SUM(orders.url"
      - name: inferred_from_other_dialect
        expression:
          dialects:
            - { dialect: BIGQUERY, expression: "COUNT(orders.url)" }
            - { dialect: SNOWFLAKE, expression: "SUM(orders.url" }
`;
    const netLoaded = loadModels(netYaml);
    expect(netLoaded.models[0].metrics.map(m => m.entity)).toEqual([
      'orders', 'orders', 'orders', 'orders', 'orders', 'orders',
    ]);
    expect(netLoaded.warnings).toEqual([]);

    const unparseable = load(GOOGLE, fullModel('metric', { expression: expr('SUM(orders.id') }));
    expect(unparseable.warnings).toContain(
        "metric 'order_count': expression could not be parsed; entity inference was " +
        "skipped (set 'entity' on the metric, or backtick-quote a reserved " +
        "qualifier, such as `Date`.amount)");
    expect(unparseable.warnings.some(w => w.includes('references no known entity'))).toBe(false);

    const vanillaUnparseable = load(VANILLA, fullModel('metric', { expression: expr('SUM(orders.id') }));
    expect(vanillaUnparseable.warnings).toContain(
        "metric 'order_count': expression could not be parsed; entity inference was " +
        "skipped (set 'entity' in a GOOGLE custom_extensions block on the metric, " +
        "or use version '0.2.0.dev0/google' and set 'entity' on the metric, or " +
        "backtick-quote a reserved qualifier, such as `Date`.amount)");
  });
});

describe('vanilla: GOOGLE blocks are read into the model', () => {
  const google = (data: object|string) => ({
    vendor_name: 'GOOGLE', data: typeof data === 'string' ? data : JSON.stringify(data),
  });
  const ACME = { vendor_name: 'ACME', data: '{"a":1}' };
  const G = '//bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/retail';
  const PROD = { name: 'prod', entities: [{ name: 'orders', source: 'bigquery:p.prod.orders' }] };
  const LABEL = {
    model: "model 'm'", dataset: "dataset 'orders'",
    relationship: "relationship 'orders_to_customers'", metric: "metric 'order_count'",
  } as const;
  const atLevel = (level: keyof typeof LABEL, ...blocks: object[]) =>
    fullModel(level, { custom_extensions: blocks });

  // fullModel, with `orders` extending a `base_order` that declares a field,
  // and each key at its own level either in a GOOGLE block beside a
  // third-party block or, in the Google flavor, natively.
  function retail(version: string): any {
    const m = fullModel();
    const vanilla = version === VANILLA;
    m.datasets.push({ name: 'base_order', source: 'bigquery:p.d.base_order', primary_key: ['id'],
      fields: [{ name: 'placed_at', expression: expr('placed_at') }] });
    const keys: [any, object][] = [
      [m, { deployments: [{ name: 'bq_prod', target: G }] }],
      [m.datasets[0], { extends: ['base_order'] }],
      [m.relationships[0], { description: 'who placed it' }],
      [m.metrics[0], { entity: 'orders' }],
    ];
    for (const [o, key] of keys) {
      if (vanilla) o.custom_extensions = [google(key), ACME];
      else Object.assign(o, key);
    }
    if (vanilla) m.custom_extensions[0] = google({ profiles: [PROD], deployments: [{ name: 'bq_prod', target: G }] });
    return m;
  }

  test('each key loads, its block is removed, and a third-party block stays', () => {
    const m = load(VANILLA, retail(VANILLA)).models[0];
    expect(m.profiles).toEqual([loadProfileFile(JSON.stringify(PROD), 'prod')]);
    expect(m.deployments).toEqual([{ name: 'bq_prod', target: G }]);
    expect(deploymentTargetUris(m)).toEqual([G]);
    expect(m.entities[0].extends).toEqual(['base_order']);
    expect(m.relationships[0].description).toBe('who placed it');
    expect(m.metrics[0].authoredEntity).toBe('orders');
    expect(m.metrics[0].entity).toBe('orders');
    // No folded `deploymentTargets` copy joins the model's blocks.
    for (const o of [m, m.entities[0], m.relationships[0], m.metrics[0]]) {
      expect(o.customExtensions).toEqual([{ vendorName: 'ACME', data: '{"a":1}' }]);
    }
  });

  test('the keys load as the Google flavor loads them, and extends is read before inheritance resolves', () => {
    const vanilla = load(VANILLA, retail(VANILLA)).models[0];
    const google = load(GOOGLE, retail(GOOGLE)).models[0];
    const withoutBlocks = (o: any) => { const { customExtensions, ...rest } = o; return rest; };
    for (const key of ['entities', 'relationships', 'metrics'] as const) {
      expect(vanilla[key].map(withoutBlocks)).toEqual(google[key].map(withoutBlocks));
    }
    expect(vanilla.deployments).toEqual(google.deployments);
    const fields = (m: any) => resolveInheritance(m).model.entities[0].fields.map((f: any) => f.name);
    expect(fields(vanilla)).toEqual(['id', 'customer_id', 'placed_at']);
    expect(fields(vanilla)).toEqual(fields(google));
  });

  test('data that is not a JSON object fails, naming the object', () => {
    for (const level of ['model', 'dataset', 'relationship', 'metric'] as const) {
      for (const data of ['{not json', '[]', '"x"', 'null']) {
        expect(() => load(VANILLA, atLevel(level, google(data)))).toThrow(
          `${LABEL[level]}: the 'data' of a GOOGLE custom_extensions block must be a JSON object.`);
      }
    }
  });

  test('a key the level does not take fails, naming the object', () => {
    const cases = [
      ['model', 'extends', "'profiles' and 'deployments'"],
      ['dataset', 'entity', "'extends'"],
      ['dataset', 'deploymentTargets', "'extends'"],
      ['relationship', 'deployments', "'description'"],
      ['metric', 'description', "'entity'"],
    ] as const;
    for (const [level, key, takes] of cases) {
      expect(() => load(VANILLA, atLevel(level, google({ [key]: 'x' })))).toThrow(
        `${LABEL[level]}: '${key}' is not a key a GOOGLE custom_extensions block takes on a ` +
        `${level}; it takes ${takes}.`);
    }
  });

  test('abstract fails, naming the dataset and the Google flavor', () => {
    expect(() => load(VANILLA, atLevel('dataset', google({ abstract: true })))).toThrow(
      "dataset 'orders': a GOOGLE custom_extensions block cannot declare 'abstract' in a " +
      "'0.2.0.dev0' document. An abstract dataset has no table, and every '0.2.0.dev0' " +
      "dataset needs a 'source'. A model that needs an abstract entity uses '0.2.0.dev0/google'.");
  });

  // An abstract dataset has no table, so it names no source and binds no
  // field. Its block is read before the bindings are checked.
  test('abstract on a dataset with no source and an unbound field fails the same way', () => {
    const m = fullModel();
    m.datasets[0].custom_extensions = [google({ extends: ['Party'] })];
    m.datasets.push({
      name: 'Party',
      custom_extensions: [google({ abstract: true })],
      fields: [{ name: 'id', datatype: 'String' }],
    });
    expect(() => load(VANILLA, m)).toThrow(
      "dataset 'Party': a GOOGLE custom_extensions block cannot declare 'abstract' in a " +
      "'0.2.0.dev0' document. An abstract dataset has no table, and every '0.2.0.dev0' " +
      "dataset needs a 'source'. A model that needs an abstract entity uses '0.2.0.dev0/google'.");
  });

  test('deploymentTargets that is not a list, or that two blocks set, fails', () => {
    const cases = [
      [google({ deploymentTargets: G }), 'expected array, received string'],
      [google({ deploymentTargets: null }), 'expected array, received null'],
    ] as const;
    for (const [block, problem] of cases) {
      expect(() => load(VANILLA, atLevel('model', block))).toThrow(
        "model 'm': 'deploymentTargets' in a GOOGLE custom_extensions block: " +
        `Invalid input: ${problem}`);
    }
    const twice = atLevel('model', google({ deploymentTargets: [G] }), google({ deploymentTargets: [G] }));
    expect(() => load(VANILLA, twice)).toThrow(
      "model 'm': two GOOGLE custom_extensions blocks both set 'deploymentTargets'; " +
      'set it in one block.');
  });

  test('a value the Google flavor rejects for the same key fails', () => {
    const cases = [
      ['model', { deployments: [{ name: 'a' }] }],
      ['model', { deployments: [{ name: 'a', target: G, extra: 1 }] }],
      ['dataset', { extends: 'base_order' }],
      ['relationship', { description: 5 }],
      ['metric', { entity: ['orders'] }],
    ] as const;
    for (const [level, data] of cases) {
      expect(() => load(VANILLA, atLevel(level, google(data)))).toThrow(
        `${LABEL[level]}: '${Object.keys(data)[0]}' in a GOOGLE custom_extensions block: `);
    }
    expect(() => load(VANILLA, atLevel('metric', google({ entity: 'nope' })))).toThrow(
      "metric 'order_count': 'entity' names 'nope', which is not a dataset in this model.");
    expect(() => load(VANILLA, atLevel('model', google({ deployments: [
      { name: 'a', target: G }, { name: 'b', target: G }] })))).toThrow(
      "deployments 'a' and 'b' target the same resource");
  });

  test('each profile is read as a profile file is, and two may not share a name', () => {
    const fileError = (text: string) => {
      try {
        loadProfileFile(text, 'prod');
      } catch (err: any) {
        return err.message;
      }
    };
    for (const profile of [{ name: 'prod', datasets: [] }, { name: 'prod', entities: 'orders' }]) {
      expect(() => load(VANILLA, atLevel('model', google({ profiles: [profile] })))).toThrow(
        `model 'm': ${fileError(JSON.stringify(profile))}`);
    }
    expect(() => load(VANILLA, atLevel('model', google({ profiles: PROD })))).toThrow(
      "model 'm': 'profiles' in a GOOGLE custom_extensions block must be a list.");
    expect(() => load(VANILLA, atLevel('model', google({ profiles: [{ entities: [] }] })))).toThrow(
      "model 'm': each profile in a GOOGLE custom_extensions block must be a mapping with a 'name'.");
    expect(() => load(VANILLA, atLevel('model', google({ profiles: [PROD, PROD] })))).toThrow(
      "model 'm': duplicate profile name 'prod'");
  });

  test('a profile name follows the rules the layout gives a profile file name', () => {
    const loadProfile = (name: string) => load(VANILLA, atLevel('model', google({ profiles: [{ name }] })));
    for (const name of ['', '1prod', 'a b', 'a/../b', 'x'.repeat(501)]) {
      expect(() => loadProfile(name)).toThrow(
        `model 'm': profile name '${name}' in a GOOGLE custom_extensions block is not valid; a ` +
        'profile name is a letter followed by up to 499 letters, digits, underscores and hyphens.');
    }
    for (const name of ['prod-eu_2', 'x'.repeat(500)]) {
      expect(loadProfile(name).models[0].profiles?.map(p => p.name)).toEqual([name]);
    }
    for (const name of ['default', 'Default']) {
      expect(() => loadProfile(name)).toThrow(
        `model 'm': a profile in a GOOGLE custom_extensions block may not be named '${name}'; ` +
        "'default' names the model's inline bindings.");
    }
    expect(() => load(VANILLA, atLevel('model', google({ profiles: [{ name: 'Prod' }, { name: 'prod' }] }))))
      .toThrow("model 'm': profiles 'Prod' and 'prod' in a GOOGLE custom_extensions block name the " +
        'same profile; profile names are unique ignoring case.');
  });

  test("a profile that sets 'version' or 'semantic_model' is told so without mention of a file", () => {
    for (const key of ['version', 'semantic_model']) {
      expect(() => load(VANILLA, atLevel('model', google({ profiles: [{ name: 'prod', [key]: VANILLA }] }))))
        .toThrow(`model 'm': profile 'prod' in a GOOGLE custom_extensions block sets '${key}', which a ` +
          'profile may not set.');
    }
  });

  test('a key two GOOGLE blocks on one object both set fails, naming the key', () => {
    expect(() => load(VANILLA, atLevel('metric', google({ entity: 'orders' }), google({ entity: 'orders' }))))
      .toThrow("metric 'order_count': two GOOGLE custom_extensions blocks both set 'entity'; set it " +
        'in one block.');
    expect(() => load(VANILLA, atLevel('dataset', google({ extends: ['customers'] }), google({ extends: ['customers'] }))))
      .toThrow("dataset 'orders': two GOOGLE custom_extensions blocks both set 'extends'; set it in " +
        'one block, listing every parent there.');
  });

  test('a key one GOOGLE block sets twice fails, as a repeated YAML key does', () => {
    expect(() => load(VANILLA, atLevel('metric', google('{"entity": "nope", "entity": "orders"}'))))
      .toThrow("metric 'order_count': the 'data' of a GOOGLE custom_extensions block sets a key " +
        'twice; set each key once.');
    expect(() => load(VANILLA, atLevel('model', google('{"profiles": [{"name": "prod", "name": "dev"}]}'))))
      .toThrow("model 'm': the 'data' of a GOOGLE custom_extensions block sets a key twice");
  });

  test('a value error is reported on one line', () => {
    expect(() => load(VANILLA, atLevel('model', google({ deployments: null })))).toThrow(
      "model 'm': 'deployments' in a GOOGLE custom_extensions block: Invalid input: expected array, " +
      'received null');
  });

  test('deploymentTargets stays in its block on the model, and deployments beside it fail', () => {
    const targets = google({ deploymentTargets: [G] });
    const m = load(VANILLA, atLevel('model', targets)).models[0];
    expect(m.customExtensions).toEqual([{ vendorName: 'GOOGLE', data: targets.data }]);
    expect(m.deployments).toBeUndefined();
    expect(deploymentTargetUris(m)).toEqual([G]);
    const deployments = { deployments: [{ name: 'a', target: G }] };
    for (const blocks of [[google({ deploymentTargets: [G], ...deployments })], [targets, google(deployments)]]) {
      expect(() => load(VANILLA, atLevel('model', ...blocks))).toThrow(
        "model 'm': set either 'deployments' or 'deploymentTargets' in its GOOGLE custom_extensions blocks, not both.");
    }
  });

  test("a metric's block entity fills authoredEntity and entity, so COUNT(*) gives no warning", () => {
    const { models, warnings } = load(VANILLA, fullModel('metric', {
      expression: expr('COUNT(*)'), custom_extensions: [google({ entity: 'orders' })],
    }));
    expect(models[0].metrics[0].authoredEntity).toBe('orders');
    expect(models[0].metrics[0].entity).toBe('orders');
    expect(warnings.some(w => w.includes('references no known entity'))).toBe(false);
  });

  test("the native anchor error offers the GOOGLE block", () => {
    expect(() => load(VANILLA, fullModel('metric', { entity: 'orders' }))).toThrow(
      "To anchor it explicitly, set 'entity' in a GOOGLE custom_extensions block on the " +
      "metric, or set the document version to '0.2.0.dev0/google'.");
  });

  test("a 'Google' block is a third-party block: neither read nor removed", () => {
    const block = { vendor_name: 'Google', data: '{"entity": "nope", "abstract": true}' };
    for (const level of ['dataset', 'metric'] as const) {
      const m = load(VANILLA, atLevel(level, block)).models[0];
      expect(irAt(m, level).customExtensions).toEqual([{ vendorName: 'Google', data: block.data }]);
      expect(m.metrics[0].authoredEntity).toBeUndefined();
    }
  });

  test('a block profile, a block extends and a block anchor get the checks for an expression with no SQL', () => {
    // A block profile's binding is rejected as a profile file's is.
    for (const expression of ['  ', '-- todo', 'orders.']) {
      const profile = { name: 'prod', entities: [{ name: 'orders', fields: [{ name: 'customer_id', expression }] }] };
      let fileError = '';
      try {
        loadProfileFile(JSON.stringify(profile), 'prod');
      } catch (err: any) {
        fileError = err.message;
      }
      expect(fileError).toContain("write the field's SQL");
      expect(() => load(VANILLA, atLevel('model', google({ profiles: [profile] })))).toThrow(
        `model 'm': ${fileError}`);
    }
    // An inherited field is checked on the entity that extends its parent in a
    // block, as it is with a native extends.
    for (const version of [VANILLA, GOOGLE]) {
      const m = retail(version);
      m.datasets[2].fields[0].expression = expr('base_order.orders.');
      expect(() => load(version, m)).toThrow(
        "model 'm': entity 'orders' inherits field 'placed_at': read on 'orders', the BIGQUERY entry of " +
        "'expression' is only the qualifier 'orders.'; write the field's SQL");
    }
    // A metric anchored in its block still needs SQL.
    expect(() => load(VANILLA, fullModel('metric', {
      expression: expr(' '), custom_extensions: [google({ entity: 'orders' })],
    }))).toThrow("metric 'order_count': the BIGQUERY entry of 'expression' is blank; write the metric's SQL");
  });

  test('profiles from the block get the checks profile files get', () => {
    const join = { name: 'orders_to_customers', from_columns: ['customer_id'], to_columns: ['id'] };
    const prod = { name: 'prod', relationships: [join], entities: [
      { name: 'orders', source: 'bigquery:p.prod.orders' },
      { name: 'customers', source: 'bigquery:p.prod.customers' }] };
    const dev = { name: 'dev', relationships: [{ ...join, to_columns: undefined }] };
    const vanilla = load(VANILLA, atLevel('model', google({ profiles: [prod, dev] }))).models[0];
    const google_ = load(GOOGLE, fullModel()).models[0];
    const files = [prod, dev].map(p => loadProfileFile(JSON.stringify(p), p.name));
    expect(vanilla.profiles).toEqual(files);
    const checks = (m: any, specs: any[]) =>
      [...specs.map(p => validateProfileCompleteness(m, p)), validateProfileConsistency(m, specs)];
    expect(checks(vanilla, vanilla.profiles!)).toEqual(checks(google_, files));
    expect(validateProfileCompleteness(vanilla, vanilla.profiles![0])).toEqual([]);
    expect(validateProfileCompleteness(vanilla, vanilla.profiles![1])).not.toEqual([]);
  });

  test('googleBlockProfiles reads the profiles without loading the rest of the model', () => {
    const doc = (version: string, model: object) => JSON.stringify({ version, semantic_model: [model] });
    const unloadable = doc(VANILLA, { name: 'm', custom_extensions: [google({ profiles: [PROD] })], datasets: [] });
    expect(() => loadModels(unloadable)).toThrow();
    expect(googleBlockProfiles(unloadable)).toEqual([loadProfileFile(JSON.stringify(PROD), 'prod')]);
    expect(googleBlockProfiles(doc(GOOGLE, fullModel()))).toEqual([]);
    // Text whose version cannot be read may be a vanilla model.
    expect(() => googleBlockProfiles('{not yaml')).toThrow(
      'Semantic model load error: could not parse input: ');
    expect(() => googleBlockProfiles(doc(VANILLA, { name: 'm', custom_extensions: [google('[]')] })))
      .toThrow("model 'm': the 'data' of a GOOGLE custom_extensions block must be a JSON object.");
  });

  test('googleBlockProfiles skips a block the load rejects for its shape', () => {
    const beside = (block: object) => JSON.stringify({ version: VANILLA, semantic_model: [
      fullModel('model', { custom_extensions: [google({ profiles: [PROD] }), block] })] });
    for (const block of [
      { vendor_name: 'GOOGLE', data: 123 },
      { ...google({}), note: 'x' },
      { vendor_name: 'GOOGLE', data: { entity: 'orders' } },
      { vendor_name: 'ACME', data: 123 },
    ]) {
      expect(() => loadModels(beside(block))).toThrow('custom_extensions');
      expect(googleBlockProfiles(beside(block)).map(p => p.name)).toEqual(['prod']);
    }
  });

  test('googleBlockProfiles reads the profiles in a GOOGLE block whose shape the load rejects', () => {
    const doc = (exts: unknown) => JSON.stringify({ version: VANILLA, semantic_model: [
      fullModel('model', { custom_extensions: exts })] });
    for (const exts of [
      [{ vendor_name: 'GOOGLE', data: { profiles: [PROD] } }],
      [{ ...google({ profiles: [PROD] }), note: 'x' }],
      google({ profiles: [PROD] }),
      [{ vendor_name: 'GOOGLE', profiles: [PROD] }],
      [{ vendor_name: 'GOOGLE', data: null, profiles: [PROD] }],
    ]) {
      expect(() => loadModels(doc(exts))).toThrow('custom_extensions');
      expect(googleBlockProfiles(doc(exts)).map(p => p.name)).toEqual(['prod']);
    }
  });

  // As a profile file is found beside a model file the load rejects, a key
  // other than `profiles` that the load rejects does not hide the profiles.
  test('googleBlockProfiles reads only the profiles of a GOOGLE block whose shape the load accepts', () => {
    const doc = (exts: object[]) => JSON.stringify({ version: VANILLA, semantic_model: [
      fullModel('model', { custom_extensions: exts })] });
    for (const exts of [
      [google({ profiles: [PROD], deployments: [{ name: 'main' }] })],
      [google({ profiles: [PROD] }), google({ deployments: [{ name: 'main' }] })],
      [google({ profiles: [PROD], bogus: 1 })],
      [google({ profiles: [PROD], deploymentTargets: [G], deployments: [] })],
      [google({ profiles: [PROD] }), google('{"deployments": [{"name": "a", "name": "b"}]}')],
      [google(`{"x": 1, "profiles": ${JSON.stringify([PROD])}, "x": 2}`)],
    ]) {
      expect(() => loadModels(doc(exts))).toThrow("model 'm'");
      expect(googleBlockProfiles(doc(exts)).map(p => p.name)).toEqual(['prod']);
    }
  });

  test('googleBlockProfiles rejects data that sets profiles twice or a key twice inside them, whatever the shape of its block', () => {
    const doc = (block: object) => JSON.stringify({ version: VANILLA, semantic_model: [
      fullModel('model', { custom_extensions: [block] })] });
    for (const data of [
      `{"profiles": ${JSON.stringify([PROD])}, "profiles": []}`,
      `{"profiles": [{"name": "prod", "name": "dev"}]}`,
    ]) {
      for (const block of [google(data), { ...google(data), note: 'x' }]) {
        expect(() => googleBlockProfiles(doc(block))).toThrow(
          "model 'm': the 'data' of a GOOGLE custom_extensions block sets a key twice");
      }
    }
  });

  test('googleBlockProfiles reads past a YAML error elsewhere in the text', () => {
    const text = (extra: string) => `version: "${VANILLA}"
semantic_model:
  - name: m
${extra}    custom_extensions:
      - vendor_name: GOOGLE
        data: '${JSON.stringify({ profiles: [PROD] })}'
`;
    for (const [extra, problem] of [
      ['    description: a\n    description: b\n', 'Map keys must be unique'],
      ['    description: *nope\n', 'Unresolved alias'],
    ]) {
      expect(() => loadModels(text(extra))).toThrow(problem);
      expect(googleBlockProfiles(text(extra)).map(p => p.name)).toEqual(['prod']);
    }
  });

  // Which of the two values holds the profiles is not known.
  test('googleBlockProfiles reports the YAML error for a document that sets semantic_model twice', () => {
    const model = (exts: object[]) => JSON.stringify([{ name: 'm', custom_extensions: exts }]);
    const text = (first: object[], second: object[]) =>
      `version: "${VANILLA}"\nsemantic_model: ${model(first)}\nsemantic_model: ${model(second)}\n`;
    const block = google({ profiles: [PROD] });
    for (const [first, second] of [[[block], []], [[], [block]]]) {
      expect(() => loadModels(text(first, second))).toThrow('Map keys must be unique');
      expect(() => googleBlockProfiles(text(first, second))).toThrow(
        'Semantic model load error: could not parse input: Map keys must be unique');
    }
  });

  test('googleBlockProfiles reports the YAML error for a model that sets custom_extensions twice', () => {
    const text = (first: object, second: object) => `version: "${VANILLA}"
semantic_model:
  - name: m
    custom_extensions: ${JSON.stringify([first])}
    custom_extensions: ${JSON.stringify([second])}
`;
    const block = google({ profiles: [PROD] });
    for (const [first, second] of [[block, ACME], [ACME, block]]) {
      expect(() => loadModels(text(first, second))).toThrow('Map keys must be unique');
      expect(() => googleBlockProfiles(text(first, second))).toThrow(
        'Semantic model load error: could not parse input: Map keys must be unique');
    }
  });

  test('googleBlockProfiles reads only the profiles of each block in text with a YAML error', () => {
    const text = `version: "${VANILLA}"
semantic_model:
  - name: m
    description: a
    description: b
    custom_extensions:
      - vendor_name: GOOGLE
        data: '${JSON.stringify({ profiles: [PROD], bogus: 1 })}'
`;
    expect(() => loadModels(text)).toThrow('Map keys must be unique');
    expect(googleBlockProfiles(text).map(p => p.name)).toEqual(['prod']);
  });

  test('googleBlockProfiles reports the YAML error when it cuts the GOOGLE block short', () => {
    const text = `version: "${VANILLA}"
semantic_model:
  - name: m
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"profiles": [
    datasets: [
`;
    expect(() => loadModels(text)).toThrow('could not parse input');
    expect(() => googleBlockProfiles(text)).toThrow(
      'Semantic model load error: could not parse input: ');
  });

  describe('googleBlockProfiles in text that is not valid YAML', () => {
    const data = (v: object) => `'${JSON.stringify(v)}'`;
    const blockYaml = (d: string) => `      - vendor_name: GOOGLE\n        data: ${d}\n`;
    const PROD_BLOCK = blockYaml(data({ profiles: [PROD] }));
    const section = (exts: string, extra = '') =>
      `  - name: m\n${extra}    custom_extensions:\n${exts}`;
    const vanilla = (exts: string, extra = '') =>
      `version: "${VANILLA}"\nsemantic_model:\n${section(exts, extra)}`;
    const names = (text: string) => googleBlockProfiles(text).map(p => p.name);
    // A key set twice on the path to the blocks leaves the reading ambiguous.
    const ambiguous: [string, string, string][] = [
      ['a repeated semantic_model section',
        `version: "${VANILLA}"\nsemantic_model:\n${section(PROD_BLOCK)}semantic_model:\n${section(PROD_BLOCK)}`,
        'Map keys must be unique'],
      ['a document written twice', vanilla(PROD_BLOCK).repeat(2), 'Map keys must be unique'],
      ['a repeated custom_extensions section',
        vanilla(`${PROD_BLOCK}    custom_extensions:\n${PROD_BLOCK}`), 'Map keys must be unique'],
      ['a later semantic_model that is empty', `${vanilla(PROD_BLOCK)}semantic_model: []\n`,
        'Map keys must be unique'],
      ['a block that sets data twice, the profiles in the first',
        vanilla(`${PROD_BLOCK}        data: '{}'\n`), 'Map keys must be unique'],
    ];
    for (const [what, text, problem] of ambiguous) {
      test(`reports the YAML error past ${what}`, () => {
        expect(() => loadModels(text)).toThrow(problem);
        expect(() => googleBlockProfiles(text)).toThrow(
          `Semantic model load error: could not parse input: ${problem}`);
      });
    }

    // A YAML error away from the blocks leaves them one reading.
    const cases: [string, string, string][] = [
      ['an alias whose anchor is not set, beside a key the block may not set',
        vanilla(blockYaml(data({ profiles: [PROD], bogus: 1 })), '    description: *nope\n'),
        'Unresolved alias'],
      ['a key set twice, beside data that sets another key twice',
        vanilla(blockYaml(`'{"profiles": ${JSON.stringify([PROD])}, "x": 1, "x": 2}'`),
          '    description: a\n    description: b\n'),
        'Map keys must be unique'],
    ];
    for (const [what, text, problem] of cases) {
      test(`finds the profile past ${what}`, () => {
        expect(() => loadModels(text)).toThrow(problem);
        expect(names(text)).toEqual(['prod']);
      });
    }

    // Each text sets `description` twice, so it is not valid YAML. An alias or
    // a merge key on the path to the blocks leaves the reading ambiguous.
    const aliasedKeys: [string, string][] = [
      ['a data key written as an alias', `version: "${VANILLA}"
semantic_model:
  - name: m
    label: &k data
    description: a
    description: b
    custom_extensions:
      - vendor_name: GOOGLE
        *k : ${data({ profiles: [PROD] })}
`],
      ['a custom_extensions key written as an alias', `version: "${VANILLA}"
semantic_model:
  - name: m
    label: &k custom_extensions
    description: a
    description: b
    *k :
${PROD_BLOCK}`],
      ['a block that takes its data from a merge key', `%YAML 1.1
---
base: &base
  vendor_name: GOOGLE
  data: ${data({ profiles: [PROD] })}
version: "${VANILLA}"
semantic_model:
  - name: m
    description: a
    description: b
    custom_extensions:
      - <<: *base
`],
    ];
    for (const [what, text] of aliasedKeys) {
      test(`reports the YAML error past ${what}`, () => {
        expect(() => loadModels(text)).toThrow('could not parse input');
        expect(() => googleBlockProfiles(text)).toThrow(
          'Semantic model load error: could not parse input: Map keys must be unique');
      });
    }

    // Past a YAML error, merge keys on the path give the YAML error too,
    // whether or not the block's own `data` would win over the merged one.
    test('reports the YAML error for YAML 1.1 merge keys past a YAML error', () => {
      const merged = (model: string) => `%YAML 1.1
---
base: &base
  custom_extensions:
    - vendor_name: GOOGLE
      data: ${data({ profiles: [PROD] })}
data: &data
  data: ${data({ profiles: [PROD] })}
version: "${VANILLA}"
semantic_model:
  - name: m
    description: a
    description: b
${model}`;
      for (const model of [
        '    <<: *base\n',
        `    custom_extensions:\n      - vendor_name: GOOGLE\n        <<: *data\n        data: '{}'\n`,
      ]) {
        expect(() => googleBlockProfiles(merged(model))).toThrow(
          'Semantic model load error: could not parse input: Map keys must be unique');
      }
    });

    // A block the load would reject, such as two that both set `profiles`, is
    // reported as the YAML error.
    test('reports the YAML error for blocks a load rejects', () => {
      const named = (name: string) => blockYaml(data({ profiles: [{ ...PROD, name }] }));
      for (const blocks of [named('Prod') + named('prod'), named('default')]) {
        const text = vanilla(blocks, '    description: a\n    description: b\n');
        expect(() => loadModels(text)).toThrow('Map keys must be unique');
        expect(() => googleBlockProfiles(text)).toThrow(
          'Semantic model load error: could not parse input: Map keys must be unique');
      }
    });

    // The YAML error may have cut the block short or moved a line in it.
    test('reports the YAML error when the error falls inside custom_extensions', () => {
      const profile = (indent: string, name: string) =>
        `${indent}- name: ${name}\n${indent}  entities: [{name: orders, source: "bigquery:p.${name}.orders"}]\n`;
      const block = (indent: string) => '      - vendor_name: GOOGLE\n        data:\n          profiles:\n' +
        profile('            ', 'prod') + profile(indent, 'dev');
      expect(names(vanilla(block('            ')))).toEqual(['prod', 'dev']);
      expect(() => loadModels(vanilla(block('           ')))).toThrow('could not parse input');
      expect(() => googleBlockProfiles(vanilla(block('           ')))).toThrow(
        'Semantic model load error: could not parse input: ');
    });

    // The yaml library expands at most 100 aliases.
    // A Google-flavor model gives no profiles, so its profile files stay listed.
    test('reports the YAML error for a vanilla model with more aliases than a load expands', () => {
      for (const version of [VANILLA, GOOGLE]) {
        const text = `version: "${version}"\nx: &a 1\nys:\n${'  - *a\n'.repeat(101)}` +
          `semantic_model:\n${section(PROD_BLOCK)}`;
        expect(() => loadModels(text)).toThrow('could not parse input: Excessive alias count');
        if (version === VANILLA) {
          expect(() => googleBlockProfiles(text)).toThrow(
            'Semantic model load error: could not parse input: Excessive alias count');
        } else {
          expect(googleBlockProfiles(text)).toEqual([]);
        }
      }
    });

    // A YAML error other than a key set twice can move custom_extensions out
    // of the model, or cut it short where it ends.
    test('reports the YAML error when an error may move or cut the blocks', () => {
      const head = `version: "${VANILLA}"\nsemantic_model:\n  - name: m\n`;
      const exts = `    custom_extensions:\n${PROD_BLOCK}`;
      const acme = '    custom_extensions:\n      - vendor_name: ACME\n        data: x\n';
      for (const [broken, fixed] of [
        [head + '   description: x\n' + exts, head + '    description: x\n' + exts],
        [head + '    label: y\n     description: x\n' + exts, head + '    label: y\n    description: x\n' + exts],
        [head + '\tdescription: x\n' + exts, head + '    description: x\n' + exts],
        [head + '    description: x\n    oops\n' + exts, head + '    description: x\n' + exts],
        [head + '    description: |\n  bad\n' + exts, head + '    description: |\n      bad\n' + exts],
        [head + exts.replace('custom_extensions:\n', 'custom_extensions:'), head + exts],
        [head + '    custom_extensions:\n      - vendor_name: ACME\n\t        data: x\n' + PROD_BLOCK,
          head + '    custom_extensions:\n      - vendor_name: ACME\n        data: x\n' + PROD_BLOCK],
        [head + acme.replace('        data', '    \t    data') + PROD_BLOCK, head + acme + PROD_BLOCK],
        [head + acme + "    '" + PROD_BLOCK.slice(4), head + acme + PROD_BLOCK],
        [head + acme.replace('      - vendor_name: ACME', '  - vendor_name: ACME') + PROD_BLOCK, head + acme + PROD_BLOCK],
        [head + exts + '    description: [x\n', head + exts + '    description: x\n'],
      ]) {
        expect(names(fixed)).toEqual(['prod']);
        expect(() => loadModels(broken)).toThrow('could not parse input');
        expect(() => googleBlockProfiles(broken)).toThrow(
          'Semantic model load error: could not parse input: ');
      }
    });

    // A key set twice, or an alias whose anchor is not set, cannot cut the
    // blocks short, so it does not hide them wherever it is.
    test('finds the profile past a key set twice or an unset alias after the blocks', () => {
      const text = (extra: string) =>
        `version: "${VANILLA}"\nsemantic_model:\n  - name: m\n    custom_extensions:\n${PROD_BLOCK}${extra}`;
      for (const extra of ['    description: a\n    description: b\n', '    description: *nope\n']) {
        expect(() => loadModels(text(extra))).toThrow('could not parse input');
        expect(names(text(extra))).toEqual(['prod']);
      }
    });

    // A version set twice or written as an alias cannot be read past the
    // error, whichever version it names.
    test('reports the YAML error for a document with more aliases than a load expands whose version cannot be read', () => {
      const aliases = `x: &a 1\nys:\n${'  - *a\n'.repeat(101)}`;
      const rest = `semantic_model:\n${section(PROD_BLOCK)}`;
      for (const head of [
        `version: "${GOOGLE}"\nversion: "${VANILLA}"\n`,
        `version: "${VANILLA}"\nversion: "${GOOGLE}"\n`,
        `v: &v "${VANILLA}"\nversion: *v\n`,
        `v: &v "${GOOGLE}"\nversion: *v\n`,
      ]) {
        expect(() => googleBlockProfiles(head + aliases + rest)).toThrow(
          'Semantic model load error: could not parse input: ');
      }
    });

    // Only a key set twice leaves the text's structure as written. Any other
    // YAML error can move the blocks, cut them short or change the version.
    test('reports the YAML error past any YAML error other than a key set twice', () => {
      const head = `version: "${VANILLA}"\nsemantic_model:\n  - name: m\n`;
      const exts = `    custom_extensions:\n${PROD_BLOCK}`;
      const dataset = '    datasets:\n      - name: d1\n';
      for (const [broken, fixed, profiles] of [
        // A syntax error ahead of the blocks.
        [head + '    description: [x\n' + exts, head + '    description: [x]\n' + exts, ['prod']],
        // A bad indent ahead of the blocks that moves a second model's blocks
        // onto the first model.
        [head + dataset + '       - name: m2\n' + exts, head + dataset + '  - name: m2\n' + exts, []],
        // A tab ahead of the first block, so a GOOGLE block may be the data of
        // a third-party block or a block of its own.
        [head + '    custom_extensions:\n    \t-\n        vendor_name: ACME\n        data:\n' +
            PROD_BLOCK.replace(/^ {6}/gm, '        '),
          head + '    custom_extensions:\n      -\n        vendor_name: ACME\n        data:\n' +
            PROD_BLOCK.replace(/^ {6}/gm, '        '), []],
        // custom_extensions left with no value, beside an earlier bad indent.
        [head + dataset + '        source: bigquery:p.d.t\n       primary_key: [id]\n' +
            '    custom_extensions:\n' + PROD_BLOCK.replace(/^ {6}/gm, '  '),
          head + dataset + '        source: bigquery:p.d.t\n        primary_key: [id]\n' +
            '    custom_extensions:\n' + PROD_BLOCK.replace(/^ {6}/gm, '  '), []],
        // A second document.
        [head + exts + '---\nx: 1\n', head + exts, ['prod']],
      ] as [string, string, string[]][]) {
        expect(names(fixed)).toEqual(profiles);
        expect(() => loadModels(broken)).toThrow('could not parse input');
        expect(() => googleBlockProfiles(broken)).toThrow(
          'Semantic model load error: could not parse input: ');
      }
    });

    // A YAML error at the root can change the version the text seems to set,
    // so the document may be vanilla whatever the version reads as.
    test('reports the YAML error when an error may change the version', () => {
      const rest = `semantic_model:\n${section(PROD_BLOCK)}`;
      for (const [broken, fixed] of [
        [`version: ${VANILLA}\n  bad: 1\n${rest}`, `version: ${VANILLA}\nbad: 1\n${rest}`],
        [`version: "${VANILLA}\n${rest}`, `version: "${VANILLA}"\n${rest}`],
        [`bad: 1\n version: "${VANILLA}"\n${rest}`, `bad: 1\nversion: "${VANILLA}"\n${rest}`],
        [`bad\nversion: "${VANILLA}"\n${rest}`, `version: "${VANILLA}"\n${rest}`],
        // A quote left open on the version and closed on the next line, or on
        // the same line.
        [`version: "${VANILLA}\n  label: "\nx: "\n${rest}`,
          `version: "${VANILLA}"\nlabel: ""\nx: ""\n${rest}`],
        [`version: "${VANILLA} # "\nlabel: "\n${rest}`,
          `version: "${VANILLA}" # "\nlabel: ""\n${rest}`],
        // A quote left open ahead of the version takes in a first version.
        [`label: "\n  version: '${VANILLA}'\n  note: "\nversion: "${GOOGLE}"\nx: "\n${rest}`,
          `label: ""\nversion: '${VANILLA}'\nnote: |\n  version: "${GOOGLE}"\n  x: "\n${rest}`],
      ]) {
        expect(names(fixed)).toEqual(['prod']);
        expect(() => loadModels(broken)).toThrow('could not parse input');
        expect(() => googleBlockProfiles(broken)).toThrow(
          'Semantic model load error: could not parse input: ');
      }
    });

    // A YAML error after the version may hide a second version, so which one
    // holds is not known.
    test('reports the YAML error when an error may hide a second version', () => {
      const rest = `semantic_model:\n${section(PROD_BLOCK)}`;
      for (const text of [
        `version: "${GOOGLE}"\nlabel: [x,\n${rest}version: "${VANILLA}"\n`,
        `version: "${GOOGLE}"\n${rest}---\nversion: "${VANILLA}"\n${rest}`,
        `meta:\nversion: "${GOOGLE}"\n${rest}   version: "${VANILLA}"\n`,
        `version: "${GOOGLE}"\nlabel: [{x: 1}"version": "${VANILLA}"\n${rest}`,
        `meta:\nversion: "${GOOGLE}"\n${rest}   ? version # comment\n   : "${VANILLA}"\n`,
      ]) {
        expect(() => loadModels(text)).toThrow('could not parse input');
        expect(() => googleBlockProfiles(text)).toThrow(
          'Semantic model load error: could not parse input: ');
      }
    });

    // A key written with no value sets it to null, as in text that parses.
    test('reads past a key set twice beside a key written with no value', () => {
      const dup = '    description: a\n    description: b\n';
      expect(names(vanilla(
        `      - { vendor_name: GOOGLE, data, profiles: ${JSON.stringify([PROD])} }\n`, dup)))
        .toEqual(['prod']);
      const noExts = `version: "${VANILLA}"\nsemantic_model:\n` +
        '  - { name: m, description: a, description: b, custom_extensions }\n';
      expect(() => loadModels(noExts)).toThrow('Map keys must be unique');
      expect(names(noExts)).toEqual([]);
    });

    // A YAML error after the version leaves it as written, so a Google-flavor
    // model gives none and its profile files stay listed.
    test('gives none for a Google-flavor model past a YAML error after its version', () => {
      for (const extra of ['    description: [x\n', '    description: a\n    description: b\n']) {
        for (const head of ['', '# A model.\n\n']) {
          const text = `${head}version: "${GOOGLE}"\nsemantic_model:\n  - name: m\n${extra}`;
          expect(() => loadModels(text)).toThrow('could not parse input');
          expect(googleBlockProfiles(text)).toEqual([]);
        }
      }
    });

    // The checks on the path apply to mappings. A block that is not a mapping
    // cannot become a GOOGLE block when a key set twice is fixed. A root key
    // that is not a string leaves the version unread, in either flavor.
    test('reads past a block that is not a mapping, and not past a root key that is not a string', () => {
      const dup = '    description: a\n    description: b\n';
      expect(names(vanilla(`      - just text\n${PROD_BLOCK}`, dup))).toEqual(['prod']);
      for (const version of [VANILLA, GOOGLE]) {
        const text = `version: "${version}"\n2024: launch\nsemantic_model:\n${section(PROD_BLOCK, dup)}`;
        expect(() => googleBlockProfiles(text)).toThrow(
          'Semantic model load error: could not parse input: Map keys must be unique');
      }
    });

    // An alias in a GOOGLE block may name an anchor set on a key set twice,
    // and its value then depends on which key the fix keeps.
    test('reports the YAML error when a GOOGLE block holds an alias', () => {
      const DEV = { ...PROD, name: 'dev' };
      const anchors = `p: &p ${JSON.stringify([PROD])}\np: &p ${JSON.stringify([DEV])}\n` +
        `n: &n prod\nn: &n dev\nb: &b {profiles: ${JSON.stringify([PROD])}}\n` +
        `b: &b {profiles: ${JSON.stringify([DEV])}}\n`;
      const entities = '            entities: [{name: orders, source: bigquery:p.prod.orders}]\n';
      for (const [block, yaml11] of [
        ['      - vendor_name: GOOGLE\n        data:\n          profiles: *p\n', false],
        ['      - vendor_name: GOOGLE\n        profiles: [*p]\n', false],
        ['      - vendor_name: GOOGLE\n        profiles:\n          - name: *n\n' + entities, false],
        ['      - vendor_name: GOOGLE\n        data:\n          profiles:\n            - name: *n\n' +
          entities.replace(/^ {12}/, '              '), false],
        ['      - vendor_name: GOOGLE\n        data:\n          <<: *b\n', true],
      ] as [string, boolean][]) {
        const text = `${yaml11 ? '%YAML 1.1\n---\n' : ''}version: "${VANILLA}"\n${anchors}` +
          `semantic_model:\n${section(block)}`;
        expect(() => loadModels(text)).toThrow('Map keys must be unique');
        expect(() => googleBlockProfiles(text)).toThrow(
          'Semantic model load error: could not parse input: Map keys must be unique');
      }
      // An alias whose anchor is not set inside a profile reads as null past
      // the error, and the fix gives it a value.
      const unset = vanilla('      - vendor_name: GOOGLE\n        profiles:\n          - name: prod\n' +
        '            entities: [{name: orders, source: *nope}]\n');
      expect(() => googleBlockProfiles(unset)).toThrow('could not parse input: Unresolved alias');
    });

    // Which version holds is not known, so neither order is read.
    test('reports the YAML error for a version set twice', () => {
      const text = (first: string, last: string) =>
        `version: "${first}"\nversion: "${last}"\nsemantic_model:\n${section(PROD_BLOCK)}`;
      for (const [first, last] of [[GOOGLE, VANILLA], [VANILLA, GOOGLE]]) {
        expect(() => googleBlockProfiles(text(first, last))).toThrow(
          'Semantic model load error: could not parse input: Map keys must be unique');
      }
    });

    test('reports the YAML error when the profiles are an alias whose anchor is not set', () => {
      const text = vanilla('      - vendor_name: GOOGLE\n        data:\n          profiles: *nope\n');
      expect(() => googleBlockProfiles(text)).toThrow('could not parse input: Unresolved alias');
    });

    // A block whose data the YAML error leaves unset cannot be read.
    test('reports the YAML error when a block has no data and no profiles beside it', () => {
      for (const [block, problem] of [
        ['      - vendor_name: GOOGLE\n        data: *nope\n', 'Unresolved alias'],
        [`      - vendor_name: GOOGLE\n       data: ${data({ profiles: [PROD] })}\n`, ''],
      ]) {
        expect(() => loadModels(vanilla(block))).toThrow('could not parse input');
        expect(() => googleBlockProfiles(vanilla(block))).toThrow(
          `Semantic model load error: could not parse input: ${problem}`);
      }
    });

    // JSON.parse keeps the last of a repeated key, so such data cannot be read.
    test('reports the YAML error when a block sets profiles twice or a key twice inside them', () => {
      for (const d of [
        `'{"profiles": [{"name": "prod", "name": "dev"}]}'`,
        `'{"profiles": ${JSON.stringify([PROD])}, "profiles": []}'`,
      ]) {
        const text = vanilla(blockYaml(d), '    description: a\n    description: b\n');
        expect(() => loadModels(text)).toThrow('Map keys must be unique');
        expect(() => googleBlockProfiles(text)).toThrow(
          'Semantic model load error: could not parse input: Map keys must be unique');
      }
    });

    // The lenient parse keeps the last of a repeated key too, so profiles
    // written as YAML that repeat a key cannot be read either.
    test('reports the YAML error when profiles written as YAML set a key twice', () => {
      for (const block of [
        `      - vendor_name: GOOGLE\n        data:\n          profiles: ${JSON.stringify([PROD])}\n          profiles: []\n`,
        '      - vendor_name: GOOGLE\n        data:\n          profiles:\n            - name: prod\n              name: dev\n',
        '      - vendor_name: GOOGLE\n        data:\n          profiles:\n            - name: prod\n              entities:\n' +
          '                - name: orders\n                  source: bigquery:p.a.orders\n                  source: bigquery:p.b.orders\n',
        `      - vendor_name: GOOGLE\n        profiles: ${JSON.stringify([PROD])}\n        profiles: []\n`,
        '      - vendor_name: GOOGLE\n        profiles:\n          - name: prod\n            name: dev\n',
      ]) {
        expect(() => loadModels(vanilla(block))).toThrow('Map keys must be unique');
        expect(() => googleBlockProfiles(vanilla(block))).toThrow(
          'Semantic model load error: could not parse input: Map keys must be unique');
      }
    });

    // A block whose vendor the YAML error leaves unknown cannot be read.
    test('reports the YAML error when a block\'s vendor_name is unset, not a string, or set twice', () => {
      for (const [block, problem] of [
        [`      - vendor_name: *nope\n        data: ${data({ profiles: [PROD] })}\n`, 'Unresolved alias'],
        [`      - vendor_name: GOOGLE\n         data: ${data({ profiles: [PROD] })}\n`, ''],
        [`      - vendor_name: GOOGLE\n        vendor_name: ACME\n        data: ${data({ profiles: [PROD] })}\n`,
          'Map keys must be unique'],
      ]) {
        expect(() => loadModels(vanilla(block))).toThrow('could not parse input');
        expect(() => googleBlockProfiles(vanilla(block))).toThrow(
          `Semantic model load error: could not parse input: ${problem}`);
      }
    });
  });

  test('googleBlockProfiles reads a semantic_model written as one mapping', () => {
    const text = JSON.stringify({ version: VANILLA, semantic_model: {
      name: 'm', custom_extensions: [google({ profiles: [PROD] })] } });
    expect(() => loadModels(text)).toThrow('semantic_model');
    expect(googleBlockProfiles(text).map(p => p.name)).toEqual(['prod']);
  });

  test('googleBlockProfiles skips profiles with no JSON form, such as a recursive alias', () => {
    const text = (block: string) => `version: "${VANILLA}"
semantic_model:
  - name: m
    custom_extensions:
${block}`;
    for (const block of [
      '      - vendor_name: GOOGLE\n        profiles: &p\n          - name: prod\n            self: *p\n',
      '      - vendor_name: GOOGLE\n        data: &d\n          profiles:\n            - name: prod\n              self: *d\n',
    ]) {
      expect(googleBlockProfiles(text(block))).toEqual([]);
    }
  });
});

describe('datatype casing follows the flavor', () => {
  // [input, vanilla result, google result]; null means rejected.
  const cases: [string|undefined, string|undefined|null, string|undefined|null][] = [
    ['Integer', 'Integer', 'Integer'],
    ['integer', null, 'Integer'],
    ['DATETIMETZ', null, 'DateTimeTz'],
    ['datetime', null, 'DateTime'],
    ['datetimetz', null, 'DateTimeTz'],
    ['Opaque', undefined, undefined],
    ['opaque', null, undefined],
    [undefined, undefined, undefined],
    ['VARCHAR', null, null],
  ];
  for (const [input, vanilla, google] of cases) {
    for (const [v, want] of [[VANILLA, vanilla], [GOOGLE, google]] as const) {
      test(`${v}: ${input ?? '(omitted)'} -> ${want === null ? 'rejected' : want}`, () => {
        const patch = input === undefined ? {} : { datatype: input };
        const run = () => load(v, fullModel('field', patch));
        if (want === null) {
          expect(run).toThrow(new RegExp(`datatype '${input}' is not valid in a '${v}' document`));
        } else {
          expect(irAt(run().models[0], 'field').type).toBe(want);
        }
      });
    }
  }
  test('a metric datatype is normalized too', () => {
    const m = load(GOOGLE, fullModel('metric', { datatype: 'integer' })).models[0];
    expect(m.metrics[0].type).toBe('Integer');
    expect(() => load(VANILLA, fullModel('metric', { datatype: 'integer' })))
      .toThrow(/datatype 'integer' is not valid/);
  });
});

describe('what a vanilla document must bind', () => {
  const opts = { bindingOptional: true };
  const unbound: [string, (m: any) => void, RegExp][] = [
    ['a dataset with no source', m => { delete m.datasets[0].source; },
      /dataset 'orders': a 0\.2\.0\.dev0 document requires 'source'\. Only 0\.2\.0\.dev0\/google lets a dataset leave it to a profile\./],
    ['a field with no expression', m => { delete m.datasets[0].fields[1].expression; },
      /field 'orders\.customer_id': a 0\.2\.0\.dev0 document requires 'expression'\. Only 0\.2\.0\.dev0\/google lets a field leave it to a profile\./],
    ['a relationship with no columns',
      m => { delete m.relationships[0].from_columns; delete m.relationships[0].to_columns; },
      /relationship 'orders_to_customers': a 0\.2\.0\.dev0 document requires 'from_columns'\. Only 0\.2\.0\.dev0\/google lets a relationship leave it to a profile\./],
  ];
  for (const [name, unbind, message] of unbound) {
    test(`${name} is rejected in vanilla, with or without bindingOptional`, () => {
      const m = fullModel(); unbind(m);
      expect(() => load(VANILLA, m)).toThrow(message);
      expect(() => load(VANILLA, m, opts)).toThrow(message);
    });
    test(`${name} is still rejected when the document carries a GOOGLE block`, () => {
      const m = fullModel('model', { custom_extensions: [{ vendor_name: 'GOOGLE', data: '{}' }] });
      unbind(m);
      expect(() => load(VANILLA, m, opts)).toThrow(message);
    });
    test(`${name} loads in the Google flavor`, () => {
      const m = fullModel(); unbind(m);
      expect(load(GOOGLE, m, opts).models).toHaveLength(1);
    });
  }
  test('a half-bound relationship is caught by the schema', () => {
    const m = fullModel(); delete m.relationships[0].to_columns;
    expect(() => load(VANILLA, m, opts)).toThrow(/from_columns and to_columns/);
  });
});

describe('closed objects: custom_extensions and dimension', () => {
  for (const v of FLAVORS) {
    test(`${v}: an unknown key inside a custom_extensions entry is rejected`, () => {
      expect(() => load(v, fullModel('dataset', {
        custom_extensions: [{ vendor_name: 'ACME', data: '{}', vendor: 'ACME' }],
      }))).toThrow(/vendor/);
    });
    test(`${v}: an unknown key inside dimension is rejected`, () => {
      expect(() => load(v, fullModel('field', {
        dimension: { is_time: true, is_tme: true },
      }))).toThrow(/is_tme/);
    });
  }
});


describe('a custom ai_context member named __proto__', () => {
  const withCustom = (custom: string, version = GOOGLE) => {
    const body = version === GOOGLE ?
        `    ai_context:\n      custom:\n${custom.replace(/^/gm, '        ')}\n` :
        `    ai_context:\n${custom.replace(/^/gm, '      ')}\n`;
    return `version: "${version}"
semantic_model:
  - name: m
${body}    datasets:
      - name: d
        source: bigquery:p.d.t
        primary_key: [id]
        fields:
          - name: id
            expression:
              dialects:
                - { dialect: ANSI_SQL, expression: id }
`;
  };

  // Nothing is dropped silently. Schema validation drops a `__proto__` key, so
  // the loader rejects it first.
  test('a member named __proto__ is rejected in both flavors', () => {
    for (const v of FLAVORS) {
      expect(() => loadModels(withCustom('__proto__: {x: 1}\nkeep: 1', v)))
          .toThrow("model 'm': custom ai_context member '__proto__' is not " +
                   "supported; rename it.");
    }
  });

  // A member's value is opaque, so a `__proto__` key inside it is kept, and so
  // is a nested key named `ai_context`.
  test('a __proto__ key inside a member value is kept', () => {
    const vanilla = loadModels(withCustom('custom: {__proto__: 1, y: 2}', VANILLA))
                        .models[0].aiContext?.additionalProperties as any;
    expect(Object.keys(vanilla.custom)).toEqual(['__proto__', 'y']);
    const google =
        loadModels(withCustom('notes: {ai_context: {__proto__: 1}}', GOOGLE))
            .models[0].aiContext?.additionalProperties as any;
    expect(Object.keys(google.notes.ai_context)).toEqual(['__proto__']);
  });

  // The error names the object, as the loader's other errors do.
  test('the error names the dataset, relationship or metric too', () => {
    const doc = (patch: object) => ({
      version: GOOGLE,
      semantic_model: [{
        name: 'm',
        datasets: [
          {name: 'orders', source: 'bigquery:p.d.o', primary_key: ['id'],
           fields: [{name: 'id', expression: 'id'}, {name: 'cid', expression: 'cid'}]},
          {name: 'customers', source: 'bigquery:p.d.c', primary_key: ['id'],
           fields: [{name: 'id', expression: 'id'}]},
        ],
        relationships: [{name: 'placed_by', from: 'orders', to: 'customers',
                         from_columns: ['cid'], to_columns: ['id']}],
        metrics: [{name: 'n', expression: 'COUNT(orders.id)'}],
        ...patch,
      }],
    });
    const proto = () => {
      const custom: Record<string, unknown> = {};
      Object.defineProperty(custom, '__proto__', {value: 1, enumerable: true});
      return {custom};
    };
    const base = doc({});
    (base.semantic_model[0].datasets[0] as any).ai_context = proto();
    expect(() => fromDocument(base)).toThrow("dataset 'orders': custom ai_context member '__proto__'");
    const rel = doc({});
    (rel.semantic_model[0].relationships[0] as any).ai_context = proto();
    expect(() => fromDocument(rel)).toThrow("relationship 'placed_by': custom ai_context member '__proto__'");
    const met = doc({});
    (met.semantic_model[0].metrics[0] as any).ai_context = proto();
    expect(() => fromDocument(met)).toThrow("metric 'n': custom ai_context member '__proto__'");
  });

  // The version is checked first, so a document with none is told that.
  test('a missing version is reported before a __proto__ member', () => {
    const text = withCustom('__proto__: 1', VANILLA).replace(/^version: .*\n/, '');
    expect(() => loadModels(text)).toThrow("missing 'version'");
  });

  test('the error names the field whose member is __proto__', () => {
    const text = `version: "${GOOGLE}"
semantic_model:
  - name: m
    datasets:
      - name: d
        source: bigquery:p.d.t
        primary_key: [id]
        fields:
          - name: id
            expression: id
            ai_context:
              custom:
                __proto__: 1
`;
    expect(() => loadModels(text))
        .toThrow("field 'd.id': custom ai_context member '__proto__' is not supported");
  });

  test('in the Google flavor a sibling __proto__ is an unrecognized key', () => {
    const text = `version: "${GOOGLE}"
semantic_model:
  - name: m
    ai_context:
      __proto__: 1
    datasets:
      - name: d
        source: bigquery:p.d.t
        primary_key: [id]
        fields:
          - { name: id, expression: id }
`;
    expect(() => loadModels(text))
        .toThrow("model 'm': ai_context has an unrecognized key '__proto__'.");
  });
});


// ---------------------------------------------------------------------------
// Per-engine expression lists, strict entity sources, deployments, and inline
// profiles (b/567743508).
// ---------------------------------------------------------------------------

describe('per-engine expression lists', () => {
  test('a three-engine list survives loading with all three entries in the order written', () => {
    for (const v of FLAVORS) {
      const { models } = load(v, {
        name: 'm',
        datasets: [{
          name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
          fields: [{
            name: 'net',
            expression: {
              dialects: [
                { dialect: 'ANSI_SQL', expression: 'gross - tax' },
                { dialect: 'BIGQUERY', expression: 'SAFE_SUBTRACT(gross, tax)' },
                { dialect: 'SPANNER', expression: 'gross - COALESCE(tax, 0)' },
              ],
            },
          }],
        }],
        metrics: [{
          name: 'rev',
          expression: {
            dialects: [
              { dialect: 'SNOWFLAKE', expression: 'SUM(orders.net)' },
              { dialect: 'BIGQUERY', expression: 'SUM(orders.net)' },
              { dialect: 'POSTGRES', expression: 'SUM(orders.net)::numeric' },
            ],
          },
        }],
      });
      const field = models[0].entities[0].fields[0];
      expect(field.stringForm).toBe(false);
      expect(field.dialects).toEqual([
        { dialect: 'ANSI_SQL', expression: 'gross - tax' },
        { dialect: 'BIGQUERY', expression: 'SAFE_SUBTRACT(gross, tax)' },
        { dialect: 'SPANNER', expression: 'gross - COALESCE(tax, 0)' },
      ]);
      expect(field.expression).toBe('SAFE_SUBTRACT(gross, tax)');

      const metric = models[0].metrics[0];
      expect(metric.stringForm).toBe(false);
      expect(metric.dialects).toEqual([
        { dialect: 'SNOWFLAKE', expression: 'SUM(orders.net)' },
        { dialect: 'BIGQUERY', expression: 'SUM(orders.net)' },
        { dialect: 'POSTGRES', expression: 'SUM(orders.net)::numeric' },
      ]);
      expect(metric.expression).toBe('SUM(orders.net)');
    }
  });

  test('the same dialect twice in one list is rejected', () => {
    for (const v of FLAVORS) {
      expect(() => load(v, {
        name: 'm',
        datasets: [{
          name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
          fields: [{
            name: 'id',
            expression: {
              dialects: [
                { dialect: 'BIGQUERY', expression: 'id' },
                { dialect: 'BIGQUERY', expression: 'o_id' },
              ],
            },
          }],
        }],
      })).toThrow("Duplicate dialect 'BIGQUERY' in expression dialects.");
    }
  });

  test('the short form in Google flavor loads as a one-entry ANSI_SQL list with stringForm:true and no BIGQUERY fallback warning, and is rejected in vanilla', () => {
    const { models, warnings } = load(GOOGLE, {
      name: 'm',
      datasets: [{
        name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
        fields: [
          { name: 'id', expression: 'o_id' },
          { name: 'amount', expression: 'o_amount' },
        ],
      }],
      metrics: [{ name: 'total', expression: 'SUM(orders.amount)' }],
    });
    const field = models[0].entities[0].fields[0];
    expect(field.stringForm).toBe(true);
    expect(field.dialects).toEqual([{ dialect: 'ANSI_SQL', expression: 'o_id' }]);
    expect(field.expression).toBe('o_id');

    const metric = models[0].metrics[0];
    expect(metric.stringForm).toBe(true);
    expect(metric.dialects).toEqual([{ dialect: 'ANSI_SQL', expression: 'SUM(orders.amount)' }]);
    expect(metric.expression).toBe('SUM(orders.amount)');
    expect(warnings.some(w => w.includes('BIGQUERY'))).toBe(false);

    expect(() => load(VANILLA, {
      name: 'm',
      datasets: [{
        name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
        fields: [{ name: 'id', expression: 'o_id' }],
      }],
    })).toThrow(/dialects:\n\s+- dialect: ANSI_SQL\n\s+expression: "o_id"/);

    expect(() => load(VANILLA, {
      name: 'm',
      datasets: [{
        name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
        fields: [{ name: 'id', expression: expr('o_id') }],
      }],
      metrics: [{ name: 'total', expression: 'SUM(orders.id)' }],
    })).toThrow(/dialects:\n\s+- dialect: ANSI_SQL\n\s+expression: "SUM\(orders\.id\)"/);
  });

  test('an expression dialect entry with an extra key is rejected', () => {
    for (const v of FLAVORS) {
      expect(() => load(v, {
        name: 'm',
        datasets: [{
          name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
          fields: [{
            name: 'id',
            expression: {
              dialects: [
                { dialect: 'BIGQUERY', expression: 'id', note: 'extra' },
              ],
            },
          }],
        }],
      })).toThrow(/unrecognized_keys|Unrecognized key/i);
    }
  });

  test('lowercase LoadOptions.dialect still picks the uppercase dialect entry', () => {
    const { models } = fromDocument({
      version: VANILLA,
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
          fields: [{
            name: 'net',
            expression: {
              dialects: [
                { dialect: 'ANSI_SQL', expression: 'gross - tax' },
                { dialect: 'BIGQUERY', expression: 'SAFE_SUBTRACT(gross, tax)' },
              ],
            },
          }],
        }],
      }],
    }, { dialect: 'bigquery' });
    expect(models[0].entities[0].fields[0].expression).toBe('SAFE_SUBTRACT(gross, tax)');
  });
});


describe('strict entity sources', () => {
  // A string with a `/` is never a bare table name, so a resource name whose
  // host is misspelled or not lowercase is rejected as its URI is, even under
  // the legacy flag.
  test('a resource name with a misspelled host is rejected as its URI is', () => {
    for (const name of [
      'bigquery.googelapis.com/projects/p/datasets/d/tables/t',
      'BigQuery.googleapis.com/projects/p/datasets/d/tables/t',
    ]) {
      for (const source of [name, `//${name}`]) {
        const doc = { name: 'm', datasets: [{ name: 'orders', source, primary_key: ['id'], fields: [] }] };
        expect(() => load(GOOGLE, doc)).toThrow(/is not a valid table reference/);
        expect(() => load(GOOGLE, doc, { allowLegacyBareSource: true }))
            .toThrow(/is not a valid table reference/);
      }
    }
  });

  const cases: Array<[string, string, string]> = [
    [
      'BigQuery resource URI',
      '//bigquery.googleapis.com/projects/acme/datasets/raw/tables/orders',
      'acme.raw.orders',
    ],
    [
      'BigQuery catalog name',
      'bigquery:acme.raw.orders',
      'acme.raw.orders',
    ],
    [
      'BigQuery catalog name with backtick-quoted segment',
      'bigquery:`acme-prod`.raw.`order-items`',
      'acme-prod.raw.order-items',
    ],
    [
      'Spanner resource URI',
      '//spanner.googleapis.com/projects/acme/instances/inst/databases/db/tables/orders',
      '//spanner.googleapis.com/projects/acme/instances/inst/databases/db/tables/orders',
    ],
    [
      'Spanner catalog name (5 segments)',
      'spanner:acme.regional-us-central1.inst.db.orders',
      'spanner:acme.regional-us-central1.inst.db.orders',
    ],
    [
      'AlloyDB resource URI (6 parts including schema)',
      '//alloydb.googleapis.com/projects/acme/locations/us-central1/clusters/cl/databases/db/schemas/public/tables/orders',
      '//alloydb.googleapis.com/projects/acme/locations/us-central1/clusters/cl/databases/db/schemas/public/tables/orders',
    ],
    [
      'AlloyDB catalog name (6 segments including schema)',
      'alloydb:acme.us-central1.cl.db.public.orders',
      'alloydb:acme.us-central1.cl.db.public.orders',
    ],
    [
      'BigLake resource URI',
      '//biglake.googleapis.com/projects/acme/catalogs/cat/namespaces/ns/tables/orders',
      'acme.cat.ns.orders',
    ],
    [
      'Cloud SQL MySQL catalog name',
      'cloudsql_mysql:acme.us-central1.inst.db.orders',
      'cloudsql_mysql:acme.us-central1.inst.db.orders',
    ],
    [
      'Cloud SQL PostgreSQL catalog name',
      'cloudsql_postgresql:acme.us-central1.inst.db.public.orders',
      'cloudsql_postgresql:acme.us-central1.inst.db.public.orders',
    ],
  ];

  for (const [label, authored, expectedDataSource] of cases) {
    test(`${label} loads and populates authoredSource and dataSource`, () => {
      const { models } = load(GOOGLE, {
        name: 'm',
        datasets: [{ name: 'orders', source: authored, primary_key: ['id'], fields: [] }],
      });
      const entity = models[0].entities[0];
      expect(entity.authoredSource).toBe(authored);
      expect(entity.dataSource).toBe(expectedDataSource);
    });
  }

  // Knowledge Catalog keeps an entry for each Google Cloud table in a system
  // entry group, one whose id starts with `@`, and the entry id is the table's
  // resource name. A source written as that entry name is rejected, and the
  // message names the resource name to write instead.
  test('an entry name in a system entry group is rejected, naming the resource name', () => {
    const loadSource = (source: string) => () => load(GOOGLE, {
      name: 'm',
      datasets: [{ name: 'orders', source, primary_key: ['id'], fields: [] }],
    });
    for (const [group, name] of [
      ['@bigquery', 'bigquery.googleapis.com/projects/acme/datasets/raw/tables/orders'],
      ['@spanner', 'spanner.googleapis.com/projects/acme/instances/inst/databases/db/tables/Orders'],
    ]) {
      const source = `projects/acme/locations/us/entryGroups/${group}/entries/${name}`;
      expect(databaseOf(source)).toBeUndefined();
      expect(loadSource(source)).toThrow(
        `dataset 'orders': source '${source}' is a Knowledge Catalog entry ` +
        `name in the system entry group '${group}'; write the table's ` +
        `resource name instead: '${name}'.`);
    }
    // An entry id that is not a resource name gets an example instead.
    const odd = 'projects/acme/locations/us/entryGroups/@bigquery/entries/orders';
    expect(loadSource(odd)).toThrow(
      "write the table's resource name instead, such as " +
      "'bigquery.googleapis.com/projects/<p>/datasets/<d>/tables/<t>'.");
  });

  // A system entry's id is named as the source to write only when it is a
  // table's resource name. A dataset entry gets an example, and a Bigtable or
  // Dataproc Metastore entry is told the service is not supported yet.
  test('a dataset, Bigtable or Dataproc Metastore entry name is not told to write its id', () => {
    const loadSource = (source: string) => () => load(GOOGLE, {
      name: 'm',
      datasets: [{ name: 'orders', source, primary_key: ['id'], fields: [] }],
    });
    const entry = (group: string, id: string) =>
      `projects/acme/locations/us/entryGroups/${group}/entries/${id}`;
    expect(loadSource(entry('@bigquery',
      'bigquery.googleapis.com/projects/acme/datasets/raw'))).toThrow(
      "in the system entry group '@bigquery'; write the table's resource " +
      "name instead, such as " +
      "'bigquery.googleapis.com/projects/<p>/datasets/<d>/tables/<t>'.");
    for (const [group, id, service] of [
      ['@bigtable', 'bigtable.googleapis.com/projects/acme/instances/inst/tables/orders', 'Bigtable'],
      ['@dataprocmetastore',
       'metastore.googleapis.com/projects/acme/locations/us/services/svc/databases/db/tables/orders',
       'Dataproc Metastore'],
    ]) {
      expect(loadSource(entry(group, id))).toThrow(
        `preview does not support ${service} sources yet.`);
    }
  });

  // Bigtable and Dataproc Metastore are Google Cloud services, but the preview
  // does not support their tables yet, in any form.
  test('a Bigtable or Dataproc Metastore source is rejected as not supported yet', () => {
    for (const [service, sources] of [
      ['Bigtable', [
        '//bigtable.googleapis.com/projects/acme/instances/inst/tables/orders',
        'bigtable.googleapis.com/projects/acme/instances/inst/tables/orders',
        'bigtable:acme.inst.orders',
      ]],
      ['Dataproc Metastore', [
        '//metastore.googleapis.com/projects/acme/locations/us/services/svc/databases/db/tables/orders',
        'metastore.googleapis.com/projects/acme/locations/us/services/svc/databases/db/tables/orders',
        'dataproc_metastore:acme.us.svc.db.orders',
      ]],
    ] as const) {
      for (const source of sources) {
        expect(databaseOf(source)).toBeUndefined();
        expect(() => load(GOOGLE, {
          name: 'm',
          datasets: [{ name: 'orders', source, primary_key: ['id'], fields: [] }],
        })).toThrow(
          `dataset 'orders': source '${source}' is a ${service} resource; the ` +
          `preview does not support ${service} sources yet.`);
      }
    }
  });

  // The preview supports Google Cloud tables only, so a third-party table is
  // rejected in every form: a catalog name under a third-party prefix, and a
  // Knowledge Catalog entry name.
  test('a third-party source is rejected in every form', () => {
    for (const source of [
      'snowflake:acct.db.public.orders',
      'databricks:table:metastore.cat.sch.orders',
      'mysql:inst.db.orders',
      'postgresql:inst.db.public.orders',
      'projects/acme/locations/us/entryGroups/snowflake/entries/acct.db.public.orders',
    ]) {
      expect(databaseOf(source)).toBeUndefined();
      expect(() => load(GOOGLE, {
        name: 'm',
        datasets: [{ name: 'orders', source, primary_key: ['id'], fields: [] }],
      })).toThrow(
        `dataset 'orders': source '${source}' is a third-party table; the ` +
        `preview supports Google Cloud tables only: BigQuery, BigLake, ` +
        `Spanner, AlloyDB and Cloud SQL.`);
    }
  });

  // Push and the runtime load a legacy `semantic_model:` wrapper with bare
  // table names allowed. An entry name has no `:`, so it must be rejected
  // before the bare table name rule reads it.
  test('an entry name is rejected where bare table names are allowed', () => {
    for (const [source, message] of [
      ['projects/acme/locations/us/entryGroups/snowflake/entries/acct.db.public.orders',
       'is a third-party table'],
      ['projects/acme/locations/us/entryGroups/@bigquery/entries/bigquery.googleapis.com/projects/acme/datasets/raw/tables/orders',
       "is a Knowledge Catalog entry name in the system entry group '@bigquery'"],
    ]) {
      expect(() => load(GOOGLE, {
        name: 'm',
        datasets: [{ name: 'orders', source, primary_key: ['id'], fields: [] }],
      }, { allowLegacyBareSource: true })).toThrow(`source '${source}' ${message}`);
    }
  });

  test('both AlloyDB spellings load together in the same model and resolve to the same database', () => {
    const uri =
        '//alloydb.googleapis.com/projects/acme/locations/us-central1/clusters/cl/databases/db/schemas/public/tables/orders';
    const fqn = 'alloydb:acme.us-central1.cl.db.public.customers';
    expect(databaseOf(uri)).toBe('alloydb/acme/us-central1/cl/db');
    expect(databaseOf(fqn)).toBe(databaseOf(uri));

    const { models } = load(GOOGLE, {
      name: 'm',
      datasets: [
        { name: 'orders', source: uri, primary_key: ['id'], fields: [] },
        { name: 'customers', source: fqn, primary_key: ['id'], fields: [] },
      ],
    });
    expect(models[0].entities).toHaveLength(2);
  });

  // A Google Cloud table may be written as its GCP resource name:
  // the resource URI without the leading `//`. Both name the same table, so
  // they give the same database and `dataSource`. `authoredSource` keeps the
  // form the author wrote, so pull can return it.
  const RESOURCE_URIS: [string, string][] = [
    ['BigQuery', '//bigquery.googleapis.com/projects/acme/datasets/raw/tables/orders'],
    ['BigLake', '//biglake.googleapis.com/projects/acme/catalogs/cat/namespaces/ns/tables/orders'],
    ['Spanner', '//spanner.googleapis.com/projects/acme/instances/inst/databases/db/tables/Orders'],
    ['AlloyDB', '//alloydb.googleapis.com/projects/acme/locations/us-central1/clusters/cl/databases/db/schemas/public/tables/orders'],
  ];
  for (const [label, uri] of RESOURCE_URIS) {
    test(`a ${label} source written as a resource name loads like its URI`, () => {
      const name = uri.slice(2);
      expect(databaseOf(name)).toBe(databaseOf(uri));
      expect(databaseOf(name)).toBeDefined();
      const loaded = (source: string) => load(GOOGLE, {
        name: 'm',
        datasets: [{ name: 'orders', source, primary_key: ['id'], fields: [] }],
      }).models[0].entities[0];
      const fromName = loaded(name);
      expect(fromName.authoredSource).toBe(name);
      expect(fromName.dataSource).toBe(loaded(uri).dataSource);
    });
  }

  test('a resource name and a URI of the same database load together in one model', () => {
    const { models } = load(GOOGLE, {
      name: 'm',
      datasets: [
        { name: 'orders', source: 'spanner.googleapis.com/projects/acme/instances/inst/databases/db/tables/Orders', primary_key: ['id'], fields: [] },
        { name: 'customers', source: '//spanner.googleapis.com/projects/acme/instances/inst/databases/db/tables/Customers', primary_key: ['id'], fields: [] },
      ],
    });
    expect(models[0].entities).toHaveLength(2);
  });

  test('a malformed resource name is rejected as a URI with the same mistake is', () => {
    for (const bad of [
      'bigquery.googleapis.com/projects/p/datasets/d',
      'bigquery.googleapis.com/projects/p/datasets/d/tables/a.b',
      'spanner.googleapis.com/projects/p/instances/i/databases/db/propertyGraphs/g',
    ]) {
      expect(databaseOf(bad)).toBeUndefined();
      expect(() => load(GOOGLE, {
        name: 'm',
        datasets: [{ name: 'orders', source: bad, primary_key: ['id'], fields: [] }],
      })).toThrow(/is not a valid table reference/);
    }
  });

  test('a four-segment Spanner or AlloyDB catalog name is rejected', () => {
    expect(() => load(GOOGLE, {
      name: 'm',
      datasets: [{ name: 'orders', source: 'spanner:acme.inst.db.orders', primary_key: ['id'], fields: [] }],
    })).toThrow(/is not a valid table reference/);

    expect(() => load(GOOGLE, {
      name: 'm',
      datasets: [{ name: 'orders', source: 'alloydb:acme.cl.db.orders', primary_key: ['id'], fields: [] }],
    })).toThrow(/is not a valid table reference/);
  });

  test('the instance-based AlloyDB URI is rejected with a migration hint by default and loads when allowLegacyBareSource is set', () => {
    const legacyUri =
        '//alloydb.googleapis.com/projects/acme/locations/us-central1/clusters/cl/instances/inst/databases/db/tables/orders';
    const doc = {
      name: 'm',
      datasets: [{ name: 'orders', source: legacyUri, primary_key: ['id'], fields: [] }],
    };
    expect(() => load(GOOGLE, doc)).toThrow(
        /uses the legacy instance-based AlloyDB URI[\s\S]*\/\/alloydb\.googleapis\.com\/projects\/acme\/locations\/us-central1\/clusters\/cl\/databases\/db\/schemas\/<schema>\/tables\/orders/,
    );

    const { models } = load(GOOGLE, doc, { allowLegacyBareSource: true });
    expect(models[0].entities[0].authoredSource).toBe(legacyUri);
    expect(models[0].entities[0].dataSource).toBe(legacyUri);

    // Written as a resource name, it gets the same message, and under the flag
    // the same `dataSource`, which the runtime reads as a URI.
    const legacyName = legacyUri.slice(2);
    const nameDoc = {
      name: 'm',
      datasets: [{ name: 'orders', source: legacyName, primary_key: ['id'], fields: [] }],
    };
    expect(() => load(GOOGLE, nameDoc)).toThrow(/uses the legacy instance-based AlloyDB URI/);
    const fromName = load(GOOGLE, nameDoc, { allowLegacyBareSource: true }).models[0].entities[0];
    expect(fromName.authoredSource).toBe(legacyName);
    expect(fromName.dataSource).toBe(legacyUri);
  });

  test('rejects broken backtick quoting, unquoted colons, unquoted whitespace, and dots in BigQuery dataset/table segments', () => {
    expect(databaseOf('bigquery:my proj.d.t')).toBeUndefined();
    for (const bad of [
      'bigquery:acme:us.sales.orders',
      'bigquery:`acme.sales.orders',
      'bigquery:`acme`x.sales.orders',
      'bigquery:ac``me.sales.orders',
      '//bigquery.googleapis.com/projects/p/datasets/a.b/tables/t',
      '//bigquery.googleapis.com/projects/p/datasets/d/tables/a.b',
      'bigquery:p.`a.b`.t',
      'bigquery:p.d.`a.b`',
    ]) {
      expect(databaseOf(bad)).toBeUndefined();
      expect(() => load(GOOGLE, {
        name: 'm',
        datasets: [{ name: 'orders', source: bad, primary_key: ['id'], fields: [] }],
      })).toThrow(/is not a valid table reference/);
    }
  });

  test('source rejections: query-valued source, bare table name, 4-part bare name, overlong source, and unknown prefix each produce their own message', () => {
    // 1. Query-valued source
    expect(() => load(GOOGLE, {
      name: 'm',
      datasets: [{ name: 'orders', source: 'SELECT * FROM orders', primary_key: ['id'], fields: [] }],
    })).toThrow("dataset 'orders': source 'SELECT * FROM orders' looks like a SQL query; a query-valued source is not supported yet.");

    // 2. Bare table names (1-, 2-, and 3-part). The hint shows the GCP
    // resource name, filling in what the name gives.
    for (const [bare, hint] of [
      ['orders', 'bigquery.googleapis.com/projects/<project>/datasets/<dataset>/tables/orders'],
      ['raw.orders', 'bigquery.googleapis.com/projects/<project>/datasets/raw/tables/orders'],
      ['acme.raw.orders', 'bigquery.googleapis.com/projects/acme/datasets/raw/tables/orders'],
    ]) {
      expect(() => load(GOOGLE, {
        name: 'm',
        datasets: [{ name: 'orders', source: bare, primary_key: ['id'], fields: [] }],
      })).toThrow(
        `dataset 'orders': bare table name '${bare}' is not a valid source. ` +
        `Write the table's GCP resource name instead, for example:\n` +
        `  source: ${hint}`,
      );
      // Passes when allowLegacyBareSource is set
      const { models } = load(GOOGLE, {
        name: 'm',
        datasets: [{ name: 'orders', source: bare, primary_key: ['id'], fields: [] }],
      }, { allowLegacyBareSource: true, defaultProject: 'acme', defaultDataset: 'raw' });
      expect(models[0].entities[0].authoredSource).toBe(bare);
      expect(models[0].entities[0].dataSource).toBe('acme.raw.orders');
    }

    // 3. Four-part bare table name suggests its BigLake resource name
    expect(() => load(GOOGLE, {
      name: 'm',
      datasets: [{ name: 'orders', source: 'acme.lake.sales.orders', primary_key: ['id'], fields: [] }],
    })).toThrow(
      "dataset 'orders': bare table name 'acme.lake.sales.orders' is not a valid source. Write its BigLake resource name instead:\n  source: biglake.googleapis.com/projects/acme/catalogs/lake/namespaces/sales/tables/orders",
    );

    // 4. Overlong source (> 4000 characters)
    const overlong = `bigquery:acme.sales.${'a'.repeat(4000)}`;
    expect(() => load(GOOGLE, {
      name: 'm',
      datasets: [{ name: 'orders', source: overlong, primary_key: ['id'], fields: [] }],
    })).toThrow(/exceeds the 4000-character limit/);

    // 5. Unknown prefix / unsupported URI
    for (const bad of ['custom:foo', 'trino:cat.sch.tbl', 'oracle:p.i.t', '//trino.example.com/anything', 'SNOWFLAKE:acct.db.public.orders']) {
      expect(() => load(GOOGLE, {
        name: 'm',
        datasets: [{ name: 'orders', source: bad, primary_key: ['id'], fields: [] }],
      })).toThrow(
        new RegExp(`dataset 'orders': source '${bad}' is not a valid table reference[\\s\\S]*The preview supports Google Cloud tables only`),
      );
    }
  });

  // A bare name with an empty segment, or with five or more, gets the general
  // error, since no hint can name its table.
  test('a bare name the hint cannot read gets the general error', () => {
    for (const bare of ['acme.us.inst.shop.orders', 'a..b', '.orders', 'orders.', 'a..b.c']) {
      expect(() => load(GOOGLE, {
        name: 'm',
        datasets: [{ name: 'orders', source: bare, primary_key: ['id'], fields: [] }],
      })).toThrow(`source '${bare}' is not a valid table reference`);
    }
  });
});


describe('deployments and inline profiles', () => {
  const BQ_TARGET = '//bigquery.googleapis.com/projects/acme/datasets/analytics/propertyGraphs/sales';
  const SPANNER_TARGET = '//spanner.googleapis.com/projects/acme/instances/test/databases/sales/propertyGraphs/sales';

  test('a named deployments list loads onto model.deployments and folds targets into the GOOGLE custom_extensions shim', () => {
    const { models } = load(GOOGLE, {
      name: 'sales',
      deployments: [
        { name: 'prod', target: BQ_TARGET },
        { name: 'staging', target: SPANNER_TARGET, profile: 'spanner_binding' },
      ],
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    });
    const m = models[0];
    expect(m.deployments).toEqual([
      { name: 'prod', target: BQ_TARGET },
      { name: 'staging', target: SPANNER_TARGET, profile: 'spanner_binding' },
    ]);
    expect(m.customExtensions).toEqual([
      {
        vendorName: 'GOOGLE',
        data: JSON.stringify({ deploymentTargets: [BQ_TARGET, SPANNER_TARGET] }),
      },
    ]);
  });

  test('duplicate deployment names are rejected', () => {
    expect(() => load(GOOGLE, {
      name: 'sales',
      deployments: [
        { name: 'prod', target: BQ_TARGET },
        { name: 'prod', target: SPANNER_TARGET },
      ],
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    })).toThrow("model 'sales': duplicate deployment name 'prod'");
  });

  test('duplicate deployment targets are rejected (after trimming), naming both deployments, and whitespace-only targets are rejected', () => {
    expect(() => load(GOOGLE, {
      name: 'sales',
      deployments: [
        { name: 'prod', target: BQ_TARGET },
        { name: 'staging', target: `${BQ_TARGET}  ` },
      ],
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    })).toThrow(
      `model 'sales': deployments 'prod' and 'staging' target the same resource '${BQ_TARGET}'; each deployment must target a distinct resource`,
    );

    expect(() => load(GOOGLE, {
      name: 'sales',
      deployments: [
        { name: 'prod', target: '   ' },
      ],
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    })).toThrow('Too small: expected string to have >=1 characters');
  });

  test('a deployment entry with an unknown key or an empty name or profile is rejected', () => {
    expect(() => load(GOOGLE, {
      name: 'sales',
      deployments: [
        { name: 'prod', target: BQ_TARGET, profle: 'spanner_binding' },
      ],
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    })).toThrow(/Unrecognized key.*profle/);

    expect(() => load(GOOGLE, {
      name: 'sales',
      deployments: [
        { name: '', target: BQ_TARGET },
      ],
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    })).toThrow("Deployment name '' is not valid");

    expect(() => load(GOOGLE, {
      name: 'sales',
      deployments: [
        { name: 'prod', target: BQ_TARGET, profile: '' },
      ],
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    })).toThrow('Too small: expected string to have >=1 characters');
  });

  test('setting both deployment_target and deployments rejects deployment_target by default and rejects setting both when allowLegacyBareSource is true', () => {
    // The author already has the list, so the message says to drop the old
    // key rather than add a list they already wrote.
    expect(() => load(GOOGLE, {
      name: 'sales',
      deployment_target: BQ_TARGET,
      deployments: [{ name: 'prod', target: SPANNER_TARGET }],
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    })).toThrow(
      "model 'sales': 'deployment_target' is no longer supported; remove it, and list its target under 'deployments' if it is not there already.",
    );

    expect(() => load(GOOGLE, {
      name: 'sales',
      deployment_target: BQ_TARGET,
      deployments: [{ name: 'prod', target: SPANNER_TARGET }],
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    }, { allowLegacyBareSource: true })).toThrow(
      "model 'sales': set either 'deployments' or 'deployment_target', not both.",
    );

    // A vanilla document cannot keep `deployments`, so it is told which key
    // to drop rather than to keep either one.
    expect(() => load(VANILLA, {
      name: 'sales',
      deployment_target: BQ_TARGET,
      deployments: [{ name: 'prod', target: SPANNER_TARGET }],
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    }, { allowLegacyBareSource: true })).toThrow(
      "model 'sales': neither 'deployments' nor 'deployment_target' is in the open format ('0.2.0.dev0'); set version: '0.2.0.dev0/google', keep 'deployments' and remove 'deployment_target'.",
    );
  });

  test('deployment_target and deployments are rejected in vanilla, and deployment_target in Google flavor quotes the target or <target>', () => {
    expect(() => load(GOOGLE, {
      name: 'sales',
      deployment_target: BQ_TARGET,
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    })).toThrow(
      `model 'sales': 'deployment_target' is no longer supported; migrate to the named 'deployments' list:\n` +
      `  deployments:\n` +
      `    - name: default\n` +
      `      target: ${BQ_TARGET}`,
    );

    expect(() => load(GOOGLE, {
      name: 'sales',
      deployment_target: 123,
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    })).toThrow(
      `model 'sales': 'deployment_target' is no longer supported; migrate to the named 'deployments' list:\n` +
      `  deployments:\n` +
      `    - name: default\n` +
      `      target: <target>`,
    );

    expect(() => load(VANILLA, {
      name: 'sales',
      deployment_target: BQ_TARGET,
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    })).toThrow(
      "model 'sales': 'deployment_target' is not in the open format ('0.2.0.dev0'); list " +
      "'deployments' in a GOOGLE custom_extensions block on the model, or set version: " +
      "'0.2.0.dev0/google' and use 'deployments:'",
    );

    expect(() => load(VANILLA, {
      name: 'sales',
      deployments: [{ name: 'prod', target: BQ_TARGET }],
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    })).toThrow(
      "model 'sales': 'deployments' is not in the open format ('0.2.0.dev0'); list " +
      "'deployments' in a GOOGLE custom_extensions block on the model, or set version: " +
      "'0.2.0.dev0/google' and use 'deployments:'",
    );
  });

  test('a padded legacy deployment_target is trimmed, as a deployments target is', () => {
    const { models } = load(GOOGLE, {
      name: 'sales',
      deployment_target: `  ${BQ_TARGET}  `,
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    }, { allowLegacyBareSource: true });
    expect(models[0].deployments).toEqual([{ name: 'default', target: BQ_TARGET }]);
  });

  test('an inline profiles key in a Google-flavor document is rejected, naming the sidecar file', () => {
    expect(() => load(GOOGLE, {
      name: 'sales',
      profiles: {
        bq: { datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders' }] },
      },
      datasets: [{ name: 'orders', source: 'bigquery:acme.raw.orders', primary_key: ['id'], fields: [] }],
    })).toThrow(
      "model 'sales': inline 'profiles' are not supported in a '0.2.0.dev0/google' document; write each binding profile in its own sidecar file 'sales.profile.<name>.yaml'.",
    );
  });
});




// Each of these is an author's mistake, so a load reports it as an error
// instead of throwing, and the callers print it with the document's name.
describe('deployment mistakes are reported, not thrown', () => {
  const G = '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
  const doc = (version: string, extra: string, key = 'entities') => `version: "${version}"
semantic_model:
  - name: sales
${extra}    ${key}:
      - name: orders
        source: bigquery:p.d.orders
        primary_key: [id]
        fields:
          - { name: id, expression: id }
`;
  const GOOGLE = '0.2.0.dev0/google';
  const both = `    deployment_target: ${G}\n    deployments:\n      - { name: a, target: "${G}" }\n`;
  const cases: [string, string, string, LoadOptions?][] = [
    ['both keys', doc(GOOGLE, both),
     "remove it, and list its target under 'deployments' if it is not there already"],
    // Under the legacy flag the both-keys check itself fires. It must throw
    // SemanticModelError, the class the load catches, so it is reported.
    ['both keys under the legacy flag', doc(GOOGLE, both),
     "set either 'deployments' or 'deployment_target', not both",
     {allowLegacyBareSource: true}],
    ['both keys in the open format under the legacy flag', doc('0.2.0.dev0', both, 'datasets'),
     "neither 'deployments' nor 'deployment_target' is in the open format", {allowLegacyBareSource: true}],
    ['deployment_target in the open format', doc('0.2.0.dev0', `    deployment_target: ${G}\n`, 'datasets'),
     "'deployment_target' is not in the open format"],
    ['both keys in the open format', doc('0.2.0.dev0', both, 'datasets'),
     "'deployment_target' is not in the open format"],
    ['deployment_target in the Google flavor', doc(GOOGLE, `    deployment_target: ${G}\n`),
     "'deployment_target' is no longer supported"],
    ['deployments in the open format', doc('0.2.0.dev0', `    deployments:\n      - { name: a, target: "${G}" }\n`, 'datasets'),
     "'deployments' is not in the open format"],
    ['inline profiles in the Google flavor', doc(GOOGLE, `    profiles:\n      - name: prod\n`),
     "inline 'profiles' are not supported"],
    ['two deployments with one target', doc(GOOGLE, `    deployments:\n      - { name: a, target: "${G}" }\n      - { name: b, target: "${G}" }\n`),
     'target the same resource'],
  ];
  for (const [label, text, message, opts] of cases) {
    test(label, () => {
      const res = loadSemanticModels([{name: 'sales', text}], opts);
      expect(res.error).toContain("Model document 'sales'");
      expect(res.error).toContain(message);
    });
  }
});


// Each name the loader reads is held to its kind's pattern (see names.ts and
// names.test.ts for the rules themselves). These pin that every kind is
// checked on load, with the scope named where the name alone does not say it.
describe('names are checked on load', () => {
  // A small model in which each name can be replaced.
  const doc = (n: Partial<Record<
      'model'|'entity'|'field'|'relationship'|'metric'|'deployment', string>> = {}) => ({
    name: n.model ?? 'sales-analytics',
    deployments: [{
      name: n.deployment ?? 'prod-us',
      target: 'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g',
    }],
    datasets: [
      { name: n.entity ?? 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
        fields: [
          { name: 'id', expression: 'id' },
          { name: n.field ?? '_customer_id', expression: 'customer_id' },
        ] },
      { name: 'customers', source: 'bigquery:p.d.customers', primary_key: ['id'], fields: [] },
    ],
    relationships: [{
      name: n.relationship ?? 'orders_to_customers', from: n.entity ?? 'orders',
      to: 'customers', from_columns: [n.field ?? '_customer_id'], to_columns: ['id'],
    }],
    metrics: [{ name: n.metric ?? 'order_count', expression: `COUNT(${n.entity ?? 'orders'}.id)` }],
  });

  test('valid names load, with a hyphen in the model and deployment names and a leading underscore in a field', () => {
    expect(load(GOOGLE, doc()).models[0].name).toBe('sales-analytics');
  });

  test('each kind rejects a name that breaks its pattern', () => {
    const cases: Array<[Parameters<typeof doc>[0], string]> = [
      [{ model: 'sales/orders' }, "Model name 'sales/orders' is not valid"],
      [{ entity: 'my-entity' }, "Entity name 'my-entity' is not valid"],
      [{ field: 'order date' }, "dataset 'orders': Field name 'order date' is not valid"],
      [{ relationship: 'placed-by' }, "Relationship name 'placed-by' is not valid"],
      [{ metric: '2024_orders' }, "Metric name '2024_orders' is not valid"],
      [{ deployment: 'prod,us' }, "model 'sales-analytics': Deployment name 'prod,us' is not valid"],
    ];
    for (const [names, message] of cases) {
      expect(() => load(GOOGLE, doc(names))).toThrow(message);
    }
  });

  test('a name over its length limit is rejected', () => {
    expect(() => load(GOOGLE, doc({ entity: 'e'.repeat(501) })))
        .toThrow('is 501 characters long; names may be at most 500 characters.');
    expect(() => load(GOOGLE, doc({ field: 'f'.repeat(301) })))
        .toThrow('is 301 characters long; names may be at most 300 characters.');
    expect(load(GOOGLE, doc({ entity: 'e'.repeat(500), field: 'f'.repeat(300) })).models)
        .toHaveLength(1);
  });

  test('a deployment name in a vanilla GOOGLE block is checked on load', () => {
    const vanilla = {
      name: 'sales',
      custom_extensions: [{
        vendor_name: 'GOOGLE',
        data: JSON.stringify({deployments: [{
          name: 'prod,us',
          target: 'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g',
        }]}),
      }],
      datasets: [{
        name: 'orders', source: 'bigquery:p.d.orders', primary_key: ['id'],
        fields: [{name: 'id', expression: {dialects: [{dialect: 'ANSI_SQL', expression: 'id'}]}}],
      }],
    };
    expect(() => load(VANILLA, vanilla))
        .toThrow("model 'sales': Deployment name 'prod,us' is not valid");
  });

  test('a vanilla document is held to the same patterns', () => {
    const vanilla = doc({ entity: 'my-entity' }) as any;
    delete vanilla.deployments;
    expect(() => load(VANILLA, vanilla)).toThrow("Entity name 'my-entity' is not valid");
  });
});
