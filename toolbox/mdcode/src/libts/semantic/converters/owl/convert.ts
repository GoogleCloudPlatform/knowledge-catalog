// OWL -> OSI conversion orchestrator.
//
// The public entry point of the OWL converter: it wires the three steps --
// parse Turtle (parse.ts) -> map to the IR (to_ir.ts) -> serialize to OSI YAML
// (../../osi_converter, reused unchanged) -- and returns the YAML plus a small
// summary the CLI reports. It adds no mapping policy of its own. Two optional
// passes ride on the mapped IR (both proposed): pruning to what a binding
// profile binds (../../prune.ts) and the coverage report (coverage.ts).

import {SemanticModel} from '../../ir';
import {serializeModel} from '../../osi_converter';
import {pruneUnbound, PruneResult} from '../../prune';
import {CoverageEntry} from '../coverage';

import {owlCoverage} from './coverage';
import {parseOwl} from './parse';
import {skosToGlossary} from './skos';
import {owlToIr} from './to_ir';

export interface ConvertResult {
  // The OSI document text, ready to write as `<model>.yaml`.
  yaml: string;
  // The model the YAML serializes (after pruning, when it ran).
  model: SemanticModel;
  // Counts for the CLI's one-line summary -- what was actually converted, not
  // the source-triple counts (see ToIrResult.stats), so a skipped element is
  // not reported as "converted". Counted before pruning.
  stats:
      {classes: number; datatypeProperties: number; objectProperties: number};
  // Notes about OWL content that could not be mapped (from the mapper) and IR
  // content with no loadable representation (from the serializer). Non-fatal.
  warnings: string[];
  // Every construct occurrence and what the import made of it (see
  // ../coverage.ts). Always computed; the CLI decides whether to write it.
  coverage: CoverageEntry[];
  // What pruning kept and removed, when `opts.bound` was given.
  prune?: Pick<PruneResult, 'kept'|'pruned'>;
}

export interface ConvertOptions {
  // Emit the compact flow YAML layout (the `owl import --compact` flag).
  compactFlow?: boolean;
  // Prune the model to these bound entities, their ancestors and the defined
  // entities over them (the `owl import --prune-unbound` flag; ../../prune.ts).
  bound?: Iterable<string>;
}

/**
 * Converts a Turtle (.ttl) OWL ontology to an OSI YAML document.
 *
 * `turtle` is one document, or several modules of ONE ontology (e.g. a core
 * module plus the domain modules that import it). Several are merged into a
 * single model before mapping -- see parse.parseOwl for the merge rules (RDF
 * merge; the first document's header describes the model; cross-module
 * references resolve).
 *
 * `modelName` names the resulting semantic model (the CLI derives it from the
 * source filename). The output is a purely LOGICAL model -- see to_ir.ts and
 * the user guide -- with no physical binding; it loads and pushes to Knowledge
 * Catalog as-is, and a graph deploy adds bindings on top.
 *
 * `opts.compactFlow` emits the compact flow YAML layout (the `owl import
 * --compact` flag) instead of the default block layout; both parse identically.
 * `opts.bound` prunes the model to what those entities need (see
 * ConvertOptions.bound).
 *
 * Throws only on malformed Turtle (the parser's error); mapping gaps are
 * reported as warnings, not failures.
 */
export function convertOwlToOsi(
    turtle: string|string[], modelName: string,
    opts: ConvertOptions = {}): ConvertResult {
  const owl = parseOwl(turtle);
  const {model: mapped, warnings: mapWarnings, stats} = owlToIr(owl, modelName);
  // K9: the ontology's SKOS vocabulary, if any, becomes the business glossary
  // (see skos.ts); `defines` resolve against the entities just mapped.
  const skosWarnings: string[] = [];
  const glossary = skosToGlossary(turtle, mapped, skosWarnings);
  if (glossary) mapped.glossary = glossary;

  let model = mapped;
  let prune: ConvertResult['prune'];
  const pruneWarnings: string[] = [];
  if (opts.bound !== undefined) {
    const result = pruneUnbound(mapped, opts.bound);
    model = result.model;
    prune = {kept: result.kept, pruned: result.pruned};
    pruneWarnings.push(...result.warnings);
  }
  const coverage = owlCoverage({
    owl,
    model: mapped,
    warnings: [...mapWarnings, ...skosWarnings],
    pruned: prune?.pruned,
  });

  // An OWL import is always logical (no source/expression), so tell the
  // serializer not to warn about the missing physical binding. `compactFlow`
  // is opt-in (the `owl import --compact` flag): it emits the compact flow
  // layout the semantic-model guides use so the shown output is reproducible;
  // the default is the standard block layout.
  const {yaml, warnings: serializeWarnings} =
      serializeModel(model, {logical: true, compactFlow: opts.compactFlow});
  return {
    yaml,
    model,
    stats,
    warnings: [
      ...mapWarnings, ...skosWarnings, ...pruneWarnings, ...serializeWarnings
    ],
    coverage,
    ...(prune ? {prune} : {}),
  };
}
