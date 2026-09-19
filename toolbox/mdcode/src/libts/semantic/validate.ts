// Push-time validation gate for a semantic model.
//
// Runs once over the shared, already-parsed models (see loadSemanticModels)
// before any destination leg, so a real `kcmd push` AND a `--validate-only` dry
// run enforce the same requirements. Returns one message per violation (an
// empty array means valid); the caller (commands.ts) prints them and aborts the
// push. Kept separate from the loader -- which validates a document against the
// schema -- because these are deployment requirements, not schema rules, and
// they read the GOOGLE deployment-target extension the BigQuery leg owns.

import {BigQueryClient} from '../gcp/bigquery';

import {googleDeploymentTargets} from './deploy_bigquery';
import {Action, ActionParameter, Constraint, Executor, SemanticModel, SQL_EXECUTOR_VERBS} from './ir';
import {LoadedModel} from './loader';
import {bindScalar} from './parameters';
import {resolveInheritance} from './resolve_inheritance';
import {referencedParameters} from './sql_identifiers';

// Checks every model against the push requirements and returns the collected
// error messages (empty when all models pass), each tagged with the model's
// source document so the author can find it.
//
// `targetOptional` permits a model with NO deployment target -- the case for a
// Knowledge-Catalog-only push, which governs the logical model and deploys no
// graph. A graph leg never sets it, so a bq/spanner/all push still requires
// exactly one target. A KC-only push ignores its deployment target entirely --
// it deploys no graph.
//
// `fieldsPruned` says the caller has already dropped every field the selected
// binding profile leaves unbound, so `entity.fields` is a subset of what the
// author declared. Checks that read a field list have to stand down for such a
// model (see validateConstraints).
export function validatePushRequirements(
    models: LoadedModel[],
    opts: {targetOptional?: boolean; fieldsPruned?: boolean} = {}): string[] {
  const errors: string[] = [];
  for (const {document, model} of models) {
    let deployInfo: ReturnType<typeof googleDeploymentTargets>;
    try {
      // One pass over the model's GOOGLE extension(s): both checks below read
      // the same parse rather than re-parsing the JSON per reader.
      deployInfo = googleDeploymentTargets(model);
    } catch (err: any) {
      // Malformed GOOGLE extension JSON: surface it as a validation error here
      // rather than letting it throw out of a later leg as an uncaught stack.
      errors.push(`${err.message || err} (${document})`);
      continue;
    }

    // A graph push must declare exactly one deployment target -- a single
    // BigQuery Graph OR Spanner Graph URI (we do not support zero or several
    // graphs per model). The target's host selects which deploy leg runs.
    //
    // An AlloyDB target parses, and is still not one of those two: it names a
    // database a model RUNS against rather than a graph a push publishes. It
    // gets its own arm below so it is not reported as a typo.
    //
    // A KC-only push (targetOptional) deploys no graph, so its deployment
    // target is irrelevant: skip the check entirely. Such a push may carry no
    // target (a logical model), one, or even both backends (whose KC aspect
    // records both)
    // -- none of that affects the Knowledge Catalog write.
    if (!opts.targetOptional) {
      if (deployInfo.uris.length !== 1) {
        errors.push(
            `model '${model.name}' (${document}) declares ${
                deployInfo.uris
                    .length} deploymentTargets; exactly one BigQuery ` +
            `Graph or Spanner Graph target is required under its GOOGLE ` +
            `custom_extension.`);
      } else if (deployInfo.alloyDb.length) {
        // Parseable, supported, and for the other command. AlloyDB has no
        // property-graph DDL, so there is no graph here for a push to deploy
        // -- which makes this a profile pointed at the wrong verb rather than
        // a URI to correct, and the message says which verb it is for.
        errors.push(
            `model '${model.name}' (${document}) deploymentTarget '${
                deployInfo.alloyDb[0].uri}' is an AlloyDB database, which a ` +
            `model runs against rather than deploys to; AlloyDB has no ` +
            `property graph for a push to publish. Push under a profile ` +
            `whose target is a BigQuery or Spanner Graph, and use this one ` +
            `to run actions against.`);
      } else if (deployInfo.bigQuery.length + deployInfo.spanner.length === 0) {
        // The single target is present but is not a supported graph URI.
        errors.push(
            `model '${model.name}' (${document}) deploymentTarget '${
                deployInfo.malformed[0]}' is not a valid BigQuery Graph or ` +
            `Spanner Graph URI; expected //bigquery.googleapis.com/projects/` +
            `<p>/datasets/<d>/propertyGraphs/<g> or //spanner.googleapis.com/` +
            `projects/<p>/instances/<i>/databases/<db>/propertyGraphs/<g>.`);
      }
    }

    // A model that targets a BigQuery graph must have every metric resolve to a
    // single entity, or the metric cannot lower to a MEASURE and would be
    // silently dropped from the graph. The loader sets metric.entity only when
    // the expression resolves to exactly one entity, so an unset entity is the
    // "references zero or multiple entities" case. Spanner Graph has no
    // MEASURE, so it imposes no such requirement (its metrics are dropped by
    // design).
    if (deployInfo.bigQuery.length > 0) {
      for (const metric of model.metrics ?? []) {
        if (!metric.entity) {
          errors.push(
              `metric '${metric.name}' in model '${model.name}' (${
                  document}) targets a BigQuery graph but does not resolve to a ` +
              `single entity; set its attach entity or scope its expression to ` +
              `one entity.`);
        }
      }
    }

    // A model that targets a graph (BigQuery OR Spanner) must have every
    // relationship's join columns bound. The loader accepts a column-less
    // relationship so a purely logical model (an OWL import) loads and pushes
    // to Knowledge Catalog, but a graph deploy would emit an invalid
    // `DESTINATION KEY () REFERENCES Dest ()` for such an edge -- so reject it
    // here rather than generate broken DDL. A KC-only push declares no graph
    // target (both arrays empty), so this is skipped.
    if (deployInfo.bigQuery.length + deployInfo.spanner.length > 0) {
      for (const rel of model.relationships ?? []) {
        // An M:N edge binds through its junction table (association), so its
        // direct source/destination columns are empty by design -- bigquery.ts
        // renders it from `rel.association`. Only a plain FK edge needs direct
        // join columns.
        if (rel.association) continue;
        if (!rel.source.columns.length || !rel.destination.columns.length) {
          errors.push(
              `relationship '${rel.name}' in model '${model.name}' (${
                  document}) targets a graph but has no join columns; add its ` +
              `from_columns and to_columns to the relationship in the model ` +
              `before a BigQuery or Spanner Graph deploy.`);
        }
      }
    }

    // Resolving inheritance throws on an `extends` naming an entity the model
    // does not declare, and the two checks below stand down rather than
    // stack-trace on one. Standing down has to mean reporting somewhere or it
    // means publishing a broken model in silence: the loader accepts such a
    // model, and a Knowledge-Catalog-only push reaches no graph leg that would
    // resolve inheritance and catch it. So the failure is reported here, once
    // per model, and the checks below stay quiet about it. A profile push that
    // pruned fields is exempt for the same reason those checks are -- pruning
    // can remove a supertype whole, and the dangling `extends` it leaves is the
    // pruner's doing rather than the author's.
    if (!opts.fieldsPruned) {
      const failure = inheritanceFailure(model);
      if (failure) {
        errors.push(
            `model '${model.name}' (${document}): ${failure} Constraint and ` +
            `action checks that need the resolved model are skipped until ` +
            `this is fixed.`);
      }
    }

    // An action reaches Knowledge Catalog only, so its checks are
    // target-independent: each parameter's type must resolve to something in
    // the ontology, the executor must carry the coordinates a runtime needs to
    // dispatch it, and each guard must name a constraint the model declares.
    // (The "exactly one executor kind" rule is already guaranteed by the loader
    // schema, so it cannot reach here.)
    errors.push(...validateActions(model, document, !!opts.fieldsPruned, true));

    // Constraints are logical invariants, target-independent like actions.
    errors.push(
        ...validateConstraints(model, document, !!opts.fieldsPruned));
  }
  return errors;
}

// The subset of the push checks that bear on RUNNING an action rather than on
// deploying a model. `kcmd action run` skips the deployment checks on purpose
// -- it deploys nothing -- but it must not skip these, because the runtime acts
// on exactly what they verify.
//
// The guard check is the one that matters most. An action naming a constraint
// the model does not declare claims to be checked, and running it would be
// running it unchecked. The parameter and executor checks decide what the
// binder can fill and what the plan can call. The `affects` checks change
// nothing about the run, and they are here so that a model failing its own push
// fails the same way when it is run instead, naming the typo rather than
// passing over it. Nothing has pruned fields on this path, so the field checks
// that stand down for a profile push apply in full.
export function validateRunnable(models: LoadedModel[]): string[] {
  const errors: string[] = [];
  for (const {document, model} of models) {
    errors.push(...validateActions(model, document, false, false));
    errors.push(...validateConstraints(model, document, false));
  }
  return errors;
}


// Static, target-independent checks for a model's actions. Returns one message
// per violation. What can be statically wrong once the model has parsed:
//   - a parameter's type resolves to neither a known entity nor a scalar
//     datatype (the loader left isEntityRef unset and only warned) -- an
//     unresolvable type is a malformed action, promoted to a hard error here;
//   - an executor is missing a coordinate a runtime needs to dispatch it (an
//     empty server/tool, endpoint/method, or service/method) -- the schema
//     accepts empty strings, so this is caught here rather than at parse;
//   - a guard names a constraint the model does not declare;
//   - an `affects` entry names a concept the model does not declare, names
//     fields on a 'delete' (which takes the whole instance), or names a field
//     the concept does not have.
//
// Every `affects` check is a hard error for the reason the guard check is: an
// entry that names nothing real leaves a reader believing the blast radius is
// described when it is not, and a consumer routing on it would route on a
// concept that does not exist.
function validateActions(
    model: SemanticModel, document: string, fieldsPruned: boolean,
    checkDescriptions: boolean): string[] {
  const errors: string[] = [];
  const actions = model.actions ?? [];
  if (!actions.length) return errors;
  const constraintNames =
      new Set((model.constraints ?? []).map(c => c.name));
  // Built only when an `affects` entry will actually read it, and through
  // `ifResolvable` because declaredConcepts resolves inheritance.
  const concepts = !fieldsPruned && actions.some(a => a.affects?.length) ?
      ifResolvable(() => declaredConcepts(model)) :
      undefined;
  for (const action of actions) {
    const where =
        `action '${action.name}' in model '${model.name}' (${document})`;
    const byType = new Map<string, ActionParameter[]>();
    for (const param of action.parameters) {
      if (param.isEntityRef === undefined) {
        errors.push(`${where} has parameter '${param.name}' whose type '${
            param.type}' is neither a known entity nor a scalar datatype.`);
      }
      if (param.required === true && param.default !== undefined) {
        errors.push(
            `${where} has parameter '${param.name}' with both ` +
            `'required: true' and a 'default'; a parameter with a default is ` +
            `optional.`);
      }
      if (param.default !== undefined && param.default !== null &&
          param.isEntityRef === false) {
        const bound = bindScalar(param, param.default);
        if ('error' in bound) {
          errors.push(
              `${where} has parameter '${param.name}' whose default '${
                  param.default}' is invalid: ${bound.error}`);
        }
      }
      const list = byType.get(param.type) ?? [];
      list.push(param);
      byType.set(param.type, list);
    }
    if (checkDescriptions) {
      for (const [type, params] of byType) {
        if (params.length <= 1) continue;
        const missing = params.filter(p => !p.description?.trim());
        if (missing.length > 0) {
          const names = missing.map(p => `'${p.name}'`);
          errors.push(
              `${where} has multiple parameters of type '${type}', so ${
                  names.length === 1 ?
                      `parameter ${names[0]}` :
                      `parameters ${names.slice(0, -1).join(', ')} and ${
                          names[names.length - 1]}`} must have a ` +
              `'description' to distinguish ${
                  names.length === 1 ? 'it' : 'them'}.`);
        }
      }
    }
    // No executor is not an error: it is an action no binding performs here,
    // which the availability pass reports rather than the validator.
    const executor = action.executor;
    if (executor !== undefined) {
      for (const missing of missingExecutorFields(executor)) {
        errors.push(`${where} has an ${
            executor.kind} executor whose '${missing}' is missing or blank.`);
      }
    }
    // An unresolved guard leaves the author believing the write is checked when
    // nothing checks it, so it fails the push rather than warning. Constraint
    // names are model-scoped and the loader rejects duplicates, so a name
    // either resolves here or names nothing at all.
    for (const guard of action.guards ?? []) {
      if (!constraintNames.has(guard)) {
        errors.push(`${where} is guarded by '${guard}', but model '${
            model.name}' declares no constraint of that name.`);
      }
    }
    errors.push(...affectedConceptErrors(action, where, concepts));
    errors.push(...sqlExecutorErrors(action, where));
  }
  return errors;
}

// The errors in a SQL executor's statements. Nothing here for the other three
// executor kinds: they name a system that performs the write, so the model has
// no text to check.
//
// A SQL executor contains the write, which is what makes its blast radius
// checkable and its guards enforceable. The same property makes it the one
// executor kind that could smuggle an unreviewed write into a governed model, so
// the shape is pinned rather than trusted:
//
//   - One DML verb per statement. A statement that reads is a query, and a
//     statement that reshapes the schema is not an action.
//   - No statement separator. Each statement is executed on its own, so a
//     semicolon means the author expected a second statement to run and it
//     silently would not.
//   - Every `@parameter` is declared. This is the load-bearing one: it is what
//     lets the runtime BIND every value instead of interpolating it, so no
//     argument can reach the store as SQL.
function sqlExecutorErrors(action: Action, where: string): string[] {
  if (action.executor?.kind !== 'sql') return [];
  const executor = action.executor;
  const errors: string[] = [];
  const bindable = new Set(action.parameters.map(p => p.name));
  executor.sql.statements.forEach((stmt, i) => {
    const at = `${where} has a sql executor whose statement ${i + 1}`;
    const text = stmt.trim();
    if (!text) {
      errors.push(`${at} is blank.`);
      return;
    }
    const verb = text.split(/\s/, 1)[0].toUpperCase();
    if (!(SQL_EXECUTOR_VERBS as readonly string[]).includes(verb)) {
      errors.push(`${at} starts with '${verb}', but a statement must be one of ${
          SQL_EXECUTOR_VERBS.join(', ')}.`);
    }
    if (text.slice(0, -1).includes(';')) {
      errors.push(
          `${at} contains ';'. Each statement runs on its own, so write ` +
          `one statement per list entry.`);
    }
    for (const name of referencedParameters(text)) {
      if (!bindable.has(name)) {
        errors.push(
            `${at} binds '@${name}', but action '${action.name}' ` +
            `declares no parameter of that name.`);
      }
    }
  });
  return errors;
}

// The errors in one action's `affects`. Split out because the checks chain: a
// concept that does not resolve makes every later check about it meaningless,
// so an entry that fails one of those says nothing more. Undeclared fields do
// not chain -- each is an independent fact about a concept that did resolve --
// so an entry reports all of them.
//
// An absent `concepts` says the model reaching this point is a profile's view
// of the author's model, not the author's model. Everything that reads the
// ontology stands down there, because pruneUnavailable drops whole entities
// and whole relationships -- not only unbound fields -- when a profile does
// not bind their keys or join columns. An action survives that pruning
// untouched, so an entry on a dropped concept is the profile's doing rather
// than the author's, and failing the deploy over it would fail it for no
// reason. An action reaches no graph in any case. What is left is the one
// check that reads only the entry itself.
function affectedConceptErrors(
    action: Action, where: string,
    concepts: Map<string, DeclaredConcept>|undefined): string[] {
  const errors: string[] = [];
  for (const affected of action.affects ?? []) {
    // A `delete` takes the whole instance, so naming fields alongside one is
    // self-contradictory whatever the ontology says.
    if (affected.fields?.length && affected.operation === 'delete') {
      errors.push(
          `${where} affects '${affected.concept}' with operation 'delete' ` +
          `and also names fields. A 'delete' takes the whole instance; drop ` +
          `the fields.`);
      continue;
    }
    if (!concepts) continue;

    const concept = concepts.get(affected.concept);
    if (!concept) {
      errors.push(
          `${where} affects '${affected.concept}', which is neither an ` +
          `entity nor a relationship this model declares.`);
      continue;
    }
    for (const field of affected.fields ?? []) {
      if (!concept.fields.has(field)) {
        errors.push(`${where} affects '${affected.concept}.${field}', but ${
            concept.kind} '${affected.concept}' declares no field '${field}'.`);
      }
    }
  }
  return errors;
}

// What an `affects` entry's `concept` may name, and the fields it has.
// Entities are indexed first, so a name that is both resolves to the entity.
// `kind` is local: it never leaves this check, and exists only to say
// `entity 'X'` or `relationship 'X'` in a message and to pick which fields
// count.
//
// Inheritance is resolved through declaredFields for the same reason the
// constraint check does it: a subtype's own `fields` omit what it inherits.
interface DeclaredConcept {
  kind: 'entity'|'relationship';
  fields: Set<string>;
}
function declaredConcepts(model: SemanticModel): Map<string, DeclaredConcept> {
  const concepts = new Map<string, DeclaredConcept>();
  for (const [name, fields] of declaredFields(model)) {
    concepts.set(name, {kind: 'entity', fields});
  }
  for (const r of model.relationships ?? []) {
    if (concepts.has(r.name)) continue;
    // Only a many-to-many edge has fields of its own (they live on the junction
    // table it is backed by), and those are exactly what a `modify` on an edge
    // names -- an enrollment's grade. A plain foreign-key edge carries none, so
    // naming fields on one is an error: the properties an author means in that
    // case belong to an endpoint entity.
    concepts.set(r.name, {
      kind: 'relationship',
      fields: new Set((r.association?.fields ?? []).map(f => f.name)),
    });
  }
  return concepts;
}


// Static, target-independent checks for a model's constraints.
//
// A constraint states its rule as a `judgment`, and every constraint must state
// one: a constraint with no body states no rule at all. (A document that states
// the removed `expression` body never gets this far -- rejectExpressionBody in
// loader.ts fails the parse and says where the rule goes instead.)
//
// A judgment gets two checks, in judgedConstraintErrors: it must say what a
// violation does, and every `<Entity>.<field>` token naming a KNOWN entity must
// name a field that entity declares. The second catches a typo that would
// otherwise surface only inside an agent's rejected action -- a rule is as easy
// to misspell in a sentence as anywhere else, and a judge handed `Order.totl`
// is being asked about a column that does not exist.
//
// Everything else is left alone. So a leading qualifier that is not a known
// entity is not guessed at here: a relationship-qualified name like
// `OrderedAs.quantity`, a metric reference, an ordinary English word that
// happens to contain a dot. A valid constraint must never be falsely rejected.
//
// Keeping that promise takes care, because the model reaching this function is
// not the document the author wrote. Its field lists have moved twice:
//   - Inheritance is still AS DECLARED. `extends` is flattened by the graph
//     legs, which run after this gate, so a subtype's `fields` here omit every
//     field it inherits. Looking the field up on the resolved model fixes that.
//   - A profile push has already pruned unbound fields (`fieldsPruned`). The
//     author's field is gone from the model, and resolving does not bring it
//     back, so the field check stands down. A constraint reaches no graph in
//     any case, and failing a push over a field this profile does not bind
//     would refuse a deploy for no reason.
function validateConstraints(
    model: SemanticModel, document: string, fieldsPruned: boolean): string[] {
  const errors: string[] = [];
  const constraints = model.constraints ?? [];
  if (!constraints.length) return errors;
  const fieldsByEntity =
      fieldsPruned ? undefined : ifResolvable(() => declaredFields(model));
  // Names the model declares that are not fields of any one entity, which a
  // token's tail may legitimately carry. See unknownFieldRefs.
  const nonFieldNames = new Set([
    ...(model.relationships ?? []).map(r => r.name),
    ...(model.metrics ?? []).map(m => m.name),
  ]);

  for (const c of constraints) {
    const where =
        `constraint '${c.name}' in model '${model.name}' (${document})`;
    if (c.judgment === undefined) {
      errors.push(
          `${where} declares no judgment. A constraint states its rule in ` +
          `words, under 'judgment', and says what a violation does, under ` +
          `'on_violation'.`);
      continue;
    }
      errors.push(
        ...judgedConstraintErrors(c, where, fieldsByEntity, nonFieldNames));
  }
  return errors;
}

// What a constraint must satisfy, beyond stating a body at all.
//
// It must say what a violation does. Any of the three words is allowed,
// `reject` included, but silence is not: an unmarked constraint rejects, and
// inheriting the harshest consequence by omission is the one outcome an author
// is least likely to have meant. Nothing here reads the prose to check the word
// against it -- the prose is prose, and a check that asked a model whether a
// sentence means refusal would be no guardrail at all.
//
// The other check resolves the `Entity.field` tokens the prose mentions, which
// is the whole of the static checking a rule settled by reading can get.
function judgedConstraintErrors(
    c: Constraint, where: string,
    fieldsByEntity: Map<string, Set<string>>|undefined,
    nonFieldNames: Set<string>): string[] {
  const errors: string[] = [];
  // The two checks are independent, so an empty judgment does not skip the
  // routing one. Reporting only the empty body would send the author back for a
  // second failure over a key they were never told about.
  const empty = !c.judgment!.trim();
  if (empty) {
    errors.push(`${where} has an empty judgment.`);
  }
  if (c.onViolation === undefined) {
    errors.push(
        `${where} must state on_violation: 'reject' to ` +
        `refuse the write, 'escalate' to hold it for a person, or 'warn' to ` +
        `let it through and report it. An unmarked constraint rejects, which ` +
        `is too strong a thing to inherit by leaving the key out.`);
  }
  if (!empty) {
    errors.push(...unknownFieldRefs(
        c.judgment!, where, fieldsByEntity, nonFieldNames));
  }
  return errors;
}

// Every `Entity.field` token in a judgment whose entity the model declares and
// whose field it does not.
//
// What makes a token a reference is that the model declares the entity, so no
// spelling heuristic is needed and none is used: entity names here are as often
// lowercase (`customer`, `orders`) as capitalized, and a rule keyed on the
// capital would check some models and quietly skip others. An unrecognized
// entity name is left alone on the principle that keeps this scan
// conservative -- a rule may name a concept from another system, and
// refusing to guess is what stops a valid rule being falsely rejected. A known
// entity with an unknown field is the case where the author plainly meant this
// model and got the name wrong, so that one is an error.

// An entity that declares no fields at all is unknowable in the same way an
// unrecognized name is, so the scan stands down there too. Fields are optional
// on an entity, and a logical model bound to nothing but Knowledge Catalog
// routinely declares none; reading an empty set as "this entity has no such
// field" would refuse every constraint such a model can write.
//
// A tail that names something the model declares is not a misspelled field
// either. Traversal has no syntax in the model today, so a prose token like
// `Customer.Order` or `LineItem.BelongsTo` reads as a field of the head and
// would be rejected for a field the author never claimed existed; the same goes
// for `Order.total_revenue`, where metrics are model-level and the qualifier is
// the entity the metric hangs off. The scan therefore settles only the case it
// can: a tail the model does not declare under any kind is the misspelling.
//
// The two segments must be adjacent to the dot, which is what keeps a sentence
// boundary ("check the memo. Every credit...") out of the scan. A decimal
// number cannot survive either, since no entity is named `30`.
function unknownFieldRefs(
    judgment: string, where: string,
    fieldsByEntity: Map<string, Set<string>>|undefined,
    nonFieldNames: Set<string>): string[] {
  if (!fieldsByEntity) return [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const token = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;
  for (let m = token.exec(judgment); m; m = token.exec(judgment)) {
    const [, entity, field] = m;
    // A token with a third segment (`Order.lineItems.amount`) is a path rather
    // than a field of `Order`, and reading its middle segment as one would
    // reject it for a field the author never claimed existed. Nothing in the
    // model defines path syntax today, so the scan declines to guess in both
    // directions: a token followed by another dotted segment is skipped, and so
    // is one preceded by a dot, which is how the tail of a path presents.
    const after = judgment.slice(m.index + m[0].length);
    if (/^\.\w/.test(after) || (m.index > 0 && judgment[m.index - 1] === '.')) {
      continue;
    }
    const fields = fieldsByEntity.get(entity);
    if (!fields || !fields.size || fields.has(field)) continue;
    // The tail names something the model declares that is not a field of the
    // head: another entity, a relationship, or a metric. `Customer.Order` and
    // `LineItem.BelongsTo` are traversals and `Order.total_revenue` is a metric
    // reference, none of which this scan can settle, and all of which an author
    // writing prose reaches for. Only a tail the model does not declare at all
    // is read as the misspelling this check exists to catch.
    if (fieldsByEntity.has(field) || nonFieldNames.has(field)) continue;
    const ref = `${entity}.${field}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    errors.push(
        `${where} references '${ref}', but entity '${entity}' declares no ` +
        `field '${field}'.`);
  }
  return errors;
}

// What `build` returns, or nothing when the model's inheritance does not
// resolve.
//
// `declaredFields` and `declaredConcepts` both resolve inheritance, and
// resolving THROWS on an `extends` naming an entity the model does not declare
// rather than reporting it. The loader accepts such a model, a
// Knowledge-Catalog-only push reaches no graph leg to catch it, and a profile
// push can create one by pruning a supertype whole. A validation gate reports;
// it does not stack-trace, so every caller that resolves inheritance to answer
// a question comes through here and stands its own check down when the answer
// is unavailable. That is the same thing a pruned profile does. Standing down
// is not silence: validatePushRequirements reports the resolution failure once
// per model, so the larger problem is named and only the checks that depend on
// the resolved model go quiet.
function ifResolvable<T>(build: () => T): T|undefined {
  try {
    return build();
  } catch {
    return undefined;
  }
}

// Why resolving the model's inheritance fails, or nothing when it succeeds.
//
// Reported rather than thrown, and reported once for the model rather than once
// per check that needed it. A model declaring no inheritance cannot fail, and
// resolving clones, so it is not asked.
function inheritanceFailure(model: SemanticModel): string|undefined {
  if (!(model.entities ?? []).some(e => e.extends?.length)) return undefined;
  try {
    resolveInheritance(model);
    return undefined;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return message.endsWith('.') ? message : `${message}.`;
  }
}

// Every field each entity has, inherited ones included. Inheritance is resolved
// through the same pass the graph legs use rather than by walking `extends`
// here, so the two can never disagree about what a subtype has. The pass
// clones, so it is skipped for a model that declares no inheritance.
function declaredFields(model: SemanticModel): Map<string, Set<string>> {
  const inherits = (model.entities ?? []).some(e => e.extends?.length);
  const entities =
      (inherits ? resolveInheritance(model).model : model).entities ?? [];
  return new Map(
      entities.map(e => [e.name, new Set((e.fields ?? []).map(f => f.name))]));
}

// The executor coordinate fields that are absent or blank. An executor with no
// gaps yields an empty list.
function missingExecutorFields(ex: Executor): string[] {
  const blank = (s: string) => s.trim().length === 0;
  switch (ex.kind) {
    case 'mcp':
      return [['server', ex.mcp.server], ['tool', ex.mcp.tool]]
          .filter(([, v]) => blank(v))
          .map(([k]) => k);
    case 'rest':
      return [['endpoint', ex.rest.endpoint], ['method', ex.rest.method]]
          .filter(([, v]) => blank(v))
          .map(([k]) => k);
    case 'grpc':
      return [['service', ex.grpc.service], ['method', ex.grpc.method]]
          .filter(([, v]) => blank(v))
          .map(([k]) => k);
    case 'sql':
      return ex.sql.statements.every(blank) ? ['statements'] : [];
  }
}


// Live pre-flight over the BigQuery-targeting models: confirms every entity's
// BigQuery source table is reachable BEFORE any destination leg runs, so a push
// fails fast when the model could not deploy, rather than surfacing a missing
// table only once the BigQuery leg executes its DDL. The caller passes only the
// models whose deployment target is a BigQuery Graph; a Spanner-targeting
// model's sources are Spanner tables (probed against a different system) and
// are not checked here.
//
// Each distinct source is probed with a dry-run query (`SELECT 1 FROM <ref>`,
// suffixed `WHERE FALSE` so it scans no data),
// so BigQuery resolves the reference exactly as the generated DDL will. That
// covers every reference form the generator emits -- a three-part
// `project.dataset.table`, a four-part federated REST-catalog / Lakehouse name
// (e.g. an Apache Iceberg table via BigLake), and quoted identifiers -- rather
// than only a three-part name. A source the loader kept verbatim because it is
// a query (contains whitespace) is not a table and is skipped. The dry-run is
// billed to the model's BigQuery deployment-target project (the same project
// the deploy runs against), falling back to `defaultProject`. Each distinct
// (billing project, reference) pair is probed once. Returns one message per
// unreachable table (empty when all pass).
export async function validateBigQueryDataSources(
    models: LoadedModel[], bq: BigQueryClient,
    defaultProject: string): Promise<string[]> {
  // Dedup by billing project + reference so a table shared across
  // entities/models is probed once; keep the first reference for a locatable
  // error message.
  const refs = new Map < string, {
    project: string;
    ref: string;
    document: string;
    model: string;
    entity: string;
  }
  >();
  for (const {document, model} of models) {
    const project = billingProject(model, defaultProject);
    for (const entity of model.entities ?? []) {
      const ref = probeableRef(entity.dataSource);
      if (!ref) continue;
      const key = `${project}\u0000${ref}`;
      if (!refs.has(key)) {
        refs.set(key, {
          project,
          ref,
          document,
          model: model.name,
          entity: entity.name,
        });
      }
    }
  }

  const errors: string[] = [];
  for (const {project, ref, document, model, entity} of refs.values()) {
    const res = await bq.query(
        project, `SELECT 1 FROM \`${ref}\` WHERE FALSE`, undefined, true);
    if (res.status === 200) continue;
    const msg = res.message?.trim() || `HTTP ${res.status}`;
    const why = /not found/i.test(msg) ?
        'does not exist' :
        /access denied|permission denied|not authorized|does not have permission/i
            .test(msg) ?
        'is not accessible (permission denied)' :
        `could not be verified (${msg})`;
    errors.push(
        `entity '${entity}' in model '${model}' (${document}) references ` +
        `BigQuery table '${ref}', which ${
            why}; the model cannot be deployed. ` +
        `Create the table or grant access to it, or fix the entity's source.`);
  }
  return errors;
}


// The BigQuery project a model's deploy -- and thus its dry-run pre-flight --
// bills to: the project of the model's first BigQuery Graph deployment target
// (where the CREATE PROPERTY GRAPH runs), falling back to the scope's default
// project when the model declares no parseable BigQuery Graph target.
// googleDeploymentTargets is safe here: validatePushRequirements ran first and
// already rejected a malformed GOOGLE extension.
function billingProject(model: SemanticModel, defaultProject: string): string {
  try {
    return googleDeploymentTargets(model).bigQuery[0]?.project ??
        defaultProject;
  } catch {
    return defaultProject;
  }
}


// A source that can be probed as a BigQuery table: the canonical `dataSource`,
// trimmed, or null when it is not a table reference -- empty, or a query the
// loader kept verbatim (contains whitespace). Unlike a tables.get probe this
// imposes no part-count limit, so a three-part `project.dataset.table` and a
// four-part REST-catalog / Lakehouse name are both returned for the dry-run to
// resolve.
function probeableRef(dataSource: string|undefined): string|null {
  const trimmed = (dataSource ?? '').trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  // A non-BigQuery resource URI (Spanner/AlloyDB/iceberg/...) is not a
  // BigQuery table, so the BigQuery pre-flight does not probe it. (BigQuery
  // source URIs are normalized to project.dataset.table by the loader, so a
  // URI reaching here is non-BigQuery.)
  if (trimmed.startsWith('//') || /^[a-z][\w+.-]*:\/\//i.test(trimmed)) {
    return null;
  }
  return trimmed;
}
