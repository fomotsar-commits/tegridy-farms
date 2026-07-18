// Thin SIGNING wrapper over dbc.ts's pure param descriptors.
//
// dbc.ts is a pure param builder (type-only SDK import, zero runtime SDK weight).
// THIS module is the out-of-band operator layer the README describes: it pulls in
// the REAL @meteora-ag SDK, maps dbc.ts's base58/bigint descriptors to web3.js
// `PublicKey` / anchor `BN` at the edge, and calls the SDK to build the on-chain
// transactions. It never bundles into the gated wizard page (the page imports
// only dbc.ts); it is imported by the operator's signing script.
//
// HARD invariants enforced here (Murphy's-law, block-0):
//   • Every entry point asserts `isSolanaLauncherEnabled()` and throws if the
//     launcher is gated — the submit path is unreachable while the flag is false.
//   • Vault-involved ops (createPartnerConfig, claimPartnerFees) additionally
//     re-affirm the fee authority via `asSquadsVault` (shape) AND verify it
//     on-chain via `verifySquadsVault` BEFORE building the tx — the off-chain brand
//     alone is not proof of multisig custody. Because the Squads v4 vault PDA is
//     SYSTEM-owned (see squads.ts), verification needs the vault's PROVENANCE
//     (parent multisig + vault index); the caller supplies it as `vaultProvenance`,
//     a map keyed by the vault address. We derive the canonical vault PDA from that
//     provenance, require the fee address to equal it, and confirm the multisig is
//     Squads-owned. Missing provenance for any vault throws (fail-closed).
//   • No real `feeClaimer` / receiver is hardcoded — the caller supplies affirmed
//     Squads vaults through the dbc.ts descriptors + their provenance here.
//
// The SDK methods return an unsigned web3.js `Transaction`. These wrappers
// partial-sign the EPHEMERAL keypairs they own (the fresh config / base-mint
// keypair, which are `signer: true` accounts), then hand the tx to the passed-in
// wallet signer (if it exposes `signTransaction`) or return it for the operator
// to co-sign and send. The wallet/payer and the ephemeral keypair BOTH sign.

import { buildCurveWithMarketCap, type DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { BN } from '@coral-xyz/anchor';
import { PublicKey, type Keypair, type Transaction } from '@solana/web3.js';
import {
  asSquadsVault,
  isSolanaLauncherEnabled,
  U64_MAX,
  type DbcClaimPartnerFeesParams,
  type DbcLaunchParams,
  type DbcPartnerConfig,
} from './dbc';
import { verifySquadsVault } from './squads';

/**
 * A wallet/keypair that can co-sign the built transaction. Mirrors the
 * wallet-adapter `signTransaction` shape; when absent, the caller co-signs the
 * returned tx out-of-band (e.g. inside a Squads proposal flow).
 */
export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
}

/**
 * Provenance for a Squads v4 vault address — the parent multisig + vault index the
 * address derives from. Required to verify the address is a genuine vault PDA (which
 * is System-owned and so cannot be verified from the address alone). See squads.ts.
 */
export interface SquadsVaultProvenance {
  multisig: string;
  vaultIndex: number;
}

/** Map of vault address → its provenance. The caller supplies one entry per vault used. */
export type VaultProvenanceMap = Record<string, SquadsVaultProvenance>;

function assertEnabled(op: string): void {
  if (!isSolanaLauncherEnabled()) {
    throw new Error(`Solana launcher is gated (SOLANA_LAUNCHER_ENABLED=false) — refusing to ${op}`);
  }
}

function provenanceFor(map: VaultProvenanceMap, addr: string, label: string): SquadsVaultProvenance {
  const p = map[addr];
  if (!p) {
    throw new Error(
      `missing Squads vault provenance (multisig + vaultIndex) for ${label} ${addr} — cannot verify vault custody`,
    );
  }
  return p;
}

/**
 * Re-affirm + on-chain-verify a fee authority is the Squads v4 vault PDA of a real
 * multisig (multisig-custodied, can sign the claim), not an EOA or a look-alike.
 * Throws on a non-vault so accrued fees can never be custodied by a single key.
 */
async function assertSquadsVaultOnChain(
  client: DynamicBondingCurveClient,
  label: string,
  addr: string,
  prov: SquadsVaultProvenance,
): Promise<void> {
  asSquadsVault(addr); // shape/affirmation (rejects empty / malformed / system pubkey)
  const ok = await verifySquadsVault(client.connection, {
    address: addr,
    multisig: prov.multisig,
    vaultIndex: prov.vaultIndex,
  });
  if (!ok) {
    throw new Error(
      `${label} (${addr}) is not the Squads v4 vault PDA of multisig ${prov.multisig} (index ${prov.vaultIndex}). ` +
        'Refusing to build: the fee authority must be a multisig-custodied vault that can sign the claim, never an EOA or a look-alike.',
    );
  }
}

async function finishSigning(
  tx: Transaction,
  signer: WalletSigner | undefined,
  ephemeral: Keypair[],
): Promise<Transaction> {
  // The ephemeral keypairs (config / base-mint) are `signer: true` accounts the
  // wrapper owns — partial-sign them here.
  if (ephemeral.length > 0) {
    tx.partialSign(...ephemeral);
  }
  // Wallet/payer co-signs if it can; otherwise return for out-of-band co-signing.
  if (signer?.signTransaction) {
    return signer.signTransaction(tx);
  }
  return tx;
}

// ── 1) Partner config-key (once per fee policy) ───────────────────────────────

/**
 * Build (and partial-sign) the `createConfig` transaction for a reusable DBC
 * partner config key.
 *
 * PRECONDITION: `verifySquadsVault` MUST pass for `feeClaimer` and
 * `leftoverReceiver` — enforced here on-chain before the tx is built.
 *
 * Maps the base58 account descriptors → `PublicKey`, runs
 * `buildCurveWithMarketCap(curve)` → `ConfigParameters`, and calls
 * `client.partner.createConfig`. `configKeypair` is the fresh config-key account
 * (a `signer: true` account) and is partial-signed here; its pubkey MUST equal
 * `partnerConfig.accounts.config`.
 */
export async function createPartnerConfig(
  client: DynamicBondingCurveClient,
  partnerConfig: DbcPartnerConfig,
  signer: WalletSigner | undefined,
  configKeypair: Keypair,
  vaultProvenance: VaultProvenanceMap,
): Promise<Transaction> {
  assertEnabled('create a partner config');
  const { curve, accounts } = partnerConfig;

  if (configKeypair.publicKey.toBase58() !== accounts.config) {
    throw new Error(
      `configKeypair pubkey (${configKeypair.publicKey.toBase58()}) does not match the descriptor config (${accounts.config})`,
    );
  }

  await assertSquadsVaultOnChain(
    client,
    'feeClaimer',
    accounts.feeClaimer,
    provenanceFor(vaultProvenance, accounts.feeClaimer, 'feeClaimer'),
  );
  await assertSquadsVaultOnChain(
    client,
    'leftoverReceiver',
    accounts.leftoverReceiver,
    provenanceFor(vaultProvenance, accounts.leftoverReceiver, 'leftoverReceiver'),
  );

  const configParams = buildCurveWithMarketCap(curve); // pure → ConfigParameters

  const tx = await client.partner.createConfig({
    config: new PublicKey(accounts.config),
    feeClaimer: new PublicKey(accounts.feeClaimer),
    leftoverReceiver: new PublicKey(accounts.leftoverReceiver),
    quoteMint: new PublicKey(accounts.quoteMint),
    payer: new PublicKey(accounts.payer),
    ...configParams,
  });

  return finishSigning(tx, signer, [configKeypair]);
}

// ── 2) Launch a token against a config key ────────────────────────────────────

/**
 * Build (and partial-sign) the `createPool` transaction that launches a token
 * against an existing partner config key. No vault is involved at this step (the
 * config key already encodes the fee authority), so only the feature gate is
 * enforced here.
 *
 * VAULT GUARANTEE (L4): `createPool` inherits its fee authority from the referenced
 * config key, whose `feeClaimer` was vault-verified at `createPartnerConfig` time.
 * This wrapper therefore does NOT re-verify it (that would require an extra fetch of
 * the config account). The guarantee holds ONLY when the config was created via
 * `createPartnerConfig` in THIS wrapper; launching against a config built out-of-band
 * inherits whatever fee authority that config baked in. Operators must only launch
 * against configs created through `createPartnerConfig`.
 *
 * `baseMintKeypair` is the fresh base-mint account (`signer: true`) and is
 * partial-signed here; its pubkey MUST equal `launchParams.baseMint`.
 */
export async function launchToken(
  client: DynamicBondingCurveClient,
  launchParams: DbcLaunchParams,
  signer: WalletSigner | undefined,
  baseMintKeypair: Keypair,
): Promise<Transaction> {
  assertEnabled('launch a token');

  if (baseMintKeypair.publicKey.toBase58() !== launchParams.baseMint) {
    throw new Error(
      `baseMintKeypair pubkey (${baseMintKeypair.publicKey.toBase58()}) does not match the descriptor baseMint (${launchParams.baseMint})`,
    );
  }

  // createPool is on the CreatorService (client.creator), not PoolService.
  const tx = await client.creator.createPool({
    name: launchParams.name,
    symbol: launchParams.symbol,
    uri: launchParams.uri,
    config: new PublicKey(launchParams.config),
    baseMint: new PublicKey(launchParams.baseMint),
    poolCreator: new PublicKey(launchParams.poolCreator),
    payer: new PublicKey(launchParams.payer),
  });

  return finishSigning(tx, signer, [baseMintKeypair]);
}

// ── 3) Claim partner trading fees (to the vault, never an EOA) ─────────────────

/**
 * Build (and, if the signer can, sign) the partner trading-fee claim.
 *
 * PRECONDITION: `verifySquadsVault` MUST pass for BOTH `feeClaimer` and
 * `receiver` — enforced here on-chain. The claim signer has full custody and
 * could otherwise redirect fees to an EOA; uses `claimPartnerTradingFeeToReceiver`
 * (explicit, required receiver) so the destination is never implicit. `bigint`
 * amounts are mapped to anchor `BN` at the edge.
 */
export async function claimPartnerFees(
  client: DynamicBondingCurveClient,
  claimParams: DbcClaimPartnerFeesParams,
  signer: WalletSigner | undefined,
  vaultProvenance: VaultProvenanceMap,
): Promise<Transaction> {
  assertEnabled('claim partner fees');

  // Re-assert u64 bounds at the edge (L3): dbc.claimPartnerFeesParams enforces these,
  // but an operator-built params object could bypass it — mirror the vault re-affirmation.
  for (const [label, v] of [
    ['maxBaseAmount', claimParams.maxBaseAmount],
    ['maxQuoteAmount', claimParams.maxQuoteAmount],
  ] as const) {
    if (v < 0n || v > U64_MAX) {
      throw new Error(`${label} must be in [0, U64_MAX], got ${v}`);
    }
  }

  await assertSquadsVaultOnChain(
    client,
    'feeClaimer',
    claimParams.feeClaimer,
    provenanceFor(vaultProvenance, claimParams.feeClaimer, 'feeClaimer'),
  );
  await assertSquadsVaultOnChain(
    client,
    'receiver',
    claimParams.receiver,
    provenanceFor(vaultProvenance, claimParams.receiver, 'receiver'),
  );

  const tx = await client.partner.claimPartnerTradingFeeToReceiver({
    feeClaimer: new PublicKey(claimParams.feeClaimer),
    payer: new PublicKey(claimParams.payer),
    pool: new PublicKey(claimParams.pool),
    receiver: new PublicKey(claimParams.receiver),
    maxBaseAmount: new BN(claimParams.maxBaseAmount.toString()),
    maxQuoteAmount: new BN(claimParams.maxQuoteAmount.toString()),
  });

  // No ephemeral keypair to partial-sign for a claim.
  return finishSigning(tx, signer, []);
}
