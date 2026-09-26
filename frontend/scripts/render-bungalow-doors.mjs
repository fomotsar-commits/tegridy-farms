// Writes dist/<door>/index.html for each Jungle Bay bungalow, after `vite build`.
// Vercel serves that file at /<door> before the SPA rewrite, so a door carries its own
// <head> (unfurl tags) and its own first frame: the heading and art its React hero
// renders, so a crawler reads the door and a visitor sees no swap when React takes over.
// FAIL-LOUD: every transform matches exactly once or the build dies. DOORS is plain JS
// (no TS loader here); src/lib/bungalowDoors.test.ts pins it to the registry and pageArt.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivedUrl, widthsForEntry } from './derivative-url.mjs';

const SITE = 'https://memetics.finance'; // canonical origin, per index.html's own tags
const DIST = resolve(process.cwd(), 'dist');
const MANIFEST_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'artDerivatives.generated.json');

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
// The first frame: BungalowHero's H1 (heroTitle, heroLine) over pageArt('home', 0).
const SETTLED_LINE = 'Settled on Jungle Bay Island.';

export const DOORS = [
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
    heroTitle: 'BAYLA.',
    heroLine: 'The muse was always here.',
    heroArt: '/art/bayla/bayla-05.jpg',
    heroPosition: '72% 47%',
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
    heroTitle: 'PEPE.',
    heroLine: SETTLED_LINE,
    heroArt: '/art/pepe/8EE4313B-CCDC-427D-AF2E-7C8D9F38D207.jpg',
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
    heroTitle: 'QR.',
    heroLine: SETTLED_LINE,
    heroArt: '/art/qr/37C87BC2-E189-44D5-8738-CB827829842D.jpg',
    heroPosition: '50% 77%',
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
    heroTitle: 'MFER.',
    heroLine: SETTLED_LINE,
    heroArt: '/art/mfer/7F184A9A-142E-4639-8D01-8225980F1A9F.jpg',
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
    heroTitle: 'BNKR.',
    heroLine: SETTLED_LINE,
    heroArt: '/art/bnkr/9B04A686-223B-4CA6-8379-FB4A416B9A42.jpg',
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
    heroTitle: 'DRB.',
    heroLine: SETTLED_LINE,
    heroArt: '/art/drb/5A132AF8-4C2E-4DE9-A937-D59CFFC98F5C.jpg',
    heroPosition: '50% 82%',
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
    heroTitle: 'BOBO.',
    heroLine: SETTLED_LINE,
    heroArt: '/art/bobo/28B3540D-E16A-4FF4-B0E8-224EF8F42840.jpg',
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
    heroTitle: 'JBM.',
    heroLine: SETTLED_LINE,
    heroArt: '/art/jbm/9DEB6D3D-9F73-4F57-AA28-83FEC6408E30.jpg',
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
    heroTitle: 'SOY.',
    heroLine: SETTLED_LINE,
    heroArt: '/art/soy/4035E458-23CF-4DFB-ABC5-0299C434D0CE.jpg',
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
    heroTitle: 'BRAINLET.',
    heroLine: SETTLED_LINE,
    heroArt: '/art/brainlet/3ADF6CD5-3562-41ED-ADC1-D45696ED2047.jpg',
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
    heroTitle: 'RIZZ.',
    heroLine: SETTLED_LINE,
    heroArt: '/art/rizz/367449C0-2CBC-44FA-9EF2-933F3EF7846F.png',
  },
  // toweli (and its /towelie alias) and nb1 have no entry: they serve the stock
  // shell, where the venue's frame opens only on `/`.
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The srcset ArtImg asks for in production (lib/artSrcSet.ts), or undefined. */
export function srcsetFor(src, manifest) {
  const entry = manifest[src];
  const natural = Array.isArray(entry) ? entry[0] : entry;
  const widths = entry === undefined ? [] : widthsForEntry(entry);
  if (!natural || widths.length === 0) return undefined;
  return [...widths.map((w) => `${derivedUrl(src, w)} ${w}w`), `${src} ${natural}w`].join(', ');
}

/** The heading's markup: BungalowHero's H1, a real space before the break. */
const headingHtml = (door) => `${esc(door.heroTitle)} <br><span>${esc(door.heroLine)}</span>`;

// The hero's chain-pill row (24.5 px, then mb-5) sits above its H1, and .heading-luxury
// spaces its letters at 0.01em. The frame holds both, so the heading neither moves nor
// re-spaces when React takes over. DoorFrame.tsx carries the same two.
export const PILL_ROW_STYLE = 'height:24.5px;margin:0 0 1.25rem';
export const HEADING_STYLE = 'letter-spacing:0.01em';

/** The door's first frame: the ff-* markup index.html styles, with no venue copy. */
function doorFrame(door, manifest) {
  const srcset = srcsetFor(door.heroArt, manifest);
  const img = [
    `src="${esc(door.heroArt)}"`,
    srcset && `srcset="${esc(srcset)}" sizes="100vw"`,
    'alt="" width="1200" height="800" fetchpriority="high" decoding="async"',
    door.heroPosition && `style="object-position:${esc(door.heroPosition)}"`,
  ].filter(Boolean).join(' ');
  return (
    `<!-- first-frame --><div id="first-frame"><div class="ff-bg"><img ${img}></div>` +
    `<div class="ff-wrap"><div class="ff-col"><div aria-hidden="true" style="${PILL_ROW_STYLE}"></div>` +
    `<h1 class="ff-h1" elementtiming="first-frame-h1" style="${HEADING_STYLE}">${headingHtml(door)}</h1></div></div></div><!-- /first-frame -->`
  );
}

/** What a crawler reads: one frame, its one h1 the door's heading, no heading naming the venue. */
function checkDoorPage(out, door) {
  const fail = (why) => {
    throw new Error(`[bungalow-doors] ${door.path}: ${why}`);
  };
  const frames = out.match(/<!-- first-frame -->[\s\S]*?<!-- \/first-frame -->/g) ?? [];
  if (frames.length !== 1) fail(`expected one first-frame block, got ${frames.length}.`);
  const h1s = frames[0].match(/<h1[\s>][\s\S]*?<\/h1>/g) ?? [];
  if (h1s.length !== 1 || !h1s[0].endsWith(`>${headingHtml(door)}</h1>`)) fail("the frame's h1 is not the door's heading.");
  if ((out.match(/<h1[\s>]/g) ?? []).length !== 1) fail('an h1 outside the first frame.');
  if (/<h[1-6][\s>](?:(?!<\/h[1-6]>)[\s\S])*MEMETICS\.FINANCE/i.test(out)) fail('a heading names MEMETICS.FINANCE.');
}

export function transform(html, door, manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))) {
  let out = html;
  const swap = (label, pattern, replacement) => {
    const count = (out.match(new RegExp(pattern.source, 'g')) ?? []).length;
    if (count !== 1) {
      throw new Error(
        `[bungalow-doors] ${door.path}: expected exactly one match for ${label}, got ${count}. index.html changed shape; update this script deliberately.`,
      );
    }
    // A function replacer: a `$&` or `$1` in a field is text, never a pattern.
    out = out.replace(pattern, typeof replacement === 'function' ? replacement : () => replacement);
  };

  const abs = (p) => esc(`${SITE}${p}`);
  const url = esc(`${SITE}/${door.path}`);
  const title = esc(door.title);
  const description = esc(door.description);
  const alt = esc(door.imageAlt);

  swap('<title>', /<title>[^<]*<\/title>/, `<title>${title}</title>`);
  swap('canonical', /<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${url}" />`);
  swap('meta description', /<meta name="description" content="[^"]*">/, `<meta name="description" content="${description}">`);
  swap('og:title', /<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${title}" />`);
  swap('og:description', /<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${description}" />`);
  swap('og:image', /<meta property="og:image" content="[^"]*" \/>/, `<meta property="og:image" content="${abs(door.image)}" />`);
  swap('og:image:secure_url', /<meta property="og:image:secure_url" content="[^"]*" \/>/, `<meta property="og:image:secure_url" content="${abs(door.image)}" />`);
  swap('og:image:type', /<meta property="og:image:type" content="[^"]*" \/>/, `<meta property="og:image:type" content="${esc(door.imageType)}" />`);
  swap('og:image:width', /<meta property="og:image:width" content="[^"]*" \/>/, `<meta property="og:image:width" content="${esc(door.imageWidth)}" />`);
  swap('og:image:height', /<meta property="og:image:height" content="[^"]*" \/>/, `<meta property="og:image:height" content="${esc(door.imageHeight)}" />`);
  swap('og:image:alt', /<meta property="og:image:alt" content="[^"]*" \/>/, `<meta property="og:image:alt" content="${alt}" />`);
  swap('og:url', /<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${url}" />`);
  swap('twitter:title', /<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${title}" />`);
  swap('twitter:description', /<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${description}" />`);
  swap('twitter:image" ', /<meta name="twitter:image" content="[^"]*" \/>/, `<meta name="twitter:image" content="${abs(door.image)}" />`);
  swap('twitter:image:alt', /<meta name="twitter:image:alt" content="[^"]*" \/>/, `<meta name="twitter:image:alt" content="${alt}" />`);
  swap('twitter:url', /<meta name="twitter:url" content="[^"]*" \/>/, `<meta name="twitter:url" content="${url}" />`);
  // The venue's frame out, the door's in. The attribute means "a static frame is on
  // screen": index.html's CSS shows it, theme-init keeps it, and the first route skips
  // its fade-in. The no-script heading becomes a paragraph, so the door's is the only h1.
  swap('first frame', /<!-- first-frame -->[\s\S]*?<!-- \/first-frame -->/, doorFrame(door, manifest));
  swap('<html>', /<html lang="en">/, '<html lang="en" data-first-frame="venue">');
  swap('no-script heading', /(<noscript>(?:(?!<\/noscript>)[\s\S])*?)<h1 style="([^"]*)">([^<]*)<\/h1>/,
    (_all, before, style, text) => `${before}<p style="${style};font-weight:700">${text}</p>`);
  checkDoorPage(out, door);
  return out;
}

const cliPath = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
if (process.argv[1] && cliPath(resolve(process.argv[1])) === cliPath(fileURLToPath(import.meta.url))) {
  const shellPath = resolve(DIST, 'index.html');
  if (!existsSync(shellPath)) {
    throw new Error('[bungalow-doors] dist/index.html not found: run after `vite build`.');
  }
  const shell = readFileSync(shellPath, 'utf8');
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  for (const door of DOORS) {
    for (const file of [door.image, door.heroArt]) {
      if (!existsSync(resolve(process.cwd(), `public${file}`))) {
        throw new Error(`[bungalow-doors] ${door.path}: ${file} missing from public/.`);
      }
    }
    // Every candidate the frame asks for must be a file this build wrote, or a phone
    // gets a broken hero until React replaces it.
    const set = srcsetFor(door.heroArt, manifest) ?? '';
    for (const candidate of set.split(', ').filter(Boolean).map((c) => c.split(' ')[0])) {
      if (!existsSync(resolve(DIST, `.${candidate}`))) {
        throw new Error(`[bungalow-doors] ${door.path}: ${candidate} is not in dist/.`);
      }
    }
    const dir = resolve(DIST, door.path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'index.html'), transform(shell, door, manifest));
    console.log(`[bungalow-doors] wrote dist/${door.path}/index.html`);
  }
  console.log(`[bungalow-doors] ${DOORS.length} door(s) rendered.`);
}
