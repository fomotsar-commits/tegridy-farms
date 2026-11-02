/**
 * The four NFT-finance addresses below are wired. If any regresses to 0x0 the
 * app has a real problem, and the "not deployed" copy sitting in its fallback
 * branch becomes reachable again. That is fine, but it must be a deliberate
 * change, not a silent one.
 */
import { describe, it, expect } from 'vitest';
import {
  PREMIUM_ACCESS_ADDRESS,
  TEGRIDY_NFT_LENDING_ADDRESS,
  TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
  TEGRIDY_LAUNCHPAD_V2_ADDRESS,
  isDeployed,
} from '../lib/constants';

describe('deployment states are not collapsed into each other', () => {
  it.each([
    ['PremiumAccess (Gold Card)', PREMIUM_ACCESS_ADDRESS],
    ['NFT lending', TEGRIDY_NFT_LENDING_ADDRESS],
    ['NFT pool factory', TEGRIDY_NFT_POOL_FACTORY_ADDRESS],
    ['LaunchpadV2', TEGRIDY_LAUNCHPAD_V2_ADDRESS],
  ])('%s is wired, so its "not deployed" branch stays unreachable', (_label, addr) => {
    expect(isDeployed(addr)).toBe(true);
  });
});
