// The bot is its own package and cannot import SITE_URL, so this test holds it: the bot's
// default origins are the canonical host, and bot/.env.example and bot/DEPLOY.md say so.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SITE_URL } from '../lib/constants';
import { loadConfig } from '../../../bot/src/config.js';

const BOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bot');
const CANONICAL = new URL(SITE_URL).origin;
const VARS = ['VENUE_ORIGIN', 'APP_ORIGIN'] as const;
// An origin after "Default"; each dot must be followed by a label, so prose punctuation stays out.
const DEFAULT_ORIGIN = /Default\D*?(https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+)/;

/** The URL after "Default" in the `#` lines directly above `NAME=`. */
function envExampleDefault(name: string): string | undefined {
  const lines = readFileSync(join(BOT, '.env.example'), 'utf-8').split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`${name}=`));
  let i = at - 1;
  while (i >= 0 && lines[i].startsWith('#')) i--;
  return at < 0 ? undefined : lines.slice(i + 1, at).join(' ').match(DEFAULT_ORIGIN)?.[1];
}

/** The URL after "Default" in the §2 table row for `name`. */
function deployDefault(name: string): string | undefined {
  const row = readFileSync(join(BOT, 'DEPLOY.md'), 'utf-8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`| \`${name}\` |`));
  return row?.match(DEFAULT_ORIGIN)?.[1];
}

describe('the bot defaults to the canonical host', () => {
  it('in code', () => {
    const cfg = loadConfig({});
    expect(cfg.venueOrigin).toBe(CANONICAL);
    expect(cfg.appOrigin).toBe(CANONICAL);
  });

  for (const name of VARS) {
    it(`in bot/.env.example and bot/DEPLOY.md for ${name}`, () => {
      expect(envExampleDefault(name), `bot/.env.example default for ${name}`).toBe(CANONICAL);
      expect(deployDefault(name), `bot/DEPLOY.md default for ${name}`).toBe(CANONICAL);
    });
  }
});
