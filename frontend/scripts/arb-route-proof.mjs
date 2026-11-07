#!/usr/bin/env node
/**
 * Proves the swaps the robot builds for a trip the engine hands over (scripts/lib/arb-legs.mjs,
 * every venue the engine prices) on mainnet by SIMULATION only: no key, no signature, nothing
 * sent. For each venue it reads one pool through the same reader the robot uses, builds a leg
 * of 0.01 SOL (or 1 USDC) from the robot's wallet with its minimum out set to the EXACT amount
 * the leg's own maths gives, and test-runs it. A leg passes when the program accepts the
 * accounts and pays out exactly that amount, with the pool unchanged between the read and the
 * test run (a pool that moved in between is read and run again, three times at most). It also
 * says how many accounts and bytes the leg takes, so a two-leg trip's fit in one transaction
 * can be judged.
 *
 *   node scripts/arb-route-proof.mjs [--only <venue words>]
 *
 * Settings: ARB_RPC_URL (public mainnet by default; one call in 1.5 s).
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';

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
const C = await import(pathToFileURL(path.join(HERE, 'lib', 'arb-chain.mjs')).href);
const LEGS = await import(pathToFileURL(path.join(HERE, 'lib', 'arb-legs.mjs')).href);
const RAY = await import(pathToFileURL(path.join(HERE, 'lib', 'raydium-programs.mjs')).href);

const RPC = process.env.ARB_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const WALLET = new PublicKey(C.ROBOT.wallet);
const SOL = C.SOL_MINT;
const USDC = C.USDC_MINT;
const only = process.argv.includes('--only') ? process.argv.slice(process.argv.indexOf('--only') + 1).join(' ').toLowerCase() : null;
const log = (line) => console.log(`${new Date().toISOString()}  ${line}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function rpc(method, params) {
  const wait = last + 1_500 - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}
const amountOf = (data) => (data?.length >= 72 ? data.readBigUInt64LE(64) : 0n);

/** Each venue's case: one pool, the coin going in, how much. */
const CASES = [
  { venue: 'ours (Tegriddy Farms)', dex: 'ours', pool: 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4', in: SOL, amount: 10_000_000n },
  { venue: 'Raydium CPMM', dex: 'cpmm', pool: 'G8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh', in: SOL, amount: 10_000_000n },
  { venue: 'Raydium AMM v4', dex: 'ammV4', pool: '2wCvQzD9YgWCzMPRxAmfd4vrsiz99ko1QhCwG7sbRztW', in: SOL, amount: 10_000_000n },
  { venue: 'PumpSwap', dex: 'pumpswap', pool: '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n', in: SOL, amount: 10_000_000n },
  { venue: 'Orca', dex: 'whirlpool', pool: '83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d', in: SOL, amount: 10_000_000n },
  { venue: 'Orca adaptive (SOL/cbBTC)', dex: 'whirlpool', pool: 'B4bn8eSGUWsETHdKj2uXUHDLW2s2zeRWrKZofBWxCMAm', in: SOL, amount: 10_000_000n },
  { venue: 'Orca adaptive (NVDAx/USDC)', dex: 'whirlpool', pool: '6R4r93V5fcMzc13CL2enEepDSYcr4Qx3ptZBDwudTXCo', in: USDC, amount: 1_000_000n },
  // Quieter Orca and DLMM pools (the venues run's, 2026-11-07): SOL/USDC moves every slot, so a read and a run seldom see the same pool.
  { venue: 'Orca (a memecoin pool)', dex: 'whirlpool', pool: 'AU971DrPyhhrpRnmEBp5pDTWL2ny7nofb5vYBjDJkR2E', in: null, amount: null },
  { venue: 'Orca (a memecoin pool, 2)', dex: 'whirlpool', pool: '8EyLmmyt8VNqhu8c2NzJ2BCTEZZk4W9SccbEoie2raR7', in: null, amount: null },
  { venue: 'Raydium CLMM', dex: 'clmm', pool: 'CYbD9RaToYMtWKA7QZyoLahnHdWq553Vm62Lh6qWtuxq', in: SOL, amount: 10_000_000n },
  { venue: 'Meteora DLMM', dex: 'dlmm', pool: 'HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR', in: SOL, amount: 10_000_000n },
  { venue: 'Meteora DLMM (a memecoin pool)', dex: 'dlmm', pool: 'ForWDAgkpGS5CnvDN8YBuEcDFtKtuhiu7CDm4bpn15TZ', in: null, amount: null },
  { venue: 'Meteora DLMM (a memecoin pool, 2)', dex: 'dlmm', pool: '7U8DUKAds4SKeKU9zWNdM6iVXrsLc7fx8VUY5sw2zjWz', in: null, amount: null },
  { venue: 'Meteora DAMM v2', dex: 'damm', pool: '8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie', in: SOL, amount: 10_000_000n },
];
/** The coin going in when a case names none: SOL, else USDC, 0.01 SOL or 1 USDC. */
const sideOf = (p) => ([p.mintA, p.mintB].includes(SOL) ? { in: SOL, amount: 10_000_000n } : [p.mintA, p.mintB].includes(USDC) ? { in: USDC, amount: 1_000_000n } : null);
/** A refusal that says the pool paid less than the exact minimum: it moved between the read and the run. */
const BELOW_MINIMUM = /AmountOutBelowMinimum|ExceededAmountSlippageTolerance|TooLittleOutputReceived|ExceededSlippage|6036|6003/;

const readLegs = LEGS.routeLegReader({ rpc, ids: { cpmm: RAY.RAYDIUM_CPMM, ammV4: RAY.RAYDIUM_AMM_V4, ammV4Authority: RAY.RAYDIUM_AMM_V4_AUTHORITY, clmm: RAY.RAYDIUM_CLMM } });

let failed = 0;
for (const c of CASES) {
  if (only && !c.venue.toLowerCase().includes(only) && !c.dex.toLowerCase().includes(only)) continue;
  let said = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // The pool once, for its pair; then the reader, as the robot runs it.
      const head = await rpc('getMultipleAccounts', [[c.pool], { encoding: 'base64', commitment: 'confirmed' }]);
      const a = head.value[0];
      const p = a && C.decodePool(c.dex, c.pool, Buffer.from(a.data[0], 'base64'));
      if (!p) throw new Error('the pool did not decode');
      const side = c.in ? { in: c.in, amount: c.amount } : sideOf(p);
      if (!side) throw new Error('neither SOL nor USDC is a side of this pool');
      const out = p.mintA === side.in ? p.mintB : p.mintA;
      const rec = { legs: [{ pool: c.pool, dex: c.dex, from: side.in, to: out, accounts: [] }], mints: {} };
      const built = await readLegs(rec, WALLET, Math.floor(Date.now() / 1000));
      if (typeof built === 'string') throw new Error(built);
      const [leg] = built.legs;
      const quoted = leg.out(side.amount);
      if (quoted === null) throw new Error('the leg would not quote');
      const ix = leg.ix(side.amount, quoted);
      if (!ix) throw new Error('the leg was not built');
      const outAta = getAssociatedTokenAddressSync(new PublicKey(out), WALLET, true, leg.toProgram);
      const before = await rpc('getMultipleAccounts', [[outAta.toBase58()], { encoding: 'base64', commitment: 'confirmed' }]);
      const had = before.value[0] ? amountOf(Buffer.from(before.value[0].data[0], 'base64')) : 0n;
      const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), createAssociatedTokenAccountIdempotentInstruction(WALLET, outAta, WALLET, new PublicKey(out), leg.toProgram), ix];
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: WALLET, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message());
      const bytes = tx.serialize().length;
      const sim = await rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', minContextSlot: built.slot, accounts: { encoding: 'base64', addresses: [outAta.toBase58()] } }]);
      const v = sim.value;
      if (v.err) {
        const logs = (v.logs ?? []).filter((l) => /Error|failed|Custom|Left|Right|insufficient/i.test(l)).slice(-4);
        const text = `test run refused ${JSON.stringify(v.err)}: ${logs.join(' | ').slice(0, 400)}`;
        if (attempt < 3 && BELOW_MINIMUM.test(text)) {
          log(`     ${c.venue}: paid under the exact minimum (the pool moved between the read and the run): again`);
          continue;
        }
        throw new Error(text);
      }
      const after = v.accounts?.[0] ? amountOf(Buffer.from(v.accounts[0].data[0], 'base64')) : null;
      const got = after === null ? null : after - had;
      const same = got === quoted;
      if (!same && attempt < 3) {
        log(`     ${c.venue}: paid ${got} against ${quoted} by my maths (the pool may have moved between the read and the run): again`);
        continue;
      }
      log(`${same ? 'OK  ' : 'FAIL'} ${c.venue} ${c.pool}: ${side.amount} in → ${quoted} out by the leg's maths, the program paid ${got}; ${ix.keys.length} accounts in the swap, ${bytes} bytes with its account opening, ${v.unitsConsumed} units, slot ${built.slot}`);
      said = same ? 'ok' : 'fail';
      break;
    } catch (e) {
      if (attempt < 3 && /moved|429|refused for speed/i.test(String(e?.message))) {
        await sleep(3_000);
        continue;
      }
      log(`FAIL ${c.venue} ${c.pool}: ${e instanceof Error ? e.message : String(e)}`);
      said = 'fail';
      break;
    }
  }
  if (said !== 'ok') failed++;
}
log(failed ? `${failed} venue(s) FAILED` : 'every venue paid exactly what its leg said');
process.exit(failed ? 1 : 0);
