// @vitest-environment node
//
// Opening a pool's two facts (SPEC_S2_CREATE N3, N13, N24): the public fee tier and the
// pool program's fee account, read BESIDE the LP gate. Neither can change the gate:
// readLpGate still reads only the cluster and the pool program, and a missing or
// unreadable tier leaves adding and removing liquidity open.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { AMM_CONFIG_OFFSETS, REGISTERED_PROGRAM_ID, deriveAmmConfig, publicTierConfig } from '../../../solana/cpswap/program';
import {
  CP_CREATE_POOL_FEE_RECEIVER,
  MAX_CREATE_FEE_LAMPORTS,
  feeAccountStateOf,
  readCreateFacts,
  readLpGate,
  tierStateOf,
  type GateRpc,
} from './config';
import { CPSWAP, FakeChain, VAULT, cfgLocal, encodeAmmConfig, encodeTokenAccount, rent, u64le } from './testkit.fixture';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_FEE_ACCOUNT = resolve(HERE, '../../../../../scripts/solana-localnet/golden/fee-ata.mainnet.json');
const TIER1 = publicTierConfig(CPSWAP);
const CP = CPSWAP.toBase58();

/** AmmConfig bytes with the owner's tier-1 values: index 1, 1% trade, 16% protocol, 0.15 SOL to open. */
function tierBytes(o: Partial<{ index: number; disable: boolean; createPoolFee: bigint; tradeFeeRate: bigint }> = {}): Uint8Array {
  const d = encodeAmmConfig();
  new DataView(d.buffer).setUint16(AMM_CONFIG_OFFSETS.index, o.index ?? 1, true);
  d[AMM_CONFIG_OFFSETS.disableCreatePool] = o.disable ? 1 : 0;
  d.set(u64le(o.tradeFeeRate ?? 10_000n), AMM_CONFIG_OFFSETS.tradeFeeRate);
  d.set(u64le(160_000n), AMM_CONFIG_OFFSETS.protocolFeeRate);
  d.set(u64le(o.createPoolFee ?? 150_000_000n), AMM_CONFIG_OFFSETS.createPoolFee);
  return d;
}

/** A native wrapped-SOL token account, as the mainnet fee account is. */
function nativeWsol(): Uint8Array {
  const d = encodeTokenAccount(WSOL_MINT, VAULT, 0n);
  const v = new DataView(d.buffer);
  v.setUint32(109, 1, true);
  v.setBigUint64(113, 2_039_280n, true);
  return d;
}

const acc = (owner: PublicKey | string, data: Uint8Array) => ({ owner: typeof owner === 'string' ? owner : owner.toBase58(), data });

describe('the public tier is derived from its index', () => {
  it('on mainnet, tier 1 is CapqvAA9… and tier 0 is BHMteE8u…', () => {
    expect(publicTierConfig(REGISTERED_PROGRAM_ID).toBase58()).toBe('CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy');
    expect(deriveAmmConfig(REGISTERED_PROGRAM_ID, 0).toBase58()).toBe('BHMteE8u6LAppswQmFmd2h7hp1fCfWtGahvVJnhRk8jW');
  });
});

describe('tierStateOf', () => {
  it('no account: not open yet (the vault has not created the tier)', () => {
    expect(tierStateOf(TIER1, null, CPSWAP)).toEqual({ kind: 'not-open', address: TIER1 });
  });

  it('not the pool program’s, not a tier, or another tier at this address: not a tier this site uses', () => {
    expect(tierStateOf(TIER1, acc(Keypair.generate().publicKey, tierBytes()), CPSWAP)).toMatchObject({ kind: 'not-a-tier', detail: /not owned by the pool program/ });
    expect(tierStateOf(TIER1, acc(CP, new Uint8Array(236)), CPSWAP)).toMatchObject({ kind: 'not-a-tier', detail: /not a fee tier/ });
    expect(tierStateOf(TIER1, acc(CP, tierBytes({ index: 0 })), CPSWAP)).toMatchObject({ kind: 'not-a-tier', detail: 'it is fee tier 0, not 1' });
  });

  it('its switch on: switched off', () => {
    expect(tierStateOf(TIER1, acc(CP, tierBytes({ disable: true })), CPSWAP)).toMatchObject({ kind: 'switched-off', config: { disableCreatePool: true } });
  });

  it('a fee to open of exactly 1 SOL is ready; one lamport more is too high', () => {
    expect(MAX_CREATE_FEE_LAMPORTS).toBe(1_000_000_000n);
    expect(tierStateOf(TIER1, acc(CP, tierBytes({ createPoolFee: 1_000_000_000n })), CPSWAP)).toMatchObject({ kind: 'ready' });
    expect(tierStateOf(TIER1, acc(CP, tierBytes({ createPoolFee: 1_000_000_001n })), CPSWAP)).toMatchObject({
      kind: 'fee-too-high',
      limit: 1_000_000_000n,
      config: { createPoolFee: 1_000_000_001n },
    });
  });

  it('the owner’s tier 1 reads ready with its live terms', () => {
    const s = tierStateOf(TIER1, acc(CP, tierBytes()), CPSWAP);
    expect(s).toMatchObject({ kind: 'ready', address: TIER1, config: { index: 1, tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, createPoolFee: 150_000_000n } });
  });
});

describe('feeAccountStateOf', () => {
  it('missing', () => {
    expect(feeAccountStateOf(null)).toEqual({ kind: 'missing' });
  });

  it.each([
    ['owned by Token-2022', () => acc(TOKEN_2022_PROGRAM_ID, nativeWsol()), /owned by Tokenz/],
    ['170 bytes', () => acc(TOKEN_PROGRAM_ID, new Uint8Array([...nativeWsol(), 0, 0, 0, 0, 0])), /170 bytes/],
    ['another mint', () => {
      const d = nativeWsol();
      d.set(Keypair.generate().publicKey.toBytes(), 0);
      return acc(TOKEN_PROGRAM_ID, d);
    }, /another token/],
    ['state 0 (not set up)', () => {
      const d = nativeWsol();
      d[108] = 0;
      return acc(TOKEN_PROGRAM_ID, d);
    }, /not set up/],
    ['state 2 (frozen)', () => {
      const d = nativeWsol();
      d[108] = 2;
      return acc(TOKEN_PROGRAM_ID, d);
    }, /frozen/],
    ['is_native tag 0', () => acc(TOKEN_PROGRAM_ID, encodeTokenAccount(WSOL_MINT, VAULT, 0n)), /not a native wrapped-SOL account/],
  ])('%s is not wrapped SOL, and says which', (_name, make, why) => {
    const s = feeAccountStateOf(make());
    expect(s.kind).toBe('not-wsol');
    if (s.kind === 'not-wsol') expect(s.detail).toMatch(why);
  });

  it('the golden mainnet fee account (2sa31zce…, owned by the token program, 165 bytes, native) is ready', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_FEE_ACCOUNT, 'utf8')) as { pubkey: string; account: { owner: string; data: [string, string] } };
    expect(golden.pubkey).toBe(CP_CREATE_POOL_FEE_RECEIVER.toBase58());
    const data = new Uint8Array(Buffer.from(golden.account.data[0], 'base64'));
    expect(data.length).toBe(165);
    expect(feeAccountStateOf({ owner: golden.account.owner, data })).toEqual({ kind: 'ready' });
  });
});

/** A chain with tier 1 and the fee account, whose reads of the addresses in `fail` throw. */
function createChain(o: { tier?: Uint8Array | null; fail?: PublicKey[]; failSync?: boolean } = {}): FakeChain {
  const c = FakeChain.healthy();
  if (o.tier !== null) c.set(TIER1, { lamports: rent(236), owner: CPSWAP, data: o.tier ?? tierBytes() });
  c.set(CP_CREATE_POOL_FEE_RECEIVER, { lamports: rent(165), owner: TOKEN_PROGRAM_ID, data: nativeWsol() });
  const base = c.getAccountInfo;
  const fail = (o.fail ?? []).map((k) => k.toBase58());
  c.getAccountInfo = ((address: PublicKey) => {
    if (fail.includes(address.toBase58())) {
      c.calls.push('getAccountInfo');
      if (o.failSync) throw new Error('boom (sync)');
      return Promise.reject(new Error('HTTP 429'));
    }
    return base(address);
  }) as typeof c.getAccountInfo;
  return c;
}

describe('readCreateFacts', () => {
  it('reads both, in one round', async () => {
    const c = createChain();
    const f = await readCreateFacts(c, cfgLocal);
    expect(f.tier).toMatchObject({ kind: 'ready', address: TIER1 });
    expect(f.feeAccount).toEqual({ kind: 'ready' });
    expect(c.calls).toEqual(['getAccountInfo', 'getAccountInfo']);
  });

  it('a tier read that throws is unread, and the fee account is still read', async () => {
    const f = await readCreateFacts(createChain({ fail: [TIER1] }), cfgLocal);
    expect(f.tier).toMatchObject({ kind: 'unread', address: TIER1, detail: expect.stringMatching(/HTTP 429/) });
    expect(f.feeAccount).toEqual({ kind: 'ready' });
  });

  it('never throws: both reads failing, even before returning a promise, are both unread', async () => {
    const f = await readCreateFacts(createChain({ fail: [TIER1, CP_CREATE_POOL_FEE_RECEIVER], failSync: true }), cfgLocal);
    expect(f.tier.kind).toBe('unread');
    expect(f.feeAccount.kind).toBe('unread');
  });

  it('no tier and no fee account: not open, missing', async () => {
    const c = createChain({ tier: null });
    c.accounts.delete(CP_CREATE_POOL_FEE_RECEIVER.toBase58());
    const f = await readCreateFacts(c, cfgLocal);
    expect(f).toEqual({ tier: { kind: 'not-open', address: TIER1 }, feeAccount: { kind: 'missing' } });
  });
});

describe('readLpGate does not change for opening a pool', () => {
  it('tier 1 missing, or a tier read that throws: the gate is open, and it still reads only genesis and the pool program', async () => {
    for (const c of [createChain({ tier: null }), createChain({ fail: [TIER1, CP_CREATE_POOL_FEE_RECEIVER] })]) {
      const g = await readLpGate(c as GateRpc, cfgLocal, 'on');
      expect(g).toEqual({ kind: 'open', cfg: cfgLocal, mode: 'on' });
      expect(c.calls).toEqual(['getGenesisHash', 'getAccountInfo', 'getAccountInfo']);
    }
  });
});
