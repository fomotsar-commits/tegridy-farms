// The wallet fill reads the network it is asked for and no other. Trust Wallet's own
// browser carries an Ethereum provider at window.ethereum and its Solana provider at
// window.trustwallet.solana; a fill that asked Ethereum first could only ever hand that
// visitor an Ethereum address.
//
// MUTATION CHECKS
//  - walletFill.ts: drop `w.trustwallet?.solana` from solanaProviders. Every Trust test fails.
//  - walletFill.ts: make readInjectedAddress ask Ethereum before Solana whatever it is
//    asked for (the code before this file existed). "never touches the Ethereum one" fails.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { injectedNetworks, readInjectedAddress } from './walletFill';

const ETH = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';
const SOL = '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw';

const w = window as unknown as Record<string, unknown>;

afterEach(() => {
  for (const name of ['ethereum', 'solana', 'phantom', 'trustwallet']) delete w[name];
});

/** An Ethereum provider that has not authorised this page, and says yes when asked. */
function ethereumProvider() {
  return {
    isTrust: true,
    request: vi.fn(async ({ method }: { method: string }) =>
      method === 'eth_requestAccounts' ? [ETH] : [],
    ),
  };
}

/** Trust's Solana provider: no key until connect answers, and the options reach the wallet. */
function trustSolanaProvider({ trusted }: { trusted: boolean }) {
  const provider = {
    isTrust: true,
    publicKey: null as unknown,
    connect: vi.fn(async (options?: { onlyIfTrusted?: boolean }) => {
      if (options?.onlyIfTrusted && !trusted) throw new Error('This site has not been connected.');
      provider.publicKey = { toString: () => SOL };
      return { publicKey: provider.publicKey };
    }),
  };
  return provider;
}

describe('which networks the browser can answer for', () => {
  it('is neither with no provider', () => {
    expect(injectedNetworks()).toEqual({ ethereum: false, solana: false });
  });

  it('sees Trust’s Solana provider, which is at window.trustwallet.solana and nowhere else', () => {
    w.trustwallet = { solana: trustSolanaProvider({ trusted: false }) };
    expect(injectedNetworks()).toEqual({ ethereum: false, solana: true });
  });

  it('names both inside a wallet browser that carries both', () => {
    w.ethereum = ethereumProvider();
    w.trustwallet = { solana: trustSolanaProvider({ trusted: false }) };
    expect(injectedNetworks()).toEqual({ ethereum: true, solana: true });
  });

  it('does not count a thing named ethereum that cannot be asked', () => {
    w.ethereum = { isTrust: true };
    expect(injectedNetworks()).toEqual({ ethereum: false, solana: false });
  });
});

describe('asked for Solana', () => {
  it('reads Trust’s Solana provider and never touches the Ethereum one', async () => {
    const eth = ethereumProvider();
    const sol = trustSolanaProvider({ trusted: true });
    w.ethereum = eth;
    w.trustwallet = { solana: sol };
    expect(await readInjectedAddress('solana')).toBe(SOL);
    expect(eth.request).not.toHaveBeenCalled();
  });

  it('asks the wallet for connect({ onlyIfTrusted: true }) and for nothing else', async () => {
    const sol = trustSolanaProvider({ trusted: true });
    w.trustwallet = { solana: sol };
    await readInjectedAddress('solana');
    expect(sol.connect.mock.calls).toEqual([[{ onlyIfTrusted: true }]]);
  });

  it('answers null for a wallet that has not trusted this site, and still asks Ethereum nothing', async () => {
    const eth = ethereumProvider();
    w.ethereum = eth;
    w.trustwallet = { solana: trustSolanaProvider({ trusted: false }) };
    expect(await readInjectedAddress('solana')).toBeNull();
    expect(eth.request).not.toHaveBeenCalled();
  });

  it('takes a key a provider already shows, without calling connect', async () => {
    const connect = vi.fn();
    w.solana = { publicKey: { toString: () => SOL }, connect };
    expect(await readInjectedAddress('solana')).toBe(SOL);
    expect(connect).not.toHaveBeenCalled();
  });

  it('asks one provider once, however many names it is reachable under', async () => {
    const sol = trustSolanaProvider({ trusted: false });
    w.solana = sol;
    w.phantom = { solana: sol };
    w.trustwallet = { solana: sol };
    expect(await readInjectedAddress('solana')).toBeNull();
    expect(sol.connect).toHaveBeenCalledTimes(1);
  });

  it('lets a second wallet answer when the first refuses', async () => {
    w.solana = trustSolanaProvider({ trusted: false });
    w.trustwallet = { solana: trustSolanaProvider({ trusted: true }) };
    expect(await readInjectedAddress('solana')).toBe(SOL);
  });
});

describe('asked for Ethereum', () => {
  it('reads the Ethereum provider and never touches a Solana one', async () => {
    const sol = trustSolanaProvider({ trusted: true });
    w.ethereum = ethereumProvider();
    w.trustwallet = { solana: sol };
    expect(await readInjectedAddress('ethereum')).toBe(ETH);
    expect(sol.connect).not.toHaveBeenCalled();
  });

  it('answers null when the prompt is refused', async () => {
    w.ethereum = {
      request: vi.fn(async () => {
        throw new Error('User rejected the request.');
      }),
    };
    expect(await readInjectedAddress('ethereum')).toBeNull();
  });
});
