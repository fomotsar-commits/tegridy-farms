// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { m } from 'framer-motion';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { PublicKey } from '@solana/web3.js';
import { SolanaProviders } from '../solana/SolanaProviders';
import { useSolanaConnect } from '../solana/useSolanaConnect';
import type { Bungalow } from '../../lib/bungalows';
import {
  isLadderConfigured, ladderProgramId,
  boostBpsForLock, weightForStake, quoteExit, checkDeposit, earnedNow, rewardRunwaySecs,
  minWeightFloor,
  MAX_LOCK_SECS, MAX_POSITIONS, MAX_EARLY_EXIT_PENALTY_BPS, MIN_BOOST_BPS,
  penaltyFor, penaltyPct, sharePct,
  type LadderPoolView, type LadderPositionView,
} from '../../lib/ladder/program';
import {
  readLadderPool, readVaultBalances, readLadderWallet, readOwnerTokenBalance,
  nextPositionNonce, walletPrincipalRaw,
  type LadderWalletView, type ReadResult,
} from '../../lib/ladder/read';
import {
  ladderStake, ladderClaim, ladderExit, ladderHatch, ladderClaimCarried,
  type WriteResult, type LadderWriteCtx,
} from '../../lib/ladder/write';
import { fmtRaw, fmtRawParts, toPlain, toRaw, humanDuration, lockLabel, boostLabel } from '../../lib/ladder/format';
import { basisBehindWrite, confirmedSlotOf, slotOrNull, type WriteFence } from '../../lib/ladder/writeFence';
import { useAccrualMeter } from '../../hooks/useAccrualMeter';
import { Fact, HEAD, PANEL_BG, LEDGER_BG, HAIR, DIVIDED_BG } from './ledger';
import { Reveal } from '../motion/Reveal';
import { DUR, EASE_OUT, pressTap, staggerContainer, staggerItem } from '../../lib/motion';

/**
 * A `bayla-ladder` pool, LIVE.
 *
 * The Solana twin of EvmLadderPoolLive, against this venue's own Anchor program
 * rather than LighthouseLadder.sol. It sits beside the Streamflow card. The two are
 * separate products on separate programs: neither replaces the other and nothing
 * moves between them, so a card that vanished the moment a second pool was
 * configured would hide real stakers' money.
 *
 * ── THE FOUR THINGS THIS CARD MUST NOT GET WRONG ────────────────────────────
 *
 * 1. THE HATCH IS NOT FREE WHILE LOCKED. `emergency_withdraw` charges the same penalty
 *    as `early_exit` — veYFI's schedule, the time left over four years capped at 75% —
 *    unless the position has matured or the pool is degraded (and in a degraded pool
 *    `early_exit` is free too).
 *    An earlier version of the operator CLI, the runbook and a sentence said out
 *    loud all had it costing nothing; the penalty rides inside a base64 event, so a
 *    dry run does not show it. Every door here is priced by `quoteExit()` and the
 *    number is on the button before it can be pressed.
 *
 * 2. REWARDS ARE COMPUTED, NOT READ. `rewards_owed` on chain is what was banked at
 *    the position's LAST interaction, and it only moves when somebody touches the
 *    pool — so a position earning for a month still stores a zero. `earnedNow()`
 *    runs the program's own accumulator forward. Printing the stored field would
 *    show a real staker that they have earned nothing.
 *
 * 3. AN UNREADABLE READ IS NOT A ZERO. Every figure below is `bigint | null`, and
 *    null renders as an outage with a reason, never as 0. That is this venue's
 *    most-repeated defect and the one it can least afford on a page with a stake
 *    button.
 *
 * 4. THE DEPOSIT GATES ARE ON CHAIN. `min_stake` (the deployed program has no setter
 *    for it — but the program is upgradeable), `deposit_cap`, `max_wallet_principal`
 *    and a per-wallet position limit are all enforced by the program. `checkDeposit()`
 *    runs them here first so a refusal explains itself instead of arriving as a
 *    constraint failure after a fee has been paid.
 */
export function SolanaLadderPoolLive({ bungalow }: { bungalow: Bungalow & { ladderPool: string } }) {
  return (
    <SolanaProviders>
      <Inner bungalow={bungalow} />
    </SolanaProviders>
  );
}

const DAY = 86_400;

/** The rungs this card offers. Every one is inside the program's 7d..4y range. */
const RUNGS = [7 * DAY, 30 * DAY, 90 * DAY, 180 * DAY, 365 * DAY, 2 * 365 * DAY, MAX_LOCK_SECS];

/** A unix second as a calendar date a person can hold, in their own locale. */
const dateOf = (secs: bigint) =>
  new Date(Number(secs) * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

type Config =
  | { ok: true; programId: PublicKey; pool: PublicKey }
  | { ok: false; reason: string };

/**
 * Resolve the program and pool ONCE, and never throw doing it.
 *
 * `ladderProgramId()` throws when unconfigured and `new PublicKey()` throws on a
 * malformed base58 string — so a typo in a Vercel env var would be an uncaught
 * render-time exception that takes the whole farm page down, not a graceful
 * "not configured". Both live inside this try.
 */
function resolveConfig(poolAddress: string): Config {
  if (!isLadderConfigured()) {
    return { ok: false, reason: 'This pool is not configured yet — no ladder program address is set for this deployment.' };
  }
  try {
    return { ok: true, programId: ladderProgramId(), pool: new PublicKey(poolAddress) };
  } catch (e) {
    return {
      ok: false,
      reason: `The configured ladder program or pool address is not a valid Solana address (${(e as Error).message}). That is a configuration error, not a network problem, so nothing here will send a transaction.`,
    };
  }
}

function Inner({ bungalow }: { bungalow: Bungalow & { ladderPool: string } }) {
  const { publicKey, wallet } = useWallet();
  const { connection } = useConnection();
  const openConnect = useSolanaConnect();
  // Footnote ids: each ledger fact points at its own disclosure (aria-describedby).
  const fid = useId();

  const config = useMemo(() => resolveConfig(bungalow.ladderPool), [bungalow.ladderPool]);

  const [poolRead, setPoolRead] = useState<ReadResult<LadderPoolView> | null>(null);
  const [vaults, setVaults] = useState<{ stakeRaw: bigint | null; rewardRaw: bigint | null } | null>(null);
  // Keyed by wallet so a disconnect or an account switch is handled by DERIVING the
  // visible values from a key match, never by a synchronous setState in an effect.
  const [walletRead, setWalletRead] = useState<{ key: string; result: ReadResult<LadderWalletView> } | null>(null);
  const [balance, setBalance] = useState<{ key: string; raw: bigint | null }>({ key: '', raw: null });

  const [amount, setAmount] = useState('');
  const [lockSecs, setLockSecs] = useState<number>(RUNGS[0]!);
  const [action, setAction] = useState<{ busy?: string; note?: string; sig?: string } | null>(null);
  // Two-step confirm, keyed by nonce+door. A door that costs a share of someone's
  // principal (up to `MAX_EARLY_EXIT_PENALTY_BPS`) must never be one mis-click away.
  // ⚠️ ARMED AGAINST ONE READ. Nonces restart at 0 for every wallet, so a bare
  // `nonce:door` armed by one wallet came up pre-armed on the next wallet's first
  // position after a switch. The armed door is stored with the exact wallet read its
  // row was drawn from, and any other read — another wallet, or the same one after
  // switching away and back — renders it disarmed (`armed` below).
  const [confirmFor, setConfirmFor] = useState<{ read: typeof walletRead; door: string } | null>(null);
  // Every pool and wallet read is started by the ONE effect below, so a wallet switch
  // cancels it. `run()` and "Try again" used to call a refresh from the render they
  // were clicked in and drop its cancellation: a read for the PREVIOUS wallet could
  // land after the new wallet's, overwrite it, and strand the card on "Reading your
  // positions…" with nothing on screen able to read again. They bump this instead.
  const [readGen, setReadGen] = useState(0);
  const reread = () => setReadGen((n) => n + 1);
  // ⚠️ A READ THAT PREDATES A CONFIRMED WRITE. After someone's first stake, the
  // pre-stake read (complete, and empty) still satisfied `walletEmpty` until the re-read
  // landed, and the card said "No open positions" to a wallet that had just opened one.
  // True when it was read; stale now. The read on screen when a write CONFIRMS is held
  // here, and while it is still the one on screen the card says it is updating instead
  // of restating it. Identity, like `armed`: any newer read — this wallet's re-read, or
  // another wallet's — is not stale, and a failed write marks nothing.
  const [staleRead, setStaleRead] = useState<typeof walletRead>(null);
  const latestWalletRead = useRef(walletRead);
  useEffect(() => { latestWalletRead.current = walletRead; }, [walletRead]);
  // ⚠️ IDENTITY IS NOT RECENCY. `staleRead` only knows which read was on screen when a
  // write confirmed; ANY read landing after it counted as fresh — including one served by
  // an RPC node still at a slot BEFORE the write. After an exit the true share
  // (W-w)/(T-w) is below W/T, so that read over-read until the next 45s poll. So the
  // slot the write CONFIRMED at is held here, keyed to the wallet that wrote, and the
  // share basis is stale while its own slot is below it — or when either slot is
  // missing (fail closed; never the old figure).
  const [writeFence, setWriteFence] = useState<WriteFence | null>(null);

  // One tick a SECOND. Rewards accrue per second, and at a minute's cadence the only
  // way to watch your own balance move was to reload the page.
  //
  // This is a clock, not a fetch: nothing in this interval touches the network. It
  // drives the countdowns, the exit quotes, and the exact `earnedNow` figures the
  // buttons are gated on. The sub-second METER rides its own leaf component
  // (`LiveEarned`) so 60Hz smoothing re-renders one <span> instead of re-quoting
  // every position's three exit doors sixty times a second.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(t);
  }, []);

  const walletKey = publicKey?.toBase58() ?? '';
  const pool = poolRead?.ok ? poolRead.value : null;

  useEffect(() => {
    if (!config.ok) return;
    let cancelled = false;
    void readLadderPool(connection, config.programId, config.pool).then((r) => {
      if (!cancelled) setPoolRead(r);
    });
    if (publicKey) {
      const key = publicKey.toBase58();
      void readLadderWallet(connection, config.programId, config.pool, publicKey).then((r) => {
        if (!cancelled) setWalletRead({ key, result: r });
      });
    }
    return () => { cancelled = true; };
  }, [connection, config, publicKey, readGen]);

  // ── the only thing here that costs RPC ────────────────────────────────────
  // The meter above is pure arithmetic over fields we already hold, so it can run as
  // fast as it likes for free. But those fields do go stale: another staker entering
  // or leaving moves `totalWeighted`, and `notify_reward` moves the rate and the
  // window. Without a re-sync the meter would climb smoothly along a schedule that
  // stopped being true.
  //
  // COST: one `readLadderPool` every 45s, plus one `readLadderWallet` when a wallet is
  // connected — so 2 account reads a minute per open card at the outside, against the
  // 1 (or 2) this card used to do once and never again. Deliberately modest; the
  // figure is honest between re-syncs because it replays the program's own math, not
  // because it is fresh.
  //
  // ⚠️ NEVER WHILE A DOOR IS ARMED. `armed` below matches the arming against the exact
  // wallet read its row was drawn from, so a re-sync landing mid-decision would
  // silently DISARM a confirm the user is looking at — and a background timer must not
  // reach into a two-step confirmation that exists to protect someone's principal.
  // Same for an in-flight write, whose own completion re-reads anyway.
  useEffect(() => {
    if (!config.ok) return;
    if (confirmFor !== null || action?.busy) return;
    const t = setInterval(reread, 45_000);
    return () => clearInterval(t);
  }, [config, confirmFor, action?.busy]);

  // Vault balances need the pool's own vault addresses, so they ride their own effect.
  useEffect(() => {
    if (!pool) return;
    let cancelled = false;
    void readVaultBalances(connection, pool).then((v) => { if (!cancelled) setVaults(v); });
    return () => { cancelled = true; };
  }, [connection, pool, action?.sig]);

  // The wallet's own balance needs the pool's mint AND token program.
  useEffect(() => {
    if (!pool || !publicKey) return;
    let cancelled = false;
    const key = publicKey.toBase58();
    void readOwnerTokenBalance(connection, pool.mint, publicKey, pool.tokenProgram).then((raw) => {
      if (!cancelled) setBalance({ key, raw });
    });
    return () => { cancelled = true; };
  }, [connection, pool, publicKey, action?.sig]);

  /* ── derived, all of it null-safe ─────────────────────────────────────── */

  const walletView = walletKey && walletRead?.key === walletKey && walletRead.result.ok
    ? walletRead.result.value
    : null;
  const walletUnreadable = walletKey && walletRead?.key === walletKey && !walletRead.result.ok
    ? walletRead.result.reason
    : null;
  // ⚠️ THREE STATES, NOT TWO. "still reading", "read and it is null" and "read and
  // it is a number" are different things, and the first two rendered identically as a
  // bare dash until the full suite raced them apart. A reader who cannot tell a
  // pending read from a failed one has been told nothing by either.
  const balanceLoaded = Boolean(walletKey) && balance.key === walletKey;
  const walletRaw = balanceLoaded ? balance.raw : null;
  // The same three states for the positions read. Before it lands, `walletView` is
  // null exactly as it is for a wallet with nothing in it, and the card used to print
  // "0 / 20" and "No open positions" to someone whose money had simply not loaded yet.
  const walletLoaded = Boolean(walletKey) && walletRead?.key === walletKey;
  const armed = confirmFor !== null && confirmFor.read === walletRead ? confirmFor.door : null;
  const arm = (door: string | null) => setConfirmFor(door === null ? null : { read: walletRead, door });

  const decimals = pool?.decimals ?? bungalow.decimals ?? 6;
  const sym = bungalow.symbol;

  // ⚠️ PROVE THIS POOL STAKES THIS BUNGALOW'S TOKEN before any figure is trusted.
  // base58 is case-SENSITIVE, so no folding here. A mispasted address renders a
  // stranger pool's numbers under our symbol and points the stake button at a
  // stranger's token — the failure TF-035 caught on the Streamflow card.
  const identityMismatch = pool !== null && pool.mint !== (bungalow.address ?? '');

  const positions = useMemo(() => walletView?.open ?? [], [walletView]);
  // `stats === null` on a LOADED view is a real zero (never staked here); no view at
  // all is not a count of anything.
  const openCount = walletView ? (walletView.stats?.openPositions ?? 0) : null;
  const myPrincipal = walletView ? walletPrincipalRaw(walletView) : null;
  const carriedRaw = walletView?.stats?.rewardsCarriedRaw ?? null;
  // ⚠️ A READ CAN SUCCEED AND STILL BE PARTIAL. `truncated` means the scan stopped
  // before accounting for every open position, and `stats.openPositions` can count
  // positions the scan did not return. An empty `open` list is "you have none" ONLY
  // when neither is the case; otherwise the card says it could not fully read the
  // wallet, and never prints a zero (read.ts: a partial list presented as complete).
  const walletPartial = walletView !== null
    && (walletView.truncated || (openCount ?? 0) > positions.length);
  const walletStale = staleRead !== null && walletRead === staleRead;
  const readEmpty = walletView !== null && !walletPartial && openCount === 0 && positions.length === 0;
  // An empty read taken before a confirmed write is not restated as empty (see `staleRead`).
  const walletUpdating = readEmpty && walletStale;
  const walletEmpty = readEmpty && !walletStale;

  // Sum only over positions we could actually read. `null` when the wallet read
  // failed, so an outage never renders as "you have earned 0".
  const myEarned: bigint | null = useMemo(() => {
    if (!pool || !walletView) return null;
    return positions.reduce((a, p) => a + earnedNow(p, pool, nowSec), 0n);
  }, [pool, walletView, positions, nowSec]);

  // The same sum as a function of an arbitrary second, for the live meter. It is NOT
  // a second implementation: both go through `earnedNow`, so the meter cannot drift
  // from the figure the rest of the card is reasoning about. Null propagates —
  // an unread wallet still renders as an outage below, never as a moving zero.
  // Depends on the READS, never on `nowSec`, so a once-a-second re-render does not
  // tear down the meter's animation frame loop.
  const earnedAt = useMemo(() => {
    if (!pool || !walletView) return null;
    return (secs: number) => positions.reduce((a, p) => a + earnedNow(p, pool, secs), 0n);
  }, [pool, walletView, positions]);

  const amountRaw = toRaw(amount, decimals);
  const overBalance = amountRaw !== null && walletRaw !== null && amountRaw > walletRaw;
  // A verdict is only computed from counts that were READ, never from assumed zeros.
  const verdict = pool && amountRaw !== null && myPrincipal !== null && openCount !== null
    ? checkDeposit(pool, amountRaw, myPrincipal, lockSecs, openCount)
    : null;

  // ⚠️ NO APR, NO PERCENTAGE, ON PURPOSE. A per-token yield depends on who else is in
  // the pool and at what weight, on the window being refilled, and on the vault — none
  // of which the chain fixes. What it DOES fix is how many tokens the whole pool is
  // scheduled to receive per second, and until when. So the card shows exactly that,
  // and only while the window is open. An earlier "configured rate" annualised this and
  // divided by total principal rather than total weight, so it was not even the rate
  // its own note named.
  //
  // What IS allowed (2026-09-20): YOUR SHARE OF POOL WEIGHT — Σ your positions' weight
  // over `totalWeighted`, floored (`sharePct`). It is a present fact the chain fixes, not
  // a forecast. FORBIDDEN, and not to be added later: share × rewards per day, "your
  // daily earnings", or any annualisation of either. Those are yield promises.
  //
  // `rewardRunwaySecs` is null only when no rate has ever been set — `notify_reward`
  // refuses a zero rate — so null means NEVER FUNDED, and 0 means the window ENDED.
  // Those are different facts, and neither is a live stream.
  const runway = pool ? rewardRunwaySecs(pool, nowSec) : null;
  const rewardWindow: 'never' | 'ended' | 'live' = runway === null ? 'never' : runway > 0 ? 'live' : 'ended';
  const perDayRaw = pool && rewardWindow === 'live' ? pool.rewardRate * BigInt(DAY) : null;
  // Invariant I-11: below this total weight the accumulator does not move and the
  // interval is lost, not banked. Every admissible stake clears it, so in practice
  // this is "nobody is staked".
  const belowFloor = pool !== null && pool.totalWeighted < minWeightFloor(pool.minStakeRaw);

  const invoker = wallet?.adapter as SignerWalletAdapter | undefined;
  const canWrite = Boolean(invoker && publicKey && config.ok && pool && !identityMismatch && !action?.busy);

  const ctx: LadderWriteCtx | null = config.ok && pool && invoker
    ? { connection, invoker, programId: config.programId, pool: config.pool, poolAccounts: pool }
    : null;

  const run = async (label: string, fn: () => Promise<WriteResult>) => {
    setAction({ busy: label });
    setConfirmFor(null);
    const res = await fn();
    if (res.ok) {
      setStaleRead(latestWalletRead.current);
      // One more ask for the confirmed slot if the write had none; if it still has none,
      // the fence fails closed (stale until a later write carries a slot).
      const slot = slotOrNull(res.slot) ?? await confirmedSlotOf(connection, res.signature);
      setWriteFence({ key: walletKey, slot });
      setAction({ note: `${label} confirmed.`, sig: res.signature });
      setAmount('');
    } else {
      setAction({ note: res.reason, sig: res.signature });
    }
    reread();
  };

  /* ── render ───────────────────────────────────────────────────────────── */

  // ── THE INSTRUMENT (2026-09-20) ───────────────────────────────────────────
  // One racing meter, one real staircase, one quiet ledger — in that order: see what
  // you are earning, climb a rung, act; the pool's context closes the card. The five
  // translucent stat tiles this replaces were too narrow for their own numbers, so
  // labels wrapped into their values and units fell onto their own lines. Every
  // figure and every sentence they carried is still here; only the location moved.
  //
  // Surfaces are SOLID (0.92-0.94) so the numbers read; the card's outer scrim is
  // unchanged, so the island's art still shows around and between the panels.

  const myWeight = walletView ? positions.reduce((a, p) => a + p.weight, 0n) : null;
  // ⚠️ SLOT-CONSISTENT, OR NOTHING. The share's inputs are `shareBasis` — the wallet's
  // weight and the pool's total read in ONE call, so from one slot (read.ts has why a
  // slot-ORDER check is not enough: it passes an exit's stale pair). Dividing this
  // wallet read by the separately-read pool total is what printed 20% for a true 18.2%.
  //
  // The separate pool read still BOUNDS it: both readings go through `sharePct` (floor,
  // refuse on mine > total, on a zero total, on a partial list) and the LOWER is shown.
  // A fresher, larger total — others staked since — can only make the share smaller, so
  // it wins; an older, smaller one loses to the basis; one smaller than your own weight
  // means the two reads disagree, and the figure is refused. Never the larger reading.
  //
  // PARTIAL means `walletPartial`, not just `truncated`: a list short of
  // `openPositions` is a partial sum even when the scan did not hit its bound. And a
  // read that predates a confirmed write of yours shows no share until the re-read lands.
  const shareBasis = walletView?.shareBasis ?? null;
  // A basis older than your own confirmed write (see `writeFence`), or one whose slot —
  // or the write's — is unknown, is "updating…", never a share.
  // (No basis at all already prints no share, and says why.)
  // The rule is shared with the lighthouse card (lib/ladder/writeFence.ts).
  const shareStale = shareBasis !== null && basisBehindWrite(writeFence, walletKey, shareBasis.slot);
  const share = (() => {
    if (!pool || !walletView || !shareBasis || walletStale || shareStale) return null;
    const own = sharePct({ mineWeight: shareBasis.mineWeight, totalWeighted: shareBasis.totalWeighted, truncated: walletPartial });
    const bound = sharePct({ mineWeight: shareBasis.mineWeight, totalWeighted: pool.totalWeighted, truncated: walletPartial });
    if (!own || !bound) return null;
    return own.pct <= bound.pct
      ? { ...own, mineWeight: shareBasis.mineWeight, totalWeighted: shareBasis.totalWeighted }
      : { ...bound, mineWeight: shareBasis.mineWeight, totalWeighted: pool.totalWeighted };
  })();
  // Hidden, not zeroed, when there is nothing to state: no weight of yours, or a pool
  // below its floor (where the accumulator does not move and a share decides nothing).
  const showShare = walletView !== null && !belowFloor && myWeight !== null && myWeight > 0n;
  const youLoaded = Boolean(publicKey) && !walletUnreadable && walletLoaded && walletView !== null;

  // The chip EXPLAINS the meter; it never drives it. The meter freezing is the math
  // freezing (lib/ladder/meter.ts, STOPPING) — this only says why.
  const accrualChip: { text: string; live: boolean } | null = !pool ? null
    : rewardWindow === 'ended' ? { text: `paused · reward window ended ${dateOf(pool.periodFinish)}`, live: false }
    : rewardWindow === 'never' ? { text: 'not accruing · no reward window scheduled', live: false }
    : belowFloor ? { text: 'not accruing · pool below its weight floor', live: false }
    : myWeight !== null && myWeight > 0n ? { text: 'accruing', live: true }
    : null;
  // A claim pays min(owed, reward vault) — so when more is owed than the vault holds,
  // the card says so beside the figure rather than let "earned" read as "claimable".
  const vaultShort = myEarned !== null && vaults?.rewardRaw != null && myEarned > vaults.rewardRaw;

  const selectedIdx = RUNGS.indexOf(lockSecs);
  const maxBps = boostBpsForLock(MAX_LOCK_SECS);

  const minStakeFact = (
    <Fact
      inline
      label="Minimum stake"
      value={pool ? fmtRaw(pool.minStakeRaw, decimals) : '–'}
      unit={sym}
      describedBy={`${fid}-min`}
    />
  );

  return (
    <Reveal>
    <div className="relative overflow-hidden rounded-2xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
      <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.52)' }} />
      <div className="relative z-10 p-5 sm:p-6 flex flex-col gap-6">
        <header>
          <p className="text-[11px] uppercase tracking-[0.14em] mb-3 m-0" style={{ color: 'var(--color-kyle)', fontFamily: HEAD }}>
            The lock ladder · LIVE
          </p>
          <h2 className="heading-luxury text-xl sm:text-2xl text-white mb-3">
            Lock {sym}, earn a weighted share
          </h2>
          {/* Owner-mandated disclosure. Every rule on this card is what the DEPLOYED
              program enforces; the upgrade authority can change any of it. */}
          {config.ok && (
            <p className="text-[12px] leading-relaxed m-0 max-w-2xl" style={{ color: 'rgba(255,255,255,0.72)' }}>
              A position keeps its full weight after its lock opens, for as long as it stays in the pool.
              The program can be upgraded by its upgrade authority, and a future upgrade may reset matured positions
              to the {boostLabel(MIN_BOOST_BPS)} base weight. Everything on this card describes the program
              as deployed today.
            </p>
          )}
        </header>

        {!config.ok && (
          <p role="alert" className="text-[13px] rounded-lg p-3 m-0" style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5' }}>
            {config.reason}
          </p>
        )}

        {config.ok && poolRead === null && (
          <p className="text-white/70 text-[13px] m-0">Reading the pool…</p>
        )}

        {config.ok && poolRead && !poolRead.ok && (
          <p role="alert" className="text-[13px] m-0" style={{ color: '#f0b26b' }}>{poolRead.reason}</p>
        )}

        {identityMismatch && pool && (
          <p role="alert" className="text-[13px] rounded-lg p-3 m-0" style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5' }}>
            This pool does not stake {sym} — it reports {pool.mint.slice(0, 6)}…{pool.mint.slice(-4)} as its
            staking mint. That is a configuration error, not a network problem, so no figures are shown and
            nothing here will send a transaction.
          </p>
        )}

        {pool && !identityMismatch && (
          <>
            {pool.degraded && (
              <p role="alert" className="text-[13px] rounded-lg p-3 m-0" style={{ background: 'rgba(240,178,107,0.10)', border: '1px solid rgba(240,178,107,0.4)', color: '#f0b26b' }}>
                <strong>This pool has been declared degraded.</strong> It takes no new stakes. Every open
                position still exits, and while it is degraded neither early exit nor the emergency hatch
                charges any penalty — that is what the flag is for. The deployed program has no instruction
                to switch it back.
              </p>
            )}

            {/* ── 1. THE METER, and you in this pool ────────────────────── */}
            <section aria-label="Your earnings" className="@container">
              <div className="grid grid-cols-1 gap-4 @min-[52rem]:grid-cols-12">
                <div
                  className={`@container relative overflow-hidden rounded-[14px] p-5 sm:p-6 min-w-0 flex flex-col gap-3 ${youLoaded ? '@min-[52rem]:col-span-7' : '@min-[52rem]:col-span-12'}`}
                  style={{
                    background: `radial-gradient(60% 80% at 0% 0%, var(--color-kyle-12), transparent), ${PANEL_BG}`,
                    border: `1px solid ${HAIR}`,
                  }}
                >
                  {!publicKey ? (
                    <>
                      <p className="m-0 text-white" style={{ fontFamily: HEAD, fontWeight: 700, fontSize: 'clamp(1.5rem, 6cqi, 2.75rem)', lineHeight: 1.1 }}>
                        Your meter starts when you lock.
                      </p>
                      <div>
                        <button type="button" onClick={openConnect} className="btn-primary px-6 py-2.5 text-[13px]">
                          Connect a Solana wallet
                        </button>
                      </div>
                    </>
                  ) : walletUnreadable ? (
                    <p role="alert" className="text-[13px] rounded-lg p-3 m-0" style={{ background: 'rgba(240,178,107,0.10)', border: '1px solid rgba(240,178,107,0.4)', color: '#f0b26b' }}>
                      {walletUnreadable} Nothing is shown below rather than a zero, because a read that did not land
                      is not the same as an empty position.{' '}
                      <button type="button" onClick={reread} className="underline underline-offset-2">Try again</button>
                    </p>
                  ) : !walletLoaded ? (
                    <p role="status" className="text-white/70 text-[16px] m-0">Reading your positions…</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3">
                        <p className="m-0 row-start-1 col-start-1 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--color-kyle)', fontFamily: HEAD }}>
                          Earned, unclaimed
                        </p>
                        {walletUpdating ? (
                          <p role="status" className="m-0 row-start-2 col-span-2 text-[16px] text-white/70">
                            Updating your positions…
                          </p>
                        ) : walletEmpty ? (
                          <p className="m-0 row-start-2 col-span-2 flex items-baseline gap-[0.3em] whitespace-nowrap" style={DIGITS}>
                            <span style={{ color: 'rgba(255,255,255,0.5)' }}>0</span>
                            <span style={UNIT_HERO}>{sym}</span>
                          </p>
                        ) : positions.length === 0 ? (
                          <p className="m-0 row-start-2 col-span-2 text-[16px]" style={{ color: '#f0b26b' }}>
                            could not be fully read
                          </p>
                        ) : (
                          <HeroDigits earnedAt={earnedAt} exactRaw={myEarned} decimals={decimals} sym={sym} />
                        )}
                        {accrualChip && (
                          <span
                            className="row-start-3 col-span-2 justify-self-start @min-[30rem]:row-start-1 @min-[30rem]:col-start-2 @min-[30rem]:col-span-1 @min-[30rem]:justify-self-end inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px]"
                            style={{
                              background: accrualChip.live ? 'var(--color-kyle-12)' : 'rgba(255,255,255,0.06)',
                              border: `1px solid ${accrualChip.live ? 'var(--color-kyle-40)' : 'rgba(255,255,255,0.12)'}`,
                              color: accrualChip.live ? 'var(--color-kyle-bright)' : 'rgba(255,255,255,0.78)',
                            }}
                          >
                            {accrualChip.live && <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: 'var(--color-kyle)' }} />}
                            {accrualChip.text}
                          </span>
                        )}
                      </div>
                      {walletUpdating ? (
                        <p className="m-0 text-[12px]" style={{ color: 'rgba(255,255,255,0.72)' }}>
                          Confirmed — reading your positions back.
                        </p>
                      ) : walletEmpty ? (
                        <p className="m-0 text-[12px]" style={{ color: 'rgba(255,255,255,0.72)' }}>
                          No open positions — pick a rung below to start one.
                        </p>
                      ) : positions.length === 0 ? (
                        <p role="alert" className="m-0 text-[12px]" style={{ color: '#f0b26b' }}>
                          This wallet has {openCount ?? 'some'} open {openCount === 1 ? 'position' : 'positions'} this view
                          could not read, so no figure is shown rather than a zero.{' '}
                          <button type="button" onClick={reread} className="underline underline-offset-2">Try again</button>
                        </p>
                      ) : (
                        <p className="m-0 text-[12px]" style={{ color: 'rgba(255,255,255,0.72)' }}>
                          {fmtRaw(myPrincipal, decimals)} {sym} staked across {openCount ?? positions.length}{' '}
                          {(openCount ?? positions.length) === 1 ? 'position' : 'positions'}
                        </p>
                      )}
                      {walletPartial && positions.length > 0 && (
                        <p className="m-0 text-[12px]" style={{ color: '#f0b26b' }}>
                          This figure covers only the positions this view could read; the wallet has more.
                        </p>
                      )}
                      {vaultShort && vaults && (
                        <p className="m-0 text-[12px]" style={{ color: '#f0b26b' }}>
                          The reward vault holds {fmtRaw(vaults.rewardRaw, decimals)} {sym}; a claim pays up to that and the
                          rest stays owed to you.
                        </p>
                      )}
                    </>
                  )}
                </div>

                {youLoaded && (
                  <m.div
                    variants={staggerContainer(0.06)}
                    initial="hidden"
                    whileInView="show"
                    viewport={{ once: true }}
                    className="@container rounded-[14px] p-5 sm:p-6 min-w-0 flex flex-col gap-4 @min-[52rem]:col-span-5"
                    style={{ background: LEDGER_BG, border: `1px solid ${HAIR}` }}
                  >
                    <p className="m-0 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'rgba(255,255,255,0.7)', fontFamily: HEAD }}>
                      You in this pool
                    </p>
                    {/* ⚠️ A SHARE OF WEIGHT, NOT A YIELD. It is what the chain fixes
                        about you today. Never multiplied by the rewards rate, never
                        annualised — see the NO APR note above. */}
                    {showShare && (
                      <m.div variants={staggerItem}>
                        <p className="m-0 mb-1.5 text-[11px] uppercase tracking-[0.12em]" style={{ color: 'rgba(76,175,80,0.9)', fontFamily: HEAD }}>
                          Your share of pool weight
                        </p>
                        {share ? (
                          <p className="m-0 text-white tabular-nums" style={{ fontFamily: MONO, fontWeight: 600, fontSize: 28, lineHeight: 1.1 }}>
                            {share.label}
                          </p>
                        ) : (
                          <p className="m-0 text-[13px]" style={{ color: '#f0b26b' }}>
                            {walletStale || shareStale ? 'updating…' : walletPartial ? 'could not be fully read' : 'could not be read'}
                          </p>
                        )}
                        {share && (
                          <>
                            <div aria-hidden="true" className="mt-2.5 h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                              <div className="h-full rounded-full" style={{ width: `${share.pct}%`, minWidth: share.pct === 0 ? 2 : undefined, background: 'var(--color-kyle)' }} />
                            </div>
                            <p className="m-0 mt-2 text-[11px] tabular-nums" style={{ color: 'rgba(255,255,255,0.62)' }}>
                              weight {fmtRaw(share.mineWeight, decimals)} of {fmtRaw(share.totalWeighted, decimals)}
                            </p>
                          </>
                        )}
                      </m.div>
                    )}
                    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-[10px] @min-[40rem]:grid-cols-3" style={{ background: DIVIDED_BG, border: `1px solid ${HAIR}` }}>
                      <Fact at="40rem" label="Your principal" value={fmtRaw(myPrincipal, decimals)} unit={sym} />
                      <Fact
                        at="40rem"
                        label="In your wallet"
                        value={!balanceLoaded ? '…' : fmtRaw(walletRaw, decimals)}
                        unit={sym}
                        state={!balanceLoaded ? 'reading…' : walletRaw === null ? 'could not be read' : undefined}
                      />
                      <Fact at="40rem" label="Open positions" value={walletUpdating ? '…' : openCount === null ? '–' : `${openCount} / ${MAX_POSITIONS}`} />
                    </div>
                  </m.div>
                )}
              </div>
            </section>

            {/* ── 2. THE STAIRCASE, and the action rail ─────────────────── */}
            {/* Visible WITHOUT a wallet: anyone can climb the ladder and see what each
                rung weighs before deciding to connect. The amount, the verdict and
                the Lock button still render only for a read wallet. */}
            <section aria-label="Open a position" className="@container rounded-[14px] px-3 py-5 sm:p-6" style={{ background: PANEL_BG, border: `1px solid ${HAIR}` }}>
              <div className="grid grid-cols-1 gap-6 @min-[52rem]:grid-cols-12">
                <div className="min-w-0 @min-[52rem]:col-span-7">
                  <p className="text-[12px] mb-3 m-0" style={{ color: 'rgba(255,255,255,0.78)' }} id="ladder-rungs-label">
                    Lock length — a longer lock carries more weight, and weight is what decides your share.
                  </p>
                  {/* TAP TARGETS (2026-09-21): seven rungs across a phone came out 40px
                      wide at 393px, under the 44px floor. On a narrow panel the rungs
                      sit flush (gap-0) and bleed 10px into the panel's padding
                      (-mx-2.5); the bars keep their visual gap from the button's own
                      3px padding. The weight label is tracked in slightly so "4.00×"
                      stays inside its rung at 320px, where it overlapped by 1.3px; self-center
                      centres it even when it is wider than the content box. */}
                  <div role="group" aria-labelledby="ladder-rungs-label" className="grid grid-cols-7 gap-0 -mx-2.5 @min-[30rem]:mx-0 @min-[30rem]:gap-1.5 h-[116px] @min-[30rem]:h-[132px] @min-[52rem]:h-[148px]">
                    {RUNGS.map((secs, i) => {
                      const on = secs === lockSecs;
                      const bps = boostBpsForLock(secs);
                      const climbed = selectedIdx >= 0 && i < selectedIdx;
                      return (
                        <m.button
                          key={secs}
                          type="button"
                          aria-pressed={on}
                          aria-label={`${lockLabel(secs)} lock, ${boostLabel(bps)} weight`}
                          onClick={() => setLockSecs(secs)}
                          whileTap={pressTap}
                          className="flex h-full min-w-0 flex-col items-stretch justify-end gap-1.5 rounded-lg px-[3px] pt-1.5 pb-1.5 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-kyle)]"
                          style={{ background: on ? 'rgba(76,175,80,0.07)' : 'transparent' }}
                        >
                          <span aria-hidden="true" className="self-center text-center text-[11px] tabular-nums leading-none tracking-[-0.03em] whitespace-nowrap" style={{ fontFamily: MONO, color: on ? '#fff' : 'rgba(255,255,255,0.66)' }}>
                            {boostLabel(bps)}
                          </span>
                          <span aria-hidden="true" className="relative flex flex-1 items-end">
                            <m.span
                              key={on ? 'on' : 'off'}
                              initial={on ? { scaleY: 0.96 } : false}
                              animate={{ scaleY: 1 }}
                              transition={{ duration: DUR.fast, ease: EASE_OUT }}
                              className="block w-full rounded-t-[5px]"
                              style={{
                                height: `${Math.max(4, (bps / maxBps) * 100)}%`,
                                transformOrigin: 'bottom',
                                background: on
                                  ? 'linear-gradient(180deg, var(--color-kyle), var(--color-primary))'
                                  : climbed ? 'var(--color-purple-40)' : 'rgba(139,92,246,0.18)',
                                boxShadow: on
                                  ? 'inset 0 2px 0 var(--color-kyle), 0 0 18px rgba(76,175,80,0.25)'
                                  : 'inset 0 1px 0 var(--color-purple-40)',
                              }}
                            />
                          </span>
                          <span aria-hidden="true" className="text-center text-[12px] leading-none" style={{ fontFamily: HEAD, fontWeight: 600, color: on ? '#fff' : 'rgba(255,255,255,0.72)' }}>
                            {lockLabel(secs)}
                          </span>
                        </m.button>
                      );
                    })}
                  </div>
                  <div className="mt-2 pt-2 flex justify-end" style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                    <p className="m-0 text-[11px] text-right" style={{ color: 'rgba(255,255,255,0.62)' }}>
                      weight grows with lock length · capped at {MAX_LOCK_SECS / (365 * DAY)} years
                    </p>
                  </div>
                </div>

                {/* ── the action rail ──────────────────────────────────── */}
                <div className="min-w-0 @min-[52rem]:col-span-5">
                  {!publicKey ? (
                    <div className="flex flex-col gap-4">
                      {minStakeFact}
                      <button type="button" onClick={openConnect} className="btn-primary w-full px-6 py-2.5 text-[13px]">
                        Connect to lock for {lockLabel(lockSecs)}
                      </button>
                    </div>
                  ) : !youLoaded ? (
                    <div className="flex flex-col gap-3">
                      {minStakeFact}
                      <p className="m-0 text-[12px]" style={{ color: 'rgba(255,255,255,0.62)' }}>
                        The stake form opens once your positions have been read.
                      </p>
                    </div>
                  ) : (
                    <fieldset className="m-0 p-0 border-0 min-w-0 flex flex-col gap-3">
                      <legend className="sr-only">Open a position</legend>
                      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
                        <label htmlFor="ladder-amount" className="block text-[11px] uppercase tracking-[0.12em]" style={{ color: 'rgba(76,175,80,0.9)', fontFamily: HEAD }}>Amount</label>
                        {minStakeFact}
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          id="ladder-amount"
                          inputMode="decimal"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          placeholder="0.0"
                          className="flex-1 min-w-0 rounded-lg px-3 py-2.5 text-white text-[15px]"
                          style={{ fontFamily: MONO, background: 'rgba(0,0,0,0.6)', border: '1px solid var(--color-purple-25)' }}
                        />
                        <button
                          type="button"
                          // MAX comes from the PLAIN string, never from the grouped
                          // display — see format.ts. The grouped form under-stakes by
                          // 1000x in any dot-grouping locale.
                          disabled={walletRaw === null}
                          onClick={() => walletRaw !== null && setAmount(toPlain(walletRaw, decimals))}
                          className="btn-secondary px-3 py-2.5 text-[12px] disabled:opacity-40"
                        >
                          Max
                        </button>
                      </div>

                      {amountRaw !== null && amountRaw > 0n && (
                        <>
                          <ul className="list-none m-0 p-0 flex flex-wrap gap-1.5" aria-label="This lock at a glance">
                            <li className={CHIP} style={CHIP_STYLE}>Unlocks {dateOf(BigInt(nowSec + lockSecs))}</li>
                            <li className={CHIP} style={CHIP_STYLE}>Weight {fmtRaw(weightForStake(amountRaw, lockSecs), decimals)}</li>
                            {!pool.degraded && (
                              <li className={CHIP} style={CHIP_STYLE}>
                                Leave now −{penaltyPct(penaltyFor(amountRaw, BigInt(lockSecs), 0n), amountRaw)}
                              </li>
                            )}
                          </ul>
                          <p className="text-[12px] m-0" style={{ color: 'rgba(255,255,255,0.72)' }}>
                            This would carry a weight of{' '}
                            <strong className="text-white">{fmtRaw(weightForStake(amountRaw, lockSecs), decimals)}</strong>{' '}
                            and unlock in {humanDuration(lockSecs)}.{' '}
                            {pool.degraded
                              ? 'While the pool is degraded it accepts no new stakes.'
                              : `Leaving straight away would forfeit ${penaltyPct(penaltyFor(amountRaw, BigInt(lockSecs), 0n), amountRaw)} of the principal; the penalty is the time left on the lock over four years, capped at ${MAX_EARLY_EXIT_PENALTY_BPS / 100}%, so it shrinks as the lock runs down.`}
                          </p>
                        </>
                      )}

                      {verdict && !verdict.allowed && (
                        <p role="alert" className="text-[12px] m-0" style={{ color: '#f0b26b' }}>{verdict.reason}</p>
                      )}
                      {overBalance && (
                        <p role="alert" className="text-[12px] m-0" style={{ color: '#f0b26b' }}>
                          That is more {sym} than this wallet holds.
                        </p>
                      )}

                      <button
                        type="button"
                        disabled={
                          !canWrite || !ctx || !walletView
                          || amountRaw === null || amountRaw <= 0n
                          || overBalance || !verdict?.allowed
                        }
                        onClick={() => {
                          if (!ctx || !walletView || amountRaw === null) return;
                          void run('Stake', () => ladderStake(ctx, {
                            // Read fresh from UserStats: the program derives the position
                            // account from this, so a stale value addresses one that
                            // already exists and the transaction fails.
                            positionNonce: nextPositionNonce(walletView),
                            amountRaw,
                            lockSecs,
                          }));
                        }}
                        className="btn-primary w-full px-6 py-3 text-[13px] disabled:opacity-40"
                      >
                        {action?.busy === 'Stake' ? 'Staking…' : `Lock ${sym} for ${lockLabel(lockSecs)}`}
                      </button>
                    </fieldset>
                  )}
                </div>
              </div>
            </section>

            {youLoaded && (
              <>
                {/* Carried rewards are real money in a field. A UI that never shows
                    them hides a balance the program deliberately preserved: the hatch
                    carries accrual, and either exit door carries what a short reward
                    vault could not pay (lib.rs `exit_with_penalty`). */}
                {carriedRaw !== null && carriedRaw > 0n && (
                  <div className="rounded-[14px] p-4 flex flex-wrap items-center justify-between gap-3"
                    style={{ background: LEDGER_BG, border: '1px solid var(--color-kyle-40)' }}>
                    <p className="text-white/85 text-[13px] m-0">
                      <strong>{fmtRaw(carriedRaw, decimals)} {sym}</strong> carried from a closed position —
                      rewards the reward vault could not cover when it closed, or that the emergency hatch set
                      aside. They are still yours.
                    </p>
                    <button type="button" disabled={!canWrite || !ctx}
                      onClick={() => ctx && void run('Claim carried', () => ladderClaimCarried(ctx))}
                      className="btn-secondary px-4 py-2.5 text-[12px] disabled:opacity-50">
                      Claim carried
                    </button>
                  </div>
                )}

                {/* ── open positions ───────────────────────────────────── */}
                <section aria-label="Your positions" className="flex flex-col gap-3">
                  <p className="m-0 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'rgba(255,255,255,0.7)', fontFamily: HEAD }}>
                    Your positions
                  </p>
                  {walletView?.truncated && (
                    <p role="alert" className="text-[12px] m-0" style={{ color: '#f0b26b' }}>
                      This wallet has more positions than one read could cover, so the list below is partial.
                      Nothing is missing from your account — only from this view.
                    </p>
                  )}

                  {walletUpdating ? (
                    <p role="status" className="text-white/60 text-[13px] m-0">Updating your positions…</p>
                  ) : walletEmpty ? (
                    <p className="text-white/60 text-[13px] m-0">No open positions in this pool.</p>
                  ) : positions.length === 0 ? (
                    <p className="text-[13px] m-0" style={{ color: '#f0b26b' }}>
                      Your open positions could not be fully read, so none are listed — this is not an empty wallet.
                    </p>
                  ) : (
                    <ul className="space-y-3 list-none p-0 m-0">
                      {positions.map((p) => (
                        <PositionRow
                          key={p.nonce}
                          position={p}
                          pool={pool}
                          nowSec={nowSec}
                          decimals={decimals}
                          sym={sym}
                          busy={action?.busy}
                          canWrite={canWrite && Boolean(ctx)}
                          confirmFor={armed}
                          setConfirmFor={arm}
                          onClaim={() => ctx && void run('Claim', () => ladderClaim(ctx, { positionNonce: p.nonce }))}
                          onExit={(early) => ctx && void run(early ? 'Early exit' : 'Withdraw', () => ladderExit(ctx, { positionNonce: p.nonce, early }))}
                          onHatch={() => ctx && void run('Emergency withdraw', () => ladderHatch(ctx, { positionNonce: p.nonce }))}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              </>
            )}

            {/* ── 3. THE LEDGER — the numbers that decide whether to stake ─── */}
            {/* One solid panel with hairline dividers, not five translucent boxes.
                Columns come from the LEDGER's own width (container query), never the
                viewport: list rows on a phone, 2×2 on an iPad, four across on a
                desktop. Helper sentences live in the footnotes below, word for word,
                always visible, and each cell points at its own with
                aria-describedby. */}
            <section data-ledger aria-label="The pool" className="@container flex flex-col gap-3">
              <p className="m-0 text-[11px] uppercase tracking-[0.14em]" style={{ color: 'rgba(255,255,255,0.7)', fontFamily: HEAD }}>
                The pool
              </p>
              <m.div
                variants={staggerContainer(0.06)}
                initial="hidden"
                whileInView="show"
                viewport={{ once: true }}
                className="grid grid-cols-1 gap-px overflow-hidden rounded-[14px] @min-[30rem]:grid-cols-2 @min-[52rem]:grid-cols-4"
                style={{ background: DIVIDED_BG, border: `1px solid ${HAIR}` }}
              >
                <Fact
                  label="Reward vault"
                  value={vaults === null ? '…' : fmtRaw(vaults.rewardRaw, decimals)}
                  unit={sym}
                  state={vaults === null ? 'reading…' : vaults.rewardRaw === null ? 'could not be read' : undefined}
                />
                <Fact label={`${sym} locked here`} value={fmtRaw(pool.totalPrincipalRaw, decimals)} unit={sym} />
                {rewardWindow === 'live' ? (
                  <>
                    <Fact label="Rewards per day" value={fmtRaw(perDayRaw, decimals)} unit={sym} describedBy={`${fid}-perday`} />
                    <Fact label="Funded through" value={dateOf(pool.periodFinish)} describedBy={`${fid}-funded`} />
                  </>
                ) : (
                  <Fact span2 label="Reward window" value={rewardWindow === 'ended' ? 'ended' : 'not started'} describedBy={`${fid}-window`} />
                )}
              </m.div>
              <ul className="list-none m-0 p-0 flex flex-col gap-1 text-[11.5px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.62)' }}>
                {rewardWindow === 'live' ? (
                  <>
                    <li id={`${fid}-perday`}>
                      <strong className="font-semibold" style={{ color: '#fff' }}>Rewards per day —</strong>{' '}
                      {belowFloor
                        ? 'scheduled, but nothing accrues while no one is staked, and that time is not paid out later'
                        : 'to all stakers combined, split by weight'}.
                    </li>
                    <li id={`${fid}-funded`}>
                      <strong className="font-semibold" style={{ color: '#fff' }}>Funded through —</strong>{' '}
                      the current reward window closes in {humanDuration(runway ?? 0)}.
                    </li>
                  </>
                ) : (
                  <li id={`${fid}-window`}>
                    <strong className="font-semibold" style={{ color: '#fff' }}>Reward window —</strong>{' '}
                    {rewardWindow === 'ended'
                      ? `closed ${dateOf(pool.periodFinish)} — no new rewards are accruing`
                      : 'no reward window has ever been scheduled — no rewards are accruing'}.
                  </li>
                )}
                <li id={`${fid}-min`}>
                  <strong className="font-semibold" style={{ color: '#fff' }}>Minimum stake —</strong>{' '}
                  the deployed program has no setter for it.
                </li>
              </ul>
            </section>

            {action?.note && (
              <p role="status" className="text-[12px] m-0 rounded-lg p-3" style={{ background: LEDGER_BG, border: '1px solid var(--color-purple-25)', color: 'rgba(255,255,255,0.85)' }}>
                {action.note}
                {action.sig && (
                  <>
                    {' '}
                    <a
                      href={`https://solscan.io/tx/${action.sig}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="View this transaction on Solscan (opens in new tab)"
                      className="underline underline-offset-2"
                    >
                      {action.sig.slice(0, 8)}…{action.sig.slice(-8)} ↗
                    </a>
                  </>
                )}
              </p>
            )}
          </>
        )}
      </div>
    </div>
    </Reveal>
  );
}

/* ── the instrument's shared surfaces ───────────────────────────────────── */

const MONO = 'var(--font-family-mono)';
const CHIP = 'rounded-full px-2.5 py-1 text-[11px] tabular-nums';
const CHIP_STYLE = { background: 'rgba(139,92,246,0.12)', border: '1px solid var(--color-purple-25)', color: 'rgba(255,255,255,0.9)' } as const;

const DIGITS = {
  fontFamily: MONO,
  fontWeight: 600,
  fontSize: 'clamp(1.75rem, 9cqi, 4.5rem)',
  letterSpacing: '-0.02em',
  lineHeight: 1,
  fontVariantNumeric: 'tabular-nums slashed-zero',
} as const;
/** The meter's unit: on the digits' baseline, subordinate, never under the 11px floor. */
const UNIT_HERO = {
  fontFamily: HEAD,
  fontWeight: 600,
  fontSize: 'max(11px, 0.28em)',
  letterSpacing: '0.06em',
  color: 'var(--color-kyle)',
} as const;

/**
 * THE HERO METER — the live figure, as its own leaf.
 *
 * It prints `useAccrualMeter(earnedAt)` and NOTHING ELSE: that is `smoothedRaw`, which
 * interpolates the TRAILING second and floors (lib/ladder/meter.ts, invariant I), so it
 * can never read higher than what is owed at that instant. `fmtRawParts` truncates. No
 * spring, no tween, no forward easing — the movement is the value changing, and every
 * gate on this card (Claim above all) keeps using the exact `earnedNow` figure.
 *
 * ⚠️ A LEAF ON PURPOSE, like `LiveEarned`: it re-renders at up to 60Hz, and owned by the
 * card that would re-quote every position's exit doors sixty times a second.
 *
 * Screen readers: the racing digits are aria-hidden. The sr-only sibling carries the
 * EXACT once-a-second figure with no aria-live, so it is never announced but is always
 * current when someone navigates to it. Its parent panel is `relative`, so the sr-only
 * box cannot escape it and widen the page.
 *
 * Two tones, one colour family: the whole part and first two decimals in white, the
 * rest of the token's precision dimmed. Fixed width (the fraction is padded), so the
 * line never jitters as the last digit climbs.
 */
function HeroDigits(
  { earnedAt, exactRaw, decimals, sym }:
  { earnedAt: ((secs: number) => bigint) | null; exactRaw: bigint | null; decimals: number; sym: string },
) {
  const live = useAccrualMeter(earnedAt);
  const parts = fmtRawParts(live ?? exactRaw, decimals, decimals);
  return (
    <p className="m-0 row-start-2 col-span-2 flex items-baseline gap-[0.3em] whitespace-nowrap min-w-0" style={DIGITS}>
      <span aria-hidden="true">
        {parts === null ? '–' : (
          <>
            <span style={{ color: '#fff' }}>{parts.whole}{parts.frac ? `.${parts.frac.slice(0, 2)}` : ''}</span>
            {parts.frac.length > 2 && <span style={{ color: 'rgba(255,255,255,0.5)' }}>{parts.frac.slice(2)}</span>}
          </>
        )}
      </span>
      <span aria-hidden="true" style={UNIT_HERO}>{sym}</span>
      <span className="sr-only">
        {`Earned, unclaimed: ${exactRaw === null ? 'could not be read' : `${fmtRaw(exactRaw, decimals, decimals)} ${sym}`}`}
      </span>
    </p>
  );
}

/**
 * The live meter on a position row, as its own leaf.
 *
 * ⚠️ IT IS A LEAF ON PURPOSE. Smoothing re-renders whatever component owns it at up
 * to 60Hz. Owned by the card, that would re-run `quoteExit` on every position sixty
 * times a second for a number that is only being printed. Owned here, sixty renders a
 * second is one <span> of text.
 *
 * The digits go to FULL token precision rather than the card's usual two. At the live
 * BAYLA schedule a 20,000 stake earns about 0.0053 BAYLA a second, so at two decimals
 * the display would change roughly every three minutes — technically live and, to
 * anyone watching it, indistinguishable from the frozen number this replaces.
 *
 * `fallback` is the exact, un-smoothed figure. It renders for the first paint and
 * whenever there is no meter to run, so this can never be the reason a value appears.
 *
 * ⚠️ RETURNS A BARE STRING, NOT A <span>. Two reasons, and the first is not cosmetic:
 * Testing Library's `getNodeText` joins only an element's DIRECT text-node children,
 * so wrapping the figure moves it out of its parent's matchable text — the existing
 * suite's "a pool emitting nothing shows a real, labelled zero" pin, which reads
 * `/0 BAYLA earned/` off the position row, stops seeing the zero. A meter is not
 * worth weakening the pin that says a real zero is still printed. Second, no wrapper
 * means no new element for a screen reader to treat as a region; the figure changes
 * up to sixty times a second and must never be announced.
 */
function LiveEarned(
  { earnedAt, fallback, decimals }:
  { earnedAt: ((secs: number) => bigint) | null; fallback: string; decimals: number },
) {
  const raw = useAccrualMeter(earnedAt);
  return <>{raw === null ? fallback : fmtRaw(raw, decimals, decimals)}</>;
}

/**
 * One position, and the price of every way out of it.
 *
 * ⚠️ THE HATCH ROW IS THE WHOLE POINT OF THIS COMPONENT. `quoteExit()` prices all
 * three doors against the live pool, so the penalty the hatch charges while locked is on
 * the button rather than in a footnote — and it becomes "no penalty" by itself the
 * moment the position matures or the pool is degraded, because the quote is computed,
 * not written down.
 */
function PositionRow({
  position, pool, nowSec, decimals, sym, busy, canWrite, confirmFor, setConfirmFor,
  onClaim, onExit, onHatch,
}: {
  position: LadderPositionView;
  pool: LadderPoolView;
  nowSec: number;
  decimals: number;
  sym: string;
  busy?: string;
  canWrite: boolean;
  confirmFor: string | null;
  setConfirmFor: (v: string | null) => void;
  onClaim: () => void;
  onExit: (early: boolean) => void;
  onHatch: () => void;
}) {
  const quotes = quoteExit(position, pool, nowSec);
  const matured = BigInt(nowSec) >= position.lockEnd;
  // ⚠️ THE EXACT FIGURE, and everything that DECIDES anything keeps using it — the
  // Claim button's `earned <= 0n` gate below above all. The meter beside it lags by
  // design (see lib/ladder/meter.ts), so gating on the smoothed value would disable
  // Claim for up to a second after this position first has something to claim.
  // Smoothing is allowed to change what is PRINTED and nothing else.
  const earned = earnedNow(position, pool, nowSec);
  const earnedAt = useMemo(() => (secs: number) => earnedNow(position, pool, secs), [position, pool]);
  const secsLeft = Number(position.lockEnd) - nowSec;
  const boost = position.amountRaw > 0n
    ? Number((position.weight * 10_000n) / position.amountRaw)
    : 0;

  const quote = (door: 'matured' | 'early' | 'hatch') => quotes.find((q) => q.door === door)!;
  // `quoteExit` prices the early door at 0 in a degraded pool, as lib.rs `early_exit`
  // charges it (#586) — so the button can never quote a charge the program will not take.
  const normal = quote(matured ? 'matured' : 'early');
  const hatch = quote('hatch');
  // `claim` and both exit doors pay min(owed, reward vault) and keep the remainder
  // owed (math.rs `payable`); an exit carries it to UserStats.rewards_carried. So a
  // promise that rewards "are paid out" is only true when the vault covers them.
  const rewardsPaid = 'Your rewards are paid up to what the reward vault holds; any remainder stays owed to you and claimable later.';

  const key = (door: string) => `${position.nonce}:${door}`;

  return (
    <li className="rounded-[14px] p-4 sm:p-5" style={{ background: 'rgba(7,11,22,0.94)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3">
        <p className="text-white text-[17px] font-semibold m-0 tabular-nums whitespace-nowrap">
          {fmtRaw(position.amountRaw, decimals)}{' '}
          <span className="text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: 'rgba(255,255,255,0.55)', fontFamily: 'var(--font-family-heading)' }}>{sym}</span>
        </p>
        <p className="text-white/70 text-[12px] m-0">{boostLabel(boost)} weight</p>
        <p className="text-white/70 text-[12px] m-0 tabular-nums">
          <LiveEarned earnedAt={earnedAt} fallback={fmtRaw(earned, decimals)} decimals={decimals} /> {sym} earned
        </p>
      </div>

      {/* The lock, as a line. The read carries no lock START, so this does not
          invent one: the bar is the time left against the four-year scale that
          prices the early door — the same fraction `quoteExit` charges, capped at
          75%. Decorative; the words beside it carry the facts. */}
      <div className="mb-4">
        <div aria-hidden="true" className="h-1 w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
          <div className="h-full rounded-full" style={{ width: `${matured ? 0 : Math.min(100, (secsLeft / MAX_LOCK_SECS) * 100)}%`, background: 'var(--color-purple-60)' }} />
        </div>
        <p className="text-white/70 text-[12px] m-0 mt-1.5 tabular-nums">
          {matured ? 'unlocked' : `unlocks in ${humanDuration(secsLeft)}`}
          {!matured && !pool.degraded && ` · leave now −${penaltyPct(normal.penaltyRaw, position.amountRaw)}`}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!canWrite || earned <= 0n} onClick={onClaim}
          className="btn-secondary px-4 py-2.5 text-[12px] disabled:opacity-40">
          {busy === 'Claim' ? 'Claiming…' : 'Claim rewards'}
        </button>

        {/* The normal door. Free once matured (or in a degraded pool), charged the
            time-left penalty before — and the program refuses whichever one is not
            open, so only the open one is offered. */}
        <ExitButton
          label={matured ? `Withdraw ${fmtRaw(normal.receivesRaw, decimals)} ${sym}` : `Exit early — keep ${fmtRaw(normal.receivesRaw, decimals)} ${sym}`}
          detail={matured
            ? `No penalty. ${rewardsPaid}`
            : pool.degraded
              ? `No penalty while the pool is degraded. ${rewardsPaid}`
              : `${fmtRaw(normal.penaltyRaw, decimals)} ${sym} is retained. ${rewardsPaid}`}
          needsConfirm={!matured}
          confirmed={confirmFor === key('normal')}
          onArm={() => setConfirmFor(key('normal'))}
          onCancel={() => setConfirmFor(null)}
          onGo={() => onExit(!matured)}
          disabled={!canWrite}
          busy={busy === 'Early exit' || busy === 'Withdraw'}
        />

        {/* The hatch. Principal only, no reward accounting — so it cannot revert on a
            dry reward vault, which is the entire reason it exists. Its price is
            quoted, never assumed. */}
        <ExitButton
          label={hatch.penaltyRaw > 0n
            ? `Emergency withdraw — costs ${fmtRaw(hatch.penaltyRaw, decimals)} ${sym}`
            : 'Emergency withdraw — no penalty'}
          detail={hatch.reason}
          needsConfirm
          confirmed={confirmFor === key('hatch')}
          onArm={() => setConfirmFor(key('hatch'))}
          onCancel={() => setConfirmFor(null)}
          onGo={onHatch}
          disabled={!canWrite}
          busy={busy === 'Emergency withdraw'}
          tone="danger"
        />
      </div>
    </li>
  );
}

function ExitButton({
  label, detail, needsConfirm, confirmed, onArm, onCancel, onGo, disabled, busy, tone,
}: {
  label: string;
  detail: string;
  needsConfirm: boolean;
  confirmed: boolean;
  onArm: () => void;
  onCancel: () => void;
  onGo: () => void;
  disabled: boolean;
  busy: boolean;
  tone?: 'danger';
}) {
  const border = tone === 'danger' ? 'rgba(239,68,68,0.5)' : 'var(--color-purple-25)';
  if (!needsConfirm || confirmed) {
    return (
      <span className="inline-flex flex-col gap-1">
        <span className="inline-flex gap-2">
          <button type="button" disabled={disabled} onClick={onGo}
            className="px-4 py-2.5 text-[12px] rounded-lg disabled:opacity-40"
            style={{ background: 'rgba(239,68,68,0.15)', border: `1px solid ${border}`, color: '#fff' }}>
            {busy ? 'Sending…' : confirmed ? 'Confirm' : label}
          </button>
          {confirmed && (
            <button type="button" onClick={onCancel} className="btn-secondary px-3 py-2.5 text-[12px]">
              Cancel
            </button>
          )}
        </span>
        <span className="text-white/60 text-[11px]">{detail}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" disabled={disabled} onClick={onArm}
        className="px-4 py-2.5 text-[12px] rounded-lg disabled:opacity-40"
        style={{ background: 'rgba(0,0,0,0.5)', border: `1px solid ${border}`, color: 'rgba(255,255,255,0.9)' }}>
        {label}
      </button>
      <span className="text-white/60 text-[11px]">{detail}</span>
    </span>
  );
}
