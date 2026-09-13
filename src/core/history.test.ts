import { describe, it, expect } from 'vitest';
import { describeVersions, relativeTime, canRestore, type Commit } from './history';

const NOW = Date.parse('2026-09-13T12:00:00Z');
const at = (iso: string, message: string, sha = message.slice(0, 7).padEnd(40, '0')): Commit =>
  ({ sha, when: Date.parse(iso), message, author: 'Gene Bernardin' });

describe('relativeTime', () => {
  it('reads the way a person would say it', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago');
    expect(relativeTime(NOW - 60 * 60_000, NOW)).toBe('1 hour ago');
    expect(relativeTime(NOW - 48 * 60 * 60_000, NOW)).toBe('2 days ago');
  });

  it('does not count singular things in the plural', () => {
    expect(relativeTime(NOW - 60_000, NOW)).toBe('1 minute ago');
    expect(relativeTime(NOW - 24 * 60 * 60_000, NOW)).toBe('1 day ago');
  });

  it('never reports the future as an age', () => {
    // Clock skew between this machine and GitHub is ordinary.
    expect(relativeTime(NOW + 60_000, NOW)).toBe('just now');
  });
});

describe('describeVersions', () => {
  const commits = [
    at('2026-09-13T11:00:00Z', 'Update site copy (2 changes)'),
    at('2026-09-13T09:00:00Z', 'Stage 1 change for review'),
    at('2026-09-10T09:00:00Z', 'Publish 2026-09-08 export; fix head verification'),
  ];

  it('marks the newest as what the site is serving', () => {
    const v = describeVersions(commits, { now: NOW });
    expect(v[0].current).toBe(true);
    expect(v.filter((x) => x.current)).toHaveLength(1);
  });

  it('honours an explicit current sha over position', () => {
    const v = describeVersions(commits, { currentSha: commits[2].sha, now: NOW });
    expect(v[2].current).toBe(true);
    expect(v[0].current).toBe(false);
  });

  /**
   * "Where did that come from" is a real question with a real answer: this
   * editor writes two message shapes and nothing else does.
   */
  it('separates what this editor published from what arrived another way', () => {
    const v = describeVersions(commits, { now: NOW });
    expect(v[0].fromEditor).toBe(true);
    expect(v[1].fromEditor).toBe(true);
    expect(v[2].fromEditor).toBe(false);
  });

  it('knows a staged publish from a live one', () => {
    const v = describeVersions(commits, { now: NOW });
    expect(v[0].preview).toBe(false);
    expect(v[1].preview).toBe(true);
  });

  it('shortens the sha the way git does', () => {
    expect(describeVersions([at('2026-09-13T11:00:00Z', 'x', 'abcdef1234567890')], { now: NOW })[0].short)
      .toBe('abcdef1');
  });

  it('survives an empty history without inventing a current version', () => {
    expect(describeVersions([], { now: NOW })).toEqual([]);
  });
});

describe('canRestore', () => {
  const [live, older] = describeVersions([
    at('2026-09-13T11:00:00Z', 'Update site copy (2 changes)'),
    at('2026-09-10T09:00:00Z', 'An older one'),
  ], { now: NOW });

  it('allows going back to an older version', () => {
    expect(canRestore(older, 0)).toEqual({ ok: true });
  });

  it('refuses the version already being served', () => {
    expect(canRestore(live, 0).ok).toBe(false);
  });

  /**
   * Queued edits are offsets into the page being replaced. Restoring under
   * them would leave numbers pointing into text that no longer exists — the
   * orphan problem, created deliberately.
   */
  it('refuses while there is unpublished work, and says what to do', () => {
    const r = canRestore(older, 3);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).toMatch(/3 changes waiting/);
      expect(r.why).toMatch(/Publish or undo/);
    }
  });

  it('counts one change in the singular', () => {
    const r = canRestore(older, 1);
    if (!r.ok) expect(r.why).toMatch(/1 change waiting/);
  });
});
