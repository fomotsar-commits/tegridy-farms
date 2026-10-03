// @vitest-environment node
//
// Opening a pool through the shared send path (SPEC_S2_CREATE 3.2 "the wallet's
// version", 5.3): on the one-off path the wallet signs FIRST and this page's one-off
// key signs after it; a wallet that rewrites the fee account or the fee tier after the
// review, or drops the pool's own signature, is refused before anything is sent; and a
// refused opening found on Check again is said in the opening's own words.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Keypair, Transaction } from '@solana/web3.js';
import { WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { deriveAmmConfig, derivePool, deriveVault, publicTierConfig, sortMints } from '../../../solana/cpswap/program';
import { CP_CREATE_POOL_FEE_RECEIVER } from './config';
import { prepareLpCreate } from './createPool';
import { CREATE_FAILURE_COPY } from './errors';
import { recheckOutcome, submitPrepared } from './submit';
import { CPSWAP, FakeChain, TIER1_VALUES, cfgLocal, createSimulator } from './testkit.fixture';
import type { LpCreateSummary, LpOpenGate, PreparedTx, TxSigner, WriteRpc } from './types';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const WALLET = Keypair.generate();
const ME = WALLET.publicKey;
const OPEN: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'on' };
const TERMS = {
  createPoolFee: TIER1_VALUES.createPoolFee,
  tradeFeeRate: TIER1_VALUES.tradeFeeRate,
  protocolFeeRate: TIER1_VALUES.protocolFeeRate,
  fundFeeRate: TIER1_VALUES.fundFeeRate,
  creatorFeeRate: TIER1_VALUES.creatorFeeRate,
};
const deps = { sleep: async () => {}, intervalMs: 1 };

/** An opening prepared on the ONE-OFF path: a lamport gift sits at the standard address's wrapped-SOL vault. */
async function preparedOneOff(): Promise<{ chain: FakeChain; p: PreparedTx }> {
  const chain = FakeChain.healthy().addTier1().addFeeReceiver();
  chain.simulate = createSimulator();
  const mint = Keypair.generate().publicKey;
  chain.mint(mint, { decimals: 6 });
  chain.fund(ME, 20_000_000_000);
  chain.tokenAccount(associatedTokenAddress(mint, ME), mint, ME, 1_000_000_000n);
  const { token0, token1 } = sortMints(WSOL_MINT, mint);
  chain.fund(deriveVault(CPSWAP, derivePool(CPSWAP, publicTierConfig(CPSWAP), token0, token1), WSOL_MINT), 10_000_000);
  const r = await prepareLpCreate(W(chain), OPEN, { outsidePrice: async () => ({ kind: 'ok', solPerToken: 0.01, source: 'Jupiter' }) }, {
    owner: ME,
    tokenMint: mint,
    sol: 1_000_000_000n,
    token: 100_000_000n,
    shown: { terms: TERMS, standard: 'empty' },
  });
  if (!r.ok) throw new Error(r.outcome.message);
  expect((r.prepared.summary as LpCreateSummary).origin).toBe('other');
  chain.calls = [];
  return { chain, p: r.prepared };
}

const events: string[] = [];

/** A wallet that copies the transaction, applies `edit`, signs, and logs when it starts and finishes. */
const walletSigner = (edit?: (tx: Transaction) => Transaction): TxSigner => ({
  publicKey: ME,
  async signTransaction<T extends Transaction>(tx: T): Promise<T> {
    events.push('wallet:start');
    let copy = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    if (edit) copy = edit(copy);
    copy.partialSign(WALLET);
    events.push('wallet:end');
    return copy as T;
  },
});

const openingIx = (tx: Transaction) => tx.instructions.find((i) => i.programId.equals(CPSWAP))!;

afterEach(() => {
  vi.restoreAllMocks();
  events.length = 0;
});

describe('an opening at a one-off address through the shared send path', () => {
  it('the wallet signs first, then the pool’s own key; both signatures check out on what is sent', async () => {
    const { chain, p } = await preparedOneOff();
    const pool = (p.summary as LpCreateSummary).pool;
    const orig = Transaction.prototype.partialSign;
    vi.spyOn(Transaction.prototype, 'partialSign').mockImplementation(function (this: Transaction, ...signers) {
      for (const s of signers) events.push(`partialSign:${s.publicKey.equals(pool) ? 'pool' : s.publicKey.equals(ME) ? 'wallet-key' : 'other'}`);
      return orig.apply(this, signers);
    });
    let sent: Uint8Array | null = null;
    chain.sendRawTransaction = async (raw: Uint8Array) => {
      sent = raw;
      return 'sent';
    };
    const o = await submitPrepared(W(chain), walletSigner(), p, deps);
    expect(o.status).toBe('confirmed');
    expect(events).toEqual(['wallet:start', 'partialSign:wallet-key', 'wallet:end', 'partialSign:pool']);
    const tx = Transaction.from(sent!);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.signatures.map((s) => s.publicKey.toBase58()).sort()).toEqual([ME.toBase58(), pool.toBase58()].sort());
    expect(tx.signatures.every((s) => s.signature !== null)).toBe(true);
  });

  it.each([
    ['slot 12 (the fee account) swapped for another account', 12, () => Keypair.generate().publicKey, /the fee to open a pool goes somewhere other than the pool program's fee account/],
    ['slot 1 swapped for the launch tier', 1, () => deriveAmmConfig(CPSWAP, 0), /the pool would open on the launch tier \(fee tier 0\)/],
    ['slot 1 swapped for another tier', 1, () => deriveAmmConfig(CPSWAP, 2), /the pool would open on a fee tier this site does not use/],
  ])('a wallet that rewrites %s after the review: refused, nothing sent', async (_name, slot, to, reason) => {
    const { chain, p } = await preparedOneOff();
    const o = await submitPrepared(
      W(chain),
      walletSigner((tx) => {
        const ix = openingIx(tx);
        ix.keys[slot] = { ...ix.keys[slot]!, pubkey: to() };
        return tx;
      }),
      p,
      deps,
    );
    expect(o).toMatchObject({ status: 'not-sent', stage: 'sign' });
    if (o.status === 'not-sent') expect(o.message).toMatch(reason);
    expect(chain.calls).not.toContain('sendRawTransaction');
    expect(openingIx(p.tx).keys[12]!.pubkey.equals(CP_CREATE_POOL_FEE_RECEIVER)).toBe(true);
  });

  it('a wallet that drops the pool’s own signature: refused as a change of who signs, nothing sent', async () => {
    const { chain, p } = await preparedOneOff();
    const o = await submitPrepared(
      W(chain),
      walletSigner((tx) => {
        const ix = openingIx(tx);
        ix.keys[3] = { ...ix.keys[3]!, isSigner: false };
        // A legacy Transaction keeps every key it already holds a signature slot for as a
        // signer, so the wallet's new message must start without those slots.
        tx.signatures = [];
        return tx;
      }),
      p,
      deps,
    );
    expect(o).toMatchObject({ status: 'not-sent', stage: 'sign', message: 'Your wallet changed who has to sign this transaction, so nothing was sent.' });
    expect(chain.calls).not.toContain('sendRawTransaction');
  });
});

describe('Check again on an opening', () => {
  const sig = '5'.repeat(88);
  const CP = CPSWAP.toBase58();
  const SYS = '11111111111111111111111111111111';
  const landedRefused = (logs: string[], code: number) => {
    const c = new FakeChain();
    c.getSignatureStatuses = async () => ({ value: [{ err: { InstructionError: [3, { Custom: code }] }, confirmationStatus: 'finalized', slot: 9 }] });
    c.getTransaction = async () => ({ meta: { logMessages: logs } });
    return c;
  };

  it('a refused opening found on Check again carries the opening’s copy when the kind is passed', async () => {
    const off = landedRefused([`Program ${CP} failed: custom program error: 0x1770`], 6000);
    expect(await recheckOutcome(W(off), sig, { cfg: cfgLocal, kind: 'lp-create' })).toMatchObject({ status: 'reverted', message: CREATE_FAILURE_COPY.notApproved });
    const ran = landedRefused([`Program ${SYS} failed: custom program error: 0x0`, `Program ${CP} failed: custom program error: 0x0`], 0);
    expect(await recheckOutcome(W(ran), sig, { cfg: cfgLocal, kind: 'lp-create' })).toMatchObject({ status: 'reverted', message: CREATE_FAILURE_COPY.addressInUse });
    // Without the kind, the opening's words are never guessed.
    const plain = await recheckOutcome(W(off), sig, { cfg: cfgLocal });
    expect(plain.status === 'reverted' && plain.message).not.toBe(CREATE_FAILURE_COPY.notApproved);
  });
});
