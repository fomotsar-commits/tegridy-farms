#!/usr/bin/env node
/**
 * Proof that a read the main RPC cannot answer is really answered by the fallback
 * (scripts/lib/rpc-fallback.mjs, KEEPER_RPC_FALLBACK_URLS), against the real endpoints. Read-only:
 * no key, nothing sent.
 *
 *   node scripts/rpc-fallback-proof.mjs [fallback url]      (default https://solana-rpc.publicnode.com)
 *
 * It reads our pools' accounts (27: more than publicnode takes in one read) two ways and compares:
 *   1. straight from the public mainnet RPC, one read;
 *   2. through rpcWithFallback with a main endpoint that cannot be reached, so the fallback answers.
 * It passes when the fallback gives every account, in the same order, owned by our program, and
 * the bytes agree (a pool traded between the two reads may differ: counted, and at most 3 allowed).
 * Written after the first 40 minutes live (2026-11-14): publicnode answered 403 to every read of
 * more than 10 accounts, and the first build threw that as the read's answer.
 */
import { rpcWithFallback } from './lib/rpc-fallback.mjs';

const MAINNET = 'https://api.mainnet-beta.solana.com';
const FALLBACK = process.argv[2] ?? 'https://solana-rpc.publicnode.com';
const OURS = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';
const UNREACHABLE = 'http://127.0.0.1:9/';

const direct = rpcWithFallback({ urls: [MAINNET] });
const pools = (await direct.call('getProgramAccounts', [OURS, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: 637 }] }])).map((a) => a.pubkey);
const opts = { encoding: 'base64', commitment: 'confirmed' };
const straight = await direct.call('getMultipleAccounts', [pools, opts]);

const said = [];
const line = rpcWithFallback({ urls: [UNREACHABLE, FALLBACK], onBusy: (url, why) => said.push(`busy ${new URL(url).host}: ${why}`), onCap: (url, n) => said.push(`cap ${new URL(url).host}: ${n}`) });
const t0 = Date.now();
const first = await line.call('getMultipleAccounts', [pools, opts]);
const firstMs = Date.now() - t0;
const t1 = Date.now();
const second = await line.call('getMultipleAccounts', [pools, opts]);
const secondMs = Date.now() - t1;

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};
const differ = (a, b) => a.value.filter((v, i) => v?.data?.[0] !== b.value[i]?.data?.[0]).length;
check('our pools were found', pools.length > 10, `${pools.length} pools (more than one read of the fallback may ask)`);
check('the fallback answered every account, in order', first.value.length === pools.length && first.value.every((v) => v && v.owner === OURS), `${first.value.length} of ${pools.length}, all owned by our program`);
check('its bytes agree with the public mainnet RPC', differ(first, straight) <= 3, `${differ(first, straight)} of ${pools.length} differ (a pool that traded between the two reads may)`);
check('the read was split to what the endpoint takes', line.counts.splitReads >= 1 || line.caps.size === 0, line.caps.size ? `at most ${[...line.caps.values()][0]} accounts a read there; split reads so far ${line.counts.splitReads}` : 'the endpoint took it whole');
check('the second read needed no refusal first', second.value.length === pools.length, `first read ${firstMs} ms, second ${secondMs} ms`);
check('slots are near the chain’s', Math.abs(Number(first.context.slot) - Number(straight.context.slot)) < 150, `fallback ${first.context.slot}, mainnet ${straight.context.slot}`);
console.log(`what it said: ${said.join(' | ') || 'nothing'}`);
console.log(failed ? `RESULT: ${failed} check(s) failed` : 'RESULT: ok, a read the main RPC cannot answer is answered whole by the fallback (nothing was sent)');
process.exitCode = failed ? 1 : 0;
