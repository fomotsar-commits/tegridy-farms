// The maker's plates on /eth-curve and /launch: every sentence pinned, and every unread state
// said in words, never as 0 or 0%. Lines are pure (makerPlatesCopy.ts); the views only place them.

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { getAddress, type Hex } from 'viem';
import type { CurveCreateBuy, DopplerBirth, DopplerPlates } from '../../lib/launcher/birthPlates';
import { CurveMakerCreateBuyView, MakerPlatesView } from './EvmMakerPlates';
import {
  ALLOCATION_READING,
  ALLOCATION_UNREADABLE,
  AUCTION_AFTER,
  BOUGHT_NONE,
  CREATE_BUY_UNREADABLE,
  CURVE_NO_LOCK,
  CURVE_READING,
  MAKER_IS_SENDER,
  MAKER_UNNAMED,
  NOT_DOPPLER,
  NO_ALLOCATION,
  curveCreateBuyLines,
  dopplerPlatesLines,
  tokenAmountText,
  utcTime,
} from './makerPlatesCopy';

vi.mock('wagmi', () => ({ usePublicClient: () => undefined }));

const MAKER = getAddress('0x295c4315fd4c0710d286b69e7cd5cecd289d5e6c');
const TX = '0x730b0c9f5f1c272b054f132459d81802950f04b74f7f8342718885c71134b250' as Hex;
const E24 = 10n ** 24n;
const DAY = 86_400n;
const START = 1_778_105_483n; // the real birth block's timestamp, 2026-05-06 22:11 UTC

const buy = (o: Partial<CurveCreateBuy> = {}): CurveCreateBuy => ({ tx: TX, creator: MAKER, makerTokens: 420n * E24, othersTokens: 0n, others: 0, ...o });
const birth = (o: Partial<DopplerBirth> = {}): DopplerBirth => ({
  tx: TX,
  maker: MAKER,
  initializer: getAddress('0x53b4c21a6cb61d64f636abbfa6e8e90e6558e8ad'),
  birthSupply: 1000n * E24,
  makerAmount: 800n * E24,
  makerSchedules: [{ id: 0n, cliff: 0n, duration: DAY }],
  othersAmount: 0n,
  others: 0,
  toMaker: 0n,
  ...o,
});
type Read = Extract<DopplerPlates, { kind: 'read' }>;
/** A read plate, read the day after the real birth unless told otherwise. */
const read = (b: DopplerBirth = birth(), o: Partial<Omit<Read, 'kind' | 'birth'>> = {}): Read => ({
  kind: 'read',
  birth: b,
  vestingStart: START,
  released: 0n,
  readAt: START + DAY / 2n,
  ourAuction: true,
  ...o,
});

describe('the words', () => {
  it("the Memetics Curve: the maker's create-buy, a read zero, and other wallets", () => {
    expect(curveCreateBuyLines(buy())).toEqual({
      maker: "The maker's create-buy: 42.00% of the supply (420,000,000 tokens), bought in the launch transaction, before anyone else could buy.",
      others: null,
    });
    expect(curveCreateBuyLines(buy({ makerTokens: 0n })).maker).toBe('The maker bought nothing in the launch transaction.');
    expect(curveCreateBuyLines(buy({ othersTokens: 11n * E24, others: 2 })).others).toBe(
      'Other wallets got 1.10% of the supply in the same transaction (2 wallets).',
    );
    expect(CURVE_NO_LOCK).toBe("No lock: the Memetics Curve has no way to lock a maker's tokens.");
  });

  // The real birth (no cliff, one day) read today: its vesting ended on 2026-05-07, so the whole
  // 80% can be claimed this second. It once read "locked ... 0 tokens released so far".
  it("Doppler: an ended vesting is never called a lock, and what the maker took is called claimed", () => {
    expect(dopplerPlatesLines(read(birth(), { readAt: START + 2n * DAY }))).toEqual({
      allocation: `The maker's allocation: 80.00% of the supply (800,000,000 tokens) to ${MAKER}, not locked any more: its vesting ended on 2026-05-07 22:11 UTC, so all of it can be claimed now; 0 tokens claimed so far.`,
      others: null,
      bought: `${BOUGHT_NONE} ${AUCTION_AFTER}`,
    });
    expect(BOUGHT_NONE).toBe('Bought in the launch transaction: none.');
    expect(AUCTION_AFTER).toBe('On this rail the auction opens after creation.');
  });

  it('Doppler: the lock is said as it stands when it was read, against start + cliff and start + duration', () => {
    const plate = birth({ makerSchedules: [{ id: 0n, cliff: 90n * DAY, duration: 365n * DAY }] });
    const at = (readAt: bigint) => dopplerPlatesLines(read(plate, { released: 12n * E24, readAt })).allocation;
    expect(at(START + 10n * DAY)).toContain(
      "locked by the token's own vesting: none of it can be claimed before 2026-08-04 22:11 UTC, and all of it can be claimed by 2027-05-06 22:11 UTC; 12,000,000 tokens claimed so far.",
    );
    const partly = "unlocking under the token's own vesting: part of it can be claimed now, and all of it by 2027-05-06 22:11 UTC; 12,000,000 tokens claimed so far.";
    expect(at(START + 90n * DAY)).toContain(partly);
    expect(at(START + 364n * DAY)).toContain(partly);
    expect(at(START + 365n * DAY)).toContain('not locked any more: its vesting ended on 2027-05-06 22:11 UTC, so all of it can be claimed now;');
  });

  it('Doppler: with no cliff, no "nothing before" the birth itself', () => {
    const line = dopplerPlatesLines(read(birth(), { readAt: START + DAY / 2n })).allocation;
    expect(line).toContain("unlocking under the token's own vesting: part of it can be claimed now, and all of it by 2026-05-07 22:11 UTC;");
    expect(line).not.toMatch(/before 2026-05-06/);
  });

  it('Doppler: "released" never stands for two things: no allocation sentence uses it', () => {
    const states = [START, START + DAY / 2n, START + 2n * DAY].flatMap((readAt) => [
      read(birth(), { readAt }),
      read(birth(), { readAt, released: null }),
      read(birth(), { readAt, vestingStart: null }),
      read(birth({ makerSchedules: [{ id: 0n, cliff: 0n, duration: 0n }] }), { readAt }),
    ]);
    for (const p of states) expect(dopplerPlatesLines(p).allocation).not.toMatch(/releas/);
  });

  it('Doppler: unread pieces are said, never 0; a zero-length schedule is not called a lock', () => {
    expect(dopplerPlatesLines(read(birth(), { released: null })).allocation).toContain('; how much the maker has claimed so far could not be read.');
    expect(dopplerPlatesLines(read(birth(), { vestingStart: null })).allocation).toContain("under the token's own vesting (its dates could not be read);");
    expect(dopplerPlatesLines(read(birth(), { vestingStart: null })).allocation).not.toMatch(/\block/);
    expect(dopplerPlatesLines(read(birth({ makerSchedules: [{ id: 0n, cliff: 0n, duration: 0n }] }))).allocation).toContain(
      "not locked: the token's own vesting made all of it claimable at birth;",
    );
  });

  // The auction's timing is a fact of our own rail. A token another integrator launched
  // through Doppler may trade from creation, so it is told nothing about an auction.
  it('Doppler: "the auction opens after creation" only for our own dynamic auction', () => {
    expect(dopplerPlatesLines(read(birth(), { ourAuction: true })).bought).toBe(`${BOUGHT_NONE} ${AUCTION_AFTER}`);
    expect(dopplerPlatesLines(read(birth(), { ourAuction: false })).bought).toBe(BOUGHT_NONE);
  });

  it('Doppler: nothing to the maker, other wallets, and what reached the maker in the launch transaction', () => {
    const lines = dopplerPlatesLines(read(birth({ makerAmount: 0n, makerSchedules: [], othersAmount: 50n * E24, others: 1, toMaker: 3n * E24 }), { released: null }));
    expect(lines.allocation).toBe(`Nothing was allocated at birth to the maker's wallet, ${MAKER}.`);
    expect(lines.others).toBe('Other wallets were allocated 5.00% of the supply at birth (1 wallet).');
    expect(lines.bought).toBe(
      "Received in the launch transaction: 0.30% of the supply (3,000,000 tokens) reached the maker's wallet outside the vesting.",
    );
  });

  // Rulings 3 and 4: the maker's wallet and the bought line on every rail, a launch with no
  // premine included (the /launch default), where it once read only "No allocation at birth."
  it('Doppler: a launch with no premine still names the maker and what it bought', () => {
    const lines = dopplerPlatesLines(read(birth({ makerAmount: 0n, makerSchedules: [] }), { vestingStart: null, released: null }));
    expect(lines).toEqual({ allocation: `${NO_ALLOCATION} The maker's wallet is ${MAKER}.`, others: null, bought: `${BOUGHT_NONE} ${AUCTION_AFTER}` });
  });

  // A smart wallet's launch is sent by a relay: the sender is not the maker, so no plate is
  // pinned on it, nothing is said to be "none", and every allocation is listed unattributed.
  it('Doppler: a maker who could not be named is said so, and no "nothing" or "none" is pinned on the sender', () => {
    const unnamed = birth({ maker: null, makerAmount: 0n, makerSchedules: [], othersAmount: 100n * E24, others: 1, toMaker: null });
    expect(dopplerPlatesLines(read(unnamed, { vestingStart: null, released: null }))).toEqual({
      allocation: MAKER_UNNAMED,
      others: 'Wallets were allocated 10.00% of the supply at birth (1 wallet).',
      bought: null,
    });
    const bare = birth({ maker: null, makerAmount: 0n, makerSchedules: [], toMaker: null });
    expect(dopplerPlatesLines(read(bare, { vestingStart: null, released: null })).others).toBe(NO_ALLOCATION);
  });

  it('amounts and times', () => {
    expect(tokenAmountText(1n)).toBe('<0.0001');
    expect(tokenAmountText(1_234_567_890_000_000_000_000n)).toBe('1,234.5678');
    expect(tokenAmountText(0n)).toBe('0');
    expect(utcTime(START)).toBe('2026-05-06 22:11 UTC');
    expect(utcTime(2n ** 64n - 1n)).toBe('after the year 9999');
  });
});

const text = (c: HTMLElement) => c.textContent ?? '';
const EM_DASH = String.fromCharCode(0x2014);

describe('/eth-curve block', () => {
  it('while reading: says so, names the wallet, and states the lock line', () => {
    const { container } = render(<CurveMakerCreateBuyView chainId={1} creator={MAKER} read={null} />);
    expect(screen.getByText(CURVE_READING)).toBeInTheDocument();
    expect(screen.getByText(CURVE_NO_LOCK)).toBeInTheDocument();
    expect(screen.getByText(MAKER)).toBeInTheDocument();
    expect(text(container)).not.toMatch(/%/);
  });

  it('unreadable: says our read failed, offers a re-read, and never shows a 0', () => {
    const onRetry = vi.fn();
    const { container } = render(
      <CurveMakerCreateBuyView chainId={8453} creator={MAKER} read={{ kind: 'unreadable', detail: 'its launch transaction could not be read: rpc down' }} onRetry={onRetry} />,
    );
    expect(screen.getByText(CREATE_BUY_UNREADABLE)).toBeInTheDocument();
    expect(text(container)).not.toMatch(/\b0(\.0+)?%|bought nothing/);
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('read: the figure, the wallet, the lock, and a link to the transaction on its own chain', () => {
    render(<CurveMakerCreateBuyView chainId={4663} creator={MAKER} read={{ kind: 'ok', value: buy() }} />);
    expect(screen.getByText(curveCreateBuyLines(buy()).maker)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'its launch transaction' })).toHaveAttribute('href', `https://robinhoodchain.blockscout.com/tx/${TX}`);
  });

  it('read: what other wallets got in the same transaction is on the block, not only in the copy', () => {
    const v = buy({ othersTokens: 11n * E24, others: 2 });
    render(<CurveMakerCreateBuyView chainId={1} creator={MAKER} read={{ kind: 'ok', value: v }} />);
    expect(screen.getByText('Other wallets got 1.10% of the supply in the same transaction (2 wallets).')).toBeInTheDocument();
  });
});

describe('/launch card', () => {
  it('while reading', () => {
    render(<MakerPlatesView plates={null} />);
    expect(screen.getByText(ALLOCATION_READING)).toBeInTheDocument();
  });

  // The zero address, WETH, any token Doppler never made: the chain answered, so this is
  // a finding, said once, with no "our read failed" and no Read again that cannot succeed.
  it('not a Doppler launch: says so plainly, and offers no re-read', () => {
    const { container } = render(<MakerPlatesView plates={{ kind: 'not-doppler' }} onRetry={() => {}} />);
    expect(screen.getByText(NOT_DOPPLER)).toBeInTheDocument();
    expect(screen.queryByText(ALLOCATION_UNREADABLE)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read again' })).not.toBeInTheDocument();
    expect(text(container)).not.toMatch(/\b0(\.0+)?%|\b0 tokens|none/);
  });

  it('unreadable: no "none", no bought line, no 0', () => {
    const { container } = render(<MakerPlatesView plates={{ kind: 'unreadable', detail: 'its launch transaction could not be looked up: HTTP 502' }} onRetry={() => {}} />);
    expect(screen.getByText(ALLOCATION_UNREADABLE)).toBeInTheDocument();
    expect(screen.queryByText(NO_ALLOCATION)).not.toBeInTheDocument();
    expect(screen.queryByText(/Bought in the launch transaction/)).not.toBeInTheDocument();
    expect(text(container)).not.toMatch(/\b0(\.0+)?%|\b0 tokens/);
  });

  it('read: the allocation, and "Bought ... none" only when the receipt showed nothing reaching the maker', () => {
    const { rerender } = render(<MakerPlatesView plates={read()} />);
    expect(screen.getByText(dopplerPlatesLines(read()).allocation)).toBeInTheDocument();
    expect(screen.getByText(`${BOUGHT_NONE} ${AUCTION_AFTER}`)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(MAKER_IS_SENDER))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'its launch transaction' })).toHaveAttribute('href', `https://etherscan.io/tx/${TX}`);
    rerender(<MakerPlatesView plates={read(birth({ toMaker: E24 }))} />);
    expect(screen.queryByText(/Bought in the launch transaction/)).not.toBeInTheDocument();
  });

  it('read: other wallets\' allocations are on the card, not only in the copy', () => {
    render(<MakerPlatesView plates={read(birth({ othersAmount: 50n * E24, others: 1 }))} />);
    expect(screen.getByText('Other wallets were allocated 5.00% of the supply at birth (1 wallet).')).toBeInTheDocument();
  });

  it('read, no premine: the maker\'s wallet and the bought line are on the card', () => {
    const { container } = render(<MakerPlatesView plates={read(birth({ makerAmount: 0n, makerSchedules: [] }), { vestingStart: null, released: null })} />);
    expect(container).toHaveTextContent(MAKER);
    expect(screen.getByText(`${BOUGHT_NONE} ${AUCTION_AFTER}`)).toBeInTheDocument();
  });

  it('read, maker not named: no sender line, no "none", and the allocations unattributed', () => {
    const unnamed = birth({ maker: null, makerAmount: 0n, makerSchedules: [], othersAmount: 100n * E24, others: 1, toMaker: null });
    const { container } = render(<MakerPlatesView plates={read(unnamed, { vestingStart: null, released: null })} />);
    expect(screen.getByText(MAKER_UNNAMED)).toBeInTheDocument();
    expect(text(container)).not.toContain(MAKER_IS_SENDER);
    expect(text(container)).not.toMatch(/none|Nothing was allocated/);
  });

  it('carries no em dash in any state', () => {
    const states = [
      null,
      { kind: 'not-doppler' } as const,
      { kind: 'unreadable', detail: 'x' } as const,
      read(birth({ others: 1, othersAmount: E24, toMaker: E24 }), { released: null }),
      read(birth({ maker: null, makerAmount: 0n, makerSchedules: [], others: 2, othersAmount: E24, toMaker: null })),
    ];
    for (const p of states) {
      const { container, unmount } = render(<MakerPlatesView plates={p} />);
      expect(text(container)).not.toContain(EM_DASH);
      unmount();
    }
    const { container } = render(<CurveMakerCreateBuyView chainId={1} creator={MAKER} read={{ kind: 'ok', value: buy({ others: 1, othersTokens: E24 }) }} />);
    expect(text(container)).not.toContain(EM_DASH);
  });
});
