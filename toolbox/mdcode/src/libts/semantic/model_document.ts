// A model file as an editable YAML document. Edits change the document's
// nodes, so every comment survives, and text() keeps the formatting of every
// line an edit did not change (see text_merge.ts).
//

import {isDeepStrictEqual} from 'node:util';
import * as yaml from 'yaml';

import {AiContext, DataType, DeploymentSpec, Entity, Field, Metric, normalizeDataType, Relationship} from './ir';
import {GOOGLE_VERSION, OSSIE_VERSION} from './loader';
import {aiContextDoc, datasetDoc, fieldDoc, metricDoc, relationshipDoc} from './osi_converter';
import {mergeFormatting} from './text_merge';
import {YAML_OPTIONS} from './yaml_options';

// How a model document is rendered: no padding inside flow collections and no
// folded lines, as kcmd's compact serializer writes them.
const RENDER_OPTIONS = {flowCollectionPadding: false, lineWidth: 0} as const;

// A scalar list at most this wide is written in flow style, as in
// `primary_key: [id]`.
const FLOW_WIDTH = 80;

// The model-level keys of a new model file.
export interface ModelAnchor {
  name: string;
  description?: string;
  aiContext?: AiContext;
  deployments?: DeploymentSpec[];
}

// The lists of a model that hold its elements.
export type ElementList = 'entities'|'metrics'|'relationships';

// The keys of a model that an anchor entry holds. `targets` is undefined when
// the deployment targets do not change.
export interface AnchorUpdate {
  description?: string;
  instructions?: string;
  targets?: string[];
}

// The dialect whose expression the view shows, and the one it falls back to.
const CANONICAL_DIALECTS = ['BIGQUERY', 'ANSI_SQL'];


export class ModelDocument {
  private readonly _doc: yaml.Document;
  // The file as written and as rendered unedited, when the document was
  // parsed from one.
  private readonly _source?: {text: string; rendered: string};

  private constructor(
      doc: yaml.Document, source?: {text: string; rendered: string}) {
    this._doc = doc;
    this._source = source;
  }

  // Parses a model file. Throws when it is not valid YAML or does not hold
  // exactly one model.
  static parse(text: string): ModelDocument {
    const doc = yaml.parseDocument(text, YAML_OPTIONS);
    if (doc.errors.length) {
      throw new Error(
          `the model file is not valid YAML: ${doc.errors[0].message}`);
    }
    modelNodeOf(doc);
    return new ModelDocument(
        doc, {text, rendered: doc.toString(RENDER_OPTIONS)});
  }

  // A new Google-flavor model file holding one model with no entities yet.
  static create(anchor: ModelAnchor): ModelDocument {
    const model = compact({
      name: anchor.name,
      description: anchor.description,
      ai_context: aiContextDoc(anchor.aiContext, true),
      deployments: anchor.deployments?.length ?
          anchor.deployments.map(d => compact({
                                   name: d.name,
                                   target: d.target,
                                   profile: d.profile,
                                 })) :
          undefined,
      entities: [],
    });
    const doc =
        new yaml.Document({version: GOOGLE_VERSION, semantic_model: [model]});
    // Quoted, as the guides write it.
    const version = doc.get('version', true);
    if (yaml.isScalar(version)) version.type = yaml.Scalar.QUOTE_DOUBLE;
    flowShortLists(doc.contents);
    return new ModelDocument(doc);
  }

  clone(): ModelDocument {
    return new ModelDocument(
        this._doc.clone(), this._source && {...this._source});
  }

  // The document rendered by the YAML library.
  render(): string {
    return this._doc.toString(RENDER_OPTIONS);
  }

  // The document as file text: the rendering, with every line no edit changed
  // as the file wrote it.
  text(): string {
    const edited = this.render();
    if (!this._source) return edited;
    const merged =
        mergeFormatting(this._source.text, this._source.rendered, edited);
    // The merge only moves formatting; check that it kept every value.
    return merged === edited || sameValues(merged, edited) ? merged : edited;
  }

  get isGoogleVersion(): boolean {
    return this._doc.get('version') === GOOGLE_VERSION;
  }

  get modelName(): string {
    return String(this._modelNode().get('name') ?? '');
  }

  // Whether the model has an element of this name in the list.
  has(list: ElementList, name: string): boolean {
    return this._items(list).some(item => item.get('name') === name);
  }

  // New fields and metrics write their expressions in the form the file uses
  // most: a string, or a list of dialects.
  addEntity(entity: Entity): void {
    const styled = {...entity, fields: entity.fields.map(f => this._styled(f))};
    this._append(
        this._entitiesKey(), datasetDoc(styled, [], true, this._version));
  }

  addMetric(metric: Metric): void {
    this._append(
        'metrics', metricDoc(this._styled(metric), [], this._version));
  }

  addRelationship(rel: Relationship): void {
    this._append('relationships', relationshipDoc(rel, [], this._version));
  }

  // Removes an element. An empty entity list stays, as `entities: []`; an
  // empty metric or relationship list is removed.
  remove(list: ElementList, name: string): void {
    const key = list === 'entities' ? this._entitiesKey() : list;
    const model = this._modelNode();
    const seq: unknown = model.get(key, true);
    if (!yaml.isSeq(seq)) return;
    seq.items = seq.items.filter(
        item => !(yaml.isMap(item) && item.get('name') === name));
    if (seq.items.length) return;
    if (list === 'entities') {
      seq.flow = true;
    } else {
      model.delete(key);
    }
  }

  // Whether the entity declares `extends` or `abstract`.
  usesInheritance(name: string): boolean {
    const node = this._find('entities', name);
    return !!node && (node.has('extends') || node.has('abstract'));
  }

  // The updates below write only the keys whose value changes, and leave
  // every key an entry does not hold as it is: `extends`, `abstract`,
  // ai_context synonyms and examples (but a relationship's synonyms), a
  // field's ai_context and is_time, custom_extensions, and the expressions in
  // other dialects.

  // Updates the model's description, ai_context instructions and deployment
  // targets. A deployment whose target stays keeps its name and profile.
  updateModel(update: AnchorUpdate): void {
    const node = this._modelNode();
    this._setValue(node, 'description', update.description);
    this._setAiContext(node, {instructions: update.instructions});
    if (update.targets) this._setTargets(node, update.targets);
  }

  // Updates an entity, matching its fields by name: a field the entity no
  // longer has is removed, and a new one is added at the end.
  updateEntity(entity: Entity): void {
    const node = this._element('entities', entity.name);
    this._setValue(
        node, 'source', entity.authoredSource ?? (entity.dataSource || undefined));
    this._setValue(
        node, 'primary_key', entity.keys.length ? entity.keys : undefined);
    this._setValue(
        node, 'unique_keys',
        entity.uniqueKeys?.length ? entity.uniqueKeys : undefined);
    this._setValue(node, 'description', entity.description);
    this._setAiContext(node, {instructions: entity.aiContext?.instructions});
    this._setFields(node, entity.fields);
  }

  updateMetric(metric: Metric): void {
    const node = this._element('metrics', metric.name);
    this._setExpression(node, metric.expression);
    this._setDataType(node, metric.type);
    this._setValue(node, 'description', metric.description);
    this._setAiContext(node, {instructions: metric.aiContext?.instructions});
  }

  updateRelationship(rel: Relationship): void {
    const node = this._element('relationships', rel.name);
    this._setValue(node, 'from', rel.source.entity);
    this._setValue(node, 'to', rel.destination.entity);
    this._setValue(
        node, 'from_columns',
        rel.source.columns.length ? rel.source.columns : undefined);
    this._setValue(
        node, 'to_columns',
        rel.destination.columns.length ? rel.destination.columns : undefined);
    this._setValue(node, 'description', rel.description);
    this._setAiContext(
        node,
        {
          instructions: rel.aiContext?.instructions,
          synonyms: rel.aiContext?.synonyms ?? [],
        });
  }

  // `item` marked to write its expression as a string when the file writes
  // more expressions that way than as dialect lists. A vanilla file has no
  // string form.
  private _styled<T extends Field|Metric>(item: T): T {
    if (!this.isGoogleVersion || item.expression === undefined) return item;
    let strings = 0;
    let lists = 0;
    yaml.visit(this._doc, {
      Map(_, map) {
        if (map.has('dialect')) return;
        const expression = map.get('expression', true);
        if (yaml.isScalar(expression)) strings++;
        if (yaml.isMap(expression)) lists++;
      },
    });
    return strings > lists ? {...item, stringForm: true} : item;
  }

  private _find(list: ElementList, name: string): yaml.YAMLMap|undefined {
    return this._items(list).find(item => item.get('name') === name);
  }

  private _element(list: ElementList, name: string): yaml.YAMLMap {
    const node = this._find(list, name);
    if (!node) throw new Error(`the model file has no ${list} entry '${name}'`);
    return node;
  }

  private get _version(): typeof OSSIE_VERSION|typeof GOOGLE_VERSION {
    return this.isGoogleVersion ? GOOGLE_VERSION : OSSIE_VERSION;
  }

  // Sets `key` to `value`, or removes it when `value` is undefined, unless it
  // already holds that value. A scalar keeps its quoting.
  private _setValue(node: yaml.YAMLMap, key: string, value: unknown): void {
    if (value === undefined) {
      node.delete(key);
      return;
    }
    const current: unknown = node.get(key, true);
    if (isDeepStrictEqual(jsOf(current), value)) return;
    if (yaml.isScalar(current) && (value === null || typeof value !== 'object')) {
      current.value = value;
      return;
    }
    const created = this._doc.createNode(value);
    flowShortLists(created);
    node.set(key, created);
  }

  // Sets the ai_context members given: `instructions` always, `synonyms` when
  // present. The string form of ai_context holds instructions alone, so it
  // becomes a mapping only when synonyms are added.
  private _setAiContext(
      node: yaml.YAMLMap, values: {instructions?: string; synonyms?: string[]}):
      void {
    const instructions = values.instructions || undefined;
    const synonyms = values.synonyms?.length ? values.synonyms : undefined;
    const ai: unknown = node.get('ai_context', true);
    if (yaml.isScalar(ai) && !synonyms) {
      if (instructions === undefined) {
        node.delete('ai_context');
      } else if (ai.value !== instructions) {
        ai.value = instructions;
      }
      return;
    }
    if (!yaml.isMap(ai)) {
      const created = compact({instructions, synonyms});
      if (Object.keys(created).length) {
        this._setValue(node, 'ai_context', created);
      } else if (!yaml.isScalar(ai)) {
        node.delete('ai_context');
      }
      return;
    }
    this._setValue(ai, 'instructions', instructions);
    if (values.synonyms !== undefined) {
      const current = jsOf(ai.get('synonyms', true));
      const same = Array.isArray(current) &&
          isDeepStrictEqual([...new Set(current)], synonyms ?? []);
      if (!same) this._setValue(ai, 'synonyms', synonyms);
    }
    if (!ai.items.length) node.delete('ai_context');
  }

  // Sets the expression the view shows: the BIGQUERY entry of `dialects`,
  // else the ANSI_SQL one, else a new BIGQUERY entry; the other entries stay.
  // An expression written as a string is replaced as a string. With no text,
  // only that entry is removed.
  private _setExpression(node: yaml.YAMLMap, text: string|undefined): void {
    const expression: unknown = node.get('expression', true);
    if (yaml.isScalar(expression)) {
      if (text === undefined) {
        node.delete('expression');
      } else if (expression.value !== text) {
        expression.value = text;
      }
      return;
    }
    const dialects =
        yaml.isMap(expression) ? expression.get('dialects', true) : undefined;
    if (!yaml.isSeq(dialects)) {
      if (text !== undefined) {
        this._setValue(
            node, 'expression', {dialects: [{dialect: 'BIGQUERY', expression: text}]});
      }
      return;
    }
    const entries = dialects.items.filter(yaml.isMap) as yaml.YAMLMap[];
    const canonical = CANONICAL_DIALECTS.map(
                          d => entries.find(e => e.get('dialect') === d))
                          .find(e => e !== undefined);
    if (text === undefined) {
      if (!canonical) return;
      dialects.items.splice(dialects.items.indexOf(canonical), 1);
      if (!dialects.items.length) node.delete('expression');
      return;
    }
    if (canonical) {
      this._setValue(canonical, 'expression', text);
    } else {
      dialects.items.push(
          this._doc.createNode({dialect: 'BIGQUERY', expression: text}));
    }
  }

  // Sets `datatype`, unless it already names the type in another spelling.
  private _setDataType(node: yaml.YAMLMap, type: DataType|undefined): void {
    const wanted = type === 'Opaque' ? undefined : type;
    const raw = node.get('datatype');
    const current = typeof raw === 'string' ?
        normalizeDataType(raw, this._version) :
        {ok: true as const, type: undefined};
    if (current.ok && current.type === wanted && (raw === undefined) === (wanted === undefined)) {
      return;
    }
    this._setValue(node, 'datatype', wanted);
  }

  private _setFields(entity: yaml.YAMLMap, fields: Field[]): void {
    let list: unknown = entity.get('fields', true);
    if (!yaml.isSeq(list)) {
      if (!fields.length) return;
      list = this._doc.createNode([]);
      entity.set('fields', list);
    }
    if (!yaml.isSeq(list)) return;
    const wanted = new Map(fields.map(f => [f.name, f]));
    list.items = list.items.filter(
        item => !yaml.isMap(item) || wanted.has(String(item.get('name'))));
    const present = new Set<string>();
    for (const item of list.items) {
      if (!yaml.isMap(item)) continue;
      const name = String(item.get('name'));
      present.add(name);
      this._updateField(item, wanted.get(name)!);
    }
    for (const field of fields) {
      if (present.has(field.name)) continue;
      if (!list.items.length) list.flow = false;
      const node = this._doc.createNode(
          fieldDoc(this._styled(field), [], true, this.isGoogleVersion));
      flowShortLists(node);
      list.items.push(node);
    }
    if (!list.items.length) entity.delete('fields');
  }

  // A field's `dimension` marks it a dimension; an existing one is kept, with
  // its is_time.
  private _updateField(node: yaml.YAMLMap, field: Field): void {
    this._setExpression(node, field.expression);
    this._setDataType(node, field.type);
    this._setValue(node, 'label', field.label);
    this._setValue(node, 'description', field.description);
    if (!field.dimension) {
      node.delete('dimension');
    } else if (!node.has('dimension')) {
      node.set('dimension', this._doc.createNode({}));
    }
  }

  // Sets the deployments to one per target: one whose target stays is kept
  // as it is, and a new target gets a deployment named `default`, or
  // `deployment_<n>` when that name is taken. A vanilla model keeps its
  // targets in a GOOGLE block, which this does not edit.
  private _setTargets(model: yaml.YAMLMap, targets: string[]): void {
    if (!this.isGoogleVersion) {
      throw new Error(
          `the deployment targets of a ${OSSIE_VERSION} model are in its ` +
          `GOOGLE block; edit the model file to change them`);
    }
    const seq: unknown = model.get('deployments', true);
    const items =
        yaml.isSeq(seq) ? seq.items.filter(yaml.isMap) as yaml.YAMLMap[] : [];
    const kept = items.filter(i => targets.includes(String(i.get('target'))));
    const names = new Set(kept.map(i => String(i.get('name'))));
    const keptTargets = new Set(kept.map(i => String(i.get('target'))));
    const added = targets.filter(t => !keptTargets.has(t)).map(target => {
      let name = 'default';
      for (let n = 1; names.has(name); n++) name = `deployment_${n}`;
      names.add(name);
      return this._doc.createNode({name, target});
    });
    if (!kept.length && !added.length) {
      model.delete('deployments');
      return;
    }
    if (yaml.isSeq(seq)) {
      seq.items = [...kept, ...added];
    } else {
      const created = this._doc.createNode([]) as yaml.YAMLSeq;
      created.items = added;
      model.set('deployments', created);
    }
  }

  private _modelNode(): yaml.YAMLMap {
    return modelNodeOf(this._doc);
  }

  // The key of the entity list: the one the file uses, else `entities` in a
  // Google-flavor file and `datasets` in a vanilla one.
  private _entitiesKey(): string {
    const model = this._modelNode();
    if (model.has('entities')) return 'entities';
    if (model.has('datasets')) return 'datasets';
    return this.isGoogleVersion ? 'entities' : 'datasets';
  }

  private _items(list: ElementList): yaml.YAMLMap[] {
    const key = list === 'entities' ? this._entitiesKey() : list;
    const seq = this._modelNode().get(key);
    return yaml.isSeq(seq) ? seq.items.filter(yaml.isMap) as yaml.YAMLMap[] :
                             [];
  }

  // Appends `value` to the model's list `key`, creating the list if needed.
  // An empty flow list (`entities: []`) becomes a block list.
  private _append(key: string, value: Record<string, unknown>): void {
    const model = this._modelNode();
    let seq = model.get(key);
    if (!yaml.isSeq(seq)) {
      seq = this._doc.createNode([]);
      model.set(key, seq);
    }
    const list = seq as yaml.YAMLSeq;
    if (!list.items.length) list.flow = false;
    const node = this._doc.createNode(value);
    flowShortLists(node);
    list.items.push(node);
  }
}


// The one model a model document holds. Throws when it holds another number.
function modelNodeOf(doc: yaml.Document): yaml.YAMLMap {
  const models = doc.get('semantic_model');
  if (!yaml.isSeq(models) || models.items.length !== 1 ||
      !yaml.isMap(models.items[0])) {
    throw new Error('the model file must hold exactly one model');
  }
  return models.items[0] as yaml.YAMLMap;
}


// Writes each short list of scalars under `node` in flow style.
function flowShortLists(node: unknown): void {
  yaml.visit(node as yaml.Node, {
    Seq(_, seq) {
      if (!seq.items.length || !seq.items.every(i => yaml.isScalar(i))) return;
      const width = seq.items.reduce(
          (n, i) => n + String((i as yaml.Scalar).value ?? '').length + 2, 2);
      if (width <= FLOW_WIDTH) seq.flow = true;
    },
  });
}


// The value a node holds, as plain data.
function jsOf(node: unknown): unknown {
  return yaml.isNode(node) ? node.toJSON() : node;
}


// Whether two YAML texts hold the same values.
function sameValues(a: string, b: string): boolean {
  try {
    return JSON.stringify(yaml.parse(a, YAML_OPTIONS)) ===
        JSON.stringify(yaml.parse(b, YAML_OPTIONS));
  } catch {
    return false;
  }
}


function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
