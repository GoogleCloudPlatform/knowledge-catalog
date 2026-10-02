// Vocabularies (K3, proposed): entities whose rows are a closed list of
// members declared in the model (see ir.Entity.members) -- an order-status or
// lifecycle-stage list, the OWL named individuals of an enumerated class.
//
// The members are the vocabulary's data, so no physical table is needed:
//
//   - BigQuery: kcmd generates one view per vocabulary,
//     `vocab_<snake_case(entity)>`, with the fixed columns
//     (code, label, sort_order, definition, iri) --
//
//       SELECT * FROM UNNEST([
//         STRUCT('OPEN' AS code, 'Open' AS label, 1 AS sort_order,
//                CAST(NULL AS STRING) AS definition, '<iri>' AS iri), ...])
//
//     -- deploys it before the graph, and the entity's node table reads it.
//     The view is generated when the entity has no source, or when its source
//     names that conventional view; a vocabulary bound to any other table keeps
//     it (its members are then documentation only), so kcmd never replaces a
//     table it does not own.
//   - Edges into a vocabulary match the code CASE-INSENSITIVELY, the same
//     lowering choice a defined entity makes for a code comparison (see
//     converters/owl/definitions.ts): a foreign key `shipped` still reaches the
//     `SHIPPED` member. A graph edge joins on column equality, so each such edge
//     is backed by a generated `edge_<relationship>` view that resolves the
//     foreign key against the vocabulary first.
//   - Knowledge Catalog: the members ride the entity description as a fixed,
//     parseable trailing paragraph (`Members: "OPEN" — "Open"; ...`), the
//     convention K1/K7 use for what the closed templates have no slot for.
//   - Skill pages list the members (code — label).
//
// Everything K3 owns lives here so the feature is easy to find, rename or drop.

import {Association, Entity, Field, fieldBinding, Relationship, SemanticModel, VocabularyMember} from './ir';
import {aliased, edgeViewName, GeneratedView, oneLine, physicalColumnOf, snakeCase, sqlInteger, sqlString, tableName, viewRef, ViewTarget} from './generated_views';

/** The columns of a generated vocabulary view, in order. */
export const VOCABULARY_COLUMNS =
    ['code', 'label', 'sort_order', 'definition', 'iri'] as const;

type VocabularyColumn = typeof VOCABULARY_COLUMNS[number];

const COLUMN_TYPES: Record<VocabularyColumn, Field['type']> = {
  code: 'String',
  label: 'String',
  sort_order: 'Integer',
  definition: 'String',
  iri: 'String',
};

/** Whether the entity is a vocabulary (declares `members`, even none). */
export function isVocabulary(entity: Pick<Entity, 'members'>): boolean {
  return entity.members !== undefined;
}

/** The conventional name of an entity's generated vocabulary view. */
export function vocabularyViewName(entityName: string): string {
  return `vocab_${snakeCase(entityName)}`;
}

/**
 * Whether kcmd generates the entity's table from its members: a concrete
 * vocabulary with no source (or an `unbound:` placeholder), or whose source
 * names its conventional `vocab_<entity>` view.
 */
export function generatesVocabularyView(entity: Entity): boolean {
  if (!isVocabulary(entity) || entity.abstract || entity.definition) {
    return false;
  }
  const source = (entity.dataSource ?? '').trim();
  if (!source || source.startsWith('unbound:')) return true;
  return tableName(source) === vocabularyViewName(entity.name);
}

// The view column a field binds to by default: a column of the same name in
// snake case (`sortOrder` -> sort_order), `order` for sort_order.
function defaultColumn(fieldName: string): VocabularyColumn|undefined {
  const snake = snakeCase(fieldName);
  if (snake === 'order') return 'sort_order';
  return (VOCABULARY_COLUMNS as readonly string[]).includes(snake) ?
      snake as VocabularyColumn :
      undefined;
}

/**
 * Binds the fields of a vocabulary whose view kcmd generates to that view's
 * columns wherever the model leaves them unbound: a single key field reads
 * `code`, any other field the column of its own name (see defaultColumn). A
 * vocabulary declared without a key is keyed by its code -- a `code` field is
 * added when none reads it, and one declared with no fields at all exposes
 * every view column. Returns the input untouched for any other entity; never
 * mutates it.
 */
export function withVocabularyBindings(entity: Entity): Entity {
  if (!generatesVocabularyView(entity)) return entity;
  const keys = entity.keys ?? [];
  const fields = entity.fields.map(f => {
    if (fieldBinding(f) !== undefined) return f;
    const column = keys.length === 1 && keys[0] === f.name ?
        'code' :
        defaultColumn(f.name);
    return column ? {...f, expression: column} : f;
  });
  const out: Entity = {...entity, fields};
  if (keys.length) return out;
  const synthesized = (column: VocabularyColumn): Field =>
      ({name: column, expression: column, type: COLUMN_TYPES[column]});
  if (!fields.length) {
    out.fields = VOCABULARY_COLUMNS.map(synthesized);
  } else if (!fields.some(f => fieldBinding(f) === 'code')) {
    out.fields = [synthesized('code'), ...fields];
  }
  out.keys = [out.fields.find(f => fieldBinding(f) === 'code')!.name];
  return out;
}

/** The `CREATE OR REPLACE VIEW` statement for a vocabulary's members. */
export function vocabularyViewDdl(entity: Entity, ref: string): string {
  const members = entity.members ?? [];
  const description = `Vocabulary ${entity.name}: one row per member ` +
      `declared in the semantic model. Generated by kcmd; do not edit.`;
  // `label` is the display text, so a member without one shows its code.
  const rows = members.map(
      m => `  STRUCT(${sqlString(m.code)} AS code, ${
          sqlString(m.label ?? m.code)} AS label, ${
          sqlInteger(m.order)} AS sort_order, ${
          sqlString(m.definition)} AS definition, ${sqlString(m.iri)} AS iri)`);
  // An empty vocabulary still needs typed columns: UNNEST of an untyped empty
  // array has none.
  const body = rows.length ?
      `SELECT * FROM UNNEST([\n${rows.join(',\n')}\n])` :
      'SELECT * FROM UNNEST(ARRAY<STRUCT<code STRING, label STRING, ' +
          'sort_order INT64, definition STRING, iri STRING>>[])';
  return `CREATE OR REPLACE VIEW \`${ref}\`\nOPTIONS (description = ${
      sqlString(description)}) AS\n${body}`;
}

// --------------------------------------------------------------------------
// BigQuery lowering.
// --------------------------------------------------------------------------

/**
 * Binds each vocabulary whose view kcmd generates to that view: its source set
 * to the view's reference (the source the model names, else the conventional
 * name next to the graph) and its fields bound per withVocabularyBindings.
 * Returns the rewritten entities -- the input is not mutated -- and one view
 * per such vocabulary, in entity order.
 */
export function bindVocabularies(
    entities: readonly Entity[], target: ViewTarget,
    warnings: string[]): {entities: Entity[]; views: GeneratedView[]} {
  const views: GeneratedView[] = [];
  const bound = entities.map(entity => {
    if (!generatesVocabularyView(entity)) return entity;
    const name = vocabularyViewName(entity.name);
    const source = (entity.dataSource ?? '').trim();
    const ref = source && !source.startsWith('unbound:') ?
        source.replace(/`/g, '') :
        viewRef(name, target);
    if (!entity.members?.length) {
      warnings.push(
          `entity '${entity.name}': vocabulary with no members; its view ` +
          `'${name}' is empty`);
    }
    const out = withVocabularyBindings({...entity, dataSource: ref});
    const codeField = out.fields.find(f => fieldBinding(f) === 'code');
    if (codeField?.type !== undefined && codeField.type !== 'String') {
      warnings.push(
          `entity '${entity.name}': field '${codeField.name}' reads the ` +
          `generated view's code column, which is STRING, but is declared ` +
          `${codeField.type}; compare it as text (edges into the vocabulary ` +
          `cast foreign keys to STRING)`);
    }
    views.push({
      name: tableName(ref),
      ref,
      kind: 'vocabulary',
      ddl: vocabularyViewDdl(out, ref),
    });
    return out;
  });
  return {entities: bound, views};
}

/**
 * Lowers a model's vocabularies for a BigQuery graph: each vocabulary whose
 * view kcmd generates is bound to that view (see bindVocabularies), and each
 * foreign-key edge into a vocabulary is re-backed by an `edge_<relationship>`
 * view that matches the code case-insensitively (an association edge, see
 * ir.Association). Returns the rewritten model -- the input is not mutated --
 * and the views to deploy, in dependency order (vocabularies, then the edges
 * that read them). A model without a vocabulary is returned as-is with no
 * views.
 */
export function lowerVocabularies(
    model: SemanticModel, target: ViewTarget,
    warnings: string[]): {model: SemanticModel; views: GeneratedView[]} {
  const entities = model.entities ?? [];
  if (!entities.some(isVocabulary)) return {model, views: []};

  const {entities: lowered, views} =
      bindVocabularies(entities, target, warnings);
  const byName = new Map(lowered.map(e => [e.name, e]));

  const relationships = (model.relationships ?? []).map(rel => {
    const dest = byName.get(rel.destination.entity);
    const src = byName.get(rel.source.entity);
    if (!dest || !isVocabulary(dest) || !src || rel.abstract ||
        rel.association || rel.via?.length || !rel.source.columns.length ||
        !rel.destination.columns.length || src.abstract || !src.dataSource) {
      return rel;
    }
    const edge = vocabularyEdgeView(rel, src, dest, target);
    views.push(edge.view);
    return {...rel, association: edge.association};
  });
  return {model: {...model, entities: lowered, relationships}, views};
}

// Whether a field compares as text (so LOWER() applies): String or untyped.
function textual(entity: Entity, fieldName: string): boolean {
  const type = entity.fields.find(f => f.name === fieldName)?.type;
  return type === undefined || type === 'String';
}

/**
 * Whether a vocabulary-side field reads a text column: a generated view's
 * column has its fixed type (see COLUMN_TYPES) whatever the field declares;
 * any other table's column has the field's declared type.
 */
export function vocabularyColumnIsText(
    entity: Entity, fieldName: string): boolean {
  if (generatesVocabularyView(entity)) {
    const column = physicalColumnOf(entity, fieldName);
    if ((VOCABULARY_COLUMNS as readonly string[]).includes(column)) {
      return COLUMN_TYPES[column as VocabularyColumn] === 'String';
    }
  }
  return textual(entity, fieldName);
}

/**
 * The condition joining a foreign key (`fkField` of `fkEntity`, read through
 * `fkAlias`) to a vocabulary's code (`codeField`, through `vocabAlias`): a
 * text code matches case-insensitively, a non-text foreign key cast to STRING
 * first (a generated view stores every code as text); a code typed otherwise
 * compares as-is. Shared by the edge views here and the derived-relationship
 * hops into a vocabulary (derived_relationships.ts).
 */
export function vocabularyJoinCondition(
    fkEntity: Entity, fkAlias: string, fkField: string, vocabulary: Entity,
    vocabAlias: string, codeField: string): string {
  const left = aliased(fkAlias, physicalColumnOf(fkEntity, fkField));
  const right = aliased(vocabAlias, physicalColumnOf(vocabulary, codeField));
  if (!vocabularyColumnIsText(vocabulary, codeField)) {
    return `${left} = ${right}`;
  }
  return textual(fkEntity, fkField) ?
      `LOWER(${left}) = LOWER(${right})` :
      `LOWER(CAST(${left} AS STRING)) = LOWER(${right})`;
}

// The view behind a foreign-key edge into a vocabulary: one row per source row
// whose foreign key matches a member's code, compared case-insensitively.
function vocabularyEdgeView(
    rel: Relationship, src: Entity, dest: Entity,
    target: ViewTarget): {view: GeneratedView; association: Association} {
  const name = edgeViewName(rel.name);
  const ref = viewRef(name, target);
  const sourceKeys = src.keys.map(k => physicalColumnOf(src, k));
  const destKeys = dest.keys.map(k => physicalColumnOf(dest, k));
  const sourceColumns = sourceKeys.map(c => `source_${outputName(c)}`);
  const destinationColumns = destKeys.map(c => `target_${outputName(c)}`);
  const conditions = rel.source.columns.map(
      (fk, i) => vocabularyJoinCondition(
          src, 's', fk, dest, 'v', rel.destination.columns[i]));
  const select = [
    ...sourceKeys.map((c, i) => `${aliased('s', c)} AS ${sourceColumns[i]}`),
    ...destKeys.map((c, i) => `${aliased('v', c)} AS ${destinationColumns[i]}`),
  ];
  const description = `Edge ${rel.name} (${rel.source.entity} -> ${
      rel.destination.entity}): each ${rel.source.entity} row paired with the ${
      rel.destination.entity} member whose code matches its ${
      rel.source.columns.join(', ')} case-insensitively. Generated by kcmd; ` +
      `do not edit.`;
  const ddl = [
    `CREATE OR REPLACE VIEW \`${ref}\``,
    `OPTIONS (description = ${sqlString(description)}) AS`,
    `SELECT ${select.join(', ')}`,
    `FROM \`${src.dataSource.replace(/`/g, '')}\` AS s`,
    `JOIN \`${dest.dataSource.replace(/`/g, '')}\` AS v`,
    `  ON ${conditions.join(' AND ')}`,
  ].join('\n');
  return {
    view: {name, ref, kind: 'edge', ddl},
    association: {
      dataSource: ref,
      keys: [...sourceColumns, ...destinationColumns],
      sourceColumns,
      destinationColumns,
    },
  };
}

// An output column name derived from a physical column (an expression yields
// a sanitized name).
function outputName(column: string): string {
  const cleaned = column.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'key';
}

// --------------------------------------------------------------------------
// Skill pages.
// --------------------------------------------------------------------------

/**
 * The member lines of a vocabulary's skill page: an intro naming the property
 * that holds the code, then one `code — label` bullet per member, in order,
 * with its definition and synonyms when present. Empty for any other entity.
 */
export function vocabularySkillLines(entity: Entity): string[] {
  if (!isVocabulary(entity)) return [];
  const members = entity.members ?? [];
  const keys = entity.keys ?? [];
  const codeProperty = keys.length === 1 ? `\`${keys[0]}\`` : 'the code';
  const out = [
    `A closed list of ${members.length} member${
        members.length === 1 ? '' : 's'}. Filter on ${codeProperty} (the ` +
        `code); an edge into ${entity.name} matches the code ` +
        `case-insensitively. Members (code — label):`,
    '',
  ];
  for (const m of members) {
    const label =
        m.label !== undefined && m.label !== m.code ? ` — ${m.label}` : '';
    const definition =
        m.definition !== undefined ? `: ${oneLine(m.definition)}` : '';
    const synonyms =
        m.synonyms?.length ? ` (also: ${m.synonyms.join(', ')})` : '';
    out.push(`- \`${m.code}\`${label}${definition}${synonyms}`);
  }
  if (!members.length) out.push('- (none declared)');
  return out;
}

// --------------------------------------------------------------------------
// Knowledge Catalog trailer codec.
// --------------------------------------------------------------------------

/** The prefix of the members paragraph on a published entity description. */
export const MEMBERS_PREFIX = 'Members: ';

/**
 * The members paragraph a vocabulary's catalog entry carries:
 * `Members: "OPEN" — "Open"; "VOID".` (codes and labels as JSON
 * strings, so any character survives the round trip), or `Members: none.`.
 * Undefined for any other entity.
 */
export function membersTrailer(entity: Pick<Entity, 'members'>): string|
    undefined {
  if (!isVocabulary(entity)) return undefined;
  const members = entity.members ?? [];
  if (!members.length) return `${MEMBERS_PREFIX}none.`;
  return `${MEMBERS_PREFIX}${
      members
          .map(
              m => m.label !== undefined ?
                  `${JSON.stringify(m.code)} — ${JSON.stringify(m.label)}` :
                  JSON.stringify(m.code))
          .join('; ')}.`;
}

const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"';

function parseMembers(body: string): VocabularyMember[]|undefined {
  if (body === 'none.') return [];
  const item =
      new RegExp(`(${JSON_STRING})(?: — (${JSON_STRING}))?(; |\\.$)`, 'y');
  const out: VocabularyMember[] = [];
  let at = 0;
  while (at < body.length) {
    item.lastIndex = at;
    const m = item.exec(body);
    if (!m) return undefined;
    const member: VocabularyMember = {code: JSON.parse(m[1])};
    if (m[2] !== undefined) member.label = JSON.parse(m[2]);
    out.push(member);
    at = item.lastIndex;
    if (m[3] === '.') break;
  }
  return at === body.length ? out : undefined;
}

/**
 * Peels the members paragraph (see membersTrailer) off the end of a pulled
 * entity description. Text without one is returned untouched. Codes and labels
 * round-trip; order is the paragraph's order, and synonyms, definitions and
 * IRIs are not published.
 */
export function splitMembersTrailer(text: string|undefined):
    {rest: string|undefined; members?: VocabularyMember[]} {
  if (text === undefined) return {rest: undefined};
  const paragraphs = text.split('\n\n');
  const last = paragraphs[paragraphs.length - 1];
  if (!last.startsWith(MEMBERS_PREFIX)) return {rest: text};
  const members = parseMembers(last.slice(MEMBERS_PREFIX.length));
  if (!members) return {rest: text};
  const rest = paragraphs.slice(0, -1).join('\n\n');
  return {rest: rest === '' ? undefined : rest, members};
}
