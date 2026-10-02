import { describe, it, expect } from 'vitest';
import { pickBestPathColumn } from './useUpstreamColumns';

describe('pickBestPathColumn', () => {
  it('prefers local_path over path when both are present (file_lister with download=true)', () => {
    expect(pickBestPathColumn(['path', 'local_path', 'filename', 'size', 'modified_at'], 'file_path')).toBe('local_path');
  });

  it('falls back to path when local_path is absent', () => {
    expect(pickBestPathColumn(['path', 'filename', 'size'], 'file_path')).toBe('path');
  });

  it('falls back to the caller-provided default when neither file_lister column exists', () => {
    expect(pickBestPathColumn(['file_path', 'category'], 'file_path')).toBe('file_path');
  });

  it('falls back to the caller-provided default even when it is not in the resolved columns (e.g. columns not loaded yet)', () => {
    expect(pickBestPathColumn([], 'file_path')).toBe('file_path');
  });
});
