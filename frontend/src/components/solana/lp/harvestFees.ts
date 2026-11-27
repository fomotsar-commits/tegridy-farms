// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../../../lib/solanaPolyfill';
import { Connection, PublicKey } from '@solana/web3.js';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
// Harvest's pool fees (owner, 2026-11-20: "including the lp fees claim with the staking in
// harvest"): the fees a wallet's shares of an island coin's classic pools earned, claimed from
// the Harvest card beside the staking rewards (lib/harvest/solana.ts). Loaded by HarvestCard
// once a Solana wallet is connected, after the staking read, like that read.
//
// EVERY CLAIM IS THE POOLS ROW'S OWN (YourPositions.tsx + RemoveLiquidityPanel.tsx `claim`):
// offered where that row would offer Claim fees (offers.ts withdrawOffer, then feeClaim.ts), and
// sent as that panel sends it: the pool program's ordinary withdraw of just the shares the fees
// added (write/liquidity.ts prepareLpWithdraw, which reads the pool again and test-runs it), then
// submitPrepared (the wallet signs only; we send). One transaction, one wallet approval each
// (Phantom, ticket #467471). A claim sent is noted (claimed.ts) and kept in the pending notes
// (pendingTrade.ts) the way the panel's flow keeps them, so neither page offers it twice.
//
// ISLAND COINS ONLY: a share of a pool whose token is a Solana room's coin (BAYLA, BOBO, …).
// Harvest is the island's pools; a share of any other pool is claimed on Pools.
import { browserCurveRpc, browserRpc } from '../../../lib/launcher/solana/curve/rpc';
import { PROGRAM_ID as LAUNCH_PROGRAM_ID } from '../../../lib/launcher/solana/curve/program';
import { clipDetail } from '../../../lib/launcher/solana/curve/read';
import { lpWriteMode, type LpWriteMode } from '../../../lib/launcher/solana/lpWriteFlag';
import { txVersionOf } from '../../../lib/launcher/solana/write/txVersion';
import { LIVE_PROGRAM_ID } from '../../../lib/solana/cpswap/program';
import { claimSentOn, dropClaimSent, noteClaimSent } from '../../../lib/solana/lp/claimed';
import { feeClaimOf } from '../../../lib/solana/lp/feeClaim';
import { readLedger, type LedgerRead, type Share } from '../../../lib/solana/lp/ledger';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { lastTrade } from '../../../lib/solana/lp/poolPast';
import { readPositions, type Position, type PositionsRead } from '../../../lib/solana/lp/positions';
import { lpFetch } from '../../../lib/solana/lp/readFetch';
import { noteResponse } from '../../../lib/solana/lp/rpcBudget';
import { readTokenSafety, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { feeNow } from '../../../lib/solana/lp/transferFee';
import { DECLINED_IN_WALLET } from '../../../lib/solana/swap/walletCopy';
import { v1SignerOf } from '../../../lib/solana/v1Signer';
import { solanaRpcEndpoint } from '../../../lib/solana';
import { holdReload } from '../../../lib/reloadHold';
import { BUNGALOWS } from '../../../lib/bungalows';
import type { SolanaClaim } from '../../../lib/harvest/solana';
import type { ClaimResult, HarvestPlan, HarvestUnread } from '../../../lib/harvest/types';
import { withReadCommitment } from '../curve/confirmedRpc';
import { browserGateRpc } from '../curve/gateRpc';
import { LP_PENDING_SCOPE, clearPendingTrade, readPendingTrades, savePendingTrade, type PendingTrade } from '../curve/pendingTrade';
import type { LpClaimBasis, LpGate, LpOpenGate, LpWriteApi, TxOutcome, TxSigner, WriteRpc } from '../curve/ports';
import { DEFAULT_SLIPPAGE_BPS } from '../curve/uiFormat';
import { loadLpWriteApi } from './lpWriteApi';
import { lpHeld, withdrawOffer } from './offers';

type Plan = HarvestPlan<SolanaClaim>;

/** The two calls a claim makes: the build (fresh reads and the test run) and the send. */
export type FeeApi = Pick<LpWriteApi, 'prepareLpWithdraw' | 'submitPrepared'>;

/** Everything the fee read reads, behind one interface so a test can hand in its own answers. */
export interface FeeReads {
  /** The pool program the positions are read from; the gate must open on the same one. */
  programId: string;
  mode: LpWriteMode;
  positions(owner: PublicKey): Promise<PositionsRead>;
  safety(mints: string[]): Promise<Map<string, TokenSafety>>;
  ledger(share: Share, view: PoolView): Promise<LedgerRead>;
  /** The write code and the LP gate: loaded only once a share of an island coin's pool is found. */
  writes(): Promise<{ api: FeeApi; gate: LpGate }>;
  /** The liquidity changes this browser sent and has no answer for yet. */
  notes(): PendingTrade[];
  /** The connection a claim is built and sent on. */
  rpc(): WriteRpc;
}

interface Room { id: string; symbol: string; address: string }

/** The island's Solana coins: a pool whose token is one of these is an island pool. */
export function islandRooms(): Room[] {
  return BUNGALOWS.filter((b) => b.live && b.chain === 'solana' && Boolean(b.address)).map((b) => ({ id: b.id, symbol: b.symbol, address: b.address! }));
}

/** A claim's answer from the send path's outcome. A cancel in the wallet stops the run; so does a sent claim whose outcome is unknown. */
export function feeClaimResult(o: TxOutcome): ClaimResult {
  switch (o.status) {
    case 'confirmed':
      return { kind: 'claimed', tx: o.signature };
    case 'reverted':
      return { kind: 'reverted', reason: o.message, tx: o.signature };
    case 'expired':
      // The network has no record of it: nothing happened, and there is no transaction to link to.
      return { kind: 'unconfirmed', reason: o.message };
    case 'unknown':
      return { kind: 'unconfirmed', reason: o.message, ...(o.signature ? { tx: o.signature } : {}), stop: true };
    case 'not-sent':
      return o.message === DECLINED_IN_WALLET ? { kind: 'declined' } : { kind: 'unconfirmed', reason: o.message };
  }
}

/**
 * The connected wallet as the send path's signer, as useCurveSigner.ts hands it to the panels:
 * its own functions, called only by submitPrepared (submit.ts), which reads the wallet's throw.
 * It signs only, never sends. Null with no address.
 */
export function txSignerOf(adapter: SignerWalletAdapter): TxSigner | null {
  const publicKey = adapter.publicKey;
  if (!publicKey) return null;
  const signV1 = v1SignerOf(adapter, publicKey);
  return { publicKey, signTransaction: adapter.signTransaction.bind(adapter), ...(signV1 ? { signV1 } : {}) };
}

/**
 * One share's claim, as the Pools panel sends it: built at a fresh read of the pool and the
 * share (refused if the shares changed, or a claim was already sent on this balance), test-run,
 * put to the wallet once, sent by us. Never throws.
 */
export async function sendFeeClaim(a: {
  api: FeeApi;
  rpc: WriteRpc;
  gate: LpOpenGate;
  signer: TxSigner;
  owner: PublicKey;
  view: PoolView;
  lpAccount: string;
  basis: LpClaimBasis;
}): Promise<ClaimResult> {
  const { api, rpc, gate, signer, view, lpAccount, basis } = a;
  let outcome: TxOutcome;
  let sentSignature: string | null = null;
  try {
    const built = await api.prepareLpWithdraw(rpc, gate, {
      owner: a.owner,
      txVersion: txVersionOf(signer),
      pool: new PublicKey(view.address),
      tokenMint: new PublicKey(view.tokenMint),
      quoteMint: new PublicKey(view.quote.mint),
      lpAccount: new PublicKey(lpAccount),
      slippageBps: DEFAULT_SLIPPAGE_BPS,
      claim: basis,
    });
    if (!built.ok) return feeClaimResult(built.outcome);
    // From the wallet's turn to the answer the page does not reload itself (lib/staleBuild.ts).
    const release = holdReload();
    try {
      outcome = await api.submitPrepared(rpc, signer, built.prepared, {
        onSent: (signature, lastValidBlockHeight) => {
          sentSignature = signature;
          // It may land from here on, even if this tab closes: noted before the first send.
          noteClaimSent(lpAccount, basis.heldAtRead);
          savePendingTrade(LP_PENDING_SCOPE, { kind: 'lp-withdraw', signature, lastValidBlockHeight, pool: view.address });
        },
      });
    } finally {
      release();
    }
  } catch (e) {
    // We cannot say whether anything was sent, so this is unknown, never "failed".
    outcome = sentSignature
      ? { status: 'unknown', signature: sentSignature, message: `We lost track of this claim (${clipDetail(e)}). Check your wallet's activity before trying again.` }
      : { status: 'not-sent', stage: 'build', message: `This claim could not be put together (${clipDetail(e)}). Nothing was sent.` };
  }
  // The pending note and the claim note follow the answer, as the panel's flow keeps them.
  const sig = ('signature' in outcome && outcome.signature) || sentSignature;
  if (outcome.status !== 'unknown') {
    if (sig) clearPendingTrade(LP_PENDING_SCOPE, sig);
    if (outcome.status !== 'confirmed') dropClaimSent(lpAccount, basis.heldAtRead);
  }
  return feeClaimResult(outcome);
}

const empty = (): Plan => ({ claims: [], held: [], unread: [] });

/**
 * The wallet's shares of island coins' pools with fees to claim, each one claim. A share whose
 * fees could not be worked out because a read failed is named as not read, never as nothing to
 * claim; one whose history is longer than one page is left alone, for Pools, where its next page
 * can be read. Shares the Pools row offers no claim on (nothing grown yet, a pool no trade has
 * reached, a withdrawal still pending, a pool that is switched off) are not listed.
 *
 * Histories are read one share at a time, behind the LP budget gate (rpcBudget.ts), as the
 * Pools list reads them: each is a page of signatures and up to twenty transactions.
 */
export async function readFeeHarvest(owner: string, reads: FeeReads | null = browserFeeReads()): Promise<Plan> {
  const plan = empty();
  if (!reads || reads.mode === 'off') return plan;
  const ownerKey = new PublicKey(owner);
  const unreadAll = (key: string, what: string, detail: string): Plan => {
    plan.unread.push({ key, chain: 'solana', roomId: '', what, detail });
    return plan;
  };

  let read: PositionsRead;
  try {
    read = await reads.positions(ownerKey);
  } catch (e) {
    read = { kind: 'unread', detail: clipDetail(e) };
  }
  if (read.kind === 'unread') return unreadAll('lp', 'your pool shares', read.detail);

  const rooms = islandRooms();
  const shares: { p: Position; view: PoolView; room: Room }[] = [];
  let unplaced = read.totalShares > read.positions.length;
  for (const p of read.positions) {
    const entry = p.pool;
    // A share whose pool could not be looked up or read may be an island pool's: never a nothing.
    if (p.placement === 'index-unread' || entry?.kind === 'unread') unplaced = true;
    if (entry?.kind !== 'pool') continue;
    const room = rooms.find((r) => r.address === entry.view.tokenMint);
    if (room) shares.push({ p, view: entry.view, room });
  }
  if (unplaced) unreadAll('lp:unplaced', 'some of your pool shares', 'their pools could not be looked up just now');
  if (!shares.length) return plan;

  let writes: { api: FeeApi; gate: LpGate };
  try {
    writes = await reads.writes();
  } catch (e) {
    return unreadAll('lp:gate', 'the fees on your pool shares', clipDetail(e));
  }
  const gate = writes.gate;
  // LP switched off: Pools offers no claim either.
  if (gate.kind === 'off') return plan;
  if (gate.kind !== 'open') return unreadAll('lp:gate', 'the fees on your pool shares', gate.detail);
  // The pools read and the program a claim goes to must be one program (useLpWrites.tsx `mismatch`).
  if (gate.cfg.cpSwapProgram.toBase58() !== reads.programId) {
    return unreadAll('lp:gate', 'the fees on your pool shares', 'this page reads pools from one program and would send to another');
  }

  let safety: Map<string, TokenSafety>;
  try {
    safety = await reads.safety([...new Set(shares.map((s) => s.view.tokenMint))]);
  } catch {
    safety = new Map();
  }
  const notes = reads.notes();

  for (const { p, view, room } of shares) {
    const pair = `${room.symbol}/${view.quote.symbol}`;
    const key = `lp:${p.lpAccount}`;
    const pool = view.snapshot.pool;
    const tokenDecimals = view.quoteIsToken0 ? pool.mint1Decimals : pool.mint0Decimals;
    const coinDecimals = view.quoteIsToken0 ? pool.mint0Decimals : pool.mint1Decimals;
    const unread = (detail: string) => {
      const u: HarvestUnread = { key, chain: 'solana', roomId: room.id, what: `the fees on your ${pair} pool share`, detail };
      plan.unread.push(u);
    };
    // The token's transfer fee is taken off its payout: a token not checked is never claimed against.
    const checked = safety.get(view.tokenMint);
    if (checked?.kind !== 'read') {
      unread('its token could not be checked just now');
      continue;
    }
    const tokenFee = feeNow(checked.facts?.transferFee, null);
    if (withdrawOffer({ mode: reads.mode, gate, position: p, held: lpHeld(notes, view.address, 'remove'), tokenFee }) !== 'offer') continue;
    // No history is read for a share the claim rule turns away on what is already known.
    const trade = lastTrade(view);
    if (trade.kind === 'none' || claimSentOn(p.lpAccount, p.lpAmount)) continue;
    let ledger: LedgerRead;
    try {
      ledger = await reads.ledger({ lpAccount: p.lpAccount, lpMint: p.lpMint, owner, lpAmount: p.lpAmount }, view);
    } catch (e) {
      ledger = { kind: 'unread', detail: clipDetail(e) };
    }
    if (ledger.kind === 'unread') {
      unread(ledger.detail);
      continue;
    }
    if (ledger.kind === 'paused') {
      unread('the network is busy, so its history was not read just now');
      continue;
    }
    if (ledger.kind === 'worth-only') {
      if (ledger.why === 'unread-entry') unread('one of its transactions could not be read just now');
      else if (ledger.why === 'run-start-not-read') {
        plan.held.push({
          key, chain: 'solana', roomId: room.id, symbol: room.symbol, where: `${pair} pool`, amountRaw: null, decimals: tokenDecimals, to: '/pools',
          reason: 'Its history is longer than Harvest reads, so its fees could not be worked out here. Work them out on Pools.',
        });
      }
      continue;
    }
    const fees = feeClaimOf({
      read: ledger, trade, canClaim: true, lpAccount: p.lpAccount, lpAmount: p.lpAmount,
      snapshot: view.snapshot, quoteIsToken0: view.quoteIsToken0, tokenFee, slippageBps: DEFAULT_SLIPPAGE_BPS,
    });
    if (!fees) continue;
    const basis: LpClaimBasis = { basis: fees.figures.basis, provenShares: fees.figures.provenShares, heldAtRead: p.lpAmount };
    const api = writes.api;
    plan.claims.push({
      key, chain: 'solana', roomId: room.id, symbol: room.symbol, where: `${pair} pool`, detail: 'fees your share earned',
      amountRaw: view.quoteIsToken0 ? fees.plan.out1 : fees.plan.out0, decimals: tokenDecimals,
      also: { symbol: view.quote.symbol, amountRaw: view.quoteIsToken0 ? fees.plan.out0 : fees.plan.out1, decimals: coinDecimals },
      about: true, caution: null,
      send: async (adapter) => {
        const signer = txSignerOf(adapter);
        if (!signer) return { kind: 'unconfirmed', reason: 'Your Solana wallet is not connected, so nothing was sent.' };
        return sendFeeClaim({ api, rpc: reads.rpc(), gate, signer, owner: ownerKey, view, lpAccount: p.lpAccount, basis });
      },
    });
  }
  return plan;
}

let sendConn: Connection | null = null;

/** The browser's reads, as the Pools page makes them (readers.ts, useLpWrites.tsx); null when this build names no pool program. */
export function browserFeeReads(): FeeReads | null {
  const programId = LIVE_PROGRAM_ID;
  if (!programId) return null;
  // Every read ends (readFetch.ts); the chain's answers feed the budget (rpcBudget.ts).
  const rpc = withReadCommitment(browserRpc(lpFetch({ what: 'the chain', onResponse: noteResponse })), 'confirmed');
  const opts = { programId, launchProgramId: LAUNCH_PROGRAM_ID };
  return {
    programId: programId.toBase58(),
    mode: lpWriteMode(),
    positions: (o) => readPositions(rpc, o, { ...opts, fetchImpl: lpFetch({ what: 'the pool index' }) }),
    safety: (mints) => readTokenSafety(rpc, mints),
    ledger: (share, view) => readLedger(rpc, share, view, programId.toBase58()),
    writes: async () => {
      const api = await loadLpWriteApi();
      const gateRpc = withReadCommitment(browserRpc(lpFetch({ what: 'the chain', onResponse: noteResponse })));
      return { api, gate: await api.readLpGate(browserGateRpc(gateRpc, browserCurveRpc(gateRpc)), api.lpWriteConfig()) };
    },
    notes: () => readPendingTrades(LP_PENDING_SCOPE),
    // The endpoint and commitment the page's ConnectionProvider sends on, as the panels send.
    rpc: () => (sendConn ??= new Connection(solanaRpcEndpoint(), 'confirmed')),
  };
}
