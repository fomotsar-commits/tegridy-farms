#!/usr/bin/env node
// Proof of the pool program's ONE added instruction, create_lp_metadata, on a LOCAL validator.
// Talks ONLY to that validator and refuses a public genesis before anything else.
//
//   LPM_RPC=http://127.0.0.1:18899 node scripts/solana-localnet/prove-lp-metadata.mjs
//
// THE VALIDATOR IT NEEDS is not the e2e one. start-validator.sh pins the binary deployed on
// mainnet, which does not have this instruction yet. This proof needs (a) the NEW pool program
// binary at the pool program's id, (b) Metaplex and the feature set cloned from mainnet, (c) the
// harness's genesis accounts, and (d) the two real mainnet pools with their lp mints, vaults, fee
// config and observation accounts, byte for byte, so it runs against the state an upgrade meets.
// Until the upgrade ships, the start script for that validator is kept with the upgrade's build
// artefacts, outside the repo, so the committed start script keeps refusing any other binary.
//
// What it proves, on a freshly opened pool AND on both real pools:
//   a  the call lands and the record reads back: name, symbol, the exact link, editor = the admin
//      vault, mutable, its size and its lamports; and what it cost in compute units
//   b  the refusals, each by its own error code, each before the call that then succeeds:
//      an lp mint that is not this pool's (three ways), a pool account our program does not own
//      (and one it owns that is not a pool), a wrong editor (a stranger, and the multisig
//      account), a wrong record address, a program that is not Metaplex, a wrong signing
//      address, and a second call for the same mint
//   c  a record address a stranger funded first still works (below and above the rent minimum),
//      and costs the caller the same
//   d  the inner call is handed Metaplex's own six accounts and nothing else, even when the
//      caller appends vaults and token programs; and the pool, its lp mint, both vaults, its
//      observation account, its fee config and the signing address are byte-identical after
//   e  deposit, swap and withdraw still work on both real pools, to the exact amounts the
//      site's own maths (src/lib/solana/cpswap/math.ts) gives
//
// Run against the binary WITHOUT the instruction, parts a to d FAIL and part e passes with the
// same amounts: that is the control for both halves. Exit 1 on any failure.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { loadVerifiedIdls, baylaMintAuthority, usdcMintAuthority, VAULT, FEE_ATA, BAYLA_MINT, USDC_MINT, WSOL_MINT } from './genesis-accounts.mjs';

const loaderSource = `
import { stripTypeScriptTypes } from 'node:module';
export async function resolve(s, c, n) { if (s[0]==='.' && !/\\.[cm]?[jt]sx?$/.test(s)) return n(s+'.ts', c); return n(s, c); }
export async function load(u, c, n) { if (!/\\.tsx?$/.test(new URL(u).pathname)) return n(u, c);
  const r = await n(u, { ...c, format: 'module' }); const src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
  return { ...r, format: 'module', source: stripTypeScriptTypes(src, { mode: 'strip' }) }; }`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CPSWAP_LIB = path.join(HERE, '..', '..', 'src', 'lib', 'solana', 'cpswap');
const mod = (n) => import(pathToFileURL(path.join(CPSWAP_LIB, `${n}.ts`)).href);
const C = { ...(await mod('program')), ...(await mod('ix')), ...(await mod('math')) };
const W3 = await import('@solana/web3.js');
const SPL = await import('@solana/spl-token');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL } = W3;

const URL = process.env.LPM_RPC || 'http://127.0.0.1:18899';
const PUBLIC_GENESIS = ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'];
const conn = new Connection(URL, 'confirmed');
const genesis = await conn.getGenesisHash();
if (PUBLIC_GENESIS.includes(genesis)) throw new Error(`REFUSING: ${URL} has a PUBLIC genesis ${genesis}`);

const CP = C.REGISTERED_PROGRAM_ID;
const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
/** The Squads MULTISIG account. It can never sign, so it must never be accepted as the editor. */
const MULTISIG = new PublicKey('EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK');
const AUTHORITY = C.deriveAuthority(CP);
const TIER_1 = C.publicTierConfig(CP);
/** The two pools that exist on mainnet. Their bytes are loaded into the validator at genesis. */
const REAL_POOLS = [
  { label: 'BAYLA/SOL (mainnet bytes)', pool: new PublicKey('ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4'), lpMint: new PublicKey('BQZth5DhHZT9H1AxZonoLAwGHknWo4LebQBxjKWtzY8e') },
  { label: 'BAYLA/USDC (mainnet bytes)', pool: new PublicKey('J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm'), lpMint: new PublicKey('3D3EKJxfePDQ1N8YtNwg8W6eSL4mjVpbYf57pnqgcAQx') },
];

// What the program must write. Typed out here, independently of the Rust source.
const WANT_NAME = 'Memetics Pool Share';
const WANT_SYMBOL = 'MEM-LP';
const wantUri = (lpMint) => `https://memetics.finance/mint/${lpMint.toBase58()}.json`;
/** Metaplex pads name, symbol and link to their maximum, so every record of this kind is this long. */
const RECORD_BYTES = 607;
/** What the Metaplex binary on mainnet charges to create a record (measured there by simulation). */
const METAPLEX_CREATE_FEE = 10_000_000n;

// Anchor's own error codes, and the one program error this instruction reuses.
const ERR = { ConstraintSeeds: 2006, ConstraintAddress: 2012, AccountDiscriminatorMismatch: 3002, AccountOwnedByWrongProgram: 3007, InvalidProgramId: 3008, IncorrectLpMint: 6004 };
/** Metaplex Token Metadata: "Metadata's key must match seed of ['metadata', program id, mint] provided". */
const MPL_INVALID_METADATA_KEY = 5;
/** Metaplex Token Metadata's answer to a create for a record that already exists (measured on this validator). */
const MPL_EXPECTED_UNINITIALIZED = 199;

let failed = 0;
let passed = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${what}`); if (ok) passed++; else failed++; return ok; };
const section = (t) => console.log(`\n== ${t}`);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ── the instruction, built by hand from the committed IDL's own order ────────
const IX_CREATE_LP_METADATA = crypto.createHash('sha256').update('global:create_lp_metadata').digest().subarray(0, 8);
const metadataPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX)[0];
function createLpMetadataIx({ payer, poolState, lpMint, metadata, authority = AUTHORITY, updateAuthority = VAULT, metadataProgram = METAPLEX, extra = [] }) {
  return new TransactionInstruction({
    programId: CP,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: poolState, isSigner: false, isWritable: false },
      { pubkey: lpMint, isSigner: false, isWritable: false },
      { pubkey: metadata ?? metadataPda(lpMint), isSigner: false, isWritable: true },
      { pubkey: updateAuthority, isSigner: false, isWritable: false },
      { pubkey: metadataProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ...extra,
    ],
    data: Buffer.from(IX_CREATE_LP_METADATA),
  });
}

function decodeMetadata(d) {
  let o = 1;
  const updateAuthority = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const mint = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const str = () => { const n = d.readUInt32LE(o); o += 4; const s = d.subarray(o, o + n).toString('utf8').replace(/\0+$/, ''); o += n; return s; };
  const name = str(), symbol = str(), uri = str();
  const sellerFeeBps = d.readUInt16LE(o); o += 2;
  const hasCreators = d[o] === 1;
  if (hasCreators) { const n = d.readUInt32LE(o + 1); o += 1 + 4 + n * 34; } else o += 1;
  const primarySaleHappened = d[o] === 1; o += 1;
  const isMutable = d[o] === 1; o += 1;
  return { key: d[0], updateAuthority, mint, name, symbol, uri, sellerFeeBps, hasCreators, primarySaleHappened, isMutable };
}

// ── sending, and reading back what happened ──────────────────────────────────
async function send(ixs, signers) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  // No preflight: a refusal must be the chain's own verdict on a landed transaction.
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  try {
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  } catch (e) {
    // web3.js sometimes REJECTS with the chain's error object for a transaction that landed and
    // failed (when its own status poll wins the race), and sometimes returns it. A refusal is
    // what half of this script is looking for, so only a real Error (expired, unreachable) stops
    // it here; the transaction read back below is the verdict either way.
    if (e instanceof Error) throw e;
  }
  let got = null;
  for (let i = 0; i < 40 && !got; i++) {
    got = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!got) await new Promise((r) => setTimeout(r, 250));
  }
  if (!got) throw new Error(`UNREAD: transaction ${sig} was confirmed but could not be read back`);
  const keys = got.transaction.message.accountKeys;
  return { sig, err: got.meta.err, logs: got.meta.logMessages ?? [], units: got.meta.computeUnitsConsumed, fee: got.meta.fee, inner: got.meta.innerInstructions ?? [], keys };
}
const mustLand = async (what, ixs, signers) => {
  const r = await send(ixs, signers);
  if (r.err) throw new Error(`setup failed (${what}): ${JSON.stringify(r.err)}\n${r.logs.join('\n')}`);
  return r;
};
/** The custom code of a failed instruction, or null when the failure is anything else. */
const customCode = (r) => {
  const e = r.err?.InstructionError;
  return Array.isArray(e) && e[1] && typeof e[1] === 'object' && 'Custom' in e[1] ? e[1].Custom : null;
};
/** Which program's invocation the failure came out of, read from the chain's own log. */
const failedIn = (r) => {
  const line = r.logs.find((l) => /^Program \S+ failed/.test(l));
  return line ? line.split(' ')[1] : null;
};
const refused = (r, code, what) => check(customCode(r) === code, `${what}: refused with ${code} (got ${JSON.stringify(r.err)})`);

async function snapshot(addresses) {
  const infos = await conn.getMultipleAccountsInfo(addresses, 'confirmed');
  return infos.map((a) => (a ? `${a.owner.toBase58()}|${a.lamports}|${a.executable}|${sha256(a.data)}|${a.data.length}` : 'absent'));
}
const tokenAmount = async (account) => {
  const a = await conn.getAccountInfo(account, 'confirmed');
  if (!a) throw new Error(`UNREAD: token account ${account.toBase58()} is absent`);
  return a.data.readBigUInt64LE(64);
};
const mintSupply = async (mint) => {
  const a = await conn.getAccountInfo(mint, 'confirmed');
  if (!a) throw new Error(`UNREAD: mint ${mint.toBase58()} is absent`);
  return a.data.readBigUInt64LE(36);
};
async function readPool(pool) {
  const a = await conn.getAccountInfo(pool, 'confirmed');
  if (!a) throw new Error(`UNREAD: pool ${pool.toBase58()} is absent on this validator. It must be loaded at genesis.`);
  if (!a.owner.equals(CP)) throw new Error(`pool ${pool.toBase58()} is owned by ${a.owner.toBase58()}`);
  const v = C.decodePoolState(pool.toBase58(), a.data);
  if (!v) throw new Error(`pool ${pool.toBase58()} does not decode`);
  return v;
}
const ata = (mint, owner, program) => SPL.getAssociatedTokenAddressSync(mint, owner, true, program);
const pk = (s) => new PublicKey(s);

// ── 0. what is running ───────────────────────────────────────────────────────
console.log(`local genesis ${genesis} · ${URL}`);
const programAccount = await conn.getAccountInfo(CP, 'confirmed');
if (!programAccount?.executable) throw new Error(`UNREAD: no pool program at ${CP.toBase58()}`);
const programData = PublicKey.findProgramAddressSync([CP.toBuffer()], LOADER)[0];
const pd = await conn.getAccountInfo(programData, 'confirmed');
if (!pd) throw new Error('UNREAD: the pool program has no ProgramData account');
const programBytes = pd.data.subarray(45);
console.log(`pool program under test: ${programBytes.length} bytes, sha256 ${sha256(programBytes)}`);
// The link's fixed part is one run of bytes in the binary. (The name and symbol are not: the
// compiler loads strings that short as numbers, so their absence would prove nothing.)
const LINK_PREFIX = 'https://memetics.finance/mint/';
console.log(`the binary ${programBytes.includes(Buffer.from(LINK_PREFIX)) ? 'contains' : 'DOES NOT contain'} the text "${LINK_PREFIX}"`);
if (!(await conn.getAccountInfo(METAPLEX, 'confirmed'))?.executable) throw new Error('UNREAD: Metaplex Token Metadata is not on this validator');
// BEFORE ANYTHING IS SENT: this must be the validator built for this proof, not some other local
// one that happens to answer on the port. Several validators run on this machine, and one stray
// run of this script opened a pool on another checkout's chain before this check existed.
for (const p of REAL_POOLS) await readPool(p.pool);
const rentRecord = BigInt(await conn.getMinimumBalanceForRentExemption(RECORD_BYTES));
console.log(`rent minimum for a ${RECORD_BYTES}-byte record on this validator: ${rentRecord} lamports`);

// The builder above against the committed IDL, position by position.
section('the instruction as the committed IDL describes it');
{
  const idls = loadVerifiedIdls();
  if (!idls) throw new Error('UNREAD: no pinned IDL found, so the account order cannot be checked');
  const ix = idls.cpIdl.instructions.find((i) => i.name === 'create_lp_metadata');
  check(!!ix, 'the committed pool IDL has create_lp_metadata');
  if (ix) {
    const built = createLpMetadataIx({ payer: Keypair.generate().publicKey, poolState: REAL_POOLS[0].pool, lpMint: REAL_POOLS[0].lpMint });
    check(Buffer.from(ix.discriminator).equals(Buffer.from(IX_CREATE_LP_METADATA)) && ix.args.length === 0, 'discriminator = sha256("global:create_lp_metadata")[0..8], and no arguments');
    check(ix.accounts.length === built.keys.length && ix.accounts.every((a, i) => !!a.signer === built.keys[i].isSigner && !!a.writable === built.keys[i].isWritable), `the ${built.keys.length} accounts this script sends carry the IDL's signer and writable flags, in its order`);
    const fixed = ix.accounts.map((a, i) => [a, built.keys[i]]).filter(([a]) => a.address);
    check(fixed.length === 4 && fixed.every(([a, k]) => a.address === k.pubkey.toBase58()), `the IDL's fixed addresses are the ones sent: ${fixed.map(([a]) => `${a.name}=${a.address}`).join(', ')}`);
  }
}

// ── 1. wallets, and a freshly opened pool ────────────────────────────────────
section('setup: wallets and a freshly opened pool');
const payer = Keypair.generate(); // opens the fresh pool and calls create_lp_metadata
const stranger = Keypair.generate(); // funds record addresses first; owns the decoy mint
const trader = Keypair.generate(); // deposits, swaps and withdraws on the real pools
for (const [k, sol] of [[payer, 50], [stranger, 5], [trader, 200]]) {
  await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL), 'confirmed');
}
const mintRent = await conn.getMinimumBalanceForRentExemption(SPL.MINT_SIZE);
async function newClassicMint(owner, authority) {
  const kp = Keypair.generate();
  await mustLand('create a mint', [
    SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: kp.publicKey, lamports: mintRent, space: SPL.MINT_SIZE, programId: SPL.TOKEN_PROGRAM_ID }),
    SPL.createInitializeMint2Instruction(kp.publicKey, 6, authority, null, SPL.TOKEN_PROGRAM_ID),
  ], [owner, kp]);
  return kp.publicKey;
}
const mintA = await newClassicMint(payer, payer.publicKey);
const mintB = await newClassicMint(payer, payer.publicKey);
const { token0: fresh0, token1: fresh1 } = C.sortMints(mintA, mintB);
for (const m of [fresh0, fresh1]) {
  await mustLand('fund the fresh pool creator', [
    SPL.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(m, payer.publicKey, SPL.TOKEN_PROGRAM_ID), payer.publicKey, m),
    SPL.createMintToInstruction(m, ata(m, payer.publicKey, SPL.TOKEN_PROGRAM_ID), payer.publicKey, 1_000_000_000_000n),
  ], [payer]);
}
const freshPool = C.derivePool(CP, TIER_1, fresh0, fresh1);
const freshLp = C.deriveLpMint(CP, freshPool);
await mustLand('open the fresh pool', [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
  C.initializeIx({
    programId: CP, creator: payer.publicKey, ammConfig: TIER_1, token0Mint: fresh0, token1Mint: fresh1,
    creatorToken0: ata(fresh0, payer.publicKey, SPL.TOKEN_PROGRAM_ID), creatorToken1: ata(fresh1, payer.publicKey, SPL.TOKEN_PROGRAM_ID),
    creatorLpToken: ata(freshLp, payer.publicKey, SPL.TOKEN_PROGRAM_ID),
    token0Program: SPL.TOKEN_PROGRAM_ID, token1Program: SPL.TOKEN_PROGRAM_ID, createPoolFee: FEE_ATA,
    initAmount0: 500_000_000_000n, initAmount1: 250_000_000_000n, openTime: 0n,
  }),
], [payer]);
const freshView = await readPool(freshPool);
check(freshView.lpMint === freshLp.toBase58(), `a pool was opened on fee tier 1 under the binary under test: ${freshPool.toBase58()}, lp mint ${freshLp.toBase58()}`);

// A mint a stranger made, naming our signing address as its mint authority. Metaplex alone
// would accept it (the authority matches and signs); only the pool binding keeps it out.
const decoyMint = await newClassicMint(stranger, AUTHORITY);

const targets = [
  { label: 'freshly opened pool', pool: freshPool, lpMint: freshLp, prefund: 0n, extra: false },
  // Funded by a stranger BELOW the rent minimum, and the caller appends both vaults and both token programs.
  { ...REAL_POOLS[0], prefund: 1_000_000n, extra: true },
  // Funded by a stranger ABOVE the rent minimum.
  { ...REAL_POOLS[1], prefund: rentRecord + 2_000_000n, extra: false },
];
for (const t of targets) {
  t.view = await readPool(t.pool);
  if (t.view.lpMint !== t.lpMint.toBase58()) throw new Error(`${t.label}: lp mint ${t.view.lpMint}`);
  t.record = metadataPda(t.lpMint);
  t.watch = [t.pool, t.lpMint, pk(t.view.token0Vault), pk(t.view.token1Vault), pk(t.view.observationKey), pk(t.view.ammConfig), AUTHORITY];
  const lpInfo = await conn.getAccountInfo(t.lpMint, 'confirmed');
  check(!!lpInfo && lpInfo.owner.equals(SPL.TOKEN_PROGRAM_ID) && new PublicKey(lpInfo.data.subarray(4, 36)).equals(AUTHORITY) && (await conn.getAccountInfo(t.record, 'confirmed')) === null,
    `${t.label}: its lp mint is a classic mint whose mint authority is ${AUTHORITY.toBase58()}, and it has no record yet`);
}

// ── 2. the refusals, on a pool whose record does not exist yet ───────────────
section('b. refusals (each on the fresh pool, before the call that then succeeds)');
const F = targets[0];
const S = targets[1];
const beforeRefusals = await snapshot([...F.watch, ...S.watch, F.record, S.record]);
const good = { payer: payer.publicKey, poolState: F.pool, lpMint: F.lpMint };
refused(await send([createLpMetadataIx({ ...good, lpMint: S.lpMint })], [payer]), ERR.IncorrectLpMint, 'this pool with ANOTHER pool\'s lp mint');
refused(await send([createLpMetadataIx({ ...good, poolState: S.pool })], [payer]), ERR.IncorrectLpMint, 'another pool with THIS pool\'s lp mint');
refused(await send([createLpMetadataIx({ ...good, lpMint: decoyMint })], [payer]), ERR.IncorrectLpMint, 'a stranger\'s mint that names our signing address as its mint authority');
refused(await send([createLpMetadataIx({ ...good, poolState: stranger.publicKey })], [payer]), ERR.AccountOwnedByWrongProgram, 'a pool account owned by the System program');
refused(await send([createLpMetadataIx({ ...good, poolState: pk(F.view.token0Vault) })], [payer]), ERR.AccountOwnedByWrongProgram, 'a pool account owned by the token program (a vault)');
refused(await send([createLpMetadataIx({ ...good, poolState: TIER_1 })], [payer]), ERR.AccountDiscriminatorMismatch, 'an account our program owns that is not a pool (the fee config)');
refused(await send([createLpMetadataIx({ ...good, updateAuthority: stranger.publicKey })], [payer]), ERR.ConstraintAddress, 'a stranger as the record\'s editor');
refused(await send([createLpMetadataIx({ ...good, updateAuthority: payer.publicKey })], [payer]), ERR.ConstraintAddress, 'the caller as the record\'s editor');
refused(await send([createLpMetadataIx({ ...good, updateAuthority: MULTISIG })], [payer]), ERR.ConstraintAddress, 'the Squads MULTISIG account as the record\'s editor');
refused(await send([createLpMetadataIx({ ...good, metadataProgram: SystemProgram.programId })], [payer]), ERR.InvalidProgramId, 'the System program in place of Metaplex');
refused(await send([createLpMetadataIx({ ...good, metadataProgram: SPL.TOKEN_PROGRAM_ID })], [payer]), ERR.InvalidProgramId, 'the token program in place of Metaplex');
refused(await send([createLpMetadataIx({ ...good, authority: stranger.publicKey })], [payer]), ERR.ConstraintSeeds, 'a stranger in place of the signing address');
{
  const r = await send([createLpMetadataIx({ ...good, metadata: S.record })], [payer]);
  check(customCode(r) === MPL_INVALID_METADATA_KEY && failedIn(r) === METAPLEX.toBase58(), `another mint's record address: refused by Metaplex with ${MPL_INVALID_METADATA_KEY} (got ${JSON.stringify(r.err)} from ${failedIn(r)})`);
  const r2 = await send([createLpMetadataIx({ ...good, metadata: Keypair.generate().publicKey })], [payer]);
  check(customCode(r2) === MPL_INVALID_METADATA_KEY && failedIn(r2) === METAPLEX.toBase58(), `a random record address: refused by Metaplex with ${MPL_INVALID_METADATA_KEY} (got ${JSON.stringify(r2.err)} from ${failedIn(r2)})`);
}
check(JSON.stringify(await snapshot([...F.watch, ...S.watch, F.record, S.record])) === JSON.stringify(beforeRefusals), 'after every refusal: both pools, their lp mints, vaults, observation accounts and fee config are byte-identical, and no record exists');

// ── 3. the call itself, three times ──────────────────────────────────────────
const results = [];
for (const t of targets) {
  section(`a/c/d. create_lp_metadata on the ${t.label}`);
  if (t.prefund > 0n) {
    await mustLand('a stranger funds the record address', [SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: t.record, lamports: t.prefund })], [stranger]);
    const funded = await conn.getAccountInfo(t.record, 'confirmed');
    check(!!funded && BigInt(funded.lamports) === t.prefund && funded.data.length === 0, `c. a stranger put ${t.prefund} lamports on the record address first (${t.prefund < rentRecord ? 'below' : 'above'} the rent minimum)`);
  }
  const extra = t.extra
    ? [t.view.token0Vault, t.view.token1Vault].map((v) => ({ pubkey: pk(v), isSigner: false, isWritable: true }))
      .concat([SPL.TOKEN_PROGRAM_ID, SPL.TOKEN_2022_PROGRAM_ID].map((p) => ({ pubkey: p, isSigner: false, isWritable: false })))
    : [];
  const before = await snapshot(t.watch);
  const payerBefore = BigInt(await conn.getBalance(payer.publicKey, 'confirmed'));
  const r = await send([createLpMetadataIx({ payer: payer.publicKey, poolState: t.pool, lpMint: t.lpMint, extra })], [payer]);
  if (!check(r.err === null, `a. the call landed${t.extra ? ' (with both vaults and both token programs appended by the caller)' : ''}: ${r.err === null ? r.sig : JSON.stringify(r.err)}`)) {
    console.log(r.logs.map((l) => `      ${l}`).join('\n'));
    continue;
  }
  const rec = await conn.getAccountInfo(t.record, 'confirmed');
  if (!check(!!rec && rec.owner.equals(METAPLEX), 'a. the record exists and Metaplex owns it')) continue;
  const m = decodeMetadata(rec.data);
  check(m.key === 4 && m.mint.equals(t.lpMint), 'a. it is a Metaplex metadata record for this lp mint');
  check(m.name === WANT_NAME && m.symbol === WANT_SYMBOL, `a. name "${m.name}", symbol "${m.symbol}"`);
  check(m.uri === wantUri(t.lpMint), `a. link ${m.uri}`);
  check(m.updateAuthority.equals(VAULT), `a. editor (update authority) = ${m.updateAuthority.toBase58()}, the admin vault`);
  check(m.isMutable && !m.primarySaleHappened && m.sellerFeeBps === 0 && !m.hasCreators, 'a. mutable, seller fee 0, no creators');
  // Metaplex moves the full rent and its fee from the payer whatever the address already holds
  // (measured here: a stranger's lamports neither block the call nor make it cheaper; they stay).
  const wantLamports = t.prefund + rentRecord + METAPLEX_CREATE_FEE;
  check(rec.data.length === RECORD_BYTES && BigInt(rec.lamports) === wantLamports, `a. ${rec.data.length} bytes holding ${rec.lamports} lamports (want ${RECORD_BYTES} and ${wantLamports} = rent ${rentRecord} + Metaplex's ${METAPLEX_CREATE_FEE} + the ${t.prefund} already there)`);
  const paid = payerBefore - BigInt(await conn.getBalance(payer.publicKey, 'confirmed'));
  const wantPaid = rentRecord + METAPLEX_CREATE_FEE + BigInt(r.fee);
  check(paid === wantPaid, `a. the caller paid ${paid} lamports (want ${wantPaid}: rent, Metaplex's fee and the ${r.fee} network fee, the same whether or not the address was funded first)`);

  // d. what Metaplex was handed. Our instruction is the only top-level one, so every inner
  // instruction belongs to it: exactly one call into Metaplex, then only System program calls.
  const inner = r.inner.flatMap((g) => g.instructions).map((i) => ({ program: r.keys[i.programIdIndex].toBase58(), accounts: i.accounts.map((a) => r.keys[a].toBase58()) }));
  const toMetaplex = inner.filter((i) => i.program === METAPLEX.toBase58());
  const wantAccounts = [t.record, t.lpMint, AUTHORITY, payer.publicKey, VAULT, SystemProgram.programId].map((k) => k.toBase58());
  check(toMetaplex.length === 1 && JSON.stringify(toMetaplex[0].accounts) === JSON.stringify(wantAccounts), `d. one call into Metaplex, handed exactly its six accounts: record, lp mint, signing address, payer, editor, System program (got ${toMetaplex.map((i) => i.accounts.length).join(',')} accounts)`);
  const others = [...new Set(inner.filter((i) => i.program !== METAPLEX.toBase58()).map((i) => i.program))];
  check(others.every((p) => p === SystemProgram.programId.toBase58()), `d. every other inner call is to the System program; none reaches a token program (${inner.length} inner calls: ${[...new Set(inner.map((i) => i.program))].join(', ')})`);
  check(inner.every((i) => !i.accounts.includes(t.view.token0Vault) && !i.accounts.includes(t.view.token1Vault)), 'd. no inner call names either vault');
  check(JSON.stringify(await snapshot(t.watch)) === JSON.stringify(before), 'd. the pool, its lp mint, both vaults, its observation account, its fee config and the signing address are byte-identical after (owner, lamports, data)');
  console.log(`  compute units used: ${r.units}`);
  results.push({ pool: t.label, lpMint: t.lpMint.toBase58(), record: t.record.toBase58(), signature: r.sig, computeUnits: r.units, bytes: rec.data.length, lamports: rec.lamports, callerPaid: paid.toString(), prefunded: t.prefund.toString() });

  const again = await send([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), createLpMetadataIx({ payer: payer.publicKey, poolState: t.pool, lpMint: t.lpMint })], [payer]);
  check(customCode(again) === MPL_EXPECTED_UNINITIALIZED && failedIn(again) === METAPLEX.toBase58(), `b. a second call for the same mint is refused by Metaplex with ${MPL_EXPECTED_UNINITIALIZED} (got ${JSON.stringify(again.err)} from ${failedIn(again)}: ${again.logs.find((l) => /Program log: .*rror/.test(l)) ?? 'no error line in the log'})`);
  const recAfter = await conn.getAccountInfo(t.record, 'confirmed');
  check(!!recAfter && recAfter.data.equals(rec.data) && recAfter.lamports === rec.lamports, 'b. the record is unchanged by the refused second call');
}

// ── 4. deposit, swap, withdraw on the real pools ─────────────────────────────
const amounts = [];
for (const t of REAL_POOLS) {
  section(`e. deposit, swap and withdraw on ${t.label}`);
  const view = await readPool(t.pool);
  const cfgInfo = await conn.getAccountInfo(pk(view.ammConfig), 'confirmed');
  const cfg = cfgInfo ? C.decodeAmmConfig(view.ammConfig, cfgInfo.data) : null;
  if (!cfg) throw new Error(`UNREAD: fee config ${view.ammConfig}`);
  const side = [0, 1].map((i) => ({
    mint: pk(i ? view.token1Mint : view.token0Mint), program: pk(i ? view.token1Program : view.token0Program), vault: pk(i ? view.token1Vault : view.token0Vault),
    fees: i ? view.protocolFeesToken1 + view.fundFeesToken1 + view.creatorFeesToken1 : view.protocolFeesToken0 + view.fundFeesToken0 + view.creatorFeesToken0,
  }));
  for (const s of side) s.account = ata(s.mint, trader.publicKey, s.program);
  const lpAccount = ata(t.lpMint, trader.publicKey, SPL.TOKEN_PROGRAM_ID);
  const vaults = async () => Promise.all(side.map((s) => tokenAmount(s.vault)));
  const wallet = async () => Promise.all(side.map((s) => tokenAmount(s.account)));

  // Give the trader both coins: 5% of each vault. SOL is wrapped; BAYLA and USDC are minted by
  // the local stand-in mints' test authorities, which exist only on a local validator.
  const v0 = await vaults();
  const fund = [];
  const signers = [trader];
  for (const [i, s] of side.entries()) {
    const want = v0[i] / 20n + 1_000_000n;
    fund.push(SPL.createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, s.account, trader.publicKey, s.mint, s.program));
    if (s.mint.equals(WSOL_MINT)) {
      fund.push(SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: s.account, lamports: want }), SPL.createSyncNativeInstruction(s.account));
    } else {
      const auth = s.mint.equals(BAYLA_MINT) ? baylaMintAuthority() : s.mint.equals(USDC_MINT) ? usdcMintAuthority() : null;
      if (!auth) throw new Error(`no local mint authority for ${s.mint.toBase58()}`);
      fund.push(SPL.createMintToInstruction(s.mint, s.account, auth.publicKey, want, [], s.program));
      signers.push(auth);
    }
  }
  fund.push(SPL.createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, lpAccount, trader.publicKey, t.lpMint, SPL.TOKEN_PROGRAM_ID));
  await mustLand('fund the trader', fund, signers);
  const common = { programId: CP, owner: trader.publicKey, poolState: t.pool, ownerLpToken: lpAccount, token0Account: side[0].account, token1Account: side[1].account, token0Vault: side[0].vault, token1Vault: side[1].vault, vault0Mint: side[0].mint, vault1Mint: side[1].mint, lpMint: t.lpMint };
  const withoutFees = (v) => v.map((x, i) => C.vaultAmountWithoutFee(x, i ? view.protocolFeesToken1 : view.protocolFeesToken0, i ? view.fundFeesToken1 : view.fundFeesToken0, i ? view.creatorFeesToken1 : view.creatorFeesToken0));

  // deposit: 1% of the pool's shares
  const lpAmount = view.lpSupply / 100n;
  const wf0 = withoutFees(v0);
  const cost = C.lpTokensToTradingTokens(lpAmount, view.lpSupply, wf0[0], wf0[1], 'ceiling');
  const w0 = await wallet();
  const dep = await send([C.depositIx({ ...common, lpTokenAmount: lpAmount, maximumToken0Amount: cost.token0Amount, maximumToken1Amount: cost.token1Amount })], [trader]);
  const v1 = await vaults();
  const w1 = await wallet();
  check(dep.err === null, `deposit landed: ${dep.err === null ? dep.sig : JSON.stringify(dep.err)}`);
  check(v1[0] - v0[0] === cost.token0Amount && v1[1] - v0[1] === cost.token1Amount && w0[0] - w1[0] === cost.token0Amount && w0[1] - w1[1] === cost.token1Amount,
    `deposit moved exactly the site's numbers, with the ceilings set to them: ${cost.token0Amount} and ${cost.token1Amount} (vaults +${v1[0] - v0[0]} / +${v1[1] - v0[1]})`);
  const afterDeposit = await readPool(t.pool);
  check((await tokenAmount(lpAccount)) === lpAmount && afterDeposit.lpSupply === view.lpSupply + lpAmount, `deposit minted exactly ${lpAmount} pool shares and the pool counts them`);

  // swap: token 0 in, 0.1% of its vault
  const amountIn = v1[0] / 1000n;
  const wf1 = withoutFees(v1);
  const quote = C.swapBaseInput({
    inputAmount: amountIn, inputVaultAmount: wf1[0], outputVaultAmount: wf1[1],
    tradeFeeRate: cfg.tradeFeeRate, creatorFeeRate: view.enableCreatorFee ? cfg.creatorFeeRate : 0n, protocolFeeRate: cfg.protocolFeeRate, fundFeeRate: cfg.fundFeeRate,
    isCreatorFeeOnInput: C.isCreatorFeeOnInput(view.creatorFeeOn, true) ?? true,
  });
  if (!quote) throw new Error('the site\'s maths gave no quote');
  const swap = await send([C.swapBaseInputIx({
    programId: CP, payer: trader.publicKey, ammConfig: pk(view.ammConfig), poolState: t.pool, inputTokenAccount: side[0].account, outputTokenAccount: side[1].account,
    inputVault: side[0].vault, outputVault: side[1].vault, inputTokenProgram: side[0].program, outputTokenProgram: side[1].program, inputTokenMint: side[0].mint, outputTokenMint: side[1].mint,
    observationState: pk(view.observationKey), amountIn, minimumAmountOut: quote.outputAmount,
  })], [trader]);
  const v2 = await vaults();
  const w2 = await wallet();
  check(swap.err === null, `swap landed: ${swap.err === null ? swap.sig : JSON.stringify(swap.err)}`);
  check(v2[0] - v1[0] === amountIn && v1[1] - v2[1] === quote.outputAmount && w2[1] - w1[1] === quote.outputAmount && w1[0] - w2[0] === amountIn,
    `swap of ${amountIn} paid out exactly the site's quote, with the floor set to it: ${quote.outputAmount} (vault -${v1[1] - v2[1]}, wallet +${w2[1] - w1[1]})`);

  // withdraw: every share just minted
  const afterSwap = await readPool(t.pool);
  const wf2 = [0, 1].map((i) => C.vaultAmountWithoutFee(v2[i], i ? afterSwap.protocolFeesToken1 : afterSwap.protocolFeesToken0, i ? afterSwap.fundFeesToken1 : afterSwap.fundFeesToken0, i ? afterSwap.creatorFeesToken1 : afterSwap.creatorFeesToken0));
  const back = C.lpTokensToTradingTokens(lpAmount, afterSwap.lpSupply, wf2[0], wf2[1], 'floor');
  const wd = await send([C.withdrawIx({ ...common, lpTokenAmount: lpAmount, minimumToken0Amount: back.token0Amount, minimumToken1Amount: back.token1Amount })], [trader]);
  const v3 = await vaults();
  const w3 = await wallet();
  check(wd.err === null, `withdraw landed: ${wd.err === null ? wd.sig : JSON.stringify(wd.err)}`);
  check(v2[0] - v3[0] === back.token0Amount && v2[1] - v3[1] === back.token1Amount && w3[0] - w2[0] === back.token0Amount && w3[1] - w2[1] === back.token1Amount,
    `withdraw returned exactly the site's numbers, with the floors set to them: ${back.token0Amount} and ${back.token1Amount}`);
  const end = await readPool(t.pool);
  check((await tokenAmount(lpAccount)) === 0n && end.lpSupply === view.lpSupply && (await mintSupply(t.lpMint)) === view.lpSupply - 100n, 'withdraw burned every share: the pool\'s count is back where it started, and the mint\'s supply is that less the 100 locked at opening');
  amounts.push({ pool: t.label, lpAmount: lpAmount.toString(), depositCost: [cost.token0Amount.toString(), cost.token1Amount.toString()], swapIn: amountIn.toString(), swapOut: quote.outputAmount.toString(), withdrawBack: [back.token0Amount.toString(), back.token1Amount.toString()], units: { deposit: dep.units, swap: swap.units, withdraw: wd.units } });
  // The record written above (if it was) is untouched by all of it.
  const rec = await conn.getAccountInfo(metadataPda(t.lpMint), 'confirmed');
  if (rec?.owner.equals(METAPLEX)) check(decodeMetadata(rec.data).name === WANT_NAME && rec.data.length === RECORD_BYTES, 'the lp mint\'s record is still there, unchanged in name and size, after deposit, swap and withdraw');
}

console.log(`\nRESULTS ${JSON.stringify({ rpc: URL, genesis, programSha256: sha256(programBytes), programBytes: programBytes.length, rentRecord: rentRecord.toString(), records: results, amounts }, null, 2)}`);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
