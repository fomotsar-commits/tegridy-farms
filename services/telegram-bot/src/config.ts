/**
 * Config — reads env vars and validates them once on boot. All call-sites
 * import a typed `config` object; nobody else reads `process.env`.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return (process.env[name] ?? fallback).trim();
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Env var ${name} must be a non-negative integer; got "${raw}"`);
  }
  return n;
}

export const config = {
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  indexerUrl: required('INDEXER_URL'),
  pollIntervalMs: intEnv('POLL_INTERVAL_MS', 60_000),
  stateFile: optional('STATE_FILE', './.state.json'),
  chainId: intEnv('CHAIN_ID', 1),
} as const;

export type Config = typeof config;
