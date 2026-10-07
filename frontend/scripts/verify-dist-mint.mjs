// Last step of `build`: does dist/ hold every token file scripts/lib/mint-identity.mjs
// names, and the picture each one points at? A file missing from a deploy is not a 404
// on this host. /mint/<mint>.json would answer the default file, and a picture path would
// answer JSON, both with status 200, to a wallet that keeps what it fetched.
// The same question as verify-dist-derivatives.mjs, asked of the thing about to ship.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_FILE, DEFAULT_TOKEN, MINT_IMG_PATH, MINT_PATH, MINT_TOKENS, SITE,
  metadataFileNames, pictureFile,
} from './lib/mint-identity.mjs';

const DIST = 'dist';
const MINT_DIR = join(DIST, MINT_PATH.slice(1));
const IMG_DIR = join(DIST, MINT_IMG_PATH.slice(1));
const PNG_SIGNATURE = '89504e470d0a1a0a';

const problems = [];
/** A folder's own files by the names the disk holds: exact case, as production serves them. */
const filesIn = (dir) => {
  try {
    return readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile());
  } catch {
    problems.push(`${dir}/ is missing`);
    return [];
  }
};

const shipped = filesIn(MINT_DIR);
const pictures = filesIn(IMG_DIR);
const wanted = metadataFileNames();
for (const name of wanted) if (!shipped.includes(name)) problems.push(`${join(MINT_DIR, name)} is missing`);
for (const name of shipped) if (!wanted.includes(name)) problems.push(`${join(MINT_DIR, name)} is in no row of the list`);

const rows = [...MINT_TOKENS.map((t) => [`${t.mint}.json`, t]), [DEFAULT_FILE, DEFAULT_TOKEN]];
const named = [];
for (const [file, token] of rows) {
  if (!shipped.includes(file)) continue;
  let json;
  try {
    json = JSON.parse(readFileSync(join(MINT_DIR, file), 'utf8'));
  } catch {
    problems.push(`${join(MINT_DIR, file)} is not JSON`);
    continue;
  }
  if (json.name !== token.name || json.symbol !== token.symbol) {
    problems.push(`${join(MINT_DIR, file)} says ${JSON.stringify(json.name)} / ${JSON.stringify(json.symbol)}, the list says ${JSON.stringify(token.name)} / ${JSON.stringify(token.symbol)}`);
  }
  const prefix = `${SITE}${MINT_IMG_PATH}/`;
  if (typeof json.image !== 'string' || !json.image.startsWith(prefix)) {
    problems.push(`${join(MINT_DIR, file)} points its picture outside ${prefix}`);
    continue;
  }
  const picture = json.image.slice(prefix.length);
  named.push(picture);
  if (!pictures.includes(picture)) {
    problems.push(`${join(IMG_DIR, picture)} is missing, and ${file} points at it`);
    continue;
  }
  const bytes = readFileSync(join(IMG_DIR, picture));
  if (bytes.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) problems.push(`${join(IMG_DIR, picture)} is not a PNG`);
  if (picture !== pictureFile(token.picture, createHash('sha256').update(bytes).digest('hex'))) {
    problems.push(`${join(IMG_DIR, picture)} does not carry the hash of its own bytes in its name`);
  }
}
for (const name of pictures) if (!named.includes(name)) problems.push(`${join(IMG_DIR, name)} is named by no metadata file`);

if (problems.length > 0) {
  console.error(`✖ dist token files: ${problems.length} problem(s) in ${MINT_DIR}/. A wallet would be served the wrong thing:`);
  for (const p of problems) console.error(`    ${p}`);
  process.exit(1);
}
console.log(`✔ dist token files: all ${wanted.length} metadata files and ${named.length} pictures present in ${MINT_DIR}/`);
