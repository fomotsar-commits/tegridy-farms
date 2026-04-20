import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { toast } from 'sonner';
import { useLimitOrders, type LimitOrder } from '../../hooks/useLimitOrders';
import { DEFAULT_TOKENS } from '../../lib/tokenList';
import { formatTokenAmount } from '../../lib/formatting';

const EXPIRY_OPTIONS = [
  { label: '1 Hour', ms: 3600000 },
  { label: '24 Hours', ms: 86400000 },
  { label: '7 Days', ms: 604800000 },
  { label: '30 Days', ms: 2592000000 },
];

const MAX_AMOUNT_ETH = 100;

/** Block minus/negative sign in number inputs */
const blockNegativeKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === '-' || e.key === 'e') e.preventDefault();
};

export function LimitOrderTab() {
  const { isConnected } = useAccount();
  const { activeOrders, pastOrders, createOrder, cancelOrder } = useLimitOrders();

  const [amount, setAmount] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [expiryIdx, setExpiryIdx] = useState(2); // default 7 days
  const [showAllPast, setShowAllPast] = useState(false);

  const fromToken = DEFAULT_TOKENS.find(t => t.symbol === 'ETH')!;
  const toToken = DEFAULT_TOKENS.find(t => t.symbol === 'TOWELI')!;

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const num = parseFloat(val);
    if (val !== '' && num < 0) return;
    setAmount(val);
  };

  const handlePriceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const num = parseFloat(val);
    if (val !== '' && num < 0) return;
    setTargetPrice(val);
  };

  const handleCreate = () => {
    if (!amount || !targetPrice || parseFloat(amount) <= 0 || parseFloat(targetPrice) <= 0) return;
    createOrder({
      fromToken: { symbol: fromToken.symbol, address: fromToken.address, decimals: fromToken.decimals, ...(fromToken.isNative && { isNative: true }) },
      toToken: { symbol: toToken.symbol, address: toToken.address, decimals: toToken.decimals, ...(toToken.isNative && { isNative: true }) },
      amount,
      targetPrice,
      expiresAt: Date.now() + EXPIRY_OPTIONS[expiryIdx]!.ms,
    });
    setAmount('');
    setTargetPrice('');
    toast.success('Limit order created');
  };

  const visiblePastOrders = showAllPast ? pastOrders : pastOrders.slice(0, 3);

  return (
    <div className="p-5">
      <p className="text-white text-[11px] mb-3" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Set a price target. When the market price reaches your target, your wallet prompts you to sign the swap &mdash; keep this tab open to see it fire. (Not an on-chain limit order.)</p>
      <p className="text-amber-300 text-[10px] mb-4 rounded px-2 py-1.5 border border-amber-500/50" style={{ background: 'rgba(0,0,0,0.70)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>&#9888; Browser-only feature: Orders only execute while this tab is open. This is not an on-chain limit order &mdash; closing the tab cancels all pending orders. Use for convenience, not reliability.</p>

      {/* Amount */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="limit-amount" className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Amount (ETH)</label>
          <span className="text-white/90 text-[10px] font-mono" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Max: {MAX_AMOUNT_ETH} ETH</span>
        </div>
        <input id="limit-amount" type="number" inputMode="decimal" value={amount} onChange={handleAmountChange}
          onKeyDown={blockNegativeKey}
          placeholder="0.1" min="0" max={MAX_AMOUNT_ETH} step="0.01"
          className="w-full font-mono text-[16px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input"
          style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }} />
      </div>

      {/* Target Price */}
      <div className="mb-3">
        <label htmlFor="limit-target-price" className="text-white text-[11px] mb-1.5 block" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Target Price (TOWELI per ETH)</label>
        <input id="limit-target-price" type="number" inputMode="decimal" value={targetPrice} onChange={handlePriceChange}
          onKeyDown={blockNegativeKey}
          placeholder="25000000" min="0"
          className="w-full font-mono text-[16px] text-white outline-none px-3 py-2.5 min-h-[44px] rounded-lg token-input"
          style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }} />
      </div>

      {/* Expiry */}
      <div className="mb-4">
        <span id="limit-expiry-label" className="text-white text-[11px] mb-1.5 block" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Expires In</span>
        <div className="flex gap-1.5" role="group" aria-labelledby="limit-expiry-label">
          {EXPIRY_OPTIONS.map((opt, i) => (
            <button key={opt.label} onClick={() => setExpiryIdx(i)}
              aria-pressed={expiryIdx === i}
              className="flex-1 py-2 min-h-[44px] rounded-lg text-[11px] font-medium cursor-pointer transition-all text-white"
              style={{
                background: expiryIdx === i ? 'var(--color-stan)' : 'rgba(0,0,0,0.55)',
                border: expiryIdx === i ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.18)',
                boxShadow: expiryIdx === i ? '0 4px 12px var(--color-stan-40)' : undefined,
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
          className="btn-primary w-full py-3 min-h-[44px] text-[13px] disabled:opacity-70 disabled:cursor-not-allowed">
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
        <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--color-purple-75)' }}>
          <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-2">Active Orders</p>
          {activeOrders.map(order => (
            <OrderRow key={order.id} order={order} onCancel={() => cancelOrder(order.id)} />
          ))}
        </div>
      )}

      {pastOrders.length > 0 && (
        <div className="mt-3">
          <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-2">Past Orders</p>
          {visiblePastOrders.map(order => (
            <OrderRow key={order.id} order={order} />
          ))}
          {pastOrders.length > 3 && (
            <button
              onClick={() => setShowAllPast(prev => !prev)}
              className="text-purple-400 hover:text-purple-300 text-[11px] mt-2 cursor-pointer transition-colors w-full text-center min-h-[44px] flex items-center justify-center">
              {showAllPast ? 'Show less' : `Show all (${pastOrders.length})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function OrderRow({ order, onCancel }: { order: LimitOrder; onCancel?: () => void }) {
  const [, setTick] = useState(0);

  // Update remaining time every minute so it doesn't go stale
  useEffect(() => {
    if (order.status !== 'active' && order.status !== 'executing') return;
    const timer = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(timer);
  }, [order.status]);

  const timeLeft = order.expiresAt - Date.now();
  const hoursLeft = Math.max(0, Math.floor(timeLeft / 3600000));
  const daysLeft = Math.floor(hoursLeft / 24);
  const expiryStr = order.status === 'expired' ? 'Expired' :
    order.status === 'filled' ? 'Filled' :
    daysLeft > 0 ? `${daysLeft}d ${hoursLeft % 24}h` : `${hoursLeft}h`;

  const statusLabel = order.status === 'expired' ? 'Order expired' :
    order.status === 'filled' ? 'Order filled' :
    order.status === 'executing' ? 'Order executing' :
    `Order active, ${expiryStr} remaining`;

  return (
    <div className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-black/60"
      style={{ borderBottom: '1px solid var(--color-purple-75)' }}>
      <div>
        <span className="text-white text-[12px] font-medium">{order.amount} {order.fromToken.symbol}</span>
        <span className="text-white text-[11px] mx-1.5">→</span>
        <span className="text-white text-[11px]">@ {formatTokenAmount(order.targetPrice, 0)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span
          aria-label={statusLabel}
          className={`text-[10px] ${order.status === 'active' ? 'text-success' : order.status === 'expired' ? 'text-danger' : 'text-white'}`}>
          {expiryStr}
        </span>
        {onCancel && order.status === 'active' && (
          <button onClick={onCancel}
            className="text-white hover:text-danger text-[10px] min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer transition-colors">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
