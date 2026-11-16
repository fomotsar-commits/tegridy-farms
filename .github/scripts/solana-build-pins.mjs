#!/usr/bin/env node
// The Solana build pipeline's own pins, checked on every solana-ci run from the repo root:
//   node .github/scripts/solana-build-pins.mjs
// Each rule keeps one finding of the Solana audit of 2026-11-15 closed. A run that checked
// nothing fails, so "found nothing wrong" and "looked at nothing" never share an exit code.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { inScope } from './diff-scope.mjs';
import { buildFlags } from '../../solana/guards/key-guard.mjs';

const WF = '.github/workflows/';
const read = (p) => readFileSync(p, 'utf-8');
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l));
// A workflow's jobs, comments dropped, each from its `  name:` line to the next one.
const jobsOf = (f) => code(read(WF + f)).join('\n').split('\njobs:\n')[1].split(/\n(?= {2}[a-z][a-z0-9-]*:\n)/);
const runsBefore = (job, cmd, step) => job.includes(cmd) && job.indexOf(cmd) < job.indexOf(`- name: ${step}\n`);
const problems = [];
let checked = 0;
const rule = (ok, msg) => {
  checked += 1;
  if (!ok) problems.push(msg);
};

// XCHL-03: avm comes from one named commit, never a branch that moves.
const AVM = /cargo install --git https:\/\/github\.com\/otter-sec\/anchor --rev ([0-9a-f]{40}) avm --locked --force$/;
const installs = readdirSync(WF)
  .filter((f) => /\.ya?ml$/.test(f))
  .flatMap((f) => code(read(WF + f)).filter((l) => l.includes('cargo install --git')).map((l) => [f, l.trim()]));
rule(installs.length === 4, `found ${installs.length} avm installs, expected 4`);
for (const [f, l] of installs) rule(AVM.test(l), `${f}: "${l}" does not install avm from one pinned commit`);
rule(new Set(installs.map(([, l]) => AVM.exec(l)?.[1])).size === 1, 'the avm installs name different commits');

// XCHL-11: no downloaded installer runs unchecked. Every Solana and Anchor install goes through
// solana-tools.sh, which pins each file it fetches by sha256 and refuses a version it has none for.
const TOOLS = '.github/scripts/solana-tools.sh';
const tools = existsSync(TOOLS) ? read(TOOLS) : '';
const shas = [...tools.matchAll(/(?:release|tools_sha)=(\S+)|\b([0-9a-f]{64})\b/g)].map((m) => m[1] ?? m[2]);
rule(shas.length === 6 && shas.every((s) => /^[0-9a-f]{64}$/.test(s)), `${TOOLS} pins ${shas.length} files, not each of the 6 by sha256`);
rule(tools !== '' && buildFlags(tools).length === 0, `${TOOLS} is missing or sets a build flag`);
rule(spawnSync('bash', [TOOLS, 'solana', 'v0.0.0'], { encoding: 'utf-8' }).stdout?.includes('no pinned sha256'), `${TOOLS} does not refuse a version it pins nothing for`);
for (const f of ['solana-ci.yml', 'solana-deploy-artifact.yml']) {
  const text = code(read(WF + f)).join('\n');
  rule(!/release\.anza\.xyz|sh -c "\$\(curl|curl[^\n]*\|\s*(?:ba)?sh\b/.test(text), `${f} runs a downloaded installer unchecked`);
  for (const [, kind, v] of text.matchAll(/^ +(?:CLMM_)?(SOLANA|ANCHOR)_VERSION: (\S+)$/gm)) rule(tools.includes(`"${kind.toLowerCase()} ${v}")`), `${TOOLS} pins nothing for ${kind.toLowerCase()} ${v}, which ${f} installs`);
  for (const job of jobsOf(f)) {
    const name = job.split(':')[0].trim();
    if (job.includes('- name: Install Solana CLI')) rule(/solana-tools\.sh" solana "\$\{(?:CLMM_)?SOLANA_VERSION\}"/.test(job), `${f}: ${name} installs Solana without solana-tools.sh`);
    const anchor = job.indexOf('solana-tools.sh" anchor "$ANCHOR_VERSION"');
    if (job.includes('avm install')) rule(anchor > -1 && anchor < job.indexOf('avm install'), `${f}: ${name} lets avm fetch Anchor and its compiler unchecked`);
  }
}

// LDR-03, XCHL-19: before building, the deploy job holds a mainnet ladder or launcher build to
// the registry's identities. Seen working here, not only present.
const DEPLOY_JOBS = jobsOf('solana-deploy-artifact.yml');
rule(DEPLOY_JOBS.length === 2, `solana-deploy-artifact.yml has ${DEPLOY_JOBS.length} jobs, expected 2`);
const GATE = 'node .github/scripts/solana-mainnet-gate.mjs';
for (const job of DEPLOY_JOBS) rule(runsBefore(job, GATE, 'Build'), `${job.split(':')[0].trim()} does not run the mainnet gate before it builds`);
const gate = (env, cwd = '.') => spawnSync(process.execPath, [resolve(GATE.split(' ')[1])], { cwd, env: { PATH: process.env.PATH, ...env } }).status;
const registry = (id) => JSON.parse(read('frontend/scripts/addresses.json')).solana.find((r) => r.id === id)?.address;
const TRUNK = { CLUSTER: 'mainnet', REF: 'refs/heads/mvp-launch' };
const LADDER = { ...TRUNK, PROGRAM: 'bayla-ladder', PROGRAM_ID: registry('bayla-ladder-program'), DEPLOYER: registry('bayla-ladder-deployer') };
const LAUNCH = { ...TRUNK, PROGRAM: 'tegridy-launch', PROGRAM_ID: registry('tegridy-launch-program-restart'), DEPLOYER: registry('tegridy-launch-deployer') };
rule(gate(LADDER) === 0, "the mainnet gate refuses the ladder at the registry's identities");
rule(gate(LAUNCH) === 0, "the mainnet gate refuses the launcher at the registry's identities");
rule(gate({ ...LADDER, PROGRAM_ID: LADDER.DEPLOYER }) === 1, 'the mainnet gate passes a ladder program id the registry does not hold');
rule(gate({ ...LAUNCH, DEPLOYER: LADDER.DEPLOYER }) === 1, 'the mainnet gate passes a launcher deployer the registry does not hold');
rule(gate(LADDER, WF) === 1, 'the mainnet gate passes when it cannot read the registry');

// XCHL-08: a mainnet build only from mvp-launch or a tag on it, both guards before building,
// and every deployable build (and each one whose hash CI prints) is --locked (SC-5).
rule(gate({ ...TRUNK, PROGRAM: 'cp-swap' }) === 0, 'the mainnet gate refuses a cp-swap build from mvp-launch');
rule(gate({ ...TRUNK, PROGRAM: 'cp-swap', REF: 'refs/heads/feature' }) === 1, 'the mainnet gate passes a build from a branch that is not mvp-launch');
for (const job of DEPLOY_JOBS) {
  for (const g of ['node solana/guards/provenance.mjs', 'node solana/guards/key-guard.mjs']) rule(runsBefore(job, g, 'Build'), `${job.split(':')[0].trim()} does not run ${g} before it builds`);
}
const lines = (f, re) => code(read(WF + f)).map((l) => l.trim()).filter((l) => re.test(l));
const SBF = /(?:^|[;&|({]\s*|\b(?:if|then|else|do)\s+)cargo build-sbf\b/;
const sbf = [...lines('solana-deploy-artifact.yml', SBF), ...lines('solana-ci.yml', SBF).filter((l) => !l.includes('--features devnet'))];
const ladder = ['solana-deploy-artifact.yml', 'solana-ci.yml'].flatMap((f) => lines(f, /\banchor build -p bayla_ladder\b/));
const idl = ['solana-deploy-artifact.yml', 'solana-ci.yml'].flatMap((f) => lines(f, /\banchor idl build\b/));
rule(sbf.length >= 10 && ladder.length === 3 && idl.length === 3, `found ${sbf.length} build-sbf, ${ladder.length} ladder and ${idl.length} IDL builds`);
for (const l of [...sbf, ...ladder]) rule(/ -- --locked\b/.test(l), `"${l}" builds without --locked`);
for (const l of ladder) rule(l.includes('--no-idl'), `"${l}" makes the IDL with arguments its cargo test cannot take`);
for (const l of idl) rule(/ --locked\b/.test(l), `"${l}" makes the IDL without --locked`);

// XCHL-09: solana-ci runs when anything that changes how the programs build changes, not
// only a file under solana/. The scope job's own patterns are read and matched.
const scoped = [...(/diff-scope\.mjs \\\n((?: +'[^']+'[^\n]*\n)+)/.exec(read(WF + 'solana-ci.yml'))?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
for (const f of ['.cargo/config.toml', 'rust-toolchain', 'rust-toolchain.toml', `${WF}solana-deploy-artifact.yml`, '.github/scripts/diff-scope.mjs', '.github/scripts/solana-mainnet-gate.mjs']) {
  rule(scoped.length > 0 && inScope([f], scoped), `a pull request that changes only ${f} skips solana-ci`);
}

// CPS-12: each mainnet build CI prints is compared with the committed hash of that file.
const PINNED = '.github/scripts/solana-mainnet-builds.sha256';
const pinned = existsSync(PINNED) ? code(read(PINNED)).filter((l) => l.trim()) : [];
const CI_JOBS = Object.fromEntries(jobsOf('solana-ci.yml').map((j) => [j.split(':')[0].trim(), j]));
for (const [job, so] of [['build', 'raydium_cp_swap.so'], ['launch-curve', 'tegridy_launch.so'], ['clmm-build', 'raydium_clmm.so']]) {
  rule(pinned.filter((l) => new RegExp(`^[0-9a-f]{64}  ${so.replace('.', '\\.')}$`).test(l)).length === 1, `${PINNED} holds no single hash for ${so}`);
  const check = `grep ' ${so.replace('.', '\\.')}$' "$GITHUB_WORKSPACE/${PINNED}" | sha256sum -c -`;
  rule((CI_JOBS[job] ?? '').includes(check), `${job} prints the hash of ${so} without comparing it with ${PINNED}`);
}
rule(pinned.length === 3, `${PINNED} holds ${pinned.length} lines, expected 3`);

// XCHL-29: every job has a time limit. XCHL-23: a cargo cache key names the Solana and Rust
// versions it was made with, not only the lock.
for (const f of ['solana-ci.yml', 'solana-deploy-artifact.yml', 'raydium-watch.yml']) {
  for (const job of existsSync(WF + f) ? jobsOf(f) : []) rule(/^ {4}timeout-minutes: \d+$/m.test(job), `${f}: ${job.split(':')[0].trim()} has no time limit`);
}
const keys = Object.values(CI_JOBS).flatMap((j) => j.match(/^ {10}key: .*$/gm) ?? []);
rule(keys.length === 4, `found ${keys.length} cargo cache keys, expected 4`);
for (const k of keys) rule(/env\.(CLMM_)?SOLANA_VERSION/.test(k) && k.includes('steps.rust.outputs.cachekey'), `"${k.trim()}" names no tool version`);

// RU-05: a weekly run reads whether Raydium re-deployed or moved either program the pools copy.
const WATCH = existsSync(`${WF}raydium-watch.yml`) ? code(read(`${WF}raydium-watch.yml`)).join('\n') : '';
rule(/^ {4}- cron: "\d+ \d+ \* \* \d"$/m.test(WATCH), 'raydium-watch.yml does not run weekly');
rule(/^ {8}run: node \.github\/scripts\/solana-raydium-watch\.mjs$/m.test(WATCH), 'raydium-watch.yml does not run solana-raydium-watch.mjs');

// XCHL-16, NE-03: no compose file hands the host's Solana key folder to a container, and the
// devnet deploy script names devnet and its key on each command instead of changing settings.
rule(!existsSync('solana/tegridy-amm/docker-compose.yml'), 'solana/tegridy-amm/docker-compose.yml mounts the Solana key folder again');
const devnet = code(read('solana/tegridy-amm/deploy-devnet.sh')).map((l) => l.trim());
rule(!devnet.some((l) => /\bsolana config set\b/.test(l)), "deploy-devnet.sh changes the operator's Solana settings");
const onChain = devnet.filter((l) => /\b(?:solana (?:balance|airdrop|program)|spl-token create-account)\b/.test(l));
rule(onChain.length === 6, `deploy-devnet.sh has ${onChain.length} commands that reach a cluster, expected 6`);
for (const l of onChain) rule(l.includes('--url devnet') && /--(?:keypair|fee-payer) "\$PAYER"/.test(l), `deploy-devnet.sh: "${l}" does not name devnet and its key`);

if (checked === 0) problems.push('checked nothing');
for (const p of problems) console.log(`::error::${p}`);
console.log(`${checked} pins checked, ${problems.length} broken`);
process.exit(problems.length ? 1 : 0);
