// Unit tests for Knowledge Catalog ID helpers (src/libts/semantic/kc_ids.ts).

import {describe, expect, test} from 'bun:test';

import {Entity, Metric, Relationship, SemanticModel} from '../../../src/libts/semantic/ir';
import {entryIdOf, Namer, NamerOptions, ownedEntryIdPrefixes, semanticLinkId, slug} from '../../../src/libts/semantic/kc_ids';

const BASE_OPTS: NamerOptions = {
  project: 'p',
  location: 'us',
  entryGroup: 'default',
};

const MODEL: SemanticModel = {
  name: 'retail_sales',
  entities: [],
  relationships: [],
  metrics: [],
};

const ENTITY: Entity = {
  name: 'store_orders',
  dataSource: 'p.d.store_orders',
  keys: ['id'],
  fields: [],
};

const METRIC: Metric = {
  name: 'total_revenue',
  expression: 'SUM(amount)',
};

const REL: Relationship = {
  name: 'order_customer',
  source: {entity: 'store_orders', columns: ['customer_id']},
  destination: {entity: 'customers', columns: ['id']},
};

describe('Namer entry IDs', () => {
  test(
      'are slash-separated, keeping a relationship\'s authored name',
      () => {
        const names = new Namer(BASE_OPTS);
        expect(names.modelId(MODEL)).toBe('retail_sales');
        expect(names.entityId(MODEL, ENTITY))
            .toBe('retail_sales/entities/store_orders');
        expect(names.metricId(MODEL, METRIC))
            .toBe('retail_sales/metrics/total_revenue');
        expect(names.relationshipId(MODEL, REL))
            .toBe('retail_sales/relationships/order_customer');
        expect(names.relationshipId(MODEL, {...REL, name: 'Order_Customer'}))
            .toBe('retail_sales/relationships/Order_Customer');
        expect(names.entry(names.entityId(MODEL, ENTITY)))
            .toBe(
                'projects/p/locations/us/entryGroups/default/entries/' +
                'retail_sales/entities/store_orders');
      });
});

describe('semanticLinkId', () => {
  test('is semantic-<kind>- and the first 32 hex characters of the SHA-256 ' +
           'of the parts joined by /',
       () => {
         expect([
           semanticLinkId('link', 'sales', 'orders', 'customers'),
           semanticLinkId('relationship', 'sales', 'placed_by', 'source'),
           semanticLinkId('extends', 'sales', 'vips', 'customers'),
         ]).toEqual([
           'semantic-link-e6b1c3bb1665161a428c2cd13a1cb443',
           'semantic-relationship-7d24245079e3654a7a01f88f89d599a9',
           'semantic-extends-22fb71a480680b1a4d779ce39187b845',
         ]);
       });
});

describe('Namer.typeName and Namer.aspectRef', () => {
  test('uses default dataplex-types project and global location', () => {
    const names = new Namer(BASE_OPTS);
    expect(names.typeName('entry', 'semantic-entity'))
        .toBe(
            'projects/dataplex-types/locations/global/' +
            'entryTypes/semantic-entity');
    expect(names.typeName('aspect', 'schema'))
        .toBe('projects/dataplex-types/locations/global/aspectTypes/schema');
    expect(names.typeName('entryLink', 'schema-join'))
        .toBe(
            'projects/dataplex-types/locations/global/' +
            'entryLinkTypes/schema-join');
    expect(names.aspectRef('schema')).toBe('dataplex-types.global.schema');
  });

  test('respects custom systemTypeProject and systemTypeLocation', () => {
    const names = new Namer({
      ...BASE_OPTS,
      systemTypeProject: 'custom-types',
      systemTypeLocation: 'us-central1',
    });
    expect(names.typeName('entry', 'semantic-model'))
        .toBe(
            'projects/custom-types/locations/us-central1/' +
            'entryTypes/semantic-model');
    expect(names.aspectRef('semantic-model'))
        .toBe('custom-types.us-central1.semantic-model');
  });
});

describe('ownedEntryIdPrefixes', () => {
  test(
      'returns eight prefixes with no slash form for actions, constraints or ' +
          'files, and no dotted form for relationships',
      () => {
        const prefixes = ownedEntryIdPrefixes('retail_sales');
        expect(prefixes).toEqual([
          'retail_sales.entities.',
          'retail_sales.metrics.',
          'retail_sales.actions.',
          'retail_sales.constraints.',
          'retail_sales.files.',
          'retail_sales/entities/',
          'retail_sales/metrics/',
          'retail_sales/relationships/',
        ]);
      });
});

describe('entryIdOf', () => {
  test('unwraps an entry ID in the new slash layout', () => {
    expect(entryIdOf(
               'projects/p/locations/us/entryGroups/default/entries/' +
               'retail_sales/entities/store_orders'))
        .toBe('retail_sales/entities/store_orders');
  });

  test('unwraps a dotted entry ID in the old layout', () => {
    expect(entryIdOf(
               'projects/p/locations/us/entryGroups/default/entries/' +
               'retail_sales.entities.store_orders'))
        .toBe('retail_sales.entities.store_orders');
  });

  test('returns the last segment for an entry-link resource name', () => {
    expect(entryIdOf(
               'projects/p/locations/us/entryGroups/default/entryLinks/' +
               'retail-sales-order-customer'))
        .toBe('retail-sales-order-customer');
  });

  test('unwraps type resource names across all type collections', () => {
    expect(entryIdOf(
               'projects/dataplex-types/locations/global/entryTypes/' +
               'semantic-entity'))
        .toBe('semantic-entity');
    expect(entryIdOf(
               'projects/dataplex-types/locations/global/aspectTypes/' +
               'semantic-metric'))
        .toBe('semantic-metric');
    expect(entryIdOf(
               'projects/dataplex-types/locations/global/entryLinkTypes/' +
               'schema-join'))
        .toBe('schema-join');
  });

  test('returns bare IDs unchanged', () => {
    expect(entryIdOf('bare_entry_id')).toBe('bare_entry_id');
    expect(entryIdOf('retail_sales.entities.store_orders'))
        .toBe('retail_sales.entities.store_orders');
    expect(entryIdOf('retail_sales/entities/store_orders'))
        .toBe('retail_sales/entities/store_orders');
  });
});

describe('slug', () => {
  test(
      'slug preserves letters, digits, underscores, dots and hyphens, mapping others to _',
      () => {
        expect(slug('retail_sales.v1-test/name with spaces'))
            .toBe('retail_sales.v1-test_name_with_spaces');
      });
});
