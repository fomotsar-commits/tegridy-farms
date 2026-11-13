#!/usr/bin/env node
// The fee-change folder, rehearsed on a local chain: the deployed range program (byte for byte the
// build on mainnet) at its own address with the vault as upgrade authority, the real Squads program,
// and a copy of the venue's multisig with local member keys and a short time lock. #19's own
// instructions are replayed first, so both tiers exist as on mainnet (compared byte for byte); then
// the folder's real page, in a headless browser, proposes (member A), approves (member B) and, after
// the lock, executes the change. Each refusal the folder promises is also tried, and must refuse.
// Writes rehearsal-results.json, which staging the mainnet fee-change folder requires.
//
//   node rehearse-tier-fee.mjs --binary <the deployed raydium_clmm.so>
//   env: CLMM_WORK (a work folder of its own), CLMM_TIME_LOCK (default 20), CLMM_FEATURES_FROM (a work
//        folder whose deactivate-features.txt to copy: mainnet's feature set)
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOY = resolve(HERE, '..');
const REPO = resolve(DEPLOY, '..', '..');
const LOCALNET = resolve(DEPLOY, '..', 'clmm-localnet');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const WORK = resolve(process.env.CLMM_WORK || 'C:/Users/jimbo/dev/clmm-localnet-work-tier-fee');
const R = join(WORK, 'rehearsal-tier-fee');
const PACK = join(R, 'pack');
// Ports and a ledger of its own: another session's local chain may be running on the defaults.
const PORT = 18799;
const RPC = `http://127.0.0.1:${PORT}`;
const LEDGER = '/root/clmm-tier-fee/ledger';
const PAGE_PORT = 5490;
const LOCK = Number(process.env.CLMM_TIME_LOCK ?? 20);
const MAINNET = 'https://api.mainnet-beta.solana.com';
mkdirSync(R, { recursive: true });

const results = [];
const step = (id, what, pass, detail = '') => { results.push({ id, what, pass: !!pass, detail: String(detail) }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${what}${detail ? ` (${detail})` : ''}`); };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const wsl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
const so = join(R, 'raydium_clmm.deployed.so');
const env = { ...process.env, CLMM_WORK: WORK, CLMM_TIME_LOCK: String(LOCK), CLMM_PORT: String(PORT), CLMM_LEDGER: LEDGER, CLMM_SO: wsl(so) };
const node = (script, args = []) => spawnSync(process.execPath, [script, ...args], { cwd: LOCALNET, env, encoding: 'utf-8', maxBuffer: 64 << 20 });
const packStep = (script) => {
  const r = spawnSync(process.execPath, [join(PACK, 'scripts', script), '--rpc', RPC], { encoding: 'utf-8', maxBuffer: 64 << 20 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return { code: r.status, out, result: /RESULT: (.*)/.exec(out)?.[1] ?? out.trim().split('\n').pop() };
};
async function mainnetRpc(method, params) {
  const r = await fetch(MAINNET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const keepAlive = spawn('wsl', ['-e', 'bash', '-lc', 'exec sleep 86400'], { stdio: 'ignore' });
let page; let browser;
try {
  // ---- the build: byte for byte the program on mainnet ----------------------------------------------
  const bin = readFileSync(resolve(opt('--binary')));
  copyFileSync(resolve(opt('--binary')), so);
  const PROGRAM_ID = '7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso';
  const stub = Buffer.from((await mainnetRpc('getAccountInfo', [PROGRAM_ID, { encoding: 'base64' }])).value.data[0], 'base64');
  const req0 = createRequire('C:/Users/jimbo/solana-launch-release-2026-09-26/rehearsal/package.json');
  const web3 = req0('@solana/web3.js');
  const pd = Buffer.from((await mainnetRpc('getAccountInfo', [new web3.PublicKey(stub.subarray(4, 36)).toBase58(), { encoding: 'base64' }])).value.data[0], 'base64');
  step('B0', 'the rehearsal\'s program file is byte for byte the program on mainnet', sha(pd.subarray(45, 45 + bin.length)) === sha(bin) && pd.subarray(45 + bin.length).every((x) => x === 0), `sha256 ${sha(bin)}, ${bin.length} bytes`);

  // ---- the chain: mainnet copies, a multisig with local members, the deployed program -----------------
  node('validator.mjs', ['--stop']);
  spawnSync('wsl', ['-e', 'mkdir', '-p', LEDGER.slice(0, LEDGER.lastIndexOf('/'))]);
  if (node('setup.mjs').status !== 0) throw new Error('setup failed');
  const feat = join(resolve(process.env.CLMM_FEATURES_FROM || 'C:/Users/jimbo/dev/clmm-localnet-work'), 'deactivate-features.txt');
  if (existsSync(feat)) copyFileSync(feat, join(WORK, 'deactivate-features.txt'));
  const v = node('validator.mjs');
  if (v.status !== 0) throw new Error(`validator did not start: ${v.stdout}${v.stderr}`);
  for (let i = 0; ; i++) {
    const ok = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' }).then((r) => r.json()).then((j) => j.result === 'ok').catch(() => false);
    if (ok) break;
    if (i > 240) throw new Error('validator did not come up');
    await sleep(1000);
  }

  // ---- the folder, staged against this chain ----------------------------------------------------------
  rmSync(PACK, { recursive: true, force: true });
  const st = spawnSync(process.execPath, [join(DEPLOY, 'stage.mjs'), '--kind', 'rehearsal', '--tier-fee', '--binary', so, '--out', PACK, '--rpc', RPC, '--port', String(PAGE_PORT)], { encoding: 'utf-8' });
  step('R0', 'stage.mjs makes a fee-change rehearsal folder against the running program', st.status === 0, (st.stdout + st.stderr).trim().split('\n').slice(-3).join(' | '));
  const CFG = JSON.parse(readFileSync(join(PACK, 'config.json'), 'utf-8'));
  step('R1', 'its config sets tier 1 from 2,500 to 10,000 per million, and nothing else', CFG.purpose === 'tier-fee' && JSON.stringify(CFG.change) === JSON.stringify({ index: 1, param: 0, from: 2500, to: 10000 }) && CFG.programId === PROGRAM_ID && CFG.binary.sha256 === sha(bin), JSON.stringify(CFG.change));
  const bad = spawnSync(process.execPath, [join(DEPLOY, 'stage.mjs'), '--kind', 'devnet', '--tier-fee'], { encoding: 'utf-8' });
  step('R2', 'stage.mjs refuses a fee-change folder for devnet', bad.status === 2 && /--tier-fee is for a mainnet or rehearsal folder/.test(bad.stderr), bad.stderr.trim());

  const url = (f) => new URL(`file:///${f.replace(/\\/g, '/')}`);
  const { makeCore } = await import(url(join(PACK, 'scripts', 'lib', 'tiers.mjs')));
  const { decideFee } = await import(url(join(PACK, 'scripts', 'lib', 'tierFee.mjs')));
  const conn = new web3.Connection(RPC, 'confirmed');
  const core = makeCore({ web3, cfg: CFG });
  const sha256hex = async (b) => sha(Buffer.from(b));
  const state = async (member) => core.readState(conn, { sha256hex, member: member ? member.publicKey?.toBase58?.() ?? member : null });
  const kp = (f) => web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, 'utf-8'))));
  const locals = ['memberA', 'memberB'].map((n) => kp(join(WORK, 'keys', `${n}.json`)));
  const A = locals.find((x) => x.publicKey.toBase58() === CFG.addr.memberA);
  const B = locals.find((x) => x.publicKey.toBase58() === CFG.addr.memberB);
  if (!A || !B) throw new Error('the staged members are not the local member keys');
  const bal = async (k) => BigInt(await conn.getBalance(new web3.PublicKey(k), 'confirmed'));
  const confirm = async (s) => { for (;;) { const x = (await conn.getSignatureStatuses([s])).value[0]; if (x?.err) throw new Error(JSON.stringify(x.err)); if (x?.confirmationStatus === 'confirmed' || x?.confirmationStatus === 'finalized') return; await sleep(300); } };
  const airdrop = async (k, l) => confirm(await conn.requestAirdrop(new web3.PublicKey(k), Number(l)));
  for (const m of [A, B]) await airdrop(m.publicKey.toBase58(), 2e9);
  await airdrop(CFG.addr.vault, 1e9);
  async function act(member, ixs, c = core) {
    const { vtx } = await c.txFor(conn, member.publicKey.toBase58(), ixs);
    vtx.sign([member]);
    const s = await conn.sendRawTransaction(vtx.serialize());
    try { await confirm(s); return { ok: true, sig: s }; } catch (e) { return { ok: false, why: e.message }; }
  }
  const nextIndex = async () => (await core.readMultisig(conn)).transactionIndex + 1;
  const waitLock = async (i) => { const pr = core.decodeProposal((await conn.getAccountInfo(core.proposalPda(i))).data); while ((await core.clock(conn)) < pr.timestamp + LOCK + 1) await sleep(1000); };

  // ---- #19, replayed: both tiers as on mainnet ----------------------------------------------------------
  const tiersCore = makeCore({ web3, cfg: { ...CFG, change: undefined } });
  const i19 = await nextIndex();
  let a = await act(A, tiersCore.proposeIxs(A.publicKey.toBase58(), i19), tiersCore);
  const a2 = await act(B, [tiersCore.approveIx(B.publicKey.toBase58(), i19)], tiersCore);
  await waitLock(i19);
  const a3 = await act(A, [tiersCore.executeIx(A.publicKey.toBase58(), i19)], tiersCore);
  const made = await core.tiers(conn);
  step('P1', '#19\'s own instructions, replayed through the vault, make both tiers', a.ok && a2.ok && a3.ok && made.every((t) => t.state === 'exact'), a.why ?? a2.why ?? a3.why ?? made.map((t) => `${t.want.index}:${t.state}`).join(' '));
  const keys = CFG.tiers.map((t) => core.ammConfig(t.index).toBase58());
  const onMainnet = (await mainnetRpc('getMultipleAccounts', [keys, { encoding: 'base64' }])).value.map((x) => Buffer.from(x.data[0], 'base64'));
  const before = (await conn.getMultipleAccountsInfo(keys.map((k) => new web3.PublicKey(k)))).map((x) => Buffer.from(x.data));
  step('P2', 'the local tiers are byte for byte the two tier accounts on mainnet', before.every((b, i) => b.equals(onMainnet[i])), keys.join(', '));

  // ---- the decision, before the page --------------------------------------------------------------------
  let d = decideFee(CFG, await state(null));
  step('F0', 'the page asks for a member wallet first', d.action === null && /connect a member wallet/.test(d.lines.at(-1).w));
  d = decideFee(CFG, await state(web3.Keypair.generate()));
  step('F1', 'the page offers nothing to a wallet outside the multisig', d.action === null && /not a member/.test(d.lines.at(-1).w));
  d = decideFee(CFG, await state(A));
  step('F2', 'with both tiers as #19 made them, member A may propose', d.action === 'propose' && !d.lines.some((l) => !l.ok), d.lines.at(-1).w);
  const otherBuild = { ...CFG, binary: { ...CFG.binary, sha256: 'ab'.repeat(32) } };
  d = decideFee(otherBuild, await makeCore({ web3, cfg: otherBuild }).readState(conn, { sha256hex, member: A.publicKey.toBase58() }));
  step('F2b', 'a folder made against another build refuses on the same chain (the program was upgraded since)', d.action === null && d.lines.some((l) => !l.ok && /NOT the build this folder was made against/.test(l.w)));

  // A proposal made outside the page: tier 1 to another fee. The page refuses while it is live.
  const iForeign = await nextIndex();
  const foreign = makeCore({ web3, cfg: { ...CFG, change: { ...CFG.change, to: 5_000 } } });
  a = await act(A, foreign.proposeIxs(A.publicKey.toBase58(), iForeign), foreign);
  d = decideFee(CFG, await state(B));
  step('F3', 'a live proposal made outside the page that touches tier 1 stops the page', a.ok && d.action === null && d.lines.some((l) => !l.ok && l.w.includes(`#${iForeign} `)), d.lines.filter((l) => !l.ok).map((l) => l.w).join(' | ').slice(0, 200));
  const rejectIx = (member, i) => new web3.TransactionInstruction({ programId: new web3.PublicKey(CFG.addr.squads), keys: [
    { pubkey: new web3.PublicKey(CFG.addr.multisig), isSigner: false, isWritable: false }, { pubkey: member.publicKey, isSigner: true, isWritable: true }, { pubkey: core.proposalPda(i), isSigner: false, isWritable: true }],
  data: Buffer.concat([createHash('sha256').update('global:proposal_reject').digest().subarray(0, 8), Buffer.from([0])]) });
  a = await act(B, [rejectIx(B, iForeign)]);
  d = decideFee(CFG, await state(A));
  step('F4', 'once member B rejects it, member A may propose again', a.ok && d.action === 'propose', a.why ?? d.lines.at(-1).w);

  // ---- the page, in a headless browser, with a stand-in wallet per member ------------------------------
  page = spawn(process.execPath, [join(PACK, 'proposer', 'serve.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let pageOut = ''; page.stdout.on('data', (b) => { pageOut += b; });
  for (let i = 0; i < 40 && !pageOut.includes('http://127.0.0.1'); i++) await sleep(250);
  const head = await fetch(`http://127.0.0.1:${PAGE_PORT}/`);
  step('W0', 'the page\'s server answers, and forbids being framed by another page', head.status === 200 && head.headers.get('x-frame-options') === 'DENY');
  const evil = await fetch(`http://127.0.0.1:${PAGE_PORT}/rpc`, { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' });
  step('W0b', 'the relay refuses a call from another web page', evil.status === 403);
  const { chromium } = createRequire(join(REPO, 'frontend', 'package.json'))('playwright');
  browser = await chromium.launch();
  const errors = [];
  async function open(member) {
    const ctx = await browser.newContext();
    const tab = await ctx.newPage();
    tab.on('pageerror', (e) => errors.push(e.message)); tab.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await tab.addInitScript(({ pub, secret }) => {
      const sk = Uint8Array.from(secret);
      window.solana = {
        publicKey: { toBase58: () => pub },
        connect: async () => ({ publicKey: { toBase58: () => pub } }),
        disconnect: async () => {},
        signTransaction: async (vtx) => { vtx.sign([{ publicKey: vtx.message.staticAccountKeys[0], secretKey: sk }]); return vtx; },
      };
    }, { pub: member.publicKey.toBase58(), secret: [...member.secretKey] });
    await tab.goto(`http://127.0.0.1:${PAGE_PORT}/`);
    await tab.waitForSelector('#lines li');
    return { ctx, tab };
  }
  const press = async (tab, words, done) => {
    await tab.click('#connect');
    await tab.waitForFunction((w) => document.getElementById('go')?.textContent.includes(w), words, { timeout: 30_000 });
    await tab.click('#go');
    await tab.waitForFunction((w) => document.getElementById('log').textContent.match(new RegExp(w)) || /STOP|FAILED|stopped/.test(document.getElementById('log').textContent), done, { timeout: 90_000 });
    return tab.textContent('#log');
  };

  // Member A proposes, on the page.
  let p = await open(A);
  step('W1', 'the page loads on the local chain and says so', (await p.tab.textContent('#net')).includes('LOCAL'));
  const what = await p.tab.textContent('#what');
  step('W1b', 'it says what the proposal does: tier 1 from 0.25% to 1%, LPs 0.21% then 0.84%, venue 0.026% then 0.104%, island 0.014% then 0.056%',
    (await p.tab.textContent('#title')).includes('fee tier 1, from 0.25% to 1%') && ['0.21%', '0.84%', '0.026%', '0.104%', '0.014%', '0.056%', keys[1]].every((x) => what.includes(x)), what.slice(0, 160));
  const second = await p.ctx.newPage();
  await second.goto(`http://127.0.0.1:${PAGE_PORT}/`);
  await second.waitForFunction(() => /another tab/.test(document.getElementById('act').textContent), null, { timeout: 15_000 }).catch(() => {});
  step('W2', 'a second tab of the page stops itself: one tab at a time', /another tab/.test(await second.textContent('#act')));
  await second.close();
  const idx = await nextIndex();
  const aBefore = await bal(A.publicKey.toBase58());
  let log = await press(p.tab, 'Sign: create the fee proposal and approve it', `proposal #${idx} is created and you approved it`);
  const aSpent = aBefore - (await bal(A.publicKey.toBase58()));
  const vtInfo = await conn.getAccountInfo(core.txPda(idx)); const prInfo = await conn.getAccountInfo(core.proposalPda(idx));
  step('F5', 'member A creates and approves the fee proposal on the page', new RegExp(`proposal #${idx} is created`).test(log), `#${idx}, member A spent ${aSpent} lamports; ${log.slice(0, 120)}`);
  step('F5b', 'the stored proposal is byte for byte the folder\'s, and the folder sized its accounts right', core.isOurs(core.decodeVaultTransaction(vtInfo.data)) && vtInfo.data.length === CFG.squads.vaultTransactionBytes && prInfo.data.length === CFG.squads.proposalBytes,
    `${vtInfo.data.length} / ${CFG.squads.vaultTransactionBytes}, ${prInfo.data.length} / ${CFG.squads.proposalBytes}`);
  await p.ctx.close();
  d = decideFee(CFG, await state(A));
  step('F6', 'member A, having approved, has nothing more to sign', d.action === null && /has your approval/.test(d.lines.at(-1).w));

  // Member B approves, on the page: the lock starts.
  p = await open(B);
  log = await press(p.tab, `Approve proposal #${idx}`, `you approved proposal #${idx}`);
  step('F7', 'member B approves on the page', new RegExp(`you approved proposal #${idx}`).test(log), log.slice(0, 120));
  await p.tab.waitForFunction(() => /time lock holds it until/.test(document.getElementById('lines').textContent), null, { timeout: 30_000 }).catch(() => {});
  step('F8', 'the page then says the time lock holds it, and offers no execute', /time lock holds it until/.test(await p.tab.textContent('#lines')) && !(await p.tab.$('#go')));
  await p.ctx.close();
  const early = await core.simulate(conn, A.publicKey.toBase58(), [core.executeIx(A.publicKey.toBase58(), idx)]);
  step('F9', 'an execute sent around the page before the lock ends is refused by Squads itself', !early.ok && early.logs.some((l) => /TimeLockNotReleased/.test(l)));
  await waitLock(idx);
  d = decideFee(CFG, await state(A));
  step('F10', 'after the lock, the page offers the execute', d.action === 'execute' && d.index === idx, d.lines.at(-1).w);

  // The execute, on the page.
  const vaultBefore = await bal(CFG.addr.vault);
  p = await open(A);
  log = await press(p.tab, `EXECUTE proposal #${idx}`, `proposal #${idx} is EXECUTED`);
  step('F11', 'the page executes the proposal', new RegExp(`proposal #${idx} is EXECUTED`).test(log), log.slice(0, 160));
  await p.tab.click('#again').catch(() => {});
  await p.tab.waitForFunction(() => /ALREADY DONE/.test(document.getElementById('act').textContent), null, { timeout: 30_000 }).catch(() => {});
  step('F12', 'the page then says ALREADY DONE and offers nothing', /ALREADY DONE: fee tier 1 charges 1%/.test(await p.tab.textContent('#act')));
  await p.ctx.close();
  step('W3', 'no error in the page\'s console', errors.length === 0, errors.join(' | ').slice(0, 200));
  step('F13', 'the vault paid nothing', (await bal(CFG.addr.vault)) === vaultBefore, `${vaultBefore - (await bal(CFG.addr.vault))} lamports`);

  // ---- after ----------------------------------------------------------------------------------------------
  const r = packStep('8-verify-tier-fee.mjs');
  step('V1', '8-verify-tier-fee: tier 1 at 1% with its split and owners, tier 0 unchanged', r.code === 0, r.result);
  const after = (await conn.getMultipleAccountsInfo(keys.map((k) => new web3.PublicKey(k)))).map((x) => Buffer.from(x.data));
  const changed = [...after[1].keys()].filter((i) => after[1][i] !== before[1][i]);
  step('V2', 'tier 0\'s account is byte for byte as before; tier 1\'s differs only in its four fee bytes, now 10,000', after[0].equals(before[0]) && changed.every((i) => i >= 47 && i < 51) && after[1].readUInt32LE(47) === 10_000,
    `tier 1 bytes changed at ${changed.join(',')}`);
  d = decideFee(CFG, await state(B));
  step('V3', 'the decision now says done, for either member', d.action === 'done');

  const about = `Rehearsed ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC on a local chain: the range program byte for byte as it runs on mainnet (sha256 ${sha(bin)}), at its own address with the vault as its upgrade authority; the real Squads program; and a copy of the vault's multisig with its two members swapped for local keys and a time lock of ${LOCK} seconds standing in for 48 hours. #19's own instructions, replayed there through the vault, made both tiers byte for byte as they are on mainnet. Then this folder's page, in a headless browser with a stand-in wallet holding each member's local key, proposed (member A), approved (member B) and, after the lock, executed the change. Member A's proposal cost it ${(Number(aSpent) / 1e9).toFixed(6)} SOL at that chain's rent.

| | What was tried | |
|---|---|---|
${results.map((x) => `| ${x.id} | ${x.what} | ${x.pass ? 'passed' : 'FAILED'} |`).join('\n')}

What it could not cover: mainnet itself (its fees, its load, its rate limits), your wallet app on the page (the rehearsal signed with key files), and the 48 hours themselves.`;
  const out = { at: new Date().toISOString(), purpose: 'tier-fee', change: CFG.change, binary: { sha256: sha(bin), bytes: bin.length }, timeLock: LOCK, about, results };
  writeFileSync(join(R, 'rehearsal-results.json'), JSON.stringify(out, null, 1));
  const failed = results.filter((x) => !x.pass);
  console.log(`\nrehearsal: ${results.length} steps, ${failed.length} failed${failed.length ? ': ' + failed.map((x) => x.id).join(', ') : ''}`);
  console.log(`results: ${join(R, 'rehearsal-results.json')}`);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.log(`STOPPED: ${e.stack ?? e}`);
  process.exitCode = 2;
} finally {
  await browser?.close().catch(() => {});
  page?.kill();
  node('validator.mjs', ['--stop']);
  keepAlive.kill();
}
