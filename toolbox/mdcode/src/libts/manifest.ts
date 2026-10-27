// Implements support for creating and loading catalog manifests.
//

import * as fs from 'node:fs';
import * as yaml from 'yaml';
import * as z from 'zod';
import * as gcp from './gcp';
import { CatalogSource, createSource, Sources } from './source';


// How a workspace stores its entries on disk, when it is not the layout its
// scope implies (see CatalogSource.layout). `kcmd init --format <layout>`
// records it, and `pull` and `push` read it back, so the choice is made once
// per workspace. Only `okf` exists: the entries as an OKF bundle under
// `bundle/`. A later layout, such as a split workspace that also keeps a
// semantic model under `catalog/`, is a new value here.
export const WORKSPACE_LAYOUTS = ['okf'] as const;
export type WorkspaceLayout = (typeof WORKSPACE_LAYOUTS)[number];

// The scope types a workspace layout may be recorded for.
const LAYOUT_SCOPES: readonly string[] = [Sources.ENTRYGROUP, Sources.KB];

const manifestSchema = z.object({
  scope: z.union([z.string(), z.array(z.string())]),
  // The workspace layout, when it is not the scope's own (see above).
  layout: z.string().optional(),
  // The binding profile a bare `kcmd push` uses when --profile is omitted
  // (semantic-model scope). Omitted means the inline 'default' binding.
  default_profile: z.string().optional(),
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


// The workspace layout a parsed catalog.yaml records, or undefined when it
// records none. Throws naming the problem when the layout is not one kcmd
// supports, or when the scope's type does not take a layout.
export function layoutOf(manifest: any): WorkspaceLayout|undefined {
  const layout = manifest?.layout;
  if (layout === undefined || layout === null) return undefined;
  if (!(WORKSPACE_LAYOUTS as readonly unknown[]).includes(layout)) {
    throw new Error(
        `Manifest error: layout '${layout}' is not supported; the supported ` +
        `layouts are ${WORKSPACE_LAYOUTS.map(l => `'${l}'`).join(', ')}.`);
  }
  const scope = manifest?.scope;
  const type = typeof scope === 'string' ? scope.split('.')[0] : undefined;
  if (type === undefined || !LAYOUT_SCOPES.includes(type)) {
    throw new Error(
        `Manifest error: layout '${layout}' applies only to ` +
        `${LAYOUT_SCOPES.map(s => `'${s}'`).join(' and ')} scopes.`);
  }
  return layout as WorkspaceLayout;
}


// The workspace layout the catalog.yaml at `path` records, read without
// resolving the scope, so that a command can choose its path before any call
// to Knowledge Catalog (the entry group may not exist yet). Undefined when
// there is no catalog.yaml or it records no layout.
export function readWorkspaceLayout(path: string): WorkspaceLayout|undefined {
  if (!fs.existsSync(path)) return undefined;
  return layoutOf(yaml.parse(fs.readFileSync(path, 'utf8')));
}


// Records `layout` in the catalog.yaml at `path`, keeping every other key and
// comment as written.
export function writeWorkspaceLayout(path: string, layout: WorkspaceLayout): void {
  const doc = yaml.parseDocument(fs.readFileSync(path, 'utf8'));
  doc.set('layout', layout);
  fs.writeFileSync(path, doc.toString(), 'utf8');
}


export class CatalogManifest {
  readonly source: CatalogSource;
  readonly snapshotConfig?: SnapshotConfig;
  readonly publishingConfig?: PublishingConfig;
  // The default binding profile for a semantic-model scope (see the schema).
  readonly defaultProfile?: string;
  // The workspace layout, when it is not the scope's own (see the schema).
  readonly layout?: WorkspaceLayout;

  private constructor(
    source: CatalogSource,
    snapshotConfig?: SnapshotConfig,
    publishingConfig?: PublishingConfig,
    defaultProfile?: string,
    layout?: WorkspaceLayout
  ) {
    this.source = source;
    this.snapshotConfig = snapshotConfig;
    this.publishingConfig = publishingConfig;
    this.defaultProfile = defaultProfile;
    this.layout = layout;
  }

  // A manifest for a scope `kcmd init` just named, listing the scope's default
  // aspects under snapshot.aspects.
  private static forNewSource(source: CatalogSource): CatalogManifest {
    const aspects = [...source.defaultAspects];
    return new CatalogManifest(source, aspects.length ? { aspects } : undefined);
  }

  static async initWithEntryGroup(name: string, ctx: gcp.ApiContext): Promise<CatalogManifest> {
    const source = await createSource(Sources.ENTRYGROUP, name, ctx);
    return CatalogManifest.forNewSource(source);
  }

  static async initWithBigQuery(dataset: string, ctx: gcp.ApiContext): Promise<CatalogManifest> {
    const source = await createSource(Sources.BIGQUERY_DATASET, dataset, ctx);
    return CatalogManifest.forNewSource(source);
  }

  static async initWithKnowledgeBase(name: string, ctx: gcp.ApiContext): Promise<CatalogManifest> {
    const source = await createSource(Sources.KB, name, ctx);
    return CatalogManifest.forNewSource(source);
  }

  static async initWithSemanticModel(name: string, ctx: gcp.ApiContext): Promise<CatalogManifest> {
    const source = await createSource(Sources.SEMANTIC_MODEL, name, ctx);
    return CatalogManifest.forNewSource(source);
  }

  static async load(path: string, ctx: gcp.ApiContext): Promise<CatalogManifest> {
    const content = fs.readFileSync(path, 'utf8');
    const parsed = yaml.parse(content);
    
    const result = manifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Manifest error: ${result.error.message}`);
    }
    
    const scope = result.data.scope;
    const layout = layoutOf(result.data);
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

    return new CatalogManifest(
        source, snapshot, publishing, result.data.default_profile, layout);
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
      layout: this.layout ?? undefined,
      default_profile: this.defaultProfile ?? undefined,
      snapshot: this.snapshotConfig ?? undefined,
      publishing: this.publishingConfig ?? undefined
    };
    fs.writeFileSync(path, yaml.stringify(data), 'utf8');
  }
}
