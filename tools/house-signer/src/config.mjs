// Reading the keys folder: house-bidder.env (endpoints and the pinned commit) and
// policy.json. Values from the env file are never printed: RPC URLs carry API keys.
//
// This file must not import @noble (cli.mjs reads the config before the noble check).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENV_FILE = 'house-bidder.env';
export const POLICY_FILE = 'policy.json';

export function defaultKeysDir() {
  return path.join(os.homedir(), 'evm-keys', 'house-bidder');
}

/** KEY=VALUE lines; # comments and blank lines ignored; surrounding quotes stripped. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function urlList(value) {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function urlProblem(url, { allowHttpLoopback }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'is not a URL';
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && loopback && allowHttpLoopback) return null;
  return 'must be https (plain http only to a local test chain in dev mode)';
}

/**
 * The signer's settings from house-bidder.env. HOUSE_OPENSEA_API_KEY and HOUSE_RPC_WS are
 * the bot's and are ignored here: the signer never talks to OpenSea.
 */
export function readEnv(keysDir, { dev = false } = {}) {
  const file = path.join(keysDir, ENV_FILE);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing`);
  const env = parseEnv(fs.readFileSync(file, 'utf8'));
  const readUrls = urlList(env.HOUSE_RPC_HTTP);
  const sendUrls = urlList(env.HOUSE_SEND_URLS);
  if (readUrls.length === 0) throw new Error('HOUSE_RPC_HTTP must name at least one RPC endpoint');
  if (sendUrls.length === 0) throw new Error('HOUSE_SEND_URLS must name at least one endpoint to send through');
  readUrls.forEach((u, i) => {
    const p = urlProblem(u, { allowHttpLoopback: dev });
    if (p) throw new Error(`HOUSE_RPC_HTTP entry ${i + 1} ${p}`);
  });
  sendUrls.forEach((u, i) => {
    const p = urlProblem(u, { allowHttpLoopback: dev });
    if (p) throw new Error(`HOUSE_SEND_URLS entry ${i + 1} ${p}`);
  });
  const pinCommit = (env.HOUSE_PIN_COMMIT ?? '').trim().toLowerCase() || null;
  return { readUrls, sendUrls, pinCommit };
}

/** policy.json bytes, parsed, and their sha256 (hex): the hash `hello` reports. */
export function readPolicyFile(keysDir) {
  const file = path.join(keysDir, POLICY_FILE);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing`);
  const bytes = fs.readFileSync(file);
  let raw;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  return { raw, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
