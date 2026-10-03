// A live venue with no network, for specs that need /solana-lp or /pools past the venue
// read: /api/solrpc answers the pool program and its two fee tiers from made-up accounts
// in the app's own layout, and aborts every other call, as a proxy that cannot reach
// Solana does. So the LP section mounts and its fee tiers read on every machine.
import type { Page } from '@playwright/test';
import { LIVE_PROGRAM_ID, deriveAmmConfig } from '../../src/lib/solana/cpswap/program';
import { configBytes } from '../../src/lib/solana/lp/testkit.fixture';

// Not the upgradeable loader, so the executable flag alone settles "deployed" (readDeployment).
const LOADER = 'BPFLoader2111111111111111111111111111111111';

type Call = { id?: unknown; method?: unknown; params?: unknown[] };

export async function playLiveVenue(page: Page): Promise<{ answered: string[] }> {
  if (!LIVE_PROGRAM_ID) throw new Error('playLiveVenue: this checkout has no pool program id');
  const program = LIVE_PROGRAM_ID.toBase58();
  const b64 = (d: Uint8Array) => Buffer.from(d).toString('base64');
  const tier = (index: number, tradeFeeRate: bigint) =>
    ({ data: [b64(configBytes(index, tradeFeeRate, 120_000n)), 'base64'], owner: program, executable: false, lamports: 1 });
  const accounts: Record<string, unknown> = {
    [program]: { data: ['', 'base64'], owner: LOADER, executable: true, lamports: 1 },
    [deriveAmmConfig(LIVE_PROGRAM_ID, 0).toBase58()]: tier(0, 2_500n),
    [deriveAmmConfig(LIVE_PROGRAM_ID, 1).toBase58()]: tier(1, 10_000n),
  };
  const result = (c: Call): unknown => {
    const first = c.params?.[0];
    if (c.method === 'getAccountInfo' && typeof first === 'string' && first in accounts) {
      return { context: { slot: 1 }, value: accounts[first] };
    }
    if (c.method === 'getMultipleAccounts' && Array.isArray(first) && first.every((a) => String(a) in accounts)) {
      return { context: { slot: 1 }, value: first.map((a) => accounts[String(a)]) };
    }
    return undefined;
  };

  const answered: string[] = [];
  await page.route('**/api/solrpc', (route) => {
    let body: unknown = null;
    try { body = route.request().postDataJSON(); } catch { /* not JSON: aborted below */ }
    const calls = (Array.isArray(body) ? body : [body]) as Call[];
    const results = calls.map((c) => (c ? result(c) : undefined));
    if (results.some((r) => r === undefined)) return route.abort();
    answered.push(...calls.map((c) => String(c.method)));
    const replies = calls.map((c, i) => ({ jsonrpc: '2.0', id: c.id, result: results[i] }));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(Array.isArray(body) ? replies : replies[0]),
    });
  });
  return { answered };
}
