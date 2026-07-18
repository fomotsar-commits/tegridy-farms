// @irys/web-upload{,-ethereum} bundle the Irys SDK + ethers + arbundles + a full
// crypto stack (~1.1MB). They are imported DYNAMICALLY inside build() so that stays
// its own lazy chunk, loaded only when a user actually uploads (Step 4+ of the gated
// launchpad wizard). Pure helpers below (arweaveUri/arweaveHttpUrl) carry zero SDK
// weight, so the wizard can import them without pulling the SDK into the page chunk.

/// @irys/web-upload-ethereum accepts an EIP-1193 provider via `.withProvider()`
/// and internally wraps it as an ethers Web3Provider. wagmi's walletClient is
/// built on top of the same `window.ethereum` for injected connectors, so we
/// can share the wallet session without a separate signer handshake.
///
/// For WalletConnect / Coinbase, `window.ethereum` may not exist — the hook
/// will error up front with a clear message.

export type IrysUploader = Awaited<ReturnType<typeof buildIrysUploader>>;

/// Build a fresh Irys uploader. Not cached — each session should build once
/// per connected wallet. Caller is responsible for detecting wallet changes
/// (drop the instance and rebuild on account/chain swap).
export async function buildIrysUploader(): Promise<ReturnType<typeof build>> {
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error('No EIP-1193 provider found. Connect an injected wallet first.');
  }
  return build();
}

async function build() {
  // Lazy-load the heavy Irys SDK only at the moment an upload is initiated. This is
  // what keeps the ~1.1MB out of the launchpad page chunk (see the module header).
  const [{ WebUploader }, { WebEthereum }] = await Promise.all([
    import('@irys/web-upload'),
    import('@irys/web-upload-ethereum'),
  ]);
  // The `as any` is because WebUploader is a type Constructable, and Irys's typings
  // for Builder.build() are loose. The runtime behavior is the documented ethereum flow.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const irys = await WebUploader(WebEthereum as any).withProvider(window.ethereum);
  return irys;
}

/// Convenience: compute Arweave gateway URL for a transaction / manifest ID.
/// Irys returns raw transaction IDs — marketplaces accept either
/// `ar://<txid>` or `https://arweave.net/<txid>`. We prefer ar:// for the
/// on-chain baseURI (shorter, future-proof) and the https variant for
/// client-side previews.
export function arweaveUri(txId: string): string {
  return `ar://${txId}/`;
}

export function arweaveHttpUrl(txId: string, path = ''): string {
  const suffix = path ? `/${path.replace(/^\//, '')}` : '';
  return `https://arweave.net/${txId}${suffix}`;
}

// ─── Window type augmentation ────────────────────────────────────

// Note: `window.ethereum` is declared elsewhere in this codebase (wagmi /
// RainbowKit). We intentionally don't redeclare it here — the Irys SDK accepts
// `any` at runtime and re-declaring with a stricter type collides with the
// existing `any`-typed global.
