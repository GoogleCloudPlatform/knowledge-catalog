// The `kcmd pull --format=okf` path: Knowledge Catalog -> OKF files on disk.
// Stub: the flag wiring and dispatch land first so the shape is reviewable
// before any conversion logic exists.

import * as gcp from '../gcp';
import * as kcmd from '../index';

/** Options forwarded from `kcmd pull`. */
export interface CatalogToOkfOptions {
  /** Report what would be written; touch no files. */
  dryRun?: boolean;
}

/**
 * Reads the context set named by `catalog.yaml`'s `scope` and materializes it
 * as an OKF v0.2 bundle under `bundle/`.
 *
 * The manifest stays a sibling of `bundle/`, never inside it, so the bundle is
 * a portable OKF bundle with nothing kcmd-specific in it.
 *
 * @returns a process exit code: 0 on success, non-zero on failure.
 */
export async function catalogToOkf(
  ctx: gcp.ApiContext,
  snapshot: kcmd.CatalogSnapshot,
  options: CatalogToOkfOptions = {},
): Promise<number> {
  console.error(
    'kcmd pull --format=okf is not implemented yet.\n' +
      `  scope   : ${snapshot.manifest.source.name}\n` +
      `  dry-run : ${options.dryRun ? 'yes' : 'no'}`,
  );
  return 1;
}
