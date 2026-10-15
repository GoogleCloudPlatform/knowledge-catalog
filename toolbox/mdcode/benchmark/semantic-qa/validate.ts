// Validates the semantic-QA benchmark: both models load, both conform to the
// OSI schema, and every name a question says it uses actually exists.
//
// This is what keeps the benchmark honest. A question whose `uses` list cites
// `total_revenue` when the model calls it `net_revenue` is a broken grading
// key, and nothing but a cross-check catches it.
//
// Run:  npx bun benchmark/semantic-qa/validate.ts
// Prints every failure and exits non-zero if there are any.

import Ajv2020 from 'ajv/dist/2020';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

import {Entity, SemanticModel} from '../../src/libts/semantic/ir';
import {loadModels} from '../../src/libts/semantic/loader';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const MODELS_DIR = path.join(ROOT, 'models');
const QUESTIONS_DIR = path.join(ROOT, 'questions');

const DIFFICULTIES = ['easy', 'medium', 'hard'];

interface Question {
  id: string;
  difficulty: string;
  question: string;
  uses: string[];  // a metric name, or an "entity.field" dimension
  answer: string;
}

const failures: string[] = [];
function fail(msg: string) {
  failures.push(msg);
}

// --- load both models -------------------------------------------------------

const modelFiles =
    fs.readdirSync(MODELS_DIR).filter(f => f.endsWith('.yaml')).sort();
if (!modelFiles.length) {
  console.error('no models found in ' + MODELS_DIR);
  process.exit(1);
}

interface Loaded {
  file: string;
  model: SemanticModel;
  metrics: Set<string>;
  entities: Set<string>;
  dimensions: Set<string>;  // "entity.field", resolving `extends`
}

const loaded = new Map<string, Loaded>();

for (const file of modelFiles) {
  const text = fs.readFileSync(path.join(MODELS_DIR, file), 'utf8');
  let models;
  try {
    models = loadModels(text, {dialect: 'ANSI_SQL'}).models;
  } catch (e) {
    fail(`${file}: failed to load -- ${(e as Error).message}`);
    continue;
  }
  if (models.length !== 1) {
    fail(`${file}: expected exactly one semantic model, got ${models.length}`);
    continue;
  }
  const m = models[0];
  const stem = file.replace(/\.yaml$/, '');
  if (m.name !== stem) {
    fail(`${file}: model name '${m.name}' does not match the file stem '${
        stem}'`);
  }

  // A subtype answers questions with its supertype's fields too, so resolve
  // `extends` transitively when collecting the legal dimension names.
  const byName = new Map<string, Entity>(m.entities.map(e => [e.name, e]));
  const fieldsOf = (e: Entity, seen = new Set<string>()): string[] => {
    if (seen.has(e.name)) return [];
    seen.add(e.name);
    const up = (e.extends ?? []).flatMap(sup => {
      const parent = byName.get(sup);
      if (!parent) {
        fail(`${file}: entity '${e.name}' extends unknown entity '${sup}'`);
        return [];
      }
      return fieldsOf(parent, seen);
    });
    return [...e.fields.map(f => f.name), ...up];
  };

  const dimensions = new Set<string>();
  for (const e of m.entities) {
    for (const f of fieldsOf(e)) dimensions.add(`${e.name}.${f}`);
  }

  loaded.set(stem, {
    file,
    model: m,
    metrics: new Set(m.metrics.map(x => x.name)),
    entities: new Set(m.entities.map(x => x.name)),
    dimensions,
  });
}

// --- OSI schema conformance -------------------------------------------------
//
// Both models declare kcmd's extended profile, which they need for `extends`
// and `abstract` (released OSI has neither). Three departures from the
// released schema follow from that and are tolerated; everything else -- a bad
// dialect enum, a misspelled key, a missing required field -- still fails:
//   - the `/google` version string itself
//   - `entities` at model level, kcmd's alias for OSI's `datasets`
//   - `extends` and `abstract` on a dataset
// The allowance is gated on the document actually declaring the extended
// profile, so a plain OSI model added later cannot quietly pick it up.

const SCHEMA_PATH = path.join(
    ROOT, '..', '..', 'tests', 'libts', 'semantic', 'fixtures', 'ossie',
    'osi-schema.json');
const GOOGLE_PROFILE_VERSION = '0.2.0.dev0/google';
const TOLERATED_EXTRA_PROPERTIES = new Set(['entities', 'extends', 'abstract']);

if (fs.existsSync(SCHEMA_PATH)) {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  // strict:false -- the schema is authored upstream; we validate documents
  // against it, not its own meta-style.
  const ajv = new Ajv2020({allErrors: true, strict: false});
  const validateSchema = ajv.compile(schema);
  for (const file of modelFiles) {
    const doc =
        yaml.parse(fs.readFileSync(path.join(MODELS_DIR, file), 'utf8'));
    if (validateSchema(doc)) continue;
    const extended =
        (doc as {version?: string})?.version === GOOGLE_PROFILE_VERSION;
    for (const e of validateSchema.errors ?? []) {
      const p = e.params as {
        additionalProperty?: string;
        missingProperty?: string
      };
      if (e.keyword === 'additionalProperties' && p.additionalProperty &&
          TOLERATED_EXTRA_PROPERTIES.has(p.additionalProperty)) {
        continue;
      }
      if (extended && e.keyword === 'const' && e.instancePath === '/version') {
        continue;  // the extended profile's own version string
      }
      if (extended && e.keyword === 'required' &&
          p.missingProperty === 'datasets') {
        continue;  // satisfied by the `entities` alias, tolerated above
      }
      fail(`${file}: not valid OSI at '${e.instancePath || '/'}' -- ${
          e.keyword} ${e.message ?? ''}`);
    }
  }
} else {
  console.warn(
      `note: ${SCHEMA_PATH} not found; skipped OSI schema conformance check`);
}

// --- every metric expression must name only real entities and fields --------

for (const L of loaded.values()) {
  for (const metric of L.model.metrics) {
    const expr = metric.expression ?? '';
    for (const [, ent, fld] of expr.matchAll(
             /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g)) {
      if (!L.entities.has(ent)) {
        fail(`${L.file}: metric '${metric.name}' references unknown entity '${
            ent}'`);
        continue;
      }
      if (!L.dimensions.has(`${ent}.${fld}`)) {
        fail(`${L.file}: metric '${metric.name}' references unknown field '${
            ent}.${fld}'`);
      }
    }
  }
}

// --- questions --------------------------------------------------------------

const questionFiles = fs.existsSync(QUESTIONS_DIR) ?
    fs.readdirSync(QUESTIONS_DIR).filter(f => f.endsWith('.yaml')).sort() :
    [];

const seenIds = new Set<string>();
const perModel = new Map<string, Question[]>();

for (const file of questionFiles) {
  const stem = file.replace(/\.yaml$/, '');
  const L = loaded.get(stem);
  if (!L) {
    fail(`questions/${file}: no model named '${stem}'`);
    continue;
  }
  const doc =
      yaml.parse(fs.readFileSync(path.join(QUESTIONS_DIR, file), 'utf8')) as {
    model?: string;
    questions?: Question[]
  };
  if (doc?.model !== stem) {
    fail(`questions/${file}: 'model' is '${doc?.model}', expected '${stem}'`);
  }
  const questions = doc?.questions ?? [];
  perModel.set(stem, questions);

  for (const q of questions) {
    const where = `questions/${file} [${q?.id ?? '?'}]`;
    if (!q?.id) fail(`${where}: missing id`);
    const key = `${stem}.${q?.id}`;
    if (seenIds.has(key)) fail(`${where}: duplicate id`);
    seenIds.add(key);

    if (!DIFFICULTIES.includes(q?.difficulty)) {
      fail(`${where}: difficulty '${q?.difficulty}' is not one of ${
          DIFFICULTIES.join(', ')}`);
    }
    if (!q?.question?.trim()) fail(`${where}: empty question text`);
    if (!q?.answer?.trim()) fail(`${where}: empty answer`);
    if (!q?.uses?.length) fail(`${where}: 'uses' must name at least one thing`);

    for (const name of q?.uses ?? []) {
      const ok =
          name.includes('.') ? L.dimensions.has(name) : L.metrics.has(name);
      if (!ok) {
        fail(`${where}: uses '${name}', which the model does not define`);
      }
    }
  }

  // The set is deliberately five per model, spanning difficulties. Both are
  // checked so the shape cannot drift without someone deciding to change it.
  if (questions.length !== 5) {
    fail(`questions/${file}: expected 5 questions, found ${questions.length}`);
  }
  const spread = new Set(questions.map(q => q?.difficulty));
  if (spread.size < 2) {
    fail(`questions/${file}: all questions are '${
            [...spread][0]}'; the set should vary in difficulty`);
  }
}

for (const stem of loaded.keys()) {
  if (!perModel.has(stem)) fail(`model '${stem}' has no questions file`);
}

// --- report -----------------------------------------------------------------

for (const f of failures) console.error('FAIL ' + f);

console.log('');
for (const [stem, L] of loaded) {
  const qs = perModel.get(stem) ?? [];
  const mix =
      DIFFICULTIES
          .map(d => `${qs.filter(q => q?.difficulty === d).length} ${d}`)
          .join(', ');
  console.log(
      `${stem.padEnd(16)} ${String(L.entities.size).padStart(2)} entities  ${
          String(L.model.relationships.length).padStart(2)} relationships  ${
          String(L.metrics.size).padStart(2)} metrics  |  ${
          qs.length} questions (${mix})`);
}
console.log('');

if (failures.length) {
  console.error(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log(
    'both models load, conform to OSI, and every question reference resolves');
