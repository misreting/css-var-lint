import { CssParseError } from './errors.ts';

/** A declaration inside a rule's body, e.g. `--gap: 1rem;` or `color: var(--x);`. */
export interface Declaration {
  type: 'decl';
  prop: string;
  value: string;
  line: number;
  column: number;
}

/**
 * A style rule or at-rule. `prelude` is the raw selector (`.card`) or at-rule
 * head (`@property --x`), before the `{`.
 *
 * The parser does not distinguish "this at-rule holds declarations" from "this
 * at-rule holds nested rules" up front — both shapes are the same grammar
 * (a block containing a mix of declarations and nested blocks), so `children`
 * can hold either. Callers that need to know which they have inspect the
 * children's `type`.
 *
 * Each `RuleNode` is a distinct object identity, which the scope-ancestry
 * checks in `rules.ts` rely on directly: "is rule A nested inside rule B" is
 * answered by walking up from A's parent chain and comparing object identity
 * to B, not by comparing selector text.
 */
export interface RuleNode {
  type: 'rule';
  prelude: string;
  line: number;
  column: number;
  children: StyleNode[];
}

export type StyleNode = Declaration | RuleNode;

/**
 * Parse a CSS source string into a tree of rules and declarations.
 *
 * This is a hand-rolled, purpose-built parser, not a full implementation of the
 * CSS Syntax Module. It correctly tracks strings, comments, and paren/bracket
 * nesting so that semicolons and braces inside `content: "a;b"`, `url(...)`,
 * or `var(--x, fn(a; b))`-shaped values don't get mistaken for structure, and
 * it handles arbitrary brace nesting (`@media` inside `@layer`, CSS nesting,
 * `@property` blocks, etc.) uniformly. It does not validate selector or value
 * grammar beyond that — a rule with a nonsense selector parses fine, because
 * this library lints custom-property semantics, not general CSS validity.
 *
 * Throws {@link CssParseError} on structural breakage it cannot recover from:
 * an unterminated string or comment, or unbalanced braces. Guessing past those
 * risks silently mis-attributing declarations to the wrong rule, which is worse
 * than refusing outright.
 */
export function parse(source: string, file: string): StyleNode[] {
  const p = new Parser(source, file);
  const nodes = p.parseBlockBody(/* topLevel */ true);
  return nodes;
}

class Parser {
  private src: string;
  private file: string;
  private i = 0;
  private line = 1;
  private column = 1;

  constructor(src: string, file: string) {
    this.src = src;
    this.file = file;
  }

  private peek(offset = 0): string {
    return this.src[this.i + offset] ?? '';
  }

  private advance(): string {
    const ch = this.src[this.i]!;
    this.i++;
    if (ch === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }

  private eof(): boolean {
    return this.i >= this.src.length;
  }

  private fail(message: string): never {
    throw new CssParseError(message, this.file, this.line, this.column);
  }

  /**
   * Consume one block's worth of content: a sequence of declarations and
   * nested rules, stopping at an unmatched `}` (left for the caller to
   * consume) or at end of input when `topLevel` is true.
   */
  parseBlockBody(topLevel: boolean): StyleNode[] {
    const nodes: StyleNode[] = [];

    for (;;) {
      this.skipInsignificant();
      if (this.eof()) {
        if (!topLevel) this.fail('unexpected end of input inside an open block ("{" with no matching "}")');
        return nodes;
      }
      if (this.peek() === '}') {
        if (topLevel) this.fail('unmatched "}" with no corresponding "{"');
        return nodes;
      }

      const node = this.parseOne();
      if (node) nodes.push(node);
    }
  }

  /** Parse a single declaration or nested rule starting at the current position. */
  private parseOne(): StyleNode | null {
    const startLine = this.line;
    const startColumn = this.column;
    let text = '';
    let depthParen = 0;
    let depthBracket = 0;

    for (;;) {
      if (this.eof()) this.fail('unexpected end of input (expected ";", "{" or "}")');
      const ch = this.peek();

      if (ch === '/' && this.peek(1) === '*') {
        this.skipComment();
        text += ' ';
        continue;
      }
      if (ch === '"' || ch === "'") {
        text += this.consumeString(ch);
        continue;
      }
      if (ch === '(') {
        depthParen++;
        text += this.advance();
        continue;
      }
      if (ch === ')') {
        if (depthParen > 0) depthParen--;
        text += this.advance();
        continue;
      }
      if (ch === '[') {
        depthBracket++;
        text += this.advance();
        continue;
      }
      if (ch === ']') {
        if (depthBracket > 0) depthBracket--;
        text += this.advance();
        continue;
      }

      if (depthParen === 0 && depthBracket === 0) {
        if (ch === ';') {
          this.advance();
          return this.declarationFrom(text, startLine, startColumn);
        }
        if (ch === '{') {
          this.advance();
          const prelude = text.trim();
          const children = this.parseBlockBody(false);
          this.skipInsignificant();
          if (this.eof() || this.peek() !== '}') {
            this.fail(`unexpected end of input inside block "${truncate(prelude)}" (missing "}")`);
          }
          this.advance(); // consume '}'
          return { type: 'rule', prelude, line: startLine, column: startColumn, children };
        }
        if (ch === '}') {
          // End of the enclosing block with no trailing ';' — a bare last
          // declaration (valid CSS: `color: red` with no semicolon before `}`).
          return this.declarationFrom(text, startLine, startColumn);
        }
      }

      text += this.advance();
    }
  }

  private declarationFrom(text: string, line: number, column: number): Declaration | null {
    const trimmed = text.trim();
    if (trimmed === '') return null; // stray semicolon or empty tail
    const colon = findTopLevelColon(trimmed);
    if (colon === -1) {
      // Not a `prop: value` pair (e.g. a bare at-rule like `@import url(x) screen;`
      // sitting where a declaration was expected). Keep it as an opaque
      // declaration with an empty value so callers can ignore it safely.
      return { type: 'decl', prop: trimmed, value: '', line, column };
    }
    const prop = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    return { type: 'decl', prop, value, line, column };
  }

  private skipComment(): void {
    const startLine = this.line;
    const startColumn = this.column;
    this.advance(); // '/'
    this.advance(); // '*'
    for (;;) {
      if (this.eof()) {
        throw new CssParseError('unterminated comment ("/*" with no matching "*/")', this.file, startLine, startColumn);
      }
      if (this.peek() === '*' && this.peek(1) === '/') {
        this.advance();
        this.advance();
        return;
      }
      this.advance();
    }
  }

  private consumeString(quote: string): string {
    const startLine = this.line;
    const startColumn = this.column;
    let out = this.advance(); // opening quote
    for (;;) {
      if (this.eof()) {
        throw new CssParseError(`unterminated string (missing closing ${quote})`, this.file, startLine, startColumn);
      }
      const ch = this.peek();
      if (ch === '\\') {
        out += this.advance();
        if (!this.eof()) out += this.advance();
        continue;
      }
      if (ch === quote) {
        out += this.advance();
        return out;
      }
      if (ch === '\n') {
        throw new CssParseError('unterminated string (newline before closing quote)', this.file, startLine, startColumn);
      }
      out += this.advance();
    }
  }

  private skipInsignificant(): void {
    for (;;) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
        this.advance();
        continue;
      }
      if (ch === '/' && this.peek(1) === '*') {
        this.skipComment();
        continue;
      }
      return;
    }
  }
}

/** Index of the first `:` not inside parens/brackets/strings, or -1. */
function findTopLevelColon(text: string): number {
  let depthParen = 0;
  let depthBracket = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipStringFrom(text, i);
      continue;
    }
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === ':' && depthParen === 0 && depthBracket === 0) return i;
  }
  return -1;
}

function skipStringFrom(text: string, start: number): number {
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

function truncate(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
