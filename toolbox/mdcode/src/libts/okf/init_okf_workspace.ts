// The `kcmd init --format=okf` path: scaffold an OKF workspace.
//
// Writes `catalog.yaml` (`scope: entryGroup.<project>.<location>.<id>` and
// `layout: okf`, which `kcmd pull` and `kcmd push` read to take the OKF path)
// and a `bundle/index.md` root skeleton. If `--pull` is set (or the entry group
// already exists remotely via `init`), pulls the remote entries into `bundle/`.
// When the entry group does not exist yet, it is left uncreated until `kcmd push`
// (so plan/review gates hold before any remote mutation).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import * as gcp from '../gcp';
import * as kcmd from '../index';
import {writeWorkspaceLayout} from '../manifest';
import {catalogToOkf} from './catalog_to_okf';

/** Options forwarded from `kcmd init`. */
export interface InitOkfWorkspaceOptions {
  /** Pull the context set straight after scaffolding. */
  pull?: boolean;
}

function scopeOf(text: string): string | undefined {
  try {
    return JSON.stringify(yaml.parse(text)?.scope);
  } catch {
    return undefined;
  }
}

/**
 * Scaffolds an OKF workspace for the given scope: `catalog.yaml` at the root,
 * and beside it a `bundle/` directory (pulling existing concepts if the
 * EntryGroup exists remotely and `--pull` is requested or `okfRemoteExists` is set).
 *
 * @returns a process exit code: 0 on success, non-zero on failure.
 */
export async function initOkfWorkspace(
  ctx: gcp.ApiContext,
  manifest: kcmd.CatalogManifest,
  options: InitOkfWorkspaceOptions = {},
): Promise<number> {
  const scopeName = manifest?.source?.name ?? '';
  const parts = scopeName.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) {
    console.error(
      `Error: EntryGroup must be in format <projectId>.<locationId>.<entryGroupId>: '${scopeName}'`,
    );
    return 1;
  }
  const [, , groupId] = parts;

  const prior = fs.existsSync('catalog.yaml')
    ? fs.readFileSync('catalog.yaml', 'utf8')
    : undefined;
  if (typeof (manifest as any).save === 'function') {
    manifest.save('catalog.yaml');
  } else {
    const scopeType = manifest.source.type || 'entryGroup';
    fs.writeFileSync(
      'catalog.yaml',
      yaml.stringify({scope: `${scopeType}.${scopeName}`}),
      'utf8',
    );
  }
  const scope = scopeOf(fs.readFileSync('catalog.yaml', 'utf8'));
  if (prior !== undefined && scope !== undefined && scopeOf(prior) === scope) {
    fs.writeFileSync('catalog.yaml', prior);
  }
  writeWorkspaceLayout('catalog.yaml', 'okf');
  console.log(fs.readFileSync('catalog.yaml', 'utf8').trimEnd());

  const bundleDir = 'bundle';
  fs.mkdirSync(bundleDir, {recursive: true});
  const indexPath = path.join(bundleDir, 'index.md');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(
      indexPath,
      `---\nokf_version: "0.2"\n---\n# ${groupId}\n`,
      'utf8',
    );
  }

  const remoteExists = (manifest as any).okfRemoteExists === true;
  if (options.pull && remoteExists) {
    const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
    const pullCode = await catalogToOkf(ctx, snapshot, {dryRun: false});
    if (pullCode !== 0) {
      return pullCode;
    }
  } else if (remoteExists && options.pull === undefined) {
    const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
    const pullCode = await catalogToOkf(ctx, snapshot, {dryRun: false});
    if (pullCode !== 0) {
      return pullCode;
    }
  } else {
    console.log(
      `Initialized OKF workspace for ${scopeName} in ${bundleDir}/ (entry group does not exist yet; \`kcmd push\` creates it).`,
    );
  }

  return 0;
}
