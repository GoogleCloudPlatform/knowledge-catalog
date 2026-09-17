// A parsed MCP Toolbox configuration.
//
// This is the shape of a `tools.yaml` as the importer reads it, kept apart from
// both the YAML mechanics (parse.ts) and the mapping policy (to_ir.ts). It is
// deliberately a SUBSET: Toolbox registers 297 tool types and 49 source types,
// and all but a handful of them wrap an API rather than a statement. What the
// importer needs from any of them is the same five things -- the tool's name,
// its description, the source it runs against, the statement it runs, and the
// parameters that go into the statement -- so the config is read structurally
// (does this document have a `statement`?) rather than by enumerating types.
//
// Field names follow Toolbox's own YAML tags exactly, so a reader can check
// this file against `internal/tools/tools.go` and `internal/util/parameters/
// parameters.go` without a translation step.

/** A `kind: source` document: where the data lives. */
export interface ToolboxSource {
  name: string;
  type: string;
  // Connection and infrastructure coordinates. A source names no tables and no
  // columns, which is the whole reason the importer has to read statements;
  // these are kept because they are what a physical binding needs.
  project?: string;
  location?: string;
  region?: string;
  cluster?: string;
  instance?: string;
  database?: string;
  dataset?: string;
  host?: string;
  port?: string;
  dialect?: string;
  readOnly?: boolean;
  writeMode?: string;
}

/**
 * One `authServices` entry on a parameter: a value taken from a verified
 * claim.
 */
export interface ToolboxParamAuthService {
  name: string;
  field: string;
}

/** A `parameters` or `templateParameters` entry. */
export interface ToolboxParameter {
  name: string;
  // One of string / integer / float / boolean / array / map. Toolbox validates
  // the set; the importer maps what it recognizes and warns on the rest.
  type: string;
  description?: string;
  // Absent means REQUIRED in Toolbox (`GetRequired` defaults a nil pointer to
  // true), which is the opposite of how an absent flag usually reads. The
  // importer normalizes it rather than passing the ambiguity on.
  required?: boolean;
  default?: unknown;
  allowedValues?: unknown[];
  excludedValues?: unknown[];
  authServices?: ToolboxParamAuthService[];
  valueFromParam?: string;
  embeddedBy?: string;
  secure?: boolean;
  items?: ToolboxParameter;
  valueType?: string;
}

/** A tool's MCP annotations. Toolbox exposes the four hints and no title. */
export interface ToolboxAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A `kind: tool` document. */
export interface ToolboxTool {
  name: string;
  type: string;
  description?: string;
  source?: string;
  statement?: string;
  parameters: ToolboxParameter[];
  // Interpolated into the statement as Go text/template BEFORE it is prepared,
  // so these can be identifiers -- a table name, a column list. Kept separate
  // from `parameters` because that difference is what decides whether a tool
  // can become an action at all. See to_ir.ts.
  templateParameters: ToolboxParameter[];
  annotations?: ToolboxAnnotations;
  // A tool-level read-only flag; only `spanner-sql` has one.
  readOnly?: boolean;
  authRequired: string[];
}

/** A `kind: group` document (a `kind: toolset` is folded into one at load). */
export interface ToolboxGroup {
  name?: string;
  description?: string;
  tools: string[];
}

/** A whole configuration, from one file or several merged. */
export interface ToolboxConfig {
  sources: ToolboxSource[];
  tools: ToolboxTool[];
  groups: ToolboxGroup[];
}

/** Looks a source up by the name a tool references. */
export function sourceOf(
    config: ToolboxConfig, tool: ToolboxTool): ToolboxSource|undefined {
  return config.sources.find((s) => s.name === tool.source);
}
