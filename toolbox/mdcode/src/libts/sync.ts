// Implements catalog sync logic for pull and push operations
//

import * as gcp from './gcp';
import { CatalogSnapshot, toLocalEntry } from './snapshot';
import { CatalogState } from './state';
import * as md from './metadata';
import { calculateEntryChecksum, calculateAspectChecksum } from './checksum';

export interface SyncResult {
  success: boolean;
  details?: string;
}

export interface ValidationResult {
  valid: boolean;
}

export interface StatusResult {
  modified: boolean;
  changes: {
    name: string;
    status: 'Created' | 'Modified' | 'Deleted' | 'Unchanged';
  }[];
}


export class CatalogSync {
  private _catalog: gcp.CatalogClient;
  private _snapshot: CatalogSnapshot;

  constructor(catalog: gcp.CatalogClient, snapshot: CatalogSnapshot) {
    this._catalog = catalog;
    this._snapshot = snapshot;
  }

  async pull(options: { force?: boolean, allowPartial?: boolean, dryRun?: boolean, conflictResolution?: 'accept-local' | 'accept-remote' | 'strict' } = {}): Promise<SyncResult> {
    if (options.conflictResolution === 'accept-remote') {
        options.force = true;
    }

    const statusRes = await this.status();
    const locallyModified = new Set(statusRes.changes.filter(c => c.status !== 'Unchanged').map(c => c.name));

    if (locallyModified.size > 0 && !options.force && !options.allowPartial && !options.dryRun) {
        return { success: false, details: `Cannot pull: you have unpushed local modifications. Use --force to overwrite or --allow-partial to skip conflicting entries.` };
    }

    const state = new CatalogState(this._snapshot.basePath);
    try {
      if (!options.dryRun) {
          await state.lock();
      }
      state.load();

      const entries = this._snapshot.manifest.source.entries(this._catalog.context);
      const pulledEntries = new Set<string>();
      const skippedEntries = new Set<string>();
      
      for await (const entry of entries) {
        if (this._snapshot.entryTypes.size && !this._snapshot.entryTypes.has(entry.entryType)) {
          continue;
        }

        const localName = this._snapshot.manifest.source.localName(entry);
        
        let conflictDetected = false;
        let coreModified = false;
        const modifiedAspects = new Set<string>();

        if (locallyModified.has(localName)) {
            const localEntry = await this._snapshot.lookupEntry(localName);
            const stateEntry = state.getEntry(localName);
            
            if (!stateEntry || calculateEntryChecksum(localEntry) !== stateEntry.entryChecksum) {
                coreModified = true;
            }
            
            if (localEntry.aspects) {
                for (const [aspectKey, aspectData] of Object.entries(localEntry.aspects)) {
                    if (!stateEntry || stateEntry.aspects?.[aspectKey] !== calculateAspectChecksum(aspectData)) {
                        modifiedAspects.add(aspectKey);
                    }
                }
            }
            if (stateEntry?.aspects) {
                for (const aspectKey of Object.keys(stateEntry.aspects)) {
                    if (!localEntry.aspects || !localEntry.aspects[aspectKey]) {
                        modifiedAspects.add(aspectKey);
                    }
                }
            }
            
            if (coreModified || modifiedAspects.size > 0) {
                conflictDetected = true;
            }
            
            if (conflictDetected) {
                if (options.dryRun && !options.force && !options.allowPartial) {
                    console.log(`[Dry Run] Conflict: ${localName} has local modifications (would abort pull)`);
                    skippedEntries.add(localName);
                    continue;
                }
                
                if (!options.force && !options.allowPartial) {
                    return { success: false, details: `Cannot pull: you have unpushed local modifications on ${localName}. Use --force to overwrite or --allow-partial to skip conflicting entries/aspects.` };
                }

                if (!options.force && options.allowPartial) {
                    if (options.dryRun) {
                       console.log(`[Dry Run] Partial Pull: preserving local modifications for ${localName}`);
                    }
                }
            }
        }

        const nameParts = entry.name.split('/');
        const res = await this._catalog.lookupEntry(nameParts[1], nameParts[3], entry.name,
                                                    [...this._snapshot.aspectTypes.keys()]);
        // The server will respond with 403 permission denied for both resource not exist or 
        // insufficient permission. We cannot tell if a resource not exist or user does not 
        // have the access. Thus using 200 for an ensured result.
        if (res.status != 200 || !res.result) {
          continue;
        }

        pulledEntries.add(localName);

        if (options.dryRun) {
            console.log(`[Dry Run] Would pull and update ${localName}`);
            continue;
        }

        if (conflictDetected && !options.force && options.allowPartial) {
             await this._snapshot._storeEntry(res.result, {
                 core: coreModified,
                 aspects: Array.from(modifiedAspects)
             });
        } else {
             await this._snapshot._storeEntry(res.result);
        }

        // Update state tracking with the fetched remote entry, so base state matches remote
        const remoteAsLocal = toLocalEntry(res.result, localName);
        const aspectChecksums: Record<string, string> = {};
        if (remoteAsLocal.aspects) {
          for (const [aspectKey, aspectData] of Object.entries(remoteAsLocal.aspects)) {
            aspectChecksums[aspectKey] = calculateAspectChecksum(aspectData);
          }
        }

        state.updateEntry(localName, {
          entryChecksum: calculateEntryChecksum(remoteAsLocal),
          lastSyncTime: new Date().toISOString(),
          aspects: aspectChecksums,
        });
      }
      
      // Cleanup entries that no longer exist remotely or are no longer in scope
      const existingEntries = await this._snapshot.listEntries();
      for (const name of existingEntries) {
        if (!pulledEntries.has(name) && !skippedEntries.has(name) && (!locallyModified.has(name) || options.force)) {
           if (options.dryRun) {
               console.log(`[Dry Run] Would delete orphaned entry ${name}`);
           } else {
               await this._snapshot._deleteEntry(name);
           }
        }
      }
      for (const name of state.listEntries()) {
        if (!pulledEntries.has(name) && !skippedEntries.has(name)) {
           if (!options.dryRun) {
               state.deleteEntry(name);
           }
        }
      }

      if (!options.dryRun) {
          state.save();
      }
      return { success: true };
    }
    catch (e: any) {
      return { success: false, details: e.message };
    }
    finally {
      if (!options.dryRun) {
          await state.unlock();
      }
    }
  }

  async push(options: { force?: boolean, allowPartial?: boolean, dryRun?: boolean, validateOnly?: boolean, conflictResolution?: 'accept-local' | 'accept-remote' | 'strict' } = {}): Promise<SyncResult> {
    if (options.conflictResolution === 'accept-local') {
        options.force = true;
    }

    const statusRes = await this.status();
    const changesToPush = statusRes.changes.filter(c => c.status !== 'Unchanged');

    if (changesToPush.length === 0) {
      return { success: true };
    }

    const state = new CatalogState(this._snapshot.basePath);
    try {
      if (!options.dryRun) {
          await state.lock();
      }
      state.load();

      for (const change of changesToPush) {
        const localName = change.name;
        
        if (change.status === 'Deleted') {
           if (this._snapshot.manifest.source.ingestedEntries) {
              if (options.dryRun) console.log(`[Dry Run] Cannot delete ingested entry ${localName}`);
              continue;
           }

           if (options.dryRun) {
              console.log(`[Dry Run] Would delete entry ${localName}`);
           } else {
              const serviceName = this._snapshot.manifest.source.serviceName(localName);
              const nameParts = serviceName.split('/');
              const project = nameParts[1];
              const location = nameParts[3];
              const entryGroup = nameParts[5];
              const entry = nameParts[7];
              
              const res = await this._catalog.deleteEntry(project, location, entryGroup, entry);
              if (res.status !== 200) {
                 return { success: false, details: `Failed to delete entry ${localName}: ${res.message || res.status}` };
              }
              state.deleteEntry(localName);
           }
           continue;
        }

        const entry = await this._snapshot._fetchEntry(localName);
        if (!entry) continue;
        
        const mdEntry = toLocalEntry(entry, localName);
        const rawLocalEntry = await this._snapshot.lookupEntry(localName);

        const stateEntry = state.getEntry(localName);
        const nameParts = entry.name.split('/');
        const project = nameParts[1];
        const location = nameParts[3];

        const existRes = await this._catalog.lookupEntry(project, location, entry.name, [...this._snapshot.aspectTypes.keys()]);
        const entryExists = existRes.status === 200 && !!existRes.result;

        if (!entryExists) {
            if (options.dryRun) {
                console.log(`[Dry Run] Would create entry ${localName}`);
            } else {
                const entryGroup = nameParts[5];
                const entryId = nameParts.slice(7).join('/');
                const createEntryRes = await this._catalog.createEntry(project, location, entryGroup, entryId, entry);
                if (createEntryRes.status != 200 || !createEntryRes.result) {
                    return { success: false, details: `Failed to create entry ${entry.name}: ${createEntryRes.message || createEntryRes.status}` };
                }
            }
            
            if (!options.dryRun) {
                const localAspectChecksums: Record<string, string> = {};
                if (mdEntry.aspects) {
                    for (const [k, v] of Object.entries(mdEntry.aspects)) {
                        localAspectChecksums[k] = calculateAspectChecksum(v);
                    }
                }
                state.updateEntry(localName, {
                    entryChecksum: calculateEntryChecksum(mdEntry),
                    lastSyncTime: new Date().toISOString(),
                    aspects: localAspectChecksums
                });
            }
            continue;
        }

        let remoteEntry: md.Entry | null = null;
        const res = await this._catalog.lookupEntry(project, location, entry.name, [...this._snapshot.aspectTypes.keys()]);
        if (res.status === 200 && res.result) {
           remoteEntry = toLocalEntry(res.result, localName);
        }

        const aspectsToPush: string[] = [];
        const localAspectChecksums: Record<string, string> = {};
        const newBaseAspectChecksums: Record<string, string> = { ...stateEntry?.aspects };
        let conflictDetected = false;

        let skipEntry = false;
        if (!stateEntry && remoteEntry) {
            if (!options.force) {
                conflictDetected = true;
                if (options.dryRun && !options.allowPartial) {
                    console.log(`[Dry Run] Conflict: ${localName} already exists remotely (would abort push)`);
                    continue;
                }
                if (!options.allowPartial) {
                    return { success: false, details: `Cannot push: conflict on ${localName}. It already exists remotely. Use --force to overwrite.` };
                }
                if (options.dryRun) {
                    console.log(`[Dry Run] Partial Push: skipping conflicting entry ${localName}`);
                }
                skipEntry = true;
            }
        }
        
        if (skipEntry) continue;


        if (mdEntry.aspects) {
           for (const [aspectKey, aspectData] of Object.entries(mdEntry.aspects)) {
              const localChecksum = calculateAspectChecksum(aspectData);
              localAspectChecksums[aspectKey] = localChecksum;
              
              if (!stateEntry || stateEntry.aspects?.[aspectKey] !== localChecksum) {
                 // Locally modified aspect
                 let aspectConflict = false;
                 
                 if (remoteEntry && remoteEntry.aspects?.[aspectKey]) {
                     const remoteAspectData = remoteEntry.aspects[aspectKey];
                     const remoteAspectChecksum = calculateAspectChecksum(remoteAspectData);
                     const baseChecksum = stateEntry?.aspects?.[aspectKey];
                     if (remoteAspectChecksum !== baseChecksum) {
                         aspectConflict = true;
                         conflictDetected = true;
                     }
                 }
                 
                 if (aspectConflict) {
                     if (options.dryRun && !options.force && !options.allowPartial) {
                         console.log(`[Dry Run] Conflict: ${localName} aspect ${aspectKey} was modified remotely (would abort push)`);
                         continue;
                     }
                     if (!options.force && !options.allowPartial) {
                         return { success: false, details: `Cannot push: conflict on ${localName} aspect ${aspectKey}. Use --force to overwrite or --allow-partial to skip.` };
                     }
                     if (!options.force && options.allowPartial) {
                         if (options.dryRun) {
                             console.log(`[Dry Run] Partial Push: skipping conflicting aspect ${aspectKey} on ${localName}`);
                         } else {
                             const remoteAspectData = remoteEntry!.aspects?.[aspectKey];
                             if (remoteAspectData) {
                                 newBaseAspectChecksums[aspectKey] = calculateAspectChecksum(remoteAspectData);
                             } else {
                                 delete newBaseAspectChecksums[aspectKey];
                             }
                         }
                         continue;
                     }
                 }
                 
                 aspectsToPush.push(aspectKey);
              }
           }
        }

        if (stateEntry?.aspects) {
           for (const [aspectKey, baseChecksum] of Object.entries(stateEntry.aspects)) {
              if (!mdEntry.aspects || !(aspectKey in mdEntry.aspects)) {
                 if (rawLocalEntry.aspects && (aspectKey in rawLocalEntry.aspects)) {
                     // Filtered out by publishing configuration, not actually deleted
                     continue;
                 }
                 
                 let aspectConflict = false;
                 
                 if (remoteEntry && remoteEntry.aspects?.[aspectKey]) {
                     const remoteAspectData = remoteEntry.aspects[aspectKey];
                     const remoteAspectChecksum = calculateAspectChecksum(remoteAspectData);
                     if (remoteAspectChecksum !== baseChecksum) {
                         aspectConflict = true;
                         conflictDetected = true;
                     }
                 }
                 
                 if (aspectConflict) {
                     if (options.dryRun && !options.force && !options.allowPartial) {
                         console.log(`[Dry Run] Conflict: ${localName} aspect ${aspectKey} was modified remotely (would abort push)`);
                         continue;
                     }
                     if (!options.force && !options.allowPartial) {
                         return { success: false, details: `Cannot push: conflict on ${localName} aspect ${aspectKey}. Use --force to overwrite or --allow-partial to skip.` };
                     }
                     if (!options.force && options.allowPartial) {
                         if (options.dryRun) {
                             console.log(`[Dry Run] Partial Push: skipping conflicting aspect ${aspectKey} on ${localName}`);
                         } else {
                             const remoteAspectData = remoteEntry!.aspects?.[aspectKey];
                             if (remoteAspectData) {
                                 newBaseAspectChecksums[aspectKey] = calculateAspectChecksum(remoteAspectData);
                             } else {
                                 delete newBaseAspectChecksums[aspectKey];
                             }
                         }
                         continue;
                     }
                 }
                 
                 aspectsToPush.push(aspectKey);
              }
           }
        }

        if (aspectsToPush.length > 0 || change.status === 'Created' || change.status === 'Modified') {
           if (options.dryRun) {
               console.log(`[Dry Run] Would push ${localName} with aspects: ${aspectsToPush.join(', ')}`);
           } else {
               const updateMask = [];
               if (aspectsToPush.length > 0) updateMask.push('aspects');
               if (!this._snapshot.manifest.source.ingestedEntries && entry.entrySource) updateMask.push('entry_source');
               
               const tempAspects = entry.aspects;
               const filteredAspects: Record<string, any> = {};
               for (const k of aspectsToPush) {
                  if (tempAspects && tempAspects[k]) filteredAspects[k] = tempAspects[k];
               }
               entry.aspects = filteredAspects;
               
               const res = await this._catalog.modifyEntry(project, location, entry, updateMask, aspectsToPush);
               entry.aspects = tempAspects;
               
               if (res.status !== 200 || !res.result) {
                 return { success: false, details: `Failed to update entry ${localName}: ${res.message || res.status}` };
               }
               
               for (const k of aspectsToPush) {
                   if (localAspectChecksums[k] !== undefined) {
                       newBaseAspectChecksums[k] = localAspectChecksums[k];
                   } else {
                       delete newBaseAspectChecksums[k];
                   }
               }
           }
        }
        
        if (!options.dryRun) {
            state.updateEntry(localName, {
               entryChecksum: calculateEntryChecksum(mdEntry),
               lastSyncTime: new Date().toISOString(),
               aspects: newBaseAspectChecksums
            });
        }
      }

      if (!options.dryRun) {
          state.save();
      }
      return { success: true };
    }
    catch (e: any) {
      return { success: false, details: e.message };
    }
    finally {
      if (!options.dryRun) {
          await state.unlock();
      }
    }
  }

  async validate(): Promise<ValidationResult> {
    throw new Error('Not yet implemented');
  }

  async status(): Promise<StatusResult> {
    const state = new CatalogState(this._snapshot.basePath);
    state.load();

    const localEntries = await this._snapshot.listEntries();
    const stateEntries = state.listEntries();

    const allEntries = new Set([...localEntries, ...stateEntries]);
    const changes: StatusResult['changes'] = [];
    let modified = false;

    for (const name of allEntries) {
      const inLocal = localEntries.includes(name);
      const inState = stateEntries.includes(name);

      if (inLocal && !inState) {
        changes.push({ name, status: 'Created' });
        modified = true;
      } else if (!inLocal && inState) {
        changes.push({ name, status: 'Deleted' });
        modified = true;
      } else {
        const localEntry = await this._snapshot.lookupEntry(name);
        const stateEntry = state.getEntry(name);
        
        let isModified = false;
        
        if (localEntry && stateEntry) {
           const localChecksum = calculateEntryChecksum(localEntry);
           if (localChecksum !== stateEntry.entryChecksum) {
               isModified = true;
           }
        }
        
        if (isModified) {
           changes.push({ name, status: 'Modified' });
           modified = true;
        } else {
           changes.push({ name, status: 'Unchanged' });
        }
      }
    }

    return { modified, changes };
  }
}
