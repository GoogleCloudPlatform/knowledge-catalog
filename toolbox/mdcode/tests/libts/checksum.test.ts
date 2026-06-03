import { describe, test, expect } from 'bun:test';
import { Entry } from '../../src/libts/metadata';
import {
  normalizeAspectData,
  calculateAspectChecksum,
  calculateEntryChecksum,
} from '../../src/libts/checksum';

describe('Checksum Utilities', () => {
  describe('normalizeAspectData', () => {
    test('normalizes object keys alphabetically', () => {
      const obj1 = { b: 2, a: 1, c: { y: 2, x: 1 } };
      const obj2 = { a: 1, b: 2, c: { x: 1, y: 2 } };

      const norm1 = normalizeAspectData(obj1);
      const norm2 = normalizeAspectData(obj2);

      // Verify keys in insertion order match the sorted order
      expect(Object.keys(norm1)).toEqual(['a', 'b', 'c']);
      expect(Object.keys(norm1.c)).toEqual(['x', 'y']);

      expect(norm1).toEqual(norm2);
    });

    test('preserves array order but normalizes objects inside arrays', () => {
      const arr1 = [{ y: 2, x: 1 }, { b: 2, a: 1 }];
      const arr2 = [{ x: 1, y: 2 }, { a: 1, b: 2 }];

      const norm1 = normalizeAspectData(arr1);
      const norm2 = normalizeAspectData(arr2);

      expect(norm1).toEqual(norm2);
      expect(Object.keys(norm1[0])).toEqual(['x', 'y']);
      expect(Object.keys(norm1[1])).toEqual(['a', 'b']);
      // Verify elements order was not changed
      expect(norm1[0].x).toBe(1);
    });

    test('handles primitives and null values correctly', () => {
      expect(normalizeAspectData(null)).toBeNull();
      expect(normalizeAspectData(123)).toBe(123);
      expect(normalizeAspectData('abc')).toBe('abc');
      expect(normalizeAspectData(true)).toBe(true);
    });
  });

  describe('calculateAspectChecksum', () => {
    test('same content with different key order results in the same hash', () => {
      const data1 = { description: 'hello', tags: ['a', 'b'], details: { score: 10, name: 'x' } };
      const data2 = { tags: ['a', 'b'], details: { name: 'x', score: 10 }, description: 'hello' };

      const hash1 = calculateAspectChecksum(data1);
      const hash2 = calculateAspectChecksum(data2);

      expect(hash1).toBe(hash2);
    });

    test('changing any content results in a different hash', () => {
      const data1 = { description: 'hello', tags: ['a', 'b'] };
      const data2 = { description: 'hello', tags: ['a', 'c'] };

      const hash1 = calculateAspectChecksum(data1);
      const hash2 = calculateAspectChecksum(data2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('calculateEntryChecksum', () => {
    test('same entry with different aspect key order or aspect property order matches hash', () => {
      const entry1: Entry = {
        name: 'orders',
        type: 'dataset',
        resource: { displayName: 'Orders Dataset', description: 'dataset for orders' },
        aspects: {
          'dataplex-types.global.overview': { content: 'This is overview', contentType: 'MARKDOWN' },
          'dataplex-types.global.descriptions': { short: 'Orders', long: 'Long description of orders' }
        }
      };

      const entry2: Entry = {
        name: 'orders',
        type: 'dataset',
        resource: { description: 'dataset for orders', displayName: 'Orders Dataset' },
        aspects: {
          'dataplex-types.global.descriptions': { long: 'Long description of orders', short: 'Orders' },
          'dataplex-types.global.overview': { contentType: 'MARKDOWN', content: 'This is overview' }
        }
      };

      const hash1 = calculateEntryChecksum(entry1);
      const hash2 = calculateEntryChecksum(entry2);

      expect(hash1).toBe(hash2);
    });

    test('modifying any field changes the entry checksum', () => {
      const entry1: Entry = {
        name: 'orders',
        type: 'dataset',
        resource: { displayName: 'Orders Dataset' },
        aspects: {
          'dataplex-types.global.overview': { content: 'This is overview' }
        }
      };

      const entry2: Entry = {
        name: 'orders',
        type: 'dataset',
        resource: { displayName: 'Orders Dataset 2' },
        aspects: {
          'dataplex-types.global.overview': { content: 'This is overview' }
        }
      };

      const hash1 = calculateEntryChecksum(entry1);
      const hash2 = calculateEntryChecksum(entry2);

      expect(hash1).not.toBe(hash2);
    });
  });
});
