import { useEffect, useState } from 'react';
import type { Dispatch } from 'react';
import { formatEther } from 'viem';
import {
  buildContractMetadata,
  buildTokenMetadata,
  matchCsvToFiles,
} from '../../../lib/nftMetadata';
import { arweaveUri } from '../../../lib/irysClient';
import { useIrysUpload } from '../../../hooks/useIrysUpload';
import { REVENUE_DISTRIBUTOR_ADDRESS } from '../../../lib/constants';
import type { WizardState, WizardAction } from './wizardReducer';
import { BTN_EMERALD, LABEL } from '../launchpadConstants';

/// Upload cost estimate overshoots slightly (20%) so dust funding covers surge
/// pricing between quote and actual upload. Any excess is retained by Irys for
/// the wallet and can be withdrawn later.
const FUNDING_BUFFER_BPS = 2000; // 20%

type Phase = 'idle' | 'quoted' | 'funding' | 'uploading' | 'done' | 'error';

export function Step4_FundUpload({
  state,
  dispatch,
  onNext,
  onBack,
}: {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  onNext: () => void;
  onBack: () => void;
}) {
  const irys = useIrysUpload();
  // metadataManifestId is the last "core" artifact produced; if it's set the
  // upload pipeline fully completed on a prior run and we should jump to done.
  const [phase, setPhase] = useState<Phase>(state.metadataManifestId ? 'done' : 'idle');
  const [localErr, setLocalErr] = useState<string | null>(null);

  const bytesToPay =
    state.imageFiles.reduce((acc, f) => acc + f.size, 0) +
    state.rows.length * 512 + // metadata JSON overhead estimate
    2048;                     // contractURI + buffer

  useEffect(() => {
    if (phase === 'idle' && state.quoteWei === null) {
      (async () => {
        try {
          const wei = await irys.quote(bytesToPay);
          const buffered = wei + (wei * BigInt(FUNDING_BUFFER_BPS)) / 10_000n;
          dispatch({ type: 'QUOTE_RECEIVED', wei: buffered });
          setPhase('quoted');
        } catch (e) {
          setLocalErr((e as Error).message);
          setPhase('error');
        }
      })();
    } else if (phase === 'idle' && state.quoteWei !== null) {
      // Hydrated from a draft with an existing quote — skip straight to quoted.
      setPhase('quoted');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const handleFundAndUpload = async () => {
    if (!state.quoteWei) return;
    setLocalErr(null);
    try {
      // 1) Fund — only if we haven't already funded on a prior attempt. Irys
      // balance persists per wallet, so re-funding is safe but costs an extra
      // tx the user didn't expect; skipping matches user expectation on retry.
      if (!state.fundTxId) {
        setPhase('funding');
        const txId = await irys.fund(state.quoteWei);
        dispatch({ type: 'FUND_SUCCESS', txId });
      }

      setPhase('uploading');

      // 2) Images folder — skip if the manifest already landed.
      let imagesManifestId = state.imagesManifestId;
      if (!imagesManifestId) {
        imagesManifestId = await irys.uploadFolder(state.imageFiles);
        dispatch({ type: 'IMAGES_UPLOADED', manifestId: imagesManifestId });
      }

      // 3) Per-token metadata JSON folder — skip if already uploaded.
      if (!state.metadataManifestId) {
        const matched = matchCsvToFiles(state.rows, state.imageFiles).matched;
        const metaItems = matched.map((m, i) => ({
          filename: `${i + 1}`, // ERC-721 token IDs start at 1 and concat to baseURI
          json: buildTokenMetadata(m.row, `${arweaveUri(imagesManifestId!)}${m.file.name}`),
        }));
        const metadataManifestId = await irys.uploadJsonFolder(metaItems);
        dispatch({ type: 'METADATA_UPLOADED', manifestId: metadataManifestId });
      }

      // 4) Banner / cover — optional and independently resumable.
      let coverId = state.coverId;
      if (!coverId && state.coverFile) {
        coverId = await irys.uploadFolder([state.coverFile]);
        dispatch({ type: 'COVER_UPLOADED', txId: coverId });
      }
      let bannerId = state.bannerId;
      if (!bannerId && state.bannerFile) {
        bannerId = await irys.uploadFolder([state.bannerFile]);
        dispatch({ type: 'BANNER_UPLOADED', txId: bannerId });
      }

      // 5) contractURI JSON — skip if already landed.
      if (!state.contractUriId) {
        const contractMeta = buildContractMetadata({
          name: state.collectionName,
          description: state.description,
          coverImageUri:
            coverId && state.coverFile ? `${arweaveUri(coverId)}${state.coverFile.name}` : undefined,
          bannerImageUri:
            bannerId && state.bannerFile
              ? `${arweaveUri(bannerId)}${state.bannerFile.name}`
              : undefined,
          externalLink: state.externalLink || undefined,
          royaltyBps: state.royaltyBps,
          feeRecipient: REVENUE_DISTRIBUTOR_ADDRESS,
        });
        const contractUriId = await irys.uploadJson(contractMeta, 'contract.json');
        dispatch({ type: 'CONTRACT_URI_UPLOADED', txId: contractUriId });
      }

      setPhase('done');
    } catch (e) {
      setLocalErr((e as Error).message);
      setPhase('error');
    }
  };

  const quoteEth = state.quoteWei ? formatEther(state.quoteWei) : '—';

  const retryLabel = (() => {
    if (!state.fundTxId) return 'Retry fund + upload';
    if (!state.imagesManifestId) return 'Retry image upload';
    if (!state.metadataManifestId) return 'Retry metadata upload';
    if (!state.contractUriId) return 'Retry contract URI';
    return 'Retry';
  })();

  return (
    <div className="space-y-5">
      <div className="rounded-xl p-4 bg-black/40 border border-white/10">
        <label className={LABEL}>Arweave upload cost</label>
        <p className="text-emerald-400 text-2xl font-semibold mt-1">
          {phase === 'idle' ? 'Calculating…' : `~${Number(quoteEth).toFixed(5)} ETH`}
        </p>
        <p className="text-white/60 text-[11px] mt-1">
          Includes {FUNDING_BUFFER_BPS / 100}% buffer for surge pricing. Dust leftover stays
          in your Irys balance and can be reclaimed later.
          {state.fundTxId && (
            <span className="text-emerald-400/80"> · Wallet already funded — retries skip funding.</span>
          )}
        </p>
      </div>

      {phase === 'uploading' && irys.progress.total > 0 && (
        <div className="rounded-xl p-4 bg-black/40 border border-white/10">
          <label className={LABEL}>
            Uploading {irys.progress.uploaded} / {irys.progress.total}
          </label>
          <div className="w-full h-1.5 rounded-full bg-black/60 mt-2 overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${(irys.progress.uploaded / irys.progress.total) * 100}%` }}
            />
          </div>
          {irys.progress.currentFile && (
            <p className="text-white/50 text-[11px] mt-1 truncate">
              {irys.progress.currentFile}
            </p>
          )}
        </div>
      )}

      <div className="space-y-2 text-[12px]">
        <RowStatus label="Wallet funding tx" value={state.fundTxId} />
        <RowStatus label="Images manifest" value={state.imagesManifestId} />
        <RowStatus label="Metadata manifest" value={state.metadataManifestId} />
        <RowStatus label="contractURI" value={state.contractUriId} />
      </div>

      {localErr && (
        <div className="rounded-lg p-3 bg-red-500/10 border border-red-500/30 text-red-300 text-[12px]">
          {localErr}
        </div>
      )}

      <div className="flex justify-between pt-4 gap-3">
        <button
          onClick={onBack}
          disabled={phase === 'funding' || phase === 'uploading'}
          className="px-5 py-2 rounded-lg text-xs text-white/70 hover:text-white border border-white/15 bg-black/30 disabled:opacity-40"
        >
          ← Back
        </button>
        {phase === 'done' ? (
          <button onClick={onNext} className={`px-8 py-2.5 rounded-xl text-sm ${BTN_EMERALD}`}>
            Review + deploy →
          </button>
        ) : (
          <button
            onClick={handleFundAndUpload}
            disabled={
              phase === 'idle' ||
              phase === 'funding' ||
              phase === 'uploading' ||
              !state.quoteWei
            }
            className={`px-8 py-2.5 rounded-xl text-sm ${BTN_EMERALD} disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {phase === 'funding'
              ? 'Confirm fund in wallet…'
              : phase === 'uploading'
              ? 'Uploading to Arweave…'
              : phase === 'error'
              ? retryLabel
              : 'Fund + Upload'}
          </button>
        )}
      </div>
    </div>
  );
}

function RowStatus({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-white/60">{label}</span>
      <span className={`font-mono truncate max-w-[60%] ${value ? 'text-emerald-400' : 'text-white/40'}`}>
        {value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—'}
      </span>
    </div>
  );
}
