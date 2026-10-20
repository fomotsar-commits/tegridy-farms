#!/usr/bin/env node
// CHECK THE UPLOAD. READ-ONLY. The buffer must hold, byte for byte, the one program file of this
// pack, and only the paying wallet may use it. The deploy (step 3) checks all of it again.
//
//   node 2-verify-buffer.mjs --buffer <BUFFER ADDRESS> [--rpc <url>]
import { CFG, args, address, connect, cluster, rpcFor, Report, main, Stopped, checkBinary, readBuffer, BUFFER_HEADER, sol, num } from './lib/pack.mjs';

export async function checkBuffer(conn, R, buf, build) {
  const b = await readBuffer(conn, buf);
  if (!R.check(!!b && !b.foreign, `${buf} is a buffer of the upgradeable loader`, `${buf} is ${b ? `not a loader buffer (owner ${b.owner})` : 'not on this network'}`)) return null;
  if (b.body.length !== build.length) R.refuse(`the buffer is ${num(b.bytes)} bytes; this build needs exactly ${num(BUFFER_HEADER + build.length)}. It was made for another file: do not deploy from it`);
  else if (b.body.equals(build)) R.pass(`the buffer holds ${num(build.length)} bytes, byte for byte the reviewed build (sha256 ${CFG.binary.sha256})`);
  else {
    let unfinished = true;
    for (let i = 0; i < build.length; i++) if (b.body[i] !== build[i] && b.body[i] !== 0) { unfinished = false; break; }
    R.refuse(unfinished
      ? 'THE UPLOAD IS NOT FINISHED: parts of the buffer are still empty. Run the upload command again with the same buffer key file, then this check again'
      : 'the buffer holds bytes that are NOT the reviewed build. Run the upload again (it rewrites every part that differs), then this check again');
  }
  R.check(b.authority === CFG.addr.deployWallet, `its authority is the paying wallet ${CFG.addr.deployWallet}: nobody else can use or close it`, `its authority is ${b.authority ?? 'NONE'}, not the paying wallet. Do not deploy from it`);
  R.note(`it holds ${sol(b.lamports)}; the deploy moves it into the program`);
  return b;
}

if (process.argv[1]?.endsWith('2-verify-buffer.mjs')) await main(async () => {
  const a = args();
  a.known(['--buffer', '--rpc']);
  if (!a.get('--buffer')) throw new Stopped('give the buffer: --buffer <BUFFER ADDRESS> (the address the buffer key file printed when you made it)');
  const buf = address(a.get('--buffer'), 'the buffer');
  const conn = connect(rpcFor(a));
  const c = await cluster(conn);
  const R = new Report(`CHECK THE UPLOAD, on ${c.words}\nRead-only: nothing is sent.\n`);
  const build = checkBinary(R);
  if (build) await checkBuffer(conn, R, buf, build);
  return R.end('every line passed. This buffer may be deployed.', 'Do not deploy from this buffer. Do what the REFUSED line says.');
});
