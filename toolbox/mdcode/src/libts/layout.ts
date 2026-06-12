// Defines the Catalog metadata layout abstraction.
//

import {DocumentsLayout} from './layouts/documents';
import {StandardLayout} from './layouts/standard';
import {CatalogManifest} from './manifest';
import * as md from './metadata';

export enum Layouts {
  STANDARD = 'standard',
  DOCUMENTS = 'documents',
}

export interface CatalogLayout {
  init(): Promise<void>;

  entryExists(name: string): boolean;
  listEntries(): string[];
  loadEntry(name: string): Promise<md.Entry>;
  saveEntry(name: string, entry: md.Entry): Promise<void>;
  deleteEntry(name: string): Promise<void>;
  getEntryPaths(name: string): {local?: string; ref?: string} | undefined;
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
    default:
      throw new Error(`Unknown layout type: ${layout}`);
  }
}
