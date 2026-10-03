// @vitest-environment node
//
// An own-pool swap (`lp-swap`) through the shared send path: the transaction the REAL
// builder prepared, handed to a wallet that changes it. The fee, the payout account and
// the minimum hold on the wallet's copy, a refusal is said in the swap's words, and a
// send that is not confirmed is "unknown", never "failed". The other kinds are pinned,
// unedited, in submit.test.ts, submitLp.test.ts and submitCreate.test.ts.
import { describe, it, expect } from 'vitest';
import { Keypair, Transaction, TransactionInstruction, type PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { routeQuote } from '../../../solana/swap/ownRoute';
import { LP_FAILURE_COPY } from './errors';
import { LIGHTHOUSE_PROGRAM_ID } from './intent';
import { readPoolForWrite, type WriteSnapshot } from './liquidity';
import { prepareRouteSwap } from './routeSwap';
import { recheckOutcome, submitPrepared } from './submit';
import { CPSWAP, FakeChain, VAULT, addPool, cfgLocal, routeSwapSimulator, setClock } from './testkit.fixture';
import type { LpOpenGate, PreparedTx, RouteSwapSummary, TxSigner, WriteRpc } from './types';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const WALLET = Keypair.generate();
const ME = WALLET.publicKey;
const STRANGER = Keypair.generate().publicKey;
const NOW = 2_000_000_000n;
const OPEN: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'on' };
const ON = { routeMode: 'on' as const, feeEnv: { account: VAULT.toBase58(), bps: 50 } };
const failed = (code: number) => `Program ${CPSWAP.toBase58()} failed: custom program error: 0x${code.toString(16)}`;
const deps = { sleep: async () => {}, intervalMs: 1 };

async function ready(side: 'buy' | 'sell'): Promise<{ chain: FakeChain; p: PreparedTx; mint: PublicKey; pool: PublicKey }> {
  const chain = FakeChain.healthy();
  chain.addTier1().addFeeReceiver();
  chain.simulate = routeSwapSimulator();
  const mint = Keypair.generate().publicKey;
  chain.mint(mint, { decimals: 6 });
  const pool = addPool(chain, mint, { sol: 85n * 10n ** 9n, tokens: 200_000_000n * 10n ** 6n });
  setClock(chain, NOW);
  chain.fund(ME, 20_000_000_000);
  chain.tokenAccount(associatedTokenAddress(mint, ME), mint, ME, 10n ** 13n);
  const amountIn = side === 'buy' ? 1_000_000_000n : 2_000_000_000_000n;
  const snap = (await readPoolForWrite(W(chain), cfgLocal, { pool: pool.address, tokenMint: mint, owner: ME, forSwap: true })) as WriteSnapshot;
  const q = routeQuote(snap.view, side, amountIn, 50n, NOW)!;
  const r = await prepareRouteSwap(
    W(chain),
    OPEN,
    { owner: ME, pool: pool.address, tokenMint: mint, tokenDecimals: 6, side, amountIn, slippageBps: 50n, jupiterNet: q.netExpected, jupiterFee: 'charged', shownNet: q.netExpected },
    ON,
  );
  if (!r.ok) throw new Error(r.outcome.message);
  chain.calls = [];
  return { chain, p: r.prepared, mint, pool: pool.address };
}

const walletSigner = (edit?: (tx: Transaction) => Transaction): TxSigner => ({
  publicKey: ME,
  async signTransaction<T extends Transaction>(tx: T): Promise<T> {
    let copy = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    if (edit) copy = edit(copy);
    copy.partialSign(WALLET);
    return copy as T;
  },
});

const feeIxOf = (tx: Transaction) => tx.instructions.find((i) => i.programId.equals(TOKEN_PROGRAM_ID) && i.data[0] === 12)!;
const swapIxOf = (tx: Transaction) => tx.instructions.find((i) => i.programId.equals(CPSWAP))!;

async function refusedAtSign(side: 'buy' | 'sell', edit: (tx: Transaction, ctx: { mint: PublicKey }) => Transaction, why: RegExp) {
  const { chain, p, mint } = await ready(side);
  const o = await submitPrepared(W(chain), walletSigner((tx) => edit(tx, { mint })), p, deps);
  expect(o).toMatchObject({ status: 'not-sent', stage: 'sign' });
  if (o.status === 'not-sent') expect(o.message).toMatch(why);
  expect(chain.calls).not.toContain('sendRawTransaction');
}

describe('an own-pool swap the wallet hands back changed: refused before anything is sent', () => {
  it('the site fee raised by one unit (buy and sell)', async () => {
    const bump = (tx: Transaction) => {
      const d = feeIxOf(tx).data;
      d.writeBigUInt64LE(d.readBigUInt64LE(1) + 1n, 1);
      return tx;
    };
    await refusedAtSign('buy', bump, /the site fee is not 0\.5% of the SOL you pay/);
    await refusedAtSign('sell', bump, /the site fee is not 0\.5% of the minimum the pool must pay you/);
  });

  it('a second site fee', async () => {
    const twice = (tx: Transaction) => {
      const f = feeIxOf(tx);
      return tx.add(new TransactionInstruction({ programId: f.programId, keys: f.keys, data: Buffer.from(f.data) }));
    };
    await refusedAtSign('buy', twice, /does not pay the site fee exactly once/);
    await refusedAtSign('sell', twice, /does not pay the site fee exactly once/);
  });

  it('the fee sent to the wallet’s own wrapped-SOL account, or to a stranger’s', async () => {
    for (const to of [associatedTokenAddress(WSOL_MINT, ME), associatedTokenAddress(WSOL_MINT, STRANGER)]) {
      await refusedAtSign(
        'buy',
        (tx) => {
          const f = feeIxOf(tx);
          f.keys[2] = { ...f.keys[2]!, pubkey: to };
          return tx;
        },
        /somewhere other than the site's fee account/,
      );
    }
  });

  it('a lowered minimum: on a buy the changed instruction is caught; on a sell the fee no longer matches it', async () => {
    const lower = (by: bigint) => (tx: Transaction) => {
      const d = swapIxOf(tx).data;
      d.writeBigUInt64LE(d.readBigUInt64LE(16) - by, 16);
      return tx;
    };
    await refusedAtSign('buy', lower(1n), /removed or changed part of this transaction/);
    await refusedAtSign('sell', lower(1_000n), /the site fee is not 0\.5% of the minimum the pool must pay you/);
    // One unit lower on a sell can leave floor(0.5%) the same; the instruction itself still changed.
    await refusedAtSign('sell', lower(1n), /site fee is not 0\.5%|removed or changed part of this transaction/);
  });

  it('the payout sent to a stranger’s account', async () => {
    await refusedAtSign(
      'buy',
      (tx, { mint }) => {
        const s = swapIxOf(tx);
        s.keys[5] = { ...s.keys[5]!, pubkey: associatedTokenAddress(mint, STRANGER) };
        return tx;
      },
      /pays out to an account that is not yours/,
    );
  });

  it('a Lighthouse guard added by the wallet passes, is held to the same balance rows, and is sent', async () => {
    const { chain, p } = await ready('buy');
    const guard = new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from([1]) });
    const o = await submitPrepared(W(chain), walletSigner((tx) => tx.add(guard)), p, deps);
    expect(o.status).toBe('confirmed');
    expect(chain.calls).toContain('simulateTransaction');
  });
});

describe('an own-pool swap after it is sent', () => {
  it('a send that is never seen is UNKNOWN, never failed, and the note it writes first can keep the pool', async () => {
    const { chain, p, pool } = await ready('buy');
    chain.getBlockHeight = async () => p.lastValidBlockHeight + 1;
    chain.getSignatureStatuses = async () => ({ value: [null] });
    const order: string[] = [];
    chain.sendRawTransaction = async () => {
      order.push('send');
      return 'sent';
    };
    const o = await submitPrepared(W(chain), walletSigner(), p, { ...deps, onSent: (sig) => void order.push(`note:${sig.length > 40}`) });
    expect(o.status).toBe('unknown');
    if (o.status === 'unknown') expect(o.message).not.toMatch(/fail/i);
    expect(order[0]).toBe('note:true');
    expect(order).toContain('send');
    expect((p.summary as RouteSwapSummary).pool.equals(pool)).toBe(true);
  });

  it('a price pushed past the limit after the review is caught by the first send’s own check: not sent, in the swap’s words', async () => {
    const { chain, p } = await ready('sell');
    chain.sendRawTransaction = async () => {
      throw Object.assign(new Error('Transaction simulation failed'), { logs: [failed(6005)] });
    };
    const o = await submitPrepared(W(chain), walletSigner(), p, deps);
    expect(o).toMatchObject({ status: 'not-sent', stage: 'send' });
    if (o.status === 'not-sent') expect(o.message).toContain(LP_FAILURE_COPY['lp-swap'].exceededSlippage);
  });

  it('a swap that landed and was refused on price says so, with the pool program’s code (what a page demotes a pool on)', async () => {
    const { chain, p } = await ready('buy');
    chain.getSignatureStatuses = async () => ({ value: [{ err: { InstructionError: [7, { Custom: 6005 }] }, confirmationStatus: 'confirmed', slot: 9 }] });
    chain.getTransaction = async () => ({ meta: { logMessages: [failed(6005)] } });
    const o = await submitPrepared(W(chain), walletSigner(), p, deps);
    expect(o).toMatchObject({ status: 'reverted', program: 'cp-swap', code: 6005, message: LP_FAILURE_COPY['lp-swap'].exceededSlippage });
  });

  it('Check again on a swap’s note says a refusal in the swap’s words', async () => {
    const c = new FakeChain();
    c.getSignatureStatuses = async () => ({ value: [{ err: { InstructionError: [7, { Custom: 6000 }] }, confirmationStatus: 'finalized', slot: 9 }] });
    c.getTransaction = async () => ({ meta: { logMessages: [failed(6000)] } });
    expect(await recheckOutcome(W(c), '5'.repeat(88), { cfg: cfgLocal, kind: 'lp-swap' })).toMatchObject({ status: 'reverted', message: LP_FAILURE_COPY['lp-swap'].notApproved });
  });
});
