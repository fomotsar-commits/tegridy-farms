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
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
  type TransactionInstruction, type TransactionResponse, type VersionedTransactionResponse,
} from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, MINT_SIZE } from '@solana/spl-token';
import {
  REGISTERED_CP_SWAP_PROGRAM_ID, REGISTERED_PROGRAM_ID, WSOL_MINT, TOKEN_PROGRAM_ID,
  curvePda, poolStatePda, migrationAuthorityPda, type GlobalConfig,
} from '../../src/lib/launcher/solana/curve/program';
import { readCurve, readGlobal, readDeployment, type CurveAccount } from '../../src/lib/launcher/solana/curve/read';
import { associatedTokenAddress, buyIx, createLaunchIx } from '../../src/lib/launcher/solana/curve/ix';
import { quoteBuyOnCurve, type CurveTerms } from '../../src/lib/launcher/solana/curve/math';
import { decodeAmmConfig, decodePoolState, deriveAmmConfig, type AmmConfigView, type PoolStateView } from '../../src/lib/solana/cpswap/program';
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

/** Raw token amount of a token account; null when the account does not exist. */
export async function tokenAmount(account: PublicKey): Promise<bigint | null> {
  const a = await chain().getAccountInfo(account, 'confirmed');
  if (!a) return null;
  if (!a.owner.equals(TOKEN_PROGRAM_ID) || a.data.length < 72) throw new Error(`${account.toBase58()} is not a token account`);
  return a.data.readBigUInt64LE(64);
}

export const ata = (mint: PublicKey, owner: PublicKey) => associatedTokenAddress(mint, owner);

export interface MintFacts { mintAuthority: PublicKey | null; supply: bigint; decimals: number; freezeAuthority: PublicKey | null }
/** SPL Mint, decoded by hand: COption<Pubkey> | u64 | u8 | bool | COption<Pubkey>. */
export async function mintFacts(mint: PublicKey): Promise<MintFacts> {
  const a = await chain().getAccountInfo(mint, 'confirmed');
  if (!a || !a.owner.equals(TOKEN_PROGRAM_ID) || a.data.length !== 82) throw new Error(`${mint.toBase58()} is not an SPL mint`);
  const d = a.data;
  const opt = (o: number) => (d.readUInt32LE(o) === 1 ? new PublicKey(d.subarray(o + 4, o + 36)) : null);
  return { mintAuthority: opt(0), supply: d.readBigUInt64LE(36), decimals: d[44], freezeAuthority: opt(46) };
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
  const c = await conn.getAccountInfo(cfgAddr, 'confirmed');
  const ammConfig = c ? decodeAmmConfig(cfgAddr.toBase58(), c.data) : null;
  if (!ammConfig) throw new Error('AmmConfig does not decode');
  const v0 = await tokenAmount(new PublicKey(pool.token0Vault));
  const v1 = await tokenAmount(new PublicKey(pool.token1Vault));
  if (v0 === null || v1 === null) throw new Error('pool vault missing');
  const reserve0 = vaultAmountWithoutFee(v0, pool.protocolFeesToken0, pool.fundFeesToken0, pool.creatorFeesToken0);
  const reserve1 = vaultAmountWithoutFee(v1, pool.protocolFeesToken1, pool.fundFeesToken1, pool.creatorFeesToken1);
  if (reserve0 === null || reserve1 === null) throw new Error('pool books do not balance');
  return { address, owner: a.owner, pool, ammConfig, snapshot: { pool, vault0Amount: v0, vault1Amount: v1, reserve0, reserve1 } };
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
/** The landed transaction, polled briefly (confirmed commitment). */
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

export async function sendFromNode(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  await assertLocalCluster();
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  // FINALIZED, not confirmed: the page reads at the RPC's default (finalized) commitment, and
  // a fixture must be settled before the page under test looks at it.
  const sig = await sendAndConfirmTransaction(chain(), tx, signers, { commitment: 'confirmed', preflightCommitment: 'confirmed' });
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
