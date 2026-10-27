// The `kcmd init --format=okf` path: scaffold an OKF workspace.
//
// This one is not a conversion: it
// creates the entry group if absent and writes a bundle skeleton carrying the
// minimum a later `push` needs, so a scaffolded workspace is publishable
// without first being pulled.
//
// Stub: the flag wiring and dispatch land first so the shape is reviewable
// before any scaffolding logic exists.

import * as gcp from '../gcp';
import * as kcmd from '../index';

/** Options forwarded from `kcmd init`. */
export interface InitOkfWorkspaceOptions {
  /** Pull the context set straight after scaffolding. */
  pull?: boolean;
}

/**
 * Scaffolds an OKF workspace for the given scope: `catalog.yaml` at the root,
 * and beside it a `bundle/` skeleton whose files already carry enough to form
 * a valid Dataplex request.
 *
 * @returns a process exit code: 0 on success, non-zero on failure.
 */
export async function initOkfWorkspace(
  ctx: gcp.ApiContext,
  manifest: kcmd.CatalogManifest,
  options: InitOkfWorkspaceOptions = {},
): Promise<number> {
  console.error(
    'kcmd init --format=okf is not implemented yet.\n' +
      `  scope : ${manifest.source.name}\n` +
      `  pull  : ${options.pull ? 'yes' : 'no'}`,
  );
  return 1;
}
