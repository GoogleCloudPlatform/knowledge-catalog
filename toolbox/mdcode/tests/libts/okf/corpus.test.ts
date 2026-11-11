// Runs the concept reader/writer over the OKF bundles shipped in okf/bundles/,
// which nobody on this change authored.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {globSync} from 'glob';

import {conceptToFileContent, fileContentToConcept} from '../../../src/libts/okf/concept';

const BUNDLES = path.resolve(__dirname, '../../../../../okf/bundles');

// conceptToFileContent normalizes key order on purpose, so compare content.
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sorted((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

const files = fs.existsSync(BUNDLES)
  ? globSync('**/*.md', {cwd: BUNDLES, absolute: true, nodir: true})
  : [];

describe('real OKF bundles', () => {
  test('the corpus is present', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test('every concept round-trips without changing content', () => {
    const drifted: string[] = [];
    let concepts = 0;

    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(BUNDLES, file);
      const first = fileContentToConcept(text, rel.replace(/\.md$/, ''));
      // index.md and log.md carry no frontmatter (SPEC §8).
      if (Object.keys(first.frontmatter).length === 0) continue;
      concepts++;

      const second = fileContentToConcept(conceptToFileContent(first), first.id);
      if (
        JSON.stringify(sorted(second.frontmatter)) !==
        JSON.stringify(sorted(first.frontmatter))
      ) {
        drifted.push(`frontmatter: ${rel}`);
      }
      if (second.body !== first.body) drifted.push(`body: ${rel}`);
      if (second.id !== first.id) drifted.push(`id: ${rel}`);
    }

    expect(concepts).toBeGreaterThan(20);
    expect(drifted).toEqual([]);
  });
});
