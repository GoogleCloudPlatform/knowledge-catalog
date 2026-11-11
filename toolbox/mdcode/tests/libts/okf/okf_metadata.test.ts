import {describe, expect, test} from 'bun:test';

import {
  appendOkfMetadata,
  OKF_METADATA_KEYS,
  splitOkfMetadata,
} from '../../../src/libts/okf/okf_metadata';

const FULL = {
  tags: ['bikeshare'],
  status: 'deprecated',
  superseded_by: '/metrics/gross-margin.md',
  stale_after: '2027-01-01',
  runtime: 'bigquery',
  parameters: [{name: 'year', type: 'integer', required: true}],
  computation: '/references/computations/lib/revenue.sql',
  executor: {
    resource: '/references/skills/run-on-bq.md',
    receipt: ['job_id', 'executed_sql', 'result'],
  },
  attester: {resource: '/references/attesters/sql-equality.py'},
  generated: {by: 'enrichment-agent'},
  verified: [{by: 'human:atharvaph'}],
  sources: ['docs/ops-sop.md'],
  usage_window: {start: '2026-01-01'},
};

describe('appendOkfMetadata', () => {
  test('leaves a body alone when no key is present', () => {
    expect(appendOkfMetadata('# Page\n', {type: 'knowledge-base'})).toBe(
      '# Page\n',
    );
  });

  test('appends a fenced yaml section', () => {
    const out = appendOkfMetadata('# Page\n', {tags: ['a'], status: 'draft'});
    expect(out).toBe(
      '# Page\n\n## OKF Metadata\n\n```yaml\ntags:\n  - a\nstatus: draft\n```\n',
    );
  });

  test('carries only OKF keys and producer extensions, not title, extra, links, or residue', () => {
    const out = appendOkfMetadata('body', {
      title: 'T',
      description: 'D',
      resource: 'bq://p.d.t',
      type: 'knowledge-base',
      'x-kcmd': {v: 1},
      extra: {resource: {parent: 'agents'}},
      links: [{type: 'related', entries: ['a', 'b']}],
      tags: ['a'],
      'x-acme-owner': 'team:data',
      custom_key: 'keep-me',
    });
    expect(out).toContain('tags:');
    expect(out).toContain('x-acme-owner: team:data');
    expect(out).toContain('custom_key: keep-me');
    expect(out).not.toContain('title');
    expect(out).not.toContain('description');
    expect(out).not.toContain('resource');
    expect(out).not.toContain('x-kcmd');
    expect(out).not.toContain('extra');
    expect(out).not.toContain('links');

    const {metadata} = splitOkfMetadata(out);
    expect(metadata).toEqual({
      tags: ['a'],
      'x-acme-owner': 'team:data',
      custom_key: 'keep-me',
    });
  });
});

describe('splitOkfMetadata', () => {
  test('a body with no section is returned whole', () => {
    const {body, metadata} = splitOkfMetadata('# Page\n\ntext\n');
    expect(body).toBe('# Page\n\ntext\n');
    expect(metadata).toEqual({});
  });

  test('round-trips every OKF key', () => {
    const content = appendOkfMetadata('# Page\n\ntext', FULL);
    const {body, metadata} = splitOkfMetadata(content);
    expect(body).toBe('# Page\n\ntext');
    expect(metadata).toEqual(FULL);
    expect(Object.keys(metadata).sort()).toEqual([...OKF_METADATA_KEYS].sort());
  });

  test('appending twice is stable once split in between', () => {
    const first = appendOkfMetadata('# Page\n', {tags: ['a']});
    const split = splitOkfMetadata(first);
    const second = appendOkfMetadata(split.body, split.metadata);
    expect(second).toBe(first);
  });

  test('a page that merely discusses the section is left alone', () => {
    const prose = '# Page\n\n## OKF Metadata\n\nWe write one of these.\n';
    expect(splitOkfMetadata(prose)).toEqual({body: prose, metadata: {}});
  });

  test('an unterminated fence is left alone', () => {
    const broken = '# Page\n\n## OKF Metadata\n\n```yaml\ntags:\n  - a\n';
    expect(splitOkfMetadata(broken)).toEqual({body: broken, metadata: {}});
  });

  test('a non-mapping payload is left alone', () => {
    const list = '# Page\n\n## OKF Metadata\n\n```yaml\n- a\n- b\n```\n';
    expect(splitOkfMetadata(list)).toEqual({body: list, metadata: {}});
  });

  test('only the last section is taken', () => {
    const content = appendOkfMetadata(
      '# Page\n\n## OKF Metadata\n\n```yaml\ntags:\n  - stale\n```\n',
      {status: 'current'},
    );
    const {body, metadata} = splitOkfMetadata(content);
    expect(metadata).toEqual({status: 'current'});
    expect(body).toContain('stale');
  });
});
