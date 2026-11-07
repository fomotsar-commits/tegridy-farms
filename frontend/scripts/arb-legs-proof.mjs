#!/usr/bin/env node
/**
 * Proves the robot's own swap legs (src/lib/solana/keeper/directLegs.ts) on mainnet by
 * SIMULATION only: no key, no signature, nothing sent. For each venue it reads one pool, builds a
 * 0.01 SOL leg from the robot's wallet with its minimum out set to the EXACT amount directLegs
 * computes, and test-runs it. A leg passes when the program accepts the accounts and pays out
 * exactly that amount, with the pool unchanged between the read and the test run.
 *
 *   node scripts/arb-legs-proof.mjs [--fixture <file>]   prints each venue's result
 *
 * --fixture writes what each passing test run saw (the pool's accounts as read, the instruction,
 * the amount paid out), the evidence keeper/directLegs.test.ts holds the legs to.
 */
import fs from 'node:fs';
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
const src = (p) => import(pathToFileURL(path.join(HERE, '..', 'src', 'lib', 'solana', p)).href);
const D = await src('keeper/directLegs.ts');
const P = await src('cpswap/program.ts');
const RAY = await import('./lib/raydium-programs.mjs');
const CPMM = new PublicKey(RAY.RAYDIUM_CPMM);
const AMM_V4 = { program: new PublicKey(RAY.RAYDIUM_AMM_V4), authority: new PublicKey(RAY.RAYDIUM_AMM_V4_AUTHORITY) };

const RPC = process.env.ARB_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const WALLET = new PublicKey('9WAugU3g3YECwuEuoPy3NEH5Co475fHATGdjr2dy2Fcz');
const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const AMOUNT_IN = 10_000_000n;
const fixtureAt = process.argv.includes('--fixture') ? process.argv[process.argv.indexOf('--fixture') + 1] : null;

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
async function read(keys) {
  const r = await rpc('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed' }]);
  return { slot: r.context.slot, acc: new Map(keys.map((k, i) => [k, r.value[i] ? { owner: r.value[i].owner, data: Buffer.from(r.value[i].data[0], 'base64') } : null])) };
}
const amountOf = (a) => (a?.data?.length >= 72 ? a.data.readBigUInt64LE(64) : 0n);

/** Each venue's case: the accounts to read, and the leg built from them. */
const CASES = [
  {
    venue: 'Raydium AMM v4', pool: '2wCvQzD9YgWCzMPRxAmfd4vrsiz99ko1QhCwG7sbRztW', // BIG BRAIN J9zjM2nn4DBYpFy3qrReaUzY66g4EFMwLa61YSGCpump / SOL
    first: (acc, pool) => { const p = D.decodeAmmV4(pool, acc.get(pool).data); return { p, more: [p.coinVault, p.pcVault] }; },
    build: (p, acc) => {
      const coin = amountOf(acc.get(p.coinVault));
      const pc = amountOf(acc.get(p.pcVault));
      const outMint = p.coinMint === SOL ? p.pcMint : p.coinMint;
      const probe = D.ammV4Leg(p, coin, pc, WALLET, SOL, AMOUNT_IN, 1n, AMM_V4);
      return { leg: probe && D.ammV4Leg(p, coin, pc, WALLET, SOL, AMOUNT_IN, probe.out, AMM_V4), outMint, outProgram: TOKEN, vIn: p.coinMint === SOL ? p.coinVault : p.pcVault, vOut: p.coinMint === SOL ? p.pcVault : p.coinVault };
    },
  },
  {
    venue: 'Raydium CPMM', pool: 'G8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh', // CYBERLEEK ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg / SOL
    first: (acc, pool) => { const p = P.decodePoolState(pool, acc.get(pool).data); return { p, more: [p.token0Vault, p.token1Vault, p.ammConfig] }; },
    build: (p, acc) => {
      const config = P.decodeAmmConfig(p.ammConfig, acc.get(p.ammConfig).data);
      const cp = { pool: p, config, vault0: amountOf(acc.get(p.token0Vault)), vault1: amountOf(acc.get(p.token1Vault)) };
      const in0 = p.token0Mint === SOL;
      const probe = D.cpLeg(cp, WALLET, SOL, AMOUNT_IN, 1n, CPMM);
      return { leg: probe && D.cpLeg(cp, WALLET, SOL, AMOUNT_IN, probe.out, CPMM), outMint: in0 ? p.token1Mint : p.token0Mint, outProgram: in0 ? p.token1Program : p.token0Program, vIn: in0 ? p.token0Vault : p.token1Vault, vOut: in0 ? p.token1Vault : p.token0Vault };
    },
  },
  ...['8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n', 'GiV7bAkQ6dipyPd5rFuoQeLLBJCNrRwP57dETVe6ourc'].map((pool) => ({
    venue: 'PumpSwap', pool, // BAYLA 7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump / SOL; APE 2Wkip2U5x93mjaAvoq8zaedweP73GgRtbaQhNcwXpump / SOL
    first: (acc, address) => { const p = D.decodePumpPool(address, acc.get(address).data); return { p, more: [p.baseVault, p.quoteVault, p.baseMint, D.PUMP_GLOBAL_CONFIG.toBase58(), D.PUMP_FEE_CONFIG.toBase58()] }; },
    build: (p, acc) => {
      const cfg = D.decodePumpFeeConfig(acc.get(D.PUMP_FEE_CONFIG.toBase58()).data);
      const g = acc.get(D.PUMP_GLOBAL_CONFIG.toBase58()).data;
      const recipient = new PublicKey(g.subarray(57, 89));
      const mint = acc.get(p.baseMint);
      const base = amountOf(acc.get(p.baseVault));
      const quote = amountOf(acc.get(p.quoteVault)) + p.quoteExtra;
      const f = D.pumpFeesFor(p, cfg, base, quote, mint.data.readBigUInt64LE(36));
      const ctx = { protocolFeeRecipient: recipient, baseProgram: new PublicKey(mint.owner), quoteProgram: new PublicKey(TOKEN) };
      return { leg: D.pumpBuyLeg(p, f, base, quote, WALLET, ctx, AMOUNT_IN, 1n), outMint: p.baseMint, outProgram: mint.owner, vIn: p.quoteVault, vOut: p.baseVault, fees: f };
    },
  })),
];

const fixtures = [];
for (const c of CASES) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const head = await read([c.pool]);
      const { p, more } = c.first(head.acc, c.pool);
      const { slot, acc } = await read([c.pool, ...more]);
      const b = c.build(p, acc);
      if (!b.leg) throw new Error('no leg built');
      const outAta = getAssociatedTokenAddressSync(new PublicKey(b.outMint), WALLET, true, new PublicKey(b.outProgram)).toBase58();
      const { acc: before } = await read([outAta]);
      const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), createAssociatedTokenAccountIdempotentInstruction(WALLET, new PublicKey(outAta), WALLET, new PublicKey(b.outMint), new PublicKey(b.outProgram)), b.leg.ix];
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: WALLET, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message());
      const sim = await rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', minContextSlot: slot, accounts: { encoding: 'base64', addresses: [b.vIn, b.vOut, outAta] } }]);
      const v = sim.value;
      const post = (v.accounts ?? []).map((a) => (a ? amountOf({ data: Buffer.from(a.data[0], 'base64') }) : null));
      const got = post[2] !== null ? post[2] - amountOf(before.get(outAta)) : null;
      const unchanged = post[1] !== null && amountOf(acc.get(b.vOut)) - post[1] === got;
      const ok = !v.err && got === b.leg.out && unchanged;
      console.log(`${c.venue} ${c.pool} (read at slot ${slot}, run at ${sim.context.slot}): ${ok ? 'PASSES' : 'FAILS'}; directLegs says ${b.leg.out}, the program paid ${got}${v.err ? `; error ${JSON.stringify(v.err)}` : ''}${unchanged ? '' : '; the pool moved between the read and the test run'}; ${v.unitsConsumed} units`);
      if (v.err) console.log((v.logs ?? []).slice(-8).map((l) => `    ${l}`).join('\n'));
      if (ok) {
        fixtures.push({
          venue: c.venue, pool: c.pool, slot, amountIn: String(AMOUNT_IN), out: String(got), fees: b.fees ? Object.fromEntries(Object.entries(b.fees).map(([k, x]) => [k, String(x)])) : undefined,
          accounts: Object.fromEntries([c.pool, ...more].map((k) => [k, { owner: acc.get(k).owner, data: acc.get(k).data.toString('base64') }])),
          keys: b.leg.ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), data: Buffer.from(b.leg.ix.data).toString('hex'),
        });
        break;
      }
      if (unchanged) break;
    } catch (e) {
      console.log(`${c.venue} ${c.pool}: not run (${e instanceof Error ? e.message : String(e)})`);
      break;
    }
  }
}
if (fixtureAt) fs.writeFileSync(fixtureAt, `${JSON.stringify(fixtures, null, 1)}\n`);
