// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HYPEREVM_DEPLOYMENT, type HyperEvmDeployment } from './hyperEvmDeployment';
import { HYPEREVM_TOKENS, MAX_SITE_FEE_BPS, WHYPE, hyperEvmLive, hyperEvmVenue, hyperEvmVenueFrom } from './hyperEvm';

/**
 * HyperEVM shows nowhere until every address of our V3 venue is set, and everywhere it should
 * once they are. Both halves are read off the same modules the site loads: the real record
 * (all null today), and a fake one swapped in under the same name. The fake addresses below
 * are NOT contracts; they only prove what the switch turns on.
 */
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
  it('holds no address and no fee rate until the venue is deployed', () => {
    expect(HYPEREVM_DEPLOYMENT).toEqual({ factory: null, positionManager: null, quoterV2: null, universalRouter: null, feeAdapter: null, treasury: null, siteFeeBps: null });
    expect(hyperEvmVenue()).toBeNull();
    expect(hyperEvmLive()).toBe(false);
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

describe('where HyperEVM shows', () => {
  afterEach(() => {
    vi.doUnmock('./hyperEvmDeployment');
    vi.resetModules();
  });

  it('nowhere while any address is null: no network row, tab, wallet chain, label or sheet', async () => {
    const s = await surfaces(null);
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
