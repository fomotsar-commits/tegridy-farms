#!/usr/bin/env node
// CHECK THE FEE CHANGE, after the vault proposal executed. READ-ONLY.
//
//   node 8-verify-tier-fee.mjs [--rpc <url>]
import { CFG, args, connect, cluster, rpcFor, read, Report, main, web3 } from './lib/pack.mjs';
import { makeCore } from './lib/tiers.mjs';
import { tierAfter } from './lib/tierFee.mjs';

await main(async () => {
  const a = args();
  a.known(['--rpc']);
  if (!CFG.change) throw new Error('this folder sets no fee: it is not a fee-change folder');
  const conn = connect(rpcFor(a));
  const c = await cluster(conn, ['mainnet', 'local']);
  const R = new Report(`CHECK THE FEE CHANGE, on ${c.words}\nRead-only: nothing is sent.\n`);
  const core = makeCore({ web3, cfg: CFG });
  const pct = (r) => `${r / 10000}%`;
  const split = (w) => `of each fee ${(1e6 - w.protocolFeeRate - w.fundFeeRate) / 1e4}% stays with the LPs, ${w.protocolFeeRate / 1e4}% to the vault, ${w.fundFeeRate / 1e4}% to the Workshop`;
  for (const t of await read('the fee tiers', () => core.tiers(conn))) {
    const w = t.want;
    const at = `tier ${w.index} (${core.ammConfig(w.index).toBase58()})`;
    if (w.index === CFG.change.index) {
      if (tierAfter(CFG, t)) R.pass(`${at}: ${pct(CFG.change.to)} of each swap, price steps (tick spacing) ${w.tickSpacing}: ${split(w)}; owner the vault, fund owner the Workshop ${CFG.addr.workshop}`);
      else if (t.state === 'exact') R.refuse(`${at} still charges ${pct(CFG.change.from)}: the vault proposal has not executed`);
      else R.refuse(`${at} reads ${t.state === 'absent' ? 'as not existing' : `OTHER values: ${JSON.stringify(t.got)}`}. Stop and ask`);
    } else if (t.state === 'exact') R.pass(`${at}: ${pct(w.tradeFeeRate)} of each swap, price steps ${w.tickSpacing}, unchanged`);
    else R.refuse(`${at} is not as made: ${JSON.stringify(t.got ?? t.state)}. Stop and ask`);
  }
  return R.end(`tier ${CFG.change.index} charges ${pct(CFG.change.to)} now, with the same split and owners, and the other tier is unchanged.`, 'Do what the REFUSED line says.');
});
