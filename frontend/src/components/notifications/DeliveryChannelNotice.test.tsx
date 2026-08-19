// Honesty guard for the delivery notice.
//
// The control that must NOT exist here is a working "Enable push" button on a
// deployment where nothing sends. A disabled button with a tooltip is not good
// enough either — people click disabled buttons and assume a transient problem.
// The button is absent, and its reason is present.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('prefers the SERVER’s delivery report, which knows about the private key half', () => {
    render(
      <DeliveryChannelNotice
        channels={resolveChannels(readPushEnvironment())}
        delivery={{
          pushConfigured: false,
          backgroundWorker: false,
          detail: 'No VAPID key pair is set on this deployment and no background worker exists.',
        }}
      />,
    );
    expect(screen.getByText(/no background worker exists/i)).toBeInTheDocument();
  });
});
