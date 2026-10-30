// @vitest-environment node
// The room LP door rule (roomLpDoors.ts) on canned pools: no test here touches the
// network. The live run against mainnet is roomLpDoors.onchain.test.ts, in the daily
// registry-onchain.yml job.
import { describe, it, expect } from 'vitest';
import { base58 } from '@scure/base';
import { BUNGALOWS } from '../lib/bungalows';
import { PublicKey } from '@solana/web3.js';
import { ACCOUNT_POOL_STATE, POOL_STATE_LEN, POOL_STATE_OFFSETS, deriveAmmConfig } from '../lib/solana/cpswap/program';
import { REGISTERED_PROGRAM_ID as REGISTERED_LAUNCH_PROGRAM, poolStatePda } from '../lib/launcher/solana/curve/program';
import { judgeRoomLpDoors, readVenueSolPools, roomsWithCoins, type Rpc, type SolPool } from './roomLpDoors';

const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOL = 1_000_000_000n;

// Two rooms' real mints and pools (lib/bungalows.ts), and USDC, which is no room's coin.
const RIZZ = { id: 'rizz', symbol: 'RIZZ', mint: '5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k' };
const SOY = { id: 'soy', symbol: 'SOY', mint: '8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump' };
const RIZZ_POOL = '3yDDaZtABgj7z4BNtPKpfnK4yrx5bvEphDXYGGTnTmfA';
const SOY_POOL = '5M4SZy9Ytu1LGWWjBUwiDZ98bGdpQL4fD3PHETEXPAN8';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_USDC_POOL = 'CvAVyjZk1A4hLuNDvEseCYHAn98mU1f4mKpveGvAM2UC';
// A made-up second pool: 32 bytes of 9.
const SECOND_RIZZ_POOL = base58.encode(new Uint8Array(32).fill(9));

const pool = (address: string, tokenMint: string, sol: bigint | null): SolPool => ({ address, tokenMint, solLamports: sol });
const POOLS = [pool(RIZZ_POOL, RIZZ.mint, 3n * SOL), pool(SOY_POOL, SOY.mint, 2n * SOL), pool(SOL_USDC_POOL, USDC, 1n * SOL)];

describe('judgeRoomLpDoors', () => {
  it('passes when each room names its SOL pool, and leaves a pool of no room’s coin alone', () => {
    const v = judgeRoomLpDoors([{ ...RIZZ, venueSolPool: RIZZ_POOL }, { ...SOY, venueSolPool: SOY_POOL }], POOLS);
    expect(v.problems).toEqual([]);
    expect(v.notes).toEqual([]);
    expect(v.lines).toEqual([`RIZZ (rizz): door opens ${RIZZ_POOL} (3.000 SOL)`, `SOY (soy): door opens ${SOY_POOL} (2.000 SOL)`]);
  });

  it('fails a room whose coin has a SOL pool on the venue but whose entry names none: its door is missing', () => {
    // RIZZ on 2026-10-16: the pool opened, the registry said nothing, the room had no door.
    const v = judgeRoomLpDoors([{ ...RIZZ }, { ...SOY, venueSolPool: SOY_POOL }], POOLS);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toContain('RIZZ (rizz)');
    expect(v.problems[0]).toContain('names none in venueSolPool');
    expect(v.problems[0]).toContain('"Add SOL + RIZZ" door is missing');
    expect(v.problems[0]).toContain(RIZZ_POOL);
  });

  it('fails both rooms when two rooms’ pools are swapped', () => {
    const v = judgeRoomLpDoors([{ ...RIZZ, venueSolPool: SOY_POOL }, { ...SOY, venueSolPool: RIZZ_POOL }], POOLS);
    expect(v.problems).toHaveLength(2);
    expect(v.problems[0]).toContain(`RIZZ (rizz) names ${SOY_POOL}, which is a SOL pool of ${SOY.mint}, not of RIZZ's ${RIZZ.mint}`);
    expect(v.problems[0]).toContain(`RIZZ's SOL pool: ${RIZZ_POOL}`);
    expect(v.problems[1]).toContain(`SOY (soy) names ${RIZZ_POOL}, which is a SOL pool of ${RIZZ.mint}`);
  });

  it('fails a room that names an address that is no SOL pool on the venue’s pool program', () => {
    const typo = '3yDDaZtABgj7z4BNtPKpfnK4yrx5bvEphDXYGGTnTmfB';
    const v = judgeRoomLpDoors([{ ...RIZZ, venueSolPool: typo }], POOLS);
    expect(v.problems).toEqual([
      `RIZZ (rizz) names ${typo}, which is not a SOL pool on the venue's pool program, so its "Add SOL + RIZZ" door opens nothing. RIZZ's SOL pool: ${RIZZ_POOL}.`,
    ]);
  });

  it('fails a room that names a pool when its coin has no SOL pool at all, and says to remove the field', () => {
    const v = judgeRoomLpDoors([{ ...RIZZ, venueSolPool: RIZZ_POOL }], [pool(SOY_POOL, SOY.mint, SOL)]);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toContain('RIZZ has no SOL pool there: remove the field.');
  });

  it('passes a room with no SOL pool and no field: no pool, no door', () => {
    const v = judgeRoomLpDoors([{ ...RIZZ }], [pool(SOY_POOL, SOY.mint, SOL)]);
    expect(v.problems).toEqual([]);
    expect(v.lines).toEqual(['RIZZ (rizz): no SOL pool on the venue, no door']);
  });

  describe('a coin with several SOL pools', () => {
    const two = [pool(RIZZ_POOL, RIZZ.mint, 3n * SOL), pool(SECOND_RIZZ_POOL, RIZZ.mint, 5n * SOL)];

    it('suggests the deepest when none is named', () => {
      const v = judgeRoomLpDoors([{ ...RIZZ }], two);
      expect(v.problems[0]).toContain(`RIZZ (rizz) has 2 SOL pools on the venue's pool program but names none`);
      expect(v.problems[0]).toContain(`Name the deepest: ${SECOND_RIZZ_POOL} (5.000 SOL)`);
    });

    it('passes the deepest named, with no note', () => {
      const v = judgeRoomLpDoors([{ ...RIZZ, venueSolPool: SECOND_RIZZ_POOL }], two);
      expect(v.problems).toEqual([]);
      expect(v.notes).toEqual([]);
      expect(v.lines).toEqual([`RIZZ (rizz): door opens ${SECOND_RIZZ_POOL} (5.000 SOL), the deepest of 2`]);
    });

    it('passes a shallower one named, with a note rather than a failure: depth moves with every trade', () => {
      const v = judgeRoomLpDoors([{ ...RIZZ, venueSolPool: RIZZ_POOL }], two);
      expect(v.problems).toEqual([]);
      expect(v.notes).toEqual([
        `RIZZ (rizz) names ${RIZZ_POOL} (3.000 SOL), but ${SECOND_RIZZ_POOL} holds more (5.000 SOL); venueSolPool asks for the deepest.`,
      ]);
    });

    it('ranks a pool whose SOL vault could not be read last, never first', () => {
      const v = judgeRoomLpDoors([{ ...RIZZ }], [pool(SECOND_RIZZ_POOL, RIZZ.mint, null), pool(RIZZ_POOL, RIZZ.mint, 1n)]);
      expect(v.problems[0]).toContain(`Name the deepest: ${RIZZ_POOL}`);
    });
  });
});

describe('roomsWithCoins, over the real registry', () => {
  it('takes every Solana room with a coin and no other room', () => {
    const rooms = roomsWithCoins(BUNGALOWS);
    expect(rooms.map((r) => r.id)).toContain('bayla');
    expect(rooms.length).toBe(BUNGALOWS.filter((b) => b.chain === 'solana' && b.address).length);
    expect(rooms.every((r) => BUNGALOWS.find((b) => b.id === r.id)?.chain === 'solana')).toBe(true);
    expect(rooms.find((r) => r.id === 'bayla')?.mint).toBe('7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');
  });
});

describe('readVenueSolPools, on a canned RPC', () => {
  // A coin whose mint sorts BEFORE wrapped SOL, so its pool keeps SOL in the token1 slot
  // (cp-swap requires token0 < token1 by bytes). The system program's all-zero key is one.
  const LOW_MINT = '11111111111111111111111111111111';
  const LOW_POOL = base58.encode(new Uint8Array(32).fill(5));
  const vault = (n: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 7)));

  function poolBytes(token0Mint: string, token1Mint: string, token0Vault: string, token1Vault: string, ammConfig?: string): string {
    const d = new Uint8Array(POOL_STATE_LEN);
    d.set(ACCOUNT_POOL_STATE, 0);
    if (ammConfig) d.set(base58.decode(ammConfig), POOL_STATE_OFFSETS.ammConfig);
    d.set(base58.decode(token0Vault), POOL_STATE_OFFSETS.token0Vault);
    d.set(base58.decode(token1Vault), POOL_STATE_OFFSETS.token1Vault);
    d.set(base58.decode(token0Mint), POOL_STATE_OFFSETS.token0Mint);
    d.set(base58.decode(token1Mint), POOL_STATE_OFFSETS.token1Mint);
    return Buffer.from(d).toString('base64');
  }
  function wsolAccount(lamports: bigint, owner = TOKEN_PROGRAM) {
    const d = Buffer.alloc(165);
    Buffer.from(base58.decode(WSOL)).copy(d, 0);
    d.writeBigUInt64LE(lamports, 64);
    return { owner, data: [d.toString('base64'), 'base64'] };
  }

  type Call = { method: string; params: unknown[] };
  function cannedRpc(calls: Call[], overrides: { token1Scan?: unknown } = {}): Rpc {
    return async (method, params) => {
      calls.push({ method, params });
      if (method === 'getProgramAccounts') {
        const filters = (params[1] as { filters: { memcmp?: { offset: number } }[] }).filters;
        const offset = filters[2]?.memcmp?.offset;
        if (offset === POOL_STATE_OFFSETS.token0Mint) {
          return [{ pubkey: RIZZ_POOL, account: { data: [poolBytes(WSOL, RIZZ.mint, vault(1), vault(2)), 'base64'] } }];
        }
        if (offset === POOL_STATE_OFFSETS.token1Mint) {
          return 'token1Scan' in overrides ? overrides.token1Scan : [{ pubkey: LOW_POOL, account: { data: [poolBytes(LOW_MINT, WSOL, vault(3), vault(4)), 'base64'] } }];
        }
        throw new Error(`no canned scan at offset ${offset}`);
      }
      if (method === 'getMultipleAccounts') {
        const keys = params[0] as string[];
        // RIZZ's SOL vault is token0's, the low coin's is token1's.
        expect(keys).toEqual([vault(1), vault(4)]);
        return { value: [wsolAccount(3n * SOL), wsolAccount(9n * SOL, 'NotTheTokenProgram1111111111111111111111111')] };
      }
      throw new Error(`no canned answer for ${method}`);
    };
  }

  it('finds SOL in either mint slot, each pool under its other coin, with the SOL its vault holds', async () => {
    const calls: Call[] = [];
    const pools = await readVenueSolPools(cannedRpc(calls));
    expect(pools).toEqual([
      { address: RIZZ_POOL, tokenMint: RIZZ.mint, solLamports: 3n * SOL },
      // A vault not owned by the token program is not read as SOL.
      { address: LOW_POOL, tokenMint: LOW_MINT, solLamports: null },
    ]);
    const scans = calls.filter((c) => c.method === 'getProgramAccounts');
    expect(scans.map((c) => c.params[0])).toEqual(['EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT', 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT']);
    expect(scans.map((c) => (c.params[1] as { filters: unknown }).filters)).toEqual(
      [168, 200].map((offset) => [{ dataSize: 637 }, { memcmp: { offset: 0, bytes: base58.encode(ACCOUNT_POOL_STATE) } }, { memcmp: { offset, bytes: WSOL } }]),
    );
  });

  // A pool on the launch tier that is not the launch pool is one the site never uses: the
  // job must never ask for it to be named as a room's door. A graduated launch pool is kept.
  it('leaves out a pool opened on the launch tier without a launch, and keeps a launch pool on that tier', async () => {
    const tier0 = deriveAmmConfig(new PublicKey('EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT'), 0).toBase58();
    const launchPool = poolStatePda(new PublicKey(SOY.mint), REGISTERED_LAUNCH_PROGRAM).toBase58();
    const asked: string[][] = [];
    const rpc: Rpc = async (method, params) => {
      if (method === 'getProgramAccounts') {
        const offset = (params[1] as { filters: { memcmp?: { offset: number } }[] }).filters[2]?.memcmp?.offset;
        if (offset !== POOL_STATE_OFFSETS.token0Mint) return [];
        return [
          { pubkey: SECOND_RIZZ_POOL, account: { data: [poolBytes(WSOL, RIZZ.mint, vault(5), vault(6), tier0), 'base64'] } },
          { pubkey: launchPool, account: { data: [poolBytes(WSOL, SOY.mint, vault(7), vault(8), tier0), 'base64'] } },
        ];
      }
      const keys = params[0] as string[];
      asked.push(keys);
      return { value: keys.map(() => wsolAccount(SOL)) };
    };
    expect(await readVenueSolPools(rpc)).toEqual([{ address: launchPool, tokenMint: SOY.mint, solLamports: SOL }]);
    expect(asked).toEqual([[vault(7)]]);
  });

  it('throws when the RPC did not answer, rather than reading as no pools', async () => {
    const failing: Rpc = async () => {
      throw new Error('getProgramAccounts answered HTTP 429');
    };
    await expect(readVenueSolPools(failing)).rejects.toThrow('HTTP 429');
  });

  it('throws when a scan answers something other than a list', async () => {
    await expect(readVenueSolPools(cannedRpc([], { token1Scan: null }))).rejects.toThrow('no list');
  });

  it('throws when an account the scan matched does not decode as a SOL pool', async () => {
    const junk = [{ pubkey: LOW_POOL, account: { data: [Buffer.alloc(POOL_STATE_LEN).toString('base64'), 'base64'] } }];
    await expect(readVenueSolPools(cannedRpc([], { token1Scan: junk }))).rejects.toThrow(`${LOW_POOL} matched the scan but is not a SOL pool`);
  });
});
