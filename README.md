# css-var-lint

Finds CSS custom properties that silently resolve to nothing, or to the wrong thing —
because of selector scope, a missing fallback, or an `@property` syntax mismatch — none
of which is a CSS parse error.

```
broken.css, default run (three provable mistakes)
  10:3   warning  [VL002]  var(--surface) has no fallback, and this tool cannot confirm
                           --surface is defined in every scope this rule can match. Per
                           css-variables-1 §3 step 4, if --surface is missing here at
                           computed-value time, this declaration becomes invalid at
                           computed-value time — an unstyled property, not a typo warning.
                           A fallback (`var(--surface, <default>)`) turns that into a
                           controlled default instead.
  22:3   error    [VL005]  --card-radius is declared as "crimson" here, but @property
                           --card-radius registers syntax "<length>" (same file).
                           "crimson" looks like a color, which that syntax doesn't accept.
                           Per css-properties-values-api-1 §4.1, this makes the
                           declaration invalid at computed-value time — it silently
                           resets to the registered initial-value instead of using
                           "crimson".
  28:3   warning  [VL004]  --legacy-banner-height is declared here but
                           var(--legacy-banner-height) is never used anywhere in the
                           project.

clean.css, the same theme fixed
  no findings
```

That's `node examples/scan-demo.ts`, trimmed for width — the tool's own output isn't
wrapped, and `--include-possible` on that same broken.css turns up a fourth, deliberately
suppressed-by-default finding (see below).

## The problem

`var(--x)` looks like a static reference to a static value. It isn't one. A custom
property's value depends on where in the cascade it was declared, and `var()`
substitution happens per-element, at computed-value time — so the same `var(--x)` in the
same stylesheet can resolve differently depending on what actually contains the element
it ends up applied to. None of the ways this goes wrong are CSS syntax errors:

- **A property defined only under one selector, read from a rule that selector doesn't
  provably reach.** `.dark-theme { --surface: #1c1c1e; }` then `.card { background:
  var(--surface); }` parses fine and renders fine — *if* `.card`'s element happens to be
  inside something matching `.dark-theme` in the actual page. If it isn't, `--surface` is
  the guaranteed-invalid value there, and the declaration is invalid at computed-value
  time. Nothing in DevTools calls this an error; the box is just the wrong color, or no
  color at all.
- **No fallback, on a property that isn't guaranteed to be defined.** `var(--x)` with no
  second argument is a bet that `--x` will always be there. When it isn't, per
  [CSS Custom Properties for Cascading Variables Module Level 1](https://www.w3.org/TR/css-variables-1/)
  §3 step 4, the declaration is invalid at computed-value time — which for most
  properties means the value behaves as `unset` (back to inherited or initial). A
  fallback (`var(--x, <default>)`) turns exactly that failure into a controlled default
  instead; leaving it off is a choice, usually made unintentionally.
- **`@property` disagreeing with what's actually declared.** `@property --radius {
  syntax: "<length>"; }` followed by `--radius: crimson;` somewhere registers a promise
  the next line breaks. Per the
  [CSS Properties and Values API Level 1](https://drafts.css-houdini.org/css-properties-values-api-1/)
  §4.1, a value that violates the registered syntax is invalid at computed-value time and
  silently resets to the registered `initial-value` — the override is dropped, not
  rejected loudly.

A generic CSS validator has nothing to flag in any of this: every one of these is
syntactically valid CSS. You find out when a themed component renders in the wrong
color, or an animation collapses to zero, and by then it can be a while since the
variable was written.

### Why the obvious defense doesn't work

The obvious first move is a stylelint rule, and one already exists:
[`stylelint-value-no-unknown-custom-properties`](https://github.com/csstools/stylelint-value-no-unknown-custom-properties)
(part of `@csstools/stylelint-plugins`) flags `var(--x)` where `--x` is never declared
anywhere. That's a real, useful check, and this tool doesn't try to replace it. Its
documented limitation, confirmed from its own README before writing this section rather
than assumed, is the one this tool exists to cover: it collects every `--custom-property:`
declaration in the project into one flat set and checks membership against that set — a
property declared under `.some-other-class` counts as "known" for a completely unrelated
selector elsewhere in the stylesheet. There is no cascade or selector-scope reasoning at
all. `:root { --brand-blue: #33f; }` and `.some-other-class { --brand-blue: #33f; }` are
treated identically by that rule; both simply add `--brand-blue` to the known set.

That's exactly backwards from what actually matters for a *scoped* custom property: a
variable defined on `.dark-theme` is not available to a rule matching `.card` unless
`.card` is inside `.dark-theme`. A flat, whole-project "is this name declared anywhere"
check can never fail that case — the name **is** declared somewhere, just not somewhere
that reaches this rule — so it passes silently. This tool's core job is exactly that gap:
scope, not existence.

## Install

```sh
npm install --save-dev css-var-lint
```

Node >= 20.6. No runtime dependencies.

## Use

As a CLI:

```sh
npx css-var-lint src/**/*.css
```

(Your shell expands the glob before this program sees it — there's no bundled glob
engine.) Exits `1` if any `error`-severity finding was reported, `0` otherwise.

As a library:

```ts
import { lint } from 'css-var-lint';

const findings = lint([
  { file: 'theme.css', source: readFileSync('theme.css', 'utf8') },
]);

for (const f of findings) {
  console.log(`${f.file}:${f.line}:${f.column} [${f.rule}] ${f.message}`);
}
```

Findings are pooled across every file passed in the same call before checks run — "is
`--x` declared anywhere in the project, and at what scope" is a project-wide question,
not a per-file one, so pass your whole stylesheet set in one `lint()` call rather than
one file at a time.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `includePossible` (CLI: `--include-possible`) | `false` | Also report findings this tool cannot prove — see below. Off by default because on an ordinary flat-selector project it would flag most ordinary scoped custom-property usage. |

CLI-only: `--strict` (exit non-zero on warnings too), `--json` (machine-readable output).

## What this can prove, and what it can only suspect

Every VL001 finding carries a `confidence`: `'certain'` or `'possible'` — the same split
this project's sibling, `container-query-lint`, makes for the same underlying reason:
a CSS file cannot see the real DOM. `@container` needs a DOM ancestor to be a query
container; a custom property needs a DOM ancestor to have set it. Both questions are
sometimes genuinely unanswerable from CSS text alone.

**`certain`** — provable from the parsed CSS alone, no DOM knowledge assumed:

- **VL001**, in one specific shape: every declaration of `--x` in the file is nested,
  via CSS nesting, *inside* the rule doing `var(--x)` — e.g. `--x` declared only inside
  a nested `.dark-theme { }` block, and referenced by the enclosing rule's own
  declarations, or by a sibling nested block. Custom properties inherit **downward
  only** (css-variables-1 §2) — a rule can never receive a value from something nested
  inside it, regardless of what the real page's markup looks like. That direction is
  fully determined by the CSS nesting structure itself, so this needs no DOM.
- **VL002** — `var(--x)` has no fallback, and this file cannot show that `--x` is
  guaranteed to be in scope everywhere this rule can match (see VL001, `possible`,
  below) — this fact ("no fallback" + "not proven safe") is itself certain, whichever
  way the underlying scope question turns out.
- **VL003** — `var(--x)` with no fallback, where `--x` is declared **nowhere** in the
  whole project (no selector, no `:root`, no `@property … { initial-value: … }`). A name
  that's never declared anywhere can't resolve, full stop.
- **VL004** — `--x` is declared but `var(--x)` never appears anywhere in the project.
- **VL005** — a declared value's inferred type doesn't satisfy its `@property`
  registration's `syntax`, for values this tool's classifier can confidently type
  (a bare color, length, number, percentage, angle, time, resolution, `url()`, string,
  or identifier — see "What it does not do").

**`possible`** — only reported with `includePossible: true` (default off):

- **VL001**, the general case: `--x` is declared under some non-`:root` selector, and
  the rule doing `var(--x)` isn't provably inside that selector's scope — neither via
  CSS nesting, nor via a literal descendant-combinator prefix in flat selector text
  (`.dark-theme .card` proves `.card` is inside `.dark-theme`; two independent flat
  selectors like `.dark-theme` and `.card` prove nothing either way). The real DOM might
  still nest them correctly — this cannot be confirmed or ruled out from CSS. Most real
  stylesheets are flat, so this is deliberately quiet by default; see "Signal-to-noise on
  a real project" below for why that default matters in practice.

A property registered with `@property` changes the *consequence* described in VL001 and
VL002's messages, not whether they fire: a registered custom property is never the
guaranteed-invalid value (css-properties-values-api-1 §2.4/§4.1) — a scope miss on one
falls back to its registered `initial-value` rather than going unstyled, and the message
says so. VL002 doesn't fire at all for a registered property, since the "unstyled
element" risk it warns about doesn't apply to one.

## Rules reference

| Code | What it flags | Confidence |
| --- | --- | --- |
| VL001 | `var(--x)` used where `--x`'s only declarations can't reach it | certain (nesting-provable) or possible (opt-in) |
| VL002 | `var(--x)` with no fallback, not proven safe | certain |
| VL003 | `var(--x)` with no fallback, `--x` declared nowhere in the project | certain |
| VL004 | `--x` declared but never referenced (dead token) | certain |
| VL005 | a declared value disagrees with `--x`'s `@property` syntax | certain |

## Signal-to-noise on a real project

Bootstrap 5.3.8's compiled `dist/css/bootstrap.css` (280 KB, no build step, npm-installed
for this check) against the default run:

```
3 errors, 537 warnings
```

The 3 errors (all VL003) are real, and not obvious from reading the file: `--bs-body-text-align`,
`--bs-nav-link-font-size`, and `--bs-breadcrumb-font-size` are each referenced by
`var()` exactly once, with no fallback, and declared nowhere else in the same
distributed file — confirmed by hand with `grep` after the tool flagged them, not just
trusted. Whether that's an intentional public override point or a leftover from a
refactor, this tool doesn't know from CSS alone — but it's the kind of thing a "search for
the name" pass over a 280 KB file would take a while to notice on its own.

The 537 warnings are mostly not that useful, and it's worth saying so plainly rather
than only citing the good result. The overwhelming majority are VL002: Bootstrap's own
convention is to declare a component's custom properties on its root class
(`.offcanvas { --bs-offcanvas-width: …; }`) and read them, with no fallback, from
sibling rules for the same component (`.offcanvas-header`, `.offcanvas-body`, …) that
are never nested under the root selector in the CSS — only in the real, rendered DOM.
That's a completely ordinary, correct pattern; VL002 has no way to see that the DOM
relationship holds, so it fires on nearly every one of them. (Running with
`--include-possible` roughly doubles the total, to 1060, for the same underlying
reason — VL001's possible bucket is largely the same population as VL002's.) The 80
VL004 warnings are similarly mostly Bootstrap's Sass-derived color palette
(`--bs-blue`, `--bs-indigo`, …), kept as CSS custom properties as a public theming
surface rather than for internal use — see "What it does not do" for the same caveat.

Net honest read: on a stylesheet written in this exact convention (root-scoped tokens,
sibling consumers, no fallbacks, by design), VL002 in particular is closer to noise than
signal, and the practical move is to filter it out (or run with `--json` and post-filter
by `rule`) rather than act on every warning. VL003, on the same file, found three real,
non-obvious things with zero false positives. VL001 found nothing at either confidence
level, because Bootstrap doesn't use CSS nesting — expected, and consistent with what it
can and can't prove.

## What it does not do

- **It does not resolve real selector ancestry.** Only two things count as provable
  scope: CSS nesting (an exact fact about the parsed tree) and a literal
  descendant-combinator prefix in flat selector text. It does not implement `:is()`/
  `:where()` expansion, attribute-selector equivalence, specificity, or any other
  selector-matching machinery — see `container-query-lint`'s README for the same design
  choice, made for the same reason (a wrong guess here is worse than no guess).
- **It does not know about JavaScript.** `--x` set via `element.style.setProperty('--x',
  …)` or read via `getComputedStyle(el).getPropertyValue('--x')` is invisible to this
  tool. VL004 in particular will flag a custom property that's genuinely a public
  theming API, meant to be set from outside the stylesheet entirely.
- **It does not evaluate values.** `classifyValue()` only classifies a single,
  literal token — a bare color, length, percentage, number, angle, time, resolution,
  `url()`, string, or identifier. Anything using `calc()`, `clamp()`, `min()`, `max()`,
  `attr()`, `env()`, a nested `var()`, or more than one space-separated token comes back
  "ambiguous" and is never used to raise VL005 — a wrong guess there would be a false
  positive on perfectly valid CSS, which is worse than staying silent.
- **`<image>` is approximated as "anything `url(...)`."** VL005 treats a bare `url()`
  value as satisfying an `<image>` syntax component. It does not model `linear-gradient()`,
  `image-set()`, or any other real `<image>` production.
- **It does not model `@scope`.** `@scope`'s donor/limit selectors change real
  cascade scoping, but this tool treats `@scope` as ancestry-transparent, the same
  way it treats `@media`/`@supports` — a nested rule under `@scope` inherits ancestry
  as if the `@scope` wrapper weren't there, rather than being understood as its own
  scoping boundary.
- **No autofix.** Every finding is a report, never a rewrite.
- **No SCSS/Less preprocessing.** It parses CSS, including CSS nesting; it does not
  understand `&`-based Sass nesting shorthand beyond what's identical to native CSS
  nesting, `@if`, mixins, or `.scss` partials referenced via `@import`/`@use` without
  inlining them first.

## Develop

Tests are TypeScript run directly by Node's test runner — no build, no install:

```sh
node --test "test/*.test.ts"    # full suite, needs node 24+ for type stripping
node examples/scan-demo.ts

npm run build && npm run test:dist   # what CI runs against node 20 and 22
```

## License

MIT
