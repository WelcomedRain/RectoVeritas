/**
 * Page settings — the values Claude Design exposes as tweakable properties.
 *
 * Some visible text is not in the markup at all. "Available for new work" is
 * written as `{{ availabilityText }}`, and the words come from a settings block
 * Claude Design puts on the page's component script:
 *
 *   <script type="text/x-dc" data-dc-script data-props="{ …schema… }">
 *
 * The attribute holds a schema — for each setting an editor type, a default
 * and a section — as HTML-entity-encoded JSON. The schema's `default` is what
 * the page renders. That was measured, not assumed: rendering variants through
 * the real runtime showed that changing `default` changes the page, while
 * changing the `?? "…"` fallback inside `renderVals()` does nothing, because the
 * runtime always supplies props from the schema and the fallback never fires.
 *
 * So an edit here rewrites one `default` inside that attribute and leaves every
 * other byte of it alone.
 */

import { decodeEntities } from './htmlIndex';

export interface PageSetting {
  key: string;
  /** Claude Design's editor type: 'text', 'boolean', … */
  editor: string;
  /** The schema's own label when it has one, otherwise the key made readable. */
  label: string;
  /** The schema default — what the page renders. */
  value: unknown;
  section: string;
}

export interface SettingsBlock {
  /** Identity for the queued change: one per settings attribute. */
  id: string;
  /** Range of the attribute's VALUE in the template, still entity-encoded. */
  start: number;
  end: number;
  raw: string;
  settings: PageSetting[];
}

const SCRIPT_RE = /<script\b[^>]*\btype="text\/x-dc"[^>]*>/g;
const PROPS_ATTR = 'data-props="';

/** availabilityText → "Availability text". */
export function readableKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Encode JSON for a double-quoted attribute the way the exporter does.
 *
 * Only `&` and `"` need it. Matching the exporter exactly is what lets an
 * unchanged block round-trip to identical bytes, which `encodeSettings` is
 * tested for against the real export.
 */
export function encodeAttrJson(value: unknown): string {
  return JSON.stringify(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function parseSchema(raw: string): Record<string, Record<string, unknown>> | null {
  try {
    const v = JSON.parse(decodeEntities(raw));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function findSettings(template: string): SettingsBlock[] {
  const blocks: SettingsBlock[] = [];
  for (const m of template.matchAll(SCRIPT_RE)) {
    const tag = m[0];
    const at = tag.indexOf(PROPS_ATTR);
    if (at === -1) continue;
    const start = (m.index ?? 0) + at + PROPS_ATTR.length;
    const end = template.indexOf('"', start);
    if (end === -1) continue;
    const raw = template.slice(start, end);
    const schema = parseSchema(raw);
    if (!schema) continue;
    const settings = Object.entries(schema).map(([key, s]) => ({
      key,
      editor: typeof s.editor === 'string' ? s.editor : 'text',
      label: typeof s.label === 'string' && s.label ? s.label : readableKey(key),
      value: s.default,
      section: typeof s.section === 'string' ? s.section : '',
    }));
    if (settings.length) blocks.push({ id: `props:${start}`, start, end, raw, settings });
  }
  return blocks;
}

/**
 * The attribute value with one setting's default replaced.
 *
 * Works from an encoded value rather than from the block, so successive edits
 * to different settings accumulate in one queued change instead of each one
 * reverting the last.
 */
export function withSetting(encoded: string, key: string, value: unknown): string {
  const schema = parseSchema(encoded);
  if (!schema || !schema[key]) return encoded;
  return encodeAttrJson({ ...schema, [key]: { ...schema[key], default: value } });
}

/** A setting's value as it stands in an encoded block. */
export function settingValue(encoded: string, key: string): unknown {
  return parseSchema(encoded)?.[key]?.default;
}

/** The setting a `{{ name }}` placeholder reads, when its name is one. */
export function placeholderKey(value: string): string | null {
  const m = value.trim().match(/^\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}$/);
  return m ? m[1] : null;
}

/**
 * What a settings change does, one line per setting, in words.
 *
 * The queued change holds the whole encoded block, because that is what gets
 * written. Shown as is, the publish review was a wall of `&quot;` with the one
 * value that changed buried somewhere in it.
 */
export function describeSettingChanges(
  liveValue: string,
  nextValue: string,
): { label: string; from: string; to: string }[] {
  const before = parseSchema(liveValue) ?? {};
  const after = parseSchema(nextValue) ?? {};
  const say = (v: unknown) => (v === true ? 'on' : v === false ? 'off' : String(v ?? ''));
  return Object.keys(after)
    .filter((k) => JSON.stringify(before[k]?.default) !== JSON.stringify(after[k]?.default))
    .map((k) => {
      const label = after[k]?.label;
      return {
        label: typeof label === 'string' && label ? label : readableKey(k),
        from: say(before[k]?.default),
        to: say(after[k]?.default),
      };
    });
}
