import { useMemo, useState } from 'react';
import { useReadContracts } from 'wagmi';
import { formatUnits, isAddress, type Address } from 'viem';
import { toast } from 'sonner';
import { ERC20_ABI } from '../../lib/contracts';
import { useAirdropFactory } from '../../hooks/useAirdropFactory';
import {
  buildCampaign,
  parseAllocationCsv,
  serializeManifest,
  verifyManifest,
  type CampaignManifest,
} from '../../lib/merkle';

/**
 * Campaign creation: CSV in, merkle root out, funding last.
 *
 * The tree is built entirely in the browser. That is deliberate — a claimant has to be
 * able to rebuild the same root from the same list without trusting this site, and a
 * server-built tree would make that impossible to check.
 *
 * The builder works while the factory is undeployed. Computing a root needs no chain,
 * and a creator preparing a campaign ahead of the deploy ceremony is a real use; only
 * the two transactions at the bottom are gated.
 */

const DEFAULT_WINDOW_DAYS = 30;

export function CampaignBuilder() {
  const factory = useAirdropFactory();
  const [tokenInput, setTokenInput] = useState('');
  const [csv, setCsv] = useState('');
  const [windowDays, setWindowDays] = useState(DEFAULT_WINDOW_DAYS);
  const [criteria, setCriteria] = useState('');
  const [built, setBuilt] = useState<{ manifest: CampaignManifest; error: null } | { manifest: null; error: string } | null>(
    null,
  );

  const token = isAddress(tokenInput) ? (tokenInput as Address) : null;

  const { data: tokenData } = useReadContracts({
    contracts: [
      { address: token ?? undefined, abi: ERC20_ABI, functionName: 'symbol' },
      { address: token ?? undefined, abi: ERC20_ABI, functionName: 'decimals' },
    ],
    query: { enabled: token !== null },
  });

  const symbol = tokenData?.[0]?.status === 'success' ? (tokenData[0].result as string) : null;
  // Never defaulted to 18. The decimals decide what every row in the CSV means, so a
  // failed read has to stop the build rather than scale the whole campaign by a guess.
  const decimals = tokenData?.[1]?.status === 'success' ? Number(tokenData[1].result as number) : null;

  const parsed = useMemo(() => {
    if (decimals === null || csv.trim() === '') return null;
    try {
      return parseAllocationCsv(csv, decimals);
    } catch (e) {
      return { entries: [], errors: [{ line: 0, raw: '', reason: (e as Error).message }], headerDetected: false, rowsSeen: 0 };
    }
  }, [csv, decimals]);

  const manifest = built?.manifest ?? null;

  /**
   * Any edit to the inputs discards the built tree.
   *
   * Without this, a creator could build a root, edit the CSV, and be looking at a root
   * preview that no longer describes the list on screen — with a Create button under it
   * that would fund the stale root. Rebuilding is one click; showing a root that does
   * not match its list is not recoverable once the transaction lands.
   */
  function invalidate() {
    if (built !== null) setBuilt(null);
  }

  function handleBuild() {
    if (!parsed || parsed.entries.length === 0) return;
    try {
      const m = buildCampaign(parsed.entries);
      m.token = token ?? undefined;
      m.criteria = criteria.trim() || undefined;
      const check = verifyManifest(m);
      if (!check.ok) {
        // Cannot happen for a tree this file just built; kept because shipping an
        // unverified manifest is the one failure that only surfaces at claim time.
        setBuilt({ manifest: null, error: `built manifest failed self-verification at rows ${check.badRows.join(', ')}` });
        return;
      }
      setBuilt({ manifest: m, error: null });
    } catch (e) {
      setBuilt({ manifest: null, error: (e as Error).message });
    }
  }

  const windowSeconds = windowDays * 86_400;
  // `null` when the factory's bounds were not read. The form then says the value is
  // unchecked here rather than inventing a range to check it against — the contract
  // enforces the real bounds either way.
  const bounds =
    factory.minWindowSeconds === null || factory.maxWindowSeconds === null
      ? null
      : { minDays: factory.minWindowSeconds / 86_400, maxDays: factory.maxWindowSeconds / 86_400 };
  const windowInRange =
    bounds === null
      ? null
      : windowSeconds >= bounds.minDays * 86_400 && windowSeconds <= bounds.maxDays * 86_400;

  return (
    <div className="space-y-5">
      {/* ─── Token ─── */}
      <section className="rounded-2xl border border-white/10 bg-black/20 p-5">
        <label htmlFor="airdrop-token" className="block text-white/70 text-[13px] font-semibold mb-2">
          Token to distribute
        </label>
        <input
          id="airdrop-token"
          value={tokenInput}
          onChange={(e) => { setTokenInput(e.target.value.trim()); invalidate(); }}
          placeholder="0x…"
          className="w-full rounded-lg bg-black/40 border border-white/12 px-3 py-2 text-[13px] text-white/90 font-mono"
        />
        <p className="text-white/45 text-[12px] mt-2">
          {token === null
            ? 'Enter the ERC-20 address. Its decimals are read from the contract and used to convert the amount column.'
            : decimals === null
              ? 'Reading decimals… amounts cannot be interpreted until this returns. Nothing is assumed.'
              : `${symbol ?? 'Token'} — ${decimals} decimals. The amount column is read at this scale.`}
        </p>
      </section>

      {/* ─── Allocation list ─── */}
      <section className="rounded-2xl border border-white/10 bg-black/20 p-5">
        <label htmlFor="airdrop-csv" className="block text-white/70 text-[13px] font-semibold mb-2">
          Allocations (CSV: address, amount)
        </label>
        <textarea
          id="airdrop-csv"
          value={csv}
          onChange={(e) => { setCsv(e.target.value); invalidate(); }}
          rows={8}
          spellCheck={false}
          placeholder={'address,amount\n0x1111…,100\n0x2222…,250.5'}
          className="w-full rounded-lg bg-black/40 border border-white/12 px-3 py-2 text-[12px] text-white/90 font-mono"
        />
        <label htmlFor="airdrop-criteria" className="block text-white/70 text-[13px] font-semibold mt-4 mb-2">
          Selection criteria (printed on the claim page)
        </label>
        <input
          id="airdrop-criteria"
          value={criteria}
          onChange={(e) => { setCriteria(e.target.value); invalidate(); }}
          placeholder="e.g. holders at block 25,900,000 with ≥ 1,000 TOWELI, contracts excluded"
          className="w-full rounded-lg bg-black/40 border border-white/12 px-3 py-2 text-[12px] text-white/90"
        />
        <p className="text-white/40 text-[11px] mt-2 leading-relaxed">
          A wallet told it is not in the list is owed the rule that excluded it. This text travels in the manifest and
          is shown verbatim on the claim page; leaving it blank makes the claim page say so.
        </p>

        {parsed && (
          <div className="mt-4 text-[12px]">
            <p className="text-white/60">
              {parsed.entries.length} valid {parsed.entries.length === 1 ? 'row' : 'rows'}
              {parsed.headerDetected ? ' (header row skipped)' : ''}
              {parsed.errors.length > 0 ? `, ${parsed.errors.length} rejected` : ''}
            </p>
            {parsed.errors.length > 0 && (
              <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                {parsed.errors.map((err) => (
                  <li key={`${err.line}-${err.reason}`} className="text-rose-300/85">
                    line {err.line}: {err.reason}
                  </li>
                ))}
              </ul>
            )}
            {parsed.errors.length > 0 && (
              <p className="text-white/45 mt-2 leading-relaxed">
                Rejected rows are not in the tree. Fix them and rebuild — funding a campaign that silently dropped rows
                pays out less than the list said.
              </p>
            )}
          </div>
        )}

        <button
          type="button"
          className="btn-primary mt-4 px-4 py-2 text-[13px]"
          disabled={!parsed || parsed.entries.length === 0}
          onClick={handleBuild}
        >
          Build merkle root
        </button>
      </section>

      {/* ─── Root preview ─── */}
      {built?.error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.06] p-4">
          <p className="text-rose-200/90 text-[13px] font-semibold">The list could not be turned into a tree</p>
          <p className="text-white/60 text-[12px] mt-1">{built.error}</p>
        </div>
      )}

      {manifest && (
        <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.04] p-5">
          <h2 className="text-white/85 font-semibold text-sm mb-3">Root preview</h2>
          <dl className="space-y-2 text-[13px]">
            <div>
              <dt className="text-white/45 text-[11px]">Merkle root</dt>
              <dd className="text-emerald-300/90 font-mono text-[12px] break-all">{manifest.root}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/50">Recipients</dt>
              <dd className="text-white/85 tabular-nums">{manifest.rows.length}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/50">Total to fund</dt>
              <dd className="text-white/85 tabular-nums">
                {decimals === null ? '—' : `${formatUnits(manifest.total, decimals)} ${symbol ?? ''}`}
              </dd>
            </div>
          </dl>
          <p className="text-white/40 text-[11px] mt-3 leading-relaxed">
            Indices are assigned by address order, not by the order of your file, so anyone with the same list rebuilds
            this exact root. Publish the manifest — the chain stores only the root, and a campaign whose manifest is
            lost is unclaimable by everyone.
          </p>
          <button
            type="button"
            className="mt-3 rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/80 hover:bg-white/5"
            onClick={() => {
              void navigator.clipboard
                .writeText(serializeManifest(manifest))
                .then(() => toast.success('Manifest copied'))
                .catch(() => toast.error('Clipboard unavailable — select the JSON manually'));
            }}
          >
            Copy manifest JSON
          </button>
        </section>
      )}

      {/* ─── Funding ─── */}
      <section className="rounded-2xl border border-white/10 bg-black/20 p-5">
        <h2 className="text-white/85 font-semibold text-sm mb-3">Fund the campaign</h2>

        {!factory.deployed ? (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
            <p className="text-amber-200/90 text-[13px] font-semibold">AirdropFactory isn't deployed yet</p>
            <p className="text-white/55 text-[12px] mt-1 leading-relaxed">
              The root above is real and reproducible, but there is no factory address on this deployment to create a
              campaign against. Keep the manifest; funding becomes available when the contract ships.
            </p>
          </div>
        ) : (
          <>
            <label htmlFor="airdrop-window" className="block text-white/60 text-[12px] mb-1">
              Claim window (days)
            </label>
            <input
              id="airdrop-window"
              type="number"
              min={1}
              value={windowDays}
              onChange={(e) => setWindowDays(Math.max(1, Number(e.target.value) || 1))}
              className="w-32 rounded-lg bg-black/40 border border-white/12 px-3 py-2 text-[13px] text-white/90"
            />
            {bounds && windowInRange === false && (
              <p className="text-rose-300/85 text-[12px] mt-2">
                Outside the factory's bounds ({bounds.minDays}–{bounds.maxDays} days). The transaction would revert.
              </p>
            )}
            {windowInRange === null && (
              <p className="text-white/45 text-[12px] mt-2">
                The factory's window bounds could not be read, so this value is unchecked here — the contract still
                enforces them.
              </p>
            )}

            <p className="text-white/55 text-[12px] mt-3">
              {factory.claimFeeWei === null
                ? 'Per-claim fee: could not be read. It is not assumed to be zero — read it before you announce a number to claimants.'
                : factory.claimFeeWei === 0n
                  ? 'Per-claim fee: none. Claimants pay gas only.'
                  : `Per-claim fee: ${formatUnits(factory.claimFeeWei, 18)} ETH, forwarded to ${factory.feeSink}. The campaign snapshots this at creation; a later change cannot re-price it.`}
            </p>
            {factory.paused === true && (
              <p className="text-amber-200/85 text-[12px] mt-2">
                New campaign creation is paused on the factory. Existing campaigns are unaffected — a pause here stops
                no claim anywhere.
              </p>
            )}

            <div className="flex gap-2 mt-4">
              <button
                type="button"
                className="rounded-lg border border-white/15 px-4 py-2 text-[13px] text-white/85 hover:bg-white/5 disabled:opacity-40"
                disabled={!manifest || !token || factory.isPending || factory.isConfirming}
                onClick={() => manifest && token && factory.approve(token, manifest.total)}
              >
                1. Approve
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-[13px] disabled:opacity-40"
                disabled={
                  !manifest ||
                  !token ||
                  factory.paused === true ||
                  windowInRange === false ||
                  factory.isPending ||
                  factory.isConfirming
                }
                onClick={() =>
                  manifest && token && factory.createCampaign(token, manifest.root, manifest.total, windowSeconds)
                }
              >
                2. Create campaign
              </button>
            </div>
            <p className="text-white/40 text-[11px] mt-3 leading-relaxed">
              The factory pulls the funding straight through to a fresh, ownerless distributor and keeps no balance.
              After the window closes, whatever nobody claimed can be taken back by you and by nobody else.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
