/**
 * SHARE THE RECEIPT, AND STILL SAY WHERE IT HAPPENED.
 *
 * "Share to X" used to post `Just <verb> on @JungleBayAC! 🌿 #<room> #DeFi` plus a
 * bare Etherscan link: a slogan that told a reader nothing. The owner's call
 * (2026-10-02): post the receipt block itself (venue, rule, action, the numbers,
 * the tx link) and KEEP the @JungleBayAC mention and the hashtag that follows the
 * active room. Everything fits in X's 280, counted the way X counts, and when it
 * does not fit the receipt is trimmed: the mention and the tag are never cut.
 *
 * And every call that needs the click's user gesture (the share sheet, the
 * clipboard write, the X window) happens INSIDE the click. A browser such as iOS
 * Safari refuses those calls once the click handler has awaited something, so the
 * card is rendered ahead of time instead of on the click. The tests model that
 * browser: each of those calls is refused unless it arrives during the tap.
 *
 * Only a phone or tablet gets the share sheet (the owner's call, 2026-10-02):
 * desktop browsers also accept files there, but X is rarely in a desktop sheet,
 * so a desktop gets the X window and the card on the clipboard. Closing the
 * sheet on a phone still leaves a link to X.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { TransactionReceiptProvider } from './TransactionReceipt';
import { useTransactionReceipt } from '../hooks/useTransactionReceipt';
import { BUNGALOW_STORAGE_KEY } from '../lib/bungalows';

// jsdom has no real canvas. Failing the render is the honest default and drives
// the "could not copy" branch; flip `works` to exercise the paths that need a PNG.
const canvasState = vi.hoisted(() => ({ works: false }));
const html2canvasMock = vi.hoisted(() =>
  vi.fn(async (_el: HTMLElement, _opts?: unknown) => {
    if (!canvasState.works) throw new Error('no canvas in jsdom');
    return {
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['fake-png'], { type: 'image/png' })),
    };
  }),
);
vi.mock('html2canvas', () => ({ default: html2canvasMock }));

const HASH = `0x${'ab'.repeat(32)}`;

const STAKE = {
  amount: '50000',
  token: 'TOWELI',
  lockDuration: '4 Years',
  boost: '4.00',
  estimatedAPR: '1237.33',
};

function Opener({ type = 'stake', data }: { type?: string; data: Record<string, unknown> }) {
  const { showReceipt } = useTransactionReceipt();
  return <button onClick={() => showReceipt({ type, data } as never)}>open receipt</button>;
}

/** Open a receipt. With a tx hash, the receipt wait is set to a confirmed success. */
function openReceipt(data: Record<string, unknown> = STAKE, type = 'stake') {
  if (typeof data.txHash === 'string') {
    wagmiMock.setWriteStatus({ hash: data.txHash as `0x${string}`, isSuccess: true, receiptStatus: 'success' });
  }
  render(
    <TransactionReceiptProvider>
      <Opener type={type} data={data} />
    </TransactionReceiptProvider>,
  );
  fireEvent.click(screen.getByText('open receipt'));
  return screen.getByRole('dialog');
}

/* ─── The gesture model ───
   `inGesture` is true only while a tap is being dispatched, which is exactly the
   window in which a strict browser honours a popup, a share sheet or a clipboard
   write. Anything the component awaits first lands after it has closed. */
let inGesture = false;
function tap(el: HTMLElement) {
  inGesture = true;
  try {
    fireEvent.click(el);
  } finally {
    inGesture = false;
  }
}
const notAllowed = () => new DOMException('not in a user gesture', 'NotAllowedError');

type Popup = { url: string; inGesture: boolean };
let popups: Popup[];
/** Ordered log of the gesture-bound calls, to read what happened before what. */
let calls: string[];

class FakeClipboardItem {
  readonly items: Record<string, Blob | PromiseLike<Blob>>;
  constructor(items: Record<string, Blob | PromiseLike<Blob>>) { this.items = items; }
  get types() { return Object.keys(this.items); }
  getType(t: string) { return Promise.resolve(this.items[t]); }
}

/**
 * A clipboard that, like Safari's or Firefox's, refuses outside the gesture and
 * fails when an item's data never arrives. `images: false` refuses every picture
 * (a denied permission); `lateText: true` takes text after the tap, as Chrome does.
 */
function installClipboard({ images = true, lateText = false } = {}) {
  const write = vi.fn((items: FakeClipboardItem[]) => {
    calls.push('clipboard.write');
    if (!inGesture || !images) return Promise.reject(notAllowed());
    return Promise.all(items.flatMap((i) => i.types.map((t) => i.getType(t)))).then(() => undefined);
  });
  const writeText = vi.fn((_t: string) => {
    calls.push(inGesture ? 'clipboard.writeText' : 'clipboard.writeText (after the tap)');
    return inGesture || lateText ? Promise.resolve() : Promise.reject(notAllowed());
  });
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  return { write, writeText };
}

/**
 * What the device's main pointer is: a finger on a phone or tablet ('coarse'),
 * or a mouse or trackpad ('fine'). jsdom has no matchMedia at all, which the
 * receipt must read as a desktop.
 */
function stubPointer(kind: 'coarse' | 'fine') {
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: media === '(pointer: coarse)' ? kind === 'coarse' : media === '(pointer: fine)' && kind === 'fine',
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

/** A share sheet that takes files, refuses outside the gesture, or fails as told. */
function installShareSheet(outcome: 'ok' | 'abort' | 'error' = 'ok') {
  const share = vi.fn((_data: { files?: File[]; text?: string }) => {
    calls.push('share');
    if (!inGesture) return Promise.reject(notAllowed());
    if (outcome === 'abort') return Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (outcome === 'error') return Promise.reject(new Error('share target failed'));
    return Promise.resolve();
  });
  return { share, canShare: (d: { files?: File[] }) => Array.isArray(d?.files) };
}

function stubNavigator(extra: Record<string, unknown>) {
  vi.stubGlobal('navigator', { ...navigator, ...extra });
}

/** The `text` param of the X intent the last popup opened. */
function sharedText(): string {
  const url = new URL(popups.at(-1)!.url);
  return url.searchParams.get('text') ?? '';
}

/** Wait until the card's render ahead of any tap has finished: a PNG, or a failure. */
async function cardRendered() {
  await waitFor(() => expect(html2canvasMock).toHaveBeenCalled(), { timeout: 3000 });
  await act(async () => {
    await Promise.resolve(html2canvasMock.mock.results.at(-1)!.value).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
  });
}

/* ─── X's character count ───
   An independent model of twitter-text's v3 config, which X uses: a code point
   counts 1 in U+0000-U+10FF and three punctuation ranges, 2 everywhere else
   (CJK, emoji, the box-drawing rule), and every link counts 23 whatever its
   length, including a bare domain such as MEMETICS.FINANCE. */
function xWeight(text: string): number {
  const one = (cp: number) =>
    cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
  return text.split(/(\s+)/).reduce((n, word) => {
    if (/^https?:\/\/\S+$/.test(word) || /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}$/i.test(word)) return n + 23;
    let w = 0;
    for (const ch of word) w += one(ch.codePointAt(0)!) ? 1 : 2;
    return n + w;
  }, 0);
}

beforeEach(() => {
  wagmiMock.reset();
  canvasState.works = false;
  html2canvasMock.mockClear();
  inGesture = false;
  popups = [];
  calls = [];
  vi.stubGlobal('open', vi.fn((url: string) => {
    calls.push('open');
    popups.push({ url, inGesture });
    // A popup blocker returns null for a window opened outside the gesture.
    return inGesture ? ({ closed: false } as unknown as Window) : null;
  }));
  localStorage.removeItem(BUNGALOW_STORAGE_KEY);
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(BUNGALOW_STORAGE_KEY);
});

const shareButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: /share to x/i });

describe('receipt share: the composed post', () => {
  it('posts the receipt fields in order: venue, rule, action, amount, lock, boost, APR, then the tx link', async () => {
    const dialog = openReceipt({ ...STAKE, txHash: HASH });
    tap(shareButton(dialog));
    await waitFor(() => expect(popups.length).toBe(1));
    const lines = sharedText().split('\n');

    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const order = [
      at(/^\u{1F33F} MEMETICS\.FINANCE$/u),
      at(/^\u{2501}{30}$/u),
      at(/^LOCKED DOWN, HELD TIME ON$/),
      at(/^Amount: 50000\.0000 TOWELI$/),
      at(/^Lock Duration: 4 Years$/),
      at(/^Boost: 4\.00x$/),
      at(/^Est\. APR: 1237\.33%$/),
      at(new RegExp(`^Tx: https://etherscan\\.io/tx/${HASH}$`)),
    ];
    expect(order.every((i) => i >= 0), `missing a receipt line in:\n${lines.join('\n')}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // None of the slogan it replaced, and no separate `url=` (which made the
    // post's preview Etherscan's page rather than ours).
    const text = sharedText();
    expect(text).not.toContain('Just ');
    expect(text).not.toContain('#DeFi');
    expect(new URL(popups[0].url).searchParams.get('url')).toBeNull();
  });

  it('keeps the @JungleBayAC mention and tags the room the visitor is in', async () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    tap(shareButton(openReceipt()));
    await waitFor(() => expect(popups.length).toBe(1));
    const text = sharedText();
    expect(text).toContain('@JungleBayAC');
    expect(text).toContain('#BAYLA');
    // A BAYLA staker's post must not carry another resident's ticker.
    expect(text).not.toContain('#TOWELI');
    // Both ride on the last line, after the receipt.
    expect(text.split('\n').at(-1)).toBe('@JungleBayAC #BAYLA');
  });

  it('with no room chosen, the venue tags itself, never a resident', async () => {
    tap(shareButton(openReceipt()));
    await waitFor(() => expect(popups.length).toBe(1));
    expect(sharedText().split('\n').at(-1)).toBe('@JungleBayAC #MemeticFinance');
  });

  // The box-drawing rule counts DOUBLE on X and the venue name is linked (23),
  // so a budget measured in JS string length lets a post through that X then
  // refuses to send. The first fixture needs trimming; the second fits by JS
  // length with the rule still in, and is over on X's count.
  it.each([
    ['a receipt long enough to need trimming', { token: 'T'.repeat(40), lockDuration: 'L'.repeat(60) }],
    ['a receipt that fits by string length but not by X', { token: 'T'.repeat(40), lockDuration: 'L'.repeat(25) }],
    ['an ordinary stake receipt', {}],
  ])("stays within X's 280, counted the way X counts it: %s", async (_name, extra) => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    tap(shareButton(openReceipt({ ...STAKE, ...extra, txHash: HASH })));
    await waitFor(() => expect(popups.length).toBe(1));
    const text = sharedText();
    expect(xWeight(text), text).toBeLessThanOrEqual(280);
  });

  it('trims the receipt first: rows go from the end, and the mention, tag and tx link stay whole', async () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    tap(shareButton(openReceipt({
      ...STAKE,
      token: 'T'.repeat(40),
      lockDuration: 'L'.repeat(60),
      txHash: HASH,
    })));
    await waitFor(() => expect(popups.length).toBe(1));
    const text = sharedText();
    expect(xWeight(text), text).toBeLessThanOrEqual(280);
    expect(text.split('\n').at(-1)).toBe('@JungleBayAC #BAYLA');
    expect(text).toContain(`Tx: https://etherscan.io/tx/${HASH}`);
    // The first figure survives; the last ones are the first to go.
    expect(text).toMatch(/^Amount: 50000\.0000 T+$/m);
    expect(text).not.toContain('Est. APR');
  });

  it('a token name X counts double cannot push the mention or tag out', async () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    // 120 CJK characters: within the card's field cap, and 240 on X's count by itself.
    tap(shareButton(openReceipt({ ...STAKE, token: '\u{4EE3}'.repeat(120), txHash: HASH })));
    await waitFor(() => expect(popups.length).toBe(1));
    const text = sharedText();
    expect(xWeight(text), text).toBeLessThanOrEqual(280);
    expect(text.split('\n').at(-1)).toBe('@JungleBayAC #BAYLA');
    expect(text).toContain(`Tx: https://etherscan.io/tx/${HASH}`);
    expect(text).toContain('MEMETICS.FINANCE');
  });

  // An emoji is TWO UTF-16 units. The card caps each field at 120, and a cap
  // counted in units cut this one in half: encodeURIComponent then threw a
  // URIError on the lone half, and Share to X did nothing at all.
  it.each([
    ['an emoji that ends exactly at the cap', `${'A'.repeat(119)}\u{1F600}`, `${'A'.repeat(119)}\u{1F600}`],
    ['an emoji just past the cap', `${'A'.repeat(120)}\u{1F600}`, 'A'.repeat(120)],
    ['half an emoji already in the name', 'AB\u{D83D}CD', 'ABCD'],
  ])('a token name with %s still shares, and never as half a character', async (_name, token, shown) => {
    tap(shareButton(openReceipt({ ...STAKE, token, txHash: HASH })));
    await waitFor(() => expect(popups.length).toBe(1));
    expect(popups[0].inGesture).toBe(true);
    expect(sharedText().split('\n')).toContain(`Amount: 50000.0000 ${shown}`);
  });
});

describe('receipt share: every gesture-bound call happens inside the tap', () => {
  it('opens X inside the tap, not after the card has rendered', async () => {
    canvasState.works = true;
    tap(shareButton(openReceipt()));
    await waitFor(() => expect(popups.length).toBe(1));
    expect(popups[0].inGesture, 'the X window was opened after the tap ended: a popup blocker eats it').toBe(true);
  });

  it('puts the card on the clipboard inside the tap, before X takes focus', async () => {
    canvasState.works = true;
    const clipboard = installClipboard();
    stubNavigator({ clipboard });
    tap(shareButton(openReceipt()));

    const hint = await screen.findByTestId('receipt-share-hint');
    await waitFor(() => expect(hint.textContent).toMatch(/Receipt image copied/i));
    expect(calls.slice(0, 2)).toEqual(['clipboard.write', 'open']);
    expect(popups[0].inGesture).toBe(true);
  });

  it('hands the share sheet the card inside the tap (phones)', async () => {
    canvasState.works = true;
    stubPointer('coarse');
    const sheet = installShareSheet('ok');
    stubNavigator(sheet);
    const dialog = openReceipt({ ...STAKE, txHash: HASH });
    await cardRendered();

    tap(shareButton(dialog));
    expect(sheet.share, 'the share sheet was not opened during the tap').toHaveBeenCalledTimes(1);
    const arg = sheet.share.mock.calls[0][0] as { files: File[]; text: string };
    expect(arg.files[0].type).toBe('image/png');
    expect(arg.text).toContain('MEMETICS.FINANCE');
    expect(arg.text).toContain('@JungleBayAC');
    // The image went WITH the post: no popup, and nothing to tell the user.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(popups).toEqual([]);
    expect(screen.queryByTestId('receipt-share-hint')).toBeNull();
  });

  // A closed sheet was read as "they changed their mind" and left nothing behind.
  // But the usual reason to close it is that X is not in it, and then the poster
  // had no way to X at all. Closing it still opens nothing by itself.
  it('a cancelled share sheet opens nothing, and still leaves a link to X (phones)', async () => {
    canvasState.works = true;
    stubPointer('coarse');
    stubNavigator(installShareSheet('abort'));
    const dialog = openReceipt();
    await cardRendered();
    tap(shareButton(dialog));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    // Backing out of the sheet must not then shove a popup at the user.
    expect(popups).toEqual([]);
    const hint = await screen.findByTestId('receipt-share-hint');
    const link = within(hint).getByRole('link', { name: /post it on x/i });
    const text = new URL(link.getAttribute('href')!).searchParams.get('text') ?? '';
    expect(text).toContain('MEMETICS.FINANCE');
    expect(text).toContain('@JungleBayAC');
    // Not the wording for a window that could not open: nothing failed.
    expect(hint.textContent).not.toMatch(/could not open/i);
  });

  // Desktop Chrome and Edge on Windows, and Safari on macOS, all say yes to
  // canShare({ files }), but X is rarely in their share sheet. A desktop gets
  // the X window and the card on the clipboard, as if there were no sheet.
  it('on a desktop, Share to X opens X inside the tap even where the browser could share files', async () => {
    canvasState.works = true;
    stubPointer('fine');
    const sheet = installShareSheet('ok');
    const clipboard = installClipboard();
    stubNavigator({ ...sheet, clipboard });
    const dialog = openReceipt({ ...STAKE, txHash: HASH });
    await cardRendered();

    tap(shareButton(dialog));
    expect(sheet.share, 'a desktop was handed the share sheet, where X is usually missing').not.toHaveBeenCalled();
    expect(popups).toHaveLength(1);
    expect(popups[0].inGesture).toBe(true);
    expect(popups[0].url).toMatch(/^https:\/\/twitter\.com\/intent\/tweet\?text=/);
    expect(calls.slice(0, 2)).toEqual(['clipboard.write', 'open']);
    const hint = await screen.findByTestId('receipt-share-hint');
    await waitFor(() => expect(hint.textContent).toMatch(/Receipt image copied/i));
  });

  it('a share sheet that fails offers a link to X, never a popup after the tap has ended', async () => {
    canvasState.works = true;
    stubPointer('coarse');
    stubNavigator(installShareSheet('error'));
    const dialog = openReceipt();
    await cardRendered();
    tap(shareButton(dialog));

    const hint = await screen.findByTestId('receipt-share-hint');
    // The tap is spent, so a popup now would be blocked. A link is a fresh tap.
    expect(popups).toEqual([]);
    const link = within(hint).getByRole('link', { name: /post it on x/i });
    const text = new URL(link.getAttribute('href')!).searchParams.get('text') ?? '';
    expect(text).toContain('MEMETICS.FINANCE');
    expect(text).toContain('@JungleBayAC');
  });

  it('does not claim files are supported when canShare is absent', async () => {
    canvasState.works = true;
    stubPointer('coarse');
    const share = vi.fn(async (_data: unknown) => undefined);
    // `share` exists but `canShare` does not: the browsers that silently drop
    // attachments. Probing only for `share` would post text and lie about it.
    stubNavigator({ share });
    const dialog = openReceipt();
    await cardRendered();
    tap(shareButton(dialog));
    await waitFor(() => expect(popups.length).toBe(1));
    expect(share).not.toHaveBeenCalled();
  });

  it('tells the poster the truth when the image could not be copied', async () => {
    const clipboard = installClipboard();
    stubNavigator({ clipboard });
    tap(shareButton(openReceipt()));
    const hint = await screen.findByTestId('receipt-share-hint');
    // html2canvas is mocked to throw, so the honest hint is the failure one:
    // never "paste the image" when nothing reached the clipboard.
    await waitFor(() => expect(hint.textContent).toMatch(/could not copy/i));
    expect(hint.textContent).not.toMatch(/Receipt image copied/i);
  });

  it('Copy Image writes to the clipboard inside the tap too', async () => {
    canvasState.works = true;
    const clipboard = installClipboard();
    stubNavigator({ clipboard });
    const dialog = openReceipt();
    tap(within(dialog).getByRole('button', { name: /copy image/i }));
    expect(clipboard.write, 'Copy Image wrote nothing during the tap').toHaveBeenCalledTimes(1);
    await act(async () => { await clipboard.write.mock.results[0].value; });
    // The image landed, so no text fallback replaced it.
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  // The text fallback ran only after awaiting the image write, by which time
  // Safari and Firefox no longer count the tap and refuse it. When the picture
  // is already known to be missing, the text goes in during the tap.
  it('when the card could not be drawn, Copy Image copies the text inside the tap, and says it is text', async () => {
    const clipboard = installClipboard();
    stubNavigator({ clipboard });
    const dialog = openReceipt({ ...STAKE, txHash: HASH });
    await cardRendered(); // the render fails: html2canvas has no canvas here

    tap(within(dialog).getByRole('button', { name: /copy image/i }));
    expect(clipboard.writeText, 'the text was not copied during the tap').toHaveBeenCalledTimes(1);
    expect(calls).toContain('clipboard.writeText');
    expect(clipboard.writeText.mock.calls[0][0]).toContain('MEMETICS.FINANCE');
    const hint = await screen.findByTestId('receipt-share-hint');
    await waitFor(() => expect(hint.textContent).toMatch(/copied as text/i));
  });

  it('Copy Image says so when the browser refuses every copy', async () => {
    canvasState.works = true;
    const clipboard = installClipboard({ images: false });
    stubNavigator({ clipboard });
    const dialog = openReceipt();
    await cardRendered();

    tap(within(dialog).getByRole('button', { name: /copy image/i }));
    const hint = await screen.findByTestId('receipt-share-hint');
    await waitFor(() => expect(hint.textContent).toMatch(/could not copy the receipt/i));
    expect(hint.textContent).not.toMatch(/copied/i);
  });

  it('Copy Image falls back to text after the tap where the browser still takes it, and says it is text', async () => {
    canvasState.works = true;
    const clipboard = installClipboard({ images: false, lateText: true });
    stubNavigator({ clipboard });
    const dialog = openReceipt();
    await cardRendered();

    tap(within(dialog).getByRole('button', { name: /copy image/i }));
    const hint = await screen.findByTestId('receipt-share-hint');
    await waitFor(() => expect(hint.textContent).toMatch(/copied as text/i));
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  });
});
