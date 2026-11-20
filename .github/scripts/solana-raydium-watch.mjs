#!/usr/bin/env node
// Run weekly by raydium-watch.yml, from the repo root. Red when Raydium has re-deployed either
// program the venue's pools copy, or its repository has moved past the head recorded below.
// A read that cannot be made is red too, never a quiet pass. Once a change upstream is read,
// record the new slot or head here; the pins themselves live in solana/guards/provenance.mjs.
import { spawnSync } from 'node:child_process';
import { COPIES } from '../../solana/guards/provenance.mjs';

const RPC = 'https://api.mainnet-beta.solana.com';
// Each program's last-deployed slot, read 2026-11-15, and the last commit of its repository
// that has been read: the pin, until someone reads what came after it.
const KNOWN = {
  'cp-swap': { program: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', slot: 463522946, head: '78f254e1023751e706df7dc15c453fc3e046697c' },
  'tegridy-clmm': { program: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', slot: 459932378, head: 'ed1eb41519d5355755f7df52b43fa9610938b60b' },
};

let calls = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (calls++) await new Promise((r) => setTimeout(r, 2500)); // the public endpoint's pace
    try {
      const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const body = await res.json();
      if (body.result?.value) return body.result.value;
    } catch {
      // tried again below
    }
  }
  throw new Error(`${method} ${params[0]} could not be read from ${RPC}`);
}

// The slot a program was last deployed at: the u64 after the 4-byte tag of its ProgramData.
async function lastDeployed(program) {
  const programData = (await rpc('getAccountInfo', [program, { encoding: 'jsonParsed' }])).data?.parsed?.info?.programData;
  if (!programData) throw new Error(`${program} names no ProgramData account`);
  const data = await rpc('getAccountInfo', [programData, { encoding: 'base64', dataSlice: { offset: 4, length: 8 } }]);
  return Number(Buffer.from(data.data[0], 'base64').readBigUInt64LE(0));
}

const problems = [];
for (const [name, known] of Object.entries(KNOWN)) {
  const { repo, commit } = COPIES[name];
  try {
    const slot = await lastDeployed(known.program);
    if (slot !== known.slot) problems.push(`${name}: ${known.program} was re-deployed at slot ${slot} (known: ${known.slot})`);
    else console.log(`${name}: ${known.program} last deployed at slot ${slot}, as known`);
  } catch (e) {
    problems.push(`${name}: ${e.message}`);
  }
  const ls = spawnSync('git', ['ls-remote', repo, 'HEAD'], { encoding: 'utf-8' });
  const head = /^([0-9a-f]{40})\tHEAD$/m.exec(ls.stdout ?? '')?.[1];
  if (!head) problems.push(`${name}: the head of ${repo} could not be read`);
  else if (head !== known.head) problems.push(`${name}: ${repo} moved to ${head}; read ${repo}/compare/${known.head}...${head} (the pin is ${commit})`);
  else console.log(`${name}: ${repo} is at ${head}, as known (the pin is ${commit})`);
}

for (const p of problems) console.log(`::error::${p}`);
process.exit(problems.length ? 1 : 0);
