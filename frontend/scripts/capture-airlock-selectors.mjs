#!/usr/bin/env node
/**
 * capture-airlock-selectors.mjs — snapshot the function selectors the DEPLOYED
 * Doppler Airlock actually implements, into src/lib/launcher/airlockSelectors.fixture.ts.
 *
 * WHY THIS EXISTS
 * We hand-roll three Airlock ABI fragments (AIRLOCK_FEES_ABI, AIRLOCK_ABI,
 * AIRLOCK_GET_ASSET_DATA). A hand-rolled ABI is an ASSERTION about a contract we do
 * not compile, and nothing in a unit test can falsify it: every test mocks the
 * transport, so a fragment naming a function the contract does not have decodes
 * canned data forever and passes.
 *
 * That is not hypothetical. `AIRLOCK_FEES_ABI` declared `integratorFees(address,address)`
 * — copied faithfully from the SDK's own `airlockAbi`, which is STALE relative to the
 * deployed contract. The real accessor is `getIntegratorFees`. Every read failed,
 * multicall's allowFailure swallowed it, and the UI showed "nothing to claim" over
 * live integrator revenue. Copying from the SDK is what caused the bug, so the pin
 * below is taken from BYTECODE, never from the SDK.
 *
 * WHAT IT RECORDS — two independent signals, because neither alone is sufficient:
 *
 *   selectors   Every PUSH4 immediate in an opcode walk of the runtime bytecode. The
 *               walk skips PUSH payloads, so bytes INSIDE a push are never mistaken
 *               for opcodes — a naive substring scan reports selectors that are not
 *               there. This is the complete presence signal: solc's dispatcher
 *               compares the incoming selector against PUSH4 constants, so an
 *               implemented function's selector is always here.
 *               It can over-report: a selector the Airlock CALLS on some other
 *               contract, or a byte run inside trailing CBOR metadata, also lands in
 *               this set. Hence the second signal.
 *
 *   dispatched  Selectors that answered a live `eth_call` with data. This is positive
 *               proof of implementation, and it is what actually separates
 *               `getIntegratorFees` (returns a word) from `integratorFees` (reverts).
 *               Only meaningful for view functions callable with placeholder args, so
 *               it is a SUBSET — a nonpayable function like `migrate` reverts on its
 *               own preconditions and is covered by the walk alone.
 *
 * Usage (from repo root):
 *   node frontend/scripts/capture-airlock-selectors.mjs
 *   ETH_RPC_URL=https://... node frontend/scripts/capture-airlock-selectors.mjs
 *
 * Deliberately dependency-free: it never derives a selector from a signature, so it
 * needs no keccak and cannot inherit a mistake from the ABI it is meant to police.
 * The test does the deriving, with viem's toFunctionSelector.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RPC = process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const AIRLOCK = '0xde3599a2ec440b296373a983c85c365da55d9dfa';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'launcher', 'airlockSelectors.fixture.ts');

/**
 * View functions we probe with a live call, as [selector, calldataSuffix].
 * Selectors are LITERAL on purpose — computing them here from a signature would let
 * the same typo that produced the bug flow into the fixture that is supposed to catch it.
 */
const ADDR_A = '11'.repeat(20).padStart(64, '0');
const ADDR_B = '00'.repeat(20).padStart(64, '0');
const PROBES = [
  ['0xe7f0d8f1', ADDR_A + ADDR_B], // getIntegratorFees(address,address)
  ['0x2e27c8de', ADDR_A], //           getModuleState(address)
  ['0x8da5cb5b', ''], //               owner()
  ['0x1652e7b7', ADDR_A], //           getAssetData(address)
];

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  return body;
}

/**
 * Collect every PUSH4 immediate, walking the code as OPCODES.
 * PUSHn (0x60..0x7f) carries n = op - 0x5f immediate bytes that must be skipped;
 * failing to skip them is what makes a plain byte-search hallucinate selectors.
 */
function push4Selectors(hex) {
  const code = Buffer.from(hex.slice(2), 'hex');
  const found = new Set();
  for (let i = 0; i < code.length; ) {
    const op = code[i];
    if (op >= 0x60 && op <= 0x7f) {
      const width = op - 0x5f;
      if (op === 0x63 && i + 1 + 4 <= code.length) {
        found.add('0x' + code.subarray(i + 1, i + 5).toString('hex'));
      }
      i += 1 + width;
    } else {
      i += 1;
    }
  }
  return found;
}

const codeRes = await rpc('eth_getCode', [AIRLOCK, 'latest']);
if (codeRes.error) throw new Error(`eth_getCode: ${codeRes.error.message}`);
const code = codeRes.result;
if (!code || code === '0x') throw new Error(`no bytecode at ${AIRLOCK} — wrong chain?`);

const blockRes = await rpc('eth_blockNumber', []);
const block = Number(BigInt(blockRes.result));

const selectors = [...push4Selectors(code)].sort();
console.log(`runtime bytecode: ${(code.length - 2) / 2} bytes @ block ${block}`);
console.log(`PUSH4 selectors:  ${selectors.length}`);

const dispatched = [];
for (const [selector, suffix] of PROBES) {
  const res = await rpc('eth_call', [{ to: AIRLOCK, data: selector + suffix }, 'latest']);
  const ok = !res.error && typeof res.result === 'string' && res.result.length > 2;
  console.log(`  ${selector} ${ok ? 'dispatched' : `NO (${res.error?.message ?? 'empty return'})`}`);
  if (ok) dispatched.push(selector);
}

const banner = `// GENERATED by frontend/scripts/capture-airlock-selectors.mjs — DO NOT EDIT BY HAND.
//
// The function selectors the deployed Doppler Airlock actually implements, captured
// from its runtime BYTECODE (not from the SDK, whose airlockAbi is stale — it still
// names the fee accessor \`integratorFees\`, which this contract does not have).
//
// airlockSelectors.test.ts asserts every function our hand-rolled Airlock ABI
// fragments declare appears here. Regenerate only by re-running the script; editing
// this file by hand to make a test pass would defeat its entire purpose.
//
// Airlock: ${AIRLOCK}
// Captured at block ${block} (mainnet).
`;

const body = `${banner}
/** The Airlock this fixture describes. Must match DOPPLER_MAINNET.airlock. */
export const AIRLOCK_ADDRESS = '${AIRLOCK}' as const;

/** Mainnet block the capture was taken at. */
export const CAPTURED_AT_BLOCK = ${block};

/**
 * Every PUSH4 immediate in an opcode-honouring walk of the runtime bytecode.
 * A function the contract implements ALWAYS appears here (solc's dispatcher compares
 * against PUSH4 constants). The converse does not hold — selectors the Airlock calls
 * on other contracts also appear — so this is a necessary, not sufficient, condition.
 */
export const AIRLOCK_DEPLOYED_SELECTORS: ReadonlySet<string> = new Set([
${selectors.map((s) => `  '${s}',`).join('\n')}
]);

/**
 * Selectors PROVEN to dispatch by a live eth_call that returned data. Positive proof
 * of implementation, and the signal that actually distinguishes getIntegratorFees
 * (returns a uint256 word) from the absent integratorFees (reverts). View functions
 * only — a nonpayable function reverts on its own preconditions and cannot be probed
 * this way, so absence from this set means "not probed", never "not implemented".
 */
export const AIRLOCK_DISPATCHED_SELECTORS: ReadonlySet<string> = new Set([
${dispatched.map((s) => `  '${s}',`).join('\n')}
]);
`;

writeFileSync(OUT, body);
console.log(`\nwrote ${OUT}`);
