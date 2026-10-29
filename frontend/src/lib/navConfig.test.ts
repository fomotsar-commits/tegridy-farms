import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  BAR_NAV,
  DRAWER_SECTIONS,
  DRAWER_LINKS,
  DASHBOARD_NAV,
  NUMBERS_TABS,
  ALL_NAV,
  MORE_NAV,
  NAV_SECTIONS,
  POOLS_SECTION,
  // Not NFT_FINANCE_LIVE: comparing the nav against the gate that built it is a tautology.
  // The address-derived halves below can fail when PROMOTE_PENDING moves.
  NFT_FINANCE_ADDRESSES_LIVE,
  COMMUNITY_LIVE,
  COMMUNITY_ADDRESSES_LIVE,
  tradeRoute,
  lockRoute,
  poolsRoute,
  islandRoute,
  litWord,
  INDEX_GROUPS,
  INDEX_PAGES,
  indexName,
  ISLAND_SECTION,
} from './navConfig';
import { readFileSync } from 'node:fs';
import { BUNGALOWS } from './bungalows';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isIndexerConfigured } from './indexer/client';
import { loadLocalRules } from './alerts/ruleStore';
import { evaluableRuleKinds } from './alerts/sources';
import { PAYMENT_LINK_CHAIN_IDS } from './commerce/settleTokens';
import { deployedCurveChains } from './launcher/curveChains';
// The route table (src/test/a11yRouteCoverage.test.ts holds it equal to App.tsx): the
// answer to "is this path routed at all".
import { ROUTES } from '../../e2e/fixtures/routes';

// The bar is four words at every width: Island, Lock, Launch, Swap (owner, 2026-10-03, the
// island's venue review item 1; on 2026-10-18 Heat and Rooms became the one word Island, and the
// drawer's Island row went up into it). Pools and Check are drawer rows. Every section is still
// one tabbed page; the bar and the drawer only decide where its row is.

describe('the bar', () => {
  it('reads Island · Lock · Launch · Swap, and nothing else', () => {
    expect(BAR_NAV.map((w) => w.label)).toEqual(['Island', 'Lock', 'Launch', 'Swap']);
    for (const dead of ['Heat', 'Rooms', 'Pools', 'Check', 'Earn', 'Farm', 'Trade', 'More', 'Dashboard']) {
      expect(BAR_NAV.map((w) => w.label), `${dead} came back to the bar`).not.toContain(dead);
    }
  });

  it('opens a routed page with every word', () => {
    const routed = new Set(ROUTES.map((r) => r.path));
    for (const w of BAR_NAV) {
      expect(w.to.startsWith('/'), w.label).toBe(true);
      expect(routed, `${w.label} opens ${w.to}, which no route draws`).toContain(w.to.split('#')[0]);
    }
  });

  it('opens Island on the home, where the read field and the hall of doors are', () => {
    expect(BAR_NAV.find((w) => w.label === 'Island')?.to).toBe('/');
    // The word is the Island section's own heading, so that section is on the bar, once.
    expect(BAR_NAV[0]?.label).toBe(ISLAND_SECTION.heading);
  });

  it('points Lock, Launch and Swap at a tab of their own section', () => {
    for (const label of ['Lock', 'Launch', 'Swap']) {
      const word = BAR_NAV.find((w) => w.label === label)!;
      const section = NAV_SECTIONS.find((s) => s.heading === label);
      expect(section, `no ${label} section`).toBeDefined();
      expect(section!.items.map((i) => i.to), `${label} opens a page whose strip lights nothing`).toContain(word.to);
    }
    expect(BAR_NAV.find((w) => w.label === 'Lock')?.to, 'Lock opens the list of every pool').toBe('/earn');
  });

  it('keeps Dashboard off the bar: it is a drawer row, once a wallet connects', () => {
    expect(BAR_NAV.map((w) => w.to)).not.toContain('/dashboard');
    expect(DASHBOARD_NAV.to).toBe('/dashboard');
    expect(ALL_NAV.map((n) => n.to)).toContain('/dashboard');
  });
});

describe('which word is lit', () => {
  const at = (path: string, hash = '') => litWord(path, hash)?.label ?? null;

  it.each([
    ['/', '', 'Island'],
    ['/', '#hall', 'Island'],
    ['/bayla', '', 'Island'],
    ['/pepe', '', 'Island'],
    ['/towelie', '', 'Island'],
    ['/nb1', '', 'Island'],
    // The island's own pages, which the drawer's Island row owned until 2026-10-18.
    ['/island', '', 'Island'],
    ['/gallery', '', 'Island'],
    ['/community', '', 'Island'],
    ['/tokenomics', '', 'Island'],
    ['/earn', '', 'Lock'],
    ['/earn/bayla', '', 'Lock'],
    ['/nft-finance', '', 'Lock'],
    ['/checkout', '', 'Lock'],
    ['/launch', '', 'Launch'],
    ['/curve-launch', '', 'Launch'],
    ['/launch-simulator', '', 'Launch'],
    ['/swap', '', 'Swap'],
    ['/solana', '', 'Swap'],
  ])('%s%s lights %s', (path, hash, word) => {
    expect(at(path, hash)).toBe(word);
  });

  it.each(['/pools', '/liquidity', '/trust', '/scan', '/history', '/lore', '/changelog', '/dashboard', '/start'])(
    'lights no bar word on %s, a page the drawer or the footer opens',
    (path) => {
      expect(at(path)).toBeNull();
    },
  );

  it('never lights two words on one routed page', () => {
    for (const r of ROUTES) {
      if (r.path.includes(':') || r.path === '/*') continue;
      for (const hash of ['', '#hall']) {
        const lit = BAR_NAV.filter((w) => w.lit(r.path, hash)).map((w) => w.label);
        expect(lit.length, `${r.path}${hash} lights ${lit.join(' and ')}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('the drawer', () => {
  it('carries Pools and Check, one row each, and the bar carries the rest', () => {
    expect(DRAWER_SECTIONS.map((s) => s.heading)).toEqual(['Pools', 'Check']);
    const onBar = BAR_NAV.map((w) => w.label);
    for (const s of NAV_SECTIONS) {
      const places = (onBar.includes(s.heading) ? 1 : 0) + (DRAWER_SECTIONS.includes(s) ? 1 : 0);
      expect(places, `the ${s.heading} section is in ${places} places; it belongs in exactly one`).toBe(1);
    }
  });

  // Owner, 2026-10-03: "pools land on solana lp"; 2026-10-24: "remove solana lp keep venue amm",
  // the same LP section, so the row lands there.
  it('lands the Pools row on the Venue AMM tab, and keeps the strip in its order', () => {
    expect(POOLS_SECTION.hub).toBe('/liquidity');
    expect(POOLS_SECTION.primaryTo).toBe('/pools');
    expect(DRAWER_SECTIONS[0], 'Pools is the drawer row people come for: it leads').toBe(POOLS_SECTION);
    expect(POOLS_SECTION.items.map((i) => [i.to, i.tabLabel ?? i.label])).toEqual([
      ['/liquidity', 'Add / Remove'],
      ['/pools', 'Venue AMM'],
      ['/range-pools', 'Range'],
      ['/zap', 'Zap'],
    ]);
  });

  // Owner, 2026-10-24: Venue AMM "left of" Range.
  it('puts Venue AMM left of Range once range pools are shown, and has no Solana LP tab', async () => {
    vi.resetModules();
    vi.doMock('./solana/clmm/programId', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./solana/clmm/programId')>()),
      rangePoolsVisible: () => true,
    }));
    try {
      const { POOLS_SECTION: withRange } = await import('./navConfig');
      expect(withRange.items.map((i) => i.tabLabel ?? i.label)).toEqual(['Add / Remove', 'Venue AMM', 'Range', 'Zap']);
      expect(withRange.items.some((i) => i.to === '/solana-lp')).toBe(false);
    } finally {
      vi.doUnmock('./solana/clmm/programId');
      vi.resetModules();
    }
  });

  it('keeps the detection tools together under Check', () => {
    const check = NAV_SECTIONS.find((sec) => sec.heading === 'Check');
    expect(DRAWER_SECTIONS).toContain(check);
    const paths = check!.items.map((i) => i.to);
    for (const p of ['/trust', '/scan', '/deployer', '/exposure']) expect(paths).toContain(p);
    expect(NAV_SECTIONS.map((sec) => sec.heading)).not.toContain('Trust & Safety');
  });

  // The footer dropped them on 2026-10-15; each still opens from one tap in the drawer.
  it('carries the records and the developer API the footer no longer lists', () => {
    expect(DRAWER_LINKS.map((l) => [l.to, l.label])).toEqual([
      ['/changelog', 'Changelog'],
      ['/contracts', 'Contracts'],
      ['/developers', 'Developer API'],
    ]);
  });
});

describe('navConfig', () => {
  // Three of NFT finance's four relaunch addresses are real, so the address-derived gate is
  // true on its own; zeroing them must fail here, not hide behind PROMOTE_PENDING.
  it('lists NFT Finance on the strength of its OWN addresses', () => {
    expect(
      NFT_FINANCE_ADDRESSES_LIVE,
      'an nft-finance address must be deployed in constants.ts for this entry to be honest',
    ).toBe(true);
    expect(MORE_NAV.map((n) => n.to)).toContain('/nft-finance');
    expect(ALL_NAV.find((n) => n.to === '/nft-finance')?.label).toBe('Borrow on NFTs');
  });

  // Governance is deployed on mainnet but 0x0 in constants.ts, so only PROMOTE_PENDING lists
  // /community. Turn it off and the last two assertions fail.
  it('lists Community ONLY because PROMOTE_PENDING forces it', () => {
    expect(COMMUNITY_ADDRESSES_LIVE, 'no governance address is wired in constants.ts yet').toBe(false);
    expect(COMMUNITY_LIVE, 'Community is listed, so something other than the addresses carries it').toBe(true);
    expect(MORE_NAV.map((n) => n.to)).toContain('/community');
  });

  // Owner, 2026-10-15: the points program and the trading competitions are deleted. No bar,
  // drawer, strip or lobby lists either: an entry is gone, or off until its page is removed.
  it('lists neither the points board nor the competitions', () => {
    const shown = ALL_NAV.filter((n) => !n.soon);
    for (const path of ['/leaderboard', '/competitions']) {
      expect(shown.map((n) => n.to), path).not.toContain(path);
    }
    for (const label of ['Venue Score', 'Points', 'Competitions']) {
      expect(shown.map((n) => n.label), label).not.toContain(label);
    }
  });

  // Owner, 2026-10-24: the Nakamigos marketplace leaves the nav (and the home and the
  // venue's metadata). /nakamigos still opens it; nothing of the venue's points there.
  it('lists no door to the Nakamigos marketplace', () => {
    expect(ALL_NAV.map((n) => n.to)).not.toContain('/nakamigos');
    expect(ALL_NAV.map((n) => n.label)).not.toContain('Marketplace');
    const island = NAV_SECTIONS.find((sec) => sec.heading === 'Island');
    expect(island?.items.map((i) => i.to)).not.toContain('/nakamigos');
  });

  it('no duplicate paths in ALL_NAV', () => {
    const paths = ALL_NAV.map((n) => n.to);
    expect(new Set(paths).size).toBe(paths.length);
  });

  // The Meteora DBC rail graduated into a pool this protocol does not own (retired 2026-08-23).
  it('does not offer the retired /solana-launch rail', () => {
    expect(ALL_NAV.find((n) => n.to === '/solana-launch')).toBeUndefined();
  });

  // /curve-launch is off whenever launching and trading cannot load (curveWriteFlag.ts). In a
  // production build only the committed constant decides, and it is off by the owner's decision
  // (2026-10-02). Off means the strip does not list it (RouteTabs.tsx); the page still opens.
  it('marks /curve-launch off in a production build while launching is off', async () => {
    expect(ALL_NAV.find((n) => n.to === '/curve-launch'), '/curve-launch missing from nav').toBeTruthy();
    vi.stubEnv('DEV', false);
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('VITE_SOLANA_CURVE_WRITES', '1');
    vi.resetModules();
    const prod = await import('./navConfig');
    expect(prod.ALL_NAV.find((n) => n.to === '/curve-launch')?.soon).toBe(true);

    vi.stubEnv('DEV', true);
    vi.stubEnv('MODE', 'development');
    vi.resetModules();
    const dev = await import('./navConfig');
    expect(dev.ALL_NAV.find((n) => n.to === '/curve-launch')?.soon).toBe(false);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('marks /curve-launch off again the moment the write path cannot load', async () => {
    vi.resetModules();
    vi.doMock('./launcher/solana/curveWriteFlag', () => ({ isCurveWriteEnabled: () => false }));
    try {
      const off = await import('./navConfig');
      expect(off.ALL_NAV.find((n) => n.to === '/curve-launch')?.soon).toBe(true);
    } finally {
      vi.doUnmock('./launcher/solana/curveWriteFlag');
      vi.resetModules();
    }
  });

  // Its rule kinds watch what the detection tools read on demand; the store is browser-local.
  it('lists /alerts under Check, on because the store is server-free', () => {
    const trust = NAV_SECTIONS.find((sec) => sec.heading === 'Check');
    expect(trust?.items.map((i) => i.to)).toContain('/alerts');
    const entry = ALL_NAV.find((n) => n.to === '/alerts');
    expect(entry?.label).toBe('Alerts');
    expect(entry?.soon, 'a store that needs nothing must not read as off').toBeFalsy();
  });

  // The precondition for the entry above. Read from this file's own URL: a guard that reads
  // nothing passes forever, so the read is proved before the contents are judged.
  it('the alert rule store reaches no network, in source and at runtime', () => {
    const storePath = join(dirname(fileURLToPath(import.meta.url)), 'alerts', 'ruleStore.ts');
    const source = readFileSync(storePath, 'utf8');
    expect(source.length, 'the rule store source could not be read').toBeGreaterThan(500);
    expect(source, 'not the module this guard thinks it is').toContain('loadLocalRules');
    expect(source.includes('fetch('), 'a browser-local store must not fetch').toBe(false);
    expect(source, 'rulesClient is the SERVER store; the local one must not use it').not.toContain('./rulesClient');
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
    expect(evaluableRuleKinds().length).toBeGreaterThan(0);
  });

  // The invoice is a merchant-signed document in the URL fragment, so a link can be minted and
  // paid in the browser. The settle-token table is the precondition, asserted first.
  it('lists /checkout once, on because a link can be minted and paid here', () => {
    const sections = NAV_SECTIONS.filter((sec) => sec.items.some((i) => i.to === '/checkout'));
    expect(sections, '/checkout must be listed in exactly one section').toHaveLength(1);
    const entry = ALL_NAV.find((n) => n.to === '/checkout');
    expect(entry?.label).toBe('Checkout');
    expect(
      PAYMENT_LINK_CHAIN_IDS,
      'no served chain has a verified settlement asset, so nothing can be minted or paid',
    ).toContain(1);
    expect(entry?.soon, 'a checkout that can mint and pay a link must not read as off').toBe(false);
  });

  // /tax reads Ethereum history through /api/etherscan, which ships with every deployment, so
  // it is on whatever the indexer does. A personal accounting page, never a detection tool.
  it('keeps /tax on: its rail ships with the deployment, and the key is disclosed on the page', () => {
    const entry = NUMBERS_TABS.find((n) => n.to === '/tax');
    expect(entry?.label).toBe('Tax Reports');
    expect(entry?.soon, 'the explorer rail ships with every deployment').toBe(false);
    expect(isIndexerConfigured()).toBe(false);
    const check = NAV_SECTIONS.find((sec) => sec.heading === 'Check');
    expect(check?.items.map((i) => i.to)).not.toContain('/tax');
  });

  // StatsPage hosts all three numbers tabs and lands on items[0]; one entry opens it (a lobby
  // door, and a link in the menu's More list).
  it('opens the three numbers tabs from ONE Island entry, and keeps them in step', () => {
    const island = NAV_SECTIONS.find((sec) => sec.heading === 'Island');
    const row = island?.items.find((i) => i.to === '/tokenomics');
    expect(row?.label, 'the operator asked "stats about what?": name the subject').toBe('Treasury & numbers');
    expect(NUMBERS_TABS[0]?.to, 'StatsPage lands on items[0]').toBe('/tokenomics');
    expect(NUMBERS_TABS.map((n) => n.to)).toEqual(['/tokenomics', '/treasury', '/tax']);
    for (const p of ['/treasury', '/tax']) {
      expect(MORE_NAV.map((n) => n.to), p + ' is listed as well as being a tab').not.toContain(p);
    }
  });

  // SectionHost lands on items[0]: a hub anywhere else opens a tab the visitor did not press.
  it('opens every section on its own first tab', () => {
    expect(NAV_SECTIONS.map((sec) => sec.heading)).toEqual(['Swap', 'Pools', 'Island', 'Launch', 'Lock', 'Check']);
    for (const s of NAV_SECTIONS) {
      expect(s.hub, s.heading + ' hub must be its own first item').toBe(s.items[0]?.to);
      const to = s.primaryTo ?? s.hub;
      expect(s.items.map((i) => i.to), s.heading + ' points outside itself').toContain(to);
    }
  });

  it('gives every section a tab strip that fits and has no two tabs alike', () => {
    for (const s of NAV_SECTIONS) {
      const shown = s.items.map((i) => i.tabLabel ?? i.label);
      for (const t of shown) {
        expect(t.length, `"${t}" is too long for a tab in the ${s.heading} strip`).toBeLessThanOrEqual(20);
        expect(t.length).toBeGreaterThan(0);
      }
      expect(new Set(shown).size, `duplicate tab labels in the ${s.heading} strip`).toBe(shown.length);
    }
  });

  // `tabLabel` is a strip shorthand; `label` is the canonical name e2e specs pin.
  it('never lets a tabLabel replace the canonical label', () => {
    for (const item of MORE_NAV) {
      expect(item.label.length, `${item.to} has no canonical label`).toBeGreaterThan(0);
      if (item.tabLabel !== undefined) {
        expect(item.tabLabel, `${item.to}'s tabLabel just restates its label`).not.toBe(item.label);
      }
    }
  });

  // A phone or iPad shows `compactTabLabel` (RouteTabs.tsx): shorter, and unique in its strip.
  it('shortens the Copy Trading tab to CT, and keeps every compact tab label a shorthand', () => {
    const copy = NAV_SECTIONS.find((s) => s.heading === 'Lock')?.items.find((i) => i.to === '/copy-trading');
    expect(copy?.label, 'the canonical name stays Copy Trading').toBe('Copy Trading');
    expect(copy?.compactTabLabel).toBe('CT');
    for (const s of [...NAV_SECTIONS, { heading: 'Numbers', items: NUMBERS_TABS }]) {
      for (const i of s.items) {
        if (i.compactTabLabel === undefined) continue;
        const full = i.tabLabel ?? i.label;
        expect(i.compactTabLabel.trim().length, `${i.to} has an empty compact label`).toBeGreaterThan(0);
        expect(i.compactTabLabel.length, `${i.to}'s compact label is no shorter than "${full}"`).toBeLessThan(full.length);
      }
      const compact = s.items.map((i) => i.compactTabLabel ?? i.tabLabel ?? i.label);
      expect(new Set(compact).size, `duplicate compact tab labels in the ${s.heading} strip`).toBe(compact.length);
    }
  });

  // The curve is live on Base and Robinhood Chain as well as mainnet; "(EVM)" is not what anyone
  // hunting for the Robinhood launcher types. Preconditions first, so a removed deploy names itself.
  it('names every chain the curve is deployed on, so each launcher is findable by name', () => {
    const chains = deployedCurveChains();
    expect(chains.map((c) => c.chainId), 'the curve must still be deployed on Robinhood Chain (4663)').toContain(4663);
    expect(chains.length, 'a single-chain rail has nothing to enumerate').toBeGreaterThan(1);
    const entry = ALL_NAV.find((n) => n.to === '/eth-curve');
    for (const c of chains) {
      expect(entry?.label, `the menu never names the ${c.name} launcher`).toContain(c.name);
    }
  });

  // Mainnet is deployed, so the outcome assertions pass for the old mainnet-only gate too; the
  // source check pins the input, the registry, which is the part that was wrong.
  it('marks /eth-curve on whether the curve launches ANYWHERE, not just on mainnet', () => {
    const chains = deployedCurveChains();
    const entry = ALL_NAV.find((n) => n.to === '/eth-curve');
    expect(entry?.live, 'a launcher that launches must not be missing its LIVE pill').toBe(true);
    expect(entry?.soon, 'a launcher that launches must never read as off').toBe(false);
    expect(chains.filter((c) => c.chainId !== 1).map((c) => c.chainId)).toContain(4663);
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'navConfig.ts'), 'utf8');
    expect(source.length, 'navConfig.ts could not be read').toBeGreaterThan(1000);
    const start = source.indexOf("to: '/eth-curve'");
    expect(start, 'the /eth-curve entry is not where this guard looks').toBeGreaterThan(-1);
    const entrySource = source.slice(start, source.indexOf('},', start));
    expect(entrySource, 'the mark must read the registry, not one chain').toContain('isCurveLive()');
    expect(entrySource).not.toContain('CURVE_LAUNCHER_ADDRESS');
  });

  // Every rail behind them is undeployed (pages/airdropVestingHonesty.test.ts). Listing either
  // is a deliberate act that deletes this test first.
  it('leaves /airdrop and /vesting reachable by URL but out of the nav', () => {
    const routed = ROUTES.map((r) => r.path);
    const listed = ALL_NAV.map((n) => n.to);
    for (const path of ['/airdrop', '/vesting']) {
      expect(routed, `${path} must stay reachable by URL`).toContain(path);
      expect(listed, `${path}'s rails are undeployed; it must not be listed`).not.toContain(path);
    }
  });
});

// Swap follows the room's chain, read at render: a door switches the skin in place, so a value
// taken at import keeps the previous room's swap. ChainSwitch keeps the other chain one click away.
describe('tradeRoute', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  const swapWord = () => BAR_NAV.find((w) => w.label === 'Swap')?.to;
  const swapSection = () => NAV_SECTIONS.find((s) => s.heading === 'Swap')!;

  it('follows the skin with no module reload', () => {
    expect(tradeRoute()).toBe('/swap');
    expect(swapWord()).toBe('/swap');

    window.localStorage.setItem('tegridy-bungalow', 'bayla');
    expect(tradeRoute(), 'a Solana room lands on the Solana swap').toBe('/solana');
    expect(swapWord()).toBe('/solana');
    expect(swapSection().primaryTo).toBe('/solana');

    window.localStorage.setItem('tegridy-bungalow', 'toweli');
    expect(tradeRoute(), 'the classic TOWELI room lands on the Ethereum swap').toBe('/swap');
    expect(swapWord()).toBe('/swap');
    expect(swapSection().primaryTo).toBe('/swap');
  });

  it('lands on a tab the Swap section really has, in every room', () => {
    for (const id of [null, 'bayla', 'toweli', 'pepe']) {
      window.localStorage.clear();
      if (id) window.localStorage.setItem('tegridy-bungalow', id);
      expect(swapSection().items.map((i) => i.to), String(id)).toContain(tradeRoute());
    }
  });
});

// Lock shows the bungalow selected (owner, 2026-10-15): the word opens the room's own pool,
// read at render as Swap's is. With no room, and for the venue sentinel, it opens the list.
describe('lockRoute', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  const lockWord = () => BAR_NAV.find((w) => w.label === 'Lock');

  it("opens the room's pool, and follows the skin with no module reload", () => {
    expect(lockRoute()).toBe('/earn');
    expect(lockWord()?.to).toBe('/earn');

    window.localStorage.setItem('tegridy-bungalow', 'bayla');
    expect(lockRoute(), "BAYLA's room opens BAYLA's pool, not every pool").toBe('/earn/bayla');
    expect(lockWord()?.to).toBe('/earn/bayla');

    window.localStorage.setItem('tegridy-bungalow', 'toweli');
    expect(lockWord()?.to, "TOWELI's room opens the classic farm").toBe('/earn/toweli');

    window.localStorage.setItem('tegridy-bungalow', 'venue');
    expect(lockWord()?.to, 'the venue sentinel is no room').toBe('/earn');
  });

  it('stays lit on the pool it opens', () => {
    window.localStorage.setItem('tegridy-bungalow', 'pepe');
    expect(lockWord()?.lit('/earn/pepe', '')).toBe(true);
  });
});

// Pools follows the room as Lock does (owner, 2026-10-17: "the wiring for the pages inside the
// bayla bungalow is off"): in a Solana room with a coin it opens the Venue AMM tab on that coin.
describe('poolsRoute', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("opens on the room's coin in a Solana room, and as for anyone elsewhere", () => {
    expect(poolsRoute()).toBe('/pools');
    expect(POOLS_SECTION.primaryTo).toBe('/pools');

    window.localStorage.setItem('tegridy-bungalow', 'bayla');
    const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
    expect(poolsRoute(), "BAYLA's room opens on BAYLA").toBe(`/pools?mint=${bayla.address}`);
    expect(POOLS_SECTION.primaryTo).toBe(`/pools?mint=${bayla.address}`);

    window.localStorage.setItem('tegridy-bungalow', 'toweli');
    expect(poolsRoute(), 'an Ethereum room keeps the tab as it opens for anyone').toBe('/pools');
  });
});

// Island stays in the room (owner, 2026-10-17, of the word it replaced: "inside a room, Heat
// (top bar and phone bar) should open that room's own page, like /bayla, instead of leaving for
// the venue home").
describe('islandRoute', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  const islandWord = () => BAR_NAV.find((w) => w.label === 'Island')!;

  it("opens the room's own page inside a room, and the venue home elsewhere", () => {
    expect(islandRoute()).toBe('/');
    expect(islandWord().to).toBe('/');
    window.localStorage.setItem('tegridy-bungalow', 'venue');
    expect(islandWord().to, 'the venue sentinel is no room').toBe('/');
    window.localStorage.setItem('tegridy-bungalow', 'bayla');
    expect(islandWord().to, "BAYLA's room stays in BAYLA's room").toBe('/bayla');
    window.localStorage.setItem('tegridy-bungalow', 'toweli');
    expect(islandWord().to, "TOWELI's room stays in TOWELI's room").toBe('/toweli');
  });

  it("lights alone on the room's own page, another room's door, and the home with or without its hall", () => {
    window.localStorage.setItem('tegridy-bungalow', 'bayla');
    for (const [path, hash] of [['/bayla', ''], ['/pepe', ''], ['/', '#hall'], ['/', '']] as const) {
      expect(islandWord().lit(path, hash), `${path}${hash}`).toBe(true);
      expect(BAR_NAV.filter((w) => w.lit(path, hash)).length, `${path}${hash}`).toBe(1);
    }
    expect(litWord('/earn/bayla')?.label, "the room's pool is Lock's").toBe('Lock');
  });
});

// Owner, 2026-10-18: "put marketplace, nft finance, and other things here that dont have a
// direct access on the app ... until we can organize them better". One tap each from the menu.
// Owner, 2026-10-18: the shadowed features went in the side nav "until we can organize them
// better"; 2026-10-19: organised, under their sections' words, on the desktop as on a phone.
describe("the menu's index", () => {
  const pages = () => INDEX_PAGES.map((i) => i.to);
  const group = (heading: string) => INDEX_GROUPS.find((g) => g.heading === heading)!;

  it('runs Island, Swap, Pools, Lock, Launch, Check, then the records: one group per section', () => {
    expect(INDEX_GROUPS.map((g) => g.heading)).toEqual(['Island', 'Swap', 'Pools', 'Lock', 'Launch', 'Check', 'Records']);
    for (const s of NAV_SECTIONS) expect(group(s.heading).to, `${s.heading}'s word`).toBe(s.primaryTo ?? s.hub);
    expect(group('Records').to).toBeUndefined();
    expect(group('Records').items).toEqual(DRAWER_LINKS);
  });

  it("carries every page that is on under its section's word, in tab order", () => {
    for (const s of NAV_SECTIONS) {
      const own = s.items.filter((i) => !i.soon).map((i) => i.to);
      expect(group(s.heading).items.map((i) => i.to).filter((to) => own.includes(to)), s.heading).toEqual(own);
    }
  });

  it("files the venue's own pages (the Gold Card, History, Lore) under Island, after the lobby's doors", () => {
    const island = group('Island').items.map((i) => i.to);
    const doors = ISLAND_SECTION.items.map((i) => i.to);
    expect(island.slice(0, doors.length)).toEqual(doors);
    for (const path of ['/premium', '/history', '/lore']) expect(island, path).toContain(path);
  });

  it("names a page by its tab label under the word, unless that only repeats the word", () => {
    const island = group('Island');
    expect(indexName(island, island.items.find((i) => i.to === '/island')!)).toBe('The island');
    expect(indexName(island, island.items.find((i) => i.to === '/tokenomics')!)).toBe('Numbers');
    const swap = group('Swap');
    expect(indexName(swap, swap.items.find((i) => i.to === '/swap')!)).toBe('Ethereum');
    const lock = group('Lock');
    expect(indexName(lock, lock.items.find((i) => i.to === '/earn')!)).toBe('Staking');
    expect(indexName(lock, lock.items.find((i) => i.to === '/nft-finance')!)).toBe('NFT Loans');
  });

  it('lands the Pools word on Venue AMM and the Check word on the overview', () => {
    expect(group('Pools').to).toBe('/pools');
    expect(group('Check').to).toBe('/trust');
  });

  it('gives every group a picture of its own in the menu', () => {
    const arts = INDEX_GROUPS.filter((g) => g.heading !== 'Records').map((g) => g.art);
    expect(new Set(arts).size, 'two groups share a picture').toBe(arts.length);
    expect(arts, "0 is the menu's own picture, and the records'").not.toContain(0);
  });

  it('opens a routed page with every entry, each once', () => {
    const routed = new Set(ROUTES.map((r) => r.path));
    for (const to of pages()) expect(routed, `${to} is listed but no route draws it`).toContain(to);
    expect(new Set(pages()).size, 'a page is listed twice').toBe(pages().length);
  });

  it('lists no page that is off today', () => {
    const off = ALL_NAV.filter((n) => n.soon).map((n) => n.to);
    for (const to of pages()) expect(off, `${to} is off, and its own strip hides it`).not.toContain(to);
  });

  // Every entry is on today, so the guard above cannot fail on its own: switch one off.
  it('drops a page the moment it is off, as its strip does', async () => {
    expect(pages(), 'the precondition: Copy Trading is listed while its tape is readable').toContain('/copy-trading');
    vi.resetModules();
    vi.doMock('./copytrade/tape', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./copytrade/tape')>()),
      hasCopyTapeSource: () => false,
    }));
    try {
      const off = await import('./navConfig');
      expect(off.ALL_NAV.find((n) => n.to === '/copy-trading')?.soon, 'Copy Trading reads as off').toBe(true);
      expect(off.INDEX_PAGES.map((i) => i.to)).not.toContain('/copy-trading');
    } finally {
      vi.doUnmock('./copytrade/tape');
      vi.resetModules();
    }
  });
});
