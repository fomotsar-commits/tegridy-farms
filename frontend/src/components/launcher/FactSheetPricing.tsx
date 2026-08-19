// The Fact Sheet's pricing block — what set the venue's line of this launch's fee
// constitution, rendered from the sheet and from nothing else.
//
// PROPS ARE THE SHEET'S OWN FIELD. This component never reads a flag, never reads the
// Heat oracle, and never resolves a price. A surface that re-derived the price could show
// today's dials over a launch that was priced months ago under different ones — and the
// locker's shares would be the older number. So the only thing rendered is the disclosure
// that was published with the launch.
//
// THE ABSENT CASE IS A STATEMENT, NOT A BLANK. `pricing === undefined` means the standard
// venue line with neither dial in force. Rendering nothing there would leave the reader
// unable to tell "priced at the standard rate" from "this surface has no idea", which is
// the same conflation the rest of this subsystem exists to refuse.
//
// TIER WORDS RENDER VERBATIM (gate spec §6.8) — never restyled, never translated into
// yield language, and never shown at all unless the island gave one.

import type { LaunchPricingDisclosure } from '../../lib/launcher/factSheet';

/** bps of the pool trade fee -> percent. Shares are of the FEE, never of trade volume. */
function pct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-white/10 last:border-b-0">
      <span className="text-[11px] uppercase tracking-wide text-white/40">{label}</span>
      <span className={`font-mono text-[13px] ${muted ? 'text-white/50' : 'text-white'}`}>{value}</span>
    </div>
  );
}

export default function FactSheetPricing({ pricing }: { pricing?: LaunchPricingDisclosure }) {
  if (!pricing) {
    return (
      <section aria-label="Launch pricing" className="text-[12px] text-white/60">
        <div className="text-[11px] uppercase tracking-wide text-white/40 mb-1">Venue share</div>
        <p>
          Priced at the venue&rsquo;s standard rate. Heat-tier launch pricing and the creator revenue share were not in
          force for this launch, so the fee constitution above is the whole of it.
        </p>
      </section>
    );
  }

  const {
    venueShareBps,
    standardVenueShareBps,
    tierDiscountBps,
    creatorRevenueShareBps,
    pricedAtTier,
    tierReadable,
    note,
  } = pricing;

  return (
    <section aria-label="Launch pricing" className="text-[12px] text-white/70">
      <div className="text-[11px] uppercase tracking-wide text-white/40 mb-1">Venue share</div>

      <Row label="Venue keeps" value={`${pct(venueShareBps)} of the pool trade fee`} />
      <Row label="Standard rate" value={pct(standardVenueShareBps)} muted />
      {tierDiscountBps > 0 && <Row label="Heat-tier discount" value={`${pct(tierDiscountBps)} to the creator`} />}
      {creatorRevenueShareBps > 0 && (
        <Row label="Creator revenue share" value={`${pct(creatorRevenueShareBps)} to the creator`} />
      )}

      {/*
        The instrument's own state, before any number that depends on it. `tierReadable
        === false` is the third state: tier pricing was in force and the island gave
        nothing to price on, so the standard rate above is a fallback rather than this
        wallet's price. No tier word appears on this branch, because there is none.
      */}
      {tierReadable === false ? (
        <p className="mt-2 text-amber-300/80">
          No fresh Heat reading was available for the launching wallet, so this launch was priced at the standard rate.
          No tier is claimed.
        </p>
      ) : pricedAtTier ? (
        <p className="mt-2">
          Priced at Heat tier <span className="text-white">{pricedAtTier}</span>, as read from the Jungle Bay Island
          oracle.
        </p>
      ) : null}

      <p className="mt-2 text-white/55">{note}</p>
    </section>
  );
}
