import { MIN_LOCK_DURATION, MAX_LOCK_DURATION, MIN_BOOST_BPS, MAX_BOOST_BPS } from './constants';

export function calculateBoost(durationSec: number): number {
  if (durationSec <= MIN_LOCK_DURATION) return MIN_BOOST_BPS;
  if (durationSec >= MAX_LOCK_DURATION) return MAX_BOOST_BPS;
  const range = MAX_LOCK_DURATION - MIN_LOCK_DURATION;
  const boostRange = MAX_BOOST_BPS - MIN_BOOST_BPS;
  const elapsed = durationSec - MIN_LOCK_DURATION;
  return MIN_BOOST_BPS + (elapsed * boostRange) / range;
}
