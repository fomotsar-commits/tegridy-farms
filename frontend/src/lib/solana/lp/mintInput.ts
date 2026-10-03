import { PublicKey } from '@solana/web3.js';
import { looksLikePubkey } from '../../launcher/solana/curve/format';
import { WSOL_MINT } from './tokenSafety';

/** Parse what someone typed into a mint, or say why not. */
export function parseMintInput(raw: string): { ok: true; mint: string } | { ok: false; reason: string } {
  const s = raw.trim();
  if (!s) return { ok: false, reason: 'Paste a token’s mint address.' };
  if (!looksLikePubkey(s)) return { ok: false, reason: 'That does not look like a Solana address.' };
  try {
    const pk = new PublicKey(s);
    if (pk.toBase58() !== s) return { ok: false, reason: 'That does not look like a Solana address.' };
  } catch {
    return { ok: false, reason: 'That does not look like a Solana address.' };
  }
  if (s === WSOL_MINT) return { ok: false, reason: 'That is SOL itself. Pools here pair a token with SOL, USDC or BAYLA: paste the other token.' };
  return { ok: true, mint: s };
}

