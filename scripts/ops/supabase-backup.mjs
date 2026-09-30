#!/usr/bin/env node
// Supabase backup, by hand or from run-job.mjs: supabase-backup.yml's tables, pagination
// and gpg format, written to a folder you control. Secrets come from the environment only.
//   node scripts/ops/supabase-backup.mjs --env-file <path outside any repo> [--dest <dir>] [--keep <n>]
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, BACKUP_PASSPHRASE; optional BACKUP_DIR, BACKUP_KEEP
// (default 26), GPG_BIN. Exit 0 = a verified backup was written; 1 = none was.

import { pathToFileURL } from 'node:url';
import { runBackup } from './lib/backup.mjs';
import { loadEnvFile, takeEnvFileFlag } from './lib/env-file.mjs';

export function parseArgs(argv) {
  const out = { dest: undefined, keep: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dest') out.dest = argv[++i];
    else if (a === '--keep') out.keep = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a} (secrets are read from the environment, never from arguments)`);
  }
  return out;
}

async function main() {
  const { envFile, rest } = takeEnvFileFlag(process.argv.slice(2));
  const args = parseArgs(rest);
  if (args.help) {
    console.log('usage: node scripts/ops/supabase-backup.mjs --env-file <path> [--dest <dir>] [--keep <n>]');
    return 0;
  }
  if (envFile) loadEnvFile(envFile);
  const result = await runBackup({ env: process.env, dest: args.dest, keep: args.keep });
  for (const line of result.lines) console.log(line);
  if (!result.ok) console.error('\nBACKUP FAILED. No new restore point exists.');
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`BACKUP FAILED: ${e?.message || e}`);
    process.exitCode = 1;
  });
}
