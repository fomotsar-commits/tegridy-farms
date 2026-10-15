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
  litWord,
} from './navConfig';
import { readFileSync } from 'node:fs';
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

// The bar is five words at every width, owner 2026-10-03 (the island's venue review, item 1):
// Heat, Rooms, Lock, Launch, Swap. Pools, Check and Island are drawer rows. Every section is
// still one tabbed page; the bar and the drawer only decide where its row is.

describe('the bar', () => {
  it('reads Heat · Rooms · Lock · Launch · Swap, and nothing else', () => {
    expect(BAR_NAV.map((w) => w.label)).toEqual(['Heat', 'Rooms', 'Lock', 'Launch', 'Swap']);
    for (const dead of ['Pools', 'Check', 'Island', 'Earn', 'Farm', 'Trade', 'More', 'Dashboard']) {
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

  it('opens Heat on the home, where the read field is, and Rooms on the hall of doors', () => {
    expect(BAR_NAV.find((w) => w.label === 'Heat')?.to).toBe('/');
    // The hall's id is VenueDoors' anchor, which every "pick a bungalow" link already uses.
    expect(BAR_NAV.find((w) => w.label === 'Rooms')?.to).toBe('/#hall');
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
    ['/', '', 'Heat'],
    ['/', '#hall', 'Rooms'],
    ['/bayla', '', 'Rooms'],
    ['/pepe', '', 'Rooms'],
    ['/towelie', '', 'Rooms'],
    ['/nb1', '', 'Rooms'],
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

  it.each(['/solana-lp', '/liquidity', '/trust', '/scan', '/island', '/gallery', '/changelog', '/dashboard', '/start'])(
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
  it('carries Pools, Check and Island, one row each, and the bar carries the rest', () => {
    expect(DRAWER_SECTIONS.map((s) => s.heading)).toEqual(['Pools', 'Check', 'Island']);
    const onBar = BAR_NAV.map((w) => w.label);
    for (const s of NAV_SECTIONS) {
      const places = (onBar.includes(s.heading) ? 1 : 0) + (DRAWER_SECTIONS.includes(s) ? 1 : 0);
      expect(places, `the ${s.heading} section is in ${places} places; it belongs in exactly one`).toBe(1);
    }
  });

  // Owner, 2026-10-03: "pools land on solana lp", and Solana LP is to be MORE visible.
  it('lands the Pools row on the Solana LP tab, and keeps the strip in its order', () => {
    expect(POOLS_SECTION.hub).toBe('/liquidity');
    expect(POOLS_SECTION.primaryTo).toBe('/solana-lp');
    expect(DRAWER_SECTIONS[0], 'Pools is the drawer row people come for: it leads').toBe(POOLS_SECTION);
    expect(POOLS_SECTION.items.map((i) => [i.to, i.tabLabel ?? i.label])).toEqual([
      ['/liquidity', 'Add / Remove'],
      ['/solana-lp', 'Solana LP'],
      ['/pools', 'Venue AMM'],
      ['/zap', 'Zap'],
    ]);
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

  // "Trade" beside "Marketplace" gave no clue which sold tokens and which sold art.
  it('files the art Marketplace on the Island, not beside the token swap', () => {
    const island = NAV_SECTIONS.find((sec) => sec.heading === 'Island');
    expect(island?.items.map((i) => i.to)).toContain('/nakamigos');
    expect(ALL_NAV.find((n) => n.to === '/nakamigos')?.label).toBe('Marketplace');
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

  // StatsPage hosts all three numbers tabs and lands on items[0]; the Island row opens it.
  it('opens the three numbers tabs from ONE Island row, and keeps them in step', () => {
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
