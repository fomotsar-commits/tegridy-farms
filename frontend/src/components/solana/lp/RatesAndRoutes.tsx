import { Link } from 'react-router-dom';
import { PUBLIC_TIER_INDICES, isPublicTierIndex, type AmmConfigView } from '../../../lib/solana/cpswap/program';
import { CREATOR_FEE_SWITCH, chargedCreatorFeeRate, feeSplit, solOf, tradeCost } from '../../../lib/solana/cpswap/venue';
import { feeRateText, pctText, solText, tradeCostText } from '../../../lib/solana/lp/format';
import { SOLANA_FEE_ACCOUNT, SOLANA_PLATFORM_FEE_BPS, isSolanaFeeConfigured } from '../../../lib/solana';
import { howVenueEarns, howYouEarn, poolWords, type JupiterFee } from '../../../lib/solana/lp/earnCopy';
import type { FeeTierRead } from '../../../lib/solana/lp/poolFinder';
import { Card, Notice, Row } from '../curve/ui';
import { CardArt } from '../../ui/CardArt';
import { FinePrint } from '../../ui/FinePrint';
import { AddressRow } from './AddressRow';
import { explorerOf } from './panelKit';
import { useLpWrites } from './useLpWrites';

/** The swap's own fee as jupiter.ts takes it: only with a wallet to pay and a rate above zero. */
const BUILD_JUPITER_FEE: JupiterFee | null =
  isSolanaFeeConfigured() && SOLANA_PLATFORM_FEE_BPS > 0 ? { bps: SOLANA_PLATFORM_FEE_BPS, wallet: SOLANA_FEE_ACCOUNT } : null;

/**
 * Rates: what a trade pays in each kind of pool, what stays in the pool for the people in
 * it, and what the venue takes. ONE card for both Pools tabs (owner, 2026-10-14: "drop the
 * duplicate fee cards ... the rates and routes getting the attention, not the word
 * jargon"). It replaces four: How you earn, How the venue earns, Fee tiers, and /pools'
 * fee sheet, which all printed the same split from the same chain read. Every sentence
 * they carried is in its Details, word for word.
 *
 * Every number is a tier as the section's one read returned it; with no read, none.
 *
 * The public tiers come first, in the order the form offers them, then the launch tier.
 * A public tier past the first that is not on chain is not listed (law 23: off is not
 * listed); the first public tier and the launch tier are, as "not created yet", because
 * either missing is a state worth a row.
 */
export function Rates({ read, jupiterFee = BUILD_JUPITER_FEE }: { read: FeeTierRead | null; jupiterFee?: JupiterFee | null }) {
  const rows = read?.kind === 'ok' ? read.tiers : [];
  // The public tiers a pool can be opened on, live, in offer order: every pool rate on the card is one of theirs.
  const publicTiers: AmmConfigView[] = PUBLIC_TIER_INDICES.flatMap((i) => {
    const t = rows.find((r) => r.index === i);
    return t?.state === 'live' && t.config ? [t.config] : [];
  });
  const venue = howVenueEarns(publicTiers, jupiterFee);
  const explorer = explorerOf(useLpWrites());
  const tiers = rows.filter((t) => t.state !== 'absent' || t.index === 0 || t.index === PUBLIC_TIER_INDICES[0]).sort((a, b) => rank(a.index) - rank(b.index));
  const severalPublic = tiers.filter((t) => isPublicTierIndex(t.index)).length > 1;
  const wallets = venue.wallets.map((w) => (
    <AddressRow key={w.address} label={w.label} value={w.address} explorer={explorer(w.address, 'wallet')} />
  ));
  return (
    <section data-testid="fee-tiers" aria-label="Rates">
      <Card title="Rates" testId="lp-rates" art={<CardArt pageId="solana-lp" idx={1} />}>
        {!read ? (
          <p data-testid="lp-no-rate">Reading the rates from the chain…</p>
        ) : read.kind === 'unread' ? (
          <div data-testid="lp-no-rate">
            <Notice tone="warn">The rates could not be read ({read.detail}), so none is shown.</Notice>
          </div>
        ) : (
          <>
            <table className="w-full text-left border-collapse" data-testid="lp-rate-table">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-white/55 align-bottom">
                  <th scope="col" className="py-1.5 pr-2 font-semibold">Pool</th>
                  <th scope="col" className="py-1.5 px-1 font-semibold text-right">Trade fee</th>
                  <th scope="col" className="py-1.5 px-1 font-semibold text-right">To the pool</th>
                  <th scope="col" className="py-1.5 pl-1 font-semibold text-right">To the venue</th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((t) => (
                  <tr key={t.index} data-testid="fee-tier" data-index={t.index} data-state={t.state} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                    <th scope="row" className="py-2.5 pr-2 font-normal text-white text-[13px] leading-tight">{tierName(t, severalPublic)}</th>
                    {t.state === 'live' && t.config ? (
                      <TierCells config={t.config} />
                    ) : (
                      <td colSpan={3} className="py-2.5 text-right text-white/60 text-[12px]">
                        {t.state === 'absent' ? 'not created yet' : 'the account there is not a fee tier'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {publicTiers.length > 0 && (
              <p className="text-white/70 text-[12px]" data-testid="lp-open-cost">
                {openLine(publicTiers, read.openingDeposits)}
              </p>
            )}
            {/* A cut that is anything but the agreed split (wallets or rates) is said in plain
                sight, in bold (owner, 2026-10-10). The agreed split keeps its wallets one press away. */}
            {venue.elsewhere && (
              <div data-testid="lp-venue-elsewhere" className="space-y-1">
                <p className="text-amber-200 text-[12px]"><strong>{venue.where}</strong></p>
                {wallets}
              </div>
            )}
          </>
        )}
        <FinePrint summary="Details">
          <p>Read from the chain when this page loads.</p>
          {publicTiers.map((t) => (
            <p key={t.index}>{earnSentence(t, publicTiers)}</p>
          ))}
          {howYouEarn(publicTiers).map((line) => (
            <p key={line}>{line}</p>
          ))}
          <ul className="list-disc pl-4 space-y-1" data-testid="lp-venue-sources">
            {venue.sources.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {!venue.elsewhere && venue.where && <p>{venue.where}</p>}
          {!venue.elsewhere && wallets}
          {read?.kind === 'ok' &&
            tiers.map((t) =>
              t.state === 'live' && t.config ? (
                <div key={t.index} data-testid="fee-tier-detail" data-index={t.index} className="space-y-1 pt-1">
                  <Row
                    label={`Tier ${t.index}${t.index === 0 ? ' (graduated launches)' : isPublicTierIndex(t.index) ? ' (public pools)' : ''}`}
                    value={tierCostText(t.config)}
                    mono={false}
                  />
                  <Row
                    label="Split"
                    value={`LPs ${feeSplit(t.config).lpKeepsPct.toFixed(3)}%, venue ${feeSplit(t.config).venueTakesPct.toFixed(3)}% of each trade`}
                    mono={false}
                  />
                  {t.config.creatorFeeRate > 0n && (
                    <Row
                      label="Creator fee"
                      value={`${feeRateText(t.config.creatorFeeRate)} a trade on top of the trade fee, in launch pools only; it goes to the token's creator, not to LPs`}
                      mono={false}
                    />
                  )}
                  <Row
                    label="To open a pool"
                    value={t.config.disableCreatePool ? 'switched off' : openingCost(t.config.createPoolFee, read.openingDeposits)}
                    mono={false}
                  />
                </div>
              ) : null,
            )}
        </FinePrint>
      </Card>
    </section>
  );
}

/**
 * Routes: where a swap goes. Every quote on the Solana swap asks our pools and Jupiter
 * and sends the trade where it pays the trader more, a tie going to our pool. Said as two
 * rows a glance can read; the sentence is in How it works, word for word.
 */
export function Routes({ jupiterFee = BUILD_JUPITER_FEE }: { jupiterFee?: JupiterFee | null }) {
  const swapFee = howVenueEarns([], jupiterFee).sources[2];
  return (
    <section data-testid="lp-routes" aria-label="Swap routes">
      <Card title="Swap routes" art={<CardArt pageId="venue-amm" idx={4} />}>
        <ul className="space-y-1.5" data-testid="lp-route-rules">
          <li className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="text-white text-[14px] font-semibold">Our pools</span>
            <span className="text-white/75 text-[12px]">when they pay you at least as much</span>
          </li>
          <li className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="text-white text-[14px] font-semibold">Jupiter</span>
            <span className="text-white/75 text-[12px]">when it pays you more</span>
          </li>
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/solana" className="btn-secondary px-5 py-2.5 text-[13px] inline-block">Swap</Link>
          <span className="text-white/60 text-[12px]" data-testid="lp-route-fee">
            Venue fee through Jupiter: {jupiterFee ? pctText(jupiterFee.bps / 100) : 'none'}
          </span>
        </div>
        <FinePrint summary="How it works">
          <p>
            Every quote on the Solana swap also asks our own pools, and prints which one
            pays the trader more and by how much. The trade goes where it pays more: to
            our pool when ours pays at least as much as Jupiter, and through Jupiter
            when it does not.
          </p>
          <p>{swapFee}</p>
        </FinePrint>
      </Card>
    </section>
  );
}

function TierCells({ config }: { config: AmmConfigView }) {
  // A launch pool charges the tier's creator fee on top (the launch program switches it on);
  // a pool anyone opens does not (CREATOR_FEE_SWITCH).
  const cost = tradeCost(config, chargedCreatorFeeRate(config, config.index === 0 ? CREATOR_FEE_SWITCH.launchPool : CREATOR_FEE_SWITCH.publicOpen));
  const split = feeSplit(config);
  return (
    <>
      <td className="py-2.5 px-1 text-right align-top">
        <span className="stat-value text-[17px] text-white">{feeRateText(cost.totalRate)}</span>
        {cost.creatorFeeRate > 0n && <span className="block text-[10px] text-white/55">incl. {feeRateText(cost.creatorFeeRate)} creator</span>}
      </td>
      <td className="py-2.5 px-1 text-right align-top">
        <span className="stat-value text-[17px]" style={{ color: '#4ade80' }}>{pctText(split.lpKeepsPct)}</span>
      </td>
      <td className="py-2.5 pl-1 text-right align-top">
        <span className="stat-value text-[17px] text-white">{pctText(split.venueTakesPct)}</span>
      </td>
    </>
  );
}

/** The public tiers first, in offer order, then every other by index. */
function rank(index: number): number {
  const k = (PUBLIC_TIER_INDICES as readonly number[]).indexOf(index);
  return k >= 0 ? k - PUBLIC_TIER_INDICES.length : index;
}

/** A row's name: "Public pools" while one public tier is listed; each by its read rate once there are more. */
function tierName(t: { index: number; config: AmmConfigView | null }, severalPublic: boolean): string {
  if (t.index === 0) return 'Launch pools';
  if (!isPublicTierIndex(t.index)) return `Tier ${t.index}`;
  if (!severalPublic) return 'Public pools';
  return t.config ? `${feeRateText(t.config.tradeFeeRate)} pools` : `Public pools (tier ${t.index})`;
}

/** What opening a pool costs, in one line: the fee (per tier when they differ) and the setup, neither refunded. */
function openLine(tiers: readonly AmmConfigView[], deposits: bigint | null): string {
  const open = tiers.filter((t) => !t.disableCreatePool);
  if (open.length === 0) return 'Opening a pool: switched off.';
  const feeOf = (t: AmmConfigView) => (t.createPoolFee > 0n ? solText(t.createPoolFee) : 'no fee');
  const same = open.every((t) => t.createPoolFee === open[0]!.createPoolFee);
  const fee = same ? feeOf(open[0]!) : open.map((t) => `${feeOf(t)} (${feeRateText(t.tradeFeeRate)} pools)`).join(' or ');
  const setup = deposits === null ? 'setup (not read)' : `${solText(deposits)} setup`;
  return `Open a pool: ${fee} + ${setup}, not refunded.`;
}

/** The split as a sentence, in the small print, one per public tier. */
function earnSentence(tier: AmmConfigView, tiers: readonly AmmConfigView[]): string {
  const split = feeSplit(tier);
  return `In ${poolWords(tier, tiers)}, each trade pays ${feeRateText(tier.tradeFeeRate)}: ${pctText(split.lpKeepsPct)} stays with LPs, ${pctText(split.venueTakesPct)} goes to the venue.`;
}

/**
 * What opening a pool costs: the tier's fee, plus the account deposits (rent) the pool
 * program takes for the pool, its price record, its LP mint and its vaults, which are
 * never refunded. "No fee" is never "free".
 */
function openingCost(fee: bigint, deposits: bigint | null): string {
  const feeText = fee > 0n ? `${solOf(fee)} SOL fee` : 'No fee';
  return deposits === null
    ? `${feeText}, plus account deposits that are never refunded (their amount could not be read)`
    : `${feeText}, plus about ${solText(deposits)} of account deposits that are never refunded`;
}

/**
 * What a trade on a tier costs. A tier with a creator rate charges it only in the pools
 * whose own switch is on, which are the launch program's (CREATOR_FEE_SWITCH): a launch
 * pool costs both fees, a pool anyone opens costs the trade fee alone. Both are said.
 */
function tierCostText(config: AmmConfigView): string {
  if (config.creatorFeeRate === 0n) return tradeCostText(config, CREATOR_FEE_SWITCH.publicOpen);
  const launch = tradeCost(config, chargedCreatorFeeRate(config, CREATOR_FEE_SWITCH.launchPool));
  return `${feeRateText(launch.totalRate)} a trade in launch pools (${feeRateText(launch.tradeFeeRate)} trade fee, ${feeRateText(launch.creatorFeeRate)} creator fee); ${feeRateText(config.tradeFeeRate)} in a pool anyone opens`;
}
