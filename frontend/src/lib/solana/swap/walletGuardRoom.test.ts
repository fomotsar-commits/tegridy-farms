// @vitest-environment node
//
// NODE, like the other Solana tests: under jsdom a Uint8Array from the other realm
// fails web3.js's address and encoding checks (the module itself never encodes with it).
//
// Room for the wallet's own safety check (walletGuardRoom.ts): every Jupiter swap asks
// for 30,000 more compute units, within the disclosed priority-fee cap. Read on Jupiter's
// own transactions, captured from its public API (__fixtures__/jupiterLive.ts).
import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { WALLET_GUARD_ROOM, withWalletGuardRoom } from './walletGuardRoom';
import { jupiterTxRefusal } from './jupiterTxGuard';
import { LIVE_USER, SWAP_SHARED_SOL_BAYLA, SWAP_SOL_BAYLA, SWAP_SOL_USDC, SWAP_USDC_SOL } from './__fixtures__/jupiterLive';

const CAP = 5_000_000; // jupiter.ts MAX_PRIORITY_LAMPORTS

const read = (b64: string) => VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
function budget(b64: string): { limit: number | null; price: bigint | null } {
  const tx = read(b64);
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  let limit: number | null = null;
  let price: bigint | null = null;
  for (const ix of tx.message.compiledInstructions) {
    if (keys[ix.programIdIndex] !== ComputeBudgetProgram.programId.toBase58()) continue;
    const d = Buffer.from(ix.data);
    if (d[0] === 2) limit = d.readUInt32LE(1);
    if (d[0] === 3) price = d.readBigUInt64LE(1);
  }
  return { limit, price };
}
const priorityLamports = (b: { limit: number | null; price: bigint | null }) => ((b.price ?? 0n) * BigInt(b.limit ?? 0) + 999_999n) / 1_000_000n;

function swap(limit: number | null, microLamports: bigint | null): string {
  const payer = Keypair.generate().publicKey;
  const ixs = [
    ...(limit === null ? [] : [ComputeBudgetProgram.setComputeUnitLimit({ units: limit })]),
    ...(microLamports === null ? [] : [ComputeBudgetProgram.setComputeUnitPrice({ microLamports })]),
    { programId: new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) },
  ];
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions: ixs }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

describe('a Jupiter swap gets room for the wallet’s own check', () => {
  it.each([
    ['SOL to USDC', SWAP_SOL_USDC],
    ['USDC to SOL', SWAP_USDC_SOL],
    ['SOL to BAYLA', SWAP_SOL_BAYLA],
    ['SOL to BAYLA, shared accounts', SWAP_SHARED_SOL_BAYLA],
  ])('%s: 30,000 more units, nothing else changed, and the guard still passes it', (_, live) => {
    const before = budget(live.tx);
    expect(before.limit).not.toBeNull();
    const out = withWalletGuardRoom(live.tx, CAP);
    const after = budget(out);
    expect(after.limit).toBe(before.limit! + WALLET_GUARD_ROOM);
    expect(after.price).toBe(before.price);
    // Same length, and only the limit's 4 bytes differ.
    const a = Buffer.from(live.tx, 'base64');
    const b = Buffer.from(out, 'base64');
    expect(b.length).toBe(a.length);
    expect([...a].filter((x, i) => x !== b[i]).length).toBeLessThanOrEqual(4);
    expect(jupiterTxRefusal(out, {
      kind: 'swap',
      user: LIVE_USER,
      quote: live.quote,
      feeBps: 50,
      feeAccount: live.feeAccount,
      maxPriorityLamports: CAP,
    })).toBeNull();
  });

  it('the BIG BRAIN buy of 11-15: Jupiter’s 49,411 for 39,936 used leaves the check 39,475, past the 13,952 + 1,818 it needed', () => {
    const out = budget(withWalletGuardRoom(swap(49_411, 6_709n), CAP));
    expect(out.limit).toBe(79_411);
    expect(out.limit! - 39_936).toBeGreaterThan(13_952 + 1_818);
  });

  it('cuts the price, never the room, when the total would pass the disclosed cap', () => {
    // Exactly at the cap before: 5,000,000 lamports on 100,000 units.
    const out = budget(withWalletGuardRoom(swap(100_000, 50_000_000n), CAP));
    expect(out.limit).toBe(130_000);
    expect(out.price).toBe((BigInt(CAP) * 1_000_000n) / 130_000n);
    expect(priorityLamports(out)).toBeLessThanOrEqual(BigInt(CAP));
  });

  it('never asks past Solana’s 1,400,000 ceiling', () => {
    expect(budget(withWalletGuardRoom(swap(1_390_000, 1n), CAP)).limit).toBe(1_400_000);
  });

  it('leaves alone a swap with no limit (every call has 200,000), a signed one, and anything unreadable', () => {
    const noLimit = swap(null, 1_000n);
    expect(withWalletGuardRoom(noLimit, CAP)).toBe(noLimit);
    const signed = read(swap(50_000, 1n));
    signed.signatures[0] = new Uint8Array(64).fill(7);
    const signedB64 = Buffer.from(signed.serialize()).toString('base64');
    expect(withWalletGuardRoom(signedB64, CAP)).toBe(signedB64);
    expect(withWalletGuardRoom('not base64 at all!', CAP)).toBe('not base64 at all!');
    expect(withWalletGuardRoom('AAAA', CAP)).toBe('AAAA');
  });
});
