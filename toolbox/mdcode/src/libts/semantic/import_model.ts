// Imports a third-party (or first-party) semantic model YAML document into a
// valid kcmd semantic model document.

import * as yaml from 'yaml';

import {deploymentTargetError, googleBlockTargetError, googleDeploymentTargets, targetProblem} from './deployment_target';
import {ALLOWED_DIALECTS, isFieldBound, normalizeDataType, ProfileSpec, SemanticModel, SqlDialect} from './ir';
import {bareNameParts, ConstructPlacement, dottedPartProblem, fillForm, FORMAT_VERSION_PLACEMENT, FormatVersion, fromDocument, GOOGLE_VENDOR, GOOGLE_VERSION, hasGoogleBlock, hasUnquotedWhitespace, isAcceptedSource, isFormatVersion, isGoogleCloudForm, isGoogleVendor, isRecord, loadModels, modelAiContexts, NO_SPACE, noSqlReason, oldSourceForm, OSSIE_VERSION, SemanticModelError, TABLE_FORMS, THIRD_PARTY_SOURCE} from './loader';
import {MAX_ENTRY_DESCRIPTION, NameKind, nameProblem} from './names';
import {SerializedFile} from './osi_converter';
import {DEFAULT_PROFILE, loadProfileFile, plainCopy, sourcesDialect} from './resolve_profiles';
import {columnsForSource, entitiesReached} from './sql_expr_utils';
import {loadSqlEngine} from './sql_parser';
import {transpileModel} from './transpile';
import {YAML_OPTIONS} from './yaml_options';
import {linkNodes, parseForUpdate, updateText} from './yaml_update';

/** Options controlling how a semantic model YAML document is imported. */
export interface ImportSemanticModelOptions {
  /**
   * Target output flavor (`'ossie'` or `'google'`); defaults to input flavor.
   */
  flavor?: 'ossie'|'google';
  /**
   * First-party GCP container resource name used to qualify bare table
   * sources.
   */
  sourcePrefix?: string;
  /** When true, translates vendor or double-quoted ANSI SQL to `BIGQUERY`. */
  transpile?: boolean;
  /**
   * When true, treats any third-party repair warning as a hard error, except
   * completing a bare table source from `sourcePrefix`.
   */
  strict?: boolean;
  /**
   * Sibling `<model>.profile.<name>.yaml` files located beside the input file,
   * used when converting a Google-flavor model to vanilla (`'ossie'`).
   */
  profileFiles?: SerializedFile[];
  /**
   * The input file's name. The warning that a JSON input was written as YAML
   * names it. Defaults to `<model>.yaml`.
   */
  fileName?: string;
}

/** Result of importing a semantic model YAML document. */
export interface ImportSemanticModelResult {
  /** True when `errors` is empty and `files` was produced. */
  ok: boolean;
  /**
   * Generated output files (`<model>.yaml` and any
   * `<model>.profile.<name>.yaml` files), or `[]` when `ok` is false.
   */
  files: SerializedFile[];
  /** Non-fatal repair and translation diagnostics. */
  warnings: string[];
  /** Validation or strict-mode errors that prevented file output. */
  errors: string[];
}

/**
 * Parsed representation of a validated `--source-prefix` container resource
 * name.
 */
interface ParsedSourcePrefix {
  base: string;
  known: string[];
  child?: string;
}

/** Mutable representation of a semantic model document during import. */
interface ImportDocument {
  /**
   * The input, or the block YAML a JSON input is rewritten as. Import writes
   * a changed file by changing only the parts of it that change.
   */
  text: string;
  /** `text`, parsed. */
  document: yaml.Document.Parsed;
  /**
   * Maps each object and array in `root` to the node of `document` it copies.
   */
  links: Map<object, yaml.Node>;
  /** Deep-copied root YAML document object. */
  root: Record<string, any>;
  /** First semantic model entry (`root.semantic_model[0]`). */
  model: Record<string, any>;
  /** Dataset/entity objects in `model`. */
  datasets: Record<string, any>[];
  /** Relationship objects in `model`. */
  relationships: Record<string, any>[];
  /** Metric objects in `model`. */
  metrics: Record<string, any>[];
  /**
   * Input document format version (`'0.2.0.dev0'` or `'0.2.0.dev0/google'`).
   */
  inputVersion: FormatVersion;
  /** Target output format version (`'0.2.0.dev0'` or `'0.2.0.dev0/google'`). */
  targetVersion: FormatVersion;
  /** Validated `--source-prefix` container resource name, if supplied. */
  sourcePrefix?: ParsedSourcePrefix;
  /** Whether strict mode (`--input first-party`) is active. */
  strict: boolean;
  /** True when any mutations have been applied to `root`. */
  modified: boolean;
  /** Collected non-fatal warnings. */
  warnings: string[];
  /** Collected validation or strict-mode errors. */
  errors: string[];
  /** Appends `msg` to `errors` in strict mode or `warnings` otherwise. */
  warnOrError: (msg: string) => void;
}

const STANDARD_AI_CONTEXT_KEYS =
    new Set(['instructions', 'synonyms', 'examples']);

// The loader's warning for a source it leaves as written.
const LOADER_SOURCE_WARNING =
    /^(.*?): source '(.*)' is not a valid GCP resource name\.$/s;

// Why no name to write is given when the name holds a quote.
const NO_QUOTE = 'kcmd cannot name a table whose name holds a quote';

// The warning for `source`, which import leaves as written after a run with
// `prefix`, if any. It gives the name to write when the loader names one,
// or another --source-prefix run when a prefix of that kind, or of any kind
// when none ran, completes the name, or else why the table cannot be named.
function sourceWarning(
    ctx: string, source: string, prefix?: ParsedSourcePrefix): string {
  const problem = oldSourceForm(source);
  if (problem !== undefined) {
    return `${ctx}: source '${source}' is ${problem}. 'kcmd push' rejects ` +
        `the file until it is repointed.`;
  }
  const host = prefix?.base.split('/')[0];
  const kinds = SOURCE_PREFIX_PATTERNS.filter(
      k => host === undefined || k.form.startsWith(`${host}/`));
  const bare = !/[/:]/.test(source);
  const rerun = bare && completes(source, kinds);
  const quoted = kinds.some(k => {
    const parts = prefixSegments(source, k.form);
    return !parts.length || parts.some(p => /[`"]/.test(p));
  });
  const cannot = !bare || rerun ? undefined :
      /\s/.test(source)        ? NO_SPACE :
      quoted                   ? NO_QUOTE :
                                 undefined;
  const dotted = !bare || rerun || cannot ?
      undefined :
      kinds.map(k => ({
             form: k.form,
             why: dottedPartProblem(prefixSegments(source, k.form), k.form),
           }))
          .find(d => d.why);
  return `${ctx}: source '${source}' is not a valid GCP resource name` +
      (cannot ? `, and ${cannot}. ` :
           dotted ? `; ${dotted.why}. Write the table's GCP resource name ` +
                   `instead, such as '${dotted.form}'. ` :
                    '; ') +
      `'kcmd push' rejects the file until it is repointed` +
      (rerun ? `, or until 'kcmd import' runs again with '--source-prefix'.` :
               '.') +
      (isGoogleCloudForm(source) ? '' : ` ${THIRD_PARTY_SOURCE}`);
}

const ALLOWED_DIALECT_SET = new Set<string>(ALLOWED_DIALECTS);

const DIALECT_ALIASES: Readonly<Record<string, SqlDialect>> = {
  GOOGLE_SQL: 'BIGQUERY',
  GOOGLESQL: 'BIGQUERY',
  POSTGRESQL: 'POSTGRES',
  TSQL: 'SQLSERVER',
};

// Each kind of --source-prefix: its pattern, the child container a bare name
// adds under it, if any, and the resource name of a table under it.
const SOURCE_PREFIX_PATTERNS:
    ReadonlyArray<{re: RegExp; child?: string; form: string}> = [
  {
    re: /^bigquery\.googleapis\.com\/projects\/([^/]+)$/,
    child: 'datasets',
    form: TABLE_FORMS.bigquery,
  },
  {
    re: /^bigquery\.googleapis\.com\/projects\/([^/]+)\/datasets\/([^/.]+)$/,
    form: TABLE_FORMS.bigquery,
  },
  {
    re: /^biglake\.googleapis\.com\/projects\/([^/]+)\/catalogs\/([^/.]+)$/,
    child: 'namespaces',
    form: TABLE_FORMS.biglake,
  },
  {
    re: /^biglake\.googleapis\.com\/projects\/([^/]+)\/catalogs\/([^/.]+)\/namespaces\/([^/.]+)$/,
    form: TABLE_FORMS.biglake,
  },
  {
    re: /^spanner\.googleapis\.com\/projects\/([^/]+)\/instances\/([^/]+)\/databases\/([^/]+)$/,
    form: TABLE_FORMS.spanner,
  },
  {
    re: /^alloydb\.googleapis\.com\/projects\/[^/]+\/locations\/[^/]+\/clusters\/[^/]+\/databases\/([^/]+)$/,
    child: 'schemas',
    form: TABLE_FORMS.alloydb,
  },
  {
    re: /^alloydb\.googleapis\.com\/projects\/[^/]+\/locations\/[^/]+\/clusters\/[^/]+\/databases\/([^/]+)\/schemas\/([^/]+)$/,
    form: TABLE_FORMS.alloydb,
  },
  {
    re: /^cloudsql\.googleapis\.com\/projects\/[^/]+\/locations\/[^/]+\/instances\/[^/]+\/databases\/([^/]+)$/,
    form: TABLE_FORMS.cloudsql,
  },
  {
    re: /^cloudsql\.googleapis\.com\/projects\/[^/]+\/locations\/[^/]+\/instances\/[^/]+\/databases\/([^/]+)\/schemas\/([^/]+)$/,
    form: TABLE_FORMS.cloudsqlSchema,
  },
];

/** Filters an unknown array down to its plain-object elements. */
function asRecords(v: unknown): Record<string, any>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

/**
 * Returns true if any node in `doc` carries a `GOOGLE` `custom_extensions`
 * block.
 */
function documentHasGoogleBlock(doc: Record<string, any>): boolean {
  for (const m of asRecords(doc.semantic_model)) {
    const nodes = [
      m,
      ...asRecords(m.datasets),
      ...asRecords(m.entities),
      ...asRecords(m.relationships),
      ...asRecords(m.metrics),
      ...asRecords(m.datasets).flatMap(ds => asRecords(ds.fields)),
      ...asRecords(m.entities).flatMap(ds => asRecords(ds.fields)),
    ];
    if (nodes.some(n => hasGoogleBlock(asRecords(n.custom_extensions)))) {
      return true;
    }
  }
  return false;
}

/** Moves non-standard `ai_context` sibling keys into `ai_context.custom`. */
function adaptAiContext(ai: Record<string, unknown>): void {
  const customKeys =
      Object.keys(ai).filter(k => !STANDARD_AI_CONTEXT_KEYS.has(k));
  if (!customKeys.length) return;
  const custom: Record<string, unknown> = {};
  for (const k of customKeys) {
    custom[k] = ai[k];
    delete ai[k];
  }
  ai.custom = custom;
}

/**
 * Phase 1 (Parse): Parses raw YAML, verifies the top-level document envelope,
 * validates `opts.sourcePrefix` when present, refuses a document with a
 * `GOOGLE` block or a Google-flavor model to convert to vanilla unless
 * `strict` is set, and constructs the mutable `ImportDocument` (or returns a
 * fatal error string).
 */
function parseImportDocument(
    rawYaml: string, opts: ImportSemanticModelOptions): ImportDocument|string {
  // 1. Parse raw YAML with strict YAML 1.2 options (`YAML_OPTIONS`) so syntax
  // errors and duplicate keys are caught immediately.
  const {document, text} = parseForUpdate(rawYaml);
  let parsedDoc: unknown;
  try {
    if (document.errors.length > 0) throw document.errors[0];
    parsedDoc = document.toJS();
  } catch (err: any) {
    return `Semantic model load error: could not parse input: ${
        err?.message ?? err}`;
  }

  // 2. Verify the top-level document envelope (`version` is a recognized format
  // version and `semantic_model[0]` is a model object). If malformed, delegate
  // to `loadModels` so the caller receives the loader's canonical schema error.
  if (!isRecord(parsedDoc) || typeof parsedDoc.version !== 'string' ||
      !isFormatVersion(parsedDoc.version) ||
      !Array.isArray(parsedDoc.semantic_model) ||
      !isRecord(parsedDoc.semantic_model[0])) {
    try {
      loadModels(rawYaml, {bindingOptional: true, warnUnacceptedSource: true});
    } catch (err: any) {
      return err?.message ?? String(err);
    }
  }

  // 3. Validate `opts.sourcePrefix` against the 8 supported first-party GCP
  // container resource name patterns before doing any document work.
  let sourcePrefix: ParsedSourcePrefix|undefined;
  if (opts.sourcePrefix !== undefined) {
    const base = opts.sourcePrefix.trim();
    const match = SOURCE_PREFIX_PATTERNS.map(p => ({m: base.match(p.re), p}))
                      .find(x => x.m !== null);
    if (!match?.m) {
      return `Invalid sourcePrefix '${opts.sourcePrefix}'; expected the GCP ` +
          `resource name of a BigQuery project or dataset, a BigLake ` +
          `catalog or namespace, a Spanner database, an AlloyDB database ` +
          `or schema, or a Cloud SQL database or schema (with no leading '//').`;
    }
    sourcePrefix = {base, known: match.m.slice(1), child: match.p.child};
  }

  // 4. Reject a document written for kcmd when `strict` is false: one with a
  // `GOOGLE` block, or a Google-flavor model converting to vanilla.
  const strict = !!opts.strict;
  if (!strict && documentHasGoogleBlock(parsedDoc as Record<string, any>)) {
    return `Document contains a '${GOOGLE_VENDOR}' custom_extensions block ` +
        `(written for kcmd); use '--input first-party' to convert a ` +
        `first-party model.`;
  }
  if (!strict && opts.flavor === 'ossie' &&
      (parsedDoc as Record<string, any>).version === GOOGLE_VERSION) {
    return `Document is a '${GOOGLE_VERSION}' model (written for kcmd); use ` +
        `'--input first-party' to convert it to '${OSSIE_VERSION}'.`;
  }

  // 5. Deep-copy `parsedDoc` via `plainCopy` to decouple shared YAML anchor /
  // alias references before in-place mutations, and assemble `ImportDocument`.
  const root = plainCopy(parsedDoc) as Record<string, any>;
  const model = root.semantic_model[0] as Record<string, any>;
  const inputVersion = root.version as FormatVersion;
  const targetVersion: FormatVersion = opts.flavor ?
      (opts.flavor === 'google' ? GOOGLE_VERSION : OSSIE_VERSION) :
      inputVersion;
  // A model file is YAML, so a JSON file is written as YAML.
  const fileName = opts.fileName ?? `${model.name}.yaml`;
  const warnings =
      text === rawYaml ? [] : [`Converted '${fileName}' to YAML.`];
  const errors: string[] = [];
  return {
    text,
    document,
    links: linkNodes(root, document.contents),
    root,
    model,
    datasets: asRecords(model.entities ?? model.datasets),
    relationships: asRecords(model.relationships),
    metrics: asRecords(model.metrics),
    inputVersion,
    targetVersion,
    sourcePrefix,
    strict,
    modified: false,
    warnings,
    errors,
    warnOrError: (msg: string) => (strict ? errors : warnings).push(msg),
  };
}

/**
 * Extracts the profile name from a `<model>.profile.<name>.yaml` filename (or
 * bare `<name>.yaml` / `<name>` identifier).
 */
function parseProfileName(fileName: string): string {
  const stem = fileName.replace(/^.*[/\\]/, '').replace(/\.ya?ml$/i, '');
  const match = stem.match(/^.+?\.profile(?:\.(.*))?$/i);
  return match ? (match[1] ?? '') : stem;
}

/**
 * Extracts and parses all valid JSON object payloads from `GOOGLE`
 * `custom_extensions` blocks on `exts`, leaving malformed JSON to be reported
 * by `fromDocument`.
 */
function parseGoogleBlocks(exts: unknown): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const b of asRecords(exts)) {
    if (!isGoogleVendor(b.vendor_name) || typeof b.data !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(b.data);
      if (isRecord(parsed)) blocks.push(parsed);
    } catch {
      // Leave malformed JSON to be reported by `fromDocument`.
    }
  }
  return blocks;
}

/**
 * Validates all model, deployment, profile, entity/dataset, field,
 * relationship, and metric names in `doc` (plus any `googleBlocks` and
 * `profileFiles`) in a single pass so every invalid or over-length identifier
 * is reported at once.
 */
function validateObjectNames(
    doc: ImportDocument, googleBlocks: Array<Record<string, unknown>>,
    modelScope: string, profileFiles?: SerializedFile[]): void {
  // Validates a single identifier `name` against `kind`'s rules via
  // `nameProblem` and appends any error to `doc.errors`.
  const validateName = (kind: NameKind, name: unknown, scope?: string) => {
    if (typeof name !== 'string') return;
    const problem = nameProblem(kind, name);
    if (problem) doc.errors.push(scope ? `${scope}: ${problem}` : problem);
  };
  // Validates the `name` property of every record in `records`.
  const validateRecords =
      (kind: NameKind, records: Array<Record<string, unknown>>,
       scope?: string) => {
        for (const record of records) validateName(kind, record.name, scope);
      };

  // 1. Validate model, deployment, and profile names (inline, `GOOGLE` block,
  // and sibling `profileFiles`).
  validateName('model', doc.model.name);
  validateRecords('deployment', asRecords(doc.model.deployments), modelScope);
  validateRecords('profile', asRecords(doc.model.profiles), modelScope);
  for (const g of googleBlocks) {
    validateRecords('deployment', asRecords(g.deployments), modelScope);
    validateRecords('profile', asRecords(g.profiles), modelScope);
  }
  if (doc.targetVersion === OSSIE_VERSION) {
    for (const pf of profileFiles ?? []) {
      validateName('profile', parseProfileName(pf.fileName), modelScope);
    }
  }

  // 2. Validate dataset/entity, field, relationship, and metric names.
  for (const ds of doc.datasets) {
    validateName('entity', ds.name);
    const dsScope =
        typeof ds.name === 'string' ? `dataset '${ds.name}'` : 'dataset';
    validateRecords('field', asRecords(ds.fields), dsScope);
  }
  validateRecords('relationship', doc.relationships);
  validateRecords('metric', doc.metrics);
}

/**
 * Phase 2 (Pre-validation): Validates all identifier names in the input
 * document and any attached `profileFiles`. The loader rejects a model's
 * legacy `deploymentTargets`.
 */
function validateInputDocument(
    doc: ImportDocument, profileFiles?: SerializedFile[]): void {
  const modelScope = typeof doc.model.name === 'string' ?
      `model '${doc.model.name}'` :
      'model';
  const googleBlocks = parseGoogleBlocks(doc.model.custom_extensions);
  validateObjectNames(doc, googleBlocks, modelScope, profileFiles);
}

/**
 * The parts of a bare dot-separated table name `source` as `prefix` reads
 * them, each unquoted and marked when it was quoted, or `undefined` when
 * `source` is not a bare name.
 */
function sourceParts(source: string, prefix: ParsedSourcePrefix):
    Array<{text: string; quoted: boolean}>|undefined {
  // Reject empty strings, already-slashed or colon-prefixed sources, and
  // query-valued sources with unquoted whitespace.
  const trimmed = source.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes(':') ||
      hasUnquotedWhitespace(trimmed)) {
    return undefined;
  }
  const segs = prefixParts(trimmed, prefix.base);
  return segs.length && segs.every(s => s.text.length) ? segs : undefined;
}

/**
 * `text` with its ASCII letters in lower case. PostgreSQL folds only these in a
 * UTF-8 database.
 */
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, c => c.toLowerCase());
}

/** True when the database of `prefix` reads unquoted names in lower case. */
function foldsUnquotedCase(prefix: ParsedSourcePrefix): boolean {
  return prefix.base.startsWith('alloydb.googleapis.com/');
}

/**
 * The first unquoted part of `source` that PostgreSQL reads in lower case and
 * so misses the name with capitals that `prefix` gives it, with the part's
 * kind and both names. Expects a `source` that matches `prefix` when letter
 * case is ignored.
 */
function foldedPart(source: string, prefix: ParsedSourcePrefix):
    {kind: string; name: string; read: string}|undefined {
  const segs = sourceParts(source, prefix);
  if (!segs || !foldsUnquotedCase(prefix)) return undefined;
  const start = prefix.known.length - segs.length + (prefix.child ? 2 : 1);
  for (let i = start; i < prefix.known.length; i++) {
    const s = segs[i - start];
    const read = lowerAscii(s.text);
    // An AlloyDB prefix names a database, then perhaps a schema.
    if (!s.quoted && read !== prefix.known[i]) {
      return {kind: i ? 'schema' : 'database', name: prefix.known[i], read};
    }
  }
  return undefined;
}

/**
 * Qualifies a bare dot-separated table name `source` against `prefix` into a
 * GCP resource name when `prefix` supplies the missing hierarchy segments and
 * any overlapping segments agree, or returns `undefined` if `source` cannot be
 * qualified. Against an AlloyDB prefix, an unquoted segment is read in lower
 * case, as PostgreSQL reads it. With `ignoreCase`, every segment agrees in any
 * letter case.
 */
function qualifyTableSource(
    source: string, prefix: ParsedSourcePrefix, ignoreCase = false): string|
    undefined {
  // Verify that any leading segments overlapping `prefix.known` match.
  const segs = sourceParts(source, prefix);
  if (!segs) return undefined;
  const needed = prefix.child ? 2 : 1;
  const overlap = segs.length - needed;
  if (overlap < 0 || overlap > prefix.known.length) return undefined;
  const foldsCase = foldsUnquotedCase(prefix);
  const read = (s: {text: string; quoted: boolean}) =>
      foldsCase && !s.quoted ? lowerAscii(s.text) : s.text;
  const agrees = (s: {text: string; quoted: boolean}, k: string) =>
      read(s) === k || (ignoreCase && lowerAscii(s.text) === lowerAscii(k));
  const tail = prefix.known.slice(prefix.known.length - overlap);
  if (tail.some((k, i) => !agrees(segs[i], k))) return undefined;

  // Append the remaining child container (if any) and table segment onto
  // `prefix.base` and verify the resulting resource name is accepted.
  const rest = segs.slice(overlap).map(read);
  const qualified = prefix.child ?
      `${prefix.base}/${prefix.child}/${rest[0]}/tables/${rest[1]}` :
      `${prefix.base}/tables/${rest[0]}`;
  return oldSourceForm(qualified) === undefined && isAcceptedSource(qualified) ?
      qualified :
      undefined;
}

// The parts of the bare name `source` as a prefix that begins as `base` does
// reads them, each with whether quotes wrap it. A BigQuery or BigLake prefix
// reads a path in one pair of backticks, such as `` `p.d.t` ``, as its parts.
function prefixParts(source: string, base: string):
    Array<{text: string; quoted: boolean}> {
  return bareNameParts(
      source.trim(), /^(bigquery|biglake)\.googleapis\.com\//.test(base));
}

// The text of each part prefixParts gives.
function prefixSegments(source: string, base: string): string[] {
  return prefixParts(source, base).map(p => p.text);
}

// The prefix of `kind` whose containers are the leading parts of a bare name
// with parts `parts`, or undefined when `kind` has no such prefix.
function prefixFor(
    kind: typeof SOURCE_PREFIX_PATTERNS[number],
    parts: string[]): ParsedSourcePrefix|undefined {
  const base =
      fillForm(kind.form, parts)?.split('/').slice(0, kind.child ? -4 : -2)
          .join('/');
  const known = base?.match(kind.re)?.slice(1);
  return base && known ? {base, known, child: kind.child} : undefined;
}

// True when a --source-prefix of one of `kinds` completes `source`.
function completes(
    source: string, kinds: typeof SOURCE_PREFIX_PATTERNS): boolean {
  return kinds.some(kind => {
    const prefix = prefixFor(kind, prefixSegments(source, kind.form));
    return prefix !== undefined &&
        qualifyTableSource(source, prefix) !== undefined;
  });
}

/**
 * When the output's flavor rejects `obj.datatype`, writes it in its canonical
 * casing, such as `Integer` for `integer`, or deletes an `Opaque` in another
 * casing. The change goes through `warnOrError` when the input's flavor
 * rejects the value too.
 */
function normalizeDatatype(
    obj: Record<string, any>, label: string, doc: ImportDocument): void {
  if (typeof obj.datatype !== 'string' ||
      normalizeDataType(obj.datatype, doc.targetVersion).ok) {
    return;
  }
  const res = normalizeDataType(obj.datatype, GOOGLE_VERSION);
  if (!res.ok) return;
  if (!normalizeDataType(obj.datatype, doc.inputVersion).ok) {
    doc.warnOrError(
        res.type === undefined ?
            `${label}: removed datatype '${obj.datatype}'.` :
            `${label}: rewrote datatype '${obj.datatype}' to '${res.type}'.`);
  }
  if (res.type === undefined) {
    delete obj.datatype;
  } else {
    obj.datatype = res.type;
  }
  doc.modified = true;
}

/**
 * Maps dialect aliases onto the 9 allowed SQL dialects and drops unsupported
 * non-SQL dialects on a field or metric, returning `'empty'` if all dialect
 * entries were dropped.
 */
function normalizeExpressionDialects(
    obj: Record<string, any>, label: string, doc: ImportDocument): 'ok'|
    'empty' {
  if (!isRecord(obj.expression) || !Array.isArray(obj.expression.dialects) ||
      obj.expression.dialects.length === 0) {
    return 'ok';
  }
  const kept: unknown[] = [];
  for (const entry of obj.expression.dialects) {
    if (!isRecord(entry) || typeof entry.dialect !== 'string') {
      kept.push(entry);
      continue;
    }
    const upper = entry.dialect.trim().toUpperCase();
    const mapped = DIALECT_ALIASES[upper] ??
        (ALLOWED_DIALECT_SET.has(upper) ? (upper as SqlDialect) : undefined);
    if (mapped !== undefined) {
      if (entry.dialect !== mapped) {
        doc.warnOrError(
            `${label}: rewrote dialect '${entry.dialect}' to '${mapped}'.`);
        entry.dialect = mapped;
        doc.modified = true;
      }
      kept.push(entry);
    } else {
      doc.warnOrError(
          `${label}: dropped unsupported dialect '${entry.dialect}'.`);
      doc.modified = true;
    }
  }
  obj.expression.dialects = kept;
  return kept.length === 0 ? 'empty' : 'ok';
}

/**
 * Returns why an unanchored metric `mt` is rejected by push's
 * `validateExpressionReferences` (`'reaches no declared entity'` or
 * `'reaches multiple entities (...)'`), or `undefined` when anchored or valid.
 */
function unanchoredMetricProblem(
    mt: Record<string, any>, entityNames: string[],
    impliedDialect?: string): string|undefined {
  // 1. Skip metrics that already declare an `entity` anchor natively or inside
  // a `GOOGLE` `custom_extensions` block.
  if (mt.entity !== undefined ||
      hasGoogleBlock(asRecords(mt.custom_extensions))) {
    return undefined;
  }

  // 2. Collect all SQL dialect expressions on the metric; if none are present
  // or any entry holds no SQL, leave the metric for `loadModels` to diagnose.
  const sources = typeof mt.expression === 'string' ?
      [{text: mt.expression, dialect: 'ANSI_SQL'}] :
      asRecords(mt.expression?.dialects)
          .filter(
              d => typeof d.dialect === 'string' &&
                  typeof d.expression === 'string')
          .map(d => ({text: d.expression, dialect: d.dialect}));
  if (!sources.length ||
      sources.some(s => noSqlReason(s.text, s.dialect) !== undefined)) {
    return undefined;
  }
  const parsed =
      sources.map(s => columnsForSource(s.text, s.dialect, impliedDialect));
  const allColumns = parsed.flatMap(c => c ?? []);

  // 3. Flag the unanchored metric if its parsed expressions reference zero
  // columns (e.g. `COUNT(*)`) or span multiple declared entities.
  const reached = entitiesReached(allColumns, entityNames);
  if (parsed.every(c => c !== undefined) && allColumns.length === 0) {
    return 'reaches no declared entity';
  }
  if (reached.length > 1) {
    return `reaches multiple entities (${reached.join(', ')})`;
  }
  return undefined;
}

/**
 * Truncates `obj.description`, without its surrounding whitespace, to at most
 * `MAX_ENTRY_DESCRIPTION` characters when it exceeds the limit, and records a
 * warning (or error in `strict` mode).
 */
function truncateDescription(
    obj: Record<string, any>, label: string, doc: ImportDocument): void {
  // Push counts the description without its surrounding whitespace.
  const text =
      typeof obj.description === 'string' ? obj.description.trim() : '';
  if (text.length > MAX_ENTRY_DESCRIPTION) {
    // The cut never ends on the first half of a surrogate pair.
    const cut =
        text.slice(0, MAX_ENTRY_DESCRIPTION).replace(/[\uD800-\uDBFF]$/, '');
    doc.warnOrError(
        `${label}: truncated 'description' from ${text.length} ` +
        `to ${cut.length} characters.`);
    obj.description = cut;
    doc.modified = true;
  }
}

/**
 * Normalizes a field's datatype and SQL dialect list, removing `f.expression`
 * with a warning in the Google version (or recording an error in the vanilla
 * version) if no supported SQL dialect remains.
 */
function repairField(
    f: Record<string, any>, dsName: string, doc: ImportDocument): void {
  const fLabel = `field '${dsName}.${f.name}'`;
  normalizeDatatype(f, fLabel, doc);
  if (normalizeExpressionDialects(f, fLabel, doc) === 'empty') {
    if (doc.targetVersion === OSSIE_VERSION) {
      doc.errors.push(
          `${fLabel}: no supported SQL dialect remains in 'expression', ` +
          `and version '${OSSIE_VERSION}' requires an 'expression' on ` +
          `every field.`);
    } else {
      delete f.expression;
      doc.modified = true;
      doc.warnOrError(
          `${fLabel}: no supported SQL dialect remains; removed ` +
          `'expression' and left the field unbound.`);
    }
  }
}

/**
 * Repairs a dataset's `source` (removing query-valued sources, qualifying bare
 * table names against `doc.sourcePrefix`, and warning on unaccepted sources),
 * truncates its `description`, and repairs each of its `fields`.
 */
function repairDataset(ds: Record<string, any>, doc: ImportDocument): void {
  // 1. Repair or diagnose `ds.source`: remove query-valued sources (in the
  // Google version), qualify bare table names against `doc.sourcePrefix`, or
  // warn on unaccepted source formats.
  const dsLabel = `dataset '${ds.name}'`;
  if (typeof ds.source === 'string') {
    const trimmed = ds.source.trim();
    const qualified = doc.sourcePrefix ?
        qualifyTableSource(trimmed, doc.sourcePrefix) :
        undefined;
    if (hasUnquotedWhitespace(trimmed)) {
      if (doc.targetVersion === OSSIE_VERSION) {
        doc.errors.push(
            `${dsLabel}: query-valued source '${trimmed}' is not supported, ` +
            `and version '${OSSIE_VERSION}' requires a table 'source' on ` +
            `every dataset.`);
      } else {
        doc.warnOrError(
            `${dsLabel}: removed query-valued source '${trimmed}'; ` +
            `dataset is now unbound.`);
        delete ds.source;
        doc.modified = true;
      }
    } else if (qualified !== undefined) {
      // The author asked for this rewrite with --source-prefix, so it is a
      // warning in strict mode too.
      doc.warnings.push(
          `${dsLabel}: rewrote bare source '${trimmed}' to '${qualified}'.`);
      ds.source = qualified;
      doc.modified = true;
    } else if (!(oldSourceForm(trimmed) === undefined &&
                 isAcceptedSource(trimmed))) {
      // Why a prefix that nearly fits the name cannot complete it.
      const p = doc.sourcePrefix;
      const caseOnly =
          !!p && qualifyTableSource(trimmed, p, true) !== undefined;
      const folded = p && caseOnly ? foldedPart(trimmed, p) : undefined;
      let why: string|undefined;
      if (folded) {
        const {kind, name, read} = folded;
        why = `names ${kind} '${read}', since PostgreSQL reads an unquoted ` +
            `name in lower case. '--source-prefix' names ${kind} '${name}', ` +
            `so import cannot complete the source. If the ${kind} is ` +
            `'${name}', write it as '"${name}"' in the source; if it is ` +
            `'${read}', write '${read}' in '--source-prefix'.`;
      } else if (caseOnly) {
        why = `differs from '--source-prefix' only in letter case, so ` +
            `import cannot complete it; correct the letter case of the ` +
            `source or of '--source-prefix'.`;
      } else if (p?.child && sourceParts(trimmed, p)?.length === 1) {
        // The container it lacks: a dataset, namespace or schema.
        const lacks = p.child.slice(0, -1);
        why = `names no ${lacks}, and neither does '--source-prefix', so ` +
            `import cannot complete it; add the ${lacks} to the source or to ` +
            `'--source-prefix'.`;
      }
      doc.warnOrError(
          why ? `${dsLabel}: source '${trimmed}' ${why}` :
                sourceWarning(dsLabel, trimmed, doc.sourcePrefix));
    }
  }

  // 2. Cap the dataset's `description` at 2,000 characters and repair each of
  // its `fields`.
  truncateDescription(ds, dsLabel, doc);
  for (const f of asRecords(ds.fields)) {
    repairField(f, String(ds.name ?? ''), doc);
  }
}

/**
 * Repairs a metric's datatype, SQL dialect list, and description, returning
 * `false` when the metric is unanchored and reaches 0 or >1 entities so the
 * caller prunes it from `doc.metrics`.
 */
function repairMetric(
    mt: Record<string, any>, entityNames: string[],
    impliedDialect: string|undefined, doc: ImportDocument): boolean {
  const mtLabel = `metric '${mt.name}'`;
  normalizeDatatype(mt, mtLabel, doc);
  if (normalizeExpressionDialects(mt, mtLabel, doc) === 'empty') {
    doc.errors.push(
        `${mtLabel}: no supported SQL dialect remains in 'expression'.`);
    return true;
  }
  const problem = unanchoredMetricProblem(mt, entityNames, impliedDialect);
  if (problem) {
    // In strict mode nothing is written, so the author edits the input.
    const flavor = doc.strict ? doc.inputVersion : doc.targetVersion;
    const how = flavor === OSSIE_VERSION ?
        `with 'entity' in a ${GOOGLE_VENDOR} custom_extensions block on the ` +
            `metric (or use version '${GOOGLE_VERSION}' and set 'entity' on ` +
            `the metric)` :
        `with an 'entity' anchor`;
    doc.warnOrError(
        `${mtLabel}: removed unanchored metric whose expression ` +
        `${problem}; add the metric back ${how}.`);
    doc.modified = true;
    return false;
  }
  truncateDescription(mt, mtLabel, doc);
  return true;
}

/**
 * Phase 3 (Repair): Repairs third-party constructs in-place on `doc` (pruning
 * extra models, repairing datasets and their fields, pruning unanchored
 * metrics, and truncating descriptions > 2,000 chars).
 */
function repairDocument(doc: ImportDocument): void {
  // 1. Prune extra models after `semantic_model[0]` because `kcmd` allows only
  // a single model per document, and cap the model's `description` at 2,000
  // characters (`MAX_ENTRY_DESCRIPTION`).
  if (doc.root.semantic_model.length > 1) {
    for (const extra of doc.root.semantic_model.slice(1)) {
      const name =
          isRecord(extra) && typeof extra.name === 'string' ? extra.name : '';
      doc.warnOrError(
          `Removed extra model${name ? ` '${name}'` : ''} from ` +
          `'semantic_model'; the format allows one model per document.`);
    }
    doc.root.semantic_model = [doc.root.semantic_model[0]];
    doc.modified = true;
  }
  truncateDescription(doc.model, `model '${doc.model.name}'`, doc);

  // 2. Repair each dataset (its table `source`, `description`, and `fields`).
  for (const ds of doc.datasets) {
    repairDataset(ds, doc);
  }

  // 3. Infer the model's source dialect from its repaired datasets via
  // `sourcesDialect`, and repair or prune each metric (`repairMetric`).
  const entityNames = doc.datasets.map(ds => ds.name)
                          .filter((n): n is string => typeof n === 'string');
  const impliedDialect = sourcesDialect({
    entities: doc.datasets.map(
        ds => ({
          abstract: Boolean(ds.abstract),
          authoredSource: typeof ds.source === 'string' ? ds.source : undefined,
          dataSource: '',
        })),
  });
  doc.metrics = doc.metrics.filter(
      mt => repairMetric(mt, entityNames, impliedDialect, doc));
  if (Array.isArray(doc.model.metrics)) {
    doc.model.metrics = doc.metrics.length ? doc.metrics : undefined;
  }

  // 4. Cap each relationship's `description`. A `GOOGLE` block comes only in
  // strict mode, which writes nothing, so its description is only reported.
  for (const r of doc.relationships) {
    const rLabel = `relationship '${r.name}'`;
    truncateDescription(r, rLabel, doc);
    for (const b of parseGoogleBlocks(r.custom_extensions)) {
      truncateDescription(b, rLabel, doc);
    }
  }
}

/**
 * Sets `version` to `doc.targetVersion`, and names the model's entity list as
 * that flavor does: `entities:` in the Google flavor, `datasets:` in vanilla.
 * The renamed key keeps its place among the model's keys.
 */
function setTargetVersion(doc: ImportDocument): void {
  const [from, to] = doc.targetVersion === GOOGLE_VERSION ?
      ['datasets', 'entities'] :
      ['entities', 'datasets'];
  doc.root.version = doc.targetVersion;
  doc.modified = true;
  if (doc.model[from] !== undefined && doc.model[to] === undefined) {
    const entries = Object.entries(doc.model);
    for (const k of Object.keys(doc.model)) delete doc.model[k];
    for (const [k, v] of entries) doc.model[k === from ? to : k] = v;
  }
}

/**
 * Converts a plain vanilla (`0.2.0.dev0`) document to the Google version
 * (`0.2.0.dev0/google`) by updating `version`, renaming `datasets:` to
 * `entities:`, and moving custom `ai_context` sibling properties under
 * `ai_context.custom`.
 */
function adaptToGoogleVersion(doc: ImportDocument): void {
  setTargetVersion(doc);
  // Move any non-standard sibling keys on `ai_context` objects (at model,
  // entity, field, relationship, or metric scope) under `ai_context.custom`,
  // since `0.2.0.dev0/google` uses strict schema validation on `ai_context`.
  for (const {ai} of modelAiContexts(doc.root)) {
    adaptAiContext(ai);
  }
}

/**
 * Adapts `doc` to the vanilla (`0.2.0.dev0`) version: converts a Google file's
 * version, entity list and custom `ai_context` members, wraps short-form
 * string expressions into a single-entry `ANSI_SQL` dialect list, and moves
 * plain relationship `description`s into a `GOOGLE` `custom_extensions` block.
 * The vanilla flavor rejects the last two forms, so in a vanilla file each of
 * those changes is a repair and goes through `warnOrError`.
 */
function adaptToOssieVersion(doc: ImportDocument): void {
  // 0. A Google file takes the vanilla version and entity list, and each
  // member of an `ai_context`'s `custom` mapping goes beside the standard
  // members, where `custom` was. An `ai_context` that held only an empty
  // `custom` is dropped.
  if (doc.inputVersion === GOOGLE_VERSION) {
    setTargetVersion(doc);
    for (const owner of [
           doc.model, ...doc.datasets,
           ...doc.datasets.flatMap(ds => asRecords(ds.fields)),
           ...doc.relationships, ...doc.metrics
         ]) {
      const ai = owner.ai_context;
      if (!isRecord(ai) || !isRecord(ai.custom)) continue;
      const entries = Object.entries(ai);
      for (const k of Object.keys(ai)) delete ai[k];
      for (const [k, v] of entries) {
        Object.assign(ai, k === 'custom' ? v : {[k]: v});
      }
      if (Object.keys(ai).length === 0) delete owner.ai_context;
    }
  }

  // 1. Wrap any short-form string `expression: "<sql>"` on a field or metric
  // into `{dialects: [{dialect: 'ANSI_SQL', expression: "<sql>"}]}`, since
  // `0.2.0.dev0` requires the `expression.dialects` object form.
  const wrapShortForm = (obj: Record<string, any>, label: string) => {
    if (typeof obj.expression !== 'string') return;
    obj.expression = {
      dialects: [{dialect: 'ANSI_SQL', expression: obj.expression}],
    };
    doc.modified = true;
    if (doc.inputVersion === OSSIE_VERSION) {
      doc.warnOrError(
          `${label}: wrote the string expression as an 'ANSI_SQL' ` +
          `dialects entry.`);
    }
  };
  for (const ds of doc.datasets) {
    for (const f of asRecords(ds.fields)) {
      wrapShortForm(f, `field '${ds.name}.${f.name}'`);
    }
  }
  for (const mt of doc.metrics) wrapShortForm(mt, `metric '${mt.name}'`);

  // 2. Relocate any top-level `description` on a relationship into a `GOOGLE`
  // `custom_extensions` block. The vanilla `0.2.0.dev0` schema does not allow
  // `description` directly on a relationship, but `kcmd` reads and preserves
  // relationship descriptions from a `{vendor_name: 'GOOGLE', data: ...}`
  // extension entry (`FORMAT_VERSION_PLACEMENT['0.2.0.dev0'].relationship`).
  // A conversion from Google has moved them already (`moveConstructs`).
  for (const r of doc.relationships) {
    if (typeof r.description !== 'string') continue;
    putGoogleBlock(r, {description: r.description});
    delete r.description;
    doc.modified = true;
    doc.warnOrError(
        `relationship '${r.name}': moved 'description' into a ` +
        `${GOOGLE_VENDOR} custom_extensions block for '${OSSIE_VERSION}'.`);
  }
}

// Where the Google flavor writes a key that a GOOGLE block carries in vanilla:
// right after the last of these keys the object has, as `kcmd pull` does.
const NATIVE_KEY_AFTER: Readonly<Record<string, readonly string[]>> = {
  deployments: ['name', 'description', 'ai_context'],
  extends: ['name', 'source'],
  description: ['name', 'from', 'to', 'from_columns', 'to_columns'],
  entity: ['name'],
};

/**
 * Sets `obj[key]` to `value` right after the last of `after` that `obj` has,
 * or first. `obj` stays the same object, so the writer keeps its text.
 */
function setAfter(
    obj: Record<string, any>, after: readonly string[], key: string,
    value: unknown): void {
  const entries = Object.entries(obj);
  const at =
      Math.max(-1, ...after.map(a => entries.findIndex(([k]) => k === a)));
  entries.splice(at + 1, 0, [key, value]);
  for (const k of Object.keys(obj)) delete obj[k];
  for (const [k, v] of entries) obj[k] = v;
}

/**
 * Removes the `GOOGLE` blocks from `obj.custom_extensions`, and the list when
 * no block is left in it, and returns the values the blocks carry.
 */
function takeGoogleBlocks(obj: Record<string, any>): Record<string, unknown> {
  const values = Object.assign({}, ...parseGoogleBlocks(obj.custom_extensions));
  if (!hasGoogleBlock(asRecords(obj.custom_extensions))) return values;
  const kept = obj.custom_extensions.filter(
      (b: unknown) => !isRecord(b) || !isGoogleVendor(b.vendor_name));
  if (kept.length) {
    obj.custom_extensions = kept;
  } else {
    delete obj.custom_extensions;
  }
  return values;
}

/** True for an empty string, list or mapping. */
function isEmpty(value: unknown): boolean {
  return value === '' ||
      ((isRecord(value) || Array.isArray(value)) &&
       Object.keys(value).length === 0);
}

/** Appends a `GOOGLE` block that carries `values` to `obj.custom_extensions`. */
function putGoogleBlock(
    obj: Record<string, any>, values: Record<string, unknown>): void {
  if (Object.keys(values).length === 0) return;
  obj.custom_extensions = [
    ...(Array.isArray(obj.custom_extensions) ? obj.custom_extensions : []),
    {vendor_name: GOOGLE_VENDOR, data: JSON.stringify(values)},
  ];
}

/**
 * Moves each construct that `doc`'s flavor and its target flavor place
 * differently (`FORMAT_VERSION_PLACEMENT`) between a native key, a `GOOGLE`
 * block and the profile files. A key the target flavor has no place for is
 * dropped, and so is an empty value bound for a `GOOGLE` block. Returns the
 * profile files the Google flavor writes.
 */
function moveConstructs(
    doc: ImportDocument, profileFiles: SerializedFile[]): SerializedFile[] {
  const levels = {
    model: [doc.model],
    dataset: doc.datasets,
    relationship: doc.relationships,
    metric: doc.metrics,
  };
  let files: SerializedFile[] = [];
  for (const [level, objects] of Object.entries(levels)) {
    const placement = (version: FormatVersion) =>
        FORMAT_VERSION_PLACEMENT[version][level as keyof typeof levels] as
        Record<string, ConstructPlacement>;
    const was = placement(doc.inputVersion);
    for (const obj of objects) {
      const block = takeGoogleBlocks(obj);
      const moved: Record<string, unknown> = {};
      for (const [key, place] of Object.entries(placement(doc.targetVersion))) {
        // A key the input's flavor has no place for stays as written.
        if (was[key] === place || was[key] === 'none') continue;
        const value: unknown = was[key] === 'block' ? block[key] :
            was[key] === 'file' ?
            profileFiles.map(pf => yaml.parse(pf.content, YAML_OPTIONS)) :
            obj[key];
        // A third-party file can write natively a key its flavor keeps in a
        // GOOGLE block. That key stays as written.
        if (was[key] === 'native') delete obj[key];
        if (value === undefined) continue;
        if (place === 'native') {
          setAfter(obj, NATIVE_KEY_AFTER[key], key, value);
        } else if (place === 'file') {
          files = asRecords(value).map(p => ({
            fileName: `${doc.model.name}.profile.${p.name}.yaml`,
            content: yaml.stringify(p, {
              aliasDuplicateObjects: false,
              compat: 'yaml-1.1',
              lineWidth: 0,
            }),
          }));
        } else if (place === 'block' && !isEmpty(value)) {
          moved[key] = value;
        }
      }
      putGoogleBlock(obj, moved);
    }
  }
  return files;
}

/**
 * Loads `doc.root` into the `SemanticModel` IR, runs `transpileModel` to
 * translate vendor or double-quoted `ANSI_SQL` expressions to `BIGQUERY`, and
 * writes any newly added `BIGQUERY` dialect entries back onto `doc`.
 */
async function transpileDocument(doc: ImportDocument): Promise<void> {
  let preLoaded: ReturnType<typeof fromDocument>;
  try {
    preLoaded = fromDocument(
        doc.root, {bindingOptional: true, warnUnacceptedSource: true});
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
    return;
  }
  // Writes `irDialects` back onto `rawNode.expression` when `transpileModel`
  // appended a new dialect entry (e.g. `BIGQUERY`).
  const syncNode =
      (rawNode: Record<string, any>,
       irDialects: Array<{dialect: string; expression: string}>|undefined) => {
        const prevCount = typeof rawNode.expression === 'string' ?
            1 :
            asRecords(rawNode.expression?.dialects).length;
        if (prevCount > 0 && irDialects && irDialects.length > prevCount) {
          rawNode.expression = {
            dialects: irDialects.map(
                d => ({dialect: d.dialect, expression: d.expression})),
          };
          doc.modified = true;
        }
      };
  for (const m of preLoaded.models) {
    const transpiled = await transpileModel(m);
    doc.warnings.push(...transpiled.warnings);
    for (const ds of doc.datasets) {
      const irEntity = transpiled.model.entities.find(e => e.name === ds.name);
      for (const f of asRecords(ds.fields)) {
        syncNode(f, irEntity?.fields.find(x => x.name === f.name)?.dialects);
      }
    }
    for (const mt of doc.metrics) {
      syncNode(
          mt, transpiled.model.metrics.find(x => x.name === mt.name)?.dialects);
    }
  }
}

/**
 * Validates every deployment target on `model` using `googleDeploymentTargets`
 * and `targetProblem` so invalid targets fail import with `kcmd push`'s exact
 * message.
 */
function validateDeploymentTargets(
    model: SemanticModel, doc: ImportDocument): void {
  for (const t of googleDeploymentTargets(model).uris) {
    if (targetProblem('', t)) {
      const d = model.deployments?.find(x => x.target === t);
      doc.errors.push(
          d ? deploymentTargetError(model, d) :
              googleBlockTargetError(model, t));
    }
  }
}

/**
 * Loads each sibling `<model>.profile.<name>.yaml` entry in `profileFiles` via
 * `loadProfileFile` and attaches the resulting `ProfileSpec` list to
 * `model.profiles`, recording any reserved or duplicate profile name or
 * profile load error in `doc.errors`.
 */
function attachProfileFiles(
    model: SemanticModel, profileFiles: SerializedFile[]|undefined,
    doc: ImportDocument): void {
  if (!profileFiles?.length) return;
  const profiles: ProfileSpec[] = [];
  const seen = new Set<string>();
  for (const pf of profileFiles) {
    const profileName = parseProfileName(pf.fileName);
    if (nameProblem('profile', profileName)) continue;
    const lower = profileName.toLowerCase();
    if (lower === DEFAULT_PROFILE) {
      doc.errors.push(
          `model '${model.name}': a profile may not be named ` +
          `'${profileName}'; '${DEFAULT_PROFILE}' names the model's inline ` +
          `bindings.`);
      continue;
    }
    if (seen.has(lower)) {
      doc.errors.push(
          `model '${model.name}': duplicate profile name '${profileName}'; ` +
          `profile names must be unique ignoring case.`);
      continue;
    }
    seen.add(lower);
    try {
      profiles.push(loadProfileFile(pf.content, profileName));
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
      doc.errors.push(err.message);
    }
  }
  if (profiles.length > 0) {
    model.profiles = profiles;
  }
}

/**
 * Verifies that `model` can be converted to the vanilla (`0.2.0.dev0`) version:
 * it must declare no `actions`, no `constraints`, and no `abstract` entities,
 * and every entity must have a `source`, every field an `expression`, and
 * every relationship its join columns (`from_columns` and `to_columns`).
 * Appends every gap to `doc.errors`.
 */
function validateOssieConversion(
    model: SemanticModel, doc: ImportDocument): void {
  const prefix = `Cannot convert '${model.name}' to version '${OSSIE_VERSION}'`;

  // 1. Reject actions and constraints, which have no representation in
  // `0.2.0.dev0`.
  for (const a of model.actions ?? []) {
    doc.errors.push(
        `${prefix}: action '${a.name}' is not supported in version ` +
        `'${OSSIE_VERSION}'.`);
  }
  for (const c of model.constraints ?? []) {
    doc.errors.push(
        `${prefix}: constraint '${c.name}' is not supported in version ` +
        `'${OSSIE_VERSION}'.`);
  }

  // 2. Reject abstract entities and require every concrete entity and field to
  // be bound.
  for (const e of model.entities) {
    if (e.abstract) {
      doc.errors.push(
          `${prefix}: entity '${e.name}' is 'abstract', which version ` +
          `'${OSSIE_VERSION}' does not support.`);
      continue;
    }
    if (!e.authoredSource && !e.dataSource) {
      doc.errors.push(`${prefix}: entity '${e.name}' has no 'source'.`);
    }
    for (const f of e.fields) {
      if (!isFieldBound(f)) {
        doc.errors.push(
            `${prefix}: field '${e.name}.${f.name}' has no 'expression'.`);
      }
    }
  }

  // 3. Require every relationship to declare its join columns.
  for (const r of model.relationships) {
    if (!r.source.columns.length || !r.destination.columns.length) {
      doc.errors.push(
          `${prefix}: relationship '${r.name}' has no join columns ` +
          `('from_columns' and 'to_columns').`);
    }
  }
}

/**
 * Loads `doc.root` into the `SemanticModel` IR for cross-version conversion,
 * recording any `SemanticModelError` on `doc.errors`.
 */
function loadSemanticModel(doc: ImportDocument): SemanticModel|undefined {
  try {
    const loaded = fromDocument(
        doc.root, {bindingOptional: true, warnUnacceptedSource: true});
    return loaded.models[0];
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
    doc.errors.push(err.message);
    return undefined;
  }
}

/**
 * Phase 4 (Convert): Checks with the `SemanticModel` IR that `doc` converts to
 * its target version (`0.2.0.dev0` <-> `0.2.0.dev0/google`), attaching profile
 * files and checking conversion gaps when targeting `0.2.0.dev0`, then edits
 * `doc` into that version with `generateAdaptedFiles`.
 */
async function generateConvertedFiles(
    doc: ImportDocument,
    opts: ImportSemanticModelOptions): Promise<SerializedFile[]> {
  if (doc.errors.length > 0) return [];
  const model = loadSemanticModel(doc);
  if (!model) return [];
  if (doc.targetVersion === OSSIE_VERSION) {
    attachProfileFiles(model, opts.profileFiles, doc);
    validateOssieConversion(model, doc);
    if (doc.errors.length > 0) return [];
  }
  return generateAdaptedFiles(doc, !!opts.transpile, opts.profileFiles);
}

/**
 * Phase 4 (Adapt): Adapts `doc` in place to its target version
 * (`moveConstructs`, then `adaptToGoogleVersion` or `adaptToOssieVersion`),
 * optionally transpiles expressions via `transpileDocument`, and returns the
 * output files. Every value these steps do not change keeps its text.
 */
async function generateAdaptedFiles(
    doc: ImportDocument, transpile: boolean,
    profileFiles: SerializedFile[] = []): Promise<SerializedFile[]> {
  // 1. Adapt `doc` in place to the target output version (`0.2.0.dev0/google`
  // or `0.2.0.dev0`).
  const profiles = doc.inputVersion === doc.targetVersion ?
      [] :
      moveConstructs(doc, profileFiles);
  if (doc.inputVersion === OSSIE_VERSION &&
      doc.targetVersion === GOOGLE_VERSION) {
    adaptToGoogleVersion(doc);
  } else if (doc.targetVersion === OSSIE_VERSION) {
    adaptToOssieVersion(doc);
  }

  // 2. When `transpile` is enabled and no prior errors occurred, translate
  // vendor or double-quoted `ANSI_SQL` expressions to `BIGQUERY`.
  if (transpile && doc.errors.length === 0) {
    await transpileDocument(doc);
  }

  // 3. Write `doc.root` into the input's text when modified or preserve the
  // text verbatim when unmodified.
  const content = doc.modified ? writeDocument(doc, doc.root) : doc.text;
  return [{fileName: `${doc.model.name}.yaml`, content}, ...profiles];
}

/**
 * Returns the input's text changed to hold `root`. What survives from the
 * input keeps its text, and long SQL stays on one line.
 */
function writeDocument(doc: ImportDocument, root: Record<string, any>): string {
  // The vanilla flavor lists a model's entities under `datasets:` and the
  // Google flavor under `entities:`. Renaming the key keeps the comments of
  // the list and of every entity in it.
  const node = doc.document.getIn(['semantic_model', 0]);
  const model = asRecords(root.semantic_model)[0] ?? {};
  for (const pair of yaml.isMap(node) ? node.items : []) {
    if (!yaml.isScalar(pair.key)) continue;
    const from = String(pair.key.value);
    const to = from === 'datasets' ? 'entities' :
        from === 'entities'        ? 'datasets' :
                                     undefined;
    if (to && to in model && !(from in model)) pair.key.value = to;
  }
  return updateText(doc.text, doc.document, root, doc.links);
}

/**
 * Phase 5 (Post-validation): Validates the serialized output YAML with
 * `loadModels` (`warnUnacceptedSource: !doc.strict`) and checks deployment
 * targets.
 */
function validateOutputDocument(content: string, doc: ImportDocument): void {
  try {
    // 1. Load the serialized output YAML with `loadModels`
    // (`warnUnacceptedSource: !doc.strict`) to run full schema and semantic
    // validation while turning unaccepted table sources into warnings in
    // non-strict mode, deduplicating warnings already recorded.
    const loaded = loadModels(
        content, {bindingOptional: true, warnUnacceptedSource: !doc.strict});
    for (const w of loaded.warnings) {
      // The repair step has reported each source the loader warns about.
      if (LOADER_SOURCE_WARNING.test(w)) continue;
      if (!doc.warnings.includes(w) && !doc.errors.includes(w)) {
        doc.warnings.push(w);
      }
    }

    // 2. Validate every deployment target on the loaded model using
    // `validateDeploymentTargets`.
    for (const m of loaded.models) {
      validateDeploymentTargets(m, doc);
    }
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
    doc.errors.push(err.message);
  }
}

/**
 * Repairs, converts, optionally transpiles, and validates a semantic model YAML
 * document, returning the normalized output file(s) along with any warnings or
 * errors.
 */
export async function importSemanticModelYaml(
    rawYaml: string,
    opts: ImportSemanticModelOptions = {}): Promise<ImportSemanticModelResult> {
  // 1. Initialize the SQL parser and parse/pre-validate the input document.
  await loadSqlEngine();
  const doc = parseImportDocument(rawYaml, opts);
  if (typeof doc === 'string') {
    return {ok: false, files: [], warnings: [], errors: [doc]};
  }
  validateInputDocument(doc, opts.profileFiles);

  // 2. Run third-party repairs (which record errors in `strict` mode).
  repairDocument(doc);

  // 3. Generate the converted or adapted output file(s).
  const shouldConvert = doc.inputVersion !== doc.targetVersion && doc.strict;
  const files = shouldConvert ?
      await generateConvertedFiles(doc, opts) :
      await generateAdaptedFiles(doc, !!opts.transpile);

  // 4. Validate the primary output document and return the result.
  if (files.length > 0 && doc.errors.length === 0) {
    validateOutputDocument(files[0].content, doc);
  }
  return {
    ok: doc.errors.length === 0,
    files: doc.errors.length === 0 ? files : [],
    warnings: doc.warnings,
    errors: doc.errors,
  };
}
