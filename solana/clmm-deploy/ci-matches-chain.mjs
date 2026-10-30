#!/usr/bin/env node
// After the deploy, once the program-id change is merged: does the repo's own CI build the very
// bytes now on chain? READ-ONLY. It takes the release build CI kept from a push to mvp-launch
// (solana-ci.yml, artifact tegridy-clmm-release), reads that commit's lib.rs for the program id,
// and compares the build with the program's data on mainnet, byte for byte.
//
//   node solana/clmm-deploy/ci-matches-chain.mjs --run <CI run id> [--rpc <url>]
// Exit 0: the same bytes. 1: they differ, or the run is not one to trust. 3: something could not be read.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const RPC = opt('--rpc') ?? 'https://api.mainnet-beta.solana.com';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf-8', maxBuffer: 64 << 20 });
const out = (code, m) => { console.log(`RESULT: ${m}`); process.exit(code); };
const run = opt('--run');
if (!/^\d+$/.test(run ?? '')) out(1, 'give the CI run: --run <the id of the solana-ci run of the merge to mvp-launch>');

let meta;
try { meta = JSON.parse(sh('gh', ['run', 'view', run, '--json', 'event,headBranch,headSha,conclusion,workflowName'])); } catch (e) { out(3, `the run could not be read (${e.message.split('\n')[0]})`); }
console.log(`run ${run}: ${meta.workflowName}, ${meta.event} to ${meta.headBranch} at ${meta.headSha}, ${meta.conclusion}`);
if (meta.event !== 'push' || meta.headBranch !== 'mvp-launch' || meta.conclusion !== 'success') out(1, 'only a successful push run of mvp-launch is trusted (not a pull request\'s, not a fork\'s)');

sh('git', ['fetch', '--quiet', 'origin', 'mvp-launch']);
const lib = sh('git', ['show', `${meta.headSha}:solana/tegridy-clmm/programs/amm/src/lib.rs`]).replace(/\r/g, '');
const id = /#\[cfg\(not\(feature = "devnet"\)\)\]\ndeclare_id!\("(\w+)"\);/.exec(lib)?.[1];
if (!id || id.startsWith('RangePoo1')) out(1, `that commit's lib.rs declares ${id ?? 'no id'}, not the venue's program id`);

const dir = mkdtempSync(join(tmpdir(), 'clmm-ci-'));
try {
  try { sh('gh', ['run', 'download', run, '-n', 'tegridy-clmm-release', '-D', dir]); } catch (e) { out(3, `the release build could not be downloaded (${e.message.split('\n')[0]})`); }
  const files = readdirSync(dir).filter((f) => f.endsWith('.so'));
  if (files.length !== 1) out(1, `the artifact holds ${files.length} program files, not one`);
  const build = readFileSync(join(dir, files[0]));
  console.log(`CI's build: ${build.length.toLocaleString('en-US')} bytes, sha256 ${sha(build)}`);

  const rpc = async (method, params) => { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result; };
  let prog; let data;
  try {
    prog = (await rpc('getAccountInfo', [id, { encoding: 'base64', commitment: 'confirmed' }])).value;
    if (!prog || prog.owner !== LOADER) out(1, `${id} is not a program of the upgradeable loader on this network`);
    const pd = Buffer.from(prog.data[0], 'base64');
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = BigInt('0x' + pd.subarray(4, 36).toString('hex')); let s = '';
    while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const x of pd.subarray(4, 36)) { if (x !== 0) break; s = '1' + s; }
    data = Buffer.from((await rpc('getAccountInfo', [s, { encoding: 'base64', commitment: 'confirmed' }])).value.data[0], 'base64');
  } catch (e) { out(3, `the program could not be read (${e.message})`); }
  const body = data.subarray(45);
  const code = body.subarray(0, build.length);
  console.log(`on chain: ${body.length.toLocaleString('en-US')} bytes of program data, the first ${build.length.toLocaleString('en-US')} hash to ${sha(code)}`);
  const same = code.equals(build) && body.subarray(build.length).every((x) => x === 0);
  out(same ? 0 : 1, same ? `the same bytes: CI's build of ${meta.headSha} is the program on chain at ${id}.` : 'THEY DIFFER: the program on chain is not CI\'s build of that commit. Do not propose the fee tiers: stop and ask.');
} finally { rmSync(dir, { recursive: true, force: true }); }
