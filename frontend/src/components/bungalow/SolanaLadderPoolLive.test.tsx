// A WIRING PIN for the Solana ladder card.
//
// The math is unit-tested in lib/ladder. What only a render can catch is the
// component handing the wrong value to the right helper, or printing a figure the
// helper never produced. Three of those would cost a user real money:
//
//   1. The emergency hatch priced as free while a position is LOCKED. It charges the
//      same time-left penalty as an early exit (veYFI's, capped at 75%), the penalty rides inside a base64 event so no
//      dry run reveals it, and this repo has already had that wrong in the operator
//      CLI, in the runbook, and out loud.
//   2. Rewards printed from the stored `rewards_owed`, which only moves when somebody
//      touches the pool — so a position earning for a month reads zero on chain.
//   3. A failed read rendered as a zero, which tells a staker their money is gone.
//
// The READ SEAM is mocked one module below the card and the math above it stays real,
// which is what makes those three assertions mean anything.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor, act } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const NOW = 1_800_000_000;              // fixed clock; every fixture is relative to it
const POOL_ADDR = '2RJNUuj3y8CDibhCehvRoufAvkBG9idpKrryYosvZxi4';
const MINT = '8opsYTPSp2AckjmAc2vx49kohs8CFtNcyR2sNURfrfoL';
const OWNER = 'Gut9toQMqtrFL5ERLsAThmtq6e1Hq9BGtWPcjNqziHrj';

/* ─────────────────────────── the rig ─────────────────────────── */

// Counts mounts: the bare card must mount none, so SolanaPoolStack can share one.
const providerMounts = vi.hoisted(() => ({ n: 0 }));
vi.mock('../solana/SolanaProviders', async () => {
  const { useEffect } = await import('react');
  return {
    SolanaProviders: ({ children }: { children: React.ReactNode }) => {
      useEffect(() => { providerMounts.n += 1; }, []);
      return children;
    },
  };
});

const walletState = vi.hoisted(() => ({ publicKey: null as { toBase58: () => string } | null }));
// STABLE. `useConnection` returns the same object across renders in the real
// provider; a fresh `{}` here would change every effect's dependency identity on
// every render and re-fire all of them forever.
const conn = vi.hoisted(() => ({ connection: {} }));
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    publicKey: walletState.publicKey,
    wallet: walletState.publicKey ? { adapter: { publicKey: walletState.publicKey } } : null,
    connected: !!walletState.publicKey,
  }),
  useConnection: () => conn,
}));

// ⚠️ A FUNCTION, not an object. The sibling Solana card's test mocks this as
// `{ connect, connecting }` while the component calls it and uses the result as an
// onClick handler — that mock only passes because no test there ever renders the
// disconnected branch. This one does.
vi.mock('../solana/useSolanaConnect', () => ({ useSolanaConnect: () => () => {} }));

// `LADDER_PROGRAM_ID` is a module-level const evaluated at import, so vi.stubEnv
// after the fact does nothing to it — the feature gate has to be mocked at the
// function, not at the environment. Everything else stays the real module.
const cfg = vi.hoisted(() => ({
  configured: true,
  program: 'HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK',
}));
vi.mock('../../lib/ladder/program', async (orig) => {
  const actual = await orig<typeof import('../../lib/ladder/program')>();
  const { PublicKey } = await import('@solana/web3.js');
  return {
    ...actual,   // the ladder math, the quotes and the deposit gates stay REAL
    isLadderConfigured: () => cfg.configured,
    ladderProgramId: () => new PublicKey(cfg.program),
  };
});

const reads = vi.hoisted(() => ({
  pool: null as unknown,
  vaults: { stakeRaw: 0n, rewardRaw: 0n } as { stakeRaw: bigint | null; rewardRaw: bigint | null },
  wallet: null as unknown,
  balance: 0n as bigint | null,
}));
vi.mock('../../lib/ladder/read', () => ({
  readLadderPool: vi.fn(async () => reads.pool),
  readVaultBalances: vi.fn(async () => reads.vaults),
  readLadderWallet: vi.fn(async () => reads.wallet),
  readOwnerTokenBalance: vi.fn(async () => reads.balance),
  nextPositionNonce: (w: { stats: { nextNonce: number } | null }) => w.stats?.nextNonce ?? 0,
  walletPrincipalRaw: (w: { stats: { principalRaw: bigint } | null }) => w.stats?.principalRaw ?? 0n,
}));

const writes = vi.hoisted(() => ({
  stake: vi.fn(async () => ({ ok: true as const, signature: 'SIG' })),
  claim: vi.fn(async () => ({ ok: true as const, signature: 'SIG' })),
  exit: vi.fn(async () => ({ ok: true as const, signature: 'SIG' })),
  hatch: vi.fn(async () => ({ ok: true as const, signature: 'SIG' })),
  carried: vi.fn(async () => ({ ok: true as const, signature: 'SIG' })),
}));
vi.mock('../../lib/ladder/write', () => ({
  ladderStake: writes.stake,
  ladderClaim: writes.claim,
  ladderExit: writes.exit,
  ladderHatch: writes.hatch,
  ladderClaimCarried: writes.carried,
}));

const { SolanaLadderPoolLive, SolanaLadderPoolCard } = await import('./SolanaLadderPoolLive');

/* ─────────────────────────── fixtures ─────────────────────────── */

const poolView = (o: Record<string, unknown> = {}) => ({
  address: POOL_ADDR, bump: 255, nonce: 0, mint: MINT,
  tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  decimals: 6, authority: OWNER, pendingAuthority: OWNER,
  stakeVault: 'SV', rewardVault: 'RV',
  minStakeRaw: 100_000_000n,               // 100 BAYLA
  depositCapRaw: 10_000_000_000_000n,
  pendingCapRaw: 0n, pendingCapTs: 0n,
  maxWalletPrincipalRaw: 10_000_000_000_000n,
  totalPrincipalRaw: 1_000_000_000n,
  totalWeighted: 1_000_000_000n,
  rewardRate: 0n,
  periodFinish: BigInt(NOW + 30 * DAY),
  lastUpdateTime: BigInt(NOW - DAY),
  rewardPerWeightStored: 0n,
  rpwResidueRaw: 0n,
  rewardsEmitted: 0n, rewardsPaid: 0n,
  rewardFundedCumulative: 0n, penaltyCollectedCumulative: 0n,
  orphanedPenaltyRaw: 0n,
  degraded: false,
  ...o,
});

const position = (o: Record<string, unknown> = {}) => ({
  address: 'POS0', pool: POOL_ADDR, owner: OWNER, nonce: 0,
  amountRaw: 500_000_000n,                 // 500 BAYLA
  weight: 2_000_000_000n,                  // 4.00x, the four-year top
  // LOCKED, with four years left: over three, so veYFI's schedule is at its 75% cap and
  // every price below is the capped one (375 of 500). A short lock is priced separately.
  lockEnd: BigInt(NOW + 4 * 365 * DAY),
  rewardPerWeightPaid: 0n,
  rewardsOwed: 0n,
  ...o,
});

// `shareBasis` is the wallet weight and the pool total read in ONE getMultipleAccounts
// call (read.ts). The default puts the SMALLEST total that call could honestly return
// (your own weight) there, so the card's other bound — the separately read pool — is
// what decides every share figure below, exactly as it did before the basis existed.
const walletView = (o: Record<string, unknown> = {}) => {
  const open = (o.open as { weight: bigint }[] | undefined) ?? [position()];
  const mine = open.reduce((a, p) => a + p.weight, 0n);
  return {
    stats: {
      address: 'US', nextNonce: 1, openPositions: 1,
      rewardsCarriedRaw: 0n, principalRaw: 500_000_000n,
    },
    slots: [], open, truncated: false,
    shareBasis: mine > 0n ? { mineWeight: mine, totalWeighted: mine } : null,
    ...o,
  };
};

const BUNGALOW = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  address: MINT, ladderPool: POOL_ADDR, decimals: 6,
} as unknown as Bungalow & { ladderPool: string };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW * 1000);
  cfg.configured = true;
  walletState.publicKey = { toBase58: () => OWNER };
  reads.pool = { ok: true, value: poolView() };
  reads.vaults = { stakeRaw: 1_000_000_000n, rewardRaw: 5_000_000_000n };
  reads.wallet = { ok: true, value: walletView() };
  reads.balance = 2_000_000_000n;
  for (const f of Object.values(writes)) f.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const draw = () => render(<SolanaLadderPoolLive bungalow={BUNGALOW} />);

/* ────────── 1. the hatch, which is the whole reason for this file ────────── */

describe('the emergency hatch is priced, never assumed', () => {
  it('⚠️ a LOCKED position is told the hatch costs 375 of its 500', () => {
    // Four years left: the 75% cap, 375 of 500. The single most expensive thing this
    // repo has said wrongly about this program is that the hatch is free.
    draw();
    return screen.findByText(/Emergency withdraw — costs 375 BAYLA/).then((btn) => {
      expect(btn).toBeTruthy();
      expect(screen.queryByText(/Emergency withdraw — no penalty/)).toBeNull();
    });
  });

  it('a SHORT lock is quoted its time-left price, not the cap', async () => {
    // veYFI's schedule: 7 days left on 500 is floor(500e6 x floor(604_800e18 / 4y) / 1e18)
    // = 2_397_260 raw — under half a percent. A card still quoting the cap would tell
    // this staker their exit costs 375.
    reads.wallet = { ok: true, value: walletView({ open: [position({ lockEnd: BigInt(NOW + 7 * DAY), weight: 200_000_000n })] }) };
    draw();
    expect(await screen.findByText(`Emergency withdraw — costs ${fmtRaw(2_397_260n, 6)} BAYLA`)).toBeTruthy();
    expect(screen.getByText(`Exit early — keep ${fmtRaw(497_602_740n, 6)} BAYLA`)).toBeTruthy();
    expect(screen.queryByText(/costs 375 BAYLA/)).toBeNull();
  });

  it('a MATURED position is told the hatch is free, because by then it is', async () => {
    reads.wallet = { ok: true, value: walletView({ open: [position({ lockEnd: BigInt(NOW - 1) })] }) };
    draw();
    expect(await screen.findByText(/Emergency withdraw — no penalty/)).toBeTruthy();
    expect(screen.queryByText(/Emergency withdraw — costs/)).toBeNull();
  });

  it('a DEGRADED pool frees the hatch even while the position is locked', async () => {
    // The flag exists so a captured or absent operator cannot trap anyone. If the
    // card kept quoting the penalty here it would deter the exit the flag was set to allow.
    reads.pool = { ok: true, value: poolView({ degraded: true }) };
    draw();
    expect(await screen.findByText(/Emergency withdraw — no penalty/)).toBeTruthy();
  });

  it('the hatch needs a second click before it sends anything', async () => {
    draw();
    const btn = await screen.findByText(/Emergency withdraw — costs 375 BAYLA/);
    btn.click();
    expect(writes.hatch).not.toHaveBeenCalled();      // armed, not fired
    expect(await screen.findByText('Confirm')).toBeTruthy();
  });
});

/* ────────── 2. rewards are computed, not read ────────── */

describe('what a position has earned', () => {
  it('⚠️ shows accrual the chain has not banked yet', async () => {
    // rewards_owed is 0 on chain because nobody has touched this pool since the
    // stake. The accumulator has still been running for a day.
    reads.pool = { ok: true, value: poolView({ rewardRate: 1_000_000n, lastUpdateTime: BigInt(NOW - DAY) }) };
    draw();
    const rows = await screen.findAllByText(/earned/);
    const text = rows.map((r) => r.textContent).join(' ');
    expect(text).not.toMatch(/\b0 BAYLA earned/);
  });

  it('a pool emitting nothing shows a real, labelled zero', async () => {
    draw();
    expect(await screen.findByText(/0 BAYLA earned/)).toBeTruthy();
  });
});

/* ────────── 3. an unreadable read is never a zero ────────── */

describe('reads that did not land', () => {
  it('an unreadable reward vault says so instead of showing 0', async () => {
    // MUTATION-FOUND. This asserted only that the words "could not be read" appeared
    // somewhere, and survived a mutation that coalesced the null to 0n — the note
    // would have gone with it, but the FIGURE is what a reader acts on, so the figure
    // is what has to be pinned.
    reads.vaults = { stakeRaw: null, rewardRaw: null };
    draw();
    const label = await screen.findByText('Reward vault');
    const card = within(label.parentElement!);
    await waitFor(() => expect(card.getByText('could not be read')).toBeTruthy());
    expect(card.getByText('–')).toBeTruthy();
    expect(card.queryByText('0')).toBeNull();
  });

  it('a read still in flight is NOT presented as a failed one', async () => {
    // FOUND BY THE FULL SUITE, not by this file. Under load the vault read had not
    // landed when the assertion above ran, and the card rendered the same bare dash
    // it shows for a failure — so "we have not asked yet" and "we asked and it broke"
    // were the same answer. The flake was the symptom; this is the defect.
    let release: (v: { stakeRaw: bigint | null; rewardRaw: bigint | null }) => void = () => {};
    const pending = new Promise<{ stakeRaw: bigint | null; rewardRaw: bigint | null }>((r) => { release = r; });
    const read = await import('../../lib/ladder/read');
    vi.mocked(read.readVaultBalances).mockImplementationOnce(() => pending);

    draw();
    const label = await screen.findByText('Reward vault');
    const card = within(label.parentElement!);
    expect(card.getByText('reading…')).toBeTruthy();
    expect(card.queryByText('could not be read')).toBeNull();

    release({ stakeRaw: 1n, rewardRaw: null });
    await waitFor(() => expect(card.getByText('could not be read')).toBeTruthy());
    expect(card.queryByText('reading…')).toBeNull();
  });

  it('a failed WALLET read does not render as "no positions"', async () => {
    // The worst possible answer on this surface: telling someone checking on their
    // own money that they have none.
    reads.wallet = { ok: false, unreadable: true, reason: 'your position could not be read: RPC 503' };
    draw();
    expect(await screen.findByText(/could not be read: RPC 503/)).toBeTruthy();
    expect(screen.queryByText('No open positions in this pool.')).toBeNull();
  });

  it('a failed POOL read shows the reason and offers no stake button', async () => {
    reads.pool = { ok: false, unreadable: true, reason: 'there is no account at this pool address' };
    draw();
    expect(await screen.findByText(/no account at this pool address/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Lock BAYLA/ })).toBeNull();
  });

  it('a partial position scan says it is partial', async () => {
    reads.wallet = { ok: true, value: walletView({ truncated: true }) };
    draw();
    expect(await screen.findByText(/the list below is partial/)).toBeTruthy();
  });
});

/* ────────── 4. the configuration gates ────────── */

describe('configuration', () => {
  it('an unconfigured deployment says so and sends nothing', async () => {
    cfg.configured = false;
    draw();
    expect(await screen.findByText(/not configured yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Lock BAYLA/ })).toBeNull();
  });

  it('a malformed pool address is a caught configuration error, not a crash', async () => {
    // `new PublicKey()` throws on bad base58. Unguarded, a typo in a Vercel env var
    // takes the whole farm page down rather than this one card.
    const bad = { ...BUNGALOW, ladderPool: 'not-a-real-address!!' } as typeof BUNGALOW;
    render(<SolanaLadderPoolLive bungalow={bad} />);
    expect(await screen.findByText(/not a valid Solana address/)).toBeTruthy();
  });

  it('⚠️ a pool staking a DIFFERENT mint shows no figures and no buttons', async () => {
    // A mispasted address renders a stranger pool's numbers under our symbol and
    // points the stake button at a stranger's token.
    reads.pool = { ok: true, value: poolView({ mint: 'So11111111111111111111111111111111111111112' }) };
    draw();
    expect(await screen.findByText(/does not stake BAYLA/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Lock BAYLA/ })).toBeNull();
    expect(screen.queryByText(/Emergency withdraw/)).toBeNull();
  });
});

/* ────────── 5. the deposit gates, checked before a fee is paid ────────── */

describe('the stake form refuses what the program would refuse', () => {
  it('explains a below-minimum stake rather than letting it revert on chain', async () => {
    // MUTATION-FOUND, twice over. The original matched /minimum stake/i, which also
    // matches the "Minimum stake" STAT LABEL two rows above — so it passed whether or
    // not any verdict rendered. And a bare dispatchEvent does not drive React's
    // onChange, so the value never reached the component either. Match the sentence
    // only checkDeposit produces, and type through fireEvent.
    draw();
    const input = await screen.findByLabelText('Amount');
    fireEvent.change(input, { target: { value: '1' } });
    expect(await screen.findByText(/no instruction to change it/i)).toBeTruthy();
    const stake = screen.getByRole('button', { name: /Lock BAYLA/ });
    expect((stake as HTMLButtonElement).disabled).toBe(true);
  });

  it('tells a staker, before they lock, what leaving straight away would cost — and that it shrinks', async () => {
    // The default rung is 7 days: 200 BAYLA forfeits 958_904 raw at once, 0.47% floored.
    draw();
    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '200' } });
    const line = await screen.findByText(/Leaving straight away would forfeit/);
    expect(line.textContent).toMatch(/forfeit 0\.47% of the principal/);
    expect(line.textContent).toMatch(/time left on the lock over four years, capped at 75%/);
    expect(line.textContent).toMatch(/shrinks as the lock runs down/);
  });

  it('accepts an amount that clears every gate', async () => {
    // The other half of the pin: a gate that refuses EVERYTHING is not a working
    // gate, and a refusal test alone cannot tell the two apart.
    draw();
    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '200' } });
    expect(screen.queryByText(/no instruction to change it/i)).toBeNull();
    const stake = screen.getByRole('button', { name: /Lock BAYLA/ });
    expect((stake as HTMLButtonElement).disabled).toBe(false);
  });

  it('refuses more than the wallet holds', async () => {
    reads.balance = 150_000_000n;
    draw();
    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '200' } });
    expect(await screen.findByText(/more BAYLA than this wallet holds/)).toBeTruthy();
  });

  it('a degraded pool takes no new stakes, says why, and offers no live Lock button', async () => {
    // MUTATION-FOUND by review: this asserted only the banner, and the Lock button sat
    // ENABLED beneath it for any amount that cleared the other gates — `stake` refuses
    // a degraded pool first (lib.rs PoolDegraded), so the click bought a wallet prompt
    // and a refusal. 200 is the amount the healthy-pool test above accepts, so the
    // degraded flag is the only thing that can be disabling the button here.
    reads.pool = { ok: true, value: poolView({ degraded: true }) };
    draw();
    expect(await screen.findByText(/takes no new stakes/)).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '200' } });
    expect(await screen.findByText(/declared degraded and accepts no new stakes/)).toBeTruthy();
    const stake = screen.getByRole('button', { name: /Lock BAYLA/ });
    expect((stake as HTMLButtonElement).disabled).toBe(true);
  });

  it('names the per-wallet position limit from the program, not a literal', async () => {
    draw();
    const stat = await screen.findByText('Open positions');
    expect(within(stat.parentElement!).getByText('1 / 20')).toBeTruthy();
  });
});

describe('MAX writes a value the parser can read back', () => {
  it('⚠️ fills the field with the PLAIN string, never the grouped display', async () => {
    // MUTATION-FOUND: nothing exercised this button. The grouped form is what shipped
    // once on the sibling card — in any dot-grouping locale "1.234" parses back as
    // 1.234 tokens instead of 1234, a silent factor-of-1000 under-stake with the
    // wallet showing the right number throughout.
    reads.balance = 1_234_500_000n;      // 1234.5 BAYLA
    draw();
    const max = await screen.findByRole('button', { name: 'Max' });
    // The balance rides its own effect, and Max is disabled until it lands — a click
    // before then is a no-op that would make this test pass on an empty field.
    await waitFor(() => expect((max as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(max);
    const input = await screen.findByLabelText('Amount');
    expect((input as HTMLInputElement).value).toBe('1234.5');
    expect((input as HTMLInputElement).value).not.toMatch(/[,\u00A0\u202F]/);
  });

  it('is disabled when the balance could not be read, rather than filling in a 0', async () => {
    reads.balance = null;
    draw();
    const max = await screen.findByRole('button', { name: 'Max' });
    expect((max as HTMLButtonElement).disabled).toBe(true);
  });
});

/* ────────── 6. carried rewards are a balance, and must be reachable ────────── */

describe('carried rewards — from the hatch or a short reward vault', () => {
  it('shows a carried balance and a way to claim it', async () => {
    reads.wallet = {
      ok: true,
      value: walletView({
        stats: { address: 'US', nextNonce: 1, openPositions: 1, rewardsCarriedRaw: 42_000_000n, principalRaw: 500_000_000n },
      }),
    };
    draw();
    expect(await screen.findByText(/42 BAYLA/)).toBeTruthy();
    // Both sources, not just the hatch: an exit against a short reward vault carries
    // the unpaid remainder here too, and the exit copy sends stakers to this box.
    expect(screen.getByText(/could not cover when it closed/)).toBeTruthy();
    const btn = await screen.findByRole('button', { name: 'Claim carried' });
    btn.click();
    expect(writes.carried).toHaveBeenCalledTimes(1);
  });

  it('does not invent the row when there is nothing carried', async () => {
    draw();
    await screen.findByText(/Emergency withdraw/);
    expect(screen.queryByRole('button', { name: 'Claim carried' })).toBeNull();
  });
});

/* ────────── 7. the disconnected state ────────── */

describe('with no wallet connected', () => {
  it('offers a connect button and reads the pool anyway', async () => {
    walletState.publicKey = null;
    draw();
    expect(await screen.findByRole('button', { name: /Connect a Solana wallet/ })).toBeTruthy();
    // Pool-level figures do not need a wallet, and withholding them would make the
    // card look broken to anyone deciding whether to connect at all.
    expect(screen.getByText('Reward vault')).toBeTruthy();
  });

  // THE WAY IN WHEN THE BODY CANNOT DRAW. Under SolanaPoolStack this card is the only
  // Connect for a member of the closed Streamflow pool, whose claim strip stays hidden
  // until a wallet connects. A ladder that fails to read must not take that claim with it.
  const connects = () => screen.queryAllByRole('button', { name: /Connect a Solana wallet/ });

  it('a readable pool shows exactly ONE connect button, not the fallback as well', async () => {
    walletState.publicKey = null;
    draw();
    await screen.findByText('Reward vault');
    expect(connects()).toHaveLength(1);
  });

  it('a failed pool read still offers exactly one connect button', async () => {
    walletState.publicKey = null;
    reads.pool = { ok: false, unreadable: true, reason: 'there is no account at this pool address' };
    draw();
    await screen.findByText(/no account at this pool address/);
    expect(connects()).toHaveLength(1);
    // Its own wrapper: a direct child of the card's flex column stretches full width.
    expect(connects()[0]!.parentElement!.className).not.toMatch(/flex-col/);
  });

  it('an unconfigured deployment still offers exactly one connect button', async () => {
    walletState.publicKey = null;
    cfg.configured = false;
    draw();
    await screen.findByText(/not configured yet/);
    expect(connects()).toHaveLength(1);
  });

  it('a pool staking a different mint still offers exactly one connect button', async () => {
    walletState.publicKey = null;
    reads.pool = { ok: true, value: poolView({ mint: 'So11111111111111111111111111111111111111112' }) };
    draw();
    await screen.findByText(/does not stake BAYLA/);
    expect(connects()).toHaveLength(1);
  });

  it('no connect button flashes while the pool is still being read', async () => {
    walletState.publicKey = null;
    reads.pool = new Promise(() => {});
    draw();
    await screen.findByText('Reading the pool…');
    expect(connects()).toHaveLength(0);
  });

  it('a CONNECTED wallet never sees the fallback on a failed read', async () => {
    reads.pool = { ok: false, unreadable: true, reason: 'there is no account at this pool address' };
    draw();
    await screen.findByText(/no account at this pool address/);
    expect(connects()).toHaveLength(0);
  });

  // A second WalletProvider reads the saved wallet only when it mounts, so a member who
  // connected through this card would not appear in the strip under it until a reload.
  it('the bare card mounts no wallet context, so the claim strip under it shares one', async () => {
    providerMounts.n = 0;
    walletState.publicKey = null;
    render(<SolanaLadderPoolCard bungalow={BUNGALOW} />);
    await screen.findByText('Reward vault');
    expect(providerMounts.n).toBe(0);
    draw();
    await waitFor(() => expect(providerMounts.n).toBe(1));
  });
});

/* ────────── 8. pool-level reward figures: never annualised ────────── */

// The card used to print a "Configured rate" percentage: rewardRate x a year divided
// by total PRINCIPAL. Rewards are split by WEIGHT, so that figure was the pool
// average, not the 1.00x rate its note claimed, and a percentage per token is a
// yield promise the program does not make. What the chain actually fixes is how many
// tokens the whole pool is scheduled to receive per second, and until when.
const { fmtRaw } = await import('../../lib/ladder/format');
const dateOf = (secs: number) =>
  new Date(secs * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
// The pool LEDGER: its cells AND the footnotes beneath them. The helper sentences
// ("to all stakers combined…", "no reward window has ever been scheduled…") moved out
// of the cells into always-visible footnotes in the 2026-09-20 redesign; what these
// pins assert is that the sentence is on the card beside its fact, not which box.
const statGrid = async () => (await screen.findByText('Reward vault')).closest('[data-ledger]') as HTMLElement;
const stat = (label: string) => within(screen.getByText(label).parentElement!);
/** A fact's disclosure: the footnote its cell points at with aria-describedby. */
const noteFor = (label: string) => {
  const id = screen.getByText(label).parentElement!.getAttribute('aria-describedby');
  if (!id) throw new Error(`"${label}" has no linked disclosure`);
  return document.getElementById(id)!.textContent ?? '';
};

describe('pool-level reward figures', () => {
  it('a LIVE window shows tokens per day to ALL stakers and the funded-through date, and no percentage', async () => {
    // 1 BAYLA a second. Weight is 4x principal, so any figure divided by principal
    // instead of weight would be off by 4x; the per-day figure divides by neither.
    reads.pool = {
      ok: true,
      value: poolView({ rewardRate: 1_000_000n, totalWeighted: 4_000_000_000n }),
    };
    draw();
    const grid = await statGrid();
    // Never annualised, never a per-token percentage.
    expect(grid.textContent).not.toMatch(/%/);
    expect(document.body.textContent).not.toMatch(/\bAPR\b|\bAPY\b|per year|annual/i);
    await waitFor(() => expect(screen.getByText('Rewards per day')).toBeTruthy());
    const perDay = stat('Rewards per day');
    expect(perDay.getByText(fmtRaw(86_400_000_000n, 6))).toBeTruthy();
    expect(noteFor('Rewards per day')).toMatch(/all stakers combined/);
    expect(stat('Funded through').getByText(dateOf(NOW + 30 * DAY))).toBeTruthy();
  });

  it('a pool that was NEVER funded does not say its rewards ended, and shows no stream', async () => {
    // rewardRate 0 is only reachable before the first notify_reward: the program
    // refuses a zero rate. "Ended" would tell a reader a stream once ran here.
    draw();
    const grid = await statGrid();
    expect(grid.textContent).toMatch(/no reward window has ever been scheduled/);
    expect(grid.textContent).not.toMatch(/ended|has closed/);
    expect(screen.queryByText('Rewards per day')).toBeNull();
    expect(screen.queryByText('Funded through')).toBeNull();
  });

  it('an ENDED window says when it closed and that nothing new accrues, and shows no stream', async () => {
    reads.pool = {
      ok: true,
      value: poolView({ rewardRate: 1_000_000n, periodFinish: BigInt(NOW - 2 * DAY) }),
    };
    draw();
    const grid = await statGrid();
    expect(grid.textContent).toMatch(/ended/);
    expect(grid.textContent).toContain(dateOf(NOW - 2 * DAY));
    expect(grid.textContent).toMatch(/no new rewards are accruing/);
    expect(grid.textContent).not.toMatch(/no reward window has ever been scheduled/);
    expect(screen.queryByText('Rewards per day')).toBeNull();
    expect(screen.queryByText('Funded through')).toBeNull();
  });

  it('a live window over an EMPTY pool says nothing accrues, rather than implying a payout', async () => {
    // Below the I-11 floor the accumulator does not move and the interval is lost.
    reads.pool = {
      ok: true,
      value: poolView({ rewardRate: 1_000_000n, totalPrincipalRaw: 0n, totalWeighted: 0n }),
    };
    reads.wallet = { ok: true, value: { stats: null, slots: [], open: [], truncated: false } };
    draw();
    await statGrid();
    await waitFor(() => expect(screen.getByText('Rewards per day')).toBeTruthy());
    expect(noteFor('Rewards per day')).toMatch(/nothing accrues/);
  });

  it('the minimum stake is not called immutable without saying it is the DEPLOYED program', async () => {
    draw();
    await statGrid();
    const note = noteFor('Minimum stake');
    expect(note).toMatch(/deployed program/);
    expect(note).not.toMatch(/fixed/);
  });
});

/* ────────── 9. a wallet read still in flight is not an empty wallet ────────── */

describe('a wallet read that has not landed yet', () => {
  it('⚠️ renders a reading state, never "0 / 20" or "No open positions"', async () => {
    // The pending path of the venue's most-repeated defect: before the read lands,
    // the card told a staker checking on their money that they held none of it.
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => { release = r; });
    const read = await import('../../lib/ladder/read');
    vi.mocked(read.readLadderWallet).mockImplementation(() => pending as never);
    try {
      draw();
      await statGrid();
      expect(screen.queryByText('No open positions in this pool.')).toBeNull();
      expect(document.body.textContent).not.toMatch(/\b0 \/ 20\b/);
      expect(await screen.findByText(/Reading your positions/)).toBeTruthy();

      // ...and the reading state is not permanent: once the read lands, it is shown.
      release({ ok: true, value: walletView() });
      expect(await screen.findByText('1 / 20')).toBeTruthy();
      expect(screen.queryByText(/Reading your positions/)).toBeNull();
    } finally {
      vi.mocked(read.readLadderWallet).mockImplementation(async () => reads.wallet as never);
    }
  });

  it('a wallet that has READ as never having staked still says so — a real zero stays a zero', async () => {
    // The counter-pin: a fix that shows "reading" forever, or hides a genuine empty
    // wallet, must fail here.
    reads.wallet = { ok: true, value: { stats: null, slots: [], open: [], truncated: false } };
    draw();
    expect(await screen.findByText('No open positions in this pool.')).toBeTruthy();
    expect(within(screen.getByText('Open positions').parentElement!).getByText('0 / 20')).toBeTruthy();
    expect(screen.queryByText(/Reading your positions/)).toBeNull();
  });
});

/* ────────── 10. the exit doors do not overstate ────────── */

describe('what the exit buttons promise', () => {
  it('an EARLY exit says rewards are paid up to what the reward vault holds, the rest stays owed', async () => {
    // exit_with_penalty pays min(owed, reward vault) and carries the remainder to
    // UserStats.rewards_carried. "Your rewards ARE paid out" is false when the vault is short.
    draw();
    const detail = await screen.findByText(/is retained\./);
    expect(detail.textContent).toMatch(/up to what the reward vault holds/);
    expect(detail.textContent).toMatch(/stays owed/);
    expect(detail.textContent).toMatch(/claimable later/);
    expect(document.body.textContent).not.toMatch(/ARE paid out/);
  });

  it('a MATURED withdraw makes the same qualified promise', async () => {
    reads.wallet = { ok: true, value: walletView({ open: [position({ lockEnd: BigInt(NOW - 1) })] }) };
    draw();
    const detail = await screen.findByText(/^No penalty\./);
    expect(detail.textContent).toMatch(/up to what the reward vault holds/);
    expect(detail.textContent).toMatch(/stays owed/);
  });

  it('⚠️ in a DEGRADED pool the early door is priced free, because early_exit charges nothing there', async () => {
    // lib.rs early_exit: `if pool.degraded { 0 } else { penalty_for(amount) }`. A card
    // quoting the penalty here deters the exit the flag was declared to allow.
    // Penalty-independent on purpose: 500 in, 500 back.
    reads.pool = { ok: true, value: poolView({ degraded: true }) };
    draw();
    expect(await screen.findByText(`Exit early — keep ${fmtRaw(500_000_000n, 6)} BAYLA`)).toBeTruthy();
    expect(screen.queryByText(/is retained\./)).toBeNull();
  });

  it('the DEGRADED banner names BOTH early doors as penalty-free, and does not promise forever', async () => {
    reads.pool = { ok: true, value: poolView({ degraded: true }) };
    draw();
    const banner = (await screen.findByText(/declared degraded/)).parentElement!;
    const text = banner.textContent ?? '';
    expect(text).toMatch(/early exit/i);
    expect(text).toMatch(/emergency hatch/i);
    expect(text).toMatch(/penalty/i);
    expect(text).not.toMatch(/cannot be switched back/);
    expect(text).toMatch(/deployed program/);
  });
});

/* ────────── 11. the program can change, and the card says so ────────── */

describe('the upgradeability disclosure', () => {
  it('says matured positions keep full weight, that an upgrade may reset them to the base, and who can upgrade', async () => {
    // "Who" is the upgrade AUTHORITY, not "a multisig": the devnet deployment's
    // authority is not a multisig, and this card renders against whatever program id
    // it is configured with.
    draw();
    await statGrid();
    const disclosure = screen.getByText(/can be upgraded/).closest('p')!;
    const text = disclosure.textContent ?? '';
    expect(text).toMatch(/keeps? (its|their) full (weight|boost)/);
    expect(text).toMatch(/upgrade authority/);
    expect(text).not.toMatch(/multisig/);
    expect(text).toMatch(/may reset/);
    expect(text).toContain('0.40×');
  });
});

/* ────────── 12. switching wallets while something is in flight ────────── */

// A wallet switch does not unmount this card, and every wallet's first position is
// nonce 0 (`UserStats.next_nonce` starts at 0 per owner). So anything the card holds
// for one wallet — a read still in flight, an armed exit door — lands on the next
// wallet's identically-numbered position unless it is tied to the wallet it came from.
const OTHER = '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5';
const EMPTY = { stats: null, slots: [], open: [], truncated: false };

describe('switching wallets while something is in flight', () => {
  let read: typeof import('../../lib/ladder/read');
  const connect = (key: string) => { walletState.publicKey = { toBase58: () => key }; };
  const redraw = (rerender: (ui: React.ReactElement) => void) =>
    rerender(<SolanaLadderPoolLive bungalow={BUNGALOW} />);

  beforeEach(async () => {
    read = await import('../../lib/ladder/read');
    vi.mocked(read.readLadderWallet).mockClear();
  });
  afterEach(() => {
    vi.mocked(read.readLadderWallet).mockImplementation(async () => reads.wallet as never);
  });

  it('⚠️ a write that settles AFTER a switch re-reads the CONNECTED wallet, and never strands it on "Reading"', async () => {
    // Review repro: A starts a stake, the user switches to B, then A's signature is
    // rejected. The write's refresh came from the render the click was in, so it read
    // A and landed A's answer on top of B's. With no key match the card sat on
    // "Reading your positions…" for good — no retry there, and every button that could
    // read again hidden behind it.
    vi.mocked(read.readLadderWallet).mockImplementation(async (_c, _p, _pool, owner) =>
      ({ ok: true, value: owner.toBase58() === OWNER ? walletView() : EMPTY }) as never);
    let settle: (v: { ok: false; reason: string }) => void = () => {};
    writes.stake.mockImplementationOnce(() => new Promise((r) => { settle = r; }) as never);

    const { rerender } = draw();
    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '200' } });
    const lock = screen.getByRole('button', { name: /Lock BAYLA/ }) as HTMLButtonElement;
    await waitFor(() => expect(lock.disabled).toBe(false));
    fireEvent.click(lock);
    expect(writes.stake).toHaveBeenCalledTimes(1);

    connect(OTHER);
    redraw(rerender);
    expect(await screen.findByText('0 / 20')).toBeTruthy();          // B's own read landed

    vi.mocked(read.readLadderWallet).mockClear();
    await act(async () => { settle({ ok: false, reason: 'User rejected the request.' }); });
    expect(await screen.findByText('User rejected the request.')).toBeTruthy();
    await waitFor(() => expect(read.readLadderWallet).toHaveBeenCalled());
    // Judge the card only after every read the settled write started has landed.
    await act(async () => {
      await Promise.all(vi.mocked(read.readLadderWallet).mock.results.map((r) => r.value));
    });

    const owners = vi.mocked(read.readLadderWallet).mock.calls.map((c) => c[3].toBase58());
    expect(owners).not.toContain(OWNER);
    expect(screen.queryByText(/Reading your positions/)).toBeNull();
    expect(screen.getByText('0 / 20')).toBeTruthy();
  });

  it('⚠️ a read for the PREVIOUS wallet that lands late is never stored for the connected one', async () => {
    // "Try again" read through an uncancellable closure as well: switch while its read
    // is in flight, and A's late answer overwrote B's.
    let releaseA: (v: unknown) => void = () => {};
    let pendingA: Promise<unknown> = Promise.resolve();
    let aReads = 0;
    vi.mocked(read.readLadderWallet).mockImplementation((_c, _p, _pool, owner) => {
      if (owner.toBase58() !== OWNER) return Promise.resolve({ ok: true, value: EMPTY }) as never;
      aReads += 1;
      if (aReads === 1) {
        return Promise.resolve({ ok: false, unreadable: true, reason: 'your position could not be read: RPC 503' }) as never;
      }
      pendingA = new Promise((r) => { releaseA = r; });
      return pendingA as never;
    });

    const { rerender } = draw();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(aReads).toBe(2));                     // A's retry is in flight

    connect(OTHER);
    redraw(rerender);
    expect(await screen.findByText('0 / 20')).toBeTruthy();          // B's read landed first

    await act(async () => {
      releaseA({ ok: true, value: walletView() });
      await pendingA;
    });

    expect(screen.queryByText(/Reading your positions/)).toBeNull();
    expect(screen.getByText('0 / 20')).toBeTruthy();
    expect(screen.queryByText('1 / 20')).toBeNull();                 // nor A's positions under B
  });

  // B's first position: 800 BAYLA, nonce 0 — the same nonce as A's.
  const B_VIEW = walletView({
    stats: { address: 'USB', nextNonce: 1, openPositions: 1, rewardsCarriedRaw: 0n, principalRaw: 800_000_000n },
    open: [position({ address: 'POSB0', owner: OTHER, amountRaw: 800_000_000n, weight: 3_200_000_000n })],
  });
  const byOwner = () => vi.mocked(read.readLadderWallet).mockImplementation(async (_c, _p, _pool, owner) =>
    ({ ok: true, value: owner.toBase58() === OWNER ? walletView() : B_VIEW }) as never);

  it('⚠️ an exit door armed by one wallet is NOT armed for the next wallet\'s same-nonce position', async () => {
    // Review repro: A armed its hatch, the user switched to B, and B's nonce-0 row came
    // up already on "Confirm" — the 600 BAYLA price gone from the button, one click from
    // `ladderHatch` signed by B.
    byOwner();
    const { rerender } = draw();
    fireEvent.click(await screen.findByText(/Emergency withdraw — costs 375 BAYLA/));
    expect(await screen.findByText('Confirm')).toBeTruthy();         // armed, for A

    connect(OTHER);
    redraw(rerender);
    expect(await screen.findByText(`Exit early — keep ${fmtRaw(200_000_000n, 6)} BAYLA`)).toBeTruthy();
    expect(screen.queryByText('Confirm')).toBeNull();
    fireEvent.click(screen.getByText(/Emergency withdraw — costs 600 BAYLA/));
    expect(writes.hatch).not.toHaveBeenCalled();                      // armed for B now, not fired
  });

  it('switching away and BACK disarms it too — a confirm belongs to the positions it was given against', async () => {
    byOwner();
    const { rerender } = draw();
    fireEvent.click(await screen.findByText(/Emergency withdraw — costs 375 BAYLA/));
    expect(await screen.findByText('Confirm')).toBeTruthy();

    connect(OTHER);
    redraw(rerender);
    expect(await screen.findByText(`Exit early — keep ${fmtRaw(200_000_000n, 6)} BAYLA`)).toBeTruthy();
    connect(OWNER);
    redraw(rerender);
    expect(await screen.findByText(`Exit early — keep ${fmtRaw(125_000_000n, 6)} BAYLA`)).toBeTruthy();
    expect(screen.queryByText('Confirm')).toBeNull();
    expect(screen.getByText(/Emergency withdraw — costs 375 BAYLA/)).toBeTruthy();
  });
});

/* ────────── 12. the redesign: share, hero meter, staircase, minimum stake ────────── */

const shareValue = () => {
  const label = screen.getByText('Your share of pool weight');
  return label.nextElementSibling?.textContent ?? '';
};

describe('your share of pool weight — a fact, never a yield', () => {
  it('is Σ position weight / pool totalWeighted, FLOORED to a tenth', async () => {
    // 2,000 weight of 2,825 → 70.796…% → 70.7%, where rounding would say 70.8%.
    reads.pool = { ok: true, value: poolView({ totalWeighted: 2_825_000_000n }) };
    draw();
    await screen.findByText('Your share of pool weight');
    expect(shareValue()).toMatch(/^70\.7%/);
    expect(shareValue()).not.toMatch(/70\.8/);
    // The subline names both weights, so the figure can be checked by hand.
    const block = screen.getByText('Your share of pool weight').parentElement!.textContent ?? '';
    expect(block).toContain(`weight ${fmtRaw(2_000_000_000n, 6)} of ${fmtRaw(2_825_000_000n, 6)}`);
  });

  it('⚠️ a PARTIAL position list reads "could not be fully read", never a percentage', async () => {
    reads.pool = { ok: true, value: poolView({ totalWeighted: 2_825_000_000n }) };
    reads.wallet = { ok: true, value: walletView({ truncated: true }) };
    draw();
    await screen.findByText('Your share of pool weight');
    expect(shareValue()).toMatch(/could not be fully read/);
    expect(shareValue()).not.toMatch(/%/);
  });

  it('⚠️ a FAILED pool read renders no share at all — never 0% or 100%', async () => {
    reads.pool = { ok: false, reason: 'The pool could not be read: RPC 503.' };
    draw();
    expect(await screen.findByText(/RPC 503/)).toBeTruthy();
    expect(screen.queryByText('Your share of pool weight')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b(0|100)%/);
  });

  it('is never multiplied into a daily or annual figure', async () => {
    reads.pool = { ok: true, value: poolView({ rewardRate: 1_000_000n, totalWeighted: 2_825_000_000n }) };
    draw();
    await screen.findByText('Your share of pool weight');
    expect(document.body.textContent).not.toMatch(/your daily|per year|annual|\bAPR\b|\bAPY\b/i);
  });
});

describe('the hero meter', () => {
  it('hides the racing digits from screen readers and gives them the exact figure instead', async () => {
    draw();
    const label = await screen.findByText('Earned, unclaimed');
    const value = label.nextElementSibling as HTMLElement;
    const racing = value.querySelector('[aria-hidden="true"]');
    expect(racing).not.toBeNull();
    const sr = value.querySelector('.sr-only');
    expect(sr?.textContent).toMatch(/^Earned, unclaimed: [\d,.]+ BAYLA$/);
    // Never announced sixty times a second.
    expect(value.closest('[aria-live]')).toBeNull();
  });

  it('with no wallet, invites a lock and prints NO placeholder digits', async () => {
    walletState.publicKey = null;
    draw();
    expect(await screen.findByText('Your meter starts when you lock.')).toBeTruthy();
    expect(screen.queryByText('Earned, unclaimed')).toBeNull();
  });

  it('says why it is not moving when the reward window has ended', async () => {
    reads.pool = { ok: true, value: poolView({ rewardRate: 1_000_000n, periodFinish: BigInt(NOW - 2 * DAY) }) };
    draw();
    expect(await screen.findByText(/paused · reward window ended/)).toBeTruthy();
  });

  it('adds a coverage line when what is owed exceeds the reward vault', async () => {
    reads.pool = { ok: true, value: poolView({ rewardRate: 1_000_000n, totalWeighted: 2_000_000_000n }) };
    reads.vaults = { stakeRaw: 1_000_000_000n, rewardRaw: 1_000_000n };   // 1 BAYLA in the vault
    draw();
    expect(await screen.findByText(/a claim pays up to that and the rest stays owed to you/)).toBeTruthy();
  });
});

describe('the hero meter never prints a zero it did not read', () => {
  // read.ts: "a partial list presented as complete is the 'unreadable renders as fine'
  // defect wearing a different hat." A read can SUCCEED and still be partial, and
  // stats.openPositions can count positions the scan did not return. In both cases an
  // empty `open` list is NOT "you have none".
  const heroValue = async () => {
    const label = await screen.findByText('Earned, unclaimed');
    return (label.nextElementSibling as HTMLElement).textContent ?? '';
  };

  it('⚠️ a TRUNCATED scan with no positions returned: no "0", no "No open positions"', async () => {
    reads.wallet = { ok: true, value: walletView({ truncated: true, open: [] }) };
    draw();
    const v = await heroValue();
    expect(v).not.toMatch(/^\s*0(?![\d.,])/);
    expect(v).toMatch(/could not be fully read/);
    expect(document.body.textContent).not.toMatch(/No open positions/);
  });

  it('⚠️ openPositions > 0 but the list came back empty: no "0", no "No open positions"', async () => {
    // stats say 1 open, the scan returned none (e.g. a slot that would not decode).
    reads.wallet = { ok: true, value: walletView({ truncated: false, open: [] }) };
    draw();
    const v = await heroValue();
    expect(v).not.toMatch(/^\s*0(?![\d.,])/);
    expect(v).toMatch(/could not be fully read/);
    expect(document.body.textContent).not.toMatch(/No open positions/);
  });

  it('a COMPLETE read of a wallet with none still shows the honest zero', async () => {
    reads.wallet = { ok: true, value: { stats: null, slots: [], open: [], truncated: false } };
    draw();
    expect(await heroValue()).toMatch(/^0\s*BAYLA$/);
    expect(screen.getByText(/No open positions — pick a rung below/)).toBeTruthy();
  });

  it('a partial list WITH positions labels its figure as partial', async () => {
    reads.wallet = { ok: true, value: walletView({ truncated: true }) };
    draw();
    await heroValue();
    expect(screen.getByText(/covers only the positions this view could read/)).toBeTruthy();
  });
});

describe('the staircase', () => {
  it('is climbable WITHOUT a wallet — seven real buttons, one pressed', async () => {
    walletState.publicKey = null;
    draw();
    const group = await screen.findByRole('group', { name: /Lock length/ });
    const rungs = within(group).getAllByRole('button');
    expect(rungs).toHaveLength(7);
    expect(rungs.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    fireEvent.click(within(group).getByRole('button', { name: /^4y lock, 4\.00× weight$/ }));
    expect(within(group).getByRole('button', { name: /^4y lock/ }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('the minimum stake is shown in every state', () => {
  it('when DISCONNECTED', async () => {
    walletState.publicKey = null;
    draw();
    const label = await screen.findByText('Minimum stake');
    expect(label.nextElementSibling?.textContent).toMatch(/^100\s*BAYLA$/);
  });

  it('when CONNECTED, beside the amount', async () => {
    draw();
    await screen.findByLabelText('Amount');
    const label = screen.getByText('Minimum stake');
    expect(label.nextElementSibling?.textContent).toMatch(/^100\s*BAYLA$/);
  });

  it('keeps its disclosure, linked to it for assistive tech', async () => {
    draw();
    const label = await screen.findByText('Minimum stake');
    const id = label.parentElement!.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)!.textContent).toMatch(/the deployed program has no setter for it/);
  });
});

/* ────────── 13. the share is SLOT-CONSISTENT (review gaps 1, 2 and 4) ────────── */

// Whole-token weights, so the worked example reads as it does in the review.
const W = (n: number) => BigInt(n) * 1_000_000n;

describe('⚠️ the share never divides one read by another read\'s total', () => {
  // THE WORKED EXAMPLE. Pool 100, you hold 10 (10%). You stake +10: you hold 20, the
  // true total is 110, the true share 18.18%. A pool read still carrying the OLD 100
  // divided into the NEW 20 prints 20% — better than the truth — and the old guard
  // (mine > total) lets it straight through, because 20 < 100.
  it('WORKED EXAMPLE: a stale pool total of 100 and a wallet of 20 never prints 20% — it prints nothing', async () => {
    reads.pool = { ok: true, value: poolView({ totalWeighted: W(100) }) };
    reads.wallet = { ok: true, value: walletView({ open: [position({ weight: W(20) })], shareBasis: null }) };
    draw();
    await screen.findByText('Your share of pool weight');
    expect(shareValue()).not.toMatch(/20%/);
    expect(shareValue()).not.toMatch(/%/);
    expect(shareValue()).toMatch(/could not be read/);
  });

  it('the same wallet, with the total read IN ITS OWN CALL (110), prints 18.1% — even against the stale 100', async () => {
    reads.pool = { ok: true, value: poolView({ totalWeighted: W(100) }) };
    reads.wallet = {
      ok: true,
      value: walletView({ open: [position({ weight: W(20) })], shareBasis: { mineWeight: W(20), totalWeighted: W(110) } }),
    };
    draw();
    await screen.findByText('Your share of pool weight');
    expect(shareValue()).toMatch(/^18\.1%/);
    const block = screen.getByText('Your share of pool weight').parentElement!.textContent ?? '';
    expect(block).toContain(`weight ${fmtRaw(W(20), 6)} of ${fmtRaw(W(110), 6)}`);
  });

  it('a pool read FRESHER than the wallet (others staked: 130) still prints a share — the lower one', async () => {
    // The counter-pin: a fix that refuses whenever the two totals differ must fail here.
    // A fresher, larger total can only make the share smaller, so it is printed — and
    // it is the smaller of the two readings, never the larger.
    reads.pool = { ok: true, value: poolView({ totalWeighted: W(130) }) };
    reads.wallet = {
      ok: true,
      value: walletView({ open: [position({ weight: W(20) })], shareBasis: { mineWeight: W(20), totalWeighted: W(110) } }),
    };
    draw();
    await screen.findByText('Your share of pool weight');
    expect(shareValue()).toMatch(/^15\.3%/);
    const block = screen.getByText('Your share of pool weight').parentElement!.textContent ?? '';
    expect(block).toContain(`weight ${fmtRaw(W(20), 6)} of ${fmtRaw(W(130), 6)}`);
  });
});

describe('⚠️ a PARTIAL wallet list prints no share, flagged or not (gap 2)', () => {
  it('openPositions says 2, one came back, truncated is false: "could not be fully read", no percentage', async () => {
    reads.pool = { ok: true, value: poolView({ totalWeighted: 2_825_000_000n }) };
    reads.wallet = {
      ok: true,
      value: walletView({
        stats: { address: 'US', nextNonce: 2, openPositions: 2, rewardsCarriedRaw: 0n, principalRaw: 1_000_000_000n },
        truncated: false,
      }),
    };
    draw();
    await screen.findByText('Your share of pool weight');
    expect(shareValue()).not.toMatch(/%/);
    expect(shareValue()).toMatch(/could not be fully read/);
  });
});

describe('a first stake does not leave a stale "No open positions" on screen (gap 4)', () => {
  it('⚠️ after a confirmed stake, the pre-stake empty read shows "Updating…" until the re-read lands', async () => {
    const read = await import('../../lib/ladder/read');
    reads.wallet = { ok: true, value: { stats: null, slots: [], open: [], truncated: false, shareBasis: null } };
    try {
      draw();
      expect(await screen.findByText(/No open positions — pick a rung below/)).toBeTruthy();

      // Hold the post-stake re-read so the in-between state can be looked at.
      let release: (v: unknown) => void = () => {};
      const pending = new Promise((r) => { release = r; });
      vi.mocked(read.readLadderWallet).mockImplementation(() => pending as never);

      fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '200' } });
      const lock = screen.getByRole('button', { name: /Lock BAYLA/ }) as HTMLButtonElement;
      await waitFor(() => expect(lock.disabled).toBe(false));
      await act(async () => { fireEvent.click(lock); });
      expect(await screen.findByText(/confirmed\./)).toBeTruthy();

      expect(screen.queryByText(/No open positions/)).toBeNull();
      expect(screen.getAllByText(/Updating your positions/).length).toBeGreaterThan(0);

      // ...and it is not permanent: the re-read lands and is shown.
      await act(async () => { release({ ok: true, value: walletView() }); });
      expect(await screen.findByText('1 / 20')).toBeTruthy();
      expect(screen.queryByText(/Updating your positions/)).toBeNull();
    } finally {
      vi.mocked(read.readLadderWallet).mockImplementation(async () => reads.wallet as never);
    }
  });

  it('a FAILED stake leaves the (still true) empty state alone', async () => {
    reads.wallet = { ok: true, value: { stats: null, slots: [], open: [], truncated: false, shareBasis: null } };
    writes.stake.mockImplementationOnce(async () => ({ ok: false, reason: 'User rejected the request.' }) as never);
    draw();
    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '200' } });
    const lock = screen.getByRole('button', { name: /Lock BAYLA/ }) as HTMLButtonElement;
    await waitFor(() => expect(lock.disabled).toBe(false));
    await act(async () => { fireEvent.click(lock); });
    expect(await screen.findByText('User rejected the request.')).toBeTruthy();
    expect(await screen.findByText(/No open positions — pick a rung below/)).toBeTruthy();
    expect(screen.queryByText(/Updating your positions/)).toBeNull();
  });
});

/* ────────── 14. after YOUR OWN confirmed write, a basis older than it is not a share ────────── */

// POST-EXIT LAG. The card marked a read stale by OBJECT IDENTITY only, so any read landing
// after your confirmed exit counted as fresh — even one served by an RPC node still at a
// pre-exit slot. After an exit the true share (W-w)/(T-w) is BELOW W/T, so that read
// over-reads until the next 45s poll. The basis now carries the slot it was read at, the
// write carries the slot it confirmed at, and the basis is stale while basisSlot <
// writeSlot — and whenever either slot is missing (fail CLOSED). Stale shows "updating…".
describe('⚠️ a share basis older than your confirmed exit is "updating…", never the old figure', () => {
  // Two positions, so after one exits there is still weight — and a share — to state.
  const twoOpen = (basis: { mineWeight: bigint; totalWeighted: bigint; slot?: number | null } | null) => walletView({
    stats: { address: 'US', nextNonce: 2, openPositions: 2, rewardsCarriedRaw: 0n, principalRaw: 1_000_000_000n },
    open: [position({ nonce: 0, address: 'POS0', weight: W(20) }), position({ nonce: 1, address: 'POS1', weight: W(10) })],
    shareBasis: basis,
  });

  const exitFirst = async (writeResult: Record<string, unknown>, postExitRead: unknown) => {
    reads.pool = { ok: true, value: poolView({ totalWeighted: W(100) }) };
    reads.wallet = { ok: true, value: twoOpen({ mineWeight: W(30), totalWeighted: W(100), slot: 300 }) };
    writes.exit.mockImplementationOnce(async () => writeResult as never);
    draw();
    await screen.findByText('Your share of pool weight');
    await waitFor(() => expect(shareValue()).toMatch(/^30%/));
    // The re-read that lands after the exit.
    reads.wallet = postExitRead;
    const early = (await screen.findAllByText(/^Exit early — keep/))[0]!;
    await act(async () => { fireEvent.click(early); });
    await act(async () => { fireEvent.click(await screen.findByText('Confirm')); });
    expect(await screen.findByText(/confirmed\./)).toBeTruthy();
    await waitFor(() => expect(vi.mocked(writes.exit)).toHaveBeenCalledTimes(1));
  };

  it('⚠️ a basis read at slot 400, BELOW the exit confirmed at 500, renders "updating…", not 30%', async () => {
    // An RPC node still at a pre-exit slot: both positions, the pre-exit total.
    await exitFirst(
      { ok: true, signature: 'SIG', slot: 500 },
      { ok: true, value: twoOpen({ mineWeight: W(30), totalWeighted: W(100), slot: 400 }) },
    );
    await waitFor(() => expect(shareValue()).toMatch(/updating…/));
    expect(shareValue()).not.toMatch(/%/);
  });

  it('⚠️ a write whose confirmed slot is MISSING fails closed: "updating…", even over a later basis', async () => {
    await exitFirst(
      { ok: true, signature: 'SIG' },
      { ok: true, value: twoOpen({ mineWeight: W(30), totalWeighted: W(100), slot: 600 }) },
    );
    await waitFor(() => expect(shareValue()).toMatch(/updating…/));
    expect(shareValue()).not.toMatch(/%/);
  });

  it('⚠️ a basis with NO slot after a confirmed exit fails closed: "updating…"', async () => {
    await exitFirst(
      { ok: true, signature: 'SIG', slot: 500 },
      { ok: true, value: twoOpen({ mineWeight: W(30), totalWeighted: W(100) }) },
    );
    await waitFor(() => expect(shareValue()).toMatch(/updating…/));
    expect(shareValue()).not.toMatch(/%/);
  });

  it('a basis read AT or after the exit slot is a share again — the lag is not permanent', async () => {
    // The counter-pin: a fix that blanks the share after every write must fail here.
    await exitFirst(
      { ok: true, signature: 'SIG', slot: 500 },
      { ok: true, value: twoOpen({ mineWeight: W(10), totalWeighted: W(80), slot: 500 }) },
    );
    await waitFor(() => expect(shareValue()).toMatch(/^10%/));
  });
});
