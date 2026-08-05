import { describe, it, expect } from 'vitest';
import { PRIMARY_NAV, POINTS_NAV, ALL_NAV, MORE_NAV, MORE_NAV_SECTIONS, NFT_FINANCE_LIVE, COMMUNITY_LIVE } from './navConfig';
import { isSolanaSubmitReady } from './launcher/solana/dbc';

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

  it('NFT Finance is promoted in primary nav ONLY when a contract is live', () => {
    // CREDIBILITY GATING (2026-06-09): a top-nav item whose every tab ends
    // in "Contract Not Deployed" leaks trust. The entry returns automatically
    // when any nft-finance relaunch address lands in constants.ts.
    const paths = PRIMARY_NAV.map((n) => n.to);
    expect(paths.includes('/nft-finance')).toBe(NFT_FINANCE_LIVE);
  });

  it('Community appears in the More menu ONLY when a governance contract is live', () => {
    const morePaths = MORE_NAV.map((n) => n.to);
    expect(morePaths.includes('/community')).toBe(COMMUNITY_LIVE);
  });

  it('POINTS_NAV is the right-aligned promoted action (Tradermigos)', () => {
    // Previously the right-aligned slot was Points; Tradermigos was swapped
    // in from the "More" dropdown so the art marketplace gets top-bar prominence.
    expect(POINTS_NAV.to).toBe('/nakamigos');
    expect(POINTS_NAV.label).toBe('Tradermigos');
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
  // entry names? /solana-launch was `soon: !isSolanaLauncherEnabled()` — with the
  // flag on and no signer, the pill cleared and the nav advertised a launch surface
  // that could not launch. It was then pilled unconditionally, with the standing
  // instruction to unpill it only when a submit path actually shipped.
  //
  // 🔄 2026-08-04 — it shipped. The pill now tracks `isSolanaSubmitReady()`, which is
  // the feature flag AND a published live config, so the nav and the submit button
  // read the SAME condition and cannot disagree.
  it('pills /solana-launch exactly when it cannot actually launch', () => {
    // Asserted as a CONCRETE value, not as `!isSolanaSubmitReady()`. Comparing the
    // pill to the same function navConfig calls is a tautology — it passes for any
    // implementation, including a hardcoded `soon: true`. So pin the precondition
    // (no VITE_SOLANA_DBC_CONFIG in this environment, so the rail cannot launch)
    // and then pin the value that must follow from it. If someone ever publishes a
    // config into the test environment, the first assertion fails loudly and forces
    // this test to be re-read rather than silently inverting.
    expect(isSolanaSubmitReady(), 'no live config should be published in tests').toBe(false);
    const entry = ALL_NAV.find((n) => n.to === '/solana-launch');
    expect(entry, '/solana-launch missing from nav').toBeTruthy();
    expect(entry?.soon, 'unlaunchable rail must stay pilled Soon').toBe(true);
  });

  // /curve-launch is the OWN-curve page and stays pilled unconditionally: its program
  // is not deployed on any cluster, so no flag or config can make it launchable.
  it('keeps /curve-launch pilled — its program is not deployed anywhere', () => {
    const entry = ALL_NAV.find((n) => n.to === '/curve-launch');
    expect(entry, '/curve-launch missing from nav').toBeTruthy();
    expect(entry?.soon).toBe(true);
  });
});
