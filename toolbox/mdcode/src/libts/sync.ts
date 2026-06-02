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
      const hasSnapshotLinks = snapshotLinks && snapshotLinks.length > 0;

      let linksMap = new Map<string, dataplex.EntryLink[]>();
      const isEntryGroupScope =
        this._snapshot.manifest.source.type === 'entryGroup' ||
        this._snapshot.manifest.source.type === 'kb';

      const entryLinkTypes = snapshotLinks?.map(
        linkTypeRef => dataplex._typeRefToName(resolveEntryLinkType(linkTypeRef, this._snapshot.manifest), 'entryLink')
      );

      if (hasSnapshotLinks && isEntryGroupScope) {
        const nameParts = this._snapshot.manifest.source.name.split('.');
        const project = nameParts[0];
        const location = nameParts[1];
        const entryGroupId = nameParts[2];

        for await (const link of this._catalog.listEntryLinks(project, location, entryGroupId)) {
          if (entryLinkTypes && !entryLinkTypes.includes(link.entryLinkType)) {
            continue;
          }
          const sourceRef = link.entryReferences.find(
            ref =>
              ref.type === 'SOURCE' ||
              !ref.type ||
              ref.type === 'UNSPECIFIED'
          );
          if (sourceRef) {
            let list = linksMap.get(sourceRef.name);
            if (!list) {
              list = [];
              linksMap.set(sourceRef.name, list);
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
        if (hasSnapshotLinks) {
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
            const sourceRef = remoteLink.entryReferences.find(
              ref =>
                ref.type === 'SOURCE' ||
                (ref.type === 'UNSPECIFIED' && ref.name === entry.name)
            );
            const targetRef = remoteLink.entryReferences.find(
              ref =>
                ref.type === 'TARGET' ||
                (ref.type === 'UNSPECIFIED' && ref.name !== entry.name)
            );

            if (sourceRef && targetRef) {
              const foundLocal = localLinks.find(loc => {
                const locSource = loc.entryReferences.find(r => r.type === 'SOURCE');
                const locTarget = loc.entryReferences.find(r => r.type === 'TARGET');
                return (
                  loc.entryLinkType === remoteLink.entryLinkType &&
                  locTarget?.name === targetRef.name &&
                  locSource?.path === sourceRef.path
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
            const locSource = localLink.entryReferences.find(
              r => r.type === 'SOURCE'
            );
            const locTarget = localLink.entryReferences.find(
              r => r.type === 'TARGET'
            );

            const foundRemote = remoteLinks.find(rem => {
              const remSource = rem.entryReferences.find(
                r =>
                  r.type === 'SOURCE' ||
                  (r.type === 'UNSPECIFIED' && r.name === entry.name)
              );
              const remTarget = rem.entryReferences.find(
                r =>
                  r.type === 'TARGET' ||
                  (r.type === 'UNSPECIFIED' && r.name !== entry.name)
              );
              return (
                rem.entryLinkType === localLink.entryLinkType &&
                remTarget?.name === locTarget?.name &&
                remSource?.path === locSource?.path
              );
            });

            if (!foundRemote) {
              if (options?.dryRun) {
                console.log(`[DRY-RUN] Create EntryLink: ${localLink.entryLinkType} from ${locSource?.name} to ${locTarget?.name}`);
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
