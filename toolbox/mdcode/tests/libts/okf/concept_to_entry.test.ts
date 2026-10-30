import {describe, expect, test} from 'bun:test';

import {OVERVIEW_ASPECT_KEY} from '../../../src/libts/okf/catalog_residue';
import {Concept, RESIDUE_KEY} from '../../../src/libts/okf/concept';
import {
  ConceptError,
  conceptToEntry,
} from '../../../src/libts/okf/concept_to_entry';

const GROUP = 'projects/p/locations/us/entryGroups/kb';
const DOCUMENT = 'projects/dataplex-types/locations/global/entryTypes/document';
const DOC_FACET = 'dataplex-types.global.document';

function concept(
  frontmatter: Record<string, unknown>,
  body = 'hello\n',
  id = 'assets/t',
): Concept {
  return {id, frontmatter, body};
}

function withResidue(
  residue: Record<string, unknown>,
  rest: Record<string, unknown> = {},
  body = 'hello\n',
): Concept {
  return concept({...rest, [RESIDUE_KEY]: {v: 1, ...residue}}, body);
}

describe('conceptToEntry', () => {
  test('names the entry from the group and the concept id', () => {
    const e = conceptToEntry(withResidue({entryType: DOCUMENT}), GROUP);
    expect(e.name).toBe(`${GROUP}/entries/assets/t`);
    expect(e.entryType).toBe(DOCUMENT);
  });

  test('restores the parent entry', () => {
    const e = conceptToEntry(
      withResidue({entryType: DOCUMENT, parentEntry: `${GROUP}/entries/assets`}),
      GROUP,
    );
    expect(e.parentEntry).toBe(`${GROUP}/entries/assets`);
  });

  test('merges OKF keys and stashed fields into entrySource', () => {
    const e = conceptToEntry(
      withResidue(
        {entryType: DOCUMENT, entrySource: {system: 'BIGQUERY', platform: 'GCP'}},
        {title: 'Jobs', description: 'Job metadata', resource: 'bq://t'},
      ),
      GROUP,
    );
    expect(e.entrySource).toEqual({
      system: 'BIGQUERY',
      platform: 'GCP',
      displayName: 'Jobs',
      description: 'Job metadata',
      resource: 'bq://t',
    });
  });

  test('restores stashed aspects', () => {
    const e = conceptToEntry(
      withResidue({
        entryType: DOCUMENT,
        aspects: {'dataplex-types.global.queries': {queries: [{sql: 'SELECT 1'}]}},
      }),
      GROUP,
    );
    expect(e.aspects?.['dataplex-types.global.queries']).toEqual({
      data: {queries: [{sql: 'SELECT 1'}]},
    });
  });

  test('puts the concept type back on the aspect it came from', () => {
    const e = conceptToEntry(
      withResidue(
        {entryType: DOCUMENT, aspects: {[DOC_FACET]: {job: {name: 'enrich-1'}}}},
        {type: 'context-overlay'},
      ),
      GROUP,
    );
    expect(e.aspects?.[DOC_FACET]).toEqual({
      data: {type: 'context-overlay', job: {name: 'enrich-1'}},
    });
  });

  test('puts the type back on an aspect stashed empty', () => {
    const e = conceptToEntry(
      withResidue(
        {entryType: DOCUMENT, aspects: {[DOC_FACET]: {}}},
        {type: 'table-context'},
      ),
      GROUP,
    );
    expect(e.aspects?.[DOC_FACET]).toEqual({data: {type: 'table-context'}});
  });

  test('does not invent an aspect for a type read off the entry type', () => {
    const e = conceptToEntry(
      withResidue({entryType: DOCUMENT}, {type: 'document'}),
      GROUP,
    );
    expect(e.aspects?.[DOC_FACET]).toBeUndefined();
  });

  test('rebuilds the overview aspect from the body', () => {
    const e = conceptToEntry(withResidue({entryType: DOCUMENT}), GROUP);
    expect(e.aspects?.[OVERVIEW_ASPECT_KEY]).toEqual({
      data: {content: 'hello\n', contentType: 'MARKDOWN'},
    });
  });

  test('marks the overview as markdown so it does not render raw', () => {
    const e = conceptToEntry(withResidue({entryType: DOCUMENT}), GROUP);
    expect((e.aspects?.[OVERVIEW_ASPECT_KEY] as any).data.contentType).toBe(
      'MARKDOWN',
    );
  });

  test('keeps the file body verbatim by default', () => {
    const e = conceptToEntry(
      withResidue({entryType: DOCUMENT}, {}, '# Title\n\nbody\n'),
      GROUP,
    );
    expect((e.aspects?.[OVERVIEW_ASPECT_KEY] as any).data.content).toBe(
      '# Title\n\nbody\n',
    );
  });

  test('drops the newline the writer added when the body had none', () => {
    const e = conceptToEntry(
      withResidue({entryType: DOCUMENT, trailingNewline: false}, {}, 'bare\n'),
      GROUP,
    );
    expect((e.aspects?.[OVERVIEW_ASPECT_KEY] as any).data.content).toBe('bare');
  });

  test('writes no overview aspect for an empty body', () => {
    const e = conceptToEntry(withResidue({entryType: DOCUMENT}, {}, ''), GROUP);
    expect(e.aspects?.[OVERVIEW_ASPECT_KEY]).toBeUndefined();
  });

  test('a pure OKF concept without x-kcmd defaults to document entryType and infers document.type and parent', () => {
    const e = conceptToEntry(
      concept(
        {
          type: 'Table',
          title: 'bikeshare_trips',
          resource: 'bigquery.googleapis.com/projects/p/datasets/d/tables/t',
          tags: ['trips', 'austin'],
          status: 'verified',
        },
        '# bikeshare_trips\n\nBody.\n',
        'tables/bikeshare_trips',
      ),
      GROUP,
    );
    expect(e.name).toBe(`${GROUP}/entries/tables/bikeshare_trips`);
    expect(e.entryType).toBe(DOCUMENT);
    expect(e.parentEntry).toBe(`${GROUP}/entries/tables`);
    expect(e.aspects?.[DOC_FACET]).toEqual({data: {type: 'table-context'}});
    expect((e.aspects?.[OVERVIEW_ASPECT_KEY] as any).data.content).toContain(
      '## OKF Metadata',
    );
    expect((e.aspects?.[OVERVIEW_ASPECT_KEY] as any).data.content).toContain(
      'status: verified',
    );
  });

  test('maps pure OKF root index.md to agents and <dir>/index.md to <dir>', () => {
    const rootIdx = conceptToEntry(
      concept({okf_version: '0.2'}, '# Austin bikeshare knowledge\n', 'index'),
      GROUP,
    );
    expect(rootIdx.name).toBe(`${GROUP}/entries/agents`);
    expect(rootIdx.parentEntry).toBeUndefined();
    expect(rootIdx.entrySource?.displayName).toBe('Austin bikeshare knowledge');
    expect(rootIdx.aspects?.[DOC_FACET]).toEqual({
      data: {type: 'knowledge-base'},
    });

    const dirIdx = conceptToEntry(
      concept({}, '# Tables\n', 'tables/index'),
      GROUP,
    );
    expect(dirIdx.name).toBe(`${GROUP}/entries/tables`);
    expect(dirIdx.parentEntry).toBe(`${GROUP}/entries/agents`);
    expect(dirIdx.entrySource?.displayName).toBe('Tables');
    expect(dirIdx.aspects?.[DOC_FACET]).toEqual({
      data: {type: 'knowledge-base-index'},
    });
  });

  test('accepts extra frontmatter block as an alias for x-kcmd residue', () => {
    const e = conceptToEntry(
      concept(
        {
          type: 'Runbook',
          title: 'ops-sop',
          extra: {
            type: DOCUMENT,
            resource: {
              parent: `${GROUP}/entries/docs`,
              system: 'KnowledgeCatalog',
            },
          },
        },
        '# ops-sop\n',
        'docs/ops-sop',
      ),
      GROUP,
    );
    expect(e.entryType).toBe(DOCUMENT);
    expect(e.parentEntry).toBe(`${GROUP}/entries/docs`);
    expect(e.entrySource?.system).toBe('KnowledgeCatalog');
    expect(e.aspects?.[DOC_FACET]).toEqual({data: {type: 'runbook'}});
  });

  test('does not inject a spurious type property onto a query-template aspect', () => {
    const qtType =
      'projects/dataplex-types/locations/global/entryTypes/query-template';
    const qtAspect = 'dataplex-types.global.query-template';
    const e = conceptToEntry(
      withResidue(
        {
          entryType: qtType,
          aspects: {
            [qtAspect]: {
              query: 'SELECT 1',
              nlQuery: 'one',
              intent: 'test',
              sourceType: 'BIGQUERY',
            },
          },
        },
        {type: 'query-template'},
      ),
      GROUP,
    );
    expect(e.aspects?.[qtAspect]).toEqual({
      data: {
        query: 'SELECT 1',
        nlQuery: 'one',
        intent: 'test',
        sourceType: 'BIGQUERY',
      },
    });
  });

  test('preserves query-template entryType via extra.type and strips unsupported parameter keys', () => {
    const qtType =
      'projects/dataplex-types/locations/global/entryTypes/query-template';
    const qtAspect = 'dataplex-types.global.query-template';
    const e = conceptToEntry(
      concept(
        {
          type: 'Query Template',
          title: 'Trips by subscriber type',
          extra: {
            type: qtType,
            aspects: {
              [qtAspect]: {
                query: 'SELECT COUNT(*) FROM t WHERE subscriber_type = @sub',
                nlQuery: 'How many trips by @sub?',
                intent: 'Count trips for a subscriber type',
                sourceType: 'BIGQUERY',
                sourceDialect: 'GOOGLE_SQL',
                parameters: [
                  {
                    name: 'sub',
                    type: 'STRING',
                    description: 'Subscriber type',
                    sampleValues: ['Local365'],
                    required: true,
                  },
                ],
              },
            },
          },
        },
        '# Trips by subscriber type\n',
        'query-context/templates/trips-by-subscriber-type',
      ),
      GROUP,
    );
    expect(e.entryType).toBe(qtType);
    expect(e.aspects?.[DOC_FACET]).toBeUndefined();
    expect(e.aspects?.[qtAspect]?.data?.['parameters']).toEqual([
      {
        name: 'sub',
        type: 'STRING',
        description: 'Subscriber type',
        sampleValues: ['Local365'],
      },
    ]);
  });

  test('a non-index concept with no entryType and no frontmatter type is refused', () => {
    expect(() => conceptToEntry(concept({}), GROUP)).toThrow(ConceptError);
  });
});
