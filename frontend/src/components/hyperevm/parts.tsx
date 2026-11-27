import type { ReactNode } from 'react';
import { HYPEREVM_TOKENS, hyperEvmAddressUrl, hyperEvmTxUrl, type HyperEvmToken } from '../../lib/chains/hyperEvm';
import type { SendState } from './useHyperEvm';

/** A label and its value on one line, wrapping rather than clipping (an address is never cut). */
export function Line({ label, value, mono = false, tone }: { label: string; value: ReactNode; mono?: boolean; tone?: 'warn' }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-white/80">
      <span className="min-w-0">{label}</span>
      <span className={`min-w-0 text-right ${mono ? 'font-mono break-all text-[11px]' : '[overflow-wrap:anywhere]'} ${tone === 'warn' ? 'text-amber-300/90' : ''}`}>{value}</span>
    </div>
  );
}

/** A coin by its own ticker and its whole address, so a copy of the ticker cannot pass for it. */
export function CoinLine({ token }: { token: HyperEvmToken }) {
  return (
    <p className="text-white/80" data-testid="hyperevm-coin">
      <span className="font-semibold text-white">{token.symbol}</span>{' '}
      {token.isNative ? (
        <span>HyperEVM's own coin, paid for gas; pools hold it as WHYPE.</span>
      ) : (
        <a className="font-mono break-all underline underline-offset-2" href={hyperEvmAddressUrl(token.address)} target="_blank" rel="noopener noreferrer">{token.address}</a>
      )}
    </p>
  );
}

export function CoinSelect({ label, value, onChange, tokens = HYPEREVM_TOKENS }: { label: string; value: HyperEvmToken; onChange: (t: HyperEvmToken) => void; tokens?: readonly HyperEvmToken[] }) {
  return (
    <select
      aria-label={label}
      value={value.address}
      onChange={(e) => {
        const t = tokens.find((x) => x.address === e.target.value);
        if (t) onChange(t);
      }}
      className="min-h-[44px] rounded-full bg-black/60 px-3 text-white text-[14px] font-semibold outline-none"
      style={{ border: '1px solid rgba(255,255,255,0.18)' }}
    >
      {tokens.map((t) => (
        <option key={t.address} value={t.address}>{t.symbol}</option>
      ))}
    </select>
  );
}

/** Where a send stands, with the transaction's link once there is one. */
export function SendStatus({ state }: { state: SendState }) {
  if (state.kind === 'idle') return null;
  const text =
    state.kind === 'wallet' ? `${state.step}: confirm in your wallet.`
    : state.kind === 'mining' ? `${state.step}: sent, waiting for the chain.`
    : state.kind === 'done' ? 'Done.'
    : state.message;
  const hash = state.kind === 'mining' || state.kind === 'done' ? state.hash : state.kind === 'failed' ? state.hash : undefined;
  return (
    <p role="status" className={`text-[12px] ${state.kind === 'failed' ? 'text-amber-300/90' : 'text-white/80'}`} data-testid="hyperevm-send-status">
      {text}{' '}
      {hash && <a className="underline underline-offset-2" href={hyperEvmTxUrl(hash)} target="_blank" rel="noopener noreferrer">See it on HyperEVMScan</a>}
    </p>
  );
}
