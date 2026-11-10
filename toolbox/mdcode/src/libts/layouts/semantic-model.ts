// Implements the SemanticModel layout.
//
// The whole model definition is a single Apache Ossie document per model,
// located at `catalog/EntryGroups/<entryGroupId>/<model>.yaml`, with its
// profile files beside it. Each Knowledge Catalog entry of the model may have
// an overview sidecar at its entry id under the same directory:
// `<model>.overview.md` for the model and, for example,
// `<model>/entities/<entity>.overview.md` for an entity.
//

import * as glob from 'glob';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

import {CatalogLayout} from '../layout';
import * as md from '../metadata';
import {listed, modelDocumentVersion} from '../semantic/loader';
import {nameProblem} from '../semantic/names';
import {PROFILE_FILE_KEYS} from '../semantic/resolve_profiles';
import {YAML_OPTIONS} from '../semantic/yaml_options';

import {joinFrontmatter, splitFrontmatter} from './documents';

// Sidecar suffixes that are NOT model documents.
const SIDECAR_SUFFIXES = ['.aspects.yaml', '.overview.yaml'];

// A binding-profile file sits beside its model as `<model>.profile.<name>.yaml`.
// `<model>.profile.yaml`, with no name, is not a model either.
const PROFILE_FILE = /^(.+)\.profile\.([^.]+)\.yaml$/;
// Any file shaped like a profile file, including a nameless one and one whose
// profile name has a dot, which is never a model either.
const ANY_PROFILE_FILE = /\.profile\.(.*\.)?yaml$/;

// The model and profile a `<model>.profile.<name>.yaml` file name names, or
// undefined when `fileName` is not one.
function profileFileName(fileName: string):
    {model: string; profile: string}|undefined {
  const m = fileName.match(PROFILE_FILE);
  return m ? {model: m[1], profile: m[2]} : undefined;
}

// Each `<model>.profile.<name>.yaml` in `dir`, by profile name.
export function profileFilesBeside(dir: string, model: string):
    {name: string; path: string}[] {
  if (!fs.existsSync(dir)) return [];
  const out: {name: string; path: string}[] = [];
  for (const f of fs.readdirSync(dir)) {
    const named = profileFileName(f);
    if (named?.model === model) {
      out.push({name: named.profile, path: path.join(dir, f)});
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Each `<model>.profile.*.yaml` in `dir`, whatever its profile name: the
// nameless file first, then those whose profile name is empty or has a dot, by
// file name, then the rest by profile name.
export function profileFileNamesBeside(dir: string, model: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const named = profileFilesBeside(dir, model).map(p => path.basename(p.path));
  const nameless = `${model}.profile.yaml`;
  const others = fs.readdirSync(dir).filter(
      f => f.startsWith(`${model}.profile.`) && f.endsWith('.yaml') &&
          f !== nameless && !named.includes(f));
  return [
    ...(fs.existsSync(path.join(dir, nameless)) ? [nameless] : []),
    ...others.sort(),
    ...named,
  ];
}

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


// Push's error for the profile file `file` beside the vanilla model file
// `modelFile`, which keeps its profiles in its GOOGLE block.
export function vanillaSiblingError(file: string, modelFile: string): string {
  return `Profile file '${file}' sits beside '${modelFile}', which is a ` +
      `${VANILLA_VERSION} document; sibling profile files are Google-flavor ` +
      `only, and a ${VANILLA_VERSION} model keeps its profiles in its GOOGLE ` +
      `block.`;
}

// The profile files in the older `<model>.profiles/` directory in `dir`, each
// named by its file basename.
export function legacyProfileFiles(dir: string, model: string):
    {name: string; path: string}[] {
  const legacy = path.join(dir, `${model}.profiles`);
  if (!fs.statSync(legacy, {throwIfNoEntry: false})?.isDirectory()) return [];
  const out: {name: string; path: string}[] = [];
  for (const entry of fs.readdirSync(legacy)) {
    if (!entry.endsWith('.yaml')) continue;
    if (SIDECAR_SUFFIXES.some(s => entry.endsWith(s))) continue;
    out.push(
        {name: path.basename(entry, '.yaml'), path: path.join(legacy, entry)});
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Push's error for the older `<model>.profiles/` directory.
export function legacyProfileDirError(model: string): string {
  return `Legacy profile directory '${model}.profiles/' is no longer ` +
      `supported; rename profile files to '${model}.profile.<name>.yaml' ` +
      `beside '${model}.yaml'.`;
}

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

    // glob returns files in directory order, which differs between
    // filesystems. Sorted, push and `kcmd profiles` visit models in the same
    // order everywhere.
    for (const localPath of matches.sort()) {
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

  // Every local profile file of a model, for pull to find the ones the
  // catalog did not return: each sibling file whose name is a valid profile
  // name, with that name, then each file in the older `<model>.profiles/`
  // directory, which push no longer reads. It applies no flavor check. A
  // sibling file with an invalid profile name is left out; push rejects it,
  // naming it.
  localProfileFiles(model: string): {path: string; profileName?: string}[] {
    return [
      ...this._siblingProfilePaths(model)
          .filter(p => !nameProblem('profile', p.name))
          .map(p => ({path: p.path, profileName: p.name})),
      ...this._legacyProfilePaths(model).map(p => ({path: p.path})),
    ];
  }

  // Every profile file of a model on disk, whatever its profile name: each
  // `<model>.profile.*.yaml` in the entry group, as profileFileNamesBeside
  // lists them, then each file in the older `<model>.profiles/` directory.
  profileFilePaths(model: string): string[] {
    if (!this._entryGroup) return [];
    const dir = this._groupDir();
    return [
      ...profileFileNamesBeside(dir, model).map(f => path.join(dir, f)),
      ...this._legacyProfilePaths(model).map(p => p.path),
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
  //     it must have no sibling profile files;
  //   - the files are named after the model, so the model file must declare
  //     that name, which `pull` uses to name both.
  profileDocuments(model: string):
      {name: string; text: string; path: string}[] {
    const nameless = this._entryGroup ?
        path.join(this._groupDir(), `${model}.profile.yaml`) :
        undefined;
    if (nameless && fs.existsSync(nameless)) {
      throw new Error(profileNameError(path.basename(nameless), '')!);
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
      throw new Error(profileNameError(
          badName, badName.slice(prefix.length, -'.yaml'.length))!);
    }
    const siblings = this._siblingProfilePaths(model);
    if (!siblings.length) return [];
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
    const seen = new Map<string, string>();
    for (const {name, path: p} of siblings) {
      const file = path.basename(p);
      if (!fs.statSync(p).isFile()) {
        throw new Error(`Profile file '${file}' is not a file.`);
      }
      if (version === VANILLA_VERSION) {
        throw new Error(vanillaSiblingError(file, modelFile));
      }
      const text = fs.readFileSync(p, 'utf8');
      checkProfileFileName(modelFile, file, name, text, seen);
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

  // Profile files with no model beside them, for push, `kcmd profiles` and
  // `kcmd skills-generate` to reject: any
  // `<prefix>.profile.<name>.yaml`, or nameless `<prefix>.profile.yaml`, where
  // `<prefix>.yaml` does not exist.
  orphanProfilePaths(): string[] {
    const dir = this._entryGroup ? this._groupDir() : undefined;
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => {
          if (f.startsWith('.') || !ANY_PROFILE_FILE.test(f)) return false;
          const prefix = f.slice(0, f.indexOf('.profile.'));
          return !fs.existsSync(path.join(dir, `${prefix}.yaml`));
        })
        .sort()
        .map(f => path.join(dir, f));
  }

  // The older `<model>.profiles/` directories in the EntryGroup dir that still
  // hold a profile file, which push, `kcmd profiles` and `kcmd skills-generate`
  // reject.
  legacyProfileDirs(): string[] {
    const dir = this._entryGroup ? this._groupDir() : undefined;
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.profiles') &&
                    fs.statSync(path.join(dir, f), {throwIfNoEntry: false})
                        ?.isDirectory() &&
                    this._legacyProfilePaths(f.slice(0, -'.profiles'.length))
                            .length > 0)
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
    return this._entryGroup ? profileFilesBeside(this._groupDir(), model) : [];
  }

  // `<model>.profiles/*.yaml`, each named by its file basename, for pull to
  // find the stale ones (see localProfileFiles). A model name
  // that pull read from the catalog may hold a path separator, and with it a
  // `..` segment, so such a name has no directory here.
  private _legacyProfilePaths(model: string): {name: string; path: string}[] {
    if (!this._entryGroup || /[\\/]/.test(model)) return [];
    return legacyProfileFiles(this._groupDir(), model);
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

// The name push gives a model file, profile file or overview sidecar of the
// model `model`: its path relative to the entry group directory, with `/`
// between segments.
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
    // Some editors save a byte order mark before the first line.
    split = splitFrontmatter(text.replace(/^\uFEFF/, ''));
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

// Whether the overviews `a` and `b` hold the same content, contentType and
// links, as the catalog stores them: empty content and an empty list of links
// are none.
export function sameOverview(a: OverviewSidecar, b: OverviewSidecar): boolean {
  const stored = ({content, contentType, links}: OverviewSidecar) =>
      JSON.stringify({
        content: content || undefined,
        contentType,
        links: links?.length ?
            links.map(({url, title}) => ({url, title})) :
            undefined,
      });
  return stored(a) === stored(b);
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

// The error checkProfileFileName throws for a profile file that breaks one of
// its rules.
export class ProfileFileError extends Error {}

// Throws when the profile file `file`, holding `text` for profile `name` beside
// the model file `modelFile`, names the same profile as a file in `seen`, which
// maps each profile name read before, in lower case, to its file. It also
// throws when the name breaks the naming rule, the file does not parse, uses
// the legacy `semantic_model:` wrapper, takes the name reserved for the inline
// bindings, or declares no name or another name. Adds the file to `seen`.
export function checkProfileFileName(
    modelFile: string, file: string, name: string, text: string,
    seen: Map<string, string>): void {
  const badName = profileNameError(file, name);
  if (badName) throw new ProfileFileError(badName);
  // Profile names are unique ignoring case.
  const twin = seen.get(name.toLowerCase());
  if (twin) {
    throw new ProfileFileError(
        `Profile files '${twin}' and '${file}' name the same profile; ` +
        `profile names are unique ignoring case.`);
  }
  seen.set(name.toLowerCase(), file);
  const declared = parseProfileName(text, file, name);
  const reserved = (n?: string) => n?.toLowerCase() === DEFAULT_PROFILE_NAME;
  if (reserved(name)) {
    throw new ProfileFileError(
        `Profile name '${DEFAULT_PROFILE_NAME}' is reserved for the ` +
        `inline bindings in '${modelFile}'; remove '${file}'.`);
  }
  if (reserved(declared)) {
    throw new ProfileFileError(
        `Profile name '${DEFAULT_PROFILE_NAME}' is reserved for the ` +
        `inline bindings in '${modelFile}'; change the name in '${file}' to ` +
        `'${name}'.`);
  }
  if (declared === undefined) {
    throw new ProfileFileError(
        `Profile file '${file}' declares no name; add 'name: ${name}'.`);
  }
  if (declared !== name) {
    throw new ProfileFileError(
        `Profile file '${file}' declares name '${declared}', which does not ` +
        `match filename suffix '${name}'.`);
  }
}

// Push's error for the profile file `file` whose profile name `name` breaks
// the naming rule, or undefined. A `<model>.profile.yaml` names no profile.
export function profileNameError(file: string, name: string): string|undefined {
  const nameless = file.match(/^(.*)\.profile\.yaml$/);
  if (nameless && name === '') {
    return `Profile file '${file}' names no profile; rename it ` +
        `'${nameless[1]}.profile.<name>.yaml'.`;
  }
  if (nameProblem('profile', name) === undefined) return undefined;
  return `Profile file '${file}' has profile name '${name}'; a profile name ` +
      `is a letter followed by letters, digits, underscores and hyphens.`;
}

// Push's error for the profile file `file`, which does not parse, with the
// parser's `message`.
export function profileParseError(file: string, message: string): string {
  return `Profile file '${file}' does not parse: ${message}`;
}

// The `name` a profile file declares at its top level, or undefined when it
// declares none. A file that does not parse or that uses the legacy
// `semantic_model:` wrapper throws, naming the file.
function parseProfileName(text: string, file: string, name: string):
    string|undefined {
  let doc: any;
  try {
    doc = yaml.parse(text, YAML_OPTIONS);
  } catch (err: any) {
    throw new ProfileFileError(profileParseError(file, err?.message ?? err));
  }
  if (doc?.semantic_model !== undefined) {
    const keys = listed([...PROFILE_FILE_KEYS].filter(k => k !== 'name'));
    throw new ProfileFileError(
        `Profile file '${file}' uses the legacy 'semantic_model:' wrapper, ` +
        `which is no longer supported. Write its ${keys} at the top level, ` +
        `beside 'name: ${name}', and drop any 'version' line. Move any ` +
        `'deployment_target' to the model file as the 'target' of an entry ` +
        `under 'deployments:' with 'name: ${name}' and 'profile: ${name}'.`);
  }
  return typeof doc?.name === 'string' ? doc.name : undefined;
}
