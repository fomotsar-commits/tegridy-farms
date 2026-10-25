#!/usr/bin/env node
// Makes one of the owner's folders for the range-pool deploy: the scripts, the page (bundled), the
// one program file, START-HERE.md, config.json with every pinned value, and SHA256SUMS. Every address
// and number comes from the repo, the chain or the other owner packs, read at staging time. It
// builds the folder beside its place and moves it in at the end, and never replaces a folder it did
// not make or one the owner has begun to use.
//
//   --kind key        [--out <dir>]                                          the program key's folder: only step 0
//   --kind devnet     --binary <so> --program-key <throwaway key> --rehearsal <results> [--out <dir>]
//   --kind mainnet    --binary <so> --rebuilt <a second build's so> --expect-sha256 <hex> --rehearsal <results> [--out <dir>]
//                     [--tiers-only]: for the program already deployed, only the fee-tier sittings
//   --kind rehearsal  --binary <so> --out <dir> --rpc <local rpc> --program-key <file> --payer-key <file>
//                     --notice-days <d> --notice-repo <url> --position-base <url> [--port <n>] [--pool-pack-peak <lamports>]
//                     [--notice-not-before <ISO time, UTC>]  a notice that names its own date (mainnet: 2026-10-23T14:00:00Z)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedUrl } from './scripts/lib/hosts.mjs';
import { TIERS, NOTICE_LINE, NOTICE_NOT_BEFORE, makeCore } from './scripts/lib/tiers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const fail = (m) => { console.error(`STOPPED: ${m}`); process.exit(2); };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const disc = (s) => createHash('sha256').update(s).digest().subarray(0, 8).toString('hex');
const KIND = opt('--kind');
if (!['key', 'devnet', 'mainnet', 'rehearsal'].includes(KIND)) fail('--kind key|devnet|mainnet|rehearsal');
const STAGED_BY = 'solana/clmm-deploy/stage.mjs';

// ---- the owner's machine: the other packs name these; nothing is typed here ------------------
const RELEASE = 'C:/Users/jimbo/solana-launch-release-2026-09-26';
const POOL = join(RELEASE, 'pool-program-upgrade-2026-10');
const poolPaper = readFileSync(join(POOL, 'START-HERE.md'), 'utf-8');
const poolLib = readFileSync(join(POOL, 'scripts', 'lib', 'pack.mjs'), 'utf-8');
const solanaExe = /^export const SOLANA_EXE = '([^']+)';$/m.exec(poolLib)?.[1]?.replace(/\\\\/g, '\\');
const payerKeyMainnet = /--keypair "(C:\\Users\\jimbo\\solana-keys\\mainnet\\[^"]+\.json)"/.exec(poolPaper)?.[1];
const noOldSbpf = /FEATURE_NO_OLD_SBPF: '(\w+)'/.exec(poolLib)?.[1];
if (!solanaExe || !existsSync(solanaExe)) fail('the owner\'s Solana tool path could not be read from the pool pack');
if (!payerKeyMainnet || !noOldSbpf) fail('the pool pack no longer names the paying key file or the SIMD-0500 rule');
const cli = /^solana-cli (\S+) /.exec(execFileSync(solanaExe, ['--version'], { encoding: 'utf-8' }))?.[1];
const packages = `${RELEASE}/rehearsal/package.json`;
const pkgReq = createRequire(packages);
const web3Version = pkgReq('@solana/web3.js/package.json').version;
const web3Sha256 = sha(readFileSync(pkgReq.resolve('@solana/web3.js')));
const web3 = pkgReq('@solana/web3.js');

// The pool pack pays from the same wallet: its program, its new build, its buffers, its peak.
function poolPack() {
  const program = /CP: '(\w+)'/.exec(poolLib)?.[1];
  const nb = /new: Object\.freeze\(\{ key: 'new', sha256: '(\w{64})', len: (\d+)/.exec(poolLib);
  const rollback = /ROLLBACK_BUFFER_KEY_FILE = '([^']+)'/.exec(poolLib)?.[1];
  const upgrade = /owner-run\\(upgrade-buffer-keypair\.json)/.exec(poolPaper)?.[1];
  const peak = /needs (\d+\.\d+) SOL at its peak/.exec(poolPaper)?.[1];
  if (!program || !nb || !rollback || !upgrade || !peak) fail('the pool pack no longer names its program, new build, buffer key files or peak');
  return { program, newSha256: nb[1], newBytes: Number(nb[2]), bufferKeyFiles: [upgrade, rollback].map((f) => join(POOL, 'owner-run', f).replace(/\//g, '\\')), peakLamports: String(Math.round(Number(peak) * 1e9)) };
}

// The devnet practice folder this mainnet folder follows: its throwaway program and its build.
function devnetRun() {
  const folder = resolve(opt('--devnet-folder') ?? join(RELEASE, 'range-pools-devnet-2026-10'));
  const d = existsSync(join(folder, 'config.json')) ? JSON.parse(readFileSync(join(folder, 'config.json'), 'utf-8')) : null;
  if (d?.stagedBy !== STAGED_BY || d.kind !== 'devnet') fail(`${folder} is not a staged devnet folder: stage it (--kind devnet) before the mainnet folder`);
  return { folder: folder.replace(/\//g, '\\'), rpc: 'https://api.devnet.solana.com', programId: d.programId, sha256: d.binary.sha256, bytes: d.binary.bytes };
}

// ---- the repo: registry, allow-list, deny list, Squads constant, the program's declared id ----
const reg = JSON.parse(readFileSync(join(REPO, 'frontend/scripts/addresses.json'), 'utf-8')).solana;
const row = (id) => { const r = reg.find((x) => x.id === id); if (!r?.address) fail(`addresses.json has no row ${id}`); return r.address; };
const allow = JSON.parse(readFileSync(join(REPO, 'solana/guards/allowed-keys.json'), 'utf-8'));
const placeholder = Object.keys(allow.placeholder ?? {})[0]
  ?? Object.keys(JSON.parse(execFileSync('git', ['-C', REPO, 'show', '50b34098f:solana/guards/allowed-keys.json'], { encoding: 'utf-8' })).placeholder)[0];
const denyKeys = readFileSync(join(REPO, 'solana/guards/upstream/deny-keys.txt'), 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const squads = /SQUADS_V4_PROGRAM_ID = '(\w+)'/.exec(readFileSync(join(REPO, 'frontend/src/lib/launcher/solana/squads.ts'), 'utf-8'))[1];
const libRs = readFileSync(join(REPO, 'solana/tegridy-clmm/programs/amm/src/lib.rs'), 'utf-8');
const declared = /#\[cfg\(not\(feature = "devnet"\)\)\]\ndeclare_id!\("(\w+)"\);/.exec(libRs.replace(/\r/g, ''))?.[1];
// Every key the mainnet build compiles in (each pubkey! not under the devnet feature) is the vault.
const srcKeys = [];
const walkRs = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walkRs(p); else if (n.endsWith('.rs')) srcKeys.push(...keysOf(p)); } };
function keysOf(p) {
  const lines = readFileSync(p, 'utf-8').replace(/\r/g, '').split('\n');
  return lines.flatMap((l, i) => [...l.matchAll(/pubkey!\("(\w+)"\)/g)].map((m) => ({ at: `${relative(REPO, p)}:${i + 1}`, key: m[1], devnet: lines[i - 1]?.trim() === '#[cfg(feature = "devnet")]' })));
}
walkRs(join(REPO, 'solana/tegridy-clmm/programs/amm/src'));
const mainnetKeys = srcKeys.filter((k) => !k.devnet);
if (mainnetKeys.length !== 7 || mainnetKeys.some((k) => k.key !== row('squads-vault'))) fail(`the program's mainnet keys are not the seven vault keys: ${JSON.stringify(mainnetKeys)}`);

// The tier and the notice line are the owner's decisions, pinned in scripts/lib/tiers.mjs.
if (!NOTICE_LINE.includes(`no sooner than ${NOTICE_NOT_BEFORE.slice(0, 10)} ${NOTICE_NOT_BEFORE.slice(11, 16)} UTC`)) fail('the notice line does not name NOTICE_NOT_BEFORE');
const TIERS_ONLY = argv.includes('--tiers-only');
if (TIERS_ONLY && KIND !== 'mainnet') fail('--tiers-only is for a mainnet folder');

async function rpc(url, method, params = []) {
  const r = await fetch(allowedUrl(url, { loopback: KIND === 'rehearsal' }), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) fail(`${url} ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const RPCS = { mainnet: 'https://api.mainnet-beta.solana.com', devnet: 'https://api.devnet.solana.com', testnet: 'https://api.testnet.solana.com' };
const CHECK_RPC = 'https://solana-rpc.publicnode.com'; // a second, separate mainnet RPC, for the page's cross-check
const genesis = {};
for (const [k, u] of Object.entries(RPCS)) genesis[k] = await rpc(u, 'getGenesisHash');
if (await rpc(CHECK_RPC, 'getGenesisHash') !== genesis.mainnet) fail(`${CHECK_RPC} is not mainnet`);

// ---- what the multisig is, read from the chain the folder is for (mainnet but for a rehearsal) --
const chainRpc = KIND === 'rehearsal' ? opt('--rpc') : RPCS.mainnet;
if (!chainRpc) fail('--rpc <local rpc> for a rehearsal');
const multisig = row('squads-multisig');
const msInfo = await rpc(chainRpc, 'getAccountInfo', [multisig, { encoding: 'base64' }]);
const ms = Buffer.from(msInfo.value.data[0], 'base64');
if (msInfo.value.owner !== squads || ms.subarray(0, 8).toString('hex') !== disc('account:Multisig')) fail('the multisig on that chain is not a Squads multisig');
const o = 94 + (ms[94] ? 33 : 1) + 1;
const members = [];
for (let i = 0, n = ms.readUInt32LE(o), p = o + 4; i < n; i++, p += 33) members.push(new web3.PublicKey(ms.subarray(p, p + 32)).toBase58());
const timeLock = ms.readUInt32LE(74);
if (KIND !== 'rehearsal' && timeLock !== 172_800) fail(`mainnet's time lock reads ${timeLock}, not 172,800`);
const cp = await rpc(RPCS.mainnet, 'getAccountInfo', [row('cp-swap-program-restart'), { encoding: 'base64' }]);
const loader = cp.value.owner;

// ---- the program file ------------------------------------------------------------------------
let binary = null;
let programId = null;
const keyAddress = (f) => execFileSync(solanaExe, ['address', '-k', f], { encoding: 'utf-8' }).trim();
if (KIND !== 'key') {
  const so = opt('--binary');
  if (!so || !existsSync(so)) fail('--binary <raydium_clmm.so>');
  const b = readFileSync(so);
  if (KIND === 'mainnet') {
    // Two builds made apart, byte for byte the same, and the hash given on the command line.
    const again = opt('--rebuilt');
    if (!again || !existsSync(again)) fail('--rebuilt <a second build of the same commit, made in a fresh copy>');
    if (sha(readFileSync(again)) !== sha(b)) fail(`the two builds differ: ${sha(b)} and ${sha(readFileSync(again))}`);
    if (opt('--expect-sha256') !== sha(b)) fail(`the builds hash to ${sha(b)}, not --expect-sha256 ${opt('--expect-sha256')}`);
    if (!declared || declared === placeholder) fail('lib.rs still declares the placeholder: the program-id change is not in this checkout');
    programId = declared;
  } else {
    if (!opt('--program-key')) fail('--program-key <file>');
    programId = keyAddress(opt('--program-key'));
  }
  if (b.indexOf(new web3.PublicKey(programId).toBuffer()) < 0) fail(`the binary does not name ${programId}`);
  if (b.indexOf(new web3.PublicKey(placeholder).toBuffer()) >= 0) fail('the binary still holds the placeholder id');
  binary = { file: `binary-to-deploy/raydium_clmm.${sha(b).slice(0, 8)}.so`, bytes: b.length, sha256: sha(b), src: so };
}
// A tiers-only folder is for the program already on mainnet: byte for byte this build, the vault
// its upgrade authority.
let deployedSlot = null;
if (TIERS_ONLY) {
  const p = await rpc(RPCS.mainnet, 'getAccountInfo', [programId, { encoding: 'base64' }]);
  const stub = p?.value && Buffer.from(p.value.data[0], 'base64');
  if (!stub || p.value.owner !== loader || stub.length !== 36) fail(`${programId} is not deployed on mainnet: stage the full mainnet folder`);
  const dataId = new web3.PublicKey(stub.subarray(4, 36)).toBase58();
  const d = Buffer.from((await rpc(RPCS.mainnet, 'getAccountInfo', [dataId, { encoding: 'base64' }])).value.data[0], 'base64');
  if (d[12] !== 1 || new web3.PublicKey(d.subarray(13, 45)).toBase58() !== row('squads-vault')) fail('the program\'s upgrade authority is not the vault');
  if (sha(d.subarray(45, 45 + binary.bytes)) !== binary.sha256 || !d.subarray(45 + binary.bytes).every((x) => x === 0)) fail('the program on mainnet is not byte for byte this build');
  deployedSlot = Number(d.readBigUInt64LE(4));
}
const reh = opt('--rehearsal') ? JSON.parse(readFileSync(opt('--rehearsal'), 'utf-8')) : null;
if (['devnet', 'mainnet'].includes(KIND) && (!reh || !reh.results.length || reh.results.some((x) => !x.pass))) fail('--rehearsal <rehearsal-results.json> of a rehearsal where every step passed');

// ---- where: a new folder, or one this script made that the owner has not begun to use ----------
const OUT = resolve(opt('--out') ?? join(RELEASE, TIERS_ONLY ? 'range-pools-tiers-2026-10' : { key: 'range-pools-key-2026-10', devnet: 'range-pools-devnet-2026-10', mainnet: 'range-pools-deploy-2026-10', rehearsal: '' }[KIND]));
if (KIND === 'rehearsal' && !opt('--out')) fail('--out <dir> for a rehearsal');
if (existsSync(OUT)) {
  const prev = existsSync(join(OUT, 'config.json')) ? JSON.parse(readFileSync(join(OUT, 'config.json'), 'utf-8')) : null;
  if (prev?.stagedBy !== STAGED_BY) fail(`${OUT} exists and was not made by this script: it is never replaced. Choose another --out`);
  const used = existsSync(join(OUT, 'owner-run')) && readdirSync(join(OUT, 'owner-run')).length > 0;
  if (used) fail(`${OUT} is in use (its owner-run folder holds files): a folder in use is never restaged over. Choose another --out`);
}
const TMP = join(dirname(OUT), `.${basename(OUT)}.staging-${process.pid}`);
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'owner-run'), { recursive: true });

/** The paper's account of the rehearsal, from rehearse.mjs's results. */
function rehearsalWords(r) {
  const rows = r.results.map((x) => `| ${x.id} | ${x.what} | ${x.pass ? 'passed' : 'FAILED'} |`).join('\n');
  return `Rehearsed ${r.at.slice(0, 16).replace('T', ' ')} UTC on a local chain. Your own Solana tool (${r.cli}) did the uploads, the deploy and the hand-over. The page's own code made, approved and executed the proposal against the real Squads program and a copy of the vault's multisig (its members swapped for local keys; a time lock of ${r.timeLock} seconds stood in for 48 hours, and a notice of ${r.noticeSeconds} seconds for 7 days; a stand-in for GitHub served the changelog's history and a stand-in for the website the position link). The program file there was this one rebuilt for a throwaway address. Everything else was this folder's.

${r.peakWords}

| | What was tried | |
|---|---|---|
${rows}

What it could not cover: mainnet itself (its fees, its load, its rate limits), GitHub and the real website, your wallet app on the page (the rehearsal signed with key files), and the 48 hours and the 7 days themselves.`;
}

const vtBytes = (msgLen) => 8 + 32 + 32 + 8 + 1 + 1 + 1 + 4 + msgLen;
const local = KIND === 'rehearsal' ? chainRpc : null;
const cfg = {
  stagedBy: STAGED_BY, kind: KIND, tiersOnly: TIERS_ONLY, stagedAt: new Date().toISOString(), repoCommit: execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
  programId, binary: binary && { file: binary.file, bytes: binary.bytes, sha256: binary.sha256 }, placeholder,
  addr: {
    vault: row('squads-vault'), multisig, squads, loader, memberA: members[0], memberB: members[1],
    deployWallet: KIND === 'rehearsal' ? keyAddress(opt('--payer-key')) : row('tegridy-launch-deployer'),
    workshop: row('island-workshop-wallet'),
  },
  keyFiles: {
    payer: KIND === 'rehearsal' ? resolve(opt('--payer-key')) : payerKeyMainnet,
    program: ['rehearsal', 'devnet'].includes(KIND) ? resolve(opt('--program-key')) : 'C:\\Users\\jimbo\\solana-keys\\mainnet\\tegridy-clmm-program-keypair.json',
  },
  bufferKeyFile: 'buffer-keypair.json',
  solanaExe, cli, packages, web3Version, web3Sha256,
  rpc: { mainnet: RPCS.mainnet, devnet: RPCS.devnet, local, check: KIND === 'rehearsal' ? local : CHECK_RPC },
  genesis, features: { noOldSbpf },
  tiers: TIERS, timeLock,
  notice: {
    line: NOTICE_LINE, days: KIND === 'rehearsal' ? Number(opt('--notice-days')) : 7, files: ['CHANGELOG.md', 'docs/CHANGELOG_EARLIER.md'],
    ...(KIND === 'mainnet' ? { notBefore: NOTICE_NOT_BEFORE } : KIND === 'rehearsal' && opt('--notice-not-before') ? { notBefore: opt('--notice-not-before') } : {}),
    repo: KIND === 'rehearsal'
      ? { api: `${opt('--notice-repo')}/api`, raw: `${opt('--notice-repo')}/raw`, branch: 'mvp-launch' }
      : { api: 'https://api.github.com/repos/fomotsar-commits/tegridy-farms', raw: 'https://raw.githubusercontent.com/fomotsar-commits/tegridy-farms', branch: 'mvp-launch' },
  },
  positionLink: { base: KIND === 'rehearsal' ? opt('--position-base') : 'https://memetics.finance/position/', expect: 'No range position at this address.' },
  poolPack: KIND === 'mainnet' && !TIERS_ONLY ? poolPack() : KIND === 'rehearsal' && opt('--pool-pack-peak')
    ? { program: web3.Keypair.generate().publicKey.toBase58(), newSha256: '0'.repeat(64), newBytes: 1, bufferKeyFiles: [join(OUT, 'no-such-pool-buffer-1.json'), join(OUT, 'no-such-pool-buffer-2.json')], peakLamports: opt('--pool-pack-peak') }
    : null,
  devnetRun: KIND === 'mainnet' && !TIERS_ONLY ? devnetRun() : null,
  page: { port: Number(opt('--port') ?? 5499) },
  cuPrice: 10_000, feeAllowanceLamports: 30_000_000,
  denyKeys,
  disc: Object.fromEntries([
    ...['create_amm_config', 'update_amm_config', 'vault_transaction_create', 'proposal_create', 'proposal_approve', 'vault_transaction_execute'].map((n) => [n, disc(`global:${n}`)]),
    ...['AmmConfig', 'Multisig', 'Proposal', 'VaultTransaction', 'ConfigTransaction', 'Batch'].map((n) => [n, disc(`account:${n}`)]),
  ]),
  squads: { multisigDisc: disc('account:Multisig'), proposalBytes: 8 + 32 + 8 + 9 + 1 + 3 * (4 + 32 * members.length) },
};
if (KIND === 'rehearsal' && (!cfg.notice.days || !opt('--notice-repo') || !cfg.positionLink.base)) fail('a rehearsal needs --notice-days, --notice-repo and --position-base');
// The proposal's message size, from the very module the page uses.
if (programId) {
  const core = makeCore({ web3, cfg });
  cfg.squads.vaultTransactionBytes = vtBytes(3 + 4 + 32 * core.EXPECTED.message.accountKeys.length + 4 + core.EXPECTED.message.instructions.reduce((s, ix) => s + 1 + 4 + ix.accountIndexes.length + 4 + ix.data.length / 2, 0) + 4);
}
// What the chains answered goes into config.json only in the shapes it must have.
const isKey = (k) => { try { return new web3.PublicKey(k).toBase58() === k; } catch { return false; } };
if (!Object.values(cfg.genesis).every(isKey) || cfg.addr.loader !== 'BPFLoaderUpgradeab1e11111111111111111111111'
  || !members.every(isKey) || members.length !== 2 || !Number.isSafeInteger(cfg.timeLock) || cfg.timeLock < 0) {
  rmSync(TMP, { recursive: true, force: true }); fail('a chain answered in a shape this folder does not take: nothing was written');
}
writeFileSync(join(TMP, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');

// ---- the files ---------------------------------------------------------------------------------
if (KIND === 'key') {
  // The key folder holds only the key check and what it shares.
  mkdirSync(join(TMP, 'scripts'), { recursive: true });
  copyFileSync(join(HERE, 'scripts', '0-program-key.mjs'), join(TMP, 'scripts', '0-program-key.mjs'));
  cpSync(join(HERE, 'scripts', 'lib'), join(TMP, 'scripts', 'lib'), { recursive: true });
} else {
  cpSync(join(HERE, 'scripts'), join(TMP, 'scripts'), { recursive: true });
  if (TIERS_ONLY) for (const f of ['0-program-key.mjs', '1-preflight.mjs', '2-verify-buffer.mjs', '3-deploy.mjs', '7-close-buffer.mjs']) rmSync(join(TMP, 'scripts', f));
  if (KIND === 'devnet') for (const f of ['5-record-notice.mjs', '6-verify-tiers.mjs']) rmSync(join(TMP, 'scripts', f));
  else {
    mkdirSync(join(TMP, 'proposer'), { recursive: true });
    for (const f of ['serve.mjs', 'index.html', 'style.css']) copyFileSync(join(HERE, 'proposer', f), join(TMP, 'proposer', f));
    // rolldown, the bundler vite ships; the Solana library from the release folder's pinned copy,
    // the same one the scripts load (CFG.web3Version), so the page and the scripts agree.
    const fe = join(REPO, 'frontend', 'node_modules');
    const { rolldown } = await import(new URL(`file:///${join(fe, 'rolldown', 'dist', 'index.mjs').replace(/\\/g, '/')}`));
    const bundle = await rolldown({
      input: join(HERE, 'proposer', 'app.js'), platform: 'browser', cwd: HERE, logLevel: 'warn',
      resolve: { modules: [join(dirname(packages), 'node_modules'), fe], mainFields: ['browser', 'module', 'main'], conditionNames: ['browser', 'import', 'module', 'default'] },
      transform: { define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' } },
    });
    await bundle.write({ file: join(TMP, 'proposer', 'app.bundle.js'), format: 'esm', minify: false, sourcemap: false });
    await bundle.close();
  }
  mkdirSync(join(TMP, 'binary-to-deploy'), { recursive: true });
  copyFileSync(binary.src, join(TMP, binary.file));
}

// ---- the paper: every blank filled from the values above and mainnet's rent today -------------
const mrent = async (n) => BigInt(await rpc(RPCS.mainnet, 'getMinimumBalanceForRentExemption', [n]));
const SOL = (l, d) => (Number(l) / 1e9).toFixed(d);
const win = (p) => p.replace(/\//g, '\\');
const fill = {
  STAGED: cfg.stagedAt.replace(/\.\d+Z$/, 'Z'), STAGED_DAY: cfg.stagedAt.slice(0, 10), COMMIT: cfg.repoCommit.slice(0, 12), PACK: win(OUT),
  SOLANA: solanaExe, KEYGEN: solanaExe.replace(/solana\.exe$/, 'solana-keygen.exe'), PROGRAM_KEY: cfg.keyFiles.program, PAYER_KEY: cfg.keyFiles.payer,
  PAYER: cfg.addr.deployWallet, VAULT: cfg.addr.vault, MULTISIG: cfg.addr.multisig, WORKSHOP: cfg.addr.workshop, MEMBER_A: cfg.addr.memberA, MEMBER_B: cfg.addr.memberB,
  FOR: { key: 'the program key only', devnet: 'DEVNET only (the practice run, with a throwaway address)', mainnet: 'MAINNET', rehearsal: 'a LOCAL REHEARSAL chain only' }[KIND],
  DEVNET_PACK: win(join(RELEASE, 'range-pools-devnet-2026-10')), MAINNET_PACK: win(join(RELEASE, 'range-pools-deploy-2026-10')),
};
if (binary) {
  const [bufferRent, dataRent, progRent, tierRent, opRent] = await Promise.all([37 + binary.bytes, 45 + binary.bytes, 36, 117, 3529].map(mrent));
  const [vtRent, prRent] = cfg.squads.vaultTransactionBytes ? await Promise.all([cfg.squads.vaultTransactionBytes, cfg.squads.proposalBytes].map(mrent)) : [0n, 0n];
  const fees = reh ? BigInt(reh.lamports.uploadFees) : BigInt(Math.ceil(binary.bytes / 1000) * 5000);
  const need = bufferRent + progRent + (dataRent > bufferRent ? dataRent - bufferRent : 0n) + BigInt(cfg.feeAllowanceLamports);
  Object.assign(fill, {
    PROGRAM_ID: programId, BINARY_FILE: binary.file, BINARY_FILE_WIN: win(binary.file), BYTES: binary.bytes.toLocaleString('en-US'), SHA256: binary.sha256,
    DATA_BYTES: (45 + binary.bytes).toLocaleString('en-US'), DATA_SOL: SOL(dataRent, 4), PROG_SOL: SOL(progRent, 5), BUFFER_SOL: SOL(bufferRent, 4),
    FEES_SOL: SOL(fees, 4), TIERS_SOL: SOL(tierRent * BigInt(TIERS.length), 4), OP_SOL: SOL(opRent, 4), MEMBER_A_SOL: SOL(vtRent + prRent + 5000n, 4),
    NEED_PAYER: (Math.ceil(Number(need) / 1e7) / 100).toFixed(2), SPENT_SOL: SOL(dataRent + progRent + fees, 3),
    POOL_PEAK: cfg.poolPack ? SOL(cfg.poolPack.peakLamports, 3) : '0',
    CU_PRICE: String(cfg.cuPrice), MAINNET_RPC: RPCS.mainnet, PORT: String(cfg.page.port), BUFFER_KEY_FILE: cfg.bufferKeyFile, NOTICE_LINE, NOTICE_WHEN: cfg.notice.notBefore ? `${cfg.notice.notBefore.replace('T', ' ').replace(':00Z', ' UTC')}` : `${cfg.notice.days} days after the notice`,
    REHEARSAL: reh ? rehearsalWords(reh) : 'Not yet run for this folder.',
  });
}
// The notice's date as the page and 5-record-notice.mjs each print it.
if (cfg.notice.notBefore) Object.assign(fill, { NOTICE_WHEN_PAGE: cfg.notice.notBefore, NOTICE_WHEN_SCRIPT: new Date(cfg.notice.notBefore).toISOString() });
if (TIERS_ONLY) fill.DEPLOYED_SLOT = deployedSlot.toLocaleString('en-US');
const template = TIERS_ONLY ? 'START-HERE-TIERS.md' : { key: 'START-HERE-KEY.md', devnet: 'START-HERE-DEVNET.md', mainnet: 'START-HERE.md', rehearsal: 'START-HERE.md' }[KIND];
const paper = readFileSync(join(HERE, template), 'utf-8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
const left = [...new Set(paper.match(/\{\{\w+\}\}/g) ?? [])];
if (left.length) { rmSync(TMP, { recursive: true, force: true }); fail(`the paper has blanks this staging cannot fill: ${left.join(' ')}`); }
writeFileSync(join(TMP, 'START-HERE.md'), paper);

// A folder that makes or executes the tiers has its page; a devnet or key folder has none.
const hasPage = existsSync(join(TMP, 'proposer', 'app.bundle.js'));
if (hasPage !== ['mainnet', 'rehearsal'].includes(KIND)) { rmSync(TMP, { recursive: true, force: true }); fail(`a ${KIND} folder ${hasPage ? 'must not have' : 'must have'} the page`); }

const all = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== 'owner-run') walk(p); } else all.push(p); } };
walk(TMP);
writeFileSync(join(TMP, 'SHA256SUMS'), all.filter((p) => !p.endsWith('SHA256SUMS')).sort().map((p) => `${sha(readFileSync(p))}  ${relative(TMP, p).replace(/\\/g, '/')}`).join('\n') + '\n');
// Only now does the old folder (made by this script, unused) give way.
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
renameSync(TMP, OUT);
console.log(`staged a ${KIND} folder at ${OUT}`);
console.log(`  program ${programId ?? '(not yet: only step 0)'}${binary ? `, binary sha256 ${binary.sha256} (${binary.bytes} bytes)` : ''}`);
console.log(`  members ${members.join(', ')}, time lock ${timeLock} s, solana ${cli}, web3 ${web3Version}`);
