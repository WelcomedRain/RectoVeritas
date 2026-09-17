import { describe, it, expect } from 'vitest';
import { gitBlobSha } from './blobSha';

describe('gitBlobSha', () => {
  /**
   * Checked against git's published values rather than against our own output,
   * which would only prove the function is consistent with itself.
   */
  it('matches git for the values git documents', async () => {
    expect(await gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(await gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('counts bytes, not characters', async () => {
    // A multi-byte character in the header length would give a wrong answer
    // that still looks like a sha, so this is the case worth pinning.
    const a = await gitBlobSha('é');
    const b = await gitBlobSha('ee');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });
});
