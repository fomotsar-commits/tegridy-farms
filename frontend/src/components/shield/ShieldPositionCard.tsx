import { useAccount, useChainId, useSendTransaction, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther } from 'viem';
import { CHAIN_ID } from '../../lib/constants';
import { BAND_LABEL, type ShieldHealthBand } from '../../lib/shield/health';
import { prepareRepay } from '../../lib/shield/preparedAction';
import { SHIELD_COPY } from '../../lib/shield/automation';
import type { ShieldPosition } from '../../lib/shield/positions';

// One position, its health, and the transaction that fixes it.
//
// The button sends a transaction that was built in `prepareRepay` and is shown in
// full before it is signed — target, function, value, and the split between the
// quote and the accrual buffer. A one-click action whose contents the user cannot
// see is not a convenience, it is a request for blind trust, and this is a money
// path.
//
// When `prepareRepay` refuses, the refusal is what renders. There is no disabled
// button with a tooltip: a greyed-out control invites the user to hunt for the
// unlock, while a sentence saying the repayment window has closed ends the hunt.

const BAND_COLOR: Record<ShieldHealthBand, string> = {
  safe: '#22c55e',
  watch: 'var(--color-towelie)',
  urgent: 'var(--color-kenny)',
  grace: 'var(--color-kenny)',
  defaulted: '#FF9C9C',
};

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function ShieldPositionCard({ position }: { position: ShieldPosition }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { sendTransaction, data: txHash, isPending, error } = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: txHash });
  // AUDIT (receipt-status, 2026-08-24): wagmi's isSuccess only means the receipt
  // was FETCHED — it latches true for on-chain REVERTED txs too. Only
  // receipt.data.status === 'success' is an actual on-chain success.
  const isReverted = receipt.isSuccess && !!receipt.data && receipt.data.status !== 'success';
  const isConfirmed = receipt.isSuccess && !isReverted;

  const prepared = prepareRepay({
    loanId: position.loanId,
    lendingContract: position.lendingContract,
    chainId,
    expectedChainId: CHAIN_ID,
    account: address ?? null,
    borrower: position.borrower,
    repaid: position.repaid,
    defaultClaimed: position.defaultClaimed,
    quotedRepayWei: position.quotedRepayWei,
    health: position.health,
  });

  // Narrowed on the discriminant directly rather than through a stored boolean.
  // `band` exists only on the read variant, and a boolean alias does not carry
  // that narrowing to a later property access — so the alias form compiled only
  // while the compiler was not actually looking at this file.
  const health = position.health;
  const color = health.status === 'unreadable' ? '#FFD37C' : BAND_COLOR[health.band];

  return (
    <li
      className="list-none rounded-xl p-4"
      style={{ background: 'rgba(0,0,0,0.6)', border: `1px solid ${color}` }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-white text-[13px] font-semibold">
          Loan #{position.loanId}
          {position.collateralContract ? (
            <span className="text-white/50 font-normal"> · {short(position.collateralContract)} #{position.tokenId.toString()}</span>
          ) : null}
        </p>
        <span className="text-[11px] uppercase tracking-wider shrink-0" style={{ color }}>
          {health.status === 'unreadable' ? 'Unknown' : BAND_LABEL[health.band]}
        </span>
      </div>

      {position.health.status === 'read' ? (
        <>
          <p className="mt-1 text-white text-[12px]">{position.health.headline}</p>
          <p className="mt-1 text-white/70 text-[12px] leading-snug">{position.health.consequence}</p>
          <p className="mt-1 text-white/45 text-[11px] leading-snug">
            {position.health.healthFactorDetail}
          </p>
        </>
      ) : (
        <p className="mt-1 text-[12px] leading-snug" style={{ color: '#FFD37C' }} role="status">
          {position.health.detail}
        </p>
      )}

      <p className="mt-2 text-white/60 text-[11px]">
        Borrowed {formatEther(position.principal)} ETH
        {position.quotedRepayWei != null ? (
          <> · owed now {formatEther(position.quotedRepayWei)} ETH</>
        ) : null}
      </p>
      {position.quoteDetail && (
        <p className="mt-1 text-[11px] leading-snug" style={{ color: '#FFD37C' }}>
          {position.quoteDetail}
        </p>
      )}

      {prepared.ok ? (
        <div className="mt-3 rounded-lg p-3" style={{ background: '#0a0a0a', border: '1px solid var(--color-purple-75)' }}>
          <p className="text-white/70 text-[11px]">Prepared transaction</p>
          <dl className="mt-1.5 space-y-0.5 text-[11px]">
            <div className="flex justify-between gap-2">
              <dt className="text-white/45">Call</dt>
              <dd className="text-white/80 text-right break-all">repayLoan({prepared.action.loanId})</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-white/45">To</dt>
              <dd className="text-white/80 text-right break-all">{prepared.action.to}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-white/45">Owed</dt>
              <dd className="text-white/80 text-right">{formatEther(prepared.action.quotedRepayWei)} ETH</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-white/45">Accrual buffer</dt>
              <dd className="text-white/80 text-right">{formatEther(prepared.action.bufferWei)} ETH</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-white/45">Sends</dt>
              <dd className="text-white text-right font-semibold">{formatEther(prepared.action.value)} ETH</dd>
            </div>
          </dl>
          <p className="mt-2 text-white/55 text-[11px] leading-snug">{prepared.action.disclosure}</p>
          <button
            type="button"
            disabled={isPending || receipt.isLoading}
            onClick={() =>
              sendTransaction({
                to: prepared.action.to,
                data: prepared.action.data,
                value: prepared.action.value,
              })
            }
            className="mt-3 w-full px-3 py-2 rounded-lg text-[12px] text-white font-semibold disabled:opacity-40"
            style={{ background: 'var(--color-purple-80)' }}
          >
            {isPending || receipt.isLoading ? 'Waiting for your wallet…' : SHIELD_COPY.signButton}
          </button>
          {error && (
            <p className="mt-2 text-[11px] leading-snug" style={{ color: '#FF9C9C' }} role="alert">
              The wallet rejected or failed to send this transaction. Nothing was repaid.
            </p>
          )}
          {isReverted && (
            <p className="mt-2 text-[11px] leading-snug" style={{ color: '#FF9C9C' }} role="alert">
              The transaction reverted on-chain. Nothing was repaid and the loan is unchanged.
            </p>
          )}
          {isConfirmed && (
            <p className="mt-2 text-[11px] leading-snug" style={{ color: '#22c55e' }} role="status">
              Repayment confirmed on-chain. The collateral returns to this wallet in the same transaction.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-[11px] leading-snug" style={{ color: '#FFD37C' }} role="status">
          {prepared.reason}
        </p>
      )}
    </li>
  );
}

export default ShieldPositionCard;
