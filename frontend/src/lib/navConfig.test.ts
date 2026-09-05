import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  PRIMARY_NAV,
  DASHBOARD_NAV,
  NUMBERS_TABS,
  ALL_NAV,
  MORE_NAV,
  NAV_SECTIONS,
  // NOTE: `NFT_FINANCE_LIVE` is deliberately NOT imported. Referencing the combined
  // gate is what made the old assertions tautological — they compared the nav array
  // against the constant that built it. The tests below pin the address-derived signal
  // instead, so flipping PROMOTE_PENDING can actually break them.
  NFT_FINANCE_ADDRESSES_LIVE,
  COMMUNITY_LIVE,
  COMMUNITY_ADDRESSES_LIVE,
} from './navConfig';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isIndexerConfigured } from './indexer/client';
import { loadLocalRules } from './alerts/ruleStore';
import { evaluableRuleKinds } from './alerts/sources';
import { PAYMENT_LINK_CHAIN_IDS } from './commerce/settleTokens';
import { deployedCurveChains } from './launcher/curveChains';
// The route table, which src/test/a11yRouteCoverage.test.ts holds equal to src/App.tsx.
// Used here as the already-verified answer to "is this path reachable by URL at all",
// so the assertions below can tell "routed but not promoted" apart from "not routed".
import { ROUTES } from '../../e2e/fixtures/routes';

// -- THE 2026-09-05 REWRITE ---------------------------------------------------
// The bar was Dashboard / Farm / Trade / NFT Finance, a right-aligned
// Marketplace, and a "More" dropdown holding five sections. It is six words
// DERIVED from NAV_SECTIONS -- Swap / Pools / Earn / Launch / Check / Island --
// plus Dashboard appended last and only when connected. There is no dropdown.
//
// Because PRIMARY_NAV is derived, the assertions below can no longer be the
// tautology this file has already been burned by twice (see the warning on the
// NFT-finance test): comparing a hand-written bar against the constant that
// built it. What is pinned instead is the RELATIONSHIP between the bar and the
// sections, plus the properties a rewrite breaks silently -- a destination with
// no path to it, or a word that opens a page highlighting nothing.

describe('navConfig', () => {
  it('PRIMARY_NAV has items with `to` and `label`', () => {
    expect(PRIMARY_NAV.length).toBeGreaterThan(0);
    for (const item of PRIMARY_NAV) {
      expect(item.to).toBeTruthy();
      expect(item.to.startsWith('/')).toBe(true);
      expect(item.label).toBeTruthy();
    }
  });

  it('is one word per section, in section order, and no more', () => {
    // SIX IS THE CEILING and it is a measured one, not a preference: the bar
    // shares an 800px row with the wordmark, the bungalow chip, Connect and the
    // theme toggle, and this repo has a documented 640-790px dead-band history
    // from letting that row overflow. headerFitsAtEveryWidth pins the geometry;
    // this pins the count that geometry was measured against.
    expect(PRIMARY_NAV).toHaveLength(NAV_SECTIONS.length);
    expect(PRIMARY_NAV.length).toBeLessThanOrEqual(6);
    expect(PRIMARY_NAV.map((n) => n.label)).toEqual(NAV_SECTIONS.map((s) => s.heading));
  });

  it('names the job, never the container -- the six words the operator asked for', () => {
    // The rename wave IS the change, so pinning the literal set is the only way
    // to stop it drifting back one word at a time: "Farm" was jargon and a
    // duplicate of the Earn group, "Trust & Safety" read as a policy page over
    // the venue's best differentiator, and "More" meant "we couldn't decide".
    expect(PRIMARY_NAV.map((n) => n.label)).toEqual([
      'Swap', 'Pools', 'Island', 'Launch', 'Earn', 'Check',
    ]);
    for (const dead of ['Farm', 'Trade', 'NFT Finance', 'More', 'Trust & Safety', 'Stats']) {
      expect(
        PRIMARY_NAV.map((n) => n.label),
        dead + ' came back to the top bar',
      ).not.toContain(dead);
    }
  });

  it('points every word at one of its own section destinations', () => {
    // `primaryTo` is an override for exactly one section (Swap, whose landing
    // follows the active bungalow's chain). An override pointing OUTSIDE its
    // section would open a page whose tab strip highlights nothing.
    for (const sec of NAV_SECTIONS) {
      const to = sec.primaryTo ?? sec.hub;
      expect(sec.items.map((i) => i.to), sec.heading + ' points outside itself').toContain(to);
    }
  });

  it('keeps Dashboard OUT of the bar -- it is empty until a wallet connects', () => {
    // It used to be the FIRST word. The operator's rule: the execution words
    // first, then "what is happening with your assets". TopNav appends it from
    // the connection state, so it must not also be a section.
    expect(PRIMARY_NAV.map((n) => n.to)).not.toContain('/dashboard');
    expect(DASHBOARD_NAV.to).toBe('/dashboard');
    expect(ALL_NAV.map((n) => n.to), 'still reachable, just not in the bar').toContain('/dashboard');
  });

  // ⚠️ 2026-08-12 — BOTH of these were TAUTOLOGIES. They read
  //   `expect(paths.includes('/nft-finance')).toBe(NFT_FINANCE_LIVE)`
  // i.e. they compared the nav array against the very constant that BUILT the
  // nav array (navConfig.ts spreads `NFT_FINANCE_LIVE ? [entry] : []`). Both
  // sides move together for ANY value of PROMOTE_PENDING, so the assertions
  // passed unconditionally and pinned nothing at all — including the fact that
  // /community is in the menu purely because of the override.
  //
  // Rewritten in the shape the /solana-launch test below already uses: pin the
  // PRECONDITION as a concrete fact read out of constants.ts, then pin the
  // concrete value that must follow from it. Neither assertion mentions the
  // combined gate, so flipping PROMOTE_PENDING can (and for Community, does)
  // break them.

  it('NFT Finance is in the primary nav on the strength of its OWN addresses', () => {
    // CREDIBILITY GATING (2026-06-09): a top-nav item whose every tab ends in
    // "Contract Not Deployed" leaks trust. NFT finance has since earned its
    // slot honestly — three of its four relaunch addresses are real in
    // constants.ts, so the address-derived signal alone is already true and
    // PROMOTE_PENDING is redundant here. Pin that, so zeroing those addresses
    // (a real regression) fails loudly instead of hiding behind the override.
    expect(
      NFT_FINANCE_ADDRESSES_LIVE,
      'an nft-finance address must be deployed in constants.ts for this entry to be honest',
    ).toBe(true);
    // 2026-09-05: it left the TOP BAR (where it was labelled "NFT Finance", a
    // category rather than a job) for the Earn section, where borrowing against
    // an asset you hold belongs. "Promoted" is what this test was ever about;
    // which row carries it is presentation.
    expect(MORE_NAV.map((n) => n.to)).toContain('/nft-finance');
    expect(ALL_NAV.find((n) => n.to === '/nft-finance')?.label).toBe('Borrow on NFTs');
  });

  it('Community is in the More menu ONLY because PROMOTE_PENDING forces it', () => {
    // The governance contracts ARE deployed and unpaused on mainnet, but their
    // constants.ts entries are still 0x0 — a UI wiring gate. So the
    // address-derived signal is false and the override is the sole reason
    // /community is promoted. Pin BOTH halves: the precondition (nothing wired)
    // and the outcome (entry present anyway). Turn PROMOTE_PENDING off and
    // COMMUNITY_LIVE collapses to false, the entry disappears, and the last two
    // assertions fail — which is the whole point.
    expect(
      COMMUNITY_ADDRESSES_LIVE,
      'no governance address is wired in constants.ts yet',
    ).toBe(false);
    expect(
      COMMUNITY_LIVE,
      'Community is promoted, so something other than the addresses is carrying it',
    ).toBe(true);
    expect(MORE_NAV.map((n) => n.to)).toContain('/community');
  });

  it('files the art Marketplace on the Island, not beside the token swap', () => {
    // It had its own right-aligned header slot until 2026-09-05, next to
    // "Trade" -- and the operator's reading was that "Trade" and "Marketplace"
    // gave no clue which one sold tokens and which sold art. It is an island
    // surface. The route is unchanged.
    const island = NAV_SECTIONS.find((sec) => sec.heading === 'Island');
    expect(island?.items.map((i) => i.to)).toContain('/nakamigos');
    expect(ALL_NAV.find((n) => n.to === '/nakamigos')?.label).toBe('Marketplace');
  });

  it('ALL_NAV is a superset of PRIMARY_NAV', () => {
    const allPaths = ALL_NAV.map((n) => n.to);
    for (const item of PRIMARY_NAV) {
      expect(allPaths).toContain(item.to);
    }
  });

  // The three detection surfaces are the protocol's one genuine differentiator and work
  // on ANY token/wallet. Under the old generic "Stats" heading (beside Tokenomics and
  // Treasury) they read as protocol vanity metrics. Pin the named grouping + the hub so
  // a future nav edit can't quietly bury them again.
  it('puts the detection tools in the TOP BAR, under the word "Check"', () => {
    // 2026-09-05, and this is the single biggest win in the rewrite. They sat
    // under "Trust & Safety" -- content-moderation language, which reads as a
    // policy page of terms and reporting -- inside a dropdown called "More".
    // Two clicks and the most boring label on the site, over the venue's one
    // genuine differentiator. "Check" is what a visitor is here to do.
    const check = NAV_SECTIONS.find((sec) => sec.heading === 'Check');
    expect(check, 'the Check section is gone').toBeDefined();
    expect(PRIMARY_NAV.map((n) => n.label)).toContain('Check');
    const paths = check!.items.map((i) => i.to);
    expect(paths).toContain('/trust');
    expect(paths).toContain('/scan');
    expect(paths).toContain('/deployer');
    expect(paths).toContain('/exposure');
    // The old heading must not come back on any section.
    expect(NAV_SECTIONS.map((sec) => sec.heading)).not.toContain('Trust & Safety');
  });

  it('no duplicate paths in ALL_NAV', () => {
    const paths = ALL_NAV.map((n) => n.to);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });

  // The "Soon" pill answers one question for a visitor: can I do the thing this
  // entry names? The lesson that produced that rule is worth keeping even though the
  // rail that taught it is gone: /solana-launch was once `soon: !isSolanaLauncherEnabled()`,
  // and with the flag on and no signer the pill cleared while the nav advertised a
  // launch surface that could not launch. Every pill below is keyed to a condition
  // that would actually stop a user, never to a flag.
  // REPLACED 2026-08-23. This asserted /solana-launch was PRESENT and pilled Soon.
  // That rail (Meteora DBC) is retired — it graduated into a pool this protocol does
  // not own. The assertion now runs the other way: the entry must be ABSENT.
  //
  // Kept as a test rather than deleted, because "the nav no longer offers a retired
  // rail" is exactly the kind of property that silently regresses when someone
  // restores a route and adds its nav entry back out of habit.
  it('does not offer the retired /solana-launch rail', () => {
    expect(
      ALL_NAV.find((n) => n.to === '/solana-launch'),
      'the Meteora DBC rail was retired 2026-08-23 — its nav entry must not come back',
    ).toBeUndefined();
  });

  // /curve-launch is the OWN-curve page and stays pilled unconditionally: its program
  // is not deployed on any cluster, so no flag or config can make it launchable.
  it('keeps /curve-launch pilled — its program is not deployed anywhere', () => {
    const entry = ALL_NAV.find((n) => n.to === '/curve-launch');
    expect(entry, '/curve-launch missing from nav').toBeTruthy();
    expect(entry?.soon).toBe(true);
  });

  // Alerts sits with the detection tools because its rule kinds watch exactly what those
  // tools read on demand, on any token, wallet or pool.
  it('promotes /alerts under Check, unpilled because the store is server-free', () => {
    const trust = NAV_SECTIONS.find((sec) => sec.heading === 'Check');
    expect(trust?.items.map((i) => i.to)).toContain('/alerts');

    const entry = ALL_NAV.find((n) => n.to === '/alerts');
    expect(entry?.label).toBe('Alerts');
    expect(entry?.soon, 'a store that needs nothing must not read as unavailable').toBeFalsy();
  });

  // The PRECONDITION, not the conclusion. The entry above is unpilled because the rule
  // store is provably local: if someone gives it a server dependency, this fails first
  // and the nav comment that cites it has to be re-read before the pill can stay off.
  it('the alert rule store reaches no network, in source and at runtime', () => {
    // Resolved from THIS file's own URL, not from the runner's cwd: a relative path
    // here silently reads nothing when vitest is invoked from another directory, and a
    // guard that reads nothing passes forever.
    const storePath = join(dirname(fileURLToPath(import.meta.url)), 'alerts', 'ruleStore.ts');
    const source = readFileSync(storePath, 'utf8');
    // A guard that reads nothing passes forever, so prove the read landed before
    // asserting anything about the contents.
    expect(source.length, 'the rule store source could not be read').toBeGreaterThan(500);
    expect(source, 'not the module this guard thinks it is').toContain('loadLocalRules');
    expect(
      source.includes('fetch('),
      'a browser-local store must not fetch - see the /alerts comment in navConfig.ts',
    ).toBe(false);
    expect(source, 'rulesClient is the SERVER store — the local one must not use it').not.toContain(
      './rulesClient',
    );

    vi.stubGlobal('fetch', () => {
      throw new Error('the rule store must not make a request');
    });
    try {
      expect(loadLocalRules()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('at least one alert rule kind is readable with no indexer configured', () => {
    // If a shipped source is ever made configurable, THIS fails and the /alerts
    // comment tells you what to do about the pill.
    expect(evaluableRuleKinds().length).toBeGreaterThan(0);
  });

  // Checkout was pilled for the /alerts reason — a migration applied by hand — until the
  // invoice became a merchant-signed document carried in the URL fragment. It now has the
  // /referrals shape instead: the advertised action completes in the browser, and the one
  // input that could make it impossible is client-readable.
  it('promotes /checkout in the More menu, unpilled because a link can be minted and paid here', () => {
    // Heading-agnostic on purpose. This assertion is about the entry being
    // PROMOTED and UNPILLED; which section it sits in is presentation. It named
    // 'Engage' until 2026-09-03, when that 14-item catch-all was split into
    // Discover / Trade / Launch / Earn — a regrouping this test had no business
    // failing on, since nothing about /checkout changed.
    const sections = NAV_SECTIONS.filter((sec) => sec.items.some((i) => i.to === '/checkout'));
    expect(sections, '/checkout must be promoted in exactly one section').toHaveLength(1);

    const entry = ALL_NAV.find((n) => n.to === '/checkout');
    expect(entry?.label).toBe('Checkout');

    // THE PRECONDITION, ASSERTED FIRST AND ON PURPOSE. The pill is keyed to the
    // settle-token table, not to CONFIGURED_CHAIN_IDS (which viemChains.ts makes
    // non-empty by construction). Emptying the table must fail HERE — naming the real
    // cause — rather than surfacing as a confusing pill assertion two lines down.
    expect(
      PAYMENT_LINK_CHAIN_IDS,
      'no served chain has a verified settlement asset, so nothing can be minted or paid',
    ).toContain(1);

    expect(entry?.soon, 'a checkout that can mint and pay a link must not read as SOON').toBe(false);
  });

  // Tax Reports is NOT keyed to the indexer any more: it reads Ethereum-mainnet history
  // through /api/etherscan, which ships with every deployment. Asserted as a CONCRETE
  // value — comparing against `!isIndexerConfigured()` would compare the entry with
  // itself — plus the independence claim, which is the part that would rot silently.
  it('does not pill /tax: its rail ships with the deployment, and the key is disclosed on the page', () => {
    // 2026-09-05: /tax left ALL_NAV for NUMBERS_TABS. It is a TAB of StatsPage,
    // and the nav lists a tabbed host once at its landing tab -- the convention
    // ActivityPage and InfoPage already follow. The pill is guarded here rather
    // than in a page test because it is the only pill on any of the three, and
    // this file is where the rule about pills is written.
    const entry = NUMBERS_TABS.find((n) => n.to === '/tax');
    expect(entry?.label).toBe('Tax Reports');
    expect(entry?.soon, 'the explorer rail ships with every deployment').toBe(false);
    // Independence: an indexer appearing or disappearing must not move this pill.
    // (lib/tax/rails.test.ts pins the rail itself; TaxPage.test.tsx pins the
    // ETHERSCAN_API_KEY disclosure that makes an unpilled entry honest.)
    expect(isIndexerConfigured()).toBe(false);
    // It is a personal accounting surface over the caller's own history, not one
    // of the detection tools that work on any address -- so it must never drift
    // into Check.
    const check = NAV_SECTIONS.find((sec) => sec.heading === 'Check');
    expect(check?.items.map((i) => i.to)).not.toContain('/tax');
  });

  it('opens the three numbers tabs from ONE Island row, and keeps them in step', () => {
    // Island carries "Treasury & numbers" -> /tokenomics, and StatsPage hosts
    // all three. The row and the host must agree about which tab is the landing
    // one, or the word opens a page highlighting something else.
    const island = NAV_SECTIONS.find((sec) => sec.heading === 'Island');
    const row = island?.items.find((i) => i.to === '/tokenomics');
    expect(row?.label, 'the operator asked "stats about what?" -- name the subject').toBe(
      'Treasury & numbers',
    );
    expect(NUMBERS_TABS[0]?.to, 'StatsPage lands on items[0]').toBe('/tokenomics');
    expect(NUMBERS_TABS.map((n) => n.to)).toEqual(['/tokenomics', '/treasury', '/tax']);
    // The siblings are deliberately NOT promoted twice.
    for (const p of ['/treasury', '/tax']) {
      expect(MORE_NAV.map((n) => n.to), p + ' is listed as well as being a tab').not.toContain(p);
    }
  });

  // ⚠️ THE DELIBERATE OMISSION. /airdrop and /vesting are routed and fully rendered, and
  // they are NOT promoted: every rail behind them (AirdropFactory, VestingFactory,
  // LaunchLockView) is undeployed, and pages/airdropVestingHonesty.test.ts pins that as a
  // fact read out of constants.ts. Reachable-by-URL-only is the state a surface earns while
  // 100% dark — the same CREDIBILITY GATING rule at the top of navConfig.ts — so promoting
  // either one is a deliberate act that has to delete this test first.
  // ───────────── THE 2026-09-04 CONDENSATION ─────────────
  // The dropdown listed twenty-one rows under six headings. Four sections now
  // carry a `hub` and render as ONE row each, their items becoming the tab strip
  // on the page that row opens. These pin the properties that make that safe;
  // every one of them fails on the pre-change file, where no section had a hub.

  it('opens every section on its own first tab', () => {
    expect(NAV_SECTIONS.map((sec) => sec.heading)).toEqual([
      'Swap', 'Pools', 'Island', 'Launch', 'Earn', 'Check',
    ]);
    for (const s of NAV_SECTIONS) {
      // SectionHost lands on items[0]. A hub pointing anywhere else opens the
      // page with a tab highlighted that the visitor did not click.
      expect(s.hub, s.heading + ' hub must be its own first item').toBe(s.items[0]?.to);
    }
  });

  it('gives every section a tab strip that fits and has no two tabs alike', () => {
    for (const s of NAV_SECTIONS) {
      const shown = s.items.map((i) => i.tabLabel ?? i.label);
      for (const t of shown) {
        expect(t.length, `"${t}" is too long for a tab in the ${s.heading} strip`).toBeLessThanOrEqual(20);
        expect(t.length).toBeGreaterThan(0);
      }
      // Two tabs reading the same thing is unusable, and it is exactly what a
      // careless `tabLabel` produces — "Memetics Curve" on both curve entries,
      // say. `label` disambiguates them; the shorthand has to as well.
      expect(new Set(shown).size, `duplicate tab labels in the ${s.heading} strip`).toBe(shown.length);
    }
  });

  // `tabLabel` is a display shorthand for the tab strip and must never be
  // mistaken for a rename: `label` is the canonical name, and e2e specs plus
  // lib/yield/surface.test.ts pin it.
  it('never lets a tabLabel replace the canonical label', () => {
    for (const item of MORE_NAV) {
      expect(item.label.length, `${item.to} has no canonical label`).toBeGreaterThan(0);
      if (item.tabLabel !== undefined) {
        expect(item.tabLabel, `${item.to}'s tabLabel just restates its label`).not.toBe(item.label);
      }
    }
  });

  // THE FINDABILITY BUG, 2026-09-04. This entry read 'Memetics Curve (EVM)' with
  // `soon`/`live` keyed to the MAINNET address alone, while the launcher has been
  // live on Base and Robinhood Chain since 2026-08-25. "(EVM)" is not a string
  // anyone hunting for the Robinhood launcher would type, and the operator's
  // report was exactly that: they could not find it.
  it('names every chain the curve is deployed on, so each launcher is findable by name', () => {
    const chains = deployedCurveChains();
    // PRECONDITIONS FIRST, so removing a deployment fails here — naming the real
    // cause — instead of surfacing as a confusing label assertion below.
    expect(
      chains.map((c) => c.chainId),
      'the curve rail must still be deployed on Robinhood Chain (4663) for this entry to name it',
    ).toContain(4663);
    expect(chains.length, 'a single-chain rail has nothing to enumerate').toBeGreaterThan(1);

    const entry = ALL_NAV.find((n) => n.to === '/eth-curve');
    for (const c of chains) {
      expect(entry?.label, `the menu never names the ${c.name} launcher`).toContain(c.name);
    }
  });

  it('pills /eth-curve on whether the curve launches ANYWHERE, not just on mainnet', () => {
    const chains = deployedCurveChains();
    const entry = ALL_NAV.find((n) => n.to === '/eth-curve');
    expect(entry?.live, 'a launcher that launches must not be missing its LIVE pill').toBe(true);
    expect(entry?.soon, 'a launcher that launches must never read as SOON').toBe(false);

    // ⚠️ THE TWO ASSERTIONS ABOVE DO NOT, ON THEIR OWN, PROVE THE FIX. The old
    // expression was `isDeployed(CURVE_LAUNCHER_ADDRESS)` — mainnet alone — and
    // mainnet IS deployed today, so both of them passed before this change and
    // would pass again if someone reverted it. They pin the OUTCOME; what
    // follows pins the INPUT, which is the part that was wrong.
    const nonMainnet = chains.filter((c) => c.chainId !== 1);
    expect(
      nonMainnet.map((c) => c.chainId),
      'precondition: the curve must be live somewhere other than mainnet for this to mean anything',
    ).toContain(4663);

    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'navConfig.ts'), 'utf8');
    expect(source.length, 'navConfig.ts could not be read').toBeGreaterThan(1000);
    const start = source.indexOf("to: '/eth-curve'");
    expect(start, "the /eth-curve entry is not where this guard looks").toBeGreaterThan(-1);
    const entrySource = source.slice(start, source.indexOf('},', start));
    expect(entrySource, 'the pill must read the registry, not one chain').toContain('isCurveLive()');
    expect(
      entrySource,
      'a mainnet-only address cannot answer "can I launch?" for a three-chain rail',
    ).not.toContain('CURVE_LAUNCHER_ADDRESS');
  });

  it('leaves /airdrop and /vesting reachable by URL but out of the nav', () => {
    const routed = ROUTES.map((r) => r.path);
    const promoted = ALL_NAV.map((n) => n.to);
    for (const path of ['/airdrop', '/vesting']) {
      expect(routed, `${path} must stay reachable by URL`).toContain(path);
      expect(promoted, `${path}'s rails are undeployed — it must not be promoted`).not.toContain(path);
    }
  });
});

/**
 * TRADE_ROUTE — which swap surface "Trade" lands on.
 *
 * The venue has two, and the nav hardcoded the Ethereum one. Standing in a
 * Solana bungalow (BAYLA) and clicking Trade therefore opened a swap that
 * cannot touch the token whose page you were on. These pin the default per
 * chain; ChainSwitch.test.tsx pins that the other surface stays one click
 * away, so the default is never a trap.
 *
 * Resolved at module scope, so each case has to re-import the module with the
 * bungalow already persisted — exactly how the app sees it after a reload.
 */
describe('TRADE_ROUTE', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  async function loadWithBungalow(id: string | null) {
    window.localStorage.clear();
    if (id) window.localStorage.setItem('tegridy-bungalow', id);
    vi.resetModules();
    return import('./navConfig');
  }

  it('is the Ethereum swap by default', async () => {
    const nav = await loadWithBungalow(null);
    expect(nav.TRADE_ROUTE).toBe('/swap');
    expect(nav.PRIMARY_NAV.find((n) => n.label === 'Swap')?.to).toBe('/swap');
  });

  it('is the Ethereum swap in the classic TOWELI bungalow', async () => {
    const nav = await loadWithBungalow('toweli');
    expect(nav.TRADE_ROUTE).toBe('/swap');
  });

  it('is the Solana swap inside a Solana bungalow', async () => {
    const nav = await loadWithBungalow('bayla');
    expect(nav.TRADE_ROUTE).toBe('/solana');
    expect(nav.PRIMARY_NAV.find((n) => n.label === 'Swap')?.to).toBe('/solana');
  });
});
