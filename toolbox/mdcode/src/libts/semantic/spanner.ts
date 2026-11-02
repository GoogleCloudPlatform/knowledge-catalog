// Generates Spanner Graph DDL from the Semantic Model IR.
//
// The shared GoogleSQL generator (./graph_ddl) writes the graph structure. This
// module supplies its Spanner engine: bare table and graph names, no measures,
// no per-element OPTIONS, and a field's SPANNER text, else its ANSI_SQL text.
//
// See:
// https://docs.cloud.google.com/spanner/docs/reference/standard-sql/graph-schema-statements
//

import {spannerTable} from './binding';
import {generateGraphDdl, GenerateResult, GraphEngine} from './graph_ddl';
import {expressionForDialect, Field, Metric, SemanticModel} from './ir';
import {sqlWithoutComments} from './sql_expr_utils';
import {quoteIdentifier} from './sql_identifiers';

export interface GenerateOptions {
  graphName?: string;  // default: model.name
}

export type {GenerateResult};

/**
 * Generates the Spanner Graph DDL for a semantic model.
 *
 * The generated statement references the entities' existing Spanner tables; it
 * does not create them. Returns the DDL plus any warnings collected while
 * mapping the IR (e.g. metrics dropped because Spanner Graph has no measure).
 *
 * Throws when the model yields no valid node table -- it declares no entities,
 * or every entity lacks a KEY -- since a property graph with an empty NODE
 * TABLES block is invalid DDL that Spanner would reject.
 */
export function generateSpannerPropertyGraph(
    model: SemanticModel, opts: GenerateOptions = {}): GenerateResult {
  return generateGraphDdl(model, spannerEngine(opts));
}

// The Spanner engine for the shared generator.
function spannerEngine(opts: GenerateOptions): GraphEngine {
  return {
    name: 'Spanner',
    table: spannerTable,
    graphName: model => quoteIdentifier(opts.graphName ?? model.name),
    placeMetrics: (metrics, _input, warnings) => skipMetrics(metrics, warnings),
    elementOptions: () => undefined,
    fieldOptions: () => undefined,
    dialect: 'SPANNER',
    fieldExpression,
  };
}

// Warns that each metric is dropped, since Spanner Graph has no MEASURE.
function skipMetrics(
    metrics: Metric[], warnings: string[]): Map<string, string[]> {
  for (const metric of metrics) {
    warnings.push(
        `metric '${metric.name}' is not emitted: Spanner Graph has no ` +
        `MEASURE, so model-level metrics have no home in it`);
  }
  return new Map();
}

// The field's SPANNER text, else its ANSI_SQL text, read as Spanner SQL with
// its comments removed. A line comment left in would swallow the ` AS <name>`
// and comma the DDL writes after the expression.
function fieldExpression(f: Field): string|undefined {
  const text = expressionForDialect(f, 'SPANNER');
  return text === undefined ? undefined :
                              sqlWithoutComments(text, 'SPANNER');
}
