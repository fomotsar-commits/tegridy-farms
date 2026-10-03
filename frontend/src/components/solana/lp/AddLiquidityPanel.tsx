import { useCallback, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { parseDecimalToBaseUnits } from '../../../lib/launcher/solana/curve/format';
import { displaySafe } from '../../../lib/launchMetadata/validate';
import { feeReserveFor, isPlanProblem, planDeposit, solSetAside, spendableSol, type DepositPlan, type PlanProblem } from '../../../lib/solana/lp/liquidityMath';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { PoolHealth } from '../../../lib/solana/lp/poolHealth';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { solText, tokenText } from '../../../lib/solana/lp/format';
import { Notice, Row, SlippagePicker } from '../curve/ui';
import { DEFAULT_SLIPPAGE_BPS, baseUnitsToInput } from '../curve/uiFormat';
import { TxFlowView } from '../curve/TxFlowView';
import { WalletNeeded } from '../curve/WalletNeeded';
import { useReturnFocus, useTxFlow } from '../curve/useTxFlow';
import type { LpOpenGate, LpWriteApi } from '../curve/ports';
import { FundingNextStep } from './FundingNextStep';
import { LpAmountPair, type LpSide } from './LpAmountPair';
import { LpBeforeYouAdd, LpReviewDisclosure } from './LpDisclosures';
import { PanelFrame } from './PanelFrame';
import { NOTES_BELOW, cannotFundText, reviewOffWhy, sharePct, solAbout, solExact, tokensAbout, unitsExact, useDebounced, useFlowReports, useSettledAlert, useWalletFacts } from './panelKit';
import { lpHeld } from './offers';
import { useLpWrites, type LpWrites } from './useLpWrites';

const ADD_HINT = 'If the pool’s price moves more than this before your deposit runs, it is refused and only the network fees are spent.';
const SOL_DECIMALS = 9;

/**
 * Add liquidity to one pool, in place inside its card. The numbers here are worked out
 * from the pool as the card read it, for the preview only: pressing Review reads the
 * pool, the token, the price and the wallet again and builds from those
 * (write/liquidity.ts `prepareLpDeposit`). The typed number is the most that can leave
 * on that side; the other side's limit is worked out from it.
 */
export function AddLiquidityPanel(p: { view: PoolView; health: PoolHealth; safety: TokenSafety | null; tokenDecimals: number | null; onClose: () => void }) {
  const writes = useLpWrites();
  const gate = writes?.gate?.kind === 'open' ? writes.gate : null;
  if (!writes || !writes.api || !gate) return null;
  return <AddInner {...p} writes={writes} api={writes.api} gate={gate} />;
}

function AddInner({
  view,
  safety,
  tokenDecimals,
  onClose,
  writes,
  api,
  gate,
}: {
  view: PoolView;
  safety: TokenSafety | null;
  tokenDecimals: number | null;
  onClose: () => void;
  writes: LpWrites;
  api: LpWriteApi;
  gate: LpOpenGate;
}) {
  const pool = view.snapshot.pool;
  // The pool records its token's decimals; the token read must agree before Review
  // builds anything, so the record is a safe fallback for the preview.
  const decimals = tokenDecimals ?? (view.quoteIsToken0 ? pool.mint1Decimals : pool.mint0Decimals);
  const tokenProgram = view.quoteIsToken0 ? pool.token1Program : pool.token0Program;
  const signer = writes.signerState.kind === 'ready' ? writes.signerState.signer : null;
  const [factsNonce, setFactsNonce] = useState(0);
  const facts = useWalletFacts(writes, signer?.publicKey ?? null, { tokenMint: view.tokenMint, tokenProgram, lpMint: pool.lpMint }, factsNonce);

  const [typed, setTyped] = useState<{ side: LpSide; text: string } | null>(null);
  const [slippageBps, setSlippageBps] = useState<bigint | null>(DEFAULT_SLIPPAGE_BPS);

  const flow = useTxFlow(api, writes.rpc, writes.pending.record, writes.pending.sent);
  const { target: reviewRef, fallback: headingRef } = useReturnFocus(flow.state.step);
  const reread = useCallback(() => setFactsNonce((n) => n + 1), []);
  useFlowReports(writes, flow.state.step, flow.locked, reread);

  const sideDecimals = (s: LpSide) => (s === 'sol' ? SOL_DECIMALS : decimals);
  const maxIn = typed && typed.text.trim() !== '' ? parseDecimalToBaseUnits(typed.text, sideDecimals(typed.side)) : null;
  const typedBad = !!typed && typed.text.trim() !== '' && maxIn === null;

  // What the wallet can put in. Unread is null, never 0: then no Max and no balance rule.
  const band = facts?.kind === 'ok'
    ? {
        walletFloor: facts.rents.walletFloor,
        feeReserve: feeReserveFor(1),
        lpAccountRent: facts.lpAccountExists ? 0n : facts.rents.tokenAccount165,
        wsolCreateRent: facts.wsol.exists ? 0n : facts.rents.tokenAccount165,
      }
    : null;
  const availableSol = facts?.kind === 'ok' && band ? spendableSol({ lamports: facts.lamports, ...band }) : null;
  const setAside = band ? solSetAside(band) : null;
  const availableToken = facts?.kind === 'ok' ? (facts.token?.amount ?? 0n) : null;
  // Said before anything is typed: a wallet that can put nothing in is not left with a greyed-out Review.
  const cannotAdd = cannotFundText({
    doing: 'add to this pool',
    forWhat: 'fees and account deposits',
    lamports: facts?.kind === 'ok' ? facts.lamports : null,
    setAside,
    availableSol,
    availableToken,
  });

  const plans = useMemo(() => {
    if (!typed || maxIn === null || maxIn === 0n) return null;
    const base = { quoteIsToken0: view.quoteIsToken0, driving: typed.side === 'sol' ? ('quote' as const) : ('token' as const), maxIn, bps: slippageBps ?? DEFAULT_SLIPPAGE_BPS };
    return {
      // The pool's own answer, with no balance rule: what the other box shows.
      free: planDeposit(view.snapshot, { ...base, availableQuote: null, availableToken: null }),
      plan: planDeposit(view.snapshot, { ...base, availableQuote: availableSol, availableToken }),
    };
  }, [typed, maxIn, slippageBps, view, availableSol, availableToken]);
  const free = plans && !isPlanProblem(plans.free) ? plans.free : null;
  const plan: DepositPlan | null = plans && !isPlanProblem(plans.plan) ? plans.plan : null;
  const problem: PlanProblem | null = plans && isPlanProblem(plans.plan) ? plans.plan : null;

  const solOf = (pl: DepositPlan) => ({ cost: view.quoteIsToken0 ? pl.cost0 : pl.cost1, max: view.quoteIsToken0 ? pl.max0 : pl.max1 });
  const tokOf = (pl: DepositPlan) => ({ cost: view.quoteIsToken0 ? pl.cost1 : pl.cost0, max: view.quoteIsToken0 ? pl.max1 : pl.max0 });
  const other: LpSide | null = typed ? (typed.side === 'sol' ? 'token' : 'sol') : null;
  const otherText = free && other ? baseUnitsToInput(other === 'sol' ? solOf(free).cost : tokOf(free).cost, sideDecimals(other)) : '';
  const boxes = { sol: typed?.side === 'sol' ? typed.text : otherText, token: typed?.side === 'token' ? typed.text : otherText };

  const onType = (side: LpSide, text: string) => setTyped(text.trim() === '' ? null : { side, text });
  const setDriving = (side: LpSide, v: bigint) => setTyped({ side, text: baseUnitsToInput(v, sideDecimals(side)) });

  // ── hints ──
  const balanceHint = (side: LpSide): string => {
    if (!signer) return 'Connect a wallet to see what you can put in.';
    if (!facts) return 'Reading your wallet…';
    if (facts.kind === 'unread') return `You have: could not read (${facts.detail})`;
    return side === 'sol'
      ? `You have ${solText(facts.lamports)}. Up to ${solText(availableSol ?? 0n)} can go in after fees and account deposits.`
      : `You have ${tokenText(availableToken ?? 0n, decimals)}.`;
  };
  const hintFor = (side: LpSide): string => {
    const base = balanceHint(side);
    if (!free || !typed || typed.side === side) return base;
    const max = side === 'sol' ? solExact(solOf(plan ?? free).max) : `${unitsExact(tokOf(plan ?? free).max, decimals)} tokens`;
    return `Worked out from the ${typed.side === 'sol' ? 'SOL' : 'token'} amount: at most ${max} can leave your wallet. ${base}`;
  };
  const parseError = (side: LpSide) =>
    typed?.side === side && typedBad
      ? side === 'sol'
        ? 'That is not a SOL amount (at most 9 decimals).'
        : `That is not an amount this token can hold (at most ${decimals} decimals).`
      : null;

  // ── the problems line ──
  const tok = (v: bigint) => tokensAbout(v, decimals);
  let problemText = '';
  let fix: { label: string; run: () => void } | null = null;
  if (problem && typed) {
    switch (problem.problem) {
      case 'too-small':
        problemText = 'Too small: at this pool’s size one side would round to zero. Add a larger amount.';
        break;
      case 'over-balance':
        if (problem.side === 'quote') {
          problemText = `That would leave your wallet with too little SOL to stay open on the network. The most you can add is ${solExact(problem.have)}.`;
          fix = { label: `Use ${solExact(problem.have)}`, run: () => setDriving('sol', problem.have) };
        } else {
          problemText = `This needs up to ${tok(problem.need)} and your wallet has ${tok(problem.have)}. Lower the ${typed.side === 'sol' ? 'SOL' : 'token'} amount, or use the most both balances allow.`;
          const most = problem.mostBoth;
          if (most !== null && most > 0n) fix = { label: 'Use the most both balances allow', run: () => setDriving(typed.side, most) };
        }
        break;
      case 'no-price':
        problemText = 'This pool is empty on one side, so it has no price to add at.';
        break;
      case 'overflow':
        problemText = 'These amounts are too large for one transaction.';
        break;
      default:
        problemText = 'These amounts could not be worked out.';
    }
  }
  // Read out once typing settles, never on every keystroke (its numbers change with each digit).
  const alertText = useSettledAlert(problemText);

  // ── the preview ──
  const S = pool.lpSupply;
  const held = writes.heldShares(pool.lpMint);
  const shareRow = plan
    ? held === null
      ? `about ${sharePct(plan.lp, S + plan.lp)} from this deposit`
      : `${sharePct(held, S)} → ${sharePct(held + plan.lp, S + plan.lp)}`
    : '';
  const wsolKept = facts?.kind === 'ok' && facts.wsol.exists && facts.wsol.amount > 0n;
  const status = useDebounced(
    plan ? `You would add about ${solAbout(solOf(plan).cost)} and ${tok(tokOf(plan).cost)} and get ${unitsExact(plan.lp, pool.lpMintDecimals)} pool shares.` : '',
  );

  // A deposit to this pool still pending (this panel's own, or one found after a reload) holds it.
  const pendingHere = lpHeld(writes.pending.notes, view.address, 'add');
  const canReview = !!signer && !!plan && slippageBps !== null && !typedBad && !problem && !flow.locked && !pendingHere && maxIn !== null;
  const review = () => {
    if (!signer || !plan || !typed || maxIn === null || slippageBps === null) return;
    const shownOtherMax = typed.side === 'sol' ? tokOf(plan).max : solOf(plan).max;
    void flow.prepare(() =>
      api.prepareLpDeposit(writes.rpc, gate, writes.readers, {
        owner: signer.publicKey,
        pool: new PublicKey(view.address),
        tokenMint: new PublicKey(view.tokenMint),
        quoteMint: new PublicKey(view.quote.mint),
        driving: typed.side === 'sol' ? 'quote' : 'token',
        maxIn,
        slippageBps,
        shownOtherMax,
      }),
    );
  };

  const warnings = safety?.kind === 'read' && safety.verdict === 'warn' ? safety.warnings : [];
  const walletReady = writes.signerState.kind === 'ready';
  const reviewWhy = reviewOffWhy({ hasWallet: !!signer, cannot: cannotAdd !== null, hasAmounts: !!typed && typed.text.trim() !== '', amountsWord: 'an amount' });
  const callsItself = safety?.kind === 'read' && safety.verdict !== 'blocked' && (safety.name || safety.symbol)
    ? `${displaySafe(safety.name ?? '', 32)} (${displaySafe(safety.symbol ?? '', 12)})`
    : null;

  return (
    <PanelFrame testId="lp-add-panel" title="Add liquidity to this pool" headingRef={headingRef}>
      <div className="space-y-1.5">
        <Row label="Pool" value={view.address} />
        <Row label="Token" value={view.tokenMint} />
        {callsItself && <Row label="Calls itself" value={callsItself} mono={false} />}
      </div>
      {flow.state.step !== 'idle' ? (
        <TxFlowView
          flow={flow}
          api={api}
          cluster={gate.cfg.cluster}
          decimals={decimals}
          signer={signer}
          extraReview={<LpReviewDisclosure kind="add" origin={view.origin} />}
          preparingText="Reading the pool and the price again, then test-running your deposit on the network…"
        />
      ) : (
        <>
          {warnings.length > 0 && (
            <div className="space-y-1">
              <Notice tone="warn">Read these about this token first:</Notice>
              <ul className="list-disc pl-4 text-amber-300/90 space-y-0.5">
                {warnings.map((w) => (
                  <li key={w.code}>{w.text}</li>
                ))}
              </ul>
            </div>
          )}
          {/* First on the form: no wallet yet, or a wallet that cannot pay for a deposit. */}
          {!walletReady && <WalletNeeded state={writes.signerState} />}
          {cannotAdd && (
            <div data-testid="lp-add-cannot" className="text-[13px] leading-relaxed space-y-1">
              <Notice tone="warn">{cannotAdd}</Notice>
              <FundingNextStep needsSol={availableSol === 0n} needsToken={availableToken === 0n} mint={view.tokenMint} wallet={signer?.publicKey.toBase58() ?? null} />
            </div>
          )}
          <LpAmountPair
            sol={boxes.sol}
            token={boxes.token}
            driving={typed?.side ?? null}
            tokenDecimals={decimals}
            linked
            onType={onType}
            onMax={(side) => {
              if (side === 'sol' && availableSol !== null) setDriving('sol', availableSol);
              if (side === 'token' && availableToken !== null) setDriving('token', availableToken);
            }}
            canMax={{ sol: availableSol !== null, token: availableToken !== null }}
            hints={{ sol: hintFor('sol'), token: hintFor('token') }}
            errors={{ sol: parseError('sol'), token: parseError('token') }}
          />
          <SlippagePicker valueBps={slippageBps} onChange={setSlippageBps} hint={ADD_HINT} />
          {plan && (
            <div className="space-y-1.5" data-testid="lp-add-preview">
              <p className="text-white/45 text-[10px]">Worked out from the pool as the page read it; checked again on fresh reads when you press Review.</p>
              <Row label="You put in about" value={`${solAbout(solOf(plan).cost)} and ${tok(tokOf(plan).cost)}`} mono={false} />
              <Row label="At most" value={`${solExact(solOf(plan).max)} and ${unitsExact(tokOf(plan).max, decimals)} tokens`} mono={false} />
              <Row label="You get" value={`${unitsExact(plan.lp, pool.lpMintDecimals)} pool shares, exactly`} mono={false} />
              <Row label="Your share of the pool" value={shareRow} mono={false} />
              <Row label="Pool fee to add" value="none" mono={false} />
            </div>
          )}
          {walletReady && <WalletNeeded state={writes.signerState} />}
          {/* Always there, so a new problem is read out the moment it appears. */}
          <div className="space-y-2">
            <p role="alert" className="text-rose-300/90">
              {alertText}
            </p>
            {fix && (
              <button type="button" className="btn-secondary w-full min-h-[44px] text-[12px]" onClick={fix.run}>
                {fix.label}
              </button>
            )}
          </div>
          <p className="text-white/60">{NOTES_BELOW}</p>
          {!canReview && reviewWhy && (
            <p className="text-amber-300/90 text-[12px]" data-testid="lp-review-why">
              {reviewWhy}
            </p>
          )}
          <div className="flex flex-col sm:flex-row gap-2">
            <button ref={reviewRef} type="button" className="btn-primary w-full min-h-[44px] text-[13px] disabled:opacity-60 disabled:grayscale" disabled={!canReview} onClick={review}>
              Review: add liquidity
            </button>
            <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={onClose}>
              Close
            </button>
          </div>
          <p className="text-white/40 text-[10px]">
            {wsolKept && facts?.kind === 'ok'
              ? `You already hold ${unitsExact(facts.wsol.amount, 9)} wrapped SOL. None of it is spent. Up to ${plan ? solExact(solOf(plan).max - solOf(plan).cost) : 'the unused part'} of this deposit that the pool does not use stays in that account as wrapped SOL; your wallet app can unwrap it.`
              : 'Your SOL is wrapped into a token account for the deposit, and the account is closed at the end, so anything not used comes back as plain SOL.'}
          </p>
        </>
      )}
      <LpBeforeYouAdd launchPool={view.origin === 'launch-pool'} config={view.config} enableCreatorFee={pool.enableCreatorFee} />
      <p role="status" className="sr-only">
        {flow.state.step === 'idle' ? status : ''}
      </p>
    </PanelFrame>
  );
}
