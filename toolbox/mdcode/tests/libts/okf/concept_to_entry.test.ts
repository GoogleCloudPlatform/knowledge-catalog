import {describe, expect, spyOn, test} from 'bun:test';

import {OVERVIEW_ASPECT_KEY} from '../../../src/libts/okf/catalog_residue';
import {Concept, RESIDUE_KEY} from '../../../src/libts/okf/concept';
import {
  ConceptError,
  conceptToEntry,
  entryToConcept,
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
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
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
        'queries/trips_by_subscriber',
      ),
      GROUP,
    );
    warn.mockRestore();

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

  test('a non-index concept with no entryType and no frontmatter type is refused with an actionable message', () => {
    expect(() => conceptToEntry(concept({}, 'body', 'README'), GROUP)).toThrow(
      new ConceptError(
        'README.md: an OKF concept needs a non-empty `type` in its frontmatter ' +
          '(OKF v0.2 §11); add one, or move the file out of bundle/.',
      ),
    );
  });

  test('entryToConcept and conceptToEntry round-trip without losing fields', () => {
    const original = conceptToEntry(
      withResidue(
        {
          entryType: DOCUMENT,
          parentEntry: `${GROUP}/entries/assets`,
          entrySource: {system: 'BIGQUERY', platform: 'GCP'},
          aspects: {[DOC_FACET]: {job: {name: 'enrich-1'}}},
        },
        {
          type: 'context-overlay',
          title: 'Trips',
          description: 'Trip records',
          resource: 'bq://p.d.trips',
          tags: ['core'],
          status: 'verified',
        },
        '# Trips\n\nBody.\n',
      ),
      GROUP,
    );
    const asConcept = entryToConcept(original, 'assets/t');
    const restored = conceptToEntry(asConcept, GROUP);
    expect(restored).toEqual(original);
  });

  test('round-trips OKF v0.2 Attested Computation keys and producer-defined frontmatter keys across push -> pull', () => {
    const pushed = conceptToEntry(
      concept(
        {
          type: 'Attested Computation',
          title: 'Revenue for fiscal year',
          description: 'Recognized revenue for a fiscal year.',
          tags: ['finance', 'revenue'],
          status: 'deprecated',
          stale_after: '2026-12-31T00:00:00Z',
          runtime: 'bigquery',
          parameters: [{name: 'year', type: 'integer', required: true}],
          computation: '/references/computations/revenue.sql',
          executor: {
            resource: '/references/skills/run-on-bq.md',
            receipt: ['job_id', 'executed_sql', 'result'],
          },
          attester: {resource: '/references/attesters/sql-equality.py'},
          owner_team: 'team:finance-fpa',
          custom_domain: 'corporate-finance',
        },
        '# Computation\n',
        'computations/revenue',
      ),
      GROUP,
    );

    const pulled = entryToConcept(pushed, 'computations/revenue');
    expect(pulled.frontmatter['runtime']).toBe('bigquery');
    expect(pulled.frontmatter['parameters']).toEqual([
      {name: 'year', type: 'integer', required: true},
    ]);
    expect(pulled.frontmatter['computation']).toBe(
      '/references/computations/revenue.sql',
    );
    expect(pulled.frontmatter['executor']).toEqual({
      resource: '/references/skills/run-on-bq.md',
      receipt: ['job_id', 'executed_sql', 'result'],
    });
    expect(pulled.frontmatter['attester']).toEqual({
      resource: '/references/attesters/sql-equality.py',
    });
    expect(pulled.frontmatter['owner_team']).toBe('team:finance-fpa');
    expect(pulled.frontmatter['custom_domain']).toBe('corporate-finance');
  });

  test('normalizes Managed Enrichment document.type taxonomy labels on both pure OKF and pulled x-kcmd concepts', () => {
    const cases: Array<[string, string]> = [
      ['Context Set', 'context-set'],
      ['Knowledge Base Root', 'context-set'],
      ['Knowledge Base Index', 'knowledge-base-index'],
      ['Index', 'knowledge-base-index'],
      ['Table', 'table-context'],
      ['BigQuery Table', 'table-context'],
      ['Table Context', 'table-context'],
      ['Knowledge Base', 'knowledge-base'],
      ['Concept', 'concept'],
      ['Learning', 'learning'],
      ['Context Overlay', 'context-overlay'],
    ];
    for (const [label, expectedSlug] of cases) {
      const pure = conceptToEntry(
        concept({type: label, title: 'T'}, '# T\n', 'docs/t'),
        GROUP,
      );
      expect(pure.aspects?.[DOC_FACET]?.data?.['type']).toBe(expectedSlug);

      const pulled = conceptToEntry(
        withResidue(
          {entryType: DOCUMENT, aspects: {[DOC_FACET]: {job: {name: 'enrich-1'}}}},
          {type: label},
        ),
        GROUP,
      );
      expect(pulled.aspects?.[DOC_FACET]?.data).toEqual({
        type: expectedSlug,
        job: {name: 'enrich-1'},
      });
    }
  });

  test('rejects invalid query-template parameter type enums with ConceptError', () => {
    const qtType =
      'projects/dataplex-types/locations/global/entryTypes/query-template';
    const qtAspect = 'dataplex-types.global.query-template';
    expect(() =>
      conceptToEntry(
        concept(
          {
            type: 'Query Template',
            extra: {
              type: qtType,
              aspects: {
                [qtAspect]: {
                  query: 'SELECT @x',
                  nlQuery: 'q',
                  intent: 'i',
                  sourceType: 'BIGQUERY',
                  parameters: [{name: 'x', type: 'ARRAY<STRING>'}],
                },
              },
            },
          },
          '# Q\n',
          'queries/q',
        ),
        GROUP,
      ),
    ).toThrow(ConceptError);
  });
});
