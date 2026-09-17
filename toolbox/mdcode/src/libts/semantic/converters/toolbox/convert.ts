// MCP Toolbox -> OSI conversion orchestrator.
//
// The public entry point of the Toolbox converter: it wires the three steps --
// read the configuration (parse.ts) -> map to the IR (to_ir.ts) -> serialize to
// OSI YAML (../../osi_converter, reused unchanged) -- and returns the YAML plus
// the summary the CLI reports. It adds no mapping policy of its own.

import {serializeModel} from '../../osi_converter';

import {parseToolboxConfig} from './parse';
import {ToIrResult, toolboxToIr} from './to_ir';

export interface ConvertResult {
  /** The OSI document text, ready to write as `<model>.yaml`. */
  yaml: string;
  /** Counts for the CLI's one-line summary. */
  stats: ToIrResult['stats'];
  /**
   * Notes about configuration content that could not be mapped (from the
   * mapper) and IR content with no loadable representation (from the
   * serializer). Non-fatal, and on this importer they are the interesting part
   * of the output: a Toolbox config says less than a semantic model needs, and
   * these are the places that shows.
   */
  warnings: string[];
}

/**
 * Converts one or more MCP Toolbox `tools.yaml` texts to an OSI YAML document.
 *
 * Several texts are converted together because a Toolbox deployment is often
 * several files served as one configuration, and a tool in one may name a
 * source in another.
 *
 * `modelName` names the resulting semantic model (the CLI derives it from the
 * source filename). Unlike an OWL import, the result is BOUND wherever the
 * Toolbox source allows it: entities carry the table their statements named and
 * fields carry their columns. Whether the binding also reaches a store kcmd can
 * run against depends on the source type -- see to_ir.ts, `resourceName`.
 *
 * Throws only on YAML that will not parse. Every mapping gap is a warning.
 */
export function convertToolboxToOsi(
    texts: string[], modelName: string,
    opts: {compactFlow?: boolean} = {}): ConvertResult {
  const {config, warnings: parseWarnings} = parseToolboxConfig(texts);
  const {model, warnings: mapWarnings, stats} = toolboxToIr(config, modelName);
  const {yaml, warnings: serializeWarnings} =
      serializeModel(model, {compactFlow: opts.compactFlow});
  return {
    yaml,
    stats,
    warnings: [...parseWarnings, ...mapWarnings, ...serializeWarnings],
  };
}
