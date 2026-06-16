// Implements support for creating and loading catalog manifests.
//

import * as fs from 'node:fs';
import * as yaml from 'yaml';
import * as z from 'zod';
import * as gcp from './gcp';
import { CatalogSource, createSource, Sources } from './source';


export function resolveEntryLinkType(
  typeRef: string
): string {
  let fullLink = typeRef;
  if (fullLink.split('.').length === 1) {
    fullLink = `dataplex-types.global.${fullLink}`;
  }
  return fullLink;
}

export function findAliasForType(
  typeRef: string
): string {
  return typeRef.replace(/^655216118709\./, 'dataplex-types.');
}

export function findAspectAliasForType(
  typeRef: string,
  manifest?: CatalogManifest
): string {
  if (manifest?.aliases) {
    for (const [alias, config] of Object.entries(manifest.aliases)) {
      if (config.aspect === typeRef) {
        return alias;
      }
    }
  }

  let cleanRef = typeRef.replace(/^655216118709\./, 'dataplex-types.');
  if (cleanRef.startsWith('dataplex-types.global.')) {
    return cleanRef.substring('dataplex-types.global.'.length);
  }
  if (cleanRef.startsWith('dataplex-types.')) {
    return cleanRef.substring('dataplex-types.'.length);
  }
  return cleanRef;
}

export function resolveAspectAlias(
  alias: string,
  manifest?: CatalogManifest
): string {
  if (manifest?.aliases?.[alias]?.aspect) {
    return manifest.aliases[alias].aspect!;
  }
  let fullAspect = alias;
  if (fullAspect.split('.').length === 1) {
    fullAspect = `dataplex-types.global.${fullAspect}`;
  }
  return fullAspect;
}

const manifestSchema = z.object({
  scope: z.union([z.string(), z.array(z.string())]),
  aliases: z.record(z.string(), z.object({
    aspect: z.string().optional(),
    glossary: z.string().optional()
  })).optional(),
  resourceAliases: z.record(z.string(), z.object({
    aspect: z.string().optional(),
    glossary: z.string().optional()
  })).optional(),
  snapshot: z.object({
    entries: z.array(z.string()).optional(),
    aspects: z.array(z.string()).optional(),
    entryLinks: z.array(z.string()).optional()
  }).optional(),
  publishing: z.object({
    entries: z.array(z.string()).optional(),
    aspects: z.array(z.string()).optional(),
    entryLinks: z.array(z.string()).optional()
  }).optional(),
});

export interface SnapshotConfig {
  entries?: string[];
  aspects?: string[];
  entryLinks?: string[];
}

export interface PublishingConfig {
  entries?: string[];
  aspects?: string[];
  entryLinks?: string[];
}

export interface Scope {
  type: string;
  name: string;
}


export class CatalogManifest {
  readonly source: CatalogSource;
  readonly snapshotConfig?: SnapshotConfig;
  readonly publishingConfig?: PublishingConfig;
  readonly aliases?: Record<string, { aspect?: string; glossary?: string }>;

  private constructor(
    source: CatalogSource,
    snapshotConfig?: SnapshotConfig,
    publishingConfig?: PublishingConfig,
    aliases?: Record<string, { aspect?: string; glossary?: string }>
  ) {
    this.source = source;
    this.snapshotConfig = snapshotConfig;
    this.publishingConfig = publishingConfig;
    this.aliases = aliases;
  }

  static async initWithEntryGroup(name: string, ctx: gcp.ApiContext): Promise<CatalogManifest> {
    const source = await createSource(Sources.ENTRYGROUP, name, ctx);
    return new CatalogManifest(source);
  }

  static async initWithBigQuery(dataset: string, ctx: gcp.ApiContext): Promise<CatalogManifest> {
    const source = await createSource(Sources.BIGQUERY_DATASET, dataset, ctx);
    return new CatalogManifest(source);
  }

  static async initWithKnowledgeBase(name: string, ctx: gcp.ApiContext): Promise<CatalogManifest> {
    const source = await createSource(Sources.KB, name, ctx);
    return new CatalogManifest(source);
  }

  static async load(path: string, ctx: gcp.ApiContext): Promise<CatalogManifest> {
    const content = fs.readFileSync(path, 'utf8');
    const parsed = yaml.parse(content);
    
    const result = manifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Manifest error: ${result.error.message}`);
    }
    
    const scope = result.data.scope;
    let source: CatalogSource;
    if (Array.isArray(scope)) {
      if (scope.length === 0) {
        throw new Error('Manifest error: scope array cannot be empty.');
      }

      const datasets: string[] = [];
      for (const s of scope) {
        const dotIndex = s.indexOf('.');
        if (dotIndex === -1) {
          throw new Error(`Manifest error: scope '${s}' is invalid.`);
        }
        const type = s.substring(0, dotIndex);
        const name = s.substring(dotIndex + 1);
        if (type !== Sources.BIGQUERY_DATASET) {
          throw new Error(`Manifest error: Unsupported scope type in multiple scopes: '${type}'.`);
        }
        datasets.push(name);
      }

      source = await createSource(Sources.BIGQUERY_DATASET, datasets.join(','), ctx);
    }
    else {
      const dotIndex = scope.indexOf('.');
      if (dotIndex === -1) {
        throw new Error(`Manifest error: scope '${scope}' is invalid.`);
      }
      source = await createSource(
        scope.substring(0, dotIndex),
        scope.substring(dotIndex + 1),
        ctx
      );
    }

    const aliases: Record<string, { aspect?: string; glossary?: string }> = {
      ...result.data.resourceAliases,
      ...result.data.aliases
    };

    const snapshot = result.data.snapshot;
    if (snapshot) {
      if (snapshot.entries) {
        for (const entryType of snapshot.entries) {
          const parts = entryType.split('.');
          if (parts.length !== 3) {
            throw new Error(`Manifest error: Invalid Entry Type '${entryType}'`);
          }
        }
      }

      if (snapshot.aspects) {
        for (const aspectType of snapshot.aspects) {
          const parts = aspectType.split('.');
          if (parts.length !== 3) {
            throw new Error(`Manifest error: Invalid Aspect Type '${aspectType}'`);
          }
        }
      }

      if (snapshot.entryLinks) {
        for (const entryLinkType of snapshot.entryLinks) {
          const resolved = resolveEntryLinkType(entryLinkType);
          const parts = resolved.split('.');
          if (parts.length !== 3) {
            throw new Error(`Manifest error: Invalid EntryLink Type '${entryLinkType}'`);
          }
        }
      }
    }

    const publishing = result.data.publishing;
    if (publishing) {
      if (publishing.entries) {
        for (const entryType of publishing.entries) {
          const parts = entryType.split('.');
          if (parts.length !== 3) {
            throw new Error(`Manifest error: Invalid Entry Type '${entryType}'`);
          }
          if (!snapshot?.entries?.includes(entryType)) {
            throw new Error(
              `Manifest error: Publishing entry type '${entryType}' is not listed in snapshot entries.`
            );
          }
        }
      }

      if (publishing.aspects) {
        for (const aspectType of publishing.aspects) {
          const parts = aspectType.split('.');
          if (parts.length !== 3) {
            throw new Error(`Manifest error: Invalid Aspect Type '${aspectType}'`);
          }
          if (!snapshot?.aspects?.includes(aspectType)) {
            throw new Error(
              `Manifest error: Publishing aspect type '${aspectType}' is not listed in snapshot aspects.`
            );
          }
        }
      }

      if (publishing.entryLinks) {
        for (const entryLinkType of publishing.entryLinks) {
          const resolved = resolveEntryLinkType(entryLinkType);
          const parts = resolved.split('.');
          if (parts.length !== 3) {
            throw new Error(`Manifest error: Invalid EntryLink Type '${entryLinkType}'`);
          }
          const resolvedSnapshotLinks = snapshot?.entryLinks?.map(link => resolveEntryLinkType(link)) ?? [];
          if (!resolvedSnapshotLinks.includes(resolved)) {
            throw new Error(
              `Manifest error: Publishing entryLink type '${entryLinkType}' is not listed in snapshot entryLinks.`
            );
          }
        }
      }
    }

    return new CatalogManifest(source, snapshot, publishing, Object.keys(aliases).length ? aliases : undefined);
  }

  save(path: string): void {
    let scope: string | string[];
    const names = this.source.name.split(',');
    if (names.length > 1) {
      scope = names.map(n => `${this.source.type}.${n}`);
    }
    else {
      scope = `${this.source.type}.${this.source.name}`;
    }

    const data: any = {
      scope: scope,
      aliases: this.aliases ?? undefined,
      snapshot: this.snapshotConfig ?? undefined,
      publishing: this.publishingConfig ?? undefined
    };
    fs.writeFileSync(path, yaml.stringify(data), 'utf8');
  }
}
