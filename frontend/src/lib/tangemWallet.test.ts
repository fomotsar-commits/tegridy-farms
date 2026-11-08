import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tangemWallet } from './rainbowkitWallets';

/**
 * Tangem on the Ethereum connect modal (owner ask, 2026-11-01). Tangem has no
 * extension and no in-app browser, so its row is WalletConnect and nothing
 * else: the QR on a computer, a link into the Tangem app on a phone.
 */

/** Resolved from cwd, as rabbyWallet.test.ts explains. */
function source(file: string): string {
  return readFileSync(join(process.cwd(), 'src', 'lib', file), 'utf8');
}

describe('tangemWallet', () => {
  const w = tangemWallet({ projectId: 'test-project-id' });
  const URI = 'wc:pairtopic123@2?relay-protocol=irn&symKey=00';

  it('a phone tap opens the Tangem app with the pairing link, the form its apps accept', () => {
    expect(w.mobile?.getUri?.(URI)).toBe(`tangem://wc?uri=${encodeURIComponent(URI)}`);
  });

  it('a computer shows the plain URI as the QR, for the phone app to scan', () => {
    expect(w.qrCode?.getUri(URI)).toBe(URI);
  });

  it('is on the phone list: installed is undefined, never false', () => {
    // RainbowKit's phone list keeps only `installed ?? true`. False here would
    // drop the row on exactly the device Tangem's app runs on.
    expect(w.installed).toBeUndefined();
  });

  it('connects over WalletConnect only: there is no provider to inject', () => {
    const body = source('rainbowkitWallets.ts');
    const i = body.indexOf('export const tangemWallet');
    expect(i, 'tangemWallet is not in rainbowkitWallets.ts').toBeGreaterThan(-1);
    const own = body.slice(i, body.indexOf('\n});\n', i));
    expect(own).toContain('getWalletConnectConnector({ projectId, walletConnectParameters })');
    expect(own).not.toContain('getInjectedConnector');
  });

  it('goes in BARE right after WalletConnect, so the four rows a phone shows first stay as they were', () => {
    // Bare, like Trust: connectorsForWallets then passes the app metadata,
    // and the Tangem app shows the site's name when asked to approve it.
    expect(source('wagmi.ts')).toContain(
      'wallets: [safe, metaMask, phantomWallet, trustWallet, coinbase, walletConnect, tangemWallet, rainbow, rabbyWallet]',
    );
  });
});
