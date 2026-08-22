// Behavior specification for the inheritance-resolution pass
// (src/libts/semantic/resolve_inheritance.ts): expanding `extends` to the full
// transitive ancestor set and flattening supertype fields onto subclasses,
// without mutating the input.

import {describe, expect, test} from 'bun:test';

import {Entity, Field, SemanticModel} from '../../../src/libts/semantic/ir';
import {resolveInheritance} from '../../../src/libts/semantic/resolve_inheritance';

// Minimal field/entity builders so a test reads as the hierarchy it describes.
function field(name: string): Field {
  return {name, expression: name};
}
function entity(
    name: string, fieldNames: string[], extendsList?: string[],
    extra: Partial<Entity> = {}): Entity {
  return {
    name,
    dataSource: `proj.ds.${name}`,
    keys: [`${name}_id`],
    fields: fieldNames.map(field),
    ...(extendsList ? {extends: extendsList} : {}),
    ...extra,
  };
}
function model(entities: Entity[], relationships: any[] = []): SemanticModel {
  return {name: 'm', entities, relationships, metrics: []};
}
// The field names on the named resolved entity, in order.
function fieldsOf(m: SemanticModel, name: string): string[] {
  return m.entities.find(e => e.name === name)!.fields.map(f => f.name);
}
function entityOf(m: SemanticModel, name: string): Entity {
  return m.entities.find(e => e.name === name)!;
}


describe('field flattening', () => {
  test(
      'a single parent flows its fields onto the child, own fields first',
      () => {
        const {model: r, warnings} = resolveInheritance(model([
          entity('Person', ['id', 'fullName', 'email']),
          entity('Customer', ['id', 'loyaltyTier'], ['Person']),
        ]));
        // Own fields lead (declared order), then the parent's not-yet-present
        // ones; `id` is shared, so the child's `id` wins and the parent's is
        // not appended.
        expect(fieldsOf(r, 'Customer')).toEqual([
          'id', 'loyaltyTier', 'fullName', 'email'
        ]);
        expect(warnings).toEqual([]);
      });

  test('a transitive chain flattens every ancestor, nearest-first', () => {
    const {model: r} = resolveInheritance(model([
      entity('Person', ['id', 'fullName']),
      entity('Employee', ['id', 'department'], ['Person']),
      entity('Manager', ['id', 'teamSize'], ['Employee']),
    ]));
    expect(fieldsOf(r, 'Manager')).toEqual([
      'id', 'teamSize', 'department', 'fullName'
    ]);
    expect(fieldsOf(r, 'Employee')).toEqual(['id', 'department', 'fullName']);
  });

  test('a nearer definition of a field name wins over a farther one', () => {
    const {model: r} = resolveInheritance(model([
      entity('A', ['id', 'note']),
      entity('B', ['id', 'note'], ['A']),  // B.note shadows A.note
    ]));
    const b = entityOf(r, 'B');
    // The kept `note` is B's own (its expression), not A's.
    const note = b.fields.find(f => f.name === 'note')!;
    expect(note.expression).toBe('note');
    expect(fieldsOf(r, 'B')).toEqual(['id', 'note']);
  });

  test('a diamond includes each ancestor and each field exactly once', () => {
    // D -> {B, C} -> A. A is reached via both B and C but must appear once.
    const {model: r} = resolveInheritance(model([
      entity('A', ['id', 'base']),
      entity('B', ['b'], ['A']),
      entity('C', ['c'], ['A']),
      entity('D', ['d'], ['B', 'C']),
    ]));
    expect(entityOf(r, 'D').extends).toEqual(['B', 'C', 'A']);
    // Nearest-first: own (d), then direct parents B (b) and C (c), then the
    // shared grandparent A (id, base) once.
    expect(fieldsOf(r, 'D')).toEqual(['d', 'b', 'c', 'id', 'base']);
  });
});


describe('extends expansion', () => {
  test(
      'extends becomes the full transitive ancestor set, nearest-first', () => {
        const {model: r} = resolveInheritance(model([
          entity('Person', ['id']),
          entity('Employee', ['id'], ['Person']),
          entity('Manager', ['id'], ['Employee']),
        ]));
        expect(entityOf(r, 'Manager').extends).toEqual(['Employee', 'Person']);
        expect(entityOf(r, 'Person').extends).toBeUndefined();
      });
});


describe('robustness', () => {
  test('a cycle is warned and terminates (no infinite loop)', () => {
    const {model: r, warnings} = resolveInheritance(model([
      entity('A', ['a'], ['B']),
      entity('B', ['b'], ['A']),
    ]));
    // Each still gets the other as an ancestor, but the back-edge is cut.
    expect(entityOf(r, 'A').extends).toEqual(['B']);
    expect(entityOf(r, 'B').extends).toEqual(['A']);
    expect(warnings.some(w => w.includes('cycle'))).toBe(true);
  });

  test('an unknown parent is warned and excluded from the ancestor set', () => {
    const {model: r, warnings} = resolveInheritance(model([
      entity('Customer', ['id'], ['Ghost']),
    ]));
    expect(entityOf(r, 'Customer').extends).toBeUndefined();
    expect(warnings.some(w => w.includes('unknown entity \'Ghost\'')))
        .toBe(true);
  });
});


describe('what does NOT flow down', () => {
  test('keys are not inherited: each entity keeps its own KEY', () => {
    const {model: r} = resolveInheritance(model([
      entity('Person', ['id']),
      entity('Customer', ['id'], ['Person']),
    ]));
    expect(entityOf(r, 'Customer').keys).toEqual(['Customer_id']);
  });

  test('relationships are untouched (edges do not inherit)', () => {
    const rel = {
      name: 'livesIn',
      source: {entity: 'Person', columns: ['city_id']},
      destination: {entity: 'City', columns: ['id']},
    };
    const {model: r} = resolveInheritance(model(
        [
          entity('Person', ['id']),
          entity('City', ['id']),
          entity('Customer', ['id'], ['Person']),
        ],
        [rel]));
    expect(r.relationships).toEqual([rel]);
  });
});


describe('non-mutation and identity', () => {
  test('the input model is not mutated', () => {
    const input = model([
      entity('Person', ['id', 'fullName']),
      entity('Customer', ['id'], ['Person']),
    ]);
    const before = JSON.stringify(input);
    resolveInheritance(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  test('a model with no extends resolves to an equivalent model', () => {
    const input = model([entity('Person', ['id', 'fullName'])]);
    const {model: r, warnings} = resolveInheritance(input);
    expect(warnings).toEqual([]);
    expect(r.entities[0].extends).toBeUndefined();
    expect(fieldsOf(r, 'Person')).toEqual(['id', 'fullName']);
  });
});


describe('inherited-expression localization', () => {
  // A field written on the supertype as `<Supertype>.col` references the
  // supertype's own table; inherited onto a subclass it must reference the
  // subclass's local column, so its own-name qualifier is stripped on the
  // flattened copy (the supertype's own field is left untouched). Without this,
  // the subclass and supertype would render the same property differently and
  // an emitter reusing one label across both tables would reject it.
  test('a self-qualified inherited expression becomes table-local', () => {
    const {model: r} = resolveInheritance(model([
      entity('Person', [], undefined, {
        fields: [{name: 'email', expression: 'Person.email'}],
      }),
      entity('Customer', ['id'], ['Person']),
    ]));
    const inherited =
        entityOf(r, 'Customer').fields.find(f => f.name === 'email')!;
    expect(inherited.expression).toBe('email');
    // The supertype's own copy is unchanged.
    const own = entityOf(r, 'Person').fields.find(f => f.name === 'email')!;
    expect(own.expression).toBe('Person.email');
  });

  test('a qualifier that is not the defining entity is left intact', () => {
    // `LOWER(email)` has no `<Person>.` qualifier, so nothing is stripped.
    const {model: r} = resolveInheritance(model([
      entity('Person', [], undefined, {
        fields: [{name: 'email', expression: 'LOWER(email)'}],
      }),
      entity('Customer', ['id'], ['Person']),
    ]));
    const inherited =
        entityOf(r, 'Customer').fields.find(f => f.name === 'email')!;
    expect(inherited.expression).toBe('LOWER(email)');
  });
});
