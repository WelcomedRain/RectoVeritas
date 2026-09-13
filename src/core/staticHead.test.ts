import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { syncStaticHead, headMismatches } from './staticHead';
import { parseBundle } from './bundle';
import { indexTemplate } from './htmlIndex';
import { verifyHeadTags } from './publish';

const page = (inner: string) => `<!DOCTYPE html><html><head>
  <!-- static-head:begin -- generated -->
${inner}
  <!-- static-head:end -->
</head><body>x</body></html>`;

describe('bringing the scraper copy up to date', () => {
  it('rewrites a value the template disagrees with', () => {
    const f = page('  <meta name="description" content="old words">');
    const r = syncStaticHead(f, new Map([['description', 'new words']]));
    expect(r.text).toContain('content="new words"');
    expect(r.changed).toEqual([{ key: 'description', was: 'old words', now: 'new words' }]);
  });

  it('matches on property as well as name, for the og tags', () => {
    const f = page('  <meta property="og:description" content="old">');
    expect(syncStaticHead(f, new Map([['og:description', 'new']])).text)
      .toContain('content="new"');
  });

  it('leaves alone every tag the template says nothing about', () => {
    // canonical, the icons and the preconnects exist only in this block. The
    // template has no opinion on them and must not be allowed to form one.
    const f = page('  <link rel="canonical" href="https://x.test/">\n'
      + '  <link rel="icon" href="/favicon.png">\n'
      + '  <meta name="description" content="old">');
    const r = syncStaticHead(f, new Map([['description', 'new']]));
    expect(r.text).toContain('<link rel="canonical" href="https://x.test/">');
    expect(r.text).toContain('<link rel="icon" href="/favicon.png">');
    expect(r.changed).toHaveLength(1);
  });

  it('changes nothing at all when the two already agree', () => {
    const f = page('  <meta name="description" content="same">');
    const r = syncStaticHead(f, new Map([['description', 'same']]));
    expect(r.text).toBe(f);
    expect(r.changed).toHaveLength(0);
  });

  it('is idempotent', () => {
    const f = page('  <meta name="description" content="old">');
    const once = syncStaticHead(f, new Map([['description', 'new']])).text;
    expect(syncStaticHead(once, new Map([['description', 'new']])).text).toBe(once);
  });

  it('encodes what it writes, so an ampersand cannot break the markup', () => {
    const f = page('  <meta property="og:title" content="x">');
    const r = syncStaticHead(f, new Map([['og:title', 'Applied AI & App Development']]));
    expect(r.text).toContain('content="Applied AI &amp; App Development"');
    expect(r.text).not.toContain('content="Applied AI & App');
  });

  it('touches nothing outside the block', () => {
    const f = page('  <meta name="description" content="old">')
      + '<script>var d = {"name":"description","content":"old"};</script>';
    const r = syncStaticHead(f, new Map([['description', 'new']]));
    expect(r.text).toContain('{"name":"description","content":"old"}');
  });

  it('says so rather than guessing when there is no block', () => {
    const r = syncStaticHead('<html><head></head><body>x</body></html>', new Map([['description', 'n']]));
    expect(r.missing).toBe(true);
    expect(r.changed).toHaveLength(0);
  });

  it('does not invent a content attribute for a tag that has none', () => {
    const f = page('  <meta name="description">');
    expect(syncStaticHead(f, new Map([['description', 'new']])).changed).toHaveLength(0);
  });
});

describe('headMismatches', () => {
  it('reports a disagreement, and nothing once it is resolved', () => {
    const f = page('  <meta name="description" content="old">');
    const values = new Map([['description', 'new']]);
    expect(headMismatches(f, values)).toHaveLength(1);
    expect(headMismatches(syncStaticHead(f, values).text, values)).toHaveLength(0);
  });
});

const REAL = 'G:/Anthea-Solve/index.html';
describe.skipIf(!existsSync(REAL))('against the real site', () => {
  const load = () => {
    const file = readFileSync(REAL, 'utf8');
    const idx = indexTemplate(parseBundle(file).template);
    const values = new Map<string, string>();
    for (const s of idx.strings) if (s.pageInfo) values.set(s.tag, s.value);
    return { file, values };
  };

  /**
   * Written first as "finds the drift that is live right now", asserting that
   * description and og:description disagreed. Then the drift was fixed and the
   * test failed — because it had encoded a fault as a requirement. What is
   * worth guarding is the opposite: that the two copies agree, and that they
   * still agree after the next publish.
   */
  it('finds the two copies in step, and says so if they ever part', () => {
    const { file, values } = load();
    expect(headMismatches(file, values)).toEqual([]);
  });

  it('resolves a drift in the real file without disturbing anything else', () => {
    const { file, values } = load();
    // Push the scraper copy out of step the way an export or a hand-edit would,
    // then check the sync pulls exactly that back and touches nothing else.
    const b = file.indexOf('<!-- static-head:begin');
    const e = file.indexOf('<!-- static-head:end -->');
    const drifted = file.slice(0, b)
      + file.slice(b, e).replace(
        /(<meta name="description" content=")[^"]*/,
        '$1something else entirely',
      )
      + file.slice(e);

    expect(headMismatches(drifted, values).map((m) => m.key)).toEqual(['description']);
    const r = syncStaticHead(drifted, values);
    expect(r.changed.map((c) => c.key)).toEqual(['description']);
    expect(headMismatches(r.text, values)).toHaveLength(0);
    expect(r.text).toBe(file);
  });

  it('leaves the file publishable — same bundle, same gate', () => {
    const { file, values } = load();
    const r = syncStaticHead(file, values);
    expect(verifyHeadTags(r.text).ok).toBe(true);
    expect(verifyHeadTags(r.text).tagCount).toBe(verifyHeadTags(file).tagCount);
    expect(parseBundle(r.text).template).toBe(parseBundle(file).template);
  });

  it('keeps the tags scrapers need that the template never mentions', () => {
    const { file, values } = load();
    const r = syncStaticHead(file, values);
    for (const needed of ['rel="canonical"', 'rel="icon"', 'rel="apple-touch-icon"']) {
      expect(r.text, needed).toContain(needed);
    }
  });
});
