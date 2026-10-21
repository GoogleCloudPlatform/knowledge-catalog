// The `kcmd push --format=okf` path: OKF files on disk -> Knowledge Catalog.
// Stub: the flag wiring and dispatch land first so the shape is reviewable
// before any conversion logic exists.

import * as gcp from '../gcp';
import * as kcmd from '../index';

/** Options forwarded from `kcmd push`. */
export interface OkfToCatalogOptions {
  validateOnly?: boolean;
}

/**
 * Reads the OKF bundle under `bundle/` and writes it to the context set named
 * by `catalog.yaml`'s `scope`, in the progressive-disclosure shape.
 *
 * @returns a process exit code: 0 on success, non-zero on failure.
 */
export async function okfToCatalog(
  ctx: gcp.ApiContext,
  snapshot: kcmd.CatalogSnapshot,
  options: OkfToCatalogOptions = {},
): Promise<number> {
  console.error(
    'kcmd push --format=okf is not implemented yet.\n' +
      `  scope         : ${snapshot.manifest.source.name}\n` +
      `  validate-only : ${options.validateOnly ? 'yes' : 'no'}`,
  );
  return 1;
}
