import type { ReactNode } from 'react';
import { formatSol, formatTokenAmount } from '../../../lib/launcher/solana/curve';
import { Notice, Row } from './ui';
import { DIVIDER, sharePercent } from './uiFormat';
import type { FeeSplitView, PreparedTx, SolanaCluster, TxOutcome, TxSigner, TxSummary, WriteApi } from './ports';
import type { TxFlow } from './useTxFlow';

// What the user sees between pressing a Review button and the chain's answer.
// Every word here is about THIS transaction, and the numbers come from the
// prepared transaction, never from the form the user typed into.

const SOL = (l: bigint) => `${formatSol(l)} SOL`;
const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;
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
          <Row label="Price impact" value={pct(summary.priceImpactBps)} />
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
          <Row label="Price impact" value={pct(summary.priceImpactBps)} />
        </>
      );
    case 'migrate':
      return (
        <>
          <Row label="Token address (mint)" value={summary.mint.toBase58()} />
          <Row label="Pool it opens" value={summary.pool.toBase58()} />
          <Notice>
            Finishing graduation moves the curve&apos;s SOL and unsold tokens into the pool and burns the pool&apos;s
            LP tokens. Anyone can do it. You pay the network fee. The rent for the accounts it opens for you is paid
            back to you inside the same transaction.
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
          <Row label="Price impact" value={`${(summary.quote.priceImpact * 100).toFixed(2)}%`} />
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
}: {
  prepared: PreparedTx;
  decimals: number | null;
  display: (s: string, max: number) => string;
  /** Anything the kind needs on top, such as the create flow's public-forever list. */
  extra?: ReactNode;
}) {
  return (
    <div className="space-y-2" data-testid="tx-review">
      <p className="text-white font-semibold text-[12px]">{TITLES[prepared.kind]}</p>
      {extra}
      <SummaryRows summary={prepared.summary} decimals={decimals} display={display} />
      <div className="pt-2 space-y-1.5" style={DIVIDER}>
        <FeeRows prepared={prepared} decimals={prepared.kind === 'create' ? 6 : decimals} />
      </div>
      <Notice tone="good">
        Test run passed: the network ran this exact transaction without sending it
        ({prepared.simulation.unitsConsumed.toLocaleString('en-US')} compute units).
      </Notice>
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
}: {
  outcome: TxOutcome;
  /** `null` when there is no signature to link. */
  explorerUrl: string | null;
  onRecheck: () => void;
  onReset: () => void;
  rechecking: boolean;
}) {
  switch (outcome.status) {
    case 'confirmed':
      return (
        <div className="space-y-1.5" data-testid="tx-outcome" data-status="confirmed">
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
        <div className="space-y-1.5" data-testid="tx-outcome" data-status="reverted">
          <Notice tone="bad">It did not go through. The network ran it and the program refused it.</Notice>
          <Notice>{outcome.message}</Notice>
          <Notice>Nothing moved except the network fee.</Notice>
          <SignatureRow signature={outcome.signature} />
          {explorerUrl && <ExplorerLink href={explorerUrl} />}
          <button type="button" onClick={onReset} className="btn-secondary w-full py-2 text-[12px] mt-1">
            Start over
          </button>
        </div>
      );
    case 'expired':
      return (
        <div className="space-y-1.5" data-testid="tx-outcome" data-status="expired">
          <Notice tone="warn">Did not go through. Nothing was charged. It is safe to try again.</Notice>
          {outcome.message && <Notice>{outcome.message}</Notice>}
          {outcome.signature && <SignatureRow signature={outcome.signature} />}
          <button type="button" onClick={onReset} className="btn-secondary w-full py-2 text-[12px] mt-1">
            Start over
          </button>
        </div>
      );
    case 'unknown':
      return (
        <div className="space-y-1.5" data-testid="tx-outcome" data-status="unknown">
          {outcome.signature ? (
            <>
              <Notice tone="warn">Sent, not confirmed yet. Do not retry until you check.</Notice>
              <Notice>
                It may still land. Sending again could make you pay twice. Check again, or look it up on the explorer.
              </Notice>
              <SignatureRow signature={outcome.signature} />
              {explorerUrl && <ExplorerLink href={explorerUrl} />}
              <button
                type="button"
                onClick={onRecheck}
                disabled={rechecking}
                className="btn-primary w-full py-2 text-[12px] mt-1 disabled:opacity-60"
              >
                {rechecking ? 'Checking…' : 'Check again'}
              </button>
              <button type="button" onClick={onReset} className="btn-secondary w-full py-2 text-[12px]">
                I checked my wallet: start over
              </button>
            </>
          ) : (
            <>
              <Notice tone="warn">We cannot tell whether this was sent.</Notice>
              <Notice>{outcome.message}</Notice>
              <button type="button" onClick={onReset} className="btn-secondary w-full py-2 text-[12px] mt-1">
                I checked my wallet: start over
              </button>
            </>
          )}
        </div>
      );
    case 'not-sent':
      return (
        <div className="space-y-1.5" data-testid="tx-outcome" data-status="not-sent">
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
}: {
  flow: TxFlow;
  api: Pick<WriteApi, 'explorerTxUrl' | 'meta'>;
  cluster: SolanaCluster;
  decimals: number | null;
  /** `null` when no wallet that can sign is connected. */
  signer: TxSigner | null;
  extraReview?: ReactNode;
}) {
  const s = flow.state;
  if (s.step === 'idle') return null;
  if (s.step === 'preparing') {
    return <Notice>Building the transaction and test-running it on the network…</Notice>;
  }
  if (s.step === 'review') {
    return (
      <div className="space-y-3">
        <TxReview prepared={s.prepared} decimals={decimals} display={api.meta.displaySafe} extra={extraReview} />
        {s.expired ? (
          <Notice tone="warn">
            This quote is too old to sign: the network would soon refuse it. Start over for a fresh one.
          </Notice>
        ) : signer === null ? (
          <Notice tone="warn">Connect a wallet that can sign to continue.</Notice>
        ) : (
          <p className="text-white/40 text-[10px]">
            Your wallet will show this transaction next. Sign only if it matches what is above.
          </p>
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-60"
            disabled={s.expired || signer === null}
            onClick={() => signer && flow.confirm(signer)}
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
      <Notice>
        Waiting for your wallet. Once you approve, we send it and wait for the network to confirm it. Keep this page
        open.
      </Notice>
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
    />
  );
}
