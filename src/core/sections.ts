/**
 * The parts of the page, as the page itself defines them.
 *
 * A column of 199 boxes in document order gives no sense of where you are in
 * it. These groups are not invented: they are the landmark elements the markup
 * already uses — header, the sections, footer — so the grouping cannot drift
 * away from the page it describes. Measured on the real site: 262 of 264 body
 * elements sit inside one, and every section carries a heading that names it
 * better than any tag could.
 */

import type { StringEntry, TemplateIndex } from './htmlIndex';

export interface PageSection {
  /** Element id of the landmark, or `''` for anything outside one. */
  id: string;
  /** What to call it: its own heading, else its id, else the kind of thing. */
  label: string;
  tag: string;
}

export interface SectionGroup {
  section: PageSection;
  entries: StringEntry[];
}

const LANDMARK = new Set([
  'header', 'nav', 'footer', 'section', 'article', 'aside',
]);

/** Names for landmarks that carry no heading of their own. */
const PLAIN: Record<string, string> = {
  header: 'Header', nav: 'Navigation', footer: 'Footer', aside: 'Aside',
};

const LOOSE: PageSection = { id: '', label: 'Elsewhere on the page', tag: '' };

/**
 * The outermost landmark an element sits in.
 *
 * Outermost, not nearest: an `<article>` inside a section is part of that
 * section as far as finding your place goes, and grouping by the nearest one
 * would shatter a page into more pieces than it has.
 */
function topLandmarkId(index: TemplateIndex, elementId: string): string {
  const chain: string[] = [];
  let node = index.byId.get(elementId) ?? null;
  const seen = new Set<string>();
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    if (LANDMARK.has(node.tag)) chain.push(node.id);
    node = node.parentId ? index.byId.get(node.parentId) ?? null : null;
  }
  return chain.length ? chain[chain.length - 1] : '';
}

function isWithin(index: TemplateIndex, elementId: string, ancestorId: string): boolean {
  let node = index.byId.get(elementId) ?? null;
  const seen = new Set<string>();
  while (node && !seen.has(node.id)) {
    if (node.id === ancestorId) return true;
    seen.add(node.id);
    node = node.parentId ? index.byId.get(node.parentId) ?? null : null;
  }
  return false;
}

function labelFor(index: TemplateIndex, sectionId: string): PageSection {
  const el = index.byId.get(sectionId);
  if (!el) return LOOSE;

  // Its own heading says what it is far better than `section#work` does.
  for (const s of index.strings) {
    if (s.kind !== 'text') continue;
    const owner = index.byId.get(s.elementId);
    if (!owner || !/^h[1-3]$/.test(owner.tag)) continue;
    if (!isWithin(index, owner.id, sectionId)) continue;
    const text = s.value.trim().replace(/\s+/g, ' ');
    if (text) return { id: sectionId, tag: el.tag, label: text };
  }

  const id = el.attrs.find((a) => a.name === 'id')?.value?.trim();
  return {
    id: sectionId,
    tag: el.tag,
    label: PLAIN[el.tag] ?? (id ? `${el.tag} · ${id}` : el.tag),
  };
}

/**
 * Group strings by the part of the page they belong to, keeping document
 * order both within a group and between groups.
 */
export function groupBySection(index: TemplateIndex, strings: StringEntry[]): SectionGroup[] {
  const sectionOf = new Map<string, string>();
  const labels = new Map<string, PageSection>();
  const groups: SectionGroup[] = [];
  const byId = new Map<string, SectionGroup>();

  for (const s of strings) {
    let secId = sectionOf.get(s.elementId);
    if (secId === undefined) {
      secId = s.elementId ? topLandmarkId(index, s.elementId) : '';
      sectionOf.set(s.elementId, secId);
    }
    let group = byId.get(secId);
    if (!group) {
      let label = labels.get(secId);
      if (!label) {
        label = secId ? labelFor(index, secId) : LOOSE;
        labels.set(secId, label);
      }
      group = { section: label, entries: [] };
      byId.set(secId, group);
      groups.push(group);
    }
    group.entries.push(s);
  }
  return groups;
}

/**
 * Strings that are parts of one thing.
 *
 * A logo is an `<a>` holding an image and two spans, and it arrives in the list
 * as four consecutive boxes — a web address, an image description and two
 * fragments of text — with nothing to say they are one link. Each is editable
 * and none of them is the thing you are looking at.
 *
 * Two conditions, and the first was learned by getting it wrong. A count alone
 * ("any element owning two or more strings") produced eighty-one groups on this
 * site: every layout div acquired a heading reading "div", and the logo split
 * in two because the inner <span> owning both text runs sits nearer than the
 * <a> that owns all four. Clutter, and the wrong answer to the one case it was
 * built for.
 *
 * So: the owner must be something a person would name — a link, a button, a
 * list item — AND own more than one of the strings here. A layout div is not a
 * thing; a link is. An element owning all of them is just the container.
 */

/** Elements that are one thing made of parts, rather than a box around parts. */
const COMPOSITE = new Set([
  'a', 'button', 'li', 'figure', 'figcaption', 'blockquote', 'label',
  'summary', 'dt', 'dd', 'picture', 'video', 'h1', 'h2', 'h3', 'h4',
]);
export interface Cluster {
  /** The element these strings belong to, or null for a string standing alone. */
  ownerId: string | null;
  tag: string;
  /** Enough of its words to recognise it by. */
  preview: string;
  entries: StringEntry[];
}

/** Ancestors of an element, nearest first, stopping before `withinId`. */
function ancestorsWithin(index: TemplateIndex, elementId: string, withinId: string): string[] {
  const out: string[] = [];
  let node = index.byId.get(elementId) ?? null;
  const seen = new Set<string>();
  while (node && node.id !== withinId && !seen.has(node.id)) {
    seen.add(node.id);
    out.push(node.id);
    node = node.parentId ? index.byId.get(node.parentId) ?? null : null;
  }
  return out;
}

export function clusterByOwner(
  index: TemplateIndex,
  entries: StringEntry[],
  withinId: string,
): Cluster[] {
  const chains = new Map<string, string[]>();
  const owns = new Map<string, number>();

  for (const e of entries) {
    let chain = chains.get(e.elementId);
    if (!chain) {
      chain = e.elementId ? ancestorsWithin(index, e.elementId, withinId) : [];
      chains.set(e.elementId, chain);
    }
    for (const id of chain) owns.set(id, (owns.get(id) ?? 0) + 1);
  }

  const ownerFor = (e: StringEntry): string | null => {
    for (const id of chains.get(e.elementId) ?? []) {
      const n = owns.get(id) ?? 0;
      if (n < 2 || n >= entries.length) continue;
      if (!COMPOSITE.has(index.byId.get(id)?.tag ?? '')) continue;
      return id;
    }
    return null;
  };

  const out: Cluster[] = [];
  for (const e of entries) {
    const owner = ownerFor(e);
    const last = out[out.length - 1];
    if (last && last.ownerId !== null && last.ownerId === owner) {
      last.entries.push(e);
      continue;
    }
    out.push({
      ownerId: owner,
      tag: owner ? index.byId.get(owner)?.tag ?? '' : '',
      preview: '',
      entries: [e],
    });
  }

  // A group of one is a heading over a single box: all cost, no information.
  // It happens when an owner's strings are not consecutive in the list.
  for (const c of out) {
    if (c.entries.length < 2) { c.ownerId = null; c.tag = ''; }
  }

  // Name each cluster by its own words, which is how a person recognises it.
  for (const c of out) {
    if (!c.ownerId) continue;
    const words = c.entries
      .filter((e) => e.kind === 'text')
      .map((e) => e.value.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
    c.preview = (words || c.entries.map((e) => e.value.trim()).find(Boolean) || '').slice(0, 60);
  }
  return out;
}
