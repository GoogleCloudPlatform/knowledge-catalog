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

import {createHash} from 'node:crypto';

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

/** Destination and system-type options for building Knowledge Catalog names. */
export interface NamerOptions {
  project: string;
  location: string;
  entryGroup: string;
  systemTypeProject?: string;
  systemTypeLocation?: string;
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

  constructor(opts: NamerOptions) {
    this.typeProject = opts.systemTypeProject ?? DEFAULT_TYPE_PROJECT;
    this.typeLocation = opts.systemTypeLocation ?? DEFAULT_TYPE_LOCATION;
    this.container = `projects/${opts.project}/locations/${
        opts.location}/entryGroups/${opts.entryGroup}`;
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
   * It is `model.name` verbatim: model names are restricted to letters,
   * digits, underscores and hyphens, all of which entry IDs allow.
   */
  modelId(model: SemanticModel): string {
    return model.name;
  }

  /** Bare entry ID for an entity within a semantic model. */
  entityId(model: SemanticModel, entity: Entity): string {
    return `${model.name}/entities/${entity.name}`;
  }

  /** Bare entry ID for a metric within a semantic model. */
  metricId(model: SemanticModel, metric: Metric): string {
    return `${model.name}/metrics/${metric.name}`;
  }

  /** Bare entry ID for a relationship within a semantic model. */
  relationshipId(model: SemanticModel, rel: Relationship): string {
    return `${model.name}/relationships/${rel.name}`;
  }
}

/**
 * ID of a link push writes: `semantic-<kind>-` and the first 32 hex characters
 * of the SHA-256 of `parts` joined by '/'. It must stay the same across
 * releases, so that push finds the links it wrote.
 */
export function semanticLinkId(
    kind: 'link'|'relationship'|'extends', ...parts: string[]): string {
  const digest =
      createHash('sha256').update(parts.join('/'), 'utf8').digest('hex');
  return `semantic-${kind}-${digest.slice(0, 32)}`;
}

/**
 * Entry-ID prefixes owned by `modelName` across both the first-generation
 * dotted layout and the second-generation slash layout.
 *
 * The dotted prefixes use `slug(modelName)` to match V1 entries, while the
 * slash prefixes use `modelName` verbatim to match V2 entity, metric and
 * relationship entries. Because V2 model names are restricted to letters,
 * digits, underscores and hyphens, all of which `slug()` keeps,
 * `slug(modelName)` and `modelName` are equal for valid V2 models.
 *
 * No push writes under `.entities.`, `.metrics.` or `.files.` any more: an
 * older kcmd wrote its entity and metric entries there, and a copy of each
 * model and profile file. The prefixes stay so the next push deletes those
 * entries.
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
    `${modelName}/relationships/`,
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

// Entry-link IDs follow a stricter grammar than entry IDs:
// `[a-z]([a-z0-9-]{0,61}[a-z0-9])?` (lowercase letters, digits, hyphens,
// starting with a letter, ending with a letter or digit, at most 63 chars).
function linkSlug(s: string): string {
  const cleaned = s.toLowerCase()
                      .replace(/[^a-z0-9-]+/g, '-')
                      .replace(/-+/g, '-')
                      .replace(/^[^a-z]+/, '')
                      .slice(0, 63)
                      .replace(/-+$/, '');
  return cleaned || 'link';
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0').slice(0, 7);
}

/** Entry-link ID prefix of a model's `@bigquery` binding links. */
export function bindingLinkPrefix(modelName: string): string {
  return linkSlug(`${modelName}-bind`);
}

/**
 * Deterministic entry-link ID for an entity's `@bigquery` binding link
 * (`<model>-bind-<kind>-<entity>`, normalized to Dataplex's 63-char link-ID
 * grammar, with a stable hash suffix when truncated).
 */
export function bindingLinkId(
    modelName: string, kind: 'view'|'node', entity: string): string {
  const full = `${bindingLinkPrefix(modelName)}-${kind}-${entity}`;
  const id = linkSlug(full);
  if (id.length < 63) return id;
  return `${id.slice(0, 54).replace(/-+$/, '')}-${fnv(full)}`;
}
