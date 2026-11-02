// Step 3: every instruction a visitor or the venue uses, on the local chain, with a check after
// each. Writes results-<run>.json into CLMM_WORK. CLMM_MUTANT=<id> feeds one broken input
// (mutants.mjs) and stops after its target check. CLMM_STOP=<phase> stops after that phase.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PublicKey, SystemProgram, Keypair, spl, LAMPORTS_PER_SOL } from './lib/deps.mjs';
import { ADDR, WORK, LOCAL_TIME_LOCK, MAINNET_TIME_LOCK, registry } from './lib/config.mjs';
import { conn, send, airdrop, kp, ledger } from './lib/chain.mjs';
import { asVault, readMultisig, approveIx, squadsPdas, checkIdl, vaultPda } from './lib/squads.mjs';
import { ix, PDA, account, sqrtPriceX64, tickAt, alignDown, arrayStart, order, ataOf } from './lib/clmm.mjs';
import { MUTANTS } from './mutants.mjs';

const MUT = process.env.CLMM_MUTANT || '';
if (MUT && !MUTANTS[MUT]) throw new Error('no mutant ' + MUT);
const mut = (id) => MUT === id;
const STOP = process.env.CLMM_STOP || '';
const RUN = MUT ? `mutant-${MUT}` : 'clean';
const started = new Date().toISOString();

// ---- record keeping ------------------------------------------------------------------------
const checks = [];
const sizes = [];
const known = new Map();
const reg = (k, label) => { const p = new PublicKey(k); if (!known.has(p.toBase58())) known.set(p.toBase58(), label); return p; };

function finish(reason) {
  const out = {
    run: RUN, mutant: MUT || null, mutantWhat: MUT ? MUTANTS[MUT].what : null, started, finished: new Date().toISOString(), reason,
    localTimeLock: LOCAL_TIME_LOCK, checks, sizes,
    txs: ledger.map((r) => ({ label: r.label, sig: r.sig, ok: r.ok, expectFail: r.expectFail, error: r.error?.name ?? r.error?.raw ?? null, cu: r.cu, bytes: r.bytes })),
  };
  writeFileSync(join(WORK, `results-${RUN}.json`), JSON.stringify(out, null, 1));
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${RUN}: ${checks.length} checks, ${failed.length} failed, ${ledger.length} transactions (${reason})`);
  process.exit(0);
}

function check(id, instruction, what, pass, counts = '') {
  if (checks.some((c) => c.id === id)) throw new Error('check id used twice: ' + id);
  checks.push({ id, instruction, what, pass: !!pass, counts: String(counts) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} [${instruction}] ${what}${counts ? ` (${counts})` : ''}`);
  if (MUT && MUTANTS[MUT].target === id) finish('mutant target judged');
}

function phaseDone(name) { console.log(`---- ${name} done`); if (STOP === name) finish('stopped after ' + name); }

/** A step the run depends on: it must succeed or the run stops, with its logs. */
async function must(label, ixs, signers, opts) {
  const r = await send(label, ixs, signers, opts);
  if (!r.ok) { console.log(r.logs.join('\n')); throw new Error(`${label} failed: ${r.error?.name ?? r.error?.raw}`); }
  return r;
}
async function mustVault(label, ixs, opts) {
  const r = await asVault(label, ixs, members, { ...opts, onIndex: (i) => squadsPdas(i).forEach((p, j) => reg(p, `squads ${j ? 'proposal' : 'transaction'} ${i}`)) });
  if (!r.executed) { console.log((r.execute?.logs || r.create.logs).join('\n')); throw new Error(`${label}: vault execute failed: ${r.execute?.error?.name ?? r.create.error?.name}`); }
  return r;
}
const vaultRun = (label, ixs, opts = {}) => asVault(label, ixs, members, { ...opts, onIndex: (i) => squadsPdas(i).forEach((p, j) => reg(p, `squads ${j ? 'proposal' : 'transaction'} ${i}`)) });

async function measure(what, address, paidBy) {
  const a = await conn.getAccountInfo(address, 'confirmed');
  sizes.push({ what, address: address.toBase58(), bytes: a.data.length, lamportsLocal: a.lamports, owner: a.owner.toBase58(), paidBy });
  return a;
}

const tok = async (a) => { try { return BigInt((await conn.getTokenAccountBalance(a, 'confirmed')).value.amount); } catch { return 0n; } };
const sol = async (k) => BigInt(await conn.getBalance(k, 'confirmed'));
const errName = (r) => r.error?.name ?? r.error?.raw ?? 'none';
const failedWith = (r, name) => !r.ok && errName(r) === name;
const fmt = (n, d) => (Number(n) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: d });

// ---- actors and addresses -------------------------------------------------------------------
const man = JSON.parse(readFileSync(join(WORK, 'manifest.json'), 'utf-8'));
const K = Object.fromEntries(Object.keys(man.localKeys).map((n) => [n, kp(JSON.parse(readFileSync(join(WORK, 'keys', `${n}.json`), 'utf-8')))]));
const { memberA, memberB, outsider, alice, bob, carol, dave, erin, mallory } = K;
const members = [memberA, memberB];
for (const [n, k] of Object.entries(K)) reg(k.publicKey, n);
const VAULT = reg(ADDR.vault, 'vault');
reg(ADDR.multisig, 'multisig');
const BAYLA = reg(ADDR.bayla, 'BAYLA mint');
const WSOL = reg(ADDR.wsol, 'WSOL mint');
ADDR.memo = new PublicKey(man.addresses.memo);
for (const k of ['program', 'squads', 'token', 'token2022', 'ata', 'memo', 'metaplex']) reg(ADDR[k], k + ' program');
reg(SystemProgram.programId, 'system program');
reg('ComputeBudget111111111111111111111111111111', 'compute budget program');
reg('SysvarRent111111111111111111111111111111111', 'rent sysvar');
const names = new Map(Object.entries(K).map(([n, k]) => [k.publicKey.toBase58(), n]));
names.set(VAULT.toBase58(), 'vault');

const progOf = new Map([[BAYLA.toBase58(), ADDR.token2022]]);
const prog = (mint) => progOf.get(mint.toBase58()) ?? ADDR.token;
const setProg = (mint, p) => progOf.set(mint.toBase58(), p);
function ata(owner, mint) {
  const a = ataOf(owner, mint, prog(mint));
  return reg(a, `ata ${names.get(owner.toBase58()) ?? owner.toBase58().slice(0, 6)} ${known.get(mint.toBase58()) ?? 'mint'}`);
}
const ataIx = (payer, owner, mint) => spl.createAssociatedTokenAccountIdempotentInstruction(payer, ata(owner, mint), owner, mint, prog(mint), ADDR.ata);

async function newMint(label, authority, decimals) {
  const m = Keypair.generate();
  reg(m.publicKey, label);
  const lamports = await conn.getMinimumBalanceForRentExemption(spl.MINT_SIZE);
  await must(`${label}: create mint`, [
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: m.publicKey, lamports, space: spl.MINT_SIZE, programId: ADDR.token }),
    spl.createInitializeMint2Instruction(m.publicKey, decimals, authority.publicKey, null, ADDR.token),
  ], [authority, m]);
  return m.publicKey;
}

// =============================================================================================
// Phase 0: the local chain is what setup said, and the test wallets are funded.
// =============================================================================================
checkIdl();
check('S0', 'setup', 'vault 0 of the multisig (registry row squads-multisig) is the registry vault', vaultPda(ADDR.multisig, mut('S0') ? 1 : 0).equals(VAULT), VAULT.toBase58());
const ms0 = await readMultisig(ADDR.multisig);
const localMembers = members.map((m) => m.publicKey.toBase58()).sort().join(',');
check('S1', 'setup', `local multisig: ${ms0.threshold} of ${ms0.members.length}, members are the two local keys, lock ${ms0.timeLock} s (mainnet ${MAINNET_TIME_LOCK} s, threshold 2)`,
  ms0.threshold === 2 && ms0.members.map((m) => m.key.toBase58()).sort().join(',') === localMembers && ms0.timeLock === LOCAL_TIME_LOCK && ms0.transactionIndex === man.multisigOnMainnet.transactionIndex,
  `next proposal ${ms0.transactionIndex + 1}, as on mainnet`);

for (const k of [memberA, memberB, outsider, alice, bob, carol, erin, mallory, K.baylaMintAuthority, K.rewardMintAuthority, K.usdMintAuthority, K.workshopStandIn]) await airdrop(k.publicKey, 100 * LAMPORTS_PER_SOL);
await airdrop(dave.publicKey, 400 * LAMPORTS_PER_SOL);
// The vault holds 0.0152 SOL on mainnet; here it gets 3 SOL, and what it spends is measured below.
const vaultStartLamports = BigInt(man.accounts.vault.lamports);
await airdrop(VAULT, 3 * LAMPORTS_PER_SOL);

// BAYLA: fund the wallets while the local mint authority exists, then remove it as on mainnet.
const BAYLA_UNIT = 1_000_000n;
const baylaFor = { alice: 50_000_000n, bob: 50_000_000n, carol: 50_000_000n, dave: 300_000_000n, erin: 20_000_000n, mallory: 1_000_000n, vault: 1_000_000n };
let minted = 0n;
for (const [n, amt] of Object.entries(baylaFor)) {
  const owner = n === 'vault' ? VAULT : K[n].publicKey;
  await must(`fund ${n} with BAYLA`, [ataIx(K.baylaMintAuthority.publicKey, owner, BAYLA), spl.createMintToInstruction(BAYLA, ata(owner, BAYLA), K.baylaMintAuthority.publicKey, amt * BAYLA_UNIT, [], ADDR.token2022)], [K.baylaMintAuthority]);
  minted += amt * BAYLA_UNIT;
}
if (!mut('S2')) await must('BAYLA: remove the local mint authority', [spl.createSetAuthorityInstruction(BAYLA, K.baylaMintAuthority.publicKey, spl.AuthorityType.MintTokens, null, [], ADDR.token2022)], [K.baylaMintAuthority]);
{
  const local = (await conn.getAccountInfo(BAYLA)).data;
  const mainnet = Buffer.from(JSON.parse(readFileSync(join(WORK, 'mainnet', 'bayla.json'), 'utf-8')).account.data[0], 'base64');
  const supplyOk = local.readBigUInt64LE(36) === mainnet.readBigUInt64LE(36) + minted;
  const same = local.subarray(0, 36).equals(mainnet.subarray(0, 36)) && local.subarray(44).equals(mainnet.subarray(44)) && local.length === mainnet.length;
  check('S2', 'setup', "BAYLA's mint is mainnet's byte for byte, except its supply (the test wallets' coins)", same && supplyOk, `${local.length} bytes, ${fmt(minted, 6)} BAYLA minted locally`);
}

// Wrapped SOL for each wallet; the vault's account must be the one the registry names.
const wrap = (owner, signer, lamports) => [ataIx(signer.publicKey, owner, WSOL), SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: ata(owner, WSOL), lamports }), spl.createSyncNativeInstruction(ata(owner, WSOL), ADDR.token)];
for (const [k, s] of [[alice, 60], [bob, 60], [carol, 60], [dave, 350], [erin, 20], [mallory, 5]]) await must(`wrap ${s} SOL for ${names.get(k.publicKey.toBase58())}`, wrap(k.publicKey, k, BigInt(s) * BigInt(LAMPORTS_PER_SOL)), [k]);
await must('vault: wrapped-SOL account', [ataIx(memberA.publicKey, VAULT, WSOL)], [memberA]);
await must('vault: BAYLA account', [ataIx(memberA.publicKey, VAULT, BAYLA)], [memberA]);
{
  const registryWsol = registry('cpswap-fee-receiver-wsol-ata');
  const derived = mut('S3') ? ataOf(ADDR.multisig, WSOL, ADDR.token) : ata(VAULT, WSOL);
  check('S3', 'setup', "the vault's wrapped-SOL account here is the one the registry names (cpswap-fee-receiver-wsol-ata)", derived.equals(registryWsol), registryWsol.toBase58());
}

// Two local coins: a reward coin and a dollar coin for the 0.25% tier's pool.
const REWARD = await newMint('REWARD mint (local)', K.rewardMintAuthority, 6);
const USD = await newMint('USD mint (local)', K.usdMintAuthority, 6);
for (const [owner, amt] of [[alice.publicKey, 10_000_000n], [mallory.publicKey, 0n]]) {
  await must('fund REWARD', [ataIx(K.rewardMintAuthority.publicKey, owner, REWARD), ...(amt ? [spl.createMintToInstruction(REWARD, ata(owner, REWARD), K.rewardMintAuthority.publicKey, amt * 1_000_000n, [], ADDR.token)] : [])], [K.rewardMintAuthority]);
}
for (const owner of [alice.publicKey, dave.publicKey]) await must('fund USD', [ataIx(K.usdMintAuthority.publicKey, owner, USD), spl.createMintToInstruction(USD, ata(owner, USD), K.usdMintAuthority.publicKey, 10_000_000n * 1_000_000n, [], ADDR.token)], [K.usdMintAuthority]);
phaseDone('phase0');
// A G mutant needs only a run's transactions, not all of them: judge it here, after setup.
if (['G1', 'G2', 'G3', 'G4', 'G5'].includes(MUT)) {
  const { ledgerChecks } = await import('./suite-phases.mjs');
  await ledgerChecks({ K, VAULT, BAYLA, poolA: PublicKey.default, poolB: PublicKey.default, known }, { check, phaseDone, measure, mut });
}

// =============================================================================================
// Phase 1: fee tiers, made by the vault through Squads, and refused to anyone else.
// =============================================================================================
// The owner's tiers (2026-10-20), born with the island split like cp-swap's: of each fee the LPs
// keep 84%, 10.4% is the venue's (protocol, vault) and 5.6% the island's (fund, its Workshop).
const WORKSHOP = reg(registry('island-workshop-wallet'), 'island Workshop (fund owner)');
const split = mut('W3') || mut('W5') || mut('F5') ? { protocol_fee_rate: 160_000, fund_fee_rate: 0 } : { protocol_fee_rate: 104_000, fund_fee_rate: 56_000 };
const TIER0 = { index: 0, tick_spacing: 120, trade_fee_rate: 10_000, ...split };
const TIER1 = { index: 1, tick_spacing: 60, trade_fee_rate: 2_500, protocol_fee_rate: 104_000, fund_fee_rate: 56_000 };
const cfg0 = reg(PDA.ammConfig(0), 'fee tier 0');
const cfg1 = reg(PDA.ammConfig(1), 'fee tier 1');
const tierIx = (t, owner = VAULT) => ix('create_amm_config', { owner, amm_config: PDA.ammConfig(t.index) }, t);
const fundOwnerIx = (cfg, to) => ix('update_amm_config', { owner: VAULT, amm_config: cfg }, { param: 4, value: 0 }, [{ pubkey: to, isWritable: false }]);
/** One vault proposal per tier: create it, then point its fund share at the Workshop. */
const tierProposal = (t) => [tierIx(t), ...((mut('T6') && t.index === 0) || (mut('T7') && t.index === 1) ? [] : [fundOwnerIx(PDA.ammConfig(t.index), WORKSHOP)])];
const splitOk = (c, spacing, trade) => c && c.tick_spacing === spacing && c.trade_fee_rate === trade && c.protocol_fee_rate === 104_000 && c.fund_fee_rate === 56_000 && c.owner.equals(VAULT) && c.fund_owner.equals(WORKSHOP);

{
  const r = mut('T1') ? (await vaultRun('T1 mutant: tier 0 by the vault', [tierIx(TIER0)])).execute : await send('stranger creates fee tier 0', [tierIx(TIER0, mallory.publicKey)], [mallory], { expectFail: true });
  check('T1', 'create_amm_config', 'a stranger cannot make a fee tier', failedWith(r, 'NotApproved') && !(await conn.getAccountInfo(cfg0)), `refused: ${errName(r)}`);
}
let pendingIndex;
{
  const r = await vaultRun('tier 0 with one approval', [tierIx(TIER0)], { approvals: 1, stopIfPending: true });
  pendingIndex = r.index;
  check('T2', 'Squads: vault_transaction_execute', 'one approval of two cannot execute a vault action', !r.executed && !(await conn.getAccountInfo(cfg0)), `proposal ${r.index}: ${r.proposal?.status}, execute ${errName(r.execute)}`);
}
{
  const who = mut('T3') ? memberB : outsider;
  const r = await send('a non-member approves', [approveIx(pendingIndex, who)], [who], { expectFail: true });
  check('T3', 'Squads: proposal_approve', 'someone outside the multisig cannot approve', failedWith(r, 'NotAMember'), `refused: ${errName(r)}`);
}
{
  const r = await vaultRun('fee tier 0 (1%, spacing 120) and its fund owner', tierProposal(TIER0), { earlyAttempt: true, ...(mut('T5') ? { approvals: 1 } : {}) });
  check('T4', 'Squads: vault_transaction_execute', `an execute sent before the ${LOCAL_TIME_LOCK} s lock runs out is refused, and the proposal stays approved`,
    r.early && !r.early.ok && errName(r.early) === 'TimeLockNotReleased' && r.afterEarly?.status === 'Approved', `refused: ${errName(r.early)}`);
  const waited = r.executedAt - r.approvedAt;
  check('T5', 'create_amm_config', 'the vault makes fee tier 0 through Squads, executed only after the lock', r.executed && waited >= LOCAL_TIME_LOCK, `proposal ${r.index}, executed ${waited} s after the second approval`);
  const c = await account('AmmConfig', cfg0);
  check('T6', 'create_amm_config + update_amm_config', "one proposal makes tier 0 (1%, spacing 120) with the split: 104,000 per million of each fee to the venue (owner: the vault), 56,000 to the island (fund owner: its Workshop)",
    splitOk(c, 120, 10_000), c ? `protocol ${c.protocol_fee_rate}, fund ${c.fund_fee_rate} per million; fund owner ${c.fund_owner.toBase58()}` : 'missing');
  await measure('fee tier (AmmConfig)', cfg0, 'vault');
}
{
  const r = await mustVault('fee tier 1 (0.25%, spacing 60) and its fund owner', tierProposal(TIER1));
  const c = await account('AmmConfig', cfg1);
  check('T7', 'create_amm_config + update_amm_config', 'one proposal makes tier 1 (0.25%, spacing 60) with the same split and the same two owners', splitOk(c, 60, 2_500), `proposal ${r.index}`);
}
{
  const upd = (owner, value) => ix('update_amm_config', { owner, amm_config: cfg1 }, { param: 1, value });
  const r = mut('T8') ? (await vaultRun('T8 mutant: update by the vault', [upd(VAULT, 100_000)])).execute : await send('stranger changes tier 1', [upd(mallory.publicKey, 100_000)], [mallory], { expectFail: true });
  check('T8', 'update_amm_config', 'a stranger cannot change a fee tier', failedWith(r, 'NotApproved') && (await account('AmmConfig', cfg1)).protocol_fee_rate === 104_000, `refused: ${errName(r)}`);
  await mustVault("tier 1: venue's part 104,000 -> 100,000", [upd(VAULT, 100_000)]);
  const mid = (await account('AmmConfig', cfg1)).protocol_fee_rate;
  if (!mut('T9')) await mustVault("tier 1: venue's part back to 104,000", [upd(VAULT, 104_000)]);
  const end = (await account('AmmConfig', cfg1)).protocol_fee_rate;
  check('T9', 'update_amm_config', 'the vault changes a tier and changes it back', mid === 100_000 && end === 104_000, `${mid} then ${end} per million`);
}
// The ceilings (the owner's ruling, 2026-10-20): at most 4% of a swap, and at most 16% of each fee
// to the venue and the island together, when a tier is made and when it is changed. Tier 9 sits
// exactly at both; the pool on it (phase 11) shows a dynamic fee held to the same 4%.
const cfg9 = reg(PDA.ammConfig(9), 'fee tier 9 (at the ceilings)');
const TIER9 = { index: 9, tick_spacing: 10, trade_fee_rate: 40_000, protocol_fee_rate: 104_000, fund_fee_rate: 56_000 };
const refusedAsOver = (r) => !r.executed && failedWith(r.execute, 'RequireGteViolated');
{
  const r = await vaultRun('the vault tries a tier above 4%', [tierIx({ ...TIER9, trade_fee_rate: mut('K1') ? 40_000 : 40_001 })]);
  check('K1', 'create_amm_config', 'the vault cannot make a tier that charges more than 4% of a swap', refusedAsOver(r) && !(await conn.getAccountInfo(cfg9)), r.executed ? 'made' : `refused: ${errName(r.execute)}`);
}
{
  const r = await vaultRun('the vault tries a tier above 16% for the venue and the island', [tierIx({ ...TIER9, protocol_fee_rate: mut('K2') ? 104_000 : 104_001 })]);
  check('K2', 'create_amm_config', 'the vault cannot make a tier that gives the venue and the island together more than 16% of each fee', refusedAsOver(r) && !(await conn.getAccountInfo(cfg9)),
    r.executed ? 'made' : `refused: ${errName(r.execute)}`);
}
if (!(await conn.getAccountInfo(cfg9))) await mustVault('vault makes tier 9, exactly at both ceilings', [tierIx(TIER9)]);
for (const [id, param, field, over, ok, what] of [
  ['K3', 0, 'trade_fee_rate', 40_001, 40_000, 'raise a tier above 4% of a swap'],
  ['K4', 1, 'protocol_fee_rate', 104_001, 104_000, "raise the venue's part past the 16% ceiling"],
  ['K5', 2, 'fund_fee_rate', 56_001, 56_000, "raise the island's part past the 16% ceiling"],
]) {
  const r = await vaultRun(`the vault tries to ${what}`, [ix('update_amm_config', { owner: VAULT, amm_config: cfg9 }, { param, value: mut(id) ? ok : over })]);
  const t = await account('AmmConfig', cfg9);
  check(id, 'update_amm_config', `the vault cannot ${what}`, refusedAsOver(r) && t[field] === TIER9[field], r.executed ? `changed to ${t[field]}` : `refused: ${errName(r.execute)}`);
}
phaseDone('phase1');

// =============================================================================================
// Phase 2: pools opened with a price and no coins.
// =============================================================================================
const [M0, M1] = order(BAYLA, WSOL);
const baylaIs0 = M0.equals(BAYLA);
const poolA = reg(PDA.pool(cfg0, M0, M1), 'pool A (BAYLA/SOL, 1%)');
const vA0 = reg(PDA.vault(poolA, M0), 'pool A vault 0');
const vA1 = reg(PDA.vault(poolA, M1), 'pool A vault 1');
const obsA = reg(PDA.observation(poolA), 'pool A price history');
const bitmapA = reg(PDA.bitmap(poolA), 'pool A range map');
// Prices: S is SOL per BAYLA. The program's price is token 1 per token 0 in base units.
const S = man.venuePrice.solPerBayla;
const raw = (s) => (baylaIs0 ? s * 1e3 : 1e-3 / s);
const human = (r) => (baylaIs0 ? r / 1e3 : 1e-3 / r);
const sqrtOf = (s) => { const r = raw(s); return sqrtPriceX64(BigInt(Math.round(r * 1e12)), 10n ** 12n); };
const SPACING = 120;
function range(sLow, sHigh) {
  let a = alignDown(tickAt(raw(sLow)), SPACING);
  let b = alignDown(tickAt(raw(sHigh)), SPACING);
  if (a > b) [a, b] = [b, a];
  if (a === b) b += SPACING;
  return [a, b];
}
const startSqrt = baylaIs0 ? sqrtPriceX64(BigInt(man.venuePrice.lamports), BigInt(man.venuePrice.baylaBase)) : sqrtPriceX64(BigInt(man.venuePrice.baylaBase), BigInt(man.venuePrice.lamports));

// Owner, 2026-10-25: opening a range pool costs 0.5 SOL, paid to the vault, whichever instruction opens it.
const OPEN_FEE = 500_000_000n;
const createPoolIx = (creator, cfg, m0, m1, pool, sqrt, fee = VAULT) => ix('create_pool', {
  pool_creator: creator, amm_config: cfg, pool_state: pool, token_mint_0: m0, token_mint_1: m1,
  token_vault_0: PDA.vault(pool, m0), token_vault_1: PDA.vault(pool, m1), observation_state: PDA.observation(pool),
  tick_array_bitmap: PDA.bitmap(pool), token_program_0: prog(m0), token_program_1: prog(m1), create_pool_fee: fee,
}, { sqrt_price_x64: sqrt, open_time: 0n });
{
  const b0 = [await tok(ata(alice.publicKey, M0)), await tok(ata(alice.publicKey, M1)), await sol(alice.publicKey)];
  const v0 = await sol(VAULT);
  const extra = mut('P2') ? [spl.createTransferCheckedInstruction(ata(alice.publicKey, BAYLA), BAYLA, ata(bob.publicKey, BAYLA), alice.publicKey, 1n, 6, [], ADDR.token2022)]
    : mut('P4') ? [SystemProgram.transfer({ fromPubkey: alice.publicKey, toPubkey: VAULT, lamports: 1 })] : [];
  const r = await must('alice opens pool A (BAYLA/SOL, 1%) at the venue pool price', [createPoolIx(alice.publicKey, cfg0, M0, M1, poolA, mut('P1') ? startSqrt * 2n : startSqrt), ...extra], [alice]);
  const p = await account('PoolState', poolA);
  const rents = [];
  for (const [w, a] of [['pool record (PoolState)', poolA], ['price history (ObservationState)', obsA], ['range map (TickArrayBitmapExtension)', bitmapA], [`pool vault 0 (${baylaIs0 ? 'BAYLA, Token-2022' : 'WSOL, SPL Token'})`, vA0], [`pool vault 1 (${baylaIs0 ? 'WSOL, SPL Token' : 'BAYLA, Token-2022'})`, vA1]]) rents.push((await measure(w, a, 'pool opener')).lamports);
  check('P1', 'create_pool', 'the pool opens with the given price, no liquidity, empty vaults, opener as owner',
    p.amm_config.equals(cfg0) && p.owner.equals(alice.publicKey) && p.token_mint_0.equals(M0) && p.token_mint_1.equals(M1) && p.tick_spacing === SPACING && p.sqrt_price_x64 === startSqrt && p.liquidity === 0n && (await tok(vA0)) === 0n && (await tok(vA1)) === 0n,
    `1 BAYLA = ${human(Number(p.sqrt_price_x64) ** 2 / 2 ** 128).toExponential(4)} SOL, tick ${p.tick_current}`);
  const b1 = [await tok(ata(alice.publicKey, M0)), await tok(ata(alice.publicKey, M1)), await sol(alice.publicKey)];
  const rentSum = rents.reduce((s, x) => s + BigInt(x), 0n);
  check('P2', 'create_pool', 'opening takes no coins from the opener: only the rent of its five accounts, the network fee and the 0.5 SOL opening fee',
    b1[0] === b0[0] && b1[1] === b0[1] && b0[2] - b1[2] === rentSum + BigInt(r.meta.fee) + OPEN_FEE, `${fmt(rentSum, 9)} SOL rent locally`);
  const gained = (await sol(VAULT)) - v0;
  check('P4', 'create_pool', 'opening a pool pays exactly 0.5 SOL to the vault', gained === OPEN_FEE, `vault +${fmt(gained, 9)} SOL`);
}
const [N0, N1] = order(WSOL, USD);
const poolB = reg(PDA.pool(cfg1, N0, N1), 'pool B (SOL/USD, 0.25%)');
for (const [w, m] of [['vault 0', N0], ['vault 1', N1]]) reg(PDA.vault(poolB, m), 'pool B ' + w);
reg(PDA.observation(poolB), 'pool B price history'); reg(PDA.bitmap(poolB), 'pool B range map');
{
  const usdPerSol = 180;
  const sqrtB = N0.equals(WSOL) ? sqrtPriceX64(usdPerSol * 1e6, 1e9) : sqrtPriceX64(1e9, usdPerSol * 1e6);
  // Three ways round the opening fee, each tried on pool B before it opens, each refused.
  {
    const r = await send('alice opens pool B paying the opening fee to mallory', [createPoolIx(alice.publicKey, cfg1, N0, N1, poolB, sqrtB, mut('P5') ? VAULT : mallory.publicKey)], [alice], { expectFail: true });
    check('P5', 'create_pool', 'the opening fee can be paid to no wallet but the vault', failedWith(r, 'ConstraintAddress') && !(await conn.getAccountInfo(poolB)), `refused: ${errName(r)}`);
  }
  {
    const poor = Keypair.generate(); reg(poor.publicKey, 'poor (0.3 SOL)');
    await airdrop(poor.publicKey, mut('P6') ? LAMPORTS_PER_SOL : 0.3 * LAMPORTS_PER_SOL);
    const r = await send('a wallet with 0.3 SOL opens pool B', [createPoolIx(poor.publicKey, cfg1, N0, N1, poolB, sqrtB)], [poor], { expectFail: true });
    check('P6', 'create_pool', 'a wallet that cannot pay the 0.5 SOL cannot open a pool, though it can pay the rent', !r.ok && r.logs.some((l) => /Transfer: insufficient lamports/.test(l)) && !(await conn.getAccountInfo(poolB)), `refused: ${errName(r)}`);
  }
  {
    const old = createPoolIx(alice.publicKey, cfg1, N0, N1, poolB, sqrtB);
    if (!mut('P7')) old.keys.pop();
    const r = await send('alice opens pool B with the account list of the program before the fee', [old], [alice], { expectFail: true });
    check('P7', 'create_pool', 'a transaction built without the fee account, as before the fee, is refused', failedWith(r, 'AccountNotEnoughKeys') && !(await conn.getAccountInfo(poolB)), `refused: ${errName(r)}`);
  }
  const r = await send('alice opens pool B (SOL/USD, 0.25%)', [createPoolIx(alice.publicKey, mut('P3') ? cfg0 : cfg1, N0, N1, poolB, sqrtB)], [alice]);
  const p = r.ok ? await account('PoolState', poolB) : null;
  check('P3', 'create_pool', 'a pool opens on the 0.25% tier with spacing 60', p && p.tick_spacing === 60 && p.amm_config.equals(cfg1) && p.sqrt_price_x64 === sqrtB, p ? `tick ${p.tick_current}` : errName(r));
}
phaseDone('phase2');

// =============================================================================================
// Phase 3: positions. A range around the price, BAYLA only above it, SOL only below it.
// =============================================================================================
const positions = {};
const arrays = new Set();
const pool = async () => account('PoolState', poolA);

/** Reads a Token-2022 mint's TokenMetadata extension (TLV type 19): name, symbol, uri. */
function tokenMetadata(data) {
  let o = 166;
  while (o + 4 <= data.length) {
    const t = data.readUInt16LE(o); const len = data.readUInt16LE(o + 2);
    if (t === 19) {
      let p = o + 4 + 64;
      const str = () => { const n = data.readUInt32LE(p); const s = data.subarray(p + 4, p + 4 + n).toString(); p += 4 + n; return s; };
      return { name: str(), symbol: str(), uri: str() };
    }
    if (t === 0) break;
    o += 4 + len;
  }
  return null;
}

async function openPosition(key, owner, [lower, upper], { bayla, solMax, baseBayla = true, withMetadata = true }) {
  const nft = Keypair.generate();
  reg(nft.publicKey, `${key} NFT mint`);
  const nftAcc = reg(spl.getAssociatedTokenAddressSync(nft.publicKey, owner.publicKey, false, ADDR.token2022), `${key} NFT account`);
  const pos = reg(PDA.position(nft.publicKey), `${key} position`);
  const taL = arrayStart(lower, SPACING); const taU = arrayStart(upper, SPACING);
  for (const s of [taL, taU]) { arrays.add(s); reg(PDA.tickArray(poolA, s), `pool A tick array ${s}`); }
  // Amounts in the program's order; the base side is the one named by base_flag.
  const baylaMax = bayla * BAYLA_UNIT; const lamMax = BigInt(Math.round(solMax * 1e9));
  const [a0, a1] = baylaIs0 ? [baylaMax, lamMax] : [lamMax, baylaMax];
  const before = { b: await tok(ata(owner.publicKey, BAYLA)), s: await tok(ata(owner.publicKey, WSOL)) };
  const r = await send(`${key}: open position`, [ix('open_position_with_token22_nft', {
    payer: owner.publicKey, position_nft_owner: owner.publicKey, position_nft_mint: nft.publicKey, position_nft_account: nftAcc,
    pool_state: poolA, protocol_position: SystemProgram.programId, tick_array_lower: PDA.tickArray(poolA, taL), tick_array_upper: PDA.tickArray(poolA, taU),
    personal_position: pos, token_account_0: ata(owner.publicKey, M0), token_account_1: ata(owner.publicKey, M1), token_vault_0: vA0, token_vault_1: vA1,
    vault_0_mint: M0, vault_1_mint: M1,
  }, {
    tick_lower_index: lower, tick_upper_index: upper, tick_array_lower_start_index: taL, tick_array_upper_start_index: taU,
    liquidity: 0n, amount_0_max: a0, amount_1_max: a1, with_metadata: withMetadata, base_flag: baseBayla === baylaIs0,
  })], [owner, nft]);
  const after = { b: await tok(ata(owner.publicKey, BAYLA)), s: await tok(ata(owner.publicKey, WSOL)) };
  positions[key] = { owner, nft: nft.publicKey, nftAcc, pos, lower, upper, taL, taU };
  return { r, paidBayla: before.b - after.b, paidSol: before.s - after.s, baylaMax, lamMax };
}

{
  const t = await pool();
  const vb = [await tok(vA0), await tok(vA1)];
  const o = await openPosition('alice', alice, mut('L1') ? range(S * 1.2, S * 2.5) : range(S / 2.5, S * 2.5), { bayla: 4_000_000n, solMax: 60, withMetadata: !mut('L2') });
  if (!o.r.ok) console.log(o.r.logs.join('\n'));
  const va = [await tok(vA0), await tok(vA1)];
  const pp = await account('PersonalPositionState', positions.alice.pos);
  const intoVaults = (va[0] - vb[0]) + (va[1] - vb[1]) === o.paidBayla + o.paidSol;
  check('L1', 'open_position_with_token22_nft', 'a range around the price takes both coins, within the caps, and the pool vaults receive exactly that',
    o.r.ok && o.paidBayla > 0n && o.paidSol > 0n && o.paidBayla <= o.baylaMax && o.paidSol <= o.lamMax && intoVaults && pp.liquidity > 0n && positions.alice.lower < t.tick_current && t.tick_current < positions.alice.upper,
    `${fmt(o.paidBayla, 6)} BAYLA + ${fmt(o.paidSol, 9)} SOL, ticks ${positions.alice.lower}..${positions.alice.upper}, ${o.r.cu} CU`);
  const nftMint = await conn.getAccountInfo(positions.alice.nft);
  const md = tokenMetadata(nftMint.data);
  const nftBal = await tok(positions.alice.nftAcc);
  const mintInfo = spl.unpackMint(positions.alice.nft, nftMint, ADDR.token2022);
  check('L2', 'open_position_with_token22_nft', 'the position is a Token-2022 NFT (supply 1, 0 decimals) held by its owner, named "Memetics Range Position", "MEM-RANGE", linking memetics.finance/position/<position>.json',
    nftMint.owner.equals(ADDR.token2022) && mintInfo.supply === 1n && mintInfo.decimals === 0 && nftBal === 1n && md?.name === 'Memetics Range Position' && md?.symbol === 'MEM-RANGE' && md?.uri === `https://memetics.finance/position/${positions.alice.pos.toBase58()}.json`,
    md ? md.uri : 'no name record');
  for (const [w, a] of [['position record (PersonalPositionState)', positions.alice.pos], ['position NFT mint (Token-2022, with name and link)', positions.alice.nft], ['position NFT account (Token-2022)', positions.alice.nftAcc]]) await measure(w, a, 'LP');
  for (const s of new Set([positions.alice.taL, positions.alice.taU])) await measure(`tick array ${s}`, PDA.tickArray(poolA, s), 'first LP whose range needs it');
}
{
  const o = await openPosition('bob', bob, mut('L3') ? range(S / 1.3, S * 3) : range(S * 1.3, S * 3), { bayla: 5_000_000n, solMax: 10 });
  if (!o.r.ok) console.log(o.r.logs.join('\n'));
  check('L3', 'open_position_with_token22_nft', 'a BAYLA-only position above the price takes BAYLA and not one lamport of SOL', o.r.ok && o.paidBayla > 0n && o.paidSol === 0n,
    `${fmt(o.paidBayla, 6)} BAYLA, ${o.paidSol} lamports, ticks ${positions.bob.lower}..${positions.bob.upper}`);
}
{
  const o = await openPosition('carol', carol, mut('L4') ? range(S / 3, S * 1.3) : range(S / 3, S / 1.3), { bayla: 5_000_000n, solMax: 15, baseBayla: false });
  if (!o.r.ok) console.log(o.r.logs.join('\n'));
  check('L4', 'open_position_with_token22_nft', 'a SOL-only position below the price takes SOL and not one unit of BAYLA', o.r.ok && o.paidSol > 0n && o.paidBayla === 0n,
    `${fmt(o.paidSol, 9)} SOL, ${o.paidBayla} BAYLA base units, ticks ${positions.carol.lower}..${positions.carol.upper}`);
}
{
  const far = mut('F4') ? range(S * 1.5, S * 2.0) : mut('R7') ? range(S / 3, S * 3) : range(S * 20, S * 40);
  const o = await openPosition('dave', dave, far, { bayla: mut('L5') ? 0n : 1_000_000n, solMax: mut('R7') ? 60 : 10 });
  check('L5', 'open_position_with_token22_nft', 'a far-away BAYLA-only position opens (it should earn nothing below)', o.r.ok && o.paidBayla > 0n, `ticks ${positions.dave.lower}..${positions.dave.upper}`);
}
{
  const meta = (await conn.getAccountInfo(positions.alice.nft)).data.length;
  const o = await openPosition('erin-nometa', erin, range(S / 2, S * 2), { bayla: 10_000n, solMax: 1, withMetadata: mut('L6') });
  const bare = (await conn.getAccountInfo(positions['erin-nometa'].nft)).data.length;
  await measure('position NFT mint without the name record', positions['erin-nometa'].nft, 'LP');
  check('L6', 'open_position_with_token22_nft', 'without the name record the NFT mint is smaller (a choice the client makes)', o.r.ok && bare < meta, `${bare} vs ${meta} bytes`);
}

const liqIx = (name, key, args, remaining = []) => {
  const p = positions[key];
  const common = {
    nft_owner: p.owner.publicKey, nft_account: p.nftAcc, pool_state: poolA, protocol_position: SystemProgram.programId, personal_position: p.pos,
    tick_array_lower: PDA.tickArray(poolA, p.taL), tick_array_upper: PDA.tickArray(poolA, p.taU), token_vault_0: vA0, token_vault_1: vA1, vault_0_mint: M0, vault_1_mint: M1,
  };
  return name === 'increase_liquidity_v2'
    ? ix(name, { ...common, token_account_0: ata(p.owner.publicKey, M0), token_account_1: ata(p.owner.publicKey, M1) }, args, remaining)
    : ix(name, { ...common, recipient_token_account_0: ata(p.owner.publicKey, M0), recipient_token_account_1: ata(p.owner.publicKey, M1) }, args, remaining);
};
{
  const l0 = (await account('PersonalPositionState', positions.alice.pos)).liquidity;
  const b0 = await tok(ata(alice.publicKey, BAYLA)); const s0 = await tok(ata(alice.publicKey, WSOL));
  const [a0, a1] = baylaIs0 ? [2_000_000n * BAYLA_UNIT, 40n * 10n ** 9n] : [40n * 10n ** 9n, 2_000_000n * BAYLA_UNIT];
  const r = await send('alice adds to her position', [liqIx('increase_liquidity_v2', 'alice', mut('L7') ? { liquidity: 0n, amount_0_max: 0n, amount_1_max: 0n, base_flag: baylaIs0 } : { liquidity: 0n, amount_0_max: a0, amount_1_max: a1, base_flag: baylaIs0 })], [alice]);
  const l1 = (await account('PersonalPositionState', positions.alice.pos)).liquidity;
  const db = b0 - (await tok(ata(alice.publicKey, BAYLA))); const ds = s0 - (await tok(ata(alice.publicKey, WSOL)));
  check('L7', 'increase_liquidity_v2', 'adding to a position raises its liquidity and takes both coins', l1 > l0 && db > 0n && ds > 0n, `+${fmt(db, 6)} BAYLA, +${fmt(ds, 9)} SOL, ${r.cu} CU`);
  const cut = l1 / 4n;
  const b1 = await tok(ata(alice.publicKey, BAYLA)); const s1 = await tok(ata(alice.publicKey, WSOL));
  const r2 = await must('alice removes a quarter', [liqIx('decrease_liquidity_v2', 'alice', { liquidity: mut('L9') ? 0n : cut, amount_0_min: 0n, amount_1_min: 0n })], [alice]);
  const l2 = (await account('PersonalPositionState', positions.alice.pos)).liquidity;
  const gb = (await tok(ata(alice.publicKey, BAYLA))) - b1; const gs = (await tok(ata(alice.publicKey, WSOL))) - s1;
  check('L9', 'decrease_liquidity_v2', 'removing a quarter lowers liquidity by exactly that and pays both coins back to the owner', l2 === l1 - cut && gb > 0n && gs > 0n, `${fmt(gb, 6)} BAYLA, ${fmt(gs, 9)} SOL back, ${r2.cu} CU`);
}
{
  const p = positions.alice;
  const who = mut('L8') ? alice : mallory;
  const before = (await account('PersonalPositionState', p.pos)).liquidity;
  const r = await send('a stranger withdraws from alice', [ix('decrease_liquidity_v2', {
    nft_owner: who.publicKey, nft_account: p.nftAcc, pool_state: poolA, protocol_position: SystemProgram.programId, personal_position: p.pos,
    tick_array_lower: PDA.tickArray(poolA, p.taL), tick_array_upper: PDA.tickArray(poolA, p.taU), token_vault_0: vA0, token_vault_1: vA1, vault_0_mint: M0, vault_1_mint: M1,
    recipient_token_account_0: ata(who.publicKey, M0), recipient_token_account_1: ata(who.publicKey, M1),
  }, { liquidity: 1_000n, amount_0_min: 0n, amount_1_min: 0n })], [who], { expectFail: true });
  check('L8', 'decrease_liquidity_v2', 'only the holder of the position NFT can withdraw from it', !r.ok && (await account('PersonalPositionState', p.pos)).liquidity === before, `refused: ${errName(r)}`);
}
phaseDone('phase3');

const ctx = { WORKSHOP, checks, sizes, known, positions, arrays, K, members, VAULT, BAYLA, WSOL, REWARD, USD, M0, M1, baylaIs0, poolA, poolB, vA0, vA1, obsA, bitmapA, cfg0, cfg1, cfg9, TIER9, S, raw, human, sqrtOf, range, SPACING, BAYLA_UNIT, man, vaultStartLamports, OPEN_FEE };
const { phases } = await import('./suite-phases.mjs');
await phases(ctx, { check, phaseDone, must, mustVault, vaultRun, measure, tok, sol, errName, failedWith, fmt, reg, ata, ataIx, prog, setProg, mut, pool, liqIx, finish, names });
finish('complete');
