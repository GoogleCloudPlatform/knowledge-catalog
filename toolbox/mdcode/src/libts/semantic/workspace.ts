// Opening a semantic-model workspace: the model as authored, under one binding
// profile, and the store its deployment target names.
//
// Both halves were the CLI's private business until an agent needed them. An
// agent runs the same actions `kcmd action run` runs, against the same store,
// so it has to load the model the same way -- and a second loader that merges
// profiles slightly differently is a demo that passes while the product fails.
// The CLI now calls this too, so there is one answer to "what does this
// workspace say" rather than one per caller.

import * as yaml from 'yaml';

import * as context from '../gcp/context';
import {SpannerDataClient} from '../gcp/spanner';
import {SemanticModelLayout} from '../layouts/semantic-model';
import {CatalogSnapshot} from '../snapshot';
import {Sources} from '../source';
import {SemanticModelSource} from '../sources/semantic-model';

import {googleDeploymentTargets} from './deployment_target';
import {SemanticModel} from './ir';
import {LoadedModel, loadSemanticModels} from './loader';
import {resolveInheritance} from './resolve_inheritance';
import {DEFAULT_PROFILE, mergeProfile} from './resolve_profiles';


/** How to open a workspace. Every field has the answer `kcmd` would give. */
export interface WorkspaceOptions {
  /** Directory holding `catalog.yaml`. Defaults to the current directory. */
  path?: string;
  /**
   * Binding profile to merge onto each model. Defaults to the scope's
   * `default_profile`, and failing that to the model's inline bindings.
   */
  profile?: string;
  ctx?: context.ApiContext;
  /**
   * Where a non-fatal problem goes -- an unbound field, a profile that names
   * something the model does not. Defaults to `console.warn`. A caller with a
   * transcript to keep tidy can collect them instead.
   */
  onWarning?: (text: string) => void;
}


/** An opened workspace: what it holds, and under which profile. */
export interface Workspace {
  /** Every model document in the scope, profile merged and inheritance resolved. */
  models: LoadedModel[];
  /** The profile actually used, after the defaults above were applied. */
  profile: string;
  /** The entry group this scope is scoped to. */
  entryGroup: string;
}


/** The Spanner database a model runs against, and a client on it. */
export interface SpannerStore {
  client: SpannerDataClient;
  project: string;
  instance: string;
  database: string;
}


// Loads every model document in the scope under one binding profile. A lighter
// path than push's: nothing is transpiled, pruned or validated for deployment,
// because running an action needs the model as authored rather than the subset
// a deployed graph can answer. Bindings stay optional so a purely logical model
// opens; a run that needs a source the model does not bind fails in the
// runtime, which names the entity.
export async function openWorkspace(options: WorkspaceOptions = {}):
    Promise<Workspace|{error: string}> {
  const base = options.path ?? '.';
  const ctx = options.ctx ?? context.ApiContext.default();
  const warn = options.onWarning ?? ((text: string) => console.warn(text));

  let snapshot: CatalogSnapshot;
  try {
    snapshot = await CatalogSnapshot.fromPath(base, ctx);
  } catch (err: any) {
    return {error: `${err?.message ?? err}`};
  }
  if (snapshot.manifest.source.type !== Sources.SEMANTIC_MODEL) {
    return {error: `'${base}' is not a semantic-model scope.`};
  }
  const layout = snapshot.layout as SemanticModelLayout;
  const source = snapshot.manifest.source as SemanticModelSource;
  const profile =
      options.profile ?? snapshot.manifest.defaultProfile ?? DEFAULT_PROFILE;

  const docs = layout.modelDocuments();
  if (!docs.length) return {error: 'no semantic model documents found.'};

  const merged: Array<{name: string; text: string}> = [];
  for (const doc of docs) {
    if (profile === DEFAULT_PROFILE) {
      merged.push({name: doc.name, text: doc.text});
      continue;
    }
    const available = layout.profileDocuments(doc.name);
    const chosen = available.find(p => p.name === profile);
    if (!chosen) {
      const names = available.map(p => p.name);
      return {
        error: `unknown binding profile '${profile}' for model '${doc.name}'; ` +
            (names.length ? `defined profiles: ${names.join(', ')}.` :
                            `no profiles are defined for this model.`),
      };
    }
    const res = mergeProfileOntoDoc(doc.text, chosen.text, profile);
    if ('error' in res) return {error: `[${doc.name}] ${res.error}`};
    for (const w of res.warnings) warn(`Warning: [${doc.name}] ${w}`);
    merged.push({name: doc.name, text: res.text});
  }

  const loaded = loadSemanticModels(
      merged,
      {defaultProject: source.project ?? ctx.project, bindingOptional: true});
  if (loaded.error) return {error: loaded.error};
  for (const w of loaded.warnings) warn(`Warning: ${w}`);

  // Inheritance is resolved for the same reason both push legs resolve it: an
  // inherited field is a field, and every reader downstream reads
  // `entity.fields`. The runtime is the reader where skipping it is unsafe
  // rather than merely incomplete. It would not see a subtype's inherited
  // `name`, so resolving a reference by name would report a row missing that
  // is there; and it would not see an inherited key's TYPE, so the check that
  // refuses a generated UUID for an Integer key would read the key as a
  // String, pass, and let the store take the mismatch instead.
  const models = loaded.models.map(m => {
    const resolved = resolveInheritance(m.model);
    for (const w of resolved.warnings) warn(`Warning: ${w}`);
    return {...m, model: resolved.model};
  });
  return {models, profile, entryGroup: source.entryGroup};
}


// Parses a logical model document and a binding profile document, merges the
// profile onto the model by name, and returns the merged authoring text plus
// any merge warnings. Shared by every path that reads a profile -- push,
// `profiles`, and opening a workspace -- so the four parse, merge, warn and
// fail identically; on a parse error or a binding-contract violation it returns
// `error` for the caller to surface.
export function mergeProfileOntoDoc(
    logicalText: string, profileText: string,
    profileName: string): {text: string; warnings: string[]}|{error: string} {
  let logicalDoc: unknown;
  let profileDoc: unknown;
  try {
    logicalDoc = yaml.parse(logicalText);
    profileDoc = yaml.parse(profileText);
  } catch (err: any) {
    return {
      error: `could not parse the model or profile '${profileName}': ${
          err?.message ?? err}`,
    };
  }
  const merged = mergeProfile(logicalDoc, profileDoc, profileName);
  if (merged.error) return {error: merged.error};
  return {text: yaml.stringify(merged.doc), warnings: merged.warnings};
}


// A Spanner table an entity is bound to.
const SPANNER_TABLE_SOURCE =
    /^\/\/spanner\.googleapis\.com\/projects\/([A-Za-z0-9_-]+)\/instances\/([A-Za-z0-9_-]+)\/databases\/([A-Za-z0-9_-]+)\/tables\/.+$/;


// The store an action runs against: the Spanner database this profile's
// deployment target names. No caller names it, so pointing a run at another
// store is selecting another profile.
//
// Checking that the entity bindings agree with the target matters more here
// than in any other leg. An action's statements address a table by its NAME,
// with the project/instance/database qualifier dropped, so an entity bound to
// another database still produces a statement that runs -- against whatever
// table of that name the target database happens to hold. Nothing later would
// report it.
export function spannerStore(
    model: SemanticModel, ctx?: context.ApiContext): SpannerStore|
    {error: string} {
  const {spanner, bigQuery} = googleDeploymentTargets(model);
  if (spanner.length > 1) {
    return {
      error: `Model '${model.name}' declares ${spanner.length} Spanner ` +
          `deployment targets under this profile, so which database the ` +
          `action writes to is ambiguous. Give each its own profile.`,
    };
  }
  if (!spanner.length) {
    return {
      error: `Model '${model.name}' declares no Spanner deployment target ` +
          `under this profile, and an action runs against Spanner` +
          (bigQuery.length ?
               ` (this profile deploys to BigQuery, which it cannot write to)` :
               '') +
          `. Select a profile whose deployment target is a Spanner database.`,
    };
  }

  const target = spanner[0];
  const database = `projects/${target.project}/instances/${
      target.instance}/databases/${target.database}`;
  // Every table the model binds, not just its entities: a many-to-many
  // relationship is backed by a junction table of its own, and an action that
  // creates the edge writes to exactly that one. No loader produces an
  // association yet, so this leg is dormant -- but the day one does, the
  // failure it prevents is a write landing in a different database silently,
  // which is not the kind of thing to notice afterwards.
  const bindings: Array<{name: string; source: string}> = [];
  for (const entity of model.entities ?? []) {
    bindings.push({name: entity.name, source: entity.dataSource ?? ''});
  }
  for (const relationship of model.relationships ?? []) {
    const source = relationship.association?.dataSource;
    if (source) bindings.push({name: relationship.name, source});
  }

  const strays: string[] = [];
  for (const binding of bindings) {
    const source = binding.source.trim();
    // Nothing bound is not a mis-binding: the entity is declared and this
    // profile supplies it no table, which the statements will report on their
    // own terms when they name a table that is not there.
    if (!source) continue;
    const bound = source.match(SPANNER_TABLE_SOURCE);
    // A source that is not a Spanner table at all -- a BigQuery URI, say --
    // is the same hazard and a likelier one: the statements would still run,
    // against whatever table of that name the target database holds, and the
    // data the model describes would sit untouched in the other system.
    if (!bound) {
      strays.push(`'${binding.name}' to ${source}, which is not a table in ` +
                  `this database`);
      continue;
    }
    const boundDatabase =
        `projects/${bound[1]}/instances/${bound[2]}/databases/${bound[3]}`;
    if (boundDatabase !== database) {
      strays.push(`'${binding.name}' to ${boundDatabase}`);
    }
  }
  if (strays.length) {
    return {
      error: `Model '${model.name}' binds ${strays.join(', ')}, but its ` +
          `deployment target is ${database}. An action's statements address a ` +
          `table by name alone, so the write would land in the target ` +
          `database's table of that name rather than in the bound one. Bind ` +
          `both to the same database.`,
    };
  }

  return {
    client: new SpannerDataClient(
        ctx ?? context.ApiContext.default(), target.project, target.instance,
        target.database),
    project: target.project,
    instance: target.instance,
    database: target.database,
  };
}
