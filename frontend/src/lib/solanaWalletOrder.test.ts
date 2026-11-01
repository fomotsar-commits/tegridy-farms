import { describe, it, expect } from 'vitest';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import type { Wallet } from '@solana/wallet-adapter-react';
import {
  PHONE_WALLET_ROW,
  hasExtension,
  opensInWalletApp,
  orderWallets,
  rowStatus,
  waitedOnWalletLabel,
  walletLabel,
} from './solanaWalletOrder';
import { TangemWalletName } from './solanaWalletConnect';

/** A row as orderWallets reads it: an adapter name and a ready state. */
function row(name: string, readyState: WalletReadyState): Wallet {
  return { adapter: { name }, readyState } as unknown as Wallet;
}

const { Installed, Loadable, NotDetected } = WalletReadyState;

function listed(wallets: Wallet[]): string[] {
  return orderWallets(wallets).map((w) => `${walletLabel(w.adapter.name)} | ${rowStatus(w.readyState, w.adapter.name)}`);
}

/**
 * Inside a wallet app's own browser (phone walk of production, 2026-10-03). The
 * app registered its wallet as "Trust Wallet"; our Trust row is named "Trust",
 * so WalletProvider's dedupe by exact name kept both, and both read "Trust
 * Wallet". The second one is a link OUT of the browser the visitor is already
 * in, to the app they are already in.
 */
describe('orderWallets: a wallet detected in this browser is listed once', () => {
  it('drops the "Open app" row of a wallet whose own registration is detected', () => {
    expect(
      listed([
        row('Trust Wallet', Installed),
        row('Phantom', Loadable),
        row('Trust', Loadable),
        row('Solflare', Loadable),
      ]),
    ).toEqual(['Trust Wallet | Detected', 'Phantom | Open app', 'Solflare | Open app']);
  });

  it('drops its "Install" row too, the same wallet in a browser that cannot hand off', () => {
    expect(listed([row('Trust Wallet', Installed), row('Trust', NotDetected), row('Phantom', NotDetected)])).toEqual([
      'Trust Wallet | Detected',
      'Phantom | Install',
    ]);
  });

  it('keeps the row when the wallet of that label is NOT detected (the control)', () => {
    expect(listed([row('Phantom', Installed), row('Trust', Loadable)])).toEqual([
      'Phantom | Detected',
      'Trust Wallet | Open app',
    ]);
  });

  it('never drops a detected wallet, even two under one label: each of them connects', () => {
    expect(listed([row('Trust Wallet', Installed), row('Trust', Installed)])).toEqual([
      'Trust Wallet | Detected',
      'Trust Wallet | Detected',
    ]);
  });
});

/**
 * WalletProvider adds this row itself on Android Chrome. It was listed under
 * the protocol's name, which no visitor knows (phone walk, 2026-10-03).
 */
describe('the row that asks Android for a wallet app', () => {
  it('is the name WalletProvider gives its own adapter', () => {
    expect(PHONE_WALLET_ROW).toBe('Mobile Wallet Adapter');
  });

  it('says what it is, not the name of its protocol', () => {
    expect(walletLabel(PHONE_WALLET_ROW)).toBe('Any wallet app');
    expect(rowStatus(Loadable, PHONE_WALLET_ROW)).toBe('Open app');
  });

  it('is called "your wallet app" in a sentence about waiting on it', () => {
    expect(waitedOnWalletLabel(PHONE_WALLET_ROW)).toBe('your wallet app');
    // The other rows keep their own names there, and WalletConnect none.
    expect(waitedOnWalletLabel('Trust')).toBe('Trust Wallet');
    expect(waitedOnWalletLabel('WalletConnect')).toBeNull();
  });

  it('stays after the wallets this venue offers by name', () => {
    expect(listed([row(PHONE_WALLET_ROW, Loadable), row('Phantom', Loadable), row('Backpack', Loadable)])).toEqual([
      'Phantom | Open app',
      'Backpack | Open app',
      'Any wallet app | Open app',
    ]);
  });
});

/**
 * Tangem (owner ask, 2026-11-01): a card wallet whose phone app connects over
 * WalletConnect only. Its row scans the QR on a computer and opens the app on a
 * phone, where the connection comes back to this page.
 */
describe('the Tangem row', () => {
  it('is offered under the exact name its adapter registers (solanaWalletConnect.ts)', () => {
    // An offered wallet ranks ahead of one that is not, whatever order they come in.
    expect(listed([row('Glow', Loadable), row(TangemWalletName, Loadable)])).toEqual([
      'Tangem | Open app',
      'Glow | Open app',
    ]);
  });

  it('shows the QR where the QR row exists, and says so', () => {
    expect(rowStatus(NotDetected, 'Tangem', true)).toBe('Scan QR code');
  });

  it('on a phone says it opens the app, but never reopens this page inside it', () => {
    expect(rowStatus(Loadable, 'Tangem')).toBe('Open app');
    expect(opensInWalletApp(Loadable, 'Tangem')).toBe(false);
    // The control: the offered wallets that do reopen the page still do.
    expect(opensInWalletApp(Loadable, 'Trust')).toBe(true);
  });

  it('offers no extension in place of its QR; Trust and Jupiter still do', () => {
    expect(hasExtension('Tangem')).toBe(false);
    expect(hasExtension('Trust')).toBe(true);
    expect(hasExtension('Jupiter')).toBe(true);
  });

  it('comes after the other wallets offered by name', () => {
    expect(listed([row('Tangem', Loadable), row('Backpack', Loadable), row('Phantom', Loadable)])).toEqual([
      'Phantom | Open app',
      'Backpack | Open app',
      'Tangem | Open app',
    ]);
  });
});
