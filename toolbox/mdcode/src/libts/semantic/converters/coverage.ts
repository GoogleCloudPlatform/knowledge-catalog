// Import coverage (proposed): what an ontology or shapes import did with each
// construct it read.
//
// An import is lossy by design -- OWL and SHACL say more than a semantic model
// can hold -- and the warnings the importers print explain individual gaps but
// not the overall picture. A coverage report lists EVERY occurrence of every
// construct the importer recognizes, each with one outcome:
//
//   compiled -- it became a native, structural part of the model: an entity, a
//               field, a key, `extends`, a relationship (or its `inverse`), a
//               defined entity's membership predicate, a constraint. Tools act
//               on it (graph deploy, validation, push checks).
//   hinted   -- it survives only as guidance text an agent reads (an
//               ai_context instruction or synonym, a description prefix): the
//               meaning is kept, nothing enforces or lowers it.
//   dropped  -- it is not represented in the model; `reason` says why.
//
// `kcmd owl import` and `kcmd shacl import` print a per-construct summary and
// write the full report to `coverage.json` (see writeCoverageFile). The format
// is a proposal: see docs/semantic-model/fidelity.md.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type CoverageOutcome = 'compiled'|'hinted'|'dropped';

export const COVERAGE_OUTCOMES: readonly CoverageOutcome[] =
    ['compiled', 'hinted', 'dropped'];

/** One occurrence of a construct in the source and what became of it. */
export interface CoverageEntry {
  // The construct, named by its vocabulary term: `rdfs:subClassOf`,
  // `owl:TransitiveProperty`, `sh:minCount`, ...
  construct: string;
  // The occurrence, readable on its own: `Order SubClassOf Document`,
  // `partOf`, `OrderShape / total on Order`.
  subject: string;
  outcome: CoverageOutcome;
  // Where it landed in the model, for compiled / hinted entries:
  // `entity Order extends`, `relationship partOf ai_context.instructions`,
  // `constraint Order_total_required`.
  target?: string;
  // Why it was hinted or dropped (or how it compiled, when that is not
  // obvious from the target).
  reason?: string;
}

/** Outcome counts for one construct. */
export interface CoverageSummaryRow {
  construct: string;
  compiled: number;
  hinted: number;
  dropped: number;
}

/** What `--prune-unbound` removed from the imported model. */
export interface CoveragePruned {
  entities: string[];
  relationships: string[];
  constraints: string[];
}

/** The coverage of one import of one model. */
export interface CoverageReport {
  importer: 'owl'|'shacl';
  model: string;
  // The files read, as given on the command line.
  sources: string[];
  // One row per construct, in the order the importer reports them.
  summary: CoverageSummaryRow[];
  totals: {compiled: number; hinted: number; dropped: number};
  entries: CoverageEntry[];
  // Present when the import pruned the model (`owl import --prune-unbound`).
  pruned?: CoveragePruned;
}

/**
 * Collects coverage entries in the order an importer visits its constructs;
 * that order is the order of the summary rows.
 */
export class CoverageRecorder {
  readonly entries: CoverageEntry[] = [];

  compiled(construct: string, subject: string, target?: string, reason?: string):
      void {
    this.add({construct, subject, outcome: 'compiled', target, reason});
  }

  hinted(construct: string, subject: string, target: string, reason?: string):
      void {
    this.add({construct, subject, outcome: 'hinted', target, reason});
  }

  dropped(construct: string, subject: string, reason: string): void {
    this.add({construct, subject, outcome: 'dropped', reason});
  }

  add(entry: CoverageEntry): void {
    const clean: CoverageEntry = {
      construct: entry.construct,
      subject: entry.subject,
      outcome: entry.outcome,
    };
    if (entry.target) clean.target = entry.target;
    if (entry.reason) clean.reason = entry.reason;
    this.entries.push(clean);
  }
}

/** Outcome counts per construct, constructs in first-seen order. */
export function summarizeCoverage(entries: readonly CoverageEntry[]):
    CoverageSummaryRow[] {
  const rows = new Map<string, CoverageSummaryRow>();
  for (const e of entries) {
    let row = rows.get(e.construct);
    if (!row) {
      row = {construct: e.construct, compiled: 0, hinted: 0, dropped: 0};
      rows.set(e.construct, row);
    }
    row[e.outcome]++;
  }
  return [...rows.values()];
}

/** Assembles a report from recorded entries. */
export function buildCoverageReport(
    importer: CoverageReport['importer'], model: string, sources: string[],
    entries: readonly CoverageEntry[], pruned?: CoveragePruned): CoverageReport {
  const summary = summarizeCoverage(entries);
  const totals = {compiled: 0, hinted: 0, dropped: 0};
  for (const row of summary) {
    for (const o of COVERAGE_OUTCOMES) totals[o] += row[o];
  }
  const report: CoverageReport = {
    importer,
    model,
    sources: [...sources],
    summary,
    totals,
    entries: [...entries],
  };
  if (pruned) report.pruned = pruned;
  return report;
}

/**
 * The summary the CLI prints: one line per construct with its counts, then the
 * totals. Plain text, aligned, no colors (it is also read from CI logs).
 */
export function formatCoverageSummary(report: CoverageReport): string {
  const header = ['construct', ...COVERAGE_OUTCOMES];
  const rows = report.summary.map(
      r => [r.construct, String(r.compiled), String(r.hinted),
            String(r.dropped)]);
  const total = ['total', ...COVERAGE_OUTCOMES.map(o => String(report.totals[o]))];
  const all = [header, ...rows, total];
  const widths = header.map((_, i) => Math.max(...all.map(r => r[i].length)));
  const line = (r: string[]) =>
      r.map((cell, i) => i === 0 ? cell.padEnd(widths[i]) :
                                   cell.padStart(widths[i]))
          .join('  ')
          .trimEnd();
  return [
    `coverage (${report.importer} import of model '${report.model}'):`,
    ...[header, ...rows].map(r => `  ${line(r)}`),
    `  ${line(total)}`,
  ].join('\n');
}

/** The on-disk shape of `coverage.json`: reports keyed by model, then importer. */
export interface CoverageFile {
  coverage_version: 1;
  models: Record<string, {owl?: CoverageReport; shacl?: CoverageReport}>;
}

/**
 * Writes `report` into the coverage file at `file`, keeping what is already
 * there for other models and for the other importer: an OWL import followed by
 * a SHACL import of the same model leaves both reports side by side. An
 * unreadable or foreign file is replaced. Returns the path written.
 */
export function writeCoverageFile(file: string, report: CoverageReport): string {
  let data: CoverageFile = {coverage_version: 1, models: {}};
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.coverage_version === 1 &&
          typeof parsed.models === 'object' && parsed.models !== null) {
        data = parsed as CoverageFile;
      }
    } catch {
      // Not ours (or truncated): start over.
    }
  }
  const forModel = data.models[report.model] ?? {};
  forModel[report.importer] = report;
  data.models[report.model] = forModel;
  fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true});
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}
