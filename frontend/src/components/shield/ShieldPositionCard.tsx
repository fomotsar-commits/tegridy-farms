import { useEffect, useState } from 'react';
import { useAccount, useChainId, useReadContract, useSendTransaction, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther } from 'viem';
import { CHAIN_ID } from '../../lib/constants';
import { ERC20_ABI } from '../../lib/contracts';
import { WETH_ADDRESS } from '../../lib/gondi/loanOffer.js';
import type { RepayStep } from '../../lib/gondi/repay';
import { getTxUrl } from '../../lib/explorer';
import { noteReplacement, receiptOutcome } from '../../lib/txErrors';
import { BAND_LABEL, type ShieldHealthBand } from '../../lib/shield/health';
import { prepareRepay } from '../../lib/shield/preparedAction';
import { SHIELD_COPY } from '../../lib/shield/automation';
import type { ShieldPosition } from '../../lib/shield/positions';
import { CardArt } from '../ui/CardArt';

// One position, its health, and the transaction that fixes it.
//
// The button sends a transaction that was built in `prepareRepay` and is shown in
// full before it is signed: target, call, the ETH it sends and the WETH it needs.
// Gondi repays in WETH, so this is up to three steps (wrap, approve, repay), the same
// three My Loans walks; after each confirms, the WETH reads refresh and the next is built.
// A one-click action whose contents the user cannot see is not a convenience, it is a
// request for blind trust, and this is a money path.
//
// When `prepareRepay` refuses, the refusal is what renders. There is no disabled
// button with a tooltip: a greyed-out control invites the user to hunt for the
// unlock, while a sentence saying the repayment window has closed ends the hunt.

const BAND_COLOR: Record<ShieldHealthBand, string> = {
  safe: '#22c55e',
  watch: 'var(--color-towelie)',
  urgent: 'var(--color-kenny)',
  defaulted: '#FF9C9C',
};

const STEP_CONFIRMED: Record<RepayStep, string> = {
  wrap: 'Wrapped. Your wallet now holds the WETH; the next step is the approval.',
  approve: 'Approved. The last step is the repayment itself.',
  repay: 'Repayment confirmed on-chain. The collateral returns to this wallet in the same transaction.',
};

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function ShieldPositionCard({ position }: { position: ShieldPosition }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { sendTransaction, data: txHash, isPending, error, reset } = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: txHash, onReplaced: noteReplacement });
  // AUDIT (receipt-status, 2026-08-24): wagmi's isSuccess only means the receipt
  // was FETCHED. Only receipt.data.status === 'success' is an on-chain success.
  //
  // 2026-09-17: and a revert never reached isSuccess — wagmi THROWS on a reverted
  // receipt, so the "reverted" line below never rendered and a reverted repay
  // showed nothing at all. receiptOutcome splits `isError` into revert vs "could
  // not read it", and each gets its own line.
  //
  // And a receipt is only proof of its OWN transaction: a repay the wallet
  // cancelled resolves with the cancel's success receipt, which printed
  // "Repayment confirmed" over a loan still open (lib/txErrors.ts).
  const { isSuccess: isConfirmed, isReverted, isReceiptUnreadable, isReplaced, replacement } =
    receiptOutcome(receipt, txHash);

  const health = position.health;
  const borrowerWallet = !!address && address.toLowerCase() === position.borrower.toLowerCase();
  const wethReads = { enabled: borrowerWallet && health.repayable };
  const weth = useReadContract({
    address: WETH_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: wethReads,
  });
  const allowance = useReadContract({
    address: WETH_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, position.lendingContract] : undefined,
    chainId: CHAIN_ID,
    query: wethReads,
  });

  const prepared = prepareRepay({
    loanId: position.loanId,
    loan: position.loan,
    lendingContract: position.lendingContract,
    chainId,
    expectedChainId: CHAIN_ID,
    account: address ?? null,
    health,
    nowUnix: Math.floor(Date.now() / 1000),
    wethBalance: typeof weth.data === 'bigint' ? weth.data : null,
    wethAllowance: typeof allowance.data === 'bigint' ? allowance.data : null,
  });

  // Which step was sent, so its confirmation names the right thing after the next is built.
  const [sentKind, setSentKind] = useState<RepayStep | null>(null);
  // A wrap or approval that confirmed changes which step comes next: read again.
  useEffect(() => {
    if (!isConfirmed || sentKind === 'repay') return;
    void weth.refetch();
    void allowance.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per confirmed step
  }, [isConfirmed]);

  const color = BAND_COLOR[health.band];

  return (
    <li
      className="relative isolate list-none rounded-xl p-4"
      style={{ background: 'rgba(0,0,0,0.6)', border: `1px solid ${color}` }}
    >
      <CardArt pageId="shield" idx={0} />
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-white text-[13px] font-semibold">
          Loan #{position.loanId}
          <span className="text-white/50 font-normal"> · {short(position.collateralContract)} #{position.tokenId.toString()}</span>
        </p>
        <span className="text-[11px] uppercase tracking-wider shrink-0" style={{ color }}>
          {BAND_LABEL[health.band]}
        </span>
      </div>

      <p className="mt-1 text-white text-[12px]">{health.headline}</p>
      <p className="mt-1 text-white/70 text-[12px] leading-snug">{health.consequence}</p>
      <p className="mt-1 text-white/45 text-[11px] leading-snug">{health.healthFactorDetail}</p>

      <p className="mt-2 text-white/60 text-[11px]">
        Borrowed {formatEther(position.principal)} WETH · owed now {formatEther(position.owedNowWei)} WETH
      </p>

      {prepared.ok ? (
        <div className="mt-3 rounded-lg p-3" style={{ background: '#0a0a0a', border: '1px solid var(--color-purple-75)' }}>
          <p className="text-white/70 text-[11px]">Prepared transaction</p>
          <dl className="mt-1.5 space-y-0.5 text-[11px]">
            <div className="flex justify-between gap-2">
              <dt className="text-white/45">Call</dt>
              <dd className="text-white/80 text-right break-all">{prepared.action.summary}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-white/45">To</dt>
              <dd className="text-white/80 text-right break-all">{prepared.action.to}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-white/45">WETH needed (owed in 10 min)</dt>
              <dd className="text-white/80 text-right">{formatEther(prepared.action.neededWei)} WETH</dd>
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
            onClick={() => {
              reset();
              setSentKind(prepared.action.kind);
              sendTransaction({
                to: prepared.action.to,
                data: prepared.action.data,
                value: prepared.action.value,
                // Mainnet-only loan: pin it, so a wallet parked on Base/Robinhood
                // (both configured chains now) prompts a switch instead of sending
                // to an address with no code there.
                chainId: CHAIN_ID,
              });
            }}
            className="mt-3 w-full px-3 py-2 rounded-lg text-[12px] text-white font-semibold disabled:opacity-40"
            style={{ background: 'var(--color-purple-80)' }}
          >
            {isPending || receipt.isLoading ? 'Waiting for your wallet…' : SHIELD_COPY.signButton[prepared.action.kind]}
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
          {isReceiptUnreadable && txHash && (
            <p className="mt-2 text-[11px] leading-snug" style={{ color: '#FFD37C' }} role="status">
              The transaction was sent, but its result could not be read, so we can&apos;t tell whether it went
              through.{' '}
              <a href={getTxUrl(CHAIN_ID, txHash)} target="_blank" rel="noopener noreferrer" className="underline">
                Check it on the explorer
              </a>{' '}
              before you send it again: if a repayment landed, a second one reverts and only costs gas.
            </p>
          )}
          {isReplaced && replacement && (
            <p className="mt-2 text-[11px] leading-snug" style={{ color: '#FFD37C' }} role="status">
              {replacement.reason === 'cancelled'
                ? 'The transaction was cancelled in your wallet, so it did not happen. The loan is unchanged.'
                : replacement.reason === 'replaced'
                  ? 'Your wallet replaced the transaction with a different one, so it did not happen as sent.'
                  : 'Another transaction from your wallet confirmed in its place. If you sped it up, it went through; if you cancelled or changed it, it did not.'}{' '}
              <a href={getTxUrl(CHAIN_ID, replacement.hash)} target="_blank" rel="noopener noreferrer" className="underline">
                Check what confirmed
              </a>{' '}
              before you send it again.
            </p>
          )}
          {isConfirmed && sentKind && (
            <p className="mt-2 text-[11px] leading-snug" style={{ color: '#22c55e' }} role="status">
              {STEP_CONFIRMED[sentKind]}
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
