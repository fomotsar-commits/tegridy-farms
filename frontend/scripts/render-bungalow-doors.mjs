// Per-door social unfurls for Jungle Bay bungalows (postbuild).
//
// The app is an SPA: crawlers fetching memetics.finance/bayla get index.html
// and unfurl the venue's TOWELI og tags. Vercel serves the filesystem before
// SPA rewrites, so emitting dist/<door>/index.html — the same shell with the
// door's own <head> identity — gives every bungalow link a real unfurl with
// zero runtime cost. The client bundle inside is byte-identical; React Router
// still owns the page once it boots.
//
// Runs automatically via the `postbuild` npm hook. FAIL-LOUD: every head
// transform must match exactly once or the build dies — a silently wrong
// unfurl is the failure mode this script exists to prevent.
//
// DOORS is deliberately self-contained (this runs under whatever Node Vercel
// gives us — no TS imports). src/lib/bungalowDoors.test.ts pins it against
// the registry so the two cannot drift.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SITE = 'https://memetics.finance'; // canonical origin, per index.html's own tags
const DIST = resolve(process.cwd(), 'dist');

// Settled doors share one honest formula: plaque facts only — no market
// numbers, no partnership claims. og images are the slots' existing classic
// thumbs (their own art arrives with the community drop; swap images then).
// KEPT AS LITERAL OBJECTS on purpose: bungalowDoors.test.ts pins this file
// with line-shape regexes (path:/image: lines) — a factory would defeat the
// lock-step and let the registry and this manifest drift silently.
const settledDesc = (name, chain) =>
  `${name} has a settled bungalow on Jungle Bay Island — contract, trade route ` +
  `and held-time heat live today on ${chain}. The full art skin opens with the ` +
  `community's drop. Dank Memes + Time = Memetic Finance.`;
const settledAlt = (name) =>
  `${name}'s bungalow door on Jungle Bay Island — classic island art until the community's drop`;

const DOORS = [
  {
    path: 'bayla',
    title: 'BAYLA | The muse of Jungle Bay Island',
    description:
      'Bayla is the muse of Jungle Bay Island — brought to light by the Jungle Bay ' +
      'Artists Collective, living on Solana. Trade her, hold her for heat, and stake ' +
      'at the lighthouse — the pool is live on-chain. Dank Memes + Time = Memetic Finance.',
    image: '/art/bayla/bayla-23.jpg',
    imageType: 'image/jpeg',
    imageWidth: '2048',
    imageHeight: '1152',
    imageAlt: 'BAYLA / SOL on Jungle Bay Island — the muse of the island, on Solana',
  },
  {
    path: 'pepe',
    title: 'PEPE | Jungle Bay Island',
    description: settledDesc('Pepe', 'Ethereum'),
    image: '/art/jungle-dark.jpg',
    imageType: 'image/jpeg',
    imageWidth: '238',
    imageHeight: '240',
    imageAlt: settledAlt('Pepe'),
  },
  {
    path: 'qr',
    title: 'QR | Jungle Bay Island',
    description: settledDesc('QR', 'Base'),
    image: '/art/jungle-dark.jpg',
    imageType: 'image/jpeg',
    imageWidth: '238',
    imageHeight: '240',
    imageAlt: settledAlt('QR'),
  },
  {
    path: 'mfer',
    title: 'MFER | Jungle Bay Island',
    description: settledDesc('MFER', 'Base'),
    image: '/art/mfers-heaven.jpg',
    imageType: 'image/jpeg',
    imageWidth: '1470',
    imageHeight: '2048',
    imageAlt: settledAlt('MFER'),
  },
  {
    path: 'bnkr',
    title: 'BNKR | Jungle Bay Island',
    description: settledDesc('BNKR', 'Base'),
    image: '/art/jungle-dark.jpg',
    imageType: 'image/jpeg',
    imageWidth: '238',
    imageHeight: '240',
    imageAlt: settledAlt('BNKR'),
  },
  {
    path: 'drb',
    title: 'DRB | Jungle Bay Island',
    description: settledDesc('DRB', 'Base'),
    image: '/art/boxing-ring.jpg',
    imageType: 'image/jpeg',
    imageWidth: '1064',
    imageHeight: '1117',
    imageAlt: settledAlt('DRB'),
  },
  {
    path: 'bobo',
    title: 'BOBO | Jungle Bay Island',
    description: settledDesc('BOBO', 'Solana'),
    image: '/art/jungle-dark.jpg',
    imageType: 'image/jpeg',
    imageWidth: '238',
    imageHeight: '240',
    imageAlt: settledAlt('BOBO'),
  },
  {
    path: 'jbm',
    title: 'JBM | Jungle Bay Island',
    description: settledDesc('JBM', 'Base'),
    image: '/art/jungle-bus.jpg',
    imageType: 'image/jpeg',
    imageWidth: '1200',
    imageHeight: '809',
    imageAlt: settledAlt('JBM'),
  },
  {
    path: 'soy',
    title: 'SOY | Jungle Bay Island',
    description: settledDesc('SOY', 'Solana'),
    image: '/art/jungle-dark.jpg',
    imageType: 'image/jpeg',
    imageWidth: '238',
    imageHeight: '240',
    imageAlt: settledAlt('SOY'),
  },
  {
    path: 'brainlet',
    title: 'BRAINLET | Jungle Bay Island',
    description: settledDesc('Brainlet', 'Solana'),
    image: '/art/beach-vibes.jpg',
    imageType: 'image/jpeg',
    imageWidth: '738',
    imageHeight: '738',
    imageAlt: settledAlt('Brainlet'),
  },
  {
    path: 'rizz',
    title: 'RIZZ | Jungle Bay Island',
    description: settledDesc('RIZZ', 'Base'),
    image: '/art/jungle-dark.jpg',
    imageType: 'image/jpeg',
    imageWidth: '238',
    imageHeight: '240',
    imageAlt: settledAlt('RIZZ'),
  },
  // toweli (and its /towelie alias) intentionally have NO entry: the venue
  // default IS the Toweli identity, so those doors serve the stock shell.
  // nb1 (the quiet slot) also has none: no token, nothing to unfurl.
];

function transform(html, door) {
  let out = html;
  const swap = (label, pattern, replacement) => {
    const matches = out.match(pattern);
    if (!matches || matches.length !== 1) {
      throw new Error(
        `[bungalow-doors] ${door.path}: expected exactly one match for ${label}, got ${matches ? matches.length : 0} — index.html's head changed shape; update this script deliberately.`,
      );
    }
    out = out.replace(pattern, replacement);
  };

  const abs = (p) => `${SITE}${p}`;
  const url = `${SITE}/${door.path}`;

  swap('<title>', /<title>[^<]*<\/title>/, `<title>${door.title}</title>`);
  swap('canonical', /<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${url}" />`);
  swap('meta description', /<meta name="description" content="[^"]*">/, `<meta name="description" content="${door.description}">`);
  swap('og:title', /<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${door.title}" />`);
  swap('og:description', /<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${door.description}" />`);
  swap('og:image', /<meta property="og:image" content="[^"]*" \/>/, `<meta property="og:image" content="${abs(door.image)}" />`);
  swap('og:image:secure_url', /<meta property="og:image:secure_url" content="[^"]*" \/>/, `<meta property="og:image:secure_url" content="${abs(door.image)}" />`);
  swap('og:image:type', /<meta property="og:image:type" content="[^"]*" \/>/, `<meta property="og:image:type" content="${door.imageType}" />`);
  swap('og:image:width', /<meta property="og:image:width" content="[^"]*" \/>/, `<meta property="og:image:width" content="${door.imageWidth}" />`);
  swap('og:image:height', /<meta property="og:image:height" content="[^"]*" \/>/, `<meta property="og:image:height" content="${door.imageHeight}" />`);
  swap('og:image:alt', /<meta property="og:image:alt" content="[^"]*" \/>/, `<meta property="og:image:alt" content="${door.imageAlt}" />`);
  swap('og:url', /<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${url}" />`);
  swap('twitter:title', /<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${door.title}" />`);
  swap('twitter:description', /<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${door.description}" />`);
  swap('twitter:image" ', /<meta name="twitter:image" content="[^"]*" \/>/, `<meta name="twitter:image" content="${abs(door.image)}" />`);
  swap('twitter:image:alt', /<meta name="twitter:image:alt" content="[^"]*" \/>/, `<meta name="twitter:image:alt" content="${door.imageAlt}" />`);
  swap('twitter:url', /<meta name="twitter:url" content="[^"]*" \/>/, `<meta name="twitter:url" content="${url}" />`);
  return out;
}

const shellPath = resolve(DIST, 'index.html');
if (!existsSync(shellPath)) {
  throw new Error('[bungalow-doors] dist/index.html not found — run after `vite build`.');
}
const shell = readFileSync(shellPath, 'utf8');

for (const door of DOORS) {
  const imgOnDisk = resolve(process.cwd(), `public${door.image}`);
  if (!existsSync(imgOnDisk)) {
    throw new Error(`[bungalow-doors] ${door.path}: og image ${door.image} missing from public/.`);
  }
  const dir = resolve(DIST, door.path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'index.html'), transform(shell, door));
  console.log(`[bungalow-doors] wrote dist/${door.path}/index.html`);
}
console.log(`[bungalow-doors] ${DOORS.length} door(s) rendered.`);
