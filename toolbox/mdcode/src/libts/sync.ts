// Implements catalog sync logic for pull and push operations
//

import * as gcp from './gcp';
import * as dataplex from './gcp/dataplex';
import { CatalogSnapshot } from './snapshot';
import { resolveEntryLinkType } from './manifest';
import * as crm from './gcp/crm';

function normalizeToProjectNumberSync(name: string): string {
  const match = name.match(/^projects\/([^/]+)\//);
  if (match) {
    const num = crm.tryGetProjectNumber(match[1]);
    if (num) {
      return name.replace(/^projects\/[^/]+\//, `projects/${num}/`);
    }
  }
  return name;
}

function getTargetEntryGroup(entryName: string): string {
  const match = entryName.match(
    /projects\/([^/]+)\/locations\/([^/]+)\/entryGroups\/([^/]+)/
  );
  if (!match) {
    throw new Error(`Invalid entry name: ${entryName}`);
  }
  return match[3];
}

export interface SyncResult {
  success: boolean;
  details?: string;
}

export interface ValidationResult {
  valid: boolean;
}

export interface StatusResult {
  modified: boolean;
}


export class CatalogSync {
  private _catalog: gcp.CatalogClient;
  private _snapshot: CatalogSnapshot;

  constructor(catalog: gcp.CatalogClient, snapshot: CatalogSnapshot) {
    this._catalog = catalog;
    this._snapshot = snapshot;
  }

  // Lists metadata in the Catalog service to create or update the local snapshot.
  async pull(): Promise<SyncResult> {
    try {
      const entries = this._snapshot.manifest.source.entries(this._catalog.context);
      
      const snapshotLinks = this._snapshot.manifest.snapshotConfig?.entryLinks;

      let linksMap = new Map<string, dataplex.EntryLink[]>();
      const isEntryGroupScope =
        this._snapshot.manifest.source.type === 'entryGroup' ||
        this._snapshot.manifest.source.type === 'kb';

      const entryLinkTypes = snapshotLinks?.map(
        linkTypeRef => dataplex._typeRefToName(resolveEntryLinkType(linkTypeRef), 'entryLink')
      );

      if (isEntryGroupScope) {
        const nameParts = this._snapshot.manifest.source.name.split('.');
        const project = nameParts[0];
        const location = nameParts[1];
        const entryGroupId = nameParts[2];

        for await (const link of this._catalog.listEntryLinks(project, location, entryGroupId)) {
          if (entryLinkTypes && !entryLinkTypes.includes(link.entryLinkType)) {
            continue;
          }
          for (const ref of link.entryReferences) {
            let list = linksMap.get(ref.name);
            if (!list) {
              list = [];
              linksMap.set(ref.name, list);
            }
            list.push(link);
          }
        }
      }

      for await (const entry of entries) {
        if (this._snapshot.entryTypes.size && !this._snapshot.entryTypes.has(entry.entryType)) {
          continue;
        }

        // TODO: Need to populate type info if its a type we haven't seen.
        // TODO: Handle local modification conflicts.
        // TODO: Handle config changes or service deletions that require removing local entries.

        const nameParts = entry.name.split('/');
        const res = await this._catalog.lookupEntry(nameParts[1], nameParts[3], entry.name,
                                                    [...this._snapshot.aspectTypes.keys()]);
        // The server will respond with 403 permission denied for both resource not exist or 
        // insufficient permission. We cannot tell if a resource not exist or user does not 
        // have the access. Thus using 200 for an ensured result.
        if (res.status != 200 || !res.result) {
          continue;
        }

        let entryLinks: dataplex.EntryLink[] = [];
        if (isEntryGroupScope) {
          entryLinks = linksMap.get(entry.name) || [];
        } else {
          const linksRes = await this._catalog.lookupEntryLinks(
            nameParts[1],
            nameParts[3],
            entry.name,
            entryLinkTypes
          );
          if (linksRes.status === 200 && linksRes.result?.entryLinks) {
            entryLinks = linksRes.result.entryLinks;
          }
        }

        await this._snapshot._storeEntry(res.result, entryLinks.length ? entryLinks : undefined);
      }
      return { success: true };
    }
    catch (e: any) {
      return { success: false, details: e.message };
    }
  }

  // Pushes local metadata to the Catalog service to publish/deploy it.
  async push(options?: { force?: boolean, validateOnly?: boolean; }): Promise<SyncResult> {
    const entries = await this._snapshot.listEntries();

    const allLocalLinks: dataplex.EntryLink[] = [];
    for (const name of entries) {
      const entry = await this._snapshot._fetchEntry(name);
      if (entry) {
        const entryLocalLinks = await this._snapshot._fetchEntryLinks(name);
        allLocalLinks.push(...entryLocalLinks);
      }
    }

    for (const name of entries) {
      const entry = await this._snapshot._fetchEntry(name);
      if (!entry) {
        // If this was filtered out based on publishing config
        continue;
      }

      // TODO: Track what has changed and do minimal update.
      // TODO: Handle creates and deletes, as well as partial updates.
      // TODO: Handle conflicts.

      const nameParts = entry.name.split('/');
      const project = nameParts[1];
      const location = nameParts[3];

      const exist = await this._catalog.lookupEntry(project, location, entry.name);
      if (exist.status != 200 || !exist.result) {
        const entryGroup = nameParts[5];
        const entryId = nameParts.slice(7).join('/');
        const createEntryRes = await this._catalog.createEntry(project, location, entryGroup, entryId, entry);
        if (createEntryRes.status != 200 || !createEntryRes.result) {
          return { success: false, details: `Failed to create entry ${entry.name}: ${createEntryRes.message || createEntryRes.status}` };
        }
        continue;
      }

      const updateMask = [];
      const aspectKeys = Object.keys(entry.aspects || {});
      if (aspectKeys.length) {
        updateMask.push('aspects');
      }

      if (!this._snapshot.manifest.source.ingestedEntries) {
        if (entry.entrySource) {
          updateMask.push('entry_source');
        }
        if (entry.parentEntry) {
          updateMask.push('parent_entry');
        }
      }

      if (updateMask.length) {
        const res = await this._catalog.modifyEntry(project, location, entry, updateMask, aspectKeys);
        if (res.status !== 200 || !res.result) {
          return { success: false, details: `Failed to update entry ${name}: ${res.message || res.status}` };
        }
      }

      // Safe link synchronization check
      const publishingLinks = this._snapshot.manifest.publishingConfig?.entryLinks;
      const hasPublishingLinks = publishingLinks && publishingLinks.length > 0;

      if (hasPublishingLinks) {
        const localLinks = await this._snapshot._fetchEntryLinks(name);
        const entryLinkTypes = publishingLinks.map(
          linkTypeRef => dataplex._typeRefToName(resolveEntryLinkType(linkTypeRef), 'entryLink')
        );
        const linksRes = await this._catalog.lookupEntryLinks(
          project,
          location,
          entry.name,
          entryLinkTypes
        );
        const remoteLinks =
          linksRes.status === 200 && linksRes.result?.entryLinks
            ? linksRes.result.entryLinks
            : [];

        const targetEntryGroup = getTargetEntryGroup(entry.name);

        for (const remoteLink of remoteLinks) {
          const remCurrent = remoteLink.entryReferences.find(r => r.name === entry.name) || remoteLink.entryReferences[0];
          const remOther = remoteLink.entryReferences.find(r => r !== remCurrent) || remoteLink.entryReferences[1];

          if (remCurrent && remOther) {
            const foundLocal = allLocalLinks.find(loc => {
              const locCurrent = loc.entryReferences[0];
              const locOther = loc.entryReferences[1];

              const remCurrentNormName = normalizeToProjectNumberSync(remCurrent.name);
              const remOtherNormName = normalizeToProjectNumberSync(remOther.name);
              const locCurrentNormName = normalizeToProjectNumberSync(locCurrent.name);
              const locOtherNormName = normalizeToProjectNumberSync(locOther.name);

              const remNames = [remCurrentNormName, remOtherNormName].sort();
              const locNames = [locCurrentNormName, locOtherNormName].sort();

              const pathMatched = 
                (locCurrentNormName === remCurrentNormName && locCurrent.path === remCurrent.path && locOther.path === remOther.path) ||
                (locCurrentNormName === remOtherNormName && locCurrent.path === remOther.path && locOther.path === remCurrent.path);

              const locType = normalizeToProjectNumberSync(loc.entryLinkType);
              const remType = normalizeToProjectNumberSync(remoteLink.entryLinkType);

              return (
                locType === remType &&
                locNames[0] === remNames[0] &&
                locNames[1] === remNames[1] &&
                pathMatched
              );
            });

            if (!foundLocal) {
              const parts = remoteLink.name.split('/');
              const linkName = parts[parts.length - 1];
              const remMatch = remoteLink.name.match(/\/entryGroups\/([^/]+)\/entryLinks\//);
              const remoteEntryGroup = remMatch ? remMatch[1] : targetEntryGroup;
              const delRes = await this._catalog.deleteEntryLink(
                project,
                location,
                remoteEntryGroup,
                linkName
              );
              if (delRes.status !== 200) {
                return { success: false, details: `Failed to delete remote entry link ${remoteLink.name}: ${delRes.message || delRes.status}` };
              }
            }
          }
        }

        for (const localLink of localLinks) {
          const foundRemote = remoteLinks.find(rem => {
            const remCurrent = rem.entryReferences.find(r => r.name === entry.name) || rem.entryReferences[0];
            const remOther = rem.entryReferences.find(r => r !== remCurrent) || rem.entryReferences[1];

            const locCurrent = localLink.entryReferences[0];
            const locOther = localLink.entryReferences[1];

            const remCurrentNormName = normalizeToProjectNumberSync(remCurrent.name);
            const remOtherNormName = normalizeToProjectNumberSync(remOther.name);
            const locCurrentNormName = normalizeToProjectNumberSync(locCurrent.name);
            const locOtherNormName = normalizeToProjectNumberSync(locOther.name);

            const remNames = [remCurrentNormName, remOtherNormName].sort();
            const locNames = [locCurrentNormName, locOtherNormName].sort();

            const pathMatched = 
              (locCurrentNormName === remCurrentNormName && locCurrent.path === remCurrent.path && locOther.path === remOther.path) ||
              (locCurrentNormName === remOtherNormName && locCurrent.path === remOther.path && locOther.path === remCurrent.path);

            const locType = normalizeToProjectNumberSync(localLink.entryLinkType);
            const remType = normalizeToProjectNumberSync(rem.entryLinkType);

            return (
              locType === remType &&
              locNames[0] === remNames[0] &&
              locNames[1] === remNames[1] &&
              pathMatched
            );
          });

          if (!foundRemote) {
            const createRes = await this._catalog.createEntryLink(
              project,
              location,
              targetEntryGroup,
              localLink
            );
            if (createRes.status !== 200) {
              return { success: false, details: `Failed to create entry link: ${createRes.message || createRes.status}` };
            }
          } else {
            const localAspectsData = Object.fromEntries(
              Object.entries(localLink.aspects || {}).map(([k, v]) => [
                normalizeToProjectNumberSync(k),
                v.data,
              ])
            );

            const remoteAspectsData = Object.fromEntries(
              Object.entries(foundRemote.aspects || {}).map(([k, v]) => [
                normalizeToProjectNumberSync(k),
                v.data,
              ])
            );

            const localAspectsJson = JSON.stringify(localAspectsData);
            const remoteAspectsJson = JSON.stringify(remoteAspectsData);

            if (localAspectsJson !== remoteAspectsJson) {
              const parts = foundRemote.name.split('/');
              const linkName = parts[parts.length - 1];
              const remMatch = foundRemote.name.match(/\/entryGroups\/([^/]+)\/entryLinks\//);
              const remoteEntryGroup = remMatch ? remMatch[1] : targetEntryGroup;
              const delRes = await this._catalog.deleteEntryLink(
                project,
                location,
                remoteEntryGroup,
                linkName
              );
              if (delRes.status !== 200) {
                return { success: false, details: `Failed to delete remote entry link ${foundRemote.name}: ${delRes.message || delRes.status}` };
              }
              const createRes = await this._catalog.createEntryLink(
                project,
                location,
                targetEntryGroup,
                localLink
              );
              if (createRes.status !== 200) {
                return { success: false, details: `Failed to recreate entry link: ${createRes.message || createRes.status}` };
              }
            }
          }
        }
      }
    }

    return { success: true };
  }

  async validate(): Promise<ValidationResult> {
    throw new Error('Not yet implemented');
  }

  async status(): Promise<StatusResult> {
    throw new Error('Not yet implemented');
  }
}
