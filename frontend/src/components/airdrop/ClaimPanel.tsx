import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { formatUnits, isAddress, type Address } from 'viem';
import { useAirdropCampaign } from '../../hooks/useAirdropCampaign';
import { evaluateEligibility, parseManifest, type CampaignManifest, type EligibilityStatus } from '../../lib/merkle';
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

export function ClaimPanel() {
  const { address } = useAccount();
  const [distributorInput, setDistributorInput] = useState('');
  const [manifestText, setManifestText] = useState('');

  const distributor = isAddress(distributorInput) ? (distributorInput as Address) : null;

  const manifestState = useMemo<{ manifest: CampaignManifest | null; error: string | null }>(() => {
    if (manifestText.trim() === '') return { manifest: null, error: null };
    try {
      return { manifest: parseManifest(manifestText), error: null };
    } catch (e) {
      return { manifest: null, error: (e as Error).message };
    }
  }, [manifestText]);

  const manifest = manifestState.manifest;
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

        <label htmlFor="claim-manifest" className="block text-white/70 text-[13px] font-semibold mt-4 mb-2">
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
          The chain stores one 32-byte root and no list, so the manifest comes from whoever created the campaign. This
          page re-derives your leaf and re-checks the proof locally against the root the distributor actually reports —
          a manifest that does not match is caught here rather than at the wallet prompt.
        </p>
        {manifestState.error && (
          <p className="text-rose-300/85 text-[12px] mt-2">Manifest rejected: {manifestState.error}</p>
        )}
      </section>

      {/* ─── Verdict ─── */}
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
