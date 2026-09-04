import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  PRIMARY_NAV,
  POINTS_NAV,
  ALL_NAV,
  MORE_NAV,
  MORE_NAV_SECTIONS,
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
// The route table, which src/test/a11yRouteCoverage.test.ts holds equal to src/App.tsx.
// Used here as the already-verified answer to "is this path reachable by URL at all",
// so the assertions below can tell "routed but not promoted" apart from "not routed".
import { ROUTES } from '../../e2e/fixtures/routes';

// Session 1 consolidated the navigation from 21 routes to a tight primary set.
// MORE_PATHS was removed; MORE_NAV is the flattened "More" destinations and
// ALL_NAV is PRIMARY_NAV + the right-aligned Tradermigos action + MORE_NAV.
// This test asserts the post-consolidation shape.

describe('navConfig', () => {
  it('PRIMARY_NAV has items with `to` and `label`', () => {
    expect(PRIMARY_NAV.length).toBeGreaterThan(0);
    for (const item of PRIMARY_NAV) {
      expect(item.to).toBeTruthy();
      expect(item.to.startsWith('/')).toBe(true);
      expect(item.label).toBeTruthy();
    }
  });

  it('PRIMARY_NAV is the agreed tight consolidation', () => {
    // Keep the top-nav tight. If this ever exceeds 5, revisit the IA
    // consolidation rationale in the session-1 battle plan before
    // relaxing the assertion.
    expect(PRIMARY_NAV.length).toBeLessThanOrEqual(5);
    const paths = PRIMARY_NAV.map((n) => n.to);
    // Spot-check the core surfaces actually exist in the primary set.
    expect(paths).toContain('/dashboard');
    expect(paths).toContain('/farm');
    expect(paths).toContain('/swap');
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
    expect(PRIMARY_NAV.map((n) => n.to)).toContain('/nft-finance');
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

  it('POINTS_NAV is the right-aligned promoted action (Marketplace)', () => {
    // Previously the right-aligned slot was Points; Tradermigos was swapped
    // in from the "More" dropdown so the art marketplace gets top-bar prominence.
    expect(POINTS_NAV.to).toBe('/nakamigos');
    // Owner call 2026-08-31: the slot reads Marketplace now — the route is
    // unchanged (/nakamigos); only the label the visitor sees moved.
    expect(POINTS_NAV.label).toBe('Marketplace');
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
  it('the trust tools live under their own "Trust & Safety" heading, with the /trust hub', () => {
    const trust = MORE_NAV_SECTIONS.find((s) => s.heading === 'Trust & Safety');
    expect(trust).toBeDefined();
    const paths = trust!.items.map((i) => i.to);
    expect(paths).toContain('/trust');
    expect(paths).toContain('/scan');
    expect(paths).toContain('/deployer');
    expect(paths).toContain('/exposure');
    // and they are NOT left behind in the generic Stats bucket
    const stats = MORE_NAV_SECTIONS.find((s) => s.heading === 'Stats');
    for (const p of ['/scan', '/deployer', '/exposure']) {
      expect(stats?.items.map((i) => i.to) ?? []).not.toContain(p);
    }
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
  it('promotes /alerts under Trust & Safety, unpilled because the store is server-free', () => {
    const trust = MORE_NAV_SECTIONS.find((s) => s.heading === 'Trust & Safety');
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
  it('promotes /checkout under Engage, unpilled because a link can be minted and paid here', () => {
    const engage = MORE_NAV_SECTIONS.find((s) => s.heading === 'Engage');
    expect(engage?.items.map((i) => i.to)).toContain('/checkout');

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
    const entry = ALL_NAV.find((n) => n.to === '/tax');
    expect(entry?.label).toBe('Tax Reports');
    expect(entry?.soon, 'the explorer rail ships with every deployment').toBe(false);
    // Independence: an indexer appearing or disappearing must not move this pill.
    // (lib/tax/rails.test.ts pins the rail itself; TaxPage.test.tsx pins the
    // ETHERSCAN_API_KEY disclosure that makes an unpilled entry honest.)
    expect(isIndexerConfigured()).toBe(false);
    // It lives under Stats, not Trust & Safety: it is a personal accounting surface over
    // the caller's own history, not one of the detection tools that work on any address.
    const stats = MORE_NAV_SECTIONS.find((s) => s.heading === 'Stats');
    expect(stats?.items.map((i) => i.to)).toContain('/tax');
  });

  // ⚠️ THE DELIBERATE OMISSION. /airdrop and /vesting are routed and fully rendered, and
  // they are NOT promoted: every rail behind them (AirdropFactory, VestingFactory,
  // LaunchLockView) is undeployed, and pages/airdropVestingHonesty.test.ts pins that as a
  // fact read out of constants.ts. Reachable-by-URL-only is the state a surface earns while
  // 100% dark — the same CREDIBILITY GATING rule at the top of navConfig.ts — so promoting
  // either one is a deliberate act that has to delete this test first.
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
    expect(nav.PRIMARY_NAV.find((n) => n.label === 'Trade')?.to).toBe('/swap');
  });

  it('is the Ethereum swap in the classic TOWELI bungalow', async () => {
    const nav = await loadWithBungalow('toweli');
    expect(nav.TRADE_ROUTE).toBe('/swap');
  });

  it('is the Solana swap inside a Solana bungalow', async () => {
    const nav = await loadWithBungalow('bayla');
    expect(nav.TRADE_ROUTE).toBe('/solana');
    expect(nav.PRIMARY_NAV.find((n) => n.label === 'Trade')?.to).toBe('/solana');
  });
});
