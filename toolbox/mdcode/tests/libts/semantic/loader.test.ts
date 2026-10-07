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
import { databaseOf, loadModels, fromDocument } from '../../../src/libts/semantic/loader';
import { isTimeDimension, DATA_TYPES } from '../../../src/libts/semantic/ir';
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

  test('a malformed GOOGLE block is kept verbatim without warning (not parsed)', () => {
    const { models, warnings } = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        custom_extensions: [{ vendor_name: 'GOOGLE', data: '{not json' }],
        datasets: [{ name: 'a', source: 'bigquery:p.d.a', primary_key: ['id'], fields: [] }],
      }],
    });
    // The loader never parses the block, so malformed JSON is not its concern.
    expect(models[0].customExtensions).toEqual([{ vendorName: 'GOOGLE', data: '{not json' }]);
    expect(warnings).toEqual([]);
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

  test("a top-level 'deployment_target' folds into the GOOGLE block form", () => {
    const sugar = fromDocument({ version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm', deployment_target: URI,
        datasets: [{ name: 'a', source: 'bigquery:p.d.s', primary_key: ['id'],
          fields: [{ name: 'id', expression: 'id' }] }],
      }],
    });
    const explicit = fromDocument({ version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        custom_extensions: [{ vendor_name: 'GOOGLE',
          data: JSON.stringify({ deploymentTargets: [URI] }) }],
        datasets: [{ name: 'a', source: 'bigquery:p.d.s', primary_key: ['id'],
          fields: [{ name: 'id', expression: expr('id') }] }],
      }],
    });
    expect(sugar.models[0].customExtensions)
      .toEqual(explicit.models[0].customExtensions);
    expect(sugar.models[0].customExtensions).toEqual([
      { vendorName: 'GOOGLE',
        data: JSON.stringify({ deploymentTargets: [URI] }) },
    ]);
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
        expect(irAt(run().models[0], level).customExtensions)
          .toEqual([{ vendorName: 'GOOGLE', data: '{}' }]);
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
    expect(m.relationships[0].customExtensions)
      .toEqual([{ vendorName: 'GOOGLE', data: '{"description": "d"}' }]);
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
      'MySQL catalog name',
      'mysql:inst.db.orders',
      'mysql:inst.db.orders',
    ],
    [
      'Cloud SQL PostgreSQL catalog name',
      'cloudsql_postgresql:acme.us-central1.inst.db.public.orders',
      'cloudsql_postgresql:acme.us-central1.inst.db.public.orders',
    ],
    [
      'PostgreSQL catalog name',
      'postgresql:inst.db.public.orders',
      'postgresql:inst.db.public.orders',
    ],
    [
      'Snowflake catalog name',
      'snowflake:acct.db.public.orders',
      'snowflake:acct.db.public.orders',
    ],
    [
      'Databricks catalog name',
      'databricks:table:metastore.cat.sch.orders',
      'databricks:table:metastore.cat.sch.orders',
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

    // 2. Bare table names (1-, 2-, and 3-part)
    for (const bare of ['orders', 'raw.orders', 'acme.raw.orders']) {
      expect(() => load(GOOGLE, {
        name: 'm',
        datasets: [{ name: 'orders', source: bare, primary_key: ['id'], fields: [] }],
      })).toThrow(
        new RegExp(`dataset 'orders': bare table name '${bare}' is not a valid source[\\s\\S]*//bigquery\\.googleapis\\.com/[\\s\\S]*bigquery:`),
      );
      // Passes when allowLegacyBareSource is set
      const { models } = load(GOOGLE, {
        name: 'm',
        datasets: [{ name: 'orders', source: bare, primary_key: ['id'], fields: [] }],
      }, { allowLegacyBareSource: true, defaultProject: 'acme', defaultDataset: 'raw' });
      expect(models[0].entities[0].authoredSource).toBe(bare);
      expect(models[0].entities[0].dataSource).toBe('acme.raw.orders');
    }

    // 3. Four-part bare table name suggests BigLake URI
    expect(() => load(GOOGLE, {
      name: 'm',
      datasets: [{ name: 'orders', source: 'acme.lake.sales.orders', primary_key: ['id'], fields: [] }],
    })).toThrow(
      "dataset 'orders': bare table name 'acme.lake.sales.orders' is not a valid source. Write a BigLake resource URI instead:\n  source: //biglake.googleapis.com/projects/acme/catalogs/lake/namespaces/sales/tables/orders",
    );

    // 4. Overlong source (> 4000 characters)
    const overlong = `bigquery:acme.sales.${'a'.repeat(4000)}`;
    expect(() => load(GOOGLE, {
      name: 'm',
      datasets: [{ name: 'orders', source: overlong, primary_key: ['id'], fields: [] }],
    })).toThrow(/exceeds the 4000-character limit/);

    // 5. Unknown prefix / unsupported URI
    for (const bad of ['custom:foo', 'trino:cat.sch.tbl', 'bigtable:p.i.t', '//trino.example.com/anything']) {
      expect(() => load(GOOGLE, {
        name: 'm',
        datasets: [{ name: 'orders', source: bad, primary_key: ['id'], fields: [] }],
      })).toThrow(
        new RegExp(`dataset 'orders': source '${bad}' is not a valid table reference`),
      );
    }
  });
});

