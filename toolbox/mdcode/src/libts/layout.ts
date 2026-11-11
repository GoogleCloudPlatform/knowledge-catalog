// Defines the Catalog metadata layout abstraction.
//

import * as path from 'node:path';
import * as md from './metadata';
import { StandardLayout } from './layouts/standard';
import { DocumentsLayout } from './layouts/documents';
import { SemanticModelLayout } from './layouts/semantic-model';
import { BUNDLE_DIR, OkfLayout } from './layouts/okf';
import { SplitLayout } from './layouts/split';

export enum Layouts {
  STANDARD = 'standard',
  DOCUMENTS = 'documents',
  SEMANTIC_MODEL = 'semantic-model',
  OKF = 'okf',
  SPLIT = 'split'
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
    case Layouts.SPLIT: {
      const groupId = entryGroup?.startsWith('projects/')
        ? entryGroup.split('/entryGroups/')[1] ?? entryGroup
        : entryGroup;
      const container = entryGroup?.startsWith('projects/')
        ? entryGroup
        : undefined;
      return new SplitLayout(
        new SemanticModelLayout(path.join(catalogPath, 'catalog'), groupId),
        new OkfLayout(path.join(catalogPath, BUNDLE_DIR), container),
      );
    }
    default:
      throw new Error(`Unknown layout type: ${layout}`);
  }
}
