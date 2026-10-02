// Polyfill MUST load before any @solana/* import — keep this first.
import '../../../lib/solanaPolyfill';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  describeTreasury,
  formatSol,
  formatTokenAmount,
  parseDecimalToBaseUnits,
  type Read,
} from '../../../lib/launcher/solana/curve';
import { Card, Field, Notice, Row } from './ui';
import {
  DIVIDER,
  bpsPercent,
  feeSplitLabel,
  inputCls,
  inputStyle,
  reserveDisclosure,
  sharePercent,
  supplySentence,
} from './uiFormat';
import { TxFlowView } from './TxFlowView';
import { BeforeYouTrade } from './BeforeYouTrade';
import { WalletNeeded } from './WalletNeeded';
import { clearPendingLaunch, readPendingLaunches, savePendingLaunch, type PendingLaunch } from './pendingLaunch';
import { useReturnFocus, useTxFlow, type OnSent, type OnSettled } from './useTxFlow';
import { liveIpfsUrl } from '../../../lib/ipfsGateways';
import { assertMayLaunch, HeatGateDenied } from '../../../lib/heat/launchGate';
import { IpfsImg } from '../../IpfsImg';
import type {
  ActionAvailability,
  LaunchLinks,
  NotSent,
  OpenGate,
  PlantBalance,
  PreparedImage,
  Prepared,
  TxOutcome,
  UploadResult,
  WriteApi,
  WriteRpc,
} from './ports';
import type { CurveSignerState } from './useCurveSigner';

/** Exact types, so iOS converts a HEIC photo to one of these when it is picked. */
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

/**
 * The launch door at submit: null when `maker` may launch, else the not-sent outcome.
 * Fails closed like launchService.ts: a cold wallet, an unreadable island and any other
 * throw all stop the launch before anything is uploaded, built or signed.
 */
async function doorRefusal(maker: string): Promise<NotSent | null> {
  try {
    await assertMayLaunch(maker);
    return null;
  } catch (e) {
    const message =
      e instanceof HeatGateDenied ? e.message : 'The island could not be read, so the door stays shut. Try again in a moment.';
    return { status: 'not-sent', stage: 'gate', message };
  }
}

/** The plant every launch pays (island ruling 2): 100,000 $BAYLA, in base units (6 decimals). */
const PLANT_TOTAL_RAW = 100_000_000_000n;
const BAYLA_DECIMALS = 6;
const PLANT_TERMS = "100,000 $BAYLA: 50,000 burned, 50,000 to the island's Workshop";
const PLANT_UNREADABLE = 'Could not read your $BAYLA balance.';
/** The island's Workshop (write/plant.ts WORKSHOP_WALLET; the form test signs as it). It cannot plant. */
const WORKSHOP_WALLET = 'G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu';
const PLANT_FROM_WORKSHOP =
  "This wallet is the island's Workshop: it receives half of every plant, so it cannot plant one. Launch from another wallet.";
const baylaText = (raw: bigint) => formatTokenAmount(raw, BAYLA_DECIMALS, BAYLA_DECIMALS).text;

/** Why this wallet cannot plant, or null when it can. A read that failed is never 0 and never enough. */
function plantShortfall(read: Read<PlantBalance>): string | null {
  if (read.kind !== 'ok') return PLANT_UNREADABLE;
  if (read.value.amount < PLANT_TOTAL_RAW) {
    return `Your wallet holds ${baylaText(read.value.amount)} $BAYLA. A launch plants 100,000.`;
  }
  return null;
}

/** The maker's $BAYLA, read through the write layer. A throw is unreadable, never 0. */
async function readPlant(api: WriteApi, rpc: WriteRpc, owner: PublicKey): Promise<Read<PlantBalance>> {
  try {
    return await api.readPlantBalance(rpc, owner);
  } catch (e) {
    return { kind: 'unreadable', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Every other plant refusal the launch build makes (the Workshop's account, its wallet), asked
 *  before the upload request. A throw refuses: it never passes as "can plant". */
async function readPlantStop(api: WriteApi, rpc: WriteRpc, maker: PublicKey): Promise<string | null> {
  try {
    return await api.readPlantRefusal(rpc, maker);
  } catch {
    return 'Could not check that the plant can land just now, so nothing was uploaded or built. Try again.';
  }
}

/** An opening buy above this share of supply gets a plain warning. The program itself sets no limit. */
const LARGE_OPENING_BUY_BPS = 500n;

type Mode = 'checking' | 'upload' | 'paste' | 'unreachable';

/** A launch this browser sent before (a reload, or a trip away), and what the chain says about it now. */
type EarlierLaunch = PendingLaunch & { mint: string; state: 'checking' | 'unknown' | 'landed'; message?: string };

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
  // Every gateway failed or hung for this picture: say so instead of a broken image.
  const [exhausted, setExhausted] = useState<string | null>(null);
  return (
    <div className="rounded-xl p-3 space-y-1.5" style={{ border: '1px solid rgba(251,191,36,0.35)' }} data-testid="public-forever">
      <p className="text-amber-200 font-semibold text-[11px]">Public forever</p>
      <div className="flex items-center gap-3">
        {copy.imageSrc && exhausted !== copy.imageSrc ? (
          <IpfsImg
            src={copy.imageSrc}
            alt="Your token picture"
            width={56}
            height={56}
            referrerPolicy="no-referrer"
            onExhausted={() => setExhausted(copy.imageSrc)}
            className="rounded-lg object-cover"
          />
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
  const [statusCheck, setStatusCheck] = useState(0);
  // Set only when the upload service itself said it is switched off.
  const [uploadsOff, setUploadsOff] = useState(false);
  const [pastedUri, setPastedUri] = useState('');
  const [buyOn, setBuyOn] = useState(false);
  const [buySol, setBuySol] = useState('');
  const [publicCopy, setPublicCopy] = useState<PublicCopy | null>(null);
  const [jsonMismatch, setJsonMismatch] = useState(false);
  const [jsonOtherMint, setJsonOtherMint] = useState(false);

  // Is the upload service there? Only the server saying "off" means paste mode. A
  // failed or slow check is not an answer, so it offers to check again.
  useEffect(() => {
    let live = true;
    meta
      .uploadsAvailable()
      .then((s) => {
        if (!live) return;
        setUploadsOff(s === 'no');
        setMode(s === 'yes' ? 'upload' : s === 'no' ? 'paste' : 'unreachable');
      })
      .catch(() => live && setMode('unreachable'));
    return () => {
      live = false;
    };
  }, [meta, statusCheck]);

  // The preview URL belongs to this component; release it when replaced or unmounted.
  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const signer = signerState.kind === 'ready' ? signerState.signer : null;
  // A Review runs on after the door read. The wallet's signMessage follows the wallet app,
  // not one account, so each step after the read checks that the form is still on screen
  // and that the wallet the door read is still the one connected.
  const alive = useRef(true);
  const liveSigner = useRef(signer);
  useEffect(() => {
    liveSigner.current = signer;
  }, [signer]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

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

  const onSettled = useCallback<OnSettled>(
    (outcome, prepared, sentSignature) => {
      if (!prepared || prepared.summary.kind !== 'create') return;
      const mint = prepared.summary.mint.toBase58();
      // Confirmed, or sent and not yet confirmed: the launch page is where the chain
      // answers. It knows about the pending signature, so it says "still landing"
      // rather than "no such launch".
      if (outcome.status === 'confirmed' || (outcome.status === 'unknown' && outcome.signature)) {
        savePendingLaunch(mint, outcome.signature, prepared.lastValidBlockHeight);
        navigate(`/curve-launch/${mint}`);
      } else if (sentSignature) {
        // Refused, expired, or turned away at the first send: this launch will never
        // appear, so its note (written when it was sent) goes.
        clearPendingLaunch(mint);
      }
    },
    [navigate],
  );
  // The note is written the moment the launch is SENT, before the wait for the
  // network: a reload during that wait must not hand back a fresh form while the first
  // launch can still land.
  const onSent = useCallback<OnSent>((signature, prepared) => {
    if (prepared.summary.kind !== 'create') return;
    savePendingLaunch(prepared.summary.mint.toBase58(), signature, prepared.lastValidBlockHeight);
  }, []);
  const flow = useTxFlow(api, rpc, onSettled, onSent);
  const { target: reviewRef, fallback: headingRef } = useReturnFocus(flow.state.step);
  const [prepNote, setPrepNote] = useState<string | undefined>(undefined);

  // Launches this browser sent that the chain has not answered for. Read whenever the
  // form is (back) on screen, and checked against the chain: refused or expired ones
  // are dropped, one that landed is shown as landed, and anything else holds Review
  // until the creator says their earlier launch did not land.
  const idle = flow.state.step === 'idle';
  const [earlier, setEarlier] = useState<EarlierLaunch[]>(() =>
    readPendingLaunches().map((p) => ({ ...p, state: 'checking' as const })),
  );
  const [earlierDismissed, setEarlierDismissed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!idle) return;
    // The first list comes from the state initializer; later ones replace it when
    // their check is in.
    const notes = readPendingLaunches();
    let live = true;
    void Promise.all(
      notes.map(async (n) => {
        let o: TxOutcome | undefined;
        try {
          o = await api.recheckOutcome(
            rpc,
            n.signature,
            n.lastValidBlockHeight === null ? undefined : { lastValidBlockHeight: n.lastValidBlockHeight },
          );
        } catch {
          o = undefined;
        }
        return { n, o };
      }),
    ).then((checked) => {
      if (!live) return;
      const next: EarlierLaunch[] = [];
      for (const { n, o } of checked) {
        if (o?.status === 'reverted' || o?.status === 'expired') {
          clearPendingLaunch(n.mint);
          continue;
        }
        next.push({
          ...n,
          state: o?.status === 'confirmed' ? 'landed' : 'unknown',
          message: o?.status === 'unknown' ? o.message : o ? undefined : 'Could not check it just now.',
        });
      }
      setEarlier(next);
    });
    return () => {
      live = false;
    };
  }, [idle, api, rpc]);
  const earlierHolds = earlier.some((e) => e.state !== 'landed' && !earlierDismissed.has(e.signature));

  // The wallet's own $BAYLA, which the plant spends from. Read for the signing wallet
  // whenever the form is (back) on screen; a result counts only for the wallet and the
  // read it was asked for, so a switched wallet or "Read again" shows as reading.
  const maker = signer?.publicKey.toBase58() ?? null;
  const [plantCheck, setPlantCheck] = useState(0);
  const [plantRead, setPlantRead] = useState<{ maker: string; check: number; read: Read<PlantBalance> } | null>(null);
  useEffect(() => {
    if (!maker || !idle) return;
    let live = true;
    void readPlant(api, rpc, new PublicKey(maker)).then((read) => {
      if (live) setPlantRead({ maker, check: plantCheck, read });
    });
    return () => {
      live = false;
    };
  }, [api, rpc, maker, idle, plantCheck]);
  const plant = plantRead && plantRead.maker === maker && plantRead.check === plantCheck ? plantRead.read : null;
  const plantBlock = maker === WORKSHOP_WALLET ? PLANT_FROM_WORKSHOP : plant ? plantShortfall(plant) : null;
  // This wallet's last read, kept while a newer one runs: a failed read's "Read again"
  // stays on screen (and under the keyboard) until the next answer.
  const lastPlant = plantRead && plantRead.maker === maker ? plantRead.read : null;
  const plantRereading = lastPlant !== null && plant === null;

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
    !earlierHolds &&
    (mode === 'upload' ? !!image && !!signMessage : mode === 'paste' ? !!uriC?.ok : false) &&
    (!buyOn || !!buyQuote?.ok) &&
    // The plant: read, and at least 100,000 $BAYLA.
    plant !== null &&
    plantBlock === null;

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
    setPrepNote("Reading this wallet's held time from the island before anything is signed…");

    const walletMoved = () => !alive.current || !liveSigner.current?.publicKey.equals(creator);
    const checkAtReview = plantCheck;
    void flow.prepare(async (): Promise<Prepared> => {
      // THE DOOR, AT SUBMIT: read live at every Review, whatever the door above showed. The
      // venue's check only (the program accepts any signer). The maker is the wallet that
      // signs the create; the island pools linked wallets.
      // The plant's balance is read again beside it, so a wallet emptied since the form
      // read it never reaches the upload request; so is every other plant refusal.
      const [refusal, plantNow, plantStop] = await Promise.all([
        doorRefusal(creator.toBase58()),
        readPlant(api, rpc, creator),
        readPlantStop(api, rpc, creator),
      ]);
      // The form shows this read when the flow comes back, never the older one: a refusal
      // and the balance under it must agree, and Review must not light up on a stale read.
      setPlantRead({ maker: creator.toBase58(), check: checkAtReview, read: plantNow });
      if (refusal) return { ok: false, outcome: refusal };
      if (walletMoved()) {
        const message =
          'The connected wallet changed while the door was reading it, so nothing was uploaded or signed. Review again with the wallet you mean to launch from.';
        return { ok: false, outcome: { status: 'not-sent', stage: 'gate', message } };
      }
      const cannotPlant = plantShortfall(plantNow);
      if (cannotPlant) {
        const message = `${cannotPlant} Nothing was uploaded, built or signed.`;
        return { ok: false, outcome: { status: 'not-sent', stage: 'build', message } };
      }
      // The launch build's own words, which already say nothing was built.
      if (plantStop) return { ok: false, outcome: { status: 'not-sent', stage: 'build', message: plantStop } };
      // The wallet opens during this step for the upload request, and the screen must say why.
      setPrepNote(
        mode === 'upload' && !reuse
          ? 'Approve the upload request in your wallet. It is a message to sign, not a transaction, and it costs nothing. Then your picture and details are uploaded, and the launch transaction is built and test-run…'
          : mode === 'paste'
            ? 'Loading your details link, then building the launch transaction and test-running it…'
            : undefined,
      );
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
          if (up.notConfigured) {
            setUploadsOff(true);
            setMode('paste');
          }
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
          imageSrc: img.ok ? liveIpfsUrl(img.value) : null,
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
      if (walletMoved()) {
        const message =
          'The connected wallet changed before the launch transaction was built, so it was not built. Review again with the wallet you mean to launch from.';
        return { ok: false, outcome: { status: 'not-sent', stage: 'build', message } };
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

  /** A field's error, once something was typed into it. */
  const err = (c: { ok: boolean; reason?: string }, raw: string) => (raw.trim() !== '' && !c.ok ? (c.reason ?? null) : null);
  const buyAmountBad = buyOn && buySol.trim() !== '' && (buyLamports === null || buyLamports === 0n);

  // Why Review is off, in words, so a disabled button never leaves someone guessing.
  // Each item is a whole instruction, so the sentence reads right whatever is missing.
  const missing: string[] = [];
  if (earlierHolds) missing.push('check your earlier launch above');
  if (!nameC.ok) missing.push(name.trim() === '' ? 'enter a name' : 'fix the name');
  if (!symbolC.ok) missing.push(symbol.trim() === '' ? 'enter a symbol' : 'fix the symbol');
  if (mode === 'checking') missing.push('wait for the picture upload check to finish');
  if (mode === 'unreachable') missing.push('reach the picture upload service (try again above) or paste a details link');
  if (mode === 'upload' && !image) missing.push(imageBusy ? 'wait for the picture to finish preparing' : 'add a picture');
  if (mode === 'upload' && signer && !signMessage) missing.push('use a wallet that can sign the upload request');
  if (mode === 'paste' && !uriC?.ok) missing.push('add a details link');
  if (mode !== 'paste' && !descC.ok) missing.push('shorten the description');
  if (mode !== 'paste' && !linksC.ok) missing.push('fix the links');
  if (buyOn && !buyQuote?.ok) missing.push('enter an opening buy that can be filled, or untick it');
  if (signer && !plant) missing.push('wait for your $BAYLA balance to be read');
  if (!signer) missing.push('connect a wallet');
  // The plant's reason is its own sentence, after the list.
  const why = [missing.length > 0 ? `Before you can review your launch: ${missing.join('; ')}.` : null, plantBlock]
    .filter((s): s is string => s !== null)
    .join(' ');
  const missingId = useId();

  if (flow.state.step !== 'idle') {
    return (
      <Card title="Launch a token" testId="launch-create-form" headingRef={headingRef}>
        <TxFlowView
          flow={flow}
          api={api}
          cluster={gate.cfg.cluster}
          decimals={6}
          signer={signer}
          preparingText={prepNote}
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
                poolFundPpm={gate.ammConfig.fundFeeRate}
                // Graduation opens the pool with the creator fee switched on.
                poolCreatorPpm={gate.ammConfig.creatorFeeRate}
                reserve={
                  gate.global.platformReserveBps > 0n
                    ? reserveDisclosure(
                        `${bpsPercent(gate.global.platformReserveBps)} of the supply`,
                        describeTreasury(gate.global.feeRecipient),
                        'will',
                      )
                    : null
                }
              />
            </>
          }
        />
      </Card>
    );
  }

  const g = gate.global;
  // Who the reserve goes to, from the settings read from chain. A multisig only when it is the known vault.
  const treasury = describeTreasury(g.feeRecipient);
  return (
    <Card title="Launch a token" testId="launch-create-form" headingRef={headingRef}>
      {!actions.create && (
        <Notice tone="warn">{gate.paused ? 'New launches are paused right now.' : 'Launching is not available right now.'}</Notice>
      )}
      {earlier.length > 0 && (
        <div
          className="rounded-xl p-3 space-y-2"
          style={{ border: '1px solid rgba(251,191,36,0.35)' }}
          data-testid="earlier-launch"
        >
          {earlier.map((e) => (
            <div key={e.signature} className="space-y-1">
              <p role="status" className={e.state === 'landed' ? 'text-emerald-300/90' : 'text-amber-300/90'}>
                {e.state === 'checking'
                  ? 'Checking a launch you sent from this browser…'
                  : e.state === 'landed'
                    ? 'A launch you sent from this browser went through.'
                    : 'A launch you sent from this browser may still be landing. Launching again now could make a second token, and you would pay for both.'}
                {e.state === 'unknown' && e.message ? ` ${e.message}` : ''}
              </p>
              <Row label="Its token address (mint)" value={e.mint} />
              <Link to={`/curve-launch/${e.mint}`} className="underline text-white/80 inline-flex items-center min-h-[44px]">
                Open that launch&apos;s page
              </Link>
            </div>
          ))}
          {earlierHolds && (
            <button
              type="button"
              className="btn-secondary w-full py-2 text-[12px] min-h-[44px]"
              onClick={() => setEarlierDismissed(new Set(earlier.map((e) => e.signature)))}
            >
              My earlier launch did not land: start a new one
            </button>
          )}
        </div>
      )}
      <p>One transaction creates your token, its details and its bonding curve. {supplySentence(g.platformReserveBps, treasury)}</p>

      <Field
        label="Name"
        hint={`Up to ${meta.LIMITS.nameBytes} characters (emoji and accented letters count as more than one).`}
        error={err(nameC, name)}
      >
        {(a11y) => (
          <input
            className={inputCls}
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            {...a11y}
          />
        )}
      </Field>
      <Field
        label="Symbol"
        hint={`${meta.LIMITS.symbolMin} to ${meta.LIMITS.symbolMax} letters A to Z or digits.`}
        error={err(symbolC, symbol)}
      >
        {(a11y) => (
          <input
            className={`${inputCls} font-mono uppercase`}
            style={inputStyle}
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            spellCheck={false}
            autoCapitalize="characters"
            {...a11y}
          />
        )}
      </Field>

      {mode === 'checking' && <Notice>Checking the picture upload service…</Notice>}
      {mode === 'unreachable' && (
        <div className="space-y-1.5" data-testid="upload-unreachable">
          <Notice tone="warn">We could not reach the picture upload service. This is often a brief network problem.</Notice>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary px-4 py-2 text-[12px]"
              onClick={() => {
                setMode('checking');
                setStatusCheck((n) => n + 1);
              }}
            >
              Try again
            </button>
            <button type="button" className="underline text-white/70 min-h-[44px] px-1" onClick={() => setMode('paste')}>
              Paste a details link instead
            </button>
          </div>
        </div>
      )}
      {mode === 'upload' && (
        <Field label="Picture" hint="Required. PNG, JPEG, WebP or GIF. Large photos are shrunk to fit 1 MB." error={imageError}>
          {(a11y) => (
            <>
              <input
                type="file"
                accept={IMAGE_ACCEPT}
                className="block w-full text-white/70 text-[12px]"
                onChange={(e) => void onPickImage(e.target.files?.[0] ?? null)}
                {...a11y}
              />
              {imageBusy && (
                <span role="status" className="text-white/50 text-[10px] block mt-1">
                  Preparing the picture…
                </span>
              )}
              {imageUrl && (
                <img src={imageUrl} alt="Picture preview" width={72} height={72} className="rounded-lg object-cover mt-2" />
              )}
            </>
          )}
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
          hint={`${uploadsOff ? 'Picture uploads are not switched on for this site yet. ' : ''}Paste a link to your token's details file: ipfs://…, a gateway link with /ipfs/ in it, or https://arweave.net/…`}
          error={uriC ? err(uriC, pastedUri) : null}
        >
          {(a11y) => (
            <input
              className={inputCls}
              style={inputStyle}
              value={pastedUri}
              onChange={(e) => setPastedUri(e.target.value)}
              spellCheck={false}
              {...a11y}
            />
          )}
        </Field>
      )}

      {mode !== 'paste' && (
        <>
          <Field
            label="Description (optional)"
            hint={`Up to ${meta.LIMITS.descriptionChars} characters.`}
            error={err(descC, description)}
          >
            {(a11y) => (
              <textarea
                className={inputCls}
                style={inputStyle}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                {...a11y}
              />
            )}
          </Field>
          {(['website', 'twitter', 'telegram'] as const).map((k) => (
            <Field
              key={k}
              label={`${LINK_NAME[k]} link (optional)`}
              // The error sits under the link it is about, named the way the form names it.
              error={!linksC.ok && linksC.field === k ? `${LINK_NAME[k]} link: ${linksC.reason}` : null}
            >
              {(a11y) => (
                <input
                  className={inputCls}
                  style={inputStyle}
                  value={links[k] ?? ''}
                  onChange={(e) => setLinks((l) => ({ ...l, [k]: e.target.value }))}
                  spellCheck={false}
                  inputMode="url"
                  {...a11y}
                />
              )}
            </Field>
          ))}
          {!linksC.ok && !(linksC.field in LINK_NAME) && <Notice tone="warn">{linksC.reason}</Notice>}
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
          <Field
            label="Opening buy (SOL)"
            hint="The trade fee comes out of this amount. No price tolerance applies: nothing can trade before it."
            error={buyAmountBad ? 'Enter an amount of SOL, like 0.5.' : null}
          >
            {(a11y) => (
              <input
                className={inputCls}
                style={inputStyle}
                value={buySol}
                onChange={(e) => setBuySol(e.target.value)}
                inputMode="decimal"
                placeholder="0.0"
                {...a11y}
              />
            )}
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
          value={
            g.platformReserveBps === 0n
              ? 'none'
              : `${bpsPercent(g.platformReserveBps)} of supply, sent to ${treasury.name} when the token is created. You also pay the rent for the treasury's token account; the review shows it.`
          }
          mono={false}
        />
      </div>

      {/* The plant is the site's, not the program's: the same for every launch made here. */}
      <div className="pt-2 space-y-1.5" style={DIVIDER} data-testid="plant-terms">
        <div className="pt-2">
          <Row label="Plant" value={PLANT_TERMS} mono={false} />
        </div>
        {signer && (
          // A live region, so the answer to a read (and a Read again) is read out.
          <div role="status">
            <Row
              label="Your $BAYLA"
              value={!plant ? 'reading…' : plant.kind === 'ok' ? `${baylaText(plant.value.amount)} $BAYLA` : 'could not read'}
              mono={false}
            />
          </div>
        )}
        {lastPlant && lastPlant.kind !== 'ok' && (
          <button
            type="button"
            className={`btn-secondary px-4 py-2 text-[12px] min-h-[44px] ${plantRereading ? 'opacity-60' : ''}`}
            // Not `disabled`, as TxFlowView's Check again: a button switched off under the
            // keyboard drops focus to the page. It does nothing while the read runs.
            aria-disabled={plantRereading || undefined}
            onClick={() => {
              if (!plantRereading) setPlantCheck((n) => n + 1);
            }}
          >
            {plantRereading ? 'Reading…' : 'Read again'}
          </button>
        )}
      </div>

      <WalletNeeded state={signerState} />
      {!ready && !flow.locked && actions.create && why !== '' && (
        <p id={missingId} className="text-white/70 text-[11px]" data-testid="review-missing">
          {why}
        </p>
      )}
      <button
        ref={reviewRef}
        type="button"
        className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-60"
        disabled={!ready}
        onClick={review}
        aria-describedby={!ready && why !== '' ? missingId : undefined}
      >
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
