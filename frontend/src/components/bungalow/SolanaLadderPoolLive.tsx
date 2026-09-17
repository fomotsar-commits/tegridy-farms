// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import { useEffect, useMemo, useState } from 'react';
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
  MAX_LOCK_SECS, MAX_POSITIONS, EARLY_EXIT_PENALTY_BPS, MIN_BOOST_BPS,
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
import { fmtRaw, toPlain, toRaw, humanDuration, lockLabel, boostLabel } from '../../lib/ladder/format';

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
 * 1. THE HATCH IS NOT FREE WHILE LOCKED. `emergency_withdraw` charges the same flat
 *    `EARLY_EXIT_PENALTY_BPS` as `early_exit` unless the position has matured or the
 *    pool is degraded (and in a degraded pool `early_exit` is free too).
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
  // principal (`EARLY_EXIT_PENALTY_BPS`) must never be one mis-click away.
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

  // One tick a minute keeps every countdown and every accrued figure honest without
  // a render loop. Rewards accrue per second, so a card that never re-rendered would
  // show a number that was right when the page loaded and drifts from then on.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
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

  // Sum only over positions we could actually read. `null` when the wallet read
  // failed, so an outage never renders as "you have earned 0".
  const myEarned: bigint | null = useMemo(() => {
    if (!pool || !walletView) return null;
    return positions.reduce((a, p) => a + earnedNow(p, pool, nowSec), 0n);
  }, [pool, walletView, positions, nowSec]);

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
      setAction({ note: `${label} confirmed.`, sig: res.signature });
      setAmount('');
    } else {
      setAction({ note: res.reason, sig: res.signature });
    }
    reread();
  };

  /* ── render ───────────────────────────────────────────────────────────── */

  return (
    <div className="relative overflow-hidden rounded-2xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
      <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.52)' }} />
      <div className="relative z-10 p-6">
        <p className="text-[10px] uppercase tracking-wider mb-3" style={{ color: 'var(--color-kyle)' }}>
          The lock ladder · LIVE
        </p>
        <h2 className="heading-luxury text-xl text-white mb-3">
          Lock {sym}, earn a weighted share
        </h2>
        {/* Owner-mandated disclosure. Every rule on this card is what the DEPLOYED
            program enforces; the upgrade authority can change any of it. */}
        {config.ok && (
          <p className="text-white/60 text-[11px] leading-relaxed mb-4 max-w-2xl">
            A position keeps its full weight after its lock opens, for as long as it stays in the pool.
            The program can be upgraded by its upgrade authority, and a future upgrade may reset matured positions
            to the {boostLabel(MIN_BOOST_BPS)} base weight. Everything on this card describes the program
            as deployed today.
          </p>
        )}

        {!config.ok && (
          <p role="alert" className="text-[13px] rounded-lg p-3" style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5' }}>
            {config.reason}
          </p>
        )}

        {config.ok && poolRead === null && (
          <p className="text-white/70 text-[13px]">Reading the pool…</p>
        )}

        {config.ok && poolRead && !poolRead.ok && (
          <p role="alert" className="text-[13px]" style={{ color: '#f0b26b' }}>{poolRead.reason}</p>
        )}

        {identityMismatch && pool && (
          <p role="alert" className="text-[13px] rounded-lg p-3" style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5' }}>
            This pool does not stake {sym} — it reports {pool.mint.slice(0, 6)}…{pool.mint.slice(-4)} as its
            staking mint. That is a configuration error, not a network problem, so no figures are shown and
            nothing here will send a transaction.
          </p>
        )}

        {pool && !identityMismatch && (
          <>
            {pool.degraded && (
              <p role="alert" className="text-[13px] rounded-lg p-3 mb-4" style={{ background: 'rgba(240,178,107,0.10)', border: '1px solid rgba(240,178,107,0.4)', color: '#f0b26b' }}>
                <strong>This pool has been declared degraded.</strong> It takes no new stakes. Every open
                position still exits, and while it is degraded neither early exit nor the emergency hatch
                charges any penalty — that is what the flag is for. The deployed program has no instruction
                to switch it back.
              </p>
            )}

            {/* ── the numbers that decide whether to stake ─────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
              <Stat
                label="Reward vault"
                value={vaults === null ? '…' : fmtRaw(vaults.rewardRaw, decimals)}
                unit={sym}
                note={vaults === null ? 'reading…' : vaults.rewardRaw === null ? 'could not be read' : undefined}
              />
              <Stat label={`${sym} locked here`} value={fmtRaw(pool.totalPrincipalRaw, decimals)} unit={sym} />
              {rewardWindow === 'live' ? (
                <>
                  <Stat
                    label="Rewards per day"
                    value={fmtRaw(perDayRaw, decimals)}
                    unit={sym}
                    note={belowFloor
                      ? 'scheduled, but nothing accrues while no one is staked, and that time is not paid out later'
                      : 'to all stakers combined, split by weight'}
                  />
                  <Stat label="Funded through" value={dateOf(pool.periodFinish)}
                    note={`the current reward window closes in ${humanDuration(runway ?? 0)}`} />
                </>
              ) : rewardWindow === 'ended' ? (
                <Stat label="Reward window" value="ended"
                  note={`closed ${dateOf(pool.periodFinish)} — no new rewards are accruing`} />
              ) : (
                <Stat label="Reward window" value="not started"
                  note="no reward window has ever been scheduled — no rewards are accruing" />
              )}
              <Stat label="Minimum stake" value={fmtRaw(pool.minStakeRaw, decimals)} unit={sym}
                note="the deployed program has no setter for it" />
            </div>

            {/* ── your position ────────────────────────────────────────── */}
            {!publicKey ? (
              <button type="button" onClick={openConnect} className="btn-primary px-6 py-2.5 text-[13px]">
                Connect a Solana wallet
              </button>
            ) : walletUnreadable ? (
              <p role="alert" className="text-[13px] rounded-lg p-3 mb-4" style={{ background: 'rgba(240,178,107,0.10)', border: '1px solid rgba(240,178,107,0.4)', color: '#f0b26b' }}>
                {walletUnreadable} Nothing is shown below rather than a zero, because a read that did not land
                is not the same as an empty position.{' '}
                <button type="button" onClick={reread} className="underline underline-offset-2">Try again</button>
              </p>
            ) : !walletLoaded ? (
              <p role="status" className="text-white/70 text-[13px]">Reading your positions…</p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                  <Stat label="Your principal" value={fmtRaw(myPrincipal, decimals)} unit={sym} />
                  <Stat label="Earned, unclaimed" value={fmtRaw(myEarned, decimals)} unit={sym} />
                  <Stat label="Open positions" value={openCount === null ? '–' : `${openCount} / ${MAX_POSITIONS}`} />
                  <Stat
                    label="In your wallet"
                    value={!balanceLoaded ? '…' : fmtRaw(walletRaw, decimals)}
                    unit={sym}
                    note={!balanceLoaded ? 'reading…' : walletRaw === null ? 'could not be read' : undefined}
                  />
                </div>

                {/* Carried rewards are real money in a field. A UI that never shows
                    them hides a balance the program deliberately preserved: the hatch
                    carries accrual, and either exit door carries what a short reward
                    vault could not pay (lib.rs `exit_with_penalty`). */}
                {carriedRaw !== null && carriedRaw > 0n && (
                  <div className="rounded-lg p-3 mb-4 flex flex-wrap items-center justify-between gap-3"
                    style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-kyle-40)' }}>
                    <p className="text-white/85 text-[13px] m-0">
                      <strong>{fmtRaw(carriedRaw, decimals)} {sym}</strong> carried from a closed position —
                      rewards the reward vault could not cover when it closed, or that the emergency hatch set
                      aside. They are still yours.
                    </p>
                    <button type="button" disabled={!canWrite || !ctx}
                      onClick={() => ctx && void run('Claim carried', () => ladderClaimCarried(ctx))}
                      className="btn-secondary px-4 py-2 text-[12px] disabled:opacity-50">
                      Claim carried
                    </button>
                  </div>
                )}

                {/* ── the stake form ───────────────────────────────────── */}
                <fieldset className="rounded-lg p-4 mb-4" style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid var(--color-purple-25)' }}>
                  <legend className="text-[10px] uppercase tracking-wider px-2" style={{ color: 'var(--color-kyle)' }}>
                    Open a position
                  </legend>

                  <label htmlFor="ladder-amount" className="block text-white/70 text-[11px] mb-1">Amount</label>
                  <div className="flex items-center gap-2 mb-3">
                    <input
                      id="ladder-amount"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.0"
                      className="flex-1 min-w-0 rounded-lg px-3 py-2 text-white text-[14px] font-mono"
                      style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid var(--color-purple-25)' }}
                    />
                    <button
                      type="button"
                      // MAX comes from the PLAIN string, never from the grouped
                      // display — see format.ts. The grouped form under-stakes by
                      // 1000x in any dot-grouping locale.
                      disabled={walletRaw === null}
                      onClick={() => walletRaw !== null && setAmount(toPlain(walletRaw, decimals))}
                      className="btn-secondary px-3 py-2 text-[12px] disabled:opacity-40"
                    >
                      Max
                    </button>
                  </div>

                  <p className="text-white/70 text-[11px] mb-2" id="ladder-rungs-label">
                    Lock length — a longer lock carries more weight, and weight is what decides your share.
                  </p>
                  <div role="group" aria-labelledby="ladder-rungs-label" className="flex flex-wrap gap-2 mb-3">
                    {RUNGS.map((secs) => {
                      const on = secs === lockSecs;
                      return (
                        <button
                          key={secs}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setLockSecs(secs)}
                          className="rounded-lg px-3 py-2 text-[12px]"
                          style={{
                            background: on ? 'var(--color-purple-25)' : 'rgba(0,0,0,0.5)',
                            border: `1px solid ${on ? 'var(--color-kyle)' : 'var(--color-purple-25)'}`,
                            color: on ? '#fff' : 'rgba(255,255,255,0.75)',
                          }}
                        >
                          <span className="font-semibold">{lockLabel(secs)}</span>
                          <span className="ml-2 opacity-80">{boostLabel(boostBpsForLock(secs))}</span>
                        </button>
                      );
                    })}
                  </div>

                  {amountRaw !== null && amountRaw > 0n && (
                    <p className="text-white/70 text-[12px] mb-3">
                      This would carry a weight of{' '}
                      <strong className="text-white">{fmtRaw(weightForStake(amountRaw, lockSecs), decimals)}</strong>{' '}
                      and unlock in {humanDuration(lockSecs)}.{' '}
                      {pool.degraded
                        ? 'While the pool is degraded it accepts no new stakes.'
                        : `Leaving early costs ${EARLY_EXIT_PENALTY_BPS / 100}% of the principal.`}
                    </p>
                  )}

                  {verdict && !verdict.allowed && (
                    <p role="alert" className="text-[12px] mb-3" style={{ color: '#f0b26b' }}>{verdict.reason}</p>
                  )}
                  {overBalance && (
                    <p role="alert" className="text-[12px] mb-3" style={{ color: '#f0b26b' }}>
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
                    className="btn-primary px-6 py-2.5 text-[13px] disabled:opacity-40"
                  >
                    {action?.busy === 'Stake' ? 'Staking…' : `Lock ${sym} for ${lockLabel(lockSecs)}`}
                  </button>
                </fieldset>

                {/* ── open positions ───────────────────────────────────── */}
                {walletView?.truncated && (
                  <p role="alert" className="text-[12px] mb-3" style={{ color: '#f0b26b' }}>
                    This wallet has more positions than one read could cover, so the list below is partial.
                    Nothing is missing from your account — only from this view.
                  </p>
                )}

                {positions.length === 0 ? (
                  <p className="text-white/60 text-[13px]">No open positions in this pool.</p>
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
              </>
            )}

            {action?.note && (
              <p role="status" className="text-[12px] mt-4 rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-purple-25)', color: 'rgba(255,255,255,0.85)' }}>
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
  );
}

function Stat({ label, value, unit, note }: { label: string; value: string; unit?: string; note?: string }) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-purple-25)' }}>
      <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--color-kyle)' }}>{label}</p>
      <p className="text-white text-[15px] font-semibold m-0 tabular-nums">
        {value}{unit ? <span className="text-white/60 text-[11px] font-normal ml-1">{unit}</span> : null}
      </p>
      {note && <p className="text-white/55 text-[11px] mt-1 m-0">{note}</p>}
    </div>
  );
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
  const earned = earnedNow(position, pool, nowSec);
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
    <li className="rounded-lg p-4" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-purple-25)' }}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3">
        <p className="text-white text-[15px] font-semibold m-0 tabular-nums">
          {fmtRaw(position.amountRaw, decimals)} <span className="text-white/60 text-[11px] font-normal">{sym}</span>
        </p>
        <p className="text-white/70 text-[12px] m-0">{boostLabel(boost)} weight</p>
        <p className="text-white/70 text-[12px] m-0">
          {matured ? 'unlocked' : `unlocks in ${humanDuration(secsLeft)}`}
        </p>
        <p className="text-white/70 text-[12px] m-0 tabular-nums">
          {fmtRaw(earned, decimals)} {sym} earned
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!canWrite || earned <= 0n} onClick={onClaim}
          className="btn-secondary px-4 py-2 text-[12px] disabled:opacity-40">
          {busy === 'Claim' ? 'Claiming…' : 'Claim rewards'}
        </button>

        {/* The normal door. Free once matured (or in a degraded pool), charged
            `EARLY_EXIT_PENALTY_BPS` before — and the program refuses whichever one is
            not open, so only the open one is offered. */}
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
            className="px-4 py-2 text-[12px] rounded-lg disabled:opacity-40"
            style={{ background: 'rgba(239,68,68,0.15)', border: `1px solid ${border}`, color: '#fff' }}>
            {busy ? 'Sending…' : confirmed ? 'Confirm' : label}
          </button>
          {confirmed && (
            <button type="button" onClick={onCancel} className="btn-secondary px-3 py-2 text-[12px]">
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
        className="px-4 py-2 text-[12px] rounded-lg disabled:opacity-40"
        style={{ background: 'rgba(0,0,0,0.5)', border: `1px solid ${border}`, color: 'rgba(255,255,255,0.9)' }}>
        {label}
      </button>
      <span className="text-white/60 text-[11px]">{detail}</span>
    </span>
  );
}
