import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('analytics', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_ANALYTICS_ENDPOINT', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function getModule() {
    return await import('./analytics');
  }

  it('generates a session ID and stores it in sessionStorage', async () => {
    await getModule();
    const id = sessionStorage.getItem('tegridy_session_id');
    expect(id).toBeTruthy();
    // UUID v4 format
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('reuses existing session ID from sessionStorage', async () => {
    sessionStorage.setItem('tegridy_session_id', 'existing-id-123');
    const mod = await getModule();
    // track an event and check the sessionId used
    mod.track('test_event');
    vi.advanceTimersByTime(11_000);
    expect(console.log).toHaveBeenCalled();
    const call = (console.log as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === '[analytics]' && c[1] === 'test_event',
    );
    expect(call).toBeTruthy();
  });

  it('track() queues an event and flushes to console in dev mode', async () => {
    const { track } = await getModule();
    track('page_load', { page: '/swap' });
    vi.advanceTimersByTime(11_000);
    expect(console.log).toHaveBeenCalledWith(
      '[analytics]',
      'page_load',
      expect.objectContaining({ page: '/swap' }),
    );
  });

  it('track() includes timestamp in ISO format', async () => {
    const { track } = await getModule();
    track('click', { target: 'button' });
    vi.advanceTimersByTime(11_000);
    const call = (console.log as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[1] === 'click',
    );
    expect(call).toBeTruthy();
  });

  it('trackSwap logs swap event with correct properties', async () => {
    const { trackSwap } = await getModule();
    trackSwap('ETH', 'TOWELI', '1.5', 'uniswap-v3');
    vi.advanceTimersByTime(11_000);
    expect(console.log).toHaveBeenCalledWith(
      '[analytics]',
      'swap',
      expect.objectContaining({
        fromToken: 'ETH',
        toToken: 'TOWELI',
        amount: '1.5',
        route: 'uniswap-v3',
      }),
    );
  });

  it('trackStake logs stake event', async () => {
    const { trackStake } = await getModule();
    trackStake('100', 30);
    vi.advanceTimersByTime(11_000);
    expect(console.log).toHaveBeenCalledWith(
      '[analytics]',
      'stake',
      expect.objectContaining({ amount: '100', lockDuration: 30 }),
    );
  });

  it('trackUnstake logs unstake event', async () => {
    const { trackUnstake } = await getModule();
    trackUnstake('50');
    vi.advanceTimersByTime(11_000);
    expect(console.log).toHaveBeenCalledWith(
      '[analytics]',
      'unstake',
      expect.objectContaining({ amount: '50' }),
    );
  });

  it('trackNFTPurchase logs nft_purchase event', async () => {
    const { trackNFTPurchase } = await getModule();
    trackNFTPurchase('JBAC', '42', '0.5');
    vi.advanceTimersByTime(11_000);
    expect(console.log).toHaveBeenCalledWith(
      '[analytics]',
      'nft_purchase',
      expect.objectContaining({ collection: 'JBAC', tokenId: '42', price: '0.5' }),
    );
  });

  it('trackPageView logs page_view event', async () => {
    const { trackPageView } = await getModule();
    trackPageView('Staking');
    vi.advanceTimersByTime(11_000);
    expect(console.log).toHaveBeenCalledWith(
      '[analytics]',
      'page_view',
      expect.objectContaining({ pageName: 'Staking' }),
    );
  });

  it('trackWalletConnect logs wallet_connect event', async () => {
    const { trackWalletConnect } = await getModule();
    trackWalletConnect('MetaMask');
    vi.advanceTimersByTime(11_000);
    expect(console.log).toHaveBeenCalledWith(
      '[analytics]',
      'wallet_connect',
      expect.objectContaining({ walletName: 'MetaMask' }),
    );
  });

  it('trackError logs error event with message and context', async () => {
    const { trackError } = await getModule();
    trackError(new Error('swap failed'), 'SwapPage');
    vi.advanceTimersByTime(11_000);
    expect(console.log).toHaveBeenCalledWith(
      '[analytics]',
      'error',
      expect.objectContaining({ message: 'swap failed', context: 'SwapPage' }),
    );
  });

  it('batches multiple events into a single flush', async () => {
    const { track } = await getModule();
    track('event1');
    track('event2');
    track('event3');
    // Before flush, console.log should not have analytics calls
    const countBefore = (console.log as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === '[analytics]',
    ).length;
    expect(countBefore).toBe(0);
    vi.advanceTimersByTime(11_000);
    const countAfter = (console.log as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === '[analytics]',
    ).length;
    expect(countAfter).toBe(3);
  });

  it('track() with no properties defaults to empty object', async () => {
    const { track } = await getModule();
    track('bare_event');
    vi.advanceTimersByTime(11_000);
    expect(console.log).toHaveBeenCalledWith('[analytics]', 'bare_event', {});
  });

  it('trackError handles non-Error objects', async () => {
    const { trackError } = await getModule();
    trackError('string error', 'context');
    vi.advanceTimersByTime(11_000);
    expect(console.log).toHaveBeenCalledWith(
      '[analytics]',
      'error',
      expect.objectContaining({ message: 'string error' }),
    );
  });
});
