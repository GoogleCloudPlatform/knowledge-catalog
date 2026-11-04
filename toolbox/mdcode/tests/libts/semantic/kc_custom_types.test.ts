// The custom aspect templates are APPEND-ONLY, and nothing else enforces it.
//
// Dataplex rejects a backwards-incompatible template change, so renumbering or
// removing a field breaks `kcmd init` for every project that already
// provisioned the type -- and it breaks it at THEIR next init, not in this
// repository, which is why no other test here notices. A field that is no
// longer written is retired in place: it keeps its index and its name, and its
// `displayName` gains a `(reserved)` marker.
//
// So these tests pin the index-to-name mapping of every field that has ever
// shipped. A failure is not a bug in the template; it is the template having
// been renumbered, and the fix is to put the indices back and append.

import {describe, expect, test} from 'bun:test';

import {ACTION_TYPE_ID, CONSTRAINT_TYPE_ID, CUSTOM_TYPES} from '../../../src/libts/semantic/kc_custom_types';

function template(id: string): any {
  const found = CUSTOM_TYPES.find(t => t.id === id);
  if (!found) throw new Error(`no custom type '${id}'`);
  return found.aspectType.metadataTemplate;
}

// Every field's index, by name, at whatever depth it lives.
function indices(fields: any[]): Record<string, number> {
  const seen: Record<string, number> = {};
  for (const f of fields ?? []) seen[f.name] = f.index;
  return seen;
}

describe('the semantic-action aspect template', () => {
  const root = template(ACTION_TYPE_ID);

  test('keeps every top-level index it has ever published', () => {
    expect(indices(root.recordFields)).toMatchObject({
      executorKind: 1,
      mcpServer: 2,
      mcpTool: 3,
      restEndpoint: 4,
      restMethod: 5,
      grpcService: 6,
      grpcMethod: 7,
      parameters: 8,
      instructions: 9,
    });
  });

  test('keeps every parameter index it has ever published', () => {
    const parameters =
        root.recordFields.find((f: any) => f.name === 'parameters');
    // `concept` and `field` are the newest pair and were APPENDED at 7 and 8.
    // They are not 3 and 4: index 3 belongs to `isEntityRef`, retired in place
    // when entity-reference parameters were removed, and taking its number
    // would have silently broken every project that ever ran `kcmd init`.
    expect(indices(parameters.arrayItems.recordFields)).toEqual({
      name: 1,
      type: 2,
      isEntityRef: 3,
      description: 4,
      required: 5,
      default: 6,
      concept: 7,
      field: 8,
    });
  });

  test('marks a field it no longer writes as reserved', () => {
    const parameters =
        root.recordFields.find((f: any) => f.name === 'parameters');
    const retired = parameters.arrayItems.recordFields.find(
        (f: any) => f.name === 'isEntityRef');
    expect(retired.annotations.displayName).toContain('(reserved)');
    expect(retired.annotations.description).toContain('never written');
  });
});

describe('the semantic-constraint aspect template', () => {
  test('keeps every index it has ever published', () => {
    // `expression` was the deterministic constraint body, cut when `judgment`
    // became the only one. It stays at index 1 as a reserved field.
    expect(indices(template(CONSTRAINT_TYPE_ID).recordFields))
        .toMatchObject({expression: 1, onViolation: 3});
  });
});
