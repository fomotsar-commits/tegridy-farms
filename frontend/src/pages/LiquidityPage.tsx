import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { usePoolTVL } from '../hooks/usePoolTVL';
import { LiquidityTab, type LiquidityPick } from '../components/swap/LiquidityTab';
import { useLiquidityChainId } from '../hooks/useLiquidityChainId';
import { CHAIN_ID } from '../lib/constants';
import { getChainConfig } from '../lib/chains/registry';
import { liquidityVenueOn } from '../lib/chains/liquidityVenue';
import { ILCalculator } from '../components/farm/ILCalculator';
import { LiquidityPrimer } from '../components/liquidity/LiquidityPrimer';
import { VenuePoolTable } from '../components/liquidity/VenuePoolTable';
import { ChainPoolTable } from '../components/liquidity/ChainPoolTable';
import { FinePrint } from '../components/ui/FinePrint';
import { lpWriteMode, type LpWriteMode } from '../lib/launcher/solana/lpWriteFlag';

/** What the Solana LP tab can do follows LP's own switch, so the pointer never promises more. */
const SOLANA_POINTER: Record<LpWriteMode, string> = {
  on: 'On Solana? Create, add or remove on the Solana LP tab',
  'withdraw-only': 'On Solana? Take liquidity out on the Solana LP tab',
  off: 'On Solana? Find a pool on the Solana LP tab',
};

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
  // The network drop-down's pick (`?c=`) while no wallet is connected; the wallet's chain once one is.
  const liquidityChainId = useLiquidityChainId();
  // The header speaks for a chain we run a venue on. A wallet on any other chain keeps
  // Ethereum's header and table, as before; the form below refuses that chain itself.
  const headerChainId = liquidityVenueOn(liquidityChainId) ? liquidityChainId : CHAIN_ID;
  const onMainnet = headerChainId === CHAIN_ID;
  const chainName = getChainConfig(headerChainId)?.name ?? 'Ethereum';
  // A pool picked from the list, and a count that remounts the form on every pick.
  const [pick, setPick] = useState<{ pool: LiquidityPick; n: number } | null>(null);
  const onPick = (pool: LiquidityPick) => setPick((prev) => ({ pool, n: (prev?.n ?? 0) + 1 }));

  return (
    <>
    <PageArtBackdrop pageId="liquidity" />
    {/* `relative` with no z-index on purpose: it paints above the backdrop by
        coming after it, without becoming a stacking context. A z-10 here would
        trap LiquidityTab's token picker (z-[100]) under the tab strip (z-30). */}
    <div className="relative mx-auto w-full max-w-[900px] px-4 py-8 sm:py-10">
      <header className="mb-6">
        {/* One heading, no eyebrow over it (owner, 2026-10-14): the chain is in the line under it. */}
        <h1 className="heading-luxury text-3xl md:text-4xl text-white leading-tight mb-3">
          Liquidity
        </h1>
        {/* "Pools" opens here, on the Ethereum form, under a tab named Add / Remove. A visitor
            with a Solana token stopped on this screen (owner on a phone, 2026-10-03). */}
        <p className="mb-3 text-[14px]" data-testid="solana-lp-pointer">
          <Link to="/solana-lp" className="inline-block py-2 underline underline-offset-2 text-white hover:text-white/80">
            {SOLANA_POINTER[lpWriteMode()]}
          </Link>
        </p>
        {/* One line: how a provider earns and what the venue takes, as numbers, on the chain
            the form is on. The venue's one-sixth cut is a switch PER POOL: a pair mints it only
            once `kLast` is set, and only the factory's feeToSetter can set it the first time
            (TegridyPair.harvest, HARVEST_BOOTSTRAP_GATED). So its state carries the date it was
            read, and the fine print says a new pool starts with it off. */}
        {onMainnet ? (
          /* Ethereum: factory 0xa24C…7a52 has one pair, TOWELI/WETH 0x5587…a481. The owner
             switched its cut on 2026-10-16 04:48Z (kLast set, tx 0x1fa58e91…); feeTo = the
             TREASURY Safe 0x7D26…Bd7d. Read 2026-10-17: kLast != 0, feeTo unchanged. */
          <p className="text-white/75 text-[14px] md:text-[15px] leading-relaxed max-w-[62ch]">
            Ethereum pools. Swap fee 0.3%. On TOWELI/ETH: 0.25% to providers, 0.05% to the
            venue&apos;s treasury (read 17 October 2026). Swaps made through this site pay the venue a
            separate fee.
          </p>
        ) : (
          /* Base and Robinhood Chain: the same factory code, and each factory's feeTo is the
             venue's FEE_REMITTANCE Safe 0xfc5D…fbf1. Neither has a pair yet (read 2026-10-17),
             and a new pair starts with kLast = 0, so its cut stays off until the feeToSetter
             (Base: the venue's L2 multisig 0xBC4E…Be5B; Robinhood: the owner wallet) switches
             it on. Our swap does not route on either chain, so the line claims no swap fee. */
          <p className="text-white/75 text-[14px] md:text-[15px] leading-relaxed max-w-[62ch]">
            {chainName} pools. Swap fee 0.3%, all to providers until the venue switches on its
            one-sixth cut for that pool, which goes to the venue&apos;s fee Safe (read 17 October 2026).
          </p>
        )}
        <FinePrint summary="How it works">
          {onMainnet ? (
            <p>
              Providers split the swap fee by pool share. On TOWELI/ETH the venue&apos;s one-sixth cut
              is on (since 16 October 2026): it is paid to the venue&apos;s treasury as new pool shares,
              so providers keep about 0.25% of each trade. The venue switches the cut on pool by
              pool, so a new pool keeps the whole 0.3% until it does. The venue also earns its own
              fee on swaps routed here.
            </p>
          ) : (
            <p>
              Providers split the 0.3% swap fee by pool share. The venue can take one sixth of it,
              paid to its fee Safe as new pool shares, but only on a pool where it has switched that
              on. Each pool in the list says whether it has.
            </p>
          )}
          <p>
            Pair two tokens into a pool and every swap that routes through it pays you a share of
            its fee, in proportion to how much of the pool is yours. Your position is an ERC-20
            token in your own wallet, redeemable for the underlying at any time. There is no lock
            and no counterparty.
          </p>
        </FinePrint>
      </header>

      {/* Ethereum's one pool, or the pools in this chain's own factory, read live. */}
      {onMainnet
        ? <VenuePoolTable poolData={poolData} />
        : <ChainPoolTable chainId={headerChainId} onPick={onPick} />}

      {/* The form. `id` so a table's buttons jump to it without a route change; a pick
          from the chain's list opens it on that pair, and only on the chain it was read on. */}
      <section id="provide" className="mt-8 scroll-mt-5">
        <h2 className="text-white text-lg font-semibold mb-1">Add or remove liquidity</h2>
        <FinePrint summary="Details" className="mb-2">
          <p>Both sides, priced off the pool&apos;s current reserves.</p>
        </FinePrint>
        <LiquidityTab key={`${liquidityChainId}:${pick?.n ?? 0}`} chainId={liquidityChainId} pick={pick?.pool} />
      </section>

      {/* The four answers for a first-timer, after the form (owner, 2026-10-14: the actions first). */}
      <LiquidityPrimer />

      {/* PROMOTED FROM /farm, 2026-09-05. It is the same component; what changed
          is that it is now in front of the person making the decision it is
          about. The heading is a question rather than a label because that is
          the question a first-time LP actually has. */}
      <section className="mt-10">
        <h2 className="text-white text-lg font-semibold mb-1">What could go wrong?</h2>
        <p className="text-white/60 text-[12.5px] mb-2">
          You can end up worth less than simply holding both tokens.
        </p>
        <ILCalculator />
        <FinePrint summary="Impermanent loss" className="mt-2">
          <p>
            Fees are not the only thing that moves your position. If the two tokens drift apart in
            price, the pool rebalances you into more of the one that fell — so an LP can end up
            worth less than simply holding both. That gap is called impermanent loss, it is real,
            and it is not a fee anyone charges you. Move the slider to size it.
          </p>
        </FinePrint>
      </section>
    </div>
    </>
  );
}
