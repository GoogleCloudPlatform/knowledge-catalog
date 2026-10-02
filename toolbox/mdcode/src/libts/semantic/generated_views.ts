// Views a graph push generates next to the property graph (K2 / K3, proposed).
//
// A BigQuery graph element table must be a table or view whose KEY and
// SOURCE / DESTINATION KEY name columns. Two proposed constructs have no such
// table in the model, so the BigQuery leg generates one and deploys it before
// the graph that reads it:
//
//   - a vocabulary entity (ir.Entity.members, see vocabulary.ts) becomes a
//     `vocab_<entity>` view over its members, and each edge INTO a vocabulary
//     an `edge_<relationship>` view that matches the code case-insensitively;
//   - a derived relationship (ir.Relationship.via, see
//     derived_relationships.ts) becomes an `edge_<relationship>` view that
//     materializes its (source key, destination key) pairs over the chain.
//
// This module holds what both share: the generated-view record, the naming
// and qualification rules, and the small SQL helpers the view bodies use. It
// imports nothing from bigquery.ts, which consumes it.

import {Entity, fieldBinding} from './ir';
import {isSimpleIdentifier, quoteIfReserved} from './sql_identifiers';
import {stripQualifier} from './sql_expr_utils';

/** A view the BigQuery leg deploys before the graph that reads it. */
export interface GeneratedView {
  // The view's table name (no project / dataset), e.g. `vocab_order_status`.
  name: string;
  // The reference the graph DDL uses: `project.dataset.name` when the target
  // is known, otherwise as much of it as is.
  ref: string;
  // What the view backs: a vocabulary node table, or an edge table (a
  // vocabulary join or a derived relationship).
  kind: 'vocabulary'|'edge';
  // The `CREATE OR REPLACE VIEW` statement (no trailing semicolon).
  ddl: string;
}

/** Where generated views are created: the graph's own project and dataset. */
export interface ViewTarget {
  project?: string;
  dataset?: string;
}

/**
 * camelCase / PascalCase -> snake_case, the default-binding rule used across
 * kcmd projects (`OrderStatus` -> `order_status`, `HTTPServer` ->
 * `http_server`).
 */
export function snakeCase(name: string): string {
  return name.replace(/(?<=[a-z0-9])([A-Z])/g, '_$1')
      .replace(/(?<=[A-Z])([A-Z][a-z])/g, '_$1')
      .toLowerCase();
}

/** The name of the view that backs a generated edge table. */
export function edgeViewName(relationship: string): string {
  return `edge_${snakeCase(relationship)}`;
}

/** Qualifies a generated view's name with the graph's project / dataset. */
export function viewRef(name: string, target: ViewTarget): string {
  const parts = [target.dataset ? target.project : undefined, target.dataset,
                 name].filter((p): p is string => !!p);
  return parts.join('.');
}

/** The last dotted segment of a table reference (its table name). */
export function tableName(ref: string): string {
  const parts = ref.replace(/`/g, '').trim().split('.');
  return parts[parts.length - 1];
}

/**
 * The physical column a field of `entity` reads: its bound expression with the
 * entity qualifier stripped, or the field name itself when it is unbound or not
 * a declared field (already a raw column). Mirrors bigquery.ts physicalColumn.
 */
export function physicalColumnOf(entity: Entity, fieldName: string): string {
  const field = entity.fields.find(f => f.name === fieldName);
  const expr = field ? fieldBinding(field) : undefined;
  return expr !== undefined ? stripQualifier(expr, entity.name) : fieldName;
}

/**
 * A column read through a table alias: `alias.col` for a bare column
 * (backtick-quoted when reserved), the expression itself (parenthesized)
 * otherwise -- an expression names its own columns, so it cannot be prefixed.
 */
export function aliased(alias: string, column: string): string {
  return isSimpleIdentifier(column) ? `${alias}.${quoteIfReserved(column)}` :
                                      `(${column})`;
}

/** A BigQuery string literal, or a typed NULL when the value is absent. */
export function sqlString(value: string|undefined): string {
  if (value === undefined) return 'CAST(NULL AS STRING)';
  const escaped = value.replace(/\\/g, '\\\\')
                      .replace(/'/g, '\\\'')
                      .replace(/\n/g, '\\n')
                      .replace(/\r/g, '\\r')
                      .replace(/\t/g, '\\t');
  return `'${escaped}'`;
}

/** A BigQuery INT64 literal, or a typed NULL when the value is absent. */
export function sqlInteger(value: number|undefined): string {
  return value === undefined || !Number.isInteger(value) ?
      'CAST(NULL AS INT64)' :
      String(value);
}

/** Folds whitespace runs to one space (for one-line view descriptions). */
export function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
