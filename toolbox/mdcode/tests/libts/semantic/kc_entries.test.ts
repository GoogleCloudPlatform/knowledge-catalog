// Unit tests for Knowledge Catalog Entry and EntryLink helpers
// (src/libts/semantic/kc_entries.ts).

import {describe, expect, test} from 'bun:test';

import {
  Entry,
  EntryLink,
  EntryReference,
} from '../../../src/libts/gcp/dataplex';
import {collectCustomTypes} from '../../../src/libts/semantic/kc_custom_types';
import {
  anchorId,
  collectEntityNames,
  collectOwnedEntries,
  entryAspectKeys,
  entryId,
  entryTypeId,
  isAnchorEntry,
  isDependentEntry,
  isEntityEntry,
  isEntryOwner,
  isExploreEntry,
  isLinkOwner,
  isMetricEntry,
  isModelEntry,
  isRelationshipLink,
  KcAnchor,
  linkId,
  linkTypeId,
  sameLinkReferences,
} from '../../../src/libts/semantic/kc_entries';
import {KcResources} from '../../../src/libts/semantic/knowledge_catalog';

const MODEL_TYPE =
    'projects/dataplex-types/locations/global/entryTypes/semantic-model';
const ENTITY_TYPE =
    'projects/dataplex-types/locations/global/entryTypes/semantic-entity';
const METRIC_TYPE =
    'projects/dataplex-types/locations/global/entryTypes/semantic-metric';
const EXPLORE_TYPE =
    'projects/dataplex-types/locations/global/entryTypes/semantic-explore';
const ACTION_TYPE =
    'projects/dest/locations/global/entryTypes/semantic-action';
const CONSTRAINT_TYPE =
    'projects/dest/locations/global/entryTypes/semantic-constraint';

const SCHEMA_JOIN_LINK_TYPE =
    'projects/dataplex-types/locations/global/entryLinkTypes/schema-join';
const RELATIONSHIP_LINK_TYPE =
    'projects/dataplex-types/locations/global/entryLinkTypes/' +
    'semantic-relationship';
const OTHER_LINK_TYPE =
    'projects/dataplex-types/locations/global/entryLinkTypes/other-link';

function makeEntry(
    id: string, entryType = ENTITY_TYPE,
    aspects?: Entry['aspects']): Entry {
  return {
    name: `projects/dest/locations/us/entryGroups/eg/entries/${id}`,
    entryType,
    ...(aspects ? {aspects} : {}),
  };
}

function makeLink(
    id: string, entryLinkType: string, refIds: string[],
    aspects?: EntryLink['aspects']): EntryLink {
  return {
    name: `projects/dest/locations/us/entryGroups/eg/entryLinks/${id}`,
    entryLinkType,
    entryReferences: refIds.map(r => ({
      name: `projects/dest/locations/us/entryGroups/eg/entries/${r}`,
      type: 'UNSPECIFIED',
    })),
    ...(aspects ? {aspects} : {}),
  };
}

describe('entryId, entryTypeId, linkId, and linkTypeId', () => {
  test('extracts bare entry IDs across V1 dotted and V2 slash layouts', () => {
    const dottedEntry = makeEntry('sales.entities.orders');
    const slashEntry = makeEntry('sales/entities/orders');

    const dottedId = entryId(dottedEntry);
    const slashId = entryId(slashEntry);

    expect(dottedId).toBe('sales.entities.orders');
    expect(slashId).toBe('sales/entities/orders');
  });

  test('extracts bare entryTypeId from a full entryType resource name', () => {
    const entity = makeEntry('sales/entities/orders', ENTITY_TYPE);

    const typeId = entryTypeId(entity);

    expect(typeId).toBe('semantic-entity');
  });

  test('extracts bare linkId and linkTypeId from an EntryLink', () => {
    const link = makeLink(
        'sales-orders-to-customer', RELATIONSHIP_LINK_TYPE,
        ['sales/entities/orders', 'sales/entities/customer']);

    const extractedLinkId = linkId(link);
    const extractedTypeId = linkTypeId(link);

    expect(extractedLinkId).toBe('sales-orders-to-customer');
    expect(extractedTypeId).toBe('semantic-relationship');
  });
});

describe('entry and link type predicates, anchorId, and custom types', () => {
  test(
      'identifies model/anchor entries and extracts anchorId only for anchors',
      () => {
        const modelEntry = makeEntry('sales', MODEL_TYPE);
        const entityEntry = makeEntry('sales.entities.orders', ENTITY_TYPE);

        expect(isModelEntry(modelEntry)).toBe(true);
        expect(isAnchorEntry(modelEntry)).toBe(true);
        expect(anchorId(modelEntry)).toBe('sales');

        expect(isModelEntry(entityEntry)).toBe(false);
        expect(isAnchorEntry(entityEntry)).toBe(false);
        expect(anchorId(entityEntry)).toBeUndefined();
        expect(anchorId(undefined)).toBeUndefined();
      });

  test('identifies entity, metric, explore, and dependent entries', () => {
    const entity = makeEntry('sales/entities/orders', ENTITY_TYPE);
    const metric = makeEntry('sales/metrics/revenue', METRIC_TYPE);
    const explore = makeEntry('sales/explores/orders', EXPLORE_TYPE);
    const action = makeEntry('sales.actions.refund', ACTION_TYPE);

    expect(isEntityEntry(entity)).toBe(true);
    expect(isDependentEntry(entity)).toBe(false);

    expect(isMetricEntry(metric)).toBe(true);
    expect(isDependentEntry(metric)).toBe(true);

    expect(isExploreEntry(explore)).toBe(true);
    expect(isDependentEntry(explore)).toBe(true);

    expect(isDependentEntry(action)).toBe(false);
  });

  test('identifies schema-join and semantic-relationship links', () => {
    const relLink = makeLink(
        'sales-orders-to-customer', RELATIONSHIP_LINK_TYPE,
        ['sales/entities/orders', 'sales/entities/customer']);
    const joinLink = makeLink(
        'sales-orders-to-customer', SCHEMA_JOIN_LINK_TYPE,
        ['sales.entities.orders', 'sales.entities.customer']);
    const otherLink = makeLink(
        'sales-orders-to-customer', OTHER_LINK_TYPE,
        ['sales.entities.orders', 'sales.entities.customer']);

    expect(isRelationshipLink(joinLink)).toBe(true);
    expect(isRelationshipLink(relLink)).toBe(true);
    expect(isRelationshipLink(otherLink)).toBe(false);
  });

  test(
      'collectCustomTypes returns deduplicated custom type IDs used by entries',
      () => {
        const entries = [
          makeEntry('sales', MODEL_TYPE),
          makeEntry('sales/entities/orders', ENTITY_TYPE),
          makeEntry('sales/entities/untyped'),
          makeEntry('sales.actions.refund', ACTION_TYPE),
          makeEntry('sales.actions.cancel', ACTION_TYPE),
          makeEntry('sales.constraints.max_refund', CONSTRAINT_TYPE),
        ];

        expect(collectCustomTypes(entries)).toEqual([
          'semantic-action',
          'semantic-constraint',
        ]);
      });
});

describe(
    'isEntryOwner, collectOwnedEntries, isLinkOwner, and collectEntityNames',
    () => {
      const RESOURCES: KcResources = {
        entries: [],
        entryLinks: [],
        ownedPrefixes: [
          'sales.entities.',
          'sales/entities/',
          'sales.metrics.',
        ],
        warnings: [],
      };

      test(
          'isEntryOwner with KcResources matches entries under non-empty ' +
              'ownedPrefixes and ignores empty prefixes',
          () => {
            const ownedDotted = makeEntry('sales.entities.orders');
            const ownedSlash = makeEntry('sales/entities/orders');
            const anchor = makeEntry('sales', MODEL_TYPE);
            const foreign = makeEntry('other.entities.orders');
            const emptyPrefixResources: KcResources = {
              ...RESOURCES,
              ownedPrefixes: [''],
            };

            expect(isEntryOwner(RESOURCES, ownedDotted)).toBe(true);
            expect(isEntryOwner(RESOURCES, ownedSlash)).toBe(true);
            expect(isEntryOwner(RESOURCES, anchor)).toBe(false);
            expect(isEntryOwner(RESOURCES, foreign)).toBe(false);
            expect(isEntryOwner(emptyPrefixResources, foreign)).toBe(false);
          });

      test(
          'isLinkOwner requires two endpoints that match ownedPrefixes for ' +
              'both KcResources and KcAnchor and rejects an empty anchorId',
          () => {
            const salesAnchor: KcAnchor = {
              anchorId: 'sales',
              ownedPrefixes: ['sales.', 'sales/'],
            };
            const emptyAnchor: KcAnchor = {
              anchorId: '',
              ownedPrefixes: ['sales.', 'sales/'],
            };
            const ownedLink = makeLink(
                'sales-orders-to-customer', SCHEMA_JOIN_LINK_TYPE,
                ['sales.entities.orders', 'sales.entities.customer']);
            const crossModelLink = makeLink(
                'sales-orders-to-external', SCHEMA_JOIN_LINK_TYPE,
                ['sales.entities.orders', 'other.entities.customer']);
            const singleEndpointLink = makeLink(
                'sales-orders-only', SCHEMA_JOIN_LINK_TYPE,
                ['sales.entities.orders']);

            expect(isLinkOwner(RESOURCES, ownedLink)).toBe(true);
            expect(isLinkOwner(RESOURCES, crossModelLink)).toBe(false);
            expect(isLinkOwner(RESOURCES, singleEndpointLink)).toBe(false);

            expect(isLinkOwner(salesAnchor, ownedLink)).toBe(true);
            expect(isLinkOwner(salesAnchor, crossModelLink)).toBe(false);
            expect(isLinkOwner(salesAnchor, singleEndpointLink)).toBe(false);
            expect(isLinkOwner(emptyAnchor, ownedLink)).toBe(false);
          });

      test(
          'collectOwnedEntries and collectEntityNames filter owned entries ' +
              'and extract semantic-entity resource names',
          () => {
            const entries: Entry[] = [
              makeEntry('sales', MODEL_TYPE),
              makeEntry('sales.entities.orders', ENTITY_TYPE),
              makeEntry('sales/entities/customer', ENTITY_TYPE),
              makeEntry('sales.metrics.revenue', METRIC_TYPE),
              makeEntry('other.entities.orders', ENTITY_TYPE),
            ];

            const owned = collectOwnedEntries(RESOURCES, entries);
            expect(owned.map(entryId)).toEqual([
              'sales.entities.orders',
              'sales/entities/customer',
              'sales.metrics.revenue',
            ]);

            const names = collectEntityNames(owned);
            expect(names).toEqual([
              'projects/dest/locations/us/entryGroups/eg/entries/' +
                  'sales.entities.orders',
              'projects/dest/locations/us/entryGroups/eg/entries/' +
                  'sales/entities/customer',
            ]);
          });

      test(
          'isEntryOwner and collectOwnedEntries with KcAnchor match the ' +
              'anchor entry and child entries across dotted and slash ID ' +
              'schemes',
          () => {
            const salesAnchor: KcAnchor = {
              anchorId: 'sales',
              ownedPrefixes: ['sales.', 'sales/'],
            };
            const emptyAnchor: KcAnchor = {
              anchorId: '',
              ownedPrefixes: [],
            };
            const entries: Entry[] = [
              makeEntry('sales', MODEL_TYPE),
              makeEntry('sales.entities.orders', ENTITY_TYPE),
              makeEntry('sales/entities/customer', ENTITY_TYPE),
              makeEntry('sales.metrics.revenue', METRIC_TYPE),
              makeEntry('sales_extra', MODEL_TYPE),
              makeEntry('other.entities.orders', ENTITY_TYPE),
            ];

            expect(isEntryOwner(emptyAnchor, entries[0]!)).toBe(false);

            const owned = collectOwnedEntries(salesAnchor, entries);
            expect(owned.map(entryId)).toEqual([
              'sales',
              'sales.entities.orders',
              'sales/entities/customer',
              'sales.metrics.revenue',
            ]);

            const entityNames = collectEntityNames(owned);
            expect(entityNames).toEqual([
              'projects/dest/locations/us/entryGroups/eg/entries/' +
                  'sales.entities.orders',
              'projects/dest/locations/us/entryGroups/eg/entries/' +
                  'sales/entities/customer',
            ]);
          });
    });

describe('entryAspectKeys', () => {
  test(
      'with v2Aspects off, entryAspectKeys returns every emitted key and ' +
          'entry-level guidelines',
      () => {
        const entity = makeEntry('sales.entities.orders', ENTITY_TYPE, {
          'dataplex-types.global.semantic-entity': {data: {}},
          'dataplex-types.global.schema': {data: {}},
          'google.com:acme.global.semantic-action': {data: {}},
        });

        const keys = entryAspectKeys(entity);

        expect(keys).toEqual(new Set([
          'dataplex-types.global.semantic-entity',
          'dataplex-types.global.schema',
          'google.com:acme.global.semantic-action',
          'dataplex-types.global.guidelines',
        ]));
      });

  test(
      'with v2Aspects on, entryAspectKeys includes sql-expressions on entity ' +
          'and metric entries and guidelines@* on entity entries',
      () => {
        const entity = makeEntry('sales/entities/orders', ENTITY_TYPE, {
          'dataplex-types.global.semantic-entity': {data: {}},
          'dataplex-types.global.schema': {data: {}},
        });
        const metric = makeEntry('sales/metrics/revenue', METRIC_TYPE, {
          'dataplex-types.global.semantic-metric': {data: {}},
        });
        const model = makeEntry('sales', MODEL_TYPE, {
          'dataplex-types.global.semantic-model': {data: {}},
        });

        const entityKeys = entryAspectKeys(entity, {v2Aspects: true});
        const metricKeys = entryAspectKeys(metric, {v2Aspects: true});
        const modelKeys = entryAspectKeys(model, {v2Aspects: true});

        expect(entityKeys).toEqual(new Set([
          'dataplex-types.global.semantic-entity',
          'dataplex-types.global.schema',
          'dataplex-types.global.guidelines',
          'dataplex-types.global.sql-expressions',
          'dataplex-types.global.guidelines@*',
        ]));
        expect(metricKeys).toEqual(new Set([
          'dataplex-types.global.semantic-metric',
          'dataplex-types.global.guidelines',
          'dataplex-types.global.sql-expressions',
        ]));
        expect(modelKeys).toEqual(new Set([
          'dataplex-types.global.semantic-model',
          'dataplex-types.global.guidelines',
        ]));
      });

  test(
      'entryAspectKeys respects systemTypeProject and systemTypeLocation ' +
          'overrides',
      () => {
        const entityEntry = makeEntry('sales/entities/orders', ENTITY_TYPE, {
          'staging-types.us.semantic-entity': {data: {}},
        });
        const opts = {
          systemTypeProject: 'staging-types',
          systemTypeLocation: 'us',
          v2Aspects: true,
        };

        const keys = entryAspectKeys(entityEntry, opts);

        expect(keys).toEqual(new Set([
          'staging-types.us.semantic-entity',
          'staging-types.us.guidelines',
          'staging-types.us.sql-expressions',
          'staging-types.us.guidelines@*',
        ]));
      });
});

describe('sameLinkReferences', () => {
  function linkWithRefs(entryReferences: EntryReference[]): EntryLink {
    return {
      entryLinkType: RELATIONSHIP_LINK_TYPE,
      entryReferences,
    };
  }

  test(
      'returns true when bare entry IDs, types, and paths match even across ' +
          'project number vs ID',
      () => {
        // The server may return a project number in `name` while the emitter
        // uses the project ID.
        const serverLink = linkWithRefs([
          {
            name: 'projects/123456/locations/us/entryGroups/eg/entries/' +
                'sales/entities/orders',
            type: 'SOURCE',
            path: '',
          },
          {
            name: 'projects/123456/locations/us/entryGroups/eg/entries/' +
                'sales/entities/customer',
            type: 'TARGET',
          },
        ]);
        const emittedLink = linkWithRefs([
          {
            name: 'projects/dest/locations/us/entryGroups/eg/entries/' +
                'sales/entities/orders',
            type: 'SOURCE',
          },
          {
            name: 'projects/dest/locations/us/entryGroups/eg/entries/' +
                'sales/entities/customer',
            type: 'TARGET',
            path: '',
          },
        ]);

        expect(sameLinkReferences(serverLink, emittedLink)).toBe(true);
      });

  test(
      'returns true when two UNSPECIFIED schema-join references come back in ' +
          'the opposite order or omit the default UNSPECIFIED type',
      () => {
        // Proto3 JSON serialization on the server may omit `type` when it holds
        // the default enum value (`UNSPECIFIED`), while the emitter sets
        // `type: 'UNSPECIFIED'`.
        const serverLink = linkWithRefs([
          {
            name: 'projects/dest/locations/us/entryGroups/eg/entries/' +
                'sales.entities.customer',
          } as EntryReference,
          {
            name: 'projects/dest/locations/us/entryGroups/eg/entries/' +
                'sales.entities.orders',
          } as EntryReference,
        ]);
        const emittedLink = makeLink(
            'sales-orders-to-customer', SCHEMA_JOIN_LINK_TYPE,
            ['sales.entities.orders', 'sales.entities.customer']);

        expect(sameLinkReferences(serverLink, emittedLink)).toBe(true);
      });

  test(
      'returns false when V1 dotted entry IDs change to V2 slash entry IDs ' +
          'or types/paths differ',
      () => {
        const v1Link = makeLink(
            'sales-orders-to-customer', SCHEMA_JOIN_LINK_TYPE,
            ['sales.entities.orders', 'sales.entities.customer']);
        const v2Link = makeLink(
            'sales-orders-to-customer', SCHEMA_JOIN_LINK_TYPE,
            ['sales/entities/orders', 'sales/entities/customer']);
        const differentTypeLink = linkWithRefs([
          {...v2Link.entryReferences[0]!, type: 'SOURCE'},
          {...v2Link.entryReferences[1]!, type: 'TARGET'},
        ]);
        const differentPathLink = linkWithRefs([
          {...v2Link.entryReferences[0]!, path: 'Schema.o_custkey'},
          v2Link.entryReferences[1]!,
        ]);
        const singleRefLink = linkWithRefs([v2Link.entryReferences[0]!]);

        expect(sameLinkReferences(v1Link, v2Link)).toBe(false);
        expect(sameLinkReferences(v2Link, differentTypeLink)).toBe(false);
        expect(sameLinkReferences(v2Link, differentPathLink)).toBe(false);
        expect(sameLinkReferences(v2Link, singleRefLink)).toBe(false);
      });
});
