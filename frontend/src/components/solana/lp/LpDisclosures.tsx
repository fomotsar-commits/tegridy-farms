import type { ReactNode } from 'react';
import type { AmmConfigView } from '../../../lib/solana/cpswap/program';
import { chargedCreatorFeeRate, feeSplit } from '../../../lib/solana/cpswap/venue';
import { feeRateText } from '../../../lib/solana/lp/format';
import { SOL_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import { Notice, Row } from '../curve/ui';
import { DisclosureArrow, FinePrint } from '../../ui/FinePrint';
import { LOCKED_SHARES_TEXT, solAbout, solExact } from './panelKit';

// What a person must know before putting money into one of these pools, said in the
// panel's Risks drop-down and again on the review. No forecast of a return is made here:
// what a pool or a position earned is measured elsewhere, and the one sentence that
// stretches a measure over time is pace.ts's, with its basis (format.ts FORECAST_WORDS).
// Where a pool's trades come from is said as the routes that exist, never as a volume.

// True of the pool program RUNNING on mainnet since its keeper-fee upgrade: that build has
// create_lp_metadata, refuses a public initialize on fee tier 0, holds a fee tier's fees
// inside limits, has the swap guard, and lets a fee tier's keeper swap free of the fees.
// src/test/poolProgramCopy.test.ts ties the wording to the binary the local harness pins,
// so the two can only move together (a roll-back too). The fork line names no trader. It
// follows RISK_SHORT wherever it is drawn, so the no-outside-audit line and the
// afford-to-lose clause are said there, once.
const FORK_LINE =
  "Our pool program is Raydium's, with its admin keys changed, one added instruction that names pool share tokens, one added check that keeps the launch fee tier for launches, added fee limits, an added swap guard and a fee exemption for a fee tier's keeper. While the vault has the guard switched on, a pool takes a swap only when a wallet sends it directly, and refuses one that another program makes.";
/**
 * Who pays no fee (states/config.rs swap_fee_rates): a tier's keeper, on the swaps it signs.
 * The vault names it (proposal #34: the price robot, on both tiers). Said beside what LPs keep.
 * The creator fee is named only where the pool charges one, as lpShareLine does.
 */
const KEEPER_PAYS = {
  both: 'pays no trade fee and no creator fee on its own swaps',
  trade: 'pays no trade fee on its own swaps',
} as const;
function KeeperLine({ creatorFee }: { creatorFee: boolean }) {
  // The wallet comes last, on a line of its own, never mid-sentence. At 10px, tight, its 44
  // characters fit a Risks list at 390 (260px) in a 0.6em mono like an iPhone's (about 253px);
  // a narrower screen breaks it there, at its end.
  return (
    <>
      A fee tier&apos;s named keeper, the venue&apos;s own price robot, {creatorFee ? KEEPER_PAYS.both : KEEPER_PAYS.trade}, so those swaps
      earn liquidity providers nothing. Everyone else pays as before. The robot&apos;s wallet:
      <span className="block font-mono text-[10px] tracking-tight [overflow-wrap:anywhere]">9WAugU3g3YECwuEuoPy3NEH5Co475fHATGdjr2dy2Fcz</span>
    </>
  );
}
/**
 * The risk in one sentence, first in every Risks drop-down (owner, 2026-10-17). The wait is said
 * as read: Squads multisig EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK, threshold 2, time_lock
 * 172,800 s (2026-11-14 UTC, finalized slot 469,210,343); reword it when that changes. The small
 * print (SolanaLpSection.tsx) says it in full. It names no program change, so an upgrade leaves it true.
 */
export const RISK_SHORT =
  "The team's vault can switch off withdrawals, change fees or replace the program, 48 hours after both keys approve (read on chain 2026‑11‑14). Our changes to Raydium's program have no outside audit. Only add what you can afford to lose.";
// What the vault adds to RISK_SHORT, which is drawn above it on every list: that it is a
// Squads multisig, the switch-offs RISK_SHORT does not name, that every action waits the
// same, and what a switch-off of withdrawals does to a deposit.
const VAULT_LINE =
  "The team's vault is a Squads multisig. It can also switch off deposits or swaps on this pool, and every action it takes has the same wait. If it switched off withdrawals, you could not take your money out until it switched them back on.";
const LAUNCH_POOL_LINE =
  "The launch program opened this pool when the token graduated and burned the launch's own pool shares, so that part can never be taken out. You get shares only for what you add, and you can take your part back out. The creator's fee and the venue's share are kept apart in the pool and are not yours.";
const ROUTING_LINE =
  "Jupiter does not send trades to these pools yet. This site's own swap sends a trade to this pool only when it pays the trader at least as much as Jupiter does, so fees can be small.";
const PRICE_MOVES_LINE = 'When the price moves, you can end up with less than if you had just held both tokens.';

// ── opening a pool ──

/** What the vault can do to a pool this site opens, and to the tier it opens on, beyond RISK_SHORT above it. */
const CREATE_VAULT_LINE =
  "The team's vault is a Squads multisig. It can also switch off deposits or swaps on this pool, or change the public fee tier's fee to open a pool; every action it takes has the same wait. If it switched off withdrawals, you could not take your money out until it switched them back on.";

/**
 * How a new pool earns, honestly, in short: on the card and the review. Jupiter does not
 * send trades to our pools. This site's own swap does, but only a trade the pool pays at
 * least as much for as Jupiter would (lib/solana/route.ts). Any other trade has to be
 * sent to the pool program by its sender. Who that will be, or how often, is not said.
 */
export const MONEY_NOTE =
  "Jupiter does not send trades to our pools. This site's own swap sends a trade to a pool only when that pool pays the trader at least as much as Jupiter does. Any other trade has to come from someone using our pool program directly.";

const MONEY_LINE =
  "How a new pool earns, honestly: Jupiter does not send trades to our pools. This site's own swap sends a trade to your pool only when your pool pays the trader at least as much as Jupiter does. Any other trade has to come from someone using our pool program directly. Expect little or nothing in fees at first. When the price moves, you can also end up with less than if you had just held both tokens.";

/** Said on the opening form in place of the list's own line on it (`LpRisksDetails`), not beside it. */
const NOT_THE_POOL_LINE = "Anyone can open other pools for this token, at any price. Yours will not be 'the' pool.";

/**
 * The liquidity providers' share of each trade, read from the pool's own fee tier just
 * now, and the creator fee traders pay on top when this pool's own switch is on: that
 * part goes to the pool's creator, so it is not part of what LPs keep. The wait for a
 * change is RISK_SHORT's, drawn on the same screen: this line says only where a change lands.
 */
function lpShareLine(config: AmmConfigView | null, enableCreatorFee: boolean): string {
  if (!config) return "This pool's fee settings could not be read, so what liquidity providers keep of each trade is not shown.";
  const creator = chargedCreatorFeeRate(config, enableCreatorFee);
  const creatorLine = creator > 0n ? ` Traders also pay this pool's creator ${feeRateText(creator)} of each trade on top; that part is not yours.` : '';
  return `Of each trade, liquidity providers keep ${feeSplit(config).lpKeepsPct.toFixed(3)}%, read from this pool's fee tier just now.${creatorLine} If the vault changes that tier's rates, the change applies to what you put in too.`;
}

/**
 * `reviewing`: a review is on screen, and it says the risk line, the fork line and the
 * vault line above its rows, so they are not said a second time under its Sign button
 * (island, answer eighteen: the two risk notices stand once).
 */
export function LpBeforeYouAdd({
  launchPool,
  config,
  enableCreatorFee,
  reviewing = false,
}: {
  launchPool: boolean;
  config: AmmConfigView | null;
  enableCreatorFee: boolean;
  reviewing?: boolean;
}) {
  return (
    <div className="space-y-2" data-testid="lp-before-you-add">
      <LpRisksDetails>
        {!reviewing && <li>{RISK_SHORT}</li>}
        {!reviewing && <li>{VAULT_LINE}</li>}
        {!reviewing && <li>{FORK_LINE}</li>}
        <li>{PRICE_MOVES_LINE}</li>
        <li>{ROUTING_LINE}</li>
        <li>{lpShareLine(config, enableCreatorFee)}</li>
        <li><KeeperLine creatorFee={config !== null && chargedCreatorFeeRate(config, enableCreatorFee) > 0n} /></li>
        {launchPool && <li>{LAUNCH_POOL_LINE}</li>}
      </LpRisksDetails>
    </div>
  );
}

/**
 * A bordered LP drop-down's summary: the small print's arrow (FinePrint), so a closed one says
 * it opens, and the 44px press. A `flex` summary draws no marker of the browser's own.
 */
export function LpSummary({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <summary className={`min-h-[44px] flex items-center gap-1.5 px-3 cursor-pointer text-white/75 list-none [&::-webkit-details-marker]:hidden ${className}`}>
      <DisclosureArrow />
      {children}
    </summary>
  );
}

/**
 * The risks, one press away: the form's own lines (`children`) first, then the ones every form
 * shares. `anyonePool`: the form's own words for "anyone can open a pool", said in the list's place.
 */
export function LpRisksDetails({ children, anyonePool }: { children?: ReactNode; anyonePool?: string }) {
  return (
    <details className="rounded-lg" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
      <LpSummary>Risks</LpSummary>
      <ul className="list-disc pl-7 pr-3 pb-3 space-y-1 text-white/65">
        {children}
        <li>{anyonePool ?? 'Anyone can open a pool for any token, at any price, so being listed here does not make it "the" pool.'}</li>
        <li>Whether a token&apos;s creator can still freeze accounts is checked only when you look; it is not watched for you.</li>
        <li>Adding and then removing costs at most one smallest unit per side in rounding, plus the network fees.</li>
        <li>This browser remembers a transaction you sent until the network answers for it. Another tab does not know about it.</li>
      </ul>
    </details>
  );
}

/**
 * What pairing with this coin adds to the risks (quotes.ts `risk`), in the coin's own
 * words, or nothing for a coin that adds none. Said where the coin is chosen; the review
 * says it again before the signature (TxFlowView.tsx). `id`: so Review can be described by
 * it, and a screen reader says it when focus reaches the button.
 */
export function CoinRiskNotice({ coin, id }: { coin: QuoteCoin; id?: string }) {
  if (!coin.risk) return null;
  return (
    <div id={id} data-testid="lp-coin-risk" data-coin={coin.symbol}>
      <Notice tone="warn">{coin.risk}</Notice>
    </div>
  );
}

/**
 * Before opening a pool, in its Risks drop-down: the fork line, what the vault can do, how a new
 * pool earns, what opening costs and keeps for good, and that it will not be "the" pool. `fee`
 * and `neverRefunded` are read live; an unread deposit says so. The fee to open and the deposits
 * are SOL whatever the pairing coin, so for another coin the line says so: someone putting in
 * USDC must not read "0.15" as USDC.
 */
export function LpBeforeYouOpen({
  fee,
  neverRefunded,
  nameRecord = null,
  walletConnected = true,
  coin = SOL_QUOTE,
  reviewing = false,
}: {
  fee: bigint;
  neverRefunded: bigint | null;
  /** What the new share token's name record costs (its deposit plus Metaplex's fee), read with the deposits. */
  nameRecord?: bigint | null;
  /** The deposits are read with the wallet. With none connected they are not "unread": the page's fee tiers list has them. */
  walletConnected?: boolean;
  /** The coin the new pool is paired with. Left out, it is SOL. */
  coin?: QuoteCoin;
  /** As on `LpBeforeYouAdd`: the review on screen says the risk line, the fork line and the vault line. */
  reviewing?: boolean;
}) {
  const deposits =
    neverRefunded !== null
      ? `about ${solAbout(neverRefunded, true)} in account deposits that never come back`
      : walletConnected
        ? 'account deposits that never come back (their amount could not be read)'
        : 'account deposits that never come back (Rates, on this page, has their amount)';
  return (
    <div className="space-y-2" data-testid="lp-before-you-open">
      <LpRisksDetails anyonePool={NOT_THE_POOL_LINE}>
        {!reviewing && <li>{RISK_SHORT}</li>}
        {!reviewing && <li>{CREATE_VAULT_LINE}</li>}
        {!reviewing && <li>{FORK_LINE}</li>}
        <li>{MONEY_LINE}</li>
        {/* A pool opened from this site charges no creator fee (CREATOR_FEE_SWITCH.publicOpen). */}
        <li><KeeperLine creatorFee={false} /></li>
        <li>
          Opening costs {solExact(fee)}, paid to the team&apos;s vault, and {deposits}{nameRecord !== null ? `, plus ${solExact(nameRecord)} for the pool share's name record (Metaplex's fee and the record's deposit)` : ''}.{' '}
          {!coin.native && `${nameRecord !== null ? 'All of it is' : 'Both are'} paid in SOL, whatever the pool is paired with: none of it comes out of your ${coin.symbol}. `}
          {LOCKED_SHARES_TEXT} stay locked in the pool forever; that is the pool program&apos;s rule for every new pool.
        </li>
      </LpRisksDetails>
    </div>
  );
}

/**
 * On the review, above its rows. A deposit: the vault line, the fork line, and the
 * launch-pool line for a launch pool. An opening: what the vault can do to the new pool and
 * its tier, the fork line, and how a new pool earns.
 */
export function LpReviewDisclosure(p: { kind: 'add'; origin: 'launch-pool' | 'standard' | 'other' } | { kind: 'create' }) {
  return (
    <div className="space-y-1" data-testid="lp-review-disclosure" data-kind={p.kind}>
      {/* On a phone the review is two screens long and its button is at the end of it. */}
      <Notice>Read this through. The Sign in wallet button is at the end of it.</Notice>
      <FinePrint summary="Risks">
        <p>{RISK_SHORT}</p>
        <p>{p.kind === 'create' ? CREATE_VAULT_LINE : VAULT_LINE}</p>
        <p>{FORK_LINE}</p>
        {p.kind === 'add' && p.origin === 'launch-pool' && <p>{LAUNCH_POOL_LINE}</p>}
        {p.kind === 'create' && <p>{MONEY_NOTE}</p>}
      </FinePrint>
    </div>
  );
}

/**
 * How to leave without this site: the pool program's own `withdraw` takes these
 * accounts, and any tool that can build a cp-swap withdrawal can use them. Collapsed;
 * pure information.
 */
export function LeaveWithoutThisSite({
  programId,
  pool,
  lpMint,
  lpAccount,
  shares,
}: {
  programId: string;
  pool: string;
  lpMint: string;
  lpAccount: string;
  shares: string;
}) {
  return (
    <details className="rounded-lg" style={{ border: '1px solid rgba(255,255,255,0.08)' }} data-testid="lp-leave-without-site">
      <LpSummary>Leaving without this site</LpSummary>
      <div className="px-3 pb-3 space-y-1.5">
        <p className="text-white/65">
          The pool program lets you take your share out with its <code className="font-mono">withdraw</code> instruction. Any tool that
          can build a cp-swap withdraw can use these:
        </p>
        <Row label="Pool program" value={programId} />
        <Row label="Pool" value={pool} />
        <Row label="Pool share token" value={lpMint} />
        <Row label="Your pool-share account" value={lpAccount} />
        <Row label="Shares you hold" value={shares} mono={false} />
      </div>
    </details>
  );
}
