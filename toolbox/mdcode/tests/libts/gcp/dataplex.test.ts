// Behavior spec for the entry-link client methods added for KC push
// reconciliation: CatalogClient.lookupEntryLinks (paginated, location-scoped
// custom verb) and CatalogClient.deleteEntryLink. Spies on the low-level
// _get/_delete so it pins the exact URL + query-param shape without a live
// Dataplex.

import {describe, expect, spyOn, test} from 'bun:test';

import {ApiContext} from '../../../src/libts/gcp/context';
import {CatalogClient, EntryLink} from '../../../src/libts/gcp/dataplex';

const CTX = new ApiContext('test-project', 'us', 'test-token');
const SCHEMA_JOIN =
    'projects/dataplex-types/locations/global/entryLinkTypes/schema-join';
const ENTRY = 'projects/proj/locations/us/entryGroups/g/entries/e1';

function link(id: string): EntryLink {
  return {
    name: `projects/proj/locations/us/entryGroups/g/entryLinks/${id}`,
    entryLinkType: SCHEMA_JOIN,
    entryReferences: [],
  };
}

function idOf(l: EntryLink): string {
  return l.name!.split('/').pop()!;
}

describe('CatalogClient.lookupEntryLinks', () => {
  test('issues a location-scoped :lookupEntryLinks GET with entry + filters',
     async () => {
       const client = new CatalogClient(CTX);
       const get = spyOn(client as any, '_get')
                       .mockImplementation(
                           async () =>
                               ({status: 200, result: {entryLinks: [link('a')]}}));

       const res = await client.lookupEntryLinks('proj', 'us', {
         entry: ENTRY,
         entryLinkTypes: [SCHEMA_JOIN],
         entryMode: 'SOURCE',
       });

       expect(res.status).toBe(200);
       expect(res.result?.map(idOf)).toEqual(['a']);
       expect(get).toHaveBeenCalledTimes(1);
       const [url, params] = get.mock.calls[0] as [string, any];
       expect(url).toBe('projects/proj/locations/us:lookupEntryLinks');
       expect(params.entry).toBe(ENTRY);
       expect(params.entryLinkTypes).toEqual([SCHEMA_JOIN]);
       expect(params.entryMode).toBe('SOURCE');
       expect(params.pageSize).toBe(10);
     });

  test('drains every page and flattens the links', async () => {
    const client = new CatalogClient(CTX);
    let call = 0;
    const get = spyOn(client as any, '_get').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          status: 200,
          result: {entryLinks: [link('a'), link('b')], nextPageToken: 'T'},
        };
      }
      return {status: 200, result: {entryLinks: [link('c')]}};
    });

    const res = await client.lookupEntryLinks('proj', 'us', {entry: ENTRY});

    expect(get).toHaveBeenCalledTimes(2);
    // The second page must carry the token the first page returned.
    expect((get.mock.calls[1][1] as any).pageToken).toBe('T');
    expect(res.result?.map(idOf)).toEqual(['a', 'b', 'c']);
  });

  test('a non-200 page aborts and is returned as-is', async () => {
    const client = new CatalogClient(CTX);
    const get =
        spyOn(client as any, '_get')
            .mockImplementation(async () => ({status: 403, message: 'denied'}));

    const res = await client.lookupEntryLinks('proj', 'us', {entry: ENTRY});

    expect(res.status).toBe(403);
    expect(res.message).toBe('denied');
    expect(res.result).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('an entry with no links returns an empty list, not undefined',
     async () => {
       const client = new CatalogClient(CTX);
       spyOn(client as any, '_get')
           .mockImplementation(async () => ({status: 200, result: {}}));

       const res = await client.lookupEntryLinks('proj', 'us', {entry: ENTRY});

       expect(res.status).toBe(200);
       expect(res.result).toEqual([]);
     });
});

describe('CatalogClient.deleteEntryLink', () => {
  test('DELETEs the fully-qualified entry-link resource', async () => {
    const client = new CatalogClient(CTX);
    const del = spyOn(client as any, '_delete')
                    .mockImplementation(async () => ({status: 200}));

    await client.deleteEntryLink('proj', 'us', 'grp', 'my-link');

    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0][0])
        .toBe('projects/proj/locations/us/entryGroups/grp/entryLinks/my-link');
  });
});
