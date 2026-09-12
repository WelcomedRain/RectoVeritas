import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { groupBySection } from './sections';
import { indexTemplate } from './htmlIndex';
import { parseBundle } from './bundle';

const idx = (html: string) => indexTemplate(html);

describe('grouping strings by part of the page', () => {
  const page = idx(`<html><body>
    <header><a href="#top">Logo</a></header>
    <section id="work"><h2>Selected work</h2><p>One</p><p>Two</p></section>
    <footer><p>Bye</p></footer>
  </body></html>`);

  it('keeps the parts in the order the page puts them', () => {
    const g = groupBySection(page, page.strings);
    expect(g.map((x) => x.section.label)).toEqual(['Header', 'Selected work', 'Footer']);
  });

  it('names a section by its own heading rather than its id', () => {
    // "Selected work" tells you where you are; "section#work" makes you work
    // it out.
    const g = groupBySection(page, page.strings);
    expect(g[1].section.label).toBe('Selected work');
  });

  it('falls back to a plain name where there is no heading', () => {
    const g = groupBySection(page, page.strings);
    expect(g[0].section.label).toBe('Header');
    expect(g[2].section.label).toBe('Footer');
  });

  it('groups by the outermost landmark, not the nearest', () => {
    // An <article> inside a section is still part of that section as far as
    // finding your place goes. Grouping by the nearest one would shatter the
    // page into more pieces than it has.
    const i = idx(`<html><body><section id="s"><h2>Work</h2>
      <article><p>A</p></article><article><p>B</p></article>
    </section></body></html>`);
    const g = groupBySection(i, i.strings);
    expect(g).toHaveLength(1);
    expect(g[0].section.label).toBe('Work');
  });

  it('puts anything outside a landmark in its own group, not a wrong one', () => {
    const i = idx('<html><body><p>Loose</p><footer><p>End</p></footer></body></html>');
    const g = groupBySection(i, i.strings);
    expect(g[0].section.label).toBe('Elsewhere on the page');
    expect(g[0].entries).toHaveLength(1);
  });

  it('loses no strings and duplicates none', () => {
    const g = groupBySection(page, page.strings);
    const out = g.flatMap((x) => x.entries.map((e) => e.id));
    expect(out).toHaveLength(page.strings.length);
    expect(new Set(out).size).toBe(page.strings.length);
  });

  it('keeps document order inside a group', () => {
    const g = groupBySection(page, page.strings);
    const work = g.find((x) => x.section.label === 'Selected work')!;
    const starts = work.entries.map((e) => e.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});

const REAL = 'G:/Anthea-Solve/index.html';
describe.skipIf(!existsSync(REAL))('against the real site', () => {
  const real = () => indexTemplate(parseBundle(readFileSync(REAL, 'utf8')).template);

  it('divides the page into a handful of readable parts', () => {
    const i = real();
    const g = groupBySection(i, i.strings.filter((s) => !s.pageInfo));
    // Few enough to scan, more than one. Measured in the browser: header, a
    // hero, five named sections and a footer.
    expect(g.length).toBeGreaterThan(3);
    expect(g.length).toBeLessThan(14);
  });

  it('names most parts with the words already on the page', () => {
    const i = real();
    const g = groupBySection(i, i.strings.filter((s) => !s.pageInfo));
    const named = g.filter((x) => x.section.label.split(' ').length > 1);
    expect(named.length).toBeGreaterThanOrEqual(g.length - 3);
  });

  it('accounts for every string it was given', () => {
    const i = real();
    const words = i.strings.filter((s) => !s.pageInfo);
    const total = groupBySection(i, words).reduce((n, x) => n + x.entries.length, 0);
    expect(total).toBe(words.length);
  });
});
