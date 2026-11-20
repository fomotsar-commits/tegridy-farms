/**
 * Amounts on the HyperEVM screens: always cut down, never rounded up, so a line never says the
 * wallet gets more than it will. `digits` is how many significant digits a small amount keeps.
 */
export function amountText(raw: bigint, decimals: number, digits = 6): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0');
  let shown: string;
  if (whole > 0n) {
    const wholeDigits = whole.toString().length;
    const keep = Math.max(0, Math.min(decimals, digits - wholeDigits, 4));
    const f = frac.slice(0, keep).replace(/0+$/, '');
    shown = `${whole.toLocaleString('en-US')}${f ? `.${f}` : ''}`;
  } else {
    const lead = frac.search(/[1-9]/);
    if (lead < 0) return '0';
    const f = frac.slice(0, lead + digits).replace(/0+$/, '');
    shown = `0.${f}`;
  }
  return neg ? `-${shown}` : shown;
}

/** A typed amount in the coin's smallest unit, or null when it is not a plain positive number. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(',', '.');
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  const raw = BigInt(`${m[1] || '0'}${frac.padEnd(decimals, '0')}`);
  return raw > 0n ? raw : null;
}

/** Basis points as a percent: 50 is 0.5%. */
export function bpsText(bps: number | bigint): string {
  return `${(Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}
