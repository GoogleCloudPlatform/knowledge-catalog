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
});
