#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { lint } from './index.ts';
import { CssVarLintError } from './errors.ts';
import type { Finding } from './rules.ts';

function usage(): string {
  return [
    'Usage: css-var-lint [options] <file.css> [file2.css ...]',
    '',
    'Options:',
    '  --include-possible   Also report findings this tool cannot prove (see README)',
    '  --strict             Exit non-zero on warnings too, not just errors',
    '  --json                Print findings as JSON instead of text',
    '  --help                Show this message',
    '',
    'Shell globs (e.g. "src/**/*.css") are expanded by your shell before this',
    'program sees them; this tool does not implement its own glob matching.',
  ].join('\n');
}

function main(): number {
  const args = process.argv.slice(2);
  const options = { includePossible: false, strict: false, json: false };
  const files: string[] = [];

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      return 0;
    } else if (arg === '--include-possible') {
      options.includePossible = true;
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}\n`);
      console.error(usage());
      return 2;
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    console.error(usage());
    return 2;
  }

  const sources = files.map((file) => {
    try {
      return { file, source: readFileSync(file, 'utf8') };
    } catch (err) {
      throw new CssVarLintError(`Cannot read ${file}: ${(err as Error).message}`);
    }
  });

  const findings = lint(sources, { includePossible: options.includePossible });

  if (options.json) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    printReport(findings, sources.length);
  }

  const hasError = findings.some((f) => f.severity === 'error');
  const hasWarning = findings.some((f) => f.severity === 'warning');
  if (hasError) return 1;
  if (hasWarning && options.strict) return 1;
  return 0;
}

function printReport(findings: Finding[], fileCount: number): void {
  if (findings.length === 0) {
    console.log(`css-var-lint: no findings in ${fileCount} file${fileCount === 1 ? '' : 's'}.`);
    return;
  }

  let lastFile: string | undefined;
  for (const f of findings) {
    if (f.file !== lastFile) {
      console.log(f.file);
      lastFile = f.file;
    }
    const where = `${f.line}:${f.column}`.padEnd(8);
    const tag = f.confidence === 'possible' ? `${f.severity}?` : f.severity;
    console.log(`  ${where} ${tag.padEnd(8)} ${f.message}  [${f.rule}]`);
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  console.log(`\n${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
}

try {
  process.exitCode = main();
} catch (err) {
  if (err instanceof CssVarLintError) {
    console.error(err.message);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
