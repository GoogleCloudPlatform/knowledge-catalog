// OWL <-> OSI conversion orchestrator.
//
// The public entry point of the OWL converter. Import wires three steps --
// parse Turtle (parse.ts) -> map to the IR (to_ir.ts) -> serialize to OSI YAML
// (../../osi_converter, reused unchanged). Export is the exact mirror --
// map the IR to an OwlModel (from_ir.ts) -> serialize to Turtle (serialize.ts).
// This file wires the steps and adds no mapping policy of its own.

import {SemanticModel} from '../../ir';
import {serializeModel} from '../../osi_converter';

import {irToOwl} from './from_ir';
import {parseOwl} from './parse';
import {serializeOwl} from './serialize';
import {owlToIr} from './to_ir';

export interface ConvertResult {
  // The OSI document text, ready to write as `<model>.yaml`.
  yaml: string;
  // Counts for the CLI's one-line summary -- what was actually converted, not
  // the source-triple counts (see ToIrResult.stats), so a skipped element is
  // not reported as "converted".
  stats:
      {classes: number; datatypeProperties: number; objectProperties: number};
  // Notes about OWL content that could not be mapped (from the mapper) and IR
  // content with no loadable representation (from the serializer). Non-fatal.
  warnings: string[];
}

/**
 * Converts a Turtle (.ttl) OWL ontology to an OSI YAML document.
 *
 * `modelName` names the resulting semantic model (the CLI derives it from the
 * source filename). The output is UNBOUND -- see to_ir.ts and the user guide --
 * but loads and pushes to Knowledge Catalog as-is.
 *
 * Throws only on malformed Turtle (the parser's error); mapping gaps are
 * reported as warnings, not failures.
 */
export function convertOwlToOsi(
    turtle: string, modelName: string): ConvertResult {
  const owl = parseOwl(turtle);
  const {model, warnings: mapWarnings, stats} = owlToIr(owl, modelName);
  const {yaml, warnings: serializeWarnings} = serializeModel(model);
  return {
    yaml,
    stats,
    warnings: [...mapWarnings, ...serializeWarnings],
  };
}

export interface ExportResult {
  // The Turtle (.ttl) ontology text, ready to write as `<model>.owl.ttl`.
  turtle: string;
  // Counts for the CLI's one-line summary, mirroring ConvertResult.stats: what
  // was actually exported (classes / datatype properties / object properties).
  stats:
      {classes: number; datatypeProperties: number; objectProperties: number};
  // Notes about IR content with no OWL representation (a metric, a bound
  // source, a non-column expression, ...). Non-fatal: the construct is dropped,
  // not the export.
  warnings: string[];
}

/**
 * Converts a semantic-model IR to a Turtle (.ttl) OWL ontology -- the inverse
 * of convertOwlToOsi, scoped to round-trip fidelity.
 *
 * A model that originated as OWL round-trips (OWL -> OSI -> OWL -> OSI is
 * stable at the IR level): every native construct maps back and the carried
 * GOOGLE `owl:`/`rdfs:` extensions are re-emitted verbatim. A model authored
 * natively exports lossily -- constructs OWL cannot express (metrics, SQL
 * expressions, bound sources, associations) are dropped with a warning (see
 * from_ir.ts).
 *
 * Never throws; representation gaps are reported as warnings.
 */
export function convertOsiToOwl(model: SemanticModel): ExportResult {
  const {owl, warnings: mapWarnings, stats} = irToOwl(model);
  const {turtle, warnings: serializeWarnings} = serializeOwl(owl);
  return {
    turtle,
    stats,
    warnings: [...mapWarnings, ...serializeWarnings],
  };
}
