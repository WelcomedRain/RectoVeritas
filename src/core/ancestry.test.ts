import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { ancestryOf, enclosingBlock } from './ancestry';
import { indexTemplate } from './htmlIndex';
import { parseBundle } from './bundle';

const idx = (html: string) => indexTemplate(html);
const find = (i: ReturnType<typeof idx>, tag: string) =>
  i.elements.find((e) => e.tag === tag)!;

describe('the ancestry trail', () => {
  const list = idx(`<html><body><main><section id="work">
    <ul class="items"><li>One</li><li>Two</li></ul>
  </section></main></body></html>`);

  it('reads outermost first, ending on the element you are on', () => {
    const chain = ancestryOf(list, find(list, 'li').id);
    expect(chain.map((c) => c.tag)).toEqual(['body', 'main', 'section', 'ul', 'li']);
    expect(chain[chain.length - 1].current).toBe(true);
    expect(chain.filter((c) => c.current)).toHaveLength(1);
  });

  it('names an element by its id or class when it has one', () => {
    const chain = ancestryOf(list, find(list, 'li').id);
    expect(chain.map((c) => c.label)).toContain('section#work');
    expect(chain.map((c) => c.label)).toContain('ul.items');
  });

  it('does not name an element by a class the runtime generated', () => {
    // `scp7` tells a person nothing; the tag alone is more use than a label
    // that looks like information and is not.
    const i = idx('<html><body><p class="scp7">Hi</p></body></html>');
    expect(ancestryOf(i, find(i, 'p').id).map((c) => c.label)).toContain('p');
  });

  it('leaves out the scaffolding nobody edits', () => {
    const i = idx('<html><head><title>T</title></head><body><p>Hi</p></body></html>');
    const tags = ancestryOf(i, find(i, 'p').id).map((c) => c.tag);
    expect(tags).not.toContain('html');
    expect(tags).not.toContain('head');
  });

  it('returns nothing for no selection', () => {
    expect(ancestryOf(list, null)).toEqual([]);
  });
});

describe('enclosingBlock', () => {
  /**
   * The case that prompted it: a list item cannot add or remove its own
   * siblings. Editing the list means editing the <ul>, and there was no way
   * to select one.
   */
  it('offers the list when you are on a list item', () => {
    const i = idx('<html><body><ul><li>One</li><li>Two</li></ul></body></html>');
    expect(enclosingBlock(i, find(i, 'li').id)?.tag).toBe('ul');
  });

  it('offers the link when you are on a span inside it', () => {
    // A logo made of an img and two spans inside one <a> showed up as four
    // unrelated boxes. This is the step that puts them back together.
    const i = idx('<html><body><a href="#top"><img alt="Logo"><span>Anthea</span></a></body></html>');
    expect(enclosingBlock(i, find(i, 'span').id)?.tag).toBe('a');
  });

  it('skips past anonymous wrappers to something with meaning', () => {
    const i = idx('<html><body><section id="s"><div><div><p>Hi</p></div></div></section></body></html>');
    expect(enclosingBlock(i, find(i, 'p').id)?.label).toBe('section#s');
  });

  it('has nothing to offer at the top of the tree', () => {
    const i = idx('<html><body>Hi</body></html>');
    expect(enclosingBlock(i, find(i, 'body').id)).toBeNull();
  });
});

const REAL = 'G:/Anthea-Solve/index.html';
describe.skipIf(!existsSync(REAL))('against the real site', () => {
  // Read inside the tests, not in the describe body: `skipIf` skips the tests
  // but still evaluates the body, so an eager read here fails the build on any
  // machine without the site — which is every machine but this one.
  const real = () => indexTemplate(parseBundle(readFileSync(REAL, 'utf8')).template);

  it('gets from a real list item to its real list', () => {
    const i = real();
    const li = i.elements.find((e) => e.tag === 'li')!;
    expect(enclosingBlock(i, li.id)?.tag).toMatch(/ul|ol/);
  });

  it('produces a trail short enough to read', () => {
    const i = real();
    const li = i.elements.find((e) => e.tag === 'li')!;
    // A trail nobody can scan is a trail nobody uses.
    expect(ancestryOf(i, li.id).length).toBeLessThan(14);
  });
});
