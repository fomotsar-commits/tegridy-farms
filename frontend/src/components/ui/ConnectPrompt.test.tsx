import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConnectPrompt } from './ConnectPrompt';

// framer-motion passthrough.
vi.mock('framer-motion', () => {
  const passthrough = {
    div: ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
  };
  return {
    motion: passthrough,
    m: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
  };
});

// Stub RainbowKit's ConnectButton — the prod bundle reaches for wagmi config
// which isn't initialised in the test environment. The stub renders the
// standard button so interaction assertions still work.
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: {
    Custom: ({ children }: {
      children: (args: { openConnectModal: () => void; mounted: boolean }) => React.ReactNode;
    }) => <>{children({ openConnectModal: () => {}, mounted: true })}</>,
  },
}));

function renderPrompt(surface?: 'farm' | 'trade' | 'lending' | 'governance' | 'generic') {
  return render(
    <MemoryRouter>
      <ConnectPrompt surface={surface} />
    </MemoryRouter>,
  );
}

describe('ConnectPrompt', () => {
  it('renders default generic surface text when no prop is passed', () => {
    renderPrompt();
    expect(screen.getByText(/Connect your wallet/i)).toBeInTheDocument();
  });

  it('renders farm-specific copy when surface="farm"', () => {
    renderPrompt('farm');
    expect(screen.getByText(/Connect to farm with tegridy/i)).toBeInTheDocument();
    // Tegridy-voice touchpoint: staking NFT language in the description.
    expect(screen.getByText(/staking position is an ERC-721/i)).toBeInTheDocument();
  });

  it('renders trade surface copy', () => {
    renderPrompt('trade');
    expect(screen.getByText(/Connect to swap on the native DEX/i)).toBeInTheDocument();
  });

  it('renders lending surface copy', () => {
    renderPrompt('lending');
    expect(screen.getByText(/Connect to borrow or lend/i)).toBeInTheDocument();
  });

  it('renders governance surface with "Cartman" flavor phrase', () => {
    renderPrompt('governance');
    // Voice touchpoint: the governance subtitle's "totally not bribes" framing.
    expect(screen.getByText(/not bribes, just donations/i)).toBeInTheDocument();
  });

  it('renders "Connect Wallet" button and FAQ link', () => {
    renderPrompt('farm');
    expect(
      screen.getByRole('button', { name: /Open wallet connection modal/i }),
    ).toBeInTheDocument();
    const faqLink = screen.getByRole('link', { name: /New to DeFi\? Read the FAQ/i });
    expect(faqLink).toHaveAttribute('href', '/faq');
  });

  it('renders a security link', () => {
    renderPrompt('farm');
    const secLink = screen.getByRole('link', { name: /security disclosures/i });
    expect(secLink).toHaveAttribute('href', '/security');
  });

  it('supports override title and description props', () => {
    render(
      <MemoryRouter>
        <ConnectPrompt title="Custom Title" description="Custom description." />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Custom Title' })).toBeInTheDocument();
    expect(screen.getByText('Custom description.')).toBeInTheDocument();
  });
});
