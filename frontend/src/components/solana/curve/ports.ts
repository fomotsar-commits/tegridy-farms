// The contract between the /curve-launch UI and the layers it drives.
//
// The UI never imports the transaction layer (lib/launcher/solana/write, .../discover)
// or the metadata layer (lib/launchMetadata) AT RUNTIME. It receives them as ONE
// object, `WriteApi`, from `writeApi.ts`, the only file that loads them, with a
// dynamic import. Two reasons:
//   1. A production build with writes off never fetches the write code.
//   2. Every component test hands in a fake `WriteApi`, so what a panel shows for
//      each outcome is tested without a chain, a wallet or the real builders.
//
// The TYPES below are the layers' own, re-exported (type-only imports are erased
// from the bundle). `writeApi.ts` assigns the real functions into `WriteApi`, so a
// drift between the UI and either layer is a type error in exactly one place.

import type { PublicKey } from '@solana/web3.js';
import type { CurveAccount, CurveRpc, CurveTerms, GlobalConfig, LaunchState, BondingCurve, Read, SolanaRpc } from '../../../lib/launcher/solana/curve';
import type {
  CreateFacts,
  CurveWriteConfig,
  LpGate,
  LpKind,
  LpOpenGate,
  OpenGate,
  Prepared,
  PreparedTx,
  SolanaCluster,
  SubmitDeps,
  TxOutcome,
  TxSigner,
  WriteGate,
  WriteRpc,
  ActionAvailability,
} from '../../../lib/launcher/solana/write/types';
import type { GateRpc } from '../../../lib/launcher/solana/write/config';
import type { CreateLaunchInput } from '../../../lib/launcher/solana/write/launch';
import type { LpDepositArgs, LpPrepareReads, LpWithdrawArgs } from '../../../lib/launcher/solana/write/liquidity';
import type { LpCreateArgs } from '../../../lib/launcher/solana/write/createPool';
import type { PlantBalance } from '../../../lib/launcher/solana/write/plant';
import type { LaunchPool, LaunchPoolRead } from '../../../lib/launcher/solana/discover/pool';
import type { TokenMetadata } from '../../../lib/launcher/solana/discover/metadata';
import type { LaunchListItem, LaunchListPage, LaunchOrigin } from '../../../lib/launcher/solana/discover/list';
import type {
  LIMITS,
  checkContentUri,
  checkDescription,
  checkLinks,
  checkName,
  checkSymbol,
  displaySafe,
  impersonationWarning,
} from '../../../lib/launchMetadata/validate.js';
import type {
  MetadataRead,
  PreparedImageResult,
  UploadInput,
  UploadResult,
  UploadStatus,
} from '../../../lib/launchMetadata/upload';
import type { quoteBuyOnCurve } from '../../../lib/launcher/solana/curve';

export type {
  ActionAvailability,
  CreateFacts,
  CurveWriteConfig,
  FeeAccountState,
  FeeSplitView,
  GateBlock,
  LpGate,
  LpKind,
  LpOpenGate,
  GraduationReadiness,
  NotSent,
  OpenGate,
  Prepared,
  PreparedTx,
  SimulatedEffect,
  SolanaCluster,
  SubmitDeps,
  TierState,
  TierTerms,
  TokenRole,
  TxKind,
  TxOutcome,
  TxSigner,
  TxSummary,
  WriteGate,
  WriteRpc,
} from '../../../lib/launcher/solana/write/types';
export type { GateRpc, CreateLaunchInput, PlantBalance, LaunchPool, LaunchPoolRead, TokenMetadata, LaunchListItem, LaunchListPage, LaunchOrigin };
export type { LpCreateArgs, LpDepositArgs, LpPrepareReads, LpWithdrawArgs };
export type { Checked, ImageMime, LaunchLinks, LaunchMetadataJson, ReadLaunchMetadata } from '../../../lib/launchMetadata/validate.js';
export type { MetadataRead, PreparedImage, PreparedImageResult, UploadInput, UploadResult } from '../../../lib/launchMetadata/upload';

// ── metadata (set M) ─────────────────────────────────────────────────────────

export interface MetadataApi {
  LIMITS: typeof LIMITS;
  checkName: typeof checkName;
  checkSymbol: typeof checkSymbol;
  checkDescription: typeof checkDescription;
  checkLinks: typeof checkLinks;
  checkContentUri: typeof checkContentUri;
  displaySafe: typeof displaySafe;
  impersonationWarning: typeof impersonationWarning;
  uploadsAvailable(): Promise<UploadStatus>;
  /** Shrinks a photo to at most 1024px and strips its EXIF (GPS). GIFs are kept as they are. */
  prepareLaunchImage(file: Blob): Promise<PreparedImageResult>;
  uploadLaunchMetadata(input: UploadInput): Promise<UploadResult>;
  readLaunchMetadataJson(uri: string, expectedMint: string): Promise<MetadataRead>;
}

// ── the one object the UI drives ─────────────────────────────────────────────

export type OpeningBuyQuote = ReturnType<typeof quoteBuyOnCurve>;

export interface WriteApi {
  curveWriteConfig(): CurveWriteConfig | null;
  readWriteGate(rpc: GateRpc, cfg: CurveWriteConfig | null): Promise<WriteGate>;
  writeActions(
    gate: WriteGate,
    launch: LaunchState | null,
    opts?: { migrationEligible?: boolean },
  ): ActionAvailability;
  explorerTxUrl(signature: string, cluster: SolanaCluster): string;

  quoteOpeningBuy(global: GlobalConfig, lamportsIn: bigint): OpeningBuyQuote;
  priceImpactBps(c: CurveTerms, side: 'buy' | 'sell', amountIn: bigint, amountOut: bigint): bigint | null;

  prepareCreateLaunch(rpc: WriteRpc, gate: OpenGate, input: CreateLaunchInput): Promise<Prepared>;
  /** What the maker's own $BAYLA account holds: the plant spends from it. A failed read is never 0. */
  readPlantBalance(rpc: WriteRpc, owner: PublicKey): Promise<Read<PlantBalance>>;
  /** Every plant refusal the launch build makes, in its words, read now; null = can plant. */
  readPlantRefusal(rpc: WriteRpc, maker: PublicKey): Promise<string | null>;
  prepareCurveBuy(
    rpc: WriteRpc,
    gate: OpenGate,
    a: { trader: PublicKey; mint: PublicKey; curve: CurveAccount; lamportsIn: bigint; slippageBps: bigint },
  ): Promise<Prepared>;
  prepareCurveSell(
    rpc: WriteRpc,
    gate: OpenGate,
    a: {
      trader: PublicKey;
      mint: PublicKey;
      curve: CurveAccount;
      curveRentFloor: bigint;
      tokensIn: bigint;
      slippageBps: bigint;
    },
  ): Promise<Prepared>;
  prepareMigrate(rpc: WriteRpc, gate: OpenGate, a: { payer: PublicKey; mint: PublicKey; curve: CurveAccount }): Promise<Prepared>;
  preparePoolSwap(
    rpc: WriteRpc,
    gate: OpenGate,
    a: { owner: PublicKey; mint: PublicKey; pool: LaunchPool; side: 'buy' | 'sell'; amountIn: bigint; slippageBps: bigint },
  ): Promise<Prepared>;

  submitPrepared(rpc: WriteRpc, signer: TxSigner, p: PreparedTx, deps?: SubmitDeps): Promise<TxOutcome>;
  /**
   * With `lastValidBlockHeight`, a signature with no record past that height is `expired` (safe to retry).
   * With `cfg` and a liquidity `kind`, a refusal is said in that kind's words (useTxFlow passes them for LP kinds only).
   */
  recheckOutcome(rpc: WriteRpc, signature: string, opts?: { lastValidBlockHeight?: number; cfg?: CurveWriteConfig; kind?: LpKind }): Promise<TxOutcome>;

  readTokenMetadata(rpc: CurveRpc, mint: PublicKey): Promise<Read<TokenMetadata>>;
  /** Anyone can appear in this list. The page must say so. */
  listRecentLaunches(rpc: SolanaRpc, cfg: CurveWriteConfig, opts?: { limit?: number; before?: string }): Promise<Read<LaunchListPage>>;
  /** Launches a wallet created, from that wallet's own history. */
  listLaunchesByCreator(
    rpc: SolanaRpc,
    cfg: CurveWriteConfig,
    creator: PublicKey,
    opts?: { limit?: number; before?: string },
  ): Promise<Read<LaunchListPage>>;
  /** The launch transaction of a mint, with the creator's opening buy. */
  readLaunchOrigin(rpc: SolanaRpc, cfg: CurveWriteConfig, mint: PublicKey): Promise<Read<LaunchOrigin>>;
  /** Tokens in the creator's main token account now. No account = 0 there. */
  readCreatorHolding(rpc: CurveRpc, mint: PublicKey, creator: PublicKey): Promise<Read<{ amount: bigint; accountExists: boolean }>>;
  readLaunchPool(
    rpc: CurveRpc,
    cfg: CurveWriteConfig,
    mint: PublicKey,
    curve: BondingCurve,
    global: GlobalConfig,
  ): Promise<LaunchPoolRead>;

  meta: MetadataApi;
}

// ── what the review needs, and the pools page's own write API ───────────────

/** What `TxFlowView` uses: the explorer link and the display-safe text rule. Both APIs satisfy it. */
export type TxViewApi = Pick<WriteApi, 'explorerTxUrl'> & { meta: Pick<MetadataApi, 'displaySafe'> };

/**
 * Adding and removing liquidity, and opening a pool, on /pools. A sibling of `WriteApi`,
 * loaded by its own file (`components/solana/lp/lpWriteApi.ts`), so the pools page never
 * downloads the launch page's upload and metadata clients (spec D19).
 */
export interface LpWriteApi {
  lpWriteConfig(): CurveWriteConfig | null;
  readLpGate(rpc: GateRpc, cfg: CurveWriteConfig | null): Promise<LpGate>;
  /** The public fee tier and the fee account, read beside the gate and never inside it. Never throws. */
  readCreateFacts(rpc: GateRpc, cfg: CurveWriteConfig): Promise<CreateFacts>;
  prepareLpDeposit(rpc: WriteRpc, gate: LpOpenGate, reads: LpPrepareReads, a: LpDepositArgs): Promise<Prepared>;
  prepareLpWithdraw(rpc: WriteRpc, gate: LpOpenGate, a: LpWithdrawArgs): Promise<Prepared>;
  prepareLpCreate(rpc: WriteRpc, gate: LpOpenGate, reads: LpPrepareReads, a: LpCreateArgs): Promise<Prepared>;
  submitPrepared(rpc: WriteRpc, signer: TxSigner, p: PreparedTx, deps?: SubmitDeps): Promise<TxOutcome>;
  /** As `WriteApi.recheckOutcome`: with `cfg` and a liquidity `kind`, a refusal is said in that kind's words. */
  recheckOutcome(rpc: WriteRpc, signature: string, opts?: { lastValidBlockHeight?: number; cfg?: CurveWriteConfig; kind?: LpKind }): Promise<TxOutcome>;
  explorerTxUrl(signature: string, cluster: SolanaCluster): string;
  meta: Pick<MetadataApi, 'displaySafe'>;
}
