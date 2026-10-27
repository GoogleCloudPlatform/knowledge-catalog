// A semantic model's entries as kcmd's local entry view shows them: the
// entries push would write to Knowledge Catalog for the model file (the
// anchor, entities, metrics, actions and constraints), plus one
// `semantic-relationship` entry per relationship (mapping Addendum 6), each
// named by its bare entry ID.
//

import * as yaml from 'yaml';

import * as dataplex from '../gcp/dataplex';
import type {Entry} from '../gcp/dataplex';
import * as md from '../metadata';
import {DeploymentSpec, SemanticModel} from './ir';
import {ACTION_TYPE_ID, CONSTRAINT_TYPE_ID} from './kc_custom_types';
import {entryIdOf, Namer} from './kc_ids';
import {RELATIONSHIP_TYPE, relationshipEntry} from './kc_relationships';
import {generateCatalogResources} from './knowledge_catalog';
import {GOOGLE_VERSION, loadSemanticModels} from './loader';
import {YAML_OPTIONS} from './yaml_options';

// Where a model's entries go: the scope's project, location and entry group,
// and whether entry IDs and aspects take the second-generation layout.
export interface ModelScope {
  project: string;
  location: string;
  entryGroup: string;
  v2Aspects: boolean;
}

// The element of the model file that an entry of the view stands for.
export type ElementKind =
    'model'|'entity'|'metric'|'relationship'|'action'|'constraint';

export interface ViewEntry {
  entry: md.Entry;
  kind: ElementKind;
  element: string;  // the element's name in the model file
}

// A model file as the layout reads it: its handle and its text.
export interface ModelFile {
  name: string;
  text: string;
}


// The entries of the one model a model file declares. A file that declares no
// entity yet shows its anchor alone (see anchorOnlyModel). A file that does
// not load, or that declares more than one model, throws the reason.
export function documentEntries(file: ModelFile, scope: ModelScope):
    ViewEntry[] {
  return modelEntries(loadModelFile(file, scope.project), scope);
}


// The one model a model file declares, loaded as `kcmd push --no-profile`
// loads it: bindings optional, a bare table name resolved in `project`. An
// anchor-only file gives the model its keys declare. Throws when the file
// does not load or declares more than one model.
export function loadModelFile(file: ModelFile, project: string):
    SemanticModel {
  const anchor = anchorOnlyModel(file.text);
  if (anchor) return anchor;
  const loaded = loadSemanticModels(
      [file], {bindingOptional: true, defaultProject: project});
  if (loaded.error) throw new Error(loaded.error);
  if (loaded.models.length !== 1) {
    throw new Error(
        `Model document '${file.name}' declares ${loaded.models.length} ` +
        `models; kcmd entry commands work on one model per entry group.`);
  }
  return loaded.models[0].model;
}


// The view of `model`. Expressions are included (`emitExpressions`): the
// view is for editing, and a publish still writes only what the live types
// accept.
export function modelEntries(
    model: SemanticModel, scope: ModelScope): ViewEntry[] {
  const names = new Namer(scope);
  const {entries} = generateCatalogResources(model, {
    project: scope.project,
    location: scope.location,
    entryGroup: scope.entryGroup,
    emitExpressions: true,
    v2Aspects: false,
  });
  const relationships = (model.relationships ?? [])
                            .map(rel => relationshipEntry(model, rel, names));
  return [...entries, ...relationships].map(e => {
    const kind = kindOf(e);
    const element = e.entrySource?.displayName ?? '';
    const entry = toViewEntry(e);
    if (scope.v2Aspects) {
      if (kind === 'model') {
        entry.name = names.modelId(model);
      } else if (kind === 'entity') {
        entry.name = names.entityId(model, {name: element} as any);
      } else if (kind === 'metric') {
        entry.name = names.metricId(model, {name: element} as any);
      }
      if (entry.resource.parent) entry.resource.parent = names.modelId(model);
    }
    return {entry, kind, element};
  });
}


// The model an anchor-only document declares: a Google-flavor model file that
// holds one model with no entities, relationships or metrics yet. The loader
// refuses it, since a model needs an entity, but a bootstrap passes through it
// after saving the anchor. Reads the keys an anchor entry shows: name,
// description, ai_context instructions and deployments. Undefined for any
// other document, which the loader then reads.
export function anchorOnlyModel(text: string): SemanticModel|undefined {
  let doc: any;
  try {
    doc = yaml.parse(text, YAML_OPTIONS);
  } catch {
    return undefined;
  }
  const models = doc?.semantic_model;
  if (doc?.version !== GOOGLE_VERSION || !Array.isArray(models) ||
      models.length !== 1) {
    return undefined;
  }
  const m = models[0];
  if (typeof m?.name !== 'string' || !isEmptyList(m.entities ?? m.datasets) ||
      !isEmptyList(m.relationships) || !isEmptyList(m.metrics)) {
    return undefined;
  }
  const model: SemanticModel = {
    name: m.name,
    entities: [],
    relationships: [],
    metrics: [],
    version: GOOGLE_VERSION,
  };
  if (typeof m.description === 'string') model.description = m.description;
  const instructions =
      typeof m.ai_context === 'string' ? m.ai_context : m.ai_context?.instructions;
  if (typeof instructions === 'string' && instructions !== '') {
    model.aiContext = {instructions};
  }
  if (Array.isArray(m.deployments)) {
    model.deployments = m.deployments
                            .filter((d: any) => typeof d?.target === 'string')
                            .map((d: any): DeploymentSpec => ({
                                   name: String(d.name ?? ''),
                                   target: d.target,
                                   ...(typeof d.profile === 'string' ?
                                           {profile: d.profile} :
                                           {}),
                                 }));
  }
  return model;
}


// Absent, null, or an empty list.
function isEmptyList(value: unknown): boolean {
  return value === undefined || value === null ||
      (Array.isArray(value) && value.length === 0);
}


function toViewEntry(entry: Entry): md.Entry {
  const aspects: Record<string, md.Aspect> = {};
  for (const [key, aspect] of Object.entries(entry.aspects ?? {})) {
    aspects[key] = aspect.data ?? {};
  }
  const source = entry.entrySource ?? {};
  const resource: md.Entry['resource'] = {};
  if (source.displayName !== undefined) resource.displayName = source.displayName;
  if (source.description !== undefined) resource.description = source.description;
  if (entry.parentEntry) resource.parent = entryIdOf(entry.parentEntry);
  return {
    name: entryIdOf(entry.name),
    type: dataplex._nameToTypeRef(entry.entryType),
    resource,
    aspects,
  };
}


function kindOf(entry: Entry): ElementKind {
  const type = entry.entryType.split('/').pop() ?? '';
  switch (type) {
    case 'semantic-model':
      return 'model';
    case 'semantic-entity':
      return 'entity';
    case 'semantic-metric':
      return 'metric';
    case RELATIONSHIP_TYPE:
      return 'relationship';
    case ACTION_TYPE_ID:
      return 'action';
    case CONSTRAINT_TYPE_ID:
      return 'constraint';
    default:
      // generateCatalogResources emits file copies only when asked to.
      throw new Error(
          `entry '${entry.name}' has type '${entry.entryType}', which the ` +
          `entry view does not show`);
  }
}
