import { test, expect, devices } from '@playwright/test';
import { coldArrival, ROOM_ROUTES, SAMPLE_MS, summarize, type Arrival } from '../e2e/fixtures/roomArrival';
import { DOOR_ROUTES } from '../e2e/fixtures/doorFrame';

// A ROOM OPENS ONCE, ON ITS HERO, walked against a deployed origin.
//
//   ROOM_ARRIVALS=10 npx playwright test --config=playwright.prod.config.ts e2e-prod/room-arrival.spec.ts
//
// A real cold visitor per arrival: a new context, service workers allowed, no
// reduced motion. Asserts one document and scrollY 0 at 1, 3 and 7 s, and the H1 in
// the viewport at 3 and 7 s, and at 1 s on a door with its own HTML.

const ARRIVALS = Number(process.env.ROOM_ARRIVALS ?? 10);

const CLASSES = {
  phone: devices['Pixel 5'],
  desktop: devices['Desktop Chrome'],
} as const;

for (const [klass, device] of Object.entries(CLASSES)) {
  for (const route of ROOM_ROUTES) {
    test(`${klass} ${route}: ${ARRIVALS} cold arrivals, one document each, on the hero`, async ({ browser }, info) => {
      test.setTimeout(60_000 + ARRIVALS * 25_000);
      const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = device;
      const arrivals: Arrival[] = [];
      for (let i = 0; i < ARRIVALS; i++) {
        const a = await coldArrival(
          browser,
          { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL: info.project.use.baseURL },
          route,
        );
        arrivals.push(a);
        expect.soft(a.loads, `${route} #${i + 1}: documents loaded`).toBe(1);
        expect.soft(a.documents, `${route} #${i + 1}: document requests`).toBe(1);
        for (const ms of SAMPLE_MS) {
          expect.soft(a.at[ms]?.y, `${route} #${i + 1}: scrollY at ${ms} ms`).toBe(0);
          if (ms >= 3000 || DOOR_ROUTES.includes(route)) expect.soft(a.at[ms]?.h1InView, `${route} #${i + 1}: H1 in view at ${ms} ms`).toBe(true);
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      console.log(summarize(`${klass} ${route}`, arrivals));
      await info.attach('arrivals', { body: JSON.stringify(arrivals, null, 2), contentType: 'application/json' });
    });
  }
}
