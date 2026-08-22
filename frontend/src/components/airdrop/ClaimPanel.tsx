import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { formatUnits, isAddress, type Address } from 'viem';
import { useAirdropCampaign } from '../../hooks/useAirdropCampaign';
import { useAirdropManifest } from '../../hooks/useAirdropManifest';
import {
  evaluateEligibility,
  parseManifest,
  type CampaignManifest,
  type EligibilityStatus,
  type ManifestStoreStatus,
} from '../../lib/merkle';
import { CHAIN_ID } from '../../lib/constants';
import { shortenAddress } from '../../lib/formatting';

/**
 * The claim surface, built around telling a wallet WHY rather than just failing.
 *
 * The ordinary shape of these pages is a claim button that reverts, and a claimant who
 * cannot tell whether they were never eligible, already claimed, arrived after the
 * window, or loaded the wrong list. Each of those is a different sentence, and the one
 * that must never be substituted for any of them is "not eligible" when the truth is
 * "this page could not check".
 *
 * `evaluateEligibility` owns that decision; this component only renders it.
 *
 * ─── WHERE THE LIST COMES FROM ─────────────────────────────────────────────
 *
 * Two sources, in this precedence:
 *
 *   1. A manifest the claimant PASTED. An explicit act by the person claiming beats
 *      anything we serve them, and it is the only path that works for campaigns created
 *      before the hosted store existed.
 *   2. The hosted store, which serves that wallet's leaf and proof and never the list.
 *
 * The store failing is not the store saying no. Every non-answer it can give
 * (unconfigured, migration unapplied, unreachable, no manifest for this campaign, a
 * proof that would not verify) leaves the manifest null, which `evaluateEligibility`
 * resolves to `unknown` — and the block below names which one it was and opens the paste
 * fallback. Absence of a manifest is never rendered as ineligibility.
 */

/** Palette per verdict. `unknown` and `no-wallet` are neutral, never red. */
const TONE: Record<EligibilityStatus, string> = {
  eligible: 'border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-200/90',
  'no-wallet': 'border-white/12 bg-white/[0.03] text-white/70',
  unknown: 'border-amber-500/25 bg-amber-500/[0.06] text-amber-200/90',
  'not-listed': 'border-white/12 bg-white/[0.03] text-white/75',
  'already-claimed': 'border-sky-500/25 bg-sky-500/[0.06] text-sky-200/90',
  'window-closed': 'border-white/12 bg-white/[0.03] text-white/75',
  'proof-invalid': 'border-rose-500/30 bg-rose-500/[0.06] text-rose-200/90',
  'root-mismatch': 'border-rose-500/30 bg-rose-500/[0.06] text-rose-200/90',
};

/**
 * One line per store status, in the store's own voice.
 *
 * Every failure entry states what is NOT being claimed by it. That repetition is
 * deliberate: these strings are the last thing between an outage and a claimant
 * concluding they were never a recipient.
 */
const STORE_NOTE: Record<ManifestStoreStatus, string> = {
  listed: 'Your leaf and proof came from our manifest store, and the proof was re-checked here against the root the distributor reports.',
  'not-listed': 'The store read this campaign’s list and this wallet is not in it. This is a verdict about the wallet, not about the store.',
  'no-manifest':
    'We hold no manifest for this campaign, so this page has no list to check you against. That is a gap in our store — it is not a statement that you are not a recipient. Paste the creator’s manifest below to check.',
  'not-configured':
    'This deployment has no manifest store configured, so no list could be loaded. Nothing here says you are not a recipient. Paste the creator’s manifest below.',
  'schema-missing':
    'The manifest store is not set up on this deployment yet, so no list could be loaded. Nothing here says you are not a recipient. Paste the creator’s manifest below.',
  'proof-unverifiable':
    'The store holds a list for this campaign but could not produce a proof that verifies against its root, so it served none. That is a fault in the stored list. Paste the creator’s manifest below.',
  unreachable:
    'The manifest store did not answer, so no list could be loaded. Nothing here says you are not a recipient. Paste the creator’s manifest below.',
};

/** Green only for the one status that is good news; a verdict about a wallet is neutral. */
const STORE_TONE: Record<ManifestStoreStatus, string> = {
  listed: 'border-emerald-500/25 bg-emerald-500/[0.05] text-emerald-200/85',
  'not-listed': 'border-white/12 bg-white/[0.03] text-white/70',
  'no-manifest': 'border-amber-500/25 bg-amber-500/[0.06] text-amber-200/85',
  'not-configured': 'border-amber-500/25 bg-amber-500/[0.06] text-amber-200/85',
  'schema-missing': 'border-amber-500/25 bg-amber-500/[0.06] text-amber-200/85',
  'proof-unverifiable': 'border-amber-500/25 bg-amber-500/[0.06] text-amber-200/85',
  unreachable: 'border-amber-500/25 bg-amber-500/[0.06] text-amber-200/85',
};

export function ClaimPanel() {
  const { address } = useAccount();
  const [distributorInput, setDistributorInput] = useState('');
  const [manifestText, setManifestText] = useState('');
  const [pasteRequested, setPasteRequested] = useState(false);

  const distributor = isAddress(distributorInput) ? (distributorInput as Address) : null;

  const manifestState = useMemo<{ manifest: CampaignManifest | null; error: string | null }>(() => {
    if (manifestText.trim() === '') return { manifest: null, error: null };
    try {
      return { manifest: parseManifest(manifestText), error: null };
    } catch (e) {
      return { manifest: null, error: (e as Error).message };
    }
  }, [manifestText]);

  const store = useAirdropManifest(distributor ? { chainId: CHAIN_ID, distributor } : null, address ?? null);
  const storeResult = store.result;

  // A pasted list wins. It is the claimant's own act, and it is the only path that
  // covers campaigns created before the store existed.
  const manifest = manifestState.manifest ?? storeResult?.manifest ?? null;
  const fromStore = manifestState.manifest === null && storeResult?.manifest != null;

  // Derived, not synchronised: open because the claimant asked, OR because the store
  // told us to offer it. A claimant should not have to know a fallback exists to reach
  // their own allocation, and computing this rather than storing it means the panel can
  // never be left closed by a render order.
  const pasteOpen = pasteRequested || storeResult?.pasteFallback === true;

  const row = useMemo(
    () =>
      manifest && address
        ? manifest.rows.find((r) => r.account.toLowerCase() === address.toLowerCase()) ?? null
        : null,
    [manifest, address],
  );

  const campaign = useAirdropCampaign(distributor, row?.index ?? null);

  const verdict = evaluateEligibility({
    manifest,
    account: address ?? null,
    onChain: campaign.campaign,
    claimed: campaign.claimed,
  });

  const decimals = campaign.tokenDecimals;
  // While the store is still being asked there is no answer yet, and the evaluator's
  // "no claim list is loaded" would be true but premature. Held back rather than shown
  // and then replaced, because the replaced version is the one people screenshot.
  const awaitingStore = store.loading && manifestState.manifest === null;

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-white/10 bg-black/20 p-5">
        <label htmlFor="claim-distributor" className="block text-white/70 text-[13px] font-semibold mb-2">
          Campaign address
        </label>
        <input
          id="claim-distributor"
          value={distributorInput}
          onChange={(e) => setDistributorInput(e.target.value.trim())}
          placeholder="0x… (the distributor, not the factory)"
          className="w-full rounded-lg bg-black/40 border border-white/12 px-3 py-2 text-[13px] text-white/90 font-mono"
        />
        <p className="text-white/40 text-[11px] mt-2 leading-relaxed">
          The chain stores one 32-byte root and no list. Enter the campaign and we look up your leaf in our manifest
          store, generate the proof server-side, and re-check it here against the root the distributor actually reports.
          You do not need the creator&apos;s JSON unless we have no manifest for the campaign.
        </p>
      </section>

      {/* ─── Where the list came from ─── */}
      {distributor && address && (
        <section
          className={`rounded-2xl border p-5 ${
            awaitingStore ? 'border-white/12 bg-white/[0.03] text-white/70' : storeResult ? STORE_TONE[storeResult.status] : 'border-white/12 bg-white/[0.03] text-white/70'
          }`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-semibold">Claim list</p>
            {storeResult?.meta && (
              <p className="text-white/45 text-[11px] tabular-nums">
                {storeResult.meta.recipientCount} recipients
              </p>
            )}
          </div>
          {awaitingStore ? (
            <p className="text-white/60 text-[12px] mt-1.5 leading-relaxed">
              Looking up this wallet in the manifest store. Nothing has been decided yet.
            </p>
          ) : storeResult ? (
            <>
              <p className="text-white/65 text-[12px] mt-1.5 leading-relaxed">{STORE_NOTE[storeResult.status]}</p>
              {storeResult.detail && storeResult.status !== 'listed' && (
                <p className="text-white/50 text-[11px] mt-2 leading-relaxed">{storeResult.detail}</p>
              )}
              {storeResult.operatorStep && (
                <p className="text-white/45 text-[11px] mt-2 leading-relaxed">
                  <span className="text-white/60 font-semibold">Operator: </span>
                  {storeResult.operatorStep}
                </p>
              )}
              {storeResult.meta?.criteria && (
                <p className="text-white/50 text-[11px] mt-2 leading-relaxed">
                  <span className="text-white/60 font-semibold">Selected as: </span>
                  {storeResult.meta.criteria}
                </p>
              )}
              {manifestState.manifest !== null && (
                <p className="text-white/45 text-[11px] mt-2 leading-relaxed">
                  A pasted manifest is in use below, so the verdict is based on that rather than on the store.
                </p>
              )}
            </>
          ) : (
            <p className="text-white/60 text-[12px] mt-1.5 leading-relaxed">
              The manifest store has not been asked yet.
            </p>
          )}
        </section>
      )}

      {/* ─── Verdict ─── */}
      {awaitingStore ? (
        <section className="rounded-2xl border border-white/12 bg-white/[0.03] p-5">
          <p className="text-sm font-semibold text-white/70">Checking</p>
          <p className="text-white/55 text-[12px] mt-1.5 leading-relaxed">
            The claim list is still being read. No eligibility verdict has been reached — this space is deliberately
            blank rather than showing a guess.
          </p>
        </section>
      ) : (
        <section className={`rounded-2xl border p-5 ${TONE[verdict.status]}`}>
          <p className="text-sm font-semibold">{verdict.title}</p>
          <p className="text-white/65 text-[12px] mt-1.5 leading-relaxed">{verdict.detail}</p>

          {verdict.row && (
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
              <div>
                <dt className="text-white/45 text-[11px]">Allocation</dt>
                <dd className="text-white/85 tabular-nums">
                  {decimals === null
                    ? 'unknown scale — token decimals unread'
                    : `${formatUnits(verdict.row.amount, decimals)} ${campaign.tokenSymbol ?? ''}`}
                </dd>
              </div>
              <div>
                <dt className="text-white/45 text-[11px]">Leaf index</dt>
                <dd className="text-white/85 tabular-nums">{verdict.row.index}</dd>
              </div>
            </dl>
          )}

          {verdict.canClaim && (
            <button
              type="button"
              className="btn-primary mt-4 px-4 py-2 text-[13px] disabled:opacity-40"
              disabled={campaign.isPending || campaign.isConfirming}
              onClick={() =>
                verdict.row &&
                campaign.claim({
                  index: verdict.row.index,
                  account: verdict.row.account,
                  amount: verdict.row.amount,
                  proof: verdict.row.proof,
                })
              }
            >
              {campaign.campaign && campaign.campaign.claimFeeWei > 0n
                ? `Claim (${formatUnits(campaign.campaign.claimFeeWei, 18)} ETH fee)`
                : 'Claim'}
            </button>
          )}
          {verdict.canClaim && fromStore && (
            <p className="text-white/40 text-[11px] mt-3 leading-relaxed">
              The proof was generated by us and verified twice — once server-side against the stored root, once here
              against the root this distributor reports. Neither check trusts the other.
            </p>
          )}
        </section>
      )}

      {/* ─── Paste fallback ─── */}
      <section className="rounded-2xl border border-white/10 bg-black/20 p-5">
        {!pasteOpen ? (
          <button
            type="button"
            className="text-white/60 hover:text-white/85 text-[12px] underline decoration-white/20"
            onClick={() => setPasteRequested(true)}
          >
            Paste a manifest instead
          </button>
        ) : (
          <>
            <label htmlFor="claim-manifest" className="block text-white/70 text-[13px] font-semibold mb-2">
              Claim list (manifest JSON)
            </label>
            <textarea
              id="claim-manifest"
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              rows={6}
              spellCheck={false}
              placeholder='{"version":1,"root":"0x…","rows":[…]}'
              className="w-full rounded-lg bg-black/40 border border-white/12 px-3 py-2 text-[12px] text-white/90 font-mono"
            />
            <p className="text-white/40 text-[11px] mt-2 leading-relaxed">
              For campaigns whose list we do not host — anything created before this store existed, or published
              elsewhere. This page re-derives your leaf and re-checks the proof locally against the root the distributor
              actually reports, so a manifest that does not match is caught here rather than at the wallet prompt. A
              pasted list takes precedence over ours.
            </p>
            {manifestState.error && (
              <p className="text-rose-300/85 text-[12px] mt-2">Manifest rejected: {manifestState.error}</p>
            )}
          </>
        )}
      </section>

      {/* ─── What the chain says ─── */}
      {distributor && (
        <section className="rounded-2xl border border-white/10 bg-black/20 p-5">
          <h2 className="text-white/85 font-semibold text-sm mb-3">Campaign, as the chain reports it</h2>
          {!campaign.campaign ? (
            <p className="text-amber-200/85 text-[12px] leading-relaxed">
              No data. {shortenAddress(distributor, 6)} did not answer a `campaignInfo()` call — it may not be a
              distributor, or the RPC did not return. Nothing on this panel should be read as a statement about the
              campaign.
            </p>
          ) : (
            <dl className="space-y-2 text-[12px]">
              <div className="flex justify-between gap-3">
                <dt className="text-white/50">Root on-chain</dt>
                <dd className="text-white/80 font-mono text-[11px] break-all">{campaign.campaign.merkleRoot}</dd>
              </div>
              {storeResult?.meta && (
                <div className="flex justify-between gap-3">
                  <dt className="text-white/50">Root we store</dt>
                  <dd
                    className={`font-mono text-[11px] break-all ${
                      storeResult.meta.root.toLowerCase() === campaign.campaign.merkleRoot.toLowerCase()
                        ? 'text-emerald-300/85'
                        : 'text-rose-300/85'
                    }`}
                  >
                    {storeResult.meta.root}
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <dt className="text-white/50">Claims close</dt>
                <dd className="text-white/80">{new Date(campaign.campaign.expiresAt * 1000).toUTCString()}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/50">Held by the distributor</dt>
                <dd className="text-white/80 tabular-nums">
                  {decimals === null
                    ? 'unknown scale'
                    : `${formatUnits(campaign.campaign.remaining, decimals)} ${campaign.tokenSymbol ?? ''}`}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/50">Created by our factory</dt>
                <dd
                  className={
                    campaign.fromOurFactory === true
                      ? 'text-emerald-300/85'
                      : campaign.fromOurFactory === false
                        ? 'text-rose-300/85'
                        : 'text-white/55'
                  }
                >
                  {campaign.fromOurFactory === true
                    ? 'yes'
                    : campaign.fromOurFactory === false
                      ? 'NO — parameters were never bounds-checked here'
                      : 'unchecked — the factory has no address on this deployment'}
                </dd>
              </div>
              <p className="text-white/40 text-[11px] leading-relaxed pt-1">
                The held figure is a live token balance, not a ledger of unclaimed allocations. For a fee-on-transfer or
                rebasing token the two differ, and this is the honest one.
              </p>
            </dl>
          )}
        </section>
      )}
    </div>
  );
}
