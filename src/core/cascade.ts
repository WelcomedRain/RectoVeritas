/**
 * Why a value is the value.
 *
 * The question this answers is the one that has come up over and over while
 * building this editor: I changed it and nothing happened. On this site the
 * usual reason is that most elements carry their styling in a `style`
 * attribute, which outranks any stylesheet rule — so a correct, publishable
 * rule edit changes nothing anyone can see.
 *
 * Ranking is done here rather than by the browser because browsers do not
 * expose which rule won; they only expose the answer. So this predicts the
 * winner from the cascade, and the caller checks the prediction against the
 * computed value. Where the two disagree the app says so rather than explain
 * confidently in the wrong direction — a guess presented as a trace would be
 * worse than no trace.
 */

export interface Declaration {
  /** The rule's selector, or null when it is an element's own style attribute. */
  selector: string | null;
  value: string;
  important: boolean;
  /** Document order of the rule. Later wins a tie. */
  order: number;
  /** Where it came from, for saying so: a stylesheet href or title. */
  origin?: string;
}

export type Specificity = [number, number, number];

/**
 * a-b-c: ids, then classes/attributes/pseudo-classes, then types/pseudo-elements.
 *
 * Deliberately a subset. `:is()`, `:has()` and `:not()` take the specificity of
 * their most specific argument, which needs a real parser; here their contents
 * are counted, which is right for the common single-argument case and wrong for
 * lists. That inaccuracy is the reason the caller verifies against the computed
 * value instead of trusting this.
 */
export function specificity(selector: string): Specificity {
  // One compound selector at a time: a comma-separated list is several rules
  // wearing one coat, and only the matching branch should count.
  const s = selector
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*[>+~]\s*/g, ' ')
    .trim();

  let a = 0, b = 0, c = 0;

  // Strip and count in an order that prevents double counting: attributes and
  // pseudo-element syntax first, since both contain characters counted below.
  let rest = s.replace(/\[[^\]]*\]/g, () => { b++; return ' '; });
  rest = rest.replace(/::[\w-]+/g, () => { c++; return ' '; });
  rest = rest.replace(/:(?:not|is|where|has)\((.*?)\)/g, (_m, inner: string) => {
    // `:where()` contributes nothing, by definition.
    if (_m.startsWith(':where')) return ' ';
    const [ia, ib, ic] = specificity(inner);
    a += ia; b += ib; c += ic;
    return ' ';
  });
  rest = rest.replace(/:[\w-]+(?:\([^)]*\))?/g, () => { b++; return ' '; });
  rest = rest.replace(/#[\w-]+/g, () => { a++; return ' '; });
  rest = rest.replace(/\.[\w-]+/g, () => { b++; return ' '; });
  rest = rest.replace(/\*/g, ' ');
  for (const tok of rest.split(/\s+/)) if (tok) c++;

  return [a, b, c];
}

export function compareSpecificity(x: Specificity, y: Specificity): number {
  return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);
}

export interface Ranked extends Declaration {
  specificity: Specificity;
  /** Why this one lost, in the terms a person would use. */
  beatenBy?: 'importance' | 'inline style' | 'specificity' | 'order';
}

export interface Trace {
  winner: Ranked | null;
  /** Everything that declared the property and lost, strongest first. */
  overridden: Ranked[];
}

/**
 * An element's own style attribute beats every rule, and `!important` beats
 * that. Otherwise: specificity, then document order.
 */
function weigh(d: Declaration): [number, number, number, number, number] {
  const inline = d.selector === null ? 1 : 0;
  const [a, b, c] = d.selector === null ? [0, 0, 0] : specificity(d.selector);
  // Importance outranks everything, including an inline declaration that is not
  // itself important.
  return [d.important ? 1 : 0, inline, a, b, c];
}

export function rankDeclarations(decls: Declaration[]): Trace {
  if (decls.length === 0) return { winner: null, overridden: [] };

  const scored = decls.map((d) => ({
    d,
    w: weigh(d),
    spec: d.selector === null ? ([0, 0, 0] as Specificity) : specificity(d.selector),
  }));

  scored.sort((x, y) => {
    for (let i = 0; i < x.w.length; i++) {
      if (x.w[i] !== y.w[i]) return y.w[i] - x.w[i];
    }
    return y.d.order - x.d.order;
  });

  const [top, ...rest] = scored;
  const winner: Ranked = { ...top.d, specificity: top.spec };

  const overridden: Ranked[] = rest.map((s) => {
    let beatenBy: Ranked['beatenBy'] = 'order';
    if (top.d.important && !s.d.important) beatenBy = 'importance';
    else if (top.d.selector === null && s.d.selector !== null) beatenBy = 'inline style';
    else if (compareSpecificity(top.spec, s.spec) > 0) beatenBy = 'specificity';
    return { ...s.d, specificity: s.spec, beatenBy };
  });

  return { winner, overridden };
}

/**
 * A declared value that can be compared with a computed one at all.
 *
 * Most cannot. The winning declaration on this site's h1 is
 * `clamp(34px, 5.2vw, 68px)` and the page draws `66.56px`; a colour written
 * `#fff` is reported as `rgb(255, 255, 255)`. Those are the same value twice,
 * not a disagreement — and a check that called them one would fire on almost
 * every trace and teach the reader to ignore it.
 *
 * So comparison is attempted only for plain absolute values, where a
 * difference really does mean the ranking is wrong.
 */
export function comparable(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  if (/[a-z-]+\(/.test(v)) return false;                     // var(), calc(), clamp(), rgb()
  // Percent needs its own clause: a word boundary cannot follow a percent
  // sign, which is itself a non-word character, so folding it into the unit
  // list below silently let every percentage through.
  if (/\d\s*%/.test(v)) return false;
  if (/\d(?:em|rem|vw|vh|vmin|vmax|ch|ex)\b/.test(v)) return false;
  if (/^#|^(?:currentcolor|inherit|initial|unset|revert)$/.test(v)) return false;
  return true;
}

export type Agreement = 'confirmed' | 'differs' | 'not-comparable';

/**
 * Check the prediction against what the page is actually drawing.
 *
 * Browsers report the answer, not the reasoning, so this is the only way to
 * know the ranking was right — and it only speaks where it can be sure.
 */
export function checkAgainstComputed(predicted: string, computed: string): Agreement {
  if (!comparable(predicted) || !computed.trim()) return 'not-comparable';
  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ').replace(/;$/, '');
  return norm(predicted) === norm(computed) ? 'confirmed' : 'differs';
}
