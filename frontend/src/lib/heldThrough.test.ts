// @vitest-environment node
//
// NODE, not jsdom: PublicKey.findProgramAddressSync fails every bump under jsdom
// (the same choice ladder/program.test.ts makes).
//
// Every read held-through.json publishes is pinned to a witness outside this module:
// state.rs and lib.rs for the ladder, the Streamflow SDK and its IDL for the lighthouse
// pools, the Solidity for EVM, and a recorded mainnet fixture that the published spec
// alone must reproduce.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { toFunctionSelector } from 'viem';
import { constants as sf, deriveStakeEntryPDA, deriveStakeVaultPDA } from '@streamflow/staking';
import {
  collectHeldThrough,
  renderHeldThrough,
  ladderMissingInProduction,
  HELD_THROUGH_SCHEMA,
  type HeldContract,
  type HeldThroughBody,
  type LayoutField,
} from './heldThrough';
import { BUNGALOWS, RETIRED_STAKE_POOLS, poolReadByIsland, type Bungalow } from './bungalows';
import {
  TEGRIDY_STAKING_ADDRESS,
  LEGACY_STAKING_ADDRESSES,
  TEGRIDY_LP_ADDRESS,
  LP_FARMING_ADDRESS,
  TOWELI_ADDRESS,
  WETH_ADDRESS,
} from './constants';
import {
  ACCOUNT_DISCRIMINATOR,
  POOL_LAYOUT,
  POSITION_LAYOUT,
  USER_STATS_LAYOUT,
} from './ladder/program';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const LADDER_SRC = resolve(REPO, 'solana/tegridy-amm/programs/bayla-ladder/src');
const FIXTURES = resolve(HERE, '__fixtures__/heldThrough');
const read = (p: string) => readFileSync(p, 'utf8');
const ledger = JSON.parse(read(resolve(HERE, '../../scripts/addresses.json')));

// The mainnet ladder the production build points at (addresses.json).
const LADDER_PROGRAM = 'EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ';
const LADDER_POOL = 'Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV';
const ledgerAddress = (chain: string, id: string): string =>
  (ledger[chain] as { id?: string; address?: string }[]).find((e) => e.id === id)!.address!;

const all = (b: HeldThroughBody): HeldContract[] => [...b.chains.solana, ...b.chains.ethereum, ...b.chains.base];
const byId = (b: HeldThroughBody, id: string): HeldContract => {
  const c = all(b).find((x) => x.id === id);
  if (!c) throw new Error(`no contract ${id} in ${all(b).map((x) => x.id).join(', ')}`);
  return c;
};
const withLadder = () => collectHeldThrough({ ladderProgram: LADDER_PROGRAM, bungalows: withLadderPool(BUNGALOWS) });
function withLadderPool(rows: readonly Bungalow[]): Bungalow[] {
  return rows.map((b) => (b.id === 'bayla' ? { ...b, ladderPool: LADDER_POOL } : b));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('held-through.json lists every contract that holds user positions', () => {
  it('lists every staking pool the registry carries, and the TOWELI side from constants.ts', () => {
    const doc = withLadder();
    for (const b of BUNGALOWS) {
      if (!b.stakePool || b.chain === 'tbd') continue;
      const hit = doc.chains[b.chain].find((c) => c.address === b.stakePool);
      expect(hit, `${b.id}'s pool ${b.stakePool} is missing`).toBeTruthy();
      expect(hit!.bungalow).toBe(b.id);
    }
    expect(byId(doc, 'bayla-ladder-pool').address).toBe(LADDER_POOL);
    for (const r of RETIRED_STAKE_POOLS) {
      const hit = doc.chains[r.chain].find((c) => c.address === r.pool);
      expect(hit, `retired pool ${r.pool} is missing`).toBeTruthy();
      expect(hit!.offered).toBe('retired');
    }
    const eth = doc.chains.ethereum.map((c) => c.address);
    for (const a of [TEGRIDY_STAKING_ADDRESS, ...LEGACY_STAKING_ADDRESSES, TEGRIDY_LP_ADDRESS, LP_FARMING_ADDRESS]) {
      expect(eth, `${a} is missing`).toContain(a);
    }
  });

  it('counts 18 contracts with the ladder: Solana 7, Ethereum 6, Base 5', () => {
    const doc = withLadder();
    expect([doc.chains.solana.length, doc.chains.ethereum.length, doc.chains.base.length]).toEqual([7, 6, 5]);
    expect(new Set(all(doc).map((c) => c.id)).size, 'ids are unique').toBe(18);
  });

  it('shows a pool added to the registry with no edit here', () => {
    const extraBase: Bungalow = {
      id: 'zzz', name: 'ZZZ', symbol: 'ZZZ', chain: 'base', address: '0x00000000000000000000000000000000000000aa',
      status: 'SETTLED', tagline: 't', thumb: '/x.jpg', live: true, decimals: 18,
      stakePool: '0x00000000000000000000000000000000000000bb', poolKind: 'ladder',
    };
    const extraSol: Bungalow = {
      id: 'yyy', name: 'YYY', symbol: 'YYY', chain: 'solana', address: 'So11111111111111111111111111111111111111112',
      status: 'SETTLED', tagline: 't', thumb: '/x.jpg', live: false, decimals: 9,
      stakePool: 'Sysvar1111111111111111111111111111111111111',
    };
    const doc = collectHeldThrough({ bungalows: [...BUNGALOWS, extraBase, extraSol], ladderProgram: '' });
    const b = byId(doc, 'ladder-zzz');
    expect(b.kind).toBe('lighthouse-ladder');
    expect(b.address).toBe(extraBase.stakePool);
    expect(b.tokens).toEqual([{ address: extraBase.address, symbol: 'ZZZ', decimals: 18 }]);
    const s = byId(doc, 'lighthouse-yyy');
    expect(s.kind).toBe('streamflow-stake-pool');
    expect(s.tokens).toEqual([{ address: extraSol.address, symbol: 'YYY', decimals: 9 }]);
  });

  it('refuses a staked registry row with no decimals rather than publish a guess', () => {
    const noDecimals = { ...BUNGALOWS.find((b) => b.id === 'pepe')!, id: 'nodec', decimals: undefined };
    expect(() => collectHeldThrough({ bungalows: [noDecimals], ladderProgram: '', retired: [] })).toThrow(/decimals/);
  });

  it('every staked registry row carries its token decimals, as read on chain', () => {
    const expected: Record<string, number> = {
      bayla: 6, pepe: 18, qr: 18, mfer: 18, bnkr: 18, drb: 18, bobo: 6, jbm: 18, soy: 6, brainlet: 6, rizz: 6,
    };
    const staked = BUNGALOWS.filter((b) => b.stakePool || b.ladderPool).map((b) => [b.id, b.decimals]);
    expect(Object.fromEntries(staked)).toEqual(expected);
  });

  it('is not filtered by the address ledger: the BAYLA lighthouse pool is listed', () => {
    const ids = collectHeldThrough({ ladderProgram: '' }).chains.solana.map((c) => c.id);
    expect(ids).toContain('lighthouse-bayla');
    expect(ids).toContain('lighthouse-bayla-retired');
  });
});

describe('the lock ladder follows the build env, like the card', () => {
  const build = async (env: Record<string, string>) => {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const mod = await import('./heldThrough');
    return mod.collectHeldThrough();
  };

  it('lists the ladder only when both the program and the pool are set', async () => {
    const neither = await build({ VITE_BAYLA_LADDER_PROGRAM: '', VITE_BAYLA_LADDER_POOL: '' });
    expect(neither.chains.solana.some((c) => c.kind === 'bayla-ladder')).toBe(false);
    const programOnly = await build({ VITE_BAYLA_LADDER_PROGRAM: LADDER_PROGRAM, VITE_BAYLA_LADDER_POOL: '' });
    expect(programOnly.chains.solana.some((c) => c.kind === 'bayla-ladder')).toBe(false);
    const poolOnly = await build({ VITE_BAYLA_LADDER_PROGRAM: '', VITE_BAYLA_LADDER_POOL: LADDER_POOL });
    expect(poolOnly.chains.solana.some((c) => c.kind === 'bayla-ladder')).toBe(false);
    const both = await build({ VITE_BAYLA_LADDER_PROGRAM: LADDER_PROGRAM, VITE_BAYLA_LADDER_POOL: LADDER_POOL });
    const ladder = both.chains.solana.find((c) => c.kind === 'bayla-ladder')!;
    expect(ladder).toBeTruthy();
    expect(ladder.program).toBe(LADDER_PROGRAM);
    expect(ladder.address).toBe(LADDER_POOL);
    // Derived offline, and equal to the vault the ledger registered from the chain.
    expect(ladder.vault).toBe(ledgerAddress('solana', 'bayla-ladder-stake-vault'));
  });

  it('fails a production build whose ledger has a live ladder the file does not list', () => {
    const without = collectHeldThrough({ ladderProgram: '' });
    expect(ladderMissingInProduction(without, ledger, 'production')).toMatch(/VITE_BAYLA_LADDER_POOL/);
    expect(ladderMissingInProduction(without, ledger, 'preview')).toBeNull();
    expect(ladderMissingInProduction(without, ledger, undefined)).toBeNull();
    expect(ladderMissingInProduction(withLadder(), ledger, 'production')).toBeNull();
  });
});

describe('readByIsland is the registry read list, never a second copy', () => {
  it('answers exactly what poolReadByIsland answers for each contract', () => {
    const doc = withLadder();
    for (const c of all(doc)) {
      const chain = doc.chains.solana.includes(c) ? 'solana' : doc.chains.ethereum.includes(c) ? 'ethereum' : 'base';
      expect(c.readByIsland, c.id).toBe(poolReadByIsland(chain, c.address));
    }
    expect(all(doc).filter((c) => c.readByIsland).map((c) => c.id).sort()).toEqual(['bayla-ladder-pool', 'lighthouse-bayla']);
  });
});

/* ------------------------------ the ladder ------------------------------ */

const RUST_SIZE: Record<string, number> = { u8: 1, bool: 1, u32: 4, u64: 8, i64: 8, u128: 16, Pubkey: 32 };
function rustLayout(src: string, struct: string): LayoutField[] {
  const body = new RegExp(`pub struct ${struct} \\{([\\s\\S]*?)\\n\\}`).exec(src)?.[1];
  if (!body) throw new Error(`no struct ${struct} in state.rs`);
  let offset = 8;
  return [...body.matchAll(/^\s*pub (\w+): ([^,]+),/gm)].map(([, name, raw]) => {
    const t = raw!.trim();
    const arr = /^\[u8;\s*(\d+)\]$/.exec(t);
    const size = arr ? Number(arr[1]) : RUST_SIZE[t];
    if (!size) throw new Error(`unsized Rust type ${t}`);
    const field = { name: name!, offset, type: arr ? `u8[${arr[1]}]` : t === 'Pubkey' ? 'pubkey' : t };
    offset += size;
    return field;
  });
}
const end = (l: LayoutField[], size: number) => l[l.length - 1]!.offset + size;
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe('the lock ladder read is the one state.rs and lib.rs declare', () => {
  const state = read(resolve(LADDER_SRC, 'state.rs'));
  const lib = read(resolve(LADDER_SRC, 'lib.rs'));
  let r: Extract<HeldContract['read'], { position: unknown }>;
  beforeEach(() => {
    r = byId(withLadder(), 'bayla-ladder-pool').read as typeof r;
  });

  it('publishes the Position, UserStats and Pool layouts of state.rs, byte for byte', () => {
    expect(r.position.layout).toEqual(rustLayout(state, 'Position'));
    expect(r.userStats.layout).toEqual(rustLayout(state, 'UserStats'));
    expect(r.pool.layout).toEqual(rustLayout(state, 'Pool'));
    expect(end(r.position.layout, 64)).toBe(r.position.size);
    expect([r.position.size, r.userStats.size, r.pool.size]).toEqual([205, 126, 508]);
  });

  it('agrees with the decoder the app runs (ladder/program.ts)', () => {
    for (const [pub, app] of [
      [r.position.layout, POSITION_LAYOUT],
      [r.userStats.layout, USER_STATS_LAYOUT],
      [r.pool.layout, POOL_LAYOUT],
    ] as const) {
      for (const [k, off] of Object.entries(app)) {
        expect(pub.find((f) => camel(f.name) === k)?.offset, k).toBe(off);
      }
    }
    expect(r.position.discriminator).toEqual(Array.from(ACCOUNT_DISCRIMINATOR.Position));
    expect(r.userStats.discriminator).toEqual(Array.from(ACCOUNT_DISCRIMINATOR.UserStats));
    expect(r.pool.discriminator).toEqual(Array.from(ACCOUNT_DISCRIMINATOR.Pool));
  });

  it('publishes the seeds as lib.rs writes them, literal prefixes and a u32 LE nonce', () => {
    const consts = Object.fromEntries(
      [...state.matchAll(/pub const (\w+_SEED): &\[u8\] = b"([^"]+)";/g)].map(([, k, v]) => [k, v]),
    );
    const token = (part: string): string => {
      const p = part.trim();
      if (consts[p]) return `utf8:${consts[p]}`;
      if (/^pool\.key\(\)\.as_ref\(\)$/.test(p)) return 'pool';
      if (/^owner\.key\(\)\.as_ref\(\)$/.test(p)) return 'owner';
      if (/^&(user_stats\.next_nonce|position\.nonce)\.to_le_bytes\(\)$/.test(p)) return 'u32le:nonce';
      return `?${p}`;
    };
    const seedLines = [...lib.matchAll(/seeds = \[([^\]]+)\]/g)].map(([, s]) => s!.split(',').map(token));
    const userLines = seedLines.filter((s) => s[0] === 'utf8:user');
    const positionLines = seedLines.filter((s) => s[0] === 'utf8:position');
    expect(userLines.length).toBeGreaterThan(0);
    expect(positionLines.length).toBeGreaterThan(0);
    for (const s of userLines) expect(s).toEqual(r.userStats.seeds);
    for (const s of positionLines) expect(s).toEqual(r.position.seeds);
    expect(r.userStats.seeds).toEqual(['utf8:user', 'pool', 'owner']);
    expect(r.position.seeds).toEqual(['utf8:position', 'pool', 'owner', 'u32le:nonce']);
    // The nonce really is a u32 on both structs, so to_le_bytes is four bytes.
    expect(rustLayout(state, 'Position').find((f) => f.name === 'nonce')!.type).toBe('u32');
    expect(rustLayout(state, 'UserStats').find((f) => f.name === 'next_nonce')!.type).toBe('u32');
  });

  it('states the exact reconcile rule, which strict vault equality is not', () => {
    expect(r.reconcile).toContain('total_principal');
    expect(r.reconcile).toContain('orphaned_penalty');
    expect(r.reconcile).toMatch(/>=/);
  });
});

/* ------------------------------ Streamflow ------------------------------ */

type IdlType = string | { array: [string, number] };
const IDL_SIZE: Record<string, number> = { u8: 1, bool: 1, u32: 4, u64: 8, u128: 16, pubkey: 32 };
function idlLayout(fields: { name: string; type: IdlType }[]): { layout: LayoutField[]; end: number } {
  let offset = 8;
  const layout = fields.map((f) => {
    const t = typeof f.type === 'string' ? f.type : `${f.type.array[0]}[${f.type.array[1]}]`;
    const size = typeof f.type === 'string' ? IDL_SIZE[f.type] : IDL_SIZE[f.type.array[0]]! * f.type.array[1];
    if (!size) throw new Error(`unsized IDL type ${t}`);
    const out = { name: f.name, offset, type: t };
    offset += size;
    return out;
  });
  return { layout, end: offset };
}

describe('the lighthouse pool read is the one the Streamflow SDK pins', () => {
  const require = createRequire(import.meta.url);
  const idl = require('@streamflow/staking/solana/idl/stake_pool.json') as {
    address: string;
    metadata: { version: string };
    types: { name: string; type: { fields: { name: string; type: IdlType }[] } }[];
    accounts: { name: string; discriminator: number[] }[];
  };
  const fieldsOf = (name: string) => idl.types.find((t) => t.name === name)!.type.fields;
  let bayla: HeldContract;
  let r: Extract<HeldContract['read'], { stakeEntry: unknown }>;
  beforeEach(() => {
    bayla = byId(withLadder(), 'lighthouse-bayla');
    r = bayla.read as typeof r;
  });
  const fixture = JSON.parse(read(resolve(FIXTURES, 'solana.json')));

  it('names the SDK program, prefix, discriminator and filter offsets', () => {
    expect(bayla.program).toBe(sf.STAKE_POOL_PROGRAM_ID.mainnet);
    expect(bayla.program).toBe(idl.address);
    expect(r.stakeEntry.seeds[0]).toBe(`utf8:${sf.STAKE_ENTRY_PREFIX.toString('utf8')}`);
    expect(r.stakeEntry.seeds).toEqual(['utf8:stake-entry', 'stakePool', 'authority', 'u32le:nonce']);
    expect(r.stakeEntry.discriminator).toEqual(sf.STAKE_ENTRY_DISCRIMINATOR);
    expect(r.stakeEntry.discriminator).toEqual(idl.accounts.find((a) => a.name === 'StakeEntry')!.discriminator);
    const memcmp = r.stakeEntry.filters.flatMap((f) => ('memcmp' in f ? [f.memcmp] : []));
    expect(memcmp).toEqual([
      { offset: sf.STAKE_ENTRY_BYTE_OFFSETS.stakePool, bytes: 'stakePool' },
      { offset: sf.STAKE_ENTRY_BYTE_OFFSETS.authority, bytes: 'authority' },
    ]);
    expect(r.idlVersion).toBe(idl.metadata.version);
  });

  it('publishes the IDL StakeEntry and StakePool layouts, and the 224-byte account the chain holds', () => {
    const entry = idlLayout(fieldsOf('StakeEntry'));
    expect(r.stakeEntry.layout).toEqual(entry.layout);
    expect(r.stakePool.layout).toEqual(idlLayout(fieldsOf('StakePool')).layout);
    expect(entry.end).toBe(220);
    // The IDL's fields end at 220; the live account is 224, and a dataSize of 220 matches nothing.
    expect(r.stakeEntry.accountSize).toBe(fixture.accounts.lighthouseEntry0.length);
    expect(r.stakeEntry.accountSize).toBe(224);
    expect(r.stakeEntry.filters).toContainEqual({ dataSize: 224 });
  });

  it('matches the SDK derivations for the entry and the vault', () => {
    const pool = new PublicKey(bayla.address);
    const wallet = new PublicKey(fixture.wallet);
    const program = new PublicKey(bayla.program!);
    expect(bayla.vault).toBe(deriveStakeVaultPDA(program, pool).toBase58());
    expect(pda(r.stakeEntry.seeds, { stakePool: bayla.address, authority: fixture.wallet, nonce: 0 }, bayla.program!))
      .toBe(deriveStakeEntryPDA(program, pool, wallet, 0).toBase58());
  });

  it('says the stake-mint receipt is not principal', () => {
    expect(r.notPrincipal).toMatch(/stake_mint/);
  });
});

/* -------------------- offline reproduction from mainnet -------------------- */

function seedBytes(tokens: readonly string[], ctx: Record<string, string | number>): Uint8Array[] {
  return tokens.map((t) => {
    if (t.startsWith('utf8:')) return new TextEncoder().encode(t.slice(5));
    if (t.startsWith('u32le:')) {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, Number(ctx[t.slice(6)]), true);
      return b;
    }
    if (typeof ctx[t] !== 'string') throw new Error(`no value for seed ${t}`);
    return new PublicKey(ctx[t] as string).toBytes();
  });
}
function pda(tokens: readonly string[], ctx: Record<string, string | number>, program: string): string {
  return PublicKey.findProgramAddressSync(seedBytes(tokens, ctx), new PublicKey(program))[0].toBase58();
}
function field(data: Buffer, layout: readonly LayoutField[], name: string): bigint | number | string {
  const f = layout.find((x) => x.name === name);
  if (!f) throw new Error(`the published layout has no ${name}`);
  switch (f.type) {
    case 'u8': case 'bool': return data[f.offset]!;
    case 'u32': return data.readUInt32LE(f.offset);
    case 'u64': return data.readBigUInt64LE(f.offset);
    case 'i64': return data.readBigInt64LE(f.offset);
    case 'u128': return data.readBigUInt64LE(f.offset) + (data.readBigUInt64LE(f.offset + 8) << 64n);
    case 'pubkey': return new PublicKey(data.subarray(f.offset, f.offset + 32)).toBase58();
    default: throw new Error(`no reader for ${f.type}`);
  }
}

describe('the published spec alone reproduces recorded mainnet positions', () => {
  const sol = JSON.parse(read(resolve(FIXTURES, 'solana.json')));
  const acct = (k: string) => Buffer.from(sol.accounts[k].dataBase64, 'base64');
  let doc: HeldThroughBody;
  beforeEach(() => {
    doc = withLadder();
  });

  it('the lock ladder: PDAs, principal, position amount and the reconcile rule', () => {
    const c = byId(doc, 'bayla-ladder-pool');
    const r = c.read as Extract<HeldContract['read'], { position: unknown }>;
    const ctx = { pool: c.address, owner: sol.wallet };
    expect(pda(r.userStats.seeds, ctx, c.program!)).toBe(sol.accounts.ladderUserStats.address);
    const us = acct('ladderUserStats');
    expect(Array.from(us.subarray(0, 8))).toEqual(r.userStats.discriminator);
    expect(field(us, r.userStats.layout, 'next_nonce')).toBe(1);
    expect(field(us, r.userStats.layout, 'principal')).toBe(100_000_000_000n);
    expect(field(us, r.userStats.layout, 'owner')).toBe(sol.wallet);

    expect(pda(r.position.seeds, { ...ctx, nonce: 0 }, c.program!)).toBe(sol.accounts.ladderPosition0.address);
    const pos = acct('ladderPosition0');
    expect(pos.length).toBe(r.position.size);
    expect(field(pos, r.position.layout, 'amount')).toBe(100_000_000_000n);

    const pool = acct('ladderPool');
    expect(c.vault).toBe(sol.accounts.ladderStakeVault.address);
    expect(field(pool, r.pool.layout, 'stake_vault')).toBe(c.vault);
    const principal = field(pool, r.pool.layout, 'total_principal') as bigint;
    const orphaned = field(pool, r.pool.layout, 'orphaned_penalty') as bigint;
    const vault = acct('ladderStakeVault').readBigUInt64LE(doc.conventions.tokenAccountAmountOffset);
    expect(principal).toBe(3_784_087_687_012n);
    expect(vault >= principal + orphaned).toBe(true);
    expect(field(pool, r.pool.layout, 'decimals')).toBe(c.tokens[0]!.decimals);
    expect(field(pool, r.pool.layout, 'mint')).toBe(c.tokens[0]!.address);
  });

  it('the lighthouse pool: entry PDA, open amount, total stake against the vault', () => {
    const c = byId(doc, 'lighthouse-bayla');
    const r = c.read as Extract<HeldContract['read'], { stakeEntry: unknown }>;
    expect(pda(r.stakeEntry.seeds, { stakePool: c.address, authority: sol.wallet, nonce: 0 }, c.program!))
      .toBe(sol.accounts.lighthouseEntry0.address);
    const e = acct('lighthouseEntry0');
    expect(Array.from(e.subarray(0, 8))).toEqual(r.stakeEntry.discriminator);
    expect(field(e, r.stakeEntry.layout, 'stake_pool')).toBe(c.address);
    expect(field(e, r.stakeEntry.layout, 'authority')).toBe(sol.wallet);
    expect(field(e, r.stakeEntry.layout, 'amount')).toBe(369_369_000_000n);
    expect(field(e, r.stakeEntry.layout, 'closed_ts')).toBe(0n);

    const pool = acct('lighthousePool');
    expect(c.vault).toBe(sol.accounts.lighthouseVault.address);
    expect(field(pool, r.stakePool.layout, 'vault')).toBe(c.vault);
    expect(field(pool, r.stakePool.layout, 'mint')).toBe(c.tokens[0]!.address);
    const total = field(pool, r.stakePool.layout, 'total_stake') as bigint;
    const vault = acct('lighthouseVault').readBigUInt64LE(doc.conventions.tokenAccountAmountOffset);
    expect(total).toBe(2_700_285_885_758n);
    expect(vault >= total).toBe(true);
  });
});

/* --------------------------------- EVM --------------------------------- */

// Selectors read against the live contracts during verification (2026-09-22).
const LIVE_SELECTORS: Record<string, string> = {
  'balanceOf(address)': '0x70a08231',
  'positions(uint256)': '0x99fbab88',
  'positionsOf(address)': '0xf867d46b',
  'totalSupply()': '0x18160ddd',
  'nextPositionId()': '0x899346c7',
  'stakingToken()': '0x72f702f3',
};
const SOLIDITY: Record<string, string> = {
  'lighthouse-ladder': 'contracts/src/LighthouseLadder.sol',
  'lighthouse-staking': 'contracts/src/vendor/synthetix-staking-rewards/StakingRewards.sol',
  'tegridy-staking': 'contracts/src/TegridyStaking.sol',
  'tegridy-pair': 'contracts/src/TegridyPair.sol',
  'tegridy-lp-farming': 'contracts/src/TegridyLPFarming.sol',
};
// Inherited from the ERC-20 / ERC-721 base, so absent from the contract's own file.
const INHERITED = new Set(['balanceOf', 'ownerOf', 'totalSupply']);
const word = (hex: string, i: number): bigint => BigInt(`0x${hex.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
const returnIndex = (returns: string, name: string): number =>
  returns.replace(/^\(|\)$/g, '').split(',').map((p) => p.trim().split(/\s+/).pop()).indexOf(name);

describe('each EVM read names a real function with its selector', () => {
  let doc: HeldThroughBody;
  let evm: HeldContract[];
  beforeEach(() => {
    doc = withLadder();
    evm = [...doc.chains.ethereum, ...doc.chains.base];
  });

  it('every selector is keccak of its signature, and the live-read ones match the chain', () => {
    expect(new Set(evm.map((c) => c.kind))).toEqual(
      new Set(['lighthouse-ladder', 'tegridy-staking', 'tegridy-staking-legacy', 'tegridy-pair', 'tegridy-lp-farming']),
    );
    for (const c of evm) {
      const r = c.read as Extract<HeldContract['read'], { calls: unknown }>;
      expect(r.calls.length, c.id).toBeGreaterThan(0);
      for (const call of r.calls) {
        expect(call.selector, `${c.id} ${call.signature}`).toBe(toFunctionSelector(call.signature));
        if (LIVE_SELECTORS[call.signature]) expect(call.selector).toBe(LIVE_SELECTORS[call.signature]);
      }
    }
  });

  it('every function exists in the contract source the venue deployed', () => {
    expect(evm.length).toBe(11);
    for (const c of evm) {
      const file = SOLIDITY[c.kind === 'tegridy-staking-legacy' ? 'tegridy-staking' : c.kind];
      expect(file, `${c.kind} has no source pin`).toBeTruthy();
      const src = read(resolve(REPO, file!));
      const r = c.read as Extract<HeldContract['read'], { calls: unknown }>;
      for (const call of r.calls) {
        const name = call.signature.slice(0, call.signature.indexOf('('));
        if (INHERITED.has(name) && !new RegExp(`function ${name}\\(`).test(src)) continue;
        const declared = new RegExp(`function ${name}\\(|\\bpublic[\\w\\s]*\\b${name}\\s*[;=]`).test(src);
        expect(declared, `${c.id}: ${name} is not in ${file}`).toBe(true);
      }
    }
  });

  it('the ladder position tuple is the LighthouseLadder struct, in order', () => {
    const r = byId(doc, 'ladder-pepe').read as Extract<HeldContract['read'], { calls: unknown }>;
    const positions = r.calls.find((x) => x.signature === 'positions(uint256)')!;
    const struct = /struct Position \{([\s\S]*?)\}/.exec(read(resolve(REPO, 'contracts/src/LighthouseLadder.sol')))![1]!;
    const sol = [...struct.matchAll(/^\s*(\w+) (\w+);/gm)].map(([, t, n]) => `${t} ${n}`);
    expect(positions.returns).toBe(`(${sol.join(', ')})`);
  });

  it('the TegridyStaking position tuple is the Solidity struct, amount first', () => {
    const r = byId(doc, 'tegridy-staking').read as Extract<HeldContract['read'], { calls: unknown }>;
    const positions = r.calls.find((x) => x.signature === 'positions(uint256)')!;
    const struct = /struct Position \{([\s\S]*?)\}/.exec(read(resolve(REPO, 'contracts/src/lib/StakingViewLib.sol')))![1]!;
    const sol = [...struct.matchAll(/^\s*(\w+) (\w+);/gm)].map(([, t, n]) => `${t} ${n}`);
    expect(positions.returns).toBe(`(${sol.join(', ')})`);
    expect(returnIndex(positions.returns, 'amount')).toBe(0);
  });

  it('reproduces a recorded TegridyStaking position and the TegridyLP redemption from the spec alone', () => {
    const eth = JSON.parse(read(resolve(FIXTURES, 'ethereum.json')));
    const staking = byId(doc, 'tegridy-staking');
    const sr = staking.read as Extract<HeldContract['read'], { calls: unknown }>;
    const call = (r: typeof sr, sig: string) => r.calls.find((x) => x.signature === sig)!;
    const pad = (n: bigint | string) => BigInt(n).toString(16).padStart(64, '0');

    const positions = call(sr, 'positions(uint256)');
    expect(`${positions.selector}${pad(2n)}`).toBe(eth.calls.stakingPositions2.data);
    expect(eth.calls.stakingPositions2.to).toBe(staking.address);
    expect(word(eth.calls.stakingPositions2.result, returnIndex(positions.returns, 'amount'))).toBe(50_000n * 10n ** 18n);
    const ownerOf = call(sr, 'ownerOf(uint256)');
    expect(`${ownerOf.selector}${pad(2n)}`).toBe(eth.calls.stakingOwnerOf2.data);
    expect(`0x${eth.calls.stakingOwnerOf2.result.slice(-40)}`).toBe('0xe9b7ab8e367be5ac0e0c865136f1907bd73df53e');

    const pair = byId(doc, 'tegridy-lp-native');
    const pr = pair.read as Extract<HeldContract['read'], { calls: unknown }>;
    expect(pair.tokens.map((t) => t.address)).toEqual([TOWELI_ADDRESS, WETH_ADDRESS]);
    expect(`0x${eth.calls.pairToken0.result.slice(-40)}`).toBe(pair.tokens[0]!.address.toLowerCase());
    expect(`0x${eth.calls.pairToken1.result.slice(-40)}`).toBe(pair.tokens[1]!.address.toLowerCase());
    const bal = call(pr, 'balanceOf(address)');
    expect(`${bal.selector}${'14898258122C0740106391E6e8E4F17F3b6d456E'.toLowerCase().padStart(64, '0')}`)
      .toBe(eth.calls.pairBalanceOfHolder.data);
    const reserves = call(pr, 'getReserves()');
    expect(reserves.selector).toBe(eth.calls.pairGetReserves.data);
    const lp = word(eth.calls.pairBalanceOfHolder.result, 0);
    const r0 = word(eth.calls.pairGetReserves.result, returnIndex(reserves.returns, 'reserve0'));
    const r1 = word(eth.calls.pairGetReserves.result, returnIndex(reserves.returns, 'reserve1'));
    const supply = word(eth.calls.pairTotalSupply.result, 0);
    expect((lp * r0) / supply).toBe(70_664_848_749_588_392_345_307n);
    expect((lp * r1) / supply).toBe(1_827_478_461_867_831n);

    const farm = byId(doc, 'lp-farming');
    const fr = farm.read as Extract<HeldContract['read'], { calls: unknown }>;
    const raw = call(fr, 'rawBalanceOf(address)');
    expect(`${raw.selector}${'E9B7aB8e367bE5AC0e0c865136f1907bd73df53e'.toLowerCase().padStart(64, '0')}`)
      .toBe(eth.calls.farmRawBalanceOfStaker.data);
    expect(word(eth.calls.farmRawBalanceOfStaker.result, 0)).toBe(word(eth.calls.farmTotalRawSupply.result, 0));
    expect(fr.redeemsThrough).toBe('tegridy-lp-native');
  });
});

/* ------------------------------- the file ------------------------------- */

describe('the rendered file', () => {
  let text: string;
  let json: Record<string, unknown>;
  beforeEach(() => {
    text = renderHeldThrough(withLadder(), { date: '2026-09-22', commit: 'abcdef123456' });
    json = JSON.parse(text);
  });

  it('is ASCII JSON with no em dash, under its schema', () => {
    expect([...text].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    expect(text).not.toContain('\u2014');
    expect(json.schema).toBe(HELD_THROUGH_SCHEMA);
    expect(json.schema).toBe('memetics.finance/held-through/1');
    expect(json.site).toBe('https://memetics.finance');
    expect(json.generated).toBe('2026-09-22');
    expect(json.commit).toBe('abcdef123456');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('prints exactly the collected contracts, nothing lost to the compact layout', () => {
    expect(json.chains).toEqual(JSON.parse(JSON.stringify(withLadder().chains)));
    expect(json.conventions).toEqual(withLadder().conventions);
  });

  it('carries no balance: every number is an offset, a size, a decimals or a byte', () => {
    const numbers: number[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'number') numbers.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(json);
    expect(numbers.length).toBeGreaterThan(0);
    for (const n of numbers) expect(Number.isInteger(n) && n >= 0 && n < 1024, String(n)).toBe(true);
    expect(text).not.toMatch(/"(balance|totalStake|total_principal_value|amountRaw)"\s*:/);
  });

  it('every listed token has integer decimals', () => {
    expect(all(withLadder()).length).toBe(18);
    for (const c of all(withLadder())) {
      expect(c.tokens.length, c.id).toBeGreaterThan(0);
      for (const t of c.tokens) expect(Number.isInteger(t.decimals), `${c.id} ${t.symbol}`).toBe(true);
    }
  });
});

describe('the build writes it', () => {
  it('runs scripts/held-through.mjs in the explicit build chain, after llms.txt', () => {
    const pkg = JSON.parse(read(resolve(HERE, '../../package.json')));
    const steps = (pkg.scripts.build as string).split('&&').map((s) => s.trim());
    const at = steps.indexOf('node scripts/held-through.mjs');
    expect(at, 'held-through.mjs is not in the build chain').toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(steps.indexOf('node scripts/llms-txt.mjs'));
    expect(read(resolve(HERE, '../../scripts/held-through.mjs'))).toContain("ssrLoadModule('/src/lib/heldThrough.ts')");
  });
});
