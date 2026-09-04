import {
  BACKGROUND_DELIVERY_AVAILABLE,
  BACKGROUND_DELIVERY_REQUIREMENTS,
  IN_APP_LIMITATION,
  type ChannelId,
  type ChannelStatus,
} from '../../lib/alerts/channels';

// Where alerts can go, stated before the user relies on them going anywhere.
//
// The control this surface deliberately does NOT render is an "Enable push"
// button that would succeed. Registering a subscription with no sender behind it
// produces a switch that reads as on and delivers nothing — the user discovers it
// by missing the event it was for. So when `canSubscribe` is false the button is
// absent and its reason is present, which is the opposite of the usual pattern of
// a disabled button with a shrug tooltip.

interface Props {
  channels: readonly ChannelStatus[];
  onSubscribe?: () => void;
}

const STATE_WORD: Record<ChannelStatus['state'], string> = {
  ready: 'Delivering',
  unsupported: 'Not supported here',
  unconfigured: 'Not configured',
  blocked: 'Blocked by your browser',
  'no-sender': 'No sender',
  off: 'Available, off',
};

/**
 * "Delivering" is too strong for a channel that only fires while a tab is open,
 * so this channel gets its own word. A badge is the shortest thing on the panel
 * and therefore the thing most likely to be read INSTEAD of the sentence below it.
 */
const READY_WORD: Partial<Record<ChannelId, string>> = {
  'web-notification': 'On, while a tab is open',
};

/**
 * The subscribe control exists ONLY for a channel that can be switched on and
 * would then do something. `web-push` never has `canSubscribe`, so its label is
 * not in this map and the button cannot be rendered for it by any state.
 */
const SUBSCRIBE_LABEL: Partial<Record<ChannelId, string>> = {
  'web-notification': 'Turn on browser notifications',
};

export function DeliveryChannelNotice({ channels, onSubscribe }: Props) {
  return (
    <section
      className="rounded-xl p-4"
      style={{ background: 'transparent' }}
      aria-label="Alert delivery"
    >
      <h3 className="text-white text-[13px] font-medium">Where alerts go</h3>

      <ul className="mt-3 space-y-3">
        {channels.map((channel) => (
          <li key={channel.id}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-white text-[12px]">{channel.label}</span>
              <span
                className="text-[11px] px-2 py-[2px] rounded-full"
                style={{
                  color: channel.state === 'ready' ? '#7CFFB2' : '#FFD37C',
                  border: '1px solid currentColor',
                }}
              >
                {(channel.state === 'ready' && READY_WORD[channel.id]) || STATE_WORD[channel.state]}
              </span>
            </div>
            {channel.detail && <p className="mt-1 text-white/70 text-[11px] leading-snug">{channel.detail}</p>}
            {channel.operatorStep && (
              <p className="mt-1 text-white/50 text-[11px] leading-snug">
                <span className="uppercase tracking-wide">Operator: </span>
                {channel.operatorStep}
              </p>
            )}
            {channel.canSubscribe && onSubscribe && SUBSCRIBE_LABEL[channel.id] && (
              <button
                type="button"
                onClick={onSubscribe}
                className="mt-2 min-h-11 px-4 rounded-lg text-[11px] text-white"
                style={{ background: 'var(--color-purple-80)' }}
              >
                {SUBSCRIBE_LABEL[channel.id]}
              </button>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-3 text-white/70 text-[11px] leading-snug">{IN_APP_LIMITATION}</p>

      {!BACKGROUND_DELIVERY_AVAILABLE && (
        <details className="mt-3">
          <summary className="text-white/60 text-[11px] cursor-pointer">
            What has to exist before push can be offered
          </summary>
          <ul className="mt-2 space-y-1 list-disc pl-4">
            {BACKGROUND_DELIVERY_REQUIREMENTS.map((req) => (
              <li key={req} className="text-white/50 text-[11px] leading-snug">
                {req}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export default DeliveryChannelNotice;
