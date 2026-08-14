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
import * as path from 'node:path';

import {CatalogLayout} from '../layout';
import * as md from '../metadata';

// Sidecar suffixes that are NOT model documents.
const SIDECAR_SUFFIXES = ['.aspects.yaml', '.overview.yaml'];


export class SemanticModelLayout implements CatalogLayout {
  private readonly _catalogPath: string;
  private readonly _entryGroup?: string;

  // Maps a model handle (the document's file basename) to its absolute path.
  private readonly _index = new Map<string, string>();

  constructor(catalogPath: string, entryGroup?: string) {
    this._catalogPath = catalogPath;
    this._entryGroup = entryGroup;
  }

  async init(): Promise<void> {
    this._index.clear();

    if (!fs.existsSync(this._catalogPath)) {
      return;
    }

    // A model document is a top-level `<model>.yaml` under the configured
    // EntryGroup dir, excluding the `.aspects.yaml` / `.overview.yaml`
    // sidecars. Scoping to the manifest's entryGroup keeps unrelated group
    // directories out of the deploy set and avoids the basename collision that
    // a cross-group `EntryGroups/*/*.yaml` glob would produce (same file name
    // in two groups). Fall back to all groups only when no scope was provided.
    const pattern = this._entryGroup ?
        `EntryGroups/${this._entryGroup}/*.yaml` :
        'EntryGroups/*/*.yaml';
    const matches = await glob.glob(pattern, {
      cwd: this._catalogPath,
      absolute: true,
      nodir: true,
    });

    for (const localPath of matches) {
      if (SIDECAR_SUFFIXES.some(s => localPath.endsWith(s))) {
        continue;
      }

      const name = path.basename(localPath, '.yaml');
      this._index.set(name, localPath);
    }
  }

  // Consistent with listEntries(): this push-only layout exposes no per-entry
  // Knowledge Catalog files, so no entry "exists" at the KC layer. Answering
  // from _index (which holds model-document handles) would report an entry that
  // listEntries() won't return and that loadEntry()/saveEntry() reject. The
  // model documents are surfaced via modelDocuments(), not as entries.
  entryExists(_name: string): boolean {
    return false;
  }

  // This is a push-only layout: it exposes no per-entry Knowledge Catalog
  // files, so it lists no entries. Returning model handles here would make
  // callers that pair listEntries() with loadEntry() -- e.g. the MCP server --
  // list a model and then throw on read. modelDocuments() is the sole accessor
  // for the authored model documents.
  listEntries(): string[] {
    return [];
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

  // True when a model document with this handle already exists on disk. `pull`
  // uses it to report which files it would overwrite vs. create.
  hasModel(name: string): boolean {
    return fs.existsSync(this.modelPath(name));
  }

  // The absolute path a model document with this handle maps to:
  // `<catalog>/EntryGroups/<entryGroup>/<name>.yaml`. Path separators in the
  // model name are replaced so a name still yields a single flat file. Requires
  // the layout to be scoped to an entry group (the semantic-model source always
  // is).
  modelPath(name: string): string {
    if (!this._entryGroup) {
      throw new Error(
          'SemanticModel layout has no entry group; cannot resolve a model path.');
    }
    const file = `${name.replace(/[/\\]/g, '_')}.yaml`;
    return path.join(this._catalogPath, 'EntryGroups', this._entryGroup, file);
  }

  // Writes a model's serialized document to its path, creating the EntryGroup
  // directory if needed, and indexes it so a later modelDocuments() sees it.
  // This is the sink `pull` writes reconstructed models to.
  writeModelDocument(name: string, text: string): void {
    const localPath = this.modelPath(name);
    fs.mkdirSync(path.dirname(localPath), {recursive: true});
    fs.writeFileSync(localPath, text);
    this._index.set(name, localPath);
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
