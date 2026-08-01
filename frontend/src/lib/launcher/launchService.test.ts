import { describe, it, expect, vi } from 'vitest';
import { parseEther, type Address } from 'viem';

// GO-LIVE 2026-07-22: LAUNCHER_ENABLED is now true in production. The gate-guard test
// below must still verify the INVARIANT (a disabled launcher refuses to launch), so it
// forces the gate shut here rather than depending on the production flag value. The real
// config values (integrator, fee tier) are preserved via the actual module.
// A controllable exotic gate so we can exercise BOTH the gated-off path (TOWELI
// rejected) and the enabled path (TOWELI threading) without touching the real flag.
const numeraireGate = vi.hoisted(() => ({ exoticOn: false }));
vi.mock('./config', async (importActual) => {
  const actual = await importActual<typeof import('./config')>();
  return {
    ...actual,
    isLauncherEnabled: () => false,
    isAllowedNumeraire: (n: `0x${string}`) =>
      n.toLowerCase() === actual.ETH_NUMERAIRE.toLowerCase() ||
      (numeraireGate.exoticOn && n.toLowerCase() === actual.TOWELI_NUMERAIRE.toLowerCase()),
  };
});
import {
  wizardConfigToLaunchConfig,
  launchToken,
  resolveFeeConstitution,
  beneficiariesToFeeConstitution,
  protocolFeeSink,
  isUserRejection,
  extractTxHash,
  LaunchError,
  type LaunchWizardInput,
  type LaunchMapOptions,
  type FeeRoleAddresses,
} from './launchService';
import { feeConstitutionToBeneficiaries } from './airlock';
import { DOPPLER_MAINNET } from './doppler.constants';
import { REVENUE_DISTRIBUTOR_ADDRESS, TREASURY_ADDRESS, LOCKER_CLAIMER_ADDRESS } from '../constants';
import { LAUNCHER_INTEGRATOR_ADDRESS, LAUNCH_FEE_TIER, DEFAULT_FEE_CONSTITUTION, ETH_NUMERAIRE, TOWELI_NUMERAIRE } from './config';

// The wizard used to DISPLAY and ATTEST the static DEFAULT_FEE_CONSTITUTION
// (Creator 70% / Attention 10%), but resolveFeeConstitution treats creator+attention
// as ONE 80% creator-directed pool. These pin the real resolved split so the two
// can't silently diverge again (the displayed/attested Fact Sheet must match what
// the StreamableFeesLocker actually pays).
describe('resolveFeeConstitution — the deployed split, not the 70/10 template', () => {
  const CREATOR = '0x1489a1B0dF0e5F7B2C4d3E6a7b8c9D0e1F2A3456' as Address;
  const KOL = '0x00000000000000000000000000000000000000AA' as Address;
  const sum = (lines: { shareBps: number }[]) => lines.reduce((n, l) => n + l.shareBps, 0);
  const share = (lines: { role: string; shareBps: number }[], role: string) =>
    lines.filter((l) => l.role === role).reduce((n, l) => n + l.shareBps, 0);

  it('with NO carve, the creator keeps the whole 80% pool (not 70%), attention 0 (not 10%)', () => {
    const r = resolveFeeConstitution(CREATOR, []);
    expect(share(r, 'creator')).toBe(8000);
    expect(share(r, 'attention-beneficiary')).toBe(0);
    // This is exactly the mismatch: the static template claims 70/10.
    expect(share([...DEFAULT_FEE_CONSTITUTION], 'creator')).toBe(7000);
    expect(share([...DEFAULT_FEE_CONSTITUTION], 'attention-beneficiary')).toBe(1000);
    expect(sum(r)).toBe(10000);
  });

  it('a carve comes OUT of the creator pool (creator + carve == 8000), fixed lines untouched', () => {
    const r = resolveFeeConstitution(CREATOR, [{ address: KOL, shareBps: 1500 }]);
    expect(share(r, 'attention-beneficiary')).toBe(1500);
    expect(share(r, 'creator')).toBe(6500); // 8000 - 1500
    expect(share(r, 'protocol-stakers')).toBe(1500);
    expect(share(r, 'doppler')).toBe(500);
    expect(sum(r)).toBe(10000);
  });

  it('throws if carves over-allocate the 80% pool', () => {
    expect(() => resolveFeeConstitution(CREATOR, [{ address: KOL, shareBps: 8500 }])).toThrow();
  });
});

// The 15% protocol fee line must name a beneficiary that can CLAIM it. The locker is
// pull-based and pays msg.sender only, so a beneficiary with no way to call it strands the
// money permanently — which is what pointing at RevenueDistributor did. Both numeraires now
// route to Treasury (a Safe, which can originate the claim). Pins the sink AND its label so
// neither the routing nor the published Fact Sheet can drift back.
describe('resolveFeeConstitution — protocol sink must be claimable', () => {
  const CREATOR = '0x1489a1B0dF0e5F7B2C4d3E6a7b8c9D0e1F2A3456' as Address;
  const protocolLine = (numeraire?: Address) =>
    resolveFeeConstitution(CREATOR, [], numeraire).find((l) => l.role === 'protocol-stakers')!;

  // THE INVARIANT: the protocol fee line must name a beneficiary that can actually CLAIM.
  // StreamableFeesLocker.releaseFees pays msg.sender only, and RevenueDistributor has no
  // arbitrary-call function — so naming it strands the whole 15% permanently. The
  // beneficiary set is fixed at create time and the locker has no admin re-point, so this
  // has to be right BEFORE launch #1. Pinning the property, not just the address.
  const CAN_ORIGINATE_A_LOCKER_CLAIM = [LOCKER_CLAIMER_ADDRESS.toLowerCase(), TREASURY_ADDRESS.toLowerCase()];

  it('every numeraire routes the protocol line to a sink that can claim from the locker', () => {
    for (const line of [protocolLine(), protocolLine(ETH_NUMERAIRE), protocolLine(TOWELI_NUMERAIRE)]) {
      expect(CAN_ORIGINATE_A_LOCKER_CLAIM).toContain(line.address.toLowerCase());
      // Mutation-check: pre-fix the ETH branch resolved to REVENUE_DISTRIBUTOR_ADDRESS,
      // which no transaction can ever make the msg.sender of locker.releaseFees.
      expect(line.address.toLowerCase()).not.toBe(REVENUE_DISTRIBUTOR_ADDRESS.toLowerCase());
      expect(line.shareBps).toBe(1500); // only the sink + label move — the 15% is unchanged
    }
  });

  it('labels the protocol line for where the money actually goes, per numeraire', () => {
    // The Fact Sheet publishes this string, permanently and on-chain. A locker position has
    // TWO currencies: on an ETH pair the numeraire leg reaches RevenueDistributor through
    // LockerClaimer, so "stakers" is true; on an exotic pair BOTH legs are ERC20 and sweep
    // to the Safe, so claiming staker yield there would be false.
    expect(protocolLine(ETH_NUMERAIRE).recipient).toBe('Tegridy stakers');
    expect(protocolLine(TOWELI_NUMERAIRE).recipient).toBe('Tegridy treasury');
    expect(protocolLine(TOWELI_NUMERAIRE).recipient).not.toMatch(/staker/i);
  });

  it('protocolFeeSink is the single source of truth for both sink + label', () => {
    expect(protocolFeeSink(ETH_NUMERAIRE)).toEqual({ address: LOCKER_CLAIMER_ADDRESS, recipient: 'Tegridy stakers' });
    expect(protocolFeeSink(TOWELI_NUMERAIRE)).toEqual({ address: LOCKER_CLAIMER_ADDRESS, recipient: 'Tegridy treasury' });
  });
});

// The broadcast tag is the anti-double-launch invariant: a submit failure that MAY have
// already broadcast the tx must NOT be offered a blind retry (that would mint a duplicate
// token + double payment). Classification lives in isUserRejection — only a user-rejected
// signature is provably pre-broadcast — so pin it: a regression that treats a receipt
// timeout as safe-to-retry fails loudly here.
describe('LaunchError broadcast tagging (anti-double-launch)', () => {
  const hex64 = (b: string) => ('0x' + b.repeat(32)) as `0x${string}`;

  it('defaults broadcast=false and carries an explicit true + txHash', () => {
    expect(new LaunchError('invalid-config', 'x').broadcast).toBe(false);
    const e = new LaunchError('submit-failed', 'x', { broadcast: true, txHash: hex64('ab') });
    expect(e.broadcast).toBe(true);
    expect(e.txHash).toBe(hex64('ab'));
  });

  it('isUserRejection: only a wallet rejection is provably pre-broadcast', () => {
    expect(isUserRejection({ code: 4001, message: 'User rejected the request' })).toBe(true);
    expect(isUserRejection({ name: 'UserRejectedRequestError' })).toBe(true);
    expect(isUserRejection({ code: 'ACTION_REJECTED' })).toBe(true);
    expect(isUserRejection({ cause: { code: 4001 } })).toBe(true); // walks the cause chain
    // The dangerous case: a receipt-wait timeout is NOT a rejection -> tagged broadcast=true.
    expect(isUserRejection(new Error('Timed out while waiting for transaction receipt'))).toBe(false);
    expect(isUserRejection({ message: 'nonce too low' })).toBe(false);
  });

  it('extractTxHash: pulls a 32-byte hash from the error or its cause, else undefined', () => {
    expect(extractTxHash({ transactionHash: hex64('cd') })).toBe(hex64('cd'));
    expect(extractTxHash({ cause: { hash: hex64('ef') } })).toBe(hex64('ef'));
    expect(extractTxHash({ transactionHash: '0xdead' })).toBeUndefined(); // malformed
    expect(extractTxHash(new Error('no hash here'))).toBeUndefined();
  });
});

// The POST-GRADUATION fully-verifiable disclosure: reverse the REAL on-chain locker
// beneficiary set back into labelled fee lines. These pin the exact WAD->bps math and
// role labelling so a mutated map (floor instead of round, a swapped/dropped role, a
// mislabelled address) fails loudly.
describe('beneficiariesToFeeConstitution — reverse of the on-chain locker split', () => {
  const CREATOR = '0x1489a1B0dF0e5F7B2C4d3E6a7b8c9D0e1F2A3456' as Address;
  const KOL = '0x00000000000000000000000000000000000000AA' as Address;
  const roles: FeeRoleAddresses = {
    creator: CREATOR,
    // Track the real sink, exactly as the post-graduation re-attestation does
    // (launchService.ts resolves it via protocolFeeSink). Hardcoding an address here
    // would silently mislabel the protocol line as soon as the sink moves — which is
    // precisely what happened when it did.
    protocolStakers: protocolFeeSink().address,
    doppler: DOPPLER_MAINNET.airlockOwner,
  };
  const WAD = 10n ** 18n;
  const bpsToShares = (bps: number) => (BigInt(bps) * WAD) / 10_000n; // forward: bps * 1e14
  const byRole = (lines: { role: string; shareBps: number }[], role: string) =>
    lines.filter((l) => l.role === role).reduce((n, l) => n + l.shareBps, 0);

  it('ROUND-TRIP: resolve -> feeConstitutionToBeneficiaries -> reverse recovers roles + bps (sums 10000)', () => {
    const resolved = resolveFeeConstitution(CREATOR, [{ address: KOL, shareBps: 1500 }]);
    const bens = feeConstitutionToBeneficiaries(resolved); // {beneficiary, shares}[], address-sorted
    const recovered = beneficiariesToFeeConstitution(bens, roles);
    expect(recovered.reduce((n, l) => n + l.shareBps, 0)).toBe(10000);
    expect(byRole(recovered, 'creator')).toBe(6500); // 8000 - 1500 carve
    expect(byRole(recovered, 'attention-beneficiary')).toBe(1500);
    expect(byRole(recovered, 'protocol-stakers')).toBe(1500);
    expect(byRole(recovered, 'doppler')).toBe(500);
    // labels mirror the forward path exactly
    expect(recovered.find((l) => l.role === 'creator')?.recipient).toBe('Creator');
    expect(recovered.find((l) => l.role === 'protocol-stakers')?.recipient).toBe(protocolFeeSink().recipient);
    expect(recovered.find((l) => l.role === 'doppler')?.recipient).toBe('Doppler');
    // the attention line's recipient is the KOL's own address
    expect(recovered.find((l) => l.role === 'attention-beneficiary')?.recipient?.toLowerCase()).toBe(KOL.toLowerCase());
  });

  it('EXOTIC round-trip: a TOWELI launch routes protocol -> Treasury, labelled "Tegridy treasury"', () => {
    // Forward-resolve with the TOWELI numeraire, then reverse with the numeraire-appropriate
    // sink (as the re-attestation does via protocolFeeSink). The disclosure must recover the
    // Treasury sink + honest label, never the ETH "stakers" line for a pair that can't yield.
    const resolved = resolveFeeConstitution(CREATOR, [], TOWELI_NUMERAIRE);
    const bens = feeConstitutionToBeneficiaries(resolved);
    const sink = protocolFeeSink(TOWELI_NUMERAIRE);
    const exoticRoles: FeeRoleAddresses = { ...roles, protocolStakers: sink.address, protocolRecipient: sink.recipient };
    const recovered = beneficiariesToFeeConstitution(bens, exoticRoles);
    const protocol = recovered.find((l) => l.role === 'protocol-stakers');
    expect(protocol?.shareBps).toBe(1500);
    expect(protocol?.recipient).toBe('Tegridy treasury');
    expect(recovered.reduce((n, l) => n + l.shareBps, 0)).toBe(10000);
  });

  it('exact WAD shares (bps * 1e14) round-trip to exact bps', () => {
    const bens = [
      { beneficiary: CREATOR, shares: bpsToShares(7000) },
      { beneficiary: LOCKER_CLAIMER_ADDRESS, shares: bpsToShares(1500) },
      { beneficiary: DOPPLER_MAINNET.airlockOwner, shares: bpsToShares(500) },
      { beneficiary: KOL, shares: bpsToShares(1000) },
    ];
    const lines = beneficiariesToFeeConstitution(bens, roles);
    expect(lines.map((l) => l.shareBps)).toEqual([7000, 1500, 500, 1000]);
    expect(lines.reduce((n, l) => n + l.shareBps, 0)).toBe(10000);
  });

  it('uses Math.round, NOT floor/trunc: a share just under a bps boundary rounds UP', () => {
    // 149_997e12 wei = 1499.97 bps. Math.round -> 1500; floor/trunc -> 1499. The wei
    // deficit (3e12) is far larger than a double''s spacing near 1.5e17, so it survives
    // Number() and genuinely exercises the rounding direction (a real normalise remainder
    // of a few wei would be erased by Number and round/floor would agree — this pins round).
    const [line] = beneficiariesToFeeConstitution([{ beneficiary: KOL, shares: 149_997_000_000_000_000n }], roles);
    expect(line.shareBps).toBe(1500);
  });

  it('labels each fixed role by address (case-insensitive) and everything else as attention', () => {
    const OTHER = '0x00000000000000000000000000000000000000bb' as Address;
    const bens = [
      { beneficiary: CREATOR.toLowerCase() as Address, shares: bpsToShares(6000) }, // creator given lowercased
      { beneficiary: LOCKER_CLAIMER_ADDRESS, shares: bpsToShares(1500) },
      { beneficiary: DOPPLER_MAINNET.airlockOwner, shares: bpsToShares(500) },
      { beneficiary: KOL, shares: bpsToShares(1000) },
      { beneficiary: OTHER, shares: bpsToShares(1000) },
    ];
    const lines = beneficiariesToFeeConstitution(bens, roles);
    expect(lines.map((l) => l.role)).toEqual([
      'creator',
      'protocol-stakers',
      'doppler',
      'attention-beneficiary',
      'attention-beneficiary',
    ]);
    // order is preserved from the locker input
    expect(lines[3].recipient?.toLowerCase()).toBe(KOL.toLowerCase());
    expect(lines[4].recipient?.toLowerCase()).toBe(OTHER.toLowerCase());
  });
});

const USER = '0x1111111111111111111111111111111111111111' as Address;
const KOL = '0x2222222222222222222222222222222222222222' as Address;

function wizard(overrides: Partial<LaunchWizardInput> = {}): LaunchWizardInput {
  return {
    name: 'Tegridy Launch',
    symbol: 'TGL',
    tokenURI: 'ipfs://meta',
    tier: 'flagship',
    totalSupply: '1000000000', // 1B whole tokens
    premineBps: 0,
    vestMonths: 12,
    cliffMonths: 0,
    mcapStartK: 300, // $300k
    mcapFloorK: 30, // $30k
    lpLockMonths: 12,
    ...overrides,
  };
}

function opts(overrides: Partial<LaunchMapOptions> = {}): LaunchMapOptions {
  return { userAddress: USER, numerairePriceUsd: 1881, ...overrides };
}

describe('wizardConfigToLaunchConfig — mapping', () => {
  it('scales supply to 18 decimals; 0% premine sells the whole supply', () => {
    const cfg = wizardConfigToLaunchConfig(wizard({ premineBps: 0 }), opts());
    expect(cfg.initialSupply).toBe(parseEther('1000000000'));
    expect(cfg.numTokensToSell).toBe(parseEther('1000000000')); // fair launch -> sell all
  });

  it('wires a premine to an on-chain vesting schedule (reserved remainder, sale reduced)', () => {
    const cfg = wizardConfigToLaunchConfig(wizard({ premineBps: 1000, vestMonths: 6, cliffMonths: 1 }), opts());
    // 10% reserved -> 90% auctioned; the reserved remainder is vested to the creator.
    expect(cfg.numTokensToSell).toBe(parseEther('900000000'));
    const premine = cfg.initialSupply - cfg.numTokensToSell;
    expect(premine).toBe(parseEther('100000000'));
    expect(cfg.vesting).toBeDefined();
    expect(cfg.vesting!.amount).toBe(premine);
    // Duration/cliff map through at 365/12 days per month.
    expect(cfg.vesting!.durationSeconds).toBe(Math.round(6 * (365 / 12) * 86_400));
    expect(cfg.vesting!.cliffSeconds).toBe(Math.round(1 * (365 / 12) * 86_400));
  });

  it('omits vesting entirely on a fair launch (byte-identical no-premine path)', () => {
    const cfg = wizardConfigToLaunchConfig(wizard({ premineBps: 0 }), opts());
    expect(cfg.vesting).toBeUndefined();
  });

  it('caps the premine at the policy maximum and requires a positive vest duration', () => {
    // Over the 20% cap.
    expect(() => wizardConfigToLaunchConfig(wizard({ premineBps: 2001, vestMonths: 12 }), opts())).toThrow(/between 0% and 20%/);
    // A premine with no vesting window is not "vested" — refuse.
    expect(() => wizardConfigToLaunchConfig(wizard({ premineBps: 500, vestMonths: 0 }), opts())).toThrow(/vesting duration/);
    // A cliff longer than the vest is nonsensical.
    expect(() => wizardConfigToLaunchConfig(wizard({ premineBps: 500, vestMonths: 6, cliffMonths: 7 }), opts())).toThrow(/cliff/);
  });

  it('rejects an attention split directed at the protocol or Doppler beneficiary address', () => {
    expect(() =>
      wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: protocolFeeSink().address, shareBps: 2000 }] })),
    ).toThrow(/protocol or Doppler/);
    expect(() =>
      wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: DOPPLER_MAINNET.airlockOwner, shareBps: 500 }] })),
    ).toThrow(/protocol or Doppler/);
  });

  it('rejects invalid wizard state (zero supply, non-descending mcap, bad numeraire price)', () => {
    expect(() => wizardConfigToLaunchConfig(wizard({ totalSupply: '0' }), opts())).toThrow(/positive/);
    expect(() => wizardConfigToLaunchConfig(wizard({ mcapStartK: 30, mcapFloorK: 300 }), opts())).toThrow(/descend/);
    expect(() => wizardConfigToLaunchConfig(wizard(), { ...opts(), numerairePriceUsd: 0 })).toThrow(/numeraire price/);
  });

  it('builds a descending market-cap band (start > min) in USD', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts());
    expect(cfg.marketCap).toEqual({ start: 300_000, min: 30_000 });
    expect(cfg.marketCap.start).toBeGreaterThan(cfg.marketCap.min);
  });

  it('computes lockDuration from months at 365/12 days/month (12mo === 365 days)', () => {
    const cfg = wizardConfigToLaunchConfig(wizard({ lpLockMonths: 12 }), opts());
    expect(cfg.lockDurationSeconds).toBe(365 * 86_400); // exactly one year
    // 6 months is below the flagship floor (12), so use a listable tier here.
    const six = wizardConfigToLaunchConfig(wizard({ tier: 'listable', lpLockMonths: 6 }), opts());
    expect(six.lockDurationSeconds).toBe(Math.round(6 * (365 / 12) * 86_400));
  });

  it('enforces the per-tier LP-lock floor (flagship >= 12mo, listable >= 1mo)', () => {
    // Flagship below the 12-month floor throws.
    expect(() => wizardConfigToLaunchConfig(wizard({ tier: 'flagship', lpLockMonths: 0 }), opts())).toThrow(
      /flagship launch requires an LP lock of at least 12 months/,
    );
    expect(() => wizardConfigToLaunchConfig(wizard({ tier: 'flagship', lpLockMonths: 6 }), opts())).toThrow(
      /flagship launch requires an LP lock of at least 12 months/,
    );
    // Listable below the 1-month floor throws.
    expect(() => wizardConfigToLaunchConfig(wizard({ tier: 'listable', lpLockMonths: 0 }), opts())).toThrow(
      /listable launch requires an LP lock of at least 1 month/,
    );
    // A non-finite lock is rejected up front.
    expect(() => wizardConfigToLaunchConfig(wizard({ tier: 'listable', lpLockMonths: Number.NaN }), opts())).toThrow(
      /non-negative finite number/,
    );
    // Valid locks at each tier minimum pass and map through.
    const flag = wizardConfigToLaunchConfig(wizard({ tier: 'flagship', lpLockMonths: 12 }), opts());
    expect(flag.lockDurationSeconds).toBe(365 * 86_400);
    const list = wizardConfigToLaunchConfig(wizard({ tier: 'listable', lpLockMonths: 1 }), opts());
    expect(list.lockDurationSeconds).toBe(Math.round(1 * (365 / 12) * 86_400));
  });

  it('resolves fee-constitution roles to concrete addresses', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: KOL, shareBps: 1000 }] }));
    const byAddress = Object.fromEntries(cfg.feeConstitution.map((l) => [l.address, l]));
    expect(byAddress[USER].role).toBe('creator');
    expect(byAddress[KOL].role).toBe('attention-beneficiary');
    expect(byAddress[LOCKER_CLAIMER_ADDRESS].role).toBe('protocol-stakers');
    expect(byAddress[DOPPLER_MAINNET.airlockOwner].role).toBe('doppler');
  });

  it('fee lines sum to exactly 10000 bps with the Doppler line >= 500', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: KOL, shareBps: 1000 }] }));
    const total = cfg.feeConstitution.reduce((n, l) => n + l.shareBps, 0);
    expect(total).toBe(10_000);
    const doppler = cfg.feeConstitution.filter((l) => l.role === 'doppler').reduce((n, l) => n + l.shareBps, 0);
    expect(doppler).toBeGreaterThanOrEqual(500);
  });

  it('attention splits carve from the creator pool; protocol + doppler are untouched', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: KOL, shareBps: 2000 }] }));
    const byAddress = Object.fromEntries(cfg.feeConstitution.map((l) => [l.address, l.shareBps]));
    // Creator keeps the 8000 pool minus the 2000 carve; KOL gets the 2000.
    expect(byAddress[USER]).toBe(6000);
    expect(byAddress[KOL]).toBe(2000);
    // Fixed lines never move.
    expect(byAddress[LOCKER_CLAIMER_ADDRESS]).toBe(1500);
    expect(byAddress[DOPPLER_MAINNET.airlockOwner]).toBe(500);
    const total = cfg.feeConstitution.reduce((n, l) => n + l.shareBps, 0);
    expect(total).toBe(10_000);
  });

  it('supports multiple KOL splits, each to its own address', () => {
    const KOL2 = '0x3333333333333333333333333333333333333333' as Address;
    const cfg = wizardConfigToLaunchConfig(
      wizard(),
      opts({
        attentionSplits: [
          { address: KOL, shareBps: 1500 },
          { address: KOL2, shareBps: 500 },
        ],
      }),
    );
    const byAddress = Object.fromEntries(cfg.feeConstitution.map((l) => [l.address, l.shareBps]));
    expect(byAddress[USER]).toBe(6000); // 8000 - 1500 - 500
    expect(byAddress[KOL]).toBe(1500);
    expect(byAddress[KOL2]).toBe(500);
    expect(byAddress[LOCKER_CLAIMER_ADDRESS]).toBe(1500);
    expect(byAddress[DOPPLER_MAINNET.airlockOwner]).toBe(500);
    const total = cfg.feeConstitution.reduce((n, l) => n + l.shareBps, 0);
    expect(total).toBe(10_000);
  });

  it('throws a clear error when a creator over-allocates the pool (> 8000 bps)', () => {
    expect(() =>
      wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: KOL, shareBps: 8001 }] })),
    ).toThrow(/over-allocate/);
    // Multiple splits that sum past the pool also throw.
    const KOL2 = '0x3333333333333333333333333333333333333333' as Address;
    expect(() =>
      wizardConfigToLaunchConfig(
        wizard(),
        opts({
          attentionSplits: [
            { address: KOL, shareBps: 5000 },
            { address: KOL2, shareBps: 4000 },
          ],
        }),
      ),
    ).toThrow(/over-allocate/);
  });

  it('coalesces a KOL split pointed at the creator back into the creator line', () => {
    // A "split" to the creator's own address is a no-op: creator keeps the full 8000.
    const cfg = wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: USER, shareBps: 2000 }] }));
    const addrs = cfg.feeConstitution.map((l) => l.address.toLowerCase());
    expect(new Set(addrs).size).toBe(addrs.length); // all unique
    const userLine = cfg.feeConstitution.find((l) => l.address === USER)!;
    expect(userLine.shareBps).toBe(8000); // 6000 remainder + 2000 split merged
    expect(userLine.role).toBe('creator'); // creator line wins the merge
    const total = cfg.feeConstitution.reduce((n, l) => n + l.shareBps, 0);
    expect(total).toBe(10_000);
  });

  it('coalesces creator + attention into one line when there are no splits (unique beneficiaries)', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts()); // no splits -> creator keeps 8000
    const addrs = cfg.feeConstitution.map((l) => l.address.toLowerCase());
    expect(new Set(addrs).size).toBe(addrs.length); // all unique
    const userLine = cfg.feeConstitution.find((l) => l.address === USER)!;
    expect(userLine.shareBps).toBe(8000); // whole creator+attention pool
    // Only three lines: creator, protocol, doppler.
    expect(cfg.feeConstitution).toHaveLength(3);
    const total = cfg.feeConstitution.reduce((n, l) => n + l.shareBps, 0);
    expect(total).toBe(10_000);
  });

  it('produces a constitution the locker accepts (sums to 1e18, doppler floor, sorted)', () => {
    // No splits (3 unique), one KOL (4 unique), two KOLs (5 unique) — all valid.
    const KOL2 = '0x3333333333333333333333333333333333333333' as Address;
    const cases: LaunchMapOptions[] = [
      opts(),
      opts({ attentionSplits: [{ address: KOL, shareBps: 1000 }] }),
      opts({
        attentionSplits: [
          { address: KOL, shareBps: 1500 },
          { address: KOL2, shareBps: 500 },
        ],
      }),
    ];
    for (const o of cases) {
      const cfg = wizardConfigToLaunchConfig(wizard(), o);
      const beneficiaries = feeConstitutionToBeneficiaries(cfg.feeConstitution);
      const sum = beneficiaries.reduce((n, b) => n + b.shares, 0n);
      expect(sum).toBe(10n ** 18n);
      const doppler = cfg.feeConstitution.filter((l) => l.role === 'doppler').reduce((n, l) => n + l.shareBps, 0);
      expect(doppler).toBeGreaterThanOrEqual(500);
    }
  });

  it('pins integrator, fee tier, start-time buffer, and passes the tier through', () => {
    const cfg = wizardConfigToLaunchConfig(wizard({ tier: 'listable' }), opts());
    expect(cfg.integrator).toBe(LAUNCHER_INTEGRATOR_ADDRESS);
    expect(cfg.feeTier).toBe(LAUNCH_FEE_TIER);
    expect(cfg.startTimeOffsetSeconds).toBe(600);
    expect(cfg.tier).toBe('listable');
    expect(cfg.numerairePriceUsd).toBe(1881);
  });

  it('supplies sane default proceeds bounds, overridable via opts', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts());
    expect(cfg.minProceeds).toBe(parseEther('1'));
    expect(cfg.maxProceeds).toBe(parseEther('1000'));
    const custom = wizardConfigToLaunchConfig(wizard(), opts({ minProceeds: parseEther('5'), maxProceeds: parseEther('50') }));
    expect(custom.minProceeds).toBe(parseEther('5'));
    expect(custom.maxProceeds).toBe(parseEther('50'));
  });
});

// Exotic base pair: token/TOWELI instead of token/ETH. The numeraire threads through
// to the config, and the proceeds band re-denominates into the numeraire.
describe('wizardConfigToLaunchConfig — numeraire (ETH default, TOWELI exotic)', () => {
  it('defaults to native ETH', () => {
    expect(wizardConfigToLaunchConfig(wizard(), opts()).numeraire).toBe(ETH_NUMERAIRE);
  });

  it('rejects TOWELI while exotic launches are gated off', () => {
    numeraireGate.exoticOn = false;
    expect(() => wizardConfigToLaunchConfig(wizard(), opts({ numeraire: TOWELI_NUMERAIRE }))).toThrow(/base pair/i);
  });

  it('when exotic is enabled, sets numeraire=TOWELI and a TOWELI-denominated proceeds band', () => {
    numeraireGate.exoticOn = true;
    try {
      const toweliUsd = 0.00003; // numerairePriceUsd is now TOWELI/USD, not ETH/USD
      const cfg = wizardConfigToLaunchConfig(wizard(), opts({ numeraire: TOWELI_NUMERAIRE, numerairePriceUsd: toweliUsd }));
      expect(cfg.numeraire).toBe(TOWELI_NUMERAIRE);
      // Proceeds are in TOWELI base units now — the $1k–$50k exotic band / TOWELI price,
      // orders of magnitude above the 1–1000 ETH default, and derived from the price.
      expect(cfg.minProceeds).toBe(BigInt(Math.floor((1_000 / toweliUsd) * 1e18)));
      expect(cfg.maxProceeds).toBe(BigInt(Math.floor((50_000 / toweliUsd) * 1e18)));
      expect(cfg.minProceeds).toBeGreaterThan(parseEther('1000')); // dwarfs the ETH cap
      expect(cfg.maxProceeds).toBeGreaterThan(cfg.minProceeds);
    } finally {
      numeraireGate.exoticOn = false;
    }
  });

  it('an explicit proceeds override still wins for a TOWELI launch', () => {
    numeraireGate.exoticOn = true;
    try {
      const cfg = wizardConfigToLaunchConfig(
        wizard(),
        opts({ numeraire: TOWELI_NUMERAIRE, numerairePriceUsd: 0.00003, minProceeds: parseEther('123'), maxProceeds: parseEther('456') }),
      );
      expect(cfg.minProceeds).toBe(parseEther('123'));
      expect(cfg.maxProceeds).toBe(parseEther('456'));
    } finally {
      numeraireGate.exoticOn = false;
    }
  });
});

describe('launchToken — gate guard (no chain access)', () => {
  it('refuses to launch when the launcher is gated (isLauncherEnabled() false)', async () => {
    // isLauncherEnabled is mocked false above -> throws before ever touching the clients,
    // regardless of the production LAUNCHER_ENABLED value (now true post go-live).
    const cfg = wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: KOL, shareBps: 1000 }] }));
    // Dummy clients: they must never be used because the guard fires first.
    const dummy = {} as never;
    await expect(launchToken(dummy, dummy, cfg)).rejects.toBeInstanceOf(LaunchError);
    await expect(launchToken(dummy, dummy, cfg)).rejects.toMatchObject({ code: 'launcher-disabled' });
  });
});
