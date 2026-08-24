// Create-a-launch surface for the OWN curve. Deploys a fixed-supply token and
// opens its bonding curve in one tx; any attached ETH is the creator's atomic
// opening buy (nobody can trade before the creator's own first position,
// because the token does not exist until this call). Metadata bounds mirror the
// contract's BadTokenMetadata (name 1-64, symbol 1-16).

import { useState } from 'react';
import { m } from 'framer-motion';
import { useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import type { Address } from 'viem';
import { sanitizeDecimalInput } from '../../lib/formatting';
import { safeParseEther } from '../../lib/safeParseEther';
import { CURVE_LAUNCHER_ABI } from '../../lib/launcher/curve';

const cardStyle = { border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' } as const;
const inputCls = 'w-full px-3 py-2 rounded-lg bg-black/55 text-white text-[13px] outline-none';
const inputStyle = { border: '1px solid rgba(255,255,255,0.18)' } as const;

export interface CurveCreateViewProps {
  nativeSymbol?: string;
  pending: boolean;
  onCreate: (name: string, symbol: string, openingBuyWei: bigint) => void;
}

export function CurveCreateView({ nativeSymbol = 'ETH', pending, onCreate }: CurveCreateViewProps) {
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [opening, setOpening] = useState('');

  const nameOk = name.trim().length >= 1 && name.length <= 64;
  const symbolOk = symbol.trim().length >= 1 && symbol.length <= 16;
  // Opening buy is optional; empty is 0. A non-empty, un-parseable value blocks.
  const openingWei = opening.trim() === '' ? 0n : safeParseEther(opening);
  const openingOk = openingWei !== null;
  const disabled = pending || !nameOk || !symbolOk || !openingOk;

  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="rounded-2xl p-5 space-y-3"
      style={cardStyle}
    >
      <div>
        <label className="block text-[11px] text-white/55 mb-1">Token name</label>
        <input className={inputCls} style={inputStyle} maxLength={64} aria-label="Token name" placeholder="Towelie Jr" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="block text-[11px] text-white/55 mb-1">Symbol</label>
        <input
          className={`${inputCls} uppercase`}
          style={inputStyle}
          maxLength={16}
          aria-label="Token symbol"
          placeholder="TWLJR"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        />
      </div>
      <div>
        <label className="block text-[11px] text-white/55 mb-1">
          Opening buy ({nativeSymbol}) <span className="text-white/35">— optional, your first position</span>
        </label>
        <input className={inputCls} style={inputStyle} inputMode="decimal" aria-label={`Opening buy in ${nativeSymbol}`} placeholder="0.0" value={opening} onChange={(e) => setOpening(sanitizeDecimalInput(e.target.value))} />
      </div>
      <p className="text-white/45 text-[11px] leading-relaxed">
        Fixed supply, no team unlock beyond your opening buy. Graduation seeds the Tegridy pool
        with the LP burned; a 3.69% reserve funds this pool's survival incentives.
      </p>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onCreate(name.trim(), symbol.trim(), openingWei ?? 0n)}
        className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-50"
      >
        {pending ? 'Confirm in wallet…' : 'Create launch'}
      </button>
    </m.div>
  );
}

export interface CurveCreatePanelProps {
  launcher: Address;
}

export function CurveCreatePanel({ launcher }: CurveCreatePanelProps) {
  const { writeContract, isPending } = useWriteContract();
  const onCreate = (name: string, symbol: string, openingBuyWei: bigint) => {
    writeContract(
      { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'create', args: [name, symbol], value: openingBuyWei },
      {
        onSuccess: () => toast.success('Launch created — your curve is live.'),
        onError: (e) => toast.error(e instanceof Error ? e.message : 'The wallet rejected the launch.'),
      },
    );
  };
  return <CurveCreateView pending={isPending} onCreate={onCreate} />;
}
