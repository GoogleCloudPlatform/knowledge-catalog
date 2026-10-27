// OSI (open, AI-first semantics) <-> Semantic Model IR converter.
//
// SCAFFOLD (naming for the end state): this file currently holds only the
// WRITE direction -- IR -> OSI YAML (`serializeModel`). The READ direction
// (OSI YAML -> IR) still lives in `loader.ts` and moves here once PR4 (the
// KC push line) merges, at which point this becomes the full two-way
// converter. Until then, "where is the OSI parser?" -> `loader.ts`.
//
// TODO(#278): fold the OSI READ direction in and drop the scaffold. Once
// #278 merges, move `loadModels` / `fromDocument` / `loadSemanticModels`
// (and their Load* types) out of `loader.ts` into this file, delete
// `loader.ts`, and repoint its importers (`src/tool/commands.ts` and the
// load / validate / bigquery tests). Then this is the sole OSI<->IR codec
// and the SCAFFOLD note above comes out.
//
// Serializing is the inverse of `loader.ts`: `loader` reads authored YAML
// into the IR; this module writes the IR out as a YAML document the loader
// can read back. It is the local-workspace sink for `pull` (Knowledge
// Catalog -> IR -> YAML), the counterpart to how `push` compiles YAML -> IR
// -> a destination.
//
// Fidelity is at the IR level, not byte-for-byte with a hand-authored file. The
// loader keeps every entry in `dialects` and records `stringForm`, and also
// picks a target/canonical `expression` + an `importedExpression` via
// `pickDialect`:
//   * this serializer writes `dialects` back out when present (or short-form
//     bare strings in GOOGLE_VERSION when `stringForm` is true), and falls back
//     to `expression` and `importedExpression` when `dialects` is absent.
//   * comments and key ordering are not preserved.
// What the loader DOES keep on the IR round-trips here: names, descriptions,
// `ai_context` (instructions / synonyms / examples / custom properties), keys
// and unique keys, data sources, field datatypes (omitting `Opaque`) / labels /
// dimension flags, expressions, relationship join columns, and
// `custom_extensions`. Output format follows `model.version` via
// `FORMAT_VERSION_PLACEMENT`: GOOGLE_VERSION ('0.2.0.dev0/google' or unset)
// writes native extension keys and one `<model>.profile.<name>.yaml` sidecar
// file per profile, whereas OSSIE_VERSION ('0.2.0.dev0') writes strict Ossie
// keys, encodes `profiles`, `deployments`, `extends`, relationship
// `description`, and metric `authoredEntity` in `GOOGLE` `custom_extensions`
// blocks, and writes no profile files.
//
// An `association` (junction-table) relationship has no open-format syntax (the
// loader cannot produce one), so only its direct foreign-key view (from/to +
// columns) is serialized; the junction detail is dropped with a note.

import * as yaml from 'yaml';

import {googleBlockTargets, unnamedDeployments} from './deployment_target';
import {Action, ActionParameter, AffectedConcept, AiContext, ALLOWED_DIALECTS, Constraint, CustomExtension, Entity, Executor, Field, Metric, ProfileSpec, Relationship, SemanticModel, SqlDialect} from './ir';
import {FORMAT_VERSION_PLACEMENT, FormatVersion, GOOGLE_VERSION, OSSIE_VERSION, writtenSource} from './loader';
import {nameProblem} from './names';
import {declaredConceptFields} from './resolve_inheritance';
import {DEFAULT_PROFILE} from './resolve_profiles';

// The vendor tag for Google-specific extension blocks on the IR (kept in sync
// with loader.GOOGLE_VENDOR). In the Google flavor, a model-level deployment
// target list rides in one as a folded shim alongside `model.deployments`.
const GOOGLE_VENDOR = 'GOOGLE';

// The dialect label for the IR's target/canonical `expression` when `dialects`
// is absent and `stringForm` is not set. BIGQUERY is the loader's default
// target dialect, so labeling the canonical form BIGQUERY makes the loader
// re-pick it exactly on reload.
const CANONICAL_DIALECT = 'BIGQUERY';

// Only dialect labels the loader accepts are ever written out.
const ALLOWED_DIALECT_SET: ReadonlySet<string> = new Set(ALLOWED_DIALECTS);

export interface SerializedFile {
  fileName: string;
  content: string;
}

export interface SerializeFilesResult {
  files: SerializedFile[];
  warnings: string[];
}

export interface SerializeResult {
  yaml: string;
  warnings: string[];
}

export interface SerializeOptions {
  logical?: boolean;
  compactFlow?: boolean;
}

/**
 * Serializes a semantic model and its sidecar profile files. The returned
 * `files` list always starts with `<model.name>.yaml`. Under `GOOGLE_VERSION`,
 * each entry in `model.profiles` follows as
 * `<model.name>.profile.<profile.name>.yaml`, except that a reserved
 * (`default`), invalid, or case-insensitively repeated name is skipped with a
 * warning. Under `OSSIE_VERSION`, valid profiles are written into the model's
 * `GOOGLE` `custom_extensions` block and no profile files are emitted.
 */
export function serializeModelFiles(
    model: SemanticModel, opts: SerializeOptions = {}): SerializeFilesResult {
  const warnings: string[] = [];
  const version = formatVersionOf(model);
  const document = modelDocument(model, warnings, opts.logical);
  const files: SerializedFile[] = [
    {fileName: `${model.name}.yaml`, content: render(document, opts)},
  ];

  if (FORMAT_VERSION_PLACEMENT[version].model.profiles === 'file') {
    for (const {name, doc} of profileDocuments(model, warnings)) {
      files.push({
        fileName: `${model.name}.profile.${name}.yaml`,
        content: render(doc, opts),
      });
    }
  }

  return {files, warnings: [...new Set(warnings)]};
}

/**
 * Returns the format version to serialize `model` as (`model.version`,
 * defaulting to `GOOGLE_VERSION` when unset).
 */
function formatVersionOf(model: SemanticModel): FormatVersion {
  return model.version === OSSIE_VERSION ? OSSIE_VERSION : GOOGLE_VERSION;
}

// A profile file's top-level mapping, as `profileDocument` writes it and
// `profileSpecOf` reads it.
type ProfileDoc = Record<string, any>;

/**
 * Validates `model.profiles` and returns the serialized `profileDocument`
 * mapping for each valid profile.
 *
 * Reserved (`default`), invalid, and case-insensitively repeated names are
 * skipped with a warning, keeping the first spelling, so the output satisfies
 * the same name rules the profile-file layout and `readBlockProfiles` enforce
 * on load.
 */
function profileDocuments(model: SemanticModel, warnings: string[]):
    Array<{name: string; doc: ProfileDoc}> {
  const seen = new Map<string, string>();
  const out: Array<{name: string; doc: ProfileDoc}> = [];
  for (const profile of model.profiles ?? []) {
    const lower = profile.name.toLowerCase();
    if (lower === DEFAULT_PROFILE) {
      warnings.push(
          `model '${model.name}': profile '${profile.name}' uses the name ` +
          `reserved for the model's inline bindings and is not serialized`);
      continue;
    }
    if (nameProblem('profile', profile.name)) {
      warnings.push(
          `model '${model.name}': profile '${profile.name}' is not a valid ` +
          `profile name and is not serialized`);
      continue;
    }
    const first = seen.get(lower);
    if (first !== undefined) {
      // Only a case-only repeat needs the ignoring-case rule explained.
      const repeat = first === profile.name ?
          `profile '${first}' is listed more than once` :
          `profiles '${first}' and '${profile.name}' name the same ` +
              `profile (profile names are unique ignoring case)`;
      warnings.push(
          `model '${model.name}': ${repeat}; only '${first}' is serialized`);
      continue;
    }
    seen.set(lower, profile.name);
    out.push({
      name: profile.name,
      doc: profileDocument(profile, warnings),
    });
  }
  return out;
}

/**
 * Serializes a single semantic model to a YAML document string in the open
 * AI-first semantics format. The document contains exactly this one model;
 * `pull` writes one file per model
 * (catalog/EntryGroups/<entryGroup>/<model>.yaml). It is the first file
 * `serializeModelFiles` returns, with the warnings for every file it builds.
 *
 * Warnings flag IR content that has no loadable representation (an association
 * relationship's junction detail, an imported expression in an unknown dialect,
 * dropped `GOOGLE` blocks under GOOGLE_VERSION, Google-only constructs and
 * missing join columns under OSSIE_VERSION, or loader-invalid gaps), so the
 * caller can surface the lossy edge.
 *
 * `logical` marks the model as a purely logical one (no physical binding).
 * Under GOOGLE_VERSION it suppresses the missing-source and missing-expression
 * warnings, which flag a lossy pull of a bound model. OSSIE_VERSION requires
 * both, so they are still given. An OWL import sets it, and so does a
 * second-generation pull, which loses no binding.
 *
 * `compactFlow` renders leaf collections (scalar sequences, all-scalar maps) in
 * flow style so the output matches the compact convention the semantic-model
 * guides author by hand and is byte-for-byte reproducible there. An OWL import
 * sets it; `pull` does not.
 */
export function serializeModel(
    model: SemanticModel, opts: SerializeOptions = {}): SerializeResult {
  const {files, warnings} = serializeModelFiles(model, opts);
  return {yaml: files[0].content, warnings};
}

// Renders one document as YAML. `aliasDuplicateObjects: false` writes an IR
// array that two keys share (an entity's key reused as a relationship's
// `to_columns`, say) out in full at each key, rather than as an `&a1` anchor
// and `*a1` alias, so editing one binding never silently edits another.
// `compat: 'yaml-1.1'` quotes strings that a YAML 1.1 parser (PyYAML,
// ruamel's 1.1 mode) would read as booleans or dates (`'yes'`, `'on'`,
// `'2001-12-14'`), so arbitrary values in `custom_extensions` or `ai_context`
// round-trip across tools.
function render(doc: Record<string, any>, opts: SerializeOptions): string {
  return opts.compactFlow ?
      renderCompact(doc) :
      yaml.stringify(doc, {aliasDuplicateObjects: false, compat: 'yaml-1.1'});
}

// Renders "leaf" collections in flow style so the output matches the compact
// convention the semantic-model guides author by hand: a sequence whose items
// are all scalars (`primary_key: [id]`, `from_columns: [fk]`) and a map whose
// values are all scalars (an inline field `{name, datatype}` or a column-less
// relationship `{name, from, to}`). Nested structures -- a dataset, an
// expression's `dialects`, an `ai_context` -- always stay block.
//
// A leaf collection is inlined ONLY while it stays short: a map or sequence
// whose flow form would exceed FLOW_WIDTH_BUDGET (a field carrying a long
// `description`, say) is left block, so `--compact` never emits an unreadable
// multi-hundred-character line. `lineWidth: 0` disables the wrapper so an
// inlined collection is never broken mid-braces -- the width gate, not the
// wrapper, is what bounds line length. Flow and block parse identically, so
// this only affects layout.
const FLOW_WIDTH_BUDGET = 80;

// The rendered width of a scalar node (its stringified value length); 0 for a
// non-scalar, which never contributes because a collection holding one is not
// inlined in the first place.
function scalarWidth(node: unknown): number {
  return yaml.isScalar(node) ?
      String((node as yaml.Scalar).value ?? '').length :
      0;
}

function renderCompact(document: Record<string, any>): string {
  const doc = new yaml.Document(
      document, {aliasDuplicateObjects: false, compat: 'yaml-1.1'});
  yaml.visit(doc, {
    Seq(_, node) {
      if (!node.items.every(item => yaml.isScalar(item))) return;
      // `[` + each `item, ` + `]`, approximated for the width gate.
      const width =
          node.items.reduce((n, item) => n + scalarWidth(item) + 2, 2);
      if (width <= FLOW_WIDTH_BUDGET) node.flow = true;
    },
    Map(_, node) {
      // The document's own mapping stays block, as a hand-written file has it.
      if (node === doc.contents) return;
      const pairs = node.items as yaml.Pair[];
      if (!pairs.every(pair => yaml.isScalar(pair.value))) return;
      // `{` + each `key: value, ` + `}`, approximated for the width gate.
      const width = pairs.reduce(
          (n, pair) => n + scalarWidth(pair.key) + scalarWidth(pair.value) + 4,
          2);
      if (width <= FLOW_WIDTH_BUDGET) node.flow = true;
    },
  });
  return doc.toString({flowCollectionPadding: false, lineWidth: 0});
}

// Builds the plain document object (version + one model) that yaml.stringify
// renders. Kept separate so tests can assert the structure without parsing
// YAML.
export function modelDocument(
    model: SemanticModel, warnings: string[] = [],
    logical = false): Record<string, any> {
  const version = formatVersionOf(model);
  return {
    version,
    semantic_model: [modelDoc(model, warnings, logical, version)],
  };
}

// Builds a sidecar profile document matching the schema `loadProfileFile` in
// `resolve_profiles.ts` reads: a top-level mapping with no `version` or
// `semantic_model` wrapper. Optional lists (`primary_key`, `unique_keys`,
// `fields`, `fields_exclude`, `metrics_exclude`, `actions`) are written
// whenever defined, even when empty, so a ProfileSpec that loadProfileFile read
// comes back the same from this file.
function profileDocument(profile: ProfileSpec, warnings: string[]): ProfileDoc {
  return compact({
    name: profile.name,
    entities: nonEmpty(profile.entities.map(
        pe => compact({
          name: pe.name,
          source: pe.source,
          primary_key: pe.primaryKey,
          unique_keys: pe.uniqueKeys,
          fields: pe.fields?.map(pf => {
            const where = `profile '${profile.name}': entity '${
                pe.name}': field '${pf.name}'`;
            const expression =
                expressionDoc(pf, /* isGoogleVersion= */ true, where, warnings);
            // loadProfileFile rejects an entry with nothing to bind, and
            // (like a model load) any blank SQL text.
            const texts = typeof expression === 'string' ?
                [expression] :
                (expression?.dialects ?? []).map(d => d.expression);
            if (expression === undefined) {
              warnings.push(
                  `${where}: no expression; the profile file will not load ` +
                  `until it is set or the field is listed in ` +
                  `'fields_exclude'.`);
            } else if (texts.some(t => t.trim() === '')) {
              warnings.push(
                  `${where}: expression is blank; the profile file will not ` +
                  `load until its SQL is written.`);
            }
            return compact({name: pf.name, expression});
          }),
          fields_exclude: pe.fieldsExclude,
        }))),
    relationships: nonEmpty(
        profile.relationships.map(pr => compact({
                                    name: pr.name,
                                    from_columns: nonEmpty(pr.fromColumns),
                                    to_columns: nonEmpty(pr.toColumns),
                                  }))),
    metrics_exclude: profile.metricsExclude,
    actions: profile.actions?.map(
        pa => compact({
          name: pa.name,
          executor: pa.executor === null ?
              null :
              (pa.executor ? executorDoc(pa.executor) : undefined),
        })),
  });
}

function modelDoc(
    model: SemanticModel, warnings: string[], logical: boolean,
    version: FormatVersion): Record<string, any> {
  const isGoogleVersion = version === GOOGLE_VERSION;
  const placement = FORMAT_VERSION_PLACEMENT[version];
  // `datasets` is required (min 1) by the loader. A reconstructed model with no
  // entities (e.g. every entity fetch failed during a pull) would serialize to
  // a document the loader rejects; emit the (empty) array but flag it so the
  // lossy edge is visible rather than surfacing later as an opaque load error.
  const datasets = (model.entities ??
                    []).map(e => datasetDoc(e, warnings, logical, version));
  if (!datasets.length) {
    warnings.push(
        `model '${
            model.name}': no datasets (entities); the document requires ` +
        `at least one and will not load until an entity is present.`);
  }
  const tableKey = isGoogleVersion ? 'entities' : 'datasets';
  // Under GOOGLE_VERSION, deployments come from `model.deployments`, or from a
  // GOOGLE `deploymentTargets` block when that is empty. Under OSSIE_VERSION,
  // named deployments and profiles go in a GOOGLE block on the model.
  const namedDeployments = (model.deployments ?? []).map(d => compact({
                                                           name: d.name,
                                                           target: d.target,
                                                           profile: d.profile
                                                         }));
  const deployments = placement.model.deployments === 'native' ?
      nonEmpty(
          namedDeployments.length ? namedDeployments :
                                    deploymentsFromGoogleExtensions(model)) :
      undefined;
  const blockProfiles = placement.model.profiles === 'block' ?
      nonEmpty(profileDocuments(model, warnings).map(p => p.doc)) :
      undefined;
  const blockDeployments = placement.model.deployments === 'block' ?
      nonEmpty(namedDeployments) :
      undefined;
  const blockPayload = compact({
    profiles: blockProfiles,
    deployments: blockDeployments,
  });

  if (!isGoogleVersion) warnGoogleOnlyContent(model, warnings);
  const emittedFields =
      placement.model.actions === 'native' && model.actions?.length ?
      emitted(model) :
      null;
  return compact({
    name: model.name,
    description: model.description,
    ai_context: aiContextDoc(model.aiContext, isGoogleVersion),
    deployments,
    [tableKey]: datasets,
    relationships:
        nonEmpty((model.relationships ??
                  []).map(r => relationshipDoc(r, warnings, version))),
    metrics: nonEmpty(
        (model.metrics ?? []).map(m => metricDoc(m, warnings, version))),
    // Hoisted out of the map: `emitted` resolves inheritance, which deep-clones
    // the model, and the answer does not vary by action.
    actions: placement.model.actions === 'native' ?
        nonEmpty((model.actions ??
                  []).map(a => actionDoc(a, warnings, emittedFields))) :
        undefined,
    constraints: placement.model.constraints === 'native' ?
        nonEmpty((model.constraints ?? []).map(c => constraintDoc(c))) :
        undefined,
    custom_extensions: customExtensionsDoc(
        model.customExtensions, `model '${model.name}'`, isGoogleVersion,
        /* isModel= */ true, warnings, /* isField= */ false, blockPayload),
  });
}

// Warns about each IR construct OSSIE_VERSION has no representation for,
// natively or in a GOOGLE block, so a '0.2.0.dev0' write flags dropped
// content just as a GOOGLE_VERSION write flags a dropped GOOGLE block.
function warnGoogleOnlyContent(model: SemanticModel, warnings: string[]): void {
  const placement = FORMAT_VERSION_PLACEMENT[OSSIE_VERSION];
  const drop = (where: string, what: string) => warnings.push(
      `${where}: ${what} has no representation under '${OSSIE_VERSION}' and ` +
      `is not serialized`);
  const where = `model '${model.name}'`;
  if (placement.model.actions === 'none' && model.actions?.length) {
    drop(where, `'actions'`);
  }
  if (placement.model.constraints === 'none' && model.constraints?.length) {
    drop(where, `'constraints'`);
  }
  for (const e of model.entities ?? []) {
    if (placement.dataset.abstract === 'none' && e.abstract) {
      drop(`entity '${e.name}'`, `'abstract'`);
    }
  }
}

export function datasetDoc(
    entity: Entity, warnings: string[], logical: boolean,
    version: FormatVersion): Record<string, any> {
  const isGoogleVersion = version === GOOGLE_VERSION;
  const placement = FORMAT_VERSION_PLACEMENT[version];
  // A concrete (non-abstract) entity with no source cannot be reloaded -- the
  // loader requires `source` unless the dataset is abstract -- so surface the
  // gap at write time instead of emitting a document that fails to load. Under
  // OSSIE_VERSION `abstract` is omitted, so a dataset without `dataSource`
  // cannot reload even if `entity.abstract` was set. Suppressed for a logical
  // model under GOOGLE_VERSION, where a missing source is intended.
  // OSSIE_VERSION requires a source on every dataset.
  if ((!logical || !isGoogleVersion) && !(isGoogleVersion && entity.abstract) &&
      !entity.dataSource) {
    warnings.push(
        `entity '${entity.name}' has no source${
            isGoogleVersion ? ' and is not abstract' : ''}; the ` +
        `serialized document will not reload until a source is set`);
  }
  const parents = nonEmpty(entity.extends);
  const nativeExtends =
      placement.dataset.extends === 'native' ? parents : undefined;
  const nativeAbstract = placement.dataset.abstract === 'native' ?
      (entity.abstract || undefined) :
      undefined;
  const blockPayload = placement.dataset.extends === 'block' ?
      compact({extends: parents}) :
      undefined;
  return compact({
    name: entity.name,
    // An abstract entity has no physical table, so its source is empty; omit
    // the key rather than emit `source: ""` (which the loader rejects). The
    // source as written survives serialization; a legacy bare name is written
    // as the name the load qualified it to.
    source: writtenSource(entity) || undefined,
    // Supertype entities (entity-level inheritance); native under
    // GOOGLE_VERSION, or in the dataset's GOOGLE block under OSSIE_VERSION.
    extends: nativeExtends,
    // Conceptual (table-less) marker; GOOGLE_VERSION only.
    abstract: nativeAbstract,
    primary_key: nonEmpty(entity.keys),
    unique_keys: nonEmpty(entity.uniqueKeys),
    description: entity.description,
    ai_context: aiContextDoc(entity.aiContext, isGoogleVersion),
    fields:
        nonEmpty((entity.fields ?? [])
                     .map(
                         f => fieldDoc(
                             f, warnings,
                             logical || (isGoogleVersion && !!entity.abstract),
                             isGoogleVersion))),
    custom_extensions: customExtensionsDoc(
        entity.customExtensions, `entity '${entity.name}'`, isGoogleVersion,
        /* isModel= */ false, warnings, /* isField= */ false, blockPayload),
  });
}

// Filters out the IR's `'Opaque'` placeholder so untyped fields and metrics
// omit the `datatype` key in YAML. `'Opaque'` marks an unknown or unmapped type
// (e.g. from `kcmd pull` or OWL import); action parameter helpers also use this
// to tell whether a projected field will emit a concrete datatype on reload.
function datatypeDoc<T extends string>(type: T|undefined): Exclude<T, 'Opaque'>|
    undefined {
  return type === undefined || type === 'Opaque' ? undefined :
                                                   type as Exclude<T, 'Opaque'>;
}

export function fieldDoc(
    field: Field, warnings: string[], logical: boolean,
    isGoogleVersion: boolean): Record<string, any> {
  const expression =
      expressionDoc(field, isGoogleVersion, `field '${field.name}'`, warnings);
  // Under GOOGLE_VERSION a field with no expression reloads unbound. A logical
  // field, or one on an abstract entity, has none on purpose and is not warned.
  // OSSIE_VERSION requires an expression on every field.
  if ((!logical || !isGoogleVersion) && !expression) {
    warnings.push(
        isGoogleVersion ?
            `field '${field.name}': no expression; it reloads as an unbound ` +
                `field.` :
            `field '${field.name}': no expression; a '${OSSIE_VERSION}' ` +
                `document requires one per field and will not load until it ` +
                `is set.`);
  }
  return compact({
    name: field.name,
    expression,
    datatype: datatypeDoc(field.type),
    label: field.label,
    dimension: dimensionDoc(field),
    description: field.description,
    ai_context: aiContextDoc(field.aiContext, isGoogleVersion),
    custom_extensions: customExtensionsDoc(
        field.customExtensions, `field '${field.name}'`, isGoogleVersion,
        /* isModel= */ false, warnings, /* isField= */ true),
  });
}

export function metricDoc(
    metric: Metric, warnings: string[],
    version: FormatVersion): Record<string, any> {
  const isGoogleVersion = version === GOOGLE_VERSION;
  const placement = FORMAT_VERSION_PLACEMENT[version];
  // Emit `entity` only from `authoredEntity` (natively under GOOGLE_VERSION or
  // in the metric's GOOGLE block under OSSIE_VERSION). A derived
  // `metric.entity` is recomputed by the loader from SQL qualifiers.
  const expression = expressionDoc(
      metric, isGoogleVersion, `metric '${metric.name}'`, warnings);
  if (!expression) {
    warnings.push(
        `metric '${metric.name}': no expression; the loader requires one per ` +
        `metric and the document will not load until it is set.`);
  }
  const authoredEntity = metric.authoredEntity || undefined;
  const blockPayload = placement.metric.entity === 'block' ?
      compact({entity: authoredEntity}) :
      undefined;
  return compact({
    name: metric.name,
    entity: placement.metric.entity === 'native' ? authoredEntity : undefined,
    expression,
    datatype: datatypeDoc(metric.type),
    description: metric.description,
    ai_context: aiContextDoc(metric.aiContext, isGoogleVersion),
    custom_extensions: customExtensionsDoc(
        metric.customExtensions, `metric '${metric.name}'`, isGoogleVersion,
        /* isModel= */ false, warnings, /* isField= */ false, blockPayload),
  });
}

// The `Concept.field` pairs this document will still resolve on reload. A
// projection is only worth emitting as a projection if the field it names
// comes out in the same document -- see `parameterDoc`. It asks the loader's
// own resolver rather than walking the model here, so the emitter cannot come
// to a different answer than the load it is writing for. A resolver that
// throws leaves every projection emitted as authored: the emitter is not the
// place to discover that a model does not load.
function emitted(model: SemanticModel): Set<string>|null {
  let concepts;
  try {
    concepts = declaredConceptFields(model);
  } catch {
    return null;
  }
  const pairs = new Set<string>();
  for (const [name, concept] of concepts) {
    // A field carrying no emitted datatype resolves to none on reload, so
    // emitting a projection at it would suppress the parameter's resolved
    // `type` and hand back an untyped parameter the loader rejects. Treating
    // the pair as unresolvable falls the parameter back to that resolved type,
    // which is the whole point of the fallback, and warns when there is none.
    for (const [field, def] of concept.fields) {
      if (datatypeDoc(def.type) !== undefined) pairs.add(`${name}.${field}`);
    }
  }
  return pairs;
}

// Inverts loader.convertAction. The executor collapses back to the open
// format's single-key object; parameters emit as their authoring form. Actions
// only exist under GOOGLE_VERSION, and loader.ts rejects custom_extensions on
// them.
function actionDoc(
    action: Action, warnings: string[],
    resolvable: Set<string>|null): Record<string, any> {
  if (action.customExtensions?.length) {
    warnings.push(
        `action '${action.name}': ${
            action.customExtensions
                .length} custom_extension(s) have no representation ` +
        `under '${GOOGLE_VERSION}' and are not serialized`);
  }
  return compact({
    name: action.name,
    description: action.description,
    executor: action.executor ? executorDoc(action.executor) : undefined,
    parameters: nonEmpty(
        (action.parameters ??
         []).map(p => parameterDoc(p, resolvable, action.name, warnings))),
    guards: nonEmpty(action.guards),
    affects: nonEmpty((action.affects ?? []).map(affectedConceptDoc)),
    ai_context: aiContextDoc(action.aiContext, /* isGoogleVersion= */ true),
  });
}

// One action parameter, back in the form an author writes.
//
// A parameter projected from a field emits the projection and NOT the type.
// The type is the field's, copied in at load; writing it back out would make
// the document state a type alongside `concept`/`field`, which is the one
// thing the loader refuses outright -- so emitting it would produce a document
// this tool cannot read. The reload resolves it again from the same field and
// arrives at the same answer.
//
// Wording is emitted whether the author wrote it or inherited it, because
// nothing here can tell those apart and the two reload identically: an
// authored value that matches the field's is the field's. So this is verbose
// where the author was terse, and exact either way.
//
// `name` is likewise always written, even where the author let it default to
// the field's name. Same trade, same reason.
// A projection emits as a projection only where the field it names comes out
// in this same document. Pruning can take the concept away -- an entity no
// binding reaches is dropped, and the parameter that projected from it is
// deliberately kept, because it copied what it needed at load time. Emitting
// `concept`/`field` anyway would write a document that no longer loads: the
// pair resolves to nothing, and the type that would have rescued it was
// suppressed precisely because the projection was supposed to supply it. So
// where the field is gone, the parameter emits as the declared one it has
// effectively become -- its resolved `type`, and none of the projection.
function parameterDoc(
    p: ActionParameter, resolvable: Set<string>|null, action: string,
    warnings: string[]): Record<string, any> {
  const projects = p.concept !== undefined &&
      (resolvable === null || resolvable.has(`${p.concept}.${p.field}`));
  // The fallback above rests on there BEING a resolved type to fall back to,
  // and a parameter can reach here without one -- a pull of an aspect written
  // before the type was recorded, or a model whose inheritance would not
  // resolve. Both keys then drop and the parameter emits as name and wording
  // alone, which reloads as a typeless parameter and is rejected by validate.
  // Nothing here can invent the type, so say so at write time rather than let
  // it surface as a load error against a document this wrote. `Opaque` is a
  // valid standalone parameter type in the loader (unlike on fields and
  // metrics), so `p.type` is emitted directly without `datatypeDoc`.
  if (!projects && p.concept !== undefined && p.type === undefined) {
    warnings.push(
        `action '${action}': parameter '${p.name}' projected from '${
            p.concept}.${p.field}', which this document does not carry, and ` +
        `no resolved datatype was recorded to write in its place. The ` +
        `parameter emits with no type and the document will not load until ` +
        `one is supplied.`);
  }
  return compact({
    name: p.name,
    type: projects ? undefined : p.type,
    concept: projects ? p.concept : undefined,
    field: projects ? p.field : undefined,
    label: p.label,
    description: p.description,
    ai_context: aiContextDoc(p.aiContext, /* isGoogleVersion= */ true),
    required: p.required,
    default: p.default,
  });
}

// One affected concept back to the open format. An entry that says nothing
// beyond which
// concept it touches emits as the bare name, which is the shorthand the author
// most likely wrote and the form the proposal uses; anything with an operation
// or fields needs the record.
//
// This NORMALIZES rather than reproducing the document byte for byte: an
// authored `{concept: Order}` with no operation comes back as `Order`. The two
// mean the same thing, so the emit is a fixed point after one pass, which is
// what the round-trip tests assert.
function affectedConceptDoc(affected: AffectedConcept): string|
    Record<string, any> {
  if (!affected.operation && !affected.fields?.length) return affected.concept;
  return compact({
    concept: affected.concept,
    operation: affected.operation,
    fields: nonEmpty(affected.fields),
  });
}

// Inverts loader.convertConstraint. The judgment is a logical invariant and
// round-trips verbatim, since nothing about it is derived. The aspect type's
// reserved `expression` and `evaluation` fields have no counterpart here: one
// names a body the model no longer has, and the other was computed from which
// body a constraint stated, so emitting either would put something the author
// cannot write into an authored document.
function constraintDoc(constraint: Constraint): Record<string, any> {
  // No custom_extensions call: a constraint carries no custom extensions.
  return compact({
    name: constraint.name,
    judgment: constraint.judgment,
    description: constraint.description,
    on_violation: constraint.onViolation,
    severity: constraint.severity,
    ai_context: aiContextDoc(constraint.aiContext, /* isGoogleVersion= */ true),
  });
}

// Collapses the IR's tagged executor union back to the open format's single-key
// object ({mcp: {...}} / {rest: {...}} / {grpc: {...}}).
function executorDoc(ex: Executor): Record<string, any> {
  switch (ex.kind) {
    case 'mcp':
      return {mcp: {server: ex.mcp.server, tool: ex.mcp.tool}};
    case 'rest':
      return {rest: {endpoint: ex.rest.endpoint, method: ex.rest.method}};
    case 'grpc':
      return {grpc: {service: ex.grpc.service, method: ex.grpc.method}};
    case 'sql':
      return {sql: {statements: [...ex.sql.statements]}};
  }
}

// Inverts loader.convertRelationship: `from`/`to` are the endpoint entities and
// `from_columns`/`to_columns` are their positional join columns. An association
// (junction-table) edge has no open-format syntax, so only this direct-FK view
// is emitted and the junction detail is flagged.
export function relationshipDoc(
    rel: Relationship, warnings: string[],
    version: FormatVersion): Record<string, any> {
  const isGoogleVersion = version === GOOGLE_VERSION;
  const placement = FORMAT_VERSION_PLACEMENT[version];
  if (rel.association) {
    warnings.push(
        `relationship '${
            rel.name}': association (junction-table) detail has no ` +
        `open-format representation and is not serialized; only its ` +
        `foreign-key endpoints are written.`);
  }
  if (!isGoogleVersion &&
      (!rel.source.columns.length || !rel.destination.columns.length)) {
    warnings.push(
        `relationship '${rel.name}': no join columns; a '${
            OSSIE_VERSION}' document requires from_columns and to_columns ` +
        `and will not load until they are set.`);
  }
  const description = rel.description || undefined;
  const blockPayload = placement.relationship.description === 'block' ?
      compact({description}) :
      undefined;
  return compact({
    name: rel.name,
    from: rel.source.entity,
    to: rel.destination.entity,
    from_columns: nonEmpty(rel.source.columns),
    to_columns: nonEmpty(rel.destination.columns),
    description: placement.relationship.description === 'native' ? description :
                                                                   undefined,
    ai_context: aiContextDoc(rel.aiContext, isGoogleVersion),
    custom_extensions: customExtensionsDoc(
        rel.customExtensions, `relationship '${rel.name}'`, isGoogleVersion,
        /* isModel= */ false, warnings, /* isField= */ false, blockPayload),
  });
}

// Renders a field or metric `expression` for the target version. The IR comes
// from two sources:
//   1. YAML loaded by `loader.ts`, which populates `dialects` and `stringForm`.
//   2. Models built by `kcmd pull` or OWL import, which leave `dialects` unset
//      and only populate `expression` (plus optional `importedExpression`).
export function expressionDoc(
    item: {
      expression?: string;
      importedExpression?: string;
      importedDialect?: string;
      dialects?: Array<{dialect: SqlDialect; expression: string}>;
      stringForm?: boolean;
    },
    isGoogleVersion: boolean, where: string, warnings: string[]): string|
    {dialects: Array<{dialect: string; expression: string}>}|undefined {
  // Path 1 (YAML round-trip): re-emit the original `dialects` list in authored
  // order. Under GOOGLE_VERSION, `stringForm` means the author wrote a bare
  // string shorthand (`expression: "SUM(amt)"`), so emit the bare string back;
  // under OSSIE_VERSION bare strings are forbidden, so emit `{dialects:
  // [...]}`.
  if (item.dialects?.length) {
    const allowed: Array<{dialect: SqlDialect; expression: string}> = [];
    for (const d of item.dialects) {
      if (ALLOWED_DIALECT_SET.has(d.dialect)) {
        allowed.push(d);
      } else {
        warnings.push(
            `${where}: expression in dialect '${d.dialect}' is not a dialect ` +
            `the loader accepts and is not serialized`);
      }
    }
    if (allowed.length) {
      if (isGoogleVersion && item.stringForm) {
        return allowed[0].expression;
      }
      return {
        dialects:
            allowed.map(d => ({dialect: d.dialect, expression: d.expression})),
      };
    }
  }
  // Path 2 (`kcmd pull` / OWL import / fallback): `dialects` is absent, so
  // synthesize it from `expression` and `importedExpression`.
  if (isGoogleVersion && item.stringForm && item.expression !== undefined &&
      item.importedExpression === undefined) {
    return item.expression;
  }
  const dialects: Array<{dialect: string; expression: string}> = [];
  if (item.expression !== undefined) {
    // `loader.ts` wraps a bare-string expression as ANSI_SQL; otherwise label
    // the canonical expression BIGQUERY so reload picks it back up.
    dialects.push({
      dialect: item.stringForm ? 'ANSI_SQL' : CANONICAL_DIALECT,
      expression: item.expression,
    });
  }
  if (item.importedExpression !== undefined) {
    // `importedExpression` holds third-party vendor SQL, such as SNOWFLAKE or
    // DATABRICKS, kept for transpilation. Only emit `importedDialect` when the
    // loader accepts it; an unknown or missing label would fail to reload.
    const label = item.importedDialect;
    if (label === undefined) {
      warnings.push(
          `${where}: imported expression has no dialect and is not serialized`);
    } else if (!ALLOWED_DIALECT_SET.has(label)) {
      warnings.push(
          `${where}: imported expression in dialect '${label}' is not a ` +
          `dialect the loader accepts and is not serialized`);
    } else if (dialects.some(d => d.dialect === label)) {
      warnings.push(
          `${where}: imported expression in dialect '${label}' has the same ` +
          `dialect as the expression and is not serialized`);
    } else {
      dialects.push({dialect: label, expression: item.importedExpression});
    }
  }
  return dialects.length ? {dialects} : undefined;
}

// Emits the field's `dimension` block when present, inverting
// loader.convertField (which sets `dimension = {}` for a bare marker and copies
// `is_time`). The key is emitted whenever the IR carries dimension metadata,
// even for an empty marker, so a dimension field reloads as a dimension.
function dimensionDoc(field: Field): Record<string, any>|undefined {
  if (!field.dimension) return undefined;
  return compact({is_time: field.dimension.isTime});
}

// Emits the structured `ai_context` for the target version, inverting
// loader.normalizeAiContext. Custom properties (`additionalProperties`) sit
// under `custom:` under GOOGLE_VERSION and as sibling keys under OSSIE_VERSION.
export function aiContextDoc(ai: AiContext|undefined, isGoogleVersion: boolean):
    Record<string, unknown>|undefined {
  if (!ai) return undefined;
  const custom =
      ai.additionalProperties ? compact(ai.additionalProperties) : undefined;
  const hasCustom = custom !== undefined && Object.keys(custom).length > 0;
  const base = compact({
    instructions: ai.instructions,
    synonyms: nonEmpty(ai.synonyms),
    examples: nonEmpty(ai.examples),
  });
  if (!hasCustom) {
    return Object.keys(base).length ? base : undefined;
  }
  return isGoogleVersion ? {...base, custom} : {...custom, ...base};
}

// The deployments a vanilla model lists only as targets in its GOOGLE blocks,
// named as a pull names them. A block whose data is not valid JSON gives none,
// and customExtensionsDoc warns that it was dropped. The other blocks still
// give theirs.
function deploymentsFromGoogleExtensions(model: SemanticModel):
    Array<{name: string; target: string}> {
  const targets = (model.customExtensions ??
                   []).flatMap(ext => blockTargets(ext, model.name));
  return unnamedDeployments(targets);
}

// The serialized payload of a synthesized `GOOGLE` `custom_extensions` block
// (the serializer counterpart to `GoogleBlockValues` in `loader.ts`, covering
// the `'block'`-placed constructs of
// `FORMAT_VERSION_PLACEMENT[OSSIE_VERSION]`).
interface GoogleBlockPayload {
  profiles?: ProfileDoc[];
  deployments?: Array<Record<string, any>>;
  extends?: string[];
  description?: string;
  entity?: string;
}

// Serializes `custom_extensions` for one IR element. Under OSSIE_VERSION,
// third-party extensions and a model's kept `deploymentTargets` GOOGLE block
// (when `deployments` is not written) are emitted, followed by a synthesized
// GOOGLE block when `blockPayload` carries any keys. Any other raw GOOGLE
// block on the IR is dropped with a warning so it cannot collide with the
// synthesized block or write keys the loader rejects. Under GOOGLE_VERSION,
// third-party extensions are written out unchanged without warning, while
// `GOOGLE` blocks are skipped (silently for the model's `deploymentTargets`
// block, and with a warning for any other `GOOGLE` block).
function customExtensionsDoc(
    exts: CustomExtension[]|undefined, where: string, isGoogleVersion: boolean,
    isModel: boolean, warnings: string[], isField = false,
    blockPayload?: GoogleBlockPayload):
    Array<{vendor_name: string; data: string}>|undefined {
  const payload: GoogleBlockPayload = blockPayload ? {...blockPayload} : {};
  if (!exts?.length && Object.keys(payload).length === 0) return undefined;
  if (!isGoogleVersion) {
    const kept: Array<{vendor_name: string; data: string}> = [];
    let droppedGoogle = 0;
    for (const e of exts ?? []) {
      if (e.vendorName !== GOOGLE_VENDOR) {
        kept.push({vendor_name: e.vendorName, data: e.data});
        continue;
      }
      // The loader keeps a model's `deploymentTargets` block, since no IR field
      // holds it, and rejects that block beside `deployments`.
      if (isModel && isDeploymentTargetsBlock(e)) {
        if (payload.deployments === undefined) {
          // Profiles this block lists are the model's, as the loader read them.
          if ('profiles' in JSON.parse(e.data)) delete payload.profiles;
          kept.push({vendor_name: GOOGLE_VENDOR, data: e.data});
        }
        continue;
      }
      droppedGoogle += 1;
    }
    if (droppedGoogle > 0) {
      warnings.push(
          isField ?
              `${where}: ${droppedGoogle} GOOGLE custom_extension(s) have no ` +
                  `representation on a field under '${OSSIE_VERSION}' and ` +
                  `are not serialized` :
              `${where}: ${droppedGoogle} GOOGLE custom_extension(s) are not ` +
                  `serialized under '${OSSIE_VERSION}'; its GOOGLE block is ` +
                  `written from its own fields`);
    }
    if (Object.keys(payload).length > 0) {
      kept.push({
        vendor_name: GOOGLE_VENDOR,
        data: JSON.stringify(payload),
      });
    }
    return nonEmpty(kept);
  }
  // No GOOGLE_VERSION construct has 'block' placement, so `blockPayload` is
  // empty here.
  const kept: Array<{vendor_name: string; data: string}> = [];
  let droppedGoogle = 0;
  for (const ext of exts ?? []) {
    if (ext.vendorName !== GOOGLE_VENDOR) {
      kept.push({vendor_name: ext.vendorName, data: ext.data});
      continue;
    }
    if (isModel && blockTargets(ext, '').length > 0) continue;
    droppedGoogle += 1;
  }
  if (droppedGoogle > 0) {
    warnings.push(
        `${where}: ${droppedGoogle} GOOGLE custom_extension(s) have no ` +
        `representation under '${GOOGLE_VERSION}' and are not serialized`);
  }
  return nonEmpty(kept);
}

/**
 * Returns true if `e.data` is a JSON object with a `'deploymentTargets'`
 * property.
 *
 * Matches the check in `readGoogleBlocks` (`loader.ts`), which keeps any
 * model-level `GOOGLE` block that declares `'deploymentTargets'` (even when the
 * list is empty or whitespace-only).
 */
function isDeploymentTargetsBlock(e: CustomExtension): boolean {
  try {
    const d = JSON.parse(e.data);
    return !!d && typeof d === 'object' &&
        Object.hasOwn(d, 'deploymentTargets');
  } catch {
    return false;
  }
}

function blockTargets(ext: CustomExtension, modelName: string): string[] {
  try {
    return googleBlockTargets([ext], modelName);
  } catch {
    return [];
  }
}

// Drops undefined-valued keys so the emitted YAML only shows fields the model
// actually set (matching the emitters' `compact` convention).
export function compact<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

// Returns the array, or undefined when empty/absent, so an empty list is
// omitted rather than rendered as `[]`.
export function nonEmpty<T>(items: T[]|undefined): T[]|undefined {
  return items && items.length ? items : undefined;
}
