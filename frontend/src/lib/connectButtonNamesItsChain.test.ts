// A Connect button that opens the ETHEREUM wallet list says so, on every
// surface where a visitor who came for Solana may be standing.
//
// A Trust wallet picked from that list is offered Ethereum, Robinhood Chain
// and Base and nothing else: no Ethereum connect can ask a wallet for Solana
// (lib/solanaSurface.ts). The owner's user met that twice (2026-10-02, 10-03),
// and a tester who had just connected Solana from the top bar read the Swap
// page's bare "Connect Wallet" as "you are not connected" (2026-10-03).
//
// The files below are the ones a sweep of every opener of that list judged a
// dead end for such a visitor. The pages left out act on Ethereum only and
// have no Solana content (TOWELI governance, the Gold Card, NFT finance, the
// Ethereum history): see the sweep in the pull request that added this file.
//
// MUTATION CHECKS
//  - Put `Connect Wallet` back as any of these buttons' words: its row fails.
//    As JSX text, in braces, in a ternary, through a variable, or with a small w.
//  - Drop `label={CONNECT_ETHEREUM_WALLET}` from a stock <ConnectButton />: its row fails.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONNECT_ETHEREUM_WALLET } from './copy';

const SURFACES = [
  'pages/TradePage.tsx',
  'pages/HomePage.tsx',
  'components/swap/DCATab.tsx',
  'components/swap/LimitOrderTab.tsx',
  'components/swap/TwapOrderPanel.tsx',
  'components/swap/TriggerOrderTab.tsx',
  'components/swap/LiquidityTab.tsx',
  'components/farm/LPFarmingSection.tsx',
  'components/farm/StakingCard.tsx',
  'components/ui/ConnectPrompt.tsx',
];

/** The source with its comments taken out: a comment may quote the old words. */
function code(file: string): string {
  return readFileSync(resolve(__dirname, '..', file), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('a Connect button that opens the Ethereum wallet list names Ethereum', () => {
  it('the words are plain and name the network', () => {
    expect(CONNECT_ETHEREUM_WALLET).toBe('Connect Ethereum wallet');
  });

  it.each(SURFACES)('%s', (file) => {
    const source = code(file);
    // It does open that list (else it has no place in this table).
    expect(source).toMatch(/openConnectModal|<ConnectButton\b/);
    // RainbowKit's stock button says "Connect Wallet" unless it is given a label.
    const stock = source.match(/<ConnectButton(?![.\w])[^>]*>/g) ?? [];
    for (const tag of stock) expect(tag, `${file}: ${tag}`).toContain('label={CONNECT_ETHEREUM_WALLET}');
    // The bare words, anywhere in code: JSX text, a string in braces or in a
    // ternary, a variable, either case. The first version of this test looked
    // for JSX text only, and every other spelling passed it (review, 2026-10-03).
    expect(source, `${file} still says "Connect Wallet" with no network`).not.toMatch(/connect\s+wallet\b/i);
    // Used, not only imported.
    expect(source.split('CONNECT_ETHEREUM_WALLET').length - 1).toBeGreaterThanOrEqual(2);
  });
});
