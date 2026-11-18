// Imports a third-party (or first-party) semantic model YAML document into a
// valid kcmd semantic model document.

import {isDeepStrictEqual} from 'node:util';
import * as yaml from 'yaml';

import {checkProfileFileName, ProfileFileError, profileNameError, profileParseError, vanillaSiblingError} from '../layouts/semantic-model';
import {checkCatalogAspects} from './deploy_knowledge_catalog';
import {deploymentTargetError, targetProblem} from './deployment_target';
import {ALLOWED_DIALECTS, isFieldBound, normalizeDataType, OSSIE_SQL, ProfileSpec, SemanticModel, SqlDialect} from './ir';
import {bareNameParts, bareNameSegments, ConstructPlacement, dialectLookupKey, dottedPartProblem, entityWord, fillForm, FORMAT_VERSION_PLACEMENT, FormatVersion, fromDocument, GOOGLE_VENDOR, GOOGLE_VERSION, hasGoogleBlock, hasUnquotedWhitespace, isAcceptedSource, isFormatVersion, isGoogleCloudForm, isGoogleVendor, isRecord, loadModels, metricTableEntities, modelAiContexts, NO_SPACE, noSqlReason, oldSourceForm, OSSIE_ROOT_VERSION, OSSIE_VERSION, parseSource, rootModelVersion, SemanticModelError, TABLE_FORMS, THIRD_PARTY_SOURCE} from './loader';
import {MAX_ENTRY_DESCRIPTION, NameKind, nameProblem} from './names';
import {SerializedFile} from './osi_converter';
import {sentence} from './parameters';
import {updatedData} from './pull_update';
import {declaredProfiles, DialectLoad, loadProfileFile, namedProfileErrors, plainCopy, ProfileFiles, readerMessage, sourcesDialect, transpilesSomething, TranspileOutcomes} from './resolve_profiles';
import {LabeledText, SourceDialects, sourcesToLookUp, tableFqnParts} from './source_dialect';
import {OssieNode, ossieNodes, ossieReferences, ossieTree} from './ossie_parser';
import {columnReferences, columnsForSource, entitiesReached, isColumnName, requalified, withoutQualifier} from './sql_expr_utils';
import {loadSqlEngine, soleColumn} from './sql_parser';
import {hasDoubleQuotedColumn, transpileModel} from './transpile';
import {localChecks, pruningLines, withProfileFiles, yamlChangedStatementErrors} from './validate';
import {documentValue, YAML_OPTIONS, yamlErrorMessage} from './yaml_options';
import {linkNodes, movedItems, nodeJson, parseForUpdate, spliced, updateText, wrappedRoot} from './yaml_update';

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
  /**
   * Reads the dialect of each Cloud SQL, Spanner and third-party table the
   * files `files` name, as `sourceDialects` does for push. Without it, the
   * dialect of each such table is unknown.
   */
  readDialects?: (files: LabeledText[]) => Promise<SourceDialects>;
  /**
   * When true, push's checks read an ANSI_SQL text on a table whose dialect
   * no lookup read as DialectLoad.readWithoutDialect says. Pull sets it for
   * the import it runs with no table's dialect read, as its own checks read.
   */
  readWithoutDialect?: boolean;
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
  /**
   * Whether the import writes `files`, the model file first, with the model
   * file over the input file. An import that stops writes nothing over it.
   * A third-party import asks. When it writes over its input, the import
   * that the advice to add a BigQuery text suggests reads `files`. When the
   * written file also has a `GOOGLE` block, a message that names an import
   * command names one with `--input first-party`, which reads that file.
   */
  overwritesInput?: (files: SerializedFile[]) => Promise<boolean>;
  /**
   * The first error the import that the advice to add a BigQuery text
   * suggests would stop on, or null when it would write its files. That
   * import is this one again with `--transpile`. With `readsWritten`, it
   * reads `files`, which this import writes over its input, and with
   * `firstParty` it takes `--input first-party`. Called only when that advice
   * may be given. Without it, the advice names the command alone.
   */
  transpileOutcome?:
      (files: SerializedFile[], readsWritten: boolean,
       firstParty: boolean) => Promise<string|null>;
}

/** Lists the entries of an entry group. */
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
  tableParts?: number;
  defaultSchema?: string;
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
  /**
   * The dialect `sourcesDialect` gives the repaired sources, in which push
   * reads an `ANSI_SQL` text of the model file. Set by the repair step.
   */
  impliedDialect?: string|null;
  /** The version of an Ossie file that held its model at the document root. */
  rootVersion?: string;
  /** The editor schema line import removes, which it reports when it writes. */
  schemaLine?: string;
  /** The line that reports the hyphens import gave the model name, if any. */
  hyphenation?: string;
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
  /**
   * Reports a repair: `done`, what import changed, as a warning, or in strict
   * mode, which writes nothing, `needed`, what the input needs, as an error.
   */
  repair: (done: string, needed: string) => void;
}

const STANDARD_AI_CONTEXT_KEYS =
    new Set(['instructions', 'synonyms', 'examples']);

// The loader's warning for a source it leaves as written.
const LOADER_SOURCE_WARNING =
    /^(.*?): source '(.*)' is not a valid GCP resource name\.$/s;

// Why no name to write is given when the name holds a quote.
const NO_QUOTE = 'kcmd cannot name a table whose name holds a quote';

// Each kind of --source-prefix for the service `prefix` names, or every kind
// when there is no prefix. The prefix's own kind comes first, so advice names
// its form.
function prefixKinds(prefix?: ParsedSourcePrefix):
    typeof SOURCE_PREFIX_PATTERNS {
  const host = prefix?.base.split('/')[0];
  const own = prefix &&
      SOURCE_PREFIX_PATTERNS.find(k => k.re.test(prefix.base))?.form;
  return SOURCE_PREFIX_PATTERNS.filter(
      k => host === undefined || k.form.startsWith(`${host}/`))
      .sort((a, b) => Number(b.form === own) - Number(a.form === own));
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
  // Only the table's own name, the last part, may hold a space, and not at
  // its end. No part may hold any other whitespace.
  const segments = bareNameSegments(source, true);
  const spaced = segments.slice(0, -1).some(s => /\s/.test(s)) ||
      /[^\S ]|\s$/.test(segments.at(-1) ?? '');
  const cannot = !bare || rerun ? undefined :
      spaced                   ? NO_SPACE :
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
      (rerun ? `, or until 'kcmd import' runs again with ${
                   prefix ? 'a different ' : ''}'--source-prefix'.` :
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

// Each vendor dialect label, with the dialect it names, and the dialect it
// names instead when every table that runs it has that dialect: GoogleSQL is
// SPANNER on a GoogleSQL Spanner table, and PostgreSQL is ALLOYDB on an
// AlloyDB table.
const DIALECT_ALIASES:
    Readonly<Record<string, readonly [SqlDialect, SqlDialect?]>> = {
  GOOGLE_SQL: ['BIGQUERY', 'SPANNER'],
  GOOGLESQL: ['BIGQUERY', 'SPANNER'],
  POSTGRESQL: ['POSTGRES', 'ALLOYDB'],
  TSQL: ['SQLSERVER'],
};

// Entity `ds` as sourcesDialect reads it, with the dialect `load` gives its
// table.
function lookedUpEntity(ds: Record<string, any>, load: DialectLoad) {
  const source = typeof ds.source === 'string' ? ds.source : undefined;
  const key = source && dialectLookupKey(source.trim());
  return {
    abstract: Boolean(ds.abstract),
    authoredSource: source,
    dataSource: '',
    sourceDialect: key ? load.sourceDialects?.get(key) : undefined,
  };
}

// The dialect of entity `ds`'s own table, as push reads it with the dialects
// `load` gives. Undefined when it has no table.
function tableDialect(
    ds: Record<string, any>, load: DialectLoad): string|null|undefined {
  return sourcesDialect({entities: [lookedUpEntity(ds, load)]});
}

// Each kind of --source-prefix: its pattern, the child container a bare name
// adds under it, if any, the resource name of a table under it, the most
// parts a table's name takes where that is more than one, and the schema a
// table's name leaves out, if any.
const SOURCE_PREFIX_PATTERNS: ReadonlyArray<{
  re: RegExp;
  child?: string;
  form: string;
  tableParts?: number;
  defaultSchema?: string;
}> = [
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
    re: /^biglake\.googleapis\.com\/projects\/([^/]+)\/catalogs\/([^/.]+)\/databases\/([^/.]+)$/,
    form: TABLE_FORMS.biglakeHive,
  },
  {
    re: /^spanner\.googleapis\.com\/projects\/([^/]+)\/instances\/([^/]+)\/databases\/([^/]+)$/,
    form: TABLE_FORMS.spanner,
    // A table in a named schema is named '<schema>.<table>'.
    tableParts: 2,
    // In a PostgreSQL-dialect Spanner database, a table in the default schema
    // `public` has no schema in its Knowledge Catalog name, so
    // `public.stations` is the table `stations`.
    defaultSchema: 'public',
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

// An Apache Ossie file with its model at the document root: a '0.3.0.dev0'
// file, or a '0.2.0.dev0' file as the Ossie converters write it. Import wraps
// the model in `semantic_model`, moves each dataset's metrics to the model,
// and converts what kcmd writes another way, reporting each edit.

/** A metric a dataset listed, which import moves to the model's metrics. */
interface MovedMetric {
  metric: Record<string, any>;
  /** The name of the dataset that listed it. */
  dataset: string;
  /** Its name as written. */
  name: string;
}

/** A name as a text writes it, without quotes, and whether quotes wrap it. */
interface WrittenName {
  name: string;
  quoted: boolean;
}

/**
 * A column name a text reads: where it sits, in code units with the end
 * excluded, from its qualifier when it has one, and its parts.
 */
interface TextName {
  start: number;
  nameStart: number;
  end: number;
  qualifier?: WrittenName;
  name: WrittenName;
}

// The editor schema line, which names the schema of the file's version.
const SCHEMA_LINE =
    /^[ \t]*#[ \t]*yaml-language-server:[ \t]*\$schema=.*(?:\r?\n|$)/m;

/**
 * Why import stops on `doc`, the value of its input, or undefined: a
 * '0.3.0.dev0' file with a `semantic_model` list, an Ossie file with its model
 * at the document root under `--input first-party` (`strict`), or a GOOGLE
 * block in such a file.
 */
function ossieFileError(doc: unknown, strict: boolean): string|undefined {
  if (isRecord(doc) && doc.version === OSSIE_ROOT_VERSION &&
      'semantic_model' in doc) {
    return `Document is a '${OSSIE_ROOT_VERSION}' file with a ` +
        `'semantic_model' list; such a file holds its model at the document ` +
        `root. Move the model's keys to the root in place of 'semantic_model'.`;
  }
  const version = rootModelVersion(doc);
  if (version === undefined) return undefined;
  if (strict) {
    return `Document is an Apache Ossie '${version}' file with its model at ` +
        `the document root, which kcmd never writes; import it without ` +
        `'--input first-party'.`;
  }
  const model = doc as Record<string, any>;
  const datasets = asRecords(model.datasets);
  const objects = [
    model, ...datasets, ...asRecords(model.relationships),
    ...asRecords(model.metrics),
    ...datasets.flatMap(ds => [...asRecords(ds.fields), ...asRecords(ds.metrics)]),
  ];
  return objects.some(
             o => hasGoogleBlock(asRecords(o.custom_extensions)) ||
                 hasGoogleBlock(asRecords(o.nonportable_extensions))) ?
      `Document holds a '${GOOGLE_VENDOR}' extension block, which kcmd never ` +
          `writes in a file with the model at the document root; remove it.` :
      undefined;
}

/**
 * Why import leaves the `metrics` of `ds`, a dataset of `model`, an Ossie
 * model's value, as written, or undefined when it moves them to the model.
 * Import moves a list of mappings that each have a string `name`, when the
 * model's own `metrics` is a list or empty.
 */
function keptMetricsReason(
    model: Record<string, any>, ds: Record<string, any>): string|undefined {
  if (model.metrics != null && !Array.isArray(model.metrics)) {
    return `the model's 'metrics' is not a list`;
  }
  if (!Array.isArray(ds.metrics)) return 'it is not a list';
  const i = ds.metrics.findIndex(
      (m: unknown) => !isRecord(m) || typeof m.name !== 'string');
  return i < 0 ? undefined : `metric number ${i + 1} has no string 'name'`;
}

/**
 * The datasets of `model`, an Ossie model's value, whose metrics import moves
 * to the model (see keptMetricsReason).
 */
function movingDatasets(model: Record<string, any>): Array<Record<string, any>> {
  return asRecords(model.datasets).filter(
      ds => 'metrics' in ds && keptMetricsReason(model, ds) === undefined);
}

/**
 * Moves the metrics each of `datasets`, datasets of `model`, lists to the end
 * of the model's `metrics`, and removes each dataset's `metrics`.
 */
function moveDatasetMetrics(
    model: Record<string, any>, datasets: Array<Record<string, any>>): void {
  const metrics = datasets.flatMap(ds => ds.metrics);
  for (const ds of datasets) delete ds.metrics;
  if (!metrics.length) return;
  if (!Array.isArray(model.metrics)) model.metrics = [];
  model.metrics.push(...metrics);
}

/**
 * `text`, which `document` parses and which holds an Ossie model at the
 * document root, with the model wrapped in `semantic_model`, and then with the
 * metrics its datasets list moved to the model (see movingDatasets). Each edit
 * is made on the text, so every comment stays, when the edited text reads as
 * the edited value. Gives the text, its document and the edits made.
 */
function rootModelText(text: string, document: yaml.Document.Parsed): {
  text: string; document: yaml.Document.Parsed; wrapped: boolean;
  moved: boolean;
} {
  // A text whose alias no longer finds its anchor does not read back.
  const edited = (t: string, value: unknown) => {
    const d = parseForUpdate(t).document;
    try {
      return !d.errors.length && isDeepStrictEqual(d.toJS(), value) ?
          {text: t, document: d} :
          undefined;
    } catch {
      return undefined;
    }
  };
  // A plain copy, so that an alias and its anchor are two values.
  const {version, ...model} = plainCopy(document.toJS());
  // A root with no key but `version` has nothing to move by text.
  const wrapped = Object.keys(model).length ?
      edited(
          wrappedRoot(text, document, 'semantic_model', 'version'),
          {version, semantic_model: [model]}) :
      undefined;
  if (!wrapped) return {text, document, wrapped: false, moved: false};
  const datasets = movingDatasets(model);
  const at = datasets.map(ds => model.datasets.indexOf(ds));
  moveDatasetMetrics(model, datasets);
  const list = wrapped.document.getIn(['semantic_model', 0, 'datasets'], true);
  const sources = at.map(i => yaml.isSeq(list) ? list.items[i] : undefined);
  const movedText = sources.every(yaml.isMap) ?
      movedItems(
          wrapped.text, wrapped.document, sources,
          wrapped.document.getIn(['semantic_model', 0], true) as yaml.YAMLMap,
          'metrics') :
      undefined;
  const moved = movedText === undefined ?
      undefined :
      edited(movedText, {version, semantic_model: [model]});
  return moved ? {...moved, wrapped: true, moved: true} :
                 {...wrapped, wrapped: true, moved: false};
}

/**
 * Renames key `from` of `obj`, an object of `doc.root`, to `to`, in its place
 * among the keys, and in `doc.document`, so the writer changes only the key.
 */
function renameKey(
    doc: ImportDocument, obj: Record<string, any>, from: string,
    to: string): void {
  const entries = Object.entries(obj);
  for (const k of Object.keys(obj)) delete obj[k];
  for (const [k, v] of entries) obj[k === from ? to : k] = v;
  renameDocumentKey(doc, obj, from, to);
}

/** Renames key `from` of the node of `obj` in `doc.document` to `to`. */
function renameDocumentKey(
    doc: ImportDocument, obj: object, from: string, to: string): void {
  const node = doc.links.get(obj);
  const pair = yaml.isMap(node) ?
      node.items.find(p => yaml.isScalar(p.key) && p.key.value === from) :
      undefined;
  if (pair) (pair.key as yaml.Scalar).value = to;
}

/**
 * Whether `written`, a name as a text or an Ossie file writes it, names
 * `declared`, as Ossie compares names: a name without quotes matches in any
 * letter case, and a quoted name matches the declared name in upper case, as
 * Ossie stores a name written without quotes.
 */
function ossieMatches(written: WrittenName, declared: string): boolean {
  return written.quoted ? written.name === declared.toUpperCase() :
                          written.name.toUpperCase() === declared.toUpperCase();
}

/**
 * The name `text`, a name an Ossie file writes in its YAML, such as a key
 * entry, reads as: a name in double quotes is a quoted name, with each `""`
 * read as one quote.
 */
function yamlName(text: string): WrittenName {
  const quoted = /^"((?:[^"]|"")*)"$/.exec(text);
  return quoted ? {name: quoted[1].replace(/""/g, '"'), quoted: true} :
                  {name: text, quoted: false};
}

/**
 * The dataset of `doc` that `written`, a dataset name an Ossie file writes in
 * its YAML (see yamlName), names as Ossie compares names, or undefined.
 */
function datasetNamed(
    doc: ImportDocument, written: unknown): Record<string, any>|undefined {
  return typeof written === 'string' ?
      doc.datasets.find(
          ds => typeof ds.name === 'string' &&
              ossieMatches(yamlName(written), ds.name)) :
      undefined;
}

/**
 * Each text of `obj.expression` in a dialect kcmd reads, with that dialect and
 * a function that replaces the text. A string expression is an ANSI_SQL text,
 * and a vendor label reads as the first dialect DIALECT_ALIASES gives it.
 */
function expressionTexts(obj: Record<string, any>):
    Array<{text: string; dialect: string; set: (text: string) => void}> {
  if (typeof obj.expression === 'string') {
    return [{
      text: obj.expression,
      dialect: 'ANSI_SQL',
      set: t => void (obj.expression = t),
    }];
  }
  return asRecords(obj.expression?.dialects).flatMap(d => {
    const upper =
        typeof d.dialect === 'string' ? d.dialect.trim().toUpperCase() : '';
    const dialect = ALLOWED_DIALECT_SET.has(upper) ? upper :
                                                     DIALECT_ALIASES[upper]?.[0];
    return dialect && typeof d.expression === 'string' ?
        [{text: d.expression, dialect, set: (t: string) => void (d.expression = t)}] :
        [];
  });
}

/**
 * The column field `f` reads, as its first text names it (see
 * expressionTexts), when that text is the column alone. A qualified name
 * there names a sibling field. Undefined otherwise.
 */
function fieldColumn(f: Record<string, any>): WrittenName|undefined {
  const [first] = expressionTexts(f);
  const column = first && soleColumn(first.text, first.dialect);
  if (!column || column.qualifier !== undefined) return undefined;
  // An OSSIE_SQL_2026 text, which parses, says whether quotes wrap the name.
  const [read] = first.dialect === OSSIE_SQL ? textNames(first.text) ?? [] : [];
  return read?.name ?? {name: column.name, quoted: false};
}

// Whether `node` is a call of AGG, which takes a metric.
function isAggCall(node: OssieNode):
    node is Extract<OssieNode, {kind: 'functionCall'}> {
  return node.kind === 'functionCall' && !node.name.quoted &&
      node.name.name.toUpperCase() === 'AGG';
}

/**
 * The column names an OSSIE_SQL_2026 `text` reads, in the order written,
 * without the argument of a call of AGG, or undefined when the parser cannot
 * read it. A name of more than two parts, such as a struct path, is left out.
 */
function textNames(text: string): TextName[]|undefined {
  const tree = ossieTree(text);
  if (tree === undefined) return undefined;
  return (tree ? ossieReferences(tree, isAggCall) : [])
      .filter(parts => parts.length <= 2)
      .map(parts => ({
             start: parts[0].start,
             nameStart: parts.at(-1)!.start,
             end: parts.at(-1)!.end,
             qualifier: parts.length === 2 ? parts[0] : undefined,
             name: parts.at(-1)!,
           }));
}

/**
 * `<dataset>.<field>` as an OSSIE_SQL_2026 text writes it, with a part in
 * double quotes where the parser does not read the part bare as that name.
 */
function qualifiedName(dataset: string, field: string): string {
  const forms = [
    [dataset, field], [`"${dataset}"`, field], [dataset, `"${field}"`],
    [`"${dataset}"`, `"${field}"`],
  ].map(([d, f]) => `${d}.${f}`);
  return forms.find(form => {
    const column = soleColumn(form, OSSIE_SQL);
    return column?.qualifier === dataset && column.name === field;
  }) ?? forms[3];
}

/**
 * Writes each text of `obj`, which `label` names, with its names converted,
 * and reports each text it changes. In an OSSIE_SQL_2026 text, each column
 * name the parser reads is replaced by what `rewrite` gives for it, or kept
 * when that is undefined. Such a text the parser cannot read stays as written,
 * with a warning. A text in another dialect becomes what `vendor` gives for
 * it. The report on an ANSI_SQL text with a double-quoted word adds that
 * BigQuery reads such a word as text, when `onBigQuery` is set.
 */
function namesConverted(
    doc: ImportDocument, obj: Record<string, any>, label: string,
    rewrite: (name: TextName, text: string) => string|undefined,
    vendor: (text: string, dialect: string) => string,
    onBigQuery: boolean): void {
  for (const t of expressionTexts(obj)) {
    let after = t.text;
    if (t.dialect !== OSSIE_SQL) {
      after = vendor(t.text, t.dialect);
    } else {
      const names = textNames(t.text);
      if (!names) {
        doc.warnings.push(
            `${label}: left its '${t.dialect}' text as written, since kcmd ` +
            `cannot read it.`);
        continue;
      }
      after = spliced(t.text, names.flatMap((n): Array<[number, number, string]> => {
        const written = rewrite(n, t.text);
        return written === undefined ? [] : [[n.start, n.end, written]];
      }));
    }
    if (after === t.text) continue;
    const asText = onBigQuery && t.dialect === 'ANSI_SQL' && after.includes('"');
    doc.warnings.push(
        `${label}: wrote its '${t.dialect}' text '${t.text}' as '${after}'` +
        (asText ? ', and BigQuery would read its double-quoted words as text' :
                  '') +
        '.');
    t.set(after);
  }
}

/**
 * Converts the names in the texts of `doc` to kcmd's naming, and reports each
 * text it changes. A field text loses the qualifier that names its own
 * dataset. A metric a dataset listed (see `moved`) names that dataset's
 * fields as `<dataset>.<field>`, and its `source.<column>` as the field whose
 * text is exactly that column, which import adds when no field reads it. A
 * dataset or field name in another letter case takes its declared spelling.
 * A text in another dialect is read with push's qualifier functions, so it
 * gets the first conversion and the declared spelling of each dataset
 * qualifier only. A moved metric's such text that names fields without a
 * qualifier or reads `source.<column>` stays so, with a warning.
 */
function convertTextNames(doc: ImportDocument, moved: MovedMetric[]): void {
  const word = entityWord(doc.targetVersion);
  const named = doc.datasets.filter(ds => typeof ds.name === 'string');
  const fieldsOf = (ds: Record<string, any>|undefined) =>
      asRecords(ds?.fields).filter(f => typeof f.name === 'string');
  const datasetOf = (n: WrittenName) => named.find(ds => ossieMatches(n, ds.name));
  const fieldOf = (ds: Record<string, any>|undefined, n: WrittenName) =>
      fieldsOf(ds).find(f => ossieMatches(n, f.name));
  // Each way `text` writes `name` in any letter case. Push's qualifier
  // functions match a name as written.
  const spellings = (text: string, name: string) => new Set(text.match(
      new RegExp(name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'gi')));
  // Push's qualifier functions read an ANSI_SQL text as BigQuery, as its graph
  // runs it. Import reads it as ANSI SQL, where a double-quoted word is a
  // name, through the engine's generic dialect.
  const reading = (dialect: string) =>
      dialect === 'ANSI_SQL' ? 'generic' : dialect;
  // Push reads an ANSI_SQL text in the dialect the model's sources imply.
  const onBigQuery = sourcesDialect({
    entities: doc.datasets.map(ds => lookedUpEntity(ds, {})),
  }) === 'BIGQUERY';
  // A field text reads columns of its dataset's source without a qualifier.
  for (const ds of named) {
    for (const f of fieldsOf(ds)) {
      namesConverted(
          doc, f, `field '${ds.name}.${f.name}'`,
          (n, text) => n.qualifier && ossieMatches(n.qualifier, ds.name) ?
              text.slice(n.nameStart, n.end) :
              undefined,
          (text, dialect) => [...spellings(text, ds.name)].reduce(
              (t, s) => withoutQualifier(t, s, reading(dialect)), text),
          onBigQuery);
    }
  }
  for (const mt of doc.metrics) {
    const label = `metric '${mt.name}'`;
    const dataset = moved.find(m => m.metric === mt)?.dataset;
    const own = dataset === undefined ?
        undefined :
        named.find(ds => ds.name === dataset);
    // `<dataset>.<field>` for the field of `own` whose text is exactly column
    // `n`, which the text writes as `written`, added when no field reads it.
    const sourceField =
        (own: Record<string, any>, n: TextName, written: string) => {
          const stored = (c: WrittenName) =>
              c.quoted ? c.name : c.name.toUpperCase();
          const found = fieldsOf(own).find(f => {
            const c = fieldColumn(f);
            return c && stored(c) === stored(n.name);
          });
          if (found) return qualifiedName(own.name, found.name);
          const name = n.name.name;
          const lower = name.toLowerCase();
          const taken = fieldsOf(own).find(f => f.name.toLowerCase() === lower);
          // Push refuses a metric named like a field of its own entity. On a
          // BigQuery graph, it refuses one named like any field.
          const metric = doc.metrics.find(
              m => typeof m.name === 'string' && m.name.toLowerCase() === lower);
          const why = taken ?
              `field '${own.name}.${taken.name}' reads another column` :
              metric ?
              `a field named '${name}' would collide with metric '${metric.name}'` :
              nameProblem('field', name) ?
              `a field named '${name}' breaks kcmd's name rules` :
              own.fields != null && !Array.isArray(own.fields) ?
              `'fields' of ${word} '${own.name}' is not a list` :
              undefined;
          if (why) {
            doc.warnings.push(
                `${label}: left '${written}' as written, since ${why}.`);
            return undefined;
          }
          const column = written.slice(n.nameStart - n.start);
          const f = {
            name,
            expression: {dialects: [{dialect: OSSIE_SQL, expression: column}]},
          };
          if (Array.isArray(own.fields)) {
            own.fields.push(f);
          } else {
            own.fields = [f];
          }
          doc.warnings.push(
              `${word} '${own.name}': added field '${name}', which reads ` +
              `column '${column}', for metric '${mt.name}'.`);
          return qualifiedName(own.name, name);
        };
    const vendor = (text: string, dialect: string) => {
      let out = text;
      for (const ds of named) {
        for (const s of spellings(out, ds.name)) {
          if (s !== ds.name) out = requalified(out, s, ds.name, reading(dialect));
        }
      }
      if (!own) return out;
      const columns = columnReferences(out, dialect) ?? [];
      const cases = [
        columns.some(
            c => c.qualifier === undefined &&
                fieldOf(own, {name: c.name, quoted: false})) &&
            `names fields of ${word} '${own.name}' without a qualifier`,
        columns.some(c => c.qualifier?.toLowerCase() === 'source') &&
            `reads 'source.<column>'`,
      ].filter(Boolean);
      if (cases.length) {
        doc.warnings.push(
            `${label}: its '${dialect}' text ${cases.join(' and ')}; import ` +
            `converts these only in an '${OSSIE_SQL}' text, so they stay as ` +
            `written.`);
      }
      return out;
    };
    namesConverted(doc, mt, label, (n, text) => {
      if (own && n.qualifier && ossieMatches(n.qualifier, 'source') &&
          !fieldOf(own, {name: 'source', quoted: false})) {
        return sourceField(own, n, text.slice(n.start, n.end));
      }
      const ds = n.qualifier ? datasetOf(n.qualifier) : own;
      const field = fieldOf(ds, n.name);
      return !ds || !field ||
              n.qualifier?.name === ds.name && n.name.name === field.name ?
          undefined :
          qualifiedName(ds.name, field.name);
    }, vendor, onBigQuery);
  }
  // kcmd matches the dataset a relationship's `from` or `to` names by its
  // declared spelling.
  for (const r of doc.relationships) {
    for (const key of ['from', 'to']) {
      const ds = datasetNamed(doc, r[key]);
      if (!ds || ds.name === r[key]) continue;
      doc.warnings.push(
          `relationship '${r.name}': wrote '${key}' ${word} '${r[key]}' as ` +
          `'${ds.name}'.`);
      r[key] = ds.name;
    }
  }
}

/**
 * Writes each call of AGG in the OSSIE_SQL_2026 text of a model metric of
 * `doc` as the OSSIE_SQL_2026 text of the metric it names, one a dataset
 * listed (see `moved`), in parentheses, and reports it. A call with FILTER or
 * OVER, one that names no such metric with such a text, and one whose
 * metric's text names no field of its dataset, such as `COUNT(*)`, stay as
 * written, with a warning.
 */
function inlineAggCalls(doc: ImportDocument, moved: MovedMetric[]): void {
  const word = entityWord(doc.targetVersion);
  for (const mt of doc.metrics) {
    if (moved.some(m => m.metric === mt)) continue;
    const label = `metric '${mt.name}'`;
    for (const t of expressionTexts(mt)) {
      const tree = t.dialect === OSSIE_SQL ? ossieTree(t.text) : undefined;
      if (!tree) continue;
      let out = '';
      let end = 0;
      let covered = 0;
      for (const call of ossieNodes(tree)) {
        if (!isAggCall(call) || call.start < covered) continue;
        covered = call.end;
        const written = t.text.slice(call.start, call.end);
        const [arg] = call.args;
        const named = call.args.length === 1 && !call.star && !call.distinct &&
                arg.kind === 'reference' && arg.parts.length === 2 ?
            moved.find(
                m => ossieMatches(arg.parts[0], m.dataset) &&
                    ossieMatches(arg.parts[1], m.name)) :
            undefined;
        const text = named &&
            expressionTexts(named.metric).find(x => x.dialect === OSSIE_SQL)?.text;
        const inner = text === undefined ? undefined : ossieTree(text);
        // The fields of its dataset that the text names place the metric there.
        // Import wrote each as `<dataset>.<field>` in the declared spelling.
        const placed = !!inner &&
            textNames(text!)!.some(n => n.qualifier?.name === named!.dataset);
        if (call.filter || call.over || !placed) {
          doc.warnings.push(
              `${label}: left '${written}' as written, since ` +
              (call.filter ? 'AGG takes no FILTER clause.' :
                   call.over ? 'kcmd cannot write a metric before OVER.' :
                   !inner    ? `it does not name a dataset's metric with an ` +
                           `'${OSSIE_SQL}' text.` :
                               `the '${OSSIE_SQL}' text of that metric names ` +
                           `no field of ${word} '${named!.dataset}'.`));
          continue;
        }
        const replaced = `(${text!.slice(inner.start, inner.end)})`;
        out += t.text.slice(end, call.start) + replaced;
        end = call.end;
        doc.warnings.push(`${label}: wrote '${written}' as '${replaced}'.`);
      }
      if (end) t.set(out + t.text.slice(end));
    }
  }
}

/**
 * Writes the model name of `doc` with a hyphen for each character the
 * model-name rule refuses, and reports it, when that makes the name valid.
 */
function hyphenateModelName(doc: ImportDocument): void {
  // A model name may hold only letters, digits, underscores and hyphens.
  const name: string = doc.model.name;
  const hyphens =
      Array.from(name, c => /[A-Za-z0-9_-]/.test(c) ? c : '-').join('');
  if (!nameProblem('model', name) || nameProblem('model', hyphens)) return;
  doc.hyphenation =
      `model '${name}': wrote its name as '${hyphens}', since a model name ` +
      `holds only letters, digits, underscores and hyphens.`;
  doc.warnings.push(doc.hyphenation);
  doc.model.name = hyphens;
  doc.modified = true;
}

/**
 * Converts what kcmd writes another way in `doc`, which holds the model of an
 * Ossie file of version `version` that held it at the document root, and
 * reports each edit: the version, the metrics its datasets listed (`moved`),
 * the empty metrics lists of the datasets `emptied` names, the `metrics` a
 * dataset keeps as written, the extension blocks, the `sql` of each
 * expression, the names in texts and relationships, the calls of AGG, and the
 * key and join entries.
 */
function convertRootModel(
    doc: ImportDocument, version: string, moved: MovedMetric[],
    emptied: string[]): void {
  const word = entityWord(doc.targetVersion);
  const report = (line: string) => void doc.warnings.push(line);
  report(
      `Moved the model from the document root into 'semantic_model'` +
      (version === doc.targetVersion ?
           '.' :
           `, and wrote version '${doc.targetVersion}' in place of '${version}'.`));

  // A moved metric whose name an earlier metric has takes the name
  // `<dataset>_<metric>` when no metric has that.
  const listed = new Set(moved.map(m => m.metric));
  const taken = new Set(
      doc.metrics.filter(mt => !listed.has(mt) && typeof mt.name === 'string')
          .map(mt => mt.name.toLowerCase()));
  // The anchor is a block in the metric's list of extension blocks, so a
  // metric whose extension blocks are not a list gets none.
  const unanchored = new Set([...listed].filter(mt => {
    const blocks = mt.custom_extensions ?? mt.nonportable_extensions;
    return blocks != null && !Array.isArray(blocks);
  }));
  for (const {metric, dataset, name} of moved) {
    const other = `${dataset}_${name}`;
    const clash = taken.has(name.toLowerCase());
    const renamed = clash && !taken.has(other.toLowerCase()) &&
        !nameProblem('metric', other);
    if (renamed) metric.name = other;
    taken.add(metric.name.toLowerCase());
    report(
        `${word} '${dataset}': moved metric '${name}' to the model's metrics` +
        (renamed ? ` as '${other}'` : '') +
        (unanchored.has(metric) ? '' : `, anchored on '${dataset}'`) +
        (!clash      ? '.' :
             renamed ? `, since another metric is named '${name}'.` :
                       `; another metric is named '${name}', and so is one ` +
                     `named '${other}', so rename it.`));
    if (unanchored.has(metric)) {
      report(
          `metric '${metric.name}': did not anchor it on '${dataset}', since ` +
          `its extension blocks are not a list.`);
    }
  }
  for (const dataset of emptied) {
    report(
        `${word} '${dataset}': removed its empty 'metrics' list, since kcmd ` +
        `lists every metric in the model's metrics.`);
  }
  // A dataset that still has `metrics` keeps them as written.
  for (const ds of doc.datasets) {
    const why = 'metrics' in ds ? keptMetricsReason(doc.model, ds) : undefined;
    if (why) {
      report(
          `${word} '${ds.name}': left its 'metrics' as written, since ${why}.`);
    }
  }

  const objects = [
    {obj: doc.model, label: `model '${doc.model.name}'`},
    ...doc.datasets.flatMap(ds => [
      {obj: ds, label: `${word} '${ds.name}'`},
      ...asRecords(ds.fields).map(
          f => ({obj: f, label: `field '${ds.name}.${f.name}'`})),
    ]),
    ...doc.relationships.map(r => ({obj: r, label: `relationship '${r.name}'`})),
    ...doc.metrics.map(mt => ({obj: mt, label: `metric '${mt.name}'`})),
  ];
  for (const {obj, label} of objects) {
    // kcmd lists extension blocks under `custom_extensions`, each with its
    // data as JSON text.
    const renamed =
        'nonportable_extensions' in obj && !('custom_extensions' in obj);
    if (renamed) {
      renameKey(doc, obj, 'nonportable_extensions', 'custom_extensions');
    }
    let wrote = false;
    for (const b of asRecords(obj.custom_extensions)) {
      const node = doc.links.get(b);
      const json = isRecord(b.data) && yaml.isMap(node) ?
          nodeJson(node.get('data', true), doc.document) :
          undefined;
      if (json === undefined) continue;
      b.data = json;
      wrote = true;
    }
    if (renamed || wrote) {
      report(
          `${label}: ` +
          (renamed ? `renamed 'nonportable_extensions' to 'custom_extensions'` +
                   (wrote ? ' and ' : '') :
                     '') +
          (wrote ? `wrote the data of its extension blocks as JSON text` : '') +
          '.');
    }

    // kcmd reads an expression's texts from `dialects`.
    const e = obj.expression;
    if (!isRecord(e) || typeof e.sql !== 'string' ||
        noSqlReason(e.sql, OSSIE_SQL) !== undefined ||
        e.dialects !== undefined && !Array.isArray(e.dialects)) {
      continue;
    }
    // Ossie reads the top-level `sql` as the OSSIE_SQL_2026 text, in place of
    // such an entry of `dialects`.
    const own = asRecords(e.dialects).find(
        d => typeof d.dialect === 'string' &&
            d.dialect.trim().toUpperCase() === OSSIE_SQL);
    if (own) {
      report(
          `${label}: moved 'sql' into its '${OSSIE_SQL}' entry of 'dialects' ` +
          `in place of the text '${own.expression}', since Ossie reads 'sql' ` +
          `as the '${OSSIE_SQL}' text.`);
      own.expression = e.sql;
      delete e.sql;
      continue;
    }
    // The writer keeps the comments on and above `sql` with the key, which
    // the document names `dialects`, and moves the text of the SQL into the
    // new entry. Beside a `dialects` list, the key goes, and the writer moves
    // the text of the SQL from the key the document names `expression`.
    renameDocumentKey(
        doc, e, 'sql', Array.isArray(e.dialects) ? 'expression' : 'dialects');
    const entry = {dialect: OSSIE_SQL, expression: e.sql};
    delete e.sql;
    if (Array.isArray(e.dialects)) {
      e.dialects.unshift(entry);
    } else {
      e.dialects = [entry];
    }
    report(`${label}: moved 'sql' into an '${OSSIE_SQL}' entry of 'dialects'.`);
  }

  // Each moved metric is anchored on its dataset, after its extension blocks
  // are converted.
  for (const {metric, dataset} of moved) {
    if (!unanchored.has(metric)) putGoogleBlock(metric, {entity: dataset});
  }

  convertTextNames(doc, moved);
  inlineAggCalls(doc, moved);

  // kcmd keys and join columns name columns.
  const lists = [
    ...doc.datasets.flatMap(ds => [
      {owner: `${word} '${ds.name}'`, key: 'primary_key', list: ds.primary_key, ds},
      ...(Array.isArray(ds.unique_keys) ? ds.unique_keys : [])
          .map((list: unknown, j: number) => ({
                 owner: `${word} '${ds.name}'`, key: `unique_keys[${j}]`, list, ds,
               })),
    ]),
    ...doc.relationships.flatMap(r => [
      {owner: `relationship '${r.name}'`, key: 'from_columns', list: r.from_columns, ds: datasetNamed(doc, r.from)},
      {owner: `relationship '${r.name}'`, key: 'to_columns', list: r.to_columns, ds: datasetNamed(doc, r.to)},
    ]),
  ];
  for (const {owner, key, list, ds} of lists) {
    if (!Array.isArray(list) || !ds) continue;
    list.forEach((entry: unknown, i: number) => {
      if (typeof entry !== 'string') return;
      const f = asRecords(ds.fields).find(
          f => typeof f.name === 'string' && ossieMatches(yamlName(entry), f.name));
      const column = f && fieldColumn(f)?.name;
      const written = column === undefined || isColumnName(column) ? column :
          column.includes('`')                                    ? undefined :
                                                                    `\`${column}\``;
      if (written === entry) return;
      const left = `${owner}: left ${key} entry '${entry}' as written, since `;
      if (!f) {
        report(
            `${left}it names no field of ${word} '${ds.name}'; kcmd reads ` +
            `it as a column name.`);
      } else if (written === undefined) {
        report(
            `${left}field '${ds.name}.${f.name}' does not read exactly one ` +
            `column that a key can name.`);
      } else {
        list[i] = written;
        report(
            `${owner}: rewrote ${key} entry '${entry}' as column '${written}', ` +
            `which field '${ds.name}.${f.name}' reads.`);
      }
    });
  }
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
 * Phase 1 (Parse): Parses raw YAML, wraps an Ossie model held at the document
 * root in `semantic_model`, verifies the top-level document envelope,
 * validates `opts.sourcePrefix` when present, refuses a document with a
 * `GOOGLE` block or a Google-flavor model to convert to vanilla unless
 * `strict` is set, and constructs the mutable `ImportDocument` (or returns a
 * fatal error string). It then checks the names (see validateInputDocument),
 * and converts a root model when they pass.
 */
function parseImportDocument(
    rawYaml: string, opts: ImportSemanticModelOptions): ImportDocument|string {
  // 1. Parse raw YAML with strict YAML 1.2 options (`YAML_OPTIONS`) so syntax
  // errors and duplicate keys are caught immediately.
  let {document, text} = parseForUpdate(rawYaml);
  // A model file is YAML, so a JSON file is written as YAML.
  const fromJson = text !== rawYaml;
  let parsedDoc: any;
  try {
    parsedDoc = documentValue(text, document);
  } catch (err: any) {
    return `Semantic model load error: could not parse input: ${
        yamlErrorMessage(err, text)}`;
  }

  // 1b. Import reads an Ossie file with its model at the document root in
  // third-party mode only, as a '0.2.0.dev0' model wrapped in
  // `semantic_model`. The editor schema line names the schema of the input
  // file, so it goes when the import writes another version or moves the
  // model.
  const ossieError = ossieFileError(parsedDoc, !!opts.strict);
  if (ossieError) return ossieError;
  const rootVersion = rootModelVersion(parsedDoc);
  // The root conversion edits the text, which a byte order mark would shift.
  if (rootVersion !== undefined && text.startsWith('\uFEFF')) {
    ({document, text} = parseForUpdate(text.slice(1)));
  }
  const written = isRecord(parsedDoc) ? parsedDoc.version : undefined;
  const flavor = opts.flavor === 'google' ? GOOGLE_VERSION :
      opts.flavor === 'ossie'             ? OSSIE_VERSION :
                                            undefined;
  const removesSchemaLine = rootVersion !== undefined ||
      (written === OSSIE_VERSION || written === GOOGLE_VERSION) &&
          flavor !== undefined && written !== flavor;
  const schemaLine = removesSchemaLine ?
      SCHEMA_LINE.exec(text.slice(0, document.contents?.range?.[0] ?? 0)) :
      null;
  if (schemaLine) {
    ({document, text} = parseForUpdate(
         text.slice(0, schemaLine.index) +
         text.slice(schemaLine.index + schemaLine[0].length)));
    parsedDoc = document.toJS();
  }
  // The datasets whose metrics go to the model, and the metrics they list,
  // which go in the same order.
  const moving = rootVersion === undefined ? [] : movingDatasets(parsedDoc);
  const planned = moving.flatMap(
      ds => ds.metrics.map(
          (m: Record<string, any>) => ({dataset: String(ds.name), name: m.name})));
  // The datasets whose `metrics` list is empty, which goes.
  const emptied =
      moving.filter(ds => !ds.metrics.length).map(ds => String(ds.name));
  let wrapped = false;
  let moved = false;
  if (rootVersion !== undefined) {
    ({text, document, wrapped, moved} = rootModelText(text, document));
    parsedDoc = document.toJS();
    if (!wrapped) {
      const {version, ...model} = parsedDoc;
      parsedDoc = {version, semantic_model: [model]};
    }
    parsedDoc.version = OSSIE_VERSION;
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
  // Import names the file it writes after the model.
  const modelName = parsedDoc.semantic_model[0].name;
  if (typeof modelName !== 'string') {
    return modelName === undefined ?
        `Model name is missing; give the model a 'name', since import names ` +
            `the file it writes after it.` :
        `Model name ${JSON.stringify(modelName)} is not a string; write it ` +
            `as one, since import names the file it writes after it.`;
  }

  // 3. Validate `opts.sourcePrefix` against the supported first-party GCP
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
      const {child, tableParts, defaultSchema} = match.p;
      sourcePrefix =
          {base, known: match.m.slice(1), child, tableParts, defaultSchema};
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
          `catalog, namespace or Hive database, a Spanner database, an ` +
          `AlloyDB database or schema, or a Cloud SQL database or schema ` +
          `(with no leading '//'), or the name of a Knowledge Catalog entry ` +
          `group ('projects/<p>/locations/<l>/entryGroups/<g>').`;
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
  const links = linkNodes(root, document.contents);
  // A model the text edits could not wrap moves by value from the root, and
  // so do metrics they could not move (see rootModelText).
  if (rootVersion !== undefined && !wrapped) {
    linkNodes(model, document.contents, links);
  }
  if (rootVersion !== undefined && !moved) {
    moveDatasetMetrics(model, movingDatasets(model));
  }
  // The moved metrics end the model's metrics, in the order planned.
  const movedMetrics = planned.map((p, i) => ({
    ...p,
    metric: model.metrics[model.metrics.length - planned.length + i],
  }));
  const inputVersion = root.version as FormatVersion;
  const targetVersion: FormatVersion = flavor ?? inputVersion;
  const fileName = opts.fileName ?? `${model.name}.yaml`;
  const warnings = fromJson ? [`Converted '${fileName}' to YAML.`] : [];
  const errors: string[] = [];
  const doc: ImportDocument = {
    text,
    document,
    links,
    root,
    model,
    datasets: asRecords(model.entities ?? model.datasets),
    relationships: asRecords(model.relationships),
    metrics: asRecords(model.metrics),
    inputVersion,
    targetVersion,
    sourcePrefix,
    entryGroup,
    rootVersion,
    schemaLine: schemaLine?.[0].trim(),
    strict,
    modified: rootVersion !== undefined,
    warnings,
    errors,
    warnOrError: (msg: string) => (strict ? errors : warnings).push(msg),
    repair: (done: string, needed: string) =>
        strict ? errors.push(needed) : warnings.push(done),
  };
  if (!strict) hyphenateModelName(doc);
  // The names are checked first, so an import that stops on one converts
  // nothing.
  validateInputDocument(doc);
  if (rootVersion !== undefined && !errors.length) {
    convertRootModel(doc, rootVersion, movedMetrics, emptied);
  }
  return doc;
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
  const word = entityWord(doc.targetVersion);
  for (const ds of doc.datasets) {
    validateName('entity', ds.name);
    const dsScope = typeof ds.name === 'string' ? `${word} '${ds.name}'` : word;
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
  const segs = sourceParts(source, prefix);
  if (!segs) return undefined;
  const read = (s: {text: string; quoted: boolean}) => readPart(prefix.base, s);
  const agrees = (s: {text: string; quoted: boolean}, k: string) =>
      read(s) === k || (ignoreCase && lowerAscii(s.text) === lowerAscii(k));
  // The table's name takes the last part, or up to `prefix.tableParts` parts,
  // and any parts before the child container must match the end of
  // `prefix.known`. Fewer table parts win, so `db.t` under database `db` is `t`.
  for (let count = 1; count <= (prefix.tableParts ?? 1); count++) {
    const overlap = segs.length - count - (prefix.child ? 1 : 0);
    if (overlap < 0 || overlap > prefix.known.length) continue;
    const tail = prefix.known.slice(prefix.known.length - overlap);
    if (tail.some((k, i) => !agrees(segs[i], k))) continue;
    const rest = segs.slice(overlap).map(read);
    let names = rest.slice(prefix.child ? 1 : 0);
    // A table in the default schema has no schema part in its name.
    if (names.length > 1 && names[0] === prefix.defaultSchema) {
      names = names.slice(1);
    }
    const table = names.join('.');
    const qualified = prefix.child ?
        `${prefix.base}/${prefix.child}/${rest[0]}/tables/${table}` :
        `${prefix.base}/tables/${table}`;
    if (oldSourceForm(qualified) === undefined && isAcceptedSource(qualified)) {
      return qualified;
    }
  }
  return undefined;
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
  // A name with more parts than the form's placeholders may end in a table
  // name of up to `kind.tableParts` parts, such as `p.i.db.ops.stations`.
  const filled = fillForm(kind.form, parts) ??
      (kind.tableParts ? fillForm(kind.form, parts.slice(0, 1 - kind.tableParts)) :
                         undefined);
  const base = filled?.split('/').slice(0, kind.child ? -4 : -2).join('/');
  const known = base?.match(kind.re)?.slice(1);
  const {child, tableParts, defaultSchema} = kind;
  return base && known ? {base, known, child, tableParts, defaultSchema} :
                         undefined;
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
  const dsLabel = `${entityWord(doc.targetVersion)} '${ds.name}'`;
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
 * Deletes `obj.datatype` when it is Opaque in any letter case, which kcmd
 * reads as no datatype, and reports it. Otherwise, when the output's flavor
 * rejects the datatype, writes it in its canonical casing, such as `Integer`
 * for `integer`. Either change goes through `doc.repair` when the input's
 * flavor rejects the value.
 */
function normalizeDatatype(
    obj: Record<string, any>, label: string, doc: ImportDocument): void {
  if (typeof obj.datatype !== 'string') return;
  const res = normalizeDataType(obj.datatype, GOOGLE_VERSION);
  const opaque = res.ok && res.type === undefined;
  if (!res.ok ||
      !opaque && normalizeDataType(obj.datatype, doc.targetVersion).ok) {
    return;
  }
  const removed = `${label}: removed datatype '${obj.datatype}', which kcmd ` +
      `reads as no datatype.`;
  if (!normalizeDataType(obj.datatype, doc.inputVersion).ok) {
    if (opaque) {
      doc.repair(removed, `${label}: remove datatype '${obj.datatype}'.`);
    } else {
      doc.repair(
          `${label}: rewrote datatype '${obj.datatype}' to '${res.type}'.`,
          `${label}: write datatype '${obj.datatype}' as '${res.type}'.`);
    }
  } else if (opaque) {
    doc.warnings.push(removed);
  }
  if (opaque) {
    delete obj.datatype;
  } else {
    obj.datatype = res.type;
  }
  doc.modified = true;
}

/**
 * Maps each dialect onto the allowed SQL dialects and drops unsupported
 * non-SQL dialects on a field or metric, returning `'empty'` if all dialect
 * entries were dropped. A vendor label stays as written for
 * `relabelVendorDialects`.
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
    if (DIALECT_ALIASES[upper]) {
      kept.push(entry);
      continue;
    }
    const mapped =
        ALLOWED_DIALECT_SET.has(upper) ? (upper as SqlDialect) : undefined;
    if (mapped !== undefined) {
      if (entry.dialect !== mapped) {
        doc.repair(
            `${label}: rewrote dialect '${entry.dialect}' to '${mapped}'.`,
            `${label}: write dialect '${entry.dialect}' as '${mapped}'.`);
        entry.dialect = mapped;
        doc.modified = true;
      }
      kept.push(entry);
    } else {
      doc.repair(
          `${label}: dropped unsupported dialect '${entry.dialect}'.`,
          `${label}: remove the entry for unsupported dialect '${
              entry.dialect}'.`);
      doc.modified = true;
    }
  }
  obj.expression.dialects = kept;
  return kept.length === 0 ? 'empty' : 'ok';
}

/**
 * Rewrites each vendor dialect label on a field or metric, in list order, as
 * the dialect it names. `tables` holds the dialect of each table that runs
 * the field or metric. The label names the second dialect DIALECT_ALIASES
 * gives it when there is a table and every table has that dialect. Otherwise
 * it names the first. A label whose dialect another entry already has stays
 * as written, and import reports it.
 */
function relabelVendorDialects(
    obj: Record<string, any>, label: string, doc: ImportDocument,
    tables: ReadonlyArray<string|null|undefined>): void {
  if (!isRecord(obj.expression) || !Array.isArray(obj.expression.dialects)) {
    return;
  }
  const entries = asRecords(obj.expression.dialects);
  entries.forEach((entry, i) => {
    const alias = typeof entry.dialect === 'string' ?
        DIALECT_ALIASES[entry.dialect.trim().toUpperCase()] :
        undefined;
    if (!alias) return;
    const [usual, own] = alias;
    const name =
        own && tables.length && tables.every(t => t === own) ? own : usual;
    if (entries.some((e, j) => j !== i && e.dialect === name)) {
      doc.errors.push(
          `${label}: dialect '${entry.dialect}' names '${name}', and ` +
          `another entry already has dialect '${name}'; remove one of the ` +
          `two entries.`);
      return;
    }
    doc.repair(
        `${label}: rewrote dialect '${entry.dialect}' to '${name}'.`,
        `${label}: write dialect '${entry.dialect}' as '${name}'.`);
    entry.dialect = name;
    doc.modified = true;
  });
}

// The entities whose tables run metric `mt`, as push reads them with
// metricTableEntities. A vendor label's text is read in the first dialect
// DIALECT_ALIASES gives it.
function metricEntities(
    mt: Record<string, any>, doc: ImportDocument): Array<Record<string, any>> {
  const anchor =
      [mt.entity, ...parseGoogleBlocks(mt.custom_extensions).map(b => b.entity)]
          .find((a): a is string => typeof a === 'string');
  const dialects =
      asRecords(mt.expression?.dialects)
          .filter(
              e => typeof e.dialect === 'string' &&
                  typeof e.expression === 'string')
          .map(
              e => ({
                dialect: DIALECT_ALIASES[e.dialect.trim().toUpperCase()]?.[0] ??
                    e.dialect,
                expression: e.expression,
              }));
  const names = doc.datasets.map(ds => ds.name)
                    .filter((n): n is string => typeof n === 'string');
  const run = metricTableEntities(
      {name: String(mt.name), authoredEntity: anchor, dialects}, names,
      undefined, doc.impliedDialect);
  return doc.datasets.filter(ds => run.includes(ds.name));
}

/**
 * Returns why an unanchored metric `mt` is rejected by push's
 * `validateExpressionReferences` (`'reaches no declared entity'` or
 * `'reaches multiple entities (...)'`), or `undefined` when anchored or valid.
 * When `translatesLater` is true, `--transpile` translates the model after
 * this check, and a metric whose `ANSI_SQL` text double-quotes a name is left
 * for the checks after translation.
 */
function unanchoredMetricProblem(
    mt: Record<string, any>, entityNames: string[],
    impliedDialect?: string|null, translatesLater = false): string|undefined {
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
  // BigQuery reads a double-quoted name as text. `--transpile` translates an
  // `ANSI_SQL` text that holds one, so the check after translation decides.
  if (translatesLater &&
      sources.some(
          s => s.dialect === 'ANSI_SQL' && hasDoubleQuotedColumn(s.text))) {
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
    doc.repair(
        `${label}: truncated 'description' from ${text.length} ` +
            `to ${cut.length} characters.`,
        `${label}: 'description' has ${text.length} characters; shorten it ` +
            `to ${MAX_ENTRY_DESCRIPTION} or fewer.`);
    obj.description = cut;
    doc.modified = true;
  }
}

/**
 * Normalizes a field's datatype and SQL dialect list, removing `f.expression`
 * with a warning in the Google version (or recording an error in the vanilla
 * version) if no supported SQL dialect remains. `abstract` is true for a field
 * of an abstract entity, which takes no expression.
 */
function repairField(
    f: Record<string, any>, dsName: string, doc: ImportDocument,
    abstract = false): void {
  const fLabel = `field '${dsName}.${f.name}'`;
  normalizeDatatype(f, fLabel, doc);
  if (normalizeExpressionDialects(f, fLabel, doc) === 'empty') {
    if (doc.targetVersion === OSSIE_VERSION) {
      doc.errors.push(
          `${fLabel}: 'expression' has no entry in a supported SQL dialect, ` +
          `and version '${OSSIE_VERSION}' requires an 'expression' on ` +
          `every field; add one.`);
    } else {
      delete f.expression;
      doc.modified = true;
      doc.repair(
          `${fLabel}: no supported SQL dialect remains; removed ` +
              `'expression' and left the field unbound.`,
          abstract ?
              `${fLabel}: 'expression' has no entry in a supported SQL ` +
                  `dialect; remove 'expression', since a field of abstract ` +
                  `entity '${dsName}' takes none.` :
              `${fLabel}: 'expression' has no entry in a supported SQL ` +
                  `dialect; add one.`);
    }
  }
}

/**
 * Repairs a dataset's `source` (removing whitespace around it, removing
 * query-valued sources, qualifying bare table names against
 * `doc.sourcePrefix` or completing them from `doc.entryTables`, and warning on
 * unaccepted sources), truncates its `description`, and repairs each of its
 * `fields`.
 */
function repairDataset(ds: Record<string, any>, doc: ImportDocument): void {
  // 1. Repair or diagnose `ds.source`: remove query-valued sources (in the
  // Google version), qualify bare table names against `doc.sourcePrefix` or
  // complete them from `doc.entryTables`, or warn on unaccepted source
  // formats.
  const word = entityWord(doc.targetVersion);
  const dsLabel = `${word} '${ds.name}'`;
  // A vanilla file has no abstract entity, and requires 'source' and
  // 'expression'.
  const abstract = doc.inputVersion === GOOGLE_VERSION && ds.abstract === true;
  if (typeof ds.source === 'string') {
    const trimmed = ds.source.trim();
    // Push rejects whitespace around a source. A query is reported below.
    if (trimmed !== ds.source && !hasUnquotedWhitespace(trimmed)) {
      doc.repair(
          `${dsLabel}: removed the whitespace around source '${trimmed}'.`,
          `${dsLabel}: remove the whitespace around source '${trimmed}'.`);
      ds.source = trimmed;
      doc.modified = true;
    }
    const qualified = doc.sourcePrefix ?
        qualifyTableSource(trimmed, doc.sourcePrefix) :
        undefined;
    const parts = doc.entryTables ? sourceParts(trimmed) : undefined;
    if (hasUnquotedWhitespace(trimmed)) {
      if (doc.targetVersion === OSSIE_VERSION) {
        // A strict import with '--flavor google' rejects the source too.
        const google = doc.strict ? '' :
            `, or import with '--flavor google', which removes the source`;
        doc.errors.push(
            `${dsLabel}: query-valued source '${trimmed}' is not supported, ` +
            `and version '${OSSIE_VERSION}' requires a table 'source' on ` +
            `every ${word}. Bind the ${word} to a table and import ` +
            `again${google}.`);
      } else {
        doc.repair(
            `${dsLabel}: removed query-valued source '${trimmed}'; ` +
                `${word} is now unbound.`,
            abstract ?
                `${dsLabel}: source '${trimmed}' is a query; remove ` +
                    `'source', since an abstract entity has no table.` :
                `${dsLabel}: source '${trimmed}' is a query; name a table.`);
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
    repairField(f, String(ds.name ?? ''), doc, abstract);
  }
}

/**
 * Repairs a metric's datatype, SQL dialect list, and description, returning
 * `false` when the caller prunes it from `doc.metrics`: when no entry of its
 * expression is in a supported SQL dialect, and when it is unanchored and
 * reaches 0 or >1 entities. A vendor label names its dialect by the tables
 * that run the metric (see metricEntities), with the dialects `load` gives
 * them. `translatesLater` is as for `unanchoredMetricProblem`.
 */
function repairMetric(
    mt: Record<string, any>, doc: ImportDocument, load: DialectLoad,
    translatesLater = false): boolean {
  const mtLabel = `metric '${mt.name}'`;
  normalizeDatatype(mt, mtLabel, doc);
  if (normalizeExpressionDialects(mt, mtLabel, doc) === 'empty') {
    doc.repair(
        `${mtLabel}: removed the metric, since 'expression' has no entry in ` +
            `a supported SQL dialect; add the metric back with one.`,
        `${mtLabel}: 'expression' has no entry in a supported SQL dialect; ` +
            `add one.`);
    doc.modified = true;
    return false;
  }
  // An abstract entity or one with no source runs nothing, as push's
  // sourcesDialect reads it. An entity with a source counts whether or not
  // the source is in an accepted form. A table of unknown dialect keeps the
  // label from naming SPANNER or ALLOYDB.
  relabelVendorDialects(
      mt, mtLabel, doc,
      metricEntities(mt, doc)
          .filter(
              ds => !ds.abstract && typeof ds.source === 'string' && ds.source)
          .map(ds => tableDialect(ds, load)));
  if (!keepsMetric(mt, doc, translatesLater)) return false;
  truncateDescription(mt, mtLabel, doc);
  return true;
}

/**
 * Returns `false`, and reports the removal, when metric `mt` is unanchored and
 * its expression reaches 0 or >1 entities, so the caller prunes it from
 * `doc.metrics`. `translatesLater` is as for `unanchoredMetricProblem`.
 */
function keepsMetric(
    mt: Record<string, any>, doc: ImportDocument,
    translatesLater = false): boolean {
  const mtLabel = `metric '${mt.name}'`;
  const entityNames = doc.datasets.map(ds => ds.name)
                          .filter((n): n is string => typeof n === 'string');
  const problem = unanchoredMetricProblem(
      mt, entityNames, doc.impliedDialect, translatesLater);
  if (problem) {
    // In strict mode nothing is written, so the author edits the input.
    const flavor = doc.strict ? doc.inputVersion : doc.targetVersion;
    const anchor = flavor === OSSIE_VERSION ?
        `'entity' in a ${GOOGLE_VENDOR} custom_extensions block on the ` +
            `metric (or use version '${GOOGLE_VERSION}' and set 'entity' on ` +
            `the metric)` :
        `'entity' on the metric`;
    const how =
        flavor === OSSIE_VERSION ? `with ${anchor}` : `with an 'entity' anchor`;
    doc.repair(
        `${mtLabel}: removed unanchored metric whose expression ` +
            `${problem}; add the metric back ${how}.`,
        `${mtLabel}: its expression ${problem}; set ${anchor}, or scope ` +
            `its expression to one entity.`);
    doc.modified = true;
    return false;
  }
  return true;
}

/**
 * Keeps the metrics of `doc` for which `keep` returns true. An entry of the
 * model's `metrics` that is not a mapping stays, for the load to report.
 */
function filterMetrics(
    doc: ImportDocument,
    keep: (mt: Record<string, any>, doc: ImportDocument) => boolean): void {
  const gone = new Set(doc.metrics.filter(mt => !keep(mt, doc)));
  if (!gone.size) return;
  doc.metrics = doc.metrics.filter(mt => !gone.has(mt));
  const left = doc.model.metrics.filter((m: any) => !gone.has(m));
  doc.model.metrics = left.length ? left : undefined;
}

/**
 * Reads, with `opts.readDialects`, the dialect of each Cloud SQL, Spanner and
 * third-party table the repaired model and its profile files name, as push
 * reads them. A read that fails is one warning per table, or per database for
 * Spanner, and the dialect of the tables it reads stays unknown. A lookup that
 * cannot start is one warning for the run, and every such table's dialect
 * stays unknown. An entry that was read and gives no dialect is reported as
 * push's other refusals are.
 */
async function readSourceDialects(
    doc: ImportDocument,
    opts: ImportSemanticModelOptions): Promise<DialectLoad> {
  // The repaired sources are in `doc.root`, and JSON is YAML. Each file is
  // labeled as push's messages about it are (see validateOutputDocument).
  // Outside strict mode, a Google-flavor import of a Google-flavor model
  // writes each profile file under a new name. Any other profile file keeps
  // its input name.
  const renames = !doc.strict && doc.inputVersion === GOOGLE_VERSION &&
      doc.targetVersion === GOOGLE_VERSION;
  const label = (fileName: string) =>
      renames ? writtenProfileFileName(doc, fileName) : fileName;
  const files = [
    {label: importDocumentName(doc, opts), text: JSON.stringify(doc.root)},
    ...(opts.profileFiles ?? []).map(
        f => ({label: label(f.fileName), text: f.content})),
  ];
  if (!opts.readDialects || !sourcesToLookUp(files.map(f => f.text)).length) {
    return {};
  }
  let got: SourceDialects;
  try {
    got = await opts.readDialects(files);
  } catch (err: any) {
    // The lookup could not start, for example with no credentials. gcloud
    // prints the details, so the warning keeps the first line.
    const why = String(err?.message ?? err).split('\n')[0];
    doc.warnings.push(`${
        sentence(`kcmd could not look up table dialects: ${why}`)} Import ` +
        "skipped the checks that need a table's dialect.");
    return {};
  }
  const skipped = 'Import skipped the checks that need its dialect.';
  for (const e of got.errors) {
    if (got.unread.includes(e)) doc.warnings.push(`${sentence(e)} ${skipped}`);
    else doc.warnOrError(e);
  }
  return {sourceDialects: got.dialects, sourceDatabases: got.databases};
}

/**
 * Phase 3 (Repair): Repairs third-party constructs in-place on `doc` (pruning
 * extra models, removing the whitespace around deployment targets, repairing
 * datasets and their fields, pruning unanchored metrics, and truncating
 * descriptions > 2,000 chars). Returns the source dialects it reads after
 * repairing the datasets.
 */
async function repairDocument(
    doc: ImportDocument,
    opts: ImportSemanticModelOptions): Promise<DialectLoad> {
  // 1. Prune extra models after `semantic_model[0]` because `kcmd` allows only
  // a single model per document, and cap the model's `description` at 2,000
  // characters (`MAX_ENTRY_DESCRIPTION`).
  if (doc.root.semantic_model.length > 1) {
    for (const extra of doc.root.semantic_model.slice(1)) {
      const name =
          isRecord(extra) && typeof extra.name === 'string' ? extra.name : '';
      const model = `model${name ? ` '${name}'` : ''}`;
      doc.repair(
          `Removed extra ${model} from 'semantic_model'; the format allows ` +
              `one model per document.`,
          `Move extra ${model} from 'semantic_model' into its own file; the ` +
              `format allows one model per document.`);
    }
    doc.root.semantic_model = [doc.root.semantic_model[0]];
    doc.modified = true;
  }
  truncateDescription(doc.model, `model '${doc.model.name}'`, doc);
  // Remove the whitespace around each deployment target, which push rejects
  // as it does around a source. A vanilla model's targets sit in a GOOGLE
  // block, which only --input first-party reads. That mode writes nothing on
  // an error, so push's own check reports them.
  for (const d of asRecords(doc.model.deployments)) {
    if (typeof d.target !== 'string' || d.target === d.target.trim()) continue;
    d.target = d.target.trim();
    doc.modified = true;
    doc.repair(
        `deployment '${d.name}': removed the whitespace around target '${
            d.target}'.`,
        `deployment '${d.name}': remove the whitespace around target '${
            d.target}'.`);
  }

  // 2. Repair each dataset (its table `source`, `description`, and `fields`).
  for (const ds of doc.datasets) {
    repairDataset(ds, doc);
  }

  // 3. Read the source dialects, infer the model's source dialect from its
  // repaired datasets via `sourcesDialect`, and repair or prune each metric
  // (`repairMetric`). An ANSI_SQL text is not read when no lookup gave its
  // tables' dialect, as push's checks read none. Under `--transpile`, the
  // metric check runs again after translation, or push's checks in strict
  // mode.
  const load = await readSourceDialects(doc, opts);
  // A vendor label on a field names its dialect by its entity's own table,
  // once every source is complete and its dialect read.
  for (const ds of doc.datasets) {
    for (const f of asRecords(ds.fields)) {
      relabelVendorDialects(
          f, `field '${ds.name ?? ''}.${f.name}'`, doc,
          [tableDialect(ds, load)]);
    }
  }
  doc.impliedDialect = sourcesDialect(
      {entities: doc.datasets.map(ds => lookedUpEntity(ds, load))});
  filterMetrics(doc, (mt, d) => repairMetric(mt, d, load, !!opts.transpile));

  // 4. Cap each relationship's `description`. A `GOOGLE` block comes only in
  // strict mode, which writes nothing, so its description is only reported.
  for (const r of doc.relationships) {
    const rLabel = `relationship '${r.name}'`;
    truncateDescription(r, rLabel, doc);
    for (const b of parseGoogleBlocks(r.custom_extensions)) {
      truncateDescription(b, rLabel, doc);
    }
  }
  return load;
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
 * those changes is a repair and goes through `doc.repair`.
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
      doc.repair(
          `${label}: wrote the string expression as an 'ANSI_SQL' ` +
              `dialects entry.`,
          `${label}: write the string expression as an 'ANSI_SQL' ` +
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
    doc.repair(
        `relationship '${r.name}': moved 'description' into a ` +
            `${GOOGLE_VENDOR} custom_extensions block for '${OSSIE_VERSION}'.`,
        `relationship '${r.name}': move 'description' into a ` +
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
            profileFiles.map(pf => documentValue(pf.content)) :
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
    // gained an entry is written back as JSON in the block's own layout.
    for (const block of asRecords(doc.model.custom_extensions)) {
      const data = parseGoogleBlocks([block])[0];
      let changed = false;
      for (const p of asRecords(data?.profiles)) {
        changed = syncProfile(p, profile(p.name)) || changed;
      }
      if (changed) {
        block.data = updatedData(block.data, data) ?? JSON.stringify(data);
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
  const root = plainCopy(documentValue(text, document)) as Record<string, any>;
  const links = linkNodes(root, document.contents);
  if (!syncProfile(root, profile)) return content;
  if (text !== content) doc.warnings.push(`Converted '${fileName}' to YAML.`);
  return writeDocument({document, links, text}, root);
}

/**
 * Validates every deployment target on `model` using `targetProblem` so
 * invalid targets fail import with `kcmd push`'s exact message.
 */
function validateDeploymentTargets(
    model: SemanticModel, doc: ImportDocument): void {
  for (const d of model.deployments ?? []) {
    if (targetProblem('', d.target)) {
      doc.errors.push(deploymentTargetError(model, d));
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
  // Import reads no profile file beside a file with its model at the root.
  if (doc.inputVersion !== OSSIE_VERSION || doc.rootVersion !== undefined ||
      profileFiles.length === 0) {
    return;
  }
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
          `${prefix}: dataset '${e.name}' is 'abstract', which version ` +
          `'${OSSIE_VERSION}' does not support.`);
      continue;
    }
    if (!e.authoredSource && !e.dataSource) {
      doc.errors.push(`${prefix}: dataset '${e.name}' has no 'source'.`);
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
 * recording any `SemanticModelError` on `doc.errors` in the words of the
 * flavor import writes.
 */
function loadSemanticModel(doc: ImportDocument): SemanticModel|undefined {
  try {
    const loaded = fromDocument(doc.root, {
      bindingOptional: true,
      warnUnacceptedSource: true,
      messageFlavor: doc.targetVersion,
    });
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
 * The name an import that keeps the flavor writes the profile file
 * `fileName` under: the model's name, then the profile's. A nameless
 * `<file>.profile.yaml` stays nameless, so push reports it.
 */
function writtenProfileFileName(doc: ImportDocument, fileName: string): string {
  const name = parseProfileName(fileName);
  return /\.profile\.ya?ml$/i.test(fileName) && name === '' ?
      `${doc.model.name}.profile.yaml` :
      `${doc.model.name}.profile.${name}.yaml`;
}

/**
 * The document name push's messages give the model file: the input file's
 * name in strict mode, since strict mode writes nothing on an error, and the
 * name of the file the import writes otherwise, without `.yaml`.
 */
function importDocumentName(
    doc: ImportDocument, opts: ImportSemanticModelOptions): string {
  const input = doc.strict ? opts.fileName : undefined;
  return (input ?? `${doc.model.name}.yaml`).replace(/\.ya?ml$/, '');
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
        fileName: writtenProfileFileName(doc, pf.fileName),
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
  // Without strict mode, the repair step's metric check then runs on the
  // translated text, which can reach entities the input text did not. In
  // strict mode, push's checks refuse a metric whose translated text reaches
  // no entity or several.
  if (transpile && doc.errors.length === 0) {
    profiles = await transpileDocument(
        doc, profiles,
        doc.inputVersion === doc.targetVersion ? profileFiles : profiles);
    if (!doc.strict) filterMetrics(doc, keepsMetric);
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

// Whether `kcmd import --transpile` gives a BigQuery text to the model file
// `content` loaded with `options`, or to a field one of its profiles or
// `profileFiles` binds (see transpilesSomething). A file that does not load
// gives none, since push stops on the error first.
function transpilesFile(
    content: string, profileFiles: SerializedFile[],
    options: Parameters<typeof loadModels>[1]): boolean {
  let model: SemanticModel|undefined;
  try {
    model = loadModels(content, options).models[0];
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
  }
  if (!model) return false;
  const profiles = [
    ...model.profiles ?? [],
    ...profileFiles.flatMap(pf => {
      try {
        return [loadProfileFile(
            pf.content, parseProfileName(pf.fileName), {skipActions: true})];
      } catch (err) {
        if (!(err instanceof SemanticModelError)) throw err;
        return [];
      }
    }),
  ];
  return transpilesSomething(model, profiles);
}

/**
 * Phase 5 (Post-validation): Validates the output model file with `loadModels`
 * (`warnUnacceptedSource: !doc.strict`), checks deployment targets, and runs
 * push's local checks (`localChecks`) on the model file and each profile it
 * declares, with the source dialects in `load`. It also checks that Knowledge
 * Catalog can store each aspect, and gives push's
 * warnings from the Knowledge Catalog entry builder, the pruning and each
 * graph, and leaves out push's notes.
 */
async function validateOutputDocument(
    files: SerializedFile[], doc: ImportDocument,
    opts: ImportSemanticModelOptions, load: DialectLoad): Promise<void> {
  const [{fileName, content}, ...profileFiles] = files;
  // Push's messages name the model document after the input file in strict
  // mode, since strict mode writes nothing on an error, and after the file
  // the import writes otherwise.
  const input = doc.strict ? opts.fileName : undefined;
  const document = importDocumentName(doc, opts);
  // 1. Load the serialized output YAML with `loadModels`
  // (`warnUnacceptedSource: !doc.strict`) to run full schema and semantic
  // validation while turning unaccepted table sources into warnings in
  // non-strict mode, deduplicating warnings already recorded. Step 2 gives
  // push's error for a field its table cannot run, so the load warns about
  // it only on a table of the preferred dialect or one no lookup has read.
  const baseLoad = {
    bindingOptional: true,
    warnUnacceptedSource: !doc.strict,
    fieldTextChecked: true,
    sourceDialects: load.sourceDialects,
    document,
  };
  // Whether the model file loads and names only deployment targets in an
  // accepted form. The import stops below on either, and writes nothing.
  const loadsWithTargets = () => {
    try {
      return !loadModels(content, baseLoad).models.some(
          m => (m.deployments ?? []).some(d => targetProblem('', d.target)));
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
      return false;
    }
  };
  // Whether this third-party import writes its files over its input, asked
  // once and only when a message depends on it. A strict import writes the
  // model its input holds, so the import its advice suggests reads the input.
  let overwrote: Promise<boolean>|undefined;
  const overwrites = () => overwrote ??= (async () => !doc.strict &&
      loadsWithTargets() && !!await opts.overwritesInput?.(files))();
  // Third-party import refuses a file with a GOOGLE block, so a command that
  // reads such a file written over the input takes --input first-party.
  const thirdPartyImport = !doc.strict &&
      !(documentHasGoogleBlock(doc.root) && await overwrites());
  try {
    const loadOptions = {...baseLoad, thirdPartyImport};
    // The advice to add a BigQuery text names the first error the import it
    // suggests would stop on, so that import runs first when the advice may
    // be given.
    const transpileOutcomes: TranspileOutcomes|undefined =
        opts.transpileOutcome &&
            transpilesFile(content, profileFiles, loadOptions) ?
        new Map([[
          document,
          await opts.transpileOutcome(
              files, await overwrites(), !thirdPartyImport),
        ]]) :
        undefined;
    const loaded = loadModels(content, {...loadOptions, transpileOutcomes});
    for (const w of loaded.warnings) {
      // The repair step has reported each source the loader warns about.
      if (LOADER_SOURCE_WARNING.test(w)) continue;
      if (!doc.warnings.includes(w) && !doc.errors.includes(w)) {
        doc.warnings.push(w);
      }
    }

    // 2. Run push's local checks on the model file and each profile it
    // declares. What push rejects is an error in strict mode and a warning
    // otherwise.
    const model = {name: document, text: content};
    // Where the input holds profile `name`, which the output writes in
    // `written`: its profile file, or the input file's GOOGLE block. Strict
    // mode writes nothing on an error, so its messages name the input file.
    const inputFiles =
        doc.inputVersion === GOOGLE_VERSION ? opts.profileFiles ?? [] : [];
    const where = (name: string, written: string) => !input ? written :
        inputFiles.find(pf => parseProfileName(pf.fileName) === name)
                ?.fileName ??
            input;
    // Push stops at a profile file that breaks a file rule, then at an action
    // statement YAML reads differently from how it is written, then at a
    // deployment target in no accepted form. validateDeploymentTargets
    // reports such a target as an error in either mode.
    let read: ReturnType<ProfileFiles>|undefined;
    try {
      const seen = new Map<string, string>();
      read = profileFiles.map(f => {
        const name = parseProfileName(f.fileName);
        const label = where(name, f.fileName);
        checkProfileFileName(input ?? fileName, label, name, f.content, seen);
        return {name, text: f.content, fileName: label};
      });
    } catch (err) {
      if (!(err instanceof ProfileFileError)) throw err;
      doc.warnOrError(err.message);
    }
    const profiles = read;
    const base = {document: model.name, model: loaded.models[0]};
    const withFiles = profiles && withProfileFiles(base, () => profiles);
    // Push then refuses an action statement YAML reads differently from how
    // it is written, in the model file and in each profile file, before it
    // checks the deployment targets.
    const changed = !withFiles || 'errors' in withFiles || doc.errors.length ?
        [] :
        yamlChangedStatementErrors(base, content, () => profiles!, load);
    for (const error of changed) doc.warnOrError(error);
    if (!doc.errors.length) {
      for (const m of loaded.models) validateDeploymentTargets(m, doc);
    }
    if (!profiles || !withFiles) return;
    const declaredBy = () => declaredProfiles(model, profiles).map(
        p => 'spec' in p ? {...p, label: where(p.name, model.name)} : p);
    // Push stops at a source its loader rejects. Import still reports each
    // profile's problems, its sources among them.
    if (loaded.warnings.some(w => LOADER_SOURCE_WARNING.test(w))) {
      for (const {error} of namedProfileErrors(
               [model], new Map([[model.name, loaded.models[0]]]),
               () => profiles, declaredBy, doc.warnings,
               {...load, transpileOutcomes})) {
        doc.warnOrError(error);
      }
      return;
    }
    if (doc.errors.length || changed.length) return;
    const own = loaded.warnings.map(w => `[${model.name}] ${w}`);
    // Push prints each warning once, after the load's. Each is a warning in
    // either mode.
    const warn = (w: string) => {
      if (!own.includes(w) && !doc.warnings.includes(w)) doc.warnings.push(w);
    };
    const checked = 'errors' in withFiles ? withFiles : await localChecks(
        {
          docs: [model],
          loaded: {models: [base], warnings: own},
          models: [withFiles],
          profileDocs: () => profiles,
          declaredBy,
          // A profile's warnings come from a second load of the model file,
          // which names the same import command as the first.
          load: {...load, thirdPartyImport, transpileOutcomes},
        },
        warn);
    // Push prints each error once.
    const errors = 'errors' in checked ? checked.errors : [];
    for (const error of new Set(errors.map(e => e.error))) {
      doc.warnOrError(error);
    }
    if ('errors' in checked || 'errors' in withFiles) return;
    // Push next builds the Knowledge Catalog entries and prints the builder's
    // warnings, and checks that Knowledge Catalog can store each aspect. The
    // entry group does not change an aspect's size.
    const catalog = checkCatalogAspects([withFiles], {
      project: 'p', location: 'l', entryGroup: 'g',
      systemTypeProject: process.env.KC_TYPE_PROJECT,
    });
    for (const w of catalog.warnings) warn(w);
    if (catalog.error) {
      doc.warnOrError(catalog.error);
      return;
    }
    // Push then warns about what pruning leaves out of each deployment, and
    // about what each graph leaves out. Import leaves out push's notes.
    for (const line of checked.plans.flatMap(pruningLines)) {
      if (line.startsWith('Warning: ')) warn(line.slice('Warning: '.length));
    }
    for (const {generated} of checked.plans) {
      for (const w of generated?.warnings ?? []) warn(w);
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
  // A third-party import that stops on a name writes nothing, so it reports
  // no edit but the hyphens it gave the model name, which the errors use.
  if (!doc.strict && doc.errors.length) {
    return {
      ok: false,
      files: [],
      warnings: doc.hyphenation ? [doc.hyphenation] : [],
      errors: doc.errors,
    };
  }
  checkVanillaProfileFiles(
      doc, opts.profileFiles ?? [], opts.fileName ?? `${doc.model.name}.yaml`);

  // 2. Read the `--source-prefix` entry group, if needed, and run third-party
  // repairs (which record errors in `strict` mode) and read the source
  // dialects.
  const listError = await listEntryTables(doc);
  if (listError) {
    return {
      ok: false,
      files: [],
      warnings: doc.warnings,
      errors: [...doc.errors, listError],
    };
  }
  const load = {
    ...await repairDocument(doc, opts),
    ...opts.readWithoutDialect ? {readWithoutDialect: true} : {},
  };

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
            profileParseError(
                input.fileName, yamlErrorMessage(problem, f.content)) :
            `the import writes '${f.fileName}', which does not parse: ${
                yamlErrorMessage(problem, f.content)}`);
  }
  if (files.length > 0 && doc.errors.length === 0) {
    await validateOutputDocument(files, doc, opts, load);
  }
  // An import that stops writes no file, so it removes no schema line.
  if (doc.schemaLine !== undefined && doc.errors.length === 0) {
    doc.warnings.unshift(
        `Removed the editor schema line '${doc.schemaLine}', which names the ` +
        `input file's schema.`);
  }
  return {
    ok: doc.errors.length === 0,
    files: doc.errors.length === 0 ? files : [],
    warnings: doc.warnings,
    errors: doc.errors,
  };
}
