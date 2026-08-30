// OWL -> OSI conversion orchestrator.
//
// The public entry point of the OWL converter: it wires the three steps --
// parse Turtle (parse.ts) -> map to the IR (to_ir.ts) -> serialize to OSI YAML
// (../../osi_converter, reused unchanged) -- and returns the YAML plus a small
// summary the CLI reports. It adds no mapping policy of its own.

import {serializeModel} from '../../osi_converter';

import {parseOwl} from './parse';
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
 * source filename). The output is a purely LOGICAL model -- see to_ir.ts and
 * the user guide -- with no physical binding; it loads and pushes to Knowledge
 * Catalog as-is, and a graph deploy adds bindings on top.
 *
 * Throws only on malformed Turtle (the parser's error); mapping gaps are
 * reported as warnings, not failures.
 */
export function convertOwlToOsi(
    turtle: string, modelName: string): ConvertResult {
  const owl = parseOwl(turtle);
  const {model, warnings: mapWarnings, stats} = owlToIr(owl, modelName);
  // An OWL import is always logical (no source/expression), so tell the
  // serializer not to warn about the missing physical binding, and emit the
  // compact flow layout the semantic-model guides use so the output is
  // reproducible there.
  const {yaml, warnings: serializeWarnings} =
      serializeModel(model, {logical: true, compactFlow: true});
  return {
    yaml,
    stats,
    warnings: [...mapWarnings, ...serializeWarnings],
  };
}
