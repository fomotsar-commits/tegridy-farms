#!/usr/bin/env node
// Re-capture the deployed selector sets in src/lib/launcher/lockerSelectors.fixture.ts.
//
// Reads each locker's runtime bytecode from mainnet and opcode-walks it, collecting
// every PUSH4 immediate while SKIPPING each PUSH instruction's immediate bytes — so
// constants and metadata can never masquerade as a function selector. Prints a ready
// -to-paste fixture body plus the eth_call cross-check the fixture header cites.
//
//   node frontend/scripts/capture-locker-selectors.mjs
//   RPC_URL=https://… node frontend/scripts/capture-locker-selectors.mjs

const RPC = process.env.RPC_URL || 'https://ethereum-rpc.publicnode.com';

const LOCKERS = {
  V1: '0xe24fc2f7191e850e2d4514abb4d39305b1871ec6',
  V2: '0xce3212e6536f33cd6fbfee265224131353ca3d47',
};

// Selectors whose presence/absence the fixture's claims rest on.
const PROBES = {
  'streams(bytes32)': '0x7f7bd2df',
  'positions(uint256)': '0x99fbab88',
};

let id = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

/** Every PUSH4 immediate reachable as code. Skipping PUSH immediates is load-bearing. */
function push4Selectors(codeHex) {
  const buf = Buffer.from(codeHex.slice(2), 'hex');
  const found = new Set();
  for (let i = 0; i < buf.length; ) {
    const op = buf[i];
    if (op >= 0x60 && op <= 0x7f) {
      // PUSH1..PUSH32
      if (op === 0x63 && i + 4 < buf.length) {
        found.add('0x' + buf.subarray(i + 1, i + 5).toString('hex'));
      }
      i += 1 + (op - 0x5f); // step OVER the immediate bytes
    } else {
      i += 1;
    }
  }
  return [...found].sort();
}

for (const [label, address] of Object.entries(LOCKERS)) {
  const code = await rpc('eth_getCode', [address, 'latest']);
  if (!code || code === '0x') throw new Error(`${label} ${address} has no code`);
  const selectors = push4Selectors(code);

  console.log(`\n// ${label} ${address}`);
  console.log(`  runtimeBytes: ${(code.length - 2) / 2},`);
  console.log(`  selectors: [`);
  for (const s of selectors) console.log(`    '${s}',`);
  console.log(`  ],`);

  // eth_call cross-check: a public-mapping getter returns zeros for an unknown key and
  // never reverts, so a revert here is real evidence of an absent selector.
  for (const [sig, sel] of Object.entries(PROBES)) {
    const calldata = sel + '0'.repeat(64);
    let outcome;
    try {
      const out = await rpc('eth_call', [{ to: address, data: calldata }, 'latest']);
      outcome = `returns ${(out.length - 2) / 2} bytes`;
    } catch {
      outcome = 'REVERT (selector absent)';
    }
    const inWalk = selectors.includes(sel) ? 'in walk' : 'NOT in walk';
    console.log(`//   ${sig.padEnd(20)} ${sel} -> ${outcome.padEnd(26)} (${inWalk})`);
  }
}

console.log('\n// codeHash: keccak256 of the runtime bytecode — compute with:');
console.log('//   cast keccak $(cast code <address> --rpc-url $RPC_URL)');
