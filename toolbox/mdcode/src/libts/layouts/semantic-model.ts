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
import * as yaml from 'yaml';

import {CatalogLayout} from '../layout';
import * as md from '../metadata';

// Sidecar suffixes that are NOT model documents.
const SIDECAR_SUFFIXES = ['.aspects.yaml', '.overview.yaml'];

// A binding-profile file sits beside its model as `<model>.profile.<name>.yaml`.
// `<model>.profile.yaml`, with no name, is not a model either.
const PROFILE_FILE = /^(.+)\.profile\.([^.]+)\.yaml$/;
// Any file shaped like a profile file, including a nameless one and one whose
// profile name has a dot, which is never a model either.
const ANY_PROFILE_FILE = /\.profile\.(.*\.)?yaml$/;
// A profile name: a letter, then letters, digits, underscores and hyphens, at
// most 500 characters (decisions.md, naming).
const PROFILE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,499}$/;

// The profile name reserved for the inline bindings in the model file.
const DEFAULT_PROFILE_NAME = 'default';

// The flavor that keeps its profiles inline, in a GOOGLE block, and so has no
// sibling profile files.
const VANILLA_VERSION = '0.2.0.dev0';


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
      const base = path.basename(localPath);
      if (ANY_PROFILE_FILE.test(base)) continue;

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

  // The binding-profile files beside a model, by profile name: sibling
  // `<model>.profile.<name>.yaml` files in the model's EntryGroup dir. When a
  // model has none, the older `<model>.profiles/*.yaml` directory is read
  // instead, until the fixtures and the demo move to sibling files.
  profilePaths(model: string): {name: string; path: string}[] {
    const siblings = this._siblingProfilePaths(model);
    return siblings.length ? siblings : this._legacyProfilePaths(model);
  }

  // The text of each profile file beside a model, by profile name. Sibling
  // files are checked first, and the first problem found with any of them
  // throws, naming the file:
  //   - a `<model>.profile.yaml` names no profile;
  //   - the file's `name:` must equal its filename suffix, because `pull`
  //     writes a profile back to the file its name implies;
  //   - `default` names the model's inline bindings, so no profile may use it;
  //   - a vanilla `0.2.0.dev0` model keeps its profiles in its GOOGLE block, so
  //     it may have no sibling profile files;
  //   - the files are named after the model, so the model file must declare
  //     that name, which `pull` uses to name both.
  profileDocuments(model: string): {name: string; text: string}[] {
    const nameless = this._entryGroup ?
        path.join(this._groupDir(), `${model}.profile.yaml`) :
        undefined;
    if (nameless && fs.existsSync(nameless)) {
      throw new Error(
          `Profile file '${path.basename(nameless)}' names no profile; ` +
          `rename it '${model}.profile.<name>.yaml'.`);
    }
    const prefix = `${model}.profile.`;
    const badName = this._entryGroup && fs.existsSync(this._groupDir()) ?
        fs.readdirSync(this._groupDir()).find(f => {
          if (!f.startsWith(prefix) || !f.endsWith('.yaml')) return false;
          const n = f.slice(prefix.length, -'.yaml'.length);
          return f !== `${model}.profile.yaml` && !PROFILE_NAME.test(n);
        }) :
        undefined;
    if (badName) {
      throw new Error(
          `Profile file '${badName}' has profile name '${
              badName.slice(prefix.length, -'.yaml'.length)}'; a profile ` +
          `name is a letter followed by letters, digits, underscores and ` +
          `hyphens.`);
    }
    const siblings = this._siblingProfilePaths(model);
    if (!siblings.length) {
      return this._legacyProfilePaths(model).map(
          ({name, path: p}) => ({name, text: fs.readFileSync(p, 'utf8')}));
    }
    const modelFile = `${model}.yaml`;
    const header = this._modelHeader(model);
    if (header.name !== undefined && header.name !== model) {
      throw new Error(
          `Profile file '${path.basename(siblings[0].path)}' is named after ` +
          `'${modelFile}', which declares model '${header.name}'; a profile ` +
          `file is named after its model, so name the model file and its ` +
          `profile files after '${header.name}'.`);
    }
    const version = header.version;
    const docs: {name: string; text: string}[] = [];
    // Profile names are unique ignoring case (Preview Decision, naming).
    const byLowerName = new Map<string, string>();
    for (const {name, path: p} of siblings) {
      const file = path.basename(p);
      const twin = byLowerName.get(name.toLowerCase());
      if (twin) {
        throw new Error(
            `Profile files '${twin}' and '${file}' name the same profile; ` +
            `profile names are unique ignoring case.`);
      }
      byLowerName.set(name.toLowerCase(), file);
      if (!fs.statSync(p).isFile()) {
        throw new Error(`Profile file '${file}' is not a file.`);
      }
      if (version === VANILLA_VERSION) {
        throw new Error(
            `Profile file '${file}' sits beside '${modelFile}', which is a ` +
            `${VANILLA_VERSION} document; sibling profile files are ` +
            `Google-flavor only, and a ${VANILLA_VERSION} model keeps its ` +
            `profiles in its GOOGLE block.`);
      }
      const text = fs.readFileSync(p, 'utf8');
      const declared = profileNameIn(text, file);
      const reserved = (n?: string) =>
          n?.toLowerCase() === DEFAULT_PROFILE_NAME;
      if (reserved(name)) {
        throw new Error(
            `Profile name '${DEFAULT_PROFILE_NAME}' is reserved for the ` +
            `inline bindings in '${modelFile}'; remove '${file}'.`);
      }
      if (reserved(declared)) {
        throw new Error(
            `Profile name '${DEFAULT_PROFILE_NAME}' is reserved for the ` +
            `inline bindings in '${modelFile}'; change the name in '${
                file}' to '${name}'.`);
      }
      if (declared === undefined) {
        throw new Error(
            `Profile file '${file}' declares no name; add 'name: ${name}'.`);
      }
      if (declared !== name) {
        throw new Error(
            `Profile file '${file}' declares name '${declared}', which ` +
            `does not match filename suffix '${name}'.`);
      }
      docs.push({name, text});
    }
    return docs;
  }

  // The text of one profile file beside a model, or undefined when the model
  // has no profile of that name. The rules `profileDocuments` enforces apply.
  profileDocument(model: string, profileName: string): string|undefined {
    return this.profileDocuments(model).find(d => d.name === profileName)
        ?.text;
  }

  // The path a profile file for this model and profile name maps to:
  // `<catalog>/EntryGroups/<entryGroup>/<model>.profile.<name>.yaml`.
  profilePath(model: string, profileName: string): string {
    return path.join(this._groupDir(), `${model}.profile.${profileName}.yaml`);
  }

  // Writes a profile file beside its model, creating the EntryGroup directory
  // if needed, for `pull` to write a catalog profile through.
  writeProfileDocument(model: string, profileName: string, text: string):
      void {
    const localPath = this.profilePath(model, profileName);
    fs.mkdirSync(path.dirname(localPath), {recursive: true});
    fs.writeFileSync(localPath, text);
  }

  // Deletes a profile file, for `pull --force-remove` to drop a local profile
  // the catalog no longer has.
  removeProfileDocument(model: string, profileName: string): void {
    const localPath = this.profilePath(model, profileName);
    if (fs.existsSync(localPath)) fs.rmSync(localPath);
  }

  // Profile files with no model beside them, for push to report: any
  // `<prefix>.profile.<name>.yaml`, or nameless `<prefix>.profile.yaml`, where
  // `<prefix>.yaml` does not exist.
  orphanProfilePaths(): string[] {
    const dir = this._entryGroup ? this._groupDir() : undefined;
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => {
          if (!ANY_PROFILE_FILE.test(f)) return false;
          const prefix = f.slice(0, f.indexOf('.profile.'));
          return !fs.existsSync(path.join(dir, `${prefix}.yaml`));
        })
        .sort()
        .map(f => path.join(dir, f));
  }

  // The older `<model>.profiles/` directories in the EntryGroup dir, which the
  // fixture migration replaces with sibling files.
  legacyProfileDirs(): string[] {
    const dir = this._entryGroup ? this._groupDir() : undefined;
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.profiles') &&
                    fs.statSync(path.join(dir, f)).isDirectory())
        .sort()
        .map(f => path.join(dir, f));
  }

  private _groupDir(): string {
    if (!this._entryGroup) {
      throw new Error(
          'SemanticModel layout has no entry group; cannot resolve a profile path.');
    }
    return path.join(this._catalogPath, 'EntryGroups', this._entryGroup);
  }

  private _siblingProfilePaths(model: string): {name: string; path: string}[] {
    if (!this._entryGroup) return [];
    const dir = this._groupDir();
    if (!fs.existsSync(dir)) return [];
    const out: {name: string; path: string}[] = [];
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(PROFILE_FILE);
      if (m && m[1] === model) out.push({name: m[2], path: path.join(dir, f)});
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // `<model>.profiles/*.yaml`, each named by its file basename.
  private _legacyProfilePaths(model: string): {name: string; path: string}[] {
    if (!this._entryGroup) return [];
    const dir = path.join(this._groupDir(), `${model}.profiles`);
    if (!fs.existsSync(dir)) return [];
    const out: {name: string; path: string}[] = [];
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.yaml')) continue;
      if (SIDECAR_SUFFIXES.some(s => entry.endsWith(s))) continue;
      out.push(
          {name: path.basename(entry, '.yaml'), path: path.join(dir, entry)});
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // The `version` and model `name` a model document declares, each undefined
  // when the document has none or does not parse; the loader reports both.
  private _modelHeader(model: string): {version?: string; name?: string} {
    const localPath = this._index.get(model);
    if (!localPath) return {};
    try {
      const doc = yaml.parse(fs.readFileSync(localPath, 'utf8'));
      const name = Array.isArray(doc?.semantic_model) ?
          doc.semantic_model[0]?.name :
          undefined;
      return {
        version: typeof doc?.version === 'string' ? doc.version : undefined,
        name: typeof name === 'string' ? name : undefined,
      };
    } catch {
      return {};
    }
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

  // Deletes a model document from disk and the index. `pull --force-remove`
  // uses it to drop a local model the catalog no longer names before writing
  // the catalog's, so the entry group is never left holding two models.
  removeModelDocument(name: string): void {
    const localPath = this.modelPath(name);
    if (fs.existsSync(localPath)) {
      fs.rmSync(localPath);
    }
    this._index.delete(name);
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

// The `name` a profile file declares at its top level, or undefined when it
// declares none. A file that does not parse throws, naming the file.
function profileNameIn(text: string, file: string): string|undefined {
  let doc: any;
  try {
    doc = yaml.parse(text);
  } catch (err: any) {
    throw new Error(
        `Profile file '${file}' does not parse: ${err?.message ?? err}`);
  }
  return typeof doc?.name === 'string' ? doc.name : undefined;
}
