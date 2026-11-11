// Defines the Catalog metadata layout abstraction.
//

import * as md from './metadata';
import { StandardLayout } from './layouts/standard';
import { DocumentsLayout } from './layouts/documents';
import { SemanticModelLayout } from './layouts/semantic-model';
import { OkfLayout } from './layouts/okf';

export enum Layouts {
  STANDARD = 'standard',
  DOCUMENTS = 'documents',
  SEMANTIC_MODEL = 'semantic-model',
  OKF = 'okf'
}


export interface CatalogLayout {
  init(): Promise<void>;

  entryExists(name: string): boolean;
  listEntries(): string[];
  loadEntry(name: string): Promise<md.Entry>;
  saveEntry(name: string, entry: md.Entry): Promise<void>;
  deleteEntry(name: string): Promise<void>;
}


export function createLayout(layout: Layouts,
                             catalogPath: string,
                             entryGroup?: string): CatalogLayout {
  switch (layout) {
    case Layouts.STANDARD:
      return new StandardLayout(catalogPath);
    case Layouts.DOCUMENTS:
      return new DocumentsLayout(catalogPath);
    case Layouts.SEMANTIC_MODEL:
      return new SemanticModelLayout(catalogPath, entryGroup);
    case Layouts.OKF:
      return new OkfLayout(catalogPath, entryGroup);
    default:
      throw new Error(`Unknown layout type: ${layout}`);
  }
}
