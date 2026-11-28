// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HYPEREVM_DEPLOYMENT, type HyperEvmDeployment } from './hyperEvmDeployment';
import { HYPEREVM_TOKENS, MAX_SITE_FEE_BPS, WHYPE, hyperEvmLive, hyperEvmVenue, hyperEvmVenueFrom } from './hyperEvm';

/**
 * HyperEVM shows nowhere until every address of our V3 venue is set, and everywhere it should
 * once they are. Both halves are read off the same modules the site loads, with a record
 * swapped in under the same name: one all null, one fake. The fake addresses below are NOT
 * contracts; they only prove what the switch turns on. The real record (deployed 2026-11-25)
 * is held to the addresses read back on chain.
 */
const UNSET: HyperEvmDeployment = Object.freeze({
  factory: null,
  positionManager: null,
  quoterV2: null,
  universalRouter: null,
  feeAdapter: null,
  treasury: null,
  siteFeeBps: null,
});

const FAKE: HyperEvmDeployment = Object.freeze({
  factory: '0x1000000000000000000000000000000000000001',
  positionManager: '0x1000000000000000000000000000000000000002',
  quoterV2: '0x1000000000000000000000000000000000000003',
  universalRouter: '0x1000000000000000000000000000000000000004',
  feeAdapter: '0x1000000000000000000000000000000000000005',
  treasury: '0x1000000000000000000000000000000000000006',
  siteFeeBps: 25,
});

describe('the HyperEVM record as committed', () => {
  it('holds the deployed venue, read back on chain 2026-11-25, and the owner\'s 0.5% site fee', () => {
    expect(HYPEREVM_DEPLOYMENT).toEqual({
      factory: '0xcaDc93E96De58EA554c71ca609974625615E046D',
      positionManager: '0xcb03207ae13076F520b8c81Ea4FE6F08F8bC63b2',
      quoterV2: '0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3',
      universalRouter: '0x8652f9389D1738598E8a732d122440cDA85FAF1A',
      feeAdapter: '0x5f30Aa592fa4dB6AB62373666334E93772c28887',
      // The HyperEVM treasury Safe, at the same address as Base's (rebuilt from its creation).
      treasury: '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0',
      siteFeeBps: 50,
      // Not deployed yet: the open form stays hidden until the owner's deploy run fills it.
      poolOpener: null,
    });
    expect(hyperEvmLive()).toBe(true);
    expect(hyperEvmVenue()).toMatchObject({ chainId: 999, factory: HYPEREVM_DEPLOYMENT.factory, treasury: HYPEREVM_DEPLOYMENT.treasury, siteFeeBps: 50n, poolOpener: null });
  });

  it('lists HYPE, WHYPE and the two dollar coins by their own tickers and whole addresses', () => {
    expect(HYPEREVM_TOKENS.map((t) => [t.symbol, t.address, t.decimals])).toEqual([
      ['HYPE', '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', 18],
      ['WHYPE', WHYPE, 18],
      ['USD₮0', '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', 6],
      ['USDC', '0xb88339CB7199b77E23DB6E890353E22632Ba630f', 6],
    ]);
  });
});

describe('hyperEvmVenueFrom', () => {
  it('is the venue once every address and the fee rate are set', () => {
    const v = hyperEvmVenueFrom(FAKE);
    expect(v).toMatchObject({ chainId: 999, name: 'HyperEVM', whype: WHYPE, factory: FAKE.factory, treasury: FAKE.treasury, siteFeeBps: 25n });
  });

  it.each(['factory', 'positionManager', 'quoterV2', 'universalRouter', 'feeAdapter', 'treasury'] as const)('is null while %s is unset, zero or not an address', (key) => {
    expect(hyperEvmVenueFrom({ ...FAKE, [key]: null })).toBeNull();
    expect(hyperEvmVenueFrom({ ...FAKE, [key]: '0x0000000000000000000000000000000000000000' })).toBeNull();
    expect(hyperEvmVenueFrom({ ...FAKE, [key]: '0x1234' as `0x${string}` })).toBeNull();
  });

  it('keeps the venue live without a pool opener, and takes one only when it is an address', () => {
    expect(hyperEvmVenueFrom(FAKE)?.poolOpener).toBeNull();
    expect(hyperEvmVenueFrom({ ...FAKE, poolOpener: null })?.poolOpener).toBeNull();
    expect(hyperEvmVenueFrom({ ...FAKE, poolOpener: '0x0000000000000000000000000000000000000000' })?.poolOpener).toBeNull();
    expect(hyperEvmVenueFrom({ ...FAKE, poolOpener: '0x1234' as `0x${string}` })?.poolOpener).toBeNull();
    expect(hyperEvmVenueFrom({ ...FAKE, poolOpener: '0x1000000000000000000000000000000000000007' })?.poolOpener).toBe('0x1000000000000000000000000000000000000007');
  });

  it('is null while the owner has not set the site fee, or sets one out of range', () => {
    expect(hyperEvmVenueFrom({ ...FAKE, siteFeeBps: null })).toBeNull();
    expect(hyperEvmVenueFrom({ ...FAKE, siteFeeBps: -1 })).toBeNull();
    expect(hyperEvmVenueFrom({ ...FAKE, siteFeeBps: 2.5 })).toBeNull();
    expect(hyperEvmVenueFrom({ ...FAKE, siteFeeBps: MAX_SITE_FEE_BPS + 1 })).toBeNull();
    expect(hyperEvmVenueFrom({ ...FAKE, siteFeeBps: 0 })?.siteFeeBps).toBe(0n);
    expect(hyperEvmVenueFrom({ ...FAKE, siteFeeBps: MAX_SITE_FEE_BPS })?.siteFeeBps).toBe(100n);
  });
});

/** Everything that names a network, loaded fresh with `record` as the deployment. */
async function surfaces(record: HyperEvmDeployment | null) {
  vi.resetModules();
  if (record) vi.doMock('./hyperEvmDeployment', () => ({ HYPEREVM_DEPLOYMENT: record }));
  // One at a time: parallel first loads of modules that share a dependency can each start it.
  const sectionChains = await import('../sectionChains');
  const nav = await import('../navConfig');
  const viemChains = await import('./viemChains');
  const registry = await import('./registry');
  const explorer = await import('../explorer');
  const moduleNetwork = await import('../../components/layout/moduleNetwork');
  const sheet = await import('../sheet');
  const items = (heading: string) => nav.NAV_SECTIONS.find((s) => s.heading === heading)!.items.map((i) => i.to);
  return {
    venueChains: sectionChains.VENUE_CHAINS.map((c) => c.id),
    venueChainOf999: sectionChains.venueChainOfEvm(999),
    swapItems: items('Swap'),
    poolsItems: items('Pools'),
    wagmiIds: viemChains.WAGMI_CHAINS.map((c) => c.id),
    wagmi999: viemChains.WAGMI_CHAINS.find((c) => c.id === 999) ?? null,
    transport999: 999 in viemChains.WAGMI_TRANSPORTS,
    served: registry.isChainServed(999),
    servedNames: registry.servedEvmChainNames(),
    label: explorer.getChainLabel(999),
    explorer: explorer.getExplorerBase(999),
    swapModule: moduleNetwork.moduleServes('swap', 'hyperevm'),
    poolsModule: moduleNetwork.moduleServes('pools', 'hyperevm'),
    sheetOpensOn: moduleNetwork.moduleNetworkOr('swap', sheet.readSheet('?sheet=buy&net=hyperevm')?.net),
  };
}

// Each test re-imports seven modules from scratch (resetModules): the first is past 5 s on a
// busy machine. 20 s, as the repo's other cold-import tests (lib/cardano/flags.test.ts).
describe('where HyperEVM shows', { timeout: 20_000 }, () => {
  afterEach(() => {
    vi.doUnmock('./hyperEvmDeployment');
    vi.resetModules();
  });

  it('nowhere while any address is null: no network row, tab, wallet chain, label or sheet', async () => {
    const s = await surfaces(UNSET);
    expect(s.venueChains).not.toContain('hyperevm');
    expect(s.venueChainOf999).toBeNull();
    expect(s.swapItems).not.toContain('/hyperevm');
    expect(s.poolsItems).not.toContain('/hyperevm-pools');
    expect(s.wagmiIds).not.toContain(999);
    expect(s.transport999).toBe(false);
    expect(s.served).toBe(false);
    expect(s.servedNames).toEqual(['Ethereum', 'Base', 'Robinhood Chain']);
    expect(s.label).toBe('Chain 999');
    expect(s.explorer).toBe('https://etherscan.io');
    expect(s.swapModule).toBe(false);
    expect(s.poolsModule).toBe(false);
    // A link naming HyperEVM opens the sheet on Solana, as any network the venue does not run does.
    expect(s.sheetOpensOn).toBe('solana');
  });

  it('nowhere while one address is still null, even with all the others set', async () => {
    const s = await surfaces({ ...FAKE, feeAdapter: null });
    expect(s.venueChains).not.toContain('hyperevm');
    expect(s.wagmiIds).not.toContain(999);
    expect(s.swapItems).not.toContain('/hyperevm');
  });

  it('everywhere it belongs once every address is set', async () => {
    const s = await surfaces(FAKE);
    expect(s.venueChains).toContain('hyperevm');
    expect(s.venueChainOf999).toBe('hyperevm');
    expect(s.swapItems).toContain('/hyperevm');
    expect(s.poolsItems).toContain('/hyperevm-pools');
    expect(s.wagmiIds).toEqual([1, 4663, 8453, 999]);
    // viem's own HyperEVM, by name: two other viem chains also use id 999.
    expect(s.wagmi999).toMatchObject({ id: 999, name: 'HyperEVM', nativeCurrency: { symbol: 'HYPE', decimals: 18 } });
    expect(s.transport999).toBe(true);
    expect(s.served).toBe(true);
    expect(s.servedNames).toEqual(['Ethereum', 'Base', 'Robinhood Chain', 'HyperEVM']);
    expect(s.label).toBe('HyperEVM');
    expect(s.explorer).toBe('https://hyperevmscan.io');
    expect(s.swapModule).toBe(true);
    expect(s.poolsModule).toBe(true);
    expect(s.sheetOpensOn).toBe('hyperevm');
  });
});
