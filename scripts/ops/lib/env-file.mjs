// Strict reader for the ops env files (NAME=value lines), shared by every scripts/ops CLI.
//
// Not node's --env-file: that parser starts a comment at any '#', so an unquoted
// `BACKUP_PASSPHRASE=abc#def` loads as `abc` and every backup would be encrypted with a
// passphrase nobody holds. Here a value is never cut: what it cannot read plainly, it refuses.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CURLY = /^[‘’“”]|[‘’“”]$/;
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/**
 * NAME=value lines; blank and '#' lines are skipped. The value is the text after the first
 * '=', trimmed, with matching outer quotes removed (no escapes). Unquoted, '#' is kept, but
 * ' #' or a curly outer quote is an error, as is a bad line, an unclosed quote or a repeated
 * NAME. Errors name the line number only: the line may hold a secret.
 */
export function parseEnvText(text) {
  const vars = {};
  const errors = [];
  const lines = stripBom(String(text)).split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = line.indexOf('=');
    const name = eq === -1 ? '' : line.slice(0, eq).trim();
    if (!NAME.test(name)) {
      errors.push(`line ${i + 1} is not NAME=value`);
      return;
    }
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if (q === '"' || q === "'") {
      if (value.length < 2 || value[value.length - 1] !== q) {
        errors.push(`line ${i + 1} (${name}) opens a quote it never closes`);
        return;
      }
      value = value.slice(1, -1);
    } else if (CURLY.test(value)) {
      errors.push(`line ${i + 1} (${name}) starts or ends with a curly quote, which is not a quote here: retype it as ' or "`);
      return;
    } else if (/\s#/.test(value)) {
      errors.push(`line ${i + 1} (${name}) has ' #' in an unquoted value: quote the whole value, or put the note on its own line`);
      return;
    }
    if (Object.hasOwn(vars, name)) {
      errors.push(`line ${i + 1} sets ${name} a second time`);
      return;
    }
    vars[name] = value;
  });
  return { vars, errors };
}

/** The directory holding a `.git` entry at or above `path`, or null. */
export function gitWorkTreeAbove(path) {
  let dir = resolve(path);
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    dir = dirname(dir);
  }
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Load env files, in order, into `env`; they win over what is already set, because naming a
 * file is the more specific instruction. Throws, with no secret in the message, when a file
 * is missing, sits inside a git work tree or has a bad line, or when two files set one name.
 */
export function loadEnvFiles(paths, env = process.env) {
  const merged = {};
  const source = {};
  for (const path of paths) {
    const file = resolve(path);
    if (!existsSync(file)) throw new Error(`env file not found: ${file}`);
    const repo = gitWorkTreeAbove(file);
    if (repo) {
      throw new Error(`refusing to read secrets from ${file}: it is inside the git work tree ${repo}. Keep the env file outside every repo.`);
    }
    const { vars, errors } = parseEnvText(readFileSync(file, 'utf8'));
    if (errors.length) throw new Error(`env file ${file} is malformed: ${errors.join('; ')}`);
    for (const [k, v] of Object.entries(vars)) {
      if (Object.hasOwn(merged, k)) throw new Error(`${k} is set in both ${source[k]} and ${file}. Keep it in one of them.`);
      merged[k] = v;
      source[k] = file;
    }
  }
  Object.assign(env, merged);
  return Object.keys(merged);
}

export const loadEnvFile = (path, env = process.env) => loadEnvFiles([path], env);

/**
 * Pull every `--env-file <path>` (or `--env-file=<path>`) out of argv, in order. Returns
 * the files and the remaining args. Warns when node's own --env-file was used.
 */
export function takeEnvFileFlag(argv, { warn = console.error, execArgv = process.execArgv } = {}) {
  const rest = [];
  const envFiles = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env-file') {
      if (!argv[i + 1]) throw new Error('--env-file needs a path');
      envFiles.push(argv[++i]);
    } else if (a.startsWith('--env-file=')) {
      envFiles.push(a.slice('--env-file='.length));
    } else {
      rest.push(a);
    }
  }
  if (execArgv.some((a) => a.startsWith('--env-file'))) {
    warn("WARNING: node's own --env-file cuts every unquoted value at '#'. Pass --env-file to this script instead (after the script name).");
  }
  return { envFiles, rest };
}
