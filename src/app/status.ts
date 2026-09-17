/**
 * What the footer is for: answering, at a glance and without being asked,
 * the two questions that decide whether an action is safe.
 *
 *   1. Where does the working copy stand against the live site, and where
 *      would Publish send it?
 *   2. Can I publish right now, and if not, why not?
 *
 * There used to be a third, permanent slot reading "Editing a copy on this
 * computer". It was true, and it was removed for being true: a fact that can
 * never be otherwise reads as one of several possibilities, so stating it
 * invited the question "as opposed to what?" — which has no answer. The copy
 * on this device is the only thing the app can ever edit.
 */

import { deployLabel, deployTone } from '../core/deploy';
import type { DeployObservation } from '../core/deploy';

export type ConnectionTone = 'ok' | 'switched' | 'lost';

/**
 * Whether the live site is showing what you have.
 *
 * 'match' and 'waiting' carry a colour in the footer; 'unknown' deliberately
 * does not, because it is the absence of an observation rather than a result.
 */
export type PendingTone = 'match' | 'waiting' | 'unknown';

/**
 * The header's answer to "is what I am looking at still the site?".
 *
 * Four states, three tones. 'behind' and 'pending' share amber deliberately:
 * both mean the copy on screen and the live page disagree, and inventing a
 * third hue would imply a third kind of severity that does not exist. The word
 * carries which kind.
 *
 * 'unchecked' is grey and is the honest default. GitHub has to actually be
 * asked, and until it answers the app knows nothing — offline, a refused
 * request and a first run are all the same state and none of them is green.
 */
export type SiteState = 'match' | 'pending' | 'behind' | 'unchecked';

export function siteState(o: {
  dirty: number;
  remote: { inSync: boolean } | null;
  restored?: { short: string } | null;
  /** Unpublished work that is not a queued patch — a replaced image, a restore. */
  localModified?: boolean;
}): SiteState {
  // Ordered by what would mislead you most. A copy that is behind the site is
  // worse than one that is ahead of it: edits you queued are yours and known,
  // whereas a page that moved underneath you is neither.
  if (o.remote && !o.remote.inSync) return 'behind';
  if (o.dirty > 0 || o.restored || o.localModified) return 'pending';
  if (o.remote) return 'match';
  return 'unchecked';
}

export interface StatusLine {
  /** Question 1. What is queued and where Publish would send it. */
  pending: { text: string; tone: PendingTone };
  /** Question 2. Absent only when connected, which needs no explanation. */
  connection: { text: string; tone: ConnectionTone } | null;
}

/**
 * Where a publish would land, short enough to sit in a status bar.
 *
 * The host alone stopped being enough once a staged copy existed: preview and
 * live share a domain and differ only by path, so a bare host would name both
 * and distinguish neither.
 */
export function publishTarget(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.host : `${u.host}${u.pathname}`;
  } catch { return null; }
}

/**
 * The trap this separates: `online` was one flag standing for two unrelated
 * things. Flipping the header switch for a test and forgetting produced
 * "Offline" with a perfectly good connection, and nothing on screen could tell
 * you which of the two you were looking at.
 */
function connectionOf(o: { manualOffline: boolean; networkUp: boolean }): StatusLine['connection'] {
  if (o.manualOffline) return { text: 'Offline — you switched this on', tone: 'switched' };
  if (!o.networkUp) return { text: 'Offline — no connection, so nothing can publish', tone: 'lost' };
  return null;
}

export function statusLine(o: {
  dirty: number;
  networkUp: boolean;
  manualOffline: boolean;
  /** The URL the next publish would write to — not necessarily the live one. */
  publishTo?: string | null;
  deploy: DeployObservation | null;
  lastPush: number | null;
  /** Set when the working copy is an older version loaded back. */
  restored?: { short: string } | null;
  /** The last look at GitHub, or null if it has never answered. */
  remote?: { inSync: boolean } | null;
  /** Unpublished work with no patch to count — a replaced image, a restore. */
  localModified?: boolean;
}): StatusLine {
  const host = publishTarget(o.publishTo);
  // A restore replaces the page wholesale and so produces no edits. Counting
  // them would say nothing is waiting while the working copy holds something
  // the site has never served.
  if (o.dirty === 0 && o.restored) {
    return {
      // Waiting, not matching: the working copy holds a version the site is
      // not serving, which is the same answer as a queued edit for the only
      // question this slot asks.
      pending: {
        text: host
          ? `Showing version ${o.restored.short} · Publish sends it to ${host}`
          : `Showing version ${o.restored.short}, which the site is not serving`,
        tone: 'waiting',
      },
      connection: connectionOf(o),
    };
  }

  if (o.dirty === 0 && o.localModified) {
    return {
      pending: {
        text: host
          ? `This copy has unpublished changes · Publish sends them to ${host}`
          : 'This copy has unpublished changes',
        tone: 'waiting',
      },
      connection: connectionOf(o),
    };
  }

  const one = o.dirty === 1;
  const changes = `${o.dirty} change${one ? '' : 's'} waiting`;
  const pending: StatusLine['pending'] = o.dirty > 0
    ? {
      text: host ? `${changes} · Publish sends ${one ? 'it' : 'them'} to ${host}` : changes,
      tone: 'waiting',
    }
    : o.remote && !o.remote.inSync
      ? {
        // Said plainly, because it is the one state where the page on screen
        // is not a version of the site at all.
        text: 'The site has changed since you opened this copy',
        tone: 'waiting' as const,
      }
      : !o.deploy && !o.lastPush && !o.remote
        ? {
          // The old wording here asserted a match on the strength of having
          // nothing queued, which is a different fact entirely.
          text: 'Working copy not checked against the live site',
          tone: 'unknown' as const,
        }
        : {
          text: deployLabel(o.deploy, o.lastPush),
          tone: deployTone(o.deploy, o.lastPush),
        };

  // The trap this separates: `online` was one flag standing for two unrelated
  // things. Flipping the header switch for a test and forgetting produced
  // "Offline" with a perfectly good connection, and nothing on screen could
  // tell you which of the two you were looking at.
  return { pending, connection: connectionOf(o) };
}

/**
 * The word the header shows for each state.
 *
 * PLACEHOLDER WORDING — these four strings are the whole of what the header
 * says, and they belong to whoever owns the app's voice. The states they name
 * are settled; the words are not.
 */
export const SITE_WORD: Record<SiteState, string> = {
  match: 'matches live',
  pending: 'edits pending',
  behind: 'site has changed',
  unchecked: 'not checked',
};

/**
 * What to say about the outcome of a look at GitHub.
 *
 * Pulled out of the dialog because these are claims about what happened to the
 * only copy of the user's work, and two of them were wrong: one promised a
 * preserved copy without saying it is reachable, and one answered a question
 * about unpublished changes when the flag it reads is about whether there was
 * a stored working copy at all.
 */
export function syncMessage(sync:
  | { kind: 'up-to-date' }
  | { kind: 'updated'; displaced: boolean }
  | { kind: 'error'; message: string }): string {
  switch (sync.kind) {
    case 'up-to-date':
      return 'Your working copy is based on the current version on GitHub.';
    case 'updated':
      return sync.displaced
        ? 'Updated from GitHub. The copy it replaced is kept in History, '
          + 'under "Set aside on this computer".'
        // False only when there was no stored working copy to set aside. It
        // says nothing about queued edits, which survive either way.
        : 'Updated from GitHub. There was no previous copy to set aside.';
    case 'error':
      return sync.message;
  }
}
