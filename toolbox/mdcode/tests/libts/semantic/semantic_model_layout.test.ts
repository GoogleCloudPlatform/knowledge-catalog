// Tests for the SemanticModel layout's pull write-path
// (src/libts/layouts/semantic-model.ts): modelPath / hasModel /
// writeModelDocument. These are the sink `pull` writes reconstructed models to;
// the push-side discovery (modelDocuments) is exercised via the deploy tests.

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {SemanticModelLayout} from '../../../src/libts/layouts/semantic-model';

let root: string;
let catalogPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-layout-'));
  catalogPath = path.join(root, 'catalog');
});

afterEach(() => {
  fs.rmSync(root, {recursive: true, force: true});
});

async function layout(entryGroup?: string): Promise<SemanticModelLayout> {
  const l = new SemanticModelLayout(catalogPath, entryGroup);
  await l.init();
  return l;
}


describe('SemanticModelLayout write path', () => {
  test('modelPath maps to EntryGroups/<entryGroup>/<name>.yaml', async () => {
    const l = await layout('eg');
    expect(l.modelPath('sales'))
        .toBe(path.join(catalogPath, 'EntryGroups', 'eg', 'sales.yaml'));
  });

  test('modelPath sanitizes path separators in the model name', async () => {
    const l = await layout('eg');
    expect(l.modelPath('a/b'))
        .toBe(path.join(catalogPath, 'EntryGroups', 'eg', 'a_b.yaml'));
  });

  test('modelPath throws without an entry group', async () => {
    const l = await layout(undefined);
    expect(() => l.modelPath('sales')).toThrow(/entry group/i);
  });

  test(
      'writeModelDocument creates the file, dirs, and indexes it', async () => {
        const l = await layout('eg');
        expect(l.hasModel('sales')).toBe(false);

        l.writeModelDocument('sales', 'version: x\n');

        const p = l.modelPath('sales');
        expect(fs.existsSync(p)).toBe(true);
        expect(fs.readFileSync(p, 'utf8')).toBe('version: x\n');
        expect(l.hasModel('sales')).toBe(true);
        // Indexed, so a subsequent read surfaces it as a model document.
        expect(l.modelDocuments()).toEqual([
          {name: 'sales', text: 'version: x\n'}
        ]);
      });

  test(
      'writeModelDocument overwrites an existing document (last-write-wins)',
      async () => {
        const l = await layout('eg');
        l.writeModelDocument('sales', 'first\n');
        l.writeModelDocument('sales', 'second\n');
        expect(fs.readFileSync(l.modelPath('sales'), 'utf8')).toBe('second\n');
      });

  test('removeModelDocument deletes the file and de-indexes it', async () => {
    const l = await layout('eg');
    l.writeModelDocument('sales', 'version: x\n');
    const p = l.modelPath('sales');
    expect(fs.existsSync(p)).toBe(true);

    l.removeModelDocument('sales');

    expect(fs.existsSync(p)).toBe(false);
    expect(l.hasModel('sales')).toBe(false);
    // De-indexed, so it no longer surfaces as a model document.
    expect(l.modelDocuments()).toEqual([]);
  });

  test('removeModelDocument is a no-op for an unknown model', async () => {
    const l = await layout('eg');
    // `pull --force-remove` may name a model that was never written; removing
    // it must not throw.
    expect(() => l.removeModelDocument('ghost')).not.toThrow();
  });
});


describe('SemanticModelLayout profile discovery', () => {
  function writeModel(eg: string, name: string, text: string): void {
    const dir = path.join(catalogPath, 'EntryGroups', eg);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, `${name}.yaml`), text);
  }
  function writeProfile(eg: string, model: string, name: string): void {
    const dir = path.join(catalogPath, 'EntryGroups', eg, `${model}.profiles`);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, `${name}.yaml`), `# ${name}\n`);
  }

  test('profileDocuments reads <model>.profiles/*.yaml by name', async () => {
    writeModel('eg', 'commerce', 'version: x\n');
    writeProfile('eg', 'commerce', 'analytical');
    writeProfile('eg', 'commerce', 'operational');
    const l = await layout('eg');
    expect(l.profileDocuments('commerce').map(p => p.name)).toEqual(
        ['analytical', 'operational']);
    expect(l.profileDocuments('commerce')[0].text).toBe('# analytical\n');
  });

  test('a model with no profiles directory yields none', async () => {
    writeModel('eg', 'commerce', 'version: x\n');
    const l = await layout('eg');
    expect(l.profileDocuments('commerce')).toEqual([]);
  });

  test('a .profiles directory is not discovered as a model document', async () => {
    writeModel('eg', 'commerce', 'version: x\n');
    writeProfile('eg', 'commerce', 'analytical');
    const l = await layout('eg');
    // Only the logical model, never the profile files, surfaces as a model.
    expect(l.modelDocuments().map(d => d.name)).toEqual(['commerce']);
  });
});


describe('SemanticModelLayout sibling profile files', () => {
  const GOOGLE = 'version: 0.2.0.dev0/google\n';
  function groupDir(): string {
    const dir = path.join(catalogPath, 'EntryGroups', 'eg');
    fs.mkdirSync(dir, {recursive: true});
    return dir;
  }
  function write(file: string, text: string): void {
    fs.writeFileSync(path.join(groupDir(), file), text);
  }

  test('modelDocuments returns the model and not its profile files', async () => {
    write('retail.yaml', GOOGLE);
    write('retail.profile.prod.yaml', 'name: prod\n');
    write('retail.profile.yaml', 'name: x\n');
    const l = await layout('eg');
    expect(l.modelDocuments().map(d => d.name)).toEqual(['retail']);
  });

  test('profileDocuments finds sibling files by name, sorted', async () => {
    write('retail.yaml', GOOGLE);
    write('retail.profile.staging.yaml', 'name: staging\n');
    write('retail.profile.prod.yaml', 'name: prod\n');
    write('other.profile.prod.yaml', 'name: prod\n');
    const l = await layout('eg');
    const docs = l.profileDocuments('retail');
    expect(docs.map(d => d.name)).toEqual(['prod', 'staging']);
    expect(docs[0].text).toBe('name: prod\n');
  });

  test('the legacy directory is read only when no sibling file exists', async () => {
    write('retail.yaml', GOOGLE);
    fs.mkdirSync(path.join(groupDir(), 'retail.profiles'));
    fs.writeFileSync(path.join(groupDir(), 'retail.profiles', 'old.yaml'), '# old\n');
    let l = await layout('eg');
    expect(l.profileDocuments('retail').map(d => d.name)).toEqual(['old']);

    write('retail.profile.prod.yaml', 'name: prod\n');
    l = await layout('eg');
    expect(l.profileDocuments('retail').map(d => d.name)).toEqual(['prod']);
  });

  test('a name that does not match the filename suffix is an error', async () => {
    write('retail.yaml', GOOGLE);
    write('retail.profile.prod.yaml', 'name: staging\n');
    const l = await layout('eg');
    expect(() => l.profileDocuments('retail')).toThrow(
        "Profile file 'retail.profile.prod.yaml' declares name 'staging', " +
        "which does not match filename suffix 'prod'.");
  });

  test('default is reserved, in the filename or in name:', async () => {
    write('retail.yaml', GOOGLE);
    write('retail.profile.default.yaml', 'name: default\n');
    let l = await layout('eg');
    expect(() => l.profileDocuments('retail')).toThrow(
        "Profile name 'default' is reserved for the inline bindings in " +
        "'retail.yaml'; remove 'retail.profile.default.yaml'.");

    fs.rmSync(path.join(groupDir(), 'retail.profile.default.yaml'));
    write('retail.profile.prod.yaml', 'name: default\n');
    l = await layout('eg');
    expect(() => l.profileDocuments('retail')).toThrow(/reserved/);
  });

  test('a missing name, an unparseable file and DEFAULT in any case are errors', async () => {
    write('retail.yaml', GOOGLE);
    write('retail.profile.prod.yaml', 'entities: []\n');
    let l = await layout('eg');
    expect(() => l.profileDocuments('retail'))
        .toThrow("Profile file 'retail.profile.prod.yaml' declares no name");

    write('retail.profile.prod.yaml', 'name: prod\nentities: [\n');
    l = await layout('eg');
    expect(() => l.profileDocuments('retail')).toThrow(/does not parse/);

    fs.rmSync(path.join(groupDir(), 'retail.profile.prod.yaml'));
    write('retail.profile.DEFAULT.yaml', 'name: DEFAULT\n');
    l = await layout('eg');
    expect(() => l.profileDocuments('retail')).toThrow(/reserved/);
  });

  test('a sibling profile beside a vanilla model is an error', async () => {
    write('retail.yaml', 'version: 0.2.0.dev0\n');
    write('retail.profile.prod.yaml', 'name: prod\n');
    const l = await layout('eg');
    expect(() => l.profileDocuments('retail')).toThrow(/Google-flavor only/);
  });

  test('orphanProfilePaths lists profile files with no model', async () => {
    write('retail.yaml', GOOGLE);
    write('retail.profile.prod.yaml', 'name: prod\n');
    write('gone.profile.prod.yaml', 'name: prod\n');
    const l = await layout('eg');
    expect(l.orphanProfilePaths()).toEqual(
        [path.join(groupDir(), 'gone.profile.prod.yaml')]);
  });

  test('legacyProfileDirs lists <model>.profiles directories', async () => {
    write('retail.yaml', GOOGLE);
    fs.mkdirSync(path.join(groupDir(), 'retail.profiles'));
    const l = await layout('eg');
    expect(l.legacyProfileDirs()).toEqual(
        [path.join(groupDir(), 'retail.profiles')]);
  });

  test('profilePath, writeProfileDocument and removeProfileDocument', async () => {
    write('retail.yaml', GOOGLE);
    const l = await layout('eg');
    const p = l.profilePath('retail', 'prod');
    expect(p).toBe(path.join(groupDir(), 'retail.profile.prod.yaml'));

    l.writeProfileDocument('retail', 'prod', 'name: prod\n');
    expect(fs.readFileSync(p, 'utf8')).toBe('name: prod\n');
    expect(l.profileDocuments('retail').map(d => d.name)).toEqual(['prod']);

    l.removeProfileDocument('retail', 'prod');
    expect(fs.existsSync(p)).toBe(false);
    l.removeProfileDocument('retail', 'prod');  // a no-op the second time
  });
});


describe('SemanticModelLayout profile file rules', () => {
  function write(file: string, text: string): void {
    const dir = path.join(catalogPath, 'EntryGroups', 'eg');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, file), text);
  }
  const MODEL = (name: string) =>
      `version: 0.2.0.dev0/google\nsemantic_model:\n  - name: ${name}\n`;

  test('a <model>.profile.yaml with no profile name is an error', async () => {
    write('retail.yaml', MODEL('retail'));
    write('retail.profile.yaml', 'name: prod\n');
    const l = await layout('eg');
    expect(() => l.profileDocuments('retail'))
        .toThrow("Profile file 'retail.profile.yaml' names no profile");
  });

  test('profile files must be named after the model the file declares', async () => {
    write('retail.yaml', MODEL('sales'));
    write('retail.profile.prod.yaml', 'name: prod\n');
    const l = await layout('eg');
    expect(() => l.profileDocuments('retail'))
        .toThrow("'retail.yaml', which declares model 'sales'");
    // A model with no sibling profile files is not checked.
    write('other.yaml', MODEL('different'));
    expect(l.profileDocuments('other')).toEqual([]);
  });

  test('profileDocument reads one profile by name, under the same rules', async () => {
    write('retail.yaml', MODEL('retail'));
    write('retail.profile.prod.yaml', 'name: prod\n');
    write('retail.profile.staging.yaml', 'name: staging\n');
    const l = await layout('eg');
    expect(l.profileDocument('retail', 'staging')).toBe('name: staging\n');
    expect(l.profileDocument('retail', 'missing')).toBeUndefined();
    write('retail.profile.bad.yaml', 'name: other\n');
    expect(() => l.profileDocument('retail', 'prod')).toThrow(/does not match/);
  });
});


describe('SemanticModelLayout profile names and orphans', () => {
  function write(file: string, text: string): void {
    const dir = path.join(catalogPath, 'EntryGroups', 'eg');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, file), text);
  }

  test('a profile file whose name has a dot is not a model and is an error', async () => {
    write('retail.yaml', 'version: 0.2.0.dev0/google\n');
    write('retail.profile.prod.v2.yaml', 'name: prod\n');
    const l = await layout('eg');
    expect(l.modelDocuments().map(d => d.name)).toEqual(['retail']);
    expect(() => l.profileDocuments('retail'))
        .toThrow("Profile file 'retail.profile.prod.v2.yaml' has profile name 'prod.v2'");
  });

  test('a nameless profile file with no model is an orphan', async () => {
    write('retail.yaml', 'version: 0.2.0.dev0/google\n');
    write('sales.profile.yaml', 'name: prod\n');
    write('sales.profile.prod.yaml', 'name: prod\n');
    const l = await layout('eg');
    expect(l.orphanProfilePaths().map(p => path.basename(p)))
        .toEqual(['sales.profile.prod.yaml', 'sales.profile.yaml']);
  });
});


describe('SemanticModelLayout profile names per the Preview Decision', () => {
  function write(file: string, text: string): void {
    const dir = path.join(catalogPath, 'EntryGroups', 'eg');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, file), text);
  }
  const MODEL = 'version: 0.2.0.dev0/google\n';

  test('two profile files whose names differ only in case are an error', async () => {
    write('retail.yaml', MODEL);
    write('retail.profile.prod.yaml', 'name: prod\n');
    write('retail.profile.PROD.yaml', 'name: PROD\n');
    const l = await layout('eg');
    expect(() => l.profileDocuments('retail')).toThrow(/name the same profile/);
  });

  // decisions.md, naming: a profile name may contain hyphens, and still starts
  // with a letter.
  test('a profile name may contain a hyphen but not start with one', async () => {
    write('retail.yaml', MODEL);
    write('retail.profile.prod-us.yaml', 'name: prod-us\n');
    expect((await layout('eg')).profileDocuments('retail').map(d => d.name))
        .toEqual(['prod-us']);
    write('retail.profile.-us.yaml', 'name: -us\n');
    const l = await layout('eg');
    expect(() => l.profileDocuments('retail'))
        .toThrow("Profile file 'retail.profile.-us.yaml' has profile name '-us'");
  });

  test('an empty profile name is an error', async () => {
    write('retail.yaml', MODEL);
    write('retail.profile..yaml', 'name: x\n');
    const l = await layout('eg');
    expect(() => l.profileDocuments('retail')).toThrow("Profile file 'retail.profile..yaml'");
  });

  test('a directory named like a profile file is an error naming it', async () => {
    write('retail.yaml', MODEL);
    fs.mkdirSync(path.join(catalogPath, 'EntryGroups', 'eg', 'retail.profile.prod.yaml'));
    const l = await layout('eg');
    expect(() => l.profileDocuments('retail'))
        .toThrow("Profile file 'retail.profile.prod.yaml' is not a file.");
  });

  test('a profile file declaring name: default is told to change its name', async () => {
    write('retail.yaml', MODEL);
    write('retail.profile.prod.yaml', 'name: default\n');
    const l = await layout('eg');
    expect(() => l.profileDocuments('retail'))
        .toThrow("change the name in 'retail.profile.prod.yaml' to 'prod'");
  });
});
