// Launch Simulator — the interactive design tool.
//
// A dev enters a PROPOSED allocation (who holds what) and structural config
// (template / powers / LP lock / team float), and sees, live as they edit:
//   - the distribution BAND + full detection report (DistributionReport), and
//   - the projected Fact-Sheet TIER buyers will see (reused launcher gate), and
//   - exactly what it takes to reach each better band (BandDeltaPanel).
// Nothing is fetched and nothing is on-chain — it is pure what-if over the dev's
// own numbers, so it self-gates to an instructional empty state until they type.
//
// HONEST FRAMING: "Load example" seeds EDITABLE template rows the dev is meant to
// replace with their real plan; they are never presented as measured on-chain
// data. With no non-zero rows, no band and no score are shown at all.

import { useMemo, useState, useEffect } from 'react';
import {
  simulate,
  CATEGORY_CHOICES,
  DEFAULT_STRUCTURAL,
  type AllocRow,
  type CategoryChoice,
  type StructuralInput,
} from '../../lib/launchSim/simulate';
import type { LaunchFactSheet, LaunchTier } from '../../lib/launcher/factSheet';
import { DistributionReport } from './DistributionReport';
import { BandDeltaPanel } from './BandDeltaPanel';

const inputCls =
  'w-full px-2.5 py-1.5 rounded-lg bg-black/30 border border-white/12 text-white text-sm outline-none focus:border-emerald-500/60 transition';

let ROW_SEQ = 0;
function newRow(partial: Partial<AllocRow> = {}): AllocRow {
  ROW_SEQ += 1;
  return { id: `r${ROW_SEQ}-${Math.random().toString(36).slice(2, 7)}`, label: '', amount: '', category: 'auto', ...partial };
}

// ── EXAMPLE scenarios — editable seeds, NOT real data. Each is a starting point
//    the dev replaces with their own plan. Kept illustrative + obviously round. ──
const EXAMPLES: { id: string; label: string; note: string; build: () => AllocRow[] }[] = [
  {
    id: 'fair',
    label: 'Fair launch',
    note: 'LP + a broad public float',
    build: () => [
      newRow({ label: 'Liquidity pool', amount: '200000000', category: 'lp' }),
      ...Array.from({ length: 40 }, (_, i) => newRow({ label: `Public buyer ${i + 1}`, amount: String(20000000 - i * 200000), category: 'auto' })),
    ],
  },
  {
    id: 'team',
    label: 'Team + LP',
    note: 'a vested team block alongside the float',
    build: () => [
      newRow({ label: 'Liquidity pool', amount: '150000000', category: 'lp' }),
      newRow({ label: 'Team (vesting)', amount: '200000000', category: 'locker' }),
      ...Array.from({ length: 25 }, (_, i) => newRow({ label: `Public buyer ${i + 1}`, amount: String(26000000 - i * 400000), category: 'auto' })),
    ],
  },
  {
    id: 'whale',
    label: 'Whale-heavy',
    note: 'a dominant wallet — see it flip the band',
    build: () => [
      newRow({ label: 'Liquidity pool', amount: '100000000', category: 'lp' }),
      newRow({ label: 'Whale 1', amount: '450000000', category: 'auto' }),
      newRow({ label: 'Whale 2', amount: '200000000', category: 'auto' }),
      ...Array.from({ length: 10 }, (_, i) => newRow({ label: `Holder ${i + 1}`, amount: '25000000', category: 'auto' })),
    ],
  },
];

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer select-none py-1">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 h-5 w-9 rounded-full transition shrink-0 relative ${checked ? 'bg-emerald-500/80' : 'bg-white/15'}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
      <span>
        <span className="text-white/80 text-sm leading-tight block">{label}</span>
        {hint && <span className="text-white/40 text-[11px] block leading-tight">{hint}</span>}
      </span>
    </label>
  );
}

// A percent input whose SOURCE OF TRUTH is bps, but that keeps its own raw text
// while the user types. The old inline inputs derived `value` straight from
// `(bps/100).toFixed(1)`, so every keystroke round-tripped through bps and got
// reformatted — typing "12" reformatted "1"→"1.0" mid-entry, dropping the "2"
// after the decimal and storing 1.0%. Mirrors LaunchPage's AttentionSplitRow.
function PctField({ bps, onBps, className }: { bps: number; onBps: (bps: number) => void; className?: string }) {
  const [text, setText] = useState(String(bps / 100));
  // Re-sync from bps ONLY when it changes to a value the current text doesn't
  // already represent (an external edit) — never on the user's own keystrokes.
  useEffect(() => {
    if (Math.round((Number(text) || 0) * 100) !== bps) setText(String(bps / 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bps]);
  return (
    <input
      className={className}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const clean = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
        setText(clean);
        onBps(Math.round((Number(clean) || 0) * 100));
      }}
    />
  );
}

function AllocationRow({
  row,
  bundlesModeled,
  snipersModeled,
  onChange,
  onRemove,
}: {
  row: AllocRow;
  bundlesModeled: boolean;
  snipersModeled: boolean;
  onChange: (patch: Partial<AllocRow>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        {/* min-w-0 lets these inputs shrink below their intrinsic content width so
            the row fits at 390px — without it flex-1 never shrinks and the remove
            button clips off-screen (w-32 alone is a no-op for the same reason). */}
        <input
          className={`${inputCls} flex-1 min-w-0`}
          placeholder="Label (e.g. Team)"
          value={row.label}
          onChange={(e) => onChange({ label: e.target.value })}
          maxLength={40}
        />
        <input
          className={`${inputCls} w-24 sm:w-32 min-w-0 tabular-nums`}
          inputMode="numeric"
          placeholder="tokens"
          value={row.amount}
          onChange={(e) => onChange({ amount: e.target.value.replace(/[^\d,]/g, '') })}
        />
        <button onClick={onRemove} className="text-white/40 hover:text-rose-300 text-sm px-1.5 shrink-0" aria-label="remove row">
          ✕
        </button>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <select
          className={`${inputCls} w-auto flex-1 min-w-[150px]`}
          value={row.category}
          onChange={(e) => onChange({ category: e.target.value as CategoryChoice })}
        >
          {CATEGORY_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
              {c.excluded ? ' — excluded' : ''}
            </option>
          ))}
        </select>
        <input
          className={`${inputCls} w-28`}
          placeholder="cluster tag"
          value={row.clusterId ?? ''}
          onChange={(e) => onChange({ clusterId: e.target.value })}
          title="Rows sharing a cluster tag are treated as one coordinated cluster."
        />
        {bundlesModeled && (
          <label className="flex items-center gap-1 text-[11px] text-white/60">
            <input type="checkbox" checked={!!row.bundled} onChange={(e) => onChange({ bundled: e.target.checked })} className="accent-amber-500" />
            bundled
          </label>
        )}
        {snipersModeled && (
          <label className="flex items-center gap-1 text-[11px] text-white/60">
            <input type="checkbox" checked={!!row.sniper} onChange={(e) => onChange({ sniper: e.target.checked })} className="accent-amber-500" />
            sniper
          </label>
        )}
      </div>
    </div>
  );
}

const TIER_STYLE: Record<LaunchTier, string> = {
  flagship: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  listable: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
  none: 'bg-white/10 text-white/60 border-white/20',
};

/** Compact projected Fact-Sheet card (presentation only; the tier + checks come
 *  from the reused launcher gate via `simulate`). */
function ProjectedFactSheet({ sheet }: { sheet: LaunchFactSheet }) {
  return (
    <div className="rounded-2xl border border-white/12 bg-[rgba(6,12,26,0.6)] p-5 sm:p-6">
      <div className="flex items-center justify-between mb-3">
        <span className="text-white/80 text-sm font-semibold">Projected Fact Sheet</span>
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${TIER_STYLE[sheet.tier]}`}>
          {sheet.tier === 'none' ? 'Below listable bar' : sheet.tier === 'listable' ? 'COMMUNITY' : 'FLAGSHIP'}
        </span>
      </div>
      <ul className="space-y-1.5">
        {sheet.gateChecks.map((c) => (
          <li key={c.id} className="flex items-start gap-2 text-xs">
            <span className={c.passed ? 'text-emerald-400' : 'text-white/30'}>{c.passed ? '✓' : '○'}</span>
            <span className="text-white/60">{c.detail}</span>
          </li>
        ))}
      </ul>
      <p className="text-white/35 text-[10px] mt-3 leading-relaxed">
        A tier reflects structural configuration at a point in time, not a judgement of the project. This is a projection
        of the config above — the live Fact Sheet is re-read from the deployed token.
      </p>
    </div>
  );
}

export function LaunchSimulator() {
  // Stable per-session timestamp (compute-once via a lazy state initializer, so
  // the "measured at" stamp does not drift on every keystroke re-render).
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const [rows, setRows] = useState<AllocRow[]>([]);
  const [structural, setStructural] = useState<StructuralInput>({ ...DEFAULT_STRUCTURAL });
  const [bundlesModeled, setBundlesModeled] = useState(false);
  const [snipersModeled, setSnipersModeled] = useState(false);

  const setS = <K extends keyof StructuralInput>(k: K, v: StructuralInput[K]) => setStructural((s) => ({ ...s, [k]: v }));

  const result = useMemo(
    () => simulate({ rows, structural, bundlesModeled, snipersModeled, now }),
    [rows, structural, bundlesModeled, snipersModeled, now],
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
      {/* ── LEFT: inputs ── */}
      <div className="space-y-5">
        <section className="rounded-2xl border border-white/12 bg-[rgba(6,12,26,0.6)] p-5">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-white font-semibold text-sm">Proposed allocation</h2>
            <span className="text-white/40 text-[11px] tabular-nums">
              {result.hasData ? `${Number(result.totalSupply).toLocaleString()} total` : 'no supply yet'}
            </span>
          </div>
          <p className="text-white/45 text-xs mb-3 leading-relaxed">
            Enter who will hold what at launch. Amounts are relative — only the shares matter. Pools, treasuries and other
            excluded categories are removed before the concentration math, exactly as on a live token.
          </p>

          <div className="space-y-2">
            {rows.map((row) => (
              <AllocationRow
                key={row.id}
                row={row}
                bundlesModeled={bundlesModeled}
                snipersModeled={snipersModeled}
                onChange={(patch) => setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, ...patch } : r)))}
                onRemove={() => setRows((rs) => rs.filter((r) => r.id !== row.id))}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button
              onClick={() => setRows((rs) => [...rs, newRow()])}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/90 text-black hover:bg-emerald-400 transition"
            >
              + Add allocation
            </button>
            {rows.length > 0 && (
              <button onClick={() => setRows([])} className="px-3 py-1.5 rounded-lg text-xs text-white/50 hover:text-white/80 transition">
                Clear all
              </button>
            )}
          </div>

          <div className="mt-3 pt-3 border-t border-white/10">
            <div className="text-white/40 text-[11px] mb-1.5">Load an editable example (then replace with your plan):</div>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.id}
                  onClick={() => setRows(ex.build())}
                  className="px-2.5 py-1 rounded-lg text-[11px] border border-white/15 text-white/70 hover:border-white/35 hover:text-white transition"
                  title={ex.note}
                >
                  {ex.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-white/12 bg-[rgba(6,12,26,0.6)] p-5">
          <h2 className="text-white font-semibold text-sm mb-2">Structural configuration</h2>
          <p className="text-white/45 text-xs mb-3 leading-relaxed">
            These drive both the distribution gate and the projected Fact Sheet from one place.
          </p>

          <Toggle
            checked={structural.knownSafeTemplate}
            onChange={(v) => setS('knownSafeTemplate', v)}
            label="Audited, non-upgradeable template (Doppler)"
            hint="Fixes supply and rules out mint / pause / blacklist / fee-on-transfer / upgrade by construction."
          />

          {!structural.knownSafeTemplate && (
            <div className="pl-2 border-l border-white/10 ml-1 mt-1 space-y-0.5">
              <Toggle checked={structural.canMint} onChange={(v) => setS('canMint', v)} label="Owner can mint" />
              <Toggle checked={structural.canPause} onChange={(v) => setS('canPause', v)} label="Owner can pause / freeze" />
              <Toggle checked={structural.canBlacklist} onChange={(v) => setS('canBlacklist', v)} label="Owner can blacklist" />
              <Toggle checked={structural.feeOnTransfer} onChange={(v) => setS('feeOnTransfer', v)} label="Fee on transfer" />
              <Toggle checked={structural.upgradeable} onChange={(v) => setS('upgradeable', v)} label="Upgradeable logic" />
            </div>
          )}

          <div className="h-px bg-white/10 my-2" />

          <Toggle
            checked={structural.lpLocked}
            onChange={(v) => setS('lpLocked', v)}
            label="Liquidity locked"
            hint="Unlocked liquidity is the binding risk — it forces the band to Concentrated."
          />
          {structural.lpLocked && (
            <label className="flex items-center gap-2 text-xs text-white/60 pl-11 -mt-1 mb-1">
              lock
              <input
                className={`${inputCls} w-16 tabular-nums`}
                inputMode="numeric"
                value={structural.lpLockMonths}
                onChange={(e) => setS('lpLockMonths', Number(e.target.value.replace(/\D/g, '')) || 0)}
              />
              months
            </label>
          )}

          <Toggle
            checked={structural.adminRenouncedOrTimelock}
            onChange={(v) => setS('adminRenouncedOrTimelock', v)}
            label="Admin renounced or timelock-held"
            hint="Required for the Flagship Fact-Sheet tier."
          />

          <div className="h-px bg-white/10 my-2" />

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-white/70 text-xs">Team / insider float (%)</span>
              <PctField
                className={`${inputCls} mt-1 tabular-nums`}
                bps={structural.teamAllocationBps}
                onBps={(bps) => setS('teamAllocationBps', bps)}
              />
            </label>
            <label className="block">
              <span className="text-white/70 text-xs">…of which on-chain vested (%)</span>
              <PctField
                className={`${inputCls} mt-1 tabular-nums`}
                bps={structural.teamAllocationVestedBps}
                onBps={(bps) => setS('teamAllocationVestedBps', bps)}
              />
            </label>
          </div>

          <div className="h-px bg-white/10 my-2" />

          <Toggle
            checked={bundlesModeled}
            onChange={setBundlesModeled}
            label="Model launch bundles"
            hint="Adds a per-row 'bundled' flag. Off = bundle supply is an un-measured gap (lowers confidence), never a false 0%."
          />
          <Toggle
            checked={snipersModeled}
            onChange={setSnipersModeled}
            label="Model snipers"
            hint="Adds a per-row 'sniper' flag for wallets bought in the opening window."
          />
        </section>
      </div>

      {/* ── RIGHT: results (self-gated) ── */}
      <div className="space-y-5">
        {!result.hasData ? (
          <div className="rounded-2xl border border-dashed border-white/15 bg-black/20 p-8 text-center">
            <div className="text-white/70 text-sm font-semibold">Nothing to measure yet</div>
            <p className="text-white/45 text-xs mt-2 max-w-sm mx-auto leading-relaxed">
              Add at least one allocation with a non-zero amount (or load an example) to see the distribution band, the
              full detection report, and what it takes to reach each band. No numbers are shown until there is real input.
            </p>
          </div>
        ) : (
          <>
            <DistributionReport analysis={result.analysis} />
            <BandDeltaPanel targets={result.bandTargets} />
            <ProjectedFactSheet sheet={result.factSheet} />
          </>
        )}
      </div>
    </div>
  );
}
