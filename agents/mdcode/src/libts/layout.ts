// Defines the Catalog metadata layout abstraction.
//

import {DocumentsLayout} from './layouts/documents';
import {OkfLayout} from './layouts/okf';
import {StandardLayout} from './layouts/standard';
import {CatalogManifest} from './manifest';
import * as md from './metadata';

export enum Layouts {
  STANDARD = 'standard',
  DOCUMENTS = 'documents',
  OKF = 'okf',
}

// The on-disk root directory name used by each layout. OKF bundles live under
// `bundle/`; the kcmd-native layouts use `catalog/`.
export function rootDirForLayout(layout: Layouts): string {
  return layout === Layouts.OKF ? 'bundle' : 'catalog';
}

export interface CatalogLayout {
  init(): Promise<void>;

  entryExists(name: string): boolean;
  listEntries(): string[];
  loadEntry(name: string): Promise<md.Entry>;
  saveEntry(name: string, entry: md.Entry): Promise<void>;
  deleteEntry(name: string): Promise<void>;
  getEntryPaths(name: string): {local?: string; ref?: string} | undefined;

  // Optional post-sync hook (e.g. OKF regenerates reserved index.md listings
  // after a pull). Layouts that don't need it simply omit it.
  finalize?(): Promise<void>;
}

export function createLayout(
  layout: Layouts,
  catalogPath: string,
  manifest?: CatalogManifest,
): CatalogLayout {
  switch (layout) {
    case Layouts.STANDARD:
      return new StandardLayout(catalogPath, manifest);
    case Layouts.DOCUMENTS:
      return new DocumentsLayout(catalogPath);
    case Layouts.OKF:
      return new OkfLayout(catalogPath, manifest);
    default:
      throw new Error(`Unknown layout type: ${layout}`);
  }
}
