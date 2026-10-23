#!/usr/bin/env node
// TAKE AN UPLOAD BUFFER'S SOL BACK, only if the deploy is given up. The paying wallet still holds
// the buffer (this pack never hands a buffer to the vault), so it closes it alone. Pinned to this
// pack's own build: the buffer must be exactly this build's size and hold this build, or an
// unfinished upload of it. The paying wallet also runs the pool pack, whose buffers are refused.
//
//   node 7-close-buffer.mjs --buffer <BUFFER ADDRESS>           (a dry run)
//   node 7-close-buffer.mjs --buffer <BUFFER ADDRESS> --send
import { spawnSync } from 'node:child_process';
import { CFG, args, address, addressOfKeyFile, connect, cluster, rpcFor, balance, Report, main, Stopped, checkBinary, readBuffer, BUFFER_HEADER, sol, num, sleep } from './lib/pack.mjs';

await main(async () => {
  const a = args();
  a.known(['--buffer', '--send', '--rpc']);
  if (!a.get('--buffer')) throw new Stopped('give the buffer: --buffer <BUFFER ADDRESS>');
  const buf = address(a.get('--buffer'), 'the buffer');
  const rpc = rpcFor(a);
  const conn = connect(rpc);
  const c = await cluster(conn);
  const send = a.has('--send');
  const R = new Report(`TAKE A BUFFER'S SOL BACK, on ${c.words}${send ? '' : '\nA DRY RUN: nothing will be sent (add --send to close it).'}\n`);
  const build = checkBinary(R);
  R.check(addressOfKeyFile(CFG.keyFiles.payer) === CFG.addr.deployWallet, `the paying wallet's key file is ${CFG.keyFiles.payer}`, `${CFG.keyFiles.payer} is not the paying wallet ${CFG.addr.deployWallet}`);
  const b = await readBuffer(conn, buf);
  if (!R.check(!!b && !b.foreign, `${buf} is a buffer of the upgradeable loader`, `${buf} is ${b ? `not a loader buffer (owner ${b.owner})` : 'not on this network (already closed, or used by the deploy)'}`) || !build) return R.end('', 'Nothing was sent.');
  R.check(b.authority === CFG.addr.deployWallet, `its authority is the paying wallet: the SOL goes back to ${CFG.addr.deployWallet}`, `its authority is ${b.authority ?? 'NONE'}, not the paying wallet. This step closes only the paying wallet's own buffer`);
  const sameSize = b.body.length === build.length;
  let mine = sameSize;
  for (let i = 0; mine && i < build.length; i++) if (b.body[i] !== build[i] && b.body[i] !== 0) mine = false;
  R.check(mine, `it is this pack's buffer: ${num(BUFFER_HEADER + build.length)} bytes, holding this build${b.body.equals(build) ? '' : ' (an unfinished upload of it)'}`,
    sameSize ? 'it is this build\'s size but holds other bytes: it is not this pack\'s upload. Nothing was sent. Stop and ask' : `it is ${num(b.bytes)} bytes, not this build's ${num(BUFFER_HEADER + build.length)}: another pack's buffer (perhaps the pool pack's). Nothing was sent`);
  if (!R.ok) return R.end('', 'Nothing was sent.');
  R.note(`it holds ${sol(b.lamports)}`);
  const cmd = ['program', 'close', buf, '--authority', CFG.keyFiles.payer, '--recipient', CFG.addr.deployWallet, '--keypair', CFG.keyFiles.payer, '--url', rpc];
  if (!send) { console.log(`\nIt would run: solana.exe ${cmd.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}`); return R.end('the dry run passed. Run the same command with --send to take the SOL back.', 'Nothing was sent.'); }
  const before = await balance(conn, CFG.addr.deployWallet);
  console.log(`\nrunning, once:  solana.exe ${cmd.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}`);
  const r = spawnSync(CFG.solanaExe, cmd, { encoding: 'utf8', maxBuffer: 16 << 20 });
  process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
  let gone = false;
  for (let i = 0; i < 20 && !(gone = !(await readBuffer(conn, buf))); i++) await sleep(3000);
  const after = await balance(conn, CFG.addr.deployWallet);
  R.check(gone, `CLOSED: the paying wallet got ${sol(after - before)} back (it holds ${sol(after)})`, `the buffer is still there (the command ${r.status === 0 ? 'said it worked' : 'failed'}). Run this step again in a minute`);
  return R.end('the buffer is closed and its SOL is back in the paying wallet.', 'Run it again in a minute.');
});
