// Amounts on the Cardano page: exact integers on the chain, decimals only on screen.

export const LOVELACE_DECIMALS = 6;

/** "12.5" with `decimals` → 12500000n; null for anything that is not a plain non-negative amount. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d*(?:\.\d*)?$/.test(t) || t === '' || t === '.') return null;
  const [whole = '', frac = ''] = t.split('.');
  if (frac.length > decimals) return null;
  return BigInt((whole || '0') + frac.padEnd(decimals, '0'));
}

/** 12500000n with 6 decimals → "12.5". Never rounds: every digit the chain holds is shown. */
export function formatAmount(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  if (decimals === 0) return `${neg ? '-' : ''}${abs.toString()}`;
  const s = abs.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function formatAda(lovelace: bigint): string {
  return `${formatAmount(lovelace, LOVELACE_DECIMALS)} ADA`;
}

export function cardanoscanTx(txHash: string): string {
  return `https://cardanoscan.io/transaction/${txHash}`;
}

/**
 * A coin's Cardanoscan page. A policy id is 56 hex digits and an asset name up to 32 bytes of hex, so only hex
 * ever reaches the link; anything else (text a visitor typed that was never a coin) gets Cardanoscan's front page.
 */
export function cardanoscanToken(policyId: string, assetName: string): string {
  if (!/^[0-9a-f]{56}$/i.test(policyId) || !/^(?:[0-9a-f]{2}){0,32}$/i.test(assetName)) return 'https://cardanoscan.io/';
  return `https://cardanoscan.io/token/${encodeURIComponent(policyId + assetName)}`;
}
