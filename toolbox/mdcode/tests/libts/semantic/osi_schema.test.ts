// Guardrail: every YAML fixture under tests/libts/semantic/fixtures must be a
// structurally valid Apache OSI document.
//
// We validate against the vendored osi-schema.json (Draft 2020-12) with ajv —
// the same JSON-Schema check the Apache validator (validation/validate.py) runs
// as its first step, but in-process with no Python/PyPI dependency. This catches
// fixtures drifting from the spec (e.g. a `dialect` value outside the OSI enum),
// so the loader's own tests exercise only genuinely valid input. The schema and
// its provenance live in fixtures/ossie/ (see that directory's README).
//

import { describe, test, expect } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020';
import * as yaml from 'yaml';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const fixturesDir = join(__dirname, 'fixtures');
const schema = JSON.parse(
  readFileSync(join(fixturesDir, 'ossie', 'osi-schema.json'), 'utf8'));

// Recursively collect every *.yaml/*.yml fixture, so a newly added fixture is
// schema-checked automatically without editing this file.
function yamlFixtures(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    // The profiles/ subtree holds binding-profile authoring input, a
    // deliberate pre-OSI superset -- a logical model declares fields with no
    // `expression`, and a profile carries `deployment_target`/`unbound` sugars
    // -- so it is not a standalone OSI document. The loader, merge, and
    // profile-golden tests validate it instead.
    if (ent.isDirectory()) {
      if (ent.name === 'profiles') continue;
      out.push(...yamlFixtures(p));
    } else if (ent.name.endsWith('.yaml') || ent.name.endsWith('.yml')) {
      out.push(p);
    }
  }
  return out;
}

// strict:false: the schema is authored by a third party; we validate documents
// against it, not the schema's own meta-style.
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
const fixtures = yamlFixtures(fixturesDir);

// TODO(#290): a default (expression-free) KC push omits the OSI-required
// `expression` on fields/metrics, so a .pull.golden.yaml produced by it fails
// this guardrail *only* with "missing required property 'expression'" errors.
// Rather than skip those fixtures by name -- which would also hide unrelated
// drift and keep skipping them after #290 restores expressions -- we validate
// them too and tolerate *only* missing-`expression` errors. Once PR #290 (the
// sql-expressions companion aspect) regenerates these goldens with expressions
// they pass with no special-casing, and any other schema drift still fails now.
function onlyMissingExpression(errors: typeof validate.errors): boolean {
  return !!errors && errors.length > 0 &&
    errors.every(
      e => e.keyword === 'required' &&
        (e.params as {missingProperty?: string}).missingProperty ===
          'expression');
}

// `extends` (entity-level inheritance, the target of OWL rdfs:subClassOf) is a
// deliberate SUPERSET of released Apache OSI: the keyword is borrowed from
// Ossie's draft ontology proposal (ontology/ontology.md) and the vendored
// osi-schema.json -- pinned to released v0.2.0.dev0 -- does not yet know it, so a
// dataset carrying `extends` trips `additionalProperties: false` on the Dataset
// def. We tolerate EXACTLY that one extra property (an additionalProperties error
// naming `extends` on a datasets path) and nothing else, so an OWL hierarchy
// golden validates while every other drift from the spec still fails. When
// upstream OSI adopts `extends`, re-vendoring the schema makes this pass with no
// special-casing and this tolerance can be removed.
function onlyExtendsExtension(errors: typeof validate.errors): boolean {
  // `extends` and `abstract` are the two deliberate dataset-level supersets of
  // released OSI (OWL rdfs:subClassOf -> inheritance, and the abstract marker);
  // tolerate exactly those additional properties and nothing else.
  const allowed = new Set(['extends', 'abstract']);
  return !!errors && errors.length > 0 &&
    errors.every(
      e => e.keyword === 'additionalProperties' &&
        allowed.has(
          (e.params as {additionalProperty?: string}).additionalProperty ??
          '') &&
        /\/datasets\/\d+$/.test(e.instancePath));
}

// The OWL import goldens (.osi.golden.yaml) are purely LOGICAL models -- a
// deliberate pre-OSI superset, the same shape the profiles/ subtree is exempted
// for: an ontology has no physical tables, so they omit every binding facet the
// released schema requires (dataset `source` and field `expression`, supplied
// by a binding profile later; relationship `from_columns`/`to_columns`, added
// to the model later) and also carry the `extends`/`abstract` dataset
// supersets. Tolerate EXACTLY those
// omissions and extra properties on these goldens and nothing else, so real
// drift (a bad enum, a misspelled key, an unexpected shape) still fails.
function onlyLogicalGoldenDeviations(errors: typeof validate.errors): boolean {
  const missingOk = new Set(
    ['source', 'expression', 'from_columns', 'to_columns']);
  const extraOk = new Set(['extends', 'abstract']);
  return !!errors && errors.length > 0 &&
    errors.every(e => {
      if (e.keyword === 'required') {
        return missingOk.has(
          (e.params as {missingProperty?: string}).missingProperty ?? '');
      }
      if (e.keyword === 'additionalProperties') {
        return extraOk.has(
          (e.params as {additionalProperty?: string}).additionalProperty ??
          '') &&
          /\/datasets\/\d+$/.test(e.instancePath);
      }
      return false;
    });
}

// `actions` (model-level write operations, the write-side counterpart to
// metrics) are a deliberate SUPERSET of released Apache OSI: the Extended-spec
// proposal adds them, but the vendored osi-schema.json -- pinned to released
// v0.2.0.dev0 -- does not yet know the keyword, so a model carrying `actions`
// trips `additionalProperties: false` on the semantic_model item. We tolerate
// EXACTLY that one extra property (an additionalProperties error naming
// `actions` on a /semantic_model/<n> path) and nothing else, so an actions
// fixture validates while every other drift from the spec still fails. When
// upstream OSI adopts actions, re-vendoring the schema makes this pass with no
// special-casing and this tolerance can be removed.
function onlyActionsExtension(errors: typeof validate.errors): boolean {
  return !!errors && errors.length > 0 &&
    errors.every(
      e => e.keyword === 'additionalProperties' &&
        (e.params as {additionalProperty?: string}).additionalProperty ===
          'actions' &&
        /\/semantic_model\/\d+$/.test(e.instancePath));
}

describe('fixtures are valid Apache OSI (osi-schema.json, Draft 2020-12)', () => {
  test('at least one fixture is discovered', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const path of fixtures) {
    const rel = path.slice(fixturesDir.length + 1);
    test(`${rel} validates against the OSI schema`, () => {
      const doc = yaml.parse(readFileSync(path, 'utf8'));
      const ok = validate(doc);
      if (!ok) {
        // A .pull.golden.yaml from an expression-free push is a known #290 gap
        // when its ONLY failures are missing `expression`; anything else is a
        // real regression and still fails.
        if (rel.endsWith('.pull.golden.yaml') &&
            onlyMissingExpression(validate.errors)) {
          return;
        }
        // The OWL import goldens are purely logical models (a pre-OSI superset,
        // like profiles/): they omit source/expression/join-columns and carry
        // the extends/abstract supersets. Tolerate exactly those deviations on
        // them, so any other drift still fails.
        if (rel.endsWith('.osi.golden.yaml') &&
            onlyLogicalGoldenDeviations(validate.errors)) {
          return;
        }
        // The hand-authored bound graph fixtures carry only the
        // extends/abstract superset (their sources/expressions are present).
        if ((rel === 'hierarchy_graph.yaml' ||
             rel === 'reserved_words_inherit.yaml') &&
            onlyExtendsExtension(validate.errors)) {
          return;
        }
        // A model-level `actions` block is a deliberate superset of released
        // OSI (the Extended-spec proposal); tolerate exactly that extra property
        // and nothing else, and only on the actions fixtures that legitimately
        // carry it -- so a stray `actions` slipping into any other fixture still
        // fails.
        if (rel.startsWith('actions_') &&
            onlyActionsExtension(validate.errors)) {
          return;
        }
        const details = (validate.errors ?? [])
          .map(e => `  ${e.instancePath || '(root)'} ${e.message}`).join('\n');
        throw new Error(`OSI schema validation failed for ${rel}:\n${details}`);
      }
      expect(ok).toBe(true);
    });
  }
});
