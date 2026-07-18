import { describe, it, expect } from 'vitest';
import { SOL_MINT, USDC_MINT } from '../../solana';
import {
  SOLANA_LAUNCHER_ENABLED,
  isSolanaLauncherEnabled,
  METEORA_PROTOCOL_FEE_PERCENT,
  MIN_FEE_BPS,
  MAX_FEE_BPS,
  MAX_ANTI_SNIPE_DURATION_SECONDS,
  U64_MAX,
  DEFAULT_ANTI_SNIPE,
  asSquadsVault,
  isLikelyBase58Pubkey,
  splitTradingFee,
  buildDbcPartnerConfig,
  buildLaunchParams,
  claimPartnerFeesParams,
  type SquadsVault,
} from './dbc';

// Real-looking base58 pubkeys (32-44 chars, valid alphabet). Not the system key.
const VAULT = asSquadsVault('SQDSvaU1t1111111111111111111111111111111111');
const OTHER_VAULT = asSquadsVault('SQDSotherVau1t22222222222222222222222222222');
const CONFIG = '5CfgKey11111111111111111111111111111111111';
const PAYER = '9PayerAddr1111111111111111111111111111111';
const BASE_MINT = '7BaseMint111111111111111111111111111111111';
const CREATOR = '4Creator1111111111111111111111111111111111';
const POOL = '3Poo1Addr1111111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';

function partnerOpts(overrides = {}) {
  return {
    feeClaimer: VAULT,
    config: CONFIG,
    payer: PAYER,
    initialMarketCap: 5_000,
    migrationMarketCap: 50_000,
    ...overrides,
  };
}

describe('gate', () => {
  it('is disabled by default (unreachable submit path)', () => {
    expect(SOLANA_LAUNCHER_ENABLED).toBe(false);
    expect(isSolanaLauncherEnabled()).toBe(false);
  });
});

describe('asSquadsVault — Squads-vault invariant', () => {
  it('throws on an empty address', () => {
    expect(() => asSquadsVault('')).toThrow(/Squads vault/);
    expect(() => asSquadsVault('   ')).toThrow(/Squads vault/);
  });

  it('throws on the default/system pubkey (zero / EOA-shaped-unset)', () => {
    expect(() => asSquadsVault(SYSTEM)).toThrow(/default\/system pubkey/);
  });

  it('throws on a malformed (non-base58) address', () => {
    expect(() => asSquadsVault('not a real address!!!')).toThrow(/base58/);
    expect(() => asSquadsVault('0OIl_short')).toThrow(/base58/);
  });

  it('accepts and brands a valid base58 vault', () => {
    const v: SquadsVault = asSquadsVault('SQDSvaU1t1111111111111111111111111111111111');
    expect(typeof v).toBe('string');
    expect(isLikelyBase58Pubkey(v)).toBe(true);
  });

  it('rejects the system pubkey via isLikelyBase58Pubkey', () => {
    expect(isLikelyBase58Pubkey(SYSTEM)).toBe(false);
  });
});

describe('splitTradingFee — 80/20 fee-split math', () => {
  it('gives Meteora a fixed 20% of the total', () => {
    const s = splitTradingFee(100, 60);
    expect(METEORA_PROTOCOL_FEE_PERCENT).toBe(20);
    expect(s.meteoraBps).toBe(20); // 20% of 100 bps
    // The remaining 80 bps split 60/40 creator/partner.
    expect(s.creatorBps).toBe(48); // 60% of 80
    expect(s.partnerBps).toBe(32); // 40% of 80
  });

  it('conserves the total (meteora + partner + creator === total)', () => {
    const s = splitTradingFee(250, 75);
    expect(s.meteoraBps + s.partnerBps + s.creatorBps).toBe(250);
  });

  it('makes the creator the majority of the 80% at the default 60%', () => {
    const s = splitTradingFee(100, 60);
    expect(s.creatorBps).toBeGreaterThan(s.partnerBps);
  });

  it('rejects an out-of-range creator percentage', () => {
    expect(() => splitTradingFee(100, 101)).toThrow(/\[0,100\]/);
    expect(() => splitTradingFee(100, -1)).toThrow(/\[0,100\]/);
  });
});

describe('buildDbcPartnerConfig — Squads-vault requirement', () => {
  it('throws when a raw (unbranded) EOA is forced in as feeClaimer', () => {
    // Simulate JS / a cast bypassing the brand — runtime re-affirmation must catch it.
    const raw = SYSTEM as unknown as SquadsVault;
    expect(() => buildDbcPartnerConfig(partnerOpts({ feeClaimer: raw }))).toThrow(/default\/system pubkey/);
  });

  it('throws when leftoverReceiver is forced to a non-vault', () => {
    const raw = SYSTEM as unknown as SquadsVault;
    expect(() => buildDbcPartnerConfig(partnerOpts({ leftoverReceiver: raw }))).toThrow(/default\/system pubkey/);
  });

  it('defaults leftoverReceiver to the feeClaimer vault', () => {
    const { accounts } = buildDbcPartnerConfig(partnerOpts());
    expect(accounts.leftoverReceiver).toBe(VAULT);
    expect(accounts.feeClaimer).toBe(VAULT);
  });
});

describe('buildDbcPartnerConfig — quote mint choice', () => {
  it('defaults to SOL with 9 quote decimals', () => {
    const { curve, accounts } = buildDbcPartnerConfig(partnerOpts());
    expect(accounts.quoteMint).toBe(SOL_MINT);
    expect(curve.token.tokenQuoteDecimal).toBe(9);
  });

  it('accepts USDC with 6 quote decimals', () => {
    const { curve, accounts } = buildDbcPartnerConfig(partnerOpts({ quoteMint: USDC_MINT }));
    expect(accounts.quoteMint).toBe(USDC_MINT);
    expect(curve.token.tokenQuoteDecimal).toBe(6);
  });

  it('rejects a quote mint that is neither SOL nor USDC', () => {
    expect(() => buildDbcPartnerConfig(partnerOpts({ quoteMint: BASE_MINT as never }))).toThrow(/SOL .* or USDC/);
  });
});

describe('buildDbcPartnerConfig — anti-snipe decay present', () => {
  it('emits a decaying fee scheduler by default (99% -> 1%)', () => {
    const { curve } = buildDbcPartnerConfig(partnerOpts());
    const fee = curve.fee.baseFeeParams;
    expect('feeSchedulerParam' in fee).toBe(true);
    if ('feeSchedulerParam' in fee) {
      expect(fee.feeSchedulerParam.startingFeeBps).toBe(MAX_FEE_BPS);
      expect(fee.feeSchedulerParam.startingFeeBps).toBeGreaterThan(fee.feeSchedulerParam.endingFeeBps);
      expect(fee.feeSchedulerParam.endingFeeBps).toBeGreaterThanOrEqual(MIN_FEE_BPS);
      expect(fee.feeSchedulerParam.numberOfPeriod).toBeGreaterThan(0);
      expect(fee.feeSchedulerParam.totalDuration).toBeLessThanOrEqual(MAX_ANTI_SNIPE_DURATION_SECONDS);
    }
    // exponential mode discriminant = 1 (Jupiter-Studio style)
    expect(fee.baseFeeMode).toBe(1);
  });

  it('rejects a non-decaying schedule (starting <= ending)', () => {
    expect(() =>
      buildDbcPartnerConfig(
        partnerOpts({ antiSnipe: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 10, totalDuration: 600 } }),
      ),
    ).toThrow(/DECAY/);
  });

  it('rejects an ending fee below the program floor', () => {
    expect(() =>
      buildDbcPartnerConfig(
        partnerOpts({ antiSnipe: { startingFeeBps: 9000, endingFeeBps: 10, numberOfPeriod: 10, totalDuration: 600 } }),
      ),
    ).toThrow(new RegExp(`\\[${MIN_FEE_BPS}, ${MAX_FEE_BPS}\\]`));
  });

  it('rejects a decay window over the 12h cap', () => {
    expect(() =>
      buildDbcPartnerConfig(
        partnerOpts({
          antiSnipe: { startingFeeBps: 9000, endingFeeBps: 100, numberOfPeriod: 10, totalDuration: MAX_ANTI_SNIPE_DURATION_SECONDS + 1 },
        }),
      ),
    ).toThrow(/totalDuration must be <=/);
  });

  it('supports a linear schedule (discriminant 0)', () => {
    const { curve } = buildDbcPartnerConfig(
      partnerOpts({ antiSnipe: { ...DEFAULT_ANTI_SNIPE, mode: 'linear' } }),
    );
    expect(curve.fee.baseFeeParams.baseFeeMode).toBe(0);
  });
});

describe('buildDbcPartnerConfig — token + curve invariants', () => {
  it('pins an immutable, no-mint SPL token and quote-collected fees', () => {
    const { curve } = buildDbcPartnerConfig(partnerOpts());
    expect(curve.token.tokenType).toBe(0); // SPLToken
    expect(curve.token.tokenAuthorityOption).toBe(1); // Immutable — no mint/update authority
    expect(curve.fee.collectFeeMode).toBe(0); // QuoteToken
    expect(curve.fee.dynamicFeeEnabled).toBe(false);
    expect(curve.token.tokenBaseDecimal).toBe(6); // default
    expect(curve.token.totalTokenSupply).toBe(1_000_000_000);
  });

  it('carries the creator-majority fee percentage and its disclosure', () => {
    const { curve, feeSplit } = buildDbcPartnerConfig(partnerOpts());
    expect(curve.fee.creatorTradingFeePercentage).toBe(60);
    expect(feeSplit.creatorBps).toBeGreaterThan(feeSplit.partnerBps);
  });

  it('migrates to DAMM v2 and passes the market-cap band through', () => {
    const { curve } = buildDbcPartnerConfig(partnerOpts({ initialMarketCap: 5_000, migrationMarketCap: 80_000 }));
    expect(curve.migration.migrationOption).toBe(1); // MET_DAMM_V2
    expect(curve.initialMarketCap).toBe(5_000);
    expect(curve.migrationMarketCap).toBe(80_000);
  });

  it('defaults LP to 100% partner-permanent-locked (fee-capture flywheel)', () => {
    const { curve } = buildDbcPartnerConfig(partnerOpts());
    expect(curve.liquidityDistribution.partnerPermanentLockedLiquidityPercentage).toBe(100);
  });

  it('rejects an LP distribution that does not sum to 100', () => {
    expect(() =>
      buildDbcPartnerConfig(
        partnerOpts({
          liquidityDistribution: {
            partnerPermanentLockedLiquidityPercentage: 50,
            partnerLiquidityPercentage: 0,
            creatorPermanentLockedLiquidityPercentage: 0,
            creatorLiquidityPercentage: 40,
          },
        }),
      ),
    ).toThrow(/sum to 100/);
  });

  it('rejects migrationMarketCap <= initialMarketCap', () => {
    expect(() => buildDbcPartnerConfig(partnerOpts({ initialMarketCap: 50_000, migrationMarketCap: 50_000 }))).toThrow(
      /must exceed initialMarketCap/,
    );
  });

  it('rejects leftover >= totalTokenSupply', () => {
    expect(() => buildDbcPartnerConfig(partnerOpts({ totalTokenSupply: 1000, leftover: 1000 }))).toThrow(/leftover/);
  });
});

describe('buildLaunchParams', () => {
  const opts = { config: CONFIG, baseMint: BASE_MINT, poolCreator: CREATOR, payer: PAYER };
  const meta = { name: 'Tegridy Meme', symbol: 'TMEME', uri: 'ipfs://meta' };

  it('assembles create-pool params from meta + accounts', () => {
    const p = buildLaunchParams(opts, meta);
    expect(p).toEqual({ ...meta, ...opts });
  });

  it('trims whitespace in meta fields', () => {
    const p = buildLaunchParams(opts, { name: '  Tegridy  ', symbol: ' TG ', uri: ' ipfs://x ' });
    expect(p.name).toBe('Tegridy');
    expect(p.symbol).toBe('TG');
    expect(p.uri).toBe('ipfs://x');
  });

  it('requires name, symbol, and uri', () => {
    expect(() => buildLaunchParams(opts, { ...meta, name: '' })).toThrow(/name/);
    expect(() => buildLaunchParams(opts, { ...meta, symbol: '  ' })).toThrow(/symbol/);
    expect(() => buildLaunchParams(opts, { ...meta, uri: '' })).toThrow(/uri/);
  });

  it('rejects a malformed account address', () => {
    expect(() => buildLaunchParams({ ...opts, baseMint: 'bad!' }, meta)).toThrow(/baseMint/);
    expect(() => buildLaunchParams({ ...opts, config: SYSTEM }, meta)).toThrow(/config/);
  });
});

describe('claimPartnerFeesParams — custody invariant', () => {
  it('builds a claim defaulting receiver to the feeClaimer vault and claim-all amounts', () => {
    const p = claimPartnerFeesParams({ feeClaimer: VAULT, pool: POOL, payer: PAYER });
    expect(p.receiver).toBe(VAULT);
    expect(p.maxBaseAmount).toBe(U64_MAX);
    expect(p.maxQuoteAmount).toBe(U64_MAX);
  });

  it('allows a distinct receiver only if it is also a Squads vault', () => {
    const p = claimPartnerFeesParams({ feeClaimer: VAULT, pool: POOL, payer: PAYER, receiver: OTHER_VAULT });
    expect(p.receiver).toBe(OTHER_VAULT);
  });

  it('refuses to redirect fees to a non-vault (EOA) receiver', () => {
    const raw = SYSTEM as unknown as SquadsVault;
    expect(() => claimPartnerFeesParams({ feeClaimer: VAULT, pool: POOL, payer: PAYER, receiver: raw })).toThrow(
      /default\/system pubkey/,
    );
  });

  it('refuses a non-vault feeClaimer', () => {
    const raw = SYSTEM as unknown as SquadsVault;
    expect(() => claimPartnerFeesParams({ feeClaimer: raw, pool: POOL, payer: PAYER })).toThrow(/default\/system pubkey/);
  });

  it('rejects a malformed pool address', () => {
    expect(() => claimPartnerFeesParams({ feeClaimer: VAULT, pool: 'nope!', payer: PAYER })).toThrow(/pool/);
  });

  it('rejects amounts outside [0, U64_MAX]', () => {
    expect(() => claimPartnerFeesParams({ feeClaimer: VAULT, pool: POOL, payer: PAYER, maxBaseAmount: -1n })).toThrow(
      /maxBaseAmount/,
    );
    expect(() =>
      claimPartnerFeesParams({ feeClaimer: VAULT, pool: POOL, payer: PAYER, maxQuoteAmount: U64_MAX + 1n }),
    ).toThrow(/maxQuoteAmount/);
  });
});
