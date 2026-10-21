// Every address the harness uses, read from the repo: the address registry
// (frontend/scripts/addresses.json), the key guard's allow-list, the deny list of Raydium's
// keys, and the frontend's Squads constant. None is typed here.
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, PublicKey, spl } from './deps.mjs';
export { REPO };

const json = (p) => JSON.parse(readFileSync(join(REPO, p), 'utf-8'));

export const WORK = process.env.CLMM_WORK || join(REPO, 'solana', 'clmm-localnet', '.work');
mkdirSync(WORK, { recursive: true });
export const RPC = process.env.CLMM_RPC || `http://127.0.0.1:${process.env.CLMM_PORT || 18899}`;
export const MAINNET_RPC = process.env.MAINNET_RPC || 'https://api.mainnet-beta.solana.com';
export const PROGRAM_SRC = join(REPO, 'solana', 'tegridy-clmm', 'programs', 'amm', 'src');

/** The local stand-in for mainnet's 172,800 s lock, in seconds. */
export const LOCAL_TIME_LOCK = Number(process.env.CLMM_TIME_LOCK ?? 10);
export const MAINNET_TIME_LOCK = 172_800;

export function registry(id) {
  const row = json('frontend/scripts/addresses.json').solana.find((r) => r.id === id);
  if (!row?.address) throw new Error(`addresses.json has no solana row ${id}`);
  return new PublicKey(row.address);
}

const allowed = json('solana/guards/allowed-keys.json');
const allowedKey = (section, about) => {
  const hit = Object.entries(allowed[section]).filter(([, v]) => (typeof v === 'string' ? v : v.why).includes(about));
  if (hit.length !== 1) throw new Error(`allowed-keys.json ${section}: ${hit.length} entries match "${about}"`);
  return new PublicKey(hit[0][0]);
};

const squadsSrc = readFileSync(join(REPO, 'frontend/src/lib/launcher/solana/squads.ts'), 'utf-8');

export const ADDR = {
  multisig: registry('squads-multisig'),
  vault: registry('squads-vault'),
  bayla: registry('bayla-mint'),
  venuePoolBaylaSol: registry('venue-pool-bayla-sol'),
  wsol: allowedKey('system', 'Wrapped SOL mint'),
  metaplex: allowedKey('system', 'Metaplex Token Metadata program'),
  // The id the program's own source declares for a build with no features.
  program: new PublicKey(/#\[cfg\(not\(feature = "devnet"\)\)\]\r?\ndeclare_id!\("(\w+)"\);/.exec(readFileSync(join(PROGRAM_SRC, 'lib.rs'), 'utf-8'))[1]),
  squads: new PublicKey(/SQUADS_V4_PROGRAM_ID = '(\w+)'/.exec(squadsSrc)[1]),
  token: spl.TOKEN_PROGRAM_ID,
  token2022: spl.TOKEN_2022_PROGRAM_ID,
  ata: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
};
if (!ADDR.wsol.equals(spl.NATIVE_MINT)) throw new Error('the allow-list WSOL mint is not spl-token NATIVE_MINT');

/** The 39 keys Raydium's two pinned repositories hard-code (solana/guards/upstream/deny-keys.txt). */
export const DENY = readFileSync(join(REPO, 'solana/guards/upstream/deny-keys.txt'), 'utf-8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
