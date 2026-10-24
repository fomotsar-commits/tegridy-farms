#!/usr/bin/env node
// Copy GitHub's weekly Supabase backups to a folder GitHub does not own, by hand. The weekly
// task runs the same code as `run-job.mjs backup-pull`, which also pings HC_PING_URL_BACKUP_PULL.
//   node scripts/ops/pull-github-backups.mjs [--dest <dir>] [--env-file <path>]...
// Env: optional BACKUP_PULL_DIR (default %USERPROFILE%\OneDrive\backups\supabase-github), GH_BIN.
// Exit 0 = every held file checks out and GitHub's backup is current; 1 = not; 2 = usage.

import { pathToFileURL } from 'node:url';
import { loadEnvFiles, takeEnvFileFlag } from './lib/env-file.mjs';
import { pullGithubBackups } from './lib/github-backups.mjs';
import { runProcess } from './lib/proc.mjs';

export function parseArgs(argv) {
  const out = { dest: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dest' && argv[i + 1]) out.dest = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

async function main() {
  const { envFiles, rest } = takeEnvFileFlag(process.argv.slice(2));
  let args;
  try {
    args = parseArgs(rest);
  } catch (e) {
    console.error(`${e.message}\nusage: node scripts/ops/pull-github-backups.mjs [--dest <dir>] [--env-file <path>]...`);
    return 2;
  }
  if (args.help) {
    console.log('usage: node scripts/ops/pull-github-backups.mjs [--dest <dir>] [--env-file <path>]...');
    return 0;
  }
  loadEnvFiles(envFiles);
  const r = await pullGithubBackups({ env: process.env, run: runProcess, dest: args.dest });
  console.log(`${r.ok ? 'OK' : 'FAIL'}: ${r.summary}\n`);
  for (const line of r.lines) console.log(line);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`pull-github-backups could not run: ${e?.message || e}`);
    process.exitCode = 2;
  });
}
