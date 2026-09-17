/**
 * What has been published, and what it would mean to go back to one.
 *
 * The safety Gene wanted from a separate dev site was never really about a
 * second site: it was "GitHub keeps every version and makes it easy to revert".
 * It does — and the editor has never shown a single one of them, so the safety
 * existed only for someone willing to open a terminal.
 *
 * Nothing here rewrites history. Going back to a version means loading it as
 * the working copy and publishing it forward as a new commit, so the record of
 * what happened stays true, including the mistake.
 */

export interface Commit {
  sha: string;
  when: number;
  message: string;
  author: string;
}

export interface Version extends Commit {
  /** Short form, as git and GitHub show it. */
  short: string;
  /** This is what the site is serving now. */
  current: boolean;
  /** Published by this editor, rather than arriving some other way. */
  fromEditor: boolean;
  /** Staged to the preview copy rather than sent to the live page. */
  preview: boolean;
  /** "just now", "2 hours ago" — what a person actually wants to read. */
  ago: string;
}

/**
 * Messages this editor writes. Matching them lets the list separate what was
 * done here from what arrived by other means — a hand-run deploy script, a
 * commit from the machine itself — which is the difference between "I did
 * that" and "where did that come from".
 */
const EDITOR_LIVE = /^Update site copy \(/;
const EDITOR_PREVIEW = /^Stage \d+ change/;

export function relativeTime(when: number, now: number): string {
  const s = Math.max(0, Math.round((now - when) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.round(mo / 12);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}

export function describeVersions(
  commits: Commit[],
  opts: { currentSha?: string | null; now?: number } = {},
): Version[] {
  const now = opts.now ?? Date.now();
  // Newest first is how the API returns them and how they are read; the one at
  // the top is current unless a specific sha says otherwise.
  const currentSha = opts.currentSha ?? commits[0]?.sha ?? null;
  return commits.map((c) => ({
    ...c,
    short: c.sha.slice(0, 7),
    current: c.sha === currentSha,
    fromEditor: EDITOR_LIVE.test(c.message) || EDITOR_PREVIEW.test(c.message),
    preview: EDITOR_PREVIEW.test(c.message),
    ago: relativeTime(c.when, now),
  }));
}

/**
 * Whether going back to a version is safe to offer right now.
 *
 * Restoring replaces the working copy, and queued edits are positions in the
 * copy being replaced — they would survive as numbers pointing into the wrong
 * text. Rather than repair that afterwards, do not start it.
 */
export function canRestore(
  version: Version,
  queued: number,
): { ok: true } | { ok: false; why: string } {
  if (version.current) {
    return { ok: false, why: 'This is the version the site is serving now.' };
  }
  if (queued > 0) {
    return {
      ok: false,
      why: `You have ${queued} change${queued === 1 ? '' : 's'} waiting. `
        + 'Publish or undo them first — going back would replace the page they are edits to.',
    };
  }
  return { ok: true };
}

/**
 * A working copy that was set aside to make room for GitHub's version.
 *
 * These were being written and never read — one `__displaced/...` key in the
 * whole codebase, at the line that creates it. The safety they were meant to
 * provide existed only for someone willing to open devtools, which is the same
 * gap this module was written to close for published versions.
 *
 * They are local and unpublished, so they have no sha and no commit message.
 * What identifies one is when it was set aside.
 */
export interface SetAside {
  /** The IndexedDB key it is stored under. */
  key: string;
  when: number;
  ago: string;
}

const SET_ASIDE_PREFIX = '__displaced/';

export function setAsideKeyFor(path: string, when: number): string {
  return `${SET_ASIDE_PREFIX}${when}/${path}`;
}

export function describeSetAside(keys: string[], now = Date.now()): SetAside[] {
  return keys
    .filter((k) => k.startsWith(SET_ASIDE_PREFIX))
    .map((key) => {
      const when = Number(key.slice(SET_ASIDE_PREFIX.length).split('/')[0]);
      return { key, when: Number.isFinite(when) ? when : 0, ago: '' };
    })
    .filter((v) => v.when > 0)
    .sort((a, b) => b.when - a.when)
    .map((v) => ({ ...v, ago: relativeTime(v.when, now) }));
}
