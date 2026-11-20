#!/usr/bin/env node
// Holds OUR compiled V3OpenFeeAdapter against Uniswap's LIVE one, byte for byte.
//
//   node contracts/hyperevm/scripts/check-adapter-bytes.mjs [--live 0x<address>] [--rpc <url>]
//
// Default target: Uniswap's adapter that owns Uniswap's own V3 factory on Ethereum,
// 0xf2371551Fe3937Db7c750f4DfABe5c2fFFdcBf5A (factory.owner() read 2026-11-19).
// After our HyperEVM deploy, run it with --live <our adapter> --rpc <HyperEVM rpc> too.
//
// What may differ, and nothing else:
//   - the immutables (FACTORY, TOKEN_JAR): zeroed at the offsets solc reports for them;
//   - the trailing CBOR metadata (it hashes source file PATHS, which differ by design).
//
// --offline (what CI runs: no RPC to depend on) compares against the sha256 of Uniswap's live
// adapter with the same masking, read 2026-11-20 from 0xf2371551Fe3937Db7c750f4DfABe5c2fFFdcBf5A:
// rerun without --offline to re-derive it from the chain.
// Needs `forge build` in contracts/hyperevm first. Node builtins only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UNISWAP_LIVE_MASKED_SHA256 = '9d435a24f9ecbd914d6af89625762425825155a451426eebb80b36d01c06aa86';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, '..', 'out', 'V3OpenFeeAdapter.sol', 'V3OpenFeeAdapter.json');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const LIVE = arg('--live', '0xf2371551Fe3937Db7c750f4DfABe5c2fFFdcBf5A');
const RPC = arg('--rpc', 'https://eth.drpc.org');

function stripMetadata(buf) {
  const len = buf.readUInt16BE(buf.length - 2);
  return buf.subarray(0, buf.length - 2 - len);
}

function zeroImmutables(buf, refs) {
  const out = Buffer.from(buf);
  for (const list of Object.values(refs)) for (const { start, length } of list) out.fill(0, start, start + length);
  return out;
}

if (!fs.existsSync(ART)) {
  console.error(`missing ${ART}: run \`forge build\` in contracts/hyperevm first`);
  process.exit(2);
}
const art = JSON.parse(fs.readFileSync(ART, 'utf8'));
const refs = art.deployedBytecode.immutableReferences || {};
const ours = Buffer.from(art.deployedBytecode.object.replace(/^0x/, ''), 'hex');

if (process.argv.includes('--offline')) {
  const h = crypto.createHash('sha256').update(stripMetadata(zeroImmutables(ours, refs))).digest('hex');
  if (h === UNISWAP_LIVE_MASKED_SHA256) {
    console.log("✅ V3OpenFeeAdapter: matches Uniswap's live Ethereum adapter (pinned fingerprint, immutables + metadata masked)");
  } else {
    console.error(`❌ V3OpenFeeAdapter does NOT match Uniswap's live adapter: ${h} != ${UNISWAP_LIVE_MASKED_SHA256}`);
    process.exitCode = 1;
  }
  process.exit();
}

const res = await fetch(RPC, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [LIVE, 'latest'] }),
});
const j = await res.json();
if (!j.result || j.result === '0x') {
  console.error(`no code at ${LIVE} on ${RPC}: ${JSON.stringify(j.error || j.result)}`);
  process.exit(2);
}
const live = Buffer.from(j.result.slice(2), 'hex');

const a = stripMetadata(zeroImmutables(ours, refs));
const b = stripMetadata(zeroImmutables(live, refs));
const nImm = Object.values(refs).reduce((n, l) => n + l.length, 0);
console.log(`ours ${ours.length} B, live ${live.length} B, ${nImm} immutable slot(s) masked`);
if (a.equals(b)) {
  console.log(`✅ V3OpenFeeAdapter: byte-identical to ${LIVE} (apart from immutables + metadata)`);
} else {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  console.error(`❌ V3OpenFeeAdapter DIFFERS from ${LIVE}: first difference at byte ${i} (lengths ${a.length} vs ${b.length})`);
  process.exitCode = 1;
}
