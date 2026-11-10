// How a pull changes a local model or profile file to hold what the catalog
// holds.
//
// Pull rebuilds each model and profile file from the catalog, so the files it
// builds have none of the author's comments and formatting, and give the
// content in one normal form: an `ai_context` in its object form, entities,
// metrics, relationships, actions and constraints sorted by name, and so on
// (see fidelity.md, "What pull recovers"). `catalogForm` gives the model a pull
// would rebuild if the catalog held what the local files say: it runs the
// local files through push's emitter and pull's reader. The text pull builds
// for that model is the local file in pull's normal form. What differs between
// it and the text pull builds from the catalog is what the catalog changed, and
// `updatedText` makes only those changes to the local file.

import {isDeepStrictEqual} from 'node:util';
import * as yaml from 'yaml';

import {SemanticModel} from './ir';
import {modelsFromCatalogResources} from './kc_converter';
import {generateCatalogResources} from './knowledge_catalog';
import {isRecord, loadSemanticModels, SemanticModelError} from './loader';
import {loadProfileFile, plainCopy, ProfileFiles, profileProblems} from './resolve_profiles';
import {withProfileFiles} from './validate';
import {YAML_OPTIONS} from './yaml_options';
import {itemKey, itemKeys, linkNodes, parseForUpdate, updateText} from './yaml_update';

/** The entry group the catalog form is built for. */
export interface CatalogScope {
  project: string;
  location: string;
  entryGroup: string;
}

/**
 * The model a pull would rebuild if the catalog held what the model file `doc`
 * and its profile files say. `profileDocs` gives the profile files. The model
 * and profile files load as push loads them, and their entries are built as
 * push builds them and read back as pull reads them. Returns `error` when a
 * file does not load, push would refuse a profile, or the catalog would hold
 * no model for it.
 *
 * Reading an inherited field's SQL needs the SQL parser, so call
 * `loadSqlEngine()` first.
 */
export function catalogForm(
    doc: {name: string; text: string}, profileDocs: ProfileFiles,
    scope: CatalogScope): {model: SemanticModel}|{error: string} {
  const loaded = loadSemanticModels([doc], {bindingOptional: true});
  if (loaded.error) return {error: loaded.error};
  if (loaded.models.length !== 1) {
    return {error: `'${doc.name}' holds ${loaded.models.length} models`};
  }
  const pushed = withProfileFiles(loaded.models[0], profileDocs);
  if ('errors' in pushed) return {error: pushed.errors[0].error};
  // withProfileFiles leaves out a profile file that does not load, which push
  // reports in a later check (see namedProfileErrors).
  for (const p of profileDocs(doc.name)) {
    try {
      loadProfileFile(p.text, p.name, {skipActions: true});
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
      return {error: err.message};
    }
  }
  // The emitter drops a name the model does not declare, so a profile naming
  // one would read as the catalog's. Push refuses it. Push checks a profile
  // without the model's actions and its own, which are out of scope for the
  // preview (see namedProfileErrors), so this check leaves them out too.
  const logical = {...pushed.model, actions: []};
  for (const profile of logical.profiles ?? []) {
    const [problem] = profileProblems(logical, {...profile, actions: []});
    if (problem) return {error: problem};
  }
  const {entries} = generateCatalogResources(pushed.model, scope);
  const [model] = modelsFromCatalogResources(entries).models;
  return model ? {model} : {error: `'${doc.name}' gives no model`};
}

/**
 * `local`, the text of a local model or profile file, changed by what changes
 * from `base`, the text pull builds for that file, to `pulled`, the text pull
 * builds for it from the catalog. Each part `base` and `pulled` agree on keeps
 * its local text, comments and form, and so does each part they both leave
 * out. Each part that changes is written in pull's form. The local file must
 * parse.
 */
export function updatedText(
    local: string, base: string, pulled: string): string {
  const {document, text} = parseForUpdate(local);
  // A plain copy, so that an alias and its anchor are two values.
  const value = plainCopy(document.toJS());
  const links = linkNodes(value, document.contents);
  const parse = (t: string) => yaml.parse(t, YAML_OPTIONS);
  return updateText(
      text, document, merged(value, parse(base), parse(pulled)), links);
}

// `local` changed by what changes from `base` to `pulled`, three values at the
// same place in the local file, in pull's form of it, and in pull's form of
// the catalog's file. A value the two forms agree on is the local one, as
// written. A value of another shape in the local file is replaced whole.
function merged(local: unknown, base: unknown, pulled: unknown): unknown {
  if (isDeepStrictEqual(base, pulled)) return local;
  if (isRecord(local) && isRecord(base) && isRecord(pulled)) {
    const entries = mergedEntries(
        Object.entries(local), Object.entries(base), Object.entries(pulled),
        false);
    return Object.fromEntries(entries!);
  }
  if (Array.isArray(local) && Array.isArray(base) && Array.isArray(pulled)) {
    // A key two items of one of the lists share matches by value in all three.
    const repeated = new Set([local, base, pulled].flatMap(items => {
      const keys = items.map(v => itemKey(v));
      return keys.filter((k, i) => keys.indexOf(k) !== i);
    }));
    const keyed = (items: unknown[]) => {
      const keys = itemKeys(items, repeated);
      return items.map((v, i) => [keys[i], v] as const);
    };
    const entries =
        mergedEntries(keyed(local), keyed(base), keyed(pulled), true);
    return entries ? entries.map(([, v]) => v) : pulled;
  }
  return pulled;
}

// The entries of `local`, a mapping's or a list's, each changed by what
// changes from `base` to `pulled`. An entry `base` has and `pulled` does not
// goes. An entry the local file does not have and `pulled` changes, such as
// one only `pulled` has, goes after the entry it follows in `pulled`. A local
// entry `base` does not have, such as a `profile: default` pull leaves out,
// stays. The local order stays unless the entries both forms have are in
// another order in `pulled`, as when a list whose order means something
// changes order.
//
// A list's entries must match one to one across the three values. Undefined
// when two items of a list have one key, or when a local item has no
// counterpart in `base` or one there has none in the local list, as when an
// item is written in another form.
function mergedEntries<K>(
    local: ReadonlyArray<readonly [K, unknown]>,
    base: ReadonlyArray<readonly [K, unknown]>,
    pulled: ReadonlyArray<readonly [K, unknown]>,
    isList: boolean): Array<[K, unknown]>|undefined {
  const [l, b, p] = [local, base, pulled].map(e => new Map(e));
  if (isList &&
      (l.size < local.length || b.size < base.length ||
       p.size < pulled.length || l.size !== b.size ||
       local.some(([k]) => !b.has(k)))) {
    return undefined;
  }
  const keysOf = (entries: ReadonlyArray<readonly [K, unknown]>) =>
      entries.map(([k]) => k);
  const shared = (keys: K[]) => keys.filter(k => b.has(k) && p.has(k));
  const sameOrder =
      isDeepStrictEqual(shared(keysOf(base)), shared(keysOf(pulled)));
  // Two forms of a mapping give its keys in one order, so only a list's
  // entries, which match one to one, can come in another order.
  const order =
      sameOrder ? keysOf(local) : keysOf(pulled).filter(k => b.has(k));
  const keys = order.filter(k => !b.has(k) || p.has(k));
  pulled.forEach(([k, v], i) => {
    if (l.has(k) || b.has(k) && isDeepStrictEqual(b.get(k), v)) return;
    const before = pulled.slice(0, i).reverse().find(([j]) => keys.includes(j));
    keys.splice(before ? keys.indexOf(before[0]) + 1 : 0, 0, k);
  });
  return keys.map(k => [
    k,
    !l.has(k)              ? p.get(k) :
        !b.has(k) && !p.has(k) ? l.get(k) :
                                 merged(l.get(k), b.get(k), p.get(k)),
  ]);
}
