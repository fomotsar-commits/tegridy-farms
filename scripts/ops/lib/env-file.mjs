// Strict reader for the ops env file (NAME=value lines), shared by every scripts/ops CLI.
//
// Not node's --env-file: that parser starts a comment at any '#', so an unquoted
// `BACKUP_PASSPHRASE=abc#def` loads as `abc` and every backup would be encrypted with a
// passphrase nobody holds. Here the value is everything after the first '=', verbatim.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/**
 * NAME=value per line; blank lines and lines starting with '#' are skipped. The value is
 * the text after the first '='. Matching outer quotes are removed, with no escapes; an
 * unquoted value is trimmed; '#' inside a value is kept. A bad line, an unclosed quote or
 * a repeated NAME is an error, named by line number only (the line may hold a secret).
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
 * Load an env file into `env` (the file wins over what is already set, because naming
 * the file is the more specific instruction). Throws, with no secret in the message,
 * when the file is missing, sits inside a git work tree, or has a bad line.
 */
export function loadEnvFile(path, env = process.env) {
  const file = resolve(path);
  if (!existsSync(file)) throw new Error(`env file not found: ${file}`);
  const repo = gitWorkTreeAbove(file);
  if (repo) {
    throw new Error(`refusing to read secrets from ${file}: it is inside the git work tree ${repo}. Keep the env file outside every repo.`);
  }
  const { vars, errors } = parseEnvText(readFileSync(file, 'utf8'));
  if (errors.length) throw new Error(`env file ${file} is malformed: ${errors.join('; ')}`);
  Object.assign(env, vars);
  return Object.keys(vars);
}

/**
 * Pull `--env-file <path>` (or `--env-file=<path>`) out of argv. Returns the remaining
 * args. Warns when node's own --env-file was used, since its parser truncates at '#'.
 */
export function takeEnvFileFlag(argv, { warn = console.error } = {}) {
  const rest = [];
  let envFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env-file') {
      if (!argv[i + 1]) throw new Error('--env-file needs a path');
      envFile = argv[++i];
    } else if (a.startsWith('--env-file=')) {
      envFile = a.slice('--env-file='.length);
    } else {
      rest.push(a);
    }
  }
  if (process.execArgv.some((a) => a.startsWith('--env-file'))) {
    warn("WARNING: node's own --env-file cuts every unquoted value at '#'. Pass --env-file to this script instead (after the script name).");
  }
  return { envFile, rest };
}
