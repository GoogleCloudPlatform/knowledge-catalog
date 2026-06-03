// Implements a local catalog interface
//

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as gcp from './gcp/context';
import * as dataplex from './gcp/dataplex';
import * as crm from './gcp/crm';
import * as md from './metadata';
import { CatalogManifest, resolveEntryLinkType, findAliasForType, findAspectAliasForType, resolveAspectAlias } from './manifest';
import { CatalogLayout, createLayout } from './layout';


export class CatalogSnapshot {

  public readonly manifest: CatalogManifest;
  public readonly basePath: string;

  private readonly _entryTypes: Map<string, dataplex.EntryType> = new Map();
  private readonly _aspectTypes: Map<string, dataplex.AspectType> = new Map();

  private readonly _layout: CatalogLayout;
  private readonly _ctx: gcp.ApiContext;

  private constructor(basePath: string, manifest: CatalogManifest, ctx: gcp.ApiContext) {
    this.basePath = basePath;
    this.manifest = manifest;
    this._ctx = ctx;

    const catalogPath = path.join(this.basePath, 'catalog');
    this._layout = createLayout(manifest.source.layout, catalogPath, manifest.source);
  }

  static async fromPath(basePath: string, ctx: gcp.ApiContext): Promise<CatalogSnapshot> {
    const manifestPath = path.join(basePath, 'catalog.yaml');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Cannot find catalog manifest at '${manifestPath}'`);
    }

    const manifest = await CatalogManifest.load(manifestPath, ctx);
    const snapshot = new CatalogSnapshot(basePath, manifest, ctx);

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
  async _storeEntry(
    entry: dataplex.Entry,
    entryLinks?: dataplex.EntryLink[]
  ): Promise<void> {
    const localName = this.manifest.source.localName(entry);
    await this._layout.saveEntry(localName, await toLocalEntry(entry, localName, entryLinks, this.manifest, this._ctx));
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
    return toServiceEntry(
      entry,
      serviceName,
      this.manifest,
      this._entryTypes,
      this._aspectTypes
    );
  }

  async _fetchEntryLinks(name: string): Promise<dataplex.EntryLink[]> {
    const entry = await this._layout.loadEntry(name);
    const serviceName = this.manifest.source.serviceName(name);
    return toServiceEntryLinks(entry, serviceName, this.manifest);
  }
}

const GLOSSARY_DISPLAY_NAME_CACHE = new Map<string, string>();
const GLOSSARY_TERM_DISPLAY_NAME_CACHE = new Map<string, string>();

async function getGlossaryDisplayName(
  project: string,
  location: string,
  glossaryId: string,
  ctx: gcp.ApiContext
): Promise<string> {
  const cacheKey = `${project}/${location}/glossaries/${glossaryId}`;
  if (GLOSSARY_DISPLAY_NAME_CACHE.has(cacheKey)) {
    return GLOSSARY_DISPLAY_NAME_CACHE.get(cacheKey)!;
  }

  const catalog = new dataplex.CatalogClient(ctx);
  try {
    const res = await catalog.getGlossary(project, location, glossaryId);
    if (res.status === 200 && res.result?.displayName) {
      const displayName = res.result.displayName;
      GLOSSARY_DISPLAY_NAME_CACHE.set(cacheKey, displayName);
      return displayName;
    }
  } catch (err) {
    // Fallback to ID if lookup fails
  }

  GLOSSARY_DISPLAY_NAME_CACHE.set(cacheKey, glossaryId);
  return glossaryId;
}

async function getGlossaryTermDisplayName(
  project: string,
  location: string,
  glossaryId: string,
  termId: string,
  ctx: gcp.ApiContext
): Promise<string> {
  const cacheKey = `${project}/${location}/glossaries/${glossaryId}/terms/${termId}`;
  if (GLOSSARY_TERM_DISPLAY_NAME_CACHE.has(cacheKey)) {
    return GLOSSARY_TERM_DISPLAY_NAME_CACHE.get(cacheKey)!;
  }

  const catalog = new dataplex.CatalogClient(ctx);
  try {
    const res = await catalog.getGlossaryTerm(project, location, glossaryId, termId);
    if (res.status === 200 && res.result?.displayName) {
      const displayName = res.result.displayName;
      GLOSSARY_TERM_DISPLAY_NAME_CACHE.set(cacheKey, displayName);
      return displayName;
    }
  } catch (err) {
    // Fallback to ID if lookup fails
  }

  GLOSSARY_TERM_DISPLAY_NAME_CACHE.set(cacheKey, termId);
  return termId;
}

export async function toLocalTarget(
  serviceName: string,
  manifest: CatalogManifest | undefined,
  ctx: gcp.ApiContext | undefined
): Promise<string> {
  if (!ctx) {
    return serviceName;
  }

  // 1. Glossary Term
  const glossaryMatch = serviceName.match(/^projects\/([^/]+)\/locations\/([^/]+)\/entryGroups\/@dataplex\/entries\/(projects\/[^/]+\/locations\/[^/]+\/glossaries\/[^/]+\/terms\/[^/]+)$/);
  if (glossaryMatch) {
    const normalizedSub = await crm.fixProject(glossaryMatch[3], ctx);
    const parts = normalizedSub.split('/');
    const targetProject = parts[1];
    const targetLocation = parts[3];
    const glossaryId = parts[5];
    const termId = parts[7];

    const glossaryDisplayName = await getGlossaryDisplayName(
      targetProject,
      targetLocation,
      glossaryId,
      ctx
    );
    const termDisplayName = await getGlossaryTermDisplayName(
      targetProject,
      targetLocation,
      glossaryId,
      termId,
      ctx
    );

    return `${targetProject}.${targetLocation}.${glossaryDisplayName}.${termDisplayName}`;
  }

  // 2. BigQuery Dataset/Table
  const bqMatch = serviceName.match(/^projects\/[^/]+\/locations\/([^/]+)\/entryGroups\/@bigquery\/entries\/bigquery.googleapis.com\/projects\/([^/]+)\/datasets\/([^/]+)(\/tables\/([^/]+))?$/);
  if (bqMatch) {
    const [, , project, dataset, , table] = bqMatch;
    const normalizedProject = await crm.fixProject(`projects/${project}`, ctx);
    const projectId = normalizedProject.split('/')[1];
    if (table) {
      return `${projectId}.${dataset}.${table}`;
    }
    return `${projectId}.${dataset}`;
  }

  // 3. General EntryGroup Entry
  const generalMatch = serviceName.match(/^projects\/([^/]+)\/locations\/([^/]+)\/entryGroups\/([^/]+)\/entries\/(.+)$/);
  if (generalMatch) {
    const [, project, location, entryGroup, entryId] = generalMatch;
    const normalizedProject = await crm.fixProject(`projects/${project}`, ctx);
    const projectId = normalizedProject.split('/')[1];
    return `${projectId}.${location}.${entryGroup}.${entryId}`;
  }

  // Fallback to manifest tryGetLocalName if available
  if (manifest) {
    const resolved = manifest.source.tryGetLocalName(serviceName);
    if (resolved !== undefined) {
      return resolved.replace(/\//g, '.');
    }
  }

  return serviceName;
}

export function fromLocalTarget(
  localTarget: string,
  entryLinkType: string,
  serviceNameContext: string,
  manifest?: CatalogManifest
): string {
  if (localTarget.startsWith('projects/')) {
    return localTarget;
  }

  const parts = localTarget.split('.');

  // 1. Glossary Term (definition, synonym, related link types)
  const isGlossaryLink = entryLinkType.endsWith('/entryLinkTypes/definition') ||
                         entryLinkType.endsWith('/entryLinkTypes/synonym') ||
                         entryLinkType.endsWith('/entryLinkTypes/related');

  if (isGlossaryLink && parts.length === 4) {
    const [project, location, glossary, term] = parts;
    const match = serviceNameContext.match(/^projects\/([^/]+)\/locations\/([^/]+)\/entryGroups\//);
    if (match) {
      const catalogProject = match[1];
      const catalogLocation = match[2];
      return `projects/${catalogProject}/locations/${catalogLocation}/entryGroups/@dataplex/entries/projects/${project}/locations/${location}/glossaries/${glossary}/terms/${term}`;
    }
  }

  // 2. BigQuery Dataset/Table (3 parts: project.dataset.table, or 2 parts: project.dataset)
  if (parts.length === 3 || parts.length === 2) {
    const [project, dataset, table] = parts;
    const match = serviceNameContext.match(/^projects\/([^/]+)\/locations\/([^/]+)\/entryGroups\//);
    if (match) {
      const catalogProject = match[1];
      const catalogLocation = match[2];
      const entryGroup = `projects/${catalogProject}/locations/${catalogLocation}/entryGroups/@bigquery`;
      const entryName = `${entryGroup}/entries/bigquery.googleapis.com/projects/${project}/datasets/${dataset}`;
      if (table) {
        return `${entryName}/tables/${table}`;
      }
      return entryName;
    }
  }

  // 3. General EntryGroup Entry (4 parts: project.location.entryGroup.entryId)
  if (parts.length === 4) {
    const [project, location, entryGroup, entryId] = parts;
    return `projects/${project}/locations/${location}/entryGroups/${entryGroup}/entries/${entryId}`;
  }

  if (manifest) {
    return manifest.source.serviceName(localTarget);
  }

  return localTarget;
}

// Converts a Dataplex entry into the local metadata representation.
async function toLocalEntry(
  entry: dataplex.Entry,
  localName: string,
  entryLinks?: dataplex.EntryLink[],
  manifest?: CatalogManifest,
  ctx?: gcp.ApiContext
): Promise<md.Entry> {
  const aspects: Record<string, md.Aspect> = {};
  if (entry.aspects) {
    for (const key in entry.aspects) {
      aspects[key] = entry.aspects[key].data ?? {};
    }
  }

  const links: Record<string, md.EntryLink[]> = {};
  if (entryLinks) {
    for (const link of entryLinks) {
      const sourceRef = link.entryReferences.find(
        ref =>
          ref.type === 'SOURCE' ||
          !ref.type ||
          ref.type === 'UNSPECIFIED' ||
          ref.name === entry.name
      ) || link.entryReferences[0];
      
      const targetRef = link.entryReferences.find(
        ref =>
          (ref !== sourceRef) &&
          (ref.type === 'TARGET' ||
           !ref.type ||
           ref.type === 'UNSPECIFIED' ||
           ref.name !== entry.name)
      ) || link.entryReferences[1];

      if (sourceRef && targetRef) {
        const targetLocalName = await toLocalTarget(targetRef.name, manifest, ctx);

        const linkTypeRef = findAliasForType(dataplex._nameToTypeRef(link.entryLinkType), manifest);

        let linkId: string | undefined;
        if (targetRef.name) {
          const match = targetRef.name.match(/\/entries\/(.+)$/);
          if (match) {
            linkId = match[1];
            if (ctx && linkId.startsWith('projects/')) {
              linkId = await crm.fixProject(linkId, ctx);
            }
          }
        }

        const localLink: md.EntryLink = {
          target: targetLocalName,
        };
        if (linkId) {
          localLink.id = linkId;
        }

        if (link.aspects) {
          for (const [aspectKey, aspectValue] of Object.entries(link.aspects)) {
            const resolvedAspectKey = findAspectAliasForType(aspectKey, manifest);
            localLink[resolvedAspectKey] = aspectValue.data ?? {};
          }
        }

        if (sourceRef.path) {
          const pathParts = sourceRef.path.split('.');
          if (pathParts[0] === 'schema' && pathParts[1]) {
            const schemaAspect = aspects['dataplex-types.global.schema'];
            if (schemaAspect && Array.isArray(schemaAspect.fields)) {
              const field = schemaAspect.fields.find((f: any) => f.name === pathParts[1]);
              if (field) {
                if (!field.links) {
                  field.links = {};
                }
                if (!field.links[linkTypeRef]) {
                  field.links[linkTypeRef] = [];
                }
                field.links[linkTypeRef].push(localLink);
                continue;
              }
            }
          }
        }

        if (!links[linkTypeRef]) {
          links[linkTypeRef] = [];
        }
        links[linkTypeRef].push(localLink);
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
        updateTime: entrySource.updateTime ?? undefined
      },
      aspects: aspects ?? undefined,
      links: Object.keys(links).length ? links : undefined
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

function toServiceEntryLinks(
  entry: md.Entry,
  serviceName: string,
  manifest: CatalogManifest
): dataplex.EntryLink[] {
  const links: dataplex.EntryLink[] = [];

  if (entry.links) {
    for (const [linkTypeRef, entryLinks] of Object.entries(entry.links)) {
      const resolvedLinkType = resolveEntryLinkType(linkTypeRef, manifest);
      if (manifest.publishingConfig) {
        const resolvedPublishingLinks = manifest.publishingConfig.entryLinks?.map(l => resolveEntryLinkType(l, manifest)) ?? [];
        if (!resolvedPublishingLinks.includes(resolvedLinkType)) {
          continue;
        }
      }

      let fullLinkTypeRef = resolvedLinkType;
      if (fullLinkTypeRef.split('.').length === 1) {
        fullLinkTypeRef = `dataplex-types.global.${fullLinkTypeRef}`;
      }
      fullLinkTypeRef = fullLinkTypeRef.replace(/^dataplex-types\./, '655216118709.');

      const entryLinkType = dataplex._typeRefToName(fullLinkTypeRef, 'entryLink');
      for (const link of entryLinks) {
        let targetName = '';
        const isGlossaryLink = entryLinkType.endsWith('/entryLinkTypes/definition') ||
                               entryLinkType.endsWith('/entryLinkTypes/synonym') ||
                               entryLinkType.endsWith('/entryLinkTypes/related');
        if (isGlossaryLink && link.id && link.id.includes('/')) {
          const match = serviceName.match(/^(projects\/[^/]+\/locations\/[^/]+)/);
          if (match) {
            targetName = `${match[1]}/entryGroups/@dataplex/entries/${link.id}`;
          }
        }
        if (!targetName) {
          targetName = fromLocalTarget(link.target, entryLinkType, serviceName, manifest);
        }

        let linkName = '';
        if (link.id && !link.id.includes('/')) {
          const match = serviceName.match(/^(projects\/[^/]+\/locations\/[^/]+\/entryGroups\/[^/]+)/);
          if (match) {
            linkName = `${match[1]}/entryLinks/${link.id}`;
          }
        }

        const linkAspects: Record<string, dataplex.Aspect> = {};
        for (const [k, v] of Object.entries(link)) {
          if (k === 'target' || k === 'id') {
            continue;
          }
          const qualifiedAspectType = resolveAspectAlias(k, manifest);
          const aspectTypeName = dataplex._typeRefToName(
            qualifiedAspectType.replace(/^dataplex-types\./, '655216118709.'),
            'aspect'
          );
          linkAspects[aspectTypeName] = {
            aspectType: aspectTypeName,
            data: v
          };
        }

        links.push({
          name: linkName,
          entryLinkType,
          entryReferences: [
            { name: serviceName, type: 'SOURCE' },
            { name: targetName, type: 'TARGET' },
          ],
          aspects: Object.keys(linkAspects).length ? linkAspects : undefined,
        });
      }
    }
  }

  const schemaAspect = entry.aspects?.['dataplex-types.global.schema'];
  if (schemaAspect && Array.isArray(schemaAspect.fields)) {
    for (const field of schemaAspect.fields) {
      if (field.links) {
        for (const [linkTypeRef, entryLinks] of Object.entries(field.links as Record<string, md.EntryLink[]>)) {
          const resolvedLinkType = resolveEntryLinkType(linkTypeRef, manifest);
          if (manifest.publishingConfig) {
            const resolvedPublishingLinks = manifest.publishingConfig.entryLinks?.map(l => resolveEntryLinkType(l, manifest)) ?? [];
            if (!resolvedPublishingLinks.includes(resolvedLinkType)) {
              continue;
            }
          }

          let fullLinkTypeRef = resolvedLinkType;
          if (fullLinkTypeRef.split('.').length === 1) {
            fullLinkTypeRef = `dataplex-types.global.${fullLinkTypeRef}`;
          }
          fullLinkTypeRef = fullLinkTypeRef.replace(/^dataplex-types\./, '655216118709.');

          const entryLinkType = dataplex._typeRefToName(fullLinkTypeRef, 'entryLink');
          for (const link of entryLinks) {
            let targetName = '';
            const isGlossaryLink = entryLinkType.endsWith('/entryLinkTypes/definition') ||
                                   entryLinkType.endsWith('/entryLinkTypes/synonym') ||
                                   entryLinkType.endsWith('/entryLinkTypes/related');
            if (isGlossaryLink && link.id && link.id.includes('/')) {
              const match = serviceName.match(/^(projects\/[^/]+\/locations\/[^/]+)/);
              if (match) {
                targetName = `${match[1]}/entryGroups/@dataplex/entries/${link.id}`;
              }
            }
            if (!targetName) {
              targetName = fromLocalTarget(link.target, entryLinkType, serviceName, manifest);
            }

            let linkName = '';
            if (link.id && !link.id.includes('/')) {
              const match = serviceName.match(/^(projects\/[^/]+\/locations\/[^/]+\/entryGroups\/[^/]+)/);
              if (match) {
                linkName = `${match[1]}/entryLinks/${link.id}`;
              }
            }

            const linkAspects: Record<string, dataplex.Aspect> = {};
            for (const [k, v] of Object.entries(link)) {
              if (k === 'target' || k === 'id') {
                continue;
              }
              const qualifiedAspectType = resolveAspectAlias(k, manifest);
              const aspectTypeName = dataplex._typeRefToName(
                qualifiedAspectType.replace(/^dataplex-types\./, '655216118709.'),
                'aspect'
              );
              linkAspects[aspectTypeName] = {
                aspectType: aspectTypeName,
                data: v
              };
            }

            links.push({
              name: linkName,
              entryLinkType,
              entryReferences: [
                { name: serviceName, type: 'SOURCE', path: `schema.${field.name}` },
                { name: targetName, type: 'TARGET' },
              ],
              aspects: Object.keys(linkAspects).length ? linkAspects : undefined,
            });
          }
        }
      }
    }
  }

  return links;
}
