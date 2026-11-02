// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createConnector } from 'wagmi';
import type { Wallet } from '@rainbow-me/rainbowkit';
import { coinbaseWalletFromBase } from './rainbowkitWallets';

/**
 * The EVM list's Coinbase Wallet row on a phone (rainbowkitWallets.ts
 * coinbaseWalletFromBase). In an ordinary phone browser the tap opens this
 * page inside the Coinbase Wallet app; inside Coinbase's own browser, and on a
 * computer, it connects through Coinbase's SDK. The SDK connector is faked:
 * what is under test is which of the two happens.
 */
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
const DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const PAGE = 'https://memetics.finance/swap?from=SOL&to=BAYLA';
const APP_LINK = `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(PAGE)}`;

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

/** Replace location with a plain object so href assignment is observable. */
function setLocation(href: string) {
  Object.defineProperty(window, 'location', { value: { href }, writable: true, configurable: true });
}

function row() {
  const signIn = vi.fn(async () => ({ accounts: ['0x0000000000000000000000000000000000000001'], chainId: 1 }));
  const base = (): Wallet => ({
    id: 'base',
    name: 'Base',
    iconUrl: 'base.svg',
    iconBackground: '#0000FF',
    installed: true,
    createConnector: () =>
      createConnector(() => ({ id: 'baseAccount', name: 'Base Account', type: 'baseAccount', connect: signIn }) as never),
  });
  const connector = coinbaseWalletFromBase(base)(undefined).createConnector({ rkDetails: {} } as never)({} as never);
  return { connect: () => connector.connect(), signIn };
}

afterEach(() => {
  const w = window as unknown as Record<string, unknown>;
  delete w.ethereum;
  delete w.coinbaseSolana;
  delete w.coinbaseWalletExtension;
});

describe('Coinbase Wallet row, EVM list', () => {
  it.each([
    ['an iPhone', IPHONE],
    ['an Android phone', ANDROID],
  ])('on %s, outside Coinbase’s browser, opens this page in the Coinbase Wallet app', async (_, ua) => {
    setUserAgent(ua);
    setLocation(PAGE);
    const { connect, signIn } = row();
    await expect(connect()).rejects.toMatchObject({ name: 'UserRejectedRequestError' });
    expect(window.location.href).toBe(APP_LINK);
    expect(signIn).not.toHaveBeenCalled();
  });

  it('inside Coinbase’s own browser connects there, never sending the app back into itself', async () => {
    setUserAgent(IPHONE);
    setLocation(PAGE);
    (window as unknown as { ethereum: unknown }).ethereum = { isCoinbaseBrowser: true, isCoinbaseWallet: true };
    const { connect, signIn } = row();
    await connect();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(PAGE);
  });

  it('a Coinbase Solana provider alone also counts as Coinbase’s browser', async () => {
    setUserAgent(ANDROID);
    setLocation(PAGE);
    (window as unknown as { coinbaseSolana: unknown }).coinbaseSolana = {};
    const { connect, signIn } = row();
    await connect();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(PAGE);
  });

  it('on a computer opens Coinbase’s own sign-in, with no hand-off', async () => {
    setUserAgent(DESKTOP);
    setLocation(PAGE);
    const { connect, signIn } = row();
    await connect();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(PAGE);
  });
});
