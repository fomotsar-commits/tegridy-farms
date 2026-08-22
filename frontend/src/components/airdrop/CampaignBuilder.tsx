import { useMemo, useState } from 'react';
import { useReadContracts } from 'wagmi';
import { formatUnits, isAddress, type Address, type Hex } from 'viem';
import { toast } from 'sonner';
import { ERC20_ABI } from '../../lib/contracts';
import { CHAIN_ID } from '../../lib/constants';
import { useAirdropFactory } from '../../hooks/useAirdropFactory';
import {
  attachDistributor,
  buildCampaign,
  parseAllocationCsv,
  publishManifest,
  serializeManifest,
  verifyManifest,
  type CampaignManifest,
  type PublishResult,
} from '../../lib/merkle';

/**
 * Campaign creation: CSV in, merkle root out, hosting, funding last.
 *
 * The tree is built entirely in the browser. That is deliberate — a claimant has to be
 * able to rebuild the same root from the same list without trusting this site, and a
 * server-built tree would make that impossible to check.
 *
 * PUBLISHING HAPPENS BEFORE FUNDING, and that ordering is the whole point of the step.
 * The store recomputes the root from the rows it actually stored and returns ITS number;
 * the creator sees that number next to the browser's before signing anything. Both sides
 * run src/lib/merkle/core.js, so agreement is expected — and a disagreement means one of
 * them is describing a different list, which is exactly the thing you must not discover
 * after the tokens are locked. Funding is blocked in that case and only in that case.
 *
 * Hosting is NOT a precondition for funding. If our store is down, the creator still has
 * a real root and a real manifest, and a campaign they can run by publishing the JSON
 * themselves. The surface says which of those two situations they are in.
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
  const [publishState, setPublishState] = useState<PublishResult | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [distributorInput, setDistributorInput] = useState('');
  const [attachNote, setAttachNote] = useState<string | null>(null);

  const token = isAddress(tokenInput) ? (tokenInput as Address) : null;

  const { data: tokenData } = useReadContracts({
    contracts: [
      { address: token ?? undefined, abi: ERC20_ABI, chainId: CHAIN_ID, functionName: 'symbol' },
      { address: token ?? undefined, abi: ERC20_ABI, chainId: CHAIN_ID, functionName: 'decimals' },
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
   * Any edit to the inputs discards the built tree AND the publish result.
   *
   * Without this, a creator could build a root, edit the CSV, and be looking at a root
   * preview that no longer describes the list on screen — with a Create button under it
   * that would fund the stale root. Rebuilding is one click; showing a root that does
   * not match its list is not recoverable once the transaction lands.
   *
   * The publish result is cleared for the same reason and it is the more dangerous half:
   * a stale "published" badge beside an edited list would claim we are hosting a
   * manifest for a root nobody has funded, and the campaign that does get funded would
   * have no list in our store at all.
   */
  function invalidate() {
    if (built !== null) setBuilt(null);
    if (publishState !== null) setPublishState(null);
    if (attachNote !== null) setAttachNote(null);
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

  async function handlePublish() {
    if (!manifest) return;
    setPublishing(true);
    setAttachNote(null);
    try {
      const result = await publishManifest({
        chainId: CHAIN_ID,
        token: token,
        criteria: criteria.trim() || null,
        // Base units as decimal strings. A JSON number cannot carry a uint256, and an
        // allocation silently rounded by IEEE-754 is a wrong allocation.
        entries: manifest.rows.map((r) => ({ account: r.account, amount: r.amount.toString() })),
      });
      setPublishState(result);
    } finally {
      setPublishing(false);
    }
  }

  async function handleAttach() {
    const storedRoot = publishState?.root;
    if (!storedRoot || !isAddress(distributorInput)) return;
    const result = await attachDistributor({
      chainId: CHAIN_ID,
      root: storedRoot as Hex,
      distributor: distributorInput as Address,
    });
    setAttachNote(
      result.ok
        ? 'Recorded. Claimants can now find this list by the campaign address alone.'
        : (result.detail ?? 'The campaign address was not recorded.'),
    );
  }

  /**
   * The store recomputed the root from the rows it stored. Anything other than exact
   * agreement means the two sides are describing different lists, and the only safe
   * response is to refuse to fund either of them. `null` while nothing is published —
   * unknown, which is not the same as agreeing.
   */
  const storedRoot = publishState?.ok ? publishState.root : null;
  const rootAgrees = manifest && storedRoot ? storedRoot.toLowerCase() === manifest.root.toLowerCase() : null;

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

      {/* ─── Hosting ─── */}
      {manifest && (
        <section className="rounded-2xl border border-white/10 bg-black/20 p-5">
          <h2 className="text-white/85 font-semibold text-sm mb-1">Host the claim list</h2>
          <p className="text-white/45 text-[12px] leading-relaxed">
            Stores the list with us so claimants fetch their own leaf and proof instead of being handed the whole
            recipient list as JSON. We serve one leaf per request and never the list — a full-list endpoint would be a
            free wallet-targeting database for anyone who asked. This step happens before funding so you can compare the
            root we computed against the one above.
          </p>

          <button
            type="button"
            className="btn-primary mt-3 px-4 py-2 text-[13px] disabled:opacity-40"
            disabled={publishing || publishState?.ok === true}
            onClick={() => void handlePublish()}
          >
            {publishing ? 'Publishing…' : publishState?.ok ? 'Published' : 'Publish the list'}
          </button>

          {publishState && (
            <div
              className={`mt-4 rounded-xl border p-4 ${
                rootAgrees === false
                  ? 'border-rose-500/30 bg-rose-500/[0.06]'
                  : publishState.ok
                    ? 'border-emerald-500/25 bg-emerald-500/[0.05]'
                    : 'border-amber-500/25 bg-amber-500/[0.06]'
              }`}
            >
              {publishState.ok ? (
                <>
                  <p className="text-white/70 text-[11px]">Root the store computed from the rows it stored</p>
                  <p
                    className={`font-mono text-[12px] break-all mt-1 ${
                      rootAgrees === false ? 'text-rose-300/90' : 'text-emerald-300/90'
                    }`}
                  >
                    {publishState.root}
                  </p>
                  {rootAgrees ? (
                    <p className="text-white/55 text-[12px] mt-2 leading-relaxed">
                      Identical to the root built in your browser. Both sides derived it from the same leaf encoding, so
                      this is the root the distributor will pay against — and the number you are about to commit.
                    </p>
                  ) : (
                    <p className="text-rose-200/90 text-[12px] mt-2 leading-relaxed font-semibold">
                      This does NOT match the root built in your browser. One of the two is describing a different list.
                      Do not fund either root — rebuild from your CSV and publish again. Funding is blocked below.
                    </p>
                  )}
                  {publishState.meta && (
                    <p className="text-white/45 text-[11px] mt-2 leading-relaxed">
                      {publishState.meta.recipientCount} recipients stored.{' '}
                      {publishState.meta.criteria
                        ? 'Your selection criteria travel with the list and are printed on the claim page.'
                        : 'No selection criteria were stored, so the claim page will say so to anyone it turns away.'}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="text-amber-200/90 text-[13px] font-semibold">
                    {publishState.alreadyPublished ? 'This list is already hosted' : 'The list was not hosted'}
                  </p>
                  <p className="text-white/60 text-[12px] mt-1 leading-relaxed">{publishState.detail}</p>
                  {publishState.operatorStep && (
                    <p className="text-white/45 text-[11px] mt-2 leading-relaxed">
                      <span className="text-white/60 font-semibold">Operator: </span>
                      {publishState.operatorStep}
                    </p>
                  )}
                  {!publishState.alreadyPublished && (
                    <p className="text-white/50 text-[11px] mt-2 leading-relaxed">
                      Your root above is still real and your campaign is still fundable — hosting is a convenience, not a
                      precondition. Copy the manifest JSON and publish it yourself, or claimants will have nothing to
                      prove a leaf against. A funded campaign whose list is nowhere is unclaimable by everyone.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {publishState?.ok && (
            <div className="mt-4 border-t border-white/10 pt-4">
              <label htmlFor="airdrop-attach" className="block text-white/60 text-[12px] mb-1">
                After funding: record the campaign address
              </label>
              <div className="flex gap-2">
                <input
                  id="airdrop-attach"
                  value={distributorInput}
                  onChange={(e) => setDistributorInput(e.target.value.trim())}
                  placeholder="0x… the distributor createCampaign returned"
                  className="flex-1 rounded-lg bg-black/40 border border-white/12 px-3 py-2 text-[12px] text-white/90 font-mono"
                />
                <button
                  type="button"
                  className="rounded-lg border border-white/15 px-3 py-2 text-[12px] text-white/80 hover:bg-white/5 disabled:opacity-40"
                  disabled={!isAddress(distributorInput)}
                  onClick={() => void handleAttach()}
                >
                  Record
                </button>
              </div>
              <p className="text-white/40 text-[11px] mt-2 leading-relaxed">
                Links the stored list to the deployed campaign so a claimant who has only the campaign address can find
                it. An address already recorded for this root is never overwritten — repointing a root at a second
                contract would send claimants somewhere their proof cannot be spent.
              </p>
              {attachNote && <p className="text-white/60 text-[12px] mt-2 leading-relaxed">{attachNote}</p>}
            </div>
          )}
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
                  // Blocked ONLY on an actual disagreement. `null` — nothing published —
                  // is not a disagreement, and refusing to fund an unhosted campaign
                  // would make our store an unannounced dependency of running one.
                  rootAgrees === false ||
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
            {rootAgrees === false && (
              <p className="text-rose-300/90 text-[12px] mt-3 leading-relaxed">
                Creation is blocked: the root we stored and the root your browser built are not the same, so neither can
                be trusted to describe your list. Rebuild and publish again.
              </p>
            )}
            {rootAgrees === null && (
              <p className="text-white/45 text-[12px] mt-3 leading-relaxed">
                Nothing is hosted for this root yet. You can still fund the campaign, but claimants will need the
                manifest JSON from you until the list is published.
              </p>
            )}
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
