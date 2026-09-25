import { describe, expect, it } from 'vitest';
import { formatCost, formatLatency, parseStepMetadataFields } from './stepMetadata';

describe('parseStepMetadataFields', () => {
  it('strips the step id prefix from matching labels', () => {
    const entries = [
      { label: 'classify_urgency__cost_usd', value: 0.0012 },
      { label: 'classify_urgency__latency_ms', value: 340 },
      { label: 'classify_urgency__router_reasoning', value: 'picked billing' },
    ];
    expect(parseStepMetadataFields('classify_urgency', entries)).toEqual({
      cost_usd: 0.0012,
      latency_ms: 340,
      router_reasoning: 'picked billing',
    });
  });

  it('ignores entries belonging to a different step', () => {
    const entries = [
      { label: 'classify_urgency__cost_usd', value: 0.0012 },
      { label: 'draft_reply__cost_usd', value: 0.02 },
    ];
    expect(parseStepMetadataFields('classify_urgency', entries)).toEqual({ cost_usd: 0.0012 });
  });

  it('returns an empty object when nothing matches', () => {
    expect(parseStepMetadataFields('classify_urgency', [{ label: 'dagster/row_count', value: 5 }])).toEqual({});
  });

  it('handles a step id that itself contains an underscore correctly', () => {
    // The real-world shape this exists for -- step ids are commonly
    // snake_case, so the prefix match must use the FULL step id plus
    // "__", not split on the first single underscore.
    const entries = [{ label: 'draft_suggested_reply__tokens_total', value: 512 }];
    expect(parseStepMetadataFields('draft_suggested_reply', entries)).toEqual({ tokens_total: 512 });
  });
});

describe('formatCost', () => {
  it('formats a typical cost with 4 decimal places', () => {
    expect(formatCost(0.0234)).toBe('$0.0234');
  });

  it('uses more precision (6 decimals) below the 1-cent threshold', () => {
    expect(formatCost(0.0012)).toBe('$0.001200');
    expect(formatCost(0.000045)).toBe('$0.000045');
  });

  it('falls back to the raw value for a non-numeric input', () => {
    expect(formatCost('not a number')).toBe('not a number');
  });
});

describe('formatLatency', () => {
  it('formats sub-second latency in milliseconds', () => {
    expect(formatLatency(340)).toBe('340ms');
  });

  it('formats latency over 1000ms in seconds', () => {
    expect(formatLatency(3400)).toBe('3.4s');
  });

  it('falls back to the raw value for a non-numeric input', () => {
    expect(formatLatency('n/a')).toBe('n/a');
  });
});
