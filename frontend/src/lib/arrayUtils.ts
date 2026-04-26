/**
 * Split an array into fixed-size chunks. Used to keep RPC multicall batches
 * under provider request-size limits (Alchemy / Infura cap ~100 reads/call).
 *
 * Negative or zero `size` returns the input wrapped in a single chunk so
 * callers get a sane fallback rather than an empty result.
 */
export function chunkArray<T>(arr: readonly T[], size: number): T[][] {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}
