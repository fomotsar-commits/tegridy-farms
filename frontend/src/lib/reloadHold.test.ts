import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { waitForTransactionReceiptQueryKey } from 'wagmi/query';
import { addReloadProbe, holdReload, holdReloadWhileWalletWorks, reloadHeld } from './reloadHold';

const undo: Array<() => void> = [];
afterEach(() => {
  for (const u of undo.splice(0)) u();
});

describe('reloadHold', () => {
  it('nothing held: a reload is free to happen', () => {
    expect(reloadHeld()).toBe(false);
  });

  it('is held until the LAST hold is released, and a release counts once', () => {
    const first = holdReload();
    const second = holdReload();
    undo.push(first, second);
    expect(reloadHeld()).toBe(true);
    first();
    first(); // a second call must not release the other flow's hold
    expect(reloadHeld()).toBe(true);
    second();
    expect(reloadHeld()).toBe(false);
  });

  it('a probe that reads work in flight holds, and stops holding when removed', () => {
    let open = true;
    const remove = addReloadProbe(() => open);
    undo.push(remove);
    expect(reloadHeld()).toBe(true);
    open = false;
    expect(reloadHeld()).toBe(false);
    open = true;
    remove();
    expect(reloadHeld()).toBe(false);
  });

  it('a probe that cannot answer counts as held', () => {
    undo.push(
      addReloadProbe(() => {
        throw new Error('the record could not be read');
      }),
    );
    expect(reloadHeld()).toBe(true);
  });
});

// How the EVM swap and liquidity flows mark a transaction: useWriteContract's isPending
// (a mutation on the app's query client) and useWaitForTransactionReceipt's isLoading (a
// query under wagmi's own key). The client is real and the key is wagmi's export, so a
// wagmi that renames it fails here.
describe('holdReloadWhileWalletWorks', () => {
  const HASH = `0x${'ab'.repeat(32)}` as const;
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    undo.push(holdReloadWhileWalletWorks(client), () => client.clear());
  });

  it('nothing open at the wallet: free', () => {
    expect(reloadHeld()).toBe(false);
  });

  it('a write waiting on the wallet holds, and stops holding when the wallet answers', async () => {
    let answer: (hash: string) => void = () => undefined;
    const write = new MutationObserver(client, { mutationFn: () => new Promise<string>((r) => (answer = r)) });
    const done = write.mutate();
    await vi.waitFor(() => expect(client.isMutating()).toBe(1));
    expect(reloadHeld()).toBe(true);
    answer(HASH);
    await done;
    expect(reloadHeld()).toBe(false);
  });

  it('a write the wallet refuses stops holding', async () => {
    const write = new MutationObserver(client, { mutationFn: () => Promise.reject(new Error('User rejected the request.')) });
    await write.mutate().catch(() => undefined);
    expect(reloadHeld()).toBe(false);
  });

  it('a sent transaction holds until its receipt is read', async () => {
    let land: (receipt: { status: string }) => void = () => undefined;
    const wait = client.fetchQuery({
      queryKey: waitForTransactionReceiptQueryKey({ chainId: 1, hash: HASH }),
      queryFn: () => new Promise<{ status: string }>((r) => (land = r)),
    });
    await vi.waitFor(() => expect(client.isFetching()).toBe(1));
    expect(reloadHeld()).toBe(true);
    land({ status: 'success' });
    await wait;
    expect(reloadHeld()).toBe(false);
  });

  it('an ordinary chain read in flight does not hold: only work the wallet was asked for', async () => {
    let answer: (v: bigint) => void = () => undefined;
    const read = client.fetchQuery({ queryKey: ['readContract', { functionName: 'balanceOf' }], queryFn: () => new Promise<bigint>((r) => (answer = r)) });
    await vi.waitFor(() => expect(client.isFetching()).toBe(1));
    expect(reloadHeld()).toBe(false);
    answer(1n);
    await read;
  });

  it('App.tsx hands the client every wagmi hook uses to it', () => {
    const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8');
    expect(app).toMatch(/<QueryClientProvider client=\{queryClient\}>/);
    expect(app).toMatch(/^holdReloadWhileWalletWorks\(queryClient\);$/m);
  });
});
