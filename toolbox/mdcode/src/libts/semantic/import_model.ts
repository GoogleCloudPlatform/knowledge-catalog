// Imports a third-party (or first-party) semantic model YAML document into a
// valid kcmd semantic model document.

import * as yaml from 'yaml';

import {checkProfileFileName, ProfileFileError, profileNameError, profileParseError, vanillaSiblingError} from '../layouts/semantic-model';
import {deploymentTargetError, googleBlockTargetError, googleDeploymentTargets, resolveModelDeployments, targetProblem} from './deployment_target';
import {ALLOWED_DIALECTS, isFieldBound, normalizeDataType, ProfileSpec, SemanticModel, SqlDialect} from './ir';
import {bareNameParts, ConstructPlacement, dottedPartProblem, fillForm, FORMAT_VERSION_PLACEMENT, FormatVersion, fromDocument, GOOGLE_VENDOR, GOOGLE_VERSION, hasGoogleBlock, hasUnquotedWhitespace, isAcceptedSource, isFormatVersion, isGoogleCloudForm, isGoogleVendor, isRecord, loadModels, modelAiContexts, NO_SPACE, noSqlReason, oldSourceForm, OSSIE_VERSION, parseSource, SemanticModelError, TABLE_FORMS, THIRD_PARTY_SOURCE} from './loader';
import {MAX_ENTRY_DESCRIPTION, NameKind, nameProblem} from './names';
import {SerializedFile} from './osi_converter';
import {appliedProfileWarnings, DeclaredProfile, declaredProfiles, DEFAULT_PROFILE, loadProfileFile, namedProfileErrors, plainCopy, readerMessage, sourcesDialect, undeclaredProfileError} from './resolve_profiles';
import {tableFqnParts} from './source_dialect';
import {columnsForSource, entitiesReached} from './sql_expr_utils';
import {loadSqlEngine} from './sql_parser';
import {transpileModel} from './transpile';
import {deploymentTableErrors, inlineBindingWarnings, spannerMetricsErrors, validateDeployments, validateInheritedColumns, validateInlineDialects} from './validate';
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
   * sources, or the name of a Knowledge Catalog entry group
   * (`projects/<p>/locations/<l>/entryGroups/<g>`) whose table entries complete
   * them by their fullyQualifiedName.
   */
  sourcePrefix?: string;
  /**
   * Lists every entry of an entry group, as `CatalogClient.listEntries` does.
   * Required when `sourcePrefix` names an entry group.
   */
  listEntries?: EntryLister;
  /** When true, translates vendor or double-quoted ANSI SQL to `BIGQUERY`. */
  transpile?: boolean;
  /**
   * When true, treats any third-party repair warning as a hard error, except
   * completing a bare table source from `sourcePrefix`.
   */
  strict?: boolean;
  /**
   * Sibling `<model>.profile.<name>.yaml` files located beside the input file.
   * A conversion to vanilla writes them into the model file, and a
   * Google-flavor import of a Google-flavor model writes them beside it.
   */
  profileFiles?: SerializedFile[];
  /**
   * The input file's name. The warning that a JSON input was written as YAML
   * names it, or `<model>.yaml` when it is unset. When set, in strict mode
   * each message about the model's bindings names the input file or profile
   * file that holds them.
   */
  fileName?: string;
}

/** The one catalog call import makes. */
export type EntryLister =
    (project: string, location: string, entryGroup: string) =>
        AsyncIterable<{name: string; fullyQualifiedName?: string}>;

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

/** A `--source-prefix` that names a Knowledge Catalog entry group. */
interface EntryGroupPrefix {
  /** The entry group's name, as written. */
  base: string;
  project: string;
  location: string;
  group: string;
  list: EntryLister;
}

/** An entry of the `--source-prefix` entry group that names a table or view. */
interface TableEntry {
  /** The entry's name, under the entry group as `--source-prefix` writes it. */
  name: string;
  fullyQualifiedName: string;
  /** The parts of `fullyQualifiedName` after its prefix, unquoted. */
  parts: string[];
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
  /** The `--source-prefix` entry group, if it names one. */
  entryGroup?: EntryGroupPrefix;
  /**
   * The table entries of `entryGroup`, listed when a dataset's source is a
   * bare table name.
   */
  entryTables?: TableEntry[];
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

// Each kind of --source-prefix for the service `prefix` names, or every kind
// when there is no prefix.
function prefixKinds(prefix?: ParsedSourcePrefix):
    typeof SOURCE_PREFIX_PATTERNS {
  const host = prefix?.base.split('/')[0];
  return SOURCE_PREFIX_PATTERNS.filter(
      k => host === undefined || k.form.startsWith(`${host}/`));
}

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
  const kinds = prefixKinds(prefix);
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

// Push's error for `source`, read as the loader reads a source in `ctx`, or
// undefined when push accepts it.
function sourceError(source: string, ctx: string): string|undefined {
  try {
    parseSource(source, {}, ctx);
    return undefined;
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
    return readerMessage(err);
  }
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

// An entry group a `--source-prefix` names. A system entry group, such as
// `@bigquery`, is refused, since its entries are Google Cloud tables, which a
// source names by resource name.
const ENTRY_GROUP_PREFIX =
    /^projects\/([^/]+)\/locations\/([^/]+)\/entryGroups\/([^/]+)$/;

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

  // 3. Validate `opts.sourcePrefix` against the 9 supported first-party GCP
  // container resource name patterns, or as an entry group, before doing any
  // document work.
  let sourcePrefix: ParsedSourcePrefix|undefined;
  let entryGroup: EntryGroupPrefix|undefined;
  if (opts.sourcePrefix !== undefined) {
    const base = opts.sourcePrefix.trim();
    const match = SOURCE_PREFIX_PATTERNS.map(p => ({m: base.match(p.re), p}))
                      .find(x => x.m !== null);
    const group = base.match(ENTRY_GROUP_PREFIX);
    if (match?.m) {
      sourcePrefix = {base, known: match.m.slice(1), child: match.p.child};
    } else if (group?.[3].startsWith('@')) {
      return `sourcePrefix '${opts.sourcePrefix}' names the system entry ` +
          `group '${group[3]}', whose entries are Google Cloud tables. Pass ` +
          `the GCP resource name of their database instead, such as ` +
          `'bigquery.googleapis.com/projects/<p>/datasets/<d>'.`;
    } else if (group) {
      entryGroup = {
        base,
        project: group[1],
        location: group[2],
        group: group[3],
        list: opts.listEntries!,
      };
    } else {
      return `Invalid sourcePrefix '${opts.sourcePrefix}'; expected the GCP ` +
          `resource name of a BigQuery project or dataset, a BigLake ` +
          `catalog or namespace, a Spanner database, an AlloyDB database ` +
          `or schema, or a Cloud SQL database or schema (with no leading ` +
          `'//'), or the name of a Knowledge Catalog entry group ` +
          `('projects/<p>/locations/<l>/entryGroups/<g>').`;
    }
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
    entryGroup,
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
 * relationship, and metric names in `doc` (plus any `googleBlocks`) in a
 * single pass so every invalid or over-length identifier is reported at once.
 */
function validateObjectNames(
    doc: ImportDocument, googleBlocks: Array<Record<string, unknown>>,
    modelScope: string): void {
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

  // 1. Validate model, deployment, and profile names (inline and `GOOGLE`
  // block).
  validateName('model', doc.model.name);
  validateRecords('deployment', asRecords(doc.model.deployments), modelScope);
  validateRecords('profile', asRecords(doc.model.profiles), modelScope);
  for (const g of googleBlocks) {
    validateRecords('deployment', asRecords(g.deployments), modelScope);
    validateRecords('profile', asRecords(g.profiles), modelScope);
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
 * document. The loader rejects a model's legacy `deploymentTargets`.
 */
function validateInputDocument(doc: ImportDocument): void {
  const modelScope = typeof doc.model.name === 'string' ?
      `model '${doc.model.name}'` :
      'model';
  const googleBlocks = parseGoogleBlocks(doc.model.custom_extensions);
  validateObjectNames(doc, googleBlocks, modelScope);
}

/**
 * The parts of a bare dot-separated table name `source` as `prefix` reads
 * them, each unquoted and marked when it was quoted, or `undefined` when
 * `source` is not a bare name.
 */
function sourceParts(source: string, prefix?: ParsedSourcePrefix):
    Array<{text: string; quoted: boolean}>|undefined {
  // Reject empty strings, already-slashed or colon-prefixed sources, and
  // query-valued sources with unquoted whitespace.
  const trimmed = source.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes(':') ||
      hasUnquotedWhitespace(trimmed)) {
    return undefined;
  }
  const segs = prefixParts(trimmed, prefix?.base ?? '');
  return segs.length && segs.every(s => s.text.length) ? segs : undefined;
}

/**
 * `text` with its ASCII letters in lower case. PostgreSQL folds only these in a
 * UTF-8 database.
 */
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, c => c.toLowerCase());
}

/**
 * True when a prefix that starts with `base` names a database that reads
 * unquoted names in lower case.
 */
function foldsUnquotedCase(base: string): boolean {
  return base.startsWith('alloydb.googleapis.com/');
}

/** `part` as the database of a prefix that starts with `base` reads it. */
function readPart(base: string, part: {text: string; quoted: boolean}): string {
  return foldsUnquotedCase(base) && !part.quoted ? lowerAscii(part.text) :
                                                   part.text;
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
  if (!segs || !foldsUnquotedCase(prefix.base)) return undefined;
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
  const read = (s: {text: string; quoted: boolean}) => readPart(prefix.base, s);
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

// True when a --source-prefix of one of `kinds` completes `source`. Each
// prefix tried is built from the parts as that kind reads them.
function completes(
    source: string, kinds: typeof SOURCE_PREFIX_PATTERNS): boolean {
  return kinds.some(kind => {
    const parts =
        prefixParts(source, kind.form).map(p => readPart(kind.form, p));
    const prefix = prefixFor(kind, parts);
    return prefix !== undefined &&
        qualifyTableSource(source, prefix) !== undefined;
  });
}

/**
 * Phase 2b (Catalog read): When `doc.entryGroup` is set and a dataset's
 * source is a bare table name, lists the entry group's entries once into
 * `doc.entryTables`, keeping those whose fullyQualifiedName names a table or
 * view. Returns the error when the list fails.
 */
async function listEntryTables(doc: ImportDocument): Promise<string|undefined> {
  const group = doc.entryGroup;
  if (!group ||
      !doc.datasets.some(
          ds => typeof ds.source === 'string' && sourceParts(ds.source))) {
    return undefined;
  }
  const tables: TableEntry[] = [];
  try {
    for await (const e of group.list(
                   group.project, group.location, group.group)) {
      const fqn = e.fullyQualifiedName ?? '';
      const table = tableFqnParts(fqn);
      if (!table) continue;
      tables.push({
        name: `${group.base}${e.name.slice(e.name.indexOf('/entries/'))}`,
        fullyQualifiedName: fqn,
        parts: table.parts,
      });
    }
  } catch (err: any) {
    return `Could not list the entries of entry group '${group.base}' to ` +
        `complete bare table names: ${err?.message ?? err}`;
  }
  doc.entryTables = tables;
  return undefined;
}

/**
 * Completes the bare table name `source` of `ds` with the one entry in
 * `doc.entryTables` whose fullyQualifiedName ends in its parts, an unquoted
 * part in any letter case and a quoted part in its own case. Leaves a name no
 * entry or several entries end in as written, and reports it with the
 * candidates.
 */
function completeFromEntryGroup(
    ds: Record<string, any>, source: string,
    parts: Array<{text: string; quoted: boolean}>, doc: ImportDocument): void {
  const dsLabel = `dataset '${ds.name}'`;
  const group = doc.entryGroup!.base;
  // Compared from the end, so a name with more parts than an entry's matches
  // none.
  const matches = doc.entryTables!.filter(t => parts.every((p, i) => {
    const e = t.parts.at(i - parts.length);
    return p.quoted ? p.text === e : p.text.toLowerCase() === e?.toLowerCase();
  }));
  if (matches.length === 1) {
    // The author asked for this rewrite with --source-prefix, so it is a
    // warning in strict mode too.
    const [m] = matches;
    doc.warnings.push(
        `${dsLabel}: rewrote bare source '${source}' to '${m.name}', the ` +
        `entry whose fullyQualifiedName is '${m.fullyQualifiedName}'.`);
    ds.source = m.name;
    doc.modified = true;
    return;
  }
  const left = `${dsLabel}: left bare source '${source}' as written, since `;
  if (matches.length) {
    const names =
        matches.map(m => `'${m.name}' (${m.fullyQualifiedName})`).join(', ');
    doc.warnOrError(
        `${left}several entries in entry group '${group}' have a ` +
        `fullyQualifiedName that ends in it: ${names}. 'kcmd push' rejects ` +
        `the file until the source names one of them.`);
  } else {
    doc.warnOrError(
        `${left}no entry for a table or view in entry group '${group}' has ` +
        `a fullyQualifiedName that ends in it. 'kcmd push' rejects the file ` +
        `until the source is the table's GCP resource name. ` +
        THIRD_PARTY_SOURCE);
  }
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
 * table names against `doc.sourcePrefix` or completing them from
 * `doc.entryTables`, and warning on unaccepted sources), truncates its
 * `description`, and repairs each of its `fields`.
 */
function repairDataset(ds: Record<string, any>, doc: ImportDocument): void {
  // 1. Repair or diagnose `ds.source`: remove query-valued sources (in the
  // Google version), qualify bare table names against `doc.sourcePrefix` or
  // complete them from `doc.entryTables`, or warn on unaccepted source
  // formats.
  const dsLabel = `dataset '${ds.name}'`;
  if (typeof ds.source === 'string') {
    const trimmed = ds.source.trim();
    const qualified = doc.sourcePrefix ?
        qualifyTableSource(trimmed, doc.sourcePrefix) :
        undefined;
    const parts = doc.entryTables ? sourceParts(trimmed) : undefined;
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
    } else if (parts) {
      completeFromEntryGroup(ds, trimmed, parts, doc);
    } else if (sourceError(trimmed, dsLabel) !== undefined) {
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
      } else if (p?.child && sourceParts(trimmed, p)?.length === 1 &&
                 completes(trimmed, prefixKinds(p))) {
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
  // `sourcesDialect`, and repair or prune each metric (`repairMetric`). The
  // pruning infers each metric's entity, so it reads an ANSI_SQL text whose
  // dialect no lookup gave as generic SQL, as the loader's inference does.
  const entityNames = doc.datasets.map(ds => ds.name)
                          .filter((n): n is string => typeof n === 'string');
  const impliedDialect = sourcesDialect({
    entities: doc.datasets.map(
        ds => ({
          abstract: Boolean(ds.abstract),
          authoredSource: typeof ds.source === 'string' ? ds.source : undefined,
          dataSource: '',
        })),
  }) ?? undefined;
  doc.metrics = doc.metrics.filter(
      mt => repairMetric(mt, entityNames, impliedDialect, doc));
  if (Array.isArray(doc.model.metrics) && doc.model.metrics.length) {
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
 * writes any newly added `BIGQUERY` dialect entries back onto `doc`, including
 * the field bindings of each BigQuery profile (`isBigQueryProfile`) in the
 * model's `GOOGLE` blocks. Translates the BigQuery profiles among
 * `profileFiles` the same way and returns every file. A warning about a JSON
 * profile file names the matching file of `inputFiles`.
 */
async function transpileDocument(
    doc: ImportDocument, profileFiles: SerializedFile[],
    inputFiles = profileFiles): Promise<SerializedFile[]> {
  let preLoaded: ReturnType<typeof fromDocument>;
  try {
    preLoaded = fromDocument(
        doc.root, {bindingOptional: true, warnUnacceptedSource: true});
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
    return profileFiles;
  }
  const syncNode = (...args: Parameters<typeof syncDialects>) => {
    if (syncDialects(...args)) doc.modified = true;
  };
  // Each of `profileFiles` as loaded, or undefined for one that does not
  // load. That one is written as it is when it parses, since push reports it.
  const loaded = profileFiles.map(pf => {
    try {
      return loadProfileFile(
          pf.content, parseProfileName(pf.fileName), {skipActions: true});
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
      return undefined;
    }
  });
  let translatedFiles = profileFiles;
  for (const m of preLoaded.models) {
    const transpiled = await transpileModel({
      ...m,
      profiles: [...(m.profiles ?? []), ...loaded.filter(p => p !== undefined)],
    }, {translatesProfile: isBigQueryProfile});
    doc.warnings.push(...transpiled.warnings);
    const profile = (name: unknown) =>
        transpiled.model.profiles?.find(p => p.name === name);
    translatedFiles = profileFiles.map((pf, i) => {
      const p = loaded[i] && profile(loaded[i].name);
      const named = {...pf, fileName: inputFiles[i].fileName};
      return p ? {...pf, content: withDialects(named, p, doc)} : pf;
    });
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
    // A profile in a GOOGLE block is JSON text, so a block whose profiles
    // gained an entry is written back as JSON.
    for (const block of asRecords(doc.model.custom_extensions)) {
      const data = parseGoogleBlocks([block])[0];
      let changed = false;
      for (const p of asRecords(data?.profiles)) {
        changed = syncProfile(p, profile(p.name)) || changed;
      }
      if (changed) {
        block.data = JSON.stringify(data);
        doc.modified = true;
      }
    }
  }
  return translatedFiles;
}

// Whether `profile` is a BigQuery profile of `model`, by the rule push's import
// hint uses: each source push accepts that it states for a concrete entity of
// `model` is a BigQuery or BigLake table, and it states at least one.
function isBigQueryProfile(profile: ProfileSpec, model: SemanticModel): boolean {
  const concrete =
      new Set(model.entities.filter(e => !e.abstract).map(e => e.name));
  const entities = profile.entities.flatMap(
      ({name, source}) => concrete.has(name) && source !== undefined &&
              sourceError(source, '') === undefined ?
          [{authoredSource: source, dataSource: source}] :
          []);
  return sourcesDialect({entities}) === 'BIGQUERY';
}

/**
 * Adds to `rawNode.expression` each dialect entry, such as `BIGQUERY`, that
 * `transpileModel` appended to `irDialects`, and returns whether it added any.
 * The entries already in a dialects list stay as written.
 */
function syncDialects(
    rawNode: Record<string, any>,
    irDialects: Array<{dialect: string; expression: string}>|undefined):
    boolean {
  const dialects = rawNode.expression?.dialects;
  const prevCount = typeof rawNode.expression === 'string' ?
      1 :
      asRecords(dialects).length;
  if (prevCount === 0 || !irDialects || irDialects.length <= prevCount) {
    return false;
  }
  const entries = irDialects.map(
      d => ({dialect: d.dialect, expression: d.expression}));
  if (typeof rawNode.expression === 'string') {
    rawNode.expression = {dialects: entries};
  } else {
    dialects.push(...entries.slice(prevCount));
  }
  return true;
}

/**
 * Writes onto the raw profile `p` each field expression that gained a dialect
 * entry in the translated `irProfile`, and returns whether any did.
 */
function syncProfile(
    p: Record<string, any>, irProfile: ProfileSpec|undefined): boolean {
  let changed = false;
  for (const pe of asRecords(p.entities)) {
    const irEntity = irProfile?.entities.find(x => x.name === pe.name);
    for (const f of asRecords(pe.fields)) {
      const irField = irEntity?.fields?.find(x => x.name === f.name);
      changed = syncDialects(f, irField?.dialects) || changed;
    }
  }
  return changed;
}

/**
 * Returns the content of the profile file `file` with each field expression
 * that gained a dialect entry in the translated `profile`, written as the
 * model file is. A JSON file that changes is written as YAML, and a warning
 * on `doc` names it.
 */
function withDialects(
    {fileName, content}: SerializedFile, profile: ProfileSpec,
    doc: ImportDocument): string {
  const {document, text} = parseForUpdate(content);
  const root = plainCopy(document.toJS()) as Record<string, any>;
  const links = linkNodes(root, document.contents);
  if (!syncProfile(root, profile)) return content;
  if (text !== content) doc.warnings.push(`Converted '${fileName}' to YAML.`);
  return writeDocument({document, links, text}, root);
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
 * Records push's error for the profile files `profileFiles` beside a vanilla
 * input in `modelFile`, which keeps its profiles in its `GOOGLE` block. Push
 * checks the name of each file first. The message is an error in strict mode
 * and a warning otherwise.
 */
function checkVanillaProfileFiles(
    doc: ImportDocument, profileFiles: SerializedFile[],
    modelFile: string): void {
  if (doc.inputVersion !== OSSIE_VERSION || profileFiles.length === 0) return;
  const badName =
      profileFiles
          .map(pf => profileNameError(pf.fileName, parseProfileName(pf.fileName)))
          .find(e => e !== undefined);
  doc.warnOrError(
      badName ?? vanillaSiblingError(profileFiles[0].fileName, modelFile));
}

/**
 * Loads each sibling `<model>.profile.<name>.yaml` entry in `profileFiles` via
 * `loadProfileFile` and attaches the resulting `ProfileSpec` list to
 * `model.profiles`. Records in `doc.errors` push's error for the first file
 * that breaks a file rule beside `modelFile`, or each profile's load error
 * labeled with its file.
 */
function attachProfileFiles(
    model: SemanticModel, profileFiles: SerializedFile[]|undefined,
    doc: ImportDocument, modelFile: string): void {
  const files = (profileFiles ?? []).map(
      pf => ({...pf, name: parseProfileName(pf.fileName)}));
  // Push checks every file's name before it loads any profile, and stops at
  // the first file that breaks a file rule.
  const seen = new Map<string, string>();
  try {
    for (const pf of files) {
      checkProfileFileName(modelFile, pf.fileName, pf.name, pf.content, seen);
    }
  } catch (err) {
    if (!(err instanceof ProfileFileError)) throw err;
    doc.errors.push(err.message);
    return;
  }
  const profiles: ProfileSpec[] = [];
  for (const pf of files) {
    try {
      profiles.push(loadProfileFile(pf.content, pf.name));
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
      doc.errors.push(`[${pf.fileName}] ${err.message}`);
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
    attachProfileFiles(
        model, opts.profileFiles, doc, opts.fileName ?? `${model.name}.yaml`);
    validateOssieConversion(model, doc);
    if (doc.errors.length > 0) return [];
  }
  return generateAdaptedFiles(doc, !!opts.transpile, opts.profileFiles);
}

/**
 * Phase 4 (Adapt): Adapts `doc` in place to its target version
 * (`moveConstructs`, then `adaptToGoogleVersion` or `adaptToOssieVersion`),
 * optionally transpiles expressions via `transpileDocument`, and returns the
 * output files: the model file, then the profile files. An import that keeps
 * the flavor writes `profileFiles` under the model's name. Every value these
 * steps do not change keeps its text.
 */
async function generateAdaptedFiles(
    doc: ImportDocument, transpile: boolean,
    profileFiles: SerializedFile[] = []): Promise<SerializedFile[]> {
  // 1. Adapt `doc` in place to the target output version (`0.2.0.dev0/google`
  // or `0.2.0.dev0`). Each of `profileFiles` goes under the model's name. A
  // nameless `<file>.profile.yaml` stays nameless, so push reports it.
  let profiles = doc.inputVersion === doc.targetVersion ?
      profileFiles.map(pf => ({
        fileName: /\.profile\.ya?ml$/i.test(pf.fileName) &&
                parseProfileName(pf.fileName) === '' ?
            `${doc.model.name}.profile.yaml` :
            `${doc.model.name}.profile.${parseProfileName(pf.fileName)}.yaml`,
        content: pf.content,
      })) :
      moveConstructs(doc, profileFiles);
  if (doc.inputVersion === OSSIE_VERSION &&
      doc.targetVersion === GOOGLE_VERSION) {
    adaptToGoogleVersion(doc);
  } else if (doc.targetVersion === OSSIE_VERSION) {
    adaptToOssieVersion(doc);
  }

  // 2. When `transpile` is enabled and no prior errors occurred, translate
  // vendor or double-quoted `ANSI_SQL` expressions to `BIGQUERY`, in the model
  // and in each BigQuery profile, in its GOOGLE blocks or among `profiles`.
  if (transpile && doc.errors.length === 0) {
    profiles = await transpileDocument(
        doc, profiles,
        doc.inputVersion === doc.targetVersion ? profileFiles : profiles);
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
function writeDocument(
    doc: Pick<ImportDocument, 'document'|'links'|'text'>,
    root: Record<string, any>): string {
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
 * Phase 5 (Post-validation): Validates the output model file with `loadModels`
 * (`warnUnacceptedSource: !doc.strict`), checks deployment targets, and checks
 * the model file's own bindings, each profile the output declares and each
 * deployment as push does.
 */
function validateOutputDocument(
    files: SerializedFile[], doc: ImportDocument,
    opts: ImportSemanticModelOptions): void {
  const [{fileName, content}, ...profileFiles] = files;
  try {
    // 1. Load the serialized output YAML with `loadModels`
    // (`warnUnacceptedSource: !doc.strict`) to run full schema and semantic
    // validation while turning unaccepted table sources into warnings in
    // non-strict mode, deduplicating warnings already recorded. Step 3 gives
    // push's error for a field its table cannot run, so the load does not
    // warn about it too.
    const loaded = loadModels(
        content, {
          bindingOptional: true,
          warnUnacceptedSource: !doc.strict,
          fieldTextChecked: true,
        });
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

    // 3. Check the model file's own bindings, each profile file, under the
    // layout's file rules, and each GOOGLE block profile with push's offline
    // checks. What push rejects is an error in strict mode and a warning
    // otherwise. Nothing is written on an error, so in strict mode each
    // message names where the input holds the bindings.
    const input = doc.strict ? opts.fileName : undefined;
    const model = {
      name: (input ?? fileName).replace(/\.ya?ml$/, ''),
      text: content,
    };
    // Where the input holds profile `name`, which the output writes in
    // `written`: its profile file, or the model file's GOOGLE block.
    const inputFiles =
        doc.inputVersion === GOOGLE_VERSION ? opts.profileFiles ?? [] : [];
    const where = (name: string, written: string) => !input ? written :
        inputFiles.find(pf => parseProfileName(pf.fileName) === name)
                ?.fileName ??
            model.name;
    const profileDocs = () => {
      const seen = new Map<string, string>();
      return profileFiles.map(f => {
        const name = parseProfileName(f.fileName);
        const label = where(name, f.fileName);
        checkProfileFileName(input ?? fileName, label, name, f.content, seen);
        return {name, text: f.content, fileName: label};
      });
    };
    const declared = () => declaredProfiles(model, profileDocs()).map(
        p => 'spec' in p ? {...p, label: where(p.name, model.name)} : p);
    for (const e of [
           ...validateInlineDialects(loaded.models[0], model.name),
           ...validateInheritedColumns(loaded.models[0], model.name),
         ]) {
      doc.warnOrError(e);
    }
    const errors = namedProfileErrors(
        [model], new Map([[model.name, loaded.models[0]]]), profileDocs,
        declared, doc.warnings, {});
    for (const e of errors) doc.warnOrError(e.error);
    // Push also warns about the values each profile without an error sets.
    let profiles: DeclaredProfile[];
    try {
      profiles = declared();
    } catch (err) {
      // namedProfileErrors reports a profile file that breaks a file rule,
      // which stops push before it checks a deployment.
      if (!(err instanceof ProfileFileError)) throw err;
      return;
    }
    const own = loaded.warnings.map(w => `[${model.name}] ${w}`);
    for (const {name} of profiles) {
      if (errors.some(e => e.profile === name)) continue;
      doc.warnings.push(...appliedProfileWarnings(model, profiles, name, own));
    }
    // Push stops at a source its loader rejects.
    if (loaded.warnings.some(w => LOADER_SOURCE_WARNING.test(w))) return;
    doc.warnings.push(...inlineBindingWarnings(
        loaded.models[0], model.name,
        profiles.some(p => p.name.toLowerCase() !== DEFAULT_PROFILE)));

    // 4. Check each deployment with push's offline checks, under the profile
    // it names. A profile file that does not load is reported above. A
    // deployment whose profile has an error gets no table check, so a bad
    // source is reported once.
    const withFiles = {...loaded.models[0]};
    withFiles.profiles = [
      ...withFiles.profiles ?? [],
      ...profiles.flatMap(p => {
        try {
          return 'text' in p ?
              [loadProfileFile(p.text, p.name, {skipActions: true})] :
              [];
        } catch (err) {
          if (!(err instanceof SemanticModelError)) throw err;
          return [];
        }
      }),
    ];
    const every = resolveModelDeployments(withFiles);
    const deployments = 'error' in every ? [] : every.deployments;
    for (const e of [
           undeclaredProfileError(
               model.name, withFiles, profiles.map(p => p.name)) ?? [],
           ...[...new Set(deployments.map(d => d.profile))].flatMap(
               profile => validateDeployments({
                 ...withFiles,
                 deployments: withFiles.deployments?.filter(
                     d => (d.profile ?? DEFAULT_PROFILE) === profile),
               }, model.name)),
           ...deployments
               .filter(d => !errors.some(e => e.profile === d.profile))
               .flatMap(d => deploymentTableErrors(model.name, withFiles, d)),
           ...deployments.flatMap(
               d => spannerMetricsErrors(model.name, withFiles, d)),
         ].flat()) {
      doc.warnOrError(e);
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
  // 1. Initialize the SQL parser and parse/pre-validate the input document,
  // and report any profile file beside a vanilla input as push does.
  await loadSqlEngine();
  const doc = parseImportDocument(rawYaml, opts);
  if (typeof doc === 'string') {
    return {ok: false, files: [], warnings: [], errors: [doc]};
  }
  validateInputDocument(doc);
  checkVanillaProfileFiles(
      doc, opts.profileFiles ?? [], opts.fileName ?? `${doc.model.name}.yaml`);

  // 2. Read the `--source-prefix` entry group, if needed, and run third-party
  // repairs (which record errors in `strict` mode).
  const listError = await listEntryTables(doc);
  if (listError) {
    return {
      ok: false,
      files: [],
      warnings: doc.warnings,
      errors: [...doc.errors, listError],
    };
  }
  repairDocument(doc);

  // 3. Generate the converted or adapted output file(s). A conversion to
  // `0.2.0.dev0` writes the sibling profile files inside the model file, and
  // a Google-flavor import of a Google-flavor model writes them beside it.
  const shouldConvert = doc.inputVersion !== doc.targetVersion && doc.strict;
  const googleToGoogle = doc.inputVersion === GOOGLE_VERSION &&
      doc.targetVersion === GOOGLE_VERSION;
  const files = shouldConvert ?
      await generateConvertedFiles(doc, opts) :
      await generateAdaptedFiles(
          doc, !!opts.transpile, googleToGoogle ? opts.profileFiles ?? [] : []);

  // 4. Check that each profile file the import writes parses, validate the
  // output files, and return the result.
  for (const [i, f] of files.slice(1).entries()) {
    const [problem] = yaml.parseDocument(f.content, YAML_OPTIONS).errors;
    if (!problem) continue;
    // A file import passes through unchanged is the input's own file.
    const input = opts.profileFiles?.[i];
    doc.errors.push(
        input?.content === f.content ?
            profileParseError(input.fileName, problem.message) :
            `the import writes '${f.fileName}', which does not parse: ${
                problem.message}`);
  }
  if (files.length > 0 && doc.errors.length === 0) {
    validateOutputDocument(files, doc, opts);
  }
  return {
    ok: doc.errors.length === 0,
    files: doc.errors.length === 0 ? files : [],
    warnings: doc.warnings,
    errors: doc.errors,
  };
}
