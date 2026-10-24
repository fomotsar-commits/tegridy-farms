// Step 2: start solana-test-validator in WSL with the copies setup.mjs wrote, detached so it
// outlives this process. Our program loads at the id lib.rs declares, with the vault as its upgrade
// authority; no program key exists or is made. `--stop` kills only the PID this script started.
// usage: node validator.mjs [--real-lock] [--no-clmm] | --stop     env: CLMM_SO (WSL path of the .so), CLMM_LEDGER
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORK } from './lib/config.mjs';

const LEDGER = process.env.CLMM_LEDGER || '/root/clmm-p1/ledger';
// Ports from one base, so several chains can run side by side (run-mutants.mjs uses three).
const P = Number(process.env.CLMM_PORT || 18899);
const PID = `${LEDGER}.pid`;
const sh = (script) => spawnSync('wsl', ['-e', 'bash', '-lc', script], { stdio: 'inherit' }).status ?? 1;

if (process.argv.includes('--stop')) {
  process.exit(sh(`[ -f ${PID} ] || { echo no pid file; exit 0; }; P=$(cat ${PID}); ` +
    `grep -q solana-test-validator /proc/$P/cmdline 2>/dev/null && kill $P && echo stopped $P; rm -f ${PID}`));
}

const m = JSON.parse(readFileSync(join(WORK, 'manifest.json'), 'utf-8'));
const A = m.addresses;
const wsl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
const W = wsl(WORK);
const SO = process.env.CLMM_SO || '/root/clmm-p1/tegridy-clmm/target/deploy/raydium_clmm.so';
const multisigFile = process.argv.includes('--real-lock') ? 'multisig-real-lock.json' : 'multisig.json';

const args = [
  // Ports of its own: another session's validator may hold the defaults on this machine.
  '--reset', '--quiet', '--ledger', LEDGER, '--rpc-port', String(P), '--faucet-port', String(P + 1001),
  '--gossip-port', String(P - 898), '--dynamic-port-range', `${P - 799}-${P - 599}`,
  // --no-clmm: the deploy pack's rehearsal deploys the program itself.
  ...(process.argv.includes('--no-clmm') ? [] : ['--upgradeable-program', A.program, SO, process.env.CLMM_UPGRADE_AUTH || A.vault]),
  '--bpf-program', A.squads, `${W}/mainnet/squads.so`,
  '--bpf-program', A.token2022, `${W}/mainnet/token2022.so`,
  '--bpf-program', A.token, `${W}/mainnet/token.so`,
  '--bpf-program', A.ata, `${W}/mainnet/ata.so`,
  '--bpf-program', A.memo, `${W}/mainnet/memo.so`,
  '--bpf-program', A.metaplex, `${W}/mainnet/metaplex.so`,
  '--account', A.multisig, `${W}/local/${multisigFile}`,
  '--account', A.bayla, `${W}/local/bayla.json`,
  '--account', A.wsol, `${W}/mainnet/wsol.json`,
];
const off = join(WORK, 'deactivate-features.txt');
if (existsSync(off)) for (const f of readFileSync(off, 'utf-8').split('\n').filter(Boolean)) args.push('--deactivate-feature', f.trim());

const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const cmd = `solana-test-validator ${args.map(q).join(' ')}`;
writeFileSync(join(WORK, 'validator-command.txt'), cmd + '\n');
console.log(`${args.length} args, ${multisigFile}, program ${SO}`);
process.exit(sh(`[ -f ${PID} ] && grep -q solana-test-validator /proc/$(cat ${PID})/cmdline 2>/dev/null && { echo already running; exit 1; }; ` +
  // nohup first, so the hang-up of this exiting shell cannot reach it before setsid detaches it.
  `nohup setsid ${cmd} > ${LEDGER}.out 2>&1 < /dev/null & P=$!; echo $P > ${PID}; sleep 2; ` +
  `kill -0 $P 2>/dev/null && echo started pid $P || { echo validator exited at once; tail -5 ${LEDGER}.out; exit 1; }`));
