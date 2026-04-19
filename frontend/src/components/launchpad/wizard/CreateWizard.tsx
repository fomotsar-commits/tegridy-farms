import { useReducer, useState } from 'react';
import { m } from 'framer-motion';
import { ART } from '../../../lib/artConfig';
import { ArtCard } from '../launchpadShared';
import { wizardReducer, initialState } from './wizardReducer';
import type { Step, WizardState } from './wizardReducer';
import { WizardStepper } from './WizardStepper';
import { Step1_Connect } from './Step1_Connect';
import { Step2_Upload } from './Step2_Upload';
import { Step3_Preview } from './Step3_Preview';
import { Step4_FundUpload } from './Step4_FundUpload';
import { Step5_Deploy } from './Step5_Deploy';
import {
  useWizardPersist,
  useDraftBanner,
  readDraft,
  clearDraft,
} from '../../../hooks/useWizardPersist';

function timeAgo(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/// CreateWizard — 5-step NFT drop deploy. Connect → Upload → Preview → Fund+Upload → Deploy.
/// Replaces the legacy CreateCollectionForm for v2. Renders inside the NFT Finance
/// → NFT Launchpad surface; shares the existing ArtCard styling and tokens.
export function CreateWizard({ onCreated }: { onCreated?: () => void }) {
  const [state, dispatch] = useReducer(wizardReducer, initialState);
  useWizardPersist(state);
  const { hasDraft, savedAt, dismiss } = useDraftBanner();
  const [restored, setRestored] = useState(false);

  const handleResume = () => {
    const draft = readDraft();
    if (!draft) return;
    // Re-inflate quoteWei from string representation
    const quoteWei = draft.quoteWei ? BigInt(draft.quoteWei) : null;
    const payload: Partial<WizardState> = {
      step: draft.step as Step,
      csvText: draft.csvText,
      collectionName: draft.collectionName,
      collectionSymbol: draft.collectionSymbol,
      description: draft.description,
      externalLink: draft.externalLink,
      maxSupply: draft.maxSupply,
      mintPrice: draft.mintPrice,
      maxPerWallet: draft.maxPerWallet,
      royaltyBps: draft.royaltyBps,
      validationWarnings: draft.validationWarnings,
      fundTxId: draft.fundTxId,
      imagesManifestId: draft.imagesManifestId,
      metadataManifestId: draft.metadataManifestId,
      contractUriId: draft.contractUriId,
      bannerId: draft.bannerId,
      coverId: draft.coverId,
      deployTxHash: draft.deployTxHash,
      deployedAddress: draft.deployedAddress,
      quoteWei,
    };
    dispatch({ type: 'HYDRATE', payload });
    setRestored(true);
    dismiss();
  };

  const handleDiscard = () => {
    dismiss();
    clearDraft();
  };

  const next = () => dispatch({ type: 'STEP_NEXT' });
  const back = () => dispatch({ type: 'STEP_BACK' });

  return (
    <m.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-8"
    >
      <ArtCard art={ART.chaosScene} opacity={1} overlay="none" className="rounded-2xl">
        <div className="p-1 sm:p-3">
          <div className="mb-5">
            <h2 className="heading-luxury text-xl text-white mb-1">Create Collection</h2>
            <p className="text-white/60 text-[12px]">
              Upload art + traits CSV · permanent Arweave storage · one-transaction deploy
            </p>
          </div>

          {hasDraft && !restored && (
            <div className="mb-4 rounded-lg p-3 bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-3">
              <p className="text-amber-200 text-[12px] flex-1">
                Draft found from {savedAt ? timeAgo(savedAt) : 'earlier'}.
                Images must be re-picked on restore.
              </p>
              <div className="flex gap-2 flex-shrink-0">
                <button
                  onClick={handleResume}
                  className="text-[11px] px-3 py-1 rounded bg-amber-500/30 hover:bg-amber-500/40 text-amber-100 border border-amber-500/50"
                >
                  Resume
                </button>
                <button
                  onClick={handleDiscard}
                  className="text-[11px] px-3 py-1 rounded text-white/70 hover:text-white border border-white/15"
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          <WizardStepper current={state.step} />

          {state.step === 1 && <Step1_Connect onNext={next} />}
          {state.step === 2 && (
            <Step2_Upload state={state} dispatch={dispatch} onNext={next} onBack={back} />
          )}
          {state.step === 3 && (
            <Step3_Preview state={state} dispatch={dispatch} onNext={next} onBack={back} />
          )}
          {state.step === 4 && (
            <Step4_FundUpload state={state} dispatch={dispatch} onNext={next} onBack={back} />
          )}
          {state.step === 5 && (
            <Step5_Deploy
              state={state}
              dispatch={dispatch}
              onBack={back}
            />
          )}

          {state.deployedAddress && onCreated && (
            <div className="mt-5 text-center">
              <button
                onClick={() => {
                  dispatch({ type: 'RESET' });
                  onCreated();
                }}
                className="text-[12px] text-white/70 hover:text-white underline"
              >
                Create another collection
              </button>
            </div>
          )}
        </div>
      </ArtCard>
    </m.div>
  );
}
