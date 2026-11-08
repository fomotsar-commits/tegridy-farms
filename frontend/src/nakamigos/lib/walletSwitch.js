// Asks the connected wallet to switch chains. Loaded on use, the way api.js
// reaches wagmi, so a panel needs no wagmi provider to render.
export async function askWalletToSwitch(chainId) {
  try {
    const [{ switchChain }, { config }] = await Promise.all([import("wagmi/actions"), import("../../lib/wagmi")]);
    await switchChain(config, { chainId });
  } catch {
    // Declined or not supported: the caller already said what to do.
  }
}
