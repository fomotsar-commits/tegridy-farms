#!/usr/bin/env node
// CHECK THE FEE TIERS, after the vault proposal executed. READ-ONLY.
//
//   node 6-verify-tiers.mjs [--rpc <url>]
import { CFG, args, connect, cluster, rpcFor, read, Report, main, web3 } from './lib/pack.mjs';
import { makeCore } from './lib/tiers.mjs';

await main(async () => {
  const a = args();
  a.known(['--rpc']);
  const conn = connect(rpcFor(a));
  const c = await cluster(conn, ['mainnet', 'local']);
  const R = new Report(`CHECK THE FEE TIERS, on ${c.words}\nRead-only: nothing is sent.\n`);
  const core = makeCore({ web3, cfg: CFG });
  for (const t of await read('the fee tiers', () => core.tiers(conn))) {
    const w = t.want;
    const words = `${w.tradeFeeRate / 10000}% of each swap, price steps (tick spacing) ${w.tickSpacing}: of each fee ${(1e6 - w.protocolFeeRate - w.fundFeeRate) / 1e4}% stays with the LPs, ${w.protocolFeeRate / 1e4}% to the vault, ${w.fundFeeRate / 1e4}% to the Workshop`;
    if (t.state === 'exact') R.pass(`tier ${w.index} (${core.ammConfig(w.index).toBase58()}): ${words}; owner the vault, fund owner the Workshop ${CFG.addr.workshop}`);
    else if (t.state === 'absent') R.refuse(`tier ${w.index} does not exist yet: the vault proposal has not executed`);
    else R.refuse(`tier ${w.index} exists with OTHER values: ${JSON.stringify(t.got)}. Stop and ask`);
  }
  return R.end('both fee tiers are live with the island split. Anyone may now open a range pool on them.', 'Do what the REFUSED line says.');
});
