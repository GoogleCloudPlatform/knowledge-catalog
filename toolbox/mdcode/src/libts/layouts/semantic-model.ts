// Implements the SemanticModel layout.
//
// The whole model definition is a single Apache Ossie document per model,
// located at `catalog/EntryGroups/<entryGroupId>/<model>.yaml`, with its
// profile files beside it. Each Knowledge Catalog entry of the model may have
// an overview sidecar at its entry id under the same directory:
// `<model>.overview.md` for the model and, for example,
// `<model>/entities/<entity>.overview.md` for an entity. Push reads the model
// documents; the entry methods show the model as the entries push would write
// for it, plus one `semantic-relationship` entry per relationship
// (semantic/model_entries.ts).
//

import * as glob from 'glob';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

import {CatalogLayout} from '../layout';
import * as md from '../metadata';
import {writeFileAtomic} from '../fsutil';
import {kcV2Aspects} from '../semantic/kc_ids';
import {modelDocumentVersion} from '../semantic/loader';
import {deleteModelEntries, SaveOutcome, saveModelEntries} from '../semantic/model_edits';
import {documentEntries, ModelFile, ModelScope, ViewEntry} from '../semantic/model_entries';
import {nameProblem} from '../semantic/names';
import {YAML_OPTIONS} from '../semantic/yaml_options';

import {joinFrontmatter, splitFrontmatter} from './documents';

// The project and location of a semantic-model scope, which name the entries
// of the entry view.
export interface LayoutScope {
  project: string;
  location: string;
}

// Sidecar suffixes that are NOT model documents.
const SIDECAR_SUFFIXES = ['.aspects.yaml', '.overview.yaml'];

// A binding-profile file sits beside its model as `<model>.profile.<name>.yaml`.
// `<model>.profile.yaml`, with no name, is not a model either.
const PROFILE_FILE = /^(.+)\.profile\.([^.]+)\.yaml$/;
// Any file shaped like a profile file, including a nameless one and one whose
// profile name has a dot, which is never a model either.
const ANY_PROFILE_FILE = /\.profile\.(.*\.)?yaml$/;

// The suffix of an entry's overview sidecar.
const OVERVIEW_SIDECAR = '.overview.md';

// The overview fields an entry's sidecar holds: `contentType` and `links` in
// its frontmatter, and `content` in its body.
export interface OverviewSidecar {
  content?: string;
  contentType?: string;
  links?: Array<{url: string; title?: string}>;
}

// The profile name reserved for the inline bindings in the model file.
const DEFAULT_PROFILE_NAME = 'default';

// The flavor that keeps its profiles inline, in a GOOGLE block, and so has no
// sibling profile files.
const VANILLA_VERSION = '0.2.0.dev0';


// The error for a sibling profile file beside a vanilla model, which keeps its
// profiles in its GOOGLE block.
function vanillaSiblingError(file: string, model: string): string {
  return `Profile file '${file}' sits beside '${model}.yaml', which is a ` +
      `${VANILLA_VERSION} document; sibling profile files are Google-flavor ` +
      `only, and a ${VANILLA_VERSION} model keeps its profiles in its GOOGLE ` +
      `block.`;
}

export class SemanticModelLayout implements CatalogLayout {
  private readonly _catalogPath: string;
  private readonly _entryGroup?: string;
  private readonly _scope?: LayoutScope;

  // Maps a model handle (the document's file basename) to its absolute path.
  private readonly _index = new Map<string, string>();

  // The entry view of the model file, by bare entry ID, and the file text it
  // was computed from.
  private _view?: {text: string; entries: Map<string, ViewEntry>};

  // `scope` names the entries of the entry view; without it, the entry
  // methods throw once the entry group holds a model file.
  constructor(catalogPath: string, entryGroup?: string, scope?: LayoutScope) {
    this._catalogPath = catalogPath;
    this._entryGroup = entryGroup;
    this._scope = scope;
  }

  async init(): Promise<void> {
    this._index.clear();
    this._view = undefined;

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

  // The entry methods answer from the entry view: the entries push would
  // write for the model file, named by their bare entry IDs, plus one
  // `semantic-relationship` entry per relationship. An empty entry group has
  // no entries. A model file that does not load fails each of them with the
  // loader's message. Reading the model file needs the SQL parser, which the
  // entry points load (loadSqlEngine) before they open the workspace.
  entryExists(name: string): boolean {
    return this._entries().has(name);
  }

  listEntries(): string[] {
    return [...this._entries().keys()];
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
  // instead, until the fixtures and the demo move to sibling files. A vanilla
  // model must have neither.
  profilePaths(model: string): {name: string; path: string}[] {
    const siblings = this._siblingProfilePaths(model);
    if (!siblings.length) return this._flavorCheckedLegacyProfilePaths(model);
    if (this._modelHeader(model).version === VANILLA_VERSION) {
      throw new Error(
          vanillaSiblingError(path.basename(siblings[0].path), model));
    }
    return siblings;
  }

  // Every local profile file of a model, for pull to find the ones the
  // catalog did not return: each sibling file whose name is a valid profile
  // name, with that name, then each file in the older `<model>.profiles/`
  // directory. Unlike profilePaths it applies no flavor check, and sibling
  // files do not hide the older directory. A sibling file with an invalid
  // profile name is left out; push rejects it, naming it.
  localProfileFiles(model: string): {path: string; profileName?: string}[] {
    return [
      ...this._siblingProfilePaths(model)
          .filter(p => !nameProblem('profile', p.name))
          .map(p => ({path: p.path, profileName: p.name})),
      ...this._legacyProfilePaths(model).map(p => ({path: p.path})),
    ];
  }

  // The overview sidecar of each entry, by entry id. Throws naming a sidecar
  // parseOverviewSidecar rejects.
  overviewSidecars(): Map<string, OverviewSidecar> {
    return new Map(this.overviewSidecarPaths().map(
        ({entryId, path: p}) => [
          entryId,
          parseOverviewSidecar(
              fs.readFileSync(p, 'utf8'), path.relative(this._groupDir(), p)),
        ]));
  }

  // Each overview sidecar on disk at a model, entity, metric or relationship
  // path, with the entry id its path names, in path order.
  overviewSidecarPaths(): {entryId: string; path: string}[] {
    if (!this._entryGroup) return [];
    const dir = this._groupDir();
    const files = glob.globSync(
        [
          `*${OVERVIEW_SIDECAR}`,
          `*/{entities,metrics,relationships}/*${OVERVIEW_SIDECAR}`,
        ],
        {cwd: dir, nodir: true, posix: true});
    return files.sort().map(f => ({
                             entryId: f.slice(0, -OVERVIEW_SIDECAR.length),
                             path: path.join(dir, f),
                           }));
  }

  // The text and path of each profile file beside a model, by profile name.
  // Sibling files are checked first, and the first problem found with any of
  // them throws, naming the file:
  //   - a `<model>.profile.yaml` names no profile;
  //   - the file's `name:` must equal its filename suffix, because `pull`
  //     writes a profile back to the file its name implies;
  //   - `default` names the model's inline bindings, so no profile may use it;
  //   - a vanilla `0.2.0.dev0` model keeps its profiles in its GOOGLE block, so
  //     it must have no sibling profile files and no `<model>.profiles/`
  //     directory;
  //   - the files are named after the model, so the model file must declare
  //     that name, which `pull` uses to name both.
  profileDocuments(model: string):
      {name: string; text: string; path: string}[] {
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
          return f !== `${model}.profile.yaml` &&
              nameProblem('profile', n) !== undefined;
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
      return this._flavorCheckedLegacyProfilePaths(model).map(
          ({name, path: p}) =>
              ({name, text: fs.readFileSync(p, 'utf8'), path: p}));
    }
    const modelFile = `${model}.yaml`;
    const header = this._modelHeader(model);
    if (header.name !== undefined && header.name !== model) {
      // A name the loader rejects cannot name the files either.
      const problem = nameProblem('model', header.name);
      if (problem) throw new Error(`Model file '${modelFile}': ${problem}`);
      throw new Error(
          `Profile file '${path.basename(siblings[0].path)}' is named after ` +
          `'${modelFile}', which declares model '${header.name}'; a profile ` +
          `file is named after its model, so name the model file and its ` +
          `profile files after '${header.name}'.`);
    }
    const version = header.version;
    const docs: {name: string; text: string; path: string}[] = [];
    // Profile names are unique ignoring case.
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
        throw new Error(vanillaSiblingError(file, model));
      }
      const text = fs.readFileSync(p, 'utf8');
      const declared = parseProfileName(text, file);
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
      docs.push({name, text, path: p});
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
  // `<catalog>/EntryGroups/<entryGroup>/<model>.profile.<name>.yaml`. Throws
  // when `profileName` breaks the profile naming rule or `model` holds a path
  // separator, so a name read from elsewhere cannot point outside the entry
  // group.
  profilePath(model: string, profileName: string): string {
    if (/[\\/]/.test(model)) {
      throw new Error(`Model name '${model}' is not valid in a file name.`);
    }
    if (nameProblem('profile', profileName)) {
      throw new Error(
          `Profile name '${profileName}' is not valid; a profile name is a ` +
          `letter, then letters, digits, underscores or hyphens.`);
    }
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

  // `<model>.profiles/*.yaml`, each named by its file basename. A model name
  // that pull read from the catalog may hold a path separator, and with it a
  // `..` segment, so such a name has no directory here.
  private _legacyProfilePaths(model: string): {name: string; path: string}[] {
    if (!this._entryGroup || /[\\/]/.test(model)) return [];
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

  // The older `<model>.profiles/*.yaml` files of a model. A vanilla model keeps
  // its profiles in its GOOGLE block, so it must have no such directory, just
  // as it must have no sibling profile files.
  private _flavorCheckedLegacyProfilePaths(model: string):
      {name: string; path: string}[] {
    const legacy = this._legacyProfilePaths(model);
    if (legacy.length && this._modelHeader(model).version === VANILLA_VERSION) {
      throw new Error(
          `Profile directory '${model}.profiles/' sits beside ` +
          `'${model}.yaml', which is a ${VANILLA_VERSION} document; profile ` +
          `files are Google-flavor only, and a ${VANILLA_VERSION} model ` +
          `keeps its profiles in its GOOGLE block.`);
    }
    return legacy;
  }

  // The `version` and model `name` a model document declares, each undefined
  // when the document has none. In a document with a YAML error, the version
  // is read as the lookup of its GOOGLE block profiles reads it, and is
  // undefined when the error may change it. The name is undefined then, since
  // the error can change the name the text seems to declare. The loader
  // reports the error.
  private _modelHeader(model: string): {version?: string; name?: string} {
    const localPath = this._index.get(model);
    if (!localPath) return {};
    try {
      const text = fs.readFileSync(localPath, 'utf8');
      let doc: any;
      try {
        doc = yaml.parse(text, YAML_OPTIONS);
      } catch {
        // A YAML error; the name stays undefined.
      }
      const name = Array.isArray(doc?.semantic_model) ?
          doc.semantic_model[0]?.name :
          undefined;
      return {
        version: modelDocumentVersion(text),
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

  // A copy of the entry, so a caller's edits never reach the view.
  async loadEntry(name: string): Promise<md.Entry> {
    const found = this._entries().get(name);
    if (!found) {
      throw new Error(`Entry '${name}' does not exist in the semantic model.`);
    }
    return structuredClone(found.entry);
  }

  // The entry view, computed again only when the model file's text changes.
  private _entries(): Map<string, ViewEntry> {
    const file = this._modelFile();
    if (!file) return new Map();
    if (this._view?.text !== file.text) {
      const entries = documentEntries(file, this._modelScope());
      this._view = {
        text: file.text,
        entries: new Map(entries.map(v => [v.entry.name, v])),
      };
    }
    return this._view.entries;
  }

  // The entry group's one model file, or undefined when it has none. The
  // entry view shows one model; an entry group with more fails.
  private _modelFile(): ModelFile|undefined {
    if (this._index.size > 1) {
      throw new Error(
          `Entry group '${this._entryGroup ?? '*'}' holds ${
              this._index.size} model files (${
              [...this._index.keys()].sort().join(', ')}); kcmd entry ` +
          `commands work on one model per entry group.`);
    }
    return this.modelDocuments()[0];
  }

  private _modelScope(): ModelScope {
    if (!this._scope || !this._entryGroup) {
      throw new Error(
          'SemanticModel layout has no project, location and entry group; ' +
          'cannot name entries.');
    }
    return {
      ...this._scope,
      entryGroup: this._entryGroup,
      v2Aspects: kcV2Aspects(),
    };
  }

  // Saves one entry as saveEntries does, and throws its error when it fails.
  async saveEntry(name: string, entry: md.Entry): Promise<void> {
    const [result] = await this.saveEntries([{...entry, name}]);
    if (!result.ok) throw new Error(result.error);
  }

  // Deletes one entry as deleteEntries does, and throws its error when it
  // fails.
  async deleteEntry(name: string): Promise<void> {
    const [result] = await this.deleteEntries([name]);
    if (!result.ok) throw new Error(result.error);
  }

  // Saves each entry into the model file: a new element's entry is named by
  // the element's own name, and an existing element's by its entry name
  // (semantic/model_edits.ts). The file is written once, in place and
  // atomically, and only when it changes. The first entry of a new model is
  // its anchor, which creates `<model>.yaml`. A model file that does not load
  // fails the whole call.
  async saveEntries(entries: md.Entry[]): Promise<md.EntryResult[]> {
    const file = this._modelFile();
    return this._write(
        file, saveModelEntries(file, entries, this._modelScope()));
  }

  // Deletes each named entry's element from the model file, under the same
  // checks: a delete that leaves the file not loading, or adds a push check
  // error (an entity a relationship or metric still uses, say), fails. The
  // model's anchor cannot be deleted.
  async deleteEntries(names: string[]): Promise<md.EntryResult[]> {
    const file = this._modelFile();
    return this._write(
        file, deleteModelEntries(file, names, this._modelScope()));
  }

  // Writes the model file a save or delete gives, once, in place and
  // atomically, when it changed.
  private async _write(file: ModelFile|undefined, outcome: SaveOutcome):
      Promise<md.EntryResult[]> {
    if (outcome.text !== undefined) {
      const target = file ? this._index.get(file.name)! :
                            this.modelPath(outcome.model!);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      await writeFileAtomic(target, outcome.text);
      if (!file) this._index.set(path.basename(target, '.yaml'), target);
    }
    return outcome.results;
  }
}

// The name push gives a model file or profile file of the model `model`: its
// path relative to the entry group directory, with `/` between segments.
export function fileNameOf(
    layout: SemanticModelLayout, model: string, localPath: string): string {
  return path.relative(path.dirname(layout.modelPath(model)), localPath)
      .split(path.sep)
      .join('/');
}

// Reads the overview sidecar `text`. Throws naming `file` when its frontmatter
// does not parse, holds a key other than contentType and links, gives a
// contentType other than MARKDOWN or HTML, or a link with no url.
export function parseOverviewSidecar(
    text: string, file: string): OverviewSidecar {
  const fail = (problem: string) =>
      new Error(`Overview sidecar '${file}': ${problem}`);
  let split: {metadata?: any; body: string};
  try {
    split = splitFrontmatter(text);
  } catch (err: any) {
    throw fail(`its frontmatter does not parse: ${err?.message ?? err}`);
  }
  const metadata = split.metadata ?? {};
  const extra = typeof metadata === 'object' && !Array.isArray(metadata) ?
      Object.keys(metadata).find(k => k !== 'contentType' && k !== 'links') :
      '';
  if (extra !== undefined) {
    throw fail(
        `its frontmatter holds only contentType and links` +
        (extra ? `, not '${extra}'.` : '.'));
  }
  const {contentType, links} = metadata;
  if (contentType !== undefined && contentType !== 'MARKDOWN' &&
      contentType !== 'HTML') {
    throw fail(`contentType is MARKDOWN or HTML, not '${contentType}'.`);
  }
  const isLink = (l: any) => typeof l?.url === 'string' &&
      ['string', 'undefined'].includes(typeof l.title) &&
      Object.keys(l).every(k => k === 'url' || k === 'title');
  if (links !== undefined && !(Array.isArray(links) && links.every(isLink))) {
    throw fail('links is a list of entries, each a url and an optional title.');
  }
  return {content: split.body.trim() || undefined, contentType, links};
}

// The text of the overview sidecar that holds `overview`.
export function formatOverviewSidecar(
    {content = '', ...rest}: OverviewSidecar): string {
  // The body ends with a newline, which push trims.
  const body = content && !content.endsWith('\n') ? `${content}\n` : content;
  // Content whose first line is `---` would otherwise read back as frontmatter.
  return Object.keys(rest).length || body.split(/\r?\n/, 1)[0] === '---' ?
      joinFrontmatter(rest, body) :
      body;
}

// The `name` a profile file declares at its top level, or undefined when it
// declares none. A file that does not parse throws, naming the file.
function parseProfileName(text: string, file: string): string|undefined {
  let doc: any;
  try {
    doc = yaml.parse(text, YAML_OPTIONS);
  } catch (err: any) {
    throw new Error(
        `Profile file '${file}' does not parse: ${err?.message ?? err}`);
  }
  return typeof doc?.name === 'string' ? doc.name : undefined;
}
