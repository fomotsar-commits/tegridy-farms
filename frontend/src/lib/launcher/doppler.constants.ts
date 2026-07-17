// Doppler (Whetstone Research) canonical deployment — Ethereum mainnet.
//
// PROVENANCE: every address below was read live from the canonical
// Deployments.md and then VERIFIED on-chain via `Airlock.getModuleState(addr)`
// against the mainnet Airlock on 2026-07-17 (block 25553318). The module-state
// column is what the Airlock itself returns — a launch physically cannot use a
// module that is not whitelisted in the correct role, so these states are the
// ground truth for "can we launch through this today" (answer: yes).
//
// Doppler core is BUSL-1.1 (no production fork until >=2027-12-31). We INTEGRATE
// the deployed contracts — we never redeploy them. See docs/LAUNCHER_STRATEGY.md.

import type { Address } from 'viem';

/** ModuleState enum as defined in Airlock.sol. */
export enum DopplerModuleState {
  NotWhitelisted = 0,
  TokenFactory = 1,
  GovernanceFactory = 2,
  PoolInitializer = 3,
  LiquidityMigrator = 4,
}

/**
 * Ethereum mainnet (chainId 1) canonical Doppler addresses.
 * `verifiedState` is the on-chain `getModuleState` result captured 2026-07-17.
 */
export const DOPPLER_MAINNET = {
  chainId: 1,

  /** Single entrypoint. `create()` (launch) and `migrate()` (graduate) live here. */
  airlock: '0xde3599a2ec440b296373a983c85c365da55d9dfa' as Address,
  /** The module-whitelisting authority (Whetstone multisig). Petition target for a custom migrator. */
  airlockOwner: '0x21E2ce70511e4FE542a97708e89520471DAa7A66' as Address,

  modules: {
    // TokenFactory (state 1) — the anti-rug token template we want.
    dopplerErc20V1Factory: {
      address: '0x89c261c05b5f9b6bcba07c199b8dee7cfad45292' as Address,
      verifiedState: DopplerModuleState.TokenFactory,
    },
    cloneErc20Factory: {
      address: '0xe7df2a4520c26a2d4dedb3a7585bfbcd30eaba6e' as Address,
      verifiedState: DopplerModuleState.TokenFactory,
    },
    // GovernanceFactory (state 2).
    governanceFactory: {
      address: '0x9f309d79bee3e8b2f56facf74b7195df176c8f61' as Address,
      verifiedState: DopplerModuleState.GovernanceFactory,
    },
    noOpGovernanceFactory: {
      address: '0xddae8b3ed08184682f7bc32b74d943ceefeab638' as Address,
      verifiedState: DopplerModuleState.GovernanceFactory,
    },
    // PoolInitializer (state 3) — V4-native launch curves.
    uniswapV4Initializer: {
      address: '0x53b4c21a6cb61d64f636abbfa6e8e90e6558e8ad' as Address,
      verifiedState: DopplerModuleState.PoolInitializer,
    },
    uniswapV4ScheduledMulticurveInitializer: {
      address: '0xf84378c9f39e0ff267f3101c88773359c5393876' as Address,
      verifiedState: DopplerModuleState.PoolInitializer,
    },
    // LiquidityMigrator (state 4) — V4-native graduation.
    uniswapV4Migrator: {
      address: '0x0820a4d0173c17ece283f7bdaaf0f8876eb205f5' as Address,
      verifiedState: DopplerModuleState.LiquidityMigrator,
    },
    uniswapV2Migrator: {
      address: '0x765875bff87614ce0581ee73b9fa663b71f3dff2' as Address,
      verifiedState: DopplerModuleState.LiquidityMigrator,
    },
  },

  /** Non-module supporting contracts (implementations / periphery). */
  support: {
    /** The safe token implementation the TokenFactory clones (see DopplerERC20V1.sol). */
    dopplerErc20V1Impl: '0xdb7b520bb5c3a2c5d4871198081911359f93be87' as Address,
    dopplerDeployer: '0xb35469ee64a87afd19b31615094fe3962d73e421' as Address,
    /** Holds+streams graduated-pool LP fees to configured beneficiaries (>=5% to Doppler enforced). */
    streamableFeesLocker: '0xe24fc2f7191e850e2d4514abb4d39305b1871ec6' as Address,
    streamableFeesLockerV2: '0xce3212e6536f33cd6fbfee265224131353ca3d47' as Address,
    uniswapV4MigratorHook: '0x4053d4fa966cbdcc20ec62070ac8814de8bee500' as Address,
    quoter: '0xfd44b773b21ac485c95db1ff38554b7699f8c042' as Address,
  },
} as const;

/**
 * Minimal Airlock ABI fragment for the reads/writes we actually use.
 * (`getModuleState` for verification; `create`/`migrate` shapes are added in the
 * SDK-spike task — we integrate via the official SDK rather than hand-rolling
 * the giant CreateParams tuple.)
 */
export const AIRLOCK_ABI = [
  {
    type: 'function',
    name: 'getModuleState',
    stateMutability: 'view',
    inputs: [{ name: 'module', type: 'address' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

/** Set of token-factory addresses whose output we treat as a known-safe template. */
export const KNOWN_SAFE_TOKEN_FACTORIES: ReadonlySet<string> = new Set(
  [
    DOPPLER_MAINNET.modules.dopplerErc20V1Factory.address,
  ].map((a) => a.toLowerCase()),
);
