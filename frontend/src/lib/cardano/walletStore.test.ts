import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAddressBech32 } from './address';
import { CIP30_WALLETS, detectWallets, sortWalletError } from './cip30';
import { connectCardanoWallet, disconnectCardanoWallet, getCardanoWallet, resetCardanoWalletForTests, restoreCardanoWallet } from './walletStore';

const TRADER = parseAddressBech32('addr1qyawx3jznhwfhsen5kg3dq4nxgvkexrw7fa6uj8qkx95cynn60n5e0298xn7eyj7lzks2lv5tcmxsqsu7ne7sa7jf4xsulzg6g')!;
const SCRIPT_WALLET = parseAddressBech32('addr1z84q0denmyep98ph3tmzwsmw0j7zau9ljmsqx6a4rvaau66j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq777e2a')!;

function fakeWallet(opts: { network?: number; address?: string; enabled?: boolean; refuse?: unknown } = {}) {
  const api = {
    getNetworkId: vi.fn(async () => opts.network ?? 1),
    getUtxos: vi.fn(async () => []),
    getChangeAddress: vi.fn(async () => opts.address ?? TRADER.hex),
    signTx: vi.fn(),
    submitTx: vi.fn(),
  };
  const wallet = {
    name: 'eternl',
    enable: vi.fn(async () => {
      if (opts.refuse) throw opts.refuse;
      return api;
    }),
    isEnabled: vi.fn(async () => opts.enabled ?? false),
  };
  (window as unknown as { cardano: unknown }).cardano = { eternl: wallet };
  return wallet;
}

beforeEach(() => resetCardanoWalletForTests());
afterEach(() => {
  delete (window as unknown as { cardano?: unknown }).cardano;
  localStorage.clear();
});

describe('the Cardano wallet connection', () => {
  it('offers no Yoroi, SecondFi, Nami or Flint', () => {
    const keys = CIP30_WALLETS.map((w) => w.walletId);
    for (const gone of ['yoroi', 'secondfi', 'nami', 'flint', 'ctrl']) expect(keys).not.toContain(gone);
  });

  it('detects only a wallet that can actually be enabled', () => {
    (window as unknown as { cardano: unknown }).cardano = { eternl: { enable: () => 0, isEnabled: () => 0 }, lace: { name: 'Lace' } };
    const found = detectWallets(window).filter((w) => w.installed).map((w) => w.info.walletId);
    expect(found).toEqual(['eternl']);
  });

  it('connects on a press, keeping the whole address', async () => {
    fakeWallet();
    await connectCardanoWallet('eternl');
    const s = getCardanoWallet();
    expect(s.status).toBe('connected');
    if (s.status === 'connected') expect(s.address.hex).toBe(TRADER.hex);
  });

  it('refuses a test network and a script wallet', async () => {
    fakeWallet({ network: 0 });
    await connectCardanoWallet('eternl');
    expect(getCardanoWallet()).toMatchObject({ status: 'error', message: expect.stringMatching(/test network/) });
    resetCardanoWalletForTests();
    fakeWallet({ address: SCRIPT_WALLET.hex });
    await connectCardanoWallet('eternl');
    expect(getCardanoWallet()).toMatchObject({ status: 'error', message: expect.stringMatching(/script wallet/) });
  });

  it('tells a decline from a failure', async () => {
    fakeWallet({ refuse: { code: -3, info: 'user declined' } });
    await connectCardanoWallet('eternl');
    expect(getCardanoWallet()).toMatchObject({ status: 'error', message: expect.stringMatching(/declined/) });
    expect(sortWalletError({ code: -2 }, 'enable')).toBe('failed');
    expect(sortWalletError({ code: 2 }, 'sign')).toBe('declined');
    expect(sortWalletError(new Error('boom'), 'sign')).toBe('failed');
  });

  it('restores on load only a wallet this browser connected that still says it is connected, without a prompt', async () => {
    const w = fakeWallet({ enabled: false });
    await restoreCardanoWallet();
    expect(w.enable).not.toHaveBeenCalled(); // nothing remembered
    localStorage.setItem('tegridy.cip30.wallet', 'eternl');
    await restoreCardanoWallet();
    expect(w.enable).not.toHaveBeenCalled(); // remembered, but the wallet says not connected
    resetCardanoWalletForTests();
    const w2 = fakeWallet({ enabled: true });
    localStorage.setItem('tegridy.cip30.wallet', 'eternl');
    await restoreCardanoWallet();
    expect(w2.enable).toHaveBeenCalledTimes(1);
    expect(getCardanoWallet().status).toBe('connected');
  });

  it('forgets on disconnect', async () => {
    fakeWallet();
    await connectCardanoWallet('eternl');
    disconnectCardanoWallet();
    expect(getCardanoWallet()).toEqual({ status: 'idle' });
    expect(localStorage.getItem('tegridy.cip30.wallet')).toBeNull();
  });
});
