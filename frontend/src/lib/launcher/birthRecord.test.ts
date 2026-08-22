// The birth certificate's done-means, from the directive §4:
//
//   "A test create shows locks + plates + fee instruction + decimals on its JSON record
//    at a stable route · gate_decision_id links every birth to its gate audit row"
//
// Plus the hard law about precision: "wrong precision voids comparability across every
// record, chart, and plate the venue serves."

import { describe, it, expect } from 'vitest';
import { parseEther, type Address } from 'viem';
import {
  buildBirthRecord,
  birthRecordUrl,
  birthRecordFailure,
  railDecimals,
  recordUnreadFrom,
  normaliseCa,
  BIRTH_RECORD_STAMP,
  BIRTH_RECORD_SCHEMA_VERSION,
} from './birthRecord';
import type { LaunchFactSheet } from './factSheet';

const TOKEN = '0x279E7cff2DBC93ff1F5cAE6cbD072F98d75987CA' as Address;
const CREATOR = '0xD71caF9fdBbd3dd7f974431EdF7f9F2c7bA8f93A' as Address;
const LOCKER = '0x1111111111111111111111111111111111111111' as Address;

function sheet(over: Partial<LaunchFactSheet> = {}): LaunchFactSheet {
  return {
    schemaVersion: 1,
    token: TOKEN,
    chainId: 1,
    name: 'Test Coin',
    symbol: 'TEST',
    totalSupply: parseEther('1000000'),
    tokenFactory: null,
    templateCodehash: null,
    knownSafeTemplate: true,
    residualPowers: [],
    liquidity: { locked: true, locker: LOCKER, unlockAt: 1800000000, note: 'LP locked in the migration locker.' },
    feeConstitution: [
      { recipient: 'Creator', shareBps: 7000, role: 'creator' },
      { recipient: 'Tegridy stakers', shareBps: 1500, role: 'protocol-stakers' },
      { recipient: 'Doppler', shareBps: 500, role: 'doppler' },
    ],
    vesting: [],
    teamAllocationBps: 0,
    teamAllocationVestedBps: 0,
    tier: 'listable',
    gateChecks: [],
    observedAt: 1786104024,
    ...over,
  };
}

const base = {
  chain: 'ethereum' as const,
  creator: CREATOR,
  birthBlock: 21_500_000,
  birthTx: '0xabc',
  gateDecisionId: 'gd_row_1',
  decimals: 18,
};

describe('the record carries what the directive names', () => {
  it('locks + plates + fee instruction + decimals, all on one record', () => {
    const r = buildBirthRecord({ sheet: sheet(), ...base });
    expect(r.locks.length).toBeGreaterThan(0);
    expect(r.plates.length).toBeGreaterThan(0);
    expect(r.fee_instruction).toHaveLength(3);
    expect(r.decimals).toBe(18);
  });

  it('gate_decision_id links the birth to its gate audit row', () => {
    expect(buildBirthRecord({ sheet: sheet(), ...base }).gate_decision_id).toBe('gd_row_1');
  });

  it('prints the stamp verbatim', () => {
    expect(buildBirthRecord({ sheet: sheet(), ...base }).stamp).toBe('Every lock verifiable onchain.');
    expect(BIRTH_RECORD_STAMP).toBe('Every lock verifiable onchain.');
  });

  it('the fee instruction names every recipient and its share', () => {
    const r = buildBirthRecord({ sheet: sheet(), ...base });
    expect(r.fee_instruction).toEqual([
      { recipient: 'Creator', share_bps: 7000, role: 'creator' },
      { recipient: 'Tegridy stakers', share_bps: 1500, role: 'protocol-stakers' },
      { recipient: 'Doppler', share_bps: 500, role: 'doppler' },
    ]);
  });
});

describe('plates — EVERY allocation named', () => {
  it('a fair launch names the sale as the whole supply', () => {
    const r = buildBirthRecord({ sheet: sheet(), ...base });
    expect(r.plates).toHaveLength(1);
    expect(r.plates[0]).toMatchObject({ name: 'Public sale', share_bps: 10_000 });
    expect(r.plates[0].amount).toBe(parseEther('1000000').toString());
  });

  it('a premine is named alongside the sale, and the shares sum to the supply', () => {
    const r = buildBirthRecord({
      sheet: sheet({
        teamAllocationBps: 1000,
        teamAllocationVestedBps: 1000,
        vesting: [{ beneficiary: CREATOR, amount: parseEther('100000'), cliffSeconds: 0, durationSeconds: 31_536_000 }],
      }),
      ...base,
    });
    expect(r.plates.map((p) => p.share_bps).reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(r.plates.find((p) => p.locked)).toMatchObject({ beneficiary: CREATOR });
  });

  it('a GENUINELY unvested insider slice is named as unlocked, not omitted', () => {
    // teamAllocationBps 2000 with teamAllocationVestedBps 0 = a real unvested slice.
    // Silence would read as "there is no insider allocation".
    const r = buildBirthRecord({
      sheet: sheet({ teamAllocationBps: 2000, teamAllocationVestedBps: 0, vesting: [] }),
      ...base,
    });
    const insider = r.plates.find((p) => p.name.includes('not under an on-chain vesting schedule'));
    expect(insider).toBeTruthy();
    expect(insider!.locked).toBe(false);
    expect(insider!.share_bps).toBe(2000);
    expect(r.plates.map((p) => p.share_bps).reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('a VESTED premine with no schedule array is LOCKED — not labelled unvested', () => {
    // THE INVERSION THIS GUARDS. `collectTokenFacts` declares `vesting[]` and never
    // pushes to it on the EVM rail, so a provably-vested premine arrives with an empty
    // array and a non-zero teamAllocationVestedBps. Reading only the array would publish
    // an UNLOCKED insider slice for a token whose insider slice is locked.
    const r = buildBirthRecord({
      sheet: sheet({ teamAllocationBps: 2000, teamAllocationVestedBps: 2000, vesting: [] }),
      ...base,
    });
    const insider = r.plates.find((p) => p.name.includes('Team allocation'));
    expect(insider).toBeTruthy();
    expect(insider!.locked).toBe(true);
    expect(insider!.name).toContain('on-chain vested');
    expect(r.plates.some((p) => p.name.includes('not under an on-chain'))).toBe(false);
    // Locked, but the cliff/duration were never read — so say that rather than invent one.
    expect(r.unread).toContain('locks.vesting');
    expect(r.locks.find((l) => l.kind === 'vesting')?.unlock_at).toBeNull();
  });

  it('a PARTIALLY vested premine names both halves', () => {
    const r = buildBirthRecord({
      sheet: sheet({ teamAllocationBps: 2000, teamAllocationVestedBps: 1500, vesting: [] }),
      ...base,
    });
    expect(r.plates.find((p) => p.locked)?.share_bps).toBe(1500);
    expect(r.plates.find((p) => p.name.includes('not under an on-chain'))?.share_bps).toBe(500);
    expect(r.plates.map((p) => p.share_bps).reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('amounts are decimal STRINGS — a JS number would silently round above 2^53', () => {
    const r = buildBirthRecord({ sheet: sheet(), ...base });
    expect(typeof r.plates[0].amount).toBe('string');
    // 1e24 base units. Round-tripping through Number would lose the low digits.
    expect(BigInt(r.plates[0].amount)).toBe(parseEther('1000000'));
    expect(r.total_supply).toBe('1000000000000000000000000');
  });
});

describe('decimals, pinned per rail — the hard law', () => {
  it('the ETH rail is fixed at 18 and needs no snapshot', () => {
    expect(railDecimals('ethereum')).toBe(18);
    expect(railDecimals('base')).toBe(18);
  });

  it('the curve rail SNAPSHOTS the mint, and 6 is not 18', () => {
    expect(railDecimals('solana', 6)).toBe(6);
    expect(railDecimals('solana', 9)).toBe(9);
  });

  it('REFUSES to invent a Solana precision when none was read', () => {
    // The whole point: an unread precision is null, never a default. A record that
    // guessed 18 for a 6-decimal mint would misprice every plate on it by 10^12.
    expect(railDecimals('solana', null)).toBeNull();
    expect(railDecimals('solana', undefined)).toBeNull();
    expect(railDecimals('solana', 1.5)).toBeNull();
    expect(railDecimals('solana', -1)).toBeNull();
  });

  it('an unread precision is named in `unread`, so a consumer cannot miss it', () => {
    const r = buildBirthRecord({ sheet: sheet(), ...base, chain: 'solana', decimals: null });
    expect(r.decimals).toBeNull();
    expect(r.unread).toContain('decimals');
  });
});

describe('plates we could not enumerate are NO plates', () => {
  it('emits nothing rather than a fabricated 100%-float plate', () => {
    // Caught on a live mainnet read: USDC came back with `plates: [Public sale = 10000
    // bps]` AND `unread: ["plates"]`. The plate is an assertion that the token has no
    // insider allocation — published for a token we had just said we could not read.
    const r = buildBirthRecord({ sheet: sheet({ teamAllocationBps: 0 }), ...base, unread: ['plates'] });
    expect(r.plates).toEqual([]);
    expect(r.unread).toContain('plates');
  });

  it('still emits plates when they WERE enumerated', () => {
    const r = buildBirthRecord({ sheet: sheet({ teamAllocationBps: 0 }), ...base });
    expect(r.plates).toHaveLength(1);
    expect(r.plates[0].share_bps).toBe(10_000);
    expect(r.unread).not.toContain('plates');
  });
});

describe('the liquidity lock is never ASSERTED on a rail that cannot read it', () => {
  it('makes NO claim when the locker was never queried', () => {
    // The live EVM state: `readMigrationStream` is inert against the V1 locker and
    // returns a hardcoded locked:false, which gate.ts renders as "Liquidity is not
    // locked; it may be withdrawable by the liquidity owner." Copying that sentence into
    // a machine-readable record publishes an assertion about a locker nobody asked.
    const r = buildBirthRecord({ sheet: sheet(), ...base, liquidityReadable: false });
    const lock = r.locks.find((l) => l.kind === 'liquidity')!;
    expect(lock.note).not.toMatch(/not locked/i);
    expect(lock.note).not.toMatch(/withdrawable/i);
    expect(lock.locker).toBeNull();
    expect(lock.unlock_at).toBeNull();
    expect(r.unread).toContain('locks.liquidity');
  });

  it('still reports a REAL lock when the locker was queried', () => {
    const r = buildBirthRecord({ sheet: sheet(), ...base, liquidityReadable: true });
    const lock = r.locks.find((l) => l.kind === 'liquidity')!;
    expect(lock.locker).toBe(LOCKER);
    expect(lock.unlock_at).toBe(1800000000);
    expect(r.unread).not.toContain('locks.liquidity');
  });

  it('defaults to readable, so every existing producer is unaffected', () => {
    const r = buildBirthRecord({ sheet: sheet(), ...base });
    expect(r.unread).not.toContain('locks.liquidity');
  });
});

describe('unread carries RECORD field names, not Solidity method names', () => {
  it('translates the collector’s method names', () => {
    expect(recordUnreadFrom(['totalSupply', 'name', 'owner'])).toEqual([
      'total_supply',
      'name',
      'residual_powers',
    ]);
  });

  it('drops method names it has no record field for, rather than leaking them', () => {
    expect(recordUnreadFrom(['isBalanceLimitActive', 'somethingElse'])).toEqual([]);
  });

  it('dedupes', () => {
    expect(recordUnreadFrom(['name', 'name'])).toEqual(['name']);
  });

  it('never publishes a raw Solidity name into the record', () => {
    const r = buildBirthRecord({ sheet: sheet(), ...base, unread: recordUnreadFrom(['totalSupply']) });
    expect(r.unread).toContain('total_supply');
    expect(r.unread).not.toContain('totalSupply');
  });
});

describe('honesty — unknown is never zero', () => {
  it('an empty fee instruction is declared unread, not published as "no fees"', () => {
    const r = buildBirthRecord({ sheet: sheet({ feeConstitution: [] }), ...base });
    expect(r.fee_instruction).toEqual([]);
    expect(r.unread).toContain('fee_instruction');
  });

  it('an unknown birth block is null AND named', () => {
    const r = buildBirthRecord({ sheet: sheet(), ...base, birthBlock: null });
    expect(r.birth_block).toBeNull();
    expect(r.unread).toContain('birth_block');
  });

  it('caller-supplied unread fields survive into the record', () => {
    const r = buildBirthRecord({ sheet: sheet(), ...base, unread: ['residual_powers'] });
    expect(r.unread).toContain('residual_powers');
  });

  it('unread is sorted and deduplicated, so two records of one token compare equal', () => {
    const r = buildBirthRecord({ sheet: sheet({ feeConstitution: [] }), ...base, unread: ['fee_instruction', 'a'] });
    expect(r.unread).toEqual([...new Set(r.unread)].sort());
  });
});

describe('addresses — folding one rail and not the other', () => {
  it('EVM addresses are lower-cased (case-insensitive on chain)', () => {
    const r = buildBirthRecord({ sheet: sheet(), ...base });
    expect(r.ca).toBe(TOKEN.toLowerCase());
    expect(r.creator).toBe(CREATOR.toLowerCase());
  });

  it('Solana base58 is NOT folded — lower-casing it names a different account', () => {
    const mint = 'So11111111111111111111111111111111111111112';
    expect(normaliseCa(mint, 'solana')).toBe(mint);
    expect(normaliseCa(mint, 'ethereum')).toBe(mint.toLowerCase());
  });
});

describe('the stable route', () => {
  it('is absolute — the consumer is a server on somebody else’s machine', () => {
    expect(birthRecordUrl('base', TOKEN, 'https://memetic.fun')).toBe(
      `https://memetic.fun/record/base/${TOKEN.toLowerCase()}.json`,
    );
  });

  it('tolerates a trailing slash on the origin rather than emitting a double slash', () => {
    expect(birthRecordUrl('base', TOKEN, 'https://memetic.fun/')).toBe(
      `https://memetic.fun/record/base/${TOKEN.toLowerCase()}.json`,
    );
  });
});

describe('birthRecordFailure — refuse to render a malformed twin', () => {
  const good = () => buildBirthRecord({ sheet: sheet(), ...base });

  it('accepts a record we just built', () => {
    expect(birthRecordFailure(good())).toBeNull();
  });

  it('rejects a future schema version rather than misreading it', () => {
    expect(birthRecordFailure({ ...good(), schema_version: BIRTH_RECORD_SCHEMA_VERSION + 1 })).toMatch(/schema version/);
  });

  it('rejects a record with no stamp', () => {
    expect(birthRecordFailure({ ...good(), stamp: '' })).toMatch(/stamp/);
  });

  it('rejects a record that does not say what it could not read', () => {
    // Omitted by destructuring rather than `delete`-d off a `Record` cast:
    // `BirthRecord` has no index signature, so the cast was never sound, and the
    // rest object is exactly the same value — a record with no `unread` key.
    const { unread: _unread, ...withoutUnread } = good();
    expect(birthRecordFailure(withoutUnread)).toMatch(/could not read/);
  });

  it('rejects non-objects and nulls', () => {
    expect(birthRecordFailure(null)).toBeTruthy();
    expect(birthRecordFailure('{}')).toBeTruthy();
  });
});

describe('the record inherits the sheet’s own lock-readability', () => {
  it('a sheet that says "not read" makes the record say so, with no caller flag', () => {
    // One source of truth. Without this, a record built from an honest sheet could still
    // publish the sheet's suppressed claim just because the caller forgot a flag.
    const r = buildBirthRecord({
      sheet: sheet({ liquidity: { locked: false, locker: null, unlockAt: null, note: '', readable: false } }),
      ...base,
    });
    expect(r.unread).toContain('locks.liquidity');
    expect(r.locks.find((l) => l.kind === 'liquidity')!.note).not.toMatch(/not locked/i);
  });

  it('an explicit caller flag still wins over the sheet', () => {
    const r = buildBirthRecord({
      sheet: sheet({ liquidity: { locked: true, locker: LOCKER, unlockAt: 1800000000, note: 'Liquidity is locked.', readable: true } }),
      ...base,
      liquidityReadable: false,
    });
    expect(r.unread).toContain('locks.liquidity');
  });
});
