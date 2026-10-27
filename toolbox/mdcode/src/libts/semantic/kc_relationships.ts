// Converts a semantic model's relationships to and from
// `semantic-relationship` entries, the form mapping Addendum 6 gives them
// (go/semantic-ontology-kc-mapping; b/568392896 part 4 writes them, and
// b/568393469 "Relationships" reads them back). kcmd's local entry view shows
// relationships this way; until the V2 switch, push still publishes each one
// as a `schema-join` link.
//

import type {Aspect, Entry} from '../gcp/dataplex';
import {AiContext, Relationship, RelationshipEnd, SemanticModel} from './ir';
import {aspectDataOf} from './kc_converter';
import {Namer} from './kc_ids';

export const RELATIONSHIP_TYPE = 'semantic-relationship';


// The `semantic-relationship` entry for one relationship of `model`: a child
// of the model entry, named by Namer.relationshipId. Its aspect names the
// `from` entity as `source` and the `to` entity as `target`, each with its
// join columns as `fields` (absent for an unbound relationship), the join
// columns of each named profile that binds it, and its synonyms. Its
// instructions go in a `guidelines` aspect, as for an entity.
export function relationshipEntry(
    model: SemanticModel, rel: Relationship, names: Namer): Entry {
  const profiles = (model.profiles ?? []).flatMap(profile => {
    const binding = profile.relationships.find(r => r.name === rel.name);
    return binding ? [{
      name: profile.name,
      sourceFields: [...binding.fromColumns],
      targetFields: [...binding.toColumns],
    }] :
                     [];
  });
  const data = compact({
    source: endData(rel.source),
    target: endData(rel.destination),
    profiles: profiles.length ? profiles : undefined,
    synonyms: rel.aiContext?.synonyms?.length ? [...rel.aiContext.synonyms] :
                                                undefined,
  });
  const aspects: Record<string, Aspect> = {
    [names.aspectRef(RELATIONSHIP_TYPE)]: {
      aspectType: names.typeName('aspect', RELATIONSHIP_TYPE),
      data,
    },
  };
  const instructions = rel.aiContext?.instructions;
  if (instructions) {
    aspects[names.aspectRef('guidelines')] = {
      aspectType: names.typeName('aspect', 'guidelines'),
      data: {instructions, userManaged: true},
    };
  }
  return {
    name: names.entry(names.relationshipId(model, rel)),
    entryType: names.typeName('entry', RELATIONSHIP_TYPE),
    parentEntry: names.entry(names.modelId(model)),
    entrySource: compact({displayName: rel.name, description: rel.description}),
    aspects,
  } as Entry;
}


// The relationship that a `semantic-relationship` entry holds. Anything that
// would be lost or read wrongly goes to `problems`, and the result is
// undefined when the entry holds no usable relationship. Named profiles' join
// columns are not read: they belong to the profiles.
export function readRelationshipEntry(
    entry: Entry, problems: string[]): Relationship|undefined {
  const name = entry.entrySource?.displayName;
  const label = `relationship '${name ?? entry.name}'`;
  if (typeof name !== 'string' || name === '') {
    problems.push(`${label}: resource.displayName must hold its name`);
    return undefined;
  }
  const data = aspectDataOf(entry.aspects, RELATIONSHIP_TYPE);
  const source = readEnd(data.source, 'source', label, problems);
  const target = readEnd(data.target, 'target', label, problems);
  if (!source || !target) return undefined;

  const rel: Relationship = {name, source, destination: target};
  const description = entry.entrySource?.description;
  if (description !== undefined) rel.description = description;

  const ai: AiContext = {};
  const instructions = aspectDataOf(entry.aspects, 'guidelines').instructions;
  if (typeof instructions === 'string' && instructions !== '') {
    ai.instructions = instructions;
  }
  if (data.synonyms !== undefined) {
    if (!isStringList(data.synonyms)) {
      problems.push(`${label}: synonyms must be a list of strings`);
    } else if (data.synonyms.length) {
      ai.synonyms = [...data.synonyms];
    }
  }
  if (Object.keys(ai).length) rel.aiContext = ai;
  return rel;
}


function endData(end: RelationshipEnd): Record<string, unknown> {
  return compact({
    name: end.entity,
    fields: end.columns.length ? [...end.columns] : undefined,
  });
}


function readEnd(
    value: any, key: 'source'|'target', label: string,
    problems: string[]): RelationshipEnd|undefined {
  if (typeof value?.name !== 'string' || value.name === '') {
    problems.push(`${label}: ${key}.name must name an entity`);
    return undefined;
  }
  if (value.fields !== undefined && !isStringList(value.fields)) {
    problems.push(`${label}: ${key}.fields must be a list of column names`);
    return undefined;
  }
  return {entity: value.name, columns: [...(value.fields ?? [])]};
}


function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}


function compact<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
