// Behavior spec for the entry-link client methods added for KC push
// reconciliation: CatalogClient.lookupEntryLinks (paginated, location-scoped
// custom verb) and CatalogClient.deleteEntryLink. Spies on the low-level
// _get/_delete so it pins the exact URL + query-param shape without a live
// Dataplex.

import {describe, expect, spyOn, test} from 'bun:test';

import {ApiContext} from '../../../src/libts/gcp/context';
import {ResourceManagerClient} from '../../../src/libts/gcp/crm';
import {_fixEntry, CatalogClient, Entry, EntryLink, FixOptions} from '../../../src/libts/gcp/dataplex';

const CTX = new ApiContext('test-project', 'us', 'test-token');
const SCHEMA_JOIN =
    'projects/dataplex-types/locations/global/entryLinkTypes/schema-join';
const GUIDELINES_TYPE =
    'projects/dataplex-types/locations/global/aspectTypes/guidelines';
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

describe('_fixEntry path-keyed aspects', () => {
  test('writing: keeps entity-level and two field-level guidelines keys, normalises aspectType, and keeps path',
     async () => {
       const entry: Entry = {
         name: ENTRY,
         entryType: 'projects/dataplex-types/locations/global/entryTypes/generic',
         aspects: {
           'dataplex-types.global.guidelines': {
             data: {instructions: 'Orders entity instructions'},
           },
           'dataplex-types.global.guidelines@Schema.order_id': {
             path: 'Schema.order_id',
             data: {instructions: 'Unique order ID'},
           },
           'dataplex-types.global.guidelines@Schema.customer_id': {
             path: 'Schema.customer_id',
             data: {instructions: 'Customer foreign key'},
           },
         },
       };

       await _fixEntry(entry, CTX);

       expect(Object.keys(entry.aspects!)).toEqual([
         'dataplex-types.global.guidelines',
         'dataplex-types.global.guidelines@Schema.order_id',
         'dataplex-types.global.guidelines@Schema.customer_id',
       ]);
       expect(entry.aspects!['dataplex-types.global.guidelines']).toEqual({
         aspectType: GUIDELINES_TYPE,
         data: {instructions: 'Orders entity instructions'},
       });
       expect(entry.aspects!['dataplex-types.global.guidelines@Schema.order_id'])
           .toEqual({
             aspectType: GUIDELINES_TYPE,
             path: 'Schema.order_id',
             data: {instructions: 'Unique order ID'},
           });
       expect(entry.aspects!['dataplex-types.global.guidelines@Schema.customer_id'])
           .toEqual({
             aspectType: GUIDELINES_TYPE,
             path: 'Schema.customer_id',
             data: {instructions: 'Customer foreign key'},
           });
     });

  test('reading: handles @Schema.<field> keys when API omits path and when numeric project id is normalised via crm.fixProject',
     async () => {
       const entry: Entry = {
         name: ENTRY,
         entryType: 'projects/655216118709/locations/global/entryTypes/generic',
         aspects: {
           'dataplex-types.global.guidelines@Schema.order_id': {
             aspectType: GUIDELINES_TYPE,
             data: {instructions: 'Unique order ID'},
           },
           '655216118709.global.guidelines@Schema.customer_id': {
             aspectType:
                 'projects/655216118709/locations/global/aspectTypes/guidelines',
             path: 'Schema.customer_id',
             data: {instructions: 'Customer foreign key'},
           },
         },
       };

       await _fixEntry(entry, CTX);

       expect(Object.keys(entry.aspects!)).toEqual([
         'dataplex-types.global.guidelines@Schema.order_id',
         'dataplex-types.global.guidelines@Schema.customer_id',
       ]);
       expect(entry.aspects!['dataplex-types.global.guidelines@Schema.order_id'])
           .toEqual({
             aspectType: GUIDELINES_TYPE,
             path: 'Schema.order_id',
             data: {instructions: 'Unique order ID'},
           });
       expect(entry.aspects!['dataplex-types.global.guidelines@Schema.customer_id'])
           .toEqual({
             aspectType: GUIDELINES_TYPE,
             path: 'Schema.customer_id',
             data: {instructions: 'Customer foreign key'},
           });
     });
});

// An update with deleteMissingAspects answers with each aspect it removed
// listed under its key with an empty value.
describe('_fixEntry removed aspects', () => {
  test('drops an aspect whose value is empty or null, at entry level and at ' +
           'a field path, and keeps the others',
       async () => {
         const lookup = spyOn(ResourceManagerClient.prototype, 'getProject')
                            .mockResolvedValue(
                                {status: 200, result: {projectId: 'types'}} as
                                any);
         const entry: Entry = {
           name: ENTRY,
           entryType:
               'projects/655216118709/locations/global/entryTypes/generic',
           aspects: {
             '655216118709.global.schema': {
               aspectType:
                   'projects/655216118709/locations/global/aspectTypes/schema',
               data: {fields: []},
             },
             '418487367933.global.guidelines': {},
             '418487367933.global.guidelines@Schema.amount': {},
             '418487367933.global.sql-expressions': null as any,
           },
         };

         await _fixEntry(entry, CTX);

         expect(entry.aspects).toEqual({
           'dataplex-types.global.schema': {
             aspectType:
                 'projects/dataplex-types/locations/global/aspectTypes/schema',
             data: {fields: []},
           },
         });
         // A removed aspect needs no project lookup.
         expect(lookup).not.toHaveBeenCalled();
         lookup.mockRestore();
       });
});


describe('CatalogClient.lookupEntryAspectTypes', () => {
  test('reads the FULL view and names each aspect type once, with a project ID',
       async () => {
         const client = new CatalogClient(CTX);
         const get = spyOn(client as any, '_get').mockImplementation(async () => ({
           status: 200,
           result: {
             name: ENTRY,
             aspects: {
               // A FULL read gives no data to an aspect the type does not require.
               'dataplex-types.global.overview': {},
               '655216118709.global.guidelines@Schema.order_id': {},
               'dataplex-types.global.guidelines@Schema.customer_id': {},
             },
           },
         }));

         const res = await client.lookupEntryAspectTypes('proj', 'us', ENTRY);

         expect(get.mock.calls[0].slice(0, 2)).toEqual(
             ['projects/proj/locations/us:lookupEntry', {entry: ENTRY, view: 'FULL'}]);
         expect(res).toEqual({
           status: 200,
           result: ['dataplex-types.global.overview', 'dataplex-types.global.guidelines'],
         });
       });

  test('looks up an unreadable project once per aspect type', async () => {
    const client = new CatalogClient(CTX);
    spyOn(client as any, '_get').mockImplementation(async () => ({
      status: 200,
      result: {
        name: ENTRY,
        aspects: {
          '111.global.guidelines@Schema.order_id': {},
          '111.global.guidelines@Schema.customer_id': {},
        },
      },
    }));
    // Resource Manager cannot read the project, and crm caches only the
    // projects it can read.
    const lookup = spyOn(ResourceManagerClient.prototype, 'getProject')
                       .mockResolvedValue({status: 403} as any);

    const res = await client.lookupEntryAspectTypes('proj', 'us', ENTRY);

    expect(res.result).toEqual(['111.global.guidelines']);
    expect(lookup).toHaveBeenCalledTimes(1);
    lookup.mockRestore();
  });
});

// Dataplex keeps an aspect that aspectKeys names and the body leaves out
// unless deleteMissingAspects is set, so a caller that means to remove one has
// to send it.
describe('CatalogClient.updateEntry', () => {
  test('sends deleteMissingAspects only when asked to', async () => {
    const client = new CatalogClient(CTX);
    const patch = spyOn(client as any, '_patch')
                      .mockImplementation(async () => ({status: 404}));
    const entry = {name: ENTRY, aspects: {}} as Entry;

    await client.updateEntry(entry, ['aspects'], ['p.global.guidelines'], true);
    await client.updateEntry(entry, ['aspects'], ['p.global.guidelines']);

    expect(patch.mock.calls[0][2]).toEqual({
      updateMask: 'aspects',
      aspectKeys: ['p.global.guidelines'],
      deleteMissingAspects: true,
    });
    expect(patch.mock.calls[1][2]).toEqual({
      updateMask: 'aspects',
      aspectKeys: ['p.global.guidelines'],
    });
  });

  test('returns the updated entry without the aspects the update removed',
       async () => {
         const client = new CatalogClient(CTX);
         // The response Dataplex gives for an update that removed guidelines.
         spyOn(client as any, '_patch').mockImplementation(async () => ({
           status: 200,
           result: {
             name: ENTRY,
             entryType:
                 'projects/655216118709/locations/global/entryTypes/generic',
             aspects: {
               '655216118709.global.overview': {
                 aspectType: 'projects/655216118709/locations/global/' +
                     'aspectTypes/overview',
                 data: {content: 'text'},
               },
               '655216118709.global.guidelines': {},
             },
           },
         }));
         const entry = {name: ENTRY, aspects: {}} as Entry;

         const res = await client.updateEntry(
             entry, ['aspects'],
             ['dataplex-types.global.overview', 'dataplex-types.global.guidelines'],
             true);

         expect(res.status).toBe(200);
         expect(Object.keys(res.result!.aspects!)).toEqual([
           'dataplex-types.global.overview',
         ]);
       });
});


describe('entrySource.resource on a read', () => {
  // A relative name whose project is a number.
  const RESOURCE = 'projects/97531/locations/us/things/t';
  const REWRITTEN = 'projects/other-proj/locations/us/things/t';
  const raw = (): Entry => ({
    name: 'projects/proj/locations/us/entryGroups/g/entries/e',
    entryType: 'projects/dataplex-types/locations/global/entryTypes/x',
    entrySource: {resource: RESOURCE},
  });

  // Push passes keepSourceResource, since it writes the value back. Every
  // other caller gets the project id.
  test('listEntries and getEntry rewrite it by default and keep it as ' +
           'stored on request',
       async () => {
         const client = new CatalogClient(CTX);
         spyOn(client as any, '_get')
             .mockImplementation(
                 async (name: string) => name.endsWith('/entries') ?
                     {status: 200, result: {entries: [raw()]}} :
                     {status: 200, result: raw()});
         const lookup =
             spyOn(ResourceManagerClient.prototype, 'getProject')
                 .mockResolvedValue(
                     {status: 200, result: {projectId: 'other-proj'}} as any);
         const listed = async (fix?: FixOptions) => {
           const resources: (string|undefined)[] = [];
           for await (const e of client.listEntries('proj', 'us', 'g', fix)) {
             resources.push(e.entrySource?.resource);
           }
           return resources[0];
         };
         const got = async (fix?: FixOptions) =>
             (await client.getEntry('proj', 'us', 'g', 'e', undefined, fix))
                 .result?.entrySource?.resource;

         expect(await listed()).toBe(REWRITTEN);
         expect(await got()).toBe(REWRITTEN);
         expect(await listed({keepSourceResource: true})).toBe(RESOURCE);
         expect(await got({keepSourceResource: true})).toBe(RESOURCE);
         lookup.mockRestore();
       });
});
