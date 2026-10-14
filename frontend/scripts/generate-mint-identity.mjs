#!/usr/bin/env node
// Writes public/mint/ from scripts/lib/mint-identity.mjs: one metadata file per mint,
// default.json, and the pictures under public/mint/img/ with a hash of their bytes in
// the name. RUN BY HAND and commit what it writes: `node scripts/generate-mint-identity.mjs`.
// Never part of `build` and never a pre* hook. src/lib/mintIdentity.test.ts pins the output.
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FILE, DEFAULT_TOKEN, MINT_IMG_PATH, MINT_PATH, MINT_TOKENS, RETIRED_PICTURES,
  metadataFor, pictureFile, serialize,
} from './lib/mint-identity.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const OUT_DIR = join(PUBLIC, MINT_PATH.slice(1));
const IMG_DIR = join(PUBLIC, MINT_IMG_PATH.slice(1));

// The island mark, 900 px. Read into memory and never written. The crop and ring numbers
// below were measured on these exact bytes, so different bytes stop the run.
const MASTER = join(PUBLIC, 'art', 'bayla', 'image-1788192198022.png');
const MASTER_SHA256 = '604ac0854e2ea2d137d04c99751c2cab8d6f563425d55356251e2566fd4badff';

const S = 512;
// The ring sits at about 88% of the half-width: a wallet crops a token picture to a circle.
const CROP = { left: 87, top: 40, width: 740, height: 740 };
const K = S / CROP.width;
const RING = { cx: (457 - CROP.left) * K, cy: (400 - CROP.top) * K, r: 325 * K };

// What turns the mark's lime light into each ring colour (sharp `modulate`). The first
// three are the approved "turned ring" numbers; moonlight is the same turn with the colour
// drained, for a pool share that names no pair.
const RINGS = {
  sol: { hue: 176, saturation: 1.7, brightness: 1.25 },
  usdc: { hue: 134, saturation: 1.15, brightness: 1.3 },
  gold: { hue: -46, saturation: 1.1, brightness: 1.1 },
  moonlight: { hue: 134, saturation: 0.16, brightness: 1.5 },
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// White shows the turned copy, black keeps the original: the island stays green inside
// the ring, and the ring and everything outside it turn.
const ringMask = (inner = 0.74, outer = 0.9) => `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
  <defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${RING.cx}" cy="${RING.cy}" r="${RING.r * outer}">
    <stop offset="${inner / outer}" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient></defs>
  <rect width="${S}" height="${S}" fill="#fff"/>
  <circle cx="${RING.cx}" cy="${RING.cy}" r="${RING.r * outer}" fill="url(#g)"/></svg>`;

async function render() {
  const master = readFileSync(MASTER);
  if (sha256(master) !== MASTER_SHA256) {
    throw new Error(`${MASTER} is not the picture the crop was measured on. Measure the crop and ring again before changing MASTER_SHA256.`);
  }
  const base = await sharp(master).extract(CROP).resize(S, S, { kernel: 'lanczos3' }).removeAlpha().png().toBuffer();
  const mask = await sharp(await sharp(Buffer.from(ringMask())).png().toBuffer()).extractChannel(0).raw().toBuffer();
  const pictures = {};
  for (const [ring, turn] of Object.entries(RINGS)) {
    const turned = await sharp(base).modulate(turn).removeAlpha().raw().toBuffer();
    const overlay = await sharp(turned, { raw: { width: S, height: S, channels: 3 } })
      .joinChannel(mask, { raw: { width: S, height: S, channels: 1 } })
      .png().toBuffer();
    pictures[ring] = await sharp(base).composite([{ input: overlay }]).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
  }
  return pictures;
}

/** Make `dir` hold exactly `wanted` (name to bytes). Anything else in it stops the run. */
function sync(dir, wanted, extension, keep = []) {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (wanted.has(name) || keep.includes(name)) continue;
    if (!name.endsWith(extension)) throw new Error(`${join(dir, name)} is not a file this script writes. Move it out, then run again.`);
    rmSync(join(dir, name));
    console.log(`  removed ${name}`);
  }
  for (const [name, bytes] of wanted) {
    // toBuffer and a plain write: sharp's toFile has failed on this tree.
    writeFileSync(join(dir, name), bytes);
    console.log(`  wrote   ${name} (${bytes.length.toLocaleString('en-US')} bytes)`);
  }
}

const pictures = await render();
const rows = [...MINT_TOKENS.map((t) => [`${t.mint}.json`, t]), [DEFAULT_FILE, DEFAULT_TOKEN]];
const images = new Map();
const files = new Map();
for (const [fileName, token] of rows) {
  const bytes = pictures[token.ring];
  if (!bytes) throw new Error(`${token.name}: no ring colour named "${token.ring}"`);
  const picture = pictureFile(token.picture, sha256(bytes));
  images.set(picture, bytes);
  files.set(fileName, Buffer.from(serialize(metadataFor(token, picture)), 'utf8'));
}

// A picture is never deleted here. One that has been deployed must keep answering at its
// address: a wallet that kept yesterday's metadata file still asks for it, and a missing
// file under /mint/ answers JSON, marked unchanging for a year.
const onDisk = existsSync(IMG_DIR) ? readdirSync(IMG_DIR) : [];
const unnamed = onDisk.filter((name) => !images.has(name) && !RETIRED_PICTURES.includes(name));
if (unnamed.length > 0) {
  throw new Error(`No token names ${unnamed.join(', ')} any more, and this script does not delete a picture. If it was ever deployed, add its file name to RETIRED_PICTURES in scripts/lib/mint-identity.mjs so its address keeps answering. If it never left this machine, delete it by hand. Then run again.`);
}
const lost = RETIRED_PICTURES.filter((name) => !onDisk.includes(name));
if (lost.length > 0) throw new Error(`${lost.join(', ')} is in RETIRED_PICTURES and not on disk. Restore it from git: a retired picture must keep answering.`);

console.log(`public${MINT_IMG_PATH}/`);
sync(IMG_DIR, images, '.png', RETIRED_PICTURES);
console.log(`public${MINT_PATH}/`);
sync(OUT_DIR, files, '.json', [MINT_IMG_PATH.split('/').pop()]);
console.log(`\n${files.size} metadata files and ${images.size} pictures. Look at each picture, then commit them.`);
