import { useEffect, useState } from 'react';
import type { Dispatch } from 'react';
import { parseEther } from 'viem';
import { useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { TEGRIDY_LAUNCHPAD_V2_ADDRESS, CHAIN_ID } from '../../../lib/constants';
import { TEGRIDY_LAUNCHPAD_V2_ABI } from '../../../lib/contracts';
import { getAddressUrl } from '../../../lib/explorer';
import { arweaveUri } from '../../../lib/irysClient';
import type { WizardState, WizardAction } from './wizardReducer';
import { BTN_EMERALD, LABEL } from '../launchpadConstants';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function Step5_Deploy({
  state,
  dispatch,
  onBack,
}: {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  onBack: () => void;
}) {
  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, data: receipt } =
    useWaitForTransactionReceipt({ hash: txHash });
  const [localErr, setLocalErr] = useState<string | null>(null);
  const chainId = useChainId();

  const factoryDeployed = TEGRIDY_LAUNCHPAD_V2_ADDRESS !== ZERO_ADDRESS;

  const handleDeploy = () => {
    // AUDIT FIX M-8: refuse on wrong chain so the user doesn't burn ETH
    // creating a collection on Sepolia/Base/Arbitrum where the factory
    // isn't deployed (or worse, hits a colliding contract on an L2 fork).
    if (chainId !== CHAIN_ID) {
      setLocalErr('Please switch to Ethereum Mainnet before deploying.');
      return;
    }
    if (!factoryDeployed) {
      setLocalErr(
        'V2 launchpad factory not deployed yet. Run DeployLaunchpadV2.s.sol and update TEGRIDY_LAUNCHPAD_V2_ADDRESS.'
      );
      return;
    }
    if (!state.metadataManifestId) {
      setLocalErr('Metadata manifest missing — go back to Step 4.');
      return;
    }
    setLocalErr(null);

    // F252: build the config inside the try so a malformed number-input value
    // (e.g. '1e4' / '0.0.5', both typeable in number inputs) surfaces an error
    // instead of throwing uncaught in the click handler.
    try {
      const maxSupply = BigInt(state.maxSupply || '0');
      if (maxSupply < 1n) {
        setLocalErr('Max supply must be at least 1.');
        return;
      }
      const maxPerWallet = BigInt(state.maxPerWallet || '0');
      if (maxPerWallet > maxSupply) {
        setLocalErr('Max per wallet cannot exceed max supply.');
        return;
      }
      const mintPrice = parseEther(state.mintPrice || '0');

      const cfg = {
        name: state.collectionName,
        symbol: state.collectionSymbol,
        maxSupply,
        mintPrice,
        maxPerWallet,
        royaltyBps: state.royaltyBps,
        placeholderURI: state.imagesManifestId ? arweaveUri(state.imagesManifestId) : '',
        contractURI: state.contractUriId
          ? `${arweaveUri(state.contractUriId)}contract.json`
          : '',
        merkleRoot: ('0x' + '0'.repeat(64)) as `0x${string}`,
        dutchStartPrice: 0n,
        dutchEndPrice: 0n,
        dutchStartTime: 0n,
        dutchDuration: 0n,
        initialPhase: 0, // CLOSED — owner flips to PUBLIC when ready
      };

      writeContract({
        chainId: CHAIN_ID,
        address: TEGRIDY_LAUNCHPAD_V2_ADDRESS as `0x${string}`,
        abi: TEGRIDY_LAUNCHPAD_V2_ABI,
        functionName: 'createCollection',
        args: [cfg],
      });
    } catch (e) {
      setLocalErr((e as Error).message);
    }
  };

  // Decode the CollectionCreated event log to get the clone address
  const deployedCollection = (() => {
    if (!isSuccess || !receipt?.logs) return null;
    // CollectionCreated topic: keccak256("CollectionCreated(uint256,address,address,string,string,uint256)")
    // topic1 = id (indexed), topic2 = collection (indexed), topic3 = creator (indexed)
    const log = receipt.logs.find(
      (l) => l.address.toLowerCase() === TEGRIDY_LAUNCHPAD_V2_ADDRESS.toLowerCase()
    );
    if (!log || log.topics.length < 3) return null;
    return `0x${log.topics[2]!.slice(26)}` as `0x${string}`;
  })();

  // F252: pre-validate maxSupply/maxPerWallet so the Deploy button is disabled
  // before a doomed tx. parseEther/BigInt are wrapped so a malformed input
  // (e.g. '1e4') marks the config invalid rather than throwing here.
  const configValid = (() => {
    try {
      const maxSupply = BigInt(state.maxSupply || '0');
      if (maxSupply < 1n) return false;
      const maxPerWallet = BigInt(state.maxPerWallet || '0');
      if (maxPerWallet > maxSupply) return false;
      parseEther(state.mintPrice || '0');
      return true;
    } catch {
      return false;
    }
  })();

  // F252: dispatch in an effect, not the render body — updating the parent
  // reducer during Step5's render triggers React's "cannot update a component
  // while rendering a different component" warning.
  useEffect(() => {
    if (isSuccess && deployedCollection && txHash && !state.deployedAddress) {
      dispatch({
        type: 'DEPLOY_SUCCESS',
        txHash,
        collection: deployedCollection,
      });
    }
  }, [isSuccess, deployedCollection, txHash, state.deployedAddress, dispatch]);

  return (
    <div className="space-y-5">
      <div className="rounded-xl p-4 bg-black/40 border border-white/10">
        <label className={LABEL}>Review before deploy</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 text-[12px]">
          <RowSummary k="Name" v={state.collectionName} />
          <RowSummary k="Symbol" v={state.collectionSymbol} />
          <RowSummary k="Supply" v={state.maxSupply} />
          <RowSummary k="Mint price" v={`${state.mintPrice} ETH`} />
          <RowSummary k="Max / wallet" v={state.maxPerWallet} />
          <RowSummary k="Royalty" v={`${(state.royaltyBps / 100).toFixed(1)}%`} />
          <RowSummary
            k="Images"
            v={state.imagesManifestId ? `ar://${state.imagesManifestId.slice(0, 8)}…` : '—'}
          />
          <RowSummary
            k="Metadata"
            v={state.metadataManifestId ? `ar://${state.metadataManifestId.slice(0, 8)}…` : '—'}
          />
          <RowSummary
            k="contractURI"
            v={state.contractUriId ? `ar://${state.contractUriId.slice(0, 8)}…` : '—'}
          />
          <RowSummary k="Initial phase" v="Closed (you'll open after review)" />
        </div>
      </div>

      {!factoryDeployed && (
        <div className="rounded-lg p-3 bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[12px]">
          <strong>Factory pending.</strong> TegridyLaunchpadV2 hasn't been broadcast to mainnet
          yet. The wizard is ready — ship the contract via
          <code className="mx-1 font-mono text-[11px]">DeployLaunchpadV2.s.sol</code>
          and drop the address into <code className="font-mono text-[11px]">constants.ts</code>.
        </div>
      )}

      {localErr && (
        <div className="rounded-lg p-3 bg-red-500/10 border border-red-500/30 text-red-300 text-[12px]">
          {localErr}
        </div>
      )}

      {isSuccess && deployedCollection && (
        <div className="rounded-lg p-4 bg-emerald-500/10 border border-emerald-500/30">
          <p className="text-emerald-300 text-sm font-semibold">Collection deployed</p>
          <p className="text-white/80 text-[12px] font-mono mt-1 break-all">
            {deployedCollection}
          </p>
          <a
            href={getAddressUrl(chainId, deployedCollection)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-2 text-[12px] text-emerald-400 hover:text-emerald-300 underline"
          >
            View on Etherscan ↗
          </a>
        </div>
      )}

      <div className="flex justify-between pt-4 gap-3">
        <button
          onClick={onBack}
          disabled={isPending || isConfirming}
          className="px-5 py-2 rounded-lg text-xs text-white/70 hover:text-white border border-white/15 bg-black/30 disabled:opacity-40"
        >
          ← Back
        </button>
        <button
          onClick={handleDeploy}
          disabled={isPending || isConfirming || isSuccess || !factoryDeployed || !configValid}
          className={`px-8 py-2.5 rounded-xl text-sm ${BTN_EMERALD} disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {isPending
            ? 'Confirm in wallet…'
            : isConfirming
            ? 'Deploying…'
            : isSuccess
            ? 'Deployed ✓'
            : 'Deploy Collection'}
        </button>
      </div>
    </div>
  );
}

function RowSummary({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-white/60">{k}</span>
      <span className="text-white font-mono truncate">{v}</span>
    </div>
  );
}
