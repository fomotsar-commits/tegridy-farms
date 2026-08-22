// Ground-truth generator for the frontend's curve-math port.
//
// `frontend/src/lib/launcher/solana/curve/math.ts` is a hand transcription of
// `programs/tegridy-launch/src/curve.rs` into TypeScript, and a UI that quotes
// differently than the program executes takes money from users. This compiles the
// REAL curve.rs and prints every case's answer as a TypeScript fixture, which the
// frontend test suite then replays through the port and asserts exactly.
//
// It lives here, not in the frontend, because it is Rust and it is bound to
// curve.rs — if curve.rs changes, this is what re-proves the port.
//
// RUN (needs only plain rustc — curve.rs is deliberately Solana-free, curve.rs:1-3):
//   cp programs/tegridy-launch/src/curve.rs /tmp/curve_pub.rs
//   sed -i 's/^fn fee_up(/pub fn fee_up(/' /tmp/curve_pub.rs   # it is private upstream
//   diff /tmp/curve_pub.rs programs/tegridy-launch/src/curve.rs  # must be that ONE line
//   cp tools/gen_curve_vectors.rs /tmp/ && cd /tmp
//   rustc --edition 2021 -O -o gen gen_curve_vectors.rs && ./gen
// Splice the output under the existing header in curveVectors.fixture.ts.
//
// curve_pub.rs is that byte-identical copy with `fee_up` made `pub`; the `diff`
// above is the check that it is a copy and not a rewrite.
#[path = "curve_pub.rs"]
mod curve;
use curve::*;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64* — deterministic, so regeneration is reproducible.
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    /// Log-uniform over [1, 2^bits) so the full u64 magnitude range is exercised.
    fn mag(&mut self, max_bits: u32) -> u64 {
        let bits = (self.next() % (max_bits as u64)) as u32 + 1;
        let v = self.next() >> (64 - bits);
        if v == 0 { 1 } else { v }
    }
}

fn err_name(e: CurveError) -> &'static str {
    match e {
        CurveError::Overflow => "Overflow",
        CurveError::InsufficientLiquidity => "InsufficientLiquidity",
        CurveError::ZeroAmount => "ZeroAmount",
        CurveError::FeeTooHigh => "FeeTooHigh",
    }
}

/// One row: `[ ...inputs, okFlag, ...outputs | errName ]` — compact on purpose.
fn row(inputs: &[u64], out: Result<Vec<u64>, CurveError>) -> String {
    let ins: Vec<String> = inputs.iter().map(|v| format!("'{v}'")).collect();
    match out {
        Ok(vs) => {
            let os: Vec<String> = vs.iter().map(|v| format!("'{v}'")).collect();
            format!("[[{}],[{}]]", ins.join(","), os.join(","))
        }
        Err(e) => format!("[[{}],'{}']", ins.join(","), err_name(e)),
    }
}

const FEES: [u64; 10] = [0, 1, 25, 100, 300, 999, 1000, 1001, 9999, 10000];

fn main() {
    let mut r = Rng(0x9E3779B97F4A7C15);

    println!("// GENERATED — do not edit by hand. See curveVectors.fixture.ts header.");
    println!("export const FEE_UP_VECTORS: readonly CurveVector[] = [");
    for _ in 0..220 {
        let amount = r.mag(64);
        let fee = FEES[(r.next() % FEES.len() as u64) as usize];
        println!("  {},", row(&[amount, fee], fee_up(amount, fee).map(|v| vec![v])));
    }
    // Edge amounts against every fee.
    for &amount in &[0u64, 1, 2, 9_999, 10_000, 10_001, 20_000, u64::MAX] {
        for &fee in FEES.iter() {
            println!("  {},", row(&[amount, fee], fee_up(amount, fee).map(|v| vec![v])));
        }
    }
    println!("];");

    println!("export const QUOTE_BUY_VECTORS: readonly CurveVector[] = [");
    for _ in 0..700 {
        let sol = r.mag(64);
        let tok = r.mag(64);
        let lam = r.mag(64);
        let fee = FEES[(r.next() % FEES.len() as u64) as usize];
        let q = quote_buy(sol, tok, lam, fee)
            .map(|q| vec![q.fee_lamports, q.lamports_to_curve, q.tokens_out]);
        println!("  {},", row(&[sol, tok, lam, fee], q));
    }
    // Degenerate / boundary reserves.
    for &(sol, tok) in &[(0u64, 1u64), (1, 0), (0, 0), (1, 1), (u64::MAX, u64::MAX), (30_000_000_000, 1_073_000_000_000_000)] {
        for &lam in &[0u64, 1, 1_000, 1_000_000_000, u64::MAX] {
            for &fee in &[0u64, 100, 1_000, 1_001] {
                let q = quote_buy(sol, tok, lam, fee)
                    .map(|q| vec![q.fee_lamports, q.lamports_to_curve, q.tokens_out]);
                println!("  {},", row(&[sol, tok, lam, fee], q));
            }
        }
    }
    println!("];");

    println!("export const QUOTE_SELL_VECTORS: readonly CurveVector[] = [");
    for _ in 0..700 {
        let sol = r.mag(64);
        let tok = r.mag(64);
        let tin = r.mag(64);
        let fee = FEES[(r.next() % FEES.len() as u64) as usize];
        let q = quote_sell(sol, tok, tin, fee)
            .map(|q| vec![q.gross_lamports, q.fee_lamports, q.lamports_out]);
        println!("  {},", row(&[sol, tok, tin, fee], q));
    }
    for &(sol, tok) in &[(0u64, 1u64), (1, 0), (0, 0), (1, 1), (u64::MAX, u64::MAX), (30_000_000_000, 1_073_000_000_000_000)] {
        for &tin in &[0u64, 1, 1_000, 1_000_000_000_000, u64::MAX] {
            for &fee in &[0u64, 100, 1_000, 1_001] {
                let q = quote_sell(sol, tok, tin, fee)
                    .map(|q| vec![q.gross_lamports, q.fee_lamports, q.lamports_out]);
                println!("  {},", row(&[sol, tok, tin, fee], q));
            }
        }
    }
    println!("];");

    // `None` is encoded as the empty output list — distinct from an error row.
    println!("export const LAMPORTS_UNTIL_TARGET_VECTORS: readonly CurveVector[] = [");
    for _ in 0..300 {
        let real = r.mag(64);
        let target = r.mag(64);
        let fee = FEES[(r.next() % FEES.len() as u64) as usize];
        let q = lamports_until_target(real, target, fee)
            .map(|o| o.map(|v| vec![v]).unwrap_or_default());
        println!("  {},", row(&[real, target, fee], q));
    }
    for &(real, target) in &[(0u64, 0u64), (0, 1), (1, 1), (2, 1), (0, u64::MAX), (u64::MAX, u64::MAX), (u64::MAX - 1, u64::MAX)] {
        for &fee in FEES.iter() {
            let q = lamports_until_target(real, target, fee)
                .map(|o| o.map(|v| vec![v]).unwrap_or_default());
            println!("  {},", row(&[real, target, fee], q));
        }
    }
    println!("];");

    println!("export const MAX_REACHABLE_VECTORS: readonly CurveVector[] = [");
    for _ in 0..200 {
        let vs = r.mag(64);
        let vt = r.mag(64);
        let s = r.mag(64);
        println!("  {},", row(&[vs, vt, s], max_reachable_real_sol(vs, vt, s).map(|v| vec![v])));
    }
    for &(vs, vt, s) in &[(0u64, 1u64, 1u64), (1, 0, 1), (1, 1, 0), (u64::MAX, 1, u64::MAX), (1, u64::MAX, 1)] {
        println!("  {},", row(&[vs, vt, s], max_reachable_real_sol(vs, vt, s).map(|v| vec![v])));
    }
    println!("];");

    // `U128_EDGE` exists because the ORIGINAL sampling window (vs≤2^48, vt/s≤2^56)
    // capped `vs·(vt+s)` at ~2^105 and therefore never reached `u128::MAX`. Both
    // functions below hold u128 intermediates that CAN exceed it on real u64 inputs,
    // and `checked_mul` turns that into `Overflow` — a branch the narrow window made
    // unreachable, so the TypeScript port went unproven there and got it wrong.
    // These pairs straddle the u128 ceiling: (vt+s) near 2^65 against a `vs` chosen so
    // the product lands just under and just over 2^128.
    const U128_EDGE: [(u64, u64, u64); 6] = [
        (u64::MAX, u64::MAX, u64::MAX),          // vs·(vt+s) ≈ 2^129 — over
        (1u64 << 63, u64::MAX, u64::MAX),        // = 2^128 − 2^64 — just under
        ((1u64 << 63) + 1, u64::MAX, u64::MAX),  // = 2^128 + 2^64 − 2 — just over
        (1u64 << 60, u64::MAX, u64::MAX),        // well under
        (u64::MAX, 1, u64::MAX),                 // (vt+s) ≈ 2^64, vs ≈ 2^64 — just under
        (u64::MAX, u64::MAX, 1),                 // symmetric partner
    ];

    println!("export const PRICE_RATIO_VECTORS: readonly CurveVector[] = [");
    for _ in 0..300 {
        let vs = r.mag(48);
        let vt = r.mag(56);
        let s = r.mag(56);
        let t = r.mag(48);
        let res = r.mag(40);
        let q = graduation_price_ratio_bps(vs, vt, s, t, res).map(|v| vec![v]);
        println!("  {},", row(&[vs, vt, s, t, res], q));
    }
    // FULL u64 magnitude on every argument — the window the original sampling missed.
    for _ in 0..300 {
        let vs = r.mag(64);
        let vt = r.mag(64);
        let s = r.mag(64);
        let t = r.mag(64);
        let res = r.mag(64);
        let q = graduation_price_ratio_bps(vs, vt, s, t, res).map(|v| vec![v]);
        println!("  {},", row(&[vs, vt, s, t, res], q));
    }
    for &(vs, vt, s) in U128_EDGE.iter() {
        for &t in &[1u64, 1u64 << 59, 1u64 << 62, 1u64 << 63, u64::MAX] {
            for &res in &[0u64, 1u64 << 40] {
                let q = graduation_price_ratio_bps(vs, vt, s, t, res).map(|v| vec![v]);
                println!("  {},", row(&[vs, vt, s, t, res], q));
            }
        }
    }
    for &(vs, vt, s, t, res) in &[
        (30_000_000_000u64, 1_073_000_000_000_000u64, 1_000_000_000_000_000u64, 2_000_000_000u64, 250_000_000u64),
        (0, 1, 1, 1, 0), (1, 0, 1, 1, 0), (1, 1, 0, 1, 0), (1, 1, 1, 0, 0),
    ] {
        let q = graduation_price_ratio_bps(vs, vt, s, t, res).map(|v| vec![v]);
        println!("  {},", row(&[vs, vt, s, t, res], q));
    }
    println!("];");

    println!("export const CONTINUITY_TARGET_VECTORS: readonly CurveVector[] = [");
    for _ in 0..300 {
        let vs = r.mag(48);
        let vt = r.mag(56);
        let s = r.mag(56);
        let res = r.mag(40);
        println!("  {},", row(&[vs, vt, s, res], continuity_target(vs, vt, s, res).map(|v| vec![v])));
    }
    for _ in 0..300 {
        let vs = r.mag(64);
        let vt = r.mag(64);
        let s = r.mag(64);
        let res = r.mag(64);
        println!("  {},", row(&[vs, vt, s, res], continuity_target(vs, vt, s, res).map(|v| vec![v])));
    }
    for &(vs, vt, s) in U128_EDGE.iter() {
        for &res in &[0u64, 1, 1u64 << 40, 1u64 << 62, u64::MAX] {
            println!("  {},", row(&[vs, vt, s, res], continuity_target(vs, vt, s, res).map(|v| vec![v])));
        }
    }
    for &(vs, vt, s, res) in &[
        (30_000_000_000u64, 1_073_000_000_000_000u64, 1_000_000_000_000_000u64, 500_000_000u64),
        (0, 1, 1, 0), (1, 0, 1, 0), (1, 1, 0, 0), (1, 1, 1, 0),
    ] {
        println!("  {},", row(&[vs, vt, s, res], continuity_target(vs, vt, s, res).map(|v| vec![v])));
    }
    println!("];");
}
