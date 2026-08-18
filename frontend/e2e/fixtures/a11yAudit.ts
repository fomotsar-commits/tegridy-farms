/**
 * The structural a11y audit the route sweep runs on every page.
 *
 * THIS IS NOT AXE, AND IT IS NOT PRETENDING TO BE. axe-core is not a
 * dependency of this repo (checked: `@axe-core/playwright` and `axe-core` are
 * absent from package.json and from node_modules), and adding a dependency is
 * not this change's to make. So the rules below are hand-written, in-page, and
 * every one of them is NAMED AFTER THE AXE RULE IT STANDS IN FOR — when axe
 * does land, each rule here is deleted in favour of its namesake rather than
 * left to disagree with it in the dark.
 *
 * What that costs, stated plainly so nobody reads a green sweep as a clean
 * WCAG bill of health. These rules cover markup an assistive technology reads
 * directly: landmarks, heading structure, accessible names, label association,
 * ARIA references that resolve, focus order. They do NOT cover anything that
 * needs layout or paint — `color-contrast`, `target-size`, `scrollable-region-
 * focusable`, `link-in-text-block` — nor the ~90 further axe rules. A route
 * with zero findings here is a route whose semantics are sound, not a route
 * that is WCAG AA.
 *
 * Rules are pure DOM reads and run inside `page.evaluate`, so the whole body
 * must stay self-contained — no imports reach it.
 */

import type { Page } from '@playwright/test';

export interface A11yFinding {
  /** axe rule id this stands in for. */
  rule: string;
  /** Human-readable locator for the offending node. */
  target: string;
  /** What is wrong with this node specifically. */
  detail: string;
}

/** Rule ids the audit can emit. Kept here so the vitest guard can assert the debt lists only name real rules. */
export const A11Y_RULES = [
  'landmark-one-main',
  'page-has-heading-one',
  'heading-order',
  'image-alt',
  'button-name',
  'link-name',
  'form-field-label',
  'aria-valid-attr-value',
  'duplicate-id-aria',
  'tabindex',
] as const;

export type A11yRule = (typeof A11Y_RULES)[number];

export interface AuditScope {
  /** Narrow the sweep to this subtree. */
  root?: string;
  /** Drop findings inside this subtree — the inverse of `root`, for auditing chrome only. */
  exclude?: string;
}

/**
 * Run the audit against the current document.
 *
 * The route sweep passes `{ root: 'main#main-content' }` so each route is
 * judged on its own content, and one 'shared chrome' test passes
 * `{ exclude: 'main#main-content' }` so the TopNav/footer defects are owned in
 * exactly one place instead of being reported on all forty routes.
 *
 * The two aggregate rules (`landmark-one-main`, `page-has-heading-one`) always
 * read the whole document — "this page has one main and one h1" is a claim
 * about the page, and scoping it to `main` would make it unfalsifiable.
 */
export async function auditA11y(page: Page, scope?: AuditScope | string): Promise<A11yFinding[]> {
  const normalized: AuditScope = typeof scope === 'string' ? { root: scope } : scope ?? {};
  return page.evaluate(({ sel, excludeSel }) => {
    const root: ParentNode = (sel ? document.querySelector(sel) : null) ?? document;
    const excludeRoot = excludeSel ? document.querySelector(excludeSel) : null;
    const excluded = (el: Element): boolean => !!excludeRoot && excludeRoot.contains(el);
    const findings: { rule: string; target: string; detail: string }[] = [];
    const add = (rule: string, target: string, detail: string) => findings.push({ rule, target, detail });

    // ── helpers ────────────────────────────────────────────────────────
    const rendered = (el: Element): boolean => {
      if (el.closest('[aria-hidden="true"]')) return false;
      if (el.closest('[hidden]')) return false;
      const style = getComputedStyle(el as HTMLElement);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      // A zero-box element that is not a visually-hidden (clip/sr-only) control
      // is not on the page for anyone; skip it rather than report it.
      const box = (el as HTMLElement).getBoundingClientRect();
      if (box.width === 0 && box.height === 0 && style.position !== 'absolute' && style.position !== 'fixed') {
        return false;
      }
      return true;
    };

    const describe = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = (el.getAttribute('class') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join('');
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const href = el.getAttribute('href');
      const attrs = [
        href ? `href="${href.slice(0, 48)}"` : '',
        el.getAttribute('type') ? `type="${el.getAttribute('type')}"` : '',
        el.getAttribute('src') ? `src="${(el.getAttribute('src') ?? '').slice(0, 48)}"` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `${tag}${id}${cls}${attrs ? `[${attrs}]` : ''}${text ? ` "${text}"` : ''}`;
    };

    const labelledByText = (el: Element): string => {
      const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
      return ids
        .map((i) => document.getElementById(i)?.textContent ?? '')
        .join(' ')
        .trim();
    };

    const accessibleName = (el: Element): string => {
      const byRef = labelledByText(el);
      if (byRef) return byRef;
      const aria = (el.getAttribute('aria-label') ?? '').trim();
      if (aria) return aria;
      const tag = el.tagName.toLowerCase();
      if (tag === 'input') {
        const t = (el.getAttribute('type') ?? '').toLowerCase();
        if (t === 'submit' || t === 'button' || t === 'reset') return (el as HTMLInputElement).value.trim();
      }
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) return text;
      // An icon-only control can still be named by the alt text or <title> of
      // the graphic it wraps.
      const img = el.querySelector('img[alt]:not([alt=""])');
      if (img) return (img.getAttribute('alt') ?? '').trim();
      const svgTitle = el.querySelector('svg > title');
      if (svgTitle) return (svgTitle.textContent ?? '').trim();
      return (el.getAttribute('title') ?? '').trim();
    };

    /**
     * A `<label>` names more than inputs. HTML's labelable elements include
     * `button`, and the browser really does compute the name that way —
     * measured on /launch-simulator, whose five `role="switch"` buttons sit
     * inside `<label>`s: Playwright's `getByRole('switch', { name: /.+/ })`
     * matched all five. An earlier version of this rule reported all five as
     * nameless, which would have shipped a fabricated defect into the debt
     * list and sent someone to "fix" working markup.
     */
    const labelName = (el: Element): string => {
      const wrapping = el.closest('label');
      if (wrapping) {
        const text = (wrapping.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
      if (el.id) {
        const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        const text = (forLabel?.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
      return '';
    };

    const all = <T extends Element>(q: string): T[] =>
      (Array.from(root.querySelectorAll(q)) as T[]).filter((el) => rendered(el) && !excluded(el));

    // ── landmark-one-main ──────────────────────────────────────────────
    // Document-level, so it always reads the document even when scoped.
    const mains = Array.from(document.querySelectorAll('main, [role="main"]')).filter(rendered);
    if (mains.length !== 1) {
      add(
        'landmark-one-main',
        mains.length === 0 ? 'document' : mains.map(describe).join(' | '),
        `expected exactly one rendered main landmark, found ${mains.length}`,
      );
    }

    // ── page-has-heading-one ───────────────────────────────────────────
    const h1s = Array.from(document.querySelectorAll('h1')).filter(rendered);
    if (h1s.length === 0) {
      add('page-has-heading-one', 'document', 'no rendered <h1> — the page has no top-level heading');
    } else if (h1s.length > 1) {
      // Not an axe default, but load-bearing here: `page.locator('h1')` is
      // used as the mounted-page probe across the e2e suite, and a second h1
      // turns those assertions into strict-mode violations.
      add(
        'page-has-heading-one',
        h1s.map(describe).join(' | '),
        `${h1s.length} rendered <h1> elements — a page has exactly one top-level heading`,
      );
    }

    // ── heading-order ──────────────────────────────────────────────────
    // Scoped, unlike the two rules above. The footer's heading levels are the
    // same on all forty routes; auditing them per-route reports one defect
    // forty times and buries the route's own. The unscoped pass in
    // a11y-routes.spec.ts ('shared chrome') is where that one is owned.
    const headings = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(rendered);
    let prev = 0;
    for (const h of headings) {
      const level = Number(h.tagName[1]);
      // The level still advances across an excluded heading — the footer's
      // levels are read by a screen reader in document order regardless of
      // which test owns them, so skipping them outright would hide a skip
      // that starts inside `main` and lands in the footer.
      if (prev !== 0 && level > prev + 1 && !excluded(h)) {
        add('heading-order', describe(h), `h${level} follows h${prev} — heading levels may not skip`);
      }
      prev = level;
    }

    // ── image-alt ──────────────────────────────────────────────────────
    for (const img of all<HTMLImageElement>('img')) {
      if (img.getAttribute('role') === 'presentation' || img.getAttribute('role') === 'none') continue;
      if (img.hasAttribute('alt')) continue;
      if (img.getAttribute('aria-label') || img.getAttribute('aria-labelledby')) continue;
      add('image-alt', describe(img), 'no alt attribute — decorative images need alt="" explicitly');
    }

    // ── button-name ────────────────────────────────────────────────────
    for (const btn of all('button, [role="button"], [role="switch"], input[type="button"], input[type="submit"]')) {
      if (accessibleName(btn) || labelName(btn)) continue;
      add(
        'button-name',
        describe(btn),
        'control has no accessible name (text, aria-label, wrapping/for label, or labelled graphic)',
      );
    }

    // ── link-name ──────────────────────────────────────────────────────
    for (const link of all('a[href]')) {
      if (accessibleName(link)) continue;
      add('link-name', describe(link), 'link has no accessible name');
    }

    // ── form-field-label ───────────────────────────────────────────────
    for (const field of all('input, select, textarea')) {
      const type = (field.getAttribute('type') ?? '').toLowerCase();
      if (type === 'hidden' || type === 'button' || type === 'submit' || type === 'reset') continue;
      if (accessibleName(field) || labelName(field)) continue;
      add(
        'form-field-label',
        describe(field),
        'form field has no label (no <label for>, wrapping label, aria-label, or aria-labelledby)',
      );
    }

    // ── aria-valid-attr-value: every idref must resolve ────────────────
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns']) {
      for (const el of all(`[${attr}]`)) {
        const missing = (el.getAttribute(attr) ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .filter((id) => !document.getElementById(id));
        if (missing.length) {
          add('aria-valid-attr-value', describe(el), `${attr} references missing id(s): ${missing.join(', ')}`);
        }
      }
    }

    // ── duplicate-id-aria ──────────────────────────────────────────────
    const referenced = new Set<string>();
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns']) {
      for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) {
        for (const id of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) referenced.add(id);
      }
    }
    for (const el of Array.from(document.querySelectorAll('label[for]'))) {
      const f = el.getAttribute('for');
      if (f) referenced.add(f);
    }
    for (const id of referenced) {
      const nodes = Array.from(document.querySelectorAll(`[id="${CSS.escape(id)}"]`));
      const n = nodes.length;
      if (n > 1 && !nodes.every(excluded)) {
        add('duplicate-id-aria', `#${id}`, `id is referenced by ARIA/label but appears ${n} times`);
      }
    }

    // ── tabindex ───────────────────────────────────────────────────────
    for (const el of all('[tabindex]')) {
      const t = Number(el.getAttribute('tabindex'));
      if (Number.isFinite(t) && t > 0) {
        add('tabindex', describe(el), `tabindex="${t}" — a positive tabindex reorders focus away from the DOM order`);
      }
    }

    return findings;
  }, { sel: normalized.root ?? null, excludeSel: normalized.exclude ?? null });
}

/** The set of rule ids present in a finding list, sorted — the shape the debt lists are compared against. */
export function violatedRules(findings: A11yFinding[]): string[] {
  return [...new Set(findings.map((f) => f.rule))].sort();
}

/** A readable failure body: every finding, grouped by rule. */
export function formatFindings(findings: A11yFinding[]): string {
  const byRule = new Map<string, A11yFinding[]>();
  for (const f of findings) {
    const list = byRule.get(f.rule) ?? [];
    list.push(f);
    byRule.set(f.rule, list);
  }
  return [...byRule.entries()]
    .map(([rule, list]) => `  ${rule} (${list.length})\n${list.map((f) => `    · ${f.target}\n      ${f.detail}`).join('\n')}`)
    .join('\n');
}
