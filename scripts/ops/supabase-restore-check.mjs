#!/usr/bin/env node
// Prove a backup is readable: check its .sha256, decrypt it in memory, count every table's
// rows. Prints counts only, never row contents; writes nothing. Exit 0 = readable and whole.
//   node scripts/ops/supabase-restore-check.mjs <file.tar.gz.gpg> [--env-file <path>]
//   node scripts/ops/supabase-restore-check.mjs --latest [dir] --prompt
// --prompt reads the passphrase with echo off (use the OFFLINE copy) and ignores the env.

import { pathToFileURL } from 'node:url';
import { checkBackupFile, defaultBackupDir, latestBackup } from './lib/backup.mjs';
import { loadEnvFile, takeEnvFileFlag } from './lib/env-file.mjs';

export function parseArgs(argv) {
  const out = { file: null, latest: false, dir: null, prompt: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--latest') {
      out.latest = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.dir = argv[++i];
    } else if (a === '--prompt') out.prompt = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown argument: ${a} (the passphrase comes from BACKUP_PASSPHRASE or --prompt, never an argument)`);
    else if (!out.file) out.file = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (out.latest && out.file) throw new Error('give a file or --latest, not both');
  return out;
}

/** Feed typed characters into a hidden-input buffer. Pure, so it can be tested without a TTY. */
export function feedHidden(buffer, chunk) {
  let buf = buffer;
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') return { done: true, value: buf };
    if (ch === '\u0003') return { done: true, cancelled: true, value: '' };
    if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
    else buf += ch;
  }
  return { done: false, value: buf };
}

function promptHidden(question) {
  if (!process.stdin.isTTY) throw new Error('--prompt needs an interactive terminal');
  process.stderr.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (data) => {
      const r = feedHidden(buf, data.toString('utf8'));
      buf = r.value;
      if (!r.done) return;
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stderr.write('\n');
      if (r.cancelled) reject(new Error('cancelled'));
      else resolve(r.value);
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  const { envFile, rest } = takeEnvFileFlag(process.argv.slice(2));
  const args = parseArgs(rest);
  if (args.help || (!args.file && !args.latest)) {
    console.log('usage: node scripts/ops/supabase-restore-check.mjs <file> | --latest [dir]  [--env-file <path>] [--prompt]');
    return args.help ? 0 : 2;
  }
  if (envFile) loadEnvFile(envFile);
  const file = args.file || latestBackup(args.dir || defaultBackupDir(process.env));
  if (!file) {
    console.error(`No supabase-backup-*.tar.gz.gpg file in ${args.dir || defaultBackupDir(process.env)}.`);
    return 1;
  }
  const passphrase = args.prompt ? await promptHidden('Backup passphrase (hidden): ') : process.env.BACKUP_PASSPHRASE;
  if (!passphrase) {
    console.error('No passphrase: set BACKUP_PASSPHRASE (or use --env-file), or pass --prompt.');
    return 1;
  }
  const result = checkBackupFile({ file, passphrase });
  for (const line of result.lines) console.log(line);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`RESTORE CHECK FAILED: ${e?.message || e}`);
    process.exitCode = 1;
  });
}
