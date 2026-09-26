/** Base class for every error this library throws. */
export class CssVarLintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The CSS could not be parsed well enough to lint safely.
 *
 * This library implements a purpose-built subset of CSS syntax — enough to find
 * rules, at-rules, declarations and nesting — not a spec-complete CSS parser.
 * Rather than guess at malformed or exotic input, it refuses. A wrong parse is
 * worse than no parse: it can turn a real problem invisible, or invent one that
 * isn't there.
 */
export class CssParseError extends CssVarLintError {
  file: string;
  line: number;
  column: number;

  constructor(message: string, file: string, line: number, column: number) {
    super(`${file}:${line}:${column}: ${message}`);
    this.file = file;
    this.line = line;
    this.column = column;
  }
}
