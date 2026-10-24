import { Link } from 'react-router-dom';
import { PUBLIC_TIER_INDEX, type AmmConfigView } from '../../../lib/solana/cpswap/program';
import { CREATOR_FEE_SWITCH, chargedCreatorFeeRate, feeSplit, solOf, tradeCost } from '../../../lib/solana/cpswap/venue';
import { feeRateText, pctText, solText, tradeCostText } from '../../../lib/solana/lp/format';
import { SOLANA_FEE_ACCOUNT, SOLANA_PLATFORM_FEE_BPS, isSolanaFeeConfigured } from '../../../lib/solana';
import { howVenueEarns, howYouEarn, type JupiterFee } from '../../../lib/solana/lp/earnCopy';
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
 * Every number is the tier as the section's one read returned it; with no read, none.
 */
export function Rates({ read, jupiterFee = BUILD_JUPITER_FEE }: { read: FeeTierRead | null; jupiterFee?: JupiterFee | null }) {
  const publicTier = read?.kind === 'ok' ? read.tiers.find((t) => t.index === PUBLIC_TIER_INDEX && t.state === 'live')?.config ?? null : null;
  const venue = howVenueEarns(publicTier, jupiterFee);
  const explorer = explorerOf(useLpWrites());
  // The public tier first: every pool opened from this site is on it.
  const tiers = read?.kind === 'ok' ? [...read.tiers].sort((a, b) => rank(a.index) - rank(b.index)) : [];
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
                    <th scope="row" className="py-2.5 pr-2 font-normal text-white text-[13px] leading-tight">{tierName(t.index)}</th>
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
            {publicTier && (
              <p className="text-white/70 text-[12px]" data-testid="lp-open-cost">
                {openLine(publicTier, read.openingDeposits)}
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
          {publicTier && <p>{earnSentence(publicTier)}</p>}
          {howYouEarn(publicTier).map((line) => (
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
                    label={`Tier ${t.index}${t.index === 0 ? ' (graduated launches)' : t.index === PUBLIC_TIER_INDEX ? ' (public pools)' : ''}`}
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
  const swapFee = howVenueEarns(null, jupiterFee).sources[2];
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

function rank(index: number): number {
  return index === PUBLIC_TIER_INDEX ? -1 : index;
}

function tierName(index: number): string {
  if (index === PUBLIC_TIER_INDEX) return 'Public pools';
  if (index === 0) return 'Launch pools';
  return `Tier ${index}`;
}

/** What opening a pool on the public tier costs, in one line: the fee and the setup, neither refunded. */
function openLine(config: AmmConfigView, deposits: bigint | null): string {
  if (config.disableCreatePool) return 'Opening a pool: switched off.';
  const fee = config.createPoolFee > 0n ? solText(config.createPoolFee) : 'no fee';
  const setup = deposits === null ? 'setup (not read)' : `${solText(deposits)} setup`;
  return `Open a pool: ${fee} + ${setup}, not refunded.`;
}

/** The split as a sentence, in the small print. */
function earnSentence(tier: AmmConfigView): string {
  const split = feeSplit(tier);
  return `In a public pool, each trade pays ${feeRateText(tier.tradeFeeRate)}: ${pctText(split.lpKeepsPct)} stays with LPs, ${pctText(split.venueTakesPct)} goes to the venue.`;
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
