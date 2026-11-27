import type { HyperEvmReader, ReadCall, ReadResult } from './pools';

/**
 * Reads that touch a contract anyone could have written (a coin someone opened a pool for), in
 * units: the calls for one coin, or for one pool. Units go out in batches; a batch that fails, or
 * holds a failed call, is asked again one unit at a time, so a coin whose calls revert or burn
 * all the gas can only spoil its own unit. A unit is null when its read throws even alone. At
 * most `MAX_ALONE` units are asked again, which bounds what many bad coins can cost a visitor.
 */
const BATCH_UNITS = 20;
const MAX_ALONE = 40;
const FAILED: ReadResult = { status: 'failure' };

export async function readUnits(reader: HyperEvmReader, units: readonly (readonly ReadCall[])[]): Promise<(ReadResult[] | null)[]> {
  const out: (ReadResult[] | null)[] = units.map(() => null);
  const retry: number[] = [];
  for (let at = 0; at < units.length; at += BATCH_UNITS) {
    const chunk = units.slice(at, at + BATCH_UNITS);
    let res: readonly ReadResult[] | null = null;
    try {
      res = await reader.multicall({ allowFailure: true, contracts: chunk.flat() });
    } catch {
      res = null;
    }
    let k = 0;
    chunk.forEach((u, j) => {
      const mine = res ? res.slice(k, k + u.length) : u.map(() => FAILED);
      k += u.length;
      out[at + j] = [...mine];
      if (mine.some((r) => r?.status !== 'success')) retry.push(at + j);
    });
  }
  for (const i of retry.slice(0, MAX_ALONE)) {
    try {
      out[i] = [...(await reader.multicall({ allowFailure: true, contracts: [...units[i]!] }))];
    } catch {
      out[i] = null;
    }
  }
  // Past MAX_ALONE, a unit keeps what its batch said: its failed calls stay failed.
  return out;
}
