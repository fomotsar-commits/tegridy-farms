import { base58, base64 } from '@scure/base';
import { PublicKey, SystemProgram, type TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';

/**
 * A SOL trip sent through Jito's block engine as a one-transaction bundle (KEEPER_JITO; off by
 * default). Jito puts a bundle in a block only whole and only if it succeeds, so a race lost to
 * another robot never lands: no fee, no tip. The tip rides inside the trip: a SOL transfer to one
 * of Jito's tip accounts, at most JITO_TIP_SHARE_PCT of the trip's test-run gain, and the trip's
 * Lighthouse floor rises by it, so the trip still keeps its own floor after paying. The tip
 * instruction is copied from mainnet transaction 5NWjWUTa…GBNQQF (slot 465,966,356): its last
 * instruction, a System transfer of 100,000 lamports from its signer to 96gYZG…rZU5.
 */

/** Jito's tip accounts, as its block engine's getTipAccounts answered 2026-11-05. */
export const JITO_TIP_ACCOUNTS: readonly string[] = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];
export const JITO_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.wtf';
/** Jito's least tip. */
export const JITO_MIN_TIP_LAMPORTS = 1_000n;
/**
 * The least tip the robot sends through Jito; a smaller one goes the usual way. Measured live
 * 2026-11-06/07: tips of 7,403 to 11,246 lamports landed 0 times in 32, tips of 19,833 and more
 * landed 18 times in 18.
 */
export const JITO_LANDING_TIP_LAMPORTS = 20_000n;
/** The most of a trip's test-run gain its tip may take. */
export const JITO_TIP_SHARE_PCT = 30n;
/** How long a sent bundle is watched before the chain is asked whether its blockhash has run out. */
export const JITO_WATCH_MS = 30_000;
/** The longest a sent bundle is watched before its ending is called unknown (a blockhash lasts ~1 min). */
export const JITO_GIVE_UP_MS = 120_000;

/** The tip: `lamports` of SOL from the robot to one of Jito's tip accounts. */
export function jitoTipIx(payer: PublicKey, lamports: bigint, tipAccount: string): TransactionInstruction {
  if (!JITO_TIP_ACCOUNTS.includes(tipAccount)) throw new Error(`${tipAccount} is not one of Jito's tip accounts`);
  if (lamports < JITO_MIN_TIP_LAMPORTS) throw new Error(`a Jito tip is at least ${JITO_MIN_TIP_LAMPORTS} lamports`);
  return SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(tipAccount), lamports });
}

/** Plain SOL the wallet keeps after a tip: it must stay open (rent) and pay the next trip's fee. */
export const JITO_KEEP_LAMPORTS = 1_000_000n;

/**
 * The tip for a SOL trip whose test run gained `gained` lamports (wrapped) against a floor of
 * `floor`, leaving the wallet `solAfter` plain lamports: JITO_TIP_SHARE_PCT of the gain, cut so
 * the gain still covers floor + tip, and cut to the plain SOL the wallet can spare, since the tip
 * is paid in plain SOL and the gain lands wrapped. Null when that is under the least tip that
 * lands (JITO_LANDING_TIP_LAMPORTS): the trip goes the usual way.
 */
export function jitoTip(gained: bigint, floor: bigint, solAfter: bigint): bigint | null {
  const least = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
  const tip = least((gained * JITO_TIP_SHARE_PCT) / 100n, gained - floor, solAfter - JITO_KEEP_LAMPORTS);
  return tip >= JITO_LANDING_TIP_LAMPORTS ? tip : null;
}

/** A random byte from the platform's cryptographic source (Node and every browser have it), not Math.random. */
const randomByte = () => globalThis.crypto.getRandomValues(new Uint8Array(1))[0]!;

/**
 * A tip account picked at random each trip, as Jito asks, so tips do not queue on one account.
 * Jito lists 8, so a byte's low 3 bits pick one with even odds: no division, no remainder.
 */
export const pickTipAccount = (byte: () => number = randomByte) => JITO_TIP_ACCOUNTS[byte() & 7]!;

export type JitoOutcome = 'confirmed' | 'reverted' | 'unknown' | 'lost';
type Status = { err: unknown; confirmationStatus?: string | null } | null;

/**
 * Sends a signed transaction to Jito as a one-transaction bundle, then watches it: 'confirmed' once
 * the chain says so, 'lost' once Jito says every region failed it, or once the chain is past the
 * transaction's blockhash and still does not know it (either way it never lands, nothing is paid),
 * 'unknown' when none of that is said within JITO_WATCH_MS, or JITO_GIVE_UP_MS when
 * `blockhashValid` is given (counted as the most a trip may cost). A bundle Jito refuses throws:
 * nothing was sent.
 */
export function jitoSender(opts: {
  fetchImpl: typeof fetch;
  status: (signature: string) => Promise<Status>;
  /** Whether the chain (confirmed) would still take a transaction with this blockhash. */
  blockhashValid?: (blockhash: string) => Promise<boolean>;
  url?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}) {
  const url = opts.url ?? JITO_BLOCK_ENGINE;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const call = async (method: string, params: unknown[]) => {
    const res = await opts.fetchImpl(`${url}/api/v1/bundles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
    if (!res.ok || !j || j.error) throw new Error(`Jito ${method}: ${j?.error?.message ?? `answered ${res.status}`}`);
    return j.result;
  };
  return async (tx: VersionedTransaction): Promise<{ signature: string; outcome: JitoOutcome; bundle: string }> => {
    const signature = base58.encode(tx.signatures[0]!);
    const bundle = await call('sendBundle', [[base64.encode(tx.serialize())], { encoding: 'base64' }]);
    if (typeof bundle !== 'string') throw new Error('Jito sendBundle: no bundle id');
    const start = now();
    const landed = (s: Status) => !!s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized');
    const giveUp = opts.blockhashValid ? JITO_GIVE_UP_MS : JITO_WATCH_MS;
    while (now() - start < giveUp) {
      const late = now() - start >= JITO_WATCH_MS;
      await sleep(late ? 3_000 : 1_000);
      const s = await opts.status(signature).catch(() => null);
      if (landed(s)) return { signature, outcome: s!.err ? 'reverted' : 'confirmed', bundle };
      const inflight = (await call('getInflightBundleStatuses', [[bundle]]).catch(() => null)) as { value?: { status?: string }[] } | null;
      if (inflight?.value?.[0]?.status === 'Failed') return { signature, outcome: 'lost', bundle };
      // Past the watch: once the chain is past the transaction's blockhash, it can never land, so
      // a signature the chain still does not know then was never paid for. Unread: unknown.
      if (late && opts.blockhashValid && (await opts.blockhashValid(tx.message.recentBlockhash).catch(() => null)) === false) {
        const last = await opts.status(signature).then(
          (x) => ({ x }),
          () => null,
        );
        if (!last) break;
        if (last.x === null) return { signature, outcome: 'lost', bundle };
        if (landed(last.x)) return { signature, outcome: last.x!.err ? 'reverted' : 'confirmed', bundle };
        // Seen in a block not yet confirmed: watched on.
      }
    }
    return { signature, outcome: 'unknown', bundle };
  };
}
