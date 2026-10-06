// `kcmd bind`, step 4: the profile document and bind_report.md.
//
// The profile (`<model>.profiles/<name>.yaml`) holds what bind decided: a
// source, field expressions and hydration rules per entity, in the closed
// profile vocabulary (see resolve_profiles.ts). What needs a person stays OUT
// of the active document unless `--accept-review` -- a needs-review entity's
// best candidate and every normalize rule are written as comments, so the
// file always loads, and accepting is uncommenting (or rerunning with the
// flag).
//
// bind_report.md explains every decision: the chosen table with its evidence
// and confidence, the rejected candidates, each field's column and the rule
// that matched it, the hydration proposals with the numbers behind them, and
// each relationship's foreign key and what the profiler found.

import {hydrationToDoc} from '../hydration';
import {EntityHydration, SemanticModel} from '../ir';
import {ProfileFinding, ProfilePlan} from '../profile_bigquery';
import {EntityProposals} from './hydrate';
import {bindSummary, Candidate, EntityBinding} from './score';
import {tableUri} from './scan';

export interface ModelBindResult {
  model: string;
  bindings: EntityBinding[];
  proposals: Map<string, EntityProposals>;
  // The profiler findings bind read (keys, orphans, regime shifts).
  findings: ProfileFinding[];
  plan?: ProfilePlan;
  // Why the data was not profiled, when it was not.
  notProfiled?: string;
  warnings: string[];
}

export interface BindRunMeta {
  profile: string;
  scan: string;
  tablesScanned: number;
  dropped: Array<{table: string; reason: string}>;
  acceptReview: boolean;
  deploymentTarget?: string;
  version?: string;
}

const DEFAULT_VERSION = '0.2.0.dev0/google';

function scalar(v: string|number|boolean): string {
  if (typeof v !== 'string') return String(v);
  return /^[A-Za-z_/][A-Za-z0-9_./-]*$/.test(v) && !/^(true|false|null|yes|no|on|off)$/i.test(v) ?
      v :
      JSON.stringify(v);
}

function sourceOf(c: Candidate): string {
  const [project, dataset, ...rest] = c.table.split('.');
  return tableUri({project, dataset, table: rest.join('.')});
}

/** The hydration an entity gets: accepted rules only, unless acceptReview. */
export function entityHydration(
    b: EntityBinding, p: EntityProposals|undefined, acceptReview: boolean): EntityHydration|undefined {
  const h: EntityHydration = {};
  if (b.status === 'derived' && b.deriveFrom) {
    h.deriveFrom = {relationship: b.deriveFrom.relationship};
    return h;
  }
  if (!p) return undefined;
  if (p.grain) h.grain = p.grain.latestBy ? {latestBy: p.grain.latestBy} : {deterministic: true};
  if (acceptReview && p.normalize.length) {
    h.normalize = p.normalize.map(n => ({
      field: n.field,
      before: n.before,
      ...(n.divideBy !== undefined ? {divideBy: n.divideBy} : {multiplyBy: n.multiplyBy}),
      ...(n.on !== undefined ? {on: n.on} : {}),
    }));
  }
  if (p.resolve.length) h.resolve = p.resolve.map(r => ({field: r.field, match: [...r.match]}));
  return Object.keys(h).length ? h : undefined;
}

function yamlLines(value: unknown, indent: string): string[] {
  if (Array.isArray(value)) {
    if (value.every(v => typeof v !== 'object')) {
      return [`${indent}[${value.map(v => scalar(v as string)).join(', ')}]`];
    }
    return value.flatMap(v => {
      const inner = yamlLines(v, `${indent}  `);
      inner[0] = `${indent}- ${inner[0].slice(indent.length + 2)}`;
      return inner;
    });
  }
  if (value && typeof value === 'object') {
    const out: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (v && typeof v === 'object') {
        if (Array.isArray(v) && v.every(x => typeof x !== 'object')) {
          out.push(`${indent}${k}: [${v.map(x => scalar(x as string)).join(', ')}]`);
        } else {
          out.push(`${indent}${k}:`, ...yamlLines(v, `${indent}  `));
        }
      } else {
        out.push(`${indent}${k}: ${k === 'before' || k === 'after' ? JSON.stringify(v) : scalar(v as string)}`);
      }
    }
    return out;
  }
  return [`${indent}${scalar(value as string)}`];
}

function entityBlock(
    b: EntityBinding, p: EntityProposals|undefined, acceptReview: boolean,
    withSource: boolean): string[] {
  const lines = [`      - name: ${b.entity}`];
  if (withSource && b.chosen) lines.push(`        source: ${sourceOf(b.chosen)}`);
  const h = entityHydration(b, p, acceptReview);
  if (h) lines.push('        hydration:', ...yamlLines(hydrationToDoc(h), '          '));
  const fields = b.status === 'vocabulary' ?
      (b.vocabFields ?? []).map(v => ({field: v.field, column: v.column})) :
      (withSource && b.chosen ? b.chosen.matches : []);
  if (fields.length) {
    lines.push('        fields:');
    for (const m of fields) lines.push(`          - {name: ${m.field}, expression: ${scalar(m.column)}}`);
  }
  return lines;
}

function normalizeComment(p: EntityProposals): string[] {
  if (!p.normalize.length) return [];
  const doc = {
    normalize: p.normalize.map(n => ({
      field: n.field,
      before: n.before,
      ...(n.divideBy !== undefined ? {divide_by: n.divideBy} : {multiply_by: n.multiplyBy}),
      ...(n.on !== undefined ? {on: n.on} : {}),
    })),
  };
  return [
    '        # PROPOSED, OFF until confirmed (kcmd bind --accept-review, or',
    '        # uncomment under hydration):',
    ...yamlLines(doc, '        #   '),
  ];
}

/** The binding profile document for the models bound. */
export function renderProfileYaml(results: ModelBindResult[], meta: BindRunMeta): string {
  const lines: string[] = [
    `# Binding profile '${meta.profile}', proposed by \`kcmd bind\` from a scan of ${meta.scan}.`,
    '# Every decision is explained in bind_report.md. Rerunning bind rewrites',
    '# this file; edit the model, the scan or the review flags instead.',
    '',
    `version: ${JSON.stringify(meta.version ?? DEFAULT_VERSION)}`,
    'semantic_model:',
  ];
  for (const r of results) {
    const s = bindSummary(r.bindings);
    lines.push(`  # ${s.accepted} of ${s.concrete} concrete entities bound or derived; ${
        s.counts.needs_review} need review; ${s.counts.unbound} unbound.`);
    lines.push(`  - name: ${scalar(r.model)}`);
    if (meta.deploymentTarget) lines.push(`    deployment_target: ${scalar(meta.deploymentTarget)}`);
    const body: string[] = [];
    for (const b of r.bindings) {
      const p = r.proposals.get(b.entity);
      if (b.status === 'auto' || b.status === 'derived' ||
          (b.status === 'needs_review' && meta.acceptReview && b.chosen)) {
        const block = entityBlock(b, p, meta.acceptReview, b.status !== 'derived');
        if (b.status === 'needs_review') {
          body.push(`      # Accepted for review: ${b.reasons.join('; ')}`);
        }
        body.push(...block);
        if (!meta.acceptReview && p) body.push(...normalizeComment(p));
      } else if (b.status === 'vocabulary') {
        if (b.vocabFields?.length) body.push(...entityBlock(b, undefined, meta.acceptReview, false));
      } else if (b.status === 'needs_review') {
        body.push(`      # NEEDS REVIEW: ${b.reasons.join('; ')}`);
        if (b.chosen) {
          body.push(...entityBlock(b, p, true, true).map(l => `      # ${l.slice(6)}`));
        }
      }
    }
    if (body.length) {
      lines.push('    entities:', ...body);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// bind_report.md
// ---------------------------------------------------------------------------

function f2(n: number): string {
  return n.toFixed(2);
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function candidateRow(c: Candidate, chosen?: Candidate): string {
  const note = [c === chosen ? 'chosen' : '', c.takenBy ? `bound to ${c.takenBy}` : '',
                c.shadowOf ? `shadow of deprecated ${c.shadowOf}` : '',
                c.keyGuessed ? 'key guessed' : '']
                   .filter(Boolean)
                   .join('; ');
  return `| \`${c.table}\` | ${f2(c.score)} | ${f2(c.nameSim)} | ${
      c.keyPresent ? 'yes' : c.keyGuessed ? 'guessed' : 'no'} | ${f2(c.coverage)} | ${
      c.kcHit ? 'yes' : ''} | ${cell(note)} |`;
}

function hydrationLines(b: EntityBinding, p: EntityProposals|undefined, accept: boolean): string[] {
  const out: string[] = [];
  if (b.deriveFrom) {
    out.push(`- **derive_from** \`${b.deriveFrom.relationship}\` (from ${b.deriveFrom.source}.${
        b.deriveFrom.field})`);
  }
  if (!p) return out;
  if (p.grain) {
    out.push(`- **grain** ${p.grain.latestBy ? `latest_by \`${p.grain.latestBy}\`` : 'deterministic'}: ${
        p.grain.evidence}`);
  }
  for (const n of p.normalize) {
    out.push(`- **normalize** \`${n.field}\` ${n.divideBy !== undefined ? `÷${n.divideBy}` : `×${n.multiplyBy}`} before ${
        n.before}${n.on ? ` by \`${n.on}\`` : ''} -- ${accept ? 'ACCEPTED (--accept-review)' : 'PROPOSED, OFF until confirmed'}: ${n.evidence}`);
  }
  for (const r of p.resolve) {
    out.push(`- **resolve** \`${r.field}\` to ${r.destination} by ${r.match.join(' or ')}: ${r.evidence}`);
  }
  for (const n of p.notes) out.push(`- note: ${n}`);
  return out;
}

function entitySection(b: EntityBinding, p: EntityProposals|undefined, accept: boolean): string[] {
  const conf = b.chosen ? ` (confidence ${f2(b.chosen.score)})` : '';
  const out = [`### ${b.entity} -- ${b.status.replace('_', ' ')}${conf}`, ''];
  if (b.deprecated) {
    out.push(`Deprecated${b.deprecated.use ? `; use ${b.deprecated.use}` : ''}.`, '');
  }
  for (const r of b.reasons) out.push(`- ${r}`);
  if (b.chosen) {
    const c = b.chosen;
    const n = c.matches.length + c.unmatched.length;
    out.push(`- table \`${c.table}\`: name ${f2(c.nameSim)}, key ${
                 c.keyPresent ? 'matched' : c.keyGuessed ? 'guessed' : 'missing'}, coverage ${
                 f2(c.coverage)} (${c.matches.length} of ${n} fields)`,
             '');
    out.push('| field | column | rule | strength |', '|---|---|---|---|');
    for (const m of c.matches) {
      out.push(`| ${m.field} | \`${m.column}\` | ${m.rule}${m.typeOk ? '' : ' (type mismatch)'}${
          m.guessed ? ' (guessed)' : ''} | ${f2(m.strength)} |`);
    }
    if (c.unmatched.length) out.push('', `Unbound fields: ${c.unmatched.join(', ')}.`);
  }
  if (b.vocabFields?.length) {
    out.push('', `View columns: ${b.vocabFields.map(v => `${v.field} -> \`${v.column}\``).join(', ')}.`);
  }
  if (b.vocabUnbound?.length) out.push('', `No view column: ${b.vocabUnbound.join(', ')}.`);
  const h = hydrationLines(b, p, accept);
  if (h.length) out.push('', 'Hydration:', '', ...h);
  const others = b.candidates.filter(c => c !== b.chosen);
  if (others.length || (b.status === 'needs_review' && b.candidates.length)) {
    out.push('', b.status === 'auto' ? 'Rejected candidates:' : 'Candidates:', '',
             '| table | score | name | key | coverage | KC | note |', '|---|---|---|---|---|---|---|',
             ...(b.status === 'auto' ? others : b.candidates).map(c => candidateRow(c, b.chosen)));
  }
  out.push('');
  return out;
}

function relationshipRows(model: SemanticModel, r: ModelBindResult): string[] {
  const byEntity = new Map(r.bindings.map(b => [b.entity, b]));
  const orphans = new Map<string, ProfileFinding>();
  const relOf = new Map((r.plan?.checks ?? []).filter(c => c.kind === 'orphans')
                            .map(c => [c.id, (c as {relationship: string}).relationship]));
  for (const f of r.findings) {
    const rel = relOf.get(f.id);
    if (f.kind === 'orphans' && rel) orphans.set(rel, f);
  }
  const out = ['| relationship | from | to | foreign key | profile | hydration |',
               '|---|---|---|---|---|---|'];
  for (const rel of model.relationships ?? []) {
    if (rel.abstract || !rel.source.columns.length) continue;
    const src = byEntity.get(rel.source.entity);
    const cols = rel.source.columns.map(
        c => src?.chosen?.matches.find(m => m.field === c)?.column ?? `${c} (unbound)`);
    const f = orphans.get(rel.name);
    const resolve = r.proposals.get(rel.source.entity)?.resolve.find(x => x.relationship === rel.name);
    out.push(`| ${rel.name} | ${rel.source.entity} | ${rel.destination.entity} | ${
        cols.map(c => `\`${c}\``).join(', ')} | ${f ? cell(`${f.status}: ${f.summary}`) : ''} | ${
        resolve ? `resolve by ${resolve.match.join(' or ')}` : ''} |`);
  }
  return out;
}

/** bind_report.md for the models bound. */
export function renderBindReport(
    results: ModelBindResult[], models: SemanticModel[], meta: BindRunMeta): string {
  const out: string[] = [];
  for (const r of results) {
    const model = models.find(m => m.name === r.model);
    const s = bindSummary(r.bindings);
    out.push(`# Bind report: ${r.model} (profile ${meta.profile})`, '');
    out.push(`Scanned ${meta.scan}: ${meta.tablesScanned} table(s) considered${
                 meta.dropped.length ? `, ${meta.dropped.length} dropped (listed at the end)` : ''}.${
                 meta.acceptReview ? ' Run with --accept-review: review items are accepted.' : ''}`,
             '');
    out.push('## Summary', '', '| status | entities |', '|---|---|');
    for (const [k, v] of Object.entries(s.counts)) out.push(`| ${k.replace('_', ' ')} | ${v} |`);
    out.push('', `Auto-accepted (bound or derived): ${s.accepted} of ${s.concrete} concrete entities (${
                     Math.round(100 * s.acceptedShare)}%).`,
             '');
    if (r.notProfiled) out.push(`Data not profiled: ${r.notProfiled}.`, '');
    const review = r.bindings.filter(b => b.status === 'needs_review' || b.status === 'unbound');
    const pending = r.bindings.filter(b => r.proposals.get(b.entity)?.normalize.length);
    if (review.length || pending.length) {
      out.push('## Review', '');
      for (const b of review) {
        const top = b.chosen ?? b.candidates[0];
        out.push(`- **${b.entity}** (${b.status.replace('_', ' ')}): ${b.reasons.join('; ')}${
            top ? `. Accepting binds \`${top.table}\`${
                      top.keyGuessed ? ` with key ${top.matches.filter(m => m.guessed).map(m => `\`${m.column}\``).join(', ')}` : ''}.` :
                  '.'}`);
      }
      for (const b of pending) {
        for (const n of r.proposals.get(b.entity)!.normalize) {
          out.push(`- **${b.entity}.${n.field}** normalize ${n.divideBy !== undefined ? `÷${n.divideBy}` : `×${n.multiplyBy}`} before ${
              n.before}${n.on ? ` by \`${n.on}\`` : ''}: ${meta.acceptReview ? 'accepted' : 'proposed, off until confirmed'}.`);
        }
      }
      out.push('');
    }
    out.push('## Entities', '');
    for (const b of r.bindings) {
      if (b.kind !== 'concrete') continue;
      out.push(...entitySection(b, r.proposals.get(b.entity), meta.acceptReview));
    }
    const vocab = r.bindings.filter(b => b.status === 'vocabulary');
    if (vocab.length) {
      out.push('## Vocabularies', '');
      for (const b of vocab) out.push(...entitySection(b, undefined, meta.acceptReview));
    }
    const none = r.bindings.filter(b => b.status === 'no_table');
    if (none.length) {
      out.push('## No table', '', '| entity | kind | why |', '|---|---|---|');
      for (const b of none) out.push(`| ${b.entity} | ${b.kind} | ${cell(b.reasons.join('; '))} |`);
      out.push('');
    }
    if (model) out.push('## Relationships', '', ...relationshipRows(model, r), '');
    if (r.warnings.length) {
      out.push('## Warnings', '', ...r.warnings.map(w => `- ${w}`), '');
    }
  }
  if (meta.dropped.length) {
    out.push('## Dropped tables', '', ...meta.dropped.map(d => `- \`${d.table}\`: ${d.reason}`), '');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
