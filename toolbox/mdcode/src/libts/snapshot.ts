// Implements a local catalog interface
//

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as gcp from './gcp/context';
import * as dataplex from './gcp/dataplex';
import * as md from './metadata';
import { CatalogManifest } from './manifest';
import { CatalogLayout, createLayout, Layouts } from './layout';
import { BUNDLE_DIR, OkfLayout } from './layouts/okf';
import { entryGroupCoordinates } from './source';

export interface SnapshotOptions {
  layout?: Layouts;
}


export class CatalogSnapshot {

  public readonly manifest: CatalogManifest;
  public readonly basePath: string;

  private readonly _entryTypes: Map<string, dataplex.EntryType> = new Map();
  private readonly _aspectTypes: Map<string, dataplex.AspectType> = new Map();

  private readonly _layout: CatalogLayout;
  private readonly _catalog: dataplex.CatalogClient;

  private constructor(basePath: string, manifest: CatalogManifest,
                      ctx: gcp.ApiContext, options: SnapshotOptions = {}) {
    this.basePath = basePath;
    this.manifest = manifest;
    this._catalog = new dataplex.CatalogClient(ctx);

    const effectiveLayout = options.layout ??
        (manifest.layout === 'okf' ? Layouts.OKF : manifest.source.layout);
    if (effectiveLayout === Layouts.OKF) {
      const coords = entryGroupCoordinates(manifest.source);
      const bundlePath = path.join(this.basePath, BUNDLE_DIR);
      this._layout = createLayout(Layouts.OKF, bundlePath, coords.container);
    } else {
      const catalogPath = path.join(this.basePath, 'catalog');
      this._layout = createLayout(
        effectiveLayout, catalogPath, manifest.source.entryGroup);
    }
  }

  static async fromManifest(basePath: string, manifest: CatalogManifest,
                            ctx: gcp.ApiContext,
                            options: SnapshotOptions = {}): Promise<CatalogSnapshot> {
    const snapshot = new CatalogSnapshot(basePath, manifest, ctx, options);
    if (!(snapshot._layout instanceof OkfLayout)) {
      await snapshot._buildTypes(manifest);
    }
    await snapshot._layout.init();
    return snapshot;
  }

  static async fromPath(basePath: string, ctx: gcp.ApiContext,
                        options: SnapshotOptions = {}): Promise<CatalogSnapshot> {
    const manifestPath = path.join(basePath, 'catalog.yaml');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Cannot find catalog manifest at '${manifestPath}'`);
    }

    const manifest = await CatalogManifest.load(manifestPath, ctx);
    return await CatalogSnapshot.fromManifest(basePath, manifest, ctx, options);
  }

  get entryTypes(): Map<string, dataplex.EntryType> {
    return this._entryTypes;
  }

  get aspectTypes(): Map<string, dataplex.AspectType> {
    return this._aspectTypes;
  }

  get layout(): CatalogLayout {
    return this._layout;
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
        await this._loadEntryType(existingEntry.type);
        const aspectType = dataplex._typeRefToName(aspectTypeRefOf(f), 'aspect');
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

  // Loads the entry and aspect types listed under snapshot in catalog.yaml.
  // Types are stored using two keys: the resource name and the 3-part type name.
  private async _buildTypes(manifest: CatalogManifest): Promise<void> {
    for (const entryType of manifest.snapshotConfig?.entries || []) {
      await this._loadEntryType(entryType);
    }

    for (const aspectType of manifest.snapshotConfig?.aspects || []) {
      if (this._aspectTypes.has(aspectType)) {
        continue;
      }

      const parts = aspectType.split('.');
      const res = await this._catalog.getAspectType(parts[0], parts[1], parts[2]);
      let type = res.result;
      // Dataplex refuses the definition of some types whose aspects callers can
      // still read and write. A refused type is registered by its name.
      if (res.status == 403) {
        type = { name: dataplex._typeRefToName(aspectType, 'aspect') };
        console.warn(`Warning: Permission denied reading the definition of aspect type ${aspectType}. ` +
                     `Its aspects are still pulled and pushed. If none are pulled, check the type name.`);
      }
      if (!type) {
        throw new Error(`Unable to load type information for aspect type ${aspectType}`);
      }
      this._aspectTypes.set(type.name, type);
      this._aspectTypes.set(aspectType, type);
    }
  }

  // Loads an entry type, given as project.location.type, and the aspect types
  // it requires. Does nothing when entryType is empty or already loaded.
  async _loadEntryType(entryType: string): Promise<void> {
    if (!entryType || this._entryTypes.has(entryType)) {
      return;
    }
    const parts = entryType.split('.');
    const res = await this._catalog.getEntryType(parts[0], parts[1], parts[2]);
    if (!res.result) {
      throw new Error(`Unable to load type information for entry type ${entryType}`);
    }

    this._entryTypes.set(res.result.name, res.result);
    this._entryTypes.set(entryType, res.result);

    for (const requiredAspect of res.result.requiredAspects ?? []) {
      if (!this._aspectTypes.has(requiredAspect.type)) {
        const parts = requiredAspect.type.split('/');
        const res = await this._catalog.getAspectType(parts[1], parts[3], parts[5]);
        if (!res.result) {
          throw new Error(`Unable to load type information for aspect type ${requiredAspect.type}`);
        }
        this._aspectTypes.set(res.result.name, res.result);
        this._aspectTypes.set(`${parts[1]}.${parts[3]}.${parts[5]}`, res.result);
      }
    }
  }

  // Stores a Dataplex entry into the locally managed catalog snapshot. This will internally map
  // The service representation into the local metadata representation.
  // This is only meant to be used within the syncing process (as part of pull operations).
  async _storeEntry(entry: dataplex.Entry): Promise<void> {
    const localName = this.manifest.source.localName(entry);
    const local = toLocalEntry(entry, localName);

    // Preserve the parent so a pull after a push round-trips it, mirroring the
    // inverse conversion _fetchEntry applies on push: store the parent as a
    // local name (Dataplex requires parentEntry to be in the same entry group,
    // so localName always resolves), not the service name. Ingested entries
    // never carry a parentEntry back to the service (toServiceEntry drops it),
    // so recording one would be misleading -- skip them.
    if (entry.parentEntry &&
        (this._layout instanceof OkfLayout || !this.manifest.source.ingestedEntries)) {
      local.resource.parent =
        this.manifest.source.localName({ ...entry, name: entry.parentEntry });
    }

    await this._layout.saveEntry(localName, local);
  }

  // Reports what _storeEntry would do with a Dataplex entry, without writing:
  // the local name it maps to and whether a local copy already exists. Used by
  // `pull --dry-run`.
  _previewStoreEntry(entry: dataplex.Entry): { localName: string; exists: boolean } {
    const localName = this.manifest.source.localName(entry);
    return { localName, exists: this._layout.entryExists(localName) };
  }

  // Fetches a Dataplex entry from its local metadata representation.
  // This is only meant to be used within the syncing process (as part of push operations).
  async _fetchEntry(name: string): Promise<dataplex.Entry | undefined> {
    const entry = await this._layout.loadEntry(name);

    if (this.manifest.publishingConfig?.entries?.length &&
        !this.manifest.publishingConfig.entries.includes(entry.type)) {
      return undefined;
    }

    if (this._layout instanceof OkfLayout) {
      if (!this._entryTypes.has(entry.type)) {
        const typeName = dataplex._typeRefToName(entry.type, 'entry');
        const stub: dataplex.EntryType = { name: typeName, requiredAspects: [] };
        this._entryTypes.set(typeName, stub);
        this._entryTypes.set(entry.type, stub);
      }
    } else {
      await this._loadEntryType(entry.type);
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
      this._layout instanceof OkfLayout
    );
  }
}

// Converts a Dataplex entry into the local metadata representation.
export function toLocalEntry(entry: dataplex.Entry, localName: string): md.Entry {
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
        system: entrySource.system ?? undefined,
        platform: entrySource.platform ?? undefined,
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
export function toServiceEntry(entry: md.Entry,
                               serviceName: string,
                               manifest: CatalogManifest,
                               entryTypes: Map<string, dataplex.EntryType>,
                               isOkf = false): dataplex.Entry {
  const entryType = entryTypes.get(entry.type);
  if (!entryType) {
    throw new Error(`Unknown entry type ${entry.type} in snapshot`);
  }

  const aspects: Record<string, dataplex.Aspect> = {};
  if (entry.aspects) {
    for (const key in entry.aspects) {
      if (manifest.publishingConfig &&
          !manifest.publishingConfig.aspects?.includes(aspectTypeRefOf(key))) {
        continue;
      }

      // A field-level aspect keeps its `@<path>` in the key it is written under.
      const aspectType = dataplex._typeRefToName(aspectTypeRefOf(key), 'aspect');
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

  if (!isOkf) {
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

  const entrySource: NonNullable<dataplex.Entry['entrySource']> = {};
  if (resource.name !== undefined) entrySource.resource = resource.name;
  if (resource.system !== undefined) entrySource.system = resource.system;
  if (resource.platform !== undefined) entrySource.platform = resource.platform;
  if (resource.ancestors !== undefined) entrySource.ancestors = resource.ancestors;
  if (resource.displayName !== undefined) entrySource.displayName = resource.displayName;
  if (resource.description !== undefined) entrySource.description = resource.description;
  if (resource.labels !== undefined) entrySource.labels = resource.labels;
  if (resource.location !== undefined) entrySource.location = resource.location;
  if (resource.createTime !== undefined) entrySource.createTime = resource.createTime;
  if (resource.updateTime !== undefined) entrySource.updateTime = resource.updateTime;

  const out: dataplex.Entry = {
    name: serviceName,
    entryType: entryTypeName,
    aspects: aspects
  };
  if (resource.parent !== undefined) {
    out.parentEntry = resource.parent;
  }
  if (Object.keys(entrySource).length) {
    out.entrySource = entrySource;
  }
  return out;
}

// The aspect type reference in an aspect key: the part before any `@<path>`,
// as in `p.global.guidelines@Schema.col1`.
function aspectTypeRefOf(key: string): string {
  const at = key.indexOf('@');
  return at < 0 ? key : key.slice(0, at);
}
