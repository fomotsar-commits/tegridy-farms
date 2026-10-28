#!/usr/bin/env node
// Rebuilds Gondi's contracts from the verified source in this folder and checks the
// result. Nothing here is ours: the sources and settings are Gondi's, exactly as
// verified on Sourcify for their mainnet deploys (see settings/*.json).
//
//   node build.mjs                     compile, compare with build/*.json (exit 1 on drift)
//   node build.mjs --write             compile and (re)write build/*.json
//   node build.mjs --mainnet <rpc>     also compare with Gondi's own mainnet deploys:
//                                      creation code vs their deploy tx input, runtime vs
//                                      their live code (immutable slots masked)
//
// Needs the exact solc each contract was built with (0.8.19, 0.8.21, 0.8.25). Foundry
// installs one with `forge build --use <version>` in any project; or point
// SOLC_<major>_<minor>_<patch> (e.g. SOLC_0_8_25) at a binary.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const rpcAt = args.indexOf('--mainnet');
const RPC = rpcAt >= 0 ? args[rpcAt + 1] : null;

function solcPath(version) {
  const env = process.env[`SOLC_${version.replaceAll('.', '_')}`];
  if (env) return env;
  const dirs = [join(homedir(), '.svm', version), join(process.env.APPDATA || '', 'svm', version)];
  for (const d of dirs) {
    for (const f of [`solc-${version}`, `solc-${version}.exe`]) {
      if (existsSync(join(d, f))) return join(d, f);
    }
  }
  throw new Error(`solc ${version} not found. Install it with \`forge build --use ${version}\` or set SOLC_${version.replaceAll('.', '_')}.`);
}

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

function mask(code, immutableReferences) {
  let out = code;
  for (const refs of Object.values(immutableReferences || {})) {
    for (const { start, length } of refs) {
      out = out.slice(0, start * 2) + '0'.repeat(length * 2) + out.slice((start + length) * 2);
    }
  }
  return out;
}

let failed = false;
for (const file of readdirSync(join(HERE, 'settings')).filter((f) => f.endsWith('.json')).sort()) {
  const cfg = JSON.parse(readFileSync(join(HERE, 'settings', file), 'utf8'));
  const name = file.replace(/\.json$/, '');
  const [target, contractName] = cfg.contract.split(':');
  const version = cfg.compiler.split('+')[0];
  const sources = {};
  for (const p of cfg.files) sources[p] = { content: readFileSync(join(HERE, cfg.sourceTree, p), 'utf8') };
  const input = {
    language: cfg.language,
    sources,
    settings: { ...cfg.settings, outputSelection: { [target]: { [contractName]: ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } } },
  };
  const out = JSON.parse(execFileSync(solcPath(version), ['--standard-json'], { input: JSON.stringify(input), maxBuffer: 1 << 28 }).toString());
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(`${name}: ${errors[0].formattedMessage}`);
  const c = out.contracts[target][contractName];
  const built = {
    contract: cfg.contract,
    compiler: cfg.compiler,
    abi: c.abi,
    bytecode: `0x${c.evm.bytecode.object}`,
    deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
    immutableReferences: c.evm.deployedBytecode.immutableReferences,
  };
  const buildFile = join(HERE, 'build', `${name}.json`);
  if (WRITE) {
    mkdirSync(join(HERE, 'build'), { recursive: true });
    writeFileSync(buildFile, `${JSON.stringify(built, null, 2)}\n`);
    console.log(`${name}: wrote build/${name}.json (${(built.bytecode.length - 2) / 2} B creation, ${(built.deployedBytecode.length - 2) / 2} B runtime)`);
  } else {
    const committed = existsSync(buildFile) ? JSON.parse(readFileSync(buildFile, 'utf8')) : null;
    const same = committed && committed.bytecode === built.bytecode && committed.deployedBytecode === built.deployedBytecode && JSON.stringify(committed.abi) === JSON.stringify(built.abi);
    console.log(`${name}: build/${name}.json ${same ? 'matches the source' : 'DOES NOT match the source'}`);
    if (!same) failed = true;
  }
  if (RPC) {
    const creation = built.bytecode.slice(2).toLowerCase();
    for (const g of cfg.gondiMainnet) {
      const tx = await rpc('eth_getTransactionByHash', [g.deployTx]);
      const createdHere = tx.to === null && tx.input.slice(2).toLowerCase().startsWith(creation);
      const live = (await rpc('eth_getCode', [g.address, 'latest'])).slice(2).toLowerCase();
      const ours = built.deployedBytecode.slice(2).toLowerCase();
      const sameRuntime = mask(ours, built.immutableReferences) === mask(live, built.immutableReferences);
      console.log(`  Gondi ${g.address}: deploy tx ${createdHere ? 'starts with our creation code' : 'DIFFERS'}, live runtime ${sameRuntime ? 'identical (immutables masked)' : 'DIFFERS'}`);
      if (!createdHere || !sameRuntime) failed = true;
    }
  }
}
if (failed) process.exit(1);
