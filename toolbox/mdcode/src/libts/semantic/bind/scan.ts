// `kcmd bind`, step 0: the catalog scan.
//
// Bind proposes a binding from what the warehouse holds: the base tables of
// the scanned datasets and their columns, read from INFORMATION_SCHEMA in ONE
// query whose single row carries the whole scan as JSON (the BigQuery client
// reads no further result pages, so a multi-row answer would be truncated).
//
// A scan is a pattern `project.dataset_glob` (`kc-demo-349204.ps_*`). The
// glob takes `*` and `?`. Datasets are then dropped by name: the deployment
// target's dataset (kcmd writes its node views and graph there, so its views
// mirror the raw tables and would shadow them), and any `--exclude` glob.
// Views are dropped too unless asked for, since a curated view is a binding
// someone already made, not a source.
//
// Pure: building the SQL and reading its answer. Running it is run.ts's job.

/** One column of a scanned table. */
export interface ScanColumn {
  name: string;
  // The BigQuery data type as INFORMATION_SCHEMA spells it (STRING, INT64,
  // NUMERIC, TIMESTAMP, ARRAY<...>, ...).
  type: string;
  ordinal: number;
}

/** One scanned table (or view). */
export interface ScanTable {
  project: string;
  dataset: string;
  table: string;
  // INFORMATION_SCHEMA.TABLES.table_type: BASE TABLE, VIEW, ...
  kind: string;
  columns: ScanColumn[];
}

export interface CatalogScan {
  tables: ScanTable[];
}

export interface ScanPattern {
  project: string;
  datasetGlob: string;
}

/** `project.dataset_glob` (or `project:dataset_glob`), or why not. */
export function parseScanPattern(raw: string): ScanPattern|{error: string} {
  const s = String(raw ?? '').trim();
  const m = s.match(/^([a-z][a-z0-9.:-]*[a-z0-9])[.:]([A-Za-z0-9_*?]+)$/);
  if (!m) {
    return {
      error: `--scan must be <project>.<dataset glob>, e.g. my-project.ps_*; got '${s}'`,
    };
  }
  return {project: m[1], datasetGlob: m[2]};
}

/** A `*` / `?` glob as an anchored regular expression. */
export function globRegex(glob: string): RegExp {
  const body = glob.split('').map(ch => ch === '*' ? '.*' :
                                      ch === '?' ? '.' :
                                      ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
                   .join('');
  return new RegExp(`^${body}$`);
}

function regionQualifier(location: string): string {
  return `region-${location.toLowerCase()}`;
}

/**
 * The one-row scan query: every table of the matching datasets with its
 * columns in ordinal order, as a JSON array in column `tables`.
 */
export function scanSql(pattern: ScanPattern, location: string): string {
  const is = `\`${pattern.project}\`.\`${regionQualifier(location)}\`.INFORMATION_SCHEMA`;
  const re = globRegex(pattern.datasetGlob).source.replace(/'/g, "\\'");
  return [
    'WITH cols AS (',
    '  SELECT table_schema, table_name,',
    '    ARRAY_AGG(STRUCT(column_name AS n, data_type AS ty, ordinal_position AS o)',
    '      ORDER BY ordinal_position) AS c',
    `  FROM ${is}.COLUMNS`,
    `  WHERE REGEXP_CONTAINS(table_schema, r'${re}')`,
    '  GROUP BY table_schema, table_name)',
    'SELECT TO_JSON_STRING(ARRAY_AGG(STRUCT(t.table_schema AS d, t.table_name AS t,',
    '    t.table_type AS k, cols.c AS c) ORDER BY t.table_schema, t.table_name)) AS tables',
    `FROM ${is}.TABLES AS t`,
    'JOIN cols USING (table_schema, table_name)',
    `WHERE REGEXP_CONTAINS(t.table_schema, r'${re}')`,
  ].join('\n');
}

/** Reads the `tables` cell of the scan query's row. */
export function parseScanResult(project: string, cell: string|null|undefined): CatalogScan {
  if (cell === null || cell === undefined || cell === '') return {tables: []};
  const parsed = JSON.parse(cell);
  if (parsed === null) return {tables: []};
  if (!Array.isArray(parsed)) throw new Error('the scan result is not a JSON array');
  const tables: ScanTable[] = parsed.map((t: any) => ({
    project,
    dataset: String(t.d),
    table: String(t.t),
    kind: String(t.k ?? 'BASE TABLE'),
    columns: (Array.isArray(t.c) ? t.c : []).map((c: any) => ({
      name: String(c.n),
      type: String(c.ty),
      ordinal: Number(c.o),
    })),
  }));
  return {tables: sortScan(tables)};
}

function sortScan(tables: ScanTable[]): ScanTable[] {
  for (const t of tables) t.columns.sort((a, b) => a.ordinal - b.ordinal);
  return tables.sort((a, b) => a.dataset.localeCompare(b.dataset) ||
                         a.table.localeCompare(b.table));
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * A scan from an INFORMATION_SCHEMA.COLUMNS export (CSV with a header naming
 * at least table_schema, table_name, column_name, data_type, and optionally
 * ordinal_position, table_catalog and table_type) -- for an offline rerun.
 */
export function scanFromCsv(text: string, defaultProject: string): CatalogScan {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return {tables: []};
  const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const need = ['table_schema', 'table_name', 'column_name', 'data_type'];
  const missing = need.filter(n => col(n) < 0);
  if (missing.length) throw new Error(`the CSV has no ${missing.join(', ')} column`);
  const byTable = new Map<string, ScanTable>();
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const get = (name: string) => col(name) >= 0 ? (cells[col(name)] ?? '').trim() : '';
    const project = get('table_catalog') || defaultProject;
    const dataset = get('table_schema');
    const table = get('table_name');
    const key = `${project}.${dataset}.${table}`;
    let t = byTable.get(key);
    if (!t) {
      t = {project, dataset, table, kind: get('table_type') || 'BASE TABLE', columns: []};
      byTable.set(key, t);
    }
    t.columns.push({
      name: get('column_name'),
      type: get('data_type'),
      ordinal: Number(get('ordinal_position')) || t.columns.length + 1,
    });
  }
  return {tables: sortScan([...byTable.values()])};
}

/** A scan file: bind's own JSON snapshot, or a COLUMNS CSV export. */
export function readScanFile(text: string, defaultProject: string): CatalogScan {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const doc = JSON.parse(trimmed);
    return {tables: sortScan((doc.tables ?? []) as ScanTable[])};
  }
  return scanFromCsv(text, defaultProject);
}

export interface ScanFilter {
  // Dataset globs to drop.
  exclude?: string[];
  // Keep views (dropped by default).
  includeViews?: boolean;
  // Keep only datasets matching this glob (the --scan pattern).
  datasetGlob?: string;
}

/** The tables bind considers, and what was dropped and why. */
export function filterScan(scan: CatalogScan, filter: ScanFilter):
    {tables: ScanTable[]; dropped: Array<{table: string; reason: string}>} {
  const exclude = (filter.exclude ?? []).map(g => ({g, re: globRegex(g)}));
  const keep = filter.datasetGlob ? globRegex(filter.datasetGlob) : undefined;
  const tables: ScanTable[] = [];
  const dropped: Array<{table: string; reason: string}> = [];
  for (const t of scan.tables) {
    const name = `${t.dataset}.${t.table}`;
    if (keep && !keep.test(t.dataset)) continue;
    const ex = exclude.find(e => e.re.test(t.dataset));
    if (ex) {
      dropped.push({table: name, reason: `dataset excluded (${ex.g})`});
    } else if (!filter.includeViews && t.kind !== 'BASE TABLE') {
      dropped.push({table: name, reason: `${t.kind.toLowerCase()}, not a base table`});
    } else {
      tables.push(t);
    }
  }
  return {tables, dropped};
}

/** `project.dataset.table`. */
export function tableRef(t: Pick<ScanTable, 'project'|'dataset'|'table'>): string {
  return `${t.project}.${t.dataset}.${t.table}`;
}

/** The profile `source` URI of a table. */
export function tableUri(t: Pick<ScanTable, 'project'|'dataset'|'table'>): string {
  return `//bigquery.googleapis.com/projects/${t.project}/datasets/${
      t.dataset}/tables/${t.table}`;
}

/** The dataset of a BigQuery property-graph deployment target URI. */
export function targetDataset(uri: string|undefined): string|undefined {
  const m = String(uri ?? '').match(
      /^\/\/bigquery\.googleapis\.com\/projects\/[^/]+\/datasets\/([^/]+)\//);
  return m ? m[1] : undefined;
}
