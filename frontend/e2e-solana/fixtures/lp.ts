// Node-side fixtures for the LP read specs: tokens of each kind, and pools made with the
// pool program exactly as a stranger (or our own create flow) would make them.
//
// Every write here goes to the LOCAL validator only (assertLocalCluster), from Node,
// never from the page under test. Pools are created with the frontend's own
// cpswap/ix.ts initializeIx (its first real execution against the mainnet binary), on
// fee tier 1 at the standard address, or at a fresh signing keypair when that address
// is taken: the same two paths the create flow will use.
import { randomUUID } from 'node:crypto';
import {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  AuthorityType, ExtensionType, MINT_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, createInitializeTransferHookInstruction,
  createMintToInstruction, createSetAuthorityInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync, getMintLen,
} from '@solana/spl-token';
import type { BrowserContext, Route } from '@playwright/test';
import { initializeIx } from '../../src/lib/solana/cpswap/ix';
import { deriveAmmConfig, deriveLpMint, derivePool, sortMints } from '../../src/lib/solana/cpswap/program';
import { CP_SWAP_PROGRAM, LOCALNET_RPC, METAPLEX, WSOL, assertLocalCluster, chain, metadataAddress } from './chain';

/** The vault's WSOL account: cp-swap's fixed create-pool-fee receiver. */
export const CREATE_POOL_FEE_RECEIVER = new PublicKey('2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa');

async function send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  await assertLocalCluster();
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0]!.publicKey;
  const sig = await sendAndConfirmTransaction(chain(), tx, signers, { commitment: 'confirmed', preflightCommitment: 'confirmed' });
  // Settle to finalized, so every later read (page, index, Node) sees it.
  for (let i = 0; i < 120; i++) {
    const s = (await chain().getSignatureStatuses([sig])).value[0];
    if (s?.confirmationStatus === 'finalized') return sig;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`fixture transaction ${sig} did not finalize within 60 s`);
}

const str = (s: string) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };

/** Metaplex CreateMetadataAccountV3 (discriminator 33), hand-built as in harness.spec.ts. */
function metadataIx(mint: PublicKey, authority: PublicKey, name: string, symbol: string, isMutable: boolean): TransactionInstruction {
  return new TransactionInstruction({
    programId: METAPLEX,
    keys: [
      { pubkey: metadataAddress(mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([33]), str(name), str(symbol), str('https://example.test/token.json'), Buffer.from([0, 0, 0, 0, 0, isMutable ? 1 : 0, 0])]),
  });
}

export interface ClassicTokenOpts {
  decimals?: number;
  /** Keep a freeze authority (the owner key) — the "freezable token" case. */
  freezable?: boolean;
  /** Keep the mint authority; default is to revoke it after minting. */
  keepMintAuthority?: boolean;
  /** Give it a Metaplex name record, immutable unless said. */
  name?: { name: string; symbol: string; mutable?: boolean };
  /** Minted to the owner's own token account. */
  supply: bigint;
}

/** A classic SPL token, minted to `owner`. */
export async function createClassicToken(owner: Keypair, o: ClassicTokenOpts): Promise<PublicKey> {
  const mint = Keypair.generate();
  const rent = await chain().getMinimumBalanceForRentExemption(MINT_SIZE);
  const ata = getAssociatedTokenAddressSync(mint.publicKey, owner.publicKey);
  const ixs: TransactionInstruction[] = [
    SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, o.decimals ?? 6, owner.publicKey, o.freezable ? owner.publicKey : null, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ata, owner.publicKey, mint.publicKey),
    createMintToInstruction(mint.publicKey, ata, owner.publicKey, o.supply),
  ];
  if (o.name) ixs.push(metadataIx(mint.publicKey, owner.publicKey, o.name.name, o.name.symbol, !!o.name.mutable));
  if (!o.keepMintAuthority) ixs.push(createSetAuthorityInstruction(mint.publicKey, owner.publicKey, AuthorityType.MintTokens, null));
  await send(ixs, [owner, mint]);
  return mint.publicKey;
}

/**
 * A Token-2022 token with a transfer hook. The hook program named is a random key: the
 * site refuses on the extension alone, and so does the pool program (utils/token.rs).
 */
export async function createTransferHookToken(owner: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate();
  const space = getMintLen([ExtensionType.TransferHook]);
  const rent = await chain().getMinimumBalanceForRentExemption(space);
  await send([
    SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferHookInstruction(mint.publicKey, owner.publicKey, Keypair.generate().publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMint2Instruction(mint.publicKey, 6, owner.publicKey, null, TOKEN_2022_PROGRAM_ID),
  ], [owner, mint]);
  return mint.publicKey;
}

export interface CreatedPool {
  address: PublicKey;
  lpMint: PublicKey;
  config: PublicKey;
  standard: boolean;
  signature: string;
}

/**
 * Open a TOKEN/SOL pool with `sol` lamports and `tokens` base units, as `creator`.
 * `at: 'standard'` uses the standard address for the fee tier; `at: 'fresh'` a new
 * signing keypair (the fallback when the standard address is taken).
 */
export async function createSolPool(creator: Keypair, mint: PublicKey, o: { configIndex: 0 | 1; sol: bigint; tokens: bigint; openTime?: bigint; at: 'standard' | 'fresh' }): Promise<CreatedPool> {
  const config = deriveAmmConfig(CP_SWAP_PROGRAM, o.configIndex);
  const { token0, token1, flipped } = sortMints(WSOL, mint);
  // sortMints(a, b): flipped means b sorted first, i.e. the token is token0.
  const solIs0 = !flipped;
  const wsolAta = getAssociatedTokenAddressSync(WSOL, creator.publicKey);
  const tokenAta = getAssociatedTokenAddressSync(mint, creator.publicKey);
  const fresh = o.at === 'fresh' ? Keypair.generate() : null;
  const standard = derivePool(CP_SWAP_PROGRAM, config, token0, token1);
  const address = fresh ? fresh.publicKey : standard;
  const lpMint = deriveLpMint(CP_SWAP_PROGRAM, address);
  const init = initializeIx({
    programId: CP_SWAP_PROGRAM,
    creator: creator.publicKey,
    ammConfig: config,
    token0Mint: token0,
    token1Mint: token1,
    creatorToken0: solIs0 ? wsolAta : tokenAta,
    creatorToken1: solIs0 ? tokenAta : wsolAta,
    creatorLpToken: getAssociatedTokenAddressSync(lpMint, creator.publicKey),
    token0Program: TOKEN_PROGRAM_ID,
    token1Program: TOKEN_PROGRAM_ID,
    createPoolFee: CREATE_POOL_FEE_RECEIVER,
    initAmount0: solIs0 ? o.sol : o.tokens,
    initAmount1: solIs0 ? o.tokens : o.sol,
    openTime: o.openTime ?? 0n,
    poolState: fresh?.publicKey,
  });
  const signature = await send([
    createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, wsolAta, creator.publicKey, WSOL),
    SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: wsolAta, lamports: o.sol }),
    createSyncNativeInstruction(wsolAta),
    init,
  ], fresh ? [creator, fresh] : [creator]);
  return { address, lpMint, config, standard: address.equals(standard), signature };
}

// ── the two server-side neighbours of the page, for the browser context ───────

/**
 * /api/pools answered by the REAL handler (api/_lib/pool-index.js, which production reaches through the vercel.json rewrite to the catchall), in this Node process, against
 * the local validator. `down: true` answers 502 instead (the index-outage case).
 *
 * Each call is one actor (one browser context) and gets its own client address: the
 * real rate limiter keys on `req.ip` (api/_lib/ratelimit.js `extractIp`), so without
 * one every actor in the run shared a single bucket.
 */
export async function installPoolIndex(context: BrowserContext, o: { down?: boolean } = {}): Promise<{ calls: string[] }> {
  process.env.SOLANA_RPC_URL = LOCALNET_RPC;
  const mod = (await import(new URL('../../api/_lib/pool-index.js', import.meta.url).href)) as {
    handlePoolIndex: (req: unknown, res: unknown) => Promise<unknown>;
    __resetPoolIndexCache: () => void;
  };
  mod.__resetPoolIndexCache();
  const calls: string[] = [];
  const ip = `e2e-${randomUUID()}`;
  await context.route('**/api/pools?*', async (route: Route) => {
    const url = new URL(route.request().url());
    calls.push(url.search);
    if (o.down) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'The pool index could not read the chain' }) });
    const out = { status: 500, headers: {} as Record<string, string>, body: '' };
    const res = {
      setHeader(k: string, v: string) { out.headers[k] = String(v); return res; },
      status(c: number) { out.status = c; return res; },
      json(p: unknown) { out.body = JSON.stringify(p); return res; },
      end() { return res; },
    };
    const req = { ip, method: route.request().method(), query: Object.fromEntries(url.searchParams.entries()), headers: await route.request().allHeaders() };
    await mod.handlePoolIndex(req, res);
    return route.fulfill({ status: out.status, contentType: 'application/json', headers: out.headers, body: out.body });
  });
  return { calls };
}

/**
 * The pool every stubbed quote says its price came through: a fixed key with no account
 * on the validator, so the page's own-pool check reads it as not ours. (A quote with an
 * empty route is not an outside price at all: outsidePrice.ts reads it as unread.)
 */
export const STUB_ROUTE_POOL = new PublicKey(new Uint8Array(32).fill(0xe2));

export interface JupiterStub {
  /** Every token mint a quote was asked for, in order. */
  asked: string[];
  /** From now on, answer this mint as Jupiter being down (`on`), or as before (`!on`). */
  setDown(mint: string, on: boolean): void;
}

/**
 * Jupiter, stubbed, answering as production's proxy (api/_lib/aggregator-proxy.js) does:
 * - a mint in `down` is an outage: 502 `{"error":"Upstream service error"}`;
 * - a mint in `prices` (SOL per whole token) is quoted at that price less 0.5% each way
 *   (a route fee the page must cancel out), through one pool: `routeThrough` when given
 *   (one of OUR pools, so the page must not take it as an outside price), otherwise
 *   STUB_ROUTE_POOL;
 * - any other mint has no route: 404 `{"error":"No route","code":"NO_ROUTE"}`, the
 *   proxy's fixed answer to Jupiter's own no-route codes;
 * - any path but the quote is a 502.
 */
export async function installJupiterStub(
  context: BrowserContext,
  prices: Map<string, { solPerToken: number; decimals: number }>,
  o: { routeThrough?: PublicKey; down?: Set<string> } = {},
): Promise<JupiterStub> {
  const SOL = WSOL.toBase58();
  const asked: string[] = [];
  const down = new Set(o.down ?? []);
  const routePool = (o.routeThrough ?? STUB_ROUTE_POOL).toBase58();
  const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await context.route('**/api/jupiter/**', async (route: Route) => {
    const u = new URL(route.request().url());
    if (!u.pathname.endsWith('/swap/v1/quote')) return route.fulfill(json(502, { error: 'Upstream service error' }));
    const input = u.searchParams.get('inputMint') ?? '';
    const output = u.searchParams.get('outputMint') ?? '';
    const amount = BigInt(u.searchParams.get('amount') ?? '0');
    const token = input === SOL ? output : input;
    asked.push(token);
    if (down.has(token)) return route.fulfill(json(502, { error: 'Upstream service error' }));
    const p = prices.get(token);
    if (!p) return route.fulfill(json(404, { error: 'No route', code: 'NO_ROUTE' }));
    const fee = 0.995;
    const out = input === SOL
      ? BigInt(Math.floor((Number(amount) / 1e9 / p.solPerToken) * 10 ** p.decimals * fee))
      : BigInt(Math.floor((Number(amount) / 10 ** p.decimals) * p.solPerToken * 1e9 * fee));
    return route.fulfill(json(200, {
      inputMint: input, outputMint: output, inAmount: amount.toString(), outAmount: out.toString(), otherAmountThreshold: out.toString(),
      swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', routePlan: [{ swapInfo: { ammKey: routePool } }],
    }));
  });
  return {
    asked,
    setDown(mint: string, on: boolean) {
      if (on) down.add(mint);
      else down.delete(mint);
    },
  };
}
