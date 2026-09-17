import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parseBundle, serializeBundle } from './bundle';
import { indexTemplate } from './htmlIndex';
import { compareBundles } from './compare';

/**
 * Against the real export, for the reason the other suites use it: the risk is
 * that our model of the format differs from the exporter's, and a synthetic
 * fixture hides exactly that.
 */
const REAL = 'G:/Anthea-Solve/index.html';

describe('comparing two versions of the page', () => {
  const load = () => {
    if (!existsSync(REAL)) return null;
    return readFileSync(REAL, 'utf8');
  };

  it('finds nothing between a file and itself', () => {
    const text = load();
    if (!text) return;
    const c = compareBundles(text, text);
    expect(c.identical).toBe(true);
    expect(c.differences).toHaveLength(0);
  });

  it('names a changed string by the label the editor uses', () => {
    const text = load();
    if (!text) return;
    const b = parseBundle(text);
    const idx = indexTemplate(b.template);
    const target = idx.strings.find((s) => s.kind === 'text' && s.value.trim().length > 12);
    expect(target).toBeTruthy();

    const changed = b.template.slice(0, target!.start)
      + 'COMPARISON PROBE'
      + b.template.slice(target!.end);
    const c = compareBundles(text, serializeBundle(b, { template: changed }));

    expect(c.identical).toBe(false);
    const hit = c.differences.find((d) => d.theirs === 'COMPARISON PROBE');
    expect(hit).toBeTruthy();
    expect(hit!.kind).toBe('changed');
    expect(hit!.tag).toBe(target!.tag);
    expect(hit!.mine).toContain(target!.value.trim().slice(0, 12));
  });

  /**
   * The reason this matches on tag-and-position rather than on the index's own
   * ids: those are positional counters, so one inserted element renumbers
   * everything after it. Matching by id would report a whole page as changed
   * over a single addition.
   */
  it('does not report a whole page as changed when one element is inserted', () => {
    const text = load();
    if (!text) return;
    const b = parseBundle(text);
    const at = b.template.indexOf('</body>');
    expect(at).toBeGreaterThan(-1);
    const grown = b.template.slice(0, at) + '<p>An added paragraph</p>' + b.template.slice(at);
    const c = compareBundles(text, serializeBundle(b, { template: grown }));

    expect(c.differences.length).toBeLessThan(4);
    expect(c.differences.some((d) => d.kind === 'only-theirs')).toBe(true);
  });

  it('counts a replaced image without describing its bytes', () => {
    const text = load();
    if (!text) return;
    const b = parseBundle(text);
    const key = Object.keys(b.manifest)[0];
    expect(key).toBeTruthy();
    const manifest = { ...b.manifest, [key]: { ...b.manifest[key], data: 'AAAA' } };
    const c = compareBundles(text, serializeBundle(b, { manifest }));

    expect(c.imagesChanged).toBe(1);
    expect(c.identical).toBe(false);
  });

  it('reports a reason rather than throwing when a side is unreadable', () => {
    const c = compareBundles('not a bundle at all', 'nor is this');
    expect(c.error).toBeTruthy();
    expect(c.differences).toHaveLength(0);
  });
});
