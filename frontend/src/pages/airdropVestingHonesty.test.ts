// HONESTY GUARD — the airdrop / vesting / lock surfaces disclose their own limits.
//
// Every rail behind these two pages is UNDEPLOYED, and every number they will one day
// render comes from a contract call that can fail. That combination is exactly where a
// zero gets written where an unknown belongs:
//
//   `campaignInfo()` reverts   → "0 remaining", a campaign that looks drained
//   `isClaimed()` doesn't land → "not claimed", a claim button that can only revert
//   the lock rail is unset     → "0 locked", a token handed a clean bill it never earned
//
// `LaunchLockView` goes to real trouble to prevent the third one: it returns explicit
// `vestingSourceAvailable` / `lockSourceAvailable` booleans so an unreachable rail can
// be told apart from a rail that answered zero. That care is only worth something if
// the render layer keeps the distinction, so this file pins it in three ways:
//
//   1. no read result on these surfaces is coerced to a number with `?? 0` / `|| 0`;
//   2. every figure the lock viewer prints sits inside an availability branch;
//   3. the pages gate on their own contract address, and say so in copy.
//
// Prose may be rewritten freely. Reintroduce a numeric fallback for a failed read, or
// drop an availability branch, and this goes red.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AIRDROP_FACTORY_ADDRESS,
  LAUNCH_LOCK_VIEW_ADDRESS,
  VESTING_FACTORY_ADDRESS,
  isDeployed,
} from '../lib/constants';

const SRC = join(process.cwd(), 'src');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

/** The files that turn a contract read into something a user sees. */
const SURFACES: Record<string, string> = {
  'hooks/useAirdropFactory.ts': read('hooks', 'useAirdropFactory.ts'),
  'hooks/useAirdropCampaign.ts': read('hooks', 'useAirdropCampaign.ts'),
  'hooks/useVestingFactory.ts': read('hooks', 'useVestingFactory.ts'),
  'hooks/useVestingStreams.ts': read('hooks', 'useVestingStreams.ts'),
  'hooks/useVestingLockView.ts': read('hooks', 'useVestingLockView.ts'),
  'components/airdrop/ClaimPanel.tsx': read('components', 'airdrop', 'ClaimPanel.tsx'),
  'components/airdrop/CampaignBuilder.tsx': read('components', 'airdrop', 'CampaignBuilder.tsx'),
  'components/vesting/VestingDashboard.tsx': read('components', 'vesting', 'VestingDashboard.tsx'),
  'components/vesting/LockViewer.tsx': read('components', 'vesting', 'LockViewer.tsx'),
};

/** Strip `//` lines and block comments — the notes discuss `?? 0` on purpose. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('a failed read never becomes a number', () => {
  // `?? 0`, `|| 0`, `?? 0n`, `|| 0n` — the four spellings of "pretend the chain said
  // zero". Nullish-coalescing to a non-numeric default (an empty array, a null) is
  // fine and is not matched.
  const NUMERIC_FALLBACK = /(\?\?|\|\|)\s*0n?\b/;

  it.each(Object.keys(SURFACES))('%s has no numeric fallback for a read', (name) => {
    const offenders = code(SURFACES[name]!)
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((l) => NUMERIC_FALLBACK.test(l.line));
    expect(
      offenders,
      `${name} coerces something to zero:\n${offenders.map((o) => `  line ${o.n}: ${o.line}`).join('\n')}`,
    ).toEqual([]);
  });

  it('the hooks type their unread values as null rather than defaulting them', () => {
    // Spot-check the three figures whose zero is meaningful, so a null default is the
    // only way to keep "disarmed fee" apart from "fee unknown".
    expect(SURFACES['hooks/useAirdropFactory.ts']).toMatch(/claimFeeWei: bigint \| null/);
    expect(SURFACES['hooks/useAirdropCampaign.ts']).toMatch(/claimed: boolean \| null/);
    expect(SURFACES['hooks/useVestingLockView.ts']).toMatch(/snapshot: LockSnapshot \| null/);
  });
});

describe('the lock viewer keeps the availability flags the contract gave it', () => {
  const viewer = SURFACES['components/vesting/LockViewer.tsx']!;

  it('branches on both rails separately', () => {
    // Two rails, two branches. One combined check would let a live vesting rail be
    // hidden by a dark lock rail, or worse, the reverse.
    expect(viewer).toMatch(/!snap\.vestingSourceAvailable/);
    expect(viewer).toMatch(/!snap\.lockSourceAvailable/);
  });

  it('prints no lock or vesting figure outside an availability branch', () => {
    // Every numeric field of the snapshot must appear only after its flag was checked.
    // Crude but load-bearing: the flag check has to come first in file order.
    const vestingFlagAt = viewer.indexOf('!snap.vestingSourceAvailable');
    const lockFlagAt = viewer.indexOf('!snap.lockSourceAvailable');
    for (const field of ['snap.vestedInflow', 'snap.vestingWalletCount']) {
      expect(viewer.indexOf(field), `${field} is rendered before the vesting flag is checked`).toBeGreaterThan(
        vestingFlagAt,
      );
    }
    for (const field of ['snap.lockedTotal', 'snap.activeLockCount', 'snap.earliestUnlockAt']) {
      expect(viewer.indexOf(field), `${field} is rendered before the lock flag is checked`).toBeGreaterThan(
        lockFlagAt,
      );
    }
  });

  it('treats a zero unlock timestamp as a missing date, not as 1970', () => {
    expect(viewer).toMatch(/snap\.earliestUnlockAt === 0 \? <NoData \/>/);
    expect(viewer).toMatch(/snap\.latestUnlockAt === 0 \? <NoData \/>/);
  });

  it('discloses a truncated scan instead of publishing a partial expiry as the expiry', () => {
    expect(viewer).toMatch(/nextLockOffset !== 0/);
    expect(viewer).toMatch(/partial|Partial/);
  });

  it('says the figure covers our vault only', () => {
    expect(viewer).toMatch(/vault only/i);
  });
});

describe('the claim surface reports why, and never guesses', () => {
  const panel = SURFACES['components/airdrop/ClaimPanel.tsx']!;

  it('delegates the verdict rather than deciding eligibility inline', () => {
    // The component renders `evaluateEligibility`; it must not grow its own
    // ineligibility logic, because that is where the "not eligible" default creeps in.
    // Compared on code, not on the header note, which quotes the phrase on purpose.
    expect(panel).toMatch(/evaluateEligibility\(/);
    expect(code(panel)).not.toMatch(/not eligible/i);
  });

  it('only offers the button on canClaim', () => {
    expect(panel).toMatch(/verdict\.canClaim &&/);
  });

  it('reports an unreadable distributor as no data, not as an empty campaign', () => {
    expect(panel).toMatch(/!campaign\.campaign \?/);
    expect(panel).toMatch(/No data\./);
  });

  it('says provenance is unchecked when the factory has no address to check against', () => {
    expect(panel).toMatch(/unchecked/);
  });
});

describe('each surface gates on its own address', () => {
  const airdropPage = read('pages', 'AirdropPage.tsx');
  const vestingPage = read('pages', 'VestingPage.tsx');

  it('the airdrop page gates the transactions on the factory address', () => {
    expect(airdropPage).toMatch(/isDeployed\(AIRDROP_FACTORY_ADDRESS\)/);
    expect(SURFACES['components/airdrop/CampaignBuilder.tsx']).toMatch(/!factory\.deployed/);
  });

  it('the vesting page gates each tab on its own rail, not on one page-wide flag', () => {
    expect(vestingPage).toMatch(/isDeployed\(VESTING_FACTORY_ADDRESS\)/);
    expect(vestingPage).toMatch(/isDeployed\(LAUNCH_LOCK_VIEW_ADDRESS\)/);
  });

  it('the builder still works with no chain, and says which half does not', () => {
    // The tree is a fact about the CSV. Gating it on a deploy would remove a genuinely
    // usable tool for no honesty gain — but the funding step must say it is unavailable.
    const builder = SURFACES['components/airdrop/CampaignBuilder.tsx']!;
    expect(builder).toMatch(/isn't deployed yet/);
    expect(builder).toMatch(/root above is real/);
  });
});

describe('the three rails are undeployed, so their walls stay reachable', () => {
  // The counterweight to everything above. If one of these gains an address, the
  // "not deployed" copy becomes unreachable and this test is the thing that says so —
  // deliberately, rather than leaving a stale wall nobody notices.
  it.each([
    ['AirdropFactory', AIRDROP_FACTORY_ADDRESS],
    ['VestingFactory', VESTING_FACTORY_ADDRESS],
    ['LaunchLockView', LAUNCH_LOCK_VIEW_ADDRESS],
  ])('%s has no address on this deployment', (_label, addr) => {
    expect(isDeployed(addr)).toBe(false);
  });
});
