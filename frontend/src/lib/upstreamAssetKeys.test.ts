import { describe, it, expect } from 'vitest';
import { parseUpstreamAssetKeys } from './upstreamAssetKeys';

describe('parseUpstreamAssetKeys', () => {
  it('passes through a correctly-typed array unchanged', () => {
    expect(parseUpstreamAssetKeys(['marts/fct_ticket_revenue'])).toEqual([
      'marts/fct_ticket_revenue',
    ]);
  });

  it('passes through a multi-item array unchanged', () => {
    expect(parseUpstreamAssetKeys(['a/b', 'c/d'])).toEqual(['a/b', 'c/d']);
  });

  it('parses a legacy comma-separated string', () => {
    expect(parseUpstreamAssetKeys('a/b, c/d')).toEqual(['a/b', 'c/d']);
  });

  it('parses a single-item string with no comma at all', () => {
    // The exact shape of the real incident: DagsterAIBar's old
    // `.join(', ')` on a one-item array produced this -- a bare string
    // with no comma, which is why it read as "just a string" rather than
    // an obviously malformed list.
    expect(parseUpstreamAssetKeys('marts/fct_ticket_revenue')).toEqual([
      'marts/fct_ticket_revenue',
    ]);
  });

  it('trims whitespace around comma-separated entries', () => {
    expect(parseUpstreamAssetKeys('a/b ,  c/d')).toEqual(['a/b', 'c/d']);
  });

  it('drops empty entries from a trailing comma', () => {
    expect(parseUpstreamAssetKeys('a/b,')).toEqual(['a/b']);
  });

  it('returns an empty array for null', () => {
    expect(parseUpstreamAssetKeys(null)).toEqual([]);
  });

  it('returns an empty array for undefined', () => {
    expect(parseUpstreamAssetKeys(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseUpstreamAssetKeys('')).toEqual([]);
  });

  it('returns an empty array for an empty array', () => {
    expect(parseUpstreamAssetKeys([])).toEqual([]);
  });

  it('filters out non-string entries from an array without crashing', () => {
    expect(parseUpstreamAssetKeys(['a/b', 42, null, 'c/d'] as unknown[])).toEqual([
      'a/b',
      'c/d',
    ]);
  });
});
