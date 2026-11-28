// Validates the semantic-QA retrieval benchmark.
//
// This set grades SEARCH: a question arrives, Knowledge Catalog is searched,
// and it must return the concepts needed to answer. So the gold labels are KC
// entry refs, and the job here is to prove every one of them names an entry
// that a push would actually create.
//
// A gold ref pointing at a metric the model renamed is a broken relevance
// judgement, and nothing but a cross-check catches it.
//
// Run:  npx bun benchmark/semantic-qa/validate.ts

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
const KINDS = ['model', 'entity', 'metric'];
const REF_LISTS = ['required', 'supporting', 'confusable', 'forbidden'];

const failures: string[] = [];
const fail = (m: string) => void failures.push(m);

// --- load every model -------------------------------------------------------

const modelFiles =
    fs.readdirSync(MODELS_DIR).filter(f => f.endsWith('.yaml')).sort();

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
    fail(`${file}: expected one semantic model, got ${models.length}`);
    continue;
  }
  const m = models[0];
  const stem = file.replace(/\.yaml$/, '');
  if (m.name !== stem) {
    fail(`${file}: model name '${m.name}' does not match file stem '${stem}'`);
  }

  const byName = new Map<string, Entity>(m.entities.map(e => [e.name, e]));
  const fieldsOf = (e: Entity, seen = new Set<string>()): string[] => {
    if (seen.has(e.name)) return [];
    seen.add(e.name);
    const up = (e.extends ?? []).flatMap(sup => {
      const parent = byName.get(sup);
      if (!parent) {
        fail(`${file}: entity '${e.name}' extends unknown '${sup}'`);
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

// --- OSI conformance --------------------------------------------------------
//
// Every model declares kcmd's extended profile. Three departures from released
// OSI follow and are tolerated; anything else still fails:
//   - the `/google` version string
//   - `entities` at model level, the alias for OSI's `datasets`
//   - `extends` / `abstract` on a dataset
// Gated on the document actually declaring the profile.

const SCHEMA_PATH = path.join(
    ROOT, '..', '..', 'tests', 'libts', 'semantic', 'fixtures', 'ossie',
    'osi-schema.json');
const GOOGLE_PROFILE = '0.2.0.dev0/google';
const TOLERATED = new Set(['entities', 'extends', 'abstract']);

if (fs.existsSync(SCHEMA_PATH)) {
  const ajv = new Ajv2020({allErrors: true, strict: false});
  const check = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')));
  for (const file of modelFiles) {
    const doc =
        yaml.parse(fs.readFileSync(path.join(MODELS_DIR, file), 'utf8'));
    if (check(doc)) continue;
    const extended = (doc as {version?: string})?.version === GOOGLE_PROFILE;
    if (!extended) {
      fail(`${file}: must declare the Google profile, version "${
          GOOGLE_PROFILE}"`);
    }
    for (const e of check.errors ?? []) {
      const p = e.params as {
        additionalProperty?: string;
        missingProperty?: string
      };
      if (e.keyword === 'additionalProperties' && p.additionalProperty &&
          TOLERATED.has(p.additionalProperty))
        continue;
      if (extended && e.keyword === 'const' && e.instancePath === '/version') {
        continue;
      }
      if (extended && e.keyword === 'required' &&
          p.missingProperty === 'datasets') {
        continue;
      }
      fail(`${file}: not valid OSI at '${e.instancePath || '/'}' -- ${
          e.keyword} ${e.message ?? ''}`);
    }
  }
} else {
  console.warn(`note: ${SCHEMA_PATH} missing; skipped OSI schema check`);
}

// --- metric expressions may only name real entities and fields --------------

for (const L of loaded.values()) {
  for (const metric of L.model.metrics) {
    for (const [, ent, fld] of (metric.expression ?? '')
             .matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g)) {
      if (!L.entities.has(ent)) {
        fail(
            `${L.file}: metric '${metric.name}' names unknown entity '${ent}'`);
      } else if (!L.dimensions.has(`${ent}.${fld}`)) {
        fail(`${L.file}: metric '${metric.name}' names unknown field '${ent}.${
            fld}'`);
      }
    }
  }
}

// --- gold refs --------------------------------------------------------------
//
// A ref is `kind:name`, optionally qualified `model.kind:name`. The three
// kinds are the three things kcmd publishes as KC entries. Relationships are
// deliberately NOT a kind: they become schema-join entry LINKS, so they are
// traversed after retrieval rather than returned by it, and a benchmark that
// asked search to return one would be grading a thing KC does not do.

function resolveRef(ref: string, ambient: string|undefined, where: string) {
  const colon = ref.lastIndexOf(':');
  if (colon < 0) {
    fail(`${where}: ref '${ref}' is missing its 'kind:' prefix`);
    return;
  }
  const lhs = ref.slice(0, colon);
  const name = ref.slice(colon + 1);
  const dot = lhs.lastIndexOf('.');
  const kind = dot < 0 ? lhs : lhs.slice(dot + 1);
  const qualifier = dot < 0 ? undefined : lhs.slice(0, dot);

  if (!KINDS.includes(kind)) {
    fail(`${where}: ref '${ref}' has unknown kind '${kind}' (expected ${
        KINDS.join(', ')})`);
    return;
  }
  if (kind === 'model') {
    if (!loaded.has(name)) fail(`${where}: ref '${ref}' names no model`);
    return;
  }
  const modelName = qualifier ?? ambient;
  if (!modelName) {
    fail(`${where}: ref '${ref}' must be qualified 'model.${kind}:${
        name}' in a cross-model file`);
    return;
  }
  const L = loaded.get(modelName);
  if (!L) {
    fail(`${where}: ref '${ref}' names no model '${modelName}'`);
    return;
  }
  const pool = kind === 'metric' ? L.metrics : L.entities;
  if (!pool.has(name)) {
    fail(`${where}: ref '${ref}' -- ${modelName} defines no ${kind} '${name}'`);
  }
}

// --- questions --------------------------------------------------------------

interface Question {
  id: string;
  kind?: string;
  difficulty: string;
  question: string;
  expect?: Record<string, string[]>;
  why?: string;
}

const questionFiles = fs.existsSync(QUESTIONS_DIR) ?
    fs.readdirSync(QUESTIONS_DIR).filter(f => f.endsWith('.yaml')).sort() :
    [];

let total = 0, negatives = 0, ambiguous = 0;
const covered = new Set<string>();
const seen = new Set<string>();

for (const file of questionFiles) {
  const doc =
      yaml.parse(fs.readFileSync(path.join(QUESTIONS_DIR, file), 'utf8')) as {
    model?: string;
    scope?: string;
    questions?: Question[]
  };
  const stem = file.replace(/\.yaml$/, '');
  const crossModel = doc?.scope === 'cross-model';

  if (!crossModel) {
    if (doc?.model !== stem) {
      fail(`questions/${file}: 'model' is '${doc?.model}', expected '${stem}'`);
      continue;
    }
    if (!loaded.has(stem)) {
      fail(`questions/${file}: no model named '${stem}'`);
      continue;
    }
    covered.add(stem);
  }
  const ambient = crossModel ? undefined : doc?.model;
  const questions = doc?.questions ?? [];

  for (const q of questions) {
    const where = `questions/${file} [${q?.id ?? '?'}]`;
    total++;
    if (!q?.id) fail(`${where}: missing id`);
    const key = `${stem}.${q?.id}`;
    if (seen.has(key)) fail(`${where}: duplicate id`);
    seen.add(key);
    if (!DIFFICULTIES.includes(q?.difficulty)) {
      fail(`${where}: difficulty '${q?.difficulty}' not in ${
          DIFFICULTIES.join('/')}`);
    }
    if (!q?.question?.trim()) fail(`${where}: empty question`);
    if (!q?.why?.trim()) fail(`${where}: every question needs a 'why'`);

    for (const list of Object.keys(q?.expect ?? {})) {
      if (!REF_LISTS.includes(list)) {
        fail(`${where}: unknown expect list '${list}' (expected ${
            REF_LISTS.join(', ')})`);
      }
    }
    for (const list of REF_LISTS) {
      for (const ref of q?.expect?.[list] ?? []) {
        resolveRef(ref, ambient, `${where} ${list}`);
      }
    }

    const required = q?.expect?.required ?? [];
    if (q?.kind === 'negative') {
      negatives++;
      if (required.length) {
        fail(`${where}: a negative must have an empty 'required'`);
      }
      if (!(q?.expect?.forbidden ?? []).length) {
        fail(`${
            where}: a negative needs 'forbidden' -- the near-misses that must not rank`);
      }
    } else {
      if (!required.length)
        fail(`${where}: 'required' must name at least one entry`);
      if (q?.kind === 'ambiguous') {
        ambiguous++;
        // The whole point of an ambiguous question is that the answer spans
        // models; one model's entries would make it an ordinary question.
        const models = new Set(required.map(r => r.slice(0, r.lastIndexOf(':')))
                                   .map(
                                       l => l.includes('.') ?
                                           l.slice(0, l.lastIndexOf('.')) :
                                           ''));
        if (models.size < 2) {
          fail(`${
              where}: an ambiguous question must require entries from 2+ models`);
        }
      }
    }
  }

  if (!crossModel) {
    if (questions.length !== 5) {
      fail(
          `questions/${file}: expected 5 questions, found ${questions.length}`);
    }
    if (new Set(questions.map(q => q?.difficulty)).size < 2) {
      fail(`questions/${file}: difficulty should vary across the set`);
    }
  }
}

for (const stem of loaded.keys()) {
  if (!covered.has(stem)) fail(`model '${stem}' has no questions file`);
}

// --- report -----------------------------------------------------------------

for (const f of failures) console.error('FAIL ' + f);

const entries = [...loaded.values()].reduce(
    (n, L) => n + 1 + L.entities.size + L.metrics.size, 0);
console.log('');
for (const [stem, L] of loaded) {
  console.log(
      `  ${stem.padEnd(20)} ${String(L.entities.size).padStart(2)} entities  ${
          String(L.metrics.size).padStart(3)} metrics`);
}
console.log(`\n  corpus      ${entries} retrievable KC entries (${
    loaded.size} model + ${
        [...loaded.values()].reduce(
            (n, L) => n + L.entities.size, 0)} entity + ${
        [...loaded.values()].reduce((n, L) => n + L.metrics.size, 0)} metric)`);
console.log(`  questions   ${total} (${ambiguous} ambiguous, ${
    negatives} negative, ${total - ambiguous - negatives} single-model)\n`);

if (failures.length) {
  console.error(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log('all models conform, and every gold ref names a real KC entry');
