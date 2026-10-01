import type { Page } from '@playwright/test';
import { DOORS } from '../../scripts/render-bungalow-doors.mjs';

/** Every door the build writes its own HTML for, as a route: '/bayla', '/pepe', ... */
export const DOOR_ROUTES: readonly string[] = DOORS.map((d: { path: string }) => `/${d.path}`);

/** The heading a door's static frame, its React fallback and its hero all read. */
export function doorHeading(route: string): string {
  const door = DOORS.find((d: { path: string }) => `/${d.path}` === route);
  if (!door) throw new Error(`${route} is not a door with its own HTML`);
  return `${door.heroTitle} ${door.heroLine}`;
}

/** The phone the island measures on: 150 ms round trip, 1.6 Mbps down, CPU 4x. Chromium only. */
export async function phoneThrottle(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}
