/**
 * The shape the Style Trace arrives in, and how a page's answer becomes one.
 *
 * Kept apart from the panel so the interesting half — ranking the cascade and
 * checking the ranking against what the page actually draws — is testable
 * without a browser.
 */

import { rankDeclarations, checkAgainstComputed, type Agreement, type Declaration, type Ranked } from '../core/cascade';

export interface TraceResult {
  pending?: boolean;
  missing?: boolean;
  computed: string;
  winner: Ranked | null;
  overridden: Ranked[];
  /**
   * Whether the page confirms the ranking. Most values cannot be compared —
   * `clamp()` and `var()` resolve to something else entirely — and saying
   * nothing is the honest answer there.
   */
  agrees: Agreement;
  /** Stylesheets the page would not let the bridge read. */
  unreadable: number;
}

export interface TracePayload {
  elementId: string;
  prop: string;
  computed: string;
  decls: Declaration[];
  unreadable: number;
  missing: boolean;
}

export function readTrace(p: TracePayload): TraceResult {
  if (p.missing) {
    return {
      missing: true, computed: '', winner: null, overridden: [],
      agrees: 'not-comparable', unreadable: 0,
    };
  }
  const { winner, overridden } = rankDeclarations(p.decls);
  return {
    computed: p.computed,
    winner,
    overridden,
    // With nothing declared there is nothing to be wrong about: the computed
    // value is inherited or a browser default, which the panel says plainly.
    agrees: winner === null ? 'not-comparable' : checkAgainstComputed(winner.value, p.computed),
    unreadable: p.unreadable,
  };
}
