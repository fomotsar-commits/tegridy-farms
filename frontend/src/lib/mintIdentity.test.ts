// @vitest-environment node
// Node, not jsdom: PublicKey.findProgramAddressSync fails every bump under jsdom.
//
// A wallet reads public/mint/ through the link written on chain, and a missing file on
// this host is not a 404: it is the app's HTML page with status 200. This pins the files
// to scripts/lib/mint-identity.mjs, the one list, and the vercel.json rules for the folder.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { SITE_URL } from './constants';
import { BUNGALOWS } from './bungalows';
import { REGISTERED_PROGRAM_ID, deriveAuthority, deriveLpMint } from './solana/cpswap/program';
import {
  DEFAULT_FILE,
  DEFAULT_TOKEN,
  LIMITS,
  MINT_IMG_PATH,
  MINT_PATH,
  MINT_TOKENS,
  RETIRED_PICTURES,
  SITE,
  carriesOwnHash,
  metadataFileNames,
  metadataFor,
  metadataUri,
  pictureFile,
  pictureFolderProblems,
  serialize,
} from '../../scripts/lib/mint-identity.mjs';
import { stakeMintFor } from '../../scripts/streamflow-receipt-name.mjs';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = join(FRONTEND, '..');
const MINT_DIR = join(FRONTEND, 'public', MINT_PATH.slice(1));
const IMG_DIR = join(FRONTEND, 'public', MINT_IMG_PATH.slice(1));

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** A directory's own files by the names the disk holds, so a case slip fails on every OS. */
const filesIn = (dir: string) => readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()).sort();

interface Row {
  file: string;
  token: { name: string; symbol: string; description: string; picture: string };
}
const ROWS: Row[] = [
  ...MINT_TOKENS.map((t) => ({ file: `${t.mint}.json`, token: t })),
  { file: DEFAULT_FILE, token: DEFAULT_TOKEN },
];

const readMetadata = (file: string) => {
  const text = readFileSync(join(MINT_DIR, file), 'utf8');
  return { text, json: JSON.parse(text) as Record<string, unknown> };
};
/** The picture a metadata file names, as a file name under public/mint/img/. */
const pictureOf = (file: string) => String(readMetadata(file).json.image).split('/').pop()!;

describe('the one list of tokens', () => {
  it('lists the two pool shares, the staking receipt and a default, each once', () => {
    expect(MINT_TOKENS.map((t) => t.kind).sort()).toEqual(['pool-share', 'pool-share', 'staking-receipt']);
    const all = [...MINT_TOKENS, DEFAULT_TOKEN];
    expect(new Set(MINT_TOKENS.map((t) => t.mint)).size).toBe(MINT_TOKENS.length);
    for (const key of ['name', 'symbol', 'picture', 'ring'] as const) {
      expect(new Set(all.map((t) => t[key])).size, `two tokens share a ${key}`).toBe(all.length);
    }
  });

  it('carries the names and symbols the owner ruled on 2026-10-06, word for word', () => {
    // Written out here on purpose. Every other check compares the files with the list, so
    // a name changed in the list and regenerated would pass them all.
    expect(MINT_TOKENS.map((t) => [t.mint, t.name, t.symbol])).toEqual([
      ['BQZth5DhHZT9H1AxZonoLAwGHknWo4LebQBxjKWtzY8e', 'BAYLA/SOL Pool Share', 'BAYLA-SOL'],
      ['3D3EKJxfePDQ1N8YtNwg8W6eSL4mjVpbYf57pnqgcAQx', 'BAYLA/USDC Pool Share', 'BAYLA-USDC'],
      ['g8W2HWmS1dKJwHHKDkR1k7SmtTTx7ic97z1ssAZ8NwN', 'Staked BAYLA', 'sBAYLA'],
    ]);
    // The default is what the pool program writes on chain for every pool, so these two
    // must stay the words fixed in that program.
    expect([DEFAULT_TOKEN.name, DEFAULT_TOKEN.symbol]).toEqual(['Memetics Pool Share', 'MEM-LP']);
  });

  it('names the canonical host and no other', () => {
    expect(SITE).toBe(SITE_URL);
  });

  it('holds only full addresses, each one in the address registry', () => {
    const registry = JSON.parse(readFileSync(join(FRONTEND, 'scripts', 'addresses.json'), 'utf8')) as {
      solana: { address?: string }[];
    };
    const registered = new Set(registry.solana.map((e) => e.address));
    const authority = deriveAuthority(REGISTERED_PROGRAM_ID).toBase58();
    const addresses = [...MINT_TOKENS.flatMap((t) => [t.mint, t.pool ?? t.stakePool]), authority];
    expect(addresses).toHaveLength(MINT_TOKENS.length * 2 + 1);
    for (const address of addresses) {
      expect(typeof address, 'a row has no pool or stake pool').toBe('string');
      const key = new PublicKey(address!);
      expect(key.toBytes()).toHaveLength(32);
      expect(key.toBase58(), 'not the canonical spelling of that address').toBe(address);
      expect(registered.has(address), `${address} is not in scripts/addresses.json`).toBe(true);
    }
  });

  it('pairs each mint with the pool it is derived from, never a retyped one', () => {
    for (const t of MINT_TOKENS) {
      if (t.kind === 'pool-share') {
        expect(deriveLpMint(REGISTERED_PROGRAM_ID, new PublicKey(t.pool!)).toBase58()).toBe(t.mint);
      } else {
        expect(t.stakePool).toBe(BUNGALOWS.find((b) => b.id === 'bayla')!.stakePool);
        expect(stakeMintFor(new PublicKey(t.stakePool!)).toBase58()).toBe(t.mint);
      }
    }
  });

  it('fits what an on-chain record can hold, and no symbol is BAYLA itself', () => {
    for (const t of [...MINT_TOKENS, DEFAULT_TOKEN]) {
      expect(bytes(t.name), t.name).toBeLessThanOrEqual(LIMITS.name);
      expect(bytes(t.name)).toBeGreaterThan(0);
      expect(bytes(t.symbol), t.symbol).toBeLessThanOrEqual(LIMITS.symbol);
      expect(bytes(t.symbol)).toBeGreaterThan(0);
      // A wallet groups rows by symbol: a share called BAYLA would sit in the coin's row.
      expect(t.symbol.toUpperCase()).not.toBe('BAYLA');
    }
    expect(LIMITS).toEqual({ name: 32, symbol: 10, uri: 200 });
    // The longest a Solana address gets is 44 characters.
    for (const mint of [...MINT_TOKENS.map((t) => t.mint), '1'.repeat(44)]) {
      expect(bytes(metadataUri(mint))).toBeLessThanOrEqual(LIMITS.uri);
      expect(metadataUri(mint)).toBe(`${SITE_URL}/mint/${mint}.json`);
    }
  });

  it('says in each description what the token is, where it is redeemed, and not to burn it', () => {
    const host = new URL(SITE_URL).host;
    for (const t of [...MINT_TOKENS, DEFAULT_TOKEN]) {
      expect(t.description).toContain(`on ${host}.`);
      expect(t.description.endsWith(' Do not burn it.')).toBe(true);
      expect(t.description).toMatch(/comes back as /);
      expect(t.description).not.toMatch(/[–—]/);
      expect(t.description).not.toMatch(/\b(earn|yield|apr|apy|profit|return)/i);
    }
  });
});

describe('public/mint/ holds exactly the files the list names', () => {
  it('has one metadata file per mint and the default, by exact name, and nothing else', () => {
    expect(filesIn(MINT_DIR)).toEqual(metadataFileNames().sort());
    expect(readdirSync(MINT_DIR).sort()).toEqual([...metadataFileNames(), 'img'].sort());
  });

  it('has exactly the pictures those files name and the retired ones, and nothing else', () => {
    const named = ROWS.map((r) => pictureOf(r.file)).sort();
    expect(new Set(named).size).toBe(ROWS.length);
    expect(readdirSync(IMG_DIR).sort()).toEqual([...named, ...RETIRED_PICTURES].sort());
    const onDisk = readdirSync(IMG_DIR).map((name) => ({ name, sha256: sha256(readFileSync(join(IMG_DIR, name))) }));
    expect(pictureFolderProblems(onDisk, named)).toEqual([]);
    for (const name of RETIRED_PICTURES) {
      expect(readFileSync(join(IMG_DIR, name)).subarray(0, 8).toString('hex'), `${name} is not a PNG`).toBe('89504e470d0a1a0a');
    }
  });

  it('never lets go of a picture that was deployed: a redesign retires it, and it stays', () => {
    // A wallet that kept yesterday's metadata file still asks for the old picture address,
    // and a missing file under /mint/ answers JSON, marked unchanging for a year.
    const old = { name: 'bayla-sol-11111111.png', sha256: `11111111${'0'.repeat(56)}` };
    const now = { name: 'bayla-sol-22222222.png', sha256: `22222222${'0'.repeat(56)}` };
    expect(pictureFolderProblems([old, now], [now.name], [old.name])).toEqual([]);
    expect(pictureFolderProblems([now], [now.name], [old.name]).join(' | ')).toMatch(/bayla-sol-11111111\.png is retired and missing/);
    expect(pictureFolderProblems([old, now], [now.name], []).join(' | ')).toMatch(/bayla-sol-11111111\.png is named by no metadata file/);
    expect(pictureFolderProblems([old, now], [now.name, old.name], [old.name]).join(' | ')).toMatch(/retired and a metadata file still points at it/);
    expect(pictureFolderProblems([now], [now.name, old.name], []).join(' | ')).toMatch(/bayla-sol-11111111\.png is missing/);
    // A retired picture is held to its own bytes too: its address must never change content.
    expect(pictureFolderProblems([{ ...old, sha256: now.sha256 }, now], [now.name], [old.name]).join(' | ')).toMatch(
      /bayla-sol-11111111\.png does not carry the hash/,
    );
    expect(carriesOwnHash('bayla-sol-11111111.png', old.sha256)).toBe(true);
    expect(carriesOwnHash('11111111.png', old.sha256)).toBe(false);
    expect(carriesOwnHash('bayla-sol-11111111.png.bak', old.sha256)).toBe(false);
  });

  it.each(ROWS)('$file is the four fields the list says, and nothing more', ({ file, token }) => {
    const { text, json } = readMetadata(file);
    expect(Object.keys(json)).toEqual(['name', 'symbol', 'description', 'image']);
    for (const value of Object.values(json)) expect(typeof value).toBe('string');
    expect(json.name).toBe(token.name);
    expect(json.symbol).toBe(token.symbol);
    expect(json.description).toBe(token.description);
    expect(text).toBe(serialize(metadataFor(token, pictureOf(file))));
  });

  it.each(ROWS)('$file points at a picture on the canonical host that is on disk', ({ file }) => {
    const image = new URL(String(readMetadata(file).json.image));
    expect(image.protocol).toBe('https:');
    expect(image.origin).toBe(new URL(SITE_URL).origin);
    expect(image.search + image.hash).toBe('');
    expect(image.pathname).toBe(`${MINT_IMG_PATH}/${pictureOf(file)}`);
    expect(readdirSync(IMG_DIR)).toContain(pictureOf(file));
  });

  it.each(ROWS)('the picture of $file is a square opaque PNG, 512 px or more, under 1 MB', ({ file }) => {
    const png = readFileSync(join(IMG_DIR, pictureOf(file)));
    expect(png.subarray(0, 8).toString('hex'), 'not a PNG by its first bytes').toBe('89504e470d0a1a0a');
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
    const width = png.readUInt32BE(16);
    expect(png.readUInt32BE(20)).toBe(width);
    expect(width).toBeGreaterThanOrEqual(512);
    // Colour type 2 is plain RGB: no alpha channel, so nothing shows through.
    expect(png[25]).toBe(2);
    expect(png.length).toBeLessThan(1024 * 1024);
  });

  it.each(ROWS)('the picture of $file carries the hash of its own bytes in its name', ({ file, token }) => {
    // A changed picture must change its URL: a wallet keeps what it fetched, keyed by URL.
    const name = pictureOf(file);
    expect(name).toBe(pictureFile(token.picture, sha256(readFileSync(join(IMG_DIR, name)))));
    expect(name).toMatch(/^[a-z-]+-[0-9a-f]{8}\.png$/);
  });
});

describe('vercel.json keeps /mint/ answering what a wallet can use', () => {
  interface HeaderRule {
    source: string;
    headers: { key: string; value: string }[];
  }
  const config = JSON.parse(readFileSync(join(FRONTEND, 'vercel.json'), 'utf8')) as {
    headers: HeaderRule[];
    rewrites: { source: string; destination: string }[];
  };
  // Near enough to the platform for the sources in this file: a dot is a literal
  // unless it is the `.` of `(.*)`, and `:name` and `:name*` are path parameters.
  const matches = (source: string, path: string) =>
    new RegExp(
      `^${source
        .replace(/\.(?![*+])/g, '\\.')
        .replace(/:[A-Za-z_]+\*/g, '.*')
        .replace(/:[A-Za-z_]+/g, '[^/]+')}$`,
    ).test(path);
  /** The value a path ends up with: the last rule that matches it and sets the key wins. */
  const header = (path: string, key: string) =>
    config.headers
      .filter((r) => matches(r.source, path))
      .flatMap((r) => r.headers)
      .filter((h) => h.key === key)
      .pop()?.value;
  const maxAge = (value: string | undefined) => Number(/max-age=(\d+)/.exec(value ?? '')?.[1] ?? 0);

  const aFile = `${MINT_PATH}/${MINT_TOKENS[0].mint}.json`;
  const aPicture = `${MINT_IMG_PATH}/${pictureOf(DEFAULT_FILE)}`;
  const noSuchMint = `${MINT_PATH}/${'1'.repeat(44)}.json`;

  it('reads the rules it is about to judge', () => {
    expect(matches('/(.*).map', '/assets/a.js.map')).toBe(true);
    expect(matches('/(.*).map', '/assets/a.jsXmap')).toBe(false);
    expect(matches('/record/:chain/:ca.json', '/record/solana/abc.json')).toBe(true);
    expect(header('/assets/a.js', 'Cache-Control')).toContain('immutable');
    expect(header('/', 'Cross-Origin-Resource-Policy')).toBe('same-site');
  });

  it('lets another site show a metadata file and a picture', () => {
    // The site-wide rule says same-site, which makes a browser on someone else's page
    // refuse the picture. /mint/ overrides it, as /record/ does.
    const rule = config.headers.find((r) => r.source === `${MINT_PATH}/(.*)`);
    expect(rule?.headers).toContainEqual({ key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' });
    for (const path of [aFile, aPicture, noSuchMint]) {
      expect(header(path, 'Cross-Origin-Resource-Policy'), path).toBe('cross-origin');
    }
  });

  it('lets a page on another site read a metadata file with fetch, by a rule of ours', () => {
    // The platform sends this header on static files by itself today. A web wallet that
    // reads the JSON from its own page depends on it, so it is written down here.
    const rule = config.headers.find((r) => r.source === `${MINT_PATH}/(.*)`);
    expect(rule?.headers).toContainEqual({ key: 'Access-Control-Allow-Origin', value: '*' });
    for (const path of [aFile, aPicture, noSuchMint]) {
      expect(header(path, 'Access-Control-Allow-Origin'), path).toBe('*');
    }
  });

  it('keeps every address under /mint/ out of search results', () => {
    // The default file answers for any path here, so each one would be a page to index.
    for (const path of [aFile, aPicture, noSuchMint, `${MINT_PATH}/`, `${MINT_PATH}/a/b/c.html`]) {
      expect(header(path, 'X-Robots-Tag'), path).toBe('noindex');
    }
  });

  it('caches a metadata file for a day and a picture for a year', () => {
    for (const path of [aFile, noSuchMint]) {
      expect(header(path, 'Cache-Control')).toContain('public');
      expect(maxAge(header(path, 'Cache-Control'))).toBe(86_400);
      expect(header(path, 'Cache-Control')).not.toContain('immutable');
    }
    // The picture's name carries its hash, so the bytes at that URL never change.
    expect(header(aPicture, 'Cache-Control')).toContain('public');
    expect(header(aPicture, 'Cache-Control')).toContain('immutable');
    expect(maxAge(header(aPicture, 'Cache-Control'))).toBeGreaterThanOrEqual(31_536_000);
  });

  it('answers a mint with no file with the default file, never the app page', () => {
    const fallback = config.rewrites.findIndex((r) => r.destination === '/index.html');
    const ours = config.rewrites.findIndex((r) => r.source === `${MINT_PATH}/(.*)`);
    expect(fallback).toBeGreaterThanOrEqual(0);
    expect(ours, 'no /mint/(.*) rewrite').toBeGreaterThanOrEqual(0);
    expect(config.rewrites[ours].destination).toBe(`${MINT_PATH}/${DEFAULT_FILE}`);
    // ORDER IS THE TEST. The first match wins, and the app fallback matches every path.
    expect(ours).toBeLessThan(fallback);
    for (const path of [noSuchMint, `${MINT_IMG_PATH}/no-such-picture.png`, `${MINT_PATH}/`]) {
      expect(matches(config.rewrites[fallback].source, path), 'the app fallback would have taken this path').toBe(true);
      expect(config.rewrites.findIndex((r) => matches(r.source, path)), path).toBe(ours);
    }
    expect(filesIn(MINT_DIR)).toContain(DEFAULT_FILE);
  });
});

describe('the build and the production monitor look for the same files', () => {
  const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

  it('checks dist/ for them as the last step of the build', () => {
    const steps = pkg.scripts.build.split('&&').map((s) => s.trim());
    expect(steps.at(-1)).toBe('node scripts/verify-dist-mint.mjs');
    expect(steps.indexOf('vite build')).toBeGreaterThan(-1);
  });

  it('never runs the generator from a build step or a lifecycle hook', () => {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(command, `the "${name}" script runs the generator`).not.toContain('generate-mint-identity');
    }
  });

  // Its own 30 second limit: this starts a second node process, which takes 170 ms alone
  // and has passed the default 5 seconds while other work held the machine.
  it('probes every file in production, and the probe can fail', () => {
    const out = execFileSync(process.execPath, [join(REPO, 'scripts', 'monitoring', 'venueHealth.mjs'), '--self-test'], {
      encoding: 'utf8',
    });
    for (const name of metadataFileNames()) {
      expect(out, `no probe for ${name}`).toContain(`ok   there is a probe for ${MINT_PATH}/${name}`);
    }
    expect(out).toContain('ok   a token file probe catches the app page answering 200');
    expect(out).toContain('ok   a token file probe catches a file another site cannot read with fetch');
    expect(out).not.toContain('FAIL');
  }, 30_000);
});
