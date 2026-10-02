#!/usr/bin/env node
// Day-one proofs on the MAINNET BINARIES, before any UI exists (plan set E, critic A8/A11).
// Talks ONLY to the local e2e validator and refuses a public genesis before anything else.
//
//   node scripts/solana-localnet/prove-onchain.mjs            (validator from start-validator.sh)
//
// It sends the ONE create transaction the site will ask a creator to sign, at worst-case
// inputs (32-byte name, 10-letter symbol, 100-byte URI), and proves on chain:
//   P1  Anchor accepts a trailing read-only account on create_launch (the launch-index key)
//   P2  Metaplex CreateMetadataAccountV3 with is_mutable=false works BEFORE create_launch
//       revokes the mint authority, and the metadata is locked with the creator as authority
//   P3  creator == trader in one buy, in the same transaction as create_launch
//   P4  the opening buy's tokens equal the frontend's quote EXACTLY (minTokensOut = quote)
//   P5  the worst-case transaction leaves >= 150 bytes of the 1,232-byte limit
//   P6  the platform reserve is paid at create: ATA(mint, global.fee_recipient) holds
//       exactly supply x platform_reserve_bps / 10,000 once the create lands
// and measures what the creator really pays (rent, Metaplex's own fee, network fee).
//
// The instructions are built with the frontend's own curve/ix.ts (the code the rehearsal
// ran) plus a Metaplex instruction encoded here by hand, independently of set T's builder.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const loaderSource = `
import { stripTypeScriptTypes } from 'node:module';
export async function resolve(s, c, n) { if (s[0]==='.' && !/\\.[cm]?[jt]sx?$/.test(s)) return n(s+'.ts', c); return n(s, c); }
export async function load(u, c, n) { if (!/\\.tsx?$/.test(new URL(u).pathname)) return n(u, c);
  const r = await n(u, { ...c, format: 'module' }); const src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
  return { ...r, format: 'module', source: stripTypeScriptTypes(src, { mode: 'strip' }) }; }`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURVE = path.join(HERE, '..', '..', 'src', 'lib', 'launcher', 'solana', 'curve');
const mod = (n) => import(pathToFileURL(path.join(CURVE, `${n}.ts`)).href);
const L = { ...(await mod('program')), ...(await mod('ix')), ...(await mod('read')), ...(await mod('math')) };
const W3 = await import('@solana/web3.js');
const SPL = await import('@solana/spl-token');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, LAMPORTS_PER_SOL } = W3;

const URL = process.env.E2E_SOLANA_RPC || 'http://127.0.0.1:8899';
const PUBLIC_GENESIS = ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'];
const conn = new Connection(URL, 'confirmed');
const genesis = await conn.getGenesisHash();
if (PUBLIC_GENESIS.includes(genesis)) throw new Error(`REFUSING: ${URL} has a PUBLIC genesis ${genesis}`);

const LP = L.REGISTERED_PROGRAM_ID;
const CP = L.REGISTERED_CP_SWAP_PROGRAM_ID;
const ids = { programId: LP, cpSwapProgram: CP };
const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const TX_LIMIT = 1232;
const HEADROOM = 150;

let failed = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${what}`); if (!ok) failed++; };

// ── Metaplex CreateMetadataAccountV3, encoded from the Token Metadata instruction docs ──
const borshStr = (s) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
function createMetadataV3({ metadata, mint, mintAuthority, payer, updateAuthority, name, symbol, uri }) {
  const data = Buffer.concat([
    Buffer.from([33]), // CreateMetadataAccountV3
    borshStr(name), borshStr(symbol), borshStr(uri),
    Buffer.from([0, 0]), // seller_fee_basis_points u16 = 0
    Buffer.from([0]), // creators: None
    Buffer.from([0]), // collection: None
    Buffer.from([0]), // uses: None
    Buffer.from([0]), // is_mutable = false
    Buffer.from([0]), // collection_details: None
  ]);
  return new TransactionInstruction({
    programId: METAPLEX,
    keys: [
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: mintAuthority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: updateAuthority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}
const metadataPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX)[0];
const launchIndex = PublicKey.findProgramAddressSync([Buffer.from('launch-index')], LP)[0];

function decodeMetadata(d) {
  let o = 1;
  const updateAuthority = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const mint = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const str = () => { const n = d.readUInt32LE(o); o += 4; const s = d.subarray(o, o + n).toString('utf8').replace(/\0+$/, ''); o += n; return s; };
  const name = str(), symbol = str(), uri = str();
  o += 2;
  if (d[o] === 1) { const n = d.readUInt32LE(o + 1); o += 1 + 4 + n * 34; } else o += 1;
  const primarySaleHappened = d[o] === 1; o += 1;
  const isMutable = d[o] === 1;
  return { key: d[0], updateAuthority, mint, name, symbol, uri, primarySaleHappened, isMutable };
}

// ── the launch ────────────────────────────────────────────────────────────────
console.log(`local genesis ${genesis} · ${URL}`);
const creator = Keypair.generate();
const mintKp = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(creator.publicKey, 5 * LAMPORTS_PER_SOL), 'confirmed');

const g = await L.readGlobal(conn, LP);
if (g.kind !== 'ok') throw new Error(`global ${g.kind}`);
const global = g.value;
const openingLamports = 50_000_000n; // 0.05 SOL, the e2e's opening buy
const fresh = {
  virtualSolReserves: global.initialVirtualSol, virtualTokenReserves: global.initialVirtualToken,
  realSolReserves: 0n,
  realTokenReserves: global.tokenTotalSupply - (global.tokenTotalSupply * global.platformReserveBps) / 10_000n,
  tradeFeeBps: global.tradeFeeBps, graduationTargetLamports: global.graduationTargetLamports, migrationReserveLamports: global.migrationReserveLamports,
};
const q = L.quoteBuyOnCurve(fresh, openingLamports);
if (!q.ok) throw new Error(`quote ${q.error}`);

// Worst case the site accepts: 32 UTF-8 bytes of name, 10 letters of symbol, 100-byte URI.
const name = 'Tegridy 🌽 worst case name 123'; // 32 bytes (the emoji is 4)
const symbol = 'ABCDEFGHIJ';
const uri = `https://ipfs.io/ipfs/b${'a'.repeat(78)}`; // 100 bytes
check(Buffer.byteLength(name) === 32 && Buffer.byteLength(uri) === 100, `worst-case inputs: name ${Buffer.byteLength(name)} B, symbol ${symbol.length}, uri ${Buffer.byteLength(uri)} B`);

const mintRent = await conn.getMinimumBalanceForRentExemption(SPL.MINT_SIZE);
const ata = L.associatedTokenAddress(mintKp.publicKey, creator.publicKey);
const { blockhash } = await conn.getLatestBlockhash('confirmed');
function buildCreate(n, s, u) {
  const create = L.createLaunchIx({ creator: creator.publicKey, mint: mintKp.publicKey, feeRecipient: global.feeRecipient }, ids);
  create.keys.push({ pubkey: launchIndex, isSigner: false, isWritable: false });
  const t = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    SystemProgram.createAccount({ fromPubkey: creator.publicKey, newAccountPubkey: mintKp.publicKey, lamports: mintRent, space: SPL.MINT_SIZE, programId: L.TOKEN_PROGRAM_ID }),
    SPL.createInitializeMint2Instruction(mintKp.publicKey, 6, creator.publicKey, null, L.TOKEN_PROGRAM_ID),
    createMetadataV3({ metadata: metadataPda(mintKp.publicKey), mint: mintKp.publicKey, mintAuthority: creator.publicKey, payer: creator.publicKey, updateAuthority: creator.publicKey, name: n, symbol: s, uri: u }),
    create,
    SPL.createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, ata, creator.publicKey, mintKp.publicKey),
    L.buyIx({ trader: creator.publicKey, mint: mintKp.publicKey, feeRecipient: global.feeRecipient, creator: creator.publicKey }, openingLamports, q.value.tokensOut, ids),
  );
  t.feePayer = creator.publicKey;
  t.recentBlockhash = blockhash;
  // The wallet signs first, the mint keypair after (Phantom's rule for multi-signer txs).
  t.partialSign(creator);
  t.partialSign(mintKp);
  return t;
}

// The real program's own caps, one byte over each (simulation only, nothing lands).
for (const [label, n, s, u, want] of [
  ['name 33 bytes', `${name}x`, symbol, uri, /Name too long/],
  ['symbol 11 letters', name, `${symbol}K`, uri, /Symbol too long/],
  ['uri 201 bytes', name, symbol, `https://ipfs.io/ipfs/b${'a'.repeat(179)}`, /URI too long/i],
]) {
  const r = await conn.simulateTransaction(buildCreate(n, s, u));
  check(!!r.value.err && (r.value.logs || []).some((l) => want.test(l)), `Token Metadata refuses ${label}: ${(r.value.logs || []).find((l) => /too long/.test(l)) ?? JSON.stringify(r.value.err)}`);
}

const tx = buildCreate(name, symbol, uri);
check(tx.verifySignatures(), 'both signatures verify');
const wire = tx.serialize();
check(wire.length + HEADROOM <= TX_LIMIT, `P5 worst-case create is ${wire.length} of ${TX_LIMIT} bytes (headroom ${TX_LIMIT - wire.length}, need >= ${HEADROOM}); ${tx.compileMessage().accountKeys.length} account keys`);

const sim = await conn.simulateTransaction(tx);
check(!sim.value.err, `simulation ok (${sim.value.unitsConsumed} CU)${sim.value.err ? ` err ${JSON.stringify(sim.value.err)}: ${(sim.value.logs || []).slice(-4).join(' | ')}` : ''}`);
if (sim.value.err) { console.log('not sending a transaction whose simulation failed'); process.exit(1); }
const before = BigInt(await conn.getBalance(creator.publicKey, 'confirmed'));
const sig = await conn.sendRawTransaction(wire, { preflightCommitment: 'confirmed' });
await conn.confirmTransaction(sig, 'confirmed');
const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
check(t && !t.meta.err, `create+open-buy landed: ${sig} (${t?.meta?.computeUnitsConsumed} CU, fee ${t?.meta?.fee})`);

const keys = t.transaction.message.staticAccountKeys ?? t.transaction.message.accountKeys;
check(keys.some((k) => k.equals(launchIndex)), `P1 the launch-index key ${launchIndex.toBase58()} is in the landed transaction and Anchor accepted it`);

const mi = await SPL.getMint(conn, mintKp.publicKey, 'confirmed');
check(mi.decimals === 6 && mi.mintAuthority === null && mi.freezeAuthority === null && mi.supply === global.tokenTotalSupply, `mint: 6 decimals, no mint authority, no freeze authority, supply ${mi.supply}`);

const mAcc = await conn.getAccountInfo(metadataPda(mintKp.publicKey), 'confirmed');
const md = mAcc && mAcc.owner.equals(METAPLEX) ? decodeMetadata(mAcc.data) : null;
check(md && md.mint.equals(mintKp.publicKey) && md.name === name && md.symbol === symbol && md.uri === uri && md.isMutable === false && md.updateAuthority.equals(creator.publicKey),
  `P2 metadata owned by Token Metadata: name/symbol/uri exact, is_mutable=${md?.isMutable}, update authority = creator`);
const mdRent = await conn.getMinimumBalanceForRentExemption(mAcc.data.length);
const metaplexFee = BigInt(mAcc.lamports) - BigInt(mdRent);

const c = await L.readCurve(conn, mintKp.publicKey, LP);
check(c.kind === 'ok' && c.value.curve.creator.equals(creator.publicKey), 'P3 curve exists, creator = the wallet that was also the trader');
const bal = BigInt((await conn.getTokenAccountBalance(ata, 'confirmed')).value.amount);
check(bal === q.value.tokensOut, `P4 creator ATA holds ${bal} = the frontend quote ${q.value.tokensOut} exactly (sent as minTokensOut)`);

const reserve = (global.tokenTotalSupply * global.platformReserveBps) / 10_000n;
const treasuryAta = L.associatedTokenAddress(mintKp.publicKey, global.feeRecipient);
const held = BigInt((await conn.getTokenAccountBalance(treasuryAta, 'confirmed')).value.amount);
check(reserve > 0n && held === reserve && c.kind === 'ok' && c.value.curve.platformReserveTokens === reserve && c.value.curve.platformReserveReleased === true,
  `P6 the treasury token account ${treasuryAta.toBase58()} holds ${held} = the platform reserve ${reserve}, and the curve records it paid`);

const after = BigInt(await conn.getBalance(creator.publicKey, 'confirmed'));
const curveRent = BigInt(await conn.getMinimumBalanceForRentExemption(L.BONDING_CURVE_SIZE));
console.log(`  cost to the creator: ${before - after} lamports = opening buy ${q.value.lamportsIn} + network fee ${t.meta.fee}`
  + ` + mint rent ${mintRent} + metadata rent ${mdRent} + Metaplex fee ${metaplexFee} + curve/vault/treasury/ATA rent (curve ${curveRent})`);
console.log(`  measure: create tx ${wire.length} B, ${t.meta.computeUnitsConsumed} CU; Metaplex create fee ${metaplexFee} lamports`);
console.log(JSON.stringify({ result: failed ? 'FAIL' : 'PASS', signature: sig, mint: mintKp.publicKey.toBase58(), txBytes: wire.length, cu: t.meta.computeUnitsConsumed, metaplexFeeLamports: String(metaplexFee), creatorPaid: String(before - after), hash: crypto.createHash('sha256').update(wire).digest('hex').slice(0, 16) }));
process.exit(failed ? 1 : 0);
