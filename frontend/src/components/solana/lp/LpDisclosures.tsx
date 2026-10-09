import type { AmmConfigView } from '../../../lib/solana/cpswap/program';
import { chargedCreatorFeeRate, feeSplit } from '../../../lib/solana/cpswap/venue';
import { feeRateText } from '../../../lib/solana/lp/format';
import { SOL_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import { Notice, Row } from '../curve/ui';
import { LOCKED_SHARES_TEXT, solAbout, solExact } from './panelKit';

// What a person must know before putting money into one of these pools, said in the
// panel (always visible) and again on the review. No yield, APR or APY: none has been
// measured, and none is ever shown.

// True of the pool program RUNNING on mainnet since its upgrade: that build has
// create_lp_metadata (the instruction that names pool share tokens). Before the upgrade this
// said "with only its admin keys changed". src/test/poolProgramCopy.test.ts ties the wording
// to the binary the local harness pins, so the two can only move together (a roll-back too).
const FORK_LINE =
  "Our pool program is Raydium's, with its admin keys changed and one added instruction that names pool share tokens. Those changes have not had their own independent review yet. Put in only what you can afford to lose.";
const VAULT_LINE =
  "The team's vault (a Squads multisig, two signatures) can switch off deposits, withdrawals or swaps on this pool, change its fee rates at once, and upgrade the program. If it switched off withdrawals, you could not take your money out until it switched them back on.";
const LAUNCH_POOL_LINE =
  "The launch program opened this pool when the token graduated and burned the launch's own pool shares, so that part can never be taken out. You get shares only for what you add, and you can take your part back out. The creator's fee and the venue's share are kept apart in the pool and are not yours.";
const ROUTING_LINE =
  'Jupiter does not send trades to these pools yet, so the trades that pay this pool its fees come mostly from bots that trade our pool program directly.';
const PRICE_MOVES_LINE =
  'When the price moves, bots trade against the pool, and you can end up with less than if you had just held both tokens.';

// ── opening a pool ──

/** What the vault can do to a pool this site opens, and to the tier it opens on. */
const CREATE_VAULT_LINE =
  "The team's vault (a Squads multisig, two signatures) can switch off deposits, withdrawals or swaps on this pool, change the public fee tier's rates and its fee to open a pool at once, and upgrade the program. If it switched off withdrawals, you could not take your money out until it switched them back on.";

/**
 * How a new pool earns, honestly, in short: on the card and the review. Jupiter does not
 * send trades to our pools. This site's own swap does, but only a trade the pool pays at
 * least as much for as Jupiter would (lib/solana/route.ts), so a new pool mostly sees
 * bots that trade our program directly.
 */
export const MONEY_NOTE =
  "Jupiter does not send trades to our pools. This site's own swap sends a trade to a pool only when that pool pays the trader at least as much as Jupiter does. The rest of the time a new pool earns fees only when bots trade our pool program directly, mostly arbitrage.";

const MONEY_LINE =
  "How a new pool earns, honestly: Jupiter does not send trades to our pools. This site's own swap sends a trade to your pool only when your pool pays the trader at least as much as Jupiter does. Every other trade against your pool comes from bots and tools that use our pool program directly, mostly arbitrage, which trades only when your pool's price drifts from the market. Expect little or nothing in fees at first. When the price moves, you can also end up with less than if you had just held both tokens.";

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
  return `Of each trade, liquidity providers keep ${feeSplit(config).lpKeepsPct.toFixed(3)}%, read from this pool's fee tier just now.${creatorLine} The vault can change that tier's rates at once, and a change applies to what you put in too.`;
}

export function LpBeforeYouAdd({ launchPool, config, enableCreatorFee }: { launchPool: boolean; config: AmmConfigView | null; enableCreatorFee: boolean }) {
  return (
    <div className="space-y-2" data-testid="lp-before-you-add">
      <ul className="list-disc pl-4 space-y-1 text-white/75">
        <li>{FORK_LINE}</li>
        <li>{VAULT_LINE}</li>
        <li>{PRICE_MOVES_LINE}</li>
        <li>{ROUTING_LINE}</li>
        <li>{lpShareLine(config, enableCreatorFee)}</li>
        {launchPool && <li>{LAUNCH_POOL_LINE}</li>}
      </ul>
      <LpRisksDetails />
    </div>
  );
}

export function LpRisksDetails() {
  return (
    <details className="rounded-lg" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
      <summary className="min-h-[44px] flex items-center px-3 cursor-pointer text-white/75">More about the risks</summary>
      <ul className="list-disc pl-7 pr-3 pb-3 space-y-1 text-white/65">
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
}: {
  fee: bigint;
  neverRefunded: bigint | null;
  /** The deposits are read with the wallet. With none connected they are not "unread": the page's fee tiers list has them. */
  walletConnected?: boolean;
  /** The coin the new pool is paired with. Left out, it is SOL. */
  coin?: QuoteCoin;
}) {
  const deposits =
    neverRefunded !== null
      ? `about ${solAbout(neverRefunded)} in account deposits that never come back`
      : walletConnected
        ? 'account deposits that never come back (their amount could not be read)'
        : 'account deposits that never come back (the fee tiers list on this page has their amount)';
  return (
    <div className="space-y-2" data-testid="lp-before-you-open">
      <ul className="list-disc pl-4 space-y-1 text-white/75">
        <li>{FORK_LINE}</li>
        <li>{CREATE_VAULT_LINE}</li>
        <li>{MONEY_LINE}</li>
        <li>
          Opening costs {solExact(fee)}, paid to the team&apos;s vault, and {deposits}.{' '}
          {!coin.native && `Both are paid in SOL, whatever the pool is paired with: none of it comes out of your ${coin.symbol}. `}
          {LOCKED_SHARES_TEXT} stay locked in the pool forever; that is the pool program&apos;s rule for every new pool.
        </li>
        <li>{NOT_THE_POOL_LINE}</li>
      </ul>
      <LpRisksDetails />
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
      <Notice tone="warn">{FORK_LINE}</Notice>
      <Notice>{p.kind === 'create' ? CREATE_VAULT_LINE : VAULT_LINE}</Notice>
      {p.kind === 'add' && p.origin === 'launch-pool' && <Notice>{LAUNCH_POOL_LINE}</Notice>}
      {p.kind === 'create' && <Notice>{MONEY_NOTE}</Notice>}
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
