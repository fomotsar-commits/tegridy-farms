import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { BTN_EMERALD } from '../launchpadConstants';

export function Step1_Connect({ onNext }: { onNext: () => void }) {
  const { isConnected } = useAccount();
  return (
    <div className="text-center py-10">
      <h3 className="heading-luxury text-lg text-white mb-3">Connect your wallet</h3>
      <p className="text-white/70 text-[13px] mb-6 max-w-md mx-auto">
        Your wallet pays for permanent Arweave storage (≈ $10–15 for 5555 images) and signs
        the collection deploy. One session, two signatures total.
      </p>
      <div className="flex justify-center mb-6">
        <ConnectButton />
      </div>
      <button
        disabled={!isConnected}
        onClick={onNext}
        className={`px-8 py-2.5 rounded-xl text-sm ${BTN_EMERALD} disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {isConnected ? 'Continue →' : 'Connect to continue'}
      </button>
    </div>
  );
}
