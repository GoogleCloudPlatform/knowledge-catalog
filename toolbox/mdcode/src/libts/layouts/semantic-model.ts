// Implements the SemanticModel layout.
//
// The whole model definition is a single Apache Ossie document per model,
// located at `catalog/EntryGroups/<entryGroupId>/<model>.yaml`. Optional
// `.aspects.yaml` / `.overview.yaml` sidecars and nested entity/metric sidecars
// are part of this layout's design but are a follow-on; this push-only
// implementation discovers and reads the model documents and nothing else.
//

import * as glob from 'glob';
import * as fs from 'node:fs';

import {CatalogLayout} from '../layout';
import * as md from '../metadata';

// Sidecar suffixes that are NOT model documents.
const SIDECAR_SUFFIXES = ['.aspects.yaml', '.overview.yaml'];


export class SemanticModelLayout implements CatalogLayout {
  private readonly _catalogPath: string;

  // Maps a model handle (the document's file basename) to its absolute path.
  private readonly _index = new Map<string, string>();

  constructor(catalogPath: string) {
    this._catalogPath = catalogPath;
  }

  async init(): Promise<void> {
    this._index.clear();

    if (!fs.existsSync(this._catalogPath)) {
      return;
    }

    // A model document is a top-level `<model>.yaml` under an EntryGroup dir,
    // excluding the `.aspects.yaml` / `.overview.yaml` sidecars.
    const matches = await glob.glob('EntryGroups/*/*.yaml', {
      cwd: this._catalogPath,
      absolute: true,
      nodir: true,
    });

    for (const localPath of matches) {
      if (SIDECAR_SUFFIXES.some(s => localPath.endsWith(s))) {
        continue;
      }

      const base = localPath.slice(localPath.lastIndexOf('/') + 1);
      const name = base.slice(0, base.length - '.yaml'.length);
      this._index.set(name, localPath);
    }
  }

  entryExists(name: string): boolean {
    const p = this._index.get(name);
    return !!p && fs.existsSync(p);
  }

  listEntries(): string[] {
    return Array.from(this._index.keys());
  }

  // Reads the raw Ossie document text for each discovered model. This is the
  // seam the push path consumes; the Ossie text is parsed to the semantic IR by
  // the loader, not mapped to a Knowledge Catalog entry here.
  modelDocuments(): {name: string; text: string}[] {
    const docs: {name: string; text: string}[] = [];
    for (const [name, localPath] of this._index) {
      docs.push({name, text: fs.readFileSync(localPath, 'utf8')});
    }
    return docs;
  }

  // The Knowledge Catalog entry-level members are not applicable to this
  // push-only layout; the model is authored as a single Ossie document, not as
  // per-entry Knowledge Catalog files. These are wired when KC-resource emit
  // and semantic-model `pull` land.
  async loadEntry(_name: string): Promise<md.Entry> {
    throw new Error(
        'The SemanticModel layout does not expose per-entry Knowledge Catalog files yet.');
  }

  async saveEntry(_name: string, _entry: md.Entry): Promise<void> {
    throw new Error(
        'The SemanticModel layout does not support writing per-entry files yet.');
  }

  async deleteEntry(_name: string): Promise<void> {
    throw new Error(
        'The SemanticModel layout does not support deleting per-entry files yet.');
  }
}
