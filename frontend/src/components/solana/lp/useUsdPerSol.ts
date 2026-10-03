import { useEffect, useState } from 'react';
import type { LpReaders } from './readers';

/**
 * Jupiter's SOL price in dollars, read once per mount and again on each reload. Null
 * until it is read, and whenever it could not be: every dollar line then stays away.
 * A re-read keeps the last price until the new one lands. A build whose readers carry
 * no price reader never shows a dollar line.
 */
export function useUsdPerSol(readers: LpReaders, reloadKey: number): number | null {
  const [usd, setUsd] = useState<number | null>(null);
  useEffect(() => {
    const read = readers.usdPerSol;
    if (!read) return;
    let live = true;
    read().then(
      (v) => {
        if (live) setUsd(v);
      },
      () => {
        if (live) setUsd(null);
      },
    );
    return () => {
      live = false;
    };
  }, [readers, reloadKey]);
  return usd;
}
