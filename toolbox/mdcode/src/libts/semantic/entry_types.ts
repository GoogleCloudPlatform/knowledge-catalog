// The entry types a semantic model owns.
//
// A context-set workspace keeps the semantic model in OSI+G and every other
// entry in OKF, so both halves have to agree on exactly which entry types
// belong to the model. This module is that agreement, in one place.
//
// It deliberately imports nothing: it is read by the layouts and by the OKF
// converters, and the type IDs it names are spread across kc_custom_types,
// kc_relationships and the emitter. tests/libts/semantic/entry_types.test.ts
// checks this list against those modules' own constants, so the duplication
// cannot drift silently.

// Every entry type a semantic model publishes. `semantic-model` is the
// anchor; `-entity`, `-metric`, `-relationship`, `-action` and `-constraint`
// are its elements; `-explore` is emitted for LookML; `-model-file` is the
// stored copy of the model file that pull rebuilds from.
export const SEMANTIC_ENTRY_TYPE_IDS: readonly string[] = [
  'semantic-model',
  'semantic-model-file',
  'semantic-entity',
  'semantic-metric',
  'semantic-relationship',
  'semantic-action',
  'semantic-constraint',
  'semantic-explore',
];

const SEMANTIC_ENTRY_TYPE_ID_SET = new Set(SEMANTIC_ENTRY_TYPE_IDS);

// The bare type ID of a reference written in any of the three forms the tool
// passes around: a full resource name
// (`projects/<p>/locations/<l>/entryTypes/<id>`), a local type reference
// (`<project>.<location>.<id>`), or the bare ID itself. Project and location
// IDs cannot contain a dot, so taking the last segment of each split is
// unambiguous even for a hyphenated ID like `semantic-model-file`.
export function entryTypeIdOf(typeRef: string): string {
  const path = typeRef.split('/').pop() ?? '';
  return path.split('.').pop() ?? '';
}

// Whether `typeRef` names an entry the semantic model owns, and so one the OKF
// half of a context-set workspace must leave alone.
//
// This tests the `semantic-` prefix rather than membership of the list above,
// because the two ways of being wrong are not equally bad. An unrecognized
// `semantic-*` type routed to the model surfaces as a loud error from a layout
// that cannot place it; the same type routed to the OKF half is written into
// the bundle as a concept and pushed back as a duplicate of an entry the
// semantic leg already wrote -- silently. So an unknown semantic type belongs
// with the model.
export function isSemanticEntryType(typeRef: string): boolean {
  return entryTypeIdOf(typeRef).startsWith('semantic-');
}

// Whether `typeRef` is one of the semantic entry types this build knows about.
// Narrower than isSemanticEntryType: use that one for routing.
export function isKnownSemanticEntryType(typeRef: string): boolean {
  return SEMANTIC_ENTRY_TYPE_ID_SET.has(entryTypeIdOf(typeRef));
}
