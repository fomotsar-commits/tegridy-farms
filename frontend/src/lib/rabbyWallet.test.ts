import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rabbyWallet } from './rainbowkitWallets';

/**
 * Rabby is the ONE wallet added from a field review that asked for nine.
 *
 * The review's premise — "the modal offers four wallets and your audience uses
 * fifteen" — was already half-answered by PR #359 (four became seven), and its
 * prescription would have made the MOBILE case worse: RainbowKit's mobile modal
 * is a horizontally-scrolling strip about four entries wide, and it renders only
 * wallets whose `installed` is true. Appending six WalletConnect-backed wallets
 * pushes the ones this venue's users actually reach for off the visible strip to
 * serve rows nobody scrolls to.
 *
 * Rabby is the exception because it costs no visible slot in any state:
 *   phone                      -> installed:false, not "ready", filtered out
 *   desktop WITH extension     -> deduped against EIP-6963 by rdns io.rabby
 *   desktop WITHOUT extension  -> the one state it exists for; EIP-6963 has
 *                                 nothing to announce and this row is the
 *                                 install path
 */
/**
 * The vendored definition's own source. Resolved from cwd, not import.meta.url:
 * vitest serves modules over http, so `new URL('./x', import.meta.url)` is not a
 * file:// URL and readFileSync rejects it.
 */
function vendoredRabbySource(): string {
  const src = readFileSync(join(process.cwd(), 'src', 'lib', 'rainbowkitWallets.ts'), 'utf8');
  const i = src.indexOf('export const rabbyWallet');
  // A guard that reads nothing passes forever — prove the slice landed.
  expect(i, 'rabbyWallet is not in rainbowkitWallets.ts').toBeGreaterThan(-1);
  return src.slice(i);
}

describe('rabbyWallet — vendored, injected-only', () => {
  const w = rabbyWallet();

  it('keeps the upstream identity so EIP-6963 can dedupe it', () => {
    // The dedupe is BY RDNS. A typo here does not fail loudly — it silently
    // shows Rabby twice to everyone who has the extension.
    expect(w.rdns).toBe('io.rabby');
    expect(w.id).toBe('rabby');
  });

  it('is injected-only, so it pulls in no WalletConnect peer', () => {
    // The reason it is safe in BOTH branches of wagmi.ts, including the
    // no-projectId fallback: a WalletConnect-backed wallet constructed without a
    // projectId throws at construction and takes the React root with it.
    const body = vendoredRabbySource();
    expect(body).toContain("getInjectedConnector({ flag: 'isRabby' })");
    expect(body).not.toContain('getWalletConnectConnector');
  });

  it('reports installed from a real provider probe, never a hardcoded true', () => {
    // THE MOBILE-MODAL TRAP. Forcing `installed: true` makes the row appear on a
    // phone and the tap silently do nothing, because no provider is behind it.
    // In jsdom there is no window.ethereum, so this must be false.
    expect(w.installed).toBe(false);
    const body = vendoredRabbySource();
    expect(body).toContain("installed: hasInjectedProvider({ flag: 'isRabby' })");
    expect(body).not.toMatch(/installed:\s*true/);
  });

  it('carries an install path, which is its whole reason to exist', () => {
    expect(w.downloadUrls?.browserExtension).toBe('https://rabby.io');
    expect(w.extension?.instructions?.steps?.length).toBeGreaterThan(0);
  });

  it('ships its own icon rather than fetching one at runtime', () => {
    expect(typeof w.iconUrl).toBe('function');
  });
});
