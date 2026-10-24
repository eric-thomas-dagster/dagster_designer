import { describe, expect, it } from 'vitest';
import { buildAssetLink, buildProjectLink, findProjectForLink, parseDeepLink } from './deepLink';

describe('parseDeepLink', () => {
  it('reads a project link', () => {
    expect(parseDeepLink('dagster-designer://project?project=Jaffle%20Shop')).toEqual({ kind: 'project', project: 'Jaffle Shop' });
  });
  it('reads an asset link, including keys with slashes', () => {
    expect(parseDeepLink('dagster-designer://asset?project=demo&key=raw%2Forders')).toEqual({ kind: 'asset', project: 'demo', assetKey: 'raw/orders' });
    expect(parseDeepLink('dagster-designer://asset?project=demo&key=raw/orders')).toEqual({ kind: 'asset', project: 'demo', assetKey: 'raw/orders' });
  });
  it('tolerates surrounding whitespace and a different case of the action', () => {
    expect(parseDeepLink('  dagster-designer://ASSET?project=demo&key=a  ')).toEqual({ kind: 'asset', project: 'demo', assetKey: 'a' });
  });
  it.each([
    ['another scheme', 'https://asset?project=demo&key=a'],
    ['a look-alike scheme', 'dagster-designer2://asset?project=demo&key=a'],
    ['an unknown action', 'dagster-designer://delete?project=demo'],
    ['no action', 'dagster-designer://?project=demo'],
    ['a project link without a project', 'dagster-designer://project'],
    ['a blank project', 'dagster-designer://project?project=%20%20'],
    ['an asset link without a key', 'dagster-designer://asset?project=demo'],
    ['an asset link without a project', 'dagster-designer://asset?key=a'],
    ['not a URL at all', 'open the thing'],
    ['an empty string', ''],
  ])('rejects %s', (_label, raw) => expect(parseDeepLink(raw)).toBeNull());

  it('rejects control characters and absurdly long values', () => {
    expect(parseDeepLink('dagster-designer://project?project=a%00b')).toBeNull();
    expect(parseDeepLink('dagster-designer://project?project=a%0Ab')).toBeNull();
    expect(parseDeepLink(`dagster-designer://project?project=${'x'.repeat(201)}`)).toBeNull();
    expect(parseDeepLink(`dagster-designer://asset?project=p&key=${'k'.repeat(501)}`)).toBeNull();
    expect(parseDeepLink(`dagster-designer://project?project=${'x'.repeat(200)}`)).not.toBeNull();
  });
  it('ignores extra parameters rather than acting on them', () => {
    expect(parseDeepLink('dagster-designer://project?project=demo&run=rm%20-rf&path=/etc')).toEqual({ kind: 'project', project: 'demo' });
  });
});

describe('building links', () => {
  it('round-trips awkward names and keys', () => {
    const name = 'My Project & Co (v2)';
    const key = 'raw/orders by day+week?';
    expect(parseDeepLink(buildAssetLink(name, key))).toEqual({ kind: 'asset', project: name, assetKey: key });
    expect(parseDeepLink(buildProjectLink(name))).toEqual({ kind: 'project', project: name });
  });
  it('produces the documented shape', () => {
    expect(buildProjectLink('demo')).toBe('dagster-designer://project?project=demo');
    expect(buildAssetLink('demo', 'a/b')).toBe('dagster-designer://asset?project=demo&key=a%2Fb');
  });
});

describe('findProjectForLink', () => {
  const projects = [
    { id: '1', name: 'Jaffle Shop' },
    { id: '2', name: 'Demo' },
    { id: '3', name: 'demo' },
  ];
  it('finds a project by name, ignoring case and spacing', () => {
    expect(findProjectForLink(projects, ' jaffle shop ')).toEqual({ project: projects[0], ambiguous: false });
  });
  it('does not guess between projects that share a name', () => {
    expect(findProjectForLink(projects, 'DEMO')).toEqual({ project: null, ambiguous: true });
  });
  it('reports no match', () => {
    expect(findProjectForLink(projects, 'missing')).toEqual({ project: null, ambiguous: false });
    expect(findProjectForLink([], 'x')).toEqual({ project: null, ambiguous: false });
  });
});
