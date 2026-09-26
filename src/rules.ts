import type { Declaration, RuleNode, StyleNode } from './parser.ts';
import {
  categorySatisfiesComponent,
  classifyValue,
  findVarCalls,
  isCustomPropertyName,
  isRootSelector,
  isTextuallyNestedUnder,
  parseSyntaxDescriptor,
  splitSelectorGroup,
  type ParsedSyntax,
} from './model.ts';

export type Severity = 'error' | 'warning';

/**
 * `certain` findings are provable from the CSS alone. `possible` findings
 * depend on a fact CSS cannot state — chiefly, the real DOM ancestor chain of
 * a selector — and are only ever reported when the caller opts in. See the
 * README section "What this can prove, and what it can only suspect", which
 * mirrors the same split made by this project's sibling, container-query-lint.
 */
export type Confidence = 'certain' | 'possible';

export interface Finding {
  rule: string;
  message: string;
  file: string;
  line: number;
  column: number;
  severity: Severity;
  confidence: Confidence;
}

export interface LintOptions {
  /**
   * Also report findings this tool cannot prove — only that a `var()`
   * reference's selector scope isn't demonstrably covered by any definition
   * of the custom property, not that it definitely isn't. Off by default:
   * on an ordinary project, most stylesheets are flat (no CSS nesting), so
   * this would flag the large majority of ordinary custom-property usage.
   * See the README.
   */
  includePossible?: boolean;
}

export interface LintFile {
  file: string;
  nodes: StyleNode[];
}

function push(
  findings: Finding[],
  file: string,
  node: { line: number; column: number },
  rule: string,
  severity: Severity,
  confidence: Confidence,
  message: string,
): void {
  findings.push({ rule, message, file, line: node.line, column: node.column, severity, confidence });
}

// ---------------------------------------------------------------------------
// Project-wide facts, gathered in one pass before any check runs.
// ---------------------------------------------------------------------------

interface Definition {
  file: string;
  node: RuleNode;
  decl: Declaration;
  /** Ancestor chain (root-to-self, inclusive) of `node`, by CSS nesting. */
  chain: RuleNode[];
  /** The comma-separated branches of `node`'s own selector (empty for at-rules). */
  selectorBranches: string[];
}

interface PropertyFacts {
  /** Every declaration `--x: value;` anywhere, regardless of selector. */
  definitions: Definition[];
  /** True if any declaration of this name sits under a `:root` branch. */
  definedAtRoot: boolean;
  /** Every place `var(--x[, fallback])` is used, with enough context to re-check it. */
  references: Reference[];
  /** `@property --x { ... }` registrations, if any. */
  registrations: Registration[];
}

interface Reference {
  file: string;
  node: RuleNode;
  decl: Declaration;
  chain: RuleNode[];
  hasFallback: boolean;
}

interface Registration {
  file: string;
  node: RuleNode;
  syntax: ParsedSyntax;
}

function emptyFacts(): PropertyFacts {
  return { definitions: [], definedAtRoot: false, references: [], registrations: [] };
}

function factsFor(map: Map<string, PropertyFacts>, name: string): PropertyFacts {
  let f = map.get(name);
  if (!f) {
    f = emptyFacts();
    map.set(name, f);
  }
  return f;
}

/** At-rules that don't change which elements a nested selector matches (see container-query-lint's TRANSPARENT_AT_RULES for the same idea applied to a different property). */
const TRANSPARENT_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'scope', 'starting-style']);

function isAtRule(node: RuleNode): boolean {
  return node.prelude.trimStart().startsWith('@');
}

function atRuleName(node: RuleNode): string {
  const m = /^@([a-zA-Z-]+)/.exec(node.prelude.trim());
  return m?.[1]?.toLowerCase() ?? '';
}

function ownDeclarations(node: RuleNode): Declaration[] {
  return node.children.filter((c): c is Declaration => c.type === 'decl');
}

/**
 * Walk the whole project once, recording every custom-property definition,
 * every `var()` reference, and every `@property` registration, each tagged
 * with its CSS-nesting ancestor chain (an array of `RuleNode` object
 * identities, root to self). That chain is what the scope checks in
 * `checkScope` use to answer "is this rule provably nested inside that one" —
 * see the README's "certain" case for exactly what it does and doesn't prove.
 */
function collectFacts(files: LintFile[]): Map<string, PropertyFacts> {
  const map = new Map<string, PropertyFacts>();

  for (const f of files) {
    const visit = (nodes: StyleNode[], chain: RuleNode[]) => {
      for (const node of nodes) {
        if (node.type === 'decl') {
          if (isCustomPropertyName(node.prop)) {
            const owner = chain[chain.length - 1];
            if (owner) {
              const facts = factsFor(map, node.prop);
              const branches = splitSelectorGroup(owner.prelude);
              facts.definitions.push({ file: f.file, node: owner, decl: node, chain, selectorBranches: branches });
              if (branches.some(isRootSelector)) facts.definedAtRoot = true;
            }
          }
          for (const call of findVarCalls(node.value)) {
            const owner = chain[chain.length - 1];
            if (!owner) continue;
            const facts = factsFor(map, call.name);
            facts.references.push({
              file: f.file,
              node: owner,
              decl: node,
              chain,
              hasFallback: call.fallback !== undefined,
            });
          }
          continue;
        }

        const atRule = isAtRule(node);
        const name = atRule ? atRuleName(node) : '';

        if (atRule && name === 'property') {
          const propName = node.prelude.trim().replace(/^@property\s+/i, '').trim();
          const syntaxDecl = ownDeclarations(node).find((d) => d.prop.toLowerCase() === 'syntax');
          if (isCustomPropertyName(propName) && syntaxDecl) {
            const facts = factsFor(map, propName);
            facts.registrations.push({ file: f.file, node, syntax: parseSyntaxDescriptor(syntaxDecl.value) });
          }
        }

        // A plain selector rule always extends the ancestry chain. A
        // "transparent" at-rule (@media, @supports, ...) doesn't change which
        // elements a nested selector matches, so it passes the chain through
        // unchanged. Anything else — @property's own body, @keyframes,
        // @font-face, @page — does not describe an element in the document at
        // all, so ancestry is reset: nothing inside it is "nested under" the
        // rules outside it.
        if (!atRule) {
          visit(node.children, [...chain, node]);
        } else if (TRANSPARENT_AT_RULES.has(name)) {
          visit(node.children, chain);
        } else {
          visit(node.children, []);
        }
      }
    };
    visit(f.nodes, []);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

export function lint(files: LintFile[], options: LintOptions = {}): Finding[] {
  const facts = collectFacts(files);
  const findings: Finding[] = [];

  for (const [name, propFacts] of facts) {
    checkScopeAndFallback(name, propFacts, options, findings);
    checkDeadProperty(name, propFacts, findings);
    checkRegistrationMismatch(name, propFacts, findings);
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return findings;
}

/** Whether `ancestor` appears in `chain` (by object identity), i.e. is `descendant`-or-self. */
function chainIncludes(chain: RuleNode[], node: RuleNode): boolean {
  return chain.includes(node);
}

type Relation = 'safe' | 'descendant-of-use' | 'unrelated';

/**
 * Classify one definition's relationship to one reference's scope.
 *
 *  - `'safe'`: the definition is the reference's own rule, a CSS-nesting
 *    ancestor of it, or — for two flat, unnested top-level rules — textually
 *    proven to be an ancestor selector. In every one of these cases the
 *    referencing element is guaranteed, by the CSS alone, to either *be* the
 *    element the definition applies to or inherit from it (custom properties
 *    inherit by default: css-variables-1 §2, "Custom properties are ...
 *    inherited").
 *  - `'descendant-of-use'`: the definition is nested *inside* the referencing
 *    rule (the reference is an ancestor of the definition, not the other way
 *    around). This is provably useless regardless of the real DOM: CSS custom
 *    properties inherit downward only, so a rule can never receive a value
 *    from something nested inside it.
 *  - `'unrelated'`: neither of the above — most commonly two flat, unrelated
 *    selectors, or two rules in different files. The real DOM could still
 *    place the referencing element inside whatever the definition's selector
 *    matches (nothing in the CSS rules it out), so this is fundamentally
 *    unprovable from CSS alone.
 */
function relate(def: Definition, ref: Reference): Relation {
  if (def.node === ref.node) return 'safe';

  if (def.file === ref.file) {
    if (chainIncludes(ref.chain, def.node)) return 'safe'; // def is an ancestor of ref, by nesting
    if (chainIncludes(def.chain, ref.node)) return 'descendant-of-use'; // def is nested inside ref
  }

  // Neither side is a CSS-nesting descendant of the other. The only
  // remaining provable relationship is the textual descendant-combinator
  // check, and that only means something when *both* selectors are flat,
  // top-level rules (chain length 1): once either side is itself nested,
  // resolving its full effective selector would require re-deriving CSS
  // Nesting's `&`-substitution rules, which this tool deliberately does not
  // attempt (see the README) — safer to call it unprovable than to guess.
  if (def.chain.length === 1 && ref.chain.length === 1) {
    const refBranches = splitSelectorGroup(ref.node.prelude);
    for (const defBranch of def.selectorBranches) {
      for (const refBranch of refBranches) {
        if (isTextuallyNestedUnder(defBranch, refBranch)) return 'safe';
      }
    }
  }

  return 'unrelated';
}

/**
 * VL001 (scope) and VL002 (no-fallback risk in the unprovable bucket) — see
 * the README for the full reasoning; this only implements it.
 */
function checkScopeAndFallback(
  name: string,
  facts: PropertyFacts,
  options: LintOptions,
  findings: Finding[],
): void {
  // A registered custom property (`@property`) is never guaranteed-invalid —
  // css-properties-values-api-1 §2.4/§4.1 give it a registered `initial-value`
  // that it resets to instead. So a scope miss on a registered property
  // doesn't produce an unstyled/invalid declaration; it silently uses the
  // registered default instead of the scoped override the author intended.
  // Still worth flagging (it's still not the value the author wrote), but the
  // wording has to say the true failure mode, not "invalid at computed-value
  // time".
  const isRegistered = facts.registrations.length > 0;

  if (facts.definitions.length === 0) {
    // VL003 handles "never defined anywhere" — a different, simpler case.
    if (!isRegistered) checkNeverDefined(name, facts, findings);
    return;
  }
  if (facts.definedAtRoot) return; // available everywhere; nothing to check.

  for (const ref of facts.references) {
    let anySafe = false;
    let allDescendantOfUse = true;

    for (const def of facts.definitions) {
      const relation = relate(def, ref);
      if (relation === 'safe') anySafe = true;
      if (relation !== 'descendant-of-use') allDescendantOfUse = false;
    }
    if (anySafe) continue;

    if (allDescendantOfUse) {
      const consequence = isRegistered
        ? `this falls back to ${name}'s registered initial-value instead (css-properties-values-api-1 ` +
          `§4.1) — the scoped override this rule wrote is silently never applied here`
        : ref.hasFallback
          ? `the fallback given here is used instead — check that it's really the intended default`
          : `no fallback is given, so this is invalid at computed-value time (css-variables-1 §3, step 4)`;
      push(
        findings,
        ref.file,
        ref.decl,
        'VL001',
        'error',
        'certain',
        `var(${name}) is used here, but every declaration of ${name} in this file is nested ` +
          `*inside* this rule, not around it. Per css-variables-1 §2, custom properties inherit ` +
          `downward only — a rule can never receive a value from something nested inside it, ` +
          `regardless of the real document structure; ${consequence}.`,
      );
    } else if (options.includePossible) {
      push(
        findings,
        ref.file,
        ref.decl,
        'VL001',
        'warning',
        'possible',
        `var(${name}) is used here, but no declaration of ${name} is provably an ancestor scope of ` +
          `this rule (via CSS nesting, or a literal descendant-combinator prefix). It may still be ` +
          `available through the real DOM's ancestor chain — this cannot be confirmed or ruled out ` +
          `from CSS alone.`,
      );
    }

    if (!allDescendantOfUse && !ref.hasFallback && !isRegistered) {
      push(
        findings,
        ref.file,
        ref.decl,
        'VL002',
        'warning',
        'certain',
        `var(${name}) has no fallback, and this tool cannot confirm ${name} is defined in every ` +
          `scope this rule can match. Per css-variables-1 §3 step 4, if ${name} is missing here at ` +
          `computed-value time, this declaration becomes invalid at computed-value time — an ` +
          `unstyled property, not a typo warning. A fallback (\`var(${name}, <default>)\`) turns that ` +
          `into a controlled default instead.`,
      );
    }
  }
}

/** VL003 — `var(--x)` where `--x` is declared nowhere in the whole project, and has no fallback. */
function checkNeverDefined(name: string, facts: PropertyFacts, findings: Finding[]): void {
  for (const ref of facts.references) {
    if (ref.hasFallback) continue; // an undefined property with a fallback is a normal, overridable default.
    push(
      findings,
      ref.file,
      ref.decl,
      'VL003',
      'error',
      'certain',
      `var(${name}) is used here, but ${name} is never declared anywhere in the project (no ` +
        `selector, no :root), and no fallback is given. Per css-variables-1 §2.2, an undeclared ` +
        `custom property's value is the guaranteed-invalid value, and substituting it with no ` +
        `fallback makes this declaration invalid at computed-value time (§3 step 4) — not a parse ` +
        `error, just a property that silently never applies.`,
    );
  }
}

/** VL004 — declared but never referenced anywhere in the project (a dead token). */
function checkDeadProperty(name: string, facts: PropertyFacts, findings: Finding[]): void {
  if (facts.definitions.length === 0 || facts.references.length > 0) return;
  for (const def of facts.definitions) {
    push(
      findings,
      def.file,
      def.decl,
      'VL004',
      'warning',
      'certain',
      `${name} is declared here but var(${name}) is never used anywhere in the project. Possibly ` +
        `dead, or consumed only from JavaScript (e.g. \`style.setProperty\`/\`getPropertyValue\`) — ` +
        `see the README.`,
    );
  }
}

/**
 * VL005 — a value declared for `--x` doesn't satisfy `--x`'s registered
 * `@property` syntax. Per css-properties-values-api-1 §2.4/§4.1: "If the
 * specified value for a registered custom property violates the registered
 * syntax ... the property becomes invalid at computed-value time (and thus
 * resets to the registered initial value)" — silently, no parse error.
 */
function checkRegistrationMismatch(name: string, facts: PropertyFacts, findings: Finding[]): void {
  if (facts.registrations.length === 0) return;

  for (const reg of facts.registrations) {
    if (reg.syntax.universal) continue; // "*" accepts anything.

    for (const def of facts.definitions) {
      const raw = def.decl.value.trim();
      if (raw === '' || /^(var|calc|clamp|min|max|env|attr)\(/i.test(raw)) continue; // out of scope: see README.
      const category = classifyValue(raw);
      if (category === 'ambiguous') continue;

      const compatible = reg.syntax.alternatives.some((alt) => {
        if (alt.component) return categorySatisfiesComponent(category, alt.component);
        return category === 'custom-ident' && alt.keyword !== undefined && alt.keyword.toLowerCase() === raw.toLowerCase();
      });
      if (compatible) continue;

      const syntaxDesc = reg.syntax.alternatives
        .map((a) => (a.component ? `<${a.component}>` : a.keyword))
        .join(' | ');
      push(
        findings,
        def.file,
        def.decl,
        'VL005',
        'error',
        'certain',
        `${name} is declared as "${raw}" here, but @property ${name} registers syntax "${syntaxDesc}" ` +
          `(${def.file === reg.file ? 'same file' : `registered in ${reg.file}`}). "${raw}" looks like a ` +
          `${category}, which that syntax doesn't accept. Per css-properties-values-api-1 §4.1, this ` +
          `makes the declaration invalid at computed-value time — it silently resets to the registered ` +
          `initial-value instead of using "${raw}".`,
      );
    }
  }
}
