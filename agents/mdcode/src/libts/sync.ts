// Implements catalog sync logic for pull and push operations
//

import * as gcp from './gcp';
import * as crm from './gcp/crm';
import {ResourceType} from './resourcealias';
import {CatalogSnapshot} from './snapshot';

// Glossary, GlossaryCategory, and GlossaryTerm are Dataplex *control-plane*
// resources, not catalog metadata. By policy `kcmd push` never creates them —
// the user must provision the glossary hierarchy in the Dataplex console or
// via `gcloud` first, and only then push catalog metadata that references it.
// Modifying descriptions/labels on EXISTING glossary resources is still
// allowed (handled by `updateGlossary*` further below).
const GLOSSARY_NO_CREATE_NOTICE =
  'kcmd does not create glossary resources. Glossary, GlossaryCategory, and ' +
  'GlossaryTerm are Dataplex control-plane resources that must be created by ' +
  'the user (Dataplex console or `gcloud`) before pushing. See README for ' +
  'rationale.';

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
  private _verifiedEntryGroups: Set<string> = new Set();
  private _verifiedGlossaries: Set<string> = new Set();
  private _verifiedCategories: Set<string> = new Set();

  constructor(catalog: gcp.CatalogClient, snapshot: CatalogSnapshot) {
    this._catalog = catalog;
    this._snapshot = snapshot;
  }

  // Lists metadata in the Catalog service to create or update the local snapshot.
  async pull(options?: {dryRun?: boolean}): Promise<SyncResult> {
    try {
      const resources = this._snapshot.manifest.source.entries(
        this._catalog.context,
      );

      const snapshotLinks = this._snapshot.manifest.snapshotConfig?.entryLinks;
      const hasSnapshotLinks = snapshotLinks && snapshotLinks.length > 0;

      const entryLinkTypes = snapshotLinks?.map((linkTypeAlias) => {
        const linkTypeRef = this._snapshot.manifest.aliasMap.lookupAlias(
          linkTypeAlias,
          ResourceType.ENTRYLINK,
        );
        return gcp._typeRefToName(linkTypeRef, 'entryLink');
      });

      for await (const resource of resources) {
        let fullResource = resource;
        let entryLinks: gcp.EntryLink[] = [];

        if (resource.entryType) {
          if (
            this._snapshot.entryTypes.size &&
            !this._snapshot.entryTypes.has(resource.entryType)
          ) {
            continue;
          }

          // TODO: Need to populate type info if its a type we haven't seen.
          // TODO: Handle local modification conflicts.
          // TODO: Handle config changes or service deletions that require removing local entries.

          const nameParts = resource.name.split('/');
          const res = await this._catalog.lookupEntry(
            nameParts[1],
            nameParts[3],
            resource.name,
            [...this._snapshot.aspectTypes.keys()],
          );
          // The server will respond with 403 permission denied for both resource not exist or
          // insufficient permission. We cannot tell if a resource not exist or user does not
          // have the access. Thus using 200 for an ensured result.
          if (res.status != 200 || !res.result) {
            continue;
          }
          fullResource = res.result;

          if (hasSnapshotLinks) {
            const linksRes = await this._catalog.lookupEntryLinks(
              nameParts[1],
              nameParts[3],
              resource.name,
              entryLinkTypes,
            );
            if (linksRes.status === 200 && linksRes.result?.entryLinks) {
              entryLinks = linksRes.result.entryLinks;
            }
          }
        }

        if (options?.dryRun) {
          console.log(`[DRY-RUN] Pull Resource: ${resource.name}`);
        } else {
          await this._snapshot._storeResource(
            fullResource,
            false,
            entryLinks.length ? entryLinks : undefined,
          );
        }
      }
      return {success: true};
    } catch (e: any) {
      return {success: false, details: e.message};
    }
  }

  async reference(): Promise<SyncResult> {
    try {
      const resources =
        this._snapshot.manifest!.referenceManifest!.source.entries(
          this._catalog.context,
        );

      // Reference pull also fetches entry links when `reference.snapshot.entryLinks`
      // is declared, so `.ref.yaml` files include the pre-enrichment link state.
      // Without this, diffing live `.yaml` (post-enrichment) vs `.ref.yaml`
      // (baseline) would surface every existing link as a fake addition.
      const referenceSnapshotLinks =
        this._snapshot.manifest!.referenceManifest!.snapshotConfig?.entryLinks;
      const hasReferenceSnapshotLinks =
        referenceSnapshotLinks && referenceSnapshotLinks.length > 0;
      const referenceEntryLinkTypes = referenceSnapshotLinks?.map(
        (linkTypeAlias) => {
          const linkTypeRef = this._snapshot.manifest.aliasMap.lookupAlias(
            linkTypeAlias,
            ResourceType.ENTRYLINK,
          );
          return gcp._typeRefToName(linkTypeRef, 'entryLink');
        },
      );

      for await (const resource of resources) {
        let fullResource = resource;
        let entryLinks: gcp.EntryLink[] = [];

        if (resource.entryType) {
          if (
            this._snapshot.referenceEntryTypes.size &&
            !this._snapshot.referenceEntryTypes.has(resource.entryType)
          ) {
            continue;
          }

          const nameParts = resource.name.split('/');
          const res = await this._catalog.lookupEntry(
            nameParts[1],
            nameParts[3],
            resource.name,
            [...this._snapshot.referenceAspectTypes.keys()],
          );
          if (res.status != 200 || !res.result) {
            continue;
          }
          fullResource = res.result;

          if (hasReferenceSnapshotLinks) {
            const linksRes = await this._catalog.lookupEntryLinks(
              nameParts[1],
              nameParts[3],
              resource.name,
              referenceEntryLinkTypes,
            );
            if (linksRes.status === 200 && linksRes.result?.entryLinks) {
              entryLinks = linksRes.result.entryLinks;
            }
          }
        }

        await this._snapshot._storeResource(
          fullResource,
          true,
          entryLinks.length ? entryLinks : undefined,
        );
      }
      return {success: true};
    } catch (e: any) {
      return {success: false, details: e.message};
    }
  }

  // Pushes local metadata to the Catalog service to publish/deploy it.
  async push(options?: {
    force?: boolean;
    validateOnly?: boolean;
    dryRun?: boolean;
  }): Promise<SyncResult> {
    const entries = await this._snapshot.listEntries();

    // Push parents before children. Dataplex `Entry.parent_entry` is IMMUTABLE
    // and is validated to reference an already-existing entry at create time, so
    // any entry whose `resource.parent` points at another entry in this same
    // push must be created AFTER that parent. Entry ids are path-qualified
    // (e.g. a folder `index` entry `a/index` is the parent of both its
    // same-folder leaves `a/m` and its sub-folder index `a/another_folder/index`),
    // so a stable order by (1) path depth ascending, then (2) `index` entries
    // before their same-depth siblings, guarantees every parent is created
    // first. A leaf's parent is the `index` of its OWN directory, which sits at
    // the same depth — hence the index-first tiebreak. This is a pure
    // reordering; independent entries are unaffected.
    const isIndexEntry = (n: string): boolean =>
      n === 'index' || n.endsWith('/index');
    entries.sort((a, b) => {
      const depthDiff = a.split('/').length - b.split('/').length;
      if (depthDiff !== 0) return depthDiff;
      return (isIndexEntry(a) ? 0 : 1) - (isIndexEntry(b) ? 0 : 1);
    });

    const publishingLinks =
      this._snapshot.manifest.publishingConfig?.entryLinks;
    const entryLinkTypes = publishingLinks?.map((linkTypeAlias) => {
      const linkTypeRef = this._snapshot.manifest.aliasMap.lookupAlias(
        linkTypeAlias,
        ResourceType.ENTRYLINK,
      );
      return gcp._typeRefToName(linkTypeRef, 'entryLink');
    });

    for (const name of entries) {
      if (!this._snapshot.isModifiable(name)) {
        continue;
      }

      const resource = await this._snapshot._fetchResource(name);
      if (!resource) {
        // If this was filtered out based on publishing config
        continue;
      }

      // TODO: Track what has changed and do minimal update.
      // TODO: Handle creates and deletes, as well as partial updates.
      // TODO: Handle conflicts.

      const nameParts = resource.name.split('/');
      const project = nameParts[1];
      const location = nameParts[3];

      if (resource.entryType) {
        // Handle Entry push
        const entry = resource as gcp.Entry;
        const exist = await this._catalog.lookupEntry(
          project,
          location,
          entry.name,
        );
        if (exist.status != 200 || !exist.result) {
          if (options?.dryRun) {
            console.log(`[DRY-RUN] Create Entry ${entry.name}`);
          } else {
            console.log(
              `entry ${name} does not exist, will try to create the entry.`,
            );

            const entryGroup = nameParts[5];
            const entryId = nameParts.slice(7).join('/');

            const groupKey = `${project}:${location}:${entryGroup}`;
            if (!this._verifiedEntryGroups.has(groupKey)) {
              const groupRes = await this._catalog.getEntryGroup(
                project,
                location,
                entryGroup,
              );
              if (groupRes.status !== 200 || !groupRes.result) {
                console.log(
                  `Entry group ${entryGroup} does not exist, creating it...`,
                );
                const createGroupRes = await this._catalog.createEntryGroup(
                  project,
                  location,
                  entryGroup,
                );
                if (createGroupRes.status !== 200 || !createGroupRes.result) {
                  return {
                    success: false,
                    details: `Failed to create entry group ${entryGroup}: ${createGroupRes.message || createGroupRes.status}`,
                  };
                }
              }
              this._verifiedEntryGroups.add(groupKey);
            }

            const createEntryRes = await this._catalog.createEntry(
              project,
              location,
              entryGroup,
              entryId,
              entry,
            );
            if (createEntryRes.status != 200 || !createEntryRes.result) {
              console.error(
                `Failed to push entry ${entry.name}: Failed to create new entry.`,
              );
              return {
                success: false,
                details: `Failed to create entry ${entry.name}: ${createEntryRes.message || createEntryRes.status}`,
              };
            }
            console.log(`Successfully created and pushed entry ${entry.name}`);
          }
        } else {
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
              console.log(
                `[DRY-RUN] Modify Entry ${entry.name} (updateMask: ${updateMask.join(',')}, aspects: ${aspectKeys.join(',')})`,
              );
            } else {
              const res = await this._catalog.modifyEntry(
                project,
                location,
                entry,
                updateMask,
                aspectKeys,
              );
              if (res.status !== 200 || !res.result) {
                return {
                  success: false,
                  details: `Failed to update entry ${name}: ${res.message || res.status}`,
                };
              }
            }
          }
        }

        // Update EntryLinks
        const localLinks = await this._snapshot._fetchEntryLinks(name);
        const existingLinksRes = await this._catalog.lookupEntryLinks(
          project,
          location,
          entry.name,
          entryLinkTypes,
        );

        if (existingLinksRes.status === 200 && existingLinksRes.result) {
          const existingLinks = existingLinksRes.result.entryLinks || [];

          // Normalize existing links in place so debug logs and downstream
          // `delete`s see the same project-ID form as the rest of the system.
          for (const existingLink of existingLinks) {
            await gcp._fixEntryLink(existingLink, this._catalog.context);
          }

          // Build comparison keys via the Unwrap-and-Normalize strategy:
          // `toServiceEntryLinks` emits TARGET as `projects/<num>/.../entries/projects/<num>/.../terms/...`
          // while remote links come back with the outer segment as project ID
          // (after `_fixEntryLink`) and the inner segment still in Number form
          // — so a raw string compare always diverges and triggers a spurious
          // DELETE+CREATE every push. Stripping the `@dataplex` proxy shell
          // and normalizing the project segment to ID on both sides makes the
          // two forms compare equal.
          const ctx = this._catalog.context;
          const existingByKey = new Map<string, gcp.EntryLink>();
          for (const el of existingLinks) {
            existingByKey.set(await this._entryLinkKey(el, ctx), el);
          }
          const localByKey = new Map<string, gcp.EntryLink>();
          for (const ll of localLinks) {
            localByKey.set(await this._entryLinkKey(ll, ctx), ll);
          }

          // Delete links that are no longer in local metadata.
          for (const [key, existingLink] of existingByKey) {
            const targetRef = existingLink.entryReferences.find(
              (r) => r.type === 'TARGET',
            )?.name;
            const sourcePath = existingLink.entryReferences.find(
              (r) => r.type === 'SOURCE',
            )?.path;
            if (localByKey.has(key)) {
              console.log(
                `[DEBUG] Existing link to ${targetRef} (path: ${sourcePath}) matches local metadata. Keeping.`,
              );
              continue;
            }
            console.log(
              `[DEBUG] No local match found for existing link to ${targetRef} (path: ${sourcePath}). DELETING.`,
            );
            if (options?.dryRun) {
              console.log(`[DRY-RUN] Delete EntryLink ${existingLink.name}`);
            } else {
              const linkNameParts = existingLink.name.split('/');
              const entryGroup = linkNameParts[5];
              const linkId = linkNameParts[7];
              const res = await this._catalog.deleteEntryLink(
                project,
                location,
                entryGroup,
                linkId,
              );
              console.log(
                `[DEBUG] DELETE EntryLink result: ${res.status} ${res.message || ''}`,
              );
            }
          }

          // Create links that don't exist remotely yet.
          for (const [key, localLink] of localByKey) {
            const targetRef = localLink.entryReferences.find(
              (r) => r.type === 'TARGET',
            )?.name;
            const sourcePath = localLink.entryReferences.find(
              (r) => r.type === 'SOURCE',
            )?.path;
            if (existingByKey.has(key)) {
              // TODO: Support EntryLink updates if aspects differ.
              continue;
            }
            console.log(
              `[DEBUG] No existing match found for local link to ${targetRef} (path: ${sourcePath}). CREATING.`,
            );
            if (options?.dryRun) {
              console.log(
                `[DRY-RUN] Create EntryLink of type ${localLink.entryLinkType}`,
              );
            } else {
              const linkNameParts = entry.name.split('/');
              const entryGroup = linkNameParts[5];
              const linkId =
                'link-' + Math.random().toString(36).substring(2, 12);
              const res = await this._catalog.createEntryLink(
                project,
                location,
                entryGroup,
                linkId,
                localLink,
              );
              console.log(
                `[DEBUG] CREATE EntryLink result: ${res.status} ${res.message || ''}`,
              );
              if (res.status !== 200) {
                throw new Error(
                  `Failed to create EntryLink: ${res.message || res.status}`,
                );
              }
            }
          }
        }
      } else if (resource.name.includes('/terms/')) {
        // Handle GlossaryTerm push
        const term = resource as gcp.GlossaryTerm;
        const glossaryId = nameParts[5];
        const termId = nameParts[7];

        const glossaryKey = `${project}:${location}:${glossaryId}`;
        if (!this._verifiedGlossaries.has(glossaryKey)) {
          const glossaryRes = await this._catalog.getGlossary(
            project,
            location,
            glossaryId,
          );
          if (glossaryRes.status !== 200 || !glossaryRes.result) {
            return {
              success: false,
              details:
                `Parent glossary '${glossaryId}' does not exist in ` +
                `${project}/${location} (required by term ${name}). ` +
                GLOSSARY_NO_CREATE_NOTICE,
            };
          }
          this._verifiedGlossaries.add(glossaryKey);
        }

        // If the term has a category, ensure the category exists
        if (term.parent && term.parent.includes('/categories/')) {
          const catParts = term.parent.split('/');
          const categoryId = catParts[7];
          const categoryKey = `${project}:${location}:${glossaryId}:${categoryId}`;

          if (!this._verifiedCategories.has(categoryKey)) {
            const catRes = await this._catalog.getGlossaryCategory(
              project,
              location,
              glossaryId,
              categoryId,
            );
            if (catRes.status !== 200 || !catRes.result) {
              return {
                success: false,
                details:
                  `Parent category '${categoryId}' does not exist in ` +
                  `glossary '${glossaryId}' (required by term ${name}). ` +
                  GLOSSARY_NO_CREATE_NOTICE,
              };
            }
            this._verifiedCategories.add(categoryKey);
          }
        }

        const exist = await this._catalog.getGlossaryTerm(
          project,
          location,
          glossaryId,
          termId,
        );
        if (exist.status !== 200 || !exist.result) {
          return {
            success: false,
            details:
              `Glossary term '${name}' does not exist. ` +
              GLOSSARY_NO_CREATE_NOTICE,
          };
        } else {
          if (options?.dryRun) {
            console.log(`[DRY-RUN] Update Glossary Term ${name}`);
          } else {
            const res = await this._catalog.updateGlossaryTerm(term);
            if (res.status !== 200 || !res.result) {
              return {
                success: false,
                details: `Failed to update glossary term ${name}: ${res.message || res.status}`,
              };
            }
          }
        }
      } else if (resource.name.includes('/categories/')) {
        // Handle GlossaryCategory push
        const category = resource as gcp.GlossaryCategory;
        const glossaryId = nameParts[5];
        const categoryId = nameParts[7];

        const glossaryKey = `${project}:${location}:${glossaryId}`;
        if (!this._verifiedGlossaries.has(glossaryKey)) {
          const glossaryRes = await this._catalog.getGlossary(
            project,
            location,
            glossaryId,
          );
          if (glossaryRes.status !== 200 || !glossaryRes.result) {
            return {
              success: false,
              details:
                `Parent glossary '${glossaryId}' does not exist in ` +
                `${project}/${location} (required by category ${name}). ` +
                GLOSSARY_NO_CREATE_NOTICE,
            };
          }
          this._verifiedGlossaries.add(glossaryKey);
        }

        const exist = await this._catalog.getGlossaryCategory(
          project,
          location,
          glossaryId,
          categoryId,
        );
        if (exist.status !== 200 || !exist.result) {
          return {
            success: false,
            details:
              `Glossary category '${name}' does not exist. ` +
              GLOSSARY_NO_CREATE_NOTICE,
          };
        } else {
          if (options?.dryRun) {
            console.log(`[DRY-RUN] Update Glossary Category ${name}`);
          } else {
            const res = await this._catalog.updateGlossaryCategory(category);
            if (res.status !== 200 || !res.result) {
              return {
                success: false,
                details: `Failed to update glossary category ${name}: ${res.message || res.status}`,
              };
            }
          }
        }
      } else {
        // Handle Glossary push
        const glossary = resource as gcp.Glossary;
        const glossaryId = nameParts[5];

        const exist = await this._catalog.getGlossary(
          project,
          location,
          glossaryId,
        );
        if (exist.status !== 200 || !exist.result) {
          return {
            success: false,
            details:
              `Glossary '${name}' does not exist. ` + GLOSSARY_NO_CREATE_NOTICE,
          };
        } else {
          if (options?.dryRun) {
            console.log(`[DRY-RUN] Update Glossary ${name}`);
          } else {
            const res = await this._catalog.updateGlossary(glossary);
            if (res.status !== 200 || !res.result) {
              return {
                success: false,
                details: `Failed to update glossary ${name}: ${res.message || res.status}`,
              };
            }
          }
        }
      }
    }

    return {success: true};
  }

  async validate(): Promise<ValidationResult> {
    throw new Error('Not yet implemented');
  }

  async status(): Promise<StatusResult> {
    throw new Error('Not yet implemented');
  }

  // Builds a comparison key for an EntryLink that's stable across the two
  // forms we have to reconcile during push:
  //   - existing remote links: `@dataplex` proxy wrapping intact, outer project
  //     normalized to ID by `_fixEntryLink`, inner project still in Number form.
  //   - local links from `toServiceEntryLinks`: both outer and inner project
  //     in Number form.
  // Unwrapping the proxy shell collapses the outer wrapper so both sides
  // compare on the inner entry, and `crm.fixProject` canonicalizes any
  // project segment to ID. Source path (e.g. `Schema.<field>`) round-trips
  // verbatim and is included to keep field-level links distinct.
  private async _entryLinkKey(
    link: gcp.EntryLink,
    ctx: gcp.ApiContext,
  ): Promise<string> {
    const target = link.entryReferences.find((r) => r.type === 'TARGET');
    const source = link.entryReferences.find((r) => r.type === 'SOURCE');
    const normalizedTarget = target
      ? await crm.fixProject(gcp.unwrapProxyEntry(target.name), ctx)
      : '';
    const normalizedLinkType = await crm.fixProject(link.entryLinkType, ctx);
    return `${normalizedLinkType}|${normalizedTarget}|${source?.path || ''}`;
  }
}
