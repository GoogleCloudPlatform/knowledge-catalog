// Reading a `tools.yaml` into the shape model.ts describes.
//
// Mechanical only: no mapping decisions are made here, so a reader checking the
// import against Toolbox's own loader can read this file alone.
//
// Toolbox accepts two spellings of the same configuration and normalizes one
// into the other before parsing (`cmd/internal/config.go:200`,
// `ConvertConfig`):
//
//   nested                              flat (one YAML document per object)
//   ------------------------------      ------------------------------------
//   tools:                              kind: tool
//     search_flights:                   name: search_flights
//       kind: postgres-sql              type: postgres-sql
//       source: pg                      source: pg
//
// The two differ in more than layout: the nested form writes the concrete type
// under `kind`, and the flat form writes it under `type`, with `kind` naming
// the primitive instead. Real configurations in the wild are mostly nested, and
// the shipped prebuilt ones are flat, so both are read here -- normalizing to
// the flat reading, exactly as Toolbox does.

import * as yaml from 'yaml';

import {ToolboxAnnotations, ToolboxConfig, ToolboxParameter, ToolboxSource, ToolboxTool,} from './model';

/** The outcome of reading a configuration. */
export interface ParseResult {
  config: ToolboxConfig;
  /** Documents that were read but are not part of the import. */
  warnings: string[];
}

// The nested top-level keys and the primitive each one produces, from
// `cmd/internal/config.go:264-283`. `toolsets` produces a group because Toolbox
// migrates it to one at load (`migrateToolsetKind`), dropping its description.
const NESTED_KINDS: ReadonlyMap<string, string> = new Map([
  ['sources', 'source'],
  ['authServices', 'authService'],
  ['embeddingModels', 'embeddingModel'],
  ['tools', 'tool'],
  ['toolsets', 'toolset'],
  ['prompts', 'prompt'],
  ['resources', 'resource'],
  ['resourceTemplates', 'resourceTemplate'],
  ['groups', 'group'],
]);

/**
 * Reads one or more `tools.yaml` texts into a single configuration.
 *
 * Several texts are merged the way Toolbox merges several `--config` files:
 * names are global, and a later definition of the same name replaces an
 * earlier one rather than failing, because an importer reading somebody's
 * config directory should report what it found rather than refuse it.
 *
 * Throws only on YAML that will not parse. A document the importer does not
 * consume is a warning.
 */
export function parseToolboxConfig(texts: string[]): ParseResult {
  const warnings: string[] = [];
  const config: ToolboxConfig = {sources: [], tools: [], groups: []};

  for (const text of texts) {
    for (const doc of yaml.parseAllDocuments(text)) {
      const value = doc.toJS();
      if (value === null || typeof value !== 'object') continue;
      for (const flat of flatten(value, warnings)) {
        absorb(config, flat, warnings);
      }
    }
  }
  return {config, warnings};
}

// One document as the flat form sees it: a `kind`, a `name`, and the body.
interface FlatDoc {
  kind: string;
  name?: string;
  body: Record<string, any>;
}

// Turns one YAML document into the flat documents it stands for: itself if it
// already declares a `kind`, otherwise one per entry of each nested key.
function* flatten(doc: any, warnings: string[]): Generator<FlatDoc> {
  if (typeof doc.kind === 'string') {
    const {kind, name, ...body} = doc;
    yield {kind, name, body};
    return;
  }
  for (const [key, value] of Object.entries(doc)) {
    const kind = NESTED_KINDS.get(key);
    if (!kind) {
      warnings.push(
          `ignored top-level key '${key}': not a Toolbox configuration key`);
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    for (const [name, entry] of Object.entries(value as Record<string, any>)) {
      // A nested body writes the concrete type under `kind`; the flat form
      // writes it under `type`. Rename it, as ConvertConfig's processValue
      // does, so everything downstream reads one spelling.
      const body: Record<string, any> =
          entry && typeof entry === 'object' && !Array.isArray(entry) ?
          {...entry} :
          {};
      if (typeof body['kind'] === 'string' && body['type'] === undefined) {
        body['type'] = body['kind'];
      }
      delete body['kind'];
      // A toolset written as a bare list of tool names.
      if (Array.isArray(entry)) body['tools'] = entry;
      yield {kind, name, body};
    }
  }
}

// Files one flat document into the configuration, or warns that it was skipped.
function absorb(config: ToolboxConfig, doc: FlatDoc, warnings: string[]): void {
  switch (doc.kind) {
    case 'source':
      replace(config.sources, readSource(doc));
      return;
    case 'tool':
      replace(config.tools, readTool(doc));
      return;
    case 'toolset':
    case 'group':
      // A group is read for its name and membership only. Its cache hints are
      // MCP transport settings with nothing to say about the domain.
      replace(config.groups, {
        name: doc.name,
        description: str(doc.body['description']),
        tools: strings(doc.body['tools']),
      });
      return;
    default:
      warnings.push(
          `ignored '${doc.kind}' document${
              doc.name ? ` '${doc.name}'` : ''}: the importer reads sources, ` +
          `tools and groups`);
  }
}

function readSource(doc: FlatDoc): ToolboxSource {
  const b = doc.body;
  return {
    name: doc.name ?? '',
    type: str(b['type']) ?? '',
    project: str(b['project']),
    location: str(b['location']),
    region: str(b['region']),
    cluster: str(b['cluster']),
    instance: str(b['instance']),
    database: str(b['database']),
    dataset: str(b['dataset']),
    host: str(b['host']),
    port: b['port'] == null ? undefined : String(b['port']),
    dialect: str(b['dialect']),
    readOnly: typeof b['readOnly'] === 'boolean' ? b['readOnly'] : undefined,
    writeMode: str(b['writeMode']),
  };
}

function readTool(doc: FlatDoc): ToolboxTool {
  const b = doc.body;
  return {
    name: doc.name ?? '',
    type: str(b['type']) ?? '',
    description: str(b['description']),
    source: str(b['source']),
    statement: str(b['statement']),
    parameters: readParameters(b['parameters']),
    templateParameters: readParameters(b['templateParameters']),
    annotations: readAnnotations(b['annotations']),
    readOnly: typeof b['readOnly'] === 'boolean' ? b['readOnly'] : undefined,
    authRequired: strings(b['authRequired']),
  };
}

function readParameters(value: unknown): ToolboxParameter[] {
  if (!Array.isArray(value)) return [];
  const out: ToolboxParameter[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, any>;
    out.push({
      name: str(e['name']) ?? '',
      type: str(e['type']) ?? '',
      description: str(e['description']),
      // Toolbox's `required` is a *bool defaulting to true, so only an explicit
      // `false` makes a parameter optional.
      required: typeof e['required'] === 'boolean' ? e['required'] : undefined,
      default: e['default'],
      allowedValues: Array.isArray(e['allowedValues']) ? e['allowedValues'] :
                                                         undefined,
      excludedValues: Array.isArray(e['excludedValues']) ? e['excludedValues'] :
                                                           undefined,
      authServices: Array.isArray(e['authServices']) ?
          e['authServices']
              .filter((a: any) => a && typeof a === 'object')
              .map((a: any) => ({
                     name: str(a['name']) ?? '',
                     field: str(a['field']) ?? '',
                   })) :
          undefined,
      valueFromParam: str(e['valueFromParam']),
      embeddedBy: str(e['embeddedBy']),
      secure: typeof e['secure'] === 'boolean' ? e['secure'] : undefined,
      items: e['items'] && typeof e['items'] === 'object' ?
          readParameters([e['items']])[0] :
          undefined,
      valueType: str(e['valueType']),
    });
  }
  return out;
}

function readAnnotations(value: unknown): ToolboxAnnotations|undefined {
  if (!value || typeof value !== 'object') return undefined;
  const a = value as Record<string, any>;
  const pick = (key: string) =>
      typeof a[key] === 'boolean' ? (a[key] as boolean) : undefined;
  return {
    readOnlyHint: pick('readOnlyHint'),
    destructiveHint: pick('destructiveHint'),
    idempotentHint: pick('idempotentHint'),
    openWorldHint: pick('openWorldHint'),
  };
}

// Replaces an entry of the same name, or appends.
function replace<T extends {name?: string}>(list: T[], item: T): void {
  const at = list.findIndex((e) => e.name === item.name);
  if (at >= 0)
    list[at] = item;
  else
    list.push(item);
}

function str(value: unknown): string|undefined {
  return typeof value === 'string' ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}
