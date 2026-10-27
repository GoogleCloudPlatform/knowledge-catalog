// Defines the Catalog metadata layout abstraction.
//

import * as path from 'node:path';

import * as md from './metadata';
import { StandardLayout } from './layouts/standard';
import { DocumentsLayout } from './layouts/documents';
import { OkfLayout } from './layouts/okf';
import { SemanticModelLayout } from './layouts/semantic-model';
import { SplitLayout } from './layouts/split';
import { BUNDLE_DIR, CATALOG_DIR } from './okf/bundle';
import type { CatalogSource } from './source';
import type { SemanticModelSource } from './sources/semantic-model';
import type { SplitSource } from './sources/split';

export enum Layouts {
  STANDARD = 'standard',
  DOCUMENTS = 'documents',
  SEMANTIC_MODEL = 'semantic-model',
  SPLIT = 'split'
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


// The layout a source's workspace uses, for a workspace rooted at `basePath`.
// Each layout names the folder it keeps its files in, so that a layout which
// uses more than one folder can say so here rather than deriving a second one
// from the first.
export function createLayout(source: CatalogSource,
                             basePath: string): CatalogLayout {
  const catalogPath = path.join(basePath, CATALOG_DIR);
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
    case Layouts.SPLIT: {
      // Only a SplitSource declares this layout. Its two halves sit in
      // different folders: the model where a semantic-model workspace keeps
      // it, the bundle beside it so that bundle/ on its own is portable OKF.
      const split = source as SplitSource;
      return new SplitLayout(
          new SemanticModelLayout(catalogPath, split.entryGroup,
                                  {project: split.project, location: split.location}),
          new OkfLayout(path.join(basePath, BUNDLE_DIR), split.groupName));
    }
    default:
      throw new Error(`Unknown layout type: ${source.layout}`);
  }
}
