import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { lint, lintSource, parse, CssParseError } from '../src/index.ts';
import type { Finding } from '../src/index.ts';
import { findVarCalls, splitTopLevelCommas, isTextuallyNestedUnder, classifyValue, parseSyntaxDescriptor } from '../src/model.ts';

function fixture(name: string): { file: string; source: string } {
  const file = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return { file, source: readFileSync(file, 'utf8') };
}

function ruleCounts(findings: Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.rule] = (out[f.rule] ?? 0) + 1;
  return out;
}

describe('VL001 unreachable-custom-property (certain)', () => {
  test('flags a var() used in a rule with the only definition nested inside it', () => {
    const f = lint([fixture('scope-certain.css')]);
    assert.deepEqual(ruleCounts(f), { VL001: 1 });
    assert.equal(f[0]!.severity, 'error');
    assert.equal(f[0]!.confidence, 'certain');
    assert.match(f[0]!.message, /nested \*inside\* this rule/);
    assert.equal(f[0]!.line, 9);
  });

  test('does not flag when the same rule declares and uses it', () => {
    const css = '.card { --x: red; color: var(--x); }';
    assert.deepEqual(lintSource(css).filter((x) => x.rule === 'VL001'), []);
  });

  test('does not flag when :root declares it, regardless of usage scope', () => {
    const css = ':root { --x: red; } .a { .b { color: var(--x); } }';
    assert.deepEqual(lintSource(css).filter((x) => x.rule === 'VL001'), []);
  });

  test('does not flag a reference nested inside its own defining rule via CSS nesting', () => {
    const css = '.dark-theme { --x: red; .card { color: var(--x); } }';
    assert.deepEqual(lintSource(css).filter((x) => x.rule === 'VL001'), []);
  });

  test('does not flag a flat pair proven safe by a descendant-combinator prefix', () => {
    const css = '.dark-theme { --x: red; } .dark-theme .card { color: var(--x); }';
    assert.deepEqual(lintSource(css).filter((x) => x.rule === 'VL001'), []);
  });

  test('proves safety across files via the same descendant-combinator text', () => {
    const a = { file: 'a.css', source: '.dark-theme { --x: red; }' };
    const b = { file: 'b.css', source: '.dark-theme .card { color: var(--x); }' };
    assert.deepEqual(lint([a, b]).filter((x) => x.rule === 'VL001'), []);
  });

  test('a mismatched leading class is not treated as a prefix match (substring trap)', () => {
    // ".card-title" textually starts with ".card" but is not nested under it.
    const css = '.card { --x: red; } .card-title { color: var(--x); }';
    const f = lintSource(css, 'f.css', { includePossible: true }).filter((x) => x.rule === 'VL001');
    assert.equal(f.length, 1);
    assert.equal(f[0]!.confidence, 'possible');
  });
});

describe('VL001 unreachable-custom-property (possible)', () => {
  test('is silent by default for an unprovable flat pair', () => {
    const quiet = lint([fixture('possible/flat-no-fallback.css')]);
    assert.deepEqual(quiet.filter((x) => x.rule === 'VL001'), []);
  });

  test('is reported as a possible warning with includePossible', () => {
    const loud = lint([fixture('possible/flat-no-fallback.css')], { includePossible: true });
    const vl001 = loud.filter((x) => x.rule === 'VL001');
    assert.equal(vl001.length, 1);
    assert.equal(vl001[0]!.severity, 'warning');
    assert.equal(vl001[0]!.confidence, 'possible');
  });

  test('is silent by default across files too, for the same reason', () => {
    const a = { file: 'a.css', source: '.dark-theme { --x: red; }' };
    const b = { file: 'b.css', source: '.card { color: var(--x); }' };
    assert.deepEqual(lint([a, b]).filter((x) => x.rule === 'VL001'), []);
    const loud = lint([a, b], { includePossible: true }).filter((x) => x.rule === 'VL001');
    assert.equal(loud.length, 1);
    assert.equal(loud[0]!.confidence, 'possible');
  });
});

describe('VL002 no-fallback-not-guaranteed', () => {
  test('fires by default on an unprovable scope with no fallback', () => {
    const f = lint([fixture('possible/flat-no-fallback.css')]);
    assert.deepEqual(ruleCounts(f), { VL002: 1 });
    assert.equal(f[0]!.confidence, 'certain');
    assert.equal(f[0]!.severity, 'warning');
  });

  test('is silent when a fallback is present, even though the scope is just as unprovable', () => {
    assert.deepEqual(lint([fixture('possible/flat-with-fallback.css')]), []);
    assert.deepEqual(lint([fixture('possible/flat-with-fallback.css')], { includePossible: true }).filter((x) => x.rule === 'VL002'), []);
  });

  test('does not double up with a certain VL001 finding at the same site', () => {
    const f = lint([fixture('scope-certain.css')]);
    assert.deepEqual(ruleCounts(f), { VL001: 1 }); // no VL002 alongside it
  });

  test('does not fire for a registered property, which degrades to its initial-value instead', () => {
    const f = lint([fixture('registered-scope-miss.css')]);
    assert.deepEqual(f.filter((x) => x.rule === 'VL002'), []);
  });
});

describe('VL001 on a registered property', () => {
  test('describes falling back to the registered initial-value, not "invalid"', () => {
    const f = lint([fixture('registered-scope-miss.css')]).filter((x) => x.rule === 'VL001');
    assert.equal(f.length, 1);
    assert.match(f[0]!.message, /registered initial-value/);
    assert.doesNotMatch(f[0]!.message, /invalid at computed-value time/);
  });
});

describe('VL003 undefined-custom-property', () => {
  test('flags a var() with no fallback for a name declared nowhere in the project', () => {
    const f = lint([fixture('undefined-no-fallback.css')]);
    assert.deepEqual(ruleCounts(f), { VL003: 1 });
    assert.equal(f[0]!.severity, 'error');
    assert.equal(f[0]!.confidence, 'certain');
  });

  test('does not flag when a fallback is given for an otherwise-undefined property', () => {
    const css = '.card { color: var(--never-defined, blue); }';
    assert.deepEqual(lintSource(css).filter((x) => x.rule === 'VL003'), []);
  });

  test('does not flag across files when the property is defined in a different file', () => {
    const a = { file: 'a.css', source: ':root { --x: red; }' };
    const b = { file: 'b.css', source: '.card { color: var(--x); }' };
    assert.deepEqual(lint([a, b]).filter((x) => x.rule === 'VL003'), []);
  });

  test('does not flag a property that is registered but never given an explicit value', () => {
    const css = '@property --x { syntax: "<color>"; inherits: false; initial-value: black; } .a { color: var(--x); }';
    assert.deepEqual(lintSource(css).filter((x) => x.rule === 'VL003'), []);
  });
});

describe('VL004 dead-custom-property', () => {
  test('flags a declared property that var() never references anywhere', () => {
    const f = lint([fixture('dead-property.css')]);
    assert.deepEqual(ruleCounts(f), { VL004: 1 });
    assert.equal(f[0]!.severity, 'warning');
    assert.equal(f[0]!.confidence, 'certain');
  });

  test('does not flag once any file in the project references it', () => {
    const a = { file: 'a.css', source: ':root { --x: red; }' };
    const b = { file: 'b.css', source: '.card { color: var(--x); }' };
    assert.deepEqual(lint([a, b]).filter((x) => x.rule === 'VL004'), []);
  });
});

describe('VL005 property-type-mismatch', () => {
  test('flags a color value against a registered <length>', () => {
    // (This fixture also declares --gap without ever referencing it via
    // var(), so VL004 "dead property" fires too — expected, and covered by
    // its own describe block; this one only checks VL005.)
    const f = lint([fixture('property-mismatch.css')]).filter((x) => x.rule === 'VL005');
    assert.equal(f.length, 1);
    assert.equal(f[0]!.severity, 'error');
    assert.match(f[0]!.message, /color/);
    assert.match(f[0]!.message, /<length>/);
  });

  test('does not flag a matching value', () => {
    const css = '@property --gap { syntax: "<length>"; inherits: false; initial-value: 0px; } .a { --gap: 8px; }';
    assert.deepEqual(lintSource(css).filter((x) => x.rule === 'VL005'), []);
  });

  test('does not flag an integer against <number> (a valid subtype)', () => {
    const css = '@property --z { syntax: "<number>"; inherits: false; initial-value: 0; } .a { --z: 4; }';
    assert.deepEqual(lintSource(css).filter((x) => x.rule === 'VL005'), []);
  });

  test('does not flag a value this tool cannot confidently classify', () => {
    const css = '@property --g { syntax: "<length>"; inherits: false; initial-value: 0px; } .a { --g: calc(1px + var(--h)); }';
    assert.deepEqual(lintSource(css).filter((x) => x.rule === 'VL005'), []);
  });

  test('does not validate against the universal syntax "*"', () => {
    const css = '@property --any { syntax: "*"; inherits: false; initial-value: red; } .a { --any: 8px; }';
    assert.deepEqual(lintSource(css).filter((x) => x.rule === 'VL005'), []);
  });

  test('accepts a literal keyword alternative in an enum-style syntax', () => {
    const css = '@property --size { syntax: "small | medium | large"; inherits: false; initial-value: medium; } .a { --size: large; }';
    assert.deepEqual(lintSource(css).filter((x) => x.rule === 'VL005'), []);
  });

  test('flags a value outside an enum-style syntax', () => {
    const css = '@property --size { syntax: "small | medium | large"; inherits: false; initial-value: medium; } .a { --size: huge; }';
    const f = lintSource(css).filter((x) => x.rule === 'VL005');
    assert.equal(f.length, 1);
  });

  test('cross-file: registration in one file, mismatched value in another', () => {
    const a = { file: 'a.css', source: '@property --gap { syntax: "<length>"; inherits: false; initial-value: 0px; }' };
    const b = { file: 'b.css', source: '.a { --gap: red; }' };
    const f = lint([a, b]).filter((x) => x.rule === 'VL005');
    assert.equal(f.length, 1);
    assert.equal(f[0]!.file, 'b.css');
    assert.match(f[0]!.message, /registered in a\.css/);
  });
});

describe('a clean project', () => {
  test('produces zero findings, including with includePossible', () => {
    const f = fixture('correct/clean.css');
    assert.deepEqual(lint([f]), []);
    assert.deepEqual(lint([f], { includePossible: true }), []);
  });
});

describe('model: findVarCalls', () => {
  test('splits the fallback only on the first top-level comma (css-variables-1 §3)', () => {
    const calls = findVarCalls('var(--a, 1, 2, 3)');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, '--a');
    assert.equal(calls[0]!.fallback, '1, 2, 3');
  });

  test('treats a bare trailing comma as an empty, present fallback', () => {
    const calls = findVarCalls('var(--a,)');
    assert.equal(calls[0]!.fallback, '');
  });

  test('has no fallback at all when there is no comma', () => {
    const calls = findVarCalls('var(--a)');
    assert.equal(calls[0]!.fallback, undefined);
  });

  test('finds a var() nested inside another var()’s fallback', () => {
    const calls = findVarCalls('var(--a, var(--b, red))');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.name, '--a');
    assert.equal(calls[0]!.fallback, 'var(--b, red)');
    assert.equal(calls[1]!.name, '--b');
    assert.equal(calls[1]!.fallback, 'red');
  });

  test('ignores var(-like text inside a quoted string', () => {
    const calls = findVarCalls('"var(--not-a-var)"');
    assert.deepEqual(calls, []);
  });
});

describe('model: splitTopLevelCommas', () => {
  test('does not split inside parens', () => {
    assert.deepEqual(splitTopLevelCommas('rgb(1, 2, 3), red'), ['rgb(1, 2, 3)', ' red']);
  });
});

describe('model: isTextuallyNestedUnder', () => {
  test('accepts a descendant combinator', () => {
    assert.ok(isTextuallyNestedUnder('.a', '.a .b'));
  });

  test('accepts a child combinator', () => {
    assert.ok(isTextuallyNestedUnder('.a', '.a > .b'));
  });

  test('rejects a same-name prefix that is not actually nested (substring trap)', () => {
    assert.ok(!isTextuallyNestedUnder('.card', '.card-title'));
  });

  test('accepts an identical selector (same rule)', () => {
    assert.ok(isTextuallyNestedUnder('.a', '.a'));
  });
});

describe('model: classifyValue', () => {
  test('classifies colors', () => {
    assert.equal(classifyValue('red'), 'color');
    assert.equal(classifyValue('#fff'), 'color');
    assert.equal(classifyValue('rgb(0 0 0)'), 'color');
  });

  test('classifies lengths, percentages, and integers/numbers', () => {
    assert.equal(classifyValue('8px'), 'length');
    assert.equal(classifyValue('50%'), 'percentage');
    assert.equal(classifyValue('4'), 'integer');
    assert.equal(classifyValue('4.5'), 'number');
  });

  test('is ambiguous for anything with a function it does not model, or multiple tokens', () => {
    assert.equal(classifyValue('calc(1px + 2px)'), 'ambiguous');
    assert.equal(classifyValue('1px solid red'), 'ambiguous');
  });
});

describe('model: parseSyntaxDescriptor', () => {
  test('parses a single component', () => {
    const s = parseSyntaxDescriptor('"<length>"');
    assert.deepEqual(s, { universal: false, alternatives: [{ component: 'length', keyword: undefined }] });
  });

  test('parses alternation of components and strips multipliers', () => {
    const s = parseSyntaxDescriptor('"<length>+ | <percentage>"');
    assert.equal(s.alternatives.length, 2);
    assert.equal(s.alternatives[0]!.component, 'length');
    assert.equal(s.alternatives[1]!.component, 'percentage');
  });

  test('recognizes the universal syntax', () => {
    assert.deepEqual(parseSyntaxDescriptor('"*"'), { universal: true, alternatives: [] });
  });

  test('treats an unrecognized bracketed token as a literal keyword rather than throwing', () => {
    const s = parseSyntaxDescriptor('"<not-a-real-component>"');
    assert.equal(s.alternatives[0]!.component, undefined);
  });
});

describe('parser', () => {
  test('refuses an unbalanced brace rather than guessing', () => {
    assert.throws(() => parse('.a { color: red;', 'bad.css'), CssParseError);
  });

  test('refuses an unmatched closing brace', () => {
    assert.throws(() => parse('.a { color: red; } }', 'bad.css'), CssParseError);
  });

  test('refuses an unterminated string', () => {
    assert.throws(() => parse('.a { content: "unterminated; }', 'bad.css'), CssParseError);
  });

  test('refuses an unterminated comment', () => {
    assert.throws(() => parse('.a { color: red; } /* oops', 'bad.css'), CssParseError);
  });

  test('a parse error names the offending file', () => {
    try {
      parse('.a {', 'exact-file.css');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof CssParseError);
      assert.equal(err.file, 'exact-file.css');
    }
  });

  test('tolerates a semicolon and braces inside a quoted string', () => {
    const nodes = parse('.a { content: "a; b { c }"; color: red; }', 'ok.css');
    assert.equal(nodes.length, 1);
  });

  test('accepts a bare last declaration with no trailing semicolon', () => {
    const nodes = parse('.a { color: red }', 'ok.css');
    const rule = nodes[0];
    assert.ok(rule && rule.type === 'rule');
    assert.equal(rule.children.length, 1);
  });
});

describe('CLI-facing shape', () => {
  test('every finding carries file, line, column, rule, severity and confidence', () => {
    const f = lint([fixture('scope-certain.css'), fixture('undefined-no-fallback.css')]);
    assert.ok(f.length >= 2);
    for (const one of f) {
      assert.equal(typeof one.file, 'string');
      assert.equal(typeof one.line, 'number');
      assert.equal(typeof one.column, 'number');
      assert.match(one.rule, /^VL\d{3}$/);
      assert.ok(one.severity === 'error' || one.severity === 'warning');
      assert.ok(one.confidence === 'certain' || one.confidence === 'possible');
    }
  });

  test('findings are sorted by file, then position', () => {
    const f = lint([fixture('undefined-no-fallback.css'), fixture('scope-certain.css')]);
    const files = f.map((x) => x.file);
    assert.deepEqual([...files].sort(), files);
  });
});
