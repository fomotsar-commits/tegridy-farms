#!/usr/bin/env node
/**
 * Proves the robot's direct trips (src/lib/solana/keeper/direct.ts) on mainnet by SIMULATION only:
 * no key, no signature, nothing sent. For each pair (one of our pools, the coin's outside pool) and
 * each way (buy in ours and sell outside; buy outside and sell in ours) it builds the WHOLE
 * transaction the robot would send (keeper/cycle.ts tripInstructions: compute budget, the two
 * coin accounts, both swaps, the Lighthouse check last) at 0.01 SOL, and test-runs it from the
 * robot's wallet. A trip passes when it fits one transaction, the programs accept it, and the
 * wallet's wrapped SOL moves by EXACTLY what direct.ts's maths says (coinOut − spent).
 *
 * There is rarely a real gap at 0.01 SOL, so the Lighthouse floor here is the trip's own expected
 * change less one lamport (usually a loss): the check still runs, and must pass at exactly that.
 *
 *   node scripts/direct-trip-proof.mjs     (ARB_RPC_URL: publicnode by default, not the robot's RPC;
 *                                           DIRECT_ALTS: lookup tables to compile with, comma-separated;
 *                                           DIRECT_LOAN=yes: each trip borrows its 0.01 SOL from Kamino inside it;
 *                                           DIRECT_TIP=yes: each trip carries a 20,000-lamport Jito tip, as a live one does)
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { AddressLookupTableAccount, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

// The robot's TS modules load through its loader (scripts/price-keeper.mjs).
const loaderSource = `
import { stripTypeScriptTypes } from 'node:module';
export async function resolve(specifier, context, nextResolve) {
  const relative = specifier[0] === '.';
  const hasExt = /\\.[cm]?[jt]sx?$/.test(specifier);
  if (!relative || hasExt) return nextResolve(specifier, context);
  try {
    return await nextResolve(specifier + '.ts', context);
  } catch {
    return nextResolve(specifier + '.js', context);
  }
}
export async function load(url, context, nextLoad) {
  if (!/\\.tsx?$/.test(new URL(url).pathname)) return nextLoad(url, context);
  const r = await nextLoad(url, { ...context, format: 'module' });
  const src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
  return { ...r, format: 'module', source: 'import.meta.env ??= {};' + stripTypeScriptTypes(src, { mode: 'strip' }) };
}
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => import(pathToFileURL(path.join(HERE, '..', 'src', 'lib', p)).href);
const F = await src('solana/lp/poolFinder.ts');
const CP = await src('solana/cpswap/program.ts');
const RD = await src('solana/cpswap/read.ts');
const LP = await src('launcher/solana/curve/program.ts');
const D = await src('solana/keeper/direct.ts');
const CY = await src('solana/keeper/cycle.ts');
const RAY = await import('./lib/raydium-programs.mjs');
const FL = await src('solana/keeper/flashLoan.ts');
const JI = await src('solana/keeper/jito.ts');

const RPC = process.env.ARB_RPC_URL?.trim() || 'https://solana-rpc.publicnode.com';
const WALLET = new PublicKey('9WAugU3g3YECwuEuoPy3NEH5Co475fHATGdjr2dy2Fcz');
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SIZE = 10_000_000n;
const PUMP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const IDS = { cpmm: RAY.RAYDIUM_CPMM, ammV4: RAY.RAYDIUM_AMM_V4, ammV4Authority: RAY.RAYDIUM_AMM_V4_AUTHORITY };
/** Our pool, and the coin's outside pool (2026-11-07: each coin's deepest, per DexScreener and its owner on chain). */
const PAIRS = [
  { name: 'BAYLA', ours: 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4', outside: { pool: '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n', program: PUMP, mint: '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump' } },
  { name: 'BIG BRAIN', ours: '3YRW6wJscukRaWutB6QgPwtK1EQM9KA7CXcXTtmN3GJK', outside: { pool: '2wCvQzD9YgWCzMPRxAmfd4vrsiz99ko1QhCwG7sbRztW', program: RAY.RAYDIUM_AMM_V4, mint: 'J9zjM2nn4DBYpFy3qrReaUzY66g4EFMwLa61YSGCpump' } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function rpc(method, params) {
  for (let i = 0; ; i++) {
    const wait = last + 400 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429 && i < 3) {
      await sleep(5_000);
      continue;
    }
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
    return j.result;
  }
}
// publicnode takes at most 10 accounts a getMultipleAccounts: split bigger reads.
async function rpcSplit(method, params) {
  if (method !== 'getMultipleAccounts' || params[0].length <= 10) return rpc(method, params);
  const value = [];
  let context;
  for (let i = 0; i < params[0].length; i += 10) {
    const r = await rpc(method, [params[0].slice(i, i + 10), ...params.slice(1)]);
    value.push(...r.value);
    context = r.context;
  }
  return { context, value };
}
const amountOf = (b64) => Buffer.from(b64, 'base64').readBigUInt64LE(64);
const LOAN = process.env.DIRECT_LOAN === 'yes' ? SIZE : 0n;
const TIP = process.env.DIRECT_TIP === 'yes' ? { lamports: 20_000n, account: JI.JITO_TIP_ACCOUNTS[0] } : undefined;
const ALTS = [];
for (const k of [...(process.env.DIRECT_ALTS ?? '').split(',').map((x) => x.trim()).filter(Boolean), ...(LOAN ? [FL.KAMINO_LOOKUP_TABLE] : [])]) {
  const a = (await rpc('getAccountInfo', [k, { encoding: 'base64', commitment: 'confirmed' }])).value;
  if (!a) throw new Error(`lookup table ${k} not found`);
  ALTS.push(new AddressLookupTableAccount({ key: new PublicKey(k), state: AddressLookupTableAccount.deserialize(Buffer.from(a.data[0], 'base64')) }));
}
if (ALTS.length) console.log(`compiling with lookup tables ${ALTS.map((t) => `${t.key.toBase58()} (${t.state.addresses.length} addresses${t.state.deactivationSlot < 2n ** 64n - 1n ? ', DEACTIVATED' : ''})`).join(', ')}`);

for (const pair of PAIRS) {
  try {
    const read = await F.readPools(rpcSplit, [pair.ours], { programId: CP.REGISTERED_PROGRAM_ID, launchProgramId: LP.PROGRAM_ID });
    const entry = read.kind === 'ok' ? read.entries[0] : null;
    if (!entry || entry.kind !== 'pool') throw new Error(`our pool not read: ${JSON.stringify(entry ?? read).slice(0, 160)}`);
    const view = entry.view;
    const now = Number(read.chainNow);
    const [d] = await D.readDirectPools(rpcSplit, [pair.outside], IDS, now, () => 0);
    if (!d) throw new Error('the outside pool did not decode');
    const pool = view.snapshot.pool;
    const tokenProgram = new PublicKey(view.quoteIsToken0 ? pool.token1Program : pool.token0Program);
    const accounts = {
      coinMint: new PublicKey(SOL), tokenMint: new PublicKey(view.tokenMint), tokenProgram,
      coinAta: getAssociatedTokenAddressSync(new PublicKey(SOL), WALLET, true, TOKEN),
      tokenAta: getAssociatedTokenAddressSync(new PublicKey(view.tokenMint), WALLET, true, tokenProgram),
      otherAta: getAssociatedTokenAddressSync(new PublicKey(USDC), WALLET, true, TOKEN),
    };
    const held = amountOf((await rpc('getAccountInfo', [accounts.coinAta.toBase58(), { encoding: 'base64', commitment: 'confirmed' }])).value.data[0]);
    const ourOut = (from, x) => RD.quoteOwnPool(view.snapshot, view.config, from, x, now)?.outAmount ?? null;
    for (const buyIn of ['ours', 'outside']) {
      let tokens, spent, coinOut, legs;
      if (buyIn === 'ours') {
        tokens = ourOut(SOL, SIZE);
        spent = SIZE;
        coinOut = d.sell(tokens);
        legs = [CY.ownSwap(WALLET, view, 'coin', SIZE, tokens), d.sellIx(WALLET, tokens, coinOut)];
      } else {
        const b = d.buy(SIZE);
        ({ tokens, spent } = b);
        coinOut = ourOut(view.tokenMint, tokens);
        legs = [d.buyIx(WALLET, SIZE, tokens), CY.ownSwap(WALLET, view, 'token', tokens, coinOut)];
      }
      const change = coinOut - spent - FL.flashFee(LOAN);
      // A tip comes out of plain SOL and raises the check by itself: the wrapped SOL still moves by `change`.
      const ixs = CY.tripInstructions(WALLET, { accounts, legs, floor: change - 1n - (TIP?.lamports ?? 0n), loan: LOAN, tip: TIP }, 10_000, 600_000, held);
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: WALLET, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message(ALTS));
      let bytes;
      try {
        bytes = tx.serialize().length + 64; // + the one signature a sent trip carries
      } catch (e) {
        console.log(`${pair.name} buy in ${buyIn}: DOES NOT FIT one transaction (${e instanceof Error ? e.message : String(e)}); ${tx.message.staticAccountKeys.length} accounts`);
        continue;
      }
      const sim = (await rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [accounts.coinAta.toBase58()] } }])).value;
      const moved = sim.accounts?.[0] ? amountOf(sim.accounts[0].data[0]) - held : null;
      const ok = !sim.err && moved === change && bytes <= 1232;
      console.log(`${pair.name} vs ${d.venue}, buy in ${buyIn}${LOAN ? ', all of it borrowed' : ''}${TIP ? ', with a Jito tip' : ''}: ${ok ? 'PASSES' : 'FAILS'}; ${bytes} bytes of 1232, ${tx.message.staticAccountKeys.length} accounts; direct.ts says the wrapped SOL moves ${change}, the test run moved it ${moved}${sim.err ? `; error ${JSON.stringify(sim.err)}` : ''}; ${sim.unitsConsumed} units`);
      if (sim.err) console.log((sim.logs ?? []).slice(-8).map((l) => `    ${l}`).join('\n'));
    }
  } catch (e) {
    console.log(`${pair.name}: not run (${e instanceof Error ? e.message : String(e)})`);
  }
}
