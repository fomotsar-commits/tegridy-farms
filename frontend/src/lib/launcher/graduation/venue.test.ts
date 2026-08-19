// The graduation plan carries one claim that can cost a creator money if it is wrong:
// which venue their liquidity lands in and on what terms. These pin that the plan tracks
// the SAME gate the launch builder branches on, and that while the venue migrator is
// unset every surface is handed a disclosure that says graduation is external.

import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import {
  resolveEvmGraduationVenue,
  resolveSolanaGraduationVenue,
  plannedVenueMigrator,
  verifyMigratorModule,
  feePercent,
} from './venue';
import { TEGRIDY_V4_MIGRATOR_ADDRESS } from '../constants';
import { DOPPLER_MAINNET } from '../doppler.constants';
import { MIGRATION_POOL, NATIVE_ETH } from '../airlock';
import { migrationPoolId } from '../lockerStream';
import { isDeployed } from '../../constants';
import { DEFAULT_FEE_CONSTITUTION } from '../config';

const TOKEN = '0x00000000000000000000000000000000000000Aa' as Address;

describe('the resolved migrator is the one that will actually run', () => {
  it('branches on exactly the gate airlock.ts branches on', () => {
    // INVARIANT, flag-agnostic: whatever TEGRIDY_V4_MIGRATOR_ADDRESS is set to, the plan's
    // migrator must equal what `buildTegridyLaunchParams` would pass. If this ever
    // disagrees, a creator is shown one venue and gets another.
    const plan = resolveEvmGraduationVenue();
    if (isDeployed(TEGRIDY_V4_MIGRATOR_ADDRESS)) {
      expect(plan.migrator.address).toBe(TEGRIDY_V4_MIGRATOR_ADDRESS);
      expect(plan.migrator.ownership).toBe('venue-owned');
    } else {
      expect(plan.migrator.address).toBe(DOPPLER_MAINNET.modules.uniswapV4Migrator.address);
      expect(plan.migrator.ownership).toBe('external');
    }
  });

  it('TRIPWIRE: the venue migrator is still unset, so graduation is external today', () => {
    // Pins CURRENT source state. When the operator deploys + whitelists the migrator and
    // sets the constant, this test is the one that must be deliberately updated — which is
    // the point: the flip cannot happen quietly.
    expect(plannedVenueMigrator().configured).toBe(false);
    expect(resolveEvmGraduationVenue().migrator.ownership).toBe('external');
  });
});

describe('honesty guard — the surface must disclose its own limits', () => {
  it('the disclosure names the external migrator and denies that venue graduation is live', () => {
    const plan = resolveEvmGraduationVenue();
    if (plan.migrator.ownership === 'venue-owned') return; // nothing to deny once it IS live
    expect(plan.disclosure).toMatch(/currently graduate/i);
    expect(plan.disclosure).toMatch(/external/i);
    expect(plan.disclosure).toMatch(/NOT live/i);
    expect(plan.disclosure).toContain(DOPPLER_MAINNET.modules.uniswapV4Migrator.address);
  });

  it('never describes the escrowed LP as burned or irreversible while the external path runs', () => {
    const plan = resolveEvmGraduationVenue({ lockDurationSeconds: 365 * 24 * 3600 });
    expect(plan.lpLock.disposition).toBe('time-locked-escrow');
    expect(plan.lpLock.irreversible).toBe(false);
    // The venue-owned design burns LP to 0xdead. Asserting it now would describe a
    // contract that does not exist about liquidity that is merely escrowed — so the note
    // must carry the DENIAL and must not carry the claim.
    expect(plan.lpLock.note).toMatch(/not burned/i);
    expect(plan.lpLock.note).not.toMatch(/\bLP (is |are )?burned\b/i);
    expect(plan.lpLock.note).toMatch(/can withdraw/i);
    expect(plan.lpLock.custodian?.toLowerCase()).toBe(
      DOPPLER_MAINNET.support.streamableFeesLocker.toLowerCase(),
    );
  });

  it('reports an unknown pool id as undetermined WITH a reason, never as a computed value', () => {
    const plan = resolveEvmGraduationVenue();
    expect(plan.pool.poolId).toBeNull();
    expect(plan.pool.poolKey).toBeNull();
    expect(plan.pool.undeterminedReason).toBeTruthy();
  });

  it('never invents a lock duration the caller did not supply', () => {
    expect(resolveEvmGraduationVenue().lpLock.durationSeconds).toBeNull();
    expect(resolveEvmGraduationVenue({ lockDurationSeconds: 0 }).lpLock.durationSeconds).toBe(0);
    expect(resolveEvmGraduationVenue({ lockDurationSeconds: NaN }).lpLock.durationSeconds).toBeNull();
  });

  it('lists the operator preconditions while unconfigured, and none once configured', () => {
    const plan = resolveEvmGraduationVenue();
    if (plan.migrator.ownership === 'venue-owned') {
      expect(plan.preconditions).toEqual([]);
    } else {
      expect(plan.preconditions.length).toBeGreaterThan(0);
      expect(plan.preconditions.join(' ')).toMatch(/setModuleState/);
    }
  });
});

describe('pool + fee facts are derived, not restated', () => {
  it('uses the same migration pool params the launch builder commits', () => {
    const plan = resolveEvmGraduationVenue({ token: TOKEN });
    expect(plan.pool.feeHundredthsBips).toBe(MIGRATION_POOL.fee);
    expect(plan.pool.tickSpacing).toBe(MIGRATION_POOL.tickSpacing);
    expect(plan.pool.poolId).toBe(migrationPoolId(TOKEN, NATIVE_ETH));
  });

  it('feePercent renders the graduated fee as a rate, not as its raw units', () => {
    expect(feePercent(MIGRATION_POOL.fee)).toBe('0.3');
    expect(feePercent(10_000)).toBe('1');
  });

  it('protocolShareBps sums only the protocol lines of the published constitution', () => {
    const plan = resolveEvmGraduationVenue();
    const expected = DEFAULT_FEE_CONSTITUTION.filter(
      (l) => l.role === 'protocol-stakers' || l.role === 'protocol-pol',
    ).reduce((n, l) => n + l.shareBps, 0);
    expect(plan.protocolShareBps).toBe(expected);
    // Creator and Doppler are somebody else's money; folding them in would overstate
    // venue revenue by more than 5x.
    expect(plan.feeSplit.find((l) => l.role === 'creator')?.protocol).toBe(false);
    expect(plan.feeSplit.find((l) => l.role === 'doppler')?.protocol).toBe(false);
  });

  it('honours a caller-supplied constitution over the template', () => {
    const plan = resolveEvmGraduationVenue({
      feeConstitution: [
        { recipient: 'Creator', shareBps: 9000, role: 'creator' },
        { recipient: 'Tegridy', shareBps: 1000, role: 'protocol-stakers' },
      ],
    });
    expect(plan.protocolShareBps).toBe(1000);
    expect(plan.feeSplit).toHaveLength(2);
  });
});

describe('the Solana rail is reported as its own venue, never mirrored from EVM', () => {
  const solana = resolveSolanaGraduationVenue();

  it('is external and says venue graduation is not live there either', () => {
    expect(solana.rail).toBe('solana');
    expect(solana.migrator.ownership).toBe('external');
    expect(solana.disclosure).toMatch(/external/i);
    expect(solana.disclosure).toMatch(/not live/i);
  });

  it('publishes no EVM fee split for a rail whose split is computed per config', () => {
    expect(solana.feeSplit).toEqual([]);
    expect(solana.protocolShareBps).toBe(0);
  });

  it('states the permanent lock as permanent and gives no EVM pool id', () => {
    expect(solana.lpLock.disposition).toBe('permanently-locked');
    expect(solana.lpLock.irreversible).toBe(true);
    expect(solana.pool.poolId).toBeNull();
    expect(solana.pool.undeterminedReason).toBeTruthy();
  });
});

describe('verifyMigratorModule — a green indicator must be earned by a real read', () => {
  const migrator = DOPPLER_MAINNET.modules.uniswapV4Migrator.address;

  it('reports whitelisted only for the LiquidityMigrator role', async () => {
    const client = { readContract: async () => 4 };
    await expect(verifyMigratorModule(client, migrator)).resolves.toMatchObject({
      state: 4,
      whitelisted: true,
      unreadable: false,
    });
  });

  it('a module in a DIFFERENT role is not whitelisted for migration', async () => {
    const client = { readContract: async () => 3 }; // PoolInitializer
    const r = await verifyMigratorModule(client, migrator);
    expect(r.whitelisted).toBe(false);
    expect(r.unreadable).toBe(false);
    expect(r.state).toBe(3);
  });

  it('a FAILED read is unreadable, not "not whitelisted"', async () => {
    const client = {
      readContract: async () => {
        throw new Error('rpc down');
      },
    };
    const r = await verifyMigratorModule(client, migrator);
    expect(r.unreadable).toBe(true);
    expect(r.whitelisted).toBe(false);
    expect(r.state).toBeNull();
  });

  it('a garbage response is unreadable rather than coerced to a state', async () => {
    const client = { readContract: async () => 'not-a-number' };
    const r = await verifyMigratorModule(client, migrator);
    expect(r.unreadable).toBe(true);
    expect(r.state).toBeNull();
  });

  it('accepts a bigint state, as a real client returns for a uint8', async () => {
    const client = { readContract: async () => 4n };
    await expect(verifyMigratorModule(client, migrator)).resolves.toMatchObject({ whitelisted: true });
  });
});
