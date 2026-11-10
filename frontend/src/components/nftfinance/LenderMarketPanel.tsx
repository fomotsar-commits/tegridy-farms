// The Lend tab's pitch and the lender's risk, in one card (owner 2026-11-09, ideas 1 and 4).
//
// Idea 1: a whole-collection offer is a floor bid that earns while it waits. Repaid, the
// lender keeps the interest; not repaid, they get the NFT for what they lent.
// Idea 4: so the lender's real question is "if I end up with the NFT, who buys it?". The
// card puts the floor and the open bids next to the amount, and once an amount is typed says
// whether a buyer already bids that much.
//
// The numbers are OpenSea's, read through our proxy (lib/gondi/lenderPitch.ts). Blur's bids
// are not in them, so the card can only under-count buyers. A read that failed shows "–",
// never "None": no buyers and no answer are different things.
//
// WORDS: /nft-finance has a visible-word ceiling (e2e/word-budget.spec.ts). The card's title
// is the pitch, the tiles are bare numbers, and every explanation sits in "Why".
import { formatEther } from 'viem';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';
import { exitCheck, underFloorPct, useLendingMarket } from '../../lib/gondi/lenderPitch';
import { CARD_BG, CARD_BORDER, LABEL_STYLE, LENDING_LIVE } from './nftLendingShared';

const eth = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

export function LenderMarketPanel({ collection, principalWei }: { collection: string; principalWei: bigint | null }) {
  const market = useLendingMarket(collection, LENDING_LIVE);
  const m = market.data;
  const bids = m?.bids ?? null;
  const principal = principalWei !== null && principalWei > 0n ? Number(formatEther(principalWei)) : null;
  const check = principal !== null ? exitCheck(principal, bids) : null;
  const under = principal !== null ? underFloorPct(principal, m?.floor ?? null) : null;

  const tiles = [
    { label: 'Floor', value: m?.floor != null ? `${eth(m.floor)} ETH` : '–' },
    { label: 'Best bid', value: !bids ? '–' : bids.bestBid === null ? 'None' : `${eth(bids.bestBid)} WETH` },
    { label: 'Near floor', value: bids?.nearFloor != null ? String(bids.nearFloor) : '–' },
    { label: 'Sales, 30d', value: m?.sales30d != null ? String(m.sales30d) : '–' },
  ];

  return (
    <div className="relative isolate rounded-xl p-3 md:p-4 space-y-2" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }} data-testid="lender-market">
      <CardArt pageId="nft-finance" idx={27} />
      <p className="text-white text-[13px] font-semibold" style={LABEL_STYLE}>
        A floor bid that earns while it waits.
      </p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg px-3 py-2" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <p className="text-white/80 text-[11px] uppercase tracking-wider" style={LABEL_STYLE}>
              {t.label}
            </p>
            <p className="text-white text-[15px] font-semibold font-mono" style={LABEL_STYLE}>
              {market.isLoading ? '…' : t.value}
            </p>
          </div>
        ))}
      </div>
      {check && principal !== null && (
        <p
          className={`text-[12px] ${check.kind === 'covered' ? 'text-emerald-300' : 'text-amber-300'}`}
          style={LABEL_STYLE}
          data-testid="lender-exit-check"
        >
          {check.kind === 'covered'
            ? `A buyer already bids ${eth(check.bestBid)} WETH, at or above your ${eth(principal)}.`
            : check.kind === 'short'
            ? `Your ${eth(principal)} WETH is ${eth(check.gap)} over the best bid: unrepaid, selling today loses that.`
            : 'No open bids right now: unrepaid, you may have to hold the NFT or list it.'}
          {under !== null && under > 0 ? ` ${under}% under the floor.` : under !== null && under < 0 ? ` ${-under}% over the floor.` : ''}
        </p>
      )}
      <FinePrint summary="Why" testId="lender-market-why">
        <p>
          Repaid, you keep the interest. Not repaid, you get the NFT for what you lent, so lend what you would pay for one.
          Borrowers usually lock their cheapest NFT.
        </p>
        <p className="mt-1">
          Floor: the cheapest OpenSea listing. Best bid: the highest open OpenSea bid for any NFT in the collection, what you
          could sell for today. Near floor: how many NFTs open bids would buy within 10% of the floor. Sales, 30d: sales in
          the last 30 days.
        </p>
        <p className="mt-1">
          Read from OpenSea through this site, each minute. Blur&apos;s bids are not counted, so there may be more buyers than
          shown, and a bid can be pulled at any time.
        </p>
      </FinePrint>
    </div>
  );
}
