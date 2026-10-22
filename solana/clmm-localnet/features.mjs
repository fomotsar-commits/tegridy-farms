// Step 2b: make the local chain's runtime features match mainnet's. Lists the features the
// running local validator knows, reads each one's account on mainnet (read-only), and writes
// the ones mainnet has NOT activated to deactivate-features.txt for the next validator start.
// usage: node features.mjs   (with the local validator running)
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORK, MAINNET_RPC, RPC } from './lib/config.mjs';

const local = JSON.parse(execFileSync('wsl', ['-e', 'bash', '-lc', `solana feature status -u ${RPC} --output json`]).toString()).features;
const ids = local.map((f) => f.id);
const off = [];
for (let i = 0; i < ids.length; i += 100) {
  const batch = ids.slice(i, i + 100);
  const r = await fetch(MAINNET_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [batch, { encoding: 'base64', commitment: 'finalized' }] }) }).then((x) => x.json());
  if (!r.result) throw new Error('mainnet read failed: ' + JSON.stringify(r.error));
  r.result.value.forEach((a, j) => {
    // Feature { activated_at: Option<u64> }: tag byte 1 means active.
    const active = a && Buffer.from(a.data[0], 'base64')[0] === 1;
    if (!active) off.push(batch[j]);
  });
}
writeFileSync(join(WORK, 'deactivate-features.txt'), off.join('\n') + '\n');
const byId = Object.fromEntries(local.map((f) => [f.id, f.description]));
console.log(`${local.length} features known locally; ${off.length} not active on mainnet, deactivated next start:`);
for (const id of off) console.log(' ', id, byId[id]);
