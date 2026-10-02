import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MakerCreateBuy } from './MakerCreateBuy';
import { makerBuyFact, makerBuyFromOrigin, plantFromOrigin, type Fact, type MakerBuy, type PlantMoved } from './facts';
import { CREATOR, KEY } from './fakeWriteApi.fixture';
import { PLANT_BURN_RAW, PLANT_WORKSHOP_RAW } from '../../../lib/launcher/solana/write/plant';
import type { LaunchOrigin } from './ports';

// Ruling 3 (2026-10-01): the maker's create-buy as a number (a share of the supply,
// and the wallet), its lock, and the plant, on every launch page. A read that failed
// says so in words, never as 0 or 0%.

const SUPPLY = 1_000_000_000_000_000n;
const ok = <T,>(value: T): Fact<T> => ({ kind: 'ok', value });
const buy = (over: Partial<MakerBuy> = {}): Fact<MakerBuy> =>
  ok({ tokens: 50_000_000_000_000n, othersTokens: 0n, others: 0, birthSupply: SUPPLY, ...over });
const CARRIED: Fact<PlantMoved> = ok({ burned: PLANT_BURN_RAW, toWorkshop: PLANT_WORKSHOP_RAW });
const UNREAD = { kind: 'unreadable' as const, detail: 'HTTP 429' };

const LOCK = "No lock: this launcher has no way to lock a maker's tokens.";
const COULD_NOT = "Could not read the maker's create-buy right now. This is our read failing, not a finding about the launch.";

function block(props: Partial<Parameters<typeof MakerCreateBuy>[0]> = {}) {
  render(<MakerCreateBuy maker={CREATOR} buy={buy()} plant={CARRIED} decimals={6} {...props} />);
  return screen.getByTestId('maker-create-buy');
}

describe("the maker's create-buy on a launch page", () => {
  it('read, bought: the share of the supply, the amount, the wallet in full, and the lock', () => {
    const el = block();
    expect(screen.getByText(
      "The maker's create-buy: 5.00% of the supply (50,000,000 tokens), bought in the launch transaction, before anyone else could buy.",
    )).toBeInTheDocument();
    expect(screen.getByText("Maker's wallet").parentElement).toHaveTextContent(CREATOR.toBase58());
    expect(screen.getByText(LOCK)).toBeInTheDocument();
    expect(el.textContent).not.toMatch(/Other wallets/);
  });

  it('read, zero: says the maker bought nothing, still names the wallet and the lock', () => {
    block({ buy: buy({ tokens: 0n }) });
    expect(screen.getByText('The maker bought nothing in the launch transaction.')).toBeInTheDocument();
    expect(screen.getByText("Maker's wallet").parentElement).toHaveTextContent(CREATOR.toBase58());
    expect(screen.getByText(LOCK)).toBeInTheDocument();
  });

  it('other wallets that got tokens in the same transaction are said apart, with how many', () => {
    block({ buy: buy({ othersTokens: 5_000_000_000_000n, others: 2 }) });
    expect(screen.getByText('Other wallets got 0.50% of the supply in the same transaction (2 wallets).')).toBeInTheDocument();
    cleanupAndRender({ buy: buy({ othersTokens: 1n, others: 1 }) });
    expect(screen.getByText('Other wallets got <0.01% of the supply in the same transaction (1 wallet).')).toBeInTheDocument();
  });

  it('unreadable: says our read failed, with the reason, and never shows 0 or 0%', () => {
    const el = block({ buy: UNREAD });
    expect(screen.getByText(COULD_NOT)).toBeInTheDocument();
    expect(el).toHaveTextContent('HTTP 429');
    expect(el.textContent).not.toMatch(/\b0(\.00)?%|\b0 tokens|bought nothing/);
    // The lock is a fact about the launcher, not a read: it is said either way.
    expect(screen.getByText(LOCK)).toBeInTheDocument();
  });

  it('the wallet is named whenever it is known, even when the buy could not be read; not invented when it is not', () => {
    block({ buy: UNREAD });
    expect(screen.getByText("Maker's wallet").parentElement).toHaveTextContent(CREATOR.toBase58());
    cleanupAndRender({ buy: UNREAD, maker: null });
    expect(screen.queryByText("Maker's wallet")).not.toBeInTheDocument();
  });

  it('a launch token whose decimals were not read shows base units, not a made-up amount', () => {
    block({ decimals: null });
    expect(screen.getByText(/5\.00% of the supply \(50000000000000 base units\)/)).toBeInTheDocument();
  });
});

describe('the plant on a launch page', () => {
  it('carried: exactly 50,000 burned and 50,000 to the Workshop', () => {
    block();
    expect(
      screen.getByText("Plant: 50,000 $BAYLA burned and 50,000 $BAYLA to the island's Workshop, in the launch transaction."),
    ).toBeInTheDocument();
  });
  it('none: both read as 0', () => {
    block({ plant: ok({ burned: 0n, toWorkshop: 0n }) });
    expect(screen.getByText('No plant: its launch transaction carried none.')).toBeInTheDocument();
  });
  it('other amounts are reported as read, and never called the plant', () => {
    const el = block({ plant: ok({ burned: 25_000_000_000n, toWorkshop: 10_000_000_000n }) });
    expect(
      screen.getByText("Its launch transaction moved $BAYLA, but not as a plant: 25,000 burned, 10,000 to the island's Workshop."),
    ).toBeInTheDocument();
    expect(el.textContent).not.toMatch(/Plant: /);
    // One base unit short of the plant is not the plant, and the amount is shown in full.
    cleanupAndRender({ plant: ok({ burned: PLANT_BURN_RAW - 1n, toWorkshop: PLANT_WORKSHOP_RAW }) });
    expect(
      screen.getByText("Its launch transaction moved $BAYLA, but not as a plant: 49,999.999999 burned, 50,000 to the island's Workshop."),
    ).toBeInTheDocument();
    cleanupAndRender({ plant: ok({ burned: PLANT_BURN_RAW, toWorkshop: -1n }) });
    expect(screen.getByText(/not as a plant: 50,000 burned, -0\.000001 to the island's Workshop\./)).toBeInTheDocument();
  });
  it('unreadable: says so, never "no plant"', () => {
    const el = block({ plant: UNREAD });
    expect(screen.getByText('Could not read whether this launch carried a plant.')).toBeInTheDocument();
    expect(el.textContent).not.toMatch(/No plant/);
  });
});

describe('from the launch transaction to the page', () => {
  const origin = (over: Partial<LaunchOrigin> = {}): LaunchOrigin => ({
    signature: 'sig',
    blockTime: 1,
    creator: CREATOR,
    mint: KEY(1),
    openingBuyTokens: 12_845n,
    reserveRecipient: null,
    boughtByOwner: [
      { owner: CREATOR, tokens: 12_345n },
      { owner: KEY(9), tokens: 500n },
    ],
    birthSupply: SUPPLY,
    plant: { burned: 0n, toWorkshop: 0n },
    ...over,
  });

  it("the maker's figure counts only the maker's wallet", () => {
    expect(makerBuyFact(CREATOR, origin().boughtByOwner, SUPPLY)).toEqual(
      ok({ tokens: 12_345n, othersTokens: 500n, others: 1, birthSupply: SUPPLY }),
    );
  });
  it('a launch transaction naming another maker than the launch account is not read as this launch', () => {
    expect(makerBuyFromOrigin({ kind: 'ok', value: origin() }, KEY(7)).kind).toBe('unreadable');
  });
  it('every missing piece is "could not read": the transaction, the per-wallet balances, the birth supply, the plant', () => {
    expect(makerBuyFromOrigin({ kind: 'absent' }, CREATOR)).toEqual({ kind: 'unreadable', detail: 'the launch transaction could not be found' });
    expect(makerBuyFromOrigin({ kind: 'unreadable', detail: 'HTTP 429' }, CREATOR)).toEqual(UNREAD);
    expect(makerBuyFromOrigin({ kind: 'ok', value: origin({ boughtByOwner: null }) }, CREATOR).kind).toBe('unreadable');
    expect(makerBuyFromOrigin({ kind: 'ok', value: origin({ birthSupply: null }) }, CREATOR).kind).toBe('unreadable');
    expect(makerBuyFromOrigin({ kind: 'ok', value: origin({ birthSupply: 0n }) }, CREATOR).kind).toBe('unreadable');
    expect(plantFromOrigin({ kind: 'ok', value: origin({ plant: null }) }).kind).toBe('unreadable');
    expect(plantFromOrigin({ kind: 'absent' }).kind).toBe('unreadable');
    expect(plantFromOrigin({ kind: 'ok', value: origin() })).toEqual(ok({ burned: 0n, toWorkshop: 0n }));
  });
});

function cleanupAndRender(props: Partial<Parameters<typeof MakerCreateBuy>[0]>) {
  cleanup();
  block(props);
}
