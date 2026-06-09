import { describe, test, expect } from 'bun:test';
import { Entry } from '../../src/libts/metadata';
import {
  calculateAspectChecksum,
  calculateEntryChecksum,
} from '../../src/libts/checksum';

describe('Checksum Utilities', () => {
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
