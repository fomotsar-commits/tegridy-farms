// Pins the decoder against the REAL mainnet PoolConfig account, captured
// 2026-08-02 from `4HVMW8TRZmXAxERH94hkVgM279fSXSBBsjonBYmxxxMn` — the one
// config on the DBC program whose feeClaimer is our Squads vault.
//
// Every expected value below was cross-checked against the Meteora SDK's own
// `getPoolConfig` decode of the same account. That is what makes hand-rolled
// offsets defensible: they are not inferred from a byte search, they are
// pinned to an independent decoder's output.

import { describe, it, expect } from 'vitest';
import {
  CONFIG_OFFSETS,
  decodePoolConfig,
  feeBpsAtSeconds,
  splitAtFee,
  POOL_CONFIG_DISCRIMINATOR,
} from './liveConfig';
import { encodeBase58 } from './feeCustody';

// Real account bytes, base64, as returned by getAccountInfo.
const LIVE_ACCOUNT_B64 = 'GmwOe3TmgSsGm4hX/quBhPtof2NGGMA12sQ53BrrO1WYoPAAAAAAAeUc3D/p5bgRyaiS88h1kuJ5K7gQGxKoQO+dTnYct/FI5RzcP+nluBHJqJLzyHWS4nkruBAbEqhA751Odhy38UiAMwI7AAAAALQAAAAAAAAAdwEAAAAAAAB4AAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQYAAABkAAAAAgE8AQAAAAAAAAAAAIKCn138sgIAEmX06ewKAADEhRtHgtoAABaz23+LSz45AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgMakfo0DAACAxqR+jQMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACVUJ1kUhgaEgAAAAAAAAAAFrPbf4tLPjkAAAAAAAAAABgQU76BtRETy7Ir53RHAACbV2lOqRpchLHE/v8AAAAAA9ZpuQTNX8tykAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const RAW = bytes(LIVE_ACCOUNT_B64);

describe('decodePoolConfig — against the real mainnet account', () => {
  it('is the account we think it is', () => {
    expect(RAW.length).toBe(1048);
    expect(RAW.slice(0, 8)).toEqual(POOL_CONFIG_DISCRIMINATOR);
  });

  it('decodes every field to the SDK-verified value', () => {
    const cfg = decodePoolConfig(RAW);
    expect(cfg).not.toBeNull();
    expect(cfg!.openingFeeBps).toBe(9900);            // 99%
    expect(cfg!.numberOfPeriod).toBe(120);
    expect(cfg!.periodFrequencySeconds).toBe(180);
    expect(cfg!.reductionFactorBps).toBe(375);
    expect(cfg!.mode).toBe('exponential');
    expect(cfg!.totalDurationSeconds).toBe(21_600);   // 6h
    expect(cfg!.creatorTradingFeePercentage).toBe(60);
    expect(cfg!.restingFeeBps).toBeCloseTo(100.86, 1); // ~1.01%
  });

  it('reproduces the decay a trader actually faces', () => {
    const cfg = decodePoolConfig(RAW)!;
    // These are the numbers that make the 6h window a business problem, so they
    // are pinned rather than described.
    expect(feeBpsAtSeconds(cfg, 0) / 100).toBeCloseTo(99.0, 1);
    expect(feeBpsAtSeconds(cfg, 3600) / 100).toBeCloseTo(46.1, 1);
    expect(feeBpsAtSeconds(cfg, 3 * 3600) / 100).toBeCloseTo(10.0, 1);
    expect(feeBpsAtSeconds(cfg, 6 * 3600) / 100).toBeCloseTo(1.01, 1);
  });

  it('splits the resting fee 48 / 32 / 20', () => {
    const cfg = decodePoolConfig(RAW)!;
    const s = splitAtFee(cfg, 10_000); // out of a hypothetical 100% fee
    expect(s.creatorBps).toBe(4800);
    expect(s.partnerBps).toBe(3200);
    expect(s.meteoraBps).toBe(2000);
  });
});

// The two pubkey offsets, pinned SEPARATELY and by the address each one yields.
//
// They are indistinguishable on this account — `fee_claimer` and
// `leftover_receiver` hold the same vault — which is precisely how the custody
// gate came to read 72. Asserting "offset 72 gives the vault" was true and told
// nobody that 72 is the wrong field. So each offset is pinned to its own value
// AND to its neighbours, so a swap moves an assertion even while the two agree.
describe('the PoolConfig pubkey offsets', () => {
  const at = (o: number) => encodeBase58(RAW.subarray(o, o + 32));
  const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';

  it('fee_claimer is 40 and leftover_receiver is 72 — never the other way round', () => {
    expect(CONFIG_OFFSETS.feeClaimer).toBe(40);
    expect(CONFIG_OFFSETS.leftoverReceiver).toBe(72);
    expect(CONFIG_OFFSETS.feeClaimer).toBeLessThan(CONFIG_OFFSETS.leftoverReceiver);
  });

  it('the field BEFORE fee_claimer is quote_mint, which anchors the pair', () => {
    // If the layout shifted by one pubkey in either direction this stops being
    // wSOL, so it is the independent evidence that 40 is not merely "a pubkey".
    expect(at(8)).toBe('So11111111111111111111111111111111111111112');
  });

  it('both fields hold the vault on the v1 config — the reason a wrong offset hid', () => {
    expect(at(CONFIG_OFFSETS.feeClaimer)).toBe(VAULT);
    expect(at(CONFIG_OFFSETS.leftoverReceiver)).toBe(VAULT);
  });
});

describe('fails closed rather than guessing', () => {
  it('rejects a wrong discriminator', () => {
    const bad = RAW.slice();
    bad[0] ^= 0xff;
    expect(decodePoolConfig(bad)).toBeNull();
  });

  it('rejects a truncated account', () => {
    expect(decodePoolConfig(RAW.slice(0, 128))).toBeNull();
  });

  it('rejects an impossible opening fee (layout drift inside the same type)', () => {
    const bad = RAW.slice();
    // cliffFeeNumerator @104 -> far beyond 100%
    new DataView(bad.buffer, bad.byteOffset).setBigUint64(104, 99_000_000_000n, true);
    expect(decodePoolConfig(bad)).toBeNull();
  });

  it('rejects a creator percentage over 100', () => {
    const bad = RAW.slice();
    bad[245] = 200;
    expect(decodePoolConfig(bad)).toBeNull();
  });

  it('rejects an unknown fee mode', () => {
    const bad = RAW.slice();
    bad[130] = 7;
    expect(decodePoolConfig(bad)).toBeNull();
  });
});
