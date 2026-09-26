import { useEffect, useRef, type ReactNode, type Ref } from 'react';
import { formatSol, formatTokenAmount } from '../../../lib/launcher/solana/curve';
import { ImpactRows, Notice, Row } from './ui';
import { DIVIDER, fractionToBps, sharePercent } from './uiFormat';
import type { FeeSplitView, PreparedTx, SolanaCluster, TxOutcome, TxSigner, TxSummary, WriteApi } from './ports';
import type { TxFlow } from './useTxFlow';

// What the user sees between pressing a Review button and the chain's answer.
// Every word here is about THIS transaction, and the numbers come from the
// prepared transaction, never from the form the user typed into.
//
// Screen readers: this view replaces the panel's form, so the button that had focus
// is gone. Each step moves focus to its own heading or notice (tabIndex -1), which
// also reads it out. Progress notes are role="status"; an outcome that needs the
// user's attention (refused, not sent, not confirmed) is role="alert". A review that
// goes stale moves focus to the alert saying so. A button whose work is running
// (Check again) stays focusable and says so in a status line, instead of switching
// off under the keyboard.

const SOL = (l: bigint) => `${formatSol(l)} SOL`;
const signedSol = (l: bigint) => `${l < 0n ? '-' : '+'}${SOL(l < 0n ? -l : l)}`;
function tokenText(v: bigint, d: number | null): string {
  const f = formatTokenAmount(v, d);
  return f.isBaseUnits ? `${f.text} (base units)` : f.text;
}

/** The amount a fee is measured against, in lamports, when the trade has one. */
function tradeLamports(s: TxSummary): bigint | null {
  switch (s.kind) {
    case 'buy':
      return s.quote.lamportsIn;
    case 'sell':
      return s.quote.lamportsOut;
    case 'pool-buy':
      return s.amountIn;
    case 'pool-sell':
      return s.quote.outAmount;
    case 'create':
      return s.openingBuy ? s.openingBuy.quote.lamportsIn : null;
    default:
      return null;
  }
}

/**
 * How the trade fee is scheduled to split. Not an upper bound per leg: when the
 * creator's wallet would be left below rent, the program pays the creator's share to
 * the platform instead, so the platform can receive the whole fee. The trader never
 * pays more than the fee.
 */
function FeeSplitRows({ split }: { split: FeeSplitView }) {
  return (
    <>
      <Row label="…creator's share" value={SOL(split.creator)} />
      <Row label="…platform's share" value={SOL(split.platform)} />
      <p className="text-white/40 text-[10px]">
        If the creator&apos;s wallet holds too little SOL to receive its share, that share goes to the platform instead.
      </p>
    </>
  );
}

export function SummaryRows({
  summary,
  decimals,
  display,
}: {
  summary: TxSummary;
  /** The launch mint's decimals, when read. `null` shows raw base units, never an assumed 9. */
  decimals: number | null;
  display: (s: string, max: number) => string;
}) {
  const tok = (v: bigint, d: number | null = decimals) => {
    const f = formatTokenAmount(v, d);
    return f.isBaseUnits ? `${f.text} (base units)` : f.text;
  };
  switch (summary.kind) {
    case 'create':
      return (
        <>
          <Row label="Name" value={display(summary.name, 32)} mono={false} />
          <Row label="Symbol" value={display(summary.symbol, 10)} />
          <Row label="Details link" value={summary.uri} />
          <Row label="Token address (mint)" value={summary.mint.toBase58()} />
          <Row label="Creator (you)" value={summary.creator.toBase58()} />
          <Row label="Decimals" value={String(summary.decimals)} />
          {summary.openingBuy ? (
            <>
              <Row label="Your opening buy: you pay" value={SOL(summary.openingBuy.quote.lamportsIn)} />
              <Row label="…of which trade fee" value={SOL(summary.openingBuy.quote.feeLamports)} />
              <Row label="You receive exactly" value={tok(summary.openingBuy.minTokensOut, 6)} />
            </>
          ) : (
            <Row label="Opening buy" value="none" mono={false} />
          )}
        </>
      );
    case 'buy':
      return (
        <>
          <Row label="Token address (mint)" value={summary.mint.toBase58()} />
          {summary.fillsCurve && (
            <Notice tone="warn">
              This buy fills the curve, so this transaction can take at most {SOL(summary.maxLamportsIn)} of the{' '}
              {SOL(summary.requestedLamports)} you entered. The rest never leaves your wallet.
            </Notice>
          )}
          <Row label="You pay (at most)" value={SOL(summary.maxLamportsIn)} />
          <Row label="…of which trade fee" value={SOL(summary.quote.feeLamports)} />
          <FeeSplitRows split={summary.feeSplit} />
          <Row label="You receive (quoted)" value={tok(summary.quote.tokensOut)} />
          <Row label="You receive at least" value={tok(summary.minTokensOut)} />
          <ImpactRows bps={summary.priceImpactBps} />
        </>
      );
    case 'sell':
      return (
        <>
          <Row label="Token address (mint)" value={summary.mint.toBase58()} />
          <Row label="You sell" value={tok(summary.tokensIn)} />
          <Row label="You receive (quoted)" value={SOL(summary.quote.lamportsOut)} />
          <Row label="Trade fee" value={SOL(summary.quote.feeLamports)} />
          <FeeSplitRows split={summary.feeSplit} />
          <Row label="You receive at least" value={SOL(summary.minLamportsOut)} />
          <ImpactRows bps={summary.priceImpactBps} />
        </>
      );
    case 'migrate':
      return (
        <>
          <Row label="Token address (mint)" value={summary.mint.toBase58()} />
          <Row label="Pool it opens" value={summary.pool.toBase58()} />
          <Notice>
            Finishing graduation moves the curve&apos;s SOL and unsold tokens into the pool and burns the pool&apos;s
            LP tokens. Anyone can do it. You pay the transaction fees shown below. The rent for the accounts it opens
            for you is paid back to you inside the same transaction.
          </Notice>
        </>
      );
    case 'release':
      return (
        <>
          <Row label="Token address (mint)" value={summary.mint.toBase58()} />
          <Row label="Tokens released" value={tok(summary.amount)} />
          <Row label="Sent to (platform treasury)" value={summary.recipient.toBase58()} />
          <Notice>Anyone can do this once a launch has graduated. It pays you nothing.</Notice>
        </>
      );
    case 'pool-buy':
    case 'pool-sell': {
      const buying = summary.kind === 'pool-buy';
      return (
        <>
          <Row label="Token address (mint)" value={summary.mint.toBase58()} />
          <Row label="Pool" value={summary.pool.toBase58()} />
          <Row label="You pay" value={buying ? SOL(summary.amountIn) : tok(summary.amountIn)} />
          <Row label="You receive (quoted)" value={buying ? tok(summary.quote.outAmount) : SOL(summary.quote.outAmount)} />
          <Row label="You receive at least" value={buying ? tok(summary.minimumAmountOut) : SOL(summary.minimumAmountOut)} />
          <Row
            label="Pool fee (inside what you pay)"
            value={buying ? SOL(summary.quote.result.tradeFee) : tok(summary.quote.result.tradeFee)}
          />
          <PoolCreatorFeeRow quote={summary.quote} buying={buying} sol={SOL} tok={tok} />
          <ImpactRows bps={fractionToBps(summary.quote.priceImpact)} />
          <Notice>
            {buying
              ? 'Your SOL is wrapped into a token account for the swap'
              : 'The pool pays out wrapped SOL'}
            {summary.unwrapsWsol
              ? ', and that account is closed at the end, so you get plain SOL back.'
              : '. You already had a wrapped SOL account, so it is left open with its balance.'}
          </Notice>
        </>
      );
    }
  }
}

/**
 * The pool creator's cut, when the pool charges one. cp-swap takes it on top of the
 * trade fee: from what you pay, or from what you receive, depending on the pool.
 */
export function PoolCreatorFeeRow({
  quote,
  buying,
  sol,
  tok,
}: {
  quote: { result: { creatorFee: bigint }; creatorFeeOnInput: boolean };
  buying: boolean;
  sol: (v: bigint) => string;
  tok: (v: bigint) => string;
}) {
  const fee = quote.result.creatorFee;
  if (fee <= 0n) return null;
  const onInput = quote.creatorFeeOnInput;
  // Buying pays SOL and receives tokens; selling the other way round.
  const inSol = onInput === buying;
  return (
    <Row
      label={onInput ? 'Creator fee (on top, from what you pay)' : 'Creator fee (taken from what you receive)'}
      value={inSol ? sol(fee) : tok(fee)}
    />
  );
}

export function FeeRows({ prepared, decimals }: { prepared: PreparedTx; decimals: number | null }) {
  const f = prepared.fees;
  const base = tradeLamports(prepared.summary);
  const share = base !== null && base > 0n ? sharePercent(f.priorityLamports, base) : null;
  return (
    <>
      <Row label="Network fee" value={SOL(f.baseLamports)} />
      <Row
        label="Priority fee"
        value={
          !f.priorityFeeRead
            ? 'none added'
            : `${SOL(f.priorityLamports)}${share ? ` (${share} of this trade)` : ''}`
        }
      />
      {!f.priorityFeeRead && (
        <Notice tone="warn">
          The current fee level could not be read, so no priority fee is added. It may take longer to land.
        </Notice>
      )}
      {f.newAccountRentLamports > 0n && (
        <Row
          label={
            prepared.kind === 'create'
              ? 'One-time account rent (token, curve and token accounts)'
              : 'One-time account rent'
          }
          value={SOL(f.newAccountRentLamports)}
        />
      )}
      {prepared.kind === 'create' && (
        <p className="text-white/40 text-[10px]">
          The token details account&apos;s rent and the token details program&apos;s own fee are not in that line. The
          test run below includes everything.
        </p>
      )}
      <Row label="Test run: your SOL changes by" value={signedSol(prepared.simulated.signerLamportsDelta)} />
      {prepared.simulated.tokenDeltas
        .filter((t) => t.delta !== 0n)
        .map((t) => (
          <Row
            key={t.account.toBase58()}
            label="Test run: your tokens change by"
            value={`${t.delta < 0n ? '-' : '+'}${tokenText(t.delta < 0n ? -t.delta : t.delta, decimals)}`}
          />
        ))}
    </>
  );
}

const TITLES: Record<PreparedTx['kind'], string> = {
  create: 'Review your launch',
  buy: 'Review your buy',
  sell: 'Review your sell',
  migrate: 'Review: finish graduation',
  release: 'Review: release the platform reserve',
  'pool-buy': 'Review your pool buy',
  'pool-sell': 'Review your pool sell',
};

export function TxReview({
  prepared,
  decimals,
  display,
  extra,
  headingRef,
}: {
  prepared: PreparedTx;
  decimals: number | null;
  display: (s: string, max: number) => string;
  /** Anything the kind needs on top, such as the create flow's public-forever list. */
  extra?: ReactNode;
  /** Focus lands here when the review appears. */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="space-y-2" data-testid="tx-review">
      <h3 ref={headingRef} tabIndex={-1} className="text-white font-semibold text-[12px] outline-none">
        {TITLES[prepared.kind]}
      </h3>
      {extra}
      <SummaryRows summary={prepared.summary} decimals={decimals} display={display} />
      <div className="pt-2 space-y-1.5" style={DIVIDER}>
        <FeeRows prepared={prepared} decimals={prepared.kind === 'create' ? 6 : decimals} />
      </div>
      <Notice tone="good">Test run passed: the network ran this exact transaction without sending it.</Notice>
    </div>
  );
}

function ExplorerLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline text-white/80">
      View on the explorer
    </a>
  );
}

function SignatureRow({ signature }: { signature: string }) {
  return <Row label="Transaction signature" value={signature} />;
}

/** What a refused transaction cost: both fees are charged when the program refuses it. */
function feesSpentText(fees: PreparedTx['fees'] | null | undefined): string {
  if (!fees) return 'Nothing moved except the fees (the network fee and any priority fee).';
  const which = fees.priorityLamports > 0n ? 'the network fee and the priority fee' : 'the network fee';
  return `Nothing moved except the fees: ${SOL(fees.baseLamports + fees.priorityLamports)} (${which}).`;
}

const EXPIRED_TEXT = 'Did not go through, and it can no longer go through. Nothing was charged. It is safe to try again.';

const NOT_SENT_COPY: Record<'build' | 'simulate' | 'sign' | 'send', string> = {
  build: 'Not sent. We could not build this transaction.',
  simulate: 'Not sent. A test run of this transaction was refused, so we did not ask your wallet to sign it.',
  sign: 'Not sent. Your wallet did not sign it.',
  send: 'Not sent. The network turned it away before running it.',
};

export function TxOutcomeCard({
  outcome,
  explorerUrl,
  onRecheck,
  onReset,
  rechecking,
  boxRef,
  fees,
  checks = 0,
}: {
  outcome: TxOutcome;
  /** `null` when there is no signature to link. */
  explorerUrl: string | null;
  onRecheck: () => void;
  onReset: () => void;
  rechecking: boolean;
  /** Focus lands here when the outcome appears. */
  boxRef?: Ref<HTMLDivElement>;
  /** The fees the transaction carried, so a refusal can say what it cost. */
  fees?: PreparedTx['fees'] | null;
  /** How many times Check again has answered. */
  checks?: number;
}) {
  // Done is news; everything else needs the user to read it before acting.
  const a11y = {
    ref: boxRef,
    tabIndex: -1,
    role: outcome.status === 'confirmed' ? 'status' : 'alert',
    className: 'space-y-1.5 outline-none',
  } as const;
  switch (outcome.status) {
    case 'confirmed':
      return (
        <div {...a11y} data-testid="tx-outcome" data-status="confirmed">
          <Notice tone="good">Done. The network confirmed it.</Notice>
          <SignatureRow signature={outcome.signature} />
          {explorerUrl && <ExplorerLink href={explorerUrl} />}
          <button type="button" onClick={onReset} className="btn-secondary w-full py-2 text-[12px] mt-1">
            Close
          </button>
        </div>
      );
    case 'reverted':
      return (
        <div {...a11y} data-testid="tx-outcome" data-status="reverted">
          <Notice tone="bad">It did not go through. The network ran it and the program refused it.</Notice>
          {outcome.message && <Notice>{outcome.message}</Notice>}
          <Notice>{feesSpentText(fees)}</Notice>
          <SignatureRow signature={outcome.signature} />
          {explorerUrl && <ExplorerLink href={explorerUrl} />}
          <button type="button" onClick={onReset} className="btn-secondary w-full py-2 text-[12px] mt-1">
            Start over
          </button>
        </div>
      );
    case 'expired':
      return (
        <div {...a11y} data-testid="tx-outcome" data-status="expired">
          <Notice tone="warn">{EXPIRED_TEXT}</Notice>
          {outcome.signature && <SignatureRow signature={outcome.signature} />}
          <button type="button" onClick={onReset} className="btn-secondary w-full py-2 text-[12px] mt-1">
            Start over
          </button>
        </div>
      );
    case 'unknown':
      if (outcome.signature) {
        // The alert (what this is, what not to do) is read once, when it appears. What
        // each check found goes in the status line under it, so a new answer is read
        // out on its own, and pressing Check again does not re-read the whole alert.
        const found = rechecking
          ? 'Checking the network…'
          : checks > 0
            ? `Check ${checks}: ${outcome.message}`
            : outcome.message;
        return (
          <div className="space-y-1.5" data-testid="tx-outcome" data-status="unknown">
            <div ref={boxRef} tabIndex={-1} role="alert" className="space-y-1.5 outline-none">
              <Notice tone="warn">Sent, not confirmed yet. Do not retry until you check.</Notice>
              <Notice>
                It may still land. Sending again could make you pay twice. Check again, or look it up on the explorer.
              </Notice>
              <SignatureRow signature={outcome.signature} />
              {explorerUrl && <ExplorerLink href={explorerUrl} />}
            </div>
            <p role="status" className="text-white/55" data-testid="tx-check-result">
              {found}
            </p>
            <button
              type="button"
              // Not `disabled`: a button switched off under the keyboard drops focus to
              // the page. It stays focusable and does nothing while a check runs.
              aria-disabled={rechecking || undefined}
              onClick={() => {
                if (!rechecking) onRecheck();
              }}
              className={`btn-primary w-full py-2 text-[12px] mt-1 ${rechecking ? 'opacity-60' : ''}`}
            >
              Check again
            </button>
            <button type="button" onClick={onReset} className="btn-secondary w-full py-2 text-[12px]">
              I checked my wallet: start over
            </button>
          </div>
        );
      }
      return (
        <div {...a11y} data-testid="tx-outcome" data-status="unknown">
          <Notice tone="warn">We cannot tell whether this was sent.</Notice>
          <Notice>{outcome.message}</Notice>
          <button type="button" onClick={onReset} className="btn-secondary w-full py-2 text-[12px] mt-1">
            I checked my wallet: start over
          </button>
        </div>
      );
    case 'not-sent':
      return (
        <div {...a11y} data-testid="tx-outcome" data-status="not-sent">
          <Notice tone="warn">{NOT_SENT_COPY[outcome.stage]}</Notice>
          {outcome.message && <Notice>{outcome.message}</Notice>}
          <Notice>Nothing was charged.</Notice>
          <button type="button" onClick={onReset} className="btn-secondary w-full py-2 text-[12px] mt-1">
            Start over
          </button>
        </div>
      );
  }
}

/**
 * The whole in-panel transaction flow: the building note, the review with its
 * Sign button, the waiting note, and the outcome. A panel renders this in place of
 * its form whenever the flow is not idle.
 */
export function TxFlowView({
  flow,
  api,
  cluster,
  decimals,
  signer,
  extraReview,
  preparingText,
}: {
  flow: TxFlow;
  api: Pick<WriteApi, 'explorerTxUrl' | 'meta'>;
  cluster: SolanaCluster;
  decimals: number | null;
  /** `null` when no wallet that can sign is connected. */
  signer: TxSigner | null;
  extraReview?: ReactNode;
  /** What is happening while it builds, when that is more than building (the launch's upload request). */
  preparingText?: string;
}) {
  const s = flow.state;
  // One focus target per step. Moving focus both keeps keyboard users in place (the
  // form's button is gone) and makes a screen reader read the new step. A review
  // going stale is a step of its own: its Sign button is switched off, so focus
  // moves to the alert that says why.
  const focusRef = useRef<HTMLElement | null>(null);
  const staleRef = useRef<HTMLParagraphElement | null>(null);
  const stepKey =
    s.step === 'outcome' ? `outcome:${s.outcome.status}` : s.step === 'review' && s.expired ? 'review:stale' : s.step;
  useEffect(() => {
    (stepKey === 'review:stale' ? staleRef.current : focusRef.current)?.focus();
  }, [stepKey]);
  const setFocus = (el: HTMLElement | null) => {
    focusRef.current = el;
  };
  if (s.step === 'idle') return null;
  if (s.step === 'preparing') {
    return (
      <p ref={setFocus} tabIndex={-1} role="status" className="text-white/55 outline-none">
        {preparingText ?? 'Building the transaction and test-running it on the network…'}
      </p>
    );
  }
  if (s.step === 'review') {
    return (
      <div className="space-y-3">
        <TxReview
          prepared={s.prepared}
          decimals={decimals}
          display={api.meta.displaySafe}
          extra={extraReview}
          headingRef={setFocus}
        />
        {s.expired ? (
          <p ref={staleRef} tabIndex={-1} role="alert" className="text-amber-300/90 outline-none">
            This quote is too old to sign: the network would soon refuse it. Start over for a fresh one.
          </p>
        ) : signer === null ? (
          <Notice tone="warn">Connect a wallet that can sign to continue.</Notice>
        ) : (
          // A status line: between Sign and the wallet opening, the block height is read
          // (up to a few seconds), and this says so instead of nothing changing.
          <p role="status" className="text-white/40 text-[10px]">
            {s.checking
              ? 'Checking the network before your wallet opens…'
              : 'Your wallet will show this transaction next. Sign only if it matches what is above.'}
          </p>
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            className={`btn-primary w-full py-2.5 text-[13px] disabled:opacity-60 ${s.checking ? 'opacity-60' : ''}`}
            disabled={s.expired || signer === null}
            aria-disabled={s.checking || undefined}
            onClick={() => signer && !s.checking && flow.confirm(signer)}
          >
            Sign in wallet
          </button>
          <button type="button" className="btn-secondary w-full py-2.5 text-[13px]" onClick={flow.reset}>
            {s.expired ? 'Start over' : 'Cancel'}
          </button>
        </div>
      </div>
    );
  }
  if (s.step === 'submitting') {
    return (
      <p ref={setFocus} tabIndex={-1} role="status" className="text-white/55 outline-none">
        Waiting for your wallet. Approve the transaction there to send it.
      </p>
    );
  }
  if (s.step === 'sent') {
    const url = api.explorerTxUrl(s.signature, cluster);
    return (
      <div ref={setFocus} tabIndex={-1} role="status" className="space-y-1.5 outline-none" data-testid="tx-sent">
        <Notice>Sent. Waiting for the network to confirm it. This can take up to two minutes.</Notice>
        <Notice tone="warn">
          Do not send it again. If you leave or reload, this browser keeps a note of it, and the page checks it when you
          come back.
        </Notice>
        <SignatureRow signature={s.signature} />
        <ExplorerLink href={url} />
      </div>
    );
  }
  const sig = 'signature' in s.outcome ? s.outcome.signature : '';
  return (
    <TxOutcomeCard
      outcome={s.outcome}
      explorerUrl={sig ? api.explorerTxUrl(sig, cluster) : null}
      onRecheck={() => void flow.recheck()}
      onReset={flow.reset}
      rechecking={s.rechecking}
      boxRef={setFocus}
      fees={s.prepared?.fees ?? null}
      checks={s.checks ?? 0}
    />
  );
}
