// Create a launch on the venue's own EVM curve: create() deploys the token and opens its
// curve; attached ETH is the creator's opening buy. Name 1-64 and symbol 1-16 mirror the
// contract's BadTokenMetadata. Order: the heat gate reads the wallet (a refusal signs and
// sends nothing), the image goes to Arweave via Irys, the create tx, then the identity JSON
// (curveIdentity.ts). A failed identity publish leaves a live launch and a retry; an unread
// create receipt holds the form behind "Check again", since the coin may already exist.

import { useEffect, useMemo, useRef, useState } from 'react';
import { m } from 'framer-motion';
import { Link } from 'react-router-dom';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import { parseEventLogs, type Address, type TransactionReceipt } from 'viem';
import { sanitizeDecimalInput } from '../../lib/formatting';
import { safeParseEther } from '../../lib/safeParseEther';
import { CURVE_LAUNCHER_ABI } from '../../lib/launcher/curve';
import {
  buildIdentityMetadata,
  identityTags,
  validateIdentityImage,
  IDENTITY_DESCRIPTION_MAX,
  IDENTITY_IMAGE_MAX_BYTES,
} from '../../lib/launcher/curveIdentity';
import { useIrysUpload } from '../../hooks/useIrysUpload';
import { assertMayLaunch } from '../../lib/heat/launchGate';
import { getTxUrl } from '../../lib/explorer';
import {
  readReceiptOutcome,
  surfaceReceiptNotice,
  surfaceUnconfirmedTx,
  waitForReceiptOutcome,
  type DirectReceiptOutcome,
} from '../../lib/txErrors';

const cardStyle = { border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' } as const;
const inputCls = 'w-full px-3 py-2 rounded-lg bg-black/55 text-white text-[13px] outline-none';
const inputStyle = { border: '1px solid rgba(255,255,255,0.18)' } as const;

export interface CurveCreateFields {
  name: string;
  symbol: string;
  openingBuyWei: bigint;
  image: File;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
}

/** The create flow's visible machine. Busy stages disable the form; the two
 *  terminal stages swap it for the success card, and 'unconfirmed' (the create
 *  tx was sent but its receipt could not be read) swaps it for a card that can
 *  check again. */
export type CurveCreateStage =
  | 'idle'
  | 'reading-heat'
  | 'uploading-image'
  | 'awaiting-wallet'
  | 'confirming'
  | 'publishing-identity'
  | 'done'
  | 'identity-failed'
  | 'unconfirmed';

const BUSY_LABEL: Record<Exclude<CurveCreateStage, 'idle' | 'done' | 'identity-failed' | 'unconfirmed'>, string> = {
  'reading-heat': 'Reading held time…',
  'uploading-image': 'Uploading image…',
  'awaiting-wallet': 'Confirm in wallet…',
  confirming: 'Confirming on-chain…',
  'publishing-identity': 'Publishing identity…',
};

/** A create tx that was sent, with what the post-receipt steps need. */
interface SentLaunch {
  hash: `0x${string}`;
  imageTxId: string;
  fields: CurveCreateFields;
}

export interface CurveCreateViewProps {
  nativeSymbol?: string;
  stage: CurveCreateStage;
  /** The launched token, known once the receipt's LaunchCreated log is parsed. */
  createdToken: Address | null;
  onCreate: (fields: CurveCreateFields) => void;
  /** Re-run only the metadata publish after an 'identity-failed'. */
  onRetryIdentity: () => void;
  /** Clear the terminal state to create another launch. */
  onReset: () => void;
  /** The sent create tx whose receipt could not be read, shown in 'unconfirmed'. */
  unconfirmedTx?: { hash: string; url: string } | null;
  /** Re-read that receipt; finishes the launch if it can. */
  onRecheck?: () => void;
  /** Hand the created token to the page (e.g. to prefill the trade panel). */
  onTrade?: (token: Address) => void;
  /**
   * AUDIT FIX TF-023: the launch terms READ from the launcher, formatted as
   * percentages. `null` while the read is in flight — the view says it is
   * still reading rather than quoting a number from memory, because this is
   * the screen on which a creator commits to these economics.
   */
  terms?: { creatorShare: string; fee: string; reserve: string } | null;
}

export function CurveCreateView({
  nativeSymbol = 'ETH',
  stage,
  createdToken,
  onCreate,
  onRetryIdentity,
  onReset,
  onTrade,
  terms = null, // AUDIT FIX TF-023
  unconfirmedTx = null,
  onRecheck,
}: CurveCreateViewProps) {
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [opening, setOpening] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Object-URL preview, feature-detected (jsdom has no createObjectURL).
  const previewUrl = useMemo(() => {
    if (!image || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    return URL.createObjectURL(image);
  }, [image]);
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const nameOk = name.trim().length >= 1 && name.length <= 64;
  const symbolOk = symbol.trim().length >= 1 && symbol.length <= 16;
  // Opening buy is optional; empty is 0. A non-empty, un-parseable value blocks.
  const openingWei = opening.trim() === '' ? 0n : safeParseEther(opening);
  const openingOk = openingWei !== null;
  const busy = stage !== 'idle' && stage !== 'done' && stage !== 'identity-failed' && stage !== 'unconfirmed';
  const disabled = busy || !nameOk || !symbolOk || !openingOk || !image || imageError !== null;

  const pickImage = (file: File | null) => {
    if (!file) {
      setImage(null);
      setImageError(null);
      return;
    }
    const err = validateIdentityImage(file);
    setImageError(err);
    setImage(err ? null : file);
  };

  // Sent, but the result is unreadable. The coin may exist, so this is not the
  // form: re-arming "Create launch" here would be one click from a second coin.
  if (stage === 'unconfirmed') {
    return (
      <m.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="rounded-2xl p-5 space-y-3"
        style={cardStyle}
      >
        <p className="text-white/90 text-sm font-semibold">We couldn’t confirm your launch</p>
        <p className="text-amber-300/90 text-[11px] leading-relaxed">
          The create transaction was sent, but we couldn’t read its result, so we can’t tell whether your
          coin exists yet. Check it before you launch again: a second launch creates a second coin, with its
          own opening buy.
        </p>
        {unconfirmedTx && (
          <a
            href={unconfirmedTx.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-[11px] text-white/80 underline break-all"
          >
            View {unconfirmedTx.hash} on the explorer
          </a>
        )}
        <div className="flex gap-2">
          {onRecheck && (
            <button type="button" className="btn-primary flex-1 py-2.5 text-[13px]" onClick={onRecheck}>
              Check again
            </button>
          )}
          <button
            type="button"
            className="flex-1 py-2.5 text-[13px] rounded-lg text-white/70 hover:text-white bg-black/40"
            style={inputStyle}
            onClick={onReset}
          >
            Start over
          </button>
        </div>
      </m.div>
    );
  }

  // Terminal states: the launch exists — show the coin, not the form.
  if (stage === 'done' || stage === 'identity-failed') {
    return (
      <m.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="rounded-2xl p-5 space-y-3"
        style={cardStyle}
      >
        <p className="text-white/90 text-sm font-semibold">
          {stage === 'done' ? 'Your launch is live 🎉' : 'Launch is live — identity didn’t publish'}
        </p>
        {createdToken && (
          <div>
            <span className="block text-[11px] text-white/55 mb-1">Token address — share it anywhere</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 rounded-lg bg-black/55 text-white/90 text-[12px] font-mono break-all" style={inputStyle}>
                {createdToken}
              </code>
              <button
                type="button"
                className="btn-primary px-3 py-2 text-[12px] shrink-0"
                onClick={() => {
                  void navigator.clipboard?.writeText(createdToken).then(
                    () => toast.success('Address copied.'),
                    () => toast.error('Copy failed — select it manually.'),
                  );
                }}
              >
                Copy
              </button>
            </div>
          </div>
        )}
        {stage === 'identity-failed' && (
          <p className="text-amber-300/90 text-[11px] leading-relaxed">
            Trading works either way — the image and description just aren’t attached yet.
          </p>
        )}
        <div className="flex gap-2">
          {stage === 'identity-failed' && (
            <button type="button" className="btn-primary flex-1 py-2.5 text-[13px]" onClick={onRetryIdentity}>
              Retry publishing identity
            </button>
          )}
          {stage === 'done' && createdToken && onTrade && (
            <button type="button" className="btn-primary flex-1 py-2.5 text-[13px]" onClick={() => onTrade(createdToken)}>
              Trade it now
            </button>
          )}
          <button
            type="button"
            className="flex-1 py-2.5 text-[13px] rounded-lg text-white/70 hover:text-white bg-black/40"
            style={inputStyle}
            onClick={onReset}
          >
            Launch another
          </button>
        </div>
      </m.div>
    );
  }

  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="rounded-2xl p-5 space-y-3"
      style={cardStyle}
    >
      <div className="flex gap-3">
        {/* Image picker — identity is the price of entry for a memecoin. */}
        <div className="shrink-0">
          <span className="block text-[11px] text-white/55 mb-1">Image</span>
          <button
            type="button"
            aria-label="Choose token image"
            onClick={() => fileInputRef.current?.click()}
            className="w-[72px] h-[72px] rounded-xl bg-black/55 overflow-hidden flex items-center justify-center text-white/40 text-[10px] leading-tight text-center"
            style={inputStyle}
          >
            {previewUrl ? (
              <img src={previewUrl} alt="Token image preview" className="w-full h-full object-cover" />
            ) : image ? (
              <span className="px-1 break-all">{image.name}</span>
            ) : (
              <span className="px-1">PNG / JPG<br />≤ {Math.floor(IDENTITY_IMAGE_MAX_BYTES / 1024)} KB</span>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label="Token image"
            className="hidden"
            onChange={(e) => pickImage(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="flex-1 space-y-3 min-w-0">
          <div>
            <label className="block text-[11px] text-white/55 mb-1">Token name</label>
            <input className={inputCls} style={inputStyle} maxLength={64} aria-label="Token name" placeholder="Towelie Jr" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] text-white/55 mb-1">Symbol</label>
            <input
              className={`${inputCls} uppercase`}
              style={inputStyle}
              maxLength={16}
              aria-label="Token symbol"
              placeholder="TWLJR"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            />
          </div>
        </div>
      </div>
      {imageError && <p className="text-amber-300/90 text-[11px]">{imageError}</p>}
      <div>
        <label className="block text-[11px] text-white/55 mb-1">
          Description <span className="text-white/35">— optional</span>
        </label>
        <textarea
          className={`${inputCls} resize-none`}
          style={inputStyle}
          rows={2}
          maxLength={IDENTITY_DESCRIPTION_MAX}
          aria-label="Token description"
          placeholder="What is this coin about?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input className={inputCls} style={inputStyle} aria-label="Website URL" placeholder="https://…" value={website} onChange={(e) => setWebsite(e.target.value)} />
        <input className={inputCls} style={inputStyle} aria-label="X (Twitter) handle" placeholder="@x" value={twitter} onChange={(e) => setTwitter(e.target.value)} />
        <input className={inputCls} style={inputStyle} aria-label="Telegram handle" placeholder="@telegram" value={telegram} onChange={(e) => setTelegram(e.target.value)} />
      </div>
      <div>
        <label className="block text-[11px] text-white/55 mb-1">
          Opening buy ({nativeSymbol}) <span className="text-white/35">— optional, your first position</span>
        </label>
        <input className={inputCls} style={inputStyle} inputMode="decimal" aria-label={`Opening buy in ${nativeSymbol}`} placeholder="0.0" value={opening} onChange={(e) => setOpening(sanitizeDecimalInput(e.target.value))} />
      </div>
      <p className="text-white/45 text-[11px] leading-relaxed">
        {/* AUDIT FIX TF-023: read, not hardcoded. Until the read lands we say we
            are still reading — an unread term is never quoted as a number, the
            same rule the pool cards follow for figures they could not fetch. */}
        {terms ? (
          <>
            <span className="text-white/70 font-medium">
              You earn {terms.creatorShare} of every trade’s fee (the fee is {terms.fee} of each trade) while the
              curve runs — accrued on-chain, claimable only by you.
            </span>{' '}
            Fixed supply, no team unlock beyond your opening buy. Graduation seeds our own pool
            with the LP burned; a {terms.reserve} reserve goes to protocol custody for discretionary ecosystem support.{' '}
            <span className="text-white/35">These terms are read live from the launcher and snapshot onto your launch when you create.</span>
          </>
        ) : (
          <>
            <span className="text-white/70 font-medium">Reading the current launch terms from the launcher…</span>{' '}
            Fixed supply, no team unlock beyond your opening buy. Graduation seeds our own pool with the LP burned,
            and a reserve is carved off total supply for protocol custody. The exact creator share, trade fee and
            reserve are shown here once the read lands — they are set on-chain and can be retuned, so this panel
            will not quote them from memory.
          </>
        )}
      </p>
      <p className="text-white/40 text-[11px] leading-relaxed">
        By launching you become the <span className="text-white/55">issuer</span> of this token and are
        responsible for its legal treatment — including whether it is a security or otherwise regulated
        where you and your buyers are. You accept the{' '}
        <Link to="/terms" className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">
          Terms
        </Link>
        , including the issuer, irreversibility and prohibited-use sections.
      </p>
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          image &&
          onCreate({
            name: name.trim(),
            symbol: symbol.trim(),
            openingBuyWei: openingWei ?? 0n,
            image,
            description,
            website,
            twitter,
            telegram,
          })
        }
        className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-50"
      >
        {busy ? BUSY_LABEL[stage as keyof typeof BUSY_LABEL] : 'Create launch'}
      </button>
    </m.div>
  );
}

export interface CurveCreatePanelProps {
  launcher: Address;
  chainId: number;
  /** Called with the new token once the launch confirms (identity or not). */
  onCreated?: (token: Address) => void;
  /** Called when the creator hits "Trade it now" on the success card. */
  onTrade?: (token: Address) => void;
}

export function CurveCreatePanel({ launcher, chainId, onCreated, onTrade }: CurveCreatePanelProps) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  // Pinned to the curve's chain — reads must never follow the wallet's chain.
  const publicClient = usePublicClient({ chainId });

  // AUDIT FIX TF-023: the terms a creator signs on are read, never hardcoded. create()
  // snapshots the owner-tunable launchConfig, and setLaunchConfig can retune it at any
  // time with no frontend deploy. Same read shape as CurveTradePanel.tsx.
  const { data: cfgRaw } = useReadContract({
    address: launcher,
    abi: CURVE_LAUNCHER_ABI,
    functionName: 'launchConfig',
    chainId,
    query: { refetchInterval: 15_000 },
  });
  const terms = useMemo(() => {
    // The getter returns the struct as a positional tuple.
    const c = cfgRaw as readonly unknown[] | undefined;
    if (!c || c.length < 6) return null;
    const pct = (bps: number) => {
      const v = bps / 100;
      return `${Number.isInteger(v) ? v : v.toFixed(2).replace(/\.?0+$/, '')}%`;
    };
    return {
      creatorShare: pct(Number(c[3])),  // creatorFeeShareBps — share OF THE FEE
      fee: pct(Number(c[2])),           // feeBps — the trade fee itself
      reserve: pct(Number(c[5])),       // reserveBps — carved off total supply
    };
  }, [cfgRaw]);
  const { uploadFile, uploadJson } = useIrysUpload();

  const [stage, setStage] = useState<CurveCreateStage>('idle');
  const [createdToken, setCreatedToken] = useState<Address | null>(null);
  // Kept for the identity retry after a post-tx publish failure.
  const [pendingIdentity, setPendingIdentity] = useState<{ imageTxId: string; fields: CurveCreateFields } | null>(null);
  // A sent create tx whose receipt could not be read, kept so "Check again" can
  // finish the launch from the same tx.
  const [unconfirmed, setUnconfirmed] = useState<SentLaunch | null>(null);

  const publishIdentity = async (token: Address, imageTxId: string, fields: CurveCreateFields) => {
    const metadata = buildIdentityMetadata({
      token,
      chainId,
      imageTxId,
      draft: {
        name: fields.name,
        symbol: fields.symbol,
        description: fields.description,
        website: fields.website,
        twitter: fields.twitter,
        telegram: fields.telegram,
      },
    });
    await uploadJson(metadata, `curve-identity-${token.toLowerCase()}.json`, identityTags(token, chainId));
  };

  const onCreate = async (fields: CurveCreateFields) => {
    try {
      // The gate runs before the image-upload signature and reads the wallet live. No
      // wallet, or a cold, stale or unreadable reading, throws into the catch below, so a
      // refusal signs and sends nothing.
      setStage('reading-heat');
      if (!address) throw new Error('Connect a wallet to launch.');
      await assertMayLaunch(address);

      setStage('uploading-image');
      const imageTxId = await uploadFile(fields.image);

      setStage('awaiting-wallet');
      // Sent from the wallet the gate just read: switching accounts mid-flow cannot hand
      // the create to a wallet nobody read.
      const hash = await writeContractAsync({
        address: launcher,
        abi: CURVE_LAUNCHER_ABI,
        functionName: 'create',
        args: [fields.name, fields.symbol],
        value: fields.openingBuyWei,
        chainId,
        account: address,
      });

      setStage('confirming');
      if (!publicClient) throw new Error('No client for the curve chain.');
      await settleLaunch(await waitForReceiptOutcome(publicClient, hash), { hash, imageTxId, fields });
    } catch (e) {
      setStage('idle');
      toast.error(e instanceof Error ? e.message : 'The wallet rejected the launch.');
    }
  };

  const holdUnconfirmed = (sent: SentLaunch) => {
    setUnconfirmed(sent);
    setStage('unconfirmed');
    surfaceUnconfirmedTx(toast, {
      hash: sent.hash,
      explorerUrl: getTxUrl(chainId, sent.hash),
      repeatCost: 'launching again creates a second coin, with its own opening buy.',
    });
  };

  /**
   * Everything after the create's receipt wait. viem RETURNS a reverted receipt, so
   * 'unreadable' only means the receipt could not be read: the coin may exist, so the
   * form stays held. A create the wallet replaced (a cancel, or another call at its
   * nonce) never ran: the form comes back. Throws on a revert or a missing log.
   */
  const settleLaunch = async (outcome: DirectReceiptOutcome<TransactionReceipt>, sent: SentLaunch) => {
    const { hash, imageTxId, fields } = sent;
    if (outcome.kind === 'unreadable') {
      holdUnconfirmed(sent);
      return;
    }
    if (outcome.kind === 'replaced') {
      setUnconfirmed(null);
      setStage('idle');
      surfaceReceiptNotice(toast, outcome, { hash, chainId, repeatCost: '' });
      return;
    }
    if (outcome.kind === 'reverted') {
      throw new Error('The launch reverted on-chain: no coin was created, and only gas was spent.');
    }
    const { receipt } = outcome;
    const created = parseEventLogs({
      abi: CURVE_LAUNCHER_ABI,
      logs: receipt.logs,
      eventName: 'LaunchCreated',
    }).find((log) => log.address.toLowerCase() === launcher.toLowerCase());
    // The hash that mined: a sped-up create confirmed under a new one.
    if (!created) throw new Error(`Launch confirmed (tx ${receipt.transactionHash ?? hash}) but no LaunchCreated log was found.`);
    const token = created.args.token;
    setCreatedToken(token);
    onCreated?.(token);

    setStage('publishing-identity');
    try {
      await publishIdentity(token, imageTxId, fields);
      setStage('done');
      toast.success('Launch created — your curve is live.');
    } catch {
      // The launch is live; only the off-chain identity is missing.
      setPendingIdentity({ imageTxId, fields });
      setStage('identity-failed');
      toast.error('Launch is live, but publishing the image failed — you can retry.');
    }
  };

  const onRecheck = async () => {
    if (!unconfirmed || !publicClient) return;
    const sent = unconfirmed;
    setStage('confirming');
    try {
      // Still unreadable, or not mined yet: settleLaunch holds it again.
      const outcome = await readReceiptOutcome(publicClient, sent.hash);
      if (outcome.kind !== 'unreadable') setUnconfirmed(null);
      await settleLaunch(outcome, sent);
    } catch (e) {
      setStage('idle');
      toast.error(e instanceof Error ? e.message : 'Could not finish the launch.');
    }
  };

  const onRetryIdentity = async () => {
    if (!createdToken || !pendingIdentity) return;
    setStage('publishing-identity');
    try {
      await publishIdentity(createdToken, pendingIdentity.imageTxId, pendingIdentity.fields);
      setPendingIdentity(null);
      setStage('done');
      toast.success('Identity published.');
    } catch {
      setStage('identity-failed');
      toast.error('Still failing — Arweave may be having a moment. Try again shortly.');
    }
  };

  const onReset = () => {
    setStage('idle');
    setCreatedToken(null);
    setPendingIdentity(null);
    setUnconfirmed(null);
  };

  return (
    <CurveCreateView
      stage={stage}
      createdToken={createdToken}
      onCreate={(fields) => void onCreate(fields)}
      onRetryIdentity={() => void onRetryIdentity()}
      onReset={onReset}
      onTrade={onTrade}
      terms={terms}
      unconfirmedTx={unconfirmed ? { hash: unconfirmed.hash, url: getTxUrl(chainId, unconfirmed.hash) } : null}
      onRecheck={() => void onRecheck()}
    />
  );
}
