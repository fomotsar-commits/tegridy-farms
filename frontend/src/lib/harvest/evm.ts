// Harvest on Ethereum and Base: which island pools there are, what one pool's reads come
// to, and how a claim's answer is read. No wagmi here, so all of it is tested without a
// chain; the reads and the wallet are the hook's (hooks/useEvmHarvest.ts).
import { encodeFunctionData } from 'viem';
import { BUNGALOWS, type Bungalow } from '../bungalows';
import { LIGHTHOUSE_LADDER_ABI } from '../contracts';
import { callsId, sendCalls, type Eip1193Like } from '../eip5792';
import { extractErrorMessage, isUserRejection, waitForReceiptOutcome, type DirectReceiptOutcome } from '../txErrors';
import { fmtAmount } from '../wallet/walletRows';
import { parseCallsStatus } from '../zap/batchStatus';
import type { SendTogether } from './run';
import type { ClaimResult, HarvestClaim, HarvestPlan } from './types';

export const EVM_CHAIN_IDS = { ethereum: 1, base: 8453 } as const;

export type EvmHarvestRoom = Bungalow & { chain: 'ethereum' | 'base'; stakePool: string; address: string };

/** Every live Ethereum and Base room with a pool: the lock ladders and any plain (no-lock) pool. */
export function evmHarvestRooms(bungalows: readonly Bungalow[] = BUNGALOWS): EvmHarvestRoom[] {
  return bungalows.filter(
    (b): b is EvmHarvestRoom =>
      b.live && (b.chain === 'ethereum' || b.chain === 'base') && Boolean(b.stakePool) && Boolean(b.address),
  );
}

export interface EvmClaim extends HarvestClaim {
  chain: 'ethereum' | 'base';
  chainId: number;
  pool: `0x${string}`;
}

/** One pool's reads for the connected account. `null` = that read did not answer. */
export interface EvmPoolRead {
  earnedRaw: bigint | null;
  stakingToken: string | null;
  rewardsToken: string | null;
  /** The ladder's own `rewardSurplus()`: what it can pay now. Undefined on a plain pool, which has none. */
  surplusRaw?: bigint | null;
  decimals: number;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * What one Ethereum or Base pool comes to. Both pool kinds pay `min(owed, what the vault
 * holds)` from `getReward()` and keep the rest owed, so an empty vault is a claim that
 * pays nothing and costs gas: held, not sent. A vault short of the amount still pays
 * what it holds, and the row says so.
 */
export function planEvmPool(room: EvmHarvestRoom, read: EvmPoolRead): HarvestPlan<EvmClaim> {
  const sym = room.symbol;
  const chainId = EVM_CHAIN_IDS[room.chain];
  const key = `evm:${room.id}`;
  const where = 'lighthouse pool';
  if (read.earnedRaw === null) {
    return { claims: [], held: [], unread: [{ key, chain: room.chain, roomId: room.id, what: `your ${sym} rewards`, detail: `the ${sym} pool did not answer` }] };
  }
  if (read.earnedRaw === 0n) return { claims: [], held: [], unread: [] };
  const held = (reason: string, amountRaw: bigint | null = read.earnedRaw) =>
    ({ claims: [], unread: [], held: [{ key, chain: room.chain, roomId: room.id, symbol: sym, where, amountRaw, decimals: read.decimals, reason }] });
  // The card's identity check (EvmLadderPoolLive): a pool that does not stake this room's
  // coin is a registry error, and its figures are not this coin's.
  if (read.stakingToken !== null && !same(read.stakingToken, room.address)) {
    return held(`This pool does not stake ${sym}, so Harvest leaves it alone.`, null);
  }
  // What the claim actually pays. Every island pool pays its own coin; one that does not
  // is not named here, and is claimed on its page.
  if (read.rewardsToken !== null && !same(read.rewardsToken, room.address)) {
    return held(`This pool pays another coin, so Harvest leaves it alone. Claim it on its page.`, null);
  }
  if (read.surplusRaw === 0n) {
    return held('Its reward vault is empty right now, so a claim would pay nothing. Nothing is lost: it stays owed.');
  }
  const caution = read.surplusRaw != null && read.surplusRaw < read.earnedRaw
    ? `The vault holds ${fmtAmount(read.surplusRaw, read.decimals)} ${sym} now: a claim pays that and the rest stays owed.`
    : null;
  return {
    claims: [{
      key, chain: room.chain, chainId, pool: room.stakePool as `0x${string}`, roomId: room.id, symbol: sym,
      where, detail: null, amountRaw: read.earnedRaw, decimals: read.decimals, caution,
    }],
    held: [],
    unread: [],
  };
}

/** One claim's receipt, read the way every direct wait reads it (lib/txErrors), as Harvest says it. */
export function receiptResult(outcome: DirectReceiptOutcome<unknown>, hash: `0x${string}`): ClaimResult {
  if (outcome.kind === 'success') return { kind: 'claimed', tx: outcome.replacement?.hash ?? hash };
  if (outcome.kind === 'reverted') return { kind: 'reverted', reason: 'Refused on chain: nothing was claimed, and only the network fee was spent.', tx: hash };
  if (outcome.kind === 'replaced') {
    return { kind: 'unconfirmed', reason: 'Your wallet replaced this transaction (a cancel, or another call), so this claim did not run.', tx: hash, stop: true };
  }
  return { kind: 'unconfirmed', reason: 'Sent, but its receipt could not be read. Check it on the explorer before claiming again.', tx: hash, stop: true };
}

export interface EvmBatchDeps {
  provider: Eip1193Like;
  from: `0x${string}`;
  /** That chain's public client, for each claim's own receipt. */
  client: Parameters<typeof waitForReceiptOutcome>[0];
  sleep?: (ms: number) => Promise<unknown>;
}

// How long a batch is watched before its claims are said to be unread: useZapRun's wait.
const BATCH_POLLS = 40;
const BATCH_POLL_MS = 3_000;
/** A batch the wallet would not take, before sending anything: EIP-1193 4200 (no such method), EIP-5792 5700 to 5760. */
const BATCH_REFUSED: ReadonlySet<number> = new Set([4200, 5700, 5710, 5740, 5750, 5760]);
const UNREAD_BATCH = 'Your wallet took them, but did not say how they ended. Check your wallet before claiming again.';

function errorCode(e: unknown): number | null {
  for (let cur = e, i = 0; cur != null && typeof cur === 'object' && i < 4; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'number') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * One chain's claims as one EIP-5792 `wallet_sendCalls`, one `getReward()` call each and
 * no `atomicRequired`, so the wallet may run them one after another. Only for a wallet
 * whose `wallet_getCapabilities` names the chain (eip5792.ts isBatchSupported). Its
 * status gives each call's transaction; each receipt is then read on its own, as the
 * one-claim send reads it. A wallet that runs them as ONE transaction gives them one
 * receipt, and they share its fate.
 */
export function sendCallsTogether(deps: EvmBatchDeps, chainId: number): SendTogether<EvmClaim> {
  return async (claims, settle) => {
    const all = (r: ClaimResult) => claims.forEach((c) => settle(c.key, r));
    const data = encodeFunctionData({ abi: LIGHTHOUSE_LADDER_ABI, functionName: 'getReward' });
    let id: string;
    try {
      const sent = await sendCalls(deps.provider, { from: deps.from, chainId: `0x${chainId.toString(16)}`, calls: claims.map((c) => ({ to: c.pool, data })) });
      id = callsId(sent);
    } catch (e) {
      if (isUserRejection(e)) {
        all({ kind: 'declined' });
        return 'done';
      }
      const code = errorCode(e);
      if (code !== null && BATCH_REFUSED.has(code)) return 'one-by-one';
      all({ kind: 'unconfirmed', reason: `Your wallet did not send them (${extractErrorMessage(e, 'no reason given').slice(0, 140)}).`, stop: true });
      return 'done';
    }
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; attempt < BATCH_POLLS; attempt++) {
      let raw: unknown;
      try {
        raw = await deps.provider.request({ method: 'wallet_getCallsStatus', params: [id] });
      } catch {
        break;
      }
      const status = parseCallsStatus(raw, claims.length);
      if (status.kind === 'pending') {
        await sleep(BATCH_POLL_MS);
        continue;
      }
      if (status.kind === 'failed') {
        all({ kind: 'unconfirmed', reason: 'Your wallet says it sent none of them, so nothing was claimed.' });
        return 'done';
      }
      if (status.kind === 'unreadable') break;
      // The same transaction, when the wallet bundled them, is read once.
      const waits = new Map<string, Promise<ClaimResult>>();
      await Promise.all(claims.map(async (c, i) => {
        const tx = status.calls[i]?.txHash;
        if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return settle(c.key, { kind: 'unconfirmed', reason: UNREAD_BATCH, stop: true });
        const hash = tx as `0x${string}`;
        if (!waits.has(hash)) waits.set(hash, waitForReceiptOutcome(deps.client, hash).then((o) => receiptResult(o, hash)));
        settle(c.key, await waits.get(hash)!);
      }));
      return 'done';
    }
    all({ kind: 'unconfirmed', reason: UNREAD_BATCH, stop: true });
    return 'done';
  };
}
