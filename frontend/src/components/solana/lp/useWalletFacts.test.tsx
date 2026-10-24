// The wallet read behind the panels' hints (panelKit.ts `useWalletFacts`): which coin it
// asks about, and that an answer for one coin is never shown for another.

import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import { TOKEN_PROGRAM } from '../../../lib/solana/lp/tokenSafety';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import type { LpReaders } from './readers';
import { useWalletFacts } from './panelKit';
import type { LpWrites } from './useLpWrites';

const OWNER = new PublicKey(new Uint8Array(32).fill(7));
const MINT = new PublicKey(new Uint8Array(32).fill(8)).toBase58();
const LP_MINT = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

type Ok = Extract<WalletFacts, { kind: 'ok' }>;
const base: Ok = {
  kind: 'ok',
  lamports: 5n * 10n ** 9n,
  token: null,
  wsol: { exists: false, amount: 0n },
  coin: null,
  lpAccountExists: false,
  rents: { walletFloor: 890_880n, tokenAccount165: 2_039_280n },
};
/** What the wallet holds on each coin's side, so an answer says which coin it is for. */
const factsFor = (quote: QuoteCoin | undefined): Ok =>
  !quote || quote.native
    ? { ...base, wsol: { exists: true, amount: 111n } }
    : { ...base, coin: { address: quote.mint, exists: true, amount: quote === USDC_QUOTE ? 222n : 333n } };

type WalletFn = LpReaders['wallet'];
const writesWith = (wallet: WalletFn) => ({ readers: { wallet } }) as unknown as LpWrites;

function mount(wallet: WalletFn, first: { quote?: QuoteCoin; opening?: true; lpMint?: string | null } = {}) {
  const writes = writesWith(wallet);
  return renderHook(
    (p: { quote?: QuoteCoin; opening?: true; lpMint?: string | null }) =>
      useWalletFacts(writes, OWNER, { tokenMint: MINT, tokenProgram: TOKEN_PROGRAM, lpMint: p.lpMint === undefined ? LP_MINT : p.lpMint, ...(p.opening ? { opening: true as const } : {}), ...(p.quote ? { quote: p.quote } : {}) }, 0),
    { initialProps: first },
  );
}

describe('useWalletFacts: which coin the wallet is asked about', () => {
  it.each([['no coin named', undefined], ['SOL named', SOL_QUOTE]] as const)('a SOL pool (%s) asks exactly as it always has: no options, or `opening` alone', async (_n, quote) => {
    const wallet = vi.fn<WalletFn>(async (_o, _m, _p, _l, opts) => factsFor(opts?.quote));
    const adding = mount(wallet, { quote });
    await waitFor(() => expect(adding.result.current).not.toBeNull());
    expect(wallet.mock.calls).toEqual([[OWNER, MINT, TOKEN_PROGRAM, LP_MINT]]);
    wallet.mockClear();
    const opening = mount(wallet, { quote, opening: true, lpMint: null });
    await waitFor(() => expect(opening.result.current).not.toBeNull());
    expect(wallet.mock.calls).toEqual([[OWNER, MINT, TOKEN_PROGRAM, null, { opening: true }]]);
  });

  it.each([['USDC', USDC_QUOTE], ['BAYLA', BAYLA_QUOTE]] as const)('a %s pool names its coin to the read, with `opening` when opening', async (_n, quote) => {
    const wallet = vi.fn<WalletFn>(async (_o, _m, _p, _l, opts) => factsFor(opts?.quote));
    const adding = mount(wallet, { quote });
    await waitFor(() => expect(adding.result.current).toEqual(factsFor(quote)));
    expect(wallet.mock.calls).toEqual([[OWNER, MINT, TOKEN_PROGRAM, LP_MINT, { quote }]]);
    wallet.mockClear();
    const opening = mount(wallet, { quote, opening: true, lpMint: null });
    await waitFor(() => expect(opening.result.current).toEqual(factsFor(quote)));
    expect(wallet.mock.calls).toEqual([[OWNER, MINT, TOKEN_PROGRAM, null, { opening: true, quote }]]);
  });
});

describe('useWalletFacts: switching coin never shows the other coin’s balance', () => {
  it('the SOL answer is dropped the moment the coin is USDC, and "reading" (null) is shown until USDC’s own answer is in', async () => {
    // Each read is released by hand, so the test sees the moment between the switch and the answer.
    const release: Array<(f: WalletFacts) => void> = [];
    const wallet = vi.fn<WalletFn>(() => new Promise<WalletFacts>((r) => release.push(r)));
    const h = mount(wallet, {});
    await waitFor(() => expect(release).toHaveLength(1));
    await act(async () => release[0]!(factsFor(SOL_QUOTE)));
    expect(h.result.current).toEqual(factsFor(SOL_QUOTE));

    h.rerender({ quote: USDC_QUOTE });
    // Same wallet, same token, same pool-share mint, same nonce: only the coin changed.
    expect(h.result.current).toBeNull();
    await waitFor(() => expect(release).toHaveLength(2));
    expect(wallet.mock.calls[1]).toEqual([OWNER, MINT, TOKEN_PROGRAM, LP_MINT, { quote: USDC_QUOTE }]);
    expect(h.result.current).toBeNull();
    await act(async () => release[1]!(factsFor(USDC_QUOTE)));
    expect(h.result.current).toEqual(factsFor(USDC_QUOTE));

    // And between two coins that are not SOL.
    h.rerender({ quote: BAYLA_QUOTE });
    expect(h.result.current).toBeNull();
    await waitFor(() => expect(release).toHaveLength(3));
    await act(async () => release[2]!(factsFor(BAYLA_QUOTE)));
    expect(h.result.current).toEqual(factsFor(BAYLA_QUOTE));
  });

  it('an answer that arrives after the coin changed is not shown for the new coin', async () => {
    const release: Array<(f: WalletFacts) => void> = [];
    const wallet = vi.fn<WalletFn>(() => new Promise<WalletFacts>((r) => release.push(r)));
    const h = mount(wallet, { quote: USDC_QUOTE });
    await waitFor(() => expect(release).toHaveLength(1));
    h.rerender({ quote: BAYLA_QUOTE });
    await waitFor(() => expect(release).toHaveLength(2));
    // USDC's answer lands late, while the form is on BAYLA.
    await act(async () => release[0]!(factsFor(USDC_QUOTE)));
    expect(h.result.current).toBeNull();
    await act(async () => release[1]!(factsFor(BAYLA_QUOTE)));
    expect(h.result.current).toEqual(factsFor(BAYLA_QUOTE));
  });
});
