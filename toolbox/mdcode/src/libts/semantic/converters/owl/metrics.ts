// Metrics stated in the ontology (kcmd:Metric individuals) -> model metrics.
//
//   met:win_rate_pct a kcmd:Metric ;
//       skos:prefLabel "Win rate percentage" ; skos:altLabel "win rate" ;
//       kcmd:expression "100 * SAFE_DIVIDE(COUNTIF(...), COUNTIF(...))" ;
//       skos:definition "..." ; kcmd:instructions "..." ; kcmd:unit "percent" .
//
// becomes
//
//   metrics:
//   - name: win_rate_pct
//     expression: 100 * SAFE_DIVIDE(COUNTIF(...), COUNTIF(...))
//     description: "...\n\nUnit: percent."
//     ai_context: {synonyms: [Win rate percentage, win rate], instructions: ...}
//
//   - name          <- the local name;
//   - expression    <- kcmd:expression, written over the ontology's own
//                      `<Class>.<property>` names (a qualifier naming a class
//                      folded into its keyed equivalent, see folds.ts, is
//                      rewritten to the keyed class);
//   - entity        <- the single entity the expression references, as the
//                      loader derives it (none for a cross-entity metric);
//   - description   <- skos:definition (else rdfs:comment / dc description),
//                      with the unit trailer `Unit: X.` for kcmd:unit (the
//                      convention fields use, see units_history.ts);
//   - ai_context    <- labels (skos:prefLabel / rdfs:label / skos:altLabel)
//                      as synonyms; kcmd:instructions as instructions.
//
// A metric with no kcmd:expression is not imported (warned); so is a second
// metric with an already-used name.

import {AiContext, Entity, Metric} from '../../ir';
import {mapOutsideStringLiterals, referencedEntityNames, escapeRegExp} from '../../sql_expr_utils';
import {withUnitTrailer} from '../../units_history';

import {EquivalentFold} from './folds';
import {OwlMetric} from './model';

/** What happened to each kcmd:Metric (for the coverage report). */
export interface OwlMetricOutcome {
  metric: string;
  // The imported metric's name, or undefined when it was skipped.
  imported?: string;
  reason?: string;
  // The metric is also a skos:Concept (its glossary term is the concept's).
  concept?: true;
}

/**
 * Maps the ontology's kcmd:Metric individuals to model metrics (see the
 * header). `entities` are the mapped entities (for the attach entity).
 */
export function owlMetrics(
    metrics: readonly OwlMetric[], entities: readonly Entity[],
    folds: readonly EquivalentFold[], warnings: string[]):
    {metrics: Metric[]; outcomes: OwlMetricOutcome[]} {
  const entityNames = entities.map(e => e.name);
  const out: Metric[] = [];
  const outcomes: OwlMetricOutcome[] = [];
  const seen = new Set<string>();
  for (const m of metrics) {
    const name = m.localName;
    if (m.expression === undefined) {
      const reason = 'no kcmd:expression';
      warnings.push(
          `metric '${name}' has no kcmd:expression, so it is not imported.`);
      outcomes.push({metric: name, reason});
      continue;
    }
    if (seen.has(name)) {
      const reason = 'a metric with this name was already imported';
      warnings.push(
          `metric '${name}' is declared twice; only the first is imported.`);
      outcomes.push({metric: name, reason});
      continue;
    }
    seen.add(name);

    const expression = refold(m.expression, folds);
    const metric: Metric = {name, expression};
    const referenced = referencedEntityNames(expression, entityNames);
    if (referenced.length === 1) metric.entity = referenced[0];
    const description = withUnitTrailer(m.definition, {unit: m.unit});
    if (description !== undefined) metric.description = description;

    const synonyms = dedupe([...m.labels, ...m.altLabels])
                         .filter(s => s.trim() && s !== name);
    const aiContext: AiContext = {};
    if (m.instructions !== undefined) aiContext.instructions = m.instructions;
    if (synonyms.length) aiContext.synonyms = synonyms;
    if (Object.keys(aiContext).length) metric.aiContext = aiContext;

    out.push(metric);
    outcomes.push(
        {metric: name, imported: name, ...(m.concept ? {concept: true as const} : {})});
  }
  return {metrics: out, outcomes};
}

// Rewrites `<Folded>.` qualifiers to `<Keeper>.` outside string literals.
function refold(expression: string, folds: readonly EquivalentFold[]): string {
  if (!folds.length) return expression;
  return mapOutsideStringLiterals(expression, seg => {
    let s = seg;
    for (const f of folds) {
      s = s.replace(
          new RegExp(`(?<![\\w\`])(\`?)${escapeRegExp(f.folded)}(\`?)\\.`, 'g'),
          `$1${f.into}$2.`);
    }
    return s;
  });
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
