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
/**
 * Jito's block engine in each region, as its docs list them (docs.jito.wtf/lowlatencytxnsend, read
 * 2026-11-13). The docs say neither that a bundle sent to one region reaches a leader connected to
 * another nor that it does not; KEEPER_JITO_REGIONS sends each bundle to several at once (the
 * same signed transaction: it lands once at most). Each takes 1 request a second from an IP.
 */
export const JITO_REGIONS: Readonly<Record<string, string>> = {
  amsterdam: 'https://amsterdam.mainnet.block-engine.jito.wtf',
  dublin: 'https://dublin.mainnet.block-engine.jito.wtf',
  frankfurt: 'https://frankfurt.mainnet.block-engine.jito.wtf',
  london: 'https://london.mainnet.block-engine.jito.wtf',
  ny: 'https://ny.mainnet.block-engine.jito.wtf',
  slc: 'https://slc.mainnet.block-engine.jito.wtf',
  singapore: 'https://singapore.mainnet.block-engine.jito.wtf',
  tokyo: 'https://tokyo.mainnet.block-engine.jito.wtf',
};

/**
 * The block engines a bundle goes to, from KEEPER_JITO_REGIONS: unset (or blank), the one endpoint
 * (JITO_BLOCK_ENGINE), as before; "all", every region; else region names joined by commas, the one
 * endpoint among them as "mainnet". A name Jito does not list throws: a typo is never a silent default.
 */
export function jitoUrls(raw: string | undefined): string[] {
  const text = raw?.trim().toLowerCase() ?? '';
  if (!text) return [JITO_BLOCK_ENGINE];
  if (text === 'all') return Object.values(JITO_REGIONS);
  const names = [...new Set(text.split(',').map((x) => x.trim()).filter(Boolean))];
  if (!names.length) return [JITO_BLOCK_ENGINE];
  return names.map((n) => {
    if (n === 'mainnet') return JITO_BLOCK_ENGINE;
    const url = JITO_REGIONS[n];
    if (!url) throw new Error(`KEEPER_JITO_REGIONS: "${n}" is not one of Jito's regions (${['all', 'mainnet', ...Object.keys(JITO_REGIONS)].join(', ')})`);
    return url;
  });
}
/** Jito's least tip. */
export const JITO_MIN_TIP_LAMPORTS = 1_000n;
/**
 * The least tip the robot sends through Jito; a smaller one goes the usual way. Measured live
 * 2026-11-06/07: tips of 7,403 to 11,246 lamports landed 0 times in 32, tips of 19,833 and more
 * landed 18 times in 18.
 */
export const JITO_LANDING_TIP_LAMPORTS = 20_000n;
/**
 * Measured again 2026-11-11 to 11-14 (the robot's own log, 17 bundles of test-run trips): tips of
 * 25,295 to 46,312 lamports landed 1 time in 8, tips of 48,230 and more 8 times in 9, and each
 * bundle that did not land held the robot about 35 s (its blockhash's life). Of the 5 lost since
 * 11-13, 3 met no other trade in any of our pools from 40 s before to 45 s after.
 * KEEPER_JITO_MIN_TIP_LAMPORTS sets the least tip; this is what landed then.
 */
export const JITO_LANDING_TIP_MEASURED_2026_11_14 = 50_000n;
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
 * lands (`landing`: JITO_LANDING_TIP_LAMPORTS unless KEEPER_JITO_MIN_TIP_LAMPORTS says another,
 * never under Jito's own least): the trip goes the usual way.
 */
export function jitoTip(gained: bigint, floor: bigint, solAfter: bigint, landing: bigint = JITO_LANDING_TIP_LAMPORTS): bigint | null {
  const least = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
  const tip = least((gained * JITO_TIP_SHARE_PCT) / 100n, gained - floor, solAfter - JITO_KEEP_LAMPORTS);
  return tip >= (landing > JITO_MIN_TIP_LAMPORTS ? landing : JITO_MIN_TIP_LAMPORTS) ? tip : null;
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
 * The second door (KEEPER_TWO_DOORS): the same signed transaction handed to the usual RPC beside
 * the bundle. One signature, so the chain takes it once at most, by whichever door reaches a
 * leader first. 'sent': the RPC's own test run passed and it went out. 'refused': that test run
 * failed, so nothing went out by this door (`why`: the chain's word). 'unread': the RPC did not
 * answer (too busy, unreachable), which says nothing about the trip.
 *
 * Why (the robot's log, 2026-11-11 to 11-14): 8 of 17 test-run bundles never landed, each holding
 * the robot ~35 s; after 4 of them (GROYPER 11-13 06:54Z, the BRAINLET round 16:07Z, SOY 11-14
 * 00:43Z, OGDOGE 05:35Z) the gap was still there and a trip through it, sent the usual way,
 * landed within a minute. On 11-14 05:57:44Z one such wait ran while another wallet (Cn8LrZZn…)
 * traded our pools at 05:58:03Z.
 */
export type PlainDoor = { door: 'sent' } | { door: 'refused'; why: string } | { door: 'unread'; why: string };
/** With two doors: the plain door is knocked on this many times in all, once a watch round, while the trip has not landed. */
export const PLAIN_KNOCKS = 4;
/**
 * With two doors: the plain door's test run refusing the trip this many times running, with
 * nothing ever sent through it, the chain not knowing the signature, and Jito not saying it still
 * holds the bundle (every bundle that did not land 11-13/14 was 'Invalid' to Jito), calls the trip
 * lost (about 2 s in, not 35): the chain itself said three times, a second apart, that it would fail.
 */
export const PLAIN_REFUSALS_LOST = 3;

/** A sent bundle's ending, and what Jito said of it on the way. */
export interface JitoSent {
  signature: string;
  outcome: JitoOutcome;
  /** Jito's id of the bundle; null when no block engine took it and the trip went by the plain door alone. */
  bundle: string | null;
  /** How many of the block engines asked took the bundle, of how many. */
  took: number;
  asked: number;
  /**
   * The last status getInflightBundleStatuses gave (Pending, Failed, Landed, Invalid), or null when
   * it never answered. A bundle that did not land says why as far as Jito says: Failed, every
   * region that had it failed it (its auction, or its own test run); Pending to the end, no
   * leader took it; Invalid, Jito did not know it.
   */
  jitoSaid: string | null;
  /** With two doors: the plain door's last word ('sent' once it ever went out by it), and why it was refused or unread. */
  plain?: PlainDoor['door'] | null;
  plainWhy?: string | null;
}

/** A sent bundle in a few words for the robot's log: how many regions took it, Jito's last word on it, and the plain door's. */
export function jitoNote(r: Pick<JitoSent, 'took' | 'asked' | 'jitoSaid'> & Partial<Pick<JitoSent, 'plain' | 'plainWhy'>>): string {
  const regions = r.asked > 1 ? `${r.took} of ${r.asked} regions took it; ` : '';
  const why = r.plainWhy ? `: ${r.plainWhy.slice(0, 160)}` : '';
  const plain = r.plain === 'sent' ? '; the plain door: sent too' : r.plain === 'refused' ? `; the plain door: its test run refused it${why}` : r.plain === 'unread' ? `; the plain door: not reached${why}` : '';
  return `${regions}Jito's last word: ${r.jitoSaid ?? 'none'}${plain}`;
}

/**
 * Sends a signed transaction to Jito as a one-transaction bundle, to every block engine in `urls`
 * at once (KEEPER_JITO_REGIONS; the one endpoint by default), then watches it: 'confirmed' once
 * the chain says so, 'lost' once Jito says every region failed it, or once the chain is past the
 * transaction's blockhash and still does not know it (either way it never lands, nothing is paid),
 * 'unknown' when none of that is said within JITO_WATCH_MS, or JITO_GIVE_UP_MS when
 * `blockhashValid` is given (counted as the most a trip may cost). A bundle no block engine takes
 * throws: nothing was sent. One that some take is sent, and the first in `urls` to take it is the
 * one asked how it fares (Failed is every region's word, per Jito's docs).
 *
 * Given `plain` (KEEPER_TWO_DOORS), the same signed transaction goes to the usual RPC at the same
 * moment (PlainDoor), and again each watch round, PLAIN_KNOCKS times in all, while it has not
 * landed. Once it ever went out by that door, Jito's Failed no longer ends the watch (the plain
 * door may still land it): only the chain does, or the blockhash running out. While it never went
 * out by it, PLAIN_REFUSALS_LOST refusals running call it lost early. A trip no block engine took
 * is still sent if the plain door took it.
 */
export function jitoSender(opts: {
  fetchImpl: typeof fetch;
  status: (signature: string) => Promise<Status>;
  /** Whether the chain (confirmed) would still take a transaction with this blockhash. */
  blockhashValid?: (blockhash: string) => Promise<boolean>;
  /** The second door: hands the signed transaction to the usual RPC, its own test run first. */
  plain?: (tx: VersionedTransaction) => Promise<PlainDoor>;
  url?: string;
  urls?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}) {
  const urls = opts.urls?.length ? [...new Set(opts.urls)] : [opts.url ?? JITO_BLOCK_ENGINE];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const call = async (url: string, method: string, params: unknown[]) => {
    const res = await opts.fetchImpl(`${url}/api/v1/bundles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
    if (!res.ok || !j || j.error) throw new Error(`Jito ${method}: ${j?.error?.message ?? `answered ${res.status}`}`);
    return j.result;
  };
  return async (tx: VersionedTransaction): Promise<JitoSent> => {
    const signature = base58.encode(tx.signatures[0]!);
    const wire = [[base64.encode(tx.serialize())], { encoding: 'base64' }];
    // The plain door never throws here: an RPC that cannot be reached says nothing about the trip.
    const knock = (): Promise<PlainDoor> =>
      opts.plain!(tx).catch((e): PlainDoor => ({ door: 'unread', why: e instanceof Error ? e.message : String(e) }));
    // Both doors at the same moment: neither waits on the other.
    const [sent, firstKnock] = await Promise.all([Promise.allSettled(urls.map((u) => call(u, 'sendBundle', wire))), opts.plain ? knock() : null]);
    const ids = sent.map((x) => (x.status === 'fulfilled' && typeof x.value === 'string' ? x.value : null));
    const first = ids.findIndex((x) => x !== null);
    // The plain door's standing: whether it ever sent, its last word, and its refusals running.
    let everSent = firstKnock?.door === 'sent';
    let plain: PlainDoor['door'] | null = firstKnock?.door ?? null;
    let plainWhy: string | null = firstKnock && firstKnock.door !== 'sent' ? firstKnock.why : null;
    let refusals = firstKnock?.door === 'refused' ? 1 : 0;
    let knocks = firstKnock ? 1 : 0;
    if (first < 0 && !everSent) {
      // No block engine took it (and the plain door sent nothing): the first one's refusal says why (as with one endpoint).
      const why = sent.find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined;
      throw why ? why.reason : new Error('Jito sendBundle: no bundle id');
    }
    const bundle = first < 0 ? null : ids[first]!;
    const took = ids.filter((x) => x !== null).length;
    const asked = urls.length;
    let jitoSaid: string | null = null;
    const done = (outcome: JitoOutcome): JitoSent => ({ signature, outcome, bundle, took, asked, jitoSaid, ...(opts.plain ? { plain: everSent ? 'sent' : plain, plainWhy: everSent ? null : plainWhy } : {}) });
    const start = now();
    const landed = (s: Status) => !!s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized');
    const giveUp = opts.blockhashValid ? JITO_GIVE_UP_MS : JITO_WATCH_MS;
    while (now() - start < giveUp) {
      const late = now() - start >= JITO_WATCH_MS;
      await sleep(late ? 3_000 : 1_000);
      const s = await opts.status(signature).catch(() => null);
      if (landed(s)) return done(s!.err ? 'reverted' : 'confirmed');
      const inflight = bundle === null ? null : ((await call(urls[first]!, 'getInflightBundleStatuses', [[bundle]]).catch(() => null)) as { value?: { status?: unknown }[] } | null);
      const said = inflight?.value?.[0]?.status;
      if (typeof said === 'string' && said) jitoSaid = said.slice(0, 24);
      // Out by the plain door too, Jito's Failed is one door's word only: the chain's is waited for.
      if (said === 'Failed' && !everSent) return done('lost');
      if (opts.plain && !late && knocks < PLAIN_KNOCKS) {
        knocks++;
        const k = await knock();
        plain = k.door;
        if (k.door === 'sent') {
          everSent = true;
          refusals = 0;
        } else {
          plainWhy = k.why;
          refusals = k.door === 'refused' ? refusals + 1 : 0;
        }
        // The chain's own test run said no three times running and nothing went out by this door:
        // lost, unless the chain knows the signature after all (then it is watched on), or Jito
        // just said it still holds the bundle (Pending) or landed it: then its word is waited for.
        const jitoHoldsIt = said === 'Pending' || said === 'Landed';
        if (!everSent && refusals >= PLAIN_REFUSALS_LOST && !jitoHoldsIt) {
          const last = await opts.status(signature).then(
            (x) => ({ x }),
            () => null,
          );
          if (last && last.x === null) return done('lost');
          if (last && landed(last.x)) return done(last.x!.err ? 'reverted' : 'confirmed');
        }
      }
      // Past the watch: once the chain is past the transaction's blockhash, it can never land, so
      // a signature the chain still does not know then was never paid for. Unread: unknown.
      if (late && opts.blockhashValid && (await opts.blockhashValid(tx.message.recentBlockhash).catch(() => null)) === false) {
        const last = await opts.status(signature).then(
          (x) => ({ x }),
          () => null,
        );
        if (!last) break;
        if (last.x === null) return done('lost');
        if (landed(last.x)) return done(last.x!.err ? 'reverted' : 'confirmed');
        // Seen in a block not yet confirmed: watched on.
      }
    }
    return done('unknown');
  };
}
