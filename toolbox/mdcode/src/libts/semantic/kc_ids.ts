// Knowledge Catalog resource naming and ID helpers.
//
// Provides a shared set of rules for constructing and parsing Knowledge Catalog
// resource names across the emitter, model validation, the catalog reader, and
// the deployment pipeline. This module imports only the IR to avoid circular
// dependencies.
//
// Terminology used in this module:
// - A "full resource name" includes the GCP container path, e.g.
//   `projects/<p>/locations/<l>/entryGroups/<eg>/entries/<entryId>`.
// - A "bare entry ID" (or "entry-link ID") is the trailing `<entryId>`
//   (or `<linkId>`) segment without the container prefix, e.g.
//   `retail_sales.entities.store_orders` (V1) or
//   `retail_sales/entities/store_orders` (V2).

import {Entity, Metric, Relationship, SemanticModel} from './ir';

// Where the `semantic-*` and `schema` system types live: built-in types in
// project `dataplex-types`, location `global`. Callers may override to
// reference them from a staging project.
export const DEFAULT_TYPE_PROJECT = 'dataplex-types';
export const DEFAULT_TYPE_LOCATION = 'global';

// Matches the container path and trailing bare ID of any Knowledge Catalog
// resource name:
// - Entry-group paths (`ENTRY_GROUP_PATH_RE`):
//   `projects/<p>/locations/<l>/entryGroups/<eg>/(entries|entryLinks)/<id>`
// - Type paths (`TYPE_PATH_RE`):
//   `projects/<p>/locations/<l>/(entryTypes|aspectTypes|entryLinkTypes)/<id>`
const ENTRY_GROUP_PATH_RE = /entryGroups\/[^/]+\/(?:entries|entryLinks)/;
const TYPE_PATH_RE = /entryTypes|aspectTypes|entryLinkTypes/;
const RESOURCE_ID_RE = new RegExp(
    `^projects/[^/]+/locations/[^/]+/` +
    `(?:${ENTRY_GROUP_PATH_RE.source}|${TYPE_PATH_RE.source})/(.+)$`);

/** Destination and layout options for constructing Knowledge Catalog names. */
export interface NamerOptions {
  project: string;
  location: string;
  entryGroup: string;
  systemTypeProject?: string;
  systemTypeLocation?: string;
  v2Aspects?: boolean;
}

/**
 * Builds the fully-qualified resource names and bare entry/link IDs for a
 * destination. Kept in one place so entry/type name construction is consistent
 * and the emitter body reads as pure mapping.
 */
export class Namer {
  private readonly typeProject: string;
  private readonly typeLocation: string;
  private readonly container: string;
  private readonly v2Aspects: boolean;

  constructor(opts: NamerOptions) {
    this.typeProject = opts.systemTypeProject ?? DEFAULT_TYPE_PROJECT;
    this.typeLocation = opts.systemTypeLocation ?? DEFAULT_TYPE_LOCATION;
    this.container = `projects/${opts.project}/locations/${
        opts.location}/entryGroups/${opts.entryGroup}`;
    this.v2Aspects = opts.v2Aspects ?? false;
  }

  /** Full resource name of a system type. `kind` selects the collection. */
  typeName(kind: 'entry'|'aspect'|'entryLink', name: string): string {
    return `projects/${this.typeProject}/locations/${
        this.typeLocation}/${kind}Types/${name}`;
  }

  /**
   * Aspect-map key: the `project.location.type` reference form the client keys
   * an entry's aspects by (see dataplex._nameToTypeRef / _fixEntry).
   */
  aspectRef(name: string): string {
    return `${this.typeProject}.${this.typeLocation}.${name}`;
  }

  /** Full resource name of an entry in the destination entry group. */
  entry(entryId: string): string {
    return `${this.container}/entries/${entryId}`;
  }

  /** Full resource name of an entry link in the destination entry group. */
  entryLink(linkId: string): string {
    return `${this.container}/entryLinks/${linkId}`;
  }

  /**
   * Bare entry ID for a semantic model, used as the `semantic-model` anchor
   * entry's ID and as the prefix for action and constraint entry IDs.
   *
   * V1 sanitizes `model.name` with `slug()` because `model.name` may contain
   * characters (e.g. spaces) that Knowledge Catalog disallows in entry IDs.
   * V2 returns `model.name` verbatim because V2 model names are restricted to
   * letters, digits, and underscores. This means `slug(model.name)` and
   * `model.name` are equal for valid V2 models.
   */
  modelId(model: SemanticModel): string {
    return this.v2Aspects ? model.name : slug(model.name);
  }

  /** Bare entry ID for an entity within a semantic model. */
  entityId(model: SemanticModel, entity: Entity): string {
    return this.v2Aspects ?
        `${model.name}/entities/${entity.name}` :
        `${slug(model.name)}.entities.${slug(entity.name)}`;
  }

  /** Bare entry ID for a metric within a semantic model. */
  metricId(model: SemanticModel, metric: Metric): string {
    return this.v2Aspects ?
        `${model.name}/metrics/${metric.name}` :
        `${slug(model.name)}.metrics.${slug(metric.name)}`;
  }

  /**
   * Entry link IDs are more restricted than entry IDs: lowercase letters,
   * numbers and hyphens only, starting with a letter (see `linkSlug`). Does not
   * branch on `v2Aspects`.
   */
  linkId(model: SemanticModel, rel: Relationship): string {
    return relationshipLinkId(model.name, rel.name);
  }

  /**
   * Bare entry ID for a verbatim model/profile file copy (used while
   * `KC_V2_ASPECTS` is off). Dotted under both layouts.
   */
  fileEntryId(modelName: string, fileName: string): string {
    return `${slug(modelName)}.files.${slug(fileName)}`;
  }
}

/** Entry-link ID for a relationship on a model. */
export function relationshipLinkId(modelName: string, relName: string): string {
  return linkSlug(`${modelName}-${relName}`);
}

/**
 * Entry-ID prefixes owned by `modelName` across both the first-generation
 * dotted layout and the second-generation slash layout.
 *
 * The dotted prefixes use `slug(modelName)` to match V1 entries, while the
 * slash prefixes use `modelName` verbatim to match V2 entity and metric
 * entries. Because V2 model names are restricted to letters, digits, and
 * underscores, `slug(modelName)` and `modelName` are equal for valid V2 models.
 */
export function ownedEntryIdPrefixes(modelName: string): string[] {
  const s = slug(modelName);
  return [
    `${s}.entities.`,
    `${s}.metrics.`,
    `${s}.actions.`,
    `${s}.constraints.`,
    `${s}.files.`,
    `${modelName}/entities/`,
    `${modelName}/metrics/`,
  ];
}

/**
 * Extracts the bare resource ID from a full Knowledge Catalog resource name
 * (entry, entry link, or type), or returns `resourceName` unchanged if it does
 * not match a known resource container.
 *
 * Matches known container collections via `RESOURCE_ID_RE` and leaves
 * non-matching strings untouched, rather than falling back to
 * `.split('/').pop()` (which would corrupt an already-bare V2 slash entry ID
 * like `'retail_sales/entities/store_orders'` into `'store_orders'`).
 */
export function entryIdOf(resourceName: string): string {
  const m = resourceName.match(RESOURCE_ID_RE);
  return m ? m[1] : resourceName;
}

/**
 * Entry IDs allow letters, numbers, underscores, hyphens, and periods; maps
 * anything else to an underscore.
 */
export function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/**
 * Entry link IDs allow only lowercase letters, numbers and hyphens, must start
 * with a letter, must end with a letter or number, and are capped at 63 chars.
 */
export function linkSlug(s: string): string {
  const out = s.toLowerCase()
                  .replace(/[^a-z0-9-]+/g, '-')
                  .replace(/-+/g, '-')
                  .replace(/^[^a-z]+/, '')
                  .replace(/^-+|-+$/g, '')
                  .slice(0, 63)
                  .replace(/-+$/, '');
  return out || 'link';
}
