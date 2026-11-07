import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAccount, useChainId, useReadContracts, useSwitchChain, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits } from 'viem';
import { toast } from 'sonner';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import type { Bungalow } from '../../lib/bungalows';
import { LIGHTHOUSE_LADDER_ABI, ERC20_ABI } from '../../lib/contracts';
import {
  deriveLadder, boostLabel, boostBpsFor, projectedRawPerSec, penaltyOn, penaltyPct, penaltyShare, lockRemaining, MIN_STAKE_RAW,
  isC1UnsafeLadder,
} from '../../lib/lighthouseLadder';
import { fmtRaw, fmtRunway } from '../../lib/evmLighthouse';
import { noteReplacement, receiptOutcome, surfaceTxError } from '../../lib/txErrors';
import { getTxUrl, getAddressUrl } from '../../lib/explorer';
import { LOCK_DURATIONS } from '../../lib/copy';
import { CopyButton } from '../ui/CopyButton';
import { shortenAddress } from '../../lib/formatting';
import { HeldTimeLine } from './HeldTimeLine';
import { CardArt } from '../ui/CardArt';
import { useOnStakesChanged } from '../../lib/harvest/stakesChanged';
import { FinePrint } from '../ui/FinePrint';
import { rewardsEndedLine, rewardsHaveEnded, rewardsZeroLine } from '../../lib/rewardsEnded';

import { PositionMark, positionHost } from '../ui/PositionMark';
import { RoomTorches } from '../RoomTorches';
/**
 * The island's LOCKED EVM lighthouse card (LighthouseLadder.sol).
 *
 * What it must get right, beyond the plain card's rules:
 *  - THE VAULT IS THE CONTRACT'S OWN `rewardSurplus()` — balance minus
 *    principal — so the page and the payout logic can never disagree about
 *    what is actually payable.
 *  - BOOST IS RELATIVE. 4.00x buys four times the SHARE, not four times the
 *    yield, and while a pool is empty the first staker earns the whole rate
 *    whatever they lock. Both facts are said out loud; a card that implied
 *    "lock 4 years for 4x rewards" would be lying to the first staker.
 *  - THE PENALTY IS SHOWN BEFORE IT IS CHARGED, in tokens, on the button.
 *  - NEVER-FUNDED is its own state, distinct from "the period ended".
 */

// Robinhood Chain is listed before any room lives there (owner, 2026-10-18): the
// fallback below is Ethereum, and a pool on an unlisted chain would read mainnet.
const CHAIN_IDS: Record<string, number> = { ethereum: 1, base: 8453, robinhood: 4663 };
const CHAIN_LABEL: Record<number, string> = { 1: 'Ethereum', 8453: 'Base', 4663: 'Robinhood Chain' };
const PLACEHOLDER = '0x0000000000000000000000000000000000000001' as const;
const DAY = 86_400n;
// The same six rungs the TOWELI farm uses (lib/copy.ts), named by their plain length
// only: the farm's own names stay in the farm's room (island, answer seventeen item 3).
const RUNGS: { length: string; secs: bigint }[] = LOCK_DURATIONS.map((d) => ({
  length: d.sublabel,
  secs: BigInt(d.days) * DAY,
}));

type Pos = { id: bigint; lockEnd: bigint; amount: bigint; boosted: bigint };

export function EvmLadderPoolLive({ bungalow, harvest }: { bungalow: Bungalow & { stakePool: string }; harvest?: ReactNode }) {
  const pool = bungalow.stakePool as `0x${string}`;
  // C1: this pool is one of the six pre-fix ladders the audit forbids depositing
  // into. Deposits only — claim and withdraw stay live below. Lifts by itself on
  // a registry repin. See lighthouseLadder.ts:C1_UNSAFE_LADDER_POOLS.
  const depositsFrozen = isC1UnsafeLadder(pool);
  const token = (bungalow.address ?? '') as `0x${string}`;
  const poolChainId = CHAIN_IDS[bungalow.chain] ?? 1;
  const accent = bungalow.accent ?? 'var(--color-kyle)';

  const { address: user, isConnected } = useAccount();
  const walletChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const onPoolChain = walletChainId === poolChainId;
  const userAddr = user ?? PLACEHOLDER;

  const [amount, setAmount] = useState('');
  const [rung, setRung] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [nowSecs, setNowSecs] = useState<bigint>(0n);
  useEffect(() => {
    const tick = () => setNowSecs(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const poolC = { address: pool, abi: LIGHTHOUSE_LADDER_ABI, chainId: poolChainId } as const;
  const tokenC = { address: token, abi: ERC20_ABI, chainId: poolChainId } as const;
  const { data: reads, isLoading, refetch } = useReadContracts({
    contracts: [
      { ...poolC, functionName: 'totalSupply' },
      { ...poolC, functionName: 'totalBoosted' },
      { ...poolC, functionName: 'rewardSurplus' },
      { ...poolC, functionName: 'rewardRate' },
      { ...poolC, functionName: 'periodFinish' },
      { ...poolC, functionName: 'rewardsDuration' },
      { ...tokenC, functionName: 'decimals' },
      { ...poolC, functionName: 'earned', args: [userAddr] },
      { ...poolC, functionName: 'balanceOf', args: [userAddr] },
      { ...tokenC, functionName: 'balanceOf', args: [userAddr] },
      { ...tokenC, functionName: 'allowance', args: [userAddr, pool] },
      { ...poolC, functionName: 'positionsOf', args: [userAddr] },
      // Identity: prove this pool really stakes THIS bungalow's token before
      // any figure is trusted (a design-review finding — a mispasted address
      // would otherwise render a stranger pool's numbers under our symbol).
      { ...poolC, functionName: 'stakingToken' },
      // The exit is the pool's own, read and never assumed. The six ladders live
      // today answer a flat rate (EARLY_EXIT_PENALTY_BPS, 25%); the ladder's-law
      // build answers a cap (MAX_EARLY_EXIT_PENALTY_BPS, 75%) and quotes each
      // position with penaltyFor() below. An unread penalty is no number.
      { ...poolC, functionName: 'EARLY_EXIT_PENALTY_BPS' },
      { ...poolC, functionName: 'MAX_EARLY_EXIT_PENALTY_BPS' },
    ],
    query: { refetchInterval: 30_000 },
  });
  // Harvest on this page claims the same rewards: read again when it runs (lib/harvest/stakesChanged.ts).
  const [me] = useState(() => ({}));
  useOnStakesChanged(me, () => void refetch());

  const big = (i: number): bigint | null => {
    const r = reads?.[i];
    return r && r.status === 'success' ? (r.result as bigint) : null;
  };
  const decimals = reads?.[6]?.status === 'success' ? Number(reads[6].result) : bungalow.decimals ?? 18;
  const poolToken = reads?.[12]?.status === 'success' ? String(reads[12].result) : null;
  const identityMismatch = poolToken !== null && poolToken.toLowerCase() !== token.toLowerCase();
  const flatBps = big(13);
  const capBps = big(14);
  const capWord = capBps === null ? '' : penaltyPct(capBps);
  const penaltyWord = flatBps !== null
    ? penaltyPct(flatBps)
    : capBps !== null
      ? `the time left on it over four years, capped at ${capWord}`
      : 'a penalty that could not be read just now';

  const view = useMemo(
    () => deriveLadder({
      totalStakedRaw: big(0), totalBoostedRaw: big(1), surplusRaw: big(2),
      rewardRateRaw: big(3), periodFinishSecs: big(4), rewardsDurationSecs: big(5),
    }, nowSecs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reads, nowSecs],
  );

  const earnedRaw = user ? big(7) : null;
  const myPrincipalRaw = user ? big(8) : null;
  const walletRaw = user ? big(9) : null;
  const allowanceRaw = user ? big(10) : null;
  const idsRead = user ? reads?.[11] : undefined;
  const ids = (idsRead?.status === 'success' ? (idsRead.result as readonly bigint[]) : []) as readonly bigint[];

  const { data: posReads, isLoading: posLoading } = useReadContracts({
    contracts: ids.map((id) => ({ ...poolC, functionName: 'positions' as const, args: [id] as const })),
    query: { enabled: ids.length > 0, refetchInterval: 30_000 },
  });
  const positions: Pos[] = ids.map((id, i) => {
    const r = posReads?.[i];
    if (!r || r.status !== 'success') return null;
    const t = r.result as readonly [string, bigint, bigint, bigint];
    return { id, lockEnd: BigInt(t[1]), amount: t[2], boosted: t[3] };
  }).filter(Boolean) as Pos[];

  // The ladder's law prices each position by the time left on it, so the figure on
  // an exit button is the pool's own penaltyFor() for that position: read, not derived.
  const { data: quoteReads } = useReadContracts({
    contracts: positions.map((p) => ({ ...poolC, functionName: 'penaltyFor' as const, args: [p.amount, p.lockEnd] as const })),
    query: { enabled: capBps !== null && positions.length > 0, refetchInterval: 30_000 },
  });
  const quoteFor = (i: number): bigint | null => {
    const r = quoteReads?.[i];
    return r && r.status === 'success' ? (r.result as bigint) : null;
  };

  // An RPC that fails must never render as "you have nothing staked". That is
  // the outage-as-zero the Solana card was built to refuse, and here it is
  // worse: it hides a locked principal from the person who owns it. Separate
  // "still loading" from "the chain would not answer", and say which.
  const positionsUnread = Boolean(user) && !isLoading && (
    (!idsRead || idsRead.status !== 'success')
      ? true
      : ids.length > 0 && !posLoading && positions.length !== ids.length
  );

  const { writeContractAsync } = useWriteContract();
  const [lastHash, setLastHash] = useState<`0x${string}` | undefined>();
  // wagmi THROWS on a reverted receipt, so "REVERTED on-chain" below never
  // rendered: a revert, and a receipt nobody could read, both said "pending" for
  // good (2026-09-17). receiptOutcome splits wagmi's `isError` into the two.
  // And a receipt is only proof of its OWN transaction: a deposit the wallet
  // cancelled resolves with the cancel's success receipt (see lib/txErrors.ts).
  const lastOutcome = receiptOutcome(
    useWaitForTransactionReceipt({ hash: lastHash, chainId: poolChainId, onReplaced: noteReplacement }),
    lastHash,
  );

  const amountRaw = (() => {
    try { return amount.trim() ? parseUnits(amount.trim(), decimals) : 0n; } catch { return null; }
  })();
  const chosen = RUNGS[rung]!;
  const needsApproval = amountRaw !== null && amountRaw > 0n && allowanceRaw !== null && allowanceRaw < amountRaw;
  const myBoostIfStaked = amountRaw === null ? 0n : (amountRaw * boostBpsFor(chosen.secs)) / 10_000n;
  // The contract's dust floor. Checked here so a below-minimum amount reads as
  // a sentence instead of costing gas to learn as "Lighthouse: stake below
  // minimum". `belowMin` is only true once an amount has actually been typed —
  // an empty field is not an error, it is an empty field.
  const belowMin = amountRaw !== null && amountRaw > 0n && amountRaw < MIN_STAKE_RAW;
  const projected = projectedRawPerSec(view, big(1), myBoostIfStaked);
  const soloPool = big(1) === 0n;

  async function send(kind: string, fn: () => Promise<`0x${string}`>) {
    if (!user) return;
    setBusy(kind);
    try {
      const hash = await fn();
      setLastHash(hash);
      toast.success(
        <span>Submitted. <a href={getTxUrl(poolChainId, hash)} target="_blank" rel="noopener noreferrer" className="underline">tx ↗</a></span>,
      );
      setTimeout(() => { void refetch(); }, 4_000);
    } catch (e) { surfaceTxError(e, toast); } finally { setBusy(null); }
  }

  const unfunded = view.vaultRaw !== null && view.vaultRaw === 0n;
  // A landed periodFinish in the past, or a pool paying 0 now (never funded, or a
  // rate of 0): no new stake (owner, 2026-10-14), as a lock of up to 4 years would
  // earn nothing and leaving early costs the pool's penalty. Claim and every position exit stay.
  // An unread end or rate holds Stake.
  const periodFinishRaw = big(4);
  const rewardsEnded = rewardsHaveEnded(periodFinishRaw, nowSecs);
  const paysNothing = !rewardsEnded && view.payingNowRawPerSec === 0n;
  const stakeClosed = depositsFrozen || rewardsEnded || paysNothing || periodFinishRaw === null || big(3) === null;

  return (
    <div className={positionHost('relative isolate overflow-hidden rounded-2xl glass-card-animated', positions.length > 0)} style={{ border: '1px solid var(--color-purple-75)' }}>
      <PositionMark inPosition={positions.length > 0} />
      <CardArt pageId="evm-ladder-pool-live" idx={0} scrim="transparent" />
      {/* ART VISIBILITY 2026-08-31 (owner): this scrim was 0.85 and the
          resident's art underneath was barely readable — a dark page scrim
          plus a dark card scrim stacked into near-black. Lightened hard.
          Safe because the dense copy inside sits on its OWN panels
          (rgba(0,0,0,0.4-0.6) blocks), so contrast is carried there and
          not by drowning the whole card. */}
      <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.52)' }} />
      <div className="relative z-10 p-6">
        <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: accent }}>
          The lighthouse · {CHAIN_LABEL[poolChainId]} · lock ladder
        </p>
        <h2 className="heading-luxury text-xl text-white mb-1">Stake {bungalow.symbol}</h2>
        <div className="flex items-center gap-2 mb-4">
          <CopyButton text={pool} display={shortenAddress(pool, 6)} className="font-mono text-[11px]" style={{ color: 'var(--color-kyle)' }} />
          <a href={getAddressUrl(poolChainId, pool)} target="_blank" rel="noopener noreferrer" aria-label="View pool on block explorer (opens in new tab)" className="text-[11px] underline underline-offset-2 text-white/60 hover:text-white">explorer ↗</a>
        </div>

        {identityMismatch ? (
          <p className="text-[13px] rounded-lg p-3" style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5' }}>
            This pool does not stake {bungalow.symbol}. It reports {shortenAddress(poolToken ?? '', 6)} as its staking
            token. That is a configuration error, not a network problem, so no figures are shown and nothing here
            will send a transaction.
          </p>
        ) : !view.coreKnown && !isLoading ? (
          <p className="text-[13px]" style={{ color: '#f0b26b' }}>
            The pool could not be read just now. Figures are withheld rather than shown as zeros.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <Stat label="Reward vault" value={`${fmtRaw(view.vaultRaw, decimals)} ${bungalow.symbol}`} title="The contract's own rewardSurplus(): its balance minus every staker's principal. This is what it can actually pay." />
              <Stat label="Total staked" value={`${fmtRaw(big(0), decimals)} ${bungalow.symbol}`} />
              <Stat label="Pool pays (all stakers)" value={view.payingNowRawPerSec === null ? '—' : `${fmtRaw(view.payingNowRawPerSec * 86_400n, decimals)}/day`} title="Pool-wide, shared across every staker by lock weight — not your personal rate." />
              <Stat label="Runway" value={view.everFunded === false ? 'not started' : fmtRunway(view.runwaySecs)} title="Exact seconds to periodFinish, read on-chain." />
            </div>
            {view.coreKnown && <HeldTimeLine chain={bungalow.chain} pool={bungalow.stakePool} className="mb-4" />}

            {/* A pool that pays nothing: the room's torches above its notice, and the notice
                stays (owner, 2026-10-15). */}
            {((rewardsEnded && periodFinishRaw !== null) || paysNothing || unfunded) && <RoomTorches roomId={bungalow.id} compact />}

            {rewardsEnded && periodFinishRaw !== null ? (
              <p className="text-[12px] mb-4" style={{ color: '#f0b26b' }} data-testid="ladder-rewards-ended">
                {rewardsEndedLine(periodFinishRaw)}
              </p>
            ) : paysNothing ? (
              <div className="text-[12px] mb-4 rounded-lg p-3" style={{ background: 'rgba(240,178,107,0.08)', border: '1px solid rgba(240,178,107,0.35)', color: '#f0b26b' }} data-testid="ladder-rewards-zero">
                <p className="m-0">{rewardsZeroLine(view.everFunded === false)}</p>
                <FinePrint summary="Why">
                  <p className="m-0">
                    A lock here would earn nothing, and leaving before it opens costs {penaltyWord}. Staking opens again
                    by itself once the pool is funded and pays a reward rate. Tokens merely sent to the pool
                    earn no one anything.
                  </p>
                </FinePrint>
              </div>
            ) : unfunded && (
              <p className="text-[12px] mb-4 rounded-lg p-3" style={{ background: 'rgba(240,178,107,0.08)', border: '1px solid rgba(240,178,107,0.35)', color: '#f0b26b' }}>
                The reward vault is empty, so the pool pays 0 today.
              </p>
            )}

            <p className="text-[11px] text-white/60 mb-4 leading-relaxed" data-testid="ladder-exit-cost">
              Longer locks earn a larger <em>share</em>. Leaving before your lock opens costs {penaltyWord}.
            </p>

            {/* THE WAY IN, above the ladder (owner, 2026-10-14: "see the stuff they are to
                interact with"). The rungs stay public below it; only the amount and the
                buttons need a wallet. */}
            {!(isConnected && user) && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4">
                <ConnectButton.Custom>
                {({ openConnectModal, mounted }) => (
                  <button type="button" onClick={openConnectModal} disabled={!mounted} className="btn-primary px-6 py-2.5 text-[13px] disabled:opacity-50">
                    Connect wallet
                  </button>
                )}
              </ConnectButton.Custom>
                <p className="text-[12px] text-white/60 m-0">
                  Connect a wallet to stake. The figures above are live either way.
                </p>
              </div>
            )}

            {/* THE LADDER IS PUBLIC. Every pool on the venue shows its lock
                tiers to every visitor, connected or not — a ladder you must
                connect a wallet to even SEE is a ladder nobody climbs. Only the
                amount field and the buttons below need a wallet. */}
            <p className="text-[10px] uppercase tracking-wider text-white/50 mb-2">Lock duration</p>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {RUNGS.map((r, i) => (
                <button key={r.length} type="button" onClick={() => setRung(i)}
                  className="rounded-lg px-2 py-2 text-[12px] border transition-colors"
                  style={{
                    background: i === rung ? 'rgba(127,224,176,0.14)' : 'rgba(0,0,0,0.4)',
                    borderColor: i === rung ? accent : 'rgba(255,255,255,0.12)',
                    color: i === rung ? '#fff' : 'rgba(255,255,255,0.75)',
                  }}>
                  {r.length}
                  <span className="block text-[10px] text-white/50">{boostLabel(r.secs)}</span>
                </button>
              ))}
            </div>
            <FinePrint summary="How it works" className="mb-3">
              <p className="m-0">
                {boostLabel(chosen.secs)} for {chosen.length}.
              </p>
              <p className="m-0">
                Longer locks earn a larger <em>share</em>: 0.40× at seven days up to 4.00× at four years, the
                venue&apos;s standard lock ladder. Rewards are
                never paid out of anyone&apos;s principal: the contract caps every payout at its surplus, so your
                deposit can always come back. Leaving before your lock opens costs {penaltyWord}, which stays in the pool for
                the stakers who waited. <strong>Emergency withdraw is always open</strong> and needs nothing from the
                reward side.
              </p>
              <p className="m-0">
                Weight decides your share of the pool&apos;s rate; it is not a multiplier on your own deposit.
              </p>
            </FinePrint>

            {/* Every pool's rewards in one press, in this card (owner, 2026-10-30), on any network:
                Harvest switches the wallet itself. Drawn only while there is something to claim. */}
            {harvest}
            {isConnected && user ? !onPoolChain ? (
              <button type="button" onClick={() => switchChain({ chainId: poolChainId })} className="btn-primary px-6 py-2.5 text-[13px]">
                Switch wallet to {CHAIN_LABEL[poolChainId]}
              </button>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <Stat label="Your principal" value={`${fmtRaw(myPrincipalRaw, decimals)} ${bungalow.symbol}`} />
                  <Stat label="Claimable" value={`${fmtRaw(earnedRaw, decimals)} ${bungalow.symbol}`} />
                </div>


                {!rewardsEnded && !paysNothing && (<>
                <div className="flex items-center gap-2 mb-2">
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
                    placeholder={`Amount (${bungalow.symbol})`} aria-label={`Amount of ${bungalow.symbol} to stake`}
                    className="flex-1 min-w-0 rounded-lg px-3 py-2 text-[13px] bg-black/50 border border-white/15 text-white placeholder-white/35" />
                  <button type="button" className="text-[11px] text-white/60 hover:text-white underline underline-offset-2"
                    onClick={() => walletRaw !== null && setAmount(fmtRaw(walletRaw, decimals, 6).replace(/,/g, ''))}>max</button>
                </div>
                <p className="text-[11px] text-white/50 mb-3">
                  Wallet: {fmtRaw(walletRaw, decimals)} {bungalow.symbol}
                  {belowMin && (
                    <span
                      className="text-amber-300/90"
                      title="Smaller positions are refused because their lock weight would be small enough to distort every staker's share."
                    >
                      {' · '}minimum {fmtRaw(MIN_STAKE_RAW, decimals)} {bungalow.symbol}
                    </span>
                  )}
                  {amountRaw !== null && amountRaw > 0n && (
                    <>
                      {' · '}at {boostLabel(chosen.secs)}
                      {soloPool
                        ? ', you would be the only staker, so you would earn the whole rate whatever you lock'
                        : projected !== null && projected > 0n
                          ? `, about ${fmtRaw(projected * 86_400n, decimals)} ${bungalow.symbol}/day at today's total weight`
                          : ''}
                    </>
                  )}
                </p>
                </>)}

                {depositsFrozen && (
                  <div className="rounded-xl p-3 mb-3 text-[12px]" style={{ background: 'rgba(120,20,20,0.30)', border: '1px solid rgba(255,120,120,0.40)' }}>
                    <p className="text-red-200/95">
                      <strong>Deposits are closed on this pool.</strong> Nothing is stuck: claiming and
                      withdrawing below are unaffected.
                    </p>
                    <FinePrint summary="Why">
                      <p className="m-0">
                        An internal audit found that this
                        deployment can pay rewards out of other stakers&rsquo; principal, so we are not taking
                        new stake into it. The fix is written and this pool is waiting to be redeployed;
                        the page will re-open by itself once it points at the new contract.
                      </p>
                    </FinePrint>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 mb-4">
                  {stakeClosed ? null : needsApproval ? (
                    <button type="button" disabled={busy !== null || !amountRaw} className="btn-primary px-5 py-2 text-[13px] disabled:opacity-50"
                      onClick={() => send('approve', () => writeContractAsync({ ...tokenC, functionName: 'approve', args: [pool, amountRaw ?? 0n] }))}>
                      {busy === 'approve' ? 'Approving…' : `Approve ${bungalow.symbol}`}
                    </button>
                  ) : (
                    <button type="button" disabled={busy !== null || !amountRaw || amountRaw === 0n || belowMin || (walletRaw !== null && amountRaw > walletRaw)}
                      className="btn-primary px-5 py-2 text-[13px] disabled:opacity-50"
                      onClick={() => send('stake', () => writeContractAsync({ ...poolC, functionName: 'stake', args: [amountRaw ?? 0n, chosen.secs] }))}>
                      {busy === 'stake' ? 'Staking…' : belowMin ? `Minimum ${fmtRaw(MIN_STAKE_RAW, decimals, 0)} ${bungalow.symbol}` : walletRaw !== null && amountRaw !== null && amountRaw > walletRaw ? 'More than your balance' : `Stake for ${chosen.length}`}
                    </button>
                  )}
                  <button type="button" disabled={busy !== null || earnedRaw === null || earnedRaw === 0n} className="btn-secondary px-5 py-2 text-[13px] disabled:opacity-50"
                    onClick={() => send('claim', () => writeContractAsync({ ...poolC, functionName: 'getReward' }))}>
                    {busy === 'claim' ? 'Claiming…' : 'Claim rewards'}
                  </button>
                </div>

                {positionsUnread && (
                  <div className="rounded-xl p-3 text-[12px]" style={{ background: 'rgba(120,60,0,0.28)', border: '1px solid rgba(255,170,60,0.35)' }}>
                    <p className="text-amber-200/95">
                      Your positions could not be read. Anything you staked is still staked.
                      Retry before acting on this panel.
                    </p>
                    <button type="button" className="btn-secondary mt-2 px-4 py-1.5 text-[12px]" onClick={() => { void refetch(); }}>
                      Retry
                    </button>
                  </div>
                )}

                {positions.length > 0 && (
                  <div className="rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <p className="text-[10px] uppercase tracking-wider text-white/50 mb-2">Your positions</p>
                    <div className="space-y-2">
                      {positions.map((p, i) => {
                        const left = lockRemaining(p.lockEnd, nowSecs);
                        const open = left === 0n;
                        const fee = flatBps !== null ? penaltyOn(p.amount, flatBps) : capBps !== null ? quoteFor(i) : null;
                        return (
                          <div key={String(p.id)} className="flex flex-wrap items-center gap-2 text-[12px]">
                            <span className="text-white tabular-nums">{fmtRaw(p.amount, decimals)} {bungalow.symbol}</span>
                            <span className="text-white/45">
                              {p.amount > 0n ? `${(Number((p.boosted * 10_000n) / p.amount) / 10_000).toFixed(2)}x` : '—'}
                            </span>
                            <span className="text-white/45">{open ? 'unlocked' : `opens in ${fmtRunway(left)}`}</span>
                            <div className="flex-1" />
                            {open ? (
                              <button type="button" disabled={busy !== null} className="btn-secondary px-3 py-1 text-[11px] disabled:opacity-50"
                                onClick={() => send('w' + p.id, () => writeContractAsync({ ...poolC, functionName: 'withdrawPosition', args: [p.id] }))}>
                                Withdraw
                              </button>
                            ) : (
                              <button type="button" disabled={busy !== null} className="btn-secondary px-3 py-1 text-[11px] disabled:opacity-50"
                                title={fee === null
                                  ? 'The penalty could not be read just now. The pool charges it either way, and it stays in the pool for the stakers who waited.'
                                  : flatBps !== null
                                    ? `Leaving early costs ${fmtRaw(fee, decimals)} ${bungalow.symbol} (${penaltyWord}), which stays in the pool for the stakers who waited.`
                                    : `Leaving now costs ${fmtRaw(fee, decimals)} ${bungalow.symbol} (about ${penaltyShare(fee, p.amount)}): the time left on your lock over four years, capped at ${capWord}. It stays in the pool for the stakers who waited.`}
                                onClick={() => send('e' + p.id, () => writeContractAsync({ ...poolC, functionName: 'earlyExit', args: [p.id] }))}>
                                {fee === null ? 'Exit early' : `Exit early (−${fmtRaw(fee, decimals)})`}
                              </button>
                            )}
                            {/* AUDIT (2026-09-01): this used to promise "Principal
                                only" unconditionally. On a LOCKED position that is
                                false — emergencyWithdraw applies the SAME
                                penalty as earlyExit
                                (LighthouseLadder.sol: `if (block.timestamp <
                                p.lockEnd) out = amount - penalty`). A user taking
                                the escape hatch early was told they would keep
                                their principal and lost a quarter of it. The label
                                and the tooltip now both carry the real cost, and
                                only the matured case claims to be free. */}
                            <button type="button" disabled={busy !== null} className="text-[11px] text-white/45 hover:text-white underline underline-offset-2"
                              title={open
                                ? 'Principal only, forfeiting unclaimed rewards, using nothing from the reward side. Always available — this is the last resort if rewards are ever broken.'
                                : fee === null
                                  ? 'Still locked, so this costs the same penalty as exiting early (it could not be read just now), AND forfeits unclaimed rewards. It uses nothing from the reward side, so it works even if rewards are broken, which is the only reason to prefer it over Exit early.'
                                  : flatBps !== null
                                    ? `Still locked, so this costs the same ${fmtRaw(fee, decimals)} ${bungalow.symbol} (${penaltyWord}) as exiting early, AND forfeits unclaimed rewards. It uses nothing from the reward side, so it works even if rewards are broken — that is the only reason to prefer it over Exit early.`
                                    : `Still locked, so this costs the same ${fmtRaw(fee, decimals)} ${bungalow.symbol} (about ${penaltyShare(fee, p.amount)}) as exiting early, AND forfeits unclaimed rewards. It uses nothing from the reward side, so it works even if rewards are broken, which is the only reason to prefer it over Exit early.`}
                              onClick={() => send('x' + p.id, () => writeContractAsync({ ...poolC, functionName: 'emergencyWithdraw', args: [p.id] }))}>
                              {open || fee === null ? 'emergency' : `emergency (−${fmtRaw(fee, decimals)})`}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {lastHash && (
                  <p className="text-[11px] text-white/55 mt-3">
                    Last tx:{' '}
                    <a href={getTxUrl(poolChainId, lastHash)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                      {shortenAddress(lastHash, 6)} ↗
                    </a>{' '}
                    {lastOutcome.isSuccess
                      ? '· confirmed'
                      : lastOutcome.isReverted
                        ? '· REVERTED on-chain'
                        : lastOutcome.isReceiptUnreadable
                          ? "· couldn't read the result, so we can't tell whether it went through. Check the link before sending it again"
                          : lastOutcome.isReplaced
                            ? lastOutcome.replacement?.reason === 'cancelled'
                              ? '· cancelled in your wallet, so it did not happen'
                              : lastOutcome.replacement?.reason === 'replaced'
                                ? '· replaced in your wallet by another transaction, so it did not happen as sent'
                                : '· another transaction from your wallet confirmed in its place. Check the link before sending it again'
                            : '· pending'}
                  </p>
                )}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }} title={title}>
      <p className="text-[10px] uppercase tracking-wider text-white/50 mb-1">{label}</p>
      <p className="text-white text-[14px] tabular-nums">{value}</p>
    </div>
  );
}
