import type { ReactNode } from 'react';
import type { AmmConfigView } from '../../../lib/solana/cpswap/program';
import { chargedCreatorFeeRate, feeSplit } from '../../../lib/solana/cpswap/venue';
import { feeRateText } from '../../../lib/solana/lp/format';
import { SOL_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import { Notice, Row } from '../curve/ui';
import { FinePrint } from '../../ui/FinePrint';
import { LOCKED_SHARES_TEXT, solAbout, solExact } from './panelKit';

// What a person must know before putting money into one of these pools, said in the
// panel (always visible) and again on the review. No forecast of a return is made here:
// what a pool or a position earned is measured elsewhere, and the one sentence that
// stretches a measure over time is pace.ts's, with its basis (format.ts FORECAST_WORDS).
// Where a pool's trades come from is said as the routes that exist, never as a volume.

// True of the pool program RUNNING on mainnet since its upgrade: that build has
// create_lp_metadata, and its public initialize refuses fee tier 0. Before the upgrade this
// said "with only its admin keys changed". src/test/poolProgramCopy.test.ts ties the wording
// to the binary the local harness pins, so the two can only move together (a roll-back too).
const FORK_LINE =
  "Our pool program is Raydium's, with its admin keys changed, one added instruction that names pool share tokens and one added check that keeps the launch fee tier for launches. Those changes have not had their own independent review yet. Put in only what you can afford to lose.";
/**
 * The risk in one sentence (owner, 2026-10-17: off the page, first in every Risks drop-down):
 * what the team's vault can do, that each change waits 48 hours after both keys approve
 * (Squads #14's time lock, read on chain 2026-10-20), and that no outside firm has checked our
 * changes. LpDisclosure's small print (SolanaLpSection.tsx) says it in full, with the
 * addresses. It names no change to the program, so the pool program's upgrade leaves it true.
 */
export const RISK_SHORT =
  "The team's vault can pause removing, change fees or replace the program, 48 hours after both its keys approve. No outside firm has checked our changes. Only add what you can afford to lose.";
const VAULT_LINE =
  "The team's vault (a Squads multisig, two signatures) can switch off deposits, withdrawals or swaps on this pool, change its fee rates, and upgrade the program. Each change waits 48 hours after both have signed. If it switched off withdrawals, you could not take your money out until it switched them back on.";
const LAUNCH_POOL_LINE =
  "The launch program opened this pool when the token graduated and burned the launch's own pool shares, so that part can never be taken out. You get shares only for what you add, and you can take your part back out. The creator's fee and the venue's share are kept apart in the pool and are not yours.";
const ROUTING_LINE =
  "Jupiter does not send trades to these pools yet. This site's own swap sends a trade to this pool only when it pays the trader at least as much as Jupiter does, so fees can be small.";
const PRICE_MOVES_LINE = 'When the price moves, you can end up with less than if you had just held both tokens.';

// ── opening a pool ──

/** What the vault can do to a pool this site opens, and to the tier it opens on. */
const CREATE_VAULT_LINE =
  "The team's vault (a Squads multisig, two signatures) can switch off deposits, withdrawals or swaps on this pool, change the public fee tier's rates and its fee to open a pool, and upgrade the program. Each change waits 48 hours after both have signed. If it switched off withdrawals, you could not take your money out until it switched them back on.";

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

const NOT_THE_POOL_LINE = "Anyone can open other pools for this token, at any price. Yours will not be 'the' pool.";

/**
 * The liquidity providers' share of each trade, read from the pool's own fee tier just
 * now, and the creator fee traders pay on top when this pool's own switch is on: that
 * part goes to the pool's creator, so it is not part of what LPs keep.
 */
function lpShareLine(config: AmmConfigView | null, enableCreatorFee: boolean): string {
  if (!config) return "This pool's fee settings could not be read, so what liquidity providers keep of each trade is not shown.";
  const creator = chargedCreatorFeeRate(config, enableCreatorFee);
  const creatorLine = creator > 0n ? ` Traders also pay this pool's creator ${feeRateText(creator)} of each trade on top; that part is not yours.` : '';
  return `Of each trade, liquidity providers keep ${feeSplit(config).lpKeepsPct.toFixed(3)}%, read from this pool's fee tier just now.${creatorLine} The vault can change that tier's rates. A change waits 48 hours after both its keys approve, then applies to what you put in too.`;
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
        {!reviewing && <li>{FORK_LINE}</li>}
        {!reviewing && <li>{VAULT_LINE}</li>}
        <li>{PRICE_MOVES_LINE}</li>
        <li>{ROUTING_LINE}</li>
        <li>{lpShareLine(config, enableCreatorFee)}</li>
        {launchPool && <li>{LAUNCH_POOL_LINE}</li>}
      </LpRisksDetails>
    </div>
  );
}

/** The risks, one press away: the form's own lines (`children`) first, then the ones every form shares. */
export function LpRisksDetails({ children }: { children?: ReactNode }) {
  return (
    <details className="rounded-lg" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
      <summary className="min-h-[44px] flex items-center px-3 cursor-pointer text-white/75">Risks</summary>
      <ul className="list-disc pl-7 pr-3 pb-3 space-y-1 text-white/65">
        {children}
        <li>Anyone can open a pool for any token, at any price, so being listed here does not make it &quot;the&quot; pool.</li>
        <li>Whether a token&apos;s creator can still freeze accounts is checked only when you look; it is not watched for you.</li>
        <li>When withdrawals are switched off on a pool, the pool program refuses every withdrawal from it.</li>
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
 * Before opening a pool, always visible: the fork line, what the vault can do, how a new
 * pool earns (honestly), what opening costs and keeps for good, and that it will not be
 * "the" pool. `fee` and `neverRefunded` are read live; an unread deposit says so.
 *
 * The fee to open and the account deposits are SOL whatever the pool is paired with (the
 * pool program takes its fee in SOL, and every account's deposit is SOL). So those two
 * figures never follow the coin, and for a pool paired with another coin the line says so:
 * someone putting in USDC must not read "0.15" as USDC.
 */
export function LpBeforeYouOpen({
  fee,
  neverRefunded,
  walletConnected = true,
  coin = SOL_QUOTE,
  reviewing = false,
}: {
  fee: bigint;
  neverRefunded: bigint | null;
  /** The deposits are read with the wallet. With none connected they are not "unread": the page's fee tiers list has them. */
  walletConnected?: boolean;
  /** The coin the new pool is paired with. Left out, it is SOL. */
  coin?: QuoteCoin;
  /** As on `LpBeforeYouAdd`: the review on screen says the risk line, the fork line and the vault line. */
  reviewing?: boolean;
}) {
  const deposits =
    neverRefunded !== null
      ? `about ${solAbout(neverRefunded)} in account deposits that never come back`
      : walletConnected
        ? 'account deposits that never come back (their amount could not be read)'
        : 'account deposits that never come back (the fee tiers list on this page has their amount)';
  return (
    <div className="space-y-2" data-testid="lp-before-you-open">
      <LpRisksDetails>
        {!reviewing && <li>{RISK_SHORT}</li>}
        {!reviewing && <li>{FORK_LINE}</li>}
        {!reviewing && <li>{CREATE_VAULT_LINE}</li>}
        <li>{MONEY_LINE}</li>
        <li>
          Opening costs {solExact(fee)}, paid to the team&apos;s vault, and {deposits}.{' '}
          {!coin.native && `Both are paid in SOL, whatever the pool is paired with: none of it comes out of your ${coin.symbol}. `}
          {LOCKED_SHARES_TEXT} stay locked in the pool forever; that is the pool program&apos;s rule for every new pool.
        </li>
        <li>{NOT_THE_POOL_LINE}</li>
      </LpRisksDetails>
    </div>
  );
}

/**
 * On the review, above its rows. A deposit: the fork line, the vault line, and the
 * launch-pool line for a launch pool. An opening: the fork line, what the vault can do to
 * the new pool and its tier, and how a new pool earns.
 */
export function LpReviewDisclosure(p: { kind: 'add'; origin: 'launch-pool' | 'standard' | 'other' } | { kind: 'create' }) {
  return (
    <div className="space-y-1" data-testid="lp-review-disclosure" data-kind={p.kind}>
      {/* On a phone the review is two screens long and its button is at the end of it. */}
      <Notice>Read this through. The Sign in wallet button is at the end of it.</Notice>
      <FinePrint summary="Risks">
        <p>{RISK_SHORT}</p>
        <p>{FORK_LINE}</p>
        <p>{p.kind === 'create' ? CREATE_VAULT_LINE : VAULT_LINE}</p>
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
      <summary className="min-h-[44px] flex items-center px-3 cursor-pointer text-white/75">Leaving without this site</summary>
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
