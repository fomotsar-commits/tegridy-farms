import { useEffect, useRef, useState } from 'react';
import type { OtherLeg } from '../../../lib/solana/lp/arbCheck';
import type { LegQuote } from '../../../lib/solana/lp/outsidePrice';
import type { Opportunity } from '../../../lib/solana/lp/poolList';
import type { LpReaders } from './readers';

/** An answer stands this long: under the list's 30 s re-read, so each read asks again, and the edge answers a repeat. */
export const CHECK_FOR_MS = 20_000;

export interface WantedCheck {
  pool: string;
  key: string;
  leg: OtherLeg;
  o: Opportunity;
}

/** A pool's last answer, with the trade it answered: it stands while that pool's next leg is asked. */
export interface CheckAnswer {
  key: string;
  leg: OtherLeg;
  o: Opportunity;
  read: LegQuote;
}

/**
 * Jupiter's quote for each wanted leg, by pool, asked one after another, never together. A
 * quote that is not read ends the pass: the legs after it are said as not read, not asked,
 * and are asked again on a later read. Nothing is asked without `legQuote`.
 */
export function useArbChecks(legQuote: LpReaders['legQuote'], wanted: readonly WantedCheck[]): ReadonlyMap<string, CheckAnswer> {
  const [answers, setAnswers] = useState<ReadonlyMap<string, CheckAnswer>>(() => new Map());
  const askedAt = useRef(new Map<string, number>());
  // The key each pool's standing answer is for, so a pool back on an old key is asked again.
  const answeredKey = useRef(new Map<string, string>());
  useEffect(() => {
    if (!legQuote || wanted.length === 0) return;
    let live = true;
    const pools = new Set(wanted.map((w) => w.pool));
    const keys = new Set(wanted.map((w) => w.key));
    for (const k of [...askedAt.current.keys()]) if (!keys.has(k)) askedAt.current.delete(k);
    void (async () => {
      let failed: string | null = null;
      for (const w of wanted) {
        const at = askedAt.current.get(w.key);
        if (at !== undefined && Date.now() - at < CHECK_FOR_MS && answeredKey.current.get(w.pool) === w.key) continue;
        const read: LegQuote =
          failed !== null
            ? { kind: 'unread', detail: failed }
            : await legQuote(w.leg.inputMint, w.leg.outputMint, w.leg.amount).catch((e: unknown) => ({ kind: 'unread' as const, detail: e instanceof Error ? e.message : String(e) }));
        if (!live) return;
        if (read.kind === 'unread') failed = read.detail;
        askedAt.current.set(w.key, Date.now());
        answeredKey.current.set(w.pool, w.key);
        const answer: CheckAnswer = { key: w.key, leg: w.leg, o: w.o, read };
        setAnswers((prev) => new Map([...[...prev].filter(([p]) => pools.has(p)), [w.pool, answer]]));
      }
    })();
    return () => {
      live = false;
    };
  }, [legQuote, wanted]);
  return answers;
}
