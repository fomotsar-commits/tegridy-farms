import { useEffect, useRef, useState } from 'react';
import type { OtherLeg } from '../../../lib/solana/lp/arbCheck';
import type { LegQuote } from '../../../lib/solana/lp/outsidePrice';
import type { LpReaders } from './readers';

/** An answer stands this long: under the list's 30 s re-read, so each read asks again, and the edge answers a repeat. */
export const CHECK_FOR_MS = 20_000;

export interface WantedCheck {
  key: string;
  leg: OtherLeg;
}

/**
 * Jupiter's quote for each wanted leg, by key, asked one after another, never together. A
 * quote that is not read ends the pass: the legs after it are said as not read, not asked,
 * and are asked again on a later read. Nothing is asked without `legQuote`.
 */
export function useArbChecks(legQuote: LpReaders['legQuote'], wanted: readonly WantedCheck[]): ReadonlyMap<string, LegQuote> {
  const [answers, setAnswers] = useState<ReadonlyMap<string, LegQuote>>(() => new Map());
  const askedAt = useRef(new Map<string, number>());
  useEffect(() => {
    if (!legQuote || wanted.length === 0) return;
    let live = true;
    const keep = new Set(wanted.map((w) => w.key));
    for (const k of [...askedAt.current.keys()]) if (!keep.has(k)) askedAt.current.delete(k);
    void (async () => {
      let failed: string | null = null;
      for (const w of wanted) {
        const at = askedAt.current.get(w.key);
        if (at !== undefined && Date.now() - at < CHECK_FOR_MS) continue;
        const read: LegQuote =
          failed !== null
            ? { kind: 'unread', detail: failed }
            : await legQuote(w.leg.inputMint, w.leg.outputMint, w.leg.amount).catch((e: unknown) => ({ kind: 'unread' as const, detail: e instanceof Error ? e.message : String(e) }));
        if (!live) return;
        if (read.kind === 'unread') failed = read.detail;
        askedAt.current.set(w.key, Date.now());
        setAnswers((prev) => new Map([...[...prev].filter(([k]) => keep.has(k)), [w.key, read]]));
      }
    })();
    return () => {
      live = false;
    };
  }, [legQuote, wanted]);
  return answers;
}
