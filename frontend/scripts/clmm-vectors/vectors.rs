// Test vectors for the site's range client, computed by the range program's OWN Rust code.
// run.sh copies solana/tegridy-clmm to a scratch folder, adds this file as a test module and
// runs it there; the copy in the repo is never touched. Inputs come from a fixed seed, so a
// run is repeatable. Outputs: {"ok": value} or {"err": "<ErrorCode name>"} or {"err": "panic"}.

use crate::instructions::calculate_latest_token_fees;
use crate::libraries::{big_num::U1024, liquidity_math, sqrt_price_math, swap_math, tick_array_bit_map, tick_math};
use crate::states::{get_fee_growth_inside, PoolState, TickArrayBitmapExtension, TickState};
use rand::{rngs::StdRng, Rng, SeedableRng};
use std::fmt::Write as _;
use std::panic::{catch_unwind, AssertUnwindSafe};

fn err_name(e: &anchor_lang::error::Error) -> String {
    let s = format!("{:?}", e);
    if let Some(i) = s.find("error_name: \"") {
        let rest = &s[i + 13..];
        return rest[..rest.find('"').unwrap()].to_string();
    }
    s
}

/// One outcome as JSON: the value's JSON, an error name, or a panic.
fn outcome<T, F: FnOnce() -> anchor_lang::Result<T>>(f: F, show: impl Fn(&T) -> String) -> String {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(v)) => format!("{{\"ok\":{}}}", show(&v)),
        Ok(Err(e)) => format!("{{\"err\":\"{}\"}}", err_name(&e)),
        Err(_) => "{\"err\":\"panic\"}".to_string(),
    }
}

fn q<T: std::fmt::Display>(v: T) -> String {
    format!("\"{}\"", v)
}

/// A value spread over every order of magnitude up to `bits` bits.
fn wide(r: &mut StdRng, bits: u32) -> u128 {
    let b = r.gen_range(0..=bits);
    if b == 0 {
        return 0;
    }
    let top = if b == 128 { u128::MAX } else { (1u128 << b) - 1 };
    r.gen_range(0..=top)
}

fn sqrt_in_range(r: &mut StdRng) -> u128 {
    match r.gen_range(0..4) {
        0 => r.gen_range(tick_math::MIN_SQRT_PRICE_X64..tick_math::MAX_SQRT_PRICE_X64),
        1 => {
            let t = r.gen_range(tick_math::MIN_TICK..tick_math::MAX_TICK);
            tick_math::get_sqrt_price_at_tick(t).unwrap()
        }
        _ => {
            let t = r.gen_range(-120_000..120_000);
            let s = tick_math::get_sqrt_price_at_tick(t).unwrap();
            let d = r.gen_range(0..1_000_000u128);
            if r.gen_bool(0.5) { s.saturating_add(d) } else { s.saturating_sub(d) }.clamp(tick_math::MIN_SQRT_PRICE_X64, tick_math::MAX_SQRT_PRICE_X64 - 1)
        }
    }
}

fn random_bitmap(r: &mut StdRng, words: usize, p: f64) -> Vec<u64> {
    (0..words)
        .map(|_| {
            let mut w = 0u64;
            for b in 0..64 {
                if r.gen_bool(p) {
                    w |= 1 << b;
                }
            }
            w
        })
        .collect()
}

#[test]
fn write_vectors() {
    std::panic::set_hook(Box::new(|_| {}));
    let mut r = StdRng::seed_from_u64(20261020);
    let mut out = String::from("{\n");

    // tick -> sqrt price
    let mut ticks: Vec<i32> = vec![tick_math::MIN_TICK - 1, tick_math::MIN_TICK, tick_math::MIN_TICK + 1, -1, 0, 1, tick_math::MAX_TICK - 1, tick_math::MAX_TICK, tick_math::MAX_TICK + 1];
    for _ in 0..500 {
        ticks.push(r.gen_range(tick_math::MIN_TICK..=tick_math::MAX_TICK));
    }
    out.push_str("\"sqrtPriceAtTick\":[");
    for (i, t) in ticks.iter().enumerate() {
        let _ = write!(out, "{}[{},{}]", if i > 0 { "," } else { "" }, t, outcome(|| tick_math::get_sqrt_price_at_tick(*t), |v| q(v)));
    }
    out.push_str("],\n");

    // sqrt price -> tick
    let mut sqrts: Vec<u128> = vec![0, tick_math::MIN_SQRT_PRICE_X64 - 1, tick_math::MIN_SQRT_PRICE_X64, tick_math::MIN_SQRT_PRICE_X64 + 1, tick_math::MAX_SQRT_PRICE_X64 - 1, tick_math::MAX_SQRT_PRICE_X64, 1u128 << 64];
    for _ in 0..500 {
        sqrts.push(sqrt_in_range(&mut r));
    }
    for _ in 0..120 {
        let t = r.gen_range(tick_math::MIN_TICK + 1..tick_math::MAX_TICK);
        let s = tick_math::get_sqrt_price_at_tick(t).unwrap();
        sqrts.push(s);
        sqrts.push(s - 1);
    }
    out.push_str("\"tickAtSqrtPrice\":[");
    for (i, s) in sqrts.iter().enumerate() {
        let _ = write!(out, "{}[{},{}]", if i > 0 { "," } else { "" }, q(s), outcome(|| tick_math::get_tick_at_sqrt_price(*s), |v| v.to_string()));
    }
    out.push_str("],\n");

    // price from sqrt price
    out.push_str("\"priceFromSqrtPrice\":[");
    for i in 0..150 {
        let s = if i % 7 == 0 { wide(&mut r, 128) } else { sqrt_in_range(&mut r) };
        let up = r.gen_bool(0.5);
        let _ = write!(out, "{}[{},{},{}]", if i > 0 { "," } else { "" }, q(s), up, outcome(|| tick_math::get_price_from_sqrt_price(s, up), |v| q(v.as_u128())));
    }
    out.push_str("],\n");

    // next sqrt price from an input or an output
    out.push_str("\"nextSqrtPrice\":[");
    for i in 0..600 {
        let s = if i % 50 == 0 { wide(&mut r, 128) } else { sqrt_in_range(&mut r) };
        let l = wide(&mut r, 128);
        let a = wide(&mut r, 64) as u64;
        let zfo = r.gen_bool(0.5);
        let input = r.gen_bool(0.5);
        let res = if input {
            outcome(|| sqrt_price_math::get_next_sqrt_price_from_input(s, l, a, zfo), |v| q(v))
        } else {
            outcome(|| sqrt_price_math::get_next_sqrt_price_from_output(s, l, a, zfo), |v| q(v))
        };
        let _ = write!(out, "{}[{},{},{},{},{},{}]", if i > 0 { "," } else { "" }, q(s), q(l), q(a), zfo, input, res);
    }
    out.push_str("],\n");

    // liquidity from amounts, both and single
    out.push_str("\"liquidityFromAmounts\":[");
    for i in 0..400 {
        let p = sqrt_in_range(&mut r);
        let a = sqrt_in_range(&mut r);
        let b = if i % 25 == 0 { a } else { sqrt_in_range(&mut r) };
        let x = wide(&mut r, 64) as u64;
        let y = wide(&mut r, 64) as u64;
        let both = outcome(|| liquidity_math::get_liquidity_from_amounts(p, a, b, x, y), |v| q(v));
        let one0 = outcome(|| liquidity_math::get_liquidity_from_single_amount_0(p, a, b, x), |v| q(v));
        let one1 = outcome(|| liquidity_math::get_liquidity_from_single_amount_1(p, a, b, y), |v| q(v));
        let _ = write!(out, "{}[{},{},{},{},{},{},{},{}]", if i > 0 { "," } else { "" }, q(p), q(a), q(b), q(x), q(y), both, one0, one1);
    }
    out.push_str("],\n");

    // delta amounts, unsigned and for a swap
    out.push_str("\"deltaAmounts\":[");
    for i in 0..500 {
        let a = sqrt_in_range(&mut r);
        let b = if i % 10 == 0 { a } else { sqrt_in_range(&mut r) };
        let l = wide(&mut r, 128);
        let up = r.gen_bool(0.5);
        let zfo = r.gen_bool(0.5);
        let d0 = outcome(|| liquidity_math::get_delta_amount_0_unsigned(a, b, l, up), |v| q(v));
        let d1 = outcome(|| liquidity_math::get_delta_amount_1_unsigned(a, b, l, up), |v| q(v));
        let sw = outcome(|| liquidity_math::get_delta_amounts_for_swap(a, b, l, zfo), |v| format!("[{},{}]", q(v.0), q(v.1)));
        let _ = write!(out, "{}[{},{},{},{},{},{},{},{}]", if i > 0 { "," } else { "" }, q(a), q(b), q(l), up, zfo, d0, d1, sw);
    }
    out.push_str("],\n");

    // delta amounts for a liquidity change at a price
    out.push_str("\"deltaAmountsSigned\":[");
    for i in 0..400 {
        let spacing = [1, 10, 60, 120][r.gen_range(0..4)];
        let lo = r.gen_range(-200_000..200_000) / spacing * spacing;
        let hi = lo + spacing * r.gen_range(1..3000);
        let cur = r.gen_range(lo - 5000..hi + 5000).clamp(tick_math::MIN_TICK, tick_math::MAX_TICK - 1);
        let s = tick_math::get_sqrt_price_at_tick(cur).unwrap() + r.gen_range(0..1000u128);
        let mag = wide(&mut r, if i % 20 == 0 { 127 } else { 90 }) as i128;
        let ld = if r.gen_bool(0.5) { mag } else { -mag };
        let res = outcome(|| liquidity_math::get_delta_amounts_signed(cur, s, lo, hi.min(tick_math::MAX_TICK), ld), |v| format!("[{},{}]", q(v.0), q(v.1)));
        let _ = write!(out, "{}[{},{},{},{},{},{}]", if i > 0 { "," } else { "" }, cur, q(s), lo, hi.min(tick_math::MAX_TICK), q(ld), res);
    }
    out.push_str("],\n");

    // add_delta
    out.push_str("\"addDelta\":[");
    for i in 0..200 {
        let x = wide(&mut r, 128);
        let m = wide(&mut r, 127) as i128;
        let y = if i % 3 == 0 { -(x.min(i128::MAX as u128) as i128) } else if r.gen_bool(0.5) { m } else { -m };
        let _ = write!(out, "{}[{},{},{}]", if i > 0 { "," } else { "" }, q(x), q(y), outcome(|| liquidity_math::add_delta(x, y), |v| q(v)));
    }
    out.push_str("],\n");

    // fees earned inside a range, then owed
    out.push_str("\"feeGrowthInside\":[");
    for i in 0..300 {
        let mut lo = TickState::default();
        let mut hi = TickState::default();
        lo.tick = r.gen_range(-1000..1000);
        hi.tick = lo.tick + r.gen_range(1..500);
        lo.fee_growth_outside_0_x64 = wide(&mut r, 128);
        lo.fee_growth_outside_1_x64 = wide(&mut r, 128);
        hi.fee_growth_outside_0_x64 = wide(&mut r, 128);
        hi.fee_growth_outside_1_x64 = wide(&mut r, 128);
        let cur = r.gen_range(lo.tick - 300..hi.tick + 300);
        let g0 = wide(&mut r, 128);
        let g1 = wide(&mut r, 128);
        let (in0, in1) = get_fee_growth_inside(&lo, &hi, cur, g0, g1);
        let owed = wide(&mut r, 64) as u64;
        let last = wide(&mut r, 128);
        let l = wide(&mut r, 128);
        let fees = outcome(|| calculate_latest_token_fees(owed, last, in0, l), |v| q(v));
        let _ = write!(
            out,
            "{}[{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}]",
            if i > 0 { "," } else { "" },
            { lo.tick }, q(lo.fee_growth_outside_0_x64), q(lo.fee_growth_outside_1_x64),
            { hi.tick }, q(hi.fee_growth_outside_0_x64), q(hi.fee_growth_outside_1_x64),
            cur, q(g0), q(g1), q(in0), q(in1), q(owed), q(last), q(l), fees
        );
    }
    out.push_str("],\n");

    // one swap step
    out.push_str("\"computeSwap\":[");
    for i in 0..1500 {
        let cur = sqrt_in_range(&mut r);
        let zfo = r.gen_bool(0.5);
        let span = wide(&mut r, if i % 4 == 0 { 100 } else { 70 });
        let target = if zfo { cur.saturating_sub(span).max(tick_math::MIN_SQRT_PRICE_X64 + 1) } else { cur.saturating_add(span).min(tick_math::MAX_SQRT_PRICE_X64 - 1) };
        let l = wide(&mut r, if i % 10 == 0 { 128 } else { 96 });
        let amount = wide(&mut r, 64) as u64;
        let fee = [0u32, 100, 500, 2500, 10000, 40000, 99999][r.gen_range(0..7)];
        let base_in = r.gen_bool(0.5);
        let fee_in = r.gen_bool(0.7);
        let res = outcome(
            || swap_math::compute_swap(cur, target, l, amount, fee, base_in, zfo, fee_in),
            |v| format!("[{},{},{},{}]", q(v.sqrt_price_next_x64), q(v.amount_in), q(v.amount_out), q(v.fee_amount)),
        );
        let _ = write!(out, "{}[{},{},{},{},{},{},{},{},{}]", if i > 0 { "," } else { "" }, q(cur), q(target), q(l), q(amount), fee, base_in, zfo, fee_in, res);
    }
    out.push_str("],\n");

    // the band search: pool map, extension map, and the pool-level walk
    out.push_str("\"bandSearch\":[");
    let mut first = true;
    for case in 0..96 {
        let spacing: u16 = [1, 10, 60, 120][case % 4];
        let p = [0.002, 0.01, 0.05][(case / 4) % 3];
        let bitmap = random_bitmap(&mut r, 16, p);
        let pos: Vec<Vec<u64>> = (0..14).map(|_| random_bitmap(&mut r, 8, p / 4.0)).collect();
        let neg: Vec<Vec<u64>> = (0..14).map(|_| random_bitmap(&mut r, 8, p / 4.0)).collect();
        let mut pool = PoolState::default();
        pool.tick_spacing = spacing;
        let mut bm = [0u64; 16];
        bm.copy_from_slice(&bitmap);
        pool.tick_array_bitmap = bm;
        let mut ext = TickArrayBitmapExtension::default();
        let (mut pa, mut na) = ([[0u64; 8]; 14], [[0u64; 8]; 14]);
        for k in 0..14 {
            pa[k].copy_from_slice(&pos[k]);
            na[k].copy_from_slice(&neg[k]);
        }
        ext.positive_tick_array_bitmap = pa;
        ext.negative_tick_array_bitmap = na;
        // Bitmaps as the indexes of their set bits, word 0 bit 0 first: far smaller than words.
        let words = |w: &Vec<u64>| {
            let bits: Vec<String> = (0..w.len() * 64).filter(|i| w[i / 64] >> (i % 64) & 1 == 1).map(|i| i.to_string()).collect();
            format!("[{}]", bits.join(","))
        };
        let maps = |m: &Vec<Vec<u64>>| format!("[{}]", m.iter().map(|w| words(w)).collect::<Vec<_>>().join(","));
        let mut queries = String::new();
        for j in 0..12 {
            let tick = if j % 3 == 0 { r.gen_range(tick_math::MIN_TICK..=tick_math::MAX_TICK) } else { r.gen_range(-40_000..40_000) * if spacing < 15 { 1 } else { 10 } };
            let zfo = r.gen_bool(0.5);
            pool.tick_current = tick;
            let start = crate::states::TickArrayState::get_array_start_index(tick, spacing);
            let in_pool = outcome(|| tick_array_bit_map::next_initialized_tick_array_start_index(U1024(bm), start, spacing, zfo), |v| format!("[{},{}]", v.0, v.1));
            let current = outcome(|| tick_array_bit_map::check_current_tick_array_is_initialized(U1024(bm), tick, spacing), |v| format!("[{},{}]", v.0, v.1));
            let walk = outcome(|| pool.next_initialized_tick_array_start_index(&Some(ext), start, zfo), |v| match v {
                Some(x) => x.to_string(),
                None => "null".to_string(),
            });
            let firstb = outcome(|| pool.get_first_initialized_tick_array(&Some(ext), zfo), |v| format!("[{},{}]", v.0, v.1));
            let in_ext = outcome(|| ext.next_initialized_tick_array_from_one_bitmap(start, spacing, zfo), |v| format!("[{},{}]", v.0, v.1));
            let ext_init = outcome(|| ext.check_tick_array_is_initialized(start, spacing), |v| format!("[{},{}]", v.0, v.1));
            let _ = write!(queries, "{}[{},{},{},{},{},{},{},{}]", if j > 0 { "," } else { "" }, tick, zfo, in_pool, current, walk, firstb, in_ext, ext_init);
        }
        let _ = write!(out, "{}[{},{},{},{},[{}]]", if first { "" } else { "," }, spacing, words(&bitmap), maps(&pos), maps(&neg), queries);
        first = false;
    }
    out.push_str("]\n}\n");

    let path = std::env::var("VECTORS_OUT").unwrap_or_else(|_| "vectors.json".to_string());
    std::fs::write(path, out).unwrap();
}
