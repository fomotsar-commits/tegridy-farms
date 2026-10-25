#!/usr/bin/env node
// The whole mainnet folder, rehearsed on a local chain: the steps of START-HERE.md in order, with
// the owner's own Solana tool, a rehearsal program key and a build carrying it (program-id-change.mjs
// on a scratch copy), the real Squads program and a copy of the venue's multisig with local member
// keys; a stand-in for GitHub and the website (fake-github.mjs); and the real page in a headless
// browser for the execute. Each refusal the folder promises is also tried, and must refuse.
// Writes rehearsal-results.json, which staging a devnet or mainnet folder requires.
//
//   node rehearse.mjs --binary <rehearsal raydium_clmm.so> --program-key <rehearsal program key>
//   env: CLMM_WORK (work folder), CLMM_TIME_LOCK (the local lock, default 20)
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { allowedUrl } from '../scripts/lib/hosts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOY = resolve(HERE, '..');
const REPO = resolve(DEPLOY, '..', '..');
const LOCALNET = resolve(DEPLOY, '..', 'clmm-localnet');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const WORK = resolve(process.env.CLMM_WORK || join(LOCALNET, '.work'));
const R = join(WORK, 'rehearsal');
const PACK = join(R, 'pack');
const PORT = 18899;
const RPC = `http://127.0.0.1:${PORT}`;
const FAKE_PORT = 18990;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const PAGE_PORT = 5498;
const LOCK = Number(process.env.CLMM_TIME_LOCK ?? 20);
const NOTICE_SECONDS = 240; // stands in for seven days
const POOL_PEAK = 1_000_000_000n; // a stand-in pool pack that has not run its Day 0
mkdirSync(R, { recursive: true });

const results = [];
const step = (id, what, pass, detail = '') => { results.push({ id, what, pass: !!pass, detail: String(detail) }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${what}${detail ? ` (${detail})` : ''}`); };
const env = { ...process.env, CLMM_WORK: WORK, CLMM_TIME_LOCK: String(LOCK), CLMM_PORT: String(PORT) };
const node = (script, args = [], cwd = LOCALNET) => spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf-8', maxBuffer: 64 << 20 });
const run = (dir, script, args = []) => {
  const r = spawnSync(process.execPath, [join(dir, 'scripts', script), ...args, ...(script.startsWith('0-') ? [] : ['--rpc', RPC])], { encoding: 'utf-8', maxBuffer: 64 << 20 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return { code: r.status, out, result: /RESULT: (.*)/.exec(out)?.[1] ?? out.trim().split('\n').pop() };
};
const packStep = (script, args) => run(PACK, script, args);
const sleep = (ms) => new Promise((q) => setTimeout(q, ms));

// ---- the stand-in for GitHub and the website: a state file, rewritten as the rehearsal goes ---
const STATE = join(R, 'fake-github.json');
const gh = { head: null, commits: [], program: null };
const saveGh = () => writeFileSync(STATE, JSON.stringify(gh));
function commit(changelog, at = Date.now() / 1000) {
  const sha = randomBytes(20).toString('hex');
  gh.commits.push({ sha, date: new Date(Math.floor(at) * 1000).toISOString().replace(/\.\d+Z$/, 'Z'), parent: gh.head, files: { 'CHANGELOG.md': changelog } });
  gh.head = sha; saveGh(); return gh.commits.at(-1);
}
const BASE = '# Changelog\n\n## [Unreleased]\n\n### 2026-10-20\n\n- An older line.\n';

const keepAlive = spawn('wsl', ['-e', 'bash', '-lc', 'exec sleep 86400'], { stdio: 'ignore' });
let fake; let page; let browser;
try {
  // ---- the chain: mainnet copies, a multisig with local members, NO range program -------------
  node('validator.mjs', ['--stop']);
  if (node('setup.mjs').status !== 0) throw new Error('setup failed');
  if (node('validator.mjs', ['--no-clmm']).status !== 0) throw new Error('validator did not start');
  for (let i = 0; ; i++) {
    const ok = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' }).then((r) => r.json()).then((j) => j.result === 'ok').catch(() => false);
    if (ok) break;
    if (i > 240) throw new Error('validator did not come up');
    await sleep(1000);
  }
  const poolLib = readFileSync('C:/Users/jimbo/solana-launch-release-2026-09-26/pool-program-upgrade-2026-10/scripts/lib/pack.mjs', 'utf-8');
  const SOLANA = /^export const SOLANA_EXE = '([^']+)';$/m.exec(poolLib)[1].replace(/\\\\/g, '\\');
  const KEYGEN = SOLANA.replace(/solana\.exe$/, 'solana-keygen.exe');
  const cli = (args) => { const r = spawnSync(SOLANA, [...args, '--url', RPC], { encoding: 'utf-8', maxBuffer: 64 << 20 }); return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }; };
  const keygen = (file) => { if (!existsSync(file)) spawnSync(KEYGEN, ['new', '--no-bip39-passphrase', '--silent', '--outfile', file]); return spawnSync(KEYGEN, ['pubkey', file], { encoding: 'utf-8' }).stdout.trim(); };

  const programKey = resolve(opt('--program-key'));
  const payerKey = join(R, 'payer-keypair.json');
  const payer = keygen(payerKey);
  const so = join(R, 'raydium_clmm.rehearsal.so');
  copyFileSync(resolve(opt('--binary')), so);
  gh.program = spawnSync(SOLANA, ['address', '-k', programKey], { encoding: 'utf-8' }).stdout.trim();
  commit(BASE);
  fake = spawn(process.execPath, [join(HERE, 'fake-github.mjs'), STATE, String(FAKE_PORT)], { stdio: 'ignore' });
  await sleep(1500);

  // The rehearsal's own folder, staged afresh (stage.mjs never replaces a folder in use).
  rmSync(PACK, { recursive: true, force: true });
  const st = spawnSync(process.execPath, [join(DEPLOY, 'stage.mjs'), '--kind', 'rehearsal', '--binary', so, '--out', PACK, '--rpc', RPC,
    '--program-key', programKey, '--payer-key', payerKey, '--notice-days', String(NOTICE_SECONDS / 86400), '--notice-repo', FAKE,
    '--position-base', `${FAKE}/position/`, '--port', String(PAGE_PORT), '--pool-pack-peak', String(POOL_PEAK)], { encoding: 'utf-8' });
  step('R0', 'stage.mjs makes a rehearsal folder', st.status === 0, (st.stdout + st.stderr).trim().split('\n').slice(-3).join(' | '));
  const CFG = JSON.parse(readFileSync(join(PACK, 'config.json'), 'utf-8'));
  const st2 = spawnSync(process.execPath, [join(DEPLOY, 'stage.mjs'), '--kind', 'key', '--out', R], { encoding: 'utf-8' });
  step('R1', 'stage.mjs refuses to replace a folder it did not make (it never deletes one)', st2.status === 2 && /was not made by this script/.test(st2.stderr) && existsSync(payerKey), st2.stderr.trim());

  // ---- web3, the page's own core, and the folder's own library ----------------------------------
  const req = createRequire(CFG.packages);
  const web3 = req('@solana/web3.js');
  const url = (f) => new URL(`file:///${f.replace(/\\/g, '/')}`);
  const { makeCore, decide, noticeState } = await import(url(join(PACK, 'scripts', 'lib', 'tiers.mjs')));
  const conn = new web3.Connection(RPC, 'confirmed');
  const core = makeCore({ web3, cfg: CFG });
  const kp = (f) => web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, 'utf-8'))));
  const locals = ['memberA', 'memberB'].map((n) => kp(join(WORK, 'keys', `${n}.json`)));
  const memberFor = (k) => locals.find((x) => x.publicKey.toBase58() === k);
  const A = memberFor(CFG.addr.memberA); // the paper's member A: the multisig's own order
  const B = memberFor(CFG.addr.memberB);
  if (!A || !B) throw new Error('the staged members are not the local member keys');
  const bal = async (k) => BigInt(await conn.getBalance(new web3.PublicKey(k), 'confirmed'));
  const confirm = async (s) => { for (;;) { const x = (await conn.getSignatureStatuses([s])).value[0]; if (x?.err) throw new Error(JSON.stringify(x.err)); if (x?.confirmationStatus === 'confirmed' || x?.confirmationStatus === 'finalized') return; await sleep(300); } };
  const airdrop = async (k, l) => confirm(await conn.requestAirdrop(new web3.PublicKey(k), Number(l)));
  const transfer = async (from, to, l) => web3.sendAndConfirmTransaction(conn, new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: new web3.PublicKey(to), lamports: Number(l) })), [from]);
  for (const m of [A, B]) await airdrop(m.publicKey.toBase58(), 1e9);
  await airdrop(CFG.addr.vault, 1e9);

  // ---- the key -----------------------------------------------------------------------------------
  let r = packStep('0-program-key.mjs', ['--key', programKey]);
  step('K1', '0-program-key: the rehearsal key and its data address are fresh on mainnet and devnet', r.code === 0 && /its data address \w+ holds nothing on mainnet/.test(r.out), r.result);
  const stray = join(R, 'scratch', 'target', 'deploy', 'raydium_clmm-keypair.json');
  mkdirSync(dirname(stray), { recursive: true }); copyFileSync(programKey, stray);
  r = packStep('0-program-key.mjs', ['--key', stray]);
  step('K2', '0-program-key refuses a key the build tool wrote (target\\deploy)', r.code === 1 && /build tool/.test(r.out), r.result);

  // ---- the money -----------------------------------------------------------------------------------
  const rent = async (n) => BigInt(await conn.getMinimumBalanceForRentExemption(n));
  const bufferRent = await rent(37 + CFG.binary.bytes);
  const dataRent = await rent(45 + CFG.binary.bytes);
  const progRent = await rent(36);
  const need = bufferRent + progRent + (dataRent > bufferRent ? dataRent - bufferRent : 0n) + BigInt(CFG.feeAllowanceLamports);
  await airdrop(payer, need * 3n + 3_000_000_000n);

  // A buffer of ANOTHER build (the placeholder build), for the refusals.
  const wrongKey = join(R, 'wrong-buffer-keypair.json');
  rmSync(wrongKey, { force: true });
  const wrongBuf = keygen(wrongKey);
  const wrongSo = join(R, 'raydium_clmm.placeholder.so');
  spawnSync('wsl', ['-e', 'bash', '-lc', `cp /root/clmm-p1/tegridy-clmm/target/deploy/raydium_clmm.so "${wrongSo.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`)}"`]);
  let c = cli(['program', 'write-buffer', wrongSo, '--buffer', wrongKey, '--buffer-authority', payerKey, '--keypair', payerKey, '--with-compute-unit-price', '10000']);
  step('B0', 'a buffer holding another build (the placeholder one) is uploaded, for the refusals', c.code === 0, c.out.trim().split('\n').pop());
  r = packStep('2-verify-buffer.mjs', ['--buffer', wrongBuf]);
  step('B1', '2-verify-buffer refuses a buffer that is not the reviewed build', r.code === 1 && /NOT the reviewed build|made for another file/.test(r.out), r.result);
  r = packStep('3-deploy.mjs', ['--buffer', wrongBuf, '--send']);
  step('B2', '3-deploy --send refuses that buffer and sends nothing', r.code === 1 && !(await conn.getAccountInfo(new web3.PublicKey(CFG.programId))), r.result);
  r = packStep('7-close-buffer.mjs', ['--buffer', wrongBuf, '--send']);
  step('C1', '7-close-buffer refuses a buffer of another build, and sends nothing', r.code === 1 && !!(await conn.getAccountInfo(new web3.PublicKey(wrongBuf))), r.result);

  // The block a stranger can put on an address they know: SOL at its data address. Seen red first.
  const squatKey = join(R, 'squatted-program-keypair.json');
  rmSync(squatKey, { force: true });
  const squatted = keygen(squatKey);
  const squatData = web3.PublicKey.findProgramAddressSync([new web3.PublicKey(squatted).toBuffer()], new web3.PublicKey(CFG.addr.loader))[0];
  await transfer(A, squatData, 1_000_000);
  c = cli(['program', 'deploy', '--buffer', wrongBuf, '--program-id', squatKey, '--upgrade-authority', payerKey, '--keypair', payerKey]);
  step('S1', 'the attack is real: with SOL at its data address, the loader refuses to deploy that address', c.code !== 0 && !(await conn.getAccountInfo(new web3.PublicKey(squatted))), c.out.trim().split('\n').filter(Boolean).pop());
  const lib = await import(url(join(PACK, 'scripts', 'lib', 'pack.mjs')));
  const RS = new lib.Report('(the rehearsal asks the folder\'s own check)');
  await lib.addressesFree(conn, RS, squatted, 'the local chain');
  step('S2', 'the folder\'s check refuses such an address before anything is uploaded', RS.refused.length === 1 && /ALREADY holds/.test(RS.refused[0].w));
  c = cli(['program', 'close', wrongBuf, '--authority', payerKey, '--recipient', payer, '--keypair', payerKey]);
  step('B3', 'the paying wallet takes that buffer\'s SOL back alone (rehearsal clean-up)', c.code === 0, c.out.trim().split('\n').slice(-1).join(''));

  // A spare upload of THIS build: the buffer return, both ways.
  const spareKey = join(R, 'spare-buffer-keypair.json');
  rmSync(spareKey, { force: true });
  const spare = keygen(spareKey);
  // Stopped half way, as a closed window would stop it; then the same command again.
  const half = spawn(SOLANA, ['program', 'write-buffer', so, '--buffer', spareKey, '--buffer-authority', payerKey, '--keypair', payerKey, '--with-compute-unit-price', '10000', '--url', RPC], { stdio: 'ignore' });
  for (let i = 0; i < 120 && !(await conn.getAccountInfo(new web3.PublicKey(spare))); i++) await sleep(500);
  await sleep(1500);
  half.kill();
  await sleep(2000);
  r = packStep('2-verify-buffer.mjs', ['--buffer', spare]);
  step('S0a', 'an upload stopped half way: 2-verify-buffer says it is not finished, and nothing is lost', r.code === 1 && /THE UPLOAD IS NOT FINISHED/.test(r.out), r.result);
  c = cli(['program', 'write-buffer', so, '--buffer', spareKey, '--buffer-authority', payerKey, '--keypair', payerKey, '--with-compute-unit-price', '10000']);
  r = packStep('2-verify-buffer.mjs', ['--buffer', spare]);
  step('S0', 'the very same upload command again carries on, and the buffer then holds the build', c.code === 0 && r.code === 0, `${c.out.trim().split('\n').pop()}; ${r.result}`);
  const outsiderKey = join(WORK, 'keys', 'outsider.json');
  const outsider = kp(outsiderKey).publicKey.toBase58();
  await airdrop(outsider, 1e9);
  c = cli(['program', 'set-buffer-authority', spare, '--buffer-authority', payerKey, '--new-buffer-authority', outsider, '--keypair', payerKey]);
  r = packStep('7-close-buffer.mjs', ['--buffer', spare, '--send']);
  step('C2', '7-close-buffer refuses this build\'s buffer when the paying wallet is not its authority', c.code === 0 && r.code === 1 && /not the paying wallet/.test(r.out), r.result);
  c = cli(['program', 'set-buffer-authority', spare, '--buffer-authority', outsiderKey, '--new-buffer-authority', payer, '--keypair', outsiderKey]);
  r = packStep('7-close-buffer.mjs', ['--buffer', spare]);
  step('C3', '7-close-buffer as a dry run passes on the paying wallet\'s own buffer of this build, and sends nothing', c.code === 0 && r.code === 0 && /DRY RUN/.test(r.out) && !!(await conn.getAccountInfo(new web3.PublicKey(spare))), r.result);
  const beforeClose = await bal(payer);
  r = packStep('7-close-buffer.mjs', ['--buffer', spare, '--send']);
  const back = (await bal(payer)) - beforeClose;
  step('C4', '7-close-buffer --send closes it, and the SOL comes back to the paying wallet', r.code === 0 && !(await conn.getAccountInfo(new web3.PublicKey(spare))) && back > bufferRent - 100_000n, `${back} lamports back (the buffer held ${bufferRent})`);

  // A folder that is not as staged: a changed file, an added file.
  for (const [id, what, change] of [['P2', 'one bit changed in the program file', (d) => { const f = join(d, CFG.binary.file); const b = readFileSync(f); b[1000] ^= 1; writeFileSync(f, b); }],
    ['P2b', 'a second program file added', (d) => copyFileSync(wrongSo, join(d, 'binary-to-deploy', 'other.so'))]]) {
    const t = join(R, 'pack-tampered');
    rmSync(t, { recursive: true, force: true }); cpSync(PACK, t, { recursive: true }); change(t);
    r = run(t, '1-preflight.mjs');
    step(id, `every script stops on a folder with ${what} (SHA256SUMS)`, r.code === 2 && /not as it was staged/.test(r.out), r.out.trim().split('\n').pop());
  }

  // The paying wallet: exactly the deploy's need, then the pool pack's share beside it.
  const sink = web3.Keypair.generate().publicKey;
  const pk = kp(payerKey);
  await transfer(pk, sink, (await bal(payer)) - need - 5000n);
  r = packStep('1-preflight.mjs');
  step('P0', '1-preflight sets the pool pack\'s SOL aside while its Day 0 has not run, and asks for both', r.code === 1 && /set aside for the pool pack/.test(r.out) && /send it/.test(r.out), r.result);
  await airdrop(payer, POOL_PEAK);
  const funded = await bal(payer);
  step('M1', 'the paying wallet holds exactly the deploy\'s need plus the pool pack\'s share', funded === need + POOL_PEAK, `${funded} = buffer ${bufferRent} + program account ${progRent} + data minus buffer ${dataRent - bufferRent} + fees ${CFG.feeAllowanceLamports} + pool pack ${POOL_PEAK}`);
  r = packStep('1-preflight.mjs');
  step('P1', '1-preflight passes', r.code === 0, r.result);

  // ---- the deploy ---------------------------------------------------------------------------------
  const bufKey = join(PACK, 'owner-run', CFG.bufferKeyFile);
  const buf = keygen(bufKey);
  const before = await bal(payer);
  c = cli(['program', 'write-buffer', join(PACK, CFG.binary.file), '--buffer', bufKey, '--buffer-authority', payerKey, '--keypair', payerKey, '--with-compute-unit-price', '10000']);
  const afterUpload = await bal(payer);
  const uploadFees = before - afterUpload - bufferRent;
  step('U1', 'the upload (solana write-buffer, the owner\'s command) finishes', c.code === 0 && c.out.includes(buf), `${before - afterUpload} lamports left the wallet: ${bufferRent} parked in the buffer, ${uploadFees} in fees`);
  r = packStep('2-verify-buffer.mjs', ['--buffer', buf]);
  step('U2', '2-verify-buffer passes on the real upload', r.code === 0, r.result);
  r = packStep('3-deploy.mjs', ['--buffer', buf]);
  step('D0', '3-deploy without --send is a dry run that passes and sends nothing', r.code === 0 && /DRY RUN/.test(r.out) && !(await conn.getAccountInfo(new web3.PublicKey(CFG.programId))), r.result);
  r = packStep('3-deploy.mjs', ['--buffer', buf, '--send']);
  const afterDeploy = await bal(payer);
  writeFileSync(join(R, 'deploy-output.txt'), r.out);
  step('D1', '3-deploy --send deploys at exact size and hands the program to the vault', r.code === 0 && /HANDED OVER/.test(r.out), r.result);
  step('M2', 'the deploy never needed a second buffer\'s worth: the pool pack\'s share was never touched', r.code === 0 && afterDeploy >= POOL_PEAK, `wallet ${funded} -> after upload ${afterUpload} -> after deploy ${afterDeploy}; the pool pack's ${POOL_PEAK} still there`);
  r = packStep('3-deploy.mjs', ['--buffer', buf, '--send']);
  step('D2', '3-deploy refuses to deploy a second time', r.code === 1 && /ALREADY deployed/.test(r.out), r.result);
  r = packStep('4-verify-program.mjs');
  step('V1', '4-verify-program: byte for byte, exact size, authority the vault; the vault\'s tier would work, a stranger\'s is refused', r.code === 0 && /the vault may make a fee tier/.test(r.out) && /NotApproved/.test(r.out), r.result);
  r = packStep('1-preflight.mjs');
  step('P3', '1-preflight after the deploy refuses to start over', r.code === 1 && /ALREADY deployed/.test(r.out), r.result);

  // ---- the notice: GitHub's merge line, read by 5-record-notice ---------------------------------
  r = packStep('5-record-notice.mjs');
  step('N0', '5-record-notice refuses while the line is not on mvp-launch', r.code === 1 && /is NOT in/.test(r.out), r.result);
  const withLine = BASE.replace('### 2026-10-20\n\n', `### 2026-10-20\n\n${CFG.notice.line}\n`);
  const c1 = commit(withLine, await core.clock(conn));
  await sleep(2000);
  r = packStep('5-record-notice.mjs');
  step('N1', '5-record-notice records the notice: first seen by the network\'s clock, and the merge it came in', r.code === 0 && r.out.includes(c1.sha), r.result);
  const rec = () => JSON.parse(readFileSync(join(PACK, 'owner-run', 'notice.json'), 'utf-8'));
  const positionLink = async () => {
    const u = `${CFG.positionLink.base}${web3.Keypair.generate().publicKey.toBase58()}.json`;
    const x = await fetch(allowedUrl(u, { loopback: true })); const j = await x.json().catch(() => null);
    return x.status === 404 && j?.error === CFG.positionLink.expect && j?.program === CFG.programId ? { ok: true, why: 'the position link is live for this program' } : { ok: false, why: `not live for this program (${JSON.stringify(j)})` };
  };
  const sha = (b) => Promise.resolve(createRequire(import.meta.url)('node:crypto').createHash('sha256').update(b).digest('hex'));
  const state = async (member) => core.readState(conn, { sha256hex: sha, member: member?.publicKey.toBase58() ?? null, notice: rec(), positionLink: await positionLink() });
  async function act(member, ixs) {
    const sim = await core.simulate(conn, member.publicKey.toBase58(), ixs);
    if (!sim.ok) return { ok: false, why: `simulation: ${JSON.stringify(sim.err)} ${sim.logs.slice(-2).join(' | ')}`, logs: sim.logs };
    const { vtx } = await core.txFor(conn, member.publicKey.toBase58(), ixs);
    vtx.sign([member]);
    const s = await conn.sendRawTransaction(vtx.serialize());
    try { await confirm(s); return { ok: true, sig: s }; } catch (e) { return { ok: false, why: e.message }; }
  }

  // ---- the proposal --------------------------------------------------------------------------------
  let d = decide(CFG, await state(null));
  step('T0', 'the page asks for a member wallet first', d.action === null && /connect a member wallet/.test(d.lines.at(-1).w));
  d = decide(CFG, { ...(await state(null)), member: web3.Keypair.generate().publicKey.toBase58() });
  step('T1', 'the page offers nothing to a wallet outside the multisig', d.action === null && /not a member/.test(d.lines.at(-1).w));

  // Two proposals made outside the page: mainnet's #19 as this pack made it before the owner ruled one
  // tier (2026-10-25), the 1% tier and a 0.25% one, approved by both; and one that only NAMES the
  // program's data account.
  const ms0 = await core.readMultisig(conn);
  const OLD_19 = [...CFG.tiers, { index: 1, tickSpacing: 60, tradeFeeRate: 2_500, protocolFeeRate: 104_000, fundFeeRate: 56_000 }];
  const two = makeCore({ web3, cfg: { ...CFG, tiers: OLD_19 } });
  const old = ms0.transactionIndex + 1;
  let a = await act(A, two.proposeIxs(A.publicKey.toBase58(), old));
  const naming = core.compile([web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(CFG.addr.vault), toPubkey: core.PROGRAM_DATA, lamports: 1 })]);
  const a2 = await act(A, core.proposeIxs(A.publicKey.toBase58(), ms0.transactionIndex + 2, naming));
  step('T2', 'two proposals are made outside the page (for the refusals): the old two-tier one and one naming the data account', a.ok && a2.ok, a.why ?? a2.why ?? 'ok');
  const proposalOf = async (i) => core.decodeProposal((await conn.getAccountInfo(core.proposalPda(i))).data);
  a = await act(B, [core.approveIx(B.publicKey.toBase58(), old)]);
  const approved = await proposalOf(old);
  step('T2b', 'member B approves the two-tier one too: Approved by both, as mainnet\'s #19 is', a.ok && approved.status === 'Approved', a.why ?? `#${old} ${approved.status}`);
  const st3 = await state(B);
  d = decide(CFG, st3);
  const stops = d.lines.filter((l) => !l.ok).map((l) => l.w);
  console.log(`  (scan: ${st3.proposals.filter((x) => x.index > ms0.transactionIndex).map((x) => `#${x.index} ${x.kind} live=${x.live} touches=${x.touches} ours=${x.ours} ${x.proposal?.status}`).join('; ')})`);
  step('T3', 'the page refuses to go on while either touches the range program (both members cancel the approved two-tier one), even one that only names its data account', d.action === null && stops.some((w) => w.includes(`#${old} (Approved)`) && /Both members cancel it/.test(w)) && stops.some((w) => w.includes(`#${ms0.transactionIndex + 2} `)), stops.join(' | ').slice(0, 260));
  r = packStep('1-preflight.mjs');
  step('T4', '1-preflight also names them and refuses', r.code === 1 && /NOT this folder's/.test(r.out), r.result);
  const voteIx = (vote, member, i) => new web3.TransactionInstruction({ programId: new web3.PublicKey(CFG.addr.squads), keys: [
    { pubkey: new web3.PublicKey(CFG.addr.multisig), isSigner: false, isWritable: false }, { pubkey: member.publicKey, isSigner: true, isWritable: true }, { pubkey: core.proposalPda(i), isSigner: false, isWritable: true }],
  data: Buffer.concat([createRequire(import.meta.url)('node:crypto').createHash('sha256').update(`global:proposal_${vote}`).digest().subarray(0, 8), Buffer.from([0])]) });
  a = await act(B, [voteIx('reject', B, ms0.transactionIndex + 2)]);
  step('T5', 'member B rejects the one naming the data account (one rejection of a 2-of-2 ends it)', a.ok, a.why ?? a.sig);
  a = await act(A, [voteIx('cancel', A, old)]);
  let p = await proposalOf(old);
  d = decide(CFG, await state(A));
  step('T5b', 'member A cancels the two-tier one: one cancel of a 2-of-2 is not enough, it stays Approved and the page still refuses', a.ok && p.status === 'Approved' && p.cancelled.length === 1 && d.action === null && d.lines.some((l) => !l.ok && l.w.includes(`#${old} (Approved)`)), a.why ?? `#${old} ${p.status}, ${p.cancelled.length} cancel`);
  a = await act(B, [voteIx('cancel', B, old)]);
  p = await proposalOf(old);
  // Squads reads the lock only for an Approved proposal: any other status is InvalidProposalStatus.
  const late = await two.simulate(conn, A.publicKey.toBase58(), [two.executeIx(A.publicKey.toBase58(), old)]);
  step('T5c', 'member B cancels it too: Cancelled, and an execute of it is refused for its status (InvalidProposalStatus), not for the lock', a.ok && p.status === 'Cancelled' && !late.ok && late.logs.some((l) => /InvalidProposalStatus/.test(l)), a.why ?? `#${old} ${p.status}; execute: ${late.logs.filter((l) => /Error/.test(l)).slice(-1).join('')}`);

  d = decide(CFG, await state(A));
  step('T6', 'with both ended, the page offers member A to propose', d.action === 'propose', d.lines.at(-1).w);
  const aBefore = await bal(A.publicKey.toBase58());
  const idx = (await core.readMultisig(conn)).transactionIndex + 1;
  a = await act(A, core.proposeIxs(A.publicKey.toBase58(), idx));
  const aSpent = aBefore - (await bal(A.publicKey.toBase58()));
  const vtInfo = await conn.getAccountInfo(core.txPda(idx)); const prInfo = await conn.getAccountInfo(core.proposalPda(idx));
  step('T7', 'member A creates and approves the tier proposal', a.ok, `#${idx}, member A spent ${aSpent} lamports; the transaction account ${vtInfo?.data.length} bytes (folder says ${CFG.squads.vaultTransactionBytes}), the proposal ${prInfo?.data.length} (folder says ${CFG.squads.proposalBytes})`);
  step('T7b', 'the folder sizes the proposal accounts right (for the SOL member A needs)', vtInfo?.data.length === CFG.squads.vaultTransactionBytes && prInfo?.data.length === CFG.squads.proposalBytes);
  step('T8', 'the stored proposal is byte for byte the page\'s', core.isOurs(core.decodeVaultTransaction(vtInfo.data)));
  d = decide(CFG, await state(A));
  step('T9', 'member A, having approved, has nothing more to sign', d.action === null && /has your approval/.test(d.lines.at(-1).w));

  // Member B's approval waits until the lock would end no sooner than the notice's days.
  let s = await state(B);
  d = decide(CFG, s);
  const n = noticeState(CFG, rec(), s.clock);
  const from = n.start + NOTICE_SECONDS - LOCK;
  step('T10', 'right after the proposal, the page tells member B to wait: the approval would let the lock end before the notice\'s days', d.action === null && /waits for your approval from/.test(d.lines.at(-1).w), d.lines.at(-1).w);
  step('T10b', 'at that time it offers the approval (worked out with the network\'s clock moved there)', decide(CFG, { ...s, clock: from }).action === 'approve');
  gh.program = web3.Keypair.generate().publicKey.toBase58(); saveGh();
  d = decide(CFG, await state(B));
  step('T10c', 'it refuses while the website\'s position link answers for another program', d.action === null && /position link|not live for this program/.test(d.lines.at(-1).w), d.lines.at(-1).w);
  gh.program = CFG.programId; saveGh();
  step('T10d', 'it refuses a notice record with a time that does not read as a time, or one checked over an hour ago', decide(CFG, { ...s, clock: from, notice: { ...rec(), seenAt: 'soon' } }).action === null && decide(CFG, { ...s, clock: Date.parse(rec().checkedAt) / 1000 + 3700 }).action === null);

  // The owner's mistake, tried: member B approves outside the page, too early.
  a = await act(B, [core.approveIx(B.publicKey.toBase58(), idx)]);
  step('T11', 'an approval sent around the page lands (Squads cannot know of the notice)', a.ok, a.why ?? a.sig);
  d = decide(CFG, await state(B));
  step('T12', 'the page then offers no execute: the time lock holds it, by the network\'s clock', d.action === null && /time lock holds it until/.test(d.lines.at(-1).w), d.lines.at(-1).w);
  const early = await core.simulate(conn, A.publicKey.toBase58(), [core.executeIx(A.publicKey.toBase58(), idx)]);
  step('T13', 'an execute sent around the page now is refused by Squads itself (time lock)', !early.ok && early.logs.some((l) => /TimeLockNotReleased/.test(l)));
  const pr = core.decodeProposal((await conn.getAccountInfo(core.proposalPda(idx))).data);
  while ((await core.clock(conn)) < pr.timestamp + LOCK + 1) await sleep(1000);
  packStep('5-record-notice.mjs');
  d = decide(CFG, await state(A));
  step('T14', 'after the lock, the page still waits for the notice\'s days (the approval came early)', d.action === null && /may execute from/.test(d.lines.at(-1).w), d.lines.at(-1).w);

  // The line drops out of the changelog in one merge, and comes back in the next.
  commit(BASE, await core.clock(conn));
  await sleep(1500);
  r = packStep('5-record-notice.mjs');
  d = decide(CFG, await state(A));
  step('T15', 'with the line gone from mvp-launch, the record refuses and so does the page', r.code === 1 && d.action === null && /NOT on mvp-launch/.test(d.lines.at(-1).w), d.lines.at(-1).w);
  await sleep(2000);
  const c3 = commit(withLine, await core.clock(conn));
  await sleep(1500);
  r = packStep('5-record-notice.mjs');
  const n3 = noticeState(CFG, rec(), await core.clock(conn));
  step('T15b', 'with it back, the notice starts again from the merge that brought it back', r.code === 0 && n3.ok && n3.start === Date.parse(c3.date) / 1000 && n3.start > n.start, `first notice ${new Date(n.start * 1000).toISOString()}, now ${new Date(n3.start * 1000).toISOString()}`);

  // Anyone may send SOL to a tier's address; it must not block the page or the execute.
  await transfer(A, core.ammConfig(0), 2_000_000);
  const t0 = (await core.tiers(conn))[0];
  d = decide(CFG, await state(A));
  step('T15c', 'SOL sent to a tier\'s address reads as "not made yet", and the page goes on', t0.state === 'absent' && t0.lamportsOnly && !d.lines.some((l) => !l.ok), d.lines.at(-1).w);

  while ((await core.clock(conn)) < n3.start + NOTICE_SECONDS + 1) await sleep(1000);
  packStep('5-record-notice.mjs');
  d = decide(CFG, await state(A));
  step('T16', 'with the lock over and the notice public for its days without a gap, the page offers the execute', d.action === 'execute' && d.index === idx, d.lines.at(-1).w);

  // ---- the execute, through the real page in a headless browser --------------------------------
  page = spawn(process.execPath, [join(PACK, 'proposer', 'serve.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let pageOut = ''; page.stdout.on('data', (b) => { pageOut += b; });
  for (let i = 0; i < 40 && !pageOut.includes('http://127.0.0.1'); i++) await sleep(250);
  const head = await fetch(`http://127.0.0.1:${PAGE_PORT}/`);
  step('W0', 'the page\'s server answers, and forbids being framed by another page', head.status === 200 && head.headers.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test(head.headers.get('content-security-policy') ?? ''));
  const evil = await fetch(`http://127.0.0.1:${PAGE_PORT}/rpc`, { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' });
  step('W0b', 'the relay refuses a call from another web page', evil.status === 403);
  const { chromium } = createRequire(join(REPO, 'frontend', 'package.json'))('playwright');
  browser = await chromium.launch();
  const tab = await browser.newPage();
  const errors = []; tab.on('pageerror', (e) => errors.push(e.message)); tab.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // A stand-in wallet holding member A's local test key: it signs exactly what it is given.
  await tab.addInitScript(({ pub, secret }) => {
    const sk = Uint8Array.from(secret);
    window.solana = {
      publicKey: { toBase58: () => pub },
      connect: async () => ({ publicKey: { toBase58: () => pub } }),
      disconnect: async () => {},
      signTransaction: async (vtx) => { vtx.sign([{ publicKey: vtx.message.staticAccountKeys[0], secretKey: sk }]); return vtx; },
    };
  }, { pub: A.publicKey.toBase58(), secret: [...A.secretKey] });
  await tab.goto(`http://127.0.0.1:${PAGE_PORT}/`);
  await tab.waitForSelector('#lines li');
  step('W1', 'the page loads on the local chain and says so', (await tab.textContent('#net')).includes('LOCAL'));
  await tab.click('#connect');
  await tab.waitForSelector('#go', { timeout: 30_000 });
  step('W2', 'connected as member A, the page offers the execute', (await tab.textContent('#go')).includes(`EXECUTE proposal #${idx}`));
  const vaultBefore = await bal(CFG.addr.vault);
  await tab.click('#go');
  await tab.waitForFunction(() => /EXECUTED|STOP|FAILED|stopped/.test(document.getElementById('log').textContent), null, { timeout: 90_000 });
  const logText = await tab.textContent('#log');
  step('T17', 'the page executes the proposal: the fee tier is made (its address had been sent SOL first)', /proposal #\d+ is EXECUTED/.test(logText), `${logText.slice(0, 200)}; the vault paid ${vaultBefore - (await bal(CFG.addr.vault))} lamports of rent`);
  await tab.click('#again').catch(() => {});
  await tab.waitForFunction(() => /ALREADY DONE/.test(document.getElementById('act').textContent), null, { timeout: 30_000 }).catch(() => {});
  step('T19', 'the page then says ALREADY DONE and offers nothing', /ALREADY DONE/.test(await tab.textContent('#act')));
  step('W3', 'no error in the page\'s console', errors.length === 0, errors.join(' | ').slice(0, 200));
  r = packStep('6-verify-tiers.mjs');
  step('T18', '6-verify-tiers: the fee tier exactly as decided, owner the vault, fund owner the Workshop, and no other tier', r.code === 0 && /owns no other fee tier/.test(r.out), r.result);
  r = packStep('4-verify-program.mjs');
  step('V2', '4-verify-program still passes after the tier', r.code === 0, r.result);

  // A tier the pack does not make, as the old #19 would have: its 0.25% one, by a proposal of its own.
  const extra = makeCore({ web3, cfg: { ...CFG, tiers: OLD_19.slice(1) } });
  const si = (await core.readMultisig(conn)).transactionIndex + 1;
  a = await act(A, extra.proposeIxs(A.publicKey.toBase58(), si));
  const a3 = a.ok ? await act(B, [extra.approveIx(B.publicKey.toBase58(), si)]) : a;
  while (a3.ok && (await core.clock(conn)) < (await proposalOf(si)).timestamp + LOCK + 1) await sleep(1000);
  const a4 = a3.ok ? await act(A, [extra.executeIx(A.publicKey.toBase58(), si)]) : a3;
  r = packStep('6-verify-tiers.mjs');
  step('T20', '6-verify-tiers refuses once a tier this pack does not make exists (the 0.25% one, made by a proposal of its own)', a4.ok && r.code === 1 && /a fee tier this pack does not make exists: index 1, 0.25%/.test(r.out), a4.why ?? r.out.split('\n').find((l) => /REFUSED :/.test(l)) ?? r.result);

  // ---- what it cost ----------------------------------------------------------------------------------
  const S = (l) => `${(Number(l) / 1e9).toFixed(6)} SOL`;
  const peakWords = `The paying wallet was funded with exactly what the check before anything is spent asks (${S(need)} at that chain's rent, which is higher than mainnet's), plus the pool pack's share, and that was enough. The upload took ${S(before - afterUpload)} from it: ${S(bufferRent)} parked in the buffer and ${S(uploadFees)} in fees. The deploy then moved the buffer's SOL into the program's data and charged the wallet only the rest: it held ${S(afterUpload)} before the deploy and ${S(afterDeploy)} after, the pool pack's share untouched. It never needed two buffers' worth. Member A's proposal cost it ${S(aSpent)}.`;
  const out = { at: new Date().toISOString(), cli: CFG.cli, timeLock: LOCK, noticeSeconds: NOTICE_SECONDS, programId: CFG.programId, binary: CFG.binary, peakWords,
    lamports: { bufferRent: String(bufferRent), dataRent: String(dataRent), progRent: String(progRent), need: String(need), funded: String(funded), afterUpload: String(afterUpload), afterDeploy: String(afterDeploy), uploadFees: String(uploadFees), memberAProposal: String(aSpent) },
    results };
  writeFileSync(join(R, 'rehearsal-results.json'), JSON.stringify(out, null, 1));
  const failed = results.filter((x) => !x.pass);
  console.log(`\nrehearsal: ${results.length} steps, ${failed.length} failed${failed.length ? ': ' + failed.map((x) => x.id).join(', ') : ''}`);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.log(`STOPPED: ${e.stack ?? e}`);
  process.exitCode = 2;
} finally {
  await browser?.close().catch(() => {});
  page?.kill(); fake?.kill();
  node('validator.mjs', ['--stop']);
  keepAlive.kill();
}
