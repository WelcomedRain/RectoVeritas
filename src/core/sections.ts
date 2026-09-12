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
