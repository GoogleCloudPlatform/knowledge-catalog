// Imports a third-party (or first-party) semantic model YAML document into a
// valid kcmd semantic model document.

import * as yaml from 'yaml';

import {deploymentTargetError, googleBlockTargetError, googleDeploymentTargets, targetProblem} from './deployment_target';
import {ALLOWED_DIALECTS, normalizeDataType, SqlDialect} from './ir';
import {catalogNameSegments, FormatVersion, fromDocument, GOOGLE_VENDOR, GOOGLE_VERSION, hasGoogleBlock, hasUnquotedWhitespace, isAcceptedSource, isFormatVersion, isGoogleVendor, isRecord, loadModels, modelAiContexts, noSqlReason, oldSourceForm, OSSIE_VERSION, SemanticModelError, unquote} from './loader';
import {MAX_ENTRY_DESCRIPTION, NameKind, nameProblem} from './names';
import {plainCopy, sourcesDialect} from './resolve_profiles';
import {columnsForSource, entitiesReached} from './sql_expr_utils';
import {loadSqlEngine} from './sql_parser';
import {transpileModel} from './transpile';
import {YAML_OPTIONS} from './yaml_options';

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
  /** When true, treats any third-party repair warning as a hard error. */
  strict?: boolean;
  /**
   * Sibling `<model>.profile.<name>.yaml` files located beside the input file,
   * used when converting a Google-flavor model to vanilla (`'ossie'`).
   */
  profileFiles?: Array<{fileName: string; content: string}>;
}

/** Result of importing a semantic model YAML document. */
export interface ImportSemanticModelResult {
  /** True when `errors` is empty and `files` was produced. */
  ok: boolean;
  /**
   * Generated output files (`<model-name>.yaml`), or `[]` when `ok` is false.
   */
  files: Array<{fileName: string; content: string}>;
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

const SOURCE_WARNING_SUFFIX = ' is not a valid GCP resource name.';

const SOURCE_CLI_HINT =
    `'kcmd push' rejects the file until it is repointed, or until ` +
    `'kcmd import' runs again with '--source-prefix'.`;

const ALLOWED_DIALECT_SET = new Set<string>(ALLOWED_DIALECTS);

const DIALECT_ALIASES: Readonly<Record<string, SqlDialect>> = {
  GOOGLE_SQL: 'BIGQUERY',
  GOOGLESQL: 'BIGQUERY',
  POSTGRESQL: 'POSTGRES',
  TSQL: 'SQLSERVER',
};

const SOURCE_PREFIX_PATTERNS: ReadonlyArray<{re: RegExp; child?: string}> = [
  {re: /^bigquery\.googleapis\.com\/projects\/([^/]+)$/, child: 'datasets'},
  {re: /^bigquery\.googleapis\.com\/projects\/([^/]+)\/datasets\/([^/.]+)$/},
  {
    re: /^biglake\.googleapis\.com\/projects\/([^/]+)\/catalogs\/([^/.]+)$/,
    child: 'namespaces',
  },
  {
    re: /^biglake\.googleapis\.com\/projects\/([^/]+)\/catalogs\/([^/.]+)\/namespaces\/([^/.]+)$/,
  },
  {
    re: /^spanner\.googleapis\.com\/projects\/([^/]+)\/instances\/([^/]+)\/databases\/([^/]+)$/,
  },
  {
    re: /^alloydb\.googleapis\.com\/projects\/[^/]+\/locations\/[^/]+\/clusters\/[^/]+\/databases\/([^/]+)$/,
    child: 'schemas',
  },
  {
    re: /^alloydb\.googleapis\.com\/projects\/[^/]+\/locations\/[^/]+\/clusters\/[^/]+\/databases\/([^/]+)\/schemas\/([^/]+)$/,
  },
  {
    re: /^cloudsql\.googleapis\.com\/projects\/[^/]+\/locations\/[^/]+\/instances\/[^/]+\/databases\/([^/]+)$/,
  },
  {
    re: /^cloudsql\.googleapis\.com\/projects\/[^/]+\/locations\/[^/]+\/instances\/[^/]+\/databases\/([^/]+)\/schemas\/([^/]+)$/,
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
 * validates `opts.sourcePrefix` when present, and constructs the mutable
 * `ImportDocument` (or returns a fatal error string).
 */
function parseImportDocument(
    rawYaml: string, opts: ImportSemanticModelOptions): ImportDocument|string {
  // 1. Parse raw YAML with strict YAML 1.2 options (`YAML_OPTIONS`) so syntax
  // errors and duplicate keys are caught immediately.
  let parsedDoc: unknown;
  try {
    parsedDoc = yaml.parse(rawYaml, YAML_OPTIONS);
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

  // 4. Deep-copy `parsedDoc` via `plainCopy` to decouple shared YAML anchor /
  // alias references before in-place mutations, and assemble `ImportDocument`.
  const root = plainCopy(parsedDoc) as Record<string, any>;
  const model = root.semantic_model[0] as Record<string, any>;
  const inputVersion = root.version as FormatVersion;
  const targetVersion: FormatVersion = opts.flavor ?
      (opts.flavor === 'google' ? GOOGLE_VERSION : OSSIE_VERSION) :
      inputVersion;
  const strict = !!opts.strict;
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
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
 * Phase 2 (Pre-validation): Enforces strict-mode and version conversion gates
 * (returning a fatal error string if refused) and validates all identifier
 * names in the input document in a single pass.
 */
function validateInputDocument(doc: ImportDocument): string|undefined {
  // 1. Enforce strict-mode and version conversion gates: reject documents with
  // `GOOGLE` extension blocks when `strict` is false (since third-party tools
  // do not write `GOOGLE` blocks), and reject unsupported version conversions
  // so we never emit a partially converted file.
  const googleBlocksPresent = documentHasGoogleBlock(doc.root);
  if (!doc.strict && googleBlocksPresent) {
    return `Document contains a '${GOOGLE_VENDOR}' custom_extensions block ` +
        `(written for kcmd); use '--input first-party' to convert a ` +
        `first-party model.`;
  }
  if (doc.inputVersion === GOOGLE_VERSION &&
      doc.targetVersion === OSSIE_VERSION) {
    return `Converting from version '${GOOGLE_VERSION}' to '${
        OSSIE_VERSION}' is not supported yet.`;
  }
  if (doc.inputVersion === OSSIE_VERSION &&
      doc.targetVersion === GOOGLE_VERSION && googleBlocksPresent) {
    return `Converting a '${OSSIE_VERSION}' document with a '${
        GOOGLE_VENDOR}' custom_extensions block to '${
        GOOGLE_VERSION}' is not supported yet.`;
  }

  // 2. Validate all model, deployment, profile, entity/dataset, field,
  // relationship, and metric names in a single pass so every invalid or
  // over-length identifier is reported at once (without rewriting names that
  // may appear inside SQL).
  // Validates `name` against `kind`'s identifier rules via `nameProblem` and
  // appends any error (prefixed by `scope` when given) to `doc.errors`.
  const check = (kind: NameKind, name: unknown, scope?: string) => {
    if (typeof name !== 'string') return;
    const problem = nameProblem(kind, name);
    if (problem) doc.errors.push(scope ? `${scope}: ${problem}` : problem);
  };
  check('model', doc.model.name);
  const modelScope = typeof doc.model.name === 'string' ?
      `model '${doc.model.name}'` :
      'model';
  const googleData =
      asRecords(doc.model.custom_extensions)
          .filter(
              b => isGoogleVendor(b.vendor_name) && typeof b.data === 'string')
          .map(b => yaml.parseDocument(b.data).toJS())
          .filter(isRecord);
  for (const d
           of [...asRecords(doc.model.deployments),
               ...googleData.flatMap(g => asRecords(g.deployments)),
  ]) {
    check('deployment', d.name, modelScope);
  }
  for (const p
           of [...asRecords(doc.model.profiles),
               ...googleData.flatMap(g => asRecords(g.profiles)),
  ]) {
    check('profile', p.name, modelScope);
  }
  for (const ds of doc.datasets) {
    check('entity', ds.name);
    const dsScope =
        typeof ds.name === 'string' ? `dataset '${ds.name}'` : 'dataset';
    for (const f of asRecords(ds.fields)) check('field', f.name, dsScope);
  }
  for (const r of doc.relationships) check('relationship', r.name);
  for (const mt of doc.metrics) check('metric', mt.name);
  return undefined;
}

/**
 * Qualifies a bare dot-separated table name `source` against `prefix` into a
 * GCP resource name when `prefix` supplies the missing hierarchy segments and
 * any overlapping segments agree, or returns `undefined` if `source` cannot be
 * qualified.
 */
function qualifyTableSource(source: string, prefix: ParsedSourcePrefix): string|
    undefined {
  // 1. Reject empty strings, already-slashed or colon-prefixed sources, and
  // query-valued sources with unquoted whitespace.
  const trimmed = source.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes(':') ||
      hasUnquotedWhitespace(trimmed)) {
    return undefined;
  }

  // 2. Split the bare dot-separated table reference into unquoted segments
  // (unwrapping a single-backticked BigQuery path like `` `p.d.t` `` first) and
  // verify that any leading segments overlapping `prefix.known` match.
  const unwrapped = prefix.base.startsWith('bigquery.googleapis.com/') &&
          trimmed.startsWith('`') && trimmed.endsWith('`') &&
          !trimmed.slice(1, -1).includes('`') ?
      trimmed.slice(1, -1) :
      trimmed;
  const segs = catalogNameSegments(unwrapped).map(unquote);
  if (!segs.length || segs.some(s => !s.length)) return undefined;
  const needed = prefix.child ? 2 : 1;
  const overlap = segs.length - needed;
  if (overlap < 0 || overlap > prefix.known.length) return undefined;
  const tail = prefix.known.slice(prefix.known.length - overlap);
  if (tail.some((k, i) => segs[i] !== k)) return undefined;

  // 3. Append the remaining child container (if any) and table segment onto
  // `prefix.base` and verify the resulting resource name is accepted.
  const rest = segs.slice(overlap);
  const qualified = prefix.child ?
      `${prefix.base}/${prefix.child}/${rest[0]}/tables/${rest[1]}` :
      `${prefix.base}/tables/${rest[0]}`;
  return isAcceptedSource(qualified) ? qualified : undefined;
}

/**
 * Canonicalizes `obj.datatype` casing (e.g. `integer` -> `Integer`) and deletes
 * `Opaque` in any casing.
 */
function normalizeDatatype(
    obj: Record<string, any>, doc: ImportDocument): void {
  if (typeof obj.datatype !== 'string') return;
  const res = normalizeDataType(obj.datatype, GOOGLE_VERSION);
  if (!res.ok) return;
  if (res.type === undefined) {
    delete obj.datatype;
    doc.modified = true;
  } else if (obj.datatype !== res.type) {
    obj.datatype = res.type;
    doc.modified = true;
  }
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
 * Truncates `obj.description` to `MAX_ENTRY_DESCRIPTION` characters when it
 * exceeds the limit and records a warning (or error in `strict` mode).
 */
function truncateDescription(
    obj: Record<string, any>, label: string, doc: ImportDocument): void {
  if (typeof obj.description === 'string' &&
      obj.description.length > MAX_ENTRY_DESCRIPTION) {
    doc.warnOrError(
        `${label}: truncated 'description' from ${obj.description.length} ` +
        `to ${MAX_ENTRY_DESCRIPTION} characters.`);
    obj.description = obj.description.slice(0, MAX_ENTRY_DESCRIPTION);
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
  normalizeDatatype(f, doc);
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
      doc.warnOrError(
          `${dsLabel}: rewrote bare source '${trimmed}' to '${qualified}'.`);
      ds.source = qualified;
      doc.modified = true;
    } else if (!(oldSourceForm(trimmed) === undefined &&
                 isAcceptedSource(trimmed))) {
      doc.warnOrError(`${dsLabel}: source '${trimmed}'${
          SOURCE_WARNING_SUFFIX.slice(0, -1)}; ${SOURCE_CLI_HINT}`);
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
  normalizeDatatype(mt, doc);
  if (normalizeExpressionDialects(mt, mtLabel, doc) === 'empty') {
    doc.errors.push(
        `${mtLabel}: no supported SQL dialect remains in 'expression'.`);
    return true;
  }
  const problem = unanchoredMetricProblem(mt, entityNames, impliedDialect);
  if (problem) {
    const how = doc.targetVersion === OSSIE_VERSION ?
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
}

/**
 * Converts a plain vanilla (`0.2.0.dev0`) document to the Google version
 * (`0.2.0.dev0/google`) by updating `version`, renaming `datasets:` to
 * `entities:`, and moving custom `ai_context` sibling properties under
 * `ai_context.custom`.
 */
function adaptToGoogleVersion(doc: ImportDocument): void {
  // 1. Switch the document header to `0.2.0.dev0/google` and rename the
  // top-level `datasets:` collection to `entities:`.
  doc.root.version = GOOGLE_VERSION;
  doc.modified = true;
  if (doc.model.datasets !== undefined && doc.model.entities === undefined) {
    doc.model.entities = doc.model.datasets;
    delete doc.model.datasets;
  }

  // 2. Move any non-standard sibling keys on `ai_context` objects (at model,
  // entity, field, relationship, or metric scope) under `ai_context.custom`,
  // since `0.2.0.dev0/google` uses strict schema validation on `ai_context`.
  for (const {ai} of modelAiContexts(doc.root)) {
    adaptAiContext(ai);
  }
}

/**
 * Adapts `doc` to the vanilla (`0.2.0.dev0`) version: wraps short-form string
 * expressions into a single-entry `ANSI_SQL` dialect list, and moves plain
 * relationship `description`s into a `GOOGLE` `custom_extensions` block.
 */
function adaptToOssieVersion(doc: ImportDocument): void {
  // 1. Wrap any short-form string `expression: "<sql>"` on a field or metric
  // into `{dialects: [{dialect: 'ANSI_SQL', expression: "<sql>"}]}`, since
  // `0.2.0.dev0` requires the `expression.dialects` object form.
  // Wraps a short-form string `expression` on `obj` into a single-entry
  // `ANSI_SQL` `dialects` list so the node conforms to `0.2.0.dev0`.
  const wrapShortForm = (obj: Record<string, any>) => {
    if (typeof obj.expression === 'string') {
      obj.expression = {
        dialects: [{dialect: 'ANSI_SQL', expression: obj.expression}],
      };
      doc.modified = true;
    }
  };
  for (const ds of doc.datasets) {
    for (const f of asRecords(ds.fields)) wrapShortForm(f);
  }
  for (const mt of doc.metrics) wrapShortForm(mt);

  // 2. Relocate any top-level `description` on a relationship into a `GOOGLE`
  // `custom_extensions` block. The vanilla `0.2.0.dev0` schema does not allow
  // `description` directly on a relationship, but `kcmd` reads and preserves
  // relationship descriptions from a `{vendor_name: 'GOOGLE', data: ...}`
  // extension entry (`FORMAT_VERSION_PLACEMENT['0.2.0.dev0'].relationship`).
  for (const r of doc.relationships) {
    if (typeof r.description === 'string') {
      // Append `{vendor_name: 'GOOGLE', data: '{"description":"..."}'}` to the
      // relationship's `custom_extensions` list (creating the list if absent).
      const exts =
          Array.isArray(r.custom_extensions) ? r.custom_extensions : [];
      exts.push({
        vendor_name: GOOGLE_VENDOR,
        data: JSON.stringify({description: r.description}),
      });
      r.custom_extensions = exts;
      // Remove the native `description` key so `0.2.0.dev0` validation passes.
      delete r.description;
      doc.modified = true;
      doc.warnOrError(
          `relationship '${r.name}': moved 'description' into a ` +
          `${GOOGLE_VENDOR} custom_extensions block for '${OSSIE_VERSION}'.`);
    }
  }
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
 * Phase 4 (Adapt): Adapts `doc` to its target version (`adaptToGoogleVersion`
 * or `adaptToOssieVersion`) and, when `transpile` is true, translates
 * expressions via `transpileDocument`.
 */
async function adaptDocument(
    doc: ImportDocument, transpile: boolean): Promise<void> {
  // 1. Adapt `doc` to the target output version (`0.2.0.dev0/google` or
  // `0.2.0.dev0`).
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
    for (const raw of loaded.warnings) {
      const w = raw.endsWith(SOURCE_WARNING_SUFFIX) ?
          `${raw.slice(0, -1)}; ${SOURCE_CLI_HINT}` :
          raw;
      if (!doc.warnings.includes(w) && !doc.errors.includes(w)) {
        doc.warnings.push(w);
      }
    }

    // 2. Validate every deployment target on the loaded model (across both
    // `m.deployments` and `GOOGLE`-block `deploymentTargets`) using
    // `googleDeploymentTargets` and `targetProblem` so invalid targets fail
    // import with `kcmd push`'s exact message.
    for (const m of loaded.models) {
      for (const t of googleDeploymentTargets(m).uris) {
        if (targetProblem('', t)) {
          const d = m.deployments?.find(x => x.target === t);
          doc.errors.push(
              d ? deploymentTargetError(m, d) : googleBlockTargetError(m, t));
        }
      }
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
  await loadSqlEngine();

  const doc = parseImportDocument(rawYaml, opts);
  if (typeof doc === 'string') {
    return {ok: false, files: [], warnings: [], errors: [doc]};
  }

  const gateError = validateInputDocument(doc);
  if (gateError) {
    return {ok: false, files: [], warnings: [], errors: [gateError]};
  }

  repairDocument(doc);
  await adaptDocument(doc, !!opts.transpile);

  const content =
      doc.modified ? yaml.stringify(doc.root, {lineWidth: 0}) : rawYaml;
  if (doc.errors.length === 0) {
    validateOutputDocument(content, doc);
  }

  if (doc.errors.length > 0) {
    return {ok: false, files: [], warnings: doc.warnings, errors: doc.errors};
  }
  return {
    ok: true,
    files: [{fileName: `${doc.model.name}.yaml`, content}],
    warnings: doc.warnings,
    errors: [],
  };
}
