import { useState, useMemo } from 'react';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { usePriceAlerts } from '../hooks/usePriceAlerts';

export function PriceAlertWidget() {
  const price = useTOWELIPrice();
  const { alerts, addAlert, removeAlert, clearTriggered } = usePriceAlerts(price.priceInUsd);

  const [type, setType] = useState<'above' | 'below'>('above');
  const [priceInput, setPriceInput] = useState('');
  const [open, setOpen] = useState(false);

  const untriggeredCount = useMemo(() => alerts.filter((a) => !a.triggered).length, [alerts]);
  const triggeredCount = useMemo(() => alerts.filter((a) => a.triggered).length, [alerts]);

  const handleAdd = () => {
    const val = parseFloat(priceInput);
    if (!val || val <= 0) return;
    addAlert(type, val);
    setPriceInput('');
  };

  return (
    <div className="relative overflow-hidden rounded-xl glass-card-animated" style={{ border: '1px solid rgba(139,92,246,0.75)' }}>
      <div className="relative z-10 p-4">
        {/* Header */}
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center justify-between gap-2"
        >
          <div className="flex items-center gap-2">
            <span className="text-[16px]">{'\u{1F514}'}</span>
            <span className="text-white text-[13px] font-medium">Price Alerts</span>
            {untriggeredCount > 0 && (
              <span className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold"
                style={{ background: 'rgba(139,92,246,0.8)', color: '#fff' }}>
                {untriggeredCount}
              </span>
            )}
          </div>
          <span className="text-white/50 text-[12px]">{open ? '\u25B2' : '\u25BC'}</span>
        </button>

        {open && (
          <div className="mt-3 space-y-3">
            {/* Add form */}
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={type}
                onChange={(e) => setType(e.target.value as 'above' | 'below')}
                className="rounded-lg px-2 py-1.5 text-[12px] bg-white/5 border border-white/10 text-white outline-none"
              >
                <option value="above">Above</option>
                <option value="below">Below</option>
              </select>
              <input
                type="number"
                step="any"
                min="0"
                placeholder="Price ($)"
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                className="flex-1 min-w-[80px] rounded-lg px-2 py-1.5 text-[12px] bg-white/5 border border-white/10 text-white outline-none placeholder:text-white/30"
              />
              <button onClick={handleAdd} className="btn-primary px-3 py-1.5 text-[11px]">
                Add
              </button>
            </div>

            {/* Alert list */}
            {alerts.length === 0 ? (
              <p className="text-white/40 text-[11px] text-center py-2">No alerts set</p>
            ) : (
              <ul className="space-y-1.5 max-h-[160px] overflow-y-auto">
                {alerts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5"
                    style={{ background: a.triggered ? 'rgba(245,158,11,0.1)' : 'rgba(255,255,255,0.03)' }}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={`text-[10px] font-semibold uppercase px-1 py-0.5 rounded ${
                        a.type === 'above' ? 'bg-success/20 text-success' : 'bg-danger/20 text-danger'
                      }`}>
                        {a.type}
                      </span>
                      <span className="text-white text-[12px] font-mono truncate">
                        ${a.price.toFixed(a.price < 0.01 ? 8 : 4)}
                      </span>
                      {a.triggered && (
                        <span className="text-warning text-[9px] font-semibold">TRIGGERED</span>
                      )}
                    </div>
                    <button
                      onClick={() => removeAlert(a.id)}
                      className="text-white/30 hover:text-white text-[14px] leading-none shrink-0 transition-colors"
                      aria-label="Remove alert"
                    >
                      x
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Clear triggered */}
            {triggeredCount > 0 && (
              <button onClick={clearTriggered} className="text-warning text-[11px] hover:underline">
                Reset {triggeredCount} triggered alert{triggeredCount > 1 ? 's' : ''}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
