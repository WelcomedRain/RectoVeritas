import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parseBundle } from './bundle';
import { indexTemplate, applyEdits } from './htmlIndex';
import { buildTargets } from './targets';
import { publish, editsFor, type PendingChange } from './publish';
import { destinationsFor } from './destination';
import {
  findSettings, withSetting, settingValue, placeholderKey, readableKey, encodeAttrJson,
  describeSettingChanges,
} from './props';

/** Against the real export, because the risk is the exporter's format, not ours. */
const REAL = 'G:/Anthea-Solve/index.html';
const real = () => (existsSync(REAL) ? parseBundle(readFileSync(REAL, 'utf8')).template : null);

describe('page settings', () => {
  it('finds the settings Claude Design exposes on the real page', () => {
    const t = real();
    if (!t) return;
    const [block] = findSettings(t);
    expect(block).toBeTruthy();
    const keys = block.settings.map((s) => s.key);
    expect(keys).toContain('availabilityText');
    expect(keys).toContain('showAvailability');
    expect(keys).toContain('showSpecs');
    const text = block.settings.find((s) => s.key === 'availabilityText')!;
    expect(text.editor).toBe('text');
    expect(typeof text.value).toBe('string');
    // The schema's own label wins over the readable key when there is one.
    expect(block.settings.find((s) => s.key === 'showSpecs')!.label)
      .toBe('Show technical specs on project cards');
  });

  /**
   * An untouched block must come back byte for byte. If the encoder differed
   * from the exporter in any way, the first edit would also rewrite every
   * other setting's bytes, and the diff would no longer say what changed.
   */
  it('round-trips the real block to identical bytes', () => {
    const t = real();
    if (!t) return;
    const [block] = findSettings(t);
    const schema = JSON.parse(block.raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    expect(encodeAttrJson(schema)).toBe(block.raw);
  });

  it('changes one default and leaves the rest alone', () => {
    const t = real();
    if (!t) return;
    const [block] = findSettings(t);
    const next = withSetting(block.raw, 'availabilityText', 'Booking for spring');
    expect(settingValue(next, 'availabilityText')).toBe('Booking for spring');
    expect(settingValue(next, 'showSpecs')).toBe(settingValue(block.raw, 'showSpecs'));
    // Still a valid attribute value: no raw double quote inside it.
    expect(next).not.toContain('"');
  });

  it('accumulates edits to different settings in one value', () => {
    const t = real();
    if (!t) return;
    const [block] = findSettings(t);
    const once = withSetting(block.raw, 'availabilityText', 'Booking for spring');
    const twice = withSetting(once, 'showSpecs', false);
    expect(settingValue(twice, 'availabilityText')).toBe('Booking for spring');
    expect(settingValue(twice, 'showSpecs')).toBe(false);
  });

  it('encodes characters that would end the attribute', () => {
    const next = withSetting(encodeAttrJson({ a: { default: 'x' } }), 'a', 'Say "hi" & go');
    expect(next).not.toContain('"');
    expect(settingValue(next, 'a')).toBe('Say "hi" & go');
  });

  it('reads the setting name out of a placeholder', () => {
    expect(placeholderKey('{{ availabilityText }}')).toBe('availabilityText');
    expect(placeholderKey('{{year}}')).toBe('year');
    expect(placeholderKey('Available for new work')).toBeNull();
  });

  it('makes a key readable', () => {
    expect(readableKey('availabilityText')).toBe('Availability text');
    expect(readableKey('showAvailability')).toBe('Show availability');
  });

  it('describes a change in words, one line per setting that moved', () => {
    const live = encodeAttrJson({
      availabilityText: { editor: 'text', default: 'Available for new work' },
      showAvailability: { editor: 'boolean', default: true },
      showSpecs: { editor: 'boolean', default: true, label: 'Show technical specs on project cards' },
    });
    const next = withSetting(withSetting(live, 'availabilityText', 'Booking for spring'), 'showAvailability', false);
    expect(describeSettingChanges(live, next)).toEqual([
      { label: 'Availability text', from: 'Available for new work', to: 'Booking for spring' },
      { label: 'Show availability', from: 'on', to: 'off' },
    ]);
  });

  /**
   * The whole publish pipeline, short of sending: round-trip check, rebuild
   * readback, share-tag splice and gate. A setting change has to survive all of
   * it, and the page that comes out must differ from the one that went in by
   * that one attribute value and nothing else.
   */
  it('publishes a setting change, and changes nothing but that value', async () => {
    if (!existsSync(REAL)) return;
    const file = readFileSync(REAL, 'utf8');
    const template = parseBundle(file).template;
    const [block] = findSettings(template);
    const change: PendingChange = {
      targetId: block.id, file: 'index.html', label: 'Page setting · Availability text',
      tag: 'data-props', kind: 'props', liveValue: block.raw,
      nextValue: withSetting(block.raw, 'availabilityText', 'Booking for spring'),
      start: block.start, end: block.end,
    };
    const targets = buildTargets(template, indexTemplate(template)).byId;
    const result = await publish({
      ref: { owner: 'x', repo: 'y', branch: 'main' }, token: '', originalFile: file,
      destination: destinationsFor('index.html', 'https://antheasolve.com/').live,
      changes: [change], targets, message: 'test', online: false,
    }, () => {});

    // Offline stops before sending, after every check has run.
    expect(result.outcome).toBe('queued');
    expect(result.steps.filter((x) => x.state === 'failed')).toEqual([]);
    const out = parseBundle(result.fileText!).template;
    expect(settingValue(findSettings(out)[0].raw, 'availabilityText')).toBe('Booking for spring');
    expect(out).toBe(applyEdits(template, editsFor([change], targets)));
  });
});
