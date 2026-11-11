// Implements support for creating and loading catalog manifests.
//

import * as fs from 'node:fs';
import * as yaml from 'yaml';
import * as z from 'zod';
import * as gcp from './gcp';
import * as dataplex from './gcp/dataplex';
import { CatalogSource, createSource, Sources } from './source';
import { EntryGroupSource } from './sources/entrygroup';
import { KnowledgeBaseSource } from './sources/kb';


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
export function layoutOf(manifest: any): WorkspaceLayout | undefined {
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
export function readWorkspaceLayout(path: string): WorkspaceLayout | undefined {
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


class OfflineEntryGroupSource extends EntryGroupSource {
  override async *entries(_ctx: gcp.ApiContext): AsyncGenerator<gcp.Entry, void, unknown> {}
}

class OfflineKnowledgeBaseSource extends KnowledgeBaseSource {
  override async *entries(_ctx: gcp.ApiContext): AsyncGenerator<gcp.Entry, void, unknown> {}
}


export class CatalogManifest {
  readonly source: CatalogSource;
  readonly snapshotConfig?: SnapshotConfig;
  readonly publishingConfig?: PublishingConfig;
  // The workspace layout, when it is not the scope's own (see the schema).
  readonly layout?: WorkspaceLayout;

  private constructor(
    source: CatalogSource,
    snapshotConfig?: SnapshotConfig,
    publishingConfig?: PublishingConfig,
    layout?: WorkspaceLayout
  ) {
    this.source = source;
    this.snapshotConfig = snapshotConfig;
    this.publishingConfig = publishingConfig;
    this.layout = layout;
  }

  // A manifest for a scope `kcmd init` just named, listing the scope's default
  // aspects under snapshot.aspects.
  private static forNewSource(source: CatalogSource): CatalogManifest {
    const aspects = [...source.defaultAspects];
    return new CatalogManifest(source, aspects.length ? { aspects } : undefined);
  }

  // Constructs a manifest for an EntryGroup or KB that has not been created in
  // Knowledge Catalog yet (used by `kcmd init --format okf` and `kcmd push --dry-run`).
  static forPendingEntryGroup(
    type: Sources.ENTRYGROUP | Sources.KB,
    name: string,
    layout?: WorkspaceLayout,
  ): CatalogManifest {
    const [project, location, entryGroup] = name.split('.');
    if (!project || !location || !entryGroup || name.split('.').length !== 3) {
      throw new Error('EntryGroup must be in format <projectId>.<locationId>.<entryGroupId>');
    }
    const eg: dataplex.EntryGroup = {
      name: dataplex.catalogContainer(project, location, entryGroup),
    };
    const source: CatalogSource =
      type === Sources.KB
        ? new OfflineKnowledgeBaseSource(type, name, eg)
        : new OfflineEntryGroupSource(type, name, eg);
    const aspects = layout === 'okf' ? [] : [...source.defaultAspects];
    return new CatalogManifest(
      source,
      aspects.length ? { aspects } : undefined,
      undefined,
      layout,
    );
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

  static async initWithContextSet(name: string, ctx: gcp.ApiContext): Promise<CatalogManifest> {
    const source = await createSource(Sources.CONTEXT_SET, name, ctx);
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

    return new CatalogManifest(source, snapshot, publishing, layout);
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
      snapshot: this.snapshotConfig ?? undefined,
      publishing: this.publishingConfig ?? undefined
    };
    fs.writeFileSync(path, yaml.stringify(data), 'utf8');
  }
}
