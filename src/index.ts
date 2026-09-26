import { parse } from './parser.ts';
import { lint as lintNodes } from './rules.ts';
import type { Finding, LintOptions } from './rules.ts';

export * from './errors.ts';
export type { Finding, Severity, Confidence, LintOptions } from './rules.ts';
export type { StyleNode, RuleNode, Declaration } from './parser.ts';
export { parse } from './parser.ts';

export interface SourceFile {
  file: string;
  source: string;
}

/**
 * Lint one or more CSS files for custom-property mistakes that never error
 * but silently fail: a `var()` reference to a property defined only in a
 * selector scope that can't reach it, a `var()` with no fallback where that
 * isn't provably safe, a property declared but never used (or the reverse),
 * and an `@property`-registered syntax disagreeing with a declared value.
 * See the README for the full list and, for each one, exactly what is and
 * isn't proven.
 *
 * Findings from every file are pooled before checks run, because "is --x
 * declared anywhere in the project" (and its scope) is a project-wide
 * question, not a per-file one.
 */
export function lint(files: SourceFile[], options: LintOptions = {}): Finding[] {
  const parsed = files.map((f) => ({ file: f.file, nodes: parse(f.source, f.file) }));
  return lintNodes(parsed, options);
}

/** Convenience wrapper around {@link lint} for a single file. */
export function lintSource(source: string, file = '<input>', options: LintOptions = {}): Finding[] {
  return lint([{ file, source }], options);
}

export default lint;
