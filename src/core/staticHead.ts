/**
 * Keeping the two copies of the share tags in step.
 *
 * This site carries its share tags twice. One copy is literal HTML inside
 * <head>, put there by tools/apply_static_head.py, and it is the copy that
 * matters: scrapers do not run JavaScript, so Google and every link preview
 * read this one and nothing else. The other lives in the <helmet> block inside
 * the template, which the page runtime hoists into <head> when it renders —
 * after a scraper has already come and gone.
 *
 * The editor indexes the template, so every Share / SEO edit has been landing
 * in the copy that scrapers never see. The gate checked the literal block was
 * present and well formed; it never checked it was current. Both were true at
 * once, which is how the two drifted apart without a word: the live site has
 * been telling search engines it builds "desktop applications" while the page
 * itself says "web apps".
 *
 * So on publish the literal block is rewritten from the template's values. Only
 * the values — never the set of tags, never their order, never anything the
 * template has no opinion about. The template only exposes <meta content>, so
 * canonical, the icons and the preconnects cannot be touched here even by
 * mistake.
 */

import { encodeAttr } from './htmlIndex';

export const HEAD_BEGIN = '<!-- static-head:begin';
export const HEAD_END = '<!-- static-head:end -->';

export interface HeadSync {
  /** The file with the literal block brought up to date. */
  text: string;
  /** Keys whose value was rewritten, with what they were and now are. */
  changed: { key: string; was: string; now: string }[];
  /** True when there is no literal block to sync — the gate reports that. */
  missing: boolean;
}

/** The identifying key of a meta tag: its `name` or its `property`. */
function keyOf(tag: string): string | null {
  const m = tag.match(/\bname="([^"]+)"/) ?? tag.match(/\bproperty="([^"]+)"/);
  return m ? m[1] : null;
}

function bounds(fileText: string): { start: number; end: number } | null {
  const start = fileText.indexOf(HEAD_BEGIN);
  if (start === -1) return null;
  const end = fileText.indexOf(HEAD_END, start);
  if (end === -1) return null;
  return { start, end };
}

/**
 * Rewrite the literal block's meta values from `values`, keyed by name or
 * property. A tag the template says nothing about is left exactly as it is,
 * byte for byte — including tags that exist only here.
 */
export function syncStaticHead(fileText: string, values: Map<string, string>): HeadSync {
  const at = bounds(fileText);
  if (!at) return { text: fileText, changed: [], missing: true };

  const changed: HeadSync['changed'] = [];
  const block = fileText.slice(at.start, at.end);

  const next = block.replace(/<meta\b[^>]*>/g, (tag) => {
    const key = keyOf(tag);
    if (key === null) return tag;
    if (!values.has(key)) return tag;

    const current = tag.match(/\bcontent="([^"]*)"/);
    // A meta with no content attribute is not ours to invent one for.
    if (!current) return tag;

    const want = encodeAttr(values.get(key)!);
    if (current[1] === want) return tag;

    changed.push({ key, was: current[1], now: want });
    return tag.replace(/\bcontent="[^"]*"/, `content="${want}"`);
  });

  return {
    text: fileText.slice(0, at.start) + next + fileText.slice(at.end),
    changed,
    missing: false,
  };
}

/**
 * Where the two copies still disagree.
 *
 * Run after the rewrite, so a non-empty answer means the rewrite could not do
 * its job — not that the page needs one.
 */
export function headMismatches(
  fileText: string,
  values: Map<string, string>,
): { key: string; scraper: string; template: string }[] {
  const at = bounds(fileText);
  if (!at) return [];
  const out: { key: string; scraper: string; template: string }[] = [];
  for (const tag of fileText.slice(at.start, at.end).match(/<meta\b[^>]*>/g) ?? []) {
    const key = keyOf(tag);
    if (key === null || !values.has(key)) continue;
    const content = tag.match(/\bcontent="([^"]*)"/);
    if (!content) continue;
    const want = encodeAttr(values.get(key)!);
    if (content[1] !== want) out.push({ key, scraper: content[1], template: want });
  }
  return out;
}
