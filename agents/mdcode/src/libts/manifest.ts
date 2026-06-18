// Implements support for creating and loading catalog manifests.
//

import * as fs from 'node:fs';
import * as yaml from 'yaml';
import * as z from 'zod';
import * as gcp from './gcp';
import {ResourceAlias, ResourceType} from './resourcealias';
import {CatalogSource, createSource, Sources} from './source';

export interface LocalEntryLink {
  type: string;
  references: string[];
}

const manifestSchema = z.object({
  scope: z.union([z.string(), z.array(z.string())]),
  // Optional override of the on-disk layout (standard|documents|okf). When
  // absent, the layout is derived from the source type (see source.layout).
  layout: z.string().optional(),
  resourceAlias: z
    .record(z.string(), z.record(z.string(), z.string()))
    .optional(),
  entryLinkTypes: z.array(z.string()).optional(),
  snapshot: z
    .object({
      entries: z.array(z.string()).optional(),
      aspects: z.array(z.string()).optional(),
      entryLinks: z.array(z.string()).optional(),
    })
    .optional(),
  publishing: z
    .object({
      entries: z.array(z.string()).optional(),
      aspects: z.array(z.string()).optional(),
      entryLinks: z.array(z.string()).optional(),
    })
    .optional(),
  reference: z
    .object({
      scope: z.union([z.string(), z.array(z.string())]),
      snapshot: z
        .object({
          entries: z.array(z.string()).optional(),
          aspects: z.array(z.string()).optional(),
          entryLinks: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
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

export interface ReferenceConfig {
  scope: string | string[];
  snapshot?: SnapshotConfig;
}

export class ReferenceManifest {
  readonly source: CatalogSource;
  readonly snapshotConfig?: SnapshotConfig;

  constructor(source: CatalogSource, snapshotConfig?: SnapshotConfig) {
    this.source = source;
    this.snapshotConfig = snapshotConfig;
  }
}

export class CatalogManifest {
  readonly source: CatalogSource;
  readonly context: gcp.ApiContext;
  readonly snapshotConfig?: SnapshotConfig;
  readonly publishingConfig?: PublishingConfig;
  readonly referenceManifest?: ReferenceManifest;
  readonly aliasMap: ResourceAlias;
  readonly entryLinkTypes?: string[];
  // Optional layout override (standard|documents|okf). Mutable so `init` can set
  // it from the `--format` flag before `save()`; `load()` reads it back.
  layout?: string;

  private constructor(
    source: CatalogSource,
    context: gcp.ApiContext,
    aliasMap = new ResourceAlias(),
    snapshotConfig?: SnapshotConfig,
    publishingConfig?: PublishingConfig,
    referenceManifest?: ReferenceManifest,
    entryLinkTypes?: string[],
  ) {
    this.source = source;
    this.context = context;
    this.aliasMap = aliasMap;
    this.snapshotConfig = snapshotConfig;
    this.publishingConfig = publishingConfig;
    this.referenceManifest = referenceManifest;
    this.entryLinkTypes = entryLinkTypes;
  }

  static async initWithEntryGroup(
    name: string,
    ctx: gcp.ApiContext,
  ): Promise<CatalogManifest> {
    const source = await createSource(Sources.ENTRYGROUP, name, ctx);
    return new CatalogManifest(source, ctx);
  }

  static async initWithBigQuery(
    dataset: string,
    ctx: gcp.ApiContext,
  ): Promise<CatalogManifest> {
    const source = await createSource(Sources.BIGQUERY_DATASET, dataset, ctx);
    return new CatalogManifest(source, ctx);
  }

  static async initWithKnowledgeBase(
    name: string,
    ctx: gcp.ApiContext,
  ): Promise<CatalogManifest> {
    const source = await createSource(Sources.KB, name, ctx);
    return new CatalogManifest(source, ctx);
  }

  static async initWithGlossary(
    name: string,
    ctx: gcp.ApiContext,
  ): Promise<CatalogManifest> {
    const source = await createSource(Sources.GLOSSARY, name, ctx);
    return new CatalogManifest(source, ctx);
  }

  static async initWithBigLakeNamespace(
    name: string,
    catalogType: 'iceberg',
    ctx: gcp.ApiContext,
  ): Promise<CatalogManifest> {
    const source = await createSource(
      catalogType === 'iceberg'
        ? Sources.BIGLAKE_ICEBERG_NAMESPACE
        : Sources.BIGLAKE_NAMESPACE,
      name,
      ctx,
    );
    return new CatalogManifest(source, ctx);
  }

  static async parseScope(
    scope: string | string[],
    ctx: gcp.ApiContext,
  ): Promise<CatalogSource> {
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
          throw new Error(
            `Manifest error: Unsupported scope type in multiple scopes: '${type}'.`,
          );
        }
        datasets.push(name);
      }

      source = await createSource(
        Sources.BIGQUERY_DATASET,
        datasets.join(','),
        ctx,
      );
    } else {
      const dotIndex = scope.indexOf('.');
      if (dotIndex === -1) {
        throw new Error(`Manifest error: scope '${scope}' is invalid.`);
      }
      source = await createSource(
        scope.substring(0, dotIndex),
        scope.substring(dotIndex + 1),
        ctx,
      );
    }
    return source;
  }

  static parseAlias(
    aliasList?: Record<string, Record<string, string>>,
  ): ResourceAlias {
    let aliasMap = new ResourceAlias();
    if (aliasList) {
      for (const [alias, resource] of Object.entries(aliasList)) {
        if (Object.keys(resource).length != 1) {
          throw Error(`Alias ${alias} has multiple mappings.`);
        }
        const [resourceType, resourceId] = Object.entries(resource)[0];
        aliasMap.add(alias, resourceType, resourceId);
      }
    }
    return aliasMap;
  }

  static parseSnapshot(
    snapshot?: SnapshotConfig,
    aliasMap?: ResourceAlias,
  ): SnapshotConfig | undefined {
    if (snapshot) {
      if (snapshot.entries) {
        for (const entryType of snapshot.entries) {
          const parts = entryType.split('.');
          if (parts.length !== 3) {
            throw new Error(
              `Manifest error: Invalid Entry Type '${entryType}'`,
            );
          }
        }
      }

      if (snapshot.aspects) {
        for (const aspectType of snapshot.aspects) {
          let formalName = aliasMap
            ? aliasMap.lookupAlias(aspectType, ResourceType.ASPECT)
            : aspectType;
          const parts = formalName.split('.');
          if (parts.length !== 3) {
            throw new Error(
              `Manifest error: Invalid Aspect Type '${aspectType}'`,
            );
          }
        }
      }

      if (snapshot.entryLinks) {
        for (const linkType of snapshot.entryLinks) {
          let formalName = aliasMap
            ? aliasMap.lookupAlias(linkType, ResourceType.ENTRYLINK)
            : linkType;
          const parts = formalName.split('.');
          if (parts.length !== 3) {
            throw new Error(
              `Manifest error: Invalid EntryLink Type '${linkType}'`,
            );
          }
        }
      }
      return snapshot;
    }
    return undefined;
  }

  static parsePublishingConfig(
    snapshot?: SnapshotConfig,
    publishing?: PublishingConfig,
    aliasMap?: ResourceAlias,
  ): PublishingConfig | undefined {
    if (publishing) {
      if (publishing.entries) {
        for (const entryType of publishing.entries) {
          const parts = entryType.split('.');
          if (parts.length !== 3) {
            throw new Error(
              `Manifest error: Invalid Entry Type '${entryType}'`,
            );
          }
          if (!snapshot?.entries?.includes(entryType)) {
            throw new Error(
              `Manifest error: Publishing entry type '${entryType}' is not listed in snapshot entries.`,
            );
          }
        }
      }

      if (publishing.aspects) {
        for (const aspectType of publishing.aspects) {
          let formalName = aliasMap
            ? aliasMap.lookupAlias(aspectType, ResourceType.ASPECT)
            : aspectType;
          const parts = formalName.split('.');
          if (parts.length !== 3) {
            throw new Error(
              `Manifest error: Invalid Aspect Type '${aspectType}'`,
            );
          }
          if (!snapshot?.aspects?.includes(aspectType)) {
            throw new Error(
              `Manifest error: Publishing aspect type '${aspectType}' is not listed in snapshot aspects.`,
            );
          }
        }
      }

      if (publishing.entryLinks) {
        for (const linkType of publishing.entryLinks) {
          let formalName = aliasMap
            ? aliasMap.lookupAlias(linkType, ResourceType.ENTRYLINK)
            : linkType;
          const parts = formalName.split('.');
          if (parts.length !== 3) {
            throw new Error(
              `Manifest error: Invalid EntryLink Type '${linkType}'`,
            );
          }
          if (!snapshot?.entryLinks?.includes(linkType)) {
            throw new Error(
              `Manifest error: Publishing entryLink type '${linkType}' is not listed in snapshot entryLinks.`,
            );
          }
        }
      }
      return publishing;
    }
    return undefined;
  }

  static async parseReference(
    reference: ReferenceConfig | undefined,
    ctx: gcp.ApiContext,
    aliasMap?: ResourceAlias,
  ): Promise<ReferenceManifest | undefined> {
    if (reference) {
      const referenceSource = await this.parseScope(reference.scope, ctx);
      const referenceSnapshot = this.parseSnapshot(
        reference.snapshot,
        aliasMap,
      );
      return new ReferenceManifest(referenceSource, referenceSnapshot);
    }

    return undefined;
  }

  static async load(
    path: string,
    ctx: gcp.ApiContext,
  ): Promise<CatalogManifest> {
    const content = fs.readFileSync(path, 'utf8');
    const parsed = yaml.parse(content);

    const result = manifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Manifest error: ${result.error.message}`);
    }

    const source = await this.parseScope(result.data.scope, ctx);

    const aliasMap = await this.parseAlias(result.data.resourceAlias);

    const snapshot = this.parseSnapshot(result.data.snapshot, aliasMap);

    const publishing = this.parsePublishingConfig(
      snapshot,
      result.data.publishing,
      aliasMap,
    );

    const reference = await this.parseReference(
      result.data.reference,
      ctx,
      aliasMap,
    );

    const entryLinkTypes = result.data.entryLinkTypes;

    const manifest = new CatalogManifest(
      source,
      ctx,
      aliasMap,
      snapshot,
      publishing,
      reference,
      entryLinkTypes,
    );
    manifest.layout = result.data.layout;
    return manifest;
  }

  save(path: string): void {
    let scope: string | string[];
    const names = this.source.name.split(',');
    if (names.length > 1) {
      scope = names.map((n) => `${this.source.type}.${n}`);
    } else {
      scope = `${this.source.type}.${this.source.name}`;
    }

    const data: any = {
      scope: scope,
      layout: this.layout ?? undefined,
      snapshot: this.snapshotConfig ?? undefined,
      publishing: this.publishingConfig ?? undefined,
      entryLinkTypes: this.entryLinkTypes ?? undefined,
    };
    fs.writeFileSync(path, yaml.stringify(data), 'utf8');
  }
}
