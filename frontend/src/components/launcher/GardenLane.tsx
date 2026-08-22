// THE GARDEN LANE — the flagship lane, shown as a promise, dark until the island's
// first certifications close. Wave 3, phase 06(a).
//
// `lib/heat/certification.ts` was written correctly and then had NO IMPORTER: no lane
// rendered it, so the promise was invisible and the module's tests guarded code nobody
// could reach. This is the surface that mounts it.
//
// ## The one rule this component exists to keep
//
// "THE VENUE NEVER SELF-DECLARES CERTIFICATION" — launch-gate spec §1. So this lane
// renders the island's answer and nothing else. There is no prop, no flag and no admin
// action that can turn it green; the only path to `certified` is the island publishing
// an endpoint that says so. Every other state — no endpoint, an unreadable one, a
// malformed body — renders dark, and says WHY, which is the difference between a lane
// that is honest and a lane that is merely quiet.
//
// It is deliberately NOT a selectable tier. Presenting it beside the live lanes as
// something a creator could pick would be the self-declaration the spec forbids,
// dressed as UI.

import { useEffect, useState } from 'react';
import { isCertified, isCertifiedState, type CertificationState } from '../../lib/heat/certification';

export interface GardenLaneProps {
  /** The community this lane would certify. */
  community: string;
}

export function GardenLane({ community }: GardenLaneProps) {
  const [state, setState] = useState<CertificationState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    // Fail-closed by construction: `isCertified` never throws and never returns a bare
    // boolean, so there is no branch here that can default to "certified".
    void isCertified(community, { signal: ac.signal }).then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [community]);

  const open = state ? isCertifiedState(state) : false;

  return (
    <div
      className={`rounded-xl p-4 border ${open ? 'border-emerald-500/70 bg-emerald-500/10' : 'border-white/12'}`}
      // Not a button. The lane is not selectable while dark, and making it look
      // clickable would imply the venue can grant what only the island can.
      aria-label="Garden lane — certified soil"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-white font-semibold text-sm">Garden — certified soil</span>
        <span
          className={`text-[10px] uppercase tracking-[0.14em] px-2 py-0.5 rounded-full ${
            open ? 'text-emerald-200 bg-emerald-500/20' : 'text-white/45 bg-white/5'
          }`}
        >
          {open ? 'Open' : 'Dark'}
        </span>
      </div>

      <p className="text-white/60 text-xs mt-1.5 leading-relaxed">
        The island&rsquo;s own lane. A certified community launches on certified soil, under the
        island&rsquo;s covenant rather than this venue&rsquo;s split.
      </p>

      {/* The reason, verbatim from the module. A dark lane that does not say why reads
          as broken; one that says why reads as waiting. */}
      <p className="text-white/40 text-[11px] mt-2 leading-relaxed">
        {state?.detail ?? 'Reading the island’s certification state…'}
      </p>

      <p className="text-white/30 text-[10.5px] mt-2 leading-relaxed">
        This venue cannot certify anyone. Certification is a fact the island publishes, or it is
        not a fact at all.
      </p>
    </div>
  );
}
