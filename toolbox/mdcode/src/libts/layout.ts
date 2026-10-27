// Defines the Catalog metadata layout abstraction.
//

import * as md from './metadata';
import { StandardLayout } from './layouts/standard';
import { DocumentsLayout } from './layouts/documents';
import { SemanticModelLayout } from './layouts/semantic-model';
import type { CatalogSource } from './source';
import type { SemanticModelSource } from './sources/semantic-model';

export enum Layouts {
  STANDARD = 'standard',
  DOCUMENTS = 'documents',
  SEMANTIC_MODEL = 'semantic-model'
}


export interface CatalogLayout {
  init(): Promise<void>;

  entryExists(name: string): boolean;
  listEntries(): string[];
  loadEntry(name: string): Promise<md.Entry>;
  saveEntry(name: string, entry: md.Entry): Promise<void>;
  deleteEntry(name: string): Promise<void>;

  // Save or delete several entries in one call, in order, with one result per
  // item in the same order. A failed item is reported, nothing of it is
  // written, and the other items still apply. Callers go through
  // CatalogSnapshot, which takes the workspace lock and passes each name at
  // most once per call. A layout that keeps each entry in its own file uses
  // saveEachEntry and deleteEachEntry (layouts/batch.ts).
  saveEntries(entries: md.Entry[]): Promise<md.EntryResult[]>;
  deleteEntries(names: string[]): Promise<md.EntryResult[]>;
}


// The layout a source's workspace uses, rooted at `catalogPath`.
export function createLayout(source: CatalogSource,
                             catalogPath: string): CatalogLayout {
  switch (source.layout) {
    case Layouts.STANDARD:
      return new StandardLayout(catalogPath);
    case Layouts.DOCUMENTS:
      return new DocumentsLayout(catalogPath);
    case Layouts.SEMANTIC_MODEL: {
      // Only a SemanticModelSource declares this layout.
      const {project, location, entryGroup} = source as SemanticModelSource;
      return new SemanticModelLayout(catalogPath, entryGroup, {project, location});
    }
    default:
      throw new Error(`Unknown layout type: ${source.layout}`);
  }
}
