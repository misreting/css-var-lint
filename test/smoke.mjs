/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines` — the TypeScript suite needs type stripping and only runs on 24+.
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { lintSource, CssParseError } = await import('../dist/index.js');

test('flags a var() whose only definition is nested inside the referencing rule', () => {
  const css = '.card { .dark-theme { --x: red; } color: var(--x); }';
  const findings = lintSource(css);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'VL001');
  assert.equal(findings[0].confidence, 'certain');
});

test('flags a reference to a name declared nowhere, with no fallback', () => {
  const css = '.a { color: var(--never-defined); }';
  const findings = lintSource(css);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'VL003');
});

test('flags a declared property that is never referenced', () => {
  const css = ':root { --unused: 1px; } .a { color: red; }';
  const findings = lintSource(css);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'VL004');
});

test('flags a value that violates its @property syntax', () => {
  const css = '@property --gap { syntax: "<length>"; inherits: false; initial-value: 0px; } .a { --gap: red; }';
  const findings = lintSource(css).filter((f) => f.rule === 'VL005');
  assert.equal(findings.length, 1);
});

test('a well-formed project produces no findings', () => {
  const css = ':root { --gap: 1rem; } .a { padding: var(--gap); }';
  assert.deepEqual(lintSource(css), []);
});

test('refuses unparseable CSS instead of guessing', () => {
  assert.throws(() => lintSource('.a { color: red;'), CssParseError);
});
