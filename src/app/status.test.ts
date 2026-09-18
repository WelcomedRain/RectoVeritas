import { describe, it, expect } from 'vitest';
import { statusLine, publishTarget, siteState, syncMessage } from './status';

const base = {
  dirty: 0, networkUp: true, manualOffline: false,
  publishTo: 'https://antheasolve.com/', deploy: null, lastPush: null,
};

describe('the status line', () => {
  /**
   * The slot that used to say "Editing a copy on this computer" is gone. It
   * was permanently true, and that is why it confused: a fact with no
   * alternative reads as one option among several. What replaced it is the
   * only question here with two possible answers.
   */
  it('answers whether the live site is showing what you have', () => {
    const seen = { inSync: true };
    expect(statusLine({ ...base, dirty: 0, remote: seen }).pending.tone).toBe('match');
    expect(statusLine({ ...base, dirty: 3 }).pending.tone).toBe('waiting');
  });

  /**
   * The defect this closes: an empty queue was being read as proof that the
   * copy matched the site. It proves only that nothing was changed *here* —
   * the page can have moved on GitHub, which is now a routine event.
   */
  it('will not call a copy a match on the strength of an empty queue', () => {
    expect(statusLine({ ...base, dirty: 0 }).pending.tone).toBe('unknown');
    expect(statusLine({ ...base, dirty: 0 }).pending.text).toMatch(/not checked/i);
  });

  it('says so plainly when the site has moved underneath the copy', () => {
    const s = statusLine({ ...base, dirty: 0, remote: { inSync: false } });
    expect(s.pending.tone).toBe('waiting');
    expect(s.pending.text).toMatch(/site has changed/i);
  });

  /**
   * `lastPush` is persisted, so reading it as "pushed" made the footer announce
   * a push from days ago in every session that followed — next to a header
   * saying the copy matched the site.
   */
  it('does not report an old session’s push as news', () => {
    const s = statusLine({ ...base, lastPush: 1, remote: { inSync: true } });
    expect(s.pending.text).not.toMatch(/pushed/i);
    expect(s.pending.tone).toBe('match');
  });

  it('does report a push made in this session', () => {
    const s = statusLine({
      ...base, lastPush: 1, pushedThisSession: true, remote: { inSync: true },
    });
    expect(s.pending.text).toMatch(/pushed/i);
  });

  it('lets a deployment observation outrank both', () => {
    const verified = { state: 'verified' as const, detail: '', checkedAt: 0, attempts: 1 };
    const s = statusLine({ ...base, lastPush: 1, deploy: verified, remote: { inSync: true } });
    expect(s.pending.text).toMatch(/serving your change/i);
  });

  it('will not call an unverified push a match', () => {
    // Pushed in this session, never observed. Green here would be the app
    // asserting something it did not check.
    expect(statusLine({ ...base, dirty: 0, lastPush: 1, pushedThisSession: true }).pending.tone)
      .toBe('unknown');
  });

  it('is waiting while the live site has not caught up', () => {
    const stale = { state: 'stale' as const, detail: '', checkedAt: 0, attempts: 1 };
    const verified = { state: 'verified' as const, detail: '', checkedAt: 0, attempts: 1 };
    expect(statusLine({ ...base, deploy: stale, lastPush: 1 }).pending.tone).toBe('waiting');
    expect(statusLine({ ...base, deploy: verified, lastPush: 1 }).pending.tone).toBe('match');
  });

  it('names where Publish would send the work, before it is pressed', () => {
    // The only irreversible outward-facing act in the app never said out loud
    // where it was aimed.
    expect(statusLine({ ...base, dirty: 2 }).pending.text).toContain('antheasolve.com');
  });

  it('counts one change without the plural, pronoun included', () => {
    expect(statusLine({ ...base, dirty: 1 }).pending.text).toBe(
      '1 change waiting · Publish sends it to antheasolve.com');
    expect(statusLine({ ...base, dirty: 2 }).pending.text).toBe(
      '2 changes waiting · Publish sends them to antheasolve.com');
  });

  it('falls back to the deployment state for a push made in this session', () => {
    // A bare `lastPush` no longer qualifies: it is persisted, so it is true in
    // every session after the first successful publish.
    expect(statusLine({ ...base, dirty: 0, lastPush: 1, pushedThisSession: true }).pending.text)
      .toMatch(/GitHub/);
  });

  it('still reports the count when the destination is not known yet', () => {
    const s = statusLine({ ...base, dirty: 2, publishTo: null });
    expect(s.pending.text).toContain('2 changes waiting');
    expect(s.pending.text).not.toContain('undefined');
  });

  /**
   * `online` was one flag for two unrelated facts: the network being
   * reachable, and a manual switch in the header meant for testing. Flipping
   * the switch and forgetting showed "Offline" on a working connection, and
   * the screen could not tell you which one you were looking at.
   */
  it('distinguishes the test switch from a real outage', () => {
    const switched = statusLine({ ...base, manualOffline: true });
    const lost = statusLine({ ...base, networkUp: false });
    expect(switched.connection?.tone).toBe('switched');
    expect(lost.connection?.tone).toBe('lost');
    expect(switched.connection?.text).not.toBe(lost.connection?.text);
    expect(switched.connection?.text).toMatch(/you switched/i);
  });

  it('says nothing about the connection while it is working', () => {
    expect(statusLine(base).connection).toBeNull();
  });

  it('blames the switch, not the network, when both are set', () => {
    // The switch is the one he can undo, so it is the one worth naming.
    expect(statusLine({ ...base, manualOffline: true, networkUp: false }).connection?.tone)
      .toBe('switched');
  });
});

describe('publishTarget', () => {
  it('reduces a URL to something a person would say out loud', () => {
    expect(publishTarget('https://antheasolve.com/')).toBe('antheasolve.com');
  });

  it('keeps the path, because preview and live share a host', () => {
    // A bare host would name both destinations and distinguish neither, which
    // is the one thing this string exists to do.
    expect(publishTarget('https://antheasolve.com/preview/'))
      .toBe('antheasolve.com/preview/');
    expect(publishTarget('https://welcomedrain.github.io/Anthea-Solve/'))
      .toBe('welcomedrain.github.io/Anthea-Solve/');
  });

  it('survives a missing or malformed URL', () => {
    expect(publishTarget(null)).toBeNull();
    expect(publishTarget('not a url')).toBeNull();
  });
});

describe('after going back to an older version', () => {
  /**
   * A restore replaces the page wholesale, so it produces no queued edits.
   * Counting edits would report nothing waiting while the working copy holds
   * something the site has never served — the same class of lie as the old
   * "editing a copy" line that vanished when it mattered.
   */
  const restored = { ...base, dirty: 0, restored: { short: 'abc1234' } };

  it('says which version is being shown rather than that nothing is waiting', () => {
    expect(statusLine(restored).pending.text).toContain('abc1234');
    expect(statusLine(restored).pending.text).not.toMatch(/matches the live site/i);
  });

  it('still names where publishing would send it', () => {
    expect(statusLine(restored).pending.text).toContain('antheasolve.com');
  });

  it('counts as waiting, since the site is not serving what is on screen', () => {
    expect(statusLine(restored).pending.tone).toBe('waiting');
  });

  it('still reports a connection problem', () => {
    expect(statusLine({ ...restored, manualOffline: true }).connection?.tone).toBe('switched');
  });

  it('lets queued edits take precedence, since they are the live question', () => {
    expect(statusLine({ ...restored, dirty: 2 }).pending.text).toContain('2 changes waiting');
  });
});

describe('siteState', () => {
  const seen = { inSync: true };

  it('is unchecked until GitHub has actually answered', () => {
    // Offline, refused, and first run are the same state, and none is green.
    expect(siteState({ dirty: 0, remote: null })).toBe('unchecked');
  });

  it('is a match only when a look said so and nothing is queued', () => {
    expect(siteState({ dirty: 0, remote: seen })).toBe('match');
    expect(siteState({ dirty: 1, remote: seen })).toBe('pending');
  });

  it('ranks being behind above being ahead', () => {
    // Queued edits are yours and known. A page that moved underneath you is
    // neither, so it is the one that gets said out loud.
    expect(siteState({ dirty: 5, remote: { inSync: false } })).toBe('behind');
  });

  it('counts a restored version as pending, since it is not what is served', () => {
    expect(siteState({ dirty: 0, remote: seen, restored: { short: 'abc1234' } })).toBe('pending');
  });

  /**
   * A replaced image writes straight into the working copy and queues no
   * patch. Reading "pending" off the patch count alone called that copy a
   * match while it held an image the site has never served.
   */
  it('counts unpublished work that has no patch to count', () => {
    expect(siteState({ dirty: 0, remote: seen, localModified: true })).toBe('pending');
  });

  it('still ranks the site moving above any of it', () => {
    expect(siteState({ dirty: 0, remote: { inSync: false }, localModified: true })).toBe('behind');
  });
});

describe('unpublished work with nothing to count', () => {
  const base = {
    dirty: 0, networkUp: true, manualOffline: false,
    publishTo: 'https://antheasolve.com/', deploy: null, lastPush: null,
  };

  it('says so, and still names the destination', () => {
    const s = statusLine({ ...base, localModified: true, remote: { inSync: true } });
    expect(s.pending.tone).toBe('waiting');
    expect(s.pending.text).toMatch(/unpublished changes/i);
    expect(s.pending.text).toContain('antheasolve.com');
  });

  it('lets a real count take over once there is one', () => {
    const s = statusLine({ ...base, dirty: 2, localModified: true });
    expect(s.pending.text).toContain('2 changes waiting');
  });
});

describe('what the app says after looking at GitHub', () => {
  /**
   * These sentences describe what became of the only copy of the user's work,
   * and both were wrong at different points: one promised a preserved copy
   * without saying it could be reached, the other talked about unpublished
   * changes while reading a flag about whether a working copy existed at all.
   */
  it('sends you to the place the replaced copy actually is', () => {
    const m = syncMessage({ kind: 'updated', displaced: true });
    expect(m).toMatch(/History/);
    expect(m).toMatch(/Set aside on this computer/);
  });

  it('does not point at History when nothing was set aside', () => {
    const m = syncMessage({ kind: 'updated', displaced: false });
    expect(m).not.toMatch(/History/);
    expect(m).not.toMatch(/unpublished/i);
    expect(m).toMatch(/no previous copy/i);
  });

  it('passes an error through as written', () => {
    expect(syncMessage({ kind: 'error', message: 'Bad credentials' })).toBe('Bad credentials');
  });
});
