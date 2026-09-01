import { useEffect, useMemo, useState } from 'react';
import { useAccount, useChainId, useReadContracts, useSwitchChain, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits } from 'viem';
import { toast } from 'sonner';
import type { Bungalow } from '../../lib/bungalows';
import { LIGHTHOUSE_LADDER_ABI, ERC20_ABI } from '../../lib/contracts';
import {
  deriveLadder, boostLabel, boostBpsFor, projectedRawPerSec, penaltyOn, lockRemaining,
} from '../../lib/lighthouseLadder';
import { fmtRaw, fmtRunway } from '../../lib/evmLighthouse';
import { surfaceTxError } from '../../lib/txErrors';
import { getTxUrl, getAddressUrl } from '../../lib/explorer';
import { LOCK_DURATIONS } from '../../lib/copy';
import { CopyButton } from '../ui/CopyButton';
import { shortenAddress } from '../../lib/formatting';

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

const CHAIN_IDS: Record<string, number> = { ethereum: 1, base: 8453 };
const CHAIN_LABEL: Record<number, string> = { 1: 'Ethereum', 8453: 'Base' };
const PLACEHOLDER = '0x0000000000000000000000000000000000000001' as const;
const DAY = 86_400n;
// The venue's OWN lock tiers, straight from lib/copy.ts — the same six rungs,
// the same names, that the TOWELI farm has always shown. A staker meets one
// ladder across the whole island.
const RUNGS: { label: string; sublabel: string; secs: bigint }[] = LOCK_DURATIONS.map((d) => ({
  label: d.label,
  sublabel: d.sublabel,
  secs: BigInt(d.days) * DAY,
}));

type Pos = { id: bigint; lockEnd: bigint; amount: bigint; boosted: bigint };

export function EvmLadderPoolLive({ bungalow }: { bungalow: Bungalow & { stakePool: string } }) {
  const pool = bungalow.stakePool as `0x${string}`;
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
    ],
    query: { refetchInterval: 30_000 },
  });

  const big = (i: number): bigint | null => {
    const r = reads?.[i];
    return r && r.status === 'success' ? (r.result as bigint) : null;
  };
  const decimals = reads?.[6]?.status === 'success' ? Number(reads[6].result) : bungalow.decimals ?? 18;
  const poolToken = reads?.[12]?.status === 'success' ? String(reads[12].result) : null;
  const identityMismatch = poolToken !== null && poolToken.toLowerCase() !== token.toLowerCase();

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
  const ids = (user && reads?.[11]?.status === 'success' ? (reads[11].result as readonly bigint[]) : []) as readonly bigint[];

  const { data: posReads } = useReadContracts({
    contracts: ids.map((id) => ({ ...poolC, functionName: 'positions' as const, args: [id] as const })),
    query: { enabled: ids.length > 0, refetchInterval: 30_000 },
  });
  const positions: Pos[] = ids.map((id, i) => {
    const r = posReads?.[i];
    if (!r || r.status !== 'success') return null;
    const t = r.result as readonly [string, bigint, bigint, bigint];
    return { id, lockEnd: BigInt(t[1]), amount: t[2], boosted: t[3] };
  }).filter(Boolean) as Pos[];

  const { writeContractAsync } = useWriteContract();
  const [lastHash, setLastHash] = useState<`0x${string}` | undefined>();
  const { data: receipt } = useWaitForTransactionReceipt({ hash: lastHash, chainId: poolChainId });

  const amountRaw = (() => {
    try { return amount.trim() ? parseUnits(amount.trim(), decimals) : 0n; } catch { return null; }
  })();
  const chosen = RUNGS[rung]!;
  const needsApproval = amountRaw !== null && amountRaw > 0n && allowanceRaw !== null && allowanceRaw < amountRaw;
  const myBoostIfStaked = amountRaw === null ? 0n : (amountRaw * boostBpsFor(chosen.secs)) / 10_000n;
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

  return (
    <div className="relative overflow-hidden rounded-2xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
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
            This pool does not stake {bungalow.symbol} — it reports {shortenAddress(poolToken ?? '', 6)} as its staking
            token. That is a configuration error, not a network problem, so no figures are shown and nothing here
            will send a transaction.
          </p>
        ) : !view.coreKnown && !isLoading ? (
          <p className="text-[13px]" style={{ color: '#f0b26b' }}>
            The pool could not be read just now — figures are withheld rather than shown as zeros.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <Stat label="Reward vault" value={`${fmtRaw(view.vaultRaw, decimals)} ${bungalow.symbol}`} title="The contract's own rewardSurplus(): its balance minus every staker's principal. This is what it can actually pay." />
              <Stat label="Total staked" value={`${fmtRaw(big(0), decimals)} ${bungalow.symbol}`} />
              <Stat label="Pool pays (all stakers)" value={view.payingNowRawPerSec === null ? '—' : `${fmtRaw(view.payingNowRawPerSec * 86_400n, decimals)}/day`} title="Pool-wide, shared across every staker by lock weight — not your personal rate." />
              <Stat label="Runway" value={view.everFunded === false ? 'not started' : fmtRunway(view.runwaySecs)} title="Exact seconds to periodFinish, read on-chain." />
            </div>

            {view.everFunded === false ? (
              <p className="text-[12px] mb-4 rounded-lg p-3" style={{ background: 'rgba(240,178,107,0.08)', border: '1px solid rgba(240,178,107,0.35)', color: '#f0b26b' }}>
                No reward period has ever been started on this pool. Staking works and your principal is safe, but
                nothing accrues until the distributor funds it and calls notify — tokens merely sent to the pool
                earn no one anything.
              </p>
            ) : unfunded && (
              <p className="text-[12px] mb-4 rounded-lg p-3" style={{ background: 'rgba(240,178,107,0.08)', border: '1px solid rgba(240,178,107,0.35)', color: '#f0b26b' }}>
                The reward vault is empty, so the pool pays 0 today.
              </p>
            )}

            <p className="text-[11px] text-white/60 mb-4 leading-relaxed">
              Longer locks earn a larger <em>share</em> — 0.40× at seven days up to 4.00× at four years, the
              same ladder the TOWELI farm uses. Rewards are
              never paid out of anyone&apos;s principal: the contract caps every payout at its surplus, so your
              deposit can always come back. Leaving before your lock opens costs 25%, which stays in the pool for
              the stakers who waited. <strong>Emergency withdraw is always open</strong> and needs nothing from the
              reward side.
            </p>

            {/* THE LADDER IS PUBLIC. TOWELI's farm shows its lock tiers to every
                visitor, connected or not — a ladder you must connect a wallet
                to even SEE is a ladder nobody climbs. Only the amount field
                and the buttons below need a wallet. */}
            <p className="text-[10px] uppercase tracking-wider text-white/50 mb-2">Lock duration</p>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {RUNGS.map((r, i) => (
                <button key={r.label} type="button" onClick={() => setRung(i)}
                  className="rounded-lg px-2 py-2 text-[12px] border transition-colors"
                  style={{
                    background: i === rung ? 'rgba(127,224,176,0.14)' : 'rgba(0,0,0,0.4)',
                    borderColor: i === rung ? accent : 'rgba(255,255,255,0.12)',
                    color: i === rung ? '#fff' : 'rgba(255,255,255,0.75)',
                  }}>
                  {r.sublabel}
                  <span className="block text-[10px] text-white/50">{boostLabel(r.secs)}</span>
                  <span className="block text-[9px] text-white/35 truncate">{r.label}</span>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-white/45 mb-4">
              {boostLabel(chosen.secs)} for {chosen.sublabel} — {chosen.label}. Weight decides your share of the
              pool&apos;s rate; it is not a multiplier on your own deposit.
            </p>

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


                <div className="flex items-center gap-2 mb-2">
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
                    placeholder={`Amount (${bungalow.symbol})`} aria-label={`Amount of ${bungalow.symbol} to stake`}
                    className="flex-1 min-w-0 rounded-lg px-3 py-2 text-[13px] bg-black/50 border border-white/15 text-white placeholder-white/35" />
                  <button type="button" className="text-[11px] text-white/60 hover:text-white underline underline-offset-2"
                    onClick={() => walletRaw !== null && setAmount(fmtRaw(walletRaw, decimals, 6).replace(/,/g, ''))}>max</button>
                </div>
                <p className="text-[11px] text-white/50 mb-3">
                  Wallet: {fmtRaw(walletRaw, decimals)} {bungalow.symbol}
                  {amountRaw !== null && amountRaw > 0n && (
                    <>
                      {' · '}at {boostLabel(chosen.secs)}
                      {soloPool
                        ? ' — you would be the only staker, so you would earn the whole rate whatever you lock'
                        : projected !== null && projected > 0n
                          ? ` — about ${fmtRaw(projected * 86_400n, decimals)} ${bungalow.symbol}/day at today's total weight`
                          : ''}
                    </>
                  )}
                </p>

                <div className="flex flex-wrap gap-2 mb-4">
                  {needsApproval ? (
                    <button type="button" disabled={busy !== null || !amountRaw} className="btn-primary px-5 py-2 text-[13px] disabled:opacity-50"
                      onClick={() => send('approve', () => writeContractAsync({ ...tokenC, functionName: 'approve', args: [pool, amountRaw ?? 0n] }))}>
                      {busy === 'approve' ? 'Approving…' : `Approve ${bungalow.symbol}`}
                    </button>
                  ) : (
                    <button type="button" disabled={busy !== null || !amountRaw || amountRaw === 0n || (walletRaw !== null && amountRaw > walletRaw)}
                      className="btn-primary px-5 py-2 text-[13px] disabled:opacity-50"
                      onClick={() => send('stake', () => writeContractAsync({ ...poolC, functionName: 'stake', args: [amountRaw ?? 0n, chosen.secs] }))}>
                      {busy === 'stake' ? 'Staking…' : walletRaw !== null && amountRaw !== null && amountRaw > walletRaw ? 'More than your balance' : `Stake for ${chosen.label}`}
                    </button>
                  )}
                  <button type="button" disabled={busy !== null || earnedRaw === null || earnedRaw === 0n} className="btn-secondary px-5 py-2 text-[13px] disabled:opacity-50"
                    onClick={() => send('claim', () => writeContractAsync({ ...poolC, functionName: 'getReward' }))}>
                    {busy === 'claim' ? 'Claiming…' : 'Claim rewards'}
                  </button>
                </div>

                {positions.length > 0 && (
                  <div className="rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <p className="text-[10px] uppercase tracking-wider text-white/50 mb-2">Your positions</p>
                    <div className="space-y-2">
                      {positions.map((p) => {
                        const left = lockRemaining(p.lockEnd, nowSecs);
                        const open = left === 0n;
                        const fee = penaltyOn(p.amount);
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
                                title={`Leaving early costs ${fmtRaw(fee, decimals)} ${bungalow.symbol} (25%), which stays in the pool for the stakers who waited.`}
                                onClick={() => send('e' + p.id, () => writeContractAsync({ ...poolC, functionName: 'earlyExit', args: [p.id] }))}>
                                Exit early (−{fmtRaw(fee, decimals)})
                              </button>
                            )}
                            <button type="button" disabled={busy !== null} className="text-[11px] text-white/45 hover:text-white underline underline-offset-2"
                              title="Principal only, forfeiting unclaimed rewards, using nothing from the reward side. Always available — this is the last resort if rewards are ever broken."
                              onClick={() => send('x' + p.id, () => writeContractAsync({ ...poolC, functionName: 'emergencyWithdraw', args: [p.id] }))}>
                              emergency
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
                    {receipt?.status === 'success' ? '· confirmed' : receipt ? '· REVERTED on-chain' : '· pending'}
                  </p>
                )}
              </>
            ) : (
              <p className="text-[12px] text-white/60">
                Connect a wallet to stake. The figures above are live either way.
              </p>
            )}
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
