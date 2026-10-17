import { describe, expect, it } from 'vitest';
import { MAX_INLINE_SETTINGS, inlineSettingCount } from './InlineAttributesForm';

describe('inlineSettingCount', () => {
  it('does not count settings that have their own UI', () => {
    const props = { asset_name: {}, upstream_asset_key: {}, upstream_asset_keys: {}, sql_template: {}, translation: {}, post_processing: {}, group_name: {} };
    expect(inlineSettingCount(props)).toBe(2);
    expect(inlineSettingCount(props, ['group_name'])).toBe(1);
    expect(inlineSettingCount(undefined)).toBe(0);
  });

  it('a transformer-sized component is over the inline limit; a small one is not', () => {
    const many = Object.fromEntries(Array.from({ length: 56 }, (_, i) => [`ops_${i}`, {}]));
    const few = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`field_${i}`, {}]));
    expect(inlineSettingCount(many)).toBeGreaterThan(MAX_INLINE_SETTINGS);
    expect(inlineSettingCount(few)).toBeLessThanOrEqual(MAX_INLINE_SETTINGS);
  });
});
