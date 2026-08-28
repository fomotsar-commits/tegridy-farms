// GHOST-CODE GUARD, COMPONENT TIER.
//
// The sibling guard at src/hooks/hooksAreMounted.test.ts exists because
// `useAutoRefreshBoost` was written in April, announced in the changelog, and
// imported by nothing until August. Components had no such guard, and the same
// thing happened one level up: `FactSheetPricing.tsx` is 89 lines, fully
// written and fully tested, and the only module that imports it is its own test
// file. Every test was green the whole time — a component nobody mounts is a
// component nobody's tests exercise either, except its own.
//
// The rule this pins: a file under src/components is either REACHABLE from the
// app, or it is listed below with the boundary that stops it. Deleting it is
// also a legitimate way to make this pass — an unreachable component nobody
// will claim is dead weight, not an asset.
//
// This checks REACHABILITY, not correctness. Being reachable proves only that
// the code can run; whether it runs correctly is what each component's own test
// file is for, and this guard is worthless without those.
//
// ── WHY THIS IS NOT A COPY OF THE HOOKS GUARD ──────────────────────────────
//
// The hooks guard matches `from '…/<Name>'` by EXPORT NAME. That works there
// only because every hook file is named after its single export. Components are
// not, and porting the regex naively is worthless:
//
//   1. Dynamic imports are invisible to it. `App.tsx` mounts OnboardingFlow,
//      ZapPage and ChartPage via `lazy(() => import('…'))`, and LendingPage
//      mounts LendingSection via
//      `lazy(() => import('../components/nftfinance/LendingSection')
//         .then(mod => ({ default: mod.LendingSection })))`.
//      A `from '…'` matcher reports every one of them as an orphan.
//   2. Symbol matching breaks on named-export destructuring off a lazy import
//      and on barrel re-exports.
//
// So this resolves module PATHS and walks a real reachability graph from the
// app's entry points. A first pass built on symbol names reported all 169
// components as orphans; a second reported 16; the truth was 2. A guard that
// ships with false positives grows an exemption list until it guards nothing.
//
// WHAT THIS DOES NOT CATCH, STATED PLAINLY: it measures IMPORT reachability, so a
// component that is imported and then never rendered still reads as mounted. That
// gap is covered by a different gate — `@typescript-eslint/no-unused-vars` is an
// ERROR in this repo's eslint config, so an import with no use fails lint. The two
// together are what close it; neither does alone, and this file should not be
// mistaken for the whole guarantee.
//
// A TEST-ONLY IMPORTER DOES NOT COUNT. Test files are excluded from the graph
// entirely, which is the whole point: FactSheetPricing is imported by exactly
// one module and that module is `FactSheetPricing.test.tsx`.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');
const COMPONENTS = join(SRC, 'components');

/**
 * Components deliberately not mounted, each with the boundary that stops it.
 * A regex, so a family can be exempted by the reason they share rather than by
 * name-by-name churn.
 *
 * Adding an entry here is a claim someone can check. Adding one without a real
 * boundary is how the thing this file exists to prevent comes back.
 */
const UNMOUNTED_BY_DESIGN: Array<{ pattern: RegExp; because: string }> = [
  {
    pattern: /^positionMarket\//,
    because:
      'The staking-position market is deploy-gated: src/lib/constants.ts documents that ' +
      'components/positionMarket gates on isDeployed(), and POSITION_MARKET_ADDRESS is the ' +
      'zero address on every network today. Mounting the panel would render an ' +
      'unconditional not-deployed state. Delete this entry the moment an address lands.',
  },
  {
    pattern: /^launcher\/FactSheetPricing\.tsx$/,
    because:
      'There is no per-launch fact-sheet DETAIL surface to mount it on. The disclosure it ' +
      'renders is real and is produced today (lib/launcher/collector.ts builds it, ' +
      'lib/launcher/attestation.ts:208 attests it), but the only launcher surface that ships is ' +
      'LaunchExplorer, which renders a LIST from launches/outcomes and never a single sheet. ' +
      'Mounting this is a feature, not a wire-up. Delete this entry when a sheet surface lands — ' +
      'the test below fails the moment anything reaches it.',
  },
];

const isTest = (p: string) => /\.(test|spec)\.[tj]sx?$/.test(p);
const isSource = (p: string) => /\.[tj]sx?$/.test(p) && !/\.d\.ts$/.test(p);

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (isSource(p) && !isTest(p)) acc.push(p);
  }
  return acc;
}

const allSources = walk(SRC);

/**
 * Every import specifier in a file — STATIC and DYNAMIC.
 *
 * Missing the second form is the entire bug this guard had to avoid: the app's
 * route-level code splitting means most page-level components are reached only
 * through `import(...)`.
 */
function specifiersIn(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g, // import X from '…'  /  export … from '…'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('…')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('…')
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) out.push(m[1]);
  }
  return out;
}

/** Resolve a specifier to a real file on disk, the way the bundler would. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else if (spec.startsWith('@/')) base = resolve(SRC, spec.slice(2));
  else if (spec.startsWith('src/')) base = resolve(SRC, spec.slice(4));
  else return null; // a bare package specifier — not our code

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.js'),
    join(base, 'index.jsx'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

// ── The reachability graph ──────────────────────────────────────────────────
//
// Roots are the app's real entry points. Anything the bundler cannot reach from
// one of these is not in the shipped app, however well-tested it is.
const ROOTS = allSources.filter(
  (f) => f === join(SRC, 'App.tsx') || f === join(SRC, 'main.tsx') || f.startsWith(join(SRC, 'pages') + sep),
);

const edges = new Map<string, string[]>();
for (const f of allSources) {
  const resolved: string[] = [];
  for (const spec of specifiersIn(readFileSync(f, 'utf-8'))) {
    const target = resolveSpecifier(f, spec);
    if (target && !isTest(target)) resolved.push(target);
  }
  edges.set(f, resolved);
}

const reachable = new Set<string>();
{
  const queue = [...ROOTS];
  for (const r of ROOTS) reachable.add(r);
  while (queue.length) {
    const cur = queue.pop() as string;
    for (const next of edges.get(cur) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
}

const componentFiles = allSources.filter((f) => f.startsWith(COMPONENTS + sep));
const rel = (f: string) => relative(COMPONENTS, f).split(sep).join('/');

describe('every component is reachable from the app, or says why not', () => {
  // Three gates in this repo have shipped that could not fail. These two
  // assertions are what stop this one joining them: an empty component list or
  // an empty root list would make every check below pass over nothing.
  it('found the components directory — a zero-length list would pass vacuously', () => {
    expect(componentFiles.length).toBeGreaterThan(100);
  });

  it('found the app entry points — with no roots, nothing is reachable and everything is a ghost', () => {
    expect(ROOTS.length).toBeGreaterThan(20);
    expect(ROOTS).toContain(join(SRC, 'App.tsx'));
  });

  it('resolves DYNAMIC imports — the lazy-mounted set must not read as orphaned', () => {
    // These are mounted exclusively through `lazy(() => import('…'))`. If the
    // specifier matcher ever regresses to static-only, every one of them turns
    // into a false positive and the exemption list starts growing.
    const lazilyMounted = [
      join(COMPONENTS, 'nftfinance', 'LendingSection.tsx'),
      join(COMPONENTS, 'onboarding', 'OnboardingFlow.tsx'),
    ].filter((f) => existsSync(f));

    expect(lazilyMounted.length).toBeGreaterThan(0);
    for (const f of lazilyMounted) {
      expect(reachable.has(f), `${rel(f)} is lazily mounted but read as unreachable`).toBe(true);
    }
  });

  it('every component is reachable, exempt, or a ghost that must be named here', () => {
    const ghosts = componentFiles
      .filter((f) => !reachable.has(f))
      .filter((f) => !UNMOUNTED_BY_DESIGN.some((e) => e.pattern.test(rel(f))))
      .map(rel)
      .sort();

    expect(
      ghosts,
      'Unreachable from src/App.tsx, src/main.tsx or any page — so it is not in the shipped app. ' +
        'Mount it, delete it, or add it to UNMOUNTED_BY_DESIGN with the boundary that stops it. ' +
        'Being imported only by its own test file counts as unreachable, and is the exact shape ' +
        'this guard was written for.',
    ).toEqual([]);
  });

  for (const exemption of UNMOUNTED_BY_DESIGN) {
    it(`the "${exemption.pattern.source}" exemption is still true`, () => {
      const matching = componentFiles.filter((f) => exemption.pattern.test(rel(f)));

      // An exemption naming nothing is stale — the files were deleted or moved,
      // and the entry now documents a boundary that no longer exists.
      expect(matching.length, `exemption "${exemption.pattern.source}" matches no component`).toBeGreaterThan(0);

      // An exemption is not a licence to stay dark forever. If the app reaches
      // it now, it SHIPPED, and the exemption is the stale thing.
      const nowReachable = matching.filter((f) => reachable.has(f)).map(rel);
      expect(
        nowReachable,
        `now reachable from the app, so the exemption is stale — delete the entry. Reason on file: ${exemption.because}`,
      ).toEqual([]);
    });
  }
});
