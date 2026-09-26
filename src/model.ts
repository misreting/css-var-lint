/**
 * CSS custom-property semantics, per two specifications. Every fact this file
 * encodes is cited to a section in a comment beside it — if a check produced a
 * wrong answer, this is the place to re-derive it from.
 *
 *  - CSS Custom Properties for Cascading Variables Module Level 1
 *    https://www.w3.org/TR/css-variables-1/ ("css-variables-1")
 *  - CSS Properties and Values API Level 1 (defines `@property`)
 *    https://drafts.css-houdini.org/css-properties-values-api-1/ ("css-properties-values-api-1")
 */

// ---------------------------------------------------------------------------
// Custom-property names
// ---------------------------------------------------------------------------

/**
 * A custom property's name is any identifier starting with two dashes.
 * css-variables-1 §2 Defining Custom Properties: "Custom property names ...
 * are just author-defined identifiers with a "--" prefix." The real grammar
 * is `--` followed by a full CSS <ident-token> (which permits escapes and
 * most Unicode); this checks the common ASCII subset and does not attempt
 * escape-sequence decoding.
 */
export const CUSTOM_PROPERTY_RE = /^--[A-Za-z0-9_-]+$/;

export function isCustomPropertyName(prop: string): boolean {
  return CUSTOM_PROPERTY_RE.test(prop.trim());
}

// ---------------------------------------------------------------------------
// Splitting comma/paren-aware token streams
// ---------------------------------------------------------------------------

/** Split a string on top-level commas, respecting nested (), [], and quoted strings. */
export function splitTopLevelCommas(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function skipString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i;
    i++;
  }
  return text.length - 1;
}

// ---------------------------------------------------------------------------
// var() references
// ---------------------------------------------------------------------------

export interface VarCall {
  /** The custom property name referenced, e.g. `--x`. */
  name: string;
  /**
   * The fallback text, if any — everything between the first top-level comma
   * inside the parens and the matching close-paren, verbatim (not re-split).
   * css-variables-1 §3 Using Cascading Variables: the var() notation: "the
   * syntax of the fallback, like that of custom properties, allows commas ...
   * anything between the first comma and the end of the function is
   * considered a fallback value." So `var(--a, 1, 2, 3)`'s fallback is the
   * literal text `1, 2, 3`, not just `1` — this only splits on the *first*
   * comma, deliberately, to get that right.
   *
   * The spec also carves out one exception: "a bare comma, with nothing
   * following it, must be treated as valid ... indicating an empty fallback
   * value" (e.g. `var(--a,)`), which is why `fallback` can be the empty
   * string (a real, present-but-empty fallback) as distinct from `undefined`
   * (no comma at all, i.e. genuinely no fallback).
   */
  fallback: string | undefined;
  /** Character offset of the whole `var(...)` call within the scanned value. */
  start: number;
  /** Character offset one past the call's closing paren. */
  end: number;
}

/**
 * Find every `var(...)` call at any nesting depth within a value — including
 * inside another var()'s own fallback, e.g. `var(--a, var(--b, red))` yields
 * both `--a` (fallback text `var(--b, red)`) and `--b` (fallback text `red`).
 * css-variables-1 §3: "If there are any var() references in the fallback,
 * substitute them as well" — fallbacks are themselves scanned recursively,
 * which is exactly what finding all `var(` occurrences regardless of nesting
 * depth achieves, without needing to actually perform substitution.
 *
 * Skips content inside quoted strings, so `content: "var(--not-a-var)"` is
 * correctly ignored.
 */
export function findVarCalls(value: string): VarCall[] {
  const calls: VarCall[] = [];
  const lower = value.toLowerCase();
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === '"' || ch === "'") {
      i = skipString(value, i) + 1;
      continue;
    }
    if (lower.startsWith('var(', i) && (i === 0 || !isIdentChar(value[i - 1]))) {
      const parenStart = i + 3;
      const close = matchingParen(value, parenStart);
      if (close === -1) {
        // Unbalanced — the declaration itself is malformed. Nothing sane to
        // report about this specific call; move past the opener and continue.
        i = parenStart + 1;
        continue;
      }
      const inner = value.slice(parenStart + 1, close);
      const commaAt = topLevelCommaIndex(inner);
      const name = (commaAt === -1 ? inner : inner.slice(0, commaAt)).trim();
      const fallback = commaAt === -1 ? undefined : inner.slice(commaAt + 1).trim();
      calls.push({ name, fallback, start: i, end: close + 1 });
      i = parenStart + 1; // continue scanning *inside* this call too, for nested var()
      continue;
    }
    i++;
  }
  return calls;
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_-]/.test(ch);
}

/** Index of the matching `)` for the `(` at `openIndex`, or -1. */
function matchingParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the first top-level comma in `text`, or -1 (paren/bracket/string aware). */
function topLevelCommaIndex(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Selector text — grouping and the descendant-combinator heuristic
// ---------------------------------------------------------------------------

/** Split a selector list on top-level commas (`.a, .b` -> [".a", ".b"]). */
export function splitSelectorGroup(prelude: string): string[] {
  return splitTopLevelCommas(prelude)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Whether a single (already-split) selector branch is exactly `:root`. */
export function isRootSelector(selector: string): boolean {
  return normalizeSelector(selector) === ':root';
}

function normalizeSelector(selector: string): string {
  return selector.trim().replace(/\s+/g, ' ').replace(/\s*([>+~])\s*/g, ' $1 ');
}

/**
 * Whether `outer` is provably an ancestor selector of `inner` by plain text —
 * i.e. `inner` starts with `outer` followed immediately by a combinator
 * (descendant, child, sibling). This is the one case, short of actual CSS
 * nesting (which the AST already proves via object identity — see
 * `rules.ts`), where a flat stylesheet's selector *text alone* proves a DOM
 * ancestor relationship: `.dark-theme .card` can only match an element that
 * has a `.dark-theme` ancestor, full stop, regardless of anything else in the
 * page.
 *
 * Deliberately conservative: only a literal prefix match, on normalized
 * whitespace. It does not attempt `:is()`/`:where()` expansion, attribute-order
 * equivalence, or any other selector-equivalence reasoning — see the README's
 * "what it does not do".
 */
export function isTextuallyNestedUnder(outer: string, inner: string): boolean {
  const o = normalizeSelector(outer);
  const n = normalizeSelector(inner);
  if (n === o) return true;
  if (!n.startsWith(o)) return false;
  // `normalizeSelector` puts a single space on both sides of every combinator,
  // so both "a b" (descendant) and "a > b" (child, after normalizing ">" to
  // " > ") leave a leading space right after the "a" prefix is stripped off.
  return n.slice(o.length).startsWith(' ');
}

// ---------------------------------------------------------------------------
// @property's `syntax` descriptor
// https://drafts.css-houdini.org/css-properties-values-api-1/#the-syntax-descriptor
// ---------------------------------------------------------------------------

/**
 * The syntax component names §5.1 "Supported Names" lists as valid inside a
 * `syntax` string, besides the universal `*` and author-supplied literal
 * keywords: `<length>`, `<number>`, `<percentage>`, `<length-percentage>`,
 * `<string>`, `<color>`, `<image>`, `<url>`, `<integer>`, `<angle>`, `<time>`,
 * `<resolution>`, `<transform-function>`, `<transform-list>`, `<custom-ident>`.
 */
export const SYNTAX_COMPONENTS = new Set([
  'length',
  'number',
  'percentage',
  'length-percentage',
  'string',
  'color',
  'image',
  'url',
  'integer',
  'angle',
  'time',
  'resolution',
  'transform-function',
  'transform-list',
  'custom-ident',
]);

export interface SyntaxAlternative {
  /** A `<component>` name (without brackets), or `undefined` for a literal keyword. */
  component: string | undefined;
  /** The literal keyword text, when `component` is undefined. */
  keyword: string | undefined;
}

export interface ParsedSyntax {
  /** `true` for the universal syntax `"*"`, which accepts any token stream and is never checked. */
  universal: boolean;
  alternatives: SyntaxAlternative[];
}

/**
 * Parse an `@property` `syntax` descriptor string, e.g. `"<length> | <percentage>"`
 * or `"small | medium | large"`. §5.1 permits both typed components and literal
 * `<custom-ident>`-shaped keywords as alternatives, and §5.2's "Multipliers"
 * allows a trailing `+` or `#` on a component (`<length>+`); those multipliers
 * describe a *list* of values and are stripped here since this tool only
 * classifies single declared values, not lists — see the README.
 */
export function parseSyntaxDescriptor(raw: string): ParsedSyntax {
  const value = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (value === '*') return { universal: true, alternatives: [] };

  const alternatives = value.split('|').map((part): SyntaxAlternative => {
    const token = part.trim().replace(/[+#]$/, '').trim();
    const m = /^<([a-z-]+)>$/i.exec(token);
    if (m && m[1] && SYNTAX_COMPONENTS.has(m[1].toLowerCase())) {
      return { component: m[1].toLowerCase(), keyword: undefined };
    }
    return { component: undefined, keyword: token };
  });
  return { universal: false, alternatives };
}

// ---------------------------------------------------------------------------
// Classifying a declared value's likely syntax category
// ---------------------------------------------------------------------------

const NAMED_COLORS = new Set([
  'transparent',
  'currentcolor',
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'pink',
  'brown',
  'gray',
  'grey',
  'cyan',
  'magenta',
  'lime',
  'navy',
  'teal',
  'maroon',
  'olive',
  'silver',
  'gold',
  'indigo',
  'violet',
  'coral',
  'salmon',
  'khaki',
  'crimson',
  'chocolate',
  'tomato',
  'orchid',
  'plum',
  'skyblue',
  'steelblue',
  'slategray',
  'slategrey',
  'rebeccapurple',
]);

const LENGTH_UNITS =
  'px|em|rem|vh|vw|vmin|vmax|svh|svw|svi|svb|lvh|lvw|lvi|lvb|dvh|dvw|dvi|dvb|pt|pc|in|cm|mm|q|ex|ch|cqw|cqh|cqi|cqb|cqmin|cqmax';

const NUMBER = String.raw`[+-]?(?:\d+\.\d+|\d+|\.\d+)`;

/** Whether `text` has whitespace outside of any parens/brackets/quoted string. */
function hasTopLevelWhitespace(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(ch!)) return true;
  }
  return false;
}

/** A best-effort classification of a single declared value's syntax category. */
export type ValueCategory =
  | 'color'
  | 'length'
  | 'percentage'
  | 'number'
  | 'integer'
  | 'angle'
  | 'time'
  | 'resolution'
  | 'url'
  | 'string'
  | 'custom-ident'
  | 'ambiguous';

/**
 * Classify a single declared custom-property value, conservatively. Anything
 * with more than one space-separated token, or that uses a function this tool
 * doesn't specifically recognize (`calc()`, `clamp()`, `min()`, `max()`,
 * `var()`, `attr()`, `env()`, ...), comes back `'ambiguous'` and is never used
 * to flag a mismatch — a wrong guess here would be a false positive on a
 * perfectly valid value, which is worse than staying silent. See the README's
 * "what it does not do".
 */
export function classifyValue(rawValue: string): ValueCategory {
  const value = rawValue.trim();
  if (value === '') return 'ambiguous';
  // Reject multiple top-level tokens (e.g. "1px solid red"), but whitespace
  // *inside* a function's parens (e.g. "rgb(0 0 0)") or a quoted string is
  // not a token boundary.
  if (hasTopLevelWhitespace(value)) return 'ambiguous';

  if (/^url\(/i.test(value)) return 'url';
  if (/^"[^"]*"$|^'[^']*'$/.test(value)) return 'string';

  if (/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(value)) return 'color';
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return 'color';
  if (NAMED_COLORS.has(value.toLowerCase())) return 'color';

  if (new RegExp(`^${NUMBER}(deg|grad|rad|turn)$`, 'i').test(value)) return 'angle';
  if (new RegExp(`^${NUMBER}m?s$`, 'i').test(value)) return 'time';
  if (new RegExp(`^${NUMBER}(dpi|dpcm|dppx|x)$`, 'i').test(value)) return 'resolution';
  if (new RegExp(`^${NUMBER}%$`).test(value)) return 'percentage';
  if (new RegExp(`^${NUMBER}(${LENGTH_UNITS})$`, 'i').test(value)) return 'length';
  if (/^0$/.test(value)) return 'length'; // unitless zero is a valid <length>

  if (/^[+-]?\d+$/.test(value)) return 'integer';
  if (new RegExp(`^${NUMBER}$`).test(value)) return 'number';

  if (/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(value)) {
    // A single bare identifier that isn't a recognized color keyword: most
    // plausibly an author-defined <custom-ident> (a keyword in an enum-style
    // syntax like "small | medium | large").
    return 'custom-ident';
  }

  return 'ambiguous';
}

/**
 * Whether a classified value category satisfies a registered `<component>`.
 * A few categories satisfy more than their own name: an integer is a valid
 * `<number>` (css-values-4 §7.3), and both `<length>` and `<percentage>`
 * satisfy `<length-percentage>` by definition (css-properties-values-api-1
 * §5.1 lists it as its own component precisely to accept either). `url` is
 * treated as satisfying `<image>` too — a bare `url(...)` is a valid `<image>`
 * in the common case — which is a deliberate, documented approximation, not a
 * full `<image>` grammar (gradients, `image-set()`, etc. are not modeled).
 */
export function categorySatisfiesComponent(category: ValueCategory, component: string): boolean {
  if (category === component) return true;
  if (component === 'number' && category === 'integer') return true;
  if (component === 'length-percentage' && (category === 'length' || category === 'percentage')) return true;
  if (component === 'image' && category === 'url') return true;
  return false;
}
