// Behavior specification for the semantic-model loader
// (src/libts/semantic/loader.ts).
//
// The loader reads the subset of an open, AI-first semantics format needed to
// normalize a model into the IR. Each test names one behavior. Focused tests
// use `fromDocument` with object literals; document-level tests parse raw
// YAML/JSON text via `loadModels`. This file asserts only the IR — the BigQuery
// generator is covered by `bigquery.test.ts` (unit) and `bigquery.e2e.test.ts`
// (file -> DDL).
//

import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'fs';
import {join} from 'path';

import {DATA_TYPES, isTimeDimension} from '../../../src/libts/semantic/ir';
import {fromDocument, loadModels} from '../../../src/libts/semantic/loader';

// Shorthand for the format's per-dialect expression object.
function expr(expression: string, dialect = 'BIGQUERY') {
  return {dialects: [{dialect, expression}]};
}


describe('dataset source strings normalize to fully-qualified references', () => {
  const {models} = fromDocument(
      {
        semantic_model: [{
          name: 'm',
          datasets: [
            {name: 'a', source: 'proj.ds.tbl', primary_key: ['id'], fields: []},
            {name: 'b', source: 'ds.tbl', primary_key: ['id'], fields: []},
            {name: 'c', source: 'tbl', primary_key: ['id'], fields: []},
          ],
        }],
      },
      {defaultProject: 'P', defaultDataset: 'D'});
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

  test('a query-like source is kept verbatim with a warning', () => {
    const {models, warnings} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'a',
          source: 'SELECT 1 FROM t',
          primary_key: ['id'],
          fields: []
        }]
      }],
    });
    expect(models[0].entities[0].dataSource).toBe('SELECT 1 FROM t');
    expect(warnings.some(w => w.includes('looks like a query'))).toBe(true);
  });

  test('a dataset without a primary key warns (its KEY would be empty)', () => {
    const {warnings} = fromDocument({
      semantic_model:
          [{name: 'm', datasets: [{name: 'a', source: 'a', fields: []}]}],
    });
    expect(warnings.some(w => w.includes('no primary_key'))).toBe(true);
  });

  test('backtick- or double-quoted identifiers are unquoted', () => {
    const {models} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'a',
          source: '`proj`.`ds`.`tbl`',
          primary_key: ['id'],
          fields: []
        }]
      }],
    });
    expect(models[0].entities[0].dataSource).toBe('proj.ds.tbl');
  });

  test('a four-part Lakehouse catalog name passes through untouched', () => {
    const {models, warnings} = fromDocument(
        {
          semantic_model: [{
            name: 'm',
            datasets: [{
              name: 'a',
              source: 'proj.cat.ns.tbl',
              primary_key: ['id'],
              fields: []
            }]
          }],
        },
        {defaultProject: 'P', defaultDataset: 'D'});
    expect(models[0].entities[0].dataSource).toBe('proj.cat.ns.tbl');
    expect(warnings).toEqual([]);
  });

  test(
      'an explicit project/dataset in the source is not overridden by defaults',
      () => {
        const {models} = fromDocument(
            {
              semantic_model: [{
                name: 'm',
                datasets: [{
                  name: 'a',
                  source: 'realproj.realds.tbl',
                  primary_key: ['id'],
                  fields: []
                }]
              }],
            },
            {defaultProject: 'P', defaultDataset: 'D'});
        expect(models[0].entities[0].dataSource).toBe('realproj.realds.tbl');
      });
});


describe('per-dialect expressions collapse to a single string', () => {
  function metricDoc(
      dialectList: Array<{dialect: string; expression: string}>) {
    return {
      semantic_model: [{
        name: 'm',
        datasets: [
          {name: 'orders', source: 'orders', primary_key: ['id'], fields: []}
        ],
        metrics: [{name: 'mx', expression: {dialects: dialectList}}],
      }],
    };
  }

  test(
      'the preferred dialect (BIGQUERY) is chosen with no warning or provenance',
      () => {
        const {models, warnings} = fromDocument(metricDoc([
          {dialect: 'ANSI_SQL', expression: 'SUM(orders.a)'},
          {dialect: 'BIGQUERY', expression: 'SUM(orders.b)'},
        ]));
        expect(models[0].metrics[0].expression).toBe('SUM(orders.b)');
        expect(warnings.some(w => w.includes('dialect'))).toBe(false);
        // Target dialect is already valid; no imported (vendor) form to
        // preserve.
        expect(models[0].metrics[0].importedExpression).toBeUndefined();
      });

  test(
      'ANSI_SQL is the fallback when the preferred dialect is absent, with an informational note',
      () => {
        const {models, warnings} = fromDocument(metricDoc([
          {dialect: 'ANSI_SQL', expression: 'SUM(orders.a)'},
        ]));
        expect(models[0].metrics[0].expression).toBe('SUM(orders.a)');
        expect(warnings.some(
                   w => w.startsWith('note:') &&
                       w.includes('using the portable \'ANSI_SQL\'')))
            .toBe(true);
        // The portable canonical dialect targets BigQuery by design; no
        // imported form.
        expect(models[0].metrics[0].importedExpression).toBeUndefined();
      });

  test(
      'a vendor-only expression is kept as imported_expression, with no target expression',
      () => {
        const {models, warnings} = fromDocument(metricDoc([
          {dialect: 'SNOWFLAKE', expression: 'SUM(orders.a)'},
        ]));
        // No target/canonical form, so the target `expression` is left unset
        // and the original vendor SQL is preserved for a later transpile pass.
        expect(models[0].metrics[0].expression).toBeUndefined();
        expect(models[0].metrics[0].importedExpression).toBe('SUM(orders.a)');
        expect(models[0].metrics[0].importedDialect).toBe('SNOWFLAKE');
        expect(warnings.some(
                   w => w.includes('\'SNOWFLAKE\'') &&
                       w.includes('imported_expression')))
            .toBe(true);
      });

  test('an explicit dialect option overrides the default preference', () => {
    const {models} = fromDocument(
        metricDoc([
          {dialect: 'SNOWFLAKE', expression: 'SF'},
          {dialect: 'BIGQUERY', expression: 'BQ'},
        ]),
        {dialect: 'SNOWFLAKE'});
    expect(models[0].metrics[0].expression).toBe('SF');
  });

  test('dialect names are matched case-insensitively', () => {
    const {models, warnings} = fromDocument(
        metricDoc([
          {dialect: 'BigQuery', expression: 'SUM(orders.a)'},
        ]),
        {dialect: 'bigquery'});
    expect(models[0].metrics[0].expression).toBe('SUM(orders.a)');
    expect(warnings.some(w => w.includes('dialect'))).toBe(false);
  });

  test(
      'field expressions select their dialect independently of metrics', () => {
        const {models, warnings} = fromDocument({
          semantic_model: [{
            name: 'm',
            datasets: [{
              name: 'orders',
              source: 'orders',
              primary_key: ['id'],
              fields: [
                {name: 'id', expression: expr('orders.id')},
                {
                  name: 'net',
                  expression: {
                    dialects: [{
                      dialect: 'ANSI_SQL',
                      expression: 'orders.gross - orders.tax'
                    }]
                  }
                },
                {
                  name: 'label',
                  expression: {
                    dialects: [{
                      dialect: 'SNOWFLAKE',
                      expression: 'IFF(orders.ok, \'y\', \'n\')'
                    }]
                  }
                },
              ],
            }],
          }],
        });
        const fields = models[0].entities[0].fields;
        expect(fields[0].expression)
            .toBe('orders.id');  // BIGQUERY, no fallback
        expect(fields[1].expression)
            .toBe('orders.gross - orders.tax');  // ANSI_SQL fallback
        expect(fields[2].expression)
            .toBeUndefined();  // no target/canonical form
        expect(fields[2].importedExpression)
            .toBe(
                'IFF(orders.ok, \'y\', \'n\')');  // SNOWFLAKE, kept as imported
        // The canonical-fallback note is field-agnostic (so it dedupes); the
        // point here is that the two fields still pick their expressions
        // independently.
        expect(
            warnings.some(w => w.includes('using the portable \'ANSI_SQL\'')))
            .toBe(true);
        // The imported (vendor) dialect is recorded only for the vendor field,
        // so the transpile pass rewrites just that one.
        expect(fields[0].importedDialect).toBeUndefined();
        expect(fields[1].importedDialect).toBeUndefined();
        expect(fields[2].importedDialect).toBe('SNOWFLAKE');
      });
});


describe('relationships map onto the direct-FK IR convention', () => {
  const {models} = fromDocument({
    semantic_model: [{
      name: 'm',
      datasets: [
        {
          name: 'orders',
          source: 'orders',
          primary_key: ['order_id'],
          fields: []
        },
        {
          name: 'customers',
          source: 'customers',
          primary_key: ['customer_id'],
          fields: []
        },
      ],
      relationships: [{
        name: 'orders_customers',
        from: 'orders',
        to: 'customers',
        from_columns: ['customer_id'],
        to_columns: ['customer_id'],
      }],
    }],
  });
  const rel = models[0].relationships[0];

  test('the source end carries the from_columns (the FK columns)', () => {
    expect(rel.source).toEqual({entity: 'orders', columns: ['customer_id']});
  });

  test(
      'the destination end carries the to_columns (the referenced key columns)',
      () => {
        expect(rel.destination)
            .toEqual({entity: 'customers', columns: ['customer_id']});
      });

  test('a composite foreign key maps column-for-column', () => {
    const {models} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [
          {
            name: 'sales',
            source: 'sales',
            primary_key: ['sale_id'],
            fields: []
          },
          {
            name: 'stores',
            source: 'stores',
            primary_key: ['region', 'store_no'],
            fields: []
          },
        ],
        relationships: [{
          name: 'sales_stores',
          from: 'sales',
          to: 'stores',
          from_columns: ['region', 'store_no'],
          to_columns: ['region', 'store_no'],
        }],
      }],
    });
    const rel = models[0].relationships[0];
    expect(rel.source.columns).toEqual(['region', 'store_no']);
    expect(rel.destination.columns).toEqual(['region', 'store_no']);
  });

  test(
      'the source columns come from from_columns, not the from dataset PK',
      () => {
        // The FK columns are taken straight from from_columns; the source
        // entity's own primary key is looked up from the entity by downstream
        // consumers, never duplicated onto the relationship (so a missing
        // from-PK is irrelevant here).
        const {models} = fromDocument({
          semantic_model: [{
            name: 'm',
            datasets: [
              {name: 'orders', source: 'orders', fields: []},  // no primary_key
              {
                name: 'customers',
                source: 'customers',
                primary_key: ['customer_id'],
                fields: []
              },
            ],
            relationships: [{
              name: 'r',
              from: 'orders',
              to: 'customers',
              from_columns: ['customer_id'],
              to_columns: ['customer_id'],
            }],
          }],
        });
        expect(models[0].relationships[0].source)
            .toEqual({entity: 'orders', columns: ['customer_id']});
      });

  test('an unresolved to dataset is a hard error', () => {
    expect(() => fromDocument({
             semantic_model: [{
               name: 'm',
               datasets: [{
                 name: 'orders',
                 source: 'orders',
                 primary_key: ['order_id'],
                 fields: []
               }],
               relationships: [{
                 name: 'r',
                 from: 'orders',
                 to: 'ghost',
                 from_columns: ['g_id'],
                 to_columns: ['id'],
               }],
             }],
           }))
        .toThrow(/'to' dataset 'ghost' is not defined/);
  });

  test('an unresolved from dataset is a hard error', () => {
    expect(() => fromDocument({
             semantic_model: [{
               name: 'm',
               datasets: [{
                 name: 'customers',
                 source: 'customers',
                 primary_key: ['customer_id'],
                 fields: []
               }],
               relationships: [{
                 name: 'r',
                 from: 'ghost',
                 to: 'customers',
                 from_columns: ['c_id'],
                 to_columns: ['customer_id'],
               }],
             }],
           }))
        .toThrow(/'from' dataset 'ghost' is not defined/);
  });

  test('mismatched from_columns/to_columns arity is a hard error', () => {
    expect(() => fromDocument({
             semantic_model: [{
               name: 'm',
               datasets: [
                 {
                   name: 'orders',
                   source: 'orders',
                   primary_key: ['order_id'],
                   fields: []
                 },
                 {
                   name: 'customers',
                   source: 'customers',
                   primary_key: ['a', 'b'],
                   fields: []
                 },
               ],
               relationships: [{
                 name: 'r',
                 from: 'orders',
                 to: 'customers',
                 from_columns: ['x', 'y'],
                 to_columns: ['a'],
               }],
             }],
           }))
        .toThrow(/different lengths/);
  });
});

describe('abstract datasets and their source constraint', () => {
  test('a non-abstract dataset with no source is a hard error', () => {
    expect(() => fromDocument({
             semantic_model: [{
               name: 'm',
               datasets: [{name: 'orders', primary_key: ['id'], fields: []}],
             }],
           }))
        .toThrow(/non-abstract dataset requires a source/);
  });

  test(
      'an abstract dataset that also declares a source is a hard error', () => {
        // abstract == no physical table; a source would be silently ignored by
        // the BigQuery leg, dropping a table the author intended, so reject the
        // combo.
        expect(() => fromDocument({
                 semantic_model: [{
                   name: 'm',
                   datasets: [{
                     name: 'Party',
                     source: 'proj.ds.party',
                     abstract: true,
                     primary_key: ['id'],
                     fields: [],
                   }],
                 }],
               }))
            .toThrow(/an abstract dataset has no table/);
      });

  test(
      'an abstract dataset with no source loads and is marked abstract', () => {
        const {models} = fromDocument({
          semantic_model: [{
            name: 'm',
            datasets: [{name: 'Party', abstract: true, fields: []}],
          }],
        });
        expect(models[0].entities[0].abstract).toBe(true);
        expect(models[0].entities[0].dataSource).toBe('');
      });

  test(
      'an abstract dataset\'s fields need no expression under a graph leg',
      () => {
        // The supertype has no table, so its fields carry no column -- they
        // name the label its subtypes bind. The strict (graph-leg) schema must
        // accept them even though a concrete dataset's field would require an
        // expression.
        const { models } = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [
          {
            name: 'Party', abstract: true, primary_key: ['id'],
            fields: [{ name: 'id' }, { name: 'name' }],
          },
          {
            name: 'Customer', extends: ['Party'], primary_key: ['id'],
            source: 'proj.ds.customer',
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

  test(
      'a CONCRETE dataset\'s expression-less field still fails under a graph leg',
      () => {
        // The abstract exemption must not leak to concrete datasets: a real
        // table's field still needs a column (or an explicit `unbound`).
        expect(
            () => fromDocument({
              semantic_model: [{
                name: 'm',
                datasets: [{
                  name: 'orders',
                  primary_key: ['id'],
                  source: 'proj.ds.orders',
                  fields: [{name: 'id', expression: 'o_id'}, {name: 'total'}],
                }],
              }],
            }))
            .toThrow(/field 'total': requires an expression/);
      });
});


describe('metrics infer their referenced entities from the expression', () => {
  test('a single referenced entity becomes the metric attach entity', () => {
    const {models} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'order_items',
          source: 'order_items',
          primary_key: ['id'],
          fields: []
        }],
        metrics: [
          {name: 'total_revenue', expression: expr('SUM(order_items.amount)')}
        ],
      }],
    });
    expect(models[0].metrics[0].entity).toBe('order_items');
  });

  test(
      'a metric spanning multiple entities has no single attach entity', () => {
        // A cross-entity metric references known entities but cannot hang off
        // one node, so `entity` is left undefined -- not a missing-entity
        // warning.
        const {models, warnings} = fromDocument({
          semantic_model: [{
            name: 'm',
            datasets: [
              {
                name: 'orders',
                source: 'orders',
                primary_key: ['id'],
                fields: []
              },
              {
                name: 'customers',
                source: 'customers',
                primary_key: ['id'],
                fields: []
              },
            ],
            metrics: [{
              name: 'ratio',
              expression: expr('SUM(orders.amount) / COUNT(customers.id)'),
            }],
          }],
        });
        expect(models[0].metrics[0].entity).toBeUndefined();
        expect(warnings.some(w => w.includes('references no known entity')))
            .toBe(false);
      });

  test('a metric referencing no known entity warns', () => {
    const {warnings} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'order_items',
          source: 'order_items',
          primary_key: ['id'],
          fields: []
        }],
        metrics: [{name: 'weird', expression: expr('SUM(unknown.x)')}],
      }],
    });
    expect(warnings.some(w => w.includes('references no known entity')))
        .toBe(true);
  });

  test(
      'a qualifier inside a string literal is not counted as a reference',
      () => {
        // 'customers.region' is data, not a column reference, so the metric
        // must be attributed only to order_items.
        const {models} = fromDocument({
          semantic_model: [{
            name: 'm',
            datasets: [
              {
                name: 'order_items',
                source: 'order_items',
                primary_key: ['id'],
                fields: []
              },
              {
                name: 'customers',
                source: 'customers',
                primary_key: ['id'],
                fields: []
              },
            ],
            metrics: [{
              name: 'tagged',
              expression:
                  expr('CONCAT(SUM(order_items.amount), \'customers.region\')'),
            }],
          }],
        });
        expect(models[0].metrics[0].entity).toBe('order_items');
      });

  test(
      'a backtick-quoted entity qualifier is recognized (BigQuery quoting)',
      () => {
        // BigQuery quotes identifiers with backticks; `orders`.amount must
        // still be attributed to the orders entity, not dropped as unqualified.
        const {models, warnings} = fromDocument({
          semantic_model: [{
            name: 'm',
            datasets: [{
              name: 'orders',
              source: 'orders',
              primary_key: ['id'],
              fields: []
            }],
            metrics: [{name: 'rev', expression: expr('SUM(`orders`.amount)')}],
          }],
        });
        expect(models[0].metrics[0].entity).toBe('orders');
        expect(warnings.some(w => w.includes('references no known entity')))
            .toBe(false);
      });
});


describe('document-level handling', () => {
  test('a mismatched version warns but still loads', () => {
    const {models, warnings} = fromDocument({
      version: '9.9.9',
      semantic_model: [{
        name: 'm',
        datasets: [{name: 'a', source: 'a', primary_key: ['id'], fields: []}]
      }],
    });
    expect(models).toHaveLength(1);
    expect(warnings.some(w => w.includes('differs from the supported')))
        .toBe(true);
  });

  test(
      'unknown/extra fields outside the subset are ignored, not errors', () => {
        const {models} = fromDocument({
          semantic_model: [{
            name: 'm',
            ai_context: {instructions: 'ignored'},
            custom_extensions: [{vendor_name: 'X', data: '{}'}],
            datasets: [{
              name: 'a',
              source: 'a',
              primary_key: ['id'],
              unique_keys: [['id']],
              fields: [{
                name: 'id',
                label: 'ignored',
                dimension: {is_time: false},
                expression: expr('a.id'),
              }],
            }],
          }],
        });
        expect(models[0].entities[0].fields[0].name).toBe('id');
      });

  test(
      'duplicate dataset names warn (only one node table can carry the label)',
      () => {
        const {warnings} = fromDocument({
          semantic_model: [{
            name: 'm',
            datasets: [
              {name: 'orders', source: 'a', primary_key: ['id'], fields: []},
              {name: 'orders', source: 'b', primary_key: ['id'], fields: []},
            ],
          }],
        });
        expect(
            warnings.some(w => w.includes('duplicate dataset name \'orders\'')))
            .toBe(true);
      });

  test('each semantic_model entry becomes its own IR model', () => {
    const {models} = fromDocument({
      semantic_model: [
        {
          name: 'first',
          datasets: [{name: 'a', source: 'a', primary_key: ['id'], fields: []}]
        },
        {
          name: 'second',
          datasets: [{name: 'b', source: 'b', primary_key: ['id'], fields: []}]
        },
      ],
    });
    expect(models.map(m => m.name)).toEqual(['first', 'second']);
  });

  test('model and metric descriptions carry through to the IR', () => {
    const {models} = fromDocument({
      semantic_model: [{
        name: 'm',
        description: 'a sales model',
        datasets: [
          {name: 'orders', source: 'orders', primary_key: ['id'], fields: []}
        ],
        metrics: [{
          name: 'c',
          description: 'row count',
          expression: expr('COUNT(orders.id)')
        }],
      }],
    });
    expect(models[0].description).toBe('a sales model');
    expect(models[0].metrics[0].description).toBe('row count');
  });

  test('JSON text loads identically to YAML (yaml.parse accepts JSON)', () => {
    const json = JSON.stringify({
      semantic_model: [{
        name: 'm',
        datasets: [
          {name: 'a', source: 'proj.ds.tbl', primary_key: ['id'], fields: []}
        ],
      }],
    });
    const {models} = loadModels(json);
    expect(models[0].entities[0].dataSource).toBe('proj.ds.tbl');
  });

  test('a document without semantic_model throws', () => {
    expect(() => fromDocument({foo: 'bar'}))
        .toThrow(/Semantic model load error/);
  });

  test('an empty semantic_model array throws (min one model required)', () => {
    expect(() => fromDocument({semantic_model: []}))
        .toThrow(/Semantic model load error/);
  });

  test('unparseable input throws', () => {
    expect(() => loadModels('{ this is : not valid')).toThrow(/load error/);
  });
});


describe('richer IR fields carry through from the format', () => {
  test('field and metric datatype populate the IR type', () => {
    const {models} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'orders',
          source: 'orders',
          primary_key: ['id'],
          fields: [{
            name: 'amount',
            datatype: 'Decimal',
            expression: expr('orders.amount')
          }],
        }],
        metrics: [{
          name: 'total',
          datatype: 'Decimal',
          expression: expr('SUM(orders.amount)')
        }],
      }],
    });
    expect(models[0].entities[0].fields[0].type).toBe('Decimal');
    expect(models[0].metrics[0].type).toBe('Decimal');
  });

  test(
      'an off-vocabulary datatype is rejected (closed, case-sensitive enum)',
      () => {
        // Lowercase 'date' is not in the vocabulary (only 'Date' is); the
        // closed enum makes this a hard parse error rather than a silently
        // mis-typed field.
        expect(() => fromDocument({
                 semantic_model: [{
                   name: 'm',
                   datasets: [{
                     name: 'orders',
                     source: 'orders',
                     primary_key: ['id'],
                     fields: [{
                       name: 'created',
                       datatype: 'date',
                       expression: expr('orders.created')
                     }],
                   }],
                 }],
               }))
            .toThrow(/Semantic model load error/);
      });

  test('a dataset unique_keys becomes Entity.uniqueKeys', () => {
    const {models} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'orders',
          source: 'orders',
          primary_key: ['id'],
          unique_keys: [['sku', 'region'], ['external_id']],
          fields: [],
        }],
      }],
    });
    expect(models[0].entities[0].uniqueKeys).toEqual([
      ['sku', 'region'], ['external_id']
    ]);
  });

  test(
      'the GOOGLE block is carried verbatim, not interpreted at load time',
      () => {
        const {models} = fromDocument({
          semantic_model: [{
            name: 'm',
            custom_extensions: [
              {vendor_name: 'OTHER', data: '{"ignored": true}'},
              {
                vendor_name: 'GOOGLE',
                data: JSON.stringify(
                    {deploymentTargets: ['projects/p/locations/us/graphs/g']})
              },
            ],
            datasets:
                [{name: 'a', source: 'a', primary_key: ['id'], fields: []}],
          }],
        });
        // GOOGLE gets no special treatment -- it rides along in
        // customExtensions like any other vendor block; a typed deployment view
        // is a consumer concern.
        expect(models[0].customExtensions).toEqual([
          {vendorName: 'OTHER', data: '{"ignored": true}'},
          {
            vendorName: 'GOOGLE',
            data: JSON.stringify(
                {deploymentTargets: ['projects/p/locations/us/graphs/g']})
          },
        ]);
      });

  test(
      'a malformed GOOGLE block is kept verbatim without warning (not parsed)',
      () => {
        const {models, warnings} = fromDocument({
          semantic_model: [{
            name: 'm',
            custom_extensions: [{vendor_name: 'GOOGLE', data: '{not json'}],
            datasets:
                [{name: 'a', source: 'a', primary_key: ['id'], fields: []}],
          }],
        });
        // The loader never parses the block, so malformed JSON is not its
        // concern.
        expect(models[0].customExtensions).toEqual([
          {vendorName: 'GOOGLE', data: '{not json'}
        ]);
        expect(warnings).toEqual([]);
      });

  test(
      'ai_context instructions and synonyms are structural, not folded into description',
      () => {
        const {models} = fromDocument({
          semantic_model: [{
            name: 'm',
            description: 'a sales model',
            ai_context: {
              instructions: 'Prefer net revenue.',
              synonyms: ['sales', 'commerce']
            },
            datasets: [{
              name: 'orders',
              source: 'orders',
              primary_key: ['id'],
              ai_context:
                  {instructions: 'One row per order.', synonyms: ['purchases']},
              fields: [{
                name: 'amount',
                expression: expr('orders.amount'),
                ai_context: {instructions: 'Gross, before tax.'},
              }],
            }],
          }],
        });
        const model = models[0];
        // Description stays the base text; instructions/synonyms live on
        // aiContext.
        expect(model.description).toBe('a sales model');
        expect(model.aiContext?.instructions).toBe('Prefer net revenue.');
        expect(model.aiContext?.synonyms).toEqual(['sales', 'commerce']);

        // Dataset-level: no base description supplied, so it stays unset;
        // instructions and synonyms are structural.
        const entity = model.entities[0];
        expect(entity.description).toBeUndefined();
        expect(entity.aiContext?.instructions).toBe('One row per order.');
        expect(entity.aiContext?.synonyms).toEqual(['purchases']);

        // Field-level: instructions structural; no description text was
        // supplied.
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
      ai_context: {
        instructions: 'Prefer net.',
        synonyms: ['commerce'],
        examples: ['revenue by month']
      },
      custom_extensions: [{
        vendor_name: 'GOOGLE',
        data: JSON.stringify(
            {deploymentTargets: ['projects/p/locations/us/graphs/g']})
      }],
      datasets: [
        {
          name: 'orders',
          source: 'proj.ds.orders',
          primary_key: ['order_id'],
          unique_keys: [['external_id']],
          description: 'One row per order',
          ai_context: {instructions: 'Grain: order.', synonyms: ['purchases']},
          custom_extensions: [{vendor_name: 'DBT', data: '{"model":"orders"}'}],
          fields: [{
            name: 'amount',
            expression: {
              dialects: [{dialect: 'BIGQUERY', expression: 'orders.amount'}]
            },
            dimension: {is_time: false},
            label: 'Order amount',
            description: 'Gross amount',
            datatype: 'Decimal',
            ai_context: {instructions: 'Before tax.', synonyms: ['gross']},
            custom_extensions: [{vendor_name: 'SNOWFLAKE', data: '{}'}],
          }],
        },
        {
          name: 'customers',
          source: 'proj.ds.customers',
          primary_key: ['customer_id'],
          fields: []
        },
      ],
      relationships: [{
        name: 'orders_customers',
        from: 'orders',
        to: 'customers',
        from_columns: ['customer_id'],
        to_columns: ['customer_id'],
        ai_context: {instructions: 'Each order has one customer.'},
        custom_extensions: [{vendor_name: 'COMMON', data: '{}'}],
      }],
      metrics: [{
        name: 'total_amount',
        expression: {
          dialects: [{dialect: 'BIGQUERY', expression: 'SUM(orders.amount)'}]
        },
        description: 'Total sales',
        datatype: 'Decimal',
        ai_context: {instructions: 'Sum of amounts.', synonyms: ['revenue']},
        custom_extensions: [{vendor_name: 'GOODDATA', data: '{}'}],
      }],
    }],
  };

  test('a maximal spec document loads without throwing', () => {
    expect(() => fromDocument(doc)).not.toThrow();
  });

  test(
      'nested custom_extensions do not produce warnings (accepted, validated)',
      () => {
        const {warnings} = fromDocument(doc);
        // No vendor extension is acted upon at load time; all are accepted
        // silently. No dialect fallbacks here either, so no notes.
        expect(warnings).toEqual([]);
      });

  test('nested custom_extensions are preserved verbatim at every level', () => {
    const {models} = fromDocument(doc);
    const m = models[0];
    // Model level: the raw GOOGLE block is kept verbatim, uninterpreted.
    expect(m.customExtensions).toEqual([
      {
        vendorName: 'GOOGLE',
        data: JSON.stringify(
            {deploymentTargets: ['projects/p/locations/us/graphs/g']})
      },
    ]);
    // Dataset / field / relationship / metric levels: kept verbatim, data
    // opaque.
    expect(m.entities[0].customExtensions).toEqual([
      {vendorName: 'DBT', data: '{"model":"orders"}'}
    ]);
    expect(m.entities[0].fields[0].customExtensions).toEqual([
      {vendorName: 'SNOWFLAKE', data: '{}'}
    ]);
    expect(m.relationships[0].customExtensions).toEqual([
      {vendorName: 'COMMON', data: '{}'}
    ]);
    expect(m.metrics[0].customExtensions).toEqual([
      {vendorName: 'GOODDATA', data: '{}'}
    ]);
  });

  test('every supported field maps into the IR', () => {
    const {models} = fromDocument(doc);
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

  test('all seven spec dialects and ten datatypes are accepted', () => {
    const dialects = [
      'ANSI_SQL', 'SNOWFLAKE', 'MDX', 'TABLEAU', 'DATABRICKS', 'MAQL',
      'BIGQUERY'
    ];
    const datatypes =
        [...DATA_TYPES];  // the loader accepts exactly the IR vocabulary
    const {models} = fromDocument({
      version: '0.2.0.dev0',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'd',
          source: 'd',
          primary_key: ['id'],
          fields: datatypes.map((dt, i) => ({
                                  name: `f${i}`,
                                  datatype: dt,
                                  expression: {
                                    dialects: [{
                                      dialect: dialects[i % dialects.length],
                                      expression: `d.c${i}`
                                    }]
                                  },
                                })),
        }],
      }],
    });
    expect(models[0].entities[0].fields.map(f => f.type)).toEqual(datatypes);
  });
});


// Reads a real fixture file from tests/libts/semantic/fixtures and returns its
// text, so these tests exercise the on-disk YAML path (loadModels) end to end
// rather than hand-built object literals.
function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

describe('gold fixtures parse from disk (real YAML files)', () => {
  test(
      'star_orders_customer.yaml: happy path (ai_context, time dimension, metrics)',
      () => {
        const {models} = loadModels(fixture('star_orders_customer.yaml'));
        expect(models).toHaveLength(1);
        const m = models[0];
        expect(m.name).toBe('sales');
        expect(m.aiContext?.instructions)
            .toBe('Use this model for order analysis.');
        expect(m.entities.map(e => e.name)).toEqual(['orders', 'customer']);
        expect(m.entities[0].keys).toEqual(['o_orderkey']);
        expect(m.relationships.map(r => r.name)).toEqual([
          'orders_to_customer'
        ]);

        const orderdate =
            m.entities[0].fields.find(f => f.name === 'o_orderdate')!;
        expect(orderdate.aiContext?.synonyms).toEqual(['order date', 'date']);
        // label and time-dimension role are structural now, not folded into
        // text.
        expect(orderdate.label).toBe('Order Date');
        expect(orderdate.dimension?.isTime).toBe(true);
        expect(isTimeDimension(orderdate)).toBe(true);
        expect(orderdate.description).toBeUndefined();

        const revenue = m.metrics.find(mt => mt.name === 'total_revenue')!;
        expect(revenue.expression).toBe('SUM(orders.o_totalprice)');
        expect(revenue.entity).toBe('orders');
        expect(revenue.aiContext?.synonyms).toEqual(['revenue', 'sales']);
        // order_count is entity-scoped (COUNT(orders.o_orderkey)) -> attach
        // entity inferred from the qualifier, so it is a valid single-entity
        // measure.
        const count = m.metrics.find(mt => mt.name === 'order_count')!;
        expect(count.entity).toBe('orders');
        expect(count.expression).toBe('COUNT(orders.o_orderkey)');
      });

  test(
      'vendor_dialects.yaml: non-target dialects kept as imported_expression',
      () => {
        const {models, warnings} = loadModels(fixture('vendor_dialects.yaml'));
        const m = models[0];
        expect(m.name).toBe('vendor_sales');

        const label =
            m.entities[0].fields.find(f => f.name === 'order_status_label')!;
        expect(label.expression).toBeUndefined();
        expect(label.importedDialect).toBe('SNOWFLAKE');
        expect(label.importedExpression).toContain('IFF(');

        const fulfilled =
            m.metrics.find(mt => mt.name === 'fulfilled_revenue')!;
        expect(fulfilled.expression).toBeUndefined();
        expect(fulfilled.importedDialect).toBe('SNOWFLAKE');
        expect(fulfilled.entity).toBe('orders');

        // Portable control metric still resolves to a target expression.
        const control = m.metrics.find(mt => mt.name === 'total_revenue')!;
        expect(control.expression).toBe('SUM(orders.o_totalprice)');

        expect(warnings.some(
                   w => w.includes('field \'orders.order_status_label\'') &&
                       w.includes('imported_expression')))
            .toBe(true);
      });

  test(
      'lineitem_databricks_ext.yaml: unique_keys + no-primary-key warning',
      () => {
        const {models, warnings} =
            loadModels(fixture('lineitem_databricks_ext.yaml'));
        const m = models[0];
        const orders = m.entities.find(e => e.name === 'orders')!;
        expect(orders.keys).toEqual([]);
        expect(orders.uniqueKeys).toEqual([['o_orderkey']]);
        expect(warnings.some(
                   w => w.includes('dataset \'lineitem\'') &&
                       w.includes('no primary_key')))
            .toBe(true);

        // custom_extensions are preserved verbatim at model / field /
        // relationship / metric levels.
        expect(m.customExtensions?.[0].vendorName).toBe('DATABRICKS');
        const lineitem = m.entities.find(e => e.name === 'lineitem')!;
        expect(lineitem.fields[0].customExtensions?.[0].vendorName)
            .toBe('DATABRICKS');
        expect(m.relationships[0].customExtensions?.[0].vendorName)
            .toBe('DATABRICKS');
        expect(
            m.metrics.find(mt => mt.name === 'revenue')!.customExtensions?.[0]
                .data)
            .toContain('currency');
      });

  test(
      'sales_google_ext.yaml: GOOGLE block verbatim + datatypes + unique_keys',
      () => {
        const {models} = loadModels(fixture('sales_google_ext.yaml'));
        const m = models[0];
        expect(m.customExtensions).toEqual([{
          vendorName: 'GOOGLE',
          data:
              '{"deploymentTargets": ["projects/demo/locations/us/entryGroups/@bigquery/entries/sales_graph"]}',
        }]);
        const orders = m.entities[0];
        expect(orders.uniqueKeys).toEqual([['o_orderkey'], ['o_ordernumber']]);
        expect(orders.fields.map(f => f.type)).toEqual([
          'Integer', 'String', 'Date', 'Decimal'
        ]);
        expect(m.metrics[0].type).toBe('Decimal');
        // Expressions are supplied in the BIGQUERY dialect (the default
        // target), so they resolve directly as `expression` -- exercising
        // pickDialect's target-dialect-present path, not the ANSI_SQL fallback.
        // Nothing is left as an imported (needs-transpile) form.
        expect(m.metrics[0].expression).toBe('SUM(orders.o_totalprice)');
        expect(m.metrics[0].importedExpression).toBeUndefined();
        expect(orders.fields.every(f => f.expression && !f.importedExpression))
            .toBe(true);
      });

  test(
      'ossie/tpcds_semantic_model.yaml: the Apache reference example loads',
      () => {
        // The unmodified spec-owner-authored example (interop proof).
        const {models, warnings} =
            loadModels(fixture('ossie/tpcds_semantic_model.yaml'));
        expect(models).toHaveLength(1);
        const m = models[0];
        expect(m.name).toBe('tpcds_retail_model');
        expect(m.entities).toHaveLength(5);
        expect(m.relationships).toHaveLength(4);
        expect(m.metrics).toHaveLength(5);

        // A cross-entity metric references more than one entity, so it has no
        // single attach entity.
        const clv =
            m.metrics.find(mt => mt.name === 'customer_lifetime_value')!;
        expect(clv.entity).toBeUndefined();

        // Every field and metric expression is ANSI_SQL -> resolves to a target
        // expression, so nothing is left needing transpilation.
        const needsTranspile =
            warnings.filter(w => w.includes('imported_expression'));
        expect(needsTranspile).toEqual([]);
      });
});

describe('duplicate names within a model warn (uniqueness checks)', () => {
  test('duplicate field names within a dataset warn', () => {
    const {warnings} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'orders',
          source: 'orders',
          primary_key: ['id'],
          fields: [
            {name: 'amount', expression: expr('orders.amount')},
            {name: 'amount', expression: expr('orders.amount2')},
          ],
        }],
      }],
    });
    expect(warnings.some(
               w => w.includes('dataset \'orders\'') &&
                   w.includes('duplicate field name \'amount\'')))
        .toBe(true);
  });

  test('duplicate metric names within a model warn', () => {
    const {warnings} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'orders',
          source: 'orders',
          primary_key: ['id'],
          fields: [{name: 'amount', expression: expr('orders.amount')}]
        }],
        metrics: [
          {name: 'total', expression: expr('SUM(orders.amount)')},
          {name: 'total', expression: expr('AVG(orders.amount)')},
        ],
      }],
    });
    expect(warnings.some(
               w => w.includes('model \'m\'') &&
                   w.includes('duplicate metric name \'total\'')))
        .toBe(true);
  });

  test('duplicate relationship names within a model warn', () => {
    const {warnings} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [
          {
            name: 'orders',
            source: 'orders',
            primary_key: ['o_id'],
            fields: [{name: 'c_id', expression: expr('orders.c_id')}]
          },
          {
            name: 'customer',
            source: 'customer',
            primary_key: ['c_id'],
            fields: [{name: 'c_id', expression: expr('customer.c_id')}]
          },
        ],
        relationships: [
          {
            name: 'o2c',
            from: 'orders',
            to: 'customer',
            from_columns: ['c_id'],
            to_columns: ['c_id']
          },
          {
            name: 'o2c',
            from: 'orders',
            to: 'customer',
            from_columns: ['c_id'],
            to_columns: ['c_id']
          },
        ],
      }],
    });
    expect(warnings.some(
               w => w.includes('model \'m\'') &&
                   w.includes('duplicate relationship name \'o2c\'')))
        .toBe(true);
  });
});


describe('field label and time-dimension role align with the format models', () => {
  // Builds one field with the given extra props and returns its IR form.
  function field(props: Record<string, unknown>) {
    const {models} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'd',
          source: 'd',
          primary_key: ['id'],
          fields: [{name: 'f', expression: expr('d.f'), ...props}],
        }],
      }],
    });
    return models[0].entities[0].fields[0];
  }

  test('label is preserved structurally, separate from description', () => {
    const f = field({label: 'Order Date', description: 'The order date'});
    expect(f.label).toBe('Order Date');
    expect(f.description).toBe('The order date');
  });

  test('a label alone is not mis-mapped into description', () => {
    const f = field({label: 'Order Date'});
    expect(f.label).toBe('Order Date');
    expect(f.description).toBeUndefined();
  });

  test('an explicit is_time:true makes it a time dimension', () => {
    const f = field({dimension: {is_time: true}});
    expect(f.dimension?.isTime).toBe(true);
    expect(isTimeDimension(f)).toBe(true);
  });

  test('an explicit is_time:false overrides a temporal datatype', () => {
    const f = field({dimension: {is_time: false}, datatype: 'Date'});
    expect(f.dimension?.isTime).toBe(false);
    expect(isTimeDimension(f)).toBe(false);
  });

  test(
      'a temporal datatype infers a time dimension when is_time is unset',
      () => {
        const f = field({dimension: {}, datatype: 'Date'});
        expect(f.dimension?.isTime).toBeUndefined();
        expect(isTimeDimension(f)).toBe(true);
      });

  test('a temporal datatype with no dimension block is not a dimension', () => {
    const f = field({datatype: 'Date'});
    expect(f.dimension).toBeUndefined();
    expect(isTimeDimension(f)).toBe(false);
  });

  test(
      'a non-temporal datatype with an empty dimension is not a time dimension',
      () => {
        const f = field({dimension: {}, datatype: 'String'});
        expect(isTimeDimension(f)).toBe(false);
      });
});


describe(
    'authoring sugars: entities alias, bare-string expression, deployment_target',
    () => {
      const URI =
          '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';

      test('\'entities:\' is an alias for \'datasets:\'', () => {
        const {models} = fromDocument({
          semantic_model: [{
            name: 'm',
            entities: [
              {
                name: 'a',
                source: 'proj.ds.tbl',
                primary_key: ['id'],
                fields: [{name: 'id', expression: expr('id')}]
              },
            ],
          }],
        });
        expect(models[0].entities.map(e => e.name)).toEqual(['a']);
        expect(models[0].entities[0].dataSource).toBe('proj.ds.tbl');
      });

      test('declaring both \'entities\' and \'datasets\' is an error', () => {
        expect(() => fromDocument({
                 semantic_model: [{
                   name: 'm',
                   entities: [{name: 'a', source: 's', fields: []}],
                   datasets: [{name: 'b', source: 's', fields: []}],
                 }],
               }))
            .toThrow(/set either 'entities' or 'datasets', not both/);
      });

      test(
          'a bare-string expression expands to the target-dialect object',
          () => {
            const {models} = fromDocument({
              semantic_model: [{
                name: 'm',
                datasets: [{
                  name: 'a',
                  source: 'proj.ds.tbl',
                  primary_key: ['id'],
                  fields: [{name: 'id', expression: 'id_col'}],
                }],
              }],
            });
            expect(models[0].entities[0].fields[0].expression).toBe('id_col');
          });

      test(
          'a top-level \'deployment_target\' folds into the GOOGLE block form',
          () => {
            const sugar = fromDocument({
              semantic_model: [{
                name: 'm',
                deployment_target: URI,
                datasets: [{
                  name: 'a',
                  source: 's',
                  primary_key: ['id'],
                  fields: [{name: 'id', expression: 'id'}]
                }],
              }],
            });
            const explicit = fromDocument({
              semantic_model: [{
                name: 'm',
                custom_extensions: [{
                  vendor_name: 'GOOGLE',
                  data: JSON.stringify({deploymentTargets: [URI]})
                }],
                datasets: [{
                  name: 'a',
                  source: 's',
                  primary_key: ['id'],
                  fields: [{name: 'id', expression: 'id'}]
                }],
              }],
            });
            expect(sugar.models[0].customExtensions)
                .toEqual(explicit.models[0].customExtensions);
            expect(sugar.models[0].customExtensions).toEqual([
              {
                vendorName: 'GOOGLE',
                data: JSON.stringify({deploymentTargets: [URI]})
              },
            ]);
          });

      test(
          '\'deployment_target\' agreeing with a GOOGLE block adds no duplicate',
          () => {
            const {models} = fromDocument({
              semantic_model: [{
                name: 'm',
                deployment_target: URI,
                custom_extensions: [{
                  vendor_name: 'GOOGLE',
                  data: JSON.stringify({deploymentTargets: [URI]})
                }],
                datasets: [{
                  name: 'a',
                  source: 's',
                  primary_key: ['id'],
                  fields: [{name: 'id', expression: 'id'}]
                }],
              }],
            });
            expect(models[0].customExtensions).toEqual([
              {
                vendorName: 'GOOGLE',
                data: JSON.stringify({deploymentTargets: [URI]})
              },
            ]);
          });

      test(
          '\'deployment_target\' disagreeing with a GOOGLE block is an error',
          () => {
            expect(() => fromDocument({
                     semantic_model: [{
                       name: 'm',
                       deployment_target: URI,
                       custom_extensions: [{
                         vendor_name: 'GOOGLE',
                         data: JSON.stringify(
                             {deploymentTargets: ['//other/target']})
                       }],
                       datasets: [{name: 'a', source: 's', fields: []}],
                     }],
                   }))
                .toThrow(/disagrees with the GOOGLE custom_extension/);
          });
    });

describe('fields may be declared unbound (no physical column)', () => {
  test('an unbound field loads with no expression', () => {
    const {models} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'a',
          source: 's',
          primary_key: ['id'],
          fields: [
            {name: 'id', expression: 'id'},
            {name: 'credit', unbound: true},
          ],
        }],
      }],
    });
    const [id, credit] = models[0].entities[0].fields;
    expect(id.unbound).toBeUndefined();
    expect(credit.unbound).toBe(true);
    expect(credit.expression).toBeUndefined();
  });

  test('a field that is both bound and unbound is an error', () => {
    expect(() => fromDocument({
             semantic_model: [{
               name: 'm',
               datasets: [{
                 name: 'a',
                 source: 's',
                 primary_key: ['id'],
                 fields: [{name: 'credit', unbound: true, expression: 'c'}]
               }],
             }],
           }))
        .toThrow(/an unbound field has no column/);
  });

  test(
      'a field that is neither bound nor unbound is an error naming the field',
      () => {
        expect(() => fromDocument({
                 semantic_model: [{
                   name: 'm',
                   datasets: [{
                     name: 'a',
                     source: 's',
                     primary_key: ['id'],
                     fields: [{name: 'credit'}]
                   }],
                 }],
               }))
            .toThrow(/field 'credit': requires an expression/);
      });
});


describe('a purely logical model loads only under bindingOptional', () => {
  // A logical-only model declares meaning (entities, fields, keys) with no
  // physical binding: no dataset `source`, no field `expression`. It is the
  // Knowledge-Catalog-only push case -- KC governs the logical layer and needs
  // no table or column to point at.
  const logicalOnly = {
    semantic_model: [{
      name: 'm',
      datasets: [{
        name: 'orders',
        primary_key: ['id'],
        fields: [{name: 'amount'}, {name: 'status'}],
      }],
    }],
  };

  test(
      'under bindingOptional it loads with an empty source and unbound fields',
      () => {
        const {models} = fromDocument(logicalOnly, {bindingOptional: true});
        const orders = models[0].entities[0];
        // No source -> empty dataSource (the emitter tolerates this); the
        // fields carry no expression because there is no binding.
        expect(orders.dataSource).toBe('');
        expect(orders.keys).toEqual(['id']);
        expect(orders.fields.map(f => f.name)).toEqual(['amount', 'status']);
        expect(orders.fields.every(f => f.expression === undefined)).toBe(true);
      });

  test(
      'without bindingOptional the same model fails for the missing source and expression',
      () => {
        let message = '';
        try {
          fromDocument(logicalOnly);
        } catch (e: any) {
          message = String(e.message ?? e);
        }
        // Both binding-completeness checks fire in the default (strict) mode.
        expect(message).toContain(
            'dataset \'orders\': a non-abstract dataset requires a source');
        expect(message).toContain('field \'amount\': requires an expression');
      });

  test(
      'bindingOptional still rejects an unbound field that also has an expression',
      () => {
        // The contradiction check is independent of binding-completeness, so it
        // fires even when a source/expression is otherwise optional.
        expect(
            () => fromDocument(
                {
                  semantic_model: [{
                    name: 'm',
                    datasets: [{
                      name: 'a',
                      fields: [{name: 'c', unbound: true, expression: 'c'}]
                    }],
                  }],
                },
                {bindingOptional: true}))
            .toThrow(/an unbound field has no column/);
      });

  test(
      'bindingOptional still rejects an abstract dataset that also names a source',
      () => {
        expect(
            () => fromDocument(
                {
                  semantic_model: [{
                    name: 'm',
                    datasets: [{
                      name: 'Party',
                      abstract: true,
                      source: 'p.d.party',
                      fields: []
                    }],
                  }],
                },
                {bindingOptional: true}))
            .toThrow(/an abstract dataset has no table/);
      });
});
