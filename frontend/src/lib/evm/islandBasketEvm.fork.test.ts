// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http, parseEther, type Chain } from 'viem';
import { base, mainnet } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ERC20_ABI } from '../contracts';
import { swapVenueOn } from '../chains/swapVenue';
import { EVM_BASKET, minOut, splitEvenly } from '../islandBasket';
import { buildEvmOrder, quoteEvmLegs, routeEvmLeg, type QuoteClient } from './islandBasketEvm';

/**
 * The island order, SENT on a fork of the real chain: opt-in, never in CI. Start a fork
 * and point the test at it, e.g.
 *   anvil --fork-url https://mainnet.base.org --port 18545
 *   ISLAND_FORK_BASE=http://127.0.0.1:18545 npx vitest run src/lib/evm/islandBasketEvm.fork.test.ts
 * (ISLAND_FORK_ETH for an Ethereum fork.) A fresh random wallet is funded: anvil's own
 * test accounts carry a sweeper on real-chain forks.
 */
const FORKS: { name: string; url: string | undefined; chain: Chain; coins: typeof EVM_BASKET.base }[] = [
  { name: 'Base', url: process.env.ISLAND_FORK_BASE, chain: base, coins: EVM_BASKET.base },
  { name: 'Ethereum', url: process.env.ISLAND_FORK_ETH, chain: mainnet, coins: EVM_BASKET.ethereum },
];

for (const f of FORKS) {
  describe.runIf(Boolean(f.url))(`island order on a ${f.name} fork`, () => {
    const setup = async () => {
      const transport = http(f.url);
      const pub = createPublicClient({ chain: f.chain, transport });
      const account = privateKeyToAccount(generatePrivateKey());
      await pub.request({ method: 'anvil_setBalance' as never, params: [account.address, '0xDE0B6B3A7640000'] as never });
      const wallet = createWalletClient({ chain: f.chain, transport, account });
      const venue = swapVenueOn(f.chain.id)!;
      const client: QuoteClient = {
        readContract: (a) => pub.readContract(a as never) as Promise<unknown>,
        simulateContract: (a) => pub.simulateContract(a as never) as Promise<{ result: unknown }>,
      };
      const shares = splitEvenly(parseEther('0.01'), f.coins.length)!;
      const legs = f.coins.map((coin, i) => ({ coin, amountIn: shares[i]! }));
      const quotes = await quoteEvmLegs(client, venue, legs);
      const routes = quotes.map((q) => routeEvmLeg(q, f.chain.id));
      const block = await pub.getBlock();
      return { pub, wallet, account, venue, quotes, routes, deadline: block.timestamp + 600n };
    };
    const balances = (pub: ReturnType<typeof createPublicClient>, who: `0x${string}`) =>
      Promise.all(f.coins.map((c) => pub.readContract({ address: c.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [who] }) as Promise<bigint>));

    it('buys every coin, each at or above its floor, and leaves no ETH in the router', async () => {
      const { pub, wallet, account, venue, quotes, routes, deadline } = await setup();
      for (const r of routes) expect(r.via).not.toBe('none');
      const order = buildEvmOrder({ venue, quotes, routes, recipient: account.address, slippageBps: 100, deadline })!;
      expect(order).not.toBeNull();
      const before = await balances(pub, account.address);
      for (const tx of order) {
        const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
        const receipt = await pub.waitForTransactionReceipt({ hash });
        expect(receipt.status).toBe('success');
        if (tx.kind === 'batch') expect(await pub.getBalance({ address: tx.to })).toBe(0n);
      }
      const after = await balances(pub, account.address);
      routes.forEach((r, i) => {
        const got = after[i]! - before[i]!;
        const floor = r.via === 'none' ? null : minOut(r.out, 100);
        expect(floor).not.toBeNull();
        expect(got >= floor!).toBe(true);
      });
      // What each coin went through, for the record.
      console.log(f.name, routes.map((r, i) => `${f.coins[i]!.symbol}:${r.via}${r.via === 'batch' || r.via === 'v2-router' ? `/${r.pool.dex}` : ''}`).join(' '), order.map((t) => t.kind).join('+'));
    }, 120_000);

    it.runIf(f.chain.id === mainnet.id)('sends a coin our pool takes through SwapFeeRouter, as its own transaction', async () => {
      const { pub, wallet, account, venue, quotes, routes, deadline } = await setup();
      // TOWELI has a pair on our factory: route it there whatever the quotes say, to prove the leg.
      const k = quotes.findIndex((q) => q.ours !== null);
      expect(k).toBeGreaterThanOrEqual(0);
      const forced = routes.map((r, i) => (i === k ? { via: 'ours' as const, out: quotes[k]!.ours!.out } : r));
      const order = buildEvmOrder({ venue, quotes, routes: forced, recipient: account.address, slippageBps: 100, deadline })!;
      const ours = order.find((t) => t.kind === 'ours')!;
      expect(ours.to).toBe(venue.swapFeeRouter);
      expect(ours.legs).toEqual([k]);
      const before = await balances(pub, account.address);
      const hash = await wallet.sendTransaction({ to: ours.to, data: ours.data, value: ours.value });
      expect((await pub.waitForTransactionReceipt({ hash })).status).toBe('success');
      const after = await balances(pub, account.address);
      expect(after[k]! - before[k]! >= minOut(quotes[k]!.ours!.out, 100)!).toBe(true);
    }, 120_000);

    it('buys nothing when one coin cannot meet its floor: the batch is all or nothing', async () => {
      const { pub, wallet, account, venue, quotes, routes, deadline } = await setup();
      // Promise one batch coin 20% more than its pool pays: its floor cannot be met.
      const k = routes.findIndex((r) => r.via === 'batch');
      expect(k).toBeGreaterThanOrEqual(0);
      const lied = routes.map((r, i) => (i === k && r.via === 'batch' ? { ...r, out: (r.out * 12n) / 10n } : r));
      const order = buildEvmOrder({ venue, quotes, routes: lied, recipient: account.address, slippageBps: 100, deadline })!;
      const batch = order.find((t) => t.kind === 'batch')!;
      const before = await balances(pub, account.address);
      await expect(pub.estimateGas({ account: account.address, to: batch.to, data: batch.data, value: batch.value })).rejects.toThrow();
      const hash = await wallet.sendTransaction({ to: batch.to, data: batch.data, value: batch.value, gas: 3_000_000n });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('reverted');
      const after = await balances(pub, account.address);
      batch.legs.forEach((i) => expect(after[i]).toBe(before[i]));
    }, 120_000);
  });
}
