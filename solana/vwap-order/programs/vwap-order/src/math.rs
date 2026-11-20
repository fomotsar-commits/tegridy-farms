//! The order's arithmetic, with no dependencies, so it is proven under a bare
//! `rustc --edition 2021 --test src/math.rs` (bayla-ladder's way).

/// Window `k` of an order is `[start + k * interval, start + (k + 1) * interval)`.
/// The window `now` falls in, or `None` before the first or after the last.
pub fn window_at(now: i64, start: i64, interval: i64, slices: u8) -> Option<u8> {
    if now < start || interval <= 0 {
        return None;
    }
    let k = (now - start) / interval;
    if k < slices as i64 {
        Some(k as u8)
    } else {
        None
    }
}

/// Slice `k`'s share of `total`, by the weights. The shares telescope, so all of them
/// together are exactly `total` and none depends on which ran. Zero weights total 0.
pub fn slice_amount(total: u64, weights: &[u16], k: usize) -> u64 {
    let sum: u128 = weights.iter().map(|w| *w as u128).sum();
    if sum == 0 || k >= weights.len() {
        return 0;
    }
    let before: u128 = weights[..k].iter().map(|w| *w as u128).sum();
    let through = before + weights[k] as u128;
    let t = total as u128;
    // t * sum < 2^64 * 2^16 * 2^8, so neither product can overflow u128.
    ((t * through / sum) - (t * before / sum)) as u64
}

/// The least a slice of `slice_in` may get at the person's own worst price,
/// `min_out_total` for `total_in`, rounded up (in the person's favour).
pub fn limit_floor(min_out_total: u64, slice_in: u64, total_in: u64) -> Option<u64> {
    if total_in == 0 {
        return None;
    }
    let n = (min_out_total as u128).checked_mul(slice_in as u128)?;
    let d = total_in as u128;
    let q = n.div_ceil(d);
    u64::try_from(q).ok()
}

/// The least a slice of `slice_in` may get against the pool's own average price over the
/// last `d_t` seconds: `d_cum / d_t` is that price in Q32.32 (output units per input unit,
/// the pool's observation format), less `band_bps` hundredths of a percent. Rounded down.
pub fn twap_floor(slice_in: u64, d_cum: u128, d_t: u64, band_bps: u16) -> Option<u64> {
    if d_t == 0 || band_bps as u128 > 10_000 {
        return None;
    }
    let price_x32 = d_cum / d_t as u128;
    let out_x32 = price_x32.checked_mul(slice_in as u128)?;
    let kept = out_x32.checked_mul(10_000 - band_bps as u128)? / 10_000;
    u64::try_from(kept >> 32).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_cover_start_to_end_and_nothing_outside() {
        assert_eq!(window_at(999, 1_000, 600, 4), None);
        assert_eq!(window_at(1_000, 1_000, 600, 4), Some(0));
        assert_eq!(window_at(1_599, 1_000, 600, 4), Some(0));
        assert_eq!(window_at(1_600, 1_000, 600, 4), Some(1));
        assert_eq!(window_at(3_399, 1_000, 600, 4), Some(3));
        assert_eq!(window_at(3_400, 1_000, 600, 4), None);
        assert_eq!(window_at(1_000, 1_000, 0, 4), None);
    }

    #[test]
    fn equal_weights_split_evenly_and_the_shares_add_up_exactly() {
        let w = [1u16; 7];
        let shares: Vec<u64> = (0..7).map(|k| slice_amount(1_000, &w, k)).collect();
        assert_eq!(shares.iter().sum::<u64>(), 1_000);
        assert!(shares.iter().all(|s| *s == 142 || *s == 143));
    }

    #[test]
    fn volume_weights_follow_the_day_and_still_add_up() {
        // A quiet night, a busy afternoon.
        let w = [1u16, 1, 4, 10, 4];
        let shares: Vec<u64> = (0..5).map(|k| slice_amount(2_000_000, &w, k)).collect();
        assert_eq!(shares, vec![100_000, 100_000, 400_000, 1_000_000, 400_000]);
        assert_eq!(shares.iter().sum::<u64>(), 2_000_000);
    }

    #[test]
    fn a_zero_weight_is_an_empty_window_and_the_largest_order_cannot_overflow() {
        assert_eq!(slice_amount(5, &[0, 3, 0], 0), 0);
        assert_eq!(slice_amount(5, &[0, 3, 0], 1), 5);
        assert_eq!(slice_amount(5, &[0, 0, 0], 1), 0);
        let w = [u16::MAX; 96];
        let all: u128 = (0..96).map(|k| slice_amount(u64::MAX, &w, k) as u128).sum();
        assert_eq!(all, u64::MAX as u128);
    }

    #[test]
    fn the_limit_rounds_up_so_the_person_never_gets_a_unit_less() {
        assert_eq!(limit_floor(1_000, 250, 1_000), Some(250));
        assert_eq!(limit_floor(1_000, 1, 3), Some(334));
        assert_eq!(limit_floor(u64::MAX, u64::MAX, u64::MAX), Some(u64::MAX));
        assert_eq!(limit_floor(1, 1, 0), None);
    }

    #[test]
    fn the_twap_floor_is_the_average_price_less_the_band() {
        // A price of 2.0 out per in (Q32.32) held for 600 seconds.
        let d_cum = (2u128 << 32) * 600;
        assert_eq!(twap_floor(1_000, d_cum, 600, 0), Some(2_000));
        assert_eq!(twap_floor(1_000, d_cum, 600, 150), Some(1_970));
        assert_eq!(twap_floor(1_000, d_cum, 600, 10_000), Some(0));
        assert_eq!(twap_floor(1_000, d_cum, 0, 150), None);
        assert_eq!(twap_floor(1_000, d_cum, 600, 10_001), None);
        // A price below one unit: 0.005 out per in.
        let d_cum = ((5u128 << 32) / 1_000) * 300;
        assert_eq!(twap_floor(1_000_000, d_cum, 300, 0), Some(4_999));
    }
}
