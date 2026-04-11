import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useLimitOrders, type LimitOrder } from '../../hooks/useLimitOrders';
import { DEFAULT_TOKENS } from '../../lib/tokenList';
import { formatTokenAmount } from '../../lib/formatting';

const EXPIRY_OPTIONS = [
  { label: '1 Hour', ms: 3600000 },
  { label: '24 Hours', ms: 86400000 },
  { label: '7 Days', ms: 604800000 },
  { label: '30 Days', ms: 2592000000 },
];

export function LimitOrderTab() {
  const { isConnected } = useAccount();
  const { activeOrders, pastOrders, createOrder, cancelOrder } = useLimitOrders();

  const [amount, setAmount] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [expiryIdx, setExpiryIdx] = useState(2); // default 7 days

  const fromToken = DEFAULT_TOKENS.find(t => t.symbol === 'ETH')!;
  const toToken = DEFAULT_TOKENS.find(t => t.symbol === 'TOWELI')!;

  const handleCreate = () => {
    if (!amount || !targetPrice || parseFloat(amount) <= 0 || parseFloat(targetPrice) <= 0) return;
    createOrder({
      fromToken: { symbol: fromToken.symbol, address: fromToken.address, decimals: fromToken.decimals, ...(fromToken.isNative && { isNative: true }) },
      toToken: { symbol: toToken.symbol, address: toToken.address, decimals: toToken.decimals, ...(toToken.isNative && { isNative: true }) },
      amount,
      targetPrice,
      expiresAt: Date.now() + EXPIRY_OPTIONS[expiryIdx].ms,
    });
    setAmount('');
    setTargetPrice('');
  };

  return (
    <div className="p-5">
      <p className="text-white/30 text-[11px] mb-3">Set a price target. When the market price reaches your target, the swap executes automatically — your wallet will prompt for approval.</p>
      <p className="text-amber-400/60 text-[10px] mb-4 bg-amber-900/20 rounded px-2 py-1 border border-amber-700/30">⚠️ Browser-only feature: Orders only execute while this tab is open. This is not an on-chain limit order — closing the tab cancels all pending orders. Use for convenience, not reliability.</p>

      {/* Amount */}
      <div className="mb-3">
        <label htmlFor="limit-amount" className="text-white/40 text-[11px] mb-1.5 block">Amount (ETH)</label>
        <input id="limit-amount" type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)}
          placeholder="0.1" min="0" step="0.01"
          className="w-full bg-transparent font-mono text-[16px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input"
          style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
      </div>

      {/* Target Price */}
      <div className="mb-3">
        <label htmlFor="limit-target-price" className="text-white/40 text-[11px] mb-1.5 block">Target Price (TOWELI per ETH)</label>
        <input id="limit-target-price" type="number" inputMode="decimal" value={targetPrice} onChange={e => setTargetPrice(e.target.value)}
          placeholder="25000000" min="0"
          className="w-full bg-transparent font-mono text-[16px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input"
          style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
      </div>

      {/* Expiry */}
      <div className="mb-4">
        <span id="limit-expiry-label" className="text-white/40 text-[11px] mb-1.5 block">Expires In</span>
        <div className="flex gap-1.5" role="group" aria-labelledby="limit-expiry-label">
          {EXPIRY_OPTIONS.map((opt, i) => (
            <button key={opt.label} onClick={() => setExpiryIdx(i)}
              aria-pressed={expiryIdx === i}
              className="flex-1 py-2 min-h-[44px] rounded-lg text-[11px] font-medium cursor-pointer transition-all"
              style={{
                background: expiryIdx === i ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.03)',
                color: expiryIdx === i ? 'var(--color-primary)' : 'rgba(255,255,255,0.4)',
                border: expiryIdx === i ? '1px solid rgba(139,92,246,0.30)' : '1px solid rgba(255,255,255,0.06)',
              }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {isConnected ? (
        <button type="button" onClick={handleCreate}
          disabled={!amount || !targetPrice || parseFloat(amount) <= 0 || parseFloat(targetPrice) <= 0}
          aria-disabled={!amount || !targetPrice || parseFloat(amount) <= 0 || parseFloat(targetPrice) <= 0}
          className="btn-primary w-full py-3 min-h-[44px] text-[13px] disabled:opacity-35 disabled:cursor-not-allowed">
          Create Limit Order
        </button>
      ) : (
        <ConnectButton.Custom>
          {({ openConnectModal, mounted }) => (
            <div {...(!mounted && { style: { opacity: 0, pointerEvents: 'none' } })}>
              <button onClick={openConnectModal} className="btn-primary w-full py-3 text-[13px]">Connect Wallet</button>
            </div>
          )}
        </ConnectButton.Custom>
      )}

      {/* Active Orders */}
      {activeOrders.length > 0 && (
        <div className="mt-4 pt-3" style={{ borderTop: '1px solid rgba(139,92,246,0.08)' }}>
          <p className="text-white/30 text-[10px] uppercase tracking-wider mb-2">Active Orders</p>
          {activeOrders.map(order => (
            <OrderRow key={order.id} order={order} onCancel={() => cancelOrder(order.id)} />
          ))}
        </div>
      )}

      {pastOrders.length > 0 && (
        <div className="mt-3">
          <p className="text-white/20 text-[10px] uppercase tracking-wider mb-2">Past Orders</p>
          {pastOrders.slice(0, 3).map(order => (
            <OrderRow key={order.id} order={order} />
          ))}
        </div>
      )}
    </div>
  );
}

function OrderRow({ order, onCancel }: { order: LimitOrder; onCancel?: () => void }) {
  const timeLeft = order.expiresAt - Date.now();
  const hoursLeft = Math.max(0, Math.floor(timeLeft / 3600000));
  const daysLeft = Math.floor(hoursLeft / 24);
  const expiryStr = order.status === 'expired' ? 'Expired' :
    order.status === 'filled' ? 'Filled' :
    daysLeft > 0 ? `${daysLeft}d ${hoursLeft % 24}h` : `${hoursLeft}h`;

  return (
    <div className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-white/[0.02]"
      style={{ borderBottom: '1px solid rgba(139,92,246,0.04)' }}>
      <div>
        <span className="text-white/60 text-[12px] font-medium">{order.amount} {order.fromToken.symbol}</span>
        <span className="text-white/20 text-[11px] mx-1.5">→</span>
        <span className="text-white/40 text-[11px]">@ {formatTokenAmount(order.targetPrice, 0)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`text-[10px] ${order.status === 'active' ? 'text-success' : order.status === 'expired' ? 'text-danger' : 'text-primary'}`}>
          {expiryStr}
        </span>
        {onCancel && order.status === 'active' && (
          <button onClick={onCancel} className="text-white/20 hover:text-danger text-[10px] cursor-pointer transition-colors">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
