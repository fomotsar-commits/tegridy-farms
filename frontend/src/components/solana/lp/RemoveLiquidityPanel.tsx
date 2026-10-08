import { useCallback, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { associatedTokenAddress } from '../../../lib/launcher/solana/curve/ix';
import { displaySafe } from '../../../lib/launchMetadata/validate';
import { swapEnabled } from '../../../lib/solana/cpswap/program';
import { feeReserveFor, isPlanProblem, planWithdraw, type PlanProblem, type WithdrawPlan } from '../../../lib/solana/lp/liquidityMath';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { formatWhen } from '../../../lib/solana/lp/poolHealth';
import type { Position } from '../../../lib/solana/lp/positions';
import { TOKEN_PROGRAM, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { Notice, Row, SlippagePicker } from '../curve/ui';
import { DEFAULT_SLIPPAGE_BPS, sharePercent } from '../curve/uiFormat';
import { TxFlowView } from '../curve/TxFlowView';
import { WalletNeeded } from '../curve/WalletNeeded';
import { useReturnFocus, useTxFlow } from '../curve/useTxFlow';
import type { LpOpenGate, LpWriteApi } from '../curve/ports';
import { ALL_BPS, PercentPicker } from './PercentPicker';
import { PanelFrame } from './PanelFrame';
import { coinAbout, coinExact, sharePct, solAbout, solExact, tokensAbout, unitsExact, useDebounced, useFlowReports, useSettledAlert, useWalletFacts } from './panelKit';
import { lpHeld } from './offers';
import { useLpWrites, type LpWrites } from './useLpWrites';

const REMOVE_HINT = 'If the pool’s price moves more than this before your withdrawal runs, it is refused and only the network fees are spent.';
/** One signature's network fee, for the row that says what leaving costs. */
const BASE_FEE_LAMPORTS = 5_000n;

/**
 * Take liquidity out of one pool, in place inside its position row. Offered whenever
 * the pool program itself would let the person leave (offers.ts `withdrawOffer`), and
 * never held back for the price, the open time, the swap or deposit switches or the
 * token's verdict. Pressing Review reads the pool and the pool-share account again and
 * builds from those (write/liquidity.ts `prepareLpWithdraw`).
 *
 * THE POOL'S COIN (`view.quote`: SOL, USDC or BAYLA). What comes back on the coin's side
 * is printed in THAT coin's decimals, never SOL's 9. SOL comes back as plain SOL. Any
 * other coin is paid into the wallet's own account for it, which the withdrawal opens
 * when it is missing. Nothing about the coin ever switches Review off: not a missing
 * account, not a balance that could not be read, not a wallet that may be short of the
 * SOL to open an account. That last one is said as a warning, and the review's own
 * reads and its test run decide.
 */
export function RemoveLiquidityPanel(p: {
  position: Position;
  view: PoolView;
  safety: TokenSafety | null;
  tokenDecimals: number | null;
  chainNow: bigint | null;
  setAside: boolean;
  onClose: () => void;
}) {
  const writes = useLpWrites();
  const gate = writes?.gate?.kind === 'open' ? writes.gate : null;
  if (!writes || !writes.api || !gate) return null;
  return <RemoveInner {...p} writes={writes} api={writes.api} gate={gate} />;
}

function RemoveInner({
  position,
  view,
  safety,
  tokenDecimals,
  chainNow,
  setAside,
  onClose,
  writes,
  api,
  gate,
}: {
  position: Position;
  view: PoolView;
  safety: TokenSafety | null;
  tokenDecimals: number | null;
  chainNow: bigint | null;
  setAside: boolean;
  onClose: () => void;
  writes: LpWrites;
  api: LpWriteApi;
  gate: LpOpenGate;
}) {
  const pool = view.snapshot.pool;
  const coin = view.quote;
  const decimals = tokenDecimals ?? (view.quoteIsToken0 ? pool.mint1Decimals : pool.mint0Decimals);
  const tokenProgram = view.quoteIsToken0 ? pool.token1Program : pool.token0Program;
  const signer = writes.signerState.kind === 'ready' ? writes.signerState.signer : null;
  const [factsNonce, setFactsNonce] = useState(0);
  const facts = useWalletFacts(writes, signer?.publicKey ?? null, { tokenMint: view.tokenMint, tokenProgram, lpMint: null, quote: coin }, factsNonce);

  // Nothing chosen at first: nothing can be reviewed until the person picks.
  const [pct, setPct] = useState<bigint | 'bad' | null>(null);
  const [slippageBps, setSlippageBps] = useState<bigint | null>(DEFAULT_SLIPPAGE_BPS);

  const flow = useTxFlow(api, writes.rpc, writes.pending.record, writes.pending.sent);
  const { target: reviewRef, fallback: headingRef } = useReturnFocus(flow.state.step);
  const reread = useCallback(() => setFactsNonce((n) => n + 1), []);
  useFlowReports(writes, flow.state.step, flow.locked, reread);

  const held = position.lpAmount;
  const result = useMemo(
    () => (typeof pct === 'bigint' ? planWithdraw(view.snapshot, { held, pctBps: pct, bps: slippageBps ?? DEFAULT_SLIPPAGE_BPS }) : null),
    [pct, view, held, slippageBps],
  );
  const plan: WithdrawPlan | null = result && !isPlanProblem(result) ? result : null;
  const problem: PlanProblem | null = result && isPlanProblem(result) ? result : null;
  // The coin's side of a plan, in the coin's own base units, and the token's.
  const coinOut = (pl: WithdrawPlan) => ({ out: view.quoteIsToken0 ? pl.out0 : pl.out1, min: view.quoteIsToken0 ? pl.min0 : pl.min1 });
  const tokOut = (pl: WithdrawPlan) => ({ out: view.quoteIsToken0 ? pl.out1 : pl.out0, min: view.quoteIsToken0 ? pl.min1 : pl.min0 });
  const shares = (v: bigint) => unitsExact(v, pool.lpMintDecimals);
  const tok = (v: bigint) => tokensAbout(v, decimals);

  let problemText = '';
  let takeAll = false;
  if (pct === 'bad') problemText = 'Enter a percent from 0.01 to 100.';
  else if (problem) {
    switch (problem.problem) {
      case 'dust-remainder':
        problemText = `That would leave ${shares(problem.keep)} pool shares, too few to ever take out at this pool’s size. Take out all of it instead?`;
        takeAll = true;
        break;
      case 'too-small':
        problemText = 'Too small: one side would round to zero. Take out a larger share, or all of it.';
        break;
      default:
        problemText = 'This could not be worked out from the pool as the page read it. Read your positions again.';
    }
  }
  // Read out once typing settles, never on every keystroke (its numbers change with each digit).
  const alertText = useSettledAlert(problemText);

  // Where the tokens land: the associated account under the pool's token program, which
  // the withdrawal opens when it is missing. Said only once the wallet was read.
  const owner = signer?.publicKey ?? null;
  const tokenMissing = facts?.kind === 'ok' && !facts.token;
  const tokenAccount = useMemo(
    () =>
      !owner || facts?.kind !== 'ok'
        ? null
        : facts.token
          ? facts.token.address
          : associatedTokenAddress(new PublicKey(view.tokenMint), owner, new PublicKey(tokenProgram)).toBase58(),
    [owner, facts, view.tokenMint, tokenProgram],
  );
  // A classic account is 165 bytes; a Token-2022 one is larger and sized by its mint (D20),
  // so its deposit is left to the review, which reads it exactly.
  const rent = facts?.kind === 'ok' && tokenProgram === TOKEN_PROGRAM ? facts.rents.tokenAccount165 : null;
  const solArrives =
    facts?.kind !== 'ok'
      ? 'not read yet (the review will say)'
      : facts.wsol.exists && facts.wsol.amount > 0n
        ? 'as wrapped SOL in the account you already hold'
        : 'as plain SOL';
  // A coin that is not SOL arrives in the wallet's own account for it, opened here when
  // there is none. Null for SOL, and while the wallet is unread: nothing is said of an
  // account that was not looked at.
  const coinAccount = !coin.native && facts?.kind === 'ok' ? facts.coin : null;
  const coinMissing = coinAccount !== null && !coinAccount.exists;
  // Sized by the coin's own mint (165 bytes for USDC, 170 for BAYLA), so it is the kit's figure.
  const coinRent = facts?.kind === 'ok' ? (facts.rents.coinAccount ?? null) : null;
  // The accounts this withdrawal opens, each with the deposit it keeps (null: the review reads it).
  const opens = [...(tokenMissing ? [{ what: 'token', rent }] : []), ...(coinMissing ? [{ what: coin.symbol, rent: coinRent }] : [])];
  const opensText = opens.map((o) => `the ${o.what} account`).join(' and ');
  const depositsKnown = opens.every((o) => o.rent !== null);
  // What those accounts' deposits come to. One that was not read is counted at the classic
  // account's deposit, never at 0: no token account costs less, so the sum is then the
  // LEAST they can come to (`depositsKnown` says whether it is exact). Counted as 0, a
  // wallet short of SOL was told a figure half the truth, or told nothing (review, 2026-10-04).
  const smallestDeposit = facts?.kind === 'ok' ? facts.rents.tokenAccount165 : 0n;
  const deposits = opens.reduce((sum, o) => sum + (o.rent ?? smallestDeposit), 0n);
  // The wallet pays those deposits and the fee in SOL before anything comes back, and
  // must keep its own floor. Below that it MAY be refused: said, never a reason to stop
  // someone leaving. Only for a coin that is not SOL (a SOL pool's words are unchanged).
  const mayLackSol =
    !coin.native && facts?.kind === 'ok' && opens.length > 0 && facts.lamports < deposits + feeReserveFor(1) + facts.rents.walletFloor
      ? { has: facts.lamports, deposits }
      : null;

  const swapsLine = !swapEnabled(pool)
    ? 'Swaps on this pool are switched off. That does not stop you taking your liquidity out.'
    : chainNow !== null && chainNow < pool.openTime
      ? `Swaps on this pool are blocked until ${formatWhen(pool.openTime)}. That does not stop you taking your liquidity out.`
      : null;
  const blockedLine =
    safety?.kind === 'read' && safety.verdict === 'blocked'
      ? `This site does not take new deposits of this token (${safety.blocks[0]?.text ?? 'see the token check'}). You can still take your liquidity out.`
      : null;

  const value = position.value;
  const holdText = value
    ? `${shares(held)} pool shares, ${value.sharePct.toFixed(4)}% of the pool, worth about ${coinAbout(view.quoteIsToken0 ? value.token0 : value.token1, coin)} and ${tok(view.quoteIsToken0 ? value.token1 : value.token0)} now`
    : `${shares(held)} pool shares`;

  const status = useDebounced(
    plan ? `You would give back ${shares(plan.lp)} pool shares and get at least ${coinExact(coinOut(plan).min, coin)} and ${unitsExact(tokOut(plan).min, decimals)} tokens.` : '',
  );

  // A withdrawal from this pool still pending (this panel's own, or one found after a reload) holds it.
  const pendingHere = lpHeld(writes.pending.notes, view.address, 'remove');
  const canReview = !!signer && !!plan && slippageBps !== null && !flow.locked && !pendingHere && typeof pct === 'bigint';
  const review = () => {
    if (!signer || !plan || typeof pct !== 'bigint' || slippageBps === null) return;
    const build = () =>
      api.prepareLpWithdraw(writes.rpc, gate, {
        owner: signer.publicKey,
        pool: new PublicKey(view.address),
        tokenMint: new PublicKey(view.tokenMint),
        quoteMint: new PublicKey(view.quote.mint),
        lpAccount: new PublicKey(position.lpAccount),
        pctBps: pct,
        slippageBps,
      });
    void flow.prepare(build, { repeatable: true });
  };

  const callsItself = !setAside && safety?.kind === 'read' && (safety.name || safety.symbol)
    ? `${displaySafe(safety.name ?? '', 32)} (${displaySafe(safety.symbol ?? '', 12)})`
    : null;

  return (
    <PanelFrame testId="lp-remove-panel" title="Remove liquidity from this pool" headingRef={headingRef}>
      <div className="space-y-1.5">
        <Row label="Pool" value={view.address} />
        <Row label="Token" value={view.tokenMint} />
        {callsItself && <Row label="Calls itself" value={callsItself} mono={false} />}
        <Row label="You hold" value={holdText} mono={false} />
        <Row
          label="Network fee and account deposit"
          value={
            opens.length > 0 && !depositsKnown
              ? `about ${solAbout(BASE_FEE_LAMPORTS)}, plus a deposit for ${opensText} it opens (the review shows ${opens.length > 1 ? 'them' : 'it'})`
              : facts?.kind !== 'ok'
                ? `about ${solAbout(BASE_FEE_LAMPORTS)}, plus a deposit if your token account${coin.native ? '' : ` or your ${coin.symbol} account`} is missing`
                : `about ${solExact(BASE_FEE_LAMPORTS + deposits)}`
          }
          mono={false}
        />
      </div>
      {flow.state.step !== 'idle' ? (
        <TxFlowView
          flow={flow}
          api={api}
          cluster={gate.cfg.cluster}
          decimals={decimals}
          signer={signer}
          preparingText="Reading the pool again and test-running your withdrawal on the network…"
        />
      ) : (
        <>
          <PercentPicker valueBps={typeof pct === 'bigint' ? pct : null} onChange={(v) => setPct(v.bad ? 'bad' : v.bps)} />
          <SlippagePicker valueBps={slippageBps} onChange={setSlippageBps} hint={REMOVE_HINT} />
          {plan && (
            <div className="space-y-1.5" data-testid="lp-remove-preview">
              <p className="text-white/45 text-[10px]">Worked out from your position as the page read it; checked again on fresh reads when you press Review.</p>
              <Row label="You give back" value={`${shares(plan.lp)} pool shares (${sharePercent(plan.lp, held) ?? sharePct(plan.lp, held)} of yours)`} mono={false} />
              <Row label="You get about" value={`${coinAbout(coinOut(plan).out, coin)} and ${tok(tokOut(plan).out)}`} mono={false} />
              <Row label="You get at least" value={`${coinExact(coinOut(plan).min, coin)} and ${unitsExact(tokOut(plan).min, decimals)} tokens`} mono={false} />
              <Row label="You keep" value={plan.keep > 0n ? `${shares(plan.keep)} pool shares` : 'none in this pool'} mono={false} />
              {coin.native ? (
                <Row label="The SOL arrives" value={solArrives} mono={false} />
              ) : coinAccount ? (
                <>
                  <Row label={`The ${coin.symbol} arrives in`} value={coinAccount.address} />
                  {coinMissing && (
                    <p className="text-white/55 text-[10px]">
                      {coinRent !== null
                        ? `Opened for you; its deposit of ${solExact(coinRent)} stays in that account.`
                        : 'Opened for you; its deposit stays in that account (the review shows the amount).'}
                    </p>
                  )}
                </>
              ) : (
                <Row label={`The ${coin.symbol} arrives in`} value={`this wallet’s own ${coin.symbol} account, opened for you if it has none (not read yet; the review will say)`} mono={false} />
              )}
              {tokenAccount && (
                <>
                  <Row label="The tokens arrive in" value={tokenAccount} />
                  {tokenMissing && (
                    <p className="text-white/55 text-[10px]">
                      {rent !== null
                        ? `Opened for you; its deposit of ${solExact(rent)} stays in that account.`
                        : 'Opened for you; its deposit stays in that account (the review shows the amount).'}
                    </p>
                  )}
                </>
              )}
              <Row label="Pool fee to take out" value="none" mono={false} />
            </div>
          )}
          {swapsLine && <Notice tone="warn">{swapsLine}</Notice>}
          {blockedLine && <Notice tone="warn">{blockedLine}</Notice>}
          {/* A warning only. Review stays on: its own reads and its test run decide. */}
          {mayLackSol && (
            <div data-testid="lp-remove-may-lack-sol">
              <Notice tone="warn">
                {`This wallet may be short of SOL for this. It has ${solExact(mayLackSol.has)}. This withdrawal opens ${opensText}, ${
                  opens.length > 1 ? 'whose deposits come to' : 'whose deposit is'
                } ${depositsKnown ? solExact(mayLackSol.deposits) : `at least ${solExact(mayLackSol.deposits)} (the review shows the exact figure)`}, and pays the network fee. You can still press Review: it test-runs the withdrawal and says for sure. If it is refused, send a little SOL to this wallet and try again.`}
              </Notice>
            </div>
          )}
          <WalletNeeded state={writes.signerState} />
          <div className="space-y-2">
            <p role="alert" className="text-rose-300/90">
              {alertText}
            </p>
            {takeAll && (
              <button type="button" className="btn-secondary w-full min-h-[44px] text-[12px]" onClick={() => setPct(ALL_BPS)}>
                Take out all of it
              </button>
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <button ref={reviewRef} type="button" className="btn-primary w-full min-h-[44px] text-[13px] disabled:opacity-60 disabled:grayscale" disabled={!canReview} onClick={review}>
              Review: remove liquidity
            </button>
            <button type="button" className="btn-secondary min-h-[44px] px-4 text-[13px]" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
      <p role="status" className="sr-only">
        {flow.state.step === 'idle' ? status : ''}
      </p>
    </PanelFrame>
  );
}
