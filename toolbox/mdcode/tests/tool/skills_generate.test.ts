// Tests for `kcmd skills-generate` (src/tool/commands.ts, skillsGenerate()) --
// what reaches the filesystem, rather than what the generator composes.
//
// The document's own shape is covered in tests/libts/semantic/skills.test.ts,
// which needs no disk. What is under test here is the part that can lose work:
// which directory a skill lands in, what happens to the skill already there,
// and what happens when two models want the same one. It runs in a temp
// working directory with a pinned context, mirroring action.test.ts.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../src/libts/gcp/context';
import {skillsGenerate} from '../../src/tool/commands';

const CTX = new ApiContext('test-project', 'us', 'test-token');

const SPANNER = '//spanner.googleapis.com/projects/acme-ops/instances/prod';

function modelText(name: string, action: string): string {
  return `version: "0.2.0.dev0/google"
semantic_model:
  - name: ${name}
    description: Orders and what they are made of.
    deployment_target: ${SPANNER}/databases/commerce/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${SPANNER}/databases/commerce/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
          - { name: total, expression: Total }
    actions:
      - name: ${action}
        description: Does a thing to an order.
        executor:
          sql:
            statements:
              - UPDATE Orders SET Total = 0 WHERE OrderId = @order
        parameters:
          - {name: order, type: Order}
        affects:
          - {concept: Order, operation: modify}
`;
}

let dir = '';
let cwd = '';
let logs: string[] = [];

function writeModel(file: string, text: string): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.test-project.us.commerce_eg\n');
  const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
  fs.mkdirSync(eg, {recursive: true});
  fs.writeFileSync(path.join(eg, file), text);
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-skills-'));
  process.chdir(dir);
  logs = [];
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  for (const channel of ['log', 'warn', 'error'] as const) {
    spyOn(console, channel).mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
  }
});

afterEach(() => {
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});


describe('kcmd skills-generate: what lands on disk', () => {
  test('the directory is named for the skill, not for the caller', async () => {
    writeModel('commerce.yaml', modelText('commerce', 'IssueCredit'));
    expect(await skillsGenerate({out: 'skills'})).toBe(0);
    expect(fs.existsSync(path.join('skills', 'commerce', 'SKILL.md')))
        .toBe(true);
    expect(fs.existsSync(path.join(
               'skills', 'commerce', 'references', 'issue-credit.md')))
        .toBe(true);
  });

  test('an existing skill is not overwritten without --force', async () => {
    writeModel('commerce.yaml', modelText('commerce', 'IssueCredit'));
    expect(await skillsGenerate({out: 'skills'})).toBe(0);
    logs = [];
    expect(await skillsGenerate({out: 'skills'})).toBe(1);
    expect(logs.join('\n')).toContain('--force');
  });
});


describe('kcmd skills-generate: --force replaces rather than layers', () => {
  test('a page for an action the model dropped is removed', async () => {
    // Progressive disclosure means an agent opens files under references/ on
    // demand. A page left behind by a rename is read as current and describes
    // a call the CLI will reject as unknown.
    writeModel('commerce.yaml', modelText('commerce', 'PlaceOrder'));
    expect(await skillsGenerate({out: 'skills'})).toBe(0);
    const stale =
        path.join('skills', 'commerce', 'references', 'place-order.md');
    expect(fs.existsSync(stale)).toBe(true);

    writeModel('commerce.yaml', modelText('commerce', 'CreateOrder'));
    logs = [];
    expect(await skillsGenerate({out: 'skills', force: true})).toBe(0);
    expect(fs.existsSync(path.join(
               'skills', 'commerce', 'references', 'create-order.md')))
        .toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(logs.join('\n')).toContain('Removed');
  });

  test('a file the generator did not put there is left alone', async () => {
    // Only reference pages are pruned. Anything else under the skill -- a
    // script, a note, a file a later version of this command writes -- is not
    // this command's to delete.
    writeModel('commerce.yaml', modelText('commerce', 'PlaceOrder'));
    expect(await skillsGenerate({out: 'skills'})).toBe(0);
    const note = path.join('skills', 'commerce', 'NOTES.md');
    fs.writeFileSync(note, 'kept');
    expect(await skillsGenerate({out: 'skills', force: true})).toBe(0);
    expect(fs.readFileSync(note, 'utf-8')).toBe('kept');
  });
});


describe('kcmd skills-generate: two models, one name', () => {
  test('a collision is refused rather than silently resolved', async () => {
    // A skill name is a lossy form of a model name. Writing both would leave
    // the second on disk and the first gone, with two "Wrote ..." lines and an
    // exit code of 0 saying otherwise.
    writeModel('a.yaml', modelText('Sales Orders', 'PlaceOrder'));
    writeModel('b.yaml', modelText('sales_orders', 'CancelOrder'));
    const code = await skillsGenerate({out: 'skills'});
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('both name');
    // And neither is on disk. The collision is a fault in the scope, not in
    // one model: whichever happened to be generated first would otherwise be
    // left behind as the answer to a question the command refused to answer.
    expect(fs.existsSync(path.join('skills', 'sales-orders'))).toBe(false);
  });
});
