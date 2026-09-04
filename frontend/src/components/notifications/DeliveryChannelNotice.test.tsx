// Honesty guard for the delivery notice.
//
// The control that must NOT exist here is a working "Enable push" button on a
// deployment where nothing sends. A disabled button with a tooltip is not good
// enough either — people click disabled buttons and assume a transient problem.
// The button is absent, and its reason is present.

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DeliveryChannelNotice } from './DeliveryChannelNotice';
import { readPushEnvironment, resolveChannels } from '../../lib/alerts/channels';

describe('no subscribe control appears while nothing would send', () => {
  it('renders no push button in the real environment of this deployment', () => {
    const onSubscribe = vi.fn();
    render(<DeliveryChannelNotice channels={resolveChannels(readPushEnvironment())} onSubscribe={onSubscribe} />);
    expect(screen.queryByText(/turn on browser push/i)).not.toBeInTheDocument();
  });

  it('renders no push button even with a key and permission granted', () => {
    const channels = resolveChannels({
      vapidPublicKey: 'BKd0-test',
      hasNotificationApi: true,
      hasServiceWorker: true,
      permission: 'granted',
      subscribed: false,
    });
    render(<DeliveryChannelNotice channels={channels} onSubscribe={vi.fn()} />);
    expect(screen.queryByText(/turn on browser push/i)).not.toBeInTheDocument();
  });
});

describe('the reasons are rendered, not hidden', () => {
  it('shows the push channel’s own explanation', () => {
    const channels = resolveChannels({
      vapidPublicKey: '',
      hasNotificationApi: true,
      hasServiceWorker: true,
      permission: 'default',
      subscribed: false,
    });
    render(<DeliveryChannelNotice channels={channels} />);
    expect(screen.getByText(/no VAPID public key/i)).toBeInTheDocument();
  });

  it('shows the operator step alongside it', () => {
    const channels = resolveChannels({
      vapidPublicKey: '',
      hasNotificationApi: true,
      hasServiceWorker: true,
      permission: 'default',
      subscribed: false,
    });
    render(<DeliveryChannelNotice channels={channels} />);
    // The requirements list also names the keys, so assert on the operator line
    // specifically — it is the one that tells someone what to run.
    expect(screen.getByText(/npx web-push generate-vapid-keys/)).toBeInTheDocument();
  });

  it('states the in-app inbox’s own limit', () => {
    render(<DeliveryChannelNotice channels={resolveChannels(readPushEnvironment())} />);
    expect(screen.getByText(/Nothing runs when it is closed/i)).toBeInTheDocument();
  });

  it('states the OS-notification channel’s one limit, in every state', () => {
    const channels = resolveChannels({
      vapidPublicKey: '',
      hasNotificationApi: true,
      hasServiceWorker: true,
      permission: 'granted',
      subscribed: false,
    });
    render(<DeliveryChannelNotice channels={channels} />);
    // "Delivering" would be too strong for a channel that stops the moment the
    // last tab closes, so this channel gets its own badge word.
    expect(screen.getByText('On, while a tab is open')).toBeInTheDocument();
    expect(screen.getByText(/every tab of this site is closed/i)).toBeInTheDocument();
  });
});

describe('the one switch that is offered, and the one that is not', () => {
  const env = (permission: NotificationPermission) => ({
    vapidPublicKey: 'BKd0-test',
    hasNotificationApi: true,
    hasServiceWorker: true,
    permission,
    subscribed: false,
  });

  it('offers the notification switch only when pressing it would achieve something', () => {
    const { unmount } = render(
      <DeliveryChannelNotice channels={resolveChannels(env('default'))} onSubscribe={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Turn on browser notifications' })).toBeInTheDocument();
    unmount();

    for (const permission of ['granted', 'denied'] as const) {
      const view = render(
        <DeliveryChannelNotice channels={resolveChannels(env(permission))} onSubscribe={vi.fn()} />,
      );
      expect(screen.queryByRole('button', { name: 'Turn on browser notifications' })).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('clicking it asks exactly once, and the target is 44px tall', () => {
    const onSubscribe = vi.fn();
    render(<DeliveryChannelNotice channels={resolveChannels(env('default'))} onSubscribe={onSubscribe} />);
    const button = screen.getByRole('button', { name: 'Turn on browser notifications' });
    expect(button.className).toContain('min-h-11');
    fireEvent.click(button);
    expect(onSubscribe).toHaveBeenCalledTimes(1);
  });
});
