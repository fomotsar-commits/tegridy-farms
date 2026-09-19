// Answer eleven, ruling 1: the rule that no Discord invite ships unless Discord's own API
// says it is permanent and the venue's server. The live check is
// scripts/verify-discord-invites.mjs in CI; these pin its judgment with canned answers so
// no test here touches the network.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VENUE_DISCORD_GUILD,
  findInviteCodes,
  judgeInvite,
  resolveInvite,
  shippedFiles,
  invitesInFiles,
} from './lib/discord-invites.mjs';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(FRONTEND, '..');
const permanent = { code: 'Abc123', expires_at: null, guild: { id: '1', name: VENUE_DISCORD_GUILD } };

describe('the verdict on one invite', () => {
  it('passes a permanent invite to the venue’s own server', () => {
    const v = judgeInvite('Abc123', { status: 200, body: permanent });
    expect(v.ok).toBe(true);
    expect(v.line).toBe(`discord.gg/Abc123: guild "${VENUE_DISCORD_GUILD}", expires_at null.`);
  });

  it('fails an invite that expires, the case #596 carried', () => {
    const v = judgeInvite('QGCbsmwgJ', { status: 200, body: { ...permanent, expires_at: '2026-10-17T15:43:32+00:00' } });
    expect(v).toMatchObject({ ok: false });
    expect(v.line).toContain('expires at 2026-10-17');
  });

  it('fails a dead invite, as Discord reports the old discord.gg/junglebay', () => {
    expect(judgeInvite('junglebay', { status: 404, body: { code: 10006, message: 'Unknown Invite' } }).ok).toBe(false);
    // Discord's error code decides even if a proxy rewrote the status, and the log says
    // why in Discord's own words, so whoever reads the red CI run knows the invite died.
    const rewritten = judgeInvite('junglebay', { status: 200, body: { code: 10006, message: 'Unknown Invite' } });
    expect(rewritten.ok).toBe(false);
    expect(rewritten.line).toContain('Unknown Invite');
  });

  it('fails a permanent invite to any other server', () => {
    const v = judgeInvite('Abc123', { status: 200, body: { ...permanent, guild: { id: '2', name: 'memetics finance' } } });
    expect(v.ok).toBe(false);
    expect(v.line).toContain('not "memetics.finance"');
  });

  it('fails closed on an answer it cannot read', () => {
    expect(judgeInvite('Abc123', { status: 429, body: { retry_after: 3 } }).ok).toBe(false);
    expect(judgeInvite('Abc123', { status: 503, body: null }).ok).toBe(false);
    expect(judgeInvite('Abc123', { error: 'getaddrinfo ENOTFOUND discord.com' }).ok).toBe(false);
    expect(judgeInvite('Abc123', undefined).ok).toBe(false);
    // 200 without expires_at is not proof of permanence: the query flag may have been dropped.
    const { expires_at: _drop, ...noExpiry } = permanent;
    expect(judgeInvite('Abc123', { status: 200, body: noExpiry }).ok).toBe(false);
  });
});

describe('asking Discord', () => {
  const reply = (status, body) => ({ status, json: async () => body });

  it('asks the v10 invite endpoint with expiration, and retries a rate limit once', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(429, { retry_after: 1.5 }))
      .mockResolvedValueOnce(reply(200, permanent));
    const sleep = vi.fn(async () => {});
    const answer = await resolveInvite('Abc123', fetchImpl, sleep);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://discord.com/api/v10/invites/Abc123?with_expiration=true');
    expect(sleep).toHaveBeenCalledWith(1500);
    expect(answer).toEqual({ status: 200, body: permanent });
  });

  it('turns a network failure into an answer the verdict fails', async () => {
    const answer = await resolveInvite('Abc123', vi.fn().mockRejectedValue(new Error('socket hang up')));
    expect(answer).toEqual({ error: 'socket hang up' });
    expect(judgeInvite('Abc123', answer).ok).toBe(false);
  });
});

describe('finding the invites the site ships', () => {
  it('reads every invite URL shape, once each', () => {
    expect(
      findInviteCodes(
        'a https://discord.gg/Abc123 b http://discord.com/invite/Xy-9?x=1 c https://discordapp.com/invite/Zz ' +
          '["Discord", "https://discord.gg/Abc123"]',
      ),
    ).toEqual(['Abc123', 'Xy-9', 'Zz']);
  });

  it('scans the app source, index.html and public/, and not the tests', () => {
    const files = shippedFiles(FRONTEND).map((f) => f.split('\\').join('/'));
    expect(files.some((f) => f.endsWith('/src/lib/constants.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('/src/nakamigos/components/About.jsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('/index.html'))).toBe(true);
    expect(files.some((f) => /\.test\.[a-z]+$/.test(f))).toBe(false);
  });

  it('finds no invite in shipped source that CI has not been asked about', () => {
    // Today no invite ships (answer eleven: the dead ones came down, the permanent one
    // waits for the owner). This is a snapshot of the scan, not the rule: when the owner's
    // invite lands, this list gains it and CI resolves it on every run.
    expect([...invitesInFiles(shippedFiles(FRONTEND), FRONTEND).keys()]).toEqual([]);
  });
});

describe('CI runs the live check', () => {
  it('in the Lint, Type Check & Test job, as a step that can fail the run', () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    const rest = ci.slice(ci.indexOf('name: Lint, Type Check & Test'));
    // Only this job: stop at the next two-space job key.
    const nextJob = rest.search(/\n {2}[A-Za-z0-9_-]+:\s*\n/);
    const job = nextJob === -1 ? rest : rest.slice(0, nextJob);
    const step = job.slice(job.indexOf('- name: Discord invites resolve'));
    expect(job.indexOf('- name: Discord invites resolve'), 'ci.yml has no Discord invite step').toBeGreaterThan(-1);
    const body = step.slice(0, step.indexOf('\n      - ', 5) === -1 ? undefined : step.indexOf('\n      - ', 5));
    expect(body).toContain('run: node scripts/verify-discord-invites.mjs');
    expect(body).not.toMatch(/continue-on-error:\s*true/);
  });
});
