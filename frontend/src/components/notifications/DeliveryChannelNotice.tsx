import {
  BACKGROUND_DELIVERY_AVAILABLE,
  BACKGROUND_DELIVERY_REQUIREMENTS,
  IN_APP_LIMITATION,
  type ChannelStatus,
} from '../../lib/alerts/channels';
import type { DeliveryReport } from '../../lib/alerts/rulesClient';

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
  /** What the SERVER reported. The browser cannot see the private VAPID half. */
  delivery?: DeliveryReport | null;
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

export function DeliveryChannelNotice({ channels, delivery, onSubscribe }: Props) {
  return (
    <section
      className="rounded-xl p-4"
      style={{ background: '#000', border: '1px solid var(--color-purple-75)' }}
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
                {STATE_WORD[channel.state]}
              </span>
            </div>
            {channel.detail && <p className="mt-1 text-white/70 text-[11px] leading-snug">{channel.detail}</p>}
            {channel.operatorStep && (
              <p className="mt-1 text-white/50 text-[11px] leading-snug">
                <span className="uppercase tracking-wide">Operator: </span>
                {channel.operatorStep}
              </p>
            )}
            {channel.canSubscribe && onSubscribe && (
              <button
                type="button"
                onClick={onSubscribe}
                className="mt-2 px-3 py-1 rounded-lg text-[11px] text-white"
                style={{ background: 'var(--color-purple-80)' }}
              >
                Turn on browser push
              </button>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-3 text-white/70 text-[11px] leading-snug">{IN_APP_LIMITATION}</p>

      {/* The server knows something the browser cannot: whether the PRIVATE VAPID
          half is set. A deployment with only the public key looks push-ready from
          here, so its own report is shown rather than inferred. */}
      {delivery && <p className="mt-2 text-white/50 text-[11px] leading-snug">{delivery.detail}</p>}

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
