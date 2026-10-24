// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../cpswap/ix';
import { getDeltaAmountsSigned, getSqrtPriceAtTick } from './math';
import { decodePoolState, deriveAmmConfig, deriveObservation, derivePersonalPosition, derivePool, deriveTickArray, deriveVault, sortMints } from './program';
import { encodeAmmConfig, encodePool, encodePosition, encodeTickArray, type RewardFields } from './encode.fixture';
import { positionNeedsExtension, rangeStatus, readBandsNear, readFeeTiers, readFreezeAuthority, readPairPools, readWalletPositions } from './read';
import { encodeMint } from '../../launcher/solana/write/testkit.fixture';

/**
 * The range program's reads against a fake RPC that answers only the two calls the proxy
 * allows here. What each test holds: a thing the chain says is not there is left out, and a
 * thing that is there but does not read is said to be unread, never left out or shown as zero.
 */

const PROG = Keypair.generate().publicKey;
const ME = Keypair.generate().publicKey;
const TOKEN = Keypair.generate().publicKey;
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const { token0: M0, token1: M1 } = sortMints(WSOL, TOKEN);
const SPACING = 120;
const TICK = 600;
const SQRT = getSqrtPriceAtTick(TICK) + 99n;
const Q64 = 1n << 64n;
const SYSTEM = new PublicKey('11111111111111111111111111111111');

interface Acct { owner: PublicKey; data: Uint8Array }

class Chain {
  accounts = new Map<string, Acct>();
  /** The wallet's token accounts; `program` defaults to Token-2022. */
  tokenAccounts: { pubkey: PublicKey; mint: PublicKey; amount: bigint; program?: PublicKey }[] = [];
  calls: string[] = [];
  set(k: PublicKey, a: Acct) { this.accounts.set(k.toBase58(), a); return this; }
  rpc: SolanaRpc = async (method, params) => {
    this.calls.push(method);
    const wire = (a: Acct) => ({ data: [Buffer.from(a.data).toString('base64'), 'base64'], owner: a.owner.toBase58(), lamports: 1 });
    if (method === 'getMultipleAccounts') {
      return { value: (params[0] as string[]).map((k) => { const a = this.accounts.get(k); return a ? wire(a) : null; }) };
    }
    if (method === 'getTokenAccountsByOwner') {
      const program = (params[1] as { programId: string }).programId;
      return {
        value: this.tokenAccounts
          .filter((t) => (t.program ?? TOKEN_2022_PROGRAM_ID).toBase58() === program)
          .map((t) => {
            const d = new Uint8Array(program === TOKEN_PROGRAM_ID.toBase58() ? 165 : 170);
            d.set(t.mint.toBytes(), 0);
            d.set(ME.toBytes(), 32);
            new DataView(d.buffer).setBigUint64(64, t.amount, true);
            return { pubkey: t.pubkey.toBase58(), account: wire({ owner: new PublicKey(program), data: d }) };
          }),
      };
    }
    throw new Error(`the proxy refuses ${method}`);
  };
}

const tier = (i: number, spacing = SPACING) => encodeAmmConfig({ index: i, tradeFeeRate: 2_500 * (i + 1), protocolFeeRate: 120_000, fundFeeRate: 40_000, tickSpacing: spacing });
const CONFIG0 = deriveAmmConfig(PROG, 0);
const CONFIG1 = deriveAmmConfig(PROG, 1);
const POOL = derivePool(PROG, CONFIG0, M0, M1);

function poolData(o: { config?: PublicKey; tick?: number; feeGrowth0?: bigint; bits?: number[]; rewards?: RewardFields[] } = {}) {
  return encodePool({
    ammConfig: o.config ?? CONFIG0, mint0: M0, mint1: M1,
    vault0: deriveVault(PROG, POOL, M0), vault1: deriveVault(PROG, POOL, M1), observation: deriveObservation(PROG, POOL),
    decimals0: 9, decimals1: 6, tickSpacing: SPACING, liquidity: 10n ** 12n,
    sqrtPriceX64: o.tick === undefined ? SQRT : getSqrtPriceAtTick(o.tick), tickCurrent: o.tick ?? TICK,
    feeGrowth0: o.feeGrowth0, bitmapBits: o.bits, rewards: o.rewards,
  });
}

const CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const SYSVAR = new PublicKey('Sysvar1111111111111111111111111111111111111');
function clockAt(unix: bigint): Acct {
  const d = new Uint8Array(40);
  new DataView(d.buffer).setBigInt64(32, unix, true);
  return { owner: SYSVAR, data: d };
}

function withTiers(): Chain {
  return new Chain().set(CONFIG0, { owner: PROG, data: tier(0) }).set(CONFIG1, { owner: PROG, data: tier(1) });
}

describe('fee tiers', () => {
  it('reads the tiers at the addresses their indexes derive, and only those that are there', async () => {
    const r = await readFeeTiers(withTiers().rpc, PROG);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.map((t) => [t.index, t.tradeFeeRate, t.protocolFeeRate + t.fundFeeRate])).toEqual([[0, 2_500, 160_000], [1, 5_000, 160_000]]);
  });

  it('SOL sent to an unused tier address (an empty account the system owns) is the chain saying "never created": absent, not unread', async () => {
    const funded = withTiers().set(deriveAmmConfig(PROG, 5), { owner: SYSTEM, data: new Uint8Array(0) });
    const r = await readFeeTiers(funded.rpc, PROG);
    expect(r.kind === 'ok' && r.value.map((t) => t.index)).toEqual([0, 1]);
    // The same at an unopened pool's address: the pair reads, with no pool there.
    const c = withTiers().set(POOL, { owner: SYSTEM, data: new Uint8Array(0) });
    const tiers = await readFeeTiers(c.rpc, PROG);
    if (tiers.kind !== 'ok') throw new Error('tiers');
    expect(await readPairPools(c.rpc, PROG, TOKEN.toBase58(), WSOL.toBase58(), tiers.value)).toEqual({ kind: 'ok', value: [] });
    // A system account WITH data is not that answer: still unread.
    const odd = withTiers().set(deriveAmmConfig(PROG, 5), { owner: SYSTEM, data: new Uint8Array(8) });
    expect((await readFeeTiers(odd.rpc, PROG)).kind).toBe('unread');
  });

  it('a tier address held by another program, a tier that does not decode, or a failed call is unread', async () => {
    const stranger = withTiers().set(deriveAmmConfig(PROG, 2), { owner: Keypair.generate().publicKey, data: tier(2) });
    const wrongIndex = withTiers().set(deriveAmmConfig(PROG, 2), { owner: PROG, data: tier(3) });
    const short = withTiers().set(deriveAmmConfig(PROG, 2), { owner: PROG, data: tier(2).subarray(0, 40) });
    for (const c of [stranger, wrongIndex, short]) expect((await readFeeTiers(c.rpc, PROG)).kind).toBe('unread');
    expect((await readFeeTiers(async () => { throw new Error('down'); }, PROG)).kind).toBe('unread');
  });
});

describe("a pair's pools", () => {
  it('finds the pool on the tier that has one, either way round the mints are given', async () => {
    const c = withTiers().set(POOL, { owner: PROG, data: poolData() });
    const tiers = await readFeeTiers(c.rpc, PROG);
    if (tiers.kind !== 'ok') throw new Error('tiers');
    for (const [a, b] of [[TOKEN, WSOL], [WSOL, TOKEN]]) {
      const r = await readPairPools(c.rpc, PROG, a!.toBase58(), b!.toBase58(), tiers.value);
      expect(r.kind === 'ok' && r.value.map((p) => [p.pool.address, p.config.index])).toEqual([[POOL.toBase58(), 0]]);
    }
  });

  it('a pool that names another tier than the one its address derives from is unread', async () => {
    const c = withTiers().set(POOL, { owner: PROG, data: poolData({ config: CONFIG1 }) });
    const tiers = await readFeeTiers(c.rpc, PROG);
    if (tiers.kind !== 'ok') throw new Error('tiers');
    expect((await readPairPools(c.rpc, PROG, TOKEN.toBase58(), WSOL.toBase58(), tiers.value)).kind).toBe('unread');
  });
});

describe('the bands near the price', () => {
  // Bit 512 is the band starting at 0; bit 511 the one below it.
  it('reads the marked bands on each side, and a marked band that is missing is an error, not an empty band', async () => {
    const pool = (bits: number[]) => {
      const c = withTiers().set(POOL, { owner: PROG, data: poolData({ bits }) });
      return { c, view: decodePoolState(POOL.toBase58(), c.accounts.get(POOL.toBase58())!.data)! };
    };
    const { c, view } = pool([511, 512, 513]);
    for (const s of [-7_200, 0, 7_200]) c.set(deriveTickArray(PROG, POOL, s), { owner: PROG, data: encodeTickArray(POOL, s, SPACING, []) });
    expect([...(await readBandsNear(c.rpc, PROG, view, null)).keys()]).toEqual([-7_200, 0, 7_200]);
    c.accounts.delete(deriveTickArray(PROG, POOL, 7_200).toBase58());
    await expect(readBandsNear(c.rpc, PROG, view, null)).rejects.toThrow(/7200/);
  });
});

describe("a wallet's positions", () => {
  const LOWER = -1_200;
  const UPPER = 1_200;
  const L = 5_000_000_000n;

  function walletWith(o: { band?: boolean; pool?: boolean; feeGrowth0?: bigint; rewards?: RewardFields[] } = {}) {
    const c = withTiers();
    if (o.pool !== false) c.set(POOL, { owner: PROG, data: poolData({ feeGrowth0: o.feeGrowth0 ?? 3n * Q64, rewards: o.rewards }) });
    if (o.band !== false) {
      c.set(deriveTickArray(PROG, POOL, -7_200), { owner: PROG, data: encodeTickArray(POOL, -7_200, SPACING, [{ tick: LOWER, liquidityNet: L, liquidityGross: L }]) });
      c.set(deriveTickArray(PROG, POOL, 0), { owner: PROG, data: encodeTickArray(POOL, 0, SPACING, [{ tick: UPPER, liquidityNet: -L, liquidityGross: L }]) });
    }
    const nft = Keypair.generate().publicKey;
    const nftAccount = Keypair.generate().publicKey;
    c.set(derivePersonalPosition(PROG, nft), {
      owner: PROG,
      data: encodePosition({ nftMint: nft, pool: POOL, tickLower: LOWER, tickUpper: UPPER, liquidity: L, feeGrowthInside0Last: Q64, feesOwed0: 7n, feesOwed1: 11n }),
    });
    c.tokenAccounts.push(
      { pubkey: nftAccount, mint: nft, amount: 1n },
      // A Token-2022 coin the wallet holds one of that is not a position, and one it holds five of.
      { pubkey: Keypair.generate().publicKey, mint: Keypair.generate().publicKey, amount: 1n },
      { pubkey: Keypair.generate().publicKey, mint: Keypair.generate().publicKey, amount: 5n },
    );
    return { c, nft, nftAccount };
  }

  it('finds the position through its NFT, with what it holds and the fees it has earned since', async () => {
    const { c, nftAccount } = walletWith();
    const r = await readWalletPositions(c.rpc, PROG, ME);
    if (r.kind !== 'ok') throw new Error(r.detail);
    expect(r.value.unread).toEqual([]);
    expect(r.value.positions).toHaveLength(1);
    const p = r.value.positions[0]!;
    expect(p.nftAccount).toBe(nftAccount.toBase58());
    expect(p.status).toBe('in-range');
    expect(p.config.index).toBe(0);
    const [a0, a1] = getDeltaAmountsSigned(TICK, SQRT, LOWER, UPPER, -L);
    expect(p.amounts).toEqual({ amount0: a0, amount1: a1 });
    // Inside the range the whole pool's growth counts: (3 - 1) per unit of liquidity since its last update.
    expect(p.fees).toEqual({ fee0: 7n + 2n * L, fee1: 11n });
    expect(p.rewards).toEqual([]);
    expect(c.calls).not.toContain('getProgramAccounts');
  });

  // A reward of 2 BAYLA a second (6 decimals) since 1,000 s, last brought up to date at 1,100 s.
  const REWARD_MINT = Keypair.generate().publicKey;
  const running: RewardFields = { mint: REWARD_MINT, vault: Keypair.generate().publicKey, openTime: 1_000n, endTime: 100_000n, lastUpdateTime: 1_100n, emissionsPerSecondX64: 2_000_000n << 64n, growthGlobalX64: Q64 };

  it('a running reward is worked out to the chain’s own clock, read in the same batch as the pool and its bands, with its coin’s decimals', async () => {
    const { c } = walletWith({ rewards: [running] });
    c.set(CLOCK, clockAt(1_400n));
    c.set(REWARD_MINT, { owner: TOKEN_PROGRAM_ID, data: encodeMint({ decimals: 6 }) });
    const r = await readWalletPositions(c.rpc, PROG, ME);
    if (r.kind !== 'ok') throw new Error(r.detail);
    const p = r.value.positions[0]!;
    // 300 s at 2 coins a second over the pool's liquidity, plus the 1 per unit the counter already held; the
    // position was last changed at growth 0 and holds L of the pool's 10^12.
    const growth = Q64 + (300n * (2_000_000n << 64n)) / 10n ** 12n;
    expect(p.rewards).toEqual([{ index: 0, mint: REWARD_MINT.toBase58(), owed: (growth * L) / Q64, decimals: 6, feeOnTransfer: false }]);
    expect(p.chainTime).toBe(1_400n);
    // Token accounts twice, then three batches: the records, the pools, then everything the sums need together.
    expect(c.calls.filter((m) => m === 'getMultipleAccounts')).toHaveLength(3);
  });

  it('a record that changed between the finding and the sums is read again with its pool: a collect landed in between pays nothing twice', async () => {
    const { c, nft } = walletWith();
    const record = derivePersonalPosition(PROG, nft);
    // The collect: owed reset to 0 and growth inside brought up to the pool's 3 per unit.
    const collected = encodePosition({ nftMint: nft, pool: POOL, tickLower: LOWER, tickUpper: UPPER, liquidity: L, feeGrowthInside0Last: 3n * Q64 });
    const rpc: SolanaRpc = async (method, params) => {
      const out = await c.rpc(method, params);
      if (method === 'getMultipleAccounts' && (params[0] as string[]).includes(record.toBase58())) c.set(record, { owner: PROG, data: collected });
      return out;
    };
    const r = await readWalletPositions(rpc, PROG, ME);
    if (r.kind !== 'ok') throw new Error(r.detail);
    expect(r.value.positions[0]!.fees).toEqual({ fee0: 0n, fee1: 0n });
  });

  it('past 100 keys, each position’s record, pool, tier, two bands and the Clock are read in one call', async () => {
    const c = withTiers();
    c.set(POOL, { owner: PROG, data: poolData({ rewards: [running] }) });
    c.set(CLOCK, clockAt(1_400n));
    const records: { record: string; lower: number; upper: number }[] = [];
    for (let k = 1; k <= 40; k++) {
      const nft = Keypair.generate().publicKey;
      const [lower, upper] = [-7_200 * k, 7_200 * k];
      c.set(derivePersonalPosition(PROG, nft), { owner: PROG, data: encodePosition({ nftMint: nft, pool: POOL, tickLower: lower, tickUpper: upper, liquidity: L }) });
      c.tokenAccounts.push({ pubkey: Keypair.generate().publicKey, mint: nft, amount: 1n });
      records.push({ record: derivePersonalPosition(PROG, nft).toBase58(), lower, upper });
    }
    const calls: string[][] = [];
    const rpc: SolanaRpc = async (method, params) => {
      if (method === 'getMultipleAccounts') calls.push(params[0] as string[]);
      return c.rpc(method, params);
    };
    const r = await readWalletPositions(rpc, PROG, ME);
    if (r.kind !== 'ok') throw new Error(r.detail);
    expect(r.value.positions).toHaveLength(40);
    for (const { record, lower, upper } of records) {
      const band = (t: number) => deriveTickArray(PROG, POOL, Math.floor(t / (SPACING * 60)) * SPACING * 60).toBase58();
      const together = calls.filter((keys) => keys.includes(CLOCK.toBase58()) && keys.includes(record));
      expect(together.length, record).toBe(1);
      expect(together[0]).toEqual(expect.arrayContaining([POOL.toBase58(), CONFIG0.toBase58(), REWARD_MINT.toBase58(), band(lower), band(upper)]));
    }
    for (const keys of calls) expect(keys.length).toBeLessThanOrEqual(100);
  });

  it('with the Clock unread a running reward could not be worked out: null, never 0', async () => {
    const { c } = walletWith({ rewards: [running] });
    const r = await readWalletPositions(c.rpc, PROG, ME);
    if (r.kind !== 'ok') throw new Error(r.detail);
    expect(r.value.positions[0]!.rewards).toBeNull();
    expect(r.value.positions[0]!.chainTime).toBeNull();
    // The fees do not need the clock.
    expect(r.value.positions[0]!.fees).not.toBeNull();
  });

  it('a reward coin whose mint did not read still has its amount, with no decimals to read it by', async () => {
    const { c } = walletWith({ rewards: [running] });
    c.set(CLOCK, clockAt(1_400n));
    const r = await readWalletPositions(c.rpc, PROG, ME);
    if (r.kind !== 'ok') throw new Error(r.detail);
    expect(r.value.positions[0]!.rewards![0]!.decimals).toBeNull();
    expect(r.value.positions[0]!.rewards![0]!.owed > 0n).toBe(true);
  });

  it('when a band holding one of its ends does not read, the fees are unknown, not zero', async () => {
    const { c } = walletWith({ band: false });
    const r = await readWalletPositions(c.rpc, PROG, ME);
    if (r.kind !== 'ok') throw new Error(r.detail);
    expect(r.value.positions[0]!.fees).toBeNull();
    expect(r.value.positions[0]!.amounts).not.toBeNull();
  });

  it('a position whose pool does not read is listed as unread, never left out', async () => {
    const { c, nft } = walletWith({ pool: false });
    const r = await readWalletPositions(c.rpc, PROG, ME);
    if (r.kind !== 'ok') throw new Error(r.detail);
    expect(r.value.positions).toEqual([]);
    expect(r.value.unread.map((u) => u.position)).toEqual([derivePersonalPosition(PROG, nft).toBase58()]);
  });

  it('a record at a position address that does not decode makes the whole read unread', async () => {
    const { c, nft } = walletWith();
    c.set(derivePersonalPosition(PROG, nft), { owner: PROG, data: new Uint8Array(50) });
    expect((await readWalletPositions(c.rpc, PROG, ME)).kind).toBe('unread');
  });

  it('a position whose NFT the wallet sent away (its empty account left behind) is not listed', async () => {
    const { c } = walletWith();
    const gone = Keypair.generate().publicKey;
    c.set(derivePersonalPosition(PROG, gone), { owner: PROG, data: encodePosition({ nftMint: gone, pool: POOL, tickLower: LOWER, tickUpper: UPPER, liquidity: L }) });
    c.tokenAccounts.push({ pubkey: Keypair.generate().publicKey, mint: gone, amount: 0n });
    const r = await readWalletPositions(c.rpc, PROG, ME);
    if (r.kind !== 'ok') throw new Error(r.detail);
    expect(r.value.positions.map((p) => p.position.nftMint)).not.toContain(gone.toBase58());
    expect(r.value.positions).toHaveLength(1);
  });

  it('a position whose NFT is a classic SPL token is found too, and says which kind it is', async () => {
    const { c } = walletWith();
    const nft = Keypair.generate().publicKey;
    const nftAccount = Keypair.generate().publicKey;
    c.set(derivePersonalPosition(PROG, nft), { owner: PROG, data: encodePosition({ nftMint: nft, pool: POOL, tickLower: LOWER, tickUpper: UPPER, liquidity: L }) });
    c.tokenAccounts.push({ pubkey: nftAccount, mint: nft, amount: 1n, program: TOKEN_PROGRAM_ID });
    const r = await readWalletPositions(c.rpc, PROG, ME);
    if (r.kind !== 'ok') throw new Error(r.detail);
    expect(r.value.positions.map((p) => [p.position.nftMint, p.nftProgram])).toEqual(
      expect.arrayContaining([[nft.toBase58(), 'token'], [expect.any(String), 'token-2022']]),
    );
    expect(r.value.positions.find((p) => p.nftProgram === 'token')!.nftAccount).toBe(nftAccount.toBase58());
  });

  it('a wallet with no position reads as none, from the chain', async () => {
    const c = withTiers();
    const r = await readWalletPositions(c.rpc, PROG, ME);
    expect(r).toEqual({ kind: 'ok', value: { positions: [], unread: [] } });
  });
});

describe("a token's freeze authority, where it is picked", () => {
  const MINT = Keypair.generate().publicKey;
  it('a mint: its freeze authority, or null for none', async () => {
    const auth = Keypair.generate().publicKey;
    const frozen = new Chain().set(MINT, { owner: TOKEN_PROGRAM_ID, data: encodeMint({ decimals: 6, freezeAuthority: auth }) });
    expect(await readFreezeAuthority(frozen.rpc, MINT.toBase58())).toEqual({ kind: 'ok', value: { kind: 'mint', freezeAuthority: auth.toBase58() } });
    const clean = new Chain().set(MINT, { owner: TOKEN_PROGRAM_ID, data: encodeMint({ decimals: 6 }) });
    expect(await readFreezeAuthority(clean.rpc, MINT.toBase58())).toEqual({ kind: 'ok', value: { kind: 'mint', freezeAuthority: null } });
  });

  it('no account, or one that is not a mint, is not-a-mint; a read that failed is unread: never "cannot be frozen"', async () => {
    expect(await readFreezeAuthority(new Chain().rpc, MINT.toBase58())).toMatchObject({ kind: 'ok', value: { kind: 'not-a-mint' } });
    const stranger = new Chain().set(MINT, { owner: SYSTEM, data: new Uint8Array(82) });
    expect(await readFreezeAuthority(stranger.rpc, MINT.toBase58())).toMatchObject({ kind: 'ok', value: { kind: 'not-a-mint' } });
    expect(await readFreezeAuthority(async () => { throw new Error('down'); }, MINT.toBase58())).toMatchObject({ kind: 'unread' });
  });
});

describe('range status', () => {
  it('the lower end is inside the range and the upper end is not, as the program counts', () => {
    const p = { tickLowerIndex: -120, tickUpperIndex: 120 };
    expect(rangeStatus({ tickCurrent: -121 }, p)).toBe('below');
    expect(rangeStatus({ tickCurrent: -120 }, p)).toBe('in-range');
    expect(rangeStatus({ tickCurrent: 119 }, p)).toBe('in-range');
    expect(rangeStatus({ tickCurrent: 120 }, p)).toBe('above');
  });

  it('only a far range on a fine spacing needs the far-band map', () => {
    expect(positionNeedsExtension({ tickSpacing: 1 }, { tickLowerIndex: -60, tickUpperIndex: 60 })).toBe(false);
    expect(positionNeedsExtension({ tickSpacing: 1 }, { tickLowerIndex: 40_000, tickUpperIndex: 40_060 })).toBe(true);
    expect(positionNeedsExtension({ tickSpacing: 120 }, { tickLowerIndex: -400_000, tickUpperIndex: 400_000 })).toBe(false);
  });
});
