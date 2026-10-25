#!/usr/bin/env node
// CHECK THE PROGRAM, after the deploy. READ-ONLY: it reads the program back from the chain, and asks
// the network to work out (without sending) a fee tier made by someone who is not the vault: that
// must be refused, which shows the program's admin really is the vault.
//
//   node 4-verify-program.mjs [--rpc <url>]
import path from 'node:path';
import { CFG, PACK, args, connect, cluster, rpcFor, read, Report, main, Stopped, checkBinary, readProgram, sameAsBuild, PROGRAMDATA_HEADER, num, web3 } from './lib/pack.mjs';
import { makeCore } from './lib/tiers.mjs';

await main(async () => {
  const a = args();
  a.known(['--rpc']);
  if (!CFG.programId) throw new Stopped('this pack was staged before the program key existed.');
  const conn = connect(rpcFor(a));
  const c = await cluster(conn);
  const R = new Report(`CHECK THE PROGRAM, on ${c.words}\nRead-only: nothing is sent.\n`);
  const build = checkBinary(R);
  const p = await readProgram(conn);
  if (!R.check(!!p && !p.foreign && !p.noData, `${CFG.programId} is a program of the upgradeable loader`, `${CFG.programId} is ${p ? 'not a deployed program of the upgradeable loader' : 'not deployed on this network'}`)) return R.end('', 'The deploy has not happened (or not here).');
  R.check(p.executable, 'it is executable', 'it is not marked executable');
  const same = sameAsBuild(p.body, build);
  R.check(same.same, `its code is ${same.why}`, `its code is NOT the reviewed build: ${same.why}. Stop and ask`);
  R.check(p.dataBytes === PROGRAMDATA_HEADER + build.length, `exact size: ${num(p.dataBytes)} bytes, no spare room (a future larger build first needs an enlarge)`, `its data account is ${num(p.dataBytes)} bytes, not the exact ${num(PROGRAMDATA_HEADER + build.length)}`);
  R.check(p.authority === CFG.addr.vault, `its upgrade authority is the vault ${CFG.addr.vault}`, `its upgrade authority is ${p.authority ?? 'NONE'}, not the vault. ${p.authority === CFG.addr.deployWallet ? `Run now: node "${path.join(PACK, 'scripts', '3-deploy.mjs')}" --handover-only --send` : 'Stop and ask'}`);
  R.note(`last deployed in slot ${num(p.deploySlot)}`);

  // The admin, asked of the program itself: the network works out (sends nothing, checks no
  // signature) the fee tier made by the vault, which must work, and by a stranger (the paying
  // wallet), which must be refused. Only while that tier does not exist yet.
  const core = makeCore({ web3, cfg: CFG });
  const t = await read('the fee tiers', () => core.tiers(conn));
  if (t[0].state === 'absent') {
    // On devnet the vault's address holds no SOL to pay the tier's rent, so only the refusal shows.
    if (c.kind === 'devnet') R.note('on devnet the vault\'s address holds no SOL, so the vault\'s own fee tier is worked out only on mainnet');
    else {
      const asVault = await read('the network working out a fee tier made by the vault', () => core.simulate(conn, CFG.addr.vault, [core.tierIxs()[0]]));
      R.check(asVault.ok, 'the vault may make a fee tier: the program\'s admin is the vault', `a fee tier made by the vault would NOT work (${JSON.stringify(asVault.err)} ${asVault.logs.slice(-2).join(' | ')}). Stop and ask`);
    }
    const ix = core.tierIxs()[0];
    ix.keys[0] = { pubkey: new web3.PublicKey(CFG.addr.deployWallet), isSigner: true, isWritable: true };
    const sim = await read('the network working out a fee tier made by a stranger', () => core.simulate(conn, CFG.addr.deployWallet, [ix]));
    const refusedByProgram = !sim.ok && sim.logs.some((l) => /Error Code: NotApproved/.test(l));
    R.check(refusedByProgram, 'a fee tier asked for by someone who is not the vault is refused by the program (NotApproved): only the vault can make one', `a stranger's fee tier was NOT refused as expected (${sim.ok ? 'it would succeed' : JSON.stringify(sim.err)}). Stop and ask`);
  } else R.note('the fee tier exists, so the admin is read from it: its owner must be the vault (below)');
  for (const x of t) R.note(`fee tier ${x.want.index} (${x.want.tradeFeeRate / 10000}%, spacing ${x.want.tickSpacing}): ${x.state === 'absent' ? 'not made yet (the vault proposal makes it)' : x.state === 'exact' ? 'made, exactly as decided' : 'EXISTS WITH OTHER VALUES: stop and ask'}`);
  if (t.some((x) => x.state === 'wrong')) R.refuse('a fee tier exists with values other than the decided ones');
  return R.end('the program is live, byte for byte the reviewed build, and only the vault can change it.', 'Do what the REFUSED line says.');
});
