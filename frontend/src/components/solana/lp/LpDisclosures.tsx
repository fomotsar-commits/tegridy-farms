import type { AmmConfigView } from '../../../lib/solana/cpswap/program';
import { feeSplit } from '../../../lib/solana/cpswap/venue';
import { Notice, Row } from '../curve/ui';

// What a person must know before putting money into one of these pools, said in the
// panel (always visible) and again on the review. No yield, APR or APY: none has been
// measured, and none is ever shown.

const FORK_LINE =
  "Our pool program is Raydium's, with only its admin keys changed. Those changes have not had their own independent review yet. Put in only what you can afford to lose.";
const VAULT_LINE =
  "The team's vault (a Squads multisig, two signatures) can switch off deposits, withdrawals or swaps on this pool, change its fee rates at once, and upgrade the program. If it switched off withdrawals, you could not take your money out until it switched them back on.";
const LAUNCH_POOL_LINE =
  "The launch program opened this pool when the token graduated and burned the launch's own pool shares, so that part can never be taken out. You get shares only for what you add, and you can take your part back out. The creator's fee and the venue's share are kept apart in the pool and are not yours.";
const ROUTING_LINE =
  'Jupiter does not send trades to these pools yet, so the trades that pay this pool its fees come mostly from bots that trade our pool program directly.';
const PRICE_MOVES_LINE =
  'When the price moves, bots trade against the pool, and you can end up with less than if you had just held both tokens.';

/** The liquidity providers' share of each trade, read from the pool's own fee tier just now. */
function lpShareLine(config: AmmConfigView | null): string {
  if (!config) return "This pool's fee settings could not be read, so what liquidity providers keep of each trade is not shown.";
  return `Of each trade, liquidity providers keep ${feeSplit(config).lpKeepsPct.toFixed(3)}%, read from this pool's fee tier just now. The vault can change that tier's rates at once, and a change applies to what you put in too.`;
}

export function LpBeforeYouAdd({ launchPool, config }: { launchPool: boolean; config: AmmConfigView | null }) {
  return (
    <div className="space-y-2" data-testid="lp-before-you-add">
      <ul className="list-disc pl-4 space-y-1 text-white/75">
        <li>{FORK_LINE}</li>
        <li>{VAULT_LINE}</li>
        <li>{PRICE_MOVES_LINE}</li>
        <li>{ROUTING_LINE}</li>
        <li>{lpShareLine(config)}</li>
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

/** On the deposit review, above its rows: the fork line, the vault line, and the launch-pool line for a launch pool. */
export function LpReviewDisclosure({ kind, origin }: { kind: 'add'; origin: 'launch-pool' | 'standard' | 'other' }) {
  return (
    <div className="space-y-1" data-testid="lp-review-disclosure" data-kind={kind}>
      <Notice tone="warn">{FORK_LINE}</Notice>
      <Notice>{VAULT_LINE}</Notice>
      {origin === 'launch-pool' && <Notice>{LAUNCH_POOL_LINE}</Notice>}
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
