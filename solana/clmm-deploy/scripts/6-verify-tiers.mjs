#!/usr/bin/env node
// CHECK THE FEE TIER, after the vault proposal executed. READ-ONLY. It also lists every fee tier the
// program owns: one this pack does not make (the cancelled #19's 0.25%, say) is refused.
//
//   node 6-verify-tiers.mjs [--rpc <url>]
import { CFG, args, connect, cluster, rpcFor, read, Report, main, web3 } from './lib/pack.mjs';
import { makeCore } from './lib/tiers.mjs';

await main(async () => {
  const a = args();
  a.known(['--rpc']);
  const conn = connect(rpcFor(a));
  const c = await cluster(conn, ['mainnet', 'local']);
  const R = new Report(`CHECK THE FEE TIER, on ${c.words}\nRead-only: nothing is sent.\n`);
  const core = makeCore({ web3, cfg: CFG });
  for (const t of await read('the fee tiers', () => core.tiers(conn))) {
    const w = t.want;
    const words = `${w.tradeFeeRate / 10000}% of each swap, price steps (tick spacing) ${w.tickSpacing}: of each fee ${(1e6 - w.protocolFeeRate - w.fundFeeRate) / 1e4}% stays with the LPs, ${w.protocolFeeRate / 1e4}% to the vault, ${w.fundFeeRate / 1e4}% to the Workshop`;
    if (t.state === 'exact') R.pass(`tier ${w.index} (${core.ammConfig(w.index).toBase58()}): ${words}; owner the vault, fund owner the Workshop ${CFG.addr.workshop}`);
    else if (t.state === 'absent') R.refuse(`tier ${w.index} does not exist yet: the vault proposal has not executed`);
    else R.refuse(`tier ${w.index} exists with OTHER values: ${JSON.stringify(t.got)}. Stop and ask`);
  }
  const decided = new Set(CFG.tiers.map((t) => core.ammConfig(t.index).toBase58()));
  const owned = await read('every fee tier the program owns', () => conn.getProgramAccounts(new web3.PublicKey(CFG.programId), { commitment: 'confirmed', filters: [{ dataSize: 117 }] }));
  const other = owned.map((x) => ({ at: x.pubkey.toBase58(), t: core.decodeTier(x.account.data) })).filter((x) => x.t && !decided.has(x.at));
  for (const x of other) R.refuse(`a fee tier this pack does not make exists: index ${x.t.index}, ${x.t.tradeFeeRate / 10000}% of each swap (${x.at}). It cannot be removed. Stop and ask`);
  if (!other.length) R.pass(`the program owns no other fee tier (${owned.length} account${owned.length === 1 ? '' : 's'} of a tier's size)`);
  return R.end('the fee tier is live with the island split, and it is the only one. Anyone may now open a range pool on it.', 'Do what the REFUSED line says.');
});
