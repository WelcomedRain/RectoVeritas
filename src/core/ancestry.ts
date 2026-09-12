/**
 * The chain from an element up to the page.
 *
 * Selection lands on the smallest thing under the pointer, which is right for
 * changing a word and wrong for everything structural. A list item cannot gain
 * or lose siblings from inside itself: adding or removing one is an edit to the
 * `<ul>`, and until there was a way to reach the `<ul>` there was no way to do
 * it at all. The same gap hid a logo built from an `<img>` and two `<span>`s
 * inside one `<a>` — four separate boxes with nothing saying they were one
 * link.
 */

import type { ElementNode, TemplateIndex } from './htmlIndex';

export interface Crumb {
  id: string;
  /** What to call it: the tag, plus an id or first class when it has one. */
  label: string;
  tag: string;
  /** True for the element the selection is actually on. */
  current: boolean;
  /**
   * Worth offering as a step. Wrappers with no identity of their own are
   * still listed — hiding them would make the trail lie about the shape of
   * the page — but the caller may want to render them more quietly.
   */
  notable: boolean;
}

const SKIP = new Set(['html', 'head', 'x-dc', 'helmet']);

/** Tags worth naming even without an id or class: they carry meaning. */
const MEANINGFUL = new Set([
  'body', 'header', 'nav', 'main', 'footer', 'section', 'article', 'aside',
  'ul', 'ol', 'dl', 'table', 'form', 'figure', 'blockquote', 'a', 'button',
  'li', 'picture', 'video',
]);

function identify(el: ElementNode): string {
  const id = el.attrs.find((a) => a.name === 'id')?.value?.trim();
  if (id) return `${el.tag}#${id}`;
  const cls = el.attrs.find((a) => a.name === 'class')?.value?.trim().split(/\s+/)[0];
  // Scoped class names the runtime generates say nothing to a person.
  if (cls && !/^scp\d/i.test(cls)) return `${el.tag}.${cls}`;
  return el.tag;
}

/**
 * Outermost first, so it reads left to right like a path and the element you
 * are on sits at the end where the eye finishes.
 */
export function ancestryOf(index: TemplateIndex, elementId: string | null): Crumb[] {
  if (!elementId) return [];
  const chain: ElementNode[] = [];
  let node = index.byId.get(elementId) ?? null;
  const guard = new Set<string>();
  while (node && !guard.has(node.id)) {
    guard.add(node.id);
    if (!SKIP.has(node.tag)) chain.push(node);
    node = node.parentId ? index.byId.get(node.parentId) ?? null : null;
  }
  chain.reverse();
  return chain.map((el, i) => ({
    id: el.id,
    tag: el.tag,
    label: identify(el),
    current: i === chain.length - 1,
    notable: MEANINGFUL.has(el.tag) || el.attrs.some((a) => a.name === 'id'),
  }));
}

/**
 * The nearest ancestor it makes sense to edit as one piece.
 *
 * Used for a single "select the whole block" step, so the common case — being
 * on an `<li>` and wanting the list — takes one click rather than a hunt along
 * the trail.
 */
export function enclosingBlock(index: TemplateIndex, elementId: string | null): Crumb | null {
  const chain = ancestryOf(index, elementId);
  if (chain.length < 2) return null;
  // Walk outward from the selection, skipping the selection itself.
  for (let i = chain.length - 2; i >= 0; i--) {
    if (chain[i].notable) return chain[i];
  }
  return chain[chain.length - 2] ?? null;
}
