//! Quote parity with the site: `tests/fixtures/quote_vectors.json` holds swaps and what the
//! program pays for each. This crate must reproduce every one, and so must the site's own
//! quote (frontend/src/lib/solana/cpswap/jupiterSdkParity.test.ts reads the same file).

mod common;

use jupiter_amm_interface::{Amm, QuoteParams, SwapMode};
use memetics_jupiter_sdk::math::{Refusal, swap_exact_in};
use memetics_jupiter_sdk::state::{AmmConfig, PoolState};
use serde_json::Value;
use solana_pubkey::Pubkey;

fn vectors() -> Value {
    let text = std::fs::read_to_string("tests/fixtures/quote_vectors.json").expect("read vectors");
    serde_json::from_str(&text).expect("vectors are JSON")
}

fn u64_of(v: &Value) -> u64 {
    v.as_str()
        .expect("amounts are strings")
        .parse()
        .expect("a u64")
}

fn refusal_named(name: &str) -> Refusal {
    match name {
        "NotApproved" => Refusal::NotApproved,
        "ZeroAmountIn" => Refusal::ZeroAmountIn,
        "InvalidFeeModel" => Refusal::InvalidFeeModel,
        "InsufficientVault" => Refusal::InsufficientVault,
        "ZeroTradingTokens" => Refusal::ZeroTradingTokens,
        "ZeroAmountOut" => Refusal::ZeroAmountOut,
        other => panic!("unknown refusal {other}"),
    }
}

#[test]
fn every_synthetic_vector() {
    let doc = vectors();
    let cases = doc["synthetic"].as_array().expect("synthetic cases");
    assert!(cases.len() >= 20, "the vectors file lost its cases");
    for c in cases {
        let p = &c["pool"];
        let pool = PoolState {
            status: p["status"].as_u64().unwrap() as u8,
            open_time: u64_of(&p["openTime"]),
            creator_fee_on: p["creatorFeeOn"].as_u64().unwrap() as u8,
            enable_creator_fee: p["enableCreatorFee"].as_bool().unwrap(),
            protocol_fees_token_0: u64_of(&p["protocolFees"][0]),
            protocol_fees_token_1: u64_of(&p["protocolFees"][1]),
            fund_fees_token_0: u64_of(&p["fundFees"][0]),
            fund_fees_token_1: u64_of(&p["fundFees"][1]),
            creator_fees_token_0: u64_of(&p["creatorFees"][0]),
            creator_fees_token_1: u64_of(&p["creatorFees"][1]),
            ..PoolState::default()
        };
        let k = &c["config"];
        let config = AmmConfig {
            trade_fee_rate: u64_of(&k["tradeFeeRate"]),
            protocol_fee_rate: u64_of(&k["protocolFeeRate"]),
            fund_fee_rate: u64_of(&k["fundFeeRate"]),
            creator_fee_rate: u64_of(&k["creatorFeeRate"]),
            ..AmmConfig::default()
        };
        let got = swap_exact_in(
            &pool,
            &config,
            u64_of(&c["vaults"][0]),
            u64_of(&c["vaults"][1]),
            c["inputIsToken0"].as_bool().unwrap(),
            u64_of(&c["amountIn"]),
            u64_of(&c["now"]) as i64,
        )
        .map(|r| r.output_amount);
        let want = match c["refusal"].as_str() {
            Some(name) => Err(refusal_named(name)),
            None => Ok(u64_of(&c["out"])),
        };
        assert_eq!(got, want, "{}", c["name"]);
    }
}

#[test]
fn every_live_vector() {
    let doc = vectors();
    let cases = doc["live"].as_array().expect("live cases");
    assert!(!cases.is_empty(), "the vectors file lost its live cases");
    for c in cases {
        let key = |f: &str| c[f].as_str().unwrap().parse::<Pubkey>().unwrap();
        let amm = common::amm(&key("pool"));
        let quote = amm
            .quote(&QuoteParams {
                amount: u64_of(&c["amountIn"]),
                input_mint: key("inputMint"),
                output_mint: key("outputMint"),
                swap_mode: SwapMode::ExactIn,
                fee_mode: Default::default(),
            })
            .expect("quote");
        assert_eq!(quote.out_amount, u64_of(&c["out"]), "{c}");
    }
}
