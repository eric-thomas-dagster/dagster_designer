import { describe, expect, it } from 'vitest';
import { importErrorMessage, pickProjectPath } from './dropImport';

describe('pickProjectPath', () => {
  it('takes the first dropped path and counts the rest', () => {
    expect(pickProjectPath(['/a/proj', '/b/other', '/c/third'])).toEqual({ path: '/a/proj', ignored: 2 });
    expect(pickProjectPath(['/a/proj'])).toEqual({ path: '/a/proj', ignored: 0 });
  });
  it('ignores blank entries and handles an empty drop', () => {
    expect(pickProjectPath(['', '  ', '/a/proj'])).toEqual({ path: '/a/proj', ignored: 0 });
    expect(pickProjectPath([])).toEqual({ path: null, ignored: 0 });
  });
});

describe('importErrorMessage', () => {
  it('uses the server explanation', () => {
    expect(importErrorMessage({ response: { data: { detail: 'Not a valid Dagster project: /x' } } })).toBe('Not a valid Dagster project: /x');
    expect(importErrorMessage({ response: { data: { detail: { message: 'nope' } } } })).toBe('nope');
  });
  it('falls back to a generic message', () => {
    expect(importErrorMessage(new Error('boom'))).toBe('Could not import that folder.');
    expect(importErrorMessage({ response: { data: { detail: '  ' } } })).toBe('Could not import that folder.');
    expect(importErrorMessage(undefined)).toBe('Could not import that folder.');
  });
});
