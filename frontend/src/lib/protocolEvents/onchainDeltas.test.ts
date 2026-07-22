import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import {
  diffCounters,
  DEFAULT_DELTA_THRESHOLDS,
  type CounterSnapshot,
} from './onchainDeltas';

const AT = 1_800_000_000; // fixed observation time

function snap(over: Partial<{
  distWei: bigint;
  epoch: number;
  lpWei: bigint;
  accs: number;
  ethUsedWei: bigint;
  revNull: boolean;
  polNull: boolean;
}> = {}): CounterSnapshot {
  const {
    distWei = 0n,
    epoch = 0,
    lpWei = 0n,
    accs = 0,
    ethUsedWei = 0n,
    revNull = false,
    polNull = false,
  } = over;
  return {
    revenue: revNull ? null : { totalDistributedWei: distWei, epochCount: epoch },
    pol: polNull ? null : { totalLPCreatedWei: lpWei, totalAccumulations: accs, totalETHUsedWei: ethUsedWei },
  };
}

describe('diffCounters', () => {
  it('emits nothing on the first observation (baseline, prev=null)', () => {
    expect(diffCounters(null, snap({ epoch: 5, accs: 3 }), AT)).toEqual([]);
  });

  it('emits nothing when no counter moved', () => {
    const s = snap({ distWei: parseEther('1'), epoch: 5, lpWei: 10n, accs: 3, ethUsedWei: parseEther('2') });
    expect(diffCounters(s, s, AT)).toEqual([]);
  });

  it('emits a fee event only when epochCount strictly increases', () => {
    const prev = snap({ distWei: parseEther('1'), epoch: 5 });
    const cur = snap({ distWei: parseEther('1.02'), epoch: 6 });
    const out = diffCounters(prev, cur, AT);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('fee');
    expect(out[0].id).toBe('fee:6'); // keyed to the NEW epoch → no double-emit
    expect(out[0].ts).toBe(AT);
    expect(out[0].detail).toContain('ETH');
    expect(out[0].detail).toContain('stakers');
    expect(out[0].txHash).toBe('');
    expect(out[0].actor).toBe('');
  });

  it('does NOT emit a fee event when ETH grew but epochCount did not (noise guard)', () => {
    const prev = snap({ distWei: parseEther('1'), epoch: 6 });
    const cur = snap({ distWei: parseEther('1.5'), epoch: 6 });
    expect(diffCounters(prev, cur, AT)).toEqual([]);
  });

  it('flags a whale fee when the ETH delta meets the threshold', () => {
    const prev = snap({ distWei: parseEther('0'), epoch: 6 });
    const cur = snap({ distWei: parseEther('0.5'), epoch: 7 });
    const out = diffCounters(prev, cur, AT);
    expect(out[0].whale).toBe(true);
  });

  it('does not flag a whale for a sub-threshold fee', () => {
    const prev = snap({ distWei: parseEther('0'), epoch: 6 });
    const cur = snap({ distWei: parseEther('0.001'), epoch: 7 });
    const out = diffCounters(prev, cur, AT);
    expect(out[0].whale).toBe(false);
    expect(out[0].whale).toBe(0.001 >= DEFAULT_DELTA_THRESHOLDS.feeWhaleEth);
  });

  it('emits a pol event when totalAccumulations increases, detailing ETH deployed', () => {
    const prev = snap({ accs: 2, ethUsedWei: parseEther('1'), lpWei: 100n });
    const cur = snap({ accs: 3, ethUsedWei: parseEther('1.25'), lpWei: 130n });
    const out = diffCounters(prev, cur, AT);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('pol');
    expect(out[0].id).toBe('pol:3');
    expect(out[0].detail).toContain('protocol-owned liquidity');
    expect(out[0].detail).toContain('ETH');
  });

  it('emits BOTH a fee and a pol event when both counters move in one poll', () => {
    const prev = snap({ epoch: 1, distWei: 0n, accs: 1, ethUsedWei: 0n });
    const cur = snap({ epoch: 2, distWei: parseEther('0.01'), accs: 2, ethUsedWei: parseEther('0.02') });
    const out = diffCounters(prev, cur, AT);
    expect(out.map((e) => e.kind).sort()).toEqual(['fee', 'pol']);
  });

  it('never emits for a surface that was not observed (null in prev or cur)', () => {
    const prev = snap({ epoch: 1, revNull: false });
    const curOutage = snap({ epoch: 2, revNull: true }); // revenue read failed this poll
    expect(diffCounters(prev, curOutage, AT)).toEqual([]);

    const prevOutage = snap({ epoch: 1, revNull: true });
    const cur = snap({ epoch: 2 });
    expect(diffCounters(prevOutage, cur, AT)).toEqual([]);
  });

  it('never emits on a counter moving backwards (re-org / bad read)', () => {
    const prev = snap({ epoch: 6, accs: 4 });
    const cur = snap({ epoch: 5, accs: 3 });
    expect(diffCounters(prev, cur, AT)).toEqual([]);
  });
});
