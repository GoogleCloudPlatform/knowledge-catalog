import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {createLayout, Layouts} from '../../../src/libts/layout';
import {OkfLayout} from '../../../src/libts/layouts/okf';
import * as md from '../../../src/libts/metadata';

const GROUP = 'projects/p/locations/us/entryGroups/kb';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-okf-layout-'));
});

afterEach(() => {
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
});

describe('OkfLayout (CatalogLayout)', () => {
  test('saveEntry, listEntries, loadEntry, deleteEntry round-trip md.Entry', async () => {
    const bundlePath = path.join(dir, 'bundle');
    const layout = createLayout(Layouts.OKF, bundlePath, GROUP);
    expect(layout).toBeInstanceOf(OkfLayout);
    await layout.init();

    const parent: md.Entry = {
      name: 'tables',
      type: 'dataplex-types.global.document',
      resource: {displayName: 'Tables'},
      aspects: {
        'dataplex-types.global.document': {type: 'knowledge-base'},
        'dataplex-types.global.overview': {content: '# Tables\n', contentType: 'MARKDOWN'},
      },
    };
    const child: md.Entry = {
      name: 'tables/trips',
      type: 'dataplex-types.global.document',
      resource: {
        displayName: 'Trips',
        description: 'Bikeshare trips',
        name: 'bq://p.d.trips',
        system: 'BIGQUERY',
        platform: 'GCP',
        parent: 'tables',
      },
      aspects: {
        'dataplex-types.global.document': {type: 'table-context'},
        'dataplex-types.global.overview': {
          content: '# Trips\n\n## OKF Metadata\n\n```yaml\ntags:\n  - core\n```\n',
          contentType: 'MARKDOWN',
        },
        'dataplex-types.global.schema': {fields: [{name: 'trip_id'}]},
      },
    };

    await layout.saveEntry('tables/trips', child);
    await layout.saveEntry('tables', parent);

    // Shallowest-first ordering so parents precede children.
    expect(layout.listEntries()).toEqual(['tables', 'tables/trips']);
    expect(layout.entryExists('tables/trips')).toBe(true);

    const diskText = fs.readFileSync(
      path.join(bundlePath, 'tables/trips.md'),
      'utf8',
    );
    expect(diskText).toContain('type: table-context');
    expect(diskText).toContain('tags:\n  - core');

    // Re-init from disk and verify zero fidelity loss.
    const reloaded = new OkfLayout(bundlePath, GROUP);
    await reloaded.init();
    const got = await reloaded.loadEntry('tables/trips');
    expect(got.type).toBe('dataplex-types.global.document');
    expect(got.resource.displayName).toBe('Trips');
    expect(got.resource.description).toBe('Bikeshare trips');
    expect(got.resource.name).toBe('bq://p.d.trips');
    expect(got.resource.system).toBe('BIGQUERY');
    expect(got.resource.platform).toBe('GCP');
    expect(got.resource.parent).toBe('tables');
    expect(got.aspects?.['dataplex-types.global.schema']).toEqual({
      fields: [{name: 'trip_id'}],
    });
    expect(got.aspects?.['dataplex-types.global.overview']?.['content']).toContain(
      'tags:\n  - core',
    );

    await reloaded.deleteEntry('tables/trips');
    expect(reloaded.entryExists('tables/trips')).toBe(false);
    // Deleting the last file in `bundle/tables/` prunes the empty directory.
    expect(fs.existsSync(path.join(bundlePath, 'tables'))).toBe(false);
  });

  test('rejects entry IDs that escape bundle/', async () => {
    const layout = new OkfLayout(path.join(dir, 'bundle'), GROUP);
    await layout.init();
    const evil: md.Entry = {
      name: '../evil',
      type: 'dataplex-types.global.generic',
      resource: {},
    };

    await expect(layout.saveEntry('../evil', evil)).rejects.toThrow(
      /escapes bundle\//,
    );
    await expect(layout.saveEntry('tables/../../evil', evil)).rejects.toThrow(
      /escapes bundle\//,
    );
    await expect(layout.saveEntry('/etc/passwd', evil)).rejects.toThrow(
      /escapes bundle\//,
    );
    expect(fs.existsSync(path.join(dir, 'evil.md'))).toBe(false);
  });

  test('skips reserved log.md at any level, dot-paths, and outside symlinks while keeping typed agents.md alongside okf_version index.md', async () => {
    const bundlePath = path.join(dir, 'bundle');
    fs.mkdirSync(path.join(bundlePath, 'tables'), {recursive: true});
    fs.mkdirSync(path.join(bundlePath, '.drafts'), {recursive: true});

    // Bundle-root index.md declaring okf_version: "0.2" (OKF v0.2 §§8, 12) alongside typed `agents.md`.
    fs.writeFileSync(
      path.join(bundlePath, 'index.md'),
      '---\nokf_version: "0.2"\n---\n# Index\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(bundlePath, 'agents.md'),
      '---\ntype: Knowledge Base Root\ntitle: Router\n---\n# Router\n',
      'utf8',
    );

    // Reserved `log.md` at root and subdirectory levels (OKF v0.2 §§3.1, 9).
    fs.writeFileSync(path.join(bundlePath, 'log.md'), '## 2026-11-03\n', 'utf8');
    fs.writeFileSync(
      path.join(bundlePath, 'tables/log.md'),
      '---\ntype: Ignored\n---\n## 2026-11-03\n',
      'utf8',
    );

    // Hidden dot-files and dot-directories.
    fs.writeFileSync(
      path.join(bundlePath, '.hidden.md'),
      '---\ntype: Metric\n---\n# Hidden\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(bundlePath, '.drafts/wip.md'),
      '---\ntype: Metric\n---\n# WIP\n',
      'utf8',
    );

    // Symlink escaping outside `bundle/`.
    const outsideFile = path.join(dir, 'outside.md');
    fs.writeFileSync(outsideFile, '---\ntype: Metric\n---\n# Outside\n', 'utf8');
    fs.symlinkSync(outsideFile, path.join(bundlePath, 'escaped-link.md'));

    // Valid typed concept under `tables/`.
    fs.writeFileSync(
      path.join(bundlePath, 'tables/orders.md'),
      '---\ntype: BigQuery Table\ntitle: Orders\n---\n# Orders\n',
      'utf8',
    );

    const layout = new OkfLayout(bundlePath, GROUP);
    await layout.init();

    expect(layout.listEntries()).toEqual(['agents', 'tables/orders']);
  });
});
