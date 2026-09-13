import { describe, it, expect } from 'vitest';
import {
  specificity, compareSpecificity, rankDeclarations, checkAgainstComputed, comparable,
  type Declaration,
} from './cascade';

const rule = (selector: string | null, value: string, order = 0, important = false): Declaration =>
  ({ selector, value, order, important });

describe('specificity', () => {
  it('counts ids, classes and types in their own columns', () => {
    expect(specificity('#id')).toEqual([1, 0, 0]);
    expect(specificity('.cls')).toEqual([0, 1, 0]);
    expect(specificity('div')).toEqual([0, 0, 1]);
    expect(specificity('#id .cls div')).toEqual([1, 1, 1]);
  });

  it('counts attributes and pseudo-classes with classes', () => {
    expect(specificity('[data-x]')).toEqual([0, 1, 0]);
    expect(specificity('a:hover')).toEqual([0, 1, 1]);
  });

  it('counts pseudo-elements with types, not with classes', () => {
    // ::before is one element-level thing; :before-the-colon rules are not.
    expect(specificity('p::before')).toEqual([0, 0, 2]);
  });

  it('ignores the universal selector, which contributes nothing', () => {
    expect(specificity('*')).toEqual([0, 0, 0]);
    expect(specificity('* .cls')).toEqual([0, 1, 0]);
  });

  it('does not let combinators inflate the count', () => {
    expect(specificity('ul > li + li')).toEqual([0, 0, 3]);
  });

  it('takes the inside of :not() but not of :where()', () => {
    expect(specificity('div:not(.cls)')).toEqual([0, 1, 1]);
    expect(specificity('div:where(.cls)')).toEqual([0, 0, 1]);
  });

  it('orders the way the cascade does', () => {
    expect(compareSpecificity([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0);
    expect(compareSpecificity([0, 1, 0], [0, 0, 9])).toBeGreaterThan(0);
    expect(compareSpecificity([0, 0, 1], [0, 0, 1])).toBe(0);
  });
});

describe('ranking the cascade', () => {
  /**
   * The case this whole feature exists for. This site puts most of its styling
   * in style attributes, so a stylesheet rule edit is correct, publishable and
   * completely invisible — which happened, and looked like the editor was
   * broken.
   */
  it('puts an element style attribute above any rule', () => {
    const t = rankDeclarations([
      rule('h1', '42px', 0),
      rule(null, '68px', 0),
    ]);
    expect(t.winner?.value).toBe('68px');
    expect(t.overridden[0].beatenBy).toBe('inline style');
  });

  it('puts !important above an inline style that is not important', () => {
    const t = rankDeclarations([
      rule(null, '68px', 0),
      rule('h1', '42px', 0, true),
    ]);
    expect(t.winner?.value).toBe('42px');
    expect(t.overridden[0].beatenBy).toBe('importance');
  });

  it('prefers the more specific rule', () => {
    const t = rankDeclarations([
      rule('h1', 'red', 0),
      rule('#title', 'blue', 0),
    ]);
    expect(t.winner?.value).toBe('blue');
    expect(t.overridden[0].beatenBy).toBe('specificity');
  });

  it('breaks a tie by document order, last one winning', () => {
    const t = rankDeclarations([
      rule('.a', 'first', 1),
      rule('.b', 'second', 2),
    ]);
    expect(t.winner?.value).toBe('second');
    expect(t.overridden[0].beatenBy).toBe('order');
  });

  it('lists everything that lost, strongest first', () => {
    const t = rankDeclarations([
      rule('div', 'c', 0),
      rule('#x', 'a', 0),
      rule('.y', 'b', 0),
    ]);
    expect(t.winner?.value).toBe('a');
    expect(t.overridden.map((o) => o.value)).toEqual(['b', 'c']);
  });

  it('has no opinion when nothing declares the property', () => {
    expect(rankDeclarations([])).toEqual({ winner: null, overridden: [] });
  });

  it('leaves a single declaration unchallenged', () => {
    const t = rankDeclarations([rule('h1', '42px', 0)]);
    expect(t.winner?.value).toBe('42px');
    expect(t.overridden).toHaveLength(0);
  });
});

describe('checking the ranking against the page', () => {
  /**
   * The prediction is checked against what the page draws, because the
   * specificity calculator is a subset and a confident wrong explanation is
   * worse than none.
   *
   * But most declared values are not the drawn value. The real winner on this
   * site's h1 is `clamp(34px, 5.2vw, 68px)` and the page draws `66.56px` —
   * the same value twice, not a disagreement. A check that called that wrong
   * would fire on nearly every trace and teach the reader to ignore it.
   */
  it('confirms a plain value that matches', () => {
    expect(checkAgainstComputed('42px', '42px')).toBe('confirmed');
    expect(checkAgainstComputed('  42PX ', '42px')).toBe('confirmed');
  });

  it('reports a real disagreement between plain values', () => {
    expect(checkAgainstComputed('42px', '68px')).toBe('differs');
  });

  it('stays quiet about values that resolve to something else', () => {
    expect(checkAgainstComputed('clamp(34px, 5.2vw, 68px)', '66.56px')).toBe('not-comparable');
    expect(checkAgainstComputed('var(--size)', '18px')).toBe('not-comparable');
    expect(checkAgainstComputed('2em', '32px')).toBe('not-comparable');
    expect(checkAgainstComputed('50%', '480px')).toBe('not-comparable');
    expect(checkAgainstComputed('#fff', 'rgb(255, 255, 255)')).toBe('not-comparable');
    expect(checkAgainstComputed('inherit', 'bold')).toBe('not-comparable');
  });

  it('says nothing when the page reported no computed value', () => {
    expect(checkAgainstComputed('42px', '')).toBe('not-comparable');
  });

  it('knows which values are worth comparing at all', () => {
    expect(comparable('42px')).toBe(true);
    expect(comparable('block')).toBe(true);
    expect(comparable('calc(100% - 2px)')).toBe(false);
    expect(comparable('1.5rem')).toBe(false);
  });
});
