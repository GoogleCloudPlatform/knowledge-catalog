// Imports a third-party (or first-party) semantic model YAML document into a
// valid kcmd semantic model document.

import {isDeepStrictEqual} from 'node:util';
import * as yaml from 'yaml';

import {checkProfileFileName, ProfileFileError, profileNameError, profileParseError, vanillaSiblingError} from '../layouts/semantic-model';
import {checkCatalogAspects} from './deploy_knowledge_catalog';
import {deploymentTargetError, targetProblem} from './deployment_target';
import {ALLOWED_DIALECTS, coversKey, isFieldBound, normalizeDataType, ProfileSpec, SemanticModel, SqlDialect} from './ir';
import {bareNameParts, bareNameSegments, ConstructPlacement, dialectLookupKey, dottedPartProblem, entityWord, fillForm, FORMAT_VERSION_PLACEMENT, FormatVersion, fromDocument, GOOGLE_VENDOR, GOOGLE_VERSION, hasGoogleBlock, hasUnquotedWhitespace, isAcceptedSource, isFormatVersion, isGoogleCloudForm, isGoogleVendor, isRecord, listed, loadModels, metricTableEntities, modelAiContexts, NO_SPACE, noSqlReason, oldSourceForm, OSSIE_ROOT_VERSION, OSSIE_VERSION, parseSource, rootModelVersion, SemanticModelError, TABLE_FORMS, THIRD_PARTY_SOURCE} from './loader';
import {MAX_ENTRY_DESCRIPTION, NameKind, nameProblem} from './names';
import {SerializedFile} from './osi_converter';
import {columnField, documentDatasets, FieldColumn, fieldSoleColumn, OssieDataset, ossieNamesRewritten, ossieOnlyQualifier} from './ossie_names';
import {sentence} from './parameters';
import {updatedData} from './pull_update';
import {declaredProfiles, DialectLoad, loadProfileFile, namedProfileErrors, plainCopy, possibleDialects, ProfileFiles, readerMessage, sourcesDialect, transpilesSomething, TranspileOutcomes} from './resolve_profiles';
import {SourceDialects, sourcesToLookUp, tableFqnParts} from './source_dialect';
import {columnKey, columnName, columnsForSource, columnsRewritten, columnsWithoutDialect, entitiesReached, fieldsReadOn, isColumnName, NameInText, qualifiedName, sameColumns, WrittenName} from './sql_expr_utils';
import {loadSqlEngine, withoutEngineMessages} from './sql_parser';
import {hasDoubleQuotedColumn, transpileModel} from './transpile';
import {localChecks, pruningLines, withProfileFiles, yamlChangedStatementErrors} from './validate';
import {YAML_OPTIONS, yamlErrorMessage} from './yaml_options';
import {aliasesWritten, linkNodes, movedItems, nodeJson, parseForUpdate, updateText, valuesListed, wrappedRoot} from './yaml_update';

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
   * files `texts` name, as `sourceDialects` does for push. Without it, the
   * dialect of each such table is unknown.
   */
  readDialects?: (texts: string[]) => Promise<SourceDialects>;
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
  /**
   * The input as the author wrote it, which the loads give the loader for
   * its advice about a text a comma split (see LoadOptions.authoredText).
   */
  authored: string;
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
  /**
   * Set when the input held its model at the document root, as Apache Ossie
   * '0.3.0.dev0' files and the Ossie converters' '0.2.0.dev0' files do. The
   * parse step has wrapped it in `semantic_model` and moved each metric a
   * dataset declares to the model's `metrics`. `datasetMetrics` lists those
   * metrics, each with the name of its dataset and its name as written.
   * `reports` holds the warnings that report the conversion's edits, which
   * go into `warnings` at offset `at` once the repair step has removed the
   * objects it removes (see Report). `added` lists the fields the conversion
   * adds for the columns metrics read as `source.<column>`.
   */
  rootModel?: {
    version: string;
    datasetMetrics:
        Array<{metric: Record<string, any>; dataset: string; name: string}>;
    /** The expressions whose `sql` the parse step moved into `dialects`. */
    sqlMoved: object[];
    reports: Report[];
    added: AddedField[];
    at: number;
  };
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

/**
 * A report of an edit the conversion of a model read from the document root
 * makes: a sentence, and the item of the list the warning it starts ends
 * with, if any. A sentence or item given as a function is read once the
 * repair step has removed the objects it removes, and is left out when the
 * function gives undefined. The report is left out when import removes
 * `about`, the field, metric or relationship whose edit it reports, or every
 * object of `about` given as a list.
 */
interface Report {
  sentence: string|(() => string | undefined);
  item?: string|(() => string | undefined);
  about?: object|object[];
}

/**
 * An alias that the conversion of a model read from the document root wrote
 * as its anchor's value: the anchor's name, and the keys and indexes from
 * the document root to the alias.
 */
interface AliasSite {
  anchor: string;
  path: Array<string|number>;
}

/**
 * A field the conversion of a model read from the document root adds to `ds`
 * for a column of its source, as the first text that reads it names the
 * column, with each text that reads the column as `source.<column>`: its
 * metric, the text it writes the column as, the column as it names it, and
 * the entry the field takes for it.
 */
interface AddedField {
  ds: Record<string, any>;
  column: FieldColumn;
  field: Record<string, any>;
  readers: Array<{
    metric: Record<string, any>; written: string; column: FieldColumn;
    entry: {dialect: string; expression: string};
  }>;
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

// The dialect the tables of `doc`'s datasets imply, as push reads it with the
// dialects `load` gives, in which push reads an ANSI_SQL text of the model.
function modelDialect(doc: ImportDocument, load: DialectLoad):
    string|null|undefined {
  return sourcesDialect(
      {entities: doc.datasets.map(ds => lookedUpEntity(ds, load))});
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

// The keys an Ossie object lists its extension blocks under: the one kcmd
// reads, and the one Apache Ossie '0.3.0.dev0' names.
const EXTENSION_KEYS = ['custom_extensions', 'nonportable_extensions'];

/**
 * The words a message names metric `mt` of `doc` by: its name, and for a
 * metric a dataset of a model read from the document root declared, its name
 * as written and its dataset's name.
 */
function metricLabel(mt: Record<string, any>, doc?: ImportDocument): string {
  const moved = doc?.rootModel?.datasetMetrics.find(m => m.metric === mt);
  return moved ? `metric '${moved.name}' of dataset '${moved.dataset}'` :
                 `metric '${mt.name}'`;
}

/**
 * Each object of `model`, a model at the document root, that may carry
 * extension blocks or an expression, with the words a message names it by,
 * and for a field, the name of its dataset. `doc` names the metrics its
 * datasets declared.
 */
function modelObjects(model: Record<string, any>, doc?: ImportDocument):
    Array<{obj: Record<string, any>; label: string; dataset?: string}> {
  const datasets = asRecords(model.datasets);
  return [
    {obj: model, label: `model '${model.name}'`},
    ...datasets.flatMap(ds => {
      const label = `dataset '${ds.name}'`;
      return [
        {obj: ds, label},
        ...asRecords(ds.fields).map(f => ({
          obj: f,
          label: `field '${ds.name}.${f.name}'`,
          dataset: String(ds.name),
        })),
        ...asRecords(ds.metrics).map(
            mt => ({obj: mt, label: `metric '${mt.name}' of ${label}`})),
      ];
    }),
    ...asRecords(model.relationships)
        .map(r => ({obj: r, label: `relationship '${r.name}'`})),
    ...asRecords(model.metrics)
        .map(mt => ({obj: mt, label: metricLabel(mt, doc)})),
  ];
}

/**
 * Records a report of an edit the conversion of a model read from the
 * document root makes (see Report).
 */
function report(
    doc: ImportDocument, sentence: Report['sentence'], item?: Report['item'],
    about?: object): void {
  doc.rootModel!.reports.push({sentence, item, about});
}

/**
 * Whether a text of `dialect` on a table of `table` writes one of `parts` in
 * double quotes that import reads as a name and the table's database reads
 * as text: an ANSI_SQL text on a BigQuery table does.
 */
function readsAsText(
    dialect: string, table: string|undefined,
    ...parts: Array<WrittenName|undefined>): boolean {
  return dialect === 'ANSI_SQL' && table === 'BIGQUERY' &&
      parts.some(p => p?.quoted && p.written.startsWith('"'));
}

/**
 * Reports `item`, a double-quoted word of an ANSI_SQL text on a BigQuery
 * table that import edits as a name, for `about`, grouped in one warning
 * (see readsAsText). `item` given as a function is read once the repair step
 * is done.
 */
function doubleQuotesReport(
    doc: ImportDocument, item: Report['item'], about: object): void {
  report(
      doc,
      `Read these double-quoted words in ANSI_SQL texts on BigQuery tables ` +
          `as names, as ANSI_SQL reads double quotes; BigQuery reads a ` +
          `double-quoted word as text`,
      item, about);
}

/** Whether `obj`, an object of `doc`, is still in the model import writes. */
function inOutput(doc: ImportDocument, obj: object): boolean {
  return obj === doc.model || doc.metrics.includes(obj as any) ||
      doc.relationships.includes(obj as any) ||
      doc.datasets.some(ds => ds === obj || asRecords(ds.fields).includes(obj));
}

/**
 * The field, metric, relationship or dataset of `model`, a model read from
 * the document root, that holds the value at `path`, a path from the root of
 * the document that wraps the model in `semantic_model`, or else `model`.
 */
function holderAt(
    model: Record<string, any>, path: Array<string|number>): object {
  const [, , list, i, key, j] = path;
  const item = (v: unknown, k: unknown) =>
      Array.isArray(v) && typeof k === 'number' && isRecord(v[k]) ? v[k] :
                                                                    undefined;
  if (list === 'metrics' || list === 'relationships') {
    return item(model[list], i) ?? model;
  }
  const ds = list === 'datasets' ? item(model.datasets, i) : undefined;
  if (!ds) return model;
  return (key === 'fields' || key === 'metrics') && item(ds[key], j) || ds;
}

/**
 * Writes the reports `report` recorded into `doc.warnings`, one warning per
 * sentence, and leaves out each report of an object import removed (see
 * Report).
 */
function writeReports(doc: ImportDocument): void {
  const {reports, at} = doc.rootModel!;
  const read = (v: Report['item']) => typeof v === 'function' ? v() : v;
  const lists = new Map<string, string[]>();
  for (const r of reports) {
    const kept = !r.about || [r.about].flat().some(o => inOutput(doc, o));
    const sentence = kept ? read(r.sentence) : undefined;
    const item = read(r.item);
    if (sentence === undefined || r.item !== undefined && item === undefined) {
      continue;
    }
    const items = lists.get(sentence) ?? [];
    if (item !== undefined && !items.includes(item)) items.push(item);
    lists.set(sentence, items);
  }
  doc.warnings.splice(
      at, 0,
      ...[...lists].map(
          ([sentence, items]) =>
              items.length ? `${sentence}: ${items.join(', ')}.` : sentence));
  reports.length = 0;
}

/**
 * The errors that stop the import of `model`, a model at the document root of
 * a `version` file: an expression whose `sql` holds no SQL, or for a field,
 * only the qualifier that names its dataset (see noSqlReason), an object
 * with both extension keys, and a `GOOGLE` block under either key, which kcmd
 * never writes in such a file.
 */
function rootModelRefusals(
    model: Record<string, any>, version: string): string[] {
  const errors: string[] = [];
  const google: string[] = [];
  for (const {obj, label, dataset} of modelObjects(model)) {
    const e = obj.expression;
    const sql = isRecord(e) && 'sql' in e ? e.sql : '';
    const noSql = !isRecord(e) || !('sql' in e) ? undefined :
        sql === null                            ? 'is empty' :
        typeof sql !== 'string'                 ? 'is not a string' :
        noSqlReason(sql, OSSIE_SQL) ??
            (dataset === undefined ? undefined :
                                     ossieOnlyQualifier(sql, dataset));
    if (noSql) {
      errors.push(
          `${label}: 'sql' in its expression ${noSql}; write the ` +
          `expression's SQL there.`);
    }
    if (EXTENSION_KEYS.every(k => k in obj)) {
      errors.push(
          `${label} has both 'custom_extensions' and ` +
          `'nonportable_extensions'; list its extension blocks under one.`);
    }
    for (const key of EXTENSION_KEYS) {
      if (hasGoogleBlock(asRecords(obj[key]))) {
        google.push(`'${key}' of ${label}`);
      }
    }
  }
  if (google.length) {
    errors.push(
        `Document holds a '${GOOGLE_VENDOR}' block in ${google.join(', ')}. ` +
        `kcmd never writes a '${version}' file with the model at the ` +
        `document root, so the block was not written for kcmd; remove it.`);
  }
  return errors;
}

/**
 * `text`, which `document` parses and which holds a model at the document
 * root, with the model wrapped in `semantic_model`, each metric its datasets
 * declare moved to the model's `metrics`, and the `sql` of each field and
 * metric expression written as the first entry of its `dialects`, in
 * OSSIE_SQL_2026, all by text edits, so every value keeps its text and every
 * comment stays. A move whose text would not read as the moved value is left
 * for the convert step, which makes it by value. An alias the edits would put
 * before its anchor is written as the anchor's value. Gives the new text and
 * its document, each alias so written with its anchor's name and its path,
 * and the path of each expression whose `sql` the edits moved.
 */
function rootModelText(text: string, document: yaml.Document.Parsed): {
  text: string; document: yaml.Document.Parsed; aliases: AliasSite[];
  sqlPaths: Array<Array<string|number>>;
} {
  const aliases: AliasSite[] = [];
  // The text and document of `edited` with its aliases written, when it
  // reads as `expected`.
  const reading = (edited: string, expected: unknown) => {
    const written = aliasesWritten(edited);
    const parsed = parseForUpdate(written.text).document;
    try {
      if (parsed.errors.length || !isDeepStrictEqual(parsed.toJS(), expected)) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    aliases.push(...written.sites);
    return {text: written.text, document: parsed};
  };
  const wrapped = aliasesWritten(
      wrappedRoot(text, document, 'semantic_model', ['version']));
  aliases.push(...wrapped.sites);
  let current = {
    text: wrapped.text,
    document: parseForUpdate(wrapped.text).document,
  };
  const model = () =>
      current.document.getIn(['semantic_model', 0], true) as yaml.YAMLMap;
  const datasets = () => {
    const list = model().get('datasets', true);
    return yaml.isSeq(list) ? list.items : [];
  };
  // The metrics move.
  const moved = current.document.toJS();
  const movedModel = moved.semantic_model[0];
  for (const ds of asRecords(movedModel.datasets)) {
    if (!('metrics' in ds)) continue;
    const items = asRecords(ds.metrics);
    if (items.length) {
      movedModel.metrics = [...asRecords(movedModel.metrics), ...items];
    }
    delete ds.metrics;
  }
  const metricsText = movedItems(
      current.text, current.document, datasets().filter(yaml.isMap), model(),
      'metrics');
  current = (metricsText !== undefined && reading(metricsText, moved)) ||
      current;
  // The `sql` move, in each field and metric expression. A value written as
  // an alias, at any level, is its anchor's node, so an expression shared so
  // moves once and each of its paths is listed.
  const resolved = (node: unknown) =>
      yaml.isAlias(node) ? node.resolve(current.document) : node;
  const paths: Array<Array<string|number>> = [];
  datasets().forEach((item, i) => {
    const ds = resolved(item);
    for (const key of ['fields', 'metrics']) {
      const list = yaml.isMap(ds) ? resolved(ds.get(key, true)) : undefined;
      if (!yaml.isSeq(list)) continue;
      list.items.forEach(
          (_, j) => paths.push(
              ['semantic_model', 0, 'datasets', i, key, j, 'expression']));
    }
  });
  const metrics = resolved(model().get('metrics', true));
  if (yaml.isSeq(metrics)) {
    metrics.items.forEach(
        (_, j) => paths.push(['semantic_model', 0, 'metrics', j, 'expression']));
  }
  const maps = paths.map(
      p => p.reduce(
          (node: unknown, key) => yaml.isMap(node) || yaml.isSeq(node) ?
              resolved(node.get(key, true)) :
              undefined,
          current.document.contents));
  const listed = valuesListed(
      current.text, current.document, [...new Set(maps.filter(yaml.isMap))],
      'sql', 'dialects', {dialect: OSSIE_SQL}, 'expression');
  const sqlPaths = paths.filter(
      (_, k) => listed.changed.includes(maps[k] as yaml.YAMLMap));
  const listedValue = current.document.toJS();
  const done = new Set<object>();
  for (const path of sqlPaths) {
    const e = path.reduce((v: any, k) => v[k], listedValue);
    if (done.has(e)) continue;
    done.add(e);
    e.dialects =
        [{dialect: OSSIE_SQL, expression: e.sql}, ...(e.dialects ?? [])];
    delete e.sql;
  }
  const sqlText = listed.changed.length ?
      reading(listed.text, listedValue) :
      undefined;
  return sqlText ? {...sqlText, aliases, sqlPaths} :
                   {...current, aliases, sqlPaths: []};
}

/**
 * The metrics `input`, a model at the document root as written, declares in
 * its datasets, each with the name of its dataset, as they sit at the end of
 * the metrics of `doc`, which holds the same model wrapped. The parse step
 * moves them by a text edit, which moves the metrics of a dataset an alias
 * repeats once, so that dataset counts once. Metrics the parse step could
 * not move so move to the end of the model's `metrics` here, each with the
 * name of the dataset it moves from.
 */
function movedDatasetMetrics(
    doc: ImportDocument, input: Record<string, any>):
    Array<{metric: Record<string, any>; dataset: string; name: string}> {
  if (doc.datasets.some(ds => 'metrics' in ds)) {
    const moved = [];
    for (const ds of doc.datasets) {
      if (!('metrics' in ds)) continue;
      moved.push(...asRecords(ds.metrics).map(
          metric => ({metric, dataset: String(ds.name), name: metric.name})));
      delete ds.metrics;
    }
    if (moved.length) {
      doc.model.metrics = [...doc.metrics, ...moved.map(m => m.metric)];
    }
    doc.metrics = asRecords(doc.model.metrics);
    doc.modified = true;
    return moved;
  }
  const declared = [...new Set(asRecords(input.datasets))].flatMap(
      ds => asRecords(ds.metrics).map(() => String(ds.name)));
  return doc.metrics.slice(doc.metrics.length - declared.length)
      .map((metric, i) => ({metric, dataset: declared[i], name: metric.name}));
}

/**
 * Renames key `from` of `obj`, an object of `doc.root`, to `to`, keeping its
 * place among the keys. The key is renamed in `doc.document` too, so the
 * writer changes only the key's text.
 */
function renameKey(
    doc: ImportDocument, obj: Record<string, any>, from: string,
    to: string): void {
  const entries = Object.entries(obj);
  for (const k of Object.keys(obj)) delete obj[k];
  for (const [k, v] of entries) obj[k === from ? to : k] = v;
  const node = doc.links.get(obj);
  const pair = yaml.isMap(node) ?
      node.items.find(p => yaml.isScalar(p.key) && p.key.value === from) :
      undefined;
  if (pair) (pair.key as yaml.Scalar).value = to;
  doc.modified = true;
}

/**
 * Writes each extension block of a model read from the document root as
 * kcmd reads one: in `custom_extensions`, renamed from
 * `nonportable_extensions`, with object `data` as one line of compact JSON.
 * Reports the blocks whose data it writes as JSON in one warning, and the
 * other blocks it moves to `custom_extensions` in another. A value JSON has
 * no form for is an error.
 */
function convertExtensionBlocks(doc: ImportDocument): void {
  for (const {obj, label} of modelObjects(doc.model, doc)) {
    const renamed = 'nonportable_extensions' in obj;
    if (renamed) {
      renameKey(doc, obj, 'nonportable_extensions', 'custom_extensions');
    }
    const vendors: string[] = [];
    // The blocks that move with their data as written.
    const moved: string[] = [];
    // The node of each block. A block or list written as an alias is copied
    // from its anchor's node, which `links` does not map it to.
    const resolved = (n: unknown) =>
        yaml.isAlias(n) ? n.resolve(doc.document) : n;
    const own = resolved(doc.links.get(obj));
    const list = yaml.isMap(own) ?
        resolved(own.get('custom_extensions', true)) :
        undefined;
    const blocks: unknown[] =
        Array.isArray(obj.custom_extensions) ? obj.custom_extensions : [];
    for (const [i, b] of blocks.entries()) {
      if (!isRecord(b)) continue;
      if (isRecord(b.data)) {
        const node = doc.links.get(b) ??
            (yaml.isSeq(list) ? resolved(list.items[i]) : undefined);
        const data = yaml.isMap(node) ? node.get('data', true) : undefined;
        const json =
            nodeJson(data ?? doc.document.createNode(b.data), doc.document);
        if (typeof json !== 'string') {
          const where = `${label}: the data of its '${b.vendor_name}' ` +
              `extension block holds`;
          doc.errors.push(
              json.key ?
                  `${where} two keys that JSON writes as '${json.text}'` +
                      `${json.path ? ` in '${json.path}'` : ''}, so JSON ` +
                      `cannot tell them apart; rename one.` :
                  `${where} '${json.text}' at '${json.path}', which JSON ` +
                      `cannot write; write it in quotes or remove it.`);
          continue;
        }
        b.data = json;
        doc.modified = true;
      } else {
        if (renamed) moved.push(`'${b.vendor_name}'`);
        continue;
      }
      vendors.push(`'${b.vendor_name}'`);
    }
    if (vendors.length) {
      report(
          doc,
          `Wrote these extension blocks under 'custom_extensions' with ` +
              `their data as JSON text, as '${doc.targetVersion}' reads them, ` +
              `and dropped any comments inside the data`,
          `${label} (${vendors.join(', ')})`, obj);
    }
    if (moved.length) {
      report(
          doc,
          `Wrote these extension blocks under 'custom_extensions', as '${
              doc.targetVersion}' reads them, and kept their data as written`,
          `${label} (${moved.join(', ')})`, obj);
    }
  }
}

// The dialect Apache Ossie writes `expression.sql` in.
const OSSIE_SQL: SqlDialect = 'OSSIE_SQL_2026';

/**
 * Writes the `sql` of each expression of a model read from the document root
 * as the first entry of its `dialects`, in OSSIE_SQL_2026, the dialect Ossie
 * writes `sql` in, and reports the expressions in one warning. The parse step
 * has moved most of them by text; the rest move here by value, with the
 * `sql` key's text written as `dialects`, so the comments around it stay.
 * `sql` takes precedence over an OSSIE_SQL_2026 entry, so such an entry is
 * dropped and reported.
 */
function convertSqlExpressions(doc: ImportDocument): void {
  const moved = new Set(doc.rootModel!.sqlMoved);
  for (const {obj, label} of modelObjects(doc.model, doc)) {
    const e = obj.expression;
    if (!isRecord(e) || !('sql' in e) && !moved.has(e)) continue;
    report(
        doc,
        `Wrote the 'sql' of these expressions as an '${OSSIE_SQL}' entry ` +
            `of 'dialects', as '${doc.targetVersion}' reads it`,
        label, obj);
    // The entry the parse step wrote for `sql` comes first.
    const dialects: unknown[] = Array.isArray(e.dialects) ?
        e.dialects.slice(moved.has(e) ? 1 : 0) :
        [];
    const kept = dialects.filter(
        d => !isRecord(d) || typeof d.dialect !== 'string' ||
            d.dialect.trim().toUpperCase() !== OSSIE_SQL);
    if (kept.length < dialects.length) {
      report(
          doc,
          `${label}: dropped its '${OSSIE_SQL}' dialects entry, since 'sql' ` +
              `holds its '${OSSIE_SQL}' expression and takes precedence.`,
          undefined, obj);
    }
    if (moved.has(e)) {
      e.dialects.splice(1, e.dialects.length - 1, ...kept);
    } else if (Array.isArray(e.dialects)) {
      e.dialects.splice(
          0, e.dialects.length, {dialect: OSSIE_SQL, expression: e.sql},
          ...kept);
      delete e.sql;
    } else {
      const entry = {dialect: OSSIE_SQL, expression: e.sql};
      delete e.dialects;
      renameKey(doc, e, 'sql', 'dialects');
      e.dialects = [entry];
    }
    doc.modified = true;
  }
}

/**
 * Each text of `obj.expression` in a dialect kcmd runs, with that dialect, a
 * function that replaces the text, the dialect name an entry import adds
 * for the text takes, and the object that holds the text. The name is the
 * dialect, or a vendor label as written, whose dialect repairDocument names
 * by the tables that run it. The object is the `dialects` entry, or `obj`
 * for an expression written as a string, which is an ANSI_SQL text, as kcmd
 * reads it.
 */
function expressionTexts(obj: Record<string, any>): Array<{
  text: string; dialect: SqlDialect; set: (text: string) => void;
  label: string; entry: object;
}> {
  if (typeof obj.expression === 'string') {
    const set = (t: string) => obj.expression = t;
    return [{
      text: obj.expression, dialect: 'ANSI_SQL', set, label: 'ANSI_SQL',
      entry: obj,
    }];
  }
  return asRecords(obj.expression?.dialects).flatMap(d => {
    const dialect =
        typeof d.dialect === 'string' ? kcmdDialect(d.dialect) : undefined;
    if (!dialect || typeof d.expression !== 'string') return [];
    const label =
        DIALECT_ALIASES[d.dialect.trim().toUpperCase()] ? d.dialect : dialect;
    const set = (t: string) => d.expression = t;
    return [{text: d.expression, dialect, set, label, entry: d}];
  });
}

/** The names of `objects`. */
function namesOf(objects: Array<Record<string, any>>): string[] {
  return objects.map(o => o.name)
      .filter((n): n is string => typeof n === 'string');
}

/**
 * The datasets of `doc` as Ossie's name rules read them, each with the
 * fields of it that `removed` lists, which import has taken off.
 */
function ossieModel(
    doc: ImportDocument,
    removed?: ReadonlyMap<string, readonly string[]>): OssieDataset[] {
  return documentDatasets(doc.datasets, removed);
}

/**
 * The column field `f` of dataset `ds` reads, as each of its texts in a
 * dialect kcmd runs names it, when each is that one column, as
 * fieldSoleColumn reads them, with the names in `datasets`, comparing an
 * ANSI_SQL text as a text of `tableDialect`. A text `asWritten` gives for
 * its entry is read in its place. Undefined otherwise.
 */
function fieldColumn(
    f: Record<string, any>, ds: Record<string, any>,
    datasets: readonly OssieDataset[], tableDialect?: string,
    asWritten?: ReadonlyMap<object, string>): FieldColumn[]|undefined {
  return fieldSoleColumn(
      expressionTexts(f).map(t => ({
                               dialect: t.dialect,
                               expression: asWritten?.get(t.entry) ?? t.text,
                             })),
      String(ds.name), datasets, tableDialect);
}

/**
 * Reports that kcmd cannot parse the OSSIE_SQL_2026 text `text` of `obj`,
 * which `label` names, so import leaves its names as written. `entry` is the
 * object that holds the text. Nothing is reported when `entry` or the
 * expression of `obj` holds a key with no value. The load refuses that key.
 * When the key is the rest of a text a comma split, the load's error says to
 * quote the text.
 */
function unreadOssieText(
    doc: ImportDocument, label: string,
    {text, entry}: {text: string; entry: object},
    obj: Record<string, any>): void {
  const bare = (o: unknown) => isRecord(o) && Object.values(o).includes(null);
  if (bare(entry) || bare(obj.expression)) return;
  report(
      doc,
      `${label}: kcmd cannot parse its '${OSSIE_SQL}' expression '${
          text}', so import left its names as written, and --transpile ` +
          `does not translate it.`,
      undefined, obj);
}

/**
 * The entity metric `mt` is anchored on: its `entity`, or the `entity` of a
 * GOOGLE block, or undefined.
 */
function metricAnchor(mt: Record<string, any>): string|undefined {
  const blocks = parseGoogleBlocks(mt.custom_extensions);
  return [mt.entity, ...blocks.map(b => b.entity)].find(
      (a): a is string => typeof a === 'string');
}

/** `name`, a declared name, as a text writes it without quotes. */
function bareName(name: string): WrittenName {
  return {written: name, name, quoted: false};
}

/**
 * The name of `declared` that `written`, a name a text of `dialect` writes,
 * names: the one it spells, or else the first one the text's database reads
 * as the same name, as it reads a column's name (see sameColumns). An
 * ANSI_SQL text reads a name as the database of the table `tableOf` gives
 * for that declared name does. An OSSIE_SQL_2026 text gives each name it
 * matches as declared (see ossieNamesRewritten), so there only the spelling
 * counts.
 */
function declaredName(
    written: WrittenName, declared: readonly string[], dialect: string,
    tableOf: (name: string) => string | undefined): string|undefined {
  const spelled = declared.find(n => n === written.name);
  if (spelled !== undefined || dialect === OSSIE_SQL) return spelled;
  return declared.find(n => sameColumns([
    columnKey(written, dialect, tableOf(n)),
    columnKey(bareName(n), dialect, tableOf(n)),
  ]));
}

/**
 * Removes from each field expression of a model read from the document root the
 * qualifier that names the field's own dataset, so the name reads as a column
 * of the dataset's source, as Apache Ossie reads it, and reports the fields in
 * one warning. The names of an OSSIE_SQL_2026 text are read by Ossie's rules
 * (see ossieNamesRewritten), and those of a text in another dialect by kcmd's
 * (see columnsRewritten), so an ANSI_SQL text's double quotes hold a name.
 * There a qualifier names a dataset as the text's database reads names (see
 * declaredName). A column that does not read as that column where it stands, as
 * written or without the qualifier, as `current_date` does not, is written as
 * its text's dialect reads it, on the dataset's table, whose dialect `load`
 * gives (see columnName), and reported in one warning. In a text of a dialect
 * other than OSSIE_SQL_2026, a column written without a qualifier stays as
 * written. A double-quoted word of an ANSI_SQL text on a BigQuery table that
 * this edits is reported in one warning (see doubleQuotesReport).
 * A qualifier in a subquery with its own FROM stays, since without it the
 * name may read a column of the subquery's tables, and a warning says what
 * to do. So does a qualifier there that names another dataset and a table or
 * alias of that FROM, since it may name that table. Any other qualifier that
 * names another dataset is an error. An OSSIE_SQL_2026 text kcmd cannot
 * parse stays as written, with a warning. Returns the fields with such an
 * error, and each OSSIE_SQL_2026 text this edits as written, by its entry
 * (see expressionTexts).
 */
function rewriteFieldExpressions(doc: ImportDocument, load: DialectLoad):
    {refused: Set<object>; asWritten: Map<object, string>} {
  const datasets = namesOf(doc.datasets);
  const names = new Set(datasets.map(n => n.toLowerCase()));
  const ossie = ossieModel(doc);
  const refused = new Set<object>();
  const asWritten = new Map<object, string>();
  for (const ds of doc.datasets) {
    const table = tableDialect(ds, load) ?? undefined;
    for (const f of asRecords(ds.fields)) {
      let other: string|undefined;
      const label = `field '${ds.name}.${f.name}'`;
      for (const t of expressionTexts(f)) {
        let unqualified = false;
        const rewrite = (c: {
          qualifier?: WrittenName; name: WrittenName; inSubquery: boolean;
          bound: boolean; at: NameInText;
        }) => {
          if (!c.qualifier) {
            if (t.dialect !== OSSIE_SQL) return undefined;
            const column = columnName(c.name, t.dialect, table, c.at);
            if (column === c.name.written) return undefined;
            report(
                doc,
                `Rewrote these column names so that the text's dialect ` +
                    `reads each as its column`,
                `${label} '${c.name.written}' to '${column}'`, f);
            return column;
          }
          const dataset =
              declaredName(c.qualifier, datasets, t.dialect, () => table);
          if (dataset && c.inSubquery && (dataset === ds.name || c.bound)) {
            const before = `${c.qualifier!.written}.${c.name.written}`;
            const left = `${label}: left '${before}' as written, since it ` +
                `sits in a subquery with its own FROM, where `;
            report(
                doc,
                dataset === ds.name ?
                    `${left}'${c.name.written}' without the qualifier may ` +
                        `read a column of the subquery's tables. kcmd reads a ` +
                        `field's columns without a qualifier, so remove the ` +
                        `qualifier if those tables have no column '${
                            c.name.name}', or else write the expression ` +
                        `without the subquery.` :
                    `${left}'${c.qualifier!.written}' may name a table of ` +
                        `that FROM. A field expression cannot read dataset ` +
                        `'${dataset}', so give that table an alias and ` +
                        `qualify the column with it.`,
                undefined, f);
          } else if (dataset === ds.name) {
            const column = columnName(c.name, t.dialect, table, c.at);
            const before = `${c.qualifier!.written}.${c.name.written}`;
            if (readsAsText(t.dialect, table, c.qualifier, c.name)) {
              doubleQuotesReport(
                  doc, `'${before}' in ${label} as column '${column}'`, f);
            } else if (column !== c.name.written) {
              report(
                  doc,
                  `Rewrote these column names so that the text's dialect ` +
                      `reads each as its column`,
                  `${label} '${c.qualifier!.written}.${c.name.written}' to ` +
                      `'${column}'`,
                  f);
            }
            unqualified = true;
            return column;
          } else if (dataset) {
            other ??= `${c.qualifier!.written}.${c.name.written}`;
          }
          return undefined;
        };
        const text = t.dialect === OSSIE_SQL ?
            ossieNamesRewritten(
                t.text, {kind: 'field', dataset: String(ds.name), datasets: ossie},
                rewrite) :
            columnsRewritten(t.text, t.dialect, names, rewrite);
        if (text === undefined) {
          unreadOssieText(doc, label, t, f);
          continue;
        }
        if (text !== t.text) {
          if (t.dialect === OSSIE_SQL) asWritten.set(t.entry, t.text);
          t.set(text);
          doc.modified = true;
        }
        if (unqualified) {
          report(
              doc,
              `Removed the qualifier that names the field's own dataset ` +
                  `from the expressions of these fields, since kcmd reads a ` +
                  `column of the dataset's source unqualified`,
              label, f);
        }
      }
      if (other) {
        doc.errors.push(
            `${label}: its expression reads '${other}', a column of another ` +
            `dataset; a field expression reads only the columns of its own ` +
            `dataset's source.`);
        refused.add(f);
      }
    }
  }
  return {refused, asWritten};
}

/**
 * `name`, when `taken` does not hold it in lower case, or else `other`, or
 * that with `_2`, `_3` and so on, the first `taken` does not hold.
 */
function freeName(
    name: string, other: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  let free = other;
  for (let n = 2; taken.has(free.toLowerCase()); n++) free = `${other}_${n}`;
  return free;
}

/**
 * The names a metric anchored on `ds`, or a field of `ds`, may not take, in
 * lower case, since kcmd compares them ignoring case: each field of `ds` and
 * each of `metrics`.
 */
function namesInUse(
    ds: Record<string, any>|undefined,
    metrics: Array<Record<string, any>>): Set<string> {
  return new Set([...namesOf(asRecords(ds?.fields)), ...namesOf(metrics)].map(
      n => n.toLowerCase()));
}

/**
 * Renames each metric that a dataset of a model read from the document root
 * declared, when another metric or a field of its dataset has its name, to
 * `<dataset>_<metric>`, or that with `_2`, `_3` and so on. The model's own
 * metrics keep their names, and dataset metrics take theirs in order. Runs
 * once the repair step has removed the metrics it removes, so only the
 * metrics import writes count. Reports each rename. A new name the name rule
 * refuses is an error.
 */
function renameDatasetMetrics(doc: ImportDocument): void {
  const {datasetMetrics} = doc.rootModel!;
  const moved = new Set(datasetMetrics.map(m => m.metric));
  const named = doc.metrics.filter(mt => !moved.has(mt));
  for (const {metric, dataset} of datasetMetrics) {
    if (!doc.metrics.includes(metric)) continue;
    const ds = doc.datasets.find(d => d.name === dataset);
    const {name} = metric;
    if (typeof name !== 'string') continue;
    const free =
        freeName(name, `${dataset}_${name}`, namesInUse(ds, named));
    named.push(metric);
    if (free === name) continue;
    const label = `metric '${name}' of dataset '${dataset}'`;
    const why =
        `another metric or a field of dataset '${dataset}' has its name`;
    const problem = nameProblem('metric', free);
    if (problem) {
      doc.errors.push(
          `${label}: ${why}, and its new name breaks the name rule: ` +
          `${problem} Rename the metric.`);
      continue;
    }
    metric.name = free;
    doc.modified = true;
    report(doc, `${label}: renamed to '${free}', since ${why}.`);
  }
}

/**
 * Rewrites the names the metrics of a model read from the document root read in
 * each of their texts. The names of an OSSIE_SQL_2026 text are read by Ossie's
 * rules (see ossieNamesRewritten), and those of a text in another dialect by
 * kcmd's (see columnsRewritten), so an ANSI_SQL text's double quotes hold a
 * name. There a dataset or field name names the declared name the text's
 * database reads as that name (see declaredName). A metric a dataset declared
 * names that dataset's fields unqualified, which are qualified with the
 * dataset's name, reported in one warning, and a column of its source as
 * `source.column`, which becomes the field that reads that column, reported in
 * one warning. The field is the one columnField finds. When no field reads the
 * column, a field is added, listed in `doc.rootModel.added`, and reported. A
 * dataset or field name that does not read as that name as written, as `date`
 * does not, or as a name in another letter case does not, is written as
 * declared, as its text's dialect reads it (see qualifiedName), and reported in
 * one warning. A double-quoted word of an ANSI_SQL text on a BigQuery table
 * that this edits is reported in one warning (see doubleQuotesReport). An
 * OSSIE_SQL_2026 text kcmd cannot parse stays as written, with a warning.
 */
function rewriteMetricNames(
    doc: ImportDocument, load: DialectLoad,
    removed: ReadonlyMap<string, readonly string[]>): void {
  const datasets = namesOf(doc.datasets);
  const dataset = (name?: string) => doc.datasets.find(ds => ds.name === name);
  // The fields of `ds`, those import has taken off included.
  const fieldsOf = (ds: Record<string, any>|undefined) => [
    ...namesOf(asRecords(ds?.fields)), ...removed.get(String(ds?.name)) ?? []
  ];
  const anchors = new Map(
      doc.rootModel!.datasetMetrics.map(m => [m.metric, m.dataset]));
  const names = new Set([
    'source', ...datasets, ...doc.datasets.flatMap(fieldsOf),
  ].map(n => n.toLowerCase()));
  const ossie = ossieModel(doc, removed);
  const table = (ds: Record<string, any>|undefined) =>
      (ds && tableDialect(ds, load)) ?? undefined;
  const implied = modelDialect(doc, load) ?? undefined;
  // Whether qualifier `q` of a metric of `ds`, written in a text of
  // `dialect`, names the source of `ds`. It does when the dialect's database
  // reads it as the name `source` and as no field of `ds`, declared or
  // inherited.
  const namesSource =
      (q: WrittenName, dialect: string, ds: Record<string, any>) => {
        const key = (n: WrittenName) => columnKey(n, dialect, implied);
        const reads = (name: string) =>
            sameColumns([key(q), key(bareName(name))]);
        return reads('source') &&
            !ossie.find(d => d.name === String(ds.name))
                 ?.fields.some(f => reads(f.name));
      };
  const {added} = doc.rootModel!;
  // A dataset or field name import writes with quotes added or removed,
  // which it reports. `after` given as a function is read once the repair
  // step is done, and gives undefined for a name it writes without quotes.
  const quotedReport =
      (mt: Record<string, any>, before: string,
       after: string|(() => string | undefined)) =>
          report(
              doc,
              `Rewrote these dataset and field names that metrics read so ` +
                  `that the text's dialect reads each as the dataset or field ` +
                  `it names`,
              () => {
                const text = typeof after === 'string' ? after : after();
                return text &&
                    `${metricLabel(mt, doc)} '${before}' to '${text}'`;
              },
              mt);
  // `<dataset>.<field>` for field `field` of `ds`, as qualifiedName writes it
  // in `dialect`, reported for metric `mt`, which writes it as `before`, when
  // a part is written in quotes, and when `quotes` says `before` holds a
  // double-quoted word BigQuery reads as text (see readsAsText). The reports
  // read the field's name once the repair step has settled the fields import
  // adds, since a field import renames there can need quotes it did not need
  // before.
  const fieldText =
      (ds: Record<string, any>, field: Record<string, any>, dialect: string,
       mt: Record<string, any>, before: string, quotes: boolean) => {
        const named = () => qualifiedName(
            bareName(ds.name), bareName(field.name), dialect, table(ds));
        quotedReport(mt, before, () => {
          const text = named();
          return text === `${ds.name}.${field.name}` ? undefined : text;
        });
        if (quotes) {
          doubleQuotesReport(
              doc,
              () => `'${before}' in ${metricLabel(mt, doc)} as field '${
                  named()}'`,
              mt);
        }
        return named();
      };
  // The column field `f` of `ds` reads on a table of dialect `on`, as
  // fieldColumn gives it. Each dataset name, table dialect and list of the
  // field's texts is read once, so a field import adds is read again once it
  // gains an entry for another dialect.
  const columns = new Map<string, FieldColumn[]|undefined>();
  const columnOf =
      (f: Record<string, any>, ds: Record<string, any>, on?: string) => {
        const key = JSON.stringify([
          String(ds.name), on ?? null,
          ...expressionTexts(f).map(t => [t.dialect, t.text]),
        ]);
        if (!columns.has(key)) columns.set(key, fieldColumn(f, ds, ossie, on));
        return columns.get(key);
      };
  // The field of `ds` whose one column is `column`, as a text of its dialect
  // names it, as columnField finds it, comparing the texts on the dataset's
  // table.
  const fieldReading = (ds: Record<string, any>, column: FieldColumn) => {
    const fields = asRecords(ds.fields);
    const on = table(ds);
    const read = {
      name: String(ds.name),
      fields: fields.map(f => ({
                           name: String(f.name),
                           column: columnOf(f, ds, on),
                         })),
    };
    const name = columnField(column, read, column.dialect, on);
    return fields.find(f => f.name === name);
  };
  // `<dataset>.<field>` for the field of dataset `ds` that reads `column`, as
  // text `t` writes it, added when no field reads it. Metric `mt` writes it
  // as `written`. Undefined when the name of the field to add breaks the
  // name rule, which is an error. A field import adds takes an entry for the
  // text that reads the column, as a text of its dialect writes the column
  // alone. `quotes` says `written` holds a double-quoted word BigQuery reads
  // as text (see fieldText).
  const sourceField =
      (ds: Record<string, any>, column: WrittenName,
       t: {dialect: SqlDialect; label: string}, mt: Record<string, any>,
       written: string, quotes: boolean): string|undefined => {
        const {dialect} = t;
        const read = {name: column.name, quoted: column.quoted, dialect};
        const entry = {
          dialect: t.label,
          expression: columnName(column, dialect, table(ds)),
        };
        const reader = {metric: mt, written, column: read, entry};
        const reads = fieldReading(ds, read);
        const done = added.find(a => a.field === reads);
        if (done) {
          const dialects = done.field.expression.dialects;
          if (!dialects.some((d: any) => kcmdDialect(d.dialect) === dialect)) {
            dialects.push(entry);
          }
          done.readers.push(reader);
          return fieldText(ds, done.field, dialect, mt, written, quotes);
        }
        if (reads) {
          const text = fieldText(ds, reads, dialect, mt, written, quotes);
          report(
              doc,
              `Wrote each 'source.<column>' these metrics read as the field ` +
                  `of their dataset that reads the column`,
              `${metricLabel(mt, doc)} '${written}' to '${text}'`, mt);
          return text;
        }
        const name = addedFieldName(column.name, ds, doc.metrics);
        const problem = nameProblem('field', name);
        if (problem) {
          const error = `${metricLabel(mt, doc)} reads a column of ` +
              `dataset '${ds.name}' that no field reads, and the name of the ` +
              `field import would add for it breaks the name rule: ${
                  problem} Add a field that reads the column, and name it in ` +
              `the metric.`;
          if (!doc.errors.includes(error)) doc.errors.push(error);
          return undefined;
        }
        const f = {name, expression: {dialects: [entry]}};
        if (Array.isArray(ds.fields)) ds.fields.push(f);
        else ds.fields = [f];
        const readers = [reader];
        added.push({ds, column: read, field: f, readers});
        // The report names the first metric that reads the column and that
        // import keeps, and the column as it names it.
        report(doc, () => {
          const first = readers.find(r => inOutput(doc, r.metric));
          return first &&
              `dataset '${ds.name}': added field '${f.name}', which reads ` +
              `column '${first.column.name}', for metric '${
                  first.metric.name}', which reads it as '${first.written}'.`;
        });
        return fieldText(ds, f, dialect, mt, written, quotes);
      };
  for (const mt of doc.metrics) {
    const own = dataset(anchors.get(mt));
    for (const t of expressionTexts(mt)) {
      const rewrite =
          (c: {qualifier?: WrittenName; name: WrittenName; source?: boolean}) => {
        const q = c.qualifier;
        const before = q ? `${q.written}.${c.name.written}` : c.name.written;
        // In a metric a dataset declared, `source` names the dataset's
        // source, unless the dataset has a field of that name. An
        // OSSIE_SQL_2026 text reads the two names by Ossie's rules, and
        // another text as its dialect does (see namesSource).
        if (own && q &&
            (t.dialect === OSSIE_SQL ? c.source :
                                       namesSource(q, t.dialect, own))) {
          return sourceField(
              own, c.name, t, mt, before,
              readsAsText(t.dialect, table(own), q, c.name));
        }
        const named = q ?
            declaredName(q, datasets, t.dialect, n => table(dataset(n))) :
            own?.name;
        if (named === undefined) return undefined;
        const on = table(dataset(named));
        const field =
            declaredName(c.name, fieldsOf(dataset(named)), t.dialect, () => on);
        if (!q && field === undefined) return undefined;
        // Each name as declared, as an OSSIE_SQL_2026 text gives it.
        const qualifier = q ? {...q, name: named} : bareName(named);
        const fieldName = {...c.name, name: field ?? c.name.name};
        const after = qualifiedName(qualifier, fieldName, t.dialect, on);
        if (!q) {
          report(
              doc,
              `Qualified with their dataset's name the field names these ` +
                  `metrics read unqualified, since kcmd reads a metric's ` +
                  `fields as '<dataset>.<field>'`,
              metricLabel(mt, doc), mt);
        }
        if (after !== before && readsAsText(t.dialect, on, q, c.name)) {
          doubleQuotesReport(
              doc, () => `'${before}' in ${metricLabel(mt, doc)} as field '${after}'`,
              mt);
        } else if (after !== `${qualifier.written}.${fieldName.written}`) {
          quotedReport(mt, before, after);
        }
        return after === before ? undefined : after;
      };
      const text = t.dialect === OSSIE_SQL ?
          ossieNamesRewritten(
              t.text,
              {kind: 'metric', dataset: own && String(own.name), datasets: ossie},
              rewrite) :
          columnsRewritten(t.text, t.dialect, names, rewrite);
      if (text === undefined) {
        unreadOssieText(doc, metricLabel(mt, doc), t, mt);
        continue;
      }
      if (text !== t.text) {
        t.set(text);
        doc.modified = true;
      }
    }
  }
}

/**
 * The name of a field import adds to `ds` for column `column`: the column's
 * name with each character a name cannot hold written as `_`, or that after
 * `source_`, and so on, when a field of `ds` or one of `metrics` has it (see
 * freeName). A field is never named `source`, since a metric would then read
 * `source.<column>` as that field.
 */
function addedFieldName(
    column: string, ds: Record<string, any>,
    metrics: Array<Record<string, any>>): string {
  const base = column.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[0-9]/, '_');
  return freeName(
      base, `source_${base}`, namesInUse(ds, metrics).add('source'));
}

/**
 * Settles each field that rewriteMetricNames added, once the repair step has
 * removed the metrics it removes. A field only removed metrics read is
 * removed, since no metric import writes needs it. Any other takes its name,
 * by the letter case of the column, and its entries from the texts of the
 * metrics import keeps, so nothing of a removed metric stays in it. A vendor
 * label names its dialect by the dataset's table, which `load` reads. A new
 * name is written in each text that names the field. When it cannot be
 * written in one, the field keeps its name, and import reports it.
 */
function settleAddedFields(doc: ImportDocument, load: DialectLoad): void {
  for (const {ds, field, readers} of doc.rootModel!.added) {
    const kept = readers.filter(r => doc.metrics.includes(r.metric));
    if (!kept.length) {
      const fields = asRecords(ds.fields).filter(f => f !== field);
      ds.fields = fields.length ? fields : undefined;
      continue;
    }
    // Each text's entry, once for each dialect it names on the table.
    const tables = [tableDialect(ds, load)];
    const named = (label: string) =>
        vendorDialect(label, tables) ?? kcmdDialect(label);
    const dialects: Array<{dialect: string; expression: string}> = [];
    for (const {entry} of kept) {
      if (!dialects.some(d => named(d.dialect) === named(entry.dialect))) {
        dialects.push({...entry});
      }
    }
    field.expression.dialects = dialects;
    const others = {fields: asRecords(ds.fields).filter(f => f !== field)};
    const before = field.name;
    const name = addedFieldName(kept[0].column.name, others, doc.metrics);
    const stuck =
        name === before ? [] : renameAddedField(doc, load, ds, field, kept, name);
    for (const mt of stuck) {
      report(doc, () =>
        `dataset '${ds.name}': kept the name '${before}' for the field ` +
        `import added, since it could not rewrite ${metricLabel(mt, doc)}, ` +
        `which reads it.`);
    }
    relabelVendorDialects(field, `field '${ds.name}.${field.name}'`, doc, tables);
  }
}

/**
 * Renames `field`, a field that rewriteMetricNames added to `ds`, to `name`,
 * and writes the new name in each text of the metrics that read it, `kept`,
 * when it can write it at each place import wrote the field's name. Returns
 * the metrics it cannot write the name in. A text kcmd cannot parse leaves
 * the field and every text as they are.
 */
function renameAddedField(
    doc: ImportDocument, load: DialectLoad, ds: Record<string, any>,
    field: Record<string, any>,
    kept: ReadonlyArray<{metric: Record<string, any>}>,
    name: string): Array<Record<string, any>> {
  const before = field.name;
  const names = new Set([String(ds.name).toLowerCase(), before.toLowerCase()]);
  const edits: Array<() => void> = [];
  const stuck: Array<Record<string, any>> = [];
  for (const mt of new Set(kept.map(r => r.metric))) {
    let written = 0;
    for (const t of expressionTexts(mt)) {
      const text = columnsRewritten(t.text, t.dialect, names, c => {
        if (c.qualifier?.name !== ds.name || c.name.name !== before) {
          return undefined;
        }
        written++;
        return qualifiedName(
            c.qualifier!, bareName(name), t.dialect,
            tableDialect(ds, load) ?? undefined);
      });
      edits.push(() => t.set(text));
    }
    if (written < kept.filter(r => r.metric === mt).length) stuck.push(mt);
  }
  if (stuck.length) return stuck;
  field.name = name;
  for (const edit of edits) edit();
  return [];
}

/**
 * Anchors each metric that a dataset of a model read from the document root
 * declared on that dataset, in a GOOGLE block, which the Google flavor writes
 * as `entity`.
 */
function anchorDatasetMetrics(doc: ImportDocument): void {
  for (const {metric, dataset} of doc.rootModel!.datasetMetrics) {
    putGoogleBlock(metric, {entity: dataset});
    doc.modified = true;
  }
}

/**
 * Rewrites each key and join column of a model read from the document root
 * that names a field of its dataset to the column the field reads (see
 * fieldColumn), since Apache Ossie names fields there and kcmd names columns.
 * A field of `takenOff`, which import has taken off, counts too. A field text
 * `asWritten` gives for its entry is read in its place, and an ANSI_SQL text
 * is compared on its table, whose dialect `load` gives. A name that matches
 * no field, in any letter case, stays as written, and so does one that names
 * a field of `refused`, whose expression import already stops on. Reports the
 * rewrites in one warning. kcmd cannot express a key or a join on a field
 * that is not a single column, so a primary or unique key with an entry on
 * such a field is removed whole, and so is a relationship with such a join
 * column, or whose `to_columns` then cover no key of its target, as push
 * requires. Reports each removal.
 */
function rewriteKeyColumns(
    doc: ImportDocument, refused: ReadonlySet<object>,
    asWritten: ReadonlyMap<object, string>, load: DialectLoad,
    takenOff: ReadonlyMap<string, ReadonlyArray<Record<string, any>>>): void {
  const ossie = ossieModel(doc, removedNames(takenOff));
  // Each entry of `list`, a key or join column list of `ds`, with the field
  // it names and the column that field reads as a key writes it, undefined
  // when the field is not a single column. A column whose name holds a
  // backtick has no form in a key.
  const entries = (list: unknown, ds: Record<string, any>|undefined) => {
    if (!Array.isArray(list) || !ds) return [];
    const fields =
        [...asRecords(ds.fields), ...takenOff.get(String(ds.name)) ?? []];
    return list.flatMap((name, i) => {
      if (typeof name !== 'string') return [];
      const f = fields.find(x => x.name === name) ??
          fields.find(
              x => typeof x.name === 'string' &&
                  x.name.toLowerCase() === name.toLowerCase());
      if (!f || refused.has(f)) return [];
      // A key names the column as the field's OSSIE_SQL_2026 text names it,
      // when it has one, and otherwise as its first text does.
      const columns = fieldColumn(
          f, ds, ossie, tableDialect(ds, load) ?? undefined, asWritten);
      const column =
          (columns?.find(c => c.dialect === OSSIE_SQL) ?? columns?.[0])?.name;
      const written = !column || column.includes('`') ? undefined :
          isColumnName(column)                        ? column :
                                                        `\`${column}\``;
      return [{i, name, f, written, read: columns !== undefined}];
    });
  };
  // Why the entries of `list` that name a field of `ds` cannot be written,
  // or undefined when they can.
  const problem = (list: unknown, ds: Record<string, any>|undefined) => {
    const e = entries(list, ds).find(e => e.written === undefined);
    if (!e) return undefined;
    const all = expressionTexts(e.f);
    const texts = [...new Set(all.map(t => `'${t.text}'`))];
    const listed = `${texts.slice(0, -1).join(', ')} and ${texts.at(-1)}`;
    // Texts that each name one column, but not the same one.
    const alone = (t: {dialect: string; text: string; entry: object}) =>
        fieldSoleColumn(
            [{
              dialect: t.dialect,
              expression: asWritten.get(t.entry) ?? t.text,
            }],
            String(ds!.name), ossie, tableDialect(ds!, load) ?? undefined);
    const differ = !e.read && all.length > 1 && all.every(alone);
    const expression = !texts.length ?
        'which has no expression in a dialect kcmd runs' :
        texts.length === 1 && differ ?
        `whose expression ${texts[0]} names different columns in ${
            all.map(t => t.label).join(' and ')}` :
        texts.length === 1 ?
        `whose expression ${texts[0]} is not a single column` :
        differ ? `whose expressions ${listed} name different columns` :
                 `whose expressions ${listed} are not a single column`;
    return `entry '${e.name}' names field '${ds!.name}.${e.f.name}', ` +
        `${expression}; kcmd keys and join columns name columns.`;
  };
  // Rewrites each entry of `list` that names a field of `ds`, which `where`
  // names, to the column it reads. The edit is of `about`, when it is of a
  // relationship.
  const rewrite = (
      list: unknown, ds: Record<string, any>|undefined, where: string,
      about?: object) => {
    for (const {i, name, written} of entries(list, ds)) {
      if (written === name) continue;
      report(
          doc,
          `Rewrote each key and join column that names a field to the ` +
              `column the field reads`,
          `${where} '${name}' to '${written}'`, about);
      (list as unknown[])[i] = written;
      doc.modified = true;
    }
  };
  const removed = (what: string) => {
    report(doc, what);
    doc.modified = true;
  };
  // The datasets that lose a key.
  const lost = new Set<object>();
  for (const ds of doc.datasets) {
    const pk = problem(ds.primary_key, ds);
    if (pk) {
      removed(`dataset '${ds.name}': removed primary_key, since its ${pk}`);
      delete ds.primary_key;
      lost.add(ds);
    } else {
      rewrite(ds.primary_key, ds, `dataset '${ds.name}': primary_key`);
    }
    if (!Array.isArray(ds.unique_keys)) continue;
    const kept = ds.unique_keys.filter((key: unknown, j: number) => {
      const uk = problem(key, ds);
      if (uk) {
        removed(
            `dataset '${ds.name}': removed unique_keys[${j}], since its ${uk}`);
        lost.add(ds);
      } else {
        rewrite(key, ds, `dataset '${ds.name}': unique_keys[${j}]`);
      }
      return !uk;
    });
    if (kept.length === ds.unique_keys.length) continue;
    if (kept.length) ds.unique_keys = kept;
    else delete ds.unique_keys;
  }
  const dataset = (name: unknown) => doc.datasets.find(ds => ds.name === name);
  const columnList = (v: unknown) =>
      Array.isArray(v) && v.every(isColumnName) ? v as string[] : undefined;
  const relationships = doc.relationships.filter(r => {
    const where = `relationship '${r.name}'`;
    const from = problem(r.from_columns, dataset(r.from));
    const to = problem(r.to_columns, dataset(r.to));
    const why = from ? `its from_columns ${from}` : to && `its to_columns ${to}`;
    if (why) {
      removed(`${where}: removed, since ${why}`);
      return false;
    }
    // The to_columns as written, which a removal names.
    const written = JSON.stringify(r.to_columns);
    rewrite(r.from_columns, dataset(r.from), `${where}: from_columns`, r);
    rewrite(r.to_columns, dataset(r.to), `${where}: to_columns`, r);
    // Push refuses a join whose columns cover no key of its target, and
    // skips the check when a list holds an entry that is not a column.
    const target = dataset(r.to);
    const toColumns = columnList(r.to_columns);
    const pk = columnList(target?.primary_key ?? []);
    const uks = (Array.isArray(target?.unique_keys) ? target!.unique_keys : [])
                    .map(columnList);
    if (!target || !lost.has(target) || !toColumns?.length || !pk ||
        uks.some((k: unknown) => !k) ||
        coversKey(toColumns, pk, uks as string[][])) {
      return true;
    }
    removed(
        `${where}: removed, since its to_columns ${
            written} cover no primary or unique key of ` +
        `dataset '${target.name}' once import removed a key of that ` +
        `dataset; push refuses such a relationship.`);
    return false;
  });
  if (relationships.length < doc.relationships.length) {
    doc.relationships = relationships;
    doc.model.relationships = relationships.length ? relationships : undefined;
  }
}

/**
 * Phase 1c (Root model): Converts the constructs of a model read from the
 * document root that kcmd writes another way, except the names its texts
 * and keys read, which repairDocument converts once it knows the dialect of
 * each table (see convertRootNames).
 */
function convertRootModel(doc: ImportDocument): void {
  convertExtensionBlocks(doc);
  convertSqlExpressions(doc);
  anchorDatasetMetrics(doc);
  doc.rootModel!.at = doc.warnings.length;
}

/**
 * Converts the names the texts and the keys of a model read from the
 * document root read, with the dialect `load` gives each table. The fields
 * of `removed`, which import has taken off, still count as fields the
 * metrics and keys may name. Returns false when the names cannot convert.
 */
function convertRootNames(
    doc: ImportDocument, load: DialectLoad,
    removed: ReadonlyMap<string, ReadonlyArray<Record<string, any>>>): boolean {
  const errors = doc.errors.length;
  // The keys read the fields before a metric adds one, and each
  // OSSIE_SQL_2026 field text as written.
  const {refused, asWritten} = rewriteFieldExpressions(doc, load);
  rewriteKeyColumns(doc, refused, asWritten, load, removed);
  rewriteMetricNames(doc, load, removedNames(removed));
  return doc.errors.length === errors;
}

/** The names of the fields of each dataset in `removed`. */
function removedNames(
    removed: ReadonlyMap<string, ReadonlyArray<Record<string, any>>>):
    Map<string, string[]> {
  return new Map([...removed].map(([ds, fields]) => [ds, namesOf([...fields])]));
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
 * Phase 1 (Parse): Parses raw YAML, wraps a third-party model written at the
 * document root in `semantic_model`, verifies the top-level document envelope,
 * validates `opts.sourcePrefix` when present, refuses a document with a
 * `GOOGLE` block or a Google-flavor model to convert to vanilla unless
 * `strict` is set, and constructs the mutable `ImportDocument` (or returns the
 * fatal errors).
 */
function parseImportDocument(
    rawYaml: string, opts: ImportSemanticModelOptions): ImportDocument|string|
    string[] {
  // 1. Parse raw YAML with strict YAML 1.2 options (`YAML_OPTIONS`) so syntax
  // errors and duplicate keys are caught immediately.
  let {document, text} = parseForUpdate(rawYaml);
  // A model file is YAML, so a JSON file is written as YAML.
  const fromJson = text !== rawYaml;
  let parsedDoc: unknown;
  try {
    if (document.errors.length > 0) throw document.errors[0];
    parsedDoc = document.toJS();
  } catch (err: any) {
    return `Semantic model load error: could not parse input: ${
        yamlErrorMessage(err, text)}`;
  }

  // 1b. A third-party Ossie file may hold its model at the document root. In
  // the default mode, the model is wrapped in `semantic_model` by a text
  // edit, so every comment stays, and read as a '0.2.0.dev0' model.
  const rootVersion = rootModelVersion(parsedDoc);
  const parsedRoot = parsedDoc;
  let aliases: AliasSite[] = [];
  let sqlPaths: Array<Array<string|number>> = [];
  if (isRecord(parsedDoc) && parsedDoc.version === OSSIE_ROOT_VERSION &&
      'semantic_model' in parsedDoc) {
    return `Document is a '${OSSIE_ROOT_VERSION}' file with a ` +
        `'semantic_model' list, which Apache Ossie's schema refuses: in ` +
        `'${OSSIE_ROOT_VERSION}' the model sits at the document root. Move ` +
        `the model's keys to the root in place of 'semantic_model'.`;
  }
  if (rootVersion !== undefined) {
    if (opts.strict) {
      return `Document is a third-party Ossie file: its '${rootVersion}' ` +
          `model sits at the document root, which kcmd never writes. ` +
          `Import it in the default '--input third-party' mode.`;
    }
    const refusals =
        rootModelRefusals(parsedDoc as Record<string, any>, rootVersion);
    if (refusals.length) return refusals;
    ({text, document, aliases, sqlPaths} = rootModelText(text, document));
    parsedDoc = document.toJS();
  }

  // 2. Verify the top-level document envelope (`version` is a recognized format
  // version and `semantic_model[0]` is a model object). If malformed, delegate
  // to `loadModels` so the caller receives the loader's canonical schema error.
  // A model wrapped in step 1b passes.
  if (rootVersion === undefined &&
      (!isRecord(parsedDoc) || typeof parsedDoc.version !== 'string' ||
       !isFormatVersion(parsedDoc.version) ||
       !Array.isArray(parsedDoc.semantic_model) ||
       !isRecord(parsedDoc.semantic_model[0]))) {
    try {
      loadModels(rawYaml, {bindingOptional: true, warnUnacceptedSource: true});
    } catch (err: any) {
      return err?.message ?? String(err);
    }
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
  // A model at the root is read as a '0.2.0.dev0' model.
  if (rootVersion !== undefined) root.version = OSSIE_VERSION;
  const inputVersion = root.version as FormatVersion;
  const targetVersion: FormatVersion = opts.flavor ?
      (opts.flavor === 'google' ? GOOGLE_VERSION : OSSIE_VERSION) :
      inputVersion;
  const fileName = opts.fileName ?? `${model.name}.yaml`;
  const warnings = fromJson ? [`Converted '${fileName}' to YAML.`] : [];
  const errors: string[] = [];
  const doc: ImportDocument = {
    text,
    authored: rawYaml,
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
    rootModel: rootVersion === undefined ?
        undefined :
        {
          version: rootVersion,
          datasetMetrics: [],
          sqlMoved: sqlPaths.map(p => p.reduce((v: any, k) => v[k], root)),
          reports: [],
          added: [],
          at: 0,
        },
    strict,
    modified: rootVersion !== undefined && rootVersion !== OSSIE_VERSION,
    warnings,
    errors,
    warnOrError: (msg: string) => (strict ? errors : warnings).push(msg),
    repair: (done: string, needed: string) =>
        strict ? errors.push(needed) : warnings.push(done),
  };
  if (doc.rootModel) {
    // A '0.2.0.dev0' file takes the output's version through the flavor
    // conversion the author asked for, which import does not report.
    report(
        doc,
        `Moved the model from the document root into 'semantic_model', ` +
            `where kcmd reads it` +
            (rootVersion === OSSIE_VERSION ?
                 '.' :
                 `, and wrote version '${rootVersion}' as '${
                     targetVersion}'.`));
    // An anchor is reported while an object that holds one of its aliases
    // so written stays.
    for (const anchor of new Set(aliases.map(a => a.anchor))) {
      report(
          doc,
          `Wrote the value of these anchors in place of each alias the ` +
              `conversion would put before its anchor, since YAML reads an ` +
              `alias only after its anchor`,
          `'${anchor}'`,
          aliases.filter(a => a.anchor === anchor)
              .map(a => holderAt(model, a.path)));
    }
    const input = parsedRoot as Record<string, any>;
    const {datasetMetrics} = doc.rootModel;
    datasetMetrics.push(...movedDatasetMetrics(doc, input));
    for (const ds of asRecords(input.datasets)) {
      if (!('metrics' in ds)) continue;
      const list: unknown[]|undefined =
          ds.metrics === null ? [] :
          Array.isArray(ds.metrics) ? ds.metrics : undefined;
      // The entries of the list that are not metrics, counted from 1.
      const others = (list ?? []).flatMap((m, i) => isRecord(m) ? [] : [i + 1]);
      if (list?.length === 0) {
        report(
            doc,
            `Removed the empty 'metrics' list of these datasets, since kcmd ` +
                `lists metrics only on the model`,
            `dataset '${ds.name}'`);
      } else if (!list || others.length === list.length) {
        report(
            doc,
            `dataset '${ds.name}': removed its 'metrics', since ${
                list ? 'no entry of it is a metric' :
                       'it is not a list of metrics'}.`);
      } else if (others.length) {
        const one = others.length === 1;
        report(
            doc,
            `dataset '${ds.name}': removed ${one ? 'entry' : 'entries'} ${
                listed(others.map(String))} of its 'metrics', since ${
                one ? 'it is not a metric' : 'they are not metrics'}.`);
      }
      if (!asRecords(list).length) continue;
      // The metrics of `ds` that import keeps.
      const item = () => {
        const names =
            namesOf(asRecords(ds.metrics))
                .filter(
                    name => datasetMetrics.some(
                        m => m.dataset === String(ds.name) &&
                            m.name === name && doc.metrics.includes(m.metric)))
                .map(n => `'${n}'`);
        return names.length ? `dataset '${ds.name}' (${names.join(', ')})` :
                              undefined;
      };
      report(
          doc,
          `Moved the metrics of these datasets to the model's 'metrics', ` +
              `each anchored on its dataset`,
          item);
    }
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
 * When the output's flavor rejects `obj.datatype`, writes it in its canonical
 * casing, such as `Integer` for `integer`, or deletes an `Opaque` in another
 * casing. The change goes through `doc.repair` when the input's flavor
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
    if (res.type === undefined) {
      doc.repair(
          `${label}: removed datatype '${obj.datatype}'.`,
          `${label}: remove datatype '${obj.datatype}'.`);
    } else {
      doc.repair(
          `${label}: rewrote datatype '${obj.datatype}' to '${res.type}'.`,
          `${label}: write datatype '${obj.datatype}' as '${res.type}'.`);
    }
  }
  if (res.type === undefined) {
    delete obj.datatype;
  } else {
    obj.datatype = res.type;
  }
  doc.modified = true;
}

/**
 * The kcmd dialect a dialect name of an imported file names, in any letter
 * case, or undefined for a dialect kcmd does not run. A vendor label names
 * its SQL language's dialect, the first DIALECT_ALIASES gives it.
 */
function kcmdDialect(name: string): SqlDialect|undefined {
  const upper = name.trim().toUpperCase();
  return DIALECT_ALIASES[upper]?.[0] ??
      (ALLOWED_DIALECT_SET.has(upper) ? (upper as SqlDialect) : undefined);
}

/**
 * Maps each dialect onto the allowed SQL dialects and drops unsupported
 * non-SQL dialects on a field or metric. Returns the dialects of the dropped
 * entries, as written, when every entry was dropped, and `undefined`
 * otherwise. A vendor label stays as written for `relabelVendorDialects`.
 * Each change is reported, except when `removesWhenEmpty` is true and a
 * third-party import drops every entry. The caller then removes the field or
 * metric and names the dropped dialects in its own warning.
 */
function normalizeExpressionDialects(
    obj: Record<string, any>, label: string, doc: ImportDocument,
    removesWhenEmpty = false): string[]|undefined {
  if (!isRecord(obj.expression) || !Array.isArray(obj.expression.dialects) ||
      obj.expression.dialects.length === 0) {
    return undefined;
  }
  const quiet = removesWhenEmpty && !doc.strict &&
      obj.expression.dialects.every(
          (e: unknown) => isRecord(e) && typeof e.dialect === 'string' &&
              kcmdDialect(e.dialect) === undefined);
  const kept: unknown[] = [];
  const dropped: string[] = [];
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
      if (!quiet) {
        doc.repair(
            `${label}: dropped unsupported dialect '${entry.dialect}'.`,
            `${label}: remove the entry for unsupported dialect '${
                entry.dialect}'.`);
      }
      dropped.push(entry.dialect);
      doc.modified = true;
    }
  }
  obj.expression.dialects = kept;
  return kept.length ? undefined : dropped;
}

/** `dialects`, each once, in quotes, after "dialect" or "dialects". */
function dialectsNamed(dialects: string[]): string {
  const names = [...new Set(dialects)];
  return `${names.length === 1 ? 'dialect' : 'dialects'} ${
      names.map(d => `'${d}'`).join(', ')}`;
}

/**
 * The dialect vendor label `label` names on `tables`, as relabelVendorDialects
 * reads it, or undefined when `label` is no vendor label.
 */
function vendorDialect(
    label: unknown, tables: ReadonlyArray<string|null|undefined>):
    SqlDialect|undefined {
  const alias = typeof label === 'string' ?
      DIALECT_ALIASES[label.trim().toUpperCase()] :
      undefined;
  if (!alias) return undefined;
  const [usual, own] = alias;
  return own && tables.length && tables.every(t => t === own) ? own : usual;
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
    const name = vendorDialect(entry.dialect, tables);
    if (name === undefined) return;
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
  const anchor = metricAnchor(mt);
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
  const readsNothing =
      parsed.every(c => c !== undefined) && allColumns.length === 0;
  if (readsNothing) return 'reaches no declared entity';
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
 * Normalizes a field's datatype and SQL dialect list. When no supported SQL
 * dialect remains, the Google version removes `f.expression`, and the vanilla
 * version, which requires an expression on every field, removes the field.
 * Each removal is a warning, or an error in strict mode. Returns `false` when
 * the caller removes the field. `abstract` is true for a field of an abstract
 * entity, which takes no expression.
 */
function repairField(
    f: Record<string, any>, dsName: string, doc: ImportDocument,
    abstract = false): boolean {
  const fLabel = `field '${dsName}.${f.name}'`;
  normalizeDatatype(f, fLabel, doc);
  const vanilla = doc.targetVersion === OSSIE_VERSION;
  const dropped = normalizeExpressionDialects(f, fLabel, doc, vanilla);
  if (dropped) {
    if (vanilla) {
      doc.repair(
          `${fLabel}: removed field whose expression is written only in ` +
              `unsupported ${dialectsNamed(dropped)}, since version '${
                  OSSIE_VERSION}' requires an 'expression' on every field; ` +
              `add the field back with an entry in a supported SQL dialect.`,
          `${fLabel}: 'expression' has no entry in a supported SQL dialect, ` +
              `and version '${OSSIE_VERSION}' requires an 'expression' on ` +
              `every field; add one.`);
      return doc.strict;
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
  return true;
}

/**
 * Repairs a dataset's `source` (removing whitespace around it, removing
 * query-valued sources, qualifying bare table names against
 * `doc.sourcePrefix` or completing them from `doc.entryTables`, and warning on
 * unaccepted sources), truncates its `description`, and repairs each of its
 * `fields`. Returns the fields it removes.
 */
function repairDataset(
    ds: Record<string, any>, doc: ImportDocument): Array<Record<string, any>> {
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
  const removed = asRecords(ds.fields).filter(
      f => !repairField(f, String(ds.name ?? ''), doc, abstract));
  if (removed.length) {
    const kept =
        ds.fields.filter((f: Record<string, any>) => !removed.includes(f));
    ds.fields = kept.length ? kept : undefined;
  }
  return removed;
}

/**
 * The removed fields that metric `mt` reads, each written `'dataset.field'`.
 * `removedFields` maps the name of each dataset to the names of the fields
 * import removed from it.
 */
function removedFieldsRead(
    mt: Record<string, any>, doc: ImportDocument, load: DialectLoad,
    removedFields: ReadonlyMap<string, string[]>): string[] {
  if (!removedFields.size) return [];
  // An ANSI_SQL text of tables whose dialect no lookup read is read in each
  // dialect they may have, as push reads it with readWithoutDialect, and
  // reads a field when each of those readings reads it.
  const unread = doc.impliedDialect === null ?
      possibleDialects(doc.datasets.map(ds => lookedUpEntity(ds, load))) :
      [];
  const readings = (t: {text: string; dialect: string}) => {
    if (t.dialect !== 'ANSI_SQL' || doc.impliedDialect !== null) {
      return [columnsForSource(t.text, t.dialect, doc.impliedDialect)];
    }
    if (!unread.length) return [columnsWithoutDialect(t.text, unread)?.columns];
    // T-SQL's parser prints a panic on some texts, such as `IF(...)`.
    return withoutEngineMessages(
        () => unread.map(d => columnsForSource(t.text, d)));
  };
  return [...removedFields].flatMap(([ds, fields]) => {
    const read = expressionTexts(mt).flatMap(t => {
      const [first, ...rest] = readings(t);
      if (!first || rest.some(c => !c)) return [];
      return fieldsReadOn(first, ds)
          .filter(f => rest.every(c => fieldsReadOn(c!, ds).includes(f)));
    });
    return [...new Set(read)].filter(f => fields.includes(f))
        .map(f => `'${ds}.${f}'`);
  });
}

/**
 * Repairs a metric's datatype, SQL dialect list, and description, returning
 * `false` when the caller prunes it from `doc.metrics`: when no entry in a
 * supported SQL dialect remains, when it reads a field of `removedFields`
 * (see removedFieldsRead), or when it is unanchored and reaches 0 or >1
 * entities. In strict mode a metric with no supported SQL dialect is an
 * error. A vendor label names its dialect by the tables that run the metric
 * (see metricEntities), with the dialects `load` gives them.
 * `translatesLater` is as for `unanchoredMetricProblem`.
 */
function repairMetric(
    mt: Record<string, any>, doc: ImportDocument, load: DialectLoad,
    removedFields: ReadonlyMap<string, string[]>,
    translatesLater = false): boolean {
  const mtLabel = metricLabel(mt, doc);
  normalizeDatatype(mt, mtLabel, doc);
  const dropped = normalizeExpressionDialects(mt, mtLabel, doc, true);
  if (dropped) {
    doc.repair(
        `${mtLabel}: removed metric whose expression is written only in ` +
            `unsupported ${dialectsNamed(dropped)}; ${addBack(mt, doc)} ` +
            `with an entry in a supported SQL dialect.`,
        `${mtLabel}: 'expression' has no entry in a supported SQL dialect; ` +
            `add one.`);
    return doc.strict;
  }
  // Strict mode removes no field, so this is always a warning.
  const read = removedFieldsRead(mt, doc, load, removedFields);
  if (read.length) {
    const word = read.length === 1 ? 'field' : 'fields';
    doc.warnings.push(
        `${mtLabel}: removed metric whose expression reads removed ${word} ` +
        `${read.join(', ')}; ${addBack(mt, doc)} with the ${word}.`);
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
  const mtLabel = metricLabel(mt, doc);
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
            `${problem}; ${addBack(mt, doc)} ${how}.`,
        `${mtLabel}: its expression ${problem}; set ${anchor}, or scope ` +
            `its expression to one entity.`);
    doc.modified = true;
    return false;
  }
  return true;
}

// The marks addBack writes, each the index of a metric in `removedMetrics`.
const ADD_BACK_MARK = /\0(\d+)\0/g;

// The metrics whose removal warning holds a mark of addBack, by document.
const removedMetrics = new WeakMap<ImportDocument, Array<Record<string, any>>>();

/**
 * A mark for the words that start the advice to add back metric `mt`, which
 * import removes. addedBack replaces it once the names of the metrics import
 * keeps are final.
 */
function addBack(mt: Record<string, any>, doc: ImportDocument): string {
  const removed = removedMetrics.get(doc) ?? [];
  removedMetrics.set(doc, removed);
  removed.push(mt);
  return `\0${removed.length - 1}\0`;
}

/**
 * Replaces each mark of addBack in `doc.warnings` with the words that start
 * the advice to add back its metric: "add the metric back", and "under a name
 * no other metric or field of its entity has" when another metric, one import
 * keeps or removes, or a field of the dataset the metric is anchored on, of
 * any dataset for an unanchored metric, has its name, as kcmd compares names.
 */
function addedBack(doc: ImportDocument): void {
  const removed = removedMetrics.get(doc) ?? [];
  const words = (mt: Record<string, any>) => {
    const name = String(mt.name).toLowerCase();
    const anchor = metricAnchor(mt);
    const datasets = anchor === undefined ?
        doc.datasets :
        doc.datasets.filter(ds => ds.name === anchor);
    const others = [...doc.metrics, ...removed].filter(m => m !== mt);
    const taken = namesInUse(undefined, others).has(name) ||
        datasets.some(ds => namesInUse(ds, []).has(name));
    return `add the metric back${
        taken ? ' under a name no other metric or field of its entity has,' :
                ''}`;
  };
  doc.warnings.forEach((w, i) => {
    doc.warnings[i] =
        w.replace(ADD_BACK_MARK, (_, k) => words(removed[Number(k)]));
  });
}

/** Keeps the metrics of `doc` for which `keep` returns true. */
function filterMetrics(
    doc: ImportDocument,
    keep: (mt: Record<string, any>, doc: ImportDocument) => boolean): void {
  doc.metrics = doc.metrics.filter(mt => keep(mt, doc));
  if (Array.isArray(doc.model.metrics) && doc.model.metrics.length) {
    doc.model.metrics = doc.metrics.length ? doc.metrics : undefined;
  }
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
  // The repaired sources are in `doc.root`, and JSON is YAML.
  const texts = [
    JSON.stringify(doc.root),
    ...(opts.profileFiles ?? []).map(f => f.content),
  ];
  if (!opts.readDialects || !sourcesToLookUp(texts).length) return {};
  let got: SourceDialects;
  try {
    got = await opts.readDialects(texts);
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
 * datasets and their fields, converting the names a model read from the
 * document root reads (see convertRootNames), removing the fields and
 * metrics left with no supported SQL dialect and the metrics that read those
 * fields, pruning unanchored metrics, and truncating descriptions > 2,000
 * chars). Returns the source dialects it reads after repairing the datasets,
 * or undefined when the names cannot convert.
 */
async function repairDocument(
    doc: ImportDocument,
    opts: ImportSemanticModelOptions): Promise<DialectLoad|undefined> {
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

  // 2. Repair each dataset (its table `source`, `description`, and `fields`),
  // noting the fields each removes.
  const removed = new Map<string, Array<Record<string, any>>>();
  for (const ds of doc.datasets) {
    const fields = repairDataset(ds, doc);
    if (fields.length) removed.set(String(ds.name ?? ''), fields);
  }
  const removedFields = removedNames(removed);

  // 3. Read the source dialects, infer the model's source dialect from its
  // repaired datasets via `sourcesDialect`, and repair or prune each metric
  // (`repairMetric`). An ANSI_SQL text is not read when no lookup gave its
  // tables' dialect, as push's checks read none. Under `--transpile`, the
  // metric check runs again after translation, or push's checks in strict
  // mode.
  const load = await readSourceDialects(doc, opts);
  // A model read from the document root converts the names of its texts and
  // keys, once every source is complete and its dialect read.
  if (doc.rootModel && !convertRootNames(doc, load, removed)) return undefined;
  // A vendor label on a field names its dialect by its entity's own table,
  // once every source is complete and its dialect read. A field import adds
  // takes its entries once the metrics import keeps are known (see
  // settleAddedFields).
  const added = new Set(doc.rootModel?.added.map(a => a.field));
  for (const ds of doc.datasets) {
    for (const f of asRecords(ds.fields)) {
      if (added.has(f)) continue;
      relabelVendorDialects(
          f, `field '${ds.name ?? ''}.${f.name}'`, doc,
          [tableDialect(ds, load)]);
    }
  }
  doc.impliedDialect = modelDialect(doc, load);
  filterMetrics(
      doc,
      (mt, d) => repairMetric(mt, d, load, removedFields, !!opts.transpile));
  // A model read from the document root renames its dataset metrics, and
  // reports its conversion, once the metrics import keeps are known.
  if (doc.rootModel) {
    settleAddedFields(doc, load);
    renameDatasetMetrics(doc);
    reportSplitAliases(doc);
    writeReports(doc);
  }
  addedBack(doc);

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
    preLoaded = fromDocument(doc.root, {
      bindingOptional: true,
      warnUnacceptedSource: true,
      authoredText: doc.authored,
    });
  } catch (err) {
    if (!(err instanceof SemanticModelError)) throw err;
    return profileFiles;
  }
  // Each field and metric, with the words a message names it by and the
  // entries the translation gave it, as JSON.
  const nodes: TranslatedNode[] = [];
  const syncNode =
      (obj: Record<string, any>, label: string,
       irDialects: Parameters<typeof syncDialects>[1]) => {
        const count = typeof obj.expression === 'string' ?
            1 :
            asRecords(obj.expression?.dialects).length;
        const before = JSON.stringify(obj.expression);
        const added = syncDialects(obj, irDialects);
        if (added) doc.modified = true;
        nodes.push({
          obj,
          label,
          added: added ?
              JSON.stringify(asRecords(obj.expression.dialects).slice(count)) :
              '',
          before,
        });
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
        syncNode(
            f, `field '${ds.name}.${f.name}'`,
            irEntity?.fields.find(x => x.name === f.name)?.dialects);
      }
    }
    for (const mt of doc.metrics) {
      syncNode(
          mt, `metric '${mt.name}'`,
          transpiled.model.metrics.find(x => x.name === mt.name)?.dialects);
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
  doc.warnings.push(...splitAliases(doc, nodes));
  return translatedFiles;
}

/**
 * A field or metric that transpileDocument wrote back: the object of
 * `doc.root`, the words a message names it by, and the entries the
 * translation gave it, as JSON, or '' when it gave none.
 */
interface TranslatedNode {
  obj: Record<string, any>;
  label: string;
  added: string;
  // Its expression before the translation, as JSON.
  before: string;
}

/**
 * The YAML nodes of the expression of `obj`, a field or metric of `doc`, and
 * of the expression's `dialects` list, each undefined when there is none.
 */
function expressionNodes(doc: ImportDocument, obj: object): unknown[] {
  const node = doc.links.get(obj);
  const expression =
      yaml.isMap(node) ? node.get('expression', true) : undefined;
  const dialects =
      yaml.isMap(expression) ? expression.get('dialects', true) : undefined;
  return [expression, dialects];
}

/**
 * The alias that the expression of `obj`, or its `dialects` list, is, with
 * the one of `holders` whose expression holds its anchor, and whether the two
 * values differ now, so that the writer writes the alias as `obj`'s own value
 * (see updateText). Undefined when there is no such alias.
 */
function sharedExpression(
    doc: ImportDocument, obj: Record<string, any>,
    holders: ReadonlyArray<Record<string, any>>):
    {alias: yaml.Alias; holder: Record<string, any>; differ: boolean}|
    undefined {
  const [expression, dialects] = expressionNodes(doc, obj);
  const alias = yaml.isAlias(expression) ? expression :
      yaml.isAlias(dialects)             ? dialects :
                                           undefined;
  const anchor = alias?.resolve(doc.document);
  const holder = anchor &&
      holders.find(h => h !== obj && expressionNodes(doc, h).includes(anchor));
  if (!holder) return undefined;
  const value = (o: Record<string, any>) => JSON.stringify(
      alias === expression ? o.expression : o.expression?.dialects);
  return {alias: alias!, holder, differ: value(obj) !== value(holder)};
}

/**
 * Reports each field and metric of a model read from the document root
 * whose expression, or its `dialects` list, is an alias of one that another
 * holds, when import rewrote the names of the two differently, so that the
 * writer writes the alias as its own value.
 */
function reportSplitAliases(doc: ImportDocument): void {
  const labels = new Map<object, () => string>();
  for (const ds of doc.datasets) {
    for (const f of asRecords(ds.fields)) {
      labels.set(f, () => `field '${ds.name}.${f.name}'`);
    }
  }
  for (const mt of doc.metrics) labels.set(mt, () => metricLabel(mt, doc));
  const holders = [...labels.keys()] as Array<Record<string, any>>;
  for (const obj of holders) {
    const shared = sharedExpression(doc, obj, holders);
    if (!shared?.differ) continue;
    report(
        doc,
        () => `${labels.get(obj)!()}: wrote its expression in place of ` +
            `alias '*${shared.alias.source}', which it shares with ${
                labels.get(shared.holder)!()}, since import rewrote the ` +
            `names in it differently for each.`,
        undefined, obj);
  }
}

/**
 * A warning for each of `nodes` whose expression, or its `dialects` list, is
 * an alias of an anchor in the expression of another of `nodes`, when the
 * translation gave the two different entries. One text in two places, such
 * as the OSSIE_SQL_2026 text of two dataset metrics, can need two
 * translations. The writer then writes the alias as its holder's own value,
 * which keeps its own entries (see updateText).
 */
function splitAliases(doc: ImportDocument, nodes: TranslatedNode[]): string[] {
  return nodes.flatMap(({obj, label, added, before}) => {
    const shared = sharedExpression(doc, obj, nodes.map(n => n.obj));
    const holder = shared && nodes.find(n => n.obj === shared.holder);
    // An expression the conversion already wrote out is reported there (see
    // reportSplitAliases).
    if (!holder || holder.added === added || holder.before !== before) {
      return [];
    }
    return [
      `${label}: wrote its expression in place of alias '*${
          shared.alias.source}', which it shares with ${holder.label}, since ` +
      `--transpile translates the expression differently for each.`,
    ];
  });
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
      authoredText: doc.authored,
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
  // Without strict mode, the repair step's metric check then runs on the
  // translated text, which can reach entities the input text did not. In
  // strict mode, push's checks refuse a metric whose translated text reaches
  // no entity or several.
  if (transpile && doc.errors.length === 0) {
    profiles = await transpileDocument(
        doc, profiles,
        doc.inputVersion === doc.targetVersion ? profileFiles : profiles);
    if (!doc.strict) filterMetrics(doc, keepsMetric);
    addedBack(doc);
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
  const document = (input ?? fileName).replace(/\.ya?ml$/, '');
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
    authoredText: doc.authored,
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
  if (typeof doc === 'string' || Array.isArray(doc)) {
    return {ok: false, files: [], warnings: [], errors: [doc].flat()};
  }
  if (doc.rootModel) {
    convertRootModel(doc);
    if (doc.errors.length) {
      return {ok: false, files: [], warnings: doc.warnings, errors: doc.errors};
    }
  }
  validateInputDocument(doc);
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
  const repaired = await repairDocument(doc, opts);
  if (!repaired) {
    return {ok: false, files: [], warnings: doc.warnings, errors: doc.errors};
  }
  const load = {
    ...repaired,
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
  return {
    ok: doc.errors.length === 0,
    files: doc.errors.length === 0 ? files : [],
    warnings: doc.warnings,
    errors: doc.errors,
  };
}
