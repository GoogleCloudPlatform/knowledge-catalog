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
import {contextSetOf, describeChanged, pullContextSetMetadata} from '../context_set';
import * as dataplex from '../gcp/dataplex';
import {BUNDLE_DIR} from '../layouts/okf';
import {CatalogManifest, writeWorkspaceLayout} from '../manifest';
import {CatalogSnapshot} from '../snapshot';
import {CatalogSync} from '../sync';

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
  manifest: CatalogManifest,
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
  const scopeType = manifest.source.type || 'entryGroup';
  fs.writeFileSync(
    'catalog.yaml',
    yaml.stringify({scope: `${scopeType}.${scopeName}`, layout: 'okf'}),
    'utf8',
  );
  const scope = scopeOf(fs.readFileSync('catalog.yaml', 'utf8'));
  if (prior !== undefined && scope !== undefined && scopeOf(prior) === scope) {
    fs.writeFileSync('catalog.yaml', prior);
    writeWorkspaceLayout('catalog.yaml', 'okf');
  }
  console.log(fs.readFileSync('catalog.yaml', 'utf8').trimEnd());

  const remoteExists = (manifest as any).okfRemoteExists === true;
  const shouldPull =
    (options.pull && remoteExists) ||
    (remoteExists && options.pull === undefined);

  if (shouldPull) {
    const snapshot = await CatalogSnapshot.fromPath('.', ctx);
    const sync = new CatalogSync(new dataplex.CatalogClient(ctx), snapshot);
    const result = await sync.pull({dryRun: false});
    if (!result.success) {
      if (result.details) console.error(`Error: ${result.details}`);
      return 1;
    }
    // The context set's display name and description, as `kcmd pull` sets
    // them.
    const ref = contextSetOf(manifest.source);
    if (ref) {
      const pulled = await pullContextSetMetadata(
        new dataplex.CatalogClient(ctx),
        ref,
        'catalog.yaml',
      );
      if (pulled.error) {
        console.error(`Error: ${pulled.error}`);
        return 1;
      }
      if (pulled.changed.length) {
        console.log(`Updated ${describeChanged(pulled.changed)} in catalog.yaml.`);
      }
    }
  } else {
    console.log(
      `Initialized OKF workspace for ${scopeName} in ${BUNDLE_DIR}/ (entry group does not exist yet; \`kcmd push\` creates it).`,
    );
  }

  fs.mkdirSync(BUNDLE_DIR, {recursive: true});
  const indexPath = path.join(BUNDLE_DIR, 'index.md');
  const agentsPath = path.join(BUNDLE_DIR, 'agents.md');
  const hasConceptFiles = fs
    .readdirSync(BUNDLE_DIR)
    .some((f) => f.endsWith('.md'));
  if (!fs.existsSync(indexPath) && !fs.existsSync(agentsPath) && !hasConceptFiles) {
    fs.writeFileSync(
      indexPath,
      `---\nokf_version: "0.2"\n---\n# ${groupId}\n`,
      'utf8',
    );
  }

  return 0;
}
