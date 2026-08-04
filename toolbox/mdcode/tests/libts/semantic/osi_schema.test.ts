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
    if (ent.isDirectory()) out.push(...yamlFixtures(p));
    else if (ent.name.endsWith('.yaml') || ent.name.endsWith('.yml')) out.push(p);
  }
  return out;
}

// strict:false: the schema is authored by a third party; we validate documents
// against it, not the schema's own meta-style.
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
const fixtures = yamlFixtures(fixturesDir);

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
        const details = (validate.errors ?? [])
          .map(e => `  ${e.instancePath || '(root)'} ${e.message}`).join('\n');
        throw new Error(`OSI schema validation failed for ${rel}:\n${details}`);
      }
      expect(ok).toBe(true);
    });
  }
});
