// Test vectors for the site's range client, computed by the range program's OWN Rust code.
// run.sh copies solana/tegridy-clmm to a scratch folder, adds this file as a test module and
// runs it there; the copy in the repo is never touched. Inputs come from a fixed seed, so a
// run is repeatable. Outputs: {"ok": value} or {"err": "<ErrorCode name>"} or {"err": "panic"}.

use crate::instructions::{calculate_latest_token_fees, swap_internal};
use crate::libraries::{big_num::U1024, fixed_point_64, liquidity_math, sqrt_price_math, swap_math, tick_array_bit_map, tick_math};
use crate::states::pool_test::build_pool;
use crate::states::tick_array_bitmap_extension_test::build_tick_array_bitmap_extension_info;
use crate::states::tick_array_test::build_tick_array_with_tick_states;
use crate::states::{get_fee_growth_inside, get_reward_growths_inside, AmmConfig, ObservationState, PersonalPositionState, PoolState, RewardInfo, TickArrayBitmapExtension, TickArrayState, TickState, REWARD_NUM};
use anchor_lang::prelude::Pubkey;
use anchor_lang::prelude::AccountLoader;
use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
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
    out.push_str("]");
    // whole swaps: swap_internal itself, on random pools with positions, resting limit orders,
    // dynamic fees, every fee-on mode, far bands and price limits
    out.push_str(",\n\"swapInternal\":[");
    for case in 0..360 {
        let spacing: u16 = [1, 10, 60, 120][case % 4];
        let sp = spacing as i32;
        let far = spacing == 1 && case % 8 == 0;
        let centre = if far { r.gen_range(31_000..60_000) * if r.gen_bool(0.5) { 1 } else { -1 } } else { r.gen_range(-30_000..30_000) * (sp / 10).max(1) };
        let tick_current = centre.clamp(tick_math::MIN_TICK + 2 * sp * 60, tick_math::MAX_TICK - 2 * sp * 60);
        let lo_p = tick_math::get_sqrt_price_at_tick(tick_current).unwrap();
        let hi_p = tick_math::get_sqrt_price_at_tick(tick_current + 1).unwrap();
        let sqrt = if r.gen_bool(0.2) { lo_p } else { r.gen_range(lo_p..hi_p) };
        let pool = build_pool(tick_current, spacing, sqrt, 0);
        let fee_on: u8 = r.gen_range(0..3);
        pool.borrow_mut().set_fee_on(fee_on).unwrap();
        let block_ts: u32 = 1_760_000_000 + r.gen_range(0..10_000_000);
        let dynamic = r.gen_bool(0.4);
        if dynamic {
            let filter: u16 = r.gen_range(5..60);
            let decay: u16 = filter + r.gen_range(10..900);
            let max_va: u32 = r.gen_range(50_000..500_000);
            pool.borrow_mut().initialize_dynamic_fee_info(tick_current, filter, decay, 5000, r.gen_range(1000..99_999), max_va).unwrap();
            let mut p = pool.borrow_mut();
            let mut d = p.dynamic_fee_info;
            d.volatility_reference = r.gen_range(0..max_va);
            d.volatility_accumulator = r.gen_range(d.volatility_reference..=max_va);
            d.tick_spacing_index_reference = d.tick_spacing_index_reference + r.gen_range(-5..5);
            d.last_update_timestamp = (block_ts as u64).saturating_sub(r.gen_range(0..(decay as u64) * 2));
            p.dynamic_fee_info = d;
        }
        // positions, then resting orders, onto one map of prices
        let mut ticks: BTreeMap<i32, TickState> = BTreeMap::new();
        let base = tick_current.div_euclid(sp) * sp;
        let mut liquidity: u128 = 0;
        for _ in 0..r.gen_range(1..7) {
            let lo = base + sp * r.gen_range(-300..60);
            let hi = lo + sp * r.gen_range(1..400);
            let (lo, hi) = (lo.max(-443520 / sp * sp), hi.min(443520 / sp * sp));
            if lo >= hi {
                continue;
            }
            let l = (1u128 << r.gen_range(40..90)) + r.gen_range(0..(1u128 << 40));
            for (t, net) in [(lo, l as i128), (hi, -(l as i128))] {
                let e = ticks.entry(t).or_insert_with(|| {
                    let mut x = TickState::default();
                    x.tick = t;
                    x
                });
                e.liquidity_gross += l;
                e.liquidity_net += net;
            }
            if lo <= tick_current && tick_current < hi {
                liquidity += l;
            }
        }
        if r.gen_bool(0.5) {
            for _ in 0..r.gen_range(1..4) {
                let t = base + sp * r.gen_range(-40..40);
                let e = ticks.entry(t).or_insert_with(|| {
                    let mut x = TickState::default();
                    x.tick = t;
                    x
                });
                e.orders_amount = wide(&mut r, 56) as u64;
                if r.gen_bool(0.4) {
                    e.part_filled_orders_remaining = wide(&mut r, 50) as u64;
                    e.unfilled_ratio_x64 = r.gen_range(1..fixed_point_64::Q64);
                    e.order_phase = r.gen_range(1..20);
                }
            }
        }
        pool.borrow_mut().liquidity = liquidity;
        let pool_key = pool.borrow().key();
        let ext_info = build_tick_array_bitmap_extension_info(pool_key);
        let mut bands: BTreeMap<i32, Vec<TickState>> = BTreeMap::new();
        for (t, st) in &ticks {
            if st.liquidity_gross == 0 && st.orders_amount == 0 && st.part_filled_orders_remaining == 0 {
                continue;
            }
            bands.entry(TickArrayState::get_array_start_index(*t, spacing)).or_default().push(*st);
        }
        for start in bands.keys() {
            pool.borrow_mut().flip_tick_array_bit(Some(ext_info), *start).unwrap();
        }
        let zfo = r.gen_bool(0.5);
        let base_in = r.gen_bool(0.5);
        let amount = wide(&mut r, 64).max(1) as u64;
        let limit = if r.gen_bool(0.6) {
            if zfo { tick_math::MIN_SQRT_PRICE_X64 + 1 } else { tick_math::MAX_SQRT_PRICE_X64 - 1 }
        } else {
            let t = tick_current + if zfo { -r.gen_range(0..20_000) } else { r.gen_range(1..20_000) };
            tick_math::get_sqrt_price_at_tick(t.clamp(tick_math::MIN_TICK + 1, tick_math::MAX_TICK - 1)).unwrap()
        };
        let cfg = AmmConfig {
            trade_fee_rate: [100, 2500, 10000, 40000][r.gen_range(0..4)],
            protocol_fee_rate: [0, 120_000, 160_000][r.gen_range(0..3)],
            fund_fee_rate: [0, 40_000][r.gen_range(0..2)],
            tick_spacing: spacing,
            ..Default::default()
        };

        // what the quote is given, before the swap changes it
        let p0 = pool.borrow();
        let bitmap_words = p0.tick_array_bitmap;
        let bitmap_bits: Vec<String> = (0..1024).filter(|i| bitmap_words[i / 64] >> (i % 64) & 1 == 1).map(|i| i.to_string()).collect();
        let d = p0.dynamic_fee_info;
        let dyn_json = if dynamic {
            format!(
                "[{},{},{},{},{},{},{},{},{}]",
                { d.filter_period }, { d.decay_period }, { d.reduction_factor }, { d.dynamic_fee_control }, { d.max_volatility_accumulator },
                { d.tick_spacing_index_reference }, { d.volatility_reference }, { d.volatility_accumulator }, { d.last_update_timestamp }
            )
        } else {
            "null".to_string()
        };
        let (pb0, pb1, fb0, fb1) = (p0.protocol_fees_token_0, p0.protocol_fees_token_1, p0.fund_fees_token_0, p0.fund_fees_token_1);
        drop(p0);
        let ext_loaded = AccountLoader::<TickArrayBitmapExtension>::try_from(ext_info).unwrap();
        let (pos_maps, neg_maps) = {
            let e = ext_loaded.load().unwrap();
            (e.positive_tick_array_bitmap, e.negative_tick_array_bitmap)
        };
        let bits_of = |w: &[u64; 8]| format!("[{}]", (0..512).filter(|i| w[i / 64] >> (i % 64) & 1 == 1).map(|i| i.to_string()).collect::<Vec<_>>().join(","));
        let ext_json = format!(
            "[[{}],[{}]]",
            pos_maps.iter().map(bits_of).collect::<Vec<_>>().join(","),
            neg_maps.iter().map(bits_of).collect::<Vec<_>>().join(",")
        );
        let ticks_json: Vec<String> = bands
            .values()
            .flatten()
            .map(|t| {
                format!(
                    "[{},{},{},{},{},{},{}]",
                    { t.tick }, q({ t.liquidity_net }), q({ t.liquidity_gross }), q({ t.orders_amount }),
                    q({ t.part_filled_orders_remaining }), q({ t.unfilled_ratio_x64 }), q({ t.order_phase })
                )
            })
            .collect();

        // the bands in walking order: the program skips any it does not need
        let mut order: Vec<i32> = bands.keys().copied().collect();
        if zfo {
            order.reverse();
        }
        let cells: Vec<RefCell<TickArrayState>> = order.iter().map(|s| build_tick_array_with_tick_states(pool_key, *s, spacing, bands[s].clone())).collect();
        let mut deque: VecDeque<_> = cells.iter().map(|c| c.borrow_mut()).collect();
        let obs = RefCell::new(ObservationState::default());
        obs.borrow_mut().pool_id = pool_key;
        let res = {
            let mut p = pool.borrow_mut();
            let mut o = obs.borrow_mut();
            outcome(
                || swap_internal(&cfg, &mut p, &mut deque, &mut o, Some(ext_info), amount, limit, zfo, base_in, block_ts),
                |v| format!("[{},{},{},{},{},{},{}]", q(v.amount_0), q(v.amount_1), q(v.trade_fee_0), q(v.trade_fee_1), q(v.sqrt_price_x64), q(v.liquidity), v.tick),
            )
        };
        drop(deque);
        let p1 = pool.borrow();
        let fees = format!(
            "[{},{},{},{}]",
            q({ p1.protocol_fees_token_0 }.wrapping_sub(pb0)), q({ p1.protocol_fees_token_1 }.wrapping_sub(pb1)),
            q({ p1.fund_fees_token_0 }.wrapping_sub(fb0)), q({ p1.fund_fees_token_1 }.wrapping_sub(fb1))
        );
        let _ = write!(
            out,
            "{}{{\"spacing\":{},\"tick\":{},\"sqrt\":{},\"liquidity\":{},\"feeOn\":{},\"bitmap\":[{}],\"ext\":{},\"dyn\":{},\"cfg\":[{},{},{}],\"ticks\":[{}],\"zfo\":{},\"baseIn\":{},\"amount\":{},\"limit\":{},\"ts\":{},\"out\":{},\"feesAfter\":{}}}",
            if case > 0 { "," } else { "" },
            spacing, tick_current, q(sqrt), q(liquidity), fee_on, bitmap_bits.join(","), ext_json, dyn_json,
            { cfg.trade_fee_rate }, { cfg.protocol_fee_rate }, { cfg.fund_fee_rate }, ticks_json.join(","),
            zfo, base_in, q(amount), q(limit), block_ts, res, fees
        );
    }
    out.push_str("],\n");

    // rewards: the pool's counters brought to a clock, growth inside a range, then what a
    // position is owed once changed. Its own seed, so every section above stays as it was.
    let mut r = StdRng::seed_from_u64(20261024);
    out.push_str("\"rewards\":[");
    for case in 0..500 {
        let mut pool = PoolState::default();
        pool.liquidity = match r.gen_range(0..6) { 0 => 0, 1 => r.gen_range(1..1000), _ => wide(&mut r, 100) };
        let base: u64 = 1_700_000_000;
        let mut infos = [RewardInfo::default(); REWARD_NUM];
        for info in infos.iter_mut() {
            if r.gen_bool(0.2) {
                continue;
            }
            let open = base + r.gen_range(0..1000);
            let end = open + r.gen_range(1..200_000);
            info.token_mint = Pubkey::new_unique();
            info.open_time = open;
            info.end_time = end;
            info.last_update_time = match r.gen_range(0..3) { 0 => open, 1 => r.gen_range(open..=end), _ => end };
            info.emissions_per_second_x64 = match r.gen_range(0..4) { 0 => r.gen_range(1..10_000_000u128) << 64, 1 => wide(&mut r, 128), _ => wide(&mut r, 96) };
            info.reward_total_emitted = match r.gen_range(0..6) { 0 => u64::MAX, 1 => u64::MAX - r.gen_range(0..1_000_000u64), _ => wide(&mut r, 60) as u64 };
            info.reward_growth_global_x64 = wide(&mut r, 128);
            info.reward_state = r.gen_range(0..4);
        }
        pool.reward_infos = infos;
        let now = match r.gen_range(0..8) {
            0 => { infos[0].open_time }
            1 => { infos[0].end_time }
            2 => { infos[0].last_update_time }
            _ => base + r.gen_range(0..250_000),
        };
        let mut lo = TickState::default();
        let mut hi = TickState::default();
        lo.tick = r.gen_range(-1000..1000);
        hi.tick = lo.tick + r.gen_range(1..500);
        let cur = r.gen_range(lo.tick - 300..hi.tick + 300);
        pool.tick_current = cur;
        lo.reward_growths_outside_x64 = [wide(&mut r, 128), wide(&mut r, 128), wide(&mut r, 128)];
        hi.reward_growths_outside_x64 = [wide(&mut r, 128), wide(&mut r, 128), wide(&mut r, 128)];
        let before: Vec<String> = infos
            .iter()
            .map(|i| format!("[{},{},{},{},{},{},{},{}]", i.initialized(), { i.reward_state }, { i.open_time }, { i.end_time }, { i.last_update_time }, q({ i.emissions_per_second_x64 }), q({ i.reward_total_emitted }), q({ i.reward_growth_global_x64 })))
            .collect();
        let updated = pool.update_reward_infos(now).unwrap();
        let after: Vec<String> = updated
            .iter()
            .map(|i| format!("[{},{},{},{}]", { i.reward_state }, { i.last_update_time }, q({ i.reward_total_emitted }), q({ i.reward_growth_global_x64 })))
            .collect();
        let inside = get_reward_growths_inside(&lo, &hi, cur, &updated);
        let mut pos = PersonalPositionState::default();
        pos.liquidity = match r.gen_range(0..5) { 0 => 0, 1 => r.gen_range(1..1_000_000_000u128), _ => wide(&mut r, 100) };
        for i in 0..REWARD_NUM {
            pos.reward_infos[i].growth_inside_last_x64 = if r.gen_bool(0.7) { inside[i].wrapping_sub(wide(&mut r, 70)) } else { wide(&mut r, 128) };
            pos.reward_infos[i].reward_amount_owed = match r.gen_range(0..5) { 0 => u64::MAX - r.gen_range(0..1000u64), _ => wide(&mut r, 50) as u64 };
        }
        let position: Vec<String> = pos.reward_infos.iter().map(|x| format!("[{},{}]", q(x.growth_inside_last_x64), q(x.reward_amount_owed))).collect();
        let pos_liquidity = pos.liquidity;
        let owed = outcome(
            move || {
                pos.decrease_liquidity(0, 0, 0, inside, 0)?;
                Ok(pos.reward_infos.map(|x| x.reward_amount_owed))
            },
            |v| format!("[{},{},{}]", q(v[0]), q(v[1]), q(v[2])),
        );
        let _ = write!(
            out,
            "{}{{\"liquidity\":{},\"tick\":{},\"now\":{},\"rewards\":[{}],\"lower\":[{},[{},{},{}]],\"upper\":[{},[{},{},{}]],\"position\":[{},[{}]],\"after\":[{}],\"inside\":[{},{},{}],\"owed\":{}}}",
            if case > 0 { "," } else { "" },
            q({ pool.liquidity }), cur, now, before.join(","),
            { lo.tick }, q({ lo.reward_growths_outside_x64 }[0]), q({ lo.reward_growths_outside_x64 }[1]), q({ lo.reward_growths_outside_x64 }[2]),
            { hi.tick }, q({ hi.reward_growths_outside_x64 }[0]), q({ hi.reward_growths_outside_x64 }[1]), q({ hi.reward_growths_outside_x64 }[2]),
            q(pos_liquidity), position.join(","), after.join(","), q(inside[0]), q(inside[1]), q(inside[2]), owed
        );
    }
    out.push_str("]\n}\n");

    let path = std::env::var("VECTORS_OUT").unwrap_or_else(|_| "vectors.json".to_string());
    std::fs::write(path, out).unwrap();
}
