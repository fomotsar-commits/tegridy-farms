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
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createFreezeAccountInstruction,
  createInitializeMetadataPointerInstruction, createInitializeMint2Instruction, createInitializeTransferFeeConfigInstruction, createInitializeTransferHookInstruction,
  createMintToInstruction, createSetAuthorityInstruction, createSyncNativeInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, getMintLen, tokenMetadataInitializeWithRentTransfer, tokenMetadataUpdateAuthority,
} from '@solana/spl-token';
import type { BrowserContext, Route } from '@playwright/test';
import { initializeIx } from '../../src/lib/solana/cpswap/ix';
import { deriveAmmConfig, deriveLpMint, derivePool, deriveVault, sortMints } from '../../src/lib/solana/cpswap/program';
import { CP_SWAP_PROGRAM, CREATE_POOL_FEE_RECEIVER, LOCALNET_RPC, METAPLEX, WSOL, accountOwner, assertLocalCluster, chain, metadataAddress, mintFacts, tokenAmount } from './chain';
import { BAYLA_COIN, SOL_COIN, USDC_COIN, type Coin } from './coins';

/** The vault's WSOL account: cp-swap's fixed create-pool-fee receiver (defined in chain.ts). */
export { CREATE_POOL_FEE_RECEIVER };

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

/**
 * A Token-2022 token that takes a fee out of every transfer (`feeBps` hundredths of a
 * percent), minted to `owner`'s Token-2022 ATA, mint authority revoked, no freeze authority.
 * The pool program ACCEPTS this extension, so a pool for it can exist. The site still
 * blocks the token: it cannot build an exact deposit or withdrawal for it.
 */
export async function createTransferFeeToken(owner: Keypair, o: { supply: bigint; feeBps: number; decimals?: number }): Promise<PublicKey> {
  const mint = Keypair.generate();
  const space = getMintLen([ExtensionType.TransferFeeConfig]);
  const rent = await chain().getMinimumBalanceForRentExemption(space);
  const account = getAssociatedTokenAddressSync(mint.publicKey, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
  await send([
    SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space, programId: TOKEN_2022_PROGRAM_ID }),
    // No authority over the fee, and no one who can collect it: the fee setting can never change.
    createInitializeTransferFeeConfigInstruction(mint.publicKey, null, null, o.feeBps, o.supply, TOKEN_2022_PROGRAM_ID),
    createInitializeMint2Instruction(mint.publicKey, o.decimals ?? 6, owner.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, account, owner.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, account, owner.publicKey, o.supply, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint.publicKey, owner.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  ], [owner, mint]);
  return mint.publicKey;
}

export interface Token2022MetadataOpts { name: string; symbol: string; decimals?: number; supply: bigint }

/**
 * A Token-2022 token whose ONLY extensions are MetadataPointer and TokenMetadata (the
 * BAYLA shape), minted to `owner`'s Token-2022 ATA: no freeze authority, the metadata's
 * update authority removed, the mint authority revoked. The pool program accepts exactly
 * these two extensions, and so does the site's token check.
 *
 * Built from `@solana/spl-token` alone (0.4.15 carries the metadata actions); the
 * metadata initialize tops up the mint's rent for the TLV entry it appends.
 */
export async function createToken2022MetadataOnly(owner: Keypair, o: Token2022MetadataOpts): Promise<PublicKey> {
  await assertLocalCluster();
  const mint = Keypair.generate();
  const space = getMintLen([ExtensionType.MetadataPointer]);
  const rent = await chain().getMinimumBalanceForRentExemption(space);
  await send([
    SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint.publicKey, null, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMint2Instruction(mint.publicKey, o.decimals ?? 6, owner.publicKey, null, TOKEN_2022_PROGRAM_ID),
  ], [owner, mint]);
  const confirm = { commitment: 'confirmed' as const, preflightCommitment: 'confirmed' as const };
  await tokenMetadataInitializeWithRentTransfer(chain(), owner, mint.publicKey, owner.publicKey, owner, o.name, o.symbol, 'https://example.test/token.json', [], confirm, TOKEN_2022_PROGRAM_ID);
  await tokenMetadataUpdateAuthority(chain(), owner, mint.publicKey, owner, null, [], confirm, TOKEN_2022_PROGRAM_ID);
  const account = getAssociatedTokenAddressSync(mint.publicKey, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
  await send([
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, account, owner.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, account, owner.publicKey, o.supply, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint.publicKey, owner.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  ], [owner]);
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
 * Open a pool that pairs `mint` with `coin` (SOL, USDC or BAYLA), with `coinAmount` of the
 * coin's base units and `tokens` base units, as `creator`.
 * `at: 'standard'` uses the standard address for the fee tier; `at: 'fresh'` a new
 * signing keypair (the fallback when the standard address is taken).
 * SOL is wrapped here first. Any other coin is spent from the creator's own account for
 * it, which must already hold it (giveUsdc, giveBayla).
 */
export async function createPairPool(
  creator: Keypair,
  mint: PublicKey,
  o: { coin: Coin; configIndex: 0 | 1; coinAmount: bigint; tokens: bigint; openTime?: bigint; at: 'standard' | 'fresh'; tokenProgram?: PublicKey },
): Promise<CreatedPool> {
  const config = deriveAmmConfig(CP_SWAP_PROGRAM, o.configIndex);
  const { token0, token1, flipped } = sortMints(o.coin.mint, mint);
  // sortMints(a, b): flipped means b sorted first, i.e. the token is token0.
  const coinIs0 = !flipped;
  // Each side follows its own mint's program (classic or Token-2022).
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  const coinAta = getAssociatedTokenAddressSync(o.coin.mint, creator.publicKey, false, o.coin.program);
  const tokenAta = getAssociatedTokenAddressSync(mint, creator.publicKey, false, tokenProgram);
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
    creatorToken0: coinIs0 ? coinAta : tokenAta,
    creatorToken1: coinIs0 ? tokenAta : coinAta,
    creatorLpToken: getAssociatedTokenAddressSync(lpMint, creator.publicKey),
    token0Program: coinIs0 ? o.coin.program : tokenProgram,
    token1Program: coinIs0 ? tokenProgram : o.coin.program,
    createPoolFee: CREATE_POOL_FEE_RECEIVER,
    initAmount0: coinIs0 ? o.coinAmount : o.tokens,
    initAmount1: coinIs0 ? o.tokens : o.coinAmount,
    openTime: o.openTime ?? 0n,
    poolState: fresh?.publicKey,
  });
  const wrap = o.coin.native
    ? [
        createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, coinAta, creator.publicKey, WSOL),
        SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: coinAta, lamports: o.coinAmount }),
        createSyncNativeInstruction(coinAta),
      ]
    : [];
  const signature = await send([...wrap, init], fresh ? [creator, fresh] : [creator]);
  return { address, lpMint, config, standard: address.equals(standard), signature };
}

/** Open a TOKEN/SOL pool with `sol` lamports and `tokens` base units: `createPairPool` with SOL. */
export function createSolPool(
  creator: Keypair,
  mint: PublicKey,
  o: { configIndex: 0 | 1; sol: bigint; tokens: bigint; openTime?: bigint; at: 'standard' | 'fresh'; tokenProgram?: PublicKey },
): Promise<CreatedPool> {
  return createPairPool(creator, mint, { coin: SOL_COIN, configIndex: o.configIndex, coinAmount: o.sol, tokens: o.tokens, openTime: o.openTime, at: o.at, tokenProgram: o.tokenProgram });
}

/**
 * The token's freeze authority freezes the pool's own vault for that token, so nothing
 * can leave it: a withdrawal is then blocked by the issuer, not by the pool program.
 */
export async function freezeVault(pool: PublicKey, mint: PublicKey, freezeAuthority: Keypair): Promise<PublicKey> {
  const program = (await accountOwner(mint)) ?? TOKEN_PROGRAM_ID;
  const vault = deriveVault(CP_SWAP_PROGRAM, pool, mint);
  await send([createFreezeAccountInstruction(vault, mint, freezeAuthority.publicKey, [], program)], [freezeAuthority]);
  return vault;
}

/**
 * Move `amount` pool shares from `from`'s share ATA to `to`'s (created if missing).
 * Pool-share mints are always classic.
 */
export async function transferLp(from: Keypair, to: PublicKey, lpMint: PublicKey, amount: bigint): Promise<PublicKey> {
  const src = getAssociatedTokenAddressSync(lpMint, from.publicKey);
  const dst = getAssociatedTokenAddressSync(lpMint, to, true);
  const { decimals } = await mintFacts(lpMint);
  await send([
    createAssociatedTokenAccountIdempotentInstruction(from.publicKey, dst, to, lpMint),
    createTransferCheckedInstruction(src, lpMint, dst, from.publicKey, amount, decimals),
  ], [from]);
  return dst;
}

/**
 * Empty and close `kp`'s ATA for `mint` under `program`: its tokens go to a fresh
 * holder's ATA first (a token account must be empty to close), its rent back to `kp`.
 */
export async function closeTokenAccount(kp: Keypair, mint: PublicKey, program: PublicKey = TOKEN_PROGRAM_ID): Promise<{ closed: PublicKey; movedTo: PublicKey | null }> {
  const account = getAssociatedTokenAddressSync(mint, kp.publicKey, false, program);
  const held = (await tokenAmount(account)) ?? 0n;
  const ixs: TransactionInstruction[] = [];
  let movedTo: PublicKey | null = null;
  if (held > 0n) {
    const holder = Keypair.generate().publicKey;
    movedTo = getAssociatedTokenAddressSync(mint, holder, false, program);
    const { decimals } = await mintFacts(mint);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, movedTo, holder, mint, program),
      createTransferCheckedInstruction(account, mint, movedTo, kp.publicKey, held, decimals, [], program),
    );
  }
  ixs.push(createCloseAccountInstruction(account, kp.publicKey, kp.publicKey, [], program));
  await send(ixs, [kp]);
  return { closed: account, movedTo };
}

// ── the two server-side neighbours of the page, for the browser context ───────

/**
 * /api/pools answered by the REAL handler (api/_lib/pool-index.js, which production reaches through the vercel.json rewrite to the catchall), in this Node process, against
 * the local validator. `down: true` answers 502 instead (the index-outage case).
 *
 * Each call is one actor (one browser context) and gets its own client address: the
 * real rate limiter keys on `req.ip` (api/_lib/ratelimit.js `extractIp`), so without
 * one every actor in the run shared a single bucket.
 *
 * `omit`: pool addresses left out of every answer, read at answer time (a spec may add
 * to the set later): the index "answering without" a pool, as a stale or lagging index
 * would. Nothing else in the answer changes.
 */
export async function installPoolIndex(context: BrowserContext, o: { down?: boolean; omit?: ReadonlySet<string> } = {}): Promise<{ calls: string[] }> {
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
    if (o.omit?.size && out.status === 200) {
      const payload = JSON.parse(out.body) as { pools?: unknown };
      if (Array.isArray(payload.pools)) payload.pools = payload.pools.filter((p) => !o.omit!.has(String(p)));
      out.body = JSON.stringify(payload);
    }
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
  /**
   * From now on, quote this mint at `solPerToken` (SOL per whole token). A mint the stub
   * did not price before is added, with `decimals` (default: the decimals it had, else 6).
   */
  setPrice(mint: string, solPerToken: number, decimals?: number): void;
}

/**
 * What the stub says USDC and BAYLA cost, in SOL per whole coin, unless a spec says
 * otherwise (`prices`, `setPrice`, `setDown`). A pool paired with USDC or BAYLA is checked
 * in that coin, which takes the coin's own SOL price as well as the token's, so a stub
 * that priced only tokens would leave every such pool "not checked". 0.005 SOL is a USDC
 * with SOL at 200; BAYLA at 0.000002 SOL is 0.0004 USDC.
 */
export const COIN_SOL_PRICE = { USDC: 0.005, BAYLA: 2e-6 } as const;

/**
 * Jupiter, stubbed, answering as production's proxy (api/_lib/aggregator-proxy.js) does:
 * - a mint in `down` is an outage: 502 `{"error":"Upstream service error"}`;
 * - a mint in `prices` (SOL per whole token) is quoted at that price less 0.5% each way
 *   (a route fee the page must cancel out), through one pool: `routeThrough` when given
 *   (one of OUR pools, so the page must not take it as an outside price), otherwise
 *   STUB_ROUTE_POOL;
 * - USDC and BAYLA are priced at `COIN_SOL_PRICE` unless `prices` names them;
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
  // A copy: setPrice changes this context's answers only, never the caller's map.
  const book = new Map<string, { solPerToken: number; decimals: number }>([
    [USDC_COIN.mint.toBase58(), { solPerToken: COIN_SOL_PRICE.USDC, decimals: USDC_COIN.decimals }],
    [BAYLA_COIN.mint.toBase58(), { solPerToken: COIN_SOL_PRICE.BAYLA, decimals: BAYLA_COIN.decimals }],
    ...prices,
  ]);
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
    const p = book.get(token);
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
    setPrice(mint: string, solPerToken: number, decimals?: number) {
      if (!(solPerToken > 0) || !Number.isFinite(solPerToken)) throw new Error(`setPrice: ${solPerToken} is not a price`);
      book.set(mint, { solPerToken, decimals: decimals ?? book.get(mint)?.decimals ?? 6 });
    },
  };
}

let freshCount = 0;
export interface FreshPricedOpts { solPerToken?: number; decimals?: number; supply?: bigint; name?: string; symbol?: string }
/**
 * A clean classic token of its OWN for one scenario (Group A runs twice against one
 * chain, so a scenario never shares a token with the other project's run): no freeze
 * authority, mint authority revoked, an immutable Metaplex name that copies no known
 * token, minted to `owner`, and priced in `stub` (default 1 SOL per million tokens).
 */
export async function freshPricedToken(owner: Keypair, stub: Pick<JupiterStub, 'setPrice'>, o: FreshPricedOpts = {}): Promise<PublicKey> {
  const decimals = o.decimals ?? 6;
  freshCount += 1;
  const tag = `${process.pid % 1000}${freshCount}`;
  const mint = await createClassicToken(owner, {
    decimals,
    supply: o.supply ?? 10_000_000n * 10n ** BigInt(decimals),
    name: { name: o.name ?? `E2E Fresh ${tag}`, symbol: o.symbol ?? `EF${tag}`.slice(0, 10) },
  });
  stub.setPrice(mint.toBase58(), o.solPerToken ?? 1e-6, decimals);
  return mint;
}

/**
 * Move `amount` base units of `mint` from `from` to `to`'s ATA (created if missing),
 * under the mint's own token program.
 */
export async function transferTokens(from: Keypair, to: PublicKey, mint: PublicKey, amount: bigint): Promise<PublicKey> {
  const program = (await accountOwner(mint)) ?? TOKEN_PROGRAM_ID;
  const src = getAssociatedTokenAddressSync(mint, from.publicKey, false, program);
  const dst = getAssociatedTokenAddressSync(mint, to, true, program);
  const { decimals } = await mintFacts(mint);
  await send([
    createAssociatedTokenAccountIdempotentInstruction(from.publicKey, dst, to, mint, program),
    createTransferCheckedInstruction(src, mint, dst, from.publicKey, amount, decimals, [], program),
  ], [from]);
  return dst;
}

/**
 * A squatter on the STANDARD tier-1 address for `mint`: `stranger` (who must already hold
 * the tokens) opens it at `priceX` times `fairSolPerToken`, with `sol` SOL in it, opening
 * for trading `openTimeFromNow` seconds after the chain's clock (0 = at once).
 */
export async function squatStandard(
  stranger: Keypair,
  mint: PublicKey,
  o: { priceX: number; openTimeFromNow: number; fairSolPerToken?: number; decimals?: number; sol?: bigint },
): Promise<CreatedPool> {
  const decimals = o.decimals ?? 6;
  const lamports = o.sol ?? 10_000_000n;
  const solPerToken = (o.fairSolPerToken ?? 1e-6) * o.priceX;
  const tokens = BigInt(Math.max(1, Math.round((Number(lamports) / 1e9 / solPerToken) * 10 ** decimals)));
  let openTime = 0n;
  if (o.openTimeFromNow > 0) {
    const slot = await chain().getSlot('confirmed');
    const now = BigInt((await chain().getBlockTime(slot)) ?? Math.floor(Date.now() / 1000));
    openTime = now + BigInt(Math.floor(o.openTimeFromNow));
  }
  const tokenProgram = (await accountOwner(mint)) ?? TOKEN_PROGRAM_ID;
  return createSolPool(stranger, mint, { configIndex: 1, sol: lamports, tokens, openTime, at: 'standard', tokenProgram });
}
