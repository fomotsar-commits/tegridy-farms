#!/usr/bin/env node
// THE CHECK BEFORE ANYTHING IS SPENT. READ-ONLY: no key file is opened and nothing is sent.
//
//   node 1-preflight.mjs [--rpc <url>]
//
//   A  is this folder whole: the one program file, your Solana tool, both key files' addresses
//   B  the network: which one, and would its loader refuse this program file (SIMD-0500)
//   C  are the program's address and its data address still empty
//   D  what the deploy costs at today's rent, and does each wallet hold it
//   E  mainnet only: is the multisig what we expect, with no open proposal touching the program
// Exit 0: every line passed. 1: at least one REFUSED. 3: something could not be read.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CFG, PACK, args, addressOfKeyFile, isBuildToolKey, connect, cluster, rpcFor, account, balance, rent, read, Report, main, Stopped,
  checkBinary, readProgram, readBuffer, sameAsBuild, readMultisig, addressesFree, poolPackReserve, devnetRunDone, PROGRAMDATA_HEADER, BUFFER_HEADER, sol, num, web3,
} from './lib/pack.mjs';
import { makeCore } from './lib/tiers.mjs';

await main(async () => {
  const a = args();
  a.known(['--rpc']);
  if (!CFG.programId) throw new Stopped('this folder was staged before the program key existed. It can only check the key (0-program-key.mjs)');
  const conn = connect(rpcFor(a));
  const c = await cluster(conn);
  const R = new Report(`CHECK BEFORE ANYTHING IS SPENT, on ${c.words}, slot ${num(c.slot)}\nRead-only: no key file is opened and nothing is sent.\n`);

  console.log('A. This folder');
  const build = checkBinary(R);
  const v = spawnSync(CFG.solanaExe, ['--version'], { encoding: 'utf8' });
  R.check((v.stdout ?? '').trim().startsWith(`solana-cli ${CFG.cli} `), `your Solana tool is ${(v.stdout ?? '').trim()}`, `the Solana tool at ${CFG.solanaExe} did not answer as version ${CFG.cli} (${(v.stdout ?? '').trim() || v.error?.message || 'no answer'})`);
  const payer = addressOfKeyFile(CFG.keyFiles.payer);
  R.check(payer === CFG.addr.deployWallet, `the paying wallet's key file is ${CFG.keyFiles.payer}, address ${payer}`, `the key file ${CFG.keyFiles.payer} is ${payer ? `the address ${payer}` : 'missing or unreadable'}, not the paying wallet ${CFG.addr.deployWallet}`);
  const progAddr = addressOfKeyFile(CFG.keyFiles.program);
  R.check(!isBuildToolKey(CFG.keyFiles.program) && progAddr === CFG.programId, `the program key file is ${CFG.keyFiles.program}, address ${progAddr} (the address built into the program)`, `the program key file ${CFG.keyFiles.program} is ${progAddr ? `the address ${progAddr}` : 'missing or unreadable'}, not ${CFG.programId}, the address built into the program file. Do not deploy`);

  if (c.kind === 'mainnet') { console.log('\nThe devnet practice run'); await devnetRunDone(R); }

  console.log('\nB. The network');
  const ver = await read('the network\'s version', () => conn.getVersion());
  R.note(`the network runs ${ver?.['solana-core'] ?? 'an unknown version'}`);
  const noOld = await account(conn, CFG.features.noOldSbpf, 'the SIMD-0500 rule');
  R.check(!noOld, `the rule that would forbid deploying this kind of program file (SIMD-0500, ${CFG.features.noOldSbpf}) has no account here: not scheduled`, `the rule SIMD-0500 (${CFG.features.noOldSbpf}) now HAS an account on this network. Stop and ask before spending anything`);

  console.log('\nC. The program\'s address');
  const p = await readProgram(conn);
  if (!p) {
    R.pass(`${CFG.programId} has no account yet: nothing is deployed there`);
    await addressesFree(conn, R, CFG.programId, c.kind);
  } else if (p.body && build && sameAsBuild(p.body, build).same) {
    R.refuse(`the program is ALREADY deployed there, byte for byte this build; its upgrade authority is ${p.authority ?? 'NONE'}. This check is for before the deploy: go to the step "Check the program" (4-verify-program.mjs)`);
  } else if (p.owner === web3.SystemProgram.programId.toBase58()) {
    R.refuse(`someone has sent SOL to the program's address ${CFG.programId}: the deploy would fail there. Do not upload. Ask a session (the program key can take it back)`);
  } else R.refuse(`${CFG.programId} ALREADY has an account that is not this build (owner ${p.owner}). Stop and ask`);

  console.log('\nD. What it costs, at today\'s rent');
  const bufferRent = await rent(conn, BUFFER_HEADER + CFG.binary.bytes);
  const dataRent = await rent(conn, PROGRAMDATA_HEADER + CFG.binary.bytes);
  const progRent = await rent(conn, 36);
  const fees = BigInt(CFG.feeAllowanceLamports);
  // The loader moves the buffer's SOL into the program's data inside the deploy (the rehearsal
  // measured it): the wallet never holds both.
  const need = bufferRent + progRent + (dataRent > bufferRent ? dataRent - bufferRent : 0n) + fees;
  R.note(`the upload buffer holds ${sol(bufferRent)} (${num(BUFFER_HEADER + CFG.binary.bytes)} bytes) until the deploy moves it into the program; the program's data locks ${sol(dataRent)} for good (${num(PROGRAMDATA_HEADER + CFG.binary.bytes)} bytes, exact size); the program account ${sol(progRent)}; fees up to ${sol(fees)}`);
  const buf = addressOfKeyFile(path.join(PACK, 'owner-run', CFG.bufferKeyFile));
  const b = buf ? await readBuffer(conn, buf) : null;
  if (!p && !b) {
    const reserve = c.kind === 'devnet' ? 0n : await poolPackReserve(conn, R);
    const have = await balance(conn, CFG.addr.deployWallet);
    R.check(have >= need + reserve, `the paying wallet holds ${sol(have)}; the deploy needs ${sol(need)} at its peak${reserve ? `, beside the ${sol(reserve)} set aside for the pool pack` : ''}`,
      `the paying wallet holds ${sol(have)}; the deploy needs ${sol(need)} at its peak${reserve ? ` beside the ${sol(reserve)} set aside for the pool pack` : ''}: send it ${sol(need + reserve - have)} more`);
  } else if (b && !b.foreign) R.note(`the buffer ${buf} is already there (${sol(b.lamports)} in it, authority ${b.authority}): the upload was made. Go on at "Check the upload" (2-verify-buffer.mjs)`);

  if (c.kind !== 'devnet') {
    const core = makeCore({ web3, cfg: CFG });
    const tierRent = (await rent(conn, 117)) * BigInt(CFG.tiers.length);
    const vault = await balance(conn, CFG.addr.vault);
    R.check(vault >= tierRent, `the vault holds ${sol(vault)}; the fee tier proposal will lock ${sol(tierRent)} of it`, `the vault holds ${sol(vault)}; the fee tier proposal needs ${sol(tierRent)}`);
    R.note(`later, not in this folder: before any pool can carry a reward, the vault must pay ${sol(await rent(conn, 3529))} for the program's operation account`);
    const proposalRent = (await rent(conn, CFG.squads.vaultTransactionBytes)) + (await rent(conn, CFG.squads.proposalBytes));
    const memberA = await balance(conn, CFG.addr.memberA);
    R.check(memberA >= proposalRent + 50_000n, `member A holds ${sol(memberA)}; the tier proposal will cost it ${sol(proposalRent)}`, `member A holds ${sol(memberA)}; the tier proposal needs ${sol(proposalRent + 50_000n)}: send member A 0.02 SOL`);

    console.log('\nE. The multisig');
    const ms = await readMultisig(conn);
    if (!ms || ms.foreign) R.refuse(`${CFG.addr.multisig} is not the Squads multisig`);
    else {
      R.check(ms.threshold === 2 && ms.members.length === 2 && ms.members.every((m) => [CFG.addr.memberA, CFG.addr.memberB].includes(m.key)), `2 approvals of 2 members: member A ${CFG.addr.memberA} and member B ${CFG.addr.memberB}`, `the multisig is ${ms.threshold} of ${ms.members.map((m) => m.key).join(', ')}, not the pinned 2 of 2`);
      R.check(ms.timeLock === CFG.timeLock, `a time lock of ${num(ms.timeLock)} seconds (${ms.timeLock / 3600} hours)`, `the time lock is ${ms.timeLock} seconds, not ${CFG.timeLock}: stop and ask`);
      R.check(ms.configAuthority === '11111111111111111111111111111111', 'no config authority: nobody can change the multisig alone', `the multisig has a config authority, ${ms.configAuthority}`);
      const props = await read('the multisig\'s proposals', () => core.scan(conn, ms));
      const touching = props.filter((x) => x.live && x.touches);
      R.check(touching.every((x) => x.ours), touching.length ? `tier proposal #${touching.map((x) => x.index).join(', #')} is open and is exactly this folder's` : 'no open proposal touches the range program',
        `an open proposal touches the range program but is NOT this folder's, or cannot be read inside (#${touching.filter((x) => !x.ours).map((x) => `${x.index} ${x.kind}`).join(', #')}). Never approve it. Stop and ask`);
    }
  }
  return R.end('every line passed. Go on to the next step in START-HERE.md.', 'Do what each REFUSED line says, then run this check again.');
});
