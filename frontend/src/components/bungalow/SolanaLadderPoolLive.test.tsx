// A WIRING PIN for the Solana ladder card.
//
// The math is unit-tested in lib/ladder. What only a render can catch is the
// component handing the wrong value to the right helper, or printing a figure the
// helper never produced. Three of those would cost a user real money:
//
//   1. The emergency hatch priced as free while a position is LOCKED. It charges the
//      same flat 25% as an early exit, the penalty rides inside a base64 event so no
//      dry run reveals it, and this repo has already had that wrong in the operator
//      CLI, in the runbook, and out loud.
//   2. Rewards printed from the stored `rewards_owed`, which only moves when somebody
//      touches the pool — so a position earning for a month reads zero on chain.
//   3. A failed read rendered as a zero, which tells a staker their money is gone.
//
// The READ SEAM is mocked one module below the card and the math above it stays real,
// which is what makes those three assertions mean anything.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const NOW = 1_800_000_000;              // fixed clock; every fixture is relative to it
const POOL_ADDR = '2RJNUuj3y8CDibhCehvRoufAvkBG9idpKrryYosvZxi4';
const MINT = '8opsYTPSp2AckjmAc2vx49kohs8CFtNcyR2sNURfrfoL';
const OWNER = 'Gut9toQMqtrFL5ERLsAThmtq6e1Hq9BGtWPcjNqziHrj';

/* ─────────────────────────── the rig ─────────────────────────── */

vi.mock('../solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: React.ReactNode }) => children,
}));

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

const { SolanaLadderPoolLive } = await import('./SolanaLadderPoolLive');

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
  weight: 200_000_000n,                    // 0.40x, the seven-day floor
  lockEnd: BigInt(NOW + 7 * DAY),          // LOCKED
  rewardPerWeightPaid: 0n,
  rewardsOwed: 0n,
  ...o,
});

const walletView = (o: Record<string, unknown> = {}) => ({
  stats: {
    address: 'US', nextNonce: 1, openPositions: 1,
    rewardsCarriedRaw: 0n, principalRaw: 500_000_000n,
  },
  slots: [], open: [position()], truncated: false,
  ...o,
});

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
  it('⚠️ a LOCKED position is told the hatch costs 125 of its 500', () => {
    // 500 x 2500bps = 125. The single most expensive thing this repo has said
    // wrongly about this program.
    draw();
    return screen.findByText(/Emergency withdraw — costs 125 BAYLA/).then((btn) => {
      expect(btn).toBeTruthy();
      expect(screen.queryByText(/Emergency withdraw — no penalty/)).toBeNull();
    });
  });

  it('a MATURED position is told the hatch is free, because by then it is', async () => {
    reads.wallet = { ok: true, value: walletView({ open: [position({ lockEnd: BigInt(NOW - 1) })] }) };
    draw();
    expect(await screen.findByText(/Emergency withdraw — no penalty/)).toBeTruthy();
    expect(screen.queryByText(/Emergency withdraw — costs/)).toBeNull();
  });

  it('a DEGRADED pool frees the hatch even while the position is locked', async () => {
    // The flag exists so a captured or absent operator cannot trap anyone. If the
    // card kept quoting 25% here it would deter the exit the flag was set to allow.
    reads.pool = { ok: true, value: poolView({ degraded: true }) };
    draw();
    expect(await screen.findByText(/Emergency withdraw — no penalty/)).toBeTruthy();
  });

  it('the hatch needs a second click before it sends anything', async () => {
    draw();
    const btn = await screen.findByText(/Emergency withdraw — costs 125 BAYLA/);
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
    expect(await screen.findByText(/cannot be lowered/i)).toBeTruthy();
    const stake = screen.getByRole('button', { name: /Lock BAYLA/ });
    expect((stake as HTMLButtonElement).disabled).toBe(true);
  });

  it('accepts an amount that clears every gate', async () => {
    // The other half of the pin: a gate that refuses EVERYTHING is not a working
    // gate, and a refusal test alone cannot tell the two apart.
    draw();
    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '200' } });
    expect(screen.queryByText(/cannot be lowered/i)).toBeNull();
    const stake = screen.getByRole('button', { name: /Lock BAYLA/ });
    expect((stake as HTMLButtonElement).disabled).toBe(false);
  });

  it('refuses more than the wallet holds', async () => {
    reads.balance = 150_000_000n;
    draw();
    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '200' } });
    expect(await screen.findByText(/more BAYLA than this wallet holds/)).toBeTruthy();
  });

  it('a degraded pool takes no new stakes, and says why', async () => {
    reads.pool = { ok: true, value: poolView({ degraded: true }) };
    draw();
    expect(await screen.findByText(/takes no new stakes/)).toBeTruthy();
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

describe('rewards the hatch set aside', () => {
  it('shows a carried balance and a way to claim it', async () => {
    reads.wallet = {
      ok: true,
      value: walletView({
        stats: { address: 'US', nextNonce: 1, openPositions: 1, rewardsCarriedRaw: 42_000_000n, principalRaw: 500_000_000n },
      }),
    };
    draw();
    expect(await screen.findByText(/42 BAYLA/)).toBeTruthy();
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
});
