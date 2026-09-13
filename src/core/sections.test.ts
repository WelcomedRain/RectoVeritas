import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { groupBySection, clusterByOwner } from './sections';
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

describe('strings that are parts of one thing', () => {
  const root = (i: ReturnType<typeof idx>) => i.elements.find((e) => e.tag === 'body')!.id;

  /**
   * The case Gene raised: the site logo is one <a> holding an image and two
   * spans, and it arrives as four consecutive boxes — a web address, an image
   * description and two fragments of text — with nothing saying they are one
   * link.
   */
  it('gathers a link built from an image and two spans', () => {
    const i = idx(`<html><body><header>
      <a href="#top"><img src="l.png" alt="Anthea Solve"><span>Anthea</span><span> Solve</span></a>
      <p>Something else</p>
    </header></body></html>`);
    const header = i.elements.find((e) => e.tag === 'header')!.id;
    const inHeader = i.strings.filter((s) => !s.pageInfo);
    const c = clusterByOwner(i, inHeader, header);

    const link = c.find((x) => x.tag === 'a')!;
    expect(link).toBeTruthy();
    expect(link.entries).toHaveLength(4);
    expect(link.preview).toBe('Anthea Solve');
    // And the unrelated paragraph is not swept in with it.
    expect(c.find((x) => x.ownerId === null)?.entries[0].value).toBe('Something else');
  });

  it('leaves a lone string alone rather than inventing a group of one', () => {
    const i = idx('<html><body><section><p>Just this</p></section></body></html>');
    const sec = i.elements.find((e) => e.tag === 'section')!.id;
    const c = clusterByOwner(i, i.strings, sec);
    expect(c).toHaveLength(1);
    expect(c[0].ownerId).toBeNull();
  });

  it('does not treat the container itself as a thing made of parts', () => {
    // An element owning every string in the band is the band. Naming it would
    // add a heading that repeats the one directly above it.
    const i = idx('<html><body><section><p>One</p><p>Two</p></section></body></html>');
    const sec = i.elements.find((e) => e.tag === 'section')!.id;
    expect(clusterByOwner(i, i.strings, sec).every((c) => c.ownerId === null)).toBe(true);
  });

  it('picks the nearest owner, not the outermost', () => {
    const i = idx(`<html><body><section>
      <a href="#a"><span>One</span><span>Two</span></a>
      <a href="#b"><span>Three</span><span>Four</span></a>
    </section></body></html>`);
    const sec = i.elements.find((e) => e.tag === 'section')!.id;
    const c = clusterByOwner(i, i.strings, sec).filter((x) => x.ownerId);
    expect(c).toHaveLength(2);
    expect(c[0].preview).toBe('One Two');
    expect(c[1].preview).toBe('Three Four');
  });

  it('keeps every string exactly once', () => {
    const i = idx(`<html><body><section>
      <a href="#a"><img alt="Logo"><span>Name</span></a><p>Prose</p>
    </section></body></html>`);
    const sec = i.elements.find((e) => e.tag === 'section')!.id;
    const flat = clusterByOwner(i, i.strings, sec).flatMap((c) => c.entries.map((e) => e.id));
    expect(flat).toHaveLength(i.strings.length);
    expect(new Set(flat).size).toBe(i.strings.length);
  });

  it('names a cluster with no text of its own by whatever it does have', () => {
    const i = idx('<html><body><section><a href="#x"><img alt="A photo"></a><p>p</p></section></body></html>');
    const sec = i.elements.find((e) => e.tag === 'section')!.id;
    const link = clusterByOwner(i, i.strings, sec).find((c) => c.tag === 'a');
    expect(link?.preview).toBeTruthy();
  });

  it('survives an element id it cannot resolve', () => {
    const i = idx('<html><body><p>Hi</p></body></html>');
    expect(() => clusterByOwner(i, i.strings, root(i))).not.toThrow();
  });
});

describe('what does not deserve a group', () => {
  /**
   * Both learned from running it against the real site, where the first
   * version produced 81 groups — a heading reading "div" over most of the page,
   * and the logo split in two.
   */
  it('does not name a layout div as a thing', () => {
    const i = idx(`<html><body><section>
      <div><p>One</p><p>Two</p></div><p>Three</p>
    </section></body></html>`);
    const sec = i.elements.find((e) => e.tag === 'section')!.id;
    expect(clusterByOwner(i, i.strings, sec).every((c) => c.ownerId === null)).toBe(true);
  });

  it('gives the link all four, not the span that sits nearer', () => {
    // <span>Anthea<span> Solve</span></span> owns two text runs and is closer
    // than the <a>. Nearest-wins split the logo; nearest-nameable does not.
    const i = idx(`<html><body><header>
      <a href="#top"><img alt="Anthea Solve"><span>Anthea<span> Solve</span></span></a>
      <p>Other</p>
    </header></body></html>`);
    const header = i.elements.find((e) => e.tag === 'header')!.id;
    const c = clusterByOwner(i, i.strings, header).filter((x) => x.ownerId);
    expect(c).toHaveLength(1);
    expect(c[0].tag).toBe('a');
    expect(c[0].entries).toHaveLength(4);
  });

  it('does not raise a heading over a single box', () => {
    // An owner whose strings are not consecutive would otherwise produce two
    // groups of one, each a heading with nothing to organise.
    const i = idx(`<html><body><section>
      <ul><li><span>—</span>A</li><li><span>—</span>B</li></ul>
    </section></body></html>`);
    const sec = i.elements.find((e) => e.tag === 'section')!.id;
    for (const c of clusterByOwner(i, i.strings, sec)) {
      if (c.ownerId) expect(c.entries.length).toBeGreaterThan(1);
    }
  });
});
