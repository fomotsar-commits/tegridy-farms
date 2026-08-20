// What the panel puts on screen, and — the half that matters — what it refuses to.

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const wallet = vi.hoisted(() => ({ isConnected: true }));
vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: wallet.isConnected }) }));

const { TelegramLinkPanel } = await import('./TelegramLinkPanel');

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const ID = '11111111-2222-4333-8444-555555555555';

// The panel reads window.location, NOT react-router — see readPendingCode in the
// component. Mounting it under a MemoryRouter here would hide the property that
// matters: AlertsPanel renders this leaf, and AlertsPage.test.tsx renders
// AlertsPanel with no Router at all.
function mount(fetchImpl: typeof fetch, url = '/alerts') {
  window.history.replaceState(null, '', url);
  return render(<TelegramLinkPanel fetchImpl={fetchImpl} />);
}

beforeEach(() => {
  wallet.isConnected = true;
});

const emptyStore = (async () => response(200, { links: [] })) as unknown as typeof fetch;

describe('with no wallet there is no question to ask', () => {
  it('makes no request and does not claim the wallet has no linked chats', async () => {
    // A page-load request that can only be answered 401 spends a rate-limit slot
    // for every visitor and arrives at the same place a beat later.
    wallet.isConnected = false;
    const fetchImpl = vi.fn();
    mount(fetchImpl as unknown as typeof fetch);
    await waitFor(() => expect(screen.getByText(/stored against your wallet/i)).toBeInTheDocument());
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByText(/not a statement that none can/i)).toBeInTheDocument();
    expect(screen.queryByText(/No chat is linked to this wallet/)).not.toBeInTheDocument();
  });
});

describe('the promise is on screen before anything else', () => {
  it('states that the bot holds no key and never asks for one', async () => {
    mount(emptyStore);
    // Awaited so the initial read settles inside act(); the promise itself is
    // static copy and is on screen before any of it resolves.
    await screen.findByText(/No chat is linked to this wallet/);
    expect(screen.getByText(/holds no key and can sign nothing/i)).toBeInTheDocument();
    expect(screen.getByText(/never ask you for a recovery phrase/i)).toBeInTheDocument();
  });

  it('says the bot is hosted nowhere, so a link is not a promise of replies', async () => {
    mount(emptyStore);
    await screen.findByText(/No chat is linked to this wallet/);
    expect(screen.getByText(/hosted nowhere/i)).toBeInTheDocument();
  });
});

describe('an unread store never renders as an empty one', () => {
  it('prints the reason instead of "no chat is linked" when the store is unreachable', async () => {
    mount((async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);
    await waitFor(() => expect(screen.getByText(/nothing here says you have none/i)).toBeInTheDocument());
    expect(screen.queryByText(/No chat is linked to this wallet/)).not.toBeInTheDocument();
  });

  it('prints the operator step for a missing migration', async () => {
    mount((async () =>
      response(503, {
        error: 'The Telegram link table does not exist on this deployment.',
        code: 'schema-missing',
        operatorStep: 'Apply 020_telegram_links.sql',
      })) as unknown as typeof fetch);
    await waitFor(() => expect(screen.getByText(/Apply 020_telegram_links.sql/)).toBeInTheDocument());
    expect(screen.queryByText(/No chat is linked to this wallet/)).not.toBeInTheDocument();
  });

  it('says signed-out as itself', async () => {
    mount((async () => response(401, { error: 'Not authenticated' })) as unknown as typeof fetch);
    await waitFor(() => expect(screen.getByText(/cannot be read until you sign in/i)).toBeInTheDocument());
  });

  it('an EMPTY ready list is allowed to say so', async () => {
    mount(emptyStore);
    await waitFor(() => expect(screen.getByText(/No chat is linked to this wallet/)).toBeInTheDocument());
  });
});

describe('claiming a code carried in from the bot', () => {
  it('offers the button only when a code is in the URL', async () => {
    mount(emptyStore);
    await waitFor(() => expect(screen.getByText(/No chat is linked/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Link that chat/ })).not.toBeInTheDocument();
  });

  it('refuses a malformed code without offering to send it', async () => {
    mount(emptyStore, '/alerts?tglink=not-a-code');
    await waitFor(() => expect(screen.getByText(/not the shape of a link code/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Link that chat/ })).not.toBeInTheDocument();
  });

  it('claims a well-formed code and confirms what the grant is', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) =>
      init?.method === 'POST' ? response(201, { linked: true }) : response(200, { links: [] }),
    ) as unknown as typeof fetch;
    mount(fetchImpl, '/alerts?tglink=ABCDEFGHJK');

    fireEvent.click(await screen.findByRole('button', { name: /Link that chat/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/read-only questions/i));
  });

  it('a failed claim is reported as a failure, never as a link', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) =>
      init?.method === 'POST'
        ? response(404, { error: 'That code is not open.', code: 'code-not-open' })
        : response(200, { links: [] }),
    ) as unknown as typeof fetch;
    mount(fetchImpl, '/alerts?tglink=ABCDEFGHJK');

    fireEvent.click(await screen.findByRole('button', { name: /Link that chat/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/not open/i));
  });
});

describe('revoking', () => {
  const oneLink = { id: ID, linked_at: '2026-08-01T00:00:00.000Z' };

  it('lists a binding without naming any Telegram account, because the server never returns one', async () => {
    mount((async () => response(200, { links: [oneLink] })) as unknown as typeof fetch);
    await waitFor(() => expect(screen.getByText(/Linked on 2026-08-01/)).toBeInTheDocument());
  });

  it('a FAILED unlink says the binding is still in place and leaves the row visible', async () => {
    // The failure that matters: a user who believes a binding is gone stops
    // watching one that is still reading their wallet.
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) =>
      init?.method === 'POST'
        ? response(502, { error: 'The binding was not removed. It is still in place.' })
        : response(200, { links: [oneLink] }),
    ) as unknown as typeof fetch;
    mount(fetchImpl);

    fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/still in place/i));
    expect(screen.getByRole('button', { name: 'Unlink' })).toBeInTheDocument();
  });

  it('a successful unlink re-reads the store', async () => {
    let removed = false;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        removed = true;
        return response(200, { removed: 1 });
      }
      return response(200, { links: removed ? [] : [oneLink] });
    }) as unknown as typeof fetch;
    mount(fetchImpl);

    fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(screen.getByText(/No chat is linked to this wallet/)).toBeInTheDocument());
  });
});
