// How a model's CONSTRAINTS are encoded in Knowledge Catalog.
//
// One entry per constraint, parented to the model anchor, carrying one aspect
// that holds the invariant. An action is published the same way. Dataplex has
// no built-in constraint type, so the entry and aspect types are the custom
// `semantic-constraint` pair, declared in kc_custom_types.ts and created by
// `kcmd init --semantic-model`. That file lists what is custom; this one holds
// the encoding that fills the aspect.
//
// An entry of its own is what makes the invariant governable. A search can list
// every rule a model states, whichever way the rule is settled. Dropping a
// constraint from the model deletes its entry, so the catalog never advertises
// a rule the model stopped requiring.
//
// The six authored fields land in two places. `expression`, `judgment`,
// `on_violation`, `severity` and `ai_context` go on the aspect, the last whole
// -- aiContextField in kc_custom_types.ts says why. `description` goes on the
// entry source, where a pull of an action already reads it, and because a
// violation quotes that sentence back to the caller as the error, which makes
// it the entry's summary.
//
// A constraint states its rule in one of those first two fields and never in
// both: `expression` for a rule a query can compute, `judgment` for one only a
// reader can settle. The aspect adds a seventh field, `evaluation`, which no
// author writes -- it restates which body the constraint used, as the word
// `deterministic` or `judged`, so a consumer picking rules to lower into SQL
// and a consumer picking rules to hand a language-model judge each select on
// one field instead of testing which body is populated. A pull reads the
// bodies and recomputes the word, so the two can never disagree in the IR.
//
// Both routing words are on the aspect because they are machine-readable, and
// they are two fields because they answer different questions: what the engine
// does about a breach, and how grave the breach is. A constraint that states
// neither is published without them and reads back the same way, so a default
// stays the IR's to define and a pull never invents a value the model never
// stated.
//
// Call sites: knowledge_catalog.ts emits the entries, kc_converter.ts reads
// them back, pull_kc.ts hydrates the aspect.
//
// WHEN A BUILT-IN CONSTRAINT TYPE SHIPS, follow the instructions at the top of
// kc_custom_types.ts. Nothing in this file changes, because the readers below
// match a type by its id suffix and ignore the project it lives in.
//
// The helpers at the bottom repeat a few lines from the modules above on
// purpose. This module imports only the IR, the entry shape and the type
// registry, so it can be swapped or deleted as a unit.

import {Entry} from '../gcp/dataplex';

import {Constraint, CONSTRAINT_SEVERITIES, constraintEvaluation, ConstraintSeverity, SemanticModel, VIOLATION_EFFECTS, ViolationEffect} from './ir';
import {aiContextAspectValue, aiContextFromAspect, CONSTRAINT_TYPE_ID, customAspectKey, customAspectTypeName, customEntryTypeName} from './kc_custom_types';

// Full resource name of the constraint entry type for a destination.
export function constraintEntryTypeName(dest: {project: string}): string {
  return customEntryTypeName(CONSTRAINT_TYPE_ID, dest);
}

// Full resource name of the constraint aspect type for a destination.
export function constraintAspectTypeName(dest: {project: string}): string {
  return customAspectTypeName(CONSTRAINT_TYPE_ID, dest);
}

// Aspect-map key: the `project.location.type` reference form the client keys an
// entry's aspects by.
export function constraintAspectKey(dest: {project: string}): string {
  return customAspectKey(CONSTRAINT_TYPE_ID, dest);
}


// ---------------------------------------------------------------------------
// Write side: the IR -> one entry per constraint.
// ---------------------------------------------------------------------------

// What the emitter supplies so this file need not rebuild entry names or repeat
// the id-collision bookkeeping it already does for entities and metrics.
export interface ConstraintEmitContext {
  // The destination project, which is where the custom types live.
  project: string;
  // Full entry resource name for an entry id (Namer.entry).
  entry(entryId: string): string;
  // Full entry resource name of the model anchor, the parent of every
  // constraint.
  anchor: string;
  // Reserves an entry id, returning false when it collides with one already
  // emitted (knowledge_catalog.claim).
  claim(entryId: string, label: string): boolean;
}

// The entry id of one constraint: `<model>.constraints.<name>`, alongside
// `<model>.metrics.<name>` and `<model>.actions.<name>`.
export function constraintEntryId(
    modelId: string, constraintName: string): string {
  return `${modelId}.constraints.${slug(constraintName)}`;
}

// The entry-id prefix a model's constraints occupy, so delete reconciliation
// removes the entry of a constraint dropped from the model.
export function constraintOwnedPrefix(modelId: string): string {
  return `${modelId}.constraints.`;
}

/**
 * One entry per constraint, to append to the model's entries.
 *
 * Empty when the model declares no constraints, so a model without them is
 * unchanged from before constraints existed. Warns once when it is non-empty:
 * constraints reach Knowledge Catalog and nowhere else, which is worth saying
 * out loud on a push that also deploys a graph.
 */
export function constraintEntries(
    model: SemanticModel, modelId: string, ctx: ConstraintEmitContext,
    warnings: string[]): Entry[] {
  const constraints = model.constraints ?? [];
  if (!constraints.length) return [];

  const entries: Entry[] = [];
  for (const constraint of constraints) {
    const id = constraintEntryId(modelId, constraint.name);
    if (!ctx.claim(id, `constraint '${constraint.name}'`)) continue;
    entries.push({
      name: ctx.entry(id),
      entryType: constraintEntryTypeName(ctx),
      parentEntry: ctx.anchor,
      entrySource: compact({
                     displayName: constraint.name,
                     description: constraint.description,
                   }) as Entry['entrySource'],
      aspects: {
        [constraintAspectKey(ctx)]: {
          aspectType: constraintAspectTypeName(ctx),
          data: constraintAspectData(constraint),
        },
      },
    });
  }
  // Counted from what was emitted rather than from the model, so a name
  // collision that skipped a constraint does not inflate the number.
  if (entries.length)
    warnings.push(
        `model '${model.name}': ${entries.length} constraint(s) published as ` +
        `${CONSTRAINT_TYPE_ID} entries (Knowledge Catalog is the only ` +
        `system a constraint reaches).`);
  return entries;
}

// The aspect payload for one constraint: the invariant in whichever body states
// it, the word for which body that was, what a violation of it does, how grave
// it is, and the whole of any `ai_context` declared on it.
//
// `evaluation` is the one field here that is computed rather than read off the
// model. It is safe to compute because it is a restatement: it says nothing the
// two bodies do not already say, and the reader recomputes it instead of
// trusting it.
function constraintAspectData(constraint: Constraint): Record<string, any> {
  return compact({
    expression: constraint.expression,
    judgment: constraint.judgment,
    evaluation: constraintEvaluation(constraint),
    aiContext: aiContextAspectValue(constraint.aiContext),
    onViolation: constraint.onViolation,
    severity: constraint.severity,
  });
}


// ---------------------------------------------------------------------------
// Read side: a constraint entry -> the IR.
// ---------------------------------------------------------------------------

// True when an entry is one of a model's constraints. The match is on the entry
// type's id suffix, so the project the type lives in need not be known. That is
// what lets a pull keep working once the custom type is replaced by a built-in
// one.
export function isConstraintEntry(entry: Entry): boolean {
  return entry.entryType?.endsWith(`/entryTypes/${CONSTRAINT_TYPE_ID}`) ??
      false;
}

// The aspect type resource names to hydrate for a constraint entry. Named
// through the entry type's own project so the pull follows the type wherever it
// lives.
export function constraintAspectTypes(entryTypeBase: string): string[] {
  return [`${entryTypeBase}/aspectTypes/${CONSTRAINT_TYPE_ID}`];
}

/**
 * Recovers one constraint from its entry, the inverse of constraintEntries.
 *
 * Returns undefined, with a warning, for an entry that states neither body, and
 * for one that states both: an invariant that states nothing, or states its
 * rule twice, would be pulled into a model that then fails its own push-side
 * validation, so one bad entry degrades itself rather than the pull.
 *
 * `evaluation` is not read. It is derived on the way out, so recomputing it
 * from the body that came back is the only reading that cannot go stale.
 */
export function readConstraint(entry: Entry, warnings: string[]): Constraint|
    undefined {
  const name = entry.entrySource?.displayName || idOf(entry.name);
  const data = constraintAspectDataOf(entry);
  const expression = aspectText(data.expression);
  const judgment = aspectText(data.judgment);
  if (!expression && !judgment) {
    warnings.push(
        `constraint '${name}': the ${CONSTRAINT_TYPE_ID} aspect has no ` +
        `expression and no judgment; the constraint is skipped, and pushing ` +
        `this model back will delete the entry`);
    return undefined;
  }
  if (expression && judgment) {
    warnings.push(
        `constraint '${name}': the ${CONSTRAINT_TYPE_ID} aspect states both ` +
        `an expression and a judgment, and a constraint states its rule in ` +
        `one or the other; the constraint is skipped, and pushing this model ` +
        `back will delete the entry`);
    return undefined;
  }

  const constraint: Constraint = {name};
  if (expression) constraint.expression = expression;
  if (judgment) constraint.judgment = judgment;
  const description = entry.entrySource?.description;
  if (description !== undefined && description !== '')
    constraint.description = description;
  const onViolation = readEnum(
      name, 'onViolation', data.onViolation, VIOLATION_EFFECTS, warnings);
  if (onViolation) constraint.onViolation = onViolation as ViolationEffect;
  // A judgment must say what a violation does, so a pulled one that states no
  // routing word is a model that will not push. Saying so here names the
  // constraint while the pull is in front of the author; the alternative is a
  // push error about a key they never wrote.
  if (judgment && constraint.onViolation === undefined) {
    warnings.push(
        `constraint '${name}': the ${CONSTRAINT_TYPE_ID} aspect states a ` +
        `judgment but no onViolation, so the pulled constraint will not push ` +
        `until one is added; a judged constraint must say whether a breach ` +
        `rejects, escalates or warns`);
  }
  const severity = readEnum(
      name, 'severity', data.severity, CONSTRAINT_SEVERITIES, warnings);
  if (severity) constraint.severity = severity as ConstraintSeverity;
  const aiContext = aiContextFromAspect(data.aiContext);
  if (aiContext) constraint.aiContext = aiContext;
  return constraint;
}

// The value an aspect field states, or undefined when it states none.
//
// A value outside the ones the IR defines is dropped with a warning rather than
// kept, because an unrecognized word would fail the pulled model's own
// push-side validation. What dropping costs differs by field and both are safe:
// an unreadable `onViolation` falls back to `reject`, which refuses more than
// the catalog asked for and never less, and an unreadable `severity` leaves a
// rule unranked, which nothing reads yet. On a judged constraint the first of
// those is not a fallback but a load error, because a judge may not refuse: the
// pulled model names the constraint and says the routing word is missing, which
// is the outcome to want when the catalog no longer says how a breach routes.
function readEnum(
    name: string, field: string, value: unknown, allowed: readonly string[],
    warnings: string[]): string|undefined {
  if (value === undefined || value === null) return undefined;
  // Only a string can be one of these words, and the check says so rather than
  // coercing: `String(["escalate"])` is `escalate`, so a coercing reader would
  // invent a routing word the catalog never stated. A blank or whitespace-only
  // value is unset rather than wrong, the same reading a blank expression gets.
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return undefined;
    if (allowed.includes(text)) return text;
  }
  warnings.push(
      `constraint '${name}': the ${CONSTRAINT_TYPE_ID} aspect states ` +
      `${field} ${showAspectValue(value)}, which is not one of ${
          allowed.join(', ')}; the constraint reads back without one`);
  return undefined;
}

// How an unusable aspect value is quoted back in a warning: a string in single
// quotes, so the word reads plainly, and anything else as JSON, so the reader
// can see it was never a word at all.
function showAspectValue(value: unknown): string {
  return typeof value === 'string' ? `'${value.trim()}'` : JSON.stringify(value);
}


// ---------------------------------------------------------------------------
// Local helpers (see the file header on why they are not shared).
// ---------------------------------------------------------------------------

// The constraint aspect's `data` from an entry, matched by the aspect key's
// `.semantic-constraint` suffix or the aspectType's
// `/aspectTypes/semantic-constraint` suffix, so it is found whichever project
// the type was provisioned in.
function constraintAspectDataOf(entry: Entry): Record<string, any> {
  for (const [key, aspect] of Object.entries(entry.aspects ?? {})) {
    if (key.endsWith(`.${CONSTRAINT_TYPE_ID}`) ||
        aspect.aspectType?.endsWith(`/aspectTypes/${CONSTRAINT_TYPE_ID}`)) {
      return aspect.data ?? {};
    }
  }
  return {};
}

// The trimmed text an aspect field states, or '' when it states none. A blank
// or whitespace-only value reads as unset, the same reading readEnum gives.
function aspectText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Entry ids allow letters, numbers, underscores, hyphens, and periods.
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// The id segment of a full entry resource name.
function idOf(name: string): string {
  return name.split('/').pop() ?? name;
}

// Drops undefined-valued keys so the emitted aspect (and its golden) only shows
// fields the model actually set.
function compact<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
