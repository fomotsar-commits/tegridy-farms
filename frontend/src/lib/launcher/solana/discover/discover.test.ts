// @vitest-environment node
//
// Discovery reads what ANYONE can write. Pinned here:
//   - token details decode strips padding, and a wrong owner / wrong mint is refused;
//   - the launch list keeps only SUCCESSFUL, TOP-LEVEL create_launch transactions on
//     the configured program, re-checks each curve (owner, mint, creator), keeps
//     "could not read" apart from zero, and says how many entries it looked at;
//   - the graduated pool is the one the curve records, and every field must match
//     what graduation writes: a pool squatted at the standard address is refused.
import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  curvePda,
  curveVaultPda,
  poolStatePda,
} from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import type { SolanaRpc } from '../curve/rpc';
import {
  ACCOUNT_POOL_STATE,
  POOL_STATE_LEN,
  POOL_STATE_OFFSETS,
  deriveLpMint,
  deriveObservation,
  deriveVault,
  derivePool,
  sortMints,
} from '../../../solana/cpswap/program';
import { launchIndexAddress } from '../write/config';
import { createLaunchInstructions } from '../write/launch';
import { METAPLEX_TOKEN_METADATA_ID, metadataPda } from '../write/metaplex';
import {
  AMM_CONFIG,
  BLOCKHASH,
  CPSWAP,
  FakeChain,
  LAUNCH,
  cfgLocal,
  encodeCurve,
  freshCurve,
  globalValue,
  rent,
  u64le,
} from '../write/testkit.fixture';
import type { OpenGate } from '../write/types';
import { decodeTokenMetadata, readTokenMetadata } from './metadata';
import {
  HIDDEN_MINTS,
  LIST_PAGE_SIZE,
  fullyDilutedValueLamports,
  listLaunchesByCreator,
  listRecentLaunches,
  parseLaunchTransaction,
  readCreatorHolding,
  readLaunchOrigin,
  shareBps,
} from './list';
import { readLaunchPool } from './pool';

// ── token details ────────────────────────────────────────────────────────────

function metadataAccount(mint: PublicKey, o: { name: string; symbol: string; uri: string; mutable?: boolean; ua?: PublicKey }): Uint8Array {
  const str = (s: string, pad: number) => {
    const b = Buffer.alloc(pad);
    Buffer.from(s, 'utf8').copy(b);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(pad);
    return Buffer.concat([len, b]);
  };
  return Uint8Array.from(Buffer.concat([
    Buffer.from([4]),
    (o.ua ?? mint).toBuffer(),
    mint.toBuffer(),
    str(o.name, 32),
    str(o.symbol, 10),
    str(o.uri, 200),
    Buffer.from([0, 0]), // sfbp
    Buffer.from([0]), // creators None
    Buffer.from([0]), // primary sale
    Buffer.from([o.mutable ? 1 : 0]),
    Buffer.from([1, 255, 1, 2]), // edition nonce, token standard … (ignored)
  ]));
}

describe('token details', () => {
  const MINT = Keypair.generate().publicKey;
  it('decodes and strips the NUL padding Metaplex stores', () => {
    const d = decodeTokenMetadata(metadataAccount(MINT, { name: 'Tegridy \u{1F33F}', symbol: 'TGD', uri: 'https://ipfs.io/ipfs/x' }), MINT);
    expect(d.ok && d.value).toMatchObject({ name: 'Tegridy \u{1F33F}', symbol: 'TGD', uri: 'https://ipfs.io/ipfs/x', isMutable: false });
  });
  it('reports editable details so the page can warn', () => {
    const d = decodeTokenMetadata(metadataAccount(MINT, { name: 'A', symbol: 'B', uri: 'u', mutable: true }), MINT);
    expect(d.ok && d.value.isMutable).toBe(true);
  });
  it('another token’s details are refused', () => {
    expect(decodeTokenMetadata(metadataAccount(Keypair.generate().publicKey, { name: 'A', symbol: 'B', uri: 'u' }), MINT).ok).toBe(false);
  });
  it('read: absent / wrong owner / unreadable are three different answers', async () => {
    const chain = new FakeChain();
    expect((await readTokenMetadata(chain, MINT)).kind).toBe('absent');
    chain.set(metadataPda(MINT), { lamports: 1, owner: Keypair.generate().publicKey, data: metadataAccount(MINT, { name: 'A', symbol: 'B', uri: 'u' }) });
    expect(await readTokenMetadata(chain, MINT)).toEqual({ kind: 'undecodable', reason: 'wrong-discriminator' });
    chain.set(metadataPda(MINT), { lamports: 1, owner: METAPLEX_TOKEN_METADATA_ID, data: metadataAccount(MINT, { name: 'A', symbol: 'B', uri: 'u' }) });
    expect((await readTokenMetadata(chain, MINT)).kind).toBe('ok');
    chain.getAccountInfo = async () => {
      throw new Error('down');
    };
    expect((await readTokenMetadata(chain, MINT)).kind).toBe('unreadable');
  });
});

// ── the launch list ──────────────────────────────────────────────────────────

const gate = { kind: 'open', cfg: cfgLocal, global: globalValue(), paused: false } as unknown as OpenGate;
const INDEX = launchIndexAddress(LAUNCH);

interface Launch {
  sig: string;
  creator: Keypair;
  mint: Keypair;
  buyTokens?: bigint | 'unreadable';
  /** Tokens another account received in the same transaction (a second wallet, or a buy through another program). */
  otherBought?: bigint;
  programId?: PublicKey;
  failed?: boolean;
}

function launchTx(l: Launch): unknown {
  const ixs = createLaunchInstructions(
    { ...gate, cfg: { ...cfgLocal, programId: l.programId ?? LAUNCH } } as OpenGate,
    { creator: l.creator.publicKey, mint: l.mint, metadata: { name: 'N', symbol: 'SS', uri: 'https://ipfs.io/ipfs/x' } },
    rent(82),
    l.buyTokens !== undefined ? { maxLamportsIn: 1_000n, minTokensOut: 1n } : null,
  );
  const tx = new Transaction({ feePayer: l.creator.publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 1 }).add(...ixs);
  const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  // Token balances as the RPC reports them: the curve vault is always there (create_launch
  // fills it); 'unreadable' = the record came back without them.
  const keys = tx.compileMessage().accountKeys;
  const m58 = l.mint.publicKey.toBase58();
  const program = l.programId ?? LAUNCH;
  const entry = (accountIndex: number, owner: PublicKey, amount: bigint) => ({ accountIndex, mint: m58, owner: owner.toBase58(), uiTokenAmount: { amount: amount.toString() } });
  const post: unknown[] = [];
  const writable: string[] = [];
  if (l.buyTokens !== 'unreadable') {
    post.push(entry(keys.findIndex((k) => k.equals(curveVaultPda(l.mint.publicKey, program))), curvePda(l.mint.publicKey, program), 900_000_000_000_000n));
    if (l.buyTokens !== undefined) {
      post.push(entry(keys.findIndex((k) => k.equals(associatedTokenAddress(l.mint.publicKey, l.creator.publicKey))), l.creator.publicKey, l.buyTokens));
    }
    if (l.otherBought !== undefined) {
      const other = Keypair.generate().publicKey;
      writable.push(associatedTokenAddress(l.mint.publicKey, other).toBase58());
      post.push(entry(keys.length, other, l.otherBought));
    }
  }
  return {
    blockTime: 1_700_000_000,
    meta: { err: l.failed ? { InstructionError: [0, 'Custom'] } : null, preTokenBalances: [], postTokenBalances: post, loadedAddresses: { writable, readonly: [] } },
    transaction: [raw, 'base64'],
  };
}

function noiseTx(from: Keypair): unknown {
  // Only MENTIONS the index address (anyone can do this for ~5,000 lamports).
  const ix = SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: from.publicKey, lamports: 1 });
  ix.keys.push({ pubkey: INDEX, isSigner: false, isWritable: false });
  const tx = new Transaction({ feePayer: from.publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 1 }).add(ix);
  return {
    blockTime: 1,
    meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
    transaction: [tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), 'base64'],
  };
}

class FakeJsonRpc {
  sigs = new Map<string, Array<{ signature: string; err: unknown; blockTime: number }>>();
  txs = new Map<string, unknown>();
  accounts = new Map<string, { data: Uint8Array; owner: PublicKey; lamports: number }>();
  calls: string[] = [];
  fail = new Set<string>();
  rpc: SolanaRpc = async (method, params) => {
    this.calls.push(method);
    if (this.fail.has(method)) throw new Error(`${method} down`);
    if (method === 'getSignaturesForAddress') {
      const [addr, opts] = params as [string, { limit: number; before?: string }];
      const all = this.sigs.get(addr) ?? [];
      const start = opts.before ? all.findIndex((s) => s.signature === opts.before) + 1 : 0;
      return all.slice(start, start + opts.limit);
    }
    if (method === 'getTransaction') return this.txs.get((params as [string])[0]) ?? null;
    if (method === 'getMultipleAccounts') {
      const keys = (params as [string[]])[0];
      return {
        context: { slot: 1 },
        value: keys.map((k) => {
          const a = this.accounts.get(k);
          return a ? { data: [Buffer.from(a.data).toString('base64'), 'base64'], owner: a.owner.toBase58(), lamports: a.lamports, executable: false } : null;
        }),
      };
    }
    throw new Error(`unexpected ${method}`);
  };
  index(address: PublicKey, entries: Array<{ sig: string; tx: unknown; err?: unknown }>) {
    this.sigs.set(address.toBase58(), entries.map((e) => ({ signature: e.sig, err: e.err ?? null, blockTime: 1 })));
    for (const e of entries) this.txs.set(e.sig, e.tx);
  }
  curve(mint: PublicKey, creator: PublicKey, owner: PublicKey = LAUNCH) {
    this.accounts.set(curvePda(mint, LAUNCH).toBase58(), { data: encodeCurve(freshCurve(mint, creator)), owner, lamports: rent(179) });
  }
}

const sig = (n: number) => `sig${n}`.padEnd(88, '1');

describe('parseLaunchTransaction', () => {
  it('a real create with an opening buy: creator, mint, the tokens the creator got', () => {
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), buyTokens: 12_345n };
    const o = parseLaunchTransaction(launchTx(l), l.sig, LAUNCH);
    expect(o?.creator.equals(l.creator.publicKey)).toBe(true);
    expect(o?.mint.equals(l.mint.publicKey)).toBe(true);
    expect(o?.openingBuyTokens).toBe(12_345n);
  });
  it('no opening buy = 0 (a real finding); a buy whose amount is missing = null (could not read)', () => {
    const a: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    expect(parseLaunchTransaction(launchTx(a), a.sig, LAUNCH)?.openingBuyTokens).toBe(0n);
    const b: Launch = { ...a, buyTokens: 'unreadable' };
    expect(parseLaunchTransaction(launchTx(b), b.sig, LAUNCH)?.openingBuyTokens).toBeNull();
  });
  // F3: counted from the token balances, so a buy we do not recognise as a top-level
  // creator buy (through another program, or from a second wallet bundled into the
  // launch) is still counted, never shown as a real-looking 0.
  it('counts tokens ANY wallet got in the launch transaction, not only a top-level creator buy', () => {
    const wrapped: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), otherBought: 500n };
    expect(parseLaunchTransaction(launchTx(wrapped), wrapped.sig, LAUNCH)?.openingBuyTokens).toBe(500n);
    const both: Launch = { ...wrapped, buyTokens: 12_345n };
    expect(parseLaunchTransaction(launchTx(both), both.sig, LAUNCH)?.openingBuyTokens).toBe(12_845n);
  });
  it('balances that do not include the curve vault are "could not read", never 0', () => {
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    const t = launchTx(l) as { meta: { postTokenBalances: unknown[] | null } };
    t.meta.postTokenBalances = [];
    expect(parseLaunchTransaction(t, l.sig, LAUNCH)?.openingBuyTokens).toBeNull();
    t.meta.postTokenBalances = null;
    expect(parseLaunchTransaction(t, l.sig, LAUNCH)?.openingBuyTokens).toBeNull();
  });
  it('refuses failed transactions, other programs and mere mentions', () => {
    const base: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    expect(parseLaunchTransaction(launchTx({ ...base, failed: true }), base.sig, LAUNCH)).toBeNull();
    expect(parseLaunchTransaction(launchTx({ ...base, programId: Keypair.generate().publicKey }), base.sig, LAUNCH)).toBeNull();
    expect(parseLaunchTransaction(noiseTx(base.creator), base.sig, LAUNCH)).toBeNull();
    expect(parseLaunchTransaction(null, base.sig, LAUNCH)).toBeNull();
  });
});

describe('listRecentLaunches', () => {
  it('keeps real launches only, re-checks each curve, and reports what it scanned', async () => {
    const f = new FakeJsonRpc();
    const good: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), buyTokens: 5n };
    const wrongOwner: Launch = { sig: sig(2), creator: Keypair.generate(), mint: Keypair.generate() };
    const failed: Launch = { sig: sig(3), creator: Keypair.generate(), mint: Keypair.generate() };
    const other: Launch = { sig: sig(4), creator: Keypair.generate(), mint: Keypair.generate(), programId: Keypair.generate().publicKey };
    f.index(INDEX, [
      { sig: good.sig, tx: launchTx(good) },
      { sig: sig(9), tx: noiseTx(good.creator) },
      { sig: wrongOwner.sig, tx: launchTx(wrongOwner) },
      { sig: failed.sig, tx: launchTx(failed), err: { InstructionError: [0, 'x'] } },
      { sig: other.sig, tx: launchTx(other) },
    ]);
    f.curve(good.mint.publicKey, good.creator.publicKey);
    f.curve(wrongOwner.mint.publicKey, wrongOwner.creator.publicKey, Keypair.generate().publicKey);
    f.accounts.set(metadataPda(good.mint.publicKey).toBase58(), { data: metadataAccount(good.mint.publicKey, { name: 'Good', symbol: 'GD', uri: 'https://ipfs.io/ipfs/x' }), owner: METAPLEX_TOKEN_METADATA_ID, lamports: 1 });

    const r = await listRecentLaunches(f.rpc, cfgLocal);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.items.map((i) => i.mint.toBase58())).toEqual([good.mint.publicKey.toBase58(), wrongOwner.mint.publicKey.toBase58()]);
    const [g, w] = r.value.items;
    expect(g!.curve.kind).toBe('ok');
    expect(g!.metadata.kind === 'ok' && g!.metadata.value.name).toBe('Good');
    expect(g!.openingBuyTokens).toBe(5n);
    expect(w!.curve).toEqual({ kind: 'undecodable', reason: 'wrong-discriminator' });
    expect(w!.metadata.kind).toBe('absent');
    expect(r.value.scanned).toBe(5);
    expect(r.value.before).toBeNull(); // fewer than a page: nothing older
    // The failed entry was skipped by its signature status; its transaction was never fetched.
    expect(f.calls.filter((c) => c === 'getTransaction')).toHaveLength(4);
    expect(f.calls.filter((c) => c === 'getMultipleAccounts')).toHaveLength(2);
  });

  it('a curve whose creator differs from the transaction’s is not accepted', async () => {
    const f = new FakeJsonRpc();
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    f.index(INDEX, [{ sig: l.sig, tx: launchTx(l) }]);
    f.curve(l.mint.publicKey, Keypair.generate().publicKey);
    const r = await listRecentLaunches(f.rpc, cfgLocal);
    expect(r.kind === 'ok' && r.value.items[0]!.curve).toEqual({ kind: 'undecodable', reason: 'malformed' });
  });

  it('unreadable stays unreadable: a failed account read is never a zero or an absence', async () => {
    const f = new FakeJsonRpc();
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    f.index(INDEX, [{ sig: l.sig, tx: launchTx(l) }]);
    f.fail.add('getMultipleAccounts');
    const r = await listRecentLaunches(f.rpc, cfgLocal);
    expect(r.kind === 'ok' && r.value.items[0]!.curve.kind).toBe('unreadable');
    expect(r.kind === 'ok' && r.value.items[0]!.metadata.kind).toBe('unreadable');
    const g = new FakeJsonRpc();
    g.fail.add('getSignaturesForAddress');
    expect((await listRecentLaunches(g.rpc, cfgLocal)).kind).toBe('unreadable');
  });

  it('pages at most 3 × 20 entries of noise, then returns a cursor and "scanned", not "no launches"', async () => {
    const f = new FakeJsonRpc();
    const spam = Keypair.generate();
    const entries = Array.from({ length: 70 }, (_, i) => ({ sig: sig(100 + i), tx: noiseTx(spam) }));
    f.index(INDEX, entries);
    const r = await listRecentLaunches(f.rpc, cfgLocal);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.items).toHaveLength(0);
    expect(r.value.scanned).toBe(3 * LIST_PAGE_SIZE);
    expect(r.value.before).toBe(sig(100 + 59));
    const next = await listRecentLaunches(f.rpc, cfgLocal, { before: r.value.before! });
    expect(next.kind === 'ok' && next.value.scanned).toBe(10);
    expect(next.kind === 'ok' && next.value.before).toBeNull();
  });

  it('a mint on the committed hide list is never listed, and is counted', async () => {
    const f = new FakeJsonRpc();
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate() };
    f.index(INDEX, [{ sig: l.sig, tx: launchTx(l) }]);
    (HIDDEN_MINTS as Set<string>).add(l.mint.publicKey.toBase58());
    try {
      const r = await listRecentLaunches(f.rpc, cfgLocal);
      expect(r.kind === 'ok' && r.value.items).toHaveLength(0);
      expect(r.kind === 'ok' && r.value.hidden).toBe(1);
    } finally {
      (HIDDEN_MINTS as Set<string>).delete(l.mint.publicKey.toBase58());
    }
  });

  it('by creator: only launches that wallet created', async () => {
    const f = new FakeJsonRpc();
    const me = Keypair.generate();
    const mine: Launch = { sig: sig(1), creator: me, mint: Keypair.generate() };
    const theirs: Launch = { sig: sig(2), creator: Keypair.generate(), mint: Keypair.generate() };
    f.index(me.publicKey, [{ sig: mine.sig, tx: launchTx(mine) }, { sig: theirs.sig, tx: launchTx(theirs) }]);
    const r = await listLaunchesByCreator(f.rpc, cfgLocal, me.publicKey);
    expect(r.kind === 'ok' && r.value.items.map((i) => i.mint.toBase58())).toEqual([mine.mint.publicKey.toBase58()]);
  });
});

describe('the launch transaction behind a mint page', () => {
  it('found through the token details account, oldest first', async () => {
    const f = new FakeJsonRpc();
    const l: Launch = { sig: sig(1), creator: Keypair.generate(), mint: Keypair.generate(), buyTokens: 77n };
    f.index(metadataPda(l.mint.publicKey), [{ sig: sig(5), tx: noiseTx(l.creator) }, { sig: l.sig, tx: launchTx(l) }]);
    const r = await readLaunchOrigin(f.rpc, cfgLocal, l.mint.publicKey);
    expect(r.kind === 'ok' && r.value.openingBuyTokens).toBe(77n);
    expect(r.kind === 'ok' && r.value.signature).toBe(l.sig);
  });
  it('absent when nothing is found; unreadable when the read fails', async () => {
    const f = new FakeJsonRpc();
    expect((await readLaunchOrigin(f.rpc, cfgLocal, Keypair.generate().publicKey)).kind).toBe('absent');
    f.fail.add('getSignaturesForAddress');
    expect((await readLaunchOrigin(f.rpc, cfgLocal, Keypair.generate().publicKey)).kind).toBe('unreadable');
  });
  it('creator holding: no account = holds 0 there; a failed read is unreadable, not 0', async () => {
    const chain = new FakeChain();
    const mint = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    expect(await readCreatorHolding(chain, mint, creator)).toEqual({ kind: 'ok', value: { amount: 0n, accountExists: false } });
    chain.tokenAccount(associatedTokenAddress(mint, creator), mint, creator, 42n);
    expect(await readCreatorHolding(chain, mint, creator)).toEqual({ kind: 'ok', value: { amount: 42n, accountExists: true } });
    chain.getAccountInfo = async () => {
      throw new Error('down');
    };
    expect((await readCreatorHolding(chain, mint, creator)).kind).toBe('unreadable');
    expect(shareBps(42n, 0n)).toBeNull();
    expect(shareBps(1n, 4n)).toBe(2_500n);
  });
  it('fully diluted value counts the whole supply at spot', () => {
    const c = freshCurve(Keypair.generate().publicKey, Keypair.generate().publicKey);
    const g = globalValue();
    expect(fullyDilutedValueLamports(c, g.tokenTotalSupply)).toBe(
      ((c.virtualSolReserves + c.realSolReserves) * g.tokenTotalSupply) / (c.virtualTokenReserves + c.realTokenReserves),
    );
  });
});

// ── the graduated pool ───────────────────────────────────────────────────────

describe('readLaunchPool', () => {
  const MINT = Keypair.generate().publicKey;
  const POOL = poolStatePda(MINT, LAUNCH);
  const { token0, token1 } = sortMints(WSOL_MINT, MINT);

  function poolBytes(over: Partial<Record<keyof typeof POOL_STATE_OFFSETS, PublicKey | number | bigint>> = {}): Uint8Array {
    const d = new Uint8Array(POOL_STATE_LEN);
    d.set(ACCOUNT_POOL_STATE, 0);
    const o = POOL_STATE_OFFSETS;
    const keys: Record<string, PublicKey> = {
      ammConfig: AMM_CONFIG, poolCreator: MINT, token0Vault: deriveVault(CPSWAP, POOL, token0), token1Vault: deriveVault(CPSWAP, POOL, token1),
      lpMint: deriveLpMint(CPSWAP, POOL), token0Mint: token0, token1Mint: token1, token0Program: TOKEN_PROGRAM_ID, token1Program: TOKEN_PROGRAM_ID,
      observationKey: deriveObservation(CPSWAP, POOL),
    };
    for (const [k, v] of Object.entries(keys)) d.set(((over[k as keyof typeof o] as PublicKey | undefined) ?? v).toBytes(), o[k as keyof typeof o]);
    d[o.status] = Number((over.status as number | undefined) ?? 0);
    d[o.lpMintDecimals] = 9;
    d.set(u64le(BigInt((over.openTime as bigint | undefined) ?? 0n)), o.openTime);
    return d;
  }

  function chainWith(poolData: Uint8Array, poolOwner: PublicKey = CPSWAP): FakeChain {
    const c = FakeChain.healthy();
    c.set(POOL, { lamports: 1, owner: poolOwner, data: poolData });
    c.tokenAccount(deriveVault(CPSWAP, POOL, token0), token0, POOL, 10_000_000n);
    c.tokenAccount(deriveVault(CPSWAP, POOL, token1), token1, POOL, 20_000_000n);
    return c;
  }
  const graduated = () => ({ ...freshCurve(MINT, MINT), complete: true, pool: POOL });

  // F4: the operator may point global.amm_config at new settings for FUTURE
  // graduations. A pool keeps the one it was created with, and is still tradeable.
  it('a pool created under earlier fee settings is still ok, with ITS OWN settings', async () => {
    const r = await readLaunchPool(chainWith(poolBytes()), cfgLocal, MINT, graduated(), globalValue({ ammConfig: Keypair.generate().publicKey }), 100);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.ammConfigAddress.equals(AMM_CONFIG)).toBe(true);
  });
  it('ok when every field is what graduation writes', async () => {
    const r = await readLaunchPool(chainWith(poolBytes()), cfgLocal, MINT, graduated(), globalValue(), 100);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.address.equals(POOL)).toBe(true);
  });
  it('not graduated: no pool', async () => {
    expect((await readLaunchPool(chainWith(poolBytes()), cfgLocal, MINT, freshCurve(MINT, MINT), globalValue())).kind).toBe('not-graduated');
  });
  it('a curve pointing at the STANDARD pair address (squattable) is a mismatch', async () => {
    const squat = derivePool(CPSWAP, AMM_CONFIG, token0, token1);
    const r = await readLaunchPool(chainWith(poolBytes()), cfgLocal, MINT, { ...graduated(), pool: squat }, globalValue());
    expect(r.kind).toBe('mismatch');
  });
  it('a pool account owned by another program is not a pool', async () => {
    expect((await readLaunchPool(chainWith(poolBytes(), Keypair.generate().publicKey), cfgLocal, MINT, graduated(), globalValue())).kind).toBe('not-a-pool');
  });
  it.each([
    ['ammConfig', Keypair.generate().publicKey],
    ['token0Mint', Keypair.generate().publicKey],
    ['token1Vault', Keypair.generate().publicKey],
    ['observationKey', Keypair.generate().publicKey],
    ['lpMint', Keypair.generate().publicKey],
    ['token0Program', new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')],
  ] as const)('a wrong %s is a mismatch', async (field, value) => {
    const r = await readLaunchPool(chainWith(poolBytes({ [field]: value })), cfgLocal, MINT, graduated(), globalValue());
    expect(r.kind).toBe('mismatch');
  });
  it('open-time is judged by the CHAIN clock (Clock sysvar), not the viewer clock', async () => {
    const clockAt = (t: bigint) => { const b = new Uint8Array(40); new DataView(b.buffer).setBigInt64(32, t, true); return b; };
    const c = chainWith(poolBytes({ openTime: 500n }));
    const CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');
    c.set(CLOCK, { lamports: 1, owner: new PublicKey('Sysvar1111111111111111111111111111111111111'), data: clockAt(501n) });
    const r = await readLaunchPool(c, cfgLocal, MINT, graduated(), globalValue());
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && r.value.chainTime).toBe(501n);
    c.set(CLOCK, { lamports: 1, owner: new PublicKey('Sysvar1111111111111111111111111111111111111'), data: clockAt(499n) });
    expect((await readLaunchPool(c, cfgLocal, MINT, graduated(), globalValue())).kind).toBe('closed-to-swaps');
    c.accounts.delete(CLOCK.toBase58());
    expect((await readLaunchPool(c, cfgLocal, MINT, graduated(), globalValue())).kind).toBe('unreadable');
  });

  it('swaps switched off, or not open yet: closed-to-swaps (no swap offered)', async () => {
    expect((await readLaunchPool(chainWith(poolBytes({ status: 4 })), cfgLocal, MINT, graduated(), globalValue(), 100)).kind).toBe('closed-to-swaps');
    expect((await readLaunchPool(chainWith(poolBytes({ openTime: 500n })), cfgLocal, MINT, graduated(), globalValue(), 100)).kind).toBe('closed-to-swaps');
  });
});
