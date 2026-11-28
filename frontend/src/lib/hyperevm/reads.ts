import type { HyperEvmReader, ReadCall, ReadResult } from './pools';

/**
 * Reads that touch a contract anyone could have written (a coin someone opened a pool for), in
 * units: the calls for one coin, or for one pool. Units go out in batches. A batch that throws is
 * split in half and each half asked again, down to one unit. Of a batch that answers, the units
 * holding a failed call are asked again together (split in half when none of the batch came back
 * whole), since a call that burns all the gas fails the calls after it. So a coin whose calls
 * revert or burn all the gas can only spoil its own unit, and the healthy units beside it are
 * read. A unit read alone keeps its own answer, failed calls included.
 *
 * A unit is null when it could not be read: it threw even alone, or the asking-again budget ran
 * out first. At most `MAX_RETRIES` reads are spent asking again, which bounds what many bad coins
 * can cost a visitor. Each batch is taken apart to the end before the next, so the budget reads
 * whole batches rather than a little of each; every batch still gets its first read.
 */
const BATCH_UNITS = 20;
export const MAX_RETRIES = 40;

export async function readUnits(reader: HyperEvmReader, units: readonly (readonly ReadCall[])[]): Promise<(ReadResult[] | null)[]> {
  const out: (ReadResult[] | null)[] = units.map(() => null);
  const halves = (r: number[]): number[][] => {
    const mid = Math.ceil(r.length / 2);
    return [r.slice(0, mid), r.slice(mid)];
  };
  let retries = 0;
  for (let at = 0; at < units.length; at += BATCH_UNITS) {
    // Last in, first out: the first half of a split is asked before the second.
    const stack: number[][] = [Array.from({ length: Math.min(BATCH_UNITS, units.length - at) }, (_, j) => at + j)];
    let first = true;
    while (stack.length > 0) {
      const range = stack.pop()!;
      if (!first) {
        if (retries >= MAX_RETRIES) {
          for (const i of range) out[i] = null; // out of budget: unread, never its batch's failure
          continue;
        }
        retries += 1;
      }
      first = false;
      let res: readonly ReadResult[] | null;
      try {
        res = await reader.multicall({ allowFailure: true, contracts: range.flatMap((i) => [...units[i]!]) });
      } catch {
        res = null;
      }
      if (res === null) {
        for (const i of range) out[i] = null;
        if (range.length > 1) stack.push(...halves(range).reverse());
        continue;
      }
      const bad: number[] = [];
      let k = 0;
      for (const i of range) {
        const n = units[i]!.length;
        const mine = res.slice(k, k + n);
        k += n;
        out[i] = mine.length === n ? [...mine] : null;
        if (mine.length !== n || mine.some((r) => r?.status !== 'success')) bad.push(i);
      }
      if (range.length > 1 && bad.length > 0) stack.push(...(bad.length < range.length ? [bad] : halves(range).reverse()));
    }
  }
  return out;
}
