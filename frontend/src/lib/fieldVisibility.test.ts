import { describe, it, expect } from 'vitest';
import { isFieldVisible, labelFor } from './fieldVisibility';

describe('isFieldVisible', () => {
  it('is visible with no rule at all', () => {
    expect(isFieldVisible({}, {})).toBe(true);
    expect(isFieldVisible({ type: 'string' }, { destination: 'snowflake' })).toBe(true);
  });

  it('is visible when the trigger field matches one of the listed values', () => {
    const schema = { 'x-dagster-visible-when': { field: 'destination', values: ['filesystem', 'databricks', 'athena'] } };
    expect(isFieldVisible(schema, { destination: 'filesystem' })).toBe(true);
    expect(isFieldVisible(schema, { destination: 'athena' })).toBe(true);
  });

  it('is hidden when the trigger field does not match any listed value', () => {
    const schema = { 'x-dagster-visible-when': { field: 'destination', values: ['filesystem', 'databricks', 'athena'] } };
    expect(isFieldVisible(schema, { destination: 'snowflake' })).toBe(false);
  });

  it('is hidden when the trigger field is unset entirely', () => {
    const schema = { 'x-dagster-visible-when': { field: 'destination', values: ['athena'] } };
    expect(isFieldVisible(schema, {})).toBe(false);
  });

  it('real case: athena_query_result_bucket only visible for destination=athena', () => {
    const schema = { 'x-dagster-visible-when': { field: 'destination', values: ['athena'] } };
    expect(isFieldVisible(schema, { destination: 'athena' })).toBe(true);
    expect(isFieldVisible(schema, { destination: 'databricks' })).toBe(false);
    expect(isFieldVisible(schema, { destination: 'filesystem' })).toBe(false);
  });
});

describe('labelFor', () => {
  it('falls back to the given default with no rule', () => {
    expect(labelFor({}, { destination: 'snowflake' }, 'Bucket Url')).toBe('Bucket Url');
  });

  it('real case: bucket_url labeled differently per destination', () => {
    const schema = {
      'x-dagster-label-by': {
        field: 'destination',
        labels: { filesystem: 'Storage location', databricks: 'Staging bucket', athena: 'Staging bucket' },
      },
    };
    expect(labelFor(schema, { destination: 'filesystem' }, 'Bucket Url')).toBe('Storage location');
    expect(labelFor(schema, { destination: 'databricks' }, 'Bucket Url')).toBe('Staging bucket');
    expect(labelFor(schema, { destination: 'athena' }, 'Bucket Url')).toBe('Staging bucket');
  });

  it('falls back to the default when the trigger value has no matching label', () => {
    const schema = {
      'x-dagster-label-by': { field: 'destination', labels: { athena: 'Staging bucket' } },
    };
    expect(labelFor(schema, { destination: 'snowflake' }, 'Bucket Url')).toBe('Bucket Url');
  });

  it('falls back to the default when the trigger field is unset', () => {
    const schema = {
      'x-dagster-label-by': { field: 'destination', labels: { athena: 'Staging bucket' } },
    };
    expect(labelFor(schema, {}, 'Bucket Url')).toBe('Bucket Url');
  });
});
