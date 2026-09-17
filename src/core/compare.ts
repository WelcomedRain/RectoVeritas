/**
 * What differs between two versions of the page, in the words the editor uses.
 *
 * A text diff is useless here: the page is a JSON-encoded string on ONE line
 * inside a script tag, so every difference reads as "line 1 changed". The
 * editor already knows how to name the parts of the page — that index is what
 * makes a real answer possible.
 *
 * Entries are matched by `tag` and position within that tag, never by the
 * index's own ids. Those ids are positional counters (`s1`, `s2`, …), so a
 * single inserted element renumbers everything after it and would report a
 * whole page as changed. Tag plus occurrence survives an insertion elsewhere,
 * which is the case that actually happens.
 */

import { parseBundle } from './bundle';
import { indexTemplate } from './htmlIndex';

export interface Difference {
  /** `h1`, `og:description`, `img@alt` — what the editor calls it. */
  tag: string;
  label: string;
  kind: 'changed' | 'only-mine' | 'only-theirs';
  mine?: string;
  theirs?: string;
}

export interface Comparison {
  differences: Difference[];
  /** Assets present in both, whose bytes are not the same. */
  imagesChanged: number;
  imagesOnlyMine: number;
  imagesOnlyTheirs: number;
  identical: boolean;
  /** Set when a side could not be read at all. */
  error?: string;
}

/** Long values are for recognising, not for reading in full. */
function clip(v: string, n = 120): string {
  const flat = v.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

function byTag(text: string) {
  const index = indexTemplate(text);
  const groups = new Map<string, { label: string; value: string }[]>();
  for (const s of index.strings) {
    const list = groups.get(s.tag) ?? [];
    list.push({ label: s.label, value: s.value });
    groups.set(s.tag, list);
  }
  return groups;
}

export function compareBundles(mineText: string, theirsText: string): Comparison {
  let mine, theirs;
  try {
    mine = parseBundle(mineText);
    theirs = parseBundle(theirsText);
  } catch (e) {
    return {
      differences: [], imagesChanged: 0, imagesOnlyMine: 0, imagesOnlyTheirs: 0,
      identical: false, error: (e as Error).message,
    };
  }

  const differences: Difference[] = [];

  if (mine.template !== theirs.template) {
    const a = byTag(mine.template);
    const b = byTag(theirs.template);
    for (const tag of new Set([...a.keys(), ...b.keys()])) {
      const left = a.get(tag) ?? [];
      const right = b.get(tag) ?? [];
      for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const l = left[i];
        const r = right[i];
        if (l && r) {
          if (l.value !== r.value) {
            differences.push({
              tag, label: l.label, kind: 'changed',
              mine: clip(l.value), theirs: clip(r.value),
            });
          }
        } else if (l) {
          differences.push({ tag, label: l.label, kind: 'only-mine', mine: clip(l.value) });
        } else if (r) {
          differences.push({ tag, label: r.label, kind: 'only-theirs', theirs: clip(r.value) });
        }
      }
    }
  }

  // Assets are keyed by UUID and the page references the bare UUID, so a
  // changed image keeps its key and changes its bytes.
  let imagesChanged = 0;
  let imagesOnlyMine = 0;
  let imagesOnlyTheirs = 0;
  for (const key of new Set([...Object.keys(mine.manifest), ...Object.keys(theirs.manifest)])) {
    const l = mine.manifest[key];
    const r = theirs.manifest[key];
    if (l && r) { if (l.data !== r.data) imagesChanged++; }
    else if (l) imagesOnlyMine++;
    else imagesOnlyTheirs++;
  }

  return {
    differences,
    imagesChanged,
    imagesOnlyMine,
    imagesOnlyTheirs,
    identical: differences.length === 0 && imagesChanged === 0
      && imagesOnlyMine === 0 && imagesOnlyTheirs === 0,
  };
}
