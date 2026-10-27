// Saves `kcmd entry save` items into a model file, and deletes `kcmd entry
// delete` names from it. Each item creates, updates or deletes one element of
// the one model in the file. The edited file must load and pass the local
// checks `kcmd push --no-profile` runs, and each element must come back as its
// item sent it, or be gone. An item that adds an error, or does not do what
// it asks, fails on its own and is not written.
//

import * as dataplex from '../gcp/dataplex';
import type {Aspect, Entry} from '../gcp/dataplex';
import * as md from '../metadata';
import {Entity, SemanticModel} from './ir';
import {aspectDataOf, readAiContext, readDeploymentTargets, readEntity, readMetric} from './kc_converter';
import {readRelationshipEntry, RELATIONSHIP_TYPE} from './kc_relationships';
import {LoadedModel} from './loader';
import {ElementList, ModelDocument} from './model_document';
import {ElementKind, loadModelFile, ModelFile, modelEntries, ModelScope, ViewEntry} from './model_entries';
import {NameKind, nameProblem} from './names';
import {validatePushRequirements} from './validate';

// What a save or delete does to the model file.
export interface SaveOutcome {
  // One result per item, in the order given.
  results: md.EntryResult[];
  // The model file's new text, or undefined when the file does not change.
  text?: string;
  // The name of the model the file holds after the save.
  model?: string;
}

// The entry types an item may create, by the last part of the type.
const CREATABLE: Record<string, ElementKind> = {
  'semantic-model': 'model',
  'semantic-entity': 'entity',
  'semantic-metric': 'metric',
  [RELATIONSHIP_TYPE]: 'relationship',
};

// The aspects the view always gives an element, which an update must hold:
// leaving one out would remove all it holds, such as every field.
const UPDATE_ASPECTS: Partial<Record<ElementKind, string[]>> = {
  model: ['semantic-model'],
  entity: ['semantic-entity', 'schema'],
  metric: ['semantic-metric'],
  relationship: [RELATIONSHIP_TYPE],
};

// The list of the model file that holds each kind of element a delete
// removes.
const LISTS: Record<'entity'|'metric'|'relationship', ElementList> = {
  entity: 'entities',
  metric: 'metrics',
  relationship: 'relationships',
};

// One item that passed planning: the change it makes to the model file.
interface Edit {
  // The item's position in the call, and the name its result reports when
  // it fails.
  index: number;
  name: string;
  // Makes the change to `doc`, which it may modify, and returns the result.
  // Throws when the change cannot be made.
  apply(doc: ModelDocument|undefined): ModelDocument;
  // The name the result reports when the edited model, shown as `view`,
  // holds what the item asked for; otherwise why it does not.
  outcome(view: ViewEntry[]): {name: string}|{error: string};
}

type Planned = Omit<Edit, 'index'>|string;

// The model file before the save, as each step needs it.
interface Base {
  file?: ModelFile;
  doc?: ModelDocument;
  model?: SemanticModel;
  view: ViewEntry[];
  errors: string[];
}


// Saves `items` into the model file `file` (undefined when the entry group
// has none yet). Throws when the file as it is does not load, which fails the
// whole call.
export function saveModelEntries(
    file: ModelFile|undefined, items: md.Entry[],
    scope: ModelScope): SaveOutcome {
  const base = readBase(file, scope);
  const planner = new Planner(base);
  return applyEdits(
      base, scope, items.map(item => ({name: item.name, planned: planner.plan(item)})));
}


// Deletes the named entries' elements from the model file `file`. Throws when
// the file as it is does not load, which fails the whole call.
export function deleteModelEntries(
    file: ModelFile|undefined, names: string[],
    scope: ModelScope): SaveOutcome {
  const base = readBase(file, scope);
  const planner = new Planner(base);
  return applyEdits(
      base, scope,
      names.map(name => ({name, planned: planner.planDelete(name)})));
}


// Applies the planned edits, records one result per item, and gives the
// file's new text.
function applyEdits(
    base: Base, scope: ModelScope,
    plans: Array<{name: string; planned: Planned}>): SaveOutcome {
  const file = base.file;
  const results: Array<md.EntryResult|undefined> =
      new Array(plans.length).fill(undefined);
  const edits: Edit[] = [];
  plans.forEach(({name, planned}, index) => {
    if (typeof planned === 'string') {
      results[index] = {name, ok: false, error: planned};
    } else {
      edits.push({...planned, index});
    }
  });

  const checker = new Checker(base, scope);
  const accepted = checker.applyAll(edits, results) ??
      checker.applyEach(edits, results);
  const text = accepted && accepted !== base.doc ? accepted.text() : undefined;
  return {
    results: results as md.EntryResult[],
    text: text !== undefined && text !== file?.text ? text : undefined,
    model: accepted?.modelName,
  };
}


function readBase(file: ModelFile|undefined, scope: ModelScope): Base {
  if (!file) return {view: [], errors: []};
  const model = loadModelFile(file, scope.project);
  return {
    file,
    doc: ModelDocument.parse(file.text),
    model,
    view: modelEntries(model, scope),
    errors: checkErrors(model, file.name),
  };
}


// Turns items into edits, one at a time, keeping track of what the earlier
// items of the call create.
class Planner {
  private readonly _byName: Map<string, ViewEntry>;
  // The model's name, once the file holds a model or an item creates one.
  private _model?: string;
  // The elements the model has, or that earlier items create, by kind.
  private readonly _names = new Map<ElementKind, Set<string>>();
  // The entities that use inheritance, which an update does not edit.
  private readonly _inheriting: Set<string>;

  constructor(base: Base) {
    this._byName = new Map(base.view.map(v => [v.entry.name, v]));
    this._model = base.model?.name;
    for (const v of base.view) this._namesOf(v.kind).add(v.element);
    this._inheriting = new Set((base.model?.entities ?? [])
                                   .filter(e => e.extends?.length || e.abstract)
                                   .map(e => e.name));
  }

  // The edit an item makes, or why it fails.
  plan(item: md.Entry): Planned {
    const existing = this._byName.get(item.name);
    if (existing) return this._update(item, existing);
    if (/[./]/.test(item.name)) {
      return `'${item.name}' is not an entry of the model; to create an ` +
          `element, name its entry by the element's own name, such as ` +
          `'orders'`;
    }
    const typeId = item.type.split('.').pop() ?? '';
    const kind = CREATABLE[typeId];
    if (!kind) {
      return typeId === 'semantic-action' || typeId === 'semantic-constraint' ?
          `saving ${typeId} entries is not supported yet` :
          `type '${item.type}' is not a type of semantic model entry`;
    }
    return this._create(item, kind);
  }

  // The edit that deletes the named entry's element, or why it fails.
  planDelete(name: string): Planned {
    const existing = this._byName.get(name);
    if (!existing) return `entry '${name}' does not exist in the semantic model`;
    const {kind, element} = existing;
    if (kind === 'model') {
      return `deleting the model's anchor entry is not supported; delete the ` +
          `model file to start over`;
    }
    if (kind === 'action' || kind === 'constraint') {
      return `deleting semantic-${kind} entries is not supported yet`;
    }
    this._byName.delete(name);
    this._namesOf(kind).delete(element);
    return {
      name,
      apply: doc => {
        if (!doc) throw new Error(`the model file has no ${kind} '${element}'`);
        doc.remove(LISTS[kind], element);
        return doc;
      },
      outcome: view =>
          view.some(v => v.kind === kind && v.element === element) ?
          {error: `the ${kind} '${element}' is still in the model`} :
          {name},
    };
  }

  private _create(item: md.Entry, kind: ElementKind): Planned {
    const name = item.name;
    const problem = nameProblem(kind as NameKind, name);
    if (problem) return problem;
    const displayName = item.resource?.displayName;
    if (displayName !== undefined && displayName !== name) {
      return `resource.displayName '${displayName}' must equal the entry ` +
          `name '${name}'; renaming is not supported`;
    }
    let entry: Entry;
    try {
      entry = toServiceEntry(item, name);
    } catch (err: any) {
      return err?.message ?? String(err);
    }

    if (kind === 'model') {
      if (this._model !== undefined) {
        return `the entry group already holds model '${this._model}'; ` +
            `kcmd entry commands work on one model per entry group`;
      }
      this._model = name;
      const anchor = {
        name,
        description: entry.entrySource?.description,
        aiContext: readAiContext(entry),
        deployments: readDeploymentTargets(entry, name, [])?.deployments,
      };
      return {
        name,
        apply: () => ModelDocument.create(anchor),
        outcome: view => savedOutcome(item, kind, name, view),
      };
    }

    if (this._model === undefined) {
      return `save the model's anchor entry (type semantic-model) before ` +
          `any other entry of the model`;
    }
    if (this._namesOf(kind).has(name)) {
      return `model '${this._model}' already has ${kind} '${name}'`;
    }
    const warnings: string[] = [];
    let add: (doc: ModelDocument) => void;
    if (kind === 'entity') {
      const entity = readEntity(entry, warnings);
      readStringFields(entity, entry);
      add = doc => doc.addEntity(entity);
    } else if (kind === 'metric') {
      const metric = readMetric(entry, [...this._namesOf('entity')], warnings);
      add = doc => doc.addMetric(metric);
    } else {
      const problems: string[] = [];
      const rel = readRelationshipEntry(entry, problems);
      if (!rel || problems.length) return problems.join('; ');
      add = doc => doc.addRelationship(rel);
    }
    this._namesOf(kind).add(name);
    return {
      name,
      apply: doc => {
        if (!doc) {
          throw new Error(
              `the model's anchor entry was not saved, so its ${kind} ` +
              `cannot be either`);
        }
        add(doc);
        return doc;
      },
      outcome: view => savedOutcome(item, kind, name, view),
    };
  }

  // Updates an existing element in place. The item holds the element as a
  // whole: a value it leaves out is removed, unless the view derives it.
  private _update(item: md.Entry, existing: ViewEntry): Planned {
    const {kind, element} = existing;
    if (kind === 'action' || kind === 'constraint') {
      return `updating semantic-${kind} entries is not supported yet`;
    }
    const displayName = item.resource?.displayName;
    if (displayName !== undefined && displayName !== element) {
      return `resource.displayName '${displayName}' must equal the ${kind}'s ` +
          `name '${element}'; renaming is not supported`;
    }
    const keys = Object.keys(item.aspects ?? {});
    const missing = (UPDATE_ASPECTS[kind] ?? [])
                        .filter(type => !keys.some(k => k.endsWith(`.${type}`)));
    if (missing.length) {
      return `an update holds the whole ${kind}, as kcmd entry get prints ` +
          `it; the ${missing.join(' and ')} aspect is missing`;
    }
    let entry: Entry;
    try {
      entry = toServiceEntry(item, element);
    } catch (err: any) {
      return err?.message ?? String(err);
    }
    const warnings: string[] = [];
    let change: (doc: ModelDocument) => void;
    if (kind === 'model') {
      const targets = readDeploymentTargets(entry, element, [])
                          ?.deployments.map(d => d.target) ?? [];
      const update = {
        description: entry.entrySource?.description,
        instructions: readAiContext(entry)?.instructions,
        targets: sameSet(targets, deploymentTargetsOf(existing.entry)) ?
            undefined :
            targets,
      };
      change = doc => doc.updateModel(update);
    } else if (kind === 'entity') {
      if (this._inheriting.has(element)) {
        return `entity '${element}' uses extends or abstract; updating it ` +
            `is not supported yet`;
      }
      const entity = readEntity(entry, warnings);
      readStringFields(entity, entry);
      change = doc => doc.updateEntity(entity);
    } else if (kind === 'metric') {
      const metric = readMetric(entry, [...this._namesOf('entity')], warnings);
      change = doc => doc.updateMetric(metric);
    } else {
      const problems: string[] = [];
      const rel = readRelationshipEntry(entry, problems);
      if (!rel || problems.length) return problems.join('; ');
      change = doc => doc.updateRelationship(rel);
    }
    return {
      name: item.name,
      apply: doc => {
        if (!doc) throw new Error(`the model file has no ${kind} '${element}'`);
        change(doc);
        return doc;
      },
      outcome: view => savedOutcome(item, kind, element, view),
    };
  }

  private _namesOf(kind: ElementKind): Set<string> {
    let names = this._names.get(kind);
    if (!names) {
      names = new Set();
      this._names.set(kind, names);
    }
    return names;
  }
}


// Applies edits and checks the results.
class Checker {
  private readonly _base: Base;
  private readonly _scope: ModelScope;

  constructor(base: Base, scope: ModelScope) {
    this._base = base;
    this._scope = scope;
  }

  // Applies every edit at once. Returns the edited document, after recording
  // a result for each edit, when the edits add no error and each does what
  // its item asks; otherwise undefined, recording nothing.
  applyAll(edits: Edit[], results: Array<md.EntryResult|undefined>):
      ModelDocument|undefined {
    if (!edits.length) return this._base.doc;
    let doc = this._base.doc?.clone();
    try {
      for (const edit of edits) doc = edit.apply(doc);
    } catch {
      return undefined;
    }
    const checked = this._check(doc!, this._base.errors);
    if (checked.errors.length) return undefined;
    const outcomes = edits.map(edit => edit.outcome(checked.view!));
    const names: string[] = [];
    for (const outcome of outcomes) {
      if ('error' in outcome) return undefined;
      names.push(outcome.name);
    }
    edits.forEach((edit, k) => {
      results[edit.index] = {name: names[k], ok: true};
    });
    return doc;
  }

  // Applies the edits one at a time, each to the result of the edits before
  // it that succeeded, and records a result for each. An edit fails when it
  // adds an error or does not do what its item asks. Returns the last
  // document that succeeded.
  applyEach(edits: Edit[], results: Array<md.EntryResult|undefined>):
      ModelDocument|undefined {
    let accepted = this._base.doc;
    let known = this._base.errors;
    for (const edit of edits) {
      const name = edit.name;
      let trial: ModelDocument;
      try {
        trial = edit.apply(accepted?.clone());
      } catch (err: any) {
        results[edit.index] = {name, ok: false, error: err?.message ?? String(err)};
        continue;
      }
      const checked = this._check(trial, known);
      const outcome = checked.errors.length ?
          {error: checked.errors.join('\n')} :
          edit.outcome(checked.view!);
      if ('error' in outcome) {
        results[edit.index] = {name, ok: false, error: outcome.error};
        continue;
      }
      accepted = trial;
      known = checked.all;
      results[edit.index] = {name: outcome.name, ok: true};
    }
    return accepted;
  }

  // Loads `doc` and runs push's local checks on it. `errors` are the errors
  // not in `known`; `all` are every error; `view` is the entry view, absent
  // when the document does not load.
  private _check(doc: ModelDocument, known: string[]):
      {errors: string[]; all: string[]; view?: ViewEntry[]} {
    const document = this._base.file?.name ?? doc.modelName;
    let model: SemanticModel;
    try {
      model = loadModelFile({name: document, text: doc.render()}, this._scope.project);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      return {errors: [message], all: [message]};
    }
    const all = checkErrors(model, document);
    return {
      errors: all.filter(e => !known.includes(e)),
      all,
      view: modelEntries(model, this._scope),
    };
  }

}


// The bare entry ID of a saved element, or why it does not come back as its
// item sent it.
function savedOutcome(
    item: md.Entry, kind: ElementKind, element: string,
    view: ViewEntry[]): {name: string}|{error: string} {
  const found = view.find(v => v.kind === kind && v.element === element);
  if (!found) {
    return {error: `the ${kind} '${element}' is not in the model after the save`};
  }
  const error = firstDifference(item.type, found.entry.type, 'type') ??
      firstDifference(item.resource ?? {}, found.entry.resource, 'resource') ??
      firstDifference(item.aspects ?? {}, found.entry.aspects ?? {}, 'aspects');
  return error ? {error} : {name: found.entry.name};
}


// The errors `kcmd push --no-profile` gives for the model from its local
// checks: validatePushRequirements as a catalog-only push runs it. The checks
// of named profiles are left to push.
function checkErrors(model: SemanticModel, document: string): string[] {
  const models: LoadedModel[] = [{document, model}];
  const errors: string[] = [];
  errors.push(...validatePushRequirements(models, {
    targetOptional: true,
    fieldsPruned: false,
    warnings: [],
    liftedExclusions: [],
  }));
  return [...new Set(errors)];
}


// Types each field the `schema` aspect gives as STRING with metadataType
// STRING as String. readEntity reads such a field as untyped, as pull does,
// and the view shows an untyped field as Opaque (metadataType OTHER), so the
// field would not come back as sent.
function readStringFields(entity: Entity, entry: Entry): void {
  const records = aspectDataOf(entry.aspects, 'schema').fields;
  if (!Array.isArray(records)) return;
  for (const field of entity.fields) {
    const record = records.find((r: any) => r?.name === field.name);
    if (field.type === undefined && record?.dataType === 'STRING' &&
        record?.metadataType === 'STRING') {
      field.type = 'String';
    }
  }
}


// The deployment targets an anchor entry of the view holds.
function deploymentTargetsOf(anchor: md.Entry): string[] {
  const key = Object.keys(anchor.aspects ?? {})
                  .find(k => k.endsWith('.semantic-model'));
  const targets = key ? anchor.aspects![key].deploymentTargets : undefined;
  return Array.isArray(targets) ? targets.filter(t => typeof t === 'string') :
                                  [];
}


function sameSet(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every(x => right.has(x));
}


// An item as the Dataplex entry the converters read: each aspect keyed and
// typed by its type reference, `resource` as the entry source.
function toServiceEntry(item: md.Entry, name: string): Entry {
  const aspects: Record<string, Aspect> = {};
  for (const [key, data] of Object.entries(item.aspects ?? {})) {
    let aspectType: string;
    try {
      aspectType = dataplex._typeRefToName(key, 'aspect');
    } catch {
      throw new Error(
          `aspect '${key}' is not keyed by an aspect type reference ` +
          `(project.location.type)`);
    }
    aspects[key] = {aspectType, data};
  }
  return {
    name,
    entryType: dataplex._typeRefToName(item.type, 'entry'),
    entrySource: {
      displayName: item.resource?.displayName ?? name,
      ...(item.resource?.description !== undefined ?
              {description: item.resource.description} :
              {}),
    },
    aspects,
  };
}


// Where `saved` does not hold what `sent` holds, as a message naming the
// path, or undefined when it does. A value `sent` leaves out is not compared,
// so a value the view derives may be left out. A list of named records, such
// as a schema's fields, is compared by name: the model file keeps its own
// order.
function firstDifference(sent: unknown, saved: unknown, at: string): string|
    undefined {
  if (sent === undefined) return undefined;
  if (Array.isArray(sent)) {
    if (!Array.isArray(saved)) return differs(at, sent, saved);
    if (namedRecords(sent) && namedRecords(saved)) {
      return namedDifference(sent, saved, at);
    }
    if (saved.length !== sent.length) return differs(at, sent, saved);
    for (let i = 0; i < sent.length; i++) {
      const d = firstDifference(sent[i], saved[i], `${at}[${i}]`);
      if (d) return d;
    }
    return undefined;
  }
  if (sent !== null && typeof sent === 'object') {
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
      return differs(at, sent, saved);
    }
    for (const [key, value] of Object.entries(sent)) {
      const d = firstDifference(
          value, (saved as Record<string, unknown>)[key], `${at}.${key}`);
      if (d) return d;
    }
    return undefined;
  }
  return sent === saved ? undefined : differs(at, sent, saved);
}


// Whether every item is a record with a string `name`.
function namedRecords(list: any[]): boolean {
  return list.length > 0 && list.every(r => typeof r?.name === 'string');
}


// firstDifference for two lists of named records, matched by name.
function namedDifference(sent: any[], saved: any[], at: string): string|
    undefined {
  const seen = new Set<string>();
  for (const record of sent) {
    if (seen.has(record.name)) return `${at}: '${record.name}' appears twice`;
    seen.add(record.name);
  }
  const byName = new Map(saved.map(r => [r.name, r]));
  for (const [i, record] of sent.entries()) {
    const d = firstDifference(record, byName.get(record.name), `${at}[${i}]`);
    if (d) return d;
  }
  const extra = saved.map(r => r.name).filter(n => !seen.has(n));
  return extra.length ?
      `${at}: ${extra.map(n => `'${n}'`).join(', ')} would be saved too` :
      undefined;
}


function differs(at: string, sent: unknown, saved: unknown): string {
  return `${at}: ${shown(sent)} would be saved as ${
      saved === undefined ? 'nothing' : shown(saved)}`;
}


// A value as JSON, cut short when long.
function shown(value: unknown): string {
  const json = JSON.stringify(value);
  return json.length > 120 ? `${json.slice(0, 117)}...` : json;
}
