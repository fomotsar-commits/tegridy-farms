// Node-side view of the local e2e validator (scripts/solana-localnet/start-validator.sh).
//
// Every assertion the specs make about MONEY is made here, against the chain, and not
// against the page: the page is the thing under test. Reads go through the frontend's
// own curve/read.ts and cpswap modules (the code the mainnet rehearsal ran), EXCEPT the
// mint, the token balances and the Metaplex metadata, which are decoded by hand below so
// that a bug in set T's decoders cannot agree with itself here.
//
// rpc.ts / index.ts are deliberately NOT imported: they pull in lib/solana.ts, which
// reads import.meta.env at load and does not exist in Node.
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
  type TransactionInstruction, type TransactionResponse, type VersionedTransactionResponse,
} from '@solana/web3.js';
import {
  AuthorityType, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createInitializeMint2Instruction,
  createSetAuthorityInstruction, createSyncNativeInstruction, MINT_SIZE,
} from '@solana/spl-token';
import {
  REGISTERED_CP_SWAP_PROGRAM_ID, REGISTERED_PROGRAM_ID, WSOL_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  curvePda, poolStatePda, migrationAuthorityPda, type GlobalConfig,
} from '../../src/lib/launcher/solana/curve/program';
import { readCurve, readGlobal, readDeployment, type CurveAccount } from '../../src/lib/launcher/solana/curve/read';
import { MIGRATE_COMPUTE_UNITS, associatedTokenAddress, buyIx, createLaunchIx, migrateToAmmIx } from '../../src/lib/launcher/solana/curve/ix';
import { quoteBuyOnCurve, type CurveTerms } from '../../src/lib/launcher/solana/curve/math';
import { decodeAmmConfig, decodePoolState, deriveAmmConfig, type AmmConfigView, type PoolStateView } from '../../src/lib/solana/cpswap/program';
import { swapBaseInputIx } from '../../src/lib/solana/cpswap/ix';
import { quoteOwnPool, type PoolSnapshot } from '../../src/lib/solana/cpswap/read';
import { vaultAmountWithoutFee } from '../../src/lib/solana/cpswap/math';

export const LOCALNET_RPC = process.env.E2E_SOLANA_RPC ?? 'http://127.0.0.1:8899';
export const LAUNCH_PROGRAM = REGISTERED_PROGRAM_ID;
export const CP_SWAP_PROGRAM = REGISTERED_CP_SWAP_PROGRAM_ID;
export const VAULT = new PublicKey('GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd');
export const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const PUBLIC_GENESIS = new Set([
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', // mainnet-beta
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', // devnet
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY', // testnet
]);
export const WSOL = WSOL_MINT;

let shared: Connection | null = null;
export function chain(): Connection {
  shared ??= new Connection(LOCALNET_RPC, 'confirmed');
  return shared;
}

/** Refuse anything but a private local cluster, before any write. */
export async function assertLocalCluster(conn = chain()): Promise<string> {
  const g = await conn.getGenesisHash();
  if (PUBLIC_GENESIS.has(g)) throw new Error(`REFUSING: ${LOCALNET_RPC} reports the PUBLIC genesis ${g}`);
  return g;
}

/**
 * A fresh throwaway key with `sol` SOL. Airdropped from Node, never from the page:
 * requestAirdrop is not on the /api/solrpc allowlist and must stay off it.
 */
export async function fundedKeypair(sol: number): Promise<Keypair> {
  await assertLocalCluster();
  const kp = Keypair.generate();
  const conn = chain();
  const sig = await conn.requestAirdrop(kp.publicKey, Math.round(sol * LAMPORTS_PER_SOL));
  const bh = await conn.getLatestBlockhash('confirmed');
  await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  return kp;
}

export async function lamports(pk: PublicKey): Promise<bigint> {
  return BigInt(await chain().getBalance(pk, 'confirmed'));
}

/** Either token program: the classic one or Token-2022. */
export const isTokenProgram = (p: PublicKey) => p.equals(TOKEN_PROGRAM_ID) || p.equals(TOKEN_2022_PROGRAM_ID);

/**
 * Raw token amount of a token account, under either token program; null when the
 * account does not exist. The first 165 bytes are the same layout in both (a Token-2022
 * account only appends its extensions after them).
 */
export async function tokenAmount(account: PublicKey): Promise<bigint | null> {
  const a = await chain().getAccountInfo(account, 'confirmed');
  if (!a) return null;
  if (!isTokenProgram(a.owner) || a.data.length < 165) throw new Error(`${account.toBase58()} is not a token account`);
  return a.data.readBigUInt64LE(64);
}

/** The associated token account of `owner` for `mint`, under `program` (classic unless said). */
export const ata = (mint: PublicKey, owner: PublicKey, program: PublicKey = TOKEN_PROGRAM_ID) => associatedTokenAddress(mint, owner, program);

// The shape is pinned by launch-flow.spec.ts (`toEqual`): the owning program is read
// with `accountOwner`, never added here.
export interface MintFacts { mintAuthority: PublicKey | null; supply: bigint; decimals: number; freezeAuthority: PublicKey | null }
/**
 * SPL Mint, decoded by hand: COption<Pubkey> | u64 | u8 | bool | COption<Pubkey>.
 * A Token-2022 mint has the same first 82 bytes; its extensions follow them.
 */
export async function mintFacts(mint: PublicKey): Promise<MintFacts> {
  const a = await chain().getAccountInfo(mint, 'confirmed');
  const classicOk = !!a && a.owner.equals(TOKEN_PROGRAM_ID) && a.data.length === 82;
  const t22Ok = !!a && a.owner.equals(TOKEN_2022_PROGRAM_ID) && a.data.length >= 82;
  if (!a || !(classicOk || t22Ok)) throw new Error(`${mint.toBase58()} is not an SPL mint`);
  const d = a.data;
  const opt = (o: number) => (d.readUInt32LE(o) === 1 ? new PublicKey(d.subarray(o + 4, o + 36)) : null);
  return { mintAuthority: opt(0), supply: d.readBigUInt64LE(36), decimals: d[44], freezeAuthority: opt(46) };
}

/** The program that owns an account; null when it does not exist. */
export async function accountOwner(address: PublicKey): Promise<PublicKey | null> {
  const a = await chain().getAccountInfo(address, 'confirmed');
  return a ? a.owner : null;
}

/** The data length of an account; null when it does not exist. */
export async function accountDataLength(address: PublicKey): Promise<number | null> {
  const a = await chain().getAccountInfo(address, 'confirmed');
  return a ? a.data.length : null;
}

export const metadataAddress = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX)[0];

export interface MetadataFacts { owner: PublicKey; updateAuthority: PublicKey; mint: PublicKey; name: string; symbol: string; uri: string; isMutable: boolean; lamports: bigint; size: number }
/** Token Metadata `Metadata` (key 4), decoded by hand; strings lose their NUL padding. */
export async function metadataFacts(mint: PublicKey): Promise<MetadataFacts | null> {
  const a = await chain().getAccountInfo(metadataAddress(mint), 'confirmed');
  if (!a) return null;
  const d = a.data;
  let o = 1;
  const pk = () => { const k = new PublicKey(d.subarray(o, o + 32)); o += 32; return k; };
  const str = () => { const n = d.readUInt32LE(o); o += 4; const s = d.subarray(o, o + n).toString('utf8').replace(/\0+$/, ''); o += n; return s; };
  const updateAuthority = pk();
  const m = pk();
  const name = str(); const symbol = str(); const uri = str();
  o += 2; // seller_fee_basis_points
  if (d[o] === 1) o += 1 + 4 + d.readUInt32LE(o + 1) * 34; else o += 1; // creators
  o += 1; // primary_sale_happened
  return { owner: a.owner, updateAuthority, mint: m, name, symbol, uri, isMutable: d[o] === 1, lamports: BigInt(a.lamports), size: d.length };
}

export async function globalConfig(): Promise<GlobalConfig> {
  const r = await readGlobal(chain(), LAUNCH_PROGRAM);
  if (r.kind !== 'ok') throw new Error(`global: ${r.kind}`);
  return r.value;
}

export async function curve(mint: PublicKey): Promise<CurveAccount | null> {
  const r = await readCurve(chain(), mint, LAUNCH_PROGRAM);
  if (r.kind === 'absent') return null;
  if (r.kind !== 'ok') throw new Error(`curve ${mint.toBase58()}: ${r.kind}`);
  return r.value;
}

export async function curveOwner(mint: PublicKey): Promise<PublicKey | null> {
  const a = await chain().getAccountInfo(curvePda(mint, LAUNCH_PROGRAM), 'confirmed');
  return a ? a.owner : null;
}

export async function deployment(programId: PublicKey) {
  return readDeployment(chain(), programId);
}

/** The curve a fresh launch starts on, from the global terms (what the opening buy quotes against). */
export function freshCurveTerms(g: GlobalConfig): CurveTerms {
  const reserve = (g.tokenTotalSupply * g.platformReserveBps) / 10_000n;
  return {
    virtualSolReserves: g.initialVirtualSol,
    virtualTokenReserves: g.initialVirtualToken,
    realSolReserves: 0n,
    realTokenReserves: g.tokenTotalSupply - reserve,
    tradeFeeBps: g.tradeFeeBps,
    graduationTargetLamports: g.graduationTargetLamports,
    migrationReserveLamports: g.migrationReserveLamports,
  };
}

export function expectedOpeningBuy(g: GlobalConfig, lamportsIn: bigint) {
  const q = quoteBuyOnCurve(freshCurveTerms(g), lamportsIn);
  if (!q.ok) throw new Error(`opening buy quote: ${q.error}`);
  return q.value;
}

export interface PoolFacts { address: PublicKey; owner: PublicKey; pool: PoolStateView; snapshot: PoolSnapshot; ammConfig: AmmConfigView }
/** The pool recorded in the curve (never cp-swap's standard address), with its vaults. */
export async function launchPool(mint: PublicKey): Promise<PoolFacts> {
  const address = poolStatePda(mint, LAUNCH_PROGRAM);
  const conn = chain();
  const a = await conn.getAccountInfo(address, 'confirmed');
  if (!a) throw new Error(`no pool at ${address.toBase58()}`);
  const pool = decodePoolState(address.toBase58(), a.data);
  if (!pool) throw new Error('pool does not decode');
  const cfgAddr = deriveAmmConfig(CP_SWAP_PROGRAM, 0);
  return poolWithBooks(address, a.owner, pool, cfgAddr);
}

/** ANY pool of the pool program, at any address, with the fee tier it records itself. */
export async function poolFacts(address: PublicKey): Promise<PoolFacts> {
  const a = await chain().getAccountInfo(address, 'confirmed');
  if (!a) throw new Error(`no pool at ${address.toBase58()}`);
  if (!a.owner.equals(CP_SWAP_PROGRAM)) throw new Error(`${address.toBase58()} is not owned by the pool program`);
  const pool = decodePoolState(address.toBase58(), a.data);
  if (!pool) throw new Error('pool does not decode');
  return poolWithBooks(address, a.owner, pool, new PublicKey(pool.ammConfig));
}

async function poolWithBooks(address: PublicKey, owner: PublicKey, pool: PoolStateView, cfgAddr: PublicKey): Promise<PoolFacts> {
  const c = await chain().getAccountInfo(cfgAddr, 'confirmed');
  const ammConfig = c ? decodeAmmConfig(cfgAddr.toBase58(), c.data) : null;
  if (!ammConfig) throw new Error('AmmConfig does not decode');
  const v0 = await tokenAmount(new PublicKey(pool.token0Vault));
  const v1 = await tokenAmount(new PublicKey(pool.token1Vault));
  if (v0 === null || v1 === null) throw new Error('pool vault missing');
  const reserve0 = vaultAmountWithoutFee(v0, pool.protocolFeesToken0, pool.fundFeesToken0, pool.creatorFeesToken0);
  const reserve1 = vaultAmountWithoutFee(v1, pool.protocolFeesToken1, pool.fundFeesToken1, pool.creatorFeesToken1);
  if (reserve0 === null || reserve1 === null) throw new Error('pool books do not balance');
  return { address, owner, pool, ammConfig, snapshot: { pool, vault0Amount: v0, vault1Amount: v1, reserve0, reserve1 } };
}

/** What cp-swap will pay for `amountIn` of `inputMint`, from the pool as it is NOW. */
export async function expectedPoolOut(mint: PublicKey, inputMint: PublicKey, amountIn: bigint): Promise<bigint> {
  const p = await launchPool(mint);
  const slot = await chain().getSlot('confirmed');
  const now = (await chain().getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  const q = quoteOwnPool(p.snapshot, p.ammConfig, inputMint.toBase58(), amountIn, now);
  if (!q) throw new Error('the pool refuses this swap');
  return q.outAmount;
}

/**
 * A local test validator's clock runs ahead of the wall clock (measured 62 s after a few
 * hours), and a new pool's open_time is set from the validator's clock. A browser quotes
 * against ITS clock, so it calls a pool "not open yet" until the wall clock passes
 * open_time. Wait for that here; the drift is a localnet artifact.
 */
export async function waitForPoolOpenByWallClock(mint: PublicKey, maxMs = 5 * 60_000): Promise<number> {
  const open = Number((await launchPool(mint)).pool.openTime);
  const waitMs = Math.max(0, (open + 2) * 1000 - Date.now());
  if (waitMs > maxMs) throw new Error(`the pool opens ${Math.round(waitMs / 1000)} s from now by the wall clock: the validator clock has drifted too far, restart it`);
  await new Promise((r) => setTimeout(r, waitMs));
  return waitMs;
}

export const migrationAuthority =() => migrationAuthorityPda(LAUNCH_PROGRAM);

type AnyTx = TransactionResponse | VersionedTransactionResponse;
/**
 * The landed transaction, polled briefly (confirmed commitment).
 *
 * ONLY FOR A TRANSACTION THAT JUST LANDED. The local validator keeps a short transaction
 * history: about a thousand slots when idle, and far fewer in a full run (380 slots, about
 * three minutes, measured mid-run; fuller blocks fill its ledger sooner). A transaction
 * that landed more than a minute ago may already be gone from it, and this then says "did
 * not land" about one that did (lp-create P2 and lp-write E12, each once in a full run).
 * Where a test waits a long time before asking (the ones that hold status reads failing
 * until the blockhash runs out), ask what the transaction LEFT on chain instead: the pool
 * account, the share balance, the tokens.
 */
export async function landedTx(signature: string, tries = 40): Promise<AnyTx> {
  for (let i = 0; i < tries; i++) {
    const t = await chain().getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (t) return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`transaction ${signature} did not land`);
}

export function txAccountKeys(t: AnyTx): PublicKey[] {
  const m = t.transaction.message as unknown as { staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[] };
  return m.staticAccountKeys ?? m.accountKeys ?? [];
}

/** Lamports a transaction moved for `pk` (post - pre), from the landed tx's own meta. */
export function lamportDelta(t: AnyTx, pk: PublicKey): bigint {
  const i = txAccountKeys(t).findIndex((k) => k.equals(pk));
  if (i < 0 || !t.meta) throw new Error(`${pk.toBase58()} is not in the transaction`);
  return BigInt(t.meta.postBalances[i]) - BigInt(t.meta.preBalances[i]);
}

export const sol = (n: number) => BigInt(Math.round(n * LAMPORTS_PER_SOL));

// ── fixture writes, from Node (NOT the page under test) ──────────────────────
// For specs whose subject is not the launch itself (outcomes, responsive): a launch
// made directly with the frontend's own curve/ix.ts, with NO metadata, the way a launch
// made outside this site looks. The page must cope with that too.

export async function sendFromNode(ixs: TransactionInstruction[], signers: Keypair[], settle: 'confirmed' | 'finalized' = 'finalized'): Promise<string> {
  await assertLocalCluster();
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  // FINALIZED, not confirmed: the page reads at the RPC's default (finalized) commitment, and
  // a fixture must be settled before the page under test looks at it. A push made DURING a
  // scenario may stop at confirmed: the LP pages and the pool index read at confirmed.
  const sig = await sendAndConfirmTransaction(chain(), tx, signers, { commitment: 'confirmed', preflightCommitment: 'confirmed' });
  if (settle === 'confirmed') return sig;
  for (let i = 0; i < 120; i++) {
    const s = (await chain().getSignatureStatuses([sig])).value[0];
    if (s?.confirmationStatus === 'finalized') return sig;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`fixture transaction ${sig} did not finalize within 60 s`);
}

export async function createLaunchDirect(creator: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate();
  const rent = await chain().getMinimumBalanceForRentExemption(MINT_SIZE);
  await sendFromNode([
    SystemProgram.createAccount({ fromPubkey: creator.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, 6, creator.publicKey, null, TOKEN_PROGRAM_ID),
    // The platform reserve is paid inside create_launch to ATA(mint, global.fee_recipient).
    createLaunchIx({ creator: creator.publicKey, mint: mint.publicKey, feeRecipient: (await globalConfig()).feeRecipient }, { programId: LAUNCH_PROGRAM, cpSwapProgram: CP_SWAP_PROGRAM }),
  ], [creator, mint]);
  return mint.publicKey;
}

export async function buyDirect(trader: Keypair, mint: PublicKey, lamportsIn: bigint): Promise<bigint> {
  const c = await curve(mint);
  if (!c) throw new Error('no curve');
  const g = await globalConfig();
  const q = quoteBuyOnCurve(c.curve, lamportsIn);
  if (!q.ok) throw new Error(`buy quote: ${q.error}`);
  const account = ata(mint, trader.publicKey);
  await sendFromNode([
    createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, account, trader.publicKey, mint),
    buyIx({ trader: trader.publicKey, mint, feeRecipient: g.feeRecipient, creator: c.curve.creator }, lamportsIn, q.value.tokensOut, { programId: LAUNCH_PROGRAM, cpSwapProgram: CP_SWAP_PROGRAM }),
  ], [trader]);
  return q.value.tokensOut;
}

// ── stage-2 fixtures (liquidity): graduation, pushes, wrapped SOL, the drainer pattern ──

/** The vault's WSOL account: cp-swap's fixed create-pool-fee receiver (the binary's constant). */
export const CREATE_POOL_FEE_RECEIVER = new PublicKey('2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa');

export interface Graduated { mint: PublicKey; pool: PublicKey; signature: string }
/**
 * A launch made from Node, bought to its target by `buyer`, then graduated: the launch
 * program opens its pool at ['launchpool', mint] on the launch tier and burns the pool
 * shares. Never traded afterwards (the "nobody has traded since graduation" case).
 */
export async function graduateDirect(creator: Keypair, buyer: Keypair): Promise<Graduated> {
  const mint = await createLaunchDirect(creator);
  const g = await globalConfig();
  // The program caps a buy at what is left to the target, so asking for more fills it exactly.
  await buyDirect(buyer, mint, 2n * (g.graduationTargetLamports + g.migrationReserveLamports));
  const c = await curve(mint);
  if (!c) throw new Error('no curve after the buy');
  const signature = await sendFromNode([
    ComputeBudgetProgram.setComputeUnitLimit({ units: MIGRATE_COMPUTE_UNITS }),
    migrateToAmmIx(
      { payer: buyer.publicKey, creator: c.curve.creator, feeRecipient: g.feeRecipient, launchMint: mint, ammConfig: g.ammConfig, createPoolFee: CREATE_POOL_FEE_RECEIVER },
      { programId: LAUNCH_PROGRAM, cpSwapProgram: CP_SWAP_PROGRAM },
    ),
  ], [buyer]);
  const pool = poolStatePda(mint, LAUNCH_PROGRAM);
  if (!(await accountOwner(pool))?.equals(CP_SWAP_PROGRAM)) throw new Error(`graduation landed but no pool at ${pool.toBase58()}`);
  return { mint, pool, signature };
}

/**
 * A swap made from Node straight against the pool program (a price push), with no
 * slippage floor worth the name: it is the fixture moving the market, not the site.
 * SOL in or out goes through `kp`'s classic WSOL account, which is closed at the end
 * only when this call created it. Stops at `confirmed` unless told otherwise.
 * `outAmount` is the output account's token change; when SOL comes out and is unwrapped,
 * it is `kp`'s net lamport change instead (after the network fee).
 */
export async function swapDirect(
  kp: Keypair,
  pool: PublicKey,
  inputMint: PublicKey,
  amountIn: bigint,
  o: { settle?: 'confirmed' | 'finalized' } = {},
): Promise<{ signature: string; outAmount: bigint }> {
  const f = await poolFacts(pool);
  const p = f.pool;
  const m0 = new PublicKey(p.token0Mint);
  const m1 = new PublicKey(p.token1Mint);
  const inIs0 = inputMint.equals(m0);
  if (!inIs0 && !inputMint.equals(m1)) throw new Error(`${inputMint.toBase58()} is not a side of ${pool.toBase58()}`);
  const outputMint = inIs0 ? m1 : m0;
  const inProg = new PublicKey(inIs0 ? p.token0Program : p.token1Program);
  const outProg = new PublicKey(inIs0 ? p.token1Program : p.token0Program);
  const inAcc = ata(inputMint, kp.publicKey, inProg);
  const outAcc = ata(outputMint, kp.publicKey, outProg);
  const wsolAcc = ata(WSOL, kp.publicKey);
  const wsolExisted = (await chain().getAccountInfo(wsolAcc, 'confirmed')) !== null;
  const outBefore = (await tokenAmount(outAcc)) ?? 0n;
  const ixs: TransactionInstruction[] = [];
  if (inputMint.equals(WSOL)) {
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, wsolAcc, kp.publicKey, WSOL),
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: wsolAcc, lamports: amountIn }),
      createSyncNativeInstruction(wsolAcc),
    );
  }
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, outAcc, kp.publicKey, outputMint, outProg),
    swapBaseInputIx({
      programId: CP_SWAP_PROGRAM,
      payer: kp.publicKey,
      ammConfig: new PublicKey(p.ammConfig),
      poolState: pool,
      inputTokenAccount: inAcc,
      outputTokenAccount: outAcc,
      inputVault: new PublicKey(inIs0 ? p.token0Vault : p.token1Vault),
      outputVault: new PublicKey(inIs0 ? p.token1Vault : p.token0Vault),
      inputTokenProgram: inProg,
      outputTokenProgram: outProg,
      inputTokenMint: inputMint,
      outputTokenMint: outputMint,
      observationState: new PublicKey(p.observationKey),
      amountIn,
      minimumAmountOut: 1n,
    }),
  );
  const outIsSol = outputMint.equals(WSOL);
  if (!wsolExisted && (inputMint.equals(WSOL) || outIsSol)) ixs.push(createCloseAccountInstruction(wsolAcc, kp.publicKey, kp.publicKey));
  const signature = await sendFromNode(ixs, [kp], o.settle ?? 'confirmed');
  if (outIsSol && !wsolExisted) {
    const t = await landedTx(signature);
    return { signature, outAmount: lamportDelta(t, kp.publicKey) };
  }
  return { signature, outAmount: ((await tokenAmount(outAcc)) ?? 0n) - outBefore };
}

/**
 * Every pool of the pool program that pairs `mint` (either side), optionally only those
 * `creator` opened: "exactly one pool by this creator". Read by NODE straight from the
 * validator with getProgramAccounts (the page is never allowed to scan; Node is the
 * referee). Offsets from the PoolState layout: pool_creator 40, token_0_mint 168,
 * token_1_mint 200, 637 bytes.
 */
export async function poolsFor(mint: PublicKey, creator?: PublicKey): Promise<PublicKey[]> {
  await assertLocalCluster();
  const found = new Map<string, PublicKey>();
  for (const offset of [168, 200]) {
    const filters = [
      { dataSize: 637 },
      { memcmp: { offset, bytes: mint.toBase58() } },
      ...(creator ? [{ memcmp: { offset: 40, bytes: creator.toBase58() } }] : []),
    ];
    const rows = await chain().getProgramAccounts(CP_SWAP_PROGRAM, { commitment: 'confirmed', filters });
    for (const r of rows) found.set(r.pubkey.toBase58(), r.pubkey);
  }
  return [...found.values()].sort((a, b) => a.toBase58().localeCompare(b.toBase58()));
}

/** Wrap `lamports` of `kp`'s SOL into its classic WSOL account (created if missing). Settles to finalized. */
export async function wrapSol(kp: Keypair, lamports: bigint): Promise<PublicKey> {
  const account = ata(WSOL, kp.publicKey);
  await sendFromNode([
    createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, account, kp.publicKey, WSOL),
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: account, lamports }),
    createSyncNativeInstruction(account),
  ], [kp]);
  return account;
}

/**
 * The drainer pattern: `kp` hands ownership of its classic token account `account` to
 * `newOwner` (SetAuthority AccountOwner). The address stays `kp`'s ATA; the money in it
 * no longer answers to `kp`.
 */
export async function reassignAtaOwner(kp: Keypair, account: PublicKey, newOwner: PublicKey): Promise<string> {
  return sendFromNode([createSetAuthorityInstruction(account, kp.publicKey, AuthorityType.AccountOwner, newOwner)], [kp]);
}
