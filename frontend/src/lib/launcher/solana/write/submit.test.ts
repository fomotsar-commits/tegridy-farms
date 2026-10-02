// @vitest-environment node
//
// THE RULE: a transaction we only failed to CONFIRM is never reported as failed.
// Someone told "failed" presses the button again and pays twice. So every ending is
// pinned here with the evidence it needs: confirmed and reverted come from the
// network's own status; expired needs the block height PAST the transaction's last
// valid height AND no record in history; everything short of that is "unknown",
// carrying the signature.
import { describe, it, expect, vi } from 'vitest';
import { base58 } from '@scure/base';
import { Keypair, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { WSOL_MINT, cpPermissionPda, migrationAuthorityPda } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { quoteBuyOnCurve } from '../curve/math';
import { readCurve } from '../curve/read';
import { CP_CREATE_POOL_FEE_RECEIVER, readWriteGate } from './config';
import { LIGHTHOUSE_PROGRAM_ID } from './intent';
import { prepareCreateLaunch, quoteOpeningBuy } from './launch';
import { recheckOutcome, submitPrepared } from './submit';
import { prepareCurveBuy } from './trade';
import { CPSWAP, FakeChain, LAUNCH, VAULT, addPlantAccounts, cfgLocal, freshCurve, globalValue, plantMoved, rent } from './testkit.fixture';
import type { OpenGate, PreparedTx, TxOutcome, TxSigner, WriteRpc } from './types';

/** The fake answers every call the write path makes; Connection’s overloads are not worth re-typing. */
const W = (c: FakeChain) => c as unknown as WriteRpc;

const WALLET = Keypair.generate();
const ME = WALLET.publicKey;
const CREATOR = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const ATA = associatedTokenAddress(MINT, ME);

async function preparedBuy(): Promise<{ chain: FakeChain; p: PreparedTx; gate: OpenGate }> {
  const chain = FakeChain.healthy(globalValue());
  chain.set(cpPermissionPda(migrationAuthorityPda(LAUNCH), CPSWAP), { lamports: 1, owner: CPSWAP, data: new Uint8Array(8) });
  chain.tokenAccount(CP_CREATE_POOL_FEE_RECEIVER, WSOL_MINT, VAULT, 0n);
  chain.fund(ME, 10_000_000_000);
  chain.addCurve(freshCurve(MINT, CREATOR));
  const gate = (await readWriteGate(chain, cfgLocal)) as OpenGate;
  const c = await readCurve(chain, MINT, LAUNCH);
  if (c.kind !== 'ok') throw new Error('curve');
  const q = quoteBuyOnCurve(c.value.curve, 100_000_000n);
  if (!q.ok) throw new Error('quote');
  chain.simulate = (_v, config) => ({
    err: null,
    logs: [],
    unitsConsumed: 50_000,
    ...(config?.accounts
      ? {
          accounts: chain.post(config.accounts.addresses, {
            [ME.toBase58()]: { lamportsDelta: -(100_000_000 + rent(165)) },
            [ATA.toBase58()]: { tokenAmount: q.value.tokensOut, mint: MINT, owner: ME },
          }),
        }
      : {}),
  });
  const r = await prepareCurveBuy(W(chain), gate, { trader: ME, mint: MINT, curve: c.value, lamportsIn: 100_000_000n, slippageBps: 100n });
  if (!r.ok) throw new Error(r.outcome.message);
  chain.calls = [];
  return { chain, p: r.prepared, gate };
}

const walletSigner = (edit?: (tx: Transaction) => Transaction): TxSigner => ({
  publicKey: ME,
  async signTransaction<T extends Transaction>(tx: T): Promise<T> {
    // Behave like a Wallet Standard adapter: bytes out, a NEW Transaction back.
    let copy = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    if (edit) copy = edit(copy);
    copy.partialSign(WALLET);
    return copy as T;
  },
});

const deps = { sleep: async () => {}, intervalMs: 1 };
const clock = () => {
  let t = 0;
  return () => (t += 1_000);
};

const neverFailed = (o: TxOutcome) => {
  if (o.status === 'unknown') expect(o.message).not.toMatch(/fail/i);
};

describe('before anything is sent', () => {
  it('a declined signature is not-sent, says so, and never reaches the network', async () => {
    const { chain, p } = await preparedBuy();
    const o = await submitPrepared(W(chain), { publicKey: ME, signTransaction: async () => { throw new Error('User rejected the request.'); } }, p, deps);
    expect(o).toMatchObject({ status: 'not-sent', stage: 'sign', message: expect.stringMatching(/cancelled/) });
    expect(chain.calls).not.toContain('sendRawTransaction');
  });

  it('a different connected wallet is refused before signing', async () => {
    const { chain, p } = await preparedBuy();
    const o = await submitPrepared(W(chain), { ...walletSigner(), publicKey: Keypair.generate().publicKey }, p, deps);
    expect(o).toMatchObject({ status: 'not-sent', stage: 'sign' });
  });

  it('a wallet that ADDS a transfer to a stranger is refused, nothing sent', async () => {
    const { chain, p } = await preparedBuy();
    const stranger = Keypair.generate().publicKey;
    const o = await submitPrepared(W(chain), walletSigner((tx) => tx.add(SystemProgram.transfer({ fromPubkey: ME, toPubkey: stranger, lamports: 1 }))), p, deps);
    expect(o).toMatchObject({ status: 'not-sent', stage: 'sign', message: expect.stringMatching(/Your wallet changed this transaction/) });
    expect(chain.calls).not.toContain('sendRawTransaction');
  });

  it('a wallet that appends an assertion-only guard is accepted after a re-simulation', async () => {
    const { chain, p } = await preparedBuy();
    const guard = new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from([7]) });
    const o = await submitPrepared(W(chain), walletSigner((tx) => tx.add(guard)), p, deps);
    expect(o.status).toBe('confirmed');
    expect(chain.calls).toContain('simulateTransaction');
  });

  it('a wallet returning an unsigned transaction is refused (signatures verified)', async () => {
    const { chain, p } = await preparedBuy();
    const o = await submitPrepared(W(chain), { publicKey: ME, signTransaction: async (tx) => tx }, p, deps);
    expect(o).toMatchObject({ status: 'not-sent', stage: 'sign' });
    expect(chain.calls).not.toContain('sendRawTransaction');
  });

  it('a preflight rejection is not-sent, with the program’s reason', async () => {
    const { chain, p } = await preparedBuy();
    chain.sendRawTransaction = async () => {
      const e = new Error('Simulation failed. Message: Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1777.') as Error & { logs: string[] };
      e.logs = [`Program ${LAUNCH.toBase58()} failed: custom program error: 0x1777`];
      throw e;
    };
    const o = await submitPrepared(W(chain), walletSigner(), p, deps);
    expect(o).toMatchObject({ status: 'not-sent', stage: 'send', message: expect.stringMatching(/price moved past your limit.*Nothing was sent/) });
  });
});

describe('after it is sent', () => {
  it('confirmed, with the signature taken from the signed bytes before broadcast', async () => {
    const { chain, p } = await preparedBuy();
    let sentSig = '';
    chain.sendRawTransaction = async (raw: Uint8Array) => {
      chain.calls.push('sendRawTransaction');
      sentSig = base58.encode(Transaction.from(raw).signature!);
      return sentSig;
    };
    const o = await submitPrepared(W(chain), walletSigner(), p, deps);
    expect(o).toEqual({ status: 'confirmed', signature: sentSig, slot: 7 });
  });

  it('a network error on send is NOT "not sent": it watches, and reports what the chain says', async () => {
    const { chain, p } = await preparedBuy();
    let first = true;
    chain.sendRawTransaction = async () => {
      if (first) {
        first = false;
        throw new Error('fetch failed');
      }
      return 'x';
    };
    const o = await submitPrepared(W(chain), walletSigner(), p, deps);
    expect(o.status).toBe('confirmed');
  });

  it('status reads that fail are "not yet", then confirmed', async () => {
    const { chain, p } = await preparedBuy();
    let n = 0;
    chain.getSignatureStatuses = async () => {
      n++;
      if (n < 3) throw new Error('503');
      return { value: [{ err: null, confirmationStatus: 'finalized', slot: 9 }] };
    };
    const o = await submitPrepared(W(chain), walletSigner(), p, deps);
    expect(o).toMatchObject({ status: 'confirmed', slot: 9 });
  });

  // UXR12/R6-3: the card around a refusal says what it cost (network AND priority
  // fee). The message carries only the reason, so the cost is never said twice, and
  // never as "only the network fee".
  it('landed and reverted: names the program and gives the reason, without a fee sentence of its own', async () => {
    const { chain, p } = await preparedBuy();
    chain.getSignatureStatuses = async () => ({ value: [{ err: { InstructionError: [3, { Custom: 6007 }] }, confirmationStatus: 'confirmed', slot: 3 }] });
    chain.getTransaction = async () => ({ meta: { logMessages: [`Program ${LAUNCH.toBase58()} failed: custom program error: 0x1777`] } });
    const o = await submitPrepared(W(chain), walletSigner(), p, deps);
    expect(o).toMatchObject({ status: 'reverted', program: 'launch', code: 6007, message: expect.stringMatching(/price moved past your limit/) });
    expect(o.status === 'reverted' && o.message).not.toMatch(/fee/i);
  });

  // FS-1: the page must be able to write its "may still land" note BEFORE anything
  // leaves the browser, so a reload during the wait cannot hand back a fresh form.
  it('tells the page the signature and blockhash window before the first send, and not at all when nothing is signed', async () => {
    const { chain, p } = await preparedBuy();
    const order: string[] = [];
    let told: [string, number] | null = null;
    chain.sendRawTransaction = async (raw: Uint8Array) => {
      order.push(`send:${base58.encode(Transaction.from(raw).signature!)}`);
      return 'x';
    };
    const o = await submitPrepared(W(chain), walletSigner(), p, {
      ...deps,
      onSent: (sig, lvbh) => {
        told = [sig, lvbh];
        order.push(`sent:${sig}`);
      },
    });
    expect(o.status).toBe('confirmed');
    expect(told).toEqual([o.status === 'confirmed' ? o.signature : '', p.lastValidBlockHeight]);
    expect(order[0]).toBe(`sent:${told![0]}`);
    expect(order[1]).toBe(`send:${told![0]}`);

    const declined = vi.fn();
    const { chain: c2, p: p2 } = await preparedBuy();
    await submitPrepared(W(c2), { publicKey: ME, signTransaction: async () => { throw new Error('User rejected the request.'); } }, p2, { ...deps, onSent: declined });
    expect(declined).not.toHaveBeenCalled();
  });

  it('a page note that cannot be written does not stop the send', async () => {
    const { chain, p } = await preparedBuy();
    const o = await submitPrepared(W(chain), walletSigner(), p, { ...deps, onSent: () => { throw new Error('storage full'); } });
    expect(o.status).toBe('confirmed');
  });

  // FS-2: past the height, "no record" is proof only from a server that has caught up
  // to the finalized slot. A lagging server behind a load balancer has simply not
  // seen the block yet; told "safe to try again", the person pays twice.
  it('past the height, "no record" from servers BEHIND the finalized slot is UNKNOWN, never expired', async () => {
    const { chain, p } = await preparedBuy();
    chain.getBlockHeight = async () => p.lastValidBlockHeight + 1;
    chain.getSignatureStatuses = async () => ({ context: { slot: FakeChain.FINALIZED_SLOT - 40 }, value: [null] });
    const o = await submitPrepared(W(chain), walletSigner(), p, deps);
    expect(o.status).toBe('unknown');
    neverFailed(o);
    // A server that does not say where it is proves nothing either.
    chain.getSignatureStatuses = async () => ({ value: [null] });
    expect((await submitPrepared(W(chain), walletSigner(), p, deps)).status).toBe('unknown');
    // Nor when the finalized slot itself cannot be read.
    chain.getSignatureStatuses = async () => ({ context: { slot: FakeChain.FINALIZED_SLOT + 40 }, value: [null] });
    chain.getSlot = async () => {
      throw new Error('down');
    };
    expect((await submitPrepared(W(chain), walletSigner(), p, deps)).status).toBe('unknown');
  });

  it('past the height, one lagging "no record" and one caught-up "no record" is still not proof', async () => {
    const { chain, p } = await preparedBuy();
    chain.getBlockHeight = async () => p.lastValidBlockHeight + 1;
    let n = 0;
    chain.getSignatureStatuses = async () => ({ context: { slot: n++ % 2 ? FakeChain.FINALIZED_SLOT : FakeChain.FINALIZED_SLOT - 1 }, value: [null] });
    expect((await submitPrepared(W(chain), walletSigner(), p, deps)).status).toBe('unknown');
  });

  it('keeps RE-SENDING the same bytes, and reports EXPIRED only past the last valid height with no record', async () => {
    const { chain, p } = await preparedBuy();
    const sent: string[] = [];
    chain.sendRawTransaction = async (raw: Uint8Array) => {
      sent.push(Buffer.from(raw).toString('base64'));
      return 'x';
    };
    let height = p.lastValidBlockHeight - 3;
    chain.getBlockHeight = async () => height++;
    const history: boolean[] = [];
    chain.getSignatureStatuses = async (_s, o?: unknown) => {
      history.push(!!(o as { searchTransactionHistory?: boolean })?.searchTransactionHistory);
      return { context: { slot: FakeChain.FINALIZED_SLOT + 40 }, value: [null] };
    };
    const o = await submitPrepared(W(chain), walletSigner(), p, deps);
    expect(o.status).toBe('expired');
    if (o.status === 'expired') expect(o.message).toMatch(/safe to try again/);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(new Set(sent).size).toBe(1); // the SAME bytes every time
    expect(history[history.length - 1]).toBe(true); // the final check searched history
  });

  it('past the height but the history read fails: UNKNOWN, never expired, never failed', async () => {
    const { chain, p } = await preparedBuy();
    chain.getBlockHeight = async () => p.lastValidBlockHeight + 1;
    chain.getSignatureStatuses = async (_s, o?: unknown) => {
      if ((o as { searchTransactionHistory?: boolean })?.searchTransactionHistory) throw new Error('down');
      return { value: [null] };
    };
    const o = await submitPrepared(W(chain), walletSigner(), p, deps);
    expect(o.status).toBe('unknown');
    neverFailed(o);
    expect(o.status === 'unknown' && o.signature.length).toBeGreaterThan(40);
  });

  it('block height unreadable until the hard time limit: UNKNOWN with the signature', async () => {
    const { chain, p } = await preparedBuy();
    chain.getBlockHeight = async () => {
      throw new Error('down');
    };
    chain.getSignatureStatuses = async () => ({ value: [null] });
    const o = await submitPrepared(W(chain), walletSigner(), p, { ...deps, now: clock(), timeoutMs: 10_000 });
    expect(o.status).toBe('unknown');
    neverFailed(o);
  });

  // An error seen only at 'processed' is in a block that can still be dropped; the
  // same signed bytes can then land and succeed. Told "it did not go through", the
  // person tries again and pays twice.
  it('an error seen only at "processed" is NOT an ending: it keeps watching', async () => {
    const { chain, p } = await preparedBuy();
    let reads = 0;
    chain.getSignatureStatuses = async () => {
      reads++;
      return reads < 3
        ? { value: [{ err: { InstructionError: [3, { Custom: 6007 }] }, confirmationStatus: 'processed', slot: 3 }] }
        : { value: [{ err: null, confirmationStatus: 'confirmed', slot: 4 }] };
    };
    expect(await submitPrepared(W(chain), walletSigner(), p, deps)).toMatchObject({ status: 'confirmed', slot: 4 });
  });

  it('expiry is judged by the FINALIZED height: past it only at "confirmed" is not yet "expired"', async () => {
    const { chain, p } = await preparedBuy();
    chain.getBlockHeight = async (c?: unknown) => (c === 'finalized' ? p.lastValidBlockHeight : p.lastValidBlockHeight + 5);
    chain.getSignatureStatuses = async () => ({ value: [null] });
    const o = await submitPrepared(W(chain), walletSigner(), p, { ...deps, now: clock(), timeoutMs: 10_000 });
    expect(o.status).toBe('unknown');
    neverFailed(o);
  });

  it('past the height, one empty history read is not proof: a second read that finds it wins', async () => {
    const { chain, p } = await preparedBuy();
    chain.getBlockHeight = async () => p.lastValidBlockHeight + 1;
    let historyReads = 0;
    chain.getSignatureStatuses = async (_s, o?: unknown) => {
      if (!(o as { searchTransactionHistory?: boolean })?.searchTransactionHistory) return { value: [null] };
      historyReads++;
      return historyReads === 1 ? { value: [null] } : { value: [{ err: null, confirmationStatus: 'finalized', slot: 6 }] };
    };
    expect(await submitPrepared(W(chain), walletSigner(), p, deps)).toMatchObject({ status: 'confirmed', slot: 6 });
  });

  it('a history hit after the height passes is the real answer (it landed just in time)', async () => {
    const { chain, p } = await preparedBuy();
    chain.getBlockHeight = async () => p.lastValidBlockHeight + 1;
    chain.getSignatureStatuses = async (_s, o?: unknown) =>
      (o as { searchTransactionHistory?: boolean })?.searchTransactionHistory
        ? { value: [{ err: null, confirmationStatus: 'confirmed', slot: 5 }] }
        : { value: [null] };
    expect(await submitPrepared(W(chain), walletSigner(), p, deps)).toMatchObject({ status: 'confirmed', slot: 5 });
  });
});

describe('extra signers', () => {
  it('create: the wallet signs first, the mint key after, and every signature verifies', async () => {
    const chain = FakeChain.healthy(globalValue());
    chain.fund(ME, 10_000_000_000);
    addPlantAccounts(chain, ME);
    const gate = (await readWriteGate(chain, cfgLocal)) as OpenGate;
    const mintKp = Keypair.generate();
    const q = quoteOpeningBuy(gate.global, 10_000_000n);
    if (!q.ok) throw new Error('quote');
    const ata = associatedTokenAddress(mintKp.publicKey, ME);
    chain.simulate = (_v, config) => ({
      err: null,
      unitsConsumed: 100_000,
      ...(config?.accounts
        ? { accounts: chain.post(config.accounts.addresses, {
            [ME.toBase58()]: { lamportsDelta: -30_000_000 },
            [ata.toBase58()]: { tokenAmount: q.value.tokensOut, mint: mintKp.publicKey, owner: ME },
            // create_launch pays the platform reserve (369 bps of the supply) to the treasury.
            [associatedTokenAddress(mintKp.publicKey, VAULT).toBase58()]: {
              tokenAmount: (gate.global.tokenTotalSupply * gate.global.platformReserveBps) / 10_000n,
              mint: mintKp.publicKey,
              owner: VAULT,
            },
            // The plant: 100,000 $BAYLA leaves, 50,000 reaches the Workshop.
            ...plantMoved(ME),
          }) }
        : {}),
    });
    const r = await prepareCreateLaunch(W(chain), gate, {
      creator: ME, mint: mintKp, metadata: { name: 'T', symbol: 'TT', uri: 'https://ipfs.io/ipfs/x' }, openingBuy: { lamportsIn: 10_000_000n },
    });
    if (!r.ok) throw new Error(r.outcome.message);
    let seen: Transaction | null = null;
    chain.sendRawTransaction = async (raw: Uint8Array) => {
      seen = Transaction.from(raw);
      return 'x';
    };
    const o = await submitPrepared(W(chain), walletSigner(), r.prepared, deps);
    expect(o.status).toBe('confirmed');
    const tx = seen as unknown as Transaction;
    expect(tx.signatures.map((s) => s.publicKey.toBase58()).sort()).toEqual([ME.toBase58(), mintKp.publicKey.toBase58()].sort());
    expect(tx.verifySignatures()).toBe(true);
  });
});

describe('recheckOutcome', () => {
  it('confirmed / reverted / expired / unknown', async () => {
    const chain = new FakeChain();
    chain.getSignatureStatuses = async () => ({ value: [{ err: null, confirmationStatus: 'finalized', slot: 1 }] });
    expect((await recheckOutcome(W(chain), 'sig')).status).toBe('confirmed');
    chain.getSignatureStatuses = async () => ({ value: [{ err: { InstructionError: [0, { Custom: 6005 }] }, confirmationStatus: 'confirmed' }] });
    chain.getTransaction = async () => ({ meta: { logMessages: [`Program ${LAUNCH.toBase58()} failed: custom program error: 0x1775`] } });
    expect(await recheckOutcome(W(chain), 'sig', { cfg: cfgLocal })).toMatchObject({ status: 'reverted', program: 'launch', code: 6005 });
    chain.getSignatureStatuses = async () => ({ context: { slot: FakeChain.FINALIZED_SLOT }, value: [null] });
    chain.getBlockHeight = async () => 2_000;
    expect((await recheckOutcome(W(chain), 'sig', { lastValidBlockHeight: 1_000 })).status).toBe('expired');
    const u = await recheckOutcome(W(chain), 'sig');
    expect(u.status).toBe('unknown');
    // An error only at 'processed' can still be undone: not "reverted".
    chain.getSignatureStatuses = async () => ({ value: [{ err: { InstructionError: [0, { Custom: 6005 }] }, confirmationStatus: 'processed' }] });
    const up = await recheckOutcome(W(chain), 'sig', { cfg: cfgLocal });
    expect(up.status).toBe('unknown');
    neverFailed(up);
    // Expired only by the FINALIZED height.
    chain.getSignatureStatuses = async () => ({ value: [null] });
    chain.getBlockHeight = async (c?: unknown) => (c === 'finalized' ? 900 : 2_000);
    expect((await recheckOutcome(W(chain), 'sig', { lastValidBlockHeight: 1_000 })).status).toBe('unknown');
    chain.getBlockHeight = async () => 2_000;
    neverFailed(u);
    chain.getSignatureStatuses = async () => {
      throw new Error('down');
    };
    const u2 = await recheckOutcome(W(chain), 'sig', { lastValidBlockHeight: 1_000 });
    expect(u2.status).toBe('unknown');
    neverFailed(u2);
  });

  // FS-2: the page's "Check again" deletes its pending note on "expired", so the same
  // proof applies there.
  it('expired only from servers caught up to the finalized slot', async () => {
    const chain = new FakeChain();
    chain.getBlockHeight = async () => 2_000;
    chain.getSignatureStatuses = async () => ({ context: { slot: FakeChain.FINALIZED_SLOT - 1 }, value: [null] });
    const lag = await recheckOutcome(W(chain), 'sig', { lastValidBlockHeight: 1_000 });
    expect(lag.status).toBe('unknown');
    neverFailed(lag);
    chain.getSignatureStatuses = async () => ({ value: [null] });
    expect((await recheckOutcome(W(chain), 'sig', { lastValidBlockHeight: 1_000 })).status).toBe('unknown');
    chain.getSignatureStatuses = async () => ({ context: { slot: FakeChain.FINALIZED_SLOT }, value: [null] });
    expect((await recheckOutcome(W(chain), 'sig', { lastValidBlockHeight: 1_000 })).status).toBe('expired');
  });
});


