import { describe, expect, it } from 'vitest';
import { fileManagerName } from './fileManager';

describe('fileManagerName', () => {
  it.each([['macos', 'Finder'], ['windows', 'File Explorer'], ['linux', 'file manager'], ['freebsd', 'file manager'], [null, 'file manager'], [undefined, 'file manager']])(
    '%s -> %s', (platform, expected) => expect(fileManagerName(platform as string | null | undefined)).toBe(expected));
});
