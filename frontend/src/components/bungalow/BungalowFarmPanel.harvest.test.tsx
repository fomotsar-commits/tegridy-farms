// Where Harvest sits on a room's pool page (owner, 2026-10-30, on the lock ladder card:
// "harvest all needs to be here too"): INSIDE the room's leading pool card, once per page,
// whatever kind of pool leads. The card itself has its own tests (farm/HarvestCard.test.tsx).
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Bungalow } from '../../lib/bungalows';

vi.mock('../farm/HarvestCard', () => ({
  HarvestCard: (p: { quiet?: boolean; headingLevel?: number }) => <div data-testid="harvest" data-quiet={String(p.quiet)} data-level={String(p.headingLevel)} />,
}));
vi.mock('../solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
// Each pool card draws what it is handed as `harvest`, inside itself.
const card = (id: string) => ({ harvest }: { harvest?: ReactNode }) => <div data-testid={id}>{harvest}</div>;
vi.mock('./LighthousePoolLive', () => ({ LighthousePoolLive: card('lighthouse-card'), LighthouseClaimStrip: card('claim-strip') }));
vi.mock('./SolanaLadderPoolLive', () => ({ SolanaLadderPoolLive: card('ladder-card'), SolanaLadderPoolCard: card('ladder-card') }));
vi.mock('./EvmLadderPoolLive', () => ({ EvmLadderPoolLive: card('evm-ladder-card') }));
vi.mock('./EvmLighthousePoolLive', () => ({ EvmLighthousePoolLive: card('evm-plain-card') }));
vi.mock('./HeatCard', () => ({ HeatCard: () => null }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

const { BungalowFarmPanel } = await import('./BungalowFarmPanel');

const SOL = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana', status: 'live',
  tagline: 'x.', address: '8opsYTPSp2AckjmAc2vx49kohs8CFtNcyR2sNURfrfoL', decimals: 6, pools: [],
};
const EVM = { ...SOL, id: 'pepe', symbol: 'PEPE', chain: 'ethereum', address: '0x6982508145454ce325ddbe47a25d4ec3d2311933', stakePool: '0x1' };

const rooms: [string, Bungalow, string][] = [
  ['a members-only pool beside the ladder (BAYLA today)', { ...SOL, stakePool: 'S', ladderPool: 'L', depositsClosed: true } as unknown as Bungalow, 'ladder-card'],
  ['an open Streamflow pool beside the ladder', { ...SOL, stakePool: 'S', ladderPool: 'L' } as unknown as Bungalow, 'ladder-card'],
  ['a Streamflow pool alone (BOBO, SOY, BRAINLET, RIZZ)', { ...SOL, stakePool: 'S' } as unknown as Bungalow, 'lighthouse-card'],
  ['an Ethereum or Base lock ladder', { ...EVM, poolKind: 'ladder' } as unknown as Bungalow, 'evm-ladder-card'],
  ['an Ethereum or Base plain pool', EVM as unknown as Bungalow, 'evm-plain-card'],
];

describe('Harvest on a pool page', () => {
  it.each(rooms)('%s: once, inside the leading card, quiet, under its heading', async (_name, room, leading) => {
    render(<MemoryRouter><BungalowFarmPanel bungalow={room} /></MemoryRouter>);
    const lead = await screen.findByTestId(leading);
    const all = screen.getAllByTestId('harvest');
    expect(all).toHaveLength(1);
    const h = within(lead).getByTestId('harvest');
    expect(h.dataset.quiet).toBe('true');
    expect(h.dataset.level).toBe('3');
  });
});
