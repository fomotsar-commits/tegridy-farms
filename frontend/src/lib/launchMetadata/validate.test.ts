// @vitest-environment node
// The launch-metadata rules. Each refusal below is an attack or an accident that
// would otherwise be written into a LOCKED metadata account or pinned forever.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CREATED_ON,
  LIMITS,
  checkContentUri,
  checkDescription,
  checkLink,
  checkLinks,
  checkName,
  checkSymbol,
  displaySafe,
  foldForCompare,
  hasEmbeddedMetadata,
  impersonates,
  impersonatesAll,
  impersonationWarning,
  isPubkeyString,
  parseLaunchMetadataJson,
  sha256Hex,
  sniffImage,
  uploadAuthMessage,
  buildMetadataJson,
  detailsDigestInput,
} from './validate.js';
import { PNG_1X1, SVG, gif, jpeg, png, webpVp8, webpVp8l, webpVp8x } from './testImages.fixture';
import { cspAllows } from '../../test/csp';
import { SITE_URL } from '../constants';
import { ipfsGatewayUrls } from '../ipfsGateways';

const MINT = 'So11111111111111111111111111111111111111112';
const OTHER = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';

const refused = (r: { ok: boolean }) => expect(r.ok).toBe(false);
const value = <T,>(r: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.value;
};

describe('checkName', () => {
  it('accepts an ordinary name, emoji, accented letters and an emoji ZWJ sequence', () => {
    expect(value(checkName('  Pepe the Frog  '))).toBe('Pepe the Frog');
    expect(value(checkName('Frog 🐸'))).toBe('Frog 🐸');
    expect(value(checkName('Café Crème'))).toBe('Café Crème');
    expect(value(checkName('Fam 👨\u200D👩\u200D👧'))).toBe('Fam 👨\u200D👩\u200D👧');
  });

  it('normalises to NFC so the same name is always the same bytes', () => {
    expect(value(checkName('Cafe\u0301'))).toBe('Café');
  });

  it.each([
    ['right-to-left override', 'Pepe\u202Eeht'],
    ['left-to-right isolate', 'Pepe\u2066x'],
    ['zero-width space', 'Pe\u200Bpe'],
    ['zero-width joiner between letters', 'Pe\u200Dpe'],
    ['byte-order mark inside the name', 'Pe\uFEFFpe'],
    ['soft hyphen', 'Pe\u00ADpe'],
    ['tag character (ASCII smuggling)', 'Pepe\u{E0041}'],
    ['a line break', 'Pepe\nUSDC'],
    ['a NUL', 'Pepe\u0000'],
    ['Hangul filler (blank-looking letter)', '\u3164'],
    ['braille blank', 'Pepe\u2800'],
    ['non-breaking space', 'Pepe\u00A0Frog'],
    ['ideographic space', 'Pepe\u3000Frog'],
    ['double space', 'Pepe  Frog'],
    // NFC folds the first accent into the letter, so four marks leave three stacked.
    ['stacked accents', 'Pe\u0301\u0302\u0303\u0304pe'],
    ['private-use character', 'Pepe'],
    ['only punctuation', '...'],
    ['empty', '   '],
    ['not a string', 42],
  ])('refuses %s', (_label, raw) => {
    refused(checkName(raw));
  });

  it('counts the 32-byte cap in UTF-8 bytes, not characters', () => {
    expect(value(checkName('a'.repeat(32)))).toHaveLength(32);
    refused(checkName('a'.repeat(33)));
    // 'ж' is 2 bytes: 16 of them are 32 bytes, 17 are 34.
    expect(checkName('ж'.repeat(16)).ok).toBe(true);
    refused(checkName('ж'.repeat(17)));
  });

  it.each(['Solana', 'S0LANA', 'USD Coin', 'Tether', 'USDC', 'Tegridy Farms', 'Official TOWELI', 'BaylaCoin', 'Memetics Cat', 'ЅOLANA'])(
    'refuses a name that copies a reserved one: %s',
    (raw) => refused(checkName(raw)),
  );

  // ATK-5 (audit 2026-10-03): the pool pages compare names with these same rules, so the
  // spellings their own, older check caught are caught here too.
  it.each([
    ['an accent on a letter', 'Sölana'],
    ['a ticker written with its $', '$SOL'],
    ['a brand word written with its $ inside a longer name', 'Official $BAYLA'],
    ['a Greek lower-case upsilon for the u', 'υsdc'],
    ['a Greek lower-case mu for the u', 'μsdt'],
  ])('refuses a reserved name spelled with %s', (_l, raw) => refused(checkName(raw)));

  // A short brand word is looked for word by word, so the words must be the ones a
  // reader sees. A mark drawn on a letter, or a character drawn as nothing, is not a gap.
  it.each([
    ['a combining mark that has no single-letter form', 'B\u0358ayla Token'],
    ['an invisible combining joiner', 'BA\u034FYLA Token'],
    ['a variation selector', 'BA\uFE0FYLA Token'],
  ])('refuses a brand word with %s inside it', (_l, raw) => refused(checkName(raw)));

  it('reads a brand word through characters that are not shown, in text any client wrote', () => {
    // zero-width space, soft hyphen, word joiner, private use, braille blank
    for (const hidden of ['\u200B', '\u00AD', '\u2060', '\uE000', '\u2800']) {
      const text = `Bay${hidden}la Token`;
      expect(displaySafe(text, 32), JSON.stringify(text)).toBe('Bayla Token');
      expect(impersonates(text), JSON.stringify(text)).toBe('BAYLA');
    }
    // A gap a reader can see is still a gap.
    expect(impersonates('Bay la Token')).toBeNull();
    expect(impersonates('Bay\tla Token')).toBeNull();
  });

  it('names every reserved word a text copies, and `impersonates` is the first of them', () => {
    expect(impersonatesAll('Bayla by Tegridy')).toEqual(['TEGRIDY', 'BAYLA']);
    expect(impersonates('Bayla by Tegridy')).toBe('TEGRIDY');
    expect(impersonatesAll('Official $TOWELI BAYLA2')).toEqual(['TOWELI', 'BAYLA']);
    expect(impersonatesAll('$SOL')).toEqual(['SOL']);
    expect(impersonatesAll('Pepe')).toEqual([]);
    expect(impersonatesAll('')).toEqual([]);
    for (const text of ['Solana', 'S0L', 'Tegridy Farms', 'BaylaCoin', 'Pepe', '...']) {
      expect(impersonates(text), text).toBe(impersonatesAll(text)[0] ?? null);
    }
  });

  it('does not refuse a name that merely contains the letters of a short brand word', () => {
    expect(checkName('Bay Lagoon').ok).toBe(true);
    expect(checkName('Solar Cat').ok).toBe(true);
    expect(checkName('Cash $ Carry').ok).toBe(true);
  });
});

describe('checkSymbol', () => {
  it('upper-cases and drops a leading $', () => {
    expect(value(checkSymbol('pepe'))).toBe('PEPE');
    expect(value(checkSymbol('$frog2'))).toBe('FROG2');
  });

  it.each([
    ['one character', 'A'],
    ['eleven characters', 'ABCDEFGHIJK'],
    ['punctuation', 'PE-PE'],
    ['a space', 'PE PE'],
    ['a Cyrillic lookalike letter', 'РЕРЕ'],
    ['a full-width letter', 'ＰＥＰＥ'],
    ['an emoji', 'PEPE🐸'],
  ])('refuses %s', (_l, raw) => refused(checkSymbol(raw)));

  it.each(['SOL', 'sol', 'S0L', '501', 'WSOL', 'USDC', 'U5DC', 'USDT', 'TOWELI', 'T0WEL1', 'TEGRIDY', 'TEGRIDYX', 'BAYLA', 'BONK', 'B0NK'])(
    'refuses the reserved ticker or its lookalike %s',
    (raw) => refused(checkSymbol(raw)),
  );

  it('folds lookalikes to one skeleton on both sides', () => {
    expect(foldForCompare('S0L')).toBe(foldForCompare('SOL'));
    expect(foldForCompare('ЅOL')).toBe(foldForCompare('SOL'));
    expect(foldForCompare('U$DC')).toBe(foldForCompare('USDC'));
    expect(foldForCompare('Sölana')).toBe(foldForCompare('Solana'));
  });
});

describe('checkDescription', () => {
  it('is optional', () => {
    expect(value(checkDescription(undefined))).toBe('');
    expect(value(checkDescription(''))).toBe('');
  });
  it('keeps line breaks, normalises CRLF and collapses long runs of blank lines', () => {
    expect(value(checkDescription('a\r\nb\n\n\n\nc'))).toBe('a\nb\n\nc');
  });
  it('caps at 280 characters', () => {
    expect(checkDescription('x'.repeat(LIMITS.descriptionChars)).ok).toBe(true);
    refused(checkDescription('x'.repeat(LIMITS.descriptionChars + 1)));
  });
  it('refuses hidden direction characters on any line', () => {
    refused(checkDescription('fine\nnot \u202Efine'));
  });
});

describe('checkLink', () => {
  it('canonicalises the three kinds', () => {
    expect(value(checkLink('website', 'example.com'))).toBe('https://example.com/');
    expect(value(checkLink('website', 'https://pepe.io/about?x=1'))).toBe('https://pepe.io/about?x=1');
    expect(value(checkLink('twitter', '@pepe_frog'))).toBe('https://x.com/pepe_frog');
    expect(value(checkLink('twitter', 'pepe_frog'))).toBe('https://x.com/pepe_frog');
    expect(value(checkLink('twitter', 'https://twitter.com/pepe_frog/'))).toBe('https://x.com/pepe_frog');
    expect(value(checkLink('telegram', '@pepegroup'))).toBe('https://t.me/pepegroup');
    expect(value(checkLink('telegram', 'pepegroup'))).toBe('https://t.me/pepegroup');
    expect(value(checkLink('telegram', 't.me/+AbCdEfGhIjK'))).toBe('https://t.me/+AbCdEfGhIjK');
    expect(value(checkLink('telegram', 'https://t.me/joinchat/AbCdEfGhIjK'))).toBe('https://t.me/+AbCdEfGhIjK');
    expect(checkLink('website', '').ok).toBe(true);
  });

  it.each([
    ['website', 'http://pepe.io'],
    ['website', 'javascript:alert(1)'],
    ['website', 'data:text/html,hi'],
    ['website', 'https://user:pass@pepe.io'],
    ['website', 'https://pepe.io:8443/'],
    ['website', 'https://127.0.0.1/'],
    ['website', 'https://localhost/'],
    ['website', 'https://phantοm.app/'], // Greek omicron: becomes xn--
    ['website', 'https://pepe.io/<script>'],
    ['website', `https://pepe.io/${'a'.repeat(120)}`],
    ['twitter', 'https://x.com/pepe/status/1'],
    ['twitter', 'https://evil.com/x.com/pepe'],
    ['twitter', 'https://x.com.evil.com/pepe'],
    ['twitter', '@this_handle_is_too_long'],
    ['telegram', 'https://t.me.evil.com/pepe'],
    ['telegram', 'https://t.me/pepe?start=1'],
  ] as const)('refuses %s %s', (kind, raw) => refused(checkLink(kind, raw)));

  it('reports which field failed', () => {
    const r = checkLinks({ website: 'https://pepe.io', twitter: 'https://evil.com/x' });
    expect(r).toMatchObject({ ok: false, field: 'twitter' });
  });
});

describe('displaySafe', () => {
  it('strips direction, zero-width, control and invisible characters', () => {
    expect(displaySafe('USD\u202EC\u200B\u0000\u3164', 32)).toBe('USDC');
  });
  it('drops a joiner that is not inside an emoji sequence', () => {
    expect(displaySafe('Pe\u200Dpe', 32)).toBe('Pepe');
  });
  it('keeps an emoji ZWJ sequence whole', () => {
    expect(displaySafe('Fam 👨\u200D👩\u200D👧', 32)).toBe('Fam 👨\u200D👩\u200D👧');
  });
  it('caps stacked accents, collapses whitespace and truncates', () => {
    expect(displaySafe('x\u0301\u0302\u0303\u0304', 10)).toBe('x\u0301\u0302');
    expect(displaySafe('a \n\t b', 10)).toBe('a b');
    expect(displaySafe('abcdefghij', 5)).toBe('abcd…');
  });
  it('never throws and always returns a string', () => {
    expect(displaySafe(undefined, 5)).toBe('');
    expect(displaySafe({ toString: () => 'x' }, 5)).toBe('');
  });
});

describe('sniffImage', () => {
  it.each([
    ['real PNG', PNG_1X1, 'image/png', 1, 1],
    ['PNG', png(640, 480), 'image/png', 640, 480],
    ['baseline JPEG', jpeg(800, 600), 'image/jpeg', 800, 600],
    ['progressive JPEG', jpeg(800, 600, { progressive: true }), 'image/jpeg', 800, 600],
    ['GIF', gif(64, 32), 'image/gif', 64, 32],
    ['WebP VP8X', webpVp8x(1024, 768), 'image/webp', 1024, 768],
    ['WebP VP8L', webpVp8l(300, 200), 'image/webp', 300, 200],
    ['WebP VP8', webpVp8(320, 240), 'image/webp', 320, 240],
  ] as const)('reads %s by its bytes', (_l, bytes, mime, width, height) => {
    expect(sniffImage(bytes)).toEqual({ ok: true, mime, width, height });
  });

  it('refuses SVG, HTML and unknown bytes whatever they claim to be', () => {
    refused(sniffImage(SVG));
    refused(sniffImage(new TextEncoder().encode('<html><body>hi</body></html>')));
    refused(sniffImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
    refused(sniffImage(new Uint8Array()));
  });

  it('refuses a picture that decodes wider or taller than 4096 pixels (a small file can be a huge bitmap)', () => {
    refused(sniffImage(png(4097, 10)));
    refused(sniffImage(webpVp8x(10, 20000)));
    expect(sniffImage(png(4096, 4096)).ok).toBe(true);
  });

  it('refuses more than 1 MiB', () => {
    const big = new Uint8Array(LIMITS.imageBytes + 1);
    big.set(png(10, 10));
    refused(sniffImage(big));
  });

  it('refuses a JPEG whose size header is missing', () => {
    refused(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])));
  });
});

describe('hasEmbeddedMetadata', () => {
  it.each([
    ['JPEG with EXIF (where a phone photo was taken)', jpeg(10, 10, { exif: true }), 'image/jpeg'],
    ['JPEG with XMP', jpeg(10, 10, { xmp: true }), 'image/jpeg'],
    ['JPEG with IPTC', jpeg(10, 10, { iptc: true }), 'image/jpeg'],
    ['PNG with a text chunk', png(10, 10, { text: true }), 'image/png'],
    ['WebP with EXIF', webpVp8x(10, 10, { exif: true }), 'image/webp'],
    ['GIF with XMP', gif(10, 10, { xmp: true }), 'image/gif'],
  ] as const)('finds %s', (_l, bytes, mime) => {
    expect(hasEmbeddedMetadata(bytes, mime)).toBe(true);
  });

  it.each([
    ['clean JPEG', jpeg(10, 10), 'image/jpeg'],
    ['clean PNG', PNG_1X1, 'image/png'],
    ['clean WebP', webpVp8x(10, 10), 'image/webp'],
    ['clean GIF', gif(10, 10), 'image/gif'],
  ] as const)('passes a %s', (_l, bytes, mime) => {
    expect(hasEmbeddedMetadata(bytes, mime)).toBe(false);
  });
});

describe('checkContentUri', () => {
  const CID0 = `Qm${'a'.repeat(44)}`;
  const CID1 = `bafkrei${'a'.repeat(52)}`;
  const V0 = `https://ipfs.io/ipfs/${CID0}`;
  const V1 = `https://ipfs.io/ipfs/${CID1}`;
  const AR = `https://arweave.net/${'A'.repeat(43)}`;

  it('accepts IPFS (v0 and v1) and Arweave content addresses', () => {
    expect(value(checkContentUri(V0))).toBe(`ipfs://${CID0}`);
    expect(value(checkContentUri(V1))).toBe(`ipfs://${CID1}`);
    expect(value(checkContentUri(AR))).toBe(AR);
  });

  // The metadata link is written on chain forever. ipfs.io and dweb.link were
  // retired on 2026-09-21, so a link that names a gateway dies with it: every IPFS
  // form must come back as the gateway-free ipfs://<cid>.
  it.each([
    ['ipfs://', `ipfs://${CID1}`],
    ['ipfs://ipfs/', `ipfs://ipfs/${CID1}`],
    ['a retired gateway', V1],
    ['another gateway', V1.replace('ipfs.io', 'gateway.pinata.cloud')],
    ['a lookalike host (never contacted: only the id is kept)', V1.replace('ipfs.io', 'ipfs.io.evil.com')],
    ['the subdomain form', `https://${CID1}.ipfs.w3s.link/`],
  ])('keeps only the content id of %s', (_l, u) => {
    expect(value(checkContentUri(u))).toBe(`ipfs://${CID1}`);
  });

  it.each([
    ['plain http', V1.replace('https', 'http')],
    ['a query', `${V1}?x=1`],
    ['a fragment', `${V1}#x`],
    ['a path after the CID', `${V1}/x.json`],
    ['a path after an ipfs:// CID', `ipfs://${CID1}/x.json`],
    ['an upper-case v1 CID', V1.toUpperCase().replace('HTTPS://IPFS.IO/IPFS/', 'https://ipfs.io/ipfs/')],
    ['a mutable web page', 'https://pepe.io/meta.json'],
    ['a short Arweave id', `https://arweave.net/${'A'.repeat(42)}`],
  ])('refuses %s', (_l, u) => refused(checkContentUri(u)));

  it('never tells people to use a retired gateway', () => {
    const r = checkContentUri('https://pepe.io/meta.json');
    expect(r.ok ? '' : r.reason).not.toMatch(/ipfs\.io|dweb\.link/);
  });

  // Two caps: the link written on chain (80, the launch transaction's budget) and the
  // longest pasted link read before it is cut down to its content id (100).
  it('stores at most 80 bytes, and every accepted form fits, the longest CID included', () => {
    expect(LIMITS.uriBytes).toBe(80);
    const longest = `b${'a'.repeat(70)}`;
    for (const u of [V0, V1, AR, `ipfs://${longest}`, `https://${longest}.ipfs.w3s.link/`]) {
      expect(new TextEncoder().encode(value(checkContentUri(u))).length, u).toBeLessThanOrEqual(LIMITS.uriBytes);
    }
  });

  it('a pasted gateway link longer than 80 is still read, up to 100', () => {
    expect(LIMITS.uriInputBytes).toBe(100);
    const pinata = V1.replace('ipfs.io', 'gateway.pinata.cloud');
    expect(new TextEncoder().encode(pinata).length).toBe(93);
    expect(value(checkContentUri(pinata))).toBe(`ipfs://${CID1}`);
    // A well-formed gateway link (a 60-character CID is allowed) that is one byte over.
    const tooLong = `https://${'g'.repeat(24)}.io/ipfs/${CID1}a`;
    expect(new TextEncoder().encode(tooLong).length).toBe(101);
    expect(checkContentUri(tooLong)).toMatchObject({ ok: false, reason: 'Too long: at most 100 characters.' });
  });

  it('the page is allowed to fetch and show them through every gateway it uses (vercel.json CSP)', () => {
    const urls = [...ipfsGatewayUrls(value(checkContentUri(V1))), AR];
    expect(urls.length).toBeGreaterThan(1);
    for (const u of urls) {
      expect(cspAllows('connect-src', u), `connect-src blocks ${u}`).toBe(true);
      expect(cspAllows('img-src', u), `img-src blocks ${u}`).toBe(true);
    }
  });

  it('the page may follow arweave.net’s redirect to its sandbox subdomain (a fetch checks every hop)', () => {
    // arweave.net answers 302 to https://<52 base32 chars>.arweave.net/<id> (checked with curl, 2026-09-26).
    const hop = `https://${'a'.repeat(52)}.arweave.net/${'A'.repeat(43)}`;
    expect(cspAllows('connect-src', hop), `connect-src blocks ${hop}`).toBe(true);
    expect(cspAllows('img-src', hop), `img-src blocks ${hop}`).toBe(true);
  });
});

describe('isPubkeyString', () => {
  it('needs base58 that decodes to 32 bytes', () => {
    expect(isPubkeyString(MINT)).toBe(true);
    expect(isPubkeyString('0OIl' + MINT.slice(4))).toBe(false);
    expect(isPubkeyString('1111')).toBe(false);
    expect(isPubkeyString(undefined)).toBe(false);
  });
});

describe('parseLaunchMetadataJson (a file ANY client may have written)', () => {
  const good = buildMetadataJson({
    name: 'Pepe', symbol: 'PEPE', description: 'frog', imageUri: `ipfs://bafkrei${'a'.repeat(52)}`,
    links: { website: 'https://pepe.io/' }, mint: MINT,
  });

  it('round-trips a file this site made', () => {
    const r = parseLaunchMetadataJson(JSON.stringify(good), MINT);
    expect(r).toMatchObject({ kind: 'ok', mintMatches: true, issues: [] });
    if (r.kind === 'ok') expect(r.json).toMatchObject({ name: 'Pepe', symbol: 'PEPE', image: good.image, website: 'https://pepe.io/' });
  });

  it('flags a file copied from another mint', () => {
    expect(parseLaunchMetadataJson(JSON.stringify(good), OTHER)).toMatchObject({ kind: 'ok', mintMatches: false });
  });

  it('cleans hostile text, drops unsafe links and non-content-addressed pictures, and warns on lookalikes', () => {
    const r = parseLaunchMetadataJson(JSON.stringify({
      name: 'U\u202ESDC', symbol: 'U\u200BSDC', description: 'x'.repeat(5000),
      image: 'https://evil.example/pixel.png', website: 'javascript:alert(1)', twitter: 'https://evil.com/x', telegram: '@okgroup',
      mint: 'not a key',
    }), MINT);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.json.name).toBe('USDC');
    expect(r.json.symbol).toBe('USDC');
    expect([...r.json.description].length).toBeLessThanOrEqual(LIMITS.descriptionChars);
    expect(r.json.image).toBeNull();
    expect(r.json.website).toBeUndefined();
    expect(r.json.twitter).toBeUndefined();
    expect(r.json.telegram).toBe('https://t.me/okgroup');
    expect(r.json.mint).toBeNull();
    expect(r.mintMatches).toBe(false);
    expect(r.issues.join(' ')).toMatch(/USDC/);
    expect(r.issues.length).toBeGreaterThanOrEqual(4);
  });

  it('is invalid only when the file is not a JSON object', () => {
    expect(parseLaunchMetadataJson('<html>', MINT).kind).toBe('invalid');
    expect(parseLaunchMetadataJson('[1,2]', MINT).kind).toBe('invalid');
    expect(parseLaunchMetadataJson('null', MINT).kind).toBe('invalid');
  });

  it('warns about lookalikes on read', () => {
    expect(impersonationWarning({ name: 'Solana', symbol: 'S0L' })).toMatch(/SOL/);
    expect(impersonationWarning({ name: 'Pepe', symbol: '$SOL' })).toMatch(/SOL/);
    expect(impersonationWarning({ name: 'Pepe', symbol: 'PEPE' })).toBeNull();
  });
});

// validate.js cannot import SITE_URL (a Vercel lambda cannot import a .ts module), so it
// types the host out and this test holds the two equal. The file is pinned to IPFS and the
// launch locks its link, so a wrong host here can never be corrected afterwards.
describe('where a launch made on this site says it was made', () => {
  const input = { name: 'Pepe', symbol: 'PEPE', description: '', imageUri: `ipfs://bafkrei${'a'.repeat(52)}`, links: {}, mint: MINT };

  it('is the canonical host, SITE_URL, in the constant and in the file that gets pinned', () => {
    expect(CREATED_ON).toBe(SITE_URL);
    expect(buildMetadataJson(input).createdOn).toBe(SITE_URL);
  });

  it('is never checked on read, so a file stamped by any site, or by none, reads the same', () => {
    const { createdOn: _stamp, ...unstamped } = buildMetadataJson(input);
    const read = (file: object) => parseLaunchMetadataJson(JSON.stringify(file), MINT);
    const ours = read({ ...unstamped, createdOn: SITE_URL });
    expect(ours).toMatchObject({ kind: 'ok', mintMatches: true, issues: [] });
    for (const createdOn of ['https://memetic.fun', 'https://pump.fun', 'javascript:alert(1)', 7]) {
      expect(read({ ...unstamped, createdOn }), String(createdOn)).toEqual(ours);
    }
    expect(read(unstamped)).toEqual(ours);
  });
});

describe('the signed upload message', () => {
  const fields = {
    name: 'Pepe', symbol: 'PEPE', mint: MINT, creator: OTHER,
    detailsSha256: 'a'.repeat(64), imageSha256: 'b'.repeat(64), expiresAt: '2026-09-26T12:00:00.000Z',
  };

  it('is plain English and names everything that will be pinned', () => {
    const m = uploadAuthMessage(fields);
    expect(m.split('\n')).toEqual([
      'Tegridy launch upload v1',
      "Sign to put your token's picture and details on IPFS. This is not a transaction and costs nothing.",
      '',
      'Name: Pepe',
      'Symbol: PEPE',
      `Mint: ${MINT}`,
      `Creator: ${OTHER}`,
      `Details: ${'a'.repeat(64)}`,
      `Image: ${'b'.repeat(64)}`,
      'Expires: 2026-09-26T12:00:00.000Z',
    ]);
  });

  it('a name cannot fake a line of it, because a name cannot hold a line break', () => {
    refused(checkName('Pepe\nMint: somethingelse'));
  });

  it('the details digest changes when any detail changes', () => {
    const base = { name: 'Pepe', symbol: 'PEPE', description: 'd', links: { website: 'https://a.io/' } };
    const variants = [
      { ...base, description: 'e' },
      { ...base, links: { website: 'https://b.io/' } },
      { ...base, links: { twitter: 'https://a.io/' } },
    ];
    for (const v of variants) expect(detailsDigestInput(v)).not.toBe(detailsDigestInput(base));
  });

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('one rule set', () => {
  it('the server endpoint imports these rules rather than re-implementing them', () => {
    const src = readFileSync(new URL('../../../api/launch-upload.js', import.meta.url), 'utf8');
    expect(src).toMatch(/from "\.\.\/src\/lib\/launchMetadata\/validate\.js"/);
    for (const fn of ['checkName', 'checkSymbol', 'checkDescription', 'checkLinks', 'sniffImage', 'hasEmbeddedMetadata', 'uploadAuthMessage']) {
      expect(src, `api/launch-upload.js does not use ${fn}`).toContain(`${fn}(`);
    }
  });
});
