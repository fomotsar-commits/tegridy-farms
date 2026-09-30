// Before any browser opens: is the thing we are about to test against the thing we think?
// Each check fails the whole run with the reason; none of them is allowed to skip.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLaunchEconomics } from '../src/lib/launcher/solana/curve/config';
import { globalPda } from '../src/lib/launcher/solana/curve/program';
import { deriveAmmConfig } from '../src/lib/solana/cpswap/program';
import { LOCALNET_RPC, LAUNCH_PROGRAM, CP_SWAP_PROGRAM, assertLocalCluster, chain, deployment, globalConfig } from './fixtures/chain';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default async function globalSetup(): Promise<void> {
  // 1. Reachable from Windows (WSL localhost forwarding) and healthy.
  let health: unknown;
  try {
    const res = await fetch(LOCALNET_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) });
    health = ((await res.json()) as { result?: unknown }).result;
  } catch (e) {
    throw new Error(`no validator at ${LOCALNET_RPC} (${(e as Error).message}). Start scripts/solana-localnet/start-validator.sh in WSL first.`, { cause: e });
  }
  if (health !== 'ok') throw new Error(`validator at ${LOCALNET_RPC} is not healthy: ${JSON.stringify(health)}`);

  // 2. Private cluster only.
  const genesis = await assertLocalCluster();

  // 3. Both programs deployed (the frontend's own readDeployment follows ProgramData).
  for (const [label, id] of [['tegridy-launch', LAUNCH_PROGRAM], ['cp-swap', CP_SWAP_PROGRAM]] as const) {
    const d = await deployment(id);
    if (d.kind !== 'deployed') throw new Error(`${label} ${id.toBase58()} is ${JSON.stringify(d)}`);
  }

  // 4. The GlobalConfig on chain is byte-for-byte the one genesis-accounts.mjs wrote
  //    (whose encoder is itself checked against the rehearsal ledger), and it passes
  //    the program's own economics rule.
  const seeded = path.join(HERE, '..', 'scripts', 'solana-localnet', '.accounts', 'global.json');
  if (!fs.existsSync(seeded)) throw new Error(`${seeded} is missing: run node scripts/solana-localnet/genesis-accounts.mjs`);
  const want = Buffer.from(JSON.parse(fs.readFileSync(seeded, 'utf8')).account.data[0], 'base64');
  const got = (await chain().getAccountInfo(globalPda(LAUNCH_PROGRAM), 'confirmed'))?.data;
  if (!got || !Buffer.from(got).equals(want)) throw new Error('the validator\'s GlobalConfig is not the seeded one: restart start-validator.sh after genesis-accounts.mjs');
  // Fee tier 1 (the public tier the vault is proposing), seeded as the stand-in for that
  // Squads proposal: the LP specs open pools on it and pay its 0.15 SOL create fee.
  const seeded1 = path.join(HERE, '..', 'scripts', 'solana-localnet', '.accounts', 'amm-config-1.json');
  if (!fs.existsSync(seeded1)) throw new Error(`${seeded1} is missing: run node scripts/solana-localnet/genesis-accounts.mjs`);
  const want1 = Buffer.from(JSON.parse(fs.readFileSync(seeded1, 'utf8')).account.data[0], 'base64');
  const got1 = (await chain().getAccountInfo(deriveAmmConfig(CP_SWAP_PROGRAM, 1), 'confirmed'))?.data;
  if (!got1 || !Buffer.from(got1).equals(want1)) throw new Error('the validator\'s AmmConfig index 1 is not the seeded one: restart start-validator.sh after genesis-accounts.mjs');
  const g = await globalConfig();
  const report = checkLaunchEconomics({
    tradeFeeBps: g.tradeFeeBps,
    initialVirtualSol: g.initialVirtualSol,
    initialVirtualToken: g.initialVirtualToken,
    tokenTotalSupply: g.tokenTotalSupply,
    graduationTargetLamports: g.graduationTargetLamports,
    migrationReserveLamports: g.migrationReserveLamports,
    platformReserveBps: g.platformReserveBps,
  });
  if (report.problems.length) throw new Error(`the seeded GlobalConfig fails checkLaunchEconomics: ${report.problems.join('; ')}`);

  // 5. The RPC guard will use production's rule, not a copy.
  const proxy = (await import(new URL('../api/solrpc.js', import.meta.url).href)) as { isAllowedRpcCall?: unknown };
  if (typeof proxy.isAllowedRpcCall !== 'function') throw new Error('api/solrpc.js does not export isAllowedRpcCall');

  console.log(`[solana e2e] ${LOCALNET_RPC} healthy · genesis ${genesis} (private) · both programs deployed · global and fee tier 1 = seeded bytes · economics ok`);
}
