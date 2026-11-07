// @vitest-environment node
//
// The swaps the robot builds for a trip the engine hands over: which arrays each walk carries,
// each instruction's accounts and bytes, and the reader's refusals. The amounts themselves are
// proven against mainnet by scripts/arb-route-proof.mjs (every venue paid exactly, 2026-11-07).
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { IX_SWAP_V2 } from '../../src/lib/solana/clmm/program.ts';
import * as V from './arb-venues.mjs';
import { DAMM_EVENT_AUTHORITY, DAMM_POOL_AUTHORITY, DAMM_PROGRAM, DLMM_EVENT_AUTHORITY, DLMM_PROGRAM, ORCA_MAX_SQRT_PRICE, ORCA_MIN_SQRT_PRICE, TAGS, dammSwapIx, dlmmSwapArrays, dlmmSwapIx, orcaSwapArrays, orcaSwapIx, routeLegReader } from './arb-legs.mjs';

const key = () => Keypair.generate().publicKey.toBase58();
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const owner = Keypair.generate().publicKey;
const pool = { address: key(), mintA: key(), mintB: key(), vaultA: key(), vaultB: key() };

describe('the instruction tags', () => {
  it('Orca’s swap_v2 shares Anchor’s tag with Raydium’s (both are "swap_v2")', () => {
    expect([...TAGS.orcaSwapV2]).toEqual([...IX_SWAP_V2]);
    expect(TAGS.dlmmSwap2).toHaveLength(8);
    expect(TAGS.dammSwap).toHaveLength(8);
    expect([...TAGS.dlmmSwap2]).not.toEqual([...TAGS.dammSwap]);
  });
});

describe('orcaSwapArrays: the three arrays in the walk’s direction', () => {
  const per = V.ORCA_TICKS_PER_ARRAY * 64;
  it('a → b walks down from the current tick’s array', () => {
    expect(orcaSwapArrays(pool.address, { tickCurrent: 100, tickSpacing: 64 }, true).map((a) => a.start)).toEqual([0, -per, -2 * per]);
  });
  it('b → a walks up, from one spacing above the current tick (a tick on an array’s last spacing starts the next array)', () => {
    expect(orcaSwapArrays(pool.address, { tickCurrent: 100, tickSpacing: 64 }, false).map((a) => a.start)).toEqual([0, per, 2 * per]);
    expect(orcaSwapArrays(pool.address, { tickCurrent: per - 1, tickSpacing: 64 }, false).map((a) => a.start)).toEqual([per, 2 * per, 3 * per]);
  });
  it('names each array by its PDA', () => {
    const [a] = orcaSwapArrays(pool.address, { tickCurrent: 100, tickSpacing: 64 }, true);
    expect(a.address).toBe(V.orcaArrayAddress(pool.address, 0));
  });
});

/** An LbPair whose map marks `inUse` bin arrays. */
function lbPair(activeId, inUse) {
  const bitmap = Array.from({ length: 16 }, () => 0n);
  for (const i of inUse) {
    const bit = i + 512;
    bitmap[bit >> 6] |= 1n << BigInt(bit & 63);
  }
  return { activeId, bitmap };
}

describe('dlmmSwapArrays: the active array and the next two in the walk’s direction, those in use', () => {
  it('x in (price falls) walks down; y in walks up; an array the map leaves out is not carried', () => {
    const p = lbPair(100, [-1, 0, 1, 3]);
    expect(dlmmSwapArrays(pool.address, p, true).map((a) => a.index)).toEqual([1, 0, -1]);
    expect(dlmmSwapArrays(pool.address, p, false).map((a) => a.index)).toEqual([1, 3]);
    expect(dlmmSwapArrays(pool.address, p, false)[0].address).toBe(V.dlmmArrayAddress(pool.address, 1));
  });
});

describe('orcaSwapIx', () => {
  const arrays = [key(), key(), key()];
  it('names the fifteen accounts of swap_v2 in the program’s order, the trader signing, and 43 bytes of data', () => {
    const ix = orcaSwapIx(pool, owner, true, 10n, 7n, arrays, [TOKEN, TOKEN_2022]);
    expect(ix.programId.toBase58()).toBe(V.WHIRLPOOL_PROGRAM);
    expect(ix.keys).toHaveLength(15);
    expect(ix.keys[0].pubkey.toBase58()).toBe(TOKEN);
    expect(ix.keys[1].pubkey.toBase58()).toBe(TOKEN_2022);
    expect(ix.keys[3]).toMatchObject({ pubkey: owner, isSigner: true, isWritable: false });
    expect(ix.keys[4]).toMatchObject({ isWritable: true });
    expect(ix.keys[4].pubkey.toBase58()).toBe(pool.address);
    expect(ix.keys.slice(11, 14).map((k) => k.pubkey.toBase58())).toEqual(arrays);
    expect(ix.keys[14].pubkey.toBase58()).toBe(V.orcaOracleAddress(pool.address));
    expect(ix.data).toHaveLength(43);
    expect([...ix.data.subarray(0, 8)]).toEqual([...TAGS.orcaSwapV2]);
    expect(ix.data.readBigUInt64LE(8)).toBe(10n);
    expect(ix.data.readBigUInt64LE(16)).toBe(7n);
    expect(ix.data[40]).toBe(1);
    expect(ix.data[41]).toBe(1);
    expect(ix.data[42]).toBe(0);
  });
  it('passes Orca’s own price bound for the direction: the lower one a → b, the upper one b → a', () => {
    const low = (ix) => ix.data.readBigUInt64LE(24) + (ix.data.readBigUInt64LE(32) << 64n);
    expect(low(orcaSwapIx(pool, owner, true, 1n, 1n, arrays, [TOKEN, TOKEN]))).toBe(ORCA_MIN_SQRT_PRICE);
    expect(low(orcaSwapIx(pool, owner, false, 1n, 1n, arrays, [TOKEN, TOKEN]))).toBe(ORCA_MAX_SQRT_PRICE);
    expect(orcaSwapIx(pool, owner, false, 1n, 1n, arrays, [TOKEN, TOKEN]).data[41]).toBe(0);
  });
});

describe('dlmmSwapIx', () => {
  it('names swap2’s sixteen accounts then the bin arrays, the program standing in for the absent optional ones, and 28 bytes of data', () => {
    const oracle = Keypair.generate().publicKey;
    const arrays = [key(), key()];
    const ix = dlmmSwapIx(pool, oracle, owner, true, 5n, 3n, arrays, [TOKEN, TOKEN]);
    expect(ix.programId.equals(DLMM_PROGRAM)).toBe(true);
    expect(ix.keys).toHaveLength(18);
    expect(ix.keys[0].pubkey.toBase58()).toBe(pool.address);
    expect(ix.keys[1].pubkey.equals(DLMM_PROGRAM)).toBe(true);
    expect(ix.keys[2].pubkey.toBase58()).toBe(pool.vaultA);
    expect(ix.keys[3].pubkey.toBase58()).toBe(pool.vaultB);
    expect(ix.keys[8]).toMatchObject({ pubkey: oracle, isWritable: true });
    expect(ix.keys[9].pubkey.equals(DLMM_PROGRAM)).toBe(true);
    expect(ix.keys[10]).toMatchObject({ pubkey: owner, isSigner: true });
    expect(ix.keys[14].pubkey.equals(DLMM_EVENT_AUTHORITY)).toBe(true);
    expect(ix.keys[15].pubkey.equals(DLMM_PROGRAM)).toBe(true);
    expect(ix.keys.slice(16).map((k) => k.pubkey.toBase58())).toEqual(arrays);
    expect(ix.data).toHaveLength(28);
    expect(ix.data.readBigUInt64LE(8)).toBe(5n);
    expect(ix.data.readBigUInt64LE(16)).toBe(3n);
    expect(ix.data.readUInt32LE(24)).toBe(0);
  });
  it('y in: the trader’s accounts are the pool’s B then A', () => {
    const ix = dlmmSwapIx(pool, Keypair.generate().publicKey, owner, false, 5n, 3n, [key()], [TOKEN, TOKEN_2022]);
    const ata = (mint, program) => PublicKey.findProgramAddressSync([owner.toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0];
    expect(ix.keys[4].pubkey.equals(ata(pool.mintB, TOKEN_2022))).toBe(true);
    expect(ix.keys[5].pubkey.equals(ata(pool.mintA, TOKEN))).toBe(true);
  });
});

describe('dammSwapIx', () => {
  it('names swap’s fourteen accounts, the pool authority first, and 24 bytes of data', () => {
    const ix = dammSwapIx(pool, owner, true, 9n, 4n, [TOKEN, TOKEN]);
    expect(ix.programId.equals(DAMM_PROGRAM)).toBe(true);
    expect(ix.keys).toHaveLength(14);
    expect(ix.keys[0].pubkey.equals(DAMM_POOL_AUTHORITY)).toBe(true);
    expect(ix.keys[1]).toMatchObject({ isWritable: true });
    expect(ix.keys[4].pubkey.toBase58()).toBe(pool.vaultA);
    expect(ix.keys[8]).toMatchObject({ pubkey: owner, isSigner: true });
    expect(ix.keys[11].pubkey.equals(DAMM_PROGRAM)).toBe(true);
    expect(ix.keys[12].pubkey.equals(DAMM_EVENT_AUTHORITY)).toBe(true);
    expect(ix.data).toHaveLength(24);
    expect([...ix.data.subarray(0, 8)]).toEqual([...TAGS.dammSwap]);
    expect(ix.data.readBigUInt64LE(8)).toBe(9n);
    expect(ix.data.readBigUInt64LE(16)).toBe(4n);
  });
  it('derives the authorities from the program', () => {
    expect(DAMM_POOL_AUTHORITY.equals(PublicKey.findProgramAddressSync([Buffer.from('pool_authority')], DAMM_PROGRAM)[0])).toBe(true);
    expect(DLMM_EVENT_AUTHORITY.equals(PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], DLMM_PROGRAM)[0])).toBe(true);
  });
});

describe('routeLegReader: refusals', () => {
  const ids = { cpmm: key(), ammV4: key(), ammV4Authority: key(), clmm: key() };
  const rpcWith = (accounts) => async (method, params) => {
    if (method !== 'getMultipleAccounts') throw new Error(method);
    return { context: { slot: 7 }, value: params[0].map((k) => accounts[k] ?? null) };
  };
  const rec = (dex, poolAddress) => ({ legs: [{ pool: poolAddress, dex, from: pool.mintA, to: pool.mintB, accounts: [] }], mints: {} });
  it('a pool the chain does not have', async () => {
    const read = routeLegReader({ rpc: rpcWith({}), ids });
    expect(await read(rec('dlmm', pool.address), owner, 1)).toBe(`pool ${pool.address} not found`);
  });
  it('a pool another program owns', async () => {
    const read = routeLegReader({ rpc: rpcWith({ [pool.address]: { owner: key(), data: ['AA==', 'base64'] } }), ids });
    expect(await read(rec('whirlpool', pool.address), owner, 1)).toBe(`pool ${pool.address} is not a Orca pool`);
  });
  it('an exchange it does not build for', async () => {
    const read = routeLegReader({ rpc: rpcWith({ [pool.address]: { owner: key(), data: ['AA==', 'base64'] } }), ids });
    expect(await read(rec('phoenix', pool.address), owner, 1)).toBe(`pool ${pool.address} is not a phoenix pool`);
  });
});
