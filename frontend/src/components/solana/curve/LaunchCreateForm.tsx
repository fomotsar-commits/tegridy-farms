// Polyfill MUST load before any @solana/* import — keep this first.
import '../../../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Keypair } from '@solana/web3.js';
import { formatSol, formatTokenAmount, parseDecimalToBaseUnits } from '../../../lib/launcher/solana/curve';
import { Card, Field, Notice, Row } from './ui';
import { DIVIDER, bpsPercent, feeSplitLabel, inputCls, inputStyle, sharePercent, supplySentence } from './uiFormat';
import { TxFlowView } from './TxFlowView';
import { BeforeYouTrade } from './BeforeYouTrade';
import { WalletNeeded } from './WalletNeeded';
import { savePendingLaunch } from './pendingLaunch';
import { useTxFlow } from './useTxFlow';
import type {
  ActionAvailability,
  LaunchLinks,
  OpenGate,
  PreparedImage,
  Prepared,
  PreparedTx,
  TxOutcome,
  UploadResult,
  WriteApi,
  WriteRpc,
} from './ports';
import type { CurveSignerState } from './useCurveSigner';

/** Exact types, so iOS converts a HEIC photo to one of these when it is picked. */
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
/** An opening buy above this share of supply gets a plain warning. The program itself sets no limit. */
const LARGE_OPENING_BUY_BPS = 500n;

type Mode = 'checking' | 'upload' | 'paste';

const LINK_NAME = { website: 'Website', twitter: 'X', telegram: 'Telegram' } as const;

interface PublicCopy {
  name: string;
  symbol: string;
  description: string;
  imageSrc: string | null;
  links: LaunchLinks;
  mint: string;
  creator: string;
}

/**
 * What goes on chain and on IPFS forever, shown on the review before the wallet
 * opens. Built from the values actually uploaded, not from the form.
 */
function PublicForever({ copy, display }: { copy: PublicCopy; display: (s: string, n: number) => string }) {
  return (
    <div className="rounded-xl p-3 space-y-1.5" style={{ border: '1px solid rgba(251,191,36,0.35)' }} data-testid="public-forever">
      <p className="text-amber-200 font-semibold text-[11px]">Public forever</p>
      <div className="flex items-center gap-3">
        {copy.imageSrc ? (
          <img src={copy.imageSrc} alt="Your token picture" width={56} height={56} className="rounded-lg object-cover" />
        ) : (
          <span className="text-white/50">No picture could be shown.</span>
        )}
        <div className="min-w-0">
          <p className="text-white break-words">{display(copy.name, 32)}</p>
          <p className="text-white/70 font-mono break-all">{display(copy.symbol, 10)}</p>
        </div>
      </div>
      {copy.description && <p className="text-white/70 break-words whitespace-pre-line">{display(copy.description, 280)}</p>}
      {(['website', 'twitter', 'telegram'] as const).map((k) =>
        copy.links[k] ? <Row key={k} label={LINK_NAME[k]} value={copy.links[k] ?? ''} /> : null,
      )}
      <Row label="Creator wallet (you)" value={copy.creator} />
      <Row label="Token address (mint)" value={copy.mint} />
      <p className="text-amber-100/90">
        Name, symbol and picture can never be changed, and no more tokens can ever be made.
      </p>
    </div>
  );
}

export interface LaunchCreateFormProps {
  api: WriteApi;
  rpc: WriteRpc;
  gate: OpenGate;
  actions: ActionAvailability;
  signerState: CurveSignerState;
}

export function LaunchCreateForm({ api, rpc, gate, actions, signerState }: LaunchCreateFormProps) {
  const meta = api.meta;
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [links, setLinks] = useState<LaunchLinks>({});
  const [image, setImage] = useState<PreparedImage | null>(null);
  const imageId = useRef(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('checking');
  const [pastedUri, setPastedUri] = useState('');
  const [buyOn, setBuyOn] = useState(false);
  const [buySol, setBuySol] = useState('');
  const [publicCopy, setPublicCopy] = useState<PublicCopy | null>(null);
  const [jsonMismatch, setJsonMismatch] = useState(false);
  const [jsonOtherMint, setJsonOtherMint] = useState(false);

  // Is the upload service there? Anything but a clear yes means paste mode.
  useEffect(() => {
    let live = true;
    meta
      .uploadsAvailable()
      .then((ok) => live && setMode(ok ? 'upload' : 'paste'))
      .catch(() => live && setMode('paste'));
    return () => {
      live = false;
    };
  }, [meta]);

  // The preview URL belongs to this component; release it when replaced or unmounted.
  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const signer = signerState.kind === 'ready' ? signerState.signer : null;

  const nameC = meta.checkName(name);
  const symbolC = meta.checkSymbol(symbol);
  const descC = meta.checkDescription(description);
  const cleanLinks = useMemo(() => {
    const l: LaunchLinks = {};
    for (const k of ['website', 'twitter', 'telegram'] as const) if (links[k]?.trim()) l[k] = links[k]!.trim();
    return l;
  }, [links]);
  const linksC = meta.checkLinks(cleanLinks);
  const uriC = mode === 'paste' ? meta.checkContentUri(pastedUri) : null;

  const buyLamports = buyOn ? parseDecimalToBaseUnits(buySol, 9) : null;
  const buyQuote = buyOn && buyLamports !== null && buyLamports > 0n ? api.quoteOpeningBuy(gate.global, buyLamports) : null;
  const buyShareBps =
    buyQuote?.ok && gate.global.tokenTotalSupply > 0n ? (buyQuote.value.tokensOut * 10_000n) / gate.global.tokenTotalSupply : null;

  const onPickImage = useCallback(
    async (file: File | null) => {
      const id = ++imageId.current;
      setImage(null);
      setImageUrl(null);
      setImageError(null);
      if (!file) return;
      setImageBusy(true);
      // Shrinks a phone photo to fit 1 MB and strips its hidden location data. The
      // bytes shown in the preview are the bytes that get uploaded.
      const r = await meta.prepareLaunchImage(file).catch(
        () => ({ ok: false, reason: 'That picture could not be read. Pick a PNG, JPEG, WebP or GIF.' }) as const,
      );
      if (id !== imageId.current) return;
      setImageBusy(false);
      if (!r.ok) {
        setImageError(r.reason);
        return;
      }
      setImage(r.image);
      setImageUrl(URL.createObjectURL(new Blob([r.image.bytes as BlobPart], { type: r.image.mime })));
    },
    [meta],
  );

  const onSettled = useCallback(
    (outcome: TxOutcome, prepared: PreparedTx | null) => {
      if (!prepared || prepared.summary.kind !== 'create') return;
      const mint = prepared.summary.mint.toBase58();
      // Confirmed, or sent and not yet confirmed: the launch page is where the chain
      // answers. It knows about the pending signature, so it says "still landing"
      // rather than "no such launch".
      if (outcome.status === 'confirmed' || (outcome.status === 'unknown' && outcome.signature)) {
        savePendingLaunch(mint, outcome.signature, prepared.lastValidBlockHeight);
        navigate(`/curve-launch/${mint}`);
      }
    },
    [navigate],
  );
  const flow = useTxFlow(api, rpc, onSettled);

  // The mint keypair lives in memory only. A reload or a wallet round trip loses it,
  // and then everything starts again with a new keypair and a new upload. The one
  // reuse: pressing Review again with the SAME details, picture and wallet, inside
  // the upload's reuse window, keeps that keypair and its upload, so the wallet is
  // not asked to sign the upload twice. Details uploaded for one mint never go with
  // another.
  const attempt = useRef(0);
  const uploadCache = useRef<{ key: string; mint: Keypair; up: Extract<UploadResult, { ok: true }> } | null>(null);
  const signMessage = signerState.kind === 'ready' ? signerState.signMessage : null;

  const ready =
    actions.create &&
    !!signer &&
    nameC.ok &&
    symbolC.ok &&
    // In paste mode the description and links live in the pasted file, not the form.
    (mode === 'paste' || (descC.ok && linksC.ok)) &&
    !flow.locked &&
    (mode === 'upload' ? !!image && !!signMessage : mode === 'paste' ? !!uriC?.ok : false) &&
    (!buyOn || !!buyQuote?.ok);

  const review = () => {
    if (!ready || !signer || !nameC.ok || !symbolC.ok) return;
    const my = ++attempt.current;
    const creator = signer.publicKey;
    const cacheKey = JSON.stringify([nameC.value, symbolC.value, description, cleanLinks, creator.toBase58(), imageId.current]);
    const cached = uploadCache.current;
    const reuse = mode === 'upload' && cached !== null && cached.key === cacheKey && Date.now() < cached.up.reuseUntil;
    const mint = reuse && cached ? cached.mint : Keypair.generate();
    const mintStr = mint.publicKey.toBase58();
    const openingBuy = buyOn && buyLamports !== null ? { lamportsIn: buyLamports, slippageBps: 0n } : undefined;
    setPublicCopy(null);
    setJsonMismatch(false);
    setJsonOtherMint(false);

    void flow.prepare(async (): Promise<Prepared> => {
      let uri: string;
      let copy: PublicCopy;
      if (mode === 'upload' && image) {
        if (!descC.ok || !linksC.ok || !signMessage) {
          return { ok: false, outcome: { status: 'not-sent', stage: 'build', message: 'The details are not complete.' } };
        }
        // The wallet signs a short message naming exactly what is pinned; nothing is
        // pinned without it. This is not the launch transaction.
        const up =
          reuse && cached
            ? cached.up
            : await meta.uploadLaunchMetadata({
                image,
                name: nameC.value,
                symbol: symbolC.value,
                description: descC.value,
                links: linksC.value,
                mint: mintStr,
                creator: creator.toBase58(),
                signMessage,
              });
        if (!up.ok) {
          uploadCache.current = null;
          if (up.notConfigured) setMode('paste');
          return {
            ok: false,
            outcome: {
              status: 'not-sent',
              stage: 'build',
              message: `The picture and details could not be uploaded: ${up.reason}${up.retryable ? ' Try again in a moment.' : ''}`,
            },
          };
        }
        uploadCache.current = { key: cacheKey, mint, up };
        uri = up.metadataUri;
        copy = {
          name: up.metadata.name,
          symbol: up.metadata.symbol,
          description: up.metadata.description,
          imageSrc: imageUrl,
          links: pickLinks(up.metadata),
          mint: mintStr,
          creator: creator.toBase58(),
        };
      } else if (uriC?.ok) {
        uri = uriC.value;
        // Paste mode: show the buyer's view of that link before anything is signed.
        const r = await meta.readLaunchMetadataJson(uri, mintStr);
        if (r.kind !== 'ok') {
          return {
            ok: false,
            outcome: {
              status: 'not-sent',
              stage: 'build',
              message:
                r.kind === 'invalid'
                  ? `That link does not hold valid token details: ${r.reason}`
                  : `That link could not be loaded, so we cannot show you what buyers will see: ${r.detail}`,
            },
          };
        }
        const img = r.json.image ? meta.checkContentUri(r.json.image) : ({ ok: false, reason: '' } as const);
        setJsonMismatch(r.json.name !== nameC.value || r.json.symbol !== symbolC.value);
        // The token's address is new, so a file that names one names ANOTHER token.
        setJsonOtherMint(r.json.mint !== null && !r.mintMatches);
        copy = {
          name: nameC.value,
          symbol: symbolC.value,
          description: r.json.description ?? '',
          imageSrc: img.ok ? img.value : null,
          links: pickLinks(r.json),
          mint: mintStr,
          creator: creator.toBase58(),
        };
      } else {
        return { ok: false, outcome: { status: 'not-sent', stage: 'build', message: 'The details are not complete.' } };
      }
      if (my !== attempt.current) {
        return { ok: false, outcome: { status: 'not-sent', stage: 'build', message: 'A newer attempt replaced this one.' } };
      }
      setPublicCopy(copy);
      return api.prepareCreateLaunch(rpc, gate, {
        creator,
        mint,
        metadata: { name: nameC.value, symbol: symbolC.value, uri },
        openingBuy,
      });
    });
  };

  const err = (c: { ok: boolean; reason?: string }, raw: string) =>
    raw.trim() !== '' && !c.ok ? <span className="text-rose-300/90 text-[10px] block mt-1">{c.reason}</span> : null;

  if (flow.state.step !== 'idle') {
    return (
      <Card title="Launch a token" testId="launch-create-form">
        <TxFlowView
          flow={flow}
          api={api}
          cluster={gate.cfg.cluster}
          decimals={6}
          signer={signer}
          extraReview={
            <>
              {publicCopy && <PublicForever copy={publicCopy} display={meta.displaySafe} />}
              {publicCopy && jsonMismatch && (
                <Notice tone="warn">
                  The name or symbol inside the link you pasted differs from what you typed. Buyers see the typed ones
                  on chain and the link&apos;s ones in some apps.
                </Notice>
              )}
              {publicCopy && jsonOtherMint && (
                <Notice tone="warn">
                  The link you pasted was made for a different token. Every page on this site will show your launch
                  with a &ldquo;Copied details&rdquo; warning. Use a details file that does not name a token address.
                </Notice>
              )}
              <BeforeYouTrade
                bare
                curveFeeBps={gate.global.tradeFeeBps}
                creatorShareBps={gate.global.creatorFeeShareBps}
                poolFeePpm={gate.ammConfig.tradeFeeRate}
                poolProtocolPpm={gate.ammConfig.protocolFeeRate}
                reserve={
                  gate.global.platformReserveBps > 0n ? `${bpsPercent(gate.global.platformReserveBps)} of the supply` : null
                }
              />
            </>
          }
        />
      </Card>
    );
  }

  const g = gate.global;
  return (
    <Card title="Launch a token" testId="launch-create-form">
      {!actions.create && (
        <Notice tone="warn">{gate.paused ? 'New launches are paused right now.' : 'Launching is not available right now.'}</Notice>
      )}
      <p>One transaction creates your token, its details and its bonding curve. {supplySentence(g.platformReserveBps)}</p>

      <Field label="Name" hint={`Up to ${meta.LIMITS.nameBytes} bytes.`}>
        <input className={inputCls} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} aria-label="Token name" spellCheck={false} />
        {err(nameC, name)}
      </Field>
      <Field label="Symbol" hint={`${meta.LIMITS.symbolMin} to ${meta.LIMITS.symbolMax} letters A to Z or digits.`}>
        <input
          className={`${inputCls} font-mono uppercase`}
          style={inputStyle}
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          aria-label="Token symbol"
          spellCheck={false}
          autoCapitalize="characters"
        />
        {err(symbolC, symbol)}
      </Field>

      {mode === 'checking' && <Notice>Checking the picture upload service…</Notice>}
      {mode === 'upload' && (
        <Field label="Picture" hint="PNG, JPEG, WebP or GIF. Large photos are shrunk to fit 1 MB.">
          <input
            type="file"
            accept={IMAGE_ACCEPT}
            aria-label="Token picture"
            className="block w-full text-white/70 text-[12px]"
            onChange={(e) => void onPickImage(e.target.files?.[0] ?? null)}
          />
          {imageBusy && <span className="text-white/50 text-[10px] block mt-1">Preparing the picture…</span>}
          {imageError && <span className="text-rose-300/90 text-[10px] block mt-1">{imageError}</span>}
          {imageUrl && <img src={imageUrl} alt="Picture preview" width={72} height={72} className="rounded-lg object-cover mt-2" />}
        </Field>
      )}
      {mode === 'upload' && signerState.kind === 'ready' && !signMessage && (
        <Notice tone="warn">
          This wallet cannot sign the upload request, so the picture cannot be uploaded from it.{' '}
          <button type="button" className="underline" onClick={() => setMode('paste')}>
            Paste a details link instead
          </button>
          .
        </Notice>
      )}
      {mode === 'paste' && (
        <Field
          label="Details link"
          hint="Picture uploads are not available on this site yet. Paste a link to your token's details file: https://ipfs.io/ipfs/… or https://arweave.net/…"
        >
          <input
            className={inputCls}
            style={inputStyle}
            value={pastedUri}
            onChange={(e) => setPastedUri(e.target.value)}
            aria-label="Token details link"
            spellCheck={false}
          />
          {uriC && err(uriC, pastedUri)}
        </Field>
      )}

      {mode !== 'paste' && (
        <>
          <Field label="Description (optional)" hint={`Up to ${meta.LIMITS.descriptionChars} characters.`}>
            <textarea
              className={inputCls}
              style={inputStyle}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-label="Token description"
            />
            {err(descC, description)}
          </Field>
          {(['website', 'twitter', 'telegram'] as const).map((k) => (
            <Field key={k} label={`${LINK_NAME[k]} link (optional)`}>
              <input
                className={inputCls}
                style={inputStyle}
                value={links[k] ?? ''}
                onChange={(e) => setLinks((l) => ({ ...l, [k]: e.target.value }))}
                aria-label={`${LINK_NAME[k]} link`}
                spellCheck={false}
                inputMode="url"
              />
            </Field>
          ))}
          {!linksC.ok && <Notice tone="warn">{`${linksC.field}: ${linksC.reason}`}</Notice>}
        </>
      )}

      <div className="pt-2 space-y-2" style={DIVIDER}>
        <label className="flex items-start gap-2 pt-2 text-white/80 cursor-pointer">
          <input type="checkbox" checked={buyOn} onChange={(e) => setBuyOn(e.target.checked)} className="mt-0.5" />
          <span>
            Your opening buy (optional). You buy first, in the same transaction, at the starting price. Everyone can see
            the creator bought: it is shown on your launch page.
          </span>
        </label>
        {buyOn && (
          <Field label="Opening buy (SOL)" hint="The trade fee comes out of this amount. No price tolerance applies: nothing can trade before it.">
            <input
              className={inputCls}
              style={inputStyle}
              value={buySol}
              onChange={(e) => setBuySol(e.target.value)}
              inputMode="decimal"
              placeholder="0.0"
              aria-label="Opening buy in SOL"
            />
          </Field>
        )}
        {buyQuote && !buyQuote.ok && <Notice tone="warn">That opening buy cannot be filled at the starting price.</Notice>}
        {buyQuote?.ok && (
          <>
            <Row
              label="You get"
              value={`${formatTokenAmount(buyQuote.value.tokensOut, 6).text}${
                buyShareBps !== null ? ` (${sharePercent(buyQuote.value.tokensOut, g.tokenTotalSupply)} of supply)` : ''
              }`}
            />
            <Row label="You pay" value={`${formatSol(buyQuote.value.lamportsIn)} SOL (fee ${formatSol(buyQuote.value.feeLamports)} SOL)`} />
            {buyShareBps !== null && buyShareBps > LARGE_OPENING_BUY_BPS && (
              <Notice tone="warn">
                That is more than 5% of the supply. Buyers will see it, and a large creator stake makes people trust a
                launch less.
              </Notice>
            )}
          </>
        )}
      </div>

      <div className="pt-2 space-y-1.5" style={DIVIDER}>
        <p className="text-white/50 pt-2">Every launch gets the same terms, read from the program just now:</p>
        <Row label="Trade fee" value={bpsPercent(g.tradeFeeBps)} />
        <Row label="Fee split" value={feeSplitLabel(g.creatorFeeShareBps) ?? 'could not read'} mono={false} />
        <Row label="Graduates at" value={`${formatSol(g.graduationTargetLamports + g.migrationReserveLamports)} SOL raised`} />
        <Row
          label="…of which migration reserve"
          value={`${formatSol(g.migrationReserveLamports)} SOL, covers opening the pool; what is left goes to the platform`}
          mono={false}
        />
        <Row
          label="Platform reserve"
          value={g.platformReserveBps === 0n ? 'none' : `${bpsPercent(g.platformReserveBps)} of supply, released only after graduation`}
          mono={false}
        />
      </div>

      <WalletNeeded state={signerState} />
      <button type="button" className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-60" disabled={!ready} onClick={review}>
        Review launch
      </button>
      <p className="text-white/35 text-[10px]">
        {mode === 'upload'
          ? 'Review asks your wallet to sign a short upload request (not a transaction), uploads your picture and details, then builds the launch transaction and test-runs it.'
          : 'Review loads your details link, then builds the launch transaction and test-runs it.'}{' '}
        The launch is signed only when you press Sign in wallet on the next step.
      </p>
    </Card>
  );
}

function pickLinks(j: { website?: string; twitter?: string; telegram?: string }): LaunchLinks {
  const l: LaunchLinks = {};
  if (j.website) l.website = j.website;
  if (j.twitter) l.twitter = j.twitter;
  if (j.telegram) l.telegram = j.telegram;
  return l;
}
