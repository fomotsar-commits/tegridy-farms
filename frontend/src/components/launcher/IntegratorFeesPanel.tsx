// Operator surface for the launcher's own revenue: read and withdraw the integrator
// fees Doppler credits us inside the Airlock.
//
// Until this panel existed the money had no UI at all. `collectIntegratorFees` was live
// on-chain with no caller in the repo; `integratorFees.ts` was written to fix that and
// was itself never imported by anything. Fees accrued and there was no way to see them,
// let alone move them.
//
// WHO CAN COLLECT. `Airlock.collectIntegratorFees` debits `msg.sender`'s own row, so the
// ONLY wallet that can withdraw is LAUNCHER_INTEGRATOR_ADDRESS. That is deliberately not
// the same wallet as the protocol owner, so the panel separates the two concerns:
// balances are public state and render for any authorized operator, while the button is
// live only for the integrator itself. Showing a real balance next to a disabled button
// that explains why beats hiding revenue behind a wallet switch.
//
// `to` is fixed to the connected account rather than a free-text address field. The
// destination of a withdrawal is exactly the kind of input that should not be typeable.

import { useEffect, useRef, useState } from 'react';
import { usePublicClient, useWalletClient, useAccount } from 'wagmi';
import { toast } from 'sonner';
import type { Address } from 'viem';
import { useIntegratorFees, type DecoratedFee } from '../../hooks/useIntegratorFees';
import { collectIntegratorFees } from '../../lib/launcher/integratorFees';
import { LAUNCHER_INTEGRATOR_ADDRESS } from '../../lib/launcher/config';
import { CHAIN_ID } from '../../lib/constants';
import { formatWei, shortenAddress } from '../../lib/formatting';

function FeeRow({
  fee,
  canCollect,
  busyCurrency,
  onCollect,
}: {
  fee: DecoratedFee;
  canCollect: boolean;
  busyCurrency: Address | null;
  onCollect: (fee: DecoratedFee) => void;
}) {
  const busy = busyCurrency?.toLowerCase() === fee.currency.toLowerCase();
  const otherBusy = busyCurrency !== null && !busy;

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap py-3 border-b border-white/10 last:border-b-0">
      <div className="min-w-0">
        <div className="stat-value text-white font-mono text-[15px] break-all">
          {formatWei(fee.amount, fee.decimals)} <span className="text-white/70">{fee.symbol}</span>
        </div>
        <div className="text-[11px] text-white/50 font-mono break-all">
          {fee.currency === '0x0000000000000000000000000000000000000000'
            ? 'native ETH'
            : shortenAddress(fee.currency)}
        </div>
      </div>
      <button
        onClick={() => onCollect(fee)}
        disabled={!canCollect || busy || otherBusy}
        className="btn-primary px-4 py-2 text-[13px] disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        aria-label={`Withdraw ${fee.symbol} integrator fees`}
      >
        {busy ? 'Confirming…' : 'Withdraw'}
      </button>
    </div>
  );
}

export function IntegratorFeesPanel() {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { data: walletClient } = useWalletClient();
  const { fees, isLoading, error, assetsUnavailable, checkedCount, unreadable, refetch } =
    useIntegratorFees(true);

  const isIntegrator =
    !!address && address.toLowerCase() === LAUNCHER_INTEGRATOR_ADDRESS.toLowerCase();

  const [busyCurrency, setBusyCurrency] = useState<Address | null>(null);

  // Abandon any pending state on unmount so a late settle can't setState on a dead tree.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleCollect = async (fee: DecoratedFee) => {
    if (!publicClient || !walletClient || !address) {
      toast.error('Wallet not ready.');
      return;
    }
    setBusyCurrency(fee.currency);
    try {
      // `collectIntegratorFees` simulates before signing, so a revert (over-draw, wrong
      // sender) surfaces as a rejected promise BEFORE the wallet prompt rather than as a
      // failed transaction the operator paid for.
      const hash = await collectIntegratorFees(publicClient, walletClient, {
        to: address,
        currency: fee.currency,
        amount: fee.amount,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      if (!mounted.current) return;
      toast.success(`Withdrew ${formatWei(fee.amount, fee.decimals)} ${fee.symbol}`);
      refetch();
    } catch (e) {
      if (!mounted.current) return;
      const msg =
        (e as { shortMessage?: string })?.shortMessage ||
        (e as { message?: string })?.message ||
        'Withdrawal failed.';
      toast.error(msg.split('\n')[0]);
    } finally {
      if (mounted.current) setBusyCurrency(null);
    }
  };

  return (
    <div className="glass-card p-6 rounded-2xl">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <h2
          className="heading-luxury text-white text-[20px] tracking-tight"
          style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
        >
          Launcher Integrator Fees
        </h2>
        <button
          onClick={refetch}
          disabled={isLoading}
          className="px-2 py-1 rounded-md bg-white/5 text-white/70 border border-white/10 hover:text-white hover:bg-white/10 transition-colors text-[11px] font-mono disabled:opacity-40"
          title="Re-read claimable balances from the Airlock"
        >
          {isLoading ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      <p className="text-white/85 text-sm mb-4" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
        Fees Doppler credits our integrator inside the Airlock. They are not streamed
        anywhere and do not arrive on their own — they sit until withdrawn.
      </p>

      {/* Which wallet is authorized. The contract debits msg.sender, so this is a fact
          about the connected account, not a policy this UI invents. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] font-mono">
        <span
          className={`px-2 py-1 rounded-md border ${
            isIntegrator
              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
              : 'bg-white/5 text-white/70 border-white/10'
          }`}
        >
          {isIntegrator ? 'INTEGRATOR' : 'READ-ONLY'}
        </span>
        <span className="px-2 py-1 rounded-md bg-white/5 text-white/80 border border-white/10 break-all">
          {shortenAddress(LAUNCHER_INTEGRATOR_ADDRESS)}
        </span>
      </div>

      {!isIntegrator && (
        <div className="mb-4 rounded-xl border border-white/10 bg-white/5 p-3">
          <p className="text-xs text-white/75">
            Balances below are real and current. Withdrawing requires the integrator
            wallet {shortenAddress(LAUNCHER_INTEGRATOR_ADDRESS)}, because the Airlock
            debits the caller&apos;s own fee row.
          </p>
        </div>
      )}

      {error ? (
        // An unreadable balance must never render as zero — the distinction this whole
        // module exists to preserve.
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4">
          <p className="text-sm text-red-300">Could not read integrator fees. {error}</p>
          <p className="text-xs text-red-200/70 mt-1">
            This is a failed read, not a zero balance.
          </p>
        </div>
      ) : isLoading && fees.length === 0 ? (
        <p className="text-sm text-white/70">Reading claimable balances…</p>
      ) : fees.length === 0 && unreadable.length > 0 ? (
        // Nothing came back, but not because the balances are zero — we could not read
        // them. Saying "nothing to claim" here would be a confident false negative over
        // real money, which is the failure this whole module exists to prevent.
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="text-sm text-amber-200">
            Could not read {unreadable.length === checkedCount ? 'any' : `${unreadable.length} of ${checkedCount}`}{' '}
            {unreadable.length === 1 ? 'balance' : 'balances'}.
          </p>
          <p className="text-xs text-amber-200/70 mt-1">
            This is not a zero balance — it is an unknown one. Retry before concluding
            there is nothing to withdraw.
          </p>
        </div>
      ) : fees.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <p className="text-sm text-white/85">Nothing to claim.</p>
          <p className="text-xs text-white/60 mt-1">
            Checked {checkedCount} {checkedCount === 1 ? 'currency' : 'currencies'} and every
            one read back zero.
            {assetsUnavailable && ' Launch-asset discovery was unavailable, so only base pairs were checked.'}
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-white/10 bg-white/5 px-4">
            {fees.map((fee) => (
              <FeeRow
                key={fee.currency}
                fee={fee}
                canCollect={isIntegrator}
                busyCurrency={busyCurrency}
                onCollect={handleCollect}
              />
            ))}
          </div>
          {/* Partial read: some balances resolved, others did not. The list below is
              real but INCOMPLETE, and saying so is the difference between a total and
              a guess. */}
          {unreadable.length > 0 && (
            <p className="text-xs text-amber-300/80 mt-3">
              {unreadable.length} of {checkedCount} balances could not be read — this list
              is incomplete, not a total.
            </p>
          )}
          {assetsUnavailable && (
            <p className="text-xs text-amber-300/80 mt-3">
              Launch-asset discovery was unavailable — only base pairs were checked, so
              asset-denominated fees may be missing from this list.
            </p>
          )}
        </>
      )}
    </div>
  );
}
