import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Address, Hex } from 'viem';
import LaunchTokenPage from './LaunchTokenPage';
import { LAUNCHER_INTEGRATOR_ADDRESS } from '../lib/launcher/config';
import { DOPPLER_MAINNET } from '../lib/launcher/doppler.constants';

// The page needs exactly one wagmi hook. A local mock keeps the test to the page's
// own logic rather than standing up a provider + transport.
const clientRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('wagmi', () => ({ usePublicClient: () => clientRef.current }));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const TOKEN = '0x1111111111111111111111111111111111111111' as Address;
const INITIALIZER = DOPPLER_MAINNET.modules.uniswapV4Initializer.address;
const FOREIGN = '0x00000000000000000000000000000000DeaDBeef' as Address;

/** A Solady LibClone runtime pointing at the recognised DopplerERC20V1 impl. */
const DOPPLER_CLONE_CODE = ('0x3d3d3d3d363d3d37363d73' +
  DOPPLER_MAINNET.support.dopplerErc20V1Impl.slice(2).toLowerCase() +
  '5af43d3d93803e602a57fd5bf3') as Hex;

function assetTuple(integrator: Address, poolInitializer: Address = INITIALIZER): readonly unknown[] {
  return [ZERO, ZERO, ZERO, ZERO, poolInitializer, ZERO, ZERO, 0n, 1_000n, integrator];
}

interface ClientOpts {
  code?: Hex | undefined;
  asset?: readonly unknown[] | Error;
  logs?: unknown[] | Error;
  token?: Record<string, unknown>;
}

function makeClient(o: ClientOpts = {}) {
  return {
    getCode: async () => o.code,
    getLogs: async () => {
      if (o.logs instanceof Error) throw o.logs;
      return o.logs ?? [];
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readContract: async (args: any) => {
      if (args.functionName === 'getAssetData') {
        if (o.asset instanceof Error) throw o.asset;
        return o.asset ?? assetTuple(ZERO, ZERO);
      }
      const v = o.token?.[args.functionName];
      if (v === undefined) throw new Error(`no stub for ${args.functionName}`);
      return v;
    },
  };
}

function renderAt(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/launch/${token}`]}>
      <Routes>
        <Route path="/launch/:token" element={<LaunchTokenPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clientRef.current = makeClient();
});

describe('LaunchTokenPage — invalid / unknown addresses', () => {
  it('renders a clean not-found state for a malformed address, with no chain reads', () => {
    let touched = false;
    clientRef.current = new Proxy(
      {},
      {
        get: () => {
          touched = true;
          return () => Promise.resolve(undefined);
        },
      },
    );
    renderAt('not-an-address');
    expect(screen.getByText('Token not found')).toBeInTheDocument();
    expect(touched).toBe(false);
  });

  it('does not crash on a path-traversal-shaped segment', () => {
    renderAt('..%2F..%2Fetc%2Fpasswd');
    expect(screen.getByText('Token not found')).toBeInTheDocument();
  });

  it('says nothing is deployed when the address has no code — and shows no Fact Sheet', async () => {
    clientRef.current = makeClient({ code: '0x' });
    renderAt(TOKEN);
    expect(await screen.findByText('No contract at this address')).toBeInTheDocument();
    expect(screen.queryByText('Launch Fact Sheet')).not.toBeInTheDocument();
  });
});

describe('LaunchTokenPage — honest unknown states', () => {
  it('reports an unreadable Airlock record as UNVERIFIED, never as "not ours"', async () => {
    clientRef.current = makeClient({ code: DOPPLER_CLONE_CODE, asset: new Error('rpc exploded') });
    renderAt(TOKEN);
    expect(await screen.findByText('Provenance unverified')).toBeInTheDocument();
    expect(screen.queryByText('Not launched here')).not.toBeInTheDocument();
  });

  it('reports a refused attestation log query as "Cannot verify", never as "No attestation"', async () => {
    clientRef.current = makeClient({
      code: DOPPLER_CLONE_CODE,
      logs: new Error('ranges over 10000 blocks are not supported on free plan'),
    });
    renderAt(TOKEN);
    expect(await screen.findByText('Cannot verify')).toBeInTheDocument();
    expect(screen.queryByText('No attestation')).not.toBeInTheDocument();
  });

  it('reports the unreadable locker as "Graduation state unverified", never as "Not graduated"', async () => {
    clientRef.current = makeClient({ code: DOPPLER_CLONE_CODE });
    renderAt(TOKEN);
    expect(await screen.findByText('Graduation state unverified')).toBeInTheDocument();
    expect(screen.queryByText('Not graduated')).not.toBeInTheDocument();
  });

  it('shows LP-lock gate checks as unread rather than as "Liquidity is not locked."', async () => {
    clientRef.current = makeClient({
      code: DOPPLER_CLONE_CODE,
      token: { name: 'Tegridy Test', symbol: 'TGT', totalSupply: 1_000n, owner: ZERO, isBalanceLimitActive: false, vestedTotalAmount: 0n },
    });
    renderAt(TOKEN);
    await screen.findByText('Launch Fact Sheet');
    expect(screen.queryByText(/Liquidity is not locked/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/liquidity-lock state could not be read/i).length).toBeGreaterThan(0);
  });

  it('does not enumerate residual powers for an unrecognised template', async () => {
    // collectTokenFacts marks every dangerous power "present" when it cannot recognise
    // the template. Publishing that would accuse a contract nobody inspected.
    clientRef.current = makeClient({ code: '0x60016000' as Hex });
    renderAt(TOKEN);
    await screen.findByText('Launch Fact Sheet');
    expect(screen.queryByText(/The owner can mint new tokens after launch/)).not.toBeInTheDocument();
    expect(screen.getByText(/its mint, pause, blacklist, transfer-tax and upgrade powers were not inspected/i)).toBeInTheDocument();
  });

  // Caught by reading the LIVE page, not by the unit tests: an unrecognised template
  // still produced two green ticks off values nobody read.
  it('shows no fabricated PASS for allocation or ownership on an unrecognised template', async () => {
    clientRef.current = makeClient({ code: '0x60016000' as Hex });
    renderAt(TOKEN);
    await screen.findByText('Launch Fact Sheet');
    expect(screen.queryByText(/Ownership renounced\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/flagship cap 2000 bps/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No team\/insider allocation\./)).not.toBeInTheDocument();
  });
});

describe('LaunchTokenPage — the slow attestation read does not hold the page', () => {
  it('renders the dossier while the attestation lookup is still in flight', async () => {
    let release: (v: unknown[]) => void = () => {};
    clientRef.current = {
      ...makeClient({ code: DOPPLER_CLONE_CODE }),
      getLogs: () => new Promise<unknown[]>((res) => { release = res; }),
    };
    renderAt(TOKEN);
    // Everything else is on screen …
    expect(await screen.findByText('Launch Fact Sheet')).toBeInTheDocument();
    // … while the attestation is explicitly still pending, not silently "none".
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(screen.queryByText('No attestation')).not.toBeInTheDocument();

    release([]);
    expect(await screen.findByText('No attestation')).toBeInTheDocument();
  });
});

describe('LaunchTokenPage — provenance claims', () => {
  it('claims a launch as ours only when the Airlock names our integrator', async () => {
    clientRef.current = makeClient({
      code: DOPPLER_CLONE_CODE,
      asset: assetTuple(LAUNCHER_INTEGRATOR_ADDRESS),
    });
    renderAt(TOKEN);
    expect(await screen.findByText('Launched through this rail')).toBeInTheDocument();
  });

  it('says plainly that a foreign integrator did not come through this rail', async () => {
    clientRef.current = makeClient({ code: DOPPLER_CLONE_CODE, asset: assetTuple(FOREIGN) });
    renderAt(TOKEN);
    expect(await screen.findByText('Not launched here')).toBeInTheDocument();
    expect(screen.queryByText('Launched through this rail')).not.toBeInTheDocument();
  });

  it('renders no name when the contract returns none, rather than substituting one', async () => {
    clientRef.current = makeClient({ code: DOPPLER_CLONE_CODE });
    renderAt(TOKEN);
    await waitFor(() => expect(screen.getByText('Unnamed token')).toBeInTheDocument());
    expect(screen.getByText(/did not return a name or symbol/i)).toBeInTheDocument();
  });
});
