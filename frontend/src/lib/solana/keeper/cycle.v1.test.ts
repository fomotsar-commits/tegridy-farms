// @vitest-environment node
//
// The send step with KEEPER_V1: a trip too big for a legacy transaction (three swaps through two
// PumpSwap pools name 43 accounts) is test-run and sent as a version 1 transaction, the usual
// way and never through Jito; off, it is skipped as before; a trip that fits is untouched. The
// chain is made up here; the step itself runs as it does live (keeper/cycle.jito.test.ts's rig).
import { describe, it, expect, vi } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { decompileTransactionMessage, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { SOL_QUOTE } from '../lp/quotes';
import { DEFAULT_SETTINGS, sendChecked, type KeeperIo, type Trip, type TripRecord } from './cycle';
import { DEFAULT_LIMITS } from './plan';
import { isV1, type TripTx } from './v1tx';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM = '11111111111111111111111111111111';
const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const key = () => Keypair.generate().publicKey;
const token = (amount: bigint) => {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { data: [Buffer.from(data).toString('base64'), 'base64'], owner: TOKEN_PROGRAM, lamports: 2_039_280, executable: false, rentEpoch: 0 };
};
const wallet = (lamports: bigint) => ({ data: ['', 'base64'], owner: SYSTEM, lamports: Number(lamports), executable: false, rentEpoch: 0 });
const HELD = 1_000_000_000n;
const GAIN = 1_000_000n;
const FLOOR = 100_000n;
const LAMPORTS = 50_000_000n;
const LOADED = 13_773_260; // what the GRR trip's test run loaded on mainnet

/** A swap naming `n` accounts of its own, as a PumpSwap leg names its pool's. */
const swap = (n: number, tag: number) =>
  new TransactionInstruction({ programId: key(), keys: Array.from({ length: n }, () => ({ pubkey: key(), isSigner: false, isWritable: true })), data: Buffer.from([tag, 0, 0, 0, 0, 0, 0, 0, 1]) });

function rig(legs: TransactionInstruction[]) {
  const owner = key();
  const accounts = { coinAta: key(), tokenAta: key(), otherAta: key(), tokenMint: key(), tokenProgram: new PublicKey(TOKEN_PROGRAM), coinMint: new PublicKey(SOL_QUOTE.mint) };
  let balanceReads = 0;
  const simulated: string[] = [];
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'getLatestBlockhash') return { value: { blockhash: key().toBase58(), lastValidBlockHeight: 400_000_000 } };
    if (method === 'simulateTransaction') {
      simulated.push(params[0] as string);
      return { value: { err: null, unitsConsumed: 200_000, loadedAccountsDataSize: LOADED, accounts: [token(HELD + GAIN), token(0n), token(0n), wallet(LAMPORTS)] } };
    }
    if (method === 'getMultipleAccounts') {
      const reads = balanceReads++;
      return { value: reads === 0 ? [token(HELD), null, token(0n), wallet(LAMPORTS)] : [token(HELD + GAIN), null, token(0n), wallet(LAMPORTS - 10_000n)] };
    }
    throw new Error(`unexpected ${method}`);
  });
  const trip: Trip = {
    name: 'T', kind: 'engine', pool: 'P1 → P2 → P3', coin: SOL_QUOTE, coinIn: 10_000_000n, accounts,
    before: { coin: HELD, token: 0n, tokenExists: true, other: 0n, otherExists: true, lamports: LAMPORTS },
    legs, lookupTables: [], floor: FLOOR, verdict: () => null, says: (g) => `gains ${g}`,
  };
  const sent: TripTx[] = [];
  const toJito: TripTx[] = [];
  const records: TripRecord[] = [];
  const log = vi.fn();
  const io = {
    rpc, owner, log, record: (r: TripRecord) => records.push(r),
    send: vi.fn(async (tx: TripTx) => (sent.push(tx), { signature: 'S1', outcome: 'confirmed' as const })),
    sendJito: vi.fn(async (tx: TripTx) => (toJito.push(tx), { signature: 'J1', outcome: 'confirmed' as const })),
  } as unknown as KeeperIo;
  return { io, trip, sent, toJito, records, log, simulated };
}
const settings = (v1: boolean) => ({ ...DEFAULT_LIMITS, ...DEFAULT_SETTINGS, raydiumPrograms: [], jito: true, v1 });
const BIG = () => [swap(15, 1), swap(15, 2), swap(13, 3)];
const said = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map((c) => String(c[0])).join('\n');

describe('sendChecked with KEEPER_V1', () => {
  it('test-runs and sends a trip too big for a legacy transaction as version 1, the usual way', async () => {
    const r = rig(BIG());
    expect(await sendChecked(r.io, settings(true), r.trip)).toBe('sent');
    expect(r.toJito).toHaveLength(0);
    expect(r.sent).toHaveLength(1);
    const tx = r.sent[0]!;
    expect(isV1(tx)).toBe(true);
    // The test run was asked about version 1 bytes too.
    const ran = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(r.simulated[0]!, 'base64')).messageBytes);
    expect(ran.version).toBe(1);
    // The sent message: the test run's units plus a fifth and 10,000, its priority fee, the
    // loaded-data limit from the test run, no ComputeBudget instruction, the Lighthouse check last.
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode((tx as { wire: Uint8Array }).wire).messageBytes));
    expect(message.config).toMatchObject({ computeUnitLimit: 250_000, priorityFeeLamports: 2_500n, loadedAccountsDataSizeLimit: 526 * 32 * 1024 });
    const programs = message.instructions.map((ix) => String(ix.programAddress));
    expect(programs).not.toContain(ComputeBudgetProgram.programId.toBase58());
    expect(programs.at(-1)).toBe(LIGHTHOUSE);
    expect(programs).toHaveLength(4);
    expect(said(r.log)).toMatch(/a version 1 transaction, \d+ bytes: too big for a legacy one/);
    expect(said(r.log)).toMatch(/a version 1 transaction is not sent through Jito/);
    expect(r.records[0]).toMatchObject({ outcome: 'confirmed', gained: GAIN });
  });

  it('skips the same trip as before when KEEPER_V1 is off', async () => {
    const r = rig(BIG());
    expect(await sendChecked(r.io, settings(false), r.trip)).toBe('no-plan');
    expect(r.sent).toHaveLength(0);
    expect(r.toJito).toHaveLength(0);
    expect(said(r.log)).toMatch(/do not fit in one transaction/);
  });

  it('leaves a trip that fits as it was: v0, through Jito with its tip', async () => {
    const r = rig([swap(3, 1), swap(3, 2)]);
    expect(await sendChecked(r.io, settings(true), r.trip)).toBe('sent');
    expect(r.sent).toHaveLength(0);
    expect(r.toJito).toHaveLength(1);
    expect(r.toJito[0]).toBeInstanceOf(VersionedTransaction);
  });
});
