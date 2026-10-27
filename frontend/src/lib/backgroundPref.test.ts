import { describe, expect, it } from 'vitest';
import { backgroundModeEnabled } from './backgroundPref';

describe('backgroundModeEnabled', () => {
  it('follows Dagster+ projects when the person never chose', () => {
    expect(backgroundModeEnabled(null, true)).toBe(true);
    expect(backgroundModeEnabled(null, false)).toBe(false);
  });
  it('an explicit choice always wins', () => {
    expect(backgroundModeEnabled(false, true)).toBe(false);
    expect(backgroundModeEnabled(true, false)).toBe(true);
  });
});
