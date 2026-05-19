// Implements a local catalog interface
//

import * as fs from 'node:fs';
import * as glob from 'glob';
import * as path from 'node:path';
import * as yaml from 'yaml';

import * as gcp from './gcp/context';
import * as dataplex from './gcp/dataplex';
import * as md from './metadata';
import { CatalogManifest } from './manifest';


export class CatalogSnapshot {

  public readonly manifest: CatalogManifest;
  public readonly basePath: string;

  private _index: Map<string, string> = new Map();
  private _entryTypes: Map<string, dataplex.EntryType> = new Map();
  private _aspectTypes: Map<string, dataplex.AspectType> = new Map();

  constructor(basePath: string, manifest: CatalogManifest) {
    this.basePath = basePath;
    this.manifest = manifest;
  }

  static async fromPath(basePath: string, ctx: gcp.ApiContext): Promise<CatalogSnapshot> {
    const manifestPath = path.join(basePath, 'catalog.yaml');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Cannot find catalog manifest at '${manifestPath}'`);
    }

    const manifest = await CatalogManifest.load(manifestPath, ctx);
    const snapshot = new CatalogSnapshot(basePath, manifest);

    await snapshot._buildTypes(manifest, ctx);
    await snapshot._buildIndex();
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
    return Array.from(this._index.keys());
  }

  // Retrieves the local copy of the entry using its local name
  async lookupEntry(name: string): Promise<md.Entry> {
    const entryPath = this._index.get(name);
    if (!entryPath || !fs.existsSync(entryPath)) {
      throw new Error(`Entry not found: ${name}`);
    }

    const content = await fs.promises.readFile(entryPath, 'utf8');
    return yaml.parse(content) as md.Entry;
  }

  // Updates the locally managed entry, referenced by its local name.
  // The list of fields can either be "resource" to update the resource-level metadata
  // (which is relevant in case of non-ingested entries) or an aspect identified by it
  // key (project.location.type).
  async updateEntry(entry: md.Entry, fields: string[]): Promise<void> {
    const existingEntry = await this.lookupEntry(entry.name);
    if (!existingEntry) {
      throw new Error(`Entry not found: ${entry.name}`);
    }

    for (const f of fields) {
      if (f == 'resource') {
        if (!existingEntry.resource) {
          existingEntry.resource = {};
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

    const entryPath = path.resolve(this.basePath, 'catalog', entry.name + '.yaml');
    await fs.promises.writeFile(entryPath, yaml.stringify(existingEntry));
  }

  // Creates an entry within the locally catalog snapshot. This capabilitiy is only supported
  // when the associated EntryGroup is user-managed, i.e. not contain ingested metadata.
  async createEntry(name: string, entry: md.Entry): Promise<void> {
    if (this.manifest.source.ingestedEntries) {
      throw new Error(`Entry cannot be created as entries are ingested.`);
    }

    // TODO: Validate aspect and other things

    let entryPath = this._index.get(name);
    if (entryPath && fs.existsSync(entryPath)) {
       throw new Error(`Entry '${name}' already exists`);
    }
    entryPath = path.resolve(this.basePath, 'catalog', name + '.yaml');

    await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.promises.writeFile(entryPath, yaml.stringify(entry));
    this._index.set(name, entryPath);
  }

  // Deletes an entry within the locally catalog snapshot. This capabilitiy is only supported
  // when the associated EntryGroup is user-managed, i.e. not contain ingested metadata.
  async deleteEntry(name: string): Promise<void> {
    if (this.manifest.source.ingestedEntries) {
      throw new Error(`Entry cannot be deleted as entries are ingested.`);
    }

    const entryPath = this._index.get(name);
    if (entryPath && fs.existsSync(entryPath)) {
      await fs.promises.unlink(entryPath);
    }
    this._index.delete(name);
  }

  // Build an index of local entry name -> file path
  private async _buildIndex(): Promise<void> {
    const catalogPath = path.join(this.basePath, 'catalog');
    if (!fs.existsSync(catalogPath)) {
      return;
    }

    const matches = await glob.glob('**/*.yaml', {
      cwd: catalogPath,
      absolute: true,
      nodir: true,
    });

    for (const localPath of matches) {
      try {
        const content = await fs.promises.readFile(localPath, 'utf8');
        const metadata = yaml.parse(content);
        if (metadata && metadata.name) {
          const localName = this.manifest.source.localName(metadata);
          this._index.set(localName, localPath);
        }
      }
      catch (err) {
        // TODO: CLI should pass in error logger
        // skip invalid yaml or unreadable files gracefully during indexing
      }
    }
  }

  // Build the map of types supported within the locally managed catalog snapshot
  private async _buildTypes(manifest: CatalogManifest, ctx: gcp.ApiContext): Promise<void> {
    const catalog = new dataplex.CatalogClient(ctx);

    for (const entryType of manifest.snapshotConfig?.entries || []) {
      const parts = entryType.split('.');
      const res = await catalog.getEntryType(parts[0], parts[1], parts[2]);
      if (!res.result) {
        throw new Error(`Unable to load type information for entry type ${entryType}`);
      }

      this._entryTypes.set(res.result.name, res.result);

      for (const requiredAspect of res.result.requiredAspects ?? []) {
        if (!this._aspectTypes.has(requiredAspect.type)) {
          const parts = requiredAspect.type.split('/');
          const res = await catalog.getAspectType(parts[1], parts[3], parts[5]);
          if (!res.result) {
            throw new Error(`Unable to load type information for aspect type ${requiredAspect.type}`);
          }
          this._aspectTypes.set(res.result.name, res.result);
        }
      }
    }

    for (const aspectType of manifest.snapshotConfig?.aspects || []) {
      const parts = aspectType.split('.');
      const res = await catalog.getAspectType(parts[0], parts[1], parts[2]);
      if (!res.result) {
        throw new Error(`Unable to load type information for aspect type ${aspectType}`);
      }
      this._aspectTypes.set(res.result.name, res.result);
    }
  }

  // Stores a Dataplex entry into the locally managed catalog snapshot. This will internally map
  // The service representation into the local metadata representation.
  // This is only meant to be used within the syncing process (as part of pull operations).
  async _storeEntry(name: string, entry: dataplex.Entry): Promise<void> {
    let entryPath = this._index.get(name);
    if (!entryPath) {
      entryPath = path.resolve(this.basePath, 'catalog', name + '.yaml');
    }

    await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.promises.writeFile(entryPath, yaml.stringify(toLocalEntry(entry)));
    this._index.set(name, entryPath);
  }

  // Parses a Dataplex entry from its local metadata representation.
  // This is only meant to be used within the syncing process (as part of push operations).
  async _parseEntry(name: string): Promise<dataplex.Entry | undefined> {
    const entry = await this.lookupEntry(name);
    if (!entry) {
      throw new Error(`Entry not found: ${name}`);
    }

    if (this.manifest.publishingConfig?.entries?.length &&
        !this.manifest.publishingConfig.entries.includes(dataplex._nameToTypeRef(entry.type))) {
      return undefined;
    }

    return fromLocalEntry(
      entry,
      this.manifest,
      this._entryTypes,
      this._aspectTypes,
    );
  }
}

// Converts a Dataplex entry into the local metadata representation.
function toLocalEntry(entry: dataplex.Entry): md.Entry {
  const aspects: Record<string, md.Aspect> = {};
  if (entry.aspects) {
    for (const key in entry.aspects) {
      aspects[key] = entry.aspects[key].data ?? {};
    }
  }

  const entrySource = entry.entrySource ?? {};

  return {
      name: entry.name,
      type: entry.entryType,
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
function fromLocalEntry(entry: md.Entry,
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

  if (manifest.source.ingestedEntries) {
    return {
      name: entry.name,
      entryType: entry.type,
      aspects: aspects
    };
  }

  return {
    name: entry.name,
    entryType: entry.type,
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
