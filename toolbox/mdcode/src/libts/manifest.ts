// Implements support for creating and loading catalog manifests.
//

import * as fs from 'node:fs';
import * as yaml from 'yaml';
import * as z from 'zod';
import * as gcp from './gcp';
import { CatalogSource, createSource, Sources } from './source';


const manifestSchema = z.object({
  scope: z.union([z.string(), z.array(z.string())]),
  snapshot: z.object({
    entries: z.array(z.string()).optional(),
    aspects: z.array(z.string()).optional()
  }).optional(),
  publishing: z.object({
    entries: z.array(z.string()).optional(),
    aspects: z.array(z.string()).optional()
  }).optional(),
});

export interface SnapshotConfig {
  entries?: string[];
  aspects?: string[];
}

export interface PublishingConfig {
  entries?: string[];
  aspects?: string[];
}

export interface Scope {
  type: string;
  name: string;
}


export class CatalogManifest {
  readonly source: CatalogSource;
  readonly snapshotConfig?: SnapshotConfig;
  readonly publishingConfig?: PublishingConfig;

  private constructor(
    source: CatalogSource,
    snapshotConfig?: SnapshotConfig,
    publishingConfig?: PublishingConfig
  ) {
    this.source = source;
    this.snapshotConfig = snapshotConfig;
    this.publishingConfig = publishingConfig;
  }

  static async initWithEntryGroup(name: string, ctx: gcp.ApiContext): Promise<CatalogManifest> {
    const source = await createSource(Sources.ENTRYGROUP, name, ctx);
    return new CatalogManifest(source);
  }

  static async initWithBigQuery(dataset: string, ctx: gcp.ApiContext): Promise<CatalogManifest> {
    const source = await createSource(Sources.BIGQUERY_DATASET, dataset, ctx);
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
          throw new Error(`Manifest error: only BigQuery datasets are allowed in multiple scopes. Found type '${type}'.`);
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
    }

    return new CatalogManifest(source, snapshot, publishing);
  }

  save(path: string): void {
    let scope: string | string[];
    if (this.source.type === Sources.BIGQUERY_DATASET) {
      const names = this.source.name.split(',');
      if (names.length > 1) {
        scope = names.map(n => `${Sources.BIGQUERY_DATASET}.${n}`);
      }
      else {
        scope = `${this.source.type}.${this.source.name}`;
      }
    }
    else {
      scope = `${this.source.type}.${this.source.name}`;
    }

    const data: any = {
      scope: scope,
    };
    if (this.snapshotConfig) {
      data.snapshot = this.snapshotConfig;
    }
    if (this.publishingConfig) {
      data.publishing = this.publishingConfig;
    }
    fs.writeFileSync(path, yaml.stringify(data), 'utf8');
  }
}
