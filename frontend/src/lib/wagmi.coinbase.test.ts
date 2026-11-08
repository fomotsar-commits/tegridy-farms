// @vitest-environment node
import { beforeAll, describe, it, expect, vi } from 'vitest';

/**
 * The EVM list's Coinbase Wallet row is RainbowKit's `base` row renamed
 * (wagmi.ts). This pins what the rename must not lose: the id stays 'base'
 * (it keys the saved session), the rdns is the Coinbase extension's own (so
 * the extension's row replaces this one instead of doubling it), and the row
 * sits ahead of WalletConnect, inside a phone's visible strip.
 *
 * createConfig is replaced so the test reads the connector list wagmi.ts
 * hands it, without starting WalletConnect.
 */
vi.mock('wagmi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('wagmi')>()),
  createConfig: (parameters: unknown) => parameters,
}));

type RkDetails = { id: string; name: string; shortName?: string; rdns?: string; iconUrl?: unknown };

let list: RkDetails[] = [];
const rows = async () => list;

// Loading wagmi.ts cold pulls in RainbowKit and every connector: seconds on a
// busy machine, so it is done once, with its own allowance.
beforeAll(async () => {
  vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', '0'.repeat(32));
  const { config } = await import('./wagmi');
  const STUB = { chains: [], emitter: { emit() {}, on() {}, off() {} }, storage: null, transports: {} } as never;
  const connectors = (config as unknown as { connectors: ((c: never) => { rkDetails?: RkDetails })[] }).connectors;
  list = connectors.map((fn) => fn(STUB).rkDetails).filter((d): d is RkDetails => Boolean(d));
}, 60_000);

describe('the EVM connect list names Coinbase Wallet', () => {
  it('is the base row under Coinbase’s name, mark and rdns', async () => {
    const { COINBASE_ICON } = await import('./walletIcons');
    const coinbase = (await rows()).filter((r) => r.name === 'Coinbase Wallet');
    expect(coinbase).toHaveLength(1);
    expect(coinbase[0]).toMatchObject({
      id: 'base',
      shortName: 'Coinbase',
      rdns: 'com.coinbase.wallet',
      iconUrl: COINBASE_ICON,
    });
  });

  it('no longer shows a row called Base', async () => {
    expect((await rows()).map((r) => r.name)).not.toContain('Base');
  });

  it('comes before WalletConnect', async () => {
    const ids = (await rows()).map((r) => r.id);
    expect(ids.indexOf('base')).toBeGreaterThan(-1);
    expect(ids.indexOf('base')).toBeLessThan(ids.indexOf('walletConnect'));
  });
});
