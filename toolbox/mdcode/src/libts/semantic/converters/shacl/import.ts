// `kcmd shacl import`: merge the constraints a SHACL shapes graph states into
// an existing semantic-model document.
//
// Unlike `kcmd owl import`, which generates a whole model, SHACL describes
// rules about a model that already exists (typically one `kcmd owl import`
// produced, or a hand-written one), so the import EDITS that document: it adds
// native model-level `constraints` and leaves everything else -- comments,
// layout, keys, other constraints -- as it was (the document is edited through
// the `yaml` CST, not re-serialized from the IR).
//
// Idempotent: every generated constraint's description ends with a provenance
// note naming its shape (see constraints.ts). Before adding, the merge removes
// the constraints previously generated from any shape in the CURRENT input, so
// re-running the same import replaces rather than duplicates, and editing a
// shape and re-importing updates its constraints. Constraints from shapes not
// in the current input, and hand-written ones, are kept. Names are
// deterministic (`<Entity>_<path>_<rule>`), with a `_2` ... suffix only when a
// name is already taken by a constraint that is kept.

import * as YAML from 'yaml';

import {loadModels} from '../../loader';

import {provenanceShape, shaclConstraints} from './constraints';
import {parseShacl} from './parse';

export interface ShaclImportOptions {
  // The model (by name) to add the constraints to; required only when the
  // document declares more than one.
  model?: string;
}

export interface ShaclImportResult {
  yaml: string;  // the updated document
  model: string;
  added: string[];     // names of the constraints written, in order
  replaced: number;    // previously generated constraints removed
  shapes: number;      // shapes read
  warnings: string[];
}

/**
 * Merges the constraints `shapes` states into the model document `modelYaml`.
 * Throws on malformed Turtle, an unloadable model document, or an ambiguous /
 * unknown model name.
 */
export function importShacl(
    shapes: string|string[], modelYaml: string,
    options: ShaclImportOptions = {}): ShaclImportResult {
  const warnings: string[] = [];
  const parsed = parseShacl(shapes);

  // The model as IR, to resolve each sh:path. bindingOptional: the logical
  // model an OWL import writes carries no sources.
  const loaded = loadModels(modelYaml, {bindingOptional: true});
  const names = loaded.models.map(m => m.name);
  let modelName = options.model;
  if (modelName === undefined) {
    if (names.length !== 1) {
      throw new Error(
          `the document declares ${names.length} models (${names.join(', ')}); ` +
          `pass --model <name> to choose one.`);
    }
    modelName = names[0];
  }
  const model = loaded.models.find(m => m.name === modelName);
  if (!model) {
    throw new Error(`model '${modelName}' is not in the document (it declares ${
        names.join(', ') || 'none'}).`);
  }

  // The same model as an editable YAML document.
  const doc = YAML.parseDocument(modelYaml);
  const seq = doc.get('semantic_model');
  if (!YAML.isSeq(seq)) {
    throw new Error('the document has no semantic_model list.');
  }
  const modelNode = seq.items.find(
      m => YAML.isMap(m) && String(m.get('name')) === modelName);
  if (!YAML.isMap(modelNode)) {
    throw new Error(`model '${modelName}' is not in the document.`);
  }

  // First pass on names: what the shapes would produce, to learn the shape
  // keys in this input; then drop the constraints those shapes generated
  // before, and derive again against the names that remain.
  const probe =
      shaclConstraints(parsed, model, new Set(), /*warnings=*/[]);
  const keys = new Set(probe.shapeKeys);
  let existing = modelNode.get('constraints');
  let replaced = 0;
  const kept = new Set<string>();
  if (YAML.isSeq(existing)) {
    existing.items = existing.items.filter(item => {
      if (!YAML.isMap(item)) return true;
      const shape = provenanceShape(String(item.get('description') ?? ''));
      if (shape !== undefined && keys.has(shape)) {
        replaced++;
        return false;
      }
      kept.add(String(item.get('name')));
      return true;
    });
  }
  const derived = shaclConstraints(parsed, model, kept, warnings);

  if (derived.constraints.length) {
    if (!YAML.isSeq(existing)) {
      existing = doc.createNode([]) as YAML.YAMLSeq;
      modelNode.set('constraints', existing);
    }
    for (const {constraint: c} of derived.constraints) {
      const node: Record<string, unknown> = {name: c.name};
      if (c.judgment !== undefined) node.judgment = c.judgment;
      if (c.description !== undefined) node.description = c.description;
      if (c.onViolation !== undefined) node.on_violation = c.onViolation;
      if (c.severity !== undefined) node.severity = c.severity;
      (existing as YAML.YAMLSeq).items.push(doc.createNode(node));
    }
  } else if (YAML.isSeq(existing) && !existing.items.length) {
    modelNode.delete('constraints');  // emptied by the replacement
  }

  const yaml = doc.toString();
  // The result must still load: a generated name or value the loader rejects
  // is a bug here, not something to write to disk.
  loadModels(yaml, {bindingOptional: true});

  return {
    yaml,
    model: modelName,
    added: derived.constraints.map(c => c.constraint.name),
    replaced,
    shapes: parsed.nodeShapes.length + parsed.standaloneProperties.length,
    warnings,
  };
}
