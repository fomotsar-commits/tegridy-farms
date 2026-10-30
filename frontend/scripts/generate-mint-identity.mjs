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

// A bungalow's own picture: its door art (src/lib/bungalowDoorArt.ts, the curator's
// placement on 2026-10-24) cut to a circle inside a ring of the pair's colour. Pinned by
// sha256 like MASTER: a door the curator moves later does not move a token's picture.
const DOORS = {
  bobo: { file: join(PUBLIC, 'art', 'bobo', 'F2E651C2-61A3-4681-B06D-D84A11C5C589.jpg'), sha256: '73236b5a2e450383b12ffabdf37ea0c25966fc58fbc868e9909ee2e14bf7db49', focusY: 49 },
  soy: { file: join(PUBLIC, 'art', 'soy', 'F8B216D6-EA7F-4BA1-9F19-06E33770EAFB.jpg'), sha256: '836f4689b38b093e9c9167566254dfebc13615d2ff003d8e291ae838feb42013', focusY: 43 },
  brainlet: { file: join(PUBLIC, 'art', 'brainlet', 'B5D288A5-2281-4654-A9E0-E197E5AE4246.jpg'), sha256: '421e25e1bf1819ffd11ec6d190794b3ab47f0e80a12096282ab1a223055b0adc', focusY: 33 },
  rizz: { file: join(PUBLIC, 'art', 'rizz', 'B40345D2-9FCF-4110-979A-572B2CE7FE38.jpg'), sha256: '655a30db9c9205cc50e1656f0007e0240c5cfff40fedbfcb5846f1d118df3826', focusY: 41 },
};
// The drawn ring's colour per pair coin: violet SOL, blue USDC, as the island's turned rings.
const DOOR_RINGS = { sol: '#8f6bff', usdc: '#3d8bff' };
// The art's radius inside the 512 px square; the ring sits just outside it.
const DOOR_R = 205;

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

/** A bungalow's door art in a circle, ringed in the pair's colour, as an opaque 512 px PNG. */
async function renderDoor(id, ring) {
  const door = DOORS[id];
  const colour = DOOR_RINGS[ring];
  if (!door) throw new Error(`no door art pinned for the bungalow "${id}"`);
  if (!colour) throw new Error(`no drawn ring colour named "${ring}"`);
  const art = readFileSync(door.file);
  if (sha256(art) !== door.sha256) throw new Error(`${door.file} is not the door art these pictures were made from. Look at the new art before changing its sha256.`);
  const { width, height } = await sharp(art).metadata();
  const side = Math.min(width, height);
  const left = Math.round((width - side) / 2);
  const top = Math.round(((height - side) * door.focusY) / 100);
  const d = 2 * DOOR_R;
  const square = await sharp(art).extract({ left, top, width: side, height: side }).resize(d, d, { kernel: 'lanczos3' }).png().toBuffer();
  const circle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><circle cx="${DOOR_R}" cy="${DOOR_R}" r="${DOOR_R}" fill="#fff"/></svg>`);
  const round = await sharp(square).composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer();
  const c = S / 2;
  const rings = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
  <defs><filter id="g" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter></defs>
  <circle cx="${c}" cy="${c}" r="${DOOR_R + 14}" fill="none" stroke="${colour}" stroke-width="14" opacity="0.75" filter="url(#g)"/>
  <circle cx="${c}" cy="${c}" r="${DOOR_R + 12}" fill="none" stroke="${colour}" stroke-width="6"/>
  <circle cx="${c}" cy="${c}" r="${DOOR_R + 12}" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.7"/></svg>`);
  return sharp({ create: { width: S, height: S, channels: 3, background: '#000' } })
    .composite([{ input: round, left: c - DOOR_R, top: c - DOOR_R }, { input: rings }])
    .removeAlpha().png({ compressionLevel: 9 }).toBuffer();
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
const slugs = new Map();
for (const [fileName, token] of rows) {
  const bytes = token.art ? await renderDoor(token.art, token.ring) : pictures[token.ring];
  if (!bytes) throw new Error(`${token.name}: no ring colour named "${token.ring}"`);
  // Two tokens may share a picture (owner, 2026-10-24: every share of a coin that is not a
  // bungalow's carries BAYLA's), but one slug never names two different pictures.
  const seen = slugs.get(token.picture);
  if (seen && !seen.equals(bytes)) throw new Error(`${token.name}: the slug "${token.picture}" already names a different picture`);
  slugs.set(token.picture, bytes);
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
