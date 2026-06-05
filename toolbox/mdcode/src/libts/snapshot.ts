// Implements a local catalog interface
//

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as gcp from './gcp/context';
import * as dataplex from './gcp/dataplex';
import * as md from './metadata';
import { CatalogManifest } from './manifest';
import { CatalogLayout, createLayout } from './layout';


export class CatalogSnapshot {

  public readonly manifest: CatalogManifest;
  public readonly basePath: string;

  private readonly _entryTypes: Map<string, dataplex.EntryType> = new Map();
  private readonly _aspectTypes: Map<string, dataplex.AspectType> = new Map();

  private readonly _layout: CatalogLayout;

  private constructor(basePath: string, manifest: CatalogManifest) {
    this.basePath = basePath;
    this.manifest = manifest;

    const catalogPath = path.join(this.basePath, 'catalog');
    this._layout = createLayout(manifest.source.layout, catalogPath);
  }

  static async fromPath(basePath: string, ctx: gcp.ApiContext): Promise<CatalogSnapshot> {
    const manifestPath = path.join(basePath, 'catalog.yaml');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Cannot find catalog manifest at '${manifestPath}'`);
    }

    const manifest = await CatalogManifest.load(manifestPath, ctx);
    const snapshot = new CatalogSnapshot(basePath, manifest);

    await snapshot._buildTypes(manifest, ctx);
    await snapshot._layout.init();
    return snapshot;
  }

  get entryTypes(): Map<string, dataplex.EntryType> {
    return this._entryTypes;
  }

  get aspectTypes(): Map<string, dataplex.AspectType> {
    return this._aspectTypes;
  }

  // Retrieves the list of locally (pulled and/or created) managed entries
  async listEntries(): Promise<string[]> {
    return this._layout.listEntries();
  }

  // Retrieves the local copy of the entry using its local name
  async lookupEntry(name: string): Promise<md.Entry> {
    return await this._layout.loadEntry(name);
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
      }
      else {
        const aspectType = dataplex._typeRefToName(f, 'aspect');
        if (!this._aspectTypes.has(aspectType)) {
          throw new Error(`The aspect '${f}' is not registered in the snapshot.`);
        }

        if (this.manifest.source.ingestedEntries) {
          const entryType = this._entryTypes.get(existingEntry.type);
          if (!entryType || entryType.requiredAspects?.find((a) => a.type == aspectType)) {
            throw new Error(`The aspect '${f}' is not modifiable on the entry.`);
          }
        }

        if (!existingEntry.aspects) {
          existingEntry.aspects = {};
        }
        if (entry.aspects && entry.aspects[f]) {
          existingEntry.aspects[f] = entry.aspects[f];
        }
        else {
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
  private async _buildTypes(manifest: CatalogManifest, ctx: gcp.ApiContext): Promise<void> {
    const catalog = new dataplex.CatalogClient(ctx);

    for (const entryType of manifest.snapshotConfig?.entries || []) {
      const parts = entryType.split('.');
      const res = await catalog.getEntryType(parts[0], parts[1], parts[2]);
      if (!res.result) {
        throw new Error(`Unable to load type information for entry type ${entryType}`);
      }

      this._entryTypes.set(res.result.name, res.result);
      this._entryTypes.set(entryType, res.result);

      for (const requiredAspect of res.result.requiredAspects ?? []) {
        if (!this._aspectTypes.has(requiredAspect.type)) {
          const parts = requiredAspect.type.split('/');
          const res = await catalog.getAspectType(parts[1], parts[3], parts[5]);
          if (!res.result) {
            throw new Error(`Unable to load type information for aspect type ${requiredAspect.type}`);
          }
          this._aspectTypes.set(res.result.name, res.result);
          this._aspectTypes.set(`${parts[0]}.${parts[3]}.${parts[5]}`, res.result);
        }
      }
    }

    for (const aspectType of manifest.snapshotConfig?.aspects || []) {
      if (this._aspectTypes.has(aspectType)) {
        continue;
      }

      const parts = aspectType.split('.');
      const res = await catalog.getAspectType(parts[0], parts[1], parts[2]);
      if (!res.result) {
        throw new Error(`Unable to load type information for aspect type ${aspectType}`);
      }
      this._aspectTypes.set(res.result.name, res.result);
      this._aspectTypes.set(aspectType, res.result);
    }
  }

  // Stores a Dataplex entry into the locally managed catalog snapshot. This will internally map
  // The service representation into the local metadata representation.
  // This is only meant to be used within the syncing process (as part of pull operations).
  async _storeEntry(entry: dataplex.Entry): Promise<void> {
    const localName = this.manifest.source.localName(entry);
    await this._layout.saveEntry(localName, toLocalEntry(entry, localName));
  }

  // Fetches a Dataplex entry from its local metadata representation.
  // This is only meant to be used within the syncing process (as part of push operations).
  async _fetchEntry(name: string): Promise<dataplex.Entry | undefined> {
    const entry = await this._layout.loadEntry(name);

    if (this.manifest.publishingConfig?.entries?.length &&
        !this.manifest.publishingConfig.entries.includes(entry.type)) {
      return undefined;
    }

    const serviceName = this.manifest.source.serviceName(name);
    if (entry.resource?.parent && !entry.resource.parent.startsWith('projects/')) {
      entry.resource.parent = this.manifest.source.serviceName(entry.resource.parent);
    }
    return toServiceEntry(
      entry,
      serviceName,
      this.manifest,
      this._entryTypes,
      this._aspectTypes
    );
  }
}

// Converts a Dataplex entry into the local metadata representation.
function toLocalEntry(entry: dataplex.Entry, localName: string): md.Entry {
  const aspects: Record<string, md.Aspect> = {};
  if (entry.aspects) {
    for (const key in entry.aspects) {
      aspects[key] = entry.aspects[key].data ?? {};
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
        updateTime: entrySource.updateTime ?? undefined
      },
      aspects: aspects ?? undefined
  };
}


// Converts a local metadata representation into a Dataplex Entry
function toServiceEntry(entry: md.Entry,
                        serviceName: string,
                        manifest: CatalogManifest,
                        entryTypes: Map<string, dataplex.EntryType>,
                        aspectTypes: Map<string, dataplex.AspectType>): dataplex.Entry {
  const entryType = entryTypes.get(entry.type);
  if (!entryType) {
    throw new Error(`Unknown entry type ${entry.type} in snapshot`);
  }

  const aspects: Record<string, dataplex.Aspect> = {};
  if (entry.aspects) {
    for (const key in entry.aspects) {
      if (manifest.publishingConfig && !manifest.publishingConfig.aspects?.includes(key)) {
        continue;
      }

      const aspectType = dataplex._typeRefToName(key, 'aspect');
      if (manifest.source.ingestedEntries &&
          entryType.requiredAspects?.find((aspectInfo) => aspectInfo.type == aspectType)) {
        continue;
      }

      aspects[key] = { aspectType, data: entry.aspects[key] };
    }
  }

  const resource = entry.resource ?? {};
  const entryTypeName = dataplex._typeRefToName(entry.type, 'entry');

  if (manifest.source.ingestedEntries ||
      !entry.resource || !Object.keys(entry.resource).length) {
    return {
      name: serviceName,
      entryType: entryTypeName,
      aspects: aspects
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
      updateTime: resource.updateTime
    },
    aspects: aspects
  };
}
