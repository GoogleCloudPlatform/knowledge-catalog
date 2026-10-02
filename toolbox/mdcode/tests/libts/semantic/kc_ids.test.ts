// Unit tests for Knowledge Catalog ID helpers (src/libts/semantic/kc_ids.ts).

import {describe, expect, test} from 'bun:test';

import {Entity, Metric, Relationship, SemanticModel} from '../../../src/libts/semantic/ir';
import {entryIdOf, linkSlug, Namer, NamerOptions, ownedEntryIdPrefixes, relationshipLinkId, slug} from '../../../src/libts/semantic/kc_ids';

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

describe('Namer entry and link IDs under v2Aspects flag states', () => {
  test('flag off (default / false) emits dotted entry IDs', () => {
    const names = new Namer(BASE_OPTS);
    expect(names.modelId(MODEL)).toBe('retail_sales');
    expect(names.entityId(MODEL, ENTITY))
        .toBe('retail_sales.entities.store_orders');
    expect(names.metricId(MODEL, METRIC))
        .toBe('retail_sales.metrics.total_revenue');
    expect(names.linkId(MODEL, REL)).toBe('retail-sales-order-customer');
    expect(names.entry(names.entityId(MODEL, ENTITY)))
        .toBe(
            'projects/p/locations/us/entryGroups/default/entries/' +
            'retail_sales.entities.store_orders');
    expect(names.entryLink(names.linkId(MODEL, REL)))
        .toBe(
            'projects/p/locations/us/entryGroups/default/entryLinks/' +
            'retail-sales-order-customer');
  });

  test(
      'flag on (v2Aspects: true) emits slash-separated entry IDs and same linkId',
      () => {
        const names = new Namer({...BASE_OPTS, v2Aspects: true});
        expect(names.modelId(MODEL)).toBe('retail_sales');
        expect(names.entityId(MODEL, ENTITY))
            .toBe('retail_sales/entities/store_orders');
        expect(names.metricId(MODEL, METRIC))
            .toBe('retail_sales/metrics/total_revenue');
        expect(names.linkId(MODEL, REL)).toBe('retail-sales-order-customer');
        expect(names.entry(names.entityId(MODEL, ENTITY)))
            .toBe(
                'projects/p/locations/us/entryGroups/default/entries/' +
                'retail_sales/entities/store_orders');
        expect(names.entryLink(names.linkId(MODEL, REL)))
            .toBe(
                'projects/p/locations/us/entryGroups/default/entryLinks/' +
                'retail-sales-order-customer');
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

describe('Namer.fileEntryId', () => {
  test('plain model file', () => {
    const names = new Namer(BASE_OPTS);
    expect(names.fileEntryId('retail_sales', 'retail_sales.yaml'))
        .toBe('retail_sales.files.retail_sales.yaml');
  });

  test('profile file keeps its dots and repeats the model name', () => {
    const names = new Namer(BASE_OPTS);
    expect(names.fileEntryId('retail_sales', 'retail_sales.profile.prod.yaml'))
        .toBe('retail_sales.files.retail_sales.profile.prod.yaml');
  });
});

describe('ownedEntryIdPrefixes', () => {
  test(
      'returns seven prefixes with no slash form for actions, constraints or files',
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

describe('relationshipLinkId', () => {
  test('matches Namer.linkId', () => {
    const names = new Namer(BASE_OPTS);
    expect(relationshipLinkId(MODEL.name, REL.name))
        .toBe(names.linkId(MODEL, REL));
  });

  test(
      'collapses two distinct relationship names that normalize to the same link ID',
      () => {
        expect(relationshipLinkId('retail_sales', 'order_customer'))
            .toBe(relationshipLinkId('retail_sales', 'Order--Customer'));
      });
});

describe('slug and linkSlug', () => {
  test(
      'slug preserves letters, digits, underscores, dots and hyphens, mapping others to _',
      () => {
        expect(slug('retail_sales.v1-test/name with spaces'))
            .toBe('retail_sales.v1-test_name_with_spaces');
      });

  test('linkSlug maps characters outside [a-z0-9-] to hyphens', () => {
    expect(linkSlug('a_b.c/d:e@f')).toBe('a-b-c-d-e-f');
  });

  test('linkSlug lowercases and collapses runs of hyphens', () => {
    expect(linkSlug('Retail___Sales---Order')).toBe('retail-sales-order');
  });

  test('linkSlug strips leading non-letters and edge hyphens', () => {
    expect(linkSlug('123-_-order_customer---')).toBe('order-customer');
  });

  test(
      'linkSlug truncates at 63 chars and strips any trailing hyphen exposed by truncation',
      () => {
        // 62 'a's + '_' + 'b' -> 62nd index (63rd char) is '-', which must be
        // stripped after slicing to 63 chars.
        const input = `${'a'.repeat(62)}_b`;
        const result = linkSlug(input);
        expect(result.length).toBe(62);
        expect(result).toBe('a'.repeat(62));
      });

  test('linkSlug falls back to "link" when no usable letters remain', () => {
    expect(linkSlug('12345___---...')).toBe('link');
    expect(linkSlug('')).toBe('link');
  });
});
