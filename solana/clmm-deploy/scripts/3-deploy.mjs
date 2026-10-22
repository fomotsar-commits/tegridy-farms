#!/usr/bin/env node
// THE DEPLOY, then at once THE HAND-OVER of the program to the vault. This is the only script of
// the folder that sends, and only with --send. It does not open a key file: it hands the paths to
// your Solana tool, which signs. It checks everything again first, runs in one window at a time,
// and once the deploy command has run it always tries the hand-over, whatever it could read back.
//
//   node 3-deploy.mjs --buffer <BUFFER ADDRESS>                 (a dry run: it only checks)
//   node 3-deploy.mjs --buffer <BUFFER ADDRESS> --send          (deploy + hand-over)
//   node 3-deploy.mjs --handover-only --send                    (only if the deploy went through and the hand-over did not)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CFG, PACK, args, address, addressOfKeyFile, isBuildToolKey, connect, cluster, rpcFor, account, balance, rent, Report, main, Stopped,
  checkBinary, readProgram, sameAsBuild, addressesFree, PROGRAMDATA_HEADER, num, sol, sleep, web3,
} from './lib/pack.mjs';
import { checkBuffer } from './2-verify-buffer.mjs';
import { makeCore } from './lib/tiers.mjs';

const LOCK = path.join(PACK, 'owner-run', 'deploy.lock');
const ME = path.join(PACK, 'scripts', '3-deploy.mjs');
const VERIFY = path.join(PACK, 'scripts', '4-verify-program.mjs');
const HANDOVER = `node "${ME}" --handover-only --send`;

function solana(cmd, rpc) {
  const full = [...cmd, '--url', rpc];
  console.log(`\nrunning, once:  solana.exe ${full.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}`);
  const r = spawnSync(CFG.solanaExe, full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  return r.status === 0;
}

await main(async () => {
  const a = args();
  a.known(['--buffer', '--send', '--handover-only', '--rpc']);
  if (!CFG.programId) throw new Stopped('this folder was staged before the program key existed');
  const send = a.has('--send');
  const handoverOnly = a.has('--handover-only');
  const rpc = rpcFor(a);
  const conn = connect(rpc);
  const c = await cluster(conn);
  const R = new Report(`THE DEPLOY AND THE HAND-OVER, on ${c.words}${send ? '' : '\nA DRY RUN: nothing will be sent (add --send to deploy).'}\n`);
  fs.mkdirSync(path.join(PACK, 'owner-run'), { recursive: true });

  const build = checkBinary(R);
  const payerKey = CFG.keyFiles.payer;
  const progKey = CFG.keyFiles.program;
  // The vault, worked out again from the multisig (vault 0): the hand-over goes nowhere else.
  makeCore({ web3, cfg: CFG });
  R.pass(`the hand-over goes to the vault ${CFG.addr.vault}, vault 0 of the multisig ${CFG.addr.multisig}`);
  R.check(addressOfKeyFile(payerKey) === CFG.addr.deployWallet, `the paying wallet's key file is ${payerKey}`, `${payerKey} is not the paying wallet ${CFG.addr.deployWallet}`);
  if (!handoverOnly) {
    R.check(!isBuildToolKey(progKey) && addressOfKeyFile(progKey) === CFG.programId, `the program key file ${progKey} is the address ${CFG.programId}`, `${progKey} is not the program key ${CFG.programId}. Do not deploy`);
    const noOld = await account(conn, CFG.features.noOldSbpf, 'the SIMD-0500 rule');
    R.check(!noOld, 'SIMD-0500 is not scheduled on this network', 'SIMD-0500 has an account on this network. Stop and ask');
  }
  if (!R.ok) return R.end('', 'Nothing was sent.');

  let p = await readProgram(conn);
  if (!handoverOnly) {
    if (p) {
      if (p.body && sameAsBuild(p.body, build).same) R.refuse(`the program is ALREADY deployed, byte for byte this build, with authority ${p.authority ?? 'NONE'}. Do not deploy again. ${p.authority === CFG.addr.deployWallet ? `The hand-over did not happen: run ${HANDOVER}` : `Go on to node "${VERIFY}"`}`);
      else R.refuse(`${CFG.programId} already has an account that is not this build (owner ${p.owner}). Stop and ask`);
      return R.end('', 'Nothing was sent.');
    }
    await addressesFree(conn, R, CFG.programId, c.kind);
    if (!a.get('--buffer')) throw new Stopped('give the buffer: --buffer <BUFFER ADDRESS>');
    const buf = address(a.get('--buffer'), 'the buffer');
    const b = await checkBuffer(conn, R, buf, build);
    if (!R.ok || !b) return R.end('', 'Nothing was sent. Do what the REFUSED line says.');
    const dataRent = await rent(conn, PROGRAMDATA_HEADER + build.length);
    const progRent = await rent(conn, 36);
    const need = progRent + (dataRent > b.lamports ? dataRent - b.lamports : 0n) + 1_000_000n;
    const have = await balance(conn, CFG.addr.deployWallet);
    if (!R.check(have >= need, `the paying wallet holds ${sol(have)}; the deploy needs ${sol(need)} more than the buffer already holds`, `the paying wallet holds ${sol(have)}; it needs ${sol(need)} for the deploy. Send it the difference`)) return R.end('', 'Nothing was sent.');
    if (!send) {
      console.log(`\nThe deploy would run: solana.exe program deploy --buffer ${buf} --program-id "${progKey}" --max-len ${build.length} --upgrade-authority "${payerKey}" --keypair "${payerKey}" --with-compute-unit-price ${CFG.cuPrice} --url ${rpc}`);
      console.log(`then: solana.exe program set-upgrade-authority ${CFG.programId} --new-upgrade-authority ${CFG.addr.vault} --skip-new-upgrade-authority-signer-check --upgrade-authority "${payerKey}" --keypair "${payerKey}" --url ${rpc}`);
      return R.end('the dry run passed. Run the same command with --send to deploy.', 'Nothing was sent.');
    }
    // One window at a time.
    try { fs.writeFileSync(LOCK, `${process.pid} ${new Date().toISOString()} ${c.kind}\n`, { flag: 'wx' }); } catch {
      R.refuse(`this step is ALREADY RUNNING in another window, or a run stopped half way (${LOCK} exists). Look at the other window. If none is open, run node "${VERIFY}": it says how far things are. Then ask a session before deleting that file`);
      return R.end('', 'Nothing was sent by this window.');
    }
    const ran = solana(['program', 'deploy', '--buffer', buf, '--program-id', progKey, '--max-len', String(build.length), '--upgrade-authority', payerKey, '--keypair', payerKey, '--with-compute-unit-price', String(CFG.cuPrice)], rpc);
    for (let i = 0; i < 20; i++) { try { p = await readProgram(conn); } catch { p = null; } if (p?.body) break; await sleep(3000); }
    if (!p?.body && !ran) {
      try { fs.unlinkSync(LOCK); } catch { /* gone already */ }
      R.refuse('the deploy command failed and no program is there: nothing landed. Read its message above, then ask a session');
      return R.end('', 'Nothing was deployed.');
    }
    if (p?.body) {
      const same = sameAsBuild(p.body, build);
      R.check(same.same, `DEPLOYED: the program's code is ${same.why}`, `the program's code is NOT the build: ${same.why}. Stop and ask`);
      R.check(p.dataBytes === PROGRAMDATA_HEADER + build.length, `exact size: the data account is ${num(p.dataBytes)} bytes, no spare room`, `the data account is ${num(p.dataBytes)} bytes, not ${num(PROGRAMDATA_HEADER + build.length)}`);
    } else R.unread('the deploy command said it worked, but the program could not be read back yet');
  } else {
    if (!p?.body || !sameAsBuild(p.body, build).same) { R.refuse('--handover-only: the program is not deployed with this build. Use the deploy command instead'); return R.end('', 'Nothing was sent.'); }
    if (p.authority === CFG.addr.vault) { R.pass('the vault ALREADY holds the upgrade authority: nothing to hand over'); return R.end(`the hand-over is done. Go on to node "${VERIFY}".`, ''); }
    if (!R.check(p.authority === CFG.addr.deployWallet, 'the paying wallet still holds the upgrade authority', `the upgrade authority is ${p.authority ?? 'NONE'}: neither the paying wallet nor the vault. Stop and ask`)) return R.end('', 'Nothing was sent.');
    if (!send) return R.end('the dry run passed. Run the same command with --send to hand the program to the vault.', 'Nothing was sent.');
  }

  // The hand-over, always, once a deploy has run: the vault cannot sign this (it is a program
  // address), hence the skip flag. If the paying wallet no longer holds the authority it fails harmlessly.
  const handed = solana(['program', 'set-upgrade-authority', CFG.programId, '--new-upgrade-authority', CFG.addr.vault, '--skip-new-upgrade-authority-signer-check', '--upgrade-authority', payerKey, '--keypair', payerKey], rpc);
  for (let i = 0; i < 20; i++) { try { p = await readProgram(conn); } catch { p = null; } if (p?.authority === CFG.addr.vault) break; await sleep(3000); }
  try { fs.unlinkSync(LOCK); } catch { /* not ours to keep */ }
  R.check(p?.authority === CFG.addr.vault, `HANDED OVER: the upgrade authority is the vault ${CFG.addr.vault}`, `the upgrade authority is ${p?.authority ?? 'unread'}, not the vault (the command ${handed ? 'said it worked' : 'failed'}). Run now: ${HANDOVER}`);
  return R.end(`the program is deployed and the vault holds it. Go on to node "${VERIFY}".`, `The hand-over is not confirmed. Run now: ${HANDOVER}`);
});
