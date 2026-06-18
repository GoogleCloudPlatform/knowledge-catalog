// Implements a local catalog interface
//

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as gcp from './gcp/context';
import * as crm from './gcp/crm';
import * as dataplex from './gcp/dataplex';
import {CatalogLayout, createLayout, Layouts, rootDirForLayout} from './layout';
import {CatalogManifest} from './manifest';
import * as md from './metadata';
import {ResourceAlias, ResourceType} from './resourcealias';

export class CatalogSnapshot {
  public readonly manifest: CatalogManifest;
  public readonly basePath: string;

  private readonly _entryTypes: Map<string, dataplex.EntryType> = new Map();
  private readonly _aspectTypes: Map<string, dataplex.AspectType> = new Map();

  private readonly _referenceEntryTypes: Map<string, dataplex.EntryType> =
    new Map();
  private readonly _referenceAspectTypes: Map<string, dataplex.AspectType> =
    new Map();

  private readonly _layout: CatalogLayout;

  private constructor(basePath: string, manifest: CatalogManifest) {
    this.basePath = basePath;
    this.manifest = manifest;

    // A manifest `layout:` override (e.g. okf) wins over the source default; the
    // root dir name follows the chosen layout (okf -> bundle/, else catalog/).
    const layout = (manifest.layout as Layouts) ?? manifest.source.layout;
    const catalogPath = path.join(this.basePath, rootDirForLayout(layout));
    this._layout = createLayout(layout, catalogPath, manifest);
  }

  static async fromPath(
    basePath: string,
    ctx: gcp.ApiContext,
    isReference: boolean = false,
    formatOverride?: string,
  ): Promise<CatalogSnapshot> {
    const manifestPath = path.join(basePath, 'catalog.yaml');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Cannot find catalog manifest at '${manifestPath}'`);
    }

    const manifest = await CatalogManifest.load(manifestPath, ctx);
    if (formatOverride) {
      manifest.layout = formatOverride;
    }
    if (isReference && !manifest.referenceManifest) {
      throw new Error(`Cannot find reference config in manifest`);
    }

    const snapshot = new CatalogSnapshot(basePath, manifest);

    await snapshot._buildTypes(manifest, ctx);
    await snapshot._buildReferenceTypes(manifest, ctx);
    await snapshot._layout.init();
    return snapshot;
  }

  get entryTypes(): Map<string, dataplex.EntryType> {
    return this._entryTypes;
  }

  get aspectTypes(): Map<string, dataplex.AspectType> {
    return this._aspectTypes;
  }

  get referenceEntryTypes(): Map<string, dataplex.EntryType> {
    return this._referenceEntryTypes;
  }

  get referenceAspectTypes(): Map<string, dataplex.AspectType> {
    return this._referenceAspectTypes;
  }

  // Retrieves the list of locally (pulled and/or created) managed entries
  async listEntries(): Promise<string[]> {
    return this._layout.listEntries();
  }

  // Optional post-sync finalization (e.g. OKF regenerates index.md listings
  // after a pull). No-op for layouts that don't implement it.
  async finalize(): Promise<void> {
    await this._layout.finalize?.();
  }

  // Retrieves the local copy of the entry using its local name
  async lookupEntry(name: string): Promise<md.Entry> {
    return await this._layout.loadEntry(name);
  }

  isModifiable(name: string): boolean {
    const paths = this._layout.getEntryPaths(name);
    return !!paths?.local;
  }

  // Updates the locally managed entry, referenced by its local name.
  // The list of fields can either be "resource" to update the resource-level metadata
  // (which is relevant in case of non-ingested entries) or an aspect identified by it
  // key (project.location.type).
  async updateEntry(entry: md.Entry, fields: string[]): Promise<void> {
    const existingEntry = await this._layout.loadEntry(entry.name);

    for (const f of fields) {
      if (f == 'resource') {
        if (!existingEntry.resource) {
          existingEntry.resource = {};
        }
        if (!entry.resource) {
          entry.resource = {};
        }
        existingEntry.resource.description = entry.resource.description;
      } else {
        const aspectType = dataplex._typeRefToName(f, 'aspect');
        if (!this._aspectTypes.has(aspectType)) {
          throw new Error(
            `The aspect '${f}' is not registered in the snapshot.`,
          );
        }

        if (this.manifest.source.ingestedEntries) {
          const entryType = this._entryTypes.get(existingEntry.type);
          if (
            !entryType ||
            entryType.requiredAspects?.find((a) => a.type == aspectType)
          ) {
            throw new Error(
              `The aspect '${f}' is not modifiable on the entry.`,
            );
          }
        }

        if (!existingEntry.aspects) {
          existingEntry.aspects = {};
        }
        if (entry.aspects && entry.aspects[f]) {
          existingEntry.aspects[f] = entry.aspects[f];
        } else {
          delete existingEntry.aspects[f];
        }
      }
    }

    await this._layout.saveEntry(entry.name, existingEntry);
  }

  // Creates an entry within the locally catalog snapshot. This capabilitiy is only supported
  // when the associated EntryGroup is user-managed, i.e. not contain ingested metadata.
  async createEntry(name: string, entry: md.Entry): Promise<void> {
    if (this.manifest.source.ingestedEntries) {
      throw new Error(`Entry cannot be created as entries are ingested.`);
    }

    // TODO: Validate aspect and other things

    if (this._layout.entryExists(name)) {
      throw new Error(`Entry '${name}' already exists`);
    }

    await this._layout.saveEntry(name, entry);
  }

  // Deletes an entry within the locally catalog snapshot. This capabilitiy is only supported
  // when the associated EntryGroup is user-managed, i.e. not contain ingested metadata.
  async deleteEntry(name: string): Promise<void> {
    if (this.manifest.source.ingestedEntries) {
      throw new Error(`Entry cannot be deleted as entries are ingested.`);
    }

    await this._layout.deleteEntry(name);
  }

  // Build the map of types supported within the locally managed catalog snapshot
  // Types are stored using two keys: the resource name and the 3-part type name.
  private async _buildTypes(
    manifest: CatalogManifest,
    ctx: gcp.ApiContext,
  ): Promise<void> {
    const catalog = new dataplex.CatalogClient(ctx);

    for (const entryType of manifest.snapshotConfig?.entries || []) {
      const parts = entryType.split('.');
      const res = await catalog.getEntryType(parts[0], parts[1], parts[2]);
      if (!res.result) {
        if (res.status === 403) {
          console.warn(
            `Warning: Permission denied loading type information for entry type ${entryType}. Proceeding...`,
          );
          const placeholderType: dataplex.EntryType = {
            name: `projects/${parts[0]}/locations/${parts[1]}/entryTypes/${parts[2]}`,
            requiredAspects: [],
          };
          this._entryTypes.set(placeholderType.name, placeholderType);
          this._entryTypes.set(entryType, placeholderType);
          continue;
        }
        throw new Error(
          `Unable to load type information for entry type ${entryType}`,
        );
      }

      this._entryTypes.set(res.result.name, res.result);
      this._entryTypes.set(entryType, res.result);

      for (const requiredAspect of res.result.requiredAspects ?? []) {
        if (!this._aspectTypes.has(requiredAspect.type)) {
          const parts = requiredAspect.type.split('/');
          const res = await catalog.getAspectType(parts[1], parts[3], parts[5]);
          if (!res.result) {
            if (res.status === 403) {
              console.warn(
                `Warning: Permission denied loading type information for required aspect type ${requiredAspect.type}. Proceeding...`,
              );
              const placeholderAspect: dataplex.AspectType = {
                name: requiredAspect.type,
              };
              this._aspectTypes.set(placeholderAspect.name, placeholderAspect);
              this._aspectTypes.set(
                `${parts[0]}.${parts[3]}.${parts[5]}`,
                placeholderAspect,
              );
              continue;
            }
            throw new Error(
              `Unable to load type information for aspect type ${requiredAspect.type}`,
            );
          }
          this._aspectTypes.set(res.result.name, res.result);
          this._aspectTypes.set(
            `${parts[0]}.${parts[3]}.${parts[5]}`,
            res.result,
          );
        }
      }
    }

    for (const aspectType of manifest.snapshotConfig?.aspects || []) {
      const aspectTypeResourceName = manifest.aliasMap.lookupAlias(
        aspectType,
        ResourceType.ASPECT,
      );
      if (this._aspectTypes.has(aspectTypeResourceName)) {
        continue;
      }

      const parts = aspectTypeResourceName.split('.');
      const res = await catalog.getAspectType(parts[0], parts[1], parts[2]);
      if (!res.result) {
        if (res.status === 403) {
          const placeholderAspect: dataplex.AspectType = {
            name: `projects/${parts[0]}/locations/${parts[1]}/aspectTypes/${parts[2]}`,
          };
          this._aspectTypes.set(placeholderAspect.name, placeholderAspect);
          this._aspectTypes.set(aspectType, placeholderAspect);
          this._aspectTypes.set(aspectTypeResourceName, placeholderAspect);
          continue;
        }
        throw new Error(
          `Unable to load type information for aspect type ${aspectTypeResourceName}`,
        );
      }
      this._aspectTypes.set(res.result.name, res.result);
      this._aspectTypes.set(aspectTypeResourceName, res.result);
    }
  }

  // Build the map of types supported within the locally managed catalog reference snapshot
  // Types are stored using two keys: the resource name and the 3-part type name.
  private async _buildReferenceTypes(
    manifest: CatalogManifest,
    ctx: gcp.ApiContext,
  ): Promise<void> {
    if (!manifest.referenceManifest) {
      return;
    }

    const catalog = new dataplex.CatalogClient(ctx);

    for (const entryType of manifest.referenceManifest!.snapshotConfig
      ?.entries || []) {
      const parts = entryType.split('.');
      const res = await catalog.getEntryType(parts[0], parts[1], parts[2]);
      if (!res.result) {
        throw new Error(
          `Unable to load type information for reference entry type ${entryType}`,
        );
      }

      this._referenceEntryTypes.set(res.result.name, res.result);
      this._referenceEntryTypes.set(entryType, res.result);

      for (const requiredAspect of res.result.requiredAspects ?? []) {
        if (!this._referenceAspectTypes.has(requiredAspect.type)) {
          const parts = requiredAspect.type.split('/');
          const res = await catalog.getAspectType(parts[1], parts[3], parts[5]);
          if (!res.result) {
            throw new Error(
              `Unable to load type information for reference aspect type ${requiredAspect.type}`,
            );
          }
          this._referenceAspectTypes.set(res.result.name, res.result);
          this._referenceAspectTypes.set(
            `${parts[0]}.${parts[3]}.${parts[5]}`,
            res.result,
          );
        }
      }
    }

    for (const aspectType of manifest.referenceManifest!.snapshotConfig
      ?.aspects || []) {
      const aspectTypeResourceName = manifest.aliasMap.lookupAlias(
        aspectType,
        ResourceType.ASPECT,
      );
      if (this._referenceAspectTypes.has(aspectTypeResourceName)) {
        continue;
      }

      const parts = aspectTypeResourceName.split('.');
      const res = await catalog.getAspectType(parts[0], parts[1], parts[2]);
      if (!res.result) {
        throw new Error(
          `Unable to load type information for reference aspect type ${aspectTypeResourceName}`,
        );
      }
      this._referenceAspectTypes.set(res.result.name, res.result);
      this._referenceAspectTypes.set(aspectTypeResourceName, res.result);
    }
  }

  // Stores a Dataplex resource into the locally managed catalog snapshot. This will internally map
  // The service representation into the local metadata representation.
  // This is only meant to be used within the syncing process (as part of pull operations).
  async _storeResource(
    resource: any,
    isReference: boolean = false,
    entryLinks?: dataplex.EntryLink[],
  ): Promise<void> {
    const source = isReference
      ? this.manifest.referenceManifest!.source
      : this.manifest.source;
    const localName = source.localName(resource, isReference);
    // When storing a reference entry, the internal name within the yaml file
    // should not contain the .ref suffix, to allow merging with the modifiable
    // entry.
    const internalName = isReference
      ? source.localName(resource, false)
      : localName;

    let localResource: md.Entry;
    if (resource.entryType) {
      localResource = await toLocalEntry(
        resource,
        internalName,
        this.manifest.aliasMap,
        entryLinks,
        this.manifest,
      );
    } else if (resource.name.includes('/terms/')) {
      localResource = toLocalGlossaryTerm(resource, internalName);
    } else if (resource.name.includes('/categories/')) {
      localResource = toLocalGlossaryCategory(resource, internalName);
    } else {
      localResource = toLocalGlossary(resource, internalName);
    }

    await this._layout.saveEntry(localName, localResource);
  }

  // Fetches a Dataplex resource from its local metadata representation.
  // This is only meant to be used within the syncing process (as part of push operations).
  async _fetchResource(name: string): Promise<any | undefined> {
    const entry = await this._layout.loadEntry(name);

    if (
      entry.type === 'glossary' ||
      entry.type === 'glossaryTerm' ||
      entry.type === 'glossaryCategory'
    ) {
      const serviceName = this.manifest.source.serviceName(name);
      if (entry.type === 'glossary') {
        return toServiceGlossary(entry, serviceName);
      } else if (entry.type === 'glossaryTerm') {
        return toServiceGlossaryTerm(entry, serviceName);
      } else {
        return toServiceGlossaryCategory(entry, serviceName);
      }
    }

    if (
      this.manifest.publishingConfig?.entries?.length &&
      !this.manifest.publishingConfig.entries.includes(entry.type)
    ) {
      return undefined;
    }

    const serviceName = this.manifest.source.serviceName(name);
    return toServiceEntry(
      entry,
      serviceName,
      this.manifest,
      this._entryTypes,
      this._aspectTypes,
      this.manifest.aliasMap,
    );
  }

  async _fetchEntryLinks(name: string): Promise<dataplex.EntryLink[]> {
    const entry = await this._layout.loadEntry(name);
    const serviceName = this.manifest.source.serviceName(name);
    return await toServiceEntryLinks(entry, serviceName, this.manifest);
  }
}

// Module-level caches for glossary display-name resolution. Keyed by the
// fully-normalized (project ID) resource path so a single pull only fetches
// each glossary / term once, no matter how many entries link to it.
const _glossaryDisplayNameCache = new Map<string, string>();
const _glossaryTermDisplayNameCache = new Map<string, string>();

async function getGlossaryDisplayName(
  catalog: dataplex.CatalogClient,
  project: string,
  location: string,
  glossaryId: string,
): Promise<string> {
  const key = `${project}/${location}/${glossaryId}`;
  const cached = _glossaryDisplayNameCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const res = await catalog.getGlossary(project, location, glossaryId);
  const name = (res.status === 200 && res.result?.displayName) || glossaryId;
  _glossaryDisplayNameCache.set(key, name);
  return name;
}

async function getGlossaryTermDisplayName(
  catalog: dataplex.CatalogClient,
  project: string,
  location: string,
  glossaryId: string,
  termId: string,
): Promise<string> {
  const key = `${project}/${location}/${glossaryId}/${termId}`;
  const cached = _glossaryTermDisplayNameCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const res = await catalog.getGlossaryTerm(
    project,
    location,
    glossaryId,
    termId,
  );
  const name = (res.status === 200 && res.result?.displayName) || termId;
  _glossaryTermDisplayNameCache.set(key, name);
  return name;
}

// Converts a Dataplex entry into the local metadata representation.
async function toLocalEntry(
  entry: dataplex.Entry,
  localName: string,
  aliasMap: ResourceAlias,
  entryLinks?: dataplex.EntryLink[],
  manifest?: CatalogManifest,
): Promise<md.Entry> {
  const aspects: Record<string, md.Aspect> = {};
  if (entry.aspects) {
    for (const key in entry.aspects) {
      const keyAlias = aliasMap.lookupResource(key, ResourceType.ASPECT);
      aspects[keyAlias] = entry.aspects[key].data ?? {};
    }
  }

  const links: Record<string, md.EntryLink[]> = {};
  if (entryLinks) {
    for (const link of entryLinks) {
      const sourceRef =
        link.entryReferences.find(
          (ref) =>
            ref.type === 'SOURCE' ||
            !ref.type ||
            ref.type === 'UNSPECIFIED' ||
            ref.name === entry.name,
        ) || link.entryReferences[0];

      const targetRef =
        link.entryReferences.find(
          (ref) =>
            ref !== sourceRef &&
            (ref.type === 'TARGET' ||
              !ref.type ||
              ref.type === 'UNSPECIFIED' ||
              ref.name !== entry.name),
        ) || link.entryReferences[1];

      if (sourceRef && targetRef) {
        const unwrappedTargetName = dataplex.unwrapProxyEntry(targetRef.name);
        // `_fixEntryLink` only normalizes the OUTER project segment; the inner
        // nested `projects/<num>/...` (e.g. the glossary's host project) stays
        // in Number form. Sources match against Project IDs (their scope is
        // configured by ID), so normalize once more after unwrap or every
        // `tryGetLocalName` call against a glossary target misses and we fall
        // back to the raw API name in the YAML.
        const normalizedTargetName = manifest
          ? await crm.fixProject(unwrappedTargetName, manifest.context)
          : unwrappedTargetName;
        let targetLocalName = normalizedTargetName;
        if (manifest) {
          // Glossary terms get a human-readable target via display-name lookup:
          // `<targetProject>.<targetLocation>.<glossaryDisplayName>.<termDisplayName>`.
          // The full UID path is preserved in `localLink.id` (set below), so
          // push round-trips exactly via `toServiceEntryLinks` (which prefers
          // `link.id` when set). Display names are cached for the duration of
          // the run so each glossary/term is only fetched once.
          const glossaryTermMatch = normalizedTargetName.match(
            /^projects\/([^/]+)\/locations\/([^/]+)\/glossaries\/([^/]+)\/terms\/([^/]+)$/,
          );
          if (glossaryTermMatch) {
            const [, gProject, gLocation, gid, tid] = glossaryTermMatch;
            const catalog = new dataplex.CatalogClient(manifest.context);
            const gDisplay = await getGlossaryDisplayName(
              catalog,
              gProject,
              gLocation,
              gid,
            );
            const tDisplay = await getGlossaryTermDisplayName(
              catalog,
              gProject,
              gLocation,
              gid,
              tid,
            );
            targetLocalName = `${gProject}.${gLocation}.${gDisplay}.${tDisplay}`;
          } else {
            const resolved =
              manifest.source.tryGetLocalName(normalizedTargetName);
            if (resolved) {
              targetLocalName = resolved;
            } else if (manifest.referenceManifest) {
              const refResolved =
                manifest.referenceManifest.source.tryGetLocalName(
                  normalizedTargetName,
                );
              if (refResolved) {
                targetLocalName = refResolved;
              }
            }
          }
        }

        const linkTypeRef = dataplex._nameToTypeRef(link.entryLinkType);
        const linkTypeAlias = aliasMap.lookupResource(
          linkTypeRef,
          ResourceType.ENTRYLINK,
        );

        const localLink: md.EntryLink = {
          target: targetLocalName,
          id: normalizedTargetName,
          aspects: link.aspects
            ? Object.fromEntries(
                Object.entries(link.aspects).map(([k, v]) => [
                  aliasMap.lookupResource(k, ResourceType.ASPECT),
                  v.data ?? {},
                ]),
              )
            : undefined,
        };

        if (sourceRef.path) {
          const pathParts = sourceRef.path.split('.');
          // Path head is case-insensitive: push writes `Schema.<field>` (capital
          // S, required by the Dataplex API), but historical data and other
          // writers may use `schema.<field>`. Accept both.
          if (pathParts[0]?.toLowerCase() === 'schema' && pathParts[1]) {
            const schemaAspect = aspects['schema'];
            if (schemaAspect && Array.isArray(schemaAspect.fields)) {
              const field = schemaAspect.fields.find(
                (f: any) => f.name === pathParts[1],
              );
              if (field) {
                if (!field.links) {
                  field.links = {};
                }
                if (!field.links[linkTypeAlias]) {
                  field.links[linkTypeAlias] = [];
                }
                field.links[linkTypeAlias].push(localLink);
                continue;
              }
            }
          }
        }

        if (!links[linkTypeAlias]) {
          links[linkTypeAlias] = [];
        }
        links[linkTypeAlias].push(localLink);
      }
    }
  }

  const entrySource = entry.entrySource ?? {};

  return {
    name: localName,
    type: dataplex._nameToTypeRef(entry.entryType),
    resource: {
      name: entrySource.resource ?? undefined,
      displayName: entrySource.displayName ?? undefined,
      description: entrySource.description ?? undefined,
      labels: entrySource.labels ?? undefined,
      location: entrySource.location ?? undefined,
      ancestors: entrySource.ancestors ?? undefined,
      createTime: entrySource.createTime ?? undefined,
      updateTime: entrySource.updateTime ?? undefined,
    },
    aspects: aspects ?? undefined,
    links: Object.keys(links).length ? links : undefined,
  };
}

// Converts a Dataplex glossary into the local metadata representation.
function toLocalGlossary(
  glossary: dataplex.Glossary,
  localName: string,
): md.Entry {
  return {
    name: localName,
    type: 'glossary',
    resource: {
      name: glossary.name,
      displayName: glossary.displayName,
      description: glossary.description,
      labels: glossary.labels,
      createTime: glossary.createTime,
      updateTime: glossary.updateTime,
    },
  };
}

// Converts a Dataplex glossary term into the local metadata representation.
function toLocalGlossaryTerm(
  term: dataplex.GlossaryTerm,
  localName: string,
): md.Entry {
  return {
    name: localName,
    type: 'glossaryTerm',
    resource: {
      name: term.name,
      displayName: term.displayName,
      description: term.description,
      labels: term.labels,
      parent: term.parent,
      createTime: term.createTime,
      updateTime: term.updateTime,
    },
  };
}

// Converts a Dataplex glossary category into the local metadata representation.
function toLocalGlossaryCategory(
  category: dataplex.GlossaryCategory,
  localName: string,
): md.Entry {
  return {
    name: localName,
    type: 'glossaryCategory',
    resource: {
      name: category.name,
      displayName: category.displayName,
      description: category.description,
      labels: category.labels,
      parent: category.parent,
      createTime: category.createTime,
      updateTime: category.updateTime,
    },
  };
}

// Converts a local metadata representation into a Dataplex Entry
function toServiceEntry(
  entry: md.Entry,
  serviceName: string,
  manifest: CatalogManifest,
  entryTypes: Map<string, dataplex.EntryType>,
  aspectTypes: Map<string, dataplex.AspectType>,
  aliasMap: ResourceAlias,
): dataplex.Entry {
  const entryType = entryTypes.get(entry.type);
  if (!entryType) {
    throw new Error(`Unknown entry type ${entry.type} in snapshot`);
  }

  const aspects: Record<string, dataplex.Aspect> = {};
  if (entry.aspects) {
    for (const key in entry.aspects) {
      const keyResourceName = aliasMap.lookupAlias(key, ResourceType.ASPECT);
      if (
        manifest.publishingConfig &&
        !manifest.publishingConfig.aspects?.includes(keyResourceName)
      ) {
        continue;
      }

      const aspectType = dataplex._typeRefToName(keyResourceName, 'aspect');
      if (
        manifest.source.ingestedEntries &&
        entryType.requiredAspects?.find(
          (aspectInfo) => aspectInfo.type == aspectType,
        )
      ) {
        continue;
      }

      aspects[keyResourceName] = {aspectType, data: entry.aspects[key]};
    }
  }

  const resource = entry.resource ?? {};
  const entryTypeName = dataplex._typeRefToName(entry.type, 'entry');

  if (
    manifest.source.ingestedEntries ||
    !entry.resource ||
    !Object.keys(entry.resource).length
  ) {
    return {
      name: serviceName,
      entryType: entryTypeName,
      aspects: aspects,
    };
  }

  return {
    name: serviceName,
    entryType: entryTypeName,
    parentEntry: resource.parent,
    entrySource: {
      resource: resource.name,
      ancestors: resource.ancestors,
      displayName: resource.displayName,
      description: resource.description,
      labels: resource.labels,
      location: resource.location,
      createTime: resource.createTime,
      updateTime: resource.updateTime,
    },
    aspects: aspects,
  };
}

// Dataplex distinguishes directed vs undirected entry links: directed types
// (e.g. `definition`) require entryReferences with explicit SOURCE/TARGET
// types, while undirected types (e.g. `related`, `synonym`, `schema-join`)
// require both refs to be UNSPECIFIED. Sending SOURCE/TARGET for an
// undirected type returns 400 INVALID_ARGUMENT
// (ENTRY_LINK_INVALID_REFERENCE_TYPES_ERROR). The set below covers the
// dataplex-types system link types; custom undirected types would need to
// be added here too.
const _UNDIRECTED_LINK_TYPE_IDS = new Set([
  'related',
  'synonym',
  'schema-join',
]);

function _isUndirectedLinkType(entryLinkType: string): boolean {
  // entryLinkType is the full Dataplex resource name:
  //   projects/<P>/locations/<L>/entryLinkTypes/<id>
  // Match on the trailing id segment.
  const id = entryLinkType.split('/').pop() || '';
  return _UNDIRECTED_LINK_TYPE_IDS.has(id);
}

async function toServiceEntryLinks(
  entry: md.Entry,
  serviceName: string,
  manifest: CatalogManifest,
): Promise<dataplex.EntryLink[]> {
  const links: dataplex.EntryLink[] = [];
  const ctx = manifest.context;

  if (entry.links) {
    for (const [linkTypeAlias, entryLinks] of Object.entries(entry.links)) {
      const linkTypeRef = manifest.aliasMap.lookupAlias(
        linkTypeAlias,
        ResourceType.ENTRYLINK,
      );
      if (manifest.publishingConfig) {
        const publishingLinks =
          manifest.publishingConfig.entryLinks?.map((l) =>
            manifest.aliasMap.lookupAlias(l, ResourceType.ENTRYLINK),
          ) ?? [];
        if (!publishingLinks.includes(linkTypeRef)) {
          continue;
        }
      }

      const entryLinkType = dataplex._typeRefToName(linkTypeRef, 'entryLink');
      for (const link of entryLinks) {
        let targetName = link.id ? link.id : link.target;
        if (!targetName.startsWith('projects/')) {
          // Try main source
          try {
            const mainResolved = manifest.source.serviceName(targetName);
            // Heuristic: if it's a glossary term link in a BQ dataset, the BQ source
            // will produce a very long /entries/biglake... string.
            // Glossary terms usually don't have '/entries/' in their FQN.
            if (
              mainResolved.startsWith('projects/') &&
              !mainResolved.includes('/entries/')
            ) {
              targetName = mainResolved;
            } else if (manifest.referenceManifest) {
              targetName =
                manifest.referenceManifest.source.serviceName(targetName);
            } else {
              targetName = mainResolved;
            }
          } catch (e) {
            if (manifest.referenceManifest) {
              try {
                targetName =
                  manifest.referenceManifest.source.serviceName(targetName);
              } catch (e2) {
                // Keep as is
              }
            }
          }
        }

        const undirected = _isUndirectedLinkType(entryLinkType);
        links.push({
          name: '',
          entryLinkType,
          entryReferences: [
            {
              // BQ SOURCE: Outer is Number, Inner (if proxy) is ID.
              // fixProjectToNumber already handles the outer.
              // Main source serviceName produces the inner with ID.
              name: await crm.fixProjectToNumber(serviceName, ctx),
              type: undirected ? 'UNSPECIFIED' : 'SOURCE',
            },
            {
              // Glossary TARGET: Both MUST be Number for proxy entries.
              name: await crm.fixProjectToNumber(
                dataplex.wrapAsProxyEntry(
                  await crm.fixProjectToNumber(targetName, ctx),
                ),
                ctx,
              ),
              type: undirected ? 'UNSPECIFIED' : 'TARGET',
            },
          ],

          aspects: link.aspects
            ? Object.fromEntries(
                Object.entries(link.aspects).map(([k, v]) => {
                  const aspectTypeRef = manifest.aliasMap.lookupAlias(
                    k,
                    ResourceType.ASPECT,
                  );
                  const aspectType = dataplex._typeRefToName(
                    aspectTypeRef,
                    'aspect',
                  );
                  return [aspectTypeRef, {aspectType, data: v}];
                }),
              )
            : undefined,
        });
      }
    }
  }

  const schemaAlias = manifest.aliasMap.lookupResource(
    'dataplex-types.global.schema',
    ResourceType.ASPECT,
  );
  const schemaAspect = entry.aspects?.[schemaAlias];
  if (schemaAspect && Array.isArray(schemaAspect.fields)) {
    for (const field of schemaAspect.fields) {
      if (field.links) {
        for (const [linkTypeAlias, entryLinks] of Object.entries(
          field.links as Record<string, md.EntryLink[]>,
        )) {
          const linkTypeRef = manifest.aliasMap.lookupAlias(
            linkTypeAlias,
            ResourceType.ENTRYLINK,
          );
          if (manifest.publishingConfig) {
            const publishingLinks =
              manifest.publishingConfig.entryLinks?.map((l) =>
                manifest.aliasMap.lookupAlias(l, ResourceType.ENTRYLINK),
              ) ?? [];
            if (!publishingLinks.includes(linkTypeRef)) {
              continue;
            }
          }

          const entryLinkType = dataplex._typeRefToName(
            linkTypeRef,
            'entryLink',
          );
          for (const link of entryLinks) {
            let targetName = link.id ? link.id : link.target;
            if (!targetName.startsWith('projects/')) {
              // Try main source
              try {
                const mainResolved = manifest.source.serviceName(targetName);
                if (
                  mainResolved.startsWith('projects/') &&
                  !mainResolved.includes('/entries/')
                ) {
                  targetName = mainResolved;
                } else if (manifest.referenceManifest) {
                  targetName =
                    manifest.referenceManifest.source.serviceName(targetName);
                } else {
                  targetName = mainResolved;
                }
              } catch (e) {
                if (manifest.referenceManifest) {
                  try {
                    targetName =
                      manifest.referenceManifest.source.serviceName(targetName);
                  } catch (e2) {
                    // Keep as is
                  }
                }
              }
            }

            const undirectedField = _isUndirectedLinkType(entryLinkType);
            links.push({
              name: '',
              entryLinkType,
              entryReferences: [
                {
                  // BQ SOURCE: Outer is Number, Inner (if proxy) is ID.
                  name: await crm.fixProjectToNumber(serviceName, ctx),
                  type: undirectedField ? 'UNSPECIFIED' : 'SOURCE',
                  path: `Schema.${field.name}`,
                },
                {
                  // Glossary TARGET: Both MUST be Number for proxy entries.
                  name: await crm.fixProjectToNumber(
                    dataplex.wrapAsProxyEntry(
                      await crm.fixProjectToNumber(targetName, ctx),
                    ),
                    ctx,
                  ),
                  type: undirectedField ? 'UNSPECIFIED' : 'TARGET',
                },
              ],
              aspects: link.aspects
                ? Object.fromEntries(
                    Object.entries(link.aspects).map(([k, v]) => {
                      const aspectTypeRef = manifest.aliasMap.lookupAlias(
                        k,
                        ResourceType.ASPECT,
                      );
                      const aspectType = dataplex._typeRefToName(
                        aspectTypeRef,
                        'aspect',
                      );
                      return [aspectTypeRef, {aspectType, data: v}];
                    }),
                  )
                : undefined,
            });
          }
        }
      }
    }
  }

  return links;
}

// Converts a local metadata representation into a Dataplex Glossary
function toServiceGlossary(
  entry: md.Entry,
  serviceName: string,
): dataplex.Glossary {
  const resource = entry.resource ?? {};
  return {
    name: resource.name || serviceName,
    displayName: resource.displayName,
    description: resource.description,
    labels: resource.labels,
    createTime: resource.createTime,
    updateTime: resource.updateTime,
  };
}

// Converts a local metadata representation into a Dataplex GlossaryTerm
function toServiceGlossaryTerm(
  entry: md.Entry,
  serviceName: string,
): dataplex.GlossaryTerm {
  const resource = entry.resource ?? {};
  if (!resource.parent) {
    throw new Error(`Glossary term ${entry.name} is missing parent glossary.`);
  }
  return {
    name: resource.name || serviceName,
    displayName: resource.displayName,
    description: resource.description,
    labels: resource.labels,
    parent: resource.parent,
    createTime: resource.createTime,
    updateTime: resource.updateTime,
  };
}

// Converts a local metadata representation into a Dataplex GlossaryCategory
function toServiceGlossaryCategory(
  entry: md.Entry,
  serviceName: string,
): dataplex.GlossaryCategory {
  const resource = entry.resource ?? {};
  if (!resource.parent) {
    throw new Error(
      `Glossary category ${entry.name} is missing parent glossary.`,
    );
  }
  return {
    name: resource.name || serviceName,
    displayName: resource.displayName,
    description: resource.description,
    labels: resource.labels,
    parent: resource.parent,
    createTime: resource.createTime,
    updateTime: resource.updateTime,
  };
}
