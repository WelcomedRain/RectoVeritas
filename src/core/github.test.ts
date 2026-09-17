import { describe, it, expect } from 'vitest';
import { friendly, parseRepoInput } from './github';

/**
 * These strings are the only thing a person sees when a publish fails, so they
 * are the product at that moment. The first real authenticated publish failed
 * with a 403, and the message named one cause with confidence when 403 has
 * more than one — and dropped GitHub's own explanation, which had been
 * captured and was sitting right there.
 */
describe('GitHub error messages', () => {
  const body = (message: string) => JSON.stringify({ message, documentation_url: 'https://...' });

  it('quotes what GitHub actually said', () => {
    const m = friendly(403, body('Resource not accessible by personal access token'));
    expect(m).toContain('Resource not accessible by personal access token');
  });

  it('names both causes of a write refusal, not just the obvious one', () => {
    const m = friendly(403, body('nope'));
    expect(m).toMatch(/Repository access/);
    expect(m).toMatch(/Contents/);
    // The preset that cannot be upgraded is the one people miss.
    expect(m).toMatch(/read-only/i);
  });

  it('states what is certain before what is likely', () => {
    // It cannot write — that much the status proves. Which of the two settings
    // is at fault, it does not.
    expect(friendly(403, body('x')).startsWith('The token cannot write')).toBe(true);
  });

  it('still calls out a rate limit as its own thing', () => {
    const m = friendly(403, '{"message":"API rate limit exceeded"}');
    expect(m).toMatch(/rate limit/i);
    expect(m).not.toMatch(/Repository access/);
  });

  it('survives a body that is not JSON', () => {
    expect(() => friendly(403, '<html>gateway error</html>')).not.toThrow();
    expect(friendly(403, '<html>')).not.toContain('GitHub said');
  });

  it('survives a body with no message field', () => {
    expect(friendly(404, '{"documentation_url":"x"}')).not.toContain('GitHub said');
  });

  it('does not quote an empty message', () => {
    expect(friendly(401, body('   '))).not.toContain('GitHub said');
  });
});

describe('parseRepoInput', () => {
  it('accepts the forms a person actually pastes', () => {
    expect(parseRepoInput('WelcomedRain/Anthea-Solve'))
      .toEqual({ owner: 'WelcomedRain', repo: 'Anthea-Solve' });
    expect(parseRepoInput('https://github.com/WelcomedRain/Anthea-Solve.git'))
      .toEqual({ owner: 'WelcomedRain', repo: 'Anthea-Solve' });
  });
});

describe('422, the one that needed its reason most', () => {
  /**
   * A 422 covers a non-fast-forward branch update, a rejected tree and a bad
   * blob, and they call for different fixes. It was the only explained status
   * that dropped GitHub's own words, which made the most ambiguous failure in
   * the app the one you could not diagnose.
   */
  /**
   * The real case, seen in use: two publishes ran at once, the first moved the
   * branch and went live, the second was refused — and the app reported a
   * failure for work that had already shipped.
   */
  it('names the branch-moved case, because the change may already be live', () => {
    const m = friendly(422, '{"message":"Update is not a fast forward"}');
    expect(m).toMatch(/branch moved/i);
    expect(m).toMatch(/Check Sync/);
    expect(m).toContain('not a fast forward');
  });

  it('falls back to the generic wording for other 422s', () => {
    const m = friendly(422, '{"message":"tree.path contains a malformed path"}');
    expect(m).toContain('refused the change as invalid');
    expect(m).not.toMatch(/branch moved/i);
  });

  it('still reads as a sentence when GitHub said nothing useful', () => {
    expect(friendly(422, '')).toContain('refused the change as invalid');
  });
});
