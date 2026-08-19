// Implements catalog sync logic for pull and push operations
//

import * as gcp from './gcp';
import { CatalogSnapshot } from './snapshot';

export interface SyncResult {
  success: boolean;
  details?: string;
  // Number of entries the pull could not read because the service returned a
  // non-success status. The Catalog API answers 403 for both "does not exist"
  // and "permission denied", so a skip is ambiguous rather than a clean miss.
  skipped?: number;
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

      // The Catalog API responds with 403 for both "resource does not exist" and
      // "insufficient permission", so a non-200 lookup below is ambiguous: we
      // cannot tell an absent entry from a forbidden one. Rather than silently
      // skip and still report success (which would present an empty or partial
      // snapshot under "Successfully updated"), count the skips and surface them
      // so the outcome is not mistaken for a complete pull.
      let skipped = 0;
      let firstSkipped: string | undefined;

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
          skipped++;
          firstSkipped ??= entry.name;
          continue;
        }

        await this._snapshot._storeEntry(res.result);
      }

      if (skipped) {
        return {
          success: false,
          skipped,
          details: `${skipped} ${skipped === 1 ? 'entry was' : 'entries were'} skipped: `
            + `the Catalog service returned a non-success status (typically 403, which `
            + `it uses for both "not found" and "permission denied"). The local snapshot `
            + `may be incomplete; check your read permission on these entries. `
            + `First skipped: ${firstSkipped}.`,
        };
      }
      return { success: true, skipped: 0 };
    }
    catch (e: any) {
      return { success: false, details: e.message };
    }
  }

  // Pushes local metadata to the Catalog service to publish/deploy it.
  async push(options?: { force?: boolean, validateOnly?: boolean; }): Promise<SyncResult> {
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

      const exist = await this._catalog.lookupEntry(project, location, entry.name);
      if (exist.status != 200 || !exist.result) {
        // The lookup is ambiguous: the Catalog API returns 403 for both "does not
        // exist" and "permission denied", so a non-200 here does not confirm the
        // entry is absent. Attempt the create (the common case is a genuinely new
        // entry), but treat a 409 as proof the entry already exists — which means
        // the lookup's status was a permission problem, not a missing entry.
        // Reporting that as "Failed to create" would point at the wrong problem.
        const entryGroup = nameParts[5];
        const entryId = nameParts.slice(7).join('/');
        const createEntryRes = await this._catalog.createEntry(project, location, entryGroup, entryId, entry);
        if (createEntryRes.status === 409) {
          return { success: false, details: `Entry ${entry.name} already exists but the lookup did not return it (status ${exist.status}${exist.message ? `: ${exist.message}` : ''}); the Catalog API returns 403 for both "not found" and "permission denied", so this usually means you lack read/update permission on the existing entry.` };
        }
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

      if (!updateMask.length) {
        continue;
      }

      const res = await this._catalog.modifyEntry(project, location, entry, updateMask, aspectKeys);
      if (res.status !== 200 || !res.result) {
        return { success: false, details: `Failed to update entry ${name}: ${res.message || res.status}` };
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
