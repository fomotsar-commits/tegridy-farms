// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { m } from 'framer-motion';
import { useWallet } from '@solana/wallet-adapter-react';
import { useSolanaConnect } from '../solana/useSolanaConnect';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { SolanaProviders } from '../solana/SolanaProviders';
import type { Bungalow } from '../../lib/bungalows';
import { staggerContainer } from '../../lib/motion';
import { Fact, HAIR, DIVIDED_BG } from './ledger';
import { HeldTimeLine } from './HeldTimeLine';
import {
  vaultIsMateriallyEmpty,
  payingNowRate,
  readPool,
  readEntries,
  readShareBasis,
  readConfirmedSlot,
  readWalletBalance,
  stake,
  unstakeAndClaim,
  unstakeAndCloseForfeitingRewards,
  claimBrokenByRateChange,
  anyClaimBrokenByRateChange,
  splitAccruedByRisk,
  offeredMaxLockDays,
  lockCeilingApplies,
  OFFERED_LOCK_CEILING_DAYS,
  claimRewards,
  lockPresets,
  defaultLockDays,
  labelForDays,
  stakeWeight,
  stakeWeightScaled,
  isFlatWeight,
  quotesAConfiguredRate,
  WEIGHT_SCALE,
  configuredAnnualRate,
  rateIsPercent,
  vaultRunwaySecs,
  unlockTs,
  type PoolView,
  type RewardPoolView,
  type StakeEntryView,
} from '../../lib/bungalowStaking';
import { sharePct } from '../../lib/ladder/program';
import { basisBehindWrite, FENCE_RETRY_MS, type WriteFence } from '../../lib/ladder/writeFence';

/**
 * The lighthouse pool, LIVE — rendered by BungalowFarmPanel when the
 * bungalow has a configured Streamflow stake-pool address.
 *
 * SHAPE: this is the Solana twin of the venue's own TOWELI StakingCard —
 * amount field with a real balance + MAX, lock duration as a radiogroup of
 * preset buttons (not a bare number spinner), the rate each lock earns
 * printed ON the button, a projected-earnings strip, and a positions list
 * that knows when a lock actually opens.
 *
 * FUNDING-LAST honesty contract, unchanged and load-bearing:
 *  - the reward vault balance is the headline number, straight off-chain;
 *  - the rate is shown TWICE and the two are never conflated: "paying now"
 *    (0% while the vault is empty — a real, labeled zero) and "configured"
 *    (what the program is set to pay, labeled as configuration);
 *  - every projection is stamped with the same caveat and reads 0 while the
 *    vault is dry;
 *  - a failed read is an OUTAGE state, never rendered as zero;
 *  - when a pool grants no duration bonus (minWeight == maxWeight — true of
 *    the RETIRED first BAYLA pool; the live 5x-ladder pool is NOT this case)
 *    the panel SAYS SO, instead of implying a boost curve that does not
 *    exist — and conversely shows the real ladder when one is configured.
 *
 * All writes are the SDK's own grouped flows (stake+entries, unstake+claim)
 * through the connected wallet; every action reports its tx signature or
 * its honest failure inline.
 */
export function LighthousePoolLive({ bungalow }: { bungalow: Bungalow & { stakePool: string } }) {
  return (
    <SolanaProviders>
      <Inner bungalow={bungalow} />
    </SolanaProviders>
  );
}

const DAY = 86_400;

function fmt(raw: bigint | null, decimals: number, maxFrac = 2): string {
  if (raw === null) return '–';
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals) || '0';
  const frac = decimals > 0 ? s.slice(-decimals).replace(/0+$/, '') : '';
  const wholeNum = Number(whole);
  const wholeFmt = Number.isSafeInteger(wholeNum) ? wholeNum.toLocaleString() : whole;
  const out = frac ? `${wholeFmt}.${frac.slice(0, maxFrac)}` : wholeFmt;
  return neg ? `-${out}` : out;
}

/**
 * Raw base units -> a plain, LOCALE-FREE decimal string.
 *
 * AUDIT (2026-09-01). MAX used to round-trip `fmt()` — a DISPLAY string — back
 * through `toRaw()` after stripping commas. `fmt` groups with
 * `toLocaleString()`, so in any dot-grouping locale (de-DE, pt-BR, it-IT,
 * nl-NL) a balance of 1234 with no fraction renders as "1.234", survives the
 * comma-strip untouched, and parses as **1.234 tokens instead of 1234** — a
 * silent factor-of-1000 under-stake, with the wallet showing the right number
 * the whole way. In space-grouping locales (fr-FR, es-ES) it instead fails to
 * parse and the button dead-ends.
 *
 * The rule this encodes: a value that will be parsed again must never be built
 * by a formatter whose job is to be readable. Display and data are different
 * strings.
 */
function toPlain(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals) || '0';
  const frac = decimals > 0 ? s.slice(-decimals).replace(/0+$/, '') : '';
  return frac ? `${whole}.${frac}` : whole;
}

function toRaw(human: string, decimals: number): bigint | null {
  const t = human.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  try { return BigInt(w + frac); } catch { return null; }
}

/** Raw base units → a plain number, for projections only (never for a write). */
function toNum(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

function pct(rate: number): string {
  const p = rate * 100;
  if (p === 0) return '0%';
  if (p < 0.01) return '<0.01%';
  return `${p.toLocaleString(undefined, { maximumFractionDigits: p < 10 ? 2 : 1 })}%`;
}

function humanDuration(secs: number): string {
  if (secs <= 0) return 'now';
  const d = Math.floor(secs / DAY);
  // A well-funded vault against a small stake produces enormous runways — the
  // first 1M BAYLA top-up rendered as "55555d", which is a five-digit number
  // nobody can read as 152 years. Roll up past a year (and past a month) so the
  // figure stays a quantity a person can hold. Below a year the day count is
  // still the most useful unit, so it is kept.
  if (d >= 365) {
    const y = d / 365;
    return `${y >= 10 ? Math.round(y) : y.toFixed(1)}y`;
  }
  if (d >= 60) return `${Math.round(d / 30)}mo`;
  if (d >= 1) return `${d}d`;
  const h = Math.floor(secs / 3600);
  if (h >= 1) return `${h}h`;
  return `${Math.max(1, Math.floor(secs / 60))}m`;
}

/** A write fence, plus the signature it belongs to (so a late slot lands on its own write). */
type SigFence = WriteFence & { sig: string };

/**
 * Give the fence for `sig` the slot that write confirmed at, once it can be read. A
 * slot that cannot be read leaves it null, which is stale (fail closed); the card's
 * retry asks again. A later write's fence is never overwritten by an earlier answer.
 */
function refineFence(sig: string, set: (f: (prev: SigFence | null) => SigFence | null) => void) {
  void readConfirmedSlot(sig).then((slot) => {
    if (slot === null) return;
    set((f) => (f && f.sig === sig ? { ...f, slot } : f));
  });
}

function Inner({ bungalow }: { bungalow: Bungalow & { stakePool: string } }) {
  const { publicKey, wallet } = useWallet();
  const openConnect = useSolanaConnect();
  const fid = useId();

  const [poolRead, setPoolRead] = useState<{ ok: true; pool: PoolView } | { ok: false; reason: string } | null>(null);
  // Entries + balance keyed by wallet: a disconnect/switch is handled by
  // DERIVING the visible values from the key match (never a synchronous
  // setState in an effect — react-hooks/set-state-in-effect).
  // list:null = not loaded or FAILED — an outage, never "no stakes": rendering
  // a failed read as an empty list makes locked funds look gone and lets a
  // new stake collide with an unseen open nonce.
  const [entriesRead, setEntriesRead] = useState<{ key: string; list: StakeEntryView[] | null; reason: string | null }>({ key: '', list: null, reason: null });
  const [balanceRead, setBalanceRead] = useState<{ key: string; raw: bigint | null }>({ key: '', raw: null });
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState<number | null>(null);
  const [customDays, setCustomDays] = useState('');
  const [action, setAction] = useState<{ busy?: string; note?: string; tx?: string } | null>(null);
  // Two-step confirm for the principal-rescue exit. It forfeits accrued rewards, so it
  // must never be a single mis-click.
  // ⚠️ ARMED AGAINST ONE READ (the ladder card's `confirmFor`). Nonces restart at 0 for
  // every wallet, so a bare nonce armed on wallet A's entry #0 came up pre-armed on
  // wallet B's entry #0 after a switch — and one click forfeited B's rewards. The armed
  // nonce is stored with the exact entries read its row was drawn from, and any other
  // read (another wallet's, or a fresh one) renders it disarmed (`rescueArmed` below).
  const [rescueFor, setRescueFor] = useState<{ read: typeof entriesRead; nonce: number } | null>(null);
  // One tick a minute keeps every "unlocks in 12d" countdown honest without a
  // render loop — same cadence the TOWELI staking card uses.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(t);
  }, []);

  const walletKey = publicKey?.toBase58() ?? '';
  const poolMint = poolRead?.ok ? poolRead.pool.mint : '';
  // AUDIT FIX TF-035: prove this pool really stakes THIS bungalow's mint before
  // any figure is trusted. The EVM sibling has carried this guard since its
  // design review (EvmLadderPoolLive.tsx:100); the Solana card read the pool
  // and rendered its numbers without ever comparing the mint. A mispasted
  // base58 in one of the four sibling `stakePool` literals (bungalows.ts:336-346
  // — four one-liners edited in one batch, the classic mispaste shape), or a
  // stale VITE_BAYLA_STAKE_POOL, which bungalows.ts:182-183 warns "WINS over
  // this constant", would render a stranger pool's figures under our symbol and
  // point the stake button at a stranger's token.
  // base58 is case-SENSITIVE — no case folding here, unlike the EVM sibling.
  const identityMismatch = poolMint !== '' && poolMint !== (bungalow.address ?? '');

  // ⚠️ EVERY POOL AND ENTRIES READ IS STARTED BY THE ONE EFFECT BELOW, so a newer read
  // cancels an older one. `run()` used to call a `refresh()` directly after each
  // confirmed write and drop the cancellation it returned; setPoolRead/setEntriesRead
  // then took whatever resolved LAST, and a slow older read could land after a newer
  // one and put a stale, smaller pool back under every figure on the card. A write now
  // bumps this generation instead — the ladder card's pattern (SolanaLadderPoolLive).
  const [readGen, setReadGen] = useState(0);
  const reread = () => setReadGen((n) => n + 1);

  // ⚠️ A READ THAT PREDATES YOUR CONFIRMED WRITE — the ladder card's two guards.
  //
  // IDENTITY (the ladder's `staleRead`): the entries read on screen when a write
  // confirms is held here, and while it is STILL the one on screen it is "updating…",
  // never restated. Without it, a first stake left the pre-stake read (complete, and
  // empty) on screen until the re-read landed, and "Your share" said "nothing staked."
  // to someone whose stake had just confirmed. Any newer read is not stale.
  //
  // RECENCY (the ladder's `writeFence`, dc2a4578): identity is not recency. A re-read
  // served by an RPC node still BEFORE the write is a consistent picture of the past —
  // pool 100, you hold A=10 and B=10, your exit of A confirms at slot 500, a node at
  // 498 serves A and B open over 100 and the card printed 20% for a true 10/90 = 11.1%.
  // So the slot the write CONFIRMED at fences the share basis, keyed to the wallet that
  // wrote: a basis below it, or a missing slot on either side, is "updating…" (fail
  // closed). The fence is set the moment the write confirms, with slot null — so it is
  // closed even before the slot is known — then given the slot once it is read.
  const [staleEntries, setStaleEntries] = useState<typeof entriesRead | null>(null);
  const latestEntriesRead = useRef(entriesRead);
  useEffect(() => { latestEntriesRead.current = entriesRead; }, [entriesRead]);
  const [writeFence, setWriteFence] = useState<SigFence | null>(null);

  useEffect(() => {
    let cancelled = false;
    readPool(bungalow.stakePool).then((r) => { if (!cancelled) setPoolRead(r); });
    if (walletKey) {
      readEntries(bungalow.stakePool, walletKey).then((r) => {
        if (cancelled) return;
        if (r.ok) setEntriesRead({ key: walletKey, list: r.entries, reason: null });
        else setEntriesRead({ key: walletKey, list: null, reason: r.reason });
      });
    }
    return () => { cancelled = true; };
  }, [bungalow.stakePool, walletKey, readGen]);

  // Wallet balance needs the pool's mint, so it rides its own effect that runs
  // once both are known.
  useEffect(() => {
    if (!walletKey || !poolMint) return;
    let cancelled = false;
    readWalletBalance(poolMint, walletKey).then((r) => {
      if (!cancelled) setBalanceRead({ key: walletKey, raw: r.ok ? r.raw : null });
    });
    return () => { cancelled = true; };
  }, [walletKey, poolMint, action?.tx]);

  const entriesForWallet = walletKey && entriesRead.key === walletKey ? entriesRead : null;
  const rescueArmed = rescueFor !== null && rescueFor.read === entriesRead ? rescueFor.nonce : null;
  const entriesKnown = entriesForWallet?.list !== null && entriesForWallet !== null;
  const entries = entriesForWallet?.list ?? [];
  // THREE STATES, NOT TWO (the ladder card's rule): not read yet, read and failed, and
  // a number. They used to print the same "–", so a pending read looked like an outage.
  const balanceLoaded = Boolean(walletKey) && balanceRead.key === walletKey;
  const walletRaw = balanceLoaded ? balanceRead.raw : null;

  const pool = poolRead?.ok ? poolRead.pool : null;
  const decimals = pool?.decimals ?? bungalow.decimals ?? 6;
  // Vault headline: ONLY reward pools paying the STAKE mint sum into the
  // "{symbol}" figure — a foreign-mint reward pool has different decimals,
  // and adding its raw units would fabricate the number. Zero same-mint
  // pools reads as null (outage), never as a real zero.
  const sameMintPools = pool ? pool.rewardPools.filter((rp) => rp.mint === pool.mint) : [];
  const funded: bigint | null = pool && sameMintPools.length > 0
    ? sameMintPools.reduce<bigint | null>((acc, rp) => (acc === null || rp.fundedRaw === null ? null : acc + rp.fundedRaw), 0n)
    : null;
  const minDays = pool ? Math.max(1, Math.ceil(pool.minDurationSecs / DAY)) : 1;
  // The VENUE's ceiling, not the pool's — see OFFERED_LOCK_CEILING_DAYS. This
  // clamps the presets, the custom-days input and `chosenDays` from one place,
  // so no path can select a lock the ladder buttons never offered.
  const maxDays = pool ? offeredMaxLockDays(pool) : minDays;
  const poolMaxDays = pool ? Math.max(minDays, Math.floor(pool.maxDurationSecs / DAY)) : minDays;
  const ceilingApplies = pool ? lockCeilingApplies(pool) : false;
  // The OFFERED ladder — the pool's own presets clamped to the venue ceiling.
  const presets = useMemo(
    () => (pool ? lockPresets(pool, OFFERED_LOCK_CEILING_DAYS) : []),
    [pool],
  );
  // SAFE DEFAULT (2026-08-29): the SHORTEST lock the pool allows, never a
  // pre-selected 30 days — see defaultLockDays() for why this is a safety
  // invariant rather than a preference.
  const defaultDays = defaultLockDays(presets, minDays);
  const chosenDays = Math.min(maxDays, Math.max(minDays, days ?? defaultDays));
  const chosenSecs = chosenDays * DAY;
  const amountRaw = toRaw(amount, decimals);
  // The largest single position this lock length can carry before the classic
  // reward program's cumulative counter overflows mid-term. `null` when no
  // reward pool imposes one (dynamic pool, zero rate, unreadable config) — and
  // an absent cap must never read as a cap of zero, so the gate below requires
  // a non-null value before it blocks anything.
  // NO SIZE CAP. There used to be a `safeCapRaw` here that refused any stake big
  // enough for its reward counter to pass 2**64-1 before the lock opened (~16,712
  // BAYLA at the 365-day rung). That danger is not real: on this pool the
  // 1,000,000 / 535,000 / 369,369 positions all claim normally, and the only two
  // that cannot be paid are the two SMALLEST. See `claimBrokenByRateChange`.
  const invoker = wallet?.adapter as SignerWalletAdapter | undefined;
  const openEntries = entries.filter((e) => e.closedTs === 0);

  // The reward pool the headline rate speaks for. Multi-reward pools are legal;
  // the venue has never run one, so the strip names the first and the per-entry
  // list still itemises every pool it finds.
  const primaryRp: RewardPoolView | null = sameMintPools[0] ?? pool?.rewardPools[0] ?? null;
  // EXIT SAFETY (devnet-proven 2026-08-28, error 6012, same program ids as
  // mainnet): while accrued rewards exceed the vault, claim AND unstake&claim
  // REVERT — principal is locked until the vault is topped up past accrual
  // (the backlog itself survives). So new stakes PAUSE while the vault is
  // materially empty: an open deposit form here would invite a lock nothing
  // can open until someone funds the vault.
  const vaultDry = pool && primaryRp ? vaultIsMateriallyEmpty(pool, primaryRp) : false;
  const stakeBlocked = !entriesKnown || funded === null || vaultDry;
  const ratePercent = pool && primaryRp ? rateIsPercent(pool, primaryRp) : false;
  const configuredRate = pool && primaryRp ? configuredAnnualRate(pool, primaryRp, chosenSecs) : 0;
  // A weighted pool has no single "configured rate" — it has a RANGE, and the
  // headline must say so. Keying the top-line stat off the selected lock made
  // it read 21.9% by default on a pool that reaches 109.5%, which undersells
  // the ladder to anyone who never touches the picker. The per-lock number
  // still lives on the buttons, where the choice is actually made.
  const weighted = pool ? !isFlatWeight(pool) : false;
  const rateAtMin = pool && primaryRp ? configuredAnnualRate(pool, primaryRp, pool.minDurationSecs) : 0;
  // THE HEADLINE MUST QUOTE A RUNG SOMEONE CAN ACTUALLY PICK.
  //
  // `maxDays` is the OFFERED ceiling (OFFERED_LOCK_CEILING_DAYS), and the presets,
  // the custom-days input and `chosenDays` are all clamped to it. These two stats
  // were still reading `pool.maxDurationSecs`, so a pool configured to 365 days
  // advertised its 365-day boost and APR beside a ladder that stops at 90 — the
  // top number in the card was for a lock the form refuses to submit. Quote the
  // longest lock actually on offer; :628 separately explains that the pool itself
  // allows more and that those rungs are paused.
  const offeredMaxSecs = maxDays * DAY;
  const rateAtMax = pool && primaryRp ? configuredAnnualRate(pool, primaryRp, offeredMaxSecs) : 0;
  const maxBoost = pool ? stakeWeight(pool, offeredMaxSecs) : 1;
  // "Paying now" is the honest half: a configured rate the vault cannot back
  // pays nothing, and this venue says the zero out loud rather than printing
  // the configuration and hoping nobody checks the vault.
  // ONE predicate for "is this vault actually paying", used by the stat, the
  // banner, the stake gate and the projections alike. The old `funded > 0n`
  // disagreed with `vaultDry` in exactly the two states vaultIsMateriallyEmpty
  // exists for — dust (< 1 whole token) and under a day of runway — so a pool
  // holding dust printed the full configured APR in green DIRECTLY ABOVE a
  // banner reading "Paying now is 0%". (vaultDry is false when the vault is
  // unreadable, so this keeps an outage out of the zero branch.)
  const payingNow = payingNowRate(configuredRate, funded, vaultDry);
  const flatWeight = pool ? isFlatWeight(pool) : true;
  const runwaySecs = pool && primaryRp ? vaultRunwaySecs(pool, primaryRp) : null;

  /**
   * DYNAMIC-POOL MODE. A dynamic reward pool has no rate fields at all, so
   * every rate helper above returns a bare 0 for it. Printing that as "0% APR"
   * would report an ABSENT number as a measured one — the same lie as
   * rendering a failed read as a zero balance — so in this mode the panel does
   * not quote a rate AT ALL.
   *
   * Instead it shows the two things that are actually true and checkable right
   * now: what is in the budget, and what SHARE of it a position holds. The
   * share is a present fact and needs no forecast. It is also the shape the
   * venue's US regulatory review asked for — a computed observation with its
   * inputs beside it, never a forward-looking yield on a number the operator
   * sets.
   */
  const dynamicPool = primaryRp ? !quotesAConfiguredRate(primaryRp) : false;

  // ⚠️ THE SHARE'S INPUTS COME FROM ONE SLOT (readShareBasis). The entries and the pool
  // land in separate requests, and dividing one by the other printed 20% for a true
  // 18.2% right after a stake (pool 100, you hold 10, +10: 20 of 110), and over-read
  // after an exit (an older entries read still counts the closed entry). So once the
  // entries read names the open entries, THOSE addresses and the pool are re-read in
  // ONE getMultipleAccountsInfo call. Only a dynamic pool prints a share, so only a
  // dynamic pool pays for the read. The basis is tied to the exact entries read it was
  // taken for (identity), and a newer entries read cancels an older basis read.
  const entriesList = entriesForWallet?.list ?? null;
  const [basisRead, setBasisRead] = useState<{
    list: StakeEntryView[];
    basis: { mineEffectiveRaw: bigint; totalEffectiveRaw: bigint; slot: number | null } | null;
  } | null>(null);
  useEffect(() => {
    if (!dynamicPool || !entriesList) return;
    const open = entriesList.filter((e) => e.closedTs === 0);
    if (open.length === 0) return;
    let cancelled = false;
    readShareBasis(bungalow.stakePool, open.map((e) => e.address)).then((basis) => {
      if (!cancelled) setBasisRead({ list: entriesList, basis });
    });
    return () => { cancelled = true; };
  }, [dynamicPool, entriesList, bungalow.stakePool]);
  // undefined = not read yet for THIS entries read; null = could not be established.
  const shareBasis = basisRead !== null && entriesList !== null && basisRead.list === entriesList
    ? basisRead.basis
    : undefined;
  const poolEffectiveRaw = pool?.totalEffectiveStakeRaw ?? null;
  // Share of everything the pool distributes while these positions stay open.
  //
  // ⚠️ THE LADDER'S RULES, THE LADDER'S FUNCTION. This used to be a float division
  // printed through `pct`, which ROUNDS (2/3 read 66.67%, and a half-up round prints a
  // share nobody holds), had NO upper bound (a wallet total above the pool total — the
  // entries and the pool land in separate reads — printed past 100%), and said "nothing
  // staked" whenever the wallet's entries had not been read, connected or not. Now:
  // `sharePct` floors to a tenth and refuses (null) on a missing or zero total and on
  // mine > total; it is only computed from a COMPLETE entries read; and "nothing
  // staked" is reserved for a complete read that found no open stake.
  //
  // SAME-SLOT, OR NOTHING (2026-09-21) — the ladder's rule (add8127f). The figure is
  // computed from `shareBasis`, never from the entries read over the pool read. The
  // separately read pool still BOUNDS it: both go through `sharePct` and the LOWER is
  // printed, so a fresher, larger total (others staked since) can only make it smaller,
  // and one below your own weight means the reads disagree and the figure is refused.
  // The entries read on screen is the one a confirmed write of yours was made over.
  const entriesStale = staleEntries !== null && entriesForWallet !== null && entriesRead === staleEntries;
  // A basis older than your own confirmed write, or one whose slot — or the write's —
  // is unknown, is "updating…", never a share (see `writeFence`).
  const shareStale = Boolean(shareBasis) && basisBehindWrite(writeFence, walletKey, shareBasis?.slot);
  const updating = entriesStale || shareStale;
  const nothingStaked = entriesKnown && openEntries.length === 0 && !entriesStale;
  const myShare = (() => {
    if (!entriesKnown || nothingStaked || !shareBasis || updating) return null;
    const own = sharePct({ mineWeight: shareBasis.mineEffectiveRaw, totalWeighted: shareBasis.totalEffectiveRaw, truncated: false });
    const bound = sharePct({ mineWeight: shareBasis.mineEffectiveRaw, totalWeighted: poolEffectiveRaw, truncated: false });
    if (!own || !bound) return null;
    return own.pct <= bound.pct ? own : bound;
  })();
  const shareNote = !publicKey
    ? 'connect a wallet to see yours.'
    : updating
      ? 'updating…'
      : nothingStaked
      ? 'nothing staked.'
      : !entriesForWallet || (entriesKnown && shareBasis === undefined)
        ? 'reading your stakes…'
        : myShare === null
          ? 'could not be read.'
          : 'of each payout — it moves as others stake.';

  const stakedTotal = openEntries.reduce((a, e) => a + e.amountRaw, 0n);
  // THE HEADER TOTAL MUST NOT COUNT WHAT CAN NEVER BE PAID. This reduce was a
  // byte-for-byte twin of the dashboard's, and had the same defect: a position
  // past the u64 ceiling still reports a pending figure, so a dead position read
  // as "N accrued" at the top of the page. Less visible than the dashboard's
  // only because the per-entry rescue sits a few hundred pixels below it — the
  // same lie, in smaller type. Split, so the header states the claimable figure
  // and the stranded amount is named separately rather than folded in.
  const { claimableRaw: pendingTotal, atRiskRaw: pendingAtRisk, atRiskCount: pendingAtRiskCount } =
    splitAccruedByRisk(openEntries, pool?.rewardPools ?? []);

  const overBalance = amountRaw !== null && walletRaw !== null && amountRaw > walletRaw;

  // ⚠️ "updating…" MUST NOT BECOME PERMANENT. This card has no standing poll (only the
  // minute clock), so a re-read that lands from a node still behind your write would
  // leave the share fenced until the next write or a reload. While it is fenced the card
  // re-reads on a timer — and asks again for the write's slot if it has none — and stops
  // as soon as a read at or past the write lands. Not while a write is in flight (its own
  // completion re-reads) or while a principal rescue is armed (nothing moves under a
  // two-step confirm). Costs nothing when nothing is fenced.
  const fenceSig = writeFence && writeFence.slot === null ? writeFence.sig : null;
  useEffect(() => {
    if (!updating || action?.busy || rescueArmed !== null) return;
    const t = setInterval(() => {
      setReadGen((n) => n + 1);
      if (fenceSig) refineFence(fenceSig, setWriteFence);
    }, FENCE_RETRY_MS);
    return () => clearInterval(t);
  }, [updating, action?.busy, rescueArmed, fenceSig]);

  const run = async (label: string, fn: () => Promise<{ ok: true; txId: string } | { ok: false; reason: string }>) => {
    setAction({ busy: label });
    const res = await fn();
    if (res.ok) {
      setStaleEntries(latestEntriesRead.current);
      setWriteFence({ key: walletKey, slot: null, sig: res.txId });
      refineFence(res.txId, setWriteFence);
      setAction({ note: `${label} confirmed.`, tx: res.txId });
      setAmount('');
      reread();
    } else {
      setAction({ note: res.reason });
    }
  };

  // The ledger's cells. `unit` is only ever a unit (or the qualifier that makes the
  // number true, like the lock a boost is quoted at) — it shares the number's
  // baseline. Everything that is a sentence goes in `note`, printed as a footnote.
  const lhCells: LhCell[] = !pool ? [] : [
    {
      key: 'vault',
      label: dynamicPool ? 'Reward budget' : 'Reward vault',
      value: fmt(funded, decimals),
      unit: bungalow.symbol,
      note: dynamicPool ? 'what is left to distribute.' : undefined,
    },
    { key: 'staked', label: 'Total staked', value: fmt(pool.totalStakeRaw, decimals), unit: bungalow.symbol },
    ...(dynamicPool
      ? [
          // No rate exists on this program, so none is invented. What a position
          // holds is its SHARE — a present fact, not a forecast — and it is the
          // number that actually determines the payout.
          {
            key: 'share',
            label: 'Your share',
            value: myShare === null ? '–' : myShare.label,
            tone: myShare === null ? 'muted' as const : 'good' as const,
            note: shareNote,
          },
          { key: 'pays', label: 'How it pays', value: 'Budget', note: 'not a fixed rate — split by weighted stake.' },
        ]
      : [
          {
            key: 'now',
            label: 'Paying now',
            value: ratePercent ? pct(payingNow) : payingNow.toLocaleString(undefined, { maximumFractionDigits: 4 }),
            unit: ratePercent ? 'APR' : `per ${bungalow.symbol}/yr`,
            tone: payingNow > 0 ? 'good' as const : 'muted' as const,
          },
          {
            key: 'configured',
            label: 'Configured',
            value: !ratePercent
              ? configuredRate.toLocaleString(undefined, { maximumFractionDigits: 4 })
              : weighted
                ? `${pct(rateAtMin)}–${pct(rateAtMax)}`
                : pct(configuredRate),
            unit: ratePercent ? 'APR' : `per ${bungalow.symbol}/yr`,
            note: weighted ? `${labelForDays(minDays)} → ${labelForDays(maxDays)}.` : undefined,
          },
        ]),
    ...(weighted
      ? [{
          key: 'boost',
          label: 'Max boost',
          value: `${maxBoost.toFixed(2)}×`,
          unit: `at ${labelForDays(maxDays).toLowerCase()}`,
          note: 'longer lock, bigger share.',
        }]
      : []),
  ];

  const setLockDays = (d: number) => {
    setDays(d);
    setCustomDays('');
  };

  return (
    // SECONDARY, WHOLE (2026-09-20): a quieter border, no glow loop, a heavier scrim,
    // and every control it has. Drawn for an open pool, or a closed one with no ladder;
    // a closed pool beside a ladder is members-only and gets LighthouseClaimStrip.
    <div className="relative overflow-hidden rounded-2xl" style={{ border: '1px solid var(--color-purple-25)' }}>
      {/* ART VISIBILITY 2026-08-31 (owner): this scrim was 0.85 and the
          resident's art underneath was barely readable — a dark page scrim
          plus a dark card scrim stacked into near-black. Lightened hard.
          Safe because the dense copy inside sits on its OWN panels
          (rgba(0,0,0,0.4-0.6) blocks), so contrast is carried there and
          not by drowning the whole card. */}
      <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.62)' }} />
      <div className="relative z-10 p-5 sm:p-6">
        {/* HONESTY FIX: this eyebrow said "LIVE" while the pool was closed to
            deposits. Closed, it now says exactly what still works. */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {bungalow.depositsClosed ? (
            <p className="text-[11px] uppercase tracking-wider m-0" style={{ color: 'rgba(255,255,255,0.7)' }}>
              The lighthouse pool · closed to deposits · claims open
            </p>
          ) : (
            <p className="text-[11px] uppercase tracking-wider m-0" style={{ color: 'var(--color-kyle)' }}>The lighthouse pool · LIVE</p>
          )}
          {bungalow.depositsClosed && (
            <span className="rounded-full px-2 py-0.5 text-[11px]" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', color: 'rgba(255,255,255,0.78)' }}>
              Claim only
            </span>
          )}
        </div>

        {poolRead === null && <p className="text-white/70 text-[13px]">Reading the pool…</p>}

        {/* Nothing else re-reads a failed pool for a visitor with no wallet. */}
        {poolRead && !poolRead.ok && (
          <p className="text-[13px]" style={{ color: '#f0b26b' }}>
            {poolRead.reason}{' '}
            <button
              type="button"
              onClick={() => { setPoolRead(null); reread(); }}
              className="min-h-[44px] underline underline-offset-2"
            >
              Try again
            </button>
          </p>
        )}

        {/* AUDIT FIX TF-035: a configuration error, not a network problem — so
            no figures, and nothing below can send a transaction. Same shape and
            styling as EvmLadderPoolLive.tsx:175-180. */}
        {identityMismatch && (
          <p className="text-[13px] rounded-lg p-3" style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5' }}>
            This pool does not stake {bungalow.symbol} — it reports {poolMint.slice(0, 6)}…{poolMint.slice(-4)} as its
            staking mint. That is a configuration error, not a network problem, so no figures are shown and nothing
            here will send a transaction.
          </p>
        )}

        {pool && !identityMismatch && (
          <>
            {/* ── The numbers that decide whether to stake ────────────────── */}
            {/* THE LADDER CARD'S LEDGER, not a copy of it (./ledger). Units sit on
                the number's baseline; every sentence that used to sit inside a
                tile is a footnote under the panel, word for word, and each cell
                points at its own with aria-describedby. Columns come from the
                CARD's width (container query), never the viewport: list rows on a
                phone, two across, then one row — and an odd cell count never
                leaves an empty cell beside a lone tile, because the last cell
                spans (lhSpan). */}
            <section aria-label="The lighthouse pool figures" className="@container mb-4 flex flex-col gap-3">
              <m.div
                variants={staggerContainer(0.06)}
                initial="hidden"
                whileInView="show"
                viewport={{ once: true }}
                className="grid grid-cols-1 gap-px overflow-hidden rounded-[14px] @min-[30rem]:grid-cols-2 @min-[52rem]:grid-cols-12"
                style={{ background: DIVIDED_BG, border: `1px solid ${HAIR}` }}
              >
                {lhCells.map((c, i) => (
                  <Fact
                    key={c.key}
                    label={c.label}
                    value={c.value}
                    unit={c.unit}
                    tone={c.tone}
                    describedBy={c.note ? `${fid}-${c.key}` : undefined}
                    className={lhSpan(i, lhCells.length)}
                  />
                ))}
              </m.div>
              {lhCells.some((c) => c.note) && (
                <ul className="list-none m-0 p-0 flex flex-col gap-1 text-[11.5px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.62)' }}>
                  {lhCells.filter((c) => c.note).map((c) => (
                    <li key={c.key} id={`${fid}-${c.key}`}>
                      <strong className="font-semibold" style={{ color: '#fff' }}>{c.label} —</strong>{' '}{c.note}
                    </li>
                  ))}
                </ul>
              )}
              <HeldTimeLine chain={bungalow.chain} pool={bungalow.stakePool} />
            </section>

            {/* The whole model in two sentences, stated before anyone signs.
                A dynamic pool cannot honestly advertise an APR: what a staker
                earns depends on how much is funded and how many others are in,
                and BOTH move. Saying so plainly is the only accurate option —
                and the safest one. */}
            {dynamicPool && (
              <p className="text-[12px] mb-4 rounded-lg px-3 py-2" style={{ background: 'rgba(96,165,250,0.10)', border: '1px solid rgba(96,165,250,0.35)', color: '#bfdbfe' }}>
                <strong>This pool pays out a funded budget, not a fixed rate.</strong>{' '}
                Whatever is funded gets split across everyone staked, in proportion to
                weighted stake — so a longer lock still earns a bigger share
                {weighted ? ` (up to ${maxBoost.toFixed(2)}×)` : ''}, but the amount per
                {' '}{bungalow.symbol} falls as more people stake and rises as fewer do.
                There is no APR to quote here, and this venue will not invent one:
                the honest figures are the budget above and your share of it.
              </p>
            )}

            {vaultDry && (
              <p className="text-[12px] mb-4 rounded-lg px-3 py-2" style={{ background: 'rgba(227,179,65,0.1)', border: '1px solid rgba(227,179,65,0.4)', color: '#e3b341' }}>
                {/* Lead with the fact that changes what the visitor can DO. The
                    reason used to arrive first and the consequence fourth, which
                    buried "staking is paused" inside a paragraph of rate talk. */}
                <strong>Staking is paused until the reward vault is funded.</strong>{' '}
                The vault is {funded === 0n ? 'empty' : 'effectively empty'}, so paying now is 0% —
                {ratePercent ? ` a configured ${pct(rateAtMax)} tops out at nothing` : ' a configured rate pays nothing'}{' '}
                until someone tops it up.
                <span className="block mt-1.5 opacity-90">
                  Deposits stay closed on purpose: while accrued rewards exceed the vault
                  the program <strong>reverts</strong> claims and unstakes, even after a lock
                  opens — so a deposit here could become principal nothing can release.
                  Accrual itself is never lost; it pays in full after a top-up.
                </span>
              </p>
            )}
            {funded === null && (
              <p className="text-[12px] mb-4" style={{ color: '#f0b26b' }}>
                The reward vault could not be read. That is an outage, not a zero.
              </p>
            )}
            {funded !== null && !vaultDry && runwaySecs !== null && (
              <p className="text-[12px] mb-4" style={{ color: '#e3b341' }}>
                At today&rsquo;s stake and today&rsquo;s rate this vault funds about{' '}
                <strong>{humanDuration(runwaySecs)}</strong> of rewards. Anything past that assumes a top-up.
              </p>
            )}

            {/* ── Closed to new deposits ──────────────────────── */}
            {/* Replaces the stake form and NOTHING else. Claim, unstake and the
                principal rescue below are untouched by design: a closed door is
                for people arriving, never for people leaving. See
                `depositsClosed` in lib/bungalows.ts for why this pool is closed
                to new stakes while it keeps running. */}
            {bungalow.depositsClosed && (
              <div className="rounded-xl p-4 mb-4" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(227,179,65,0.4)' }}>
                <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: '#e3b341' }}>
                  Closed to new deposits
                </p>
                <p className="text-white/70 text-[12px] leading-relaxed">
                  This pool is no longer taking new stakes. It keeps running for everyone already in
                  it &mdash; rewards keep accruing, claims work, and every position comes back in full
                  when its lock opens.
                </p>
                <p className="text-white/50 text-[11px] leading-relaxed mt-2">
                  Existing locks stay where they are and keep running in this pool until the last one
                  matures; nothing in this pool is moved anywhere.
                </p>
                <p className="text-white/40 text-[11px] leading-relaxed mt-2">
                  To be exact about what changed: the pool still exists on-chain and its terms are
                  immutable. It is this venue that has stopped offering it, not the program that has
                  stopped accepting it.
                </p>
              </div>
            )}

            {/* THE WAY BACK IN, for a closed pool.
                The block below deliberately removes the stake form — and the
                only Connect button on this card used to live INSIDE it, so
                closing the door also took away the one control a returning
                staker needs to reach their claim, their unstake and their
                rescue. Every exit survived the flag; the way to REACH them did
                not. autoConnect hid it: anyone who had connected here before
                was reconnected on load and never saw the gap, while a first
                connection on this page — a new device, a cleared browser, or
                any wallet that was not selectable until now — was impossible.
                Keep this OUTSIDE the `!depositsClosed` block. */}
            {bungalow.depositsClosed && !publicKey && (
              <div className="rounded-xl p-4 mb-4" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-purple-25)' }}>
                <p className="text-white/80 text-[13px] mb-3 max-w-md leading-relaxed">
                  Already staked here? Connect your Solana wallet to claim rewards, or to unstake a
                  position whose lock has opened. This pool takes no new stakes, but nothing about
                  leaving it has changed.
                </p>
                <button type="button" onClick={openConnect} className="btn-primary px-6 py-2.5 text-[13px]">
                  Connect Solana Wallet
                </button>
              </div>
            )}

            {!bungalow.depositsClosed && (
            <>
            {/* ── Stake ──────────────────────────────────────────────────── */}
            <div className="rounded-xl p-4 mb-4" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-purple-25)' }}>
              <p className="text-[10px] uppercase tracking-wider mb-3" style={{ color: 'var(--color-kyle)' }}>Stake {bungalow.symbol}</p>
              {/* Amount + balance/MAX, the venue's own staking-card idiom. Only a
                  connected wallet has a balance to spend, so this half waits —
                  but the lock table below does NOT, because what each lock earns
                  is a fact about the pool, not about the visitor. */}
              {publicKey && (
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <label htmlFor="lh-amount" className="text-white text-[11px] uppercase tracking-wider label-pill">Amount</label>
                      <button
                        type="button"
                        disabled={walletRaw === null || walletRaw === 0n}
                        onClick={() => walletRaw !== null && setAmount(toPlain(walletRaw, decimals))}
                        className="text-white/60 text-[11px] hover:text-white transition-colors cursor-pointer disabled:cursor-default disabled:hover:text-white/60"
                      >
                        Balance: {!balanceLoaded ? '…' : walletRaw === null ? 'unreadable' : fmt(walletRaw, decimals)}{walletRaw !== null && walletRaw > 0n ? ' · MAX' : ''}
                      </button>
                    </div>
                    <input
                      id="lh-amount"
                      type="text"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.0"
                      spellCheck={false}
                      aria-label={`Amount of ${bungalow.symbol} to stake`}
                      className="w-full rounded-lg p-3.5 min-h-[44px] font-mono text-xl text-white placeholder:text-white/40 outline-none focus-visible:ring-2 focus-visible:ring-[#4CAF50]"
                      style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}
                    />
                    {overBalance && (
                      <p className="text-[11px] mt-1.5" style={{ color: '#f0b26b' }}>
                        That is more {bungalow.symbol} than this wallet holds.
                      </p>
                    )}
                  </div>
              )}

                  {/* Lock duration — buttons, each carrying the rate it earns. */}
                  <div className="mb-4">
                    <label id="lh-lock-label" className="text-white text-[11px] uppercase tracking-wider label-pill mb-2 block">Lock duration</label>
                    <div role="radiogroup" aria-labelledby="lh-lock-label" className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {presets.map((opt) => {
                        const selected = chosenDays === opt.days && customDays === '';
                        const optRate = primaryRp ? configuredAnnualRate(pool, primaryRp, opt.seconds) : 0;
                        return (
                          <button
                            key={opt.days}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => setLockDays(opt.days)}
                            className="rounded-lg px-2.5 py-2 min-h-[44px] text-center cursor-pointer transition-all"
                            style={{
                              background: selected ? 'var(--color-purple-75)' : 'rgba(0,0,0,0.55)',
                              border: selected ? '1px solid var(--color-purple-30)' : '1px solid rgba(255,255,255,0.25)',
                              color: selected ? '#000000' : 'rgba(255,255,255,1)',
                            }}
                          >
                            <span className="block text-[12px] leading-tight">
                              {selected && <span aria-hidden="true" className="mr-1">&#10003;</span>}
                              {opt.label}
                            </span>
                            {/* Multiplier alongside the rate, so each button is a
                                row of the boost schedule rather than a bare
                                percentage — the ladder is legible without having
                                to click through every option to compare. Hidden
                                on a flat pool, where every row would read 1.00x.
                                On a DYNAMIC pool the multiplier is the whole
                                story: there is no rate to print, and printing
                                the helpers' bare 0 would read as "this lock
                                earns 0%", which is false. */}
                            <span className="block text-[11px] leading-tight opacity-80 font-mono">
                              {weighted && `${stakeWeight(pool, opt.seconds).toFixed(2)}×`}
                              {dynamicPool
                                ? (weighted ? ' share' : '—')
                                : `${weighted ? ' · ' : ''}${ratePercent ? pct(optRate) : optRate.toLocaleString(undefined, { maximumFractionDigits: 3 })}`}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Any duration in the window is legal — the presets are a
                        convenience, not the whole range. */}
                    <div className="flex items-center gap-2 mt-2">
                      <label htmlFor="lh-days" className="text-white/55 text-[11px]">or exactly</label>
                      <input
                        id="lh-days"
                        type="number"
                        min={minDays}
                        max={maxDays}
                        value={customDays}
                        placeholder={String(chosenDays)}
                        onChange={(e) => {
                          const v = e.target.value;
                          setCustomDays(v);
                          const n = Number(v);
                          if (Number.isFinite(n) && v !== '') setDays(Math.max(minDays, Math.min(maxDays, Math.floor(n))));
                        }}
                        className="w-20 rounded-lg px-2.5 py-1.5 text-[13px] font-mono text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4CAF50]"
                        style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid var(--color-purple-25)' }}
                      />
                      <span className="text-white/55 text-[11px]">days ({minDays}–{maxDays})</span>
                    </div>

                    {vaultDry && (
                      <p className="text-[11px] mt-2" style={{ color: '#e3b341' }}>
                        Every rate on those buttons is the pool&rsquo;s <strong>configured</strong> rate.
                        {funded === 0n
                          ? ' With the vault at zero, all six of them pay 0 today.'
                          : ' The vault cannot back them today, so all six pay 0.'}
                      </p>
                    )}

                    {/* Only the FLAT case needs saying in prose. On a weighted
                        pool the ladder is already on every button (1.32× · 28.9%)
                        and in the Max boost stat, so a sentence repeating it was
                        just one more line to read. */}
                    {flatWeight && (
                      <p className="text-white/45 text-[11px] mt-2 leading-relaxed">
                        This pool weights every lock the same (1.00&times;), so a longer lock does
                        <strong className="text-white/70"> not</strong> raise the rate — it only sets
                        when you can take your {bungalow.symbol} back.
                      </p>
                    )}

                    {/* THE VENUE'S CEILING, said out loud. The pool still allows
                        longer — its durations are create-only and cannot be
                        changed — so this must read as "we stopped offering it",
                        never as "the pool changed". Claiming the latter would be
                        the kind of quiet substitution the honesty rules exist to
                        prevent, and anyone can check the pool on-chain. */}
                    {ceilingApplies && (
                      <p className="text-[11px] mt-2 leading-relaxed" style={{ color: '#f0b26b' }}>
                        We currently offer locks up to <strong>{labelForDays(maxDays)}</strong>, though this
                        pool itself allows up to {labelForDays(poolMaxDays)}. Longer locks are paused while
                        the reward rail is replaced: past roughly {maxDays} days a position&rsquo;s reward
                        accounting runs out before the lock opens, and it stops paying for the rest of its
                        term. Your {bungalow.symbol} would still come back in full — but it would sit there
                        earning nothing collectable, and you could not move it.
                      </p>
                    )}
                  </div>

                  {/* On a DYNAMIC pool the honest answer to "what will I earn"
                      is a share, not an amount: the payout depends on future
                      funding and on who else stakes, and neither is knowable.
                      So the projection strip is replaced by the one figure that
                      IS computable — the share this stake would take. */}
                  {dynamicPool && amountRaw !== null && amountRaw > 0n && poolEffectiveRaw !== null && (() => {
                    const addedEffective = (amountRaw * stakeWeightScaled(pool, chosenSecs)) / WEIGHT_SCALE;
                    const after = poolEffectiveRaw + addedEffective;
                    const share = after > 0n ? Number(addedEffective) / Number(after) : 0;
                    return (
                      <div className="rounded-lg p-4 mb-4" style={{ background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.18)' }}>
                        <p className="text-[11px] font-semibold mb-1 uppercase tracking-wider" style={{ color: '#93c5fd' }}>
                          What this stake would take
                        </p>
                        <p className="stat-value text-2xl leading-tight" style={{ color: '#bfdbfe' }}>{pct(share)}</p>
                        <p className="text-white/45 text-[11px] mt-1 leading-relaxed">
                          of every payout, at a {stakeWeight(pool, chosenSecs).toFixed(2)}× weight on{' '}
                          {labelForDays(chosenDays).toLowerCase()} — computed against the stake in the pool
                          right now. It falls as others stake and rises as they leave. No amount is
                          projected here because the payout depends on future funding, which is not a
                          number this page can know.
                        </p>
                      </div>
                    );
                  })()}

                  {/* Projections — the TOWELI card's strip, with the vault caveat
                      welded on. Renders even at zero, because "0" IS the answer
                      today and hiding it would be the softer lie. FIXED pools
                      only: a dynamic pool has no rate to project from. */}
                  {!dynamicPool && amountRaw !== null && amountRaw > 0n && primaryRp && (
                    <div className="rounded-lg p-4 mb-4" style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)' }}>
                      <p className="text-emerald-400 text-[11px] font-semibold mb-2 uppercase tracking-wider">
                        {vaultDry ? 'What it would earn once funded' : 'Projected rewards'}
                      </p>
                      <div className="grid grid-cols-3 gap-3">
                        {[
                          { label: '30 Days', days: 30 },
                          { label: '90 Days', days: 90 },
                          { label: '1 Year', days: 365 },
                        ].map(({ label, days: d }) => {
                          const held = Math.min(d, chosenDays);
                          const projected = toNum(amountRaw, decimals) * configuredRate * (d / 365);
                          return (
                            <div key={label} className="text-center">
                              {/* A11Y-R16: 9px carried words a reader must parse to interpret the
                                  number above it — a column label, a denomination and a
                                  full explanatory sentence. 11px is the floor for anything
                                  that is a word; 9px stays only for uppercase status pills
                                  whose text is duplicated in an aria-label. */}
                              <p className="text-white/40 text-[11px] uppercase mb-0.5">{label}</p>
                              <p className="stat-value text-white text-[13px]">
                                {vaultDry ? '0' : projected < 0.01 ? '<0.01' : projected.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                              </p>
                              <p className="text-white/30 text-[11px]">
                                {bungalow.symbol}{held < d ? ` · ${held}d locked` : ''}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-white/35 text-[11px] mt-2 text-center leading-relaxed">
                        {vaultDry ? (
                          <>
                            Zero, because the vault is empty. At the configured{' '}
                            {ratePercent ? pct(configuredRate) : `${configuredRate.toFixed(3)} per ${bungalow.symbol}`} a
                            year it would be{' '}
                            {(toNum(amountRaw, decimals) * configuredRate).toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
                            {bungalow.symbol} over a year — once someone funds it.
                          </>
                        ) : (
                          <>
                            At the configured {ratePercent ? pct(configuredRate) : 'rate'}. Rewards stop the moment
                            the vault empties; nothing here assumes a top-up.
                          </>
                        )}
                      </p>
                    </div>
                  )}

                  {!publicKey ? (
                    <>
                      <p className="text-white/80 text-[13px] mb-2 max-w-md leading-relaxed">
                        Connect a Solana wallet to stake. Your principal comes back to you
                        when the lock opens.
                      </p>
                      {/* The no-early-exit fact belongs BEFORE the wallet, not after
                          it: this is the screen where someone decides whether to take
                          part at all. It used to appear only under the stake button,
                          which a disconnected visitor never reaches. */}
                      <p className="text-[12px] mb-3 max-w-md leading-relaxed" style={{ color: '#e3b341' }}>
                        There is no early exit. The program refuses an unstake until the
                        lock you choose opens — not for a fee, not by the venue, not by
                        anyone. Pick a lock you can wait out.
                      </p>
                      <button type="button" onClick={openConnect} className="btn-primary px-6 py-2.5 text-[13px]">
                        Connect Solana Wallet
                      </button>
                    </>
                  ) : (
                  <>
                  <button
                    type="button"
                    disabled={!amountRaw || amountRaw === 0n || overBalance || !invoker || !!action?.busy || stakeBlocked}
                    onClick={() => invoker && amountRaw && void run('Stake', () => stake({
                      invoker, pool, amountRaw, durationSecs: chosenSecs, entries,
                    }))}
                    className="btn-primary w-full py-3 text-[14px] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {action?.busy === 'Stake' ? 'Confirm in wallet…'
                      : vaultDry ? 'Staking paused — vault unfunded'
                      : !entriesKnown ? 'Waiting for your stakes to load…'
                      : funded === null ? 'Vault unreadable — staking paused'
                      : !amountRaw || amountRaw === 0n ? 'Enter an amount'
                      : overBalance ? `Not enough ${bungalow.symbol}`
                      : `Stake & lock for ${labelForDays(chosenDays)}`}
                  </button>
                  {!entriesKnown && entriesForWallet?.reason && (
                    <p className="text-[11px] mt-2" style={{ color: '#f0b26b' }}>
                      {entriesForWallet.reason} Staking waits until your existing stakes are
                      readable — a new stake could otherwise collide with one of them.
                    </p>
                  )}
                  <p className="text-white/45 text-[11px] text-center mt-2">
                    Unlocks {new Date((nowSec + chosenSecs) * 1000).toLocaleDateString()} · no early exit and no
                    penalty path — the program simply refuses an unstake until then
                    {pool.unstakePeriodSecs > 0 ? `, then a ${humanDuration(pool.unstakePeriodSecs)} cool-down applies` : ''}.
                  </p>
                  </>
                  )}
            </div>
            </>
            )}

            {/* ── Your position ──────────────────────────────────────────── */}
            {publicKey && openEntries.length > 0 && (
              <div className="rounded-xl p-4" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-purple-25)' }}>
                <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
                  <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>Your stakes</p>
                  <p className="text-white/70 text-[12px]">
                    <span className="stat-value text-white text-[14px]">{fmt(stakedTotal, decimals)}</span> {bungalow.symbol} staked
                    {' · '}
                    <span className="stat-value text-white text-[14px]">{fmt(pendingTotal, decimals)}</span> accrued
                    {pendingAtRiskCount > 0 && (
                      <>
                        {' · '}
                        <span className="stat-value text-[14px]" style={{ color: '#e3b341' }}>
                          {fmt(pendingAtRisk, decimals)}
                        </span>{' '}
                        <span style={{ color: '#e3b341' }}>at risk — try claiming</span>
                      </>
                    )}
                  </p>
                </div>
                <ul className="space-y-2">
                  {openEntries.map((e) => {
                    const opensAt = unlockTs(e);
                    const locked = nowSec < opensAt;
                    // An accrual this read did not price is UNKNOWN, never zero — a zero
                    // here disabled the claim as "Nothing accrued yet" (see `pendingUnread`).
                    const entryPending = e.pendingUnread ? null : pool.rewardPools.reduce<bigint | null>((acc, rp) => {
                      if (acc === null) return null;
                      const v = e.pendingRaw[rp.nonce];
                      return v === undefined ? acc : v === null ? null : acc + v;
                    }, 0n);
                    return (
                      <li key={e.address || e.nonce} className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}>
                        {/* TRIMMED 2026-08-31 (owner): this carried amount, lock,
                            weight, unlock date and accrued — every one of which is
                            already on screen within a few hundred pixels. The header
                            above totals staked and accrued; the lock ladder above that
                            prints each duration's weight and APR; and the unstake button
                            below renders "Locked · <countdown>" itself. Only the
                            per-entry amount is not stated elsewhere, so only it stays.
                            entryPending is still computed — the buttons gate on it. */}
                        <div className="mb-3">
                          <span className="stat-value text-white text-[17px] leading-none">
                            {fmt(e.amountRaw, decimals)} <span className="text-white/60 text-[13px]">{bungalow.symbol}</span>
                          </span>
                        </div>
                        {(() => {
                          // 6012-precise gating: the SDK's own calcRewards gives this
                          // entry's accrued amount; when it exceeds the vault, claim AND
                          // the grouped exit are guaranteed to revert (devnet-proven), so
                          // the buttons say so instead of letting the wallet eat it.
                          const exceedsVault =
                            entryPending !== null && funded !== null && entryPending > funded;
                          const nothingPending = entryPending === 0n;
                          // 6000 RISK — A WARNING, NOT A GATE. This block used
                          // to disable the claim whenever the entry's cumulative
                          // `accountedAmount` passed u64::MAX, on the belief that
                          // the program could no longer pay it. Measured against
                          // mainnet on 2026-09-12 that belief is false: the
                          // 1,000,000-BAYLA position sits at 107.67% of that
                          // number and pays 13,603 BAYLA, while the entries that
                          // genuinely revert sit at 265% and 274%. The disabled
                          // button was therefore hiding a five-figure balance
                          // from the person it belonged to.
                          //
                          // Nothing here knows where the real line is, so the
                          // button stays live and the chain answers. A claim that
                          // reverts costs a transaction fee; a claim never
                          // offered costs the whole balance.
                          const atRisk = anyClaimBrokenByRateChange(e, pool.rewardPools);
                          return (
                        <div className="flex flex-wrap items-center gap-2">
                          {pool.rewardPools.map((rp) => {
                            const rpAtRisk = claimBrokenByRateChange(e, rp);
                            return (
                            <button
                              key={rp.address || rp.nonce}
                              type="button"
                              disabled={!invoker || !!action?.busy || nothingPending || exceedsVault}
                              title={rpAtRisk
                                ? 'This position is deep enough into the reward program’s accounting that the claim MAY revert. It may also pay in full — only the chain knows, and trying is how you ask. A revert costs the network fee and nothing else; your staked BAYLA is untouched either way.'
                                : exceedsVault ? 'The vault cannot cover this claim — it reverts until a top-up; nothing is lost.' : nothingPending ? 'Nothing accrued yet.' : undefined}
                              onClick={() => invoker && void run('Claim', () => claimRewards({ invoker, pool, rewardPool: rp, entryNonce: e.nonce }))}
                              className="btn-secondary px-3 py-1.5 text-[12px] disabled:opacity-50"
                            >
                              {exceedsVault ? 'Nothing claimable yet'
                                : rpAtRisk ? 'Claim rewards (may revert)'
                                : 'Claim rewards'}
                            </button>
                            );
                          })}
                          <button
                            type="button"
                            disabled={!invoker || !!action?.busy || locked || exceedsVault}
                            title={locked
                              ? 'The program refuses an unstake before the lock opens'
                              : atRisk
                                ? 'This exit claims rewards in the same transaction, and this position is deep into the reward accounting — so the exit MAY revert. If it does, nothing moves and the principal rescue below is still there. Try this first: it is the only path that keeps the rewards.'
                                : exceedsVault
                                  ? 'The exit pays rewards in the same transaction — it reverts until the vault covers them (nothing is lost).'
                                  : undefined}
                            onClick={() => invoker && void run('Unstake', () => unstakeAndClaim({ invoker, pool, entryNonce: e.nonce }))}
                            className="btn-secondary px-3 py-1.5 text-[12px] disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {locked ? `Locked · ${humanDuration(opensAt - nowSec)}`
                              : exceedsVault ? 'Exit blocked — vault unfunded'
                              : atRisk ? 'Unstake & claim (may revert)'
                              : 'Unstake & claim'}
                          </button>

                          {/* PRINCIPAL RESCUE. Offered in the states where the
                              normal exit is impossible because its CLAIM LEG
                              reverts, leaving principal stuck behind it. It
                              closes the reward entry instead of claiming it,
                              which is why it works — and why it costs the
                              accrued rewards. Two-step on purpose.

                              TWO triggers, and both are load-bearing:

                              (a) exceedsVault — the 6012 funding gap. Temporary:
                                  clears on a top-up.

                              (b) atRisk — deep into the 6000 accounting band.
                                  ADDED 2026-09-06, and this is the one that
                                  would have trapped people. The original gate
                                  was `exceedsVault` alone, on the assumption
                                  that a funded vault means a working exit. It
                                  does not: an entry whose claim leg reverts does
                                  so while the vault is fully funded, so
                                  `exceedsVault` is FALSE, this button never
                                  rendered, and the only control on screen was
                                  the one call that cannot succeed.

                                  It is offered here as a FALLBACK, not a verdict.
                                  Being in the band does not mean the claim fails
                                  — measured 2026-09-12, the 1,000,000 entry is
                                  in it and pays 13,603 BAYLA. So the normal exit
                                  above stays enabled and is the one to try
                                  first; this is what is left if it reverts.

                              The chain itself never traps the principal: the
                              stake program's `unstake` does not take the reward
                              entry as an account at all, and an overflowed
                              position was seen exiting on mainnet (tx
                              2eLftTr3…, 2026-09-04) with no reward-program
                              instruction in the transaction. Only the UI could
                              trap it, and this is where. */}
                          {!locked && (exceedsVault || atRisk) && (
                            rescueArmed === e.nonce ? (
                              <span className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={!invoker || !!action?.busy}
                                  onClick={() => {
                                    setRescueFor(null);
                                    if (invoker) void run('Rescue', () => unstakeAndCloseForfeitingRewards({ invoker, pool, entryNonce: e.nonce, entry: e }));
                                  }}
                                  className="px-3 py-1.5 text-[12px] rounded-lg disabled:opacity-50"
                                  style={{ background: 'rgba(227,179,65,0.18)', border: '1px solid #e3b341', color: '#e3b341' }}
                                >
                                  Forfeit rewards &amp; take principal
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setRescueFor(null)}
                                  className="btn-secondary px-2.5 py-1.5 text-[12px]"
                                >
                                  Cancel
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                disabled={!invoker || !!action?.busy}
                                title="Withdraws your principal WITHOUT claiming rewards. It closes the reward entry rather than paying it, so it cannot be blocked by an unfunded vault or by a position that has passed the reward program's limit — and the accrued rewards are given up."
                                onClick={() => setRescueFor({ read: entriesRead, nonce: e.nonce })}
                                className="btn-secondary px-3 py-1.5 text-[12px] disabled:opacity-50"
                                style={{ borderColor: 'rgba(227,179,65,0.5)', color: '#e3b341' }}
                              >
                                Take principal without rewards
                              </button>
                            )
                          )}
                        </div>
                          );
                        })()}
                      </li>
                    );
                  })}
                </ul>
                {vaultDry && (
                  <p className="text-white/45 text-[11px] mt-3">
                    Accrual keeps counting while the vault is dry, and nothing is lost — but
                    claims and exits <strong>revert</strong> until the vault covers what has
                    accrued (proven against the live program). Both work again the moment it
                    is topped up, and the backlog pays in full.
                  </p>
                )}
              </div>
            )}

            {publicKey && !entriesKnown && entriesForWallet?.reason && (
              <p className="text-[12px] mt-1" style={{ color: '#f0b26b' }}>
                Your stakes could not be read right now. That is an outage, not an empty list.
              </p>
            )}

            {action?.busy && <p className="text-white/70 text-[12px] mt-3">{action.busy} — waiting for the wallet…</p>}
            {action?.note && (
              <p className="text-[12px] mt-3 text-white/85">
                {action.note}{' '}
                {action.tx && (
                  <a href={`https://solscan.io/tx/${action.tx}`} target="_blank" rel="noopener noreferrer"
                    aria-label="View transaction on Solscan (opens in new tab)"
                    className="inline-flex min-h-[44px] items-center underline underline-offset-2 text-white/70 hover:text-white">
                    view tx ↗
                  </a>
                )}
              </p>
            )}

            {/* TAP TARGETS (2026-09-21): these two links were 69x13 inline words in a
                sentence — far under the 44px tap floor. They are their own row now,
                44px tall, and the sentence they sat in follows them, unchanged in
                meaning. */}
            <div className="mt-4 flex flex-wrap items-center gap-x-5">
              <a href={`https://solscan.io/account/${pool.address}`} target="_blank" rel="noopener noreferrer"
                aria-label="View stake pool on Solscan (opens in new tab)"
                className="inline-flex min-h-[44px] items-center gap-1.5 text-[11px] text-white/60 hover:text-white/90">
                Pool <span className="underline underline-offset-2 font-mono">{pool.address.slice(0, 4)}…{pool.address.slice(-4)} ↗</span>
              </a>
              {primaryRp && (
                <a href={`https://solscan.io/account/${primaryRp.vault}`} target="_blank" rel="noopener noreferrer"
                  aria-label="View reward vault on Solscan (opens in new tab)"
                  className="inline-flex min-h-[44px] items-center gap-1.5 text-[11px] text-white/60 hover:text-white/90">
                  Reward vault <span className="underline underline-offset-2 font-mono">{primaryRp.vault.slice(0, 4)}…{primaryRp.vault.slice(-4)} ↗</span>
                </a>
              )}
            </div>
            <p className="text-white/45 text-[11px] m-0 leading-relaxed">
              A Streamflow staking pool — audited program, non-custodial, verifiable on-chain.
              {primaryRp && (primaryRp.permissionless
                ? ' Reward vault funding is permissionless: anyone can top it up, and the balance above is the proof.'
                : ' Only the pool authority can fund the reward vault.')}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A CLOSED Streamflow pool beside a ladder, for its members only (owner, 2026-09-21).
 * SolanaPoolStack draws it under the ladder card and shares that card's wallet context.
 * No open position here: nothing. A failed read: an outage, never "not a member".
 * Unstake appears once a lock opens (Streamflow never returns principal by itself), and
 * the principal rescue only on an open lock in the 6000 band, never for a dry vault.
 */
export function LighthouseClaimStrip({ bungalow }: { bungalow: Bungalow & { stakePool: string } }) {
  const { publicKey, wallet } = useWallet();
  const walletKey = publicKey?.toBase58() ?? '';
  const titleId = useId();

  const [poolRead, setPoolRead] = useState<{ ok: true; pool: PoolView } | { ok: false; reason: string } | null>(null);
  // Keyed by wallet and DERIVED by key match: a switch never shows the last wallet's rows.
  const [entriesRead, setEntriesRead] = useState<{ key: string; list: StakeEntryView[] | null; reason: string | null } | null>(null);
  // Keyed by the wallet that SENT it: under the next wallet's rows a receipt reads as theirs.
  const [action, setAction] = useState<{ key: string; busy?: string; note?: string; tx?: string } | null>(null);
  // The rescue confirm is armed against ONE entries read (the full card's rule): another
  // wallet's read, a fresh read and any write all disarm it.
  const [rescueFor, setRescueFor] = useState<{ read: typeof entriesRead; nonce: number } | null>(null);
  // Every read goes through the one effect below, so a newer read cancels an older one.
  const [readGen, setReadGen] = useState(0);
  const reread = () => setReadGen((n) => n + 1);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(t);
  }, []);

  // No wallet, no reads: a visitor who cannot be a member costs this pool nothing.
  useEffect(() => {
    if (!walletKey) return;
    let cancelled = false;
    readEntries(bungalow.stakePool, walletKey).then((r) => {
      if (cancelled) return;
      if (r.ok) setEntriesRead({ key: walletKey, list: r.entries, reason: null });
      else setEntriesRead({ key: walletKey, list: null, reason: r.reason });
    });
    readPool(bungalow.stakePool).then((r) => { if (!cancelled) setPoolRead(r); });
    return () => { cancelled = true; };
  }, [bungalow.stakePool, walletKey, readGen]);

  const mine = walletKey && entriesRead?.key === walletKey ? entriesRead : null;
  // Disconnected or still reading: nothing, so a non-member never sees a flash.
  if (!mine) return null;

  const act = action && action.key === walletKey ? action : null;
  const tryAgain = (onClick: () => void) => (
    <button type="button" onClick={onClick} className="min-h-[44px] underline underline-offset-2">Try again</button>
  );
  const actionLines = (
    <>
      {act?.busy && <p role="status" className="text-white/70 text-[12px] mt-3 mb-0">{act.busy}: waiting for the wallet…</p>}
      {act?.note && (
        <p className="text-[12px] mt-3 mb-0 text-white/85">
          {act.note}{' '}
          {act.tx && (
            <a href={`https://solscan.io/tx/${act.tx}`} target="_blank" rel="noopener noreferrer"
              aria-label="View transaction on Solscan (opens in new tab)"
              className="inline-flex min-h-[44px] items-center underline underline-offset-2 text-white/70 hover:text-white">
              view tx ↗
            </a>
          )}
        </p>
      )}
    </>
  );
  // The closed full card's quiet shell: no glow loop, the quiet border, the 0.62 scrim.
  const shell = (body: ReactNode) => (
    <section aria-labelledby={titleId} className="relative overflow-hidden rounded-2xl" style={{ border: '1px solid var(--color-purple-25)' }}>
      <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.62)' }} />
      <div className="relative z-10 p-5">
        <p id={titleId} className="text-[11px] uppercase tracking-wider mb-1" style={{ color: 'rgba(255,255,255,0.7)' }}>
          The lighthouse pool · retired
        </p>
        {body}
        {actionLines}
      </div>
    </section>
  );

  // A non-member may be reading this, so it never names the closed pool. Try again drops
  // the failure first, so a retry that fails again is not a dead click.
  if (mine.list === null) {
    const retryEntries = () => {
      setEntriesRead((s) => (s && s.list === null ? null : s));
      reread();
    };
    return (
      <div>
        <p role="status" className="text-[12px] rounded-lg px-3 py-2 m-0" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(240,178,107,0.4)', color: '#f0b26b' }}>
          Your {bungalow.symbol} positions could not be checked right now. That is an outage, not an
          empty result.{' '}
          {tryAgain(retryEntries)}
        </p>
        {actionLines}
      </div>
    );
  }

  const openEntries = mine.list.filter((e) => e.closedTs === 0);
  // Exiting the last position closes it; its receipt stays on screen.
  if (openEntries.length === 0) return act?.note ? shell(null) : null;

  const pool = poolRead?.ok ? poolRead.pool : null;
  const poolMint = pool?.mint ?? '';
  const identityMismatch = poolMint !== '' && poolMint !== (bungalow.address ?? '');
  const decimals = pool?.decimals ?? bungalow.decimals ?? 6;
  const sym = bungalow.symbol;
  const invoker = wallet?.adapter as SignerWalletAdapter | undefined;
  const multiReward = (pool?.rewardPools.length ?? 0) > 1;
  // An empty reward-pool list, or one missing a pool an entry has a figure for, is an
  // outage: an exit claims only the listed pools and then closes the entry for good.
  const rewardPoolsIncomplete = pool !== null && (
    pool.rewardPools.length === 0
    || openEntries.some((e) => Object.keys(e.pendingRaw).some((n) => !pool.rewardPools.some((rp) => rp.nonce === Number(n))))
  );
  const retryPool = () => {
    setPoolRead((p) => (p && !p.ok ? null : p));
    reread();
  };

  // An ABSENT pending figure is unknown, not zero, so it never disables a claim.
  const pendingOf = (e: StakeEntryView, rp: RewardPoolView): bigint | null => e.pendingRaw[rp.nonce] ?? null;
  // Per reward pool, in its own units: a claim reverts (6012) past what its vault holds.
  const exceedsVault = (e: StakeEntryView, rp: RewardPoolView): boolean => {
    const v = pendingOf(e, rp);
    return v !== null && rp.fundedRaw !== null && v > rp.fundedRaw;
  };
  const anyExceedsVault = pool ? openEntries.some((e) => pool.rewardPools.some((rp) => exceedsVault(e, rp))) : false;
  const rescueArmed = rescueFor !== null && rescueFor.read === entriesRead ? rescueFor.nonce : null;

  // Busy disables every button whichever wallet sent it; only its lines are scoped.
  // Re-read after a failure too: a rescue that stopped may already have paid a claim.
  const run = async (label: string, fn: () => Promise<{ ok: true; txId: string } | { ok: false; reason: string }>) => {
    const key = walletKey;
    setRescueFor(null);
    setAction({ key, busy: label });
    const res = await fn();
    setAction(res.ok ? { key, note: `${label} confirmed.`, tx: res.txId } : { key, note: res.reason });
    reread();
  };

  const btn = 'btn-secondary min-h-[44px] px-4 py-2 text-[12px] disabled:opacity-40';
  return shell(
    <>
      <p className="text-white/60 text-[11px] leading-relaxed mb-3">
        This pool takes no new stakes.{' '}
        {openEntries.length === 1
          ? 'Claim what your position has earned here, and withdraw it here once its lock opens.'
          : 'Claim what your positions have earned here, and withdraw each one here once its lock opens.'}
      </p>

      {poolRead === null && <p role="status" className="text-white/70 text-[12px] m-0">Reading the pool…</p>}
      {poolRead && !poolRead.ok && (
        <p role="alert" className="text-[12px] m-0" style={{ color: '#f0b26b' }}>
          {poolRead.reason}{' '}
          {tryAgain(retryPool)}
        </p>
      )}
      {identityMismatch && (
        <p role="alert" className="text-[12px] rounded-lg p-3 m-0" style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5' }}>
          This pool does not stake {sym}. It reports {poolMint.slice(0, 6)}…{poolMint.slice(-4)} as its staking
          mint, which is a configuration error, so nothing here will send a transaction.
        </p>
      )}
      {pool && !identityMismatch && rewardPoolsIncomplete && (
        <p role="alert" className="text-[12px] rounded-lg px-3 py-2 m-0" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(240,178,107,0.4)', color: '#f0b26b' }}>
          The reward program could not be read, so what your {openEntries.length === 1 ? 'position has' : 'positions have'} earned
          is unknown right now. That is an outage, not a zero, and nothing here can be claimed or withdrawn safely
          until it reads.{' '}
          {tryAgain(retryPool)}
        </p>
      )}

      {pool && !identityMismatch && !rewardPoolsIncomplete && (
        <>
          <ul className="space-y-2 m-0 p-0 list-none">
            {openEntries.map((e) => {
              const opensAt = unlockTs(e);
              const locked = nowSec < opensAt;
              const atRisk = anyClaimBrokenByRateChange(e, pool.rewardPools);
              const exitBlocked = pool.rewardPools.some((rp) => exceedsVault(e, rp));
              // Same-mint pools only (a foreign mint has other decimals), all known, and
              // never for an entry this read did not fully price (pendingUnread).
              const sameMint = pool.rewardPools.filter((rp) => rp.mint === pool.mint);
              const earned = e.pendingUnread || sameMint.length === 0 ? null : sameMint.reduce<bigint | null>((acc, rp) => {
                const v = pendingOf(e, rp);
                return acc === null || v === null ? null : acc + v;
              }, 0n);
              return (
                <li key={e.address || e.nonce} className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-purple-25)' }}>
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-2.5">
                    <p className="text-white text-[15px] font-semibold m-0 tabular-nums">
                      {fmt(e.amountRaw, decimals)} <span className="text-white/60 text-[11px] font-normal">{sym}</span>
                    </p>
                    <p className="text-white/70 text-[12px] m-0">
                      {locked ? `unlocks in ${humanDuration(opensAt - nowSec)}` : 'unlocked'}
                    </p>
                    {earned !== null && (
                      <p className="text-white/70 text-[12px] m-0 tabular-nums">
                        {fmt(earned, decimals, decimals)} {sym} earned
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {pool.rewardPools.map((rp) => {
                      const pending = pendingOf(e, rp);
                      const blocked = exceedsVault(e, rp);
                      const rpAtRisk = claimBrokenByRateChange(e, rp);
                      return (
                        <button
                          key={rp.address || rp.nonce}
                          type="button"
                          disabled={!invoker || !!action?.busy || pending === 0n || blocked}
                          title={blocked
                            ? 'The reward vault cannot cover this claim yet. It works again after a top-up, and nothing accrued is lost.'
                            : rpAtRisk
                              ? 'This position is deep enough into the reward program’s accounting that the claim may revert. It may also pay in full; only the chain knows, and trying is how you ask. A revert costs the network fee and nothing else.'
                              : pending === 0n ? 'Nothing accrued yet.' : undefined}
                          onClick={() => invoker && void run('Claim', () => claimRewards({ invoker, pool, rewardPool: rp, entryNonce: e.nonce }))}
                          className={btn}
                        >
                          {blocked ? 'Nothing claimable yet' : rpAtRisk ? 'Claim rewards (may revert)' : 'Claim rewards'}
                          {multiReward ? ` · pool #${rp.nonce}` : ''}
                        </button>
                      );
                    })}

                    {!locked && (
                      <button
                        type="button"
                        disabled={!invoker || !!action?.busy || exitBlocked}
                        title={exitBlocked
                          ? 'The exit pays rewards in the same transaction, so it waits until the vault covers them. Nothing is lost.'
                          : atRisk
                            ? 'This exit claims rewards in the same transaction and may revert. If it does, nothing moves, and taking the principal without rewards is still there. Try this first: it is the only way out that keeps the rewards.'
                            : undefined}
                        onClick={() => invoker && void run('Unstake', () => unstakeAndClaim({ invoker, pool, entryNonce: e.nonce }))}
                        className={btn}
                      >
                        {exitBlocked ? 'Exit waits for a vault top-up' : atRisk ? 'Unstake & claim (may revert)' : 'Unstake & claim'}
                      </button>
                    )}

                    {!locked && atRisk && (
                      rescueArmed === e.nonce ? (
                        <span className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={!invoker || !!action?.busy}
                            onClick={() => {
                              if (invoker) void run('Rescue', () => unstakeAndCloseForfeitingRewards({ invoker, pool, entryNonce: e.nonce, entry: e }));
                            }}
                            className="min-h-[44px] px-4 py-2 text-[12px] rounded-lg disabled:opacity-40"
                            style={{ background: 'rgba(227,179,65,0.18)', border: '1px solid #e3b341', color: '#e3b341' }}
                          >
                            Forfeit rewards &amp; take principal
                          </button>
                          <button type="button" onClick={() => setRescueFor(null)} className="btn-secondary min-h-[44px] px-3 py-2 text-[12px]">
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={!invoker || !!action?.busy}
                          title="First tries to claim every reward pool with something pending, one transaction each. If a claim fails for any reason the chain has not called permanent, it stops there: claims already paid stay paid, and your principal stays staked. Where the chain has, it withdraws your principal and closes the reward entry, giving those rewards up."
                          onClick={() => setRescueFor({ read: entriesRead, nonce: e.nonce })}
                          className={btn}
                          style={{ borderColor: 'rgba(227,179,65,0.5)', color: '#e3b341' }}
                        >
                          Take principal without rewards
                        </button>
                      )
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <HeldTimeLine chain={bungalow.chain} pool={bungalow.stakePool} className="mt-3" />

          {anyExceedsVault && (
            <p className="text-white/55 text-[11px] mt-3 mb-0 leading-relaxed">
              The reward vault cannot cover what has accrued right now, so claims wait for a top-up.
              Accrual keeps counting, and nothing is lost.
            </p>
          )}
        </>
      )}
    </>,
  );
}

interface LhCell {
  key: string;
  label: string;
  value: string;
  unit?: string;
  tone?: 'good' | 'muted';
  /** A sentence about the figure — printed as a footnote, never inside the cell. */
  note?: string;
}

/**
 * Column spans for the lighthouse ledger, so no row ever ends in an empty cell.
 * Two across: an odd last cell spans both columns. One row (12-column grid): the
 * cells share it evenly — or, for five, three over two. The class strings are
 * spelled out because Tailwind only emits classes it finds verbatim in the source.
 */
function lhSpan(i: number, n: number): string {
  const two = n % 2 === 1 && i === n - 1 ? '@min-[30rem]:col-span-2' : '';
  const wide = n === 5 ? (i < 3 ? '@min-[52rem]:col-span-4' : '@min-[52rem]:col-span-6')
    : n === 4 ? '@min-[52rem]:col-span-3'
    : n === 3 ? '@min-[52rem]:col-span-4'
    : n === 2 ? '@min-[52rem]:col-span-6'
    : '@min-[52rem]:col-span-12';
  return `${two} ${wide}`;
}
