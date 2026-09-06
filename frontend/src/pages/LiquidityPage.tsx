import { usePageTitle } from '../hooks/usePageTitle';
import { usePoolTVL } from '../hooks/usePoolTVL';
import { LiquidityTab } from '../components/swap/LiquidityTab';
import { ILCalculator } from '../components/farm/ILCalculator';
import { LiquidityPrimer } from '../components/liquidity/LiquidityPrimer';
import { VenuePoolTable } from '../components/liquidity/VenuePoolTable';

/**
 * LiquidityPage — the venue's liquidity surface, as a page.
 *
 * ⚠️ WHAT THIS IS NOT. It is not a rewrite of the LP form. `LiquidityTab` is
 * unchanged and still owns every write: the same factory, the same router, the
 * same approve→add cascade, the same slippage presets, the same "your liquidity
 * is safe" panel that exists because "my LP disappeared" is the #1 support
 * question. Wrapping a working form in a better page is the whole change; a
 * rewrite would have put a live money path at risk to fix a findability bug.
 *
 * WHAT IT ADDS, and why each piece is here rather than somewhere else:
 *
 *  1. A POOL TABLE ABOVE THE FORM. The operator's complaint was that the venue
 *     "is not friendly for LPing" and needs to "attract new wallets that hold a
 *     lot of assets". A wallet like that does not arrive wanting a form — it
 *     arrives wanting to know what is here, how deep it is, and what it pays.
 *     Before this the only browsable pool list in the app was /terminal, which
 *     is a read-only discovery feed under Check with no LP action on it, and the
 *     venue's own pool card offered "View all pools →" that landed on this very
 *     form. You can now see the pools before you are asked to fund one.
 *
 *  2. A PRIMER, COLLAPSED BY DEFAULT. "Teaching people what they are, why they
 *     are needed" was the brief. It is `<details>`, shut, below the table:
 *     someone who already knows scrolls past it, and someone who does not is not
 *     made to read an essay before they can act.
 *
 *  3. THE IL CALCULATOR, PROMOTED. It already existed — buried inside the farm
 *     page, where someone deciding whether to provide liquidity was unlikely to
 *     meet it. Impermanent loss is the single thing a first-time LP does not
 *     know and most needs to; it belongs on the page where the decision is made.
 *
 * The numbers in the table are live chain reads with an explicit unreadable
 * state — see VenuePoolTable. A pool whose reserves did not answer says so; it
 * never renders as a zero, which is this repo's most-repeated bug class.
 */
export default function LiquidityPage() {
  usePageTitle(
    'Liquidity',
    'Provide liquidity on memetics.finance native pools and earn a share of every swap that routes through them.',
  );
  const poolData = usePoolTVL();

  return (
    <div className="mx-auto w-full max-w-[900px] px-4 py-8 sm:py-10">
      <header className="mb-6">
        <p className="text-[11px] uppercase tracking-wider label-pill mb-2" style={{ color: 'var(--color-stan)' }}>
          Native pools · Ethereum
        </p>
        <h1 className="heading-luxury text-3xl md:text-4xl text-white leading-tight mb-3">
          Liquidity
        </h1>
        {/* One sentence, and it is the mechanism rather than a pitch: what you
            put in, what you get back, and who pays you. */}
        <p className="text-white/75 text-[14px] md:text-[15px] leading-relaxed max-w-[62ch]">
          Pair two tokens into a pool and every swap that routes through it pays you a share of
          its fee, in proportion to how much of the pool is yours. Your position is an ERC-20
          token in your own wallet, redeemable for the underlying at any time. There is no lock
          and no counterparty.
        </p>
      </header>

      <VenuePoolTable poolData={poolData} />

      <LiquidityPrimer />

      {/* The form. `id` so the table's "Provide liquidity" buttons can jump to
          it without a route change — the pool is already the venue's only pair,
          so a navigation would land the visitor back on this same page. */}
      <section id="provide" className="mt-8 scroll-mt-24">
        <h2 className="text-white text-lg font-semibold mb-1">Add or remove liquidity</h2>
        <p className="text-white/60 text-[12.5px] mb-4">
          Both sides, priced off the pool&apos;s current reserves. You keep full control of the
          pair, the amounts and the slippage you will accept.
        </p>
        <LiquidityTab />
      </section>

      {/* PROMOTED FROM /farm, 2026-09-05. It is the same component; what changed
          is that it is now in front of the person making the decision it is
          about. The heading is a question rather than a label because that is
          the question a first-time LP actually has. */}
      <section className="mt-10">
        <h2 className="text-white text-lg font-semibold mb-1">What could go wrong?</h2>
        <p className="text-white/60 text-[12.5px] mb-2">
          Fees are not the only thing that moves your position. If the two tokens drift apart in
          price, the pool rebalances you into more of the one that fell — so an LP can end up
          worth less than simply holding both. That gap is called impermanent loss, it is real,
          and it is not a fee anyone charges you. Move the slider to size it.
        </p>
        <ILCalculator />
      </section>
    </div>
  );
}
