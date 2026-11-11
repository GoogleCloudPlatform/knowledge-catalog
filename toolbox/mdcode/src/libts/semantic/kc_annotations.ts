// Extended Knowledge Catalog V2 metadata and BigQuery physical-binding types.
//
// Dataplex's second-generation built-in types (`semantic-model`,
// `semantic-entity`, `semantic-metric`, `semantic-relationship`, `schema`,
// `sql-expressions`, `guidelines`, `overview`, `semantic-extensions`) store
// standard semantic-model constructs natively. Their metadataTemplates are
// closed, while `semantic-extensions` (`projects/dataplex-types/locations/
// global/aspectTypes/semantic-extensions`) is built-in, requires no server-side
// provisioning, is already hydrated by `pull_kc.ts`, and reserves
// `vendorName: 'GOOGLE'` for kcmd (user/vanilla GOOGLE blocks are stripped at
// emit time).
//
// Extended Google-profile IR constructs that have no dedicated slot on the
// closed built-in templates -- model `glossary`, entity `definition`, full
// vocabulary `members`, inline & profile `hydration` / `mode`, explicit
// `Opaque` datatypes, and relationship `abstract` / `extends` / `inverse` /
// `via` / `filter` / `association` -- ride a synthesized `{vendorName:
// 'GOOGLE', data: JSON.stringify(...)}` block inside `semantic-extensions`
// ONLY when present, keeping standard models and all V2 golden fixtures
// untouched.

import type {Aspect} from '../gcp/dataplex';

import {BigQueryGraphTarget, googleDeploymentTargets} from './deployment_target';
import {Entity, EntityBindingMode, EntityDefinition, EntityHydration, Glossary, ProfileSpec, Relationship, RelationshipStep, SemanticModel, VocabularyMember} from './ir';

/** Vendor name reserved inside `semantic-extensions` for kcmd V2 metadata. */
export const GOOGLE_EXTENSION_VENDOR = 'GOOGLE';

/**
 * Physical BigQuery assets an entity is read through: its generated node view
 * (absent under `mode: 'direct'` or when no view is generated) and its
 * property-graph node.
 */
export interface EntityPhysical {
  nodeView?: string;
  graph?: string;
  graphNode?: string;
}

/**
 * Environment coordinates needed to address `@bigquery` catalog entries for
 * `bindingLinks`: dataset locations (`project.dataset` -> lowercase region)
 * and optional numeric project numbers (`projectId` -> `projectNumber`).
 */
export interface BigQueryEntryLocator {
  datasetLocations: ReadonlyMap<string, string>;
  projectNumbers?: ReadonlyMap<string, string>;
}

/** Synthesized `GOOGLE` payload on a `semantic-model` entry. */
export interface ModelGoogleExtension {
  glossary?: Glossary;
}

/** Per-profile entity hydration / mode stored in `EntityGoogleExtension`. */
export interface ProfileHydrationExtension {
  name: string;
  hydration?: EntityHydration|null;
  mode?: EntityBindingMode|null;
}

/** Synthesized `GOOGLE` payload on a `semantic-entity` entry. */
export interface EntityGoogleExtension {
  definition?: EntityDefinition;
  members?: VocabularyMember[];
  hydration?: EntityHydration;
  mode?: EntityBindingMode;
  profiles?: ProfileHydrationExtension[];
}

/** Synthesized `GOOGLE` payload on a `semantic-relationship` entry. */
export interface RelationshipGoogleExtension {
  abstract?: true;
  extends?: string[];
  inverse?: string;
  via?: RelationshipStep[];
  filter?: string;
  association?: Relationship['association'];
}

function compactObj<T extends Record<string, any>>(obj: T): T|undefined {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

/** Builds the `GOOGLE` extension payload for a `semantic-model` entry. */
export function modelGoogleExt(model: SemanticModel):
    ModelGoogleExtension|undefined {
  return compactObj({
    glossary: model.glossary,
  });
}

/** Builds the `GOOGLE` extension payload for a `semantic-entity` entry. */
export function entityGoogleExt(
    entity: Entity, namedProfiles: readonly ProfileSpec[]):
    EntityGoogleExtension|undefined {
  const profileEntries: ProfileHydrationExtension[] = [];
  for (const p of namedProfiles) {
    const b = p.entities.find(x => x.name === entity.name);
    if (!b || (b.hydration === undefined && b.mode === undefined)) continue;
    const entry: ProfileHydrationExtension = {name: p.name};
    if (b.hydration !== undefined) entry.hydration = b.hydration;
    if (b.mode !== undefined) entry.mode = b.mode;
    profileEntries.push(entry);
  }
  return compactObj({
    definition: entity.definition,
    members: entity.members,
    hydration: entity.hydration && Object.keys(entity.hydration).length ?
        entity.hydration :
        undefined,
    mode: entity.mode,
    profiles: profileEntries.length ? profileEntries : undefined,
  });
}

/** Builds the `GOOGLE` extension payload for a `semantic-relationship` entry. */
export function relationshipGoogleExt(rel: Relationship):
    RelationshipGoogleExtension|undefined {
  return compactObj({
    abstract: rel.abstract ? true : undefined,
    extends: rel.extends?.length ? rel.extends : undefined,
    inverse: rel.inverse,
    via: rel.via?.length ? rel.via : undefined,
    filter: rel.filter,
    association: rel.association,
  });
}

/**
 * Parses the synthesized `GOOGLE` JSON payload from an entry's
 * `semantic-extensions` aspect at `path` (`''` for the entry itself,
 * `'Schema.<field>'` for a field), or returns undefined when absent or invalid.
 */
export function readGoogleExt<T extends Record<string, any>>(
    aspects: Record<string, Aspect>|undefined, path = ''): T|undefined {
  for (const [key, aspect] of Object.entries(aspects ?? {})) {
    const [ref, keyPath = ''] = key.split('@');
    if ((aspect.path || keyPath) !== path) continue;
    if (!ref.endsWith('.semantic-extensions') &&
        !aspect.aspectType?.endsWith('/aspectTypes/semantic-extensions')) {
      continue;
    }
    const list = Array.isArray(aspect.data?.customExtensions) ?
        aspect.data.customExtensions :
        [];
    const found = list.find(
        (x: any) => x?.vendorName === GOOGLE_EXTENSION_VENDOR &&
            typeof x?.data === 'string');
    if (!found) return undefined;
    try {
      const parsed = JSON.parse(found.data);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ?
          (parsed as T) :
          undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const BQ_TARGET_RE = new RegExp(
    '^(?://)?bigquery\\.googleapis\\.com/projects/([A-Za-z0-9_-]+)/' +
    'datasets/([A-Za-z0-9_-]+)/propertyGraphs/([A-Za-z0-9_-]+)$');

/**
 * Resolves the model's first BigQuery property-graph target from
 * `model.deployments` (with fallback to `//`-prefixed or legacy
 * `GOOGLE` `deploymentTargets` on in-memory IR models).
 */
export function firstBigQueryTarget(model: SemanticModel):
    BigQueryGraphTarget|undefined {
  try {
    const t = googleDeploymentTargets(model).bigQuery[0];
    if (t) return t;
  } catch {
    // Fall through to lenient parse for in-memory IR.
  }
  const candidates: string[] =
      (model.deployments ?? []).map(d => d.target);
  for (const ext of model.customExtensions ?? []) {
    if (ext.vendorName !== 'GOOGLE') continue;
    try {
      const data = JSON.parse(ext.data);
      if (Array.isArray(data?.deploymentTargets)) {
        candidates.push(...data.deploymentTargets.filter(
            (u: unknown): u is string => typeof u === 'string'));
      }
      if (Array.isArray(data?.deployments)) {
        for (const d of data.deployments) {
          if (typeof d?.target === 'string') candidates.push(d.target);
        }
      }
    } catch {
      // Malformed JSON: validation reports it.
    }
  }
  for (const uri of candidates) {
    const m = uri.trim().match(BQ_TARGET_RE);
    if (m) {
      return {project: m[1], dataset: m[2], graphName: m[3], uri};
    }
  }
  return undefined;
}
