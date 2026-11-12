// Push's checks of the SQL of each field and metric.

import {Entity, expressionForDialect, Field, isFieldBound, Metric, SemanticModel, SqlDialect} from './ir';
import {inheritedNoSqlProblems, noSqlProblemOf, noSqlReason, OSSIE_VERSION, writtenSource} from './loader';
import {qualifierCaseError} from './names';
import {declaredConceptFields, resolveInheritance} from './resolve_inheritance';
import {DialectLoad, expressionSources, fieldsOnTables, firstEntityPerDatabase, noTextFor, possibleDialects, sourcesDialect} from './resolve_profiles';
import {columnsForSource, columnsWithoutDialect, entitiesReached, fieldsReadOn, measureEntities, qualifiedColumns, selfReferenceMessage} from './sql_expr_utils';
import {hashStartsComment} from './sql_identifiers';
import {SqlColumn} from './sql_parser';

// A field of an entity, or a metric.
export type ExpressionItem = {entity: string; field: string}|{metric: string};

// A problem push reports, with the field or metric it is about, when it is
// about one.
export interface ExpressionProblem {
  item?: ExpressionItem;
  problem: string;
}

// What `build` returns, or nothing when the model's inheritance does not
// resolve.
//
// `declaredFields` and `declaredConcepts` both resolve inheritance, and
// resolving THROWS on an `extends` naming an entity the model does not declare,
// on a cycle, and on an ambiguously inherited field, rather than reporting it.
// The loader accepts such a model, a
// Knowledge-Catalog-only push reaches no graph leg to catch it, and a profile
// push can create one by pruning a supertype whole. A validation gate reports;
// it does not stack-trace, so every caller that resolves inheritance to answer
// a question comes through here and stands its own check down when the answer
// is unavailable. That is the same thing a pruned profile does. Standing down
// is not silence: validatePushRequirements reports the resolution failure once
// per model, so the larger problem is named and only the checks that depend on
// the resolved model go quiet.
export function ifResolvable<T>(build: () => T): T|undefined {
  try {
    return build();
  } catch {
    return undefined;
  }
}

// Every field each entity has, inherited and profile-excluded ones included so
// an unpruned check before `pruneUnavailable` does not report a profile-excluded
// inherited field as undeclared. Inheritance is resolved through the same pass
// the graph legs use rather than by walking `extends` here, so the two can
// never disagree about what a subtype has. The pass clones, so it is skipped
// for a model that declares no inheritance.
export function declaredFields(model: SemanticModel): Map<string, Set<string>> {
  const inherits = (model.entities ?? []).some(e => e.extends?.length);
  const entities =
      (inherits ? resolveInheritance(model).model : model).entities ?? [];
  return new Map(entities.map(
      e => [
        e.name,
        new Set([
          ...(e.fields ?? []).map(f => f.name),
          ...(e.excludedFields ?? []),
        ]),
      ]));
}

// Push's checks of the SQL of each field and metric of `model`, written in
// `document`, each problem with the field or metric it is about:
//   - Reject a field or a metric with no SQL, as the loader does, since a
//     model built in memory skips the loader (see fieldNoSqlProblems and
//     metricNoSqlError).
// The rules below run when inheritance resolved cleanly:
//   - For each metric:
//     1. Unless it has no SQL, reject a metric with no `authoredEntity` when
//        its expressions, read together, reach no entity or more than one.
//     2. Reject when `authoredEntity ?? entity` does not name a declared
//        entity (runs on every push).
//     3. When `authoredEntity` is set and the expressions reference at least
//        one entity, at least one of those must be `authoredEntity`.
//     4. For every referenced entity, every field it is referenced with must
//        be declared or inherited on that entity (gated on `!fieldsPruned`,
//        and run before pruning).
//     5. Reject a column reference with no entity qualifier, or a qualified
//        reference whose qualifier is not a declared entity (including when it
//        differs in case from a declared entity), in a metric expression.
//     6. Reject a metric whose name matches, ignoring case, a declared or
//        inherited field of `authoredEntity ?? entity`, since metrics and
//        fields on one entity share a namespace. This runs before pruning, so
//        a graph push catches it even when pruning drops either side.
//   - For each field on each entity E:
//     1. Reject any reference to an entity other than E, and a qualifier that
//        differs only in case from a declared entity.
//     2. For references to E itself, every field named must be declared or
//        inherited on E (gated on `!fieldsPruned`, and run before pruning).
//     3. Reject a field that names itself, directly or through other fields of
//        E, declared or inherited, since the graph renders a field that names
//        a sibling from that sibling's SQL (see selfReferenceProblems).
//
// With `load.readWithoutDialect`, an ANSI_SQL text of tables whose dialect no
// lookup read is read as columnsWithoutDialect reads it in the dialects those
// tables may have, where it is otherwise skipped. A metric text that read
// leaves a name out of is then left out of the rules on which entities the
// text reaches.
export function expressionProblems(
    model: SemanticModel, document: string, fieldsPruned = false,
    warnings: string[] = [], load: DialectLoad = {}): ExpressionProblem[] {
  const errors: ExpressionProblem[] = [];
  errors.push(...fieldNoSqlProblems(model, document));
  const fieldsByEntity = ifResolvable(() => declaredFields(model));
  if (!fieldsByEntity) {
    for (const metric of model.metrics ?? []) {
      const noSql = metricNoSqlError(metric, model, document);
      if (noSql) errors.push({item: {metric: metric.name}, problem: noSql});
    }
    return errors;
  }
  const entityNames = [...fieldsByEntity.keys()];
  const sourcesRead = sourcesDialect(model);
  const dialectless = sourcesRead === null && !!load.readWithoutDialect;
  const impliedDialect = dialectless ? undefined : sourcesRead;
  // Each entity's fields as the graph renders them (see selfReferenceProblems),
  // with an inherited text read in the sources' dialect, as the runtime
  // reads it. A dialect in which `#` starts a comment is read with BigQuery's
  // rules, which also start a comment at `#`.
  const inheritedReading =
      impliedDialect && !hashStartsComment(impliedDialect) ? impliedDialect :
                                                             undefined;
  const resolvedByName = new Map(
      (ifResolvable(
           () => resolveInheritance(model, inheritedReading, {requalify: true})
                     .model.entities) ??
       model.entities ?? [])
          .map(e => [e.name, e]));
  const candidates =
      dialectless ? possibleDialects(model.entities ?? []) : [];
  // The columns `text` reads, and whether the read left a name out.
  const read = (text: string, dialect: string) => {
    if (dialect !== 'ANSI_SQL' || !dialectless) {
      return {
        columns: columnsForSource(text, dialect, impliedDialect),
        skipped: false,
      };
    }
    const r = columnsWithoutDialect(text, candidates);
    return {columns: r?.columns, skipped: !!r?.skipped};
  };
  const addUnreadableWarning =
      (what: string, total: number, unread: string[]) => {
        // A caller that looked up no table's dialect and did not set
        // readWithoutDialect reads no ANSI_SQL text when every table needs
        // the lookup, so it warns about none.
        const unreadDialects = impliedDialect === null ?
            unread.filter(d => d !== 'ANSI_SQL') :
            unread;
        if (!unreadDialects.length) return;
        if (unreadDialects.length === total) {
          warnings.push(
              `${what} in model '${model.name}' (${document}): kcmd could ` +
              `not read its SQL, so the fields it reads were not checked.`);
        } else {
          const listed = unreadDialects.map(d => `'${d}'`).join(', ');
          const entryText = unreadDialects.length === 1 ?
              'that entry reads' :
              'those entries read';
          warnings.push(
              `${what} in model '${model.name}' (${document}): kcmd could ` +
              `not read its ${listed} SQL, so the fields ${entryText} were ` +
              `not checked.`);
        }
      };

  for (const entity of model.entities ?? []) {
    const others = entityNames.filter(n => n !== entity.name);
    const knownFields = fieldsByEntity.get(entity.name)!;
    for (const field of entity.fields ?? []) {
      const item = {entity: entity.name, field: field.name};
      // A text with no SQL has nothing to read, so it gets no warning.
      const sources = expressionSources(field).filter(
          s => noSqlReason(s.text, s.dialect, entity.name) === undefined);
      const allColumns: SqlColumn[] = [];
      const unreadDialects: string[] = [];
      for (const {text, dialect} of sources) {
        const {columns} = read(text, dialect);
        if (!columns) {
          unreadDialects.push(dialect);
          continue;
        }
        allColumns.push(...columns);
      }
      addUnreadableWarning(
          `field '${entity.name}.${field.name}'`, sources.length,
          unreadDialects);
      for (const other of others) {
        const refs = fieldsReadOn(allColumns, other);
        if (refs.length) {
          errors.push({item, problem:
              `field '${entity.name}.${field.name}' in model '${
                  model.name}' (${document}) references entity '${
                  other}' ('${other}.${
                  refs[0]}'); a field expression may only reference its ` +
              `own entity '${
                  entity.name}' or unqualified columns of its backing ` +
              `table.`});
        }
      }
      const where = `field '${entity.name}.${field.name}' in model '${
          model.name}' (${document})`;
      errors.push(...[...new Set(allColumns.flatMap(
          c => qualifierCaseError(where, c, entityNames) ?? []))]
          .map(problem => ({item, problem})));
      if (!fieldsPruned) {
        for (const ref of fieldsReadOn(allColumns, entity.name)) {
          if (!knownFields.has(ref)) {
            errors.push({item, problem:
                `field '${entity.name}.${field.name}' in model '${
                    model.name}' (${document}) references '${
                    entity.name}.${ref}', which is not a declared or ` +
                `inherited field of '${entity.name}'.`});
          }
        }
      }
    }
    errors.push(...selfReferenceProblems(
        entity, resolvedByName.get(entity.name) ?? entity, model, document,
        impliedDialect));
  }

  const entityOfMetric =
      new Map((model.metrics ?? []).map(m => [m.name, m.entity]));
  for (const metric of model.metrics ?? []) {
    const item = {metric: metric.name};
    const authored = metric.authoredEntity;
    const anchor = authored ?? metric.entity;
    // Whether `name`, read where a field belongs, names another metric of
    // the model: qualified with `on`, that metric's entity, or unqualified
    // and no field of this metric's entity, declared or inherited. A metric
    // cannot read another metric, so each such metric gets one message,
    // with no advice on how to name a field.
    const metricsRead = new Set<string>();
    const readsMetric = (name: string, on?: string) => {
      if (name === metric.name || !entityOfMetric.has(name)) return false;
      if (on === undefined ?
              anchor !== undefined && fieldsByEntity.get(anchor)?.has(name) :
              entityOfMetric.get(name) !== on) {
        return false;
      }
      if (!metricsRead.has(name)) {
        metricsRead.add(name);
        errors.push({item, problem:
            `metric '${metric.name}' in model '${model.name}' (${
                document}): '${name}' is a metric, and a metric over ` +
            `other metrics is not supported in this version; write the ` +
            `expression of '${name}' in its place.`});
      }
      return true;
    };
    const sources = expressionSources(metric);
    // A text with no SQL has nothing to read, so it gets no warning.
    const readable =
        sources.filter(s => noSqlReason(s.text, s.dialect) === undefined);
    const allColumns: SqlColumn[] = [];
    const unreadDialects: string[] = [];
    // Whether the read left a name out of a text.
    let partial = false;
    for (const {text, dialect} of readable) {
      const {columns, skipped} = read(text, dialect);
      if (!columns) {
        unreadDialects.push(dialect);
        continue;
      }
      partial ||= skipped;
      allColumns.push(...columns);
    }
    addUnreadableWarning(
        `metric '${metric.name}'`, readable.length, unreadDialects);

    const reached = entitiesReached(allColumns, entityNames);

    const collision = metricFieldCollisionError(
        metric, anchor, fieldsByEntity, model, document);
    if (collision) errors.push({item, problem: collision});

    // An anchor does not make up for missing SQL: the graph would drop the
    // metric.
    const noSql = metricNoSqlError(metric, model, document);
    if (noSql) {
      errors.push({item, problem: noSql});
    } else if (
        !partial &&
        (!authored && unreadDialects.length === 0 && allColumns.length === 0 ||
         !authored && reached.length > 1)) {
      const fixHint = model.version === '0.2.0.dev0' ?
          `set 'entity' in a GOOGLE custom_extensions block on the metric ` +
          `(or use version '0.2.0.dev0/google' and set 'entity' on the ` +
          `metric) or scope its expression to one entity.` :
          `set 'entity' on the metric or scope its expression to one entity.`;
      errors.push({item, problem:
          `metric '${metric.name}' in model '${model.name}' (${
              document}) has no 'entity' anchor and its expression${
              reached.length === 0 ?
                  ' reaches no declared entity' :
                  ` reaches multiple entities (${reached.join(', ')})`}, ` +
          `so it does not resolve to a single entity; ${fixHint}`});
    }

    if (anchor !== undefined && !fieldsByEntity.has(anchor)) {
      errors.push({item, problem:
          `metric '${metric.name}' in model '${model.name}' (${
              document}): entity '${
              anchor}' is not declared in the model.`});
    }

    if (!partial && authored !== undefined && fieldsByEntity.has(authored) &&
        reached.length > 0 && !reached.includes(authored)) {
      errors.push({item, problem:
          `metric '${metric.name}' in model '${model.name}' (${
              document}) is anchored to entity '${
              authored}', but its expression only references ${
              reached.map(e => `'${e}'`).join(', ')}; the anchor ` +
          `contradicts the SQL.`});
    }

    if (!fieldsPruned) {
      for (const entityName of reached) {
        const knownFields = fieldsByEntity.get(entityName)!;
        for (const ref of fieldsReadOn(allColumns, entityName)) {
          if (!knownFields.has(ref) && !readsMetric(ref, entityName)) {
            errors.push({item, problem:
                `metric '${metric.name}' in model '${model.name}' (${
                    document}): expression references '${entityName}.${
                    ref}', but entity '${entityName}' has no field '${
                    ref}'; metric expressions must reference declared ` +
                `fields, not physical columns.`});
          }
        }
      }
    }

    const seenUnqualified = new Set<string>();
    for (const col of allColumns) {
      if (col.qualifier !== undefined &&
          (fieldsByEntity.has(col.qualifier) || col.qualifier === anchor)) {
        continue;
      }
      const token = col.qualifier !== undefined ?
          `${col.qualifier}.${col.name}` :
          col.name;
      if (seenUnqualified.has(token)) continue;
      seenUnqualified.add(token);
      if (col.qualifier === undefined) {
        if (readsMetric(col.name)) continue;
        errors.push({item, problem:
            `metric '${metric.name}' in model '${model.name}' (${
                document}): '${token}' must be written as ` +
            `'entity.field'; a metric reads fields, never columns.`});
      } else {
        const where =
            `metric '${metric.name}' in model '${model.name}' (${document})`;
        errors.push({item, problem:
            qualifierCaseError(where, col, entityNames) ??
            `${where}: '${token}' has qualifier '${col.qualifier}', which ` +
                `is not a declared entity in model '${model.name}'; write ` +
                `'entity.field' starting with a declared entity.`});
      }
    }
  }
  return errors;
}

// Why each field of `model` holds no SQL, in the loader's words. Each field
// is read on the entity that declares it, and each field an entity inherits
// is read on that entity, as the loader does. An association's field is an
// edge property, read on its relationship.
function fieldNoSqlProblems(
    model: SemanticModel, document: string): ExpressionProblem[] {
  const where = `in model '${model.name}' (${document})`;
  const errors: ExpressionProblem[] = [];
  for (const e of model.entities ?? []) {
    for (const f of e.fields ?? []) {
      const problem = noSqlProblemOf(f, e.name);
      if (problem) {
        errors.push({item: {entity: e.name, field: f.name}, problem:
            `field '${e.name}.${f.name}' ${where}: ${problem}; write the ` +
            `field's SQL, or remove 'expression' to leave the field unbound.`});
      }
    }
  }
  if ((model.entities ?? []).some(e => e.extends?.length)) {
    const concepts = ifResolvable(() => declaredConceptFields(model));
    const inherited = concepts ?
        inheritedNoSqlProblems(model.entities ?? [], concepts, noSqlProblemOf) :
        [];
    for (const problem of inherited) {
      errors.push(
          {problem: `model '${model.name}' (${document}): ${problem}.`});
    }
  }
  for (const rel of model.relationships ?? []) {
    for (const f of rel.association?.fields ?? []) {
      const problem = noSqlProblemOf(f, rel.name);
      if (problem) {
        errors.push({problem:
            `relationship '${rel.name}' field '${f.name}' ${where}: ${
                problem}; write the field's SQL.`});
      }
    }
  }
  return errors;
}

// The errors for the fields of `entity` that name themselves, directly or
// through other fields of `entity`. The graph renders a field that names a
// sibling as `<entity>.<field>` from that sibling's own SQL, so a field that
// reaches itself that way has no SQL to render. A field expression that writes
// its own column as `<entity>.<field>` names itself too: write the bare column
// instead. With the dialect the sources imply, each field gives the text a
// database of that dialect runs, picked as the runtime picks it: its entry for
// that dialect, else its ANSI_SQL one. A text no database of that dialect runs
// forms no cycle. With no dialect known, each dialect is read on its own, from
// the text an engine of that dialect renders, so two texts that no one engine
// reads together do not form a cycle.
//
// `resolved` is `entity` with the fields it inherits, which name its fields
// as the graph renders them (see resolve_inheritance.localizeInheritedField),
// so a field can reach itself through one it inherits. A cycle is reported on
// an entity only when a field on it is bound there, so one an ancestor forms on
// its own is reported on that ancestor alone.
function selfReferenceProblems(
    entity: Entity, resolved: Entity, model: SemanticModel, document: string,
    impliedDialect: string|null|undefined): ExpressionProblem[] {
  const own = entity.fields ?? [];
  const inherited = resolved.fields ?? [];
  // A field a profile excludes is left off `resolved`, but still checked.
  const fields = [
    ...inherited,
    ...own.filter(f => !inherited.some(r => r.name === f.name)),
  ];
  const bound = new Set(own.filter(f => isFieldBound(f)).map(f => f.name));
  const names = new Set(fields.map(f => f.name));
  // The dialects read, each on its own. With the sources' dialect known, it is
  // that dialect alone. Otherwise it is every dialect a field writes, and
  // ANSI_SQL, read as BigQuery as the graph generators read it, unless the
  // sources' dialect is null, which no lookup read.
  const dialects = new Set<string>();
  if (impliedDialect) {
    dialects.add(impliedDialect);
  } else {
    dialects.add('ANSI_SQL');
    for (const f of fields) {
      for (const d of f.dialects ?? []) dialects.add(d.dialect);
      if (f.importedDialect) dialects.add(f.importedDialect);
    }
    if (impliedDialect === null) dialects.delete('ANSI_SQL');
  }
  // Each message, with the field it names first.
  const errors = new Map<string, string>();
  for (const dialect of dialects) {
    // The fields of `entity` each field names, in this dialect, read as the
    // graph generators read them (see graph_ddl.siblingsRead), so a qualifier
    // the parser reserves, such as `Date` in `Date.days`, names them too.
    const reads = new Map<string, string[]>();
    for (const f of fields) {
      const text = expressionForDialect(f, dialect as SqlDialect);
      if (text === undefined ||
          noSqlReason(text, dialect, entity.name) !== undefined) {
        continue;
      }
      reads.set(
          f.name,
          [...new Set(qualifiedColumns(text, entity.name, dialect) ?? [])]
              .filter(n => names.has(n)));
    }
    for (const f of fields) {
      const through = pathBack(f.name, reads);
      if (!through || ![f.name, ...through].some(n => bound.has(n))) continue;
      const message = selfReferenceMessage(
                          entity.name, [f.name, ...through],
                          ` in model '${model.name}' (${document})`) +
          '.';
      if (!errors.has(message)) errors.set(message, f.name);
    }
  }
  return [...errors].map(
      ([problem, field]) => ({item: {entity: entity.name, field}, problem}));
}

// The shortest run of other fields through which `start` reaches itself in
// `reads`, empty when it names itself directly, or undefined when it does not
// reach itself.
function pathBack(
    start: string, reads: ReadonlyMap<string, string[]>): string[]|undefined {
  const via = new Map<string, string[]>();
  const queue: string[] = [];
  for (const next of reads.get(start) ?? []) {
    if (next === start) return [];
    if (!via.has(next)) {
      via.set(next, [next]);
      queue.push(next);
    }
  }
  while (queue.length) {
    const name = queue.shift()!;
    for (const next of reads.get(name) ?? []) {
      if (next === start) return via.get(name);
      if (!via.has(next)) {
        via.set(next, [...via.get(name)!, next]);
        queue.push(next);
      }
    }
  }
  return undefined;
}

// The error for a metric with no SQL, or undefined. A metric is rejected when
// none of its texts holds SQL, with or without an anchor, since the graph
// would drop it. It is also rejected when any one of its texts holds none, as
// the loader rejects it, since a model built in memory skips the loader.
function metricNoSqlError(
    metric: Metric, model: SemanticModel, document: string): string|undefined {
  const where = `metric '${metric.name}' in model '${model.name}' (${document})`;
  const readable = expressionSources(metric).filter(
      s => noSqlReason(s.text, s.dialect) === undefined);
  if (!readable.length) {
    return `${where} has no SQL in 'expression'; write the metric's SQL.`;
  }
  const problem = noSqlProblemOf(metric);
  return problem && `${where}: ${problem}; write the metric's SQL.`;
}

// The error for a metric whose name matches, ignoring case, a declared or
// inherited field of `owner`, or undefined.
function metricFieldCollisionError(
    metric: Metric, owner: string|undefined,
    fieldsByEntity: Map<string, Set<string>>, model: SemanticModel,
    document: string): string|undefined {
  const fields = owner === undefined ? undefined : fieldsByEntity.get(owner);
  if (!fields) return undefined;
  const lower = metric.name.toLowerCase();
  const match = [...fields].find(f => f.toLowerCase() === lower);
  if (match === undefined) return undefined;
  return `Metric '${metric.name}' in model '${model.name}' (${
             document}) collides with field '${match}' on entity '${
             owner}'; metrics and fields on the same entity share a ` +
      `namespace.`;
}

// The model file's tables are all in one database, as a profile's are, and
// when they are, each bound field has a text for the dialect of its entity's
// source. One problem for each break of these rules. `hint` gives the end of
// the message for a field with no such text.
export function inlineDialectProblems(
    model: SemanticModel, document: string,
    sourceDatabases?: ReadonlyMap<string, string>,
    hint: (entity: Entity, field: Field, dialect: string) => string = () => ''):
    ExpressionProblem[] {
  const databases = firstEntityPerDatabase(
      (model.entities ?? []).filter(e => !e.abstract).map(e => ({
        entity: e.name,
        source: writtenSource(e),
        lookedUp: e.sourceDialect,
      })),
      sourceDatabases);
  if (databases.length > 1) {
    const named = databases.map(n => `'${n}'`).join(', ');
    return [{
      problem: `model '${model.name}' (${document}) binds entities in more ` +
          `than one database (${named}); bind the model file's entities to ` +
          `tables in one database.`,
    }];
  }
  const problems: ExpressionProblem[] = [];
  for (const {entity: e, field: f, table: {name: dialect}} of
           fieldsOnTables(model)) {
    if (!noTextFor(f, [dialect])) continue;
    problems.push({
      item: {entity: e.name, field: f.name},
      problem: `field '${e.name}.${f.name}' in model '${model.name}' (${
                   document}) has no expression for ${dialect} or ANSI_SQL, ` +
          `and the model file binds entity '${e.name}' to ${
                   /^[AEIOU]/.test(dialect) ? 'an' : 'a'} ${dialect} source${
                   hint(e, f, dialect)}.`,
    });
  }
  return problems;
}

// The BigQuery graph's rules for placing each metric of `model` as a measure,
// one problem per metric that breaks them, skipping each one in
// `alreadyFlagged`, which expressionProblems has reported. The generator
// (`bigquery.ts`) places a measure on the one entity whose qualifier its
// BigQuery SQL writes before a column, or on its anchor when the SQL writes
// none (see measureEntities), and skips a metric that has no BigQuery or
// ANSI_SQL text. expressionProblems reads every dialect entry together and
// lets an authored anchor settle SQL that reads two entities, so it does not
// catch each metric the generator would skip. `hint` gives the end of the
// message for a metric with only a vendor text.
export function placementProblems(
    model: SemanticModel, document: string,
    alreadyFlagged: ReadonlySet<string>,
    hint: (metric: Metric) => string = () => ''): ExpressionProblem[] {
  const problems: ExpressionProblem[] = [];
  const entityNames = (model.entities ?? []).map(e => e.name);
  for (const metric of model.metrics ?? []) {
    if (alreadyFlagged.has(metric.name)) continue;
    const item = {metric: metric.name};
    const prefix = `metric '${metric.name}' in model '${model.name}' (${document})`;
    // The text BigQuery runs: its `BIGQUERY` entry, else its `ANSI_SQL` one,
    // else `expression` for a metric held without a dialect list.
    const bqText = expressionForDialect(metric, 'BIGQUERY');
    if (bqText === undefined && metric.importedExpression !== undefined) {
      problems.push({item, problem:
          `${prefix} targets a BigQuery graph with only a '${
              metric.importedDialect ?? 'vendor'}' expression; supply a ` +
          `'BIGQUERY' or 'ANSI_SQL' expression${hint(metric)}.`});
      continue;
    }
    const placed =
        measureEntities(bqText ?? '', entityNames, metric.entity);
    if (placed.length > 1) {
      problems.push({item, problem:
          `${prefix} targets a BigQuery graph and its BigQuery SQL reads ` +
          `several entities (${placed.join(', ')}); a BigQuery measure ` +
          `belongs to one entity's node table, so scope its expression to ` +
          `one entity.`});
    } else if (placed.length === 0) {
      const anchor = model.version === OSSIE_VERSION ?
          `'entity' in a GOOGLE custom_extensions block on the metric` :
          `top-level 'entity'`;
      problems.push({item, problem:
          `${prefix} targets a BigQuery graph but does not resolve to a ` +
          `single entity; the BigQuery generator places a measure on the ` +
          `entity its BigQuery SQL reads, or on ${anchor}.`});
    }
  }
  return problems;
}
