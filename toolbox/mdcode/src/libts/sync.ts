// Implements catalog sync logic for pull and push operations
//

import * as gcp from './gcp';
import * as dataplex from './gcp/dataplex';
import { CatalogSnapshot } from './snapshot';
import { resolveEntryLinkType } from './manifest';

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
  async pull(options?: { dryRun?: boolean; }): Promise<SyncResult> {
    try {
      const entries = this._snapshot.manifest.source.entries(this._catalog.context);
      
      const snapshotLinks = this._snapshot.manifest.snapshotConfig?.entryLinks;
      const hasSnapshotLinks = snapshotLinks !== undefined && snapshotLinks.length > 0;

      let linksMap = new Map<string, dataplex.EntryLink[]>();
      const isEntryGroupScope =
        this._snapshot.manifest.source.type === 'entryGroup' ||
        this._snapshot.manifest.source.type === 'kb';

      const entryLinkTypes = snapshotLinks?.map(
        linkTypeRef => dataplex._typeRefToName(resolveEntryLinkType(linkTypeRef, this._snapshot.manifest), 'entryLink')
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

        if (options?.dryRun) {
          console.log(`[DRY-RUN] Pull Entry: ${entry.name}`);
        } else {
          await this._snapshot._storeEntry(res.result, entryLinks.length ? entryLinks : undefined);
        }
      }
      return { success: true };
    }
    catch (e: any) {
      return { success: false, details: e.message };
    }
  }

  // Pushes local metadata to the Catalog service to publish/deploy it.
  async push(options?: { force?: boolean, validateOnly?: boolean; dryRun?: boolean; }): Promise<SyncResult> {
    const entries = await this._snapshot.listEntries();

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

      const updateMask = [];
      const aspectKeys = Object.keys(entry.aspects || {});
      if (aspectKeys.length) {
        updateMask.push('aspects');
      }

      if (!this._snapshot.manifest.source.ingestedEntries) {
        if (entry.entrySource) {
          updateMask.push('entry_source');
        }
      }

      if (updateMask.length) {
        if (options?.dryRun) {
          console.log(`[DRY-RUN] Modify Entry ${entry.name} (updateMask: ${updateMask.join(',')}, aspects: ${aspectKeys.join(',')})`);
        } else {
          const res = await this._catalog.modifyEntry(project, location, entry, updateMask, aspectKeys);
          if (res.status !== 200 || !res.result) {
            return { success: false, details: `Failed to update entry ${name}: ${res.message || res.status}` };
          }
        }
      }

      // Safe link synchronization check
      const publishingLinks = this._snapshot.manifest.publishingConfig?.entryLinks;
      const hasPublishingLinks = publishingLinks && publishingLinks.length > 0;

      if (hasPublishingLinks) {
        const localLinks = await this._snapshot._fetchEntryLinks(name);
        const entryLinkTypes = publishingLinks.map(
          linkTypeRef => dataplex._typeRefToName(resolveEntryLinkType(linkTypeRef, this._snapshot.manifest), 'entryLink')
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

        const entryGroupMatch = entry.name.match(
          /projects\/([^/]+)\/locations\/([^/]+)\/entryGroups\/([^/]+)/
        );
        if (entryGroupMatch) {
          const entryGroup = entryGroupMatch[3];

          for (const remoteLink of remoteLinks) {
            const remCurrent = remoteLink.entryReferences.find(r => r.name === entry.name) || remoteLink.entryReferences[0];
            const remOther = remoteLink.entryReferences.find(r => r !== remCurrent) || remoteLink.entryReferences[1];

            if (remCurrent && remOther) {
              const foundLocal = localLinks.find(loc => {
                const locCurrent = loc.entryReferences.find(r => r.name === entry.name) || loc.entryReferences[0];
                const locOther = loc.entryReferences.find(r => r !== locCurrent) || loc.entryReferences[1];
                return (
                  loc.entryLinkType === remoteLink.entryLinkType &&
                  locOther?.name === remOther.name &&
                  locCurrent?.path === remCurrent.path &&
                  locOther?.path === remOther.path
                );
              });

              if (!foundLocal) {
                const parts = remoteLink.name.split('/');
                const linkName = parts[parts.length - 1];
                if (options?.dryRun) {
                  console.log(`[DRY-RUN] Delete EntryLink: ${remoteLink.name}`);
                } else {
                  await this._catalog.deleteEntryLink(
                    project,
                    location,
                    entryGroup,
                    linkName
                  );
                }
              }
            }
          }

          for (const localLink of localLinks) {
            const locCurrent = localLink.entryReferences.find(r => r.name === entry.name) || localLink.entryReferences[0];
            const locOther = localLink.entryReferences.find(r => r !== locCurrent) || localLink.entryReferences[1];

            const foundRemote = remoteLinks.find(rem => {
              const remCurrent = rem.entryReferences.find(r => r.name === entry.name) || rem.entryReferences[0];
              const remOther = rem.entryReferences.find(r => r !== remCurrent) || rem.entryReferences[1];
              return (
                rem.entryLinkType === localLink.entryLinkType &&
                remOther?.name === locOther?.name &&
                remCurrent?.path === locCurrent?.path &&
                remOther?.path === locOther?.path
              );
            });

            if (!foundRemote) {
              if (options?.dryRun) {
                console.log(`[DRY-RUN] Create EntryLink: ${localLink.entryLinkType} from ${locCurrent?.name} to ${locOther?.name}`);
              } else {
                await this._catalog.createEntryLink(
                  project,
                  location,
                  entryGroup,
                  localLink
                );
              }
            } else {
              const localAspectsJson = JSON.stringify(localLink.aspects || {});
              const remoteAspectsJson = JSON.stringify(
                foundRemote.aspects
                  ? Object.fromEntries(
                      Object.entries(foundRemote.aspects).map(([k, v]) => [
                        k,
                        v.data,
                      ])
                    )
                  : {}
              );

              if (localAspectsJson !== remoteAspectsJson) {
                const parts = foundRemote.name.split('/');
                const linkName = parts[parts.length - 1];
                if (options?.dryRun) {
                  console.log(`[DRY-RUN] Update EntryLink aspects for ${foundRemote.name}`);
                } else {
                  await this._catalog.deleteEntryLink(
                    project,
                    location,
                    entryGroup,
                    linkName
                  );
                  await this._catalog.createEntryLink(
                    project,
                    location,
                    entryGroup,
                    localLink
                  );
                }
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
