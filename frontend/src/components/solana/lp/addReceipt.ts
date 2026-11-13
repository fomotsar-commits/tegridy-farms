import type { Connection } from '@solana/web3.js';
import { RECEIPT_WORDS } from '../../../lib/arrival';
import { bungalowByAddress } from '../../../lib/bungalows';
import { lastReading } from '../../../lib/heat/heatStore';
import { clockFor, holdersFor, raiseReceipt, settleReceipt } from '../../../lib/receipt';
import { SOLANA_FEE_ACCOUNT } from '../../../lib/solana';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { settleAddReceipt, type FeeRoute } from '../../../lib/solana/receiptRead';
import type { LpReaders } from './readers';

/**
 * An add that landed ends on the receipt card (island answer twenty-five, build 6): it rises at
 * once, and what went in, with the fee, is then read from the signature. An add of both coins
 * pays the pool no fee; an add made with one coin shows its swap leg's fee, read from step 1.
 * The pool's other LPs are then read (`holders`, the readers' own; island answer thirty-two):
 * that many bricks on the card's floor besides the adder's.
 */
export function raiseAddReceipt(
  rpc: Pick<Connection, 'getTransaction'>,
  signature: string,
  // `holders` is always passed, the reader's own or undefined: a call that forgets it is a type error.
  // `named`: `ticker` is a ticker of the coin's own (identity.ts ownTicker), not "tokens" or a copy's "fake X".
  a: { view: PoolView; wallet: string; ticker: string; named: boolean; decimals: number; leg?: { signature: string; paid: 'quote' | 'token' }; holders: LpReaders['holders'] },
): void {
  const { view } = a;
  const island = bungalowByAddress('solana', view.tokenMint) !== null;
  raiseReceipt({
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    wallet: a.wallet,
    action: 'added',
    coin: { symbol: a.ticker, mint: view.tokenMint },
    island,
    pairing: view.quote.symbol,
    unnamed: !a.named,
    title: null,
    under: RECEIPT_WORDS.addedTo(view.quote.symbol, a.ticker),
    fee: { kind: 'reading' },
    clock: clockFor('added', view.tokenMint, a.wallet, lastReading(), island),
    holders: holdersFor(view.tokenMint, a.wallet, lastReading()),
    lps: null,
  });
  // The read is at 'confirmed', like the add, so the adder's own share is in it: it is their
  // brick, already on the floor, and is left out of the count. A read that fails leaves null:
  // the floor is bedrock and the adder, never a wrong count.
  void a
    .holders?.(view)
    .then((r) => settleReceipt(signature, { lps: r.kind === 'ok' ? r.holders.filter((h) => h.owner !== a.wallet).length : null }))
    .catch(() => undefined);
  const quote = { mint: view.quote.mint, symbol: view.quote.symbol, decimals: view.quote.decimals };
  const token = { mint: view.tokenMint, symbol: a.ticker, decimals: a.decimals };
  // With the pool's fee settings unread, a swap leg in this pool cannot be split: its row says so.
  const route: FeeRoute = view.config
    ? { kind: 'auto', pool: view.address, rates: { protocolFeeRate: view.config.protocolFeeRate, fundFeeRate: view.config.fundFeeRate }, feeOwner: SOLANA_FEE_ACCOUNT || null }
    : { kind: 'pool', pool: '', rates: { protocolFeeRate: 0n, fundFeeRate: 0n } };
  void settleAddReceipt(rpc, signature, {
    pool: view.address,
    quote,
    token,
    quoteIsToken0: view.quoteIsToken0,
    leg: a.leg ? { signature: a.leg.signature, route, paid: a.leg.paid === 'quote' ? quote : token } : null,
  });
}
